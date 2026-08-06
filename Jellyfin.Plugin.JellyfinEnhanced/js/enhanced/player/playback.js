/**
 * @file Manages video playback controls and enhancements.
 */
(function(JE) {
    'use strict';

    /**
     * Finds the currently active video element on the page.
     * @returns {HTMLVideoElement|null} The video element or null if not found.
     */
    const getVideo = () => document.querySelector('video');

    /**
     * Finds the main settings button in the video player OSD.
     * @returns {HTMLElement|null} The settings button element.
     */
    const settingsBtn = () => document.querySelector(
    '.videoOsdBottom .btnVideoOsdSettings, .videoOsdBottom button[title="Settings"], .videoOsdBottom button[aria-label="Settings"]'
    );

    JE.openSettings = (cb) => {
        settingsBtn()?.click();
        setTimeout(cb, 120); // Wait for the menu to animate open
    };

    /**
     * Adjusts playback speed up or down through a predefined list of speeds.
     * @param {string} direction Either 'increase' or 'decrease'.
     */
    JE.adjustPlaybackSpeed = (direction) => {
        const video = getVideo();
        if (!video) {
            JE.toast(JE.t('toast_no_video_found'));
            return;
        }
        const speeds = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
        let currentIndex = speeds.findIndex(speed => Math.abs(speed - video.playbackRate) < 0.01);
        if (currentIndex === -1) {
            currentIndex = speeds.findIndex(speed => speed >= video.playbackRate);
            if (currentIndex === -1) currentIndex = speeds.length - 1;
        }
        if (direction === 'increase') {
            currentIndex = Math.min(currentIndex + 1, speeds.length - 1);
        } else {
            currentIndex = Math.max(currentIndex - 1, 0);
        }
        video.playbackRate = speeds[currentIndex];
        JE.toast(JE.t('toast_speed', { speed: speeds[currentIndex] }));
    };

    /**
     * Resets the video playback speed to normal (1.0x).
     */
    JE.resetPlaybackSpeed = () => {
        const video = getVideo();
        if (!video) {
            JE.toast(JE.t('toast_no_video_found'));
            return;
        }
        video.playbackRate = 1.0;
        JE.toast(JE.t('toast_speed_normal'));
    };

    /**
     * Jumps to a specific percentage of the video's duration.
     * @param {number} percentage The percentage to jump to (0-100).
     */
    JE.jumpToPercentage = (percentage) => {
        const video = getVideo();
        if (!video || !video.duration) {
            JE.toast(JE.t('toast_no_video_found'));
            return;
        }
        video.currentTime = video.duration * (percentage / 100);
        JE.toast(JE.t('toast_jumped_to', { percent: percentage }));
    };

    // Frame Step (YouTube-style , / .). FPS cached per (itemId + media source) so series
    // auto-play swaps don't cross-pollute. Transient failures fall back to 24 without caching.
    const FRAME_STEP_FALLBACK_FPS = 24;
    const _fpsCache = new Map();
    const _fpsInflight = new Map();
    let _frameOverlay = null;
    let _frameOverlayHideTimer = null;
    let _frameOverlayFadeTimer = null;
    const _fallbackFpsWarned = new Set();

    function getCurrentVideoItemId() {
        try {
            const hash = window.location.hash || '';
            const q = hash.indexOf('?');
            if (q === -1) return null;
            return new URLSearchParams(hash.substring(q + 1)).get('id');
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: frame-step item id parse failed', err);
            return null;
        }
    }

    function pickFps(stream) {
        if (!stream) return null;
        const candidates = [stream.ReferenceFrameRate, stream.RealFrameRate, stream.AverageFrameRate];
        for (const c of candidates) {
            const n = parseFloat(c);
            if (Number.isFinite(n) && n >= 1 && n < 1000) return n;
        }
        return null;
    }

    function getActiveMediaSourceId(video) {
        try {
            const src = video?.currentSrc || video?.src || '';
            const q = src.indexOf('?');
            if (q === -1) return null;
            return new URLSearchParams(src.substring(q + 1)).get('MediaSourceId') || null;
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: frame-step MediaSourceId parse failed', err);
            return null;
        }
    }

    async function fetchFpsForItem(itemId, activeMediaSourceId) {
        if (!itemId || !window.ApiClient) return null;
        try {
            const userId = window.ApiClient.getCurrentUserId();
            const item = await window.ApiClient.getItem(userId, itemId);
            const sources = Array.isArray(item?.MediaSources) ? item.MediaSources : [];
            const ordered = activeMediaSourceId
                ? [...sources.filter(s => s.Id === activeMediaSourceId), ...sources.filter(s => s.Id !== activeMediaSourceId)]
                : sources;
            for (const source of ordered) {
                const vs = source.MediaStreams?.find(s => s.Type === 'Video');
                const fps = pickFps(vs);
                if (fps) return fps;
            }
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: frame-step fps lookup failed', err);
        }
        return null;
    }

    function getFpsCacheKey(itemId, video) {
        if (!itemId) return null;
        const msId = getActiveMediaSourceId(video);
        if (msId) return `${itemId}|ms:${msId}`;
        const src = (video?.currentSrc || video?.src || '').split('?')[0];
        return `${itemId}|src:${src}`;
    }

    async function resolveFps(video) {
        const itemId = getCurrentVideoItemId();
        const cacheKey = getFpsCacheKey(itemId, video);
        if (cacheKey && _fpsCache.has(cacheKey)) return _fpsCache.get(cacheKey);
        // Inflight keyed by itemId so presses before/after currentSrc populates share one fetch.
        if (itemId && _fpsInflight.has(itemId)) return _fpsInflight.get(itemId);

        const activeMediaSourceId = getActiveMediaSourceId(video);
        const promise = (async () => {
            const fetched = itemId ? await fetchFpsForItem(itemId, activeMediaSourceId) : null;
            const isReal = Number.isFinite(fetched) && fetched >= 1;
            const fps = isReal ? fetched : FRAME_STEP_FALLBACK_FPS;
            // Build write key from the source we fetched for, not getVideo() which may have swapped.
            const finalKey = itemId
                ? (activeMediaSourceId
                    ? `${itemId}|ms:${activeMediaSourceId}`
                    : `${itemId}|src:${(video?.currentSrc || video?.src || '').split('?')[0]}`)
                : null;
            if (finalKey && isReal) _fpsCache.set(finalKey, fps);
            if (!isReal && itemId && !_fallbackFpsWarned.has(itemId)) {
                try {
                    JE.toast(tWithFallback(
                        'toast_frame_step_fps_fallback',
                        'ℹ Frame step using fallback {fps} fps (actual rate unknown)',
                        { fps: FRAME_STEP_FALLBACK_FPS }
                    ));
                    _fallbackFpsWarned.add(itemId);
                } catch (err) {
                    console.warn('🪼 Jellyfin Enhanced: frame-step fallback toast failed', err);
                }
            }
            return fps;
        })();
        if (itemId) _fpsInflight.set(itemId, promise);
        try { return await promise; }
        finally { if (itemId) _fpsInflight.delete(itemId); }
    }

    // JE.t returns the raw key on miss; tWithFallback substitutes an inline English default
    // until upstream en.json catches up. Mirrors elsewhere/reviews.js.
    const _tFallbackWarned = new Set();
    function tWithFallback(key, fallback, params) {
        let result;
        try {
            result = JE.t(key, params);
        } catch (err) {
            console.warn(`🪼 Jellyfin Enhanced: JE.t('${key}') threw, using fallback:`, err);
            result = null;
        }
        if (!result || result === key) {
            if (!_tFallbackWarned.has(key)) {
                _tFallbackWarned.add(key);
                console.warn(`🪼 Jellyfin Enhanced: missing translation key '${key}', using inline fallback`);
            }
            let out = fallback;
            if (params) {
                for (const [k, v] of Object.entries(params)) {
                    out = out.split(`{${k}}`).join(String(v));
                }
            }
            return out;
        }
        return result;
    }

    function showFrameOverlay(text) {
        if (!_frameOverlay) {
            _frameOverlay = document.createElement('div');
            _frameOverlay.setAttribute('data-je-frame-overlay', 'true');
            _frameOverlay.style.cssText = `
                position: fixed; bottom: 18%; left: 50%; transform: translateX(-50%);
                background: rgba(0,0,0,0.78); color: #fff; padding: 6px 14px; border-radius: 6px;
                font-size: 0.95em; font-weight: 600; z-index: 999999;
                pointer-events: none; font-family: system-ui;
                opacity: 0; transition: opacity 0.15s ease-out; display: none;
                white-space: nowrap;
            `;
            document.body.appendChild(_frameOverlay);
        }
        _frameOverlay.textContent = text;
        _frameOverlay.style.display = 'block';
        requestAnimationFrame(() => {
            if (_frameOverlay) _frameOverlay.style.opacity = '1';
        });

        if (_frameOverlayHideTimer) { clearTimeout(_frameOverlayHideTimer); _frameOverlayHideTimer = null; }
        if (_frameOverlayFadeTimer) { clearTimeout(_frameOverlayFadeTimer); _frameOverlayFadeTimer = null; }
        _frameOverlayHideTimer = setTimeout(() => {
            _frameOverlayHideTimer = null;
            if (!_frameOverlay) return;
            _frameOverlay.style.opacity = '0';
            _frameOverlayFadeTimer = setTimeout(() => {
                _frameOverlayFadeTimer = null;
                if (_frameOverlay && _frameOverlay.style.opacity === '0') {
                    _frameOverlay.style.display = 'none';
                }
            }, 200);
        }, 900);
    }

    JE.frameStep = async (direction) => {
      try {
        const video = getVideo();
        if (!video) {
            JE.toast(JE.t('toast_no_video_found'));
            return;
        }
        if (!video.paused) {
            try {
                const r = video.pause();
                // pause() returns a Promise on Chromecast/MSE/PiP; swallow rejection.
                if (r && typeof r.catch === 'function') {
                    r.catch(err => console.warn('🪼 Jellyfin Enhanced: video.pause() rejected', err));
                }
            } catch (err) {
                console.warn('🪼 Jellyfin Enhanced: video.pause() threw', err);
            }
        }

        const fps = await resolveFps(video);
        const frameDuration = 1 / fps;
        const delta = direction === 'forward' ? frameDuration : -frameDuration;
        const upper = Number.isFinite(video.duration) ? video.duration : Infinity;
        const newTime = Math.max(0, Math.min(upper, video.currentTime + delta));
        video.currentTime = newTime;

        const arrow = direction === 'forward' ? '▶' : '◀';
        const frameNum = Math.max(0, Math.round(newTime * fps));
        const fpsLabel = Number.isInteger(fps) ? String(fps) : fps.toFixed(3).replace(/\.?0+$/, '');
        const text = tWithFallback(
            'toast_frame_step',
            '{arrow} Frame {frame}  ·  {fps} fps',
            { arrow, frame: frameNum, fps: fpsLabel }
        );
        showFrameOverlay(text);
      } catch (err) {
        console.warn('🪼 Jellyfin Enhanced: frameStep failed', err);
      }
    };

    // --- Jump Back  ---
    // Track the last "stable" playback position via timeupdate (fires ~4x/sec
    // while playing). When a seek starts we snapshot that stable value — not
    // video.currentTime inside the seeking event
    // A guard flag prevents the jump-back action itself from overwriting the saved position.
    let _lastStablePosition = null;   // updated continuously during normal playback
    let _lastPositionBeforeSeek = null; // snapshotted at seek start
    let _jumpingBack = false;

    /**
     * Attaches timeupdate + seeking listeners to the given video element to track
     * the last known position before each seek. Safe to call multiple times — the
     * listeners are stored on the element and only attached once.
     * @param {HTMLVideoElement} video
     */
    JE.attachSeekTracker = (video) => {
        if (!video || video._jeSeekTrackerAttached) return;

        // Keep a rolling record of where we actually are during normal playback
        video.addEventListener('timeupdate', () => {
            if (_jumpingBack) return;
            if (!video.seeking && Number.isFinite(video.currentTime) && video.currentTime > 0) {
                _lastStablePosition = video.currentTime;
            }
        });

        video.addEventListener('seeking', () => {
            if (_jumpingBack) return;
            if (_lastStablePosition !== null) {
                _lastPositionBeforeSeek = _lastStablePosition;
            }
        });

        video._jeSeekTrackerAttached = true;
    };

    /**
     * Jumps back to the position captured just before the last seek.
     */
    JE.jumpToLastPosition = () => {
        const video = getVideo();
        if (!video) {
            JE.toast(JE.t('toast_no_video_found'));
            return;
        }
        if (_lastPositionBeforeSeek === null) {
            JE.toast(tWithFallback('toast_no_last_position', '{{icon:rewind}} No previous position saved'));
            return;
        }
        const targetTime = _lastPositionBeforeSeek;
        _lastPositionBeforeSeek = null; // consume it so repeated presses don't loop
        _jumpingBack = true;
        _lastStablePosition = null;    // reset so it re-accumulates after the jump
        video.currentTime = targetTime;
        setTimeout(() => { _jumpingBack = false; }, 500);

        const mins = Math.floor(targetTime / 60);
        const secs = Math.floor(targetTime % 60).toString().padStart(2, '0');
        JE.toast(tWithFallback('toast_jumped_back', '{{icon:rewind}} Jumped back to {time}', { time: `${mins}:${secs}` }));
    };

    // ── Segment-data skip (primary), skip-button click (fallback) ───────────
    //
    // The server's native Media Segments API (GET /MediaSegments/{itemId},
    // available on both 10.11 and 12) gives the exact intro/outro boundaries,
    // so the shortcut can seek straight past the segment the position is inside
    // — no button, no DOM. The visible skip-button click remains the fallback
    // for items without segment data and for third-party skip-button plugins.

    /** Ticks per second in Jellyfin's timeline (1 tick = 100 ns). */
    const TICKS_PER_SECOND = 10000000;

    /** Per-item media segment cache: itemId → {segments:[], at:number}. */
    const segmentCache = new Map();
    const SEGMENT_CACHE_MS = 10 * 60 * 1000;

    /**
     * Derives the transcode clock offset (ticks) from the media source URL —
     * non-HLS progressive transcodes without CopyTimestamps restart the element
     * clock at the transcode's StartTimeTicks, so raw currentTime would desync
     * every boundary comparison. HLS (.m3u8 / blob:) and Static/CopyTimestamps
     * sources keep an absolute clock (offset 0).
     * @param {string} src
     * @returns {number}
     */
    function transcodeOffsetTicks(src) {
        try {
            const q = (src || '').indexOf('?');
            if (q === -1) return 0;
            if (src.substring(0, q).toLowerCase().endsWith('.m3u8')) return 0;
            let startTimeTicks = 0;
            for (const [name, value] of new URLSearchParams(src.substring(q + 1))) {
                const lower = name.toLowerCase();
                if ((lower === 'static' || lower === 'copytimestamps') && String(value).toLowerCase() === 'true') {
                    return 0; // absolute element clock
                }
                if (lower === 'starttimeticks') {
                    const n = parseInt(value, 10);
                    if (Number.isFinite(n) && n > 0) startTimeTicks = n;
                }
            }
            return startTimeTicks;
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: transcode offset parse failed', err);
            return 0;
        }
    }

    /**
     * Fetches (and caches) the item's media segments.
     * @param {string} itemId
     * @returns {Promise<Array<object>>}
     */
    async function fetchMediaSegments(itemId) {
        const cached = segmentCache.get(itemId);
        if (cached && (performance.now() - cached.at) < SEGMENT_CACHE_MS) return cached.segments;
        try {
            const ac = window.ApiClient;
            if (!ac) return [];
            const res = await ac.ajax({
                type: 'GET',
                url: ac.getUrl(`/MediaSegments/${encodeURIComponent(itemId)}`),
                dataType: 'json'
            });
            const segments = Array.isArray(res && res.Items) ? res.Items : [];
            segmentCache.set(itemId, { segments, at: performance.now() });
            return segments;
        } catch (err) {
            // Transient failure: no caching, the next press retries.
            console.warn('🪼 Jellyfin Enhanced: media segments fetch failed', err);
            return [];
        }
    }

    /**
     * Clicks the visible native/third-party skip button, if any.
     * @returns {boolean} True when a button was clicked.
     */
    function clickSkipButton() {
        const skipButton = document.querySelector('button.skip-button.emby-button:not(.skip-button-hidden):not(.hide)');
        if (!skipButton) return false;
        const buttonText = skipButton.textContent || '';
        skipButton.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        skipButton.click();
        if (buttonText.includes('Skip Intro')) {
            JE.toast(JE.t('toast_skipped_intro'));
        } else if (buttonText.includes('Skip Outro')) {
            JE.toast(JE.t('toast_skipped_outro'));
        } else {
            JE.toast('⏭️ Skipped');
        }
        return true;
    }

    /**
     * Skips the current intro/outro. Primary path is data-driven: when the
     * position is inside a known media segment, seek past its exact end — no
     * button, no DOM. Falls back to the visible skip button otherwise.
     */
    JE.skipIntroOutro = () => {
        const video = getVideo();
        const itemId = getCurrentVideoItemId()
            || parseItemIdFromVideosSrc((video && (video.currentSrc || video.src)) || '');
        if (!video || !itemId) {
            if (!clickSkipButton()) JE.toast(JE.t('toast_no_skip_button'));
            return;
        }
        const pressVideo = video;
        const pressSrc = video.currentSrc || video.src || '';
        fetchMediaSegments(itemId).then(segments => {
            // The fetch is async: bail to the button if the surface moved.
            const v = getVideo();
            if (v !== pressVideo || ((v && (v.currentSrc || v.src)) || '') !== pressSrc) {
                if (!clickSkipButton()) JE.toast(JE.t('toast_no_skip_button'));
                return;
            }
            const offset = transcodeOffsetTicks(pressSrc);
            const nowTicks = pressVideo.currentTime * TICKS_PER_SECOND + offset;
            const seg = segments.find(s => s
                && typeof s.StartTicks === 'number' && typeof s.EndTicks === 'number'
                && s.StartTicks <= nowTicks && s.EndTicks > nowTicks);
            if (seg) {
                const endSeconds = (seg.EndTicks - offset) / TICKS_PER_SECOND;
                const duration = Number.isFinite(pressVideo.duration) && pressVideo.duration > 0
                    ? pressVideo.duration : Infinity;
                const target = Math.min(endSeconds, duration);
                if (target > pressVideo.currentTime) {
                    pressVideo.currentTime = target;
                    if (seg.Type === 'Intro') {
                        JE.toast(JE.t('toast_skipped_intro'));
                    } else if (seg.Type === 'Outro') {
                        JE.toast(JE.t('toast_skipped_outro'));
                    } else {
                        JE.toast('⏭️ Skipped');
                    }
                    return;
                }
            }
            if (!clickSkipButton()) JE.toast(JE.t('toast_no_skip_button'));
        }).catch(err => {
            console.warn('🪼 Jellyfin Enhanced: segment skip failed', err);
            if (!clickSkipButton()) JE.toast(JE.t('toast_no_skip_button'));
        });
    };

    // ── Native OSD track menus ───────────────────────────────────────────────
    //
    // Cycling subtitle/audio tracks drives Jellyfin's own action sheet. Doing that
    // safely needs four things the previous implementation got wrong:
    //
    //  * Wait for the sheet, don't guess. It was read 200ms after clicking the OSD
    //    button, with nothing verifying it had opened. The sheet is built inside a
    //    dynamic import() of components/actionSheet, so the delay was a bet on how
    //    fast that resolves. (In practice elements/emby-select statically imports
    //    actionSheet, so the chunk is usually already loaded — which is why this
    //    rarely misfires and is hard to reproduce — but a cold deep-link into
    //    /video, or a slow device, can still lose the race.)
    //
    //  * Scope every query to one sheet. dialogHelper only hides a dismissed sheet
    //    after a 100ms exit animation and removes it later still, so a document-wide
    //    '.actionSheetContent .listItem' query can read a stale sheet, or two at once.
    //
    //  * Close sheets the way dialogHelper expects. document.body.click() is a no-op
    //    here: the close listener is bound to .dialogContainer (a CHILD of body, so a
    //    body-dispatched event never reaches it), it requires e.target to BE that
    //    container, and it also requires a preceding mousedown — HTMLElement.click()
    //    dispatches only a click.
    //
    //  * Never compare against English UI strings. Sheet titles are localized
    //    ('Untertitel', 'Sous-titres', 字幕). The OSD button's own title attribute
    //    resolves the *same* translation key, so it is a locale-proof reference. The
    //    'Secondary Subtitles' row is localized too, which is why rows are now
    //    identified by their numeric data-id (the stream index) instead of by text —
    //    otherwise a localized UI can land the cycle on the secondary-subtitle row
    //    and open that submenu instead of changing the track.

    /** In-flight menu open, so repeated presses cannot stack sheets. @type {Promise|null} */
    let pendingMenuOpen = null;

    // dialogHelper keeps a dismissed sheet in the DOM — and visually rendered — for the length
    // of its exit animation, so isRendered() alone cannot tell a live sheet from a dying one.
    // Clicking a track row closes the sheet, so a quick second press could otherwise reuse the
    // closing sheet: read its stale check marks, click a settled dialog to no effect, and toast
    // a track that was never applied. dialogHelper announces the close by dispatching a
    // non-bubbling 'closing' event on the dialog the moment closing starts; non-bubbling events
    // still run the capture phase, so a document-level capture listener sees it.
    // Timestamped rather than a plain set: if the exit animationend never fires (backgrounded
    // tab, interrupted animation) the sheet stays rendered, and a permanent mark would exempt
    // it from closeActionSheet's leftover cleanup forever. After the grace window — far longer
    // than any exit animation — a still-rendered sheet is treated as a stuck leftover again.
    const sheetClosingAt = new WeakMap();
    const SHEET_CLOSING_GRACE_MS = 1000;
    document.addEventListener('closing', (e) => {
        const t = e.target;
        if (t instanceof Element && t.classList.contains('actionSheet')) {
            sheetClosingAt.set(t, performance.now());
        }
    }, true);

    /** @param {Element} sheet */
    function isClosing(sheet) {
        const at = sheetClosingAt.get(sheet);
        return at !== undefined && (performance.now() - at) < SHEET_CLOSING_GRACE_MS;
    }

    // Jellyfin applies a track selection only when the sheet's close animation finishes
    // (actionSheet resolves on the dialog 'close' event, not on the row click), so for a
    // beat after a cycle the player still reports the OLD track and a freshly opened sheet
    // still check-marks it. Remembering what was just clicked lets the next press continue
    // the cycle from there instead of re-selecting the same track. The window is short —
    // a few times the exit animation, just long enough for the selection to land — because
    // past that the check mark is authoritative again and an out-of-band change (a mouse
    // click in the native menu, the SubtitleMenu shortcut) would make the memory stale.
    const lastCycled = { subtitle: null, audio: null };

    /** @param {'subtitle'|'audio'} kind @returns {string|null} data-id or null */
    function recentlyCycledId(kind) {
        const rec = lastCycled[kind];
        return rec
            && (performance.now() - rec.at) < 500
            && rec.item === getCurrentVideoItemId() // stream indices repeat across items
            ? rec.id : null;
    }

    /**
     * Clicks an element the way the video OSD expects. On Firefox/Edge the OSD installs a
     * document capture-phase guard that cancels any click whose target does not contain its
     * `clickedElement`, which a bare programmatic .click() after a keypress fails. Sending
     * pointerdown first makes the element the clickedElement. JE.skipIntroOutro above already
     * uses this pattern for the same reason.
     * @param {HTMLElement} el
     */
    function activate(el) {
        if (typeof PointerEvent === 'function') {
            el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        }
        el.click();
    }

    /**
     * The localized title of an OSD button — the same translation key the matching
     * action sheet renders as its title. Deliberately title-only: an aria-label
     * fallback sounds safer but is worse, because a label WORDED differently from
     * the sheet title would make the match never succeed (3s timeout, false "not
     * found" toast), while an empty string only degrades the guards gracefully.
     * @param {string} selector
     * @returns {string}
     */
    function osdButtonTitle(selector) {
        const btn = document.querySelector(selector);
        return ((btn && btn.getAttribute('title')) || '').trim();
    }

    /**
     * @param {Element|null} el
     * @returns {boolean} True when the element is actually rendered (not a dismissed sheet).
     */
    function isRendered(el) {
        if (!el) return false;
        const h = /** @type {HTMLElement} */ (el);
        // Not offsetParent: actionSheet sets position:fixed on the sheet, so offsetParent is
        // null unless .dialogContainer happens to carry `contain: strict`. Depending on that
        // CSS would silently disable both the reuse fast path and closing if it ever changed.
        return !!(h.offsetWidth || h.offsetHeight || h.getClientRects().length);
    }

    /**
     * Finds a rendered action sheet whose title matches `title`.
     * @param {string} title
     * @returns {Element|null} The sheet's .dialogContainer, or null.
     */
    function findOpenSheetByTitle(title) {
        if (!title) return null;
        // Permanent exclusion here, unlike closeActionSheet's timed one: a sheet that ever
        // began closing has stale check marks and must never be REUSED, even if its exit
        // animation stalls past the grace window — it just becomes cleanable again.
        const sheet = Array.from(document.querySelectorAll('.actionSheet')).find(s =>
            isRendered(s) && !sheetClosingAt.has(s) &&
            Array.from(s.querySelectorAll('.actionSheetTitle'))
                .some(t => (t.textContent || '').trim() === title)
        );
        return sheet ? (sheet.closest('.dialogContainer') || sheet) : null;
    }

    /**
     * Closes the open native action sheet by replaying the outside tap dialogHelper
     * listens for: mousedown then click, dispatched ON the dialog container so both
     * `e.target === dialogContainer` and `e.target == clickedElement` hold.
     * @param {Element} [target] - A specific .dialogContainer to close; defaults to the
     *   first rendered sheet that is not already closing.
     * @returns {boolean} True when a close was attempted.
     */
    function closeActionSheet(target) {
        let container = target || null;
        if (!container) {
            const sheet = Array.from(document.querySelectorAll('.actionSheet'))
                .find(s => isRendered(s) && !isClosing(s));
            container = sheet && sheet.closest('.dialogContainer');
        }
        if (!container) return false;
        // pointerdown FIRST. On Firefox/Edge the video OSD installs a document capture-phase
        // click guard that cancels any click whose target does not contain its `clickedElement`
        // (video/index.js onClickCapture). That variable is refreshed by keydown and by
        // pointerdown — not by mousedown — so a bare mousedown+click is still swallowed and the
        // sheet never closes. Dispatching pointerdown on the container makes it the
        // clickedElement, after which dialogHelper's own mousedown+click guards both pass.
        if (typeof PointerEvent === 'function') {
            container.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
        }
        ['mousedown', 'click'].forEach(type => {
            container.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        });
        return true;
    }

    /**
     * Clicks an OSD button and resolves with the dialog container of the sheet it opened —
     * waiting for the sheet to exist rather than assuming a delay.
     * @param {string} buttonSelector
     * @returns {Promise<Element|null>} The new sheet's container, or null if none appeared.
     */
    function openOsdMenu(buttonSelector, expectedTitle) {
        const before = new Set(document.querySelectorAll('.dialogContainer'));
        const btn = /** @type {HTMLElement|null} */ (document.querySelector(buttonSelector));
        if (!btn) return Promise.resolve(null);
        activate(btn);
        // Accept only a container that did not exist before the click — a dismissed sheet would
        // otherwise satisfy the selector immediately. Match on .actionSheetContent rather than a
        // row: actionSheet sets innerHTML before dialogHelper appends the container, so content
        // is never half-rendered, and a genuinely EMPTY menu (a video with no audio streams)
        // must resolve immediately instead of stalling until the timeout. Also require the title
        // to be the menu we asked for, so a sheet opened concurrently elsewhere is not adopted.
        return JE.core.dom.waitForElement('.dialogContainer', {
            timeout: 3000,
            quiet: true,
            predicate: (el) => {
                if (before.has(el) || !el.querySelector('.actionSheetContent')) return false;
                if (!expectedTitle) return true;
                const t = el.querySelector('.actionSheetTitle');
                return !!t && (t.textContent || '').trim() === expectedTitle;
            }
        });
    }

    /**
     * Advances to the next track within one already-resolved sheet.
     * @param {Element} container - The sheet's .dialogContainer; all queries are scoped to it.
     * @param {string} emptyToastKey
     * @param {string} toastVar - 'subtitle' | 'audio'
     */
    function cycleWithinSheet(container, emptyToastKey, toastVar) {
        // Real track rows carry a numeric data-id (the stream index; -1 is "Off").
        // Non-track rows such as "Secondary Subtitles" do not, so this needs no text match.
        const options = Array.from(container.querySelectorAll('.actionSheetMenuItem'))
            .filter(item => /^-?\d+$/.test(item.getAttribute('data-id') || ''));

        // 'Off' (data-id -1) alone is not a cycle: a subtitle menu for an item with no
        // subtitle streams still renders the Off row, and toggling Off→Off with a toast
        // naming "Off" would masquerade as a track change.
        if (!options.some(item => item.getAttribute('data-id') !== '-1')) {
            JE.toast(JE.t(emptyToastKey));
            closeActionSheet(container);
            return;
        }

        // Prefer the row we cycled to moments ago over the check mark: the selection is
        // applied on sheet close, so right after a cycle the check mark still sits on the
        // previous track and trusting it would re-select the same track.
        const recentId = recentlyCycledId(/** @type {'subtitle'|'audio'} */ (toastVar));
        let currentIndex = recentId !== null
            ? options.findIndex(option => option.getAttribute('data-id') === recentId)
            : -1;
        if (currentIndex === -1) {
            currentIndex = options.findIndex(option => {
                const check = option.querySelector('.listItemIcon.check');
                return check && getComputedStyle(check).visibility !== 'hidden';
            });
        }

        const next = options[(currentIndex + 1) % options.length];
        if (!next) return;
        activate(/** @type {HTMLElement} */ (next));
        // Recorded after activate(): if the click throws or is swallowed, an unset record
        // (falling back to the check mark) is the safe direction, not a poisoned one.
        lastCycled[toastVar] = {
            id: next.getAttribute('data-id'),
            at: performance.now(),
            item: getCurrentVideoItemId()
        };
        const labelEl = next.querySelector('.listItemBodyText');
        JE.toast(JE.t('toast_' + toastVar, { [toastVar]: ((labelEl && labelEl.textContent) || '').trim() }));
    }

    /**
     * Opens (or reuses) an OSD track menu and advances to the next track.
     * @param {string} buttonSelector - The OSD button that opens the menu.
     * @param {string} emptyToastKey - Toast key for "this menu has no tracks".
     * @param {string} toastVar - 'subtitle' | 'audio'
     */
    function cycleTrackMenu(buttonSelector, emptyToastKey, toastVar) {
        const title = osdButtonTitle(buttonSelector);
        const alreadyOpen = findOpenSheetByTitle(title);
        if (alreadyOpen) {
            cycleWithinSheet(alreadyOpen, emptyToastKey, toastVar);
            return;
        }
        // One open at a time. Without this, a second press before the sheet exists snapshots a
        // stale `before` set, clicks the button again and leaves an orphan sheet on screen.
        if (pendingMenuOpen) return;
        // A different sheet may be open (audio while cycling subtitles, or a leftover).
        // Close it first so we never stack two sheets and then read rows from both.
        closeActionSheet();
        pendingMenuOpen = openOsdMenu(buttonSelector, title)
            .then(container => {
                if (!container) {
                    if (!document.querySelector(buttonSelector)) {
                        console.warn(`🪼 Jellyfin Enhanced: ${buttonSelector} is not present; cannot cycle tracks.`);
                    } else {
                        console.warn(`🪼 Jellyfin Enhanced: ${buttonSelector} menu did not open in time.`);
                    }
                    // Only touch the UI if we are still on the player — the await window is up to
                    // 3s, in which the user may have navigated away and opened an unrelated sheet.
                    if (typeof JE.isVideoPage !== 'function' || JE.isVideoPage()) {
                        JE.toast(JE.t(emptyToastKey));
                    }
                    return;
                }
                cycleWithinSheet(container, emptyToastKey, toastVar);
            })
            .catch(err => {
                console.warn('🪼 Jellyfin Enhanced: track cycling failed:', err);
            })
            .finally(() => { pendingMenuOpen = null; });
    }

    // ── DOM-free track cycling (primary path) ────────────────────────────────
    //
    // Tracks are switched through the server's remote-control channel:
    // POST /Sessions/{id}/Command with SetAudioStreamIndex / SetSubtitleStreamIndex.
    // The web client routes both commands straight into its internal
    // playbackManager (serverNotifications.js in both jellyfin-web 10.11 and 12,
    // with Index -1 meaning "subtitles off"), so no action sheet ever opens.
    // The hardened OSD menu cycle above remains the fallback for an unmoved
    // surface when the session cannot be resolved or the command fails.
    //
    // Staleness model (each guard exists because a concrete interleaving breaks
    // without it — see the matching comments):
    //  * Presses are serialized per kind, so a rapid second press observes the
    //    first press's commanded index instead of re-computing the same "next"
    //    from a lagging PlayState.
    //  * A short-lived commanded-index memory (scoped to session+item+
    //    MediaSourceId) bridges the window where PlayState still reports the
    //    old track. It is retired the moment PlayState acknowledges the value,
    //    voided by a MediaSource switch (stream indices renumber), and cleared
    //    before EVERY menu fallback (the menu is authoritative and its
    //    selection is not observed here).
    //  * Item ownership is captured AT the keypress: parsed from the media
    //    source URL (or the video-page URL), or — for id-less hls.js blob
    //    sources — via a press-time session probe accepted only if the
    //    element/source surface is unchanged when it resolves. A press whose
    //    id-less surface later moves is swallowed outright: a lagging server
    //    can keep reporting the old item after an episode change, so no probe
    //    can PROVE the moved surface still plays the press item.
    //  * Before the POST the current surface is re-checked against the press
    //    item (a probe response itself can be stale), and a failed POST falls
    //    back to the menu only with positively proven, unmoved ownership.

    /** Milliseconds a commanded index may bridge PlayState lag. */
    const TRACK_COMMAND_MEMORY_MS = 10000;

    /**
     * Per-kind commanded-index memory. Audio and subtitle records are
     * independent so an intervening command of the other kind cannot evict one.
     * @type {{subtitle: ?{sessionId:string,itemId:string,mediaSourceId:?string,index:number,at:number}, audio: ?{...}}}
     */
    const lastCommanded = { subtitle: null, audio: null };

    /** @param {'subtitle'|'audio'} kind */
    function forgetCommanded(kind) { lastCommanded[kind] = null; }

    /**
     * The remembered commanded index, when still authoritative.
     * @param {'subtitle'|'audio'} kind
     * @param {string} sessionId
     * @param {string} itemId
     * @param {?string} mediaSourceId
     * @param {number|null|undefined} reported - PlayState's current index.
     * @returns {?number}
     */
    function rememberedIndex(kind, sessionId, itemId, mediaSourceId, reported) {
        const rec = lastCommanded[kind];
        if (!rec || rec.sessionId !== sessionId || rec.itemId !== itemId) return null;
        // A media-source switch renumbers streams; the optimistic index is void.
        if (rec.mediaSourceId !== (mediaSourceId || null)) {
            forgetCommanded(kind);
            return null;
        }
        // PlayState acknowledged the command — it is authoritative again, and a
        // later EXTERNAL selection must win instead of being overridden.
        if (typeof reported === 'number' && reported === rec.index) {
            forgetCommanded(kind);
            return null;
        }
        if ((performance.now() - rec.at) > TRACK_COMMAND_MEMORY_MS) return null;
        return rec.index;
    }

    /**
     * Normalizes a Jellyfin item id for comparison (dashless, lowercase).
     * @param {string|null|undefined} value
     * @returns {?string}
     */
    function normalizeItemId(value) {
        const v = (value || '').replace(/-/g, '').toLowerCase();
        return v || null;
    }

    /**
     * Parses the playing item id from a /Videos/{id}/... media source URL.
     * @param {string} src
     * @returns {?string}
     */
    function parseItemIdFromVideosSrc(src) {
        const m = (src || '').match(/\/[Vv]ideos\/([0-9a-fA-F-]{32,36})\b/);
        return m ? m[1] : null;
    }

    /**
     * Item identity visible right now: source-URL parse with the video-page URL
     * as fallback. Null for id-less sources (hls.js blob) — an indeterminate
     * value never *asserts* staleness.
     * @returns {?string}
     */
    function currentItemHint() {
        const video = getVideo();
        const src = (video && (video.currentSrc || video.src)) || '';
        return normalizeItemId(parseItemIdFromVideosSrc(src) || getCurrentVideoItemId());
    }

    /**
     * Resolves the caller's OWN playing session — the remote-control target the
     * DOM-free paths command. Fail-open: an ambiguous DeviceId match (multiple
     * playing sessions) returns null rather than risking the wrong session.
     * @returns {Promise<?object>} The session DTO, or null.
     */
    async function probeOwnSession() {
        try {
            const ac = window.ApiClient;
            if (!ac) return null;
            const userId = ac.getCurrentUserId();
            const deviceId = typeof ac.deviceId === 'function' ? ac.deviceId() : '';
            if (!userId || !deviceId) return null;
            const sessions = await ac.ajax({
                type: 'GET',
                url: ac.getUrl(`/Sessions?ControllableByUserId=${encodeURIComponent(userId)}`),
                dataType: 'json'
            });
            if (!Array.isArray(sessions)) return null;
            const matches = sessions.filter(s => s && s.DeviceId === deviceId && s.NowPlayingItem && s.NowPlayingItem.Id);
            return matches.length === 1 ? matches[0] : null;
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: own-session probe failed', err);
            return null;
        }
    }

    /**
     * Per-kind press serialization: each press queues on a settled promise chain
     * so a rapid second press observes the first press's outcome. No timers.
     * @type {{subtitle: Promise, audio: Promise}}
     */
    const trackCycleChains = { subtitle: Promise.resolve(), audio: Promise.resolve() };

    /**
     * DOM-free cycle attempt. Returns true when the press was fully handled
     * (including toasts and deliberate swallows); false → the caller runs the
     * menu fallback.
     * @param {'subtitle'|'audio'} kind
     * @param {{item: Promise<?string>, idless: boolean, video: ?HTMLVideoElement, src: string}} press
     * @returns {Promise<boolean>}
     */
    async function cycleTrackViaApi(kind, press) {
        const ac = window.ApiClient;
        if (!ac) return false;
        const onVideoPage = () => (typeof JE.isVideoPage !== 'function' || JE.isVideoPage());
        const surfaceUnchanged = () => {
            const v = getVideo();
            return v === press.video && ((v && (v.currentSrc || v.src)) || '') === press.src;
        };
        if (!onVideoPage()) return true;

        const [pressItemId, session] = await Promise.all([press.item, probeOwnSession()]);
        if (!onVideoPage()) return true; // navigated away — swallow
        // Unproven ownership never commands. The menu fallback is acceptable
        // only while the press surface has not moved; unproven + moved may
        // belong to the previous item — swallow.
        if (!pressItemId) {
            return press.idless && !surfaceUnchanged();
        }
        const sessionId = session && session.Id;
        const itemId = session && session.NowPlayingItem && session.NowPlayingItem.Id;
        if (!sessionId || !itemId) return false;
        // The press belongs to the item playing at the keypress; a disagreeing
        // session (next episode landed while queued/probing) swallows.
        const sessionItem = normalizeItemId(itemId);
        if (sessionItem && pressItemId !== sessionItem) return true;
        // Id-less press whose surface moved: no probe can prove it — swallow.
        if (press.idless && !surfaceUnchanged()) return true;

        const type = kind === 'subtitle' ? 'Subtitle' : 'Audio';
        const streams = ((session.NowPlayingItem && session.NowPlayingItem.MediaStreams) || [])
            .filter(s => s && s.Type === type && typeof s.Index === 'number');
        if (streams.length === 0) {
            JE.toast(JE.t(kind === 'subtitle' ? 'toast_no_subtitles_found' : 'toast_no_audio_tracks_found'));
            return true;
        }
        // Subtitles cycle through Off (-1); audio has no Off state.
        const candidates = kind === 'subtitle'
            ? [-1].concat(streams.map(s => s.Index))
            : streams.map(s => s.Index);
        if (candidates.length < 2) {
            // A single audio track: nothing to switch. Named toast, no command.
            JE.toast(JE.t('toast_audio', { audio: trackDisplayName(streams[0]) }));
            return true;
        }

        const playState = session.PlayState || {};
        const reported = kind === 'subtitle' ? playState.SubtitleStreamIndex : playState.AudioStreamIndex;
        const mediaSourceId = playState.MediaSourceId || null;
        const current = rememberedIndex(kind, sessionId, itemId, mediaSourceId, reported);
        const effective = current !== null ? current : (typeof reported === 'number' ? reported : -1);
        const position = candidates.indexOf(effective);
        const next = candidates[(position + 1) % candidates.length];
        const commandName = kind === 'subtitle' ? 'SetSubtitleStreamIndex' : 'SetAudioStreamIndex';

        // Pre-POST recheck: the probe response itself can be stale (produced for
        // the press item while the next episode landed in flight). A derivable
        // current item disagreeing with the press item swallows.
        const itemNow = currentItemHint();
        if (itemNow && itemNow !== pressItemId) return true;
        try {
            await ac.ajax({
                type: 'POST',
                url: ac.getUrl(`/Sessions/${encodeURIComponent(sessionId)}/Command`),
                contentType: 'application/json',
                data: JSON.stringify({ Name: commandName, Arguments: { Index: String(next) } })
            });
        } catch (err) {
            // The menu fallback after a FAILED command requires positively
            // proven, unmoved ownership — a rejected command cannot explain a
            // surface change, and a moved item must not get the menu.
            if (!onVideoPage()) return true;
            let proven = currentItemHint();
            if (!proven) {
                const fresh = await probeOwnSession();
                proven = normalizeItemId(fresh && fresh.NowPlayingItem && fresh.NowPlayingItem.Id);
            }
            if (proven !== pressItemId) return true;
            console.warn(`🪼 Jellyfin Enhanced: ${commandName} failed, falling back to the menu cycle`, err);
            return false;
        }
        // POST-side check deliberately ignores the surface: a successful switch
        // itself restarts the stream. The memory is session+item keyed, so a
        // write after a genuine item change self-invalidates on the next press.
        if (!onVideoPage()) return true;
        lastCommanded[kind] = { sessionId, itemId, mediaSourceId, index: next, at: performance.now() };
        const nextStream = next === -1 ? null : streams.find(s => s.Index === next);
        JE.toast(JE.t(kind === 'subtitle' ? 'toast_subtitle' : 'toast_audio',
            { [kind]: trackDisplayName(nextStream) }));
        return true;
    }

    /**
     * Human-readable track name for toasts.
     * @param {?object} stream
     * @returns {string}
     */
    function trackDisplayName(stream) {
        if (!stream) return tWithFallback('track_off', 'Off');
        const name = (stream.DisplayTitle || stream.Title || stream.Language || stream.Codec || '').trim();
        return name || ('#' + stream.Index);
    }

    /**
     * Queues one track-cycle press: API first, hardened OSD menu as fallback.
     * @param {'subtitle'|'audio'} kind
     */
    function cycleTrack(kind) {
        if (!window.ApiClient) {
            // No API client — menu path directly; the memory never outlives a fallback.
            forgetCommanded(kind);
            runMenuFallback(kind);
            return;
        }
        // Press-time ownership, captured BEFORE queueing. Id-bearing sources
        // resolve synchronously; id-less sources fire a press-time probe that
        // only counts if the surface is still the keypress surface on resolve.
        const hint = currentItemHint();
        const pressVideo = hint ? null : getVideo();
        const press = {
            idless: !hint,
            video: pressVideo,
            src: (pressVideo && (pressVideo.currentSrc || pressVideo.src)) || '',
            item: null
        };
        press.item = hint
            ? Promise.resolve(hint)
            : probeOwnSession()
                .then(s => {
                    const id = normalizeItemId(s && s.NowPlayingItem && s.NowPlayingItem.Id);
                    const v = getVideo();
                    const same = v === press.video && ((v && (v.currentSrc || v.src)) || '') === press.src;
                    return same ? id : null;
                })
                .catch(() => null);
        trackCycleChains[kind] = trackCycleChains[kind].then(async () => {
            let handled = false;
            try {
                handled = await cycleTrackViaApi(kind, press);
            } catch (err) {
                console.warn('🪼 Jellyfin Enhanced: API track cycle failed', err);
            }
            if (handled) return;
            if (typeof JE.isVideoPage === 'function' && !JE.isVideoPage()) return;
            // Every menu fallback invalidates the optimistic memory: the menu is
            // authoritative and its selection is not observed here.
            forgetCommanded(kind);
            runMenuFallback(kind);
        });
    }

    /** @param {'subtitle'|'audio'} kind */
    function runMenuFallback(kind) {
        if (kind === 'subtitle') {
            cycleTrackMenu('button.btnSubtitles', 'toast_no_subtitles_found', 'subtitle');
        } else {
            cycleTrackMenu('button.btnAudio', 'toast_no_audio_tracks_found', 'audio');
        }
    }

    /**
     * Cycles through available subtitle tracks (server command; OSD menu fallback).
     */
    JE.cycleSubtitleTrack = () => cycleTrack('subtitle');

    /**
     * Cycles through available audio tracks (server command; OSD menu fallback).
     */
    JE.cycleAudioTrack = () => cycleTrack('audio');

    // ── DOM-free aspect ratio cycling ────────────────────────────────────────
    //
    // Mirrors jellyfin-web's htmlVideoPlayer.setAspectRatio (identical in 10.11
    // and 12): the mode lives in the native appSettings localStorage key
    // `aspectRatio` (unprefixed — AppSettings.set only prefixes user-scoped
    // keys), and applying it is `object-fit` on the media element ('auto'
    // removes the property; the PGS graphical-subtitle canvas maps 'auto' to
    // 'contain'). Writing the same key keeps the native settings menu's check
    // marks — and the next native apply — consistent. No panel ever opens.

    /** The three native aspect modes, in native menu order. */
    const ASPECT_MODES = ['auto', 'cover', 'fill'];

    /**
     * Localized label for an aspect mode (used in the toast).
     * @param {string} mode
     * @returns {string}
     */
    function aspectModeLabel(mode) {
        if (mode === 'cover') return tWithFallback('aspect_ratio_cover', 'Cover');
        if (mode === 'fill') return tWithFallback('aspect_ratio_fill', 'Fill');
        return tWithFallback('aspect_ratio_auto', 'Auto');
    }

    /**
     * Cycles video aspect ratio (Auto → Cover → Fill) without opening the OSD
     * settings menu.
     */
    JE.cycleAspect = () => {
        const video = getVideo();
        if (!video) {
            JE.toast(JE.t('toast_no_video_found'));
            return;
        }
        let stored = null;
        try {
            stored = window.localStorage.getItem('aspectRatio');
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: aspect ratio setting read failed', err);
        }
        const current = ASPECT_MODES.indexOf(stored) !== -1 ? stored : 'auto';
        const next = ASPECT_MODES[(ASPECT_MODES.indexOf(current) + 1) % ASPECT_MODES.length];
        try {
            window.localStorage.setItem('aspectRatio', next);
        } catch (err) {
            // Apply-only degradation: the mode still changes for this stream,
            // the native menu just won't reflect it.
            console.warn('🪼 Jellyfin Enhanced: aspect ratio setting write failed', err);
        }
        if (next === 'auto') {
            video.style.removeProperty('object-fit');
        } else {
            video.style.objectFit = next;
        }
        // libpgs renders graphical subtitles into a sibling canvas whose fit the
        // native player keeps in step with the video ('auto' → 'contain').
        const parent = video.parentElement;
        if (parent) {
            parent.querySelectorAll(':scope > canvas').forEach(canvas => {
                canvas.style.objectFit = next === 'auto' ? 'contain' : next;
            });
        }
        JE.toast(JE.t('toast_aspect_ratio', { ratio: aspectModeLabel(next) }));
    };

    // ── Playback info overlay (DOM-free ShowPlaybackInfo) ────────────────────
    //
    // A plugin-rendered stats overlay toggled by the ShowPlaybackInfo shortcut,
    // replacing the settings-menu → stats panel click chain. Data comes from the
    // media element itself plus the own-session probe (PlayState /
    // TranscodingInfo / MediaStreams). Every value lands via textContent — no
    // HTML sink. One 1s refresh timer exists only while the overlay is open,
    // and it self-destructs when the player goes away.

    const PLAYBACK_INFO_REFRESH_MS = 1000;
    let playbackInfoOverlay = null;
    let playbackInfoTimer = null;

    /** Tears the overlay and its refresh timer down. */
    function destroyPlaybackInfo() {
        if (playbackInfoTimer) { clearTimeout(playbackInfoTimer); playbackInfoTimer = null; }
        if (playbackInfoOverlay) { playbackInfoOverlay.remove(); playbackInfoOverlay = null; }
    }

    /**
     * Builds the label/value rows for the overlay.
     * @param {HTMLVideoElement} video
     * @param {?object} session
     * @returns {Array<[string,string]>}
     */
    function playbackInfoRows(video, session) {
        const rows = [];
        if (video.videoWidth && video.videoHeight) {
            rows.push([tWithFallback('pi_resolution', 'Resolution'), `${video.videoWidth}×${video.videoHeight}`]);
        }
        if (Math.abs(video.playbackRate - 1) > 0.001) {
            rows.push([tWithFallback('pi_speed', 'Speed'), `${video.playbackRate}x`]);
        }
        if (typeof video.getVideoPlaybackQuality === 'function') {
            const q = video.getVideoPlaybackQuality();
            rows.push([tWithFallback('pi_dropped_frames', 'Dropped frames'), `${q.droppedVideoFrames} / ${q.totalVideoFrames}`]);
        }
        try {
            const buffered = video.buffered;
            if (buffered && buffered.length > 0) {
                const ahead = buffered.end(buffered.length - 1) - video.currentTime;
                if (Number.isFinite(ahead)) rows.push([tWithFallback('pi_buffer', 'Buffered'), `${Math.max(0, ahead).toFixed(1)} s`]);
            }
        } catch (err) { /* buffered ranges can throw during teardown */ }
        if (session) {
            const playState = session.PlayState || {};
            const transcoding = session.TranscodingInfo || null;
            if (playState.PlayMethod) {
                let method = playState.PlayMethod;
                if (transcoding && typeof transcoding.CompletionPercentage === 'number') {
                    method += ` (${transcoding.CompletionPercentage.toFixed(0)}%)`;
                }
                rows.push([tWithFallback('pi_play_method', 'Play method'), method]);
            }
            if (transcoding) {
                const codecs = [transcoding.Container, transcoding.VideoCodec, transcoding.AudioCodec]
                    .filter(Boolean).join(' · ');
                if (codecs) rows.push([tWithFallback('pi_transcoding', 'Transcoding'), codecs]);
                if (typeof transcoding.Bitrate === 'number' && transcoding.Bitrate > 0) {
                    rows.push([tWithFallback('pi_bitrate', 'Bitrate'), `${(transcoding.Bitrate / 1000000).toFixed(1)} Mbps`]);
                }
                const reasons = Array.isArray(transcoding.TranscodeReasons)
                    ? transcoding.TranscodeReasons.join(', ') : (transcoding.TranscodeReasons || '');
                if (reasons) rows.push([tWithFallback('pi_transcode_reason', 'Reason'), reasons]);
            } else if (session.NowPlayingItem && session.NowPlayingItem.Container) {
                rows.push([tWithFallback('pi_container', 'Container'), session.NowPlayingItem.Container]);
            }
            const streams = (session.NowPlayingItem && session.NowPlayingItem.MediaStreams) || [];
            if (typeof playState.AudioStreamIndex === 'number') {
                const audio = streams.find(s => s && s.Type === 'Audio' && s.Index === playState.AudioStreamIndex);
                if (audio) rows.push([tWithFallback('pi_audio', 'Audio'), trackDisplayName(audio)]);
            }
            if (typeof playState.SubtitleStreamIndex === 'number' && playState.SubtitleStreamIndex >= 0) {
                const sub = streams.find(s => s && s.Type === 'Subtitle' && s.Index === playState.SubtitleStreamIndex);
                if (sub) rows.push([tWithFallback('pi_subtitle', 'Subtitles'), trackDisplayName(sub)]);
            }
        }
        return rows;
    }

    /**
     * Renders the overlay off-DOM and swaps content in one replaceChildren —
     * no incremental mutation of the live overlay, all values via textContent.
     * @param {HTMLVideoElement} video
     * @param {?object} session
     */
    function renderPlaybackInfo(video, session) {
        if (!playbackInfoOverlay) return;
        const fragment = document.createDocumentFragment();
        const title = document.createElement('div');
        title.style.cssText = 'font-weight:600;margin-bottom:6px;';
        title.textContent = tWithFallback('playback_info_title', 'Playback Info');
        fragment.appendChild(title);
        for (const [label, value] of playbackInfoRows(video, session)) {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;justify-content:space-between;gap:16px;';
            const labelEl = document.createElement('span');
            labelEl.style.opacity = '0.75';
            labelEl.textContent = label;
            const valueEl = document.createElement('span');
            valueEl.textContent = value;
            row.append(labelEl, valueEl);
            fragment.appendChild(row);
        }
        playbackInfoOverlay.replaceChildren(fragment);
    }

    /**
     * One refresh tick: sample the video + session coherently, render, reschedule.
     * `overlay` identity-guards the loop so a toggle-off/on while a probe is in
     * flight cannot fork a second timer chain.
     * @param {HTMLElement} overlay
     */
    async function refreshPlaybackInfo(overlay) {
        if (playbackInfoOverlay !== overlay) return;
        if (typeof JE.isVideoPage === 'function' && !JE.isVideoPage()) { destroyPlaybackInfo(); return; }
        const video = getVideo();
        if (!video) { destroyPlaybackInfo(); return; }
        const sampledSrc = video.currentSrc || video.src || '';
        const sampledPageItem = getCurrentVideoItemId();
        const session = await probeOwnSession();
        if (playbackInfoOverlay !== overlay) return;
        const current = getVideo();
        if (!current) { destroyPlaybackInfo(); return; }
        // The session sample and the video must describe the same playback: a
        // next-episode swap (new element/source, a changed route id behind a
        // stable blob source, or a derivable item disagreeing with the probed
        // session) discards this mixed sample; the next tick renders fresh.
        const currentSrc = current.currentSrc || current.src || '';
        const derivable = normalizeItemId(parseItemIdFromVideosSrc(currentSrc) || getCurrentVideoItemId());
        const sessionItem = normalizeItemId(session && session.NowPlayingItem && session.NowPlayingItem.Id);
        const coherent = current === video
            && currentSrc === sampledSrc
            && getCurrentVideoItemId() === sampledPageItem
            && !(derivable && sessionItem && derivable !== sessionItem);
        if (coherent) renderPlaybackInfo(current, session);
        playbackInfoTimer = setTimeout(() => {
            playbackInfoTimer = null;
            refreshPlaybackInfo(overlay);
        }, PLAYBACK_INFO_REFRESH_MS);
    }

    /**
     * Toggles the playback-info overlay (no native menus involved).
     */
    JE.togglePlaybackInfo = () => {
        if (playbackInfoOverlay) { destroyPlaybackInfo(); return; }
        const video = getVideo();
        if (!video) {
            JE.toast(JE.t('toast_no_video_found'));
            return;
        }
        const overlay = document.createElement('div');
        overlay.setAttribute('data-je-playback-info', 'true');
        overlay.style.cssText = `
            position: fixed; top: 12px; left: 12px; z-index: 999999;
            background: rgba(0,0,0,0.72); color: #fff; padding: 10px 14px;
            border-radius: 8px; font-size: 0.85em; font-family: system-ui;
            pointer-events: none; min-width: 240px; max-width: 42vw;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        `;
        playbackInfoOverlay = overlay;
        renderPlaybackInfo(video, null); // immediate local stats; session data lands on the first refresh
        document.body.appendChild(overlay);
        refreshPlaybackInfo(overlay);
    };

    let skipButtonObserver = null;

    /**
     * Initializes a MutationObserver to watch for the skip button's appearance.
     */
    JE.initializeAutoSkipObserver = () => {
        if (skipButtonObserver) {
            return; // Observer is already running
        }
        skipButtonObserver = new MutationObserver((mutationsList) => {
            for (const mutation of mutationsList) {
                if (mutation.type === 'childList' || mutation.type === 'attributes') {
                    const skipButton = document.querySelector('button.skip-button.emby-button:not(.skip-button-hidden):not(.hide)');
                    if (skipButton && !JE.state.skipToastShown) {
                        const buttonText = skipButton.textContent || '';
                        if (JE.currentSettings.autoSkipIntro && buttonText.includes('Skip Intro')) {
                            skipButton.click();
                            JE.toast(JE.t('toast_auto_skipped_intro'));
                            JE.state.skipToastShown = true;
                        } else if (JE.currentSettings.autoSkipOutro && buttonText.includes('Skip Outro')) {
                            skipButton.click();
                            JE.toast(JE.t('toast_auto_skipped_outro'));
                            JE.state.skipToastShown = true;
                        }
                    } else if (!skipButton) {
                        JE.state.skipToastShown = false; // Reset when the button is gone
                    }
                }
            }
        });

        skipButtonObserver.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style']
        });
    };

    /**
     * Disconnects the MutationObserver for the skip button.
     */
    JE.stopAutoSkip = () => {
        if (skipButtonObserver) {
            skipButtonObserver.disconnect();
            skipButtonObserver = null;
        }
    };

    // --- Long Press Speed Control ---
    const LONG_PRESS_CONFIG = {
        DURATION: 500,
        SPEED_NORMAL: 1.0,
        SPEED_FAST: 2.0,
        MOVEMENT_THRESHOLD: 10, // pixels - ignore small movements
    };

    let pressTimer = null;
    let isLongPress = false;
    let videoElement = null;
    let originalSpeed = LONG_PRESS_CONFIG.SPEED_NORMAL;
    let speedOverlay = null;
    let pressStartX = null;
    let pressStartY = null;

    function createSpeedOverlay() {
        if (speedOverlay) return;
        speedOverlay = document.createElement('div');
        speedOverlay.setAttribute('data-speed-overlay', 'true');
        speedOverlay.style.cssText = `
            position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
            background: rgba(0,0,0,0.9); color: white; padding: 8px 16px; border-radius: 6px;
            font-size: 1.2em; font-weight: bold; z-index: 999999;
            pointer-events: none; font-family: system-ui;
            opacity: 0; transition: opacity 0.2s ease-out; display: none;
        `;
        document.body.appendChild(speedOverlay);
    }

    function showOverlay(speed) {
        createSpeedOverlay();
        speedOverlay.innerHTML = `${speed}x${speed > 1 ? ' ' + JE.icon(JE.IconName.FAST_FORWARD) : ' ' + JE.icon(JE.IconName.PLAY)}`;
        speedOverlay.style.display = 'block';
        setTimeout(() => speedOverlay.style.opacity = '1', 10);
    }

    function hideOverlay() {
        if (speedOverlay) {
            speedOverlay.style.opacity = '0';
            setTimeout(() => speedOverlay.style.display = 'none', 200);
        }
    }

    JE.handleLongPressDown = (e) => {
        if (!JE.currentSettings.longPress2xEnabled || (e.button !== undefined && e.button !== 0) || pressTimer) {
            return;
        }
        videoElement = getVideo();
        if (!videoElement) return;

        // Store initial press position
        pressStartX = e.clientX || e.touches?.[0]?.clientX;
        pressStartY = e.clientY || e.touches?.[0]?.clientY;

        originalSpeed = videoElement.playbackRate || LONG_PRESS_CONFIG.SPEED_NORMAL;
        isLongPress = false;

        pressTimer = setTimeout(() => {
            if (JE.state.pauseScreenClickTimer) {
                clearTimeout(JE.state.pauseScreenClickTimer);
                JE.state.pauseScreenClickTimer = null;
            }
            isLongPress = true;
            // Make sure video is playing when we activate speed boost
            if (videoElement.paused) {
                videoElement.play().catch(err => console.warn("🪼 Play blocked:", err));
            }
            videoElement.playbackRate = LONG_PRESS_CONFIG.SPEED_FAST;
            showOverlay(LONG_PRESS_CONFIG.SPEED_FAST);
            if (navigator.vibrate) navigator.vibrate(50);
        }, LONG_PRESS_CONFIG.DURATION);
    };

    JE.handleLongPressUp = (e) => {
        if (!pressTimer) return;
        clearTimeout(pressTimer);
        pressTimer = null;

        if (isLongPress) {
            const video = getVideo();
            if (video) {
                video.playbackRate = originalSpeed;
            }
            hideOverlay();
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
        }
        isLongPress = false;
        pressStartX = null;
        pressStartY = null;
    };

    JE.handleLongPressCancel = () => {
        if (pressTimer) {
            clearTimeout(pressTimer);
            pressTimer = null;
            if (isLongPress) {
                const video = getVideo();
                if (video) {
                    video.playbackRate = originalSpeed;
                }
                hideOverlay();
            }
            isLongPress = false;
        }
        pressStartX = null;
        pressStartY = null;
    };

    // Handle mouse movement during press to detect drag/scrub
    JE.handleLongPressMove = (e) => {
        if (!pressTimer || isLongPress || !pressStartX || !pressStartY) return;

        const currentX = e.clientX || e.touches?.[0]?.clientX;
        const currentY = e.clientY || e.touches?.[0]?.clientY;

        if (currentX === null || currentY === null) return;

        const distanceMoved = Math.sqrt(
            Math.pow(currentX - pressStartX, 2) + Math.pow(currentY - pressStartY, 2)
        );

        // If user moves more than threshold, cancel the long press (likely a drag attempt)
        if (distanceMoved > LONG_PRESS_CONFIG.MOVEMENT_THRESHOLD) {
            clearTimeout(pressTimer);
            pressTimer = null;
            pressStartX = null;
            pressStartY = null;
        }
    };

    // Block click events that would pause/play when doing a long press
    JE.handleLongPressClick = (e) => {
        // If long press is just completed OR user is still holding (timer active),
        // prevent the click from pausing the video
        if (isLongPress || pressTimer) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            return;
        }
    };

})(window.JellyfinEnhanced);