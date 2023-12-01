import Context from "../../context"
import { IImportConfig, IItemRelationImportRequest, ImportResponse, ReturnMessage, ImportResult, ImportMode, ErrorProcessing, ITypeImportRequest, IRelationImportRequest, IAttrGroupImportRequest } from "../../models/import"
import { sequelize } from "../../models"
import { ModelsManager, TreeNode, ModelManager, AttrGroupWrapper } from "../../models/manager"
import { AttrGroup } from "../../models/attributes"

import logger from '../../logger'
import { processAttrGroupActions } from "../utils"
import { EventType } from "../../models/actions"

/*
mutation { import(
    config: {
        mode: CREATE_UPDATE
        errors: PROCESS_WARN
    },
    attrGroups: [
        {
            delete: false
            identifier: "tst",
            name: {ru: "test group"},
            order: 10,
            visible: true
        }
    ]
    ) {
    attrGroups {
	  identifier
	  result
	  id
	  errors { code message }
	  warnings { code message }
	}}}
*/
export async function importAttrGroup(context: Context, config: IImportConfig, group: IAttrGroupImportRequest): Promise<ImportResponse> {
    const result = new ImportResponse(group.identifier)

    if (!group.identifier || !/^[A-Za-z0-9_-]*$/.test(group.identifier)) {
        result.addError(ReturnMessage.WrongIdentifier)
        result.result = ImportResult.REJECTED
        return result
    }

    try {
        const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
        const grp = mng.getAttrGroups().find(grp => grp.getGroup().identifier === group.identifier)
        if (group.delete) {
            if (!grp) {
                result.addError(ReturnMessage.AttrGroupNotFound)
                result.result = ImportResult.REJECTED
            } else {
                const data = grp.getGroup()

                const idx = mng.getAttrGroups().findIndex(grp => grp.getGroup().id === data.id)

                const tst2  = mng.getAttrGroups()[idx].getGroup()
                if ((await tst2!.countAttributes()) > 0) {
                    result.addError(ReturnMessage.AttrGroupDeleteFailed1)
                    result.result = ImportResult.REJECTED
                    return result
                }
    
                // check Roles
                const tst1 = mng.getRoles().find(role => role.itemAccess.groups.includes(data.id) || role.relAccess.groups.includes(data.id))
                if (tst1) {
                    result.addError(ReturnMessage.AttrGroupDeleteFailed2)
                    result.result = ImportResult.REJECTED
                    return result
                }
    
                data.updatedBy = context.getCurrentUser()!.login
                data.identifier = data.identifier + '_d_' + Date.now() 
                await sequelize.transaction(async (t) => {
                    await data!.save({transaction: t})
                    await data!.destroy({transaction: t})
                })
                      
                mng.getAttrGroups().splice(idx, 1)
                
                await processAttrGroupActions(context, EventType.AfterCreate, data, true)
                await mng.reloadModelRemotely(data.id, null, 'ATTRIBUTE_GROUP', true, context.getUserToken())
                result.result = ImportResult.DELETED
            }
            return result
        }

        if (config.mode === ImportMode.CREATE_ONLY) {
            if (grp) {
                result.addError(ReturnMessage.AttrGroupExist)
                result.result = ImportResult.REJECTED
                return result
            }
        } else if (config.mode === ImportMode.UPDATE_ONLY) {
            if (!grp) {
                result.addError(ReturnMessage.AttrGroupNotFound)
                result.result = ImportResult.REJECTED
                return result
            }
        }        

        if (!grp) {
            // create

            const data = await sequelize.transaction(async (t) => {
                return await AttrGroup.create ({
                    identifier: group.identifier,
                    tenantId: context.getCurrentUser()!.tenantId,
                    createdBy: context.getCurrentUser()!.login,
                    updatedBy: context.getCurrentUser()!.login,
                    name: group.name || null,
                    order: group.order != null? group.order : null,
                    visible: group.visible || false,
                    options: group.options ?  group.options : []
                }, {transaction: t})
            })

            mng.getAttrGroups().push(new AttrGroupWrapper(data))
            result.id = ""+data.id

            await processAttrGroupActions(context, EventType.AfterCreate, data, true)
            await mng.reloadModelRemotely(data.id, null, 'ATTRIBUTE_GROUP', false, context.getUserToken())
            result.result = ImportResult.CREATED
        } else {
            // update
            const data = grp.getGroup()
            if (group.name) data.name = group.name
            if (group.order != null) data.order = group.order
            if (group.visible != null) data.visible = group.visible
            if (group.options != null) data.options = group.options
            data.updatedBy = context.getCurrentUser()!.login
            await sequelize.transaction(async (t) => {
                await data.save({transaction: t})
            })

            result.id = ""+data.id

            await processAttrGroupActions(context, EventType.AfterUpdate, data, true)
            await mng.reloadModelRemotely(data.id, null, 'ATTRIBUTE_GROUP', false, context.getUserToken())
            result.result = ImportResult.UPDATED
        } 
    } catch (error) {
        result.addError(new ReturnMessage(0, ""+error))
        result.result = ImportResult.REJECTED
        logger.error(error)
    }

    return result
}
