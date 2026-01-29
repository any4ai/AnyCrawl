import { WorkerManager } from "./managers/Worker.js";
import { QueueManager } from "./managers/Queue.js";
import { Job } from "bullmq";
import { log } from "crawlee";
import { Utils } from "./Utils.js";
// Removed unused imports to keep startup lean
import { ProgressManager } from "./managers/Progress.js";
import { ALLOWED_ENGINES, JOB_TYPE_CRAWL, JOB_TYPE_SCRAPE } from "@anycrawl/libs";
import { ensureAIConfigLoaded } from "@anycrawl/ai/utils/config.js";
import { refreshAIConfig, getDefaultLLModelId, getEnabledProviderModels } from "@anycrawl/ai/utils/helper.js";

// Parse command-line arguments for queue selection
function parseQueueArgs(): { queues: string[], schedulerOnly: boolean } {
    const args = process.argv.slice(2);
    const queueArg = args.find(arg => arg.startsWith('--queues='));

    if (!queueArg) {
        // Default: start all queues
        return { queues: [], schedulerOnly: false };
    }

    const queuesValue = queueArg.split('=')[1];
    if (!queuesValue) {
        return { queues: [], schedulerOnly: false };
    }

    const queues = queuesValue.split(',').map(q => q.trim()).filter(q => q);

    // Check if only scheduler is requested
    const schedulerOnly = queues.length === 1 && queues[0] === 'scheduler';

    return { queues, schedulerOnly };
}

const { queues: requestedQueues, schedulerOnly } = parseQueueArgs();

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

// Determine which engines to initialize based on requested queues
let AVAILABLE_ENGINES: string[] = [];
let engineQueueManager: any;

if (!schedulerOnly) {
    log.info("Initializing queues and engines...");
    // Dynamically import after AI config is ready to ensure @anycrawl/ai is initialized with config
    const { EngineQueueManager, AVAILABLE_ENGINES: ALL_ENGINES } = await import("./managers/EngineQueue.js");

    // Filter engines based on requested queues
    if (requestedQueues.length > 0) {
        // Extract engine names from queue names (e.g., "playwright", "puppeteer", "cheerio")
        const requestedEngines = new Set(
            requestedQueues
                .filter(q => q !== 'scheduler')
                .map(q => q.replace(/^(scrape-|crawl-)/, ''))
        );
        AVAILABLE_ENGINES = [...ALL_ENGINES].filter((engine: string) => requestedEngines.has(engine));
        log.info(`🎯 Starting selected queues: ${Array.from(requestedEngines).join(', ')}`);
    } else {
        AVAILABLE_ENGINES = [...ALL_ENGINES];
        log.info("🚀 Starting all available queues");
    }

    engineQueueManager = EngineQueueManager.getInstance();
    await engineQueueManager.initializeQueues();
    await engineQueueManager.initializeEngines();

    // Initialize QueueManager
    QueueManager.getInstance();
    log.info("All queues and engines initialized and started");
} else {
    log.info("🎯 Starting scheduler only (no browser queues)");
}

// Initialize Scheduler Manager (if enabled and requested)
const shouldStartScheduler = process.env.ANYCRAWL_SCHEDULER_ENABLED === "true" &&
    (requestedQueues.length === 0 || requestedQueues.includes('scheduler'));

if (shouldStartScheduler) {
    const { SchedulerManager } = await import("./managers/Scheduler.js");
    await SchedulerManager.getInstance().start();
    log.info("✅ Scheduler Manager initialized");
}

