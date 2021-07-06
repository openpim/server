import { Channel, ChannelExecution } from "../../models/channels"
import { ChannelAttribute, ChannelCategory, ChannelHandler } from "../ChannelHandler"
import logger from "../../logger"
import * as temp from 'temp'
import { FileManager } from "../../media/FileManager"
import * as xml2js from 'xml2js'
import * as fs from 'fs'

const fsAsync = require('fs').promises

interface JobContext {
    log: string,
    result: number
}

export class YMChannelHandler extends ChannelHandler {
    public async processChannel(channel: Channel, language: string): Promise<void> {
        logger.debug('YM channel trigered: ' + channel.identifier)
        const chanExec = await this.createExecution(channel)

        const context: JobContext = {log: '', result: 2}
        let fileName = temp.path({prefix: 'openpim'})

        if (channel.config.shopAttributes) {
            const name = this.getValueByExpression(channel.config.shopAttributes.find((elem:any) => elem.id === 'name'))
            const company = this.getValueByExpression(channel.config.shopAttributes.find((elem:any) => elem.id === 'company'))
            const url = this.getValueByExpression(channel.config.shopAttributes.find((elem:any) => elem.id === 'url'))
            const currency1 = this.getValueByExpression(channel.config.shopAttributes.find((elem:any) => elem.id === 'currency1'))

            if (name && company && url && currency1) {
                const yml:any = {yml_catalog : {$: {date: new Date().toISOString()}, shop: {name: name, company: company, url: url, currencies: []}}}

                channel.config.shopAttributes.forEach((attrConfig:any) => {
                    if (attrConfig.id !== 'name' && attrConfig.id !== 'company' && attrConfig.id !== 'url') {
                        const attr = this.getValueByExpression(channel.config.shopAttributes.find((elem:any) => elem.id === attrConfig.id))
                        if (attr != null) {
                            if (attrConfig.id.startsWith('currency')) {
                                const arr = attr.split(',')
                                yml.yml_catalog.shop.currencies.push({currency: {$: {id: arr[0], rate: arr[1]}}})
                            } else if (attrConfig.id.startsWith('delivery-option')) {
                                const arr = attr.split(',')
                                if (!yml.yml_catalog.shop['delivery-options']) yml.yml_catalog.shop['delivery-options'] = []
                                const option:any = {option: {$: {cost: arr[0], days: arr[1]}}}
                                if (arr.length > 2) option.option.$['order-before'] = arr[2]
                                yml.yml_catalog.shop['delivery-options'].push(option)
                            } else { 
                                yml.yml_catalog.shop[attrConfig.id] = attr
                            }
                        }
                    }                    
                })

                const builder = new xml2js.Builder()
                const str = builder.buildObject(yml)
                logger.debug('YML file created. \n ' + str)
                console.log(str)
                
                /*
                await fsAsync.writeFile(fileName, str)
                if (fs.existsSync(fileName)) {
                    const fm = FileManager.getInstance()
                    fileName = await fm.saveChannelFile(channel.tenantId, channel.id, chanExec, fileName)
                    context.log += '\nсоздан YML файл'
                }

                if (channel.config.extCmd) {
                    const cmd = channel.config.extCmd + ' ' + fileName
                    logger.debug('Starting [' + cmd + ']')
                    context.log += '\nЗапускается ' + cmd
                    const result: any = await this.asyncExec(cmd)
                    context.log += result.stdout + (result.stderr ? "\nERRORS:\n" + result.stderr : "") 
                    if (result.code !== 0) {
                        context.result = 3
                        context.log += '\nОшибка запуска: ' + result.code
                    }
                }*/
            } else {
                context.result = 3
                if (!name) context.log += 'Не задан name в заголовоке YML файла'
                if (!company) context.log += 'Не задан company в заголовоке YML файла'
                if (!url) context.log += 'Не задан url в заголовоке YML файла'
                if (!currency1) context.log += 'Не задана валюта в заголовоке YML файла'
            }
        } else {
            context.result = 3
            context.log += 'Не задан заголовок YML файла'
        }
        await this.finishExecution(channel, chanExec, context.result, context.log)

    }

    public async getCategories(channel: Channel): Promise<ChannelCategory[]> {
        return []
    }

    public async getAttributes(channel: Channel, categoryId: string): Promise<ChannelAttribute[]> {
        return []
    }
}