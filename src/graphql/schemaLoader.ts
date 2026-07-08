import fs from 'fs/promises'
import path from 'path'

const IMPORT_RE = /^\s*#\s*import\s+.+?\s+from\s+['"](.+?)['"]\s*$/gm

async function collectTypeDefs(
    entryPath: string,
    visited: Set<string>,
    typeDefs: string[],
) {
    const normalizedPath = path.resolve(entryPath)
    if (visited.has(normalizedPath)) return
    visited.add(normalizedPath)

    const source = await fs.readFile(normalizedPath, 'utf-8')
    const imports = [...source.matchAll(IMPORT_RE)].map((match) => match[1])

    for (const relImportPath of imports) {
        await collectTypeDefs(path.resolve(path.dirname(normalizedPath), relImportPath), visited, typeDefs)
    }

    const cleanedSource = source.replace(IMPORT_RE, '').trim()
    if (cleanedSource) typeDefs.push(cleanedSource)
}

export async function loadSchemaTypeDefs(entryPath: string) {
    const typeDefs: string[] = []
    await collectTypeDefs(entryPath, new Set<string>(), typeDefs)
    return typeDefs
}
