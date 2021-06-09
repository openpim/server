import { Channel } from '../../models/channels'
import { ChannelAttribute, ChannelCategory, ChannelHandler } from '../ChannelHandler'
import fetch from 'node-fetch'
import NodeCache = require('node-cache')
import { Item } from '../../models/items'
import logger from "../../logger"
import { sequelize } from '../../models'
import * as uuid from "uuid"

export class WBChannelHandler extends ChannelHandler {
    private cache = new NodeCache();

    public async processChannel(channel: Channel, language: string): Promise<void> {
        channel.runtime.lastStart = new Date()

        const query:any = {}
        query[channel.identifier] = {status: 1}
        let items = await Item.findAll({ 
            where: { tenantId: channel.tenantId, channels: query} 
        })
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            await this.processItem(channel, item, language)
        }
        // TODO add record to channel executions
        channel.runtime.duration = Date.now() - channel.runtime.lastStart.getTime()
        await sequelize.transaction(async (t) => {
            await channel.save({transaction: t})
        })
    }

    async processItem(channel: Channel, item: Item, language: string) {
        for (const categoryId in channel.mappings) {
            const categoryConfig = channel.mappings[categoryId]
            if (categoryConfig.valid && categoryConfig.valid.length > 0 && categoryConfig.visible && categoryConfig.visible.length > 0) {
                const pathArr = item.path.split('.')
                const tst = categoryConfig.valid.includes(''+item.typeId) && categoryConfig.visible.find((elem:any) => pathArr.includes(''+elem))
                if (tst) {
                    await this.processItemInCategory(channel, item, categoryConfig, language)
                    await sequelize.transaction(async (t) => {
                        await item.save({transaction: t})
                    })
                    return
                }
            } else {
                logger.warn('No valid/visible configuration for : ' + channel.identifier + ' for item: ' + item.identifier + ', tenant: ' + channel.tenantId)
            }
        }

        const data = item.channels[channel.identifier]
        data.status = 3
        data.message = 'Этот объект не подходит ни под одну категорию из этого канала.'
        item.changed('channels', true)
        await sequelize.transaction(async (t) => {
            await item.save({transaction: t})
        })
    }

    async processItemInCategory(channel: Channel, item: Item, categoryConfig: any, language: string) {
        if (!channel.config.wbToken) {
            this.reportError(channel, item, 'Не введен API token в конфигурации канала')
            return
        }
        if (!channel.config.wbSupplierID) {
            this.reportError(channel, item, 'Не введен идентификатор поставщика в конфигурации канала')
            return
        }

        const data = item.channels[channel.identifier]
        data.category = categoryConfig.id
        
        // request to WB
        const request:any = {id: uuid.v4(), jsonrpc: '2.0', params: { supplierID: channel.config.wbSupplierID, card: {}}}

        const prodCountryConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#prodCountry')
        request.params.card.countryProduction = await this.getValueByMapping(channel, prodCountryConfig, item, language)
        if (!request.params.card.countryProduction) {
            this.reportError(channel, item, 'Не введена конфигурауция для "Страны производства" для категории: ' + categoryConfig.name)
            return
        }

        const supplierCodeConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#supplierCode')
        const vendorCode = await this.getValueByMapping(channel, supplierCodeConfig, item, language)
        request.params.card.supplierVendorCode = vendorCode
        if (!request.params.card.supplierVendorCode) {
            this.reportError(channel, item, 'Не введена конфигурауция для "Артикула поставщика" для категории: ' + categoryConfig.name)
            return
        }

        const barcodeConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#barcode')
        const barcode = await this.getValueByMapping(channel, barcodeConfig, item, language)
        if (!barcode) {
            this.reportError(channel, item, 'Не введена конфигурауция для "Баркода" для категории: ' + categoryConfig.name)
            return
        }

        const priceConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#price')
        const price = await this.getValueByMapping(channel, priceConfig, item, language)
        if (!price) {
            this.reportError(channel, item, 'Не введена конфигурауция для "Цены" для категории: ' + categoryConfig.name)
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
                        if (attrConfig.id.startsWith('nom#')) {
                            if (!request.params.card.nomenclatures[0].addin) request.params.card.nomenclatures[0].addin = []
                            request.params.card.nomenclatures[0].addin.push({type: attr.name, params: [{value: value}]})
                        } else if (attrConfig.id.startsWith('var#')) {
                            if (!request.params.card.nomenclatures[0].variations[0].addin) request.params.card.nomenclatures[0].variations[0].addin = []
                            request.params.card.nomenclatures[0].variations[0].addin.push({type: attr.name, params: [{value: value}]})
                        } else {
                            if (!request.params.card.addin) request.params.card.addin = []
                            request.params.card.addin.push({type: attr.name, params: [{value: value}]})
                        }
                    } else if (attr.required) {
                        this.reportError(channel, item, 'Нет значения для обязательного атрибута "' + attr.name + '" для категории: ' + categoryConfig.name)
                        return
                    }
                } catch (err) {
                    logger.error('Ошибка вычисления атрибута "' + attr.name + '" для категории: ' + categoryConfig.name, err)
                    this.reportError(channel, item, 'Ошибка вычисления атрибута "' + attr.name + '" для категории: ' + categoryConfig.name + ': ' + err.message)
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
            this.reportError(channel, item, 'Ошибка запроса на Wildberries: ' + res.statusText)
            return
        } else {
            const json = await res.json()
            console.log(222, json)
            if (json.error) {
                this.reportError(channel, item, 'Ошибка запроса на Wildberries: ' + json.error.message)
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
                this.reportError(channel, item, 'Ошибка запроса проверки на Wildberries: ' + res.statusText)
                return
            } else {
                const json = await res.json()
                if (json.error) {
                    this.reportError(channel, item, 'Ошибка запроса проверки на Wildberries: ' + json.error.message)
                    logger.debug("Check error from Windberries: " + JSON.stringify(json))
                    return
                }

                if (json.result.cursor.total === 0) {
                    this.reportError(channel, item, 'Wildberries не вернул ошибку, но карточка не создана.')
                    return
                }
                item.values.wbId = json.result.cards[0].id
                item.changed('values', true)
            }
        }

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