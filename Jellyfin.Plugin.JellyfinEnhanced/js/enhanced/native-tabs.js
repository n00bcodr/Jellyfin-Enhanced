// /js/enhanced/native-tabs.js
// Shared registry for adding self-contained tabs to the Home page's native tab
// strip, without depending on the external Custom Tabs plugin.
//
// Jellyfin's own tab mechanism (components/maintabsmanager.js + the emby-tabs
// element) is generic: a button in `.emby-tabs-slider` with `data-index="N"`
// and a `.tabContent.pageTabContent` panel at DOM position N (relative to the
// other panels) is all it takes. Jellyfin wires up the click-to-switch and
// .is-active toggling itself, the same way it does for its own Home/Favorites
// tabs (index 0/1) and the same way the Custom Tabs plugin adds its own tabs.
// This is the exact mechanism the Custom Tabs plugin uses internally, just
// run from JE's own already-injected script instead of a separate plugin.
//
// Works unmodified on Jellyfin 10.11 and on Jellyfin 12 in stable layout,
// where `.emby-tabs-slider` is part of the normal, visible header. On
// Jellyfin 12's experimental layout the tab *button* itself is invisible
// (it lives inside `.skinHeader`, which that layout hides, see
// getHeaderRightContainer in this same file for the equivalent header-button
// problem), but the tab *panel* is not inside `.skinHeader` and stays fully
// reachable: navigating to `#/home?tab=N` (Jellyfin's own deep-link
// convention, used natively for `?tab=1` = Favorites) still activates it.
//
// Sharing the Home tab strip with other plugins (Custom Tabs claims `?tab=2..`):
// - Jellyfin resolves a tab by *position*, so every tab of ours is kept at the
//   position its index names (see alignSlots), whatever else is in the strip.
// - Indices start after every index anyone else claims, and are re-derived
//   whenever the Custom Tabs list changes.
// - Our links carry a stable `jeTab=<id>` next to `tab=N`; a link whose N went
//   stale is rewritten to the current index before anything acts on it.
// - A page Custom Tabs already hosts is not added a second time.
(function (JE) {
    'use strict';

    /** Ordered list of {id, title, onMount, index}. Order determines data-index assignment. */
    var entries = [];
    var injectPending = false;
    var appliedDeepLink = null;
    /** Whether the last ensureInjected() call found us off the home page -- logged only on change. */
    var wasOffHomePage = false;

    function isOnHomePage() {
        var hash = window.location.hash;
        return hash === '' || hash === '#/home' || hash === '#/home.html'
            || hash.indexOf('#/home?') !== -1 || hash.indexOf('#/home.html?') !== -1;
    }

    /** The shared parent of all native `.tabContent.pageTabContent` panels (Home's page root). */
    function getTabsRoot() {
        // Jellyfin 10 can retain old Home pages while loading a replacement.
        // Never attach to the first cached (hidden) page just because its IDs
        // still exist in the document.
        var panels = document.querySelectorAll('.tabContent.pageTabContent[data-index="0"]');
        for (var i = panels.length - 1; i >= 0; i--) {
            var root = panels[i].parentElement;
            if (JE.helpers.isActiveTabContainer(root)) return root;
        }
        return null;
    }

    /** Last Custom Tabs list seen ({Title, ContentHtml}[]), or null before the first answer. */
    var customTabs = null;
    var customTabsSignature = null;
    var customTabsFetching = false;
    /** The tab strip the Custom Tabs list was last checked for; Jellyfin rebuilds it per Home visit. */
    var checkedSlider = null;

    /**
     * Re-read the Custom Tabs list. Runs on first use and whenever Home's tab
     * strip is rebuilt, so tabs the admin adds or removes are picked up without
     * a reload. Never waits on the Custom Tabs plugin's own script.
     */
    function refreshCustomTabs() {
        if (customTabsFetching) return;
        // Only skip on a definite "not installed": the /Plugins fallback leaves
        // the flag unset for non-admins, and Custom Tabs may still be there.
        if (JE.hasCustomTabs === false) { applyCustomTabs([]); return; }
        customTabsFetching = true;
        ApiClient.fetch({
            url: ApiClient.getUrl('CustomTabs/Config'),
            type: 'GET',
            dataType: 'json',
            headers: { accept: 'application/json' }
        }).then(function (configs) {
            return Array.isArray(configs) ? configs : [];
        }, function () {
            // Keep the last good list on a transient failure; none yet means "no tabs".
            return customTabs || [];
        }).then(function (list) {
            customTabsFetching = false;
            applyCustomTabs(list);
        });
    }

    /**
     * Store a fresh Custom Tabs list. When it differs from the last one, every
     * index of ours may be wrong (Custom Tabs owns `2..count+1`), so they are
     * dropped and re-derived on the next pass.
     * @param {Array<{Title: string, ContentHtml: string}>} list - Custom Tabs entries.
     */
    function applyCustomTabs(list) {
        var signature = list.length + '\u0000' + list.map(function (tab) {
            return tab && typeof tab.ContentHtml === 'string' ? tab.ContentHtml : '';
        }).join('\u0000');
        if (signature === customTabsSignature) return;
        var hadList = customTabs != null;
        customTabs = list;
        customTabsSignature = signature;
        if (hadList) {
            console.log('🪼 Jellyfin Enhanced: [native-tabs] Custom Tabs list changed, re-deriving tab indices');
            resetIndices();
        }
        scheduleInject();
    }

    /** Forget every assigned index; buttons are rebuilt and panels relabelled on the next pass. */
    function resetIndices() {
        entries.forEach(function (entry) {
            entry.index = null;
            entry.hostedFor = null;
            document.getElementById('je-native-tab-btn-' + entry.id)?.remove();
        });
        appliedDeepLink = null;
    }

    /**
     * Whether a Custom Tabs entry already hosts this page (e.g. a Bookmarks tab
     * left over from before the native tab was enabled). The page then keeps
     * that one tab instead of showing up twice. ContentHtml is parsed into an
     * inert template, so nothing in it runs or loads.
     * @param {object} entry - A registered tab.
     * @returns {boolean} Whether the page is already on a Custom Tab.
     */
    function isHostedByCustomTabs(entry) {
        if (!entry.hostSelector || !customTabs) return false;
        if (entry.hostedFor !== customTabs) {
            entry.hostedFor = customTabs;
            entry.hostedIndex = customTabs.findIndex(function (tab) {
                if (!tab || typeof tab.ContentHtml !== 'string' || !tab.ContentHtml) return false;
                var template = document.createElement('template');
                template.innerHTML = tab.ContentHtml;
                return !!template.content.querySelector(entry.hostSelector);
            });
            entry.hosted = entry.hostedIndex !== -1;
            if (entry.hosted) {
                console.log('🪼 Jellyfin Enhanced: [native-tabs] "' + entry.title + '" is already a Custom Tabs tab, not adding it twice');
            }
        }
        return entry.hosted;
    }

    /**
     * Next free tab index. Custom Tabs hardcodes its tabs to `i + 2` and, on
     * Jellyfin 12's modern layout, renders them as plain links with no
     * `data-index`, so scanning the strip alone cannot see them. Our reserved
     * slots are skipped: they only mirror indices someone else claims.
     */
    function nextFreeIndex(slider) {
        var max = Math.max(1, customTabs.length + 1); // native Home(0)/Favorites(1) always present
        slider.querySelectorAll('[data-index]').forEach(function (el) {
            if (el.id.indexOf(RESERVED_ID_PREFIX) === 0) return;
            var idx = parseInt(el.getAttribute('data-index'), 10);
            if (!isNaN(idx) && idx > max) max = idx;
        });
        document.querySelectorAll('a[href*="#/home?tab="], a[href*="#/home.html?tab="]').forEach(function (el) {
            var match = /[?&]tab=(\d+)/.exec(el.getAttribute('href') || '');
            var idx = match ? parseInt(match[1], 10) : NaN;
            if (!isNaN(idx) && idx > max) max = idx;
        });
        return max + 1;
    }

    var RESERVED_ID_PREFIX = 'je-native-tab-reserved-';

    /** Whether a tab button/panel was created by this module (a tab of ours or a reserved slot). */
    function isOwnSlot(el) {
        return el.id.indexOf('je-native-tab-') === 0;
    }

    function slotIndex(el) {
        return parseInt(el.getAttribute('data-index'), 10);
    }

    /**
     * Hidden, empty stand-in for a tab index another plugin claims without
     * putting anything at that position in the Home tab strip or panel list.
     * @param {string} kind - 'btn' or 'panel'.
     * @param {number} index - The claimed index.
     * @returns {HTMLElement} The placeholder element.
     */
    function createReservedSlot(kind, index) {
        var el;
        if (kind === 'btn') {
            el = document.createElement('button');
            el.type = 'button';
            el.className = 'emby-tab-button hide';
            el.tabIndex = -1;
            el.setAttribute('aria-hidden', 'true');
        } else {
            el = document.createElement('div');
            el.className = 'tabContent pageTabContent';
        }
        el.id = RESERVED_ID_PREFIX + kind + '-' + index;
        el.setAttribute('data-index', String(index));
        return el;
    }

    /**
     * Make each of our tabs sit at the position its index names. Jellyfin
     * resolves a Home tab by position, not by `data-index`: emby-tabs selects
     * `tabButtons[index]` and maintabsmanager activates the index-th
     * `.tabContent`. On the modern layout Custom Tabs claims `?tab=2..` with
     * React header links only, so every index below ours that nothing fills
     * gets a hidden placeholder. On the legacy layout Custom Tabs may append
     * its buttons after ours, so ours are moved back to the end.
     * @param {HTMLElement} container - The tab strip or the panel root.
     * @param {string} kind - 'btn' or 'panel'.
     * @param {number} lastIndex - Highest index used by one of our tabs.
     * @returns {boolean} Whether anything was added, removed or moved.
     */
    function alignSlots(container, kind, lastIndex) {
        var selector = kind === 'btn' ? '.emby-tab-button' : '.tabContent';
        var items = function () { return Array.prototype.slice.call(container.querySelectorAll(selector)); };
        var changed = false;
        var claimed = {};
        items().forEach(function (el) {
            if (!isOwnSlot(el)) claimed[slotIndex(el)] = true;
        });
        entries.forEach(function (entry) {
            if (entry.index != null) claimed[entry.index] = true;
        });

        items().forEach(function (el) {
            if (el.id.indexOf(RESERVED_ID_PREFIX) !== 0) return;
            var idx = slotIndex(el);
            if (claimed[idx] || idx >= lastIndex) {
                el.remove();
                changed = true;
            }
        });
        for (var i = 0; i < lastIndex; i++) {
            if (claimed[i]) continue;
            // A slot left behind in a cached Home page moves over, like our panels do.
            var slot = document.getElementById(RESERVED_ID_PREFIX + kind + '-' + i);
            if (slot && container.contains(slot)) continue;
            container.appendChild(slot || createReservedSlot(kind, i));
            changed = true;
        }

        var all = items();
        var ours = all.filter(isOwnSlot).sort(function (x, y) { return slotIndex(x) - slotIndex(y); });
        var tail = all.slice(all.length - ours.length);
        if (ours.some(function (el, k) { return tail[k] !== el; })) {
            ours.forEach(function (el) { container.appendChild(el); });
            changed = true;
        }
        return changed;
    }

    function ensureInjected() {
        if (entries.length === 0) return;

        if (!isOnHomePage()) {
            if (!wasOffHomePage) {
                wasOffHomePage = true;
                console.debug('🪼 Jellyfin Enhanced: [native-tabs] not on home page (hash=' + window.location.hash + '), skipping');
            }
            return;
        }
        wasOffHomePage = false;

        var slider = document.querySelector('.emby-tabs-slider');
        var root = getTabsRoot();
        if (!slider || !root) {
            console.debug('🪼 Jellyfin Enhanced: [native-tabs] waiting for DOM - .emby-tabs-slider ' +
                (slider ? 'found' : 'MISSING') + ', tab panel root ' + (root ? 'found' : 'MISSING'));
            return;
        }

        if (slider !== checkedSlider) {
            checkedSlider = slider;
            refreshCustomTabs();
        }
        // Until Custom Tabs has answered once we cannot know which indices are taken.
        if (customTabs == null) return;

        var addedTabButton = false;

        entries.forEach(function (entry) {
            if (isHostedByCustomTabs(entry)) {
                entry.index = null;
                document.getElementById('je-native-tab-btn-' + entry.id)?.remove();
                document.getElementById('je-native-tab-panel-' + entry.id)?.remove();
                return;
            }
            // Assign the index once and keep it until the Custom Tabs list
            // changes (resetIndices) -- recomputing on every pass could hand an
            // entry a different index while its button and panel still carry
            // the old one.
            if (entry.index == null) {
                entry.index = nextFreeIndex(slider);
            }

            if (!document.getElementById('je-native-tab-btn-' + entry.id)) {
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.setAttribute('is', 'emby-button');
                btn.id = 'je-native-tab-btn-' + entry.id;
                btn.className = 'emby-tab-button';
                btn.setAttribute('data-index', String(entry.index));

                var label = document.createElement('div');
                label.className = 'emby-button-foreground';
                label.textContent = entry.title;
                btn.appendChild(label);

                slider.appendChild(btn);
                window.CustomElements?.upgradeSubtree?.(slider);
                addedTabButton = true;
                console.log('🪼 Jellyfin Enhanced: [native-tabs] added tab button "' + entry.title + '" at data-index=' + entry.index);
            }

            var panel = document.getElementById('je-native-tab-panel-' + entry.id);
            if (!panel) {
                panel = document.createElement('div');
                panel.id = 'je-native-tab-panel-' + entry.id;
                panel.className = 'tabContent pageTabContent';
                panel.setAttribute('data-index', String(entry.index));
                root.appendChild(panel);
                entry.onMount(panel);
                console.log('🪼 Jellyfin Enhanced: [native-tabs] added tab panel "' + entry.title + '" at data-index=' + entry.index);
            } else if (panel.parentElement !== root) {
                panel.classList.remove('is-active');
                root.appendChild(panel);
            }
            if (panel.getAttribute('data-index') !== String(entry.index)) {
                panel.setAttribute('data-index', String(entry.index));
            }
        });

        var lastIndex = -1;
        entries.forEach(function (entry) {
            if (entry.index != null && entry.index > lastIndex) lastIndex = entry.index;
        });
        if (lastIndex >= 0) {
            if (alignSlots(slider, 'btn', lastIndex)) addedTabButton = true;
            alignSlots(root, 'panel', lastIndex);
        }

        // Read all visibilities before acting on them, so the reads share one layout
        // instead of each forcing one right after a panel mount.
        entries.forEach(function (entry) {
            var tabBtn = document.getElementById('je-native-tab-btn-' + entry.id);
            if (tabBtn) isTabButtonVisible(tabBtn, entry.id);
        });
        entries.forEach(ensureDiscoverable);

        // The tab strip's ScrollerFactory (emby-tabs.js) caches each tab's
        // width/position at init time and never watches for new children --
        // appending a button above desyncs that cache, so existing tabs
        // visually overlap the new one until something unrelated (e.g. a
        // window resize) happens to call the scroller's own refresh(). Force
        // that recompute immediately instead of leaving it to chance.
        if (addedTabButton) {
            document.querySelector('[is="emby-tabs"]')?.refresh?.();
        }

        syncDeepLink();
    }

    /**
     * Header-tray group holding every fallback link, plus a trailing `|`
     * separator between it and the random-button/active-streams group. Given
     * `order: -1`, it always renders first within the tray regardless of DOM
     * insertion order -- random button and active-streams each run their own
     * independent retry loop, so racing them on raw prepend() timing is not
     * reliable; flexbox order sidesteps the race entirely.
     */
    function getOrCreateGroup(headerRight) {
        var group = document.getElementById('je-native-tabs-group');
        if (group) return group;

        group = document.createElement('div');
        group.id = 'je-native-tabs-group';
        group.style.cssText = 'display:flex;align-items:center;order:-1;';

        var separator = document.createElement('span');
        separator.id = 'je-native-tabs-separator';
        separator.setAttribute('aria-hidden', 'true');
        separator.style.cssText = 'display:inline-block;width:1px;height:1.4em;margin:0 0.5em;background:rgba(255,255,255,0.3);';
        group.appendChild(separator);

        headerRight.appendChild(group);
        return group;
    }

    function removeGroupIfEmpty() {
        var group = document.getElementById('je-native-tabs-group');
        // Only the separator left -> nothing to separate -> drop the whole group.
        if (group && group.children.length <= 1) {
            group.remove();
        }
    }

    /**
     * On Jellyfin 12's experimental layout the tab strip button lives inside
     * `.skinHeader`, which that layout hides -- so the button exists but is
     * never visible to click. When that's detected, add a fallback entry
     * point in the header button tray (the same `.headerRight`/MUI-toolbar
     * container random-button-style features use) that deep-links to
     * `#/home?tab=N`. Skipped entirely when the real tab button is already
     * visible (old/stable layout), so that layout doesn't get a redundant
     * second way to reach the same tab.
     */
    // offsetParent forces layout; reuse a recent answer across mutation bursts.
    var visibilityCache = {};
    function isTabButtonVisible(btn, id) {
        var cached = visibilityCache[id];
        var now = Date.now();
        if (cached && cached.btn === btn && now - cached.ts < 1000) return cached.visible;
        var visible = btn.offsetParent !== null;
        visibilityCache[id] = { btn: btn, ts: now, visible: visible };
        return visible;
    }

    function ensureDiscoverable(entry) {
        var btn = document.getElementById('je-native-tab-btn-' + entry.id);
        var linkId = 'je-native-tab-link-' + entry.id;

        // No index: hosted by Custom Tabs instead, or not placed yet.
        if (entry.index == null || (btn && isTabButtonVisible(btn, entry.id))) {
            document.getElementById(linkId)?.remove();
            removeGroupIfEmpty();
            return;
        }

        if (document.getElementById(linkId)) return;

        var headerRight = JE.helpers.getHeaderButtonTray?.();
        if (!headerRight) return;
        // getHeaderButtonTray can reconnect the existing links after React
        // replaces its toolbar, so repeat the guard before creating a link.
        if (document.getElementById(linkId)) return;

        var group = getOrCreateGroup(headerRight);
        var separator = document.getElementById('je-native-tabs-separator');

        var link = document.createElement('button');
        link.id = linkId;
        link.type = 'button';
        link.setAttribute('is', 'paper-icon-button-light');
        link.className = 'headerButton headerButtonRight paper-icon-button-light';
        link.title = entry.title;
        link.innerHTML = '<i class="material-icons">' + (entry.icon || 'tab') + '</i>';
        link.addEventListener('click', function () {
            if (entry.index != null) window.location.hash = deepLinkHash(entry, entry.index);
        });

        group.insertBefore(link, separator);
        console.log('🪼 Jellyfin Enhanced: [native-tabs] tab button for "' + entry.title + '" is hidden (experimental layout), added header-tray fallback link');
    }

    var DEEP_LINK_PARAM = 'jeTab';

    /**
     * @param {string} name - Query parameter in the hash route.
     * @returns {string|null} Its decoded value, or null when absent.
     */
    function hashParam(name) {
        var match = new RegExp('[?&]' + name + '=([^&]*)').exec(window.location.hash);
        if (!match) return null;
        try { return decodeURIComponent(match[1]); } catch (e) { return match[1]; }
    }

    /** @returns {string} The current Home route (`#/home` or `#/home.html`) without its query. */
    function homeRoute() {
        var hash = window.location.hash;
        return hash.indexOf('#/home') === 0 ? hash.split('?')[0] : '#/home';
    }

    /**
     * Link to one of our tabs: `tab=N` lets Jellyfin and Custom Tabs act on it
     * natively, and `jeTab=<id>` names the page independently of N, which
     * shifts whenever other plugins' tabs come and go.
     * @param {object} entry - A registered tab.
     * @param {number} index - The tab index the page currently lives at.
     * @returns {string} The hash route for the tab.
     */
    function deepLinkHash(entry, index) {
        return homeRoute() + '?tab=' + index + '&' + DEEP_LINK_PARAM + '=' + encodeURIComponent(entry.id);
    }

    /**
     * The index a registered page lives at right now: its own native tab, or
     * the Custom Tab hosting it instead (Custom Tabs puts entry i at i + 2).
     * @param {object} entry - A registered tab.
     * @returns {number|null} The index, or null while it is not placed.
     */
    function currentIndexOf(entry) {
        if (entry.index != null) return entry.index;
        return isHostedByCustomTabs(entry) ? entry.hostedIndex + 2 : null;
    }

    /**
     * If the URL names one of our pages but its tab isn't active yet, activate
     * it. `jeTab=<id>` wins over `tab=N`: a link whose N no longer matches (a
     * saved link from before a Custom Tab was added, say) is rewritten first,
     * since Jellyfin and Custom Tabs both act on N. A bare `tab=N` (older
     * links) is honoured only when N is one of our native tabs.
     */
    function syncDeepLink() {
        var wantedId = hashParam(DEEP_LINK_PARAM);
        var urlIndex = parseInt(hashParam('tab'), 10);
        var entry = wantedId != null
            ? entries.find(function (e) { return e.id === wantedId; })
            : entries.find(function (e) { return e.index != null && e.index === urlIndex; });
        if (!entry) return;
        var wantedIndex = currentIndexOf(entry);
        if (wantedIndex == null) return;
        if (urlIndex !== wantedIndex) {
            // Rewrite in place rather than navigate: a router navigation builds
            // a new Home page, and Custom Tabs fills its legacy-layout panels
            // only once per session, so a hosting Custom Tab would come up
            // empty. Custom Tabs re-reads the URL on its next sync (it watches
            // history and the DOM); Jellyfin's selection is done below.
            history.replaceState(history.state, '', window.location.pathname + window.location.search +
                deepLinkHash(entry, wantedIndex));
        }

        // Resolve by position, exactly as Jellyfin will, and only act once the
        // button and panel there really are the wanted tab (a Custom Tab's
        // button may not exist yet; on the modern layout Custom Tabs follows
        // the URL by itself).
        var tabsElem = document.querySelector('[is="emby-tabs"]');
        var root = getTabsRoot();
        var btn = tabsElem?.querySelectorAll('.emby-tab-button')[wantedIndex];
        var panel = root?.querySelectorAll('.tabContent')[wantedIndex];
        if (!btn || !panel || slotIndex(btn) !== wantedIndex || slotIndex(panel) !== wantedIndex) return;
        var hash = window.location.hash;
        // Consume a deep link once per page/header. Reapplying it for every
        // content mutation would undo a later click on Home or Favorites.
        if (appliedDeepLink && appliedDeepLink.hash === hash && appliedDeepLink.root === root &&
            appliedDeepLink.panel === panel && appliedDeepLink.tabs === tabsElem) return;
        // A rebuilt Home page needs tabchange even if the persistent header
        // already reports this index; its new panel has not been activated.
        // Jellyfin's own attempt can also stop half way (index recorded, panel
        // shown, button never highlighted) when the button did not exist yet,
        // and then never hides that panel again.
        var strayPanels = function () {
            return Array.prototype.filter.call(root.querySelectorAll('.tabContent.is-active'),
                function (el) { return el !== panel; });
        };
        var isApplied = function () {
            return tabsElem.selectedIndex?.() === wantedIndex && panel.classList.contains('is-active') &&
                btn.classList.contains('emby-tab-button-active') && strayPanels().length === 0;
        };
        if (tabsElem.selectedIndex && !isApplied()) {
            tabsElem.selectedIndex(wantedIndex);
            strayPanels().forEach(function (el) { el.classList.remove('is-active'); });
        }
        if (isApplied()) {
            appliedDeepLink = { hash: hash, root: root, panel: panel, tabs: tabsElem };
        }
    }

    function scheduleInject() {
        if (injectPending) return;
        injectPending = true;
        JE.core.dom.afterNextPaint(function () {
            injectPending = false;
            ensureInjected();
        });
    }

    JE.nativeTabs = {
        /**
         * Register a self-contained Home-page tab. Safe to call multiple times
         * with the same id (no-op after the first).
         * @param {string} id - Stable identifier (e.g. "requests").
         * @param {string} title - Tab label.
         * @param {(panel: HTMLElement) => void} onMount - Called once with the new panel to fill it.
         * @param {string} [icon] - Material Icons ligature for the header-tray fallback link. Defaults to "tab".
         * @param {string} [hostSelector] - Selector for the page's content marker. When a Custom
         *   Tabs entry already contains it, that tab hosts the page and no native tab is added.
         */
        register: function (id, title, onMount, icon, hostSelector) {
            if (entries.some(function (e) { return e.id === id; })) return;
            entries.push({ id: id, title: title, onMount: onMount, icon: icon, hostSelector: hostSelector });
            console.log('🪼 Jellyfin Enhanced: [native-tabs] registered "' + title + '" (id=' + id + ')');
            scheduleInject();
        },
        unregister: function (id) {
            entries = entries.filter(function (e) { return e.id !== id; });
            document.getElementById('je-native-tab-btn-' + id)?.remove();
            document.getElementById('je-native-tab-panel-' + id)?.remove();
            document.getElementById('je-native-tab-link-' + id)?.remove();
            removeGroupIfEmpty();
        }
    };

    // A replacement Home root can arrive hidden and be revealed after the
    // view event. Child mutations alone miss that final class-only transition.
    JE.helpers.observeTabContainers('native-tabs', '.tabContent.pageTabContent[data-index="0"]', scheduleInject);
    // Re-inject on every navigation (hashchange, popstate AND pushState navs
    // the old raw hashchange listener missed).
    JE.core.navigation.onNavigate(function () {
        appliedDeepLink = null;
        scheduleInject();
    });
    JE.core.navigation.onViewPage(scheduleInject, { fetchItem: false });

})(window.JellyfinEnhanced);
