import { TwoCaptchaTurnstileClient } from "../TwoCaptcha.js";
import type { TurnstileSolverInput, TurnstileSolverProvider, TurnstileSolverResult } from "./TurnstileSolverProvider.js";

interface TwoCaptchaTurnstileProviderOptions {
    apiKey: string;
    solveTimeoutMs?: number;
}

export class TwoCaptchaTurnstileProvider implements TurnstileSolverProvider {
    public readonly name = "2captcha";
    private readonly client: TwoCaptchaTurnstileClient;

    constructor(options: TwoCaptchaTurnstileProviderOptions) {
        this.client = new TwoCaptchaTurnstileClient({
            apiKey: options.apiKey,
            timeoutMs: options.solveTimeoutMs,
        });
    }

    async solve(input: TurnstileSolverInput): Promise<TurnstileSolverResult> {
        return this.client.solve({
            pageUrl: input.pageUrl,
            sitekey: input.sitekey,
            data: input.data,
            pagedata: input.pagedata,
            action: input.action,
            userAgent: input.userAgent,
        });
    }
}
