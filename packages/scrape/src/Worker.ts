import { WorkerManager } from "./managers/Worker.js";
import { QueueManager } from "./managers/Queue.js";
import { Job } from "bullmq";
import { log } from "crawlee";
import { Utils } from "./Utils.js";
// Removed unused imports to keep startup lean
import { ProgressManager } from "./managers/Progress.js";
import { ALLOWED_ENGINES, JOB_TYPE_CRAWL, JOB_TYPE_SCRAPE } from "./constants.js";
import { ensureAIConfigLoaded } from "@anycrawl/ai/utils/config.js";
import { refreshAIConfig, getDefaultLLModelId, getEnabledProviderModels } from "@anycrawl/ai/utils/helper.js";

// Initialize Utils first
const utils = Utils.getInstance();
await utils.initializeKeyValueStore();

// Initialize queues and engines
// Ensure AI config is loaded (URL/file) before engines start
try {
    await ensureAIConfigLoaded();
    refreshAIConfig();
    const providers = Array.from(new Set(getEnabledProviderModels().map(p => p.provider)));
    const defaultModel = getDefaultLLModelId();
    log.info(`[ai] providers ready: ${providers.length > 0 ? providers.join(', ') : 'none'}`);
    if (defaultModel) log.info(`[ai] default model: ${defaultModel}`);
    // Validate extract model provider is actually registered
    try {
        const { getLLM, getExtractModelId } = await import("@anycrawl/ai");
        const extractId = getExtractModelId();
        getLLM(extractId);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.warning(`[ai] validation: ${msg}. Check provider credentials (apiKey/baseURL) for the configured provider.`);
    }
} catch { }
const authEnabled = process.env.ANYCRAWL_API_AUTH_ENABLED === "true";
const creditsEnabled = process.env.ANYCRAWL_API_CREDITS_ENABLED === "true";
log.info(`🔐 Auth enabled: ${authEnabled}`);
log.info(`💳 Credits deduction enabled: ${creditsEnabled}`);
log.info("Initializing queues and engines...");
// Dynamically import after AI config is ready to ensure @anycrawl/ai is initialized with config
const { EngineQueueManager, AVAILABLE_ENGINES } = await import("./managers/EngineQueue.js");
const engineQueueManager = EngineQueueManager.getInstance();
await engineQueueManager.initializeQueues();
await engineQueueManager.initializeEngines();

// Initialize QueueManager
QueueManager.getInstance();
log.info("All queues and engines initialized and started");

async function runJob(job: Job) {
    const engineType = job.data.engine || "cheerio";
    if (!ALLOWED_ENGINES.includes(engineType)) {
        throw new Error(`Unsupported engine type: ${engineType}`);
    }

    const jobType = job.data.type || JOB_TYPE_SCRAPE;
    log.info(`Processing ${jobType} job for URL: ${job.data.url} with engine: ${engineType}`);

    let options = job.data.options;
    // if jobType is crawl, transform options
    if (jobType === JOB_TYPE_CRAWL) {
        options = { ...job.data.options.scrape_options };
    }
    // Use queue job ID for status updates, but pass parentId for result recording
    const currentJobId = job.id as string;
    const parentId = job.data.parentId || currentJobId; // Use provided parentId for result recording
    const uniqueKey = await engineQueueManager.addRequest(engineType, job.data.url,
        {
            jobId: currentJobId, // Use queue job ID for status updates
            parentId: parentId, // Use parent job ID for result recording
            queueName: job.data.queueName,
            type: jobType,
            options: options || {},
            crawl_options: jobType === JOB_TYPE_CRAWL ? job.data.options : null,
        }
    );
    // Seed enqueued counter for crawl jobs (the initial URL itself)
    if (jobType === JOB_TYPE_CRAWL) {
        await ProgressManager.getInstance().incrementEnqueued(currentJobId, 1);
    }
    job.updateData({
        ...job.data,
        uniqueKey,
        status: "processing",
    });
}

