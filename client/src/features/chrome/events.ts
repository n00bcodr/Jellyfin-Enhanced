import { captureIdentity, hostClient, isSameIdentity, type ChromeSession, type EventsContext, type IdentitySnapshot, type BodyMutationCallback, type Unsubscribe } from './host';

/** Home surface context captured on a card's menu trigger for the next action sheet. */
export interface RemoveContext { itemId: string; surface: unknown; card: Element; ts: number }
type PressHandler = (event: Event) => void;

/** The JE facade members the core event wiring reads and publishes. */
export interface EventsBridge {
    session?: ChromeSession;
    internals?: { canonicalCombo?: (combo: unknown) => unknown };
    /** The same function, published as chrome's facade for the settings panel's shortcut editor (step C4). */
    canonicalCombo?: (combo: unknown) => unknown;
    state: { activeShortcuts?: Record<string, unknown>; removeContext?: RemoveContext | null };
    pluginConfig: { ClearLocalStorageTimestamp?: unknown; DisableAllShortcuts?: unknown };
    currentSettings: {
        removeContinueWatchingEnabled?: unknown; longPress2xEnabled?: unknown;
        autoPauseEnabled?: unknown; autoResumeEnabled?: unknown; autoPipEnabled?: unknown;
    };
    keyCombo(event: KeyboardEvent): string;
    t(key: string): string;
    toast(message: string): void;
    icon?(name: unknown): string;
    IconName?: { LINK?: unknown };
    isVideoPage(): boolean;
    showEnhancedPanel?(): void;
    cycleAspect?(): void; togglePlaybackInfo?(): void;
    cycleSubtitleTrack?(): void; cycleAudioTrack?(): void;
    resetPlaybackSpeed?(): void; adjustPlaybackSpeed?(direction: 'increase' | 'decrease'): void;
    skipIntroOutro?(): void; frameStep?(direction: 'back' | 'forward'): void;
    jumpToLastPosition?(): void; jumpToPercentage?(percent: number): void;
    addOsdSettingsButton?(): void; initializeAutoSkipObserver?(): void; applySavedStylesWhenReady?(): void;
    attachSeekTracker?(video: HTMLVideoElement): void; stopAutoSkip?(): void;
    addRandomButton?(): void; addUserPreferencesLink?(): void;
    injectGlobalStyles?(): void; addPluginMenuButton?(): void; addUserMenuLink?(): void;
    addRemoveButton?(): void; addMultiSelectRemoveButton?(): void;
    detectCardSurface?(card: Element): unknown;
    handleLongPressDown?: PressHandler; handleLongPressUp?: PressHandler; handleLongPressMove?: PressHandler;
    handleLongPressClick?: PressHandler; handleLongPressCancel?: PressHandler;
    helpers: {
        createObserver(id: string, callback: () => void, target: Node, options: MutationObserverInit): unknown;
        throttle(callback: () => void, limit: number): () => void;
        onBodyMutation(id: string, callback: BodyMutationCallback, options?: { priority?: number }): Unsubscribe | unknown;
    };
    keyListener?: (event: KeyboardEvent) => void;
    initializeEnhancedScript?: () => void;
}

const MODIFIER_ORDER = ['Meta', 'Ctrl', 'Alt', 'Shift'] as const;

/**
 * Rewrite a stored shortcut ("Shift+Ctrl+S", "Ctrl+Shift+S") as its modifier set in the
 * shortcut editor's order followed by the key, so any typed modifier order matches the
 * runtime combo. Anything but a non-empty string is returned unchanged.
 */
export function canonicalCombo(combo: unknown): unknown {
    if (typeof combo !== 'string' || !combo) return combo;
    const modifiers = new Set<string>();
    let rest = combo;
    let match: RegExpExecArray | null;
    // A trailing "+" is the key itself ("Ctrl++"), never a separator.
    while ((match = /^(Meta|Ctrl|Alt|Shift)\+(?=.)/.exec(rest))) {
        modifiers.add(match[1] ?? '');
        rest = rest.slice(match[0].length);
    }
    const key = /^[a-zA-Z]$/.test(rest) ? rest.toUpperCase() : rest;
    return MODIFIER_ORDER.filter(name => modifiers.has(name)).map(name => name + '+').join('') + key;
}
export function canonicalShortcuts(active: Record<string, unknown> | undefined): Record<string, unknown> {
    const canonical: Record<string, unknown> = {};
    for (const [name, combo] of Object.entries(active || {})) canonical[name] = canonicalCombo(combo);
    return canonical;
}

