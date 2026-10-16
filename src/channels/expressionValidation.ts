import { validateMappingExpression } from './expressions'

// Validate only new/edited source so unrelated SAVE does not reject legacy rules.
export function validateChannelExpressions(config: any, mappings: any, previousConfig: any = {}, previousMappings: any = {}): void {
    const check = (source: any, previous: any, path: string) => {
        if (source === previous || source == null || source === '') return
        if (typeof source !== 'string') throw new Error(path + ': expression must be a string.')
        const diagnostic = validateMappingExpression(source)
        if (!diagnostic.valid) throw new Error(path + ': ' + diagnostic.message + ' (line ' + diagnostic.line + ', column ' + diagnostic.column + ')')
    }
    check(config?.variantExpr, previousConfig?.variantExpr, 'variantExpr')
    for (const field of config?.ymShopAttributes || []) check(field.expr, previousConfig?.ymShopAttributes?.find((row: any) => (row.id ?? row.name) === (field.id ?? field.name))?.expr, 'ymShopAttributes.' + (field.id ?? field.name))
    for (const [id, category] of Object.entries<any>(mappings || {})) {
        if (!category || category.deleted) continue
        const previous = previousMappings?.[id]
        check(category.categoryExpr, previous?.categoryExpr, id + '.categoryExpr')
        for (const field of category.attributes || []) check(field.expr, previous?.attributes?.find((row: any) => row.id === field.id)?.expr, id + '.' + field.id)
    }
}
