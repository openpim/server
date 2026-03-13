import Context from '../../context'
import { ErrorProcessing, IImportConfig, IItemRelationImportRequest, ImportMode, ImportResult } from '../../models/import'
import { ItemRelation } from '../../models/itemRelations'
import { importItemRelation } from '../../resolvers/import/itemRelations'
import { evaluateExpression } from '../evaluateExpression'
import { resolveBulkExpressionData } from './expressions'

export interface BulkRelationConfig {
    column?: string
    relationIdentifier?: string
    relationIdentifierExpression?: string
    identifierExpression?: string
    sourceField?: string
    sourceExpression?: string
    targetField?: string
    targetIdentifierExpression?: string
    targetSource?: string
    targetExpression?: string
    valuesExpression?: any
    values?: any
}

type RelationImportResponse = {
    errors?: { message: string }[]
    result?: ImportResult | null
}

type BulkRelationImportDeps = {
    importRelation?: (
        context: Context,
        config: IImportConfig,
        itemRelation: IItemRelationImportRequest
    ) => Promise<RelationImportResponse>
    relationModel?: {
        findAll(params: any): Promise<Array<{
            identifier: string
            values: any
            updatedBy?: string
            save?(): Promise<void>
        }>>
    }
}

export type ResolvedBulkRelationRequest = {
    relationIdentifier: string
    sourceIdentifier: string
    targetIdentifier: string
    relationRequest: IItemRelationImportRequest
}

export type SkippedBulkRelationRequest = {
    skipReason: string
}

function hasExpression(expression: any): boolean {
    return !!(expression && `${expression}`.trim().length)
}

export function getBulkRelationOrder(values: any): number | null {
    if (!values || typeof values !== 'object') return null
    if (!Object.prototype.hasOwnProperty.call(values, '_itemRelationOrder')) return null

    const order = values._itemRelationOrder
    if (order === null || typeof order === 'undefined' || order === '') return null

    const numericOrder = Number(order)
    return Number.isNaN(numericOrder) ? null : numericOrder
}

function findExistingBulkRelationByOrder(relations: Array<{ identifier: string, values: any }>, values: any) {
    const nextOrder = getBulkRelationOrder(values)
    return relations.find(relation => getBulkRelationOrder(relation.values) === nextOrder) || null
}

async function renameExistingBulkRelationIdentifierIfNeeded(
    context: Context,
    relation: { identifier: string, updatedBy?: string, save?(): Promise<void> } | null,
    nextIdentifier: string
) {
    if (!relation || relation.identifier === nextIdentifier) return

    relation.identifier = nextIdentifier

    const currentUser = context.getCurrentUser?.()
    if (currentUser?.login) {
        relation.updatedBy = currentUser.login
    }

    if (typeof relation.save === 'function') {
        await relation.save()
    }
}

export async function upsertBulkRelationForImport(
    context: Context,
    relationRequest: IItemRelationImportRequest,
    deps: BulkRelationImportDeps = {}
) {
    const relationModel = deps.relationModel || (ItemRelation.applyScope(context) as unknown as {
        findAll(params: any): Promise<Array<{ identifier: string, values: any }>>
    })
    const importRelation = deps.importRelation || importItemRelation
    const existingRelations = await relationModel.findAll({
        where: {
            relationIdentifier: relationRequest.relationIdentifier,
            targetIdentifier: relationRequest.targetIdentifier
        },
        order: [['id', 'ASC']]
    } as any)
    const existingRelation = findExistingBulkRelationByOrder(existingRelations as any[], relationRequest.values)
    await renameExistingBulkRelationIdentifierIfNeeded(context, existingRelation as any, relationRequest.identifier)

    const requestForImport: IItemRelationImportRequest = {
        ...relationRequest,
        identifier: relationRequest.identifier,
        relationIdentifier: existingRelation ? '' : relationRequest.relationIdentifier
    }

    const importResponse = await importRelation(context, {
        mode: ImportMode.CREATE_UPDATE,
        errors: ErrorProcessing.PROCESS_WARN
    }, requestForImport)

    if (importResponse.result === ImportResult.REJECTED || (importResponse.errors && importResponse.errors.length > 0)) {
        const errorMessage = importResponse.errors?.map(error => error.message).filter(Boolean).join('; ')
        throw new Error(errorMessage || 'Import item relation rejected')
    }

    return {
        existingRelation,
        importResponse,
        requestForImport
    }
}

