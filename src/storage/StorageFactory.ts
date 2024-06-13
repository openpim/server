import { FilesystemStorageManager } from "./FilesystemStorageManager";
import { StorageManager } from "./StorageManager";

export class StorageFactory {
    public static getStorageInstance(): StorageManager {
        return new FilesystemStorageManager()
    }    
}
