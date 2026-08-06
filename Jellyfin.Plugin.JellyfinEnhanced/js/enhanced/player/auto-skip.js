/**
 * @file Auto-Skip — data-driven segment auto-skip that honours Jellyfin's native
 * Media Segment boundaries exactly.
 *
 * The previous implementation auto-CLICKED the native "skip" button by matching
 * its English text ("Skip Intro"/"Skip Outro"). That inherited three bugs:
 *   • dead on localized clients (the button text is translated);
 *   • only worked when the native client was configured to PROMPT — a user whose
 *     media-segment action is "None" never gets a button, so never got a skip;
 *   • no seek-back guard — the click re-fired every time the native client
 *     re-prompted after a manual seek, insta-re-skipping the user.
 * It also never read the segment's StartTicks/EndTicks, so it could not honour
 * the real boundary; it landed wherever the native button happened to seek.
 *
 * This engine reads the native Media Segments (GET /MediaSegments/{itemId},
 * available on Jellyfin 10.10+ and 12) and seeks to the segment's exact EndTicks
 * itself, driven by the media element's `timeupdate` event (no polling; the
 * per-tick scan is bounded by the handful of segments an item has). It mirrors
 * the native MediaSegmentManager's guards (backward-entry `lastTime > StartTicks`
 * plus a last-ignored latch — deliberately NO permanent once-per-item set, so a
 * legitimate replay skips again exactly like native), meaning a user who seeks
 * back into a segment after an auto-skip is never insta-re-skipped — including
 * when the native client's own Skip action performed the original skip.
 *
 * Precedence vs native: the plugin seeks to the SAME EndTicks the native client
 * would, so any overlap with the native Skip action is idempotent (one visible
 * jump to the identical position). The plugin's value-add is the in-player quick
 * toggle (Auto Skip Intro / Auto Skip Outro) plus a localized toast; the native
 * per-type actions still own Recap/Preview/Commercial, which these toggles
 * deliberately do not cover.
 *
 * One deliberate divergence from the native manager: a segment with no EndTicks is
 * ignored rather than acted on. Native reads "no end" as "advance to the next
 * track", which is far too invasive for a plugin toggle to do on the user's
 * behalf; the native per-type action still handles that case if the user wants it.
 *
 * The seek is a plain `video.currentTime` assignment, because playbackManager is
 * not reachable from a plugin. That is equivalent to the native seek for direct
 * play/stream and HLS — the whole item is seekable. On a *progressive* transcode
 * the element can only seek within what the server has already produced, so a
 * skip there may stall or no-op where the native client would relaunch the stream
 * at the target; the toggles are best paired with direct play or HLS transcoding
 * (jellyfin-web's default in browsers). For the same reason the seek is local
 * only, so SyncPlay groups will not follow it.
 */
