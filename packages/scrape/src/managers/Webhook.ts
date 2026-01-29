import crypto from "crypto";
import axios from "axios";
import { log } from "crawlee";
import { getDB, schemas, eq, sql } from "@anycrawl/db";
import { QueueManager } from "./Queue.js";
import { WorkerManager } from "./Worker.js";
import { randomUUID } from "crypto";

// Helper function to check if URL points to a private IP
function isPrivateIP(url: string): boolean {
    try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname;

        // Check for localhost
        if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
            return true;
        }

        // Check for private IP ranges (IPv4)
        const privateRanges = [
            /^10\./,                    // 10.0.0.0/8
            /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // 172.16.0.0/12
            /^192\.168\./,              // 192.168.0.0/16
            /^169\.254\./,              // 169.254.0.0/16 (link-local)
        ];

        for (const range of privateRanges) {
            if (range.test(hostname)) {
                return true;
            }
        }

        // Check for private IPv6 ranges
        if (hostname.includes(":")) {
            if (hostname.startsWith("fe80:") || hostname.startsWith("fc") || hostname.startsWith("fd")) {
                return true;
            }
        }

        return false;
    } catch (error) {
        // If URL parsing fails, treat as potentially unsafe
        return true;
    }
}

export class WebhookManager {
    private static instance: WebhookManager;
    private readonly WEBHOOK_QUEUE = "webhooks";
    private retryProcessorInterval: NodeJS.Timeout | null = null;

    private constructor() {}

    public static getInstance(): WebhookManager {
        if (!WebhookManager.instance) {
            WebhookManager.instance = new WebhookManager();
        }
        return WebhookManager.instance;
    }

    public async initialize(): Promise<void> {
        log.info("[WEBHOOK] 🔔 Initializing Webhook Manager...");

        // Create webhook delivery queue
        const queueManager = QueueManager.getInstance();
        queueManager.getQueue(this.WEBHOOK_QUEUE);

        // Start webhook delivery worker
        const workerManager = WorkerManager.getInstance();
        await workerManager.getWorker(
            this.WEBHOOK_QUEUE,
            async (job) => {
                await this.deliverWebhook(job.data.deliveryId);
            }
        );

        // Start retry processor (check every 30 seconds for pending retries)
        this.startRetryProcessor();

        log.info("[WEBHOOK] ✅ Webhook Manager initialized successfully");
    }

    public async triggerEvent(
        eventType: string,
        payload: any,
        eventSource: string,
        eventSourceId: string,
        userId?: string
    ): Promise<void> {
        const db = await getDB();

        try {
            // Find all active subscriptions for this event type
            const subscriptions = await db
                .select()
                .from(schemas.webhookSubscriptions)
                .where(
                    sql`${schemas.webhookSubscriptions.isActive} = true
                        AND ${schemas.webhookSubscriptions.eventTypes}::jsonb @> ${JSON.stringify([eventType])}`
                );

            log.debug(`[WEBHOOK] Found ${subscriptions.length} webhook subscriptions for event ${eventType}`);

            for (const subscription of subscriptions) {
                // Filter by userId if provided
                if (userId && subscription.userId !== userId) {
                    continue;
                }

                // Filter by scope
                if (subscription.scope !== "all" && subscription.specificTaskIds) {
                    const taskIds = subscription.specificTaskIds as string[];
                    if (!taskIds.includes(eventSourceId)) {
                        continue;
                    }
                }

                await this.enqueueDelivery(subscription, eventType, payload, eventSource, eventSourceId);
            }
        } catch (error) {
            log.error(`[WEBHOOK] Failed to trigger webhook event ${eventType}: ${error}`);
        }
    }

    private async enqueueDelivery(
        subscription: any,
        eventType: string,
        payload: any,
        eventSource: string,
        eventSourceId: string
    ): Promise<void> {
        const db = await getDB();

        try {
            // Create delivery record
            const deliveryUuid = randomUUID();
            await db.insert(schemas.webhookDeliveries).values({
                uuid: deliveryUuid,
                webhookSubscriptionUuid: subscription.uuid,
                eventType: eventType,
                eventSource: eventSource,
                eventSourceId: eventSourceId,
                status: "pending",
                attemptNumber: 1,
                maxAttempts: subscription.maxRetries || 3,
                requestUrl: subscription.webhookUrl,
                requestMethod: "POST",
                requestHeaders: subscription.customHeaders || {},
                requestBody: payload,
                createdAt: new Date(),
            });

            // Enqueue for delivery
            const queueManager = QueueManager.getInstance();
            const queue = queueManager.getQueue(this.WEBHOOK_QUEUE);
            await queue.add(
                "webhook-delivery",
                { deliveryId: deliveryUuid },
                { jobId: deliveryUuid }
            );

            log.debug(`[WEBHOOK] Enqueued webhook delivery ${deliveryUuid} for event ${eventType}`);
        } catch (error) {
            log.error(`[WEBHOOK] Failed to enqueue webhook delivery: ${error}`);
        }
    }

