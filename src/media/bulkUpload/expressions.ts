import Context from '../../context'
import { IItemImportRequest } from '../../models/import'
import { evaluateExpression } from '../evaluateExpression'
import { BulkRuntimeFileInfo } from './runtime'

type BulkMapping = {
    attribute?: string
    column?: string
    expression?: string
}

function removeBulkFileExtension(name: string): string {
    const idx = name.lastIndexOf('.')
    return idx > 0 ? name.substring(0, idx) : name
}

function getBulkFileExtension(name: string): string {
    const idx = name.lastIndexOf('.')
    return idx > 0 ? name.substring(idx + 1).toLowerCase() : ''
}

export function buildBulkFileRow(fileInfo: BulkRuntimeFileInfo): Record<string, any> {
    return {
        $fileName: removeBulkFileExtension(fileInfo.originalName),
        $fileNameFull: fileInfo.originalName,
        $fileExt: getBulkFileExtension(fileInfo.originalName),
        $fileMimeType: fileInfo.mimeType,
        $fileSize: fileInfo.size,
        $fileIndex: fileInfo.idx
    }
}

export function resolveBulkExpressionData(column: string | undefined, row: Record<string, any>): any {
    if (!column) return null
    return typeof row[column] === 'undefined' ? null : row[column]
}

function hasExpression(expression: any): boolean {
    return !!(expression && `${expression}`.length)
}

export async function mapBulkFile(
    mappings: BulkMapping[],
    row: Record<string, any>,
    context: Context
): Promise<IItemImportRequest> {
    const result: IItemImportRequest = {
        identifier: '',
        newIdentifier: '',
        delete: false,
        skipActions: false,
        typeIdentifier: '',
        parentIdentifier: '',
        name: {},
        values: {},
        channels: {}
    }

    for (let i = 0; i < mappings.length; i++) {
        const mapping = mappings[i]
        if (!mapping || !mapping.attribute) continue

        const data = mapping.column ? resolveBulkExpressionData(mapping.column, row) : null
        if (!mapping.column && !mapping.expression) continue

        const mappedData = hasExpression(mapping.expression)
            ? await evaluateExpression(null, data, mapping.expression!, context)
            : data

        if (mapping.attribute === 'identifier' || mapping.attribute === 'newIdentifier' || mapping.attribute === 'typeIdentifier' || mapping.attribute === 'parentIdentifier') {
            result[mapping.attribute] = mappedData == null ? '' : '' + mappedData
        } else if (mapping.attribute.startsWith('$name#')) {
            const langIdentifier = mapping.attribute.substring(6)
            result.name[langIdentifier] = mappedData
        } else {
            result.values[mapping.attribute] = mappedData
        }
    }

    return result
}
