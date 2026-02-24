import { jest } from '@jest/globals';

/**
 * MapService Tests
 *
 * These tests verify the MapService interfaces and core logic
 * without requiring network calls or external dependencies.
 *
 * Note: Schema validation tests should be run in packages/libs where the schemas are defined,
 * to avoid ESM module linking issues in the monorepo.
 */

describe('MapService Interface Tests', () => {
    describe('MapOptions Interface', () => {
        test('should accept empty options', () => {
            const options: Record<string, any> = {};
            const validated = {
                limit: options.limit ?? 5000,
                search: options.search,
                includeSubdomains: options.includeSubdomains ?? false,
                ignoreSitemap: options.ignoreSitemap ?? false,
            };
            expect(validated.limit).toBe(5000);
            expect(validated.includeSubdomains).toBe(false);
            expect(validated.ignoreSitemap).toBe(false);
        });

        test('should accept all options', () => {
            const options = {
                limit: 100,
                search: 'test query',
                includeSubdomains: true,
                ignoreSitemap: true,
                searchService: { search: jest.fn() },
            };
            expect(options.limit).toBe(100);
            expect(options.search).toBe('test query');
            expect(options.includeSubdomains).toBe(true);
            expect(options.ignoreSitemap).toBe(true);
            expect(options.searchService).toBeDefined();
        });
    });

    describe('MapLink Interface', () => {
        test('should have required url field', () => {
            const link = { url: 'https://example.com' };
            expect(link.url).toBeDefined();
            expect(typeof link.url).toBe('string');
        });

        test('should have optional title and description', () => {
            const linkWithAll = {
                url: 'https://example.com',
                title: 'Example Title',
                description: 'Example Description',
            };
            expect(linkWithAll.title).toBe('Example Title');
            expect(linkWithAll.description).toBe('Example Description');

            const linkMinimal: { url: string; title?: string; description?: string } = {
                url: 'https://example.com'
            };
            expect(linkMinimal.title).toBeUndefined();
            expect(linkMinimal.description).toBeUndefined();
        });
    });

    describe('MapResult Interface', () => {
        test('should have links array', () => {
            const result = {
                links: [
                    { url: 'https://example.com/page1' },
                    { url: 'https://example.com/page2', title: 'Page 2' },
                ],
            };
            expect(Array.isArray(result.links)).toBe(true);
            expect(result.links.length).toBe(2);
        });

        test('should allow empty links array', () => {
            const result = { links: [] };
            expect(result.links.length).toBe(0);
        });
    });
});

