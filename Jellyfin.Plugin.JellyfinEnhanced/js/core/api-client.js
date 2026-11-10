(() => {
"use strict";
(() => {
  // client/src/core/api/cache.ts
  function createCache(config, now) {
    const entries = /* @__PURE__ */ new Map();
    const clears = /* @__PURE__ */ new Map();
    let clock = 0, floor = 0;
    function get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      entries.delete(key);
      if (now() - entry.timestamp >= config.ttlMs) return null;
      entries.set(key, entry);
      return entry.data;
    }
    function set(key, data, requestedAt) {
      if (requestedAt !== void 0) {
        if (requestedAt < floor) return;
        for (const [pattern, at] of clears) if (at > requestedAt && key.includes(pattern)) return;
      }
      entries.delete(key);
      while (entries.size >= Math.max(1, config.maxEntries)) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
      if (config.maxEntries > 0) entries.set(key, { data, timestamp: now() });
    }
    function clear() {
      entries.clear();
      floor = ++clock;
      clears.clear();
    }
    function clearMatching(pattern) {
      clears.delete(pattern);
      clears.set(pattern, ++clock);
      if (clears.size > 32) {
        const oldest = clears.entries().next();
        if (!oldest.done) {
          clears.delete(oldest.value[0]);
          floor = oldest.value[1];
        }
      }
      for (const key of entries.keys()) if (key.includes(pattern)) entries.delete(key);
    }
    return { get, set, clear, clearMatching, stamp: () => clock };
  }

  // client/src/core/api/types.ts
  function abortError() {
    const error = new Error("Request aborted");
    error.name = "AbortError";
    return error;
  }
  function isAbort(error) {
    return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
  }
  var HttpError = class extends Error {
    constructor(status) {
      super(`HTTP ${status}`);
      this.status = status;
      this.name = "HttpError";
    }
  };
  var MutationUncertainError = class extends Error {
    constructor(cause) {
      super("Mutation outcome is unknown; verify the server state before retrying");
      this.cause = cause;
      this.name = "MutationUncertainError";
    }
  };
  var DecodeError = class extends Error {
    constructor(cause) {
      super("Response did not match the expected payload");
      this.cause = cause;
      this.name = "DecodeError";
    }
  };

  // client/src/core/api/cancellation.ts
  function cancellation(deps, signals, timeoutMs) {
    const controller = deps.controller();
    const inputs = [controller.signal];
    for (const signal2 of signals) if (signal2) inputs.push(signal2);
    const signal = deps.combineSignals(inputs);
    const timer = timeoutMs && timeoutMs > 0 ? deps.setTimer(() => controller.abort(), timeoutMs) : void 0;
    return {
      controller,
      signal,
      dispose() {
        if (timer !== void 0) deps.clearTimer(timer);
      }
    };
  }
  function abortable(promise, signal) {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(abortError());
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          if (signal.aborted) reject(abortError());
          else resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      );
    });
  }

  // client/src/core/api/dedup.ts
  function createDedup(controller, promote) {
    const entries = /* @__PURE__ */ new Map();
    function run(key, start, signal, priority) {
      if (signal.aborted) return Promise.reject(abortError());
      let entry = entries.get(key);
      if (!entry || entry.controller.signal.aborted) {
        const ctl = controller();
        const limit = { priority, signal: ctl.signal };
        const promise = start(ctl.signal, limit);
        entry = { promise, controller: ctl, limit, subscribers: 0, settled: false };
        const created = entry;
        entries.set(key, created);
        const finish = () => {
          created.settled = true;
          if (entries.get(key) === created) entries.delete(key);
        };
        void promise.then(finish, finish);
      } else if (priority !== "low") promote(entry.limit);
      const current = entry;
      current.subscribers++;
      let left = false;
      const leave = () => {
        if (left) return;
        left = true;
        signal.removeEventListener("abort", leave);
        current.subscribers--;
        if (current.subscribers === 0 && !current.settled) {
          if (entries.get(key) === current) entries.delete(key);
          current.controller.abort();
        }
      };
      signal.addEventListener("abort", leave, { once: true });
      return abortable(current.promise, signal).finally(leave);
    }
    return {
      run,
      forget(pattern = "") {
        for (const key of entries.keys()) if (key.includes(pattern)) entries.delete(key);
      }
    };
  }

  // client/src/core/api/metrics.ts
  function createMetrics(now, debug) {
    const metrics = {
      enabled: false,
      sections: /* @__PURE__ */ new Map(),
      requests: [],
      queueWaits: []
    };
    return {
      metrics,
      startMeasurement(name) {
        if (metrics.enabled) metrics.sections.set(name, { startTime: now(), endTime: null, requestCount: 0, totalBytes: 0, cacheHits: 0 });
      },
      recordRequest(name, bytes, fromCache = false) {
        const section = metrics.sections.get(name);
        if (!metrics.enabled || !section) return;
        section.requestCount++;
        section.totalBytes += bytes || 0;
        if (fromCache) section.cacheHits++;
      },
      endMeasurement(name) {
        if (!metrics.enabled) return void 0;
        const section = metrics.sections.get(name);
        if (!section) return null;
        section.endTime = now();
        const result = {
          ttfr: section.endTime - section.startTime,
          requests: section.requestCount,
          cacheHits: section.cacheHits,
          bytes: section.totalBytes
        };
        debug(`[JE Metrics] ${name}:`, { ...result, ttfr: `${result.ttfr.toFixed(1)}ms`, bytes: `${(result.bytes / 1024).toFixed(1)}KB` });
        return result;
      },
      getMetrics() {
        const sections = {};
        for (const [name, value] of metrics.sections) Object.defineProperty(sections, name, { value: { ...value }, enumerable: true });
        return { sections, requests: metrics.requests.slice(), queueWaits: metrics.queueWaits.slice() };
      },
      resetMetrics() {
        metrics.sections.clear();
        metrics.requests = [];
        metrics.queueWaits = [];
      }
    };
  }

  // client/src/core/api/retry.ts
  function backoff(attempt, config, random) {
    const delay = Math.min(config.baseDelayMs * 2 ** (attempt - 1), config.maxDelayMs);
    return Math.max(0, Math.round(delay + delay * config.jitterFactor * (random * 2 - 1)));
  }
  function sleep(deps, ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      const abort = () => {
        deps.clearTimer(timer);
        reject(abortError());
      };
      const timer = deps.setTimer(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, ms);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  async function retryFetch(deps, url, options, config, lease, record, retrySafe = false) {
    const started = deps.now();
    const safe = retrySafe || ["GET", "HEAD", "OPTIONS"].includes((options.method || "GET").toUpperCase());
    const attempts = safe ? Math.max(1, config.maxAttempts) : 1;
    const cancel = cancellation(deps, [lease.signal, options.signal], config.timeoutBudgetMs);
    const init = { ...options, signal: cancel.signal };
    let lastError = new Error("No request attempts");
    try {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        lease.throwIfStale();
        if (cancel.signal.aborted) throw abortError();
        if (deps.now() - started > config.timeoutBudgetMs) throw new Error(`Time budget exceeded (${config.timeoutBudgetMs}ms)`);
        try {
          const response = await abortable(deps.fetch(url, init), cancel.signal);
          lease.throwIfStale();
          if (response.ok) {
            record({ url, attempt, status: response.status, duration: deps.now() - started });
            return response;
          }
          const error = new HttpError(response.status);
          try {
            const text2 = await abortable(response.clone().text(), cancel.signal);
            if (text2) {
              error.responseText = text2;
              try {
                const data = JSON.parse(text2);
                error.responseJSON = data;
              } catch (parseError) {
                deps.debug("Error body not JSON:", parseError);
              }
            }
          } catch (readError) {
            if (isAbort(readError)) throw readError;
            deps.debug("Failed to read error body:", readError);
          }
          lease.throwIfStale();
          lastError = error;
          if (!config.retryableStatuses.includes(response.status) || !safe) throw error;
        } catch (error) {
          lease.throwIfStale();
          if (isAbort(error)) throw error;
          if (error instanceof HttpError && (!config.retryableStatuses.includes(error.status) || !safe)) throw error;
          if (!safe) throw new MutationUncertainError(error);
          lastError = error;
        }
        if (attempt < attempts) await sleep(deps, backoff(attempt, config, deps.random()), cancel.signal);
      }
      throw lastError;
    } finally {
      cancel.dispose();
    }
  }

  // client/src/core/api/scheduler.ts
  function createScheduler(config, now, recordWait) {
    let active = 0, activeLow = 0;
    const normal = [], low = [], stale = [];
    const queues = [normal, low, stale];
    const cap = () => normal.length === 0 && active === activeLow ? Math.max(config.maxLowConcurrent, config.maxConcurrent - 1) : config.maxLowConcurrent;
    function drain() {
      while (active < config.maxConcurrent) {
        let lane = "normal";
        let next = normal.shift();
        if (!next) {
          if (activeLow >= cap()) break;
          next = low.shift() || stale.shift();
          lane = "low";
        }
        if (!next) break;
        active++;
        if (lane === "low") activeLow++;
        recordWait(lane, now() - next.enqueuedAt);
        next.start(lane);
      }
    }
    function enqueue(options) {
      const decorative = options.priority === "low";
      const queue = decorative ? low : normal;
      const size = decorative ? low.length + stale.length : normal.length;
      if (size >= (decorative ? config.maxLowQueueSize : config.maxQueueSize)) {
        const evicted = decorative ? stale.shift() : void 0;
        if (!evicted) return Promise.reject(new Error("Request queue full - too many pending requests"));
        evicted.cancel();
      }
      return new Promise((resolve, reject) => {
        const signal = options.signal;
        const onAbort = () => {
          for (const list of queues) {
            const index = list.indexOf(entry);
            if (index >= 0) list.splice(index, 1);
          }
          entry.cancel();
          drain();
        };
        const cleanup = () => signal?.removeEventListener("abort", onAbort);
        const entry = {
          options,
          enqueuedAt: now(),
          start(lane) {
            cleanup();
            resolve(lane);
          },
          cancel() {
            cleanup();
            reject(abortError());
          }
        };
        if (signal?.aborted) {
          entry.cancel();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        queue.push(entry);
      });
    }
    async function run(fn, options = {}) {
      if (options.signal?.aborted) throw abortError();
      let lane = options.priority === "low" ? "low" : "normal";
      if (active < config.maxConcurrent && normal.length === 0 && (lane === "normal" || low.length === 0 && activeLow < cap())) {
        active++;
        if (lane === "low") activeLow++;
      } else lane = await enqueue(options);
      try {
        if (options.signal?.aborted) throw abortError();
        return await fn();
      } finally {
        active--;
        if (lane === "low") activeLow--;
        drain();
      }
    }
    function promote(options) {
      if (options.priority !== "low") return;
      options.priority = "normal";
      for (const queue of [low, stale]) {
        const index = queue.findIndex((entry2) => entry2.options === options);
        if (index < 0) continue;
        const entry = queue.splice(index, 1)[0];
        if (entry) normal.push(entry);
        drain();
        return;
      }
    }
    return {
      run,
      promote,
      demote() {
        stale.push(...low.splice(0));
      },
      cancelAll() {
        for (const queue of queues) for (const entry of queue.splice(0)) entry.cancel();
      }
    };
  }

  // client/src/core/api/api.ts
  function createApi(deps) {
    const CONFIG = {
      retry: {
        maxAttempts: 2,
        baseDelayMs: 500,
        maxDelayMs: 5e3,
        jitterFactor: 0.3,
        retryableStatuses: [408, 429, 500, 502, 503, 504],
        timeoutBudgetMs: 15e3
      },
      cache: { ttlMs: 30 * 60 * 1e3, maxEntries: 200 },
      concurrency: { maxConcurrent: 4, maxQueueSize: 100, maxLowConcurrent: 2, maxLowQueueSize: 200 }
    };
    const measurements = createMetrics(deps.now, deps.debug);
    const { metrics } = measurements;
    const scheduler = createScheduler(CONFIG.concurrency, deps.now, (priority, waitMs) => {
      if (metrics.enabled) metrics.queueWaits.push({ priority, waitMs });
    });
    const cache = createCache(CONFIG.cache, deps.wallNow);
    const dedup = createDedup(deps.controller, scheduler.promote);
    const controllers = /* @__PURE__ */ new Map();
    const legacy = /* @__PURE__ */ new Map();
    const scheduledOptions = /* @__PURE__ */ new WeakMap();
    const record = (metric) => {
      if (metrics.enabled) metrics.requests.push(metric);
    };
    function clearCacheMatching(pattern) {
      cache.clearMatching(pattern);
      dedup.forget(pattern);
      for (const key of legacy.keys()) if (key.includes(pattern)) legacy.delete(key);
    }
    function clearCache() {
      cache.clear();
      dedup.forget();
      legacy.clear();
    }
    function abortAllRequests() {
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
      dedup.forget();
      legacy.clear();
    }
    deps.onIdentityChange(() => {
      clearCache();
      scheduler.cancelAll();
      abortAllRequests();
    });
    deps.onNavigate(() => {
      abortAllRequests();
      scheduler.demote();
    });
    function getCached(key) {
      deps.acquireLease().throwIfStale();
      return cache.get(key);
    }
    function setCache(key, data, requestedAt) {
      deps.acquireLease().throwIfStale();
      cache.set(key, data, requestedAt);
    }
    async function fetchWithRetry(url, options = {}, config = CONFIG.retry) {
      const lease = deps.acquireLease();
      return retryFetch(deps, url, options, config, lease, record);
    }
    async function withConcurrencyLimit(fn, options = {}) {
      const lease = deps.acquireLease();
      const cancel = cancellation(deps, [lease.signal, options.signal]);
      const scheduled = { ...options, signal: cancel.signal };
      scheduledOptions.set(options, scheduled);
      try {
        return await scheduler.run(async () => {
          lease.throwIfStale();
          const result = await abortable(fn(), cancel.signal);
          lease.throwIfStale();
          return result;
        }, scheduled);
      } finally {
        scheduledOptions.delete(options);
        cancel.dispose();
      }
    }
    function deduplicatedFetch(key, fn, signal, limit) {
      const lease = deps.acquireLease();
      if (signal?.aborted) return Promise.reject(abortError());
      const existing = legacy.get(key);
      if (existing && existing.signal === (signal || null)) {
        if (existing.limit && limit?.priority !== "low") {
          scheduler.promote(scheduledOptions.get(existing.limit) || existing.limit);
          existing.limit.priority = "normal";
        }
        return existing.promise;
      }
      const cancel = cancellation(deps, [lease.signal, signal]);
      let pending;
      try {
        lease.throwIfStale();
        pending = fn();
      } catch (error) {
        cancel.dispose();
        return Promise.reject(error);
      }
      const promise = abortable(pending, cancel.signal).then((value) => {
        lease.throwIfStale();
        return value;
      });
      const entry = { promise, signal: signal || null, ...limit ? { limit } : {} };
      const release = () => {
        if (legacy.get(key) === entry) legacy.delete(key);
      };
      cancel.signal.addEventListener("abort", release, { once: true });
      legacy.set(key, entry);
      const cleanup = () => {
        release();
        cancel.signal.removeEventListener("abort", release);
        cancel.dispose();
      };
      void promise.then(cleanup, cleanup);
      return promise;
    }
    const manager = {
      fetchWithRetry,
      deduplicatedFetch,
      withConcurrencyLimit,
      getAbortSignal(key) {
        controllers.get(key)?.abort();
        const controller = deps.controller();
        controllers.set(key, controller);
        return controller.signal;
      },
      abortAllRequests,
      abortRequest(key) {
        controllers.get(key)?.abort();
        controllers.delete(key);
      },
      getCached,
      setCache,
      clearCache,
      clearCacheMatching,
      cacheStamp() {
        deps.acquireLease().throwIfStale();
        return cache.stamp();
      },
      ...measurements,
      CONFIG
    };
    async function request(url, options, lease) {
      lease.throwIfStale();
      const method = options.method || "GET";
      const isGet = method.toUpperCase() === "GET";
      const priority = options.priority === "low" ? "low" : "normal";
      const subscriber = cancellation(deps, [lease.signal, options.signal], options.timeoutMs);
      const requestedAt = cache.stamp();
      try {
        if (subscriber.signal.aborted) throw abortError();
        if (isGet && options.cacheKey && !options.skipCache) {
          const cached = cache.get(options.cacheKey);
          if (cached !== null) return cached;
        }
        const start = async (signal, limit) => {
          const transport = cancellation(deps, [signal, lease.signal]);
          try {
            return await scheduler.run(async () => {
              lease.throwIfStale();
              if (isGet && options.cacheKey && !options.skipCache) {
                const cached = cache.get(options.cacheKey);
                if (cached !== null) return cached;
              }
              const headers = {
                ...options.auth === false ? { Accept: "application/json" } : lease.headers,
                ...options.headers
              };
              const init = { method, headers, signal: transport.signal };
              if (limit.priority === "low") init.priority = "low";
              if (options.body !== void 0) {
                if (typeof options.body === "string") init.body = options.body;
                else {
                  const body = JSON.stringify(options.body);
                  if (body !== void 0) init.body = body;
                  if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
                }
              }
              const response = await retryFetch(
                deps,
                url,
                init,
                options.skipRetry ? { ...CONFIG.retry, maxAttempts: 1 } : CONFIG.retry,
                lease,
                record,
                options.retrySafe
              );
              const text2 = await abortable(response.text(), transport.signal);
              lease.throwIfStale();
              const data = text2 ? JSON.parse(text2) : {};
              if (isGet && options.cacheKey) cache.set(options.cacheKey, data, requestedAt);
              return data;
            }, limit);
          } finally {
            transport.dispose();
          }
        };
        let result;
        if (isGet && options.cacheKey) {
          result = await dedup.run(options.cacheKey, start, subscriber.signal, priority);
        } else if (isGet && options.auth !== false && Object.keys(options.headers || {}).length === 0) {
          result = deps.clone(await dedup.run(`GET ${url}`, start, subscriber.signal, priority));
        } else {
          result = await abortable(start(subscriber.signal, { priority, signal: subscriber.signal }), subscriber.signal);
        }
        lease.throwIfStale();
        return result;
      } finally {
        subscriber.dispose();
      }
    }
    function guarded(url, options, lease) {
      return request(url, options, lease).then((value) => {
        lease.throwIfStale();
        if (options.signal?.aborted) throw abortError();
        return value;
      });
    }
    const fetch = (url, options = {}) => guarded(url, options, deps.acquireLease());
    function jf(path, options = {}) {
      const lease = deps.acquireLease();
      return guarded(lease.resolve(path), options, lease);
    }
    const plugin = (path, options) => jf(`/JellyfinEnhanced${path}`, options);
    async function decoded(pending, decode, lease) {
      const value = await pending;
      lease.throwIfStale();
      let result;
      try {
        result = decode(value);
      } catch (error) {
        throw new DecodeError(error);
      }
      lease.throwIfStale();
      return result;
    }
    return {
      fetch,
      jf,
      plugin,
      manager,
      authHeaders: () => ({ ...deps.acquireLease().headers }),
      fetchDecoded: (url, decode, options) => {
        const lease = deps.acquireLease();
        return decoded(fetch(url, options), decode, lease);
      },
      jfDecoded: (path, decode, options) => {
        const lease = deps.acquireLease();
        return decoded(jf(path, options), decode, lease);
      },
      pluginDecoded: (path, decode, options) => {
        const lease = deps.acquireLease();
        return decoded(plugin(path, options), decode, lease);
      }
    };
  }

  // client/src/host/api-host.ts
  var text = (value) => typeof value === "string" ? value : "";
  function installApi() {
    const host = window;
    const je = host.JellyfinEnhanced;
    if (!je) throw new Error("Jellyfin Enhanced must be initialized before API");
    if (je.core?.api) return;
    let snapshot;
    let generation = new AbortController();
    const handlers = /* @__PURE__ */ new Set();
    function read() {
      const client = host.ApiClient;
      try {
        return {
          client,
          user: text(client?.getCurrentUserId()),
          token: text(client?.accessToken()),
          server: text(typeof client?.serverId === "function" ? client.serverId() : client?.serverId) || text(client?._serverInfo?.Id),
          base: client?.getUrl("/") || ""
        };
      } catch {
        return { client, user: "", token: "", server: "", base: "" };
      }
    }
    function invalidate() {
      const old = generation;
      generation = new AbortController();
      old.abort();
      for (const handler of handlers) handler();
    }
    function synchronize() {
      je?.session?.checkNow("api");
      const current = read();
      if (snapshot && (snapshot.client !== current.client || snapshot.user !== current.user || snapshot.server !== current.server || snapshot.base !== current.base || snapshot.token !== current.token)) {
        snapshot = current;
        invalidate();
      } else snapshot = current;
      return current;
    }
    je.session?.onUserChange("core-api", () => {
      snapshot = void 0;
      invalidate();
    });
    function acquireLease() {
      const current = synchronize();
      const signal = generation.signal;
      const session = je?.session?.createLease();
      function throwIfStale() {
        synchronize();
        session?.throwIfStale();
        if (signal.aborted) throw abortError();
      }
      return {
        signal,
        headers: {
          "X-Jellyfin-User-Id": current.user,
          Authorization: `MediaBrowser Token="${current.token}"`,
          "X-Emby-Token": current.token,
          Accept: "application/json"
        },
        throwIfStale,
        resolve(path) {
          throwIfStale();
          if (!current.client) throw new Error("Jellyfin ApiClient is unavailable");
          return current.client.getUrl(path);
        }
      };
    }
    const api = createApi({
      acquireLease,
      onIdentityChange: (callback) => {
        handlers.add(callback);
      },
      onNavigate: (callback) => {
        je.core?.navigation?.onNavigate(() => {
          synchronize();
          callback();
        });
      },
      fetch: (url, options) => window.fetch(url, options),
      controller: () => new AbortController(),
      combineSignals: (signals) => AbortSignal.any(signals),
      now: () => performance.now(),
      wallNow: () => Date.now(),
      random: () => Math.random(),
      setTimer: (callback, ms) => window.setTimeout(callback, ms),
      clearTimer: (timer) => window.clearTimeout(timer),
      clone: (value) => structuredClone(value),
      debug: (...values) => console.debug(...values)
    });
    je.core = je.core || {};
    je.core.api = api;
    je.requestManager = api.manager;
    window.setInterval(synchronize, 5e3);
  }

  // client/src/core/api/entry.ts
  installApi();
})();
})();
//# sourceMappingURL=api-client.js.map
