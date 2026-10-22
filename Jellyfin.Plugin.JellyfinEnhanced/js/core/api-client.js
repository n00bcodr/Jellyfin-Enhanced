// @ts-check
// /js/core/api-client.js
//
// One fetch layer for every upstream the plugin talks to.
//
// The retry / dedup / concurrency / cache machinery here is the former
// jellyseerr/request-manager.js, moved into core so it is available to all
// modules (jellyseerr/request-manager.js now re-exports it as
// JE.requestManager — that surface is frozen). On top of it, JE.core.api
// exposes a generalized fetch wrapper with the MediaBrowser auth headers
// that ~35 call sites used to hand-build, plus per-request timeout support.
//
// Public surface:
//   JE.core.api.fetch(url, options)  — full-URL fetch with auth + retry/dedup/cache
//   JE.core.api.jf(path, options)    — same, path resolved via ApiClient.getUrl
//   JE.core.api.plugin(path, options)— same, targeting /JellyfinEnhanced/ endpoints
//   JE.core.api.manager              — the request manager (aliased as JE.requestManager)
//   JE.core.build                    — the server's JE build vs the one this page booted against (reload notice)
(function(JE) {
    'use strict';

    JE.core = JE.core || {};

    const logPrefix = '🪼 Jellyfin Enhanced: API Client:';

    // Configuration
    const CONFIG = {
        retry: {
            maxAttempts: 2,
            baseDelayMs: 500,
            maxDelayMs: 5000,
            jitterFactor: 0.3,
            retryableStatuses: [408, 429, 500, 502, 503, 504],
            timeoutBudgetMs: 15000
        },
        cache: {
            ttlMs: 30 * 60 * 1000, // 30 minutes - discovery data rarely changes
            maxEntries: 200
        },
        concurrency: {
            // JE's endpoints share a host with Jellyfin's own API and image
            // requests. Over HTTP/1.1 browsers open at most 6 connections per
            // host, so staying below 6 leaves sockets free for jellyfin-web.
            // Over HTTP/2 (common behind reverse proxies) there is no per-host
            // socket limit; the cap then simply bounds how much JE work competes
            // with jellyfin-web's own requests.
            maxConcurrent: 4,
            maxQueueSize: 100,
            // Decorative lane (priority: 'low'): at most this many of the
            // maxConcurrent slots, and only when no normal request is waiting,
            // so normal requests always find a slot quickly. While no normal
            // request is queued or running, the lane widens to maxConcurrent - 1,
            // which still leaves a slot free for the next normal request. Its
            // queue (current + previous-page entries) is bounded separately: past
            // the bound the oldest previous-page lookup is dropped, else the new
            // one is rejected (callers treat a failed embellishment as "render nothing").
            maxLowConcurrent: 2,
            maxLowQueueSize: 200
        }
    };

    /**
     * Scheduling options for withConcurrencyLimit. coreFetch keeps the same
     * object on its dedup entry so a normal caller joining a still-queued low
     * request can promote it (promoteRequest mutates `priority`).
     * @typedef {Object} ConcurrencyOptions
     * @property {'low'|'normal'} [priority='normal'] - 'low' = decorative lane.
     * @property {AbortSignal|null} [signal] - Leaves the queue and rejects with
     *   an AbortError as soon as it aborts while waiting for a slot.
     */

    /**
     * @typedef {Object} QueuedRequest
     * @property {ConcurrencyOptions} options
     * @property {number} enqueuedAt
     * @property {(lane: 'low'|'normal') => void} start - Hands over an already-acquired slot.
     * @property {() => void} cancel - Rejects with an AbortError (caller removes it from its queue).
     */

    // In-flight request deduplication
    /** @type {Map<string, {promise: Promise<any>, signal: AbortSignal|null, limit: ConcurrencyOptions|null}>} */
    const inFlightRequests = new Map();

    // Response cache with TTL
    /** @type {Map<string, {data: any, timestamp: number}>} */
    const responseCache = new Map();

    // AbortController management per page/context
    /** @type {Map<string, AbortController>} */
    const activeControllers = new Map();

    // Concurrency control
    let activeCount = 0;
    let activeLowCount = 0;
    /** @type {Array<QueuedRequest>} */
    const pendingQueue = [];
    /** @type {Array<QueuedRequest>} */
    const lowPriorityQueue = [];
    // Low requests queued before the last navigation: Jellyfin keeps earlier
    // views in the DOM and their cards never re-request decorations, so these
    // still run — but only once the current page's low queue is empty.
    /** @type {Array<QueuedRequest>} */
    const staleLowQueue = [];

    // Metrics (debug-gated)
    const metrics = {
        enabled: false,
        /** @type {Map<string, any>} */
        sections: new Map(),
        /** @type {Array<any>} */
        requests: [],
        /** @type {Array<{priority: 'low'|'normal', waitMs: number}>} */
        queueWaits: []
    };

    /**
     * Sleep utility with jitter support. Rejects with an AbortError as soon as
     * `signal` aborts, so an aborted request frees its slot without waiting out
     * a retry backoff.
     * @param {number} ms
     * @param {AbortSignal|null} [signal]
     * @returns {Promise<void>}
     */
    function sleep(ms, signal) {
        return new Promise((resolve, reject) => {
            if (signal && signal.aborted) {
                reject(createAbortError());
                return;
            }
            const onAbort = () => {
                clearTimeout(timer);
                reject(createAbortError());
            };
            const timer = setTimeout(() => {
                if (signal) signal.removeEventListener('abort', onAbort);
                resolve();
            }, ms);
            if (signal) signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    /**
     * Same AbortError shape fetchWithRetry throws.
     * @returns {Error}
     */
    function createAbortError() {
        const abortError = new Error('Request aborted');
        abortError.name = 'AbortError';
        return abortError;
    }

    /**
     * Calculate exponential backoff with jitter
     * @param {number} attempt
     * @param {typeof CONFIG.retry} [config]
     */
    function calculateBackoff(attempt, config = CONFIG.retry) {
        const exponentialDelay = config.baseDelayMs * Math.pow(2, attempt - 1);
        const clampedDelay = Math.min(exponentialDelay, config.maxDelayMs);
        const jitter = clampedDelay * config.jitterFactor * (Math.random() * 2 - 1);
        return Math.max(0, Math.round(clampedDelay + jitter));
    }

    /**
     * The wait a response asks for before trying again (Retry-After: seconds or an HTTP date), in
     * milliseconds, or 0 when it names none.
     * @param {Response} response
     * @returns {number}
     */
    function retryAfterMs(response) {
        const value = response?.headers?.get?.('Retry-After');
        if (!value) return 0;
        const seconds = Number(value);
        if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
        const at = Date.parse(value);
        return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
    }

    /**
     * Check if an error/status is retryable
     * @param {*} error
     * @param {number} [status]
     */
    function isRetryable(error, status) {
        // Network errors are retryable
        if (error && !status) {
            return error.name !== 'AbortError';
        }
        return CONFIG.retry.retryableStatuses.includes(/** @type {number} */ (status));
    }

    /**
     * Fetch with automatic retry and exponential backoff.
     *
     * A write (one sent with its origin, `binding`) is tried again only when no attempt can have been stored: after an
     * answer refusing it before processing (429, 503), or, for an idempotent write (PUT, DELETE, or one its caller marks
     * idempotent), after any retryable failure. A write whose attempt went out without a usable answer (a lost connection,
     * a 5xx, a timeout) is otherwise never sent blindly again: it fails as 'uncertain' (JE.core.userWrite.outcome). A retry
     * goes out only while its origin is still the signed-in session; one cancelled after an uncertain attempt stays
     * uncertain (the first attempt may have been stored), never "not sent".
     * @param {string} url
     * @param {RequestInit} [options]
     * @param {typeof CONFIG.retry} [retryConfig]
     * @param {*} [binding] - A write's origin (JE.core.userWrite.origin()): a retry goes out only while it is current.
     * @param {{idempotent?: boolean}} [write] - A write that may be sent again after an uncertain attempt.
     * @returns {Promise<Response>}
     */
    async function fetchWithRetry(url, options = {}, retryConfig = CONFIG.retry, binding = null, write = {}) {
        const startTime = performance.now();
        let lastError;
        let lastStatus;
        // Whether an attempt of this write went out and may have been stored (nothing proves it wasn't).
        let mayHaveCommitted = false;
        const method = String(options.method || 'GET').toUpperCase();
        const idempotent = write.idempotent === true || method === 'PUT' || method === 'DELETE';
        /** A write's failure, with what its attempts prove. */
        const writeFailure = error => {
            if (binding && error && typeof error === 'object') {
                if (mayHaveCommitted) {
                    error.mayHaveCommitted = true;
                    error.writeOutcome = 'uncertain';
                }
            }
            return error;
        };
        /** An answer of a write is never served from the browser's cache; a GET asked with no-store neither. */
        const fresh = method !== 'GET' && method !== 'HEAD' || options.cache === 'no-store';

        for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
            // A write's retry is sent again only while its session is still the signed-in one (the first attempt was
            // checked by JE.core.userWrite.send).
            if (binding && attempt > 1 && !JE.core.userWrite.isBound(binding)) {
                const error = /** @type {any} */ (new Error(`${url}: the session changed; this write was not sent again`));
                error.sessionChanged = true;
                error.mayHaveCommitted = mayHaveCommitted;
                error.writeOutcome = mayHaveCommitted ? 'uncertain' : 'unsent';
                JE.core.userWrite.notSent(error);
                throw error;
            }
            // Check time budget
            if (performance.now() - startTime > retryConfig.timeoutBudgetMs) {
                const error = /** @type {any} */ (new Error(`Time budget exceeded (${retryConfig.timeoutBudgetMs}ms)`));
                if (binding) error.writeOutcome = mayHaveCommitted ? 'uncertain' : 'unsent';
                throw writeFailure(error);
            }

            // Check if aborted
            if (options.signal?.aborted) {
                const abortError = /** @type {any} */ (new Error('Request aborted'));
                abortError.name = 'AbortError';
                if (binding) abortError.writeOutcome = mayHaveCommitted ? 'uncertain' : 'unsent';
                throw writeFailure(abortError);
            }

            try {
                const response = await fetch(url, options);
                // Every JE answer names the server's build: before anything about its body can fail, the page compares it
                // (an answer of a write, or one asked with no-store, is the server's now; any other is a hint, confirmed
                // by a fresh handshake).
                build.noteAnswer(response, { fresh });

                if (response.ok) {
                    if (metrics.enabled) {
                        metrics.requests.push({
                            url,
                            attempt,
                            status: response.status,
                            duration: performance.now() - startTime
                        });
                    }
                    return response;
                }

                lastStatus = response.status;
                lastError = /** @type {any} */ (new Error(`HTTP ${response.status}`));
                lastError.status = response.status;
                // A busy server (429) or a check still running (504) says when to come back.
                lastError.retryAfterMs = retryAfterMs(response);

                // Capture body so callers can read structured error details (e.g. quota messages).
                try {
                    const text = await response.clone().text();
                    if (text) {
                        lastError.responseText = text;
                        try {
                            lastError.responseJSON = JSON.parse(text);
                        } catch (e) {
                            // Body wasn't JSON (Seerr HTML challenge page, etc) — keep responseText.
                            console.debug(`${logPrefix} Error body not JSON:`, /** @type {Error} */ (e).message);
                        }
                    }
                } catch (readErr) {
                    if (/** @type {any} */ (readErr)?.name === 'AbortError') throw readErr;
                    console.debug(`${logPrefix} Failed to read error body:`, readErr);
                }

                if (binding) {
                    // A refusal before processing proves nothing was stored; any other failed answer may follow a commit.
                    const refusedBeforeProcessing = response.status === 429 || response.status === 503;
                    if (!refusedBeforeProcessing && response.status >= 500 || response.status === 408) mayHaveCommitted = true;
                    if (!isRetryable(null, response.status) || (!refusedBeforeProcessing && !idempotent)) {
                        throw writeFailure(JE.core.userWrite.classify(lastError));
                    }
                } else if (!isRetryable(null, response.status)) {
                    throw lastError;
                }
            } catch (error) {
                lastError = error;

                // An attempt that went out without an answer may have been stored.
                if (binding && !(/** @type {any} */ (error)?.status) && !(/** @type {any} */ (error)?.writeOutcome)) mayHaveCommitted = true;

                // Don't retry abort errors
                if (/** @type {any} */ (error).name === 'AbortError') {
                    throw writeFailure(error);
                }

                // Don't retry non-retryable errors (a write's uncertain attempt is retried only when idempotent)
                if (!isRetryable(error, lastStatus) || (binding && /** @type {any} */ (error)?.writeOutcome)
                    || (binding && mayHaveCommitted && !idempotent)) {
                    throw writeFailure(error);
                }
            }

            // Wait before retry (except on last attempt)
            if (attempt < retryConfig.maxAttempts) {
                // Never sooner than the server asked; a wait past the time budget is left to the caller
                // (the error carries retryAfterMs), rather than a retry the server already said is early.
                const asked = Number(lastError?.retryAfterMs) || 0;
                if (asked > 0 && performance.now() - startTime + asked > retryConfig.timeoutBudgetMs) break;
                const delay = Math.max(calculateBackoff(attempt, retryConfig), asked);
                if (metrics.enabled) {
                    console.debug(`${logPrefix} Retry ${attempt}/${retryConfig.maxAttempts} for ${url} in ${delay}ms`);
                }
                try {
                    await sleep(delay, options.signal);
                } catch (error) {
                    throw writeFailure(error);
                }
            }
        }

        // All retries exhausted
        if (metrics.enabled) {
            console.warn(`${logPrefix} All retries exhausted for ${url}`);
        }
        throw writeFailure(lastError);
    }

    /**
     * Deduplicated fetch - shares in-flight requests for identical keys
     * Note: When signal is provided, we clone the result instead of sharing
     * the promise to prevent abort propagation to other waiters
     * @param {string} key
     * @param {() => Promise<any>} fetchFn
     * @param {AbortSignal} [signal]
     * @param {ConcurrencyOptions} [limit] - The scheduling options fetchFn passes to
     *   withConcurrencyLimit; any joiner not itself low priority (including callers
     *   that omit this) promotes a queued low request.
     */
    function deduplicatedFetch(key, fetchFn, signal, limit) {
        // Share an in-flight request only with callers on the SAME abort signal
        // (or both unsignalled): a caller must never adopt a request that another
        // caller's controller can abort — or already has. The entry is dropped
        // synchronously when its signal aborts, so `abort(); fetch(sameKey)` in
        // one synchronous block starts a fresh request instead of inheriting a
        // dead promise (its `.finally` would only run a task later).
        const wanted = signal || null;
        const existing = inFlightRequests.get(key);
        if (existing && existing.signal === wanted && !(signal && signal.aborted)) {
            if (metrics.enabled) {
                console.debug(`${logPrefix} Reusing in-flight request for ${key}`);
            }
            // A decorative lookup must not make a primary caller wait in the
            // low lane for the same data.
            if (existing.limit && (!limit || limit.priority !== 'low')) {
                promoteRequest(existing.limit);
            }
            return existing.promise;
        }

        /** @type {{promise: Promise<any>, signal: AbortSignal|null, limit: ConcurrencyOptions|null}} */
        const entry = {
            promise: /** @type {Promise<any>} */ (/** @type {unknown} */ (null)),
            signal: wanted,
            limit: limit || null
        };
        const release = () => {
            // Only remove OUR entry: after a user-switch flush a new
            // request may already occupy this key — deleting it would let
            // a third caller start a duplicate fetch.
            if (inFlightRequests.get(key) === entry) {
                inFlightRequests.delete(key);
            }
        };
        const onAbort = () => release();
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        entry.promise = fetchFn().finally(() => {
            release();
            if (signal) signal.removeEventListener('abort', onAbort);
        });

        inFlightRequests.set(key, entry);
        return entry.promise;
    }

    /**
     * Low-lane cap: maxLowConcurrent, widened to maxConcurrent - 1 while no
     * normal request is queued or running (one slot always stays free for the
     * next normal arrival).
     */
    function lowLaneCap() {
        const idle = pendingQueue.length === 0 && activeCount === activeLowCount;
        const { maxConcurrent, maxLowConcurrent } = CONFIG.concurrency;
        return idle ? Math.max(maxLowConcurrent, maxConcurrent - 1) : maxLowConcurrent;
    }

    /**
     * Start queued requests while slots are free: every waiting normal request
     * first, then current-page low requests, then previous-page ones, up to the
     * low-lane cap. The slot is counted here, before the waiter resumes, so a
     * synchronous caller in the same tick cannot also claim it.
     */
    function drainQueues() {
        while (activeCount < CONFIG.concurrency.maxConcurrent) {
            /** @type {QueuedRequest|undefined} */
            let next;
            /** @type {'low'|'normal'} */
            let lane;
            if (pendingQueue.length > 0) {
                next = pendingQueue.shift();
                lane = 'normal';
            } else if (activeLowCount < lowLaneCap() && (lowPriorityQueue.length > 0 || staleLowQueue.length > 0)) {
                next = lowPriorityQueue.length > 0 ? lowPriorityQueue.shift() : staleLowQueue.shift();
                lane = 'low';
            } else {
                break;
            }
            if (!next) break;
            activeCount++;
            if (lane === 'low') activeLowCount++;
            if (metrics.enabled) {
                metrics.queueWaits.push({ priority: lane, waitMs: performance.now() - next.enqueuedAt });
            }
            next.start(lane);
        }
    }

    /**
     * Move a still-queued low request to the back of the normal queue. A low
     * request that is already running keeps its low-lane slot until it settles.
     * Promotion bypasses maxQueueSize: the request is already admitted.
     * @param {ConcurrencyOptions} options
     */
    function promoteRequest(options) {
        if (options.priority !== 'low') return;
        options.priority = 'normal';
        for (const queue of [lowPriorityQueue, staleLowQueue]) {
            const index = queue.findIndex(entry => entry.options === options);
            if (index === -1) continue;
            pendingQueue.push(queue.splice(index, 1)[0]);
            drainQueues();
            return;
        }
    }

    /**
     * Remove a waiting request from whichever queue holds it.
     * @param {QueuedRequest} entry
     */
    function removeQueued(entry) {
        for (const queue of [pendingQueue, lowPriorityQueue, staleLowQueue]) {
            const index = queue.indexOf(entry);
            if (index !== -1) queue.splice(index, 1);
        }
    }

    /**
     * Wait in the queue for the request's lane until drainQueues hands over a slot.
     * @param {ConcurrencyOptions} options
     * @returns {Promise<'low'|'normal'>} The lane whose slot was acquired.
     */
    function enqueue(options) {
        const low = options.priority === 'low';
        const queue = low ? lowPriorityQueue : pendingQueue;
        const maxSize = low ? CONFIG.concurrency.maxLowQueueSize : CONFIG.concurrency.maxQueueSize;
        const queued = low ? lowPriorityQueue.length + staleLowQueue.length : pendingQueue.length;
        if (queued >= maxSize) {
            // A full low lane makes room by dropping the oldest previous-page lookup.
            const evicted = low ? staleLowQueue.shift() : undefined;
            if (!evicted) return Promise.reject(new Error('Request queue full - too many pending requests'));
            evicted.cancel();
        }
        const signal = options.signal || null;
        return new Promise((resolve, reject) => {
            // Aborted while waiting: leave the queue now instead of holding a
            // place until a slot frees, and never consume that slot later.
            const onAbort = () => {
                removeQueued(entry);
                entry.cancel();
            };
            /** @type {QueuedRequest} */
            const entry = {
                options,
                enqueuedAt: performance.now(),
                start: (lane) => {
                    if (signal) signal.removeEventListener('abort', onAbort);
                    resolve(lane);
                },
                cancel: () => {
                    if (signal) signal.removeEventListener('abort', onAbort);
                    reject(createAbortError());
                }
            };
            if (signal) signal.addEventListener('abort', onAbort, { once: true });
            queue.push(entry);
        });
    }

    /**
     * On navigation, demote waiting low requests behind the new page's: they
     * still run (earlier views stay in the DOM and their cards never retry),
     * but only once the current low queue is empty. Running requests and the
     * normal queue (which holds any promoted request) are untouched.
     */
    function demoteLowPriorityQueue() {
        staleLowQueue.push(...lowPriorityQueue.splice(0));
    }

    /**
     * Reject every waiting request in every queue (user switch). Headers and
     * the identity epoch are captured when a request starts, so a request
     * queued as user A must never go out — writes included — as user B.
     */
    function cancelAllQueued() {
        for (const queue of [pendingQueue, lowPriorityQueue, staleLowQueue]) {
            for (const entry of queue.splice(0)) entry.cancel();
        }
    }

    /**
     * Execute function with concurrency limit
     * @param {() => Promise<any>} fn
     * @param {ConcurrencyOptions} [options] - Optional priority lane and abort signal.
     */
    async function withConcurrencyLimit(fn, options = {}) {
        if (options.signal && options.signal.aborted) throw createAbortError();

        /** @type {'low'|'normal'} */
        let lane = options.priority === 'low' ? 'low' : 'normal';
        const canStart = activeCount < CONFIG.concurrency.maxConcurrent && pendingQueue.length === 0
            && (lane === 'normal'
                || (lowPriorityQueue.length === 0 && activeLowCount < lowLaneCap()));
        if (canStart) {
            activeCount++;
            if (lane === 'low') activeLowCount++;
        } else {
            // Wait if at capacity (the slot is counted by drainQueues)
            lane = await enqueue(options);
        }

        try {
            return await fn();
        } finally {
            activeCount--;
            if (lane === 'low') activeLowCount--;
            // Release next queued request
            drainQueues();
        }
    }

    /**
     * Get AbortSignal for a page/context key
     * Automatically aborts previous request for the same key
     * @param {string} pageKey
     */
    function getAbortSignal(pageKey) {
        // Abort previous controller for this key
        const previous = activeControllers.get(pageKey);
        if (previous) {
            previous.abort();
        }

        const controller = new AbortController();
        activeControllers.set(pageKey, controller);
        return controller.signal;
    }

    /**
     * Abort all active requests (call on navigation)
     */
    function abortAllRequests() {
        for (const controller of activeControllers.values()) {
            controller.abort();
        }
        activeControllers.clear();
        inFlightRequests.clear();
    }

    /**
     * Abort request for a specific page key
     * @param {string} pageKey
     */
    function abortRequest(pageKey) {
        const controller = activeControllers.get(pageKey);
        if (controller) {
            controller.abort();
            activeControllers.delete(pageKey);
        }
    }

    /**
     * Get cached response (LRU - moves accessed entry to end)
     * @param {string} key
     */
    function getCached(key) {
        const entry = responseCache.get(key);
        if (entry && Date.now() - entry.timestamp < CONFIG.cache.ttlMs) {
            if (metrics.enabled) {
                console.debug(`${logPrefix} Cache hit for ${key}`);
            }
            // LRU: Move to end by re-inserting
            responseCache.delete(key);
            responseCache.set(key, entry);
            return entry.data;
        }
        // Remove stale entry
        if (entry) {
            responseCache.delete(key);
        }
        return null;
    }

    /**
     * Set cached response
     * @param {string} key
     * @param {*} data
     */
    function setCache(key, data) {
        // Refresh an existing key without evicting an unrelated entry. Deleting
        // first also moves the refreshed response to the newest LRU position.
        responseCache.delete(key);
        // Evict oldest entries if at capacity
        if (responseCache.size >= CONFIG.cache.maxEntries) {
            const oldestKey = responseCache.keys().next().value;
            if (oldestKey !== undefined) responseCache.delete(oldestKey);
        }

        responseCache.set(key, {
            data,
            timestamp: Date.now()
        });
    }

    /**
     * Clear all cache entries
     */
    function clearCache() {
        responseCache.clear();
    }

    /**
     * Clear cache entries matching a pattern
     * @param {string} pattern
     */
    function clearCacheMatching(pattern) {
        for (const key of responseCache.keys()) {
            if (key.includes(pattern)) {
                responseCache.delete(key);
            }
        }
    }

    // Cache keys never include a user id, but proxied responses (Seerr, tag
    // data) ARE per-user server-side — flush everything when the signed-in
    // user changes so user B never reads user A's cached responses.
    JE.session?.onUserChange('core-api', () => {
        responseCache.clear();
        inFlightRequests.clear();
        cancelAllQueued();
    });

    // Metrics API

    /**
     * Start measuring a section's load time
     * @param {string} sectionName
     */
    function startMeasurement(sectionName) {
        if (!metrics.enabled) return;
        metrics.sections.set(sectionName, {
            startTime: performance.now(),
            endTime: null,
            requestCount: 0,
            totalBytes: 0,
            cacheHits: 0
        });
    }

    /**
     * Record a request for metrics
     * @param {string} sectionName
     * @param {number} bytes
     * @param {boolean} [fromCache]
     */
    function recordRequest(sectionName, bytes, fromCache = false) {
        if (!metrics.enabled) return;
        const section = metrics.sections.get(sectionName);
        if (section) {
            section.requestCount++;
            section.totalBytes += bytes || 0;
            if (fromCache) section.cacheHits++;
        }
    }

    /**
     * End measurement and log results
     * @param {string} sectionName
     */
    function endMeasurement(sectionName) {
        if (!metrics.enabled) return;
        const section = metrics.sections.get(sectionName);
        if (section) {
            section.endTime = performance.now();
            const ttfr = section.endTime - section.startTime;
            console.debug(`[JE Metrics] ${sectionName}:`, {
                ttfr: `${ttfr.toFixed(1)}ms`,
                requests: section.requestCount,
                cacheHits: section.cacheHits,
                bytes: `${(section.totalBytes / 1024).toFixed(1)}KB`
            });
            return {
                ttfr,
                requests: section.requestCount,
                cacheHits: section.cacheHits,
                bytes: section.totalBytes
            };
        }
        return null;
    }

    /**
     * Get all metrics
     */
    function getMetrics() {
        const result = {
            /** @type {Record<string, any>} */
            sections: {},
            requests: metrics.requests.slice(),
            queueWaits: metrics.queueWaits.slice()
        };
        for (const [name, data] of metrics.sections) {
            result.sections[name] = { ...data };
        }
        return result;
    }

    /**
     * Reset metrics
     */
    function resetMetrics() {
        metrics.sections.clear();
        metrics.requests = [];
        metrics.queueWaits = [];
    }

    // Abort all in-flight requests on SPA navigation so that mid-fetch results
    // from page A don't land on page B with stale state. Modules continue to
    // do their own per-section cleanup; this is a belt-and-braces global
    // handler. Uses the deduplicated navigation pipeline, which covers
    // popstate, hashchange AND pushState transitions. Queued decorative
    // (low-priority) lookups are demoted behind the new page's, not dropped.
    JE.core.navigation.onNavigate(() => {
        try { abortAllRequests(); } catch (_) { /* never propagate */ }
        try { demoteLowPriorityQueue(); } catch (_) { /* never propagate */ }
    });

    const manager = {
        // Core functions
        fetchWithRetry,
        deduplicatedFetch,
        withConcurrencyLimit,

        // Abort management
        getAbortSignal,
        abortAllRequests,
        abortRequest,

        // Cache management
        getCached,
        setCache,
        clearCache,
        clearCacheMatching,

        // Metrics
        metrics,
        startMeasurement,
        recordRequest,
        endMeasurement,
        getMetrics,
        resetMetrics,

        // Configuration (for testing/tuning)
        CONFIG
    };

    // ── Generalized authenticated fetch ──────────────────────────────────────

    /**
     * Build the standard Jellyfin auth headers.
     * Jellyfin 12 authenticates from the Authorization header; the legacy
     * X-Emby-Token is kept for 10.11 back-compat. X-Jellyfin-User-Id lets the
     * plugin's server side resolve the acting user.
     * @returns {Record<string, string>}
     */
    function authHeaders() {
        return {
            'X-Jellyfin-User-Id': ApiClient.getCurrentUserId(),
            'Authorization': 'MediaBrowser Token="' + ApiClient.accessToken() + '"',
            'X-Emby-Token': ApiClient.accessToken(),
            'Accept': 'application/json'
        };
    }

    /**
     * @typedef {Object} CoreFetchOptions
     * @property {string} [method='GET'] - HTTP method.
     * @property {Record<string, string>} [headers] - Extra/override headers.
     * @property {*} [body] - Request body. Non-string values are JSON.stringify'd.
     * @property {AbortSignal} [signal] - Caller-supplied abort signal.
     * @property {string} [cacheKey] - Enables response cache + in-flight dedup (GET only). Plain GETs
     *   without custom headers still share concurrent identical requests.
     * @property {boolean} [skipCache=false] - Bypass the response cache.
     * @property {boolean} [skipRetry=false] - Limit to a single attempt.
     * @property {boolean} [auth=true] - Include the Jellyfin auth headers.
     * @property {number} [timeoutMs] - Per-request timeout; aborts via AbortController.
     * @property {'low'} [priority] - Decorative lookup (badges, icons, per-card tags): runs in
     *   a capped lane that yields to every waiting normal request, and is sent with
     *   fetch priority 'low'. A normal caller sharing the same in-flight request promotes it.
     * @property {*} [session] - A write's origin: JE.core.userWrite.origin() taken when the person acted (or the origin a
     *   mutation queue handed it). Required for every write: one without it is refused, never sent as whoever is signed in.
     * @property {boolean} [idempotent=false] - A write that changes nothing when sent twice (marking an item played): it may
     *   be tried again after an attempt whose answer was lost. PUT and DELETE are idempotent by definition.
     * @property {'no-store'} [cache] - Ask the network, not the browser's cache (the answer then names the build that runs).
     * @property {boolean} [readOnly=false] - A read sent as POST (its ids in the body): changes nothing on the server, so it
     *   is no person's write and needs no origin (Q-REBUILD1FIX11-4).
     */

    /**
     * Authenticated JSON fetch with retry, dedup, concurrency limiting,
     * caching and optional per-request timeout. Generalizes the former
     * jellyseerr/api.js managedFetch for all upstreams.
     * @param {string} url - Fully-qualified URL.
     * @param {CoreFetchOptions} [options]
     * @returns {Promise<any>} Parsed JSON response ({} for empty bodies).
     */
    async function coreFetch(url, options = {}) {
        const {
            method = 'GET',
            headers = {},
            body,
            signal,
            cacheKey,
            skipCache = false,
            skipRetry = false,
            auth = true,
            timeoutMs,
            priority
        } = options;

        const isGet = method.toUpperCase() === 'GET';
        // A write belongs to the origin it was made in (taken when the person acted, before any wait): it is sent through
        // JE.core.userWrite.send once the limiter grants its slot (the check runs right before its headers are built), and
        // never as anyone else. This layer never takes a session of its own for a write: without its origin it is refused.
        const write = !isGet && auth && options.readOnly !== true && !!JE.core.userWrite;
        const binding = write ? (options.session || null) : null;
        if (write && !binding) return JE.core.userWrite.send(null, () => Promise.resolve(), url);

        // One object per request: the limiter reads it while queued, and the
        // dedup entry keeps it so a normal joiner can promote a queued low request.
        /** @type {ConcurrencyOptions} */
        const limit = { priority: priority === 'low' ? 'low' : 'normal', signal: signal || null };

        // Check cache first (GET only)
        if (isGet && !skipCache && cacheKey) {
            const cached = getCached(cacheKey);
            if (cached) return cached;
        }

        const sendRequest = async () => {
            /** @type {Record<string, string>} */
            const requestHeaders = {
                ...(auth ? authHeaders() : { 'Accept': 'application/json' }),
                ...headers
            };

            /** @type {RequestInit} */
            const init = { method, headers: requestHeaders };
            if (options.cache === 'no-store') init.cache = 'no-store';
            // Fetch Priority hint; ignored by browsers without support. Read at
            // start time so a promoted request goes out at normal priority.
            if (limit.priority === 'low') init.priority = 'low';

            if (body !== undefined) {
                if (typeof body === 'string') {
                    init.body = body;
                } else {
                    init.body = JSON.stringify(body);
                    if (!requestHeaders['Content-Type']) {
                        requestHeaders['Content-Type'] = 'application/json';
                    }
                }
            }

            // Per-request timeout: abort via our own controller, chained to
            // the caller's signal so either can cancel the request.
            /** @type {*} */
            let timeoutId = null;
            /** @type {(() => void)|null} */
            let unchain = null;
            if (timeoutMs && timeoutMs > 0) {
                const controller = new AbortController();
                if (signal) {
                    if (signal.aborted) {
                        controller.abort();
                    } else {
                        const onAbort = () => controller.abort();
                        signal.addEventListener('abort', onAbort, { once: true });
                        unchain = () => signal.removeEventListener('abort', onAbort);
                    }
                }
                timeoutId = setTimeout(() => controller.abort(), timeoutMs);
                init.signal = controller.signal;
            } else if (signal) {
                init.signal = signal;
            }

            // Identity epoch at request start: a response that finishes after
            // a user switch must not repopulate the (already flushed) cache —
            // cache keys carry no user id, so a late write would hand user
            // A's response to user B.
            const requestEpoch = JE.session ? JE.session.getEpoch() : 0;

            try {
                const response = await fetchWithRetry(
                    url,
                    init,
                    skipRetry ? { ...CONFIG.retry, maxAttempts: 1 } : undefined,
                    binding,
                    { idempotent: options.idempotent === true }
                );
                // Tolerant JSON parse: some endpoints reply with empty bodies.
                const text = await response.text();
                const data = text ? JSON.parse(text) : {};

                if (isGet && cacheKey && (!JE.session || JE.session.isCurrent(requestEpoch))) {
                    setCache(cacheKey, data);
                }
                return data;
            } finally {
                if (timeoutId) clearTimeout(timeoutId);
                if (unchain) unchain();
            }
        };
        // Runs once the limiter granted the slot: a write's session is checked right then, before sendRequest builds its
        // headers (synchronously, up to the network call).
        const fetchFn = () => (binding ? JE.core.userWrite.send(binding, sendRequest, url) : sendRequest());

        // In-flight dedup OUTSIDE the concurrency limit so only the one unique
        // fetch takes a pool slot (waiters share its promise without holding
        // slots), and re-check the cache once a slot is acquired: a prefetch that
        // completed while this call queued must not be fetched a second time.
        // The caller's signal goes to the limiter too, so a request aborted while
        // queued leaves the queue at once; dedup only shares entries between
        // callers on the same signal, so that abort already applies to every sharer.
        const limitedFetch = () => withConcurrencyLimit(() => {
            if (isGet && !skipCache && cacheKey) {
                const cached = getCached(cacheKey);
                if (cached) return Promise.resolve(cached);
            }
            return fetchFn();
        }, limit);
        if (isGet && cacheKey) return deduplicatedFetch(cacheKey, limitedFetch, signal, limit);

        // Plain GETs share concurrent identical requests too, even without a cacheKey
        // (nothing is cached). Skipped when a caller customises the headers, since the
        // response could then differ for the same URL. Each caller gets its own copy so
        // one mutating its result cannot affect the others.
        if (isGet && auth && Object.keys(headers).length === 0) {
            return deduplicatedFetch(`GET ${url}`, limitedFetch, signal, limit).then((data) => structuredClone(data));
        }
        return limitedFetch();
    }

    /**
     * Fetch a Jellyfin-server path (resolved via ApiClient.getUrl).
     * @param {string} path - e.g. '/Plugins'
     * @param {CoreFetchOptions} [options]
     */
    function jf(path, options) {
        return coreFetch(ApiClient.getUrl(path), options);
    }

    /**
     * Fetch a plugin endpoint under /JellyfinEnhanced/.
     * @param {string} path - e.g. '/jellyseerr/search?query=...'
     * @param {CoreFetchOptions} [options]
     */
    function pluginFetch(path, options) {
        return jf(`/JellyfinEnhanced${path}`, options);
    }

    // ---- The server's JE build (the version handshake) ----
    // The server names its JE build (the client script's cache key: the version and the running assembly's identity, new
    // with every build) in the bootstrap and on every answer of its routes (X-JE-Build). The page knows the build of the code
    // it runs (JE.pageBuild: written into plugin.js as the server serves it, so a copy the browser kept from an earlier build
    // names that one); the server running another build than this page's scripts means the page asks the person to reload
    // (once), before a save can be lost to a contract this page doesn't know. Without a page build (a host that set none),
    // the first build the server named stands in for it (JE.serverBuild).
    //
    // Which answer proves the build that runs NOW: only one the browser could not have kept. That is an answer of a write
    // (never served from the cache), an answer asked with `cache: 'no-store'`, and an answer the server marked no-store (the
    // bootstrap, the handshake). Any other answer (Awards and MDBList ratings kept for 30 minutes, scripts, locales, data a
    // browser revalidates) may be a copy from an earlier build: its header is a hint. A hint naming another build than the
    // page's is confirmed by ONE handshake (GET /JellyfinEnhanced/version, asked with no-store; the server answers it no-store),
    // shared by every hint that arrives meanwhile; only the handshake's answer shows the notice. A handshake that fails
    // leaves it unknown: the next hint may try again, no sooner than a growing delay (30 s, doubling to 10 minutes).
    let reloadNotice = null;
    /** @type {Promise<void>|null} */
    let confirming = null;
    // The hint a handshake found to be a kept copy (the server runs this page's build): not confirmed again.
    let refutedHint = '';
    let failedConfirmations = 0;
    let nextConfirmationAt = 0;

    /** The build this page compares with: its own, else the first the server named. */
    const ownBuild = () => (typeof JE.pageBuild === 'string' && JE.pageBuild ? JE.pageBuild : JE.serverBuild);

    /** Shows the reload notice (once per page). */
    function showReloadNotice() {
        if (reloadNotice?.isConnected || !document.body) return;
        const text = (key, fallback) => {
            const value = typeof JE.t === 'function' ? JE.t(key) : '';
            return typeof value === 'string' && value && value !== key ? value : fallback;
        };
        const notice = document.createElement('div');
        notice.className = 'je-reload-notice';
        notice.setAttribute('role', 'alert');
        // Centred between 16 px gutters (fit to its text, at most 560 px): a phone gets the full width, never a half-width
        // column of one word per line.
        notice.style.cssText = 'position:fixed;left:16px;right:16px;bottom:24px;margin:0 auto;width:fit-content;z-index:100000;max-width:560px;'
            + 'box-sizing:border-box;display:flex;gap:12px;align-items:center;padding:12px 16px;border-radius:8px;'
            + 'background:#202020;color:#fff;box-shadow:0 4px 18px rgba(0,0,0,.5);font-size:14px;line-height:1.4;';
        const message = document.createElement('span');
        message.textContent = text('reload_notice_text', 'Jellyfin Enhanced was updated on the server. Reload this page so your changes keep being saved.');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = text('reload_notice_button', 'Reload');
        button.style.cssText = 'flex:none;padding:6px 14px;border:0;border-radius:4px;background:#00a4dc;color:#fff;font:inherit;cursor:pointer;';
        button.addEventListener('click', () => window.location.reload());
        notice.append(message, button);
        document.body.appendChild(notice);
        reloadNotice = notice;
        console.warn(`${logPrefix} the server runs another Jellyfin Enhanced build than this page: reload to keep saving.`);
    }

    const build = {
        /**
         * Compares the build the server runs now (an answer it could not have been kept: the bootstrap, the handshake, an
         * answer of a write) with the one this page runs.
         * @param {*} serverBuild - The server's build, as named in such an answer.
         * @returns {boolean} True when they differ (the reload notice is shown).
         */
        check(serverBuild) {
            if (typeof serverBuild !== 'string' || !serverBuild) return false;
            if (!JE.serverBuild) JE.serverBuild = serverBuild;
            if (serverBuild === ownBuild()) return false;
            showReloadNotice();
            return true;
        },
        /**
         * A build named by an answer that may be a kept copy: nothing when it is the page's own, else one shared handshake
         * confirms what runs.
         * @param {*} named
         * @returns {Promise<void>|undefined} The confirmation, when one runs.
         */
        hint(named) {
            if (typeof named !== 'string' || !named) return undefined;
            const own = ownBuild();
            if (!own || named === own || named === refutedHint) return undefined;
            return build.confirm(named);
        },
        /**
         * The handshake: what the server runs now, from an answer the browser can't have kept. One at a time; a failed one
         * is tried again only after a growing delay.
         * @param {string} [hinted] - The hint being confirmed (remembered when the server runs this page's build after all).
         * @returns {Promise<void>}
         */
        confirm(hinted) {
            if (confirming) return confirming;
            if (Date.now() < nextConfirmationAt || typeof fetch !== 'function' || typeof ApiClient === 'undefined') return Promise.resolve();
            const run = (async () => {
                try {
                    const response = await fetch(ApiClient.getUrl('/JellyfinEnhanced/version'), { cache: 'no-store', headers: { 'Accept': 'text/plain' } });
                    const named = response?.headers?.get?.('X-JE-Build');
                    if (!named) throw new Error('the handshake named no build');
                    failedConfirmations = 0;
                    nextConfirmationAt = 0;
                    if (!build.check(named) && hinted) refutedHint = hinted;
                } catch (error) {
                    failedConfirmations++;
                    nextConfirmationAt = Date.now() + Math.min(600000, 30000 * Math.pow(2, failedConfirmations - 1));
                    console.debug(`${logPrefix} build handshake failed; the server's build stays unknown for now.`, error?.message || error);
                }
            })();
            const guarded = run.finally(() => { if (confirming === guarded) confirming = null; });
            confirming = guarded;
            return guarded;
        },
        /**
         * Reads the build an answer names (a fetch Response, or the Response a failed ApiClient.ajax rejects with), before
         * its body is read. `fresh`: the answer can't be a kept copy (a write's, or one asked with no-store); an answer the
         * server marked no-store is fresh too. Anything else is a hint.
         * @param {*} response
         * @param {{fresh?: boolean}} [options]
         */
        noteAnswer(response, options = {}) {
            try {
                const named = response?.headers?.get?.('X-JE-Build');
                if (!named) return;
                const control = String(response?.headers?.get?.('Cache-Control') || '').toLowerCase();
                if (options.fresh === true || /(^|[,\s])no-store([,\s]|$)/.test(control)) build.check(named);
                else void build.hint(named);
            } catch { /* An answer without readable headers names no build. */ }
        }
    };
    JE.core.build = build;
    // A bootstrap answered before this module loaded named the server's build already.
    if (typeof JE.serverBuild === 'string' && JE.serverBuild) build.check(JE.serverBuild);

    JE.core.api = {
        fetch: coreFetch,
        jf,
        plugin: pluginFetch,
        authHeaders,
        manager
    };

    console.log('🪼 Jellyfin Enhanced: API client core initialized');

})(window.JellyfinEnhanced);
