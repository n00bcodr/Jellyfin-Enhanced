/**
 * @file Hidden Content section wiring inside the settings panel (toggles,
 * surface filters, experimental options, manage button).
 * Split from ui.js (code motion; bodies verbatim).
 */
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.enhancedUi = JE.internals.enhancedUi || {};

    /**
     * Wires the Hidden Content settings-panel listeners.
     * @param {object} ctx Shared panel context assembled in ui-panel.js.
     */
    /** The Plugin Pages entry JE registers for Hidden Content (JellyfinEnhanced.cs), and its page. */
    const PLUGIN_PAGE_ID = 'Jellyfin.Plugin.JellyfinEnhanced.HiddenContentPage';
    const PLUGIN_PAGE_URL = '/JellyfinEnhanced/hiddenContentPage';

    /**
     * JE's Hidden Content page as a Plugin Pages route, from a link's `href`: only the companion's own route
     * (`#/userpluginsettings.html`) with exactly one parameter, `pageUrl`, naming JE's page (or JE's page under this
     * server's base path, as older Plugin Pages register it). The route is built here, never copied from the link.
     * @param {string|null} href A link's href.
     * @returns {string|null} The route, or null for any other destination.
     */
    function pluginPageRouteOf(href) {
        const at = typeof href === 'string' ? href.indexOf('#/') : -1;
        if (at < 0) return null;
        const [path, query, ...rest] = href.slice(at + 1).split('?');
        if (path !== '/userpluginsettings.html' || rest.length || query == null) return null;
        const params = new URLSearchParams(query);
        if ([...params.keys()].length !== 1 || params.getAll('pageUrl').length !== 1) return null;
        const pageUrl = params.get('pageUrl');
        let base = '';
        try { base = new URL(ApiClient.serverAddress()).pathname.replace(/\/+$/, ''); } catch (_) { /* no base path */ }
        return pageUrl === PLUGIN_PAGE_URL || (base && pageUrl === base + PLUGIN_PAGE_URL) ? `#/userpluginsettings.html?pageUrl=${pageUrl}` : null;
    }

    /**
     * Whether the companion shows JE's Hidden Content page, and its route: from its sidebar link (legacy drawer, by JE's
     * entry id) or its user-menu item (Jellyfin 12's Modern layout, no item id) when that names JE's page exactly; a
     * link with JE's entry id that names anything else still says the page is registered, and the route is JE's own.
     * @returns {{route: string}|null} The destination, or null when the companion drew no entry for it.
     */
    function pluginPageEntry() {
        const canonical = `#/userpluginsettings.html?pageUrl=${PLUGIN_PAGE_URL}`;
        const own = document.querySelector(`a[data-itemid="${PLUGIN_PAGE_ID}"]`);
        if (own) return { route: pluginPageRouteOf(own.getAttribute('href')) || canonical };
        for (const a of document.querySelectorAll('a[href*="userpluginsettings"]')) {
            const route = pluginPageRouteOf(a.getAttribute('href'));
            if (route) return { route };
        }
        return JE.internals?.hiddenContentPage?.pluginPagesExists ? { route: canonical } : null;
    }

    /**
     * The Home route of the Custom Tabs entry that holds the Hidden Content marker
     * (`<div class="jellyfinenhanced hidden-content">`), as Custom Tabs' own links name it: its entries are at `?tab=2`
     * onwards, in order, with `ctTab=<entry id>`.
     * @returns {Promise<string|null>} The route, or null when no entry holds it or the list can't be read.
     */
    async function customTabRoute() {
        let configs;
        try {
            configs = await ApiClient.fetch({ url: ApiClient.getUrl('CustomTabs/Config'), type: 'GET', dataType: 'json', headers: { accept: 'application/json' } });
        } catch (_) {
            return null;
        }
        if (!Array.isArray(configs)) return null;
        for (let i = 0; i < configs.length; i++) {
            const html = configs[i]?.ContentHtml ?? configs[i]?.contentHtml;
            if (typeof html !== 'string' || !html) continue;
            // Parsed inert (a template runs nothing and loads nothing).
            const template = document.createElement('template');
            template.innerHTML = html;
            if (!template.content.querySelector('.jellyfinenhanced.hidden-content')) continue;
            const id = configs[i]?.Id ?? configs[i]?.id;
            return `#/home?tab=${i + 2}` + (typeof id === 'string' && id ? `&ctTab=${encodeURIComponent(id)}` : '');
        }
        return null;
    }

    /**
     * "Manage hidden content": opens the list where this server shows it: the native Home tab, the Plugin Pages
     * page, the Custom Tabs tab, or JE's own page; the manager window when none of them can be reached.
     * @param {Event} e The press.
     * @returns {Promise<void>}
     */
    async function openHiddenContentManager(e) {
        const config = JE.pluginConfig || {};
        if (config.HiddenContentEnabled && config.HiddenContentUseNativeTab && JE.nativeTabs) {
            // The list is a Home tab then (hidden-content-custom-tab.js): the page of its own does nothing,
            // so go to the tab, named by id (native-tabs.js puts the right tab index in).
            window.location.hash = '#/home?tab=0&jeTab=hidden-content';
        } else if (config.HiddenContentEnabled && config.HiddenContentUsePluginPages && pluginPageEntry()) {
            // The companion shows the list (JE's own page stays away then, hidden-content-page-nav.js).
            window.location.hash = pluginPageEntry().route;
        } else if (config.HiddenContentEnabled && config.HiddenContentUseCustomTabs) {
            const from = window.location.hash;
            const button = e?.currentTarget || e?.target;
            // The press's owner, taken while it is dispatched: the manager window opened after the read is still a
            // surface of it (over the settings panel), which the press itself no longer names by then.
            const owner = JE.ownerOf?.(e) || null;
            const route = await customTabRoute();
            // The viewer moved on, or closed the panel, while the list was read: nothing happens.
            if (window.location.hash !== from || (button && !button.isConnected)) return;
            if (route) window.location.hash = route;
            else JE.hiddenContent.showManagementPanel(owner || e);
        } else if (config.HiddenContentEnabled && JE.hiddenContentPage) {
            JE.hiddenContentPage.showPage();
        } else {
            JE.hiddenContent.showManagementPanel(e);
        }
    }

    internal.wireHiddenContentListeners = function(ctx) {
        const { resetAutoCloseTimer } = ctx;

        // ============================================================
        // Hidden Content — settings panel event listeners
        // Binds change handlers for all hidden-content toggles:
        // master enable, button visibility, surface filters,
        // confirmation dialog, experimental collections, and
        // the "Manage Hidden Content" button.
        // ============================================================
        if (JE.hiddenContent) {
            const hiddenButtonToggles = [
                ['hiddenShowButtonJellyseerr', 'showButtonJellyseerr'],
                ['hiddenShowButtonLibrary', 'showButtonLibrary'],
                ['hiddenShowButtonDetails', 'showButtonDetails'],
                ['hiddenShowButtonCast', 'showButtonCast']
            ];
            for (const [id, key] of hiddenButtonToggles) {
                const el = document.getElementById(id);
                if (el) {
                    el.addEventListener('change', (e) => {
                        JE.hiddenContent.updateSettings({ [key]: e.target.checked });
                        if (key === 'showButtonLibrary' || key === 'showButtonCast') {
                            if (e.target.checked) {
                                JE.hiddenContent.addLibraryHideButtons();
                            } else {
                                JE.hiddenContent.removeLibraryHideButtons();
                                JE.hiddenContent.addLibraryHideButtons();
                            }
                        }
                        resetAutoCloseTimer();
                    });
                }
            }
            const hiddenSurfaceToggles = [
                ['hiddenFilterLibrary', 'filterLibrary'],
                ['hiddenFilterDiscovery', 'filterDiscovery'],
                ['hiddenFilterSearch', 'filterSearch'],
                ['hiddenFilterCalendar', 'filterCalendar'],
                ['hiddenFilterUpcoming', 'filterUpcoming'],
                ['hiddenFilterRecommendations', 'filterRecommendations'],
                ['hiddenFilterRequests', 'filterRequests'],
                ['hiddenFilterNextUp', 'filterNextUp'],
                ['hiddenFilterContinueWatching', 'filterContinueWatching']
            ];
            const masterToggle = document.getElementById('hiddenContentEnabledToggle');
            if (masterToggle) {
                masterToggle.addEventListener('change', (e) => {
                    JE.hiddenContent.updateSettings({ enabled: e.target.checked });
                    resetAutoCloseTimer();
                });
            }
            const buttonsToggle = document.getElementById('hiddenShowHideButtons');
            if (buttonsToggle) {
                buttonsToggle.addEventListener('change', (e) => {
                    JE.hiddenContent.updateSettings({ showHideButtons: e.target.checked });
                    if (e.target.checked) {
                        if (JE.hiddenContent.getSettings().showButtonLibrary) {
                            JE.hiddenContent.addLibraryHideButtons();
                        }
                    } else {
                        JE.hiddenContent.removeLibraryHideButtons();
                    }
                    resetAutoCloseTimer();
                });
            }
            for (const [id, key] of hiddenSurfaceToggles) {
                const el = document.getElementById(id);
                if (el) {
                    el.addEventListener('change', (e) => {
                        JE.hiddenContent.updateSettings({ [key]: e.target.checked });
                        resetAutoCloseTimer();
                    });
                }
            }
            const confirmToggle = document.getElementById('hiddenShowConfirmation');
            if (confirmToggle) {
                confirmToggle.addEventListener('change', (e) => {
                    JE.hiddenContent.updateSettings({ showHideConfirmation: e.target.checked });
                    localStorage.removeItem('je_hide_confirm_suppressed_until');
                    resetAutoCloseTimer();
                });
            }
            const experimentalCollections = document.getElementById('hiddenExperimentalCollections');
            if (experimentalCollections) {
                experimentalCollections.addEventListener('change', (e) => {
                    JE.hiddenContent.updateSettings({ experimentalHideCollections: e.target.checked });
                    if (!e.target.checked) {
                        JE.hiddenContent.removeLibraryHideButtons();
                        JE.hiddenContent.addLibraryHideButtons();
                    }
                    resetAutoCloseTimer();
                });
            }
            const manageBtn = document.getElementById('manageHiddenContentBtn');
            if (manageBtn) {
                manageBtn.addEventListener('click', (e) => { openHiddenContentManager(e); });
            }
        }
    };

})(window.JellyfinEnhanced);
