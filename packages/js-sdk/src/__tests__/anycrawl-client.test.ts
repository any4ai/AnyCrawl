import { jest } from '@jest/globals';
import type { ScrapeRequest, CrawlRequest, SearchRequest } from '../types.js';
import type { AnyCrawlClient as AnyCrawlClientType } from '../index.js';
// ESM-compatible mocking: mock axios BEFORE importing the module under test
await jest.unstable_mockModule('axios', () => ({
    __esModule: true,
    default: { create: jest.fn() },
}));

const { AnyCrawlClient } = await import('../index.js');
const axios: any = (await import('axios')).default;
const mockedAxios = axios as { create: jest.Mock };

describe('AnyCrawlClient', () => {
    let client: AnyCrawlClientType;
    let mockAxiosInstance: any;
    let storedErrorHandler: ((err: any) => never) | null = null;

    beforeEach(() => {
        const delegateGet = jest.fn();
        const delegatePost = jest.fn();
        const delegateDelete = jest.fn();
        const delegatePut = jest.fn();
        const delegatePatch = jest.fn();
        const wrapRejection = (p: Promise<any>) =>
            p.catch((err: any) => {
                if (storedErrorHandler) {
                    try {
                        storedErrorHandler(err);
                    } catch (e) {
                        throw e;
                    }
                }
                throw err;
            });
        const wrapGet = jest.fn().mockImplementation((...args: any[]) =>
            wrapRejection(Promise.resolve(delegateGet(...args)))
        );
        const wrapPost = jest.fn().mockImplementation((...args: any[]) =>
            wrapRejection(Promise.resolve(delegatePost(...args)))
        );
        const wrapDelete = jest.fn().mockImplementation((...args: any[]) =>
            wrapRejection(Promise.resolve(delegateDelete(...args)))
        );
        const wrapPut = jest.fn().mockImplementation((...args: any[]) =>
            wrapRejection(Promise.resolve(delegatePut(...args)))
        );
        const wrapPatch = jest.fn().mockImplementation((...args: any[]) =>
            wrapRejection(Promise.resolve(delegatePatch(...args)))
        );
        Object.assign(wrapGet, { mockResolvedValueOnce: delegateGet.mockResolvedValueOnce.bind(delegateGet), mockRejectedValueOnce: delegateGet.mockRejectedValueOnce.bind(delegateGet) });
        Object.assign(wrapPost, { mockResolvedValueOnce: delegatePost.mockResolvedValueOnce.bind(delegatePost), mockRejectedValueOnce: delegatePost.mockRejectedValueOnce.bind(delegatePost) });
        Object.assign(wrapDelete, { mockResolvedValueOnce: delegateDelete.mockResolvedValueOnce.bind(delegateDelete), mockRejectedValueOnce: delegateDelete.mockRejectedValueOnce.bind(delegateDelete) });
        Object.assign(wrapPut, { mockResolvedValueOnce: delegatePut.mockResolvedValueOnce.bind(delegatePut), mockRejectedValueOnce: delegatePut.mockRejectedValueOnce.bind(delegatePut) });
        Object.assign(wrapPatch, { mockResolvedValueOnce: delegatePatch.mockResolvedValueOnce.bind(delegatePatch), mockRejectedValueOnce: delegatePatch.mockRejectedValueOnce.bind(delegatePatch) });
        mockAxiosInstance = {
            get: wrapGet,
            post: wrapPost,
            delete: wrapDelete,
            put: wrapPut,
            patch: wrapPatch,
            interceptors: {
                response: {
                    use: jest.fn((_ok: any, err: any) => {
                        storedErrorHandler = err;
                    }),
                },
            },
        };
        mockedAxios.create.mockReturnValue(mockAxiosInstance);
        client = new AnyCrawlClient('test-api-key', 'https://api.test.com');
        jest.clearAllMocks();
    });

    describe('constructor', () => {
        it('should initialize with default base URL', () => {
            const defaultClient = new AnyCrawlClient('test-key');
            expect(mockedAxios.create).toHaveBeenCalledWith({
                baseURL: 'https://api.anycrawl.dev',
                headers: {
                    'Authorization': 'Bearer test-key',
                    'Content-Type': 'application/json',
                },
                timeout: 300000,
            });
        });

        it('should initialize with custom base URL', () => {
            const customClient = new AnyCrawlClient('test-key', 'https://custom.api.com');
            expect(mockedAxios.create).toHaveBeenCalledWith({
                baseURL: 'https://custom.api.com',
                headers: {
                    'Authorization': 'Bearer test-key',
                    'Content-Type': 'application/json',
                },
                timeout: 300000,
            });
        });

        it('should not set onAuthFailure when constructor receives undefined', () => {
            const c = new AnyCrawlClient('key', 'https://api.test.com', undefined);
            c.setAuthFailureCallback(jest.fn());
            mockAxiosInstance.get.mockRejectedValueOnce({
                response: { status: 401, data: { error: 'Auth' } },
            });
            expect(c).toBeDefined();
        });
    });

    describe('healthCheck', () => {
        it('should return health status', async () => {
            const mockResponse = { data: { status: 'ok' } };
            mockAxiosInstance.get.mockResolvedValueOnce(mockResponse);

            const result = await client.healthCheck();

            expect(result).toEqual({ status: 'ok' });
            expect(mockAxiosInstance.get).toHaveBeenCalledWith('/health');
        });

        it('should handle health check errors', async () => {
            mockAxiosInstance.get.mockRejectedValueOnce(new Error('Network error'));

            await expect(client.healthCheck()).rejects.toThrow(/Network error/);
        });
    });

    describe('scrape', () => {
        it('should scrape a URL successfully with minimal options', async () => {
            const mockResponse = {
                data: {
                    success: true,
                    data: {
                        url: 'https://example.com',
                        status: 'completed',
                        jobId: 'test-job-id',
                        title: 'Test Page',
                        html: '<html>Test</html>',
                        markdown: '# Test Page',
                        metadata: [],
                        timestamp: '2024-01-01T00:00:00Z',
                    },
                },
            };
            mockAxiosInstance.post.mockResolvedValueOnce(mockResponse);

            const result = await client.scrape({
                url: 'https://example.com',
                engine: 'cheerio',
            });

            expect(result.url).toBe('https://example.com');
            expect(result.status).toBe('completed');
            expect(mockAxiosInstance.post).toHaveBeenCalledWith('/v1/scrape', {
                url: 'https://example.com',
                engine: 'cheerio',
            });
        });

        it('should scrape with all options', async () => {
            const mockResponse = {
                data: {
                    success: true,
                    data: {
                        url: 'https://example.com',
                        status: 'completed',
                    },
                },
            };
            mockAxiosInstance.post.mockResolvedValueOnce(mockResponse);

            const options: ScrapeRequest = {
                url: 'https://example.com',
                engine: 'playwright',
                template_id: 'tpl-1',
                variables: { foo: 'bar' },
                proxy: 'http://proxy.example.com:8080',
                formats: ['markdown', 'html', 'screenshot'],
                timeout: 60000,
                retry: true,
                wait_for: 3000,
                wait_until: 'networkidle',
                wait_for_selector: '.content',
                include_tags: ['article', 'main'],
                exclude_tags: ['nav', 'footer'],
                only_main_content: true,
                json_options: {
                    schema: { type: 'object' },
                    user_prompt: 'Extract article content',
                },
                extract_source: 'markdown',
                ocr_options: true,
                max_age: 3600,
                store_in_cache: true,
            };

            await client.scrape(options);

            expect(mockAxiosInstance.post).toHaveBeenCalledWith('/v1/scrape', options);
        });

        it('should throw error when scraping fails', async () => {
            const mockResponse = {
                data: {
                    success: false,
                    error: 'Scraping failed',
                },
            };
            mockAxiosInstance.post.mockResolvedValueOnce(mockResponse);

            await expect(
                client.scrape({
                    url: 'https://example.com',
                    engine: 'cheerio',
                })
            ).rejects.toThrow('Scraping failed');
        });

        it('should throw error when API returns no error message', async () => {
            const mockResponse = {
                data: {
                    success: false,
                },
            };
            mockAxiosInstance.post.mockResolvedValueOnce(mockResponse);

            await expect(
                client.scrape({
                    url: 'https://example.com',
                    engine: 'cheerio',
                })
            ).rejects.toThrow('Scraping failed');
        });
    });

    describe('createCrawl', () => {
        it('should create crawl job successfully with minimal options', async () => {
            const mockResponse = {
                data: {
                    success: true,
                    data: {
                        job_id: 'test-crawl-id',
                        status: 'created',
                        message: 'Crawl job created',
                    },
                },
            };
            mockAxiosInstance.post.mockResolvedValueOnce(mockResponse);

            const result = await client.createCrawl({
                url: 'https://example.com',
                engine: 'cheerio',
            });

            expect(result.job_id).toBe('test-crawl-id');
            expect(result.status).toBe('created');
            expect(mockAxiosInstance.post).toHaveBeenCalledWith('/v1/crawl', {
                url: 'https://example.com',
                engine: 'cheerio',
            });
        });

        it('should create crawl job with all options', async () => {
            const mockResponse = {
                data: {
                    success: true,
                    data: {
                        job_id: 'test-crawl-id',
                        status: 'created',
                        message: 'Crawl job created',
                    },
                },
            };
            mockAxiosInstance.post.mockResolvedValueOnce(mockResponse);

            const options: CrawlRequest = {
                url: 'https://example.com',
                engine: 'playwright',
                template_id: 'tpl-1',
                variables: { key: 'val' },
                scrape_paths: ['/blog/*'],
                // Scrape options should live inside scrape_options for crawl
                scrape_options: {
                    proxy: 'http://proxy.example.com:8080',
                    formats: ['markdown', 'html'],
                    timeout: 60000,
                    wait_for: 3000,
                    include_tags: ['article'],
                    exclude_tags: ['nav'],
                    json_options: { schema: { type: 'object' } },
                    extract_source: 'markdown',
                    ocr_options: true,
                    max_age: 3600,
                    store_in_cache: true,
                },
                // Retry remains a top-level crawl option
                retry: true,
                exclude_paths: ['/admin/*'],
                include_paths: ['/blog/*'],
                max_depth: 5,
                strategy: 'same-domain',
                limit: 50,
            };

            await client.createCrawl(options);

            expect(mockAxiosInstance.post).toHaveBeenCalledWith('/v1/crawl', expect.any(Object));
            const callArg = mockAxiosInstance.post.mock.calls[0][1];
            expect(callArg).toMatchObject({
                url: 'https://example.com',
                engine: 'playwright',
                exclude_paths: ['/admin/*'],
                include_paths: ['/blog/*'],
                max_depth: 5,
                strategy: 'same-domain',
                limit: 50,
                retry: true,
            });
            expect(callArg.scrape_options).toMatchObject({
                proxy: 'http://proxy.example.com:8080',
                formats: ['markdown', 'html'],
                timeout: 60000,
                wait_for: 3000,
                include_tags: ['article'],
                exclude_tags: ['nav'],
                json_options: { schema: { type: 'object' } },
            });
            expect(callArg.template_id).toBe('tpl-1');
            expect(callArg.variables).toEqual({ key: 'val' });
            expect(callArg.scrape_paths).toEqual(['/blog/*']);
        });

        it('should throw error when crawl creation fails', async () => {
            const mockResponse = {
                data: {
                    success: false,
                    error: 'Crawl creation failed',
                },
            };
            mockAxiosInstance.post.mockResolvedValueOnce(mockResponse);

            await expect(
                client.createCrawl({
                    url: 'https://example.com',
                    engine: 'cheerio',
                })
            ).rejects.toThrow('Crawl creation failed');
        });
    });

    describe('getCrawlStatus', () => {
        it('should get crawl status successfully', async () => {
            const mockResponse = {
                data: {
                    success: true,
                    data: {
                        job_id: 'test-crawl-id',
                        status: 'completed',
                        start_time: '2024-01-01T00:00:00Z',
                        expires_at: '2024-01-02T00:00:00Z',
                        credits_used: 10,
                        total: 100,
                        completed: 95,
                        failed: 5,
                    },
                },
            };
            mockAxiosInstance.get.mockResolvedValueOnce(mockResponse);

            const result = await client.getCrawlStatus('test-crawl-id');

            expect(result.job_id).toBe('test-crawl-id');
            expect(result.status).toBe('completed');
            expect(mockAxiosInstance.get).toHaveBeenCalledWith('/v1/crawl/test-crawl-id/status');
        });

        it('should throw error when getting status fails', async () => {
            const mockResponse = {
                data: {
                    success: false,
                    error: 'Failed to get crawl status',
                },
            };
            mockAxiosInstance.get.mockResolvedValueOnce(mockResponse);

            await expect(client.getCrawlStatus('test-crawl-id')).rejects.toThrow('Failed to get crawl status');
        });
    });

    describe('getCrawlResults', () => {
        it('should get crawl results successfully', async () => {
            const mockResponse = {
                data: {
                    status: 'completed',
                    total: 100,
                    completed: 100,
                    creditsUsed: 10,
                    data: [{ url: 'https://example.com', title: 'Test' }],
                },
            };
            mockAxiosInstance.get.mockResolvedValueOnce(mockResponse);

            const result = await client.getCrawlResults('test-crawl-id');

            expect(result.status).toBe('completed');
            expect(result.total).toBe(100);
            expect(mockAxiosInstance.get).toHaveBeenCalledWith('/v1/crawl/test-crawl-id?skip=0');
        });

        it('should get crawl results with skip parameter', async () => {
            const mockResponse = {
                data: {
                    status: 'completed',
                    total: 100,
                    completed: 100,
                    creditsUsed: 10,
                    data: [],
                },
            };
            mockAxiosInstance.get.mockResolvedValueOnce(mockResponse);

            await client.getCrawlResults('test-crawl-id', 50);

            expect(mockAxiosInstance.get).toHaveBeenCalledWith('/v1/crawl/test-crawl-id?skip=50');
        });

        it('should use credits_used when creditsUsed is missing', async () => {
            const mockResponse = {
                data: {
                    status: 'completed',
                    total: 10,
                    completed: 10,
                    credits_used: 5,
                    data: [],
                },
            };
            mockAxiosInstance.get.mockResolvedValueOnce(mockResponse);

            const result = await client.getCrawlResults('test-crawl-id');
            expect(result.creditsUsed).toBe(5);
        });

        it('should throw raw.message when raw.error is missing', async () => {
            mockAxiosInstance.get.mockResolvedValueOnce({
                data: { success: false, message: 'Custom failure' },
            });

            await expect(client.getCrawlResults('job-1')).rejects.toThrow('Custom failure');
        });

        it('should normalize invalid skip to 0', async () => {
            mockAxiosInstance.get.mockResolvedValueOnce({
                data: { status: 'completed', total: 0, completed: 0, data: [] },
            });

            await client.getCrawlResults('job-1', -10);
            expect(mockAxiosInstance.get).toHaveBeenCalledWith('/v1/crawl/job-1?skip=0');
        });
    });

    describe('cancelCrawl', () => {
        it('should cancel crawl successfully', async () => {
            const mockResponse = {
                data: {
                    success: true,
                    data: {
                        job_id: 'test-crawl-id',
                        status: 'cancelled',
                    },
                },
            };
            mockAxiosInstance.delete.mockResolvedValueOnce(mockResponse);

            const result = await client.cancelCrawl('test-crawl-id');

            expect(result.job_id).toBe('test-crawl-id');
            expect(result.status).toBe('cancelled');
            expect(mockAxiosInstance.delete).toHaveBeenCalledWith('/v1/crawl/test-crawl-id');
        });

        it('should throw error when cancellation fails', async () => {
            const mockResponse = {
                data: {
                    success: false,
                    error: 'Failed to cancel crawl',
                },
            };
            mockAxiosInstance.delete.mockResolvedValueOnce(mockResponse);

            await expect(client.cancelCrawl('test-crawl-id')).rejects.toThrow('Failed to cancel crawl');
        });
    });

    describe('search', () => {
        it('should search successfully with minimal options', async () => {
            const mockResponse = {
                data: {
                    success: true,
                    data: [
                        {
                            title: 'Test Result',
                            url: 'https://example.com',
                            description: 'Test description',
                            source: 'google',
                        },
                    ],
                },
            };
            mockAxiosInstance.post.mockResolvedValueOnce(mockResponse);

            const result = await client.search({
                query: 'test query',
                scrape_options: { engine: 'cheerio' },
            });

            expect(result).toHaveLength(1);
            expect(result[0]?.title).toBe('Test Result');
            expect(mockAxiosInstance.post).toHaveBeenCalledWith('/v1/search', {
                query: 'test query',
                scrape_options: { engine: 'cheerio' },
            });
        });

        it('should search with all options', async () => {
            const mockResponse = {
                data: {
                    success: true,
                    data: [],
                },
            };
            mockAxiosInstance.post.mockResolvedValueOnce(mockResponse);

            const options: SearchRequest = {
                query: 'test query',
                engine: 'google',
                limit: 20,
                offset: 10,
                pages: 2,
                lang: 'en',
                country: 'US',
                template_id: 'tpl-1',
                variables: { foo: 'bar' },
                scrape_options: { engine: 'playwright' },
                safe_search: 1,
            };

            await client.search(options);

            expect(mockAxiosInstance.post).toHaveBeenCalledWith('/v1/search', options);
        });

        it('should throw error when search fails', async () => {
            const mockResponse = {
                data: {
                    success: false,
                    error: 'Search failed',
                },
            };
            mockAxiosInstance.post.mockResolvedValueOnce(mockResponse);

            await expect(
                client.search({
                    query: 'test query',
                    scrape_options: { engine: 'cheerio' },
                })
            ).rejects.toThrow('Search failed');
        });
    });

    describe('map', () => {
        it('should map a URL successfully', async () => {
            const mockResponse = {
                data: {
                    success: true,
                    data: [
                        { url: 'https://example.com/page1', title: 'Page 1' },
                        { url: 'https://example.com/page2', title: 'Page 2' },
                    ],
                },
            };
            mockAxiosInstance.post.mockResolvedValueOnce(mockResponse);

            const result = await client.map({
                url: 'https://example.com',
                limit: 100,
            });

            expect(result.links).toHaveLength(2);
            expect(result.links[0]).toEqual({ url: 'https://example.com/page1', title: 'Page 1' });
            expect(mockAxiosInstance.post).toHaveBeenCalledWith('/v1/map', {
                url: 'https://example.com',
                limit: 100,
            });
        });

        it('should map with all options', async () => {
            const mockResponse = { data: { success: true, data: [] } };
            mockAxiosInstance.post.mockResolvedValueOnce(mockResponse);

            await client.map({
                url: 'https://example.com',
                limit: 50,
                include_subdomains: true,
                ignore_sitemap: true,
            });

            expect(mockAxiosInstance.post).toHaveBeenCalledWith('/v1/map', {
                url: 'https://example.com',
                limit: 50,
                include_subdomains: true,
                ignore_sitemap: true,
            });
        });

        it('should throw error when map fails', async () => {
            mockAxiosInstance.post.mockResolvedValueOnce({
                data: { success: false, error: 'Map request failed' },
            });

            await expect(client.map({ url: 'https://example.com' })).rejects.toThrow('Map request failed');
        });

        it('should return empty links when API returns null data', async () => {
            const mockResponse = {
                data: {
                    success: true,
                    data: null,
                },
            };
            mockAxiosInstance.post.mockResolvedValueOnce(mockResponse);

            const result = await client.map({ url: 'https://example.com' });

            expect(result.links).toEqual([]);
        });
    });

    describe('crawl (blocking)', () => {
        it('should create crawl, poll until completed, and aggregate results', async () => {
            mockAxiosInstance.post.mockResolvedValueOnce({
                data: { success: true, data: { job_id: 'job-1', status: 'created', message: 'Created' } },
            });
            mockAxiosInstance.get
                .mockResolvedValueOnce({
                    data: {
                        success: true,
                        data: {
                            job_id: 'job-1',
                            status: 'pending',
                            start_time: '2024-01-01T00:00:00Z',
                            expires_at: '2024-01-02T00:00:00Z',
                            credits_used: 0,
                            total: 2,
                            completed: 0,
                            failed: 0,
                        },
                    },
                })
                .mockResolvedValueOnce({
                    data: {
                        success: true,
                        data: {
                            job_id: 'job-1',
                            status: 'completed',
                            start_time: '2024-01-01T00:00:00Z',
                            expires_at: '2024-01-02T00:00:00Z',
                            credits_used: 2,
                            total: 2,
                            completed: 2,
                            failed: 0,
                        },
                    },
                });
            mockAxiosInstance.get.mockResolvedValueOnce({
                data: {
                    success: true,
                    status: 'completed',
                    total: 2,
                    completed: 2,
                    credits_used: 2,
                    data: [
                        { url: 'https://example.com/1', title: 'Page 1' },
                        { url: 'https://example.com/2', title: 'Page 2' },
                    ],
                },
            });

            const result = await client.crawl(
                { url: 'https://example.com', engine: 'cheerio', limit: 10 },
                1,
                5000
            );

            expect(result.job_id).toBe('job-1');
            expect(result.status).toBe('completed');
            expect(result.total).toBe(2);
            expect(result.data).toHaveLength(2);
            expect(result.data[0]).toEqual({ url: 'https://example.com/1', title: 'Page 1' });
        });

        it('should throw when crawl fails', async () => {
            mockAxiosInstance.post.mockResolvedValueOnce({
                data: { success: true, data: { job_id: 'job-1', status: 'created', message: 'Created' } },
            });
            mockAxiosInstance.get.mockResolvedValueOnce({
                data: {
                    success: true,
                    data: {
                        job_id: 'job-1',
                        status: 'failed',
                        start_time: '2024-01-01T00:00:00Z',
                        expires_at: '2024-01-02T00:00:00Z',
                        credits_used: 0,
                        total: 0,
                        completed: 0,
                        failed: 0,
                    },
                },
            });

            await expect(
                client.crawl({ url: 'https://example.com', engine: 'cheerio' }, 1)
            ).rejects.toThrow('Crawl failed (job_id=job-1)');
        });

        it('should throw when crawl times out', async () => {
            mockAxiosInstance.post.mockResolvedValueOnce({
                data: { success: true, data: { job_id: 'job-1', status: 'created', message: 'Created' } },
            });
            mockAxiosInstance.get.mockResolvedValue({
                data: {
                    success: true,
                    data: {
                        job_id: 'job-1',
                        status: 'pending',
                        start_time: '2024-01-01T00:00:00Z',
                        expires_at: '2024-01-02T00:00:00Z',
                        credits_used: 0,
                        total: 10,
                        completed: 0,
                        failed: 0,
                    },
                },
            });

            await expect(
                client.crawl({ url: 'https://example.com', engine: 'cheerio' }, 1, 200)
            ).rejects.toThrow(/Crawl timed out after 200ms \(job_id=job-1\)/);
        });

        it('should handle crawl results page with empty data array', async () => {
            mockAxiosInstance.post.mockResolvedValueOnce({
                data: { success: true, data: { job_id: 'job-1', status: 'created', message: 'Created' } },
            });
            mockAxiosInstance.get
                .mockResolvedValueOnce({
                    data: {
                        success: true,
                        data: {
                            job_id: 'job-1',
                            status: 'completed',
                            start_time: '',
                            expires_at: '',
                            credits_used: 0,
                            total: 0,
                            completed: 0,
                            failed: 0,
                        },
                    },
                })
                .mockResolvedValueOnce({
                    data: {
                        success: true,
                        status: 'completed',
                        total: 0,
                        completed: 0,
                        credits_used: 0,
                        data: [],
                    },
                });

            const result = await client.crawl(
                { url: 'https://example.com', engine: 'cheerio', limit: 10 },
                1
            );

            expect(result.data).toHaveLength(0);
            expect(result.total).toBe(0);
        });

        it('should return partial data when crawl is cancelled', async () => {
            mockAxiosInstance.post.mockResolvedValueOnce({
                data: { success: true, data: { job_id: 'job-1', status: 'created', message: 'Created' } },
            });
            mockAxiosInstance.get
                .mockResolvedValueOnce({
                    data: {
                        success: true,
                        data: {
                            job_id: 'job-1',
                            status: 'cancelled',
                            start_time: '2024-01-01T00:00:00Z',
                            expires_at: '2024-01-02T00:00:00Z',
                            credits_used: 1,
                            total: 5,
                            completed: 1,
                            failed: 0,
                        },
                    },
                })
                .mockResolvedValueOnce({
                    data: {
                        success: true,
                        status: 'cancelled',
                        total: 5,
                        completed: 1,
                        credits_used: 1,
                        data: [{ url: 'https://example.com/1', title: 'Page 1' }],
                    },
                });

            const result = await client.crawl(
                { url: 'https://example.com', engine: 'cheerio', limit: 10 },
                1
            );

            expect(result.job_id).toBe('job-1');
            expect(result.status).toBe('cancelled');
            expect(result.data).toHaveLength(1);
            expect(result.data[0]).toEqual({ url: 'https://example.com/1', title: 'Page 1' });
        });
    });

    describe('scheduled tasks', () => {
        it('should create scheduled task', async () => {
            mockAxiosInstance.post.mockResolvedValueOnce({
                data: {
                    success: true,
                    data: { task_id: 'task-1', next_execution_at: '2024-01-02T09:00:00Z' },
                },
            });

            const result = await client.createScheduledTask({
                name: 'Daily scrape',
                cron_expression: '0 9 * * *',
                task_type: 'scrape',
                task_payload: { url: 'https://example.com', engine: 'cheerio' },
            });

            expect(result.task_id).toBe('task-1');
            expect(result.next_execution_at).toBe('2024-01-02T09:00:00Z');
            expect(mockAxiosInstance.post).toHaveBeenCalledWith('/v1/scheduled-tasks', expect.any(Object));
        });

        it('should list scheduled tasks', async () => {
            mockAxiosInstance.get.mockResolvedValueOnce({
                data: {
                    success: true,
                    data: [{ task_id: 'task-1', name: 'Test' }],
                },
            });

            const tasks = await client.listScheduledTasks();
            expect(tasks).toHaveLength(1);
            expect(tasks[0]).toEqual({ task_id: 'task-1', name: 'Test' });
            expect(mockAxiosInstance.get).toHaveBeenCalledWith('/v1/scheduled-tasks');
        });

        it('should get and update scheduled task', async () => {
            mockAxiosInstance.get.mockResolvedValueOnce({
                data: { success: true, data: { task_id: 'task-1', name: 'Test' } },
            });
            mockAxiosInstance.put.mockResolvedValueOnce({
                data: { success: true, data: { task_id: 'task-1', cron_expression: '0 10 * * *' } },
            });

            const task = await client.getScheduledTask('task-1');
            expect(task.task_id).toBe('task-1');

            const updated = await client.updateScheduledTask('task-1', { cron_expression: '0 10 * * *' });
            expect(updated.cron_expression).toBe('0 10 * * *');
        });

        it('should pause and resume scheduled task', async () => {
            mockAxiosInstance.patch.mockResolvedValueOnce({ data: { success: true } });
            mockAxiosInstance.patch.mockResolvedValueOnce({ data: { success: true } });

            await client.pauseScheduledTask('task-1', 'Maintenance');
            await client.resumeScheduledTask('task-1');

            expect(mockAxiosInstance.patch).toHaveBeenCalledWith(
                '/v1/scheduled-tasks/task-1/pause',
                { reason: 'Maintenance' }
            );
            expect(mockAxiosInstance.patch).toHaveBeenCalledWith('/v1/scheduled-tasks/task-1/resume');
        });

        it('should pause scheduled task without reason', async () => {
            mockAxiosInstance.patch.mockResolvedValueOnce({ data: { success: true } });

            await client.pauseScheduledTask('task-1');

            expect(mockAxiosInstance.patch).toHaveBeenCalledWith(
                '/v1/scheduled-tasks/task-1/pause',
                {}
            );
        });

        it('should get task executions without params', async () => {
            mockAxiosInstance.get.mockResolvedValueOnce({
                data: { success: true, data: [], meta: { limit: 20, offset: 0 } },
            });

            const { data, meta } = await client.getScheduledTaskExecutions('task-1');
            expect(data).toEqual([]);
            expect(meta).toEqual({ limit: 20, offset: 0 });
            expect(mockAxiosInstance.get).toHaveBeenCalledWith('/v1/scheduled-tasks/task-1/executions');
        });

        it('should delete scheduled task', async () => {
            mockAxiosInstance.delete.mockResolvedValueOnce({ data: { success: true } });

            await client.deleteScheduledTask('task-1');

            expect(mockAxiosInstance.delete).toHaveBeenCalledWith('/v1/scheduled-tasks/task-1');
        });

        it('should get task executions and cancel execution', async () => {
            mockAxiosInstance.get.mockResolvedValueOnce({
                data: { success: true, data: [{ execution_id: 'exec-1' }], meta: { limit: 10, offset: 0 } },
            });
            mockAxiosInstance.delete.mockResolvedValueOnce({ data: { success: true } });

            const { data } = await client.getScheduledTaskExecutions('task-1', { limit: 10, offset: 0 });
            expect(data).toHaveLength(1);
            expect(data[0]).toEqual({ execution_id: 'exec-1' });

            await client.cancelScheduledTaskExecution('task-1', 'exec-1');
            expect(mockAxiosInstance.delete).toHaveBeenCalledWith(
                '/v1/scheduled-tasks/task-1/executions/exec-1'
            );
        });
    });

    describe('webhooks', () => {
        it('should create webhook', async () => {
            mockAxiosInstance.post.mockResolvedValueOnce({
                data: {
                    success: true,
                    data: {
                        webhook_id: 'wh-1',
                        secret: 'secret-xyz',
                        message: 'Webhook created',
                    },
                },
            });

            const result = await client.createWebhook({
                name: 'My webhook',
                webhook_url: 'https://example.com/webhook',
                event_types: ['scrape.completed'],
            });

            expect(result.webhook_id).toBe('wh-1');
            expect(result.secret).toBe('secret-xyz');
        });

        it('should list and get webhook', async () => {
            mockAxiosInstance.get.mockResolvedValueOnce({
                data: { success: true, data: [{ webhook_id: 'wh-1', name: 'Test' }] },
            });
            mockAxiosInstance.get.mockResolvedValueOnce({
                data: { success: true, data: { webhook_id: 'wh-1', name: 'Test' } },
            });

            const webhooks = await client.listWebhooks();
            expect(webhooks).toHaveLength(1);

            const webhook = await client.getWebhook('wh-1');
            expect(webhook.webhook_id).toBe('wh-1');
        });

        it('should update and delete webhook', async () => {
            mockAxiosInstance.put.mockResolvedValueOnce({ data: { success: true } });
            mockAxiosInstance.delete.mockResolvedValueOnce({ data: { success: true } });

            await client.updateWebhook('wh-1', { event_types: ['crawl.completed'] });
            await client.deleteWebhook('wh-1');

            expect(mockAxiosInstance.put).toHaveBeenCalledWith('/v1/webhooks/wh-1', {
                event_types: ['crawl.completed'],
            });
            expect(mockAxiosInstance.delete).toHaveBeenCalledWith('/v1/webhooks/wh-1');
        });

        it('should get webhook deliveries without params', async () => {
            mockAxiosInstance.get.mockResolvedValueOnce({
                data: { success: true, data: [], meta: {} },
            });

            const { data } = await client.getWebhookDeliveries('wh-1');
            expect(data).toEqual([]);
            expect(mockAxiosInstance.get).toHaveBeenCalledWith('/v1/webhooks/wh-1/deliveries');
        });

        it('should default to empty array when deliveries data is null', async () => {
            mockAxiosInstance.get.mockResolvedValueOnce({
                data: { success: true, data: null },
            });

            const { data } = await client.getWebhookDeliveries('wh-1');
            expect(data).toEqual([]);
        });

        it('should get deliveries, test, activate, deactivate, replay', async () => {
            mockAxiosInstance.get.mockResolvedValueOnce({
                data: {
                    success: true,
                    data: [{ delivery_id: 'd1', status: 'failed' }],
                    meta: { limit: 20, offset: 0 },
                },
            });
            mockAxiosInstance.post.mockResolvedValueOnce({ data: { success: true } });
            mockAxiosInstance.put.mockResolvedValueOnce({ data: { success: true } });
            mockAxiosInstance.put.mockResolvedValueOnce({ data: { success: true } });
            mockAxiosInstance.post.mockResolvedValueOnce({ data: { success: true } });

            const { data } = await client.getWebhookDeliveries('wh-1', { limit: 20, status: 'failed' });
            expect(data).toHaveLength(1);

            await client.testWebhook('wh-1');
            await client.activateWebhook('wh-1');
            await client.deactivateWebhook('wh-1');
            await client.replayWebhookDelivery('wh-1', 'd1');

            expect(mockAxiosInstance.post).toHaveBeenCalledWith('/v1/webhooks/wh-1/test');
            expect(mockAxiosInstance.put).toHaveBeenCalledWith('/v1/webhooks/wh-1/activate');
            expect(mockAxiosInstance.put).toHaveBeenCalledWith('/v1/webhooks/wh-1/deactivate');
            expect(mockAxiosInstance.post).toHaveBeenCalledWith('/v1/webhooks/wh-1/deliveries/d1/replay');
        });

        it('should get webhook events', async () => {
            mockAxiosInstance.get.mockResolvedValueOnce({
                data: {
                    success: true,
                    data: {
                        event_types: ['scrape.completed', 'crawl.completed'],
                        categories: { scrape: ['scrape.completed'] },
                    },
                },
            });

            const events = await client.getWebhookEvents();
            expect(events.event_types).toContain('scrape.completed');
            expect(events.categories).toEqual({ scrape: ['scrape.completed'] });
            expect(mockAxiosInstance.get).toHaveBeenCalledWith('/v1/webhook-events');
        });

        it('should get webhook events with null payload defaults', async () => {
            mockAxiosInstance.get.mockResolvedValueOnce({
                data: { success: true, data: null },
            });

            const events = await client.getWebhookEvents();
            expect(events.event_types).toEqual([]);
            expect(events.categories).toEqual({});
        });
    });

    describe('getCrawlResults error', () => {
        it('should throw when raw.success is false', async () => {
            mockAxiosInstance.get.mockResolvedValueOnce({
                data: { success: false, error: 'Failed to get crawl results' },
            });

            await expect(client.getCrawlResults('job-1')).rejects.toThrow('Failed to get crawl results');
        });

        it('should throw when raw is null', async () => {
            mockAxiosInstance.get.mockResolvedValueOnce({ data: null });

            await expect(client.getCrawlResults('job-1')).rejects.toThrow('Failed to get crawl results');
        });

        it('should use fallback when raw has success false but no error or message', async () => {
            mockAxiosInstance.get.mockResolvedValueOnce({
                data: { success: false },
            });

            await expect(client.getCrawlResults('job-1')).rejects.toThrow('Failed to get crawl results');
        });
    });

    describe('error handling', () => {
        it('should handle network errors', async () => {
            const networkError = new Error('Network error');
            mockAxiosInstance.get.mockRejectedValueOnce(networkError);

            await expect(client.healthCheck()).rejects.toThrow(/Network error/);
        });

        it('should handle API errors with response', async () => {
            const apiError = {
                response: {
                    status: 400,
                    data: { error: 'Bad Request' },
                },
            };
            mockAxiosInstance.get.mockRejectedValueOnce(apiError);

            await expect(client.healthCheck()).rejects.toThrow('API Error 400: Bad Request');
        });

        it('should handle API errors with message', async () => {
            const apiError = {
                response: {
                    status: 500,
                    data: { message: 'Internal Server Error' },
                },
            };
            mockAxiosInstance.get.mockRejectedValueOnce(apiError);

            await expect(client.healthCheck()).rejects.toThrow('API Error 500: Internal Server Error');
        });

        it('should handle API errors with unknown error', async () => {
            const apiError = {
                response: {
                    status: 500,
                    data: {},
                },
            };
            mockAxiosInstance.get.mockRejectedValueOnce(apiError);

            await expect(client.healthCheck()).rejects.toThrow('API Error 500: Unknown error');
        });

        it('should handle request errors', async () => {
            const requestError = {
                request: {},
                message: 'Request timeout',
            };
            mockAxiosInstance.get.mockRejectedValueOnce(requestError);

            await expect(client.healthCheck()).rejects.toThrow('Network error: Unable to reach AnyCrawl API');
        });

        it('should handle other errors', async () => {
            const otherError = new Error('Other error');
            mockAxiosInstance.get.mockRejectedValueOnce(otherError);

            await expect(client.healthCheck()).rejects.toThrow('Request error: Other error');
        });

        it('should invoke onAuthFailure on 401 and throw auth error', async () => {
            const onAuthFailure = jest.fn();
            const clientWithCallback = new AnyCrawlClient('key', 'https://api.test.com', onAuthFailure);
            mockAxiosInstance.get.mockRejectedValueOnce({
                response: { status: 401, data: { error: 'Invalid API key' } },
            });

            await expect(clientWithCallback.healthCheck()).rejects.toThrow('Authentication failed: Invalid API key');
            expect(onAuthFailure).toHaveBeenCalledTimes(1);
        });

        it('should throw on 401 without invoking when onAuthFailure is not set', async () => {
            const c = new AnyCrawlClient('key', 'https://api.test.com');
            mockAxiosInstance.get.mockRejectedValueOnce({
                response: { status: 401, data: { error: 'Invalid API key' } },
            });

            await expect(c.healthCheck()).rejects.toThrow('Authentication failed: Invalid API key');
        });

        it('should invoke onAuthFailure on 403 and throw auth error', async () => {
            const onAuthFailure = jest.fn();
            const clientWithCallback = new AnyCrawlClient('key', 'https://api.test.com', onAuthFailure);
            mockAxiosInstance.get.mockRejectedValueOnce({
                response: { status: 403, data: { error: 'Forbidden' } },
            });

            await expect(clientWithCallback.healthCheck()).rejects.toThrow('Authentication failed: Forbidden');
            expect(onAuthFailure).toHaveBeenCalledTimes(1);
        });

        it('should throw specialized message for 402 with current_credits', async () => {
            mockAxiosInstance.get.mockRejectedValueOnce({
                response: {
                    status: 402,
                    data: { error: 'Insufficient credits', current_credits: 0 },
                },
            });

            await expect(client.healthCheck()).rejects.toThrow(
                'Payment required: Insufficient credits. current_credits=0'
            );
        });

        it('should throw Unknown request error when error has no response, no request, and is not Error', async () => {
            mockAxiosInstance.get.mockRejectedValueOnce({ someProp: 1 });

            await expect(client.healthCheck()).rejects.toThrow('Unknown request error');
        });
    });

    describe('setAuthFailureCallback', () => {
        it('should allow setting callback after construction and invoke on 401', async () => {
            const onAuthFailure = jest.fn();
            const c = new AnyCrawlClient('key', 'https://api.test.com');
            c.setAuthFailureCallback(onAuthFailure);
            mockAxiosInstance.get.mockRejectedValueOnce({
                response: { status: 401, data: { error: 'Expired' } },
            });

            await expect(c.healthCheck()).rejects.toThrow('Authentication failed: Expired');
            expect(onAuthFailure).toHaveBeenCalledTimes(1);
        });
    });

    describe('scrape engine default', () => {
        it('should use playwright when engine is omitted', async () => {
            mockAxiosInstance.post.mockResolvedValueOnce({
                data: {
                    success: true,
                    data: {
                        url: 'https://example.com',
                        status: 'completed',
                        jobId: 'j1',
                        title: '',
                        html: '',
                        markdown: '',
                        metadata: [],
                        timestamp: '',
                    },
                },
            });

            await client.scrape({ url: 'https://example.com', engine: undefined as any });
            expect(mockAxiosInstance.post).toHaveBeenCalledWith(
                '/v1/scrape',
                expect.objectContaining({ engine: 'playwright' })
            );
        });
    });

    describe('search branches', () => {
        it('should pass timeRange and sources when provided', async () => {
            mockAxiosInstance.post.mockResolvedValueOnce({
                data: { success: true, data: [] },
            });

            await client.search({
                query: 'q',
                timeRange: 'week',
                sources: 'news',
            });
            expect(mockAxiosInstance.post).toHaveBeenCalledWith(
                '/v1/search',
                expect.objectContaining({ query: 'q', timeRange: 'week', sources: 'news' })
            );
        });

        it('should not add scrape_options when engine is missing', async () => {
            mockAxiosInstance.post.mockResolvedValueOnce({
                data: { success: true, data: [] },
            });

            await client.search({
                query: 'q',
                scrape_options: { formats: ['markdown'] } as any,
            });
            const callArg = mockAxiosInstance.post.mock.calls[0][1];
            expect(callArg.scrape_options).toBeUndefined();
        });
    });

    describe('crawl pagination', () => {
        it('should aggregate multiple pages when next is present', async () => {
            mockAxiosInstance.post.mockResolvedValueOnce({
                data: { success: true, data: { job_id: 'job-1', status: 'created', message: 'Created' } },
            });
            mockAxiosInstance.get
                .mockResolvedValueOnce({
                    data: {
                        success: true,
                        data: {
                            job_id: 'job-1',
                            status: 'pending',
                            start_time: '',
                            expires_at: '',
                            credits_used: 0,
                            total: 3,
                            completed: 0,
                            failed: 0,
                        },
                    },
                })
                .mockResolvedValueOnce({
                    data: {
                        success: true,
                        data: {
                            job_id: 'job-1',
                            status: 'completed',
                            start_time: '',
                            expires_at: '',
                            credits_used: 3,
                            total: 3,
                            completed: 3,
                            failed: 0,
                        },
                    },
                })
                .mockResolvedValueOnce({
                    data: {
                        success: true,
                        status: 'completed',
                        total: 3,
                        completed: 3,
                        credits_used: 3,
                        data: [{ url: 'https://example.com/1' }, { url: 'https://example.com/2' }],
                        next: 'https://api.test.com/v1/crawl/job-1?skip=2',
                    },
                })
                .mockResolvedValueOnce({
                    data: {
                        success: true,
                        status: 'completed',
                        total: 3,
                        completed: 3,
                        credits_used: 3,
                        data: [{ url: 'https://example.com/3' }],
                    },
                });

            const result = await client.crawl(
                { url: 'https://example.com', engine: 'cheerio', limit: 10 },
                1
            );

            expect(result.data).toHaveLength(3);
            expect(result.data[0]).toEqual({ url: 'https://example.com/1' });
            expect(result.data[1]).toEqual({ url: 'https://example.com/2' });
            expect(result.data[2]).toEqual({ url: 'https://example.com/3' });
        });
    });

    describe('webhooks getWebhookDeliveries params', () => {
        it('should pass status, from, to when provided', async () => {
            mockAxiosInstance.get.mockResolvedValueOnce({
                data: { success: true, data: [], meta: {} },
            });

            await client.getWebhookDeliveries('wh-1', {
                limit: 20,
                offset: 0,
                status: 'failed',
                from: '2024-01-01',
                to: '2024-01-31',
            });

            expect(mockAxiosInstance.get).toHaveBeenCalledWith(
                '/v1/webhooks/wh-1/deliveries?limit=20&offset=0&status=failed&from=2024-01-01&to=2024-01-31'
            );
        });
    });
});
