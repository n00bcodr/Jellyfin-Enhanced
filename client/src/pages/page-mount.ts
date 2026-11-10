import { pagesBridge, pagesClient, type PagesBridge } from '../host/bootstrap-pages-host';

const MAX_WAIT_MS = 5000;
const INTERVAL_MS = 50;
const MOUNT_EVENT = 'je:plugin-page-mounted';

/** A selector other code treats as unique: the mounted page borrows it while visible. */
export type ExclusiveToken = { kind: 'id'; id: string } | { kind: 'class'; selector: string; className: string };

/** One activation of a page. Everything tied to `signal` ends when the page is left. */
export interface PageView {
    readonly container: HTMLElement;
    readonly signal: AbortSignal;
    /** Re-assert exclusivity; true when a render created a duplicate, which is then emptied. */
    reclaim(): boolean;
}

export interface PageDefinition<Facade> {
    readonly name: string;
    readonly pageSelector: string;
    readonly containerSelector: string;
    createContainer(): HTMLElement;
    /** Set only for pages whose feature looks its container up globally. */
    readonly exclusive?: ExclusiveToken;
    resolve(bridge: PagesBridge): Facade | null | undefined;
    /** Omitted when the feature renders the container on its own. */
    render?(facade: Facade, view: PageView): void;
    suspend?(facade: Facade, view: PageView): void;
    readonly loadedMessage?: string;
}

interface MountedMarkup { page: Element; loading: HTMLElement | null; error: HTMLElement | null }

const asHtml = (element: Element | null): HTMLElement | null => element instanceof HTMLElement ? element : null;
const isRendered = (element: HTMLElement) => element.offsetWidth > 0 || element.offsetHeight > 0;

/** The nearest earlier sibling (or descendant of one): this insertion's own markup. */
function preceding(start: Element, selector: string): Element | null {
    for (let node = start.previousElementSibling; node; node = node.previousElementSibling) {
        const match = node.matches(selector) ? node : node.querySelector(selector);
        if (match) return match;
    }
    return null;
}

/**
 * Plugin Pages inserts the fetched fragment and runs this script during insertion,
 * so the running script identifies its own copy of the markup. Ids cannot: cached
 * views keep earlier copies and getElementById returns the first, which may be stale.
 */
export function locateMarkup(script: Element | null, pageSelector: string): MountedMarkup | null {
    if (script) {
        const page = preceding(script, pageSelector);
        if (page) return { page, loading: asHtml(preceding(script, '#je-loading')), error: asHtml(preceding(script, '#je-error')) };
    }
    // A host that evaluated the script outside insertion: use the visible preferences page.
    const views = [...document.querySelectorAll<HTMLElement>('#userPluginPreferencesPage')];
    const scope = views.find(view => view.offsetWidth > 0 && view.offsetHeight > 0) ?? document;
    const pages = [...scope.querySelectorAll<HTMLElement>(pageSelector)].filter(page => !page.closest('[data-type="custom"]'));
    const page = pages.reverse().find(isRendered) ?? pages[0];
    if (!page) return null;
    const root = page.closest('[data-role="content"]')?.parentElement ?? document;
    return { page, loading: root.querySelector<HTMLElement>('#je-loading'), error: root.querySelector<HTMLElement>('#je-error') };
}

/** Comparable route: the host may rewrite `name.html` to `name` after loading a view. */
const routeKey = (hash: string) => hash.replace(/\.html(?=\?|$)/, '');

const hostIdentity = (): string => {
    const api = pagesClient();
    const server = typeof api?.serverId === 'function' ? api.serverId() : api?.serverId;
    return JSON.stringify([api?.getCurrentUserId?.(), server, api?.getUrl?.('/'), api?.accessToken?.()]);
};
const signedIn = (): boolean => !!pagesClient()?.getCurrentUserId?.();

/** Lends the exclusive token to the mounted container; every other holder gets it back. */
function createTokenLease(token: ExclusiveToken | undefined, container: HTMLElement) {
    const holders = (): Element[] => !token ? [] : [...document.querySelectorAll(token.kind === 'id' ? `[id="${token.id}"]` : token.selector)];
    const take = (element: Element) => {
        if (token?.kind === 'id') element.removeAttribute('id');
        else if (token) element.classList.remove(token.className);
    };
    const give = (element: Element) => {
        if (token?.kind === 'id') element.id = token.id;
        else if (token) element.classList.add(token.className);
    };
    let displaced: Element[] = [];
    function displaceOthers(): Element[] {
        const others = holders().filter(element => element !== container);
        others.forEach(take);
        displaced.push(...others);
        return others;
    }
    return {
        acquire(): void {
            displaceOthers();
            give(container);
        },
        reclaim(): boolean {
            const added = displaceOthers();
            added.forEach(element => { element.replaceChildren(); });
            return added.length > 0;
        },
        release(): void {
            if (!token) return;
            take(container);
            displaced.filter(element => element.isConnected).forEach(give);
            displaced = [];
        },
        /** Displaced holders miss a feature's identity reset, so they are cleared here. */
        clearDisplaced(): void { displaced.forEach(element => { element.replaceChildren(); }); }
    };
}

