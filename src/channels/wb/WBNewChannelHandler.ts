import { Channel, ChannelExecution } from '../../models/channels'
import { ChannelAttribute, ChannelCategory, ChannelHandler } from '../ChannelHandler'
import fetch from 'node-fetch'
const FormData = require('form-data')
import NodeCache = require('node-cache')
import { Item } from '../../models/items'
import logger from "../../logger"
import { sequelize } from '../../models'
import * as uuid from "uuid"
import * as fs from 'fs'
import { Op } from 'sequelize'
import { ItemRelation } from '../../models/itemRelations'
import { request } from 'http'

interface JobContext {
    log: string
    variantParent?: string
    variantRequest?: any
    variantItems?: [Item]
}

export class WBNewChannelHandler extends ChannelHandler {
    private cache = new NodeCache({useClones: false});

    public async processChannel(channel: Channel, language: string, data: any): Promise<void> {
        
        const chanExec = await this.createExecution(channel)

        const context: JobContext = {log: ''}

        if (!channel.config.wbToken) {
            await this.finishExecution(channel, chanExec, 3, 'Не введен API token в конфигурации канала')
            return
        }

        if (!channel.config.imtIDAttr) {
            await this.finishExecution(channel, chanExec, 3, 'Не введен атрибут где хранить imtID')
            return
        }

        if (!channel.config.nmIDAttr) {
            await this.finishExecution(channel, chanExec, 3, 'Не введен атрибут где хранить nmID')
            return
        }

        if (!channel.config.wbCodeAttr) {
            await this.finishExecution(channel, chanExec, 3, 'Не введен атрибут где находится артикул товара')
            return
        }
        try {
            if (!data) {
                const query:any = {}
                query[channel.identifier] = {status: 1}
                let items = await Item.findAndCountAll({ 
                    where: { tenantId: channel.tenantId, channels: query},
                    order: [['parentIdentifier', 'ASC'], ['id', 'ASC']]
                })
                context.log += 'Найдено ' + items.count +' записей для обработки \n\n'
                for (let i = 0; i < items.rows.length; i++) {
                    const item = items.rows[i];
                    await this.processItem(channel, item, language, context)
                    context.log += '\n\n'
                }
            } else if (data.sync) {
                await this.syncJob(channel, context, data)
            }

            await this.finishExecution(channel, chanExec, 2, context.log)
        } catch (err) {
            logger.error("Error on channel processing", err)
            context.log += 'Ошибка запуска канала - '+ JSON.stringify(err)
            await this.finishExecution(channel, chanExec, 3, context.log)
        }
    }

