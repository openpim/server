import { Channel } from '../../models/channels'
import { ChannelAttribute, ChannelCategory, ChannelHandler } from '../ChannelHandler'
import fetch from 'node-fetch'
import * as FormData from 'form-data'
import NodeCache = require('node-cache')
import { Item } from '../../models/items'
import logger from "../../logger"
import { sequelize } from '../../models'
import { ModelsManager } from '../../models/manager'
import { Type } from '../../models/types'

interface JobContext {
    log: string
}

export class OzonChannelHandler extends ChannelHandler {
    private cache = new NodeCache();

    public async processChannel(channel: Channel, language: string, data: any): Promise<void> {
        const chanExec = await this.createExecution(channel)
       
        const context: JobContext = {log: ''}

        if (!channel.config.ozonClientId) {
            await this.finishExecution(channel, chanExec, 3, 'Не введен Client Id в конфигурации канала')
            return
        }
        if (!channel.config.ozonApiKey) {
            await this.finishExecution(channel, chanExec, 3, 'Не введен API key в конфигурации канала')
            return
        }
        if (!channel.config.ozonIdAttr) {
            await this.finishExecution(channel, chanExec, 3, 'Не введен атрибут где хранить Ozon ID')
            return
        }

        if (!data) {
            const query:any = {}
            query[channel.identifier] = {status: 1}
            let items = await Item.findAndCountAll({ 
                where: { tenantId: channel.tenantId, channels: query} 
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
    }

    async syncJob(channel: Channel, context: JobContext, data: any) {
        context.log += 'Запущена синхронизация с Ozon\n'

        let total = 0
        let current = 0
        const url = 'https://api-seller.ozon.ru/v1/product/list'
        const request = {
            "page": 1,
            "page_size": 1000
        }

        do {
            logger.info("Sending request Ozon: " + url + " => " + JSON.stringify(request))
            const res = await fetch(url, {
                method: 'post',
                body:    JSON.stringify(request),
                headers: { 'Client-Id': channel.config.ozonClientId, 'Api-Key': channel.config.ozonApiKey }
            })

            if (res.status !== 200) {
                const msg = 'Ошибка запроса на Ozon: ' + res.statusText
                context.log += msg                      
                return
            } else {
                const json = await res.json()
                if (json.error) {
                    const msg = 'Ошибка запроса на Ozon: ' + json.error.message
                    context.log += msg                      
                    logger.info("Error from Ozon: " + JSON.stringify(json))
                    return
                }

                total = json.result.total
                context.log += 'Найдено '+ total + ' товаров, выбрано ' + request.page_size + ' страница ' + request.page + '\n'
                current = request.page * request.page_size + 1
                request.page = request.page + 1

                for (let i = 0; i < json.result.items.length; i++) {
                    const card = json.result.items[i];
                    await this.syncCard(channel, card, context, data.attr)
                }
    
            }
        } while (total >= current)        

        context.log += 'Cинхронизация закончена'
    }

    async syncCard(channel: Channel, card: any, context: JobContext, attr:string) {
        const sku = card.offer_id
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

        if (card.product_id !== item.values[channel.config.ozonIdAttr] || (item.channels[channel.identifier] && item.channels[channel.identifier].status === 4)) {
            item.values[channel.config.ozonIdAttr] = card.product_id
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

            if (categoryConfig.valid && categoryConfig.valid.length > 0 && ( (categoryConfig.visible && categoryConfig.visible.length > 0) || categoryConfig.categoryExpr) ) {
                const pathArr = item.path.split('.')
                const tstType = categoryConfig.valid.includes(item.typeId) 
                if (tstType) {
                    const tst = categoryConfig.categoryExpr ? await this.evaluateExpression(channel, item, categoryConfig.categoryExpr) : categoryConfig.visible.find((elem:any) => pathArr.includes(''+elem))
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
                logger.warn('No valid/visible configuration for : ' + channel.identifier + ' for item: ' + item.identifier + ', tenant: ' + channel.tenantId)
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

        // request to Ozon
        const product:any = {attributes:[]}
        const request:any = {items:[product]}

        const productCodeConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#productCode')
        const productCode = await this.getValueByMapping(channel, productCodeConfig, item, language)
        if (!productCode) {
            const msg = 'Не введена конфигурация для "Артикула товара" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

        const vatConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#vat')
        const vat = await this.getValueByMapping(channel, vatConfig, item, language)

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

        const depthConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#depth')
        const depth = await this.getValueByMapping(channel, depthConfig, item, language)
        if (!depth) {
            const msg = 'Не введена конфигурация для "Длина упаковки" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

        const widthConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#width')
        const width = await this.getValueByMapping(channel, widthConfig, item, language)
        if (!width) {
            const msg = 'Не введена конфигурация для "Ширина упаковки" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

        const heightConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#height')
        const height = await this.getValueByMapping(channel, heightConfig, item, language)
        if (!height) {
            const msg = 'Не введена конфигурация для "Высота упаковки" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

        const weightConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#weight')
        const weight = await this.getValueByMapping(channel, weightConfig, item, language)
        if (!weight) {
            const msg = 'Не введена конфигурация для "Вес с упаковкой" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

        const ozonCategoryId = parseInt(categoryConfig.id.substring(4))
        product.category_id = ozonCategoryId
        product.offer_id = productCode
        product.barcode = barcode
        product.price = price
        product.weight = weight
        product.weight_unit = 'g'
        product.depth = depth
        product.height = height
        product.width = width
        product.dimension_unit = 'мм'
        product.vat = vat

        // atributes
        for (let i = 0; i < categoryConfig.attributes.length; i++) {
            const attrConfig = categoryConfig.attributes[i];
            
            if (
                attrConfig.id != '#productCode' && attrConfig.id != '#name' && attrConfig.id != '#barcode' && attrConfig.id != '#price' && 
                attrConfig.id != '#weight' && attrConfig.id != '#depth' && attrConfig.id != '#height' && attrConfig.id != '#width'
            ) {
                const attr = (await this.getAttributes(channel, categoryConfig.id)).find(elem => elem.id === attrConfig.id)
                if (!attr) {
                    logger.warn('Failed to find attribute in channel for attribute with id: ' + attrConfig.id)
                    continue
                }
                try {
                    const value = await this.getValueByMapping(channel, attrConfig, item, language)
                    if (value) {
                        const ozonAttrId = parseInt(attrConfig.id.substring(5))
                        const data = {complex_id:0, id: ozonAttrId, values: <any[]>[]}
                        if (Array.isArray(value)) {
                            for (let j = 0; j < value.length; j++) {
                                const elem = value[j];
                                const ozonValue = await this.generateValue(channel, ozonCategoryId, ozonAttrId, attr.dictionary, elem)
                                if (!ozonValue) {
                                    const msg = 'Значение "' + elem + '" не найдено в справочнике для атрибута "' + attr.name + '" для категории: ' + categoryConfig.name
                                    context.log += msg                      
                                    this.reportError(channel, item, msg)
                                    return
                                }
                                    data.values.push(ozonValue)
                            }
                        } if (typeof value === 'object') {
                            data.values.push(value)
                        } else {
                            const ozonValue = await this.generateValue(channel, ozonCategoryId, ozonAttrId, attr.dictionary, value)
                            if (!ozonValue) {
                                const msg = 'Значение "' + value + '" не найдено в справочнике для атрибута "' + attr.name + '" для категории: ' + categoryConfig.name
                                context.log += msg                      
                                this.reportError(channel, item, msg)
                                return
                            }
                            data.values.push(ozonValue)
                        }
                        product.attributes.push(data)
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
        
        const images = await this.processItemImages(channel, item, context)
        if (images && images.length>0 ) product.images = images

        const url = 'https://api-seller.ozon.ru/v2/product/import'
        logger.info("Sending request to Ozon: " + url + " => " + JSON.stringify(request))

        const res = await fetch(url, {
            method: 'post',
            body:    JSON.stringify(request),
            headers: { 'Client-Id': channel.config.ozonClientId, 'Api-Key': channel.config.ozonApiKey }
        })
        logger.info("Response status from Ozon: " + res.status)
        if (res.status !== 200) {
            const text = await res.text()
            const msg = 'Ошибка запроса на Ozon: ' + res.statusText + "   " + text
            context.log += msg                      
            this.reportError(channel, item, msg)
            logger.error(msg)
            return
        } else {
            const json = await res.json()
            logger.info("Response from Ozon: " + JSON.stringify(json))

            await this.sleep(2000)
            
            const taskId = json.result.task_id
            logger.info("Sending request to Ozon to check task id: " + taskId)
            const res2 = await fetch('https://api-seller.ozon.ru/v1/product/import/info', {
                method: 'post',
                body:    JSON.stringify({task_id: taskId}),
                headers: { 'Client-Id': channel.config.ozonClientId, 'Api-Key': channel.config.ozonApiKey }
            })
            if (res2.status !== 200) {
                const text = await res2.text()
                const msg = 'Ошибка запроса на Ozon: ' + res2.statusText + "   " + text
                context.log += msg                      
                this.reportError(channel, item, msg)
                logger.error(msg)
                return
            } else {
                const json2 = await res2.json()
                logger.info("Response 2 from Ozon: " + JSON.stringify(json2))
    
                const status = json2.result.items[0].status
                const data = item.channels[channel.identifier]
                if (status === 'imported') {
                    context.log += 'Запись с идентификатором: ' + item.identifier + ' обработана успешно.\n'
                    data.status = 2
                    data.message = ''
                    data.syncedAt = Date.now()
                    item.changed('channels', true)            
                    item.values[channel.config.ozonIdAttr] = json2.result.items[0].product_id
                    item.changed('values', true)
                } else if (status === 'failed') {
                    context.log += 'Запись с идентификатором: ' + item.identifier + ' обработана с ошибкой.\n'
                    data.status = 3
                    data.message = ''
                    item.changed('channels', true)            
                } else {
                    context.log += 'Запись с идентификатором: ' + item.identifier + ' обработана со статусом: ' + status + ' \n'
                    data.status = 4
                    data.message = ''
                    item.changed('channels', true)            
                }
            }
        }
    }

    async processItemImages(channel: Channel, item: Item, context: JobContext) {
        const data:string[] = [] 
        if (channel.config.imgRelations && channel.config.imgRelations.length > 0) {
            const mng = ModelsManager.getInstance().getModelManager(channel.tenantId)
            const typeNode = mng.getTypeById(item.typeId)
            if (!typeNode) {
                throw new Error('Failed to find type by id: ' + item.typeId + ', tenant: ' + mng.getTenantId())
            }
            const type:Type = typeNode.getValue()

            if (type.mainImage && channel.config.imgRelations.includes(type.mainImage)) {
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
                        ir."relationId" = :relation
                        order by a.id`, {
                    model: Item,
                    mapToModel: true,                     
                    replacements: { 
                        tenant: channel.tenantId,
                        itemId: item.id,
                        relation: type.mainImage
                    }
                })
                if (images) {
                    for (let i = 0; i < images.length; i++) {
                        const image = images[i];
                        if (image.values[channel.config.ozonImageAttr]) data.push(image.values[channel.config.ozonImageAttr])
                    }
                }
            }

            const rels = channel.config.imgRelations.filter((elem:any) => elem !== type.mainImage)
            if (rels.length > 0) {
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
                        relations: rels
                    }
                })
                if (images) {
                    for (let i = 0; i < images.length; i++) {
                        const image = images[i];
                        if (image.values[channel.config.ozonImageAttr]) data.push(image.values[channel.config.ozonImageAttr])
                    }
                }
            }
        }
        return data
    }    
    private async generateValue(channel: Channel, ozonCategoryId: number, ozonAttrId: number, dictionary: boolean, value: any) {
        if (dictionary) {
            let dict: any[] | undefined = this.cache.get('dict_'+ozonCategoryId+'_'+ozonAttrId)
            if (!dict) {
                dict = []
                let next = false
                let last = 0
                do {
                    const res = await fetch('https://api-seller.ozon.ru/v2/category/attribute/values', {
                        method: 'post',
                        body:    JSON.stringify({
                            "attribute_id": ozonAttrId,
                            "category_id": ozonCategoryId,
                            "language": "DEFAULT",
                            "last_value_id": last,
                            "limit": 5000
                            }),
                        headers: { 'Content-Type': 'application/json', 'Client-Id': channel.config.ozonClientId, 'Api-Key': channel.config.ozonApiKey }
                    })
                    const json = await res.json()
                    dict = dict.concat(json.result)
                    next = json.has_next
                    last = dict[dict.length-1].id
                } while (next)
    
                this.cache.set('dict_'+ozonCategoryId+'_'+ozonAttrId, dict, 3600)
            }
            const entry = dict!.find((elem:any) => elem.value === value)
            if (!entry) {
                return null
            } else {
                return {dictionary_value_id: entry.id, value: value}
            }
        } else {
            return { value: value }
        }
    }

    public async getCategories(channel: Channel): Promise<ChannelCategory[]> {
        if (!channel.config.ozonClientId) throw new Error('Не введен Client Id в конфигурации канала.')
        if (!channel.config.ozonApiKey) throw new Error('Не введен Api Key в конфигурации канала.')

        let data = this.cache.get('categories')
        if (! data) {
            const res = await fetch('https://api-seller.ozon.ru/v1/categories/tree?language=DEFAULT', {
                headers: { 'Client-Id': channel.config.ozonClientId, 'Api-Key': channel.config.ozonApiKey }
            })
            const json = await res.json()
            data = []
            this.collectAllLeafs(json.result, <ChannelCategory[]>data)
            this.cache.set('categories', data, 3600)
        }
        return <ChannelCategory[]>data
    }
    private collectAllLeafs(arr: any[], data: ChannelCategory[]) {
        arr.forEach(elem => {
          if (elem.children) {
              if (elem.children.length > 0) {
                this.collectAllLeafs(elem.children, data)
              } else {
                data.push({id: 'cat_' + elem.category_id, name: elem.title})
              }
          }  
        })
    }

    
    public async getAttributes(channel: Channel, categoryId: string): Promise<ChannelAttribute[]> {
        let data = this.cache.get('attr_'+categoryId)
        if (! data) {
            const query = {
                attribute_type: "ALL",
                category_id: [categoryId.substring(4)],
                language: "DEFAULT"
              }
              logger.info("Sending request to Ozon: https://api-seller.ozon.ru/v3/category/attribute => " + JSON.stringify(query))
              const res = await fetch('https://api-seller.ozon.ru/v3/category/attribute', {
                method: 'post',
                body:    JSON.stringify(query),
                headers: { 'Content-Type': 'application/json', 'Client-Id': channel.config.ozonClientId, 'Api-Key': channel.config.ozonApiKey }
            })
            if (res.status !== 200) {
                const text = await res.text()
                throw new Error("Failed to query attributes with error: " + res.statusText+", text: " + text)
            }
            const json = await res.json()

            data = json.result[0].attributes.map((elem:any) => { 
                return { 
                    id: 'attr_' + elem.id, 
                    name: elem.name,
                    required: elem.is_required,
                    description: elem.description,
                    dictionary: elem.dictionary_id !== 0,
                    dictionaryLinkPost: elem.dictionary_id !== 0 ? { body: {
                        attribute_id: elem.id,
                        category_id: categoryId.substring(4),
                        language: "DEFAULT",
                        last_value_id: 0,
                        limit: 1000
                      }, headers: { 'Content-Type': 'application/json', 'Client-Id': channel.config.ozonClientId, 'Api-Key': channel.config.ozonApiKey } } : null,
                    dictionaryLink: elem.dictionary_id !== 0 ? 'https://api-seller.ozon.ru/v2/category/attribute/values' : null
                } 
            } )


            this.cache.set('attr_'+categoryId, data, 3600)
        }
        return <ChannelAttribute[]>data
    }
}
