import { log } from '@anycrawl/libs';
import { TwoCaptchaTurnstileProvider } from './providers/TwoCaptchaTurnstileProvider.js';
import type { TurnstileSolverProvider } from './providers/TurnstileSolverProvider.js';

export type CDPTurnstileSolverType = string;

export interface CDPTurnstileSolverResult {
    enabled: boolean;
    attempted: boolean;
    solved: boolean;
    taskId?: string;
    injectMethod?: string;
    errorCode?: string;
    errorDescription?: string;
}

export interface CDPTurnstileSolveDirectResult {
    success: boolean;
    token?: string;
    taskId?: string;
    injectMethod?: string;
    userAgent?: string;
    errorCode?: string;
    errorDescription?: string;
}

interface CDPTurnstileSolveDirectOptions {
    forceAttempt?: boolean;
    skipInFlightWait?: boolean;
}

export interface CDPTurnstileSolverOptions {
    /** Backward-compatible 2captcha API key bootstrap */
    twoCaptchaKey?: string;
    provider?: TurnstileSolverProvider;
    solveTimeoutMs?: number;
}

interface TurnstileInterceptParams {
    sitekey: string;
    pageurl: string;
    data?: string;
    pagedata?: string;
    action?: string;
    userAgent?: string;
}

const TURNSTILE_INTERCEPT_SCRIPT = `
(function () {
    if (window.__anycrawlTurnstileHookInstalled) return;
    window.__anycrawlTurnstileHookInstalled = true;
    window.__anycrawlTurnstileDetected = false;
    window.__anycrawlTurnstileSolving = false;
    window.__anycrawlTurnstileSolved = false;
    window.__anycrawlTurnstileParams = window.__anycrawlTurnstileParams || null;
    window.__anycrawlTurnstileCallback = window.__anycrawlTurnstileCallback || null;

    const pick = function () {
        for (let i = 0; i < arguments.length; i++) {
            const value = arguments[i];
            if (typeof value === 'string' && value.trim()) return value.trim();
        }
        return undefined;
    };

    const findStringByKey = function (root, keyPattern) {
        if (!root || typeof root !== 'object') return undefined;
        const stack = [root];
        const seen = [];
        while (stack.length > 0) {
            const current = stack.pop();
            if (!current || typeof current !== 'object') continue;
            if (seen.indexOf(current) >= 0) continue;
            seen.push(current);

            if (Array.isArray(current)) {
                for (let i = 0; i < current.length; i++) {
                    stack.push(current[i]);
                }
                continue;
            }

            const keys = Object.keys(current);
            for (let i = 0; i < keys.length; i++) {
                const key = keys[i];
                const value = current[key];
                const lowered = String(key).toLowerCase();
                if (typeof value === 'string' && value.trim() && keyPattern(lowered, value.trim())) {
                    return value.trim();
                }
                if (value && typeof value === 'object') {
                    stack.push(value);
                }
            }
        }
        return undefined;
    };

    const resolveContainer = function (container) {
        try {
            if (!container) return null;
            if (typeof container === 'string') {
                return document.querySelector(container);
            }
            if (container && typeof container === 'object' && 'nodeType' in container) {
                return container;
            }
            return null;
        } catch (e) {
            return null;
        }
    };

    const capture = function (container, options) {
        const opts =
            options && typeof options === 'object'
                ? options
                : (
                    container
                    && typeof container === 'object'
                    && !('nodeType' in container)
                    ? container
                    : {}
                );
        const cfOpt = window._cf_chl_opt || window.__cf_chl_opt || window.cf_chl_opt || {};
        const containerEl = resolveContainer(
            container
            && typeof container === 'object'
            && !('nodeType' in container)
            ? (container.container || container.element || container.target || null)
            : container
        );

        window.__anycrawlTurnstileDetected = true;

        const sitekeyFromNested = pick(
            findStringByKey(opts, function (key, value) {
                return key.indexOf('sitekey') >= 0 || key === 'k';
            }),
            findStringByKey(cfOpt, function (key, value) {
                return key.indexOf('sitekey') >= 0 || key === 'k';
            })
        );
        const sitekey = pick(
            opts.sitekey,
            opts.siteKey,
            opts.websiteKey,
            opts.k,
            opts.params && (opts.params.sitekey || opts.params.siteKey || opts.params.websiteKey),
            opts.renderParameters && (opts.renderParameters.sitekey || opts.renderParameters.siteKey || opts.renderParameters.websiteKey),
            containerEl && containerEl.getAttribute ? containerEl.getAttribute('data-sitekey') : undefined,
            containerEl && containerEl.getAttribute ? containerEl.getAttribute('data-site-key') : undefined,
            cfOpt.cTurnstileSitekey,
            cfOpt.sitekey,
            cfOpt.siteKey,
            cfOpt.websiteKey,
            cfOpt.turnstileSitekey,
            sitekeyFromNested
        );

        if (!sitekey) return null;

        const dataFromNested = pick(
            findStringByKey(opts, function (key, value) {
                return key === 'cdata' || key.indexOf('challengedata') >= 0;
            }),
            findStringByKey(cfOpt, function (key, value) {
                return key === 'cdata' || key.indexOf('challengedata') >= 0;
            })
        );

        const pagedataFromNested = pick(
            findStringByKey(opts, function (key, value) {
                return key.indexOf('chlpagedata') >= 0 || key.indexOf('pagedata') >= 0;
            }),
            findStringByKey(cfOpt, function (key, value) {
                return key.indexOf('chlpagedata') >= 0 || key.indexOf('pagedata') >= 0;
            })
        );

        const actionFromNested = pick(
            findStringByKey(opts, function (key, value) {
                return key.indexOf('action') >= 0;
            }),
            findStringByKey(cfOpt, function (key, value) {
                return key.indexOf('action') >= 0;
            })
        );

        const params = {
            sitekey: sitekey,
            pageurl: window.location.href,
            data: pick(opts.cData, opts.data, cfOpt.cData, cfOpt.data, cfOpt.challengeData, dataFromNested),
            pagedata: pick(opts.chlPageData, opts.pagedata, opts.pageData, cfOpt.chlPageData, cfOpt.pagedata, cfOpt.pageData, pagedataFromNested),
            action: pick(opts.action, opts.chlAction, cfOpt.chlAction, cfOpt.action, cfOpt.turnstileAction, actionFromNested, 'managed'),
            userAgent: navigator.userAgent
        };

        window.__anycrawlTurnstileSolving = true;
        window.__anycrawlTurnstileParams = params;
        if (typeof opts.callback === 'function') {
            window.__anycrawlTurnstileCallback = opts.callback;
            window.cfCallback = opts.callback;
            window.tsCallback = opts.callback;
        } else if (typeof opts.callback === 'string' && typeof window[opts.callback] === 'function') {
            window.__anycrawlTurnstileCallback = window[opts.callback];
            window.cfCallback = window[opts.callback];
            window.tsCallback = window[opts.callback];
        }

        try {
            console.log('intercepted-params:' + JSON.stringify(params));
            console.log('anycrawl-turnstile-params:' + JSON.stringify(params));
        } catch (e) {}

        return params;
    };
    window.__anycrawlCaptureTurnstile = capture;

    const proxyTurnstile = {
        __isAnycrawlProxy: true,
        render: function (container, options) {
            if (window.__anycrawlTurnstileSolved || window.__turnstileSolved) return 'already-solved';
            try { capture(container, options || {}); } catch (e) {}
            return 'anycrawl-proxy-widget-id';
        },
        execute: function (container, options) {
            if (window.__anycrawlTurnstileSolved || window.__turnstileSolved) return 'already-solved';
            return this.render(container, options || {});
        },
        getResponse: function () {
            return null;
        },
        reset: function () {
            return undefined;
        },
        remove: function () {
            return undefined;
        },
        isExpired: function () {
            return false;
        }
    };

    let currentTurnstile = proxyTurnstile;

    try {
        Object.defineProperty(window, 'turnstile', {
            configurable: true,
            get: function () {
                return currentTurnstile;
            },
            set: function (value) {
                window.__anycrawlTurnstileDetected = true;
                currentTurnstile = proxyTurnstile;
            }
        });
    } catch (e) {
        // ignore defineProperty errors; polling fallback will handle late-loaded real turnstile
    }

    window.__anycrawlTurnstileReady = true;
})();
`;

