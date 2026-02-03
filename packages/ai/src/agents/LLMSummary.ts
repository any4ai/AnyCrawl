import { generateText, NoObjectGeneratedError } from "ai";
import { BaseAgent } from "./BaseAgent.js";
import { TextChunker, ChunkResult } from "./TextChunker.js";
import { log } from "@anycrawl/libs";
import { SUMMARY_SYSTEM_PROMPT, buildSummaryPrompt } from "../prompts/summary.prompts.js";
import { CostTracking } from "./CostTracking.js";

interface SummaryOptions {
    maxTokensInput?: number;
    chunkOverlap?: number;
    systemPrompt?: string;
    costLimit?: number;
}

interface SummaryResult {
    summary: string;
    tokens: {
        input: number;
        output: number;
        total: number;
    };
    chunks: number;
    cost?: number;
    durationMs?: number;
}

class LLMSummary extends BaseAgent {
    private systemPrompt: string;
    private textChunker: TextChunker;

    constructor(modelId: string, prompt: string = SUMMARY_SYSTEM_PROMPT, costLimit: number | null = null) {
        super(modelId, costLimit);
        this.systemPrompt = prompt;
        this.textChunker = new TextChunker(this.countTokens.bind(this));
    }

    /**
     * Extract actual token usage from provider response if available
     */
    private extractUsageTokens(result: any, fallbackPromptText?: string, fallbackOutputText?: string): {
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
        const outputText = String(fallbackOutputText ?? '');
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
     * Merge multiple summaries into one
     */
    private async mergeSummaries(summaries: string[], options: SummaryOptions = {}): Promise<string> {
        if (summaries.length === 0) return '';
        if (summaries.length === 1) return summaries[0] ?? '';

        const mergePrompt = `You are given multiple summaries of different parts of the same document. Please combine them into a single coherent summary that captures all the key points without redundancy.

Summaries to merge:
${summaries.map((s, i) => `--- Part ${i + 1} ---\n${s}`).join('\n\n')}

Please provide a unified summary:`;

        try {
            const result = await generateText({
                model: this.llm,
                system: options.systemPrompt || this.systemPrompt || "",
                messages: [{ role: 'user', content: mergePrompt }],
            });

            return result.text || summaries.join('\n\n');
        } catch (error) {
            log.error(`Failed to merge summaries: ${error instanceof Error ? error.message : String(error)}`);
            // Fallback: concatenate summaries
            return summaries.join('\n\n');
        }
    }

    /**
     * Generate summary for the given content
     */
    async perform(text: string | string[], options: SummaryOptions = {}): Promise<SummaryResult> {
        const overallStart = Date.now();
        const scopedTracking = new CostTracking(this.costTracking.limit);
        const recordCall = (call: {
            type: "summary" | "merge";
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

        // Get default parameters based on model config
        const defaults = this.getDefaultParams();
        const {
            maxTokensInput = defaults.maxTokensInput,
            chunkOverlap = defaults.chunkOverlap
        } = options;

        const inputText = Array.isArray(text) ? text.join('\n') : text;
        const inputTokens = this.countTokens(inputText);

        log.debug(`📊 Model: ${this.modelId}`);
        log.debug(`📏 Input tokens: ${inputTokens}, Max input: ${maxTokensInput}`);

        // If text is short enough, process directly
        if (inputTokens <= maxTokensInput) {
            const fullPrompt = buildSummaryPrompt(inputText);
            log.debug(`🔍 Full prompt length: ${fullPrompt.length}`);

            try {
                const result = await generateText({
                    model: this.llm,
                    system: options.systemPrompt || this.systemPrompt || "",
                    messages: [{ role: 'user', content: fullPrompt }],
                });

                const systemPrompt = options.systemPrompt || this.systemPrompt || "";
                const usageTokens = this.extractUsageTokens(result, fullPrompt + systemPrompt, result.text);

                if (typeof usageTokens.providerCost === 'number') {
                    recordCall({
                        type: "summary",
                        metadata: { direct: true },
                        cost: usageTokens.providerCost,
                        model: this.modelId,
                        tokens: { input: usageTokens.inputTokens, output: usageTokens.outputTokens }
                    });
                } else {
                    recordCall({
                        type: "summary",
                        metadata: { direct: true },
                        cost: this.calculateCost(usageTokens.inputTokens, usageTokens.outputTokens),
                        model: this.modelId,
                        tokens: { input: usageTokens.inputTokens, output: usageTokens.outputTokens }
                    });
                }

                const totalDuration = Date.now() - overallStart;
                const finalResult: SummaryResult = {
                    summary: result.text || '',
                    tokens: {
                        input: usageTokens.inputTokens,
                        output: usageTokens.outputTokens,
                        total: usageTokens.totalTokens
                    },
                    chunks: 1,
                    cost: scopedTracking.getTotalCost(),
                    durationMs: totalDuration
                };

                log.info(`[summary] tokens(input=${finalResult.tokens.input}, output=${finalResult.tokens.output}, total=${finalResult.tokens.total}) cost=$${finalResult.cost?.toFixed(6)} duration=${totalDuration}ms model=${this.modelId} chunks=${finalResult.chunks}`);
                return finalResult;

            } catch (error) {
                log.error('Error during summarization:', {
                    error: error instanceof Error ? error.message : String(error)
                });
                throw error;
            }
        }

        // For longer text, use chunking
        log.debug(`📦 Text too long, splitting into chunks (max: ${maxTokensInput}, overlap: ${chunkOverlap})`);
        const allChunks = this.textChunker.splitMultipleTexts([inputText], {
            maxTokens: maxTokensInput,
            overlapTokens: chunkOverlap
        });

        const chunkSummaries: string[] = [];
        for (const [index, chunkInfo] of allChunks.entries()) {
            try {
                log.debug(`⚡ Processing chunk ${index + 1}/${allChunks.length} (${chunkInfo.tokens} tokens)`);
                const fullPrompt = buildSummaryPrompt(chunkInfo.chunk);

                const result = await generateText({
                    model: this.llm,
                    system: options.systemPrompt || this.systemPrompt || "",
                    messages: [{ role: 'user', content: fullPrompt }],
                });

                chunkSummaries.push(result.text || '');

                // Track tokens and cost for this chunk
                const systemPrompt = options.systemPrompt || this.systemPrompt || "";
                const usageTokens = this.extractUsageTokens(result, fullPrompt + systemPrompt, result.text);

                if (typeof usageTokens.providerCost === 'number') {
                    recordCall({
                        type: "summary",
                        metadata: { direct: false, chunkIndex: index + 1, totalChunks: allChunks.length },
                        cost: usageTokens.providerCost,
                        model: this.modelId,
                        tokens: { input: usageTokens.inputTokens, output: usageTokens.outputTokens }
                    });
                } else {
                    recordCall({
                        type: "summary",
                        metadata: { direct: false, chunkIndex: index + 1, totalChunks: allChunks.length },
                        cost: this.calculateCost(usageTokens.inputTokens, usageTokens.outputTokens),
                        model: this.modelId,
                        tokens: { input: usageTokens.inputTokens, output: usageTokens.outputTokens }
                    });
                }
            } catch (error) {
                log.error(`❌ Error processing chunk ${chunkInfo.startIndex}-${chunkInfo.endIndex}: ${error instanceof Error ? error.message : String(error)}`);
                chunkSummaries.push('');
            }
        }

        // Merge all chunk summaries
        const mergedSummary = await this.mergeSummaries(chunkSummaries.filter(s => s.length > 0), options);

        recordCall({
            type: "merge",
            metadata: { chunksCount: allChunks.length },
            cost: 0,
            model: this.modelId,
            tokens: { input: 0, output: 0 }
        });

        const totalTokens = scopedTracking.getTotalTokens();
        const totalDuration = Date.now() - overallStart;
        const finalResult: SummaryResult = {
            summary: mergedSummary,
            tokens: totalTokens,
            chunks: allChunks.length,
            cost: scopedTracking.getTotalCost(),
            durationMs: totalDuration
        };

        log.info(`[summary] tokens(input=${finalResult.tokens.input}, output=${finalResult.tokens.output}, total=${finalResult.tokens.total}) cost=$${finalResult.cost?.toFixed(6)} duration=${totalDuration}ms model=${this.modelId} chunks=${finalResult.chunks}`);
        return finalResult;
    }

    /**
     * Get chunk statistics for debugging
     */
    public analyzeChunking(text: string, options: SummaryOptions = {}): {
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

export { LLMSummary };

export type {
    SummaryOptions,
    SummaryResult
};
