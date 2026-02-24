// @anycrawl/ai - AI SDK Provider Management Module
// This module provides a unified interface for AI model creation
export * from './utils/helper.js';
// Re-export commonly used types from ai-sdk
export type {
    LanguageModel,
    EmbeddingModel,
    CoreMessage,
    GenerateTextResult,
    StreamTextResult,
    EmbedResult,
    JSONSchema7,
} from 'ai';

// Re-export commonly used functions from ai-sdk
export {
    generateText,
    generateObject,
    streamText,
    streamObject,
    embed,
} from 'ai';

export * from './ProviderRegistry.js';

export * from './agents/LLMExtract.js';
export * from './agents/LLMSummary.js';
export * from './agents/LLMOCR.js';

// Also export config loader helpers for consumers (e.g., scrape worker startup)
export { ensureAIConfigLoaded, getAIConfig } from './utils/config.js';
