/**
 * @file Settings/help panel host (JE.showEnhancedPanel): open/close lifecycle,
 * settings refresh, dragging, auto-close, tab switching; delegates the
 * HTML template and section wiring to the ui-panel-*.ts modules.
 * The host owns the one dialog contract every section relies on: dialog
 * semantics, initial focus, Tab kept inside, the page behind inert while it
 * is open, focus given back on close, and
 * the settings search (sections add their controls through ctx.registerSearch).
 */
import { apiClient, panelHost, registry, settingsDocumentContract, settingsPanelContext, type PanelBridge } from './host';
import type { PanelContext, SearchHit, SearchProvider } from './context';
import { closestTarget, queryButton, queryElement, queryElements, querySelect, queryInput } from '../shared/dom';
import { isTextEntryType, paneSlug, shouldApplyRefresh } from './panel-refresh';
import { pluginShortcutList } from './shortcut-rules';

type Deps = Pick<PanelBridge, 'internals' | 'session' | 'userConfig' | 'currentSettings' | 'toCamelCase' | 'loadSettings'
    | 'initializeShortcuts' | 'themer' | 'pluginConfig' | 'state' | 'CONFIG' | 'core' | 'keyListener' | 'saveUserSettings'
    | 't' | 'toast' | 'getSettingsSaveState' | 'showEnhancedPanel'>;

const PANEL_ID = 'jellyfin-enhanced-panel';
const POINTER_EVENTS = ['pointerdown', 'mousedown', 'click'] as const;
const MAX_RESULTS = 8;

