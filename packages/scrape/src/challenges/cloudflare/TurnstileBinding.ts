export interface TurnstileBindingParams {
    sitekey: string;
    data?: string;
    pagedata?: string;
    action?: string;
}

/** Creates a document-local binding. Functions/nodes never cross the protocol boundary. */
export function captureTurnstileBinding(input: { id: string; params: TurnstileBindingParams }): boolean {
    const win = window as any;
    const key = (p: any) => JSON.stringify([p?.sitekey ?? '', p?.data ?? p?.cData ?? '', p?.pagedata ?? p?.chlPageData ?? '', p?.action ?? '']);
    const runtime = win.__anycrawlTurnstileParams || win.__turnstileParams || win.__interceptedParams;
    const expected = key(input.params);
    const documentUrl = new URL(location.href);
    for (const key of [...documentUrl.searchParams.keys()]) if (key.startsWith('__cf_chl_')) documentUrl.searchParams.delete(key);
    if (runtime?.sitekey && key(runtime) !== expected) return false;
    if (!runtime?.sitekey) {
        // Without intercepted managed parameters, only a real standalone widget can be bound.
        if (input.params.data || input.params.pagedata) return false;
        const widget = Array.from(document.querySelectorAll('[data-sitekey],[data-site-key]')).find(node =>
            (node.getAttribute('data-sitekey') || node.getAttribute('data-site-key')) === input.params.sitekey);
        if (!widget) return false;
    }
    const callback = win.__anycrawlTurnstileCallback || win.cfCallback || win.tsCallback;
    const fields = Array.from(document.querySelectorAll('input[name="cf-turnstile-response"],textarea[name="cf-turnstile-response"],input[name="g-recaptcha-response"],textarea[name="g-recaptcha-response"]'));
    if (typeof callback !== 'function' && !fields.length) return false;
    win.__anycrawlTurnstileBindings ??= new Map();
    win.__anycrawlTurnstileBindings.set(input.id, {
        document, url: documentUrl.href, key: expected, runtime: Boolean(runtime?.sitekey),
        options: win._cf_chl_opt || win.__cf_chl_opt,
        callback: typeof callback === 'function' ? callback : null, fields, used: false,
    });
    return true;
}

/** Validation and callback invocation occur in one synchronous browser execution. */
export function injectTurnstileBinding(input: { id: string; token: string }): string {
    const win = window as any;
    const bindings = win.__anycrawlTurnstileBindings;
    const binding = bindings?.get(input.id);
    const documentUrl = new URL(location.href);
    for (const key of [...documentUrl.searchParams.keys()]) if (key.startsWith('__cf_chl_')) documentUrl.searchParams.delete(key);
    if (!binding || binding.used || binding.document !== document || binding.url !== documentUrl.href) return 'stale-binding';
    const runtime = win.__anycrawlTurnstileParams || win.__turnstileParams || win.__interceptedParams;
    const currentKey = JSON.stringify([runtime?.sitekey ?? '', runtime?.data ?? runtime?.cData ?? '', runtime?.pagedata ?? runtime?.chlPageData ?? '', runtime?.action ?? '']);
    if (binding.runtime && (!runtime || currentKey !== binding.key)) return 'stale-binding';
    if (binding.options !== (win._cf_chl_opt || win.__cf_chl_opt)) return 'stale-binding';
    if (binding.callback !== (typeof (win.__anycrawlTurnstileCallback || win.cfCallback || win.tsCallback) === 'function'
        ? (win.__anycrawlTurnstileCallback || win.cfCallback || win.tsCallback) : null)) return 'stale-binding';
    if (binding.fields.some((node: Element) => !node.isConnected || node.ownerDocument !== document)) return 'stale-binding';
    binding.used = true;
    bindings.delete(input.id);
    if (binding.callback) {
        try { binding.callback(input.token); return 'callback:bound'; }
        catch { return 'callback-error'; }
    }
    for (const field of binding.fields as Array<HTMLInputElement | HTMLTextAreaElement>) {
        const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (setter) setter.call(field, input.token); else field.value = input.token;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return binding.fields.length ? 'token-input:bound' : 'no-target';
}

export function releaseTurnstileBinding(id: string): void {
    (window as any).__anycrawlTurnstileBindings?.delete(id);
}
