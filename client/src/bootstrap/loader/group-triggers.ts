import type { LoaderNamespace } from '../../host/bootstrap-pages-host';
import type { ComponentGroupLoader } from '../../host/component-groups-host';
import { FEATURE_INITIALIZERS, initializeGroupFeatures, lazyGroupOf, readExport } from './features';
import { CORE_GROUP, createGroupLoader } from './group-loader';
import { createGroupRules, FEATURE_PAGES, markerSelector } from './group-rules';
import { isRecord } from './keys';

/** The first <video> event that says playback is starting; none of them bubbles, so they are captured. */
const VIDEO_EVENTS = ['loadstart', 'play', 'playing'] as const;

export type ComponentGroupsRuntime = ReturnType<typeof createComponentGroups>;

/**
 * The component groups of this page load: what is loaded (group-loader.ts), what is needed
 * (group-rules.ts), and what makes the loader ask again. Publishes `JE.loader`.
 */
export function createComponentGroups(JE: LoaderNamespace) {
    const rules = createGroupRules(JE);
    /** A JE.currentSettings object -> the groups whose stage-6 initializers ran with it (settings are replaced on a user switch). */
    const startedWith = new WeakMap<object, Set<string>>();
    let retryTimer = 0;

    const loader = createGroupLoader({
        companions: id => rules.companions(id),
        afterCore: registerPageTabs,
        loaded(ids) {
            startFeatures(ids);
            nudgeObservers();
        },
        failed: scheduleRetry
    });
    const isGroup = (id: string): boolean => !!loader.groups()?.byId[id];
    /** The groups the current page, config and user need right now. */
    const neededGroups = (): string[] => rules.needed(loader.groups()?.order ?? []);

    /** Stage 6 for groups whose modules have just run. */
    function startFeatures(ids: readonly string[]): void {
        const settings = JE.currentSettings;
        if (settings) {
            const started = startedWith.get(settings) ?? new Set<string>();
            for (const id of ids) started.add(id);
            startedWith.set(settings, started);
        }
        initializeGroupFeatures(JE, ids, isGroup);
    }

    /**
     * Register JE's own Home tabs for the pages delivered that way, in FEATURE_PAGES order, right after
     * "core" has run: a tab has to be in the tab strip from the first Home render, while its page loads
     * only when the tab is shown. Each page's custom-tab module registers the same tab when it loads;
     * the registry keeps the first registration of an id.
     */
    function registerPageTabs(): void {
        const config = JE.pluginConfig || {};
        if (typeof JE.nativeTabs?.register !== 'function') return;
        for (const page of FEATURE_PAGES) {
            if (!config[page.flag] || !config[`${page.delivery}UseNativeTab`]) continue;
            const [id, titleKey, fallbackTitle, icon] = page.tab;
            const title = titleKey ? (JE.t(titleKey) || fallbackTitle) : fallbackTitle;
            JE.nativeTabs.register(id, title ?? '', panel => {
                const marker = document.createElement('div');
                marker.className = page.marker;
                panel.appendChild(marker);
            }, icon);
        }
    }

    /**
     * Give the features of groups that loaded after the page was drawn the DOM change they wait for.
     * Many features start their work from the shared body observer and, started at boot, are woken by
     * the page still filling in; started later, on a page that has already settled, nothing would wake
     * them until the user did something. An empty hidden element added to the body and removed again is
     * that wake-up, and changes nothing else.
     */
    function nudgeObservers(): void {
        if (!document.body) return;
        const marker = document.createElement('span');
        marker.hidden = true;
        document.body.appendChild(marker);
        marker.remove();
    }

    /**
     * Load whatever the current page, config and user need and do not have yet. Called on every
     * navigation, when a Home tab or a video appears and after a user switch; cheap when nothing is
     * missing.
     */
    function loadNeeded(): Promise<void> {
        const now = Date.now();
        // A group whose files could not be fetched at all is asked for again after a pause, not on every
        // page change in between (scheduleRetry).
        const due = neededGroups().filter(id => loader.state(id) || loader.retryAt(id) <= now);
        // Paced like boot: the modules of a page the user has just gone to run in the gaps jellyfin-web
        // leaves while it draws that page.
        const loading = loader.ensure(due, { pace: 'background' });
        scheduleRetry();
        return loading;
    }

    /**
     * Arrange for the groups whose last load failed entirely to be asked for again when their pause is
     * over, without waiting for another trigger. The retry asks only for what the page still needs; if
     * that fails too, the batch schedules the next one, with a longer pause.
     */
    function scheduleRetry(): void {
        if (retryTimer) return;
        const now = Date.now();
        // Only groups the page still needs and that are not being loaded right now.
        const waiting = neededGroups().filter(id => !loader.state(id) && loader.retryAt(id) > now).map(id => loader.retryAt(id));
        if (!waiting.length) return;
        retryTimer = window.setTimeout(() => {
            retryTimer = 0;
            void loadNeeded();
        }, Math.max(0, Math.min(...waiting) - Date.now()) + 50);
    }

    /**
     * Give every `exports` function of a group that is not loaded a stand-in that loads the group and
     * then makes the same call, so a caller anywhere (a shortcut, a header button, another feature) needs
     * no knowledge of groups. The group's module replaces the stand-in when it runs. A stand-in returns a
     * promise for the real call's result, so it only suits calls whose result the caller does not use at
     * once.
     */
    function installLazyExports(): void {
        for (const [id, rule] of Object.entries(rules.FEATURE_GROUPS)) {
            if (!rule.exports || !isGroup(id) || loader.state(id)) continue;
            for (const path of rule.exports) {
                // A dotted export sits on a namespace its module creates; until then an empty one holds the
                // stand-in (the module replaces it).
                const parts = path.split('.');
                const name = parts.pop() ?? '';
                let owner: object = JE;
                for (const part of parts) {
                    let next: unknown = Reflect.get(owner, part);
                    if (next === undefined || next === null) Reflect.set(owner, part, next = {});
                    if (!isRecord(next) && typeof next !== 'function') break;
                    owner = next;
                }
                if (Reflect.get(owner, name) !== undefined) continue;
                const standIn = Object.assign(function (...args: unknown[]): Promise<unknown> {
                    return loader.ensure([id]).then(() => {
                        const real = readExport(JE, path);
                        if (typeof real.value === 'function' && real.value !== standIn) return Reflect.apply(real.value, real.owner, args);
                        console.error(`🪼 Jellyfin Enhanced: '${path}' is not available (component group '${id}' did not load).`);
                        return undefined;
                    });
                }, { jeLazyGroup: id });
                Reflect.set(owner, name, standIn);
            }
        }
    }

    /**
     * Start loading groups on demand once the boot groups' features have started, and load at once
     * whatever the page needs beyond them:
     *  - on every navigation (JE's own deduplicated navigation hook, which fires as soon as the address
     *    changes, before the new view is shown);
     *  - when a Home tab holding the placeholder of a page that is not loaded becomes the active one (tab
     *    switches do not always change the address);
     *  - when a <video> starts loading or playing (playback can begin before the address changes to the
     *    video page);
     *  - when a switched-in user's data has loaded (done by its own caller).
     * Resolves when the groups needed right now have loaded.
     */
    function watchTriggers(): Promise<void> {
        const onNavigate = JE.core.navigation?.onNavigate;
        if (typeof onNavigate === 'function') onNavigate(() => { void loadNeeded(); });
        else window.addEventListener('hashchange', () => { void loadNeeded(); });

        const config = JE.pluginConfig || {};
        const tabbed = FEATURE_PAGES.filter(page => isGroup(page.group) && config[page.flag] && rules.isTabbedPage(page));
        if (tabbed.length && typeof JE.helpers?.observeTabContainers === 'function') {
            const watcher = JE.helpers.observeTabContainers('je-component-groups', tabbed.map(markerSelector).join(', '), () => {
                if (tabbed.every(page => loader.state(page.group))) watcher?.teardown();
                else void loadNeeded();
            });
        }

        if (isGroup('player') && !loader.state('player')) {
            const onVideo = (event: Event): void => {
                if (!(event.target instanceof Node) || event.target.nodeName !== 'VIDEO') return;
                rules.sawVideo();
                for (const type of VIDEO_EVENTS) document.removeEventListener(type, onVideo, true);
                void loadNeeded();
            };
            for (const type of VIDEO_EVENTS) document.addEventListener(type, onVideo, true);
        }

        return loadNeeded(); // What the resolved settings and the current address add.
    }

    /**
     * `ensure(ids, { pace })` loads groups (resolves when they have run and their features are initialized;
     * `pace` as in group-loader.ts `ensure`, 'now' unless given: a caller whose work can wait for the page asks with 'boot'),
     * `state()` reports each group asked for so far ('loading' or 'ready'), `needed()` lists what the
     * current page needs, `settled()` resolves when nothing is loading, and `catalog()` describes the
     * rules as data (tests check them against the groups file).
     */
    const api: ComponentGroupLoader = {
        ensure: (ids, options) => loader.ensure(typeof ids === 'string' ? [ids] : ids, options?.pace ? { pace: options.pace } : {}),
        state: () => loader.states(),
        needed: () => neededGroups(),
        settled: () => loader.settled(),
        catalog: () => ({
            groups: Object.entries(rules.FEATURE_GROUPS).map(([id, rule]) => ({ id, exports: [...(rule.exports ?? [])] })),
            initializers: FEATURE_INITIALIZERS.map(([group, path]) => ({ group, path })),
            pages: FEATURE_PAGES.map(page => ({ group: page.group, flag: page.flag, delivery: page.delivery, tab: [...page.tab], marker: page.marker }))
        })
    };
    JE.loader = api;

    return {
        setGroups: loader.setGroups,
        /** Stage 3: the groups this page needs, as one request made and run in idle time. Rejects when nothing can be loaded. */
        loadBootGroups: (): Promise<void> => loader.ensure(neededGroups(), { pace: 'boot', boot: true }),
        /** Stage 6 for every group loaded so far; groups loaded later run their own entries right after their modules. */
        startLoadedFeatures: (): void => { startFeatures(loader.ready()); },
        installLazyExports, watchTriggers, loadNeeded,
        /** Whether a group's stage 6 last ran with exactly these settings (it has only just started for this user). */
        startedWith: (id: string, settings: object | undefined): boolean => !!settings && isGroup(id) && id !== CORE_GROUP && !!startedWith.get(settings)?.has(id)
    };
}
