import { Billing } from "../model/Billing.js";
import { schemas } from "../index.js";

interface InMemoryJob {
    jobId: string;
    apiKey: string;
    creditsUsed: number;
    deductedAt: Date | null;
    updatedAt: Date | null;
}

interface InMemoryApiKey {
    uuid: string;
    credits: number;
    lastUsedAt: Date | null;
}

interface InMemoryBillingLedger {
    jobId: string;
    apiKey: string;
    mode: "delta" | "target";
    reason: string;
    idempotencyKey: string;
    charged: number;
    beforeUsed: number;
    afterUsed: number;
    chargeDetails: unknown;
    beforeCredits: number | null;
    afterCredits: number | null;
    createdAt: Date;
}

interface InMemoryState {
    job: InMemoryJob;
    apiKey: InMemoryApiKey;
    ledger: InMemoryBillingLedger[];
}

interface HarnessOptions {
    // Simulate optimistic lock conflicts: first N target-updates return no row.
    conflictsOnTargetJobUpdate?: number;
}

interface HarnessStats {
    jobTargetUpdateAttempts: number;
    apiKeyUpdateCount: number;
    ledgerInsertCount: number;
}

interface UpdateContext {
    table: unknown;
    setValues: Record<string, unknown>;
    resultRows: Array<Record<string, unknown>>;
}

function extractSqlNumber(value: unknown): number {
    if (typeof value === "number") return value;

    const chunks = (value as { queryChunks?: unknown[] })?.queryChunks ?? [];
    const numericChunk = chunks.find((chunk) => typeof chunk === "number");

    if (typeof numericChunk !== "number") {
        throw new Error("Unable to extract numeric operand from SQL expression");
    }

    return numericChunk;
}

function createTxHarness(initialCredits: number, initialUsed = 0, options: HarnessOptions = {}) {
    const jobId = "job-test";
    const apiKeyId = "api-key-test";

    const state: InMemoryState = {
        job: {
            jobId,
            apiKey: apiKeyId,
            creditsUsed: initialUsed,
            deductedAt: null,
            updatedAt: null,
        },
        apiKey: {
            uuid: apiKeyId,
            credits: initialCredits,
            lastUsedAt: null,
        },
        ledger: [],
    };

    const stats: HarnessStats = {
        jobTargetUpdateAttempts: 0,
        apiKeyUpdateCount: 0,
        ledgerInsertCount: 0,
    };

    let conflictsRemaining = options.conflictsOnTargetJobUpdate ?? 0;

    const tx = {
        select: (_projection: unknown) => ({
            from: (_table: unknown) => ({
                where: (_condition: unknown) => ({
                    limit: async (_count: number) => [
                        {
                            apiKey: state.job.apiKey,
                            creditsUsed: state.job.creditsUsed,
                        },
                    ],
                }),
            }),
        }),
        insert: (table: unknown) => {
            const insertState: {
                values?: Record<string, unknown>;
            } = {};

            const builder = {
                values(values: Record<string, unknown>) {
                    insertState.values = values;
                    return this;
                },
                onConflictDoNothing(_config: { target: unknown }) {
                    return this;
                },
                async returning(_projection: unknown) {
                    if (table !== schemas.billingLedger) {
                        throw new Error("Unexpected table insert in Billing test harness");
                    }

                    const values = insertState.values ?? {};
                    const idempotencyKey = String(values.idempotencyKey ?? "");
                    const exists = state.ledger.some((entry) => entry.idempotencyKey === idempotencyKey);
                    if (exists) {
                        return [];
                    }

                    const ledgerRow: InMemoryBillingLedger = {
                        jobId: String(values.jobId),
                        apiKey: String(values.apiKey),
                        mode: String(values.mode) as "delta" | "target",
                        reason: String(values.reason),
                        idempotencyKey,
                        charged: Number(values.charged ?? 0),
                        beforeUsed: Number(values.beforeUsed ?? 0),
                        afterUsed: Number(values.afterUsed ?? 0),
                        chargeDetails: values.chargeDetails ?? null,
                        beforeCredits: values.beforeCredits === undefined ? null : Number(values.beforeCredits),
                        afterCredits: values.afterCredits === undefined ? null : Number(values.afterCredits),
                        createdAt: (values.createdAt as Date) ?? new Date(),
                    };

                    state.ledger.push(ledgerRow);
                    stats.ledgerInsertCount += 1;
                    return [{ idempotencyKey: ledgerRow.idempotencyKey }];
                },
            };

            return builder;
        },
        update: (table: unknown) => {
            const context: UpdateContext = {
                table,
                setValues: {},
                resultRows: [],
            };

            const builder = {
                set(setValues: Record<string, unknown>) {
                    context.setValues = setValues;
                    return this;
                },
                where(_condition: unknown) {
                    if (context.table === schemas.jobs) {
                        const rawCreditsUsed = context.setValues.creditsUsed;
                        const isTargetMode = typeof rawCreditsUsed === "number";

                        if (isTargetMode) {
                            stats.jobTargetUpdateAttempts += 1;
                            if (conflictsRemaining > 0) {
                                conflictsRemaining -= 1;
                                context.resultRows = [];
                                return this;
                            }

                            state.job.creditsUsed = rawCreditsUsed;
                            state.job.deductedAt = (context.setValues.deductedAt as Date) ?? state.job.deductedAt;
                            state.job.updatedAt = (context.setValues.updatedAt as Date) ?? state.job.updatedAt;
                            context.resultRows = [{ creditsUsed: state.job.creditsUsed }];
                            return this;
                        }

                        const delta = extractSqlNumber(rawCreditsUsed);
                        state.job.creditsUsed += delta;
                        state.job.deductedAt = (context.setValues.deductedAt as Date) ?? state.job.deductedAt;
                        state.job.updatedAt = (context.setValues.updatedAt as Date) ?? state.job.updatedAt;
                        context.resultRows = [];
                        return this;
                    }

                    if (context.table === schemas.apiKey) {
                        stats.apiKeyUpdateCount += 1;
                        const chargedDelta = extractSqlNumber(context.setValues.credits);
                        state.apiKey.credits -= chargedDelta;
                        state.apiKey.lastUsedAt = (context.setValues.lastUsedAt as Date) ?? state.apiKey.lastUsedAt;
                        context.resultRows = [{ credits: state.apiKey.credits }];
                        return this;
                    }

                    if (context.table === schemas.billingLedger) {
                        const latest = state.ledger[state.ledger.length - 1];
                        if (!latest) {
                            context.resultRows = [];
                            return this;
                        }

                        if (context.setValues.beforeCredits !== undefined) {
                            latest.beforeCredits = context.setValues.beforeCredits as number | null;
                        }
                        if (context.setValues.afterCredits !== undefined) {
                            latest.afterCredits = context.setValues.afterCredits as number | null;
                        }
                        context.resultRows = [];
                        return this;
                    }

                    throw new Error("Unexpected table update in Billing test harness");
                },
                async returning(_projection: unknown) {
                    return context.resultRows;
                },
            };

            return builder;
        },
    };

    return { tx, state, stats, jobId };
}

