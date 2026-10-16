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
import { replaceOperations, checkRelationAttrDisplayValue, checkLOV } from '../resolvers/utils'
import Context from "../context"
import { Attribute } from "../models/attributes"
import { QueryTypes } from 'sequelize'
import { evaluateMappingExpression } from './expressions'

export abstract class ChannelHandler {
  private lovCache = new NodeCache({useClones: false});
  private localCache = new NodeCache({useClones: false});

  abstract processChannel(channel: Channel, language: string, data: any, context?: Context): Promise<void>

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

  async isVariant(channel: Channel, item: Item): Promise<boolean> {
    if (channel.config.variantsSupport && channel.config.variantExpr) {
      return !!await this.evaluateExpression(channel, item, channel.config.variantExpr)
    }
    return false
  }

  async evaluateExpression (channel: Channel, item: Item, expr: string): Promise<any> {
    return await this.evaluateExpression2 (channel, item, expr, null)
  }

  async evaluateExpression2(channel: Channel, item: Item, expr: string, data: any): Promise<any> {
    const tenantId = channel ? channel.tenantId : item.tenantId
    return await this.evaluateExpressionCommon(tenantId, item, expr, data, channel)
  }

  async evaluateExpressionCommon(tenantId: string, item: Item, expr: string, data: any, channel: Channel | null): Promise<any> {
    if (!expr) return null
    function safeCondition(value: any, depth = 0): void {
      if (depth > 32) throw new Error('Query depth limit exceeded.')
      if (typeof value === 'string' && value.startsWith('###:')) throw new Error('Raw SQL is not allowed in mapping expressions.')
      if (value && typeof value === 'object') for (const name of Object.keys(value)) {
        if (['include', 'collectionId', '__proto__', 'constructor', 'prototype'].includes(name)) throw new Error('Query property is not allowed: ' + name)
        safeCondition(value[name], depth + 1)
      }
    }
    // Per-query transaction makes the deadline local to this operation/connection.
    const read = async (model: any, method: string, options: any) => sequelize.transaction(async t => {
      await sequelize.query("SET LOCAL statement_timeout = '2000ms'", { transaction: t })
      return model[method]({ ...options, transaction: t })
    })
    const readSQL = async (sql: string, options: any): Promise<any> => sequelize.transaction(async t => {
      await sequelize.query("SET LOCAL statement_timeout = '2000ms'", { transaction: t })
      return sequelize.query(sql, { ...options, transaction: t })
    })
    const utils = {
      findItem: async (condition: any) => {
        safeCondition(condition)
        logger.debug(`Executing evaluateExpression findItem, condition: ${JSON.stringify(condition)}`)
        replaceOperations(condition, null)
        const item = await read(Item, 'findOne', {
            where: {
                [Op.and]: [
                    condition,
                    { tenantId }
                ]
            }
        })
        logger.debug(`findItem result: ${item?.identifier}`)
        return item
      },
      findItems: async (condition: any) => {
        safeCondition(condition)
        logger.debug(`Executing evaluateExpression findItems, condition: ${JSON.stringify(condition)}`)
        replaceOperations(condition, null)
        const items = await read(Item, 'findAll', {
            where: {
                [Op.and]: [
                    condition,
                    { tenantId }
                ]
            }, limit: 100
        })
        logger.debug(`findItem result count: ${items?.length}`)
        return items
      },
      getItem: async (identifier: string) => {
        return await read(Item, 'findOne', {
          where: {
            identifier: identifier,
            tenantId
          }
        })
      },
      getRelation: async (relationIdentifier: string) => {
        return await read(ItemRelation, 'findOne', {
          where: {
            relationIdentifier: relationIdentifier,
            tenantId
          }
        })
      },
      getTargetRelations: async (relationIdentifier: string) => {
        return await read(ItemRelation, 'findAll', {
          where: {
            relationIdentifier: relationIdentifier,
            targetId: item.id,
            tenantId
          }, limit: 100
        })
      },
      getSourceRelations: async (relationIdentifier: string) => {
        return await read(ItemRelation, 'findAll', {
          where: {
            relationIdentifier: relationIdentifier,
            itemId: item.id,
            tenantId
          }, limit: 100
        })
      },
      getTargetRelation: async (relationIdentifier: string, itemIdentifier: string) => {
        return await read(ItemRelation, 'findOne', {
          where: {
            relationIdentifier: relationIdentifier,
            targetId: item.id,
            itemIdentifier: itemIdentifier,
            tenantId
          }
        })
      },
      getSourceRelation: async (relationIdentifier: string, targetIdentifier: string) => {
        return await read(ItemRelation, 'findOne', {
          where: {
            relationIdentifier: relationIdentifier,
            itemId: item.id,
            targetIdentifier: targetIdentifier,
            tenantId
          }
        })
      },
      getSourceRelationsById: async (relationIdentifier: string, id: number) => {
        return await read(ItemRelation, 'findAll', {
          where: {
            relationIdentifier: relationIdentifier,
            itemId: id,
            tenantId
          }, limit: 100
        })
      },
      getTargetRelationsById: async (relationIdentifier: string, id: number) => {
        return await read(ItemRelation, 'findAll', {
          where: {
            relationIdentifier: relationIdentifier,
            targetId: id,
            tenantId
          }, limit: 100
        })
      },
      getTargetObject: async (relationIdentifier: string, full: false) => {
        const items: Item[] = await readSQL(
          `SELECT i.* FROM "items" i, "itemRelations" r where 
              i."deletedAt" IS NULL and 
              r."deletedAt" IS NULL and 
              i."tenantId"=:tenant and
              r."tenantId"=:tenant and
              i."id"=r."targetId" and 
              r."relationIdentifier" = :relationIdentifier and 
              r."itemId"=:itemId 
              order by i.id LIMIT :resultLimit`, {
          replacements: { 
              resultLimit: full ? 100 : 1,
              tenant: tenantId,
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
        const items: Item[] = await readSQL(
          `SELECT i.* FROM "items" i, "itemRelations" r where 
              i."deletedAt" IS NULL and 
              r."deletedAt" IS NULL and 
              i."tenantId"=:tenant and
              r."tenantId"=:tenant and
              i."id"=r."itemId" and 
              r."relationIdentifier" = :relationIdentifier and 
              r."targetId"=:itemId 
              order by i.id LIMIT :resultLimit`, {
          replacements: { 
              resultLimit: full ? 100 : 1,
              tenant: tenantId,
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
          lov = await read(LOV, 'findOne', {
            where: {
              identifier: identifier,
              tenantId
            }
          })
          this.lovCache.set(key, lov, 180)
        }
        return lov
      },
      getLOVValue: async (identifier: string, id: number, lang: string, channel: string) => {
        const lov = await utils.getLOV(identifier)
        if (lov) {
          const val = lov.values.find((elem:any) => elem.id == id)
          if (val) return val[channel ? channel : 'value']?.[lang]
        } else {
          logger.warn(`getLOVValue: LOV with identifier ${identifier} not found`)
        }
        return null
      }
    }
    try {
      const plain = typeof (item as any).get === 'function' ? (item as any).get({ plain: true }) : item
      const safeItem = Object.fromEntries(['id', 'identifier', 'typeId', 'name', 'values', 'path', 'parentIdentifier', 'channels', 'mimeType', 'originalFilename'].map(name => [name, plain[name]]))
      const operators = Object.fromEntries(['eq', 'ne', 'and', 'or', 'not', 'in', 'notIn', 'gt', 'gte', 'lt', 'lte', 'like', 'iLike'].map(name => [name, 'OP_' + name]))
      return await evaluateMappingExpression(expr, { item: safeItem, data,
        channel: channel ? { id: channel.id, identifier: channel.identifier, type: channel.type } : null, Op: operators }, utils)
    } catch (err:any) {
      logger.error('Failed to execute mapping expression for item with id: ' + item.id + ' with error: ' + err.message)
      throw err
    }
  }
  async getValueByMapping(channel: Channel, mapping: any, item: Item, language: string): Promise<any> {
    return await this.getValueByMapping2(channel, mapping, item, language, null)
  }

  async getValueByMapping2(channel: Channel, mapping: any, item: Item, language: string, data: any): Promise<any> {
    if (!mapping) return null
    if (mapping.expr && mapping.expr.trim()) {
      return await this.evaluateExpression2(channel, item, mapping.expr, data)
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
            const tst = mapping.options.find((elem:any) => elem.name == attrValue)
            if (tst) {
              if (tst.value && tst.value.includes(';')) attrValue = tst.value.split(';')
                else attrValue = tst.value
            }
          }
          const mng = ModelsManager.getInstance().getModelManager(channel.tenantId)
          const attrNode = mng.getAttributeByIdentifier(mapping.attrIdent, true)
          if (attrNode) {
            const attr = attrNode.attr
            if (attr.type === 7) {
              return await checkLOV(channel, attr, attrValue, language, this.lovCache)
            } else if (attr.type === 9) {
              return await checkRelationAttrDisplayValue(channel.tenantId, attr, attrValue, language, channel, this.lovCache)
            } else {
              return attrValue
            }
          }
        }
      } else {
        const attr = mapping.attrIdent.substring(0, tst)
        const lang = mapping.attrIdent.substring(tst + 1)
        if (attr === '$name') {
          return item.name[lang]
        } else {
          let attrValue = item.values[attr] ? item.values[attr][lang] : null
          if (attrValue && mapping.options) {
            const tst = mapping.options.find((elem:any) => elem.name == attrValue)
            if (tst) {
              if (tst.value && tst.value.includes(';')) attrValue = tst.value.split(';')
                else attrValue = tst.value
            }
          }
          const mng = ModelsManager.getInstance().getModelManager(channel.tenantId)
          const attrNode = mng.getAttributeByIdentifier(attr, true)
          if (attrNode) {
            const attr = attrNode.attr
            if (attr.type === 7) {
              return await checkLOV(channel, attr, attrValue, lang, this.lovCache)
            } else if (attr.type === 9) {
              return await checkRelationAttrDisplayValue(channel.tenantId, attr, attrValue, lang, channel, this.lovCache)
            } else {
              return attrValue
            }
          }
        }
      }
    }
    return null
  }

  async sleep(ms: number) {
    return new Promise( resolve => setTimeout(resolve, ms) )
}

  async getValueByExpression(mapping: any): Promise<any> {
    if (mapping && mapping.expr) {
      return await evaluateMappingExpression(mapping.expr, {})
    }
    return null
  }

  public async clearLOVCache() {
    this.lovCache.flushAll()
  }

  reportError(channel: Channel, item: Item, error: string) {
    const data = item.channels[channel.identifier]
    data.status = 3
    data.message = error
    delete data.wbError
    delete data.ozonError
    item.changed('channels', true)
    return data
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
  filtering: boolean
  dictionary: boolean
  category: string
  dictionaryLink?: string
  dictionaryLinkPost?: any
  maxCount?: number
  isAspect?: boolean
  attributeComplexId?: number
  categoryDependent?: boolean
}
