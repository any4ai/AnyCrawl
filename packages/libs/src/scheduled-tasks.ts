/**
 * Scheduled Tasks Limit Utilities
 */

export type SubscriptionTier = "free" | "paid" | string;

/**
 * Check if scheduled tasks limit feature is enabled
 */
export function isScheduledTasksLimitEnabled(): boolean {
    return process.env.ANYCRAWL_SCHEDULED_TASKS_LIMIT_ENABLED === "true";
}

/**
 * Get the scheduled tasks limit for a subscription tier
 */
export function getScheduledTasksLimit(tier: SubscriptionTier): number {
    const freeLimit = parseInt(process.env.ANYCRAWL_SCHEDULED_TASKS_LIMIT_FREE || "1");
    const paidLimit = parseInt(process.env.ANYCRAWL_SCHEDULED_TASKS_LIMIT_PAID || "100");

    return tier === "free" ? freeLimit : paidLimit;
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
