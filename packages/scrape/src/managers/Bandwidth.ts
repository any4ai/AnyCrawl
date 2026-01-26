import type { RequestTrafficMetric } from "@anycrawl/libs";
import { addJobTraffic } from "@anycrawl/db";
import { log } from "crawlee";

type TrafficDelta = {
    totalBytes: number;
    requestBytes: number;
    responseBytes: number;
    requestCount: number;
};

const createEmptyDelta = (): TrafficDelta => ({
    totalBytes: 0,
    requestBytes: 0,
    responseBytes: 0,
    requestCount: 0,
});

export class BandwidthManager {
    private static instance: BandwidthManager;
    private pendingByJobId: Map<string, TrafficDelta> = new Map();
    private flushTimer: NodeJS.Timeout | null = null;
    private flushRunning: boolean = false;

    static getInstance(): BandwidthManager {
        if (!BandwidthManager.instance) {
            BandwidthManager.instance = new BandwidthManager();
        }
        return BandwidthManager.instance;
    }

    private constructor() {
        const intervalMs = Number(process.env.ANYCRAWL_BANDWIDTH_FLUSH_INTERVAL_MS ?? 5000);
        if (intervalMs > 0) {
            this.flushTimer = setInterval(() => {
                this.flushAll().catch(() => { });
            }, intervalMs);
            // Avoid keeping the process alive solely for flushing
            this.flushTimer.unref?.();
        }
    }

    recordRequest(metric: RequestTrafficMetric): void {
        if (!metric.jobId || metric.totalBytes <= 0) return;

        const current = this.pendingByJobId.get(metric.jobId) ?? createEmptyDelta();
        current.totalBytes += metric.totalBytes;
        current.requestBytes += metric.requestBytes;
        current.responseBytes += metric.responseBytes;
        current.requestCount += 1;
        this.pendingByJobId.set(metric.jobId, current);
    }

    async flushJob(jobId: string): Promise<void> {
        const delta = this.pendingByJobId.get(jobId);
        if (!delta) return;
        this.pendingByJobId.delete(jobId);
        await this.persist(jobId, delta);
    }

    async flushAll(): Promise<void> {
        if (this.flushRunning) return;
        if (this.pendingByJobId.size === 0) return;
        this.flushRunning = true;
        try {
            const pending = Array.from(this.pendingByJobId.entries());
            this.pendingByJobId.clear();
            await Promise.all(pending.map(([jobId, delta]) => this.persist(jobId, delta)));
        } finally {
            this.flushRunning = false;
        }
    }

    private async persist(jobId: string, delta: TrafficDelta): Promise<void> {
        if (delta.totalBytes <= 0) return;
        try {
            await addJobTraffic(jobId, {
                totalBytes: delta.totalBytes,
                requestBytes: delta.requestBytes,
                responseBytes: delta.responseBytes,
                requestCount: delta.requestCount,
            });
        } catch (error) {
            // Avoid dropping usage data on transient DB issues
            const current = this.pendingByJobId.get(jobId) ?? createEmptyDelta();
            current.totalBytes += delta.totalBytes;
            current.requestBytes += delta.requestBytes;
            current.responseBytes += delta.responseBytes;
            current.requestCount += delta.requestCount;
            this.pendingByJobId.set(jobId, current);
            log.debug(`[bandwidth] Failed to persist traffic for job ${jobId}: ${error}`);
        }
    }
}

