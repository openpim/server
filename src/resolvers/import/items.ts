import Context from '../../context'
import { IItemImportRequest, ImportResponse, IImportConfig, ImportMode, ReturnMessage, ImportResult, ImportError} from '../../models/import'
import { Item } from '../../models/items'
import { sequelize } from '../../models'
import { QueryTypes, Transaction, literal } from 'sequelize'
import { ModelsManager, ModelManager, TreeNode } from '../../models/manager'
import { filterValues, mergeValues, checkValues, processItemActions, diff, isObjectEmpty, filterChannels, filterEditChannels, checkSubmit, processDeletedChannels, checkRelationAttributes, createRelationsForItemRelAttributes, filterValuesNotAllowed } from '../utils'
import { Attribute } from '../../models/attributes'
import { Op } from 'sequelize'
import { EventType } from '../../models/actions'
import { ItemRelation } from '../../models/itemRelations'

import logger from '../../logger'
import audit from '../../audit'
import { ChangeType, ItemChanges, AuditItem } from '../../audit'
import { FileManager } from '../../media/FileManager'

type ItemIdentifierChangeDeps = {
    findItemByIdentifier?: (context: Context, identifier: string, transaction: Transaction | null) => Promise<any>
    updateItemRelationSourceIdentifiers?: (context: Context, oldIdentifier: string, newIdentifier: string, transaction: Transaction | null) => Promise<any>
    updateItemRelationTargetIdentifiers?: (context: Context, oldIdentifier: string, newIdentifier: string, transaction: Transaction | null) => Promise<any>
    updateChildParentIdentifiers?: (context: Context, oldIdentifier: string, newIdentifier: string, transaction: Transaction | null) => Promise<any>
}

type ItemIdentifierChangeRequest = {
    context: Context
    item: any
    typeNode: TreeNode<any> | null | undefined
    newIdentifier: any
    transaction?: Transaction | null
    deps?: ItemIdentifierChangeDeps
}

type ItemIdentifierChangeResult = {
    changed: boolean
    oldIdentifier?: string
    newIdentifier?: string
}

const ITEM_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]*$/

function normalizeNewIdentifier(newIdentifier: any): string {
    return newIdentifier === null || typeof newIdentifier === 'undefined' ? '' : ('' + newIdentifier).trim()
}

function getTransactionOptions(transaction: Transaction | null) {
    return transaction ? { transaction } : {}
}

export function typeAllowsIdentifierChange(typeNode: TreeNode<any> | null | undefined): boolean {
    const options = typeNode?.getValue()?.options
    if (!Array.isArray(options)) return false

    return options.some((option: any) => {
        if (!option || option.name !== 'allow_identifier_change') return false
        if (option.value === true) return true
        return typeof option.value === 'string' && option.value.toLowerCase() === 'true'
    })
}

export function assertItemIdentifierChangeAllowed(context: Context, item: any, typeNode: TreeNode<any> | null | undefined, newIdentifier: any): string {
    const normalizedNewIdentifier = normalizeNewIdentifier(newIdentifier)
    if (!normalizedNewIdentifier || normalizedNewIdentifier === item.identifier) return ''

    if (!ITEM_IDENTIFIER_PATTERN.test(normalizedNewIdentifier)) {
        throw new ImportError(ReturnMessage.WrongIdentifier.code, ReturnMessage.WrongIdentifier.message + ': ' + normalizedNewIdentifier + ', tenant: ' + context.getCurrentUser?.()?.tenantId)
    }

    if (item.parentIdentifier && normalizedNewIdentifier === item.parentIdentifier) {
        throw new ImportError(ReturnMessage.WrongParent.code, ReturnMessage.WrongParent.message)
    }

    if (!context.isAdmin()) {
        throw new ImportError(ReturnMessage.ItemIdentifierAdminOnly.code, ReturnMessage.ItemIdentifierAdminOnly.message)
    }

    if (!typeAllowsIdentifierChange(typeNode)) {
        throw new ImportError(ReturnMessage.ItemIdentifierTypeOption.code, ReturnMessage.ItemIdentifierTypeOption.message)
    }

    return normalizedNewIdentifier
}

