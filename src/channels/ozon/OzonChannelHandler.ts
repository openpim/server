import { Channel, ChannelExecution } from '../../models/channels'
import { ChannelAttribute, ChannelCategory, ChannelHandler } from '../ChannelHandler'
import fetch from 'node-fetch'
import * as FormData from 'form-data'
import NodeCache = require('node-cache')
import { Item } from '../../models/items'
import logger from "../../logger"
import { sequelize } from '../../models'
import { ModelsManager } from '../../models/manager'
import { Type } from '../../models/types'
import { Op } from 'sequelize'
import { ItemRelation } from '../../models/itemRelations'
import Context from '../../context'
import { processItemActions } from '../../resolvers/utils'
import { EventType } from '../../models/actions'

const NEW_VER_DELIMETER = '-'

interface JobContext {
    log: string
}

export class OzonChannelHandler extends ChannelHandler {
    private cache = new NodeCache({useClones: false});

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

        try {
            if (!data) {
                const query:any = {}
                query[channel.identifier] = {status: 1}
                let items = await Item.findAndCountAll({ 
                    where: { tenantId: channel.tenantId, channels: query} 
                })
                context.log += 'Запущена выгрузка на Ozon\n'
                context.log += 'Найдено ' + items.count +' записей для обработки \n\n'
                for (let i = 0; i < items.rows.length; i++) {
                    const item = items.rows[i];
                    await this.processItem(channel, item, language, context)
                    context.log += '\n\n'
                }
            } else if (data.sync) {
                await this.syncJob(channel, context, data)
            } else if (data.clearCache) {
                this.cache.flushAll()
                this.clearLOVCache()
                context.log += 'Кеш очищен'
            }

            await this.finishExecution(channel, chanExec, 2, context.log)
        } catch (err) {
            logger.error("Error on channel processing", err)
            context.log += 'Ошибка запуска канала - '+ JSON.stringify(err)
            await this.finishExecution(channel, chanExec, 3, context.log)
        }
    }

    async syncJob(channel: Channel, context: JobContext, data: any) {
        context.log += 'Запущена синхронизация с Ozon\n'

        if (data.item) {
            const item = await Item.findByPk(data.item)
            await this.syncItem(channel, item!, context, true)
        } else {
            const query:any = {}
            query[channel.config.ozonIdAttr] = { [Op.ne]: '' }
            let items = await Item.findAll({ 
                where: { tenantId: channel.tenantId, values: query} 
            })
            context.log += 'Найдено ' + items.length + ' записей для обработки \n\n'
            const itemsWithoutTaskId = items.filter(item => !('' + item.values[channel.config.ozonIdAttr]).startsWith('task_id='))
            await this.syncItems(channel, itemsWithoutTaskId, context)

            const itemsWithTaskId = items.filter(item => ('' + item.values[channel.config.ozonIdAttr]).startsWith('task_id='))
            for (let item of itemsWithTaskId) {
                await this.syncItem(channel, item!, context, false)
            }

        }
        context.log += 'Cинхронизация закончена'
    }

    processProductStatus(item: Item, result: any, channel: Channel, context: JobContext) {
        const status = result.status
        context.log += '   статус товара: ' + JSON.stringify(status)

        if (status.is_created && !status.is_failed && status.moderate_status !== 'declined') {
            item.channels[channel.identifier].status = 2
            item.channels[channel.identifier].message = JSON.stringify(status)
            item.channels[channel.identifier].syncedAt = new Date().getTime()
            item.changed('channels', true)

            logger.info('   product sources: ' + JSON.stringify(result.sources))
            context.log += '   sources: ' + JSON.stringify(result.sources)

            if (channel.config.ozonFBSIdAttr) {
                const fbs = result.sources.find((elem: any) => elem.source === 'fbs')
                if (fbs || result.sku) {
                    item.values[channel.config.ozonFBSIdAttr] = '' + (fbs?.sku || result.sku)
                    item.changed('values', true)
                }
            }
            if (channel.config.ozonFBOIdAttr) {
                const fbo = result.sources.find((elem: any) => elem.source === 'fbo')
                if (fbo || result.sku) {
                    item.values[channel.config.ozonFBOIdAttr] = '' + (fbo?.sku || result.sku)
                    item.changed('values', true)
                }
            }
        } else if (status.is_failed || status.moderate_status === 'declined') {
            item.channels[channel.identifier].status = 3
            item.channels[channel.identifier].message = JSON.stringify(status)
            item.channels[channel.identifier].syncedAt = new Date().getTime()
            item.changed('channels', true)
        } else {
            item.channels[channel.identifier].status = 4
            item.channels[channel.identifier].message = 'Модерация: ' + JSON.stringify(status)
            item.channels[channel.identifier].syncedAt = new Date().getTime()
            item.changed('channels', true)
        }
    }

    async syncItem(channel: Channel, item: Item, context: JobContext, singleSync: boolean) {
        context.log += 'Обрабатывается товар c идентификатором: [' + item.identifier + ']\n'

        if (item.values[channel.config.ozonIdAttr] && item.channels[channel.identifier]) {
            const chanData = item.channels[channel.identifier]
            if (!singleSync && chanData.status === 3) {
                context.log += 'Статус товара - ошибка, синхронизация не будет проводиться \n'
                return
            }

            const tst = '' + item.values[channel.config.ozonIdAttr]
            if (tst.startsWith('task_id=')) {
                // receive product id first
                const taskId = tst.substring(8)
                const log2 = "Sending request to Ozon to check task id: " + taskId
                logger.info(log2)
                if (channel.config.debug) context.log += log2 + '\n'
                const res2 = await fetch('https://api-seller.ozon.ru/v1/product/import/info', {
                    method: 'post',
                    body: JSON.stringify({ task_id: taskId }),
                    headers: { 'Client-Id': channel.config.ozonClientId, 'Api-Key': channel.config.ozonApiKey }
                })
                if (res2.status !== 200) {
                    const text = await res2.text()
                    const msg = 'Ошибка запроса на Ozon: ' + res2.statusText + " " + text
                    context.log += msg
                    this.reportError(channel, item, msg)
                    logger.error(msg)
                    return
                } else {
                    const json2 = await res2.json()
                    const log3 = "Response 2 from Ozon: " + JSON.stringify(json2)
                    logger.info(log3)
                    if (channel.config.debug) context.log += log3 + '\n'
                    if (json2.result.items.length === 0 || json2.result.items[0].product_id == 0) {
                        context.log += '  товар c идентификатором ' + item.identifier + ' пока не получил product_id \n'
                        return
                    } else {
                        item.values[channel.config.ozonIdAttr] = json2.result.items[0].product_id
                        item.changed('values', true)
                    }
                }
            }

            const tst2 = '' + item.values[channel.config.ozonIdAttr]
            if (tst2.startsWith('task_id=')) return

            // try to find current status
            const url = 'https://api-seller.ozon.ru/v2/product/info'
            const request = {
                "product_id": item.values[channel.config.ozonIdAttr]
            }
            const log = "Sending request Ozon: " + url + " => " + JSON.stringify(request)
            logger.info(log)
            if (channel.config.debug) context.log += log + '\n'
            const res = await fetch(url, {
                method: 'post',
                body: JSON.stringify(request),
                headers: { 'Client-Id': channel.config.ozonClientId, 'Api-Key': channel.config.ozonApiKey }
            })
            if (res.status !== 200) {
                const msg = 'Ошибка запроса на Ozon: ' + res.statusText
                context.log += msg
                return
            } else {
                const data = await res.json()
                logger.info('   received data: ' + JSON.stringify(data))
                const result = data.result
                this.processProductStatus(item, result, channel, context)
            }

            await this.saveItemIfChanged(channel, item)
            context.log += '  товар c идентификатором ' + item.identifier + ' синхронизирован \n'
        } else {
            context.log += '  товар c идентификатором ' + item.identifier + ' не требует синхронизации \n'
        }
    }

    async syncItems(channel: Channel, items: Item[], context: JobContext) {
        context.log += 'Обрабатываются товары c идентификаторами: [' + items.map(item => item.identifier).join(', ') + ']\n'

        let filteredItems = items.filter(item => !(item.values[channel.config.ozonIdAttr] && item.channels[channel.identifier]))

        for (const item of filteredItems) {
            context.log += '  товар c идентификатором ' + item.identifier + ' не требует синхронизации \n'
        }

        filteredItems = items.filter(item => (item.values[channel.config.ozonIdAttr] && item.channels[channel.identifier]))

        const productIds = filteredItems.map(item => item.values[channel.config.ozonIdAttr].toString()).filter(id => !!id)

        if (productIds.length === 0) {
            context.log += 'Нет товаров для синхронизации\n'
            return;
        }

        const skus = []
        const chunkSize = 1000
        for (let i = 0; i < productIds.length; i += chunkSize) {
            const chunk = productIds.slice(i, i + chunkSize)
            const request = {
                "product_id": chunk,
            }

            const url = 'https://api-seller.ozon.ru/v2/product/info/list'
            const log = "Sending request to Ozon: " + url + " => " + JSON.stringify(request)
            logger.info(log)
            if (channel.config.debug) context.log += log + '\n'

            const res = await fetch(url, {
                method: 'post',
                body: JSON.stringify(request),
                headers: { 'Client-Id': channel.config.ozonClientId, 'Api-Key': channel.config.ozonApiKey }
            })

            if (res.status !== 200) {
                const msg = 'Ошибка запроса на Ozon: ' + res.statusText
                context.log += msg + '\n'
                logger.error(msg)
                return
            }

            const data = await res.json()
            logger.info('Received data: ' + JSON.stringify(data))

            for (const item of filteredItems) {
                const result = data.result.items.find((elem: any) => elem.id === item.values[channel.config.ozonIdAttr])
                
                if (!result) {
                    context.log += 'Товар c идентификатором ' + item.identifier + ' не найден в ответе Ozon\n'
                    continue
                }

                context.log += 'Товар c идентификатором ' + item.identifier + ' обрабатывается\n'

                this.processProductStatus(item, result, channel, context)
                await this.saveItemIfChanged(channel, item)

                skus.push(result.sku)

                context.log += '  товар c идентификатором ' + item.identifier + ' синхронизирован\n'
            }
        }
        for (let j = 0; j < skus.length; j += chunkSize) {
            const skusChunk = skus.slice(j, j + chunkSize)
            const requestRating = {
                "skus": skusChunk
            };
            const urlRating = 'https://api-seller.ozon.ru/v1/product/rating-by-sku'
            const logRating = "Sending request to Ozon: " + urlRating + " => " + JSON.stringify(requestRating)
            logger.info(logRating)
            if (channel.config.debug) context.log += logRating + '\n'

            const resRating = await fetch(urlRating, {
                method: 'post',
                body: JSON.stringify(requestRating),
                headers: { 'Client-Id': channel.config.ozonClientId, 'Api-Key': channel.config.ozonApiKey }
            })

            if (resRating.status !== 200) {
                const msg = 'Ошибка запроса на Ozon: ' + resRating.statusText
                context.log += msg + '\n'
                logger.error(msg)
                return
            }

            const dataRating = await resRating.json()
            logger.info('Received data: ' + JSON.stringify(dataRating))

            for (const item of filteredItems) {
                const result = dataRating.products.find((elem: any) => elem.sku == item.values[channel.config.ozonFBOIdAttr])

                if (!result) {
                    context.log += 'Товар c идентификатором ' + item.identifier + ' не найден в ответе Ozon (Rating)\n'
                    continue
                }

                context.log += 'Товар c идентификатором ' + item.identifier + ' обрабатывается\n'

                item.values[channel.config.ozonAttrContentRating] = '' + result.rating
                item.changed('values', true)
                await this.saveItemIfChanged(channel, item)

                context.log += '  товар c идентификатором ' + item.identifier + ' синхронизирован\n'
            }
        }
        context.log += 'Синхронизация товаров завершена\n'
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
                            const changedValues = await this.processItemInCategory(channel, item, categoryConfig, language, context)

                            await this.saveItemIfChanged(channel, item, changedValues)
                        } catch (err) {
                            logger.error("Failed to process item with id: " + item.id + " for tenant: " + item.tenantId, err)

                            const data = item.channels[channel.identifier]
                            data.status = 3
                            data.message = 'Ошибка обработки товара: ' + err
                            context.log += data.message
                            await this.saveItemIfChanged(channel, item)
                        }
                        return
                    }
                }
            } else {
                // context.log += 'Запись с идентификатором: ' + item.identifier + ' не подходит под конфигурацию категории: '+categoryConfig.name+' \n'
                // logger.warn('No valid/visible configuration for : ' + channel.identifier + ' for item: ' + item.identifier + ', tenant: ' + channel.tenantId)
            }
        }

        const data = item.channels[channel.identifier]
        data.status = 3
        data.message = 'Этот объект не подходит ни под одну категорию из этого канала.'
        context.log += 'Запись с идентификатором:' + item.identifier + ' не подходит ни под одну категорию из этого канала.\n'
        await this.saveItemIfChanged(channel, item)
    }

    async saveItemIfChanged(channel: Channel, item: Item, changedValues:any = {}) {
        const reloadedItem = await Item.findByPk(item.id) // refresh item from DB (other channels can already change it)
        let changed = false
        let valuesChanged = false
        const data = item.channels[channel.identifier]
        const newChannels:any = {}
        newChannels[channel.identifier] = JSON.parse(JSON.stringify(reloadedItem!.channels[channel.identifier]))
        const tmp = newChannels[channel.identifier]
        if (tmp.status !== data.status || tmp.message !== data.message) {
            changed = true
            tmp.status = data.status
            tmp.message = data.message
            if (data.syncedAt) tmp.syncedAt = data.syncedAt
        }
        if (reloadedItem!.values[channel.config.ozonIdAttr] !== item.values[channel.config.ozonIdAttr]) {
            changed = true
            valuesChanged = true
            changedValues[channel.config.ozonIdAttr] = item.values[channel.config.ozonIdAttr]
        }
        if (reloadedItem!.values[channel.config.ozonFBSIdAttr] !== item.values[channel.config.ozonFBSIdAttr]) {
            changed = true
            valuesChanged = true
            changedValues[channel.config.ozonFBSIdAttr] = item.values[channel.config.ozonFBSIdAttr]
        }
        if (reloadedItem!.values[channel.config.ozonFBOIdAttr] !== item.values[channel.config.ozonFBOIdAttr]) {
            changed = true
            valuesChanged = true
            changedValues[channel.config.ozonFBOIdAttr] = item.values[channel.config.ozonFBOIdAttr]
        }
        if (reloadedItem!.values[channel.config.ozonAttrContentRating] !== item.values[channel.config.ozonAttrContentRating]) {
            changed = true
            valuesChanged = true
            changedValues[channel.config.ozonAttrContentRating] = item.values[channel.config.ozonAttrContentRating]
        }
        if (changedValues && Object.keys(changedValues).length > 0) {
            changed = true
            valuesChanged = true
        }
        if (changed) {
            const ctx = Context.createAs("admin", channel.tenantId)

            try {
                await processItemActions(ctx, EventType.BeforeUpdate, reloadedItem!, reloadedItem!.parentIdentifier, reloadedItem!.name, changedValues, newChannels, false, false)

                if (valuesChanged) { 
                    reloadedItem!.values = {...reloadedItem!.values, ...changedValues}
                    reloadedItem!.changed('values', true)
                }

            } catch (err:any) {
                tmp.status = 3
                tmp.message = 'Ошибка: '+err.message
            }
            reloadedItem!.channels = {...reloadedItem!.channels, ...newChannels}
            reloadedItem!.changed('channels', true)
    
            await sequelize.transaction(async (t) => {
                await reloadedItem!.save({transaction: t})
            })

            await processItemActions(ctx, EventType.AfterUpdate, reloadedItem!, reloadedItem!.parentIdentifier, reloadedItem!.name, reloadedItem!.values, reloadedItem!.channels, false, false)
        }
    }

    async processItemInCategory(channel: Channel, item: Item, categoryConfig: any, language: string, context: JobContext) {
        context.log += 'Найдена категория "' + categoryConfig.name +'" для записи с идентификатором: ' + item.identifier + '\n'

        const changedValues:any = {}

        const data = item.channels[channel.identifier]
        data.category = categoryConfig.id

        // request to Ozon
        const product:any = {attributes:[]}
        const request:any = {items:[product]}

        const productCodeConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#productCode')
        const productCode = await this.getValueByMapping(channel, productCodeConfig, item, language)
        if (!productCode) {
            const msg = 'Не введена конфигурация или нет данных для "Артикула товара" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

        const vatConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#vat')
        const vat = await this.getValueByMapping(channel, vatConfig, item, language)
        if (!vat) {
            const msg = 'Не введена конфигурация или нет данных для "НДС" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

        const barcodeConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#barcode')
        const barcode = await this.getValueByMapping(channel, barcodeConfig, item, language)
        /*if (!barcode) {
            const msg = 'Не введена конфигурация или нет данных для "Баркода" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }*/

        const priceConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#price')
        const price = await this.getValueByMapping(channel, priceConfig, item, language)
        if (!price) {
            const msg = 'Не введена конфигурация или нет данных для "Цены" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

        const depthConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#depth')
        const depth = await this.getValueByMapping(channel, depthConfig, item, language)
        if (!depth) {
            const msg = 'Не введена конфигурация или нет данных для "Длина упаковки" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

        const widthConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#width')
        const width = await this.getValueByMapping(channel, widthConfig, item, language)
        if (!width) {
            const msg = 'Не введена конфигурация или нет данных для "Ширина упаковки" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

        const heightConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#height')
        const height = await this.getValueByMapping(channel, heightConfig, item, language)
        if (!height) {
            const msg = 'Не введена конфигурация или нет данных для "Высота упаковки" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

        const weightConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#weight')
        const weight = await this.getValueByMapping(channel, weightConfig, item, language)
        if (!weight) {
            const msg = 'Не введена конфигурация или нет данных для "Вес с упаковкой" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

        const nameConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#name')
        const name = await this.getValueByMapping(channel, nameConfig, item, language)
        if (!name) {
            const msg = 'Не введена конфигурация или нет данных для "Названия товара" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

        let ozonCategoryId: number|null = null
        let ozonTypeId: number|null = null
        const newVersion = categoryConfig.id.includes(NEW_VER_DELIMETER)
        if (newVersion) { // new API version
            const tmp = categoryConfig.id.substring(4)
            const arr = tmp.split(NEW_VER_DELIMETER)
            ozonCategoryId = parseInt(arr[0])
            ozonTypeId = parseInt(arr[1])
            product.description_category_id = ozonCategoryId
        } else {
            ozonCategoryId = parseInt(categoryConfig.id.substring(4))
            product.category_id = ozonCategoryId
        }
        product.offer_id = ''+productCode
        if(barcode) product.barcode = ''+barcode
        product.price = ''+price
        product.weight = weight
        product.weight_unit = 'g'
        product.depth = depth
        product.height = height
        product.width = width
        product.dimension_unit = 'mm'
        product.vat = ''+vat
        product.name = name

        const priceOldConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#oldprice')
        const priceOld = await this.getValueByMapping(channel, priceOldConfig, item, language)
        if (priceOld) product.old_price = ''+priceOld

        const pricePremConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#premprice')
        const pricePrem = await this.getValueByMapping(channel, pricePremConfig, item, language)
        if (pricePrem) product.premium_price = ''+pricePrem

        const colorImageConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#color_image')
        const colorImage = await this.getValueByMapping(channel, colorImageConfig, item, language)
        if (colorImage) product.color_image = colorImage

        // video processing
        const complex_attributes:any = [{attributes:[]}]
        let wasData = false
        const videoUrlsConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#videoUrls')
        let videoUrlsValue = await this.getValueByMapping(channel, videoUrlsConfig, item, language)
        if (videoUrlsValue) {
            if (!Array.isArray(videoUrlsValue)) videoUrlsValue = [videoUrlsValue]
            const videos = {
                "complex_id": 100001,
                "id": 21841,
                "values": videoUrlsValue.map((elem:any) => { return { value: elem } })
              }
              complex_attributes[0].attributes.push(videos)
              wasData = true
        }
        const videoNamesConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#videoNames')
        let videoNamesValue = await this.getValueByMapping(channel, videoNamesConfig, item, language)
        if (videoNamesValue) {
            if (!Array.isArray(videoNamesValue)) videoNamesValue = [videoNamesValue]
            const videoNames = {
                "complex_id": 100001,
                "id": 21837,
                "values": videoNamesValue.map((elem:any) => { return { value: elem } })
              }
              complex_attributes[0].attributes.push(videoNames)
              wasData = true
        }
        if (wasData) product.complex_attributes = complex_attributes

        const attrs = await this.getAttributes(channel, categoryConfig.id)

        const complexAttributesToProcess:number[] = []
        // atributes
        for (let i = 0; i < categoryConfig.attributes.length; i++) {
            const attrConfig = categoryConfig.attributes[i];
            
            if (
                attrConfig.id != '#productCode' && attrConfig.id != '#name' && attrConfig.id != '#barcode' && attrConfig.id != '#price' && attrConfig.id != '#oldprice' && attrConfig.id != '#premprice' && 
                attrConfig.id != '#weight' && attrConfig.id != '#depth' && attrConfig.id != '#height' && attrConfig.id != '#width' && attrConfig.id != '#vat'
                && attrConfig.id != '#videoUrls' && attrConfig.id != '#videoNames' && attrConfig.id != '#images360Urls' && attrConfig.id != 'attr_4194' // image attribute is filled automatically
            ) {
                const attr = attrs.find(elem => elem.id === attrConfig.id)
                if (!attr) {
                    logger.warn('Failed to find attribute in channel for attribute with id: ' + attrConfig.id)
                    continue
                }
                if (attr.attributeComplexId && attr.attributeComplexId > 0) {
                    // skip complex attributes to later processing
                    if (!complexAttributesToProcess.includes(attr.attributeComplexId)) complexAttributesToProcess.push(attr.attributeComplexId)
                    continue
                }
                try {
                    let value = await this.getValueByMapping(channel, attrConfig, item, language)
                    if (value) {
                        if (typeof value === 'string' || value instanceof String) value = value.trim()
                        const ozonAttrId = parseInt(attrConfig.id.substring(5))
                        const data = {complex_id:0, id: ozonAttrId, values: <any[]>[]}
                        if (Array.isArray(value)) {
                            for (let j = 0; j < value.length; j++) {
                                let elem = value[j];
                                if (elem && (typeof elem === 'string' || elem instanceof String)) elem = elem.trim()
                                const ozonValue = await this.generateValue(channel, ozonCategoryId, ozonTypeId, ozonAttrId, attr.dictionary, elem)
                                if (!ozonValue) {
                                    const msg = 'Значение "' + elem + '" не найдено в справочнике для атрибута "' + attr.name + '" для категории: ' + categoryConfig.name + ' (' + ozonAttrId + '/' + ozonCategoryId + '/' + ozonTypeId + ')'
                                    context.log += msg                      
                                    this.reportError(channel, item, msg)
                                    return
                                }
                                data.values.push(ozonValue)
                            }
                        } else if (typeof value === 'object') {
                            data.values.push(value)
                        } else {
                            const ozonValue = await this.generateValue(channel, ozonCategoryId, ozonTypeId, ozonAttrId, attr.dictionary, value)
                            if (!ozonValue) {
                                const msg = 'Значение "' + value + '" не найдено в справочнике для атрибута "' + attr.name + '" для категории: ' + categoryConfig.name + ' (' + ozonAttrId + '/'  + ozonCategoryId + '/' + ozonTypeId + ')'
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
                } catch (err:any) {
                    const msg = 'Ошибка вычисления атрибута "' + attr.name + '" для категории: ' + categoryConfig.name
                    logger.error(msg, err)
                    context.log += msg + ': ' + err.message        
                    this.reportError(channel, item, msg + ': ' + err.message)
                    return
                  }
            }
        }

        //complex attributes processing
        for (const complexAttrId of complexAttributesToProcess) {
            const attrsToProcess = attrs.filter(elem => elem.attributeComplexId == complexAttrId)
            const valsArr:any[] = []
            let maxLength = 0
            for (const attr of attrsToProcess) {
                const currentValArr:any[] = []
                const attrConfig = categoryConfig.attributes.find((elem:any) => elem.id === attr.id)
                let value = await this.getValueByMapping(channel, attrConfig, item, language)
                const ozonAttrId = parseInt(attr.id.substring(5))
                if (value) {
                    if (Array.isArray(value)) {
                        for (let j = 0; j < value.length; j++) {
                            let elem = value[j];
                            if (elem && (typeof elem === 'string' || elem instanceof String)) elem = elem.trim()
                            const ozonValue = await this.generateValue(channel, ozonCategoryId, ozonTypeId, ozonAttrId, attr.dictionary, elem)
                            if (!ozonValue) {
                                const msg = 'Значение "' + elem + '" не найдено в справочнике для атрибута "' + attr.name + '" для категории: ' + categoryConfig.name + ' (' + ozonAttrId + '/' + ozonCategoryId + '/' + ozonTypeId + ')'
                                context.log += msg                      
                                this.reportError(channel, item, msg)
                                return
                            }
                            currentValArr.push(ozonValue)
                        }
                    } else if (typeof value === 'object') {
                        currentValArr.push(value)
                    } else {
                        const ozonValue = await this.generateValue(channel, ozonCategoryId, ozonTypeId, ozonAttrId, attr.dictionary, value)
                        if (!ozonValue) {
                            const msg = 'Значение "' + value + '" не найдено в справочнике для атрибута "' + attr.name + '" для категории: ' + categoryConfig.name + ' (' + ozonAttrId + '/'  + ozonCategoryId + '/' + ozonTypeId + ')'
                            context.log += msg                      
                            this.reportError(channel, item, msg)
                            return
                        }
                        currentValArr.push(ozonValue)
                    }
                }
                if (currentValArr.length > maxLength) maxLength = currentValArr.length
                valsArr.push(currentValArr)
            }
            if (maxLength == 0) continue
            if (!product.complex_attributes) product.complex_attributes = []
            let idx = 0
            do {
                const attributes:any = {attributes: []}
                for (let i = 0; i < attrsToProcess.length; i++) {
                    const attr = attrsToProcess[i]
                    const valArr = valsArr[i]
                    if (valArr.length > idx) {
                        const ozonAttrId = parseInt(attr.id.substring(5))
                        attributes.attributes.push({id: ozonAttrId, complex_id: complexAttrId, values: [valArr[idx]]})
                    }
                }
                product.complex_attributes.push(attributes)
            } while (idx++ < maxLength-1)
        }

        await this.processItemImages(channel, item, context, product, attrs)

        // images 360 processing
        const images360UrlsConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#images360Urls')
        let images360UrlsValue = await this.getValueByMapping(channel, images360UrlsConfig, item, language)
        if (images360UrlsValue) {
            if (!Array.isArray(images360UrlsValue)) images360UrlsValue = [images360UrlsValue]
            product.images360 = images360UrlsValue
        }

        const ozonProductId = item.values[channel.config.ozonIdAttr] ? ''+item.values[channel.config.ozonIdAttr]: null
        if (ozonProductId && !ozonProductId.startsWith('task_id=')) {
            if (!channel.config.sendPriceUpdate) {
                    // check if we have changed prices that we should leave unchanged
                const existingPricesReq = {product_id: ozonProductId}
                const existingPricesUrl = 'https://api-seller.ozon.ru/v2/product/info'
                const logPr = "Sending request to Ozon: " + existingPricesUrl + " => " + JSON.stringify(existingPricesReq)
                logger.info(logPr)
                if (channel.config.debug) context.log += logPr+'\n'
                const existingPricesRes = await fetch(existingPricesUrl, {
                    method: 'post',
                    body:    JSON.stringify(existingPricesReq),
                    headers: { 'Client-Id': channel.config.ozonClientId, 'Api-Key': channel.config.ozonApiKey }
                })
                logger.info("Response status from Ozon: " + existingPricesRes.status)
                if (existingPricesRes.status !== 200) {
                    const text = await existingPricesRes.text()
                    const msg = 'Ошибка запроса на Ozon: ' + existingPricesRes.statusText + "   " + text
                    context.log += msg                      
                    this.reportError(channel, item, msg)
                    logger.error(msg)
                    return
                } else {
                    const existingPricesJson = await existingPricesRes.json()

                    const priceAttr = priceConfig.attrIdent
                    if (priceAttr && item.values[priceAttr] != parseFloat(existingPricesJson.result.price)) {
                        changedValues[priceAttr] = parseFloat(existingPricesJson.result.price)
                        product.price = existingPricesJson.result.price
                    }
                    const priceOldAttr = priceOldConfig?.attrIdent
                    if (priceOldAttr && existingPricesJson.result.old_price && item.values[priceOldAttr] != parseFloat(existingPricesJson.result.old_price)) {
                        changedValues[priceOldAttr] = parseFloat(existingPricesJson.result.old_price)
                        product.old_price = existingPricesJson.result.old_price
                    }
                    const pricePremAttr = pricePremConfig?.attrIdent
                    if (pricePremAttr && existingPricesJson.result.premium_price && item.values[pricePremAttr] != parseFloat(existingPricesJson.result.premium_price)) {
                        changedValues[pricePremAttr] = parseFloat(existingPricesJson.result.premium_price)
                        product.premium_price = existingPricesJson.result.premium_price
                    }
                }
            }

            if (channel.config.saveVideos) {
                // check if we have loaded videos that we should leave unchanged
                const existingDataReq = {
                    "filter": {
                        "product_id": [ozonProductId],
                        "visibility": "ALL"
                    },
                    "limit": 1000
                }
                const existingDataUrl = 'https://api-seller.ozon.ru/v3/products/info/attributes'
                const log = "Sending request to Ozon: " + existingDataUrl + " => " + JSON.stringify(existingDataReq)
                logger.info(log)
                if (channel.config.debug) context.log += log+'\n'
                const existingDataRes = await fetch(existingDataUrl, {
                    method: 'post',
                    body:    JSON.stringify(existingDataReq),
                    headers: { 'Client-Id': channel.config.ozonClientId, 'Api-Key': channel.config.ozonApiKey }
                })
                logger.info("Response status from Ozon: " + existingDataRes.status)
                if (existingDataRes.status !== 200) {
                    const text = await existingDataRes.text()
                    const msg = 'Ошибка запроса на Ozon: ' + existingDataRes.statusText + "   " + text
                    context.log += msg                      
                    this.reportError(channel, item, msg)
                    logger.error(msg)
                    return
                } else {
                    const existingDataJson = await existingDataRes.json()
                    // const log = "Response from Ozon: " + JSON.stringify(existingDataJson)
                    // logger.info(log)
                    // if (channel.config.debug) context.log += log+'\n'
                    let videoElem1
                    let videoElem2
                    let videoCover
                    if (existingDataJson.result[0].complex_attributes) {
                        existingDataJson.result[0].complex_attributes.forEach((elem:any) => {
                            const data1 = elem.attributes.find((elem1:any) => elem1.attribute_id === 21837)
                            if (data1) {
                                delete(data1.attribute_id)
                                data1.id = 21837
                                videoElem1 = data1
                            }

                            const data2 = elem.attributes.find((elem2:any) => elem2.attribute_id === 21841)
                            if (data2) {
                                delete(data2.attribute_id)
                                data2.id = 21841
                                videoElem2 = data2
                            }

                            const data3 = elem.attributes.find((elem3:any) => elem3.attribute_id === 21845)
                            if (data3) {
                                delete(data3.attribute_id)
                                data3.id = 21845
                                videoCover = data3
                            }

                        })
                    }
                    if ((videoElem1 && videoElem2) || videoCover)  {
                        const log = "Найдены загруженные видео: \n" + JSON.stringify(videoElem1) + "\n" + JSON.stringify(videoElem2) + "\n" + JSON.stringify(videoCover)
                        logger.info(log)
                        if (channel.config.debug) context.log += log+'\n'
                        if (!product.complex_attributes) product.complex_attributes = []
                        if (videoElem1 && videoElem2) {
                            const data = {attributes:[]}
                            data.attributes.push(videoElem1)
                            data.attributes.push(videoElem2)
                            product.complex_attributes.push(data)
                        }
                        if (videoCover) {
                            const data = {attributes:[]}
                            data.attributes.push(videoCover)
                            product.complex_attributes.push(data)
                        }
                    } else {
                        const log = "Загруженные видео не найдены"
                        logger.info(log)
                        if (channel.config.debug) context.log += log+'\n'
                    }
                }
            }
        }

        const url = newVersion? 'https://api-seller.ozon.ru/v3/product/import' : 'https://api-seller.ozon.ru/v2/product/import'
        const log = "Sending request to Ozon: " + url + " => " + JSON.stringify(request)
        logger.info(log)
        if (channel.config.debug) context.log += log+'\n'

        if (process.env.OPENPIM_OZON_EMULATION === 'true') {
            const msg = 'Включена эмуляция работы, сообщение не было послано на Озон'
            if (channel.config.debug) context.log += msg+'\n'
            logger.info(msg)
            return changedValues
        }

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
            const log = "Response from Ozon: " + JSON.stringify(json)
            logger.info(log)
            if (channel.config.debug) context.log += log+'\n'

            await this.sleep(2000)
            
            const taskId = json.result.task_id
            const log2 = "Sending request to Ozon to check task id: " + taskId
            logger.info(log2)
            if (channel.config.debug) context.log += log2+'\n'
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
                const log3 = "Response 2 from Ozon: " + JSON.stringify(json2) 
                logger.info(log3)
                if (channel.config.debug) context.log += log3+'\n'
    
                let status = null
                let errors = null
                if (json2.result.items && json2.result.items.length > 0) {
                    status = json2.result.items[0].status
                    errors = json2.result.items[0].errors
                }
                const data = item.channels[channel.identifier]
                if (status === 'imported') {
                    context.log += 'Запись с идентификатором: ' + item.identifier + ' обработана успешно.\n'
                    data.status = 4
                    data.message = 'Товар находится на модерации ' + errors && errors.length > 0? JSON.stringify(errors) :''
                    data.syncedAt = Date.now()
                    item.changed('channels', true)
                    if (json2.result.items[0].product_id == 0) {
                        item.values[channel.config.ozonIdAttr] = 'task_id='+taskId
                    } else {
                        item.values[channel.config.ozonIdAttr] = json2.result.items[0].product_id
                    }
                    item.changed('values', true)
                } else if (status === 'failed') {
                    context.log += 'Запись с идентификатором: ' + item.identifier + ' обработана с ошибкой.\n'
                    data.status = 3
                    data.message = errors && errors.length > 0? 'Ошибки:'+JSON.stringify(errors) :''
                    item.changed('channels', true)            
                } else {
                    context.log += 'Запись с идентификатором: ' + item.identifier + ' обработана со статусом: ' + status + ' \n'
                    data.status = 4
                    data.message = ''
                    item.changed('channels', true)            
                    if (status === null || json2.result.items[0].product_id == 0) {
                        item.values[channel.config.ozonIdAttr] = 'task_id='+taskId
                    } else {
                        item.values[channel.config.ozonIdAttr] = json2.result.items[0].product_id
                    }
                    item.changed('values', true)
                }
            }
        }

        return changedValues
    }

    async processItemImages(channel: Channel, item: Item, context: JobContext, product: any, attrs: ChannelAttribute[]) {
        if (channel.config.imgRelations && channel.config.imgRelations.length > 0) {
            const mng = ModelsManager.getInstance().getModelManager(channel.tenantId)
            const typeNode = mng.getTypeById(item.typeId)
            if (!typeNode) {
                throw new Error('Failed to find type by id: ' + item.typeId + ', tenant: ' + mng.getTenantId())
            }
            const type:Type = typeNode.getValue()

            const data:string[] = [] 
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
                        order by ir.values->'_itemRelationOrder', a.id`, {
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
                        const url = image.values[channel.config.ozonImageAttr]
                        let addition = ''
                        if (channel.config.uniqueImages) addition = url.includes('?') ? '&timestamp='+Date.now() : '?timestamp='+Date.now()
                        if (url && !product.primary_image) {
                            product.primary_image = url + addition
                        } else if (url) {
                            data.push(url + addition)
                        }
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
                        order by ir.values->'_itemRelationOrder', a.id`, {
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
                        const url = image.values[channel.config.ozonImageAttr]
                        if (url) {
                            let addition = ''
                            if (channel.config.uniqueImages) addition = url.includes('?') ? '&timestamp='+Date.now() : '?timestamp='+Date.now()
                            data.push(url + addition)
                        }
                    }
                }
            }
            if (data.length > 0) {
                product.images = data

                /*
                const hasImageAttr = attrs.some(elem => elem.id === 'attr_4194')
                if (hasImageAttr) {
                    product.attributes.push({
                        "complex_id": 0,
                        "id": 4194,
                        "values": [{"value": data[0]}]
                    })
                } */
            }
        }
    }    
    private async generateValue(channel: Channel, ozonCategoryId: number, ozonTypeId: number|null, ozonAttrId: number, dictionary: boolean, value: any) {
        if (dictionary) {
            let dict: any[] | string | undefined = this.cache.get('dict_'+ozonCategoryId+'_'+ozonAttrId+'_'+ozonTypeId)
            if (!dict) {
                dict = []
                let next = false
                let last = 0
                let idx = 0
                do {
                    let res
                    if (ozonTypeId) {
                        const body = {
                            "attribute_id": ozonAttrId,
                            "description_category_id": ozonCategoryId,
                            "type_id": ozonTypeId,
                            "language": "DEFAULT",
                            "last_value_id": last,
                            "limit": 5000
                        }
                        if (channel.config.debug) console.log('generateValue - request to https://api-seller.ozon.ru/v1/description-category/attribute/values '+JSON.stringify(body))
                        res = await fetch('https://api-seller.ozon.ru/v1/description-category/attribute/values', {
                            method: 'post',
                            body:    JSON.stringify(body),
                            headers: { 'Content-Type': 'application/json', 'Client-Id': channel.config.ozonClientId, 'Api-Key': channel.config.ozonApiKey }
                        })
                    } else {
                        const body = {
                            "attribute_id": ozonAttrId,
                            "category_id": ozonCategoryId,
                            "language": "DEFAULT",
                            "last_value_id": last,
                            "limit": 5000
                        }
                        if (channel.config.debug) console.log('generateValue - request to https://api-seller.ozon.ru/v2/category/attribute/values '+JSON.stringify(body))
                        res = await fetch('https://api-seller.ozon.ru/v2/category/attribute/values', {
                            method: 'post',
                            body:    JSON.stringify(body),
                            headers: { 'Content-Type': 'application/json', 'Client-Id': channel.config.ozonClientId, 'Api-Key': channel.config.ozonApiKey }
                        })
                    }
                    const json = await res.json()
                    if (channel.config.debug) console.log(`generateValue - response: result length ${json.result.length}, has_next: ${json.has_next} `)
                    dict = dict.concat(json.result)
                    next = json.has_next
                    if (dict.length === 0) throw new Error('No data for attribute dictionary: '+ozonAttrId+', for category: '+ozonCategoryId)
                    last = dict[dict.length-1]?.id
                    if (idx++ > 50) {
                        throw new Error('Data dictionary for attribute: '+ozonAttrId+ ', typeId:' + ozonTypeId + ' is too big, for category: '+ozonCategoryId)
                    }
                } while (next)
    
                this.cache.set('dict_'+ozonCategoryId+'_'+ozonAttrId+'_'+ozonTypeId, dict, 3600)
            } else if (dict === 'big') {
                throw new Error('Data dictionary for attribute: '+ozonAttrId+ ', typeId:' + ozonTypeId + ' is too big, for category: '+ozonCategoryId)
            }

            let entry = (dict as any[])!.find((elem:any) => elem.value == value)
            if (!entry) {
                if (channel.config.debug) console.log(`generateValue - entry not found 1: ${value} for attr: ${ozonAttrId}`)
                entry = (dict as any[])!.find((elem:any) => elem.id == value)
            }
            if (!entry) {
                if (channel.config.debug) console.log(`generateValue - entry not found 2: ${value} for attr: ${ozonAttrId}`)
                return null
            } else {
                if (channel.config.debug) console.log(`generateValue - entry found: ${entry.id} for attr: ${ozonAttrId} `)
                return {dictionary_value_id: entry.id, value: entry.value}
            }
        } else {
            return { value: ''+value }
        }
    }

    public async getCategories(channel: Channel): Promise<{list: ChannelCategory[]|null, tree: ChannelCategory|null}> {
        if (process.env.OPENPIM_OZON_V4 === 'true') {
            return await this.getCategoriesNew(channel)
        } else {
            return await this.getCategoriesOld(channel)
        }
    }

    public async getAttributes(channel: Channel, categoryId: string): Promise<ChannelAttribute[]> {
        const newVersion = categoryId.indexOf(NEW_VER_DELIMETER) > 0
        if (newVersion) {
            return await this.getAttributesNew(channel, categoryId)
        } else {
            return await this.getAttributesOld(channel, categoryId)
        }
    }

    public async getCategoriesOld(channel: Channel): Promise<{list: ChannelCategory[]|null, tree: ChannelCategory|null}> {
        if (!channel.config.ozonClientId) throw new Error('Не введен Client Id в конфигурации канала.')
        if (!channel.config.ozonApiKey) throw new Error('Не введен Api Key в конфигурации канала.')

        let tree:ChannelCategory | undefined = this.cache.get('categories')
        if (! tree) {
            tree  = {id: '', name: 'root', children: []}
            const res = await fetch('https://api-seller.ozon.ru/v2/category/tree?language=DEFAULT', {
                method: 'post',
                headers: { 'Client-Id': channel.config.ozonClientId, 'Api-Key': channel.config.ozonApiKey }
            })
            const json = await res.json()
            this.collectTreeOld(json.result, tree)
            this.cache.set('categories', tree, 3600)
        }
        return {list: null, tree: tree}
    }
    private collectTreeOld(arr: any[], treeNode: ChannelCategory) {
        arr.forEach(elem => {
            const child = {id: 'cat_' + elem.category_id, name: elem.title, children: []}
            treeNode.children!.push(child)
            if (elem.children) {
                if (elem.children.length > 0) {
                    this.collectTreeOld(elem.children, child)
                }
            }  
        })
    }
    public async getAttributesOld(channel: Channel, categoryId: string): Promise<ChannelAttribute[]> {
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
                    name: elem.name + ' ('+ elem.type + ')',
                    required: elem.is_required,
                    category: categoryId,
                    description: elem.description+'\n id: '+elem.id+', category: '+categoryId,
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

    public async getCategoriesNew(channel: Channel): Promise<{list: ChannelCategory[]|null, tree: ChannelCategory|null}> {
        if (!channel.config.ozonClientId) throw new Error('Не введен Client Id в конфигурации канала.')
        if (!channel.config.ozonApiKey) throw new Error('Не введен Api Key в конфигурации канала.')

        let tree:ChannelCategory | undefined = this.cache.get('categories_new')
        if (! tree) {
            tree  = {id: '', name: 'root', children: []}
            const res = await fetch('https://api-seller.ozon.ru/v1/description-category/tree', {
                method: 'post',
                headers: { 'Client-Id': channel.config.ozonClientId, 'Api-Key': channel.config.ozonApiKey }
            })
            const json = await res.json()
            this.collectTreeNew(json.result, tree, null)
            this.cache.set('categories_new', tree, 3600)
        }
        return {list: null, tree: tree}
    }
    private collectTreeNew(arr: any[], treeNode: ChannelCategory, parent: any) {
        arr.forEach(elem => {
            const child = elem.type_id ? {id: 'cat_' + parent.description_category_id + NEW_VER_DELIMETER + elem.type_id, name: elem.type_name, children: []} : {id: 'cat_' + elem.description_category_id, name: elem.category_name, children: []}
            treeNode.children!.push(child)
            if (elem.children) {
                if (elem.children.length > 0) {
                    this.collectTreeNew(elem.children, child, elem)
                }
            }  
        })
    }

    public async getAttributesNew(channel: Channel, categoryId: string): Promise<ChannelAttribute[]> {
        let data = this.cache.get('attr_'+categoryId)
        if (! data) {
            const tmp = categoryId.substring(4)
            const arr = tmp.split(NEW_VER_DELIMETER)
            const ozonCategoryId = arr[0]
            const ozonTypeId = arr[1]
            const query = {
                description_category_id: ozonCategoryId,
                type_id: ozonTypeId,
                language: "DEFAULT"
              }
              logger.info("Sending request to Ozon: https://api-seller.ozon.ru/v1/description-category/attribute => " + JSON.stringify(query))
              const res = await fetch('https://api-seller.ozon.ru/v1/description-category/attribute', {
                method: 'post',
                body:    JSON.stringify(query),
                headers: { 'Content-Type': 'application/json', 'Client-Id': channel.config.ozonClientId, 'Api-Key': channel.config.ozonApiKey }
            })
            if (res.status !== 200) {
                const text = await res.text()
                throw new Error("Failed to query attributes with error: " + res.statusText+", text: " + text)
            }
            const json = await res.json()

            data = json.result.map((elem:any) => { 
                return { 
                    id: 'attr_' + elem.id, 
                    name: elem.name + ' ('+ elem.type + ')',
                    required: elem.is_required,
                    category: categoryId,
                    description: elem.description+'\n id: '+elem.id+', category: '+categoryId,
                    dictionary: elem.dictionary_id !== 0,
                    isAspect: elem.is_aspect,
                    attributeComplexId: elem.attribute_complex_id,
                    categoryDependent: elem.category_dependent,
                    dictionaryLinkPost: elem.dictionary_id !== 0 ? { body: {
                        attribute_id: elem.id,
                        description_category_id: ozonCategoryId,
                        category_id: ozonCategoryId,
                        type_id: ozonTypeId,
                        language: "DEFAULT",
                        last_value_id: 0,
                        limit: 1000
                      }, headers: { 'Content-Type': 'application/json', 'Client-Id': channel.config.ozonClientId, 'Api-Key': channel.config.ozonApiKey } } : null,
                    dictionaryLink: elem.dictionary_id !== 0 ? 'https://api-seller.ozon.ru/v1/description-category/attribute/values' : null
                } 
            } )


            this.cache.set('attr_'+categoryId, data, 3600)
        }
        return <ChannelAttribute[]>data
    }

    public async getChannelAttributeValues(channel: Channel, categoryId: string, attributeId: string): Promise<any> {
        const attrs = await this.getAttributes(channel, categoryId)
        const attr = attrs.find(elem => elem.id === attributeId)
        if (attr && attr.dictionaryLinkPost) {
            const resp =await fetch(attr.dictionaryLink!, {
                method: 'POST',
                headers: attr.dictionaryLinkPost.headers,
                body: JSON.stringify(attr.dictionaryLinkPost.body)
              })
            return await resp.json()
        }
        return {}
    }
}
