import type { MappingRequest, MappingSuggestion } from './mapping'

const types: Record<number, string> = { 1: 'text', 2: 'boolean', 3: 'integer', 4: 'float', 5: 'date', 6: 'time', 7: 'dictionary', 8: 'url', 9: 'relation' }
const units: Record<string, string> = { 'квт': 'кВт', kw: 'кВт', 'вт': 'Вт', w: 'Вт', 'кг': 'кг', kg: 'кг', 'г': 'г', g: 'г', 'см': 'см', cm: 'см', 'мм': 'мм', mm: 'мм', 'м': 'м', m: 'м', 'л': 'л', l: 'л', 'мл': 'мл', ml: 'мл', 'дб': 'дБ', db: 'дБ' }

function candidateUnit(name: string): string | null {
    const match = name.match(/(?:^|[^\p{L}])(квт|kw|вт|w|кг|kg|г|g|см|cm|мм|mm|мл|ml|л|l|дб|db)(?=$|[^\p{L}])/iu)
    return match ? units[match[1].toLowerCase()] : null
}

function sample(value: any) {
    if (!value) return null
    return { status: value.status === 'loaded' ? 'loaded' : 'unavailable',
        examples: Array.isArray(value.examples) ? value.examples.filter((row: any) => typeof row === 'string').slice(0, 8).map((row: string) => row.slice(0, 80)) : [],
        total: Number.isSafeInteger(value.total) && value.total >= 0 ? value.total : null, truncated: !!value.truncated,
        sharedByAttributes: Number.isSafeInteger(value.sharedByAttributes) ? value.sharedByAttributes : 0 }
}

function describeCandidate(candidate: any) {
    return { attrIdent: candidate.attrIdent, name: candidate.name, group: candidate.group, typeName: types[candidate.type] || 'unknown',
        unit: candidateUnit(candidate.name || ''), valueOptions: sample(candidate.valueOptions) }
}

export function buildMappingReview(request: MappingRequest, suggestion: MappingSuggestion) {
    const attribute = request.attribute
    const marketType = attribute.typeName || (attribute.dictionary ? 'dictionary' : attribute.numeric ? 'number' : /\(boolean\)|\[булево\]/i.test(attribute.name) ? 'boolean' : /\(text\)|\[текст\]/i.test(attribute.name) ? 'text' : 'unknown')
    const marketplace = { id: attribute.id, name: attribute.name, description: attribute.description,
        typeName: marketType, unit: attribute.unit || null, valueOptions: sample(attribute.valueOptions) }
    const chosen = request.candidates.find(candidate => candidate.attrIdent === suggestion.attrIdent)
    const pim = chosen ? describeCandidate(chosen) : null
    const checks: string[] = []
    let kind = !chosen ? 'unmatched' : suggestion.needsReview ? 'review' : 'direct'
    if (chosen && pim) {
        const sameRepresentation = (attribute.dictionary && chosen.type === 7) || (attribute.numeric && [3, 4].includes(chosen.type)) ||
            (marketType === 'boolean' && chosen.type === 2) || (marketType === 'text' && [1, 8].includes(chosen.type))
        if (marketType === 'unknown') checks.push('marketplace_type_unknown')
        else if (!sameRepresentation) { checks.push('representation_differs'); kind = 'conversion' }
        if (attribute.numeric && marketplace.unit && pim.unit && (units[marketplace.unit.toLowerCase()] || marketplace.unit) !== pim.unit) {
            checks.push('units_differ'); kind = 'conversion'
        }
        if (attribute.numeric && marketplace.unit && !pim.unit) checks.push('unit_unknown')
        const dimension = /ширин|высот|глубин|длин|размер/i.test(attribute.name)
        const niche = /встраив|ниш/i
        const packaging = /упаков/i
        const gasBurners = /конфор/i.test(attribute.name) && /газов/i.test(attribute.name) && /конфор/i.test(chosen.name) && !/газов/i.test(chosen.name)
        if ((dimension && ((niche.test(attribute.name) !== niche.test(chosen.name)) || (packaging.test(attribute.name) !== packaging.test(chosen.name)))) || gasBurners) {
            checks.push('scope_differs'); kind = 'review'
        }
        if ((pim.valueOptions?.sharedByAttributes || 0) > 1) checks.push('shared_dictionary')
        if ((attribute.dictionary && marketplace.valueOptions?.status !== 'loaded') || (chosen.type === 7 && pim.valueOptions?.status !== 'loaded')) checks.push('dictionary_unknown')
        if (kind === 'direct' && checks.length) kind = 'review'
    }
    return { kind, checks, marketplace, pim, candidates: request.candidates.slice(0, 5).map(describeCandidate) }
}
