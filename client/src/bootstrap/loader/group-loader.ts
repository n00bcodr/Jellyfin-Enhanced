import { client } from '../../host/bootstrap-pages-host';
import { resetBundleGlobals, takeBundle, takeGroupBundles, type DefinedBundle, type GroupPace } from '../../host/component-groups-host';
import {
    BUNDLE_IDLE_TIMEOUT_MS, COMPONENT_SCRIPTS_BASE_PATH, getComponentScriptList, runBundleModules, waitForIdle, type RunStep
} from './component-loader';
import { isRecord } from './keys';
import { loadScripts, scriptLoaded } from './script-loader';
import { getScriptVersion, isDevMode } from './script-tag';

// Component groups.
//
// js/component-groups.json assigns the manifest's modules to named groups; every module it does not
// list belongs to the implicit "core" group. The server serves any set of groups as one script
// (bundle.js?g=a,b). Only the groups a page needs are downloaded and run: "core" always, the others
// when their feature is enabled and their route, surface or trigger appears (group-rules.ts). A
// group's modules run in manifest order, after the groups it names in "after", and its stage-6
// initializers run right after them. Dev mode, and any group whose bundle request fails, loads that
// group's files one by one instead: the same files in the same order.

export const CORE_GROUP = 'core';
const GROUP_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
/** A group none of whose files could be fetched is asked for again after 5 s, doubling to a minute. */
const GROUP_RETRY_DELAY_MS = 5000;
const GROUP_RETRY_MAX_DELAY_MS = 60_000;

export interface ResolvedGroup { id: string; after: string[]; scripts: string[] }
/**
 * The resolved groups of this page load: `order` is the run order ("core" first), and `whole` is true
 * when no usable groups file was available and "core" is the entire manifest.
 */
export interface ComponentGroups { order: string[]; byId: Record<string, ResolvedGroup>; whole: boolean }

/**
 * Resolve the "groups" array of js/component-groups.json against the manifest, exactly as
 * Features/Platform/Services/ClientScriptBundle.cs does: ids are unique and well formed, every listed
 * module is in the manifest and in one group only, and "after" names earlier groups only (so the file
 * order is a valid run order). Null for anything else.
 */
export function resolveComponentGroups(scripts: readonly string[], rawGroups: unknown): ComponentGroups | null {
    if (!Array.isArray(rawGroups)) return null;
    const position = new Map(scripts.map((path, index) => [path, index]));
    const owner = new Set<string>();
    const order = [CORE_GROUP];
    const byId: Record<string, ResolvedGroup> = Object.create(null);
    byId[CORE_GROUP] = { id: CORE_GROUP, after: [], scripts: [] };
    for (const entry of rawGroups) {
        const id = isRecord(entry) && typeof entry.id === 'string' ? entry.id : '';
        if (!isRecord(entry) || !GROUP_ID_PATTERN.test(id) || byId[id]) return null;
        const after: string[] = [];
        if (entry.after !== undefined) {
            if (!Array.isArray(entry.after)) return null;
            for (const name of entry.after) {
                if (typeof name !== 'string' || name === id || !byId[name]) return null;
                if (name !== CORE_GROUP && !after.includes(name)) after.push(name);
            }
        }
        if (!Array.isArray(entry.modules) || entry.modules.length === 0) return null;
        const own: string[] = [];
        for (const module of entry.modules) {
            const path = typeof module === 'string' ? module.trim() : '';
            if (!position.has(path) || owner.has(path)) return null;
            owner.add(path);
            own.push(path);
        }
        own.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
        byId[id] = { id, after, scripts: own };
        order.push(id);
    }
    byId[CORE_GROUP] = { id: CORE_GROUP, after: [], scripts: scripts.filter(path => !owner.has(path)) };
    return { order, byId, whole: false };
}

const isModuleList = (value: unknown): value is Array<() => void> =>
    Array.isArray(value) && value.length > 0 && value.every(entry => typeof entry === 'function');

