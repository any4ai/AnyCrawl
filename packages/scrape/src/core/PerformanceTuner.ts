import { existsSync, readFileSync } from "node:fs";
import { availableParallelism, cpus, totalmem } from "node:os";
import type { EngineOptions } from "../types/engine.js";

const BYTES_PER_MB = 1024 * 1024;
const DEFAULT_VIEWPORT_WIDTH = 1365;
const DEFAULT_VIEWPORT_HEIGHT = 768;
const DEFAULT_SMART_WAIT_MAX_MS = 1500;
const DEFAULT_MAX_REQUEST_RETRIES = 1;

type Env = Record<string, string | undefined>;

export interface RuntimeResourceSnapshot {
    cpuCount: number;
    cpuSource: string;
    memoryMb: number;
    memorySource: string;
}

export interface PerformanceTuning {
    resources: RuntimeResourceSnapshot;
    minConcurrency: number;
    maxConcurrency: number;
    desiredConcurrency: number;
    scaleUpStepRatio: number;
    scaleDownStepRatio: number;
    maybeRunIntervalSecs: number;
    autoscaleIntervalSecs: number;
    workerConcurrency: number;
    viewport: {
        width: number;
        height: number;
    };
    smartWaitMaxMs: number;
    maxRequestRetries: number;
    overrides: string[];
}

export interface CreatePerformanceTuningOptions {
    resources?: RuntimeResourceSnapshot;
    env?: Env;
}

const clampInt = (value: number, min: number, max: number): number => {
    const rounded = Math.round(value);
    return Math.min(Math.max(rounded, min), max);
};

