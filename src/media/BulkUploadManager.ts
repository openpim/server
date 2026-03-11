import * as fs from 'fs'
import { File } from 'formidable'
import i18next from '../i18n'
import logger from '../logger'
import Context from '../context'
import { Process } from '../models/processes'
import { ImportConfig } from '../models/importConfigs'
import { Item } from '../models/items'
import { ErrorProcessing, IImportConfig, IItemImportRequest, ImportMode, ImportResult } from '../models/import'
import { importItem } from '../resolvers/import/items'
import { ActionUtils, processImportActions } from '../resolvers/utils'
import { EventType } from '../models/actions'
import { clearProcessCache } from '../resolvers/processes'
import { FileManager } from './FileManager'
import { evaluateExpression } from './evaluateExpression'

type BulkFileStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'skipped'

interface BulkRuntimeFileInfo {
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

interface BulkRuntimeStats {
    total: number
    completed: number
    failed: number
    skipped: number
    processing: number
    pending: number
}

interface BulkRuntime {
    type: 'bulk-upload'
    mappingId: number
    files: BulkRuntimeFileInfo[]
    stats: BulkRuntimeStats
}

interface BulkRelationConfig {
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

const DEFAULT_MAX_FILES = 100
const BULK_FILE_PROCESS_STEPS = 8
const DEFAULT_LOG_MODE = 'info'
const PROCESS_JSON_LOG_MAX_LENGTH = 12000
const PROCESS_JSON_INFO_MAX_LENGTH = 2500
export class BulkUploadManager {
    private static instance: BulkUploadManager
    private readonly fileManager: FileManager
    private readonly filesRoot: string

    private constructor() {
        this.fileManager = FileManager.getInstance()
        this.filesRoot = process.env.FILES_ROOT!
    }

    public static getInstance(): BulkUploadManager {
        if (!BulkUploadManager.instance) {
            BulkUploadManager.instance = new BulkUploadManager()
        }
        return BulkUploadManager.instance
    }

