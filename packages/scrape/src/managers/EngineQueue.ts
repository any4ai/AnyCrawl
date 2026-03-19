import { randomUUID } from "node:crypto";
import { log, RequestQueueV2 } from "crawlee";
import { Utils } from "../Utils.js";
import type { EngineOptions } from "../types/engine.js";
import { EngineFactoryRegistry } from "../engines/EngineFactory.js";
import type { Engine } from "../engines/EngineFactory.js";
import { ALLOWED_ENGINES } from "@anycrawl/libs";

const VIRTUAL_ENGINES = ["auto"] as const;

export const AVAILABLE_ENGINES = (() => {
    if (process.env.ANYCRAWL_AVAILABLE_ENGINES) {
        const engines = process.env.ANYCRAWL_AVAILABLE_ENGINES.split(',').map(e => e.trim().toLowerCase());
        const invalidEngines = engines.filter(e => !ALLOWED_ENGINES.includes(e as any));
        if (invalidEngines.length > 0) {
            throw new Error(`Invalid engine types specified: ${invalidEngines.join(', ')}. Allowed engines are: ${ALLOWED_ENGINES.join(', ')}`);
        }
        return engines as unknown as typeof ALLOWED_ENGINES;
    }
    return ALLOWED_ENGINES;
})();

const REAL_ENGINES = AVAILABLE_ENGINES.filter(
    (e: string) => !(VIRTUAL_ENGINES as readonly string[]).includes(e),
);

// Define engine type
export type EngineType = (typeof AVAILABLE_ENGINES)[number];

log.info(`ignore ssl errors: ${process.env.ANYCRAWL_IGNORE_SSL_ERROR === "true" ? true : false}`);
log.info(`enable proxy: ${(process.env.ANYCRAWL_PROXY_URL) ? true : false}, ${process.env.ANYCRAWL_PROXY_URL}`);
if (process.env.ANYCRAWL_PROXY_CONFIG) {
    log.info(`proxy config: ${process.env.ANYCRAWL_PROXY_CONFIG}`);
}
// Queue manager class to handle all engine queues
export class EngineQueueManager {
    private static instance: EngineQueueManager;
    private queues: Map<string, RequestQueueV2> = new Map();
    private engines: Map<string, Engine> = new Map();

    private constructor() { }

    async getAvailableEngines(): Promise<EngineType[]> {
        return [...AVAILABLE_ENGINES];
    }

    static getInstance(): EngineQueueManager {
        if (!EngineQueueManager.instance) {
            EngineQueueManager.instance = new EngineQueueManager();
        }
        return EngineQueueManager.instance;
    }

    async initializeQueues(): Promise<void> {
        for (const engineType of REAL_ENGINES) {
            const queue = await Utils.getInstance().getQueue(engineType);
            this.queues.set(engineType, queue);
        }
    }

    async initializeEngines(): Promise<void> {
        for (const engineType of REAL_ENGINES) {
            const queue = this.queues.get(engineType);
            if (!queue) {
                throw new Error(`Queue not initialized for ${engineType}`);
            }

            let engine: Engine = await this.createEngine(engineType, queue);

            // Ensure the queue is set before initialization
            await engine.init();
            this.engines.set(engineType, engine);
            log.info(`Initialized engine for ${engineType}`);
        }
    }

    /**
     * create engine using factory pattern
     * @param engineType engine type
     * @param queue request queue
     * @param options engine options
     * @returns engine
     */
    async createEngine(
        engineType: string,
        queue: RequestQueueV2,
        options?: EngineOptions
    ): Promise<Engine> {
        return EngineFactoryRegistry.createEngine(engineType, queue, options);
    }

    async startEngines(): Promise<void> {
        // Start all engines
        for (const [engineType, engine] of this.engines) {
            try {
                log.info(`Starting crawler for ${engineType}...`);
                engine.run().then(() => { });
            } catch (error) {
                log.error(`Error starting crawler for ${engineType}: ${error}`);
                throw error;
            }
        }
    }

    async getEngine(engineType: string): Promise<Engine> {
        const engine = this.engines.get(engineType);
        if (!engine) {
            throw new Error(`Engine not found for ${engineType}`);
        }
        return engine;
    }

    async stopEngines(): Promise<void> {
        // Stop all engines
        for (const [engineType, engine] of this.engines) {
            await engine.stop();
        }
    }

    async addRequest(engineType: string, url: string, userData: object): Promise<string> {
        const queue = this.queues.get(engineType);
        if (!queue) {
            throw new Error(`Queue not found for engine type: ${engineType}`);
        }
        const uniqueKey = randomUUID().toString() + "-" + url;
        await queue.addRequest({
            url,
            uniqueKey,
            userData, //userData.options will be used as options for the engine
        });
        log.info(`Added URL to queue: ${url} for engine: ${engineType}`);
        return uniqueKey;
    }

    async getQueueInfo(engineType: string): Promise<any> {
        const queue = this.queues.get(engineType);
        if (!queue) {
            throw new Error(`Queue not found for engine type: ${engineType}`);
        }
        return queue.getInfo();
    }
}
