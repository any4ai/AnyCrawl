import { Response } from "express";
import { z } from "zod";
import { SearchService, getSearchConfig } from "@anycrawl/search/SearchService";
import { log } from "@anycrawl/libs/log";
import { searchSchema, scrapeSchema, RequestWithAuth, CreditCalculator, WebhookEventType, estimateTaskCredits, getCacheConfig, appConfig } from "@anycrawl/libs";
import { randomUUID } from "crypto";
import { STATUS, createJob, insertJobResult, completedJob, failedJob, updateJobCounts, updateJobCacheHits, JOB_RESULT_STATUS } from "@anycrawl/db";
import { QueueManager, CacheManager, resolveAutoEngine, type EngineType, type RequestTask } from "@anycrawl/scrape";
import { TemplateHandler, validateVariables, applyVariableDefaults, TemplateVariableMapper } from "../../utils/templateHandler.js";
import { validateTemplateOnlyFields } from "../../utils/templateValidator.js";
import { mergeOptionsWithTemplate } from "../../utils/optionMerger.js";
import { DomainValidator } from "@anycrawl/template-client";
import { renderTextTemplate } from "../../utils/urlTemplate.js";
import { triggerWebhookEvent } from "../../utils/webhookHelper.js";
import {
    SEARCH_SCRAPE_PARTIAL_TIMEOUT_MS,
    collectSettledWithinTimeout,
    resolveSearchFollowUpWaitMs,
} from "../../utils/searchFollowUpTiming.js";

const SEARCH_FOLLOW_UP_SCRAPE_OPTION_KEYS = new Set([
    "template_id",
    "variables",
    "engine",
    "proxy",
    "formats",
    "timeout",
    "wait_until",
    "wait_for",
    "wait_for_selector",
    "include_tags",
    "exclude_tags",
    "only_main_content",
    "json_options",
    "extract_source",
    "ocr_options",
    "max_age",
    "store_in_cache",
]);

function pickSearchFollowUpScrapeOptions(options: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!options || typeof options !== "object") {
        return {};
    }

    const picked: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(options)) {
        if (SEARCH_FOLLOW_UP_SCRAPE_OPTION_KEYS.has(key)) {
            picked[key] = value;
        }
    }
    return picked;
}

function elapsedMs(startTime: number): number {
    return Date.now() - startTime;
}

export class SearchController {
    private searchService: SearchService;

    constructor() {
        this.searchService = new SearchService(getSearchConfig());
        log.info("SearchController initialized");
    }

