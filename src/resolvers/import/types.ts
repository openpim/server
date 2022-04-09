import Context from "../../context"
import { IImportConfig, IItemRelationImportRequest, ImportResponse, ReturnMessage, ImportResult, ImportMode, ErrorProcessing, ITypeImportRequest } from "../../models/import"
import { sequelize } from "../../models"
import { ModelsManager, TreeNode, ModelManager } from "../../models/manager"
import { Type } from "../../models/types"
import { QueryTypes } from "sequelize"
import e = require("express")
import { Relation } from "../../models/relations"
import { Attribute } from "../../models/attributes"
import { Item } from "../../models/items"
import { Op, literal } from 'sequelize'

import logger from '../../logger'

/*
mutation { import(
    config: {
        mode: CREATE_UPDATE
        errors: PROCESS_WARN
    },
    types: [
        {
            delete: false
            identifier: "tst",
            parentIdentifier: "",
            name: {ru: "test type2"}
            icon: "folder",
            iconColor: "red"
        }
    ]
    ) {
    types {
	  identifier
	  result
	  id
	  errors { code message }
	  warnings { code message }
    }}}
    
*/
export async function importType(context: Context, config: IImportConfig, type: ITypeImportRequest): Promise<ImportResponse> {
    const result = new ImportResponse(type.identifier)

    if (!type.identifier || !/^[A-Za-z0-9_-]*$/.test(type.identifier)) {
        result.addError(ReturnMessage.WrongIdentifier)
        result.result = ImportResult.REJECTED
        return result
    }

    try {
        const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
        if (type.delete) {
            const typeNode = mng.getTypeByIdentifier(type.identifier)
            if (!typeNode) {
                result.addError(ReturnMessage.TypeNotFound)
                result.result = ImportResult.REJECTED
            } else {
                if (typeNode.getChildren().length > 0) {
                    result.addError(ReturnMessage.TypeDeleteFailed)
                    result.result = ImportResult.REJECTED
                } else {
                    const parentNode = typeNode.getParent()!
                    parentNode.deleteChild(typeNode)
        
                    const type:Type = typeNode.getValue()

                    const nId = type.id
                    // check Roles
                    const tst4 = mng.getRoles().find(role => role.itemAccess.valid.includes(nId))
                    // check Relations
                    //const tst3 = await Relation.applyScope(context).findOne({
                    //    where: {[Op.or]: [{sources: { [Op.contains]: nId}}, {targets: { [Op.contains]: nId}}]}
                    //})
                    const tst3 = await Relation.applyScope(context).findOne({
                        where: {[Op.or]: [literal("sources @> '"+nId+"'"), literal("targets @> '"+nId+"'")]}
                    })
                    // check Attributes
                    // const tst2 = await Attribute.applyScope(context).findOne({where: {valid: { [Op.contains]: nId}}})
                    const tst2 = await Attribute.applyScope(context).findOne({where: literal("valid @> '"+nId+"'")})
                    // check Items
                    const tst1 = await Item.applyScope(context).findOne({where: {typeId: nId}})
                    // check Linked types
                    const tst5 = mng.getTypeByLinkId(nId)

                    if (tst1 || tst2 || tst3 || tst4 || tst5) {
                        result.addError(ReturnMessage.TypeCanNotDelete)
                        result.result = ImportResult.REJECTED
                        return result
                    }

                    type.updatedBy = context.getCurrentUser()!.login
                    type.identifier = type.identifier + '_d_' + Date.now() 
                    await sequelize.transaction(async (t) => {
                        await type.save({transaction: t})
                        await type.destroy({transaction: t})
                    })
        
                    result.result = ImportResult.DELETED
                }
            }
            return result
        }

        const typeNode = mng.getTypeByIdentifier(type.identifier)
        if (config.mode === ImportMode.CREATE_ONLY) {
            if (typeNode) {
                result.addError(ReturnMessage.TypeExist)
                result.result = ImportResult.REJECTED
                return result
            }
        } else if (config.mode === ImportMode.UPDATE_ONLY) {
            if (!typeNode) {
                result.addError(ReturnMessage.TypeNotFound)
                result.result = ImportResult.REJECTED
                return result
            }
        }        

        if (!typeNode) {
            // create
            let parentNode: TreeNode<any> | null = null
            if (type.parentIdentifier) {
                parentNode = mng.getTypeByIdentifier(type.parentIdentifier)
                if (!parentNode) {
                    result.addError(ReturnMessage.TypeParentNotFound)
                    result.result = ImportResult.REJECTED
                    return result
                }
            }

            let link:Type
            if (type.linkIdentifier) {
                link = mng.getTypeByIdentifier(type.linkIdentifier)?.getValue()
                if (!link) {
                    result.addError(ReturnMessage.TypeLinkNotFound)
                    result.result = ImportResult.REJECTED
                    return result
                }
            }

            const results:any = await sequelize.query("SELECT nextval('types_id_seq')", { 
                type: QueryTypes.SELECT
            });
            const newId = (results[0]).nextval

            let path = '' + newId
            let parentId = null
            if (parentNode) {
                parentId = parentNode?.getValue().id
                while(parentNode != mng.getRoot()) {
                    path = parentNode!.getValue().id + '.' + path
                    parentNode = parentNode!.getParent()
                }
            }

            let images = checkRelations(type, mng, result)
            if (result.result) return result

            let mainImageId = 0
            if (type.mainImage) {
                const tst = mng.getRelationByIdentifier(type.mainImage)
                if (!tst) {
                    result.addWarning(ReturnMessage.RelationNotFound)
                } else {
                    mainImageId = tst.id;
                }
            }

            const data = await sequelize.transaction(async (t) => {
                return await Type.create ({
                    id: newId,
                    path: path,
                    identifier: type.identifier,
                    icon: type.icon,
                    iconColor: type.iconColor,
                    tenantId: context.getCurrentUser()!.tenantId,
                    createdBy: context.getCurrentUser()!.login,
                    updatedBy: context.getCurrentUser()!.login,
                    name: type.name || null,
                    link: link ? link.id : 0,
                    file: type.file != null ? type.file : false,
                    mainImage: mainImageId,
                    images: images,
                    options: type.options ?  type.options : []
                }, {transaction: t})
            })
            mng.addType(parentId, data)

            result.id = ""+data.id
            result.result = ImportResult.CREATED
        } else {
            // update
            if (type.parentIdentifier) {
                result.addWarning(ReturnMessage.TypeUpdateParent);
                if (config.errors == ErrorProcessing.WARN_REJECTED) {
                    result.result = ImportResult.REJECTED
                    return result
                }
            }

            if (type.linkIdentifier) {
                result.addWarning(ReturnMessage.TypeUpdateLink);
                if (config.errors == ErrorProcessing.WARN_REJECTED) {
                    result.result = ImportResult.REJECTED
                    return result
                }
            }

            const data: Type = typeNode.getValue()
            if (type.name) data.name = type.name
            if (type.icon) data.icon = type.icon
            if (type.iconColor) data.iconColor = type.iconColor
            if (type.file != null) data.file = type.file

            if (type.images) {
                data.images = checkRelations(type, mng, result)
                if (result.result) return result
            }

            if (type.mainImage) {
                const tst = mng.getRelationByIdentifier(type.mainImage)
                if (!tst) {
                    result.addWarning(ReturnMessage.RelationNotFound)
                } else {
                    data.mainImage = tst.id;
                }
            }
            if (type.options != null) data.options = type.options

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

function checkRelations(type: ITypeImportRequest, mng: ModelManager, result: ImportResponse) {
    let rels: number[] = []
    if (type.images) {
        for (let index = 0; index < type.images.length; index++) {
            const relIdentifier = type.images[index];
            const tst = mng.getRelationByIdentifier(relIdentifier)
            if (!tst) {
                result.addWarning(ReturnMessage.RelationNotFound)
            } else {
                rels.push(tst.id)
            }
        }
    }
    return rels
}

