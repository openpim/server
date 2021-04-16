import Context, { ConfigAccess } from '../context'
import { Language } from '../models/languages'
import { sequelize } from '../models'
import { LOV } from '../models/lovs'
import { Attribute } from '../models/attributes'

export default {
    Query: {
        getLOVs: async (parent: any, args: any, context: Context) => {
            context.checkAuth()

            // if (!context.canViewConfig(ConfigAccess.LOVS)) 
            //    throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to view list of values, tenant: ' + context.getCurrentUser()!.tenantId)
            
            return LOV.applyScope(context).findAll()
        },
        getLOV: async (parent: any, { id }: any, context: Context) => {
            context.checkAuth()
           
            return LOV.applyScope(context).findByPk(parseInt(id))
        }
    },
    Mutation: {
        createLOV: async (parent: any, {identifier, name, values}: any, context: Context) => {
            context.checkAuth()

            //if (!context.canEditConfig(ConfigAccess.LOVS)) 
            //    throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to create list of values, tenant: ' + context.getCurrentUser()!.tenantId)

            if (!/^[A-Za-z0-9_-]*$/.test(identifier)) throw new Error('Identifier must not has spaces and must be in English only: ' + identifier + ', tenant: ' + context.getCurrentUser()!.tenantId)

            const tst = await LOV.applyScope(context).findOne({
                where: {
                    identifier: identifier
                }
            })
            if (tst) {
                throw new Error('Identifier already exists: ' + identifier + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }

            const lov = await sequelize.transaction(async (t) => {
                return await LOV.create ({
                    identifier: identifier,
                    tenantId: context.getCurrentUser()!.tenantId,
                    createdBy: context.getCurrentUser()!.login,
                    updatedBy: context.getCurrentUser()!.login,
                    name: name,
                    values: values || []
                }, {transaction: t})
            })

            return lov.id
        },
        updateLOV: async (parent: any, { id, name, values }: any, context: Context) => {
            context.checkAuth()
            if (!context.canEditConfig(ConfigAccess.LOVS)) 
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to update list of values, tenant: ' + context.getCurrentUser()!.tenantId)

            const nId = parseInt(id)

            const lov = await LOV.applyScope(context).findByPk(parseInt(id))
            if (!lov) {
                throw new Error('Failed to find list of values by id: ' + id + ', tenant: ' + context.getCurrentUser()?.tenantId)
            }

            if (name) lov.name = name
            if (values) lov.values = values
            lov.updatedBy = context.getCurrentUser()!.login
            await sequelize.transaction(async (t) => {
                await lov.save({transaction: t})
            })
            return lov.id
        },
        removeLOV: async (parent: any, { id }: any, context: Context) => {
            context.checkAuth()
            if (!context.canEditConfig(ConfigAccess.LOVS)) 
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to remove list of values, tenant: ' + context.getCurrentUser()!.tenantId)

            const nId = parseInt(id)

            const lov = await LOV.applyScope(context).findByPk(parseInt(id))
            if (!lov) {
                throw new Error('Failed to find list of values by id: ' + id + ', tenant: ' + context.getCurrentUser()?.tenantId)
            }

            // check Attributes
            const tst1 = await Attribute.applyScope(context).findOne({where: {lov: nId}})
            if (tst1) throw new Error('Can not remove this list of values because there are attributes linked to it.');

            lov.updatedBy = context.getCurrentUser()!.login
            // we have to change identifier during deletion to make possible that it will be possible to make new type with same identifier
            lov.identifier = lov.identifier + '_d_' + Date.now() 
            await sequelize.transaction(async (t) => {
                await lov!.save({transaction: t})
                await lov!.destroy({transaction: t})
            })

            return true
        }
    }
}