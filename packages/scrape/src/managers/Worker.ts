import { Worker } from "bullmq";
import { log } from "@anycrawl/libs";
import { Utils } from "../Utils.js";
import { getPerformanceTuning } from "../core/PerformanceTuner.js";

export class WorkerManager {
    private static instance: WorkerManager;
    private workers: Map<string, Worker> = new Map();

    private constructor() {}

    public static getInstance(): WorkerManager {
        if (!WorkerManager.instance) {
            WorkerManager.instance = new WorkerManager();
        }
        return WorkerManager.instance;
    }
    public async getWorker(name: string, jobHandler: (job: any) => Promise<void>): Promise<Worker> {
        if (!this.workers.has(name)) {
            const shouldLogLifecycle = name.startsWith("scrape-") || name.startsWith("crawl-");
            this.workers.set(
                name,
                new Worker(
                    name,
                    async (job) => {
                        if (shouldLogLifecycle) {
                            log.info(`[BULLMQ] Worker ${name} picked job ${job.id}`);
                        }
                        return await jobHandler(job);
                    },
                    {
                        connection: Utils.getInstance().getRedisConnection(),
                        concurrency: getPerformanceTuning().workerConcurrency,
                    }
                )
            );
            const worker = this.workers.get(name)!;
            if (shouldLogLifecycle) {
                worker.on("ready", () => log.info(`[BULLMQ] Worker ${name} ready`));
                worker.on("active", (job) => log.info(`[BULLMQ] Worker ${name} active job ${job.id}`));
                worker.on("completed", (job) => log.info(`[BULLMQ] Worker ${name} completed job ${job.id}`));
                worker.on("stalled", (jobId) => log.warning(`[BULLMQ] Worker ${name} stalled job ${jobId}`));
            }
            worker.on("failed", (job, error) => log.error(`[BULLMQ] Worker ${name} failed job ${job?.id}: ${error.message}`));
            worker.on("error", (error) => log.error(`[BULLMQ] Worker ${name} error: ${error.message}`));
        }
        return this.workers.get(name)!;
    }
}
