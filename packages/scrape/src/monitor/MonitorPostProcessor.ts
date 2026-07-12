/**
 * MonitorPostProcessor — runs after a scheduled scrape execution completes
 * successfully. It snapshots content, diffs against the previous run, and fires
 * notifications for meaningful changes.
 *
 * Called from ExecutionLifecycle.finalizeExecution() on the completed branch.
 * Must NEVER throw: wrap all errors and log warnings so the execution lifecycle
 * is never disrupted.
 */

import { randomUUID } from "crypto";
import {
    getDB,
    schemas,
    eq,
    sql,
    getMonitorByScheduledTask,
    getLatestSnapshot,
} from "@anycrawl/db";
import { getJobResults } from "@anycrawl/db";
import { log, config } from "@anycrawl/libs";
import {
    WebhookEventType,
    type MonitorEventPayload,
} from "@anycrawl/libs";
import { LLMExtract, getExtractModelId } from "@anycrawl/ai";
import { normalizeContent, hashContent, truncateForStorage } from "./normalize.js";
import { textDiff, priceDiff, classifyPriceChange } from "./diff.js";
import { judgeChange } from "./judge.js";
import { WebhookManager } from "../managers/Webhook.js";
import { EmailNotifier } from "./EmailNotifier.js";

interface PostProcessInput {
    db?: any;
    scheduledTaskUuid: string;
    executionUuid: string;
    jobUuid?: string;
}

interface UrlChange {
    url: string;
    changeType: string;
    diffText?: string;
    diffJson?: any;
    judgment?: any;
    snapshotUuid: string;
    prevSnapshotUuid?: string;
}

export class MonitorPostProcessor {
    /**
     * Entry point called by finalizeExecution() on the success branch.
     * Safe to call for non-monitor tasks — returns immediately when no monitor
     * config is found for the scheduled task.
     */
    public static async process(input: PostProcessInput): Promise<void> {
        try {
            await MonitorPostProcessor._process(input);
        } catch (err) {
            log.warning(`[MONITOR] post-process uncaught error for execution ${input.executionUuid}: ${err}`);
        }
    }

    private static async _process(input: PostProcessInput): Promise<void> {
        const db = input.db || await getDB();

        // 1. Look up the monitor config keyed by the scheduled task. Exit fast
        //    for the common case (non-monitor scheduled tasks).
        const monitor = await getMonitorByScheduledTask(db, input.scheduledTaskUuid);
        if (!monitor) return;

        // 2. Resolve jobUuid → the string jobId used by job_results.
        //    finalizeExecution may not pass jobUuid on the worker success path.
        let jobUuid = input.jobUuid;
        if (!jobUuid) {
            const execRows = await db
                .select({ jobUuid: schemas.taskExecutions.jobUuid })
                .from(schemas.taskExecutions)
                .where(eq(schemas.taskExecutions.uuid, input.executionUuid))
                .limit(1);
            jobUuid = execRows[0]?.jobUuid ?? undefined;
        }
        if (!jobUuid) {
            log.warning(`[MONITOR] No jobUuid for execution ${input.executionUuid} — skipping diff`);
            return;
        }

        // 3. jobs.uuid (PK, uuid) → jobs.jobId (string, used by job_results API)
        const jobRows = await db
            .select({ jobId: schemas.jobs.jobId })
            .from(schemas.jobs)
            .where(eq(schemas.jobs.uuid, jobUuid))
            .limit(1);
        const jobId = jobRows[0]?.jobId;
        if (!jobId) {
            log.warning(`[MONITOR] No jobs row for uuid=${jobUuid} — skipping diff`);
            return;
        }

        // 4. Fetch all result rows for this job (one per URL).
        let results: any[];
        try {
            results = await getJobResults(jobId);
        } catch (err) {
            log.warning(`[MONITOR] getJobResults failed for jobId=${jobId}: ${err}`);
            return;
        }
        if (!results || results.length === 0) {
            log.debug(`[MONITOR] No results for jobId=${jobId}`);
            return;
        }

        const diffOptions = (monitor.diffOptions as any) ?? {};
        const notifyOptions = (monitor.notifyOptions as any) ?? {};
        const onlyMeaningful: boolean = notifyOptions.only_meaningful !== false;
        const trackMode: string = monitor.trackMode ?? "text";

        const changes: UrlChange[] = [];

        // 5. Process each URL result.
        for (const result of results) {
            try {
                await MonitorPostProcessor._processResult({
                    db,
                    monitor,
                    executionUuid: input.executionUuid,
                    result,
                    diffOptions,
                    trackMode,
                    onlyMeaningful,
                    changes,
                });
            } catch (err) {
                log.warning(`[MONITOR] Error processing result url=${result.url}: ${err}`);
            }
        }

        // 6. Notify.
        if (changes.length > 0) {
            await MonitorPostProcessor._notify(monitor, changes, results.length, notifyOptions);
        } else {
            // Fire a "check completed, no changes" summary when webhooks are enabled.
            await MonitorPostProcessor._notifyCheckCompleted(monitor, results.length, 0);
        }
    }

