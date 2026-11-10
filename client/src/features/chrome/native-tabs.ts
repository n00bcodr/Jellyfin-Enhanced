import { captureIdentity, isSameIdentity, type ChromeSession, type IdentityClient, type IdentitySnapshot } from './host';

/**
 * Shared registry for self-contained tabs on the Home page's native tab strip.
 *
 * Jellyfin's tab mechanism (maintabsmanager + emby-tabs) is positional: a button in
 * `.emby-tabs-slider` with `data-index="N"` and a `.tabContent.pageTabContent` panel at
 * position N is all it takes; Jellyfin wires click-to-switch and `.is-active` itself.
 * On the 12.x modern layout the button sits inside the hidden `.skinHeader`, but the
 * panel stays reachable through `#/home?tab=N`, so a header-tray fallback link is added.
 *
 * Sharing the strip with other plugins (Custom Tabs claims `?tab=2..`) is reconciled
 * against the live page on every pass: our tabs are kept at the position their index
 * names, our indices start after every foreign claim (buttons, panels, Home deep links,
 * the Custom Tabs count), and our links carry a stable `jeTab=<id>` next to `tab=N`.
 */
export interface NativeTabEntry {
    id: string; title: string; onMount: (panel: HTMLElement) => void; icon: string | undefined; index: number | null;
}
export interface NativeTabsFacade {
    register(id: string, title: string, onMount: (panel: HTMLElement) => void, icon?: string): void;
    unregister(id: string): void;
}
export interface NativeTabsBridge {
    hasCustomTabs?: boolean;
    session?: ChromeSession;
    helpers: {
        isActiveTabContainer(element: HTMLElement): boolean;
        getHeaderButtonTray?(): HTMLElement | null;
        observeTabContainers(id: string, selector: string, callback: () => void): unknown;
    };
    core: {
        dom: { afterNextPaint(callback: () => void): unknown };
        navigation: { onNavigate(callback: () => void): unknown; onViewPage(callback: () => void, options: { fetchItem: boolean }): unknown };
    };
    nativeTabs?: NativeTabsFacade;
}
export interface NativeTabsClient extends IdentityClient {
    getUrl(path: string): string;
    fetch(request: { url: string; type: string; dataType: string; headers: Record<string, string> }): Promise<unknown>;
    getCurrentUserId(): string;
    getItems(userId: string, query: Record<string, string | number | boolean>): Promise<unknown>;
    getImageUrl(id: string, options: { type: string; tag: string; maxWidth: number; quality: number }): string;
}
/** emby-tabs custom element members used for positional selection. */
interface TabsElement extends HTMLElement {
    selectedTabIndex?: number;
    selectedIndex?(index?: number): number | undefined;
    refresh?(): void;
}
interface AppliedDeepLink { hash: string; root: HTMLElement; panel: HTMLElement; tabs: TabsElement; btn: Element | null }
interface NativeWindow extends Window { CustomElements?: { upgradeSubtree?(element: Element): void } }

const OWN_ID_PREFIX = 'je-native-tab-';
const RESERVED_ID_PREFIX = 'je-native-tab-reserved-';
const DEEP_LINK_PARAM = 'jeTab';
const LOG = '🪼 Jellyfin Enhanced: [native-tabs]';

