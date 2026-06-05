import { createProviderRegistry, LanguageModel } from "ai";
import { createOpenAI, openai } from "@ai-sdk/openai";
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { aiConfig, getDefaultLLModelId, getEnabledModelIdByModelKey } from "./utils/helper.js";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

type ProviderRegistry = ReturnType<typeof createProviderRegistry>;

const separator = '/';
const atlasCloudBaseURL = 'https://api.atlascloud.ai/v1';
const evolinkBaseURL = 'https://direct.evolink.ai/v1';
let providerRegistry: ProviderRegistry;

// Extra headers for providers that support custom headers (e.g., OpenRouter)
const extraHeaders: Record<string, string> = {
    'HTTP-Referer': 'https://anycrawl.dev',
    'X-Title': 'AnyCrawl',
};


if (aiConfig) {
    // load from config
    const providers = aiConfig.providers;
    const providerInstances: Record<string, any> = {};
    Object.entries(providers).forEach(([key, provider]) => {
        const typedProvider = provider as {
            enabled: boolean;
            apiKey?: string;
            apiKeyEnv?: string;
            baseURL?: string;
            baseURLEnv?: string;
        };
        if (!typedProvider.enabled) {
            return;
        }

        const apiKey = typedProvider.apiKey ?? (typedProvider.apiKeyEnv ? process.env[typedProvider.apiKeyEnv] : null);
        const baseURL = typedProvider.baseURL
            ?? (typedProvider.baseURLEnv ? process.env[typedProvider.baseURLEnv] : null)
            ?? (key === 'atlascloud' ? atlasCloudBaseURL : key === 'evolink' ? evolinkBaseURL : null);

        if (apiKey && baseURL) {
            if (key === 'openai') {
                providerInstances[key] = createOpenAI({
                    apiKey,
                    baseURL,
                });
            } else if (key === 'openrouter') {
                providerInstances[key] = createOpenRouter({
                    apiKey,
                    headers: extraHeaders,
                });
            } else {
                // For any other provider, use openaiCompatible
                providerInstances[key] = createOpenAICompatible({
                    name: key,
                    baseURL,
                    apiKey,
                });
            }
        }
    });

    providerRegistry = createProviderRegistry(providerInstances, {
        separator,
    });

} else {
    // load from env
    const providerInstances: Record<string, any> = {};
    if (process.env.OPENAI_API_KEY) {
        providerInstances['openai'] = openai;
    }
    if (process.env.OPENROUTER_API_KEY) {
        providerInstances['openrouter'] = createOpenAICompatible({
            name: 'openrouter',
            baseURL: process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
            apiKey: process.env.OPENROUTER_API_KEY,
            headers: extraHeaders,
        });
    }
    if (process.env.ATLASCLOUD_API_KEY) {
        providerInstances['atlascloud'] = createOpenAICompatible({
            name: 'atlascloud',
            baseURL: process.env.ATLASCLOUD_BASE_URL ?? atlasCloudBaseURL,
            apiKey: process.env.ATLASCLOUD_API_KEY,
        });
    }
    if (process.env.EVOLINK_API_KEY) {
        providerInstances['evolink'] = createOpenAICompatible({
            name: 'evolink',
            baseURL: process.env.EVOLINK_BASE_URL ?? evolinkBaseURL,
            apiKey: process.env.EVOLINK_API_KEY,
        });
    }
    if (process.env.CUSTOM_API_KEY && process.env.CUSTOM_BASE_URL) {
        providerInstances['custom'] = createOpenAICompatible({
            name: 'custom',
            baseURL: process.env.CUSTOM_BASE_URL,
            apiKey: process.env.CUSTOM_API_KEY,
        });
    }
    providerRegistry = createProviderRegistry(providerInstances, {
        separator,
    });
}
const getLLM = (modelId: string): LanguageModel => {
    if (providerRegistry) {
        return providerRegistry.languageModel(modelId as never);
    }
    throw new Error('ProviderRegistry is not initialized');
}

const getDefaultLLM = (): LanguageModel => {
    return getLLM(getDefaultLLModelId());
}

const getLLMByModel = (modelKey: string): LanguageModel => {
    return getLLM(getEnabledModelIdByModelKey(modelKey));
}

export {
    providerRegistry,
    getLLM,
    getDefaultLLM,
    getLLMByModel
};
