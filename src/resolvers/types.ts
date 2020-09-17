import Context, { ConfigAccess } from '../context'
import { ModelManager, ModelsManager } from '../models/manager'
import { Type } from '../models/types'
import { sequelize } from '../models'
import { QueryTypes } from 'sequelize'
import { Item } from '../models/items'
import { Attribute } from '../models/attributes'
import { Op } from 'sequelize'
import { Relation } from '../models/relations'

export default {
    Query: {
        getTypes: async (parent: any, args: any, context: Context) => {
            context.checkAuth()
            
            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
            return mng.getTypes()
        },
        getType: async (parent: any, { id }: any, context: Context) => {
            context.checkAuth()
            
            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
            const typeNode = mng.getTypeById(parseInt(id))
            const type = typeNode?.getValue()
            if (type) {
                type.parentIdentifier = typeNode?.getParent() !== mng.getRoot() ? typeNode?.getParent()?.getValue().identifier : ''
                if (type.link) {
                    const link = mng.getTypeById(type.link)?.getValue()
                    if (link) type.linkIdentifier = link.identifier 
                } else if (!type.link) {
                    type.linkIdentifier = ''
                }
            }
            return type
        }
    },
    Mutation: {
        createType: async (parent: any, { parentId, identifier, name, icon, iconColor, file, mainImage, images }: any, context: Context) => {
            context.checkAuth()
            if (!context.canEditConfig(ConfigAccess.TYPES)) 
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to create type, tenant: ' + context.getCurrentUser()!.tenantId)

            if (!/^[A-Za-z0-9_]*$/.test(identifier)) throw new Error('Identifier must not has spaces and must be in English only: ' + identifier + ', tenant: ' + context.getCurrentUser()!.tenantId)

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
            if (mng.getTypeByIdentifier(identifier) !== null) {
                throw new Error('Identifier already exists: ' + identifier + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }

            const pId = parseInt(parentId)

            const results:any = await sequelize.query("SELECT nextval('types_id_seq')", { 
                type: QueryTypes.SELECT
            });
            const id = (results[0]).nextval

            let path = '' + id
            if (pId) {
                let parent  = mng.getTypeById(pId)
                if (parent) {
                    while(parent != mng.getRoot()) {
                        path = parent!.getValue().id + '.' + path
                        parent = parent!.getParent()
                    }
                } else {
                    throw new Error('Failed to find parent by id: ' + parentId + ', tenant: ' + mng.getTenantId())
                }
            } 

            const imgs = images ? images.map((elem: string) => parseInt(elem)) : []

            const type = await sequelize.transaction(async (t) => {
                const type = await Type.create ({
                    id: id,
                    path: path,
                    identifier: identifier,
                    icon: icon,
                    iconColor: iconColor,
                    tenantId: context.getCurrentUser()!.tenantId,
                    createdBy: context.getCurrentUser()!.login,
                    updatedBy: context.getCurrentUser()!.login,
                    name: name,
                    link: 0,
                    file: file != null ? file : false,
                    mainImage: mainImage ? parseInt(mainImage) : 0,
                    images: imgs
                }, {transaction: t})
                return type
            })

            mng.addType(pId, type)
            return type.id
        },
        updateType: async (parent: any, { id, name, icon, iconColor, file, mainImage, images  }: any, context: Context) => {
            context.checkAuth()
            if (!context.canEditConfig(ConfigAccess.TYPES)) 
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to update type, tenant: ' + context.getCurrentUser()!.tenantId)

            const nId = parseInt(id)

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

            let typeNode  = mng.getTypeById(nId)
            if (!typeNode) {
                throw new Error('Failed to find type by id: ' + id + ', tenant: ' + mng.getTenantId())
            }

            const type:Type = typeNode.getValue()
            if (name) type.name = name
            if (icon) type.icon = icon
            if (iconColor) type.iconColor = iconColor
            if (file != null) type.file = file
            if (mainImage != null) type.mainImage = mainImage
            if (images) type.images = images.map((elem: string) => parseInt(elem))

            type.updatedBy = context.getCurrentUser()!.login
            await sequelize.transaction(async (t) => {
                await type.save({transaction: t})
            })
            return type.id
        },
        removeType: async (parent: any, { id }: any, context: Context) => {
            context.checkAuth()
            if (!context.canEditConfig(ConfigAccess.TYPES)) 
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to remove type, tenant: ' + context.getCurrentUser()!.tenantId)

            const nId = parseInt(id)

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

            let typeNode  = mng.getTypeById(nId)
            if (!typeNode) {
                throw new Error('Failed to find type by id: ' + id + ', tenant: ' + mng.getTenantId())
            }

            if (typeNode.getChildren().length > 0) {
                throw new Error('Failed to remove type with children id: ' + id + ', tenant: ' + mng.getTenantId())
            }

            // check Roles
            const tst4 = mng.getRoles().find(role => role.itemAccess.valid.includes(nId))
            if (tst4) throw new Error('Can not remove this type because there are roles linked to it.');
            // check Relations
            const tst3 = await Relation.applyScope(context).findOne({
                where: {[Op.or]: [{sources: { [Op.contains]: nId}}, {targets: { [Op.contains]: nId}}]}
            })
            if (tst3) throw new Error('Can not remove this type because there are relations linked to it.');
            // check Attributes
            const tst2 = await Attribute.applyScope(context).findOne({where: {valid: { [Op.contains]: nId}}})
            if (tst2) throw new Error('Can not remove this type because there are attributes linked to it.');
            // check Items
            const tst1 = await Item.applyScope(context).findOne({where: {typeId: nId}})
            if (tst1) throw new Error('Can not remove this type because there are objects of this type.');

            const parentNode = typeNode.getParent()!
            parentNode.deleteChild(typeNode)

            const type:Type = typeNode.getValue()
            type.updatedBy = context.getCurrentUser()!.login
            // we have to change identifier during deletion to make possible that it will be possible to make new type with same identifier
            type.identifier = type.identifier + '_deleted_' + Date.now() 
            await sequelize.transaction(async (t) => {
                await type.save({transaction: t})
                await type.destroy({transaction: t})
            })

            return true
        },
        linkType: async (parent: any, { id, parentId }: any, context: Context) => {
            context.checkAuth()
            if (!context.canEditConfig(ConfigAccess.TYPES)) 
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to link type, tenant: ' + context.getCurrentUser()!.tenantId)

            const nId = parseInt(id)
            const nParentId = parseInt(parentId)

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

            let typeNode  = mng.getTypeById(nId)
            if (!typeNode) {
                throw new Error('Failed to find type by id: ' + id + ', tenant: ' + mng.getTenantId())
            }
            let parentNode  = mng.getTypeById(nParentId)
            if (!parentNode) {
                throw new Error('Failed to find type by id: ' + nParentId + ', tenant: ' + mng.getTenantId())
            }

            const results:any = await sequelize.query("SELECT nextval('types_id_seq')", { 
                type: QueryTypes.SELECT
            });
            const newId = (results[0]).nextval

            let path = '' + newId
            while(parentNode != mng.getRoot()) {
                path = parentNode!.getValue().id + '.' + path
                parentNode = parentNode!.getParent()
            }

            const type = await sequelize.transaction(async (t) => {
                const type = await Type.create ({
                    id: newId,
                    path: path,
                    identifier: '' + newId,
                    icon: '',
                    iconColor: '',
                    tenantId: context.getCurrentUser()!.tenantId,
                    createdBy: context.getCurrentUser()!.login,
                    updatedBy: context.getCurrentUser()!.login,
                    name: {},
                    link: nId,
                    file: false,
                    mainImage: 0,
                    images: []
                }, {transaction: t})
                return type
            })

            mng.addType(nParentId, type)
            return type.id
        }
    }
}