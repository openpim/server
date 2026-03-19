import * as fs from 'fs'
import * as http from 'http'
import * as https from 'https'
import * as os from 'os'
import moment from 'moment'
import Context from '../context'
import logger from '../logger'
import { Item } from '../models/items'
import { ItemRelation } from '../models/itemRelations'
import { LOV } from '../models/lovs'
import { ModelsManager } from '../models/manager'
import { ActionUtils, mergeValues, replaceOperations } from '../resolvers/utils'

export type ItemReference = number | string | { id?: number, identifier?: string, itemId?: number, itemIdentifier?: string }
export type ItemReferenceWhere = { itemId?: number, itemIdentifier?: string }
export type TargetReferenceWhere = { targetId?: number, targetIdentifier?: string }
export type ItemRelationRow = {
    id?: number
    identifier?: string
    relationId?: number
    relationIdentifier?: string
    itemId?: number
    itemIdentifier?: string
    targetId?: number
    targetIdentifier?: string
    values?: any
}
export type QueryOptions = {
    limit?: number
    offset?: number
    order?: any
}

type CacheStore = {
    get<T>(key: string): T | undefined
    set<T>(key: string, value: T, ttl?: number): boolean
    has(key: string): boolean
    del(key: string): number
}

type QueryModel<T> = {
    count(params: { where: any } & QueryOptions): Promise<number>
    findAll(params: { where: any } & QueryOptions): Promise<T[]>
    findOne(params: { where: any } & QueryOptions): Promise<T | null>
}

type EvaluationDeps = {
    actionUtils?: Pick<ActionUtils, 'createItem' | 'createItemRelation' | 'saveFile'>
    itemModel?: QueryModel<Item>
    itemRelationModel?: QueryModel<ItemRelation>
    lovModel?: Pick<QueryModel<LOV>, 'findOne'>
    logger?: Pick<typeof logger, 'debug'>
    replaceOperations?: (obj: any, context: Context | null) => any
    store?: CacheStore
}

type QueryExecutor<T> = {
    count(where: any, options?: QueryOptions): Promise<number>
    exists(where: any, options?: QueryOptions): Promise<boolean>
    findMany(where: any, options?: QueryOptions): Promise<T[]>
    findOne(where: any, options?: QueryOptions): Promise<T | null>
}

type LovValue = {
    id: number
    value?: Record<string, string | null>
    [key: string]: any
}

type ReferenceFieldNames = {
    genericIdKey: 'id'
    genericIdentifierKey: 'identifier'
    idKey: 'itemId' | 'targetId'
    identifierKey: 'itemIdentifier' | 'targetIdentifier'
}

function normalizeReference(
    reference: ItemReference,
    label: string,
    fields: ReferenceFieldNames
): Partial<Record<'itemId' | 'itemIdentifier' | 'targetId' | 'targetIdentifier', number | string>> {
    if (typeof reference === 'number') {
        return { [fields.idKey]: reference }
    }

    if (typeof reference === 'string') {
        return { [fields.identifierKey]: reference }
    }

    if (reference && typeof reference === 'object') {
        const typedId = reference[fields.idKey as keyof typeof reference]
        if (typeof typedId === 'number') {
            return { [fields.idKey]: typedId }
        }

        const genericId = reference[fields.genericIdKey]
        if (typeof genericId === 'number') {
            return { [fields.idKey]: genericId }
        }

        const typedIdentifier = reference[fields.identifierKey as keyof typeof reference]
        if (typeof typedIdentifier === 'string' && typedIdentifier.length) {
            return { [fields.identifierKey]: typedIdentifier }
        }

        const genericIdentifier = reference[fields.genericIdentifierKey]
        if (typeof genericIdentifier === 'string' && genericIdentifier.length) {
            return { [fields.identifierKey]: genericIdentifier }
        }
    }

    throw new Error(`Failed to normalize ${label}`)
}

export function normalizeItemReference(reference: ItemReference, label = 'reference'): ItemReferenceWhere {
    return normalizeReference(
        reference,
        label,
        {
            genericIdKey: 'id',
            genericIdentifierKey: 'identifier',
            idKey: 'itemId',
            identifierKey: 'itemIdentifier'
        }
    ) as ItemReferenceWhere
}

