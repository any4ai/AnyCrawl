import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
// Real (unmocked) pure helpers so we can precompute hashes for the "same" case.
import { normalizeContent, hashContent } from "../../monitor/normalize.js";

/**
 * Integration test for MonitorPostProcessor.
 *
 * All I/O boundaries are mocked (DB, AI, Webhook, Email, judge) but the real
 * normalize + diff + classify orchestration runs, so this verifies the actual
 * decision path: snapshot → diff → classify → change record → webhook event.
 */

// --- Captured state, reset per test ---
let inserted: Record<string, any[]>;
let webhookEvents: Array<{ eventType: string; payload: any; source: string; sourceId: string }>;
let monitorConfig: any;
let prevSnapshot: any;
let jobResults: any[];

// Distinguishable table markers (schemas mock)
const schemas = {
    jobs: "jobs",
    taskExecutions: "task_executions",
    monitors: "monitors",
    monitorSnapshots: "monitor_snapshots",
    monitorChanges: "monitor_changes",
    scheduledTasks: "scheduled_tasks",
};

function makeDb() {
    return {
        select: (_projection?: any) => ({
            from: (table: any) => ({
                where: () => ({
                    limit: async () => {
                        if (table === schemas.jobs) return [{ jobId: "job-1" }];
                        if (table === schemas.taskExecutions) return [{ jobUuid: "job-uuid-1" }];
                        return [];
                    },
                }),
            }),
        }),
        insert: (table: any) => ({
            values: async (v: any) => {
                (inserted[table] = inserted[table] || []).push(v);
            },
        }),
        update: (_table: any) => ({
            set: () => ({
                where: async () => {},
            }),
        }),
    };
}

// --- ESM module mocks (must precede dynamic import of the SUT) ---
jest.unstable_mockModule("@anycrawl/db", () => ({
    getDB: async () => makeDb(),
    schemas,
    eq: (..._a: any[]) => ({}),
    sql: (..._a: any[]) => ({}),
    getMonitorByScheduledTask: async () => monitorConfig,
    getLatestSnapshot: async () => prevSnapshot,
    getJobResults: async () => jobResults,
}));

jest.unstable_mockModule("@anycrawl/ai", () => ({
    LLMExtract: class {
        async perform() {
            return { data: {} };
        }
    },
    getExtractModelId: () => "test-model",
}));

// Note: jest.unstable_mockModule resolves relative specifiers from the package
// root (jest.setup.js / rootDir), NOT the test file. Paths are therefore given
// relative to packages/scrape; they resolve to the same absolute modules the SUT
// imports, so the mocks apply.
jest.unstable_mockModule("./src/managers/Webhook.js", () => ({
    WebhookManager: {
        getInstance: () => ({
            triggerEvent: async (eventType: string, payload: any, source: string, sourceId: string) => {
                webhookEvents.push({ eventType, payload, source, sourceId });
            },
        }),
    },
}));

jest.unstable_mockModule("./src/monitor/judge.js", () => ({
    judgeChange: async () => ({ meaningful: true, confidence: "high", reason: "test" }),
}));

jest.unstable_mockModule("./src/monitor/EmailNotifier.js", () => ({
    EmailNotifier: { sendChangeEmail: async () => {} },
}));

// Dynamic import AFTER mocks are registered
const { MonitorPostProcessor } = await import("../../monitor/MonitorPostProcessor.js");

