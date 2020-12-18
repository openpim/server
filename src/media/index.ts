import {Request, Response} from 'express'
import Context from '../context'
import { IncomingForm } from 'formidable'
import { Item } from '../models/items'
import { ModelsManager } from '../models/manager'
import { FileManager } from './FileManager'
import { sequelize } from '../models'

import logger from '../logger'

export async function processDownload(context: Context, req: Request, res: Response, thumbnail: boolean) {
    const idStr = req.params.id
    const id = parseInt(idStr)
    if (!id) throw new Error('Wrong "id" parameter')

    const item = await Item.applyScope(context).findByPk(id)
    if (!item) {
        logger.error('Failed to find item by id: ' + id + ', user: ' + context.getCurrentUser()!.login + ", tenant: " + context.getCurrentUser()!.tenantId)
        res.status(400).send('Failed to find image')
        return
    }

    if (!context.canViewItem(item)) {
        logger.error('User :' + context.getCurrentUser()?.login + ' can not view item (asset download) :' + item.id + ', tenant: ' + context.getCurrentUser()!.tenantId)
        res.status(400).send('You do not have permissions to view this item')
        return
    }

    if (!item.storagePath) {
        logger.error('Failed to find image for item by id: ' + id + ', user: ' + context.getCurrentUser()!.login + ", tenant: " + context.getCurrentUser()!.tenantId)
        res.status(400).send('Failed to find image')
        return
    }

    const hdrs:any = {
        'Content-Type': item.mimeType
    }
    if (!thumbnail) {
        hdrs['Content-Disposition'] = 'attachment; filename="' + item.fileOrigName + '"'

    }
    res.sendFile(process.env.FILES_ROOT! + item.storagePath + (thumbnail ? '_thumb.jpg': ''), {headers: hdrs})
}

export async function processUpload(context: Context, req: Request, res: Response) {
    const form = new IncomingForm()
    form.keepExtensions = true
 
    form.parse(req, async (err, fields, files) => {
        try {
            context.checkAuth();

            const file = files['file']
            const idStr =  <string>fields['id']

            if (!idStr) throw new Error('Failed to find "id" parameter')
            if (!file) throw new Error('Failed to find "file" parameter')

            const id = parseInt(idStr)

            const item = await Item.applyScope(context).findByPk(id)
            if (!item) throw new Error('Failed to find item by id: ' + id + ', user: ' + context.getCurrentUser()!.login + ", tenant: " + context.getCurrentUser()!.tenantId)

            if (!context.canEditItem(item)) {
                throw new Error('User :' + context.getCurrentUser()?.login + ' can not edit item (asset upload) :' + item.id + ', tenant: ' + context.getCurrentUser()!.tenantId)
            }
        
            const mng = ModelsManager.getInstance().getModelManager(context.getCurrentUser()!.tenantId)
            const type = mng.getTypeById(item.typeId)?.getValue()
            if (!type!.file) throw new Error('Item with id: ' + id + ' is not a file, user: ' + context.getCurrentUser()!.login + ", tenant: " + context.getCurrentUser()!.tenantId)

            const fm = FileManager.getInstance()
            await fm.saveFile(context.getCurrentUser()!.tenantId, item, file)

            item.fileOrigName = file.name
            item.mimeType = file.type
            item.updatedBy = context.getCurrentUser()!.login
            await sequelize.transaction(async (t) => {
                await item.save({transaction: t})
            })

            res.send('OK')
        } catch (error) {
            logger.error(error)
            res.status(400).send(error.message)
        }
    });
}