    private static async _processResult(params: {
        db: any;
        monitor: any;
        executionUuid: string;
        result: any;
        diffOptions: any;
        trackMode: string;
        onlyMeaningful: boolean;
        changes: UrlChange[];
    }): Promise<void> {
        const { db, monitor, executionUuid, result, diffOptions, trackMode, onlyMeaningful, changes } = params;

        const url: string = result.url;
        const data: Record<string, any> = result.data ?? {};

        // 5a. Normalize + hash current content.
        const normalizeOpts = {
            ignoreSelectors: diffOptions.ignore_selectors,
            onlyMainContent: diffOptions.only_main_content,
        };
        const normalized = normalizeContent(data, normalizeOpts);
        // Hash the FULL normalized content (so any change is detected), but store and
        // diff the truncated form. Both current and previous snapshots hold the truncated
        // text, so textDiff compares like-for-like and never reports the truncation
        // boundary as a spurious change.
        const contentHash = hashContent(normalized);
        const storedContent = truncateForStorage(normalized);

        // 5b. Structured extraction for price/json modes.
        //     The scrape job already runs LLM extraction when json_options + the json
        //     format are set, storing it in data.json — reuse that to avoid a second
        //     (billable, possibly inconsistent) extraction. Fall back to extracting here
        //     only when the scrape result lacks a json payload.
        let extracted: any = undefined;
        if (trackMode === "json" || trackMode === "mixed") {
            if (data.json !== undefined && data.json !== null) {
                extracted = data.json;
            } else if (monitor.extractSchema) {
                try {
                    const modelId = getExtractModelId();
                    const extractor = new LLMExtract(modelId);
                    const extractResult = await extractor.perform(normalized, monitor.extractSchema as any, {
                        prompt: monitor.goal ?? undefined,
                    });
                    extracted = extractResult.data;
                } catch (err) {
                    log.warning(`[MONITOR] Extraction failed for url=${url}: ${err}`);
                }
            }
        }

        // 5c. Get the previous snapshot for this (monitor, url) before writing the new one.
        const prevSnapshot = await getLatestSnapshot(db, monitor.uuid, url);

        // 5d. Determine status.
        let snapshotStatus: string;
        if (!prevSnapshot) {
            snapshotStatus = "new";
        } else if (prevSnapshot.contentHash === contentHash) {
            snapshotStatus = "same";
        } else {
            snapshotStatus = "changed";
        }

        // 5e. Write the snapshot.
        const snapshotUuid = randomUUID();
        await db.insert(schemas.monitorSnapshots).values({
            uuid: snapshotUuid,
            monitorUuid: monitor.uuid,
            taskExecutionUuid: executionUuid,
            url,
            contentHash,
            content: storedContent,
            extracted: extracted ?? null,
            status: snapshotStatus,
            capturedAt: new Date(),
        });

        // 5f. Skip diff for new/same — baseline is established on first run.
        if (snapshotStatus !== "changed") return;

        // 5g. Compute diff.
        let diffText: string | undefined;
        let diffJson: any[] | undefined;
        let changeType = "content";

        if (trackMode === "text" || trackMode === "mixed") {
            const prevNormalized = prevSnapshot.content ?? "";
            // Diff truncated-vs-truncated: prevSnapshot.content was stored truncated, so
            // compare against the truncated current content for a like-for-like diff.
            const tdResult = textDiff(prevNormalized, storedContent);
            diffText = tdResult.diffText;
            if (!tdResult.changed) {
                // Content normalized to same string after re-computation: no meaningful diff
                await db.update(schemas.monitorSnapshots)
                    .set({ status: "same" })
                    .where(eq(schemas.monitorSnapshots.uuid, snapshotUuid));
                return;
            }
        }

        if (trackMode === "json" || trackMode === "mixed") {
            const prevExtracted = prevSnapshot.extracted ?? {};
            const currExtracted = extracted ?? {};
            const fieldDiffs = priceDiff(prevExtracted, currExtracted);
            if (fieldDiffs.length > 0) {
                diffJson = fieldDiffs;
                const classified = classifyPriceChange(
                    fieldDiffs,
                    (monitor.notifyOptions as any)?.thresholds
                );
                if (classified) changeType = classified;
            }
        }

        // In pure json (price) mode, a content-hash change with no field-level diff is
        // noise (e.g. a footer date moved). Downgrade to "same" and skip the alert.
        if (trackMode === "json" && (!diffJson || diffJson.length === 0)) {
            await db.update(schemas.monitorSnapshots)
                .set({ status: "same" })
                .where(eq(schemas.monitorSnapshots.uuid, snapshotUuid));
            return;
        }

        // 5h. AI judgment when a goal is configured.
        let judgment: any = undefined;
        if (monitor.goal && (diffText || diffJson)) {
            const diffForJudge = diffText ?? JSON.stringify(diffJson, null, 2);
            judgment = await judgeChange(monitor.goal, diffForJudge, url);
            if (onlyMeaningful && !judgment.meaningful) {
                log.debug(`[MONITOR] AI judge: not meaningful for url=${url} reason="${judgment.reason}"`);
                return;
            }
        }

        // 5i. Write change record.
        const changeUuid = randomUUID();
        await db.insert(schemas.monitorChanges).values({
            uuid: changeUuid,
            monitorUuid: monitor.uuid,
            url,
            fromSnapshotUuid: prevSnapshot.uuid,
            toSnapshotUuid: snapshotUuid,
            changeType,
            diffText: diffText ?? null,
            diffJson: diffJson ?? null,
            judgment: judgment ?? null,
            notified: false,
            createdAt: new Date(),
        });

        changes.push({
            url,
            changeType,
            diffText,
            diffJson,
            judgment,
            snapshotUuid,
            prevSnapshotUuid: prevSnapshot.uuid,
        });
    }