export function isHomeHash(hash: string): boolean {
    return hash === '' || hash === '#/home' || hash === '#/home.html' || hash.includes('#/home?') || hash.includes('#/home.html?');
}
/** A hash-route query value, decoded when valid; null when absent. */
export function hashParam(hash: string, name: string): string | null {
    const match = new RegExp('[?&]' + name + '=([^&]*)').exec(hash);
    if (!match) return null;
    const raw = match[1] ?? '';
    try { return decodeURIComponent(raw); } catch { return raw; }
}
/** The current Home route (`#/home` or `#/home.html`) without its query. */
export function homeRoute(hash: string): string {
    return hash.indexOf('#/home') === 0 ? (hash.split('?')[0] ?? '#/home') : '#/home';
}
export function deepLinkHash(hash: string, index: number, id: string): string {
    return homeRoute(hash) + '?tab=' + index + '&' + DEEP_LINK_PARAM + '=' + encodeURIComponent(id);
}
/** Highest `tab=N` named by a Home deep link (Custom Tabs' only trace on the modern layout). */
export function linkedTabIndex(href: string): number | null {
    const match = /^#\/home(?:\.html)?\?(?:[^#]*&)?tab=(\d+)/.exec(href);
    return match ? parseInt(match[1] ?? '', 10) : null;
}

const isOwnSlot = (element: Element): boolean => element.id.indexOf(OWN_ID_PREFIX) === 0;
const slotIndex = (element: Element): number => parseInt(element.getAttribute('data-index') ?? '', 10);
const isTabs = (element: Element | null): element is TabsElement => element instanceof HTMLElement;

