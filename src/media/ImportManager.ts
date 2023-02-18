import * as fs from 'fs'
import * as readline from 'readline'
import {File} from 'formidable'
import logger from '../logger'
import { Process } from '../models/processes'
import { ImportConfig } from '../models/importConfigs'

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

    public async processFile(proc: Process, importConfig: ImportConfig, filepath: any) {
        const rl = readline.createInterface({
            input: fs.createReadStream(filepath),
            crlfDelay: Infinity
        })

        let lineNumber = 0
        let headers = ''
        for await (const line of rl) {
            if (lineNumber === 0) {
                headers = line
            }
            if (lineNumber > 0) {
                const res = await this.mapLine(headers, importConfig, line)
                console.log(res)
            }
            lineNumber++
        }
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
