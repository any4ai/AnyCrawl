/**
 * Core modules for the engine architecture
 * These modules handle specific responsibilities separated from the main BaseEngine
 */

// Core module exports
export { ConfigValidator } from "./ConfigValidator.js";
export { DataExtractor, ExtractionError } from "./DataExtractor.js";
export { JobManager } from "./JobManager.js";
export { EngineConfigurator, ConfigurableEngineType } from "./EngineConfigurator.js";
export {
    createPerformanceTuning,
    detectRuntimeResources,
    formatPerformanceTuningSummary,
    getBrowserEnginePerformanceOptions,
    getHttpEnginePerformanceOptions,
    getPerformanceTuning,
    parseCgroupCpuMax,
    parseCgroupCpuQuota,
    parseCgroupMemoryMb,
    resetPerformanceTuningForTests,
} from "./PerformanceTuner.js";

// Re-export types for convenience
export type { MetadataEntry, BaseContent } from "./DataExtractor.js";
export type { PerformanceTuning, RuntimeResourceSnapshot } from "./PerformanceTuner.js";
