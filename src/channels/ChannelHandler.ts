const { Op } = require("sequelize");

import NodeCache = require("node-cache")
import { Channel, ChannelExecution } from "../models/channels"
import { Item } from "../models/items"
import { LOV } from "../models/lovs"
import { ModelsManager } from "../models/manager"
import { sequelize } from '../models'
import logger from "../logger"
import { exec } from "child_process"
import { ItemRelation } from "../models/itemRelations"
import { replaceOperations } from '../resolvers/utils'

export abstract class ChannelHandler {
  private lovCache = new NodeCache({useClones: false});

  abstract processChannel(channel: Channel, language: string, data: any): Promise<void>

  abstract getCategories(channel: Channel): Promise<{list: ChannelCategory[]|null, tree: ChannelCategory|null}>

  abstract getAttributes(channel: Channel, categoryId: string): Promise<{ id: string; name: string; required: boolean; dictionary: boolean, dictionaryLink?: string }[]>

  async getChannelAttributeValues(channel: Channel, categoryId: string, attributeId: string): Promise<any> {
    return {}
  }

  asyncExec (cmd: string) {
    return new Promise(async (resolve) => {
        try {
            exec(cmd, {maxBuffer: 1024 * 10000}, function (error: any, stdout: string, stderr: string) {
                resolve({ code: error ? error.code : 0, stdout:stdout, stderr: stderr } )
            })
        } catch (err:any) {
            logger.error('External channel error: ', err)
            resolve({ code: -1, stdout: '', stderr: err.message } )
        }
    })
  }

  async createExecution(channel: Channel) {
    channel.runtime.lastStart = new Date()

    const chanExec = await sequelize.transaction(async (t:any) => {
        await channel.save({transaction: t})
        return await ChannelExecution.create({
            tenantId: channel.tenantId,
            channelId: channel.id,
            status: 1,
            startTime: new Date(),
            finishTime: null,
            storagePath: '',
            log: '',
            createdBy: 'system',
            updatedBy: 'system',
        }, { transaction: t })
    })
    return chanExec
  }

  async finishExecution(channel: Channel, chanExec: ChannelExecution, status: number, log?: string) {
    chanExec.status = status
    chanExec.finishTime = new Date()
    chanExec.log = log || ''

    channel.runtime.duration = chanExec.finishTime.getTime() - chanExec.startTime.getTime()
    await sequelize.transaction(async (t: any) => {
        await channel.save({transaction: t})
        await chanExec!.save({transaction: t})
    })
  }

  isVariant(channel: Channel, item: Item): boolean {
    if (channel.config.variantsSupport && channel.config.variantExpr) {
      const func = new Function('item', '"use strict"; return (' + channel.config.variantExpr + ')')
      return !!func(item)
    }
    return false
  }

  async evaluateExpression (channel: Channel, item: Item, expr: string): Promise<any> {
    return await this.evaluateExpression2 (channel, item, expr, null)
  }