// Initialize Webhook Manager (if enabled)
if (process.env.ANYCRAWL_WEBHOOKS_ENABLED === "true") {
    const { WebhookManager } = await import("./managers/Webhook.js");
    await WebhookManager.getInstance().initialize();
    log.info("✅ Webhook Manager initialized");
}

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
            // Ensure template variables are available to the engine context
            templateVariables: job.data.templateVariables,
            options: options || {},
            crawl_options: jobType === JOB_TYPE_CRAWL ? job.data.options : null,
            // Set original_url to initial URL for proxy rule matching
            // This ensures proxy rules can match correctly for both initial and subsequent requests
            original_url: job.data.url,
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
        const workers = [];

        // Worker for scheduler queue (BullMQ repeatable jobs)
        if (shouldStartScheduler) {
            workers.push(
                WorkerManager.getInstance().getWorker('scheduler', async (job: Job) => {
                    const { SchedulerManager } = await import("./managers/Scheduler.js");
                    await SchedulerManager.getInstance().processScheduledTaskJob(job);
                })
            );
        }

        // Workers for scrape and crawl jobs (only if not scheduler-only mode)
        if (!schedulerOnly) {
            // Workers for scrape jobs
            workers.push(
                ...AVAILABLE_ENGINES.map((engineType: any) =>
                    WorkerManager.getInstance().getWorker(`scrape-${engineType}`, async (job: Job) => {
                        job.updateData({
                            ...job.data,
                            type: JOB_TYPE_SCRAPE,
                        });
                        await runJob(job);
                    })
                )
            );
            // Workers for crawl jobs
            workers.push(
                ...AVAILABLE_ENGINES.map((engineType: any) =>
                    WorkerManager.getInstance().getWorker(`crawl-${engineType}`, async (job: Job) => {
                        job.updateData({
                            ...job.data,
                            type: JOB_TYPE_CRAWL,
                        });
                        await runJob(job);
                    })
                )
            );
        }

        await Promise.all(workers);

        log.info("Worker started successfully");

        // Check queue status periodically for all engines (only if not scheduler-only)
        if (!schedulerOnly) {
            setInterval(async () => {
                for (const engineType of AVAILABLE_ENGINES) {
                    try {
                        const queueInfo = await engineQueueManager.getQueueInfo(engineType);
                        if (queueInfo) {
                            log.info(
                                `[QUEUE] ${engineType} - requests: ${queueInfo.pendingRequestCount}, handled: ${queueInfo.handledRequestCount}`
                            );
                        }
                    } catch (error) {
                        log.error(`[QUEUE] Error checking status for ${engineType}: ${error}`);
                    }
                }
            }, 3000); // Check every 3 seconds
        }

        // Log current browser instances for browser engines (controlled by env, only if not scheduler-only)
        if (!schedulerOnly && process.env.ANYCRAWL_LOG_BROWSER_STATUS === "true") {
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

                        log.info(`[BROWSER] ${engineType} - count: ${browserCount} (desired=${desiredConcurrency}, current=${currentConcurrency})`);
                    } catch (error) {
                        log.error(`[BROWSER] Error checking status for ${engineType}: ${error}`);
                    }
                }
            }, 5000); // Check every 5 seconds
        }

        // Check for jobs that need finalization based on limits
        setInterval(async () => {
            try {
                log.debug("[FINALIZE] Starting periodic finalization check for crawl jobs...");
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

                log.debug(`[FINALIZE] Found ${activeJobs.length} active crawl jobs to check for finalization`);

                let checkedJobs = 0;
                let jobsWithLimits = 0;
                let finalizedJobs = 0;

                for (const job of activeJobs) {
                    try {
                        checkedJobs++;
                        const payload = job.payload as any;
                        const limit = payload?.limit;

                        log.debug(`[FINALIZE] Checking job ${job.jobId} (queue: ${job.queueName}) - limit: ${limit}`);

                        if (limit && typeof limit === 'number' && limit > 0) {
                            jobsWithLimits++;
                            log.debug(`[FINALIZE] Job ${job.jobId} has limit ${limit}, checking for finalization...`);

                            const wasFinalized = await pm.checkAndFinalizeByLimit(job.jobId, job.queueName, limit);
                            if (wasFinalized) {
                                finalizedJobs++;
                                log.info(`[FINALIZE] Job ${job.jobId} was finalized due to reaching limit ${limit}`);
                            } else {
                                log.debug(`[FINALIZE] Job ${job.jobId} not yet ready for finalization (limit: ${limit})`);
                            }
                        } else {
                            log.warning(`[FINALIZE] Job ${job.jobId} has no valid limit, skipping finalization check`);
                        }
                    } catch (error) {
                        log.error(`[FINALIZE] Error checking job ${job.jobId} for finalization: ${error}`);
                    }
                }

                log.info(`[FINALIZE] Finalization check completed: ${checkedJobs} jobs checked, ${jobsWithLimits} with limits, ${finalizedJobs} finalized`);
            } catch (error) {
                log.error(`[FINALIZE] Error in periodic finalization check: ${error}`);
            }
        }, 10000); // Check every 10 seconds

        // Check for expired jobs and clean them up
        setInterval(async () => {
            try {
                log.debug("[CLEANUP] Starting periodic cleanup check for expired jobs...");
                const { getDB, schemas, eq, sql } = await import("@anycrawl/db");
                const progressManager = ProgressManager.getInstance();
                const db = await getDB();

                // Find all pending jobs that have expired
                const expiredJobs = await db
                    .select({
                        jobId: schemas.jobs.jobId,
                        jobType: schemas.jobs.jobType,
                        jobQueueName: schemas.jobs.jobQueueName,
                        jobExpireAt: schemas.jobs.jobExpireAt,
                        status: schemas.jobs.status
                    })
                    .from(schemas.jobs)
                    .limit(1000)
                    .where(
                        sql`${schemas.jobs.status} = 'pending' AND ${schemas.jobs.jobExpireAt} < NOW()`
                    );

                if (expiredJobs.length > 0) {
                    log.info(`[CLEANUP] Found ${expiredJobs.length} expired pending jobs to clean up`);

                    let cleanedJobs = 0;
                    for (const job of expiredJobs) {
                        try {
                            let finalStatus: string;
                            let finalMessage: string;
                            let shouldMarkAsCompleted: boolean;

                            // First, try to use ProgressManager to get final status
                            try {
                                const isFinalized = await progressManager.isFinalized(job.jobId);

                                if (isFinalized) {
                                    // Job is already finalized by ProgressManager
                                    log.info(`[CLEANUP] Expired job ${job.jobId} already finalized by ProgressManager, skipping`);
                                    continue;
                                }

                                // Use job's own counts for decision
                                const jobCompleted = job.completed || 0;
                                const jobFailed = job.failed || 0;

                                const totalCompleted = jobCompleted;
                                const totalFailed = jobFailed;

                                shouldMarkAsCompleted = totalFailed <= totalCompleted;
                                finalStatus = shouldMarkAsCompleted ? 'completed' : 'failed';
                                finalMessage = shouldMarkAsCompleted
                                    ? `Job completed with timeout (failed: ${totalFailed} <= completed: ${totalCompleted})`
                                    : `Job failed due to timeout (failed: ${totalFailed} > completed: ${totalCompleted})`;
                            } catch (pmError) {
                                // Fallback to simple job record check if ProgressManager fails
                                const jobCompleted = job.completed || 0;
                                const jobFailed = job.failed || 0;

                                shouldMarkAsCompleted = jobFailed <= jobCompleted;
                                finalStatus = shouldMarkAsCompleted ? 'completed' : 'failed';
                                finalMessage = shouldMarkAsCompleted
                                    ? `Job completed with timeout (failed: ${jobFailed} <= completed: ${jobCompleted}) - PM failed`
                                    : `Job failed due to timeout (failed: ${jobFailed} > completed: ${jobCompleted}) - PM failed`;
                            }

                            // Update job status
                            await db
                                .update(schemas.jobs)
                                .set({
                                    status: finalStatus,
                                    errorMessage: finalMessage,
                                    updatedAt: new Date(),
                                    isSuccess: shouldMarkAsCompleted,
                                })
                                .where(eq(schemas.jobs.jobId, job.jobId));

                            cleanedJobs++;
                            log.info(`[CLEANUP] Cleaned up expired job ${job.jobId} (type: ${job.jobType}, expired at: ${job.jobExpireAt}) -> ${finalStatus}`);
                        } catch (error) {
                            log.error(`[CLEANUP] Error cleaning up expired job ${job.jobId}: ${error}`);
                        }
                    }

                    log.info(`[CLEANUP] Expired job cleanup completed: ${cleanedJobs} jobs cleaned up`);
                } else {
                    log.debug("[CLEANUP] No expired jobs found for cleanup");
                }
            } catch (error) {
                log.error(`[CLEANUP] Error in periodic expired job cleanup: ${error}`);
            }
        }, 60000); // Check every 60 seconds

        // Handle graceful shutdown
        process.on("SIGINT", async () => {
            log.warning("Received SIGINT signal, stopping all services...");
            // Temporarily disable console.warn to prevent the pause message
            const originalWarn = console.warn;
            console.warn = () => { };

            // Stop Scheduler Manager (if enabled)
            if (process.env.ANYCRAWL_SCHEDULER_ENABLED === "true") {
                try {
                    const { SchedulerManager } = await import("./managers/Scheduler.js");
                    await SchedulerManager.getInstance().stop();
                    log.info("✅ Scheduler Manager stopped");
                } catch (error) {
                    log.error(`Error stopping Scheduler Manager: ${error}`);
                }
            }

            // Stop Webhook Manager (if enabled)
            if (process.env.ANYCRAWL_WEBHOOKS_ENABLED === "true") {
                try {
                    const { WebhookManager } = await import("./managers/Webhook.js");
                    await WebhookManager.getInstance().stop();
                    log.info("✅ Webhook Manager stopped");
                } catch (error) {
                    log.error(`Error stopping Webhook Manager: ${error}`);
                }
            }

            // Stop all engines (if initialized)
            if (!schedulerOnly) {
                await engineQueueManager.stopEngines();
            }

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
// Start engines (only if not scheduler-only)
if (!schedulerOnly) {
    await engineQueueManager.startEngines();
}
