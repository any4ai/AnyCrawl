import { z } from "zod";
import { ALLOWED_ENGINES, SCRAPE_FORMATS, EXTRACT_SOURCES } from "../constants.js";

export { ALLOWED_ENGINES, SCRAPE_FORMATS, EXTRACT_SOURCES };

// Define the recursive JSON Schema type
export const jsonSchemaType: z.ZodType<any> = z.lazy(() =>
    z.object({
        type: z.enum(["object", "array", "string", "number", "boolean", "null"]),
        // For object schemas
        properties: z.record(jsonSchemaType).optional(),
        required: z.array(z.string()).optional(),
        // For array schemas
        items: z.union([jsonSchemaType, z.array(jsonSchemaType)]).optional(),
        // Helpful hints for LLM extraction
        description: z.string().optional(),
    })
);

// define json options schema
export const jsonOptionsSchema = z.object({
    /**
     * The JSON schema to be used for extracting structured data
     */
    schema: jsonSchemaType.optional(),

    /**
     * The user prompt to be used for extracting structured data
     */
    user_prompt: z.string().optional(),
    schema_name: z.string().optional(),
    schema_description: z.string().optional(),
}).strict();

// define base schema
export const baseSchema = z.object({
    /**
     * Template ID to use for this crawl
     */
    template_id: z.string().optional(),

    /**
     * Template variables - dynamic parameters defined by the template
     */
    variables: z.record(z.any()).optional(),

    /**
     * The URL to be processed
     */
    url: z.string().url(),

    /**
     * The engine to be used
     */
    engine: z.enum(ALLOWED_ENGINES).default("cheerio"),

    /**
     * The proxy mode or custom proxy URL to be used.
     * - "auto": Automatically decide between base and stealth proxy (default)
     * - "base": Use ANYCRAWL_PROXY_URL
     * - "stealth": Use ANYCRAWL_PROXY_STEALTH_URL
     * - Custom URL: A full proxy URL string (e.g., "http://user:pass@proxy:8080")
     */
    proxy: z.union([
        z.enum(["auto", "base", "stealth"]),
        z.string().url()
    ]).optional(),

    /**
     * The formats to be used
     */
    formats: z.array(z.enum(SCRAPE_FORMATS)).default(["markdown"]),

    /**
     * The timeout to be used
     */
    timeout: z.number().min(1000).max(600_000).default(60_000),

    /**
     * The wait for to be used
     */
    wait_for: z.number().min(1).max(60_000).optional(),

    /**
     * Navigation wait condition for browser engines. Mirrors Playwright/Puppeteer goto waitUntil.
     * Field name is 'wait_until'.
     */
    wait_until: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).optional(),

    /**
     * The selector to wait for in browser engines. String or object form.
     * Only effective for Playwright/Puppeteer; ignored for Cheerio.
     */
    wait_for_selector: z
        .union([
            z.string(),
            z.object({
                selector: z.string(),
                timeout: z.number().min(1).max(120000).optional(),
                state: z.enum(["attached", "visible", "hidden", "detached"]).optional(),
            }).strict(),
            z.array(
                z.union([
                    z.string(),
                    z.object({
                        selector: z.string(),
                        timeout: z.number().min(1).max(120000).optional(),
                        state: z.enum(["attached", "visible", "hidden", "detached"]).optional(),
                    }).strict(),
                ])
            ).nonempty()
        ])
        .optional(),


    /**
     * The retry to be used
     */
    retry: z.boolean().default(false),

    /**
     * The include tags to be used
     */
    include_tags: z.array(z.string()).optional(),

    /**
     * The exclude tags to be used
     */
    exclude_tags: z.array(z.string()).optional(),

    /**
     * The JSON options to be used for extracting structured data
     * If all nested fields are empty (empty strings or empty schema object),
     * treat as undefined so the request omits json_options entirely.
     */
    json_options: z.preprocess((value) => {
        if (value == null) return undefined;
        if (typeof value !== 'object') return value;

        const input = value as any;

        const schemaVal = input.schema;
        const hasSchema = schemaVal && typeof schemaVal === 'object' && Object.keys(schemaVal).length > 0;

        const userPrompt = typeof input.user_prompt === 'string' ? input.user_prompt.trim() : input.user_prompt;
        const schemaName = typeof input.schema_name === 'string' ? input.schema_name.trim() : input.schema_name;
        const schemaDescription = typeof input.schema_description === 'string' ? input.schema_description.trim() : input.schema_description;

        const cleaned: any = {};
        if (hasSchema) cleaned.schema = schemaVal;
        if (userPrompt) cleaned.user_prompt = userPrompt;
        if (schemaName) cleaned.schema_name = schemaName;
        if (schemaDescription) cleaned.schema_description = schemaDescription;

        return Object.keys(cleaned).length === 0 ? undefined : cleaned;
    }, jsonOptionsSchema.optional()),

    /**
     * The source format to use for JSON extraction (html or markdown)
     */
    extract_source: z.enum(EXTRACT_SOURCES).default("markdown"),
});

export type BaseSchema = z.infer<typeof baseSchema>;

export type JsonSchemaType = z.infer<typeof jsonSchemaType>;
