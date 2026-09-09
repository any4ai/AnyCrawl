import { Deadline } from '../../utils/Deadline.js';

export const isCloudflareFrameUrl = (value: string): boolean => {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && (url.hostname === 'challenges.cloudflare.com'
            || url.hostname.endsWith('.challenges.cloudflare.com'));
    } catch { return false; }
};

export interface CloudflareClick {
    source: 'frame-locator' | 'frame-cdp';
    frameUrl: string;
    x?: number;
    y?: number;
    acknowledged?: boolean;
}

/** Input is always derived from a current CF node, never a screenshot or fixed coordinates. */
export class CloudflareNativeInteraction {
    private readonly sessions = new Map<any, { client: any; owned: boolean }>();
    private readonly clicked = new Set<string>();
    private disposed = false;

    private async clientFor(page: any, frame: any): Promise<any> {
        const existing = this.sessions.get(frame);
        if (existing?.owned) return existing.client;
        if (typeof page.context === 'function') {
            const client = await page.context().newCDPSession(frame);
            if (this.disposed) { await client.detach(); throw new Error('CF interaction disposed'); }
            this.sessions.set(frame, { client, owned: true });
            return client;
        }
        // Puppeteer's public Frame.client belongs to the driver; never detach it.
        const client = frame.client;
        if (!client?.send) throw new Error('CF frame CDP session unavailable');
        this.sessions.set(frame, { client, owned: false });
        return client;
    }