  async evaluateExpression2 (channel: Channel, item: Item, expr: string, data: any): Promise<any> {
    if (!expr) return null
    
    const utils = {
      findItem: async (condition: any) => {
        logger.debug(`Executing evaluateExpression findItem, condition: ${JSON.stringify(condition)}`)
        replaceOperations(condition)
        const item = await Item.findOne({
            where: {
                [Op.and]: [
                    condition,
                    { tenantId: channel.tenantId }
                ]
            }
        })
        logger.debug(`findItem result: ${item?.identifier}`)
        return item
      },
      findItems: async (condition: any) => {
        logger.debug(`Executing evaluateExpression findItems, condition: ${JSON.stringify(condition)}`)
        replaceOperations(condition)
        const items = await Item.findAll({
            where: {
                [Op.and]: [
                    condition,
                    { tenantId: channel.tenantId }
                ]
            }
        })
        logger.debug(`findItem result count: ${items?.length}`)
        return items
      },
      getItem: async (identifier: string) => {
        return await Item.findOne({
          where: {
            identifier: identifier,
            tenantId: channel.tenantId,
          }
        })
      },
      getRelation: async (relationIdentifier: string) => {
        return await ItemRelation.findOne({
          where: {
            relationIdentifier: relationIdentifier,
            tenantId: channel.tenantId,
          }
        })
      },
      getTargetRelations: async (relationIdentifier: string) => {
        return await ItemRelation.findAll({
          where: {
            relationIdentifier: relationIdentifier,
            targetId: item.id,
            tenantId: channel.tenantId,
          }
        })
      },
      getSourceRelations: async (relationIdentifier: string) => {
        return await ItemRelation.findAll({
          where: {
            relationIdentifier: relationIdentifier,
            itemId: item.id,
            tenantId: channel.tenantId,
          }
        })
      },
      getTargetRelation: async (relationIdentifier: string, itemIdentifier: string) => {
        return await ItemRelation.findOne({
          where: {
            relationIdentifier: relationIdentifier,
            targetId: item.id,
            itemIdentifier: itemIdentifier,
            tenantId: channel.tenantId,
          }
        })
      },
      getSourceRelation: async (relationIdentifier: string, targetIdentifier: string) => {
        return await ItemRelation.findOne({
          where: {
            relationIdentifier: relationIdentifier,
            itemId: item.id,
            targetIdentifier: targetIdentifier,
            tenantId: channel.tenantId,
          }
        })
      },
      getTargetObject: async (relationIdentifier: string, full: false) => {
        const items: Item[] = await sequelize.query(
          `SELECT i.* FROM "items" i, "itemRelations" r where 
              i."deletedAt" IS NULL and 
              r."deletedAt" IS NULL and 
              i."tenantId"=:tenant and 
              i."id"=r."targetId" and 
              r."relationIdentifier" = :relationIdentifier and 
              r."itemId"=:itemId 
              order by i.id`, {
          replacements: { 
              tenant: channel.tenantId,
              relationIdentifier: relationIdentifier,
              itemId: item.id
          },
          model: Item,
          mapToModel: true
        })
        if (!full) {
          return items && items.length > 0 ? items[0] : null
        } else {
          return items && items.length > 0 ? items : []
        }
      },
      getSourceObject: async (relationIdentifier: string, full: false) => {
        const items: Item[] = await sequelize.query(
          `SELECT i.* FROM "items" i, "itemRelations" r where 
              i."deletedAt" IS NULL and 
              r."deletedAt" IS NULL and 
              i."tenantId"=:tenant and 
              i."id"=r."itemId" and 
              r."relationIdentifier" = :relationIdentifier and 
              r."targetId"=:itemId 
              order by i.id`, {
          replacements: { 
              tenant: channel.tenantId,
              relationIdentifier: relationIdentifier,
              itemId: item.id
          },
          model: Item,
          mapToModel: true
        })
        if (!full) {
          return items && items.length > 0 ? items[0] : null
        } else {
          return items && items.length > 0 ? items : []
        }
      },
      getLOV: async (identifier: string) => {
        const key = 'utilsLOV_'+identifier
        let lov:LOV | undefined | null = this.lovCache.get(key)
        if (!lov) {
          lov = await LOV.findOne({
            where: {
              identifier: identifier,
              tenantId: channel.tenantId,
            }
          })
          this.lovCache.set(key, lov, 180)
        }
        return lov
      },
      getLOVValue: async (identifier: string, id: number, lang: string) => {
        const lov = await utils.getLOV(identifier)
        if (lov) {
          const val = lov.values.find((elem:any) => elem.id == id)
          if (val) return val.value[lang]
        }
        return null
      }
    }
    try {
      const func = new Function('item', 'utils', 'channel', 'data', '"use strict"; return (async () => { return (' + expr + ')})()')
      return await func(item, utils, channel, data)
    } catch (err:any) {
      logger.error('Failed to execute expression :[' + expr + '] for item with id: ' + item.id + ' with error: ' + err.message)
      throw err
    }
  }
  async getValueByMapping(channel: Channel, mapping: any, item: Item, language: string): Promise<any> {
    return await this.getValueByMapping2(channel, mapping, item, language, null)
  }

  async getValueByMapping2(channel: Channel, mapping: any, item: Item, language: string, variant: any): Promise<any> {
    if (!mapping) return null
    if (mapping.expr && mapping.expr.trim()) {
      return await this.evaluateExpression2(channel, item, mapping.expr, variant)
    } else if (mapping.attrIdent) {
      const tst = mapping.attrIdent.indexOf('#')
      if (tst === -1) {
        if (mapping.attrIdent === '$parentId') {
          const arr = item.path.split('.')
          return parseInt(arr[arr.length-2])
        } else if (mapping.attrIdent === '$id') {
            return item.id
        } else {
          let attrValue = item.values[mapping.attrIdent]
          if (attrValue && mapping.options) {
            const tst = mapping.options.find((elem:any) => elem.name === attrValue)
            if (tst) attrValue = tst.value
          }

          return await this.checkLOV(channel, mapping.attrIdent, attrValue, language)
        }
      } else {
        const attr = mapping.attrIdent.substring(0, tst)
        const lang = mapping.attrIdent.substring(tst + 1)
        if (attr === '$name') {
          return item.name[lang]
        } else {
          let attrValue = item.values[attr] ? item.values[attr][lang] : null
          if (attrValue && mapping.options) {
            const tst = mapping.options.find((elem:any) => elem.name === attrValue)
            if (tst) attrValue = tst.value
          }
          return await this.checkLOV(channel, attr, attrValue, language)
        }
      }
    }
    return null
  }

