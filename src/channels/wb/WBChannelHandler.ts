import { Channel, ChannelExecution } from '../../models/channels'
import { ChannelAttribute, ChannelCategory, ChannelHandler } from '../ChannelHandler'
import fetch from 'node-fetch'
import * as FormData from 'form-data'
import NodeCache = require('node-cache')
import { Item } from '../../models/items'
import logger from "../../logger"
import { sequelize } from '../../models'
import * as uuid from "uuid"
import * as fs from 'fs'

interface JobContext {
    log: string
    variantParent?: string
    variantRequest?: any
    variantItems?: [Item]
}

export class WBChannelHandler extends ChannelHandler {
    private cache = new NodeCache();

    public async processChannel(channel: Channel, language: string, data: any): Promise<void> {
        const chanExec = await this.createExecution(channel)
      
        const context: JobContext = {log: ''}

        if (!channel.config.wbToken) {
            await this.finishExecution(channel, chanExec, 3, 'Не введен API token в конфигурации канала')
            return
        }
        if (!channel.config.wbSupplierID) {
            await this.finishExecution(channel, chanExec, 3, 'Не введен идентификатор поставщика в конфигурации канала')
            return
        }

        if (!channel.config.wbIdAttr) {
            await this.finishExecution(channel, chanExec, 3, 'Не введен атрибут где хранить Wildberries ID')
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
                if (context.variantRequest) { // send last variant request that was not processed
                    await this.sendVariantsRequest(channel, context)
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
        context.log += 'Запущена синхронизация с Wildberries\n'

        let total = 0
        let current = 0
        const url = 'https://suppliers-api.wildberries.ru/card/list'
        const request = {
            "id": uuid.v4(),
            "jsonrpc": "2.0",
            "params": {
              "query": {
                "limit": 1000,
                "offset": 0
              }
            }
        }

        do {
            logger.info("Sending request Windberries: " + url + " => " + JSON.stringify(request))
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
                if (json.error) {
                    const msg = 'Ошибка запроса на Wildberries: ' + json.error.message
                    context.log += msg                      
                    logger.info("Error from Windberries: " + JSON.stringify(json))
                    return
                }

                total = json.result.cursor.total
                context.log += 'Найдено '+ total + ' товаров, выбрано ' + request.params.query.limit + ' со смещением ' + request.params.query.offset + '\n'
                current = request.params.query.offset + request.params.query.limit + 1
                request.params.query.offset = current

                for (let i = 0; i < json.result.cards.length; i++) {
                    const card = json.result.cards[i];
                    await this.syncCard(channel, card, context, data.attr)
                }
    
            }
        } while (total >= current)

        context.log += 'Cинхронизация закончена'
    }

    async syncCard(channel: Channel, card: any, context: JobContext, attr:string) {
        const sku = card.nomenclatures[0].vendorCode
        context.log += 'Обрабатывается товар: ['+ sku + ']\n'

        const filter:any = {}
        filter[attr] = sku
        const item = await Item.findOne({
            where: {
                values: filter,
                tenantId: channel.tenantId
            }
        })
        
        if(!item) {
            context.log += '   такой товар не найден\n'
            return
        }

        if (card.imtId !== item.values[channel.config.wbIdAttr]) {
            item.values[channel.config.wbIdAttr] = card.imtId
            item.changed('values', true)
            if (item.channels[channel.identifier] && item.channels[channel.identifier].status === 4) {
                item.channels[channel.identifier].status = 2
                item.channels[channel.identifier].message = ''
                item.changed('channels', true)
            }
            await sequelize.transaction(async (t) => {
                await item.save({transaction: t})
            })    
            context.log += '  товар c идентификатором ' + item.identifier + ' синхронизирован \n'
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
                        tst = categoryConfig.visible.find((elem:any) => pathArr.includes(''+elem))
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

    async sendVariantsRequest(channel: Channel, context: JobContext) {
        const varItem = context.variantItems![0]
        await this.sendRequest(channel, varItem, context.variantRequest, context)
        const data = varItem.channels[channel.identifier]
        for (let i = 0; i < context.variantItems!.length; i++) {
            const item = context.variantItems![i]
            item.channels[channel.identifier] = data
            item.changed('channels', true)
            item.values[channel.config.wbIdAttr] = varItem.values[channel.config.wbIdAttr]
            item.changed('values', true)
            await sequelize.transaction(async (t) => {
                await varItem.save({transaction: t})
            })
        }
    }

    async processItemInCategory(channel: Channel, item: Item, categoryConfig: any, language: string, context: JobContext) {
        context.log += 'Найдена категория "' + categoryConfig.name +'" для записи с идентификатором: ' + item.identifier + '\n'

        const data = item.channels[channel.identifier]
        data.category = categoryConfig.id
        
        // request to WB
        let request:any = {id: uuid.v4(), jsonrpc: '2.0', params: { supplierID: channel.config.wbSupplierID, card: {}}}

        const create = item.values[channel.config.wbIdAttr] ? false : true

        // check for variant
        const variant = this.isVariant(channel, item)
        if (variant) {
            if (item.parentIdentifier != context.variantParent) {
                if (context.variantRequest) {
                    await this.sendVariantsRequest(channel, context)
                }
                context.variantParent = item.parentIdentifier
                context.variantRequest = request
                context.variantItems = [item]
            } else {
                request = context.variantRequest
                context.variantItems!.push(item)
            }
        } else {
            if (context.variantParent) delete context.variantParent
            if (context.variantRequest) delete context.variantRequest
            if (context.variantItems) delete context.variantItems
        }

        if (!create && !variant) {
            // load card from WB
            const loadUrl = 'https://suppliers-api.wildberries.ru/card/cardByImtID'
            const loadRequest = {
                id: uuid.v4(),
                jsonrpc: "2.0",
                params: {
                    imtID: item.values[channel.config.wbIdAttr]
                }
            }
            logger.info("Sending request Windberries: " + loadUrl + " => " + JSON.stringify(loadRequest))
            const res = await fetch(loadUrl, {
                method: 'post',
                body:    JSON.stringify(loadRequest),
                headers: { 'Content-Type': 'application/json', 'Authorization': channel.config.wbToken },
            })
            logger.info("Response status from Windberries: " + res.status)
            if (res.status !== 200) {
                const msg = 'Ошибка запроса на Wildberries: ' + res.statusText
                context.log += msg                      
                this.reportError(channel, item, msg)
                return
            } else {
                const json = await res.json()
                if (json.error) {
                    const msg = 'Ошибка запроса на Wildberries: ' + json.error.message
                    this.reportError(channel, item, msg)
                    context.log += msg                      
                    logger.info("Error from Windberries: " + JSON.stringify(json))
                    return
                }
                request.params.card = json.result.card
            }
        }

        const prodCountryConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#prodCountry')
        request.params.card.countryProduction = await this.getValueByMapping(channel, prodCountryConfig, item, language)
        if (!request.params.card.countryProduction) {
            const msg = 'Не введена конфигурация для "Страны производства" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

        const supplierCodeConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#supplierCode')
        const vendorCode = await this.getValueByMapping(channel, supplierCodeConfig, item, language)
        request.params.card.supplierVendorCode = vendorCode
        if (!request.params.card.supplierVendorCode) {
            const msg = 'Не введена конфигурация для "Артикула поставщика" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

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
        const tmp = {
            "type": "Розничная цена",
            "params": [
              {
                "count": price
              }
            ]
          }
        if (!request.params.card.nomenclatures) request.params.card.nomenclatures = []
        let idx
        if (create) {
            idx = request.params.card.nomenclatures.push({vendorCode: productCode, variations:[{barcode: barcode, addin:[tmp]}]}) - 1
        } else {
            idx = request.params.card.nomenclatures.findIndex((elem:any) => elem.vendorCode === productCode)
            if (idx === -1) idx = request.params.card.nomenclatures.push({vendorCode: productCode, variations:[{barcode: barcode, addin:[tmp]}]}) - 1
        }

        request.params.card.object = categoryConfig.name

        // atributes
        for (let i = 0; i < categoryConfig.attributes.length; i++) {
            const attrConfig = categoryConfig.attributes[i];
            
            if (attrConfig.id != '#prodCountry' && attrConfig.id != '#supplierCode' && attrConfig.id != '#barcode' && attrConfig.id != '#price' && attrConfig.id != '#productCode') {
                const attr = (await this.getAttributes(channel, categoryConfig.id)).find(elem => elem.id === attrConfig.id)
                if (!attr) {
                    logger.warn('Failed to find attribute in channel for attribute with id: ' + attrConfig.id)
                    continue
                }
                try {
                    const value = await this.getValueByMapping(channel, attrConfig, item, language)
                    if (value) {
                        const data = {type: attr.name, params: <any[]>[]}
                        if (Array.isArray(value)) {
                            value.forEach((elem:any) => {
                                data.params.push({ value: elem })
                            })
                        } else {
                            data.params.push({ value: value })
                        }

                        if (attrConfig.id.startsWith('nom#')) {
                            if (!request.params.card.nomenclatures[idx].addin) request.params.card.nomenclatures[idx].addin = []
                            if (!create) this.clearPreviousValue(request.params.card.nomenclatures[idx].addin, data.type)
                            request.params.card.nomenclatures[idx].addin.push(data)
                        } else if (attrConfig.id.startsWith('var#')) {
                            if (!request.params.card.nomenclatures[idx].variations[0].addin) request.params.card.nomenclatures[idx].variations[0].addin = []
                            if (!create) this.clearPreviousValue(request.params.card.nomenclatures[idx].variations[0].addin, data.type)
                            request.params.card.nomenclatures[idx].variations[0].addin.push(data)
                        } else {
                            if (!request.params.card.addin) request.params.card.addin = []
                            if (!create) this.clearPreviousValue(request.params.card.addin, data.type)
                            request.params.card.addin.push(data)
                        }
                    } else if (attr.required) {
                        const msg = 'Нет значения для обязательного атрибута "' + attr.name + '" для категории: ' + categoryConfig.name
                        context.log += msg                      
                        this.reportError(channel, item, msg)
                        return
                    }
                } catch (err) {
                    const msg = 'Ошибка вычисления атрибута "' + attr.name + '" для категории: ' + categoryConfig.name
                    logger.error(msg, err)
                    context.log += msg + ': ' + err.message        
                    this.reportError(channel, item, msg + ': ' + err.message)
                    return
                  }
            }
        }

        //images
        const images = await this.processItemImages(channel, item, context)
        if (images && images.length>0 ) {
            if (!request.params.card.nomenclatures[idx].addin) request.params.card.nomenclatures[idx].addin = []
            if (!create) this.clearPreviousValue(request.params.card.nomenclatures[idx].addin, "Фото")
            request.params.card.nomenclatures[idx].addin.push({type: "Фото", params: images})
        }

        // console.log(JSON.stringify(request))
        if (!variant) await this.sendRequest(channel, item, request, context)
    }

    private clearPreviousValue(arr: any[], type: string) {
        const tst = arr.findIndex((elem:any) => elem.type === type)
        if (tst != -1) arr.splice(tst, 1)
    }

    async sendRequest(channel: Channel, item: Item, request: any, context: JobContext) {
        const create = item.values[channel.config.wbIdAttr] ? false : true

        if (!create) request.params.card.imtId = item.values[channel.config.wbIdAttr]
        const url = create ? 'https://suppliers-api.wildberries.ru/card/create' : 'https://suppliers-api.wildberries.ru/card/update'
        logger.info("Sending request Windberries: " + url + " => " + JSON.stringify(request))

        const res = await fetch(url, {
            method: 'post',
            body:    JSON.stringify(request),
            headers: { 'Content-Type': 'application/json', 'Authorization': channel.config.wbToken },
        })
        logger.info("Response status from Windberries: " + res.status)
        if (res.status !== 200) {
            const msg = 'Ошибка запроса на Wildberries: ' + res.statusText
            context.log += msg                      
            this.reportError(channel, item, msg)
            return
        } else {
            const json = await res.json()
            if (json.error) {
                const msg = 'Ошибка запроса на Wildberries: ' + json.error.message
                this.reportError(channel, item, msg)
                context.log += msg                      
                logger.info("Error from Windberries: " + JSON.stringify(json))
                return
            }
        }

        if (create) {
            // check that card was created and take id
            await new Promise(resolve => setTimeout(resolve, 3000)) // wait 3 seconds
            const query = {
                "id": "11",
                "jsonrpc": "2.0",
                "params": {
                  "filter": {
                      "find": [
                          {
                              "column": "nomenclatures.vendorCode",
                              "search": request.params.card.supplierVendorCode
                          }
                      ]
                  },
                  "query": {
                    "limit": 1,
                    "offset": 0
                  }
                }
            }
            const res = await fetch('https://suppliers-api.wildberries.ru/card/list', {
                method: 'post',
                body:    JSON.stringify(query),
                headers: { 'Content-Type': 'application/json', 'Authorization': channel.config.wbToken },
            })
            if (res.status !== 200) {
                const msg = 'Ошибка запроса проверки на Wildberries: ' + res.statusText
                context.log += msg                      
                this.reportError(channel, item, msg)
                return
            } else {
                const json = await res.json()
                if (json.error) {
                    const msg = 'Ошибка запроса проверки на Wildberries: ' + json.error.message
                    context.log += msg                      
                    this.reportError(channel, item, msg)
                    logger.info("Check error from Windberries: " + JSON.stringify(json))
                    return
                }

                if (json.result.cursor.total === 0) {
                    const msg = 'Wildberries не вернул ошибку, статус выставлен в ожидание.'
                    context.log += msg                      
                    const data = item.channels[channel.identifier]
                    data.status = 4
                    data.message = ''
                    item.changed('channels', true)
                    return
                }
                item.values[channel.config.wbIdAttr] = json.result.cards[0].imtId
                item.changed('values', true)
            }
        }

        context.log += 'Запись с идентификатором: ' + item.identifier + ' обработана успешно.\n'
        const data = item.channels[channel.identifier]
        data.status = 2
        data.message = ''
        data.syncedAt = Date.now()
        item.changed('channels', true)
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
            const res = await fetch('https://content-suppliers.wildberries.ru/ns/characteristics-configurator-api/content-configurator/api/v1/config/get/object/all?top=10000&lang=ru')
            const json = await res.json()
            data = Object.values(json.data).map(value => { return {id: this.transliterate((<string>value).toLowerCase()), name: value} } )
            this.cache.set('categories', data, 3600)
        }
        return { list: <ChannelCategory[]>data, tree: null }
    }
    
    public async getAttributes(channel: Channel, categoryId: string): Promise<ChannelAttribute[]> {
        let data = this.cache.get('attr_'+categoryId)
        if (! data) {
            const categories = await this.getCategories(channel)
            const category = categories.list!.find((elem:any) => elem.id === categoryId)

            if (!category) throw new Error('Failed to find category by id: ' + categoryId)

            const res = await fetch('https://content-suppliers.wildberries.ru/ns/characteristics-configurator-api/content-configurator/api/v1/config/get/object/translated?name=' + encodeURIComponent(category.name) + '&lang=ru')
            const json = await res.json()
            data = Object.values(json.data.addin).map((addin:any) => { 
                return { 
                    id: this.transliterate((<string>addin.type).toLowerCase()), 
                    name: addin.type + (addin.units ? ' (' + addin.units[0] + ')' : ''),
                    required: addin.required,
                    dictionary: !!addin.dictionary,
                    dictionaryLink: addin.dictionary ? 'https://content-suppliers.wildberries.ru/ns/characteristics-configurator-api/content-configurator/api/v1/directory/' + encodeURIComponent(addin.dictionary.substring(1)) + '?lang=ru&top=500' : null
                } 
            } )

            if (json.data.nomenclature && json.data.nomenclature.addin) {
                const nomenclature = json.data.nomenclature.addin.map((addin:any) => { 
                    return { 
                        id: 'nom#' + this.transliterate((<string>addin.type).toLowerCase()), 
                        name: addin.type + (addin.units ? ' (' + addin.units[0] + ')' : ''),
                        required: addin.required,
                        dictionary: !!addin.dictionary,
                        dictionaryLink: addin.dictionary ? 'https://content-suppliers.wildberries.ru/ns/characteristics-configurator-api/content-configurator/api/v1/directory/' + encodeURIComponent(addin.dictionary.substring(1)) + '?lang=ru&top=500' : null
                    } 
                } )
                data = [...<ChannelAttribute[]>data, ...nomenclature]
            }

            if (json.data.nomenclature.variation && json.data.nomenclature.variation.addin) {
                const variation = json.data.nomenclature.variation.addin.map((addin:any) => { 
                    return { 
                        id: 'var#' + this.transliterate((<string>addin.type).toLowerCase()), 
                        name: addin.type + (addin.units ? ' (' + addin.units[0] + ')' : ''),
                        required: addin.required,
                        dictionary: !!addin.dictionary,
                        dictionaryLink: addin.dictionary ? 'https://content-suppliers.wildberries.ru/ns/characteristics-configurator-api/content-configurator/api/v1/directory/' + encodeURIComponent(addin.dictionary.substring(1)) + '?lang=ru&top=500' : null
                    } 
                } )
                data = [...<ChannelAttribute[]>data, ...variation]
            }

            this.cache.set('attr_'+categoryId, data, 3600)
        }
        return <ChannelAttribute[]>data
    }
}
        /*
        const tstReq = {
            "params": {
                "supplierId": "d9ad5a14-faf8-4ecd-b0d1-4d94bc9d4a9d",
                "card": {
                    "countryProduction": "Италия",
                    "supplierVendorCode": "23220",
                    "object": "Помады",
                    "nomenclatures": [
                        {
                            "vendorCode": "23220",
                            "variations": [
                                {
                                    "barcode": "1640018232206",
                                    "addin": [
                                        {
                                            "type": "Розничная цена",
                                            "params": [
                                                {
                                                    "count": 100
                                                }
                                            ]
                                        }
                                    ]
                                }
                            ]
                        }
                    ],
                    "addin": [
                        {
                            "type": "Состав",
                            "params": [
                                {
                                    "value": "Dimethicone",
                                    "count": 100
                                }
                            ]
                        },
                        {
                            "type": "Тнвэд",
                            "params": [
                                {
                                    "value": "3304100000"
                                }
                            ]
                        },
                        {
                            "type": "Бренд",
                            "params": [
                                {
                                    "value": "Limoni"
                                }
                            ]
                        },
                        {
                            "type": "Комплектация",
                            "params": [
                                {
                                    "value": "Помада -1 шт."
                                }
                            ]
                        },
                        {
                            "type": "Наименование",
                            "params": [
                                {
                                    "value": "LIMONI Матовая жидкая помада-крем"
                                }
                            ]
                        },
                        {
                            "type": "Описание",
                            "params": [
                                {
                                    "value": "Матовая жидкая помада-крем Matte Lip Cream окутывает губы шелковистой вуалью, оставляя ощущение невесомости. В состав кремовой матовой помады Matte Lip Cream входит масло Ши, которое прекрасно увлажняет и смягчает губы. Благодаря удобному аппликатору помада легко и равномерно наносится на поверхность губ, а ультрастойкая пигментированная формула сохраняет макияж надолго. Легкое нанесение и плотное покрытие всего в один слой.Жидкая матовая помада Matte Lip Cream не сбивается в складках кожи, \n\nне растекается. Удобная компактная упаковка с легкостью поместится даже в самой маленькой косметичке."
                                }
                            ]
                        }
                    ]
                }
            },
            "jsonrpc": "2.0",
            "id": "d9ad5a14-faf8-4ecd-b0d1-4d94bc9d4a9d"
        }*/