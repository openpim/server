import { FilesystemStorageManager } from "./FilesystemStorageManager";
import { StorageManager } from "./StorageManager";

export class StorageFactory {
    private static instance: StorageManager
    public static getStorageInstance(): StorageManager {
        if (!StorageFactory.instance) {
            StorageFactory.instance = new FilesystemStorageManager()
        }

        return StorageFactory.instance
    }    
}
