import { log, type SandboxContext } from "@anycrawl/libs";
import { htmlToMarkdown } from "@anycrawl/libs/html-to-markdown";
import { SandboxError } from "../errors/index.js";
import { runInNewContext } from "vm";
import { DANGEROUS_PATTERNS, DEFAULT_ALLOWED_PAGE_METHODS } from "../constants/security.js";
export interface SandboxConfig {
    timeout: number; // Execution timeout in milliseconds
    maxPageCalls?: number; // Maximum number of page method calls
    allowedPageMethods?: string[]; // Whitelist of allowed page methods
}

export interface SandboxLogEntry {
    level: 'log' | 'warn' | 'error';
    ts: number;
    message: string;
}

const SANDBOX_LOG_MAX_ENTRIES = 200;
const SANDBOX_LOG_MAX_BYTES = 51200; // 50KB

/**
 * Security monitoring for sandbox execution
 */
interface ExecutionStats {
    pageMethodCalls: number;
    startTime: number;
}

/**
 * Secure code execution environment using Node.js built-in vm
 */
export class QuickJSSandbox {
    private config: SandboxConfig;

    // Provide preNav API that proxies to a host implementation injected via executionContext.preNavHost
    private createPreNavApi(sandboxCtx: SandboxContext) {
        const host = (sandboxCtx.executionContext as any)?.preNavHost;
        log.debug(`[createPreNavApi] host exists: ${!!host}, keys: ${host ? Object.keys(host).join(',') : 'N/A'}`);
        log.debug(`[createPreNavApi] executionContext keys: ${sandboxCtx.executionContext ? Object.keys(sandboxCtx.executionContext).join(',') : 'N/A'}`);

        const ensure = (fnName: string) => {
            if (!host || typeof host[fnName] !== 'function') {
                log.error(`[createPreNavApi] preNav host validation failed: host=${!!host}, fnName=${fnName}, type=${host ? typeof host[fnName] : 'N/A'}`);
                throw new SandboxError(`preNav host is not available: missing ${fnName}()`);
            }
        };

        const preNavApi = {
            wait: async (key: string, opts?: { timeoutMs?: number }) => {
                ensure('wait');
                log.debug(`[preNav.wait] called with key=${key}, opts=${JSON.stringify(opts)}`);
                const result = await host.wait(key, opts);
                if (result === undefined) {
                    log.warning(`[preNav.wait] timeout for key=${key} - no data captured`);
                } else {
                    log.debug(`[preNav.wait] result for key=${key}: ${JSON.stringify(result).substring(0, 200)}`);
                }
                return result;
            },
            get: async (key: string) => {
                ensure('get');
                log.debug(`[preNav.get] called with key=${key}`);
                const result = await host.get(key);
                log.debug(`[preNav.get] result for key=${key}: ${JSON.stringify(result).substring(0, 200)}`);
                return result;
            },
            has: async (key: string) => {
                ensure('has');
                log.debug(`[preNav.has] called with key=${key}`);
                const result = await host.has(key);
                log.debug(`[preNav.has] result for key=${key}: ${result}`);
                return result;
            },
            // Custom serialization for console.log and JSON.stringify
            toJSON: () => {
                return {
                    _type: 'PreNavAPI',
                    _description: 'Pre-navigation data capture API',
                    _methods: ['wait(key, opts?)', 'get(key)', 'has(key)'],
                    _example: 'const data = await preNav.wait("xUserTweets", { timeoutMs: 10000 })',
                    _note: 'wait() returns undefined on timeout (no error thrown)',
                    _available: !!host
                };
            },
            // Custom string representation
            toString: () => {
                return '[PreNavAPI: wait, get, has]';
            },
            // Inspection symbol for better Node.js console output
            [Symbol.for('nodejs.util.inspect.custom')]: () => {
                return {
                    type: 'PreNavAPI',
                    methods: {
                        wait: '(key: string, opts?: { timeoutMs?: number }) => Promise<any | undefined>',
                        get: '(key: string) => Promise<any | undefined>',
                        has: '(key: string) => Promise<boolean>'
                    },
                    note: 'wait() returns undefined on timeout',
                    available: !!host
                };
            }
        };

        return preNavApi;
    }

