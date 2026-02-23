import { Response } from "express";
import { z } from "zod";
import { mapSchema, RequestWithAuth, CreditCalculator, estimateTaskCredits, WebhookEventType } from "@anycrawl/libs";
import { log } from "@anycrawl/libs";
import { MapService } from "@anycrawl/scrape";
import { SearchService } from "@anycrawl/search/SearchService";
import { randomUUID } from "crypto";
import { createJob, completedJob, failedJob, STATUS, updateJobCacheHits } from "@anycrawl/db";
import { triggerWebhookEvent } from "../../utils/webhookHelper.js";

export class MapController {
    private mapService: MapService;
    private searchService: SearchService;

    constructor() {
        this.mapService = new MapService();
        this.searchService = new SearchService({
            defaultEngine: process.env.ANYCRAWL_SEARCH_DEFAULT_ENGINE,
            enabledEngines: process.env.ANYCRAWL_SEARCH_ENABLED_ENGINES?.split(',').map(e => e.trim()),
            searxngUrl: process.env.ANYCRAWL_SEARXNG_URL,
            acEngineUrl: process.env.ANYCRAWL_AC_ENGINE_URL,
        });
        log.info("MapController initialized");
    }

    public map = async (req: RequestWithAuth, res: Response): Promise<void> => {
        let mapJobId: string | null = null;
        try {
            const requestData = { ...req.body };

            // Validate request
            const validatedData = mapSchema.parse(requestData);

            // Pre-check if user has enough credits
            if (req.auth && process.env.ANYCRAWL_API_AUTH_ENABLED === "true" && process.env.ANYCRAWL_API_CREDITS_ENABLED === "true") {
                const userCredits = req.auth.credits;
                const estimatedCredits = estimateTaskCredits('map', validatedData);

                if (estimatedCredits > userCredits) {
                    res.status(402).json({
                        success: false,
                        error: "Insufficient credits",
                        message: `Estimated credits required (${estimatedCredits}) exceeds available credits (${userCredits}).`,
                        details: {
                            estimated_total: estimatedCredits,
                            available_credits: userCredits,
                        }
                    });
                    return;
                }
            }

            // Create job for map request
            mapJobId = randomUUID();
            await createJob({
                job_id: mapJobId,
                job_type: "map",
                job_queue_name: "map",
                url: validatedData.url,
                req,
                status: STATUS.PENDING,
            });
            req.jobId = mapJobId;

            // Trigger map.created webhook
            await triggerWebhookEvent(
                WebhookEventType.MAP_CREATED,
                mapJobId,
                {
                    url: validatedData.url,
                    status: "created",
                    limit: validatedData.limit,
                    include_subdomains: validatedData.include_subdomains,
                    ignore_sitemap: validatedData.ignore_sitemap,
                },
                "map"
            );

            // Trigger map.started webhook
            await triggerWebhookEvent(
                WebhookEventType.MAP_STARTED,
                mapJobId,
                {
                    url: validatedData.url,
                    status: "started",
                },
                "map"
            );

            // Execute map operation (always use search service for site: discovery)
            const result = await this.mapService.map(validatedData.url, {
                limit: validatedData.limit,
                includeSubdomains: validatedData.include_subdomains,
                ignoreSitemap: validatedData.ignore_sitemap,
                searchService: this.searchService,
                maxAge: validatedData.max_age,
                useIndex: validatedData.use_index,
            });
            if (result.fromCache) {
                try {
                    await updateJobCacheHits(mapJobId, 1);
                } catch (cacheUpdateError) {
                    log.warning(`[MapController] Failed to update cache hits for job_id=${mapJobId}: ${cacheUpdateError}`);
                }
            }

            // Calculate credits
            req.billingChargeDetails = CreditCalculator.buildMapChargeDetails();
            req.creditsUsed = req.billingChargeDetails.total;

            // Mark job as completed
            await completedJob(mapJobId, true);

            // Trigger map.completed webhook
            await triggerWebhookEvent(
                WebhookEventType.MAP_COMPLETED,
                mapJobId,
                {
                    url: validatedData.url,
                    status: "completed",
                    total: result.links.length,
                    credits_used: req.creditsUsed,
                },
                "map"
            );

            res.json({
                success: true,
                data: result.links,
            });
        } catch (error) {
            if (error instanceof z.ZodError) {
                const formattedErrors = error.errors.map((err) => ({
                    field: err.path.join("."),
                    message: err.message,
                    code: err.code,
                }));
                const message = error.errors.map((err) => err.message).join(", ");

                req.creditsUsed = 0;
                req.billingChargeDetails = undefined;
                res.status(400).json({
                    success: false,
                    error: "Validation error",
                    message: message,
                    details: {
                        issues: formattedErrors,
                    },
                });
            } else {
                const message = error instanceof Error ? error.message : "Unknown error occurred";
                log.error(`[MapController] Error: ${message}`);

                req.creditsUsed = 0;
                req.billingChargeDetails = undefined;

                // Mark job as failed and trigger webhook
                if (mapJobId) {
                    try {
                        await failedJob(mapJobId, message);
                        await triggerWebhookEvent(
                            WebhookEventType.MAP_FAILED,
                            mapJobId,
                            {
                                url: req.body.url,
                                status: "failed",
                                error_message: message,
                            },
                            "map"
                        );
                    } catch (webhookError) {
                        log.error(`[MapController] Failed to trigger webhook: ${webhookError}`);
                    }
                }

                res.status(500).json({
                    success: false,
                    error: "Internal server error",
                    message: message,
                });
            }
        }
    };
}
