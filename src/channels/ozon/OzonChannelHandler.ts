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


        context.log += 'Cинхронизация закончена'
    }

    async processItem(channel: Channel, item: Item, language: string, context: JobContext) {
        context.log += 'Обрабатывается запись с идентификатором: ' + item.identifier +'\n'

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
