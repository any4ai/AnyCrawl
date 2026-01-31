import { Response } from "express";
import { z } from "zod";
import { SearchService } from "@anycrawl/search/SearchService";
import { log } from "@anycrawl/libs/log";
import { searchSchema, RequestWithAuth, CreditCalculator } from "@anycrawl/libs";
import { randomUUID } from "crypto";
import { STATUS, createJob, insertJobResult, completedJob, failedJob, updateJobCounts, JOB_RESULT_STATUS } from "@anycrawl/db";
import { QueueManager } from "@anycrawl/scrape";
import { TemplateHandler, TemplateVariableMapper } from "../../utils/templateHandler.js";
import { validateTemplateOnlyFields } from "../../utils/templateValidator.js";
import { renderTextTemplate } from "../../utils/urlTemplate.js";
export class SearchController {
    private searchService: SearchService;

    constructor() {
        this.searchService = new SearchService({
            defaultEngine: process.env.ANYCRAWL_SEARCH_DEFAULT_ENGINE,
            enabledEngines: process.env.ANYCRAWL_SEARCH_ENABLED_ENGINES?.split(',').map(e => e.trim()),
            searxngUrl: process.env.ANYCRAWL_SEARXNG_URL,
            acEngineUrl: process.env.ANYCRAWL_AC_ENGINE_URL,
        });
        log.info("SearchController initialized");
    }

    public handle = async (req: RequestWithAuth, res: Response): Promise<void> => {
        let searchJobId: string | null = null;
        let engineName: string | null = null;
        let defaultPrice: number = 0;
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

                // Remove template field before schema validation (schemas use strict mode)
                delete requestData.template;
            }

            // Render query template (filters treated as raw for search)
            try {
                if (requestData && typeof requestData.query === "string") {
                    requestData.query = renderTextTemplate(requestData.query, requestData.variables);
                }
            } catch { /* ignore render errors; schema will validate later */ }

            // Validate and parse the merged data
            const validatedData = searchSchema.parse(requestData);

            // Get actual engine name that will be used (resolved by SearchService)
            engineName = this.searchService.resolveEngine(validatedData.engine);

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

            const expectedPages = validatedData.pages || 1;
            let pagesProcessed = 0;
            let failedPages = 0;
            let successPages = 0;

            let scrapeJobIds: string[] = [];
            const scrapeJobCreationPromises: Promise<void>[] = [];
            const scrapeCompletionPromises: Promise<{ url: string; data: any }>[] = [];
            let completedScrapeCount = 0;
            let totalScrapeCount = 0; // Track total scrape tasks
            // Global scrape limit control (if limit provided)
            const shouldLimitScrape = typeof validatedData.limit === 'number' && validatedData.limit > 0;
            let remainingScrape = shouldLimitScrape ? (validatedData.limit as number) : Number.POSITIVE_INFINITY;

            const results = await this.searchService.search(validatedData.engine, {
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
                        if (validatedData.scrape_options) {
                            const scrapeOptions = validatedData.scrape_options;
                            const engineForScrape = scrapeOptions.engine!;
                            // Respect global limit across pages
                            const allowedCount = Math.max(0, Math.min(pageResults.length, remainingScrape));
                            const toProcess = shouldLimitScrape ? pageResults.slice(0, allowedCount) : pageResults;
                            for (const result of toProcess) {
                                if (!result.url) continue; // Ensure url is a string for RequestTask
                                const resultUrl = result.url as string;
                                // Extract engine from scrapeOptions and pass remaining options
                                const { engine: _engine, ...options } = scrapeOptions;
                                const jobPayload = {
                                    url: resultUrl,
                                    engine: engineForScrape,
                                    options,
                                    // Pass search job ID as parent ID for result recording
                                    parentId: searchJobId,
                                };
                                log.info(`Scrape job payload: ${JSON.stringify(jobPayload)}`);
                                const createTask = (async () => {
                                    const scrapeJobId = await QueueManager.getInstance().addJob(`scrape-${engineForScrape}`, jobPayload);
                                    // Don't create a separate job in the jobs table
                                    // The scrape engine will record results directly to the search job
                                    scrapeJobIds.push(scrapeJobId);
                                    totalScrapeCount++; // Increment total scrape count
                                    // prepare wait-for-completion promise for this job
                                    scrapeCompletionPromises.push((async () => {
                                        const job = await QueueManager.getInstance().waitJobDone(
                                            `scrape-${engineForScrape}`,
                                            scrapeJobId,
                                            scrapeOptions.timeout || 60_000
                                        );
                                        // only merge when status is completed
                                        if (!job || job.status !== 'completed' || job.error) {
                                            return { url: resultUrl, data: null };
                                        }
                                        const { uniqueKey, queueName, options, engine, url: _url, type: _type, status: _status, ...jobData } = job as any;
                                        return { url: resultUrl, data: jobData };
                                    })());
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
            if (scrapeCompletionPromises.length > 0) {
                log.info(`Waiting for ${scrapeCompletionPromises.length} scrape jobs to complete, ${scrapeJobIds.join(", ")}`);
                const completedScrapes = await Promise.all(scrapeCompletionPromises);
                const successfulScrapes = completedScrapes.filter(({ data }) => Boolean(data));
                completedScrapeCount = successfulScrapes.length;
                const urlToScrapeData = new Map<string, any>(successfulScrapes
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
            // Calculate credits using CreditCalculator
            req.creditsUsed = defaultPrice + CreditCalculator.calculateSearchCredits({
                pages: validatedData.pages,
                scrape_options: validatedData.scrape_options,
                completedScrapeCount,
            });

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
                } else {
                    await completedJob(searchJobId, true, { total: finalTotalTasks, completed: finalCompletedTasks, failed: finalFailedTasks });
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
                res.status(500).json({
                    success: false,
                    error: "Internal server error",
                    message: error instanceof Error ? error.message : "Unknown error occurred",
                });
            }
        }
    };
}