    /**
     * Resolve full HTML content from available sources in a consistent order.
     * Order: scrapeResult.rawHtml -> scrapeResult.html -> response.body -> page.content()
     */
    private async resolveFullHtml(context: SandboxContext, page?: any): Promise<string | undefined> {
        // 1) Prefer rawHtml/html from scrapeResult
        const scrapeResult: any = (context.executionContext as any)?.scrapeResult;
        let html: string | undefined =
            (scrapeResult && typeof scrapeResult.rawHtml === 'string' && scrapeResult.rawHtml) || undefined;

        // 2) Fallback to response.body
        if (!html) {
            try {
                const resp: any = (context.executionContext as any)?.response;
                const body = resp?.body;
                if (body && typeof body === 'object' && typeof body.toString === 'function') {
                    html = body.toString('utf-8');
                }
            } catch { /* ignore */ }
        }

        // 3) Last resort: page.content() if page is provided and not closed (trusted path only)
        if (!html && page && typeof page.content === 'function') {
            try {
                if (typeof page.isClosed === 'function' && page.isClosed()) {
                    // skip if closed
                } else {
                    html = await page.content();
                }
            } catch { /* ignore */ }
        }

        return html;
    }

    /**
     * Resolve markdown from the HTML snapshot exposed to template code.
     */
    private resolveMarkdown(html?: string): string | undefined {
        if (!html) return undefined;
        return htmlToMarkdown(html);
    }

    private withMarkdownGetter<T extends object>(sandboxContext: T, html?: string): T {
        let resolved = false;
        let markdown: string | undefined;

        Object.defineProperty(sandboxContext, 'markdown', {
            enumerable: true,
            get: () => {
                if (!resolved) {
                    markdown = this.resolveMarkdown(html);
                    resolved = true;
                }
                return markdown;
            }
        });

        return sandboxContext;
    }

    constructor(config?: Partial<SandboxConfig>) {
        // Read timeout from environment variable or use default
        const envTimeout = process.env.ANYCRAWL_TEMPLATE_EXECUTION_TIMEOUT
            ? parseInt(process.env.ANYCRAWL_TEMPLATE_EXECUTION_TIMEOUT)
            : 60000; // 60 seconds default for browser automation

        this.config = {
            timeout: config?.timeout || envTimeout,
            maxPageCalls: config?.maxPageCalls || 1000,
            allowedPageMethods: config?.allowedPageMethods || [...DEFAULT_ALLOWED_PAGE_METHODS],
        };

        log.info(`[SANDBOX] Initialized: timeout=${this.config.timeout}ms, maxPageCalls=${this.config.maxPageCalls}`);
    }

    /**
     * Perform static code analysis to detect dangerous patterns
     */
    private analyzeCodeSafety(code: string): { safe: boolean; violations: string[] } {
        const violations: string[] = [];

        for (const { pattern, message } of DANGEROUS_PATTERNS) {
            if (pattern.test(code)) {
                violations.push(message);
            }
        }

        return {
            safe: violations.length === 0,
            violations
        };
    }

    /**
     * Create sandboxed console for safe logging.
     * When logBuffer is provided, log entries are captured for return to the caller.
     */
    private createSandboxConsole(logBuffer?: SandboxLogEntry[]): any {
        const formatArgs = (args: any[]) => args.map((arg: any) => {
            if (typeof arg === 'string') return arg;
            if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
            try {
                return JSON.stringify(arg);
            } catch {
                return String(arg);
            }
        }).join(' ');

        let totalBytes = 0;
        const pushLog = (level: SandboxLogEntry['level'], msg: string) => {
            if (!logBuffer) return;
            if (logBuffer.length >= SANDBOX_LOG_MAX_ENTRIES) return;
            if (totalBytes >= SANDBOX_LOG_MAX_BYTES) return;
            totalBytes += msg.length;
            logBuffer.push({ level, ts: Date.now(), message: msg });
        };

        return {
            log: (...args: any[]) => { const m = formatArgs(args); log.info(`[SANDBOX] ${m}`); pushLog('log', m); },
            error: (...args: any[]) => { const m = formatArgs(args); console.error(`[SANDBOX] ${m}`); pushLog('error', m); },
            warn: (...args: any[]) => { const m = formatArgs(args); console.warn(`[SANDBOX] ${m}`); pushLog('warn', m); },
            info: () => { throw new SandboxError('console.info is not allowed'); },
            debug: () => { throw new SandboxError('console.debug is not allowed'); },
            trace: () => { throw new SandboxError('console.trace is not allowed'); },
        };
    }

