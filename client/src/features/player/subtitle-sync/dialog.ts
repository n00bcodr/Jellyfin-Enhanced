/**
 * @file Subtitle sync.
 *
 * A player dialog that lists every line of the subtitle track that is playing, with its time. Typing
 * filters the lines. Choosing a line syncs the subtitles to it: the offset is set so the line shows at
 * the moment the dialog opened, which is when you heard it. Each line also has a jump button that seeks
 * to where the line shows.
 *
 * The offset is jellyfin-web's own, set through its subtitle sync control (JE.setSubtitleOffset in
 * track-controls.ts), so its slider, its G/H keys and JE's [ ] shortcuts keep agreeing with it.
 * jellyfin-web keeps that offset within ±30 s, and a positive offset shows subtitles earlier.
 *
 * The dialog pauses playback while it is open and resumes it on close only when it paused it.
 *
 * Upstream ships this as its own component script (enhanced/player/subtitle-sync.js). The component
 * list is pinned here, so auto-skip.ts, the entry before it in upstream's order, installs it.
 */
import { isSafeCssColor } from '../../shared/settings-values';
import type { PlayerBridge, PlayerFeatureContext, playerHost } from '../host';
import {
    cleanLineText, filterLines, formatTime, isProgressiveTranscode, lineIndexAt, MAX_OFFSET_SECONDS, measureOffset, offsetInRange,
    parseTrackEvents, roundOffset, searchKey, syncOffsetFor, TICKS_PER_SECOND, withinSeekable, type SubtitleLine,
} from './lines';
import syncCss from './subtitle-sync.css';
import { createTrackLookup, TIMEOUTS, trackLabel, type TrackAnswer } from './track';
import { createView, OVERLAY_ID, part, searchInput, type DialogState } from './view';
import { clientRendersSubtitles, createSubtitleWatch, cueSample, linesStillShown, rendererKey, rendererOf, sameRenderer, syncSupport, videoSrc } from './watch';
import { createCustomElement } from '../../shared/dom';

const BUTTON_ID = 'je-subtitle-sync-btn';
const STYLE_ID = 'je-subtitle-sync-style';
const SEARCH_DEBOUNCE_MS = 80;
/**
 * TV remote and gamepad key codes, named the way jellyfin-web's keyboardNavigation names them (with its
 * aliases applied), so its Back, D-pad and select keys work in the dialog.
 */
const KEY_CODE_NAMES: Readonly<Record<number, string>> = {
    13: 'Enter', 27: 'Escape', 38: 'ArrowUp', 40: 'ArrowDown',
    138: 'ArrowUp', 139: 'ArrowDown', 195: 'GamepadA', 196: 'Escape',
    203: 'ArrowUp', 204: 'ArrowDown', 211: 'ArrowUp', 212: 'ArrowDown',
    461: 'Back', 10009: 'Back',
};

/** `JE.internals.subtitleSync`: the pure rules and the waits, for unit tests. */
export interface SubtitleSyncInternals {
    MAX_OFFSET_SECONDS: number;
    cleanLineText: typeof cleanLineText; searchKey: typeof searchKey; parseTrackEvents: typeof parseTrackEvents; filterLines: typeof filterLines;
    roundOffset: typeof roundOffset; syncOffsetFor: typeof syncOffsetFor; offsetInRange: typeof offsetInRange; lineIndexAt: typeof lineIndexAt;
    measureOffset: typeof measureOffset; isProgressiveTranscode: typeof isProgressiveTranscode;
    timeouts: typeof TIMEOUTS;
    formatTime: typeof formatTime; formatOffset(seconds: number): string;
    clientRendersSubtitles: typeof clientRendersSubtitles;
    isOpen(): boolean;
}
export interface SubtitleSyncHost {
    JE: PlayerBridge;
    ApiClient: ReturnType<typeof playerHost>['ApiClient'];
    ctx: PlayerFeatureContext;
}

