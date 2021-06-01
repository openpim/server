import { Channel, ChannelExecution } from "../../models/channels";
import { ChannelHandler } from "../ChannelHandler";
import { exec } from "child_process";
import logger from "../../logger";
import { sequelize } from '../../models'
import * as temp from 'temp'
import * as fs from 'fs'
import { FileManager } from "../../media/FileManager";

export class ExtChannelHandler extends ChannelHandler {
    private asyncExec (cmd: string) {
        return new Promise(async (resolve) => {
            try {
                exec(cmd, function (error: any, stdout: string, stderr: string) {
                    resolve({ code: error ? error.code : 0, stdout:stdout, stderr: stderr } )
                })
            } catch (err) {
                logger.error('External channel error: ', err)
                resolve({ code: -1, stdout: '', stderr: err.message } )
            }
        })
    }
    
    public async processChannel(channel: Channel): Promise<void> {
        if (channel.config.extCmd) {
            const startTime = new Date()
            channel.runtime.lastStart = startTime
    
            const chanExec = await sequelize.transaction(async (t) => {
                await channel.save({transaction: t})
                return await ChannelExecution.create({
                    tenantId: channel.tenantId,
                    channelId: channel.id,
                    status: 1,
                    startTime: new Date(),
                    finishTime: null,
                    storagePath: '',
                    log: '',
                    createdBy: 'system',
                    updatedBy: 'system',
                }, { transaction: t })
            })
    
            const tempName = temp.path({prefix: 'openpim'});
            const cmd = channel.config.extCmd.replace('{channelIdentifier}', channel.identifier).replace('{outputFile}', tempName)
            logger.info('Starting program :' + cmd + ' channel: ' + channel.identifier + ', tenant: ' + channel.tenantId)
            const result: any = await this.asyncExec(cmd)
            logger.debug('exec finished for channel: ' + channel.identifier + ', tenant: ' + channel.tenantId)
    
            if (fs.existsSync(tempName)) {
                const fm = FileManager.getInstance()
                await fm.saveChannelFile(channel.tenantId, channel.id, chanExec, tempName)
            }
    
            chanExec.status = result.code === 0 ? 2 : 3
            chanExec.finishTime = new Date()
            chanExec.log = result.stdout + (result.stderr ? "/nERRORS:/n" + result.stderr : "") 
    
            channel.runtime.duration = chanExec.finishTime.getTime() - chanExec.startTime.getTime()
            await sequelize.transaction(async (t) => {
                await channel.save({transaction: t})
                await chanExec!.save({transaction: t})
            })
    
        } else {
            logger.warn('Command is not defined for channel: ' + channel.identifier + ', tenant: ' + channel.tenantId)
        }    
    }

    public async getCategories(channel: Channel): Promise<{ id: string; name: string; }[]> {
        return []
    }
}