function getDefaultItemIdentifierChangeDeps(): Required<ItemIdentifierChangeDeps> {
    return {
        findItemByIdentifier: async (context: Context, identifier: string, transaction: Transaction | null) => {
            return Item.applyScope(context).findOne({
                where: { identifier },
                ...getTransactionOptions(transaction),
            })
        },
        updateItemRelationSourceIdentifiers: async (context: Context, oldIdentifier: string, newIdentifier: string, transaction: Transaction | null) => {
            return ItemRelation.applyScope(context).update(
                { itemIdentifier: newIdentifier },
                {
                    where: { itemIdentifier: oldIdentifier },
                    ...getTransactionOptions(transaction),
                },
            )
        },
        updateItemRelationTargetIdentifiers: async (context: Context, oldIdentifier: string, newIdentifier: string, transaction: Transaction | null) => {
            return ItemRelation.applyScope(context).update(
                { targetIdentifier: newIdentifier },
                {
                    where: { targetIdentifier: oldIdentifier },
                    ...getTransactionOptions(transaction),
                },
            )
        },
        updateChildParentIdentifiers: async (context: Context, oldIdentifier: string, newIdentifier: string, transaction: Transaction | null) => {
            return Item.applyScope(context).update(
                { parentIdentifier: newIdentifier },
                {
                    where: { parentIdentifier: oldIdentifier },
                    ...getTransactionOptions(transaction),
                },
            )
        },
    }
}

export async function changeItemIdentifier(request: ItemIdentifierChangeRequest): Promise<ItemIdentifierChangeResult> {
    const { context, item, typeNode } = request
    const transaction = request.transaction || null
    const normalizedNewIdentifier = assertItemIdentifierChangeAllowed(context, item, typeNode, request.newIdentifier)

    if (!normalizedNewIdentifier) return { changed: false }

    const deps = { ...getDefaultItemIdentifierChangeDeps(), ...(request.deps || {}) }
    const oldIdentifier = item.identifier

    const existing = await deps.findItemByIdentifier(context, normalizedNewIdentifier, transaction)
    if (existing && Number(existing.id) !== Number(item.id)) {
        throw new ImportError(ReturnMessage.ItemIdentifierExists.code, ReturnMessage.ItemIdentifierExists.message + ': ' + normalizedNewIdentifier + ', tenant: ' + context.getCurrentUser?.()?.tenantId)
    }

    await deps.updateItemRelationSourceIdentifiers(context, oldIdentifier, normalizedNewIdentifier, transaction)
    await deps.updateItemRelationTargetIdentifiers(context, oldIdentifier, normalizedNewIdentifier, transaction)
    await deps.updateChildParentIdentifiers(context, oldIdentifier, normalizedNewIdentifier, transaction)

    item.identifier = normalizedNewIdentifier
    if (typeof item.changed === 'function') item.changed('identifier', true)

    return {
        changed: true,
        oldIdentifier,
        newIdentifier: normalizedNewIdentifier,
    }
}

/*

mutation { import(
    config: {
        mode: CREATE_UPDATE
        errors: PROCESS_WARN
    },
    items: [
        {
            identifier: "itemSa1",
            parentIdentifier: "itemLevel1",
            typeIdentifier: "sa1",
            name: {ru:"Продукт1"},
            values: {
                attr1: "aaa"
                attr2: {ru: "test"}
            }
        }]
    ) {
    items {
	  identifier
	  result
	  id
	  errors { code message }
	  warnings { code message }
	}}}

*/

