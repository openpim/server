import * as fs from 'fs'
import { File } from 'formidable'
import i18next from '../../i18n'
import logger from '../../logger'
import Context from '../../context'
import { Process } from '../../models/processes'
import { ImportConfig } from '../../models/importConfigs'
import { Item } from '../../models/items'
import { ErrorProcessing, IImportConfig, ImportMode, ImportResult } from '../../models/import'
import { importItem } from '../../resolvers/import/items'
import { processImportActions } from '../../resolvers/utils'
import { EventType } from '../../models/actions'
import { clearProcessCache } from '../../resolvers/processes'
import { FileManager } from '../FileManager'
import { evaluateExpression } from '../evaluateExpression'
import {
    buildBulkFileRow,
    mapBulkFile
} from './expressions'
import {
    buildBulkFileStatus,
    buildBulkFileStepLog,
    buildBulkRequestLogEntry,
    buildBulkUploadStatus
} from './logging'
import {
    BulkRuntime,
    BulkRuntimeFileInfo,
    calculateBulkRuntimeStats,
    normalizeBulkRuntime
} from './runtime'
import {
    getBulkRelationConfigs,
    resolveBulkRelationRequest,
    upsertBulkRelationForImport
} from './itemRelations'

const DEFAULT_MAX_FILES = 100

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
    private buildRequestLogEntry(title: string, payload: any, config: any): string {
        return buildBulkRequestLogEntry(title, payload, config)
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
        return buildBulkUploadStatus(totalFiles)
    }

    private buildFileStatus(fileIndex: number, totalFiles: number, stage: string, fileName: string): string {
        return buildBulkFileStatus(fileIndex, totalFiles, stage, fileName)
    }

    private buildFileStepLog(fileIndex: number, totalFiles: number, fileName: string, stepNumber: number, stepName: string): string {
        return buildBulkFileStepLog(fileIndex, totalFiles, fileName, stepNumber, stepName)
    }
    private async mapFile(mappings: any[], row: Record<string, any>, context: Context) {
        return await mapBulkFile(mappings, row, context)
    }

    private buildFileRow(fileInfo: BulkRuntimeFileInfo): Record<string, any> {
        return buildBulkFileRow(fileInfo)
    }

    private async createRelationIfNeeded(
        context: Context,
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
        const relationConfigs = getBulkRelationConfigs(config)
        if (!relationConfigs.length) return 0

        let createdCount = 0
        for (let i = 0; i < relationConfigs.length; i++) {
            const relationConfig = relationConfigs[i]
            await this.saveRuntimeProcess(
                proc,
                runtime,
                login,
                undefined,
                this.buildFileStepLog(fileIndex, totalFiles, fileInfo.originalName, 7, `resolve relation ${i + 1}/${relationConfigs.length}`)
            )

            const resolvedRelation = await resolveBulkRelationRequest(
                relationConfig,
                row,
                fileItemIdentifier,
                context,
                this.buildRelationIdentifier.bind(this)
            )

            if ('skipReason' in resolvedRelation) {
                await this.saveRuntimeProcess(
                    proc,
                    runtime,
                    login,
                    undefined,
                    `Relation skipped for ${fileInfo.originalName}: ${resolvedRelation.skipReason}`
                )
                continue
            }

            await this.saveRuntimeProcess(
                proc,
                runtime,
                login,
                undefined,
                this.buildRequestLogEntry(`ItemRelation request JSON for ${fileInfo.originalName}`, resolvedRelation.relationRequest, config)
            )

            const relationUpsert = await upsertBulkRelationForImport(context, resolvedRelation.relationRequest)
            createdCount++

            await this.saveRuntimeProcess(
                proc,
                runtime,
                login,
                undefined,
                `Relation ${relationUpsert.importResponse.result || 'processed'} (${resolvedRelation.relationIdentifier}) for ${fileInfo.originalName}: ${resolvedRelation.sourceIdentifier} -> ${resolvedRelation.targetIdentifier}, identifier=${relationUpsert.requestForImport.identifier}.`
            )
        }

        return createdCount
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
        return normalizeBulkRuntime(rawRuntime, mappingId)
    }

    private calculateStats(files: BulkRuntimeFileInfo[]) {
        return calculateBulkRuntimeStats(files)
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
