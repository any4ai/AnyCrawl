export interface RecoverySample {
    url: string;
    readyState: string;
    hasContent: boolean;
    loading: boolean;
    fingerprint: string;
    textLength: number;
    issue?: 'error' | 'restricted';
    evidence?: string[];
    html?: string;
}

export interface ContentVerdict {
    status: 'acceptable' | 'loading' | 'retryable_error' | 'restricted' | 'unverified';
    reason?: string;
}

/** Serializable browser probe. HTML and live DOM signals are read in one JS task. */
export function readRecoverySample(options: { captureHtml?: boolean } = {}): RecoverySample {
    const scope = document.querySelector('article') || document.querySelector('main,[role="main"]') || document.body;
    const empty: RecoverySample = { url: location.href, readyState: document.readyState,
        hasContent: false, loading: false, fingerprint: '', textLength: 0 };
    if (!scope) return empty;
    const visible = (node: Element) => {
        const box = node.getBoundingClientRect(), style = getComputedStyle(node);
        if (box.width <= 0 || box.height <= 0 || style.display === 'none'
            || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
        for (let parent: Element | null = node; parent; parent = parent.parentElement) {
            if (getComputedStyle(parent).opacity === '0') return false;
        }
        return true;
    };
    const outsideContent = (node: Element) => Boolean(node.closest('nav,aside,header,footer,[role="navigation"],[role="complementary"]'));
    const quoted = (node: Element) => Boolean(node.closest('pre,code,blockquote,figcaption'));
    const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
    const root = Array.from(scope.querySelectorAll('[itemprop~="articleBody"]')).find(node => !outsideContent(node) && !quoted(node) && visible(node)) || scope;
    const loadingSelector = '[aria-busy="true"],[role="progressbar"],[class*="skeleton" i],[class*="loading" i]';
    let loading = scope.matches(loadingSelector) && visible(scope);
    for (const node of [root, ...Array.from(root.querySelectorAll(loadingSelector))]) {
        if (node.matches(loadingSelector) && !outsideContent(node) && visible(node)) { loading = true; break; }
    }
    const evidence: string[] = [];
    let issue: RecoverySample['issue'];
    for (const node of [root, ...Array.from(root.querySelectorAll('div,section,p,span,[role="alert"],[role="status"]'))]) {
        if (outsideContent(node) || quoted(node)) continue;
        // Containers with paragraph/section children are inspected through those
        // children; an error in a body panel must not be hidden by the abstract.
        if (node.querySelector('p,section,article,div')) continue;
        const text = normalize((node as HTMLElement).innerText ?? node.textContent ?? '');
        if (!text) continue;
        if (/^(?:loading|please wait|加载中|正在加载)[\s.。…]*$/i.test(text) && visible(node)) loading = true;
        const errorMessage = /^(?:(?:sorry[,!.]?\s*)?(?:unable|failed|cannot|could not) to (?:load|fetch|retrieve|display)\b|(?:this |the )?(?:content|article|page|full[ -]text) (?:is (?:temporarily )?unavailable|could not be loaded)\b|something went wrong\b|(?:an? |unexpected )?error (?:occurred|loading|retrieving)\b|加载失败|内容加载失败|暂时无法(?:加载|获取|显示))/i.test(text);
        const panel = node.closest('[role="alert"],[role="status"],[aria-live],.error,.alert,.error-message,.error-state,.load-error');
        const controlsRoot = panel && scope.contains(panel) ? panel : node;
        const retry = Array.from(controlsRoot.querySelectorAll('button,a,[role="button"]')).some(control =>
            /^(?:retry|try again|reload|refresh|重试|重新加载)[.!\s]*$/i.test(normalize(control.textContent ?? '')) && visible(control));
        const statusUi = Boolean(panel && scope.contains(panel)) || node.matches('[role="alert"],[role="status"],[aria-live]')
            || Array.from(node.classList).some(name => /^(?:error|alert|error[-_]message|error[-_]state|load[-_]error)$/i.test(name));
        if (errorMessage && (statusUi || retry) && visible(node)) {
            if (issue !== 'restricted') issue = 'error';
            evidence.push('visible_content_error');
        }
        const restricted = /^(?:sign in|log in|subscribe|purchase access) to (?:read|view|access)\b|^(?:you (?:must|need to) (?:sign in|log in|subscribe))\b/i.test(text);
        if (restricted && (statusUi || node.querySelector('a,button,form')) && visible(node)) {
            issue = 'restricted'; evidence.push('visible_content_restriction');
        }
    }
    const text = normalize((root as HTMLElement).innerText ?? root.textContent ?? '');
    const heading = normalize(root.querySelector('h1')?.textContent ?? '');
    let contentText = heading ? text.replace(heading, '').trim() : text;
    // Article scaffolding is not its body. Keep plain/link-only documents on
    // their existing path when no article semantics establish that expectation.
    if (scope.tagName === 'ARTICLE' || root !== scope) {
        for (const node of Array.from(root.querySelectorAll('header,footer,nav,aside,[role="navigation"],h1,h2,h3,h4,h5,h6'))) {
            const decoration = normalize((node as HTMLElement).innerText ?? node.textContent ?? '');
            if (decoration) contentText = contentText.replace(decoration, '').trim();
        }
    }
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    const sample: RecoverySample = { url: location.href, readyState: document.readyState,
        hasContent: Boolean(contentText) || Array.from(root.querySelectorAll('table,canvas,img,video,form')).some(node => !outsideContent(node) && visible(node)),
        loading, issue, evidence: [...new Set(evidence)], fingerprint: `${text.length}:${hash >>> 0}`, textLength: text.length };
    if (options.captureHtml) sample.html = (document.doctype ? new XMLSerializer().serializeToString(document.doctype) : '')
        + document.documentElement.outerHTML;
    return sample;
}

/** A failed ad alone is not a content failure; missing content is independent evidence. */
export function classifyContent(sample: RecoverySample, failedRequests: number): ContentVerdict {
    if (sample.issue === 'restricted') return { status: 'restricted', reason: 'visible_content_restriction' };
    if (sample.issue === 'error') return { status: 'retryable_error', reason: 'visible_content_error' };
    if (sample.readyState !== 'complete' || sample.loading) return { status: 'loading' };
    if (!sample.hasContent) return failedRequests > 0
        ? { status: 'unverified', reason: 'missing_content_after_request_failure' } : { status: 'loading' };
    return { status: 'acceptable' };
}

export interface VerifiedContentSnapshot {
    readonly version: 1;
    readonly epoch: number;
    readonly networkRevision: number;
    readonly html: string;
    readonly sample: Readonly<RecoverySample>;
}
