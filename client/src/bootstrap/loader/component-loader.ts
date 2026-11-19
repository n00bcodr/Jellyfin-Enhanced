import { client } from '../../host/bootstrap-pages-host';
import { countBundleModule } from '../../host/component-groups-host';
import { getScriptVersion } from './script-tag';

export const COMPONENT_SCRIPTS_BASE_PATH = '/JellyfinEnhanced/js';
// Module-runner pacing. Evaluating component modules costs main-thread time. As one task, or as
// slices competing on equal terms, it lands while jellyfin-web renders its first view and delays
// it by that much. So at boot each slice runs in idle time (the timeout caps the wait) and stays
// short, so a task that becomes pending mid-slice, such as a chunk arriving on a cold load, waits
// only a few milliseconds. A group loaded later because the user went to its page is paced the
// same way, so the new view is drawn first; one loaded because something was asked for directly
// (the settings panel, a shortcut) keeps the short slices but does not wait for idle time.
const BUNDLE_RUN_BUDGET_MS = 10;
export const BUNDLE_IDLE_TIMEOUT_MS = 100;

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
 * Bootstrap's list when available, else the embedded manifest. A failed request is retried once; if
 * that fails too it throws, since an empty list would load no feature at all.
 */
export async function getComponentScriptList(fromBootstrap: unknown): Promise<string[]> {
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
    // ApiClient.ajax rejects with the fetch Response itself: name its status, not "[object Response]".
    const status = typeof lastError === 'object' && lastError !== null && 'status' in lastError ? lastError.status : undefined;
    const reason = lastError instanceof Error ? lastError.message : typeof status === 'number' ? `HTTP ${status}` : String(lastError);
    throw new Error(`Could not load the component-script manifest: ${reason}`);
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
export function waitForIdle(timeoutMs: number): Promise<IdleDeadline | null> {
    if (typeof requestIdleCallback === 'function') {
        return new Promise(resolve => { requestIdleCallback(resolve, { timeout: timeoutMs }); });
    }
    return yieldToEventLoop().then(() => null);
}

/** One entry of a run: a module's function, or a step of the loader's own (not counted as a module). */
export interface RunStep { run: () => void; name: string; loaderStep?: boolean }

/**
 * Run module functions in order, in short slices (see the pacing notes above). A module that throws
 * is logged and rethrown asynchronously, so it still surfaces as an uncaught error like a throwing
 * script, and the run continues. `idle`: wait for browser idle time between slices (boot, and a page
 * the user went to) instead of only yielding.
 */
export async function runBundleModules(steps: readonly RunStep[], idle: boolean): Promise<void> {
    const nextSlice = (): Promise<IdleDeadline | null> => (idle ? waitForIdle(BUNDLE_IDLE_TIMEOUT_MS) : yieldToEventLoop().then(() => null));
    let deadline = await nextSlice();
    let sliceStart = performance.now();
    for (const [index, step] of steps.entries()) {
        try {
            step.run();
        } catch (error) {
            console.error(`🪼 Jellyfin Enhanced: Module '${step.name || `#${index + 1}`}' threw while loading; continuing with the next module.`, error);
            setTimeout(() => { throw error; }, 0);
        }
        if (!step.loaderStep) countBundleModule();
        if (index + 1 >= steps.length) break;
        // End the slice when its budget is spent or the idle period is over. A callback run
        // by the timeout reports no idle time, so it gets the full budget and always progresses.
        const budgetSpent = performance.now() - sliceStart >= BUNDLE_RUN_BUDGET_MS;
        const idleOver = !!deadline && !deadline.didTimeout && deadline.timeRemaining() < 1;
        if (budgetSpent || idleOver) {
            deadline = await nextSlice();
            sliceStart = performance.now();
        }
    }
}
