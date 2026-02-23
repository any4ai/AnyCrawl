import { encoding_for_model, TiktokenModel, get_encoding } from "tiktoken";
import { modelsConfig } from "../utils/models-config.js";
import { ModelConfig } from "../utils/types.js";
import { CostTracking } from "./CostTracking.js";
import { log } from "@anycrawl/libs";
import { LanguageModel } from "ai";
import { getLLM, getLLMByModel } from "../ProviderRegistry.js";

const DEFAULT_INPUT_COST_PER_TOKEN = 2e-7;
const DEFAULT_OUTPUT_COST_PER_TOKEN = 8e-7;

/**
 * Base class for all AI agents that interact with language models
 * Provides common functionality for token counting, cost tracking, and model configuration
 */
export abstract class BaseAgent {
    protected modelId: string;
    protected llm: LanguageModel;
    protected costTracking: CostTracking;
    protected encoding: any;
    protected modelConfig: ModelConfig | null = null;

    constructor(modelId: string, costLimit: number | null = null) {
        this.modelId = modelId;
        // If modelId is in provider/model format, use it directly; otherwise resolve by model key
        try {
            this.llm = modelId.includes('/') ? getLLM(modelId) : getLLMByModel(modelId);
        } catch (error) {
            if (!modelId.includes('/')) {
                throw new Error(`Model ${modelId} is not found`);
            }
            throw error;
        }
        this.costTracking = new CostTracking(costLimit);

        // Load model configuration
        this.modelConfig = this.getModelConfig(modelId);

        // Initialize tiktoken encoding
        try {
            // 1) Try full provider/modelId directly first
            this.encoding = encoding_for_model(modelId as unknown as TiktokenModel);
        } catch (e1) {
            try {
                // 2) Then try with normalized model name (strip provider prefix)
                const normalized = this.getTiktokenModel(modelId);
                this.encoding = encoding_for_model(normalized);
            } catch (e2) {
                // 3) Finally, fallback to a general-purpose encoding
                try {
                    this.encoding = get_encoding('cl100k_base');
                    const normalized = this.getTiktokenModel(modelId);
                    log.info(`tiktoken model not found for: ${modelId} (normalized: ${normalized}). Falling back to cl100k_base.`);
                } catch (err) {
                    // If base encoding is also unavailable, rely on rough estimation in countTokens
                    const normalized = this.getTiktokenModel(modelId);
                    log.warning(`Failed to initialize tiktoken for: ${modelId} (normalized: ${normalized}). Will use rough estimation.`);
                }
            }
        }
    }

    /**
     * Get model configuration with priority lookup
     */
    protected getModelConfig(modelId: string): ModelConfig | null {
        // Priority order for model configuration lookup:
        // 1. Full path: "openrouter/openai/gpt-4"
        // 2. Provider/Model: "openai/gpt-4" 
        // 3. Model only: "gpt-4"

        const lookupKeys: string[] = [modelId]; // Start with full modelId

        if (modelId.includes('/')) {
            const parts = modelId.split('/');

            if (parts.length >= 3) {
                // For "openrouter/openai/gpt-4" → try "openai/gpt-4"
                const providerModel = parts.slice(-2).join('/');
                if (providerModel) {
                    lookupKeys.push(providerModel);
                }
            }

            // Always try just the model name (last part)
            const modelName = parts[parts.length - 1];
            if (modelName) {
                lookupKeys.push(modelName);

                // Also try common variations of the model name
                lookupKeys.push(
                    modelName.replace('-', '_'),
                    modelName.replace('_', '-')
                );
            }
        }

        // Try each lookup key in priority order
        for (const key of lookupKeys) {
            if (key && modelsConfig[key]) {
                return modelsConfig[key];
            }
        }

        return null;
    }

    /**
     * Extract tiktoken model name from model ID
     */
    protected getTiktokenModel(modelId: string): TiktokenModel {
        // Normalize modelId by removing any provider prefixes like "openrouter/", etc.
        // Keep only the last segment after '/'
        const modelName = modelId.includes('/') ? modelId.split('/').pop() : modelId;

        if (!modelName) {
            throw new Error(`Invalid model ID format: ${modelId}`);
        }

        return modelName as TiktokenModel;
    }

    /**
     * Count tokens in text using tiktoken or fallback estimation
     */
    protected countTokens(text: string): number {
        try {
            return this.encoding.encode(text).length;
        } catch (error) {
            // Fallback: rough estimation (1 token ≈ 4 characters)
            return Math.ceil(text.length / 4);
        }
    }

    /**
     * Calculate cost based on token usage
     */
    protected calculateCost(inputTokens: number, outputTokens: number): number {
        const inputRate = this.modelConfig?.input_cost_per_token ?? DEFAULT_INPUT_COST_PER_TOKEN;
        const outputRate = this.modelConfig?.output_cost_per_token ?? DEFAULT_OUTPUT_COST_PER_TOKEN;
        const inputCost = inputRate * inputTokens;
        const outputCost = outputRate * outputTokens;

        return inputCost + outputCost;
    }

    /**
     * Get default parameters based on model configuration
     */
    protected getDefaultParams() {
        if (!this.modelConfig) {
            return {
                maxTokensInput: 4000,
                maxTokensOutput: 2000,
                chunkOverlap: 200
            };
        }

        const config = this.modelConfig;
        const maxInputTokens = config.max_input_tokens || config.max_tokens || 4000;
        const maxOutputTokens = config.max_output_tokens || config.max_tokens || 2000;

        return {
            maxTokensInput: Math.floor(maxInputTokens * 0.8), // Use 80% for safety
            maxTokensOutput: maxOutputTokens,
            chunkOverlap: Math.min(200, Math.floor(maxInputTokens * 0.1)) // 10% overlap
        };
    }

    /**
     * Get model capabilities
     */
    public getModelCapabilities() {
        if (!this.modelConfig) {
            return {
                maxInputTokens: 4000,
                maxOutputTokens: 2000,
                supportsVision: false,
                supportsFunctionCalling: false,
                supportsStreaming: false,
                inputCostPerToken: 0,
                outputCostPerToken: 0
            };
        }

        const config = this.modelConfig;
        return {
            maxInputTokens: config.max_input_tokens || config.max_tokens || 4000,
            maxOutputTokens: config.max_output_tokens || config.max_tokens || 2000,
            supportsVision: config.supports_vision || false,
            supportsFunctionCalling: config.supports_function_calling || false,
            supportsStreaming: config.supports_native_streaming || false,
            inputCostPerToken: config.input_cost_per_token || 0,
            outputCostPerToken: config.output_cost_per_token || 0
        };
    }

    /**
     * Track a model call for cost tracking
     */
    protected trackCall(type: "extract" | "batch" | "merge" | string, metadata: Record<string, any>, inputTokens: number, outputTokens: number) {
        const cost = this.calculateCost(inputTokens, outputTokens);

        this.costTracking.addCall({
            type: type as any,
            metadata,
            cost,
            model: this.modelId,
            tokens: {
                input: inputTokens,
                output: outputTokens
            }
        });
    }

    // Cost tracking public methods
    public getCostTracking(): any {
        return this.costTracking.toJSON();
    }

    public printCostSummary(): void {
        this.costTracking.printSummary();
    }

    public getCostSummary(): string {
        return this.costTracking.formatSummary();
    }

    public resetCostTracking(): void {
        this.costTracking = new CostTracking(this.costTracking.limit);
    }

    // Model information methods
    public getModelId(): string {
        return this.modelId;
    }

    public getModelConfiguration(): ModelConfig | null {
        return this.modelConfig;
    }
} 