export function assertValidRelationIdentifier(relationIdentifier: string): string {
    if (!relationIdentifier || !relationIdentifier.trim()) {
        throw new Error('relationIdentifier is required')
    }

    return relationIdentifier
}

function normalizeTargetReference(reference: ItemReference, label = 'reference'): TargetReferenceWhere {
    return normalizeReference(
        reference,
        label,
        {
            genericIdKey: 'id',
            genericIdentifierKey: 'identifier',
            idKey: 'targetId',
            identifierKey: 'targetIdentifier'
        }
    ) as TargetReferenceWhere
}

function buildWhere(where: any, context: Context, replaceOps: (obj: any, context: Context | null) => any): any {
    const condition = where ? { ...where } : {}
    replaceOps(condition, context)
    return condition
}

function createQueryExecutor<T>(model: QueryModel<T>, context: Context, deps: EvaluationDeps): QueryExecutor<T> {
    const replaceOps = deps.replaceOperations || replaceOperations
    const log = deps.logger || logger

    return {
        async count(where: any, options: QueryOptions = {}): Promise<number> {
            const scopedWhere = buildWhere(where, context, replaceOps)
            log.debug(`evaluateExpression count, where: ${JSON.stringify(scopedWhere)}`)
            return await model.count({ where: scopedWhere, ...options })
        },
        async exists(where: any, options: QueryOptions = {}): Promise<boolean> {
            return (await this.count(where, options)) > 0
        },
        async findMany(where: any, options: QueryOptions = {}): Promise<T[]> {
            const scopedWhere = buildWhere(where, context, replaceOps)
            log.debug(`evaluateExpression findMany, where: ${JSON.stringify(scopedWhere)}`)
            return await model.findAll({ where: scopedWhere, ...options })
        },
        async findOne(where: any, options: QueryOptions = {}): Promise<T | null> {
            const scopedWhere = buildWhere(where, context, replaceOps)
            log.debug(`evaluateExpression findOne, where: ${JSON.stringify(scopedWhere)}`)
            return await model.findOne({ where: scopedWhere, ...options })
        }
    }
}

function ensureStore(context: Context, store?: CacheStore): CacheStore {
    if (store) return store
    return ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId).getCache() as CacheStore
}

function ensureItemModel(context: Context, model?: QueryModel<Item>): QueryModel<Item> {
    return model || (Item.applyScope(context) as QueryModel<Item>)
}

function ensureItemRelationModel(context: Context, model?: QueryModel<ItemRelation>): QueryModel<ItemRelation> {
    return model || (ItemRelation.applyScope(context) as QueryModel<ItemRelation>)
}

function ensureLovModel(context: Context, model?: Pick<QueryModel<LOV>, 'findOne'>): Pick<QueryModel<LOV>, 'findOne'> {
    return model || (LOV.applyScope(context) as Pick<QueryModel<LOV>, 'findOne'>)
}

function ensureActionUtils(context: Context, actionUtils?: Pick<ActionUtils, 'createItem' | 'createItemRelation' | 'saveFile'>): Pick<ActionUtils, 'createItem' | 'createItemRelation' | 'saveFile'> {
    return actionUtils || new ActionUtils(context)
}

function orderItemsByIds<T extends { id?: number }>(items: T[], ids: number[]): T[] {
    const itemsById = new Map<number, T>()
    items.forEach(item => {
        if (typeof item.id === 'number') itemsById.set(item.id, item)
    })

    return ids
        .map(id => itemsById.get(id))
        .filter((item): item is T => !!item)
}

async function resolveRelatedItems(
    itemModel: QueryModel<Item>,
    relations: ItemRelation[],
    side: 'source' | 'target',
    full: boolean
): Promise<Item[] | Item | null> {
    const ids = side === 'source'
        ? relations.map(relation => relation.itemId).filter((id): id is number => typeof id === 'number')
        : relations.map(relation => relation.targetId).filter((id): id is number => typeof id === 'number')

    if (!ids.length) {
        return full ? [] : null
    }

    const items = await itemModel.findAll({ where: { id: ids } })
    const orderedItems = orderItemsByIds(items, ids)

    return full ? orderedItems : (orderedItems[0] || null)
}

