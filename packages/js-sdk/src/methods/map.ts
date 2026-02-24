import { AxiosInstance, AxiosResponse } from 'axios';
import { ApiResponse, MapRequest, MapResult, MapLink } from '../types.js';
import { Logger } from '../logger.js';
const log = new Logger();

/**
 * Map a website to discover all URLs.
 *
 * @param client Axios instance
 * @param input Map request parameters
 * @returns Map result with list of discovered URLs
 */
export async function map(client: AxiosInstance, input: MapRequest): Promise<MapResult> {
    log.debug('Calling /v1/map');
    const response: AxiosResponse<ApiResponse<MapLink[]>> = await client.post('/v1/map', input);
    const payload: ApiResponse<MapLink[]> = response.data;

    if (!payload.success) {
        throw new Error((payload as any).error || 'Map request failed');
    }

    return {
        links: payload.data || []
    };
}