export async function importItem(context: Context, config: IImportConfig, item: IItemImportRequest): Promise<ImportResponse> {
    const result = new ImportResponse(item.identifier)

    if (!item.identifier || !/^[A-Za-z0-9_-]*$/.test(item.identifier)) {
        result.addError(ReturnMessage.WrongIdentifier)
        result.result = ImportResult.REJECTED
        return result
    }

    try {
        if (item.delete) {
            const data = await Item.applyScope(context).findOne({where: { identifier: item.identifier } })
            if (!data) {
                result.addError(ReturnMessage.ItemNotFound)
                result.result = ImportResult.REJECTED
            } else {
                if (!context.canEditItem(data)) {
                    result.addError(ReturnMessage.ItemNoAccess)
                    result.result = ImportResult.REJECTED
                }

                const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
                // check Roles
                const tst1 = mng.getRoles().find(role => role.itemAccess.fromItems.includes(data.id))
                // check Attributes
                // const tst2 = await Attribute.applyScope(context).findOne({where: {visible: { [Op.contains]: data.id}}})
                const tst2:any = await Attribute.applyScope(context).findOne({where: literal("visible @> '"+data.id+"'") })
                if (tst1 || tst2) {
                    result.addError(ReturnMessage.ItemDeleteFailed)
                    result.result = ImportResult.REJECTED
                    return result
                }
               
                // check children
                const cnt:any = await sequelize.query('SELECT count(*) FROM items where "deletedAt" IS NULL and "tenantId"=:tenant and path~:lquery', {
                    replacements: { 
                        tenant: context.getCurrentUser()!.tenantId,
                        lquery: data.path + '.*{1}',
                    },
                    plain: true,
                    raw: true,
                    type: QueryTypes.SELECT
                })
                const childrenNumber = parseInt(cnt.count)
                if (childrenNumber > 0) {
                    result.addError(ReturnMessage.ItemDeleteFailedChildren)
                    result.result = ImportResult.REJECTED
                    return result
                }

                let checkRelationsOnDelete = true
                const type = mng.getTypeByIdentifier(data.typeIdentifier)
                if (type && type.getValue().options && type.getValue().options.some((opt:any) => opt.name === 'checkRelationsOnDelete' && opt.value == 'false' )) checkRelationsOnDelete = false

                if (checkRelationsOnDelete) {
                    // check relations
                    const num = await ItemRelation.applyScope(context).count({
                        where: {
                            [Op.or]: [{itemId: data.id}, {targetId: data.id}]
                        },
                    })
                    if (num > 0) {
                        result.addError(ReturnMessage.ItemDeleteFailedRelations)
                        result.result = ImportResult.REJECTED
                        return result
                    }
                }

                data.updatedBy = context.getCurrentUser()!.login

                const oldIdentifier = item.identifier
                const transaction = await sequelize.transaction()
                try {
                    if (!item.skipActions) await processItemActions(context, EventType.BeforeDelete, data, "", "", null, null, true, false, false, transaction)
                    data.identifier = item.identifier + '_d_' + Date.now() 
                    await data.save({ transaction })
                    await data.destroy({ transaction })
                    if (data.storagePath) {
                        const fm = FileManager.getInstance()
                        await fm.removeFile(data)
                    }
                    await transaction.commit()
                    if (!item.skipActions) await processItemActions(context, EventType.AfterDelete, data, "", "", null, null, true, false, false, null)
                } catch (err:any) {
                    if (transaction) await transaction.rollback()
                    throw new ImportError(err.message)
                }
                if (audit.auditEnabled()) {
                    const itemChanges: ItemChanges = {
                        typeIdentifier: data.typeIdentifier,
                        parentIdentifier: data.parentIdentifier,
                        name: data.name,
                        values: data.values,
                        channels: data.channels
                    }
                    audit.auditItem(ChangeType.DELETE, data.id, oldIdentifier, {deleted: itemChanges}, context.getCurrentUser()!.login, data.updatedAt)
                }
                result.result = ImportResult.DELETED
            }
            return result
        }

        let data: Item | null = await Item.applyScope(context).findOne({where: { identifier: item.identifier } })
        if (config.mode === ImportMode.CREATE_ONLY) {
            if (data) {
                result.addError(ReturnMessage.ItemExist)
                result.result = ImportResult.REJECTED
                return result
            }
        } else if (config.mode === ImportMode.UPDATE_ONLY) {
            if (!data) {
                result.addError(ReturnMessage.ItemNotFound)
                result.result = ImportResult.REJECTED
                return result
            }
        }

        const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

        if (!data) {
            // create
            const type = checkType(item, result, mng)
            if (result.result) return result
    
            let parent = await checkParent(item, result, mng, context)
            if (result.result) return result
    
            const results:any = await sequelize.query("SELECT nextval('items_id_seq')", { 
                type: QueryTypes.SELECT
            });
            const id = (results[0]).nextval

            let path:string
            if (parent) {
                path = parent.path + "." + id
            } else {
                path = '' + id
            }
    
            if (!context.canEditItem2(type!.getValue().id, path)) {
                result.addError(ReturnMessage.ItemNoAccess)
                result.result = ImportResult.REJECTED
                return result
            }

            if (item.parentIdentifier === item.identifier) {
                result.addError(ReturnMessage.WrongParent)
                result.result = ImportResult.REJECTED
                return result
            }

            const data = Item.build ({
                id: id,
                path: path,
                relations: {},
                identifier: item.identifier,
                tenantId: context.getCurrentUser()!.tenantId,
                createdBy: context.getCurrentUser()!.login,
                updatedBy: context.getCurrentUser()!.login,
                name: item.name,
                typeId: type!.getValue().id,
                typeIdentifier: type!.getValue().identifier,
                parentIdentifier: parent ? parent.identifier : "",
                values: null,
                fileOrigName: '',
                storagePath: '',
                mimeType: ''
            })

            if (!item.values) item.values = {}
            if (!item.channels) item.channels = {}

            const transaction = await sequelize.transaction()
            try {
                if (!item.skipActions) await processItemActions(context, EventType.BeforeCreate, data, item.parentIdentifier, item.name, item.values, item.channels, true, false, false, transaction)

                filterEditChannels(context, item.channels)
                checkSubmit(context, item.channels)

                filterValuesNotAllowed(context.getNotEditItemAttributes2(type!.getValue().id, path), item.values)
                checkValues(mng, item.values)

                let relAttributesData: any = []
                relAttributesData = await checkRelationAttributes(context, mng, data, item.values, transaction, item.skipActions)

                data.values = item.values
                data.channels = item.channels

                await data.save({transaction})
                await createRelationsForItemRelAttributes(context, relAttributesData, transaction)
                await transaction.commit()
                if (!item.skipActions) await processItemActions(context, EventType.AfterCreate, data, item.parentIdentifier, item.name, item.values, item.channels, true, false, false, null)
            } catch (err:any) {
                if (transaction) await transaction.rollback()
                throw new ImportError(err.message)
            }

            if (audit.auditEnabled()) {
                const itemChanges: ItemChanges = {
                    typeIdentifier: data.typeIdentifier,
                    parentIdentifier: data.parentIdentifier,
                    name: data.name,
                    values: data.values,
                    channels: data.channels
                }
                audit.auditItem(ChangeType.CREATE, data.id, item.identifier, {added: itemChanges}, context.getCurrentUser()!.login, data.createdAt)
            }
            result.id = ""+data.id
            result.result = ImportResult.CREATED

        } else {
            // update
            if ((item.name || item.values) && !context.canEditItem(data)) {
                result.addError(ReturnMessage.ItemNoAccess)
                result.result = ImportResult.REJECTED
                return result
            }

            let itemDiff: AuditItem = {added:{}, changed:{}, old:{}, deleted: {}}
            if (item.typeIdentifier) {
                const type = checkType(item, result, mng)
                if (result.result) return result
                
                if (data.typeId !== type!.getValue().id) {
                    if (audit.auditEnabled()) {
                        itemDiff.changed!.typeIdentifier = type!.getValue().identifier
                        itemDiff.old!.typeIdentifier = data.typeIdentifier
                    }
                    data.typeId = type!.getValue().id
                    data.typeIdentifier = type!.getValue().identifier
                }
            } else {
                item.typeIdentifier = data.typeIdentifier
            }

            const preparedNewIdentifier = assertItemIdentifierChangeAllowed(context, data, mng.getTypeByIdentifier(data.typeIdentifier), item.newIdentifier)
            if (preparedNewIdentifier) {
                const existedByNewIdentifier = await Item.applyScope(context).findOne({ where: { identifier: preparedNewIdentifier } })
                if (existedByNewIdentifier && Number(existedByNewIdentifier.id) !== Number(data.id)) {
                    throw new ImportError(ReturnMessage.ItemIdentifierExists.code, ReturnMessage.ItemIdentifierExists.message + ': ' + preparedNewIdentifier + ', tenant: ' + context.getCurrentUser()!.tenantId)
                }
            }

            if (!item.values) item.values = {}
            if (!item.channels) item.channels = {}

            const transaction = await sequelize.transaction()
            try {
                if (!item.skipActions) await processItemActions(context, EventType.BeforeUpdate, data, item.parentIdentifier, item.name, item.values, item.channels, true, false, false, transaction)
                if (item.parentIdentifier && data.parentIdentifier !== item.parentIdentifier) {
                    if (item.parentIdentifier === data.identifier) {
                        result.addError(ReturnMessage.WrongParent)
                        result.result = ImportResult.REJECTED
                        if (transaction) await transaction.rollback()
                        return result
                    }
                    
                    let parent = await checkParent(item, result, mng, context)
                    if (result.result) {
                        if (transaction) await transaction.rollback()
                        return result
                    }

                    if (audit.auditEnabled()) {
                        itemDiff.changed!.parentIdentifier = item.parentIdentifier
                        itemDiff.old!.parentIdentifier = data.parentIdentifier
                    }

                    let newPath: string
                    if (parent) {
                        newPath = parent.path+"."+data.id
                    } else {
                        newPath = ""+data.id
                    }
                    if (newPath !== data.path) {
                        // check children
                        const cnt: any = await sequelize.query('SELECT count(*) FROM items where "deletedAt" IS NULL and "tenantId"=:tenant and path~:lquery', {
                            replacements: {
                                tenant: context.getCurrentUser()!.tenantId,
                                lquery: data.path + '.*{1}',
                            },
                            plain: true,
                            raw: true,
                            type: QueryTypes.SELECT,
                            transaction
                        })
                        const childrenNumber = parseInt(cnt.count)
                        if (childrenNumber > 0) { //move subtree
                            await sequelize.query('update items set path = text2ltree(:parentPath) || subpath(path,:level) where path <@ :oldPath and "tenantId"=:tenant', {
                                replacements: { 
                                    tenant: context.getCurrentUser()!.tenantId,
                                    oldPath: data.path,
                                    parentPath: parent ? parent.path : '',
                                    level: data.path.split('.').length - 1
                                },
                                plain: true,
                                raw: true,
                                type: QueryTypes.UPDATE,
                                transaction
                            })
                        } else { // move leaf
                            data.path = newPath
                        }
                        data.parentIdentifier = parent ? parent.identifier : ""
                    }
                }

                const identifierChange = await changeItemIdentifier({
                    context,
                    item: data,
                    typeNode: mng.getTypeByIdentifier(data.typeIdentifier),
                    newIdentifier: item.newIdentifier,
                    transaction,
                })

                if (identifierChange.changed && audit.auditEnabled()) {
                    itemDiff.changed!.identifier = identifierChange.newIdentifier
                    itemDiff.old!.identifier = identifierChange.oldIdentifier
                }

                if (item.name) {
                    if (audit.auditEnabled()) {
                        const nameDiff: AuditItem = diff({name:data.name}, {name:item.name})
                        itemDiff.added = {...itemDiff.added, ...nameDiff.added}
                        itemDiff.changed = {...itemDiff.changed, ...nameDiff.changed}
                        itemDiff.old = {...itemDiff.old, ...nameDiff.old}
                    }
                    data.name = {...data.name, ...item.name}
                }

                filterEditChannels(context, item.channels)
                checkSubmit(context, item.channels)
                filterValuesNotAllowed(context.getNotEditItemAttributes(data), item.values)
                checkValues(mng, item.values)

                let relAttributesData: any = []
                relAttributesData = await checkRelationAttributes(context, mng, data, item.values, transaction, item.skipActions)

                if (audit.auditEnabled()) {
                    const valuesDiff: AuditItem = diff({values:data.values, channels:data.channels}, {values:item.values, channels:item.channels})
                    itemDiff.added = {...itemDiff.added, ...valuesDiff.added}
                    itemDiff.changed = {...itemDiff.changed, ...valuesDiff.changed}
                    itemDiff.old = {...itemDiff.old, ...valuesDiff.old}
                    itemDiff.deleted = {...itemDiff.deleted, ...valuesDiff.deleted}
                }

                data.values = mergeValues(item.values, data.values)
                data.changed('values', true)
                data.channels = mergeValues(item.channels, data.channels)
                processDeletedChannels(item.channels)
                data.changed('channels', true)
                data.updatedBy = context.getCurrentUser()!.login

                await data.save({ transaction })
                await createRelationsForItemRelAttributes(context, relAttributesData, transaction)
                await transaction.commit()
                if (!item.skipActions) await processItemActions(context, EventType.AfterUpdate, data, item.parentIdentifier, item.name, item.values, item.channels, true, false, false, null)
            } catch(err:any) {
                if (transaction) await transaction.rollback()
                throw new ImportError(err.message)
            }

            if (audit.auditEnabled()) {
                if (!isObjectEmpty(itemDiff!.added) || !isObjectEmpty(itemDiff!.changed) || !isObjectEmpty(itemDiff!.deleted)) audit.auditItem(ChangeType.UPDATE, data.id, data.identifier, itemDiff!, context.getCurrentUser()!.login, data.updatedAt)
            }

            result.id = ""+data.id
            if (data.identifier !== item.identifier) result.identifier = data.identifier
            result.result = ImportResult.UPDATED
        }
    } catch (error) {
        result.addError(ReturnMessage.fromError(error))
        result.result = ImportResult.REJECTED
        logger.error(error)
    }
    return result
}

