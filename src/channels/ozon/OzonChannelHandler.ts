import { Channel } from '../../models/channels'
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


        context.log += 'Cинхронизация закончена'
    }

    async processItem(channel: Channel, item: Item, language: string, context: JobContext) {
        context.log += 'Обрабатывается запись с идентификатором: ' + item.identifier +'\n'

        for (const categoryId in channel.mappings) {
            const categoryConfig = channel.mappings[categoryId]
            if (categoryConfig.valid && categoryConfig.valid.length > 0 && categoryConfig.visible && categoryConfig.visible.length > 0) {
                const pathArr = item.path.split('.')
                const tst = categoryConfig.valid.includes(''+item.typeId) && categoryConfig.visible.find((elem:any) => pathArr.includes(''+elem))
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

        const barcodeConfig = categoryConfig.attributes.find((elem:any) => elem.id === '#barcode')
        const barcode = await this.getValueByMapping(channel, barcodeConfig, item, language)
        if (!barcode) {
            const msg = 'Не введена конфигурация для "Баркода" для категории: ' + categoryConfig.name
            context.log += msg
            this.reportError(channel, item, msg)
            return
        }

        product.barcode = barcode

        // atributes
        for (let i = 0; i < categoryConfig.attributes.length; i++) {
            const attrConfig = categoryConfig.attributes[i];
            
            if (attrConfig.id != '#barcode') {
                const attr = (await this.getAttributes(channel, categoryConfig.id)).find(elem => elem.id === attrConfig.id)
                if (!attr) {
                    logger.warn('Failed to find attribute in channel for attribute with id: ' + attrConfig.id)
                    continue
                }
                try {
                    const value = await this.getValueByMapping(channel, attrConfig, item, language)
                    if (value) {
                        const data = {id: attrConfig.id.substring(5), values: <any[]>[]}
                        if (Array.isArray(value)) {
                            value.forEach((elem:any) => {
                                data.values.push({ value: elem })
                            })
                        } else {
                            data.values.push({ value: value })
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
            console.log(555, JSON.stringify(json, null, 3))
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
                category_id: categoryId.substring(4),
                language: "DEFAULT"
              }
            const res = await fetch('https://api-seller.ozon.ru/v2/category/attribute', {
                method: 'post',
                body:    JSON.stringify(query),
                headers: { 'Content-Type': 'application/json', 'Client-Id': channel.config.ozonClientId, 'Api-Key': channel.config.ozonApiKey }
            })
            const json = await res.json()

            data = json.result.map((elem:any) => { 
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
