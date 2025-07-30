import userResolvers from './users'
import typeResolvers from './types'
import attrResolvers from './attributes'
import relResolvers from './relations'
import itemResolvers from './items'
import langResolvers from './languages'
import actionResolvers from './actions'
import dashResolvers from './dashboards'
import searchResolvers from './search'
import itemrelationsResolvers from './itemRelations'
import importResolvers from './import'
import importConfigResolvers from './importConfigs'
import lovResolvers from './lovs'
import auditResolvers from './audit'
import chanResolvers from './channels'
import colResolvers from './collections'
import procResolvers from './processes'
import tempResolvers from './templates'
import authResolvers from './auth'
import reloadResolvers from './reload'
import mediaResolvers from './media'
import GraphQLJSON, { GraphQLJSONObject } from 'graphql-type-json'
import LanguageDependentString from './utils/languageDependentString'
import { GraphQLDateTime } from 'graphql-iso-date'
import Context from '../context'
import { QueryTypes } from 'sequelize'
import { sequelize } from '../models'
import { isWebDAVEnabled, setWebDAVEnabled } from '../index'

import logger from '../logger'
import { ModelManager } from '../models/manager'
import fs from 'fs/promises'
import path from 'path'

const getAbsTarget = (root: any, rel: any = '') => {
    const absRoot = path.resolve(root) + path.sep
    const absTarget = path.resolve(root, rel || '')
    if (!absTarget.startsWith(absRoot)) {
        throw new Error('Path is outside of allowed directory')
    }
    return { absRoot, absTarget }
}

const listFiles = async (absTarget: any, type: any = null) => {
    const files = await fs.readdir(absTarget, { withFileTypes: true })
    if (type === 'dir') {
        return files.filter(f => f.isDirectory()).map(f => f.name)
    }
    if (type === 'file') {
        return files.filter(f => f.isFile()).map(f => f.name)
    }
    return files.map(f => ({
        name: f.name,
        type: f.isDirectory() ? 'dir' : 'file'
    }))
}

const statFile = async (absTarget: any) => {
    const stat = await fs.stat(absTarget)
    return {
        name: path.basename(absTarget),
        size: stat.size,
        mtime: stat.mtime,
        isDirectory: stat.isDirectory()
    }
}

