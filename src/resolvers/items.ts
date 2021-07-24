import Context from '../context'
import { sequelize } from '../models'
import { QueryTypes, Utils } from 'sequelize'
import { Item } from '../models/items'
import {  ModelsManager } from '../models/manager'
import { filterValues, filterChannels, mergeValues, checkValues, processItemActions, diff, isObjectEmpty, filterEditChannels, checkSubmit } from './utils'
import { FileManager } from '../media/FileManager'
import { Type } from '../models/types'
import { Attribute } from '../models/attributes'
import { Op } from 'sequelize'
import { EventType } from '../models/actions'
import { ItemRelation } from '../models/itemRelations'

import audit from '../audit'
import { ChangeType, ItemChanges, AuditItem } from '../audit'


function generateOrder(order: string[][]) {
    if (!order) return 'id ASC'

    let result = ''
    for (let i = 0; i < order.length; i++) {
        const arr = order[i]
        const field = arr[0]
        const idx = field.indexOf('.')
        if (idx !== -1) {
            result = field.substring(0, idx)+"->'"+field.substring(idx+1)+"'"
        } else {
            result = field
        }
        result += " " + arr[1]

        if (i !== order.length-1) result += ', '
    }
    if (result.length === 0){
        result = 'id ASC'
    }
    return result
}

