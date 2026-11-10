import type { MediaSegment } from './wire';
import type { AutoSkipDependencies, ResolverOptions } from './host';
/** 1 tick = 100 ns; 10,000,000 ticks per second. */
    export const TICKS_PER_SECOND = 10000000;

    /** Mirror the native client: never skip a segment shorter than this (avoids churn). */
    export const MIN_SEGMENT_TICKS = TICKS_PER_SECOND; // 1 second

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
    function segmentKey(seg: MediaSegment) {
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
    export function parseTranscodeOffsetTicksFromSrc(src: string) {
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
    export function createSessionItemResolver(opts: ResolverOptions) {
        let probedSrc: string | null = null;
        let probedId: string | null = null;
        let probeAttempts = 0;
        let inFlight = false;
        return (video: HTMLVideoElement) => {
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
    export function createAutoSkipEngine(deps: AutoSkipDependencies) {
        let video: HTMLVideoElement | null = null;
        let listener: (() => void) | null = null;
        let itemId: string | null = null;
        /** @type {MediaSegment[]} */
        let segments: MediaSegment[] = [];
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
        let lastKey: string | null = null;
        let lastIgnored = false;

        /**
         * Fetch and sort this item's segments. Stale responses (item changed
         * while in flight) are dropped via the fetch token.
         * @param {string} id
         */
        async function loadSegments(id: string) {
            const token = ++fetchToken;
            let result: MediaSegment[] = [];
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
            attach(v: HTMLVideoElement) {
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

