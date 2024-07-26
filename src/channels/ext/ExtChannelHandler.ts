import { Channel, ChannelExecution } from "../../models/channels"
import { ChannelAttribute, ChannelCategory, ChannelHandler } from "../ChannelHandler"
import logger from "../../logger"
import * as temp from 'temp'
import * as fs from 'fs'
import { FileManager } from "../../media/FileManager"
import Context from "../../context"

export class ExtChannelHandler extends ChannelHandler {
    public async processChannel(channel: Channel, language: string, data: any, context?: Context): Promise<void> {
        if (channel.config.extCmd) {
            const chanExec = await this.createExecution(channel)
            const tempName = temp.path({ prefix: 'openpim' })
            const cmd = channel.config.extCmd.replaceAll('{channelIdentifier}', channel.identifier).replaceAll('{outputFile}', tempName).replaceAll('{language}', language).replaceAll('{user}', JSON.stringify(context?.getUserLogin()) || '').replaceAll('{roles}', JSON.stringify(context?.getUserRoles().join(',')) || '')
            logger.info('Starting program :' + cmd + ' channel: ' + channel.identifier + ', tenant: ' + channel.tenantId)
            const result: any = await this.asyncExec(cmd)
            logger.debug('exec finished for channel: ' + channel.identifier + ', tenant: ' + channel.tenantId)
    
            if (fs.existsSync(tempName)) {
                const fm = FileManager.getInstance()
                await fm.saveChannelFile(channel.tenantId, channel.id, chanExec, tempName)
            }
    
            const log = result.stdout + (result.stderr ? "\nERRORS:\n" + result.stderr : "") 
            await this.finishExecution(channel, chanExec, result.code === 0 ? 2 : 3, log)
        } else {
            throw new Error('Command is not defined for channel: ' + channel.identifier + ', tenant: ' + channel.tenantId)
        }
    }

    public async getCategories(channel: Channel): Promise<{list: ChannelCategory[]|null, tree: ChannelCategory|null}> {
        return { list: [], tree: null }
    }

    public async getAttributes(channel: Channel, categoryId: string): Promise<ChannelAttribute[]> {
        return []
    }
}