    public handle = async (req: RequestWithAuth, res: Response): Promise<void> => {
        let searchJobId: string | null = null;
        let engineName: string | null = null;
        let defaultPrice: number = 0;
        const searchStartedAt = Date.now();
        /** Search-template metadata: when false, do not bill scrape template perCall for follow-up scrapes. */
        let chargeScrapeTemplateCreditsForFollowup = true;
        try {
            // Merge template options with request body before parsing
            let requestData = { ...req.body };

            if (requestData.template_id) {
                // Validate: when using template_id, only specific fields are allowed
                if (!validateTemplateOnlyFields(requestData, res, "search")) {
                    return;
                }

                const currentUserId = req.auth?.user ? String(req.auth.user) : undefined;
                requestData = await TemplateHandler.mergeRequestWithTemplate(
                    requestData,
                    "search",
                    currentUserId
                );
                defaultPrice = TemplateHandler.reslovePrice(requestData.template, "credits", "perCall");
                const stMeta = requestData.template?.metadata as { charge_scrape_template_credits?: boolean } | undefined;
                if (stMeta && typeof stMeta.charge_scrape_template_credits === "boolean") {
                    chargeScrapeTemplateCreditsForFollowup = stMeta.charge_scrape_template_credits;
                }

                // Remove template field before schema validation (schemas use strict mode)
                delete requestData.template;
            }

            // Render query template (filters treated as raw for search)
            try {
                if (requestData && typeof requestData.query === "string") {
                    requestData.query = renderTextTemplate(requestData.query, requestData.variables);
                }
            } catch { /* ignore render errors; schema will validate later */ }

            const rawMergedRequestScrapeOptions = pickSearchFollowUpScrapeOptions(
                requestData.scrape_options as Record<string, unknown> | undefined
            );

            // Validate and parse the merged data
            const validatedData = searchSchema.parse(requestData);
            // Get actual engine name that will be used (resolved by SearchService)
            engineName = this.searchService.resolveEngine(validatedData.engine);
            const expectedPages = this.searchService.resolveEffectivePages(engineName, {
                query: validatedData.query,
                limit: validatedData.limit,
                offset: validatedData.offset,
                pages: validatedData.pages,
                lang: validatedData.lang,
                country: validatedData.country,
                timeRange: validatedData.timeRange,
                sources: validatedData.sources,
                safe_search: validatedData.safe_search,
            });

            let mergedSearchScrapeOptions = validatedData.scrape_options;
            let scrapeFollowTemplatePerCall = 0;
            let scrapeFollowDomainRestriction: ReturnType<typeof DomainValidator.parseDomainRestriction> = undefined;

            if (validatedData.scrape_options?.template_id) {
                const uid = req.auth?.user ? String(req.auth.user) : undefined;
                const tr = await TemplateHandler.getTemplateOptions(
                    validatedData.scrape_options.template_id,
                    "scrape",
                    uid
                );
                if (!tr.success || !tr.template || !tr.templateOptions) {
                    res.status(400).json({
                        success: false,
                        error: "Validation error",
                        message: tr.error || "Invalid scrape template for search follow-up",
                    });
                    return;
                }
                try {
                    validateVariables(
                        tr.template.variables,
                        validatedData.scrape_options.variables,
                        validatedData.scrape_options
                    );
                } catch (ve) {
                    res.status(400).json({
                        success: false,
                        error: "Validation error",
                        message: ve instanceof Error ? ve.message : String(ve),
                    });
                    return;
                }
                const variablesWithDefaults = applyVariableDefaults(
                    tr.template.variables,
                    validatedData.scrape_options.variables
                );
                const templateScrapeOptions = pickSearchFollowUpScrapeOptions(
                    tr.templateOptions as Record<string, unknown>
                );
                const rawMappedScrapeOptions = pickSearchFollowUpScrapeOptions(
                    TemplateVariableMapper.mapVariablesToRequestData(
                        variablesWithDefaults,
                        tr.template,
                        rawMergedRequestScrapeOptions
                    )
                );
                const mergedRawScrapeOptions = mergeOptionsWithTemplate(
                    templateScrapeOptions,
                    {
                        ...rawMappedScrapeOptions,
                        ...(variablesWithDefaults !== undefined ? { variables: variablesWithDefaults } : {}),
                    }
                );
                const normalizedMergedSearch = searchSchema.parse({
                    ...validatedData,
                    scrape_options: mergedRawScrapeOptions,
                });
                mergedSearchScrapeOptions = normalizedMergedSearch.scrape_options;
                scrapeFollowTemplatePerCall = TemplateHandler.reslovePrice(tr.template, "credits", "perCall");
                if (!chargeScrapeTemplateCreditsForFollowup) {
                    scrapeFollowTemplatePerCall = 0;
                }
                scrapeFollowDomainRestriction = DomainValidator.parseDomainRestriction(
                    tr.template.metadata?.allowedDomains
                );
            }

            const searchEstimatePayload = {
                ...validatedData,
                pages: expectedPages,
                scrape_options: mergedSearchScrapeOptions ?? validatedData.scrape_options,
            };

            // Pre-check if user has enough credits
            if (req.auth && appConfig.authEnabled && appConfig.creditsEnabled) {
                const userCredits = req.auth.credits;

                // Use estimateTaskCredits for accurate credit estimation
                const estimatedCredits =
                    defaultPrice +
                    estimateTaskCredits("search", searchEstimatePayload, { scrapeFollowTemplatePerCall });

                if (estimatedCredits > userCredits) {
                    res.status(402).json({
                        success: false,
                        error: "Insufficient credits",
                        message: `Estimated credits required (${estimatedCredits}) exceeds available credits (${userCredits}).`,
                        details: {
                            template_credits: defaultPrice,
                            estimated_total: estimatedCredits,
                            available_credits: userCredits,
                        }
                    });
                    return;
                }
            }

            // Create job for search request (pending)
            searchJobId = randomUUID();
            await createJob({
                job_id: searchJobId,
                job_type: "search",
                job_queue_name: `search-${engineName}`,
                url: `search:${validatedData.query}`,
                req,
                status: STATUS.PENDING,
            });
            req.jobId = searchJobId;

            // Trigger search.created webhook
            await triggerWebhookEvent(
                WebhookEventType.SEARCH_CREATED,
                searchJobId,
                {
                    query: validatedData.query,
                    status: "created",
                    engine: engineName,
                },
                "search"
            );

            // Trigger search.started webhook
            await triggerWebhookEvent(
                WebhookEventType.SEARCH_STARTED,
                searchJobId,
                {
                    query: validatedData.query,
                    status: "started",
                },
                "search"
            );

            let pagesProcessed = 0;
            let failedPages = 0;
            let successPages = 0;

            let scrapeJobIds: string[] = [];
            const scrapeJobCreationPromises: Promise<void>[] = [];
            const scrapeCompletionPromises: Promise<{ url: string; data: any }>[] = [];
            const pendingFollowUpScrapes = new Map<string, { queueName: string; url: string }>();
            const autoEnginePromises = new Map<string, Promise<EngineType>>();
            const followUpEngineCounts: Record<string, number> = {};
            const followUpCreationStartedAt = Date.now();
            let followUpFirstEnqueueMs: number | undefined;
            let completedScrapeCount = 0;
            let totalScrapeCount = 0; // Track total scrape tasks
            // Global scrape limit control (if limit provided)
            const shouldLimitScrape = typeof validatedData.limit === 'number' && validatedData.limit > 0;
            let remainingScrape = shouldLimitScrape ? (validatedData.limit as number) : Number.POSITIVE_INFINITY;
            const cachedScrapes: { url: string; data: any }[] = [];
            const cacheConfig = getCacheConfig();
            const cacheManager = CacheManager.getInstance();
            const getAutoEngineForUrl = (url: string, proxy: string | undefined): Promise<EngineType> => {
                let domain: string;
                try {
                    domain = new URL(url).hostname;
                } catch {
                    domain = url;
                }
                const cacheKey = `${proxy ?? ""}:${domain}`;
                let promise = autoEnginePromises.get(cacheKey);
                if (!promise) {
                    promise = resolveAutoEngine(url, proxy).then((engine) => engine as EngineType);
                    autoEnginePromises.set(cacheKey, promise);
                }
                return promise;
            };

            const results = await this.searchService.search(engineName, {
                query: validatedData.query,
                limit: validatedData.limit,
                offset: validatedData.offset,
                pages: expectedPages,
                lang: validatedData.lang,
                country: validatedData.country,
                timeRange: validatedData.timeRange,
                sources: validatedData.sources,
                safe_search: validatedData.safe_search,
            }, async (page, pageResults, _uniqueKey, success) => {
                try {
                    pagesProcessed += 1;
                    if (!success) {
                        failedPages += 1;
                        // Record a failed page entry (single record per page)
                        await insertJobResult(
                            searchJobId!,
                            `search:${engineName}:${validatedData.query}:page:${page}`,
                            { page, query: validatedData.query, results: [] },
                            JOB_RESULT_STATUS.FAILED
                        );
                    } else {
                        if (mergedSearchScrapeOptions) {
                            const scrapeOptions = mergedSearchScrapeOptions;
                            const maxAge = scrapeOptions.max_age;
                            const effectiveMaxAge = maxAge ?? cacheConfig.defaultMaxAge;
                            const shouldCheckCache =
                                cacheConfig.pageCacheEnabled &&
                                (maxAge === undefined || maxAge > 0) &&
                                !scrapeOptions.template_id;
                            // Respect global limit across pages
                            const allowedCount = Math.max(0, Math.min(pageResults.length, remainingScrape));
                            const toProcess = shouldLimitScrape ? pageResults.slice(0, allowedCount) : pageResults;
                            for (const result of toProcess) {
                                if (!result.url) continue; // Ensure url is a string for RequestTask
                                const resultUrl = result.url as string;
                                if (scrapeFollowDomainRestriction) {
                                    const domainCheck = DomainValidator.validateDomain(
                                        resultUrl,
                                        scrapeFollowDomainRestriction
                                    );
                                    if (!domainCheck.isValid) {
                                        continue;
                                    }
                                }
                                const createTask = (async () => {
                                    try {
                                        const requestedScrapeEngine = scrapeOptions.engine ?? "auto";
                                        const engineForScrape = (requestedScrapeEngine === "auto"
                                            ? await getAutoEngineForUrl(resultUrl, scrapeOptions.proxy)
                                            : requestedScrapeEngine) as EngineType;
                                        followUpEngineCounts[engineForScrape] = (followUpEngineCounts[engineForScrape] ?? 0) + 1;
                                        if (requestedScrapeEngine === "auto") {
                                            log.info(`[SEARCH] Resolved follow-up scrape engine for ${resultUrl}: ${engineForScrape}`);
                                        }
                                        const cacheOptions = {
                                            engine: engineForScrape,
                                            formats: scrapeOptions.formats,
                                            json_options: scrapeOptions.json_options,
                                            include_tags: scrapeOptions.include_tags,
                                            exclude_tags: scrapeOptions.exclude_tags,
                                            proxy: scrapeOptions.proxy,
                                            only_main_content: scrapeOptions.only_main_content,
                                            extract_source: scrapeOptions.extract_source,
                                            ocr_options: scrapeOptions.ocr_options,
                                            wait_for: scrapeOptions.wait_for,
                                            wait_until: scrapeOptions.wait_until,
                                            wait_for_selector: scrapeOptions.wait_for_selector,
                                            template_id: scrapeOptions.template_id,
                                            store_in_cache: scrapeOptions.store_in_cache,
                                        };
                                        if (shouldCheckCache) {
                                            try {
                                                const cached = await cacheManager.getFromCache(
                                                    resultUrl,
                                                    { ...cacheOptions, url: resultUrl },
                                                    maxAge
                                                );
                                                if (cached) {
                                                    const cachedData: any = { ...cached, maxAge: effectiveMaxAge };
                                                    if ("fromCache" in cachedData) delete cachedData.fromCache;
                                                    cachedScrapes.push({ url: resultUrl, data: cachedData });
                                                    totalScrapeCount++; // Count cached result as completed scrape
                                                    completedScrapeCount++;
                                                    return;
                                                }
                                            } catch (cacheError) {
                                                log.warning(`[SEARCH] Cache check failed for follow-up scrape ${resultUrl}: ${cacheError instanceof Error ? cacheError.message : String(cacheError)}`);
                                            }
                                        }
                                        const jobPayload = scrapeSchema.parse({
                                            url: resultUrl,
                                            engine: engineForScrape,
                                            template_id: scrapeOptions.template_id,
                                            variables: scrapeOptions.variables,
                                            proxy: scrapeOptions.proxy,
                                            formats: scrapeOptions.formats,
                                            timeout: scrapeOptions.timeout,
                                            wait_for: scrapeOptions.wait_for,
                                            wait_until: scrapeOptions.wait_until,
                                            wait_for_selector: scrapeOptions.wait_for_selector,
                                            include_tags: scrapeOptions.include_tags,
                                            exclude_tags: scrapeOptions.exclude_tags,
                                            only_main_content: scrapeOptions.only_main_content,
                                            json_options: scrapeOptions.json_options,
                                            extract_source: scrapeOptions.extract_source,
                                            ocr_options: scrapeOptions.ocr_options,
                                            max_age: scrapeOptions.max_age,
                                            store_in_cache: scrapeOptions.store_in_cache,
                                        }) as RequestTask & { parentId?: string | null };
                                        jobPayload.parentId = searchJobId;
                                        log.info(
                                            `[SEARCH] Enqueue follow-up scrape url=${resultUrl} queue=scrape-${engineForScrape} requestedEngine=${requestedScrapeEngine} parentJob=${searchJobId}`
                                        );
                                        const scrapeJobId = await QueueManager.getInstance().addJob(`scrape-${engineForScrape}`, jobPayload);
                                        followUpFirstEnqueueMs ??= elapsedMs(followUpCreationStartedAt);
                                        const followUpQueueName = `scrape-${engineForScrape}`;
                                        pendingFollowUpScrapes.set(scrapeJobId, { queueName: followUpQueueName, url: resultUrl });
                                        log.info(`[SEARCH] Enqueued follow-up scrape jobId=${scrapeJobId} queue=scrape-${engineForScrape} url=${resultUrl}`);
                                        // Don't create a separate job in the jobs table
                                        // The scrape engine will record results directly to the search job
                                        scrapeJobIds.push(scrapeJobId);
                                        totalScrapeCount++; // Increment total scrape count
                                        // prepare wait-for-completion promise for this job
                                        scrapeCompletionPromises.push((async () => {
                                            try {
                                                const waitTimeout = resolveSearchFollowUpWaitMs(scrapeOptions.timeout);
                                                const job = await QueueManager.getInstance().waitJobDone(
                                                    followUpQueueName,
                                                    scrapeJobId,
                                                    waitTimeout
                                                );
                                                pendingFollowUpScrapes.delete(scrapeJobId);
                                                // only merge when status is completed
                                                if (!job || job.status !== 'completed' || job.error) {
                                                    return { url: resultUrl, data: null };
                                                }
                                                const { uniqueKey, queueName, options, engine, url: _url, type: _type, status: _status, ...jobData } = job as any;
                                                return { url: resultUrl, data: jobData };
                                            } catch (error) {
                                                const message = error instanceof Error ? error.message : String(error);
                                                log.warning(`[SEARCH] Follow-up scrape did not complete for ${resultUrl}: ${message}`);
                                                try {
                                                    await QueueManager.getInstance().markJobCancelled(
                                                        followUpQueueName,
                                                        scrapeJobId,
                                                        message
                                                    );
                                                    pendingFollowUpScrapes.delete(scrapeJobId);
                                                } catch (cancelError) {
                                                    log.warning(`[SEARCH] Failed to mark follow-up scrape cancelled for ${resultUrl}: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`);
                                                }
                                                return { url: resultUrl, data: null };
                                            }
                                        })());
                                    } catch (error) {
                                        log.warning(
                                            `[SEARCH] Failed to create follow-up scrape for ${resultUrl}: ${error instanceof Error ? error.message : String(error)}`
                                        );
                                    }
                                })();
                                scrapeJobCreationPromises.push(createTask);
                                if (shouldLimitScrape) remainingScrape -= 1;
                                if (remainingScrape <= 0) break;
                            }
                        }
                        successPages += 1;
                        // Insert a single record for this page with aggregated results
                        await insertJobResult(
                            searchJobId!,
                            `search:${engineName}:${validatedData.query}:page:${page}`,
                            { page, query: validatedData.query, results: pageResults },
                            JOB_RESULT_STATUS.SUCCESS
                        );
                    }

                    // Update job counts based on pages for progress (include scrape tasks)
                    const totalTasks = expectedPages + totalScrapeCount;
                    const completedTasks = successPages + completedScrapeCount;
                    const failedTasks = failedPages + (totalScrapeCount - completedScrapeCount);
                    await updateJobCounts(searchJobId!, { total: totalTasks, completed: completedTasks, failed: failedTasks });
                } catch (e) {
                    log.error(`Per-page handler error for job_id=${searchJobId}: ${e instanceof Error ? e.message : String(e)}`);
                }
            });
            // Ensure all scrape jobs have been enqueued before waiting for completion, then enrich results with scrape data
            await Promise.all(scrapeJobCreationPromises);
            if (scrapeCompletionPromises.length > 0 || cachedScrapes.length > 0) {
                let successfulScrapes: { url: string; data: any }[] = [];
                if (scrapeCompletionPromises.length > 0) {
                    log.info(`Waiting for ${scrapeCompletionPromises.length} scrape jobs to complete, ${scrapeJobIds.join(", ")}`);
                    const waitStartedAt = Date.now();
                    const { settled: completedScrapes, timedOut } = await collectSettledWithinTimeout(
                        scrapeCompletionPromises,
                        SEARCH_SCRAPE_PARTIAL_TIMEOUT_MS,
                        (error) => log.warning(`[SEARCH] Follow-up scrape wait failed: ${error instanceof Error ? error.message : String(error)}`)
                    );
                    if (timedOut) {
                        log.warning(
                            `[SEARCH] Returning partial follow-up scrape results: ${completedScrapes.length}/${scrapeCompletionPromises.length} settled within ${SEARCH_SCRAPE_PARTIAL_TIMEOUT_MS}ms`
                        );
                        await Promise.all([...pendingFollowUpScrapes.entries()].map(async ([jobId, pending]) => {
                            try {
                                await QueueManager.getInstance().markJobCancelled(
                                    pending.queueName,
                                    jobId,
                                    `Search enrichment window timed out after ${SEARCH_SCRAPE_PARTIAL_TIMEOUT_MS}ms`
                                );
                            } catch (cancelError) {
                                log.warning(`[SEARCH] Failed to mark timed-out follow-up scrape cancelled for ${pending.url}: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`);
                            }
                        }));
                        pendingFollowUpScrapes.clear();
                    }
                    log.info(`[SEARCH] Follow-up scrape wait completed in ${elapsedMs(waitStartedAt)}ms timedOut=${timedOut}`);
                    successfulScrapes = completedScrapes.filter(({ data }) => Boolean(data));
                }
                const allScrapes = [...cachedScrapes, ...successfulScrapes];
                completedScrapeCount = allScrapes.length;
                if (cachedScrapes.length > 0) {
                    try {
                        await updateJobCacheHits(searchJobId!, cachedScrapes.length);
                    } catch (cacheUpdateError) {
                        log.warning(`[SEARCH] Failed to update cache hits for job_id=${searchJobId}: ${cacheUpdateError}`);
                    }
                }
                const urlToScrapeData = new Map<string, any>(allScrapes
                    .map(({ url, data }) => [url, data])
                );
                for (const r of results as any[]) {
                    if (r && r.url) {
                        const data = urlToScrapeData.get(r.url);
                        if (data) {
                            // Add domain prefix to screenshot paths if they exist
                            if (data.screenshot) {
                                data.screenshot = `${process.env.ANYCRAWL_DOMAIN}/v1/public/storage/file/${data.screenshot}`;
                            }
                            if (data['screenshot@fullPage']) {
                                data['screenshot@fullPage'] = `${process.env.ANYCRAWL_DOMAIN}/v1/public/storage/file/${data['screenshot@fullPage']}`;
                            }
                            Object.assign(r, data);
                        }
                    }
                }
            }
            log.info(
                `[SEARCH] Performance job_id=${searchJobId} search_ms=${elapsedMs(searchStartedAt)} pages_processed=${pagesProcessed}/${expectedPages} ` +
                `followups=${completedScrapeCount}/${totalScrapeCount} cache_hits=${cachedScrapes.length} ` +
                `first_enqueue_ms=${followUpFirstEnqueueMs ?? "n/a"} auto_domains=${autoEnginePromises.size} ` +
                `per_engine=${JSON.stringify(followUpEngineCounts)}`
            );
            // Calculate credits using CreditCalculator
            req.billingChargeDetails = CreditCalculator.buildSearchChargeDetails({
                pages: expectedPages,
                scrape_options: mergedSearchScrapeOptions ?? validatedData.scrape_options,
                completedScrapeCount,
            }, {
                templateCredits: defaultPrice,
                scrapeFollowTemplatePerCall,
            });
            req.creditsUsed = req.billingChargeDetails.total;

            // Mark job status based on page results and scrape tasks
            try {
                const finalTotalTasks = expectedPages + totalScrapeCount;
                const finalCompletedTasks = successPages + completedScrapeCount;
                const finalFailedTasks = failedPages + (totalScrapeCount - completedScrapeCount);

                if (finalFailedTasks >= finalTotalTasks) {
                    await failedJob(
                        searchJobId,
                        `All tasks failed (${finalFailedTasks}/${finalTotalTasks})`,
                        false,
                        { total: finalTotalTasks, completed: finalCompletedTasks, failed: finalFailedTasks }
                    );
                    // Trigger webhook for search failure
                    await triggerWebhookEvent(
                        WebhookEventType.SEARCH_FAILED,
                        searchJobId,
                        {
                            query: validatedData.query,
                            status: "failed",
                            error: `All tasks failed (${finalFailedTasks}/${finalTotalTasks})`,
                            total: finalTotalTasks,
                            completed: finalCompletedTasks,
                            failed: finalFailedTasks,
                        },
                        "search"
                    );
                } else {
                    await completedJob(searchJobId, true, { total: finalTotalTasks, completed: finalCompletedTasks, failed: finalFailedTasks });
                    // Trigger webhook for search completion
                    await triggerWebhookEvent(
                        WebhookEventType.SEARCH_COMPLETED,
                        searchJobId,
                        {
                            query: validatedData.query,
                            status: "completed",
                            total: finalTotalTasks,
                            completed: finalCompletedTasks,
                            failed: finalFailedTasks,
                            results_count: (results as any[]).length,
                        },
                        "search"
                    );
                }
            } catch (e) {
                log.error(`Failed to mark job final status for job_id=${searchJobId}: ${e instanceof Error ? e.message : String(e)}`);
            }
            res.json({
                success: true,
                data: results,
            });
        } catch (error) {
            if (error instanceof z.ZodError) {
                const formattedErrors = error.errors.map((err) => ({
                    field: err.path.join("."),
                    message: err.message,
                    code: err.code,
                }));

                req.creditsUsed = 0;
                req.billingChargeDetails = undefined;
                res.status(400).json({
                    success: false,
                    error: "Validation error",
                    details: {
                        issues: formattedErrors,
                        messages: error.errors.map((err) => err.message),
                    },
                });
            } else {
                if (searchJobId) {
                    try {
                        await failedJob(searchJobId, error instanceof Error ? error.message : "Unknown error", false, { total: 0, completed: 0, failed: 0 });
                    } catch (e) {
                        log.error(`Failed to mark job failed for job_id=${searchJobId}: ${e instanceof Error ? e.message : String(e)}`);
                    }
                }
                req.creditsUsed = 0;
                req.billingChargeDetails = undefined;
                res.status(500).json({
                    success: false,
                    error: "Internal server error",
                    message: error instanceof Error ? error.message : "Unknown error occurred",
                });
            }
        }
    };
}
