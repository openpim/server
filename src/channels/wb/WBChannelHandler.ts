import { Channel } from '../../models/channels'
import { ChannelAttribute, ChannelCategory, ChannelHandler } from '../ChannelHandler'
import fetch from 'node-fetch'
import NodeCache = require('node-cache')
import { Item } from '../../models/items'
import logger from "../../logger"
import { sequelize } from '../../models'
import * as uuid from "uuid"

interface JobContext {
    log: string
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
            logger.debug("Sending request Windberries: " + url + " => " + JSON.stringify(request))
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
                console.log(333, json)
                if (json.error) {
                    const msg = 'Ошибка запроса на Wildberries: ' + json.error.message
                    context.log += msg                      
                    logger.debug("Error from Windberries: " + JSON.stringify(json))
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

        if (card.id !== item.values.wbId) {
            item.values.wbId = card.id
            item.changed('values', true)
            if (item.channels[channel.identifier] && item.channels[channel.identifier].status === 3 && item.channels[channel.identifier].message.startsWith('Wildberries не вернул ошибку')) {
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
            if (categoryConfig.valid && categoryConfig.valid.length > 0 && categoryConfig.visible && categoryConfig.visible.length > 0) {
                const pathArr = item.path.split('.')
                const tst = categoryConfig.valid.includes(''+item.typeId) && categoryConfig.visible.find((elem:any) => pathArr.includes(''+elem))
                if (tst) {
                    await this.processItemInCategory(channel, item, categoryConfig, language, context)
                    await sequelize.transaction(async (t) => {
                        await item.save({transaction: t})
                    })
                    return
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
        
        // request to WB
        const request:any = {id: uuid.v4(), jsonrpc: '2.0', params: { supplierID: channel.config.wbSupplierID, card: {}}}

        const prodCountryConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#prodCountry')
        request.params.card.countryProduction = await this.getValueByMapping(channel, prodCountryConfig, item, language)
        if (!request.params.card.countryProduction) {
            const msg = 'Не введена конфигурауция для "Страны производства" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

        const supplierCodeConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#supplierCode')
        const vendorCode = await this.getValueByMapping(channel, supplierCodeConfig, item, language)
        request.params.card.supplierVendorCode = vendorCode
        if (!request.params.card.supplierVendorCode) {
            const msg = 'Не введена конфигурауция для "Артикула поставщика" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

        const barcodeConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#barcode')
        const barcode = await this.getValueByMapping(channel, barcodeConfig, item, language)
        if (!barcode) {
            const msg = 'Не введена конфигурауция для "Баркода" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

        const priceConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#price')
        const price = await this.getValueByMapping(channel, priceConfig, item, language)
        if (!price) {
            const msg = 'Не введена конфигурауция для "Цены" для категории: ' + categoryConfig.name
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
        request.params.card.nomenclatures = [{vendorCode: request.params.card.supplierVendorCode, variations:[{barcode: barcode, addin:[tmp]}]}]

        request.params.card.object = categoryConfig.name

        // atributes
        for (let i = 0; i < categoryConfig.attributes.length; i++) {
            const attrConfig = categoryConfig.attributes[i];
            
            if (attrConfig.id != '#prodCountry' && attrConfig.id != '#supplierCode' && attrConfig.id != '#barcode' && attrConfig.id != '#price') {
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
                            if (!request.params.card.nomenclatures[0].addin) request.params.card.nomenclatures[0].addin = []
                            request.params.card.nomenclatures[0].addin.push(data)
                        } else if (attrConfig.id.startsWith('var#')) {
                            if (!request.params.card.nomenclatures[0].variations[0].addin) request.params.card.nomenclatures[0].variations[0].addin = []
                            request.params.card.nomenclatures[0].variations[0].addin.push(data)
                        } else {
                            if (!request.params.card.addin) request.params.card.addin = []
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

        const create = item.values.wbId ? false : true
        if (!create) request.params.card.id = item.values.wbId

        const url = create ? 'https://suppliers-api.wildberries.ru/card/create' : 'https://suppliers-api.wildberries.ru/card/update'
        console.log(url, JSON.stringify(request, null, 2))       
        logger.debug("Sending request Windberries: " + url + " => " + JSON.stringify(request))
        const res = await fetch(url, {
            method: 'post',
            body:    JSON.stringify(request),
            headers: { 'Content-Type': 'application/json', 'Authorization': channel.config.wbToken },
        })
        logger.debug("Response status from Windberries: " + res.status)
        if (res.status !== 200) {
            const msg = 'Ошибка запроса на Wildberries: ' + res.statusText
            context.log += msg                      
            this.reportError(channel, item, msg)
            return
        } else {
            const json = await res.json()
            console.log(222, json)
            if (json.error) {
                const msg = 'Ошибка запроса на Wildberries: ' + json.error.message
                this.reportError(channel, item, msg)
                context.log += msg                      
                logger.debug("Error from Windberries: " + JSON.stringify(json))
                return
            }
        }

        if (create) {
            // check that card was created and take id
            await new Promise(resolve => setTimeout(resolve, 1000)) // wait a second
            const query = {
                "id": "11",
                "jsonrpc": "2.0",
                "params": {
                  "filter": {
                      "find": [
                          {
                              "column": "nomenclatures.vendorCode",
                              "search": vendorCode
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
                body:    JSON.stringify(request),
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
                    logger.debug("Check error from Windberries: " + JSON.stringify(json))
                    return
                }

                if (json.result.cursor.total === 0) {
                    const msg = 'Wildberries не вернул ошибку, но карточка не создана.'
                    context.log += msg                      
                    this.reportError(channel, item, msg)
                    return
                }
                item.values.wbId = json.result.cards[0].id
                item.changed('values', true)
            }
        }

        context.log += 'Запись с идентификатором: ' + item.identifier + ' обработана успешно.\n'
        data.status = 2
        data.message = ''
        data.syncedAt = Date.now()
        item.changed('channels', true)
    }

    public async getCategories(channel: Channel): Promise<ChannelCategory[]> {
        let data = this.cache.get('categories')
        if (! data) {
            const res = await fetch('https://content-suppliers.wildberries.ru/ns/characteristics-configurator-api/content-configurator/api/v1/config/get/object/all?top=10000&lang=ru')
            const json = await res.json()
            data = Object.values(json.data).map(value => { return {id: this.transliterate((<string>value).toLowerCase()), name: value} } )
            this.cache.set('categories', data, 3600)
        }
        return <ChannelCategory[]>data
    }
    
    public async getAttributes(channel: Channel, categoryId: string): Promise<ChannelAttribute[]> {
        let data = this.cache.get('attr_'+categoryId)
        if (! data) {
            const categories = await this.getCategories(channel)
            const category = categories.find(elem => elem.id === categoryId)

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