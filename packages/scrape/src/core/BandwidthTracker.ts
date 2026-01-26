import type { RequestEngine, RequestTrafficMetric } from "@anycrawl/libs";
import { BandwidthManager } from "../managers/Bandwidth.js";
import { ConfigurableEngineType } from "./EngineConfigurator.js";

type CdpClient = {
    send(method: string, params?: Record<string, unknown>): Promise<unknown>;
    on(event: string, handler: (params: any) => void): void;
};

type TrackerHandle = {
    setJobContext(jobId: string): void;
};

const trackers = new WeakMap<object, TrackerHandle>();

const createSessionId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const estimateRequestBytes = (params: any): number => {
    try {
        const method = String(params?.request?.method ?? "GET");
        const url = String(params?.request?.url ?? "");
        const headers = params?.request?.headers ?? {};
        const requestLine = `${method} ${url} HTTP/1.1\r\n`;
        const headerLines = Object.entries(headers)
            .map(([k, v]) => `${k}: ${String(v)}\r\n`)
            .join("");
        const postData = typeof params?.request?.postData === "string" ? params.request.postData : "";
        return Buffer.byteLength(`${requestLine}${headerLines}\r\n${postData}`, "utf8");
    } catch {
        return 0;
    }
};

const attachCdpClient = async (page: any, engineType: ConfigurableEngineType): Promise<CdpClient> => {
    if (engineType === ConfigurableEngineType.PLAYWRIGHT) {
        return (await page.context().newCDPSession(page)) as CdpClient;
    }
    if (engineType === ConfigurableEngineType.PUPPETEER) {
        return (await page.target().createCDPSession()) as CdpClient;
    }
    throw new Error(`Unsupported engine type for CDP tracker: ${engineType}`);
};

export const getOrCreateBandwidthTracker = async (
    page: any,
    engineType: ConfigurableEngineType
): Promise<TrackerHandle | null> => {
    if (!page || (engineType !== ConfigurableEngineType.PLAYWRIGHT && engineType !== ConfigurableEngineType.PUPPETEER)) {
        return null;
    }

    const existing = trackers.get(page as object);
    if (existing) return existing;

    const client = await attachCdpClient(page, engineType);
    await client.send("Network.enable");

    const engine = engineType as unknown as RequestEngine;
    const sessionId = createSessionId();
    const bandwidthManager = BandwidthManager.getInstance();

    let currentJobId: string | null = null;

    const activeRequestId = new Map<string, string>(); // requestId -> metricId
    const hopIndexByRequestId = new Map<string, number>(); // requestId -> hopIndex (next)
    const metrics = new Map<string, RequestTrafficMetric>(); // metricId -> metric

    const nextHopIndex = (requestId: string): number => {
        const current = hopIndexByRequestId.get(requestId) ?? 0;
        hopIndexByRequestId.set(requestId, current + 1);
        return current;
    };

    const finalizeHop = (metricId?: string, failed?: boolean) => {
        if (!metricId) return;
        const metric = metrics.get(metricId);
        if (!metric) return;
        metric.failed = failed || false;
        metric.totalBytes = metric.requestBytes + metric.responseBytes;
        metric.endTime = Date.now();
        bandwidthManager.recordRequest(metric);
        metrics.delete(metricId);
    };

    client.on("Network.requestWillBeSent", (params: any) => {
        if (!currentJobId) return;
        const requestId = String(params.requestId);
        const hopIndex = nextHopIndex(requestId);
        const metricId = `${sessionId}:${requestId}:${hopIndex}`;

        if (params.redirectResponse) {
            finalizeHop(activeRequestId.get(requestId), false);
        }

        const metric: RequestTrafficMetric = {
            id: metricId,
            jobId: currentJobId,
            engine,
            url: String(params.request?.url ?? ""),
            method: String(params.request?.method ?? "GET"),
            requestBytes: estimateRequestBytes(params),
            responseBytes: 0,
            totalBytes: 0,
            startTime: Date.now(),
        };

        activeRequestId.set(requestId, metricId);
        metrics.set(metricId, metric);
    });

    client.on("Network.requestWillBeSentExtraInfo", (params: any) => {
        const metricId = activeRequestId.get(String(params.requestId));
        if (!metricId || !params.headersText) return;
        const metric = metrics.get(metricId);
        if (!metric) return;
        metric.requestBytes = Buffer.byteLength(String(params.headersText), "utf8");
    });

    client.on("Network.responseReceived", (params: any) => {
        const metricId = activeRequestId.get(String(params.requestId));
        const metric = metricId ? metrics.get(metricId) : null;
        if (!metric) return;
        metric.status = params.response?.status;
        metric.url = String(params.response?.url ?? metric.url);
        metric.fromCache = !!(params.response?.fromDiskCache || params.response?.fromServiceWorker);
    });

    client.on("Network.dataReceived", (params: any) => {
        const metricId = activeRequestId.get(String(params.requestId));
        const metric = metricId ? metrics.get(metricId) : null;
        if (!metric) return;
        metric.responseBytes += Number(params.encodedDataLength || 0);
    });

    client.on("Network.loadingFinished", (params: any) => {
        const requestId = String(params.requestId);
        const metricId = activeRequestId.get(requestId);
        const metric = metricId ? metrics.get(metricId) : null;
        if (metric && metric.responseBytes === 0) {
            metric.responseBytes = Number(params.encodedDataLength || 0);
        }
        finalizeHop(metricId, false);
        activeRequestId.delete(requestId);
    });

    client.on("Network.loadingFailed", (params: any) => {
        const requestId = String(params.requestId);
        finalizeHop(activeRequestId.get(requestId), true);
        activeRequestId.delete(requestId);
    });

    const handle: TrackerHandle = {
        setJobContext: (jobId: string) => {
            currentJobId = jobId;
        },
    };

    trackers.set(page as object, handle);
    return handle;
};

