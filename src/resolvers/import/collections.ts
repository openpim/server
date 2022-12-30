import Context from "../../context"
import { IImportConfig, ImportResponse, ReturnMessage, ImportResult, ImportMode, ICollectionImportRequest, ICollectionItemsImportRequest } from "../../models/import"
import { sequelize } from "../../models"
import { Op } from 'sequelize'
import { Item } from "../../models/items"
import { Collection } from "../../models/collections"
import { CollectionItems } from "../../models/collectionItems"

import logger from '../../logger'


export async function importCollection(context: Context, config: IImportConfig, collection: ICollectionImportRequest): Promise<ImportResponse> {
    const result = new ImportResponse(collection.identifier)

    if (!collection.identifier || !/^[A-Za-z0-9_-]*$/.test(collection.identifier)) {
        result.addError(ReturnMessage.WrongIdentifier)
        result.result = ImportResult.REJECTED
        return result
    }

    try {
        const data = await Collection.applyScope(context).findOne({where: { identifier: collection.identifier }})
        if (collection.delete) {
            if (!data) {
                result.addError(ReturnMessage.CollectionNotFound)
                result.result = ImportResult.REJECTED
            } else {

                data.updatedBy = context.getCurrentUser()!.login
                // we have to change identifier during deletion to make possible that it will be possible to make new type with same identifier
                data.identifier = data.identifier + '_d_' + Date.now() 
                await sequelize.transaction(async (t) => {
                    await data.save({transaction: t})
                    await data.destroy({transaction: t})
                })
                                    
                result.result = ImportResult.DELETED
            }
            return result
        }
        if (config.mode === ImportMode.CREATE_ONLY) {
            if (data) {
                result.addError(ReturnMessage.CollectionExist)
                result.result = ImportResult.REJECTED
                return result
            }
        } else if (config.mode === ImportMode.UPDATE_ONLY) {
            if (!data) {
                result.addError(ReturnMessage.CollectionNotFound)
                result.result = ImportResult.REJECTED
                return result
            }
        }        

        if (!data) {
            // create
            const data = await sequelize.transaction(async (t) => {
                return await Collection.create ({
                    identifier: collection.identifier,
                    tenantId: context.getCurrentUser()!.tenantId,
                    createdBy: context.getCurrentUser()!.login,
                    updatedBy: context.getCurrentUser()!.login,
                    name: collection.name,
                    public: collection.public ? true : false,
                    user: context.getCurrentUser()!.login
                }, {transaction: t})
            })
            result.id = ""+data.id
            result.result = ImportResult.CREATED
        } else {
            // update
            if (collection.name) data.name = collection.name
            data.public = collection.public
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

export async function importCollectionItems(context: Context, config: IImportConfig, collectionItems: ICollectionItemsImportRequest): Promise<ImportResponse> {

    const result = new ImportResponse("collectionItems")

    for (let i in collectionItems.itemIdentifiers) {
        if (!collectionItems.itemIdentifiers[i] || !/^[A-Za-z0-9_-]*$/.test(collectionItems.itemIdentifiers[i])) {
            result.addError(ReturnMessage.WrongIdentifier)
            result.result = ImportResult.REJECTED
            return result
        }
    }

    const collectionIdentifier: any = collectionItems.collectionIdentifier
    const collectionId: any = await Collection.applyScope(context).findOne({
        where: {
            identifier: collectionIdentifier
        }
    })

    const permissions: any = await Collection.applyScope(context).findOne({
        where: {
            id: collectionId.id
        }
    })
    
    if (!(context.getCurrentUser()?.login === permissions.user || permissions.public)) {
        result.addError(ReturnMessage.CollectionItemsAddFailed)
        result.result = ImportResult.REJECTED
        return result
    }
    
    const itemIds = await Item.applyScope(context).findAll({where: { identifier: collectionItems.itemIdentifiers}})
    const ids: any = []
    for (let i in itemIds) {
        ids[i] = itemIds[i].id
    }

    try {
        if (collectionItems.delete) {
            await CollectionItems.destroy({ 
                where: {
                    itemId: {
                        [Op.in]: ids
                    }
                }    
            })
            result.result = ImportResult.DELETED
            sequelize.query('DELETE FROM "collectionItems" a USING "collectionItems" b WHERE a.id > b.id AND a."itemId" = b."itemId" AND a."collectionId" = b."collectionId";')
            return result
        } 
        const values: any = []
        ids.map((id: any) => {
            values.push({
                itemId: id,
                collectionId: collectionId.id,
                tenantId: context.getCurrentUser()!.tenantId,
                createdBy: context.getCurrentUser()!.login,
                updatedBy: context.getCurrentUser()!.login,
            })
        })
        const data: any = await sequelize.transaction(async (t) => {
            return await CollectionItems.bulkCreate(values, {transaction: t})
        })
        result.id = ""+data.id
        result.result = ImportResult.CREATED
    } catch (error) {
        result.addError(new ReturnMessage(0, ""+error))
        result.result = ImportResult.REJECTED
        logger.error(error)
    }
    sequelize.query('DELETE FROM "collectionItems" a USING "collectionItems" b WHERE a.id > b.id AND a."itemId" = b."itemId" AND a."collectionId" = b."collectionId";')
    return result
}