    async handleUpload(
        context: Context,
        processId: number | null,
        files: File[],
        importConfig: ImportConfig
    ): Promise<Process> {
        const currentUser = context.getCurrentUser()!
        let proc: Process

        if (processId) {
            const existing = await Process.applyScope(context).findByPk(processId)
            if (!existing) throw new Error('Process not found: ' + processId)
            if (existing.runtime?.type && existing.runtime.type !== 'bulk-upload') {
                throw new Error('Process is not bulk-upload type')
            }
            if (existing.createdBy !== currentUser.login) {
                throw new Error('User ' + currentUser.id + ' does not has permissions to update process: ' + existing.id + ', tenant: ' + currentUser.tenantId)
            }
            if (existing.active) throw new Error('Process is already running')
            proc = existing
        } else {
            const language = this.detectLanguage(importConfig)
            const titleName = importConfig.name?.[language] || importConfig.identifier
            proc = Process.build({
                identifier: 'bulkUploadProcess' + Date.now(),
                tenantId: currentUser.tenantId,
                createdBy: currentUser.login,
                updatedBy: currentUser.login,
                title: `${i18next.t('ImportProcessForMapping', { lng: language })}${titleName}`,
                active: false,
                status: 'uploading',
                log: '',
                runtime: {},
                finishTime: null,
                storagePath: '',
                mimeType: '',
                fileName: ''
            })
            await proc.save()
        }

        const runtime = this.normalizeRuntime(proc.runtime, importConfig.id)
        if (runtime.mappingId !== importConfig.id) {
            throw new Error('Process mapping mismatch. Expected mappingId: ' + importConfig.id + ', got: ' + runtime.mappingId)
        }

        const maxFiles = importConfig.config?.maxFiles || DEFAULT_MAX_FILES
        if (runtime.files.length + files.length > maxFiles) {
            throw new Error('Exceeded max files limit: ' + maxFiles)
        }

        await this.saveRuntimeProcess(
            proc,
            runtime,
            currentUser.login,
            `Uploading: batch of ${files.length} file(s)`,
            `Upload batch received: ${files.length} file(s). Files already queued: ${runtime.files.length}.`
        )

        for (let i = 0; i < files.length; i++) {
            const file = files[i]
            if (!file || !file.filepath) continue

            const idx = runtime.files.length
            const originalName = file.originalFilename || `file_${idx}`
            const mimeType = file.mimetype || ''
            const size = file.size || 0
            const tmpPath = await this.fileManager.saveBulkTempFile(currentUser.tenantId, proc.id, idx, file.filepath)

            runtime.files.push({
                idx,
                originalName,
                mimeType,
                size,
                tmpPath,
                status: 'pending',
                error: null,
                resultItemId: null,
                resultIdentifier: null
            })
            runtime.stats = this.calculateStats(runtime.files)

            const mimeInfo = mimeType ? `, mime=${mimeType}` : ''
            await this.saveRuntimeProcess(
                proc,
                runtime,
                currentUser.login,
                this.buildUploadStatus(runtime.files.length),
                `Upload step ${i + 1}/${files.length}: temp file saved for ${originalName} (${size} bytes${mimeInfo}). Queue size: ${runtime.files.length}.`
            )
        }

        runtime.stats = this.calculateStats(runtime.files)
        await this.saveRuntimeProcess(
            proc,
            runtime,
            currentUser.login,
            `Upload ready: ${runtime.files.length} file(s) pending`,
            `Upload batch completed: ${files.length} file(s) accepted. Total queued files: ${runtime.files.length}.`
        )

        return proc
    }
    async startProcessing(
        context: Context,
        proc: Process,
        importConfig: ImportConfig,
        language: string
    ): Promise<void> {
        const login = context.getCurrentUser()!.login
        const runtime = this.normalizeRuntime(proc.runtime, importConfig.id)

        proc.active = true
        proc.finishTime = null
        await this.saveRuntimeProcess(
            proc,
            runtime,
            login,
            `Starting processing: ${runtime.files.length} file(s)`,
            `${i18next.t('Started', { lng: language })}. Processing start requested for ${runtime.files.length} file(s).`
        )

        this.processFiles(context, proc.id, importConfig.id, language).catch((error) => {
            logger.error('Bulk upload processing failed', error)
        })
    }
    private async processFiles(context: Context, processId: number, importConfigId: number, language: string): Promise<void> {
        const currentUser = context.getCurrentUser()!
        const proc = await Process.applyScope(context).findByPk(processId)
        const importConfig = await ImportConfig.applyScope(context).findByPk(importConfigId)
        if (!proc || !importConfig) {
            logger.error('Bulk processing aborted. Process or import config not found.', processId, importConfigId)
            return
        }

        const runtime = this.normalizeRuntime(proc.runtime, importConfig.id)
        const importConfigOptions: IImportConfig = {
            mode: ImportMode.CREATE_UPDATE,
            errors: ErrorProcessing.PROCESS_WARN
        }
        const totalFiles = runtime.files.length

        try {
            const firstFilePath = runtime.files.length ? this.filesRoot + runtime.files[0].tmpPath : null
            await this.saveRuntimeProcess(
                proc,
                runtime,
                currentUser.login,
                'Processing: before-start actions',
                'Process step: ImportBeforeStart actions started.'
            )
            await processImportActions(context, EventType.ImportBeforeStart, proc, importConfig, firstFilePath)
            await this.saveRuntimeProcess(
                proc,
                runtime,
                currentUser.login,
                `Processing: ${totalFiles} file(s) queued`,
                'Process step: ImportBeforeStart actions completed.'
            )

            const actionUtils = new ActionUtils(context)
            for (let i = 0; i < runtime.files.length; i++) {
                const fileInfo = runtime.files[i]
                if (fileInfo.status !== 'pending') continue

                const fileName = fileInfo.originalName
                let currentStep = 'prepare file'

                fileInfo.status = 'processing'
                fileInfo.error = null
                runtime.stats = this.calculateStats(runtime.files)
                await this.saveRuntimeProcess(
                    proc,
                    runtime,
                    currentUser.login,
                    this.buildFileStatus(i, totalFiles, 'prepare file', fileName),
                    `[${i + 1}/${totalFiles}] ${fileName} - processing started.`
                )

                try {
                    const row = this.buildFileRow(fileInfo)
                    const defaultExpressionData = row.$fileName ?? row.$fileNameFull ?? null

                    currentStep = 'beforeEachRow'
                    if (importConfig.config?.beforeEachRow) {
                        await this.saveRuntimeProcess(
                            proc,
                            runtime,
                            currentUser.login,
                            this.buildFileStatus(i, totalFiles, currentStep, fileName),
                            this.buildFileStepLog(i, totalFiles, fileName, 1, 'beforeEachRow')
                        )
                        const beforeEachResult = await evaluateExpression(row, defaultExpressionData, importConfig.config.beforeEachRow, context)
                        if (beforeEachResult) {
                            fileInfo.status = 'skipped'
                            fileInfo.error = null
                            runtime.stats = this.calculateStats(runtime.files)
                            await this.saveRuntimeProcess(
                                proc,
                                runtime,
                                currentUser.login,
                                this.buildFileStatus(i, totalFiles, 'skipped', fileName),
                                `Bulk file skipped: ${fileName}. Step beforeEachRow returned a skip flag.`
                            )
                            continue
                        }
                    } else {
                        await this.saveRuntimeProcess(
                            proc,
                            runtime,
                            currentUser.login,
                            this.buildFileStatus(i, totalFiles, 'beforeEachRow skipped', fileName),
                            this.buildFileStepLog(i, totalFiles, fileName, 1, 'beforeEachRow skipped (not configured)')
                        )
                    }

                    currentStep = 'map item'
                    await this.saveRuntimeProcess(
                        proc,
                        runtime,
                        currentUser.login,
                        this.buildFileStatus(i, totalFiles, currentStep, fileName),
                        this.buildFileStepLog(i, totalFiles, fileName, 2, 'map item')
                    )
                    const item = await this.mapFile(importConfig.mappings || [], row, context)
                    if (!item.identifier) {
                        item.identifier = this.fileNameToIdentifier(fileInfo.originalName)
                    }
                    await this.saveRuntimeProcess(
                        proc,
                        runtime,
                        currentUser.login,
                        undefined,
                        `Mapped item payload for ${fileName}: identifier=${item.identifier || ''}, type=${item.typeIdentifier || ''}, parent=${item.parentIdentifier || ''}.`
                    )
                    await this.saveRuntimeProcess(
                        proc,
                        runtime,
                        currentUser.login,
                        undefined,
                        this.buildRequestLogEntry(`Item request JSON for ${fileName}`, {
                            config: importConfigOptions,
                            item
                        }, importConfig.config)
                    )

                    currentStep = 'import item'
                    await this.saveRuntimeProcess(
                        proc,
                        runtime,
                        currentUser.login,
                        this.buildFileStatus(i, totalFiles, currentStep, fileName),
                        this.buildFileStepLog(i, totalFiles, fileName, 3, 'import item')
                    )
                    const importResponse = await importItem(context, importConfigOptions, item)
                    if (!importResponse || importResponse.result === ImportResult.REJECTED) {
                        const errors = importResponse?.errors?.map(elem => elem.message).filter(Boolean).join('; ')
                        throw new Error(errors || 'Import item rejected')
                    }
                    await this.saveRuntimeProcess(
                        proc,
                        runtime,
                        currentUser.login,
                        undefined,
                        `Import item completed for ${fileName}: responseId=${importResponse.id || ''}, result=${importResponse.result || 'OK'}.`
                    )

                    currentStep = 'resolve imported item'
                    await this.saveRuntimeProcess(
                        proc,
                        runtime,
                        currentUser.login,
                        this.buildFileStatus(i, totalFiles, currentStep, fileName),
                        this.buildFileStepLog(i, totalFiles, fileName, 4, 'resolve imported item')
                    )
                    const importedItem = await this.findImportedItem(context, importResponse.id, item.identifier)
                    if (!importedItem) throw new Error('Failed to find imported item: ' + item.identifier)
                    await this.saveRuntimeProcess(
                        proc,
                        runtime,
                        currentUser.login,
                        undefined,
                        `Imported item resolved for ${fileName}: id=${importedItem.id}, identifier=${importedItem.identifier}.`
                    )

                    currentStep = 'verify temporary file'
                    await this.saveRuntimeProcess(
                        proc,
                        runtime,
                        currentUser.login,
                        this.buildFileStatus(i, totalFiles, currentStep, fileName),
                        this.buildFileStepLog(i, totalFiles, fileName, 5, 'verify temporary file')
                    )
                    const tmpFullPath = this.filesRoot + fileInfo.tmpPath
                    if (!fs.existsSync(tmpFullPath)) {
                        throw new Error('Failed to find uploaded file in temp storage: ' + fileInfo.tmpPath)
                    }
                    await this.saveRuntimeProcess(
                        proc,
                        runtime,
                        currentUser.login,
                        undefined,
                        `Temporary file verified for ${fileName}: ${fileInfo.tmpPath}.`
                    )

                    currentStep = 'attach file'
                    await this.saveRuntimeProcess(
                        proc,
                        runtime,
                        currentUser.login,
                        this.buildFileStatus(i, totalFiles, currentStep, fileName),
                        this.buildFileStepLog(i, totalFiles, fileName, 6, 'attach file')
                    )
                    await this.fileManager.saveBulkFile(currentUser.tenantId, importedItem, tmpFullPath, fileInfo.mimeType, fileInfo.originalName, fileInfo.size, true)
                    importedItem.fileOrigName = fileInfo.originalName
                    importedItem.mimeType = fileInfo.mimeType
                    importedItem.updatedBy = currentUser.login
                    importedItem.changed('values', true)
                    await importedItem.save()
                    await this.saveRuntimeProcess(
                        proc,
                        runtime,
                        currentUser.login,
                        undefined,
                        `File attached to item ${importedItem.identifier}: ${fileName}.`
                    )

                    currentStep = 'create relations'
                    await this.saveRuntimeProcess(
                        proc,
                        runtime,
                        currentUser.login,
                        this.buildFileStatus(i, totalFiles, currentStep, fileName),
                        this.buildFileStepLog(i, totalFiles, fileName, 7, 'create relations')
                    )
                    const relationCount = await this.createRelationIfNeeded(
                        context,
                        actionUtils,
                        importConfig.config,
                        row,
                        importedItem.identifier,
                        proc,
                        runtime,
                        currentUser.login,
                        fileInfo,
                        i,
                        totalFiles
                    )
                    await this.saveRuntimeProcess(
                        proc,
                        runtime,
                        currentUser.login,
                        undefined,
                        relationCount > 0
                            ? `Relation creation completed for ${fileName}: ${relationCount} relation(s) created.`
                            : `Relation creation completed for ${fileName}: no relations created.`
                    )

                    currentStep = 'afterEachRow'
                    if (importConfig.config?.afterEachRow) {
                        await this.saveRuntimeProcess(
                            proc,
                            runtime,
                            currentUser.login,
                            this.buildFileStatus(i, totalFiles, currentStep, fileName),
                            this.buildFileStepLog(i, totalFiles, fileName, 8, 'afterEachRow')
                        )
                        await evaluateExpression(row, importResponse, importConfig.config.afterEachRow, context)
                        await this.saveRuntimeProcess(
                            proc,
                            runtime,
                            currentUser.login,
                            undefined,
                            `afterEachRow completed for ${fileName}.`
                        )
                    } else {
                        await this.saveRuntimeProcess(
                            proc,
                            runtime,
                            currentUser.login,
                            this.buildFileStatus(i, totalFiles, 'afterEachRow skipped', fileName),
                            this.buildFileStepLog(i, totalFiles, fileName, 8, 'afterEachRow skipped (not configured)')
                        )
                    }

                    fileInfo.status = 'completed'
                    fileInfo.resultItemId = importedItem.id
                    fileInfo.resultIdentifier = importedItem.identifier
                    fileInfo.error = null
                    runtime.stats = this.calculateStats(runtime.files)
                    await this.saveRuntimeProcess(
                        proc,
                        runtime,
                        currentUser.login,
                        this.buildFileStatus(i, totalFiles, 'completed', fileName),
                        `Bulk file processed: ${fileName}. Item identifier: ${importedItem.identifier}.`
                    )
                } catch (error: any) {
                    const errorMessage = error?.message || '' + error
                    fileInfo.status = 'failed'
                    fileInfo.error = `${currentStep}: ${errorMessage}`
                    runtime.stats = this.calculateStats(runtime.files)
                    await this.saveRuntimeProcess(
                        proc,
                        runtime,
                        currentUser.login,
                        this.buildFileStatus(i, totalFiles, 'failed', fileName),
                        `Bulk file failed at step "${currentStep}": ${fileName}. ${errorMessage}`
                    )
                }
            }

            await this.saveRuntimeProcess(
                proc,
                runtime,
                currentUser.login,
                'Processing: after-end actions',
                'Process step: ImportAfterEnd actions started.'
            )
            await processImportActions(context, EventType.ImportAfterEnd, proc, importConfig, null)
            await this.saveRuntimeProcess(
                proc,
                runtime,
                currentUser.login,
                'Processing complete',
                'Process step: ImportAfterEnd actions completed.'
            )
        } catch (error: any) {
            logger.error('Bulk upload fatal error', error)
            await this.saveRuntimeProcess(
                proc,
                runtime,
                currentUser.login,
                'Bulk processing fatal error',
                `${i18next.t('ImportManagerError', { lng: language })} ${error?.message || error}`
            )
        } finally {
            proc.active = false
            proc.finishTime = Date.now()
            runtime.stats = this.calculateStats(runtime.files)
            await this.saveRuntimeProcess(
                proc,
                runtime,
                currentUser.login,
                i18next.t('Finished', { lng: language }),
                `Bulk processing finished. Total=${runtime.stats.total}, completed=${runtime.stats.completed}, failed=${runtime.stats.failed}, skipped=${runtime.stats.skipped}.`
            )
        }
    }
    private getLogMode(config: any): string {
        return config?.logMode === 'debug' ? 'debug' : DEFAULT_LOG_MODE
    }