const resolver = {
    Query: {
        ping: () => {
            return 'pong'
        },
        serverConfig: () =>  {
            return ModelManager.getServerConfig()
        },
        nextId: async (parent: any, {seqName}: any, context: Context) => {
            context.checkAuth()
            const sequence = seqName ? seqName : 'identifier_seq'
            const results:any = await sequelize.query("SELECT nextval('"+sequence+"')", { 
                type: QueryTypes.SELECT
            });
            const id = (results[0]).nextval
            return id
        },
        isWebDAVEnabled: async (parent: any, {enabled}: any, context: Context) => {
            context.checkAuth()
            if (context.getCurrentUser()!.tenantId != '0' && !context.isAdmin()) {
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to execute queries, tenant: ' + context.getCurrentUser()!.tenantId)
            }
            return isWebDAVEnabled
        },
        ls: async (parent: any, { path: rel }: any, context: Context) => {
            context.checkAuth()
            if (context.getCurrentUser()!.tenantId != '0' && !context.isAdmin()) {
                throw new Error('Недостаточно прав')
            }
            const root = process.env.FILES_ROOT
            if (!root) {
                throw new Error('FILES_ROOT environment variable is not set')
            }
            const { absTarget } = getAbsTarget(root, rel)
            return await listFiles(absTarget)
        },
        lsDirs: async (parent: any, { path: rel }: any, context: Context) => {
            context.checkAuth()
            if (context.getCurrentUser()!.tenantId != '0' && !context.isAdmin()) {
                throw new Error('Недостаточно прав')
            }
            const root = process.env.FILES_ROOT
            if (!root) {
                throw new Error('FILES_ROOT environment variable is not set')
            }
            const { absTarget } = getAbsTarget(root, rel)
            return await listFiles(absTarget, 'dir')
        },
        lsFiles: async (parent: any, { path: rel }: any, context: Context) => {
            context.checkAuth()
            if (context.getCurrentUser()!.tenantId != '0' && !context.isAdmin()) {
                throw new Error('Недостаточно прав')
            }
            const root = process.env.FILES_ROOT
            if (!root) {
                throw new Error('FILES_ROOT environment variable is not set')
            }
            const { absTarget } = getAbsTarget(root, rel)
            return await listFiles(absTarget, 'file')
        },
        stat: async (parent: any, { path: rel }: any, context: Context) => {
            context.checkAuth()
            if (context.getCurrentUser()!.tenantId != '0' && !context.isAdmin()) {
                throw new Error('Недостаточно прав')
            }
            const root = process.env.FILES_ROOT
            if (!root) {
                throw new Error('FILES_ROOT environment variable is not set')
            }
            const { absTarget } = getAbsTarget(root, rel)
            return await statFile(absTarget)
        },
        readFile: async (parent: any, { path: rel }: any, context: Context) => {
            context.checkAuth()
            if (context.getCurrentUser()!.tenantId != '0' && !context.isAdmin()) {
                throw new Error('Недостаточно прав')
            }
            const root = process.env.FILES_ROOT
            if (!root) {
                throw new Error('FILES_ROOT environment variable is not set')
            }
            const { absTarget } = getAbsTarget(root, rel)
            return await fs.readFile(absTarget, 'utf-8')
        }
    }, 
    Mutation: {
        logLevel: async (parent: any, {level}: any, context: Context) => {
            context.checkAuth()    
            if (context.getCurrentUser()!.tenantId != '0' && !context.isAdmin()) {
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to set log level, tenant: ' + context.getCurrentUser()!.tenantId)
            }

            logger.info('Setting log level to ' + level + ' by user: ' + context.getCurrentUser()?.login)

            logger.transports[0].level = level;
            return true
        },
        query: async (parent: any, {query}: any, context: Context) => {
            context.checkAuth()    
            if (context.getCurrentUser()!.tenantId != '0' && !context.isAdmin()) {
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to execute queries, tenant: ' + context.getCurrentUser()!.tenantId)
            }

            logger.debug(`Received query: ${query}`)
            const data:any = await sequelize.query(query, { raw: true })
            if (Array.isArray(data) && data.length > 1) {
                delete data[1].rows
                delete data[1].fields
                delete data[1]._parsers
                delete data[1]._types
                delete data[1].rowAsArray
                delete data[1].RowCtor
                delete data[1].oid
            }
            logger.debug(`data: ${JSON.stringify(data)}`)
            return data
        },
        setWebDAVEnabled: (parent: any, {enabled}: any, context: Context) => {
            context.checkAuth()
            if (context.getCurrentUser()!.tenantId != '0' && !context.isAdmin()) {
                throw new Error('User '+ context.getCurrentUser()?.id+ ' does not has permissions to execute queries, tenant: ' + context.getCurrentUser()!.tenantId)
            }
            setWebDAVEnabled(!!enabled)
            return isWebDAVEnabled
        }
    }
}

export default {
    JSON: GraphQLJSON,
    JSONObject: GraphQLJSONObject,
    LanguageDependentString: LanguageDependentString,
    UTCDateTime: GraphQLDateTime,
    Query: {
        ...resolver.Query,
        ...userResolvers.Query,
        ...typeResolvers.Query,
        ...attrResolvers.Query,
        ...relResolvers.Query,
        ...itemResolvers.Query,
        ...langResolvers.Query,
        ...actionResolvers.Query,
        ...dashResolvers.Query,
        ...itemrelationsResolvers.Query,
        ...searchResolvers.Query,
        ...lovResolvers.Query,
        ...chanResolvers.Query,
        ...auditResolvers.Query,
        ...importConfigResolvers.Query,
        ...colResolvers.Query,
        ...procResolvers.Query,
        ...tempResolvers.Query,
        ...authResolvers.Query,
        ...reloadResolvers.Query,
        ...mediaResolvers.Query
    },
    Mutation: {
        ...resolver.Mutation,
        ...userResolvers.Mutation,
        ...typeResolvers.Mutation,
        ...attrResolvers.Mutation,
        ...relResolvers.Mutation,
        ...itemResolvers.Mutation,
        ...langResolvers.Mutation,
        ...actionResolvers.Mutation,
        ...dashResolvers.Mutation,
        ...itemrelationsResolvers.Mutation,
        ...importResolvers.Mutation,
        ...searchResolvers.Mutation,
        ...lovResolvers.Mutation,
        ...chanResolvers.Mutation,
        ...colResolvers.Mutation,
        ...procResolvers.Mutation,
        ...tempResolvers.Mutation,
        ...importConfigResolvers.Mutation
    },
    SearchResponse: {
        ...searchResolvers.SearchResponse
    },
    ItemsSearchResponse: {
        ...searchResolvers.ItemsSearchResponse
    },
    ItemsResponse: {
        ...itemResolvers.ItemsResponse
    }
}