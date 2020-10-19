import Context from '../../context'
import { IItemImportRequest, ImportResponse, IImportConfig, ImportMode, ReturnMessage, ImportResult} from '../../models/import'
import { Item } from '../../models/items'
import { sequelize } from '../../models'
import { QueryTypes } from 'sequelize'
import { ModelsManager, ModelManager, TreeNode } from '../../models/manager'
import { filterValues, mergeValues, checkValues, processItemActions } from '../utils'
import { Attribute } from '../../models/attributes'
import { Op } from 'sequelize'
import { EventType } from '../../models/actions'
import { ItemRelation } from '../../models/itemRelations'

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

    if (!item.identifier || !/^[A-Za-z0-9_]*$/.test(item.identifier)) {
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
                const tst2 = await Attribute.applyScope(context).findOne({where: {visible: { [Op.contains]: data.id}}})
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

                data.updatedBy = context.getCurrentUser()!.login

                await processItemActions(context, EventType.BeforeDelete, data, null, true)

                data.identifier = item.identifier + '_d_' + Date.now() 
                await sequelize.transaction(async (t) => {
                    await data.save({transaction: t})
                    await data.destroy({transaction: t})
                })

                await processItemActions(context, EventType.AfterDelete, data, null, true)

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

            const data = await Item.build ({
                id: id,
                path: path,
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
            await processItemActions(context, EventType.BeforeCreate, data, item.values, true)

            filterValues(context.getEditItemAttributes2(type!.getValue().id, path), item.values)
            try {
                checkValues(mng, item.values)
            } catch (err) {
                result.addError(new ReturnMessage(0, err.message))
                result.result = ImportResult.REJECTED
                return result
            }

            data.values = item.values

            await sequelize.transaction(async (t) => {
                await data.save({transaction: t})
            })

            await processItemActions(context, EventType.AfterCreate, data, item.values, true)

            result.id = ""+data.id
            result.result = ImportResult.CREATED
        } else {
            // update

            if (!context.canEditItem(data)) {
                result.addError(ReturnMessage.ItemNoAccess)
                result.result = ImportResult.REJECTED
                return result
            }

            if (item.typeIdentifier) {
                const type = checkType(item, result, mng)
                if (result.result) return result
                
                if (data.typeId !== type!.getValue().id) {
                    data.typeId = type!.getValue().id
                    data.typeIdentifier = type!.getValue().identifier
                }
            }

            if (item.parentIdentifier) {
                let parent = await checkParent(item, result, mng, context)
                if (result.result) return result
    
                let newPath: string
                if (parent) {
                    newPath = parent.path+"."+data.id
                } else {
                    newPath = ""+data.id
                }
                if (newPath !== data.path) {
                    data.path = newPath
                    data.parentIdentifier = parent ? parent.identifier : ""
                }
            }

            if (item.name) data.name = {...data.name, ...item.name}

            if (!item.values) item.values = {}
            await processItemActions(context, EventType.BeforeUpdate, data, item.values, true)

            filterValues(context.getEditItemAttributes(data), item.values)
            try {
                checkValues(mng, item.values)
            } catch (err) {
                result.addError(new ReturnMessage(0, err.message))
                result.result = ImportResult.REJECTED
                return result
            }

            data.values = mergeValues(item.values, data.values)

            data.updatedBy = context.getCurrentUser()!.login
            await sequelize.transaction(async (t) => {
                await data!.save({transaction: t})
            })

            await processItemActions(context, EventType.AfterUpdate, data, item.values, true)

            result.id = ""+data.id
            result.result = ImportResult.UPDATED
        }
    } catch (error) {
        result.addError(new ReturnMessage(0, ""+error))
        result.result = ImportResult.REJECTED
        console.error(error)
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