    private isDebugLogMode(config: any): boolean {
        return this.getLogMode(config) === 'debug'
    }

    private buildRequestLogEntry(title: string, payload: any, config: any): string {
        if (this.isDebugLogMode(config)) {
            return this.buildJsonLogEntry(title, payload, PROCESS_JSON_LOG_MAX_LENGTH, true)
        }
        return this.buildJsonLogEntry(`${title} (compact)`, payload, PROCESS_JSON_INFO_MAX_LENGTH, false)
    }

    private buildJsonLogEntry(title: string, payload: any, maxLength: number = PROCESS_JSON_LOG_MAX_LENGTH, pretty: boolean = true): string {
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

    private async saveRuntimeProcess(
        proc: Process,
        runtime: BulkRuntime,
        login: string,
        status?: string,
        logEntry?: string
    ): Promise<void> {
        if (typeof status !== 'undefined') {
            proc.status = status
        }
        if (logEntry) {
            proc.log = `${proc.log || ''}\n${logEntry}`.trim()
        }
        proc.runtime = runtime
        proc.updatedBy = login
        proc.changed('runtime', true)
        await proc.save()
        clearProcessCache()
    }

    private buildUploadStatus(totalFiles: number): string {
        return `Uploading: ${totalFiles} file(s) queued`
    }

    private buildFileStatus(fileIndex: number, totalFiles: number, stage: string, fileName: string): string {
        return `Processing ${fileIndex + 1}/${totalFiles}: ${stage} ${fileName}`
    }

    private buildFileStepLog(fileIndex: number, totalFiles: number, fileName: string, stepNumber: number, stepName: string): string {
        return `[${fileIndex + 1}/${totalFiles}] ${fileName} - step ${stepNumber}/${BULK_FILE_PROCESS_STEPS}: ${stepName}`
    }
    private async mapFile(mappings: any[], row: Record<string, any>, context: Context): Promise<IItemImportRequest> {
        const result: any = {
            identifier: '',
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

            const data = mapping.column ? this.getExpressionData(mapping.column, row) : null
            if (!mapping.column && !mapping.expression) continue

            const mappedData = (mapping.expression && mapping.expression.length)
                ? await evaluateExpression(null, data, mapping.expression, context)
                : data

            if (mapping.attribute === 'identifier' || mapping.attribute === 'typeIdentifier' || mapping.attribute === 'parentIdentifier') {
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

    private buildFileRow(fileInfo: BulkRuntimeFileInfo): Record<string, any> {
        return {
            $fileName: this.removeExtension(fileInfo.originalName),
            $fileNameFull: fileInfo.originalName,
            $fileExt: this.getExtension(fileInfo.originalName),
            $fileMimeType: fileInfo.mimeType,
            $fileSize: fileInfo.size,
            $fileIndex: fileInfo.idx
        }
    }

    private async createRelationIfNeeded(
        context: Context,
        actionUtils: ActionUtils,
        config: any,
        row: Record<string, any>,
        fileItemIdentifier: string,
        proc: Process,
        runtime: BulkRuntime,
        login: string,
        fileInfo: BulkRuntimeFileInfo,
        fileIndex: number,
        totalFiles: number
    ): Promise<number> {
        const relationConfigs = this.getRelationConfigs(config)
        if (!relationConfigs.length) return 0

        let createdCount = 0
        for (let i = 0; i < relationConfigs.length; i++) {
            const relationConfig = relationConfigs[i]
            const relationData = this.getExpressionData(relationConfig.column, row)

            await this.saveRuntimeProcess(
                proc,
                runtime,
                login,
                undefined,
                this.buildFileStepLog(fileIndex, totalFiles, fileInfo.originalName, 7, `resolve relation ${i + 1}/${relationConfigs.length}`)
            )

            const sourceField = relationConfig.sourceField || relationConfig.targetSource
            const sourceExpression = relationConfig.sourceExpression || relationConfig.targetExpression
            const sourceData = sourceField
                ? this.getExpressionData(sourceField, row)
                : relationData
            const sourceIdentifierRaw = sourceExpression
                ? await evaluateExpression(null, sourceData, sourceExpression, context)
                : sourceData

            if (!sourceIdentifierRaw) {
                await this.saveRuntimeProcess(
                    proc,
                    runtime,
                    login,
                    undefined,
                    `Relation skipped for ${fileInfo.originalName}: source identifier is empty.`
                )
                continue
            }

            const sourceIdentifier = '' + sourceIdentifierRaw

            const targetField = relationConfig.targetField
            const targetExpression = relationConfig.targetIdentifierExpression
            const targetData = targetField
                ? this.getExpressionData(targetField, row)
                : relationData
            const targetIdentifierRaw = targetExpression
                ? await evaluateExpression(null, targetData, targetExpression, context)
                : targetData
            const targetIdentifier = targetIdentifierRaw ? '' + targetIdentifierRaw : fileItemIdentifier

            if (!targetIdentifier) {
                await this.saveRuntimeProcess(
                    proc,
                    runtime,
                    login,
                    undefined,
                    `Relation skipped for ${fileInfo.originalName}: target identifier is empty.`
                )
                continue
            }

            const relationIdentifierExpression = relationConfig.relationIdentifierExpression && ('' + relationConfig.relationIdentifierExpression).trim().length
                ? '' + relationConfig.relationIdentifierExpression
                : ''
            const relationIdentifierRaw = relationIdentifierExpression
                ? await evaluateExpression(null, relationData, relationIdentifierExpression, context)
                : relationConfig.relationIdentifier

            if (!relationIdentifierRaw) {
                await this.saveRuntimeProcess(
                    proc,
                    runtime,
                    login,
                    undefined,
                    `Relation skipped for ${fileInfo.originalName}: relation type is empty.`
                )
                continue
            }

            const relationIdentifier = '' + relationIdentifierRaw

            const identifierExpression = relationConfig.identifierExpression && ('' + relationConfig.identifierExpression).trim().length
                ? '' + relationConfig.identifierExpression
                : ''
            const relationItemIdentifierRaw = identifierExpression
                ? await evaluateExpression(null, relationData, identifierExpression, context)
                : this.buildRelationIdentifier(relationIdentifier, sourceIdentifier, targetIdentifier)

            if (!relationItemIdentifierRaw) {
                await this.saveRuntimeProcess(
                    proc,
                    runtime,
                    login,
                    undefined,
                    `Relation skipped for ${fileInfo.originalName}: relation identifier is empty.`
                )
                continue
            }

            const relIdentifier = '' + relationItemIdentifierRaw
            const relationValues = relationConfig.valuesExpression && ('' + relationConfig.valuesExpression).trim().length
                ? this.normalizeRelationValues(await evaluateExpression(null, relationData, '' + relationConfig.valuesExpression, context))
                : this.normalizeRelationValues(relationConfig.values)
            const relationRequest = {
                relationIdentifier,
                identifier: relIdentifier,
                itemIdentifier: sourceIdentifier,
                targetIdentifier,
                values: relationValues,
                skipActions: false
            }

            await this.saveRuntimeProcess(
                proc,
                runtime,
                login,
                undefined,
                this.buildRequestLogEntry(`ItemRelation request JSON for ${fileInfo.originalName}`, relationRequest, config)
            )

            await actionUtils.createItemRelation(
                relationRequest.relationIdentifier,
                relationRequest.identifier,
                relationRequest.itemIdentifier,
                relationRequest.targetIdentifier,
                relationRequest.values,
                relationRequest.skipActions
            )
            createdCount++

            await this.saveRuntimeProcess(
                proc,
                runtime,
                login,
                undefined,
                `Relation created (${relationIdentifier}) for ${fileInfo.originalName}: ${sourceIdentifier} -> ${targetIdentifier}, identifier=${relIdentifier}.`
            )
        }

        return createdCount
    }

    private getExpressionData(column: string | undefined, row: Record<string, any>): any {
        if (!column) return null
        return typeof row[column] === 'undefined' ? null : row[column]
    }
    private getRelationConfigs(config: any): BulkRelationConfig[] {
        if (!config || typeof config !== 'object') return []

        const rawRelations = Array.isArray(config.relations)
            ? config.relations
            : (config.relation ? [config.relation] : [])

        return rawRelations.filter((relation: any) => {
            return relation && typeof relation === 'object' && (relation.relationIdentifier || relation.relationIdentifierExpression)
        })
    }

    private normalizeRelationValues(values: any): Record<string, any> {
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

    private async findImportedItem(context: Context, id: string, identifier: string): Promise<Item | null> {
        if (id) {
            const nId = parseInt(id)
            if (!isNaN(nId)) {
                const itemById = await Item.applyScope(context).findByPk(nId)
                if (itemById) return itemById
            }
        }
        return await Item.applyScope(context).findOne({ where: { identifier } })
    }

    private normalizeRuntime(rawRuntime: any, mappingId: number): BulkRuntime {
        const runtime = (rawRuntime && typeof rawRuntime === 'object') ? rawRuntime : {}
        const files: BulkRuntimeFileInfo[] = Array.isArray(runtime.files)
            ? runtime.files.map((file: any, idx: number) => ({
                idx: typeof file?.idx === 'number' ? file.idx : idx,
                originalName: file?.originalName || '',
                mimeType: file?.mimeType || '',
                size: file?.size || 0,
                tmpPath: file?.tmpPath || '',
                status: this.normalizeStatus(file?.status),
                error: file?.error || null,
                resultItemId: file?.resultItemId || null,
                resultIdentifier: file?.resultIdentifier || null
            }))
            : []

        return {
            type: 'bulk-upload',
            mappingId: runtime.mappingId || mappingId,
            files,
            stats: this.calculateStats(files)
        }
    }

    private normalizeStatus(status: string): BulkFileStatus {
        if (status === 'processing' || status === 'completed' || status === 'failed' || status === 'skipped') {
            return status
        }
        return 'pending'
    }

    private calculateStats(files: BulkRuntimeFileInfo[]): BulkRuntimeStats {
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

    private detectLanguage(importConfig: ImportConfig): string {
        if (importConfig.name?.en) return 'en'
        const keys = importConfig.name ? Object.keys(importConfig.name) : []
        return keys.length > 0 ? keys[0] : 'en'
    }

    private removeExtension(name: string): string {
        const idx = name.lastIndexOf('.')
        return idx > 0 ? name.substring(0, idx) : name
    }

    private getExtension(name: string): string {
        const idx = name.lastIndexOf('.')
        return idx > 0 ? name.substring(idx + 1).toLowerCase() : ''
    }

    private fileNameToIdentifier(name: string): string {
        return this.removeExtension(name)
            .replace(/[^A-Za-z0-9_]/g, '_')
            .substring(0, 200) + '_' + Date.now()
    }

    private buildRelationIdentifier(relationIdentifier: string, sourceIdentifier: string, targetIdentifier: string): string {
        const source = sourceIdentifier.replace(/[^A-Za-z0-9_-]/g, '_')
        const target = targetIdentifier.replace(/[^A-Za-z0-9_-]/g, '_')
        return `${relationIdentifier}_${source}_${target}_${Date.now()}`
    }
}













