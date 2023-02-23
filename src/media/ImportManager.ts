import * as fs from 'fs'
import * as readline from 'readline'
import { Process } from '../models/processes'
import { ImportConfig } from '../models/importConfigs'
import { processImportConfigActions } from '../resolvers/utils'
import { EventType } from '../models/actions'
import { IItemImportRequest, IImportConfig, ImportMode, ErrorProcessing, ImportResponse } from '../models/import'
import { importItem } from '../resolvers/import/items'
import Context from '../context'

export class ImportManager {
    private static instance: ImportManager

    private constructor() {
    }

    public static getInstance(): ImportManager {
        if (!ImportManager.instance) {
            ImportManager.instance = new ImportManager()
        }
        return ImportManager.instance
    }

    public async processImportFile(context: Context, process: Process, importConfig: ImportConfig, filepath: any): Promise<ImportResponse> {

        const result = new ImportResponse('import')
        const rl = readline.createInterface({
            input: fs.createReadStream(filepath),
            crlfDelay: Infinity
        })
        let lineNumber = 0
        let headers = ''

        const importConfigOptions: IImportConfig = {
            mode: ImportMode.CREATE_UPDATE,
            errors: ErrorProcessing.PROCESS_WARN
        }

        for await (const line of rl) {
            if (lineNumber === 0) {
                headers = line
            }
            if (lineNumber > 0) {
                const item = await this.mapLine(headers, importConfig, line)
                process.log += '\n Item: ' +  JSON.stringify(item)
                await processImportConfigActions(context, EventType.BeforeUpdate,  importConfig, item)

                const importRes = await importItem(context, <IImportConfig>importConfigOptions, <IItemImportRequest>item)
                
                await processImportConfigActions(context, EventType.AfterUpdate, importConfig, item)
                process.log += '\n Import result: ' + JSON.stringify(importRes)
                await process.save()
            }
            lineNumber++
        }

        process.active = false
        process.status = 'finished'
        process.finishTime = Date.now()
        process.save()

        return result
    }

    private async mapLine(headers: String, importConfig: ImportConfig, data: String) {
        const result: any = {}
        const headersArr = headers.split(',')
        const dataArr = data.split(',')
        for (let i = 0; i < importConfig.mappings.length; i++) {
            const mapping = importConfig.mappings[i]
            const idx = headersArr.indexOf(mapping.name)
            if (idx !== -1 && mapping.targetName && mapping.targetName.length) {
                result[mapping.targetName] = dataArr[idx]
            }
        }
        return result
    }
  }
