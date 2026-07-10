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
(function (JE) {
    'use strict';

    /** Ordered list of {id, title, onMount, index}. Order determines data-index assignment. */
    var entries = [];
    var injectPending = false;
    /** Whether the last ensureInjected() call found us off the home page -- logged only on change. */
    var wasOffHomePage = false;

    function isOnHomePage() {
        var hash = window.location.hash;
        return hash === '' || hash === '#/home' || hash === '#/home.html'
            || hash.indexOf('#/home?') !== -1 || hash.indexOf('#/home.html?') !== -1;
    }

    /** The shared parent of all native `.tabContent.pageTabContent` panels (Home's page root). */
    function getTabsRoot() {
        var nativePanel = document.querySelector('.tabContent.pageTabContent[data-index="0"]');
        return nativePanel ? nativePanel.parentElement : null;
    }

    /**
     * Highest `data-index` currently in use on the tab strip, plus 1. Scanning
     * live rather than assuming "native tabs are 0/1, ours start at 2" matters
     * because the external Custom Tabs plugin claims indices the exact same
     * way (`i + 2`, with no collision checking of its own either) -- if a user
     * runs both, blindly assuming an index is free would clash with it.
     */
    function nextFreeIndex(slider) {
        var max = 1; // native Home(0)/Favorites(1) always present
        slider.querySelectorAll('[data-index]').forEach(function (el) {
            var idx = parseInt(el.getAttribute('data-index'), 10);
            if (!isNaN(idx) && idx > max) max = idx;
        });
        return max + 1;
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

        entries.forEach(function (entry) {
            // Assign the index once and cache it -- recomputing on every pass
            // could hand an entry a *different* index later (if something else's
            // tabs come and go), which would desync its already-created button
            // from its already-created panel.
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
                console.log('🪼 Jellyfin Enhanced: [native-tabs] added tab button "' + entry.title + '" at data-index=' + entry.index);
            }

            if (!document.getElementById('je-native-tab-panel-' + entry.id)) {
                var panel = document.createElement('div');
                panel.id = 'je-native-tab-panel-' + entry.id;
                panel.className = 'tabContent pageTabContent';
                panel.setAttribute('data-index', String(entry.index));
                root.appendChild(panel);
                entry.onMount(panel);
                console.log('🪼 Jellyfin Enhanced: [native-tabs] added tab panel "' + entry.title + '" at data-index=' + entry.index);
            }

            ensureDiscoverable(entry);
        });

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
    function ensureDiscoverable(entry) {
        var btn = document.getElementById('je-native-tab-btn-' + entry.id);
        var linkId = 'je-native-tab-link-' + entry.id;

        if (btn && btn.offsetParent !== null) {
            document.getElementById(linkId)?.remove();
            removeGroupIfEmpty();
            return;
        }

        if (document.getElementById(linkId)) return;

        var headerRight = JE.helpers.getHeaderRightContainer?.();
        if (!headerRight) return;

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
            var hash = window.location.hash;
            var base = hash.indexOf('#/home') === 0 ? hash.split('?')[0] : '#/home';
            window.location.hash = base + '?tab=' + entry.index;
        });

        group.insertBefore(link, separator);
        console.log('🪼 Jellyfin Enhanced: [native-tabs] tab button for "' + entry.title + '" is hidden (experimental layout), added header-tray fallback link');
    }

    /** If the URL asks for one of our tab indices (Jellyfin's own `?tab=N` convention) but it isn't active yet, activate it. */
    function syncDeepLink() {
        var match = /[?&]tab=(\d+)/.exec(window.location.hash);
        if (!match) return;
        var wantedIndex = parseInt(match[1], 10);
        var entry = entries.find(function (e) { return e.index === wantedIndex; });
        if (!entry) return;

        var btn = document.getElementById('je-native-tab-btn-' + entry.id);
        var tabsElem = document.querySelector('[is="emby-tabs"]');
        if (btn && tabsElem?.selectedIndex && tabsElem.selectedIndex() !== wantedIndex) {
            tabsElem.selectedIndex(wantedIndex);
        }
    }

    function scheduleInject() {
        if (injectPending) return;
        injectPending = true;
        requestAnimationFrame(function () {
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
        }
    };

    JE.helpers.onBodyMutation('native-tabs', scheduleInject);
    window.addEventListener('hashchange', scheduleInject);

})(window.JellyfinEnhanced);
