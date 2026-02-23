import { Response, NextFunction } from "express";
import { Billing } from "@anycrawl/db";
import { RequestWithAuth, type BillingChargeDetailsV1, type BillingMode } from "@anycrawl/libs";
import { log } from "@anycrawl/libs/log";

// Routes that should not trigger credit deduction
const ignoreDeductRoutes: string[] = [];

// Retry configuration
const MAX_RETRY_ATTEMPTS = 3;
const INITIAL_RETRY_DELAY_MS = 1000; // 1 second
const BACKOFF_MULTIPLIER = 2;
const CRAWL_CREATE_ROUTE = { method: "POST", path: "/v1/crawl" };

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

    // Register finish event handler to deduct credits
    res.on("finish", () => {
        if (ignoreDeductRoutes.includes(req.path) || ignoreDeductRoutes.includes(req.route?.path)) {
            return;
        }

        // Only deduct credits for successful requests with positive credit usage
        if (res.statusCode >= 200 && res.statusCode < 400 && req.creditsUsed && req.creditsUsed > 0) {
            const jobId = req.jobId;
            if (!jobId) {
                log.warning(`[${req.method}] [${req.path}] Skip deduction: missing jobId`);
                return;
            }

            const mode: BillingMode = isCrawlCreateRequest(req.method, req.path, req.route?.path) ? "delta" : "target";
            log.info(`[${req.method}] [${req.path}] [${jobId}] Deducting ${req.creditsUsed} credits (mode=${mode})`);
            deductCreditsWithRetry(jobId, req.creditsUsed, mode, req.billingChargeDetails).catch(error => {
                log.error(`[${req.method}] [${req.path}] [${jobId}] Final deduction failure: ${error}`);
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
    jobId: string,
    creditsUsed: number,
    mode: BillingMode,
    chargeDetails?: BillingChargeDetailsV1,
): Promise<void> {
    let lastError: Error | unknown;

    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
        try {
            await deductCreditsAsync(jobId, creditsUsed, mode, chargeDetails);
            return; // Success, exit retry loop
        } catch (error) {
            lastError = error;
            log.warning(`[${jobId}] Deduction attempt ${attempt}/${MAX_RETRY_ATTEMPTS} failed: ${error}`);

            if (attempt < MAX_RETRY_ATTEMPTS) {
                const delayMs = INITIAL_RETRY_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, attempt - 1);
                log.info(`[${jobId}] Retrying in ${delayMs}ms...`);
                await sleep(delayMs);
            }
        }
    }

    // All retries exhausted - log error (deductedAt remains null for failed deductions)
    log.error(`[${jobId}] Deduction failed after ${MAX_RETRY_ATTEMPTS} attempts`);
    throw lastError;
}

/**
 * Asynchronously deduct credits without blocking the response
 * Updates apiKey credits and sets deductedAt timestamp on job
 */
async function deductCreditsAsync(
    jobId: string,
    creditsUsed: number,
    mode: BillingMode,
    chargeDetails?: BillingChargeDetailsV1,
): Promise<void> {
    if (mode === "delta") {
        const params: {
            jobId: string;
            delta: number;
            reason: string;
            idempotencyKey: string;
            chargeDetails?: BillingChargeDetailsV1;
        } = {
            jobId,
            delta: creditsUsed,
            reason: "api_crawl_initial",
            idempotencyKey: `api:crawl-initial:${jobId}`,
        };
        if (chargeDetails) {
            params.chargeDetails = chargeDetails;
        }
        const result = await Billing.chargeDeltaByJobId(params);
        if (typeof result.remainingCredits === "number") {
            log.info(`[${jobId}] Deduction completed (delta): -${result.charged} credits, remaining: ${result.remainingCredits}`);
        } else {
            log.info(`[${jobId}] Deduction completed (delta): -${result.charged} credits`);
        }
        return;
    }

    const params: {
        jobId: string;
        targetUsed: number;
        reason: string;
        idempotencyKey: string;
        chargeDetails?: BillingChargeDetailsV1;
    } = {
        jobId,
        targetUsed: creditsUsed,
        reason: "api_request_finalize",
        idempotencyKey: `api:request-finalize:${jobId}:${creditsUsed}`,
    };
    if (chargeDetails) {
        params.chargeDetails = chargeDetails;
    }
    const result = await Billing.chargeToUsedByJobId(params);
    if (typeof result.remainingCredits === "number") {
        log.info(`[${jobId}] Deduction completed (target): -${result.charged} credits, remaining: ${result.remainingCredits}`);
    } else {
        log.info(`[${jobId}] Deduction completed (target): -${result.charged} credits`);
    }
}

function isCrawlCreateRequest(method: string, path: string, routePath?: string): boolean {
    const normalize = (value: string | undefined): string => {
        if (!value) return "";
        return value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
    };

    const normalizedPath = normalize(path);
    const normalizedRoutePath = normalize(routePath);
    return method === CRAWL_CREATE_ROUTE.method
        && (normalizedPath === CRAWL_CREATE_ROUTE.path || normalizedRoutePath === CRAWL_CREATE_ROUTE.path);
}
