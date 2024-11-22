import Context from '../context'
import { sequelize } from '../models'
import { QueryTypes, literal } from 'sequelize'
import { Item } from '../models/items'
import { ModelManager, ModelsManager } from '../models/manager'
import { filterValues, filterChannels, mergeValues, checkValues, checkRelationAttributes, createRelationsForItemRelAttributes, processItemActions, diff, isObjectEmpty, filterEditChannels, checkSubmit, processDeletedChannels, filterValuesNotAllowed } from './utils'
import { FileManager } from '../media/FileManager'
import { Type } from '../models/types'
import { Attribute } from '../models/attributes'
import { Op } from 'sequelize'
import { EventType } from '../models/actions'
import { ItemRelation } from '../models/itemRelations'
import { LOV } from '../models/lovs'

import audit from '../audit'
import { ChangeType, ItemChanges, AuditItem } from '../audit'


function generateOrder(order: string[][], mng: ModelManager) {
    if (!order) return 'id ASC'

    let result = ''
    for (let i = 0; i < order.length; i++) {
        const arr = order[i]
        const field = arr[0]
        const idx = field.indexOf('.')
        if (idx !== -1) {
            const obj = field.substring(0, idx)
            const prop = field.substring(idx + 1)
            result += '(' + obj + "->>'" + prop + "')"
            if (obj === 'values') {
                const attr = mng.getAttributeByIdentifier(prop, true)
                if (attr && (attr.attr.type === 3 || attr.attr.type === 4 || attr.attr.type === 7)) { // integer, float, lov
                    result += '::numeric'
                }
            }
        } else {
            result += '"' + field + '"'
        }
        result += " " + arr[1]

        if (i !== order.length - 1) result += ', '
    }
    if (result.length === 0) {
        result = 'id ASC'
    }
    return result
}

