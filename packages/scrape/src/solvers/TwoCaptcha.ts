import axios, { type AxiosError } from 'axios';

export interface TwoCaptchaTurnstileInput {
    pageUrl: string;
    sitekey: string;
    data?: string;
    pagedata?: string;
    action?: string;
    userAgent?: string;
}

export interface TwoCaptchaTurnstileSolveResult {
    success: boolean;
    token?: string;
    userAgent?: string;
    taskId?: string;
    errorCode?: string;
    errorDescription?: string;
}

interface TwoCaptchaCreateTaskResponse {
    errorId: number;
    errorCode?: string;
    errorDescription?: string;
    taskId?: number;
}

interface TwoCaptchaGetTaskResultResponse {
    errorId: number;
    errorCode?: string;
    errorDescription?: string;
    status?: 'idle' | 'processing' | 'ready' | 'failed';
    solution?: {
        token?: string;
        userAgent?: string;
    };
}

interface TwoCaptchaClientOptions {
    apiKey: string;
    apiBaseUrl?: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
    requestTimeoutMs?: number;
}

class TwoCaptchaRequestError extends Error {
    public readonly errorCode: string;
    public readonly errorDescription: string;

    constructor(errorCode: string, errorDescription: string) {
        super(errorDescription);
        this.name = 'TwoCaptchaRequestError';
        this.errorCode = errorCode;
        this.errorDescription = errorDescription;
    }
}

/**
 * 2captcha JSON API client for Cloudflare Turnstile.
 * API reference: https://2captcha.com/api-docs/cloudflare-turnstile
 */
export class TwoCaptchaTurnstileClient {
    private readonly apiKey: string;
    private readonly apiBaseUrl: string;
    private readonly timeoutMs: number;
    private readonly pollIntervalMs: number;
    private readonly requestTimeoutMs: number;

    constructor(options: TwoCaptchaClientOptions) {
        this.apiKey = options.apiKey.trim();
        this.apiBaseUrl = options.apiBaseUrl || process.env.ANYCRAWL_2CAPTCHA_API_BASE || 'https://api.2captcha.com';
        this.timeoutMs = options.timeoutMs ?? this.readEnvInt('ANYCRAWL_2CAPTCHA_TIMEOUT_MS', 60000);
        this.pollIntervalMs = options.pollIntervalMs ?? this.readEnvInt('ANYCRAWL_2CAPTCHA_POLL_MS', 3000);
        this.requestTimeoutMs = options.requestTimeoutMs ?? this.readEnvInt('ANYCRAWL_2CAPTCHA_REQUEST_TIMEOUT_MS', 30000);
    }

    async solve(input: TwoCaptchaTurnstileInput): Promise<TwoCaptchaTurnstileSolveResult> {
        try {
            const taskId = await this.createTask(input);
            const pollResult = await this.pollTaskResult(taskId);
            return {
                ...pollResult,
                taskId,
            };
        } catch (error) {
            const normalized = this.normalizeError(error);
            return {
                success: false,
                errorCode: normalized.errorCode,
                errorDescription: normalized.errorDescription,
            };
        }
    }

    private async createTask(input: TwoCaptchaTurnstileInput): Promise<string> {
        const task: Record<string, unknown> = {
            type: 'TurnstileTaskProxyless',
            websiteURL: input.pageUrl,
            websiteKey: input.sitekey,
        };

        if (input.action) task.action = input.action;
        if (input.data) task.data = input.data;
        if (input.pagedata) task.pagedata = input.pagedata;
        if (input.userAgent) task.userAgent = input.userAgent;

        let responseData: TwoCaptchaCreateTaskResponse;
        try {
            const response = await axios.post<TwoCaptchaCreateTaskResponse>(`${this.apiBaseUrl}/createTask`, {
                clientKey: this.apiKey,
                task,
            }, {
                timeout: this.requestTimeoutMs,
                headers: {
                    'content-type': 'application/json',
                },
            });
            responseData = response.data;
        } catch (error) {
            throw this.normalizeError(error, 'createTask');
        }

        if (!responseData || responseData.errorId !== 0 || !responseData.taskId) {
            throw new TwoCaptchaRequestError(
                responseData?.errorCode || 'TWOCAPTCHA_CREATE_TASK_FAILED',
                responseData?.errorDescription || '2captcha createTask failed'
            );
        }

        return String(responseData.taskId);
    }

