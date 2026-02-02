import { log } from "@anycrawl/libs/log";
import { WebhookEventType } from "@anycrawl/libs";
import { getJob } from "@anycrawl/db";
import { WebhookManager } from "@anycrawl/scrape";

/**
 * Helper to trigger webhook events with common error handling
 * Reduces duplication across controllers
 */
export async function triggerWebhookEvent(
    eventType: WebhookEventType,
    jobId: string,
    payload: Record<string, unknown>,
    resourceType: "scrape" | "crawl" | "search" | "task"
): Promise<void> {
    if (process.env.ANYCRAWL_WEBHOOKS_ENABLED !== "true") {
        return;
    }

    try {
        const dbJob = await getJob(jobId);
        if (dbJob) {
            await WebhookManager.getInstance().triggerEvent(
                eventType,
                {
                    job_id: jobId,
                    ...payload,
                },
                resourceType,
                jobId,
                dbJob.userId ?? undefined
            );
        }
    } catch (e) {
        log.error(`Failed to trigger webhook ${eventType} for ${resourceType} ${jobId}: ${e}`);
    }
}
