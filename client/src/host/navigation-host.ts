import { createNavigation } from '../core/navigation';
import { coreHost, readIdentity } from './core-host';

/** Browser events and Jellyfin router integration stay outside navigation state. */
export function installNavigation(): void {
    const host = coreHost();
    const je = host.JellyfinEnhanced;
    const core = je.core ?? (je.core = {});
    if (core.navigation) return;
    const currentElement = () => document.querySelector('.libraryPage:not(.hide)');
    const currentView = () => {
        const element = currentElement();
        return element?.getAttribute('data-type') || element?.id || element?.getAttribute('data-role') || null;
    };
    const runtime = createNavigation({
        href: () => window.location.href,
        hash: () => window.location.hash,
        currentView, currentElement,
        async fetchItem(hash) {
            const client = host.ApiClient;
            const identity = readIdentity(client);
            const lease = je.session?.createLease();
            const href = window.location.href;
            try {
                const id = new URLSearchParams((hash || '').split('?')[1]).get('id');
                if (!id || (lease && !lease.isCurrent())) return null;
                const item = je.helpers?.getItemCached
                    ? await je.helpers.getItemCached(id)
                    : await client?.getItem?.(identity.userId, id);
                const current = readIdentity(host.ApiClient);
                if (href !== window.location.href || host.ApiClient !== client ||
                    current.userId !== identity.userId || current.serverId !== identity.serverId ||
                    (lease && !lease.isCurrent())) return null;
                return item ?? null;
            } catch (error) {
                if (!lease?.signal.aborted) console.error('🪼 Jellyfin Enhanced: Navigation: Error fetching item:', error);
                return null;
            }
        },
        report: (context, error) => console.error(`🪼 Jellyfin Enhanced: Navigation: ${context}:`, error)
    });
    core.navigation = runtime.navigation;
    let hooked = false;
    let lastEvent: Event | null = null;
    let hookGeneration = 0;
    function installEmbyHook(): void {
        const page = host.Emby?.Page;
        if (!page) { window.setTimeout(installEmbyHook, 100); return; }
        const original = page.onViewShow;
        page.onViewShow = function(view, element, hash) {
            const generation = ++hookGeneration;
            const event = lastEvent;
            lastEvent = null;
            try { original?.call(this, view, element, hash); }
            catch (error) { console.warn('🪼 Jellyfin Enhanced: Navigation: Error in original onViewShow:', error); }
            if (generation === hookGeneration) runtime.notifyViewHandlers(view, element, hash, event);
        };
        hooked = true;
    }
    function initialize(): void {
        document.addEventListener('viewshow', event => {
            lastEvent = event;
            // Router-internal calls in later tasks must not reuse an unforwarded DOM event.
            queueMicrotask(() => { if (lastEvent === event) lastEvent = null; });
        }, true);
        document.addEventListener('viewshow', event => {
            if (hooked) return;
            lastEvent = null;
            runtime.notifyViewHandlers(currentView() || undefined, event.target instanceof Element ? event.target : null,
                window.location.hash, event);
        });
        for (const event of ['je:navigate', 'hashchange', 'popstate']) {
            window.addEventListener(event, runtime.dispatchNavigate);
        }
        // The marker preserves coexistence with hosts that already installed JE history hooks.
        const history: History & { __jePushed?: boolean } = window.history;
        if (!history.__jePushed) {
            history.__jePushed = true;
            for (const method of ['pushState', 'replaceState'] as const) {
                const original = history[method].bind(history);
                history[method] = (data: unknown, unused: string, url?: string | URL | null) => {
                    const before = window.location.href;
                    original(data, unused, url);
                    if (window.location.href !== before) window.dispatchEvent(new Event('je:navigate'));
                };
            }
        }
        installEmbyHook();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
    else initialize();
}
