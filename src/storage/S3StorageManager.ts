import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, GetObjectCommandOutput } from "@aws-sdk/client-s3"
import { StorageManager } from "./StorageManager"
import { Item } from "../models/items"
import { ModelManager } from '../models/manager'
import { ReadStream, createReadStream } from "fs"
import dotenv from 'dotenv'
import { Readable } from "stream"
dotenv.config()


class S3StorageManager extends StorageManager {
    private s3Client: S3Client
    private bucketName: string

    constructor() {
        super()
        const serverConfig = ModelManager.getServerConfig()
        this.s3Client = new S3Client({
            region: serverConfig.storage.access.AWS_REGION,
            endpoint: serverConfig.storage.access.AWS_ENDPOINT,
            credentials: {
                accessKeyId: serverConfig.storage.access.AWS_ACCESS_KEY_ID!,
                secretAccessKey: serverConfig.storage.access.AWS_SECRET_ACCESS_KEY!
            },
            requestHandler: {
                httpsAgent: { maxSockets: Infinity }
            }
    })
        this.bucketName = serverConfig.storage.access.AWS_BUCKET_NAME!
    }

    public async removeFile(item: Item): Promise<boolean> {
        const params = {
            Bucket: this.bucketName,
            Key: item.id.toString()
        }

        try {
            await this.s3Client.send(new DeleteObjectCommand(params))
            return true
        } catch (err) {
            console.error(`Error deleting file from S3: ${err}`)
            return false
        }
    }

    public async saveFile(item: Item, filepath: string, mimetype: string, clean: boolean): Promise<void> {
        const params = {
            Bucket: this.bucketName,
            Key: item.id.toString(),
            Body: createReadStream(filepath),
            ContentType: mimetype
        }

        try {
            await this.s3Client.send(new PutObjectCommand(params))
        } catch (err) {
            console.error(`Error uploading file to S3: ${err}`)
        }
    }

    public async getReadStream(item: Item): Promise<Readable | null> {
        const params = {
            Bucket: this.bucketName,
            Key: item.id.toString()
        }

        try {
            const { Body } = await this.s3Client.send(new GetObjectCommand(params)) as GetObjectCommandOutput & { Body: Readable }
            if (!Body) {
                throw new Error('Failed to retrieve file body from S3')
            }

            return Body
        } catch (err) {
            console.error(`Error getting file from S3: ${err}`)
            return null
        }
    }
}

export { S3StorageManager }