function checkType(item: IItemImportRequest, result: ImportResponse, mng: ModelManager) : TreeNode<any> | null {
    if (!item.typeIdentifier) {
        result.addError(ReturnMessage.TypeRequired)
        result.result = ImportResult.REJECTED
        return null
    }
    const type = mng.getTypeByIdentifier(item.typeIdentifier)
    if (!type) {
        result.addError(ReturnMessage.ItemTypeNotFound)
        result.result = ImportResult.REJECTED
        return null
    }
    return type
}

async function checkParent(item: IItemImportRequest, result: ImportResponse, mng: ModelManager, context: Context): Promise<Item | null>  {
    let parent = null
    if (!item.parentIdentifier) {
        const tstType = mng.getRoot().getChildren().find(elem => elem.getValue().identifier === item.typeIdentifier)
        if (!tstType) {
            result.addError(ReturnMessage.WrongTypeRoot)
            result.result = ImportResult.REJECTED
            return null
        }
    } else {
        parent = await Item.applyScope(context).findOne({where: { identifier: item.parentIdentifier } })
        if (!parent) {
            result.addError(ReturnMessage.ParentNotFound)
            result.result = ImportResult.REJECTED
            return null
        }
        const parentType = mng.getTypeById(parent.typeId)!
        const itemType = mng.getTypeByIdentifier(item.typeIdentifier)!

        const tstType = parentType.getChildren().find(elem => (elem.getValue().identifier === item.typeIdentifier) || (elem.getValue().link === itemType.getValue().id))
        if (!tstType) {
            result.addError(ReturnMessage.WrongTypeParent)
            result.result = ImportResult.REJECTED
            return null
        }
    }
    return parent
}

function isObject(obj: any)
{
    return obj != null && obj.constructor.name === "Object"
}
