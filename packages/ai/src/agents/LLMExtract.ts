import { generateObject, JSONSchema7, jsonSchema, streamObject, NoObjectGeneratedError } from "ai";
import { BaseAgent } from "./BaseAgent.js";
import { TextChunker, ChunkResult } from "./TextChunker.js";
import { log } from "@anycrawl/libs";
import { buildExtractionPrompt, EXTRACT_SYSTEM_PROMPT } from "../prompts/extract.prompts.js";
import { CostTracking } from "./CostTracking.js";

const VALID_JSON_SCHEMA_TYPES = new Set([
    'object',
    'array',
    'string',
    'number',
    'integer',
    'boolean',
    'null',
]);

// --- Schema normalization helpers ---
function removeDefaultProperty(obj: any): any {
    if (Array.isArray(obj)) {
        return obj.map(removeDefaultProperty);
    } else if (obj && typeof obj === "object") {
        const { default: _default, ...rest } = obj;
        return Object.fromEntries(
            Object.entries(rest).map(([k, v]) => [k, removeDefaultProperty(v)])
        );
    }
    return obj;
}

function normalizeSchema(schema: any): any {
    // First remove defaults recursively
    const removeDefaults = removeDefaultProperty(schema);

    // Build a normalized base schema
    let base: any;
    if (removeDefaults && removeDefaults.type === "array") {
        base = {
            type: "object",
            properties: {
                items: removeDefaults,
            },
            required: ["items"],
            additionalProperties: false,
        };
    } else if (removeDefaults && typeof removeDefaults === "object" && !removeDefaults.type) {
        base = {
            type: "object",
            properties: Object.fromEntries(
                Object.entries(removeDefaults).map(([key, value]) => {
                    return [key, normalizeSchema(value)];
                })
            ),
            required: Object.keys(removeDefaults),
            additionalProperties: false,
        };
    } else {
        base = removeDefaults;
    }

    // Enforce additionalProperties: false on all object nodes, recurse arrays/items
    const enforceAdditionalFalse = (node: any): any => {
        if (!node || typeof node !== 'object') return node;
        if (Array.isArray(node)) return node.map(enforceAdditionalFalse);
        const out: any = { ...node };
        if (out.type === 'object') {
            if (out.additionalProperties === undefined) out.additionalProperties = false;
            if (out.properties && typeof out.properties === 'object') {
                for (const [k, v] of Object.entries(out.properties)) {
                    (out.properties as any)[k] = enforceAdditionalFalse(v);
                }
            }
        } else if (out.type === 'array' && out.items) {
            out.items = enforceAdditionalFalse(out.items);
        }
        return out;
    };

    return enforceAdditionalFalse(base);
}

// Interfaces
interface ExtractOptions {
    prompt?: string;
    maxTokensInput?: number;
    chunkOverlap?: number;
    systemPrompt?: string; //used for override system prompt, and work for once call
    costLimit?: number; //used for override cost limit, and work for once call
    schemaName?: string;
    schemaDescription?: string;
}

interface ExtractResult {
    data: any;
    tokens: {
        input: number;
        output: number;
        total: number;
    };
    chunks: number;
    cost?: number;
    durationMs?: number;
}

interface BatchExtractResult {
    results: any[];
    totalTokens: {
        input: number;
        output: number;
        total: number;
    };
    totalChunks: number;
    cost?: number;
}

class LLMExtract extends BaseAgent {
    private systemPrompt: string;
    private textChunker: TextChunker;

    constructor(modelId: string, prompt: string = EXTRACT_SYSTEM_PROMPT, costLimit: number | null = null) {
        super(modelId, costLimit);
        this.systemPrompt = prompt;
        this.textChunker = new TextChunker(this.countTokens.bind(this));
    }

