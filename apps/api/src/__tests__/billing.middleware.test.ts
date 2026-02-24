import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { Billing } from "@anycrawl/db";
import { RequestWithAuth } from "@anycrawl/libs";
import { deductCreditsMiddleware } from "../middlewares/DeductCreditsMiddleware.js";

interface MockedRequest extends Partial<RequestWithAuth> {
    method: string;
    path: string;
    route?: { path?: string };
    jobId?: string;
    creditsUsed?: number;
}

interface MockedResponse {
    statusCode: number;
    on: (event: string, listener: () => void) => MockedResponse;
}

function createMockResponse(statusCode: number): {
    res: MockedResponse;
    emit: (event: string) => void;
} {
    const listeners = new Map<string, () => void>();
    const res: MockedResponse = {
        statusCode,
        on: (event: string, listener: () => void) => {
            listeners.set(event, listener);
            return res;
        },
    };

    return {
        res,
        emit: (event: string) => {
            const handler = listeners.get(event);
            if (handler) {
                handler();
            }
        },
    };
}

async function waitFor(assertion: () => void, timeoutMs = 7000): Promise<void> {
    const started = Date.now();
    let lastError: Error | null = null;

    while (Date.now() - started < timeoutMs) {
        try {
            assertion();
            return;
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }

    throw lastError || new Error("waitFor timeout");
}

describe("DeductCreditsMiddleware billing behavior", () => {
    const originalAuthEnabled = process.env.ANYCRAWL_API_AUTH_ENABLED;
    const originalCreditsEnabled = process.env.ANYCRAWL_API_CREDITS_ENABLED;

    beforeAll(() => {
        process.env.ANYCRAWL_API_AUTH_ENABLED = "true";
        process.env.ANYCRAWL_API_CREDITS_ENABLED = "true";
    });

    beforeEach(() => {
        process.env.ANYCRAWL_API_AUTH_ENABLED = "true";
        process.env.ANYCRAWL_API_CREDITS_ENABLED = "true";
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    afterAll(() => {
        process.env.ANYCRAWL_API_AUTH_ENABLED = originalAuthEnabled;
        process.env.ANYCRAWL_API_CREDITS_ENABLED = originalCreditsEnabled;
    });

    it("uses target mode and retries without extra charging on transient failures", async () => {
        const chargeDetails = {
            version: 1 as const,
            basis: "charged_delta" as const,
            calculator: "scrape_v1",
            total: 7,
            items: [
                { code: "base_scrape", credits: 1 },
                { code: "json_llm_extract", credits: 6 },
            ],
        };
        const targetSpy = jest
            .spyOn(Billing, "chargeToUsedByJobId")
            .mockRejectedValueOnce(new Error("transient-1"))
            .mockRejectedValueOnce(new Error("transient-2"))
            .mockResolvedValue({
                jobId: "job-target-retry",
                charged: 7,
                currentUsed: 7,
                remainingCredits: 93,
            });
        const deltaSpy = jest.spyOn(Billing, "chargeDeltaByJobId").mockResolvedValue({
            jobId: "unused",
            charged: 0,
            currentUsed: 0,
            remainingCredits: 0,
        });

        const req = {
            method: "POST",
            path: "/v1/scrape",
            route: { path: "/v1/scrape" },
            jobId: "job-target-retry",
            creditsUsed: 7,
            billingChargeDetails: chargeDetails,
        } as MockedRequest;
        const { res, emit } = createMockResponse(200);
        const next = jest.fn();

        await deductCreditsMiddleware(req as RequestWithAuth, res as unknown as any, next);
        emit("finish");
        expect(next).toHaveBeenCalledTimes(1);

        await waitFor(() => {
            expect(targetSpy).toHaveBeenCalledTimes(3);
        }, 9000);

        expect(deltaSpy).not.toHaveBeenCalled();
        expect(targetSpy).toHaveBeenCalledWith({
            jobId: "job-target-retry",
            targetUsed: 7,
            reason: "api_request_finalize",
            idempotencyKey: "api:request-finalize:job-target-retry:7",
            chargeDetails,
        });
    }, 15000);

    it("uses delta mode for crawl creation route, including trailing slash", async () => {
        const deltaSpy = jest.spyOn(Billing, "chargeDeltaByJobId").mockResolvedValue({
            jobId: "job-crawl-initial",
            charged: 3,
            currentUsed: 3,
            remainingCredits: 97,
        });
        const targetSpy = jest.spyOn(Billing, "chargeToUsedByJobId").mockResolvedValue({
            jobId: "unused",
            charged: 0,
            currentUsed: 0,
            remainingCredits: 0,
        });

        const req = {
            method: "POST",
            path: "/v1/crawl/",
            route: { path: "/v1/crawl" },
            jobId: "job-crawl-initial",
            creditsUsed: 3,
        } as MockedRequest;
        const { res, emit } = createMockResponse(200);
        const next = jest.fn();

        await deductCreditsMiddleware(req as RequestWithAuth, res as unknown as any, next);
        emit("finish");
        expect(next).toHaveBeenCalledTimes(1);

        await waitFor(() => {
            expect(deltaSpy).toHaveBeenCalledTimes(1);
        });
        expect(targetSpy).not.toHaveBeenCalled();
        expect(deltaSpy).toHaveBeenCalledWith({
            jobId: "job-crawl-initial",
            delta: 3,
            reason: "api_crawl_initial",
            idempotencyKey: "api:crawl-initial:job-crawl-initial",
        });
    });

    it("skips deduction when jobId is missing", async () => {
        const deltaSpy = jest.spyOn(Billing, "chargeDeltaByJobId").mockResolvedValue({
            jobId: "unused",
            charged: 0,
            currentUsed: 0,
            remainingCredits: 0,
        });
        const targetSpy = jest.spyOn(Billing, "chargeToUsedByJobId").mockResolvedValue({
            jobId: "unused",
            charged: 0,
            currentUsed: 0,
            remainingCredits: 0,
        });

        const req = {
            method: "POST",
            path: "/v1/search",
            route: { path: "/v1/search" },
            creditsUsed: 5,
        } as MockedRequest;
        const { res, emit } = createMockResponse(200);
        const next = jest.fn();

        await deductCreditsMiddleware(req as RequestWithAuth, res as unknown as any, next);
        emit("finish");
        expect(next).toHaveBeenCalledTimes(1);

        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(deltaSpy).not.toHaveBeenCalled();
        expect(targetSpy).not.toHaveBeenCalled();
    });

    it("skips deduction for non-success response", async () => {
        const deltaSpy = jest.spyOn(Billing, "chargeDeltaByJobId").mockResolvedValue({
            jobId: "unused",
            charged: 0,
            currentUsed: 0,
            remainingCredits: 0,
        });
        const targetSpy = jest.spyOn(Billing, "chargeToUsedByJobId").mockResolvedValue({
            jobId: "unused",
            charged: 0,
            currentUsed: 0,
            remainingCredits: 0,
        });

        const req = {
            method: "POST",
            path: "/v1/map",
            route: { path: "/v1/map" },
            jobId: "job-failed",
            creditsUsed: 11,
        } as MockedRequest;
        const { res, emit } = createMockResponse(500);
        const next = jest.fn();

        await deductCreditsMiddleware(req as RequestWithAuth, res as unknown as any, next);
        emit("finish");
        expect(next).toHaveBeenCalledTimes(1);

        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(deltaSpy).not.toHaveBeenCalled();
        expect(targetSpy).not.toHaveBeenCalled();
    });
});
