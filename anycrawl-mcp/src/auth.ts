import { AnyCrawlClient } from '@anycrawl/js-sdk';
import { IncomingHttpHeaders } from 'http';

const PLACEHOLDER_KEYS = new Set([
    '{your_api_key}',
    '{your-api-key}',
    'your-api-key',
    'your_api_key',
    'your-api-key-here',
    'your_api_key_here',
]);

const VALID_KEY_CACHE_MS = 5 * 60 * 1000;
const INVALID_KEY_CACHE_MS = 60 * 1000;

interface KeyValidationCacheEntry {
    valid: boolean;
    expiresAt: number;
}

const keyValidationCache = new Map<string, KeyValidationCacheEntry>();

export function extractApiKey(headers: IncomingHttpHeaders): string | null {
    const anycrawlApiKey = headers['x-anycrawl-api-key'] || headers['X-AnyCrawl-Api-Key'];
    if (typeof anycrawlApiKey === 'string' && anycrawlApiKey.trim()) {
        return anycrawlApiKey.trim();
    }

    const authHeader = headers.authorization || headers.Authorization;
    if (typeof authHeader === 'string') {
        const match = authHeader.match(/^Bearer\s+(.+)$/i);
        if (match?.[1]) {
            return match[1].trim();
        }
        if (authHeader.trim()) {
            return authHeader.trim();
        }
    }

    return null;
}

export function normalizeApiKey(raw: string): string {
    const apiKey = raw.trim();
    if (!apiKey) {
        throw new Error(
            'AnyCrawl API key is required. Use /{API_KEY}/mcp or set Authorization: Bearer <key>'
        );
    }

    const normalized = apiKey.toLowerCase();
    if (PLACEHOLDER_KEYS.has(normalized) || apiKey.includes('{YOUR_API_KEY}') || apiKey.includes('{API_KEY}')) {
        throw new Error(
            'Invalid AnyCrawl API key placeholder. Replace {YOUR_API_KEY} with your real API key.'
        );
    }

    return apiKey;
}

export function clearApiKeyValidationCache(): void {
    keyValidationCache.clear();
}

export async function validateApiKey(apiKey: string, baseUrl?: string): Promise<void> {
    const normalizedKey = normalizeApiKey(apiKey);
    const cacheKey = `${baseUrl || 'https://api.anycrawl.dev'}:${normalizedKey}`;
    const cached = keyValidationCache.get(cacheKey);
    const now = Date.now();

    if (cached && cached.expiresAt > now) {
        if (!cached.valid) {
            throw new Error('Invalid AnyCrawl API key');
        }
        return;
    }

    try {
        const client = new AnyCrawlClient(normalizedKey, baseUrl);
        await client.healthCheck();
        keyValidationCache.set(cacheKey, {
            valid: true,
            expiresAt: now + VALID_KEY_CACHE_MS,
        });
    } catch (error) {
        keyValidationCache.set(cacheKey, {
            valid: false,
            expiresAt: now + INVALID_KEY_CACHE_MS,
        });

        const message = error instanceof Error ? error.message : String(error);
        if (/authentication failed/i.test(message)) {
            throw new Error('Invalid AnyCrawl API key');
        }
        throw new Error(`Unable to validate AnyCrawl API key: ${message}`);
    }
}