/**
 * Run a standalone page for as long as its host view exists. Must be called
 * synchronously from the page script, while document.currentScript is valid.
 * A cached view can be restored without its script running again, so leaving the
 * page suspends it and coming back resumes it, rather than ending the mount.
 */
export function mountPluginPage<Facade>(definition: PageDefinition<Facade>): void {
    const markup = locateMarkup(document.currentScript, definition.pageSelector);
    if (!markup) return;
    const { page, loading, error } = markup;
    const view = page.closest('[data-role="page"], .mainAnimatedPage');
    const container = page.querySelector<HTMLElement>(definition.containerSelector)
        ?? (page.appendChild(definition.createContainer()));
    const route = routeKey(location.hash);
    const lease = createTokenLease(definition.exclusive, container);
    const owner = new AbortController();
    const listening = { signal: owner.signal };

    let active = false;
    let hiddenByEvent = false;
    let awaitingUserData = false;
    let timer: number | null = null;
    let renderedFacade: Facade | null = null;
    let renderedIdentity: string | null = null;
    let activation = new AbortController();

    const pageView = (): PageView => ({ container, signal: activation.signal, reclaim: lease.reclaim });
    function stopWaiting(): void {
        if (timer !== null) clearInterval(timer);
        timer = null;
    }
    function showFailure(): void {
        if (loading) loading.style.display = 'none';
        if (error) error.style.display = 'block';
    }
    function complete(facade: Facade): void {
        stopWaiting();
        loading?.remove();
        renderedFacade = facade;
        renderedIdentity = hostIdentity();
        try {
            definition.render?.(facade, pageView());
        } catch (failure) {
            console.error(`🪼 Jellyfin Enhanced: ${definition.name} page failed to render.`, failure);
            showFailure();
            return;
        }
        if (definition.loadedMessage) console.log(`🪼 Jellyfin Enhanced: ${definition.loadedMessage}`);
    }
    function poll(): boolean {
        const bridge = pagesBridge();
        const facade = bridge && signedIn() ? definition.resolve(bridge) : null;
        if (!facade) return false;
        complete(facade);
        return true;
    }
    function startWaiting(): void {
        let waited = 0;
        timer = window.setInterval(() => {
            if (poll()) return;
            waited += INTERVAL_MS;
            if (waited < MAX_WAIT_MS) return;
            stopWaiting();
            showFailure();
        }, INTERVAL_MS);
    }
    function activate(): void {
        if (active) return;
        active = true;
        activation = new AbortController();
        if (renderedIdentity !== null && renderedIdentity !== hostIdentity()) {
            container.replaceChildren();
            lease.clearDisplaced();
        }
        lease.acquire();
        if (loading) loading.style.display = '';
        if (error) error.style.display = 'none';
        startWaiting();
    }
    function deactivate(): void {
        if (!active) return;
        active = false;
        stopWaiting();
        if (renderedFacade !== null) {
            try { definition.suspend?.(renderedFacade, pageView()); }
            catch (failure) { console.error(`🪼 Jellyfin Enhanced: ${definition.name} page failed to stop.`, failure); }
        }
        renderedFacade = null;
        activation.abort();
        lease.release();
    }
    function dispose(): void {
        deactivate();
        owner.abort();
    }
    function sync(): void {
        if (owner.signal.aborted) return;
        if (!container.isConnected) { dispose(); return; }
        const shown = !hiddenByEvent && !view?.classList.contains('hide') && !(view instanceof HTMLElement && view.hidden);
        if (shown && !awaitingUserData && routeKey(location.hash) === route) activate();
        else deactivate();
    }

    // Earlier mounts settle first, so a token is never held twice.
    document.dispatchEvent(new CustomEvent(MOUNT_EVENT, { detail: { name: definition.name, view } }));
    document.addEventListener(MOUNT_EVENT, event => {
        const detail: unknown = event instanceof CustomEvent ? event.detail : null;
        const same = typeof detail === 'object' && detail !== null && 'view' in detail && 'name' in detail
            && detail.name === definition.name && detail.view === view;
        if (same) dispose();
        else sync();
    }, listening);
    view?.addEventListener('viewshow', () => { hiddenByEvent = false; sync(); }, listening);
    view?.addEventListener('viewhide', () => { hiddenByEvent = true; sync(); }, listening);
    view?.addEventListener('viewdestroy', dispose, listening);
    for (const type of ['hashchange', 'popstate', 'je:navigate']) window.addEventListener(type, sync, listening);
    window.addEventListener('beforeunload', dispose, listening);
    // A transition means this content belongs to someone else, wherever the view is now.
    document.addEventListener('je:user-changed', () => {
        deactivate();
        awaitingUserData = true;
        renderedIdentity = null;
        container.replaceChildren();
        lease.clearDisplaced();
    }, listening);
    document.addEventListener('je:user-data-loaded', () => { awaitingUserData = false; sync(); }, listening);
    sync();
}

/** Surface a rejected fire-and-forget feature call without leaving it unhandled. */
export function settle(name: string, work: unknown): void {
    Promise.resolve(work).catch((failure: unknown) => console.error(`🪼 Jellyfin Enhanced: ${name} page update failed.`, failure));
}
