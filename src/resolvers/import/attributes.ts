import Context from "../../context"
import { IImportConfig, ImportResponse, ReturnMessage, ImportResult, ImportMode, IRelationImportRequest,  IAttributeImportRequest } from "../../models/import"
import { sequelize } from "../../models"
import { ModelsManager, TreeNode, ModelManager, AttrGroupWrapper } from "../../models/manager"
import { AttrGroup, Attribute } from "../../models/attributes"
import { Item } from "../../models/items"
import { LOV } from "../../models/lovs"

import logger from '../../logger'
import { processAttributeActions } from "../utils"
import { EventType } from "../../models/actions"

/*
mutation { import(
    config: {
        mode: CREATE_UPDATE
        errors: PROCESS_WARN
    },
    attributes: [
        {
            delete: false
            identifier: "tst",
            name: {ru: "test attribute"},
            valid: ["sa1_2"],
            visible: ["itemLevel1"],
            relations: ["rel1"],
            order: 10,
            languageDependent: true,
            groups: ["grp1"]
        }
    ]
    ) {
    attributes {
	  identifier
	  result
	  id
	  errors { code message }
	  warnings { code message }
	}}}
*/
export async function importAttribute(context: Context, config: IImportConfig, attr: IAttributeImportRequest): Promise<ImportResponse> {
    const result = new ImportResponse(attr.identifier)

    if (!attr.identifier || !/^[A-Za-z0-9_]*$/.test(attr.identifier)) {
        result.addError(ReturnMessage.WrongIdentifier)
        result.result = ImportResult.REJECTED
        return result
    }

    try {
        const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
        const attribute = mng.getAttributeByIdentifier(attr.identifier, true)
        if (attr.delete) {
            if (!attribute) {
                result.addError(ReturnMessage.AttributeNotFound)
                result.result = ImportResult.REJECTED
            } else {
                const data = attribute.attr
                data.updatedBy = context.getCurrentUser()!.login
                data.identifier = data.identifier + '_d_' + Date.now() 
                await sequelize.transaction(async (t) => {
                    await data!.save({transaction: t})
                    await data!.destroy({transaction: t})
                })
    
                for (let i=0; i < mng.getAttrGroups().length; i++) {
                    const grp = mng.getAttrGroups()[i]
                    const idx = grp.getAttributes().findIndex((attr) => { return attr.id === data.id })
                    if (idx !== -1) {
                        grp.getAttributes().splice(idx, 1)
                    }
                }
                        
                await processAttributeActions(context, EventType.AfterDelete, data, true)
                
                result.result = ImportResult.DELETED
            }
            return result
        }

        if (config.mode === ImportMode.CREATE_ONLY) {
            if (attribute) {
                result.addError(ReturnMessage.AttributeExist)
                result.result = ImportResult.REJECTED
                return result
            }
        } else if (config.mode === ImportMode.UPDATE_ONLY) {
            if (!attribute) {
                result.addError(ReturnMessage.AttributeNotFound)
                result.result = ImportResult.REJECTED
                return result
            }
        }        

        if (!attribute) {
            // create
            let valid = checkValid(attr, mng, result)
            if (result.result) return result

            let visible = await checkVisible(attr, context, result)
            if (result.result) return result

            let relations = checkRelations(attr, mng, result)
            if (result.result) return result

            let groups = checkGroups(attr, mng, result)
            if (result.result) return result

            if (groups.length === 0) {
                result.addError(ReturnMessage.AttributeGroupRequired)
                result.result = ImportResult.REJECTED
                return result
            }

            const lov = attr.lov ? (await LOV.applyScope(context).findOne({where: {identifier: attr.lov}}))?.id : 0

            const data = await sequelize.transaction(async (t) => {
                const data = await Attribute.create ({
                    identifier: attr.identifier,
                    tenantId: context.getCurrentUser()!.tenantId,
                    createdBy: context.getCurrentUser()!.login,
                    updatedBy: context.getCurrentUser()!.login,
                    name: attr.name || null,
                    order: attr.order != null? attr.order : 0,
                    valid: valid,
                    visible: visible,
                    relations: relations,
                    languageDependent: attr.languageDependent || false,
                    type: attr.type || 1,
                    pattern: attr.pattern || '',
                    errorMessage: attr.errorMessage || {ru:""},
                    lov: lov,
                    richText: attr.richText != null ? attr.richText : false,
                    multiLine: attr.multiLine != null ? attr.multiLine : false,
                    options: attr.options ?  attr.options : []
                }, {transaction: t})

                for (let i = 0; i < groups.length; i++) {
                    await groups[i].getGroup().addAttribute(data, {transaction: t})
                    groups[i].getAttributes().push(data)
                }

                return data
            })

            result.id = ""+data.id

            await processAttributeActions(context, EventType.AfterCreate, data, true)

            result.result = ImportResult.CREATED
        } else {
            // update
            const data = attribute.attr

            let valid = checkValid(attr, mng, result)
            if (result.result) return result

            let visible = await checkVisible(attr, context, result)
            if (result.result) return result

            let relations = checkRelations(attr, mng, result)
            if (result.result) return result

            let groups = checkGroups(attr, mng, result)
            if (result.result) return result
            if (attr.groups && groups.length == 0) {
                result.addError(ReturnMessage.AttributeGroupRequired)
                result.result = ImportResult.REJECTED
                return result
            }

            if (attr.name) data.name = attr.name
            if (attr.languageDependent != null) data.languageDependent = attr.languageDependent
            if (attr.order != null) data.order = attr.order
            if (attr.valid) data.valid = valid
            if (attr.visible) data.visible = visible
            if (attr.relations) data.relations = relations
            if (attr.type) data.type = attr.type
            if (attr.pattern != null) data.pattern = attr.pattern
            if (attr.errorMessage != null) data.errorMessage = attr.errorMessage
            if (attr.lov) {
                data.lov = (await LOV.applyScope(context).findOne({where: {identifier: attr.lov}}))!.id
            }
            if (attr.richText != null) data.richText = attr.richText
            if (attr.multiLine != null) data.multiLine = attr.multiLine
            if (attr.options != null) data.options = attr.options

            data.updatedBy = context.getCurrentUser()!.login
            await sequelize.transaction(async (t) => {
                await data.save({transaction: t})

                if (attr.groups) {
                    for (let i=0; i < mng.getAttrGroups().length; i++) {
                        const grp = mng.getAttrGroups()[i]
                        const idx = grp.getAttributes().findIndex(attr => attr.id === data.id )
                        if (idx !== -1) {
                            const idxGroups = groups.findIndex(group => group.getGroup().id === grp.getGroup().id)
                            if (idxGroups === -1) {
                                grp.getGroup().removeAttribute(data, {transaction: t})
                                grp.getAttributes().splice(idx, 1)
                            } else {
                                groups.splice(idxGroups, 1)
                            }
                        }
                    }

                    for (let i = 0; i < groups.length; i++) {
                        await groups[i].getGroup().addAttribute(data, {transaction: t})
                        groups[i].getAttributes().push(data)
                    }
                }
            })

            result.id = ""+data.id

            await processAttributeActions(context, EventType.AfterUpdate, data, true)

            result.result = ImportResult.UPDATED
        } 
    } catch (error) {
        result.addError(new ReturnMessage(0, ""+error))
        result.result = ImportResult.REJECTED
        logger.error(error)
    }

    return result
}

