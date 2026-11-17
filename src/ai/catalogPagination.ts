// Cursors are opaque MCP capabilities, not values the model may synthesize.
// A guard lives for one answer and can be seeded from owner-scoped real MCP records.
// Prose and arbitrary chat history never issue tokens.
export function catalogArgumentsKey(value: any): string {
    return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
}

export class CatalogPagination {
    private issued = new Map<string, Set<string>>()
    private pages = new Map<string, string | null>()
    private invalidated = new Set<string>()
    constructor(private schemas: Map<string, any>) {}

    private enabled(name: string): boolean {
        const schema = this.schemas.get(name)
        return !!schema?.properties?.cursor && !schema.required?.includes('cursor')
    }
    private scope(name: string, args: any): string {
        const filters: any = { ...args }
        for (const [key, property] of Object.entries(this.schemas.get(name)?.properties || {})) {
            if (!(key in filters) && property && Object.prototype.hasOwnProperty.call(property, 'default')) filters[key] = (property as any).default
        }
        for (const key of ['cursor', 'offset', 'limit']) delete filters[key]
        return name + ':' + catalogArgumentsKey(filters)
    }

    prepare(name: string, args: any): { arguments: any; error?: any } {
        if (!this.enabled(name) || !Object.prototype.hasOwnProperty.call(args, 'cursor')) return { arguments: args }
        const scope = this.scope(name, args)
        const issuedFor = this.issued.get(args.cursor)
        if (typeof args.cursor === 'string' && issuedFor?.has(scope)) {
            const next = { ...args }
            // A genuine cursor is authoritative; never combine it with an offset.
            delete next.offset
            return { arguments: next }
        }
        const next = { ...args }
        delete next.cursor
        if (!this.pages.has(scope) && !issuedFor) {
            // First page of a new search: omit an invented optional cursor, preserving filters.
            return { arguments: next }
        }
        const cursor = this.pages.get(scope)
        if (cursor) { next.cursor = cursor; delete next.offset }
        const canRestart = !this.pages.has(scope) || this.invalidated.has(scope)
        const error = { isError: true, content: [{ type: 'text', text:
            'AI chat rejected a cursor not issued for this tool and these filters. MCP was not called. Use the suggested call only if it matches the intended page; do not fabricate a cursor.' }],
            structuredContent: { error: { code: 'CURSOR_NOT_ISSUED', retryable: false } },
            aiChatRecovery: { ...(cursor || canRestart ? { suggestedCall: { name, arguments: next } } : {}),
                notice: this.invalidated.has(scope) ? 'MCP rejected the earlier cursor. The suggested call restarts the first page, not a continuation.'
                    : this.pages.has(scope) && !cursor ? 'The previous successful page did not provide a next cursor. Pagination is finished; do not restart the first page as if it were the next page.'
                    : cursor ? 'Copy this next cursor exactly.' : 'The filters or tool changed; start a new search without cursor, not a continuation.' } }
        return { arguments: args, error }
    }

    observe(name: string, args: any, result: any): void {
        if (!this.enabled(name)) return
        const scope = this.scope(name, args)
        if (result.isError === true) {
            if (result.structuredContent?.error?.code === 'INVALID_CURSOR' && typeof args.cursor === 'string') {
                this.invalidated.add(scope)
                this.issued.get(args.cursor)?.delete(scope)
                if (this.pages.get(scope) === args.cursor) this.pages.set(scope, null)
            }
            return
        }
        this.invalidated.delete(scope)
        let data = result.structuredContent
        if (!data) {
            for (const item of result.content || []) {
                if (item.type !== 'text') continue
                try { data = JSON.parse(item.text); break } catch { /* Summaries cannot issue a cursor. */ }
            }
        }
        const cursor = data?.pagination?.nextCursor ?? data?.nextCursor
        this.pages.set(scope, typeof cursor === 'string' && cursor.length > 0 ? cursor : null)
        if (typeof cursor === 'string' && cursor.length > 0) {
            const scopes = this.issued.get(cursor) || new Set<string>()
            scopes.add(scope)
            this.issued.set(cursor, scopes)
        }
    }
}
