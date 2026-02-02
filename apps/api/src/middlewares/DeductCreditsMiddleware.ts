import { Response, NextFunction } from "express";
import { getDB, schemas, eq, sql } from "@anycrawl/db";
import { RequestWithAuth } from "@anycrawl/libs";
import { log } from "@anycrawl/libs/log";

// Routes that should not trigger credit deduction
const ignoreDeductRoutes: string[] = [];

// Retry configuration
const MAX_RETRY_ATTEMPTS = 3;
const INITIAL_RETRY_DELAY_MS = 1000; // 1 second
const BACKOFF_MULTIPLIER = 2;

/**
 * Middleware to handle credit deduction after successful API requests
 * Credits are deducted asynchronously to avoid blocking the response
 */
export const deductCreditsMiddleware = async (
    req: RequestWithAuth,
    res: Response,
    next: NextFunction
): Promise<void> => {
    // Skip if auth is disabled or credits deduction is disabled
    if (process.env.ANYCRAWL_API_AUTH_ENABLED !== "true" || process.env.ANYCRAWL_API_CREDITS_ENABLED !== "true") {
        next();
        return;
    }

    const userUuid = req.auth?.uuid;

    // Register finish event handler to deduct credits
    res.on("finish", () => {
        if (ignoreDeductRoutes.includes(req.path) || ignoreDeductRoutes.includes(req.route?.path)) {
            return;
        }

        // Only deduct credits for successful requests with positive credit usage
        if (res.statusCode >= 200 && res.statusCode < 400 && req.creditsUsed && req.creditsUsed > 0) {
            log.info(`[${req.method}] [${req.path}] [${userUuid}] Deducting ${req.creditsUsed} credits${req.jobId ? `, jobId: ${req.jobId}` : ""}`);
            deductCreditsWithRetry(userUuid, req.creditsUsed, req.jobId).catch(error => {
                log.error(`[${req.method}] [${req.path}] [${userUuid}] Final deduction failure: ${error}`);
            });
        }
    });

    next();
};

/**
 * Sleep utility for retry delays
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Deduct credits with automatic retry on failure
 * Uses exponential backoff: 1s, 2s, 4s
 */
async function deductCreditsWithRetry(
    userUuid: string | undefined,
    creditsUsed: number,
    jobId?: string
): Promise<void> {
    if (!userUuid) {
        log.warning(`Cannot deduct credits: user UUID not found for jobId: ${jobId || "N/A"}`);
        return;
    }

    let lastError: Error | unknown;

    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
        try {
            await deductCreditsAsync(userUuid, creditsUsed, jobId);
            return; // Success, exit retry loop
        } catch (error) {
            lastError = error;
            log.warning(`[${userUuid}] [${jobId || "N/A"}] Deduction attempt ${attempt}/${MAX_RETRY_ATTEMPTS} failed: ${error}`);

            if (attempt < MAX_RETRY_ATTEMPTS) {
                const delayMs = INITIAL_RETRY_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, attempt - 1);
                log.info(`[${userUuid}] [${jobId || "N/A"}] Retrying in ${delayMs}ms...`);
                await sleep(delayMs);
            }
        }
    }

    // All retries exhausted - log error (deductedAt remains null for failed deductions)
    log.error(`[${userUuid}] [${jobId || "N/A"}] Deduction failed after ${MAX_RETRY_ATTEMPTS} attempts`);
    throw lastError;
}

/**
 * Asynchronously deduct credits without blocking the response
 * Updates apiKey credits and sets deductedAt timestamp on job
 */
async function deductCreditsAsync(
    userUuid: string,
    creditsUsed: number,
    jobId: string | undefined
): Promise<void> {
    const db = await getDB();

    await db.transaction(async (tx: any) => {
        // Update apiKey credits and last_used_at
        await tx
            .update(schemas.apiKey)
            .set({
                credits: sql`${schemas.apiKey.credits} - ${creditsUsed}`,
                lastUsedAt: new Date()
            })
            .where(eq(schemas.apiKey.uuid, userUuid));

        // Update job record with credits and deductedAt timestamp
        if (jobId) {
            await tx.update(schemas.jobs).set({
                creditsUsed: sql`${schemas.jobs.creditsUsed} + ${creditsUsed}`,
                deductedAt: new Date(),
                updatedAt: new Date(),
            }).where(eq(schemas.jobs.jobId, jobId));
        }

        // Log remaining credits for verification
        try {
            const [after] = await tx
                .select({ credits: schemas.apiKey.credits })
                .from(schemas.apiKey)
                .where(eq(schemas.apiKey.uuid, userUuid));

            if (after && typeof after.credits === "number") {
                log.info(`[${userUuid}] [${jobId || "N/A"}] Deduction completed: -${creditsUsed} credits, remaining: ${after.credits}`);
            } else {
                log.info(`[${userUuid}] [${jobId || "N/A"}] Deduction completed: -${creditsUsed} credits`);
            }
        } catch {
            log.info(`[${userUuid}] [${jobId || "N/A"}] Deduction completed: -${creditsUsed} credits`);
        }
    });
}
