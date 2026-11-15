/**
 * @file Subtitle sync (#1061).
 *
 * A player dialog that lists every line of the subtitle track that is playing, with its time.
 * Typing filters the lines. Choosing a line syncs the subtitles to it: the offset is set so the
 * line shows at the moment the dialog opened, which is when you heard it. Each line also has a
 * jump button that seeks to where the line shows.
 *
 * The offset is jellyfin-web's own, set through its subtitle sync control
 * (JE.setSubtitleOffset in playback.js), so its slider, its G/H keys and JE's [ ] shortcuts keep
 * agreeing with it. jellyfin-web keeps that offset within ±30 s, and a positive offset shows
 * subtitles earlier (htmlVideoPlayer subtracts it from each cue).
 *
 * The lines come from the server's JSON rendering of the track (`Stream.js`, the request
 * jellyfin-web itself makes for text subtitles), so every text format the server reads works:
 * SRT, ASS/SSA, WebVTT and text tracks inside the file. Image formats (PGS, VobSub, DVB) have no
 * text to list.
 *
 * The dialog pauses playback while it is open and resumes it on close only when it paused it.
 */
(function (JE) {
    'use strict';

    const TICKS_PER_SECOND = 10000000;
    /** jellyfin-web's subtitle sync slider range (subtitlesync.template.html: min -30, max 30). */
    const MAX_OFFSET_SECONDS = 30;
    const FETCH_TIMEOUT_MS = 30000;
    const OVERLAY_ID = 'je-subtitle-sync';
    const BUTTON_ID = 'je-subtitle-sync-btn';
    const STYLE_ID = 'je-subtitle-sync-style';
    const SEARCH_DEBOUNCE_MS = 80;
    /** Cues compared with the lines to tell whether they are the same track. */
    const CUE_SAMPLE_SIZE = 24;
    /** Lines with unique text needed before a measured offset is trusted. */
    const MIN_OFFSET_MATCHES = 3;
    /**
     * Waits, in milliseconds (read when used; the tests shorten them): `sessionWait` for the
     * state report the dialog asks for, polled every `sessionPoll`; `lookup` for the item lookup.
     */
    const TIMEOUTS = { sessionWait: 12000, sessionPoll: 250, lookup: 8000 };
    /**
     * jellyfin-web reports its playback state (subtitle track included) on pause and at least
     * every ten seconds otherwise (playbackManager's progress interval), so the server's answer
     * can be this much older than what is on screen.
     */
    const REPORT_INTERVAL_MS = 11000;
    /** How close (seconds) a paused report's position must be to the dialog's to be its pause. */
    const PAUSE_POSITION_TOLERANCE = 0.25;

    /**
     * Translates a key, falling back to English text when the key is missing.
     * @param {string} key
     * @param {string} fallback
     * @param {Object} [params]
     * @returns {string}
     */
    function tr(key, fallback, params) {
        let value = null;
        try {
            value = typeof JE.t === 'function' ? JE.t(key, params) : null;
        } catch (err) {
            value = null;
        }
        if (value && value !== key) return value;
        let text = fallback;
        for (const [name, v] of Object.entries(params || {})) text = text.split(`{${name}}`).join(String(v));
        return text;
    }

    // ── Pure helpers (unit-tested through JE.internals.subtitleSync) ─────────────────────

    /**
     * Turns a server track event's text into plain display text: ASS line breaks become new
     * lines, ASS override blocks and HTML-style tags (<i>, <font>) are dropped, and runs of
     * whitespace collapse.
     * @param {*} text
     * @returns {string}
     */
    function cleanLineText(text) {
        if (typeof text !== 'string') return '';
        let stripped = text
            .replace(/\\N/gi, '\n')
            .replace(/\\h/g, ' ')
            .replace(/\r/g, '')
            .replace(/\{\\[^}]*\}/g, '');
        // Removing one tag can join its neighbours into a new one ("<<i>b>"), so repeat until
        // nothing changes. The text is only ever shown through textContent.
        let previous;
        do {
            previous = stripped;
            stripped = stripped.replace(/<\/?[a-zA-Z][^>]*>/g, '');
        } while (stripped !== previous);
        return stripped
            .split('\n')
            .map(part => part.replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .join('\n');
    }

    /**
     * The form of a text that searches compare: lower case, without accents or punctuation,
     * single spaces.
     * @param {*} text
     * @returns {string}
     */
    function searchKey(text) {
        return String(text == null ? '' : text)
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s]/gu, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * @typedef {Object} SubtitleLine
     * @property {number} index Position in the sorted list.
     * @property {number} start Start in the subtitle file, seconds.
     * @property {number} end End in the subtitle file, seconds.
     * @property {string} text Display text.
     * @property {string} search searchKey(text).
     */

    /**
     * Reads the server's `Stream.js` answer into lines sorted by start. Events without text or
     * with an unusable start are skipped.
     * @param {*} data `{ TrackEvents: [{ Text, StartPositionTicks, EndPositionTicks }] }`
     * @returns {SubtitleLine[]}
     */
    function parseTrackEvents(data) {
        const events = data && Array.isArray(data.TrackEvents) ? data.TrackEvents : [];
        /** @type {SubtitleLine[]} */
        const lines = [];
        for (const ev of events) {
            if (!ev) continue;
            const start = Number(ev.StartPositionTicks) / TICKS_PER_SECOND;
            const end = Number(ev.EndPositionTicks) / TICKS_PER_SECOND;
            const text = cleanLineText(ev.Text);
            if (!text || !Number.isFinite(start) || start < 0) continue;
            lines.push({ index: 0, start, end: Number.isFinite(end) && end > start ? end : start, text, search: searchKey(text) });
        }
        lines.sort((a, b) => a.start - b.start);
        lines.forEach((line, i) => { line.index = i; });
        return lines;
    }

    /**
     * The lines that contain every word of the query (case, accents and punctuation ignored).
     * @param {SubtitleLine[]} lines
     * @param {string} query
     * @returns {SubtitleLine[]}
     */
    function filterLines(lines, query) {
        const terms = searchKey(query).split(' ').filter(Boolean);
        if (!terms.length) return lines;
        return lines.filter(line => terms.every(term => line.search.includes(term)));
    }

    /**
     * Rounds an offset to jellyfin-web's slider step (0.1 s).
     * @param {number} seconds
     * @returns {number}
     */
    function roundOffset(seconds) {
        const v = Math.round(seconds * 10) / 10;
        return Object.is(v, -0) ? 0 : v;
    }

    /**
     * The offset that makes a line show at `anchor`: jellyfin-web shows a line at
     * `start - offset`, so the offset is `start - anchor`.
     * @param {number} lineStart Line start in the subtitle file, seconds.
     * @param {number} anchor Media time the line should show at, seconds.
     * @returns {number}
     */
    function syncOffsetFor(lineStart, anchor) {
        return roundOffset(lineStart - anchor);
    }

    /**
     * Whether jellyfin-web can apply an offset (its control stops at ±30 s).
     * @param {number} offset
     * @returns {boolean}
     */
    function offsetInRange(offset) {
        return Number.isFinite(offset) && Math.abs(offset) <= MAX_OFFSET_SECONDS;
    }

    /**
     * The index of the last line that has started showing by `time` with `offset` applied, or
     * -1 when none has.
     * @param {SubtitleLine[]} lines Sorted by start.
     * @param {number} time Media time, seconds.
     * @param {number} offset Subtitle offset, seconds.
     * @returns {number}
     */
    function lineIndexAt(lines, time, offset) {
        let lo = 0;
        let hi = lines.length - 1;
        let found = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (lines[mid].start - offset <= time) {
                found = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return found;
    }

    /**
     * Compares lines from the server with cues jellyfin-web is showing ({start, key} with key =
     * searchKey of the cue's clean text). It is a different track when most cues' text is not
     * among the lines. Otherwise the shift is measured only on texts that occur once in the
     * lines, so a repeated line ("Yes.") can't pair a cue with the wrong occurrence; when most of
     * those agree on one shift, it is the offset jellyfin-web applied (it moves each cue to
     * start - offset). Returns that offset, 'mismatch', or null when it can't tell.
     * @param {SubtitleLine[]} lines
     * @param {Array<{start: number, key: string}>|null} sample
     * @returns {number|'mismatch'|null}
     */
    function measureOffset(lines, sample) {
        if (!sample || !sample.length || !lines.length) return null;
        /** @type {Map<string, number[]>} */
        const startsByKey = new Map();
        for (const line of lines) {
            if (!line.search) continue;
            const starts = startsByKey.get(line.search);
            if (starts) starts.push(line.start);
            else startsByKey.set(line.search, [line.start]);
        }
        const diffs = [];
        let compared = 0;
        let found = 0;
        for (const cue of sample) {
            if (!cue.key) continue;
            compared++;
            const starts = startsByKey.get(cue.key);
            if (!starts) continue;
            found++;
            if (starts.length === 1) diffs.push(starts[0] - cue.start);
        }
        if (!compared) return null;
        if (found < Math.ceil(compared * 0.6)) return 'mismatch';
        if (diffs.length < MIN_OFFSET_MATCHES) return null;
        diffs.sort((a, b) => a - b);
        const median = diffs[diffs.length >> 1];
        const agreeing = diffs.filter(d => Math.abs(d - median) <= 0.05).length;
        return agreeing < Math.ceil(diffs.length * 0.6) ? null : roundOffset(median);
    }

    /**
     * Formats seconds as m:ss or h:mm:ss.
     * @param {number} seconds
     * @returns {string}
     */
    function formatTime(seconds) {
        const total = Math.max(0, Math.floor(Number(seconds) || 0));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = String(total % 60).padStart(2, '0');
        return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
    }

    /**
     * Formats an offset the way jellyfin-web's sync control shows it, with a sign: "+1.5 s".
     * @param {number} seconds
     * @returns {string}
     */
    function formatOffset(seconds) {
        const v = roundOffset(seconds);
        return tr('subtitle_sync_seconds', '{value} s', { value: (v > 0 ? '+' : '') + v.toFixed(1) });
    }

    // ── Player state ──────────────────────────────────────────────────────────────────────

    /** @returns {HTMLVideoElement|null} */
    function getVideo() {
        return JE.internals?.player?.getVideo?.() || document.querySelector('video');
    }

    /**
     * The media element's source URL, used to notice a source change.
     * @param {HTMLVideoElement} video
     * @returns {string}
     */
    function videoSrc(video) {
        return (video && (video.currentSrc || video.src)) || '';
    }

    /**
     * The playing position in the item's own timeline: the element clock plus the start of a
     * progressive transcode (auto-skip.js derives it from the source URL).
     * @param {HTMLVideoElement} video
     * @returns {number}
     */
    function mediaTime(video) {
        return (Number(video.currentTime) || 0) + transcodeOffsetSeconds(video);
    }

    /**
     * Seconds the element clock is behind the item's timeline (non-zero only for a progressive
     * transcode that started part-way).
     * @param {HTMLVideoElement} video
     * @returns {number}
     */
    function transcodeOffsetSeconds(video) {
        const parse = JE.internals?.autoSkip?.parseTranscodeOffsetTicksFromSrc;
        const ticks = typeof parse === 'function' ? parse(videoSrc(video)) : 0;
        return (Number(ticks) || 0) / TICKS_PER_SECOND;
    }

    /**
     * jellyfin-web's current subtitle offset, read from its sync slider; null when the player
     * has no sync control.
     * @returns {number|null}
     */
    function currentOffset() {
        const slider = document.querySelector('.subtitleSyncSlider');
        if (!slider || typeof slider.updateOffset !== 'function') return null;
        const v = parseFloat(slider.value);
        return Number.isFinite(v) ? v : 0;
    }

    /**
     * The cue track jellyfin-web fills and shows for the primary subtitles, if it uses one.
     * @param {HTMLVideoElement} video
     * @returns {TextTrack|null}
     */
    function shownCueTrack(video) {
        try {
            const tracks = video && video.textTracks ? Array.from(video.textTracks) : [];
            return tracks.find(t => t && String(t.label || '') === 'manualTrack' && t.mode === 'showing') || null;
        } catch (err) {
            return null;
        }
    }

    /**
     * Up to CUE_SAMPLE_SIZE cues spread over the shown cue track, for measureOffset.
     * @param {HTMLVideoElement} video
     * @returns {Array<{start: number, key: string}>|null}
     */
    function cueSample(video) {
        const track = shownCueTrack(video);
        const cues = track && track.cues;
        if (!cues || !cues.length) return null;
        const step = Math.max(1, Math.floor(cues.length / CUE_SAMPLE_SIZE));
        const sample = [];
        for (let i = 0; i < cues.length && sample.length < CUE_SAMPLE_SIZE; i += step) {
            const cue = /** @type {VTTCue} */ (cues[i]);
            sample.push({ start: cue.startTime, key: searchKey(cleanLineText(cue.text)) });
        }
        return sample;
    }

    /**
     * The element jellyfin-web draws the primary subtitles on when it doesn't use a cue track:
     * its custom subtitle element or the libass canvas for ASS/SSA. It creates a new one for each
     * track it shows, right after resetting the subtitle offset to 0 (htmlVideoPlayer
     * setTrackForDisplay).
     * @param {HTMLVideoElement} video
     * @returns {Element|null}
     */
    function drawnSurface(video) {
        const custom = document.querySelector('.videoSubtitles .videoSubtitlesInner');
        if (custom) return custom;
        const parent = video && video.parentElement;
        return (parent && parent.querySelector('.libassjs-canvas-parent')) || null;
    }

    /**
     * Writes to jellyfin-web's subtitle offset through its sync control since the page loaded:
     * its slider's updateOffset() (used by its G/H keys, its text field and JE) and dragging the
     * slider. Counted by watchSliderWrites.
     */
    let sliderWrites = 0;

    /** Sliders already watched (jellyfin-web makes a new one for each playback). */
    const watchedSliders = new WeakSet();

    /**
     * Counts every write through jellyfin-web's subtitle sync slider: wraps its updateOffset
     * (calling the original unchanged) and listens for it being dragged.
     */
    function watchSliderWrites() {
        const slider = document.querySelector('.subtitleSyncSlider');
        if (!slider || watchedSliders.has(slider) || typeof slider.updateOffset !== 'function') return;
        watchedSliders.add(slider);
        const original = slider.updateOffset;
        slider.updateOffset = function () {
            countSliderWrite();
            return original.apply(this, arguments);
        };
        slider.addEventListener('change', countSliderWrite);
    }

    /**
     * Counts one offset write. A renderer that appeared since the last look is recorded first,
     * so this write counts as made after it (see effectiveOffset).
     */
    function countSliderWrite() {
        noteRenderer();
        sliderWrites++;
    }

    /** When the subtitles on screen last changed (shown, switched or turned off), by this page's clock. */
    let subtitlesChangedAt = 0;

    /** Counts subtitle changes on screen; a load spanning a change can't trust what it read. */
    let subtitleGeneration = 0;

    /** The renderer key last seen (see rendererKey); undefined before the first look. */
    let rendererKeySeen;

    /**
     * Each renderer key seen, with the slider write count when it was first seen. A key seen
     * again (Firefox briefly hides the cues on every offset change) keeps its first record.
     * @type {WeakMap<object, number>}
     */
    const rendererFirstSeen = new WeakMap();

    /** The text track list watched for subtitle changes. */
    let watchedTrackList = null;

    /**
     * The first cue object of the shown cue track.
     * @param {HTMLVideoElement|null} video
     * @returns {TextTrackCue|null}
     */
    function firstCue(video) {
        const track = video ? shownCueTrack(video) : null;
        const cues = track && track.cues;
        return cues && cues.length ? cues[0] : null;
    }

    /**
     * What identifies the subtitles jellyfin-web is drawing: its cue track's first cue object, or
     * its drawn element (libass, custom element). Both are new for every track it shows, and it
     * creates them right after resetting the offset to 0 (htmlVideoPlayer setTrackForDisplay →
     * renderTracksEvents, jellyfin-web 10.11 and 12), even for a file with the same text; an
     * offset change only moves the existing cues' times.
     * @param {HTMLVideoElement|null} video
     * @returns {object|null}
     */
    function rendererKey(video) {
        return video ? firstCue(video) || drawnSurface(video) : null;
    }

    /** Records a subtitle change on screen. */
    function noteSubtitleChange() {
        subtitlesChangedAt = Date.now();
        subtitleGeneration++;
    }

    /**
     * Records the renderer when it changed, after making sure offset writes and track changes
     * are watched. A new renderer is seen soon after jellyfin-web creates it: this runs on every
     * video-page DOM update (the first of which comes before any subtitles are drawn), 50 ms
     * after each text track change, and before the dialog relies on it.
     */
    function noteRenderer() {
        watchSliderWrites();
        const video = getVideo();
        watchSubtitleChanges(video);
        const key = rendererKey(video);
        if (rendererKeySeen === undefined) {
            // The first look: what is there already is not a change, and its offset history is
            // unknown (the slider is trusted for it).
            rendererKeySeen = key;
            return;
        }
        if (key === rendererKeySeen) return;
        rendererKeySeen = key;
        if (key && rendererFirstSeen.has(key)) return;
        if (key) rendererFirstSeen.set(key, sliderWrites);
        noteSubtitleChange();
    }

    /**
     * A change of the video's text tracks, looked at once it settles (Firefox restores the mode
     * after an offset change in a 0 ms timeout).
     */
    function onTrackListChange() {
        setTimeout(noteRenderer, 50);
    }

    /**
     * Brings the change records up to date before they are relied on, as a change can be newer
     * than the last page update or the settle delay above.
     */
    function catchUpSubtitleChanges() {
        noteRenderer();
    }

    /**
     * Watches the video's text track list for changes, moving to a new video element when the
     * player replaces it.
     * @param {HTMLVideoElement|null} video
     */
    function watchSubtitleChanges(video) {
        const list = video && video.textTracks;
        if (!list || list === watchedTrackList || typeof list.addEventListener !== 'function') return;
        if (watchedTrackList && typeof watchedTrackList.removeEventListener === 'function') {
            watchedTrackList.removeEventListener('change', onTrackListChange);
        }
        watchedTrackList = list;
        list.addEventListener('change', onTrackListChange);
    }

    /**
     * The offset the dialog shows and jumps with: 0 for subtitles jellyfin-web doesn't draw
     * itself. jellyfin-web's hidden slider keeps an earlier
     * track's value after a track switch, while the player resets the offset to 0. With enough
     * cues it is measured from them; otherwise, when nobody has written the offset since the
     * current renderer appeared, it is 0; otherwise the slider's.
     * @param {DialogState} state
     * @returns {number|null} null when the player has no subtitle offset.
     */
    function effectiveOffset(state) {
        const slider = currentOffset();
        if (slider === null) return null;
        // Subtitles jellyfin-web doesn't draw itself (burned into the picture) never move with it.
        if (!clientRendersSubtitles(state.video)) return 0;
        if (state.lines) {
            const measured = measureOffset(state.lines, cueSample(state.video));
            if (typeof measured === 'number') return measured;
        }
        noteRenderer();
        const key = rendererKey(state.video);
        if (key && rendererFirstSeen.has(key) && rendererFirstSeen.get(key) === sliderWrites) return 0;
        return slider;
    }

    /**
     * Which of jellyfin-web's renderers shows the primary subtitles, and what it draws with.
     * @param {HTMLVideoElement} video
     * @returns {{kind: 'cues', track: TextTrack, cue: TextTrackCue|null}|{kind: 'drawn', el: Element}|{kind: 'none'}}
     */
    function rendererOf(video) {
        const track = shownCueTrack(video);
        if (track) return { kind: 'cues', track, cue: firstCue(video) };
        const el = drawnSurface(video);
        return el ? { kind: 'drawn', el } : { kind: 'none' };
    }

    /**
     * Whether two renderer readings are the same subtitles: the same cue track holding the same
     * cues, the same drawn element, or nothing drawn both times.
     * @param {ReturnType<typeof rendererOf>} a
     * @param {ReturnType<typeof rendererOf>} b
     * @returns {boolean}
     */
    function sameRenderer(a, b) {
        if (a.kind !== b.kind) return false;
        if (a.kind === 'cues') return a.track === b.track && a.cue === b.cue;
        if (a.kind === 'drawn') return a.el === b.el;
        return true;
    }

    /**
     * Whether the listed lines are still the subtitles on screen: jellyfin-web still draws them
     * with what it drew them with when they loaded (see sameRenderer), and cues, if any, carry
     * their text. A track switch, subtitles going off or another renderer appearing all fail it.
     * @param {DialogState} state
     * @returns {boolean}
     */
    function linesStillShown(state) {
        if (!state.lines || !state.renderer) return false;
        if (!sameRenderer(state.renderer, rendererOf(state.video))) return false;
        return measureOffset(state.lines, cueSample(state.video)) !== 'mismatch';
    }

    /**
     * Whether jellyfin-web draws the current subtitles itself, so an offset moves them: a cue
     * track it fills ('manualTrack'), its custom subtitle element, or the libass canvas for
     * ASS/SSA. Burned-in subtitles have none of these.
     * @param {HTMLVideoElement} video
     * @returns {boolean}
     */
    function clientRendersSubtitles(video) {
        if (shownCueTrack(video)) return true;
        if (document.querySelector('.videoSubtitles .videoSubtitlesInner')) return true;
        const parent = video && video.parentElement;
        return !!(parent && parent.querySelector('.libassjs-canvas-parent, .libassjs-canvas'));
    }

    /**
     * Whether choosing a line can sync it, and if not, why.
     * @param {HTMLVideoElement} video
     * @returns {{ok: boolean, reason?: 'unavailable'|'burned'}}
     */
    function syncSupport(video) {
        if (currentOffset() === null) return { ok: false, reason: 'unavailable' };
        if (!clientRendersSubtitles(video)) return { ok: false, reason: 'burned' };
        return { ok: true };
    }

    /** @returns {string|null} */
    function currentUserId() {
        try {
            return JE.session?.getUserId?.() || window.ApiClient?.getCurrentUserId?.() || null;
        } catch (err) {
            return null;
        }
    }

    /**
     * Normalises a Jellyfin id for comparison (no dashes, lower case).
     * @param {*} value
     * @returns {string|null}
     */
    function normalizeId(value) {
        const v = String(value || '').replace(/-/g, '').toLowerCase();
        return v || null;
    }

    /**
     * The item the page shows it is playing, when the source URL or the route names it.
     * @param {HTMLVideoElement} video
     * @returns {string|null}
     */
    function itemHint(video) {
        const parse = JE.internals?.autoSkip?.parseItemIdFromVideosSrc;
        const fromSrc = typeof parse === 'function' ? parse(videoSrc(video)) : null;
        return normalizeId(fromSrc || JE.internals?.player?.getCurrentVideoItemId?.());
    }

    // ── Dialog ────────────────────────────────────────────────────────────────────────────

    /**
     * @typedef {Object} DialogState
     * @property {HTMLVideoElement} video
     * @property {string} src
     * @property {number} epoch
     * @property {number} anchor Media time when the dialog opened, seconds.
     * @property {boolean} pausedByUs Whether the dialog paused playback (cleared by a seek made elsewhere while open).
     * @property {number} generationAtOpen subtitleGeneration when the dialog opened.
     * @property {AbortController} abort
     * @property {Element|null} returnFocus
     * @property {HTMLElement} overlay
     * @property {SubtitleLine[]|null} lines
     * @property {Map<number, HTMLElement>} rows
     * @property {Array<() => void>} cleanup
     * @property {*} searchTimer
     * @property {boolean} supportShown Whether the hint currently says choosing a line syncs it.
     * @property {{kind: string, track?: TextTrack, cue?: TextTrackCue|null, el?: Element}|null} renderer What drew the subtitles when the lines were checked.
     * @property {boolean} [relooked] Whether the lines were looked up again after the surface changed during a load.
     */

    /** @type {DialogState|null} */
    let dialog = null;

    /** The last track loaded, so reopening on the same track needs no request. */
    let lineCache = null;

    /** A closed dialog's resume still waiting to be decided (see closeDialog). */
    let pendingResume = null;

    /** Drops a closed dialog's waiting resume: a new dialog now owns what happens to playback. */
    function cancelPendingResume() {
        if (pendingResume) pendingResume.cancel();
        pendingResume = null;
    }

    /**
     * Whether a dialog is still the open one and still about the same playback.
     * @param {DialogState} state
     * @returns {boolean}
     */
    function isCurrent(state) {
        return dialog === state
            && (!JE.session || JE.session.isCurrent(state.epoch))
            && state.video.isConnected
            && getVideo() === state.video
            && videoSrc(state.video) === state.src;
    }

    /** Adds the dialog and OSD button styles once. */
    function injectStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const accent = JE.themer?.getThemeVariables?.()?.primaryAccent || '#00a4dc';
        const css = `
            .btnSubtitles.hide + #${BUTTON_ID} { display: none !important; }
            /* JE's Material Symbols subset (declared in ui-styles.js), at the size of the player's own icons. */
            #${BUTTON_ID} .je-msym-rounded {
                font-family: 'JE Material Symbols Rounded'; font-weight: normal; font-style: normal; font-size: 1.67em;
                line-height: 1; letter-spacing: normal; text-transform: none; display: inline-block; white-space: nowrap;
                word-wrap: normal; direction: ltr; font-feature-settings: 'liga'; -webkit-font-smoothing: antialiased;
            }
            #${OVERLAY_ID} {
                position: fixed; inset: 0; z-index: 10000; display: flex; align-items: center; justify-content: center;
                padding: 16px; box-sizing: border-box; background: rgba(0,0,0,0.6);
                --je-subsync-accent: ${accent};
            }
            #${OVERLAY_ID} .je-subsync-dialog {
                display: flex; flex-direction: column; width: min(680px, 100%); max-height: min(80vh, 760px);
                background: rgba(24,24,24,0.97); color: #fff; border: 1px solid rgba(255,255,255,0.12);
                border-radius: 12px; box-shadow: 0 16px 48px rgba(0,0,0,0.6); overflow: hidden; font-size: 15px;
            }
            #${OVERLAY_ID} .je-subsync-head { display: flex; align-items: flex-start; gap: 12px; padding: 16px 16px 8px 20px; }
            #${OVERLAY_ID} .je-subsync-titles { flex: 1; min-width: 0; }
            #${OVERLAY_ID} .je-subsync-title { margin: 0; font-size: 1.15em; font-weight: 600; }
            #${OVERLAY_ID} .je-subsync-track { margin-top: 2px; font-size: 0.85em; color: rgba(255,255,255,0.65); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            #${OVERLAY_ID} .je-subsync-icon-btn {
                flex: none; display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px;
                border: 0; border-radius: 50%; background: transparent; color: inherit; cursor: pointer; padding: 0;
            }
            #${OVERLAY_ID} .je-subsync-icon-btn:hover, #${OVERLAY_ID} .je-subsync-icon-btn:focus-visible { background: rgba(255,255,255,0.12); outline: none; }
            #${OVERLAY_ID} .je-subsync-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px; padding: 0 20px 10px; font-size: 0.85em; color: rgba(255,255,255,0.75); }
            #${OVERLAY_ID} .je-subsync-meta b { color: #fff; font-variant-numeric: tabular-nums; }
            #${OVERLAY_ID} .je-subsync-reset {
                border: 1px solid rgba(255,255,255,0.25); background: transparent; color: inherit; border-radius: 999px;
                padding: 2px 10px; font: inherit; cursor: pointer;
            }
            #${OVERLAY_ID} .je-subsync-reset:hover, #${OVERLAY_ID} .je-subsync-reset:focus-visible { border-color: var(--je-subsync-accent); outline: none; }
            #${OVERLAY_ID} .je-subsync-reset[hidden] { display: none; }
            #${OVERLAY_ID} .je-subsync-search { padding: 0 16px 8px; }
            #${OVERLAY_ID} .je-subsync-input {
                width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px; font: inherit; color: #fff;
                background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.18);
            }
            #${OVERLAY_ID} .je-subsync-input:focus { outline: none; border-color: var(--je-subsync-accent); }
            #${OVERLAY_ID} .je-subsync-hint { padding: 0 20px 8px; font-size: 0.8em; color: rgba(255,255,255,0.6); }
            #${OVERLAY_ID} .je-subsync-status { padding: 4px 20px 8px; font-size: 0.85em; }
            #${OVERLAY_ID} .je-subsync-status:empty { display: none; }
            #${OVERLAY_ID} .je-subsync-status[data-kind="error"] { color: #ff8a80; }
            #${OVERLAY_ID} .je-subsync-status button { margin-left: 8px; }
            #${OVERLAY_ID} .je-subsync-list { list-style: none; margin: 0; padding: 0 8px 8px; overflow-y: auto; flex: 1; min-height: 0; overscroll-behavior: contain; }
            #${OVERLAY_ID} .je-subsync-row { display: flex; align-items: stretch; border-radius: 8px; }
            #${OVERLAY_ID} .je-subsync-row[hidden] { display: none; }
            #${OVERLAY_ID} .je-subsync-row.is-current { background: rgba(255,255,255,0.07); box-shadow: inset 3px 0 0 var(--je-subsync-accent); }
            #${OVERLAY_ID} .je-subsync-line {
                flex: 1; min-width: 0; display: flex; gap: 12px; align-items: baseline; text-align: left; padding: 8px 10px;
                border: 0; border-radius: 8px; background: transparent; color: inherit; font: inherit; cursor: pointer;
            }
            #${OVERLAY_ID} .je-subsync-line:hover, #${OVERLAY_ID} .je-subsync-line:focus-visible { background: rgba(255,255,255,0.12); outline: none; }
            #${OVERLAY_ID} .je-subsync-time { flex: none; min-width: 4.2em; font-size: 0.85em; color: rgba(255,255,255,0.6); font-variant-numeric: tabular-nums; }
            #${OVERLAY_ID} .je-subsync-text { flex: 1; min-width: 0; white-space: pre-line; overflow-wrap: anywhere; }
            #${OVERLAY_ID} .je-subsync-jump { align-self: center; color: rgba(255,255,255,0.7); }
            #${OVERLAY_ID} .je-subsync-empty { padding: 24px 20px; text-align: center; color: rgba(255,255,255,0.6); }
            #${OVERLAY_ID} .je-subsync-foot { padding: 8px 20px 12px; font-size: 0.8em; color: rgba(255,255,255,0.55); border-top: 1px solid rgba(255,255,255,0.08); }
            #${OVERLAY_ID} .material-icons { font-size: 22px; }
            @media (max-width: 600px) {
                #${OVERLAY_ID} { padding: 16px; align-items: flex-end; }
                #${OVERLAY_ID} .je-subsync-dialog { max-height: 85vh; }
            }
        `;
        if (JE.core?.ui?.injectCss) {
            JE.core.ui.injectCss(STYLE_ID, css);
        } else {
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = css;
            document.head.appendChild(style);
        }
    }

    /**
     * Builds the dialog's static markup. Every value is set through textContent afterwards.
     * @returns {HTMLElement}
     */
    function buildOverlay() {
        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.setAttribute('data-je-own-keys', '');
        overlay.innerHTML = `
            <div class="je-subsync-dialog" role="dialog" aria-modal="true" aria-labelledby="je-subsync-title">
                <div class="je-subsync-head">
                    <div class="je-subsync-titles">
                        <h2 class="je-subsync-title" id="je-subsync-title"></h2>
                        <div class="je-subsync-track"></div>
                    </div>
                    <button type="button" class="je-subsync-icon-btn je-subsync-close"><span class="material-icons close" aria-hidden="true"></span></button>
                </div>
                <div class="je-subsync-meta">
                    <span class="je-subsync-anchor"></span>
                    <span class="je-subsync-offset"></span>
                    <button type="button" class="je-subsync-reset" hidden></button>
                </div>
                <div class="je-subsync-search"><input type="search" class="je-subsync-input" autocomplete="off" spellcheck="false" enterkeyhint="search"></div>
                <div class="je-subsync-hint"></div>
                <div class="je-subsync-status" role="status" aria-live="polite"></div>
                <ul class="je-subsync-list"></ul>
                <div class="je-subsync-foot" aria-live="polite"></div>
            </div>`;
        const title = tr('subtitle_sync_title', 'Sync subtitles');
        overlay.querySelector('.je-subsync-title').textContent = title;
        const close = overlay.querySelector('.je-subsync-close');
        close.title = tr('subtitle_sync_close', 'Close');
        close.setAttribute('aria-label', close.title);
        const input = /** @type {HTMLInputElement} */ (overlay.querySelector('.je-subsync-input'));
        input.placeholder = tr('subtitle_sync_placeholder', 'Search the subtitles');
        input.setAttribute('aria-label', input.placeholder);
        overlay.querySelector('.je-subsync-reset').textContent = tr('subtitle_sync_reset', 'Reset offset');
        return overlay;
    }

    /**
     * Shows a message above the list; `action` adds a button after it.
     * @param {DialogState} state
     * @param {string} text
     * @param {'info'|'error'} [kind]
     * @param {{label: string, run: () => void}} [action]
     */
    function setStatus(state, text, kind, action) {
        const box = state.overlay.querySelector('.je-subsync-status');
        box.replaceChildren();
        box.dataset.kind = kind || 'info';
        if (!text) return;
        box.append(document.createTextNode(text));
        if (action) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'je-subsync-reset';
            btn.textContent = action.label;
            btn.addEventListener('click', action.run);
            box.append(btn);
        }
    }

    /**
     * Refreshes the sync point, offset, hint and each line's time from the player's current
     * offset (jellyfin-web owns it; it is read again on every refresh).
     * @param {DialogState} state
     */
    function refreshMeta(state) {
        const offset = effectiveOffset(state);
        const o = offset === null ? 0 : offset;
        state.overlay.querySelector('.je-subsync-anchor').textContent =
            tr('subtitle_sync_sync_point', 'Heard at {time}', { time: formatTime(state.anchor) });
        const offsetEl = state.overlay.querySelector('.je-subsync-offset');
        // Only with a track listed that the offset moves: without one the slider may still hold an
        // earlier track's value, and burned-in subtitles don't move with it.
        const showOffset = offset !== null && !!(state.lines && state.lines.length) && syncSupport(state.video).ok;
        offsetEl.textContent = showOffset ? tr('subtitle_sync_offset', 'Offset {offset}', { offset: formatOffset(o) }) : '';
        const reset = /** @type {HTMLButtonElement} */ (state.overlay.querySelector('.je-subsync-reset'));
        reset.hidden = !showOffset || roundOffset(o) === 0;
        const support = syncSupport(state.video);
        state.supportShown = support.ok;
        const hint = state.overlay.querySelector('.je-subsync-hint');
        if (!state.lines || !state.lines.length) {
            hint.textContent = '';
        } else if (support.ok) {
            hint.textContent = tr('subtitle_sync_hint', 'Choose the line you just heard to sync the subtitles to it. The arrow button jumps to a line.');
        } else if (support.reason === 'burned') {
            hint.textContent = tr('subtitle_sync_hint_burned', 'These subtitles are part of the video picture, so they can\'t be shifted. Choosing a line jumps to it.');
        } else {
            hint.textContent = tr('subtitle_sync_hint_unavailable', 'This player can\'t shift subtitles. Choosing a line jumps to it.');
        }
        if (state.lines) {
            const currentIndex = lineIndexAt(state.lines, state.anchor, o);
            for (const [index, row] of state.rows) {
                row.querySelector('.je-subsync-time').textContent = formatTime(state.lines[index].start - o);
                row.classList.toggle('is-current', index === currentIndex);
            }
        }
    }

    /**
     * Renders every line once; searching only hides rows.
     * @param {DialogState} state
     */
    function renderLines(state) {
        const list = state.overlay.querySelector('.je-subsync-list');
        const fragment = document.createDocumentFragment();
        state.rows = new Map();
        const jumpLabel = tr('subtitle_sync_jump', 'Go to this line');
        for (const line of state.lines || []) {
            const row = document.createElement('li');
            row.className = 'je-subsync-row';
            row.dataset.index = String(line.index);
            const main = document.createElement('button');
            main.type = 'button';
            main.className = 'je-subsync-line';
            const time = document.createElement('span');
            time.className = 'je-subsync-time';
            const text = document.createElement('span');
            text.className = 'je-subsync-text';
            text.textContent = line.text;
            main.append(time, text);
            const jump = document.createElement('button');
            jump.type = 'button';
            jump.className = 'je-subsync-icon-btn je-subsync-jump';
            jump.title = jumpLabel;
            jump.setAttribute('aria-label', jumpLabel);
            jump.innerHTML = '<span class="material-icons redo" aria-hidden="true"></span>';
            row.append(main, jump);
            fragment.append(row);
            state.rows.set(line.index, row);
        }
        list.replaceChildren(fragment);
        refreshMeta(state);
        applyFilter(state);
    }

    /**
     * Hides the rows the search does not match and updates the count; with an empty search it
     * scrolls to the line showing at the sync point.
     * @param {DialogState} state
     */
    function applyFilter(state) {
        if (!state.lines) return;
        const query = /** @type {HTMLInputElement} */ (state.overlay.querySelector('.je-subsync-input')).value;
        const matches = filterLines(state.lines, query);
        const shown = new Set(matches.map(line => line.index));
        for (const [index, row] of state.rows) row.hidden = !shown.has(index);
        const list = state.overlay.querySelector('.je-subsync-list');
        let empty = list.querySelector('.je-subsync-empty');
        if (!matches.length && state.lines.length) {
            if (!empty) {
                empty = document.createElement('li');
                empty.className = 'je-subsync-empty';
                list.append(empty);
            }
            empty.textContent = tr('subtitle_sync_no_match', 'No lines match your search.');
        } else if (empty) {
            empty.remove();
        }
        state.overlay.querySelector('.je-subsync-foot').textContent =
            tr('subtitle_sync_count', '{shown} of {total} lines', { shown: matches.length, total: state.lines.length });
        if (!searchKey(query)) {
            const current = list.querySelector('.je-subsync-row.is-current');
            if (current) current.scrollIntoView({ block: 'center' });
        } else {
            list.scrollTop = 0;
        }
    }

    /**
     * Resolves with a lookup's answer, or with `fallback` when it fails or `ms` pass without an
     * answer (ApiClient lookups can't be aborted; a late answer is ignored).
     * @template T
     * @param {Promise<T>|T} promise
     * @param {number} ms
     * @param {T} fallback
     * @returns {Promise<T>}
     */
    function withTimeout(promise, ms, fallback) {
        return new Promise(resolve => {
            const timer = setTimeout(() => resolve(fallback), ms);
            Promise.resolve(promise).then(
                value => { clearTimeout(timer); resolve(value); },
                () => { clearTimeout(timer); resolve(fallback); });
        });
    }

    /**
     * This device's session, once it is known to describe what is on screen. jellyfin-web
     * reports its whole state on pause and at least every ten seconds. After a subtitle change on
     * screen in the last REPORT_INTERVAL_MS (a track shown, switched or turned off, see
     * noteRenderer), before or after the dialog opened, nothing already on the server can be shown
     * to be newer than the change, so the dialog waits for the next report (LastPlaybackCheckIn
     * moves past the first value it sees). Without one, the server's last report came after the
     * last change; when the dialog paused playback it still waits for that pause's report
     * (isPauseReport), which also covers a change it could not see (image subtitles). Null when
     * no current answer came in time.
     * @param {DialogState} state
     * @returns {Promise<object|null>}
     */
    async function probeFreshSession(state) {
        const probe = JE.internals?.player?.probeOwnSession;
        if (typeof probe !== 'function') return null;
        const deadline = Date.now() + TIMEOUTS.sessionWait;
        const awaitReport = subtitlesChangedAt > 0 && Date.now() - subtitlesChangedAt < REPORT_INTERVAL_MS;
        /** @type {string|null|undefined} undefined until a session has been seen. */
        let baseline;
        for (;;) {
            const session = await withTimeout(probe(), Math.max(1, deadline - Date.now()), null);
            if (!isCurrent(state)) return null;
            if (session) {
                const checkIn = session.LastPlaybackCheckIn || null;
                if (awaitReport) {
                    if (baseline === undefined) baseline = checkIn;
                    else if (checkIn !== baseline) return session;
                } else if (state.pausedByUs) {
                    if (isPauseReport(session, state)) return session;
                } else {
                    return session;
                }
            }
            if (Date.now() >= deadline) return null;
            await new Promise(resolve => setTimeout(resolve, TIMEOUTS.sessionPoll));
            if (!isCurrent(state)) return null;
        }
    }

    /**
     * Whether a session's state is the report of the dialog's own pause: paused at the position
     * the dialog opened at (jellyfin-web reports the position it paused at). An earlier pause's
     * report still on the server would show another position.
     * @param {object} session
     * @param {DialogState} state
     * @returns {boolean}
     */
    function isPauseReport(session, state) {
        const playState = session && session.PlayState;
        if (!playState || playState.IsPaused !== true) return false;
        const position = Number(playState.PositionTicks) / TICKS_PER_SECOND;
        return Number.isFinite(position) && Math.abs(position - state.anchor) <= PAUSE_POSITION_TOLERANCE;
    }

    /**
     * Resolves which subtitle track is playing: the server's view of this device's session,
     * checked against the item the page is playing.
     * @param {DialogState} state
     * @returns {Promise<null|{error: 'session'|'none'|'image', stream?: object}|{itemId: string, mediaSourceId: string, index: number, stream: object|null}>}
     */
    async function resolveTrack(state) {
        const session = await probeFreshSession(state);
        if (!isCurrent(state)) return null;
        const nowPlaying = session && session.NowPlayingItem;
        const itemId = nowPlaying && nowPlaying.Id;
        const hint = itemHint(state.video);
        if (!itemId || (hint && hint !== normalizeId(itemId))) return { error: 'session' };
        const playState = session.PlayState || {};
        const index = typeof playState.SubtitleStreamIndex === 'number' ? playState.SubtitleStreamIndex : -1;
        if (index < 0) return { error: 'none' };
        const mediaSourceId = playState.MediaSourceId || itemId;
        let stream = null;
        try {
            const userId = currentUserId();
            const item = userId && window.ApiClient
                ? await withTimeout(window.ApiClient.getItem(userId, itemId), TIMEOUTS.lookup, null)
                : null;
            if (!isCurrent(state)) return null;
            const source = (item && Array.isArray(item.MediaSources) ? item.MediaSources : [])
                .find(s => s && normalizeId(s.Id) === normalizeId(mediaSourceId));
            stream = (source && Array.isArray(source.MediaStreams) ? source.MediaStreams : [])
                .find(s => s && s.Type === 'Subtitle' && s.Index === index) || null;
        } catch (err) {
            // The track's description is only for the label and the image check; the lines
            // request below still tells whether the track has text.
            console.warn('🪼 Jellyfin Enhanced: subtitle sync item lookup failed', err);
        }
        if (!isCurrent(state)) return null;
        if (!stream) {
            stream = (Array.isArray(nowPlaying.MediaStreams) ? nowPlaying.MediaStreams : [])
                .find(s => s && s.Type === 'Subtitle' && s.Index === index) || null;
        }
        if (stream && stream.IsTextSubtitleStream === false) return { error: 'image', stream };
        return { itemId, mediaSourceId, index, stream };
    }

    /**
     * Fetches the track's lines (or reuses the last track's).
     * @param {DialogState} state
     * @param {{itemId: string, mediaSourceId: string, index: number}} track
     * @returns {Promise<SubtitleLine[]>}
     */
    async function loadLines(state, track) {
        const key = [currentUserId(), normalizeId(track.itemId), normalizeId(track.mediaSourceId), track.index].join('|');
        if (lineCache && lineCache.key === key) return lineCache.lines;
        const path = `/Videos/${encodeURIComponent(track.itemId)}/${encodeURIComponent(track.mediaSourceId)}/Subtitles/${track.index}/0/Stream.js`;
        const data = await JE.core.api.jf(path, { signal: state.abort.signal, timeoutMs: FETCH_TIMEOUT_MS });
        const lines = parseTrackEvents(data);
        if (JE.session ? JE.session.isCurrent(state.epoch) : true) lineCache = { key, lines };
        return lines;
    }

    /**
     * A readable name for the subtitle track.
     * @param {object|null} stream
     * @returns {string}
     */
    function trackLabel(stream) {
        if (!stream) return '';
        return String(stream.DisplayTitle || stream.Title || stream.Language || '').trim();
    }

    /**
     * Loads the track and its lines into the dialog, showing what went wrong otherwise.
     * @param {DialogState} state
     */
    async function populate(state) {
        setStatus(state, tr('subtitle_sync_loading', 'Loading the subtitle lines…'));
        // What drew the subtitles before anything was looked up, to check the answer against.
        catchUpSubtitleChanges();
        const startRenderer = rendererOf(state.video);
        const startGeneration = subtitleGeneration;
        let track;
        try {
            track = await resolveTrack(state);
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: subtitle sync track lookup failed', err);
            track = { error: 'session' };
        }
        if (!track || !isCurrent(state)) return;
        const label = trackLabel(track.stream || null);
        state.overlay.querySelector('.je-subsync-track').textContent = label;
        if ('error' in track) {
            if (track.error === 'none') {
                setStatus(state, tr('subtitle_sync_none', 'Turn on a subtitle track first.'), 'info', {
                    label: tr('subtitle_sync_choose_track', 'Choose subtitles'),
                    run: () => {
                        closeDialog();
                        document.querySelector('.videoOsdBottom .btnSubtitles')?.click();
                    }
                });
            } else if (track.error === 'image') {
                setStatus(state, tr('subtitle_sync_image', 'This subtitle track is made of images, so its lines can\'t be listed.'), 'info');
            } else {
                setStatus(state, tr('subtitle_sync_error_session', 'Couldn\'t tell which subtitles are playing.'), 'error', {
                    label: tr('subtitle_sync_retry', 'Try again'), run: () => populate(state)
                });
            }
            return;
        }
        let lines;
        try {
            lines = await loadLines(state, track);
        } catch (err) {
            if (!isCurrent(state)) return;
            console.warn('🪼 Jellyfin Enhanced: subtitle lines request failed', err);
            setStatus(state, tr('subtitle_sync_error_load', 'Couldn\'t load the subtitle lines.'), 'error', {
                label: tr('subtitle_sync_retry', 'Try again'), run: () => populate(state)
            });
            return;
        }
        if (!isCurrent(state)) return;
        if (!lines.length) {
            setStatus(state, tr('subtitle_sync_empty', 'This subtitle track has no lines.'), 'info');
            return;
        }
        // The answer describes the subtitles that were on screen when the lookup started. If they
        // changed meanwhile (switched, turned off, another renderer), look once more.
        const now = rendererOf(state.video);
        const unproven = !sameRenderer(startRenderer, now) || subtitleGeneration !== startGeneration;
        if (unproven && !state.relooked) {
            state.relooked = true;
            populate(state);
            return;
        }
        if (unproven || measureOffset(lines, cueSample(state.video)) === 'mismatch') {
            showStale(state);
            return;
        }
        setStatus(state, '');
        state.renderer = now;
        state.lines = lines;
        renderLines(state);
    }

    /**
     * Says the listed lines no longer match the subtitles on screen and offers to reload them;
     * the rows are cleared so none of them can be used.
     * @param {DialogState} state
     */
    function showStale(state) {
        state.lines = null;
        state.renderer = null;
        state.rows = new Map();
        state.overlay.querySelector('.je-subsync-list').replaceChildren();
        state.overlay.querySelector('.je-subsync-foot').textContent = '';
        refreshMeta(state);
        setStatus(state, tr('subtitle_sync_stale', 'These lines don\'t match the subtitles on screen.'), 'error', {
            label: tr('subtitle_sync_reload', 'Reload'), run: () => populate(state)
        });
    }

    /**
     * Syncs the subtitles so `line` shows at the sync point; when the player can't shift these
     * subtitles (the hint says so) it jumps to the line instead.
     * @param {DialogState} state
     * @param {SubtitleLine} line
     */
    function chooseLine(state, line) {
        if (!isCurrent(state)) {
            closeDialog({ resume: false });
            return;
        }
        if (!linesStillShown(state)) {
            showStale(state);
            return;
        }
        const support = syncSupport(state.video);
        if (support.ok !== state.supportShown) {
            // The subtitles started or stopped being shiftable since the hint was written:
            // update it rather than do something it doesn't describe.
            refreshMeta(state);
            return;
        }
        if (!support.ok) {
            jumpToLine(state, line);
            return;
        }
        const offset = syncOffsetFor(line.start, state.anchor);
        if (!offsetInRange(offset)) {
            setStatus(state, tr('subtitle_sync_too_far', 'That line is {offset} away. Jellyfin can shift subtitles by up to {max} seconds.', {
                offset: formatOffset(offset), max: MAX_OFFSET_SECONDS
            }), 'error');
            return;
        }
        if (typeof JE.setSubtitleOffset !== 'function' || !JE.setSubtitleOffset(offset)) {
            setStatus(state, tr('subtitle_sync_hint_unavailable', 'This player can\'t shift subtitles. Choosing a line jumps to it.'), 'error');
            refreshMeta(state);
            return;
        }
        JE.toast?.(tr('subtitle_sync_synced', 'Subtitles synced ({offset})', { offset: formatOffset(offset) }));
        closeDialog();
    }

    /**
     * Seeks to where `line` shows with the current offset, then closes the dialog. A progressive
     * transcode only holds what the server has produced from where that stream started, so a
     * line outside the element's seekable range is not jumped to; the dialog says why.
     * @param {DialogState} state
     * @param {SubtitleLine} line
     */
    function jumpToLine(state, line) {
        if (!isCurrent(state)) {
            closeDialog({ resume: false });
            return;
        }
        if (!linesStillShown(state)) {
            showStale(state);
            return;
        }
        const offset = effectiveOffset(state) || 0;
        const elementTime = Math.max(0, line.start - offset) - transcodeOffsetSeconds(state.video);
        if (isProgressiveTranscode(videoSrc(state.video)) && !withinSeekable(state.video, elementTime)) {
            setStatus(state, tr('subtitle_sync_jump_unavailable', 'This stream can only jump within the part the server has prepared so far, and that line is outside it.'), 'error');
            return;
        }
        state.video.currentTime = Math.max(0, elementTime);
        closeDialog();
    }

    /**
     * Whether the media element can seek to a time (its seekable ranges).
     * @param {HTMLVideoElement} video
     * @param {number} time Element time, seconds.
     * @returns {boolean}
     */
    function withinSeekable(video, time) {
        if (!(time >= 0)) return false;
        try {
            const ranges = video.seekable;
            for (let i = 0; ranges && i < ranges.length; i++) {
                if (time >= ranges.start(i) && time <= ranges.end(i)) return true;
            }
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: subtitle sync seekable check failed', err);
        }
        return false;
    }

    /**
     * Whether a source is a progressive transcode: a server stream URL that is neither direct
     * play (Static=true) nor an HLS playlist (hls.js plays from a blob: URL).
     * @param {string} src
     * @returns {boolean}
     */
    function isProgressiveTranscode(src) {
        if (!/^https?:/i.test(src || '')) return false;
        const q = src.indexOf('?');
        const path = (q === -1 ? src : src.slice(0, q)).toLowerCase();
        if (!path.includes('/videos/') || path.endsWith('.m3u8')) return false;
        for (const [name, value] of new URLSearchParams(q === -1 ? '' : src.slice(q + 1))) {
            if (name.toLowerCase() === 'static' && String(value).toLowerCase() === 'true') return false;
        }
        return true;
    }

    /**
     * Moves focus between the visible lines (and from the search box into the list).
     * @param {DialogState} state
     * @param {Element} from
     * @param {1|-1} step
     * @returns {boolean} Whether focus moved.
     */
    function moveFocus(state, from, step) {
        const buttons = Array.from(state.overlay.querySelectorAll('.je-subsync-row:not([hidden]) .je-subsync-line'));
        if (!buttons.length) return false;
        const input = state.overlay.querySelector('.je-subsync-input');
        if (from === input) {
            if (step < 0) return false;
            // Into the list at the highlighted line when it is shown, else at the first match.
            const current = state.overlay.querySelector('.je-subsync-row.is-current:not([hidden]) .je-subsync-line');
            const first = /** @type {HTMLElement} */ (current || buttons[0]);
            first.focus();
            first.scrollIntoView({ block: 'nearest' });
            return true;
        }
        const row = from.closest('.je-subsync-row');
        const at = row ? buttons.indexOf(row.querySelector('.je-subsync-line')) : -1;
        if (at === -1) return false;
        const next = at + step;
        if (next < 0) {
            /** @type {HTMLElement} */ (input).focus();
            return true;
        }
        if (next >= buttons.length) return false;
        /** @type {HTMLElement} */ (buttons[next]).focus();
        buttons[next].scrollIntoView({ block: 'nearest' });
        return true;
    }

    /**
     * TV remote and gamepad key codes, named the way jellyfin-web's keyboardNavigation names
     * them (with its aliases applied), so its Back, D-pad and select keys work in the dialog.
     */
    const KEY_CODE_NAMES = {
        13: 'Enter', 27: 'Escape', 38: 'ArrowUp', 40: 'ArrowDown',
        138: 'ArrowUp', 139: 'ArrowDown', 195: 'GamepadA', 196: 'Escape',
        203: 'ArrowUp', 204: 'ArrowDown', 211: 'ArrowUp', 212: 'ArrowDown',
        461: 'Back', 10009: 'Back'
    };

    /**
     * The key a keydown means in the dialog.
     * @param {KeyboardEvent} e
     * @returns {string}
     */
    function dialogKeyName(e) {
        return KEY_CODE_NAMES[e.keyCode] || e.key || '';
    }

    /**
     * Keys inside the dialog: Escape closes, arrows move between lines, Tab stays inside. No
     * key reaches jellyfin-web's player keys (Space would pause) or JE's other shortcuts.
     * @param {DialogState} state
     * @param {KeyboardEvent} e
     */
    function onDialogKey(state, e) {
        e.stopPropagation();
        if (e.type !== 'keydown') return;
        const target = /** @type {Element} */ (e.target);
        const key = dialogKeyName(e);
        if (key === 'Escape' || key === 'Back' || key === 'BrowserBack' || key === 'GoBack') {
            e.preventDefault();
            closeDialog();
            return;
        }
        if (key === 'ArrowDown' || key === 'ArrowUp') {
            if (moveFocus(state, target, key === 'ArrowDown' ? 1 : -1)) e.preventDefault();
            return;
        }
        if ((key === 'Enter' || key === 'GamepadA') && target.classList.contains('je-subsync-input')) {
            e.preventDefault();
            moveFocus(state, target, 1);
            return;
        }
        if (key === 'GamepadA' && target instanceof window.HTMLButtonElement) {
            e.preventDefault();
            target.click();
            return;
        }
        if (e.key === 'Tab') {
            const focusable = Array.from(state.overlay.querySelectorAll('button:not([hidden]), input'))
                .filter(el => !el.closest('[hidden]') && /** @type {HTMLElement} */ (el).offsetParent !== null);
            if (!focusable.length) return;
            const first = /** @type {HTMLElement} */ (focusable[0]);
            const last = /** @type {HTMLElement} */ (focusable[focusable.length - 1]);
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
        const canonical = JE.internals?.canonicalCombo;
        const bound = JE.state?.activeShortcuts?.SubtitleSync;
        if (combo && bound && (typeof canonical === 'function' ? canonical(bound) === canonical(combo) : bound === combo)) {
            e.preventDefault();
            closeDialog();
        }
    }

    /**
     * Opens the dialog for the subtitle track that is playing. Pauses playback while it is open.
     */
    function openDialog() {
        if (dialog) {
            if (isCurrent(dialog)) {
                /** @type {HTMLElement|null} */ (dialog.overlay.querySelector('.je-subsync-input'))?.focus();
                return;
            }
            closeDialog({ resume: false });
        }
        const video = getVideo();
        const onVideoPage = typeof JE.isVideoPage !== 'function' || JE.isVideoPage();
        if (!video || !onVideoPage) {
            // On the player page without a <video> the player draws its own subtitles (mpv in Jellyfin
            // Desktop): there are no cues to check the lines against and no element to seek.
            JE.toast?.(video || !onVideoPage
                ? tr('toast_no_video_found', 'No video found')
                : tr('toast_player_unsupported', '{{icon:info}} Not available with this player'));
            return;
        }
        injectStyles();
        // JE's pause screen would sit behind the dialog and take its keys; it waits while the
        // dialog is open (pausescreen.js) and is put away now if it is showing.
        if (document.documentElement.classList.contains('pause-screen-active')) {
            JE.pauseScreenInstance?.hideOverlay?.();
        }
        cancelPendingResume();
        // Changes already on screen are recorded first, so only later ones count as made while
        // the dialog was open (see closeDialog).
        catchUpSubtitleChanges();
        const wasPlaying = !video.paused && !video.ended;
        if (wasPlaying) video.pause();
        const overlay = buildOverlay();
        /** @type {DialogState} */
        const state = {
            video,
            src: videoSrc(video),
            epoch: JE.session ? JE.session.getEpoch() : 0,
            anchor: mediaTime(video),
            pausedByUs: wasPlaying,
            generationAtOpen: subtitleGeneration,
            abort: new AbortController(),
            returnFocus: document.activeElement,
            overlay,
            lines: null,
            rows: new Map(),
            cleanup: [],
            searchTimer: null,
            supportShown: false,
            renderer: null
        };
        dialog = state;

        const keyHandler = (e) => onDialogKey(state, e);
        overlay.addEventListener('keydown', keyHandler);
        overlay.addEventListener('keyup', keyHandler);
        overlay.addEventListener('keypress', keyHandler);
        overlay.addEventListener('wheel', (e) => e.stopPropagation());
        overlay.addEventListener('click', (e) => {
            e.stopPropagation();
            const target = /** @type {Element} */ (e.target);
            if (target === overlay) {
                closeDialog();
                return;
            }
            if (target.closest('.je-subsync-close')) {
                closeDialog();
                return;
            }
            if (target.closest('.je-subsync-meta .je-subsync-reset')) {
                if (typeof JE.setSubtitleOffset === 'function' && JE.setSubtitleOffset(0)) {
                    JE.toast?.(tr('subtitle_sync_offset_reset', 'Subtitle offset reset'));
                }
                refreshMeta(state);
                // jellyfin-web applies an offset 100 ms later (debounced); measure again after.
                setTimeout(() => {
                    if (dialog === state) refreshMeta(state);
                }, 250);
                /** @type {HTMLElement|null} */ (overlay.querySelector('.je-subsync-input'))?.focus();
                return;
            }
            const row = target.closest('.je-subsync-row');
            if (!row || !state.lines) return;
            const line = state.lines[Number(row.dataset.index)];
            if (!line) return;
            if (target.closest('.je-subsync-jump')) {
                jumpToLine(state, line);
            } else if (target.closest('.je-subsync-line')) {
                chooseLine(state, line);
            }
        });
        const input = /** @type {HTMLInputElement} */ (overlay.querySelector('.je-subsync-input'));
        input.addEventListener('input', () => {
            clearTimeout(state.searchTimer);
            state.searchTimer = setTimeout(() => {
                if (dialog === state) applyFilter(state);
            }, SEARCH_DEBOUNCE_MS);
        });

        // Anything that ends this playback ends the dialog.
        const onGone = () => closeDialog({ resume: false });
        // jellyfin-web shows a cue track once it has loaded it, which can make these subtitles
        // shiftable after the dialog opened.
        // Checked once the change settles: Firefox flips the cue track's mode for a moment on
        // every offset change.
        const onTracks = () => setTimeout(() => {
            if (dialog !== state || !state.lines) return;
            if (linesStillShown(state)) refreshMeta(state);
            else showStale(state);
        }, 60);
        // A seek made elsewhere while the dialog is open (its own jump closes it first) means
        // playback is no longer the one the dialog paused: closing leaves it paused.
        const onSeeking = () => { state.pausedByUs = false; };
        const textTracks = video.textTracks;
        textTracks?.addEventListener?.('change', onTracks);
        video.addEventListener('seeking', onSeeking);
        video.addEventListener('emptied', onGone);
        document.addEventListener('viewshow', onGone);
        window.addEventListener('hashchange', onGone);
        state.cleanup.push(() => {
            textTracks?.removeEventListener?.('change', onTracks);
            video.removeEventListener('seeking', onSeeking);
            video.removeEventListener('emptied', onGone);
            document.removeEventListener('viewshow', onGone);
            window.removeEventListener('hashchange', onGone);
            clearTimeout(state.searchTimer);
        });

        document.body.appendChild(overlay);
        refreshMeta(state);
        input.focus();
        populate(state);
    }

    /**
     * Closes the dialog. Playback resumes only if the dialog paused it, the same video is still
     * loaded, and nothing else seeked or changed the subtitles while it was open, unless `resume`
     * is false.
     * @param {{resume?: boolean}} [opts]
     */
    function closeDialog(opts) {
        const state = dialog;
        if (!state) return;
        dialog = null;
        state.abort.abort();
        for (const fn of state.cleanup) {
            try { fn(); } catch (err) { console.warn('🪼 Jellyfin Enhanced: subtitle sync cleanup failed', err); }
        }
        state.overlay.remove();
        const video = state.video;
        if (!(opts && opts.resume === false) && state.pausedByUs) {
            // Cues that are not showing at this moment may be Firefox's brief mode flip on an
            // offset change (the same cues come back), or subtitles turned off: decide once settled.
            if (rendererKey(video) === null && rendererKeySeen) {
                // Anything that would have stopped the resume while open still stops it until then,
                // and so does another dialog opening (cancelPendingResume).
                const cancel = () => { state.pausedByUs = false; };
                const triggers = [[video, 'seeking'], [video, 'emptied'], [document, 'viewshow'], [window, 'hashchange']];
                for (const [target, name] of triggers) target.addEventListener(name, cancel);
                const settle = () => {
                    clearTimeout(timer);
                    for (const [target, name] of triggers) target.removeEventListener(name, cancel);
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
        const back = /** @type {HTMLElement|null} */ (state.returnFocus);
        if (back && back.isConnected && typeof back.focus === 'function') {
            try { back.focus({ preventScroll: true }); } catch (err) { /* focus is best effort */ }
        }
    }

    /**
     * Resumes playback the closed dialog paused, unless something else changed it while the
     * dialog was open or since: a seek or leaving the page (clears pausedByUs), a subtitle change
     * on screen (including one too recent for the settle delay to have recorded yet), another
     * video, another user, another page, or a dialog open again.
     * @param {DialogState} state
     */
    function resumeIfOwned(state) {
        const video = state.video;
        catchUpSubtitleChanges();
        if (dialog === null && state.pausedByUs && subtitleGeneration === state.generationAtOpen
            && (!JE.session || JE.session.isCurrent(state.epoch))
            && (typeof JE.isVideoPage !== 'function' || JE.isVideoPage())
            && video.isConnected && getVideo() === video && videoSrc(video) === state.src && video.paused) {
            const played = video.play();
            if (played && typeof played.catch === 'function') played.catch(() => {});
        }
    }

    /**
     * Opens the dialog, or closes it when it is open (the keyboard shortcut).
     */
    JE.toggleSubtitleSync = () => {
        if (dialog && isCurrent(dialog)) {
            closeDialog();
        } else {
            openDialog();
        }
    };

    /**
     * Adds the Subtitle Sync button after jellyfin-web's Subtitles button in the player, or
     * removes it when the setting is off. It hides with the Subtitles button through CSS.
     * Called on every video-page DOM update, which also notes subtitle changes on screen as they
     * happen (see effectiveOffset and probeFreshSession), whether or not the button is shown.
     */
    JE.addSubtitleSyncButton = () => {
        noteRenderer();
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
        const button = document.createElement('button');
        button.id = BUTTON_ID;
        button.type = 'button';
        button.setAttribute('is', 'paper-icon-button-light');
        button.className = 'autoSize paper-icon-button-light';
        button.title = label;
        button.setAttribute('aria-label', label);
        button.innerHTML = '<span class="xlargePaperIconButton je-msym-rounded" aria-hidden="true">subtitles_gear</span>';
        button.addEventListener('click', (e) => {
            e.stopPropagation();
            openDialog();
        });
        subtitlesButton.insertAdjacentElement('afterend', button);
    };

    JE.session?.onUserChange?.('subtitle-sync', () => {
        closeDialog({ resume: false });
        lineCache = null;
    });

    JE.internals = JE.internals || {};
    JE.internals.subtitleSync = {
        MAX_OFFSET_SECONDS,
        cleanLineText,
        searchKey,
        parseTrackEvents,
        filterLines,
        roundOffset,
        syncOffsetFor,
        offsetInRange,
        lineIndexAt,
        measureOffset,
        isProgressiveTranscode,
        timeouts: TIMEOUTS,
        formatTime,
        formatOffset,
        clientRendersSubtitles,
        isOpen: () => dialog !== null
    };

})(window.JellyfinEnhanced);
