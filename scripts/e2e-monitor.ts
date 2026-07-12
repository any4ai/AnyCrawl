/**
 * Real end-to-end integration test for MonitorPostProcessor.
 *
 * Run with:
 *   ANYCRAWL_API_DB_TYPE=postgresql \
 *   ANYCRAWL_API_DB_CONNECTION="postgres://anycrawl:anycrawl@localhost:55432/anycrawl" \
 *   ANYCRAWL_WEBHOOKS_ENABLED=false \
 *   ANYCRAWL_API_CREDITS_ENABLED=false \
 *   tsx scripts/e2e-monitor.ts
 *
 * Uses real DB, real diff/normalize/classify logic. No AI or webhook I/O
 * (no goal set → no judge call; webhooks disabled → no queue).
 */

import { randomUUID } from "crypto";
import { getDB, schemas, eq } from "@anycrawl/db";
import { hashContent, normalizeContent } from "../packages/scrape/src/monitor/normalize.js";
import { MonitorPostProcessor } from "../packages/scrape/src/monitor/MonitorPostProcessor.js";

// ────────────────────────────────────────────────────────────────────────────
// Mini assertion framework
// ────────────────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const log: string[] = [];

function check(label: string, got: any, expected: any) {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) {
        passed++;
        log.push(`  ✅ ${label}`);
    } else {
        failed++;
        log.push(`  ❌ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
    }
}

function checkTruthy(label: string, value: any) {
    if (value) {
        passed++;
        log.push(`  ✅ ${label}`);
    } else {
        failed++;
        log.push(`  ❌ ${label}: got ${JSON.stringify(value)}`);
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Seed helpers (minimal required columns only)
// ────────────────────────────────────────────────────────────────────────────
async function seedScheduledTask(db: any, taskUuid: string) {
    await db.insert(schemas.scheduledTasks).values({
        uuid: taskUuid,
        apiKey: null,
        userId: null,
        name: "[e2e-monitor] test task",
        taskType: "scrape",
        taskPayload: { url: "https://example.com", engine: "auto", options: { formats: ["markdown"] } },
        cronExpression: "0 * * * *",
        timezone: "UTC",
        concurrencyMode: "skip",
        minCreditsRequired: 1,
        isActive: true,
        isPaused: false,
        createdAt: new Date(),
        updatedAt: new Date(),
    });
}

async function seedJob(db: any, jobUuid: string, jobId: string, url: string) {
    await db.insert(schemas.jobs).values({
        uuid: jobUuid,
        jobId,
        jobType: "scrape",
        jobQueueName: "scrape-cheerio",
        jobExpireAt: new Date(Date.now() + 3_600_000),
        url,
        payload: null,
        status: "completed",
        isSuccess: true,
        origin: "e2e-test",
        createdAt: new Date(),
        updatedAt: new Date(),
    });
}

async function seedJobResult(db: any, jobUuid: string, url: string, data: Record<string, any>) {
    await db.insert(schemas.jobResults).values({
        uuid: randomUUID(),
        jobUuid,
        url,
        data,
        status: "success",
        createdAt: new Date(),
        updatedAt: new Date(),
    });
}

async function seedMonitor(db: any, monUuid: string, taskUuid: string, opts: {
    monitorType?: string;
    trackMode?: string;
    extractSchema?: any;
}) {
    await db.insert(schemas.monitors).values({
        uuid: monUuid,
        apiKey: null,
        userId: null,
        name: "E2E Test Monitor",
        monitorType: opts.monitorType ?? "webpage",
        scheduledTaskUuid: taskUuid,
        targets: [{ url: "https://example.com", engine: "auto" }],
        goal: null,
        trackMode: opts.trackMode ?? "text",
        extractSchema: opts.extractSchema ?? null,
        diffOptions: {},
        notifyOptions: { channels: [], only_meaningful: true },
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
    });
}

async function seedExecution(db: any, execUuid: string, taskUuid: string, jobUuid: string) {
    await db.insert(schemas.taskExecutions).values({
        uuid: execUuid,
        scheduledTaskUuid: taskUuid,
        executionNumber: 1,
        idempotencyKey: `${taskUuid}-${Date.now()}`,
        status: "completed",
        jobUuid,
        triggeredBy: "scheduler",
        scheduledFor: new Date(),
        createdAt: new Date(),
        completedAt: new Date(),
    });
}

async function seedBaselineSnapshot(db: any, snapUuid: string, monUuid: string, contentHash: string, content: string, extracted: any) {
    await db.insert(schemas.monitorSnapshots).values({
        uuid: snapUuid,
        monitorUuid: monUuid,
        taskExecutionUuid: null,
        url: "https://example.com",
        contentHash,
        content,
        extracted: extracted ?? null,
        status: "same",
        capturedAt: new Date(Date.now() - 60_000),
    });
}

// ────────────────────────────────────────────────────────────────────────────
// Test 1: First check establishes baseline snapshot (status = new, no change)
// ────────────────────────────────────────────────────────────────────────────
async function testFirstCheck(db: any) {
    console.log("\n── Test 1: first check establishes baseline ────────────────────");

    const taskUuid = randomUUID();
    const monUuid  = randomUUID();
    const jobUuid  = randomUUID();
    const execUuid = randomUUID();
    const jobId    = "e2e-first-" + Date.now();
    const url      = "https://example.com";

    await seedScheduledTask(db, taskUuid);
    await seedJob(db, jobUuid, jobId, url);
    await seedJobResult(db, jobUuid, url, { markdown: "# Welcome\n\nFirst capture." });
    await seedMonitor(db, monUuid, taskUuid, { trackMode: "text" });
    await seedExecution(db, execUuid, taskUuid, jobUuid);

    await MonitorPostProcessor.process({ scheduledTaskUuid: taskUuid, executionUuid: execUuid, jobUuid });

    const snaps = await db.select().from(schemas.monitorSnapshots)
        .where(eq(schemas.monitorSnapshots.monitorUuid, monUuid));
    check("1 snapshot created", snaps.length, 1);
    check("status = new", snaps[0]?.status, "new");
    checkTruthy("content stored", snaps[0]?.content?.length > 0);
    checkTruthy("content_hash present", typeof snaps[0]?.contentHash === "string");

    const changes = await db.select().from(schemas.monitorChanges)
        .where(eq(schemas.monitorChanges.monitorUuid, monUuid));
    check("no change records on first check", changes.length, 0);
}

// ────────────────────────────────────────────────────────────────────────────
// Test 2: Price increase ($19 → $24) creates price_up change with field diff
// ────────────────────────────────────────────────────────────────────────────
async function testPriceIncrease(db: any) {
    console.log("\n── Test 2: price increase $19 → $24 detected ───────────────────");

    const taskUuid    = randomUUID();
    const monUuid     = randomUUID();
    const jobUuid     = randomUUID();
    const execUuid    = randomUUID();
    const prevSnapId  = randomUUID();
    const jobId       = "e2e-price-" + Date.now();
    const url         = "https://example.com";
    const extractSchema = {
        type: "object",
        properties: { plans: { type: "array", items: { type: "object",
            properties: { name: { type: "string" }, price: { type: "number" } } } } },
    };

    await seedScheduledTask(db, taskUuid);
    await seedJob(db, jobUuid, jobId, url);
    // Scrape result includes pre-extracted json (price 24) to avoid LLM call
    await seedJobResult(db, jobUuid, url, {
        markdown: "Plan Pro: $24/month",
        json: { plans: [{ name: "pro", price: 24 }] },
    });
    await seedMonitor(db, monUuid, taskUuid, {
        monitorType: "price",
        trackMode: "json",
        extractSchema,
    });
    await seedExecution(db, execUuid, taskUuid, jobUuid);
    // Baseline snapshot has price 19
    await seedBaselineSnapshot(db, prevSnapId, monUuid, "old-hash-" + monUuid,
        "Plan Pro: $19/month", { plans: [{ name: "pro", price: 19 }] });

    await MonitorPostProcessor.process({ scheduledTaskUuid: taskUuid, executionUuid: execUuid, jobUuid });

    const snaps = await db.select().from(schemas.monitorSnapshots)
        .where(eq(schemas.monitorSnapshots.monitorUuid, monUuid));
    // One old baseline + one new snapshot
    check("2 snapshots (baseline + new)", snaps.length, 2);
    const newSnap = snaps.find((s: any) => s.uuid !== prevSnapId);
    check("new snapshot status = changed", newSnap?.status, "changed");
    check("extracted price = 24", newSnap?.extracted?.plans?.[0]?.price, 24);

    const changes = await db.select().from(schemas.monitorChanges)
        .where(eq(schemas.monitorChanges.monitorUuid, monUuid));
    check("1 change record created", changes.length, 1);
    const c = changes[0];
    check("changeType = price_up", c?.changeType, "price_up");
    checkTruthy("diffJson present", Array.isArray(c?.diffJson) && c.diffJson.length > 0);
    const priceDiff = c?.diffJson?.find((d: any) => d.path.includes("price"));
    checkTruthy("price field diff found", !!priceDiff);
    check("from = 19", priceDiff?.from, 19);
    check("to = 24",   priceDiff?.to,   24);
    check("delta = 5", priceDiff?.delta, 5);
}

// ────────────────────────────────────────────────────────────────────────────
// Test 3: Unchanged content → snapshot status = same, no change record
// ────────────────────────────────────────────────────────────────────────────
async function testNoChange(db: any) {
    console.log("\n── Test 3: unchanged content → no change record ────────────────");

    const taskUuid    = randomUUID();
    const monUuid     = randomUUID();
    const jobUuid     = randomUUID();
    const execUuid    = randomUUID();
    const prevSnapId  = randomUUID();
    const jobId       = "e2e-same-" + Date.now();
    const url         = "https://example.com";
    const markdown    = "Stable content that does not change.";
    const normalized  = normalizeContent({ markdown });
    const hash        = hashContent(normalized);

    await seedScheduledTask(db, taskUuid);
    await seedJob(db, jobUuid, jobId, url);
    await seedJobResult(db, jobUuid, url, { markdown });
    await seedMonitor(db, monUuid, taskUuid, { trackMode: "text" });
    await seedExecution(db, execUuid, taskUuid, jobUuid);
    await seedBaselineSnapshot(db, prevSnapId, monUuid, hash, normalized, null);

    await MonitorPostProcessor.process({ scheduledTaskUuid: taskUuid, executionUuid: execUuid, jobUuid });

    const snaps = await db.select().from(schemas.monitorSnapshots)
        .where(eq(schemas.monitorSnapshots.monitorUuid, monUuid));
    check("2 snapshots", snaps.length, 2);
    const newSnap = snaps.find((s: any) => s.uuid !== prevSnapId);
    check("new snapshot status = same", newSnap?.status, "same");

    const changes = await db.select().from(schemas.monitorChanges)
        .where(eq(schemas.monitorChanges.monitorUuid, monUuid));
    check("0 change records", changes.length, 0);
}

// ────────────────────────────────────────────────────────────────────────────
// Test 4: Text content changes → monitor_changes with diff_text
// ────────────────────────────────────────────────────────────────────────────
async function testTextChange(db: any) {
    console.log("\n── Test 4: text content change detected ────────────────────────");

    const taskUuid    = randomUUID();
    const monUuid     = randomUUID();
    const jobUuid     = randomUUID();
    const execUuid    = randomUUID();
    const prevSnapId  = randomUUID();
    const jobId       = "e2e-text-" + Date.now();
    const url         = "https://example.com";
    const oldMarkdown = "# Docs\n\nVersion 1.0 released.";
    const newMarkdown = "# Docs\n\nVersion 2.0 released.";
    const prevNorm    = normalizeContent({ markdown: oldMarkdown });
    const prevHash    = hashContent(prevNorm);

    await seedScheduledTask(db, taskUuid);
    await seedJob(db, jobUuid, jobId, url);
    await seedJobResult(db, jobUuid, url, { markdown: newMarkdown });
    await seedMonitor(db, monUuid, taskUuid, { trackMode: "text" });
    await seedExecution(db, execUuid, taskUuid, jobUuid);
    await seedBaselineSnapshot(db, prevSnapId, monUuid, prevHash, prevNorm, null);

    await MonitorPostProcessor.process({ scheduledTaskUuid: taskUuid, executionUuid: execUuid, jobUuid });

    const changes = await db.select().from(schemas.monitorChanges)
        .where(eq(schemas.monitorChanges.monitorUuid, monUuid));
    check("1 change record", changes.length, 1);
    check("changeType = content", changes[0]?.changeType, "content");
    checkTruthy("diffText contains removal", (changes[0]?.diffText as string ?? "").includes("-Version 1.0"));
    checkTruthy("diffText contains addition", (changes[0]?.diffText as string ?? "").includes("+Version 2.0"));
}

// ────────────────────────────────────────────────────────────────────────────
// Test 5: Non-monitor task is a no-op
// ────────────────────────────────────────────────────────────────────────────
async function testNonMonitorNoOp(db: any) {
    console.log("\n── Test 5: non-monitor scheduled task is a no-op ───────────────");

    const snapsBefore: any[] = await db.select().from(schemas.monitorSnapshots);
    const changesBefore: any[] = await db.select().from(schemas.monitorChanges);

    await MonitorPostProcessor.process({
        scheduledTaskUuid: randomUUID(), // no matching monitor
        executionUuid: randomUUID(),
        jobUuid: undefined,
    });

    const snapsAfter: any[] = await db.select().from(schemas.monitorSnapshots);
    const changesAfter: any[] = await db.select().from(schemas.monitorChanges);
    check("no new snapshots", snapsAfter.length, snapsBefore.length);
    check("no new changes",   changesAfter.length, changesBefore.length);
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────
async function main() {
    console.log("═══════════════════════════════════════════════════════════════");
    console.log(" AnyCrawl Monitor — real end-to-end test (live Postgres)");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log(`DB: ${process.env.ANYCRAWL_API_DB_CONNECTION?.replace(/:([^:@]+)@/, ":***@")}`);

    const db = await getDB();

    await testFirstCheck(db);
    await testPriceIncrease(db);
    await testNoChange(db);
    await testTextChange(db);
    await testNonMonitorNoOp(db);

    console.log("\n═══════════════════════════════════════════════════════════════");
    for (const l of log) console.log(l);
    console.log("═══════════════════════════════════════════════════════════════");
    console.log(`\n${passed + failed} assertions — ${passed} passed  ${failed} failed\n`);

    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
