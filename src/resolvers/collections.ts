import Context, { ConfigAccess } from '../context'
import { sequelize } from '../models'
import { Op, literal, FindAndCountOptions } from 'sequelize'
import { Collection } from '../models/collections'
import { CollectionItems } from '../models/collectionItems'
import { EventType } from '../models/actions'
import { processCollectionElemActions } from './utils'

export default {
    Query: {
        getCollectionByIdentifier: async (parent: any, { identifier }: any, context: Context) => {
            context.checkAuth()
            const data = await Collection.applyScope(context).findOne({
                where: {
                    identifier: identifier
                }
            })
            return data
        },
        getCollections: async (parent: any, { onlyMy }: any, context: Context) => {
            context.checkAuth()
            const where:any = {}
            if (onlyMy) {
                where.user = context.getCurrentUser()!.login
            } else {
                where[Op.or] = [{user: context.getCurrentUser()!.login},{public: true}]
            }
            const arr = await Collection.applyScope(context).findAll({ where: where })
            return arr
        }
    },
    Mutation: {
        saveCollections: async (parent: any, { identifier, name, publicCollection }: any, context: Context) => {
            context.checkAuth()
            if (!/^[A-Za-z0-9_-]*$/.test(identifier)) throw new Error('Identifier must not has spaces and must be in English only: ' + identifier + ', tenant: ' + context.getCurrentUser()!.tenantId)

            const data = await Collection.applyScope(context).findOne({
                where: {
                    identifier: identifier
                }
            })

            if (data) {
                if (data.user !== context.getCurrentUser()?.login) {
                    throw new Error('Failed to update collection that belogs to another user by identifier: ' + identifier + ', tenant: ' + context.getCurrentUser()?.tenantId)
                }
                if (name) data.name = name
                data.public = publicCollection ? true : false
                data.updatedBy = context.getCurrentUser()!.login
                await sequelize.transaction(async (t) => {
                    await data.save({transaction: t})
                })
                return data.id
            } else {
                const data = await sequelize.transaction(async (t) => {
                    return await Collection.create ({
                        identifier,
                        tenantId: context.getCurrentUser()!.tenantId,
                        createdBy: context.getCurrentUser()!.login,
                        updatedBy: context.getCurrentUser()!.login,
                        name,
                        public: publicCollection ? true : false,
                        user: context.getCurrentUser()!.login
                    }, {transaction: t})
                })
                return data.id
            }
        },
        removeCollection: async (parent: any, { identifier }: any, context: Context) => {
            context.checkAuth()

            const data = await Collection.applyScope(context).findOne({
                where: {
                    identifier: identifier
                }
            })

            if (data) {
                if (data.user === context.getCurrentUser()?.login) {
                    data.updatedBy = context.getCurrentUser()!.login
                    data.identifier = data.identifier + '_d_' + Date.now() 
                    await sequelize.transaction(async (t) => {
                        await data.save({transaction: t})
                        await data.destroy({transaction: t})
                    }) 
                    return true
                } else {
                    throw new Error('Failed to remove collection that belogs to another user by identifier: ' + identifier + ', tenant: ' + context.getCurrentUser()?.tenantId)
                }
            } else {
                throw new Error('Failed to find collection by identifier: ' + identifier + ', tenant: ' + context.getCurrentUser()?.tenantId)
            }
        },
        addToCollection: async (parent: any, { collectionId, items }: any, context: Context) => {
            context.checkAuth()

            const collection: any = await Collection.applyScope(context).findOne({
                where: {
                    id: collectionId
                }
            })

            if (!(context.getCurrentUser()?.login === collection.user || collection.public)) {
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to add items from collection, tenant: ' + context.getCurrentUser()!.tenantId)
            }

            const values: any = []
            items.map((id: any) => {
                values.push({
                    itemId: id,
                    collectionId,
                    tenantId: context.getCurrentUser()!.tenantId,
                    createdBy: context.getCurrentUser()!.login,
                    updatedBy: context.getCurrentUser()!.login,
                })
            })
            await sequelize.transaction(async (t) => {
                return await CollectionItems.bulkCreate(values, {transaction: t})
            })

            sequelize.query('DELETE FROM "collectionItems" a USING "collectionItems" b WHERE a.id > b.id AND a."itemId" = b."itemId" AND a."collectionId" = b."collectionId";')

            await processCollectionElemActions(context, EventType.AfterCreate, collection, items, false)

            return true
        },
        removeFromCollection: async (parent: any, { collectionId, items }: any, context: Context) => {
            context.checkAuth()

            const collection: any = await Collection.applyScope(context).findOne({
                where: {
                    id: collectionId
                }
            })
            
            if (!(context.getCurrentUser()?.login === collection.user || collection.public)) {
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to remove items from collection, tenant: ' + context.getCurrentUser()!.tenantId)
            }

            items.map((elem: any, index:any) => {
                items[index] = parseInt(elem)
            })

            const data = await CollectionItems.destroy({ 
                where: {
                    itemId: {
                        [Op.in]: items
                    },
                    collectionId
                }    
            })

            await processCollectionElemActions(context, EventType.AfterDelete, collection, items, false)

            return data
        }
    }
}