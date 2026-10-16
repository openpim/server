export function ozonAttributeType(value: unknown): { type: string; isNumber: boolean } {
    const type = ({ STRING: 'TEXT', TEXT: 'TEXT', INTEGER: 'INTEGER', DECIMAL: 'NUMERIC', NUMBER: 'NUMERIC', NUMERIC: 'NUMERIC', BOOLEAN: 'BOOLEAN' } as Record<string, string>)[String(value || '').toUpperCase()] || 'UNKNOWN'
    return { type, isNumber: ['INTEGER', 'NUMERIC'].includes(type) }
}