  async sleep(ms: number) {
    return new Promise( resolve => setTimeout(resolve, ms) )
}

  getValueByExpression(mapping: any): any {
    if (mapping && mapping.expr) {
      const func = new Function('"use strict"; return (' + mapping.expr + ')')
      return func()
    }
    return null
  }

  private async checkLOV(channel: Channel, attrIdent: string, attrValue: any, language: string) {
    if (!attrValue) return attrValue

    const mng = ModelsManager.getInstance().getModelManager(channel.tenantId)
    const attrNode = mng.getAttributeByIdentifier(attrIdent, true)
    if (attrNode) {
      const attr = attrNode.attr
      if (attr.lov && attr.type == 7) {
        let lov:LOV | undefined | null = this.lovCache.get(attr.lov)
        if (!lov) {
          lov = await LOV.findByPk(attr.lov)
          this.lovCache.set(attr.lov, lov, 180)
        }
        if (lov) {
          if (Array.isArray(attrValue)) {
            if (attrValue.length === 0) return null
            return attrValue.map(val => {
              const value = lov!.values.find((elem:any) => elem.id === val)
              if (!value) {
                logger.error('Failed to find id '+val+' in lov '+attr.lov+' during evaluation of attribute '+attrIdent)
                return val
              }
              return value[channel.identifier] ? value[channel.identifier][language] || value.value[language] : value.value[language]
            })
          } else {
            const value = lov.values.find((elem:any) => elem.id === attrValue)
            if (!value) {
              logger.error('Failed to find id '+attrValue+' in lov '+attr.lov+' during evaluation of attribute '+attrIdent)
              return value
            }
            return value[channel.identifier] ? value[channel.identifier][language] || value.value[language] : value.value[language]
          }
        }
      }
    }
    return attrValue
  }

  public async clearLOVCache() {
    this.lovCache.flushAll()
  }

  reportError(channel: Channel, item: Item, error: string) {
    const data = item.channels[channel.identifier]
    data.status = 3
    data.message = error
    item.changed('channels', true)
    return
  }

  private a:any = {"(": "_", ")": "_", "\"":"_","'":"_"," ": "_","Ё":"YO","Й":"I","Ц":"TS","У":"U","К":"K","Е":"E","Н":"N","Г":"G","Ш":"SH","Щ":"SCH","З":"Z","Х":"H","Ъ":"'","ё":"yo","й":"i","ц":"ts","у":"u","к":"k","е":"e","н":"n","г":"g","ш":"sh","щ":"sch","з":"z","х":"h","ъ":"'","Ф":"F","Ы":"I","В":"V","А":"a","П":"P","Р":"R","О":"O","Л":"L","Д":"D","Ж":"ZH","Э":"E","ф":"f","ы":"i","в":"v","а":"a","п":"p","р":"r","о":"o","л":"l","д":"d","ж":"zh","э":"e","Я":"Ya","Ч":"CH","С":"S","М":"M","И":"I","Т":"T","Ь":"'","Б":"B","Ю":"YU","я":"ya","ч":"ch","с":"s","м":"m","и":"i","т":"t","ь":"_","б":"b","ю":"yu"};
  transliterate (word: string) {
    return word.split('').map( (char) => { 
      return this.a[char] || char; 
    }).join("")
  }
}

export interface ChannelCategory {
  id: string
  name: string
  children?: ChannelCategory[]
}

export interface ChannelAttribute {
  id: string
  type: string
  isNumber: boolean
  name: string
  required: boolean
  dictionary: boolean
  category: string
  dictionaryLink?: string
  dictionaryLinkPost?: any
  maxCount?: number
  isAspect?: boolean
  attributeComplexId?: number
  categoryDependent?: boolean
}