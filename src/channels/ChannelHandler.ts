import { Channel } from "../models/channels";

export abstract class ChannelHandler {
    abstract processChannel(channel: Channel): Promise<void>

    abstract getCategories(channel: Channel): Promise<{id: string, name:string}[]>
  }