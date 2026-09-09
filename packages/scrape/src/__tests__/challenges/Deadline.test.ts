import { afterEach, expect, jest, test } from "@jest/globals";
import { Deadline } from "../../utils/Deadline.js";
import { smartWaitForDOMStable } from "../../utils/smartWait.js";

afterEach(() => { jest.useRealTimers(); });
test("success clears the timer and an already aborted operation never starts", async () => {
    jest.useFakeTimers();
    const budget = new Deadline(Date.now() + 100);
    expect(await budget.run(async () => "ready")).toBe("ready");
    expect(jest.getTimerCount()).toBe(0);
    const controller = new AbortController();
    controller.abort(new Error("closed"));
    const operation = jest.fn(async () => "late");
    await expect(budget.run(operation, controller.signal)).rejects.toThrow("closed");
    expect(operation).not.toHaveBeenCalled();
});

test("DOM settling uses the remaining challenge budget, even if evaluate hangs", async () => {
    jest.useFakeTimers();
    const page = { isClosed: () => false, evaluate: jest.fn(() => new Promise(() => {})) };
    const startedAt = Date.now();
    const settling = smartWaitForDOMStable(page, "https://example.test/", {
        useCache: false,
        maxWaitMs: 5000,
        deadlineAt: startedAt + 25,
    });
    await jest.advanceTimersByTimeAsync(25);
    await settling;
    expect(Date.now() - startedAt).toBe(25);
    expect(jest.getTimerCount()).toBe(0);
});

test("no DOM wait is started once the challenge budget has expired", async () => {
    const page = { isClosed: () => false, evaluate: jest.fn() };
    await smartWaitForDOMStable(page, "https://example.test/", {
        useCache: false,
        deadlineAt: Date.now() - 1,
    });
    expect(page.evaluate).not.toHaveBeenCalled();
});
