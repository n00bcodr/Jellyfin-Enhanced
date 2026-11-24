(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function sharedModule(id) {
    const namespace = window.JellyfinEnhanced?.core?.sharedModules?.[id];
    if (!namespace) throw new Error(`${id} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);
    return namespace;
  }
  function sharedExport(namespace, name) {
    return namespace[name];
  }

  // client/generated-shared/stub/client/src/features/player/host.ts
  var shared = /* @__PURE__ */ sharedModule("features/player/host");
  var export0 = /* @__PURE__ */ sharedExport(shared, "playerHost");

  // client/generated-shared/stub/client/src/features/player/wire.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/player/wire");
  var export02 = /* @__PURE__ */ sharedExport(shared2, "decodeItem");
  var export2 = /* @__PURE__ */ sharedExport(shared2, "decodeSegments");
  var export3 = /* @__PURE__ */ sharedExport(shared2, "decodeSessions");

  // client/generated-shared/stub/client/src/features/player/lifetime.ts
  var shared3 = /* @__PURE__ */ sharedModule("features/player/lifetime");
  var export03 = /* @__PURE__ */ sharedExport(shared3, "createPlayerLifetime");

  // client/src/features/player/auto-skip-engine.ts
  var TICKS_PER_SECOND = 1e7;
  var MIN_SEGMENT_TICKS = TICKS_PER_SECOND;
  var MAX_PROBE_ATTEMPTS = 5;
  function segmentKey(seg) {
    return seg.Id || `${seg.Type || "Unknown"}:${seg.StartTicks != null ? seg.StartTicks : ""}:${seg.EndTicks != null ? seg.EndTicks : ""}`;
  }
  function parseTranscodeOffsetTicksFromSrc(src) {
    try {
      const q = src.indexOf("?");
      if (q === -1) return 0;
      if (src.substring(0, q).toLowerCase().endsWith(".m3u8")) return 0;
      let startTimeTicks = 0;
      for (const [name, value] of new URLSearchParams(src.substring(q + 1))) {
        const lower = name.toLowerCase();
        if ((lower === "static" || lower === "copytimestamps") && String(value).toLowerCase() === "true") {
          return 0;
        }
        if (lower === "starttimeticks") {
          const n = parseInt(value, 10);
          if (Number.isFinite(n) && n > 0) startTimeTicks = n;
        }
      }
      return startTimeTicks;
    } catch (err) {
      console.warn("🪼 Jellyfin Enhanced: auto-skip offset parse failed", err);
      return 0;
    }
  }
  function createSessionItemResolver(opts) {
    let probedSrc = null;
    let probedId = null;
    let probeAttempts = 0;
    let inFlight = false;
    return (video) => {
      const src = video.currentSrc || "";
      const direct = src ? opts.parseFromSrc(src) : null;
      if (direct) return direct;
      const fromPage = opts.fallbackId();
      if (fromPage) return fromPage;
      if (src !== probedSrc) {
        probedSrc = src;
        probedId = null;
        probeAttempts = 0;
      }
      if (src && !probedId && !inFlight && probeAttempts < MAX_PROBE_ATTEMPTS) {
        probeAttempts++;
        inFlight = true;
        opts.probeNowPlayingId().then((id) => {
          if (probedSrc === src) probedId = id;
        }).catch(() => void 0).finally(() => {
          inFlight = false;
        });
      }
      return src && src === probedSrc ? probedId : null;
    };
  }
  function createAutoSkipEngine(deps) {
    let video = null;
    let listener = null;
    let itemId = null;
    let segments = [];
    let fetchToken = 0;
    let lastTimeTicks = -1;
    let lastKey = null;
    let lastIgnored = false;
    async function loadSegments(id) {
      const token = ++fetchToken;
      let result = [];
      try {
        result = await deps.fetchSegments(id);
      } catch (err) {
        console.warn("🪼 Jellyfin Enhanced: media-segments fetch failed", err);
        result = [];
      }
      if (token !== fetchToken) return;
      segments = (Array.isArray(result) ? result : []).filter((s) => s && s.StartTicks != null).slice().sort((a, b) => (a.StartTicks || 0) - (b.StartTicks || 0));
    }
    function reinitIfItemChanged() {
      if (!video) return;
      const id = deps.resolveItemId(video);
      if (id === itemId) return;
      if (!id) {
        itemId = null;
        segments = [];
        lastTimeTicks = -1;
        lastKey = null;
        lastIgnored = false;
        fetchToken++;
        return;
      }
      itemId = id;
      segments = [];
      lastTimeTicks = -1;
      lastKey = null;
      lastIgnored = false;
      loadSegments(id);
    }
    function evaluate() {
      if (!video) return;
      const t = video.currentTime;
      if (!Number.isFinite(t)) return;
      const offsetTicks = deps.getPositionOffsetTicks(video);
      const timeTicks = t * TICKS_PER_SECOND + offsetTicks;
      if (!segments.length) return;
      for (const seg of segments) {
        if (seg.StartTicks == null || seg.EndTicks == null) continue;
        const inSegment = seg.StartTicks <= timeTicks && seg.EndTicks > timeTicks;
        if (!inSegment) continue;
        if (!deps.shouldSkipType(seg.Type)) continue;
        const key = segmentKey(seg);
        if (lastIgnored && lastKey === key) break;
        lastKey = key;
        if (lastTimeTicks > seg.StartTicks) {
          lastIgnored = true;
          break;
        }
        if (seg.EndTicks - seg.StartTicks < MIN_SEGMENT_TICKS) {
          lastIgnored = true;
          break;
        }
        lastIgnored = false;
        const endSeconds = (seg.EndTicks - offsetTicks) / TICKS_PER_SECOND;
        const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Infinity;
        const target = Math.min(endSeconds, duration);
        if (target > t) {
          video.currentTime = target;
          deps.onSkipped(seg);
        }
        break;
      }
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
          reinitIfItemChanged();
          return;
        }
        this.detach();
        video = v;
        listener = onTick;
        v.addEventListener("timeupdate", listener);
        reinitIfItemChanged();
      },
      /** Stop and reset all state. Idempotent. */
      detach() {
        if (video && listener) video.removeEventListener("timeupdate", listener);
        video = null;
        listener = null;
        itemId = null;
        segments = [];
        lastTimeTicks = -1;
        lastKey = null;
        lastIgnored = false;
        fetchToken++;
      },
      /** Inspection hooks for tests/debugging — not part of the public surface. */
      _internal: {
        evaluate,
        reinitIfItemChanged,
        get segments() {
          return segments;
        },
        get itemId() {
          return itemId;
        },
        get lastKey() {
          return lastKey;
        },
        get lastIgnored() {
          return lastIgnored;
        }
      }
    };
  }

  // client/src/features/shared/settings-values.ts
  function isSafeCssColor(value) {
    if (typeof value !== "string") return false;
    const v = value.trim();
    if (!/^(?:#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|[a-z]+|(?:rgba?|hsla?)\([\d\s.,%/+-]*\))$/i.test(v)) return false;
    return typeof CSS === "undefined" || typeof CSS.supports !== "function" || CSS.supports("color", v);
  }

  // client/src/features/player/subtitle-sync/lines.ts
  var TICKS_PER_SECOND2 = 1e7;
  var MAX_OFFSET_SECONDS = 30;
  var MIN_OFFSET_MATCHES = 3;
  var member = (value, key) => typeof value === "object" && value !== null ? Reflect.get(value, key) : void 0;
  function cleanLineText(text) {
    if (typeof text !== "string") return "";
    let stripped = text.replace(/\\N/gi, "\n").replace(/\\h/g, " ").replace(/\r/g, "").replace(/\{\\[^}]*\}/g, "");
    let previous;
    do {
      previous = stripped;
      stripped = stripped.replace(/<\/?[a-zA-Z][^>]*>/g, "");
    } while (stripped !== previous);
    return stripped.split("\n").map((part2) => part2.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
  }
  function searchKey(text) {
    return String(text == null ? "" : text).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
  }
  function parseTrackEvents(data) {
    const events = member(data, "TrackEvents");
    const lines = [];
    for (const ev of Array.isArray(events) ? events : []) {
      if (!ev) continue;
      const start = Number(member(ev, "StartPositionTicks")) / TICKS_PER_SECOND2;
      const end = Number(member(ev, "EndPositionTicks")) / TICKS_PER_SECOND2;
      const text = cleanLineText(member(ev, "Text"));
      if (!text || !Number.isFinite(start) || start < 0) continue;
      lines.push({ index: 0, start, end: Number.isFinite(end) && end > start ? end : start, text, search: searchKey(text) });
    }
    lines.sort((a, b) => a.start - b.start);
    lines.forEach((line, i) => {
      line.index = i;
    });
    return lines;
  }
  function filterLines(lines, query) {
    const terms = searchKey(query).split(" ").filter(Boolean);
    if (!terms.length) return lines;
    return lines.filter((line) => terms.every((term) => line.search.includes(term)));
  }
  function roundOffset(seconds) {
    const v = Math.round(seconds * 10) / 10;
    return Object.is(v, -0) ? 0 : v;
  }
  function syncOffsetFor(lineStart, anchor) {
    return roundOffset(lineStart - anchor);
  }
  function offsetInRange(offset) {
    return Number.isFinite(offset) && Math.abs(offset) <= MAX_OFFSET_SECONDS;
  }
  function lineIndexAt(lines, time, offset) {
    let lo = 0;
    let hi = lines.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = lo + hi >> 1;
      const line = lines[mid];
      if (line && line.start - offset <= time) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }
  function measureOffset(lines, sample) {
    if (!sample || !sample.length || !lines.length) return null;
    const startsByKey = /* @__PURE__ */ new Map();
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
      const only = starts.length === 1 ? starts[0] : void 0;
      if (only !== void 0) diffs.push(only - cue.start);
    }
    if (!compared) return null;
    if (found < Math.ceil(compared * 0.6)) return "mismatch";
    if (diffs.length < MIN_OFFSET_MATCHES) return null;
    diffs.sort((a, b) => a - b);
    const median = diffs[diffs.length >> 1] ?? 0;
    const agreeing = diffs.filter((d) => Math.abs(d - median) <= 0.05).length;
    return agreeing < Math.ceil(diffs.length * 0.6) ? null : roundOffset(median);
  }
  function formatTime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor(total % 3600 / 60);
    const s = String(total % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  }
  function isProgressiveTranscode(src) {
    if (!/^https?:/i.test(src || "")) return false;
    const q = src.indexOf("?");
    const path = (q === -1 ? src : src.slice(0, q)).toLowerCase();
    if (!path.includes("/videos/") || path.endsWith(".m3u8")) return false;
    for (const [name, value] of new URLSearchParams(q === -1 ? "" : src.slice(q + 1))) {
      if (name.toLowerCase() === "static" && String(value).toLowerCase() === "true") return false;
    }
    return true;
  }
  function withinSeekable(video, time) {
    if (!(time >= 0)) return false;
    try {
      const ranges = video.seekable;
      for (let i = 0; ranges && i < ranges.length; i++) {
        if (time >= ranges.start(i) && time <= ranges.end(i)) return true;
      }
    } catch (err) {
      console.warn("🪼 Jellyfin Enhanced: subtitle sync seekable check failed", err);
    }
    return false;
  }
  function withTimeout(promise, ms, fallback) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(fallback), ms);
      Promise.resolve(promise).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        () => {
          clearTimeout(timer);
          resolve(fallback);
        }
      );
    });
  }
  function normalizeId(value) {
    const v = String(value || "").replace(/-/g, "").toLowerCase();
    return v || null;
  }

  // client/src/features/player/subtitle-sync/subtitle-sync.css
  var subtitle_sync_default = `/* Subtitle sync: the player's Subtitle Sync button and its dialog. dialog.ts adds one rule after these, setting
   --je-subsync-accent to the theme's accent (the value here is the fallback). */
.btnSubtitles.hide + #je-subtitle-sync-btn { display: none !important; }
/* JE's Material Symbols subset (declared in ui-styles.js), at the size of the player's own icons. */
#je-subtitle-sync-btn .je-msym-rounded {
    font-family: 'JE Material Symbols Rounded'; font-weight: normal; font-style: normal; font-size: 1.67em;
    line-height: 1; letter-spacing: normal; text-transform: none; display: inline-block; white-space: nowrap;
    word-wrap: normal; direction: ltr; font-feature-settings: 'liga'; -webkit-font-smoothing: antialiased;
}
#je-subtitle-sync {
    position: fixed; inset: 0; z-index: 10000; display: flex; align-items: center; justify-content: center;
    padding: 16px; box-sizing: border-box; background: rgba(0,0,0,0.6);
    --je-subsync-accent: #00a4dc;
}
#je-subtitle-sync .je-subsync-dialog {
    display: flex; flex-direction: column; width: min(680px, 100%); max-height: min(80vh, 760px);
    background: rgba(24,24,24,0.97); color: #fff; border: 1px solid rgba(255,255,255,0.12);
    border-radius: 12px; box-shadow: 0 16px 48px rgba(0,0,0,0.6); overflow: hidden; font-size: 15px;
}
#je-subtitle-sync .je-subsync-head { display: flex; align-items: flex-start; gap: 12px; padding: 16px 16px 8px 20px; }
#je-subtitle-sync .je-subsync-titles { flex: 1; min-width: 0; }
#je-subtitle-sync .je-subsync-title { margin: 0; font-size: 1.15em; font-weight: 600; }
#je-subtitle-sync .je-subsync-track { margin-top: 2px; font-size: 0.85em; color: rgba(255,255,255,0.65); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#je-subtitle-sync .je-subsync-icon-btn {
    flex: none; display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px;
    border: 0; border-radius: 50%; background: transparent; color: inherit; cursor: pointer; padding: 0;
}
#je-subtitle-sync .je-subsync-icon-btn:hover, #je-subtitle-sync .je-subsync-icon-btn:focus-visible { background: rgba(255,255,255,0.12); outline: none; }
#je-subtitle-sync .je-subsync-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px; padding: 0 20px 10px; font-size: 0.85em; color: rgba(255,255,255,0.75); }
#je-subtitle-sync .je-subsync-meta b { color: #fff; font-variant-numeric: tabular-nums; }
#je-subtitle-sync .je-subsync-reset {
    border: 1px solid rgba(255,255,255,0.25); background: transparent; color: inherit; border-radius: 999px;
    padding: 2px 10px; font: inherit; cursor: pointer;
}
#je-subtitle-sync .je-subsync-reset:hover, #je-subtitle-sync .je-subsync-reset:focus-visible { border-color: var(--je-subsync-accent); outline: none; }
#je-subtitle-sync .je-subsync-reset[hidden] { display: none; }
#je-subtitle-sync .je-subsync-search { padding: 0 16px 8px; }
#je-subtitle-sync .je-subsync-input {
    width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px; font: inherit; color: #fff;
    background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.18);
}
#je-subtitle-sync .je-subsync-input:focus { outline: none; border-color: var(--je-subsync-accent); }
#je-subtitle-sync .je-subsync-hint { padding: 0 20px 8px; font-size: 0.8em; color: rgba(255,255,255,0.6); }
#je-subtitle-sync .je-subsync-status { padding: 4px 20px 8px; font-size: 0.85em; }
#je-subtitle-sync .je-subsync-status:empty { display: none; }
#je-subtitle-sync .je-subsync-status[data-kind="error"] { color: #ff8a80; }
#je-subtitle-sync .je-subsync-status button { margin-left: 8px; }
#je-subtitle-sync .je-subsync-list { list-style: none; margin: 0; padding: 0 8px 8px; overflow-y: auto; flex: 1; min-height: 0; overscroll-behavior: contain; }
#je-subtitle-sync .je-subsync-row { display: flex; align-items: stretch; border-radius: 8px; }
#je-subtitle-sync .je-subsync-row[hidden] { display: none; }
#je-subtitle-sync .je-subsync-row.is-current { background: rgba(255,255,255,0.07); box-shadow: inset 3px 0 0 var(--je-subsync-accent); }
#je-subtitle-sync .je-subsync-line {
    flex: 1; min-width: 0; display: flex; gap: 12px; align-items: baseline; text-align: left; padding: 8px 10px;
    border: 0; border-radius: 8px; background: transparent; color: inherit; font: inherit; cursor: pointer;
}
#je-subtitle-sync .je-subsync-line:hover, #je-subtitle-sync .je-subsync-line:focus-visible { background: rgba(255,255,255,0.12); outline: none; }
#je-subtitle-sync .je-subsync-time { flex: none; min-width: 4.2em; font-size: 0.85em; color: rgba(255,255,255,0.6); font-variant-numeric: tabular-nums; }
#je-subtitle-sync .je-subsync-text { flex: 1; min-width: 0; white-space: pre-line; overflow-wrap: anywhere; }
#je-subtitle-sync .je-subsync-jump { align-self: center; color: rgba(255,255,255,0.7); }
#je-subtitle-sync .je-subsync-empty { padding: 24px 20px; text-align: center; color: rgba(255,255,255,0.6); }
#je-subtitle-sync .je-subsync-foot { padding: 8px 20px 12px; font-size: 0.8em; color: rgba(255,255,255,0.55); border-top: 1px solid rgba(255,255,255,0.08); }
#je-subtitle-sync .material-icons { font-size: 22px; }
@media (max-width: 600px) {
    #je-subtitle-sync { padding: 16px; align-items: flex-end; }
    #je-subtitle-sync .je-subsync-dialog { max-height: 85vh; }
}
`;

  // client/src/features/player/subtitle-sync/watch.ts
  var CUE_SAMPLE_SIZE = 24;
  var syncSlider = () => document.querySelector(".subtitleSyncSlider");
  function videoSrc(video) {
    return video && (video.currentSrc || video.src) || "";
  }
  function currentOffset() {
    const slider = syncSlider();
    if (!slider || typeof slider.updateOffset !== "function") return null;
    const v = parseFloat(slider.value);
    return Number.isFinite(v) ? v : 0;
  }
  function shownCueTrack(video) {
    try {
      const tracks = video && video.textTracks ? Array.from(video.textTracks) : [];
      return tracks.find((t) => t && String(t.label || "") === "manualTrack" && t.mode === "showing") || null;
    } catch {
      return null;
    }
  }
  function cueSample(video) {
    const cues = shownCueTrack(video)?.cues;
    if (!cues || !cues.length) return null;
    const step = Math.max(1, Math.floor(cues.length / CUE_SAMPLE_SIZE));
    const sample = [];
    for (let i = 0; i < cues.length && sample.length < CUE_SAMPLE_SIZE; i += step) {
      const cue = cues[i];
      if (cue) sample.push({ start: cue.startTime, key: searchKey(cleanLineText(Reflect.get(cue, "text"))) });
    }
    return sample;
  }
  function drawnSurface(video) {
    const custom = document.querySelector(".videoSubtitles .videoSubtitlesInner");
    if (custom) return custom;
    return video?.parentElement?.querySelector(".libassjs-canvas-parent") || null;
  }
  function firstCue(video) {
    const cues = video ? shownCueTrack(video)?.cues : null;
    return cues && cues.length ? cues[0] ?? null : null;
  }
  function rendererKey(video) {
    return video ? firstCue(video) || drawnSurface(video) : null;
  }
  function rendererOf(video) {
    const track = shownCueTrack(video);
    if (track) return { kind: "cues", track, cue: firstCue(video) };
    const el = drawnSurface(video);
    return el ? { kind: "drawn", el } : { kind: "none" };
  }
  function sameRenderer(a, b) {
    if (a.kind === "cues") return b.kind === "cues" && a.track === b.track && a.cue === b.cue;
    if (a.kind === "drawn") return b.kind === "drawn" && a.el === b.el;
    return b.kind === "none";
  }
  function linesStillShown(video, lines, renderer) {
    if (!lines || !renderer) return false;
    if (!sameRenderer(renderer, rendererOf(video))) return false;
    return measureOffset(lines, cueSample(video)) !== "mismatch";
  }
  function clientRendersSubtitles(video) {
    if (shownCueTrack(video)) return true;
    if (document.querySelector(".videoSubtitles .videoSubtitlesInner")) return true;
    return !!video?.parentElement?.querySelector(".libassjs-canvas-parent, .libassjs-canvas");
  }
  function syncSupport(video) {
    if (currentOffset() === null) return { ok: false, reason: "unavailable" };
    if (!clientRendersSubtitles(video)) return { ok: false, reason: "burned" };
    return { ok: true };
  }
  function createSubtitleWatch(getVideo) {
    let sliderWrites = 0;
    const watchedSliders = /* @__PURE__ */ new WeakSet();
    let changedAt = 0;
    let generation = 0;
    let keySeen;
    const firstSeen = /* @__PURE__ */ new WeakMap();
    let watchedTrackList = null;
    function countSliderWrite() {
      noteRenderer();
      sliderWrites++;
    }
    function watchSliderWrites() {
      const slider = syncSlider();
      const original = slider?.updateOffset;
      if (!slider || watchedSliders.has(slider) || typeof original !== "function") return;
      watchedSliders.add(slider);
      slider.updateOffset = function(...args) {
        countSliderWrite();
        return Reflect.apply(original, this, args);
      };
      slider.addEventListener("change", countSliderWrite);
    }
    const onTrackListChange = () => {
      setTimeout(noteRenderer, 50);
    };
    function watchSubtitleChanges(video) {
      const list = video?.textTracks;
      if (!list || list === watchedTrackList || typeof list.addEventListener !== "function") return;
      if (watchedTrackList && typeof watchedTrackList.removeEventListener === "function") watchedTrackList.removeEventListener("change", onTrackListChange);
      watchedTrackList = list;
      list.addEventListener("change", onTrackListChange);
    }
    function noteRenderer() {
      watchSliderWrites();
      const video = getVideo();
      watchSubtitleChanges(video);
      const key = rendererKey(video);
      if (keySeen === void 0) {
        keySeen = key;
        return;
      }
      if (key === keySeen) return;
      keySeen = key;
      if (key && firstSeen.has(key)) return;
      if (key) firstSeen.set(key, sliderWrites);
      changedAt = Date.now();
      generation++;
    }
    function effectiveOffset(video, lines) {
      const slider = currentOffset();
      if (slider === null) return null;
      if (!clientRendersSubtitles(video)) return 0;
      if (lines) {
        const measured = measureOffset(lines, cueSample(video));
        if (typeof measured === "number") return measured;
      }
      noteRenderer();
      const key = rendererKey(video);
      if (key && firstSeen.has(key) && firstSeen.get(key) === sliderWrites) return 0;
      return slider;
    }
    return {
      noteRenderer,
      effectiveOffset,
      generation: () => generation,
      changedAt: () => changedAt,
      /** Whether a renderer has been seen at the last look. */
      sawRenderer: () => !!keySeen
    };
  }

  // client/src/features/player/subtitle-sync/track.ts
  var FETCH_TIMEOUT_MS = 3e4;
  var REPORT_INTERVAL_MS = 11e3;
  var PAUSE_POSITION_TOLERANCE = 0.25;
  var TIMEOUTS = { sessionWait: 12e3, sessionPoll: 250, lookup: 8e3 };
  function createTrackLookup({ JE: JE2, ApiClient: ApiClient2, ctx: ctx2, watch }, isCurrent) {
    let lineCache = null;
    function currentUserId2() {
      try {
        return JE2.session?.getUserId?.() || ApiClient2.getCurrentUserId() || null;
      } catch {
        return null;
      }
    }
    function itemHint(video) {
      const fromSrc = ctx2.own.autoSkip?.parseItemIdFromVideosSrc?.(videoSrc(video)) ?? null;
      return normalizeId(fromSrc || ctx2.own.player?.getCurrentVideoItemId?.());
    }
    function isPauseReport(session, state) {
      if (session.PlayState.IsPaused !== true) return false;
      const position = Number(session.PlayState.PositionTicks) / TICKS_PER_SECOND2;
      return Number.isFinite(position) && Math.abs(position - state.anchor) <= PAUSE_POSITION_TOLERANCE;
    }
    async function probeFreshSession(state) {
      const probe = ctx2.own.player?.probeOwnSession;
      if (typeof probe !== "function") return null;
      const deadline = Date.now() + TIMEOUTS.sessionWait;
      const changedAt = watch.changedAt();
      const awaitReport = changedAt > 0 && Date.now() - changedAt < REPORT_INTERVAL_MS;
      let baseline;
      for (; ; ) {
        const session = await withTimeout(probe(), Math.max(1, deadline - Date.now()), null);
        if (!isCurrent(state)) return null;
        if (session) {
          const checkIn = session.LastPlaybackCheckIn || null;
          if (awaitReport) {
            if (baseline === void 0) baseline = checkIn;
            else if (checkIn !== baseline) return session;
          } else if (state.pausedByUs) {
            if (isPauseReport(session, state)) return session;
          } else {
            return session;
          }
        }
        if (Date.now() >= deadline) return null;
        await new Promise((resolve) => setTimeout(resolve, TIMEOUTS.sessionPoll));
        if (!isCurrent(state)) return null;
      }
    }
    const subtitleStream = (streams, index) => streams.find((s) => s.Type === "Subtitle" && s.Index === index) || null;
    async function resolveTrack(state) {
      const session = await probeFreshSession(state);
      if (!isCurrent(state)) return null;
      const itemId = session?.NowPlayingItem.Id;
      const hint = itemHint(state.video);
      if (!session || !itemId || hint && hint !== normalizeId(itemId)) return { error: "session" };
      const index = typeof session.PlayState.SubtitleStreamIndex === "number" ? session.PlayState.SubtitleStreamIndex : -1;
      if (index < 0) return { error: "none" };
      const mediaSourceId = session.PlayState.MediaSourceId || itemId;
      let stream = null;
      try {
        const userId = currentUserId2();
        const item = userId ? await withTimeout(ApiClient2.getItem(userId, itemId), TIMEOUTS.lookup, null) : null;
        if (!isCurrent(state)) return null;
        const source = item ? export02(item).MediaSources.find((s) => normalizeId(s.Id) === normalizeId(mediaSourceId)) : void 0;
        stream = source ? subtitleStream(source.MediaStreams, index) : null;
      } catch (err) {
        console.warn("🪼 Jellyfin Enhanced: subtitle sync item lookup failed", err);
      }
      if (!isCurrent(state)) return null;
      if (!stream) stream = subtitleStream(session.NowPlayingItem.MediaStreams, index);
      if (stream && stream.IsTextSubtitleStream === false) return { error: "image", stream };
      return { itemId, mediaSourceId, index, stream };
    }
    async function loadLines(state, track) {
      const key = [currentUserId2(), normalizeId(track.itemId), normalizeId(track.mediaSourceId), track.index].join("|");
      if (lineCache && lineCache.key === key) return lineCache.lines;
      const api = JE2.core.api;
      if (!api) throw new Error("The Jellyfin request helper is not available");
      const path = `/Videos/${encodeURIComponent(track.itemId)}/${encodeURIComponent(track.mediaSourceId)}/Subtitles/${track.index}/0/Stream.js`;
      const data = await api.jf(path, { signal: state.abort.signal, timeoutMs: FETCH_TIMEOUT_MS });
      const lines = parseTrackEvents(data);
      if (JE2.session ? JE2.session.isCurrent(state.epoch) : true) lineCache = { key, lines };
      return lines;
    }
    return { resolveTrack, loadLines, clearCache() {
      lineCache = null;
    } };
  }
  function trackLabel(stream) {
    if (!stream) return "";
    return String(stream.DisplayTitle || stream.Title || stream.Language || "").trim();
  }

  // client/src/features/player/subtitle-sync/view.ts
  var OVERLAY_ID = "je-subtitle-sync";
  var OVERLAY_MARKUP = `
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
  function part(state, selector) {
    const el = state.overlay.querySelector(selector);
    if (!el) throw new Error(`Subtitle sync dialog lost ${selector}`);
    return el;
  }
  var searchInput = (state) => state.overlay.querySelector(".je-subsync-input");
  function createView(watch, tr) {
    function formatOffset(seconds) {
      const v = roundOffset(seconds);
      return tr("subtitle_sync_seconds", "{value} s", { value: (v > 0 ? "+" : "") + v.toFixed(1) });
    }
    function buildOverlay() {
      const overlay = document.createElement("div");
      overlay.id = OVERLAY_ID;
      overlay.setAttribute("data-je-own-keys", "");
      overlay.innerHTML = OVERLAY_MARKUP;
      part({ overlay }, ".je-subsync-title").textContent = tr("subtitle_sync_title", "Sync subtitles");
      const close = part({ overlay }, ".je-subsync-close");
      close.title = tr("subtitle_sync_close", "Close");
      close.setAttribute("aria-label", close.title);
      const input = searchInput({ overlay });
      if (input) {
        input.placeholder = tr("subtitle_sync_placeholder", "Search the subtitles");
        input.setAttribute("aria-label", input.placeholder);
      }
      part({ overlay }, ".je-subsync-reset").textContent = tr("subtitle_sync_reset", "Reset offset");
      return overlay;
    }
    function setStatus(state, text, kind, action) {
      const box = part(state, ".je-subsync-status");
      box.replaceChildren();
      box.dataset.kind = kind || "info";
      if (!text) return;
      box.append(document.createTextNode(text));
      if (action) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "je-subsync-reset";
        btn.textContent = action.label;
        btn.addEventListener("click", action.run);
        box.append(btn);
      }
    }
    function refreshMeta(state) {
      const offset = watch.effectiveOffset(state.video, state.lines);
      const o = offset === null ? 0 : offset;
      part(state, ".je-subsync-anchor").textContent = tr("subtitle_sync_sync_point", "Heard at {time}", { time: formatTime(state.anchor) });
      const support = syncSupport(state.video);
      const showOffset = offset !== null && !!(state.lines && state.lines.length) && support.ok;
      part(state, ".je-subsync-offset").textContent = showOffset ? tr("subtitle_sync_offset", "Offset {offset}", { offset: formatOffset(o) }) : "";
      part(state, ".je-subsync-meta .je-subsync-reset").hidden = !showOffset || roundOffset(o) === 0;
      state.supportShown = support.ok;
      const hint = part(state, ".je-subsync-hint");
      if (!state.lines || !state.lines.length) {
        hint.textContent = "";
      } else if (support.ok) {
        hint.textContent = tr("subtitle_sync_hint", "Choose the line you just heard to sync the subtitles to it. The arrow button jumps to a line.");
      } else if (support.reason === "burned") {
        hint.textContent = tr("subtitle_sync_hint_burned", "These subtitles are part of the video picture, so they can't be shifted. Choosing a line jumps to it.");
      } else {
        hint.textContent = tr("subtitle_sync_hint_unavailable", "This player can't shift subtitles. Choosing a line jumps to it.");
      }
      if (state.lines) {
        const currentIndex = lineIndexAt(state.lines, state.anchor, o);
        for (const [index, row] of state.rows) {
          const time = row.querySelector(".je-subsync-time");
          if (time) time.textContent = formatTime((state.lines[index]?.start ?? 0) - o);
          row.classList.toggle("is-current", index === currentIndex);
        }
      }
    }
    function applyFilter(state) {
      if (!state.lines) return;
      const query = searchInput(state)?.value ?? "";
      const matches = filterLines(state.lines, query);
      const shown = new Set(matches.map((line) => line.index));
      for (const [index, row] of state.rows) row.hidden = !shown.has(index);
      const list = part(state, ".je-subsync-list");
      let empty = list.querySelector(".je-subsync-empty");
      if (!matches.length && state.lines.length) {
        if (!empty) {
          empty = document.createElement("li");
          empty.className = "je-subsync-empty";
          list.append(empty);
        }
        empty.textContent = tr("subtitle_sync_no_match", "No lines match your search.");
      } else if (empty) {
        empty.remove();
      }
      part(state, ".je-subsync-foot").textContent = tr("subtitle_sync_count", "{shown} of {total} lines", { shown: matches.length, total: state.lines.length });
      if (!searchKey(query)) {
        list.querySelector(".je-subsync-row.is-current")?.scrollIntoView({ block: "center" });
      } else {
        list.scrollTop = 0;
      }
    }
    function renderLines(state) {
      const fragment = document.createDocumentFragment();
      state.rows = /* @__PURE__ */ new Map();
      const jumpLabel = tr("subtitle_sync_jump", "Go to this line");
      for (const line of state.lines || []) {
        const row = document.createElement("li");
        row.className = "je-subsync-row";
        row.dataset.index = String(line.index);
        const main = document.createElement("button");
        main.type = "button";
        main.className = "je-subsync-line";
        const time = document.createElement("span");
        time.className = "je-subsync-time";
        const text = document.createElement("span");
        text.className = "je-subsync-text";
        text.textContent = line.text;
        main.append(time, text);
        const jump = document.createElement("button");
        jump.type = "button";
        jump.className = "je-subsync-icon-btn je-subsync-jump";
        jump.title = jumpLabel;
        jump.setAttribute("aria-label", jumpLabel);
        jump.innerHTML = '<span class="material-icons redo" aria-hidden="true"></span>';
        row.append(main, jump);
        fragment.append(row);
        state.rows.set(line.index, row);
      }
      part(state, ".je-subsync-list").replaceChildren(fragment);
      refreshMeta(state);
      applyFilter(state);
    }
    function moveFocus(state, from, step) {
      const buttons = Array.from(state.overlay.querySelectorAll(".je-subsync-row:not([hidden]) .je-subsync-line"));
      if (!buttons.length) return false;
      const input = searchInput(state);
      if (from === input) {
        if (step < 0) return false;
        const first = state.overlay.querySelector(".je-subsync-row.is-current:not([hidden]) .je-subsync-line") || buttons[0];
        first?.focus();
        first?.scrollIntoView({ block: "nearest" });
        return true;
      }
      const own = from.closest(".je-subsync-row")?.querySelector(".je-subsync-line");
      const at = own ? buttons.indexOf(own) : -1;
      if (at === -1) return false;
      const next = at + step;
      if (next < 0) {
        input?.focus();
        return true;
      }
      const target = buttons[next];
      if (!target) return false;
      target.focus();
      target.scrollIntoView({ block: "nearest" });
      return true;
    }
    return { formatOffset, buildOverlay, setStatus, refreshMeta, applyFilter, renderLines, moveFocus };
  }

  // client/src/features/shared/dom.ts
  function createCustomElement(tag, is) {
    const create = document.createElement;
    const element = create.call(document, tag, is);
    if (element.getAttribute("is") !== is) element.setAttribute("is", is);
    return element;
  }

  // client/src/features/player/subtitle-sync/dialog.ts
  var BUTTON_ID = "je-subtitle-sync-btn";
  var STYLE_ID = "je-subtitle-sync-style";
  var SEARCH_DEBOUNCE_MS = 80;
  var KEY_CODE_NAMES = {
    13: "Enter",
    27: "Escape",
    38: "ArrowUp",
    40: "ArrowDown",
    138: "ArrowUp",
    139: "ArrowDown",
    195: "GamepadA",
    196: "Escape",
    203: "ArrowUp",
    204: "ArrowDown",
    211: "ArrowUp",
    212: "ArrowDown",
    461: "Back",
    10009: "Back"
  };
  function installSubtitleSync({ JE: JE2, ApiClient: ApiClient2, ctx: ctx2 }) {
    function tr(key, fallback, params) {
      let value = null;
      try {
        value = typeof JE2.t === "function" ? JE2.t(key, params) : null;
      } catch {
        value = null;
      }
      if (value && value !== key) return value;
      let text = fallback;
      for (const [name, v] of Object.entries(params || {})) text = text.split(`{${name}}`).join(String(v));
      return text;
    }
    const toastText = (key, fallback) => {
      const value = JE2.t(key);
      return value && value !== key ? value : fallback;
    };
    const getVideo = () => ctx2.own.player?.getVideo?.() || document.querySelector("video");
    const watch = createSubtitleWatch(getVideo);
    const view = createView(watch, tr);
    let dialog = null;
    let pendingResume = null;
    function cancelPendingResume() {
      pendingResume?.cancel();
      pendingResume = null;
    }
    function isCurrent(state) {
      const open = dialog;
      return !!open && open === state && (!JE2.session || JE2.session.isCurrent(open.epoch)) && open.video.isConnected && getVideo() === open.video && videoSrc(open.video) === open.src;
    }
    const lookup = createTrackLookup({ JE: JE2, ApiClient: ApiClient2, ctx: ctx2, watch }, isCurrent);
    function transcodeOffsetSeconds(video) {
      const ticks = ctx2.own.autoSkip?.parseTranscodeOffsetTicksFromSrc?.(videoSrc(video)) ?? 0;
      return (Number(ticks) || 0) / TICKS_PER_SECOND2;
    }
    const mediaTime = (video) => (Number(video.currentTime) || 0) + transcodeOffsetSeconds(video);
    function injectStyles() {
      if (document.getElementById(STYLE_ID)) return;
      const accent = JE2.themer?.getThemeVariables?.()?.primaryAccent;
      const css = isSafeCssColor(accent) ? `${subtitle_sync_default}
#${OVERLAY_ID} { --je-subsync-accent: ${accent}; }` : subtitle_sync_default;
      const ui = JE2.core?.ui;
      if (ui?.injectCss) {
        ui.injectCss(STYLE_ID, css);
        return;
      }
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = css;
      document.head.appendChild(style);
    }
    function showStale(state) {
      state.lines = null;
      state.renderer = null;
      state.rows = /* @__PURE__ */ new Map();
      part(state, ".je-subsync-list").replaceChildren();
      part(state, ".je-subsync-foot").textContent = "";
      view.refreshMeta(state);
      view.setStatus(state, tr("subtitle_sync_stale", "These lines don't match the subtitles on screen."), "error", {
        label: tr("subtitle_sync_reload", "Reload"),
        run: () => {
          void populate(state);
        }
      });
    }
    async function populate(state) {
      view.setStatus(state, tr("subtitle_sync_loading", "Loading the subtitle lines…"));
      watch.noteRenderer();
      const startRenderer = rendererOf(state.video);
      const startGeneration = watch.generation();
      const retry = { label: tr("subtitle_sync_retry", "Try again"), run: () => {
        void populate(state);
      } };
      let track;
      try {
        track = await lookup.resolveTrack(state);
      } catch (err) {
        console.warn("🪼 Jellyfin Enhanced: subtitle sync track lookup failed", err);
        track = { error: "session" };
      }
      if (!track || !isCurrent(state)) return;
      part(state, ".je-subsync-track").textContent = trackLabel(track.stream);
      if ("error" in track) {
        if (track.error === "none") {
          view.setStatus(state, tr("subtitle_sync_none", "Turn on a subtitle track first."), "info", {
            label: tr("subtitle_sync_choose_track", "Choose subtitles"),
            run: () => {
              closeDialog();
              document.querySelector(".videoOsdBottom .btnSubtitles")?.click();
            }
          });
        } else if (track.error === "image") {
          view.setStatus(state, tr("subtitle_sync_image", "This subtitle track is made of images, so its lines can't be listed."), "info");
        } else {
          view.setStatus(state, tr("subtitle_sync_error_session", "Couldn't tell which subtitles are playing."), "error", retry);
        }
        return;
      }
      let lines;
      try {
        lines = await lookup.loadLines(state, track);
      } catch (err) {
        if (!isCurrent(state)) return;
        console.warn("🪼 Jellyfin Enhanced: subtitle lines request failed", err);
        view.setStatus(state, tr("subtitle_sync_error_load", "Couldn't load the subtitle lines."), "error", retry);
        return;
      }
      if (!isCurrent(state)) return;
      if (!lines.length) {
        view.setStatus(state, tr("subtitle_sync_empty", "This subtitle track has no lines."), "info");
        return;
      }
      const now = rendererOf(state.video);
      const unproven = !sameRenderer(startRenderer, now) || watch.generation() !== startGeneration;
      if (unproven && !state.relooked) {
        state.relooked = true;
        void populate(state);
        return;
      }
      if (unproven || measureOffset(lines, cueSample(state.video)) === "mismatch") {
        showStale(state);
        return;
      }
      view.setStatus(state, "");
      state.renderer = now;
      state.lines = lines;
      view.renderLines(state);
    }
    function jumpToLine(state, line) {
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
        view.setStatus(state, tr("subtitle_sync_jump_unavailable", "This stream can only jump within the part the server has prepared so far, and that line is outside it."), "error");
        return;
      }
      state.video.currentTime = Math.max(0, elementTime);
      closeDialog();
    }
    function chooseLine(state, line) {
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
        view.refreshMeta(state);
        return;
      }
      if (!support.ok) {
        jumpToLine(state, line);
        return;
      }
      const offset = syncOffsetFor(line.start, state.anchor);
      if (!offsetInRange(offset)) {
        view.setStatus(state, tr("subtitle_sync_too_far", "That line is {offset} away. Jellyfin can shift subtitles by up to {max} seconds.", {
          offset: view.formatOffset(offset),
          max: MAX_OFFSET_SECONDS
        }), "error");
        return;
      }
      if (typeof JE2.setSubtitleOffset !== "function" || !JE2.setSubtitleOffset(offset)) {
        view.setStatus(state, tr("subtitle_sync_hint_unavailable", "This player can't shift subtitles. Choosing a line jumps to it."), "error");
        view.refreshMeta(state);
        return;
      }
      JE2.toast?.(JE2.t("subtitle_sync_synced", { offset: JE2.escapeHtml(view.formatOffset(offset)) }));
      closeDialog();
    }
    function onDialogKey(state, e) {
      e.stopPropagation();
      if (e.type !== "keydown" || !(e.target instanceof Element)) return;
      const target = e.target;
      const key = KEY_CODE_NAMES[e.keyCode] || e.key || "";
      if (key === "Escape" || key === "Back" || key === "BrowserBack" || key === "GoBack") {
        e.preventDefault();
        closeDialog();
        return;
      }
      if (key === "ArrowDown" || key === "ArrowUp") {
        if (view.moveFocus(state, target, key === "ArrowDown" ? 1 : -1)) e.preventDefault();
        return;
      }
      if ((key === "Enter" || key === "GamepadA") && target.classList.contains("je-subsync-input")) {
        e.preventDefault();
        view.moveFocus(state, target, 1);
        return;
      }
      if (key === "GamepadA" && target instanceof HTMLButtonElement) {
        e.preventDefault();
        target.click();
        return;
      }
      if (e.key === "Tab") {
        const focusable = Array.from(state.overlay.querySelectorAll("button:not([hidden]), input")).filter((el) => !el.closest("[hidden]") && el.offsetParent !== null);
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
      if (target.classList.contains("je-subsync-input")) return;
      const combo = typeof JE2.keyCombo === "function" ? JE2.keyCombo(e) : null;
      const canonical = ctx2.peer("canonicalCombo");
      const bound = JE2.state?.activeShortcuts?.SubtitleSync;
      if (combo && bound && (typeof canonical === "function" ? canonical(bound) === canonical(combo) : bound === combo)) {
        e.preventDefault();
        closeDialog();
      }
    }
    function onDialogClick(state, e) {
      e.stopPropagation();
      if (!(e.target instanceof Element)) return;
      const target = e.target;
      if (target === state.overlay || target.closest(".je-subsync-close")) {
        closeDialog();
        return;
      }
      if (target.closest(".je-subsync-meta .je-subsync-reset")) {
        if (typeof JE2.setSubtitleOffset === "function" && JE2.setSubtitleOffset(0)) JE2.toast?.(JE2.t("subtitle_sync_offset_reset"));
        view.refreshMeta(state);
        setTimeout(() => {
          if (dialog === state) view.refreshMeta(state);
        }, 250);
        searchInput(state)?.focus();
        return;
      }
      const row = target.closest(".je-subsync-row");
      const line = row && state.lines ? state.lines[Number(row.dataset.index)] : void 0;
      if (!line) return;
      if (target.closest(".je-subsync-jump")) jumpToLine(state, line);
      else if (target.closest(".je-subsync-line")) chooseLine(state, line);
    }
    function openDialog() {
      if (dialog) {
        if (isCurrent(dialog)) {
          searchInput(dialog)?.focus();
          return;
        }
        closeDialog({ resume: false });
      }
      const video = getVideo();
      const onVideoPage = typeof JE2.isVideoPage !== "function" || JE2.isVideoPage();
      if (!video || !onVideoPage) {
        JE2.toast?.(video || !onVideoPage ? JE2.t("toast_no_video_found") : toastText("toast_player_unsupported", "{{icon:info}} Not available with this player"));
        return;
      }
      injectStyles();
      if (document.documentElement.classList.contains("pause-screen-active")) JE2.pauseScreenInstance?.hideOverlay?.();
      cancelPendingResume();
      watch.noteRenderer();
      const wasPlaying = !video.paused && !video.ended;
      if (wasPlaying) video.pause();
      const overlay = view.buildOverlay();
      const state = {
        video,
        src: videoSrc(video),
        epoch: JE2.session ? JE2.session.getEpoch() : 0,
        anchor: mediaTime(video),
        pausedByUs: wasPlaying,
        generationAtOpen: watch.generation(),
        abort: new AbortController(),
        returnFocus: document.activeElement,
        overlay,
        lines: null,
        rows: /* @__PURE__ */ new Map(),
        searchTimer: void 0,
        supportShown: false,
        renderer: null
      };
      dialog = state;
      const { signal } = state.abort;
      const keyHandler = (e) => onDialogKey(state, e);
      overlay.addEventListener("keydown", keyHandler);
      overlay.addEventListener("keyup", keyHandler);
      overlay.addEventListener("keypress", keyHandler);
      overlay.addEventListener("wheel", (e) => e.stopPropagation());
      overlay.addEventListener("click", (e) => onDialogClick(state, e));
      searchInput(state)?.addEventListener("input", () => {
        clearTimeout(state.searchTimer);
        state.searchTimer = window.setTimeout(() => {
          if (dialog === state) view.applyFilter(state);
        }, SEARCH_DEBOUNCE_MS);
      });
      const onGone = () => closeDialog({ resume: false });
      const onTracks = () => {
        setTimeout(() => {
          if (dialog !== state || !state.lines) return;
          if (linesStillShown(state.video, state.lines, state.renderer)) view.refreshMeta(state);
          else showStale(state);
        }, 60);
      };
      const onSeeking = () => {
        state.pausedByUs = false;
      };
      video.textTracks?.addEventListener?.("change", onTracks, { signal });
      video.addEventListener("seeking", onSeeking, { signal });
      video.addEventListener("emptied", onGone, { signal });
      document.addEventListener("viewshow", onGone, { signal });
      window.addEventListener("hashchange", onGone, { signal });
      document.body.appendChild(overlay);
      view.refreshMeta(state);
      searchInput(state)?.focus();
      void populate(state);
    }
    function resumeIfOwned(state) {
      const video = state.video;
      watch.noteRenderer();
      if (dialog === null && state.pausedByUs && watch.generation() === state.generationAtOpen && (!JE2.session || JE2.session.isCurrent(state.epoch)) && (typeof JE2.isVideoPage !== "function" || JE2.isVideoPage()) && video.isConnected && getVideo() === video && videoSrc(video) === state.src && video.paused) {
        Promise.resolve(video.play()).catch(() => {
        });
      }
    }
    function closeDialog(opts) {
      const state = dialog;
      if (!state) return;
      dialog = null;
      state.abort.abort();
      clearTimeout(state.searchTimer);
      state.overlay.remove();
      const video = state.video;
      if (!(opts && opts.resume === false) && state.pausedByUs) {
        if (rendererKey(video) === null && watch.sawRenderer()) {
          const waiting = new AbortController();
          const cancel = () => {
            state.pausedByUs = false;
          };
          video.addEventListener("seeking", cancel, { signal: waiting.signal });
          video.addEventListener("emptied", cancel, { signal: waiting.signal });
          document.addEventListener("viewshow", cancel, { signal: waiting.signal });
          window.addEventListener("hashchange", cancel, { signal: waiting.signal });
          const settle = () => {
            clearTimeout(timer);
            waiting.abort();
            if (pendingResume && pendingResume.state === state) pendingResume = null;
          };
          const timer = setTimeout(() => {
            settle();
            resumeIfOwned(state);
          }, 60);
          pendingResume = { state, cancel: () => {
            cancel();
            settle();
          } };
        } else {
          resumeIfOwned(state);
        }
      }
      const back = state.returnFocus;
      if (back instanceof HTMLElement && back.isConnected) {
        try {
          back.focus({ preventScroll: true });
        } catch {
        }
      }
    }
    JE2.toggleSubtitleSync = () => {
      if (dialog && isCurrent(dialog)) closeDialog();
      else openDialog();
    };
    JE2.addSubtitleSyncButton = () => {
      watch.noteRenderer();
      const existing = document.getElementById(BUTTON_ID);
      if (JE2.currentSettings?.subtitleSyncButtonEnabled !== true) {
        existing?.remove();
        return;
      }
      if (!getVideo()) {
        existing?.remove();
        return;
      }
      const subtitlesButton = document.querySelector(".videoOsdBottom .btnSubtitles");
      if (!subtitlesButton) return;
      if (existing && existing.previousElementSibling === subtitlesButton) return;
      existing?.remove();
      injectStyles();
      const label = tr("subtitle_sync_button", "Sync subtitles");
      const button = createCustomElement("button", "paper-icon-button-light");
      button.id = BUTTON_ID;
      button.type = "button";
      button.classList.add("autoSize", "paper-icon-button-light");
      button.title = label;
      button.setAttribute("aria-label", label);
      button.innerHTML = '<span class="xlargePaperIconButton je-msym-rounded" aria-hidden="true">subtitles_gear</span>';
      button.addEventListener("click", (e) => {
        e.stopPropagation();
        openDialog();
      });
      subtitlesButton.insertAdjacentElement("afterend", button);
    };
    JE2.session?.onUserChange?.("subtitle-sync", () => {
      closeDialog({ resume: false });
      lookup.clearCache();
    });
    ctx2.own.subtitleSync = {
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
      formatOffset: view.formatOffset,
      clientRendersSubtitles,
      isOpen: () => dialog !== null
    };
  }

  // client/src/features/player/auto-skip.ts
  var { JE, ApiClient, ctx } = export0();
  var lifetime = export03(JE, "auto-skip");
  function segmentTypeEnabled(type) {
    if (type === "Intro") return !!JE.currentSettings?.autoSkipIntro;
    if (type === "Outro") return !!JE.currentSettings?.autoSkipOutro;
    return false;
  }
  function segmentTypeEnabledFor(epoch, type) {
    if (JE.session && !JE.session.isCurrent(epoch)) return false;
    return segmentTypeEnabled(type);
  }
  function autoSkipToast(seg) {
    if (seg.Type === "Intro") JE.toast(JE.t("toast_auto_skipped_intro"));
    else if (seg.Type === "Outro") JE.toast(JE.t("toast_auto_skipped_outro"));
  }
  function parseItemIdFromVideosSrc(src) {
    const m = src.match(/\/[Vv]ideos\/([0-9a-fA-F-]{32,36})\b/);
    return m?.[1]?.replace(/-/g, "").toLowerCase() ?? null;
  }
  async function probeNowPlayingItemId(userId) {
    try {
      const api = JE.core?.api;
      const ac = ApiClient;
      if (!api || typeof api.jf !== "function" || !ac) return null;
      const deviceId = typeof ac.deviceId === "function" ? ac.deviceId() : "";
      if (!userId || !deviceId) return null;
      const sessions = await api.jf(
        `/Sessions?ControllableByUserId=${encodeURIComponent(userId)}`,
        { skipCache: true }
      );
      if (!Array.isArray(sessions)) return null;
      const matches = export3(sessions).filter((x) => x?.DeviceId === deviceId && x?.NowPlayingItem?.Id);
      return matches.length === 1 ? matches[0]?.NowPlayingItem?.Id || null : null;
    } catch (err) {
      console.warn("🪼 Jellyfin Enhanced: auto-skip now-playing probe failed", err);
      return null;
    }
  }
  async function fetchMediaSegments(itemId) {
    const api = JE.core?.api;
    if (!api || typeof api.jf !== "function") return [];
    const res = await api.jf(`/MediaSegments/${encodeURIComponent(itemId)}`, { skipCache: true });
    return export2(res);
  }
  function currentUserId() {
    try {
      return JE.session?.getUserId?.() || ApiClient?.getCurrentUserId?.() || null;
    } catch (err) {
      console.warn("🪼 Jellyfin Enhanced: auto-skip user lookup failed", err);
      return null;
    }
  }
  var _engine = null;
  var _engineEpoch = null;
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
        getPositionOffsetTicks: (video) => parseTranscodeOffsetTicksFromSrc(video.currentSrc || "")
      });
    }
    return _engine;
  }
  JE.session?.onUserChange("auto-skip", () => {
    _engine?.detach();
    _engine = null;
    _engineEpoch = null;
  });
  JE.initializeAutoSkipObserver = () => {
    if (!currentUserId()) return;
    const video = ctx.own.player?.getVideo?.();
    if (!video) return;
    autoSkipEngine().attach(video);
  };
  JE.stopAutoSkip = () => {
    _engine?.detach();
  };
  ctx.own.autoSkip = {
    TICKS_PER_SECOND,
    MIN_SEGMENT_TICKS,
    createAutoSkipEngine,
    createSessionItemResolver,
    parseTranscodeOffsetTicksFromSrc,
    parseItemIdFromVideosSrc,
    segmentTypeEnabled
  };
  lifetime.onReset(() => {
    _engine?.detach();
    _engine = null;
    _engineEpoch = null;
  });
  installSubtitleSync({ JE, ApiClient, ctx });
})();
})();
//# sourceMappingURL=auto-skip.js.map