    private async deliverWebhook(deliveryId: string): Promise<void> {
        const db = await getDB();

        try {
            const delivery = await db
                .select()
                .from(schemas.webhookDeliveries)
                .where(eq(schemas.webhookDeliveries.uuid, deliveryId))
                .limit(1);

            if (!delivery.length) {
                log.error(`[WEBHOOK] Delivery ${deliveryId} not found`);
                return;
            }

            const deliveryRecord = delivery[0];

            const subscription = await db
                .select()
                .from(schemas.webhookSubscriptions)
                .where(eq(schemas.webhookSubscriptions.uuid, deliveryRecord.webhookSubscriptionUuid))
                .limit(1);

            if (!subscription.length || !subscription[0].isActive) {
                log.info(`[WEBHOOK] Subscription inactive, skipping delivery ${deliveryId}`);
                return;
            }

            const sub = subscription[0];

            // Check for private IP protection (unless explicitly allowed)
            const allowLocalWebhooks = process.env.ALLOW_LOCAL_WEBHOOKS === "true";
            if (!allowLocalWebhooks && isPrivateIP(deliveryRecord.requestUrl)) {
                const errorMsg = "Webhook delivery blocked: Private IP addresses are not allowed";
                log.warning(`[WEBHOOK] ${errorMsg} - URL: ${deliveryRecord.requestUrl}`);

                await db
                    .update(schemas.webhookDeliveries)
                    .set({
                        status: "failed",
                        errorMessage: errorMsg,
                        errorCode: "PRIVATE_IP_BLOCKED",
                    })
                    .where(eq(schemas.webhookDeliveries.uuid, deliveryId));

                return;
            }

            // Generate HMAC signature
            const signature = this.generateSignature(deliveryRecord.requestBody, sub.webhookSecret);

            // Prepare headers
            const headers = {
                "Content-Type": "application/json",
                "X-AnyCrawl-Signature": signature,
                "X-Webhook-Event": deliveryRecord.eventType,
                "X-Webhook-Delivery-Id": deliveryId,
                "X-Webhook-Timestamp": new Date().toISOString(),
                ...(deliveryRecord.requestHeaders || {}),
                ...(sub.customHeaders || {}),
            };

            const startTime = Date.now();

            try {
                // Send webhook
                const response = await axios({
                    method: deliveryRecord.requestMethod,
                    url: deliveryRecord.requestUrl,
                    headers: headers,
                    data: deliveryRecord.requestBody,
                    timeout: (sub.timeoutSeconds || 10) * 1000,
                    validateStatus: (status) => status >= 200 && status < 300,
                });

                const duration = Date.now() - startTime;

                // Mark as delivered
                await db
                    .update(schemas.webhookDeliveries)
                    .set({
                        status: "delivered",
                        responseStatus: response.status,
                        responseHeaders: response.headers as any,
                        responseBody: JSON.stringify(response.data).substring(0, 1000),
                        responseDurationMs: duration,
                        deliveredAt: new Date(),
                    })
                    .where(eq(schemas.webhookDeliveries.uuid, deliveryId));

                // Update subscription stats
                await db
                    .update(schemas.webhookSubscriptions)
                    .set({
                        lastSuccessAt: new Date(),
                        consecutiveFailures: 0,
                        totalDeliveries: sql`${schemas.webhookSubscriptions.totalDeliveries} + 1`,
                        successfulDeliveries: sql`${schemas.webhookSubscriptions.successfulDeliveries} + 1`,
                    })
                    .where(eq(schemas.webhookSubscriptions.uuid, sub.uuid));

                log.info(`[WEBHOOK] ✅ Webhook delivered: ${deliveryId} to ${sub.webhookUrl} (${duration}ms)`);
            } catch (error: any) {
                const duration = Date.now() - startTime;
                await this.handleDeliveryFailure(deliveryRecord, sub, error, duration);
            }
        } catch (error) {
            log.error(`[WEBHOOK] Failed to process webhook delivery ${deliveryId}: ${error}`);
        }
    }