export function getBulkRelationConfigs(config: any): BulkRelationConfig[] {
    if (!config || typeof config !== 'object') return []

    const rawRelations = Array.isArray(config.relations)
        ? config.relations
        : (config.relation ? [config.relation] : [])

    return rawRelations.filter((relation: any) => {
        return relation && typeof relation === 'object' && (relation.relationIdentifier || relation.relationIdentifierExpression)
    })
}

export function normalizeBulkRelationValues(values: any): Record<string, any> {
    if (values == null || values === '') return {}

    if (typeof values === 'string') {
        const trimmed = values.trim()
        if (!trimmed) return {}

        let parsed: any
        try {
            parsed = JSON.parse(trimmed)
        } catch (error) {
            throw new Error('Relation values must be a valid JSON object')
        }

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Relation values must be a JSON object')
        }

        return parsed
    }

    if (typeof values === 'object' && !Array.isArray(values)) {
        return values
    }

    throw new Error('Relation values must be a JSON object')
}

export async function resolveBulkRelationRequest(
    relationConfig: BulkRelationConfig,
    row: Record<string, any>,
    fileItemIdentifier: string,
    context: Context,
    buildRelationIdentifier: (relationIdentifier: string, sourceIdentifier: string, targetIdentifier: string) => string
): Promise<ResolvedBulkRelationRequest | SkippedBulkRelationRequest> {
    const relationData = resolveBulkExpressionData(relationConfig.column, row)

    const sourceField = relationConfig.sourceField || relationConfig.targetSource
    const sourceExpression = relationConfig.sourceExpression || relationConfig.targetExpression
    const sourceData = sourceField
        ? resolveBulkExpressionData(sourceField, row)
        : relationData
    const sourceIdentifierRaw = hasExpression(sourceExpression)
        ? await evaluateExpression(null, sourceData, sourceExpression!, context)
        : sourceData

    if (!sourceIdentifierRaw) {
        return { skipReason: 'source identifier is empty.' }
    }

    const sourceIdentifier = '' + sourceIdentifierRaw

    const targetData = relationConfig.targetField
        ? resolveBulkExpressionData(relationConfig.targetField, row)
        : relationData
    const targetIdentifierRaw = hasExpression(relationConfig.targetIdentifierExpression)
        ? await evaluateExpression(null, targetData, relationConfig.targetIdentifierExpression!, context)
        : targetData
    const targetIdentifier = targetIdentifierRaw ? '' + targetIdentifierRaw : fileItemIdentifier

    if (!targetIdentifier) {
        return { skipReason: 'target identifier is empty.' }
    }

    const relationIdentifierRaw = hasExpression(relationConfig.relationIdentifierExpression)
        ? await evaluateExpression(null, relationData, `${relationConfig.relationIdentifierExpression}`, context)
        : relationConfig.relationIdentifier

    if (!relationIdentifierRaw) {
        return { skipReason: 'relation type is empty.' }
    }

    const relationIdentifier = '' + relationIdentifierRaw
    const relationItemIdentifierRaw = hasExpression(relationConfig.identifierExpression)
        ? await evaluateExpression(null, relationData, `${relationConfig.identifierExpression}`, context)
        : buildRelationIdentifier(relationIdentifier, sourceIdentifier, targetIdentifier)

    if (!relationItemIdentifierRaw) {
        return { skipReason: 'relation identifier is empty.' }
    }

    const relationRequest: IItemRelationImportRequest = {
        delete: false,
        relationIdentifier,
        identifier: '' + relationItemIdentifierRaw,
        itemIdentifier: sourceIdentifier,
        targetIdentifier,
        values: hasExpression(relationConfig.valuesExpression)
            ? normalizeBulkRelationValues(await evaluateExpression(null, relationData, `${relationConfig.valuesExpression}`, context))
            : normalizeBulkRelationValues(relationConfig.values),
        skipActions: false
    }

    return {
        relationIdentifier,
        sourceIdentifier,
        targetIdentifier,
        relationRequest
    }
}