export function createNativeTabs(JE: NativeTabsBridge, readClient: () => NativeTabsClient | undefined) {
    const host: NativeWindow = window;
    let entries: NativeTabEntry[] = [];
    let injectPending = false;
    let appliedDeepLink: AppliedDeepLink | null = null;
    /** URL we just rewrote ourselves; its navigation event is not a new deep link. */
    let rewrittenHash: string | null = null;
    /** URL whose deep link the user overrode by picking another tab. */
    let userPickedHash: string | null = null;
    /** True while we select a tab ourselves. */
    let selectingTab = false;
    let watchedTabs: TabsElement | null = null;
    let lastTabStripInput = 0;
    let wasOffHomePage = false;
    /** Custom Tabs count, or null before the first answer; scoped to one identity (CHR-TABS-1). */
    let customTabCount: number | null = null;
    let customTabsFetching = false;
    let checkedSlider: Element | null = null;
    let visibilityCache: Record<string, { btn: Element; ts: number; visible: boolean }> = {};
    /** A borrowed library backdrop, valid only for the identity whose library it came from (CHR-TABS-1). */
    let backdrop: { owner: IdentitySnapshot; url: string } | null = null;
    let backdropLoading = false;
    const watchedBackgrounds = new WeakSet<Element>();
    let scope: IdentitySnapshot = captureIdentity(JE.session, readClient());

    const hash = (): string => window.location.hash;
    const ownerNow = (): IdentitySnapshot => captureIdentity(JE.session, readClient());

    /** Identity-scoped caches start over when the signed-in account or server changes. */
    function syncScope(): void {
        const now = ownerNow();
        if (isSameIdentity(scope, now)) return;
        scope = now;
        customTabCount = null;
        customTabsFetching = false;
        checkedSlider = null;
        backdrop = null;
        backdropLoading = false;
        removeBorrowedBackdrop();
    }

    function getTabsRoot(): HTMLElement | null {
        // Jellyfin can retain old Home pages while loading a replacement: never attach
        // to a cached hidden page just because its IDs still exist.
        const panels = document.querySelectorAll('.tabContent.pageTabContent[data-index="0"]');
        for (let i = panels.length - 1; i >= 0; i--) {
            const root = panels[i]?.parentElement;
            if (root && JE.helpers.isActiveTabContainer(root)) return root;
        }
        return null;
    }

    function setCustomTabCount(count: number): void {
        if (count === customTabCount) return;
        customTabCount = count;
        scheduleInject();
    }

    /**
     * Re-read the Custom Tabs count on first use and whenever Home's strip is rebuilt.
     * Only a hint for tabs that plugin has not drawn yet: a failed read cannot collide,
     * at most relabel later. Never waits on Custom Tabs' script.
     */
    function refreshCustomTabCount(): void {
        if (customTabsFetching) return;
        // Only a definite "not installed" skips: /Plugins leaves the flag unset for non-admins.
        if (JE.hasCustomTabs === false) { setCustomTabCount(0); return; }
        const client = readClient();
        if (!client) return;
        const owner = scope;
        customTabsFetching = true;
        const request = (async () => client.fetch({
            url: client.getUrl('CustomTabs/Config'), type: 'GET', dataType: 'json', headers: { accept: 'application/json' }
        }))();
        request.then(configs => Array.isArray(configs) ? configs.length : 0, () => customTabCount || 0).then(count => {
            // A reply for a previous account/server cannot place this one's tabs.
            if (owner !== scope) return;
            customTabsFetching = false;
            setCustomTabCount(count);
        });
    }

    function highestForeignIndex(slider: Element, root: Element): number {
        let max = Math.max(1, (customTabCount || 0) + 1);
        const consider = (index: number | null): void => { if (index !== null && !isNaN(index) && index > max) max = index; };
        slider.querySelectorAll('.emby-tab-button').forEach(el => { if (!isOwnSlot(el)) consider(slotIndex(el)); });
        root.querySelectorAll('.tabContent').forEach(el => { if (!isOwnSlot(el)) consider(slotIndex(el)); });
        document.querySelectorAll('a[href*="#/home?"], a[href*="#/home.html?"]').forEach(el => {
            if (el.closest(`[id^="${OWN_ID_PREFIX}"]`)) return;
            consider(linkedTabIndex(el.getAttribute('href') || ''));
        });
        return max;
    }

    /** Relabel a placed tab in place (content and listeners survive); Jellyfin's selection record follows. */
    function relabel(entry: NativeTabEntry, index: number): void {
        const previous = entry.index;
        entry.index = index;
        const btn = document.getElementById(OWN_ID_PREFIX + 'btn-' + entry.id);
        const panel = document.getElementById(OWN_ID_PREFIX + 'panel-' + entry.id);
        btn?.setAttribute('data-index', String(index));
        panel?.setAttribute('data-index', String(index));
        if (previous == null) return;
        const tabs = document.querySelector('[is="emby-tabs"]');
        if (isTabs(tabs) && btn?.classList.contains('emby-tab-button-active') && tabs.selectedTabIndex === previous) tabs.selectedTabIndex = index;
        console.log(`${LOG} "${entry.title}" moved from index ${previous} to ${index} (another tab now uses ${previous})`);
    }

    function createReservedSlot(kind: 'btn' | 'panel', index: number): HTMLElement {
        let el: HTMLElement;
        if (kind === 'btn') {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'emby-tab-button hide';
            button.tabIndex = -1;
            button.setAttribute('aria-hidden', 'true');
            el = button;
        } else {
            el = document.createElement('div');
            el.className = 'tabContent pageTabContent';
        }
        el.id = RESERVED_ID_PREFIX + kind + '-' + index;
        el.setAttribute('data-index', String(index));
        return el;
    }

    /**
     * Make positions match indices in one list. Unfilled indices below ours get a hidden
     * placeholder; placeholders something real now fills are dropped; tabs from index 2
     * up are kept in index order after Favorites. Home(0)/Favorites(1) never move.
     * Idempotent. Returns whether anything changed.
     */
    function alignSlots(container: HTMLElement, kind: 'btn' | 'panel', lastIndex: number): boolean {
        const selector = kind === 'btn' ? '.emby-tab-button' : '.tabContent';
        const items = (): Element[] => [...container.querySelectorAll(selector)].filter(el => el.parentElement === container);
        let changed = false;
        const claimed = new Set<number>();
        for (const el of items()) if (!isOwnSlot(el)) claimed.add(slotIndex(el));
        for (const entry of entries) if (entry.index != null) claimed.add(entry.index);
        for (const el of items()) {
            if (el.id.indexOf(RESERVED_ID_PREFIX) !== 0) continue;
            const index = slotIndex(el);
            if (claimed.has(index) || index >= lastIndex) { el.remove(); changed = true; }
        }
        for (let i = 2; i < lastIndex; i++) {
            if (claimed.has(i)) continue;
            // A slot left behind in a cached Home page moves over, like our panels do.
            const slot = document.getElementById(RESERVED_ID_PREFIX + kind + '-' + i);
            if (slot && slot.parentElement === container) continue;
            container.appendChild(slot || createReservedSlot(kind, i));
            changed = true;
        }
        const all = items();
        if (all.some(el => isNaN(slotIndex(el)))) return changed;
        const head = all.filter(el => slotIndex(el) < 2);
        const tabs = all.filter(el => slotIndex(el) >= 2);
        const sorted = tabs.slice().sort((x, y) => slotIndex(x) - slotIndex(y) || tabs.indexOf(x) - tabs.indexOf(y));
        let ref: Element | null = head[head.length - 1] ?? null;
        for (const el of sorted) {
            const target: Element | null = ref ? ref.nextElementSibling : container.firstElementChild;
            if (target !== el) { container.insertBefore(el, target); changed = true; }
            ref = el;
        }
        return changed;
    }

    function mount(entry: NativeTabEntry, panel: HTMLElement): void {
        try { entry.onMount(panel); }
        catch (error) { console.error(`${LOG} "${entry.title}" failed to mount:`, error); }
    }

    function ensureInjected(): void {
        if (entries.length === 0) return;
        if (!isHomeHash(hash())) {
            if (!wasOffHomePage) {
                wasOffHomePage = true;
                console.debug(`${LOG} not on home page (hash=${hash()}), skipping`);
            }
            return;
        }
        wasOffHomePage = false;
        syncScope();
        const slider = document.querySelector<HTMLElement>('.emby-tabs-slider');
        const root = getTabsRoot();
        if (!slider || !root) {
            console.debug(`${LOG} waiting for DOM - .emby-tabs-slider ${slider ? 'found' : 'MISSING'}, tab panel root ${root ? 'found' : 'MISSING'}`);
            return;
        }
        if (slider !== checkedSlider) {
            checkedSlider = slider;
            refreshCustomTabCount();
        }
        const tabsElement = slider.closest('[is="emby-tabs"]');
        watchUserTabChanges(isTabs(tabsElement) ? tabsElement : null);
        // Optional config is only a hint. Place from live foreign claims now;
        // a late count or added foreign tab triggers relabeling below.
        // A hung optional request must never block JE's own navigation.

        let addedTabButton = false;
        let nextIndex = highestForeignIndex(slider, root) + 1;
        for (const entry of entries) {
            // Contiguous from the first free index, in registration order.
            const index = nextIndex++;
            if (entry.index !== index) relabel(entry, index);
            if (!document.getElementById(OWN_ID_PREFIX + 'btn-' + entry.id)) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.setAttribute('is', 'emby-button');
                btn.id = OWN_ID_PREFIX + 'btn-' + entry.id;
                btn.className = 'emby-tab-button';
                btn.setAttribute('data-index', String(entry.index));
                const label = document.createElement('div');
                label.className = 'emby-button-foreground';
                label.textContent = entry.title;
                btn.appendChild(label);
                slider.appendChild(btn);
                host.CustomElements?.upgradeSubtree?.(slider);
                addedTabButton = true;
                console.log(`${LOG} added tab button "${entry.title}" at data-index=${entry.index}`);
            }
            const existing = document.getElementById(OWN_ID_PREFIX + 'panel-' + entry.id);
            if (!existing) {
                const panel = document.createElement('div');
                panel.id = OWN_ID_PREFIX + 'panel-' + entry.id;
                panel.className = 'tabContent pageTabContent';
                panel.setAttribute('data-index', String(entry.index));
                root.appendChild(panel);
                mount(entry, panel);
                console.log(`${LOG} added tab panel "${entry.title}" at data-index=${entry.index}`);
            } else if (existing.parentElement !== root) {
                existing.classList.remove('is-active');
                root.appendChild(existing);
            }
        }
        const lastIndex = entries[entries.length - 1]?.index ?? 0;
        if (alignSlots(slider, 'btn', lastIndex)) addedTabButton = true;
        alignSlots(root, 'panel', lastIndex);
        // Read all visibilities first so the reads share one layout.
        for (const entry of entries) {
            const btn = document.getElementById(OWN_ID_PREFIX + 'btn-' + entry.id);
            if (btn) isTabButtonVisible(btn, entry.id);
        }
        entries.forEach(ensureDiscoverable);
        // emby-tabs' scroller caches tab geometry at init; recompute after adding buttons.
        if (addedTabButton) {
            const tabs = document.querySelector('[is="emby-tabs"]');
            if (isTabs(tabs)) tabs.refresh?.();
        }
        syncDeepLink(slider, root);
    }

    /** Header-tray group of fallback links plus a trailing separator; `order: -1` renders it first. */
    function getOrCreateGroup(headerRight: HTMLElement): HTMLElement {
        const existing = document.getElementById('je-native-tabs-group');
        if (existing) return existing;
        const group = document.createElement('div');
        group.id = 'je-native-tabs-group';
        group.style.cssText = 'display:flex;align-items:center;order:-1;';
        const separator = document.createElement('span');
        separator.id = 'je-native-tabs-separator';
        separator.setAttribute('aria-hidden', 'true');
        separator.style.cssText = 'display:inline-block;width:1px;height:1.4em;margin:0 0.5em;background:rgba(255,255,255,0.3);';
        group.appendChild(separator);
        headerRight.appendChild(group);
        return group;
    }
    function removeGroupIfEmpty(): void {
        const group = document.getElementById('je-native-tabs-group');
        if (group && group.children.length <= 1) group.remove();
    }

    /** offsetParent forces layout; reuse a recent answer across mutation bursts. */
    function isTabButtonVisible(btn: HTMLElement, id: string): boolean {
        const cached = visibilityCache[id];
        const now = Date.now();
        if (cached && cached.btn === btn && now - cached.ts < 1000) return cached.visible;
        const visible = btn.offsetParent !== null;
        visibilityCache[id] = { btn, ts: now, visible };
        return visible;
    }

    /** A header-tray deep link when the strip's button is hidden (12.x modern layout); none when it is visible. */
    function ensureDiscoverable(entry: NativeTabEntry): void {
        const btn = document.getElementById(OWN_ID_PREFIX + 'btn-' + entry.id);
        const linkId = OWN_ID_PREFIX + 'link-' + entry.id;
        if (entry.index == null || (btn && isTabButtonVisible(btn, entry.id))) {
            document.getElementById(linkId)?.remove();
            removeGroupIfEmpty();
            return;
        }
        if (document.getElementById(linkId)) return;
        const headerRight = JE.helpers.getHeaderButtonTray?.();
        if (!headerRight) return;
        // getHeaderButtonTray can reconnect existing links after React replaces its toolbar.
        if (document.getElementById(linkId)) return;
        const group = getOrCreateGroup(headerRight);
        const separator = document.getElementById('je-native-tabs-separator');
        const link = document.createElement('button');
        link.id = linkId;
        link.type = 'button';
        link.setAttribute('is', 'paper-icon-button-light');
        link.className = 'headerButton headerButtonRight paper-icon-button-light';
        link.title = entry.title;
        const icon = document.createElement('i');
        icon.className = 'material-icons';
        icon.textContent = entry.icon || 'tab';
        link.appendChild(icon);
        link.addEventListener('click', () => {
            if (entry.index != null) window.location.hash = deepLinkHash(hash(), entry.index, entry.id);
        });
        group.insertBefore(link, separator);
        console.log(`${LOG} tab button for "${entry.title}" is hidden (experimental layout), added header-tray fallback link`);
    }

    /**
     * A user's own tab pick (click, key, swipe) spends the URL's deep link, even when it
     * was never fully applied. Jellyfin's own selection picks the URL's tab without input;
     * ours are flagged.
     */
    function watchUserTabChanges(tabs: TabsElement | null): void {
        if (!tabs || tabs === watchedTabs) return;
        watchedTabs = tabs;
        tabs.addEventListener('beforetabchange', event => {
            if (selectingTab) return;
            const urlIndex = parseInt(hashParam(hash(), 'tab') ?? '', 10);
            const picked = parseInt(String(event instanceof CustomEvent ? event.detail?.selectedTabIndex : undefined), 10);
            if (picked !== (isNaN(urlIndex) ? 0 : urlIndex) || Date.now() - lastTabStripInput < 1000) userPickedHash = hash();
        });
        // tabchange fires once the index is recorded; the highlight may follow in the same task.
        tabs.addEventListener('tabchange', event => {
            const picked = parseInt(String(event instanceof CustomEvent ? event.detail?.selectedTabIndex : undefined), 10);
            setTimeout(() => { clearStraySelection(tabs, picked); syncBackdrop(); }, 0);
        });
    }

    /** Jellyfin only deactivates the previous tab; keep exactly the selected button and panel active. */
    function clearStraySelection(tabs: TabsElement, index: number): void {
        const root = getTabsRoot();
        if (!root || isNaN(index) || tabs.selectedIndex?.() !== index) return;
        const btn = tabs.querySelectorAll('.emby-tab-button')[index];
        const panel = root.querySelectorAll('.tabContent')[index];
        if (!btn || !panel || slotIndex(btn) !== index || slotIndex(panel) !== index) return;
        if (!btn.classList.contains('emby-tab-button-active') || !panel.classList.contains('is-active')) return;
        root.querySelectorAll('.tabContent.is-active').forEach(el => { if (el !== panel) el.classList.remove('is-active'); });
        tabs.querySelectorAll('.emby-tab-button-active').forEach(el => { if (el !== btn) el.classList.remove('emby-tab-button-active'); });
    }

    /**
     * Finish what a `?tab=N` link asks for. `jeTab=<id>` wins over a stale `tab=N`, which
     * is rewritten in place first. Jellyfin selects N before injected buttons exist and
     * stops half way; any N >= 2 is completed once position N really is tab N.
     */
    function syncDeepLink(slider: HTMLElement, root: HTMLElement): void {
        const wantedId = hashParam(hash(), DEEP_LINK_PARAM);
        let wantedIndex = parseInt(hashParam(hash(), 'tab') ?? '', 10);
        const entry = wantedId != null ? entries.find(e => e.id === wantedId) : undefined;
        if (entry && entry.index != null && entry.index !== wantedIndex) {
            // Rewrite rather than navigate: a router navigation builds a new Home page.
            const staleHash = hash();
            // replaceState notifies JE navigation synchronously; ours clears rewrittenHash once seen.
            const freshHash = deepLinkHash(staleHash, entry.index, entry.id);
            rewrittenHash = freshHash;
            history.replaceState(history.state, '', window.location.pathname + window.location.search + freshHash);
            wantedIndex = entry.index;
            if (userPickedHash === staleHash) userPickedHash = freshHash;
            // Our tab moved after the link was already followed: only the URL needed updating.
            const ownPanel = document.getElementById(OWN_ID_PREFIX + 'panel-' + entry.id);
            if (appliedDeepLink && appliedDeepLink.hash === staleHash && appliedDeepLink.panel === ownPanel) {
                appliedDeepLink.hash = hash();
                appliedDeepLink.btn = document.getElementById(OWN_ID_PREFIX + 'btn-' + entry.id);
            }
        }
        // Home(0) and Favorites(1) exist before Jellyfin selects, so they always complete.
        if (isNaN(wantedIndex) || wantedIndex < 2) return;
        if (userPickedHash === hash()) return;
        const found = slider.closest('[is="emby-tabs"]') || document.querySelector('[is="emby-tabs"]');
        const tabs = isTabs(found) ? found : null;
        const btn = tabs?.querySelectorAll('.emby-tab-button')[wantedIndex];
        const panel = root.querySelectorAll<HTMLElement>('.tabContent')[wantedIndex];
        const select = tabs?.selectedIndex?.bind(tabs);
        if (!tabs || !select || !btn || !panel || slotIndex(btn) !== wantedIndex || slotIndex(panel) !== wantedIndex) return;
        const current = hash();
        // Consume a deep link once per page/header; reapplying it would undo a later click.
        if (appliedDeepLink && appliedDeepLink.hash === current && appliedDeepLink.root === root &&
            appliedDeepLink.panel === panel && appliedDeepLink.tabs === tabs) {
            // A different button at the position only needs its highlight finished, while
            // that tab is still selected. selectedIndex() lags a click by 120 ms.
            const stillSelected = select() === wantedIndex && panel.classList.contains('is-active') &&
                ![...tabs.querySelectorAll('.emby-tab-button-active')].some(el => el !== btn);
            if (appliedDeepLink.btn === btn || !stillSelected) {
                appliedDeepLink.btn = btn;
                return;
            }
        }
        // Jellyfin's same-index path leaves the old highlight and panel; a second highlight
        // would make the next click on it a no-op.
        const strays = (): Element[] => [...root.querySelectorAll('.tabContent.is-active')].filter(el => el !== panel)
            .concat([...tabs.querySelectorAll('.emby-tab-button-active')].filter(el => el !== btn));
        const isApplied = (): boolean => select() === wantedIndex && panel.classList.contains('is-active') &&
            btn.classList.contains('emby-tab-button-active') && strays().length === 0;
        if (!isApplied()) {
            selectingTab = true;
            try { select(wantedIndex); }
            finally { selectingTab = false; }
            strays().forEach(el => el.classList.remove('is-active', 'emby-tab-button-active'));
        }
        if (isApplied()) appliedDeepLink = { hash: current, root, panel, tabs, btn };
    }

    function removeBorrowedBackdrop(): void {
        const bg = document.querySelector('.backgroundContainer');
        const holder = document.querySelector('.backdropContainer');
        const mine = holder?.querySelector('.je-backdrop');
        if (!bg || !holder || !mine) return;
        mine.remove();
        // Only drop the class if no Jellyfin backdrop took over meanwhile.
        const other = [...holder.querySelectorAll<HTMLElement>('.backdropImage')].some(el => el.style.backgroundImage);
        if (!other) bg.classList.remove('withBackdrop');
    }

    /**
     * Jellyfin only paints a backdrop for tabs it knows. While one of our pages is the
     * active tab, borrow a random library backdrop of the signed-in user; take it away
     * once it no longer is.
     */
    function syncBackdrop(): void {
        const bg = document.querySelector('.backgroundContainer');
        const holder = document.querySelector('.backdropContainer');
        if (!bg || !holder) return;
        syncScope();
        const onOurPage = !!document.querySelector('#indexPage .tabContent.is-active :is(.jellyfinenhanced, .sections.bookmarks)');
        if (!onOurPage || !isHomeHash(hash())) { removeBorrowedBackdrop(); return; }
        // Jellyfin clears the backdrop on every tab change, so withBackdrop says whether it shows.
        if (!watchedBackgrounds.has(bg)) {
            watchedBackgrounds.add(bg);
            new MutationObserver(syncBackdrop).observe(bg, { attributes: true, attributeFilter: ['class'] });
        }
        if (bg.classList.contains('withBackdrop')) return;
        const borrowed = backdrop;
        if (borrowed && isSameIdentity(borrowed.owner, scope)) {
            holder.querySelector('.je-backdrop')?.remove();
            const el = document.createElement('div');
            el.className = 'backdropImage displayingBackdropImage je-backdrop';
            // displayingBackdropImage's z-index would lift it over the page's dimming overlay.
            el.style.zIndex = 'auto';
            el.style.backgroundImage = `url("${borrowed.url}")`;
            holder.appendChild(el);
            bg.classList.add('withBackdrop');
            return;
        }
        if (backdropLoading) return;
        const client = readClient();
        if (!client) return;
        const owner = scope;
        backdropLoading = true;
        const finish = (): void => { if (owner === scope) backdropLoading = false; };
        (async () => client.getItems(client.getCurrentUserId(), {
            SortBy: 'Random', Limit: 1, Recursive: true, IncludeItemTypes: 'Movie,Series', ImageTypes: 'Backdrop'
        }))().then(response => {
            // Another account's library must never decorate this one's page.
            if (owner !== scope || !isSameIdentity(owner, ownerNow())) return;
            const items = typeof response === 'object' && response !== null && 'Items' in response ? response.Items : null;
            const item: unknown = Array.isArray(items) ? items[0] : null;
            if (typeof item !== 'object' || item === null || !('Id' in item) || typeof item.Id !== 'string') return;
            const tags = 'BackdropImageTags' in item ? item.BackdropImageTags : null;
            const tag: unknown = Array.isArray(tags) ? tags[0] : null;
            if (typeof tag !== 'string' || !tag) return;
            backdrop = { owner, url: client.getImageUrl(item.Id, { type: 'Backdrop', tag, maxWidth: 1920, quality: 70 }) };
            finish();
            syncBackdrop();
        }).catch(() => { /* a backdrop is decoration only */ }).then(finish);
    }

    function scheduleInject(): void {
        if (injectPending) return;
        injectPending = true;
        JE.core.dom.afterNextPaint(() => {
            injectPending = false;
            ensureInjected();
            syncBackdrop();
        });
    }

    const facade: NativeTabsFacade = {
        /** Register a self-contained Home tab. Repeated registration of an id is a no-op. */
        register(id, title, onMount, icon) {
            if (entries.some(e => e.id === id)) return;
            entries.push({ id, title, onMount, icon, index: null });
            console.log(`${LOG} registered "${title}" (id=${id})`);
            scheduleInject();
        },
        unregister(id) {
            entries = entries.filter(e => e.id !== id);
            delete visibilityCache[id];
            document.getElementById(OWN_ID_PREFIX + 'btn-' + id)?.remove();
            document.getElementById(OWN_ID_PREFIX + 'panel-' + id)?.remove();
            document.getElementById(OWN_ID_PREFIX + 'link-' + id)?.remove();
            removeGroupIfEmpty();
        }
    };

    function noteTabStripInput(event: Event): void {
        if (event.isTrusted && event.target instanceof Element && event.target.closest('[is="emby-tabs"]')) lastTabStripInput = Date.now();
    }

    function start(): void {
        document.addEventListener('pointerdown', noteTabStripInput, { capture: true, passive: true });
        document.addEventListener('keydown', noteTabStripInput, { capture: true, passive: true });
        // A replacement Home root can arrive hidden and be revealed after the view event.
        JE.helpers.observeTabContainers('native-tabs', '.tabContent.pageTabContent[data-index="0"]', scheduleInject);
        // Every navigation (hashchange, popstate and pushState).
        JE.core.navigation.onNavigate(() => {
            if (hash() !== rewrittenHash) {
                appliedDeepLink = null;
                userPickedHash = null;
            }
            rewrittenHash = null;
            scheduleInject();
        });
        JE.core.navigation.onViewPage(scheduleInject, { fetchItem: false });
        JE.session?.onUserChange('native-tabs', () => {
            appliedDeepLink = null;
            userPickedHash = null;
            visibilityCache = {};
            syncScope();
            scheduleInject();
        });
    }

    return { facade, start };
}