describe("Billing integration (mocked transaction harness)", () => {
    it("chargeToUsedByJobId is idempotent across duplicate finalize callbacks", async () => {
        const harness = createTxHarness(100, 0);

        const first = await Billing.chargeToUsedByJobId({
            jobId: harness.jobId,
            targetUsed: 10,
            reason: "test_target_first",
            dbOrTx: harness.tx,
        });
        const second = await Billing.chargeToUsedByJobId({
            jobId: harness.jobId,
            targetUsed: 10,
            reason: "test_target_duplicate_callback",
            dbOrTx: harness.tx,
        });

        expect(first.charged).toBe(10);
        expect(second.charged).toBe(0);
        expect(harness.state.job.creditsUsed).toBe(10);
        expect(harness.state.apiKey.credits).toBe(90);
        expect(harness.state.job.deductedAt).not.toBeNull();
        expect(harness.state.apiKey.lastUsedAt).not.toBeNull();
        expect(harness.stats.apiKeyUpdateCount).toBe(1);
        expect(harness.state.ledger).toHaveLength(1);
        expect(harness.state.ledger[0]?.charged).toBe(10);
        expect(harness.state.ledger[0]?.mode).toBe("target");
    });

    it("chargeToUsedByJobId retries optimistic-lock conflict without extra deduction", async () => {
        const harness = createTxHarness(100, 0, { conflictsOnTargetJobUpdate: 1 });

        const result = await Billing.chargeToUsedByJobId({
            jobId: harness.jobId,
            targetUsed: 20,
            reason: "test_target_retry_once",
            dbOrTx: harness.tx,
        });

        expect(result.charged).toBe(20);
        expect(harness.state.job.creditsUsed).toBe(20);
        expect(harness.state.apiKey.credits).toBe(80);
        expect(harness.stats.jobTargetUpdateAttempts).toBe(2);
        expect(harness.stats.apiKeyUpdateCount).toBe(1);
        expect(harness.state.ledger).toHaveLength(1);

        const duplicate = await Billing.chargeToUsedByJobId({
            jobId: harness.jobId,
            targetUsed: 20,
            reason: "test_target_duplicate_after_retry",
            dbOrTx: harness.tx,
        });

        expect(duplicate.charged).toBe(0);
        expect(harness.state.apiKey.credits).toBe(80);
        expect(harness.stats.apiKeyUpdateCount).toBe(1);
        expect(harness.state.ledger).toHaveLength(1);
    });

    it("chargeDeltaByJobId accumulates usage and allows negative credits", async () => {
        const harness = createTxHarness(3, 0);

        const first = await Billing.chargeDeltaByJobId({
            jobId: harness.jobId,
            delta: 2,
            reason: "test_delta_first",
            dbOrTx: harness.tx,
        });

        await new Promise((resolve) => setTimeout(resolve, 8));

        const second = await Billing.chargeDeltaByJobId({
            jobId: harness.jobId,
            delta: 5,
            reason: "test_delta_second",
            dbOrTx: harness.tx,
        });

        expect(first.charged).toBe(2);
        expect(second.charged).toBe(5);
        expect(harness.state.job.creditsUsed).toBe(7);
        expect(harness.state.apiKey.credits).toBe(-4);
        expect(harness.state.job.deductedAt).not.toBeNull();
        expect(harness.state.apiKey.lastUsedAt).not.toBeNull();
        expect(harness.state.ledger).toHaveLength(2);
        expect(harness.state.ledger[0]?.afterUsed).toBe(2);
        expect(harness.state.ledger[1]?.afterUsed).toBe(7);
    });

    it("chargeDeltaByJobId dedupes repeated retry callbacks with same idempotency key", async () => {
        const harness = createTxHarness(20, 0);

        const first = await Billing.chargeDeltaByJobId({
            jobId: harness.jobId,
            delta: 4,
            reason: "test_delta_retry",
            idempotencyKey: "dedupe-key-1",
            dbOrTx: harness.tx,
        });

        const duplicate = await Billing.chargeDeltaByJobId({
            jobId: harness.jobId,
            delta: 4,
            reason: "test_delta_retry",
            idempotencyKey: "dedupe-key-1",
            dbOrTx: harness.tx,
        });

        expect(first.charged).toBe(4);
        expect(duplicate.charged).toBe(0);
        expect(harness.state.job.creditsUsed).toBe(4);
        expect(harness.state.apiKey.credits).toBe(16);
        expect(harness.state.ledger).toHaveLength(1);
        expect(harness.state.ledger[0]?.idempotencyKey).toBe("dedupe-key-1");
    });

    it("chargeDeltaByJobId stores charge details when totals match charged credits", async () => {
        const harness = createTxHarness(20, 0);
        const chargeDetails = {
            version: 1 as const,
            basis: "charged_delta" as const,
            calculator: "scrape_v1",
            total: 6,
            items: [
                { code: "base_scrape", credits: 1 },
                { code: "json_llm_extract", credits: 5 },
            ],
        };

        await Billing.chargeDeltaByJobId({
            jobId: harness.jobId,
            delta: 6,
            reason: "test_delta_with_details",
            chargeDetails,
            dbOrTx: harness.tx,
        });

        expect(harness.state.ledger).toHaveLength(1);
        expect(harness.state.ledger[0]?.chargeDetails).toEqual(chargeDetails);
    });

    it("chargeDeltaByJobId falls back to unattributed detail when item totals mismatch", async () => {
        const harness = createTxHarness(20, 0);

        await Billing.chargeDeltaByJobId({
            jobId: harness.jobId,
            delta: 4,
            reason: "test_delta_details_mismatch",
            chargeDetails: {
                version: 1,
                basis: "charged_delta",
                calculator: "scrape_v1",
                total: 3,
                items: [
                    { code: "base_scrape", credits: 1 },
                    { code: "json_llm_extract", credits: 2 },
                ],
            },
            dbOrTx: harness.tx,
        });

        const storedDetails = harness.state.ledger[0]?.chargeDetails as any;
        expect(storedDetails.total).toBe(4);
        expect(storedDetails.items).toHaveLength(1);
        expect(storedDetails.items[0]?.code).toBe("unattributed_adjustment");
        expect(storedDetails.items[0]?.credits).toBe(4);
    });

    it("chargeToUsedByJobId never refunds when reported usage drops", async () => {
        const harness = createTxHarness(100, 0);

        const up = await Billing.chargeToUsedByJobId({
            jobId: harness.jobId,
            targetUsed: 15,
            reason: "test_target_up",
            dbOrTx: harness.tx,
        });
        const down = await Billing.chargeToUsedByJobId({
            jobId: harness.jobId,
            targetUsed: 10,
            reason: "test_target_down_no_refund",
            dbOrTx: harness.tx,
        });

        expect(up.charged).toBe(15);
        expect(down.charged).toBe(0);
        expect(harness.state.job.creditsUsed).toBe(15);
        expect(harness.state.apiKey.credits).toBe(85);
        expect(harness.state.ledger).toHaveLength(1);
    });

    it("chargeToUsedByJobId throws after max retries when conflicts persist", async () => {
        const harness = createTxHarness(100, 0, { conflictsOnTargetJobUpdate: 10 });

        await expect(Billing.chargeToUsedByJobId({
            jobId: harness.jobId,
            targetUsed: 9,
            reason: "test_target_retry_exhausted",
            dbOrTx: harness.tx,
        })).rejects.toThrow("Failed to chargeToUsed after 5 retries");

        expect(harness.state.job.creditsUsed).toBe(0);
        expect(harness.state.apiKey.credits).toBe(100);
        expect(harness.stats.jobTargetUpdateAttempts).toBe(5);
        expect(harness.stats.apiKeyUpdateCount).toBe(0);
        expect(harness.state.ledger).toHaveLength(0);
    });
});
