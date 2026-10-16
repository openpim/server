import { MappingCandidate, rankLexicalCandidates } from './mapping'

export function normalizeVector(value: unknown, dimensions?: number): number[] {
    if (!Array.isArray(value) || !value.length || value.length > 4096 || dimensions !== undefined && value.length !== dimensions || value.some(row => typeof row !== 'number' || !Number.isFinite(row))) throw new Error('Invalid embedding vector or dimensions.')
    const norm = Math.hypot(...value)
    if (!Number.isFinite(norm) || norm <= 0) throw new Error('Embedding vector must have finite nonzero norm.')
    return value.map(row => row / norm)
}

export function rankSemanticCandidates(candidates: MappingCandidate[], query: number[], vectors: Map<string, number[]>): MappingCandidate[] {
    const normalizedQuery = normalizeVector(query)
    return candidates.map(candidate => {
        const vector = normalizeVector(vectors.get(candidate.attrIdent), query.length)
        return { candidate, score: vector.reduce((sum, value, index) => sum + value * normalizedQuery[index], 0) }
    }).sort((a, b) => b.score - a.score || a.candidate.attrIdent.localeCompare(b.candidate.attrIdent)).map(row => row.candidate)
}

export function rankHybridCandidates(attribute: { name: string; dictionary?: boolean; numeric?: boolean }, candidates: MappingCandidate[], semantic: MappingCandidate[], limit = 30): MappingCandidate[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid shortlist limit.')
    const lexical = rankLexicalCandidates(attribute, candidates)
    const allowed = new Map(candidates.map(row => [row.attrIdent, row]))
    if (allowed.size !== candidates.length || new Set(semantic.map(row => row.attrIdent)).size !== semantic.length || semantic.length !== candidates.length || semantic.some(row => !allowed.has(row.attrIdent))) throw new Error('Semantic ranking must contain exactly the eligible candidate pool.')
    const exact = lexical.filter(row => row.name.toLowerCase() === attribute.name.toLowerCase())
    const scores = new Map<string, number>()
    for (const ranking of [lexical, semantic]) ranking.forEach((row, index) => scores.set(row.attrIdent, (scores.get(row.attrIdent) || 0) + 1 / (60 + index + 1)))
    const exactIds = new Set(exact.map(row => row.attrIdent))
    const fused = candidates.filter(row => !exactIds.has(row.attrIdent)).sort((a, b) => scores.get(b.attrIdent)! - scores.get(a.attrIdent)! || a.attrIdent.localeCompare(b.attrIdent))
    return [...exact, ...fused].slice(0, limit)
}

export function embeddingText(row: any): string {
    // Explicit metadata allowlist. No API headers, values, product data or expressions.
    const description = typeof row.description === 'string' && !/^\s*id:/i.test(row.description) ? row.description.slice(0, 1000) : ''
    return [row.name, row.attrIdent, row.group, row.typeName || row.type, row.dictionary ? 'dictionary' : '', row.numeric ? 'numeric' : '', description]
        .filter(value => value !== undefined && value !== null && value !== '').map(value => String(value).slice(0, 1000)).join('\n')
}

export interface RetrievalEvaluationRow {
    label: { status: string; expectedAttrIdents?: string[] }
    poolComplete: boolean
    candidates: Pick<MappingCandidate, 'attrIdent'>[]
    rankings: Record<'lexical' | 'semantic' | 'hybrid', string[]>
}

export function evaluateRetrieval(rows: RetrievalEvaluationRow[]) {
    const positives = rows.filter(row => row.label.status === 'confirmed' && row.label.expectedAttrIdents?.length)
    const eligible = positives.filter(row => row.poolComplete)
    const incomplete = positives.length - eligible.length
    const pending = rows.filter(row => row.label.status !== 'confirmed').length
    const unmatched = rows.filter(row => row.label.status === 'confirmed' && row.label.expectedAttrIdents?.length === 0).length
    const outsidePool = eligible.filter(row => !row.candidates.some(candidate => row.label.expectedAttrIdents!.includes(candidate.attrIdent))).length
    const metrics = eligible.length && !incomplete ? Object.fromEntries(['lexical', 'semantic', 'hybrid'].map(mode => {
        const positions = eligible.map(row => row.rankings[mode as keyof typeof row.rankings].findIndex(id => row.label.expectedAttrIdents!.includes(id)))
        return [mode, { recallAt30: positions.filter(index => index >= 0 && index < 30).length / eligible.length, mrrAt30: positions.reduce((sum, index) => sum + (index < 0 || index >= 30 ? 0 : 1 / (index + 1)), 0) / eligible.length }]
    })) : null
    return { confirmedPositives: positives.length, pending, confirmedUnmatched: unmatched, completePools: rows.filter(row => row.poolComplete).length,
        incompletePools: rows.filter(row => !row.poolComplete).length, incompletePositivePools: incomplete, expectedOutsidePool: outsidePool, metrics }
}
