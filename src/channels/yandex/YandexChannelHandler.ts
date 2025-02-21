import { Channel } from '../../models/channels'
import { ChannelAttribute, ChannelCategory, ChannelHandler } from '../ChannelHandler'
import fetch from 'node-fetch'
import NodeCache = require('node-cache')
import { Item } from '../../models/items'
import logger from "../../logger"
import { sequelize } from '../../models'
import { Op } from 'sequelize'
import { ItemRelation } from '../../models/itemRelations'
import Context from '../../context'
import { processItemActions } from '../../resolvers/utils'
import { EventType } from '../../models/actions'

interface JobContext {
    log: string
}

interface ParameterValueDTO {
    parameterId: number,
    unitId?: number,
    value?: string,
    valueId?: number
}

interface UpdateOfferDTO {
    offerId: string,
    additionalExpenses?: any,
    adult?: boolean,
    age?: any,
    barcodes?: string[],
    basicPrice?: any,
    boxCount?: number,
    certificates?: string[],
    cofinancePrice?: any,
    commodityCodes?: any[],
    condition?: any,
    description: string,
    downloadable?: boolean,
    firstVideoAsCover?: boolean,
    guaranteePeriod?: any,
    lifeTime?: any,
    manuals?: any,
    manufacturerCountries?: string[],
    marketCategoryId: number,
    name?: string,
    parameterValues: ParameterValueDTO[],
    pictures: string[],
    purchasePrice?: any,
    shelfLife?: any,
    tags?: string[],
    type?: any,
    vendor: string,
    vendorCode?: string,
    videos?: string[],
    weightDimensions?: any
}

enum YMDataTypes {
    ENUM = "List of values",
    TEXT = "Text",
    NUMERIC = "Number",
    BOOLEAN = "Boolean"
}

const standardAttributes = [
    'name',
    'vendor',
    'pictures',
    'description',
    'additionalExpenses',
    'adult',
    'age',
    'barcodes',
    'basicPrice',
    'boxCount',
    'certificates',
    'cofinancePrice',
    'commodityCodes',
    'condition',
    'downloadable',
    'firstVideoAsCover',
    'guaranteePeriod',
    'lifeTime',
    'manuals',
    'manufacturerCountries',
    'purchasePrice',
    'shelfLife',
    'tags',
    'type',
    'vendorCode',
    'videos',
    'weightDimensions'
]

/* enum YMCardStatuses {
    HAS_CARD_CAN_NOT_UPDATE = "Карточка Маркета",
    HAS_CARD_CAN_UPDATE = "Можно дополнить",
    HAS_CARD_CAN_UPDATE_ERRORS = "Изменения не приняты.",
    HAS_CARD_CAN_UPDATE_PROCESSING = "Изменения на проверке.",
    NO_CARD_NEED_CONTENT = "Создайте карточку",
    NO_CARD_MARKET_WILL_CREATE = "Создаст Маркет",
    NO_CARD_ERRORS = "Не создана из-за ошибки",
    NO_CARD_PROCESSING = "Проверяем данные",
    NO_CARD_ADD_TO_CAMPAIGN = "Разместите товар в магазине"
} */

export class YandexChannelHandler extends ChannelHandler {
    private cache = new NodeCache({ useClones: false });

