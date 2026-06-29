import {
    createPerformanceTuning,
    getBrowserEnginePerformanceOptions,
    parseCgroupCpuMax,
    parseCgroupCpuQuota,
    parseCgroupMemoryMb,
    resetPerformanceTuningForTests,
} from "../../core/PerformanceTuner.js";

describe("PerformanceTuner", () => {
    const resources = {
        cpuCount: 8,
        cpuSource: "test-cpu",
        memoryMb: 8192,
        memorySource: "test-memory",
    };

    afterEach(() => {
        resetPerformanceTuningForTests();
        delete process.env.ANYCRAWL_MIN_CONCURRENCY;
        delete process.env.ANYCRAWL_MAX_CONCURRENCY;
        delete process.env.ANYCRAWL_AUTOSCALE_DESIRED_CONCURRENCY;
        delete process.env.ANYCRAWL_AUTOSCALE_SCALE_UP_STEP_RATIO;
        delete process.env.ANYCRAWL_AUTOSCALE_SCALE_DOWN_STEP_RATIO;
        delete process.env.ANYCRAWL_AUTOSCALE_MAYBE_RUN_INTERVAL_SECS;
        delete process.env.ANYCRAWL_AUTOSCALE_INTERVAL_SECS;
        delete process.env.ANYCRAWL_BULLMQ_WORKER_CONCURRENCY;
        delete process.env.ANYCRAWL_BROWSER_VIEWPORT_WIDTH;
        delete process.env.ANYCRAWL_BROWSER_VIEWPORT_HEIGHT;
        delete process.env.ANYCRAWL_SMART_WAIT_MAX_MS;
        delete process.env.ANYCRAWL_MAX_REQUEST_RETRIES;
    });

    test("parses cgroup CPU v2 quota", () => {
        expect(parseCgroupCpuMax("200000 100000")).toBe(2);
        expect(parseCgroupCpuMax("max 100000")).toBeUndefined();
        expect(parseCgroupCpuMax("invalid 100000")).toBeUndefined();
    });

    test("parses cgroup CPU v1 quota", () => {
        expect(parseCgroupCpuQuota("150000", "100000")).toBe(1.5);
        expect(parseCgroupCpuQuota("-1", "100000")).toBeUndefined();
        expect(parseCgroupCpuQuota("100000", "0")).toBeUndefined();
    });

    test("parses cgroup memory limit", () => {
        expect(parseCgroupMemoryMb(String(2 * 1024 * 1024 * 1024), 8192)).toBe(2048);
        expect(parseCgroupMemoryMb("max", 8192)).toBeUndefined();
        expect(parseCgroupMemoryMb(String(16 * 1024 * 1024 * 1024), 8192)).toBeUndefined();
    });

    test("derives concurrency from CPU and memory without env configuration", () => {
        const tuning = createPerformanceTuning({ resources, env: {} });

        expect(tuning.maxConcurrency).toBe(17);
        expect(tuning.desiredConcurrency).toBe(9);
        expect(tuning.minConcurrency).toBe(2);
        expect(tuning.workerConcurrency).toBe(68);
        expect(tuning.viewport).toEqual({ width: 1365, height: 768 });
        expect(tuning.smartWaitMaxMs).toBe(1500);
        expect(tuning.maxRequestRetries).toBe(1);
        expect(tuning.overrides).toEqual([]);
    });

    test("keeps small containers usable with minimum concurrency", () => {
        const tuning = createPerformanceTuning({
            resources: {
                cpuCount: 0.5,
                cpuSource: "test-cpu",
                memoryMb: 1024,
                memorySource: "test-memory",
            },
            env: {},
        });

        expect(tuning.maxConcurrency).toBe(2);
        expect(tuning.desiredConcurrency).toBe(2);
        expect(tuning.minConcurrency).toBe(2);
    });

    test("applies env overrides when provided", () => {
        const tuning = createPerformanceTuning({
            resources,
            env: {
                ANYCRAWL_MIN_CONCURRENCY: "3",
                ANYCRAWL_MAX_CONCURRENCY: "20",
                ANYCRAWL_AUTOSCALE_DESIRED_CONCURRENCY: "15",
                ANYCRAWL_AUTOSCALE_SCALE_UP_STEP_RATIO: "0.8",
                ANYCRAWL_AUTOSCALE_SCALE_DOWN_STEP_RATIO: "0.4",
                ANYCRAWL_AUTOSCALE_MAYBE_RUN_INTERVAL_SECS: "0.05",
                ANYCRAWL_AUTOSCALE_INTERVAL_SECS: "2",
                ANYCRAWL_BULLMQ_WORKER_CONCURRENCY: "77",
                ANYCRAWL_BROWSER_VIEWPORT_WIDTH: "1280",
                ANYCRAWL_BROWSER_VIEWPORT_HEIGHT: "720",
                ANYCRAWL_SMART_WAIT_MAX_MS: "900",
                ANYCRAWL_MAX_REQUEST_RETRIES: "0",
            },
        });

        expect(tuning.minConcurrency).toBe(3);
        expect(tuning.maxConcurrency).toBe(20);
        expect(tuning.desiredConcurrency).toBe(15);
        expect(tuning.scaleUpStepRatio).toBe(0.8);
        expect(tuning.scaleDownStepRatio).toBe(0.4);
        expect(tuning.maybeRunIntervalSecs).toBe(0.05);
        expect(tuning.autoscaleIntervalSecs).toBe(2);
        expect(tuning.workerConcurrency).toBe(77);
        expect(tuning.viewport).toEqual({ width: 1280, height: 720 });
        expect(tuning.smartWaitMaxMs).toBe(900);
        expect(tuning.maxRequestRetries).toBe(0);
        expect(tuning.overrides).toContain("ANYCRAWL_MAX_REQUEST_RETRIES=0");
    });

    test("maps tuning into browser crawler options", () => {
        process.env.ANYCRAWL_MAX_CONCURRENCY = "12";
        process.env.ANYCRAWL_AUTOSCALE_DESIRED_CONCURRENCY = "6";
        process.env.ANYCRAWL_MAX_REQUEST_RETRIES = "0";
        resetPerformanceTuningForTests();

        const options = getBrowserEnginePerformanceOptions();

        expect(options.maxConcurrency).toBe(12);
        expect(options.maxRequestRetries).toBe(0);
        expect(options.autoscaledPoolOptions).toMatchObject({
            desiredConcurrency: 6,
            scaleUpStepRatio: 0.5,
            scaleDownStepRatio: 0.25,
        });
    });
});
