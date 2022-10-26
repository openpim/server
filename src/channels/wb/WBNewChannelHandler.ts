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
    private cache = new NodeCache();

    public async processChannel(channel: Channel, language: string, data: any): Promise<void> {
        
        const chanExec = await this.createExecution(channel)

        const context: JobContext = {log: ''}

        if (!channel.config.wbToken) {
            await this.finishExecution(channel, chanExec, 3, 'Не введен API token в конфигурации канала')
            return
        }

        if (!channel.config.wbIdAttr) {
            await this.finishExecution(channel, chanExec, 3, 'Не введен атрибут где хранить Wildberries ID')
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

        const errorsResp = await fetch('https://suppliers-api.wildberries.ru/content/v1/cards/error/list', {
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
                where: { tenantId: channel.tenantId, values: query} 
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
                const request = {vendorCodes: [article]}
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
                    if (channel.config.imtIDAttr) item.values[channel.config.imtIDAttr] = json.data[0].imtID
                    if (channel.config.nmIDAttr) item.values[channel.config.nmIDAttr] = json.data[0].nmID
                    item.changed('values', true)
                    item.channels[channel.identifier].status = 2
                    item.channels[channel.identifier].message = ""
                    item.channels[channel.identifier].syncedAt = Date.now()
                    item.changed('channels', true)
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
        const productCode = await this.getValueByMapping(channel, productCodeConfig, item, language)
        if (!productCode) {
            const msg = 'Не введена конфигурация для "Артикула товара" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

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
        let request:any = {vendorCode:productCode, characteristics:[{"Предмет": categoryConfig.name}], sizes:[]}

        const size = {wbSize:"", price: price, skus: [barcode]}
        request.sizes.push(size)

        // atributes
        for (let i = 0; i < categoryConfig.attributes.length; i++) {
            const attrConfig = categoryConfig.attributes[i];
            
            if (
                attrConfig.id != '#productCode' && attrConfig.id != '#barcode' && attrConfig.id != '#price'
            ) {
                const attr = (await this.getAttributes(channel, categoryConfig.id)).find(elem => elem.id === attrConfig.id)
                if (!attr) {
                    logger.warn('Failed to find attribute in channel for attribute with id: ' + attrConfig.id)
                    continue
                }
                try {
                    const value = await this.getValueByMapping(channel, attrConfig, item, language)
                    if (value) {
                        const data:any = {}
                        data[attr.type] = attr.maxCount === 0 ? value : [value]

                        request.characteristics.push(data)
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

        await this.sendRequest(channel, item, [[request]], context)
    }

    async sendRequest(channel: Channel, item: Item, request: any, context: JobContext) {
        const create = item.values[channel.config.wbIdAttr] ? false : true

        if (!create) request.params.card.imtId = parseInt(item.values[channel.config.wbIdAttr])
        const url = create ? 'https://suppliers-api.wildberries.ru/content/v1/cards/upload' : 'https://suppliers-api.wildberries.ru/content/v1/cards/update'
        let msg = "Sending request Windberries: " + url + " => " + JSON.stringify(request)
        logger.info(msg)
        if (channel.config.debug) context.log += msg+'\n'

        const res = await fetch(url, {
            method: 'post',
            body:    JSON.stringify(request),
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

    async processItemImages(channel: Channel, item: Item, context: JobContext) {
        const data:{value: string, units:string}[] = [] 
        if (channel.config.imgRelations && channel.config.imgRelations.length > 0) {
            const images: Item[] = await sequelize.query(
                `SELECT a.*
                    FROM "items" a, "itemRelations" ir, "types" t where 
                    a."tenantId"=:tenant and 
                    ir."itemId"=:itemId and
                    a."id"=ir."targetId" and
                    a."typeId"=t."id" and
                    t."file"=true and
                    coalesce(a."storagePath", '') != '' and
                    ir."deletedAt" is null and
                    a."deletedAt" is null and
                    ir."relationId" in (:relations)
                    order by a.id`, {
                model: Item,
                mapToModel: true,                     
                replacements: { 
                    tenant: channel.tenantId,
                    itemId: item.id,
                    relations: channel.config.imgRelations
                }
            })
            if (images) {
                for (let i = 0; i < images.length; i++) {
                    const image = images[i];
                    const form = new FormData()
                    form.append('uploadfile', fs.createReadStream(process.env.FILES_ROOT + image.storagePath), {
                        contentType: image.mimeType,
                        filename: image.fileOrigName,
                    })
                    const headers = form.getHeaders()
                    headers.Authorization = channel.config.wbToken
                    const fileId = uuid.v4()
                    headers['X-File-Id'] = fileId 
                    context.log += 'Загружаю файл '+image.identifier+'\n'
                    logger.info('Загружаю файл '+image.identifier)                
                    const res = await fetch('https://suppliers-api.wildberries.ru/card/upload/file/multipart', {
                        method: 'post',
                        body:    form,
                        headers: headers
                    })
                    if (res.status !== 200) {
                        const msg = 'Ошибка загрузки файла на Wildberries: ' + res.statusText
                        context.log += msg                      
                        this.reportError(channel, item, msg)
                        return
                    } else {
                        data.push({value: fileId, units:image.mimeType})
                    }                                        
                }
            }
        }
        return data
    }


    public async getCategories(channel: Channel): Promise<{list: ChannelCategory[]|null, tree: ChannelCategory|null}> {
        let data = this.cache.get('categories')
        if (! data) {
            const res = await fetch('https://suppliers-api.wildberries.ru/content/v1/object/all?top=10000', {
                method: 'get',
                body:    JSON.stringify(request),
                headers: { 'Content-Type': 'application/json', 'Authorization': channel.config.wbToken },
            })
            const json = await res.json()
            data = Object.values(json.data).map((value:any) => { return {id: this.transliterate((value.objectName).toLowerCase().replace('-','_')), name: value.objectName} })
            this.cache.set('categories', data, 3600)
        }
        return { list: <ChannelCategory[]>data, tree: null }
    }
    
    public async getAttributes(channel: Channel, categoryId: string): Promise<ChannelAttribute[]> {
        let data = this.cache.get('attr_'+categoryId)
        if (!data) {
            const categories = await this.getCategories(channel)
            const category = categories.list!.find((elem:any) => elem.id === categoryId)

            if (!category) throw new Error('Failed to find category by id: ' + categoryId)

            const res = await fetch('https://suppliers-api.wildberries.ru/content/v1/object/characteristics/' + encodeURIComponent(category.name), {
                method: 'get',
                body:    JSON.stringify(request),
                headers: { 'Content-Type': 'application/json', 'Authorization': channel.config.wbToken },
            })
            const json = await res.json()
            data = Object.values(json.data).map((data:any) => { 
                return { 
                    id: this.transliterate((<string>data.name).toLowerCase()), 
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
