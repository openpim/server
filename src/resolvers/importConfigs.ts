import Context, { ConfigAccess } from '../context'
import { ModelsManager } from '../models/manager'
import { sequelize } from '../models'
import { ImportConfig } from '../models/importConfigs'
import logger from '../logger'

export default {
    Query: {
        getImportConfigs: async (parent: any, args: any, context: Context) => {
            context.checkAuth()
            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
            return mng.getImportConfigs()
        }
    },
    Mutation: {
        createImportConfig: async (parent: any, {identifier, name, type, mappings}: any, context: Context) => {
            context.checkAuth()

            if (!context.canEditConfig(ConfigAccess.IMPORTCONFIGS)) 
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to create import config, tenant: ' + context.getCurrentUser()!.tenantId)

            if (!/^[A-Za-z0-9_]*$/.test(identifier)) 
                throw new Error('Identifier must not has spaces and must be in English only: ' + identifier + ', tenant: ' + context.getCurrentUser()!.tenantId)

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

            const tst = mng.getImportConfigs().find(el => el.identifier === identifier)
            if (tst) {
                throw new Error('Identifier already exists: ' + identifier + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }

            const importConfig = await sequelize.transaction(async (t) => {
                const importConfig = await ImportConfig.create ({
                    identifier: identifier,
                    tenantId: context.getCurrentUser()!.tenantId,
                    createdBy: context.getCurrentUser()!.login,
                    updatedBy: context.getCurrentUser()!.login,
                    name: name,
                    type: type,
                    mappings: mappings ? mappings : [],
                }, {transaction: t})
                return importConfig
            })

            mng.getImportConfigs().push(importConfig)
            return importConfig.id
        },
        updateImportConfig: async (parent: any, { id, name, type, mappings }: any, context: Context) => {
            context.checkAuth()
            if (!context.canEditConfig(ConfigAccess.IMPORTCONFIGS)) 
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to update import config, tenant: ' + context.getCurrentUser()!.tenantId)

            const nId = parseInt(id)

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

            let importConfig  = mng.getImportConfigs().find((el) => el.id === nId)
            if (!importConfig) {
                throw new Error('Failed to find import config by id: ' + id + ', tenant: ' + mng.getTenantId())
            }

            if (name) importConfig.name = name
            if (type != null) importConfig.type = type
            if (mappings) importConfig.mappings = mappings
            /* if (mappings) {
                const tmp = {...importConfig.mappings, ...mappings } // merge mappings to avoid deletion from another user
                for (const prop in tmp) {
                    if (tmp[prop].deleted) delete tmp[prop]
                }
                importConfig.mappings = tmp
            } */
            importConfig.updatedBy = context.getCurrentUser()!.login
            await sequelize.transaction(async (t) => {
                await importConfig!.save({transaction: t})
            })

            return importConfig.id
        },
        removeImportConfig: async (parent: any, { id }: any, context: Context) => {
            context.checkAuth()
            if (!context.canEditConfig(ConfigAccess.IMPORTCONFIGS)) 
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to remove import config, tenant: ' + context.getCurrentUser()!.tenantId)

            const nId = parseInt(id)

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

            const idx = mng.getImportConfigs().findIndex((el) => el.id === nId)
            if (idx === -1) {
                throw new Error('Failed to find import config by id: ' + id + ', tenant: ' + mng.getTenantId())
            }

            const importConfig  = mng.getImportConfigs()[idx]
            importConfig.updatedBy = context.getCurrentUser()!.login
            // we have to change identifier during deletion to make possible that it will be possible to make new type with same identifier
            importConfig.identifier = importConfig.identifier + '_d_' + Date.now() 
            await sequelize.transaction(async (t) => {
                await importConfig!.save({transaction: t})
                await importConfig!.destroy({transaction: t})
            })

            mng.getImportConfigs().splice(idx, 1)
            return true
        }
    }
}