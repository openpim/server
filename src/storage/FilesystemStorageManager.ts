import * as fs from 'fs'
import { Item } from "../models/items"
import { StorageManager } from "./StorageManager"
import logger from '../logger'


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
        }
        const thumb = fullPath + '_thumb.jpg'
        if (fs.existsSync(thumb)) {
            fs.unlink(thumb, (err) => {
                if (err) logger.error('Error deleting file:' + thumb, err)
            })
        } else {
            logger.error(thumb + ' no such file found for item id: ' + item.id);
        }     
    }

    public async saveFile(item: Item, filepath: string, clean = true ) {
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

    public async getReadStream(item: Item): Promise<fs.ReadStream | null> {
        const filePath = this.filesRoot + item.storagePath
        if (fs.existsSync(filePath)) {
            return fs.createReadStream(filePath)
        }
        return null
    }

}