export function installUiPanel(JE: Deps, featureCtx = settingsPanelContext(JE)): void {
    const internal = registry(JE);

    /** Closes the open panel through its full teardown. */
    let closeOpenPanel: (() => void) | null = null;
    let cancelOpening: (() => void) | null = null;

    /** Read policy from the host, a previously validated document, or authenticated Users/Me. */
    async function hostAdministrator(client: ReturnType<typeof apiClient>): Promise<boolean> {
        const flagOf = (user: unknown): boolean | undefined => {
            const policy: unknown = user !== null && typeof user === 'object' ? Reflect.get(user, 'Policy') : undefined;
            const flag: unknown = policy !== null && typeof policy === 'object' ? Reflect.get(policy, 'IsAdministrator') : undefined;
            return typeof flag === 'boolean' ? flag : undefined;
        };
        if (typeof client.getCurrentUser === 'function') {
            const flag = flagOf(await client.getCurrentUser());
            if (flag !== undefined) return flag;
        }
        const loadedFlag = JE.userConfig?.settings?.isAdmin;
        if (JE.userConfig?.settingsRevision && typeof loadedFlag === 'boolean') return loadedFlag;
        const flag = flagOf(await client.ajax({ type: 'GET', url: client.getUrl('/Users/Me'), dataType: 'json' }));
        if (flag === undefined) throw new Error('Current user policy unavailable. Please reopen settings to retry.');
        return flag;
    }

    /**
     * Fetch the user's settings document with its revision and replace the
     * loaded one when another session changed it (see shouldApplyRefresh).
     * The legacy unrevisioned GET of settings.json replaced the content but
     * kept the old revision, so the panel's next save failed as a conflict.
     */
    async function refreshSettings(currentUserId: string, sameOpeningIdentity: () => boolean): Promise<boolean> {
        const client = apiClient();
        const startRevision = JE.userConfig?.settingsRevision;
        const startedSettings = JE.currentSettings;
        const startedDocument = JE.userConfig;
        const startedState = JE.getSettingsSaveState?.();
        if (startedState?.pending) return true;
        const startedContents = JSON.stringify(startedSettings);
        const mayReplace = () => {
            const state = JE.getSettingsSaveState?.();
            return sameOpeningIdentity() && JE.currentSettings === startedSettings && JE.userConfig === startedDocument
                && !state?.pending && state?.version === startedState?.version
                && JSON.stringify(startedSettings) === startedContents;
        };
        const response = await client.ajax({
            type: 'GET',
            url: client.getUrl(`/JellyfinEnhanced/user-settings/${currentUserId}/settings-document?_=${Date.now()}`),
            dataType: 'json'
        });
        if (!sameOpeningIdentity()) return false;
        // No document: nothing to refresh (the loaded one stays).
        if (!response) {
            if (!startRevision) throw new Error('Settings document unavailable. Please reopen settings to retry.');
            return true;
        }
        const contract = settingsDocumentContract();
        if (!contract) throw new Error('Settings validator unavailable');
        // The document must carry the caller's authority: the host's own user policy, as
        // the loader checks it, else the flag of the document the page loaded with.
        const isAdmin = await hostAdministrator(client);
        if (!sameOpeningIdentity()) return false;
        const snapshot = contract.parseSettingsDocument(response, isAdmin);
        if (!mayReplace()) return true;
        if (!shouldApplyRefresh(startRevision, JE.userConfig?.settingsRevision, snapshot.Revision)) return true;
        const settings = JE.toCamelCase(snapshot.Settings);
        if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) throw new TypeError('Settings document is not an object');
        JE.userConfig = JE.userConfig || { shortcuts: { Shortcuts: [] } };
        JE.userConfig.settings = { ...settings };
        JE.userConfig.settingsRevision = snapshot.Revision;
        // Reload current settings (a new loaded object with its inheritance state).
        if (typeof JE.loadSettings === 'function') {
            JE.currentSettings = JE.loadSettings();
        }
        return true;
    }

    /**
     * Toggles the main settings and help panel for the plugin.
     */
    JE.showEnhancedPanel = async () => {
        if (cancelOpening) { cancelOpening(); return; }
        if (document.getElementById(PANEL_ID)) {
            if (closeOpenPanel) closeOpenPanel();
            else document.getElementById(PANEL_ID)?.remove();
            return;
        }
        // Refresh user settings when panel opens to ensure correct user's settings are displayed
        const client = apiClient();
        const currentUserId = client.getCurrentUserId();
        const openingEpoch = JE.session?.getEpoch();
        /** Read the host's server identity, including clients exposing it as a property. */
        const serverId = () => { const c = apiClient(); return typeof c.serverId === 'function' ? c.serverId() : c.serverId; };
        const openingServerId = serverId();
        const openingUrl = client.getUrl('/');
        const openingToken = client.accessToken?.();
        const openingHash = window.location.hash;
        let cancelled = false;
        let stopOpeningNavigation: (() => void) | undefined;
        const releaseOpening = () => {
            stopOpeningNavigation?.();
            stopOpeningNavigation = undefined;
            window.removeEventListener('hashchange', cancel);
            window.removeEventListener('popstate', cancel);
            window.removeEventListener('pagehide', cancelOnUnload);
            if (cancelOpening === cancel) cancelOpening = null;
        };
        const cancel = () => { cancelled = true; releaseOpening(); };
        // Only the document's own pagehide (its target is the document): jellyfin-web dispatches a bubbling one on the view
        // it leaves after the address has changed, and a back/forward-cache hide (persisted) may be shown again.
        const cancelOnUnload = (event: PageTransitionEvent) => {
            if ((event.target === window || event.target === document) && !event.persisted) cancel();
        };
        cancelOpening = cancel;
        stopOpeningNavigation = JE.core?.navigation?.onNavigate(cancel);
        window.addEventListener('hashchange', cancel);
        window.addEventListener('popstate', cancel);
        window.addEventListener('pagehide', cancelOnUnload);
        /** Reject replies from an earlier session, even after an A → B → A switch. */
        const sameOpeningIdentity = () => !cancelled && apiClient() === client
            && client.getCurrentUserId() === currentUserId && client.getUrl('/') === openingUrl
            && client.accessToken?.() === openingToken && window.location.hash === openingHash
            && serverId() === openingServerId && JE.session?.getEpoch() === openingEpoch;
        try {
            if (currentUserId && !await refreshSettings(currentUserId, sameOpeningIdentity)) return;
        } catch (e) {
            if (!sameOpeningIdentity()) return;
            console.warn("🪼 Jellyfin Enhanced: Could not refresh settings for panel display:", e);
            if (!JE.userConfig?.settingsRevision) {
                const key = 'toast_settings_load_failed';
                const translated = JE.t(key);
                JE.toast?.(translated && translated !== key ? translated : 'Settings could not be loaded. Please try opening the panel again.');
                return;
            }
        } finally { releaseOpening(); }

        if (!sameOpeningIdentity()) return;

        // Re-initialize shortcuts to ensure they're populated before building the panel
        if (typeof JE.initializeShortcuts === 'function') {
            JE.initializeShortcuts();
        }

        const existing = document.getElementById(PANEL_ID);
        if (existing) {
            if (closeOpenPanel) closeOpenPanel();
            else existing.remove();
            return;
        }
        // Get theme-appropriate styles
        const themeVars = JE.themer.getThemeVariables();

        // Define theme-aware variables
        const primaryAccentColor = themeVars.primaryAccent;
        const theme = {
            panelBgColor: themeVars.panelBg,
            headerFooterBg: themeVars.secondaryBg,
            detailsBackground: themeVars.secondaryBg,
            primaryAccentColor,
            toggleAccentColor: primaryAccentColor,
            kbdBackground: themeVars.altAccent,
            presetBoxBackground: themeVars.altAccent,
            githubButtonBg: `rgba(102, 179, 255, 0.1)`,
            releaseNotesBg: primaryAccentColor,
            checkUpdatesBorder: `1px solid ${primaryAccentColor}`,
            releaseNotesTextColor: themeVars.textColor,
            logoUrl: themeVars.logo
        };
        const panelBlurValue = themeVars.blur;

        // Focus goes back here when the panel closes (the menu button that opened it).
        const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
        const help = document.createElement('div');
        help.id = PANEL_ID;
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
            // The dialog clips its rounded frame but must never become an
            // extra scroll container when a focused control is re-presented.
            overflow: 'clip',
            display: 'flex',
            fontFamily: 'inherit',
            flexDirection: 'column'
        });

        const pluginShortcuts = pluginShortcutList(JE.pluginConfig.Shortcuts);

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
        let autoCloseTimer: ReturnType<typeof setTimeout> | null = null;
        let isMouseInside = false;
        // Listeners bound outside the panel element (matchMedia and friends) and
        // section teardowns (ctx.onClose) that removing the panel would otherwise
        // leak; drained on every close path.
        const panelMediaCleanups: Array<() => void> = [];
        const runPanelCleanups = () => {
            for (let cleanup = panelMediaCleanups.pop(); cleanup; cleanup = panelMediaCleanups.pop()) cleanup();
        };

        // --- The page behind is inert while the dialog is open ---------
        // Native inert retargets background clicks to body; newly appended
        // controls also belong to the background. Guard by dialog containment,
        // rather than membership in the list of nodes made inert at opening.
        /** Body children this panel made inert. */
        const inertBackground: HTMLElement[] = [];
        /** The last control focused inside the dialog. */
        let lastFocusInside: HTMLElement | null = null;
        const isInside = (target: EventTarget | null) => target instanceof Node && help.contains(target);
        /** Restore focus after an outside press, script focus or destinationless blur. */
        const restoreFocus = () => {
            if (!help.isConnected || isInside(document.activeElement)) return;
            const back = lastFocusInside && lastFocusInside.isConnected
                && help.contains(lastFocusInside) && !lastFocusInside.matches(':disabled')
                && !lastFocusInside.closest('[inert], [hidden]')
                ? lastFocusInside : help;
            back.focus({ preventScroll: true });
            // A control disabled since it last had focus cannot take focus again.
            if (!isInside(document.activeElement)) help.focus({ preventScroll: true });
        };
        /** Remember the most recent control inside the active dialog. */
        const trackFocusInside = (e: FocusEvent) => {
            if (e.target instanceof HTMLElement) lastFocusInside = e.target;
        };
        /** Reject focus into any element outside the dialog, including late additions. */
        const guardFocus = (e: FocusEvent) => {
            if (!isInside(e.target)) restoreFocus();
        };
        /** A blur to body need not emit focusin; wait for the browser's focus move to finish. */
        const guardBlur = (e: FocusEvent) => {
            if (!isInside(e.relatedTarget)) queueMicrotask(restoreFocus);
        };
        /** Prevent outside activation and the default pointer action that blurs to body. */
        const guardPointer = (e: Event) => {
            if (isInside(e.target)) return;
            e.preventDefault();
            e.stopPropagation();
            restoreFocus();
        };
        /** Hold the page and install the active dialog's focus/pointer boundary. */
        const holdBackground = () => {
            for (const node of Array.from(document.body.children)) {
                if (node === help || !(node instanceof HTMLElement) || node.hasAttribute('inert')) continue;
                node.setAttribute('inert', '');
                inertBackground.push(node);
            }
            help.addEventListener('focusin', trackFocusInside);
            help.addEventListener('focusout', guardBlur);
            document.addEventListener('focusin', guardFocus, true);
            for (const type of POINTER_EVENTS) document.addEventListener(type, guardPointer, true);
        };
        /** Release only nodes held by this dialog and remove every boundary listener. */
        const releaseBackground = () => {
            for (let node = inertBackground.pop(); node; node = inertBackground.pop()) node.removeAttribute('inert');
            help.removeEventListener('focusin', trackFocusInside);
            help.removeEventListener('focusout', guardBlur);
            document.removeEventListener('focusin', guardFocus, true);
            for (const type of POINTER_EVENTS) document.removeEventListener(type, guardPointer, true);
        };

        let closed = false;
        /**
         * Close this panel: every close path (Escape/?, the close button,
         * auto-close, navigation, the toggle) goes through here.
         */
        const closePanel = () => {
            if (closed) return;
            closed = true;
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
            if (closed) return;
            if (autoCloseTimer) clearTimeout(autoCloseTimer);
            // setTimeout coerces the configured delay exactly like Number().
            autoCloseTimer = setTimeout(() => {
                if (!isMouseInside && document.getElementById(PANEL_ID)) closePanel();
            }, Number(JE.CONFIG.HELP_PANEL_AUTOCLOSE_DELAY));
        };

        // The grab affordance lives on the header, the only draggable surface.
        const setHeaderCursor = (cursor: string) => {
            const header = queryElement(help, '.panel-header');
            if (header) header.style.cursor = cursor;
        };

        const handleMouseDown = (e: MouseEvent) => {
            // Drag only from the header bar: the panes host interactive surfaces
            // (subtitle position grid, selects, sliders) that must own their own
            // pointer gestures — a blanket panel-drag steals them now that the
            // old <details> exclusion no longer matches the pane markup.
            if (!closestTarget(e, '.panel-header')) return;
            if (closestTarget(e, '.preset-box, button, a, input, select')) return;
            isDragging = true;
            offset = { x: e.clientX - help.getBoundingClientRect().left, y: e.clientY - help.getBoundingClientRect().top };
            setHeaderCursor('grabbing');
            e.preventDefault();
            resetAutoCloseTimer();
        };

        const handleMouseMove = (e: MouseEvent) => {
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
         */
        const searchProviders: SearchProvider[] = [];

        const createToast = (featureKey: string, isEnabled: boolean) => {
            const feature = JE.t(featureKey);
            const status = JE.t(isEnabled ? 'status_enabled' : 'status_disabled');
            return JE.t('toast_feature_status', { feature, status });
        };

        // Shared context handed to the split panel modules
        // (ui-panel-template.ts and the ui-panel-*.ts wiring files).
        const ctx: PanelContext = {
            help,
            pluginShortcuts,
            resetAutoCloseTimer,
            onClose: (fn) => { panelMediaCleanups.push(fn); },
            closePanel: () => closePanel(),
            /**
             * Let the settings search find a section's controls. Choosing a
             * result opens the provider's pane first, then runs the result.
             * Returns a function that unregisters it.
             */
            registerSearch: (provider) => {
                searchProviders.push(provider);
                return () => { const i = searchProviders.indexOf(provider); if (i >= 0) searchProviders.splice(i, 1); };
            },
            /** Show a pane by its data-pane slug (set by the section nav below). */
            openPane: () => false,
            createToast,
            ...theme
        };

        help.innerHTML = internal.buildPanelHtml ? internal.buildPanelHtml(ctx) : '';

        document.body.appendChild(help);
        closeOpenPanel = closePanel;
        holdBackground();
        const stopNavigation = JE.core?.navigation?.onNavigate(closePanel);
        if (stopNavigation) panelMediaCleanups.push(stopNavigation);
        // The dialog itself takes focus first (no ring: it is not a control).
        help.focus({ preventScroll: true });

        // Keep Tab inside the dialog: past the last control it wraps to the
        // first, and Shift+Tab before the first wraps to the last. Hidden and
        // inert controls (the phone layer not shown) don't count.
        const tabbables = () => {
            // An unchecked radio is skipped by Tab when its group has a checked one.
            const checkedGroups = new Set(queryElements(help, 'input[type="radio"]:checked').map((r) => r instanceof HTMLInputElement ? r.name : ''));
            return queryElements(help, 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')
                .filter((el) => !el.closest('[inert], [hidden]') && el.getClientRects().length > 0
                    && !(el instanceof HTMLInputElement && el.type === 'radio' && !el.checked && checkedGroups.has(el.name)));
        };
        help.addEventListener('keydown', (e) => {
            if (e.key !== 'Tab') return;
            const list = tabbables();
            const first = list[0];
            const last = list[list.length - 1];
            if (!first || !last) return;
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
        internal.wireShortcutEditor?.(ctx);
        resetAutoCloseTimer();

        // --- Section navigation (adaptive settings view) ---
        // The nav rail is built FROM the panes, so nav and content can never
        // drift: every .je-pane's title becomes a nav item (icon included).
        (function buildSectionNav() {
            const navHost = queryElement(help, '.je-panel-nav-items');
            const body = queryElement(help, '.je-panel-body');
            const panes = queryElements(help, '.je-pane');
            if (!navHost || !body || panes.length === 0) return;

            const items: HTMLButtonElement[] = [];

            // Phone-mode focus ownership: the list and the detail pane are stacked
            // layers, so exactly one of them may own focus at a time. `inert`
            // removes the hidden layer from the tab order and the a11y tree;
            // desktop shows both columns side by side, so neither is inert there.
            const navColumn = queryElement(help, '.je-panel-nav');
            const mainColumn = queryElement(help, '.je-panel-main');
            const phoneMedia = window.matchMedia('(max-width: 760px)');
            const dock = queryElement(help, '.je-panel-dock');
            const sectionSelect = querySelect(help, '#jePanelSection');
            const searchInput = queryInput(help, '#jePanelSearch');
            const searchResults = queryElement(help, '#jePanelSearchResults');
            const syncLayerFocus = (moveFocus: boolean) => {
                if (!navColumn || !mainColumn) return;
                if (dock && searchInput && searchResults) {
                    if (phoneMedia.matches) dock.append(searchInput, searchResults);
                    else navColumn.prepend(searchInput, searchResults);
                }
                if (phoneMedia.matches) {
                    const detailOpen = body.classList.contains('je-pane-open');
                    navColumn.inert = detailOpen;
                    mainColumn.inert = !detailOpen;
                    if (moveFocus) {
                        const target = detailOpen
                            ? queryElement(help, '#jePanelBack')
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

            const activate = (pane: HTMLElement, persist: boolean) => {
                panes.forEach(p => p.classList.toggle('active', p === pane));
                items.forEach(b => b.classList.toggle('active', b.dataset.tab === pane.dataset.pane));
                if (sectionSelect) sectionSelect.value = pane.dataset.pane ?? '';
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
                if (!pane.dataset.pane) pane.dataset.pane = paneSlug(label) || `pane-${index}`;
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
                const pointer = closestTarget(e, '[data-je-open-pane]');
                if (!pointer) return;
                const slug = pointer.dataset.jeOpenPane ?? '';
                ctx.openPane(slug);
                const pane = panes.find(p => p.dataset.pane === slug);
                const heading = (pane && (queryElement(pane, '[role="tab"][aria-selected="true"]') || queryElement(pane, '.je-pane-title'))) || null;
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
            const search = searchInput;
            const results = searchResults;
            const renderResults = (query: string) => {
                if (!results) return;
                const found: Array<SearchHit & { pane: string }> = [];
                if (query) {
                    for (const provider of searchProviders) {
                        try {
                            for (const hit of provider.search(query) || []) found.push({ label: hit.label, path: hit.path, run: () => hit.run(), pane: provider.pane });
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
                    const first = results ? queryButton(results, 'button') : null;
                    if (!first) return;
                    if (e.key === 'Enter') { e.preventDefault(); first.click(); }
                    else if (e.key === 'ArrowDown') { e.preventDefault(); first.focus(); }
                });
                results?.addEventListener('keydown', (e) => {
                    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
                    const buttons = queryElements(results, 'button');
                    const at = buttons.findIndex(button => button === document.activeElement);
                    if (at < 0) return;
                    e.preventDefault();
                    const next = at + (e.key === 'ArrowDown' ? 1 : -1);
                    (next < 0 ? search : buttons[Math.min(next, buttons.length - 1)])?.focus();
                });
            }

            // Initial view: desktop restores the last-open section; a phone-sized
            // viewport starts on the section list (nothing pre-opened).
            const lastTab = JE.currentSettings.lastOpenedTab;
            const initial = panes.find(p => p.dataset.pane === lastTab) || panes[0];
            if (phoneMedia.matches) {
                panes.forEach(p => p.classList.remove('active'));
                syncLayerFocus(false);
            } else if (initial) {
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
        const isEditableKeyboardTarget = (target: EventTarget | null) => target instanceof HTMLElement
            && isTextEntryType(target.tagName, target instanceof HTMLInputElement ? target.type : '', target.isContentEditable);
        const closeHelp = (ev: Event) => {
            const keyboardClose = ev instanceof KeyboardEvent && ev.type === 'keydown'
                && (ev.key === 'Escape' || (ev.key === '?' && !isEditableKeyboardTarget(ev.target)));
            if (keyboardClose || (ev.type === 'click' && ev.target instanceof Element && ev.target.id === 'closeSettingsPanel')) {
                ev.stopPropagation();
                closePanel();
            }
        };

        document.addEventListener('keydown', closeHelp);
        const closeButton = document.getElementById('closeSettingsPanel');
        if (!closeButton) throw new TypeError('Missing panel control #closeSettingsPanel');
        closeButton.addEventListener('click', closeHelp);

        if (!JE.pluginConfig.DisableAllShortcuts) {
            document.removeEventListener('keydown', JE.keyListener, true);
        }

        internal.wireSettingsListeners?.(ctx);
        internal.wireTagLooks?.(ctx);
        internal.wireHiddenContentListeners?.(ctx);
        featureCtx.peer('spoilerBlur')?.wireSettings?.(ctx);
        internal.wireMiscSettingsControls?.(ctx);
        internal.wireTagGroupEditor?.(ctx);
        internal.wireLanguageControls?.(ctx);
        // Last: the hub drives the tag sections wired above (tab switches, search).
        internal.wireMediaTagsHub?.(ctx);
    };
}

installUiPanel(panelHost());
