/**
 * @file The seek history (Jump to Last Position) and Jump to % of a player without a `<video>` (mpv in
 * Jellyfin Desktop), kept from and sent through jellyfin-web's OSD (shared/osd-playback.ts).
 *
 * Such a player fires no seeking event, so the history is kept two ways:
 *  * A change of the OSD's position slider (a click or drag on the timeline, or JE's own jump to %, skip or
 *    bookmark) is a seek of any length: the OSD still shows where playback was.
 *  * Other seeks (jellyfin-web's keys and rewind/forward buttons, chapters, remote control) show as a jump in
 *    the position text. Between two readings, playback explains at most the seconds played since the first
 *    (none while the OSD showed paused) x 4, jellyfin-web's top speed, + 2.5 s forward, and nothing backward
 *    beyond the text's whole-second rounding; any other move is a seek.
 *  * jellyfin-web's own seek keys and buttons (rewind, fast-forward, chapters, Home/End, digits; unmodified,
 *    as jellyfin-web only seeks on those) mark a seek intent. A move of 1.5 s (plus half the time since) or
 *    more away from where playback at the observed rate would be within 3 s confirms it, so short skips
 *    count too.
 * Play/pause changes are readings too, so a pause starts a reading with nothing played since. The rate is
 * measured over stretches of 3 s or more of plain playback (1x until then; JE's own speed changes set it).
 * When an item ends, autoplay replaces the time before the OSD shows the next item's id. So a jump in the text
 * away from an item's last 30 s clears the saved position and is held for 5 s: if the item changes it was
 * autoplay, otherwise it is recorded then.
 */
import { playerUnsupportedText, type PlayerContext } from './context';
import { osdPlayback as osd, type OsdItem } from '../shared/osd-playback';

/** The position Jump to Last Position returns to, shared by the `<video>` history (frame-seek.ts) and this one. */
export interface SeekHistory {
    /** Seconds of the item; null when nothing is saved. */
    position: number | null;
}

/** One reading of the OSD. */
interface Reading extends OsdItem { position: number; at: number; playing: boolean }
/** What is waited for after a seek from a reading to a target. */
interface Landing extends Reading { from: number; until: number }

const OSD_SEEK_RATE_ALLOWANCE = 4;
const OSD_ITEM_END_SECONDS = 30;
const OSD_IDENTITY_SETTLE_MS = 5000;
const OSD_INTENT_WINDOW_MS = 3000;
const OSD_INTENT_MOVED_SECONDS = 1.5;
const OSD_INTENT_RATE_TOLERANCE = 0.5;
const OSD_RATE_WINDOW_MS = 3000;
const OSD_SEEK_KEYS: ReadonlySet<string> = new Set(['ArrowLeft', 'ArrowRight', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'KeyJ', 'KeyL']);
const OSD_SEEK_BUTTONS = '.btnRewind, .btnFastForward, .btnPreviousChapter, .btnNextChapter';
const OSD_SEEK_SLACK_SECONDS = 2.5;
const OSD_SEEK_BACK_SECONDS = 1.5;
const OSD_SLIDER_SEEK_MIN_SECONDS = 1;
const OSD_JUMP_SETTLE_MS = 15000;
const OSD_JUMP_ARRIVED_SECONDS = 3;

