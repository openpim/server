import logger from "../logger"
import { WhereOptions } from 'sequelize/types'
import { Channel } from "../models/channels"
import { scheduleJob, Range, Job } from 'node-schedule'
import { extChannelProcessor } from "./ext/ExtChannelProcessor"
import { Item } from "../models/items"
import { fn } from 'sequelize'

export class ChannelsManager {
    private tenantId: string
    private jobMap: Record<string, [Job|null, boolean]> = {}

    public constructor(tenantId: string) { this.tenantId = tenantId }
    public getTenantId() { return this.tenantId }

    public addChannel(channel: Channel) {
        this.startChannel(channel)
    }

    public stopChannel(channel: Channel) {
        const tst = this.jobMap[channel.identifier]
        if (tst && tst[0]) tst[0].cancel()
    }

    public async triggerChannel(channel: Channel) {
        logger.info("Channel " + channel.identifier + " was triggered, tenant: " + this.tenantId)

        const jobDetails = this.jobMap[channel.identifier]
        if (jobDetails[1]) {
            logger.warn("Channel " + channel.identifier + " is already running, skip it, tenant: " + this.tenantId)
        }
        jobDetails[1] = true

        try {
            const whereExpression: any = { tenantId: this.tenantId, channels: {} }
            whereExpression.channels[channel.identifier] = { status: 1 }
            const result: any = await Item.findAll({
                attributes: [
                    [fn('count', '*'), 'count']
                ],
                where: whereExpression
            })
            const count = result[0].getDataValue('count')
            if (count > 0) {
                logger.info("Found " + count + " submitted items for channel " + channel.identifier + ", tenant: " + this.tenantId)
                const processor = this.getProcessor(channel)
                processor(this.tenantId, channel)
            } else {
                logger.info("Submitted items are not found for channel " + channel.identifier + ", skiping it, tenant: " + this.tenantId)
            }
        } finally {
            jobDetails[1] = false
        }
    }

    public startChannel(channel: Channel) {
        if (channel.active) {
            this.stopChannel(channel)
            if (!channel.config.start || channel.config.start === 1) {
                this.jobMap[channel.identifier] = [null, false]
            } else if (channel.config.start === 2) { //interval
                if(channel.config.interval) {
                    const range = new Range(0, 60, parseInt(channel.config.interval))
                    const job = scheduleJob({minute: range}, () => {
                        this.triggerChannel(channel)
                    })  
                    this.jobMap[channel.identifier] = [job, false]
                } else {
                    logger.warn('Interval is not set for channel: ' + channel.identifier + ', tenant: ' + this.tenantId)
                }
            } else { // time
                if(channel.config.time) {
                    const arr = channel.config.time.split(':')
                    const job = scheduleJob({hour: parseInt(arr[0]), minute: parseInt(arr[1])}, () => {
                        this.triggerChannel(channel)
                    })  
                    this.jobMap[channel.identifier] = [job, false]
                } else {
                    logger.warn('Time is not set for channel: ' + channel.identifier + ', tenant: ' + this.tenantId)
                }
            }
        }
    }

    private getProcessor(channel: Channel): ChannelProcessor {
        if (channel.type === 1) return extChannelProcessor
        return (tenantId: string, channel: Channel) => { logger.error("Empty processor was started for channel: " + channel.identifier) }
    }
}

export class ChannelsManagerFactory {
    private static instance: ChannelsManagerFactory
    private tenantMap: Record<string, ChannelsManager> = {}
    
    private constructor() { }

    public static getInstance(): ChannelsManagerFactory {
        if (!ChannelsManagerFactory.instance) {
            ChannelsManagerFactory.instance = new ChannelsManagerFactory()
        }

        return ChannelsManagerFactory.instance
    }

    public getChannelsManager(tenant: string): ChannelsManager {
        let tst = this.tenantMap[tenant]
        if (!tst) {
            logger.warn('Can not find channels manager for tenant: ' + tenant);
        }
        return tst
    }

    public async init() {
        let where: WhereOptions | undefined = undefined
        if (process.argv.length > 3) {
            where = {tenantId: process.argv.splice(3)}
        }
        await this.initChannels(where)
    }

    public async initChannels(where: WhereOptions | undefined) {
        const channels = await Channel.findAll({
            where: where,
            order: [['tenantId', 'DESC']]})
        if (!channels) return

        let mng: ChannelsManager | null = null
        for (var i = 0; i < channels.length; i++) {
            const channel = channels[i];
            if (!mng || mng.getTenantId() !== channel.tenantId) {
                mng = new ChannelsManager(channel.tenantId)
                this.tenantMap[channel.tenantId] = mng
            }
            mng.addChannel(channel)
        }
    }
}

export interface ChannelProcessor
{
    (tenantId: string, channel: Channel): void
};