    /**
     * Extract actual token usage from provider response if available
     */
    private extractUsageTokens(result: any, fallbackPromptText?: string, fallbackOutputObject?: any): {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        providerCost?: number;
        providerCurrency?: string;
        rawUsage?: any;
    } {
        const usage = result?.usage || result?.response?.usage || null;
        const promptTokens = usage?.promptTokens ?? usage?.inputTokens ?? usage?.prompt_tokens ?? null;
        const completionTokens = usage?.completionTokens ?? usage?.outputTokens ?? usage?.completion_tokens ?? null;
        const totalTokens = usage?.totalTokens ?? usage?.total_tokens ?? null;
        const currency = usage?.currency || usage?.unit || usage?.pricing?.currency || undefined;
        const costCandidate = usage?.totalCost ?? usage?.total_cost ?? usage?.cost ?? usage?.price ?? usage?.total_price ?? usage?.pricing?.total ?? undefined;

        if (typeof promptTokens === 'number' && typeof completionTokens === 'number') {
            return {
                inputTokens: promptTokens,
                outputTokens: completionTokens,
                totalTokens: typeof totalTokens === 'number' ? totalTokens : promptTokens + completionTokens,
                providerCost: typeof costCandidate === 'number' ? costCandidate : undefined,
                providerCurrency: currency,
                rawUsage: usage ?? undefined,
            };
        }

        // Fallback to local estimation
        const promptText = String(fallbackPromptText ?? '');
        const outputText = JSON.stringify(fallbackOutputObject ?? {});
        const estimatedInput = this.countTokens(promptText);
        const estimatedOutput = this.countTokens(outputText);
        return {
            inputTokens: estimatedInput,
            outputTokens: estimatedOutput,
            totalTokens: estimatedInput + estimatedOutput,
        };
    }

    /**
     * Get system prompt tokens for parameter calculation
     */
    private getSystemPromptTokens(): number {
        return this.countTokens(this.systemPrompt);
    }

    private isValidNormalizedSchema(schema: any): boolean {
        if (!schema || typeof schema !== 'object') {
            return false;
        }

        const typeValue = schema.type;
        if (typeof typeValue === 'string') {
            return VALID_JSON_SCHEMA_TYPES.has(typeValue);
        }

        if (Array.isArray(typeValue)) {
            return typeValue.every((item) => typeof item === 'string' && VALID_JSON_SCHEMA_TYPES.has(item));
        }

        return false;
    }

    private buildEmptyDataFromSchema(schema: JSONSchema7): any {
        if (!schema || typeof schema !== 'object') {
            return null;
        }

        const typeValue = schema.type;
        const hasObjectType = typeValue === 'object' || (Array.isArray(typeValue) && typeValue.includes('object'));

        if (hasObjectType && schema.properties && typeof schema.properties === 'object') {
            const result: Record<string, any> = {};
            for (const [key, value] of Object.entries(schema.properties)) {
                result[key] = this.buildEmptyDataFromSchema(value as JSONSchema7);
            }
            return result;
        }

        return null;
    }

    /**
     * Choose object-generation mode based on model capability.
     * "json" avoids response-format warnings on providers without native schema support.
     */
    private getGenerateMode(): "auto" | "json" {
        if (this.modelConfig?.supports_response_schema) {
            return "auto";
        }
        return "json";
    }

    /**
     * Extract field names from schema for prompt construction
     */
    private getSchemaFields(schema: JSONSchema7): string[] {
        if (schema.properties && typeof schema.properties === 'object') {
            return Object.keys(schema.properties);
        }
        return [];
    }