export function installOsdSeekHistory(context: PlayerContext, history: SeekHistory) {
    const { JE, lifetime, getVideo, tWithFallback } = context;
    /** The latest OSD reading. */
    let lastReading: Reading | null = null;
    /** The item the saved position belongs to. */
    let historyItem: OsdItem | null = null;
    /** While JE's jump back or a recorded slider seek lands. */
    let jump: Landing | null = null;
    /** True while JE's jump back moves the slider. */
    let ownJump = false;
    /** The reading taken when a jellyfin-web seek key or button was used. */
    let intent: Reading | null = null;
    /** A jump away from an item's end, until its identity settles. */
    let pendingSeek: { from: Reading; until: number } | null = null;
    /** Playback rate observed (or set by JE) for the current item. */
    let rate = 1;
    /** The reading where the current stretch of plain playback began. */
    let run: Reading | null = null;
    /** The .osdPositionText being observed. */
    let watchedText: Element | null = null;
    let observer: MutationObserver | null = null;
    /** Ends the document listeners that watch for seeks. */
    let listening: AbortController | null = null;

    /** Whether the player page is showing (true when JE.isVideoPage is not available). */
    const isOnVideoPage = (): boolean => typeof JE.isVideoPage !== 'function' || JE.isVideoPage();

    function readOsd(): Reading | null {
        const position = osd.positionSeconds();
        const key = osd.itemKey();
        const duration = osd.durationSeconds();
        if (position === null || key === null || duration === null) return null;
        // Unknown play state counts as playing: the larger allowance can only miss a seek, never invent one.
        return { key, duration, position, at: Date.now(), playing: osd.isPaused() !== true };
    }

    /** Saves the position to jump back to, for the item it belongs to. */
    function rememberPosition(reading: Reading): void {
        history.position = reading.position;
        historyItem = { key: reading.key, duration: reading.duration };
        pendingSeek = null; // a newer seek decides where to return to
        run = null;
    }

    /** What to wait for after a seek from a reading to a target (see notePosition). */
    function landingFor(reading: Reading, target: number): Landing {
        return { key: reading.key, duration: reading.duration, position: target, from: reading.position, at: reading.at, playing: reading.playing, until: reading.at + OSD_JUMP_SETTLE_MS };
    }

    /** Sets the rate JE's own speed change chose. */
    function noteRate(value: number): void {
        if (Number.isFinite(value) && value > 0) rate = value;
        run = null;
    }

    /**
     * Checks a reading against a pending seek intent: a move away from where playback would be since the
     * intent confirms it, and the intent's position becomes the one to return to. A stale intent (over 3 s
     * old, another item) is dropped.
     * @returns True when the reading confirmed a seek.
     */
    function confirmIntent(reading: Reading): boolean {
        const pending = intent;
        if (!pending) return false;
        if (reading.at - pending.at > OSD_INTENT_WINDOW_MS || !osd.sameItem(pending, reading)) {
            intent = null;
            return false;
        }
        const playedSinceIntent = pending.playing ? Math.max(0, reading.at - pending.at) / 1000 : 0;
        const expected = pending.position + playedSinceIntent * rate;
        if (Math.abs(reading.position - expected) < OSD_INTENT_MOVED_SECONDS + playedSinceIntent * OSD_INTENT_RATE_TOLERANCE) return false;
        intent = null;
        rememberPosition(pending);
        return true;
    }

    /**
     * Records one OSD reading. A move that playback can't explain since the previous reading is a seek, and
     * the previous reading becomes the position to jump back to. A saved position of another item is dropped.
     */
    function notePosition(): void {
        if (getVideo()) return; // the element's own listeners keep the history
        const reading = readOsd();
        if (!reading) return;
        if (historyItem && !osd.sameItem(historyItem, reading)) {
            history.position = null;
            historyItem = null;
        }
        if (jump) {
            // JE's own jump back or a recorded slider seek. Up to `played` (what could have played since;
            // buffering or a pause means less) past the old position means the player hasn't moved yet:
            // skipped. A seek key used meanwhile is judged next, then the same past the target is the landing
            // and becomes the baseline. After 15 s without one, the wait ends with a fresh baseline and nothing
            // recorded. Anything else (another seek, the next item) is judged as usual.
            const landing = jump;
            if (osd.sameItem(reading, landing)) {
                const played = Math.max(0, reading.at - landing.at) / 1000 * rate;
                const near = (origin: number): boolean => reading.position >= origin - OSD_JUMP_ARRIVED_SECONDS
                    && reading.position <= origin + played + OSD_JUMP_ARRIVED_SECONDS;
                const landed = near(landing.position);
                if (!landed && near(landing.from) && reading.at < landing.until) return;
                jump = null;
                if (intent && intent.at >= landing.at && confirmIntent(reading)) {
                    // The key seek superseded the landing.
                    lastReading = reading;
                    return;
                }
                if (landed || reading.at >= landing.until) {
                    lastReading = reading;
                    run = null;
                    return;
                }
            } else {
                jump = null;
            }
        }
        const previous = lastReading;
        lastReading = reading;
        if (pendingSeek) {
            if (!osd.sameItem(pendingSeek.from, reading)) {
                pendingSeek = null; // the next item: it was autoplay
            } else if (reading.at >= pendingSeek.until) {
                rememberPosition(pendingSeek.from); // still the same item: it was a seek
            }
        }
        if (!previous || !osd.sameItem(previous, reading)) {
            rate = 1;
            run = null;
            return;
        }
        if (confirmIntent(reading)) return;
        const delta = reading.position - previous.position;
        const played = previous.playing ? Math.max(0, reading.at - previous.at) / 1000 : 0;
        if (delta < -OSD_SEEK_BACK_SECONDS || delta > played * OSD_SEEK_RATE_ALLOWANCE + OSD_SEEK_SLACK_SECONDS) {
            run = null;
            if (previous.duration - previous.position <= OSD_ITEM_END_SECONDS) {
                // Maybe autoplay of the next item, still showing this one's id: decide once identity settles.
                history.position = null;
                historyItem = null;
                pendingSeek = { from: previous, until: reading.at + OSD_IDENTITY_SETTLE_MS };
                return;
            }
            rememberPosition(previous);
            return;
        }
        // Plain playback: measure the rate over stretches of a few seconds.
        if (!previous.playing || !reading.playing) {
            run = null;
        } else if (!run) {
            run = reading;
        } else if (reading.at - run.at >= OSD_RATE_WINDOW_MS) {
            const measured = (reading.position - run.position) / ((reading.at - run.at) / 1000);
            rate = Math.min(OSD_SEEK_RATE_ALLOWANCE, Math.max(0.25, measured));
            run = reading;
        }
    }

    /**
     * The reading a seek intent starts from. While an earlier seek is still landing the OSD shows the old
     * time, so the intent starts from that seek's target plus what has played since.
     */
    function intentReading(): Reading | null {
        const reading = readOsd();
        if (!reading || !jump || !osd.sameItem(reading, jump)) return reading;
        const played = reading.playing ? Math.max(0, reading.at - jump.at) / 1000 * rate : 0;
        return { ...reading, position: jump.position + played };
    }

    /**
     * Notes the position as a seek intent when one of jellyfin-web's seek keys is pressed (its OSD handles
     * them after JE's listener, and seeks only on unmodified ones; JE's own shortcuts stop the key first).
     */
    function onSeekKey(e: KeyboardEvent): void {
        if (getVideo() || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || !isOnVideoPage()) return;
        const target = e.target;
        // The position slider is a range input that seeks with keys; text fields don't.
        if (target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && target.type !== 'range')) return;
        const code = e.code || '';
        if (OSD_SEEK_KEYS.has(code) || OSD_SEEK_KEYS.has(e.key || '') || /^(Digit|Numpad)\d$/.test(code)) intent = intentReading();
    }

    /** Notes the position as a seek intent when the OSD's rewind, fast-forward or chapter button is used. */
    function onSeekButton(e: Event): void {
        if (getVideo()) return;
        const btn = e.target instanceof Element ? e.target.closest(OSD_SEEK_BUTTONS) : null;
        const page = btn && osd.activeOsdPage();
        if (page && page.contains(btn)) intent = intentReading();
    }

    /**
     * A change of the OSD's position slider is a seek (see above): the position the OSD shows at that moment
     * is the one to return to.
     */
    function onSliderChange(e: Event): void {
        const slider = e.target;
        if (ownJump || getVideo() || !(slider instanceof HTMLInputElement) || !slider.classList.contains('osdPositionSlider')) return;
        const page = osd.activeOsdPage();
        if (!page || !page.contains(slider)) return;
        const reading = readOsd();
        if (!reading) return;
        const target = (parseFloat(slider.value) / 100) * reading.duration;
        if (!Number.isFinite(target) || Math.abs(target - reading.position) < OSD_SLIDER_SEEK_MIN_SECONDS) return;
        rememberPosition(reading);
        lastReading = reading;
        // Its landing is this seek, not another one (nor autoplay, near an item's end): wait for it the way
        // JE's own jump back is waited for. It also supersedes a jump back still landing.
        jump = landingFor(reading, target);
    }

    /**
     * Keeps the seek history of a player without a `<video>` by watching the OSD's position text, its
     * play/pause button and its position slider. Safe to call on every page update: it only (re)attaches when
     * the showing OSD's text element changed.
     */
    JE.watchOsdPosition = () => {
        if (!listening) {
            listening = new AbortController();
            const { signal } = listening;
            // Capture phase: runs before jellyfin-web's own handlers start the seek.
            document.addEventListener('change', onSliderChange, { capture: true, signal });
            document.addEventListener('keydown', onSeekKey, { capture: true, signal });
            document.addEventListener('click', onSeekButton, { capture: true, signal });
        }
        const page = osd.activeOsdPage();
        const text = page && !getVideo() ? page.querySelector('.osdPositionText') : null;
        if (text === watchedText) return;
        observer?.disconnect();
        observer = null;
        watchedText = text;
        lastReading = null; // a new view: measure afresh (a saved position stays tied to its item)
        if (!text || !page) return;
        observer = new MutationObserver(notePosition);
        observer.observe(text, { childList: true, characterData: true, subtree: true });
        const playPause = page.querySelector('.btnPause');
        if (playPause) observer.observe(playPause, { attributes: true, attributeFilter: ['class'], subtree: true });
        notePosition();
    };

    /** Stops watching the OSD (leaving the player). */
    JE.stopWatchingOsdPosition = () => {
        observer?.disconnect();
        observer = null;
        watchedText = null;
        lastReading = null;
        intent = null;
        pendingSeek = null;
        run = null;
        listening?.abort();
        listening = null;
    };

    /** Jump to Last Position: seeks through the OSD's position slider. */
    function jumpToLast(): void {
        if (osd.positionSeconds() === null) {
            JE.toast(playerUnsupportedText(context));
            return;
        }
        notePosition(); // a seek since the text last changed still counts; another item's position goes
        if (history.position === null) {
            JE.toast(tWithFallback('toast_no_last_position', '{{icon:rewind}} No previous position saved'));
            return;
        }
        const targetTime = history.position;
        const before = readOsd();
        ownJump = true;
        let moved: boolean;
        try {
            moved = osd.seekTo(targetTime);
        } finally {
            ownJump = false;
        }
        if (!moved) {
            JE.toast(playerUnsupportedText(context));
            return;
        }
        history.position = null; // consume it so repeated presses don't loop
        historyItem = null;
        pendingSeek = null;
        run = null;
        // The jump itself is not a seek to remember: wait for it to land.
        jump = before ? landingFor(before, targetTime) : null;

        const mins = Math.floor(targetTime / 60);
        const secs = Math.floor(targetTime % 60).toString().padStart(2, '0');
        JE.toast(tWithFallback('toast_jumped_back', '{{icon:rewind}} Jumped back to {time}', { time: `${mins}:${secs}` }));
    }

    /** Jump to % of the item, through jellyfin-web's position slider. */
    function jumpToPercent(percentage: number): void {
        if (osd.seekToPercent(percentage)) JE.toast(JE.t('toast_jumped_to', { percent: Number(percentage) }));
        else JE.toast(playerUnsupportedText(context));
    }

    // Another account, or another page: nothing kept from the OSD applies any more.
    lifetime.onReset(() => {
        JE.stopWatchingOsdPosition();
        historyItem = null;
        jump = null;
        ownJump = false;
        rate = 1;
    });

    return { jumpToLast, jumpToPercent, noteRate };
}
export type OsdSeekHistory = ReturnType<typeof installOsdSeekHistory>;
