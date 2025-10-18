import { getTemplate } from "@anycrawl/db";
import { AVAILABLE_ENGINES } from "@anycrawl/scrape";
import { TemplateClient } from "@anycrawl/template-client";
import { mergeOptionsWithTemplate } from "./optionMerger.js";
import { TemplateScrapeSchema, TemplateCrawlSchema, TemplateSearchSchema, TemplateConfig, log } from "@anycrawl/libs";
import { DomainValidator, TemplateExecutionError } from "@anycrawl/template-client";

/**
 * Template processing result
 */
export interface TemplateProcessingResult {
    success: boolean;
    engineName?: string;
    mergedOptions?: any;
    error?: string;
}

/**
 * Template handler for processing template-related logic
 */
export class TemplateHandler {
    private static templateClient: TemplateClient | null = null;

    /**
     * Check if user has permission to use template
     * @param template - The template configuration
     * @param currentUserId - Current user ID from API key
     * @returns true if user has permission, false otherwise
     */
    private static hasTemplateAccess(template: any, currentUserId?: string): boolean {
        // If current request API key has no associated user, any template can be used
        // for self-hosted
        if (!currentUserId) {
            return true;
        }

        const templateCreatedBy = template.createdBy;

        // If template creator equals current user, access is allowed
        if (templateCreatedBy === currentUserId) {
            return true;
        }

        const templateStatus = template.status;
        const templateReviewStatus = template.reviewStatus;
        // If template creator doesn't match current user, but status is published and review status is approved, access is allowed
        if (templateStatus === 'published' && templateReviewStatus === 'approved') {
            return true;
        }

        // If template creator doesn't match current user, and status is not published or review status is not approved, access is denied
        return false;
    }

    /**
     * Get or create TemplateClient instance (singleton)
     */
    private static getTemplateClient(): TemplateClient {
        if (!this.templateClient) {
            this.templateClient = new TemplateClient();
        }
        return this.templateClient;
    }

