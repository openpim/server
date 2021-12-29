import * as fs from 'fs'
import {Request, Response} from 'express'
import Context from '../context'
import { IncomingForm, File } from 'formidable'
import { Item } from '../models/items'
import { ModelsManager } from '../models/manager'
import { FileManager } from './FileManager'
import { sequelize } from '../models'
import { QueryTypes } from 'sequelize'

import logger from '../logger'
import { Type } from '../models/types'
import { ItemRelation } from '../models/itemRelations'
import audit, { AuditItem, ChangeType, ItemRelationChanges } from '../audit'
import { ChannelExecution } from '../models/channels'
import contentDisposition = require('content-disposition')
import { checkValues, filterValues, processItemActions } from '../resolvers/utils'
import { EventType } from '../models/actions'

export async function processChannelDownload(context: Context, req: Request, res: Response, thumbnail: boolean) {
    const idStr = req.params.id
    const id = parseInt(idStr)
    if (!id) throw new Error('Wrong "id" parameter')

    const exec = await ChannelExecution.applyScope(context).findByPk(id)
    if (!exec) {
        logger.error('Failed to find execution by id: ' + id + ', user: ' + context.getCurrentUser()!.login + ", tenant: " + context.getCurrentUser()!.tenantId)
        res.status(400).send('Failed to find image')
        return
    }

    const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
    const chan = mng.getChannels().find( chan => chan.id === exec.channelId)
    if (!chan) {
        logger.error('Failed to find channel by id: ' + exec.channelId + ', tenant: ' + mng.getTenantId())
        res.status(400).send('Failed to find image')
        return
    }
    if (!context.canEditChannel(chan.identifier) || chan.tenantId !== context.getCurrentUser()?.tenantId) {
        logger.error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to download the file ' + id + ' from channel, tenant: ' + context.getCurrentUser()!.tenantId)
        res.status(400).send('Failed to find image')
        return
    }

    if (!exec.storagePath) {
        logger.error('Failed to find image for item by id: ' + id + ', user: ' + context.getCurrentUser()!.login + ", tenant: " + context.getCurrentUser()!.tenantId)
        res.status(400).send('Failed to find image')
        return
    }

    const hdrs:any = {
        'Content-Type': chan.config.mime ? chan.config.mime : "application/octet-stream"
    }
    hdrs['Content-Disposition'] = chan.config.file ? contentDisposition(chan.config.file) : 'attachment; filename="result.bin"'
    res.sendFile(process.env.FILES_ROOT! + exec.storagePath, {headers: hdrs})
}

export async function processDownload(context: Context, req: Request, res: Response, thumbnail: boolean) {
    const idStr = req.params.id
    const inline = req.query.inline
    const id = parseInt(idStr)
    if (!id) throw new Error('Wrong "id" parameter')

    const item = await Item.findByPk(id)
    if (!item) {
        logger.error('Failed to find item by id: ' + id + ', user: ' + context.getCurrentUser()?.login + ", tenant: " + context.getCurrentUser()?.tenantId)
        res.status(400).send('Failed to find image')
        return
    }

    const mng = ModelsManager.getInstance().getModelManager(item.tenantId)
    const type:Type = mng.getTypeById(item.typeId)?.getValue()
    const skipAuth = type.options.some((elem:any) => elem.name === 'directUrl' && elem.value === 'true')

    if (!skipAuth) {
        context.checkAuth()
          if (!context.canViewItem(item)) {
            logger.error('User :' + context.getCurrentUser()?.login + ' can not view item (asset download) :' + item.id + ', tenant: ' + context.getCurrentUser()!.tenantId)
            res.status(400).send('You do not have permissions to view this item')
            return
        }
    }

    if (!item.storagePath) {
        logger.error('Failed to find image for item by id: ' + id + ', user: ' + context.getCurrentUser()?.login + ", tenant: " + context.getCurrentUser()?.tenantId)
        res.status(400).send('Failed to find image')
        return
    }

    const hdrs:any = {
        'Content-Type': item.mimeType
    }
    if (!thumbnail && inline === undefined) {
        hdrs['Content-Disposition'] = contentDisposition(item.fileOrigName)

    }
    res.sendFile(process.env.FILES_ROOT! + item.storagePath + (thumbnail ? '_thumb.jpg': ''), {headers: hdrs})
}

