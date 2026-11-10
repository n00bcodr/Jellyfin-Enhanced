import {
    apiClient, engine, publishAssetVersion, publishCdnRoute, publishStartup, pluginVersion, startup,
    type AdminStartup,
} from '../../host/admin-config-host';
import type { AdminEngine } from './engine/api';

/** How long the engine may take before the page reports it could not load. */
export const ENGINE_LOAD_TIMEOUT_MS = 30000;

function versionQuery(version: string | null): { v: string } | undefined {
    return version ? { v: version } : undefined;
}

/** Whether a loaded script really was the settings engine with its sections. */
function usable(candidate: AdminEngine | undefined): candidate is AdminEngine {
    return !!candidate && typeof candidate.mount === 'function' && Object.keys(candidate.sections).length > 0;
}

/** Load jeAdmin.js with a script element; resolves only once it has defined the engine and its sections. */
function loadEngine(url: string): Promise<AdminEngine> {
    const running = engine();
    if (usable(running)) return Promise.resolve(running);
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        const timer = window.setTimeout(() => {
            script.remove();
            reject(new Error('the settings engine did not load in time'));
        }, ENGINE_LOAD_TIMEOUT_MS);
        script.async = true;
        script.src = url;
        script.onload = () => {
            window.clearTimeout(timer);
            const loaded = engine();
            if (usable(loaded)) resolve(loaded);
            else reject(new Error('the settings engine script defined no sections'));
        };
        script.onerror = () => {
            window.clearTimeout(timer);
            script.remove();
            reject(new Error('the settings engine script could not be loaded'));
        };
        document.head.appendChild(script);
    });
}

function addOnce(id: string, create: () => HTMLElement): void {
    if (document.getElementById(id)) return;
    const element = create();
    element.id = id;
    document.head.appendChild(element);
}

/**
 * The page's first script: stylesheet, CDN route, icon font, and the start of the engine load. The page
 * script waits for that load, so nothing here blocks the main thread while the view is being inserted.
 */
export function beginStartup(): void {
    const client = apiClient();
    const version = pluginVersion();
    publishAssetVersion(version);
    const query = versionQuery(version);

    addOnce('jeAdminCss', () => {
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = client.getUrl('/JellyfinEnhanced/Configuration/jeAdmin.css', query);
        return css;
    });

    // Every external CDN asset this page used to load directly is served from the plugin's own route.
    publishCdnRoute(subpath => client.getUrl('/JellyfinEnhanced/cdn/' + subpath));

    // JE's icon subset, under a private family name so a theme's own 'Material Symbols Rounded' is never shadowed.
    addOnce('jeAdminIconFont', () => {
        const style = document.createElement('style');
        style.textContent = "@font-face{font-family:'JE Material Symbols Rounded';font-style:normal;font-weight:100 700;font-display:block;src:url("
            + client.getUrl('/JellyfinEnhanced/fonts/materialsymbolsrounded-subset.woff2', query) + ") format('woff2');}";
        return style;
    });

    const engineUrl = client.getUrl('/JellyfinEnhanced/Configuration/jeAdmin.js', query);
    const state: AdminStartup = {
        engine: loadEngine(engineUrl),
        pageShown: false,
        retry() {
            state.engine = loadEngine(engineUrl);
            return state.engine;
        },
    };
    // The page may be shown before the engine arrives; the page script replays that once it starts.
    document.querySelector('#JellyfinEnhancedPage')?.addEventListener('pageshow', () => { state.pageShown = true; }, { once: true });
    state.engine.catch(() => { /* The page script reports this; it may start after the rejection. */ });
    publishStartup(state);
}

export function startupState(): AdminStartup | undefined {
    return startup();
}
