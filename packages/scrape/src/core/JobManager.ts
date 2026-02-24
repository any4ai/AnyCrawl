import { log } from "crawlee";
import { QueueManager, QueueName } from "../managers/Queue.js";
import { Utils } from "../Utils.js";
import { WebhookEventType } from "@anycrawl/libs";
import { getJob } from "@anycrawl/db";

/**
 * Job manager for handling job status updates
 * Separates job management logic from the main engine
 */
export class JobManager {
    /**
     * Mark a job as completed and store the data
     */
    async markCompleted(jobId: string, queueName: QueueName, data: any): Promise<void> {
        const job = await QueueManager.getInstance().getJob(queueName, jobId);

        if (!job) {
            log.error(`[${queueName}] [${jobId}] Job not found in queue`);
            return;
        }

        // Update job status to completed
        job.updateData({
            ...job.data,
            status: "completed",
            ...data,
        });

        // Store data in key-value store
        await (await Utils.getInstance().getKeyValueStore()).setValue(jobId, data);

        // Trigger webhook event for scrape completion
        try {
            const dbJob = await getJob(jobId);
            if (dbJob && process.env.ANYCRAWL_WEBHOOKS_ENABLED === "true") {
                const { WebhookManager } = await import("../managers/Webhook.js");
                await WebhookManager.getInstance().triggerEvent(
                    WebhookEventType.SCRAPE_COMPLETED,
                    {
                        job_id: jobId,
                        url: job.data.url,
                        status: "completed",
                        ...data,
                    },
                    "scrape",
                    jobId,
                    dbJob.userId ?? undefined
                );
            }
        } catch (e) {
            log.warning(`[${queueName}] [${jobId}] Failed to trigger webhook: ${e}`);
        }
    }

    /**
     * Mark a job as failed
     */
    async markFailed(jobId: string, queueName: QueueName, error: string, data?: any): Promise<void> {
        const job = await QueueManager.getInstance().getJob(queueName, jobId);

        if (!job) {
            log.error(`[${queueName}] [${jobId}] Job not found in queue`);
            return;
        }

        // Update job status to failed
        job.updateData({
            ...job.data,
            status: "failed",
            ...data,
        });

        // Trigger webhook event for scrape failure
        try {
            const dbJob = await getJob(jobId);
            if (dbJob && process.env.ANYCRAWL_WEBHOOKS_ENABLED === "true") {
                const { WebhookManager } = await import("../managers/Webhook.js");
                await WebhookManager.getInstance().triggerEvent(
                    WebhookEventType.SCRAPE_FAILED,
                    {
                        job_id: jobId,
                        url: job.data.url,
                        status: "failed",
                        error,
                        ...data,
                    },
                    "scrape",
                    jobId,
                    dbJob.userId ?? undefined
                );
            }
        } catch (e) {
            log.warning(`[${queueName}] [${jobId}] Failed to trigger webhook: ${e}`);
        }
    }
} 