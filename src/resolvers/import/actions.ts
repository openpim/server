import Context from "../../context"
import { IImportConfig, ImportResponse, ReturnMessage, ImportResult, ImportMode, IActionImportRequest, IActionTriggerImportRequest } from "../../models/import"
import { sequelize } from "../../models"
import { Action } from "../../models/actions"

import logger from '../../logger'
import { TriggerType, EventType } from "../../models/actions"
import { ModelManager, ModelsManager } from "../../models/manager"
import { Item } from "../../models/items"

export async function importAction(context: Context, config: IImportConfig, action: IActionImportRequest): Promise<ImportResponse> {
    const result = new ImportResponse(action.identifier)

    if (!action.identifier || !/^[A-Za-z0-9_-]*$/.test(action.identifier)) {
        result.addError(ReturnMessage.WrongIdentifier)
        result.result = ImportResult.REJECTED
        return result
    }

    try {
        const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
        const idx = mng.getActions().findIndex(elem => elem.identifier === action.identifier)
        if (action.delete) {
            if (idx === -1) {
                result.addError(ReturnMessage.ActionNotFound)
                result.result = ImportResult.REJECTED
            } else {
                const data = mng.getActions()[idx]
                data.updatedBy = context.getCurrentUser()!.login
                // we have to change identifier during deletion to make possible that it will be possible to make new type with same identifier
                data.identifier = data.identifier + '_d_' + Date.now() 
                await sequelize.transaction(async (t) => {
                    await data.save({transaction: t})
                    await data.destroy({transaction: t})
                })
                mng.getActions().splice(idx, 1)

                result.result = ImportResult.DELETED
            }
            return result
        }

        if (config.mode === ImportMode.CREATE_ONLY) {
            if (idx !== -1) {
                result.addError(ReturnMessage.ActionExist)
                result.result = ImportResult.REJECTED
                return result
            }
        } else if (config.mode === ImportMode.UPDATE_ONLY) {
            if (idx === -1) {
                result.addError(ReturnMessage.ActionNotFound)
                result.result = ImportResult.REJECTED
                return result
            }
        }        

        if (idx === -1) {
            // create
            const data:Action = await Action.create ({
                identifier: action.identifier,
                tenantId: context.getCurrentUser()!.tenantId,
                createdBy: context.getCurrentUser()!.login,
                updatedBy: context.getCurrentUser()!.login,
                name: action.name,
                order: action.order != null ? action.order : 0,
                code: action.code || '',
                triggers: action.triggers ? await processTriggers(mng, context, action.triggers, result) : []
            })
            if (result.result) return result

            await sequelize.transaction(async (t) => {
                return await data.save({transaction: t})
            })

            mng.getActions().push(data);

            result.id = ""+data.id
            result.result = ImportResult.CREATED
        } else {
            // update
            const data = mng.getActions()[idx]

            if (action.name) data.name = action.name
            if (action.triggers) {
                data.triggers = await processTriggers(mng, context, action.triggers, result)
                if (result.result) return result
            }
            data.updatedBy = context.getCurrentUser()!.login
            await sequelize.transaction(async (t) => {
                await data.save({transaction: t})
            })

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

async function processTriggers(mng: ModelManager, context: Context, triggers: [IActionTriggerImportRequest], result: ImportResponse) {
    const res:any[] = []

    for(const trigger of triggers) {
        const data:any = {type: TriggerType[trigger.type as any], 
            event: trigger.event ? EventType[trigger.event as any] : null,
            itemButton: trigger.itemButton,
            selectItems: trigger.selectItems,
            askBeforeExec: trigger.askBeforeExec,
            selectItemsFilter: trigger.selectItemsFilter,
            itemFrom: 0,
            itemType: 0,
            relation: 0,
            roles: []
        }

        if (trigger.roles) {
            const arr = []
            for (let index = 0; index < trigger.roles.length; index++) {
                const roleIdentifier = trigger.roles[index];
                const tst = mng.getRoles().find(elem => elem.identifier === roleIdentifier)
                if (!tst) {
                    result.addError(ReturnMessage.RoleNotFound)
                    result.result = ImportResult.REJECTED
                    return null
                }
                arr.push(tst.id)
            }
            data.roles = arr
        }
        if (trigger.itemType) {
            const tst = mng.getTypeByIdentifier(trigger.itemType)
            if (!tst) {
                result.addError(ReturnMessage.TypeNotFound)
                result.result = ImportResult.REJECTED
                return null
            }
            data.itemType = tst.getValue().id
        }
        if (trigger.itemFrom) {
            const itemFrom = await Item.applyScope(context).findOne({ where: { identifier: trigger.itemFrom} })
            if (!itemFrom) {
                result.addError(ReturnMessage.ActionItemFromNotFound)
                result.result = ImportResult.REJECTED
                return null
            }
            data.itemFrom = itemFrom.id
        }
        if (trigger.relation) {
            const tst = mng.getRelationByIdentifier(trigger.relation)
            if (!tst) {
                result.addError(ReturnMessage.RelationNotFound)
                result.result = ImportResult.REJECTED
                return null
            }
            data.relation = tst.id
        }
        res.push(data)
    }

    return res
}
