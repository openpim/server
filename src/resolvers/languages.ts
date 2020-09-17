import Context, { ConfigAccess } from '../context'
import { ModelManager, ModelsManager } from '../models/manager'
import { Language } from '../models/languages'
import { sequelize } from '../models'

export default {
    Query: {
        getLanguages: async (parent: any, args: any, context: Context) => {
            context.checkAuth()
            
            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
            return mng.getLanguages()
        }
    },
    Mutation: {
        createLanguage: async (parent: any, {identifier, name}: any, context: Context) => {
            context.checkAuth()
            if (!context.canEditConfig(ConfigAccess.LANGUAGES)) 
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to create language, tenant: ' + context.getCurrentUser()!.tenantId)

            if (!/^[A-Za-z0-9_]*$/.test(identifier)) throw new Error('Identifier must not has spaces and must be in English only: ' + identifier + ', tenant: ' + context.getCurrentUser()!.tenantId)

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

            const tst = mng.getLanguages().find( lang => lang.identifier === identifier)
            if (tst) {
                throw new Error('Identifier already exists: ' + identifier + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }

            const lang = await sequelize.transaction(async (t) => {
                const lang = await Language.create ({
                    identifier: identifier,
                    tenantId: context.getCurrentUser()!.tenantId,
                    createdBy: context.getCurrentUser()!.login,
                    updatedBy: context.getCurrentUser()!.login,
                    name: name
                }, {transaction: t})
                return lang
            })

            mng.getLanguages().push(lang)
            return lang.id
        },
        updateLanguage: async (parent: any, { id, name }: any, context: Context) => {
            context.checkAuth()
            if (!context.canEditConfig(ConfigAccess.LANGUAGES)) 
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to update language, tenant: ' + context.getCurrentUser()!.tenantId)

            const nId = parseInt(id)

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

            let lang  = mng.getLanguages().find( (lang) => lang.id === nId)
            if (!lang) {
                throw new Error('Failed to find language by id: ' + id + ', tenant: ' + mng.getTenantId())
            }

            if (name) lang.name = name
            lang.updatedBy = context.getCurrentUser()!.login
            await sequelize.transaction(async (t) => {
                await lang!.save({transaction: t})
            })
            return lang.id
        },
        removeLanguage: async (parent: any, { id }: any, context: Context) => {
            context.checkAuth()
            if (!context.canEditConfig(ConfigAccess.LANGUAGES)) 
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to remove language, tenant: ' + context.getCurrentUser()!.tenantId)

            const nId = parseInt(id)

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

            const idx = mng.getLanguages().findIndex( (lang) => lang.id === nId)    
            if (idx === -1) {
                throw new Error('Failed to find language by id: ' + id + ', tenant: ' + mng.getTenantId())
            }

            const lang  = mng.getLanguages()[idx]
            lang.updatedBy = context.getCurrentUser()!.login
            // we have to change identifier during deletion to make possible that it will be possible to make new type with same identifier
            lang.identifier = lang.identifier + '_d_' + Date.now() 
            await sequelize.transaction(async (t) => {
                await lang!.save({transaction: t})
                await lang!.destroy({transaction: t})
            })

            mng.getLanguages().splice(idx, 1)

            return true
        }
    }
}