export default {
    ItemsResponse: {
        count: async ({ parentId, context, parentItem }: any) => {
            let cnt = {count: '0'}
            if (!parentId) {
                cnt = await sequelize.query('SELECT count(*) FROM items where "deletedAt" IS NULL and "tenantId"=:tenant and nlevel(path) = 1', {
                    replacements: {
                        tenant: context.getCurrentUser()!.tenantId,
                    },
                    plain: true,
                    raw: true,
                    type: QueryTypes.SELECT
                })
            } else {
                cnt = await sequelize.query('SELECT count(*) FROM items where "deletedAt" IS NULL and "tenantId"=:tenant and path~:lquery', {
                    replacements: { 
                        tenant: context.getCurrentUser()!.tenantId,
                        lquery: parentItem.path + '.*{1}',
                    },
                    plain: true,
                    raw: true,
                    type: QueryTypes.SELECT
                })
            }
            return parseInt(cnt.count)
        },
        rows: async ({ parentId, offset, limit, orderSql, context, parentItem }: any) => {
            let items: Item[]
            if (!parentId) {
                items = await sequelize.query('SELECT * FROM items where "deletedAt" IS NULL and "tenantId"=:tenant and nlevel(path) = 1 order by '+orderSql+' limit :limit offset :offset', {
                    replacements: { 
                        tenant: context.getCurrentUser()!.tenantId,
                        offset: offset,
                        limit: limit === -1 ? null : limit
                    },
                    model: Item,
                    mapToModel: true
                })
            } else {
                items = await sequelize.query('SELECT * FROM items where "deletedAt" IS NULL and "tenantId"=:tenant and path~:lquery order by '+orderSql+' limit :limit offset :offset', {
                    replacements: { 
                        tenant: context.getCurrentUser()!.tenantId,
                        lquery: parentItem.path + '.*{1}',
                        offset: offset,
                        limit: limit === -1 ? null : limit
                    },
                    model: Item,
                    mapToModel: true
                })
            }

            items = items.filter(item => context.canViewItem(item))

            items.forEach(item => {   
                const allowedAttributes = context.getViewItemAttributes(item)
                filterValues(allowedAttributes, item.values)
                filterChannels(context, item.channels)
            })
            return items || []
        }
    },
    Query: {
        getItems: async (parent: any, params: any, context: Context) => {
            context.checkAuth()
            params.orderSql = generateOrder(params.order)
            params.context = context

            if (params.parentId) {
                const pId = parseInt(params.parentId)

                const parentItem = await Item.applyScope(context).findByPk(pId)
                if (!parentItem) {
                    throw new Error('Failed to find parent item by id: ' + params.parentId + ', tenant: ' + context.getCurrentUser()!.tenantId)
                }

                params.parentItem = parentItem
            }

            return params
        },
        getItem: async (parent: any, { id }: any, context: Context) => {
            context.checkAuth()

            const item = await Item.applyScope(context).findByPk(parseInt(id))
            if (item && context.canViewItem(item)) {
                const allowedAttributes = context.getViewItemAttributes(item)
                filterValues(allowedAttributes, item.values)
                filterChannels(context, item.channels)
                return item
            } else {
                return null
            }
        },
        hasRelations: async (parent: any, { id }: any, context: Context) => {
            context.checkAuth()
            const nId = parseInt(id)
            const num = await ItemRelation.applyScope(context).count({
                where: {
                    [Op.or]: [{itemId: nId}, {targetId: nId}]
                },
            })
            return (num > 0)
        },
        getItemsByIds: async (parent: any, { ids }: any, context: Context) => {
            context.checkAuth()
            const arr = ids.map((elem:any) => parseInt(elem))
            let items = await Item.applyScope(context).findAll({ where: { id: arr} })
            items = items.filter(item => context.canViewItem(item))
 
            items.forEach(item => {   
                const allowedAttributes = context.getViewItemAttributes(item)
                filterValues(allowedAttributes, item.values)
                filterChannels(context, item.channels)
            })

            // DB can return data in different order then we send to it, so we need to order it
            items.sort(function (a, b) {
                return arr.indexOf(a.id) - arr.indexOf(b.id)
            })

            return items
        },
        getItemByIdentifier: async (parent: any, { identifier }: any, context: Context) => {
            context.checkAuth()
            const item = await Item.applyScope(context).findOne({
                where: {
                    identifier: identifier
                }
            })
            if (item && context.canViewItem(item)) {
                const allowedAttributes = context.getViewItemAttributes(item)
                filterValues(allowedAttributes, item.values)
                filterChannels(context, item.channels)
                return item
            } else {
                return null
            }
        },
        getAssets: async (parent: any, { id }: any, context: Context) => {
            context.checkAuth()

            const item = await Item.applyScope(context).findByPk(parseInt(id))
            if (item && context.canViewItem(item)) {
                const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
                const type:Type = mng.getTypeById(item.typeId)?.getValue()
                
                // const relIds = type.images ? type.images.slice(0) : []
                // if (type.mainImage) relIds.push(type.mainImage)

                const data: any[] = await sequelize.query(
                    `SELECT a."id", a."name", a."identifier", ir."relationId", a."mimeType", a."fileOrigName"
                        FROM "items" a, "itemRelations" ir, "types" t, "relations" r where 
                        a."tenantId"=:tenant and 
                        ir."itemId"=:itemId and
                        a."id"=ir."targetId" and
                        a."typeId"=t."id" and
                        t."file"=true and
                        ir."relationId"=r."id" and
                        coalesce(a."storagePath", '') != '' and
                        ir."deletedAt" is null and
                        a."deletedAt" is null and 
                        r."deletedAt" is null
                        order by r.order, a.id`, {
                    replacements: { 
                        tenant: context.getCurrentUser()!.tenantId,
                        itemId: item.id
                    },
                    type: QueryTypes.SELECT
                })
                const res = data.map(elem => { 
                    return {
                        id: elem.id, 
                        identifier: elem.identifier,
                        name: elem.name,
                        mimeType: elem.mimeType,
                        fileOrigName: elem.fileOrigName,
                        mainImage: type.mainImage === elem.relationId, 
                        image: type.images.includes(elem.relationId) }
                })
                return res
            } else {
                return null
            }
        },
        getMainImages: async (parent: any, { ids }: any, context: Context) => {
            context.checkAuth()
            const arr = ids.map((elem:any) => parseInt(elem))

            const data: any[] = await sequelize.query(
                `SELECT distinct item."id" as "itemId", asset."id", asset."identifier"
                    FROM "items" item, "items" asset, "itemRelations" ir, "types" itemType, "types" assetType where 
                    item."tenantId"=:tenant and 
                    item."id" in (:ids) and
                    item."typeId"=itemType."id" and
                    ir."itemId"=item."id" and
                    asset."id"=ir."targetId" and
                    asset."typeId"=assetType."id" and
                    ir."relationId"=itemType."mainImage" and
                    assetType."file"=true and
                    coalesce(asset."storagePath", '') != '' and
                    ir."deletedAt" is null and
                    asset."deletedAt" is null and
                    item."deletedAt" is null
                UNION SELECT item."id" as "itemId", item."id", item."identifier" FROM "items" item where 
                    item."id" in (:ids) and
                    item."storagePath" is not null and
                    item."storagePath" != '' and
                    item."mimeType" like 'image/%' and
                    item."deletedAt" is null
                    `, {
                replacements: { 
                    tenant: context.getCurrentUser()!.tenantId,
                    ids: ids
                },
                type: QueryTypes.SELECT
            })
            return data
        }        
    },
    Mutation: {
        createItem: async (parent: any, { parentId, identifier, name, typeId, values, channels}: any, context: Context) => {
            context.checkAuth()
            if (!/^[A-Za-z0-9_-]*$/.test(identifier)) throw new Error('Identifier must not has spaces and must be in English only: ' + identifier + ', tenant: ' + context.getCurrentUser()!.tenantId)

            const tst = await Item.applyScope(context).findOne({
                where: {
                    identifier: identifier
                }
            })
            if (tst) {
                throw new Error('Identifier: ' + identifier + ' already exists, tenant: ' + context.getCurrentUser()!.tenantId)
            }

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
            const nTypeId = parseInt(typeId)
            const type = mng.getTypeById(nTypeId)
            if (!type) {
                throw new Error('Failed to find type by id: ' + nTypeId + ', tenant: ' + mng.getTenantId())
            }

            const results:any = await sequelize.query("SELECT nextval('items_id_seq')", { 
                type: QueryTypes.SELECT
            });
            const id = (results[0]).nextval
            
            let path:string
            let parentIdentifier:string
            if (parentId) {
                const pId = parseInt(parentId)
                const parentItem = await Item.applyScope(context).findByPk(pId)
                if (!parentItem) {
                    throw new Error('Failed to find parent item by id: ' + parentId + ', tenant: ' + context.getCurrentUser()!.tenantId)
                }

                const parentType = mng.getTypeById(parentItem.typeId)!
                const tstType = parentType.getChildren().find(elem => (elem.getValue().id === nTypeId) || (elem.getValue().link === nTypeId))
                if (!tstType) {
                    throw new Error('Failed to create item with type: ' + nTypeId + ' under type: ' + parentItem.typeId + ', tenant: ' + context.getCurrentUser()!.tenantId)
                }

                parentIdentifier = parentItem.identifier
                path = parentItem.path + "." + id
            } else {
                const tstType = mng.getRoot().getChildren().find(elem => elem.getValue().id === nTypeId)
                if (!tstType) {
                    throw new Error('Failed to create root item with type: ' + nTypeId + ', tenant: ' + context.getCurrentUser()!.tenantId)
                }

                parentIdentifier = ''
                path = '' + id
            }

            if (!context.canEditItem2(nTypeId, path)) {
                throw new Error('User :' + context.getCurrentUser()?.login + ' can not create such item , tenant: ' + context.getCurrentUser()!.tenantId)
            }

            const item = Item.build ({
                id: id,
                path: path,
                identifier: identifier,
                tenantId: context.getCurrentUser()!.tenantId,
                createdBy: context.getCurrentUser()!.login,
                updatedBy: context.getCurrentUser()!.login,
                name: name,
                typeId: nTypeId,
                typeIdentifier: type.getValue().identifier,
                parentIdentifier: parentIdentifier, 
                values: null,
                channels: null,
                fileOrigName: '',
                storagePath: '',
                mimeType: ''
            })

            if (!values) values = {}

            await processItemActions(context, EventType.BeforeCreate, item, values, channels, false)

            filterEditChannels(context, channels)
            checkSubmit(context, channels)

            filterValues(context.getEditItemAttributes2(nTypeId, path), values)
            checkValues(mng, values)

            item.values = values
            item.channels = channels

            await sequelize.transaction(async (t) => {
                await item.save({transaction: t})
            })

            await processItemActions(context, EventType.AfterCreate, item, values, channels, false)

            if (audit.auditEnabled()) {
                const itemChanges: ItemChanges = {
                    typeIdentifier: item.typeIdentifier,
                    parentIdentifier: item.parentIdentifier,
                    name: item.name,
                    values: values
                }
                audit.auditItem(ChangeType.CREATE, item.id, item.identifier, {added: itemChanges}, context.getCurrentUser()!.login, item.createdAt)
            }

            return item.id
        },
        updateItem: async (parent: any, { id, name, values, channels }: any, context: Context) => {
            context.checkAuth()
            const nId = parseInt(id)

            const item = await Item.applyScope(context).findByPk(nId)
            if (!item) {
                throw new Error('Failed to find item by id: ' + nId + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }

            if ((name || values) && !context.canEditItem(item)) {
                throw new Error('User :' + context.getCurrentUser()?.login + ' can not edit item :' + item.id + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
            item.updatedBy = context.getCurrentUser()!.login

            await processItemActions(context, EventType.BeforeUpdate, item, values, channels, false)

            let itemDiff: AuditItem
            if (channels) {
                filterEditChannels(context, channels)
                checkSubmit(context, channels)
                item.channels = mergeValues(channels, item.channels)
            }
            if (values) {
                filterValues(context.getEditItemAttributes(item), values)
                checkValues(mng, values)
                if (audit.auditEnabled()) itemDiff = diff({name: item.name, values: item.values}, {name: name, values: values})
                item.values = mergeValues(values, item.values)
            } else {
                if (audit.auditEnabled()) itemDiff = diff({name: item.name}, {name: name})
            }

            if (name) item.name = name
            await sequelize.transaction(async (t) => {
                await item.save({transaction: t})
            })

            await processItemActions(context, EventType.AfterUpdate, item, values, channels, false)

            if (audit.auditEnabled()) {
                if (!isObjectEmpty(itemDiff!.added) || !isObjectEmpty(itemDiff!.changed) || !isObjectEmpty(itemDiff!.deleted)) audit.auditItem(ChangeType.UPDATE, item.id, item.identifier, itemDiff!, context.getCurrentUser()!.login, item.updatedAt)
            }

            return item.id
        },
        moveItem: async (parent: any, { id, parentId }: any, context: Context) => {
            context.checkAuth()
            const nId = parseInt(id)
            const nparentId = parseInt(parentId)

            const item = await Item.applyScope(context).findByPk(nId)
            if (!item) {
                throw new Error('Failed to find item by id: ' + nId + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }

            const parentItem = await Item.applyScope(context).findByPk(nparentId)
            if (!parentItem) {
                throw new Error('Failed to find item by id: ' + nparentId + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }

            if (!context.canEditItem(item)) {
                throw new Error('User :' + context.getCurrentUser()?.login + ' can not edit item :' + item.id + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }

            // check children
            const cnt:any = await sequelize.query('SELECT count(*) FROM items where "deletedAt" IS NULL and "tenantId"=:tenant and path~:lquery', {
                replacements: { 
                    tenant: context.getCurrentUser()!.tenantId,
                    lquery: item.path + '.*{1}',
                },
                plain: true,
                raw: true,
                type: QueryTypes.SELECT
            })
            const childrenNumber = parseInt(cnt.count)
            if (childrenNumber > 0) throw new Error('Can not move item with children, remove children first.');

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
            const parentType = mng.getTypeById(parentItem.typeId)!
            const itemType = mng.getTypeByIdentifier(item.typeIdentifier)!
    
            const tstType = parentType.getChildren().find(elem => (elem.getValue().identifier === item.typeIdentifier) || (elem.getValue().link === itemType.getValue().id))
            if (!tstType) throw new Error('Can not move this item to this parent because this is not allowed by data model.');

            let newPath = parentItem.path+"."+item.id
            if (newPath !== item.path) {
                item.path = newPath
                const old = item.parentIdentifier
                item.parentIdentifier = parentItem.identifier;

                await sequelize.transaction(async (t) => {
                    await item.save({transaction: t})
                })

                if (audit.auditEnabled()) {
                    const itemDiff: AuditItem = {changed: {parentIdentifier: parentItem.identifier}, old: {parentIdentifier: old}}
                    audit.auditItem(ChangeType.UPDATE, item.id, item.identifier, itemDiff, context.getCurrentUser()!.login, item.updatedAt)
                }
            }

            return item
        },
        removeItem: async (parent: any, { id }: any, context: Context) => {
            context.checkAuth()
            const nId = parseInt(id)

            const item = await Item.applyScope(context).findByPk(nId)
            if (!item) {
                throw new Error('Failed to find item by id: ' + nId + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }
            if (!context.canEditItem(item)) {
                throw new Error('User :' + context.getCurrentUser()?.login + ' can not edit item :' + item.id + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
            // check Roles
            const tst1 = mng.getRoles().find(role => role.itemAccess.fromItems.includes(nId))
            if (tst1) throw new Error('Can not remove this item because there are roles linked to it.');
            // check Attributes
            const tst2 = await Attribute.applyScope(context).findOne({where: {visible: { [Op.contains]: nId}}})
            if (tst2) throw new Error('Can not remove this item because there are attributes linked to it.');
            // check children
            const cnt:any = await sequelize.query('SELECT count(*) FROM items where "deletedAt" IS NULL and "tenantId"=:tenant and path~:lquery', {
                replacements: { 
                    tenant: context.getCurrentUser()!.tenantId,
                    lquery: item.path + '.*{1}',
                },
                plain: true,
                raw: true,
                type: QueryTypes.SELECT
            })
            const childrenNumber = parseInt(cnt.count)
            if (childrenNumber > 0) throw new Error('Can not remove item with children, remove children first.');
            // check relations
            const num = await ItemRelation.applyScope(context).count({
                where: {
                    [Op.or]: [{itemId: item.id}, {targetId: item.id}]
                },
            })
            if (num > 0) throw new Error('Can not remove item that has relations, remove them first.');

            await processItemActions(context, EventType.BeforeDelete, item, null, null, false)

            item.updatedBy = context.getCurrentUser()!.login

            // we have to change identifier during deletion to make possible that it will be possible to make new type with same identifier
            const oldIdentifier = item.identifier
            item.identifier = item.identifier + '_d_' + Date.now() 
            await sequelize.transaction(async (t) => {
                await item.save({transaction: t})
                await item.destroy({transaction: t})
            })

            if (item.storagePath) {
                const fm = FileManager.getInstance()
                await fm.removeFile(item)
            }

            await processItemActions(context, EventType.AfterDelete, item, null, null,false)

            if (audit.auditEnabled()) {
                const itemChanges: ItemChanges = {
                    typeIdentifier: item.typeIdentifier,
                    parentIdentifier: item.parentIdentifier,
                    name: item.name,
                    values: item.values
                }
                audit.auditItem(ChangeType.DELETE, item.id, oldIdentifier, {deleted: itemChanges}, context.getCurrentUser()!.login, item.updatedAt)
            }

            return true
        },
        removeFile: async (parent: any, { id }: any, context: Context) => {
            context.checkAuth()
            const nId = parseInt(id)

            const item = await Item.applyScope(context).findByPk(nId)
            if (!item) {
                throw new Error('Failed to find item by id: ' + nId + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }
            if (!context.canEditItem(item)) {
                throw new Error('User :' + context.getCurrentUser()?.login + ' can not edit item :' + item.id + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
            const type = mng.getTypeById(item.typeId)?.getValue()
            if (!type!.file) throw new Error('Item with id: ' + id + ' is not a file, user: ' + context.getCurrentUser()!.login + ", tenant: " + context.getCurrentUser()!.tenantId)

            if (!item.storagePath) return

            const fm = FileManager.getInstance()
            await fm.removeFile(item)

            const mimeOld = item.mimeType
            const fileOld = item.fileOrigName

            item.mimeType = ''
            item.fileOrigName = ''

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

            return true
        }
    }
}