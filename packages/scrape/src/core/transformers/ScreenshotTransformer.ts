import { log } from "@anycrawl/libs";
import { CrawlingContext } from "../../engines/Base.js";
import { Utils } from "../../Utils.js";
import { s3 } from "@anycrawl/libs";
import { waitForScreenshotReady } from "../../utils/screenshotReady.js";

export class ScreenshotTransformer {
    private s3: typeof s3;

    constructor() {
        this.s3 = s3;
    }

    /**
     * Capture screenshot using CDP
     * Tips: it need more time, and we need to test it more. It will maybe released in the future.
     * @param context - Crawling context
     * @param fullPage - Whether to capture the full page
     * @returns Buffer of the screenshot
     */
    async CDPCaptureScreenshot(context: CrawlingContext, fullPage: boolean): Promise<any> {
        const screenshotOptions = fullPage ? { fullPage: true, quality: 100, type: 'jpeg' } : { quality: 100, type: 'jpeg' };
        const cdpOptions: {
            format: 'jpeg' | 'png' | 'webp';
            quality?: number;
            captureBeyondViewport?: boolean;
        } = {
            format: screenshotOptions.type as 'jpeg' | 'png' | 'webp' || 'jpeg',
        };
        if (screenshotOptions.quality) {
            cdpOptions.quality = screenshotOptions.quality;
        }
        if (screenshotOptions.fullPage) {
            cdpOptions.captureBeyondViewport = true;
        }

        let screenshot: Buffer;
        const page = (context as any).page;
        try {
            let session;
            // page.context() exists on Playwright's Page, but not Puppeteer's
            if (page.context && typeof page.context === 'function') {
                // Playwright
                session = await page.context().newCDPSession(page);
            } else if (page.target && typeof page.target === 'function') {
                // Puppeteer
                session = await page.target().createCDPSession();
            }

            if (session) {
                try {
                    if (cdpOptions.captureBeyondViewport) {
                        const { contentSize } = await session.send('Page.getLayoutMetrics');
                        const pageSize = await page.evaluate(() => {
                            const body = document.body;
                            const html = document.documentElement;
                            return {
                                width: Math.max(
                                    body.scrollWidth,
                                    html.scrollWidth,
                                    body.offsetWidth,
                                    html.offsetWidth,
                                    body.clientWidth,
                                    html.clientWidth
                                ),
                                height: Math.max(
                                    body.scrollHeight,
                                    html.scrollHeight,
                                    body.offsetHeight,
                                    html.offsetHeight,
                                    body.clientHeight,
                                    html.clientHeight
                                ),
                            }
                        });

                        await session.send('Emulation.setDeviceMetricsOverride', {
                            width: pageSize.width,
                            height: Math.max(contentSize.height, pageSize.height),
                            deviceScaleFactor: 1,
                            mobile: false,
                        });
                    }

                    const { data } = await session.send('Page.captureScreenshot', cdpOptions);
                    screenshot = Buffer.from(data, 'base64');

                    if (cdpOptions.captureBeyondViewport) {
                        await session.send('Emulation.clearDeviceMetricsOverride');
                    }
                } finally {
                    await session.detach();
                }
            } else {
                log.warning(`Could not determine browser engine for CDP. Falling back to default screenshot method.`);
                screenshot = await page.screenshot(screenshotOptions);
            }
        } catch (e) {
            log.warning(`CDP screenshot capture failed: ${e instanceof Error ? e.message : String(e)}. Falling back to default screenshot method.`);
            screenshot = await page.screenshot(screenshotOptions);
        }
        return screenshot;
    }

    /**
     * Capture screenshot via CDP Page.captureScreenshot (instant, no lifecycle wait).
     * Falls back to page.screenshot() if CDP session is unavailable.
     */
    private async captureViaCDP(
        page: any,
        fullPage: boolean,
    ): Promise<Buffer> {
        const cdp = (page as any).__anycrawlCdpSession;
        if (!cdp) {
            return await page.screenshot(
                fullPage
                    ? { fullPage: true, quality: 100, type: 'jpeg' }
                    : { quality: 100, type: 'jpeg' },
            );
        }

        try {
            if (fullPage) {
                const metrics = await cdp.send('Page.getLayoutMetrics');
                const contentWidth = Math.ceil(metrics.contentSize.width);
                const contentHeight = Math.ceil(metrics.contentSize.height);

                await cdp.send('Emulation.setDeviceMetricsOverride', {
                    width: contentWidth,
                    height: contentHeight,
                    deviceScaleFactor: 1,
                    mobile: false,
                });

                const { data } = await cdp.send('Page.captureScreenshot', {
                    format: 'jpeg',
                    quality: 100,
                    captureBeyondViewport: true,
                });

                await cdp.send('Emulation.clearDeviceMetricsOverride');
                return Buffer.from(data, 'base64');
            }

            const { data } = await cdp.send('Page.captureScreenshot', {
                format: 'jpeg',
                quality: 100,
            });
            return Buffer.from(data, 'base64');
        } catch (e) {
            log.warning(`[Screenshot] CDP capture failed: ${e instanceof Error ? e.message : String(e)}, falling back to page.screenshot()`);
            return await page.screenshot(
                fullPage
                    ? { fullPage: true, quality: 100, type: 'jpeg' }
                    : { quality: 100, type: 'jpeg' },
            );
        }
    }

    public async captureAndStoreScreenshot(context: CrawlingContext, page: any, formats: string[]): Promise<string | void> {
        try {
            const jobId = context.request.userData["jobId"];
            const crypto = await import('crypto');
            const reqHash = crypto.createHash('md5').update(context.request.uniqueKey).digest('hex').substring(0, 8);

            let fileName: string | undefined;
            let fullPage = false;

            if (formats.includes("screenshot@fullPage")) {
                fileName = `screenshot-fullPage-${jobId}-${reqHash}.jpeg`;
                fullPage = true;
            } else if (formats.includes("screenshot")) {
                fileName = `screenshot-${jobId}-${reqHash}.jpeg`;
            } else {
                return;
            }

            try {
                await waitForScreenshotReady(page, context.request.url, { fullPage });
            } catch {
                // proceed with screenshot even if readiness check fails
            }

            const screenshot = await this.captureViaCDP(page, fullPage);
            log.debug(`[Screenshot] Captured screenshot for ${context.request.url} -> ${fileName}`);

            if (process.env.ANYCRAWL_STORAGE === 's3') {
                await this.s3.uploadImage(fileName!, screenshot);
            } else {
                const keyValueStore = await Utils.getInstance().getKeyValueStore();
                await keyValueStore.setValue(fileName!, screenshot, { contentType: 'image/jpeg' });
            }
            log.info(`[Screenshot] Saved screenshot: ${fileName} for URL: ${context.request.url}`);
            return fileName;
        } catch (error) {
            log.warning(`Screenshot capture failed: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
    }
}
