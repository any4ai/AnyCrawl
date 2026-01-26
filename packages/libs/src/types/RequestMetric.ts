export type RequestEngine = "playwright" | "puppeteer" | "cheerio";

export interface RequestMetricBase {
    id: string;
    jobId: string;
    engine: RequestEngine;
    url: string;
    method: string;
    status?: number;
    startTime: number;
    endTime?: number;
    failed?: boolean;
    fromCache?: boolean;
}

export interface RequestTrafficMetric extends RequestMetricBase {
    requestBytes: number;
    responseBytes: number;
    totalBytes: number;
}

