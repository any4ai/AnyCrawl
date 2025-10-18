import { log, type SandboxContext } from "@anycrawl/libs";
import { SandboxError } from "../errors/index.js";
import { runInNewContext } from "vm";
import { DANGEROUS_PATTERNS, DEFAULT_ALLOWED_PAGE_METHODS } from "../constants/security.js";
export interface SandboxConfig {
    timeout: number; // Execution timeout in milliseconds
    maxPageCalls?: number; // Maximum number of page method calls
    allowedPageMethods?: string[]; // Whitelist of allowed page methods
}

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
     * Create sandboxed console for safe logging
     */
    private createSandboxConsole(): any {
        const formatArgs = (args: any[]) => args.map((arg: any) => {
            if (typeof arg === 'string') return arg;
            if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
            try {
                return JSON.stringify(arg);
            } catch {
                return String(arg);
            }
        }).join(' ');

        return {
            log: (...args: any[]) => log.info(`[SANDBOX] ${formatArgs(args)}`),
            error: (...args: any[]) => console.error(`[SANDBOX] ${formatArgs(args)}`),
            warn: (...args: any[]) => console.warn(`[SANDBOX] ${formatArgs(args)}`),
            // Block other methods for security
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

    /**
     * Execute code using AsyncFunction with Proxy-based security
     */
    private async executeWithAsyncFunction(code: string, context: SandboxContext): Promise<any> {
        const templateId = context.template?.templateId || 'unknown';
        const stats: ExecutionStats = {
            pageMethodCalls: 0,
            startTime: Date.now()
        };

        // Precompute HTML using original page (not proxy)
        const html = await this.resolveFullHtml(context, context.page);

        // Create secure page proxy
        const securePage = context.page ? this.createSecurePageProxy(context.page, stats) : undefined;
        const rawPage = context.page;

        // Create sandboxed console
        const sandboxConsole = this.createSandboxConsole();

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
            {
                data: context.executionContext,
                page: securePage,
                template: context.template,
                html,
                variables: context.variables,
                httpClient: createHttpCrawlee(context.executionContext.userData?.options?.proxy ?? undefined),
                userData: context.executionContext.userData,
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
            },
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
                context: context.executionContext,
                stats: {
                    executionTime,
                    pageMethodCalls: stats.pageMethodCalls
                }
            };
        } catch (error) {
            // Enhance error with template info
            const errorMsg = error instanceof Error ? error.message : String(error);
            throw new SandboxError(`Template ${templateId} execution failed: ${errorMsg}`);
        }
    }

    /**
     * Execute code using VM with complete isolation
     * Page is passed by reference and works across VM context boundary
     */
    private async executeWithVM(code: string, context: SandboxContext): Promise<any> {
        const templateId = context.template?.templateId || 'unknown';
        const startTime = Date.now();
        const rawPage = context.page;

        // Resolve HTML using original page
        const html = await this.resolveFullHtml(context, context.page);

        // Create VM sandbox with page object (passed by reference)
        const sandbox = {
            // Unified context object
            context: {
                data: context.executionContext,
                template: context.template,
                variables: context.variables,
                html,
                page: context.page,
                userData: context.executionContext.userData,
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
            },
            // Direct access to common objects
            template: context.template,
            variables: context.variables,
            page: context.page,
            console: this.createSandboxConsole(),
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
            const result = resultPromise instanceof Promise ? await resultPromise : resultPromise;

            // Log execution stats
            const executionTime = Date.now() - startTime;
            log.info(`[SANDBOX] Template ${templateId} completed in ${executionTime}ms (VM isolation)`);

            return {
                success: true,
                result,
                context: context.executionContext
            };
        } catch (error) {
            // Enhance error with template info
            const errorMsg = error instanceof Error ? error.message : String(error);
            throw new SandboxError(`Template ${templateId} execution failed: ${errorMsg}`);
        }
    }

}