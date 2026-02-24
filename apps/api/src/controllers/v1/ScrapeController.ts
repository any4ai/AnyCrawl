import { Response } from "express";
import { z } from "zod";
import { scrapeSchema, RequestWithAuth, CreditCalculator, WebhookEventType, getCacheConfig, getResolvedProxyMode } from "@anycrawl/libs";
import { QueueManager, CrawlerErrorType, CacheManager } from "@anycrawl/scrape";
import { STATUS, createJob, failedJob, completedJob, insertJobResult, updateJobCacheHits } from "@anycrawl/db";
import { log } from "@anycrawl/libs";
import { TemplateHandler, TemplateVariableMapper } from "../../utils/templateHandler.js";
import { validateTemplateOnlyFields } from "../../utils/templateValidator.js";
import { renderUrlTemplate } from "../../utils/urlTemplate.js";
import { triggerWebhookEvent } from "../../utils/webhookHelper.js";
import { randomUUID } from "crypto";
export class ScrapeController {
    public handle = async (req: RequestWithAuth, res: Response): Promise<void> => {
        let jobId: string | null = null;
        let engineName: string | null = null;
        let defaultPrice: number = 0;
        try {
            // Debug raw request params (avoid logging sensitive fields like proxy urls / prompts)
            const rawBody: any = req.body;
            if (rawBody && typeof rawBody === "object") {
                const rawMaxAge = rawBody.max_age;
                const rawMaxAgeCamel = rawBody.maxAge;
                const rawStoreInCache = rawBody.store_in_cache;
                const rawStoreInCacheCamel = rawBody.storeInCache;
                if (Object.prototype.hasOwnProperty.call(rawBody, "maxAge") && !Object.prototype.hasOwnProperty.call(rawBody, "max_age")) {
                    log.warning(`[SCRAPE] Received 'maxAge' (camelCase) but not 'max_age'. API expects snake_case; 'maxAge' will be ignored.`);
                }
                if (Object.prototype.hasOwnProperty.call(rawBody, "storeInCache") && !Object.prototype.hasOwnProperty.call(rawBody, "store_in_cache")) {
                    log.warning(`[SCRAPE] Received 'storeInCache' (camelCase) but not 'store_in_cache'. API expects snake_case; 'storeInCache' will be ignored.`);
                }
                log.debug(
                    `[SCRAPE] Received cache params: max_age=${rawMaxAge} (${typeof rawMaxAge}) maxAge=${rawMaxAgeCamel} (${typeof rawMaxAgeCamel}) store_in_cache=${rawStoreInCache} (${typeof rawStoreInCache}) storeInCache=${rawStoreInCacheCamel} (${typeof rawStoreInCacheCamel})`
                );
                try {
                    log.debug(`[SCRAPE] Received body keys: ${Object.keys(rawBody).sort().join(",")}`);
                } catch { /* ignore */ }
            } else {
                log.debug(`[SCRAPE] Received non-object body type=${typeof rawBody}`);
            }

            // Merge template options with request body before parsing
            let requestData = { ...req.body };

            if (requestData.template_id) {
                // Validate: when using template_id, only specific fields are allowed
                if (!validateTemplateOnlyFields(requestData, res, "scrape")) {
                    return;
                }

                const currentUserId = req.auth?.user ? String(req.auth.user) : undefined;
                requestData = await TemplateHandler.mergeRequestWithTemplate(
                    requestData,
                    "scrape",
                    currentUserId
                );
                defaultPrice = TemplateHandler.reslovePrice(requestData.template, "credits", "perCall");

                // Remove template field before schema validation (schemas use strict mode)
                delete requestData.template;
            }

            // Render URL template with variables before validation
            try {
                if (requestData && typeof requestData.url === "string") {
                    requestData.url = renderUrlTemplate(requestData.url, requestData.variables);
                }
            } catch { /* ignore render errors; schema will validate later */ }

            // Validate and parse the merged data
            const jobPayload = scrapeSchema.parse(requestData);
            engineName = jobPayload.engine;

            // Check cache before creating job (if max_age > 0 or undefined)
            const cacheConfig = getCacheConfig();
            const maxAge = jobPayload.options.max_age;
            const hasTemplate = !!jobPayload.options.template_id;
            const shouldCheckCache = cacheConfig.pageCacheEnabled && !hasTemplate && (maxAge === undefined || maxAge > 0);
            log.debug(`[SCRAPE] Parsed cache params: max_age=${maxAge} store_in_cache=${jobPayload.options.store_in_cache}`);
            log.debug(`[SCRAPE] Cache decision: pageCacheEnabled=${cacheConfig.pageCacheEnabled} hasTemplate=${hasTemplate} shouldCheckCache=${shouldCheckCache}`);

            if (shouldCheckCache) {
                try {
                    const cacheManager = CacheManager.getInstance();
                    const cached = await cacheManager.getFromCache(
                        jobPayload.url,
                        {
                            url: jobPayload.url,
                            engine: jobPayload.engine,
                            formats: jobPayload.options.formats,
                            json_options: jobPayload.options.json_options,
                            include_tags: jobPayload.options.include_tags,
                            exclude_tags: jobPayload.options.exclude_tags,
                            proxy: jobPayload.options.proxy,
                            only_main_content: jobPayload.options.only_main_content,
                            extract_source: jobPayload.options.extract_source,
                            ocr_options: jobPayload.options.ocr_options,
                            wait_for: jobPayload.options.wait_for,
                            wait_until: jobPayload.options.wait_until,
                            wait_for_selector: jobPayload.options.wait_for_selector,
                            template_id: jobPayload.options.template_id,
                            store_in_cache: jobPayload.options.store_in_cache,
                        },
                        maxAge
                    );

                    if (cached) {
                        log.info(`[CACHE] Cache hit for ${jobPayload.url} (cached at ${cached.cachedAt.toISOString()})`);

                        // Calculate credits (cache hit still costs credits)
                        const scrapeOptions = jobPayload.options || {};
                        req.billingChargeDetails = CreditCalculator.buildScrapeChargeDetails({
                            proxy: scrapeOptions.proxy,
                            json_options: scrapeOptions.json_options,
                            formats: scrapeOptions.formats,
                            extract_source: scrapeOptions.extract_source,
                        }, {
                            templateCredits: defaultPrice,
                        });
                        req.creditsUsed = req.billingChargeDetails.total;

                        // Create a synthetic job record for cache hit so credits/webhooks stay consistent
                        const cacheJobId = randomUUID();
                        jobId = cacheJobId;
                        req.jobId = cacheJobId;

                        const cachedAtIso = cached.cachedAt.toISOString();
                        const effectiveMaxAge = maxAge ?? cacheConfig.defaultMaxAge;
                        const jobResultData: any = {
                            ...cached,
                            status: "completed",
                            jobId: cacheJobId,
                            proxy: getResolvedProxyMode(scrapeOptions.proxy),
                            cachedAt: cachedAtIso,
                            maxAge: effectiveMaxAge,
                        };
                        if ("fromCache" in jobResultData) delete jobResultData.fromCache;

                        try {
                            await createJob({
                                job_id: cacheJobId,
                                job_type: "scrape",
                                job_queue_name: `scrape-${engineName}`,
                                url: jobPayload.url,
                                req,
                                status: STATUS.PENDING,
                            });
                            await updateJobCacheHits(cacheJobId, 1);

                            await triggerWebhookEvent(
                                WebhookEventType.SCRAPE_CREATED,
                                cacheJobId,
                                {
                                    url: jobPayload.url,
                                    status: "created",
                                    engine: engineName,
                                },
                                "scrape"
                            );

                            await triggerWebhookEvent(
                                WebhookEventType.SCRAPE_STARTED,
                                cacheJobId,
                                {
                                    url: jobPayload.url,
                                    status: "started",
                                },
                                "scrape"
                            );

                            await insertJobResult(cacheJobId, jobPayload.url, jobResultData);
                            await completedJob(cacheJobId, true, { total: 1, completed: 1, failed: 0 });

                            await triggerWebhookEvent(
                                WebhookEventType.SCRAPE_COMPLETED,
                                cacheJobId,
                                {
                                    url: jobPayload.url,
                                    status: "completed",
                                    ...jobResultData,
                                },
                                "scrape"
                            );
                        } catch (jobError) {
                            log.warning(`[CACHE] Failed to create/record cache-hit job: ${jobError}`);
                        }

                        // Return cached result (match scrape response shape)
                        const responseData: any = { ...jobResultData };
                        if (responseData.screenshot && typeof responseData.screenshot === "string" && !responseData.screenshot.startsWith("http")) {
                            responseData.screenshot = `${process.env.ANYCRAWL_DOMAIN}/v1/public/storage/file/${responseData.screenshot}`;
                        }
                        if (responseData["screenshot@fullPage"] && typeof responseData["screenshot@fullPage"] === "string" && !responseData["screenshot@fullPage"].startsWith("http")) {
                            responseData["screenshot@fullPage"] = `${process.env.ANYCRAWL_DOMAIN}/v1/public/storage/file/${responseData["screenshot@fullPage"]}`;
                        }

                        res.json({ success: true, data: responseData });
                        return;
                    }
                } catch (cacheError) {
                    log.warning(`[CACHE] Error checking cache: ${cacheError}`);
                    // Continue with normal scrape if cache check fails
                }
            }

            jobId = await QueueManager.getInstance().addJob(`scrape-${engineName}`, jobPayload);
            await createJob({
                job_id: jobId,
                job_type: 'scrape',
                job_queue_name: `scrape-${engineName}`,
                url: jobPayload.url,
                req,
                status: STATUS.PENDING,
            });
            // Propagate jobId for downstream middlewares (e.g., credits logging)
            req.jobId = jobId;

            // Trigger scrape.created webhook
            await triggerWebhookEvent(
                WebhookEventType.SCRAPE_CREATED,
                jobId,
                {
                    url: jobPayload.url,
                    status: "created",
                    engine: engineName,
                },
                "scrape"
            );

            // Trigger scrape.started webhook
            await triggerWebhookEvent(
                WebhookEventType.SCRAPE_STARTED,
                jobId,
                {
                    url: jobPayload.url,
                    status: "started",
                },
                "scrape"
            );

            // waiting job done
            const job = await QueueManager.getInstance().waitJobDone(`scrape-${engineName}`, jobId, jobPayload.options.timeout || 60_000);
            const { uniqueKey, queueName, options, engine, ...jobData } = job;
            // for failed job to cancel the job in the queue
            // Check if job failed
            if (job.status === 'failed' || job.error) {
                const message = job.message || "The scraping task could not be completed";
                await QueueManager.getInstance().cancelJob(`scrape-${engineName}`, jobId);
                await failedJob(jobId, message, false, { total: 1, completed: 0, failed: 1 });

                // Trigger scrape.cancelled webhook
                await triggerWebhookEvent(
                    WebhookEventType.SCRAPE_CANCELLED,
                    jobId,
                    {
                        url: jobPayload.url,
                        status: "cancelled",
                        error_message: message,
                    },
                    "scrape"
                );

                // Ensure no credits are deducted for failed scrape
                req.creditsUsed = 0;
                req.billingChargeDetails = undefined;
                res.status(200).json({
                    success: false,
                    error: "Scrape task failed",
                    message: message,
                    data: {
                        ...jobData,
                    }
                });
                return;
            }

            // Calculate credits using CreditCalculator
            const scrapeOptions = (jobPayload as any)?.options || {};
            req.billingChargeDetails = CreditCalculator.buildScrapeChargeDetails({
                proxy: scrapeOptions.proxy,
                json_options: scrapeOptions.json_options,
                formats: scrapeOptions.formats,
                extract_source: scrapeOptions.extract_source,
            }, {
                templateCredits: defaultPrice,
            });
            req.creditsUsed = req.billingChargeDetails.total;

            // Add domain prefix to screenshot path if it exists
            if (jobData.screenshot) {
                jobData.screenshot = `${process.env.ANYCRAWL_DOMAIN}/v1/public/storage/file/${jobData.screenshot}`;
            }

            if (jobData['screenshot@fullPage']) {
                jobData['screenshot@fullPage'] = `${process.env.ANYCRAWL_DOMAIN}/v1/public/storage/file/${jobData['screenshot@fullPage']}`;
            }

            // Job completion is handled in worker/engine; no extra completedJob call here

            res.json({
                success: true,
                data: jobData,
            });
        } catch (error) {
            if (error instanceof z.ZodError) {
                const formattedErrors = error.errors.map((err) => ({
                    field: err.path.join("."),
                    message: err.message,
                    code: err.code,
                }));
                const message = error.errors.map((err) => err.message).join(", ");
                // Ensure no credits are deducted for validation failure
                req.creditsUsed = 0;
                req.billingChargeDetails = undefined;
                res.status(400).json({
                    success: false,
                    error: "Validation error",
                    message: message,
                    data: {
                        type: CrawlerErrorType.VALIDATION_ERROR,
                        issues: formattedErrors,
                        message: message,
                        status: 'failed',
                    },
                });
            } else {
                const message = error instanceof Error ? error.message : "Unknown error occurred";
                if (jobId) {
                    // Best-effort cancel; do not block failed marking if cancel throws
                    try {
                        if (engineName) {
                            await QueueManager.getInstance().cancelJob(`scrape-${engineName}`, jobId);
                        }
                    } catch { /* ignore cancel errors */ }
                    try {
                        await failedJob(jobId, message, false, { total: 1, completed: 0, failed: 1 });
                    } catch { /* ignore DB errors to still return response */ }
                }
                // Ensure no credits are deducted for internal error
                req.creditsUsed = 0;
                req.billingChargeDetails = undefined;
                res.status(500).json({
                    success: false,
                    error: "Internal server error",
                    message: message,
                    data: {
                        type: CrawlerErrorType.INTERNAL_ERROR,
                        message: message,
                        status: 'failed',
                    },
                });
            }
        }
    };
}