    async tryClick(page: any, deadline: Deadline, signal: AbortSignal, isCurrent: () => boolean, documentEpoch = 0): Promise<CloudflareClick | null> {
        const guard = () => {
            deadline.check(); signal.throwIfAborted();
            if (this.disposed || page.isClosed?.() || !isCurrent()) throw new Error('CF document changed');
        };
        guard();
        for (const frame of page.frames?.() ?? []) {
            const frameUrl = frame.url();
            if (!isCloudflareFrameUrl(frameUrl)) continue;
            const frameKey = `${documentEpoch}:${frameUrl}`;
            if (this.clicked.has(frameKey)) continue;
            let client: any; let objectId: string | undefined;
            try {
                // A shared ordinary context can leave the verification owner's
                // tab in the background. Activate that page before measuring
                // and dispatching input; followers never enter this path.
                if (typeof page.bringToFront === 'function') {
                    await deadline.run(() => page.bringToFront(), signal);
                    guard();
                }
                // Ordinary visible DOM is the inexpensive path (Playwright).
                if (typeof page.context === 'function' && typeof frame.locator === 'function') {
                    const control = frame.locator('input[type="checkbox"], [role="checkbox"]');
                    if (await control.count() === 1 && await control.isVisible() && await control.isEnabled() && !await control.isChecked()) {
                        guard();
                        if (frame.url() !== frameUrl) continue;
                        await control.click({ timeout: Math.min(1500, deadline.remainingMs), noWaitAfter: true });
                        this.clicked.add(frameKey);
                        return { source: 'frame-locator', frameUrl };
                    }
                }
                guard();
                client = await this.clientFor(page, frame);
                const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
                guard();
                const controls: any[] = []; const stack = [{ node: root, url: root.documentURL ?? '' }]; let scanned = 0;
                while (stack.length && ++scanned <= 10000) {
                    const item = stack.pop()!; const node = item.node; const documentUrl = node.documentURL || item.url;
                    const attrs: Record<string, string> = {};
                    for (let i = 0; i < (node.attributes?.length ?? 0); i += 2) attrs[node.attributes[i]] = node.attributes[i + 1];
                    if (documentUrl === frameUrl && ((node.nodeName === 'INPUT' && attrs.type?.toLowerCase() === 'checkbox') || attrs.role === 'checkbox')) controls.push(node);
                    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? []), ...(node.contentDocument ? [node.contentDocument] : [])])
                        stack.push({ node: child, url: documentUrl });
                }
                if (scanned > 10000 || controls.length !== 1) continue;
                const resolved = await client.send('DOM.resolveNode', { backendNodeId: controls[0].backendNodeId });
                objectId = resolved.object.objectId;
                const inspectControl = `function () {
                        const control = this;
                        if (!control.isConnected || control.disabled || control.getAttribute('aria-disabled') === 'true'
                            || control.checked || control.getAttribute('aria-checked') === 'true') return null;
                        let target = control; let rect = target.getBoundingClientRect();
                        if (rect.width < 4 || rect.height < 4 || getComputedStyle(target).opacity === '0') {
                            target = control.labels?.[0] || control.closest('label') || control;
                            rect = target.getBoundingClientRect();
                        }
                        const style = getComputedStyle(target);
                        if (rect.width < 4 || rect.height < 4 || style.display === 'none' || style.visibility === 'hidden') return null;
                        const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
                        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
                        const root = target.getRootNode();
                        const hit = root.elementFromPoint?.(x, y) || document.elementFromPoint(x, y);
                        if (hit !== target && !target.contains(hit)) return null;
                        return { x, y, documentUrl: location.href };
                    }`;
                const detailResult = await client.send('Runtime.callFunctionOn', { objectId, returnByValue: true, functionDeclaration: inspectControl });
                const detail = detailResult.result?.value;
                if (!detail || !isCloudflareFrameUrl(detail.documentUrl)) continue;
                const owner = await frame.frameElement();
                try {
                    const outer = await owner.boundingBox();
                    const metrics = await owner.evaluate((element: HTMLElement) => ({
                        width: element.offsetWidth, height: element.offsetHeight,
                        left: element.clientLeft, top: element.clientTop,
                        transform: getComputedStyle(element).transform,
                    }));
                    if (!outer || !metrics.width || !metrics.height) continue;
                    // Rotated/skewed frames need a different coordinate transform; do not guess.
                    if (metrics.transform !== 'none') {
                        const matrix = /^matrix\(([^)]+)\)$/.exec(metrics.transform)?.[1]?.split(',').map(Number);
                        if (!matrix || matrix.length !== 6 || matrix[1] !== 0 || matrix[2] !== 0 || (matrix[0] ?? 0) <= 0 || (matrix[3] ?? 0) <= 0) continue;
                    }
                    const x = outer.x + (metrics.left + detail.x) * outer.width / metrics.width;
                    const y = outer.y + (metrics.top + detail.y) * outer.height / metrics.height;
                    guard();
                    if (frame.url() !== frameUrl) continue;
                    const freshOuter = await owner.boundingBox();
                    const fresh = await client.send('Runtime.callFunctionOn', { objectId, returnByValue: true, functionDeclaration: inspectControl });
                    guard();
                    if (!freshOuter || !fresh.result?.value || frame.url() !== frameUrl) continue;
                    if (['x', 'y', 'width', 'height'].some(key => Math.abs(freshOuter[key] - outer[key]) > 1)
                        || Math.abs(fresh.result.value.x - detail.x) > 1 || Math.abs(fresh.result.value.y - detail.y) > 1) continue;
                    await page.mouse.click(x, y);
                    let acknowledged: boolean | undefined;
                    try {
                        const check = await client.send('Runtime.callFunctionOn', { objectId, returnByValue: true,
                            functionDeclaration: 'function () { return !!this.checked || this.getAttribute("aria-checked") === "true"; }' });
                        acknowledged = check.result?.value;
                    } catch { /* Successful input may immediately navigate away. */ }
                    // A delivered input event is not proof of a checked node.
                    // Leave an unacknowledged control eligible for the handler's
                    // remaining (bounded) native attempt.
                    if (acknowledged !== false) this.clicked.add(frameKey);
                    return { source: 'frame-cdp', frameUrl, x, y, acknowledged };
                } finally { await owner.dispose?.().catch(() => {}); }
            } catch (error) {
                if (signal.aborted || deadline.remainingMs <= 0 || this.disposed || !isCurrent()) throw error;
                // A still-loading/detached frame is not proof that CF passed. Try the next observation.
            } finally {
                if (client && objectId) await client.send('Runtime.releaseObject', { objectId }).catch(() => {});
            }
        }
        return null;
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        const entries = [...this.sessions.values()]; this.sessions.clear();
        await Promise.allSettled(entries.filter(entry => entry.owned).map(entry => entry.client.detach()));
    }
}
