import { exec } from "child_process";
import logger from "../../logger";
import { Channel, ChannelExecution } from "../../models/channels";
import { sequelize } from '../../models'
import * as temp from 'temp'
import * as fs from 'fs'

function asyncExec (cmd: string) {
    return new Promise(async (resolve) => {
        try {
            exec(cmd, function (error: any, stdout: string, stderr: string) {
                resolve({ code: error ? error.code : 0, stdout:stdout, stderr: stderr } )
            })
        } catch (err) {
            resolve({ code: -1, stdout: '', stderr: err.message } )
        }
    })
}

export async function extChannelProcessor(tenantId: string, channel: Channel): Promise<void> {
    if (channel.config.extCmd) {
        const chanExec = await sequelize.transaction(async (t) => {
            return await ChannelExecution.create({
                tenantId: tenantId,
                channelId: channel.id,
                status: 1,
                startTime: new Date(),
                createdBy: 'system',
                updatedBy: 'system',
            }, { transaction: t })
        })

        const tempName = temp.path({prefix: 'openpim'});
        const cmd = channel.config.extCmd.replace('{channelIdentifier}', channel.identifier).replace('{outputFile}', tempName)
        logger.info('Starting program :' + cmd + ' channel: ' + channel.identifier + ', tenant: ' + tenantId)
        const result: any = await asyncExec(cmd)
        logger.debug('exec finished for channel: ' + channel.identifier + ', tenant: ' + tenantId)

        if (fs.existsSync(tempName)) {
            // TODO save file
        }

        chanExec.status = result.code === 0 ? 2 : 3
        chanExec.finishTime = new Date()
        chanExec.message = result.code === -1 ? result.stderr : ''
        chanExec.log = result.stdout + (result.stderr ? "/nERRORS:/n" + result.stderr : "") 
        await sequelize.transaction(async (t) => {
            await chanExec!.save({transaction: t})
        })

    } else {
        logger.warn('Command is not defined for channel: ' + channel.identifier + ', tenant: ' + tenantId)
    }
}