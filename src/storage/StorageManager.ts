import { Item } from "../models/items";
import { Readable } from "stream"

export abstract class StorageManager {
    abstract removeFile(item: Item): Promise<boolean>

    abstract saveFile(item: Item, filepath: string, mimetype: string, clean: boolean): Promise<void>

    abstract getReadStream(item: Item): Promise<Readable | null>
}