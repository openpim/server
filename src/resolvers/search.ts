import Context, { ConfigAccess } from '../context'
import { Type } from '../models/types'
import { Item } from '../models/items'
import { FindAndCountOptions, CountWithOptions, FindOptions, WhereOptions, Includeable } from 'sequelize/types'
import { Attribute, AttrGroup } from '../models/attributes'
import { Relation } from '../models/relations'
import { ItemRelation } from '../models/itemRelations'
import { ModelsManager } from '../models/manager'
import { filterChannels, filterValues } from './utils'
import { User, Role } from '../models/users'
import { LOV } from '../models/lovs'
import { SavedColumns, SavedSearch } from '../models/search'
import { sequelize } from '../models'
import { Op } from 'sequelize'

/* sample search request
query { search(
    requests: [
        {
            entity: ITEM, 
            offset: 0, 
            limit: 100,
            order: [["id", "ASC"]], - optional
            where: {typeId: 2, values: { attr1: { OP_ne: "attr1"}}} - optional
        }]
    ) {
    responses {
        ... on ItemsSearchResponse {
            count
            rows {
                id
                identifier
                name
            }
        }
    }}} 
    
    more where: {updatedAt: { OP_gt: "2020-04-3 12:33:16"}}

    more where (join with relations):
    {"OP_or": [
{ "sourceRelation___relationId": 1 },
{ "targetRelation___relationId": 1 }]}

    */
function replaceOperations(obj: any) {
    let sourceRelation = false
    let targetRelation = false
    for (const prop in obj) {
        const value = obj[prop];
        if (prop.startsWith('OP_')) {
            const operation = prop.substr(3)
            delete obj[prop]
            obj[Symbol.for(operation)] = value
        }

        if (prop.startsWith('sourceRelation___')) {
            const field = prop.substr(17)
            delete obj[prop]
            const column = '$sourceRelation.'+field+'$'
            obj[column] = value
            sourceRelation = true
        }

        if (prop.startsWith('targetRelation___')) {
            const field = prop.substr(17)
            delete obj[prop]
            const column = '$targetRelation.'+field+'$'
            obj[column] = value
            targetRelation = true
        }

        if (value === Object(value)) {
            const ret = replaceOperations(value)
            if (ret.sourceRelation) sourceRelation = true
            if (ret.targetRelation) targetRelation = true
        }
    }
    return {sourceRelation: sourceRelation, targetRelation: targetRelation}
}

export function prepareWhere (context: Context, where: any) {
    const params: any = {}
    let replaceResult = {sourceRelation: false, targetRelation: false}
    if (where) {
        replaceResult = replaceOperations(where)
        params.where = where
    }
    if (replaceResult.sourceRelation || replaceResult.targetRelation) {
        const arr = []
        if (replaceResult.sourceRelation) arr.push({model: ItemRelation, as: 'sourceRelation'})
        if (replaceResult.targetRelation) arr.push({model: ItemRelation, as: 'targetRelation'})
        params.include = arr
    }
    return params
}