const TURNSTILE_POLLING_SCRIPT = `
(function () {
    if (window.__anycrawlTurnstilePollingInstalled) return;
    window.__anycrawlTurnstilePollingInstalled = true;

    const intervalId = setInterval(function () {
        try {
            if (window.__anycrawlTurnstileSolved || window.__turnstileSolved) {
                clearInterval(intervalId);
                return;
            }

            const capture = window.__anycrawlCaptureTurnstile;
            const turnstile = window.turnstile;
            if (typeof capture !== 'function' || !turnstile) return;
            if (turnstile.__isAnycrawlProxy || turnstile.__isAnycrawlPatched) return;

            turnstile.__isAnycrawlPatched = true;

            turnstile.render = function (container, options) {
                if (window.__anycrawlTurnstileSolved || window.__turnstileSolved) return 'already-solved';
                try { capture(container, options || {}); } catch (e) {}
                return 'anycrawl-intercepted-widget';
            };
            if (typeof turnstile.execute === 'function') {
                turnstile.execute = function (container, options) {
                    return turnstile.render(container, options || {});
                };
            }
        } catch (e) {}
    }, 1);

    setTimeout(function () {
        clearInterval(intervalId);
    }, 20000);
})();
`;

/**
 * Cloudflare Turnstile solver using 2captcha via CDP runtime interception.
 */
export class CDPTurnstileSolver {
    private readonly provider: TurnstileSolverProvider | null;
    private readonly solveTimeoutMs: number;

    private detected = false;
    private solving = false;
    private solved = false;
    private consoleListener: ((msg: any) => void) | null = null;
    private lastResult: CDPTurnstileSolverResult | null = null;
    private lastCapturedParams: TurnstileInterceptParams | null = null;
    private lastCapturedAt = 0;
    private lastInjectError: string | null = null;

    constructor(options: CDPTurnstileSolverOptions) {
        this.solveTimeoutMs = options.solveTimeoutMs ?? 60000;
        if (options.provider) {
            this.provider = options.provider;
            return;
        }

        const key = (options.twoCaptchaKey || '').trim();
        this.provider = key
            ? new TwoCaptchaTurnstileProvider({
                apiKey: key,
                solveTimeoutMs: this.solveTimeoutMs,
            })
            : null;
    }

    getSolverType(): CDPTurnstileSolverType {
        return this.provider?.name || 'none';
    }

    isDetected(): boolean {
        return this.detected;
    }

    isSolving(): boolean {
        return this.solving;
    }

    isSolved(): boolean {
        return this.solved;
    }

    getLastResult(): CDPTurnstileSolverResult | null {
        return this.lastResult;
    }

    async solveDirect(
        pageUrl: string,
        page?: any,
        options?: CDPTurnstileSolveDirectOptions
    ): Promise<CDPTurnstileSolveDirectResult> {
        return this.solveByProvider(pageUrl, page, options);
    }

    /**
     * Check if the current page is a Cloudflare Challenge page.
     */
    async isChallenge(page: any): Promise<boolean> {
        try {
            return await page.evaluate(() => {
                const title = (document.title || '').toLowerCase();
                const bodyText = (document.body?.innerText || '').toLowerCase();

                return (
                    title.includes('just a moment')
                    || title.includes('checking your browser')
                    || title.includes('performing security verification')
                    || bodyText.includes('performing security verification')
                    || bodyText.includes('security service to protect against malicious bots')
                    || bodyText.includes('enable javascript and cookies to continue')
                );
            });
        } catch {
            return false;
        }
    }

    async setup(page: any): Promise<void> {
        if (!page || (page as any).__anycrawlTurnstileSolverSetup) return;
        (page as any).__anycrawlTurnstileSolverSetup = true;

        await this.setupChallengeScriptInterception(page);
        await this.installInterceptScript(page);

        if (!this.consoleListener) {
            this.consoleListener = (msg: any) => {
                void this.handleConsoleMessage(page, msg);
            };
            page.on('console', this.consoleListener);
            page.once('close', () => {
                void this.cleanup(page);
            });
        }

        log.debug('[CDPTurnstileSolver] setup complete (provider=2captcha)');
    }

