import * as fs from 'fs'
import FS from 'fs/promises'
import { Item } from '../models/items'
import { mergeValues } from '../resolvers/utils'
import {File} from 'formidable'
import logger from '../logger'
import { Channel, ChannelExecution } from '../models/channels'
import { Process } from '../models/processes'
import * as hasha from 'hasha'
import sharp from "sharp"

import { StorageFactory } from '../storage/StorageFactory'

export class FileManager {
    private static instance: FileManager
    private filesRoot: string

    private constructor() {
        this.filesRoot = process.env.FILES_ROOT!
    }

    public static getInstance(): FileManager {
        if (!FileManager.instance) {
            FileManager.instance = new FileManager()
        }

        return FileManager.instance
    }

    public getFilesRoot() {
        return this.filesRoot
    }

    public async removeFile(item: Item) {
        StorageFactory.getStorageInstance().removeFile(item)

        const folder = ~~(item.id/1000)
        const filesPath = '/' +item.tenantId + '/' + folder
        const relativePath = filesPath + '/' + item.id
        const fullPath = this.filesRoot + relativePath
        const thumb = fullPath + '_thumb.jpg'
        if (fs.existsSync(thumb)) {
            fs.unlink(thumb, (err) => {
                if (err) logger.error('Error deleting file:' + thumb, err)
            })
        } else {
            logger.error(thumb + ' no such file found for item id: ' + item.id);
        }


        let values
        if (this.isImage(item.mimeType)) {
            values = {
                image_width: '',
                image_height: '',
                image_type: '',
                file_type: '',
                image_rgba: ''
            }
        } else {
            values = {
                file_type: ''
            }
        }
        item.values = mergeValues(values, item.values)        
        item.storagePath = ''
    }

    public async saveChannelFile(tenantId: string, channelId: number, exec: ChannelExecution, file: string) {
        const tst = '/' + tenantId
        if (!fs.existsSync(this.filesRoot + tst)) fs.mkdirSync(this.filesRoot + tst)

        const filesPath = '/' + tenantId + '/channels/' + channelId
        if (!fs.existsSync(this.filesRoot + filesPath)) fs.mkdirSync(this.filesRoot + filesPath, {recursive: true})

        const relativePath = filesPath + '/' + exec.id
        const fullPath = this.filesRoot + relativePath
        try {
            fs.renameSync(file, fullPath)
        } catch (e) { 
            // logger.error('Failed to rename file (will use copy instead): ', file, fullPath)
            // logger.error(e)
            fs.copyFileSync(file, fullPath)
            fs.unlinkSync(file)
        }

        exec.storagePath = relativePath

        return fullPath
    }

	public async saveChannelXlsxTemplate(tenantId: string, channel: Channel, file: File) {
        const tst = '/' + tenantId
        if (!fs.existsSync(this.filesRoot + tst)) {
			fs.mkdirSync(this.filesRoot + tst)
		}

        const filesPath = '/' + tenantId + '/excelTemplateChannel'
        if (!fs.existsSync(this.filesRoot + filesPath)) {
			fs.mkdirSync(this.filesRoot + filesPath, {recursive: true})
		}

		const extNum = file.originalFilename?.lastIndexOf('.')
		const ext = extNum !== -1 ? file.originalFilename?.substring(extNum!) : ''
        const relativePath = filesPath + '/' + channel.identifier + ext
        const fullPath = this.filesRoot + relativePath
        try {
            fs.renameSync(file.filepath, fullPath)
        } catch (e) { 
            // logger.error('Failed to rename file (will use copy instead): ', file, fullPath)
            // logger.error(e)
            fs.copyFileSync(file.filepath, fullPath)
            fs.unlinkSync(file.filepath)
        }

		channel.config.template = fullPath
        channel.config.originalFilename = file.originalFilename
		channel.changed('config', true)

        return fullPath
    }

