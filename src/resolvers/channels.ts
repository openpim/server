import Context, { ConfigAccess } from '../context'
import { ModelManager, ModelsManager } from '../models/manager'
import { sequelize } from '../models'
import { Channel } from '../models/channels'

export default {
    Query: {
        getChannels: async (parent: any, args: any, context: Context) => {
            context.checkAuth()
            
            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
            return mng.getChannels()
        }
    },
    Mutation: {
        createChannel: async (parent: any, {identifier, name, active, type, config, mappings}: any, context: Context) => {
            context.checkAuth()
            if (!context.canEditConfig(ConfigAccess.LANGUAGES)) 
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to create channel, tenant: ' + context.getCurrentUser()!.tenantId)

            if (!/^[A-Za-z0-9_]*$/.test(identifier)) throw new Error('Identifier must not has spaces and must be in English only: ' + identifier + ', tenant: ' + context.getCurrentUser()!.tenantId)

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

            const tst = mng.getChannels().find( chan => chan.identifier === identifier)
            if (tst) {
                throw new Error('Identifier already exists: ' + identifier + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }

            const chan = await sequelize.transaction(async (t) => {
                const chan = await Channel.create ({
                    identifier: identifier,
                    tenantId: context.getCurrentUser()!.tenantId,
                    createdBy: context.getCurrentUser()!.login,
                    updatedBy: context.getCurrentUser()!.login,
                    name: name,
                    active: active,
                    type: type,
                    config: config ? config : {},
                    mappings: mappings ? mappings : {}
                }, {transaction: t})
                return chan
            })

            mng.getChannels().push(chan)
            return chan.id
        },
        updateChannel: async (parent: any, { id, name, active, type, config, mappings }: any, context: Context) => {
            context.checkAuth()
            if (!context.canEditConfig(ConfigAccess.CHANNELS)) 
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to update channel, tenant: ' + context.getCurrentUser()!.tenantId)

            const nId = parseInt(id)

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

            let chan  = mng.getChannels().find( (chan) => chan.id === nId)
            if (!chan) {
                throw new Error('Failed to find channel by id: ' + id + ', tenant: ' + mng.getTenantId())
            }

            if (name) chan.name = name
            if (active != null) chan.active = active
            if (type != null) chan.type = type
            if (config) chan.config = config
            if (mappings) chan.mappings = mappings
            chan.updatedBy = context.getCurrentUser()!.login
            await sequelize.transaction(async (t) => {
                await chan!.save({transaction: t})
            })
            return chan.id
        },
        removeChannel: async (parent: any, { id }: any, context: Context) => {
            context.checkAuth()
            if (!context.canEditConfig(ConfigAccess.CHANNELS)) 
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to remove channel, tenant: ' + context.getCurrentUser()!.tenantId)

            const nId = parseInt(id)

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

            const idx = mng.getChannels().findIndex( (chan) => chan.id === nId)    
            if (idx === -1) {
                throw new Error('Failed to find channel by id: ' + id + ', tenant: ' + mng.getTenantId())
            }

            const chan  = mng.getChannels()[idx]
            chan.updatedBy = context.getCurrentUser()!.login
            // we have to change identifier during deletion to make possible that it will be possible to make new type with same identifier
            chan.identifier = chan.identifier + '_d_' + Date.now() 
            await sequelize.transaction(async (t) => {
                await chan!.save({transaction: t})
                await chan!.destroy({transaction: t})
            })

            mng.getChannels().splice(idx, 1)

            return true
        }
    }
}