    /**
     * Create field-specific prompt (递归展开所有嵌套字段)
     */
    private createFieldPrompt(schema: JSONSchema7, indent: string = ''): string {
        if (!schema || typeof schema !== 'object' || !schema.properties || typeof schema.properties !== 'object') return '';
        const fields = Object.keys(schema.properties);
        if (fields.length === 0) return "";

        const fieldDescriptions = fields.map(field => {
            const propSchema = schema.properties?.[field] as JSONSchema7;
            const type = propSchema?.type || 'any';
            const description = propSchema?.description || '';
            let typeDescription = '';
            if (type === 'array') {
                const items = propSchema.items as JSONSchema7;
                const itemType = items && typeof items === 'object' && 'type' in items ? items.type : 'any';
                typeDescription = `(array of ${itemType}s)`;
                // Recursively expand array items
                if (items && items.type === 'object') {
                    return `${indent}- ${field} ${typeDescription}: ${description}\n${this.createFieldPrompt(items, indent + '    ')}`;
                }
            } else if (type === 'object') {
                typeDescription = '(object)';
                // Recursively expand array items
                return `${indent}- ${field} ${typeDescription}: ${description}\n${this.createFieldPrompt(propSchema, indent + '    ')}`;
            } else {
                typeDescription = `(${type})`;
            }
            return `${indent}- ${field} ${typeDescription}: ${description}`;
        }).join('\n');

        return fieldDescriptions;
    }

    /**
     * Merge multiple extraction results
     */
    private mergeResults(results: any[], schema: JSONSchema7): any {
        if (results.length === 0) return null;
        if (results.length === 1) return results[0];

        // Simple merge strategy - you can make this more sophisticated
        const merged: any = {};

        for (const result of results) {
            if (!result) continue;

            for (const [key, value] of Object.entries(result)) {
                if (value === null || value === undefined) continue;

                if (!merged[key]) {
                    merged[key] = value;
                } else if (Array.isArray(merged[key]) && Array.isArray(value)) {
                    // Merge arrays and remove duplicates
                    merged[key] = this.deduplicateArray([...merged[key], ...value]);
                } else if (typeof merged[key] === 'object' && typeof value === 'object') {
                    // Merge objects
                    merged[key] = { ...merged[key], ...value };
                } else {
                    // For primitive values, prefer non-empty values
                    if (merged[key] === null || merged[key] === undefined || merged[key] === '') {
                        merged[key] = value;
                    }
                }
            }
        }

        return merged;
    }

