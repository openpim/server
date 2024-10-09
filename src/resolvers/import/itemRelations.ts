import Context from "../../context"
import { IImportConfig, IItemRelationImportRequest, ImportResponse, ReturnMessage, ImportResult, ImportMode, ErrorProcessing } from "../../models/import"
import { ItemRelation } from "../../models/itemRelations"
import { sequelize } from "../../models"
import { ModelsManager } from "../../models/manager"
import { Item } from "../../models/items"
import { Relation } from "../../models/relations"
import { mergeValues, filterValues, checkValues, processItemRelationActions, diff, isObjectEmpty, updateItemRelationAttributes } from "../utils"
import { EventType } from "../../models/actions"

import logger from '../../logger'
import audit, { AuditItemRelation, ChangeType, ItemRelationChanges } from "../../audit"

/*

mutation { import(
    config: {
        mode: CREATE_UPDATE
        errors: PROCESS_WARN
    },
    itemRelations: [
        {
            delete: false,
            identifier: "rel1",
            relationIdentifier: "rel1"
            itemIdentifier: "itemLevel1",
            targetIdentifier: "sa1",
            values: {
                attr1: "aaa"
                attr2: {ru: "test"}
            }
        }
    ]
    ) {
    itemRelations {
	  identifier
	  result
	  id
	  errors { code message }
	  warnings { code message }
	}}}

*/

