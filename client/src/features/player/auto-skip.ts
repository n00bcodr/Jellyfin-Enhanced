import { playerHost } from './host';
import { decodeItem, decodeItems, decodeSessions, decodeSegments, type Item, type Stream, type PlayingSession, type MediaSegment } from './wire';
import type { AutoSkipDependencies, ResolverOptions, SkipEngine } from './host';
import { createPlayerLifetime } from './lifetime';
const { JE, ApiClient, ctx } = playerHost();
const lifetime = createPlayerLifetime(JE, 'auto-skip');
import { TICKS_PER_SECOND, MIN_SEGMENT_TICKS, parseTranscodeOffsetTicksFromSrc, createSessionItemResolver, createAutoSkipEngine } from './auto-skip-engine';
    // ── DOM glue ─────────────────────────────────────────────────────────────

    /**
     * Whether the user's settings enable auto-skip for a given segment type. Only
     * the two types the settings model exposes (Intro/Outro) are covered — we do
     * NOT invent settings for Recap/Preview/Commercial, which the native per-type
     * actions own.
     * @param {string|undefined} type
     * @returns {boolean}
     */
    function segmentTypeEnabled(type: string | undefined) {
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
    function segmentTypeEnabledFor(epoch: number, type: string | undefined) {
        if (JE.session && !JE.session.isCurrent(epoch)) return false;
        return segmentTypeEnabled(type);
    }

    /**
     * Localized toast after an auto-skip. Constant keys, no interpolation.
     * @param {MediaSegment} seg
     */
    function autoSkipToast(seg: MediaSegment) {
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
    function parseItemIdFromVideosSrc(src: string) {
        const m = src.match(/\/[Vv]ideos\/([0-9a-fA-F-]{32,36})\b/);
        return m?.[1]?.replace(/-/g, '').toLowerCase() ?? null;
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
    async function probeNowPlayingItemId(userId: string | null) {
        try {
            const api = JE.core?.api;
            const ac = ApiClient;
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
            const matches = decodeSessions(sessions).filter(x => x?.DeviceId === deviceId && x?.NowPlayingItem?.Id);
            return matches.length === 1 ? (matches[0]?.NowPlayingItem?.Id || null) : null;
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
    async function fetchMediaSegments(itemId: string) {
        const api = JE.core?.api;
        if (!api || typeof api.jf !== 'function') return [];
        const res = await api.jf(`/MediaSegments/${encodeURIComponent(itemId)}`, { skipCache: true });
        return decodeSegments(res);
    }

    /**
     * The signed-in user id, from the session core when it is available.
     * @returns {string|null}
     */
    function currentUserId() {
        try {
            return JE.session?.getUserId?.() || ApiClient?.getCurrentUserId?.() || null;
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: auto-skip user lookup failed', err);
            return null;
        }
    }

    let _engine: SkipEngine | null = null;
    let _engineEpoch: number | null = null;

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
                    fallbackId: () => ctx.own.player?.getCurrentVideoItemId?.() || null,
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
        const video = ctx.own.player?.getVideo?.();
        if (!video) return; // catch it on a later tick once the element mounts
        autoSkipEngine().attach(video);
    };

    /** Tears the auto-skip engine down (video-page leave). */
    JE.stopAutoSkip = () => {
        _engine?.detach();
    };

    // Exposed for unit tests and for other modules that need the primitives.
    ctx.own.autoSkip = {
        TICKS_PER_SECOND,
        MIN_SEGMENT_TICKS,
        createAutoSkipEngine,
        createSessionItemResolver,
        parseTranscodeOffsetTicksFromSrc,
        parseItemIdFromVideosSrc,
        segmentTypeEnabled
    };

lifetime.onReset(() => { _engine?.detach(); _engine = null; _engineEpoch = null; });
