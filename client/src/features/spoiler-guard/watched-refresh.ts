import { spoilerHost } from './host';
import { own } from './ownership';
const { JE, internal } = spoilerHost();
const owner = own(JE, 'watched');
const playedRoute = /\/(?:Users\/[a-f0-9-]+\/PlayedItems|UserPlayedItems)\/[a-f0-9-]+/i;
let installed = false;
function refresh(method: string, url: string) {
    if (!playedRoute.test(url) || (method !== 'POST' && method !== 'DELETE')) return;
    if (internal.isStateLoaded() && internal.isLoadOk() && !internal.hasAnyState()) return;
    owner.later(() => internal.refreshSpoilerableImages(), 200);
}
internal.installWatchedRefresh = () => {
    if (installed) return;
    installed = true;
    const originalFetch = window.fetch;
    const wrappedFetch: typeof fetch = function(this: Window, input, init) {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
        const token = owner.lease();
        const promise = originalFetch.call(this, input, init);
        if (playedRoute.test(url)) void promise.then(response => { if (response.ok && token.current()) refresh(method, url); }).catch(() => {});
        return promise;
    };
    if (typeof originalFetch === 'function') window.fetch = wrappedFetch;
    const requests = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    const open: typeof XMLHttpRequest.prototype.open = function(this: XMLHttpRequest, method: string, url: string | URL, async: boolean = true, username?: string | null, password?: string | null) {
        requests.set(this, { method: method.toUpperCase(), url: String(url) });
        originalOpen.call(this, method, url, async, username, password);
    };
    const send: typeof XMLHttpRequest.prototype.send = function(this: XMLHttpRequest, body) {
        const request = requests.get(this);
        const token = owner.lease();
        if (request && playedRoute.test(request.url)) {
            const xhr = this;
            const completed = () => {
                release();
                if (token.current() && xhr.status >= 200 && xhr.status < 300) refresh(request.method, request.url);
            };
            const release = owner.track(() => xhr.removeEventListener('loadend', completed));
            xhr.addEventListener('loadend', completed, { once: true });
        }
        originalSend.call(this, body);
    };
    XMLHttpRequest.prototype.open = open;
    XMLHttpRequest.prototype.send = send;
    // Hooks persist across navigation and identity changes; only their pending work is cancelled.
    JE.core?.lifecycle?.register('spoiler-guard-watched-installation').onTeardown(() => {
        owner.reset();
        if (window.fetch === wrappedFetch) window.fetch = originalFetch;
        if (XMLHttpRequest.prototype.open === open) XMLHttpRequest.prototype.open = originalOpen;
        if (XMLHttpRequest.prototype.send === send) XMLHttpRequest.prototype.send = originalSend;
        installed = false;
    });
};
