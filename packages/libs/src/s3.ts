import { Readable } from "stream";
import { S3Client, PutObjectCommand, GetObjectCommand, PutObjectCommandOutput } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { log } from "./log.js";

export interface IStorage {
    upload(key: string, body: Readable | Buffer | string): Promise<PutObjectCommandOutput | void>;
    getTemporaryUrl(key: string, expiresIn?: number): Promise<string>;
    uploadImage(key: string, imageData: Buffer | Readable, contentType?: string): Promise<PutObjectCommandOutput | void>;
    // New methods for cache support
    get(key: string): Promise<Buffer | null>;
    uploadJson(key: string, data: object): Promise<PutObjectCommandOutput | void>;
}

// Storage configuration
export interface StorageConfig {
    bucket: string;
    cachePrefix: string;
}

export function getStorageConfig(): StorageConfig {
    const baseBucket = process.env.ANYCRAWL_S3_BUCKET || '';
    return {
        bucket: process.env.ANYCRAWL_S3_CACHE_BUCKET || baseBucket,
        cachePrefix: process.env.ANYCRAWL_S3_CACHE_PREFIX || 'cache/',
    };
}

class S3Storage implements IStorage {
    private client: S3Client;
    private bucket: string;

    constructor(bucketOverride?: string) {
        if (!process.env.ANYCRAWL_S3_ENDPOINT) {
            throw new Error("ANYCRAWL_S3_ENDPOINT is required");
        }
        if (!process.env.ANYCRAWL_S3_ACCESS_KEY || !process.env.ANYCRAWL_S3_SECRET_ACCESS_KEY) {
            throw new Error("ANYCRAWL_S3_ACCESS_KEY is required");
        }
        const resolvedBucket = bucketOverride || process.env.ANYCRAWL_S3_BUCKET;
        if (!resolvedBucket) {
            throw new Error("ANYCRAWL_S3_BUCKET (or bucket override) is required");
        }

        this.client = new S3Client({
            region: process.env.ANYCRAWL_S3_REGION,
            endpoint: process.env.ANYCRAWL_S3_ENDPOINT,
            credentials: {
                accessKeyId: process.env.ANYCRAWL_S3_ACCESS_KEY,
                secretAccessKey: process.env.ANYCRAWL_S3_SECRET_ACCESS_KEY,
            },
        });
        this.bucket = resolvedBucket;
    }

    async upload(key: string, body: Readable | Buffer | string) {
        const command = new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: body,
        });
        log.info(`Uploading to S3: ${key}`);
        const result = await this.client.send(command);
        log.info(`Uploaded to S3: ${key} result: ${JSON.stringify(result)}`);
        return result;
    }

    async getTemporaryUrl(key: string, expiresIn: number = 3600): Promise<string> {
        const command = new GetObjectCommand({
            Bucket: this.bucket,
            Key: key,
        });

        return getSignedUrl(this.client, command, { expiresIn });
    }

    async uploadImage(key: string, imageData: Buffer | Readable, contentType: string = 'image/jpeg') {
        const command = new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: imageData,
            ContentType: contentType,
        });

        log.info(`Uploading image to S3: ${key}`);
        const result = await this.client.send(command);
        log.info(`Uploaded image to S3: ${key}`);
        return result;
    }

    async get(key: string): Promise<Buffer | null> {
        try {
            const command = new GetObjectCommand({
                Bucket: this.bucket,
                Key: key,
            });
            const response = await this.client.send(command);
            if (response.Body) {
                const chunks: Uint8Array[] = [];
                for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
                    chunks.push(chunk);
                }
                return Buffer.concat(chunks);
            }
            return null;
        } catch (error: any) {
            if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
                return null;
            }
            throw error;
        }
    }

    async uploadJson(key: string, data: object): Promise<PutObjectCommandOutput | void> {
        const command = new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: JSON.stringify(data),
            ContentType: 'application/json',
        });
        log.info(`Uploading JSON to S3: ${key}`);
        const result = await this.client.send(command);
        log.info(`Uploaded JSON to S3: ${key}`);
        return result;
    }
}

class NoOpStorage implements IStorage {
    async upload(key: string, _body: Readable | Buffer | string): Promise<void> {
        log.info(`[NoOpStorage] Skipping upload for key: ${key}`);
        return Promise.resolve();
    }

    async getTemporaryUrl(key: string, _expiresIn?: number): Promise<string> {
        log.info(`[NoOpStorage] Skipping getTemporaryUrl for key: ${key}`);
        return Promise.resolve("");
    }

    async uploadImage(key: string, _imageData: Buffer | Readable, _contentType?: string): Promise<void> {
        log.info(`[NoOpStorage] Skipping uploadImage for key: ${key}`);
        return Promise.resolve();
    }

    async get(key: string): Promise<Buffer | null> {
        log.info(`[NoOpStorage] Skipping get for key: ${key}`);
        return Promise.resolve(null);
    }

    async uploadJson(key: string, _data: object): Promise<void> {
        log.info(`[NoOpStorage] Skipping uploadJson for key: ${key}`);
        return Promise.resolve();
    }
}

function createS3Client(bucketOverride?: string): IStorage {
    if (process.env.ANYCRAWL_STORAGE === "s3") {
        log.info("Using S3 storage");
        return new S3Storage(bucketOverride);
    }
    log.info("Using NoOp storage");
    return new NoOpStorage();
}

export const s3: IStorage = createS3Client();
export const s3Cache: IStorage = createS3Client(getStorageConfig().bucket || undefined);
