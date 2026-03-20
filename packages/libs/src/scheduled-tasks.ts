/**
 * Scheduled Tasks Limit Utilities
 */

import { config } from "./config.js";

export type SubscriptionTier = "free" | "paid" | string;

/** @deprecated Use `config.scheduler.limitEnabled` instead. */
export function isScheduledTasksLimitEnabled(): boolean {
    return config.scheduler.limitEnabled;
}

/** @deprecated Use `config.scheduler.limitFree` / `config.scheduler.limitPaid` instead. */
export function getScheduledTasksLimit(tier: SubscriptionTier): number {
    return tier === "free" ? config.scheduler.limitFree : config.scheduler.limitPaid;
}

/**
 * Build the limit exceeded error response
 */
export function buildLimitExceededResponse(tier: string, limit: number, currentCount: number) {
    return {
        success: false,
        error: "Scheduled tasks limit reached",
        message: `Maximum ${limit} scheduled task(s) allowed for ${tier} tier.`,
        current_count: currentCount,
        limit: limit,
    };
}

/**
 * Build the auto-pause reason message
 */
export function buildAutoPauseReason(limit: number): string {
    return `Auto-paused: Subscription limit exceeded (limit: ${limit})`;
}
