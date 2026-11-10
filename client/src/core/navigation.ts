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
        getViewHandlerCount: () => views.size,
        getNavCallbackCount: () => callbacks.size
    };
    return {
        navigation,
        dispatchNavigate(event?: Event): void {
            if (deps.href() === lastHref) return;
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
