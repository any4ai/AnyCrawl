import { Configuration, KeyValueStore, log, RequestQueueV2 } from "crawlee";
import { join } from "node:path";
import IORedis from "ioredis";
import { Job } from "bullmq";
import type { EngineOptions } from "./types/engine.js";

/**
 * Utility class for storing global instances
 */
export class Utils {
    private static instance: Utils;
    private keyValueStore: KeyValueStore | undefined = undefined;
    private queueMap: Map<string, RequestQueueV2> = new Map();

    private constructor() {
        const config = Configuration.getGlobalConfig();
        config.set("storageClientOptions", {
            localDataDirectory: join(process.cwd(), "../../storage"),
        });
    }

    static getInstance(): Utils {
        if (!Utils.instance) {
            Utils.instance = new Utils();
        }
        return Utils.instance;
    }

    public async initializeKeyValueStore(): Promise<void> {
        if (!this.keyValueStore) {
            this.keyValueStore = await KeyValueStore.open(this.getStorageName());
            log.info("KeyValueStore initialized");
        }
    }

    /**
     * Get the KeyValueStore instance
     * @returns The KeyValueStore instance
     */
    public async getKeyValueStore(): Promise<KeyValueStore> {
        if (!this.keyValueStore) {
            await this.initializeKeyValueStore();
        }
        return this.keyValueStore!;
    }

    /**
     * Set the storage directory
     */
    public setStorageDirectory = () => {
        const config = Configuration.getGlobalConfig();
        config.set("storageClientOptions", {
            localDataDirectory: join(process.cwd(), "../../storage"),
        });
    };

    /**
     * Get a queue by name
     * @param name The name of the queue
     * @returns The queue
     */
    public async getQueue(name: string): Promise<RequestQueueV2> {
        let queue = this.queueMap.get(name);
        if (!queue) {
            queue = await RequestQueueV2.open(`${name}_queue`);
            this.queueMap.set(name, queue);
            log.info(`Initialized queue for ${name}`);
        }
        return queue;
    }

    /**
     * Get the Redis connection
     * @returns The Redis connection
     */
    public getRedisConnection(): IORedis.Redis {
        const redisConnection = new IORedis.default(process.env.ANYCRAWL_REDIS_URL!, {
            maxRetriesPerRequest: null,
        });
        return redisConnection;
    }

    public async once(job: Job, options?: EngineOptions) {
        let queueName = `temporary_scrape_${job.id}`;
        const queue = await Utils.getInstance().getQueue(queueName);
        await queue.addRequest({
            url: job.data.url,
            label: queueName,
            userData: {
                jobId: job.id,
                engine: job.data.engine,
                queueName: "scrape",
                type: "temporary_scrape",
                options: {},
            },
        });
        const { EngineQueueManager } = await import("./managers/EngineQueue.js");
        const engine = await EngineQueueManager.getInstance().createEngine(
            job.data.engine,
            queue,
            options
        );
        await engine.init();
        await engine.run();
        await queue.drop();
    }

    public getStorageName(): string {
        return process.env.ANYCRAWL_NAME_KEY_VALUE_STORE || 'AnyCrawl';
    }
}
