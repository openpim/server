import Context, { ConfigAccess } from '../context'
import { sequelize } from '../models'
import { Template } from '../models/templates'
import { FindAndCountOptions, fn, literal, Op } from 'sequelize'
import { replaceOperations } from './utils'

export default {
    Query: {
        getTemplates: async (parent: any, request: any, context: Context) => {
            context.checkAuth()

            const params: FindAndCountOptions = {
                offset: request.offset,
                limit: request.limit
            }
            if (request.where) {
                const include = replaceOperations(request.where, context)
                params.where = request.where
                if (include && include.length > 0) params.include = include
            } else {
                params.where = {}
            }

            if (request.order) params.order = request.order

            const res = await Template.applyScope(context).findAndCountAll(params)
            return res
        }
    },
    Mutation: {
        createTemplate: async (parent: any, { identifier, name, template, templateRichtext, order, valid, visible, options }: any, context: Context) => {
            context.checkAuth()
            if (!/^[A-Za-z0-9_]*$/.test(identifier)) throw new Error('Identifier must not has spaces and must be in English only: ' + identifier + ', tenant: ' + context.getCurrentUser()!.tenantId)

            if (!context.canEditConfig(ConfigAccess.TEMPLATES)) {
                throw new Error('User: ' + context.getCurrentUser()?.login + ' can not edit templates, tenant: ' + context.getCurrentUser()!.tenantId)
            }

            const tst = await Template.applyScope(context).findOne({
                where: {
                    identifier: identifier
                }
            })
            if (tst) {
                throw new Error('Identifier: ' + identifier + ' already exists, tenant: ' + context.getCurrentUser()!.tenantId)
            }

            const val = valid ? valid.map((elem: string) => parseInt(elem)) : []
            const vis = visible ? visible.map((elem: string) => parseInt(elem)) : []

            const temp = await sequelize.transaction(async (t) => {
                const temp = await Template.create({
                    identifier: identifier,
                    tenantId: context.getCurrentUser()!.tenantId,
                    createdBy: context.getCurrentUser()!.login,
                    updatedBy: context.getCurrentUser()!.login,
                    name: name,
                    template: template,
                    templateRichtext: templateRichtext,
                    order: order != null ? order : 0,
                    valid: val,
                    visible: vis,
                    options: options
                }, { transaction: t })
                return temp
            })

            return temp
        },
        updateTemplate: async (parent: any, { id, name, template, templateRichtext, order, valid, visible, options }: any, context: Context) => {
            context.checkAuth()

            if (!context.canEditConfig(ConfigAccess.TEMPLATES)) {
                throw new Error('User: ' + context.getCurrentUser()?.login + ' can not edit templates, tenant: ' + context.getCurrentUser()!.tenantId)
            }

            const nId = parseInt(id)
            const temp = await Template.applyScope(context).findByPk(nId)
            if (!temp) throw new Error('Failed to find template by id: ' + nId + ', tenant: ' + context.getCurrentUser()!.tenantId)

            if (name) temp.name = name
            if (template) temp.template = template
            if (templateRichtext) temp.templateRichtext = templateRichtext
            if (order != null) temp.order = order
            if (valid) temp.valid = valid.map((elem: string) => parseInt(elem))
            if (visible) temp.visible = visible.map((elem: string) => parseInt(elem))
            if (options) temp.options = options
            temp.updatedBy = context.getCurrentUser()!.login
            await sequelize.transaction(async (t) => {
                await temp!.save({ transaction: t })
            })

            return temp
        },
        removeTemplate: async (parent: any, { id }: any, context: Context) => {
            context.checkAuth()

            if (!context.canEditConfig(ConfigAccess.TEMPLATES)) {
                throw new Error('User: ' + context.getCurrentUser()?.login + ' can not edit templates, tenant: ' + context.getCurrentUser()!.tenantId)
            }

            const nId = parseInt(id)
            const temp = await Template.applyScope(context).findByPk(nId)
            if (!temp) throw new Error('Failed to find template by id: ' + nId + ', tenant: ' + context.getCurrentUser()!.tenantId)

            temp.updatedBy = context.getCurrentUser()!.login
            // we have to change identifier during deletion to make possible that it will be possible to make new type with same identifier
            temp.identifier = temp.identifier + '_d_' + Date.now()
            await sequelize.transaction(async (t) => {
                await temp!.save({ transaction: t })
                await temp!.destroy({ transaction: t })
            })

            return true
        }
    }
}