    public async saveProcessFile(tenantId: string, process: Process, file: string, mimetype: string, filename: string, clean = true) {
        const tst = '/' + tenantId
        if (!fs.existsSync(this.filesRoot + tst)) fs.mkdirSync(this.filesRoot + tst)

        const filesPath = '/' + tenantId + '/processes/'
        if (!fs.existsSync(this.filesRoot + filesPath)) fs.mkdirSync(this.filesRoot + filesPath, {recursive: true})

        const relativePath = filesPath  + process.id
        const fullPath = this.filesRoot + relativePath
        if (clean) {
            try {
                fs.renameSync(file, fullPath)
            } catch (e) { 
                fs.copyFileSync(file, fullPath)
                fs.unlinkSync(file)
            }
        } else {
            fs.copyFileSync(file, fullPath)
        }

        process.storagePath = relativePath
        process.mimeType = mimetype
        process.fileName = filename

        return fullPath
    }

    public async saveFile(tenantId: string, item: Item, filepath: string, mimetype: string | null, originalFilename: string | null, size: number, clean = true ) {
        const folder = ~~(item.id/1000)

        const tst = '/' + tenantId
        if (!fs.existsSync(this.filesRoot + tst)) fs.mkdirSync(this.filesRoot + tst)

        const filesPath = '/' + tenantId + '/' + folder
        if (!fs.existsSync(this.filesRoot + filesPath)) fs.mkdirSync(this.filesRoot + filesPath)

        const relativePath = filesPath + '/' + item.id
        const fullPath = this.filesRoot + relativePath

        let values:any = {}
        if (process.env.OPENPIM_FILE_HASH) {
            values.file_hash = await hasha.fromFile(filepath, {algorithm: process.env.OPENPIM_FILE_HASH})
        }

        item.storagePath = relativePath

        if (this.isImage(mimetype||'')) {
            const image = sharp(filepath)
            const metadata = await image.metadata()
            values.image_width= metadata.width
            values.image_height= metadata.height
            values.image_type=metadata.format
            values.file_type=mimetype
            values.file_name=originalFilename||''
            values.file_size=size
            values.image_rgba=metadata.space

            /*
            let w
            let h
            if (values.image_width > values.image_height) {
                w = 300
                h = Math.round(parseInt(values.image_height) * 300 / parseInt(values.image_width))
            } else {
                w = Math.round(parseInt(values.image_width) * 300 / parseInt(values.image_height))
                h = 300
            }
            if (values.image_width == values.image_height) {
                w = 300
                h = 300
            }*/

            await image.resize(300, 300, {
                fit: sharp.fit.contain,
                background: { r: 255, g: 255, b: 255, alpha: 1 }
            }).flatten({ background: '#fff' }).jpeg({ quality: 70 }).toFile(fullPath + '_thumb.jpg')
            sharp.cache(false)
        } else {
            values.file_name=originalFilename||''
            values.file_type=mimetype||''
            values.file_size=size
        }
        item.values = mergeValues(values, item.values)

        await StorageFactory.getStorageInstance().saveFile(item, filepath, mimetype || 'application/octet-stream', clean)
    }

    private isImage(mimeType: string) : boolean {
        return (mimeType === 'image/jpeg') 
            || (mimeType === 'image/png') 
            || (mimeType === 'image/bmp') 
            || (mimeType === 'image/tiff')
            || (mimeType === 'image/gif')
            || (mimeType === 'image/webp')
    }


    public static async getLastXBytesBuffer(path: string, bytesToRead: number) : Promise<Buffer> {
        const handle = await FS.open(path, 'r');
        const { size } = await handle.stat()
      
        // Calculate the position x bytes from the end
        const position = size > bytesToRead ? size - bytesToRead : 0; 
      
        // Get the resulting buffer
        const bytesRead = size > bytesToRead ? bytesToRead : size
        const { buffer } = await handle.read(Buffer.alloc(bytesRead), 0, bytesRead, position);
      
        await handle.close()
        return buffer
    }
}