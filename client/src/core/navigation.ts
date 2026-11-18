export type NavigateCallback = (event?: Event) => void;
export type ViewCallback = (view: string | null | undefined, element: Element | null | undefined,
    hash: string | undefined, item: Promise<unknown> | null, rawEvent: Event | null) => void;
export interface ViewOptions { pages?: readonly string[] | null; fetchItem?: boolean; immediate?: boolean }
export interface NavigationDependencies {
    href(): string;
    hash(): string;
    currentView(): string | null;
    currentElement(): Element | null;
    fetchItem(hash: string | undefined): Promise<unknown>;
    report(context: string, error: unknown): void;
    /** Whether the history entry is one a jellyfin-web dialog wrote (its router state lists the open dialogs). */
    isDialogEntry(): boolean;
    /** The history entry's state. */
    state(): unknown;
    /** Writes an address with history's own methods as they were before JE patched them: no 'je:navigate'. */
    writeAddress(state: unknown, url: string, push: boolean): void;
}

/**
 * An address without the fragment a page keeps its own state in (`#/route?query#state`, see the Seerr discovery
 * address): the part jellyfin-web's router reads.
 */
export function routerPart(href: string): string {
    const text = String(href);
    const at = text.indexOf('#');
    const mark = at < 0 ? -1 : text.indexOf('#', at + 1);
    return mark < 0 ? text : text.slice(0, mark);
}

/** An address's route (`…#/home`), without its query and fragment. */
export function routeOf(href: string): string {
    const text = String(href);
    const at = text.indexOf('#');
    return at < 0 ? text : text.slice(0, at + 1) + (text.slice(at + 1).split(/[?#]/)[0] ?? '');
}

/**
 * A page as the plugin's pages tell them apart: the router's part of its address, and the page a fragment opens over
 * it (the Recommendations category), not the filters it shows.
 */
export function pageOf(href: string): string {
    const head = routerPart(href);
    const category = /(?:^|[#&])jeCategory=([^&]*)/.exec(String(href).slice(head.length));
    return `${head}#${category ? category[1] : ''}`;
}

/** Navigation fan-out with snapshot iteration and cancellation of superseded dispatches. */
export function createNavigation(deps: NavigationDependencies) {
    const callbacks = new Map<NavigateCallback, object>();
    const views = new Set<{ callback: ViewCallback; options: ViewOptions }>();
    let lastHref: string | null = null;
    let navGeneration = 0;
    let viewGeneration = 0;
    function invoke(entry: { callback: ViewCallback; options: ViewOptions }, view: string | null | undefined,
        element: Element | null | undefined, hash: string | undefined, event: Event | null): void {
        if (entry.options.pages && (!view || !entry.options.pages.includes(view))) return;
        try {
            entry.callback(view, element, hash, entry.options.fetchItem ? deps.fetchItem(hash) : null, event);
        } catch (error) { deps.report('Error in view handler', error); }
    }
    const navigation = {
        onNavigate(callback: NavigateCallback): () => void {
            const entry = {};
            callbacks.set(callback, entry);
            return () => { if (callbacks.get(callback) === entry) callbacks.delete(callback); };
        },
        offNavigate: (callback: NavigateCallback): boolean => callbacks.delete(callback),
        onViewPage(callback: ViewCallback, options: ViewOptions = {}): () => void {
            const entry = { callback, options: { ...options, pages: options.pages ? [...options.pages] : null } };
            views.add(entry);
            if (options.immediate) invoke(entry, deps.currentView(), deps.currentElement(), deps.hash(), null);
            return () => { views.delete(entry); };
        },
        getCurrentView: () => deps.currentView(),
        /**
         * Changes the address without it being a navigation for the plugin: no 'je:navigate', and the address counts
         * as already seen, so its features keep what they show. For what a page keeps in its own address (a Seerr
         * section's filters, the Recommendations category page), which must not tear that page's features down. The
         * browser's Back and Forward to and from it still navigate. `state`: the entry's (keep `history.state` when
         * replacing: the router's own is in it); `push`: add a history entry (else the current one is replaced).
         */
        setAddressQuietly(state: unknown, url: string, push = false): void {
            deps.writeAddress(state, url, push);
            lastHref = deps.href();
        },
        getViewHandlerCount: () => views.size,
        getNavCallbackCount: () => callbacks.size
    };
    return {
        navigation,
        /**
         * The address the page opened at is already where it is: a popstate or hashchange that lands on it again (a
         * dialog's own history entry popped by Back, such as the Seerr More Info modal's) is not a navigation.
         * Unseeded, the first one after a reload or an opened link would tear every page feature down.
         */
        seed(): void { lastHref = deps.href(); },
        dispatchNavigate(event?: Event): void {
            if (deps.href() === lastHref) return;
            // A jellyfin-web dialog opened on the page (an item's "…" menu) pushes an entry at the address its router
            // last saw, which lacks the page's own fragment (its Seerr filters, the Recommendations category) and can
            // lag behind its query (a tab number corrected in place). The entry gets the page's address as it is
            // shown: the page is still there, and closing the dialog and a reload on its entry find the page as it
            // was. Back or Forward onto such an entry of the page shown gives it the page's address as it is now (its
            // filters may have changed since): the same page, not a navigation.
            if (lastHref !== null && deps.isDialogEntry()) {
                const href = deps.href();
                const pushed = event?.type === 'je:navigate';
                if (pushed ? routeOf(href) === routeOf(lastHref) : pageOf(href) === pageOf(lastHref)) {
                    deps.writeAddress(deps.state(), lastHref, false);
                    return;
                }
            }
            lastHref = deps.href();
            const generation = ++navGeneration;
            for (const [callback, entry] of [...callbacks]) {
                if (generation !== navGeneration) break;
                if (callbacks.get(callback) !== entry) continue;
                try { callback(event); }
                catch (error) { deps.report('Error in onNavigate callback', error); }
            }
        },
        notifyViewHandlers(view: string | null | undefined, element: Element | null | undefined,
            hash: string | undefined, event: Event | null): void {
            const generation = ++viewGeneration;
            for (const entry of [...views]) {
                if (generation !== viewGeneration) break;
                if (views.has(entry)) invoke(entry, view, element, hash, event);
            }
        }
    };
}
export type Navigation = ReturnType<typeof createNavigation>['navigation'];