    private async handleDeliveryFailure(
        delivery: any,
        subscription: any,
        error: any,
        duration: number
    ): Promise<void> {
        const db = await getDB();

        const errorMessage = error instanceof Error ? error.message : String(error);
        const responseStatus = error.response?.status;
        const responseHeaders = error.response?.headers;
        const responseBody = error.response?.data
            ? JSON.stringify(error.response.data).substring(0, 1000)
            : null;

        log.warning(`[WEBHOOK] Webhook delivery failed: ${delivery.uuid} - ${errorMessage}`);

        if (delivery.attemptNumber < delivery.maxAttempts) {
            // Calculate next retry time with exponential backoff
            const backoffMultiplier = subscription.retryBackoffMultiplier || 2;
            const backoffMs = Math.pow(backoffMultiplier, delivery.attemptNumber) * 60000; // Base: 1 minute
            const nextRetryAt = new Date(Date.now() + backoffMs);

            await db
                .update(schemas.webhookDeliveries)
                .set({
                    status: "retrying",
                    attemptNumber: delivery.attemptNumber + 1,
                    errorMessage: errorMessage,
                    responseStatus: responseStatus,
                    responseHeaders: responseHeaders as any,
                    responseBody: responseBody,
                    responseDurationMs: duration,
                    nextRetryAt: nextRetryAt,
                })
                .where(eq(schemas.webhookDeliveries.uuid, delivery.uuid));

            log.info(
                `[WEBHOOK] Webhook delivery ${delivery.uuid} will retry (attempt ${delivery.attemptNumber + 1}/${delivery.maxAttempts}) at ${nextRetryAt.toISOString()}`
            );
        } else {
            // Max attempts reached - mark as failed
            await db
                .update(schemas.webhookDeliveries)
                .set({
                    status: "failed",
                    errorMessage: errorMessage,
                    responseStatus: responseStatus,
                    responseHeaders: responseHeaders as any,
                    responseBody: responseBody,
                    responseDurationMs: duration,
                })
                .where(eq(schemas.webhookDeliveries.uuid, delivery.uuid));

            // Increment subscription failure count
            await db
                .update(schemas.webhookSubscriptions)
                .set({
                    lastFailureAt: new Date(),
                    consecutiveFailures: sql`${schemas.webhookSubscriptions.consecutiveFailures} + 1`,
                    totalDeliveries: sql`${schemas.webhookSubscriptions.totalDeliveries} + 1`,
                    failedDeliveries: sql`${schemas.webhookSubscriptions.failedDeliveries} + 1`,
                })
                .where(eq(schemas.webhookSubscriptions.uuid, subscription.uuid));

            // Check if we should auto-disable
            const updatedSub = await db
                .select()
                .from(schemas.webhookSubscriptions)
                .where(eq(schemas.webhookSubscriptions.uuid, subscription.uuid))
                .limit(1);

            if (
                updatedSub[0] &&
                updatedSub[0].consecutiveFailures >= updatedSub[0].autoDisableAfterFailures
            ) {
                await db
                    .update(schemas.webhookSubscriptions)
                    .set({ isActive: false })
                    .where(eq(schemas.webhookSubscriptions.uuid, subscription.uuid));

                log.warning(
                    `[WEBHOOK] Webhook subscription ${subscription.uuid} auto-disabled after ${updatedSub[0].consecutiveFailures} consecutive failures`
                );
            }

            log.error(`[WEBHOOK] Webhook delivery permanently failed: ${delivery.uuid}`);
        }
    }

    private generateSignature(payload: any, secret: string): string {
        const hmac = crypto.createHmac("sha256", secret);
        hmac.update(JSON.stringify(payload));
        return `sha256=${hmac.digest("hex")}`;
    }

    private startRetryProcessor(): void {
        // Check for pending retries every 30 seconds
        this.retryProcessorInterval = setInterval(async () => {
            try {
                const db = await getDB();

                // Find deliveries due for retry
                const retries = await db
                    .select()
                    .from(schemas.webhookDeliveries)
                    .where(
                        sql`${schemas.webhookDeliveries.status} = 'retrying'
                            AND ${schemas.webhookDeliveries.nextRetryAt} <= NOW()`
                    )
                    .limit(100);

                if (retries.length > 0) {
                    log.debug(`[WEBHOOK] Processing ${retries.length} pending webhook retries`);
                }

                for (const retry of retries) {
                    // Re-enqueue for delivery
                    const queueManager = QueueManager.getInstance();
                    const queue = queueManager.getQueue(this.WEBHOOK_QUEUE);
                    await queue.add(
                        "webhook-delivery",
                        { deliveryId: retry.uuid },
                        { jobId: `${retry.uuid}-retry-${retry.attemptNumber}` }
                    );

                    // Update status to pending to prevent duplicate processing
                    await db
                        .update(schemas.webhookDeliveries)
                        .set({ status: "pending" })
                        .where(eq(schemas.webhookDeliveries.uuid, retry.uuid));
                }
            } catch (error) {
                log.error(`[WEBHOOK] Retry processor error: ${error}`);
            }
        }, 30000);

        // Avoid keeping the process alive solely for retry processing
        this.retryProcessorInterval.unref?.();
    }

    public async stop(): Promise<void> {
        log.info("[WEBHOOK] Stopping Webhook Manager...");

        if (this.retryProcessorInterval) {
            clearInterval(this.retryProcessorInterval);
            this.retryProcessorInterval = null;
        }

        log.info("[WEBHOOK] ✅ Webhook Manager stopped successfully");
    }
}
