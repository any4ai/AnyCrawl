import { Response } from "express";
import { z } from "zod";
import { mapSchema, RequestWithAuth, CreditCalculator, estimateTaskCredits } from "@anycrawl/libs";
import { log } from "@anycrawl/libs";
import { MapService } from "@anycrawl/scrape";
import { SearchService } from "@anycrawl/search/SearchService";

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

            // Execute map operation (always use search service for site: discovery)
            const result = await this.mapService.map(validatedData.url, {
                limit: validatedData.limit,
                includeSubdomains: validatedData.include_subdomains,
                ignoreSitemap: validatedData.ignore_sitemap,
                searchService: this.searchService,
            });

            // Calculate credits
            req.creditsUsed = CreditCalculator.calculateMapCredits({});

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
                res.status(500).json({
                    success: false,
                    error: "Internal server error",
                    message: message,
                });
            }
        }
    };
}
