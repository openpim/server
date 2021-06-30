import Context, { ConfigAccess } from '../context'
import { ModelManager, ModelsManager } from '../models/manager'
import { Relation } from '../models/relations'
import { sequelize } from '../models'
import { Attribute } from '../models/attributes'
import { Op } from 'sequelize'
import { ItemRelation } from '../models/itemRelations'

export default {
    Query: {
        getRelations: async (parent: any, args: any, context: Context) => {
            context.checkAuth()
            
            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
            return mng.dumpRelations()
        },
        getRelation: async (parent: any, { id }: any, context: Context) => {
            context.checkAuth()
            
            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
            const rel = mng.getRelationById(parseInt(id))
            if (rel) {
                const data = {sources: [], targets: []}
                Object.assign(data, rel.get({ plain: true }))
    
                data.sources = rel.sources.map((id: number) => mng.getTypeById(id)?.getValue().identifier)
                data.targets = rel.targets.map((id: number) => mng.getTypeById(id)?.getValue().identifier)
                return data
            }
            return rel
        }
    },
    Mutation: {
        createRelation: async (parent: any, {identifier, name, sources, targets, child, multi, order}: any, context: Context) => {
            context.checkAuth()
            if (!context.canEditConfig(ConfigAccess.RELATIONS)) 
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to create relation, tenant: ' + context.getCurrentUser()!.tenantId)

            if (!/^[A-Za-z0-9_-]*$/.test(identifier)) throw new Error('Identifier must not has spaces and must be in English only: ' + identifier + ', tenant: ' + context.getCurrentUser()!.tenantId)

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

            if (mng.getRelationByIdentifier(identifier)) {
                throw new Error('Identifier already exists: ' + identifier + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }

            const src = sources ? sources.map((elem: string) => parseInt(elem)) : []
            const tgt = targets ? targets.map((elem: string) => parseInt(elem)) : []
            const rel = await sequelize.transaction(async (t) => {
                const rel = await Relation.create ({
                    identifier: identifier,
                    tenantId: context.getCurrentUser()!.tenantId,
                    createdBy: context.getCurrentUser()!.login,
                    updatedBy: context.getCurrentUser()!.login,
                    name: name,
                    sources: src,
                    targets: tgt,
                    child: child || false,
                    multi: multi || false,
                    order: order || 0
                }, {transaction: t})
                return rel
            })

            mng.getRelations().push(rel)
            return rel.id
        },
        updateRelation: async (parent: any, { id, name, sources, targets, child, multi, order}: any, context: Context) => {
            context.checkAuth()
            if (!context.canEditConfig(ConfigAccess.RELATIONS)) 
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to update relation, tenant: ' + context.getCurrentUser()!.tenantId)

            const nId = parseInt(id)

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

            let rel  = mng.getRelationById(nId)
            if (!rel) {
                throw new Error('Failed to find relation by id: ' + id + ', tenant: ' + mng.getTenantId())
            }

            if (name) rel.name = name
            if (child != null) rel.child = child
            if (multi != null) rel.multi = multi
            if (order != null) rel.order = order
            if (sources) rel.sources = sources.map((elem: string) => parseInt(elem))
            if (targets) rel.targets = targets.map((elem: string) => parseInt(elem))
            rel.updatedBy = context.getCurrentUser()!.login
            await sequelize.transaction(async (t) => {
                await rel!.save({transaction: t})
            })
            return rel.id
        },
        removeRelation: async (parent: any, { id }: any, context: Context) => {
            context.checkAuth()
            if (!context.canEditConfig(ConfigAccess.RELATIONS)) 
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to remove relation, tenant: ' + context.getCurrentUser()!.tenantId)

            const nId = parseInt(id)

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

            const idx = mng.getRelations().findIndex( (rel) => rel.id === nId)    
            if (idx === -1) {
                throw new Error('Failed to find relation by id: ' + id + ', tenant: ' + mng.getTenantId())
            }

            // check Attributes
            const tst2 = await Attribute.applyScope(context).findOne({where: {relations: { [Op.contains]: nId}}})
            if (tst2) throw new Error('Can not remove this relation because there are attributes linked to it.');
            // check ItemRelations
            const tst1 = await ItemRelation.applyScope(context).findOne({where: {relationId: nId}})
            if (tst1) throw new Error('Can not remove this relation because there are objects of this type.');
            // check Roles
            const tst3 = mng.getRoles().find(role => role.relAccess.relations.includes(nId));
            if (tst3) throw new Error('Can not remove this relation because there are roles linked to it.');

            const rel  = mng.getRelations()[idx]
            rel.updatedBy = context.getCurrentUser()!.login
            // we have to change identifier during deletion to make possible that it will be possible to make new type with same identifier
            rel.identifier = rel.identifier + '_d_' + Date.now() 
            await sequelize.transaction(async (t) => {
                await rel!.save({transaction: t})
                await rel!.destroy({transaction: t})
            })

            mng.getRelations().splice(idx, 1)

            return true
        }
    }
}