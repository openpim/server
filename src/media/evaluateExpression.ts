const { Op } = require('sequelize')

import * as fs from 'fs'
import * as http from 'http'
import * as https from 'https'
import * as os from 'os'
import moment from 'moment'
import Context from '../context'
import logger from '../logger'
import { Item } from '../models/items'
import { ModelsManager } from '../models/manager'
import { LOV } from '../models/lovs'
import { ItemRelation } from '../models/itemRelations'
import { ActionUtils, mergeValues, replaceOperations } from '../resolvers/utils'

export async function evaluateExpression(row: any, data: any, expression: string, context: Context): Promise<any> {
    try {
        const actionUtils = new ActionUtils(context)
        const utils = {
            findItem: async (condition: any) => {
                logger.debug(`Executing evaluateExpression findItem, condition: ${JSON.stringify(condition)}`)
                replaceOperations(condition, context)
                const item = await Item.findOne({
                    where: {
                        [Op.and]: [
                            condition,
                            { tenantId: context.getCurrentUser()?.tenantId }
                        ]
                    }
                })
                logger.debug(`findItem result: ${item?.identifier}`)
                return item
            },
            findItems: async (condition: any) => {
                logger.debug(`Executing evaluateExpression findItems, condition: ${JSON.stringify(condition)}`)
                replaceOperations(condition, context)
                const arr = await Item.findAll({
                    where: {
                        [Op.and]: [
                            condition,
                            { tenantId: context.getCurrentUser()?.tenantId }
                        ]
                    }
                })
                logger.debug(`findsItem result: ${arr.length}`)
                return arr
            },
            findLOV: async (lovIdentifier: string, value: string, lang = 'en', caseInsensitive = false, createIfNotExists = false) => {
                const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
                let lov: LOV | undefined | null = mng.getCache().get('IM_LOV_' + lovIdentifier)
                if (!lov) {
                    lov = await LOV.applyScope(context).findOne({ where: { identifier: lovIdentifier } })
                    if (!lov) throw new Error(`Failed to find LOV by identifier: ${lovIdentifier}`)
                    logger.debug('findLOV: lov found')
                    mng.getCache().set('IM_LOV_' + lovIdentifier, lov, 60 * 60)
                }
                const valueLowerCase = value ? ('' + value).toLowerCase() : null
                let val = lov.values.find((elem: any) => {
                    if (!caseInsensitive) {
                        return elem.value[lang] == value
                    } else {
                        const elemVal = elem.value[lang] ? elem.value[lang].toLowerCase() : null
                        return elemVal == valueLowerCase
                    }
                })
                logger.debug(`findLOV: value found: ${JSON.stringify(val)}`)
                if (!val && createIfNotExists) {
                    const max = lov.values.reduce((prev: any, current: any) => (prev.id > current.id) ? prev : current)
                    val = { id: max ? max.id + 1 : 1, value: {}, filter: null }
                    val.value[lang] = value
                    lov.values.push(val)
                    lov.changed('values', true)
                    logger.debug(`findLOV: new value created: ${JSON.stringify(val)}`)
                    await lov.save()
                }
                return val?.id
            },
            getCache: () => {
                const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
                return mng.getCache()
            },
            downloadFile: async (url: string, targetPath: string): Promise<string | null> => {
                return new Promise((resolve, reject) => {
                    const file = fs.createWriteStream(targetPath)
                    const get = url.startsWith('https:') ? https.get : http.get
                    get(url, response => {
                        const mimeType = response.headers['content-type']
                        response.pipe(file)
                        file.on('finish', (): void => {
                            file.close(() => resolve(mimeType || null))
                        })
                        file.on('error', err => {
                            fs.unlink(targetPath, () => reject(err))
                        })
                    }).on('error', err => {
                        fs.unlink(targetPath, (): void => reject(err))
                    })
                })
            },
            downloadAndAssignFile: async (url: string, itemIdentifier: string, fileIdentifier: string, fileType: string, fileParent: string, fileName: any, fileValues: any, relationType: string, relationIdentifier: string, relationValues: any, skipActions: boolean = false) => {
                if (!url) return
                const tmpFile = os.tmpdir() + '/' + Date.now()
                const mimeType = await utils.downloadFile(url, tmpFile)
                let file = await Item.applyScope(context).findOne({ where: { identifier: fileIdentifier } })
                if (!file) {
                    file = await actionUtils.createItem(fileParent, fileType, fileIdentifier, { ru: fileName }, fileValues, skipActions)
                    await file.save()
                }
                await actionUtils.saveFile(file, tmpFile, mimeType, fileName, true)
                file.values = mergeValues(fileValues, file.values)
                file.changed('values', true)
                await file.save()
                const rel = await ItemRelation.applyScope(context).findOne({ where: { identifier: relationIdentifier } })
                if (!rel) {
                    await actionUtils.createItemRelation(relationType, relationIdentifier, itemIdentifier, file.identifier, relationValues, skipActions)
                } else {
                    rel.values = mergeValues(relationValues, rel.values)
                    rel.changed('values', true)
                    await rel.save()
                }
            }
        }
        const func = new Function('row', 'data', 'utils', 'actionUtils', 'moment', 'logger', '"use strict"; return (async () => { return (' + expression + ')})()')
        return await func(row, data, utils, actionUtils, moment, logger)
    } catch (err: any) {
        logger.error('Failed to execute expression :[' + expression + '] for data: ' + data + ' with error: ' + err.message)
        throw err
    }
}
