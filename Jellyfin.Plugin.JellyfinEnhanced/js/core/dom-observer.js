(() => {
"use strict";
(() => {
  // client/src/core/dom/scheduling.ts
  function createPaintQueue(clock) {
    let queue = [];
    let scheduled = false;
    return (callback) => {
      queue.push(callback);
      if (scheduled) return;
      scheduled = true;
      let done = false;
      let afterFrame;
      const run = () => {
        if (done) return;
        done = true;
        clock.clearTimeout(fallback);
        clock.cancelFrame(frame);
        if (afterFrame !== void 0) clock.clearTimeout(afterFrame);
        scheduled = false;
        const batch = queue;
        queue = [];
        for (const fn of batch) {
          try {
            fn();
          } catch (error) {
            clock.report("Error in afterNextPaint callback:", error);
          }
        }
      };
      const fallback = clock.setTimeout(run, 250);
      const frame = clock.requestFrame(() => {
        if (!done) afterFrame = clock.setTimeout(run, 0);
      });
    };
  }
  function createBodyDispatch(afterPaint, report) {
    const subscribers = /* @__PURE__ */ new Map();
    let pending = [];
    let starts = /* @__PURE__ */ new Map();
    let scheduled = false;
    let generation = 0;
    const invoke = (id, sub, records) => {
      try {
        sub.callback(records);
      } catch (error) {
        report(id, error);
      }
    };
    const reset = () => {
      generation++;
      pending = [];
      starts.clear();
      scheduled = false;
    };
    return {
      subscribers,
      reset,
      dispatch(records) {
        const epoch = generation;
        const snapshot = [...subscribers].sort((a, b) => b[1].priority - a[1].priority);
        for (const [id, sub] of snapshot) {
          if (epoch !== generation) return;
          if (subscribers.get(id) !== sub) continue;
          if (sub.priority > 0) invoke(id, sub, records);
          else {
            if (!starts.has(sub)) starts.set(sub, pending.length);
          }
        }
        if (epoch !== generation || starts.size === 0) return;
        for (const record of records) pending.push(record);
        if (scheduled) return;
        scheduled = true;
        afterPaint(() => {
          if (epoch !== generation) return;
          scheduled = false;
          const batch = pending;
          const offsets = starts;
          pending = [];
          starts = /* @__PURE__ */ new Map();
          for (const [id, sub] of [...subscribers].sort((a, b) => b[1].priority - a[1].priority)) {
            if (epoch !== generation) return;
            const start = offsets.get(sub);
            if (subscribers.get(id) === sub && start !== void 0) {
              invoke(id, sub, start === 0 ? batch : batch.slice(start));
            }
          }
        });
      }
    };
  }

  // client/src/core/dom/runtime.ts
  function createDom(host) {
    const afterNextPaint = createPaintQueue(host);
    const body = createBodyDispatch(
      afterNextPaint,
      (id, error) => host.report(`Error in body observer subscriber "${id}":`, error)
    );
    const owners = /* @__PURE__ */ new Map();
    const waits = /* @__PURE__ */ new Set();
    let observer = null;
    let waitSequence = 0;
    let teardownGeneration = 0;
    function stopIfEmpty() {
      if (body.subscribers.size !== 0) return;
      observer?.disconnect();
      observer = null;
      body.reset();
    }
    function ensureBody() {
      if (observer) return;
      const current = host.createObserver((records) => {
        if (observer !== current || !records.some(host.isStructuralChange)) return;
        body.dispatch(records);
      });
      current.observe(host.document.body, { childList: true, subtree: true });
      observer = current;
    }
    function disconnectObserver(id) {
      const owner = owners.get(id);
      if (!owner) return false;
      owner.disconnect();
      return true;
    }
    function onBodyMutation(id, callback, options) {
      disconnectObserver(id);
      const sub = { callback, priority: typeof options?.priority === "number" ? options.priority : 0 };
      const owner = { managed: false, disconnect() {
        if (owners.get(id) !== owner) return;
        owners.delete(id);
        body.subscribers.delete(id);
        stopIfEmpty();
      } };
      owners.set(id, owner);
      body.subscribers.set(id, sub);
      ensureBody();
      return { disconnect: owner.disconnect, unsubscribe: owner.disconnect };
    }
    function removeBodySubscriber(id) {
      return body.subscribers.has(id) && disconnectObserver(id);
    }
    function createObserver(id, callback, target, config) {
      disconnectObserver(id);
      if (host.isBodyTarget(target) && config.childList && config.subtree && !config.attributes && !config.attributeFilter && !config.characterData && !config.characterDataOldValue && !config.attributeOldValue) {
        const handle = onBodyMutation(id, (records) => callback(records, proxy));
        const owner2 = owners.get(id);
        if (owner2) owner2.managed = true;
        const proxy = {
          ...handle,
          observe() {
          },
          takeRecords: () => []
        };
        return proxy;
      }
      const native = host.createObserver((records) => {
        if (owners.get(id) === owner) callback(records, native);
      });
      const disconnectNative = native.disconnect.bind(native);
      const observeNative = native.observe.bind(native);
      const owner = { managed: true, disconnect() {
        disconnectNative();
        if (owners.get(id) === owner) owners.delete(id);
      } };
      observeNative(target, config);
      owners.set(id, owner);
      native.disconnect = owner.disconnect;
      native.observe = (node, options) => {
        observeNative(node, options);
        if (owners.get(id) !== owner) {
          disconnectObserver(id);
          owners.set(id, owner);
        }
      };
      return native;
    }
    function disconnectAllObservers() {
      teardownGeneration++;
      for (const owner of [...owners.values()]) owner.disconnect();
      stopIfEmpty();
      for (const cancel of [...waits]) cancel();
    }
    function waitForElement(selector, options = {}) {
      const opts = typeof options === "number" ? { timeout: options } : options ?? {};
      const root = opts.root ?? host.document;
      let warned = false;
      const find = () => {
        if (!opts.predicate) return root.querySelector(selector);
        for (const element of Array.from(root.querySelectorAll(selector))) {
          try {
            if (opts.predicate(element)) return element;
          } catch (error) {
            if (!warned) {
              warned = true;
              host.warn(`waitForElement predicate threw for ${selector}:`, error);
            }
          }
        }
        return null;
      };
      return new Promise((resolve) => {
        if (opts.signal?.aborted) {
          resolve(null);
          return;
        }
        const generation = teardownGeneration;
        const existing = find();
        if (opts.signal?.aborted || generation !== teardownGeneration) {
          resolve(null);
          return;
        }
        if (existing) {
          resolve(existing);
          return;
        }
        let timer;
        let settled = false;
        let handle;
        const finish = (element) => {
          if (settled) return;
          settled = true;
          if (timer !== void 0) host.clearTimeout(timer);
          handle?.unsubscribe();
          waits.delete(cancel);
          opts.signal?.removeEventListener("abort", cancel);
          resolve(element);
        };
        const cancel = () => finish(null);
        waits.add(cancel);
        handle = onBodyMutation(`wait-${selector}-${++waitSequence}`, () => {
          const element = find();
          if (element) finish(element);
        });
        opts.signal?.addEventListener("abort", cancel, { once: true });
        timer = host.setTimeout(() => {
          if (!opts.quiet) host.warn(`Timeout waiting for element: ${selector}`);
          finish(null);
        }, opts.timeout ?? 1e4);
      });
    }
    host.onUnload(disconnectAllObservers);
    return {
      onBodyMutation,
      removeBodySubscriber,
      createObserver,
      disconnectObserver,
      disconnectAllObservers,
      waitForElement,
      afterNextPaint,
      getObserverCount: () => [...owners.values()].filter((owner) => owner.managed).length,
      getBodySubscriberCount: () => body.subscribers.size
    };
  }

  // client/src/host/dom-host.ts
  function domBridge() {
    const host = window;
    if (!host.JellyfinEnhanced) throw new Error("Jellyfin Enhanced must be initialized before DOM core");
    return host.JellyfinEnhanced;
  }
  function browserDomHost() {
    const noise = ".osdPositionText, .osdDurationText, .startTimeText, .endTimeText, .endsAtText, .videoSubtitlesInner, .videoSecondarySubtitlesInner";
    return {
      document,
      createObserver: (callback) => new MutationObserver(callback),
      isStructuralChange: (record) => (record.addedNodes.length > 0 || record.removedNodes.length > 0) && !(record.target instanceof Element && record.target.closest(noise)),
      isBodyTarget: (node) => node === document.body || node === document.documentElement || node === document,
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeout: (id) => window.clearTimeout(id),
      requestFrame: (callback) => window.requestAnimationFrame(callback),
      cancelFrame: (id) => window.cancelAnimationFrame(id),
      onUnload: (callback) => window.addEventListener("beforeunload", callback),
      report: (context, error) => console.error(`🪼 Jellyfin Enhanced: ${context}`, error),
      warn: (context, error) => console.warn(`🪼 Jellyfin Enhanced: ${context}`, error)
    };
  }

  // client/src/core/dom/entry.ts
  var bridge = domBridge();
  var core = bridge.core ?? (bridge.core = {});
  core.dom ?? (core.dom = createDom(browserDomHost()));
})();
})();
//# sourceMappingURL=dom-observer.js.map