    async cleanup(page?: any): Promise<void> {
        if (page && this.consoleListener) {
            try {
                page.off('console', this.consoleListener);
            } catch {
                // ignore
            }
        }
        this.consoleListener = null;
        this.lastCapturedParams = null;
        this.lastCapturedAt = 0;
    }

    private async solveByProvider(
        pageUrl: string,
        page?: any,
        options?: CDPTurnstileSolveDirectOptions
    ): Promise<CDPTurnstileSolveDirectResult> {
        const forceAttempt = Boolean(options?.forceAttempt);
        if (!this.provider) {
            const errorCode = 'TWOCAPTCHA_CLIENT_MISSING';
            const errorDescription = '2captcha client not initialized';
            this.lastResult = {
                enabled: false,
                attempted: false,
                solved: false,
                errorCode,
                errorDescription,
            };
            return {
                success: false,
                errorCode,
                errorDescription,
            };
        }

        if (!page || page.isClosed?.()) {
            const errorCode = 'TWOCAPTCHA_PAGE_REQUIRED';
            const errorDescription = '2captcha solver requires a live page instance';
            this.lastResult = {
                enabled: true,
                attempted: false,
                solved: false,
                errorCode,
                errorDescription,
            };
            return {
                success: false,
                errorCode,
                errorDescription,
            };
        }

        const cachedParams = this.getFreshCapturedParams(pageUrl);
        if (cachedParams?.sitekey) {
            log.debug(`[CDPTurnstileSolver] Using cached captured params for ${pageUrl}`);
            return this.solveWithTurnstileParams(page, cachedParams);
        }

        // Fast guard: if page is clearly not a Turnstile/Cloudflare challenge,
        // skip solving to avoid long param-wait stalls and noisy warnings.
        if (!forceAttempt) {
            const quickChallengeSignals = await page.evaluate(() => {
                const win = window as any;
                const hasChallengeForm = Boolean(
                    document.querySelector('form#challenge-form')
                    || document.querySelector('form[action*="challenge"]')
                );
                const hasRuntimeParams = Boolean(
                    win.__anycrawlTurnstileParams
                    || win.__turnstileParams
                    || win.__interceptedParams
                );
                const hasSitekeyElement = Boolean(
                    document.querySelector('[data-sitekey], [data-site-key], .cf-turnstile, input[name="cf-turnstile-response"]')
                );
                const hasChallengeClass = Boolean(
                    document.querySelector('.cf-chl-widget, [id*="cf-chl-widget"], [class*="challenge-form"], [id*="challenge-form"]')
                );
                return {
                    shouldSolve: hasChallengeForm || hasRuntimeParams || hasSitekeyElement || hasChallengeClass,
                };
            }).catch(() => ({ shouldSolve: true }));

            if (!quickChallengeSignals.shouldSolve) {
                const errorCode = 'TWOCAPTCHA_NOT_CHALLENGE';
                const errorDescription = 'Turnstile challenge signals not present on page';
                this.lastResult = {
                    enabled: true,
                    attempted: false,
                    solved: false,
                    errorCode,
                    errorDescription,
                };
                return {
                    success: false,
                    errorCode,
                    errorDescription,
                };
            }
        }

        const params = await this.extractTurnstileParams(page, pageUrl);
        if (!params || !params.sitekey) {
            const errorCode = 'TWOCAPTCHA_PARAMS_MISSING';
            const errorDescription = 'Could not extract Turnstile params from page runtime';
            log.warning(`[CDPTurnstileSolver] 2captcha params missing for ${pageUrl}`);
            this.lastResult = {
                enabled: true,
                attempted: true,
                solved: false,
                errorCode,
                errorDescription,
            };
            return {
                success: false,
                errorCode,
                errorDescription,
            };
        }

        return this.solveWithTurnstileParams(page, params);
    }

    private setCapturedParams(params: TurnstileInterceptParams): void {
        if (!params?.sitekey) return;
        this.lastCapturedParams = params;
        this.lastCapturedAt = Date.now();
    }

    clearCapturedParams(): void {
        this.lastCapturedParams = null;
        this.lastCapturedAt = 0;
    }

    private getFreshCapturedParams(pageUrl: string): TurnstileInterceptParams | null {
        if (!this.lastCapturedParams?.sitekey) return null;
        const ageMs = Date.now() - this.lastCapturedAt;
        if (ageMs > Math.min(this.solveTimeoutMs, 120000)) return null;
        if (!this.lastCapturedParams.pageurl) {
            return {
                ...this.lastCapturedParams,
                pageurl: pageUrl,
            };
        }
        return this.lastCapturedParams;
    }

