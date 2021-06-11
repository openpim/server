import { Channel, ChannelExecution } from "../../models/channels"
import { ChannelAttribute, ChannelCategory, ChannelHandler } from "../ChannelHandler"
import { exec } from "child_process"
import logger from "../../logger"
import { sequelize } from '../../models'
import * as temp from 'temp'
import * as fs from 'fs'
import { FileManager } from "../../media/FileManager"

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
    
    public async processChannel(channel: Channel, language: string): Promise<void> {
        if (channel.config.extCmd) {
            const chanExec = await this.createExecution(channel)
    
            const tempName = temp.path({prefix: 'openpim'});
            const cmd = channel.config.extCmd.replace('{channelIdentifier}', channel.identifier).replace('{outputFile}', tempName).replace('{language}', language)
            logger.info('Starting program :' + cmd + ' channel: ' + channel.identifier + ', tenant: ' + channel.tenantId)
            const result: any = await this.asyncExec(cmd)
            logger.debug('exec finished for channel: ' + channel.identifier + ', tenant: ' + channel.tenantId)
    
            if (fs.existsSync(tempName)) {
                const fm = FileManager.getInstance()
                await fm.saveChannelFile(channel.tenantId, channel.id, chanExec, tempName)
            }
    
            const log = result.stdout + (result.stderr ? "/nERRORS:/n" + result.stderr : "") 
            await this.finishExecution(channel, chanExec, result.code === 0 ? 2 : 3, log)
        } else {
            logger.warn('Command is not defined for channel: ' + channel.identifier + ', tenant: ' + channel.tenantId)
        }    
    }

    public async getCategories(channel: Channel): Promise<ChannelCategory[]> {
        return []
    }

    public async getAttributes(channel: Channel, categoryId: string): Promise<ChannelAttribute[]> {
        return []
    }
}