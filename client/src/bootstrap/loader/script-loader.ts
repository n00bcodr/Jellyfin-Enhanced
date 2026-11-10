import { client } from '../../host/bootstrap-pages-host';
import { getScriptVersion } from './script-tag';

/** Insert a classic script. Load and error stay property handlers, as the host's loaders use. */
export function appendScript(src: string, configure?: (script: HTMLScriptElement) => void,
    onLoad?: () => void, onError?: (error: unknown) => void): void {
    const script = document.createElement('script');
    script.src = src;
    configure?.(script);
    if (onLoad) script.onload = () => onLoad();
    if (onError) script.onerror = error => onError(error);
    document.head.appendChild(script);
}

/** Resolves true on load and false on failure, so callers decide about the fallback. */
export const scriptLoaded = (src: string, configure?: (script: HTMLScriptElement) => void): Promise<boolean> =>
    new Promise(resolve => { appendScript(src, configure, () => resolve(true), () => resolve(false)); });

/**
 * Load scripts in parallel with execution forced into array order (async=false),
 * so js/core/* runs before dependents. One failure never stops the others.
 */
export async function loadScripts(scripts: readonly string[], basePath: string): Promise<void> {
    await Promise.allSettled(scripts.map(name => new Promise<void>(resolve => {
        appendScript(client().getUrl(`${basePath}/${name}?v=${getScriptVersion()}`), script => { script.async = false; },
            resolve, error => {
                console.error(`🪼 Jellyfin Enhanced: Failed to load script '${name}'`, error);
                resolve();
            });
    })));
}
