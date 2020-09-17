import Context from '../context'
import { sequelize } from '../models'
import { QueryTypes } from 'sequelize'
import { Item } from '../models/items'
import {  ModelsManager } from '../models/manager'
import { filterValues, mergeValues, checkValues, processItemActions } from './utils'
import { FileManager } from '../media/FileManager'
import { Type } from '../models/types'
import { Attribute } from '../models/attributes'
import { Op } from 'sequelize'
import { EventType } from '../models/actions'

export default {
    Query: {
        getItems: async (parent: any, { parentId, offset, limit  }: any, context: Context) => {
            context.checkAuth()
            let items: Item[]
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
                items = await sequelize.query('SELECT * FROM items where "deletedAt" IS NULL and "tenantId"=:tenant and nlevel(path) = 1 order by id limit :limit offset :offset', {
                    replacements: { 
                        tenant: context.getCurrentUser()!.tenantId,
                        offset: offset,
                        limit: limit === -1 ? null : limit
                    },
                    model: Item,
                    mapToModel: true
                })
            } else {
                const pId = parseInt(parentId)

                const parentItem = await Item.applyScope(context).findByPk(pId)
                if (!parentItem) {
                    throw new Error('Failed to find parent item by id: ' + parentId + ', tenant: ' + context.getCurrentUser()!.tenantId)
                }
                
                cnt = await sequelize.query('SELECT count(*) FROM items where "deletedAt" IS NULL and "tenantId"=:tenant and path~:lquery', {
                    replacements: { 
                        tenant: context.getCurrentUser()!.tenantId,
                        lquery: parentItem.path + '.*{1}',
                    },
                    plain: true,
                    raw: true,
                    type: QueryTypes.SELECT
                })
                items = await sequelize.query('SELECT * FROM items where "deletedAt" IS NULL and "tenantId"=:tenant and path~:lquery limit :limit offset :offset', {
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
            })

            return { count: parseInt(cnt.count), rows: (items || []) }
        },
        getItem: async (parent: any, { id }: any, context: Context) => {
            context.checkAuth()

            const item = await Item.applyScope(context).findByPk(parseInt(id))
            if (item && context.canViewItem(item)) {
                const allowedAttributes = context.getViewItemAttributes(item)
                filterValues(allowedAttributes, item.values)
                return item
            } else {
                return null
            }
        },
        getItemsByIds: async (parent: any, { ids }: any, context: Context) => {
            context.checkAuth()
            const arr = ids.map((elem:any) => parseInt(elem))
            let items = await Item.applyScope(context).findAll({ where: { id: arr} })
            items = items.filter(item => context.canViewItem(item))

            items.forEach(item => {   
                const allowedAttributes = context.getViewItemAttributes(item)
                filterValues(allowedAttributes, item.values)
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
                    `SELECT a."id", a."identifier", ir."relationId", a."mimeType", a."fileOrigName"
                        FROM "items" a, "itemRelations" ir, "types" t where 
                        a."tenantId"=:tenant and 
                        ir."itemId"=:itemId and
                        a."id"=ir."targetId" and
                        a."typeId"=t."id" and
                        t."file"=true and
                        coalesce(a."storagePath", '') != '' and
                        ir."deletedAt" is null and
                        a."deletedAt" is null
                        order by a.id`, {
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
                    order by asset.id`, {
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
        createItem: async (parent: any, { parentId, identifier, name, typeId, values }: any, context: Context) => {
            context.checkAuth()
            if (!/^[A-Za-z0-9_]*$/.test(identifier)) throw new Error('Identifier must not has spaces and must be in English only: ' + identifier + ', tenant: ' + context.getCurrentUser()!.tenantId)

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
                fileOrigName: '',
                storagePath: '',
                mimeType: ''
            })

            if (!values) values = {}

            await processItemActions(context, EventType.BeforeCreate, item, values, false)

            filterValues(context.getEditItemAttributes2(nTypeId, path), values)
            checkValues(mng, values)

            item.values = values

            await sequelize.transaction(async (t) => {
                await item.save({transaction: t})
            })

            await processItemActions(context, EventType.AfterCreate, item, values, false)

            return item.id
        },
        updateItem: async (parent: any, { id, name, values }: any, context: Context) => {
            context.checkAuth()
            const nId = parseInt(id)

            const item = await Item.applyScope(context).findByPk(nId)
            if (!item) {
                throw new Error('Failed to find item by id: ' + nId + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }

            if (!context.canEditItem(item)) {
                throw new Error('User :' + context.getCurrentUser()?.login + ' can not edit item :' + item.id + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }

            if (name) item.name = name
            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
            item.updatedBy = context.getCurrentUser()!.login

            await processItemActions(context, EventType.BeforeUpdate, item, values, false)

            if (values) {
                filterValues(context.getEditItemAttributes(item), values)
                checkValues(mng, values)
                item.values = mergeValues(values, item.values)
            }
            await sequelize.transaction(async (t) => {
                await item.save({transaction: t})
            })

            await processItemActions(context, EventType.AfterUpdate, item, values, false)
            return item.id
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

            await processItemActions(context, EventType.BeforeDelete, item, null, false)

            item.updatedBy = context.getCurrentUser()!.login

            // we have to change identifier during deletion to make possible that it will be possible to make new type with same identifier
            item.identifier = item.identifier + '_d_' + Date.now() 
            await sequelize.transaction(async (t) => {
                await item.save({transaction: t})
                await item.destroy({transaction: t})
            })

            await processItemActions(context, EventType.AfterDelete, item, null, false)
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

            item.mimeType = ''
            item.fileOrigName = ''

            item.updatedBy = context.getCurrentUser()!.login
            await sequelize.transaction(async (t) => {
                await item.save({transaction: t})
            })

            return true
        }
    }
}