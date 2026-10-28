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
     * Where the Hidden Content list is in Plugin Pages mode: the companion's own entry for it (its link carries the
     * page's registered address), else the companion's route for JE's page.
     * @returns {string} The hash route.
     */
    function pluginPageRoute() {
        const link = document.querySelector(`a[data-itemid="${PLUGIN_PAGE_ID}"][href*="userpluginsettings"]`);
        const href = link?.getAttribute('href') || '';
        const at = href.indexOf('#/userpluginsettings');
        return at >= 0 ? href.slice(at) : `#/userpluginsettings.html?pageUrl=${PLUGIN_PAGE_URL}`;
    }

    /**
     * The Home tab index of the Custom Tabs entry that holds the Hidden Content marker
     * (`<div class="jellyfinenhanced hidden-content">`): Custom Tabs puts its entries at `?tab=2` onwards, in order.
     * @returns {Promise<number|null>} The index, or null when no entry holds it or the list can't be read.
     */
    async function customTabIndex() {
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
            if (template.content.querySelector('.jellyfinenhanced.hidden-content')) return i + 2;
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
        } else if (config.HiddenContentEnabled && config.HiddenContentUsePluginPages
            && (JE.internals?.hiddenContentPage?.pluginPagesExists || document.querySelector(`a[data-itemid="${PLUGIN_PAGE_ID}"]`))) {
            // The companion shows the list (JE's own page stays away then, hidden-content-page-nav.js).
            window.location.hash = pluginPageRoute();
        } else if (config.HiddenContentEnabled && config.HiddenContentUseCustomTabs) {
            const from = window.location.hash;
            const button = e?.currentTarget || e?.target;
            const index = await customTabIndex();
            // The viewer moved on, or closed the panel, while the list was read: nothing happens.
            if (window.location.hash !== from || (button && !button.isConnected)) return;
            if (index != null) window.location.hash = `#/home?tab=${index}`;
            else JE.hiddenContent.showManagementPanel(e);
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
