import IORedis from "ioredis";
import { Utils } from "../Utils.js";
import { completedJob, failedJob, getDB, schemas, eq, sql } from "@anycrawl/db";
import { log, CreditCalculator } from "@anycrawl/libs";
import type { QueueName } from "./Queue.js";
import { BandwidthManager } from "./Bandwidth.js";

const REDIS_FIELDS = {
    ENQUEUED: "enqueued",
    DONE: "done",
    SUCCEEDED: "succeeded",
    FAILED: "failed",
    STARTED_AT: "started_at",
    FINISHED_AT: "finished_at",
    FINALIZED: "finalized",
    CANCELLED: "cancelled",
    ENQUEUING: "enqueuing",
} as const;

/**
 * Progress manager for crawl jobs using Redis counters
 * Keys:
 *  - HSET crawl:{jobId} enqueued <number> done <number> succeeded <number> failed <number> started_at <ts> finished_at <ts> finalized 0|1
 */
export class ProgressManager {
    private static instance: ProgressManager;
    private redis: IORedis.Redis;

    private constructor() {
        this.redis = Utils.getInstance().getRedisConnection();
    }

    public static getInstance(): ProgressManager {
        if (!ProgressManager.instance) {
            ProgressManager.instance = new ProgressManager();
        }
        return ProgressManager.instance;
    }

    private key(jobId: string): string {
        return `crawl:${jobId}`;
    }

    private async getNumberField(jobId: string, field: string): Promise<number> {
        const key = this.key(jobId);
        try {
            const rawValue = await this.redis.hget(key, field);
            return Number(rawValue ?? 0);
        } catch {
            return 0;
        }
    }

    async ensureStarted(jobId: string): Promise<void> {
        const key = this.key(jobId);
        try {
            await this.redis.hsetnx(key, REDIS_FIELDS.STARTED_AT, new Date().toISOString());
        } catch {
            // ignore
        }
    }

    /**
     * Reset progress state for a job (useful on retries or restarts)
     */
    async reset(jobId: string): Promise<void> {
        const key = this.key(jobId);
        try {
            await this.redis.del(key);
        } catch {
            // ignore
        }
    }

    public async getEnqueued(jobId: string): Promise<number> {
        return this.getNumberField(jobId, REDIS_FIELDS.ENQUEUED);
    }

    public async getDone(jobId: string): Promise<number> {
        return this.getNumberField(jobId, REDIS_FIELDS.DONE);
    }

    public async isFinalized(jobId: string): Promise<boolean> {
        const key = this.key(jobId);
        try {
            const value = await this.redis.hget(key, REDIS_FIELDS.FINALIZED);
            return String(value ?? '0') === '1';
        } catch {
            return false;
        }
    }

    public async isCancelled(jobId: string): Promise<boolean> {
        const key = this.key(jobId);
        try {
            const value = await this.redis.hget(key, REDIS_FIELDS.CANCELLED);
            return String(value ?? '0') === '1';
        } catch {
            return false;
        }
    }

    public async beginEnqueue(jobId: string): Promise<void> {
        const key = this.key(jobId);
        try {
            await this.redis.hincrby(key, REDIS_FIELDS.ENQUEUING, 1);
        } catch { }
    }

    public async endEnqueue(jobId: string): Promise<void> {
        const key = this.key(jobId);
        try {
            // Decrement but not below zero
            const lua = `
              local k = KEYS[1]
              local f = '${REDIS_FIELDS.ENQUEUING}'
              local cur = tonumber(redis.call('HGET', k, f) or '0')
              if cur > 0 then
                redis.call('HINCRBY', k, f, -1)
              else
                redis.call('HSET', k, f, '0')
              end
            `;
            await this.redis.eval(lua, 1, key);
        } catch { }
    }

    public async getEnqueuing(jobId: string): Promise<number> {
        return this.getNumberField(jobId, REDIS_FIELDS.ENQUEUING);
    }

