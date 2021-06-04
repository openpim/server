import { Channel } from "../models/channels";

export abstract class ChannelHandler {
    abstract processChannel(channel: Channel): Promise<void>

    abstract getCategories(channel: Channel): Promise<ChannelCategory[]>

    abstract getAttributes(channel: Channel, categoryId: string): Promise<{ id: string; name: string; required: boolean; dictionary: boolean, dictionaryLink?: string}[]>
  }

export interface ChannelCategory {
  id: string
  name: string
}

export interface ChannelAttribute {
  id: string
  name: string
  required: boolean
  dictionary: boolean
  dictionaryLink?: string
}