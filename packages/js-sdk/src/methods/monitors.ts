import type { AxiosInstance, AxiosResponse } from 'axios';
import type {
    CreateMonitorRequest,
    UpdateMonitorRequest,
    Monitor,
    MonitorCreateResponse,
    MonitorSnapshot,
    MonitorChange,
} from '../types.js';
import { unwrapApiResponse } from '../utils/index.js';

export async function createMonitor(
    client: AxiosInstance,
    input: CreateMonitorRequest
): Promise<MonitorCreateResponse> {
    const response: AxiosResponse<unknown> = await client.post('/v1/monitors', input);
    return unwrapApiResponse<MonitorCreateResponse>(response.data, 'Failed to create monitor');
}

export async function listMonitors(client: AxiosInstance): Promise<Monitor[]> {
    const response: AxiosResponse<unknown> = await client.get('/v1/monitors');
    return unwrapApiResponse<Monitor[]>(response.data, 'Failed to list monitors');
}

export async function getMonitor(client: AxiosInstance, monitorId: string): Promise<Monitor> {
    const response: AxiosResponse<unknown> = await client.get(`/v1/monitors/${monitorId}`);
    return unwrapApiResponse<Monitor>(response.data, 'Failed to get monitor');
}

export async function updateMonitor(
    client: AxiosInstance,
    monitorId: string,
    input: UpdateMonitorRequest
): Promise<Monitor> {
    const response: AxiosResponse<unknown> = await client.patch(`/v1/monitors/${monitorId}`, input);
    return unwrapApiResponse<Monitor>(response.data, 'Failed to update monitor');
}

export async function deleteMonitor(client: AxiosInstance, monitorId: string): Promise<void> {
    const response: AxiosResponse<unknown> = await client.delete(`/v1/monitors/${monitorId}`);
    unwrapApiResponse<unknown>(response.data, 'Failed to delete monitor');
}

export async function pauseMonitor(client: AxiosInstance, monitorId: string): Promise<void> {
    const response: AxiosResponse<unknown> = await client.post(`/v1/monitors/${monitorId}/pause`);
    unwrapApiResponse<unknown>(response.data, 'Failed to pause monitor');
}

export async function resumeMonitor(client: AxiosInstance, monitorId: string): Promise<void> {
    const response: AxiosResponse<unknown> = await client.post(`/v1/monitors/${monitorId}/resume`);
    unwrapApiResponse<unknown>(response.data, 'Failed to resume monitor');
}

/** Trigger an immediate on-demand check. Returns once the check has been queued. */
export async function runMonitor(client: AxiosInstance, monitorId: string): Promise<void> {
    const response: AxiosResponse<unknown> = await client.post(`/v1/monitors/${monitorId}/check`);
    unwrapApiResponse<unknown>(response.data, 'Failed to trigger monitor check');
}

export async function getMonitorSnapshots(
    client: AxiosInstance,
    monitorId: string,
    params?: { limit?: number; offset?: number }
): Promise<MonitorSnapshot[]> {
    const q = new URLSearchParams();
    if (params?.limit != null) q.set('limit', String(params.limit));
    if (params?.offset != null) q.set('offset', String(params.offset));
    const query = q.toString();
    const url = query ? `/v1/monitors/${monitorId}/snapshots?${query}` : `/v1/monitors/${monitorId}/snapshots`;
    const response: AxiosResponse<unknown> = await client.get(url);
    return unwrapApiResponse<MonitorSnapshot[]>(response.data, 'Failed to get monitor snapshots');
}

export async function getMonitorChanges(
    client: AxiosInstance,
    monitorId: string,
    params?: { limit?: number; offset?: number }
): Promise<MonitorChange[]> {
    const q = new URLSearchParams();
    if (params?.limit != null) q.set('limit', String(params.limit));
    if (params?.offset != null) q.set('offset', String(params.offset));
    const query = q.toString();
    const url = query ? `/v1/monitors/${monitorId}/changes?${query}` : `/v1/monitors/${monitorId}/changes`;
    const response: AxiosResponse<unknown> = await client.get(url);
    return unwrapApiResponse<MonitorChange[]>(response.data, 'Failed to get monitor changes');
}

export async function getMonitorChange(
    client: AxiosInstance,
    monitorId: string,
    changeId: string
): Promise<MonitorChange> {
    const response: AxiosResponse<unknown> = await client.get(`/v1/monitors/${monitorId}/changes/${changeId}`);
    return unwrapApiResponse<MonitorChange>(response.data, 'Failed to get monitor change');
}