    /**
     * Process template for a given request
     * @param templateId - The template ID
     * @param url - The URL to validate against domain restrictions
     * @param requestOptions - Options from the request
     * @param templateType - Expected template type (scrape, crawl, search)
     * @param currentUserId - Current user ID from API key
     * @param options - Processing options
     * @returns TemplateProcessingResult
     */
    public static async processTemplate(
        templateId: string,
        url: string,
        requestOptions: any,
        templateType: "scrape" | "crawl" | "search",
        currentUserId?: string,
        options: {
            validateDomain?: boolean;
            mergeOptions?: boolean;
            validateEngine?: boolean;
        } = {}
    ): Promise<TemplateProcessingResult> {
        const {
            validateDomain = true,
            mergeOptions = true,
            validateEngine = true
        } = options;

        try {
            // Get template from database
            const template = await getTemplate(templateId);
            if (!template) {
                return {
                    success: false,
                    error: `Template not found: ${templateId}`
                };
            }

            // Check template access permission
            if (!this.hasTemplateAccess(template, currentUserId)) {
                return {
                    success: false,
                    error: `Access denied: You don't have permission to use this template`
                };
            }

            // Validate template type
            if (template.templateType !== templateType) {
                return {
                    success: false,
                    error: `Template type mismatch: expected ${templateType}, got ${template.templateType}`
                };
            }

            // Get the appropriate options for the template type
            const templateOptions = this.getTemplateOptionsForType(template, templateType);
            if (!templateOptions) {
                return {
                    success: false,
                    error: `No options found for template type: ${templateType}`
                };
            }

            // Validate engine if required
            if (validateEngine && templateOptions.engine) {
                if (!AVAILABLE_ENGINES.includes(templateOptions.engine)) {
                    return {
                        success: false,
                        error: `Invalid template engine: ${templateOptions.engine}`
                    };
                }
            }

            // Validate domain restrictions if required
            if (validateDomain) {
                const templateClient = this.getTemplateClient();
                const domainValidation = templateClient.validateDomainRestrictions(template, url);
                if (!domainValidation.isValid) {
                    return {
                        success: false,
                        error: `Domain validation failed: ${domainValidation.error}`
                    };
                }
            }

            // Merge options if required
            let mergedOptions = requestOptions;
            if (mergeOptions) {
                mergedOptions = mergeOptionsWithTemplate(
                    templateOptions as any,
                    requestOptions
                );
            }

            return {
                success: true,
                engineName: templateOptions.engine,
                mergedOptions
            };
        } catch (error) {
            return {
                success: false,
                error: `Template processing failed: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }

    /**
     * Get template options for a specific type
     * @param template - The template configuration
     * @param templateType - The template type
     * @returns Template options for the specified type
     */
    private static getTemplateOptionsForType(template: any, templateType: "scrape" | "crawl" | "search"): any {
        const reqOptions = template.reqOptions || {};

        // With the new structure, reqOptions directly contains the type-specific options
        // No need to extract from nested objects
        return reqOptions;
    }

    /**
     * Process template for scrape operations
     * @param templateId - The template ID
     * @param url - The URL to validate
     * @param requestOptions - Request options
     * @param currentUserId - Current user ID from API key
     * @returns TemplateProcessingResult
     */
    public static async processScrapeTemplate(
        templateId: string,
        url: string,
        requestOptions: any,
        currentUserId?: string
    ): Promise<TemplateProcessingResult> {
        return this.processTemplate(templateId, url, requestOptions, "scrape", currentUserId, {
            validateDomain: true,
            mergeOptions: true,
            validateEngine: true
        });
    }

    /**
     * Get template options for merging before schema parse
     * @param templateId - The template ID
     * @param templateType - The template type
     * @param currentUserId - Current user ID from API key
     * @returns Template options for merging
     */
    public static async getTemplateOptions(
        templateId: string,
        templateType: "scrape" | "crawl" | "search",
        currentUserId?: string
    ): Promise<{ success: boolean; templateOptions?: TemplateScrapeSchema | TemplateCrawlSchema | TemplateSearchSchema; template?: TemplateConfig; error?: string }> {
        try {
            const templateClient = this.getTemplateClient();
            const template = await templateClient.getTemplate(templateId);

            if (!template) {
                return {
                    success: false,
                    error: `Template not found: ${templateId}`
                };
            }

            // Check template access permission
            if (!this.hasTemplateAccess(template, currentUserId)) {
                return {
                    success: false,
                    error: `Access denied: You don't have permission to use this template`
                };
            }

            // Validate template type
            if (template.templateType !== templateType) {
                return {
                    success: false,
                    error: `Template type mismatch. Expected: ${templateType}, got: ${template.templateType}`
                };
            }

            const templateOptions = this.getTemplateOptionsForType(template, templateType);
            if (!templateOptions) {
                return {
                    success: false,
                    error: `No options found for template type: ${templateType}`
                };
            }

            return {
                success: true,
                templateOptions,
                template
            };
        } catch (error) {
            return {
                success: false,
                error: `Failed to get template: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    /**
     * Process template for crawl operations
     * @param templateId - The template ID
     * @param url - The URL to validate
     * @param crawlOptions - Crawl options to merge
     * @param currentUserId - Current user ID from API key
     * @returns TemplateProcessingResult
     */
    public static async processCrawlTemplate(
        templateId: string,
        url: string,
        crawlOptions: any,
        currentUserId?: string
    ): Promise<TemplateProcessingResult> {
        return this.processTemplate(templateId, url, crawlOptions, "crawl", currentUserId, {
            validateDomain: true,
            mergeOptions: true,
            validateEngine: true
        });
    }

    /**
     * Process template for search operations
     * @param templateId - The template ID
     * @param url - The URL to validate (optional for search)
     * @param searchOptions - Search options to merge
     * @param currentUserId - Current user ID from API key
     * @param options - Additional options
     * @returns TemplateProcessingResult
     */
    public static async processSearchTemplate(
        templateId: string,
        url: string | null,
        searchOptions: any,
        currentUserId?: string,
        options: {
            validateDomain?: boolean;
            validateEngine?: boolean;
        } = {}
    ): Promise<TemplateProcessingResult> {
        return this.processTemplate(templateId, url || '', searchOptions, "search", currentUserId, {
            validateDomain: options.validateDomain ?? false, // Search doesn't need domain validation
            mergeOptions: true,
            validateEngine: options.validateEngine ?? true
        });
    }

    public static async mergeRequestWithTemplate<T extends Record<string, any>>(
        requestData: T,
        templateType: "scrape" | "crawl" | "search",
        currentUserId?: string
    ): Promise<T> {
        const templateId = (requestData as Record<string, any>)?.template_id;
        if (!templateId) {
            return { ...requestData };
        }

        const templateResult = await this.getTemplateOptions(templateId, templateType, currentUserId);

        if (!templateResult.success || !templateResult.templateOptions || !templateResult.template) {
            throw new Error(templateResult.error ?? "Failed to apply template configuration");
        }

        let mergedData: Record<string, any> = { ...requestData };

        // Validate variables before applying defaults
        validateVariables(
            templateResult.template.variables,
            mergedData.variables,
            mergedData  // Pass the request data to check if mapping targets exist
        );

        const variablesWithDefaults = applyVariableDefaults(
            templateResult.template.variables,
            mergedData.variables
        );

        if (variablesWithDefaults !== undefined) {
            mergedData.variables = variablesWithDefaults;
            mergedData = TemplateVariableMapper.mapVariablesToRequestData(
                variablesWithDefaults,
                templateResult.template,
                mergedData
            );
        } else if (mergedData.variables !== undefined) {
            delete mergedData.variables;
        }

        const mergedTemplateData = mergeOptionsWithTemplate(
            templateResult.templateOptions as Record<string, any>,
            mergedData
        );

        mergedData = {
            ...mergedData,
            ...mergedTemplateData,
            template: templateResult.template
        };

        if (mergedData.url && templateResult.template.metadata?.allowedDomains) {
            const domainRestriction = DomainValidator.parseDomainRestriction(templateResult.template.metadata.allowedDomains);
            if (domainRestriction) {
                const validationResult = DomainValidator.validateDomain(mergedData.url, domainRestriction);
                if (!validationResult.isValid) {
                    throw new TemplateExecutionError(validationResult.error || "URL not allowed by template domain restrictions");
                }
            }
        }

        // For search templates, validate query against allowedKeywords if present
        if (templateType === "search" && mergedData.query && templateResult.template.metadata?.allowedKeywords) {
            const keywordRestriction = DomainValidator.parseDomainRestriction(templateResult.template.metadata.allowedKeywords);
            if (keywordRestriction) {
                const validationResult = DomainValidator.validatePattern(
                    mergedData.query,
                    keywordRestriction,
                    'Search query'
                );
                if (!validationResult.isValid) {
                    throw new TemplateExecutionError(validationResult.error || "Search query not allowed by template keyword restrictions");
                }
            }
        }

        // For search templates, apply query transformation if configured and log original/final
        if (templateType === "search" && mergedData.query && templateResult.template.customHandlers?.queryTransform) {
            mergedData.query = this.applyAndLogTransform(
                mergedData.query,
                templateResult.template.customHandlers?.queryTransform,
                templateResult.template,
                "query"
            );
        }

        // Apply URL transformation if present and log original/final
        // Preserve original URL for downstream proxy/glob matching
        if (mergedData.url && templateResult.template.customHandlers?.urlTransform) {
            try {
                if (!mergedData.original_url) {
                    mergedData.original_url = mergedData.url;
                }
            } catch { /* ignore */ }
            mergedData.url = this.applyAndLogTransform(
                mergedData.url,
                templateResult.template.customHandlers?.urlTransform,
                templateResult.template,
                "url"
            );
        }

        // Filter out fields that are not compatible with the template type schema
        mergedData = this.filterBySchemaType(mergedData, templateType);

        return mergedData as T;
    }

    /**
     * Filter request data based on template type schema
     * Removes fields that are not compatible with the specific template type
     * @param data - The merged request data
     * @param templateType - The template type (scrape, crawl, search)
     * @returns Filtered data without schema-incompatible fields
     */
    private static filterBySchemaType(
        data: Record<string, any>,
        templateType: "scrape" | "crawl" | "search"
    ): Record<string, any> {
        const filtered = { ...data };

        // Remove fields that are not allowed by the specific schema
        if (templateType === "search") {
            // searchSchema doesn't allow 'url' field - search uses 'query' instead
            // Remove it to prevent validation errors
            delete filtered.url;
        }

        return filtered;
    }

    public static reslovePrice(template: TemplateConfig, type: "credits" = 'credits', scenario: "perCall" = 'perCall'): number {
        if (scenario === "perCall" && template.pricing?.perCall
            && Number.isFinite(template.pricing.perCall)
            && template.pricing.perCall > 0
            && template.pricing.currency === type
        ) {
            return template.pricing.perCall;
        }
        return 0;
    }

    /**
     * Generic transform that supports optional regex extraction, then template/append modes
     */
    private static applyTransform(
        originalValue: string,
        transform: {
            enabled: boolean;
            mode: "template" | "append";
            template?: string;
            prefix?: string;
            suffix?: string;
            regexExtract?: { pattern: string; flags?: string; group?: number; trim?: boolean };
        } | undefined,
        templatePlaceholder: string
    ): string {
        if (!transform || !transform.enabled) {
            log.info(`Transform disabled or missing; skipping. value="${originalValue}"`);
            return originalValue;
        }

        let subject = originalValue;

        // Optional regex extraction
        const reCfg = transform.regexExtract;
        if (reCfg && reCfg.pattern) {
            try {
                const re = new RegExp(reCfg.pattern, reCfg.flags || undefined);
                const match = subject.match(re);
                if (match) {
                    const groupIndex = Number.isInteger(reCfg.group) ? (reCfg.group as number) : 0;
                    if (groupIndex >= 0 && groupIndex < match.length) {
                        subject = match[groupIndex] ?? match[0];
                    } else {
                        subject = match[0];
                    }
                    if (reCfg.trim !== false) {
                        subject = subject.trim();
                    }
                }
            } catch {
                // Invalid regex config - ignore and fall back to original subject
            }
        }

        if (transform.mode === "template") {
            if (!transform.template) {
                log.info(`Template mode requires 'template' string; skipping transform.`);
                return subject;
            }
            const ph = new RegExp(`\\{\\{${templatePlaceholder}\\}\\}`, "g");
            return transform.template.replace(ph, subject);
        }

        if (transform.mode === "append") {
            const prefix = transform.prefix || "";
            const suffix = transform.suffix || "";
            if (!prefix && !suffix) {
                log.info(`Append mode configured but both prefix and suffix are empty; skipping transform.`);
                return subject;
            }
            return `${prefix}${subject}${suffix}`;
        }

        log.info(`Unknown transform mode: "${String((transform as any).mode)}"; skipping transform.`);
        return subject;
    }

    /**
     * Apply transform and log original/final values for a given field
     */
    private static applyAndLogTransform(
        value: string,
        transform: {
            enabled: boolean;
            mode: "template" | "append";
            template?: string;
            prefix?: string;
            suffix?: string;
            regexExtract?: { pattern: string; flags?: string; group?: number; trim?: boolean };
        } | undefined,
        template: TemplateConfig,
        field: "url" | "query"
    ): string {
        const original = value;
        const finalValue = this.applyTransform(value, transform as any, field);
        log.info(`Template ${field} transform: original="${original}", final="${finalValue}", template_id="${(template as any).templateId}"`);
        return finalValue;
    }
}

export class TemplateVariableMapper {
    static mapVariablesToRequestData(
        variables: Record<string, any> | undefined,
        template: TemplateConfig,
        requestData: Record<string, any>
    ): Record<string, any> {
        if (!variables || !template.variables) {
            return { ...requestData };
        }

        const updatedData = { ...requestData };

        for (const [variableName, value] of Object.entries(variables)) {
            const variableConfig = template.variables?.[variableName];
            if (!variableConfig?.mapping?.target) {
                continue;
            }

            const targetPath = variableConfig.mapping.target;
            // Precedence: explicit params > variables (mapping) > defaultValue
            // Do not override explicitly provided values already present in requestData
            const existingValue = TemplateVariableMapper.getNestedValue(updatedData, targetPath);
            if (existingValue !== undefined && existingValue !== null) {
                continue;
            }
            TemplateVariableMapper.setNestedValue(updatedData, targetPath, value);
        }

        return updatedData;
    }

    static getNestedValue(obj: Record<string, any>, path: string): any {
        if (!path) {
            return undefined;
        }

        const segments = path.split(".");
        let current: any = obj;

        for (const segment of segments) {
            if (!segment || current === undefined || current === null) {
                return undefined;
            }
            current = current[segment];
        }

        return current;
    }

    private static setNestedValue(target: Record<string, any>, path: string, value: any): void {
        if (!path) {
            return;
        }

        const segments = path.split(".");
        let current: Record<string, any> = target;

        while (segments.length > 1) {
            const segment = segments.shift()!;
            if (!segment) {
                continue;
            }
            if (current[segment] === undefined || current[segment] === null || typeof current[segment] !== "object") {
                current[segment] = {};
            }
            current = current[segment];
        }

        const finalSegment = segments.pop();
        if (!finalSegment) {
            return;
        }

        current[finalSegment] = value;
    }
}

/**
 * Validate variables against template variable definitions
 * @param variableDefinitions - Template variable definitions
 * @param providedVariables - User-provided variables
 * @param requestData - Request data to check if mapping targets already exist
 * @throws Error if validation fails
 */
export function validateVariables(
    variableDefinitions: TemplateConfig["variables"] | undefined,
    providedVariables: Record<string, any> | undefined,
    requestData?: Record<string, any>
): void {
    if (!variableDefinitions) {
        return;
    }

    const errors: string[] = [];

    // Check for required variables
    for (const [variableName, definition] of Object.entries(variableDefinitions)) {
        if (definition.required) {
            const value = providedVariables?.[variableName];
            const hasValue = value !== undefined && value !== null;
            const hasDefaultValue = Object.prototype.hasOwnProperty.call(definition, "defaultValue");

            // If variable has mapping and the target field already exists in requestData, it's satisfied
            let hasMappedTarget = false;
            if (definition.mapping?.target && requestData) {
                const targetValue = TemplateVariableMapper.getNestedValue(requestData, definition.mapping.target);
                hasMappedTarget = targetValue !== undefined && targetValue !== null;
            }

            if (!hasValue && !hasDefaultValue && !hasMappedTarget) {
                errors.push(`Required variable '${variableName}' is missing`);
            }
        }
    }

    // Validate provided variables
    if (providedVariables) {
        for (const [variableName, value] of Object.entries(providedVariables)) {
            const definition = variableDefinitions[variableName];

            // Check if variable is defined in template
            if (!definition) {
                errors.push(`Unknown variable '${variableName}' not defined in template`);
                continue;
            }

            // Skip null/undefined values (will be handled by defaults)
            if (value === undefined || value === null) {
                continue;
            }

            // Validate type
            const actualType = typeof value;
            switch (definition.type) {
                case "string":
                    if (actualType !== "string") {
                        errors.push(`Variable '${variableName}' must be a string, got ${actualType}`);
                    }
                    break;

                case "number":
                    if (actualType !== "number" || !Number.isFinite(value)) {
                        errors.push(`Variable '${variableName}' must be a finite number, got ${actualType}`);
                    }
                    break;

                case "boolean":
                    if (actualType !== "boolean") {
                        errors.push(`Variable '${variableName}' must be a boolean, got ${actualType}`);
                    }
                    break;

                case "url":
                    if (actualType !== "string") {
                        errors.push(`Variable '${variableName}' must be a string (URL), got ${actualType}`);
                    } else {
                        try {
                            new URL(value);
                        } catch {
                            errors.push(`Variable '${variableName}' must be a valid URL`);
                        }
                    }
                    break;

                case "enum": {
                    const defAny = definition as any;
                    let allowed: Array<string | number | boolean> | undefined = defAny.values;
                    if ((!Array.isArray(allowed) || allowed.length === 0) && Array.isArray(defAny.options)) {
                        allowed = defAny.options.map((opt: any) => opt?.value).filter((v: any) => v !== undefined);
                    }
                    if (!Array.isArray(allowed) || allowed.length === 0) {
                        errors.push(`Variable '${variableName}' enum has no values defined`);
                        break;
                    }
                    const isAllowed = allowed.includes(value);
                    if (!isAllowed) {
                        errors.push(`Variable '${variableName}' must be one of [${allowed.map(v => JSON.stringify(v)).join(", ")}], got ${JSON.stringify(value)}`);
                    }
                    break;
                }

                default:
                    errors.push(`Variable '${variableName}' has unknown type '${definition.type}'`);
            }
        }
    }

    if (errors.length > 0) {
        throw new Error(`Template variable validation failed:\n- ${errors.join("\n- ")}`);
    }
}

export function applyVariableDefaults(
    variableDefinitions: TemplateConfig["variables"] | undefined,
    providedVariables: Record<string, any> | undefined
): Record<string, any> | undefined {
    if (!variableDefinitions) {
        return providedVariables;
    }

    const mergedVariables = providedVariables ? { ...providedVariables } : {};
    let defaultApplied = false;

    for (const [variableName, definition] of Object.entries(variableDefinitions)) {
        if (mergedVariables[variableName] === undefined || mergedVariables[variableName] === null) {
            if (Object.prototype.hasOwnProperty.call(definition, "defaultValue")) {
                mergedVariables[variableName] = definition.defaultValue;
                defaultApplied = true;
            }
        }
    }

    if (providedVariables && Object.keys(providedVariables).length > 0) {
        return mergedVariables;
    }

    if (defaultApplied) {
        return mergedVariables;
    }

    return providedVariables;
}