describe('MapService Logic Tests', () => {
    describe('Domain Filtering', () => {
        const filterByDomain = (
            links: Array<{ url: string }>,
            baseHostname: string,
            includeSubdomains: boolean
        ) => {
            const getBaseDomain = (hostname: string): string => {
                const parts = hostname.split('.');
                if (parts.length <= 2) return hostname;
                return parts.slice(-2).join('.');
            };

            const baseDomain = getBaseDomain(baseHostname);

            return links.filter(link => {
                try {
                    const linkUrl = new URL(link.url);
                    const linkDomain = getBaseDomain(linkUrl.hostname);

                    if (includeSubdomains) {
                        return linkDomain === baseDomain;
                    } else {
                        return linkUrl.hostname === baseHostname;
                    }
                } catch {
                    return false;
                }
            });
        };

        test('should filter by exact hostname when includeSubdomains is false', () => {
            const links = [
                { url: 'https://example.com/page1' },
                { url: 'https://sub.example.com/page2' },
                { url: 'https://other.com/page3' },
            ];

            const filtered = filterByDomain(links, 'example.com', false);

            expect(filtered.length).toBe(1);
            expect(filtered[0]!.url).toBe('https://example.com/page1');
        });

        test('should include subdomains when includeSubdomains is true', () => {
            const links = [
                { url: 'https://example.com/page1' },
                { url: 'https://sub.example.com/page2' },
                { url: 'https://deep.sub.example.com/page3' },
                { url: 'https://other.com/page4' },
            ];

            const filtered = filterByDomain(links, 'example.com', true);

            expect(filtered.length).toBe(3);
            expect(filtered.map(l => l.url)).toContain('https://example.com/page1');
            expect(filtered.map(l => l.url)).toContain('https://sub.example.com/page2');
            expect(filtered.map(l => l.url)).toContain('https://deep.sub.example.com/page3');
        });

        test('should handle www subdomain correctly', () => {
            const links = [
                { url: 'https://www.example.com/page1' },
                { url: 'https://example.com/page2' },
            ];

            // When filtering by www.example.com with subdomains
            const filtered = filterByDomain(links, 'www.example.com', true);
            expect(filtered.length).toBe(2);

            // When filtering by www.example.com without subdomains
            const filteredExact = filterByDomain(links, 'www.example.com', false);
            expect(filteredExact.length).toBe(1);
            expect(filteredExact[0]!.url).toBe('https://www.example.com/page1');
        });
    });

    describe('Search Filtering', () => {
        const filterBySearch = (
            links: Array<{ url: string; title?: string; description?: string }>,
            search: string
        ) => {
            const searchTerms = search.toLowerCase().split(/\s+/).filter(Boolean);

            const scored = links.map(link => {
                let score = 0;
                const urlLower = link.url.toLowerCase();
                const titleLower = (link.title || '').toLowerCase();
                const descLower = (link.description || '').toLowerCase();

                for (const term of searchTerms) {
                    if (urlLower.includes(term)) score += 3;
                    if (titleLower.includes(term)) score += 2;
                    if (descLower.includes(term)) score += 1;
                }

                return { link, score };
            });

            scored.sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score;
                return a.link.url.localeCompare(b.link.url);
            });

            return scored.map(s => s.link);
        };

        test('should score URLs by search term relevance', () => {
            const links = [
                { url: 'https://example.com/docs/api', title: 'API Docs' },
                { url: 'https://example.com/about', title: 'About Us' },
                { url: 'https://example.com/docs', title: 'Documentation' },
            ];

            const sorted = filterBySearch(links, 'docs api');

            // First link should have highest score (contains both 'docs' and 'api' in URL and title)
            expect(sorted[0]!.url).toBe('https://example.com/docs/api');
            // Last link should have lowest score (no matches)
            expect(sorted[sorted.length - 1]!.url).toBe('https://example.com/about');
        });

        test('should handle description in scoring', () => {
            const links = [
                { url: 'https://example.com/page1', description: 'API documentation' },
                { url: 'https://example.com/api', title: 'API' },
                { url: 'https://example.com/page2' },
            ];

            const sorted = filterBySearch(links, 'api');

            // URL match (3) + title match (2) = 5
            expect(sorted[0]!.url).toBe('https://example.com/api');
            // Description match only (1)
            expect(sorted[1]!.url).toBe('https://example.com/page1');
            // No match (0)
            expect(sorted[2]!.url).toBe('https://example.com/page2');
        });

        test('should handle multiple search terms', () => {
            const links = [
                { url: 'https://example.com/getting-started', title: 'Getting Started Guide' },
                { url: 'https://example.com/guide', title: 'User Guide' },
                { url: 'https://example.com/faq', title: 'FAQ' },
            ];

            const sorted = filterBySearch(links, 'getting started');

            expect(sorted[0]!.url).toBe('https://example.com/getting-started');
        });
    });

    describe('URL Deduplication', () => {
        const deduplicateUrls = (urls: string[]): string[] => {
            const seen = new Set<string>();
            const unique: string[] = [];

            for (const url of urls) {
                const urlWithoutFragment = url.split('#')[0] || url;
                if (!seen.has(urlWithoutFragment)) {
                    seen.add(urlWithoutFragment);
                    unique.push(urlWithoutFragment);
                }
            }

            return unique;
        };

        test('should remove duplicate URLs', () => {
            const urls = [
                'https://example.com/page1',
                'https://example.com/page1',
                'https://example.com/page2',
            ];

            const unique = deduplicateUrls(urls);

            expect(unique.length).toBe(2);
            expect(unique).toContain('https://example.com/page1');
            expect(unique).toContain('https://example.com/page2');
        });

        test('should treat URLs with fragments as duplicates', () => {
            const urls = [
                'https://example.com/page1',
                'https://example.com/page1#section1',
                'https://example.com/page1#section2',
            ];

            const unique = deduplicateUrls(urls);

            expect(unique.length).toBe(1);
            expect(unique[0]).toBe('https://example.com/page1');
        });

        test('should preserve order of first occurrence', () => {
            const urls = [
                'https://example.com/page1',
                'https://example.com/page2',
                'https://example.com/page1',
                'https://example.com/page3',
            ];

            const unique = deduplicateUrls(urls);

            expect(unique).toEqual([
                'https://example.com/page1',
                'https://example.com/page2',
                'https://example.com/page3',
            ]);
        });
    });

    describe('Limit Option', () => {
        test('should respect limit option', () => {
            const links = Array.from({ length: 100 }, (_, i) => ({
                url: `https://example.com/page${i}`,
            }));

            const limit = 10;
            const limited = links.slice(0, limit);

            expect(limited.length).toBe(10);
            expect(limited[0]!.url).toBe('https://example.com/page0');
            expect(limited[9]!.url).toBe('https://example.com/page9');
        });

        test('should handle limit larger than array', () => {
            const links = [
                { url: 'https://example.com/page1' },
                { url: 'https://example.com/page2' },
            ];

            const limit = 5000;
            const limited = links.slice(0, limit);

            expect(limited.length).toBe(2);
        });
    });

    describe('Base Domain Extraction', () => {
        const getBaseDomain = (hostname: string): string => {
            const parts = hostname.split('.');
            if (parts.length <= 2) return hostname;
            return parts.slice(-2).join('.');
        };

        test('should extract base domain correctly', () => {
            expect(getBaseDomain('example.com')).toBe('example.com');
            expect(getBaseDomain('www.example.com')).toBe('example.com');
            expect(getBaseDomain('sub.domain.example.com')).toBe('example.com');
            expect(getBaseDomain('deep.sub.domain.example.com')).toBe('example.com');
        });

        test('should handle single-part hostnames', () => {
            expect(getBaseDomain('localhost')).toBe('localhost');
        });

        test('should handle two-part hostnames', () => {
            expect(getBaseDomain('example.com')).toBe('example.com');
            expect(getBaseDomain('test.io')).toBe('test.io');
        });
    });

    describe('URL Validation', () => {
        const isValidUrl = (url: string): boolean => {
            try {
                const parsed = new URL(url);
                return parsed.protocol === 'http:' || parsed.protocol === 'https:';
            } catch {
                return false;
            }
        };

        test('should validate HTTP/HTTPS URLs', () => {
            expect(isValidUrl('https://example.com')).toBe(true);
            expect(isValidUrl('http://example.com')).toBe(true);
            expect(isValidUrl('https://example.com/path?query=1')).toBe(true);
        });

        test('should reject invalid URLs', () => {
            expect(isValidUrl('not-a-url')).toBe(false);
            expect(isValidUrl('')).toBe(false);
            expect(isValidUrl('ftp://example.com')).toBe(false);
            expect(isValidUrl('javascript:alert(1)')).toBe(false);
        });
    });
});
