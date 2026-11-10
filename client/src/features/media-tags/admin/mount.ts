/**
 * @file The Media Tags tab across Jellyfin's view lifecycle: the section
 * modules loaded once per document in order, one live page (Jellyfin keeps
 * earlier views in the document), activations one after another, every answer
 * checked against the session it was asked in, and pending saves flushed
 * before the page hides or the browser tab closes.
 */
import { dashboard } from './host';
import { find } from './dom';
import type { SaveStore } from './save-store';
import type { PageContext, PageOptions, Target } from './types';
import { configOf, type Config } from './values';

/** The one live page: only the shown one is built (ids stay unique), another is emptied and rebuilt if shown again. */
export interface MountState { active: { page: HTMLElement; root: HTMLElement; ctx: PageContext } | null }

export interface LifecycleDeps {
    mount: MountState;
    saves: SaveStore;
    signedIn(): boolean;
    createPage(root: HTMLElement, config: Config, options?: PageOptions): PageContext;
    pluginId: string;
    tx(text: unknown): string;
    sectionFiles: readonly string[];
    getConfiguration(pluginId: string): Promise<unknown>;
    scriptUrl(file: string, query: string): string;
    leaveWithPending(): Promise<void>;
    /** The section the URL asks for, once per address. */
    freshTarget(): Target;
}

/** The root whose sticky offset follows Jellyfin's toolbar (one listener for the document). */
let toolbarRoot: HTMLElement | null = null;
/**
 * Sticky tabs and the collapsed preview sit under Jellyfin's fixed toolbar and
 * the configuration page's sticky header, not behind them: the lower edge of the two becomes --je-ta-toolbar.
 * @param root
 */
function followToolbar(root: HTMLElement): void {
    const measure = (): void => {
        const tracked = toolbarRoot;
        if (!tracked?.isConnected) return;
        let bottom = 0;
        for (const bar of Array.from(document.querySelectorAll('.skinHeader, .MuiAppBar-root'))) {
            const style = getComputedStyle(bar);
            if (style.position !== 'fixed' && style.position !== 'sticky') continue;
            const box = bar.getBoundingClientRect();
            if (box.height > 0 && box.top <= 0) bottom = Math.max(bottom, Math.round(box.bottom));
        }
        // The configuration page's title, search and sidebar toggle stay pinned (desktop): where it sticks, plus its height.
        const page = tracked.closest('[data-role="page"]');
        const header = find(page, '.je-sticky-header');
        if (header) {
            const style = getComputedStyle(header);
            if (style.position === 'sticky') bottom = Math.max(bottom, Math.round((parseFloat(style.top) || 0) + header.getBoundingClientRect().height));
        }
        // On a phone the page's section menu bar sticks under the toolbar: below it too.
        const nav = find(page, '.jea-nav');
        const navToggle = nav?.querySelector('.jea-nav-toggle');
        if (nav && navToggle && getComputedStyle(navToggle).display !== 'none' && getComputedStyle(nav).position === 'sticky') {
            bottom = Math.max(bottom, Math.round((parseFloat(getComputedStyle(nav).top) || 0) + navToggle.getBoundingClientRect().height));
        }
        tracked.style.setProperty('--je-ta-toolbar', `${bottom}px`);
        // The settings column (the page's content, beside its sidebar): the conflict bar is centred on it, not on the window.
        const main = tracked.closest('.jea-main');
        if (main) {
            const box = main.getBoundingClientRect();
            tracked.style.setProperty('--je-ta-main-x', `${Math.round(box.left + box.width / 2)}px`);
            tracked.style.setProperty('--je-ta-main-w', `${Math.round(box.width)}px`);
        }
    };
    if (!toolbarRoot) window.addEventListener('resize', () => measure(), { passive: true });
    toolbarRoot = root;
    measure();
    setTimeout(measure, 300);
}

/**
 * Theme: Jellyfin's themes swap a stylesheet, so tell light from dark by the page background (as configPage.html does).
 * @param root
 */
function detectTheme(root: HTMLElement): void {
    try {
        const m = getComputedStyle(document.documentElement).backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        root.classList.toggle('je-ta-light', !!m && (Number(m[1]) + Number(m[2]) + Number(m[3])) > 450);
    } catch { /* keep dark */ }
}

/**
 * Load a script once (resolves when it ran).
 * @param src
 */
function loadScript(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = src;
        el.onload = () => resolve();
        el.onerror = () => reject(new Error(`could not load ${src}`));
        document.head.appendChild(el);
    });
}

