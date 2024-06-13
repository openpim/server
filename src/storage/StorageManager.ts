import { ReadStream } from "fs";
import { Item } from "../models/items";

export abstract class StorageManager {
    abstract removeFile(item: Item): Promise<void>

    abstract saveFile(item: Item, filepath: string, clean: boolean): Promise<void>

    abstract getReadStream(item: Item): Promise<ReadStream | null>
}