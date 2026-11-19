// The loader's component-group globals and types (client/src/bootstrap/loader/, built into js/plugin.js). Kept out of
// bootstrap-pages-host.ts, which the standalone pages also bundle: their inline source maps carry every line of it.

/** The pace of a group load: see client/src/bootstrap/loader/group-loader.ts `ensure`. */
export type GroupPace = 'boot' | 'background' | 'now';
/** `JE.loader`: the component-group loader, for features and automation. */
export interface ComponentGroupLoader {
    ensure(ids: string | readonly string[], options?: { pace?: GroupPace }): Promise<void>;
    state(): Record<string, 'loading' | 'ready'>;
    needed(): string[];
    settled(): Promise<void>;
    catalog(): {
        groups: Array<{ id: string; exports: string[] }>;
        initializers: Array<{ group: string; path: string }>;
        pages: Array<{ group: string; flag: string; delivery: string; tab: Array<string | null | undefined>; marker: string }>;
    };
}
/** What the loader's group rules use of enhanced/helpers.js and core/navigation.js once "core" has run. */
export interface LoaderHelpers {
    isActiveTabContainer?(element: Element): boolean;
    observeTabContainers?(id: string, selector: string, callback: () => void): { teardown(): void } | undefined;
}
export interface LoaderCore { navigation?: { onNavigate?(callback: () => void): unknown } }

/** Bundle globals are written by Features/Platform/Services/ClientScriptBundle.cs. */
interface BundleWindow extends Window {
    __JE_BUNDLE_MODULES?: unknown;
    __JE_BUNDLE_TOTAL?: unknown;
    __JE_BUNDLE_PROGRESS?: number;
    __JE_BUNDLES?: Record<string, unknown>;
    JE?: unknown;
}
const bundleWindow = (): BundleWindow => window;

/** What one bundle script defined for a group: its module functions and how many it announced. */
export interface DefinedBundle { modules: unknown; total: unknown }

/** Forget a previous whole bundle's module list before the script that defines the next one is requested. */
export function resetBundleGlobals(): void {
    bundleWindow().__JE_BUNDLE_MODULES = undefined;
}
/** Take the whole bundle's module list exactly once; the functions are single-use. */
export function takeBundle(): DefinedBundle {
    const host = bundleWindow();
    const bundle = { modules: host.__JE_BUNDLE_MODULES, total: host.__JE_BUNDLE_TOTAL };
    delete host.__JE_BUNDLE_MODULES;
    return bundle;
}
/** Take what a group bundle (bundle.js?g=...) defined for each of these groups, exactly once. */
export function takeGroupBundles(ids: readonly string[]): Record<string, DefinedBundle | undefined> {
    const defined = bundleWindow().__JE_BUNDLES ?? {};
    const taken: Record<string, DefinedBundle | undefined> = Object.create(null);
    for (const id of ids) {
        const bundle = defined[id];
        taken[id] = typeof bundle === 'object' && bundle !== null && 'modules' in bundle && 'total' in bundle
            ? { modules: bundle.modules, total: bundle.total } : undefined;
        delete defined[id];
    }
    return taken;
}
/** window.__JE_BUNDLE_PROGRESS counts the modules run since the page loaded. */
export function countBundleModule(): void {
    const host = bundleWindow();
    host.__JE_BUNDLE_PROGRESS = Math.max(0, host.__JE_BUNDLE_PROGRESS || 0) + 1;
}
/**
 * `window.JE` names the plugin for scripts outside JE (and JE's own custom-tab pages), unless the page has a
 * `window.JE` of its own.
 */
export function aliasNamespace(namespace: object): void {
    const host = bundleWindow();
    if (!host.JE) host.JE = namespace;
}
