import { Channel } from '../../models/channels'
import { ChannelHandler } from '../ChannelHandler'
import fetch from 'node-fetch'
import NodeCache = require('node-cache');

export class WBChannelHandler extends ChannelHandler {
    private cache = new NodeCache();

    public async processChannel(channel: Channel): Promise<void> {
    }

    public async getCategories(channel: Channel): Promise<{ id: string; name: string; }[]> {
        let data = this.cache.get('categories')
        if (! data) {
            const res = await fetch('https://content-suppliers.wildberries.ru/ns/characteristics-configurator-api/content-configurator/api/v1/config/get/object/all?top=10000&lang=ru')
            const json = await res.json()
            data = Object.values(json.data).map(value => { return {id: ''+value, name: ''+value} } )
            this.cache.set('categories', data, 3600)
        }
        return <{ id: string; name: string; }[]>data
    }
}