const isTyping = (): boolean => ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName ?? '');
const SHEET_SELECTOR = '.actionSheet, .actionSheetScroller, .dialogContainer';

export function createEvents(ctx: EventsContext) {
    const JE = ctx.core;
    let installed = false;

    /** Always active: opens the panel unless it is open or the user is typing. */
    function panelKeyListener(event: KeyboardEvent): void {
        if (document.getElementById('jellyfin-enhanced-panel') || isTyping()) return;
        if (event.key === '?') {
            event.preventDefault();
            event.stopPropagation();
            JE.showEnhancedPanel?.();
        }
    }

    /** Player-only actions in their baseline priority order; the first matching binding wins. */
    function playerActions(event: KeyboardEvent): Array<[string, () => void]> {
        return [
            ['BookmarkCurrentTime', () => {
                const bookmarks = ctx.peer('bookmarks');
                if (bookmarks?.showModal) bookmarks.showModal('add');
                else console.warn('🪼 Jellyfin Enhanced: New bookmark system not loaded, using fallback');
            }],
            ['CycleAspectRatio', () => JE.cycleAspect?.()],
            // Toggles the plugin-rendered playback-info overlay; no host settings menu opens.
            ['ShowPlaybackInfo', () => JE.togglePlaybackInfo?.()],
            ['SubtitleMenu', () => {
                const open = [...document.querySelectorAll('.actionSheetContent .actionSheetTitle')].find(el => el.textContent === 'Subtitles');
                if (open) {
                    document.querySelector('.dialogBackdrop.dialogBackdropOpened')?.remove();
                    document.querySelector('.dialogContainer')?.remove();
                } else {
                    document.querySelector<HTMLElement>('button.btnSubtitles')?.click();
                }
            }],
            // Never on auto-repeat: each cycle is a real stream switch (transcode restarts).
            ['CycleSubtitleTracks', () => { if (!event.repeat) JE.cycleSubtitleTrack?.(); }],
            ['CycleAudioTracks', () => { if (!event.repeat) JE.cycleAudioTrack?.(); }],
            ['ResetPlaybackSpeed', () => JE.resetPlaybackSpeed?.()],
            ['IncreasePlaybackSpeed', () => JE.adjustPlaybackSpeed?.('increase')],
            ['DecreasePlaybackSpeed', () => JE.adjustPlaybackSpeed?.('decrease')],
            ['OpenEpisodePreview', () => {
                const focus = document.getElementById('popupFocusContainer');
                if (focus?.classList.contains('opened')) {
                    // Current InPlayerEpisodePreview wraps everything in #previewPopup;
                    // older versions add a separate backdrop and dialog container.
                    const popup = document.getElementById('previewPopup');
                    if (popup) popup.remove();
                    else {
                        document.getElementById('dialogBackdropContainer')?.remove();
                        document.getElementById('dialogContainer')?.remove();
                    }
                } else {
                    document.querySelector<HTMLElement>('button#popupPreviewButton.autoSize.paper-icon-button-light[is="paper-icon-button-light"]')?.click();
                }
            }],
            ['SkipIntroOutro', () => JE.skipIntroOutro?.()],
            ['FrameStepBack', () => JE.frameStep?.('back')],
            ['FrameStepForward', () => JE.frameStep?.('forward')],
            ['JumpToLastPosition', () => JE.jumpToLastPosition?.()]
        ];
    }

    /** The main shortcut listener; JE.keyListener keeps this identity for add/remove callers. */
    function keyListener(event: KeyboardEvent): void {
        if (isTyping()) return;
        // A key recorder (admin shortcut grid) is capturing the next press.
        if (document.activeElement?.hasAttribute('data-je-key-recorder')) return;
        const key = event.key;
        const combo = JE.keyCombo(event);
        const video = document.querySelector('video');
        const shortcuts = canonicalShortcuts(JE.state.activeShortcuts);

        if (combo === shortcuts.OpenSearch) {
            event.preventDefault();
            document.querySelector<HTMLElement>('button.headerSearchButton')?.click();
            setTimeout(() => document.querySelector<HTMLElement>('input[type="search"]')?.focus(), 100);
            JE.toast(JE.t('toast_search'));
        } else if (combo === shortcuts.GoToHome) {
            event.preventDefault();
            window.location.hash = '#/home.html';
            JE.toast(JE.t('toast_home'));
        } else if (combo === shortcuts.GoToDashboard) {
            event.preventDefault();
            window.location.hash = '#/dashboard';
            JE.toast(JE.t('toast_dashboard'));
        } else if (combo === shortcuts.QuickConnect) {
            event.preventDefault();
            window.location.hash = '#/quickconnect';
            JE.toast(`${JE.icon?.(JE.IconName?.LINK) ?? ''} Quick Connect`);
        } else if (combo === shortcuts.PlayRandomItem && !JE.isVideoPage()) {
            event.preventDefault();
            document.getElementById('randomItemButton')?.click();
        }

        if (!JE.isVideoPage() || !video) return;
        const action = playerActions(event).find(([name]) => combo === shortcuts[name]);
        if (action) {
            event.preventDefault();
            event.stopImmediatePropagation();
            action[1]();
        }
        if (shortcuts.JumpToPercentage !== '' && !event.altKey && !event.ctrlKey && !event.metaKey && /^[0-9]$/.test(key)) {
            JE.jumpToPercentage?.(parseInt(key, 10) * 10);
        }
    }

    function setupDOMObserver(): void {
        const runPageSpecificFunctions = (): void => {
            if (JE.isVideoPage()) {
                JE.addOsdSettingsButton?.();
                JE.initializeAutoSkipObserver?.();
                JE.applySavedStylesWhenReady?.();
                const video = document.querySelector('video');
                if (video) JE.attachSeekTracker?.(video);
            } else {
                JE.stopAutoSkip?.();
            }
        };
        JE.helpers.createObserver('dom-observer', JE.helpers.throttle(() => {
            runPageSpecificFunctions();
            JE.addRandomButton?.();
            JE.addUserPreferencesLink?.();
        }, 100), document.body, { childList: true, subtree: true });
    }

    /**
     * Inject the "Remove" item into opening action sheets. Coalesced onto a frame,
     * which runs after the mutation and before the sheet's first paint; priority
     * keeps the body subscription synchronous for the same reason.
     */
    function observeActionSheets(): void {
        let scheduled = false;
        const runInjection = (): void => {
            scheduled = false;
            if (!JE.currentSettings.removeContinueWatchingEnabled) return;
            if (typeof JE.addRemoveButton === 'function') JE.addRemoveButton();
            else console.warn('🪼 Jellyfin Enhanced: addRemoveButton not available');
            // Also the multi-select / long-press menu on touch devices.
            if (typeof JE.addMultiSelectRemoveButton === 'function') JE.addMultiSelectRemoveButton();
        };
        const touchesActionSheet = (mutations: MutationRecord[]): boolean => {
            for (const mutation of mutations) {
                if (mutation.target instanceof Element && mutation.target.closest(SHEET_SELECTOR)) return true;
                for (const node of mutation.addedNodes) {
                    if (node instanceof Element && (node.matches(SHEET_SELECTOR) || node.querySelector(SHEET_SELECTOR))) return true;
                }
            }
            return false;
        };
        JE.helpers.onBodyMutation('action-sheets', mutations => {
            if (scheduled || !touchesActionSheet(mutations)) return;
            scheduled = true;
            requestAnimationFrame(runInjection);
        }, { priority: 1 });
    }

    /** Capture which home surface a card belongs to, on the menu trigger: the only moment the card is known. */
    function addContextMenuListener(): void {
        const capture = (itemElement: Element | null): void => {
            if (!itemElement) { JE.state.removeContext = null; return; }
            const card = itemElement.closest('.card') || itemElement;
            const itemId = (card instanceof HTMLElement ? card.dataset.id : undefined)
                || (itemElement instanceof HTMLElement ? itemElement.dataset.id : undefined) || null;
            if (!itemId) { JE.state.removeContext = null; return; }
            const surface = typeof JE.detectCardSurface === 'function' ? JE.detectCardSurface(card) : null;
            JE.state.removeContext = { itemId, surface, card, ts: Date.now() };
            if (surface) console.log(`🪼 Jellyfin Enhanced: ${String(surface)} item detected for Remove action sheet:`, itemId);
        };
        // Clicks inside an open sheet/dialog are menu interactions, not card triggers.
        const insideOpenMenu = (target: Element): boolean => !!target.closest('.actionSheetContent, .actionSheet, .dialogContainer, dialog');
        document.body.addEventListener('mousedown', event => {
            if (!JE.currentSettings.removeContinueWatchingEnabled || !(event.target instanceof Element)) return;
            const menuButton = event.target.closest('button[data-action="menu"]');
            if (!menuButton) return;
            capture(menuButton.closest('.card[data-id]') || menuButton.closest('[data-id]'));
        }, true);
        document.body.addEventListener('contextmenu', event => {
            if (!JE.currentSettings.removeContinueWatchingEnabled || !(event.target instanceof Element)) return;
            if (insideOpenMenu(event.target)) return;
            capture(event.target.closest('.card[data-id]'));
        }, true);
    }

    function clearLocalStorageIfRequested(): void {
        try {
            const serverClear = Number(JE.pluginConfig.ClearLocalStorageTimestamp) || 0;
            const localCleared = parseInt(localStorage.getItem('jellyfinEnhancedLastCleared') || '0', 10);
            if (serverClear > localCleared) {
                localStorage.removeItem('jellyfinEnhancedSettings');
                localStorage.setItem('jellyfinEnhancedLastCleared', serverClear.toString());
            }
        } catch (error) {
            // Blocked storage must not stop shortcuts and observers from installing.
            console.warn('🪼 Jellyfin Enhanced: Could not apply the local-storage reset request:', error);
        }
    }

    /**
     * Long-press 2x is a physical gesture on the player. Listeners are always
     * installed and resolve JE's press handlers per event; the player gates the
     * press on the signed-in user's current setting (CHR-EVENTS-1).
     */
    function installLongPress(): void {
        const onVideoPage = (name: 'handleLongPressDown' | 'handleLongPressUp' | 'handleLongPressMove' | 'handleLongPressClick' | 'handleLongPressCancel') => (event: Event): void => {
            if (!JE.isVideoPage()) return;
            // Synthetic events (dialog helpers replaying outside taps) neither arm nor cancel a press;
            // stopping them here would swallow them before the host's own listener.
            if (event.isTrusted === false) return;
            if (event.target instanceof Element && event.target.closest('.osdControls, .pause-screen-active, .jellyfin-enhanced-panel')) return;
            JE[name]?.(event);
        };
        document.addEventListener('mousedown', onVideoPage('handleLongPressDown'), true);
        document.addEventListener('mouseup', onVideoPage('handleLongPressUp'), true);
        document.addEventListener('mousemove', onVideoPage('handleLongPressMove'), true);
        document.addEventListener('click', onVideoPage('handleLongPressClick'), true);
        document.addEventListener('mouseleave', onVideoPage('handleLongPressCancel'), true);
        document.addEventListener('touchstart', onVideoPage('handleLongPressDown'), { capture: true, passive: true });
        document.addEventListener('touchmove', onVideoPage('handleLongPressMove'), { capture: true, passive: true });
        document.addEventListener('touchend', onVideoPage('handleLongPressUp'), { capture: true, passive: false });
        document.addEventListener('touchcancel', onVideoPage('handleLongPressCancel'), { capture: true, passive: false });
    }

    /**
     * Auto pause/resume/PiP on tab visibility. Auto PiP only closes a PiP window it
     * opened itself: closing the browser's own automatic PiP races it and leaves the
     * player dark with audio only (#910).
     */
    function installVisibility(): void {
        const pausedOwners = new Map<HTMLVideoElement, { identity: IdentitySnapshot; source: string }>();
        const mediaSource = (video: HTMLVideoElement) => video.currentSrc || video.getAttribute('src') || video.src;
        const clearPaused = (video: HTMLVideoElement) => { pausedOwners.delete(video); delete video.dataset.wasPlayingBeforeHidden; };
        for (const name of ['emptied', 'loadstart']) document.addEventListener(name, event => {
            if (event.target instanceof HTMLVideoElement) clearPaused(event.target);
        }, true);
        JE.session?.onUserChange('chrome-auto-resume', () => {
            for (const video of pausedOwners.keys()) delete video.dataset.wasPlayingBeforeHidden;
            pausedOwners.clear();
        });
        let autoPipVideo: HTMLVideoElement | null = null;
        const canAutoPip = (video: HTMLVideoElement): boolean => document.pictureInPictureEnabled
            && !video.disablePictureInPicture && video.readyState >= HTMLMediaElement.HAVE_METADATA;
        const exitAutoPip = (): void => {
            const pipVideo = autoPipVideo;
            autoPipVideo = null;
            if (pipVideo && document.pictureInPictureElement === pipVideo) {
                document.exitPictureInPicture().catch(error => console.error('🪼 Jellyfin Enhanced: Auto PiP Error:', error));
            }
        };
        document.addEventListener('leavepictureinpicture', event => {
            if (event.target === autoPipVideo) autoPipVideo = null;
        }, true);
        document.addEventListener('visibilitychange', () => {
            const video = document.querySelector('video');
            if (!video) return;
            JE.attachSeekTracker?.(video);
            if (document.hidden) {
                if (!video.paused && JE.currentSettings.autoPauseEnabled) {
                    pausedOwners.set(video, { identity: captureIdentity(JE.session, hostClient()), source: mediaSource(video) });
                    video.pause();
                    video.dataset.wasPlayingBeforeHidden = 'true';
                }
                if (JE.currentSettings.autoPipEnabled && !document.pictureInPictureElement && canAutoPip(video)) {
                    video.requestPictureInPicture().then(() => {
                        autoPipVideo = video;
                        // The tab came back before the window finished opening.
                        if (!document.hidden) exitAutoPip();
                    }).catch((error: unknown) => {
                        // Expected in Chromium without a gesture; the browser may open its own PiP.
                        if (error instanceof Error && error.name === 'NotAllowedError') {
                            console.debug('🪼 Jellyfin Enhanced: Auto PiP not allowed by the browser:', error.message);
                        } else {
                            console.error('🪼 Jellyfin Enhanced: Auto PiP Error:', error);
                        }
                    });
                }
            } else {
                const owner = pausedOwners.get(video);
                if (video.paused && video.dataset.wasPlayingBeforeHidden === 'true' && JE.currentSettings.autoResumeEnabled
                    && owner && owner.source === mediaSource(video)
                    && isSameIdentity(owner.identity, captureIdentity(JE.session, hostClient()))) {
                    // Autoplay policy may refuse a resume without a gesture; that is not a page error.
                    Promise.resolve(video.play()).catch(error => console.debug('🪼 Jellyfin Enhanced: Auto resume refused:', error));
                }
                clearPaused(video);
                exitAutoPip();
            }
        });
    }

    /** Wire the core listeners and observers. Repeated calls rerun setup without duplicating listeners. */
    function initializeEnhancedScript(): void {
        clearLocalStorageIfRequested();
        JE.injectGlobalStyles?.();
        JE.addPluginMenuButton?.();
        JE.addUserMenuLink?.();
        JE.addRandomButton?.();
        JE.applySavedStylesWhenReady?.();
        setupDOMObserver();
        observeActionSheets();
        if (installed) return;
        installed = true;
        addContextMenuListener();
        document.addEventListener('keydown', panelKeyListener);
        // Capture phase: a matching player shortcut runs before (and suppresses) the host's own key handlers.
        if (!JE.pluginConfig.DisableAllShortcuts) document.addEventListener('keydown', keyListener, true);
        installLongPress();
        installVisibility();
    }

    return { keyListener, initializeEnhancedScript };
}
