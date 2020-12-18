import Context from "../../context"
import { IImportConfig, IItemRelationImportRequest, ImportResponse, ReturnMessage, ImportResult, ImportMode, ErrorProcessing, ITypeImportRequest, IRelationImportRequest } from "../../models/import"
import { sequelize } from "../../models"
import { ModelsManager, TreeNode, ModelManager } from "../../models/manager"
import { Relation } from "../../models/relations"
import { Attribute } from "../../models/attributes"
import { ItemRelation } from "../../models/itemRelations"
import { Op } from 'sequelize'

import logger from '../../logger'

/*
mutation { import(
    config: {
        mode: CREATE_UPDATE
        errors: PROCESS_WARN
    },
    relations: [
        {
            delete: false
            identifier: "tst",
            name: {ru: "test relation"},
            sources: ["level1_2"],
            targets: ["other1_2"],
            child: false,
            multi: true
        }
    ]
    ) {
    relations {
	  identifier
	  result
	  id
	  errors { code message }
	  warnings { code message }
    }}}
*/
export async function importRelation(context: Context, config: IImportConfig, relation: IRelationImportRequest): Promise<ImportResponse> {
    const result = new ImportResponse(relation.identifier)

    if (!relation.identifier || !/^[A-Za-z0-9_]*$/.test(relation.identifier)) {
        result.addError(ReturnMessage.WrongIdentifier)
        result.result = ImportResult.REJECTED
        return result
    }

    try {
        const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
        if (relation.delete) {
            const data = mng.getRelationByIdentifier(relation.identifier)
            if (!data) {
                result.addError(ReturnMessage.RelationNotFound)
                result.result = ImportResult.REJECTED
            } else {
                // check Attributes
                const tst2 = await Attribute.applyScope(context).findOne({where: {relations: { [Op.contains]: data.id}}})
                // check ItemRelations
                const tst1 = await ItemRelation.applyScope(context).findOne({where: {relationId: data.id}})
                if (tst1 || tst2) {
                    result.addError(ReturnMessage.RelationCanNotDelete)
                    result.result = ImportResult.REJECTED
                    return result
                }

                data.updatedBy = context.getCurrentUser()!.login
                data.identifier = data.identifier + '_d_' + Date.now() 
                await sequelize.transaction(async (t) => {
                    await data!.save({transaction: t})
                    await data!.destroy({transaction: t})
                })
    
                const idx = mng.getRelations().findIndex( (rel) => rel.id === data.id)    
                mng.getRelations().splice(idx, 1)
                    
                result.result = ImportResult.DELETED
            }
            return result
        }

        const data = mng.getRelationByIdentifier(relation.identifier)
        if (config.mode === ImportMode.CREATE_ONLY) {
            if (data) {
                result.addError(ReturnMessage.RelationExist)
                result.result = ImportResult.REJECTED
                return result
            }
        } else if (config.mode === ImportMode.UPDATE_ONLY) {
            if (!data) {
                result.addError(ReturnMessage.RelationNotFound)
                result.result = ImportResult.REJECTED
                return result
            }
        }        

        if (!data) {
            // create
            let sources = checkSources(relation, mng, result)
            if (result.result) return result

            let targets = checkTargets(relation, mng, result)
            if (result.result) return result

            const data = await sequelize.transaction(async (t) => {
                return await Relation.create ({
                    identifier: relation.identifier,
                    tenantId: context.getCurrentUser()!.tenantId,
                    createdBy: context.getCurrentUser()!.login,
                    updatedBy: context.getCurrentUser()!.login,
                    name: relation.name,
                    sources: {data: sources},
                    targets: {data: targets},
                    child: relation.child || false,
                    multi: relation.multi || false
                }, {transaction: t})
            })
            mng.getRelations().push(data)

            result.id = ""+data.id
            result.result = ImportResult.CREATED
        } else {
            // update
            let sources = checkSources(relation, mng, result)
            if (result.result) return result

            let targets = checkTargets(relation, mng, result)
            if (result.result) return result

            if (relation.name) data.name = relation.name
            if (relation.child != null) data.child = relation.child
            if (relation.multi != null) data.multi = relation.multi
            if (relation.sources) data.sources = {data: sources}
            if (relation.targets) data.targets = {data: targets}
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

function checkSources(relation: IRelationImportRequest, mng: ModelManager, result: ImportResponse) {
    let sources: number[] = []
    if (relation.sources) {
        for (let index = 0; index < relation.sources.length; index++) {
            const typeIdentifier = relation.sources[index];
            const tst = mng.getTypeByIdentifier(typeIdentifier)
            if (!tst) {
                result.addError(ReturnMessage.TypeNotFound)
                result.result = ImportResult.REJECTED
                return result
            }
            sources.push(tst.getValue().id)
        }
    }
    return sources
}

function checkTargets(relation: IRelationImportRequest, mng: ModelManager, result: ImportResponse) {
    let targets: number[] = []
    if (relation.targets) {
        for (let index = 0; index < relation.targets.length; index++) {
            const typeIdentifier = relation.targets[index];
            const tst = mng.getTypeByIdentifier(typeIdentifier)
            if (!tst) {
                result.addError(ReturnMessage.TypeNotFound)
                result.result = ImportResult.REJECTED
                return result
            }
            targets.push(tst.getValue().id)
        }
    }
    return targets
}