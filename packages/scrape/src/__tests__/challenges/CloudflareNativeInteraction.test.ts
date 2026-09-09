import { describe, expect, jest, test } from '@jest/globals';
import { runInNewContext } from 'node:vm';
import { CloudflareNativeInteraction } from '../../challenges/cloudflare/CloudflareNativeInteraction.js';
import { Deadline } from '../../utils/Deadline.js';
function fixture(options: { count?: number; checked?: boolean; acknowledge?: boolean; owned?: boolean; url?: string; beforeClick?: () => void; transform?: string } = {}) {
    const url = options.url ?? 'https://challenges.cloudflare.com/turnstile/widget';
    const control: any = { isConnected: true, checked: options.checked ?? false, disabled: false,
        getAttribute: () => null, getBoundingClientRect: () => ({ x: 9, y: 20.5, width: 168, height: 24 }),
        getRootNode: () => ({ elementFromPoint: () => control }), contains: () => false };
    const document = { elementFromPoint: () => control };
    const client = { detach: jest.fn(async () => {}), send: jest.fn(async (method: string, args: any) => {
        if (method === 'DOM.getDocument') return { root: { documentURL: url, nodeName: '#document', children: [], shadowRoots: [
            { nodeName: '#document-fragment', children: Array.from({ length: options.count ?? 1 }, (_, i) => ({ nodeName: 'INPUT', backendNodeId: i + 1, attributes: ['type', 'checkbox'] })) },
        ] } };
        if (method === 'DOM.resolveNode') return { object: { objectId: 'node' } };
        if (method === 'Runtime.callFunctionOn') return { result: { value: runInNewContext(`(${args.functionDeclaration}).call(control)`, {
            control, document, innerWidth: 300, innerHeight: 65, location: { href: url },
            getComputedStyle: () => ({ opacity: '1', display: 'block', visibility: 'visible' }),
        }) } };
        return {};
    }) };
    const owner = { boundingBox: async () => ({ x: 300, y: 200, width: 600, height: 130 }),
        evaluate: async () => { options.beforeClick?.(); return { width: 300, height: 65, left: 0, top: 0, transform: options.transform ?? 'none' }; },
        dispose: jest.fn(async () => {}) };
    const frame = { url: () => url, client, frameElement: async () => owner };
    const page: any = { isClosed: () => false, frames: () => [frame], bringToFront: jest.fn(async () => {}), mouse: { click: jest.fn(async () => { if (options.acknowledge !== false) control.checked = true; }) } };
    if (options.owned) page.context = () => ({ newCDPSession: async () => client });
    return { page, client, owner, control };
}
const deadline = () => new Deadline(Date.now() + 3000);
describe('CF CDP input boundaries', () => {
    test('closed-shadow input bounds are transformed through the current iframe and clicked once', async () => {
        const f = fixture(); const driver = new CloudflareNativeInteraction(); const signal = new AbortController().signal;
        const result = await driver.tryClick(f.page, deadline(), signal, () => true);
        expect(f.page.bringToFront).toHaveBeenCalledTimes(1);
        expect(result?.acknowledged).toBe(true);
        expect(result?.source).toBe('frame-cdp'); expect(f.page.mouse.click).toHaveBeenCalledWith(486, 265);
        expect(await driver.tryClick(f.page, deadline(), signal, () => true)).toBeNull();
        expect(f.page.mouse.click).toHaveBeenCalledTimes(1); await driver.dispose();
        expect(f.client.detach).not.toHaveBeenCalled(); // borrowed Puppeteer session remains driver-owned
    });
    test('unacknowledged input remains eligible for a subsequent bounded handler attempt', async () => {
        const f = fixture({ acknowledge: false }); const driver = new CloudflareNativeInteraction();
        const signal = new AbortController().signal;
        expect((await driver.tryClick(f.page, deadline(), signal, () => true))?.acknowledged).toBe(false);
        expect((await driver.tryClick(f.page, deadline(), signal, () => true))?.acknowledged).toBe(false);
        expect(f.page.mouse.click).toHaveBeenCalledTimes(2); await driver.dispose();
    });
    test('a new document may reuse the CF frame URL without inheriting old click suppression', async () => {
        const f = fixture(); const driver = new CloudflareNativeInteraction(); const signal = new AbortController().signal;
        await driver.tryClick(f.page, deadline(), signal, () => true, 0);
        f.control.checked = false;
        expect(await driver.tryClick(f.page, deadline(), signal, () => true, 0)).toBeNull();
        expect(await driver.tryClick(f.page, deadline(), signal, () => true, 1)).toMatchObject({ acknowledged: true });
        expect(f.page.mouse.click).toHaveBeenCalledTimes(2); await driver.dispose();
    });
    test.each([{ count: 2 }, { checked: true }, { url: 'https://challenges.cloudflare.com.evil.test/' }, { transform: 'matrix(0,1,-1,0,0,0)' }])('refuses ambiguous, completed, non-CF or rotated targets', async options => {
        const f = fixture(options); const driver = new CloudflareNativeInteraction();
        expect(await driver.tryClick(f.page, deadline(), new AbortController().signal, () => true)).toBeNull();
        expect(f.page.mouse.click).not.toHaveBeenCalled(); await driver.dispose();
    });
    test('a document change after bounds lookup cannot dispatch a late click', async () => {
        let current = true; const f = fixture({ beforeClick: () => { current = false; } });
        const driver = new CloudflareNativeInteraction();
        await expect(driver.tryClick(f.page, deadline(), new AbortController().signal, () => current)).rejects.toThrow('changed');
        expect(f.page.mouse.click).not.toHaveBeenCalled(); await driver.dispose();
    });
    test('owned Playwright CDP sessions are detached, and cancellation prevents dispatch', async () => {
        const f = fixture({ owned: true }); const driver = new CloudflareNativeInteraction();
        await driver.tryClick(f.page, deadline(), new AbortController().signal, () => true);
        await driver.dispose(); expect(f.client.detach).toHaveBeenCalledTimes(1);
        const aborted = new AbortController(); aborted.abort();
        await expect(new CloudflareNativeInteraction().tryClick(f.page, deadline(), aborted.signal, () => true)).rejects.toBeDefined();
        expect(f.page.mouse.click).toHaveBeenCalledTimes(1);
    });
});
