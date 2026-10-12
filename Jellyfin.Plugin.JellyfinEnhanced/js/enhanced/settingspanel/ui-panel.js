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

    // Panes whose controls write settings.json; read-only while it failed to load.
    // A selector limits it to the rows holding those controls: the language pane's
    // translation-cache button only touches localStorage and stays usable.
    const SETTINGS_DOCUMENT_PANES = {
        'playback': null, 'auto-skip': null, 'subtitles': null, 'random-button': null, 'ui': null,
        'language': '#displayLanguageSelect'
    };

    /**
     * Shows the settings panes read-only with a Retry button when the stored
     * settings.json failed to load (JE.userConfig.settingsStatus 'unavailable',
     * or still 'loading' after a user switch).
     * The values on screen are then fallback defaults that JE.saveUserSettings
     * refuses to write, so the controls are inert rather than silently unsaved.
     * @param {HTMLElement} help - The panel root.
     * @param {(ev: Event) => void} retry - Click handler of the Retry buttons.
     */
    function showSettingsUnavailable(help, retry) {
        Object.entries(SETTINGS_DOCUMENT_PANES).forEach(([paneName, controlSelector]) => {
            const pane = help.querySelector(`.je-pane[data-pane="${paneName}"]`);
            if (!pane) return;
            const title = pane.querySelector('.je-pane-title');
            const rows = controlSelector
                ? Array.from(pane.querySelectorAll(controlSelector), (control) => control.parentElement)
                : Array.from(pane.children).filter((child) => child !== title);
            if (!rows.length) return;
            rows.forEach((child) => {
                child.setAttribute('inert', '');
                child.setAttribute('aria-disabled', 'true');
                child.style.opacity = '0.5';
            });

            const notice = document.createElement('div');
            notice.className = 'je-settings-unavailable';
            notice.setAttribute('role', 'status');
            Object.assign(notice.style, {
                display: 'flex', alignItems: 'center', gap: '12px', margin: '0 16px 16px 16px', padding: '12px',
                borderRadius: '6px', borderLeft: '3px solid #f0ad4e', background: 'rgba(240, 173, 78, 0.12)'
            });
            const text = document.createElement('span');
            text.style.flex = '1';
            text.textContent = JE.settings.unavailableText('panel_settings_unavailable');
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'je-settings-unavailable-retry';
            Object.assign(button.style, {
                padding: '6px 14px', border: '1px solid rgba(255,255,255,0.3)', borderRadius: '6px',
                background: 'rgba(255,255,255,0.1)', color: '#fff', fontFamily: 'inherit', cursor: 'pointer'
            });
            button.textContent = JE.settings.unavailableText('panel_settings_unavailable_retry');
            button.addEventListener('click', retry);
            notice.append(text, button);
            if (title) title.after(notice); else pane.prepend(notice);
        });
    }

    // Closes the open panel through its own close path (listeners, focus restore); null when closed.
    let closeOpenPanel = null;

    // How long the in-panel "couldn't save" strip stays up.
    const SAVE_ERROR_VISIBLE_MS = 6000;
    let saveErrorTimer = null;

    /**
     * Shows a failed-save message inside the open panel, between the header and the sections, so
     * it is visible in every layout: a toast would sit under the panel, which fills a phone screen.
     * Called by JE.saveUserSettings (config.js) for saves made with notifyOnError.
     * @param {string} message Plain text.
     * @returns {boolean} Whether a panel was open to show it in.
     */
    internal.showPanelSaveError = (message) => {
        const help = document.getElementById('jellyfin-enhanced-panel');
        if (!help) return false;
        let strip = help.querySelector('.je-save-error');
        if (!strip) {
            strip = document.createElement('div');
            strip.className = 'je-save-error';
            strip.setAttribute('role', 'alert');
            Object.assign(strip.style, {
                flexShrink: '0', padding: '10px 20px', fontSize: '13px', color: '#fff',
                borderLeft: '3px solid #d9534f', background: 'rgba(217, 83, 79, 0.18)'
            });
            const header = help.querySelector('.panel-header');
            if (header) header.after(strip); else help.prepend(strip);
        }
        strip.textContent = message;
        if (saveErrorTimer) clearTimeout(saveErrorTimer);
        saveErrorTimer = setTimeout(() => {
            saveErrorTimer = null;
            strip.remove();
        }, SAVE_ERROR_VISIBLE_MS);
        return true;
    };

    /**
     * localStorage key of the section the panel last showed, per server and user: it is
     * device-local panel state, so it is no longer saved in settings.json.
     * @returns {string|null} The key, or null without a signed-in user.
     */
    function lastTabStorageKey() {
        const userId = ApiClient.getCurrentUserId?.();
        if (!userId) return null;
        const serverId = (typeof ApiClient.serverId === 'function' ? ApiClient.serverId() : ApiClient.serverId) || '';
        return `JE_panel_last_tab_${serverId}_${userId}`;
    }

    /**
     * The section to open first: the device's own choice, else the value older versions
     * stored in settings.json (copied to this device once, so it is read only that time).
     * @returns {string|undefined} A pane name, or undefined for none.
     */
    function readLastOpenedTab() {
        const key = lastTabStorageKey();
        const legacy = JE.currentSettings?.lastOpenedTab;
        if (!key) return legacy;
        try {
            const stored = localStorage.getItem(key);
            if (stored) return stored;
            if (legacy) localStorage.setItem(key, legacy);
        } catch (e) { /* storage blocked: fall back to the legacy value */ }
        return legacy;
    }

    /**
     * Remembers the open section on this device.
     * @param {string} pane The pane name.
     */
    function writeLastOpenedTab(pane) {
        const key = lastTabStorageKey();
        if (!key) return;
        try { localStorage.setItem(key, pane); } catch (e) { /* storage blocked */ }
    }

    // Elements Tab can land on inside the panel.
    const TABBABLE_SELECTOR = 'a[href], button, input, select, textarea, [tabindex]';

    // Non-modal popups opened from the panel that share its focus trap (ui-release-notes.js sets it).
    const PANEL_COMPANION_SELECTOR = '[data-je-panel-companion]';

    /**
     * Whether Tab can reach the element right now: enabled, not tabindex=-1, not inert and
     * not hidden by display/visibility on it or an ancestor up to the panel root.
     * @param {Element} element A candidate inside the panel.
     * @param {HTMLElement} root The panel root.
     * @returns {boolean}
     */
    function isTabbable(element, root) {
        if (element.disabled || element.getAttribute('tabindex') === '-1') return false;
        if (element.type === 'hidden' || element.closest('[inert]')) return false;
        for (let node = element; node && node !== root.parentNode; node = node.parentElement) {
            const style = window.getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
        }
        return true;
    }

    /**
     * First and last element Tab can reach inside the panel.
     * @param {HTMLElement} root The panel root.
     * @returns {{first: HTMLElement|null, last: HTMLElement|null}}
     */
    function tabbableEdges(root) {
        const candidates = Array.from(root.querySelectorAll(TABBABLE_SELECTOR));
        return {
            first: candidates.find(el => isTabbable(el, root)) || null,
            last: candidates.reverse().find(el => isTabbable(el, root)) || null
        };
    }

    /**
     * Toggles the main settings and help panel for the plugin.
     */
    JE.showEnhancedPanel = async () => {
        const panelId = 'jellyfin-enhanced-panel';
        // Toggle: close an open panel first, before the refresh below replaces JE.currentSettings,
        // so a colour save still pending in the panel is flushed with the values the user chose.
        if (closeOpenPanel && document.getElementById(panelId)) {
            closeOpenPanel();
            return;
        }
        // Where focus goes back to when the panel closes (the link, button or page that opened it).
        const opener = document.activeElement;
        // Refresh user settings when panel opens to ensure correct user's settings are displayed
        const currentUserId = ApiClient.getCurrentUserId();
        // A user switch while the refresh is in flight makes its answer the
        // previous user's: drop it (and the panel open) rather than install it
        // over the incoming user's 'loading' state.
        const epoch = JE.session ? JE.session.getEpoch() : 0;
        if (currentUserId) {
            try {
                // Fetch fresh settings for the current user, with their per-key state (locks and
                // the like) so the rows show what an administrator changed since the page loaded.
                const settingsResponse = await ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${currentUserId}/settings.json?meta=true&_=${Date.now()}`),
                    dataType: 'json'
                });
                if (JE.session && !JE.session.isCurrent(epoch)) return;

                // A server without Meta answers the plain document (it never has a Settings key).
                const withMeta = settingsResponse && settingsResponse.Settings && typeof settingsResponse.Settings === 'object' && settingsResponse.Meta;
                const settingsDocument = withMeta ? settingsResponse.Settings : settingsResponse;

                // Update the userConfig with fresh data
                if (settingsDocument) {
                    JE.userConfig = JE.userConfig || {};
                    JE.userConfig.settings = window.JellyfinEnhanced.toCamelCase(settingsDocument);
                    JE.userConfig.settingsStatus = 'ok';
                    if (withMeta && typeof JE.camelCaseSettingsMeta === 'function') {
                        JE.userConfig.settingsMeta = JE.camelCaseSettingsMeta(settingsResponse.Meta);
                    } else if (!withMeta) {
                        // A server without Meta (rolled back under this tab) has no locks or gates:
                        // drop the ones a newer server reported, as a bootstrap from it would.
                        delete JE.userConfig.settingsMeta;
                    }

                    // Reload current settings
                    if (typeof JE.loadSettings === 'function') {
                        JE.currentSettings = JE.loadSettings();
                    }
                }
            } catch (e) {
                if (JE.session && !JE.session.isCurrent(epoch)) return;
                console.warn("🪼 Jellyfin Enhanced: Could not refresh settings for panel display:", e);
                // The server says the stored file cannot be read (it may have become unreadable
                // since boot): show it read-only rather than let saves go on. A plain network
                // failure keeps the status it had.
                if (e?.status === 503 && typeof e.json === 'function') {
                    const body = await e.json().catch(() => null);
                    if (JE.session && !JE.session.isCurrent(epoch)) return;
                    if (body?.status === 'unavailable') {
                        JE.userConfig = JE.userConfig || {};
                        JE.userConfig.settingsStatus = 'unavailable';
                    }
                }
            }
        }

        // Re-initialize shortcuts to ensure they're populated before building the panel
        if (typeof JE.initializeShortcuts === 'function') {
            JE.initializeShortcuts();
        }

        // Another call opened a panel while this one waited for the refresh.
        const existing = document.getElementById(panelId);
        if (existing) {
            if (closeOpenPanel) closeOpenPanel(); else existing.remove();
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
        // A modal dialog for assistive tech; `focuscontainer` keeps jellyfin-web's D-pad
        // navigation (layout=tv) inside it, and tabindex=-1 lets it hold focus as a fallback.
        help.setAttribute('role', 'dialog');
        help.setAttribute('aria-modal', 'true');
        help.setAttribute('aria-label', 'Jellyfin Enhanced');
        help.className = 'focuscontainer';
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
        // Listeners bound outside the panel element (matchMedia and friends) that
        // removing the panel would otherwise leak; drained on every close path.
        const panelMediaCleanups = [];
        const runPanelCleanups = () => {
            while (panelMediaCleanups.length) panelMediaCleanups.pop()();
        };

        const resetAutoCloseTimer = () => {
            if (autoCloseTimer) clearTimeout(autoCloseTimer);
            autoCloseTimer = setTimeout(() => {
                if (!isMouseInside && document.getElementById(panelId)) {
                    closePanel();
                }
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
        // Keyboard, D-pad and touch use count as activity too, not only the mouse.
        help.addEventListener('keydown', resetAutoCloseTimer);
        help.addEventListener('focusin', resetAutoCloseTimer);
        help.addEventListener('touchstart', resetAutoCloseTimer, { passive: true });
        // Keyboard and focus use in a companion popup (the release notes, which shares the
        // panel's Tab cycle) is panel activity too.
        const companionActivity = (e) => {
            if (e.target instanceof Element && e.target.closest(PANEL_COMPANION_SELECTOR)) resetAutoCloseTimer();
        };
        document.addEventListener('keydown', companionActivity);
        document.addEventListener('focusin', companionActivity);
        panelMediaCleanups.push(() => {
            document.removeEventListener('keydown', companionActivity);
            document.removeEventListener('focusin', companionActivity);
        });

        // Shared context handed to the split panel modules
        // (ui-panel-template.js and the ui-panel-*.js wiring files).
        const ctx = {
            help,
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
            logoUrl,
            // Registers a callback run once when the panel closes (any close path).
            onPanelClose: (fn) => panelMediaCleanups.push(fn)
        };

        help.innerHTML = internal.buildPanelHtml(ctx);

        document.body.appendChild(help);

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
            phoneMedia.addEventListener('change', handlePhoneMediaChange);

            const activate = (pane, persist) => {
                panes.forEach(p => p.classList.toggle('active', p === pane));
                items.forEach(b => b.classList.toggle('active', b.dataset.tab === pane.dataset.pane));
                body.classList.add('je-pane-open');
                syncLayerFocus(persist);
                if (persist) writeLastOpenedTab(pane.dataset.pane);
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

            // Search filters the section list by each pane's full text.
            const search = help.querySelector('#jePanelSearch');
            if (search) {
                search.addEventListener('input', () => {
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
            const lastTab = readLastOpenedTab();
            const initial = panes.find(p => p.dataset.pane === lastTab) || panes[0];
            if (phoneMedia.matches) {
                panes.forEach(p => p.classList.remove('active'));
                syncLayerFocus(false);
            } else {
                activate(initial, false);
            }
            // Initial focus: the open section's nav item (the first one on a phone).
            const initialFocus = items.find(b => b.classList.contains('active')) || items[0];
            if (initialFocus) initialFocus.focus({ preventScroll: true });

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
        const closePanel = () => {
            if (autoCloseTimer) clearTimeout(autoCloseTimer);
            const focusWasInside = help.contains(document.activeElement);
            help.remove();
            if (closeOpenPanel === closePanel) closeOpenPanel = null;
            runPanelCleanups();
            document.removeEventListener('keydown', closeHelp);
            document.removeEventListener('keydown', trapFocus);
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
            if (!JE.pluginConfig.DisableAllShortcuts) {
                document.addEventListener('keydown', JE.keyListener, true);
            }
            // Focus returns to whatever opened the panel, unless the user had already moved it
            // elsewhere on the page.
            if (focusWasInside && opener instanceof HTMLElement && opener !== document.body && opener.isConnected) {
                opener.focus({ preventScroll: true });
            }
        };
        /**
         * Focus trap: Tab and Shift+Tab wrap around inside the panel; Tab from anywhere else on
         * the page (the panel is aria-modal) brings focus back into it. Focus in another dialog
         * (one opened on top of the panel) is left alone. Companion popups the panel opened
         * (`[data-je-panel-companion]`, e.g. the release notes) join the cycle after the panel,
         * so Tab moves from the panel's last control to the popup's first and back.
         * @param {KeyboardEvent} ev The document keydown.
         */
        const trapFocus = (ev) => {
            if (ev.key !== 'Tab' || ev.defaultPrevented) return;
            const active = document.activeElement;
            const roots = [help, ...document.querySelectorAll(PANEL_COMPANION_SELECTOR)];
            const activeRoot = roots.find(root => root.contains(active));
            if (!activeRoot && active instanceof Element && active.closest('dialog, [role="dialog"], [aria-modal="true"], .dialogContainer')) return;
            const cycle = roots.map(root => ({ root, ...tabbableEdges(root) })).filter(entry => entry.first);
            if (!cycle.length || cycle[0].root !== help) {
                ev.preventDefault();
                help.focus();
                return;
            }
            const at = cycle.findIndex(entry => entry.root === activeRoot);
            if (at === -1) {
                ev.preventDefault();
                (ev.shiftKey ? cycle[0].last : cycle[0].first).focus();
                return;
            }
            const { root, first, last } = cycle[at];
            if (active === root) {
                ev.preventDefault();
                (ev.shiftKey ? last : first).focus();
            } else if (ev.shiftKey && active === first) {
                ev.preventDefault();
                cycle[(at - 1 + cycle.length) % cycle.length].last.focus();
            } else if (!ev.shiftKey && active === last) {
                ev.preventDefault();
                cycle[(at + 1) % cycle.length].first.focus();
            }
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
        document.addEventListener('keydown', trapFocus);
        document.getElementById('closeSettingsPanel').addEventListener('click', closeHelp);
        closeOpenPanel = closePanel;

        if (!JE.pluginConfig.DisableAllShortcuts) {
            document.removeEventListener('keydown', JE.keyListener, true);
        }
        ctx.createToast = createToast;

        internal.wireSettingsListeners(ctx);
        internal.wireHiddenContentListeners(ctx);
        JE.internals.spoilerGuard?.wireSettings?.(ctx);
        internal.wireMiscSettingsControls(ctx);
        internal.wireLanguageControls(ctx);
        // After the wiring above, which sets the controls' initial state: locks and gates disable rows.
        internal.decorateSettingsProvenance?.(ctx);

        // 'loading': opened right after a user switch and the refresh above failed too.
        const settingsStatus = JE.userConfig?.settingsStatus;
        if (settingsStatus === 'unavailable' || settingsStatus === 'loading') {
            // Retry = close and open again: opening re-fetches the settings first.
            showSettingsUnavailable(help, (ev) => {
                ev.stopPropagation(); // the panel's own click handler would re-arm its auto-close timer
                closePanel();
                JE.showEnhancedPanel();
            });
        }
    };
})(window.JellyfinEnhanced);
