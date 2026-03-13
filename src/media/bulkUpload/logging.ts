export const BULK_FILE_PROCESS_STEPS = 8
export const DEFAULT_BULK_LOG_MODE = 'info'
export const PROCESS_JSON_LOG_MAX_LENGTH = 12000
export const PROCESS_JSON_INFO_MAX_LENGTH = 2500

export function getBulkLogMode(config: any): string {
    return config?.logMode === 'debug' ? 'debug' : DEFAULT_BULK_LOG_MODE
}

export function isBulkDebugLogMode(config: any): boolean {
    return getBulkLogMode(config) === 'debug'
}

export function buildBulkJsonLogEntry(
    title: string,
    payload: any,
    maxLength: number = PROCESS_JSON_LOG_MAX_LENGTH,
    pretty: boolean = true
): string {
    let json = 'null'
    try {
        json = JSON.stringify(payload ?? null, null, pretty ? 2 : 0) || 'null'
    } catch (error: any) {
        json = JSON.stringify({ error: 'Failed to stringify payload', message: error?.message || '' + error }, null, pretty ? 2 : 0)
    }

    if (json.length > maxLength) {
        const remainder = json.length - maxLength
        json = json.substring(0, maxLength) + `
... [truncated ${remainder} chars]`
    }

    return `${title}:
${json}`
}

export function buildBulkRequestLogEntry(title: string, payload: any, config: any): string {
    if (isBulkDebugLogMode(config)) {
        return buildBulkJsonLogEntry(title, payload, PROCESS_JSON_LOG_MAX_LENGTH, true)
    }

    return buildBulkJsonLogEntry(`${title} (compact)`, payload, PROCESS_JSON_INFO_MAX_LENGTH, false)
}

export function buildBulkUploadStatus(totalFiles: number): string {
    return `Uploading: ${totalFiles} file(s) queued`
}

export function buildBulkFileStatus(fileIndex: number, totalFiles: number, stage: string, fileName: string): string {
    return `Processing ${fileIndex + 1}/${totalFiles}: ${stage} ${fileName}`
}

export function buildBulkFileStepLog(fileIndex: number, totalFiles: number, fileName: string, stepNumber: number, stepName: string): string {
    return `[${fileIndex + 1}/${totalFiles}] ${fileName} - step ${stepNumber}/${BULK_FILE_PROCESS_STEPS}: ${stepName}`
}
