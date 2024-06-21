import * as fs from 'fs'
import { Item } from "../models/items"
import { StorageManager } from "./StorageManager"
import logger from '../logger'
import { Readable } from 'stream'


export class FilesystemStorageManager extends StorageManager {
    private filesRoot: string = process.env.FILES_ROOT!

    public async removeFile(item: Item) {
        const folder = ~~(item.id/1000)

        const filesPath = '/' +item.tenantId + '/' + folder
        const relativePath = filesPath + '/' + item.id
        const fullPath = this.filesRoot + relativePath

        if (fs.existsSync(fullPath)) { 
            fs.unlink(fullPath, (err) => {
                if (err) logger.error('Error deleting file:' + fullPath, err)
            })
        } else {
            logger.error(fullPath + ' no such file found for item id: ' + item.id);
            return false
        }
        return true     
    }

    public async saveFile(item: Item, filepath: string, mimetype: string, clean = true ) {
        const folder = ~~(item.id/1000)

        const filesPath = '/' + item.tenantId + '/' + folder

        const relativePath = filesPath + '/' + item.id
        const fullPath = this.filesRoot + relativePath

        if (clean) {
            try {
                fs.renameSync(filepath, fullPath)
            } catch (e) { 
                fs.copyFileSync(filepath, fullPath)
                fs.unlinkSync(filepath)
            }
        } else {
            fs.copyFileSync(filepath, fullPath)
        }
    }    

    public async getReadStream(item: Item): Promise<Readable | null> {
        const filePath = this.filesRoot + item.storagePath
        if (fs.existsSync(filePath)) {
            return fs.createReadStream(filePath)
        }
        return null
    }

}