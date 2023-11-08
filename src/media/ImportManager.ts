import * as fs from 'fs'
import { Process } from '../models/processes'
import { ImportConfig } from '../models/importConfigs'
import { IItemImportRequest, IImportConfig, ImportMode, ErrorProcessing } from '../models/import'
import { importItem } from '../resolvers/import/items'
import Context from '../context'
import XLSX from 'xlsx'
import { File } from 'formidable'
import logger from "../logger"
import { processImportActions } from '../resolvers/utils'
import { EventType } from '../models/actions'
import i18next from '../i18n'

export class ImportManager {
    private static instance: ImportManager
    private filesRoot: string

    private constructor() {
        this.filesRoot = process.env.FILES_ROOT!
    }

    public static getInstance(): ImportManager {
        if (!ImportManager.instance) {
            ImportManager.instance = new ImportManager()
        }
        return ImportManager.instance
    }

    public async processImportFile(context: Context, process: Process, importConfig: ImportConfig, filepath: any) {
        const result:any = await processImportActions(context, EventType.ImportBeforeStart, process, importConfig, filepath)

        const config = importConfig.config
        const data: any = await this.getImportConfigFileData(result[0].data?.filepath || filepath)

        let { selectedTab, headerLineNumber, dataLineNumber, limit } = config

        // data for selected tab only
        const selectedData = data[selectedTab]
        if (selectedData) {
            headerLineNumber = parseInt(headerLineNumber) - 1
            dataLineNumber = parseInt(dataLineNumber) - 1
            limit = parseInt(limit)

            const headers = selectedData[headerLineNumber]

            const startRowNumber = dataLineNumber
            const endRowNumber = limit ? dataLineNumber + limit : selectedData.length

            const importConfigOptions: IImportConfig = {
                mode: ImportMode.CREATE_UPDATE,
                errors: ErrorProcessing.PROCESS_WARN
            }

            for (let i = startRowNumber; i < endRowNumber; i++) {
                const rowData = selectedData[i] || null
                if (rowData) {
                    const res = (config.beforeEachRow && config.beforeEachRow.length) ? await this.evaluateExpression(rowData, null, config.beforeEachRow) : null
                    if (res && typeof res == 'boolean') {
                        process.log += '\n' + `${i18next.t('ImportManagerValueSkipped')} ${JSON.stringify(rowData)}`
                        continue
                    }
                    if (res) {
                        process.log += '\n' + `${i18next.t('ImportManagerRowSkipped')} ${JSON.stringify(rowData)}`
                        continue
                    }
                    try {
                        const item = await this.mapLine(headers, importConfig, rowData)
                        process.log += '\n' + `${i18next.t('ImportManagerItem')} ` + JSON.stringify(item)
                        if (item.identifier && typeof item.identifier !== 'undefined' && (item.identifier + '').length) {
                            const importRes = await importItem(context, <IImportConfig>importConfigOptions, <IItemImportRequest>item)
                            process.log += '\n' + `${i18next.t('ImportManagerImportResult')} ${JSON.stringify(importRes)}`
                        } else {
                            process.log += '\n' + `${i18next.t('ImportManagerItemIdentifierIsEmpty')}`
                        }
                    } catch (e) {
                        process.log += '\n' + `${i18next.t('ImportManagerErrorUpdatingItem')} ${e}`
                    }
                    await process.save()
                } else {
                    process.log += '\n' + `${i18next.t('ImportManagerThereIsNoDataForLine')} ${i}}`
                    await process.save()
                }
            }
           
            process.log += '\n' + `${i18next.t('ImportManagerFileProcessingFinished')}`
        } else {
            process.log += '\n' + `${i18next.t('ImportManagerUploadedFileHasInvalidFormat')}`
        }

        processImportActions(context, EventType.ImportAfterEnd, process, importConfig, filepath)

        process.active = false
        process.status = i18next.t('Finished')
        process.finishTime = Date.now()
        await process.save()
    }

    private async mapLine(headers: Array<any>, importConfig: ImportConfig, data: Array<any>) {
        const result: any = {
            name: {},
            values: {}
        }
        try {
            for (let i = 0; i < importConfig.mappings.length; i++) {
                const mapping = importConfig.mappings[i]
    
                let idx = -1
                if (importConfig.config.noHeadersChecked && mapping.column) {
                    // calculates an index from string like 'Column 10'
                    idx = parseInt(mapping.column.substring(7))-1
                } else if (mapping.column) {
                    idx = headers.indexOf(mapping.column)
                }
    
                if ((idx !== -1 || (idx === -1 && mapping.expression)) && mapping.attribute && mapping.attribute.length) {
                    const mappedData = (mapping.expression && mapping.expression.length) ? await this.evaluateExpression(data, data[idx], mapping.expression) : data[idx]
                    if ((mapping.attribute !== 'identifier' && mapping.attribute !== 'typeIdentifier' && mapping.attribute !== 'parentIdentifier') && !mapping.attribute.startsWith('$name#')) {
                        result.values[mapping.attribute] = mappedData
                    } else if (mapping.attribute.startsWith('$name#')) {
                        const langIdentifier = mapping.attribute.substring(6)
                        result.name[langIdentifier] = mappedData
                    } else {
                        result[mapping.attribute] = mappedData
                    }
                }
            }
        } catch (e:any) {
            throw new Error(e)
        }
        
        return result
    }

    private async evaluateExpression(row:Array<any>, data: any, expression: string): Promise<any> {
        try {
            const func = new Function('row', 'data', '"use strict"; return (async () => { return (' + expression + ')})()')
            return await func(row, data)
        } catch (err: any) {
            logger.error('Failed to execute expression :[' + expression + '] for data: ' + data + ' with error: ' + err.message)
            throw err
        }
    }

    public async saveImportConfigTemplateFile(tenantId: string, file: File, clean = true) {
        const tst = '/' + tenantId
        if (!fs.existsSync(this.filesRoot + tst)) fs.mkdirSync(this.filesRoot + tst)

        const filesPath = '/' + tenantId + '/importconfigs/'
        if (!fs.existsSync(this.filesRoot + filesPath)) fs.mkdirSync(this.filesRoot + filesPath, { recursive: true })

        const relativePath = filesPath + new Date().getTime()
        const fullPath = this.filesRoot + relativePath

        if (clean) {
            try {
                fs.renameSync(file.filepath, fullPath)
            } catch (e) {
                fs.copyFileSync(file.filepath, fullPath)
                fs.unlinkSync(file.filepath)
            }
        } else {
            fs.copyFileSync(file.filepath, fullPath)
        }

        const info = {
            storagePath: relativePath,
            mimeType: file.mimetype,
            fileName: file.originalFilename
        }

        const data = await this.getImportConfigFileData(fullPath)
        const res = { info, data }

        return res
    }

    public async getImportConfigFileData(filePath: string) {
        return new Promise((resolve, reject) => {
            if (!filePath) reject(new Error('No filepath specified'))
            try {
                const wb = XLSX.readFile(filePath)
                const sheetData: any = {}
                for (let i = 0; i < wb.SheetNames.length; i++) {
                    const ws = wb.Sheets[wb.SheetNames[i]]
                    if (!ws || !ws['!ref']) continue
                    const options = { header: 1 }
                    sheetData[wb.SheetNames[i]] = XLSX.utils.sheet_to_json(ws, options)
                }
                resolve(sheetData)
            } catch (err) {
                reject(err)
            }
        })
    }
}