    private async solveWithTurnstileParams(
        page: any,
        params: TurnstileInterceptParams
    ): Promise<CDPTurnstileSolveDirectResult> {
        if (!this.provider) {
            return {
                success: false,
                errorCode: 'TWOCAPTCHA_CLIENT_MISSING',
                errorDescription: '2captcha client not initialized',
            };
        }

        const normalizedPageUrl = params.pageurl
            || (typeof page?.url === 'function' ? page.url() : '');
        if (!normalizedPageUrl) {
            return {
                success: false,
                errorCode: 'TWOCAPTCHA_PAGEURL_MISSING',
                errorDescription: 'Turnstile page URL is missing',
            };
        }

        this.solving = true;
        this.detected = true;
        this.solved = false;

        try {
            const solveResult = await this.provider.solve({
                pageUrl: normalizedPageUrl,
                sitekey: params.sitekey,
                data: params.data,
                pagedata: params.pagedata,
                action: params.action,
                userAgent: params.userAgent,
            });

            if (!solveResult.success || !solveResult.token) {
                this.lastResult = {
                    enabled: true,
                    attempted: true,
                    solved: false,
                    taskId: solveResult.taskId,
                    errorCode: solveResult.errorCode,
                    errorDescription: solveResult.errorDescription,
                };
                (page as any).__anycrawlTurnstileSolveResult = this.lastResult;
                return {
                    success: false,
                    taskId: solveResult.taskId,
                    errorCode: solveResult.errorCode,
                    errorDescription: solveResult.errorDescription,
                };
            }

            await this.applySolvedUserAgent(page, solveResult.userAgent);
            this.lastInjectError = null;
            let injectMethod = await this.injectTurnstileToken(page, solveResult.token);

            const solved = injectMethod !== 'no-target' && injectMethod !== 'inject-error';
            const injectErrorDescription = injectMethod === 'inject-error'
                ? (this.lastInjectError || 'Token generated but injection script execution failed')
                : 'Token generated but injection target not found';
            this.solved = solved;

            this.lastResult = {
                enabled: true,
                attempted: true,
                solved,
                taskId: solveResult.taskId,
                injectMethod,
                errorCode: solved ? undefined : 'TWOCAPTCHA_INJECT_FAILED',
                errorDescription: solved ? undefined : injectErrorDescription,
            };
            (page as any).__anycrawlTurnstileSolveResult = this.lastResult;

            return {
                success: solved,
                token: solveResult.token,
                taskId: solveResult.taskId,
                injectMethod,
                userAgent: solveResult.userAgent,
                errorCode: solved ? undefined : 'TWOCAPTCHA_INJECT_FAILED',
                errorDescription: solved ? undefined : injectErrorDescription,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.lastResult = {
                enabled: true,
                attempted: true,
                solved: false,
                errorCode: 'TWOCAPTCHA_SOLVER_ERROR',
                errorDescription: message,
            };
            (page as any).__anycrawlTurnstileSolveResult = this.lastResult;
            return {
                success: false,
                errorCode: 'TWOCAPTCHA_SOLVER_ERROR',
                errorDescription: message,
            };
        } finally {
            this.solving = false;
        }
    }

    private async applySolvedUserAgent(page: any, userAgent?: string): Promise<void> {
        const ua = typeof userAgent === 'string' ? userAgent.trim() : '';
        if (!ua) return;

        // Puppeteer path
        if (typeof page?.setUserAgent === 'function') {
            try {
                await page.setUserAgent(ua);
                return;
            } catch (error) {
                log.debug(`[CDPTurnstileSolver] failed to set Puppeteer userAgent: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        // Playwright Chromium path via CDP
        try {
            const context = typeof page?.context === 'function' ? page.context() : null;
            if (context && typeof context.newCDPSession === 'function') {
                const cdpSession = await context.newCDPSession(page);
                try {
                    await cdpSession.send('Network.setUserAgentOverride', { userAgent: ua });
                    return;
                } finally {
                    try { await cdpSession.detach(); } catch { }
                }
            }
        } catch (error) {
            log.debug(`[CDPTurnstileSolver] failed to set CDP userAgent override: ${error instanceof Error ? error.message : String(error)}`);
        }

        // Last-resort runtime override for callback scripts reading navigator.userAgent
        try {
            await page.evaluate((resolvedUa: string) => {
                const win = window as any;
                win.__anycrawlSolvedUserAgent = resolvedUa;
                try {
                    Object.defineProperty(navigator, 'userAgent', {
                        configurable: true,
                        get: () => resolvedUa,
                    });
                } catch {
                    // ignore - browser may block overriding navigator.userAgent
                }
            }, ua);
        } catch (error) {
            log.debug(`[CDPTurnstileSolver] failed runtime userAgent override: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async extractTurnstileParams(page: any, pageUrl: string): Promise<TurnstileInterceptParams | null> {
        const envAttempts = parseInt(process.env.ANYCRAWL_2CAPTCHA_PARAM_ATTEMPTS || '', 10);
        const envWaitMs = parseInt(process.env.ANYCRAWL_2CAPTCHA_PARAM_WAIT_MS || '', 10);
        const waitMs = Number.isFinite(envWaitMs) && envWaitMs > 0 ? envWaitMs : 300;
        const maxAttempts = Number.isFinite(envAttempts) && envAttempts > 0 ? envAttempts : 45;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            if (!page || page.isClosed?.()) return null;

            // Console interception may capture params asynchronously while we are polling.
            // Use them immediately to avoid waiting for the late fallback branch.
            const cachedAtAttemptStart = this.getFreshCapturedParams(pageUrl);
            if (cachedAtAttemptStart?.sitekey) {
                if (attempt > 0) {
                    log.debug(`[CDPTurnstileSolver] Param polling picked cached params early for ${pageUrl} (attempt=${attempt + 1})`);
                }
                return cachedAtAttemptStart;
            }

            const mainFrameParams = await this.extractTurnstileParamsFromContext(page, pageUrl);
            if (mainFrameParams?.sitekey) {
                return mainFrameParams;
            }

            // If the page has already moved away from challenge and still has no turnstile hints,
            // abort early to avoid unnecessary waiting.
            if (attempt >= 6 && attempt % 3 === 0) {
                const challengeStill = await this.isChallenge(page);
                if (!challengeStill) {
                    const hasTurnstileHints = await page.evaluate(() => {
                        const win = window as any;
                        const hasRuntimeParams = Boolean(
                            win.__anycrawlTurnstileParams
                            || win.__turnstileParams
                            || win.__interceptedParams
                        );
                        const hasSitekeyElement = Boolean(
                            document.querySelector('[data-sitekey], [data-site-key], .cf-turnstile, input[name="cf-turnstile-response"]')
                        );
                        const hasChallengeForm = Boolean(
                            document.querySelector('form#challenge-form')
                            || document.querySelector('form[action*="challenge"]')
                        );
                        return hasRuntimeParams || hasSitekeyElement || hasChallengeForm;
                    }).catch(() => true);

                    if (!hasTurnstileHints) {
                        return null;
                    }
                }
            }

            // Scanning all frames on each tick is expensive; do sparse frame scans.
            const shouldScanFrames = attempt < 3 || attempt % 4 === 0;
            if (shouldScanFrames && typeof page.frames === 'function') {
                const frames = page.frames() as any[];
                for (const frame of frames) {
                    const frameUrl = typeof frame?.url === 'function' ? frame.url() : pageUrl;
                    const frameParams = await this.extractTurnstileParamsFromContext(frame, frameUrl || pageUrl);
                    if (frameParams?.sitekey) {
                        return frameParams;
                    }
                }
            }

            if (attempt < maxAttempts - 1) {
                const cachedBeforeSleep = this.getFreshCapturedParams(pageUrl);
                if (cachedBeforeSleep?.sitekey) {
                    log.debug(`[CDPTurnstileSolver] Param polling captured params before sleep for ${pageUrl} (attempt=${attempt + 1})`);
                    return cachedBeforeSleep;
                }
                await new Promise((resolve) => setTimeout(resolve, waitMs));
            }
        }

        return null;
    }

    private async extractRuntimeTurnstileParamsDirect(page: any, pageUrl: string): Promise<TurnstileInterceptParams | null> {
        if (!page || typeof page.evaluate !== 'function') return null;
        try {
            const raw = await page.evaluate(() => {
                const win = window as any;
                const pick = (...values: any[]) => {
                    for (const value of values) {
                        if (value === undefined || value === null) continue;
                        if (typeof value === 'string' && value.trim()) return value.trim();
                        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
                    }
                    return undefined;
                };

                const runtimeParams = win.__anycrawlTurnstileParams || win.__turnstileParams || win.__interceptedParams || null;
                if (!runtimeParams || typeof runtimeParams !== 'object') return null;

                return {
                    sitekey: pick(runtimeParams.sitekey, runtimeParams.siteKey, runtimeParams.websiteKey, runtimeParams.k),
                    pageurl: pick(runtimeParams.pageurl, runtimeParams.pageUrl, runtimeParams.websiteURL, runtimeParams.websiteUrl, window.location.href),
                    data: pick(runtimeParams.data, runtimeParams.cData, runtimeParams.challengeData),
                    pagedata: pick(runtimeParams.pagedata, runtimeParams.pageData, runtimeParams.chlPageData),
                    action: pick(runtimeParams.action, runtimeParams.chlAction, runtimeParams.turnstileAction),
                    userAgent: pick(runtimeParams.userAgent, runtimeParams.ua, navigator.userAgent),
                };
            });

            if (!raw) return null;
            return this.normalizeTurnstileParams(raw, pageUrl);
        } catch {
            return null;
        }
    }

    private async extractTurnstileParamsFromContext(context: any, pageUrl: string): Promise<TurnstileInterceptParams | null> {
        if (!context || typeof context.evaluate !== 'function') return null;
        try {
            const raw = await context.evaluate(() => {
                const pick = (...values: any[]) => {
                    for (const value of values) {
                        if (typeof value === 'string' && value.trim()) return value.trim();
                    }
                    return undefined;
                };
                const asSitekey = (value: any): string | undefined => {
                    if (typeof value !== 'string') return undefined;
                    const trimmed = value.trim();
                    if (!trimmed) return undefined;
                    if (/^0x4[A-Za-z0-9_-]{12,}$/i.test(trimmed)) return trimmed;
                    if (/^[A-Za-z0-9_-]{20,}$/i.test(trimmed)) return trimmed;
                    return undefined;
                };
                const pickSitekey = (...values: any[]): string | undefined => {
                    for (const value of values) {
                        const normalized = asSitekey(value);
                        if (normalized) return normalized;
                    }
                    return undefined;
                };
                const findStringByKey = (root: any, keyPattern: (key: string, value: string) => boolean) => {
                    if (!root || typeof root !== 'object') return undefined;
                    const stack = [root];
                    const seen = new WeakSet<object>();
                    while (stack.length > 0) {
                        const current = stack.pop();
                        if (!current || typeof current !== 'object') continue;
                        if (seen.has(current)) continue;
                        seen.add(current);

                        if (Array.isArray(current)) {
                            for (const item of current) stack.push(item);
                            continue;
                        }

                        for (const [key, value] of Object.entries(current)) {
                            const lowered = String(key).toLowerCase();
                            if (typeof value === 'string' && value.trim() && keyPattern(lowered, value.trim())) {
                                return value.trim();
                            }
                            if (value && typeof value === 'object') {
                                stack.push(value as any);
                            }
                        }
                    }
                    return undefined;
                };
                const findPatternInObject = (root: any, pattern: RegExp) => {
                    if (!root || typeof root !== 'object') return undefined;
                    const stack = [root];
                    const seen = new WeakSet<object>();
                    while (stack.length > 0) {
                        const current = stack.pop();
                        if (!current || typeof current !== 'object') continue;
                        if (seen.has(current)) continue;
                        seen.add(current);

                        if (Array.isArray(current)) {
                            for (const item of current) stack.push(item);
                            continue;
                        }

                        for (const [, value] of Object.entries(current)) {
                            if (typeof value === 'string' && value.trim()) {
                                const match = value.trim().match(pattern);
                                if (match?.[1]) return match[1];
                                if (match?.[0]) return match[0];
                            } else if (value && typeof value === 'object') {
                                stack.push(value as any);
                            }
                        }
                    }
                    return undefined;
                };
                const fromRegex = (source: string, patterns: RegExp[]) => {
                    for (const pattern of patterns) {
                        const match = source.match(pattern);
                        if (match?.[1]) return match[1];
                    }
                    return undefined;
                };
                const fromResourceUrls = (urls: string[]): string | undefined => {
                    const sitekeyPattern = /(0x4[A-Za-z0-9_-]{12,})/i;
                    const queryKeys = ['sitekey', 'siteKey', 'k', 'turnstile_sitekey', 'cf_chl_sitekey'];
                    const baseHref = window.location.href || 'https://example.com/';

                    for (const rawUrl of urls) {
                        if (typeof rawUrl !== 'string' || !rawUrl.trim()) continue;
                        const trimmedUrl = rawUrl.trim();

                        const textMatch = trimmedUrl.match(sitekeyPattern);
                        if (textMatch?.[1]) return textMatch[1];

                        try {
                            const parsed = new URL(trimmedUrl, baseHref);
                            for (const key of queryKeys) {
                                const value = parsed.searchParams.get(key);
                                const normalized = asSitekey(value);
                                if (normalized) return normalized;
                            }
                            const hrefMatch = parsed.href.match(sitekeyPattern);
                            if (hrefMatch?.[1]) return hrefMatch[1];
                        } catch {
                            // ignore invalid URL values
                        }
                    }

                    return undefined;
                };

                const runtimeParams = (window as any).__anycrawlTurnstileParams
                    || (window as any).__turnstileParams
                    || (window as any).__interceptedParams;
                const runtimeSitekey = pickSitekey(
                    runtimeParams?.sitekey,
                    runtimeParams?.siteKey,
                    runtimeParams?.websiteKey,
                    runtimeParams?.k
                );
                if (runtimeSitekey) {
                    return {
                        sitekey: runtimeSitekey,
                        pageurl: pick(runtimeParams.pageurl, runtimeParams.pageUrl, runtimeParams.websiteURL, runtimeParams.websiteUrl, window.location.href),
                        data: pick(runtimeParams.data, runtimeParams.cData, runtimeParams.challengeData),
                        pagedata: pick(runtimeParams.pagedata, runtimeParams.pageData, runtimeParams.chlPageData),
                        action: pick(runtimeParams.action, runtimeParams.chlAction, runtimeParams.turnstileAction),
                        userAgent: pick(runtimeParams.userAgent, runtimeParams.ua, navigator.userAgent),
                    };
                }

                const win = window as any;
                const cfOpt = win._cf_chl_opt || win.__cf_chl_opt || win.cf_chl_opt || null;

                const domNodes = Array.from(
                    document.querySelectorAll('[data-sitekey], [data-site-key], [data-turnstile-sitekey], [data-cf-sitekey], .cf-turnstile')
                ) as Element[];
                const domSitekey = pickSitekey(
                    ...domNodes.map((node) => node.getAttribute('data-sitekey')),
                    ...domNodes.map((node) => node.getAttribute('data-site-key')),
                    ...domNodes.map((node) => node.getAttribute('data-turnstile-sitekey')),
                    ...domNodes.map((node) => node.getAttribute('data-cf-sitekey'))
                );

                const scripts = Array.from(document.querySelectorAll('script'))
                    .map((script) => script.textContent || '')
                    .join('\n');
                const scriptUrls = Array.from(document.querySelectorAll('script[src]'))
                    .map((node) => (node as HTMLScriptElement).src || node.getAttribute('src') || '');
                const iframeUrls = Array.from(document.querySelectorAll('iframe[src]'))
                    .map((node) => (node as HTMLIFrameElement).src || node.getAttribute('src') || '');
                const resourceSitekey = fromResourceUrls([...scriptUrls, ...iframeUrls]);

                const nestedSitekey = pickSitekey(
                    findStringByKey(cfOpt, (key, value) => key.includes('sitekey') || key === 'k'),
                    findPatternInObject(cfOpt, /(0x4[A-Za-z0-9_-]{12,})/),
                    fromRegex(scripts, [/(0x4[A-Za-z0-9_-]{12,})/i]),
                    resourceSitekey
                );

                const sitekey = pickSitekey(
                    cfOpt?.cTurnstileSitekey,
                    cfOpt?.sitekey,
                    cfOpt?.siteKey,
                    cfOpt?.websiteKey,
                    cfOpt?.turnstileSitekey,
                    nestedSitekey,
                    domSitekey,
                    fromRegex(scripts, [
                        /cTurnstileSitekey["']?\s*[:=]\s*["']([^"'\\s,}]{10,})["']/i,
                        /sitekey["']?\s*[:=]\s*["']([^"'\\s,}]{10,})["']/i,
                        /websiteKey["']?\s*[:=]\s*["']([^"'\\s,}]{10,})["']/i,
                    ])
                );

                if (!sitekey) return null;

                const nestedData = pick(
                    findStringByKey(cfOpt, (key, value) => key === 'cdata' || key.includes('challengedata'))
                );

                const data = pick(
                    cfOpt?.cData,
                    cfOpt?.data,
                    cfOpt?.challengeData,
                    nestedData,
                    fromRegex(scripts, [
                        /cData["']?\s*[:=]\s*["']([^"']+)["']/i,
                        /data["']?\s*[:=]\s*["']([^"']+)["']/i,
                    ])
                );

                const nestedPageData = pick(
                    findStringByKey(cfOpt, (key, value) => key.includes('chlpagedata') || key.includes('pagedata'))
                );

                const pagedata = pick(
                    cfOpt?.chlPageData,
                    cfOpt?.pagedata,
                    cfOpt?.pageData,
                    nestedPageData,
                    fromRegex(scripts, [
                        /chlPageData["']?\s*[:=]\s*["']([^"']+)["']/i,
                        /pagedata["']?\s*[:=]\s*["']([^"']+)["']/i,
                        /pageData["']?\s*[:=]\s*["']([^"']+)["']/i,
                    ])
                );

                const nestedAction = pick(
                    findStringByKey(cfOpt, (key, value) => key.includes('action'))
                );

                const action = pick(
                    cfOpt?.chlAction,
                    cfOpt?.action,
                    cfOpt?.turnstileAction,
                    nestedAction,
                    fromRegex(scripts, [
                        /chlAction["']?\s*[:=]\s*["']([^"']+)["']/i,
                        /action["']?\s*[:=]\s*["']([^"']+)["']/i,
                    ]),
                    'managed'
                );

                return {
                    sitekey,
                    pageurl: window.location.href,
                    data,
                    pagedata,
                    action,
                    userAgent: navigator.userAgent,
                };
            });

            if (!raw) return null;
            return this.normalizeTurnstileParams(raw, pageUrl);
        } catch {
            return null;
        }
    }

    private normalizeTurnstileParams(raw: any, pageUrl: string): TurnstileInterceptParams | null {
        if (!raw || typeof raw !== 'object') return null;
        const readScalar = (value: any): string | undefined => {
            if (value === undefined || value === null) return undefined;
            if (typeof value === 'string') {
                const trimmed = value.trim();
                return trimmed || undefined;
            }
            if (typeof value === 'number' || typeof value === 'boolean') {
                return String(value);
            }
            return undefined;
        };
        const readParam = (value: any): string | undefined => {
            const scalar = readScalar(value);
            if (scalar) return scalar;
            if (value && typeof value === 'object') {
                try {
                    const json = JSON.stringify(value);
                    return json && json !== '{}' ? json : undefined;
                } catch {
                    return undefined;
                }
            }
            return undefined;
        };

        const sitekey = readScalar(raw.sitekey ?? raw.siteKey ?? raw.websiteKey ?? raw.k) || '';
        if (!sitekey) return null;
        const pageurl = readScalar(raw.pageurl ?? raw.pageUrl ?? raw.websiteURL ?? raw.websiteUrl) || pageUrl;

        return {
            sitekey,
            pageurl,
            data: readParam(raw.data ?? raw.cData ?? raw.challengeData),
            pagedata: readParam(raw.pagedata ?? raw.pageData ?? raw.chlPageData),
            action: readParam(raw.action ?? raw.chlAction ?? raw.turnstileAction),
            userAgent: readScalar(raw.userAgent ?? raw.ua),
        };
    }

    private async markMainFrameSolved(page: any): Promise<void> {
        if (!page || typeof page.evaluate !== 'function') return;
        try {
            await page.evaluate(() => {
                const win = window as any;
                win.__anycrawlTurnstileSolved = true;
                win.__turnstileSolved = true;
                win.__anycrawlTurnstileSolving = false;
            });
        } catch {
            // ignore solved-flag sync errors
        }
    }

    private async injectTurnstileTokenInContext(context: any, token: string): Promise<string> {
        if (!context || typeof context.evaluate !== 'function') return 'no-target';
        try {
            // Use string-eval script to avoid tsx/esbuild keep-names helper (`__name`) leaking
            // into browser context evaluate callbacks.
            const serializedToken = JSON.stringify(token)
                .replace(/\u2028/g, '\\u2028')
                .replace(/\u2029/g, '\\u2029');
            const script = `
(() => {
    const solveToken = ${serializedToken};
    const win = window;
    win.__anycrawlTurnstileSolved = false;
    win.__anycrawlTurnstileSolving = true;

    function markSolved(method) {
        win.__anycrawlTurnstileSolved = true;
        win.__turnstileSolved = true;
        win.__anycrawlTurnstileSolving = false;
        return method;
    }

    function markUnsolved(method) {
        win.__anycrawlTurnstileSolving = false;
        return method;
    }

    function resolvePath(root, path) {
        if (!root || typeof path !== 'string') return undefined;
        const parts = path.split('.').map(function (part) { return part.trim(); }).filter(Boolean);
        let current = root;
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (!current || (typeof current !== 'object' && typeof current !== 'function')) return undefined;
            current = current[part];
        }
        return current;
    }

    function invokeIfFunction(candidate, method) {
        if (typeof candidate !== 'function') return null;
        try {
            candidate(solveToken);
            return markSolved(method);
        } catch {
            return null;
        }
    }

    const cfOpt = win._cf_chl_opt || win.__cf_chl_opt || win.cf_chl_opt || {};
    const seenCallbacks = new WeakSet();
    const callbackQueue = [];

    function enqueueCallback(label, fn) {
        if (typeof fn !== 'function') return;
        if (seenCallbacks.has(fn)) return;
        seenCallbacks.add(fn);
        callbackQueue.push({ label: label, fn: fn });
    }

    function enqueueFromName(label, value) {
        if (typeof value === 'function') {
            enqueueCallback(label, value);
            return;
        }
        if (typeof value !== 'string') return;
        const name = value.trim();
        if (!name) return;
        const resolved = win[name] || resolvePath(win, name) || resolvePath(cfOpt, name);
        if (typeof resolved === 'function') {
            enqueueCallback(label + ':' + name, resolved);
        }
    }

    enqueueFromName('direct', win.__anycrawlTurnstileCallback || win.cfCallback || win.tsCallback);
    enqueueFromName('cfOpt.chlCallback', cfOpt.chlCallback);
    enqueueFromName('cfOpt.onSuccess', cfOpt.onSuccess);
    enqueueFromName('cfOpt.callback', cfOpt.callback);
    enqueueFromName('cfOpt.successCallback', cfOpt.successCallback);

    const callbackKeyPattern = /(callback|success|verify|solved|complete|done)/i;
    if (cfOpt && typeof cfOpt === 'object') {
        const stack = [cfOpt];
        const seen = new WeakSet();
        let scanned = 0;
        while (stack.length > 0 && scanned < 500) {
            scanned += 1;
            const current = stack.pop();
            if (!current || typeof current !== 'object') continue;
            if (seen.has(current)) continue;
            seen.add(current);

            if (Array.isArray(current)) {
                for (let i = 0; i < current.length; i++) {
                    const item = current[i];
                    if (item && typeof item === 'object') stack.push(item);
                }
                continue;
            }

            const entries = Object.entries(current);
            for (let i = 0; i < entries.length; i++) {
                const key = entries[i][0];
                const value = entries[i][1];
                const lowered = String(key).toLowerCase();
                if (callbackKeyPattern.test(lowered)) {
                    enqueueFromName('cfOpt:' + lowered, value);
                }
                if (value && typeof value === 'object') stack.push(value);
            }
        }
    }

    for (let i = 0; i < callbackQueue.length; i++) {
        const entry = callbackQueue[i];
        const callbackResult = invokeIfFunction(entry.fn, 'callback:' + entry.label);
        if (callbackResult) return callbackResult;
    }

    function setElementValue(node, value) {
        try {
            const proto = node instanceof HTMLTextAreaElement
                ? HTMLTextAreaElement.prototype
                : HTMLInputElement.prototype;
            const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
            const setter = descriptor && descriptor.set;
            if (setter) setter.call(node, value);
            else node.value = value;
        } catch {
            node.value = value;
        }
        node.setAttribute('value', value);
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
        node.dispatchEvent(new Event('blur', { bubbles: true }));
    }

    const selectors = [
        'input[name="cf-turnstile-response"]',
        'textarea[name="cf-turnstile-response"]',
        'input[id="cf-turnstile-response"]',
        'input[name*="turnstile"][name*="response"]',
        'textarea[name*="turnstile"][name*="response"]',
        'input[id*="turnstile"][id*="response"]',
        'input[name="g-recaptcha-response"]',
        'textarea[name="g-recaptcha-response"]',
        'input[name*="captcha"][name*="response"]',
        'textarea[name*="captcha"][name*="response"]'
    ];

    const touched = new Set();
    let filled = 0;
    let closestForm = null;

    for (let i = 0; i < selectors.length; i++) {
        const selector = selectors[i];
        const nodes = Array.from(document.querySelectorAll(selector));
        for (let j = 0; j < nodes.length; j++) {
            const node = nodes[j];
            if (touched.has(node)) continue;
            touched.add(node);
            if (!node || node.disabled) continue;
            setElementValue(node, solveToken);
            filled += 1;
            if (!closestForm) {
                const parentForm = node.closest('form');
                if (parentForm) closestForm = parentForm;
            }
        }
    }

    const challengeForms = Array.from(document.querySelectorAll('form')).filter(function (form) {
        const idValue = (form.id || '').toLowerCase();
        const actionValue = (form.getAttribute('action') || '').toLowerCase();
        if (idValue.includes('challenge') || idValue.includes('turnstile') || idValue.includes('captcha')) return true;
        if (actionValue.includes('challenge') || actionValue.includes('turnstile') || actionValue.includes('captcha')) return true;
        return Boolean(form.querySelector('[name*="turnstile"], [name*="captcha"], [id*="turnstile"], [id*="captcha"]'));
    });

    const selectedChallengeForm = closestForm && challengeForms.indexOf(closestForm) >= 0
        ? closestForm
        : null;
    const fallbackForm = document.querySelector('form#challenge-form')
        || document.querySelector('form[action*="challenge"]');
    const targetForm = selectedChallengeForm || challengeForms[0] || fallbackForm;

    function ensureHiddenField(form, fieldName) {
        let input = form.querySelector('input[name="' + fieldName + '"]');
        if (!input) {
            input = document.createElement('input');
            input.type = 'hidden';
            input.name = fieldName;
            form.appendChild(input);
        }
        setElementValue(input, solveToken);
        return 1;
    }

    if (targetForm) {
        filled += ensureHiddenField(targetForm, 'cf-turnstile-response');
        filled += ensureHiddenField(targetForm, 'g-recaptcha-response');
    }

    try {
        win.__anycrawlTurnstileToken = solveToken;
        if (cfOpt && typeof cfOpt === 'object') {
            cfOpt.cf_turnstile_response = solveToken;
            cfOpt.turnstileToken = solveToken;
        }
        window.dispatchEvent(new CustomEvent('anycrawl-turnstile-token', {
            detail: { token: solveToken }
        }));
        window.postMessage({
            source: 'anycrawl',
            type: 'turnstile-token',
            token: solveToken
        }, '*');
    } catch {
        // ignore post-message/event dispatch failures
    }

    if (targetForm && filled > 0) {
        try {
            if (typeof targetForm.requestSubmit === 'function') targetForm.requestSubmit();
            else targetForm.submit();
        } catch {
            // ignore submit errors; token may still be consumed asynchronously
        }
        return markSolved('form-submit');
    }

    if (filled > 0) {
        return markSolved('token-input');
    }

    return markUnsolved('no-target');
})()
`;
            return await context.evaluate(script);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.lastInjectError = message;
            log.debug(`[CDPTurnstileSolver] injectTurnstileTokenInContext failed: ${message}`);
            return 'inject-error';
        }
    }

    private async injectTurnstileToken(page: any, token: string): Promise<string> {
        const mainResult = await this.injectTurnstileTokenInContext(page, token);
        if (mainResult !== 'no-target' && mainResult !== 'inject-error') {
            await this.markMainFrameSolved(page);
            return mainResult;
        }

        if (page && typeof page.frames === 'function') {
            const frames = page.frames() as any[];
            const mainFrame = typeof page.mainFrame === 'function' ? page.mainFrame() : null;
            for (let idx = 0; idx < frames.length; idx++) {
                const frame = frames[idx];
                if (!frame) continue;
                if (mainFrame && frame === mainFrame) continue;
                const frameResult = await this.injectTurnstileTokenInContext(frame, token);
                if (frameResult !== 'no-target' && frameResult !== 'inject-error') {
                    await this.markMainFrameSolved(page);
                    return `frame:${idx}:${frameResult}`;
                }
            }
        }

        return mainResult;
    }

    private async setupChallengeScriptInterception(page: any): Promise<void> {
        const isPlaywrightLike = typeof page?.route === 'function' && typeof page?.context === 'function';
        if (!isPlaywrightLike) return;
        if ((page as any).__anycrawlTurnstileRouteHookInstalled) return;
        (page as any).__anycrawlTurnstileRouteHookInstalled = true;

        try {
            await page.route('**/*', async (route: any) => {
                const proceed = async () => {
                    if (typeof route?.fallback === 'function') {
                        return route.fallback();
                    }
                    return route.continue();
                };

                const requestUrl = route.request().url();
                const isChallengeScript = requestUrl.includes('challenges.cloudflare.com')
                    && (requestUrl.includes('/turnstile/') || requestUrl.includes('/cdn-cgi/'));
                if (!isChallengeScript) {
                    return proceed();
                }

                try {
                    for (let i = 0; i < 8; i++) {
                        const scriptReady = await page.evaluate(() => Boolean(
                            (window as any).__anycrawlTurnstileHookInstalled
                            && (window as any).__anycrawlTurnstileReady
                        ))
                            .catch(() => false);
                        if (scriptReady) break;
                        await new Promise((resolve) => setTimeout(resolve, 40));
                    }
                    await new Promise((resolve) => setTimeout(resolve, 40));
                } catch {
                    // ignore interception wait errors
                }

                return proceed();
            });
        } catch (error) {
            log.debug(`[CDPTurnstileSolver] failed to install script interception route: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async installInterceptScript(page: any): Promise<void> {
        try {
            if (typeof page.addInitScript === 'function') {
                await page.addInitScript(TURNSTILE_INTERCEPT_SCRIPT);
                await page.addInitScript(TURNSTILE_POLLING_SCRIPT);
            } else if (typeof page.evaluateOnNewDocument === 'function') {
                await page.evaluateOnNewDocument(TURNSTILE_INTERCEPT_SCRIPT);
                await page.evaluateOnNewDocument(TURNSTILE_POLLING_SCRIPT);
            }
        } catch (error) {
            log.debug(`[CDPTurnstileSolver] failed to install intercept script: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async handleConsoleMessage(page: any, msg: any): Promise<void> {
        if (!this.provider) return;

        const text = typeof msg?.text === 'function' ? msg.text() : String(msg);

        const prefixes = ['anycrawl-turnstile-params:', 'intercepted-params:'];
        const prefix = prefixes.find((value) => text.includes(value));
        if (!prefix) return;

        const raw = text.slice(text.indexOf(prefix) + prefix.length);
        try {
            const parsed = JSON.parse(raw) as any;
            const normalized = this.normalizeTurnstileParams(
                parsed,
                typeof page?.url === 'function' ? page.url() : ''
            );
            if (!normalized?.sitekey) return;

            this.setCapturedParams(normalized);
            try {
                await page.evaluate((params: TurnstileInterceptParams) => {
                    (window as any).__anycrawlTurnstileParams = params;
                }, normalized);
            } catch {
                // ignore sync-back errors
            }
        } catch {
            // ignore malformed console payloads
        }
    }
}

export default CDPTurnstileSolver;
