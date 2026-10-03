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
// Sharing the Home tab strip with other plugins (Custom Tabs claims `?tab=2..`)
// is reconciled against the live page on every pass, never cached:
// - Jellyfin resolves a tab by *position* (emby-tabs selects `tabButtons[N]`,
//   maintabsmanager activates the N-th `.tabContent`), so each tab of ours is
//   kept at the position its index names (alignSlots).
// - Our indices start after every index anything else occupies: buttons,
//   panels, `#/home?tab=N` header links, plus the Custom Tabs count, which
//   covers tabs that plugin has not drawn yet. A claim that shows up later
//   relabels our tabs instead of colliding with them (relabel).
// - Our links carry a stable `jeTab=<id>` next to `tab=N`; a link whose N went
//   stale is rewritten to the current index before anything acts on it.
(function (JE) {
    'use strict';

    /** Ordered list of {id, title, onMount, icon, index}. Order determines index assignment. */
    var entries = [];
    var injectPending = false;
    var appliedDeepLink = null;
    /** URL we just rewrote ourselves; its navigation event is not a new deep link. */
    var rewrittenHash = null;
    /** Whether the last ensureInjected() call found us off the home page -- logged only on change. */
    var wasOffHomePage = false;

    var OWN_ID_PREFIX = 'je-native-tab-';
    var RESERVED_ID_PREFIX = 'je-native-tab-reserved-';
    var DEEP_LINK_PARAM = 'jeTab';

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

    /** Whether a tab button/panel was created by this module (a tab of ours or a reserved slot). */
    function isOwnSlot(el) {
        return el.id.indexOf(OWN_ID_PREFIX) === 0;
    }

    function slotIndex(el) {
        return parseInt(el.getAttribute('data-index'), 10);
    }

    /** Number of Custom Tabs entries, or null before the first answer. */
    var customTabCount = null;
    var customTabsFetching = false;
    /** The tab strip the Custom Tabs count was last read for; Jellyfin rebuilds it per Home visit. */
    var checkedSlider = null;

    /**
     * Re-read the Custom Tabs count, on first use and whenever Home's tab strip
     * is rebuilt. It is only a hint for tabs that plugin has not drawn yet; the
     * page itself stays the source of truth, so a failed read cannot cause a
     * collision, at most a later relabel. Never waits on Custom Tabs' script.
     */
    function refreshCustomTabCount() {
        if (customTabsFetching) return;
        // Only skip on a definite "not installed": the /Plugins fallback leaves
        // the flag unset for non-admins, and Custom Tabs may still be there.
        if (JE.hasCustomTabs === false) { setCustomTabCount(0); return; }
        customTabsFetching = true;
        ApiClient.fetch({
            url: ApiClient.getUrl('CustomTabs/Config'),
            type: 'GET',
            dataType: 'json',
            headers: { accept: 'application/json' }
        }).then(function (configs) {
            return Array.isArray(configs) ? configs.length : 0;
        }, function () {
            return customTabCount || 0;
        }).then(function (count) {
            customTabsFetching = false;
            setCustomTabCount(count);
        });
    }

    function setCustomTabCount(count) {
        if (count === customTabCount) return;
        customTabCount = count;
        scheduleInject();
    }

    /**
     * Highest tab index anything other than us occupies on this Home page:
     * buttons in the strip, panels under the root, Home deep links in the
     * header (Custom Tabs' only trace on the modern layout), and the indices
     * Custom Tabs will take (`2..count+1`). Home(0)/Favorites(1) always count.
     * @param {HTMLElement} slider - The tab strip.
     * @param {HTMLElement} root - The panel root.
     * @returns {number} The highest foreign index.
     */
    function highestForeignIndex(slider, root) {
        var max = Math.max(1, (customTabCount || 0) + 1);
        var consider = function (idx) { if (!isNaN(idx) && idx > max) max = idx; };
        Array.prototype.forEach.call(slider.querySelectorAll('.emby-tab-button'), function (el) {
            if (!isOwnSlot(el)) consider(slotIndex(el));
        });
        Array.prototype.forEach.call(root.querySelectorAll('.tabContent'), function (el) {
            if (!isOwnSlot(el)) consider(slotIndex(el));
        });
        document.querySelectorAll('a[href*="#/home?"], a[href*="#/home.html?"]').forEach(function (el) {
            if (el.closest('[id^="' + OWN_ID_PREFIX + '"]')) return;
            var match = /^#\/home(?:\.html)?\?(?:[^#]*&)?tab=(\d+)/.exec(el.getAttribute('href') || '');
            if (match) consider(parseInt(match[1], 10));
        });
        return max;
    }

    /**
     * Move a placed tab to a new index: its button and panel are relabelled in
     * place (content and listeners survive), and if it is the selected tab,
     * Jellyfin's record of the selection follows so the next click still
     * deselects it correctly.
     * @param {object} entry - A registered tab.
     * @param {number} index - Its new index.
     */
    function relabel(entry, index) {
        var previous = entry.index;
        entry.index = index;
        var btn = document.getElementById(OWN_ID_PREFIX + 'btn-' + entry.id);
        var panel = document.getElementById(OWN_ID_PREFIX + 'panel-' + entry.id);
        btn?.setAttribute('data-index', String(index));
        panel?.setAttribute('data-index', String(index));
        if (previous == null) return;
        var tabsElem = document.querySelector('[is="emby-tabs"]');
        if (tabsElem && btn?.classList.contains('emby-tab-button-active') && tabsElem.selectedTabIndex === previous) {
            tabsElem.selectedTabIndex = index;
        }
        console.log('🪼 Jellyfin Enhanced: [native-tabs] "' + entry.title + '" moved from index ' + previous +
            ' to ' + index + ' (another tab now uses ' + previous + ')');
    }

    /**
     * Hidden, empty stand-in for a tab index something else claims without
     * putting anything at that position in this list (Custom Tabs on the modern
     * layout only adds header links).
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
     * Make positions match indices in one list (the tab strip's buttons, or the
     * root's panels). Every index below ours that nothing fills gets a hidden
     * placeholder, placeholders something real now fills are dropped, and the
     * tabs from index 2 up are kept in index order right after Favorites --
     * other plugins' too: Custom Tabs on the legacy layout appends its buttons
     * after ours, and inserts a panel added mid-session straight after
     * Favorites. Only out-of-place elements move, never Jellyfin's Home(0) and
     * Favorites(1). Idempotent: a second call on an aligned list changes nothing.
     * @param {HTMLElement} container - The tab strip or the panel root.
     * @param {string} kind - 'btn' or 'panel'.
     * @param {number} lastIndex - Highest index used by one of our tabs.
     * @returns {boolean} Whether anything was added, removed or moved.
     */
    function alignSlots(container, kind, lastIndex) {
        var selector = kind === 'btn' ? '.emby-tab-button' : '.tabContent';
        var items = function () {
            return Array.prototype.filter.call(container.querySelectorAll(selector),
                function (el) { return el.parentElement === container; });
        };
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
        for (var i = 2; i < lastIndex; i++) {
            if (claimed[i]) continue;
            // A slot left behind in a cached Home page moves over, like our panels do.
            var slot = document.getElementById(RESERVED_ID_PREFIX + kind + '-' + i);
            if (slot && slot.parentElement === container) continue;
            container.appendChild(slot || createReservedSlot(kind, i));
            changed = true;
        }

        var all = items();
        // Something without a numeric index cannot be placed; leave the order alone.
        if (all.some(function (el) { return isNaN(slotIndex(el)); })) return changed;
        var head = all.filter(function (el) { return slotIndex(el) < 2; });
        var tabs = all.filter(function (el) { return slotIndex(el) >= 2; });
        var sorted = tabs.slice().sort(function (x, y) {
            return slotIndex(x) - slotIndex(y) || tabs.indexOf(x) - tabs.indexOf(y);
        });
        var ref = head.length ? head[head.length - 1] : null;
        sorted.forEach(function (el) {
            var target = ref ? ref.nextElementSibling : container.firstElementChild;
            if (target !== el) {
                container.insertBefore(el, target);
                changed = true;
            }
            ref = el;
        });
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
            refreshCustomTabCount();
        }
        // Until Custom Tabs has answered once, tabs it has not drawn yet are invisible to us.
        if (customTabCount == null) return;

        var addedTabButton = false;
        var nextIndex = highestForeignIndex(slider, root) + 1;

        entries.forEach(function (entry) {
            // Contiguous from the first free index, in registration order. The
            // same answer every pass unless another plugin's claims changed.
            var index = nextIndex++;
            if (entry.index !== index) relabel(entry, index);

            if (!document.getElementById(OWN_ID_PREFIX + 'btn-' + entry.id)) {
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.setAttribute('is', 'emby-button');
                btn.id = OWN_ID_PREFIX + 'btn-' + entry.id;
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

            var panel = document.getElementById(OWN_ID_PREFIX + 'panel-' + entry.id);
            if (!panel) {
                panel = document.createElement('div');
                panel.id = OWN_ID_PREFIX + 'panel-' + entry.id;
                panel.className = 'tabContent pageTabContent';
                panel.setAttribute('data-index', String(entry.index));
                root.appendChild(panel);
                entry.onMount(panel);
                console.log('🪼 Jellyfin Enhanced: [native-tabs] added tab panel "' + entry.title + '" at data-index=' + entry.index);
            } else if (panel.parentElement !== root) {
                panel.classList.remove('is-active');
                root.appendChild(panel);
            }
        });

        var lastIndex = entries[entries.length - 1].index;
        if (alignSlots(slider, 'btn', lastIndex)) addedTabButton = true;
        alignSlots(root, 'panel', lastIndex);

        // Read all visibilities before acting on them, so the reads share one layout
        // instead of each forcing one right after a panel mount.
        entries.forEach(function (entry) {
            var tabBtn = document.getElementById(OWN_ID_PREFIX + 'btn-' + entry.id);
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

        syncDeepLink(slider, root);
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

        // No index yet: not placed, nothing to link to.
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
            if (entry.index != null) window.location.hash = deepLinkHash(entry);
        });

        group.insertBefore(link, separator);
        console.log('🪼 Jellyfin Enhanced: [native-tabs] tab button for "' + entry.title + '" is hidden (experimental layout), added header-tray fallback link');
    }

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
     * @param {object} entry - A placed tab.
     * @returns {string} The hash route for the tab.
     */
    function deepLinkHash(entry) {
        return homeRoute() + '?tab=' + entry.index + '&' + DEEP_LINK_PARAM + '=' + encodeURIComponent(entry.id);
    }

    /**
     * Finish what a `?tab=N` link asks for. `jeTab=<id>` wins over `tab=N`: a
     * link whose N no longer matches (saved before a Custom Tab was added, say)
     * is rewritten first, since Jellyfin and Custom Tabs both act on N.
     *
     * Jellyfin selects N as soon as Home renders, before injected buttons
     * exist, and stops half way (index recorded, panel maybe shown, button
     * never highlighted, the previous panel never hidden). That applies to
     * Custom Tabs' tabs as much as ours, so any N >= 2 is completed here once
     * the button and panel at position N really are tab N.
     * @param {HTMLElement} slider - The tab strip.
     * @param {HTMLElement} root - The panel root.
     */
    function syncDeepLink(slider, root) {
        var wantedId = hashParam(DEEP_LINK_PARAM);
        var wantedIndex = parseInt(hashParam('tab'), 10);
        var entry = wantedId != null ? entries.find(function (e) { return e.id === wantedId; }) : null;
        if (entry && entry.index != null && entry.index !== wantedIndex) {
            // Rewrite in place rather than navigate: a router navigation builds
            // a new Home page, and Custom Tabs fills its legacy-layout panels
            // only once per session. Custom Tabs re-reads the URL on its next
            // sync (it watches history and the DOM).
            var staleHash = window.location.hash;
            rewrittenHash = deepLinkHash(entry);
            history.replaceState(history.state, '', window.location.pathname + window.location.search + rewrittenHash);
            wantedIndex = entry.index;
            // Our tab moved after this link was already followed: only the URL
            // needed updating. Re-selecting it would undo whatever the user
            // clicked since (tab clicks leave the URL alone).
            if (appliedDeepLink && appliedDeepLink.hash === staleHash &&
                appliedDeepLink.panel === document.getElementById(OWN_ID_PREFIX + 'panel-' + entry.id)) {
                appliedDeepLink.hash = window.location.hash;
                appliedDeepLink.btn = document.getElementById(OWN_ID_PREFIX + 'btn-' + entry.id);
            }
        }
        // Home(0) and Favorites(1) exist before Jellyfin selects, so they always complete.
        if (isNaN(wantedIndex) || wantedIndex < 2) return;

        var tabsElem = slider.closest('[is="emby-tabs"]') || document.querySelector('[is="emby-tabs"]');
        var btn = tabsElem?.querySelectorAll('.emby-tab-button')[wantedIndex];
        var panel = root.querySelectorAll('.tabContent')[wantedIndex];
        if (!tabsElem?.selectedIndex || !btn || !panel ||
            slotIndex(btn) !== wantedIndex || slotIndex(panel) !== wantedIndex) return;
        var hash = window.location.hash;
        // Consume a deep link once per page/header. Reapplying it for every
        // content mutation would undo a later click on Home or Favorites.
        if (appliedDeepLink && appliedDeepLink.hash === hash && appliedDeepLink.root === root &&
            appliedDeepLink.panel === panel && appliedDeepLink.tabs === tabsElem) {
            // A different button at that position (Custom Tabs' real one
            // replacing our placeholder) only needs its highlight finished --
            // and only while that tab is still the selected one. Once the
            // user picked another tab, the link stays consumed.
            if (appliedDeepLink.btn === btn || tabsElem.selectedIndex() !== wantedIndex) {
                appliedDeepLink.btn = btn;
                return;
            }
        }
        // Jellyfin's same-index path highlights the new button without
        // clearing the old one, and never hides the previous panel; a second
        // highlighted button would make the next click on it a no-op.
        var strays = function () {
            return Array.prototype.filter.call(root.querySelectorAll('.tabContent.is-active'),
                function (el) { return el !== panel; }).concat(Array.prototype.filter.call(
                tabsElem.querySelectorAll('.emby-tab-button-active'), function (el) { return el !== btn; }));
        };
        var isApplied = function () {
            return tabsElem.selectedIndex() === wantedIndex && panel.classList.contains('is-active') &&
                btn.classList.contains('emby-tab-button-active') && strays().length === 0;
        };
        if (!isApplied()) {
            tabsElem.selectedIndex(wantedIndex);
            strays().forEach(function (el) { el.classList.remove('is-active', 'emby-tab-button-active'); });
        }
        if (isApplied()) {
            appliedDeepLink = { hash: hash, root: root, panel: panel, tabs: tabsElem, btn: btn };
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
         */
        register: function (id, title, onMount, icon) {
            if (entries.some(function (e) { return e.id === id; })) return;
            entries.push({ id: id, title: title, onMount: onMount, icon: icon });
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
        if (window.location.hash !== rewrittenHash) appliedDeepLink = null;
        rewrittenHash = null;
        scheduleInject();
    });
    JE.core.navigation.onViewPage(scheduleInject, { fetchItem: false });

})(window.JellyfinEnhanced);