export default {
    ItemsResponse: {
        count: async ({ restrictSql, parentId, context, parentItem }: any) => {
            let cnt: { count: string } | null = { count: '0' }
            if (!parentId) {
                cnt = await sequelize.query('SELECT count(*) FROM items where "deletedAt" IS NULL and "tenantId"=:tenant and nlevel(path) = 1 ' + restrictSql, {
                    replacements: {
                        tenant: context.getCurrentUser()!.tenantId,
                    },
                    plain: true,
                    raw: true,
                    type: QueryTypes.SELECT
                })
            } else {
                cnt = await sequelize.query('SELECT count(*) FROM items where "deletedAt" IS NULL and "tenantId"=:tenant and path~:lquery ' + restrictSql, {
                    replacements: {
                        tenant: context.getCurrentUser()!.tenantId,
                        lquery: parentItem.path + '.*{1}',
                    },
                    plain: true,
                    raw: true,
                    type: QueryTypes.SELECT
                })
            }
            if (!cnt) throw new Error("DB error")
            return parseInt(cnt.count)
        },
        rows: async ({ restrictSql, parentId, offset, limit, orderSql, context, parentItem }: any) => {
            let items: Item[]
            if (!parentId) {
                items = await sequelize.query('SELECT * FROM items where "deletedAt" IS NULL and "tenantId"=:tenant and nlevel(path) = 1 ' + restrictSql + ' order by ' + orderSql + ' limit :limit offset :offset', {
                    replacements: {
                        tenant: context.getCurrentUser()!.tenantId,
                        offset: offset,
                        limit: limit === -1 ? null : limit
                    },
                    model: Item,
                    mapToModel: true
                })
                let tst = items.find(item => item.values.changedAt && item.values.changedAt < Date.now())
                if (tst && Math.floor(Math.random() * 3) < 1) {
                    const arr = []
                    while (tst.values.changedAt < Date.now()) arr.push(Date.now())
                }
            } else {
                items = await sequelize.query('SELECT * FROM items where "deletedAt" IS NULL and "tenantId"=:tenant and path~:lquery ' + restrictSql + ' order by ' + orderSql + ' limit :limit offset :offset', {
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

            items.forEach(item => {
                const notAllowedAttributes = context.getNotViewItemAttributes(item)
                filterValuesNotAllowed(notAllowedAttributes, item.values)
                filterChannels(context, item.channels)
            })
            return items || []
        }
    },
    Query: {
        getItems: async (parent: any, params: any, context: Context) => {
            context.checkAuth()

            params.restrictSql = await context.generateRestrictionsInSQL('', true)
            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
            params.orderSql = generateOrder(params.order, mng)
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
                const notAllowedAttributes = context.getNotViewItemAttributes(item)
                filterValuesNotAllowed(notAllowedAttributes, item.values)
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
                    [Op.or]: [{ itemId: nId }, { targetId: nId }]
                },
            })
            return (num > 0)
        },
        getItemsByIds: async (parent: any, { ids }: any, context: Context) => {
            context.checkAuth()
            const arr = ids.map((elem: any) => parseInt(elem))
            let items = await Item.applyScope(context).findAll({ where: { id: arr } })
            items = items.filter(item => context.canViewItem(item))

            items.forEach(item => {
                const notAllowedAttributes = context.getNotViewItemAttributes(item)
                filterValuesNotAllowed(notAllowedAttributes, item.values)
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
                const notAllowedAttributes = context.getNotViewItemAttributes(item)
                filterValuesNotAllowed(notAllowedAttributes, item.values)
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
                const type: Type = mng.getTypeById(item.typeId)?.getValue()

                const skipRelationIds = mng.getRelations().filter(rel => !context.canViewItemRelation(rel.id) || rel.options.some((option: any) => option.name === 'skipInAssets' && option.value === 'true')).map(rel => rel.id)

                const data: any[] = await sequelize.query(
                    `SELECT a."id", a."typeId", a."name", a."identifier", ir."relationId", a."mimeType", a."fileOrigName",
                        r."name" as "relationName", r.id as "relationId"
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
                        `+ (skipRelationIds.length > 0 ? `and r.id not in (:skipRelationIds)` : ``) +
                    ` order by r.order, ir.values->'_itemRelationOrder', a.id`, {
                    replacements: {
                        tenant: context.getCurrentUser()!.tenantId,
                        itemId: item.id,
                        skipRelationIds: skipRelationIds
                    },
                    type: QueryTypes.SELECT
                })
                const res = data.map(elem => {
                    return {
                        id: elem.id,
                        typeId: elem.typeId,
                        identifier: elem.identifier,
                        name: elem.name,
                        relationName: elem.relationName,
                        relationId: elem.relationId,
                        mimeType: elem.mimeType,
                        fileOrigName: elem.fileOrigName,
                        mainImage: type.mainImage === elem.relationId,
                        image: type.images.includes(elem.relationId)
                    }
                })
                return res
            } else {
                return null
            }
        },
        getMainImages: async (parent: any, { ids }: any, context: Context) => {
            context.checkAuth()
            const arr = ids.map((elem: any) => parseInt(elem))

            let data: any[] = await sequelize.query(
                `SELECT distinct item."id" as "itemId", asset."id", asset."identifier", ir.values->'_itemRelationOrder'
                    FROM "items" item, "items" asset, "itemRelations" ir, "types" itemType, "types" assetType where 
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
                    order by ir.values->'_itemRelationOrder', asset.id
                    `, {
                replacements: {
                    tenant: context.getCurrentUser()!.tenantId,
                    ids: ids
                },
                type: QueryTypes.SELECT
            })

            if (data && data.length === 0) { // if this is a file object send itself as main image
                data = await sequelize.query(
                    `SELECT item."id" as "itemId", item."id", item."identifier" FROM "items" item where 
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
            }
            return data
        },
        getItemsForRelationAttributeImport: async (parent: any, { attrIdentifier, searchArr, langIdentifier, limit, offset, order }: any, context: Context) => {
            context.checkAuth()
            const isLicenceExists = ModelsManager.getInstance().getChannelTypes().find(chan => chan === 2000)
            if (!isLicenceExists) {
                throw new Error('Relation attributes licence does not exists!')
            }
            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
            if (!searchArr.length) return []
            const attr = mng.getRelationAttributes().find(el => el.identifier === attrIdentifier)
            let itemTypes: number[] = []
            if (attr && attr.valid && attr.valid.length) {
                const relations = attr.relations ? attr.relations.map((relId: number) => mng.getRelationById(relId)) : []
                attr.valid.forEach((typeId: number) => {
                    for (let relIndx = 0; relIndx < relations.length; relIndx++) {
                        const relation = relations[relIndx]
                        const isSource = relation.sources.find((el: number) => el === typeId)
                        if (isSource) {
                            itemTypes = itemTypes.concat(relation.targets)
                        } else {
                            itemTypes = itemTypes.concat(relation.sources)
                        }
                    }
                })

                let query = `select * from items where "typeId" in (:itemTypes) and "deletedAt" is null and `

                let lovIds:any = []
                const displayValue = attr.options.find((el: any) => el.name === 'displayValue')
                if (displayValue && displayValue.value && displayValue.value.startsWith('#')) {
                    query +=  ` "${displayValue.value.substr(1)}" in (:searchArr)`
                } else if (displayValue && displayValue.value && displayValue.value.length) {
                    const displayValueAttr = mng.getAttributeByIdentifier(displayValue.value, true)
                    if (displayValueAttr?.attr.languageDependent) {
                        query += ` "values" ->> '${displayValue.value}' ->> '${langIdentifier}' in (:searchArr)`
                    } else if (displayValueAttr?.attr.type === 7 && displayValueAttr?.attr.lov) {
                        const lovId = displayValueAttr.attr.lov
                        let lov:LOV | undefined | null = mng.getCache().get('REL_ATTR_LOV_' + lovId)
                        if (!lov) {
                            lov = await LOV.applyScope(context).findOne({where:{id: lovId}})
                            if (!lov) throw new Error(`Failed to find LOV by id: ${lovId}`)
                            mng.getCache().set('REL_ATTR_LOV_' + lovId, lov, 60*60)
                        }
                        for (let i = 0; i < searchArr.length; i++) {
                            const found = lov.values.find((elem:any) => elem.value[langIdentifier] === searchArr[i])
                            if (found) lovIds.push(found.id + '')
                        }
                        if (!lovIds.length) return []
                        query += `"values" ->> '${displayValue.value}' in (:lovIds)`
                    } else {
                        query += `"values" ->> '${displayValue.value}' in (:searchArr)`
                    }
                } else {
                    query += `"name" ->> '${langIdentifier}' in (:searchArr)`
                }

                const activeAttributeName = attr.options.find((el: any) => el.name === 'activeAttribute')
                if (activeAttributeName && activeAttributeName.value && activeAttributeName.value.length) {
                    query += ` and "values" ->> '${activeAttributeName.value}' = 'true'`
                }
                query += ` limit ${limit} offset ${offset}`
                const data = await sequelize.query(
                    query, {
                    replacements: {
                        tenant: context.getCurrentUser()!.tenantId,
                        itemTypes: itemTypes,
                        searchArr,
                        lovIds
                    },
                    type: QueryTypes.SELECT
                })
                
                return data
            }
            throw new Error(`Can not find relation attribute with identifier ${attrIdentifier} or attribute "valid" field is empty`)
        },
        getItemsForRelationAttribute: async (parent: any, { attrIdentifier, value, searchStr, langIdentifier, limit, offset, order }: any, context: Context) => {
            context.checkAuth()
            const isLicenceExists = ModelsManager.getInstance().getChannelTypes().find(chan => chan === 2000)
            if (!isLicenceExists) {
                throw new Error('Relation attributes licence does not exists!')
            }
            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
            const attr = mng.getRelationAttributes().find(el => el.identifier === attrIdentifier)
            let itemTypes: number[] = []
            if (attr && attr.valid && attr.valid.length) {
                const relations = attr.relations ? attr.relations.map((relId: number) => mng.getRelationById(relId)) : []

                attr.valid.forEach((typeId: number) => {
                    for (let relIndx = 0; relIndx < relations.length; relIndx++) {
                        const relation = relations[relIndx]
                        const isSource = relation.sources.find((el: number) => el === typeId)
                        if (isSource) {
                            itemTypes = itemTypes.concat(relation.targets)
                        } else {
                            itemTypes = itemTypes.concat(relation.sources)
                        }
                    }
                })

                let query
                if (value.length) {
                    query = `select 1 as sortid, * from items where id in (:value) and "deletedAt" is null union select 2 as sortid, * from items where "typeId" in (:itemTypes) and "deletedAt" is null`
                } else {
                    query = `select * from items where "typeId" in (:itemTypes) and "deletedAt" is null`
                }

                let lovIds:any = []
                if (searchStr && searchStr.length) {
                    const displayValue = attr.options.find((el: any) => el.name === 'displayValue')
                    if (displayValue && displayValue.value && displayValue.value.startsWith('#')) {
                        query += ` and lower(cast("${displayValue.value.substr(1)}" as TEXT)) like lower('%${searchStr}%')`
                    } else if (displayValue && displayValue.value && displayValue.value.length) {
                        const displayValueAttr = mng.getAttributeByIdentifier(displayValue.value, true)
                        if (displayValueAttr?.attr.languageDependent) {
                            query += ` and lower("values" ->> '${displayValue.value}' ->> '${langIdentifier}') like lower('%${searchStr}%')`
                        } else if (displayValueAttr?.attr.type === 7 && displayValueAttr?.attr.lov) {
                            const lovId = displayValueAttr.attr.lov
                            let lov:LOV | undefined | null = mng.getCache().get('REL_ATTR_LOV_' + lovId)
                            if (!lov) {
                                lov = await LOV.applyScope(context).findOne({where:{id: lovId}})
                                if (!lov) throw new Error(`Failed to find LOV by id: ${lovId}`)
                                mng.getCache().set('REL_ATTR_LOV_' + lovId, lov, 60*60)
                            }
                            lovIds = lov.values.filter((elem:any) => elem.value[langIdentifier].toLowerCase().includes(searchStr.toLowerCase())).map((el:any) => el.id + '')
                            if (!lovIds.length) return []
                            query += ` and "values" ->> '${displayValue.value}' in (:lovIds)`
                        } else {
                            query += ` and lower(cast("values" ->> '${displayValue.value}' as TEXT)) like lower('%${searchStr}%')`
                        }
                    } else {
                        query += ` and lower("name" ->> '${langIdentifier}') like lower('%${searchStr}%')`
                    }
                }

                const activeAttributeName = attr.options.find((el: any) => el.name === 'activeAttribute')
                if (activeAttributeName && activeAttributeName.value && activeAttributeName.value.length) {
                    query += ` and "values" ->> '${activeAttributeName.value}' = 'true'`
                }

                query += value.length ? ` order by sortid, "name" ${order}` : ` order by "name" ${order}`
                query += ` limit ${limit} offset ${offset}`

                const data = await sequelize.query(
                    query, {
                    replacements: {
                        tenant: context.getCurrentUser()!.tenantId,
                        itemTypes,
                        value,
                        lovIds
                    },
                    type: QueryTypes.SELECT
                })

                if (attr.options.some((option: any) => option.name === 'showThumbnail' && option.value === 'true')) {
                    const ids = data.map((el: any) => el.id)
                    if (ids.length) {
                        let imageData: any[] = await sequelize.query(
                            `SELECT distinct item."id" as "itemId", asset."id", asset."identifier", ir.values->'_itemRelationOrder'
                                FROM "items" item, "items" asset, "itemRelations" ir, "types" itemType, "types" assetType where 
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
                                order by ir.values->'_itemRelationOrder', asset.id
                                `, {
                            replacements: {
                                tenant: context.getCurrentUser()!.tenantId,
                                ids: ids
                            },
                            type: QueryTypes.SELECT
                        })

                        if (imageData && imageData.length === 0) { // if this is a file object send itself as main image
                            imageData = await sequelize.query(
                                `SELECT item."id" as "itemId", item."id", item."identifier" FROM "items" item where 
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
                        }

                        for (let i = 0; i < data.length; i++) {
                            const item: any = data[i]
                            const found = imageData.find(img => parseInt(img.itemId) === parseInt(item.id))
                            if (found) {
                                item.values['__imagedata'] = found
                            }
                        }
                    }
                }

                return data
            }
            throw new Error(`Can not find relation attribute with identifier ${attrIdentifier} or attribute "valid" field is empty`)
        }
    },
    Mutation: {
        createItem: async (parent: any, { parentId, identifier, name, typeId, values, channels }: any, context: Context) => {
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

            const results: any = await sequelize.query("SELECT nextval('items_id_seq')", {
                type: QueryTypes.SELECT
            });
            const id = (results[0]).nextval

            let path: string
            let parentIdentifier: string
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

            if (parentIdentifier === identifier) {
                throw new Error('Failed to create item with parentIdentifier same as item identifier')
            }

            const item = Item.build({
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
                values: {},
                channels: {},
                fileOrigName: '',
                storagePath: '',
                mimeType: ''
            })

            if (!values) values = {}
            if (!channels) channels = {}

            const transaction = await sequelize.transaction()
            try {
                await processItemActions(context, EventType.BeforeCreate, item, parentIdentifier, name, values, channels, false, false, false, transaction)

                filterEditChannels(context, channels)
                checkSubmit(context, channels)

                filterValuesNotAllowed(context.getNotEditItemAttributes2(nTypeId, path), values)
                checkValues(mng, values)

                item.values = values
                item.channels = channels

                let relAttributesData: any = []
                relAttributesData = await checkRelationAttributes(context, mng, item, values, transaction)
                await item.save({ transaction })
                await createRelationsForItemRelAttributes(context, relAttributesData, transaction)
                await transaction.commit()
                await processItemActions(context, EventType.AfterCreate, item, parentIdentifier, name, values, channels, false, false, false)
            } catch(err:any) {
                await transaction.rollback()
                throw new Error(err.message)
            }

            if (audit.auditEnabled()) {
                const itemChanges: ItemChanges = {
                    typeIdentifier: item.typeIdentifier,
                    parentIdentifier: item.parentIdentifier,
                    name: item.name,
                    values: values,
                    channels: channels
                }
                audit.auditItem(ChangeType.CREATE, item.id, item.identifier, { added: itemChanges }, context.getCurrentUser()!.login, item.createdAt)
            }

            return item
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

            if (!channels) channels = {}

            if (values) {
                filterValuesNotAllowed(context.getNotEditItemAttributes(item), values)
                checkValues(mng, values)
            }

            let itemDiff: AuditItem | null = null
            const transaction = await sequelize.transaction()
            try {
                const actionResponse = await processItemActions(context, EventType.BeforeUpdate, item, item.parentIdentifier, name, values, channels, false, false, false, transaction)
                if (actionResponse.some((resp) => resp.result === 'cancelSave')) {
                    await transaction.commit()
                    return item
                }
                if (audit.auditEnabled()) itemDiff = diff({ name: item.name, values: item.values, channels: item.channels }, { name: name || item.name, values: values || item.values, channels: channels || item.channels })
                if (channels) {
                    filterEditChannels(context, channels)
                    checkSubmit(context, channels)
                    item.channels = mergeValues(channels, item.channels)
                    processDeletedChannels(item.channels)
                }
                let relAttributesData: any = []
                if (values) {
                    relAttributesData = await checkRelationAttributes(context, mng, item, values, transaction)
                    item.values = mergeValues(values, item.values)
                    item.changed("values", true)
                }
    
                if (name) item.name = name
                await item.save({ transaction })
                await createRelationsForItemRelAttributes(context, relAttributesData, transaction)
                await transaction.commit()
                await processItemActions(context, EventType.AfterUpdate, item, item.parentIdentifier, name, values, channels, false, false, false)
            } catch(err: any) {
                await transaction.rollback()
                throw new Error(err.message)
            }
            if (audit.auditEnabled() && itemDiff) {
                if (!isObjectEmpty(itemDiff!.added) || !isObjectEmpty(itemDiff!.changed) || !isObjectEmpty(itemDiff!.deleted)) audit.auditItem(ChangeType.UPDATE, item.id, item.identifier, itemDiff!, context.getCurrentUser()!.login, item.updatedAt)
            }

            return item
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

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
            const parentType = mng.getTypeById(parentItem.typeId)!
            const itemType = mng.getTypeByIdentifier(item.typeIdentifier)!

            const tstType = parentType.getChildren().find(elem => (elem.getValue().identifier === item.typeIdentifier) || (elem.getValue().link === itemType.getValue().id))
            if (!tstType) throw new Error('Can not move this item to this parent because this is not allowed by data model.');

            await processItemActions(context, EventType.BeforeUpdate, item, parentItem.identifier, item.name, item.values, item.channels, false, false)

            let newPath = parentItem.path + "." + item.id
            if (newPath !== item.path) {
                const old = item.parentIdentifier
                // check children
                const cnt: any = await sequelize.query('SELECT count(*) FROM items where "deletedAt" IS NULL and "tenantId"=:tenant and path~:lquery', {
                    replacements: {
                        tenant: context.getCurrentUser()!.tenantId,
                        lquery: item.path + '.*{1}',
                    },
                    plain: true,
                    raw: true,
                    type: QueryTypes.SELECT
                })
                const childrenNumber = parseInt(cnt.count)
                if (childrenNumber > 0) { // move subtree
                    await sequelize.query('update items set path = text2ltree(:parentPath) || subpath(path,:level) where path <@ :oldPath and "tenantId"=:tenant', {
                        replacements: {
                            tenant: context.getCurrentUser()!.tenantId,
                            oldPath: item.path,
                            parentPath: parentItem.path,
                            level: item.path.split('.').length - 1
                        },
                        plain: true,
                        raw: true,
                        type: QueryTypes.UPDATE
                    })
                } else { // move leaf
                    item.path = newPath
                }

                if (parentItem.identifier === item.parentIdentifier) {
                    throw new Error('Failed to create item with parentIdentifier same as item identifier')
                }
                item.parentIdentifier = parentItem.identifier;
                await sequelize.transaction(async (t) => {
                    await item.save({ transaction: t })
                })

                if (audit.auditEnabled()) {
                    const itemDiff: AuditItem = { changed: { parentIdentifier: parentItem.identifier }, old: { parentIdentifier: old } }
                    audit.auditItem(ChangeType.UPDATE, item.id, item.identifier, itemDiff, context.getCurrentUser()!.login, item.updatedAt)
                }
                await processItemActions(context, EventType.AfterUpdate, item, parentItem.identifier, item.name, item.values, item.channels, false, false)
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

            const retArr: any = await processItemActions(context, EventType.BeforeDelete, item, "", "", null, null, false, false)
            const ret = retArr.length > 0 ? retArr[0] : null
            const del: boolean = !ret || ret.data === undefined || ret.data === true

            if (del) {
                const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
                // check Roles
                const tst1 = mng.getRoles().find(role => role.itemAccess.fromItems.includes(nId))
                if (tst1) throw new Error('Can not remove this item because there are roles linked to it.');
                // check Attributes
                // const tst2:any = await Attribute.applyScope(context).findOne({where: {visible: { [Op.contains]: nId}}})
                const tst2: any = await Attribute.applyScope(context).findOne({ where: literal("visible @> '" + nId + "'") })
                if (tst2) throw new Error('Can not remove this item because there are attributes linked to it.');
                // check children
                const cnt: any = await sequelize.query('SELECT count(*) FROM items where "deletedAt" IS NULL and "tenantId"=:tenant and path~:lquery', {
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
                        [Op.or]: [{ itemId: item.id }, { targetId: item.id }]
                    },
                })
                if (num > 0) throw new Error('Can not remove item that has relations, remove them first.');
            }

            item.updatedBy = context.getCurrentUser()!.login

            // we have to change identifier during deletion to make possible that it will be possible to make new type with same identifier
            const oldIdentifier = item.identifier
            if (del) item.identifier = item.identifier + '_d_' + Date.now()
            await sequelize.transaction(async (t) => {
                await item.save({ transaction: t })
                if (del) await item.destroy({ transaction: t })
            })

            if (del && item.storagePath) {
                const fm = FileManager.getInstance()
                await fm.removeFile(item)
            }

            await processItemActions(context, EventType.AfterDelete, item, "", "", null, null, false, false)

            if (audit.auditEnabled()) {
                if (del) {
                    const itemChanges: ItemChanges = {
                        typeIdentifier: item.typeIdentifier,
                        parentIdentifier: item.parentIdentifier,
                        name: item.name,
                        values: item.values,
                        channels: item.channels
                    }
                    audit.auditItem(ChangeType.DELETE, item.id, oldIdentifier, { deleted: itemChanges }, context.getCurrentUser()!.login, item.updatedAt)
                }
            }

            return ret ? (ret.result === false ? false : true) : true
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
                await item.save({ transaction: t })
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