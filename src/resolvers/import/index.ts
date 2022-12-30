import Context, { ConfigAccess } from '../../context'
import { IItemImportRequest, IImportConfig, ImportResponses, IItemRelationImportRequest, ImportMode, ErrorProcessing, ITypeImportRequest, IRelationImportRequest, IAttrGroupImportRequest, IAttributeImportRequest, IRoleImportRequest, IUserImportRequest, ILOVImportRequest, ICollectionImportRequest, ICollectionItemsImportRequest } from '../../models/import'
import { importItem } from './items'
import { importItemRelation } from './itemRelations'
import { importType } from './types'
import { importRelation } from './relations'
import { importAttrGroup } from './attrGroups'
import { importAttribute } from './attributes'
import { importRole } from './roles'
import { importUser } from './users'
import { importLOV } from './lovs'
import { importCollection } from './collections'
import { importCollectionItems } from './collections'

export default {
    Mutation: {
        import: async (parent: any, { config, types, relations, items, itemRelations, attrGroups, attributes, roles, users, lovs, collections, collectionItems }: any, context: Context) => {
            context.checkAuth()

            config.mode = ImportMode[config.mode]
            config.errors = ErrorProcessing[config.errors]

            const responses = new ImportResponses()
            if (types && types.length > 0) {
                if (!context.canEditConfig(ConfigAccess.TYPES)) 
                    throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to edit types, tenant: ' + context.getCurrentUser()!.tenantId)

                responses.types = []
                for (let index = 0; index < types.length; index++) {
                    const type = types[index];
                    const resp = await importType(context, <IImportConfig>config, <ITypeImportRequest>type)
                    responses.types.push(resp)
                }
            }
            if (relations && relations.length > 0) {
                if (!context.canEditConfig(ConfigAccess.RELATIONS)) 
                    throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to edit relations, tenant: ' + context.getCurrentUser()!.tenantId)

                responses.relations = []
                for (let index = 0; index < relations.length; index++) {
                    const rel = relations[index];
                    const resp = await importRelation(context, <IImportConfig>config, <IRelationImportRequest>rel)
                    responses.relations.push(resp)
                }
            }
            if (items && items.length > 0) {
                responses.items = []
                for (let index = 0; index < items.length; index++) {
                    const item = items[index];
                    const resp = await importItem(context, <IImportConfig>config, <IItemImportRequest>item)
                    responses.items.push(resp)
                }
            }
            if (itemRelations && itemRelations.length > 0) {
                responses.itemRelations = []
                for (let index = 0; index < itemRelations.length; index++) {
                    const itemRelation = itemRelations[index];
                    const resp = await importItemRelation(context, <IImportConfig>config, <IItemRelationImportRequest>itemRelation)
                    responses.itemRelations.push(resp)
                }
            }
            if (attrGroups && attrGroups.length > 0) {
                if (!context.canEditConfig(ConfigAccess.ATTRIBUTES)) 
                    throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to edit attributes, tenant: ' + context.getCurrentUser()!.tenantId)

                responses.attrGroups = []
                for (let index = 0; index < attrGroups.length; index++) {
                    const group = attrGroups[index];
                    const resp = await importAttrGroup(context, <IImportConfig>config, <IAttrGroupImportRequest>group)
                    responses.attrGroups.push(resp)
                }
            }
            if (attributes && attributes.length > 0) {
                if (!context.canEditConfig(ConfigAccess.ATTRIBUTES)) 
                    throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to edit attributes, tenant: ' + context.getCurrentUser()!.tenantId)

                responses.attributes = []
                for (let index = 0; index < attributes.length; index++) {
                    const attr = attributes[index];
                    const resp = await importAttribute(context, <IImportConfig>config, <IAttributeImportRequest>attr)
                    responses.attributes.push(resp)
                }
            }
            if (roles && roles.length > 0) {
                if (!context.canEditConfig(ConfigAccess.ROLES)) 
                    throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to edit roles, tenant: ' + context.getCurrentUser()!.tenantId)

                responses.roles = []
                for (let index = 0; index < roles.length; index++) {
                    const role = roles[index];
                    const resp = await importRole(context, <IImportConfig>config, <IRoleImportRequest>role)
                    responses.roles.push(resp)
                }
            }
            if (users && users.length > 0) {
                if (!context.canEditConfig(ConfigAccess.USERS)) 
                    throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to edit users, tenant: ' + context.getCurrentUser()!.tenantId)

                responses.users = []
                for (let index = 0; index < users.length; index++) {
                    const user = users[index];
                    const resp = await importUser(context, <IImportConfig>config, <IUserImportRequest>user)
                    responses.users.push(resp)
                }
            }
            if (lovs && lovs.length > 0) {
                if (!context.canEditConfig(ConfigAccess.LOVS)) 
                    throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to edit list of values, tenant: ' + context.getCurrentUser()!.tenantId)

                responses.lovs = []
                for (let index = 0; index < lovs.length; index++) {
                    const lov = lovs[index];
                    const resp = await importLOV(context, <IImportConfig>config, <ILOVImportRequest>lov)
                    responses.lovs.push(resp)
                }
            }
            if (collections && collections.length > 0) {
                if (!context.canEditConfig(ConfigAccess.COLLECTIONS)) 
                    throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to edit collection, tenant: ' + context.getCurrentUser()!.tenantId)

                responses.collections = []
                for (let index = 0; index < collections.length; index++) {
                    const collection = collections[index];
                    const resp = await importCollection(context, <IImportConfig>config, <ICollectionImportRequest>collection)
                    responses.collections.push(resp)
                }
            }
            if (collectionItems && collectionItems.length > 0) {
                if (!context.canEditConfig(ConfigAccess.COLLECTIONITEMS)) 
                    throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to edit collection, tenant: ' + context.getCurrentUser()!.tenantId)

                responses.collectionItems = []
                for (let index = 0; index < collectionItems.length; index++) {
                    const collectionItem = collectionItems[index];
                    const resp = await importCollectionItems(context, <IImportConfig>config, <ICollectionItemsImportRequest>collectionItem)
                    responses.collectionItems.push(resp)
                }
            }

            return responses
        }
    }
}