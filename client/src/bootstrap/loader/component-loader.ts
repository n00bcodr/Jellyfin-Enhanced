import { client, reportBundleProgress, resetBundleGlobals, takeBundle } from '../../host/bootstrap-pages-host';
import { loadScripts, scriptLoaded } from './script-loader';
import { getScriptVersion, isDevMode } from './script-tag';

const COMPONENT_SCRIPTS_BASE_PATH = '/JellyfinEnhanced/js';
// Evaluating the 150+ component modules costs ~100 ms of main thread. As one task, or as
// slices competing on equal terms, it delays jellyfin-web's first view by that much. So each
// slice runs in idle time (the timeout caps the wait) and stays short, so a task that becomes
// pending mid-slice, such as a chunk arriving on a cold load, waits only a few milliseconds.
const BUNDLE_RUN_BUDGET_MS = 10;
const BUNDLE_IDLE_TIMEOUT_MS = 100;

/** Drop "//" note entries from the manifest; null when it is not a usable manifest. */
export function filterComponentManifest(manifest: unknown): string[] | null {
    if (!Array.isArray(manifest)) return null;
    const scripts = manifest
        .filter((entry): entry is string => typeof entry === 'string')
        .map(entry => entry.trim())
        .filter(entry => entry && !entry.startsWith('//'));
    return scripts.length ? scripts : null;
}

/** Attempts at the manifest request, and the wait between them. */
const MANIFEST_ATTEMPTS = 2;
const MANIFEST_RETRY_DELAY_MS = 1000;

/**
 * Bootstrap's list when available, else the embedded manifest. Only dev and fallback need it. A failed
 * request is retried once; if that fails too it throws, since an empty list would load no feature at all.
 */
async function getComponentScriptList(fromBootstrap: unknown): Promise<string[]> {
    const fromPayload = filterComponentManifest(fromBootstrap);
    if (fromPayload) return fromPayload;
    let lastError: unknown;
    for (let attempt = 1; attempt <= MANIFEST_ATTEMPTS; attempt++) {
        if (attempt > 1) await new Promise(resolve => setTimeout(resolve, MANIFEST_RETRY_DELAY_MS));
        try {
            const api = client();
            const manifest = await api.ajax({
                type: 'GET',
                url: api.getUrl(`${COMPONENT_SCRIPTS_BASE_PATH}/component-scripts.json?v=${getScriptVersion()}`),
                dataType: 'json'
            });
            const scripts = filterComponentManifest(manifest);
            if (scripts) return scripts;
            lastError = new Error('Manifest is empty or malformed');
        } catch (error) {
            lastError = error;
        }
        if (attempt < MANIFEST_ATTEMPTS) console.warn('🪼 Jellyfin Enhanced: Could not load the component-script manifest; retrying.', lastError);
    }
    throw new Error(`Could not load the component-script manifest: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/**
 * Yield as a macrotask that queues behind everything already pending (unlike
 * scheduler.yield), so jellyfin-web's own tasks run between module slices.
 */
function yieldToEventLoop(): Promise<void> {
    return new Promise(resolve => {
        if (typeof MessageChannel === 'function') {
            const channel = new MessageChannel();
            channel.port1.onmessage = () => resolve();
            channel.port2.postMessage(null);
        } else {
            setTimeout(resolve, 0);
        }
    });
}

/** Wait for browser idle, capped by the timeout; null where requestIdleCallback is unavailable. */
function waitForIdle(timeoutMs: number): Promise<IdleDeadline | null> {
    if (typeof requestIdleCallback === 'function') {
        return new Promise(resolve => { requestIdleCallback(resolve, { timeout: timeoutMs }); });
    }
    return yieldToEventLoop().then(() => null);
}

/**
 * Run the bundle's module functions in manifest order in short idle slices. A
 * module that throws is logged and rethrown asynchronously, so it still surfaces
 * as an uncaught error like a throwing script, and the run continues.
 */
export async function runBundleModules(modules: ReadonlyArray<() => void>, fromBootstrap: unknown): Promise<void> {
    const names = filterComponentManifest(fromBootstrap) || [];
    let deadline = await waitForIdle(BUNDLE_IDLE_TIMEOUT_MS);
    let sliceStart = performance.now();
    for (const [index, module] of modules.entries()) {
        try {
            module();
        } catch (error) {
            console.error(`🪼 Jellyfin Enhanced: Module '${names[index] || `#${index + 1}`}' threw while loading; continuing with the next module.`, error);
            setTimeout(() => { throw error; }, 0);
        }
        reportBundleProgress(index + 1);
        if (index + 1 >= modules.length) break;
        // End the slice when its budget is spent or the idle period is over. A callback run
        // by the timeout reports no idle time, so it gets the full budget and always progresses.
        const budgetSpent = performance.now() - sliceStart >= BUNDLE_RUN_BUDGET_MS;
        const idleOver = !!deadline && !deadline.didTimeout && deadline.timeRemaining() < 1;
        if (budgetSpent || idleOver) {
            deadline = await waitForIdle(BUNDLE_IDLE_TIMEOUT_MS);
            sliceStart = performance.now();
        }
    }
}

const isModuleList = (value: unknown): value is Array<() => void> =>
    Array.isArray(value) && value.length > 0 && value.every(entry => typeof entry === 'function');

/**
 * Load every component from the server-side bundle. Falls back to the per-file
 * loader when the request fails or nothing was defined (a syntax error aborts
 * the whole script), so only a broken file fails.
 */
async function loadComponentBundle(fromBootstrap: unknown): Promise<void> {
    const url = client().getUrl(`/JellyfinEnhanced/bundle.js?v=${getScriptVersion()}`);
    resetBundleGlobals(); // -1 = nothing executed; the bundle's prologue sets 0.
    // Fetch and parse only once jellyfin-web is idle, at low fetch priority. Measured: an early
    // preload made its first content ~200-300 ms later on a cold 20 Mbps load, and inserting
    // right away put the 2.8 MB pre-parse in front of the first view's rendering.
    await waitForIdle(BUNDLE_IDLE_TIMEOUT_MS);
    const requestOk = await scriptLoaded(url, script => { script.setAttribute('fetchpriority', 'low'); });
    const { modules, total } = takeBundle();
    if (requestOk && isModuleList(modules) && modules.length === total) {
        await runBundleModules(modules, fromBootstrap);
        return;
    }
    const scripts = await getComponentScriptList(fromBootstrap);
    console.warn(requestOk
        ? '🪼 Jellyfin Enhanced: Component bundle did not define its modules (syntax error?) — loading the component scripts individually.'
        : '🪼 Jellyfin Enhanced: Component bundle request failed — loading the component scripts individually.');
    await loadScripts(scripts, COMPONENT_SCRIPTS_BASE_PATH);
}

/** Dev mode loads individual files (debuggable, no-store); production loads the bundle. */
export async function loadComponentScripts(fromBootstrap: unknown): Promise<void> {
    if (isDevMode()) {
        await loadScripts(await getComponentScriptList(fromBootstrap), COMPONENT_SCRIPTS_BASE_PATH);
        return;
    }
    await loadComponentBundle(fromBootstrap);
}