    async incrementEnqueued(jobId: string, incrementBy: number): Promise<void> {
        if (incrementBy <= 0) return;
        const key = this.key(jobId);
        const now = new Date().toISOString();
        await this.redis
            .multi()
            .hsetnx(key, REDIS_FIELDS.STARTED_AT, now)
            .hincrby(key, REDIS_FIELDS.ENQUEUED, incrementBy)
            .exec();
    }

    async markPageDone(
        jobId: string,
        wasSuccess: boolean
    ): Promise<{ done: number; enqueued: number }> {
        const key = this.key(jobId);
        // If already finalized, do not increment counters nor deduct credits again
        try {
            const finalized = await this.isFinalized(jobId);
            if (finalized) {
                const [enqueued, done] = await Promise.all([
                    this.getEnqueued(jobId),
                    this.getDone(jobId),
                ]);
                return { done, enqueued };
            }
        } catch { /* ignore and continue */ }
        const res = await this.redis
            .multi()
            .hincrby(key, REDIS_FIELDS.DONE, 1)
            .hincrby(key, wasSuccess ? REDIS_FIELDS.SUCCEEDED : REDIS_FIELDS.FAILED, 1)
            .hget(key, REDIS_FIELDS.ENQUEUED)
            .hget(key, REDIS_FIELDS.DONE)
            .exec();
        const enqueued = Number(res?.[2]?.[1] ?? 0);
        const done = Number(res?.[3]?.[1] ?? 0);

        // Increment DB counters per page and deduct credits inside a single DB transaction
        try {
            const db = await getDB();
            let perPageCost = 1;
            let queueNameForFinalize: string | undefined;
            let apiKeyForDeduction: string | undefined;
            let jobLimit: number | undefined;
            let shouldDeductCredits = wasSuccess;
            let remainingAfterDeduction: number | undefined;

            await db.transaction(async (tx: any) => {
                // Fetch job row ONCE for cost calculation, limit checking, deduction and potential finalize
                try {
                    const [jobRow] = await tx
                        .select({ apiKey: schemas.jobs.apiKey, queueName: schemas.jobs.jobQueueName, payload: schemas.jobs.payload })
                        .from(schemas.jobs)
                        .where(eq(schemas.jobs.jobId, jobId));
                    apiKeyForDeduction = jobRow?.apiKey as string | undefined;
                    queueNameForFinalize = jobRow?.queueName as string | undefined;
                    const payload: any = jobRow?.payload ?? {};
                    jobLimit = payload?.limit;
                    // Check if this page exceeds the limit - don't deduct credits if over limit
                    if (jobLimit && done > jobLimit) {
                        shouldDeductCredits = false;
                        log.info(`[${queueNameForFinalize}] [${jobId}] Page ${done} exceeds limit ${jobLimit}, not deducting credits`);
                    }

                    // Calculate per-page cost using CreditCalculator
                    const scrapeOptions = payload?.options?.scrape_options || payload?.options || {};
                    perPageCost = CreditCalculator.calculateCrawlPageCredits({
                        proxy: scrapeOptions.proxy,
                        json_options: scrapeOptions.json_options || payload?.json_options,
                        formats: scrapeOptions.formats || payload?.options?.formats,
                        extract_source: scrapeOptions.extract_source || payload?.extract_source,
                    });
                } catch { /* ignore: default perPageCost remains 1 */ }

                const updates: any = {
                    updatedAt: new Date(),
                };

                // Always update total, completed, failed counters
                updates.total = sql`${schemas.jobs.total} + 1`;
                if (wasSuccess) {
                    updates.completed = sql`${schemas.jobs.completed} + 1`;
                    // Only increment creditsUsed if within limit
                    if (shouldDeductCredits) {
                        updates.creditsUsed = sql`${schemas.jobs.creditsUsed} + ${perPageCost}`;
                    }
                } else {
                    updates.failed = sql`${schemas.jobs.failed} + 1`;
                }

                await tx.update(schemas.jobs).set(updates).where(eq(schemas.jobs.jobId, jobId));

                // Deduct credits from the API key balance per processed URL when credits are enabled and within limit
                if (shouldDeductCredits && process.env.ANYCRAWL_API_CREDITS_ENABLED === 'true' && apiKeyForDeduction) {
                    log.info(`[${queueNameForFinalize}] [${jobId}] Deducting ${perPageCost} credits for page ${done}, apiKey: ${apiKeyForDeduction}`);
                    try {
                        // Update credits and get remaining balance in a single query
                        const [updatedUser] = await tx
                            .update(schemas.apiKey)
                            .set({
                                credits: sql`${schemas.apiKey.credits} - ${perPageCost}`,
                                lastUsedAt: new Date(),
                            })
                            .where(eq(schemas.apiKey.uuid, apiKeyForDeduction))
                            .returning({ credits: schemas.apiKey.credits });
                        if (updatedUser && typeof updatedUser.credits === 'number') {
                            remainingAfterDeduction = updatedUser.credits;
                            log.info(`[${queueNameForFinalize}] [${jobId}] Credits deducted: ${perPageCost}, remaining: ${remainingAfterDeduction}, apiKey: ${apiKeyForDeduction}`);
                        } else {
                            remainingAfterDeduction = undefined;
                            log.warning(`[${queueNameForFinalize}] [${jobId}] Credits deduction returned no row or invalid data; skipping credits-based finalize`);
                        }
                    } catch {
                        log.error(`[PROGRESS] Error deducting credits for job ${jobId}, apiKey: ${apiKeyForDeduction}, perPageCost: ${perPageCost}`);
                        remainingAfterDeduction = undefined;
                    }
                }
            });

            // After COMMIT: only if we positively know credits are exhausted, attempt a safe finalize.
            // Avoid premature finalize when deduction result is unknown or credits feature not applied.
            if (remainingAfterDeduction !== undefined && remainingAfterDeduction <= 0 && queueNameForFinalize) {
                try {
                    const target = Number.isFinite(jobLimit as number) && (jobLimit as number) > 0 ? (jobLimit as number) : 0;
                    log.info(`[${queueNameForFinalize}] [${jobId}] Credits exhausted, attempting safe finalize (target=${target}, done=${done})`);
                    const finalizeResult = await this.tryFinalize(jobId, queueNameForFinalize, { reason: 'credits_exhausted' }, target);
                    if (finalizeResult) {
                        log.info(`[${queueNameForFinalize}] [${jobId}] Job finalized successfully after credits exhausted`);
                    }
                } catch { /* ignore finalize race */ }
            }
        } catch { }
        return { done, enqueued };
    }

