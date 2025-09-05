import { FilesystemStorageManager } from "./FilesystemStorageManager"
import { S3StorageManager } from "./S3StorageManager"
import { StorageManager } from "./StorageManager"
import { ModelManager } from '../models/manager'
import * as dotenv from 'dotenv'
import logger from '../logger'

dotenv.config()

export class StorageFactory {
    private static instance: StorageManager
    public static getStorageInstance(): StorageManager {
        if (!StorageFactory.instance) {
            const serverConfig = ModelManager.getServerConfig()
            if (serverConfig?.storage?.type === 's3') {
                logger.info(`Using S3 storage`)
                StorageFactory.instance = new S3StorageManager()
            } else {
                logger.info(`Using File storage`)
                StorageFactory.instance = new FilesystemStorageManager()
            }
        }

        return StorageFactory.instance
    }
}
