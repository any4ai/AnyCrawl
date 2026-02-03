import { z } from "zod";
import { baseSchema } from "./BaseSchema.js";
import { scrapeSchema } from "./ScrapeSchema.js";

// Crawl specific options
const crawlOptionsSchema = z.object({
    /**
     * Template ID to use for this crawl
     */
    template_id: z.string().optional(),
    /**
     * Paths to exclude from crawling (supports wildcards)
     */
    exclude_paths: z.array(z.string()).optional(),

    /**
     * Paths to include in crawling (supports wildcards)
     * URLs matching these patterns will be visited and links extracted
     */
    include_paths: z.array(z.string()).optional(),

    /**
     * Paths to scrape content from (supports wildcards)
     * Only URLs matching these patterns will have their content extracted and saved
     * If not specified, all included URLs will be scraped (default behavior)
     */
    scrape_paths: z.array(z.string()).optional(),

    /**
     * Maximum depth to crawl from the starting URL
     */
    max_depth: z.number().min(1).max(50).default(10),

    // Protocol          Domain
    // ┌────┐          ┌─────────┐
    // https://example.anycrawl.dev/...
    // │       └─────────────────┤
    // │             Hostname    │
    // │                         │
    // └─────────────────────────┘
    //          Origin
    // strategy for crawling, all, same-domain, same-hostname, same-origin
    strategy: z.enum(["all", "same-domain", "same-hostname", "same-origin"]).default("same-domain"),

    /**
     * Maximum number of pages to crawl
     */
    limit: z.number().min(1).max(50000).default(100)
});
const selectedSchema = baseSchema
    .pick({
        proxy: true,
        formats: true,
        timeout: true,
        wait_for: true,
        wait_for_selector: true,
        include_tags: true,
        exclude_tags: true,
        only_main_content: true,
        json_options: true,
        extract_source: true,
    });
// Extract scrape option fields from baseSchema for reuse (same as ScrapeSchema)
const scrapeOptionsInputSchema = selectedSchema
    .strict();

type ScrapeOptionsInput = z.infer<typeof scrapeOptionsInputSchema>;

const mergedSchema = baseSchema
    .extend({
        // Reuse the strict scrape options input schema for validation
        scrape_options: scrapeOptionsInputSchema.partial().optional(),
    })
    .merge(crawlOptionsSchema);

const transformSchema = (data: z.infer<typeof mergedSchema>) => {
    // Normalize scrape options using scrapeSchema to avoid duplication
    const normalizedScrapeOptions = data.scrape_options
        ? scrapeSchema.parse({
            url: data.url,
            engine: data.engine,
            variables: data.variables,
            // pass through only allowed scrape option fields; defaults are applied by scrapeSchema
            ...(data.scrape_options as Partial<ScrapeOptionsInput>),
        }).options
        : scrapeSchema.parse(data).options;

    return {
        url: data.url,
        engine: data.engine,
        templateVariables: data.variables,
        options: {
            template_id: data.template_id,
            exclude_paths: data.exclude_paths,
            include_paths: data.include_paths,
            scrape_paths: data.scrape_paths,
            max_depth: data.max_depth,
            limit: data.limit,
            strategy: data.strategy,
            scrape_options: normalizedScrapeOptions,
        }
    };
}

// Use the full base schema to inherit all scrape parameters
export const crawlSchema = mergedSchema
    .strict() // Make the entire schema strict to catch unknown fields
    .transform((data) => {
        return transformSchema(data);
    });

export type CrawlSchema = z.infer<typeof crawlSchema>;

export const TemplateCrawlSchema = mergedSchema.partial();

export type TemplateCrawlSchema = z.infer<typeof TemplateCrawlSchema>;

export const CrawlSchemaInput = z.object({
    uuid: z.string().uuid(),
});
export type CrawlSchemaInput = z.input<typeof CrawlSchemaInput>;
