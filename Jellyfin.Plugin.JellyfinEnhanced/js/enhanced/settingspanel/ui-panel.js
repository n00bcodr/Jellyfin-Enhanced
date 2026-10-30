/**
 * @file Settings/help panel host (JE.showEnhancedPanel): open/close lifecycle,
 * settings refresh, dragging, auto-close, tab switching; delegates the
 * HTML template and section wiring to the ui-panel-*.js modules.
 * The host owns the one dialog contract every section relies on: dialog
 * semantics, initial focus, Tab kept inside, the page behind inert while it
 * is open, focus given back on close, and
 * the settings search (sections add their controls through ctx.registerSearch).
 * Split from ui.js (code motion; bodies verbatim).
 */
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.enhancedUi = JE.internals.enhancedUi || {};

    /** @type {Function|null} closes the open panel through its full teardown */
    let closeOpenPanel = null;

    /**
     * Toggles the main settings and help panel for the plugin.
     */
    JE.showEnhancedPanel = async () => {
        // Refresh user settings when panel opens to ensure correct user's settings are displayed
        const currentUserId = ApiClient.getCurrentUserId();
        if (currentUserId) {
            try {
                // Fetch fresh settings for the current user
                const settingsResponse = await ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${currentUserId}/settings.json?_=${Date.now()}`),
                    dataType: 'json'
                });

                // Update the userConfig with fresh data
                if (settingsResponse) {
                    JE.userConfig = JE.userConfig || {};
                    JE.userConfig.settings = window.JellyfinEnhanced.toCamelCase(settingsResponse);

                    // Reload current settings
                    if (typeof JE.loadSettings === 'function') {
                        JE.currentSettings = JE.loadSettings();
                    }
                }
            } catch (e) {
                console.warn("🪼 Jellyfin Enhanced: Could not refresh settings for panel display:", e);
            }
        }

        // Re-initialize shortcuts to ensure they're populated before building the panel
        if (typeof JE.initializeShortcuts === 'function') {
            JE.initializeShortcuts();
        }

        const panelId = 'jellyfin-enhanced-panel';
        const existing = document.getElementById(panelId);
        if (existing) {
            if (closeOpenPanel) closeOpenPanel();
            else existing.remove();
            return;
        }
        // Get theme-appropriate styles
        const themeVars = JE.themer.getThemeVariables();

        // Define theme-aware variables
        const panelBgColor = themeVars.panelBg;
        const headerFooterBg = themeVars.secondaryBg;
        const detailsBackground = themeVars.secondaryBg;
        const primaryAccentColor = themeVars.primaryAccent;
        const toggleAccentColor = primaryAccentColor;
        const kbdBackground = themeVars.altAccent;
        const presetBoxBackground = themeVars.altAccent;
        const panelBlurValue = themeVars.blur;
        const githubButtonBg = `rgba(102, 179, 255, 0.1)`;
        const releaseNotesBg = primaryAccentColor;
        const checkUpdatesBorder = `1px solid ${primaryAccentColor}`;
        const releaseNotesTextColor = themeVars.textColor;
        const logoUrl = themeVars.logo;

        // Focus goes back here when the panel closes (the menu button that opened it).
        const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
        const help = document.createElement('div');
        help.id = panelId;
        help.setAttribute('role', 'dialog');
        help.setAttribute('aria-modal', 'true');
        help.setAttribute('aria-labelledby', 'jePanelTitle');
        help.tabIndex = -1;
        Object.assign(help.style, {
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            background: 'rgb(24, 24, 24)',
            color: '#fff',
            padding: '0',
            borderRadius: '16px',
            zIndex: 999999,
            fontSize: '14px',
            backdropFilter: `blur(${panelBlurValue})`,
            // Two-column (nav rail + one open section) layout needs a stable
            // canvas, so the panel takes a fixed size instead of hugging its
            // content. The <=760px media query in the panel stylesheet drops
            // this to a full-screen sheet.
            width: 'min(1040px, 94vw)',
            height: 'min(720px, 90vh)',
            minWidth: '350px',
            maxWidth: '94vw',
            maxHeight: '90vh',
            boxShadow: '0 10px 30px rgba(0,0,0,0.7)',
            border: '1px solid rgba(255,255,255,0.1)',
            overflow: 'hidden',
            display: 'flex',
            fontFamily: 'inherit',
            flexDirection: 'column'
        });

        const pluginShortcuts = Array.isArray(JE.pluginConfig.Shortcuts) ? JE.pluginConfig.Shortcuts : [];

        // Ensure activeShortcuts is initialized before building the panel
        if (!JE.state.activeShortcuts || Object.keys(JE.state.activeShortcuts).length === 0) {
            console.warn('🪼 Jellyfin Enhanced: activeShortcuts not initialized, initializing now...');
            if (typeof JE.initializeShortcuts === 'function') {
                JE.initializeShortcuts();
            }
        }

        // --- Draggable Panel Logic ---------
        let isDragging = false;
        let offset = { x: 0, y: 0 };
        let autoCloseTimer = null;
        let isMouseInside = false;
        // Listeners bound outside the panel element (matchMedia and friends) and
        // section teardowns (ctx.onClose) that removing the panel would otherwise
        // leak; drained on every close path.
        const panelMediaCleanups = [];
        const runPanelCleanups = () => {
            while (panelMediaCleanups.length) panelMediaCleanups.pop()();
        };

        // --- The page behind is inert while the dialog is open ---------
        // Tab containment alone lets a click or a script move focus to the
        // page behind. Every other child of <body> present at open time gets
        // `inert` (no focus, clicks or screen-reader reach); a focusin guard
        // and a mousedown guard cover browsers without inert support and a
        // click on inert content blurring to <body>. Nodes added later (the
        // release notes card the panel opens, toasts) stay usable.
        /** @type {HTMLElement[]} body children this panel made inert */
        const inertBackground = [];
        /** @type {HTMLElement|null} the last control focused inside the dialog */
        let lastFocusInside = null;
        /** @param {EventTarget|null} target @returns {boolean} */
        const isBackground = (target) => target instanceof Node && !help.contains(target)
            && inertBackground.some((node) => node.contains(target));
        const trackFocusInside = (e) => {
            if (e.target instanceof HTMLElement && e.target !== help) lastFocusInside = e.target;
        };
        const guardFocus = (e) => {
            if (!isBackground(e.target)) return;
            const back = lastFocusInside && lastFocusInside.isConnected && help.contains(lastFocusInside) ? lastFocusInside : help;
            back.focus({ preventScroll: true });
        };
        const guardPointer = (e) => {
            // Keep focus where it is: a press on the inert page would blur to <body>.
            if (isBackground(e.target)) e.preventDefault();
        };
        const holdBackground = () => {
            for (const node of Array.from(document.body.children)) {
                if (node === help || !(node instanceof HTMLElement) || node.hasAttribute('inert')) continue;
                node.setAttribute('inert', '');
                inertBackground.push(node);
            }
            help.addEventListener('focusin', trackFocusInside);
            document.addEventListener('focusin', guardFocus, true);
            document.addEventListener('mousedown', guardPointer, true);
        };
        const releaseBackground = () => {
            while (inertBackground.length) inertBackground.pop().removeAttribute('inert');
            help.removeEventListener('focusin', trackFocusInside);
            document.removeEventListener('focusin', guardFocus, true);
            document.removeEventListener('mousedown', guardPointer, true);
        };

        /**
         * Close this panel: every close path (Escape/?, the close button,
         * auto-close, the toggle) goes through here.
         */
        const closePanel = () => {
            if (autoCloseTimer) clearTimeout(autoCloseTimer);
            if (closeOpenPanel === closePanel) closeOpenPanel = null;
            help.remove();
            runPanelCleanups();
            // Before giving focus back: an inert opener can't take it.
            releaseBackground();
            if (opener && opener.isConnected) opener.focus({ preventScroll: true });
            document.removeEventListener('keydown', closeHelp);
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
            if (!JE.pluginConfig.DisableAllShortcuts) {
                document.addEventListener('keydown', JE.keyListener, true);
            }
        };

        const resetAutoCloseTimer = () => {
            if (autoCloseTimer) clearTimeout(autoCloseTimer);
            autoCloseTimer = setTimeout(() => {
                if (!isMouseInside && document.getElementById(panelId)) closePanel();
            }, JE.CONFIG.HELP_PANEL_AUTOCLOSE_DELAY);
        };

        // The grab affordance lives on the header, the only draggable surface.
        const setHeaderCursor = (cursor) => {
            const header = help.querySelector('.panel-header');
            if (header) header.style.cursor = cursor;
        };

        const handleMouseDown = (e) => {
            // Drag only from the header bar: the panes host interactive surfaces
            // (subtitle position grid, selects, sliders) that must own their own
            // pointer gestures — a blanket panel-drag steals them now that the
            // old <details> exclusion no longer matches the pane markup.
            if (!e.target.closest('.panel-header')) return;
            if (e.target.closest('.preset-box, button, a, input, select')) return;
            isDragging = true;
            offset = { x: e.clientX - help.getBoundingClientRect().left, y: e.clientY - help.getBoundingClientRect().top };
            setHeaderCursor('grabbing');
            e.preventDefault();
            resetAutoCloseTimer();
        };

        const handleMouseMove = (e) => {
            if (isDragging) {
                help.style.left = `${e.clientX - offset.x}px`;
                help.style.top = `${e.clientY - offset.y}px`;
                help.style.transform = 'none';
            }
            resetAutoCloseTimer();
        };

        const handleMouseUp = () => {
            isDragging = false;
            setHeaderCursor('grab');
            resetAutoCloseTimer();
        };

        help.addEventListener('mousedown', handleMouseDown);
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
        // Reset the auto-close timer when the mouse enters or leaves the panel.
        help.addEventListener('mouseenter', () => { isMouseInside = true; if (autoCloseTimer) clearTimeout(autoCloseTimer); });
        help.addEventListener('mouseleave', () => { isMouseInside = false; resetAutoCloseTimer(); });
        help.addEventListener('click', resetAutoCloseTimer);
        help.addEventListener('wheel', (e) => { e.stopPropagation(); resetAutoCloseTimer(); });

        /**
         * Settings search providers: each section that wants its controls
         * found by name registers { search(query) → [{ label, path, run }] }.
         * @type {Array<{pane: string, search: (query: string) => Array<{label: string, path: string, run: () => void}>}>}
         */
        const searchProviders = [];

        // Shared context handed to the split panel modules
        // (ui-panel-template.js and the ui-panel-*.js wiring files).
        const ctx = {
            help,
            pluginShortcuts,
            resetAutoCloseTimer,
            /** Register a teardown that runs when the panel closes (any path). */
            onClose: (fn) => { panelMediaCleanups.push(fn); },
            /** Close the panel through its full teardown. */
            closePanel: () => closePanel(),
            /**
             * Let the settings search find a section's controls. Choosing a
             * result opens the provider's pane first, then runs the result.
             * @param {{pane: string, search: (query: string) => Array<{label: string, path: string, run: () => void}>}} provider
             * @returns {() => void} Unregisters it.
             */
            registerSearch: (provider) => {
                searchProviders.push(provider);
                return () => { const i = searchProviders.indexOf(provider); if (i >= 0) searchProviders.splice(i, 1); };
            },
            /** Show a pane by its data-pane slug (set by the section nav below). */
            openPane: (slug) => {},
            panelBgColor,
            headerFooterBg,
            detailsBackground,
            primaryAccentColor,
            toggleAccentColor,
            kbdBackground,
            presetBoxBackground,
            githubButtonBg,
            releaseNotesBg,
            checkUpdatesBorder,
            releaseNotesTextColor,
            logoUrl
        };

        help.innerHTML = internal.buildPanelHtml(ctx);

        document.body.appendChild(help);
        closeOpenPanel = closePanel;
        holdBackground();
        // The dialog itself takes focus first (no ring: it is not a control).
        help.focus({ preventScroll: true });

        // Keep Tab inside the dialog: past the last control it wraps to the
        // first, and Shift+Tab before the first wraps to the last. Hidden and
        // inert controls (the phone layer not shown) don't count.
        const tabbables = () => {
            // An unchecked radio is skipped by Tab when its group has a checked one.
            const checkedGroups = new Set(Array.from(help.querySelectorAll('input[type="radio"]:checked'), (r) => r.name));
            return Array.from(help.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
                .filter((el) => !el.closest('[inert], [hidden]') && el.getClientRects().length > 0
                    && !(el.type === 'radio' && !el.checked && checkedGroups.has(el.name)));
        };
        help.addEventListener('keydown', (e) => {
            if (e.key !== 'Tab') return;
            const list = tabbables();
            if (!list.length) return;
            const first = list[0];
            const last = list[list.length - 1];
            const active = document.activeElement;
            if (e.shiftKey && (active === first || active === help)) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && active === last) {
                e.preventDefault();
                first.focus();
            }
        });

        internal.wirePanelResize?.(ctx);
        internal.wireShortcutEditor(ctx);
        resetAutoCloseTimer();

        // --- Section navigation (adaptive settings view) ---
        // The nav rail is built FROM the panes, so nav and content can never
        // drift: every .je-pane's title becomes a nav item (icon included).
        (function buildSectionNav() {
            const navHost = help.querySelector('.je-panel-nav-items');
            const body = help.querySelector('.je-panel-body');
            const panes = Array.from(help.querySelectorAll('.je-pane'));
            if (!navHost || !body || panes.length === 0) return;

            const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
            const items = [];

            // Phone-mode focus ownership: the list and the detail pane are stacked
            // layers, so exactly one of them may own focus at a time. `inert`
            // removes the hidden layer from the tab order and the a11y tree;
            // desktop shows both columns side by side, so neither is inert there.
            const navColumn = help.querySelector('.je-panel-nav');
            const mainColumn = help.querySelector('.je-panel-main');
            const phoneMedia = window.matchMedia('(max-width: 760px)');
            const dock = help.querySelector('.je-panel-dock');
            const sectionSelect = help.querySelector('#jePanelSection');
            const searchInput = help.querySelector('#jePanelSearch');
            const searchResults = help.querySelector('#jePanelSearchResults');
            const syncLayerFocus = (moveFocus) => {
                if (!navColumn || !mainColumn) return;
                if (dock && navColumn && searchInput && searchResults) {
                    if (phoneMedia.matches) dock.append(searchInput, searchResults);
                    else navColumn.prepend(searchInput, searchResults);
                }
                if (phoneMedia.matches) {
                    const detailOpen = body.classList.contains('je-pane-open');
                    navColumn.inert = detailOpen;
                    mainColumn.inert = !detailOpen;
                    if (moveFocus) {
                        const target = detailOpen
                            ? help.querySelector('#jePanelBack')
                            : (items.find(b => b.classList.contains('active')) || items[0]);
                        if (target) target.focus();
                    }
                } else {
                    navColumn.inert = false;
                    mainColumn.inert = false;
                }
            };
            const handlePhoneMediaChange = () => syncLayerFocus(false);
            phoneMedia.addEventListener('change', handlePhoneMediaChange);

            const activate = (pane, persist) => {
                panes.forEach(p => p.classList.toggle('active', p === pane));
                items.forEach(b => b.classList.toggle('active', b.dataset.tab === pane.dataset.pane));
                if (sectionSelect) sectionSelect.value = pane.dataset.pane;
                body.classList.add('je-pane-open');
                syncLayerFocus(persist);
                if (persist) {
                    JE.currentSettings.lastOpenedTab = pane.dataset.pane;
                    JE.saveUserSettings('settings.json', JE.currentSettings);
                }
                resetAutoCloseTimer();
            };

            panes.forEach((pane, index) => {
                const title = pane.querySelector('.je-pane-title');
                const label = (pane.dataset.paneLabel || (title && title.textContent) || '').trim();
                if (!pane.dataset.pane) pane.dataset.pane = slug(label) || `pane-${index}`;
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'tab-button';
                button.dataset.tab = pane.dataset.pane;
                // Title markup is template-authored (same document, already rendered),
                // duplicated verbatim so the nav item carries the pane heading's icon;
                // the fallback label is plain text.
                if (title) {
                    button.innerHTML = title.innerHTML;
                } else {
                    button.textContent = label;
                }
                button.addEventListener('click', () => activate(pane, true));
                navHost.appendChild(button);
                items.push(button);
                if (sectionSelect) {
                    const option = document.createElement('option');
                    option.value = pane.dataset.pane;
                    option.textContent = label;
                    sectionSelect.appendChild(option);
                }
            });

            sectionSelect?.addEventListener('change', () => ctx.openPane(sectionSelect.value));
            ctx.openPane = (slug) => {
                const pane = panes.find(p => p.dataset.pane === slug);
                if (pane) activate(pane, true);
                return !!pane;
            };
            // "Open Media Tags" (and any other pointer) buttons in a pane.
            help.addEventListener('click', (e) => {
                const pointer = e.target.closest?.('[data-je-open-pane]');
                if (!pointer) return;
                ctx.openPane(pointer.dataset.jeOpenPane);
                const pane = panes.find(p => p.dataset.pane === pointer.dataset.jeOpenPane);
                const heading = pane?.querySelector('[role="tab"][aria-selected="true"]') || pane?.querySelector('.je-pane-title');
                if (heading) {
                    if (!heading.matches('button')) heading.tabIndex = -1;
                    heading.focus();
                }
            });

            // Mobile back button returns to the section list.
            const backButton = help.querySelector('#jePanelBack');
            if (backButton) {
                backButton.addEventListener('click', () => {
                    body.classList.remove('je-pane-open');
                    syncLayerFocus(true);
                    resetAutoCloseTimer();
                });
            }

            // Search filters the section list by each pane's full text, and
            // lists the controls registered sections match by name: choosing
            // one opens its pane and lets the section reveal and focus it.
            const search = help.querySelector('#jePanelSearch');
            const results = help.querySelector('#jePanelSearchResults');
            const MAX_RESULTS = 8;
            const renderResults = (query) => {
                if (!results) return;
                const found = [];
                if (query) {
                    for (const provider of searchProviders) {
                        try {
                            for (const hit of provider.search(query) || []) found.push({ ...hit, pane: provider.pane });
                        } catch (err) {
                            console.warn('🪼 Jellyfin Enhanced: settings search provider failed', err);
                        }
                    }
                }
                const shown = found.slice(0, MAX_RESULTS);
                results.replaceChildren(...shown.map((hit) => {
                    const li = document.createElement('li');
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'je-panel-search-result';
                    button.textContent = hit.label;
                    const where = document.createElement('span');
                    where.textContent = hit.path;
                    button.appendChild(where);
                    button.addEventListener('click', () => {
                        if (hit.pane) ctx.openPane(hit.pane);
                        hit.run();
                        resetAutoCloseTimer();
                    });
                    li.appendChild(button);
                    return li;
                }));
                results.hidden = shown.length === 0;
            };
            if (search) {
                search.addEventListener('input', () => {
                    const query = search.value.trim().toLowerCase();
                    items.forEach((button) => {
                        const pane = panes.find(p => p.dataset.pane === button.dataset.tab);
                        const hit = !query || (!!pane && (pane.textContent || '').toLowerCase().includes(query));
                        button.style.display = hit ? '' : 'none';
                    });
                    renderResults(query);
                    resetAutoCloseTimer();
                });
                // Enter runs the first match; Down moves into the list.
                search.addEventListener('keydown', (e) => {
                    const first = results?.querySelector('button');
                    if (!first) return;
                    if (e.key === 'Enter') { e.preventDefault(); first.click(); }
                    else if (e.key === 'ArrowDown') { e.preventDefault(); first.focus(); }
                });
                results?.addEventListener('keydown', (e) => {
                    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
                    const buttons = Array.from(results.querySelectorAll('button'));
                    const at = buttons.indexOf(document.activeElement);
                    if (at < 0) return;
                    e.preventDefault();
                    const next = at + (e.key === 'ArrowDown' ? 1 : -1);
                    (next < 0 ? search : buttons[Math.min(next, buttons.length - 1)]).focus();
                });
            }

            // Initial view: desktop restores the last-open section; a phone-sized
            // viewport starts on the section list (nothing pre-opened).
            const lastTab = JE.currentSettings.lastOpenedTab;
            const initial = panes.find(p => p.dataset.pane === lastTab) || panes[0];
            if (phoneMedia.matches) {
                panes.forEach(p => p.classList.remove('active'));
                syncLayerFocus(false);
            } else {
                activate(initial, false);
            }

            // The panel is destroyed by removal, so the media listener has to be
            // dropped alongside it or it outlives every closed panel.
            panelMediaCleanups.push(() => phoneMedia.removeEventListener('change', handlePhoneMediaChange));
        })();

        // --- Event Handlers for Settings Panel ---
        // '?' is a close shortcut, so it must not fire while the caret sits in the
        // section search box (or any other panel text field) — otherwise typing a
        // question mark dismisses the panel mid-search.
        const isEditableKeyboardTarget = (target) => {
            if (!(target instanceof HTMLElement)) return false;
            if (target.isContentEditable) return true;
            const tag = target.tagName;
            if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
            return tag === 'INPUT' && !['checkbox', 'radio', 'button', 'range', 'color'].includes(target.type);
        };
        const closeHelp = (ev) => {
            const keyboardClose = ev.type === 'keydown'
                && (ev.key === 'Escape' || (ev.key === '?' && !isEditableKeyboardTarget(ev.target)));
            if (keyboardClose || (ev.type === 'click' && ev.target.id === 'closeSettingsPanel')) {
                ev.stopPropagation();
                closePanel();
            }
        };

        const createToast = (featureKey, isEnabled) => {
            const feature = JE.t(featureKey);
            const status = JE.t(isEnabled ? 'status_enabled' : 'status_disabled');
            return JE.t('toast_feature_status', { feature, status });
        };
        document.addEventListener('keydown', closeHelp);
        document.getElementById('closeSettingsPanel').addEventListener('click', closeHelp);

        if (!JE.pluginConfig.DisableAllShortcuts) {
            document.removeEventListener('keydown', JE.keyListener, true);
        }
        ctx.createToast = createToast;

        internal.wireSettingsListeners(ctx);
        internal.wireTagLooks?.(ctx);
        internal.wireHiddenContentListeners(ctx);
        JE.internals.spoilerGuard?.wireSettings?.(ctx);
        internal.wireMiscSettingsControls(ctx);
        internal.wireTagGroupEditor(ctx);
        internal.wireLanguageControls(ctx);
        // Last: the hub drives the tag sections wired above (tab switches, search).
        internal.wireMediaTagsHub?.(ctx);
    };
})(window.JellyfinEnhanced);