(function(JE) {
    'use strict';

    /** 1 tick = 100 ns; 10,000,000 ticks per second. */
    const TICKS_PER_SECOND = 10000000;

    /** Mirror the native client: never skip a segment shorter than this (avoids churn). */
    const MIN_SEGMENT_TICKS = TICKS_PER_SECOND; // 1 second

    /**
     * How many times a single media source may be probed for its item id before
     * we give up on it. Ticks drive the retries (~4/s), so this is roughly a
     * second of grace for the playback-start report to land.
     */
    const MAX_PROBE_ATTEMPTS = 5;

    /**
     * @typedef {Object} MediaSegment
     * @property {string} [Id]
     * @property {string} [Type] - 'Intro' | 'Outro' | 'Recap' | 'Preview' | 'Commercial' | 'Unknown'
     * @property {number} [StartTicks]
     * @property {number} [EndTicks]
     */

    /**
     * Stable identity for a segment, used by the acted/ignored state machine.
     * Falls back to the boundary triple when the provider omits an Id.
     * @param {MediaSegment} seg
     * @returns {string}
     */
    function segmentKey(seg) {
        return seg.Id || `${seg.Type || 'Unknown'}:${seg.StartTicks != null ? seg.StartTicks : ''}:${seg.EndTicks != null ? seg.EndTicks : ''}`;
    }

    /**
     * Derive the transcode position offset (ticks) from a media element source URL
     * — the plugin-observable equivalent of native `streamInfo.transcodingOffsetTicks`
     * (jellyfin-web playbackmanager.js getCurrentTicks/createStreamInfo):
     *   - a non-HLS progressive transcode WITHOUT CopyTimestamps starts the stream
     *     at the transcode's start position and the element clock restarts at 0;
     *     the server-built TranscodingUrl carries that position as `StartTimeTicks=`
     *     (MediaBrowser.Model/Dlna/StreamInfo.ToUrl) → return it;
     *   - a CopyTimestamps=true progressive transcode keeps an absolute clock → 0;
     *   - Static=true direct play/stream has an absolute clock → 0;
     *   - HLS via hls.js exposes a `blob:` src with no query → 0, correct because the
     *     HLS playlist spans the full item (native sets transcodingOffsetTicks=0 for hls).
     * A mid-transcode seek restarts the stream with a NEW TranscodingUrl (new
     * StartTimeTicks) and currentSrc reflects it, so the offset stays in sync.
     * @param {string} src
     * @returns {number} Ticks to ADD to the element clock to get the absolute position.
     */
    function parseTranscodeOffsetTicksFromSrc(src) {
        try {
            const q = src.indexOf('?');
            if (q === -1) return 0;
            // HLS playlists (Safari's native HLS exposes the real .m3u8 URL as
            // currentSrc; hls.js/MSE yields blob: and never reaches here) carry an
            // ABSOLUTE timeline — their StartTimeTicks is a server seek hint, not a
            // clock offset. Treating it as one would shift every boundary.
            if (src.substring(0, q).toLowerCase().endsWith('.m3u8')) return 0;
            // Param casing varies across producers (server ToUrl vs client-built
            // urls), so compare case-insensitively like the native client does.
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
            console.warn('🪼 Jellyfin Enhanced: auto-skip offset parse failed', err);
            return 0;
        }
    }

    /**
     * Item-identity resolver with a server-session fallback for sources whose URL
     * carries no item id (hls.js MSE playback exposes a blob: URL). Order:
     * direct src parse → page fallback → one async now-playing probe per DISTINCT
     * source (single-flight, cached until the source changes, so there is no
     * polling — the probe fires only on a source change).
     *
     * Caveat: the probe reads the SERVER's idea of what this device is playing. On
     * next-episode auto-play the client reports playback start before ticks begin,
     * so the id is current; a network reorder could in principle cache the previous
     * episode's id for the life of that source. The forward-only seek guard bounds
     * the damage, and the id is re-derived as soon as the source changes again.
     * @param {{parseFromSrc: (src: string) => (string|null), fallbackId: () => (string|null), probeNowPlayingId: () => Promise<string|null>}} opts
     * @returns {(video: HTMLVideoElement) => (string|null)}
     */
    function createSessionItemResolver(opts) {
        let probedSrc = null;
        let probedId = null;
        let probeAttempts = 0;
        let inFlight = false;
        return (video) => {
            const src = video.currentSrc || '';
            const direct = src ? opts.parseFromSrc(src) : null;
            if (direct) return direct;
            const fromPage = opts.fallbackId();
            if (fromPage) return fromPage;
            if (src !== probedSrc) {
                probedSrc = src;
                probedId = null;
                probeAttempts = 0;
            }
            // An UNRESOLVED probe is retried on later ticks: the first tick of a
            // new source can beat the client's own playback-start report, and the
            // server would then have no NowPlayingItem to match. Caching that miss
            // for the life of the source would silently disable auto-skip for the
            // whole episode. Bounded so an item that genuinely cannot be resolved
            // (ambiguous device match) costs a handful of requests, not a poll.
            if (src && !probedId && !inFlight && probeAttempts < MAX_PROBE_ATTEMPTS) {
                probeAttempts++;
                inFlight = true;
                opts.probeNowPlayingId()
                    .then((id) => {
                        if (probedSrc === src) probedId = id;
                    })
                    .catch(() => undefined)
                    .finally(() => {
                        inFlight = false;
                    });
            }
            return src && src === probedSrc ? probedId : null;
        };
    }

    /**
     * Create an auto-skip engine. Stateful controller: `attach(video)` begins
     * driving off the element's `timeupdate`; `detach()` tears everything down.
     * Both are idempotent and safe to call repeatedly (events.js re-invokes
     * attach on every video-page tick).
     * @param {{shouldSkipType: (type: string|undefined) => boolean, fetchSegments: (itemId: string) => Promise<MediaSegment[]>, resolveItemId: (video: HTMLVideoElement) => (string|null), onSkipped: (seg: MediaSegment) => void, getPositionOffsetTicks: (video: HTMLVideoElement) => number}} deps
     */
    function createAutoSkipEngine(deps) {
        let video = null;
        let listener = null;
        let itemId = null;
        /** @type {MediaSegment[]} */
        let segments = [];
        let fetchToken = 0;
        // Previous evaluated ABSOLUTE position, in ticks — native's `lastTime`.
        // The backward-entry guard compares the PREVIOUS position against a
        // segment's start to tell "played forward into the segment" apart from
        // "seeked back into it".
        let lastTimeTicks = -1;
        // Native-parity state machine (mirrors MediaSegmentManager's
        // lastSegmentIndex + isLastSegmentIgnored, keyed by segment identity):
        //  - a segment IGNORED (backward entry / sub-second) stays inert while it
        //    remains the last-touched segment, so seeking back INTO a segment
        //    never insta-re-skips;
        //  - a LEGITIMATE REPLAY (seek to before StartTicks, then play forward
        //    through it) skips again, exactly like the native Skip action — there
        //    is deliberately NO permanent per-item once-set.
        let lastKey = null;
        let lastIgnored = false;

        /**
         * Fetch and sort this item's segments. Stale responses (item changed
         * while in flight) are dropped via the fetch token.
         * @param {string} id
         */
        async function loadSegments(id) {
            const token = ++fetchToken;
            let result = [];
            try {
                result = await deps.fetchSegments(id);
            } catch (err) {
                // A transient failure disables auto-skip only for this item view;
                // a later item change re-fetches. The failure is never cached.
                console.warn('🪼 Jellyfin Enhanced: media-segments fetch failed', err);
                result = [];
            }
            if (token !== fetchToken) return; // stale — item changed while in flight
            segments = (Array.isArray(result) ? result : [])
                .filter(s => s && s.StartTicks != null)
                .slice()
                .sort((a, b) => (a.StartTicks || 0) - (b.StartTicks || 0));
        }

        /**
         * Re-resolve the playing item and reset per-item state when it changes.
         */
        function reinitIfItemChanged() {
            if (!video) return;
            const id = deps.resolveItemId(video);
            if (id === itemId) return;
            if (!id) {
                // Source transition (empty/unparseable currentSrc, e.g. between
                // episodes): the OLD item's segments must not act on ticks from
                // the incoming one. Drop all per-item state until identity is
                // known — the next resolvable tick re-fetches, even for the same
                // item.
                itemId = null;
                segments = [];
                lastTimeTicks = -1;
                lastKey = null;
                lastIgnored = false;
                fetchToken++; // invalidate any in-flight fetch
                return;
            }
            // New item (next episode / new playback). Reset every per-item guard.
            itemId = id;
            segments = [];
            lastTimeTicks = -1;
            lastKey = null;
            lastIgnored = false;
            loadSegments(id);
        }

        /**
         * One evaluation pass: skip at most one segment for the current position.
         */
        function evaluate() {
            if (!video) return;
            const t = video.currentTime;
            if (!Number.isFinite(t)) return;
            // Absolute item position = element clock + transcode offset (native
            // getCurrentTicks parity). On a non-CopyTimestamps progressive
            // transcode the element clock restarts at the transcode start
            // position, so the raw currentTime would desync every comparison.
            const offsetTicks = deps.getPositionOffsetTicks(video);
            const timeTicks = t * TICKS_PER_SECOND + offsetTicks;

            if (!segments.length) return;

            for (const seg of segments) {
                // `== null` (not truthiness) so a segment starting at 0 ticks works.
                if (seg.StartTicks == null || seg.EndTicks == null) continue;
                const inSegment = seg.StartTicks <= timeTicks && seg.EndTicks > timeTicks;
                if (!inSegment) continue;
                if (!deps.shouldSkipType(seg.Type)) continue;

                const key = segmentKey(seg);
                // Native parity: an ignored segment stays inert while it is the
                // last-touched one; anything else (first touch, replay after a
                // successful skip, a different segment) is evaluated afresh.
                if (lastIgnored && lastKey === key) break;
                lastKey = key;

                // Backward-entry guard (native parity): the PREVIOUS position
                // being past the segment start means the user seeked back INTO it
                // (or the native Skip already jumped it) — ignore, never
                // insta-re-skip.
                if (lastTimeTicks > seg.StartTicks) {
                    lastIgnored = true;
                    break;
                }

                // Ignore sub-second segments (native parity — avoids churn).
                if (seg.EndTicks - seg.StartTicks < MIN_SEGMENT_TICKS) {
                    lastIgnored = true;
                    break;
                }

                lastIgnored = false;
                // Element-clock seek target for the ABSOLUTE EndTicks boundary.
                const endSeconds = (seg.EndTicks - offsetTicks) / TICKS_PER_SECOND;
                // duration can read 0/NaN before metadata loads — treat that as
                // unknown (Infinity) so we still seek to the exact end; only a
                // genuine finite duration clamps a segment that runs to the item
                // end.
                const duration = Number.isFinite(video.duration) && video.duration > 0
                    ? video.duration
                    : Infinity;
                const target = Math.min(endSeconds, duration);
                // Only ever seek forward, and only toast when we actually jumped.
                if (target > t) {
                    video.currentTime = target;
                    deps.onSkipped(seg);
                }
                break; // one skip per tick
            }
            // Native parity: `lastTime` advances only once segments exist — ticks
            // during a pending fetch must not make the backward-entry guard
            // misread ordinary forward playback as a seek-back when the fetch
            // lands mid-segment.
            lastTimeTicks = timeTicks;
        }

        function onTick() {
            reinitIfItemChanged();
            evaluate();
        }

        return {
            /**
             * Begin driving auto-skip off `v`'s timeupdate. Idempotent.
             * @param {HTMLVideoElement} v
             */
            attach(v) {
                if (v === video) {
                    reinitIfItemChanged(); // same element, possibly a new source (next episode)
                    return;
                }
                this.detach();
                video = v;
                listener = onTick;
                v.addEventListener('timeupdate', listener);
                reinitIfItemChanged(); // kick off the initial fetch
            },
            /** Stop and reset all state. Idempotent. */
            detach() {
                if (video && listener) video.removeEventListener('timeupdate', listener);
                video = null;
                listener = null;
                itemId = null;
                segments = [];
                lastTimeTicks = -1;
                lastKey = null;
                lastIgnored = false;
                fetchToken++; // invalidate any in-flight fetch
            },
            /** Inspection hooks for tests/debugging — not part of the public surface. */
            _internal: {
                evaluate,
                reinitIfItemChanged,
                get segments() { return segments; },
                get itemId() { return itemId; },
                get lastKey() { return lastKey; },
                get lastIgnored() { return lastIgnored; }
            }
        };
    }

    // ── DOM glue ─────────────────────────────────────────────────────────────

    /**
     * Whether the user's settings enable auto-skip for a given segment type. Only
     * the two types the settings model exposes (Intro/Outro) are covered — we do
     * NOT invent settings for Recap/Preview/Commercial, which the native per-type
     * actions own.
     * @param {string|undefined} type
     * @returns {boolean}
     */
    function segmentTypeEnabled(type) {
        if (type === 'Intro') return !!JE.currentSettings?.autoSkipIntro;
        if (type === 'Outro') return !!JE.currentSettings?.autoSkipOutro;
        return false;
    }

    /**
     * Type gate fenced to the identity the engine was built for.
     * `JE.currentSettings` is swapped wholesale on a user switch, so a tick that
     * lands between the switch and the engine rebuild would otherwise evaluate
     * the outgoing user's playback against the incoming user's toggles.
     * @param {number} epoch - Identity generation captured when the engine was built.
     * @param {string|undefined} type
     * @returns {boolean}
     */
    function segmentTypeEnabledFor(epoch, type) {
        if (JE.session && !JE.session.isCurrent(epoch)) return false;
        return segmentTypeEnabled(type);
    }

    /**
     * Localized toast after an auto-skip. Constant keys, no interpolation.
     * @param {MediaSegment} seg
     */
    function autoSkipToast(seg) {
        if (seg.Type === 'Intro') JE.toast(JE.t('toast_auto_skipped_intro'));
        else if (seg.Type === 'Outro') JE.toast(JE.t('toast_auto_skipped_outro'));
    }

    /**
     * Resolve the playing item id from the media element's source path
     * (/Videos/{itemId}/…). currentSrc changes on next-episode auto-play, giving
     * reliable item-change detection.
     * @param {string} src
     * @returns {string|null}
     */
    function parseItemIdFromVideosSrc(src) {
        const m = src.match(/\/[Vv]ideos\/([0-9a-fA-F-]{32,36})\b/);
        return m ? m[1].replace(/-/g, '').toLowerCase() : null;
    }

    /**
     * Now-playing probe for sources without an id in the URL (hls.js blob:).
     * /Sessions?ControllableByUserId works for non-admins and includes the
     * caller's own session; matched by DeviceId so casts and other tabs never
     * mislead us.
     * @param {string|null} userId - The user the engine was built for. Passed in
     *   rather than read live so a probe that started before a user switch can
     *   never resolve against the incoming user's sessions.
     * @returns {Promise<string|null>}
     */
    async function probeNowPlayingItemId(userId) {
        try {
            const api = JE.core?.api;
            const ac = window.ApiClient;
            if (!api || typeof api.jf !== 'function' || !ac) return null;
            const deviceId = typeof ac.deviceId === 'function' ? ac.deviceId() : '';
            if (!userId || !deviceId) return null;
            const sessions = await api.jf(
                `/Sessions?ControllableByUserId=${encodeURIComponent(userId)}`,
                { skipCache: true }
            );
            if (!Array.isArray(sessions)) return null;
            // Same-browser tabs share a deviceId (the server usually merges them
            // into one session). If more than one playing session still matches,
            // identity is ambiguous — fail closed, because no auto-skip beats a
            // skip on the wrong item.
            const matches = sessions.filter(x => x?.DeviceId === deviceId && x?.NowPlayingItem?.Id);
            return matches.length === 1 ? (matches[0].NowPlayingItem?.Id || null) : null;
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: auto-skip now-playing probe failed', err);
            return null;
        }
    }

    /**
     * Fetch the item's provider-filtered media segments via the native REST API
     * (Jellyfin 10.10+ / 12). No cacheKey is supplied, so every item view reads
     * fresh segments.
     * @param {string} itemId
     * @returns {Promise<MediaSegment[]>}
     */
    async function fetchMediaSegments(itemId) {
        const api = JE.core?.api;
        if (!api || typeof api.jf !== 'function') return [];
        const res = await api.jf(`/MediaSegments/${encodeURIComponent(itemId)}`, { skipCache: true });
        return Array.isArray(res?.Items) ? res.Items : [];
    }

    /**
     * The signed-in user id, from the session core when it is available.
     * @returns {string|null}
     */
    function currentUserId() {
        try {
            return JE.session?.getUserId?.() || window.ApiClient?.getCurrentUserId?.() || null;
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: auto-skip user lookup failed', err);
            return null;
        }
    }

    let _engine = null;
    let _engineEpoch = null;

    /**
     * The engine is rebuilt on every identity transition, so one account's
     * in-flight probe or cached segments can never act on another's playback.
     */
    function autoSkipEngine() {
        const epoch = JE.session ? JE.session.getEpoch() : 0;
        if (!_engine || _engineEpoch !== epoch) {
            _engine?.detach();
            _engineEpoch = epoch;
            const userId = currentUserId();
            _engine = createAutoSkipEngine({
                shouldSkipType: (type) => segmentTypeEnabledFor(epoch, type),
                fetchSegments: fetchMediaSegments,
                resolveItemId: createSessionItemResolver({
                    parseFromSrc: parseItemIdFromVideosSrc,
                    fallbackId: () => JE.internals?.player?.getCurrentVideoItemId?.() || null,
                    probeNowPlayingId: () => probeNowPlayingItemId(userId)
                }),
                onSkipped: autoSkipToast,
                getPositionOffsetTicks: (video) => parseTranscodeOffsetTicksFromSrc(video.currentSrc || '')
            });
        }
        return _engine;
    }

    // A user switch is a route change in the SPA, so tear the engine down with
    // the rest of the per-user state rather than waiting for a video-page leave.
    JE.session?.onUserChange('auto-skip', () => {
        _engine?.detach();
        _engine = null;
        _engineEpoch = null;
    });

    /**
     * Starts the auto-skip engine on the current video element. events.js
     * re-invokes this on every video-page tick (idempotent — attach no-ops on the
     * same element and only re-checks for an item change).
     */
    JE.initializeAutoSkipObserver = () => {
        // Signed out (or mid sign-in): every segment fetch would 401. Wait for a
        // later tick rather than attaching an engine that can only warn-spam.
        if (!currentUserId()) return;
        const video = JE.internals?.player?.getVideo?.();
        if (!video) return; // catch it on a later tick once the element mounts
        autoSkipEngine().attach(video);
    };

    /** Tears the auto-skip engine down (video-page leave). */
    JE.stopAutoSkip = () => {
        _engine?.detach();
    };

    // Exposed for unit tests and for other modules that need the primitives.
    JE.internals = JE.internals || {};
    JE.internals.autoSkip = {
        TICKS_PER_SECOND,
        MIN_SEGMENT_TICKS,
        createAutoSkipEngine,
        createSessionItemResolver,
        parseTranscodeOffsetTicksFromSrc,
        parseItemIdFromVideosSrc,
        segmentTypeEnabled
    };

})(window.JellyfinEnhanced);