export async function processUpload(context: Context, req: Request, res: Response) {
    const form = new IncomingForm({maxFileSize: 500*1024*1024, keepExtensions: true})
 
    form.parse(req, async (err, fields, files) => {
        try {
            if (err) {
                logger.error(err)
                res.status(400).send(err)
                return
            }

            context.checkAuth();

            let idStr =  <string>fields['id']
            if (!idStr) { //try to find id as file
                const tst = <File>files['id']
                if (tst) {
                    const tst2 = fs.readFileSync(tst.filepath, {encoding:'utf8'})
                    if (tst2) idStr = tst2.trim()
                }
            }
            if (!idStr) throw new Error('Failed to find "id" parameter')

            const file = <File>files['file']
            if (!file) throw new Error('Failed to find "file" parameter')

            const id = parseInt(idStr)

            const item = await Item.applyScope(context).findByPk(id)
            if (!item) throw new Error('Failed to find item by id: ' + id + ', user: ' + context.getCurrentUser()!.login + ", tenant: " + context.getCurrentUser()!.tenantId)

            if (!context.canEditItem(item)) {
                throw new Error('User :' + context.getCurrentUser()?.login + ' can not edit item (asset upload) :' + item.id + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }
        
            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
            const type = mng.getTypeById(item.typeId)?.getValue()
            if (!type!.file) throw new Error('Item with id: ' + id + ' is not a file, user: ' + context.getCurrentUser()!.login + ", tenant: " + context.getCurrentUser()!.tenantId)

            const fm = FileManager.getInstance()
            await fm.saveFile(context.getCurrentUser()!.tenantId, item, file)

            const mimeOld = item.mimeType
            const fileOld = item.fileOrigName

            item.fileOrigName = file.originalFilename || ''
            item.mimeType = file.mimetype || ''
            item.updatedBy = context.getCurrentUser()!.login
            await sequelize.transaction(async (t) => {
                await item.save({transaction: t})
            })

            if (audit.auditEnabled()) {
                const itemChanges: AuditItem = {
                    changed: {
                        mimeType: '',
                        fileOrigName: ''
                    },
                    old: {
                        mimeType: mimeOld,
                        fileOrigName: fileOld
                    }
                }
                audit.auditItem(ChangeType.UPDATE, item.id, item.identifier, itemChanges, context.getCurrentUser()!.login, item.updatedAt)
            }

            res.send(JSON.stringify(item))
        } catch (error) {
            logger.error(error)
            res.status(400).send(error.message)
        }
    });
}

export async function processCreateUpload(context: Context, req: Request, res: Response) {
    const form = new IncomingForm({maxFileSize: 500*1024*1024, keepExtensions: true})
 
    form.parse(req, async (err, fields, files) => {
        try {
            if (err) {
                logger.error(err)
                res.status(400).send(err)
                return
            }
            context.checkAuth();

            // file, fileItemTypeId, parentId, relationId
            const file = <File>files['file']
            const itemIdStr =  <string>fields['itemId']
            const fileItemTypeIdStr =  <string>fields['fileItemTypeId']
            const parentIdStr =  <string>fields['parentId']
            const relationIdStr =  <string>fields['relationId']
            const lang = <string>fields['lang']
            const fileName = <string>fields['fileName']
            const fileIdentifier = <string>fields['fileIdentifier']

            if (!file) throw new Error('Failed to find "file" parameter')
            if (!itemIdStr) throw new Error('Failed to find "itemId" parameter')
            if (!fileItemTypeIdStr) throw new Error('Failed to find "fileItemTypeId" parameter')
            if (!parentIdStr) throw new Error('Failed to find "parentId" parameter')
            if (!relationIdStr) throw new Error('Failed to find "relationId" parameter')
            if (!lang) throw new Error('Failed to find "lang" parameter')
            if (!fileName) throw new Error('Failed to find "fileName" parameter')
            if (!fileIdentifier) throw new Error('Failed to find "fileIdentifier" parameter')

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

            // *** create file item ***
            const tmp = mng.getTypeById(parseInt(fileItemTypeIdStr))
            if (!tmp) throw new Error('Failed to find type by id: ' + fileItemTypeIdStr)
            const fileItemType = <Type>tmp!.getValue()

            // TODO: do we need to check if we have such item already?
            const fileItemIdent = fileIdentifier

            let results:any = await sequelize.query("SELECT nextval('items_id_seq')", { 
                type: QueryTypes.SELECT
            });
            const id = (results[0]).nextval
            
            let path:string
            let parentIdentifier:string
            const pId = parseInt(parentIdStr)
            const parentItem = await Item.applyScope(context).findByPk(pId)
            if (!parentItem) {
                throw new Error('Failed to find parent item by id: ' + parentIdStr + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }
            const parentType = mng.getTypeById(parentItem.typeId)!
            const tstType = parentType.getChildren().find(elem => (elem.getValue().id === fileItemType.id) || (elem.getValue().link === fileItemType.id))
            if (!tstType) {
                throw new Error('Failed to create item with type: ' + fileItemType.id + ' under type: ' + parentItem.typeId + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }
            parentIdentifier = parentItem.identifier
            path = parentItem.path + "." + id
            if (!context.canEditItem2(fileItemType.id, path)) {
                throw new Error('User :' + context.getCurrentUser()?.login + ' can not create such item , tenant: ' + context.getCurrentUser()!.tenantId)
            }
            const name:any = {}
            name[lang] = fileName || file.originalFilename || ''

            const item:Item = Item.build ({
                id: id,
                path: path,
                identifier: fileItemIdent,
                tenantId: context.getCurrentUser()!.tenantId,
                createdBy: context.getCurrentUser()!.login,
                updatedBy: context.getCurrentUser()!.login,
                name: name,
                typeId: fileItemType.id,
                typeIdentifier: fileItemType.identifier,
                parentIdentifier: parentIdentifier, 
                values: {},
                channels: {},
                fileOrigName: '',
                storagePath: '',
                mimeType: ''
            })

            const values = {}
            await processItemActions(context, EventType.BeforeCreate, item, parentIdentifier, name, values, item.channels, false)
            filterValues(context.getEditItemAttributes2(parentItem.typeId, path), values)
            checkValues(mng, values)
            item.values = values

            // *** upload file ***
            const type = mng.getTypeById(item.typeId)?.getValue()
            if (!type!.file) throw new Error('Item with id: ' + id + ' is not a file, user: ' + context.getCurrentUser()!.login + ", tenant: " + context.getCurrentUser()!.tenantId)

            const fm = FileManager.getInstance()
            await fm.saveFile(context.getCurrentUser()!.tenantId, item, file)

            item.fileOrigName = file.originalFilename || ''
            item.mimeType = file.mimetype || ''
            item.updatedBy = context.getCurrentUser()!.login
            console.log(item)
            await sequelize.transaction(async (t) => {
                await item.save({transaction: t})
            })

            await processItemActions(context, EventType.AfterCreate, item, item.parentIdentifier, item.name, item.values, item.channels, false)

            if (audit.auditEnabled()) {
                const itemChanges: AuditItem = {
                    added: {
                        mimeType: file.mimetype || '',
                        fileOrigName: file.originalFilename || ''
                    }
                }
                audit.auditItem(ChangeType.CREATE, item.id, item.identifier, itemChanges, context.getCurrentUser()!.login, item.updatedAt)
            }


            // *** create link to item ***
            const rel = mng.getRelationById(parseInt(relationIdStr))
            if (!rel) throw new Error('Failed to find relation by id: ' + relationIdStr)

            if (!context.canEditItemRelation(rel.id)) {
                throw new Error('User :' + context.getCurrentUser()?.login + ' can not edit item relation:' + rel.id + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }

            const nItemId = parseInt(itemIdStr)
            const source = await Item.applyScope(context).findByPk(nItemId)
            if (!source) {
                throw new Error('Failed to find item by id: ' + itemIdStr + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }

            const relIdent = source.identifier + "_" + fileItemIdent

            const tst3 = rel.targets.find((typeId: number) => typeId === item.typeId)
            if (!tst3) {
                throw new Error('Relation with id: ' + rel.id + ' can not have target with type: ' + item.typeId + ', tenant: ' + mng.getTenantId())
            }

            if (!rel.multi) {
                const count = await ItemRelation.applyScope(context).count( {
                    where: {
                        itemId: nItemId,
                        relationId: rel.id
                    }
                })

                if (count > 0) {
                    throw new Error('Relation with id: ' + rel.id + ' can not have more then one target, tenant: ' + mng.getTenantId())
                }
            }

            // TODO: process item relation actions
            const itemRelation = await ItemRelation.build ({
                identifier: relIdent,
                tenantId: context.getCurrentUser()!.tenantId,
                createdBy: context.getCurrentUser()!.login,
                updatedBy: context.getCurrentUser()!.login,
                relationId: rel.id,
                relationIdentifier: rel.identifier,
                itemId: nItemId,
                itemIdentifier: source.identifier,
                targetId: item.id,
                targetIdentifier: item.identifier,
                values: {}
            })

            await sequelize.transaction(async (t) => {
                await itemRelation.save({transaction: t})
            })

            if (audit.auditEnabled()) {
                const itemRelationChanges: ItemRelationChanges = {
                    relationIdentifier: itemRelation.relationIdentifier,
                    itemIdentifier: itemRelation.itemIdentifier,
                    targetIdentifier: itemRelation.targetIdentifier,
                    values: itemRelation.values
                }
                audit.auditItemRelation(ChangeType.CREATE, itemRelation.id, itemRelation.identifier, {added: itemRelationChanges}, context.getCurrentUser()!.login, itemRelation.createdAt)
            }

            res.send('OK')
        } catch (error) {
            logger.error(error)
            res.status(400).send(error.message)
        }
    });
}