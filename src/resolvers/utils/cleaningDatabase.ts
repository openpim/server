import { sequelize } from "../../models"
import { scheduleJob, Range, Job } from 'node-schedule'
import logger from "../../logger"
import { FileManager } from "../../media/FileManager"
import * as fs from 'fs'

export class cleaningDatabase {
    static async Job(user: any): Promise<any> {
        const openpimDir : any = FileManager.getInstance().getFilesRoot()

        logger.info(JSON.stringify(openpimDir))

        const daysToSaveDeleted = user.props.daysToSaveDeleted

        if (daysToSaveDeleted.length <= 2) throw new Error('You must provide number of days to save the data')
        const daysToSave : any = daysToSaveDeleted.length > 2 ? parseInt(daysToSaveDeleted[2]) : null

        scheduleJob(user.props.cron, async () => {
            logger.info('Starting at ' + new Date())
        
            const queryAdd = daysToSave ? ` and "deletedAt" < (now() - interval '`+daysToSave+` day')` : ''
            const queryAdd2 = daysToSave ? ` and "updatedAt" < (now() - interval '`+daysToSave+` day')` : ''

            // attributes
            const attributes : any = await sequelize.query(`delete from "attributes" where "deletedAt" is not null`+queryAdd)
            logger.info(attributes[1].rowCount + ' attributes were deleted')

            // item relations
            const itemRelations : any = await sequelize.query(`delete from "itemRelations" where "deletedAt" is not null`+queryAdd)
            logger.info(itemRelations[1].rowCount + ' item relations were deleted')

            // items without files
            const items1 : any = await sequelize.query(`delete from "items" where "deletedAt" is not null and ("storagePath" is null or trim("storagePath") = '')`+queryAdd)
            logger.info(items1[1].rowCount + ' items without files were deleted')

            // items with files
            const items2 : any = await sequelize.query(`select id, "storagePath" from "items" where "deletedAt" is not null and "storagePath" is not null`+queryAdd)
            logger.info('Found '+items2[1].rows.length+' items with files to delete')
            const ids : any = []
            for (let i = 0; i < items2[1].rows.length; i++) {
                const item : any = items2[1].rows[i]
                if (item.storagePath === '') continue
                const file : any = openpimDir + item.storagePath

                if (fs.existsSync(file+'_thumb.jpg')) fs.unlinkSync(file+'_thumb.jpg')
                if (fs.existsSync(file)) fs.unlinkSync(file)
                ids.push(item.id)
            }

            for (let i in ids) {
                const items3 : any = await sequelize.query(`delete from "items" where id = ` + ids[i])
                logger.info(items3[1].rowCount + ' items with files were deleted')
            }

            // channel executions without files
            const exec1 : any = await sequelize.query(`delete from "channels_exec" where ("storagePath" is null or trim("storagePath") = '')`+queryAdd2)
            logger.info(exec1[1].rowCount + ' channel executions without files were deleted')

            // channel executions with files
            const exec2 : any = await sequelize.query(`select id, "storagePath" from "channels_exec" where "storagePath" is not null`+queryAdd2)
            logger.info('Found ' + exec2[1].rows.length+' channel executions with files to delete')
            const execIds : any = []
            for (let i = 0; i < exec2[1].rows.length; i++) {
                const item = exec2[1].rows[i]
                if (item.storagePath === '') continue
                const file = openpimDir + item.storagePath
                if (fs.existsSync(file)) fs.unlinkSync(file)
                execIds.push(item.id)
            }

            for (let i in execIds) {
                const exec3 : any = await sequelize.query(`delete from "channels_exec" where id = ` + execIds[i])
                logger.info(exec3[1].rowCount + ' channel executions with files were deleted')
            }

            // processes without files
            const proc1 : any = await sequelize.query(`delete from "processes" where ("storagePath" is null or trim("storagePath") = '')`+queryAdd2)
            logger.info(proc1[1].rowCount + ' processes without files were deleted')

            // processes with files
            const proc2 : any = await sequelize.query(`select id, "storagePath" from "processes" where "storagePath" is not null`+queryAdd2)
            logger.info('Found '+ proc2[1].rows.length+' processes with files to delete')
            const procIds = []
            for (let i = 0; i < proc2[1].rows.length; i++) {
                const item = proc2.rows[i]
                if (item.storagePath === '') continue
                const file = openpimDir + item.storagePath
                if (fs.existsSync(file)) fs.unlinkSync(file)
                procIds.push(item.id)
            }

            for (let i in procIds) {
                const proc3 : any = await sequelize.query(`delete from "processes" where id = ` + procIds[i])
                logger.info(proc3[1].rowCount + ' processes with files were deleted')
            }

        })
    }
}