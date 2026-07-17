import {
    clearApiKeyValidationCache,
    extractApiKey,
    normalizeApiKey,
    validateApiKey,
} from '../auth';
import { AnyCrawlClient } from '@anycrawl/js-sdk';

jest.mock('@anycrawl/js-sdk');

describe('auth', () => {
    beforeEach(() => {
        clearApiKeyValidationCache();
        jest.clearAllMocks();
    });

    describe('extractApiKey', () => {
        test('reads x-anycrawl-api-key header', () => {
            expect(extractApiKey({ 'x-anycrawl-api-key': ' sk-test ' })).toBe('sk-test');
        });

        test('reads Authorization Bearer header', () => {
            expect(extractApiKey({ authorization: 'Bearer sk-test' })).toBe('sk-test');
        });

        test('returns null when no key is present', () => {
            expect(extractApiKey({})).toBeNull();
        });
    });

    describe('normalizeApiKey', () => {
        test('rejects empty keys', () => {
            expect(() => normalizeApiKey('   ')).toThrow(/AnyCrawl API key is required/);
        });

        test('rejects placeholder keys', () => {
            expect(() => normalizeApiKey('{YOUR_API_KEY}')).toThrow(/placeholder/i);
            expect(() => normalizeApiKey('your-api-key')).toThrow(/placeholder/i);
        });

        test('returns trimmed key', () => {
            expect(normalizeApiKey('  sk-live-123  ')).toBe('sk-live-123');
        });
    });

    describe('validateApiKey', () => {
        test('accepts valid keys from healthCheck', async () => {
            (AnyCrawlClient as jest.Mock).mockImplementation(() => ({
                healthCheck: jest.fn().mockResolvedValue({ status: 'ok' }),
            }));

            await expect(validateApiKey('sk-valid')).resolves.toBeUndefined();
        });

        test('rejects invalid keys from healthCheck', async () => {
            (AnyCrawlClient as jest.Mock).mockImplementation(() => ({
                healthCheck: jest.fn().mockRejectedValue(new Error('Authentication failed: Invalid API key')),
            }));

            await expect(validateApiKey('sk-invalid')).rejects.toThrow(/Invalid AnyCrawl API key/);
        });

        test('uses cache for repeated validations', async () => {
            const healthCheck = jest.fn().mockResolvedValue({ status: 'ok' });
            (AnyCrawlClient as jest.Mock).mockImplementation(() => ({ healthCheck }));

            await validateApiKey('sk-valid');
            await validateApiKey('sk-valid');

            expect(healthCheck).toHaveBeenCalledTimes(1);
        });
    });
});