function checkValid(attr: IAttributeImportRequest, mng: ModelManager, result: ImportResponse) {
    let valid: number[] = []
    if (attr.valid) {
        for (let index = 0; index < attr.valid.length; index++) {
            const typeIdentifier = attr.valid[index];
            const tst = mng.getTypeByIdentifier(typeIdentifier)
            if (!tst) {
                result.addError(ReturnMessage.TypeNotFound)
                result.result = ImportResult.REJECTED
                return <number[]>[]
            }
            valid.push(tst.getValue().id)
        }
    }
    return valid
}

async function checkVisible(attr: IAttributeImportRequest, context: Context, result: ImportResponse) {
    if (attr.visible) {
        const items = await Item.applyScope(context).findAll({ where: { identifier: attr.visible} })
        return items.map(item => item.id)
    } else {
        return []
    }
}

function checkRelations(attr: IAttributeImportRequest, mng: ModelManager, result: ImportResponse) {
    let rels: number[] = []
    if (attr.relations) {
        for (let index = 0; index < attr.relations.length; index++) {
            const relIdentifier = attr.relations[index];
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

function checkGroups(attr: IAttributeImportRequest, mng: ModelManager, result: ImportResponse) {
    const groups: AttrGroupWrapper[] = []
    if (attr.groups) {
        for (let index = 0; index < attr.groups.length; index++) {
            const grpIdentifier = attr.groups[index];
            const tst = mng.getAttrGroups().find(grp => grp.getGroup().identifier === grpIdentifier)
            if (!tst) {
                result.addError(ReturnMessage.AttrGroupNotFound)
                result.result = ImportResult.REJECTED
                return <AttrGroupWrapper[]>[]
            }
            groups.push(tst)
        }
    }
    return groups
}
