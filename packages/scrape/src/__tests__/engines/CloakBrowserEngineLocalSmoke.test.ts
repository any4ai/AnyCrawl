import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { RequestQueueV2 } from "crawlee";
import { EngineFactoryRegistry } from "../../engines/EngineFactory.js";
import type { CrawlingContext } from "../../types/engine.js";

describe('CloakBrowser engine local smoke', () => {
    const runSmoke = process.env.ANYCRAWL_RUN_CLOAKBROWSER_ENGINE_SMOKE === 'true';
    const testOrSkip = runSmoke ? test : test.skip;

    let server: Server;
    let baseUrl: string;
    let previousEnv: NodeJS.ProcessEnv;

    beforeAll(async () => {
        if (!runSmoke) return;

        previousEnv = { ...process.env };
        process.env.ANYCRAWL_API_DB_TYPE = 'sqlite';
        process.env.ANYCRAWL_API_DB_CONNECTION = ':memory:';
        process.env.ANYCRAWL_STORAGE = 'local';
        process.env.ANYCRAWL_CACHE_ENABLED = 'false';
        process.env.ANYCRAWL_PROXY_URL = '';
        process.env.ANYCRAWL_PROXY_STEALTH_URL = '';
        process.env.ANYCRAWL_USER_AGENT = '';

        server = createServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(`<!doctype html>
                <html>
                    <head><title>Cloak Engine Fixture</title></head>
                    <body>
                        <main id="app">loading</main>
                        <script>
                            setTimeout(() => {
                                document.querySelector("#app").textContent = "cloak engine ready";
                                const done = document.createElement("div");
                                done.id = "ready";
                                done.textContent = "dynamic content";
                                document.body.appendChild(done);
                            }, 50);
                        </script>
                    </body>
                </html>`);
        });

        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => {
            if (!server?.listening) {
                resolve();
                return;
            }
            server.close(() => resolve());
        });
        if (previousEnv) {
            process.env = previousEnv;
        }
    });

    testOrSkip.each(['playwright', 'puppeteer'] as const)(
        '%s crawler runs through CloakBrowser and exposes CDP',
        async (engineType) => {
            const queue = await RequestQueueV2.open(`cloakbrowser-smoke-${engineType}-${Date.now()}`);
            const seen: Array<{ text: string; cdpAttached: boolean; runtime: string }> = [];
            let engine: Awaited<ReturnType<typeof EngineFactoryRegistry.createEngine>> | undefined;

            try {
                await queue.addRequest({
                    url: baseUrl,
                    uniqueKey: `${engineType}-${Date.now()}`,
                    userData: {
                        jobId: `cloakbrowser-smoke-${engineType}`,
                        parentId: `cloakbrowser-smoke-${engineType}`,
                        engine: engineType,
                        queueName: `smoke-${engineType}`,
                        type: 'temporary_scrape',
                        options: {
                            formats: ['markdown'],
                            wait_for_selector: '#ready',
                            timeout: 60_000,
                            store_in_cache: false,
                        },
                    },
                });

                engine = await EngineFactoryRegistry.createEngine(engineType, queue, {
                    headless: true,
                    proxyConfiguration: undefined,
                    useSessionPool: false,
                    maxRequestsPerCrawl: 1,
                    maxRequestRetries: 0,
                    requestHandlerTimeoutSecs: 60,
                    requestHandler: async (context: CrawlingContext) => {
                        const page: any = (context as any).page;
                        const text = await page.evaluate(() => document.querySelector('#ready')?.textContent);
                        const identity = await page.evaluate(() => ({ ua: navigator.userAgent, webdriver: navigator.webdriver }));
                        expect(identity.webdriver).toBe(false);
                        expect(identity.ua).not.toContain('Chrome/107.');
                        expect(identity.ua).not.toContain('HeadlessChrome');
                        if (engineType === 'playwright') {
                            expect(page.viewportSize()).not.toEqual({ width: 1920, height: 1080 });
                            const other = await page.context().browser().newContext();
                            try {
                                await page.context().addCookies([{ name: 'isolation-test', value: 'private', url: baseUrl! }]);
                                expect((await other.cookies()).some((cookie: any) => cookie.name === 'isolation-test')).toBe(false);
                            } finally { await other.close(); }
                        }

                        let cdpAttached = false;
                        if (engineType === 'playwright') {
                            const session = await page.context().newCDPSession(page);
                            await session.send('Runtime.enable');
                            await session.detach();
                            cdpAttached = true;
                        } else {
                            const session = await page.target().createCDPSession();
                            await session.send('Runtime.enable');
                            await session.detach();
                            cdpAttached = true;
                        }

                        const launcher = (engine as any)
                            ?.getEngine()
                            ?.options
                            ?.launchContext
                            ?.launcher;

                        seen.push({
                            text,
                            cdpAttached,
                            runtime: launcher?.__anycrawlBrowserRuntime,
                        });
                    },
                });

                await engine.init();
                await engine.run();

                expect(seen).toEqual([
                    {
                        text: 'dynamic content',
                        cdpAttached: true,
                        runtime: 'cloakbrowser',
                    },
                ]);
            } finally {
                await engine?.stop();
                await queue.drop();
            }
        },
        240_000,
    );
});