    private async pollTaskResult(taskId: string): Promise<TwoCaptchaTurnstileSolveResult> {
        const startAt = Date.now();

        while (Date.now() - startAt < this.timeoutMs) {
            let responseData: TwoCaptchaGetTaskResultResponse;
            try {
                const numericTaskId = Number(taskId);
                const response = await axios.post<TwoCaptchaGetTaskResultResponse>(`${this.apiBaseUrl}/getTaskResult`, {
                    clientKey: this.apiKey,
                    taskId: Number.isFinite(numericTaskId) ? numericTaskId : taskId,
                }, {
                    timeout: this.requestTimeoutMs,
                    headers: {
                        'content-type': 'application/json',
                    },
                });
                responseData = response.data;
            } catch (error) {
                const normalized = this.normalizeError(error, 'getTaskResult');
                return {
                    success: false,
                    errorCode: normalized.errorCode,
                    errorDescription: normalized.errorDescription,
                };
            }

            if (!responseData) {
                return {
                    success: false,
                    errorCode: 'TWOCAPTCHA_EMPTY_RESPONSE',
                    errorDescription: '2captcha getTaskResult returned empty payload',
                };
            }

            if (responseData.errorId !== 0) {
                return {
                    success: false,
                    errorCode: responseData.errorCode || 'TWOCAPTCHA_API_ERROR',
                    errorDescription: responseData.errorDescription || '2captcha returned API error',
                };
            }

            if (responseData.status === 'ready') {
                const token = responseData.solution?.token;
                if (!token) {
                    return {
                        success: false,
                        errorCode: 'TWOCAPTCHA_EMPTY_TOKEN',
                        errorDescription: '2captcha task ready but token is empty',
                    };
                }
                return {
                    success: true,
                    token,
                    userAgent: responseData.solution?.userAgent,
                };
            }

            if (responseData.status === 'failed') {
                return {
                    success: false,
                    errorCode: responseData.errorCode || 'TWOCAPTCHA_TASK_FAILED',
                    errorDescription: responseData.errorDescription || '2captcha task failed',
                };
            }

            await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
        }

        return {
            success: false,
            errorCode: 'TWOCAPTCHA_TIMEOUT',
            errorDescription: `2captcha task polling timed out after ${this.timeoutMs}ms`,
        };
    }

    private normalizeError(error: unknown, op?: string): TwoCaptchaRequestError {
        if (error instanceof TwoCaptchaRequestError) {
            return error;
        }

        if (axios.isAxiosError(error)) {
            const axiosError = error as AxiosError<TwoCaptchaCreateTaskResponse | TwoCaptchaGetTaskResultResponse>;
            const status = axiosError.response?.status;
            const body = axiosError.response?.data;
            const bodyCode = body && typeof body === 'object' ? body.errorCode : undefined;
            const bodyDescription = body && typeof body === 'object' ? body.errorDescription : undefined;
            const code = bodyCode || (status ? `TWOCAPTCHA_HTTP_${status}` : 'TWOCAPTCHA_HTTP_ERROR');
            const description = bodyDescription || axiosError.message || '2captcha HTTP error';
            const suffix = op ? ` (${op})` : '';
            return new TwoCaptchaRequestError(code, `${description}${suffix}`);
        }

        if (error instanceof Error) {
            return new TwoCaptchaRequestError('TWOCAPTCHA_CLIENT_ERROR', error.message);
        }

        return new TwoCaptchaRequestError('TWOCAPTCHA_CLIENT_ERROR', String(error));
    }

    private readEnvInt(name: string, defaultValue: number): number {
        const raw = process.env[name];
        if (!raw) return defaultValue;
        const parsed = parseInt(raw, 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
    }
}