describe("MonitorPostProcessor (integration)", () => {
    const origWebhooks = process.env.ANYCRAWL_WEBHOOKS_ENABLED;

    beforeEach(() => {
        process.env.ANYCRAWL_WEBHOOKS_ENABLED = "true";
        delete process.env.ANYCRAWL_SMTP_HOST; // email disabled
        inserted = {};
        webhookEvents = [];
        prevSnapshot = null;
        jobResults = [];
        monitorConfig = null;
    });

    afterEach(() => {
        if (origWebhooks === undefined) delete process.env.ANYCRAWL_WEBHOOKS_ENABLED;
        else process.env.ANYCRAWL_WEBHOOKS_ENABLED = origWebhooks;
    });

    it("detects a price increase and fires monitor.price.changed", async () => {
        monitorConfig = {
            uuid: "mon-1",
            name: "Competitor Pricing",
            monitorType: "price",
            trackMode: "json",
            goal: "Alert on price changes",
            extractSchema: { type: "object" },
            diffOptions: {},
            notifyOptions: { channels: ["webhook"], only_meaningful: true },
            userId: "user-1",
        };
        prevSnapshot = {
            uuid: "snap-0",
            contentHash: "OLD_HASH",
            content: "Price: $19",
            extracted: { price: 19 },
        };
        jobResults = [
            { url: "https://x.com/pricing", data: { markdown: "Price: $24", json: { price: 24 } } },
        ];

        await MonitorPostProcessor.process({
            scheduledTaskUuid: "task-1",
            executionUuid: "exec-1",
            jobUuid: "job-uuid-1",
        });

        // A snapshot was written with status "changed"
        const snaps = inserted[schemas.monitorSnapshots] || [];
        expect(snaps).toHaveLength(1);
        expect(snaps[0].status).toBe("changed");
        expect(snaps[0].extracted).toEqual({ price: 24 });

        // A change was recorded, classified price_up with the field diff
        const changes = inserted[schemas.monitorChanges] || [];
        expect(changes).toHaveLength(1);
        expect(changes[0].changeType).toBe("price_up");
        expect(changes[0].diffJson).toEqual([
            { path: "price", from: 19, to: 24, delta: 5 },
        ]);

        // Webhook: one price.changed + one check.completed summary
        const priceEvent = webhookEvents.find((e) => e.eventType === "monitor.price.changed");
        expect(priceEvent).toBeDefined();
        expect(priceEvent!.payload.change_type).toBe("price_up");
        expect(priceEvent!.payload.url).toBe("https://x.com/pricing");
        expect(priceEvent!.source).toBe("monitor");

        const summary = webhookEvents.find((e) => e.eventType === "monitor.check.completed");
        expect(summary).toBeDefined();
        expect(summary!.payload.summary.changed).toBe(1);
    });

    it("detects a text change on a webpage monitor and fires monitor.changed", async () => {
        monitorConfig = {
            uuid: "mon-2",
            name: "Docs Page",
            monitorType: "webpage",
            trackMode: "text",
            goal: null,
            extractSchema: null,
            diffOptions: {},
            notifyOptions: { channels: ["webhook"], only_meaningful: true },
            userId: "user-1",
        };
        prevSnapshot = { uuid: "snap-0", contentHash: "OLD_HASH", content: "Version 1.0", extracted: null };
        jobResults = [{ url: "https://x.com/docs", data: { markdown: "Version 2.0" } }];

        await MonitorPostProcessor.process({
            scheduledTaskUuid: "task-2",
            executionUuid: "exec-2",
            jobUuid: "job-uuid-1",
        });

        const changes = inserted[schemas.monitorChanges] || [];
        expect(changes).toHaveLength(1);
        expect(changes[0].changeType).toBe("content");
        expect(changes[0].diffText).toContain("-Version 1.0");
        expect(changes[0].diffText).toContain("+Version 2.0");

        expect(webhookEvents.some((e) => e.eventType === "monitor.changed")).toBe(true);
        expect(webhookEvents.some((e) => e.eventType === "monitor.price.changed")).toBe(false);
    });

    it("does not fire change events when content is unchanged", async () => {
        const markdown = "Stable content that does not change";
        const normalized = normalizeContent({ markdown });
        monitorConfig = {
            uuid: "mon-3",
            name: "Stable Page",
            monitorType: "webpage",
            trackMode: "text",
            goal: null,
            extractSchema: null,
            diffOptions: {},
            notifyOptions: { channels: ["webhook"], only_meaningful: true },
            userId: "user-1",
        };
        // Previous snapshot hash matches current → status "same"
        prevSnapshot = { uuid: "snap-0", contentHash: hashContent(normalized), content: normalized, extracted: null };
        jobResults = [{ url: "https://x.com/stable", data: { markdown } }];

        await MonitorPostProcessor.process({
            scheduledTaskUuid: "task-3",
            executionUuid: "exec-3",
            jobUuid: "job-uuid-1",
        });

        // Snapshot written as "same", no change records
        const snaps = inserted[schemas.monitorSnapshots] || [];
        expect(snaps).toHaveLength(1);
        expect(snaps[0].status).toBe("same");
        expect(inserted[schemas.monitorChanges] || []).toHaveLength(0);

        // Only the check-completed summary fires, with changed=0
        expect(webhookEvents.some((e) => e.eventType === "monitor.changed")).toBe(false);
        const summary = webhookEvents.find((e) => e.eventType === "monitor.check.completed");
        expect(summary).toBeDefined();
        expect(summary!.payload.summary.changed).toBe(0);
    });

    it("is a no-op for non-monitor scheduled tasks", async () => {
        monitorConfig = null; // getMonitorByScheduledTask returns nothing
        await MonitorPostProcessor.process({
            scheduledTaskUuid: "not-a-monitor",
            executionUuid: "exec-x",
            jobUuid: "job-uuid-1",
        });
        expect(inserted[schemas.monitorSnapshots] || []).toHaveLength(0);
        expect(webhookEvents).toHaveLength(0);
    });

    it("first check establishes a baseline without firing change events", async () => {
        monitorConfig = {
            uuid: "mon-4",
            name: "New Monitor",
            monitorType: "webpage",
            trackMode: "text",
            goal: null,
            extractSchema: null,
            diffOptions: {},
            notifyOptions: { channels: ["webhook"], only_meaningful: true },
            userId: "user-1",
        };
        prevSnapshot = null; // no prior snapshot → status "new"
        jobResults = [{ url: "https://x.com/new", data: { markdown: "First capture" } }];

        await MonitorPostProcessor.process({
            scheduledTaskUuid: "task-4",
            executionUuid: "exec-4",
            jobUuid: "job-uuid-1",
        });

        const snaps = inserted[schemas.monitorSnapshots] || [];
        expect(snaps).toHaveLength(1);
        expect(snaps[0].status).toBe("new");
        expect(inserted[schemas.monitorChanges] || []).toHaveLength(0);
        expect(webhookEvents.some((e) => e.eventType === "monitor.changed")).toBe(false);
    });
});
