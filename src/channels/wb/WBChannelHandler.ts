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

    public async processChannel(channel: Channel): Promise<void> {
        channel.runtime.lastStart = new Date()

        const query:any = {}
        query[channel.identifier] = {status: 1}
        let items = await Item.findAll({ 
            where: { tenantId: channel.tenantId, channels: query} 
        })
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            await this.processItem(channel, item)
        }
        // TODO add record to channel executions
        channel.runtime.duration = Date.now() - channel.runtime.lastStart.getTime()
        await sequelize.transaction(async (t) => {
            await channel.save({transaction: t})
        })
    }

    async processItem(channel: Channel, item: Item) {
        for (const categoryId in channel.mappings) {
            const categoryConfig = channel.mappings[categoryId]
            if (categoryConfig.valid && categoryConfig.valid.length > 0 && categoryConfig.visible && categoryConfig.visible.length > 0) {
                const pathArr = item.path.split('.')
                const tst = categoryConfig.valid.includes(''+item.typeId) && categoryConfig.visible.find((elem:any) => pathArr.includes(''+elem))
                if (tst) {
                    await this.processItemInCategory(channel, item, categoryConfig)
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

    async processItemInCategory(channel: Channel, item: Item, categoryConfig: any) {
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
        request.params.card.countryProduction = await this.getValueByMapping(prodCountryConfig, item)
        if (!request.params.card.countryProduction) {
            this.reportError(channel, item, 'Не введена конфигурауция для "Страны производства" для категории: ' + categoryConfig.name)
            return
        }

        const supplierCodeConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#supplierCode')
        request.params.card.supplierVendorCode = await this.getValueByMapping(supplierCodeConfig, item)
        if (!request.params.card.supplierVendorCode) {
            this.reportError(channel, item, 'Не введена конфигурауция для "Артикула поставщика" для категории: ' + categoryConfig.name)
            return
        }

        request.params.card.object = categoryConfig.name

        console.log(request)

        data.status = 2
        data.message = ''
        data.syncedAt = Date.now()
        // item.changed('channels', true)
    }

    async getValueByMapping(mapping:any, item: Item): Promise<any> {
        if (mapping.expr) {

        } else if (mapping.attrIdent) {
            const tst = mapping.attrIdent.indexOf('#')
            if (tst === -1) {
                return item.values[mapping.attrIdent]
            } else {
                const attr = mapping.attrIdent.substring(0, tst)
                const lang = mapping.attrIdent.substring(tst+1)
                return item.values[attr][lang]
            }
        }
        return null
    }

    reportError(channel: Channel, item: Item, error: string) {
        const data = item.channels[channel.identifier]
        data.status = 3
        data.message = error
        item.changed('channels', true)
        return
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
                        id: this.transliterate((<string>addin.type).toLowerCase()), 
                        name: addin.type + (addin.units ? ' (' + addin.units[0] + ')' : ''),
                        required: addin.required,
                        dictionary: !!addin.dictionary,
                        dictionaryLink: addin.dictionary ? 'https://content-suppliers.wildberries.ru/ns/characteristics-configurator-api/content-configurator/api/v1/directory/' + encodeURIComponent(addin.dictionary.substring(1)) + '?lang=ru&top=500' : null
                    } 
                } )
                data = [...<ChannelAttribute[]>data, ...nomenclature]
            }
            this.cache.set('attr_'+categoryId, data, 3600)
        }
        return <ChannelAttribute[]>data
    }

    private a:any = {"(": "_", ")": "_", "\"":"_","'":"_"," ": "_","Ё":"YO","Й":"I","Ц":"TS","У":"U","К":"K","Е":"E","Н":"N","Г":"G","Ш":"SH","Щ":"SCH","З":"Z","Х":"H","Ъ":"'","ё":"yo","й":"i","ц":"ts","у":"u","к":"k","е":"e","н":"n","г":"g","ш":"sh","щ":"sch","з":"z","х":"h","ъ":"'","Ф":"F","Ы":"I","В":"V","А":"a","П":"P","Р":"R","О":"O","Л":"L","Д":"D","Ж":"ZH","Э":"E","ф":"f","ы":"i","в":"v","а":"a","п":"p","р":"r","о":"o","л":"l","д":"d","ж":"zh","э":"e","Я":"Ya","Ч":"CH","С":"S","М":"M","И":"I","Т":"T","Ь":"'","Б":"B","Ю":"YU","я":"ya","ч":"ch","с":"s","м":"m","и":"i","т":"t","ь":"_","б":"b","ю":"yu"};
    private transliterate (word: string) {
      return word.split('').map( (char) => { 
        return this.a[char] || char; 
      }).join("")
    }
}
