import { Response } from "express";
import { z } from "zod";
import { scrapeSchema, RequestWithAuth, CreditCalculator } from "@anycrawl/libs";
import { QueueManager, CrawlerErrorType, AVAILABLE_ENGINES } from "@anycrawl/scrape";
import { STATUS, createJob, failedJob } from "@anycrawl/db";
import { log } from "@anycrawl/libs";
import { TemplateHandler, TemplateVariableMapper } from "../../utils/templateHandler.js";
import { validateTemplateOnlyFields } from "../../utils/templateValidator.js";
import { renderUrlTemplate } from "../../utils/urlTemplate.js";
export class ScrapeController {
    public handle = async (req: RequestWithAuth, res: Response): Promise<void> => {
        let jobId: string | null = null;
        let engineName: string | null = null;
        let defaultPrice: number = 0;
        try {
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
            // waiting job done
            const job = await QueueManager.getInstance().waitJobDone(`scrape-${engineName}`, jobId, jobPayload.options.timeout || 60_000);
            const { uniqueKey, queueName, options, engine, ...jobData } = job;
            // for failed job to cancel the job in the queue
            // Check if job failed
            if (job.status === 'failed' || job.error) {
                const message = job.message || "The scraping task could not be completed";
                await QueueManager.getInstance().cancelJob(`scrape-${engineName}`, jobId);
                await failedJob(jobId, message, false, { total: 1, completed: 0, failed: 1 });
                // Ensure no credits are deducted for failed scrape
                req.creditsUsed = 0;
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
            req.creditsUsed = defaultPrice + CreditCalculator.calculateScrapeCredits({
                proxy: scrapeOptions.proxy,
                json_options: scrapeOptions.json_options,
                formats: scrapeOptions.formats,
                extract_source: scrapeOptions.extract_source,
            });

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
