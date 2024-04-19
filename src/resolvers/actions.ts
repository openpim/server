import Context, { ConfigAccess } from '../context'
import { ModelsManager } from '../models/manager'
import { sequelize } from '../models'
import { Action } from '../models/actions'
import { Item } from '../models/items'
import { diff, isObjectEmpty, mergeValues, processItemButtonActions, processItemButtonActions2, processTableButtonActions, testAction } from './utils'
import audit, { AuditItem, ChangeType } from '../audit'

export default {
    Query: {
        getActions: async (parent: any, args: any, context: Context) => {
            context.checkAuth()
            
            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
            return mng.getActions()
        }
    },
    Mutation: {
        createAction: async (parent: any, {identifier, name, code, order, triggers}: any, context: Context) => {
            context.checkAuth()
            if (!context.canEditConfig(ConfigAccess.ACTIONS)) 
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to create action, tenant: ' + context.getCurrentUser()!.tenantId)

            if (!/^[A-Za-z0-9_-]*$/.test(identifier)) throw new Error('Identifier must not has spaces and must be in English only: ' + identifier + ', tenant: ' + context.getCurrentUser()!.tenantId)

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

            const tst = mng.getActions().find( act => act.identifier === identifier)
            if (tst) {
                throw new Error('Identifier already exists: ' + identifier + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }

            const action = await sequelize.transaction(async (t) => {
                return await Action.create ({
                    identifier: identifier,
                    tenantId: context.getCurrentUser()!.tenantId,
                    createdBy: context.getCurrentUser()!.login,
                    updatedBy: context.getCurrentUser()!.login,
                    name: name,
                    order: order != null ? order : 0,
                    code: code || '',
                    triggers: triggers || []
                }, {transaction: t})
            })

            mng.getActions().push(action)
            await mng.reloadModelRemotely(action.id, null, 'ACTION', false, context.getUserToken())
            return action.id
        },
        updateAction: async (parent: any, { id, name, code, order, triggers }: any, context: Context) => {
            context.checkAuth()
            if (!context.canEditConfig(ConfigAccess.ACTIONS)) 
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to update action, tenant: ' + context.getCurrentUser()!.tenantId)

            const nId = parseInt(id)

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

            let act  = mng.getActions().find(act => act.id === nId)
            if (!act) {
                throw new Error('Failed to find action by id: ' + id + ', tenant: ' + mng.getTenantId())
            }

            if (name) act.name = name
            if (code) act.code = code
            if (triggers) act.triggers = triggers
            if (order != null) act.order = order
            act.updatedBy = context.getCurrentUser()!.login
            await sequelize.transaction(async (t) => {
                await act!.save({transaction: t})
            })
            delete mng.getActionsCache()[act.identifier]
            await mng.reloadModelRemotely(act.id, null, 'ACTION', false, context.getUserToken())
            return act.id
        },
        removeAction: async (parent: any, { id }: any, context: Context) => {
            context.checkAuth()
            if (!context.canEditConfig(ConfigAccess.ACTIONS)) 
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to remove action, tenant: ' + context.getCurrentUser()!.tenantId)

            const nId = parseInt(id)

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

            const idx = mng.getActions().findIndex(act => act.id === nId)    
            if (idx === -1) {
                throw new Error('Failed to find action by id: ' + id + ', tenant: ' + mng.getTenantId())
            }

            const act  = mng.getActions()[idx]
            act.updatedBy = context.getCurrentUser()!.login
            // we have to change identifier during deletion to make possible that it will be possible to make new type with same identifier
            act.identifier = act.identifier + '_d_' + Date.now() 
            await sequelize.transaction(async (t) => {
                await act!.save({transaction: t})
                await act!.destroy({transaction: t})
            })

            mng.getActions().splice(idx, 1)
            await mng.reloadModelRemotely(act.id, null, 'ACTION', true, context.getUserToken())
            return true
        },
        executeButtonAction: async (parent: any, { itemId, buttonText, data }: any, context: Context) => {
            context.checkAuth()

            const nId = parseInt(itemId)

            const item = await Item.applyScope(context).findByPk(nId)
            if (!item) {
                throw new Error('Failed to find item by id: ' + nId + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }

            const { channels, values, result } = await processItemButtonActions(context, buttonText, item, data)

            if (!context.canEditItem(item)) {
                return result
            }

            let itemDiff: AuditItem
            if (audit.auditEnabled()) itemDiff = diff({values: item.values}, {values: values})

            item.values = values
            item.changed("values", true)
            item.channels = channels

            item.updatedBy = context.getCurrentUser()!.login
            await sequelize.transaction(async (t) => {
                await item.save({transaction: t})
            })

            if (audit.auditEnabled()) {
                if (!isObjectEmpty(itemDiff!.added) || !isObjectEmpty(itemDiff!.changed) || !isObjectEmpty(itemDiff!.deleted)) audit.auditItem(ChangeType.UPDATE, item.id, item.identifier, itemDiff!, context.getCurrentUser()!.login, item.updatedAt)
            }

            return result
        },
        executeTableButtonAction: async (parent: any, { itemId, buttonText, where, data }: any, context: Context) => {
            context.checkAuth()

            let item:(Item | null) = null

            if (itemId) {
                const nId = parseInt(itemId)
                item = await Item.applyScope(context).findByPk(nId)
                if (!item) {
                    throw new Error('Failed to find item by id: ' + nId + ', tenant: ' + context.getCurrentUser()!.tenantId)
                }
            }

            const { channels, values, result } = await processTableButtonActions(context, buttonText, item, where, data)

            if (item && !context.canEditItem(item)) {
                return result
            }

            if (item) {
                let itemDiff: AuditItem
                if (audit.auditEnabled()) itemDiff = diff({values: item.values}, {values: values})

                item.values = values
                item.changed("values", true)
                item.channels = channels

                item.updatedBy = context.getCurrentUser()!.login
                await sequelize.transaction(async (t) => {
                    await item!.save({transaction: t})
                })

                if (audit.auditEnabled()) {
                    if (!isObjectEmpty(itemDiff!.added) || !isObjectEmpty(itemDiff!.changed) || !isObjectEmpty(itemDiff!.deleted)) audit.auditItem(ChangeType.UPDATE, item.id, item.identifier, itemDiff!, context.getCurrentUser()!.login, item.updatedAt)
                }
            }

            return result
        },
        executeAction: async (parent: any, { itemId, actionIdentifier, data }: any, context: Context) => {
            context.checkAuth()

            const nId = parseInt(itemId)

            const item = await Item.applyScope(context).findByPk(nId)
            if (!item) {
                throw new Error('Failed to find item by id: ' + nId + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
            const action = mng.getActions().find(elem => elem.identifier === actionIdentifier)
            if (!action) {
                throw new Error('Failed to find action by identifier: ' + actionIdentifier + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }

            const { channels, values, result } = await processItemButtonActions2(context, [action], item, data, '')

            if (!context.canEditItem(item)) {
                return result
            }

            let itemDiff: AuditItem
            if (audit.auditEnabled()) itemDiff = diff({values: item.values}, {values: values})

            item.values = mergeValues(values, item.values)
            item.changed("values", true)
            item.channels = channels

            item.updatedBy = context.getCurrentUser()!.login
            await sequelize.transaction(async (t) => {
                await item.save({transaction: t})
            })

            if (audit.auditEnabled()) {
                if (!isObjectEmpty(itemDiff!.added) || !isObjectEmpty(itemDiff!.changed) || !isObjectEmpty(itemDiff!.deleted)) audit.auditItem(ChangeType.UPDATE, item.id, item.identifier, itemDiff!, context.getCurrentUser()!.login, item.updatedAt)
            }

            return result
        },
        testAction: async (parent: any, { itemId, actionId }: any, context: Context) => {
            context.checkAuth()

            const nId = parseInt(itemId)

            const item = await Item.applyScope(context).findByPk(nId)
            if (!item) {
                throw new Error('Failed to find item by id: ' + nId + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }

            if (!context.canEditItem(item)) {
                throw new Error('User :' + context.getCurrentUser()?.login + ' can not edit item :' + item.id + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }

            const cId = parseInt(actionId)

            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)

            let act  = mng.getActions().find(act => act.id === cId)
            if (!act) {
                throw new Error('Failed to find action by id: ' + cId + ', tenant: ' + mng.getTenantId())
            }

            try {
                const { values, log, compileError, message, error } = await testAction(context, act, item)

                let itemDiff: AuditItem
                if (audit.auditEnabled()) itemDiff = diff({values: item.values}, {values: values})
    
                item.values = values

                item.updatedBy = context.getCurrentUser()!.login
                await sequelize.transaction(async (t) => {
                    await item.save({transaction: t})
                })

                if (audit.auditEnabled()) {
                    if (!isObjectEmpty(itemDiff!.added) || !isObjectEmpty(itemDiff!.changed) || !isObjectEmpty(itemDiff!.deleted)) audit.auditItem(ChangeType.UPDATE, item.id, item.identifier, itemDiff!, context.getCurrentUser()!.login, item.updatedAt)
                }
    
                return {failed: compileError ? true : false, log: log, error: error, message: message, compileError:compileError || ''}
            } catch (error:any) {
                return {failed: true, log: '', error: error.message, compileError:''}
            }
        }
    }
}