export function getSourceRelationWhere(
    relationIdentifier: string,
    sourceRef: ItemReference,
    targetRef?: ItemReference
): ItemRelationRow {
    const where: ItemRelationRow = {
        relationIdentifier: assertValidRelationIdentifier(relationIdentifier),
        ...normalizeItemReference(sourceRef, 'sourceRef')
    }

    if (typeof targetRef !== 'undefined') {
        Object.assign(where, normalizeTargetReference(targetRef, 'targetRef'))
    }

    return where
}

export function getTargetRelationWhere(
    relationIdentifier: string,
    targetRef: ItemReference,
    sourceRef?: ItemReference
): ItemRelationRow {
    const where: ItemRelationRow = {
        relationIdentifier: assertValidRelationIdentifier(relationIdentifier),
        ...normalizeTargetReference(targetRef, 'targetRef')
    }

    if (typeof sourceRef !== 'undefined') {
        Object.assign(where, normalizeItemReference(sourceRef, 'sourceRef'))
    }

    return where
}

export function createItemsUtils(context: Context, deps: EvaluationDeps = {}) {
    const query = createQueryExecutor(ensureItemModel(context, deps.itemModel), context, deps)

    return {
        count(where: any, options?: QueryOptions) {
            return query.count(where, options)
        },
        exists(where: any, options?: QueryOptions) {
            return query.exists(where, options)
        },
        findMany(where: any, options?: QueryOptions) {
            return query.findMany(where, options)
        },
        findOne(where: any, options?: QueryOptions) {
            return query.findOne(where, options)
        }
    }
}

export function createItemRelationsUtils(context: Context, deps: EvaluationDeps = {}) {
    const relationModel = ensureItemRelationModel(context, deps.itemRelationModel)
    const itemModel = ensureItemModel(context, deps.itemModel)
    const query = createQueryExecutor(relationModel, context, deps)

    async function getSourceItems(relationIdentifier: string, targetRef: ItemReference, full: true): Promise<Item[]>
    async function getSourceItems(relationIdentifier: string, targetRef: ItemReference, full?: false): Promise<Item | null>
    async function getSourceItems(relationIdentifier: string, targetRef: ItemReference, full = false): Promise<Item[] | Item | null> {
        const relations = await query.findMany(getTargetRelationWhere(relationIdentifier, targetRef))
        return await resolveRelatedItems(itemModel, relations, 'source', full)
    }

    async function getTargetItems(relationIdentifier: string, sourceRef: ItemReference, full: true): Promise<Item[]>
    async function getTargetItems(relationIdentifier: string, sourceRef: ItemReference, full?: false): Promise<Item | null>
    async function getTargetItems(relationIdentifier: string, sourceRef: ItemReference, full = false): Promise<Item[] | Item | null> {
        const relations = await query.findMany(getSourceRelationWhere(relationIdentifier, sourceRef))
        return await resolveRelatedItems(itemModel, relations, 'target', full)
    }

    return {
        count(where: any, options?: QueryOptions) {
            return query.count(where, options)
        },
        exists(where: any, options?: QueryOptions) {
            return query.exists(where, options)
        },
        findMany(where: any, options?: QueryOptions) {
            return query.findMany(where, options)
        },
        findOne(where: any, options?: QueryOptions) {
            return query.findOne(where, options)
        },
        forSource(relationIdentifier: string, sourceRef: ItemReference, options?: QueryOptions) {
            return query.findMany(getSourceRelationWhere(relationIdentifier, sourceRef), options)
        },
        forTarget(relationIdentifier: string, targetRef: ItemReference, options?: QueryOptions) {
            return query.findMany(getTargetRelationWhere(relationIdentifier, targetRef), options)
        },
        findSource(relationIdentifier: string, sourceRef: ItemReference, targetRef: ItemReference, options?: QueryOptions) {
            return query.findOne(getSourceRelationWhere(relationIdentifier, sourceRef, targetRef), options)
        },
        findTarget(relationIdentifier: string, targetRef: ItemReference, sourceRef: ItemReference, options?: QueryOptions) {
            return query.findOne(getTargetRelationWhere(relationIdentifier, targetRef, sourceRef), options)
        },
        getSourceItems,
        getTargetItems
    }
}