    /**
     * Atomically finalize the job if done === enqueued and not finalized yet
     */
    async tryFinalize(
        jobId: string,
        queueName: string,
        summary?: Record<string, unknown>,
        finalizeTarget?: number
    ): Promise<boolean> {
        const key = this.key(jobId);
        const now = new Date().toISOString();
        // Lua script ensures atomic check-and-set
        const script = `
      local k = KEYS[1]
      local finalized = redis.call('HGET', k, '${REDIS_FIELDS.FINALIZED}')
      if finalized == '1' then return 0 end
      local enq = tonumber(redis.call('HGET', k, '${REDIS_FIELDS.ENQUEUED}') or '0')
      local done = tonumber(redis.call('HGET', k, '${REDIS_FIELDS.DONE}') or '0')
      local limit = tonumber(ARGV[2]) or 0
      local enqueuing = tonumber(redis.call('HGET', k, '${REDIS_FIELDS.ENQUEUING}') or '0')
      -- Finalize policy:
      -- 1) Reached the explicit limit (done >= limit and limit > 0) — terminate proactively
      -- 2) Or queue drained (all enqueued processed) AND no active enqueuers
      local reached_limit = (limit > 0 and done >= limit)
      local queue_drained = (enq > 0 and done == enq and enqueuing == 0)
      if reached_limit or queue_drained then
        redis.call('HSET', k, '${REDIS_FIELDS.FINALIZED}', '1')
        redis.call('HSET', k, '${REDIS_FIELDS.FINISHED_AT}', ARGV[1])
        return 1
      end
      return 0
    `;
        const finalized = await this.redis.eval(
            script,
            1,
            key,
            now,
            String(finalizeTarget ?? 0)
        );

        if (Number(finalized) === 1) {
            // Read summary fields for reporting
            const fields = await this.redis.hgetall(key);
            const total = Number(fields[REDIS_FIELDS.ENQUEUED] ?? 0);
            const succeeded = Number(fields[REDIS_FIELDS.SUCCEEDED] ?? 0);
            const failed = Number(fields[REDIS_FIELDS.FAILED] ?? 0);
            const finalSummary = {
                total,
                succeeded,
                failed,
                started_at: fields[REDIS_FIELDS.STARTED_AT],
                finished_at: fields[REDIS_FIELDS.FINISHED_AT],
                ...(summary ?? {}),
            };
            // Mark in BullMQ job data - inline the JobManager functionality to avoid circular dependency
            const { QueueManager } = await import("./Queue.js");
            const job = await QueueManager.getInstance().getJob(queueName as QueueName, jobId);
            if (job) {
                job.updateData({
                    ...job.data,
                    status: "completed",
                    ...finalSummary,
                });

                // Store data in key-value store
                await (await Utils.getInstance().getKeyValueStore()).setValue(jobId, finalSummary);
            }

            // Mark in DB: if no pages succeeded (completed = 0), mark as failed
            try {
                if (succeeded === 0) {
                    // If no pages succeeded, mark job as failed
                    await failedJob(jobId, "No pages were successfully processed", false, { total, completed: succeeded, failed });
                } else {
                    // Mark as completed with success status
                    await completedJob(jobId, true, { total, completed: succeeded, failed });
                }
            } catch {
                // DB not configured or transient error; ignore to not block finalize
            }
            try {
                await BandwidthManager.getInstance().flushJob(jobId);
            } catch {
                // ignore flush errors to avoid blocking finalize
            }
            return true;
        }
        return false;
    }