    private static async _notify(
        monitor: any,
        changes: UrlChange[],
        totalUrls: number,
        notifyOptions: any
    ): Promise<void> {
        const channels: string[] = notifyOptions.channels ?? ["webhook"];
        const userId: string | undefined = monitor.userId ?? undefined;

        const changedCount = changes.length;
        const sameCount = totalUrls - changedCount;

        // Fire per-change webhook events
        if (channels.includes("webhook") && config.webhooks.enabled) {
            for (const change of changes) {
                const eventType =
                    change.changeType === "price_up" || change.changeType === "price_down"
                        ? WebhookEventType.MONITOR_PRICE_CHANGED
                        : WebhookEventType.MONITOR_CHANGED;

                const payload: MonitorEventPayload = {
                    monitor_id: monitor.uuid,
                    monitor_name: monitor.name,
                    monitor_type: monitor.monitorType,
                    url: change.url,
                    change_type: change.changeType,
                    diff_text: change.diffText,
                    diff_json: change.diffJson,
                    judgment: change.judgment,
                    captured_at: new Date().toISOString(),
                };

                try {
                    await WebhookManager.getInstance().triggerEvent(
                        eventType,
                        payload,
                        "monitor",
                        monitor.uuid,
                        userId
                    );
                } catch (err) {
                    log.warning(`[MONITOR] Webhook triggerEvent failed: ${err}`);
                }
            }
        }

        // Fire check-completed summary event
        await MonitorPostProcessor._notifyCheckCompleted(monitor, totalUrls, changedCount);

        // Email notification
        if (channels.includes("email") && config.email.enabled) {
            const recipients: string[] = notifyOptions.email_recipients ?? [];
            if (recipients.length > 0) {
                try {
                    await EmailNotifier.sendChangeEmail(recipients, monitor, changes);
                } catch (err) {
                    log.warning(`[MONITOR] Email notification failed: ${err}`);
                }
            }
        }

        // Mark changes as notified
        try {
            const db = await getDB();
            for (const change of changes) {
                await db.update(schemas.monitorChanges)
                    .set({ notified: true })
                    .where(
                        sql`${schemas.monitorChanges.monitorUuid} = ${monitor.uuid}
                            AND ${schemas.monitorChanges.toSnapshotUuid} = ${change.snapshotUuid}`
                    );
            }
        } catch (err) {
            log.warning(`[MONITOR] Failed to mark changes as notified: ${err}`);
        }
    }

    private static async _notifyCheckCompleted(
        monitor: any,
        totalUrls: number,
        changedCount: number
    ): Promise<void> {
        if (!config.webhooks.enabled) return;
        const payload: MonitorEventPayload = {
            monitor_id: monitor.uuid,
            monitor_name: monitor.name,
            monitor_type: monitor.monitorType,
            summary: {
                total: totalUrls,
                same: totalUrls - changedCount,
                changed: changedCount,
                new: 0,
                removed: 0,
                error: 0,
            },
            captured_at: new Date().toISOString(),
        };
        try {
            await WebhookManager.getInstance().triggerEvent(
                WebhookEventType.MONITOR_CHECK_COMPLETED,
                payload,
                "monitor",
                monitor.uuid,
                monitor.userId ?? undefined
            );
        } catch (err) {
            log.warning(`[MONITOR] check-completed webhook failed: ${err}`);
        }
    }
}