    public async processChannel(channel: Channel, language: string, data: any): Promise<void> {
        const chanExec = await this.createExecution(channel)

        const context: JobContext = { log: '' }

        if (!channel.config.apiToken || channel.config.apiToken === '') {
            await this.finishExecution(channel, chanExec, 3, 'Не введен API key в конфигурации канала')
            return
        }

        if (!channel.config.businessId || channel.config.businessId === '') {
            await this.finishExecution(channel, chanExec, 3, 'Не введен идентификатор кабинета в конфигурации канала')
            return
        }

        if (!channel.config.offerIdAttr) {
            await this.finishExecution(channel, chanExec, 3, 'Не введен атрибут где находится offerid')
            return
        }

        if (!channel.config.marketSkuAttr) {
            await this.finishExecution(channel, chanExec, 3, 'Не введен атрибут где хранить marketSku')
            return
        }

        try {
            if (!data) {
                const query: any = {}
                query[channel.identifier] = { status: 1 }
                let items = await Item.findAndCountAll({
                    where: { tenantId: channel.tenantId, channels: query }
                })
                context.log += 'Запущена выгрузка на Yandex Market\n'
                context.log += 'Найдено ' + items.count + ' записей для обработки \n\n'
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
            context.log += 'Ошибка запуска канала - ' + JSON.stringify(err)
            await this.finishExecution(channel, chanExec, 3, context.log)
        }
    }

    async processItem(channel: Channel, item: Item, language: string, context: JobContext) {
        context.log += 'Обрабатывается запись с идентификатором: ' + item.identifier + '\n'

        for (const categoryId in channel.mappings) {
            const categoryConfig = channel.mappings[categoryId]
            if (categoryConfig.valid && categoryConfig.valid.length > 0 && (
                (categoryConfig.visible && categoryConfig.visible.length > 0) || categoryConfig.categoryExpr || (categoryConfig.categoryAttr && categoryConfig.categoryAttrValue))) {
                const pathArr = item.path.split('.')
                const tstType = categoryConfig.valid.includes(item.typeId) || categoryConfig.valid.includes('' + item.typeId)
                if (tstType) {
                    let tst = null
                    if (categoryConfig.visible && categoryConfig.visible.length > 0) {
                        if (categoryConfig.visibleRelation) {
                            let sources = await Item.findAll({
                                where: { tenantId: channel.tenantId, '$sourceRelation.relationId$': categoryConfig.visibleRelation, '$sourceRelation.targetId$': item.id },
                                include: [{ model: ItemRelation, as: 'sourceRelation' }]
                            })
                            tst = sources.some(source => {
                                const pathArr = source.path.split('.')
                                return categoryConfig.visible.find((elem: any) => pathArr.includes('' + elem))
                            })
                        } else {
                            tst = categoryConfig.visible.find((elem: any) => pathArr.includes('' + elem))
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
            }
        }

        const data = item.channels[channel.identifier]
        data.status = 3
        data.message = 'Этот объект не подходит ни под одну категорию из этого канала.'
        context.log += 'Запись с идентификатором:' + item.identifier + ' не подходит ни под одну категорию из этого канала.\n'
        await this.saveItemIfChanged(channel, item)
    }

    async saveItemIfChanged(channel: Channel, item: Item, changedValues: any = {}) {
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

        /* if (reloadedItem!.values[channel.config.offerIdAttr] !== changedValues[channel.config.offerIdAttr]) {
                console.log('1')
                changed = true
                valuesChanged = true
            }
        */

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
                tmp.message = 'Ошибка: ' + err.message
            }
            reloadedItem!.channels = {...reloadedItem!.channels, ...newChannels}
            reloadedItem!.changed('channels', true)
    
            await sequelize.transaction(async (t) => {
                await reloadedItem!.save({transaction: t})
            })
            await processItemActions(ctx, EventType.AfterUpdate, reloadedItem!, reloadedItem!.parentIdentifier, reloadedItem!.name, reloadedItem!.values, reloadedItem!.channels, false, false)
        }
     }

    async generateValue(channel: Channel, yandexCategoryId: number, yandexAttrId: number, attr: any, value: any) {
        if (attr.dictionary) {
            const yandexValues = await this.getChannelAttributeValues(channel, yandexCategoryId + '', "yandexattr_" + yandexAttrId)
            if (!yandexValues.values || !yandexValues.values.length) return null
            const tst = yandexValues.values.find((el: any)  => el.value === value)
            return tst?.id
        } else {
            return value
        }
     }

    async addStandardParam(offer: any, attrs: Array<any>, paramId: string, channel:Channel, item:Item, language: string) {
        const attrConfig = attrs.find((elem:any) => elem.id === paramId)
        const value = await this.getValueByMapping(channel, attrConfig, item, language)
        if (value !== null && typeof value !== 'undefined') {
            offer[paramId] = value
        }
    }

    async processItemInCategory(channel: Channel, item: Item, categoryConfig: any, language: string, context: JobContext) {
        context.log += 'Найдена категория "' + categoryConfig.name + '" для записи с идентификатором: ' + item.identifier + '\n'

        const changedValues: any = {}

        const data = item.channels[channel.identifier]
        data.category = categoryConfig.id

        /* const offerIdConfig = categoryConfig.attributes.find((elem:any) => elem.id === 'offerid')
        const offerid = await this.getValueByMapping(channel, offerIdConfig, item, language)
        if (!offerid) {
            const msg = 'Не введена конфигурация или нет данных для "offerid" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        } */

        const offerId = item.values[channel.config.offerIdAttr]
        if (!offerId || offerId === '') {
            const msg = 'Атрибут указанный для offerid пустой или отсутсвует'
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

        const nameConfig = categoryConfig.attributes.find((elem:any) => elem.id === 'name')
        const name = await this.getValueByMapping(channel, nameConfig, item, language)
        if (!name) {
            const msg = 'Не введена конфигурация или нет данных для "Названия товара" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

        const vendorConfig = categoryConfig.attributes.find((elem:any) => elem.id === 'vendor')
        const vendor = await this.getValueByMapping(channel, vendorConfig, item, language)
        if (!vendor) {
            const msg = 'Не введена конфигурация или нет данных для "Название бренда или производителя" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

        const picturesConfig = categoryConfig.attributes.find((elem:any) => elem.id === 'pictures')
        const pictures = await this.getValueByMapping(channel, picturesConfig, item, language)
        if (!pictures) {
            const msg = 'Не введена конфигурация или нет данных для "Название бренда или производителя" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

        const descriptionConfig = categoryConfig.attributes.find((elem:any) => elem.id === 'description')
        const description = await this.getValueByMapping(channel, descriptionConfig, item, language)
        if (!description) {
            const msg = 'Не введена конфигурация или нет данных для "Описание предложения" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

        let yandexCategoryId: number = categoryConfig.id

        const offer: UpdateOfferDTO = { 
            offerId,
            description,
            name,
            vendor,
            marketCategoryId: yandexCategoryId,
            pictures,
            parameterValues: []
        }

        for (let i=0; i<standardAttributes.length; i++) {
            await this.addStandardParam(offer, categoryConfig.attributes, standardAttributes[i], channel, item, language)
        }

        const request: any = { offerMappings: [{ offer }] }
        const attrs = await this.getAttributes(channel, yandexCategoryId.toString())

        // atributes
        for (let i = 0; i < categoryConfig.attributes.length; i++) {
            const attrConfig = categoryConfig.attributes[i]
            // standard attributes have been already processed
            if (standardAttributes.find(el => el === attrConfig.id)) continue
            const attr = attrs.find(elem => elem.id === attrConfig.id)
            if (!attr) {
                logger.warn('Failed to find attribute in channel for attribute with id: ' + attrConfig.id)
                continue
            }
            try {
                let value = await this.getValueByMapping(channel, attrConfig, item, language)
                if (value) {
                    if (typeof value === 'string' || value instanceof String) value = value.trim()
                    const yandexAttrId = parseInt(attrConfig.id.substring(11))
                    if (Array.isArray(value)) {
                        for (let j = 0; j < value.length; j++) {
                            const data: ParameterValueDTO = { parameterId: yandexAttrId }
                            let elem = value[j];
                            if (elem && (typeof elem === 'string' || elem instanceof String)) elem = elem.trim()
                            const yandexValue = await this.generateValue(channel, yandexCategoryId, yandexAttrId, attr, elem)
                            if (!yandexValue) {
                                const msg = 'Значение "' + elem + '" не найдено в справочнике для атрибута "' + attr.name + '" для категории: ' + categoryConfig.name + ' (' + yandexAttrId + '/' + yandexCategoryId + '/)'
                                context.log += msg
                                this.reportError(channel, item, msg)
                                return
                            };
                            if (attr.dictionary) {
                                data.valueId = yandexValue
                                data.value = value + ''
                            } else {
                                data.value = yandexValue
                            }
                            // В YM we need to add several parameters in case of multivalue
                            offer.parameterValues.push(data)
                        }
                    } else if (typeof value === 'object') {
                        const data: ParameterValueDTO = { parameterId: yandexAttrId, value }
                        offer.parameterValues.push(data)
                    } else {
                        const yandexValue = await this.generateValue(channel, yandexCategoryId, yandexAttrId, attr, value)
                        if (!yandexValue) {
                            const msg = 'Значение "' + value + '" не найдено в справочнике для атрибута "' + attr.name + '" для категории: ' + categoryConfig.name + ' (' + yandexAttrId + '/' + yandexCategoryId + '/)'
                            context.log += msg
                            this.reportError(channel, item, msg)
                            return
                        }
                        const data: ParameterValueDTO = { parameterId: yandexAttrId };
                        if (attr.dictionary) {
                            data.valueId = yandexValue
                            data.value = value + ''
                        } else {
                            data.value = yandexValue
                        }
                        offer.parameterValues.push(data)
                    }
                } else if (attr.required) {
                    const msg = 'Нет значения для обязательного атрибута "' + attr.name + '" для категории: ' + categoryConfig.name
                    context.log += msg
                    this.reportError(channel, item, msg)
                    return
                }
            } catch (err: any) {
                const msg = 'Ошибка вычисления атрибута "' + attr.name + '" для категории: ' + categoryConfig.name
                logger.error(msg, err)
                context.log += msg + ': ' + err.message
                this.reportError(channel, item, msg + ': ' + err.message)
                return
            }
        }

        const businessId = channel.config.businessId
        const url = `https://api.partner.market.yandex.ru/businesses/${businessId}/offer-mappings/update`

        const log = "Sending request to yandex: " + url + " => " + JSON.stringify(request)
        logger.info(log)
        if (channel.config.debug) context.log += log + '\n'

        if (process.env.OPENPIM_YANDEX_EMULATION === 'true') {
            const msg = 'Включена эмуляция работы, сообщение не было послано на Yandex Market'
            if (channel.config.debug) context.log += msg + '\n'
            return changedValues
        }

        const res = await fetch(url, {
            method: 'post',
            body: JSON.stringify(request),
            headers: { 'Api-Key': channel.config.apiToken }
        })
        logger.info("Response status from Yandex market: " + res.status)
        if (res.status !== 200) {
            const text = await res.text()
            const msg = 'Ошибка запроса на yandex: ' + res.statusText + "   " + text
            context.log += msg
            this.reportError(channel, item, msg)
            logger.error(msg)
            return
        } else {
            const json = await res.json()
            const log = "Response from yandex: " + JSON.stringify(json)
            logger.info(log)
            const chan = item.channels[channel.identifier]
            chan.status = 4
            chan.message = JSON.stringify(json)
            item.changed('channels', true)
            // changedValues[channel.config.offerIdAttr] = offerid
            if (channel.config.debug) context.log += log + '\n'
       }

        return changedValues
    }

    async syncJob(channel: Channel, context: JobContext, data: any) {
        context.log += 'Запущена синхронизация с Yandex Market\n'
        if (data.item) {
            const item = await Item.findByPk(data.item)
            await this.syncItems(channel, [item!], context)
        } else {
            const query:any = {}
            query[channel.identifier] = { status: {[Op.ne]: null }}
            let items = await Item.findAll({ 
                where: { tenantId: channel.tenantId, channels: query} 
            })
            context.log += 'Найдено ' + items.length + ' записей для обработки \n\n'
            await this.syncItems(channel, items, context)
        }
        context.log += 'Cинхронизация закончена'
    }

    async syncItems(channel: Channel, items: Item[], context: JobContext) {
        context.log += 'Обрабатываются товары c идентификаторами: [' + items.map(item => item.identifier).join(', ') + ']\n'

        const businessId = channel.config.businessId
        const url = `https://api.partner.market.yandex.ru/businesses/${businessId}/offer-cards`

        const productIds = items.filter(item => item.values[channel.config.offerIdAttr]).map(item => item.values[channel.config.offerIdAttr].toString())

        if (!productIds.length) {
            context.log += 'Нет товаров для синхронизации\n'
            return
        }

        const chunkSize = 1000
        for (let i = 0; i < productIds.length; i += chunkSize) {

            const chunk = productIds.slice(i, i + chunkSize)
            let msg = "Запрос на Yandex Market: " + url + " => " + JSON.stringify(chunk)
            logger.info(msg)
            if (channel.config.debug) context.log += msg+'\n'

            const res = await fetch(url, {
                method: 'post',
                body:    JSON.stringify({
                    offerIds: chunk
                }),
                headers: { 'Content-Type': 'application/json', 'Api-Key': channel.config.apiToken }
            })

            const json = await res.json()
            if (res.status !== 200 || json.status !== 'OK') {
                const msg = 'Ошибка запроса на Yandex Market: ' + res.statusText || JSON.stringify(json)
                context.log += msg
                return
            } else {
                if (json.result.offerCards.length === 0) {
                    const msg = 'По данному запросу ничего не найдено'
                    logger.info(msg)
                    context.log += msg
                    return
                }

                const offerCards = json.result.offerCards
                for (const item of items) {
                    const offerCard = offerCards.find((elem: any) => elem.offerId === item.values[channel.config.offerIdAttr] + '')
                    if (!offerCard) {
                        context.log += 'Товар c идентификатором ' + item.identifier + ' не найден в ответе Yandex\n'
                        continue
                    }
                    context.log += 'Товар c идентификатором ' + item.identifier + ' обрабатывается\n'
                    if (item.channels[channel.identifier]?.status === 3 && !item.channels[channel.identifier]?.yandexError) {
                        context.log += 'Статус товара ' + item.identifier + ' ошибка, синхронизация не будет проводиться \n'
                        continue
                    }
                    this.processProductStatus(item, offerCard, channel, context)
                    const changedValues: any = {}
                    if (offerCard.mapping?.marketSku) {
                        changedValues[channel.config.marketSkuAttr] = offerCard.mapping.marketSku
                    }
                    await this.saveItemIfChanged(channel, item, changedValues)
                    context.log += '  товар c идентификатором ' + item.identifier + ' синхронизирован\n'
                }
            }
        }

        context.log += 'Синхронизация товаров завершена\n'
    }

    processProductStatus(item: Item, result: any, channel: Channel, context: JobContext) {
        /* HAS_CARD_CAN_NOT_UPDATE - Карточка Маркета.
         HAS_CARD_CAN_UPDATE - Можно дополнить.
         HAS_CARD_CAN_UPDATE_ERRORS - Изменения не приняты.
         HAS_CARD_CAN_UPDATE_PROCESSING - Изменения на проверке.
         NO_CARD_NEED_CONTENT - Создайте карточку.
         NO_CARD_MARKET_WILL_CREATE - Создаст Маркет.
         NO_CARD_ERRORS - Не создана из-за ошибки.
         NO_CARD_PROCESSING - Проверяем данные.
         NO_CARD_ADD_TO_CAMPAIGN - Разместите товар в магазине.
        */
        const status = result.cardStatus
        if (status === 'HAS_CARD_CAN_UPDATE_ERRORS' || status === 'NO_CARD_ERRORS' || status === 'NO_CARD_NEED_CONTENT') {
            item.channels[channel.identifier].status = 3
            item.channels[channel.identifier].message = JSON.stringify(result)
            item.channels[channel.identifier].syncedAt = new Date().getTime()
            item.channels[channel.identifier].yandexError = true
        } else if (status === 'HAS_CARD_CAN_UPDATE_PROCESSING' || status === 'NO_CARD_PROCESSING' || status  === 'NO_CARD_MARKET_WILL_CREATE') {
            item.channels[channel.identifier].status = 4
            item.channels[channel.identifier].message = JSON.stringify(result)
            item.channels[channel.identifier].syncedAt = new Date().getTime()
        } else if (status === 'HAS_CARD_CAN_NOT_UPDATE' || status === 'HAS_CARD_CAN_UPDATE' || status === 'NO_CARD_ADD_TO_CAMPAIGN') {
            item.channels[channel.identifier].status = 2
            item.channels[channel.identifier].message = JSON.stringify(result)
            item.channels[channel.identifier].syncedAt = new Date().getTime()
            item.channels[channel.identifier].yandexError = false
        }
        item.changed('channels', true)
    }

    public async getCategories(channel: Channel): Promise<{ list: ChannelCategory[] | null, tree: ChannelCategory | null }> {
        let tree: ChannelCategory | undefined = this.cache.get('categories')
        if (!tree) {
            const url = 'https://api.partner.market.yandex.ru/categories/tree'
            logger.info("Sending POST request to Yandex: " + url)
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Api-Key': channel.config.apiToken }
            })
            const json = await res.json()
            tree = { id: '', name: 'root', children: json.result.children }
            this.cache.set('categories', tree, 3600)
        }
        return { list: null, tree }
    }

    public async getAttributes(channel: Channel, categoryId: string): Promise<ChannelAttribute[]> {
        let data = this.cache.get('attr_' + categoryId)
        if (!data) {
            const res = await fetch(`https://api.partner.market.yandex.ru/category/${categoryId}/parameters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Api-Key': channel.config.apiToken }
            })
            const json = await res.json()
            data = Object.values(json.result.parameters).map((param: any) => {
                const dataType: keyof typeof YMDataTypes = param.type
                const defaultUnit = param.unit?.units && param.unit?.defaultUnitId ? param.unit.units.find((el: any) => el.id === param.unit.defaultUnitId) : null
                return {
                    id: 'yandexattr_' + param.id,
                    type: param.type,
                    description: param.description + '\n id: ' + param.id + ', category: ' + categoryId,
                    isNumber: param.type === 'NUMERIC' ? true : false,
                    name: param.name + (defaultUnit ? ', ' + defaultUnit.name : '') + (YMDataTypes[dataType] !== YMDataTypes.ENUM ? ' (' + YMDataTypes[dataType] + ')' : ''),
                    category: categoryId,
                    required: param.required,
                    dictionary: param.type === 'ENUM',
                    dictionaryLinkPost: param.type === 'ENUM' ? {
                        body: {
                            attribute_id: param.id,
                            category_id: categoryId,
                            language: "DEFAULT",
                            last_value_id: 0,
                            limit: 1000
                        },
                        headers: {
                            'Content-Type': 'application/json',
                            'Api-Key': channel.config.apiToken
                        }
                    } : null,
                    dictionaryLink: param.type === 'ENUM' ? `https://api.partner.market.yandex.ru/category/${categoryId}/parameters` : null
                }
            })
        }
        return <ChannelAttribute[]>data
    }

    public async getChannelAttributeValues(channel: Channel, categoryId: string, attributeId: string): Promise<any> {
        const attrs = await this.getAttributes(channel, categoryId)
        const attr = attrs.find(elem => elem.id === attributeId)
        const paramId = attributeId.substring(11)
        if (attr && attr.dictionaryLinkPost) {
            const resp = await fetch(attr.dictionaryLink!, {
                method: 'POST',
                headers: attr.dictionaryLinkPost.headers,
                body: JSON.stringify(attr.dictionaryLinkPost.body)
            })
            const json = await resp.json()
            const params = json.result?.parameters || []
            const param = params.find((el: any) => el.id === parseInt(paramId, 10))
            const result = {
                values: param?.values || []
            }
            return result
        }
        return {}
    }
}
