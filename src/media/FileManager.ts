import * as fs from 'fs'
import { Item } from '../models/items'
import * as Jimp from 'jimp'
import { mergeValues } from '../resolvers/utils'
import { FragmentsOnCompositeTypes } from 'graphql/validation/rules/FragmentsOnCompositeTypes'
import {File} from 'formidable'

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

    public async removeFile(item: Item) {
        const folder = ~~(item.id/1000)

        const filesPath = '/' +folder
        const relativePath = filesPath + '/' + item.id
        const fullPath = this.filesRoot + relativePath

        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath)
        if (fs.existsSync(fullPath + '_thumb.jpg')) fs.unlinkSync(fullPath + '_thumb.jpg')

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

    public async saveFile(tenantId: string, item: Item, file: File) {
        const folder = ~~(item.id/1000)

        const tst = '/' + tenantId
        if (!fs.existsSync(this.filesRoot + tst)) fs.mkdirSync(this.filesRoot + tst)

        const filesPath = '/' + tenantId + '/' + folder
        if (!fs.existsSync(this.filesRoot + filesPath)) fs.mkdirSync(this.filesRoot + filesPath)

        const relativePath = filesPath + '/' + item.id
        const fullPath = this.filesRoot + relativePath
        try {
            fs.renameSync(file.path, fullPath)
        } catch (e) { 
            console.error('Failed to rename file (will use copy instead): ', file.path, fullPath)
            console.error(e)
            fs.copyFileSync(file.path, fullPath)
            fs.unlinkSync(file.path)
        }

        item.storagePath = relativePath

        let values
        if (this.isImage(file.type)) {
            const image = await Jimp.read(fullPath)
            values = {
                image_width: image.bitmap.width,
                image_height: image.bitmap.height,
                image_type: image.getExtension(),
                file_type: image.getMIME(),
                file_name: file.name,
                image_rgba: image._rgba
            }

            const w = image.bitmap.width > image.bitmap.height ? 200 : Jimp.AUTO
            const h = image.bitmap.width > image.bitmap.height ? Jimp.AUTO: 200
            image.resize(w, h).quality(70).background(0xffffffff)
            image.write(fullPath + '_thumb.jpg')    
        } else {
            values = {
                file_name: file.name,
                file_type: file.type
            }
        }
        item.values = mergeValues(values, item.values)
    }

    private isImage(mimeType: string) : boolean {
        return (mimeType === 'image/jpeg') 
            || (mimeType === 'image/png') 
            || (mimeType === 'image/bmp') 
            || (mimeType === 'image/tiff')
            || (mimeType === 'image/gif')
    }
}