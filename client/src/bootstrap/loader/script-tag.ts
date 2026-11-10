import { liveNamespace } from '../../host/bootstrap-pages-host';

const scriptTag = () => document.querySelector('script[plugin="Jellyfin Enhanced"]');

/** Whether the server injected dev mode: component scripts then load file by file. */
export const isDevMode = (): boolean => scriptTag()?.getAttribute('dev') === 'true';

/**
 * Cache-busting value. The tag's version attribute holds the full cache key
 * (version + DLL timestamp) baked in at server startup, unlike JE.pluginVersion.
 */
export function getScriptVersion(): string | number {
    if (isDevMode()) return Date.now();
    return scriptTag()?.getAttribute('version') || liveNamespace()?.pluginVersion || Date.now();
}

/** The cache key's version part is what /version returns, so translations.js skips that request. */
export function scriptTagVersion(): string {
    return (scriptTag()?.getAttribute('version') || '').split('-')[0] ?? '';
}