export default {
    SearchResponse: {
        __resolveType(obj: any, context: any, info: any) {
            return obj.type;
        },
    }, 
    Query: {
        search: async (parent: any, { requests }: any, context: Context) => {
            context.checkAuth()
            
            const arr: any[] = []
            
            for (let i = 0; i < requests.length; i++) {
                const request = requests[i];
                let res:any
                const params: FindAndCountOptions = {
                    offset: request.offset,
                    limit: request.limit
                }
                let replaceResult = {sourceRelation: false, targetRelation: false}
                if (request.where) {
                    replaceResult = replaceOperations(request.where)
                    params.where = request.where
                }
                if (request.order) params.order = request.order
                if (request.entity === 'ITEM') {
                    if (replaceResult.sourceRelation || replaceResult.targetRelation) {
                        const arr = []
                        if (replaceResult.sourceRelation) arr.push({model: ItemRelation, as: 'sourceRelation'})
                        if (replaceResult.targetRelation) arr.push({model: ItemRelation, as: 'targetRelation'})
                        params.include = arr
                    }

                    // queries are processed in ItemsResponse resolvers
                    res = {}
                    res.type = 'ItemsSearchResponse'
                    res.params = params
                    res.context = context
                } else if (request.entity === 'TYPE') {
                    if (!context.canViewConfig(ConfigAccess.TYPES)) 
                        throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to view types, tenant: ' + context.getCurrentUser()!.tenantId)

                    res = await Type.applyScope(context).findAndCountAll(params)
                    const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

                    res.rows.forEach((type: { id: number, link: number, linkIdentifier: string, parentIdentifier: string, images: any, mainImage: any }) => {
                        const typeNode = mng.getTypeById(type.id)
                        type.parentIdentifier = typeNode?.getParent() !== mng.getRoot() ? typeNode?.getParent()?.getValue().identifier : ''

                        type.images = type.images ? type.images.map((relId: number) => mng.getRelationById(relId)?.identifier) : []
                        type.mainImage = type.mainImage ? mng.getRelationById(type.mainImage)?.identifier : ''

                        if (type.link) {
                            type.linkIdentifier = mng.getTypeById(type.link)!.getValue().identifier
                        } else {
                            type.linkIdentifier = ''
                        }
                    })
                    res.type = 'TypesResponse'
                } else if (request.entity === 'ATTRIBUTE') {
                    if (!context.canViewConfig(ConfigAccess.ATTRIBUTES)) 
                        throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to view attributes, tenant: ' + context.getCurrentUser()!.tenantId)

                    res = await Attribute.applyScope(context).findAndCountAll(params)
                    const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
                    for (let i = 0; i < res.rows.length; i++) {
                        const attr: { id: number, valid: any, visible: any, relations: any, groups: string[], lov: any } = res.rows[i];

                        attr.valid = attr.valid ? attr.valid.map((typeId: number) => mng.getTypeById(typeId)?.getValue().identifier) : []
                        if (attr.visible) {
                            const items = await Item.applyScope(context).findAll({ where: { id: attr.visible} })
                            attr.visible = items.map(item => item.identifier)
                        } else {
                            attr.visible = []
                        }
                        attr.relations = attr.relations ? attr.relations.map((relId: number) => mng.getRelationById(relId)?.identifier) : []
                        if (attr.lov) {
                            attr.lov = (await LOV.applyScope(context).findByPk(attr.lov))?.identifier
                        } else {
                            attr.lov = ''
                        }
                        attr.groups = []
                        mng.getAttrGroups().forEach(group => {
                            group.getAttributes().forEach(groupAttr => {
                                if (groupAttr.id === attr.id) {
                                    attr.groups.push(group.getGroup().identifier)
                                }
                            })
                        })
                    }
                    res.type = 'AttributesResponse'
                } else if (request.entity === 'ATTRIBUTE_GROUP') {
                    if (!context.canViewConfig(ConfigAccess.ATTRIBUTES)) 
                        throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to view attributes, tenant: ' + context.getCurrentUser()!.tenantId)

                    res = await AttrGroup.applyScope(context).findAndCountAll(params)
                    res.type = 'AttrGroupsResponse'
                } else if (request.entity === 'RELATION') {
                    if (!context.canViewConfig(ConfigAccess.RELATIONS)) 
                        throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to view relations, tenant: ' + context.getCurrentUser()!.tenantId)

                    res = await Relation.applyScope(context).findAndCountAll(params)
                    const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
                    res.rows.forEach((rel: Relation) => {
                        if (rel.sources) rel.sources = rel.sources.map((id: number) => mng.getTypeById(id)?.getValue().identifier)
                        if (rel.targets) rel.targets = rel.targets.map((id: number) => mng.getTypeById(id)?.getValue().identifier)
                    })
                    res.type = 'RelationsResponse'
                } else if (request.entity === 'ITEM_RELATION') {
                    res = await ItemRelation.applyScope(context).findAndCountAll(params)

                    res.rows = res.rows.filter( (itemRel: ItemRelation) => context.canViewItemRelation(itemRel.id))
                    for (let i = 0; i < res.rows.length; i++) {
                        const itemRel = res.rows[i];
                        const allowedAttributes = context.getViewItemRelationAttributes(itemRel.relationId)
                        filterValues(allowedAttributes, itemRel.values)
                    }
                    res.type = 'SearchItemRelationResponse'
                } else if (request.entity === 'USER') {
                    if (!context.canViewConfig(ConfigAccess.USERS)) 
                        throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to view users, tenant: ' + context.getCurrentUser()!.tenantId)

                    res = await User.applyScope(context).findAndCountAll(params)
                    const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
                    res.rows.forEach((user: User) => {
                        if (user.roles) user.roles = user.roles.map((id: number) => mng.getRoles().find(role => role.id === id)?.identifier)
                    })
                    res.type = 'UsersResponse'
                } else if (request.entity === 'ROLE') {
                    if (!context.canViewConfig(ConfigAccess.ROLES)) 
                        throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to view roles, tenant: ' + context.getCurrentUser()!.tenantId)
                    res = await Role.applyScope(context).findAndCountAll(params)
                    const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

                    for (let i = 0; i < res.rows.length; i++) {
                        const role: Role = res.rows[i]
                        if (role.relAccess) {
                            const rels = role.relAccess.relations ? role.relAccess.relations.map((relId: number) => mng.getRelationById(relId)?.identifier) : []
                            const groups = role.relAccess.groups ? 
                                role.relAccess.groups.map((data: any) => { return {access: data.access, groupIdentifier: mng.getAttrGroups().find(group => group.getGroup().id === data.groupId)?.getGroup().identifier }} ) : []
                            role.relAccess = {access: role.relAccess.access, relations: rels, groups: groups}
                        }
                        if (role.itemAccess) {
                            const valid = role.itemAccess.valid ? role.itemAccess.valid.map((typeId: number) => mng.getTypeById(typeId)?.getValue().identifier) : []
                            const groups = role.itemAccess.groups ? 
                                role.itemAccess.groups.map((data: any) => { return {access: data.access, groupIdentifier: mng.getAttrGroups().find(group => group.getGroup().id === data.groupId)?.getGroup().identifier }} ) : []
                            let items = role.itemAccess.fromItems.length > 0 ? await Item.applyScope(context).findAll({ where: { id: role.itemAccess.fromItems} }) : []
                            role.itemAccess = {access: role.itemAccess.access, valid: valid, groups: groups, fromItems: items.map(item => item.identifier)}
                        }
                    }
                    res.type = 'RolesResponse'
                } else if (request.entity === 'LOV') {
                    if (!context.canViewConfig(ConfigAccess.LOVS)) 
                        throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to view list of values, tenant: ' + context.getCurrentUser()!.tenantId)

                    res = await LOV.applyScope(context).findAndCountAll(params)
                    res.type = 'LOVsResponse'
                }
                arr.push(res)
            }

            return {responses: arr}
        },
        getSearchByIdentifier: async (parent: any, { identifier }: any, context: Context) => {
            context.checkAuth()
            const data = await SavedSearch.applyScope(context).findOne({
                where: {
                    identifier: identifier
                }
            })
            return data
        },
        getSearches: async (parent: any, { onlyMy }: any, context: Context) => {
            context.checkAuth()
            const where:any = {}
            if (onlyMy) {
                where.user = context.getCurrentUser()!.login
            } else {
                where[Op.or] = [{user: context.getCurrentUser()!.login},{public: true}]
            }
            const arr = await SavedSearch.applyScope(context).findAll({ where: where })
            return arr
        },
        getColumnsByIdentifier: async (parent: any, { identifier }: any, context: Context) => {
            context.checkAuth()
            const data = await SavedColumns.applyScope(context).findOne({
                where: {
                    identifier: identifier
                }
            })
            return data
        },
        getColumns: async (parent: any, { onlyMy }: any, context: Context) => {
            context.checkAuth()
            const where:any = {}
            if (onlyMy) {
                where.user = context.getCurrentUser()!.login
            } else {
                where[Op.or] = [{user: context.getCurrentUser()!.login},{public: true}]
            }
            const arr = await SavedColumns.applyScope(context).findAll({ where: where, order: [['user', 'DESC']] })
            return arr
        },
    },
    ItemsSearchResponse: {
        count: async ({context, params}: any) => {
            return await Item.applyScope(context).count(params)
        },
        rows: async ({context, params}: any) => {
            const arr = await Item.applyScope(context).findAll(params)

            const rows = arr.filter( (item: Item) => context.canViewItem(item))
            for (let i = 0; i < arr.length; i++) {
                const item = arr[i];
                const allowedAttributes = context.getViewItemAttributes(item)
                filterValues(allowedAttributes, item.values)
                filterChannels(context, item.channels)
            }
            return rows
        }
    },
    Mutation: {
        saveSearch: async (parent: any, { identifier, name, publicSearch, extended, filters, whereClause }: any, context: Context) => {
            context.checkAuth()
            if (!/^[A-Za-z0-9_-]*$/.test(identifier)) throw new Error('Identifier must not has spaces and must be in English only: ' + identifier + ', tenant: ' + context.getCurrentUser()!.tenantId)

            const data = await SavedSearch.applyScope(context).findOne({
                where: {
                    identifier: identifier
                }
            })

            if (data) {
                if (data.user !== context.getCurrentUser()?.login) {
                    throw new Error('Failed to update search that belogs to another user by identifier: ' + identifier + ', tenant: ' + context.getCurrentUser()?.tenantId)
                }
                if (name) data.name = name
                if (extended != null) data.extended = extended
                if (filters) data.filters = filters
                if (whereClause) data.whereClause = whereClause
                if (publicSearch != null) data.public = publicSearch
                data.updatedBy = context.getCurrentUser()!.login
                await sequelize.transaction(async (t) => {
                    await data.save({transaction: t})
                })
                return data.id
            } else {
                const data = await sequelize.transaction(async (t) => {
                    return await SavedSearch.create ({
                        identifier: identifier,
                        tenantId: context.getCurrentUser()!.tenantId,
                        createdBy: context.getCurrentUser()!.login,
                        updatedBy: context.getCurrentUser()!.login,
                        name: name,
                        public: publicSearch != null ? publicSearch : false,
                        extended: extended != null ? extended : false,
                        filters: filters || [],
                        whereClause: whereClause || {},
                        user: context.getCurrentUser()!.login
                    }, {transaction: t})
                })
    
                return data.id
            }
        },
        removeSearch: async (parent: any, { identifier }: any, context: Context) => {
            context.checkAuth()

            const data = await SavedSearch.applyScope(context).findOne({
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
                    throw new Error('Failed to remove search that belogs to another user by identifier: ' + identifier + ', tenant: ' + context.getCurrentUser()?.tenantId)
                }
            } else {
                throw new Error('Failed to find search by identifier: ' + identifier + ', tenant: ' + context.getCurrentUser()?.tenantId)
            }
        },
        saveColumns: async (parent: any, { identifier, name, publicAccess, columns }: any, context: Context) => {
            context.checkAuth()
            if (!/^[A-Za-z0-9_-]*$/.test(identifier)) throw new Error('Identifier must not has spaces and must be in English only: ' + identifier + ', tenant: ' + context.getCurrentUser()!.tenantId)

            const data = await SavedColumns.applyScope(context).findOne({
                where: {
                    identifier: identifier
                }
            })

            if (data) {
                if (data.user !== context.getCurrentUser()?.login) {
                    throw new Error('Failed to update columns configuration that belogs to another user by identifier: ' + identifier + ', tenant: ' + context.getCurrentUser()?.tenantId)
                }
                if (name) data.name = name
                if (publicAccess != null) data.public = publicAccess
                if (columns) data.columns = columns
                data.updatedBy = context.getCurrentUser()!.login
                await sequelize.transaction(async (t) => {
                    await data.save({transaction: t})
                })
                return data.id
            } else {
                const data = await sequelize.transaction(async (t) => {
                    return await SavedColumns.create ({
                        identifier: identifier,
                        tenantId: context.getCurrentUser()!.tenantId,
                        createdBy: context.getCurrentUser()!.login,
                        updatedBy: context.getCurrentUser()!.login,
                        name: name,
                        public: publicAccess != null ? publicAccess : false,
                        columns: columns || [],
                        user: context.getCurrentUser()!.login
                    }, {transaction: t})
                })
    
                return data.id
            }
        },
        removeColumns: async (parent: any, { identifier }: any, context: Context) => {
            context.checkAuth()

            const data = await SavedColumns.applyScope(context).findOne({
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
                    throw new Error('Failed to remove columns configuration that belogs to another user by identifier: ' + identifier + ', tenant: ' + context.getCurrentUser()?.tenantId)
                }
            } else {
                throw new Error('Failed to find columns configuration by identifier: ' + identifier + ', tenant: ' + context.getCurrentUser()?.tenantId)
            }
        }        
    }
}