export function installSubtitleSync({ JE, ApiClient, ctx }: SubtitleSyncHost): void {
    /** Translates a key, falling back to English text when the key is missing. */
    function tr(key: string, fallback: string, params?: Record<string, string | number>): string {
        let value: string | null = null;
        try {
            value = typeof JE.t === 'function' ? JE.t(key, params) : null;
        } catch {
            value = null;
        }
        if (value && value !== key) return value;
        let text = fallback;
        for (const [name, v] of Object.entries(params || {})) text = text.split(`{${name}}`).join(String(v));
        return text;
    }

    /** A toast's words (a toast renders markup): the locale's string, else the English one. */
    const toastText = (key: string, fallback: string): string => {
        const value = JE.t(key);
        return value && value !== key ? value : fallback;
    };
    const getVideo = (): HTMLVideoElement | null => ctx.own.player?.getVideo?.() || document.querySelector('video');
    const watch = createSubtitleWatch(getVideo);
    const view = createView(watch, tr);

    /** The open dialog. */
    let dialog: DialogState | null = null;
    /** A closed dialog's resume still waiting to be decided (see closeDialog). */
    let pendingResume: { state: DialogState; cancel(): void } | null = null;

    /** Drops a closed dialog's waiting resume: a new dialog now owns what happens to playback. */
    function cancelPendingResume(): void {
        pendingResume?.cancel();
        pendingResume = null;
    }

    /** Whether a dialog is still the open one and still about the same playback. */
    function isCurrent(state: { video: HTMLVideoElement; epoch: number }): boolean {
        const open = dialog;
        return !!open && open === state
            && (!JE.session || JE.session.isCurrent(open.epoch))
            && open.video.isConnected
            && getVideo() === open.video
            && videoSrc(open.video) === open.src;
    }
    const lookup = createTrackLookup({ JE, ApiClient, ctx, watch }, isCurrent);

    /**
     * Seconds the element clock is behind the item's timeline (non-zero only for a progressive transcode
     * that started part-way; auto-skip.ts derives it from the source URL).
     */
    function transcodeOffsetSeconds(video: HTMLVideoElement): number {
        const ticks = ctx.own.autoSkip?.parseTranscodeOffsetTicksFromSrc?.(videoSrc(video)) ?? 0;
        return (Number(ticks) || 0) / TICKS_PER_SECOND;
    }
    /** The playing position in the item's own timeline: the element clock plus the start of a progressive transcode. */
    const mediaTime = (video: HTMLVideoElement): number => (Number(video.currentTime) || 0) + transcodeOffsetSeconds(video);

    /** Adds the dialog and OSD button styles once. */
    function injectStyles(): void {
        if (document.getElementById(STYLE_ID)) return;
        // The theme's accent is a rule of the stylesheet, as upstream's, so custom CSS can still set
        // --je-subsync-accent on the dialog; anything that is not a colour keeps the stylesheet's own.
        const accent = JE.themer?.getThemeVariables?.()?.primaryAccent;
        const css = isSafeCssColor(accent) ? `${syncCss}\n#${OVERLAY_ID} { --je-subsync-accent: ${accent}; }` : syncCss;
        // The shared style registry when the core has it (tests and early pages may not).
        const ui = JE.core?.ui;
        if (ui?.injectCss) {
            ui.injectCss(STYLE_ID, css);
            return;
        }
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = css;
        document.head.appendChild(style);
    }

    /** Says the listed lines no longer match the subtitles on screen and offers to reload them; the rows are cleared so none of them can be used. */
    function showStale(state: DialogState): void {
        state.lines = null;
        state.renderer = null;
        state.rows = new Map();
        part(state, '.je-subsync-list').replaceChildren();
        part(state, '.je-subsync-foot').textContent = '';
        view.refreshMeta(state);
        view.setStatus(state, tr('subtitle_sync_stale', 'These lines don\'t match the subtitles on screen.'), 'error', {
            label: tr('subtitle_sync_reload', 'Reload'), run: () => { void populate(state); },
        });
    }

    /** Loads the track and its lines into the dialog, showing what went wrong otherwise. */
    async function populate(state: DialogState): Promise<void> {
        view.setStatus(state, tr('subtitle_sync_loading', 'Loading the subtitle lines…'));
        // What drew the subtitles before anything was looked up, to check the answer against.
        watch.noteRenderer();
        const startRenderer = rendererOf(state.video);
        const startGeneration = watch.generation();
        const retry = { label: tr('subtitle_sync_retry', 'Try again'), run: () => { void populate(state); } };
        let track: TrackAnswer | null;
        try {
            track = await lookup.resolveTrack(state);
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: subtitle sync track lookup failed', err);
            track = { error: 'session' };
        }
        if (!track || !isCurrent(state)) return;
        part(state, '.je-subsync-track').textContent = trackLabel(track.stream);
        if ('error' in track) {
            if (track.error === 'none') {
                view.setStatus(state, tr('subtitle_sync_none', 'Turn on a subtitle track first.'), 'info', {
                    label: tr('subtitle_sync_choose_track', 'Choose subtitles'),
                    run: () => {
                        closeDialog();
                        document.querySelector<HTMLElement>('.videoOsdBottom .btnSubtitles')?.click();
                    },
                });
            } else if (track.error === 'image') {
                view.setStatus(state, tr('subtitle_sync_image', 'This subtitle track is made of images, so its lines can\'t be listed.'), 'info');
            } else {
                view.setStatus(state, tr('subtitle_sync_error_session', 'Couldn\'t tell which subtitles are playing.'), 'error', retry);
            }
            return;
        }
        let lines: SubtitleLine[];
        try {
            lines = await lookup.loadLines(state, track);
        } catch (err) {
            if (!isCurrent(state)) return;
            console.warn('🪼 Jellyfin Enhanced: subtitle lines request failed', err);
            view.setStatus(state, tr('subtitle_sync_error_load', 'Couldn\'t load the subtitle lines.'), 'error', retry);
            return;
        }
        if (!isCurrent(state)) return;
        if (!lines.length) {
            view.setStatus(state, tr('subtitle_sync_empty', 'This subtitle track has no lines.'), 'info');
            return;
        }
        // The answer describes the subtitles that were on screen when the lookup started. If they changed
        // meanwhile (switched, turned off, another renderer), look once more.
        const now = rendererOf(state.video);
        const unproven = !sameRenderer(startRenderer, now) || watch.generation() !== startGeneration;
        if (unproven && !state.relooked) {
            state.relooked = true;
            void populate(state);
            return;
        }
        if (unproven || measureOffset(lines, cueSample(state.video)) === 'mismatch') {
            showStale(state);
            return;
        }
        view.setStatus(state, '');
        state.renderer = now;
        state.lines = lines;
        view.renderLines(state);
    }

    /**
     * Seeks to where `line` shows with the current offset, then closes the dialog. A progressive transcode
     * only holds what the server has produced from where that stream started, so a line outside the
     * element's seekable range is not jumped to; the dialog says why.
     */
    function jumpToLine(state: DialogState, line: SubtitleLine): void {
        if (!isCurrent(state)) {
            closeDialog({ resume: false });
            return;
        }
        if (!linesStillShown(state.video, state.lines, state.renderer)) {
            showStale(state);
            return;
        }
        const offset = watch.effectiveOffset(state.video, state.lines) || 0;
        const elementTime = Math.max(0, line.start - offset) - transcodeOffsetSeconds(state.video);
        if (isProgressiveTranscode(videoSrc(state.video)) && !withinSeekable(state.video, elementTime)) {
            view.setStatus(state, tr('subtitle_sync_jump_unavailable', 'This stream can only jump within the part the server has prepared so far, and that line is outside it.'), 'error');
            return;
        }
        state.video.currentTime = Math.max(0, elementTime);
        closeDialog();
    }

    /**
     * Syncs the subtitles so `line` shows at the sync point; when the player can't shift these subtitles
     * (the hint says so) it jumps to the line instead.
     */
    function chooseLine(state: DialogState, line: SubtitleLine): void {
        if (!isCurrent(state)) {
            closeDialog({ resume: false });
            return;
        }
        if (!linesStillShown(state.video, state.lines, state.renderer)) {
            showStale(state);
            return;
        }
        const support = syncSupport(state.video);
        if (support.ok !== state.supportShown) {
            // The subtitles started or stopped being shiftable since the hint was written: update it rather
            // than do something it doesn't describe.
            view.refreshMeta(state);
            return;
        }
        if (!support.ok) {
            jumpToLine(state, line);
            return;
        }
        const offset = syncOffsetFor(line.start, state.anchor);
        if (!offsetInRange(offset)) {
            view.setStatus(state, tr('subtitle_sync_too_far', 'That line is {offset} away. Jellyfin can shift subtitles by up to {max} seconds.', {
                offset: view.formatOffset(offset), max: MAX_OFFSET_SECONDS,
            }), 'error');
            return;
        }
        if (typeof JE.setSubtitleOffset !== 'function' || !JE.setSubtitleOffset(offset)) {
            view.setStatus(state, tr('subtitle_sync_hint_unavailable', 'This player can\'t shift subtitles. Choosing a line jumps to it.'), 'error');
            view.refreshMeta(state);
            return;
        }
        // A toast renders markup (the string's icon), so the offset is escaped.
        JE.toast?.(JE.t('subtitle_sync_synced', { offset: JE.escapeHtml(view.formatOffset(offset)) }));
        closeDialog();
    }

    /**
     * Keys inside the dialog: Escape closes, arrows move between lines, Tab stays inside. No key reaches
     * jellyfin-web's player keys (Space would pause) or JE's other shortcuts.
     */
    function onDialogKey(state: DialogState, e: KeyboardEvent): void {
        e.stopPropagation();
        if (e.type !== 'keydown' || !(e.target instanceof Element)) return;
        const target = e.target;
        const key = KEY_CODE_NAMES[e.keyCode] || e.key || '';
        if (key === 'Escape' || key === 'Back' || key === 'BrowserBack' || key === 'GoBack') {
            e.preventDefault();
            closeDialog();
            return;
        }
        if (key === 'ArrowDown' || key === 'ArrowUp') {
            if (view.moveFocus(state, target, key === 'ArrowDown' ? 1 : -1)) e.preventDefault();
            return;
        }
        if ((key === 'Enter' || key === 'GamepadA') && target.classList.contains('je-subsync-input')) {
            e.preventDefault();
            view.moveFocus(state, target, 1);
            return;
        }
        if (key === 'GamepadA' && target instanceof HTMLButtonElement) {
            e.preventDefault();
            target.click();
            return;
        }
        if (e.key === 'Tab') {
            const focusable = Array.from(state.overlay.querySelectorAll<HTMLElement>('button:not([hidden]), input'))
                .filter(el => !el.closest('[hidden]') && el.offsetParent !== null);
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (!first || !last) return;
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
            return;
        }
        if (target.classList.contains('je-subsync-input')) return;
        // The open shortcut closes the dialog again.
        const combo = typeof JE.keyCombo === 'function' ? JE.keyCombo(e) : null;
        const canonical = ctx.peer('canonicalCombo');
        const bound = JE.state?.activeShortcuts?.SubtitleSync;
        if (combo && bound && (typeof canonical === 'function' ? canonical(bound) === canonical(combo) : bound === combo)) {
            e.preventDefault();
            closeDialog();
        }
    }

    /** A click inside the dialog: close, reset the offset, choose a line or jump to it. */
    function onDialogClick(state: DialogState, e: MouseEvent): void {
        e.stopPropagation();
        if (!(e.target instanceof Element)) return;
        const target = e.target;
        if (target === state.overlay || target.closest('.je-subsync-close')) {
            closeDialog();
            return;
        }
        if (target.closest('.je-subsync-meta .je-subsync-reset')) {
            if (typeof JE.setSubtitleOffset === 'function' && JE.setSubtitleOffset(0)) JE.toast?.(JE.t('subtitle_sync_offset_reset'));
            view.refreshMeta(state);
            // jellyfin-web applies an offset 100 ms later (debounced); measure again after.
            setTimeout(() => { if (dialog === state) view.refreshMeta(state); }, 250);
            searchInput(state)?.focus();
            return;
        }
        const row = target.closest<HTMLElement>('.je-subsync-row');
        const line = row && state.lines ? state.lines[Number(row.dataset.index)] : undefined;
        if (!line) return;
        if (target.closest('.je-subsync-jump')) jumpToLine(state, line);
        else if (target.closest('.je-subsync-line')) chooseLine(state, line);
    }

    /** Opens the dialog for the subtitle track that is playing. Pauses playback while it is open. */
    function openDialog(): void {
        if (dialog) {
            if (isCurrent(dialog)) {
                searchInput(dialog)?.focus();
                return;
            }
            closeDialog({ resume: false });
        }
        const video = getVideo();
        const onVideoPage = typeof JE.isVideoPage !== 'function' || JE.isVideoPage();
        if (!video || !onVideoPage) {
            // On the player page without a <video> the player draws its own subtitles (mpv in Jellyfin
            // Desktop): there are no cues to check the lines against and no element to seek.
            JE.toast?.(video || !onVideoPage ? JE.t('toast_no_video_found') : toastText('toast_player_unsupported', '{{icon:info}} Not available with this player'));
            return;
        }
        injectStyles();
        // JE's pause screen would sit behind the dialog and take its keys; it waits while the dialog is open
        // (pausescreen.ts) and is put away now if it is showing.
        if (document.documentElement.classList.contains('pause-screen-active')) JE.pauseScreenInstance?.hideOverlay?.();
        cancelPendingResume();
        // Changes already on screen are recorded first, so only later ones count as made while the dialog
        // was open (see closeDialog).
        watch.noteRenderer();
        const wasPlaying = !video.paused && !video.ended;
        if (wasPlaying) video.pause();
        const overlay = view.buildOverlay();
        const state: DialogState = {
            video,
            src: videoSrc(video),
            epoch: JE.session ? JE.session.getEpoch() : 0,
            anchor: mediaTime(video),
            pausedByUs: wasPlaying,
            generationAtOpen: watch.generation(),
            abort: new AbortController(),
            returnFocus: document.activeElement,
            overlay,
            lines: null,
            rows: new Map(),
            searchTimer: undefined,
            supportShown: false,
            renderer: null,
        };
        dialog = state;
        // Everything the dialog listens to ends with it (closeDialog aborts this).
        const { signal } = state.abort;

        const keyHandler = (e: KeyboardEvent): void => onDialogKey(state, e);
        overlay.addEventListener('keydown', keyHandler);
        overlay.addEventListener('keyup', keyHandler);
        overlay.addEventListener('keypress', keyHandler);
        overlay.addEventListener('wheel', e => e.stopPropagation());
        overlay.addEventListener('click', e => onDialogClick(state, e));
        searchInput(state)?.addEventListener('input', () => {
            clearTimeout(state.searchTimer);
            state.searchTimer = window.setTimeout(() => { if (dialog === state) view.applyFilter(state); }, SEARCH_DEBOUNCE_MS);
        });

        // Anything that ends this playback ends the dialog.
        const onGone = (): void => closeDialog({ resume: false });
        // jellyfin-web shows a cue track once it has loaded it, which can make these subtitles shiftable
        // after the dialog opened. Checked once the change settles: Firefox flips the cue track's mode for a
        // moment on every offset change.
        const onTracks = (): void => {
            setTimeout(() => {
                if (dialog !== state || !state.lines) return;
                if (linesStillShown(state.video, state.lines, state.renderer)) view.refreshMeta(state);
                else showStale(state);
            }, 60);
        };
        // A seek made elsewhere while the dialog is open (its own jump closes it first) means playback is no
        // longer the one the dialog paused: closing leaves it paused.
        const onSeeking = (): void => { state.pausedByUs = false; };
        video.textTracks?.addEventListener?.('change', onTracks, { signal });
        video.addEventListener('seeking', onSeeking, { signal });
        video.addEventListener('emptied', onGone, { signal });
        document.addEventListener('viewshow', onGone, { signal });
        window.addEventListener('hashchange', onGone, { signal });

        document.body.appendChild(overlay);
        view.refreshMeta(state);
        searchInput(state)?.focus();
        void populate(state);
    }

    /**
     * Resumes playback the closed dialog paused, unless something else changed it while the dialog was open
     * or since: a seek or leaving the page (clears pausedByUs), a subtitle change on screen (including one
     * too recent for the settle delay to have recorded yet), another video, another user, another page, or
     * a dialog open again.
     */
    function resumeIfOwned(state: DialogState): void {
        const video = state.video;
        watch.noteRenderer();
        if (dialog === null && state.pausedByUs && watch.generation() === state.generationAtOpen
            && (!JE.session || JE.session.isCurrent(state.epoch))
            && (typeof JE.isVideoPage !== 'function' || JE.isVideoPage())
            && video.isConnected && getVideo() === video && videoSrc(video) === state.src && video.paused) {
            // play() answers with a promise that rejects when the browser refuses; older players answer nothing.
            Promise.resolve(video.play()).catch(() => {});
        }
    }

    /**
     * Closes the dialog. Playback resumes only if the dialog paused it, the same video is still loaded, and
     * nothing else seeked or changed the subtitles while it was open, unless `resume` is false.
     */
    function closeDialog(opts?: { resume?: boolean }): void {
        const state = dialog;
        if (!state) return;
        dialog = null;
        state.abort.abort();
        clearTimeout(state.searchTimer);
        state.overlay.remove();
        const video = state.video;
        if (!(opts && opts.resume === false) && state.pausedByUs) {
            // Cues that are not showing at this moment may be Firefox's brief mode flip on an offset change
            // (the same cues come back), or subtitles turned off: decide once settled.
            if (rendererKey(video) === null && watch.sawRenderer()) {
                // Anything that would have stopped the resume while open still stops it until then, and so
                // does another dialog opening (cancelPendingResume).
                const waiting = new AbortController();
                const cancel = (): void => { state.pausedByUs = false; };
                video.addEventListener('seeking', cancel, { signal: waiting.signal });
                video.addEventListener('emptied', cancel, { signal: waiting.signal });
                document.addEventListener('viewshow', cancel, { signal: waiting.signal });
                window.addEventListener('hashchange', cancel, { signal: waiting.signal });
                const settle = (): void => {
                    clearTimeout(timer);
                    waiting.abort();
                    if (pendingResume && pendingResume.state === state) pendingResume = null;
                };
                const timer = setTimeout(() => {
                    settle();
                    resumeIfOwned(state);
                }, 60);
                pendingResume = { state, cancel: () => { cancel(); settle(); } };
            } else {
                resumeIfOwned(state);
            }
        }
        const back = state.returnFocus;
        if (back instanceof HTMLElement && back.isConnected) {
            try { back.focus({ preventScroll: true }); } catch { /* focus is best effort */ }
        }
    }

    /** Opens the dialog, or closes it when it is open (the keyboard shortcut). */
    JE.toggleSubtitleSync = () => {
        if (dialog && isCurrent(dialog)) closeDialog();
        else openDialog();
    };

    /**
     * Adds the Subtitle Sync button after jellyfin-web's Subtitles button in the player, or removes it when
     * the setting is off. It hides with the Subtitles button through CSS. Called on every video-page DOM
     * update, which also notes subtitle changes on screen as they happen (see the watch's effectiveOffset
     * and the lookup's probeFreshSession), whether or not the button is shown.
     */
    JE.addSubtitleSyncButton = () => {
        watch.noteRenderer();
        const existing = document.getElementById(BUTTON_ID);
        if (JE.currentSettings?.subtitleSyncButtonEnabled !== true) {
            existing?.remove();
            return;
        }
        // A player without a <video> (mpv in Jellyfin Desktop) draws its own subtitles: nothing to sync.
        if (!getVideo()) {
            existing?.remove();
            return;
        }
        const subtitlesButton = document.querySelector('.videoOsdBottom .btnSubtitles');
        if (!subtitlesButton) return;
        if (existing && existing.previousElementSibling === subtitlesButton) return;
        existing?.remove();
        injectStyles();
        const label = tr('subtitle_sync_button', 'Sync subtitles');
        const button = createCustomElement('button', 'paper-icon-button-light');
        button.id = BUTTON_ID;
        button.type = 'button';
        button.classList.add('autoSize', 'paper-icon-button-light');
        button.title = label;
        button.setAttribute('aria-label', label);
        button.innerHTML = '<span class="xlargePaperIconButton je-msym-rounded" aria-hidden="true">subtitles_gear</span>';
        button.addEventListener('click', e => {
            e.stopPropagation();
            openDialog();
        });
        subtitlesButton.insertAdjacentElement('afterend', button);
    };

    JE.session?.onUserChange?.('subtitle-sync', () => {
        closeDialog({ resume: false });
        lookup.clearCache();
    });

    ctx.own.subtitleSync = {
        MAX_OFFSET_SECONDS, cleanLineText, searchKey, parseTrackEvents, filterLines, roundOffset, syncOffsetFor, offsetInRange, lineIndexAt,
        measureOffset, isProgressiveTranscode, timeouts: TIMEOUTS, formatTime, formatOffset: view.formatOffset, clientRendersSubtitles,
        isOpen: () => dialog !== null,
    };
}
// The dialog's overlay id, for the modules that leave its keys to it (pausescreen.ts, chrome's key listener).
export { OVERLAY_ID };