    /**
     * Create a secure Proxy wrapper for the page object
     */
    private createSecurePageProxy(page: any, stats: ExecutionStats): any {
        const allowedMethods = this.config.allowedPageMethods || [];
        const maxCalls = this.config.maxPageCalls || 1000;

        return new Proxy(page, {
            get: (target, prop: string | symbol) => {
                // Allow symbol properties (used by Playwright internally)
                if (typeof prop === 'symbol') {
                    return target[prop];
                }

                // Check if method is in whitelist
                if (!allowedMethods.includes(prop)) {
                    throw new SandboxError(
                        `Access to page.${prop} is not allowed. Allowed methods: ${allowedMethods.join(', ')}`
                    );
                }

                // Check call limit
                if (stats.pageMethodCalls >= maxCalls) {
                    throw new SandboxError(
                        `Maximum page method calls (${maxCalls}) exceeded for security`
                    );
                }

                const value = target[prop];

                // If it's a function, wrap it to count calls and add security checks
                if (typeof value === 'function') {
                    // Return an async function to properly handle page methods (which return Promises)
                    return async (...args: any[]) => {
                        stats.pageMethodCalls++;
                        log.info(`[SANDBOX] page.${prop} called (${stats.pageMethodCalls}/${maxCalls})`);

                        // Special security check for evaluate methods
                        if (prop === 'evaluate' || prop === 'evaluateHandle' || prop === '$eval' || prop === '$$eval') {
                            // The first argument is the function/code to evaluate
                            if (args.length > 0 && typeof args[0] === 'string') {
                                // If it's a string, check for dangerous patterns
                                const codeCheck = this.analyzeCodeSafety(args[0]);
                                if (!codeCheck.safe) {
                                    throw new SandboxError(
                                        `page.${prop} contains forbidden patterns:\n${codeCheck.violations.join('\n')}`
                                    );
                                }
                            }
                            log.debug(`[SANDBOX] page.${prop} executing browser-side code`);
                        }

                        // Call with correct 'this' binding - await to handle Promise properly
                        return await value.call(target, ...args);
                    };
                }

                return value;
            },
            set: () => {
                throw new SandboxError('Modifying page object is not allowed');
            },
            deleteProperty: () => {
                throw new SandboxError('Deleting page properties is not allowed');
            }
        });
    }

    /**
     * Returns true when sandbox log capture should be active.
     * Active when NODE_ENV=development (always-on locally) or when the
     * template sets metadata.debug=true (opt-in per template in production).
     */
    private isDebugEnabled(context: SandboxContext): boolean {
        if (process.env.NODE_ENV === 'development') return true;
        return context.template?.metadata?.debug === true;
    }

    /**
     * Execute code in sandbox - choose execution method based on trust level
     * Both methods support page access with concurrent execution guarantees
     * Note: Code safety is already validated by TemplateCodeValidator before execution
     */
    async executeCode(code: string, context: SandboxContext): Promise<any> {
        const isTrusted = context.template?.trusted === true;
        const templateId = context.template?.templateId || 'unknown';

        if (isTrusted) {
            // Trusted: AsyncFunction with Proxy-based security
            log.info(`[SANDBOX] Trusted template (${templateId}): AsyncFunction + Proxy security`);
            return await this.executeWithAsyncFunction(code, context);
        } else {
            // Non-trusted: VM with complete isolation
            log.info(`[SANDBOX] Non-trusted template (${templateId}): VM isolation`);
            return await this.executeWithVM(code, context);
        }
    }