function normalizeLovValue(value: string | null | undefined, caseInsensitive: boolean): string | null {
    if (value === null || typeof value === 'undefined') return null
    return caseInsensitive ? `${value}`.toLowerCase() : `${value}`
}

function readLovText(lovValue: LovValue | null, lang: string): string | null {
    if (!lovValue?.value) return null
    const localized = lovValue.value[lang]
    return typeof localized === 'undefined' ? null : localized
}

export function createLovsUtils(context: Context, deps: EvaluationDeps = {}) {
    const store = ensureStore(context, deps.store)
    const lovModel = ensureLovModel(context, deps.lovModel)

    async function get(identifier: string): Promise<LOV> {
        const cacheKey = `IM_LOV_${identifier}`
        const cached = store.get<LOV>(cacheKey)
        if (cached) return cached

        const lov = await lovModel.findOne({ where: { identifier } })
        if (!lov) {
            throw new Error(`Failed to find LOV by identifier: ${identifier}`)
        }

        store.set(cacheKey, lov, 60 * 60)
        return lov
    }

    async function listValues(identifier: string): Promise<LovValue[]> {
        const lov = await get(identifier)
        return Array.isArray(lov.values) ? lov.values : []
    }

    async function getValue(identifier: string, id: number): Promise<LovValue | null> {
        const values = await listValues(identifier)
        return values.find(value => value.id === id) || null
    }

    async function findValue(
        identifier: string,
        value: string,
        options: { lang?: string, caseInsensitive?: boolean } = {}
    ): Promise<LovValue | null> {
        const { lang = 'en', caseInsensitive = false } = options
        const expected = normalizeLovValue(value, caseInsensitive)
        const values = await listValues(identifier)

        return values.find(lovValue => normalizeLovValue(readLovText(lovValue, lang), caseInsensitive) === expected) || null
    }

    return {
        findValue,
        async findValueId(identifier: string, value: string, options?: { lang?: string, caseInsensitive?: boolean }) {
            const lovValue = await findValue(identifier, value, options)
            return lovValue?.id || null
        },
        get,
        async getValue(identifier: string, id: number) {
            return await getValue(identifier, id)
        },
        async getValueText(identifier: string, id: number, lang = 'en') {
            const lovValue = await getValue(identifier, id)
            return readLovText(lovValue, lang)
        },
        async hasValue(identifier: string, value: string, options?: { lang?: string, caseInsensitive?: boolean }) {
            return !!(await findValue(identifier, value, options))
        },
        listValues
    }
}

export function createCacheUtils(store: CacheStore) {
    return {
        del(key: string) {
            return store.del(key)
        },
        get<T>(key: string) {
            return store.get<T>(key)
        },
        has(key: string) {
            return store.has(key)
        },
        set<T>(key: string, value: T, ttl?: number) {
            if (typeof ttl === 'number') {
                return store.set(key, value, ttl)
            }

            return store.set(key, value)
        }
    }
}