/** Creates the tab's lifecycle (one per document). */
export function createLifecycle(deps: LifecycleDeps) {
    const { mount, saves } = deps;
    /** the section modules, loaded once per document */
    let modulesLoaded: Promise<void> | null = null;
    // A configuration reload may finish after viewbeforehide. It must not
    // resume a hidden preview (or retain sheets from a late first mount).
    const hiddenPages = new WeakSet<HTMLElement>();
    /** activations run one after another */
    let queue: Promise<PageContext | null> = Promise.resolve(null);
    let unloadWired = false;

    /**
     * Make a page element the live one: build it (tearing down any other), or
     * reload its configuration when it already is; then open the tab the URL asks for.
     * @param page
     */
    function activate(page: HTMLElement): Promise<PageContext | null> {
        queue = queue.then(() => show(page)).catch((err: unknown) => {
            console.error('🪼 Jellyfin Enhanced: the Media Tags tab failed to load', err);
            const root = find(page, '.je-tag-admin');
            if (root) showLoadError(page, root);
            return null;
        });
        return queue;
    }

    /**
     * One activation. Every answer is checked against the session it was asked
     * in: another session's settings are never shown. When someone is signed in
     * now (another server, another administrator), the page starts again for
     * them; signed out, it stays empty.
     * @param page
     */
    async function show(page: HTMLElement): Promise<PageContext | null> {
        const root = find(page, '.je-tag-admin');
        if (!root) throw new Error('The Media Tags tab has no .je-tag-admin element');
        detectTheme(root);
        followToolbar(root);
        // Another administrator (or server) since the last view: start from nothing.
        const mark = saves.sessionMark();
        const again = (): Promise<PageContext | null> | null => (deps.signedIn() ? show(page) : null);
        const live = mount.active;
        if (live && live.page === page && root.contains(live.ctx.root.firstElementChild)) {
            let fresh: Config | null = null;
            try {
                const answer = await deps.getConfiguration(deps.pluginId);
                fresh = configOf(answer);
                // A malformed answer is not the stored settings: the page keeps what it shows.
                if (!fresh && saves.sameSession(mark)) console.warn('🪼 Jellyfin Enhanced: the configuration the server returned is not a settings document');
            } catch (err) { if (saves.sameSession(mark)) console.warn('🪼 Jellyfin Enhanced: could not reload the configuration', err); }
            // Signed out or another session while it loaded: the reset emptied the view.
            if (!saves.sameSession(mark)) return again();
            const active = mount.active;
            if (!active) return null;
            if (fresh) active.ctx.reload(fresh);
            if (!hiddenPages.has(page)) active.ctx.preview?.resume();
            const target = deps.freshTarget();
            if (target.tab) active.ctx.openTab(target.tab, { group: target.group });
            return active.ctx;
        }
        if (live) {
            mount.active = null;
            await live.ctx.flush();
            live.ctx.dispose();
            live.root.replaceChildren();
            delete live.root.dataset.tab;
            if (!saves.sameSession(mark)) return again();
        }
        dashboard()?.showLoadingMsg?.();
        let config: Config | null = null;
        let failure: unknown = null;
        try {
            const answer = await deps.getConfiguration(deps.pluginId);
            config = configOf(answer);
            if (!config) failure = new TypeError('The configuration the server returned is not a settings document');
        } catch (err) {
            failure = err ?? new Error('The configuration could not be read');
        } finally {
            dashboard()?.hideLoadingMsg?.();
        }
        // The previous session's settings (or failure), answered after it ended: not shown to anyone.
        if (!saves.sameSession(mark)) return again();
        if (failure || !config) {
            console.error('🪼 Jellyfin Enhanced: could not load the Media Tags settings', failure);
            showLoadError(page, root);
            return null;
        }
        const ctx = deps.createPage(root, config);
        mount.active = { page, root, ctx };
        if (hiddenPages.has(page)) ctx.preview?.suspend();
        return ctx;
    }

    /**
     * The settings could not be loaded: say so in the page, with Retry (which
     * activates the page again), instead of the loading line.
     */
    function showLoadError(page: HTMLElement, root: HTMLElement): void {
        root.innerHTML = `<div class="je-ta-wait je-ta-load-error" role="alert"><p>${deps.tx('The Media Tags settings could not be loaded from the server.')}</p>`
            + `<button type="button" class="je-ta-button" data-je-reload><span class="material-icons" aria-hidden="true">refresh</span>${deps.tx('Retry')}</button></div>`;
        const retry = root.querySelector('[data-je-reload]');
        if (!(retry instanceof HTMLButtonElement)) return;
        retry.addEventListener('click', () => {
            retry.disabled = true;
            void activate(page);
        }, { once: true });
    }

    /**
     * Mount the Media Tags tab: load the section modules once, build the tab and
     * keep it live across Jellyfin's view lifecycle of the configuration page
     * that holds it. Called again, it reloads the configuration and opens the
     * section the URL asks for.
     * @param tab - The tab's element (`#media-tags`, holding `.je-tag-admin`).
     * @param version - Cache-busting version for the module URLs.
     */
    async function mountTab(tab: HTMLElement, version?: string): Promise<PageContext | null> {
        if (!modulesLoaded) {
            const query = version ? `?v=${encodeURIComponent(version)}` : '';
            const loading = deps.sectionFiles.reduce<Promise<void>>((chain, file) => chain.then(() => loadScript(deps.scriptUrl(file, query))), Promise.resolve());
            modulesLoaded = loading;
            // A module that failed to load is tried again the next time the tab opens.
            loading.catch(() => { if (modulesLoaded === loading) modulesLoaded = null; });
        }
        await modulesLoaded;
        const closestPage = tab.closest('[data-role="page"]');
        const page = closestPage instanceof HTMLElement ? closestPage : tab;
        if (!page.dataset.jeTaWired) {
            page.dataset.jeTaWired = '1';
            // Shown again: the configuration page calls mountTab when the tab is (or becomes) the one shown.
            page.addEventListener('viewshow', () => { hiddenPages.delete(page); });
            page.addEventListener('viewbeforehide', () => {
                hiddenPages.add(page);
                const active = mount.active;
                if (active?.page !== page) return;
                active.ctx.preview?.suspend();
                void deps.leaveWithPending();
            });
        }
        if (!unloadWired) {
            unloadWired = true;
            // Leaving the dashboard (reload, closing the tab) with an edit not saved: the browser asks.
            window.addEventListener('beforeunload', (e) => {
                if (!saves.hasPending()) return;
                void saves.flush();
                e.preventDefault();
                e.returnValue = '';
            });
        }
        return activate(page);
    }

    return { activate, mountTab };
}