    async syncJob(channel: Channel, context: JobContext, data: any) {
        context.log += 'Запущена синхронизация с WB\n'

        const wbCodeAttr = channel.config.wbCodeAttr
        if (!wbCodeAttr) {
            context.log += 'Ошибка, не введен Атрибут где находится артикул товара в конфигурации канала\n'
            return 
        }

        const errorsResp = await fetch('https://suppliers-api.wildberries.ru/content/v2/cards/error/list', {
            headers: { 'Content-Type': 'application/json', 'Authorization': channel.config.wbToken },
        })
        const errorsJson = await errorsResp.json()
        let msg = "Найдено "+errorsJson.data.length+" ошибок"
        logger.info(msg)
        if (channel.config.debug) context.log += msg+'\n'
        for (let i = 0; i < errorsJson.data.length; i++) {
            const error = errorsJson.data[i];
            
            const query:any = {}
            query[wbCodeAttr] = error.vendorCode
            let item = await Item.findOne({ 
                where: { tenantId: channel.tenantId, values: query, [Op.or] : channel.visible.map((parentId:any) => {return {path: {[Op.regexp]: '*.'+parentId+'.*'}}})} 
            })
            if (!item) {
                let msg = "Ошибка, не найден товар по артикулу для синхронизации: " + error.vendorCode
                logger.info(msg)
                context.log += msg+'\n'
            } else {
                if (item.channels[channel.identifier]) {
                    item.channels[channel.identifier].status = 3
                    item.channels[channel.identifier].message = error.errors.join(', ')
                    data.syncedAt = Date.now()
                    item.changed('channels', true)
                    item.save()
                    let msg = "Ошибка, для товара: " + error.vendorCode + ", " + item.channels[channel.identifier].message
                    logger.info(msg)
                    context.log += msg+'\n'
                }
            }
        }


        if (data.item) {
            const item = await Item.findByPk(data.item)
            await this.syncItem(channel, item!, context, true)
        } else {
            const query:any = {}
            query[channel.identifier] = { status: 4 }
            let items = await Item.findAll({ 
                where: { tenantId: channel.tenantId, channels: query} 
            })
            context.log += 'Найдено ' + items.length +' записей для обработки \n\n'
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                await this.syncItem(channel, item, context, false)
            }
        }
        context.log += 'Cинхронизация закончена'
    }

    async syncItem(channel: Channel, item: Item, context: JobContext, singleSync: boolean) {
        context.log += 'Обрабатывается товар c идентификатором: [' + item.identifier + ']\n'

        if (item.channels[channel.identifier]) {
            const chanData = item.channels[channel.identifier]
            if (!singleSync && chanData.status === 3) {
                context.log += 'Статус товара - ошибка, синхронизация не будет проводиться \n'
                return
            }

            const article = item.values[channel.config.wbCodeAttr]
            if (!article) {
                item.channels[channel.identifier].status = 3
                item.channels[channel.identifier].message = 'Не найдено значение артикула товара в атрибуте: ' + channel.config.wbCodeAttr
            } else {
                const url = 'https://suppliers-api.wildberries.ru/content/v1/cards/filter'
                const request = {vendorCodes: [''+article]}
                let msg = "Запрос на WB: " + url + " => " + JSON.stringify(request)
                logger.info(msg)
                if (channel.config.debug) context.log += msg+'\n'
                const res = await fetch(url, {
                    method: 'post',
                    body:    JSON.stringify(request),
                    headers: { 'Content-Type': 'application/json', 'Authorization': channel.config.wbToken },
                })
    
                if (res.status !== 200) {
                    const msg = 'Ошибка запроса на Wildberries: ' + res.statusText
                    context.log += msg                      
                    return
                } else {
                    const json = await res.json()
                    if (channel.config.debug) context.log += 'Ответ от WB '+JSON.stringify(json)+'\n'
                    if (json.data[0]?.imtID) {
                        let status = 2
                        // if item was created first time (imtIDAttr is empty) send it agin to WB to send images (images can be assigned only to existing items)
                        if (channel.config.imtIDAttr && !item.values[channel.config.imtIDAttr]) status = 1
                        item.channels[channel.identifier].status = status
                        item.channels[channel.identifier].message = ""
                        item.channels[channel.identifier].syncedAt = Date.now()
                        item.changed('channels', true)
                        
                        if (channel.config.imtIDAttr) item.values[channel.config.imtIDAttr] = json.data[0].imtID
                        if (channel.config.nmIDAttr) item.values[channel.config.nmIDAttr] = json.data[0].nmID
                        item.changed('values', true)
                    } else {
                        context.log += 'новых данных не получено\n'
                    }
                }
            }

            await sequelize.transaction(async (t) => {
                await item.save({ transaction: t })
            })
        } else {
            context.log += '  товар c идентификатором ' + item.identifier + ' не требует синхронизации \n'
        }

    }    

    async processItem(channel: Channel, item: Item, language: string, context: JobContext) {
        context.log += 'Обрабатывается запись с идентификатором: ' + item.identifier +'\n'

        for (const categoryId in channel.mappings) {
            const categoryConfig = channel.mappings[categoryId]

            if (categoryConfig.valid && categoryConfig.valid.length > 0 && ( 
                (categoryConfig.visible && categoryConfig.visible.length > 0) || categoryConfig.categoryExpr || (categoryConfig.categoryAttr && categoryConfig.categoryAttrValue)) ) {
                const pathArr = item.path.split('.')
                const tstType = categoryConfig.valid.includes(item.typeId) || categoryConfig.valid.includes(''+item.typeId)
                if (tstType) {
                    let tst = null
                    if (categoryConfig.visible && categoryConfig.visible.length > 0) {
                        if (categoryConfig.visibleRelation) {
                            let sources = await Item.findAll({ 
                                where: { tenantId: channel.tenantId, '$sourceRelation.relationId$': categoryConfig.visibleRelation, '$sourceRelation.targetId$': item.id },
                                include: [{model: ItemRelation, as: 'sourceRelation'}]
                            })
                            tst = sources.some(source => {
                                const pathArr = source.path.split('.')
                                return categoryConfig.visible.find((elem:any) => pathArr.includes(''+elem))
                            })
                        } else {
                            tst = categoryConfig.visible.find((elem:any) => pathArr.includes(''+elem))
                        }
                    } else if (categoryConfig.categoryExpr) {
                        tst = await this.evaluateExpression(channel, item, categoryConfig.categoryExpr)
                    } else {
                        tst = item.values[categoryConfig.categoryAttr] && item.values[categoryConfig.categoryAttr] == categoryConfig.categoryAttrValue
                    }
                    if (tst) {
                        try {
                            await this.processItemInCategory(channel, item, categoryConfig, language, context)
                            await sequelize.transaction(async (t) => {
                                await item.save({transaction: t})
                            })

                            // await new Promise(resolve => setTimeout(resolve, 5000))
                        } catch (err) {
                            logger.error("Failed to process item with id: " + item.id + " for tenant: " + item.tenantId, err)
                        }
                        return
                    }
                }
            } else {
                context.log += 'Запись с идентификатором: ' + item.identifier + ' не подходит под конфигурацию канала.\n'
                // logger.warn('No valid/visible configuration for : ' + channel.identifier + ' for item: ' + item.identifier + ', tenant: ' + channel.tenantId)
            }
        }

        const data = item.channels[channel.identifier]
        data.status = 3
        data.message = 'Этот объект не подходит ни под одну категорию из этого канала.'
        context.log += 'Запись с идентификатором:' + item.identifier + ' не подходит ни под одну категорию из этого канала.\n'
        item.changed('channels', true)
        await sequelize.transaction(async (t) => {
            await item.save({transaction: t})
        })
    }

    async processItemInCategory(channel: Channel, item: Item, categoryConfig: any, language: string, context: JobContext) {
        context.log += 'Найдена категория "' + categoryConfig.name +'" для записи с идентификатором: ' + item.identifier + '\n'

        const data = item.channels[channel.identifier]
        data.category = categoryConfig.id
        
        const productCodeConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#productCode')
        let productCode = await this.getValueByMapping(channel, productCodeConfig, item, language)
        if (!productCode) {
            const msg = 'Не введена конфигурация для "Артикула товара" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }
        productCode = ''+productCode

        const barcodeConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#barcode')
        const barcode = await this.getValueByMapping(channel, barcodeConfig, item, language)
        if (!barcode) {
            const msg = 'Не введена конфигурация для "Баркода" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

        const priceConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#price')
        const price = await this.getValueByMapping(channel, priceConfig, item, language)
        if (!price) {
            const msg = 'Не введена конфигурация для "Цены" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

        // request to WB
        let request:any = {vendorCode:productCode, characteristics:[{"Предмет": categoryConfig.name}], sizes:[{wbSize:"", price: price, skus: [''+barcode]}]}

        const nmID = item.values[channel.config.nmIDAttr]
        if (nmID) {
            const existUrl = 'https://suppliers-api.wildberries.ru/content/v1/cards/filter'
            const existsBody = {vendorCodes: [productCode]}
            let msg = "Sending request Windberries: " + existUrl + " => " + JSON.stringify(existsBody)
            logger.info(msg)
            const resExisting = await fetch(existUrl, {
                method: 'post',
                body:    JSON.stringify(existsBody),
                headers: { 'Content-Type': 'application/json', 'Authorization': channel.config.wbToken },
            })
            if (resExisting.status !== 200) {
                const msg = 'Ошибка запроса на Wildberries - https://suppliers-api.wildberries.ru/content/v1/cards/filter: ' + resExisting.statusText
                context.log += msg                      
                this.reportError(channel, item, msg)
                return
            } else {
                const json = await resExisting.json()
                // if (channel.config.debug) context.log += 'received response (load existing data):'+JSON.stringify(json)+'\n'
                const tst = json.data.find((elem:any) => elem.nmID == nmID)
                if (tst) {
                    request = tst
                } else {
                    logger.warn('Failed to find existing product by code: '+productCode)
                }
                request.sizes[0].price = price
            }

            request.nmID = nmID
        }

        // atributes
        const create = item.values[channel.config.imtIDAttr] ? false : true
        for (let i = 0; i < categoryConfig.attributes.length; i++) {
            const attrConfig = categoryConfig.attributes[i];
            
            if (
                attrConfig.id != '#productCode' && attrConfig.id != '#barcode' && attrConfig.id != '#price'
                && attrConfig.id != '#images'
            ) {
                const attr = (await this.getAttributes(channel, categoryConfig.id)).find(elem => elem.id === attrConfig.id)
                if (!attr) {
                    logger.warn('Failed to find attribute in channel for attribute with id: ' + attrConfig.id)
                    continue
                }
                try {
                    const value = await this.getValueByMapping(channel, attrConfig, item, language)
                    if (!create) this.clearPreviousValue(request.characteristics, attr.type)
                    if (value) {
                        if (Array.isArray(value) && value.length > 0) {
                            const data:any = {}
                            data[attr.type] = attr.maxCount == 0 || attr.maxCount == 1 ? value[0] : value
                            request.characteristics.push(data)
                        } else {
                            const data:any = {}
                            data[attr.type] = attr.maxCount == 0 || attr.maxCount == 1 ? value : [value]
                            request.characteristics.push(data)
                        }
                    } else if (attr.required) {
                        const msg = 'Нет значения для обязательного атрибута "' + attr.name + '" для категории: ' + categoryConfig.name
                        context.log += msg                      
                        this.reportError(channel, item, msg)
                        return
                    }
                } catch (err:any) {
                    const msg = 'Ошибка вычисления атрибута "' + attr.name + '" для категории: ' + categoryConfig.name
                    logger.error(msg, err)
                    context.log += msg + ': ' + err.message        
                    this.reportError(channel, item, msg + ': ' + err.message)
                    return
                  }
            }
        }        

        await this.sendRequest(channel, item, request, context, categoryConfig.id)

        // images
        if (!create) { // send images on update only because product is not exists at WB just after create
            const imageConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#images')
            if (!imageConfig) return
            const images = await this.getValueByMapping(channel, imageConfig, item, language)
            if (images && images.length > 0) {
                const imgRequest = {
                    "vendorCode": productCode,
                    "data": images
                    }
                const imgUrl = 'https://suppliers-api.wildberries.ru/content/v1/media/save'
                let msg = "Sending request Windberries: " + imgUrl + " => " + JSON.stringify(imgRequest)
                logger.info(msg)
                if (channel.config.debug) context.log += msg+'\n'

                if (process.env.OPENPIM_WB_EMULATION === 'true') {
                    const msg = 'Включена эмуляция работы, сообщение не было послано на WB'
                    if (channel.config.debug) context.log += msg+'\n'
                    logger.info(msg)
                    return
                }
        
                const res = await fetch(imgUrl, {
                    method: 'post',
                    body:    JSON.stringify(imgRequest),
                    headers: { 'Content-Type': 'application/json', 'Authorization': channel.config.wbToken },
                })
                msg = "Response status from Windberries: " + res.status
                logger.info(msg)
                if (channel.config.debug) context.log += msg+'\n'
                if (res.status !== 200) {
                    const msg = 'Ошибка запроса на Wildberries: ' + res.statusText
                    context.log += msg                      
                    this.reportError(channel, item, msg)
                    return
                }
            }
        }
    }

    private clearPreviousValue(arr: any[], type: string) {
        const tst = arr.findIndex((elem:any) => elem.hasOwnProperty(type))
        if (tst != -1) arr.splice(tst, 1)
    }

    async sendRequest(channel: Channel, item: Item, request: any, context: JobContext, categoryId: string) {
        const create = item.values[channel.config.nmIDAttr] ? false : true

        let grpItem = null
        if (channel.config.wbGroupAttr) {
            const grp = item.values[channel.config.wbGroupAttr]
            if (grp) {
                // find all items in this group
                const query:any = {}
                query[channel.config.wbGroupAttr] = grp
                let grpItems = await Item.findAll({where: { tenantId: channel.tenantId, values: query, id: {[Op.ne]: item.id} }})
                // find item already at WB
                grpItem = grpItems.find(elem => elem.values[channel.config.imtIDAttr])
                // find item already send to WB but without imtID yet
                if (!grpItem) grpItem = grpItems.find(elem => elem.channels[channel.identifier]?.status === 4 )
            }
        }

        let url = ''
        let req

        const idx = categoryId.indexOf('-')
        const objId = parseInt(categoryId.substring(idx+1))

        if (grpItem) {
            url = create ? 'https://suppliers-api.wildberries.ru/content/v2/cards/upload/add' : 'https://suppliers-api.wildberries.ru/content/v2/cards/update'
            req = create ? { imtID: item.values[channel.config.imtIDAttr], cardsToAdd: [request] } : [request]
        } else {
            url = create ? 'https://suppliers-api.wildberries.ru/content/v2/cards/upload' : 'https://suppliers-api.wildberries.ru/content/v2/cards/update'
            req = create ? [{subjectID: objId,variants:[request]}] : [request]
        }
        
        let msg = "Sending request Windberries: " + url + " => " + JSON.stringify(req)
        logger.info(msg)
        if (channel.config.debug) context.log += msg+'\n'

        if (process.env.OPENPIM_WB_EMULATION === 'true') {
            const msg = 'Включена эмуляция работы, сообщение не было послано на WB'
            if (channel.config.debug) context.log += msg+'\n'
            logger.info(msg)
            return
        }

        const res = await fetch(url, {
            method: 'post',
            body:    JSON.stringify(req),
            headers: { 'Content-Type': 'application/json', 'Authorization': channel.config.wbToken },
        })
        msg = "Response status from Windberries: " + res.status
        logger.info(msg)
        if (channel.config.debug) context.log += msg+'\n'
        if (res.status !== 200) {
            const msg = 'Ошибка запроса на Wildberries: ' + (await res.text())
            context.log += msg                      
            this.reportError(channel, item, msg)
            return
        } else {
            const json = await res.json()
            if (channel.config.debug) context.log += 'received response:'+JSON.stringify(json)+'\n'
            if (json.error) {
                const msg = 'Ошибка запроса на Wildberries: ' + json.error.message
                this.reportError(channel, item, msg)
                context.log += msg                      
                logger.info("Error from Windberries: " + JSON.stringify(json))
                return
            } else {
                context.log += 'Запись с идентификатором: ' + item.identifier + ' обработана успешно.\n'
                const data = item.channels[channel.identifier]
                data.status = 4
                data.message = ''
                data.syncedAt = Date.now()
                item.changed('channels', true)
            }
        }
    }

    public async getCategories(channel: Channel): Promise<{list: ChannelCategory[]|null, tree: ChannelCategory|null}> {
        let tree:ChannelCategory | undefined = this.cache.get('categories')
        if (!tree) {
            const res = await fetch('https://suppliers-api.wildberries.ru/content/v2/object/parent/all', {
                method: 'get',
                body:    JSON.stringify(request),
                headers: { 'Content-Type': 'application/json', 'Authorization': channel.config.wbToken },
            })
            const json = await res.json()
            const data:ChannelCategory[] = Object.values(json.data).map((value:any) => { return {id: 'cat_'+value.id, name: value.name, children: []} })

            let offset = 0
            let length = 0
            do {
                const res2 = await fetch('https://suppliers-api.wildberries.ru/content/v2/object/all?limit=1000&offset='+offset, {
                    method: 'get',
                    body:    JSON.stringify(request),
                    headers: { 'Content-Type': 'application/json', 'Authorization': channel.config.wbToken },
                })
                const json2 = await res2.json()

                for(const obj of json2.data) {
                    if (!obj.isVisible) continue
                    const cat = 'cat_'+obj.parentID
                    const parent = data.find(elem => elem.id === cat)
                    if (!parent) {
                        logger.warning(`Failed to find parent for ${JSON.stringify(obj)}`)
                    } else {
                        parent.children!.push({id: parent.id+'-'+obj.subjectID, name: obj.subjectName, children: []})
                    }
                }

                length = json2.data.length
                offset += 1000
            } while (length > 0)

            tree  = {id: '', name: 'root', children: data.filter(elem => elem.children!.length > 0)}
            this.cache.set('categories', tree, 3600)
        }
        return { list: null, tree: tree }
    }
    
    public async getAttributes(channel: Channel, categoryId: string): Promise<ChannelAttribute[]> {
        let data = this.cache.get('attr_'+categoryId)
        if (!data) {
            const idx = categoryId.indexOf('-')
            const objId = categoryId.substring(idx+1)

            const res = await fetch('https://suppliers-api.wildberries.ru/content/v2/object/charcs/' + objId, {
                method: 'get',
                body:    JSON.stringify(request),
                headers: { 'Content-Type': 'application/json', 'Authorization': channel.config.wbToken },
            })
            const json = await res.json()
            data = Object.values(json.data).map((data:any) => { 
                return { 
                    id: 'wbattr_'+data.charcID, 
                    type: data.name,
                    isNumber: data.charcType === 1 ? false : true,
                    name: data.name + (data.unitName ? ' (' + data.unitName + ')' : '') + (data.charcType === 4 ? ' [число]' : ''),
                    category: categoryId,
                    required: data.required,
                    maxCount: data.maxCount,
                    dictionary: false
                    // dictionaryLink: data.dictionary ? 'https://content-suppliers.wildberries.ru/ns/characteristics-configurator-api/content-configurator/api/v1/directory/' + encodeURIComponent(data.dictionary.substring(1)) + '?lang=ru&top=500' : null
                } 
            } )

            this.cache.set('attr_'+categoryId, data, 3600)
        }
        return <ChannelAttribute[]>data
    }
}