export function createEvaluationUtils(context: Context, deps: EvaluationDeps = {}) {
    const store = ensureStore(context, deps.store)
    const items = createItemsUtils(context, deps)
    const lovs = createLovsUtils(context, { ...deps, store })
    const itemRelations = createItemRelationsUtils(context, deps)
    const itemModel = ensureItemModel(context, deps.itemModel)
    const relationModel = ensureItemRelationModel(context, deps.itemRelationModel)
    const actionUtils = ensureActionUtils(context, deps.actionUtils)

    const legacyUtils: {
        downloadAndAssignFile: (url: string, itemIdentifier: string, fileIdentifier: string, fileType: string, fileParent: string, fileName: any, fileValues: any, relationType: string, relationIdentifier: string, relationValues: any, skipActions?: boolean) => Promise<void>
        downloadFile: (url: string, targetPath: string) => Promise<string | null>
    } = {
        async downloadFile(url: string, targetPath: string): Promise<string | null> {
            return await new Promise((resolve, reject) => {
                const file = fs.createWriteStream(targetPath)
                const get = url.startsWith('https:') ? https.get : http.get

                get(url, response => {
                    const mimeType = response.headers['content-type']
                    response.pipe(file)

                    file.on('finish', () => {
                        file.close(() => resolve(typeof mimeType === 'string' ? mimeType : null))
                    })

                    file.on('error', err => {
                        fs.unlink(targetPath, () => reject(err))
                    })
                }).on('error', err => {
                    fs.unlink(targetPath, () => reject(err))
                })
            })
        },
        async downloadAndAssignFile(url: string, itemIdentifier: string, fileIdentifier: string, fileType: string, fileParent: string, fileName: any, fileValues: any, relationType: string, relationIdentifier: string, relationValues: any, skipActions = false): Promise<void> {
            if (!url) return

            const tmpFile = `${os.tmpdir()}/${Date.now()}`
            const mimeType = await legacyUtils.downloadFile(url, tmpFile)
            let file = await itemModel.findOne({ where: { identifier: fileIdentifier } })

            if (!file) {
                file = await actionUtils.createItem(fileParent, fileType, fileIdentifier, { ru: fileName }, fileValues, skipActions)
                await file.save()
            }

            await actionUtils.saveFile(file, tmpFile, mimeType, fileName, true)
            file.values = mergeValues(fileValues, file.values)
            file.changed('values', true)
            await file.save()

            const relation = await relationModel.findOne({ where: { identifier: relationIdentifier } })
            if (!relation) {
                await actionUtils.createItemRelation(relationType, relationIdentifier, itemIdentifier, file.identifier, relationValues, skipActions)
                return
            }

            relation.values = mergeValues(relationValues, relation.values)
            relation.changed('values', true)
            await relation.save()
        }
    }

    return {
        cache: createCacheUtils(store),
        downloadAndAssignFile: legacyUtils.downloadAndAssignFile,
        downloadFile: legacyUtils.downloadFile,
        findItem(where: any, options?: QueryOptions) {
            return items.findOne(where, options)
        },
        findItems(where: any, options?: QueryOptions) {
            return items.findMany(where, options)
        },
        async findLOV(identifier: string, value: string, lang = 'en', caseInsensitive = false, createIfNotExists = false): Promise<number | null> {
            const existingId = await lovs.findValueId(identifier, value, { lang, caseInsensitive })
            if (existingId || !createIfNotExists) {
                return existingId
            }

            const lov = await lovs.get(identifier)
            const values = Array.isArray(lov.values) ? lov.values : []
            const nextId = values.reduce((max, current) => Math.max(max, current?.id || 0), 0) + 1
            const newValue = { id: nextId, value: { [lang]: value }, filter: null }

            values.push(newValue)
            lov.values = values
            lov.changed('values', true)
            await lov.save()

            return newValue.id
        },
        getCache() {
            return store
        },
        itemRelations,
        items,
        lovs,
        relations: itemRelations
    }
}

function createEvaluationRuntime(context: Context) {
    const actionUtils = new ActionUtils(context)
    return {
        actionUtils,
        logger,
        moment,
        utils: createEvaluationUtils(context, { actionUtils })
    }
}

export function serializeExpressionDataForLog(data: any): string {
    try {
        const json = JSON.stringify(data)
        return typeof json === 'string' ? json : String(data)
    } catch (error) {
        return String(data)
    }
}

export async function evaluateExpression(row: any, data: any, expression: string, context: Context): Promise<any> {
    try {
        const runtime = createEvaluationRuntime(context)
        const func = new Function(
            'row',
            'data',
            'utils',
            'actionUtils',
            'moment',
            'logger',
            '"use strict"; return (async () => { return (' + expression + ')})()'
        )
        return await func(row, data, runtime.utils, runtime.actionUtils, runtime.moment, runtime.logger)
    } catch (err: any) {
        logger.error(`Failed to execute expression :[${expression}] for data: ${serializeExpressionDataForLog(data)} with error: ${err.message}`)
        throw err
    }
}
