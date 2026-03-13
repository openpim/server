export type BulkFileStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'skipped'

export interface BulkRuntimeFileInfo {
    idx: number
    originalName: string
    mimeType: string
    size: number
    tmpPath: string
    status: BulkFileStatus
    error: string | null
    resultItemId: number | null
    resultIdentifier: string | null
}

export interface BulkRuntimeStats {
    total: number
    completed: number
    failed: number
    skipped: number
    processing: number
    pending: number
}

export interface BulkRuntime {
    type: 'bulk-upload'
    mappingId: number
    files: BulkRuntimeFileInfo[]
    stats: BulkRuntimeStats
}

export function normalizeBulkStatus(status: string): BulkFileStatus {
    if (status === 'processing' || status === 'completed' || status === 'failed' || status === 'skipped') {
        return status
    }

    return 'pending'
}

export function calculateBulkRuntimeStats(files: BulkRuntimeFileInfo[]): BulkRuntimeStats {
    const stats: BulkRuntimeStats = {
        total: files.length,
        completed: 0,
        failed: 0,
        skipped: 0,
        processing: 0,
        pending: 0
    }

    for (let i = 0; i < files.length; i++) {
        const status = files[i].status
        if (status === 'completed') stats.completed++
        if (status === 'failed') stats.failed++
        if (status === 'skipped') stats.skipped++
        if (status === 'processing') stats.processing++
        if (status === 'pending') stats.pending++
    }

    return stats
}

export function normalizeBulkRuntime(rawRuntime: any, mappingId: number): BulkRuntime {
    const runtime = (rawRuntime && typeof rawRuntime === 'object') ? rawRuntime : {}
    const files: BulkRuntimeFileInfo[] = Array.isArray(runtime.files)
        ? runtime.files.map((file: any, idx: number) => ({
            idx: typeof file?.idx === 'number' ? file.idx : idx,
            originalName: file?.originalName || '',
            mimeType: file?.mimeType || '',
            size: file?.size || 0,
            tmpPath: file?.tmpPath || '',
            status: normalizeBulkStatus(file?.status),
            error: file?.error || null,
            resultItemId: file?.resultItemId || null,
            resultIdentifier: file?.resultIdentifier || null
        }))
        : []

    return {
        type: 'bulk-upload',
        mappingId: runtime.mappingId || mappingId,
        files,
        stats: calculateBulkRuntimeStats(files)
    }
}
