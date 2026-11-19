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

  // client/generated-shared/stub/client/src/features/media-tags/host.ts
  var shared = /* @__PURE__ */ sharedModule("features/media-tags/host");
  var export5 = /* @__PURE__ */ sharedExport(shared, "tagRuntimeHost");

  // client/src/features/media-tags/types/status/backdrop/blur.ts
  function boxSizes(sigma) {
    const width = Math.floor(sigma * 3 * Math.sqrt(2 * Math.PI) / 4 + 0.5);
    if (!(width > 1)) return [];
    return width % 2 ? [width, width, width] : [width, width, width + 1];
  }
  function blurLines(data, lines, length, lineStep, pixelStep, sizes, a, b) {
    const [s0 = 0, s1 = 0, s2 = 0] = sizes;
    const pad = (s0 + s1 + s2 - 3) / 2;
    const period = 2 * length;
    const padded = length + 2 * pad;
    const norm = 1 / (s0 * s1 * s2);
    for (let line = 0; line < lines; line++) {
      for (let channel = 0; channel < 3; channel++) {
        const base = line * lineStep + channel;
        for (let k = 0; k < padded; k++) {
          let j = (k - pad) % period;
          if (j < 0) j += period;
          if (j >= length) j = period - 1 - j;
          a[k] = data[base + j * pixelStep] ?? 0;
        }
        let from = a, to = b, count = padded;
        for (let pass = 0; pass < 3; pass++) {
          const size = sizes[pass] ?? 1;
          const out = count - size + 1;
          let sum = 0;
          for (let k = 0; k < size; k++) sum += from[k] ?? 0;
          to[0] = sum;
          for (let k = 1; k < out; k++) {
            sum += (from[k + size - 1] ?? 0) - (from[k - 1] ?? 0);
            to[k] = sum;
          }
          count = out;
          const swap = from;
          from = to;
          to = swap;
        }
        for (let j = 0; j < length; j++) data[base + j * pixelStep] = Math.floor((from[j] ?? 0) * norm + 0.5);
      }
    }
  }
  function blurRgba(data, width, height, sigma) {
    const sizes = boxSizes(sigma);
    if (!sizes.length || !(width > 0 && height > 0)) return data;
    const scratch = Math.max(width, height) + sizes.reduce((sum, size) => sum + size, 0);
    const a = new Float64Array(scratch), b = new Float64Array(scratch);
    blurLines(data, height, width, width * 4, 4, sizes, a, b);
    blurLines(data, width, height, 4, width * 4, sizes, a, b);
    return data;
  }

  // client/src/features/media-tags/types/status/backdrop/css-values.ts
  var UNITS = 64;
  var snap = (value) => Math.floor(value + 0.5);
  var units = (value) => Math.round(value * UNITS) / UNITS;
  function splitLayers(value) {
    const out = [];
    let depth = 0, start = 0;
    const text = String(value || "");
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "," && depth === 0) {
        out.push(text.slice(start, i).trim());
        start = i + 1;
      }
    }
    const last = text.slice(start).trim();
    if (last) out.push(last);
    return out;
  }
  function parseColour(value) {
    const text = String(value || "").trim();
    if (text === "transparent") return [0, 0, 0, 0];
    const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(text);
    if (!m) return null;
    let alpha = 1;
    if (m[4] !== void 0) alpha = m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [Number(m[1]), Number(m[2]), Number(m[3]), alpha];
  }
  function parseGradient(value) {
    const m = /^linear-gradient\((.*)\)$/s.exec(String(value || "").trim());
    if (!m) return null;
    const parts = splitLayers(m[1]);
    let angle = 180;
    const first = parts[0] || "";
    const sides = { "to top": 0, "to right": 90, "to bottom": 180, "to left": 270 };
    if (Object.prototype.hasOwnProperty.call(sides, first)) {
      angle = sides[first] ?? 180;
      parts.shift();
    } else if (/^-?[\d.]+deg$/.test(first)) {
      angle = parseFloat(first);
      parts.shift();
    } else if (/^to /.test(first) || /^-?[\d.]+(?:rad|grad|turn)$/.test(first)) {
      return null;
    }
    if (parts.length < 2) return null;
    const stops = [];
    for (const part of parts) {
      const s = /^(rgba?\([^)]*\))(?:\s+(-?[\d.]+)%)?$/.exec(part);
      if (!s || !s[1] || !parseColour(s[1])) return null;
      stops.push({ colour: s[1], at: s[2] === void 0 ? null : parseFloat(s[2]) / 100 });
    }
    const at = (i) => stops[i]?.at ?? null;
    const set = (i, value2) => {
      const stop = stops[i];
      if (stop) stop.at = value2;
    };
    if (at(0) === null) set(0, 0);
    if (at(stops.length - 1) === null) set(stops.length - 1, 1);
    for (let i = 1; i < stops.length; i++) {
      const own = at(i);
      if (own !== null) {
        set(i, Math.max(own, at(i - 1) ?? 0));
        continue;
      }
      let next = i;
      while (at(next) === null) next++;
      const from = at(i - 1) ?? 0;
      const to = Math.max(from, at(next) ?? 0);
      for (let k = i; k < next; k++) set(k, from + (to - from) * (k - i + 1) / (next - i + 1));
    }
    if (stops.some((stop) => (stop.at ?? 0) < 0 || (stop.at ?? 0) > 1)) return null;
    return { angle, stops: stops.map((stop) => ({ at: stop.at ?? 0, colour: stop.colour })) };
  }
  function parseLength(value) {
    const m = /^(-?[\d.]+)(%|px)$/.exec(String(value || "").trim());
    if (!m || !m[1]) return null;
    return m[2] === "%" ? { pct: parseFloat(m[1]) / 100 } : { px: parseFloat(m[1]) };
  }
  function fitImage(naturalWidth, naturalHeight, boxWidth, boxHeight, fit, scale) {
    if (!(naturalWidth > 0 && naturalHeight > 0 && boxWidth > 0 && boxHeight > 0)) return null;
    const size = String(fit.size || "").trim();
    const cover = Math.max(boxWidth / naturalWidth, boxHeight / naturalHeight);
    const contain = Math.min(boxWidth / naturalWidth, boxHeight / naturalHeight);
    let width, height;
    if (size === "cover") {
      width = naturalWidth * cover;
      height = naturalHeight * cover;
    } else if (size === "contain") {
      width = naturalWidth * contain;
      height = naturalHeight * contain;
    } else if (size === "fill") {
      width = boxWidth;
      height = boxHeight;
    } else if (size === "none" || size === "auto" || size === "auto auto") {
      width = naturalWidth * scale;
      height = naturalHeight * scale;
    } else if (size === "scale-down") {
      const s = Math.min(scale, contain);
      width = naturalWidth * s;
      height = naturalHeight * s;
    } else {
      const parts = size.split(/\s+/);
      if (parts.length > 2) return null;
      const w = parts[0] === "auto" ? null : parseLength(parts[0]);
      const h = parts.length < 2 || parts[1] === "auto" ? null : parseLength(parts[1]);
      if (parts[0] !== "auto" && !w || parts.length === 2 && parts[1] !== "auto" && !h) return null;
      const px2 = (v, box) => "pct" in v ? v.pct * box : v.px * scale;
      width = w ? px2(w, boxWidth) : null;
      height = h ? px2(h, boxHeight) : null;
      if (width === null && height === null) return null;
      if (width === null) width = (height ?? 0) * naturalWidth / naturalHeight;
      if (height === null) height = width * naturalHeight / naturalWidth;
    }
    if (!(width > 0 && height > 0)) return null;
    const position = String(fit.position || "50% 50%").trim().split(/\s+/);
    if (position.length !== 2) return null;
    const px = parseLength(position[0]), py = parseLength(position[1]);
    if (!px || !py) return null;
    const x = "pct" in px ? (boxWidth - width) * px.pct : px.px * scale;
    const y = "pct" in py ? (boxHeight - height) * py.pct : py.px * scale;
    return { x, y, width, height };
  }
  function startsPixelGrid(style, moves) {
    const contain = style.contain || "";
    const paint = /\b(?:paint|content|strict)\b/.test(contain);
    const layout = /\b(?:layout|content|strict)\b/.test(contain);
    const styled = /\b(?:style|content|strict)\b/.test(contain) || !!style.containerType && style.containerType !== "normal";
    return paint || layout && styled || /\b(?:transform|scale|rotate)\b/.test(style.willChange || "") || !!style.contentVisibility && style.contentVisibility !== "visible" || !!style.transform && style.transform !== "none" && !moves;
  }
  function placeLayer(from, to, near, far) {
    const lo = Math.max(from, near), hi = Math.min(to, far);
    if (!(hi > lo) || snap(lo) !== from || snap(hi) !== to) return null;
    return { offset: lo - near, size: hi - lo };
  }

  // client/src/features/media-tags/types/status/backdrop/state.ts
  var tagClass = "status-tag";
  var backdropLog = "🪼 Jellyfin Enhanced: Status tag backdrop:";
  var BLUR_PX = 6;
  var MAX_SCALE = 3;
  var ARTWORK_CAP = 12;
  var ARTWORK_PIXELS = 4e6;
  var MAX_DECODES = 4;
  var STEP_MIN_MS = 3;
  var SLICE_BUDGET_MS = 6;
  var MEASURE_CARDS = 6;
  var MEASURE_BUDGET_MS = 3;
  var RESIZE_SETTLE_MS = 200;
  var BENEATH_REACH = 6;
  var UNREADABLE_CAP = 500;
  var LIVE_REST_MS = 180;
  var HOLD_MS = 1e3;
  var HOLD_MAX_MS = 3e4;
  var QUIET_MS = 3e3;
  var AGAIN_EVENTS = ["transitionend", "transitioncancel", "animationend", "pointerleave", "focusout"];
  var PROBE_RGB = [18, 52, 86];
  var HOST_MARKS = /* @__PURE__ */ new Set(["data-je-flow", "data-je-live", "data-je-blur"]);
  function createBackdropState() {
    return {
      cards: /* @__PURE__ */ new Map(),
      dirty: /* @__PURE__ */ new Set(),
      applied: /* @__PURE__ */ new WeakMap(),
      waiting: [],
      ready: [],
      decoding: /* @__PURE__ */ new Map(),
      artwork: /* @__PURE__ */ new Map(),
      unreadable: /* @__PURE__ */ new Set(),
      tainting: /* @__PURE__ */ new Set(),
      lingering: /* @__PURE__ */ new Set(),
      detached: /* @__PURE__ */ new WeakSet(),
      counters: { passes: 0, maxPassMs: 0, measures: 0, measureMs: 0, maxMeasureMs: 0, layoutMs: 0, cards: 0, reused: 0, slices: 0, sliceMs: 0, maxSliceMs: 0, decodes: 0, drawn: 0, plain: 0, pixelMs: 0, maxPixelMs: 0, failed: 0 },
      active: true,
      supported: null,
      generation: 0,
      quietMs: QUIET_MS,
      lastTracked: -Infinity
    };
  }

  // client/src/features/media-tags/types/status/backdrop/draw.ts
  var closeBitmap = (entry) => entry.drawable.close?.();
  function roundedPath(ctx, width, height, radii) {
    const [r0 = 0, r1 = 0, r2 = 0, r3 = 0] = radii;
    const limit = Math.min(1, width / Math.max(1e-6, r0 + r1), width / Math.max(1e-6, r3 + r2), height / Math.max(1e-6, r0 + r3), height / Math.max(1e-6, r1 + r2));
    const [tl, tr, br, bl] = [r0 * limit, r1 * limit, r2 * limit, r3 * limit];
    ctx.beginPath();
    ctx.moveTo(tl, 0);
    ctx.lineTo(width - tr, 0);
    ctx.arcTo(width, 0, width, tr, tr);
    ctx.lineTo(width, height - br);
    ctx.arcTo(width, height, width - br, height, br);
    ctx.lineTo(bl, height);
    ctx.arcTo(0, height, 0, height - bl, bl);
    ctx.lineTo(0, tl);
    ctx.arcTo(0, 0, tl, 0, tl);
    ctx.closePath();
  }
  function fillGradient(ctx, under, gradient, dx, dy) {
    const rad = gradient.angle * Math.PI / 180;
    const sin = Math.sin(rad), cos = Math.cos(rad);
    const half = (Math.abs(under.width * sin) + Math.abs(under.height * cos)) / 2;
    const cx = dx + under.width / 2, cy = dy + under.height / 2;
    const fill = ctx.createLinearGradient(cx - sin * half, cy + cos * half, cx + sin * half, cy - cos * half);
    for (const stop of gradient.stops) fill.addColorStop(stop.at, stop.colour);
    ctx.fillStyle = fill;
    ctx.fillRect(dx, dy, under.width, under.height);
  }
  function createDraw(st, fns) {
    let sliceScheduled = false;
    let quietTimer = 0;
    let canvas = null;
    let cutter = null;
    function write(carrier, layers, base) {
      const image = layers.map((l) => `url("${l.url}")`);
      const position = layers.map((l) => `${l.x}px ${l.y}px`);
      const size = layers.map((l) => `${l.width}px ${l.height}px`);
      const repeat = layers.map(() => "no-repeat");
      if (base) {
        image.push(...base.image);
        position.push(...base.position);
        size.push(...base.size);
        repeat.push(...base.repeat);
      }
      carrier.style.setProperty("background-image", image.join(", "));
      carrier.style.setProperty("background-position", position.join(", "));
      carrier.style.setProperty("background-size", size.join(", "));
      carrier.style.setProperty("background-repeat", repeat.join(", "));
      st.applied.set(carrier, layers.length);
    }
    function clear(carrier) {
      if (!st.applied.has(carrier)) return;
      st.applied.delete(carrier);
      for (const property of ["background-image", "background-position", "background-size", "background-repeat"]) carrier.style.removeProperty(property);
    }
    function scheduleSlice() {
      if (sliceScheduled || !st.active) return;
      const wait = st.lastTracked + st.quietMs - performance.now();
      if (wait > 0) {
        if (!quietTimer) {
          quietTimer = setTimeout(() => {
            quietTimer = 0;
            scheduleSlice();
          }, wait);
        }
        return;
      }
      sliceScheduled = true;
      if (typeof requestIdleCallback === "function") requestIdleCallback(runSlice, { timeout: 500 });
      else setTimeout(() => runSlice(), 16);
    }
    const wanted = (job) => st.cards.get(job.card.host) === job.card && job.card.sig === job.sig && job.card.latest === job && job.card.host.isConnected;
    function runSlice(deadline) {
      sliceScheduled = false;
      if (!st.active) return;
      const started = performance.now();
      const left = typeof deadline?.timeRemaining === "function" ? () => deadline.timeRemaining() : () => SLICE_BUDGET_MS - (performance.now() - started);
      const late = !deadline || !!deadline.didTimeout;
      let steps = 0;
      while (st.ready.length && (left() >= STEP_MIN_MS || late && steps === 0)) {
        const job = st.ready.shift();
        if (!job || !wanted(job)) continue;
        steps++;
        draw(job);
      }
      let launched = 0;
      while (st.waiting.length && (left() >= STEP_MIN_MS || late && !steps && !launched)) {
        const job = st.waiting[0];
        if (!job || !wanted(job)) {
          st.waiting.shift();
          continue;
        }
        if (st.artwork.has(job.key)) {
          st.waiting.shift();
          st.ready.push(job);
          continue;
        }
        const flight = st.decoding.get(job.key);
        if (flight) {
          st.waiting.shift();
          flight.jobs.add(job);
          continue;
        }
        if (st.decoding.size >= MAX_DECODES) break;
        st.waiting.shift();
        launched++;
        decode(job);
      }
      const spent = performance.now() - started;
      st.counters.slices++;
      st.counters.sliceMs += spent;
      st.counters.maxSliceMs = Math.max(st.counters.maxSliceMs, spent);
      if (st.ready.length || st.waiting.length && st.decoding.size < MAX_DECODES) scheduleSlice();
    }
    function decode(job) {
      const key = job.key;
      const gen = st.generation;
      const flight = { jobs: /* @__PURE__ */ new Set([job]) };
      st.decoding.set(key, flight);
      st.counters.decodes++;
      const settle = (entry) => {
        const stale = st.decoding.get(key) !== flight || gen !== st.generation;
        if (st.decoding.get(key) === flight) st.decoding.delete(key);
        if (stale) {
          if (entry?.bitmap) closeBitmap(entry);
          return;
        }
        if (entry) {
          remember(key, entry);
          for (const j of flight.jobs) st.ready.push(j);
        } else {
          fns.markUnreadable(key);
          st.counters.failed++;
        }
        scheduleSlice();
      };
      (async () => {
        let source = job.img && job.img.complete && job.img.naturalWidth > 0 ? job.img : null;
        if (!source) {
          source = new Image();
          source.decoding = "async";
          source.src = job.url;
          await source.decode();
        }
        const width = source.naturalWidth, height = source.naturalHeight;
        if (!(width > 0 && height > 0)) return null;
        if (typeof createImageBitmap === "function") {
          try {
            return { drawable: await createImageBitmap(source), bitmap: true, width, height };
          } catch (err) {
            if (err instanceof Error && err.name === "SecurityError") return null;
          }
        }
        if (source === job.img && typeof source.decode === "function") await source.decode();
        return { drawable: source, bitmap: false, width, height };
      })().then(settle, (err) => {
        const name = err instanceof Error ? err.name : "";
        if (name !== "SecurityError" && name !== "InvalidStateError" && name !== "EncodingError") console.debug(`${backdropLog} could not decode artwork`, err);
        settle(null);
      });
    }
    function remember(key, entry) {
      forget(key);
      st.artwork.set(key, entry);
      const pixels = () => {
        let sum = 0;
        for (const e of st.artwork.values()) sum += e.width * e.height;
        return sum;
      };
      while (st.artwork.size > 1 && (st.artwork.size > ARTWORK_CAP || pixels() > ARTWORK_PIXELS)) {
        const [oldest] = st.artwork.keys();
        if (oldest === void 0) break;
        forget(oldest);
      }
    }
    function forget(key) {
      const entry = st.artwork.get(key);
      if (!entry) return;
      st.artwork.delete(key);
      if (entry.bitmap) closeBitmap(entry);
    }
    function picture(job, spec, art, placed) {
      const { width, height } = spec;
      canvas = canvas || document.createElement("canvas");
      const sheet = canvas;
      sheet.width = width;
      sheet.height = height;
      const ctx = sheet.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, width, height);
      if (job.base) {
        ctx.fillStyle = job.base;
        ctx.fillRect(0, 0, width, height);
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "medium";
      ctx.drawImage(art.drawable, placed.x - spec.x, placed.y - spec.y, placed.width, placed.height);
      const background = (under) => {
        const dx = under.x - spec.x, dy = under.y - spec.y;
        if (under.colour) {
          ctx.fillStyle = under.colour;
          ctx.fillRect(dx, dy, under.width, under.height);
        }
        for (let i = under.gradients.length - 1; i >= 0; i--) {
          const gradient = under.gradients[i];
          if (gradient) fillGradient(ctx, under, gradient, dx, dy);
        }
      };
      spec.unders.filter((under) => under.host).forEach(background);
      spec.unders.filter((under) => !under.host).forEach(background);
      const pixels = ctx.getImageData(0, 0, width, height);
      const data = pixels.data;
      for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return null;
      blurRgba(data, width, height, BLUR_PX * job.scale);
      ctx.putImageData(pixels, 0, 0);
      if (spec.radii.some((r) => r > 0)) {
        ctx.globalCompositeOperation = "destination-in";
        ctx.fillStyle = "#000";
        roundedPath(ctx, width, height, spec.radii);
        ctx.fill();
        ctx.globalCompositeOperation = "source-over";
      }
      return spec.pieces.map((p) => {
        if (p.sx === 0 && p.sy === 0 && p.width === width && p.height === height) return sheet.toDataURL("image/png");
        cutter = cutter || document.createElement("canvas");
        cutter.width = p.width;
        cutter.height = p.height;
        const cut = cutter.getContext("2d");
        if (!cut) return "";
        cut.clearRect(0, 0, p.width, p.height);
        cut.drawImage(sheet, p.sx, p.sy, p.width, p.height, 0, 0, p.width, p.height);
        return cutter.toDataURL("image/png");
      });
    }
    function show(job, drawn) {
      const layers = /* @__PURE__ */ new Map();
      job.specs.forEach((spec, at) => {
        const urls = drawn[at];
        if (!urls) return;
        spec.pieces.forEach((p, i) => {
          const url = urls[i];
          if (!url) return;
          const list = layers.get(p.carrier) ?? [];
          list.push({ url, x: p.left, y: p.top, width: p.cssWidth, height: p.cssHeight });
          layers.set(p.carrier, list);
        });
      });
      const card = job.card;
      if (card.live) return;
      const complete = !job.partial && job.specs.length > 0 && job.specs.every((spec, at) => {
        const urls = drawn[at];
        return !!urls && spec.pieces.every((p, i) => !!urls[i] && p.carrier.isConnected);
      });
      if (!complete) layers.clear();
      for (const carrier of Array.from(card.carriers)) {
        if (layers.has(carrier)) continue;
        clear(carrier);
        card.carriers.delete(carrier);
      }
      for (const [carrier, list] of layers) {
        write(carrier, list, job.bases.get(carrier) || null);
        card.carriers.add(carrier);
      }
      card.chips?.takeRecords();
      fns.setBlur(card.host, !complete);
    }
    function draw(job) {
      const art = st.artwork.get(job.key);
      if (!art) {
        st.waiting.push(job);
        return;
      }
      st.artwork.delete(job.key);
      st.artwork.set(job.key, art);
      const started = performance.now();
      let drawn = [];
      try {
        const placed = fitImage(art.width, art.height, job.boxWidth, job.boxHeight, job.fit, job.scale);
        drawn = job.specs.map((spec) => {
          const urls = placed ? picture(job, spec, art, placed) : null;
          if (urls) st.counters.drawn++;
          else st.counters.plain++;
          return urls;
        });
      } catch (err) {
        drawn = [];
        fns.markUnreadable(job.key);
        const name = err instanceof Error ? err.name : "";
        if (name === "SecurityError") st.tainting.add(fns.originOf(job.key));
        forget(job.key);
        st.counters.failed++;
        if (name !== "SecurityError") console.debug(`${backdropLog} could not draw a backdrop`, err);
      }
      job.card.kept = { job, drawn };
      show(job, drawn);
      const spent = performance.now() - started;
      st.counters.pixelMs += spent;
      st.counters.maxPixelMs = Math.max(st.counters.maxPixelMs, spent);
    }
    function dropWork() {
      st.generation++;
      st.waiting.length = 0;
      st.ready.length = 0;
      st.decoding.clear();
      for (const key of Array.from(st.artwork.keys())) forget(key);
    }
    return { write, clear, scheduleSlice, show, dropWork };
  }

  // client/src/features/media-tags/types/status/backdrop/read.ts
  function paintOrigin(el, memo) {
    if (!el || el === document.documentElement) return { x: 0, y: 0 };
    const known = memo.get(el);
    if (known) return known;
    const style = getComputedStyle(el);
    let origin;
    const move = /^matrix\(1, 0, 0, 1, (-?[\d.e-]+), (-?[\d.e-]+)\)$/.exec(style.transform || "");
    if (startsPixelGrid(style, !!move)) {
      const rect = el.getBoundingClientRect();
      origin = { x: rect.left, y: rect.top };
    } else {
      const up = paintOrigin(el.parentElement, memo);
      origin = move ? { x: up.x + Number(move[1]), y: up.y + Number(move[2]) } : up;
    }
    memo.set(el, origin);
    return origin;
  }
  function backgroundOf(style, box, skip) {
    const colour = parseColour(style.backgroundColor);
    if (!colour) return null;
    const images = splitLayers(style.backgroundImage).slice(skip);
    const gradients = [];
    for (const image of images) {
      if (image === "none") continue;
      const gradient = parseGradient(image);
      if (!gradient) return null;
      gradients.push(gradient);
    }
    if (gradients.length) {
      const plain = (value, allowed) => splitLayers(value).slice(skip).slice(0, images.length).every((v) => allowed.includes(v));
      if (!plain(style.backgroundSize, ["auto", "auto auto", "100% 100%"]) || !plain(style.backgroundPosition, ["0% 0%", "0px 0px"]) || !plain(style.backgroundOrigin, ["padding-box", "border-box"]) || !plain(style.backgroundClip, ["border-box", "padding-box"]) || parseFloat(style.borderTopWidth) || parseFloat(style.borderLeftWidth) || parseFloat(style.borderRightWidth) || parseFloat(style.borderBottomWidth)) return null;
    }
    const painted = (colour[3] ?? 0) > 0 || gradients.length > 0;
    return { colour: (colour[3] ?? 0) > 0 ? style.backgroundColor : null, gradients, text: painted ? `${style.backgroundColor};${images.join(",")}@${box.join(",")}` : "" };
  }
  function baseOf(style, skip) {
    const image = splitLayers(style.backgroundImage).slice(skip);
    if (!image.length || image.every((v) => v === "none")) return null;
    const list = (value, fallback) => {
      const own = splitLayers(value).slice(skip);
      return image.map((_, i) => own[i % Math.max(1, own.length)] || fallback);
    };
    return { image, position: list(style.backgroundPosition, "0% 0%"), size: list(style.backgroundSize, "auto"), repeat: list(style.backgroundRepeat, "repeat") };
  }
  function chipBeneath(host, slot, opacity, box, X, Y) {
    const [left = 0, top = 0, right = 0, bottom = 0] = box;
    const over = (r) => r.width > 0 && r.height > 0 && X(r.right) > left - BENEATH_REACH && X(r.left) < right + BENEATH_REACH && Y(r.bottom) > top - BENEATH_REACH && Y(r.top) < bottom + BENEATH_REACH;
    for (const other of Array.from(host.children)) {
      if (other === slot) break;
      if (!other.classList.contains("je-tag-slot") || !over(other.getBoundingClientRect())) continue;
      const shown = getComputedStyle(other);
      if (shown.visibility === "hidden" || Math.abs(Number(shown.opacity) - opacity) > 0.05) continue;
      for (const el of Array.from(other.querySelectorAll("*"))) {
        if (!over(el.getBoundingClientRect())) continue;
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || !(Number(style.opacity) > 0)) continue;
        const colour = parseColour(style.backgroundColor);
        const edge = parseFloat(style.borderTopWidth) || 0;
        const edgeColour = parseColour(style.borderTopColor);
        if (colour && (colour[3] ?? 0) > 0 || edge > 0 && edgeColour && (edgeColour[3] ?? 0) > 0) return true;
        if (el.tagName === "IMG" || el.localName === "svg" || style.backgroundImage !== "none" || style.boxShadow !== "none") return true;
        if (Array.from(el.childNodes).some((node) => node.nodeType === 3 && /\S/.test(node.nodeValue || ""))) return true;
      }
    }
    return false;
  }
  function artworkOf(host) {
    const parent = host.parentElement;
    if (!parent) return null;
    const container = parent.classList.contains("cardScalable") ? parent.querySelector(".cardImageContainer") : parent;
    if (!container) return null;
    const img = Array.from(container.querySelectorAll("img")).find((el) => !el.closest(".je-tag-host"));
    if (img) {
      const url = img.currentSrc || img.src;
      if (!url) return { wait: container, img: null };
      return img.complete && img.naturalWidth > 0 ? { box: img, container, url, img } : { wait: container, img };
    }
    const bg = /url\(["']?([^"')]+)["']?\)/.exec((container instanceof HTMLElement ? container.style?.backgroundImage : "") || "");
    return bg && bg[1] && container instanceof HTMLElement ? { box: container, container, url: bg[1], img: null } : { wait: container, img: null };
  }
  function createRead(st, fns) {
    function read(card, scale, pass) {
      const none = { card, sig: "", job: null };
      const host = card.host;
      const tags = Array.from(host.querySelectorAll(`.${tagClass}`));
      if (!tags.length) return none;
      const art = artworkOf(host);
      fns.watchArtwork(card, art ? "wait" in art ? art.wait : art.container : null, art && "wait" in art ? art.img : null);
      if (!art || "wait" in art || st.unreadable.has(art.url) || st.tainting.size && st.tainting.has(fns.originOf(art.url))) return none;
      const kept = card.kept;
      if (!card.moved && kept && kept.job.sig === card.fullSig && kept.job.url === art.url && kept.job.scale === scale && kept.job.specs.every((spec) => spec.pieces.every((p) => p.carrier.isConnected))) {
        return { card, sig: kept.job.sig, job: kept.job };
      }
      const result = full(card, scale, pass, art, tags);
      if (!result.hold) card.fullSig = result.sig;
      return result;
    }
    function full(card, scale, pass, art, tags) {
      const none = { card, sig: "", job: null };
      const host = card.host;
      const probe = pass.probed ? 0 : performance.now();
      const boxRect = art.box.getBoundingClientRect();
      if (!pass.probed) {
        pass.probed = true;
        st.counters.layoutMs += performance.now() - probe;
      }
      if (!(boxRect.width > 0 && boxRect.height > 0)) {
        card.moved = false;
        return none;
      }
      const laidOut = [art.box.offsetWidth, art.box.offsetHeight];
      if (laidOut[0] > 0 && laidOut[1] > 0 && (Math.abs(boxRect.width - laidOut[0]) > Math.max(1, laidOut[0] * 0.01) || Math.abs(boxRect.height - laidOut[1]) > Math.max(1, laidOut[1] * 0.01))) {
        fns.measureAgainLater(card, true);
        return { card, sig: "", job: null, hold: true };
      }
      card.moved = false;
      card.holdMs = 0;
      const boxStyle = getComputedStyle(art.box);
      const shown = (style, el) => style.filter === "none" && style.visibility !== "hidden" && (Number(style.opacity) >= 1 || typeof el.getAnimations === "function" && el.getAnimations().length > 0);
      if (!shown(boxStyle, art.box)) {
        fns.measureAgainLater(card);
        return none;
      }
      const containerStyle = art.container === art.box ? boxStyle : getComputedStyle(art.container);
      if (art.container !== art.box && !shown(containerStyle, art.container)) {
        fns.measureAgainLater(card);
        return none;
      }
      let fit;
      if (art.img) fit = { size: boxStyle.objectFit, position: boxStyle.objectPosition };
      else {
        if (splitLayers(boxStyle.backgroundImage).length !== 1 || boxStyle.backgroundAttachment !== "scroll" || !["padding-box", "border-box"].includes(boxStyle.backgroundOrigin) || boxStyle.backgroundRepeat !== "no-repeat" && boxStyle.backgroundSize !== "cover") return none;
        fit = { size: boxStyle.backgroundSize, position: boxStyle.backgroundPosition };
      }
      const baseColour = [boxStyle.backgroundColor, containerStyle.backgroundColor].find((c) => ((parseColour(c) || [0, 0, 0, 0])[3] ?? 0) >= 1) || null;
      const origin = paintOrigin(host, pass.origins);
      const X = (v) => (v - origin.x) * scale, Y = (v) => (v - origin.y) * scale;
      const boxLeft = snap(X(boxRect.left)), boxTop = snap(Y(boxRect.top));
      const boxWidth = snap(X(boxRect.right)) - boxLeft, boxHeight = snap(Y(boxRect.bottom)) - boxTop;
      if (!(boxWidth > 0 && boxHeight > 0)) return none;
      const frac = (v) => units(v - Math.floor(v));
      const seen = /* @__PURE__ */ new Map();
      const facts = (el) => {
        let f = seen.get(el);
        if (!f) {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          const border = (side) => (parseFloat(style[side]) || 0) * scale;
          f = {
            style,
            rect,
            painted: [snap(X(rect.left)), snap(Y(rect.top)), snap(X(rect.right)), snap(Y(rect.bottom))],
            padding: [X(rect.left) + border("borderLeftWidth"), Y(rect.top) + border("borderTopWidth"), X(rect.right) - border("borderRightWidth"), Y(rect.bottom) - border("borderBottomWidth")],
            own: el instanceof HTMLElement ? st.applied.get(el) || 0 : 0
          };
          seen.set(el, f);
        }
        return f;
      };
      const at = (list, i) => list[i] ?? 0;
      const specs = [];
      const bases = /* @__PURE__ */ new Map();
      const parts = [];
      let partial = false;
      for (const tag of tags) {
        const rect = tag.getBoundingClientRect();
        if (!(rect.width > 0 && rect.height > 0)) continue;
        const style = getComputedStyle(tag);
        const colour = parseColour(style.backgroundColor);
        if (style.visibility === "hidden" || colour && (colour[3] ?? 0) >= 1 && style.backgroundImage === "none") continue;
        const group = tag.closest("[data-je-group]");
        const slot = tag.closest(".je-tag-slot");
        if (!group || !slot || !host.contains(slot)) {
          partial = true;
          continue;
        }
        if (Number(style.opacity) < 1 || group !== tag && Number(facts(group).style.opacity) < 1) {
          partial = true;
          fns.measureAgainLater(card);
          continue;
        }
        let gridX = origin.x, gridY = origin.y, left = 0, top = 0;
        for (const el of [slot, group]) {
          const f = facts(el);
          if (!startsPixelGrid(f.style, false)) continue;
          left += snap((f.rect.left - gridX) * scale);
          top += snap((f.rect.top - gridY) * scale);
          gridX = f.rect.left;
          gridY = f.rect.top;
        }
        left += snap((rect.left - gridX) * scale);
        top += snap((rect.top - gridY) * scale);
        const width = snap(units(rect.width * scale)), height = snap(units(rect.height * scale));
        if (!(width > 0 && height > 0)) continue;
        if (left < boxLeft || top < boxTop || left + width > boxLeft + boxWidth || top + height > boxTop + boxHeight) {
          partial = true;
          continue;
        }
        const unders = [];
        let drawable = true;
        let underText = "";
        for (const el of [host, slot, group]) {
          const f = facts(el);
          if (!(at(f.painted, 2) > at(f.painted, 0) && at(f.painted, 3) > at(f.painted, 1))) continue;
          const bg = backgroundOf(f.style, f.painted.map((v, i) => v - (i % 2 ? boxTop : boxLeft)), f.own);
          if (!bg) {
            drawable = false;
            break;
          }
          if (!bg.text) continue;
          unders.push({ x: at(f.painted, 0) - boxLeft, y: at(f.painted, 1) - boxTop, width: at(f.painted, 2) - at(f.painted, 0), height: at(f.painted, 3) - at(f.painted, 1), colour: bg.colour, gradients: bg.gradients, host: el === host });
          underText += `${bg.text};`;
        }
        if (!drawable) {
          partial = true;
          continue;
        }
        const pieces = [];
        const piece = (carrier, x0, y0, x1, y1) => {
          if (!(x1 > x0 && y1 > y0)) return;
          const f = facts(carrier);
          const h = placeLayer(x0, x1, at(f.padding, 0), at(f.padding, 2)), v = placeLayer(y0, y1, at(f.padding, 1), at(f.padding, 3));
          if (!h || !v || x0 < at(f.painted, 0) || y0 < at(f.painted, 1) || x1 > at(f.painted, 2) || y1 > at(f.painted, 3)) return;
          pieces.push({ carrier, sx: x0 - left, sy: y0 - top, width: x1 - x0, height: y1 - y0, left: units(h.offset / scale), top: units(v.offset / scale), cssWidth: units(h.size / scale), cssHeight: units(v.size / scale) });
          if (!bases.has(carrier)) {
            const base = baseOf(f.style, f.own);
            if (base) bases.set(carrier, base);
          }
        };
        const inSlot = facts(slot).painted;
        const cutRight = Math.max(left, Math.min(left + width, at(inSlot, 2))), cutBottom = Math.max(top, Math.min(top + height, at(inSlot, 3)));
        piece(slot, Math.max(left, at(inSlot, 0)), Math.max(top, at(inSlot, 1)), cutRight, cutBottom);
        if (!pieces.length) {
          partial = true;
          continue;
        }
        const corners = [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius];
        if (corners.some((r) => /%|\S\s+\S/.test(String(r || "")))) {
          partial = true;
          continue;
        }
        const radii = corners.map((r) => (parseFloat(r) || 0) * scale);
        if (chipBeneath(host, slot, Number(facts(slot).style.opacity), [left, top, left + width, top + height], X, Y)) {
          partial = true;
          continue;
        }
        specs.push({ x: left - boxLeft, y: top - boxTop, width, height, radii, unders, pieces });
        parts.push([
          left - boxLeft,
          top - boxTop,
          width,
          height,
          radii.map(units).join("/"),
          underText,
          pieces.map((p) => `${p.sx},${p.sy},${p.width},${p.height},${p.left},${p.top},${p.cssWidth},${p.cssHeight}`).join(";")
        ].join(","));
      }
      if (!specs.length) return none;
      const sig = [scale, art.url, art.img ? "img" : "bg", fit.size, fit.position, baseColour || "", frac(X(boxRect.left)), frac(Y(boxRect.top)), boxWidth, boxHeight, ...parts].join("|");
      return { card, sig, job: { card, sig, key: art.url, url: art.url, img: art.img, scale, boxWidth, boxHeight, fit, base: baseColour, specs, bases, partial } };
    }
    return { read };
  }

  // client/src/features/media-tags/types/status/backdrop/painter.ts
  function createStatusTagBackdrop(JE2) {
    const st = createBackdropState();
    const fns = {};
    const { read } = createRead(st, fns);
    const drawing = createDraw(st, fns);
    let measureScheduled = false;
    let resizeTimer = 0;
    let sizes = null;
    function isSupported() {
      if (st.supported !== null) return st.supported;
      try {
        const probe = document.createElement("canvas");
        probe.width = probe.height = 2;
        const ctx = probe.getContext("2d", { willReadFrequently: true });
        st.supported = false;
        if (ctx && typeof ctx.getImageData === "function" && typeof probe.toDataURL === "function") {
          ctx.fillStyle = `rgb(${PROBE_RGB.join(", ")})`;
          ctx.fillRect(0, 0, 2, 2);
          const got = ctx.getImageData(0, 0, 1, 1).data;
          st.supported = PROBE_RGB.every((value, i) => Math.abs((got[i] ?? -1) - value) <= 1) && got[3] === 255 && probe.toDataURL("image/png").startsWith("data:image/png");
        }
      } catch {
        st.supported = false;
      }
      return st.supported;
    }
    const pixelScale = () => Math.min(MAX_SCALE, Math.max(1, window.devicePixelRatio || 1));
    function markDirty(card) {
      if (!st.active) return;
      st.dirty.add(card);
      if (measureScheduled) return;
      measureScheduled = true;
      if (typeof JE2.core?.dom?.afterNextPaint === "function") JE2.core.dom.afterNextPaint(measureDirty);
      else requestAnimationFrame(() => setTimeout(measureDirty, 0));
    }
    function watchArtwork(card, container, img) {
      if (card.container !== container) {
        card.art?.disconnect();
        card.container = container;
        if (container) {
          if (!card.art) card.art = new MutationObserver((records) => {
            if (!records.some((record) => !(record.target instanceof Element && record.target.closest(".je-tag-host")))) return;
            if (!artworkParked(card)) markDirty(card);
          });
          card.art.observe(container, { attributes: true, attributeFilter: ["style", "src", "srcset"], childList: true, subtree: true });
        }
      }
      if (card.img !== img) {
        card.img?.removeEventListener("load", card.onLoad);
        card.img = img;
        img?.addEventListener("load", card.onLoad);
      }
    }
    function artworkParked(card) {
      const kept = card.kept;
      const container = card.container instanceof HTMLElement ? card.container : null;
      if (!kept || card.moved || kept.job.img || card.sig !== kept.job.sig || !container) return false;
      const shown = /url\(["']?([^"')]+)["']?\)/.exec(container.style?.backgroundImage || "");
      return (shown ? shown[1] : container.getAttribute("data-src") || "") === kept.job.url;
    }
    function originOf(url) {
      try {
        return new URL(url, document.baseURI).origin;
      } catch {
        return "";
      }
    }
    function markUnreadable(url) {
      st.unreadable.add(url);
      if (st.unreadable.size > UNREADABLE_CAP) {
        const [oldest] = st.unreadable;
        if (oldest !== void 0) st.unreadable.delete(oldest);
      }
    }
    function measureAgainLater(card, scaled = false) {
      if (card.again) return;
      const target = card.host.closest(".card, .listItem") || card.host.parentElement;
      if (!target || typeof target.addEventListener !== "function") return;
      let timer = 0;
      const stop = () => {
        if (card.again !== stop) return;
        card.again = null;
        if (timer) clearTimeout(timer);
        for (const type of AGAIN_EVENTS) target.removeEventListener(type, again);
      };
      const again = () => {
        if (card.again !== stop) return;
        stop();
        card.moved = true;
        markDirty(card);
      };
      card.again = stop;
      for (const type of AGAIN_EVENTS) target.addEventListener(type, again, { passive: true });
      if (scaled) {
        card.holdMs = Math.min(HOLD_MAX_MS, card.holdMs ? card.holdMs * 2 : HOLD_MS);
        timer = setTimeout(again, card.holdMs);
      }
    }
    function onResize(entries) {
      for (const entry of entries) {
        const card = entry.target instanceof HTMLElement ? st.cards.get(entry.target) : void 0;
        if (!card) continue;
        card.moved = true;
        markDirty(card);
      }
    }
    function track(host) {
      if (!host) return;
      if (!st.active || st.supported === false || typeof MutationObserver !== "function") {
        setBlur(host, true);
        return;
      }
      let card = st.cards.get(host);
      if (!card) {
        const created = { host, chips: null, art: null, container: null, img: null, onLoad: () => markDirty(created), sig: "", carriers: /* @__PURE__ */ new Set(), kept: null, moved: true, on: [], latest: null, fullSig: "", again: null, live: false, resting: 0, holdMs: 0 };
        card = created;
        st.cards.set(host, card);
        st.lastTracked = performance.now();
        created.chips = new MutationObserver((records) => {
          if (records.every((record) => record.type === "attributes" && record.target === host && HOST_MARKS.has(record.attributeName || ""))) return;
          dropStale(created);
          created.moved = true;
          markDirty(created);
        });
        created.chips.observe(host, { attributes: true, childList: true, subtree: true });
        if (typeof ResizeObserver === "function") {
          if (!sizes) sizes = new ResizeObserver(onResize);
          sizes.observe(host);
        }
      }
      dropStale(card);
      if (!card.carriers.size) setBlur(host, true);
      card.moved = true;
      markDirty(card);
    }
    function dropStale(card) {
      if (!card.carriers.size) return;
      let stale = false;
      for (const carrier of card.carriers) {
        if (!carrier.isConnected || !card.host.contains(carrier) || !carrier.querySelector(`.${tagClass}`)) {
          stale = true;
          break;
        }
      }
      if (!stale) return;
      for (const carrier of card.carriers) drawing.clear(carrier);
      card.carriers.clear();
      card.on = [];
      setBlur(card.host, true);
    }
    function resume(host) {
      if (!host || !st.detached.has(host) || !host.isConnected) return;
      st.detached.delete(host);
      if (!host.querySelector(`.${tagClass}`)) {
        delete host.dataset.jeBlur;
        return;
      }
      track(host);
      try {
        JE2.core?.tagLayout?.syncFlowOf?.(host);
      } catch {
      }
    }
    function setBlur(host, on) {
      if (host.dataset.jeBlur === "1" === on) return;
      if (on) host.dataset.jeBlur = "1";
      else delete host.dataset.jeBlur;
      try {
        JE2.core?.tagLayout?.syncFlowOf?.(host);
      } catch (err) {
        console.debug(`${backdropLog} could not re-decide a card's layout`, err);
      }
    }
    function release(host) {
      const card = host ? st.cards.get(host) : void 0;
      if (!card) return;
      card.chips?.disconnect();
      card.art?.disconnect();
      card.img?.removeEventListener("load", card.onLoad);
      sizes?.unobserve(host);
      card.again?.();
      if (card.resting) clearTimeout(card.resting);
      card.resting = 0;
      card.live = false;
      st.lingering.delete(card);
      for (const carrier of card.carriers) drawing.clear(carrier);
      card.carriers.clear();
      if (host.isConnected) setBlur(host, true);
      else {
        host.dataset.jeBlur = "1";
        st.detached.add(host);
      }
      card.sig = "";
      card.on = [];
      card.latest = null;
      st.cards.delete(host);
      st.dirty.delete(card);
    }
    function measure(list) {
      const started = performance.now();
      const scale = pixelScale();
      const pass = { origins: /* @__PURE__ */ new Map(), probed: false };
      const plans = list.filter((card) => card.host.isConnected && st.cards.get(card.host) === card && !card.live).map((card) => read(card, scale, pass));
      for (const { card, sig, job, hold } of plans) {
        if (hold) {
          for (const carrier of card.carriers) drawing.clear(carrier);
          card.carriers.clear();
          card.on = [];
          setBlur(card.host, true);
          card.chips?.takeRecords();
          continue;
        }
        const on = job ? job.specs.flatMap((spec) => spec.pieces.map((p) => p.carrier)) : [];
        if (sig === card.sig && on.length === card.on.length && on.every((carrier, i) => carrier === card.on[i])) continue;
        card.sig = sig;
        card.on = on;
        card.latest = job;
        if (job && card.kept?.job.sig === sig) {
          st.counters.reused++;
          const drawn = card.kept.drawn;
          card.kept = { job, drawn };
          drawing.show(job, drawn);
          continue;
        }
        for (const carrier of card.carriers) drawing.clear(carrier);
        card.carriers.clear();
        setBlur(card.host, true);
        card.chips?.takeRecords();
        if (job && isSupported()) {
          st.waiting.push(job);
          drawing.scheduleSlice();
        }
      }
      if (st.supported === false) setActive(false);
      const spent = performance.now() - started;
      st.counters.measures++;
      st.counters.cards += plans.length;
      st.counters.measureMs += spent;
      st.counters.maxMeasureMs = Math.max(st.counters.maxMeasureMs, spent);
    }
    function measureDirty() {
      measureScheduled = false;
      for (const host of Array.from(st.cards.keys())) if (!host.isConnected) release(host);
      if (!st.active) {
        st.dirty.clear();
        return;
      }
      const started = performance.now();
      while (st.dirty.size && performance.now() - started < MEASURE_BUDGET_MS) {
        const batch = Array.from(st.dirty).slice(0, MEASURE_CARDS);
        for (const card of batch) st.dirty.delete(card);
        measure(batch);
      }
      const [next] = st.dirty;
      if (next) markDirty(next);
      st.counters.passes++;
      st.counters.maxPassMs = Math.max(st.counters.maxPassMs, performance.now() - started);
    }
    function hidesOnHover(host) {
      if (!document.body?.classList.contains("je-tags-hide-on-hover")) return false;
      const layout = host.dataset.jeLayout;
      return layout !== "summary" && layout !== "minimal";
    }
    function inUse(card) {
      try {
        const el = card.host.closest(".card, .listItem");
        return !!el && (el.matches(":focus-within") || !hidesOnHover(card.host) && el.matches(":hover"));
      } catch {
        return false;
      }
    }
    function use(card) {
      if (card.resting) clearTimeout(card.resting);
      card.resting = 0;
      st.lingering.delete(card);
      if (card.live) return;
      card.live = true;
      setBlur(card.host, true);
      for (const carrier of card.carriers) drawing.clear(carrier);
      card.carriers.clear();
      card.on = [];
      card.chips?.takeRecords();
    }
    function rest(card) {
      if (!card.live || card.resting) return;
      card.resting = setTimeout(() => {
        card.resting = 0;
        if (!card.live || st.cards.get(card.host) !== card) return;
        if (inUse(card)) {
          let over = false;
          try {
            over = !!card.host.closest(".card, .listItem")?.matches(":hover");
          } catch {
            over = false;
          }
          if (over) st.lingering.add(card);
          return;
        }
        card.live = false;
        card.moved = true;
        markDirty(card);
      }, LIVE_REST_MS);
    }
    function onUse(event) {
      const target = event.target instanceof Element ? event.target : null;
      const pointer = event.type === "pointerover";
      const el = target ? target.closest(".card, .listItem") : null;
      if (pointer) {
        for (const card2 of Array.from(st.lingering)) if (!el || !el.contains(card2.host)) {
          st.lingering.delete(card2);
          rest(card2);
        }
      }
      const host = el ? el.querySelector(".je-tag-host") : null;
      const card = host ? st.cards.get(host) : void 0;
      if (!card || !host || pointer && hidesOnHover(host)) return;
      use(card);
    }
    function onLeave(event) {
      const target = event.target instanceof Element ? event.target : null;
      const el = target ? target.closest(".card, .listItem") : null;
      const related = event.relatedTarget;
      const to = related instanceof Node ? related : null;
      if (!el || to && el.contains(to)) return;
      const host = el.querySelector(".je-tag-host");
      const card = host ? st.cards.get(host) : void 0;
      if (card) rest(card);
    }
    function refresh() {
      for (const card of st.cards.values()) {
        card.moved = true;
        markDirty(card);
      }
    }
    function onRefused(event) {
      const violation = event;
      if (!st.active || violation.disposition && violation.disposition !== "enforce" || violation.blockedURI !== "data" || !/^img-src/.test(violation.effectiveDirective || violation.violatedDirective || "")) return;
      console.warn(`${backdropLog} the page's content security policy refuses data: images; status tags keep the live backdrop filter.`);
      setActive(false);
    }
    function onWindowResize() {
      if (!st.cards.size) return;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(refresh, RESIZE_SETTLE_MS);
    }
    function listen(on) {
      if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
      const pointerOver = ["pointerover", onUse], focusIn = ["focusin", onUse];
      const pointerOut = ["pointerout", onLeave], focusOut = ["focusout", onLeave];
      if (on) {
        document.addEventListener(pointerOver[0], pointerOver[1], { passive: true });
        document.addEventListener(focusIn[0], focusIn[1]);
        document.addEventListener(pointerOut[0], pointerOut[1], { passive: true });
        document.addEventListener(focusOut[0], focusOut[1]);
        document.addEventListener("securitypolicyviolation", onRefused);
        window.addEventListener("resize", onWindowResize, { passive: true });
      } else {
        document.removeEventListener("pointerover", onUse);
        document.removeEventListener("focusin", onUse);
        document.removeEventListener("pointerout", onLeave);
        document.removeEventListener("focusout", onLeave);
        document.removeEventListener("securitypolicyviolation", onRefused);
        window.removeEventListener("resize", onWindowResize);
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = 0;
      }
    }
    function setActive(value) {
      const on = !!value;
      if (on === st.active) return;
      st.active = on;
      listen(on);
      if (on) {
        document.querySelectorAll(".je-tag-host").forEach((host) => track(host));
        return;
      }
      for (const host of Array.from(st.cards.keys())) release(host);
      sizes?.disconnect();
      sizes = null;
      st.dirty.clear();
      drawing.dropWork();
    }
    Object.assign(fns, {
      markDirty,
      watchArtwork,
      measureAgainLater,
      originOf,
      markUnreadable,
      setBlur,
      isSupported,
      setActive,
      clear: drawing.clear,
      write: drawing.write,
      show: drawing.show,
      scheduleSlice: drawing.scheduleSlice
    });
    listen(true);
    JE2.session?.onUserChange?.("status-tag-backdrop", () => {
      drawing.dropWork();
      st.unreadable.clear();
      st.tainting.clear();
      for (const card of st.cards.values()) {
        for (const carrier of card.carriers) drawing.clear(carrier);
        card.carriers.clear();
        setBlur(card.host, true);
        card.sig = "";
        card.fullSig = "";
        card.kept = null;
        card.on = [];
        card.latest = null;
      }
      refresh();
    });
    return {
      BLUR_PX,
      track,
      release,
      resume,
      refresh,
      setActive,
      isActive: () => st.active,
      /** The quiet period before pictures are painted (ms); a performance check or a test may shorten it. */
      get quietMs() {
        return st.quietMs;
      },
      set quietMs(ms) {
        st.quietMs = Math.max(0, Number(ms) || 0);
      },
      /** Timings and counts (performance checks). */
      stats: () => ({ ...st.counters, watching: st.cards.size, waiting: st.waiting.length, ready: st.ready.length, decoding: st.decoding.size, artwork: st.artwork.size, unreadable: st.unreadable.size }),
      boxSizes,
      blurRgba,
      fitImage,
      parseGradient,
      parseColour,
      splitLayers,
      snap,
      startsPixelGrid,
      placeLayer
    };
  }

  // client/src/features/media-tags/types/status/backdrop/status-tag-backdrop-entry.ts
  var JE = export5();
  var backdrop = createStatusTagBackdrop(JE);
  JE.statusTagBackdrop = backdrop;
  var waiting = /* @__PURE__ */ new Set();
  document.querySelectorAll(`.je-tag-host .${tagClass}`).forEach((tag) => {
    const host = tag.closest(".je-tag-host");
    if (host) waiting.add(host);
  });
  waiting.forEach((host) => backdrop.track(host));
})();
})();
//# sourceMappingURL=status-tag-backdrop.js.map
