import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

const originalEnv = { ...process.env };

const restoreEnv = () => {
    Object.keys(process.env).forEach((key) => {
        if (!(key in originalEnv)) {
            delete process.env[key];
        }
    });

    Object.assign(process.env, originalEnv);
}

describe('ProviderRegistry', () => {
    beforeEach(() => {
        jest.resetModules();
        restoreEnv();
        delete process.env.ANYCRAWL_AI_CONFIG_PATH;
        delete process.env.OPENAI_API_KEY;
        delete process.env.OPENROUTER_API_KEY;
        delete process.env.OPENROUTER_BASE_URL;
        delete process.env.ATLASCLOUD_API_KEY;
        delete process.env.ATLASCLOUD_BASE_URL;
        delete process.env.EVOLINK_API_KEY;
        delete process.env.EVOLINK_BASE_URL;
        delete process.env.CUSTOM_API_KEY;
        delete process.env.CUSTOM_BASE_URL;
        delete process.env.DEFAULT_LLM_MODEL;
        delete process.env.DEFAULT_EXTRACT_MODEL;
    });

    afterAll(() => {
        restoreEnv();
    });

    test('registers Atlas Cloud in env mode', async () => {
        process.env.ATLASCLOUD_API_KEY = 'test-atlas-key';

        const { getLLM } = await import('../ProviderRegistry.js');

        expect(getLLM('atlascloud/deepseek-v3')).toBeDefined();
    });

    test('registers Evolink in env mode', async () => {
        process.env.EVOLINK_API_KEY = 'test-evolink-key';

        const { getLLM } = await import('../ProviderRegistry.js');

        expect(getLLM('evolink/gpt-5.2')).toBeDefined();
    });

    test('keeps OpenAI and OpenRouter env registrations working', async () => {
        process.env.OPENAI_API_KEY = 'test-openai-key';
        process.env.OPENROUTER_API_KEY = 'test-openrouter-key';

        const { getLLM } = await import('../ProviderRegistry.js');

        expect(getLLM('openai/gpt-4o')).toBeDefined();
        expect(getLLM('openrouter/openai/gpt-4o-mini')).toBeDefined();
    });

    test('accepts provider-prefixed model ids that are not in modelsConfig', async () => {
        process.env.DEFAULT_LLM_MODEL = 'atlascloud/deepseek-v3';

        const { getAvailableModels, getDefaultLLModelId, getEnabledProviderModels } = await import('../utils/helper.js');

        expect(getDefaultLLModelId()).toBe('atlascloud/deepseek-v3');
        expect(getAvailableModels()).toEqual([
            {
                value: 'atlascloud/deepseek-v3',
                label: 'atlascloud/deepseek-v3',
            },
        ]);
        expect(getEnabledProviderModels()).toEqual([
            {
                modelName: 'atlascloud/deepseek-v3',
                displayName: 'atlascloud/deepseek-v3',
                provider: 'env',
                modelId: 'atlascloud/deepseek-v3',
            },
        ]);
    });

    test('uses the default Atlas Cloud base URL in config mode', async () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'anycrawl-atlascloud-'));
        const configPath = join(tmpDir, 'ai.config.json');

        try {
            writeFileSync(configPath, JSON.stringify({
                providers: {
                    atlascloud: {
                        enabled: true,
                        apiKeyEnv: 'ATLASCLOUD_API_KEY',
                    },
                },
                modelMapping: {
                    'deepseek-v3': {
                        displayName: 'DeepSeek V3',
                        providers: [
                            { provider: 'atlascloud', modelId: 'deepseek-v3' },
                        ],
                    },
                },
                defaults: {
                    DEFAULT_LLM_MODEL: 'deepseek-v3',
                    DEFAULT_EXTRACT_MODEL: 'deepseek-v3',
                },
            }));

            process.env.ANYCRAWL_AI_CONFIG_PATH = configPath;
            process.env.ATLASCLOUD_API_KEY = 'test-atlas-key';

            const { ensureAIConfigLoaded } = await import('../utils/config.js');
            await ensureAIConfigLoaded();

            const { refreshAIConfig } = await import('../utils/helper.js');
            refreshAIConfig();

            const { getLLM } = await import('../ProviderRegistry.js');

            expect(getLLM('atlascloud/deepseek-v3')).toBeDefined();
        } finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('uses the default Evolink base URL in config mode', async () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'anycrawl-evolink-'));
        const configPath = join(tmpDir, 'ai.config.json');

        try {
            writeFileSync(configPath, JSON.stringify({
                providers: {
                    evolink: {
                        enabled: true,
                        apiKeyEnv: 'EVOLINK_API_KEY',
                    },
                },
                modelMapping: {
                    'gpt-5.2': {
                        displayName: 'GPT-5.2',
                        providers: [
                            { provider: 'evolink', modelId: 'gpt-5.2' },
                        ],
                    },
                },
                defaults: {
                    DEFAULT_LLM_MODEL: 'gpt-5.2',
                    DEFAULT_EXTRACT_MODEL: 'gpt-5.2',
                },
            }));

            process.env.ANYCRAWL_AI_CONFIG_PATH = configPath;
            process.env.EVOLINK_API_KEY = 'test-evolink-key';

            const { ensureAIConfigLoaded } = await import('../utils/config.js');
            await ensureAIConfigLoaded();

            const { refreshAIConfig } = await import('../utils/helper.js');
            refreshAIConfig();

            const { getLLM } = await import('../ProviderRegistry.js');

            expect(getLLM('evolink/gpt-5.2')).toBeDefined();
        } finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
