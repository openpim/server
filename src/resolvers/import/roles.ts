import Context from "../../context"
import { IImportConfig, ImportResponse, ReturnMessage, ImportResult, ImportMode, IRelationImportRequest,  IAttributeImportRequest, IRoleImportRequest, IGroupsAccessRequest } from "../../models/import"
import { sequelize } from "../../models"
import { ModelsManager, ModelManager, AttrGroupWrapper } from "../../models/manager"
import { Item } from "../../models/items"
import { Role, User } from "../../models/users"
import { Op } from 'sequelize'

import logger from '../../logger'

/*

mutation { import(
    config: {
        mode: CREATE_UPDATE
        errors: PROCESS_WARN
    },
    roles: [
        {
        delete: false,
        name: "Администратор2",
        itemAccess: {access:0, valid:[], groups:[], fromItems:[]},
        configAccess: {lovs:2,roles:2,types:2,users:2,languages:2,relations:2,attributes:2},
        identifier: "admin2",
        relAccess: {access:0,relations:[],groups:[]},
        }
    ]
    ) {
    roles {
        identifier
        result
        id
        errors { code message }
        warnings { code message }
}}}

*/

export async function importRole(context: Context, config: IImportConfig, role: IRoleImportRequest): Promise<ImportResponse> {
    const result = new ImportResponse(role.identifier)

    if (!role.identifier || !/^[A-Za-z0-9_]*$/.test(role.identifier)) {
        result.addError(ReturnMessage.WrongIdentifier)
        result.result = ImportResult.REJECTED
        return result
    }

    try {
        if (role.identifier === 'admin') {
            result.addError(ReturnMessage.RoleAdminCanNotBeUpdated)
            result.result = ImportResult.REJECTED
            return result
        }

        const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
        const idx = mng.getRoles().findIndex(elem => elem.identifier === role.identifier)
        if (role.delete) {
            if (idx === -1) {
                result.addError(ReturnMessage.RoleNotFound)
                result.result = ImportResult.REJECTED
            } else {
                const data = mng.getRoles()[idx]
                if (data.identifier === 'admin') {
                    result.addError(ReturnMessage.RoleAdminCanNotBeUpdated)
                    result.result = ImportResult.REJECTED
                    return result
                }
    
                // check Users
                const tst1 = await User.applyScope(context).findOne({where: {roles: { [Op.contains]: data.id}}})
                if (tst1) {
                    result.addError(ReturnMessage.RoleDeleteFailed)
                    result.result = ImportResult.REJECTED
                    return result
                }

                data.updatedBy = context.getCurrentUser()!.login
                data.identifier = role.identifier + '_d_' + Date.now() 
                await sequelize.transaction(async (t) => {
                    await data.save({transaction: t})
                    await data.destroy({transaction: t})
                })
    
                mng.getRoles().splice(idx, 1)
                mng.getUsers().forEach(wrapper => {
                    const idx = wrapper.getRoles().findIndex(r => r.id === data.id)
                    if (idx !== -1) wrapper.getRoles().splice(idx, 1)
                })
                                
                result.result = ImportResult.DELETED
            }
            return result
        }

        if (config.mode === ImportMode.CREATE_ONLY) {
            if (idx !== -1) {
                result.addError(ReturnMessage.RoleExist)
                result.result = ImportResult.REJECTED
                return result
            }
        } else if (config.mode === ImportMode.UPDATE_ONLY) {
            if (idx === -1) {
                result.addError(ReturnMessage.RoleNotFound)
                result.result = ImportResult.REJECTED
                return result
            }
        }        

        if (idx === -1) {
            // create
            let relationIds = checkRelations(role.relAccess.relations, mng, result)
            if (result.result) return result
            let groups = checkGroups(role.relAccess.groups, mng, result)
            if (result.result) return result
            const relAccess = {access: role.relAccess.access || 0, relations: relationIds, groups: groups}

            let valid = checkValid(role.itemAccess.valid, mng, result)
            if (result.result) return result
            let groups2 = checkGroups(role.itemAccess.groups, mng, result)
            if (result.result) return result
            let fromItems = await checkFromItems(role.itemAccess.fromItems, context, result)
            if (result.result) return result
            const itemAccess = { valid: valid, fromItems: fromItems, access: role.itemAccess.access || 0, groups: groups2 }

            const data = await sequelize.transaction(async (t) => {
                return await Role.create ({
                    identifier: role.identifier,
                    tenantId: context.getCurrentUser()!.tenantId,
                    createdBy: context.getCurrentUser()!.login,
                    updatedBy: context.getCurrentUser()!.login,
                    name: role.name || '',
                    configAccess: role.configAccess || { types: 0, attributes: 0, relations: 0, users: 0, roles: 0, languages: 0 },
                    relAccess: relAccess,
                    itemAccess: itemAccess
                }, {transaction: t})
            })

            mng.getRoles().push(data);

            result.id = ""+data.id
            result.result = ImportResult.CREATED
        } else {
            // update
            const data = mng.getRoles()[idx]

            if (role.name) data.name = role.name
            if (role.configAccess) data.configAccess = role.configAccess
            if (role.relAccess) {
                let relationIds = checkRelations(role.relAccess.relations, mng, result)
                if (result.result) return result
                let groups = checkGroups(role.relAccess.groups, mng, result)
                if (result.result) return result
                const relAccess = {access: role.relAccess.access || 0, relations: relationIds, groups: groups}
        
                data.relAccess = relAccess
            }
            if (role.itemAccess) {
                let valid = checkValid(role.itemAccess.valid, mng, result)
                if (result.result) return result
                let groups2 = checkGroups(role.itemAccess.groups, mng, result)
                if (result.result) return result
                let fromItems = await checkFromItems(role.itemAccess.fromItems, context, result)
                if (result.result) return result
                const itemAccess = { valid: valid, fromItems: fromItems, access: role.itemAccess.access || 0, groups: groups2 }
                
                data.itemAccess = itemAccess
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

function checkRelations(relations: [string], mng: ModelManager, result: ImportResponse) {
    let rels: number[] = []
    if (relations) {
        for (let index = 0; index < relations.length; index++) {
            const relIdentifier = relations[index];
            const tst = mng.getRelationByIdentifier(relIdentifier)
            if (!tst) {
                result.addError(ReturnMessage.RelationNotFound)
                result.result = ImportResult.REJECTED
                return <number[]>[]
            }
            rels.push(tst.id)
        }
    }
    return rels
}

function checkGroups(groups: [IGroupsAccessRequest], mng: ModelManager, result: ImportResponse) {
    const arr: any[] = []
    if (groups) {
        for (let index = 0; index < groups.length; index++) {
            const data = groups[index]
            const grpIdentifier = data.groupIdentifier;
            const tst = mng.getAttrGroups().find(grp => grp.getGroup().identifier === grpIdentifier)
            if (!tst) {
                result.addError(ReturnMessage.AttrGroupNotFound)
                result.result = ImportResult.REJECTED
                return <AttrGroupWrapper[]>[]
            }
            arr.push({access: data.access, groupId: tst.getGroup().id})
        }
    }
    return arr
}

function checkValid(valid: [string], mng: ModelManager, result: ImportResponse) {
    let arr: number[] = []
    if (valid) {
        for (let index = 0; index < valid.length; index++) {
            const typeIdentifier = valid[index];
            const tst = mng.getTypeByIdentifier(typeIdentifier)
            if (!tst) {
                result.addError(ReturnMessage.TypeNotFound)
                result.result = ImportResult.REJECTED
                return <number[]>[]
            }
            arr.push(tst.getValue().id)
        }
    }
    return arr
}

async function checkFromItems(identifiers: [string], context: Context, result: ImportResponse) {
    if (identifiers) {
        const items = await Item.applyScope(context).findAll({ where: { identifier: identifiers} })
        return items.map(item => item.id)
    } else {
        return []
    }
}
