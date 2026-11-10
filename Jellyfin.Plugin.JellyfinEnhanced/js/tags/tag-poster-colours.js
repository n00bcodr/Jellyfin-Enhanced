(() => {
"use strict";
(() => {
  // client/src/features/media-tags/rules-host.ts
  function tagRulesHost() {
    const host = window;
    if (!host.JellyfinEnhanced)
      throw new Error("Jellyfin Enhanced must load before tag rules");
    return host.JellyfinEnhanced;
  }
  function posterScope(bridge2) {
    const host = window;
    const server = bridge2.session?.getServerId?.() || host.ApiClient?.serverId?.() || "";
    const user = bridge2.session?.getUserId?.() || host.ApiClient?.getCurrentUserId?.() || "";
    return server && user ? `${server}:${user}` : "";
  }

  // client/src/features/media-tags/layout/poster-colour-rules.ts
  var logPrefix = "🪼 Jellyfin Enhanced: Poster colours:";
  var ALGORITHM = 1;
  var SAMPLE_SIZE = 32;
  var MIN_ALPHA = 128;
  var NEAR_BLACK = 28;
  var NEAR_WHITE = 235;
  var GREY_CHROMA = 24;
  var MIN_SATURATION = 0.45;
  var MAX_SATURATION = 0.85;
  var MIN_LIGHTNESS = 0.2;
  var MAX_LIGHTNESS = 0.42;
  var BORDER_STEP = 0.16;
  var NEUTRAL = Object.freeze({ background: [40, 40, 40], border: [88, 88, 88], text: [255, 255, 255] });
  var SLICE_CARDS = 40;
  var MAX_DECODES = 4;
  var STEP_MIN_MS = 4;
  var SLICE_BUDGET_MS = 8;
  var MEMORY_CAP = 3e3;
  var STORE_CAP = 2e3;
  var PERSIST_DELAY_MS = 2e3;
  var SWEEP_MS = 3e3;
  var FAILED = "failed";
  var STALE = "stale";
  function dominant(data, width, height) {
    const count = new Int32Array(512);
    const sumR = new Float64Array(512), sumG = new Float64Array(512), sumB = new Float64Array(512);
    const pixels = Math.min(width * height, Math.floor(data.length / 4));
    for (let i = 0; i < pixels; i++) {
      const o = i * 4;
      const r = data[o], g = data[o + 1], b = data[o + 2], a = data[o + 3];
      if (r === void 0 || g === void 0 || b === void 0 || a === void 0 || ![r, g, b, a].every((v) => Number.isFinite(v) && v >= 0 && v <= 255))
        continue;
      if (a < MIN_ALPHA)
        continue;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      if (max < NEAR_BLACK || min > NEAR_WHITE)
        continue;
      const bin = r >> 5 << 6 | g >> 5 << 3 | b >> 5;
      count[bin] = (count[bin] || 0) + 1;
      sumR[bin] = (sumR[bin] || 0) + r;
      sumG[bin] = (sumG[bin] || 0) + g;
      sumB[bin] = (sumB[bin] || 0) + b;
    }
    let best = -1;
    let bestScore = 0;
    for (let bin = 0; bin < 512; bin++) {
      if (count[bin] === 0)
        continue;
      const cr = (bin >> 6 << 5) + 16, cg = ((bin >> 3 & 7) << 5) + 16, cb = ((bin & 7) << 5) + 16;
      const chroma = Math.max(cr, cg, cb) - Math.min(cr, cg, cb);
      const score = (count[bin] || 0) * (256 + 2 * chroma);
      if (score > bestScore) {
        bestScore = score;
        best = bin;
      }
    }
    if (best < 0)
      return null;
    const n = count[best] || 1;
    const mean = (sum) => Math.floor((2 * sum + n) / (2 * n));
    return [mean(sumR[best] || 0), mean(sumG[best] || 0), mean(sumB[best] || 0)];
  }
  function textContrast(rgb, white) {
    const channel = (v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    const l = 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
    return white ? 1.05 / (l + 0.05) : (l + 0.05) / 0.05;
  }
  function hsl(hue, saturation, lightness) {
    const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const x = c * (1 - Math.abs(hue % 2 - 1));
    const m = lightness - c / 2;
    const sextant = Math.trunc(hue);
    const [r, g, b] = sextant === 0 ? [c, x, 0] : sextant === 1 ? [x, c, 0] : sextant === 2 ? [0, c, x] : sextant === 3 ? [0, x, c] : sextant === 4 ? [x, 0, c] : [c, 0, x];
    const round = (v) => Math.min(255, Math.max(0, Math.floor(v * 255 + 0.5)));
    return [round(r + m), round(g + m), round(b + m)];
  }
  function normalise(input) {
    if (!Array.isArray(input) || input.length !== 3 || !input.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 255))
      return NEUTRAL;
    const rgb = [Number(input[0]), Number(input[1]), Number(input[2])];
    const [r, g, b] = rgb;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const chroma = max - min;
    if (chroma < GREY_CHROMA)
      return NEUTRAL;
    let hue = max === r ? (g - b) / chroma : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
    if (hue < 0)
      hue += 6;
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const saturation = clamp(chroma / (255 - Math.abs(max + min - 255)), MIN_SATURATION, MAX_SATURATION);
    const lightness = clamp((max + min) / 510, MIN_LIGHTNESS, MAX_LIGHTNESS);
    const background = hsl(hue, saturation, lightness);
    const white = textContrast(background, true) >= 4.5;
    const border = hsl(hue, saturation, clamp(lightness + (white ? BORDER_STEP : -BORDER_STEP), 0, 1));
    return { background, border, text: white ? [255, 255, 255] : [0, 0, 0] };
  }
  function coloursOf(data, width, height) {
    return normalise(dominant(data, width, height));
  }
  var css = (rgb) => `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  function keyOf(url) {
    if (!url || /^(?:data|blob):/i.test(url))
      return null;
    const m = /\/Items\/([0-9a-f-]{32,36})\/Images\/([A-Za-z]+)(?:\/(\d+))?/i.exec(url);
    if (!m?.[1] || !m[2])
      return url.split("#")[0] || null;
    const tag = /[?&]tag=([^&#]+)/i.exec(url);
    return `${m[1].replace(/-/g, "").toLowerCase()}:${m[2].toLowerCase()}:${m[3] || 0}:${tag?.[1] ? safeDecode(tag[1]) : ""}`;
  }
  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  // client/src/features/media-tags/layout/poster-colours.ts
  function errorName(error) {
    return error && typeof error === "object" && "name" in error ? error.name : void 0;
  }
  function createPosterColours(host) {
    let active = false;
    let generation = 0;
    const memory = /* @__PURE__ */ new Map();
    const queue = /* @__PURE__ */ new Set();
    let sliceScheduled = false;
    const toSample = /* @__PURE__ */ new Map();
    const sampling = /* @__PURE__ */ new Map();
    const ready = [];
    const launches = [];
    const unsaved = /* @__PURE__ */ new Map();
    let persistTimer = 0;
    let primed = null;
    let primedScope = "";
    const watches = /* @__PURE__ */ new WeakMap();
    const watchOf = /* @__PURE__ */ new WeakMap();
    const live = /* @__PURE__ */ new Set();
    const weakRef = (w) => typeof WeakRef === "function" ? new WeakRef(w) : { deref: () => w };
    let sweepTimer = 0;
    let canvas = null;
    const counters = { slices: 0, totalMs: 0, maxMs: 0, cards: 0, sampled: 0, failed: 0, fromMemory: 0, sampleMs: 0, maxSampleMs: 0, steps: 0, fallback: 0, rechecks: 0 };
    const scope = host.scope;
    function prime() {
      const s = scope();
      if (primed && primedScope === s)
        return primed;
      primedScope = s;
      const store = host.store();
      const gen = generation;
      primed = (async () => {
        if (!s || !store?.available?.() || typeof store.getPosterColours !== "function")
          return;
        try {
          const stored = await store.getPosterColours(s, ALGORITHM);
          if (gen !== generation || primedScope !== s)
            return;
          for (const [key, d] of stored)
            if (!memory.has(key))
              memory.set(key, { d });
        } catch {
        }
      })();
      return primed;
    }
    function persistSoon() {
      if (persistTimer)
        return;
      const gen = generation;
      persistTimer = setTimeout(() => {
        persistTimer = 0;
        const batches = new Map(unsaved);
        unsaved.clear();
        const store = host.store();
        if (gen !== generation || !store?.available?.() || typeof store.putPosterColours !== "function")
          return;
        const now = scope();
        for (const [s, batch] of batches) {
          if (!s || s !== now || !batch.size)
            continue;
          store.putPosterColours(s, ALGORITHM, batch, STORE_CAP).catch(() => {
          });
        }
      }, PERSIST_DELAY_MS);
    }
    function remember(key, value) {
      memory.delete(key);
      memory.set(key, value);
      if (memory.size > MEMORY_CAP)
        memory.delete(memory.keys().next().value || "");
    }
    function targetOf(host2) {
      return host2.closest(".cardBox") || host2.parentElement || host2;
    }
    function artworkOf(host2) {
      const parent = host2.parentElement;
      if (!parent)
        return null;
      const container = parent.classList.contains("cardScalable") ? parent.querySelector(".cardImageContainer, [data-je-poster-rgb]") : parent;
      if (!container)
        return null;
      const declared = container.getAttribute("data-je-poster-rgb") || container.querySelector(":scope > [data-je-poster-rgb]")?.getAttribute("data-je-poster-rgb");
      if (declared) {
        const rgb = declared.split(",").map((v) => Number(v.trim()));
        return rgb.length === 3 && rgb.every((v) => Number.isInteger(v) && v >= 0 && v <= 255) ? { key: `declared:${rgb.join(",")}`, url: "", img: null, container, rgb: [rgb[0] || 0, rgb[1] || 0, rgb[2] || 0] } : null;
      }
      const img = container.querySelector("img");
      if (img) {
        const url2 = img.currentSrc || img.src;
        const key2 = keyOf(url2);
        if (!key2)
          return { wait: container, img: null };
        return img.complete && img.naturalWidth > 0 ? { key: key2, url: url2, img, container } : { wait: container, img };
      }
      const bg = /url\(["']?([^"')]+)["']?\)/.exec(container.style?.backgroundImage || "");
      const url = bg?.[1] || "";
      const key = keyOf(url);
      return key ? { key, url, img: null, container } : { wait: container, img: null };
    }
    const idOf = (card) => card?.getAttribute("data-id") || card?.getAttribute("data-itemid") || null;
    function watch(host2, container, img, key) {
      const owner = host2.parentElement;
      if (!owner)
        return;
      let w = watches.get(owner);
      if (!w) {
        const created = { owner, host: host2, container: null, card: null, id: null, key: null, img: null, observer: null, ref: { deref: () => void 0 }, onLoad: () => changed(created) };
        w = created;
        w.ref = weakRef(w);
        watches.set(owner, w);
        live.add(w.ref);
        sweepSoon();
      }
      if (w.host !== host2)
        watchOf.delete(w.host);
      w.host = host2;
      watchOf.set(host2, w);
      w.key = key;
      if (w.container !== container) {
        w.observer?.disconnect();
        w.container = container;
        w.card = owner.closest("[data-id], [data-itemid]");
        if (!w.observer && typeof MutationObserver === "function")
          w.observer = new MutationObserver((records) => {
            if (records.some(artworkRecord) && w)
              changed(w);
          });
        w.observer?.observe(container, { attributes: true, attributeFilter: ["style", "src", "srcset"], attributeOldValue: true, childList: true, subtree: true });
        if (w.card)
          w.observer?.observe(w.card, { attributes: true, attributeFilter: ["data-id", "data-itemid"] });
      }
      w.id = idOf(w.card);
      if (w.img !== img) {
        w.img?.removeEventListener("load", w.onLoad);
        w.img = img;
        img?.addEventListener("load", w.onLoad);
      }
    }
    const backgroundOf = (style) => /url\(["']?([^"')]+)["']?\)/.exec(style || "")?.[1] || "";
    function artworkRecord(record) {
      const target = record.target;
      if (!(target instanceof Element))
        return false;
      if (target.closest?.(".je-tag-host"))
        return false;
      if (record.type === "childList") {
        const nodes = [...record.addedNodes, ...record.removedNodes];
        return nodes.some((n) => n instanceof Element && !n.classList.contains("je-tag-host"));
      }
      if (record.attributeName === "style")
        return backgroundOf(record.oldValue) !== backgroundOf(target.getAttribute("style"));
      return true;
    }
    function changed(w) {
      if (watches.get(w.owner) !== w)
        return;
      counters.rechecks++;
      const host2 = w.owner.isConnected ? w.host.parentElement === w.owner ? w.host : Array.from(w.owner.children).find((c) => c.classList.contains("je-tag-host")) : null;
      if (!(host2 instanceof HTMLElement)) {
        drop(w);
        return;
      }
      const art = artworkOf(host2);
      const key = art && "key" in art ? art.key : null;
      if (host2 !== w.host || key !== w.key || idOf(w.card) !== w.id)
        track(host2);
    }
    function drop(w) {
      w.observer?.disconnect();
      w.observer = null;
      w.img?.removeEventListener("load", w.onLoad);
      w.img = null;
      if (watches.get(w.owner) === w)
        watches.delete(w.owner);
      if (watchOf.get(w.host) === w)
        watchOf.delete(w.host);
      live.delete(w.ref);
    }
    function sweepSoon() {
      if (sweepTimer || !live.size)
        return;
      sweepTimer = setTimeout(sweep, SWEEP_MS);
    }
    function sweep() {
      sweepTimer = 0;
      for (const ref of Array.from(live)) {
        const w = ref.deref();
        if (!w)
          live.delete(ref);
        else if (!w.owner.isConnected || w.host.parentElement !== w.owner)
          changed(w);
      }
      sweepSoon();
    }
    function release(host2) {
      const w = host2 ? watchOf.get(host2) : null;
      if (w)
        drop(w);
    }
    function apply(target, key, value) {
      if (!value || value === FAILED) {
        clear(target);
        return;
      }
      const c = normalise(value.d);
      target.style.setProperty("--je-tag-bg", css(c.background));
      target.style.setProperty("--je-tag-border", css(c.border));
      target.style.setProperty("--je-tag-fg", css(c.text));
      target.dataset.jePosterColour = "1";
      target.dataset.jePosterKey = key;
    }
    function clear(target) {
      if (!target.dataset.jePosterColour && !target.dataset.jePosterKey)
        return;
      target.style.removeProperty("--je-tag-bg");
      target.style.removeProperty("--je-tag-border");
      target.style.removeProperty("--je-tag-fg");
      delete target.dataset.jePosterColour;
      delete target.dataset.jePosterKey;
    }
    function dropSamples() {
      toSample.clear();
      sampling.clear();
      launches.length = 0;
      for (const step of ready.splice(0))
        if (step.bitmap)
          "close" in step.drawable ? step.drawable.close() : void 0;
    }
    function scheduleSlice() {
      if (sliceScheduled || !active)
        return;
      sliceScheduled = true;
      if (typeof requestIdleCallback === "function")
        requestIdleCallback(runSlice, { timeout: 500 });
      else
        setTimeout(runSlice, 16);
    }
    function runSlice(deadline) {
      sliceScheduled = false;
      if (!active)
        return;
      const started = performance.now();
      const left = typeof deadline?.timeRemaining === "function" ? () => deadline.timeRemaining() : () => SLICE_BUDGET_MS - (performance.now() - started);
      const late = !deadline || !!deadline.didTimeout;
      let steps = 0;
      let drawings = 0;
      while (ready.length && (left() >= STEP_MIN_MS || late && steps === 0)) {
        if (!ready[0]?.bitmap && drawings)
          break;
        const step = ready.shift();
        if (!step)
          break;
        if (!step.bitmap)
          drawings++;
        steps++;
        finish(step.job, pixels(step));
      }
      const batch = [];
      for (const host2 of queue) {
        queue.delete(host2);
        if (host2.isConnected)
          batch.push(host2);
        if (batch.length >= SLICE_CARDS)
          break;
      }
      const reads = batch.map((host2) => ({ host: host2, target: targetOf(host2), art: artworkOf(host2) }));
      for (const { host: host2, target, art } of reads) {
        if (!art) {
          clear(target);
          continue;
        }
        if ("wait" in art) {
          clear(target);
          watch(host2, art.wait, art.img, null);
          continue;
        }
        if (art.rgb) {
          apply(target, art.key, { d: art.rgb });
          continue;
        }
        watch(host2, art.container, null, art.key);
        const known = memory.get(art.key);
        if (known !== void 0) {
          counters.fromMemory++;
          if (target.dataset.jePosterKey !== art.key || !target.dataset.jePosterColour)
            apply(target, art.key, known);
          continue;
        }
        if (target.dataset.jePosterKey && target.dataset.jePosterKey !== art.key)
          clear(target);
        const running = sampling.get(art.key);
        if (running) {
          running.hosts.add(host2);
          continue;
        }
        const job = toSample.get(art.key) || { key: art.key, url: art.url, img: art.img, hosts: /* @__PURE__ */ new Set(), gen: generation, scope: scope() };
        job.hosts.add(host2);
        if (!job.img && art.img)
          job.img = art.img;
        toSample.set(art.key, job);
      }
      let launched = 0;
      pumpSamples(() => (left() >= STEP_MIN_MS || late && !launched) && ++launched > 0);
      const spent = performance.now() - started;
      counters.slices++;
      counters.cards += batch.length;
      counters.steps += steps;
      counters.totalMs += spent;
      counters.maxMs = Math.max(counters.maxMs, spent);
      if (queue.size || ready.length || launches.length || toSample.size && sampling.size < MAX_DECODES)
        scheduleSlice();
    }
    function pumpSamples(more) {
      while (launches.length) {
        if (!more())
          return;
        const next = launches.shift();
        if (!next)
          break;
        const { job, source, fallback } = next;
        launch(job, source, fallback);
      }
      for (const [key, job] of toSample) {
        if (sampling.size >= MAX_DECODES)
          return;
        const running = sampling.get(key);
        if (running) {
          toSample.delete(key);
          job.hosts.forEach((host2) => running.hosts.add(host2));
          continue;
        }
        if (!more())
          return;
        toSample.delete(key);
        if (moved(job)) {
          job.hosts.forEach((host2) => track(host2));
          continue;
        }
        sampling.set(key, job);
        start(job);
      }
    }
    function start(job) {
      if (job.img && job.img.complete && job.img.naturalWidth > 0) {
        launch(job, job.img, false);
        return;
      }
      const image = new Image();
      image.decoding = "async";
      image.src = job.url;
      settle(job, attempt(() => image.decode()), () => launches.push({ job, source: image, fallback: false }));
    }
    function launch(job, source, fallback) {
      const width = source.naturalWidth, height = source.naturalHeight;
      if (!(width > 0 && height > 0)) {
        finish(job, FAILED);
        return;
      }
      const scale = Math.min(1, SAMPLE_SIZE / Math.max(width, height));
      const w = Math.max(1, Math.floor(width * scale + 0.5));
      const h = Math.max(1, Math.floor(height * scale + 0.5));
      if (!fallback && typeof createImageBitmap === "function") {
        settle(job, attempt(() => createImageBitmap(source, { resizeWidth: w, resizeHeight: h, resizeQuality: "medium" })), (bitmap) => ready.push({ job, drawable: bitmap, bitmap: true, w, h }), (err) => {
          if (errorName(err) === "SecurityError")
            return false;
          launches.push({ job, source, fallback: true });
          return true;
        });
        return;
      }
      if (source !== job.img || typeof source.decode !== "function") {
        ready.push({ job, drawable: source, bitmap: false, w, h });
        scheduleSlice();
        return;
      }
      settle(job, attempt(() => source.decode()), () => ready.push({ job, drawable: source, bitmap: false, w, h }));
    }
    function attempt(fn) {
      try {
        return Promise.resolve(fn());
      } catch (err) {
        return Promise.reject(err);
      }
    }
    function settle(job, promise, done, retry) {
      promise.then((value) => {
        if (!owns(job)) {
          value?.close?.();
          return;
        }
        done(value);
        scheduleSlice();
      }, (err) => {
        if (!owns(job))
          return;
        if (!retry?.(err))
          finish(job, failure(job, err));
        scheduleSlice();
      });
    }
    const owns = (job) => sampling.get(job.key) === job && job.gen === generation;
    function finish(job, d) {
      if (!owns(job))
        return;
      sampling.delete(job.key);
      if (d !== STALE) {
        remember(job.key, d === FAILED ? FAILED : { d });
        if (d === FAILED)
          counters.failed++;
        else {
          counters.sampled++;
          if (!unsaved.has(job.scope))
            unsaved.set(job.scope, /* @__PURE__ */ new Map());
          unsaved.get(job.scope)?.set(job.key, d);
          persistSoon();
        }
      }
      for (const host2 of job.hosts)
        track(host2);
    }
    const moved = (job) => !!job.img && keyOf(job.img.currentSrc || job.img.src) !== job.key;
    function failure(job, err) {
      if (moved(job))
        return STALE;
      if (errorName(err) !== "SecurityError" && errorName(err) !== "InvalidStateError" && errorName(err) !== "EncodingError") {
        console.debug(`${logPrefix} could not sample artwork`, err);
      }
      return FAILED;
    }
    function pixels(step) {
      const { job, drawable, bitmap, w, h } = step;
      if (!bitmap && drawable === job.img && (moved(job) || !job.img.complete))
        return STALE;
      const started = performance.now();
      try {
        canvas = canvas || (typeof OffscreenCanvas === "function" ? new OffscreenCanvas(w, h) : document.createElement("canvas"));
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx || !("clearRect" in ctx))
          return FAILED;
        ctx.clearRect(0, 0, w, h);
        ctx.imageSmoothingQuality = "medium";
        ctx.drawImage(drawable, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        return dominant(data, w, h);
      } catch (err) {
        return failure(job, err);
      } finally {
        if (bitmap)
          "close" in drawable ? drawable.close() : void 0;
        else
          counters.fallback++;
        const spent = performance.now() - started;
        counters.sampleMs += spent;
        counters.maxSampleMs = Math.max(counters.maxSampleMs, spent);
      }
    }
    function track(host2) {
      if (!active || !host2)
        return;
      queue.add(host2);
      scheduleSlice();
    }
    function setActive(on) {
      on = !!on;
      if (on === active)
        return;
      active = on;
      if (on) {
        prime().then(() => {
          if (!active)
            return;
          document.querySelectorAll(".je-tag-host").forEach((host2) => queue.add(host2));
          scheduleSlice();
        });
        return;
      }
      queue.clear();
      dropSamples();
      for (const ref of Array.from(live)) {
        const w = ref.deref();
        if (w)
          drop(w);
      }
      live.clear();
      clearTimeout(sweepTimer);
      sweepTimer = 0;
      document.querySelectorAll("[data-je-poster-colour], [data-je-poster-key]").forEach((el) => clear(el));
    }
    function clearMemory() {
      memory.clear();
      unsaved.clear();
      clearTimeout(persistTimer);
      persistTimer = 0;
      primed = null;
      primedScope = "";
    }
    host.onUserChange(() => {
      generation++;
      setActive(false);
      dropSamples();
      clearMemory();
    });
    return {
      ALGORITHM,
      NEUTRAL,
      dominant,
      normalise,
      coloursOf,
      keyOf,
      css,
      setActive,
      isActive: () => active,
      track,
      release,
      stats: () => ({ ...counters, queued: queue.size, waiting: toSample.size, decoding: sampling.size, remembered: memory.size, watching: live.size }),
      clearMemory
    };
  }

  // client/src/features/media-tags/layout/poster-colours-entry.ts
  var bridge = tagRulesHost();
  bridge.tagPosterColours = createPosterColours({
    scope: () => posterScope(bridge),
    store: () => bridge.tagCacheStore,
    onUserChange: (reset) => {
      bridge.session?.onUserChange?.("tag-poster-colours", reset);
    }
  });
})();
})();
//# sourceMappingURL=tag-poster-colours.js.map
