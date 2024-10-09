import Context from '../context'
import { sequelize } from '../models'
import { Item } from '../models/items'
import { ItemRelation, IItemRelation } from '../models/itemRelations'
import { ModelsManager } from '../models/manager'
import { QueryTypes, literal } from 'sequelize'
import { filterValues, mergeValues, checkValues, processItemRelationActions, updateItemRelationAttributes, diff, isObjectEmpty } from './utils'
import { EventType } from '../models/actions'
import audit, { AuditItemRelation, ChangeType, ItemRelationChanges } from '../audit'

export default {
    Query: {
        getSourceRelations: async (parent: any, { itemId, relationId, offset, limit, where }: any, context: Context) => {
            context.checkAuth()

            const relId = parseInt(relationId)
            if (!context.canViewItemRelation(relId)) return {count: 0, rows: []}
            
            let whereClause = {
                itemId: parseInt(itemId),
                relationId: relId,
                ...where
            } 
            const res = await ItemRelation.applyScope(context).findAndCountAll({
                where: whereClause,
                order: [literal("values->'_itemRelationOrder'"), ['id', 'ASC']],
                offset: offset,
                limit: limit === -1 ? null : limit
            })

            if (res.count > 0) {
                const itemsArr = res.rows.map(elem => elem.itemId)
                const targetArr = res.rows.map(elem => elem.targetId)
                const items = await Item.applyScope(context).findAll({ where: { id: itemsArr} })
                const targets = await Item.applyScope(context).findAll({ where: { id: targetArr} })

                const allowedAttributes = context.getViewItemRelationAttributes(relId)

                res.rows.forEach(row => {
                    const data:IItemRelation = <any>row
                    data.item = items.find(item => item.id === row.itemId)!
                    data.target = targets.find(item => item.id === row.targetId)!
                    filterValues(allowedAttributes, data.values)
                })
            }

            return res
        },
        getTargetRelations: async (parent: any, { itemId, relationId, offset, limit, where }: any, context: Context) => {
            context.checkAuth()
            
            const relId = parseInt(relationId)
            if (!context.canViewItemRelation(relId)) return {count: 0, rows: []}

            let whereClause = {
                targetId: parseInt(itemId),
                relationId: relId,
                ...where
            } 
            const res = await ItemRelation.applyScope(context).findAndCountAll({
                where: whereClause,
                order: [literal("values->'_itemRelationOrder'"),['id', 'ASC']],
                offset: offset,
                limit: limit === -1 ? null : limit
            })

            if (res.count > 0) {
                const itemsArr = res.rows.map(elem => elem.itemId)
                const targetArr = res.rows.map(elem => elem.targetId)
                const items = await Item.applyScope(context).findAll({ where: { id: itemsArr} })
                const targets = await Item.applyScope(context).findAll({ where: { id: targetArr} })

                const allowedAttributes = context.getViewItemRelationAttributes(relId)

                res.rows.forEach(row => {
                    const data:IItemRelation = <any>row
                    data.item = items.find(item => item.id === row.itemId)!
                    data.target = targets.find(item => item.id === row.targetId)!
                    filterValues(allowedAttributes, data.values)
                })
            }

            return res
        },
        getItemRelation: async (parent: any, { id }: any, context: Context) => {
            context.checkAuth()

            const relId = parseInt(id)
            if (!context.canViewItemRelation(relId)) return null

            const res = await ItemRelation.applyScope(context).findByPk(relId)
            if (res) {
                const arr = [res.itemId, res.targetId]
                const items = await Item.applyScope(context).findAll({ where: { id: arr} })

                const data:IItemRelation = <any>res
                data.item = items[0]
                data.target = items[1]
                filterValues(context.getViewItemRelationAttributes(relId), data.values)
                return data
            } else {
                return null
            }
        },
        getItemRelationByIdentifier: async (parent: any, { identifier }: any, context: Context) => {
            context.checkAuth()

            const res = await ItemRelation.applyScope(context).findOne({
                where: {
                    identifier: identifier
                }
            })

            if (res) {
                if (!context.canViewItemRelation(res.id)) return null
    
                const arr = [res.itemId, res.targetId]
                const items = await Item.applyScope(context).findAll({ where: { id: arr} })

                const data:IItemRelation = <any>res
                data.item = items[0]
                data.target = items[1]
                filterValues(context.getViewItemRelationAttributes(res.id), data.values)
                return data
            } else {
                return null
            }
        },
        getItemRelationsChildren: async (parent: any, { itemId, offset, limit, sort  }: any, context: Context) => {
            context.checkAuth()
            
            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
            let relationsWithChildren = mng.getRelations().filter(rel => rel.child).map(rel => rel.id)

            relationsWithChildren = relationsWithChildren.filter(id => context.canViewItemRelation(id))

            if (relationsWithChildren.length === 0) return { count: 0, rows: [] }

            const restrictSql = await context.generateRestrictionsInSQL('i.', true)

            let cnt:{count: string}|null = {count: '0'}
            cnt = await sequelize.query(
                `SELECT Count(i.*) FROM "items" i, "itemRelations" r where
                    i."deletedAt" IS NULL and
                    r."deletedAt" IS NULL and
                    i."tenantId"=:tenant and
                    i."id"=r."targetId" and
                    r."relationId" in (:relations) and
                    r."itemId"=:itemId`+restrictSql, { 
                replacements: { 
                    tenant: context.getCurrentUser()!.tenantId,
                    relations: relationsWithChildren,
                    itemId: itemId,
                },
                plain: true,
                raw: true,
                type: QueryTypes.SELECT
            })
            if (!cnt) throw new Error("DB error")
            let items: Item[] = await sequelize.query(
                `SELECT i.* FROM "items" i, "itemRelations" r where 
                    i."deletedAt" IS NULL and 
                    r."deletedAt" IS NULL and 
                    i."tenantId"=:tenant and 
                    i."id"=r."targetId" and 
                    r."relationId" in (:relations) and 
                    r."itemId"=:itemId
                    `+restrictSql+` 
                    order by i.`+(sort ? sort : 'id')+` 
                    limit :limit offset :offset`, {
                replacements: { 
                    tenant: context.getCurrentUser()!.tenantId,
                    relations: relationsWithChildren,
                    itemId: itemId,
                    offset: offset,
                    limit: limit === -1 ? null : limit
                },
                model: Item,
                mapToModel: true
            })

            return { count: parseInt(cnt.count), rows: (items || []) }
        }
    },
    Mutation: {
        createItemRelation: async (parent: any, { identifier, itemId, relationId, targetId, values }: any, context: Context) => {
            context.checkAuth()
            if (!/^[A-Za-z0-9_-]*$/.test(identifier)) throw new Error('Identifier must not has spaces and must be in English only: ' + identifier + ', tenant: ' + context.getCurrentUser()!.tenantId)

            const nRelationId = parseInt(relationId)
            if (!context.canEditItemRelation(nRelationId)) {
                throw new Error('User :' + context.getCurrentUser()?.login + ' can not edit item relation:' + nRelationId + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }

            const tst = await ItemRelation.applyScope(context).findOne({
                where: {
                    identifier: identifier
                }
            })
            if (tst) {
                throw new Error('Identifier: ' + identifier + ' already exists, tenant: ' + context.getCurrentUser()!.tenantId)
            }

            const nItemId = parseInt(itemId)
            const item = await Item.applyScope(context).findByPk(nItemId)
            if (!item) {
                throw new Error('Failed to find item by id: ' + itemId + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }

            const nTargetId = parseInt(targetId)
            const targetItem = await Item.applyScope(context).findByPk(nTargetId)
            if (!targetItem) {
                throw new Error('Failed to find target item by id: ' + targetId + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
            const rel = mng.getRelationById(nRelationId)
            if (!rel) {
                throw new Error('Failed to find relation by id: ' + relationId + ', tenant: ' + mng.getTenantId())
            }

            const tst3 = rel.targets.find((typeId: number) => typeId === targetItem.typeId)
            if (!tst3) {
                throw new Error('Relation with id: ' + relationId + ' can not have target with type: ' + targetItem.typeId + ', tenant: ' + mng.getTenantId())
            }

            if (!rel.multi) {
                const count = await ItemRelation.applyScope(context).count( {
                    where: {
                        itemId: nItemId,
                        relationId: rel.id
                    }
                })

                if (count > 0) {
                    throw new Error('Relation with id: ' + relationId + ' can not have more then one target, tenant: ' + mng.getTenantId())
                }
            }

            const itemRelation = await ItemRelation.build ({
                identifier: identifier,
                tenantId: context.getCurrentUser()!.tenantId,
                createdBy: context.getCurrentUser()!.login,
                updatedBy: context.getCurrentUser()!.login,
                relationId: nRelationId,
                relationIdentifier: rel.identifier,
                itemId: nItemId,
                itemIdentifier: item.identifier,
                targetId: nTargetId,
                targetIdentifier: targetItem.identifier,
                values: null
            })

            if (!values) values = {}
            await processItemRelationActions(context, EventType.BeforeCreate, itemRelation, null, values, false, false)

            filterValues(context.getEditItemRelationAttributes(nRelationId), values)
            checkValues(mng, values)
            itemRelation.values = values

            const transaction = await sequelize.transaction()
            try {
                await updateItemRelationAttributes(context, mng, itemRelation, false, transaction)
                await itemRelation.save({ transaction })
                await transaction.commit()
            } catch(err: any) {
                transaction.rollback()
                throw new Error(err.message)
            }
            await processItemRelationActions(context, EventType.AfterCreate, itemRelation, null, values, false, false)
            if (audit.auditEnabled()) {
                const itemRelationChanges: ItemRelationChanges = {
                    relationIdentifier: itemRelation.relationIdentifier,
                    itemIdentifier: itemRelation.itemIdentifier,
                    targetIdentifier: itemRelation.targetIdentifier,
                    values: values
                }
                audit.auditItemRelation(ChangeType.CREATE, itemRelation.id, itemRelation.identifier, {added: itemRelationChanges}, context.getCurrentUser()!.login, itemRelation.createdAt)
            }

            return itemRelation
        },
        updateItemRelation: async (parent: any, { id, itemId, targetId, values }: any, context: Context) => {
            context.checkAuth()
            const nId = parseInt(id)

            const itemRelation = await ItemRelation.applyScope(context).findByPk(nId)
            if (!itemRelation) {
                throw new Error('Failed to find item relation by id: ' + nId + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }

            if (!context.canEditItemRelation(itemRelation.relationId)) {
                throw new Error('User :' + context.getCurrentUser()?.login + ' can not edit item relation:' + itemRelation.relationId + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }

            let relDiff: AuditItemRelation = {added:{}, changed: {}, old: {}, deleted: {}}

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
            const rel = mng.getRelationById(itemRelation.relationId)

            const changes:any = {}
            if (itemId) {
                const nItemId = parseInt(itemId)
                if (itemRelation.itemId !== nItemId) {
                    const item = await Item.applyScope(context).findByPk(nItemId)
                    if (!item) {
                        throw new Error('Failed to find item by id: ' + itemId + ', tenant: ' + context.getCurrentUser()!.tenantId)
                    }
                    const tst3 = rel!.sources.find((typeId: number) => typeId === item.typeId)
                    if (!tst3) {
                        throw new Error('Relation with id: ' + itemRelation.relationId + ' can not have source with type: ' + item.typeId + ', tenant: ' + mng.getTenantId())
                    }

                    if (audit.auditEnabled()) {
                        relDiff.changed!.itemIdentifier = item.identifier
                        relDiff.old!.itemIdentifier = itemRelation.itemIdentifier
                    }

                    changes.itemId = nItemId
                    changes.itemIdentifier = item.identifier
                }
            }

            if (targetId) {
                const nTargetId = parseInt(targetId)
                if (itemRelation.targetId !== nTargetId) {
                    const targetItem = await Item.applyScope(context).findByPk(nTargetId)
                    if (!targetItem) {
                        throw new Error('Failed to find target item by id: ' + targetId + ', tenant: ' + context.getCurrentUser()!.tenantId)
                    }
                    const tst3 = rel!.targets.find((typeId: number) => typeId === targetItem.typeId)
                    if (!tst3) {
                        throw new Error('Relation with id: ' + itemRelation.relationId + ' can not have target with type: ' + targetItem.typeId + ', tenant: ' + mng.getTenantId())
                    }

                    if (audit.auditEnabled()) {
                        relDiff.changed!.targetIdentifier = targetItem.identifier
                        relDiff.old!.targetIdentifier = itemRelation.targetIdentifier
                    }

                    changes.targetId = nTargetId
                    changes.targetIdentifier = targetItem.identifier
                }
            }

            await processItemRelationActions(context, EventType.BeforeUpdate, itemRelation, changes, values, false, false)

            if (changes.itemId) {
                itemRelation.itemId = changes.itemId
                itemRelation.itemIdentifier = changes.itemIdentifier
            }

            if (changes.targetId) {
                itemRelation.targetId = changes.targetId
                itemRelation.targetIdentifier = changes.targetIdentifier
            }

            if (values) {
                filterValues(context.getEditItemRelationAttributes(itemRelation.relationId), values)
                checkValues(mng, values)

                let valuesDiff: AuditItemRelation
                if (audit.auditEnabled()) {
                    valuesDiff = diff({values: itemRelation.values}, {values: values})
                    relDiff.added = {...relDiff.added, ...valuesDiff.added}
                    relDiff.changed = {...relDiff.changed, ...valuesDiff.changed}
                    relDiff.old = {...relDiff.old, ...valuesDiff.old}
                }

                itemRelation.values = mergeValues(values, itemRelation.values)
            }
            itemRelation.updatedBy = context.getCurrentUser()!.login

            const transaction = await sequelize.transaction()
            try {
                await updateItemRelationAttributes(context, mng, itemRelation, false, transaction)
                await itemRelation.save({ transaction })
                await transaction.commit()
            } catch(err: any) {
                transaction.rollback()
                throw new Error(err.message)
            }
            await processItemRelationActions(context, EventType.AfterUpdate, itemRelation, null, values, false, false)
            if (audit.auditEnabled()) {
                if (!isObjectEmpty(relDiff!.added) || !isObjectEmpty(relDiff!.changed) || !isObjectEmpty(relDiff!.deleted)) audit.auditItemRelation(ChangeType.UPDATE, itemRelation.id, itemRelation.identifier, relDiff, context.getCurrentUser()!.login, itemRelation.updatedAt)
            }

            return itemRelation
        },
        removeItemRelation: async (parent: any, { id }: any, context: Context) => {
            context.checkAuth()
            const nId = parseInt(id)

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

            const itemRelation = await ItemRelation.applyScope(context).findByPk(nId)
            if (!itemRelation) {
                throw new Error('Failed to find item relation by id: ' + nId + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }

            if (!context.canEditItemRelation(itemRelation.relationId)) {
                throw new Error('User :' + context.getCurrentUser()?.login + ' can not edit item relation:' + itemRelation.relationId + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }

            const actionResponse = await processItemRelationActions(context, EventType.BeforeDelete, itemRelation, null, null, false, false)
            
            itemRelation.updatedBy = context.getCurrentUser()!.login
            if(actionResponse.some((resp) => resp.result === 'cancelDelete')) {
                await itemRelation.save()
                return true
            }

            // we have to change identifier during deletion to make possible that it will be possible to make new type with same identifier
            const oldIdentifier = itemRelation.identifier
            itemRelation.identifier = itemRelation.identifier + '_d_' + Date.now()

            const transaction = await sequelize.transaction()
            try {
                await updateItemRelationAttributes(context, mng, itemRelation, true, transaction)
                await itemRelation.save({ transaction })
                await itemRelation.destroy({ transaction })
                await transaction.commit()
            } catch(err: any) {
                transaction.rollback()
                throw new Error(err.message)
            }
            await processItemRelationActions(context, EventType.AfterDelete, itemRelation, null, null, false, false)
            if (audit.auditEnabled()) {
                const itemRelationChanges: ItemRelationChanges = {
                    relationIdentifier: itemRelation.relationIdentifier,
                    itemIdentifier: itemRelation.itemIdentifier,
                    targetIdentifier: itemRelation.targetIdentifier,
                    values: itemRelation.values
                }
                audit.auditItemRelation(ChangeType.DELETE, itemRelation.id, oldIdentifier, {deleted: itemRelationChanges}, context.getCurrentUser()!.login, itemRelation.updatedAt)
            }
            return true
        }
    }
}