export async function importItemRelation(context: Context, config: IImportConfig, itemRelation: IItemRelationImportRequest): Promise<ImportResponse> {
    const result = new ImportResponse(itemRelation.identifier)

    if (!itemRelation.identifier || !/^[A-Za-z0-9_-]*$/.test(itemRelation.identifier)) {
        result.addError(ReturnMessage.WrongIdentifier)
        result.result = ImportResult.REJECTED
        return result
    }

    try {
        const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
        if (itemRelation.delete) {
            const data = await ItemRelation.applyScope(context).findOne({where: { identifier: itemRelation.identifier } })
            if (!data) {
                result.addError(ReturnMessage.ItemRelationNotFound)
                result.result = ImportResult.REJECTED
            } else {
                if (!context.canEditItemRelation(data.relationId)) {
                    result.addError(ReturnMessage.ItemRelationNoAccess)
                    result.result = ImportResult.REJECTED
                }
                data.updatedBy = context.getCurrentUser()!.login
                if (!itemRelation.skipActions) await processItemRelationActions(context, EventType.BeforeDelete, data, null, null, true, false)
                const oldIdentifier = data.identifier
                data.identifier = itemRelation.identifier + '_d_' + Date.now()

                const transaction = await sequelize.transaction()
                try {
                    await updateItemRelationAttributes(context, mng, data, true, transaction)
                    await data.save({ transaction })
                    await data.destroy({ transaction })
                    transaction.commit()
                } catch(err: any) {
                    transaction.rollback()
                    throw new Error(err.message)
                }
                if (!itemRelation.skipActions) await processItemRelationActions(context, EventType.AfterDelete, data, null, null, true, false)
                if (audit.auditEnabled()) {
                    const itemRelationChanges: ItemRelationChanges = {
                        relationIdentifier: data.relationIdentifier,
                        itemIdentifier: data.itemIdentifier,
                        targetIdentifier: data.targetIdentifier,
                        values: data.values
                    }
                    audit.auditItemRelation(ChangeType.DELETE, data.id, oldIdentifier, {deleted: itemRelationChanges}, context.getCurrentUser()!.login, data.updatedAt)
                }
    
                result.result = ImportResult.DELETED
            }
            return result
        }

        let data: ItemRelation | null = await ItemRelation.applyScope(context).findOne({where: { identifier: itemRelation.identifier } })
        if (config.mode === ImportMode.CREATE_ONLY) {
            if (data) {
                result.addError(ReturnMessage.ItemRelationExist)
                result.result = ImportResult.REJECTED
                return result
            }
        } else if (config.mode === ImportMode.UPDATE_ONLY) {
            if (!data) {
                result.addError(ReturnMessage.ItemRelationNotFound)
                result.result = ImportResult.REJECTED
                return result
            }
        }        

        if (!data) {
            // create
            if (!itemRelation.relationIdentifier) {
                result.addError(ReturnMessage.ItemRelationRelationIdentifierRequired)
                result.result = ImportResult.REJECTED
                return result
            }
            const relation = mng.getRelationByIdentifier(itemRelation.relationIdentifier)
            if (!relation) {
                result.addError(ReturnMessage.ItemRelationRelationNotFound)
                result.result = ImportResult.REJECTED
                return result
            }

            if (!context.canEditItemRelation(relation.id)) {
                result.addError(ReturnMessage.ItemRelationNoAccess)
                result.result = ImportResult.REJECTED
                return result
            }

            const source = await checkSource(itemRelation, result, relation, context)
            if (result.result) return result

            const target = await checkTarget(itemRelation, result, relation, context)
            if (result.result) return result

            if (!relation.multi) {
                const count = await ItemRelation.applyScope(context).count( {
                    where: {
                        itemId: source!.id,
                        relationId: relation.id
                    }
                })
                if (count > 0) { 
                    result.addError(ReturnMessage.ItemRelationNotMulty)
                    result.result = ImportResult.REJECTED
                    return result
                }
            }

            const data = await ItemRelation.build ({
                identifier: itemRelation.identifier,
                tenantId: context.getCurrentUser()!.tenantId,
                createdBy: context.getCurrentUser()!.login,
                updatedBy: context.getCurrentUser()!.login,
                relationId: relation.id,
                relationIdentifier: relation.identifier,
                itemId: source!.id,
                itemIdentifier: source!.identifier,
                targetId: target!.id,
                targetIdentifier: target?.identifier,
                values: null
            })

            if (!itemRelation.values) itemRelation.values = {}
            if (!itemRelation.skipActions) await processItemRelationActions(context, EventType.BeforeCreate, data, null, itemRelation.values, true, false)

            filterValues(context.getEditItemRelationAttributes(relation.id), itemRelation.values)
            try {
                checkValues(mng, itemRelation.values)
            } catch (err:any) {
                result.addError(new ReturnMessage(0, err.message))
                result.result = ImportResult.REJECTED
                return result
            }

            data.values = itemRelation.values

            const transaction = await sequelize.transaction()
            try {
                await updateItemRelationAttributes(context, mng, data, false, transaction)
                await data.save({ transaction })
                transaction.commit()
            } catch(err: any) {
                transaction.rollback()
                throw new Error(err.message)
            }
            if (!itemRelation.skipActions) await processItemRelationActions(context, EventType.AfterCreate, data, null, itemRelation.values, true, false)

            if (audit.auditEnabled()) {
                const itemRelationChanges: ItemRelationChanges = {
                    relationIdentifier: data.relationIdentifier,
                    itemIdentifier: data.itemIdentifier,
                    targetIdentifier: data.targetIdentifier,
                    values: data.values
                }
                audit.auditItemRelation(ChangeType.CREATE, data.id, itemRelation.identifier, {added: itemRelationChanges}, context.getCurrentUser()!.login, data.createdAt)
            }

            result.id = ""+data.id
            result.result = ImportResult.CREATED
        } else {
            // update
            if (!context.canEditItemRelation(data.relationId)) {
                result.addError(ReturnMessage.ItemRelationNoAccess)
                result.result = ImportResult.REJECTED
                return result
            }

            if (itemRelation.relationIdentifier) {
                result.addWarning(ReturnMessage.ItemRelationUpdateRelationIdentifier);
                if (config.errors == ErrorProcessing.WARN_REJECTED) {
                    result.result = ImportResult.REJECTED
                    return result
                }
            }

            let relDiff: AuditItemRelation = {added:{}, changed: {}, old: {}, deleted: {}}

            const changes:any = {}
            if (data.itemIdentifier !== itemRelation.itemIdentifier) {
                const relation = mng.getRelationByIdentifier(data.relationIdentifier)
                if (!relation) {
                    result.addError(ReturnMessage.ItemRelationRelationNotFound)
                    result.result = ImportResult.REJECTED
                    return result
                }
                const source = await checkSource(itemRelation, result, relation, context)
                if (result.result) return result

                if (audit.auditEnabled()) {
                    relDiff.changed!.itemIdentifier = source!.identifier
                    relDiff.old!.itemIdentifier = data.itemIdentifier
                }

                changes.itemId = source!.id
                changes.itemIdentifier = source!.identifier
            }

            if (data.targetIdentifier !== itemRelation.targetIdentifier) {
                const relation = mng.getRelationByIdentifier(data.relationIdentifier)
                if (!relation) {
                    result.addError(ReturnMessage.ItemRelationRelationNotFound)
                    result.result = ImportResult.REJECTED
                    return result
                }
                const target = await checkTarget(itemRelation, result, relation, context)
                if (result.result) return result

                if (audit.auditEnabled()) {
                    relDiff.changed!.targetIdentifier = target!.identifier
                    relDiff.old!.targetIdentifier = data.targetIdentifier
                }

                changes.targetId = target!.id
                changes.targetIdentifier = target!.identifier
            }

            if (!itemRelation.values) itemRelation.values = {}

            if (!itemRelation.skipActions) await processItemRelationActions(context, EventType.BeforeUpdate, data, changes, itemRelation.values, true, false)

            if (changes.itemId) {
                data.itemId = changes.itemId
                data.itemIdentifier = changes.itemIdentifier
            }

            if (changes.targetId) {
                data.targetId = changes.targetId
                data.targetIdentifier = changes.targetIdentifier
            }

            filterValues(context.getEditItemRelationAttributes(data.relationId), itemRelation.values)
            try {
                checkValues(mng, itemRelation.values)
            } catch (err:any) {
                result.addError(new ReturnMessage(0, err.message))
                result.result = ImportResult.REJECTED
                return result
            }

            if (audit.auditEnabled()) {
                const valuesDiff = diff({values: data.values}, {values: itemRelation.values})
                relDiff.added = {...relDiff.added, ...valuesDiff.added}
                relDiff.changed = {...relDiff.changed, ...valuesDiff.changed}
                relDiff.old = {...relDiff.old, ...valuesDiff.old}
            }

            data.values = mergeValues(itemRelation.values, data.values)
            data.updatedBy = context.getCurrentUser()!.login

            const transaction = await sequelize.transaction()
            try {
                await updateItemRelationAttributes(context, mng, data, false, transaction)
                await data!.save({transaction})
                transaction.commit()
            } catch(err: any) {
                transaction.rollback()
                throw new Error(err.message)
            }
            if (!itemRelation.skipActions) await processItemRelationActions(context, EventType.AfterUpdate, data, null, itemRelation.values, true, false)
            if (audit.auditEnabled()) {
                if (!isObjectEmpty(relDiff!.added) || !isObjectEmpty(relDiff!.changed) || !isObjectEmpty(relDiff!.deleted)) audit.auditItemRelation(ChangeType.UPDATE, data.id, data.identifier, relDiff, context.getCurrentUser()!.login, data.updatedAt)
            }
            result.id = ""+data.id
            result.result = ImportResult.UPDATED
        }
    } catch (error) {
        result.addError(new ReturnMessage(0, ""+error))
        result.result = ImportResult.REJECTED
        logger.error(error)
    }

    return result
}

