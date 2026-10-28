/**
 * @file Settings/help panel host (JE.showEnhancedPanel): open/close lifecycle,
 * settings refresh, dragging, auto-close, tab switching; delegates the
 * HTML template and section wiring to the ui-panel-*.js modules.
 * Split from ui.js (code motion; bodies verbatim).
 */
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.enhancedUi = JE.internals.enhancedUi || {};

    /** Closes the open panel (every close path ends here: media, drag, keyboard and surface cleanups), or null. */
    let closeOpenPanel = null;

    // An outgoing panel must not remain an editable view after its identity store is cleared. Its own close path
    // cleans up media, drag, keyboard and surface listeners (a panel this module did not draw: its close button).
    JE.session?.onUserChange?.('settings-panel', () => {
        if (closeOpenPanel) closeOpenPanel();
        else document.getElementById('closeSettingsPanel')?.click();
    });

    /**
     * Toggles the main settings and help panel for the plugin. The panel is a modal surface on the shared stack
     * (JE.openSurface): a named dialog, Tab and the D-pad stay inside it, what it covers is inert, Escape or Back
     * closes it while it is the topmost surface, and focus goes back to the control that opened it.
     * @param {Event|Object} [from] The press that opens it (or its owner), taken before anything awaits.
     * @param {{tab?: string}} [options] tab: the section to show first.
     */
    JE.showEnhancedPanel = async (from, options = {}) => {
        // Whoever opened it (the viewer's gesture or the surface it was made in) owns the panel's surface; taken
        // now, while the event is still being dispatched.
        const owner = (from && JE.ownerOf?.(from)) || null;
        // Opened with a pointer (a real click, not a key's activation): the only way auto-close can apply (see below).
        const openedByPointer = typeof MouseEvent !== 'undefined' && from instanceof MouseEvent && from.detail > 0;
        // The shared document store fences this read against newer saves and identity changes.
        const epoch = JE.session?.getEpoch?.();
        const currentUserId = ApiClient.getCurrentUserId();
        if (currentUserId) {
            try {
                if (!await JE.readUserSettings('settings.json')) return;
            } catch (e) {
                console.warn("🪼 Jellyfin Enhanced: Could not refresh settings for panel display:", e);
            }
        }
        if (currentUserId !== ApiClient.getCurrentUserId()
            || (epoch !== undefined && !JE.session.isCurrent(epoch))) return;

        // Re-initialize shortcuts to ensure they're populated before building the panel
        if (typeof JE.initializeShortcuts === 'function') {
            JE.initializeShortcuts();
        }

        const panelId = 'jellyfin-enhanced-panel';
        const existing = document.getElementById(panelId);
        if (existing) {
            if (closeOpenPanel) closeOpenPanel();
            else existing.querySelector('#closeSettingsPanel')?.click();
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

        const help = document.createElement('div');
        help.id = panelId;
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
        // Auto-close is only for a panel opened with a pointer that never takes the focus afterwards. Opened any other
        // way (a key, a remote, a link the keyboard activated), or once a key is pressed or focus arrives inside it
        // (a screen reader's included), it stays open until it is closed: a reader may read without any further event,
        // and moving the pointer does not change that. Nor does it close while a surface it opened is on top of it.
        let keyboardInUse = !openedByPointer;
        let focusSettled = false;
        // Listeners bound outside the panel element (matchMedia and friends) that
        // removing the panel would otherwise leak; drained on every close path.
        const panelMediaCleanups = [];
        const runPanelCleanups = () => {
            while (panelMediaCleanups.length) panelMediaCleanups.pop()();
        };

        const resetAutoCloseTimer = () => {
            if (autoCloseTimer) clearTimeout(autoCloseTimer);
            autoCloseTimer = null;
            if (keyboardInUse) return;
            autoCloseTimer = setTimeout(() => {
                autoCloseTimer = null;
                if (!document.getElementById(panelId)) return;
                const covered = !!releaseSurface && JE.isTopmostSurface?.(help) === false;
                if (keyboardInUse) return;
                if (!isMouseInside && !covered) closePanel();
                else resetAutoCloseTimer();
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
        // Someone working with the keyboard (or a remote) is using the panel: it stays open for them (see keyboardInUse).
        const noteKeyboard = () => {
            keyboardInUse = true;
            if (autoCloseTimer) clearTimeout(autoCloseTimer);
            autoCloseTimer = null;
        };
        help.addEventListener('keydown', noteKeyboard, true);
        // Any focus inside the panel after its opening's own (the stack moves focus in as it opens).
        help.addEventListener('focusin', () => { if (focusSettled) noteKeyboard(); });
        setTimeout(() => { focusSettled = true; }, 0);
        help.addEventListener('wheel', (e) => { e.stopPropagation(); resetAutoCloseTimer(); });

        // Shared context handed to the split panel modules
        // (ui-panel-template.js and the ui-panel-*.js wiring files).
        const ctx = {
            help,
            panelCleanups: panelMediaCleanups,
            pluginShortcuts,
            resetAutoCloseTimer,
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

        const scope = JE.internals.settingsPanelScope(ctx);
        const { listen } = scope;
        // A section asked for by the opener (a link to Requests & alerts) is the one shown first.
        if (options?.tab && JE.currentSettings) JE.currentSettings.lastOpenedTab = options.tab;

        help.innerHTML = internal.buildPanelHtml(ctx);

        // Every way the panel closes (its × button, Escape or Back, '?', the auto-close timer, its owner ending,
        // another user signing in): once.
        let releaseSurface = null;
        let closed = false;
        const closePanel = () => {
            if (closed) return;
            closed = true;
            if (closeOpenPanel === closePanel) closeOpenPanel = null;
            isDragging = false;
            if (autoCloseTimer) clearTimeout(autoCloseTimer);
            // The page behind is live again and focus goes back to the opener, before the panel goes.
            releaseSurface?.();
            help.remove();
            runPanelCleanups();
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
            if (!JE.pluginConfig.DisableAllShortcuts) {
                document.addEventListener('keydown', JE.keyListener, true);
            }
        };
        closeOpenPanel = closePanel;

        document.body.appendChild(help);
        // On the one surface stack when an owner opened it (a press or a surface's owner). Its name is the panel's
        // own title; the stack sets the dialog role and modal state, makes the page behind inert, keeps Tab inside and
        // takes Escape/Back while the panel is the topmost surface.
        if (owner && typeof JE.openSurface === 'function' && JE.admitSurface?.(owner, 'the settings panel')) {
            releaseSurface = JE.openSurface(help, closePanel, owner, { label: 'Jellyfin Enhanced' });
        }

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
            const syncLayerFocus = (moveFocus) => {
                if (!navColumn || !mainColumn) return;
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
            listen(phoneMedia, 'change', handlePhoneMediaChange);

            const activate = (pane, persist) => {
                panes.forEach(p => p.classList.toggle('active', p === pane));
                items.forEach(b => b.classList.toggle('active', b.dataset.tab === pane.dataset.pane));
                body.classList.add('je-pane-open');
                syncLayerFocus(persist);
                if (persist) {
                    if (scope.isCurrent()) JE.updateSettings({ lastOpenedTab: pane.dataset.pane }, { origin: JE.core.userWrite.origin() });
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
                listen(button, 'click', () => activate(pane, true));
                navHost.appendChild(button);
                items.push(button);
            });

            // Mobile back button returns to the section list.
            const backButton = help.querySelector('#jePanelBack');
            if (backButton) {
                listen(backButton, 'click', () => {
                    body.classList.remove('je-pane-open');
                    syncLayerFocus(true);
                    resetAutoCloseTimer();
                });
            }

            // Search filters the section list by each pane's full text.
            const search = help.querySelector('#jePanelSearch');
            if (search) {
                listen(search, 'input', () => {
                    const query = search.value.trim().toLowerCase();
                    items.forEach((button) => {
                        const pane = panes.find(p => p.dataset.pane === button.dataset.tab);
                        const hit = !query || (!!pane && (pane.textContent || '').toLowerCase().includes(query));
                        button.style.display = hit ? '' : 'none';
                    });
                    resetAutoCloseTimer();
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
            // On the surface stack, Escape (and every Back key) is the stack's: it closes only the topmost surface
            // (a dialog the panel opened goes first). '?' closes the panel only while nothing is over it.
            const topmost = !releaseSurface || JE.isTopmostSurface?.(help) !== false;
            const keyboardClose = ev.type === 'keydown' && topmost
                && ((ev.key === 'Escape' && !releaseSurface) || (ev.key === '?' && !isEditableKeyboardTarget(ev.target)));
            if (keyboardClose || (ev.type === 'click' && ev.target.id === 'closeSettingsPanel')) {
                ev.stopPropagation();
                closePanel();
            }
        };

        scope.onCleanup(closePanel);

        const createToast = (featureKey, isEnabled) => {
            const feature = JE.t(featureKey);
            const status = JE.t(isEnabled ? 'status_enabled' : 'status_disabled');
            return JE.t('toast_feature_status', { feature, status });
        };
        listen(document, 'keydown', closeHelp);
        listen(document.getElementById('closeSettingsPanel'), 'click', closeHelp);

        if (!JE.pluginConfig.DisableAllShortcuts) {
            document.removeEventListener('keydown', JE.keyListener, true);
        }
        ctx.createToast = createToast;

        internal.wireSettingsListeners(ctx);
        internal.wireHiddenContentListeners(ctx);
        JE.internals.spoilerGuard?.wireSettings?.(ctx);
        JE.internals.arrNotify?.wireSettings?.(ctx);
        JE.internals.arrReady?.wireSettings?.(ctx);
        internal.wireMiscSettingsControls(ctx);
        internal.wireLanguageControls(ctx);
    };
})(window.JellyfinEnhanced);