    /**
     * Mark job as cancelled and finalized immediately.
     * Prevent further enqueueing and allow engines to short-circuit processing.
     */
    async cancel(jobId: string): Promise<void> {
        const key = this.key(jobId);
        const now = new Date().toISOString();
        try {
            await this.redis
                .multi()
                .hset(key, REDIS_FIELDS.CANCELLED, '1')
                .hset(key, REDIS_FIELDS.FINALIZED, '1')
                .hset(key, REDIS_FIELDS.FINISHED_AT, now)
                .exec();
        } catch {
            // ignore
        }
    }

    /**
     * Check if a job should be finalized based on limit and current progress
     * This method can be called periodically to ensure jobs don't hang
     */
    async checkAndFinalizeByLimit(jobId: string, queueName: string, limit: number): Promise<boolean> {
        try {
            const [done, finalized, cancelled] = await Promise.all([
                this.getDone(jobId),
                this.isFinalized(jobId),
                this.isCancelled(jobId)
            ]);

            // If already finalized or cancelled, no action needed
            if (finalized || cancelled) {
                return false;
            }

            // If we've reached the limit, try to finalize
            if (limit > 0 && done >= limit) {
                log.info(`[${queueName}] [${jobId}] Limit reached (${done}/${limit}), attempting to finalize job`);
                const finalizeResult = await this.tryFinalize(jobId, queueName, {}, limit);
                if (finalizeResult) {
                    log.info(`[${queueName}] [${jobId}] Job finalized successfully by limit check`);
                }
                return finalizeResult;
            }

            return false;
        } catch (error) {
            log.error(`[${queueName}] [${jobId}] Error in checkAndFinalizeByLimit: ${error}`);
            return false;
        }
    }
}