// Initialize the application
(async () => {
    try {
        // check redis
        const redisClient = Utils.getInstance().getRedisConnection();
        await redisClient.ping();
        log.info("Redis connection established");
        // Start the worker to handle new URLs
        log.info("Starting worker...");
        await Promise.all([
            // Workers for scrape jobs
            ...AVAILABLE_ENGINES.map((engineType: any) =>
                WorkerManager.getInstance().getWorker(`scrape-${engineType}`, async (job: Job) => {
                    job.updateData({
                        ...job.data,
                        type: JOB_TYPE_SCRAPE,
                    });
                    await runJob(job);
                })
            ),
            // Workers for crawl jobs
            ...AVAILABLE_ENGINES.map((engineType: any) =>
                WorkerManager.getInstance().getWorker(`crawl-${engineType}`, async (job: Job) => {
                    job.updateData({
                        ...job.data,
                        type: JOB_TYPE_CRAWL,
                    });
                    await runJob(job);
                }),
            )
        ]);

        log.info("Worker started successfully");

        // Check queue status periodically for all engines
        setInterval(async () => {
            for (const engineType of AVAILABLE_ENGINES) {
                try {
                    const queueInfo = await engineQueueManager.getQueueInfo(engineType);
                    if (queueInfo) {
                        log.info(
                            `Queue status for ${engineType} - requests: ${queueInfo.pendingRequestCount}, handled: ${queueInfo.handledRequestCount}`
                        );
                    }
                } catch (error) {
                    log.error(`Error checking queue status for ${engineType}: ${error}`);
                }
            }
        }, 3000); // Check every 3 seconds

        // Log current browser instances for browser engines (controlled by env)
        if (process.env.ANYCRAWL_LOG_BROWSER_STATUS === "true") {
            setInterval(async () => {
                for (const engineType of AVAILABLE_ENGINES) {
                    try {
                        const engine = await engineQueueManager.getEngine(engineType);
                        const crawler: any = (engine as any).getEngine ? (engine as any).getEngine() : undefined;
                        const isBrowserEngine = engineType === 'playwright' || engineType === 'puppeteer';
                        let browserCount: number | string = isBrowserEngine ? 0 : 'n/a';
                        let desiredConcurrency: number | string = 'n/a';
                        let currentConcurrency: number | string = 'n/a';

                        if (crawler) {
                            const browserPool: any = (crawler as any).browserPool ?? (crawler as any)._browserPool;
                            const autoscaledPool: any = (crawler as any).autoscaledPool ?? (crawler as any)._autoscaledPool;

                            // Fixed single source of truth for browser count
                            if (browserPool && isBrowserEngine) {
                                browserCount = browserPool.activeBrowserControllers ?? 0;
                            }

                            if (autoscaledPool) {
                                desiredConcurrency = autoscaledPool.desiredConcurrency ?? autoscaledPool._desiredConcurrency ?? 'n/a';
                                currentConcurrency = autoscaledPool.currentConcurrency ?? autoscaledPool._currentConcurrency ?? 'n/a';
                            }
                        }

                        log.info(`Browser status for ${engineType} - count: ${browserCount} (desired=${desiredConcurrency}, current=${currentConcurrency})`);
                    } catch (error) {
                        log.error(`Error checking browser status for ${engineType}: ${error}`);
                    }
                }
            }, 5000); // Check every 5 seconds
        }

        // Check for jobs that need finalization based on limits
        setInterval(async () => {
            try {
                log.debug("Starting periodic finalization check for crawl jobs...");
                const pm = ProgressManager.getInstance();
                // Get all active crawl jobs from the database
                const { getDB, schemas, eq, sql } = await import("@anycrawl/db");
                const db = await getDB();

                // Use proper drizzle syntax for the query
                const activeJobs = await db
                    .select({
                        jobId: schemas.jobs.jobId,
                        queueName: schemas.jobs.jobQueueName,
                        payload: schemas.jobs.payload,
                        status: schemas.jobs.status
                    })
                    .from(schemas.jobs)
                    .limit(1000)
                    .where(
                        sql`${schemas.jobs.status} = 'pending' AND ${schemas.jobs.payload}->>'type' = 'crawl'`
                    );

                log.debug(`Found ${activeJobs.length} active crawl jobs to check for finalization`);

                let checkedJobs = 0;
                let jobsWithLimits = 0;
                let finalizedJobs = 0;

                for (const job of activeJobs) {
                    try {
                        checkedJobs++;
                        const payload = job.payload as any;
                        const limit = payload?.limit;

                        log.debug(`Checking job ${job.jobId} (queue: ${job.queueName}) - limit: ${limit}`);

                        if (limit && typeof limit === 'number' && limit > 0) {
                            jobsWithLimits++;
                            log.debug(`Job ${job.jobId} has limit ${limit}, checking for finalization...`);

                            const wasFinalized = await pm.checkAndFinalizeByLimit(job.jobId, job.queueName, limit);
                            if (wasFinalized) {
                                finalizedJobs++;
                                log.info(`Job ${job.jobId} was finalized due to reaching limit ${limit}`);
                            } else {
                                log.debug(`Job ${job.jobId} not yet ready for finalization (limit: ${limit})`);
                            }
                        } else {
                            log.warning(`Job ${job.jobId} has no valid limit, skipping finalization check`);
                        }
                    } catch (error) {
                        log.error(`Error checking job ${job.jobId} for finalization: ${error}`);
                    }
                }

                log.info(`Finalization check completed: ${checkedJobs} jobs checked, ${jobsWithLimits} with limits, ${finalizedJobs} finalized`);
            } catch (error) {
                log.error(`Error in periodic finalization check: ${error}`);
            }
        }, 10000); // Check every 10 seconds

        // Handle graceful shutdown
        process.on("SIGINT", async () => {
            log.warning("Received SIGINT signal, stopping all crawlers...");
            // Temporarily disable console.warn to prevent the pause message
            const originalWarn = console.warn;
            console.warn = () => { };

            // Stop all engines
            await engineQueueManager.stopEngines();

            // Restore console.warn
            console.warn = originalWarn;

            process.exit(0);
        });

        // Keep the process running
        process.stdin.resume();
    } catch (error) {
        log.error(`Failed to start scraping worker: ${error}`);
        process.exit(1);
    }
})();
await engineQueueManager.startEngines();
