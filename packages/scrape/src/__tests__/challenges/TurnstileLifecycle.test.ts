import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { runInNewContext, createContext, runInContext } from "node:vm";
import { EventEmitter } from "node:events";
import axios from "axios";
import {
    CDPTurnstileSolver,
    TURNSTILE_INTERCEPT_SCRIPT,
} from "../../solvers/CDPTurnstileSolver.js";
import { TwoCaptchaTurnstileClient } from "../../solvers/TwoCaptcha.js";
import type { TurnstileSolverInput } from "../../solvers/providers/TurnstileSolverProvider.js";
const originalEnvironment = process.env;

function attachBindingPage(page: any, solver: any) {
    const window: any = { __anycrawlTurnstileCallback: jest.fn() };
    const context = createContext({ URL, window, document: { querySelectorAll: () => [] }, location: { href: page.url() } });
    page.evaluate = async (fn: Function, arg: any) => {
        window.__anycrawlTurnstileParams = solver.lastCapturedParams;
        context.arg = arg;
        return runInContext(`(${fn.toString()})(arg)`, context);
    };
    return window.__anycrawlTurnstileCallback;
}


afterEach(() => {
    process.env = originalEnvironment;
    jest.useRealTimers();
    jest.restoreAllMocks();
});

describe("Turnstile lifecycle", () => {
    test("a polling HTTP request aborted by the deadline is reported as timeout", async () => {
        jest.useFakeTimers();
        jest.spyOn(axios, "post").mockImplementation(async (url: any, _data: any, options: any) => {
            if (url.endsWith("/createTask")) return { data: { errorId: 0, taskId: 1 } } as any;
            return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("request aborted")), { once: true }));
        });
        const client = new TwoCaptchaTurnstileClient({ apiKey: "fixture", timeoutMs: 100 });
        const pending = client.solve({ pageUrl: "https://example.test/", sitekey: "fixture" });
        await jest.advanceTimersByTimeAsync(100);
        expect((await pending).errorCode).toBe("TWOCAPTCHA_TIMEOUT");
    });
    test("an explicitly confirmed challenge is not abandoned by a weaker DOM-only check", async () => {
        process.env = { ...originalEnvironment, ANYCRAWL_2CAPTCHA_PARAM_ATTEMPTS: "45", ANYCRAWL_2CAPTCHA_PARAM_WAIT_MS: "300" };
        jest.useFakeTimers();
        const solve = jest.fn(async () => ({ success: false }));
        const solver = new CDPTurnstileSolver({ provider: { name: "fixture", solve } });
        const page = Object.assign(new EventEmitter(), {
            isClosed: () => false, url: () => "https://example.test/",
            evaluate: jest.fn(async () => false), frames: () => [],
        });
        jest.spyOn(solver as any, "extractTurnstileParamsFromContext").mockResolvedValue(null);
        jest.spyOn(solver, "isChallenge").mockResolvedValue(false);
        let finished = false;
        const pending = solver.solveDirect(page.url(), page, { forceAttempt: true }).then((result) => { finished = true; return result; });
        await jest.advanceTimersByTimeAsync(4000);
        expect(finished).toBe(false);
        await jest.advanceTimersByTimeAsync(10000);
        expect((await pending).errorCode).toBe("TWOCAPTCHA_PARAMS_MISSING");
        expect(solve).not.toHaveBeenCalled();
    });
    test("early parameter capture preserves real widget return, callback, execute, and this", () => {
        const logs: string[] = [];
        let poll: (() => void) | undefined;
        const window: any = {
            location: { href: "https://example.test/" },
            addEventListener: jest.fn(),
        };
        runInNewContext(TURNSTILE_INTERCEPT_SCRIPT, {
            window,
            navigator: { userAgent: "native-UA" },
            document: { querySelector: () => null },
            console: { log: (text: string) => logs.push(text) },
            setInterval: (callback: () => void) => { poll = callback; return 1; },
            setTimeout: () => 2,
            clearInterval: jest.fn(),
        });
        expect(window.turnstile).toBeUndefined();
        expect(Object.prototype.hasOwnProperty.call(window, 'turnstile')).toBe(false);
        const callback = jest.fn();
        const widget = {
            render(this: unknown, _container: unknown, options: any) {
                expect(this).toBe(widget);
                options.callback("native-token");
                return "real-widget-id";
            },
            execute: jest.fn(() => "real-execute"),
            getResponse: () => "native-token",
        };
        window.turnstile = widget;
        poll!();
        expect(window.turnstile.render("#widget", { sitekey: "test-sitekey", callback })).toBe(
            "real-widget-id"
        );
        expect(callback).toHaveBeenCalledWith("native-token");
        expect(widget.execute()).toBe("real-execute");
        expect(widget.getResponse()).toBe("native-token");
        expect(window.__anycrawlTurnstileParams).toMatchObject({
            sitekey: "test-sitekey",
            userAgent: "native-UA",
        });
        expect(logs).toHaveLength(1);
    });

    test("concurrent callers on one page share one provider task and one callback", async () => {
        jest.useFakeTimers();
        const solve = jest.fn(async () => { await new Promise(resolve => setTimeout(resolve, 20)); return { success: true, token: "shared-token" }; });
        const solver = new CDPTurnstileSolver({ provider: { name: "fixture", solve } });
        const page = Object.assign(new EventEmitter(), { isClosed: () => false, url: () => "https://example.test/" });
        (solver as any).setCapturedParams({ sitekey: "fixture", pageurl: page.url() });
        const callback = attachBindingPage(page, solver);
        const one = solver.solveDirect(page.url(), page); const two = solver.solveDirect(page.url(), page);
        await jest.advanceTimersByTimeAsync(30);
        expect((await one).success).toBe(true); expect((await two).success).toBe(true);
        expect(solve).toHaveBeenCalledTimes(1); expect(callback).toHaveBeenCalledTimes(1);
        expect(page.listenerCount("close")).toBe(0);
    });
    test("provider result cannot inject after the live challenge parameters change", async () => {
        let solver: CDPTurnstileSolver;
        const solve = jest.fn(async () => {
            (solver as any).setCapturedParams({ sitekey: "fixture", pageurl: "https://example.test/", data: "new" });
            return { success: true, token: "old-token" };
        });
        solver = new CDPTurnstileSolver({ provider: { name: "fixture", solve } });
        const page = Object.assign(new EventEmitter(), { isClosed: () => false, url: () => "https://example.test/" });
        (solver as any).setCapturedParams({ sitekey: "fixture", pageurl: page.url(), data: "old" });
        const callback = attachBindingPage(page, solver);
        expect((await solver.solveDirect(page.url(), page)).errorCode).toBe("TWOCAPTCHA_STALE_RESULT");
        expect(solve).toHaveBeenCalledTimes(1); expect(callback).not.toHaveBeenCalled();
    });
    test("cancellation during polling sleep returns without another HTTP request", async () => {
        jest.useFakeTimers();
        const post = jest.spyOn(axios, "post").mockImplementation(async (url: any) => url.endsWith("/createTask")
            ? { data: { errorId: 0, taskId: 1 } } as any : { data: { errorId: 0, status: "processing" } } as any);
        const controller = new AbortController();
        const client = new TwoCaptchaTurnstileClient({ apiKey: "fixture", timeoutMs: 5000, pollIntervalMs: 3000 });
        const pending = client.solve({ pageUrl: "https://example.test/", sitekey: "fixture", signal: controller.signal });
        await jest.advanceTimersByTimeAsync(0); controller.abort();
        expect((await pending).errorCode).toBe("TWOCAPTCHA_CANCELLED");
        expect(post).toHaveBeenCalledTimes(2); expect(jest.getTimerCount()).toBe(0);
    });

    test("an expired budget creates no provider task", async () => {
        const solve = jest.fn(async () => ({ success: true, token: "secret" }));
        const solver = new CDPTurnstileSolver({ provider: { name: "fixture", solve } });
        const result = await solver.solveDirect("https://example.test/", new EventEmitter(), {
            deadlineAt: Date.now() - 1,
        });
        expect(result.errorCode).toBe("TWOCAPTCHA_TIMEOUT");
        expect(solve).not.toHaveBeenCalled();
    });

    test("a late provider result is aborted and cannot inject after the deadline", async () => {
        jest.useFakeTimers();
        let signal: AbortSignal | undefined;
        const solve = jest.fn((input: TurnstileSolverInput) => {
            signal = input.signal;
            return new Promise<{ success: boolean; token: string }>((resolve) =>
                setTimeout(() => resolve({ success: true, token: "late-secret" }), 100)
            );
        });
        const solver = new CDPTurnstileSolver({ provider: { name: "fixture", solve } });
        const page = Object.assign(new EventEmitter(), {
            isClosed: () => false,
            url: () => "https://example.test/",
        });
        (solver as any).setCapturedParams({
            sitekey: "fixture",
            pageurl: page.url(),
            userAgent: "native-UA",
        });
        const callback = attachBindingPage(page, solver);
        const pending = solver.solveDirect(page.url(), page, { deadlineAt: Date.now() + 20 });
        await jest.advanceTimersByTimeAsync(20);
        expect((await pending).errorCode).toBe("TWOCAPTCHA_TIMEOUT");
        expect(signal?.aborted).toBe(true);
        await jest.advanceTimersByTimeAsync(100);
        expect(callback).not.toHaveBeenCalled();
        expect(page.listenerCount("close")).toBe(0);
    });

    test("createTask and polling share one budget; final sleep cannot overshoot", async () => {
        jest.useFakeTimers();
        const requests: Array<{ url: string; timeout: number }> = [];
        jest.spyOn(axios, "post").mockImplementation(async (url: any, _data: any, options: any) => {
            requests.push({ url, timeout: options.timeout });
            if (url.endsWith("/createTask")) {
                await new Promise((resolve) => setTimeout(resolve, 40));
                return { data: { errorId: 0, taskId: 1 } } as any;
            }
            return { data: { errorId: 0, status: "processing" } } as any;
        });
        const client = new TwoCaptchaTurnstileClient({
            apiKey: "fixture",
            timeoutMs: 100,
            pollIntervalMs: 3000,
        });
        const started = Date.now();
        const pending = client.solve({ pageUrl: "https://example.test/", sitekey: "fixture" });
        await jest.advanceTimersByTimeAsync(100);
        expect((await pending).errorCode).toBe("TWOCAPTCHA_TIMEOUT");
        expect(Date.now() - started).toBe(100);
        expect(requests.map((request) => request.timeout)).toEqual([100, 60]);
    });

    test("closing the page cancels a pending provider without injecting", async () => {
        const solve = jest.fn(
            (_input: TurnstileSolverInput) => new Promise<{ success: boolean }>(() => {})
        );
        const solver = new CDPTurnstileSolver({ provider: { name: "fixture", solve } });
        const page = Object.assign(new EventEmitter(), {
            isClosed: () => false,
            url: () => "https://example.test/",
        });
        (solver as any).setCapturedParams({ sitekey: "fixture", pageurl: page.url() });
        attachBindingPage(page, solver);
        const pending = solver.solveDirect(page.url(), page);
        await Promise.resolve();
        page.emit("close");
        expect((await pending).errorCode).toBe("TWOCAPTCHA_CANCELLED");
        expect(page.listenerCount("close")).toBe(0);
    });

    test("context verification cancellation aborts the provider and prevents late injection", async () => {
        jest.useFakeTimers(); const owner = new AbortController(); let providerSignal: AbortSignal | undefined;
        const solve = jest.fn(async (input: TurnstileSolverInput) => {
            providerSignal = input.signal;
            await new Promise(resolve => setTimeout(resolve, 100));
            return { success: true, token: 'cancelled-owner-token' };
        });
        const solver = new CDPTurnstileSolver({ provider: { name: 'fixture', solve } });
        const page = Object.assign(new EventEmitter(), { isClosed: () => false, url: () => 'https://example.test/' });
        (solver as any).setCapturedParams({ sitekey: 'fixture', pageurl: page.url() });
        const callback = attachBindingPage(page, solver);
        const pending = solver.solveDirect(page.url(), page, { signal: owner.signal });
        await jest.advanceTimersByTimeAsync(0); owner.abort();
        expect((await pending).errorCode).toBe('TWOCAPTCHA_CANCELLED');
        expect(providerSignal?.aborted).toBe(true);
        await jest.advanceTimersByTimeAsync(100); expect(callback).not.toHaveBeenCalled();
        expect(page.listenerCount('close')).toBe(0); expect(jest.getTimerCount()).toBe(0);
    });

    test("CloakBrowser native identity is never changed to match a solver response", async () => {
        const solve = jest.fn(async () => ({
            success: true,
            token: "secret",
            userAgent: "other-UA",
        }));
        const solver = new CDPTurnstileSolver({
            provider: { name: "fixture", solve },
            preserveUserAgent: true,
        });
        const page = Object.assign(new EventEmitter(), {
            isClosed: () => false,
            url: () => "https://example.test/",
        });
        (solver as any).setCapturedParams({
            sitekey: "fixture",
            pageurl: page.url(),
            userAgent: "native-UA",
        });
        const override = jest.spyOn(solver as any, "applySolvedUserAgent");
        const callback = attachBindingPage(page, solver);
        expect((await solver.solveDirect(page.url(), page)).errorCode).toBe(
            "TWOCAPTCHA_USER_AGENT_MISMATCH"
        );
        expect(override).not.toHaveBeenCalled();
        expect(callback).not.toHaveBeenCalled();
    });
});