const parsePositiveInt = (value: string | undefined): number | undefined => {
    if (value === undefined || value === "") return undefined;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const parseNonNegativeInt = (value: string | undefined): number | undefined => {
    if (value === undefined || value === "") return undefined;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

const parsePositiveFloat = (value: string | undefined): number | undefined => {
    if (value === undefined || value === "") return undefined;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const readTextFile = (path: string): string | undefined => {
    try {
        if (!existsSync(path)) return undefined;
        return readFileSync(path, "utf8").trim();
    } catch {
        return undefined;
    }
};

export const parseCgroupCpuMax = (content: string | undefined): number | undefined => {
    if (!content) return undefined;
    const [quotaRaw, periodRaw] = content.trim().split(/\s+/);
    if (!quotaRaw || quotaRaw === "max") return undefined;
    const quota = Number.parseFloat(quotaRaw);
    const period = Number.parseFloat(periodRaw || "");
    if (!Number.isFinite(quota) || !Number.isFinite(period) || quota <= 0 || period <= 0) {
        return undefined;
    }
    return quota / period;
};

export const parseCgroupCpuQuota = (
    quotaContent: string | undefined,
    periodContent: string | undefined,
): number | undefined => {
    const quota = Number.parseFloat(quotaContent || "");
    const period = Number.parseFloat(periodContent || "");
    if (!Number.isFinite(quota) || !Number.isFinite(period) || quota <= 0 || period <= 0) {
        return undefined;
    }
    return quota / period;
};

export const parseCgroupMemoryMb = (
    content: string | undefined,
    hostMemoryMb: number,
): number | undefined => {
    if (!content || content === "max") return undefined;
    const bytes = Number.parseFloat(content);
    if (!Number.isFinite(bytes) || bytes <= 0) return undefined;
    const mb = Math.floor(bytes / BYTES_PER_MB);
    if (mb <= 0 || mb > hostMemoryMb) return undefined;
    return mb;
};

const detectCpuCount = (): { value: number; source: string } => {
    const cgroupV2 = parseCgroupCpuMax(readTextFile("/sys/fs/cgroup/cpu.max"));
    if (cgroupV2 !== undefined) {
        return { value: Math.max(0.1, cgroupV2), source: "cgroup:cpu.max" };
    }

    const cgroupV1 = parseCgroupCpuQuota(
        readTextFile("/sys/fs/cgroup/cpu/cpu.cfs_quota_us"),
        readTextFile("/sys/fs/cgroup/cpu/cpu.cfs_period_us"),
    );
    if (cgroupV1 !== undefined) {
        return { value: Math.max(0.1, cgroupV1), source: "cgroup:cpu.cfs" };
    }

    const hostCpu = typeof availableParallelism === "function"
        ? availableParallelism()
        : cpus().length;
    return { value: Math.max(1, hostCpu || 1), source: "os.availableParallelism" };
};

const detectMemoryMb = (): { value: number; source: string } => {
    const hostMemoryMb = Math.max(1, Math.floor(totalmem() / BYTES_PER_MB));
    const cgroupV2 = parseCgroupMemoryMb(readTextFile("/sys/fs/cgroup/memory.max"), hostMemoryMb);
    if (cgroupV2 !== undefined) {
        return { value: cgroupV2, source: "cgroup:memory.max" };
    }

    const cgroupV1 = parseCgroupMemoryMb(
        readTextFile("/sys/fs/cgroup/memory/memory.limit_in_bytes"),
        hostMemoryMb,
    );
    if (cgroupV1 !== undefined) {
        return { value: cgroupV1, source: "cgroup:memory.limit_in_bytes" };
    }

    return { value: hostMemoryMb, source: "os.totalmem" };
};

export const detectRuntimeResources = (): RuntimeResourceSnapshot => {
    const cpu = detectCpuCount();
    const memory = detectMemoryMb();
    return {
        cpuCount: cpu.value,
        cpuSource: cpu.source,
        memoryMb: memory.value,
        memorySource: memory.source,
    };
};

const addOverride = (overrides: string[], key: string, value: unknown): void => {
    overrides.push(`${key}=${String(value)}`);
};

export const createPerformanceTuning = (
    options: CreatePerformanceTuningOptions = {},
): PerformanceTuning => {
    const env = options.env || process.env;
    const resources = options.resources || detectRuntimeResources();
    const overrides: string[] = [];

    const reserveMb = Math.max(768, resources.memoryMb * 0.25);
    const cpuSlots = Math.floor(resources.cpuCount * 3);
    const memorySlots = Math.floor(Math.max(0, resources.memoryMb - reserveMb) / 350);
    const automaticMaxConcurrency = clampInt(Math.min(cpuSlots, memorySlots), 2, 64);

    const maxConcurrencyOverride = parsePositiveInt(env.ANYCRAWL_MAX_CONCURRENCY);
    const maxConcurrency = maxConcurrencyOverride ?? automaticMaxConcurrency;
    if (maxConcurrencyOverride !== undefined) {
        addOverride(overrides, "ANYCRAWL_MAX_CONCURRENCY", maxConcurrencyOverride);
    }

    const automaticDesiredConcurrency = clampInt(Math.ceil(maxConcurrency * 0.5), 2, maxConcurrency);
    const minConcurrencyOverride = parsePositiveInt(env.ANYCRAWL_MIN_CONCURRENCY);
    const minConcurrency = minConcurrencyOverride ?? Math.min(2, automaticDesiredConcurrency);
    if (minConcurrencyOverride !== undefined) {
        addOverride(overrides, "ANYCRAWL_MIN_CONCURRENCY", minConcurrencyOverride);
    }

    const desiredConcurrencyOverride = parsePositiveInt(env.ANYCRAWL_AUTOSCALE_DESIRED_CONCURRENCY);
    const desiredConcurrency = desiredConcurrencyOverride !== undefined
        ? clampInt(desiredConcurrencyOverride, 1, maxConcurrency)
        : automaticDesiredConcurrency;
    if (desiredConcurrencyOverride !== undefined) {
        addOverride(overrides, "ANYCRAWL_AUTOSCALE_DESIRED_CONCURRENCY", desiredConcurrencyOverride);
    }

    const scaleUpStepRatio = parsePositiveFloat(env.ANYCRAWL_AUTOSCALE_SCALE_UP_STEP_RATIO) ?? 0.5;
    if (env.ANYCRAWL_AUTOSCALE_SCALE_UP_STEP_RATIO) {
        addOverride(overrides, "ANYCRAWL_AUTOSCALE_SCALE_UP_STEP_RATIO", scaleUpStepRatio);
    }

    const scaleDownStepRatio = parsePositiveFloat(env.ANYCRAWL_AUTOSCALE_SCALE_DOWN_STEP_RATIO) ?? 0.25;
    if (env.ANYCRAWL_AUTOSCALE_SCALE_DOWN_STEP_RATIO) {
        addOverride(overrides, "ANYCRAWL_AUTOSCALE_SCALE_DOWN_STEP_RATIO", scaleDownStepRatio);
    }

    const maybeRunIntervalSecs = parsePositiveFloat(env.ANYCRAWL_AUTOSCALE_MAYBE_RUN_INTERVAL_SECS) ?? 0.1;
    if (env.ANYCRAWL_AUTOSCALE_MAYBE_RUN_INTERVAL_SECS) {
        addOverride(overrides, "ANYCRAWL_AUTOSCALE_MAYBE_RUN_INTERVAL_SECS", maybeRunIntervalSecs);
    }

    const autoscaleIntervalSecs = parsePositiveFloat(env.ANYCRAWL_AUTOSCALE_INTERVAL_SECS) ?? 5;
    if (env.ANYCRAWL_AUTOSCALE_INTERVAL_SECS) {
        addOverride(overrides, "ANYCRAWL_AUTOSCALE_INTERVAL_SECS", autoscaleIntervalSecs);
    }

    const workerConcurrencyOverride = parsePositiveInt(env.ANYCRAWL_BULLMQ_WORKER_CONCURRENCY);
    const workerConcurrency = workerConcurrencyOverride
        ?? clampInt(maxConcurrency * 4, 50, 200);
    if (workerConcurrencyOverride !== undefined) {
        addOverride(overrides, "ANYCRAWL_BULLMQ_WORKER_CONCURRENCY", workerConcurrencyOverride);
    }

    const viewportWidth = parsePositiveInt(env.ANYCRAWL_BROWSER_VIEWPORT_WIDTH)
        ?? DEFAULT_VIEWPORT_WIDTH;
    if (env.ANYCRAWL_BROWSER_VIEWPORT_WIDTH) {
        addOverride(overrides, "ANYCRAWL_BROWSER_VIEWPORT_WIDTH", viewportWidth);
    }

    const viewportHeight = parsePositiveInt(env.ANYCRAWL_BROWSER_VIEWPORT_HEIGHT)
        ?? DEFAULT_VIEWPORT_HEIGHT;
    if (env.ANYCRAWL_BROWSER_VIEWPORT_HEIGHT) {
        addOverride(overrides, "ANYCRAWL_BROWSER_VIEWPORT_HEIGHT", viewportHeight);
    }

    const smartWaitMaxMs = parseNonNegativeInt(env.ANYCRAWL_SMART_WAIT_MAX_MS)
        ?? DEFAULT_SMART_WAIT_MAX_MS;
    if (env.ANYCRAWL_SMART_WAIT_MAX_MS !== undefined) {
        addOverride(overrides, "ANYCRAWL_SMART_WAIT_MAX_MS", smartWaitMaxMs);
    }

    const maxRequestRetries = parseNonNegativeInt(env.ANYCRAWL_MAX_REQUEST_RETRIES)
        ?? DEFAULT_MAX_REQUEST_RETRIES;
    if (env.ANYCRAWL_MAX_REQUEST_RETRIES !== undefined) {
        addOverride(overrides, "ANYCRAWL_MAX_REQUEST_RETRIES", maxRequestRetries);
    }

    return {
        resources,
        minConcurrency,
        maxConcurrency,
        desiredConcurrency,
        scaleUpStepRatio,
        scaleDownStepRatio,
        maybeRunIntervalSecs,
        autoscaleIntervalSecs,
        workerConcurrency,
        viewport: {
            width: viewportWidth,
            height: viewportHeight,
        },
        smartWaitMaxMs,
        maxRequestRetries,
        overrides,
    };
};

let cachedPerformanceTuning: PerformanceTuning | null = null;

export const getPerformanceTuning = (): PerformanceTuning => {
    if (!cachedPerformanceTuning) {
        cachedPerformanceTuning = createPerformanceTuning();
    }
    return cachedPerformanceTuning;
};

export const resetPerformanceTuningForTests = (): void => {
    cachedPerformanceTuning = null;
};

export const getBrowserEnginePerformanceOptions = (): Partial<EngineOptions> => {
    const tuning = getPerformanceTuning();
    return {
        minConcurrency: tuning.minConcurrency,
        maxConcurrency: tuning.maxConcurrency,
        maxRequestRetries: tuning.maxRequestRetries,
        autoscaledPoolOptions: {
            desiredConcurrency: tuning.desiredConcurrency,
            scaleUpStepRatio: tuning.scaleUpStepRatio,
            scaleDownStepRatio: tuning.scaleDownStepRatio,
            maybeRunIntervalSecs: tuning.maybeRunIntervalSecs,
            autoscaleIntervalSecs: tuning.autoscaleIntervalSecs,
        },
    };
};

export const getHttpEnginePerformanceOptions = (): Partial<EngineOptions> => {
    const options: Partial<EngineOptions> = {};
    const minConcurrency = parsePositiveInt(process.env.ANYCRAWL_MIN_CONCURRENCY);
    const maxConcurrency = parsePositiveInt(process.env.ANYCRAWL_MAX_CONCURRENCY);
    if (minConcurrency !== undefined) options.minConcurrency = minConcurrency;
    if (maxConcurrency !== undefined) options.maxConcurrency = maxConcurrency;
    return options;
};

export const formatPerformanceTuningSummary = (tuning = getPerformanceTuning()): string => {
    const overrides = tuning.overrides.length > 0 ? tuning.overrides.join(", ") : "none";
    return [
        `cpu=${tuning.resources.cpuCount.toFixed(2)} (${tuning.resources.cpuSource})`,
        `memory=${tuning.resources.memoryMb}MB (${tuning.resources.memorySource})`,
        `concurrency min=${tuning.minConcurrency} desired=${tuning.desiredConcurrency} max=${tuning.maxConcurrency}`,
        `autoscale scaleUp=${tuning.scaleUpStepRatio} scaleDown=${tuning.scaleDownStepRatio} maybeRun=${tuning.maybeRunIntervalSecs}s interval=${tuning.autoscaleIntervalSecs}s`,
        `workerConcurrency=${tuning.workerConcurrency}`,
        `viewport=${tuning.viewport.width}x${tuning.viewport.height}`,
        `smartWaitMaxMs=${tuning.smartWaitMaxMs}`,
        `maxRequestRetries=${tuning.maxRequestRetries}`,
        `overrides=${overrides}`,
    ].join("; ");
};
