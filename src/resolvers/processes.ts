import Context from '../context'
import { sequelize } from '../models'
import { Process } from '../models/processes'
import { FindAndCountOptions, fn, literal, Op } from 'sequelize'
import { FieldNode, GraphQLResolveInfo, SelectionNode } from 'graphql'
import { replaceOperations } from './utils'

let processCache:any = {}

const PROCESS_FIELDS = new Set([
    'id',
    'identifier',
    'title',
    'active',
    'status',
    'finishTime',
    'storagePath',
    'mimeType',
    'fileName',
    'log',
    'runtime',
    'createdBy',
    'createdAt',
    'updatedBy',
    'updatedAt'
])

function getRequestedProcessAttributes(info: GraphQLResolveInfo): string[] {
    const rowsField = info.fieldNodes[0]?.selectionSet?.selections.find(
        (selection): selection is FieldNode =>
            selection.kind === 'Field' && selection.name.value === 'rows' && !!selection.selectionSet
    )
    if (!rowsField?.selectionSet) return ['id']

    const attrs = rowsField.selectionSet.selections
        .filter((selection): selection is FieldNode => selection.kind === 'Field')
        .filter(selection => PROCESS_FIELDS.has(selection.name.value))
        .map(selection => selection.name.value)

    return attrs.length > 0 ? attrs : ['id']
}

export function clearProcessCache() {
    processCache = {}
}

export default {
    Query: {
        getProcesses: async (parent: any, request : any, context: Context, info: GraphQLResolveInfo) => {
            context.checkAuth()

            const deleteTime = Date.now() - 1000 * 50
            for (const prop in processCache) {
                const tst = processCache[prop]
                if (tst.date < deleteTime) delete processCache[prop]
            }

            const attributes = getRequestedProcessAttributes(info)
            const key = JSON.stringify({ request, attributes }) + context.getCurrentUser()!.login
            const proc = processCache[key]
            if (proc && proc.res) return proc.res
            
            const params: FindAndCountOptions = {
                attributes,
                offset: request.offset,
                limit: request.limit
            }
            const whereAdd = {createdBy: context.getCurrentUser()!.login}
            if (request.where) {
                const include = replaceOperations(request.where, context)
                params.where = { [Op.and]: [whereAdd, request.where] }
                if (include && include.length > 0) params.include = include
            } else {
                params.where = whereAdd
            }

            if (request.order) params.order = request.order

            const res = await Process.applyScope(context).findAndCountAll(params)    
            processCache[key] = {res: res, date: Date.now()}
            return res
        }
    },
    Mutation: {
        createProcess: async (parent: any, {identifier, title, active, status, log, runtime}: any, context: Context) => {
            context.checkAuth()
            if (!/^[A-Za-z0-9_]*$/.test(identifier)) throw new Error('Identifier must not has spaces and must be in English only: ' + identifier + ', tenant: ' + context.getCurrentUser()!.tenantId)

            const tst = await Process.applyScope(context).findOne({
                where: {
                    identifier: identifier
                }
            })
            if (tst) {
                throw new Error('Identifier: ' + identifier + ' already exists, tenant: ' + context.getCurrentUser()!.tenantId)
            }

            const proc = await sequelize.transaction(async (t) => {
                const proc = await Process.create ({
                    identifier: identifier,
                    tenantId: context.getCurrentUser()!.tenantId,
                    createdBy: context.getCurrentUser()!.login,
                    updatedBy: context.getCurrentUser()!.login,
                    title: title,
                    active: active != null ? active : true,
                    status: status || '',
                    log: log || '',
                    runtime: runtime || {},
                    finishTime: null,
                    storagePath: '',
                    mimeType: '',
                    fileName: ''
                }, {transaction: t})
                return proc
            })

            processCache = {}
            return proc
        },
        updateProcess: async (parent: any, { id, title, active, status, log, runtime }: any, context: Context) => {
            context.checkAuth()

            const nId = parseInt(id)
            const proc = await Process.applyScope(context).findByPk(nId)
            if (!proc) throw new Error('Failed to find process by id: ' + nId + ', tenant: ' + context.getCurrentUser()!.tenantId)
            if (proc.createdBy !== context.getCurrentUser()?.login) 
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to update process: '+proc.id+', tenant: ' + context.getCurrentUser()!.tenantId)

            if (title) proc.title = title
            if (active !== null && active !== undefined) {
                if (proc.active && !active) proc.finishTime = new Date()
                proc.active = active
            }
            if (status != null) proc.status = status
            if (log != null) proc.log = log
            if (runtime) proc.runtime = runtime
            proc.updatedBy = context.getCurrentUser()!.login
            await sequelize.transaction(async (t) => {
                await proc!.save({transaction: t})
            })

            processCache = {}
            return proc
        },
        removeProcess: async (parent: any, { id }: any, context: Context) => {
            context.checkAuth()

            const nId = parseInt(id)
            const proc = await Process.applyScope(context).findByPk(nId)
            if (!proc) throw new Error('Failed to find process by id: ' + nId + ', tenant: ' + context.getCurrentUser()!.tenantId)
            if (proc.createdBy !== context.getCurrentUser()?.login) 
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to delete process: '+proc.id+', tenant: ' + context.getCurrentUser()!.tenantId)

            proc.updatedBy = context.getCurrentUser()!.login
            // we have to change identifier during deletion to make possible that it will be possible to make new type with same identifier
            proc.identifier = proc.identifier + '_d_' + Date.now() 
            await sequelize.transaction(async (t) => {
                await proc!.save({transaction: t})
                await proc!.destroy({transaction: t})
            })

            processCache = {}
            return true
        }
    }
}