    /**
     * Deduplicate array items
     */
    private deduplicateArray(arr: any[]): any[] {
        const seen = new Set();
        return arr.filter(item => {
            const key = typeof item === 'object' ? JSON.stringify(item) : item;
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
    }

    /**
     * Override getDefaultParams to account for system prompt
     */
    protected getDefaultParams() {
        const baseParams = super.getDefaultParams();

        // Adjust maxTokensInput to account for system prompt
        const systemPromptTokens = this.getSystemPromptTokens();
        const adjustedMaxTokensInput = Math.max(1000, baseParams.maxTokensInput - systemPromptTokens);

        return {
            ...baseParams,
            maxTokensInput: adjustedMaxTokensInput
        };
    }

    /**
     * Unified extraction logic for both single and chunked extraction
     */
    async perform(text: string | string[], schema: JSONSchema7, options: ExtractOptions = {}): Promise<ExtractResult> {
        const overallStart = Date.now();
        const scopedTracking = new CostTracking(this.costTracking.limit);
        const recordCall = (call: {
            type: "extract" | "batch" | "merge";
            metadata: Record<string, any>;
            cost: number;
            model: string;
            tokens?: {
                input: number;
                output: number;
            };
        }) => {
            scopedTracking.addCall(call);
            this.costTracking.addCall(call);
        };
        // --- normalize schema ---
        const normalizedSchema = normalizeSchema(schema);
        // Get default parameters based on model config
        const defaults = this.getDefaultParams();
        const {
            maxTokensInput = defaults.maxTokensInput,
            chunkOverlap = defaults.chunkOverlap
        } = options;

        const inputText = Array.isArray(text) ? text.join('\n') : text;
        const inputTokens = this.countTokens(inputText);
        const generationMode = this.getGenerateMode();

        log.debug(`📊 Model: ${this.modelId}`);
        log.debug(`📏 Input tokens: ${inputTokens}, Max input: ${maxTokensInput}`);

        if (!this.isValidNormalizedSchema(normalizedSchema)) {
            const totalDuration = Date.now() - overallStart;
            log.warning(`Invalid schema provided for extraction, skipping LLM call. schema.type=${JSON.stringify((normalizedSchema as any)?.type)}`);
            return {
                data: {},
                tokens: {
                    input: inputTokens,
                    output: 0,
                    total: inputTokens,
                },
                chunks: 1,
                cost: 0,
                durationMs: totalDuration,
            };
        }

        if (inputText.trim().length === 0) {
            const totalDuration = Date.now() - overallStart;
            return {
                data: this.buildEmptyDataFromSchema(normalizedSchema),
                tokens: {
                    input: inputTokens,
                    output: 0,
                    total: inputTokens,
                },
                chunks: 1,
                cost: 0,
                durationMs: totalDuration,
            };
        }

        // If text is short enough, process directly
        if (inputTokens <= maxTokensInput) {
            const { prompt } = options;
            const fieldPrompt = this.createFieldPrompt(normalizedSchema);
            const fullPrompt = buildExtractionPrompt({ prompt: prompt ?? undefined, fieldPrompt, content: inputText });
            log.debug(`🔍 Normalized schema: ${JSON.stringify(normalizedSchema)}`);
            log.debug(`🔍 Full prompt: ${fullPrompt}`);
            try {
                const result = await generateObject({
                    model: this.llm,
                    system: options.systemPrompt || this.systemPrompt || "",
                    messages: [{ role: 'user', content: fullPrompt }],
                    schema: jsonSchema(normalizedSchema),
                    mode: generationMode,
                });

                const systemPrompt = options.systemPrompt || this.systemPrompt || "";
                const extractedData = result.object || result;
                const usageTokens = this.extractUsageTokens(result, fullPrompt + systemPrompt, extractedData);
                if (typeof usageTokens.providerCost === 'number' && usageTokens.providerCost > 0) {
                    recordCall({
                        type: "extract",
                        metadata: { direct: true },
                        cost: usageTokens.providerCost,
                        model: this.modelId,
                        tokens: { input: usageTokens.inputTokens, output: usageTokens.outputTokens }
                    });
                } else {
                    recordCall({
                        type: "extract",
                        metadata: { direct: true },
                        cost: this.calculateCost(usageTokens.inputTokens, usageTokens.outputTokens),
                        model: this.modelId,
                        tokens: { input: usageTokens.inputTokens, output: usageTokens.outputTokens }
                    });
                }

                const totalDuration = Date.now() - overallStart;
                const finalResult = {
                    data: extractedData,
                    tokens: {
                        input: usageTokens.inputTokens,
                        output: usageTokens.outputTokens,
                        total: usageTokens.totalTokens
                    },
                    chunks: 1,
                    cost: scopedTracking.getTotalCost(),
                    usage: usageTokens.rawUsage ?? undefined,
                    durationMs: totalDuration
                };

                // Output cost tracking information (overall extract duration only)
                log.info(`[extract] tokens(input=${finalResult.tokens.input}, output=${finalResult.tokens.output}, total=${finalResult.tokens.total}) cost=$${finalResult.cost.toFixed(6)} duration=${totalDuration}ms model=${this.modelId} chunks=${finalResult.chunks}`);
                return finalResult;

            } catch (error) {
                if (NoObjectGeneratedError.isInstance(error)) {
                    log.error('Failed to generate object from LLM response', {
                        cause: error.cause,
                        finishReason: error.finishReason,
                        usage: error.usage
                    });
                } else if (error instanceof Error && error.message.includes('Cost limit exceeded')) {
                    log.warning('Cost limit exceeded', {
                        error: error instanceof Error ? error.message : String(error)
                    });
                } else {
                    log.error('Error during extraction:', {
                        error: error instanceof Error ? error.message : String(error)
                    });
                }

                throw error;
            }
        }

        // For longer text, use chunking
        log.debug(`📦 Text too long, splitting into chunks (max: ${maxTokensInput}, overlap: ${chunkOverlap})`);
        const allChunks = this.textChunker.splitMultipleTexts([inputText], {
            maxTokens: maxTokensInput,
            overlapTokens: chunkOverlap
        });
        const allResults: any[] = [];
        for (const [index, chunkInfo] of allChunks.entries()) {
            try {
                log.debug(`⚡ Processing chunk ${index + 1}/${allChunks.length} (${chunkInfo.tokens} tokens)`);
                const fieldPrompt = this.createFieldPrompt(normalizedSchema);
                const fullPrompt = buildExtractionPrompt({ prompt: options.prompt ?? undefined, fieldPrompt, content: chunkInfo.chunk });
                const result = await generateObject({
                    model: this.llm,
                    system: options.systemPrompt || this.systemPrompt || "",
                    messages: [{ role: 'user', content: fullPrompt }],
                    schema: jsonSchema(normalizedSchema),
                    mode: generationMode,
                });
                const chunkData = result.object;
                allResults.push(chunkData);

                // Track tokens and cost for this chunk using provider usage if available
                const systemPrompt = options.systemPrompt || this.systemPrompt || "";
                const usageTokens = this.extractUsageTokens(result, fullPrompt + systemPrompt, chunkData);
                if (typeof usageTokens.providerCost === 'number' && usageTokens.providerCost > 0) {
                    recordCall({
                        type: "extract",
                        metadata: { direct: false, chunkIndex: index + 1, totalChunks: allChunks.length },
                        cost: usageTokens.providerCost,
                        model: this.modelId,
                        tokens: { input: usageTokens.inputTokens, output: usageTokens.outputTokens }
                    });
                } else {
                    recordCall({
                        type: "extract",
                        metadata: { direct: false, chunkIndex: index + 1, totalChunks: allChunks.length },
                        cost: this.calculateCost(usageTokens.inputTokens, usageTokens.outputTokens),
                        model: this.modelId,
                        tokens: { input: usageTokens.inputTokens, output: usageTokens.outputTokens }
                    });
                }
            } catch (error) {
                log.error(`❌ Error processing chunk ${chunkInfo.startIndex}-${chunkInfo.endIndex}: ${error instanceof Error ? error.message : String(error)}`);
                allResults.push(null);
            }
        }
        recordCall({
            type: "merge",
            metadata: { chunksCount: allChunks.length },
            cost: 0,
            model: this.modelId,
            tokens: { input: 0, output: 0 }
        });
        const mergedResult = this.mergeResults(allResults, normalizedSchema);
        const totalTokens = scopedTracking.getTotalTokens();
        const totalDuration = Date.now() - overallStart;
        const finalResult = {
            data: mergedResult,
            tokens: totalTokens,
            chunks: allChunks.length,
            cost: scopedTracking.getTotalCost(),
            durationMs: totalDuration
        };
        log.info(`[extract] tokens(input=${finalResult.tokens.input}, output=${finalResult.tokens.output}, total=${finalResult.tokens.total}) cost=$${finalResult.cost?.toFixed(6)} duration=${totalDuration}ms model=${this.modelId} chunks=${finalResult.chunks}`);
        return finalResult;
    }

    /**
     * Get chunk statistics for debugging
     */
    public analyzeChunking(text: string, options: ExtractOptions = {}): {
        chunks: ChunkResult[];
        stats: ReturnType<TextChunker['getChunkStats']>;
    } {
        const defaults = this.getDefaultParams();
        const {
            maxTokensInput = defaults.maxTokensInput,
            chunkOverlap = defaults.chunkOverlap
        } = options;

        const chunks = this.textChunker.splitTextIntoChunks(text, {
            maxTokens: maxTokensInput,
            overlapTokens: chunkOverlap
        });

        const stats = this.textChunker.getChunkStats(chunks);

        return { chunks, stats };
    }
}

export { LLMExtract };

export type {
    ExtractOptions,
    ExtractResult,
    BatchExtractResult
};