async function checkSource(itemRelation: IItemRelationImportRequest, result: ImportResponse, relation: Relation, context: Context): Promise<Item | null> {
    if (!itemRelation.itemIdentifier) {
        result.addError(ReturnMessage.ItemRelationSourceIdentifierRequired)
        result.result = ImportResult.REJECTED
        return null
    }
    const source = await Item.applyScope(context).findOne({where: { identifier: itemRelation.itemIdentifier } })
    if (!source) {
        result.addError(ReturnMessage.ItemRelationSourceNotFound)
        result.result = ImportResult.REJECTED
        return null
    }
    if (!relation.sources || !relation.sources.find((typeId: number) => typeId === source.typeId)) {
        result.addError(ReturnMessage.ItemRelationWrongSource)
        result.result = ImportResult.REJECTED
        return null
    }

    return source
}

async function checkTarget(itemRelation: IItemRelationImportRequest, result: ImportResponse, relation: Relation, context: Context): Promise<Item | null> {
    if (!itemRelation.targetIdentifier) {
        result.addError(ReturnMessage.ItemRelationTargetIdentifierRequired)
        result.result = ImportResult.REJECTED
        return null
    }
    const target = await Item.applyScope(context).findOne({where: { identifier: itemRelation.targetIdentifier } })
    if (!target) {
        result.addError(ReturnMessage.ItemRelationTargetNotFound)
        result.result = ImportResult.REJECTED
        return null
    }
    if (!relation.targets || !relation.targets.find((typeId: number) => typeId === target.typeId)) {
        result.addError(ReturnMessage.ItemRelationWrongTarget)
        result.result = ImportResult.REJECTED
        return null
    }

    return target
}