    private async executeWithAsyncFunction(code: string, context: SandboxContext): Promise<any> {
        const templateId = context.template?.templateId || 'unknown';
        const debugMode = this.isDebugEnabled(context);
        const logBuffer: SandboxLogEntry[] | undefined = debugMode ? [] : undefined;
        const stats: ExecutionStats = {
            pageMethodCalls: 0,
            startTime: Date.now()
        };

        // Precompute HTML using original page (not proxy)
        const html = await this.resolveFullHtml(context, context.page);

        // Create secure page proxy
        const securePage = context.page ? this.createSecurePageProxy(context.page, stats) : undefined;
        const rawPage = context.page;

        // Create sandboxed console (with log capture when debug=true)
        const sandboxConsole = this.createSandboxConsole(logBuffer);

        // Create parameter names and values
        const paramNames = [
            'context',
            'template',
            'variables',
            'page',
            'console',
            'JSON',
            'Math',
            'Date',
            'RegExp',
            'Error',
            'TypeError',
            'ReferenceError',
            'SyntaxError',
            'Promise',
        ];
        const { createHttpCrawlee } = await import('../libs/http-client.js');
        const paramValues = [
            // Unified context object
            this.withMarkdownGetter({
                data: context.executionContext,
                page: securePage,
                template: context.template,
                html,
                variables: context.variables,
                httpClient: createHttpCrawlee(context.executionContext.userData?.options?.proxy ?? undefined),
                userData: context.executionContext.userData,
                preNav: this.createPreNavApi(context),
                // Safe helper to read cookies without exposing page.context()
                cookies: async () => {
                    try {
                        if (!rawPage || typeof rawPage.context !== 'function') return [];
                        const ctx = rawPage.context();
                        if (!ctx || typeof ctx.cookies !== 'function') return [];
                        return await ctx.cookies();
                    } catch {
                        return [];
                    }
                }
            }, html),
            context.template,
            context.variables,
            securePage,
            sandboxConsole,
            JSON,
            Math,
            Date,
            RegExp,
            Error,
            TypeError,
            ReferenceError,
            SyntaxError,
            Promise,
        ];

        try {
            // Create and execute async function
            const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
            const fn = new AsyncFunction(...paramNames, code);

            // Set a timeout wrapper
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => {
                    reject(new Error(`Execution timeout (${this.config.timeout}ms)`));
                }, this.config.timeout);
            });

            const executionPromise = fn(...paramValues);
            const result = await Promise.race([executionPromise, timeoutPromise]);

            // Log execution stats
            const executionTime = Date.now() - stats.startTime;
            log.info(`[SANDBOX] Template ${templateId} completed in ${executionTime}ms with ${stats.pageMethodCalls} page calls`);

            return {
                success: true,
                result,
                logs: logBuffer || [],
                context: context.executionContext,
                stats: {
                    executionTime,
                    pageMethodCalls: stats.pageMethodCalls
                }
            };
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            logBuffer?.push({ level: 'error', ts: Date.now(), message: `Execution failed: ${errorMsg}` });
            const sandboxErr = new SandboxError(`Template ${templateId} execution failed: ${errorMsg}`);
            (sandboxErr as any).logs = logBuffer || [];
            throw sandboxErr;
        }
    }

    /**
     * Execute code using VM with complete isolation
     * Page is passed by reference and works across VM context boundary
     */
    private async executeWithVM(code: string, context: SandboxContext): Promise<any> {
        const templateId = context.template?.templateId || 'unknown';
        const debugMode = this.isDebugEnabled(context);
        const logBuffer: SandboxLogEntry[] | undefined = debugMode ? [] : undefined;
        const startTime = Date.now();
        const rawPage = context.page;

        // Resolve HTML using original page
        const html = await this.resolveFullHtml(context, context.page);

        // Create VM sandbox with page object (passed by reference)
        const sandbox = {
            // Unified context object
            context: this.withMarkdownGetter({
                data: context.executionContext,
                template: context.template,
                variables: context.variables,
                html,
                page: context.page,
                userData: context.executionContext.userData,
                preNav: this.createPreNavApi(context),
                // Safe helper to read cookies without exposing page.context()
                cookies: async () => {
                    try {
                        if (!rawPage || typeof rawPage.context !== 'function') return [];
                        const ctx = rawPage.context();
                        if (!ctx || typeof ctx.cookies !== 'function') return [];
                        return await ctx.cookies();
                    } catch {
                        return [];
                    }
                }
            }, html),
            // Direct access to common objects
            template: context.template,
            variables: context.variables,
            page: context.page,
            console: this.createSandboxConsole(logBuffer),
            // Standard JS objects
            JSON,
            Math,
            Date,
            RegExp,
            Error,
            TypeError,
            ReferenceError,
            SyntaxError,
            Promise,
            // Note: Timers are NOT provided in VM for security
            // VM has built-in timeout protection via runInNewContext options
        };

        // Wrap code in async function for return/await support
        const wrappedCode = `(async function() { ${code} })()`;

        try {
            // Execute in isolated VM context
            const resultPromise = runInNewContext(wrappedCode, sandbox, {
                timeout: this.config.timeout,
                displayErrors: true
            });

            // Await result if it's a Promise
            const result = resultPromise && typeof resultPromise.then === 'function' ? await resultPromise : resultPromise;

            // Log execution stats
            const executionTime = Date.now() - startTime;
            log.info(`[SANDBOX] Template ${templateId} completed in ${executionTime}ms (VM isolation)`);

            return {
                success: true,
                result,
                logs: logBuffer || [],
                context: context.executionContext
            };
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            logBuffer?.push({ level: 'error', ts: Date.now(), message: `Execution failed: ${errorMsg}` });
            const sandboxErr = new SandboxError(`Template ${templateId} execution failed: ${errorMsg}`);
            (sandboxErr as any).logs = logBuffer || [];
            throw sandboxErr;
        }
    }

}