export interface EnsureOptions {
    /**
     * 'boot' waits for idle time before requesting and runs the modules in idle time; 'background' (a
     * page the user went to) requests at once but still runs the modules in idle time, so jellyfin-web
     * draws the new view first; 'now' (the default: something was asked for directly) requests at once
     * and runs without waiting for idle time.
     */
    pace?: GroupPace;
    /** Boot: the caller runs the groups' stage-6 initializers itself, and a failure is its to report. */
    boot?: boolean;
}

/** What the loader asks of the rules and features around it (group-triggers.ts). */
export interface GroupLoaderHooks {
    /** The groups a group's rule loads along with it. */
    companions(id: string): readonly string[];
    /** Runs right after "core" in a split manifest, before every other group's modules (the Home tabs). */
    afterCore(): void;
    /** Groups loaded after boot have run: start their features. */
    loaded(ids: string[]): void;
    /** Some groups of a batch could not be fetched at all. */
    failed(): void;
}

export type GroupLoader = ReturnType<typeof createGroupLoader>;

/** All component-group state. plugin.js is one entry, so exactly one instance exists. */
export function createGroupLoader(hooks: GroupLoaderHooks) {
    let groups: ComponentGroups | null = null;
    /** Why the manifest could not be read, when the whole bundle is being loaded without it. */
    let manifestError: unknown = null;
    /** Group id -> 'loading' | 'ready'. A group that is absent has not been asked for. */
    const states: Record<string, 'loading' | 'ready'> = Object.create(null);
    /** Batches run strictly one after another, in the order they were asked for. */
    let queue: Promise<void> = Promise.resolve();
    /**
     * Group id -> time (ms) before which a group whose load failed entirely is not retried on a mere page
     * change, so an unreachable server is not asked again on every DOM change. The pause doubles with each
     * failure in a row.
     */
    const retryAfter: Record<string, number> = Object.create(null);
    const retryCount: Record<string, number> = Object.create(null);

    /**
     * Set the page's component groups from the bootstrap payload when it carries them, otherwise from the
     * embedded files. Without a usable groups file every module is "core" and the whole manifest loads as
     * one bundle, as it did before groups existed.
     */
    async function setGroups(bootstrap: { ComponentScripts?: unknown; ComponentGroups?: unknown } | null): Promise<void> {
        let scripts: string[] = [];
        try {
            scripts = await getComponentScriptList(bootstrap ? bootstrap.ComponentScripts : null);
        } catch (error) {
            // Dev mode loads file by file and cannot start without the list. The whole bundle can: only its
            // per-file fallback needs the list, and reports this error then.
            if (isDevMode()) throw error;
            manifestError = error;
        }
        let rawGroups: unknown = bootstrap ? bootstrap.ComponentGroups : null;
        if (!Array.isArray(rawGroups) && !bootstrap && scripts.length) {
            try {
                const api = client();
                const file: unknown = await api.ajax({
                    type: 'GET',
                    url: api.getUrl(`${COMPONENT_SCRIPTS_BASE_PATH}/component-groups.json?v=${getScriptVersion()}`),
                    dataType: 'json'
                });
                rawGroups = isRecord(file) ? file.groups : null;
            } catch (error) {
                console.warn('🪼 Jellyfin Enhanced: Could not load the component-group file — loading every component script.', error);
            }
        }
        const resolved = scripts.length ? resolveComponentGroups(scripts, rawGroups) : null;
        if (!resolved && Array.isArray(rawGroups)) {
            console.warn('🪼 Jellyfin Enhanced: The component-group file is not usable — loading every component script.');
        }
        const whole: Record<string, ResolvedGroup> = Object.create(null);
        whole[CORE_GROUP] = { id: CORE_GROUP, after: [], scripts };
        groups = resolved ?? { order: [CORE_GROUP], byId: whole, whole: true };
    }

    /**
     * The given groups plus "core", everything they are (transitively) "after" and the groups their rules
     * load along with them, in run order. Unknown ids are dropped.
     */
    function withRequired(ids: readonly string[]): string[] {
        const current = groups;
        if (!current) return [];
        const wanted = new Set([CORE_GROUP]);
        const add = (id: string): void => {
            const group = current.byId[id];
            if (!group || wanted.has(id)) return;
            wanted.add(id);
            group.after.forEach(add);
            hooks.companions(id).forEach(add);
        };
        ids.forEach(add);
        return current.order.filter(id => wanted.has(id));
    }

    /**
     * Request one script holding the given groups and resolve with what it defined, or null when the
     * request failed (and in dev mode, which never requests bundles).
     */
    async function requestBundle(current: ComponentGroups, ids: readonly string[], idle: boolean): Promise<Record<string, DefinedBundle | undefined> | null> {
        if (isDevMode()) return null;
        // Fetch and parse the boot bundle only once jellyfin-web is idle, at low fetch priority. Measured: an
        // early preload made its first content ~200-300 ms later on a cold 20 Mbps load, and inserting right
        // away put the pre-parse in front of the first view's rendering.
        if (idle) await waitForIdle(BUNDLE_IDLE_TIMEOUT_MS);
        const version = getScriptVersion();
        const url = client().getUrl(current.whole
            ? `/JellyfinEnhanced/bundle.js?v=${version}`
            : `/JellyfinEnhanced/bundle.js?g=${ids.join(',')}&v=${version}`);
        if (current.whole) resetBundleGlobals();
        const requestOk = await scriptLoaded(url, script => { if (idle) script.setAttribute('fetchpriority', 'low'); });
        const bundles = current.whole ? { [CORE_GROUP]: takeBundle() } : takeGroupBundles(ids);
        return requestOk ? bundles : null;
    }

    /** Whether a bundle defined exactly the modules a group lists. */
    const isComplete = (current: ComponentGroups, group: ResolvedGroup, bundle: DefinedBundle | undefined): bundle is { modules: Array<() => void>; total: number } =>
        !!bundle && isModuleList(bundle.modules) && bundle.modules.length === bundle.total
        && (current.whole || bundle.total === group.scripts.length);

    /** A group's files for the per-file loader; in whole mode the manifest may still have to be reported missing. */
    function filesOf(current: ComponentGroups, group: ResolvedGroup): string[] {
        if (current.whole && !group.scripts.length) {
            throw manifestError ?? new Error('Could not load the component-script manifest: it is empty');
        }
        return group.scripts;
    }

    /**
     * Run one batch of groups, in order: each group's modules from the bundle when the request defined
     * them, otherwise its files one by one (dev mode, a failed request, or a bundle that defined nothing
     * because of a syntax error: then only the broken file fails, as before bundles existed).
     */
    async function runBatch(current: ComponentGroups, ids: readonly string[], pending: Promise<Record<string, DefinedBundle | undefined> | null>, idle: boolean): Promise<void> {
        const bundles = await pending;
        const defined = (id: string): Array<() => void> | null => {
            const group = current.byId[id];
            const bundle = bundles?.[id];
            return group && isComplete(current, group, bundle) ? bundle.modules : null;
        };
        if (!isDevMode() && !ids.every(id => defined(id))) {
            console.warn(bundles
                ? '🪼 Jellyfin Enhanced: Component bundle did not define its modules (syntax error?) — loading the component scripts individually.'
                : '🪼 Jellyfin Enhanced: Component bundle request failed — loading the component scripts individually.');
        }
        // Consecutive groups that load file by file go in as one ordered set of script tags, so their
        // downloads overlap as they always have.
        let files: string[] = [];
        let fileGroups: string[] = [];
        const flushFiles = async (): Promise<void> => {
            if (!fileGroups.length) return;
            const loading = fileGroups;
            const names = files;
            files = [];
            fileGroups = [];
            const results = await loadScripts(names, COMPONENT_SCRIPTS_BASE_PATH);
            // Nothing arrived at all (offline?): leave these groups unasked-for so the next trigger tries
            // again, instead of staying missing until reload.
            const anyLoaded = results.some(Boolean);
            for (const id of loading) {
                if (anyLoaded || id === CORE_GROUP) {
                    states[id] = 'ready';
                } else {
                    delete states[id];
                    const failures = retryCount[id] = (retryCount[id] ?? 0) + 1;
                    retryAfter[id] = Date.now() + Math.min(GROUP_RETRY_MAX_DELAY_MS, GROUP_RETRY_DELAY_MS * 2 ** (failures - 1));
                }
            }
        };
        // Consecutive groups that came in the bundle run as ONE list of modules, paced as one run. Run group
        // by group, each run would begin with its own wait for idle time, and a boot of twenty groups would
        // spread its modules over a second or more: modules that start work as they load (Seerr's fetch and
        // draw) would then finish before stage 6 had started the features they consult (Hidden Content),
        // which follows the last module.
        let steps: RunStep[] = [];
        let bundleGroups: string[] = [];
        const flushBundles = async (): Promise<void> => {
            if (!bundleGroups.length) return;
            const running = bundleGroups;
            const list = steps;
            steps = [];
            bundleGroups = [];
            await runBundleModules(list, idle);
            for (const id of running) states[id] = 'ready';
        };
        for (const id of ids) {
            const group = current.byId[id];
            if (!group) continue;
            // JE's own Home tabs are registered between "core" and every other group's modules, so the tabs
            // keep one order (group-triggers.ts registerPageTabs).
            const needsTabs = id === CORE_GROUP && !current.whole;
            const modules = defined(id);
            if (modules) {
                await flushFiles();
                modules.forEach((run, index) => steps.push({ run, name: group.scripts[index] ?? '' }));
                bundleGroups.push(id);
                if (needsTabs) steps.push({ run: hooks.afterCore, name: 'plugin.js (Home tab registration)', loaderStep: true });
            } else {
                await flushBundles();
                files = files.concat(filesOf(current, group));
                fileGroups.push(id);
                if (needsTabs) {
                    await flushFiles();
                    if (states[CORE_GROUP] === 'ready') hooks.afterCore();
                }
            }
        }
        await flushBundles();
        await flushFiles();
    }

    /**
     * Make sure the given groups (and everything they must load after) have run, loading whichever have
     * not been asked for yet as one request. The returned promise resolves once they, and every batch
     * asked for before them, have run. Only a boot batch can reject (boot reports it); a later one logs.
     * Groups run in the order they were asked for, so a dependency asked for earlier always runs first.
     */
    function ensure(ids: readonly string[], options: EnsureOptions = {}): Promise<void> {
        const current = groups;
        if (!current) return Promise.resolve();
        const missing = withRequired(ids).filter(id => !states[id]);
        if (!missing.length) return queue;
        for (const id of missing) states[id] = 'loading';
        const pending = requestBundle(current, missing, options.pace === 'boot').catch(() => null);
        const batch = queue
            .then(() => runBatch(current, missing, pending, options.pace === 'boot' || options.pace === 'background'))
            .then(() => {
                if (options.boot) return;
                const loaded = missing.filter(id => states[id] === 'ready');
                for (const id of loaded) {
                    delete retryAfter[id];
                    delete retryCount[id];
                }
                if (loaded.length < missing.length) hooks.failed();
                if (loaded.length) hooks.loaded(loaded);
            });
        queue = batch.catch((error: unknown) => {
            if (!options.boot) console.error('🪼 Jellyfin Enhanced: Failed to load component groups', missing, error);
            for (const id of missing) if (states[id] === 'loading') states[id] = 'ready';
        });
        return options.boot ? batch : queue;
    }

    return {
        setGroups, ensure,
        groups: (): ComponentGroups | null => groups,
        state: (id: string): 'loading' | 'ready' | undefined => states[id],
        states: (): Record<string, 'loading' | 'ready'> => ({ ...states }),
        ready: (): string[] => Object.keys(states).filter(id => states[id] === 'ready'),
        /** When a group whose last load failed entirely may be asked for again on a page change (0: at once). */
        retryAt: (id: string): number => retryAfter[id] ?? 0,
        settled: (): Promise<void> => queue
    };
}
