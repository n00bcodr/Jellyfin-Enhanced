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
//   JE.core.api.session()            — the signed-in session, for a request sent later (see below)
//   JE.core.api.manager              — the request manager (aliased as JE.requestManager)
//
// Bound requests (deferred work: retries, re-reads, queued writes, action-bar operations). A request made after
// an await, a timer or a queue wait carries the session that asked for it, and optionally its owner's predicate:
//   const session = JE.core.api.session();                // or JE.createSessionAction().session
//   JE.core.api.plugin(path, { bound: { session, current: () => owner.isLive } });
//   // shorthand: JE.core.api.plugin(path, { bound: action.bound(() => owner.isLive) })
// The transport checks both immediately before the bytes go out (after the queue releases it, after whatever the
// caller awaited first, and before every retry attempt) and sends with that session's own credentials; when the
// session is no longer the signed-in one, or current() is not true, it rejects with an AbortError and sends nothing.
// The answer is published only while both still hold. A call without `bound` behaves exactly as before.
// The binding is part of the request's identity: de-duplication and the response cache key on it (its session and its
// owner's predicate, by object identity), so a bound request never shares an in-flight request or a cached answer with
// another binding or with an unbound caller, and one binding ending (or its caller aborting) cancels only its own request.
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
    let presentationGeneration = 0;
    let requestIdentity = null;
    /** Invalidates personalized reads without cancelling writes or starting a retry loop. */
    function presentationChanged() {
        presentationGeneration++;
        responseCache.clear();
        inFlightRequests.clear();
    }
    window.addEventListener('je-spoiler-policy-changed', presentationChanged);
    window.addEventListener('je-hidden-content-changed', presentationChanged);

    // Response cache with TTL
    /** @type {Map<string, {data: any, timestamp: number}>} */
    const responseCache = new Map();

    // Only answers that are the same for every person are kept (awards, MDBList ratings, the DoesTheDogDie catalog).
    // Everything else the server projects for the person asking: the Seerr and TMDB proxies and watch providers apply
    // their parental limits and Seerr account, so a restriction must apply to the next request, not after the TTL.
    // Those keys still share a request already in flight; nothing is kept once it settles.
    const SHARED_CACHE_PREFIXES = Object.freeze(['awards:', 'mdblist-ratings:', 'ddd:']);

    /**
     * True when a cache key's answer is the same for everyone (see SHARED_CACHE_PREFIXES).
     * @param {string} key - Cache key.
     * @returns {boolean} Whether it may be kept.
     */
    function isSharedKey(key) {
        return typeof key === 'string' && SHARED_CACHE_PREFIXES.some(prefix => key.startsWith(prefix));
    }

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

    // Write outcomes (D46S2 audit S3): a bound write that was never sent (its binding ended first) is UNSENT; one the
    // server answered after its owner ended is ACCEPTED (the AbortError carries the answer, so the caller reconciles
    // its session's state from the server without any page effect); otherwise it answered (or failed) normally.
    /** @param {*} data @param {boolean} sessionChanged @returns {Error} */
    function createAcceptedAbort(data, sessionChanged) {
        const error = /** @type {any} */ (createAbortError());
        error.jeOutcome = 'accepted';
        error.jeAnswer = data;
        error.jeSessionChanged = sessionChanged;
        return error;
    }
    /** @returns {Error} */
    function createUnsentAbort() {
        const error = /** @type {any} */ (createAbortError());
        error.jeOutcome = 'unsent';
        return error;
    }
    /**
     * The outcome of a write's error: 'unsent' (never sent), 'accepted' (answered after its owner ended; `answer`), or
     * 'failed' (anything else).
     * @param {*} error
     * @returns {{outcome: 'unsent'|'accepted'|'failed', answer?: *, sessionChanged?: boolean}}
     */
    function writeOutcome(error) {
        if (error?.jeOutcome === 'accepted') return { outcome: 'accepted', answer: error.jeAnswer, sessionChanged: !!error.jeSessionChanged };
        if (error?.jeOutcome === 'unsent' || (error?.name === 'AbortError' && error?.jeSent !== true)) return { outcome: 'unsent' };
        return { outcome: 'failed' };
    }

    // Read freshness (D46S2-R10-9, audit S4): each resource family a title action writes has a write epoch, moved on when
    // a write of it is sent and again when it is answered. A read's de-duplication and cache keys carry the epoch it
    // started in, so a read that starts after a write never joins (or answers from) one that started before it.
    /** @type {Map<string, number>} */
    const writeEpochs = new Map();
    // Read-only POSTs (they change nothing) do not move an epoch.
    const READ_POSTS = /\/JellyfinEnhanced\/arr\/calendar\/user-data(?:\?|$)/;
    /** @param {string} url @returns {string} The family a request belongs to ('' when untracked). */
    function familyOf(url) {
        const m = /\/JellyfinEnhanced\/(jellyseerr|acquire|arr|spoiler-blur)(?:\/|\?|$)/.exec(String(url || ''));
        return m ? m[1] : '';
    }
    /** @param {string} family */
    function bumpEpoch(family) {
        if (family) writeEpochs.set(family, (writeEpochs.get(family) || 0) + 1);
    }
    // The title-action write endpoints (D46S2-R10-1): a write there goes out only with an owner token's binding (the
    // Seerr request and issue, Follow and Remind; every caller passes one). JE mode's own asks and searches carry their
    // owner's binding from every title action; its library pages still send session-guarded writes of their own.
    const OWNED_WRITES = /\/JellyfinEnhanced\/(?:jellyseerr\/(?:request|issue)|acquire\/(?:follows|remind))(?:\?|$)/;

    /**
     * The abort of a read that started under an older Hidden Content / Spoiler Guard policy. Only this abort may be
     * asked again, and only by the same session that started it (see isPresentationAbort).
     * @returns {DOMException}
     */
    function createPresentationAbort() {
        const abortError = new DOMException('Presentation policy changed', 'AbortError');
        Object.defineProperty(abortError, 'presentationChanged', { value: true });
        return abortError;
    }

    /**
     * Whether an error is a privacy-policy abort (a session change, navigation or caller abort is not).
     * @param {*} error
     * @returns {boolean}
     */
    function isPresentationAbort(error) {
        return error?.name === 'AbortError' && error.presentationChanged === true;
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
     * Fetch with automatic retry and exponential backoff
     * @param {string} url
     * @param {RequestInit} [options]
     * @param {typeof CONFIG.retry} [retryConfig]
     * @param {() => void} [assertSession] Submit-time identity check, including every retry.
     * @param {boolean} [acceptHttpErrors=false] Return HTTP errors to status-preserving callers.
     * @returns {Promise<Response>}
     */
    async function fetchWithRetry(url, options = {}, retryConfig = CONFIG.retry, assertSession = captureSession(), acceptHttpErrors = false, onSend = null) {
        const startTime = performance.now();
        let lastError;
        let lastStatus;

        for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
            // Check time budget
            if (performance.now() - startTime > retryConfig.timeoutBudgetMs) {
                throw new Error(`Time budget exceeded (${retryConfig.timeoutBudgetMs}ms)`);
            }

            // Check if aborted
            if (options.signal?.aborted) {
                const abortError = new Error('Request aborted');
                abortError.name = 'AbortError';
                throw abortError;
            }

            try {
                assertSession();
                if (onSend) onSend();
                const response = await fetch(url, options);
                // Every JE answer names the server's build: another one than this page booted against asks for a reload.
                build.noteAnswer(response);
                assertSession();
                // An answer of JE's API carries the person's revisions (core/access-revision.js), refusals included.
                JE.core?.revision?.noteResponse(response);

                if (response.ok || acceptHttpErrors) {
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
                    assertSession();
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

                if (!isRetryable(null, response.status)) {
                    throw lastError;
                }
            } catch (error) {
                assertSession();
                lastError = error;

                // Don't retry abort errors
                if (/** @type {any} */ (error).name === 'AbortError') {
                    throw error;
                }

                // Don't retry non-retryable errors
                if (!isRetryable(error, lastStatus)) {
                    throw error;
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
                await sleep(delay, options.signal);
            }
        }

        // All retries exhausted
        if (metrics.enabled) {
            console.warn(`${logPrefix} All retries exhausted for ${url}`);
        }
        throw lastError;
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
     * Reject every waiting request in every queue on a user switch. Released
     * entries are checked again against their submitting identity before auth
     * headers are constructed, so they cannot escape cancellation as user B.
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
        if (!isSharedKey(key)) return null;
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
        // A per-person answer is never kept (it would outlive a change to the person's access).
        if (!isSharedKey(key)) return;
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
        isSharedKey,
        clearCache,
        clearCacheMatching,
        invalidatePresentation: presentationChanged,
        getPresentationGeneration: () => presentationGeneration,

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
     * @typedef {Object} RequestSession
     * @property {string} userId
     * @property {string} serverId
     * @property {string} token
     * @property {*} epoch
     * @property {() => boolean} current - Whether this is still the signed-in session (identity and epoch).
     */

    /**
     * The signed-in session, captured now, for a request sent later.
     * @returns {RequestSession}
     */
    function session() {
        const userId = ApiClient.getCurrentUserId();
        const epoch = JE.session?.getEpoch?.();
        const server = () => typeof ApiClient.serverId === 'function' ? ApiClient.serverId() : ApiClient.serverId;
        const serverId = server();
        const token = ApiClient.accessToken();
        return Object.freeze({
            userId, serverId, token, epoch,
            current: () => ApiClient.getCurrentUserId() === userId && server() === serverId
                && ApiClient.accessToken() === token && JE.session?.isCurrent?.(epoch) !== false
        });
    }

    /**
     * The one bound-request check: the request's own session must still be the signed-in one and its owner's
     * current() (when given) must be true. Used as the request's session assertion, so the transport runs it
     * immediately before every send and again before the answer is published.
     * @param {{session: RequestSession, current?: () => boolean}} bound
     * @returns {(() => void) & {userId: string, token: string}}
     */
    function bindRequest(bound) {
        const owner = bound?.session;
        if (!owner || typeof owner.current !== 'function') throw new TypeError('A bound request needs the session that asked for it');
        return Object.assign(() => {
            if (!owner.current() || (bound.current && bound.current() !== true)) throw createAbortError();
        }, { userId: owner.userId, token: owner.token });
    }

    /** @type {WeakMap<object, number>} */
    const bindingIds = new WeakMap();
    let nextBindingId = 1;
    /** @param {object} value */
    function idOf(value) {
        let id = bindingIds.get(value);
        if (!id) {
            id = nextBindingId++;
            bindingIds.set(value, id);
        }
        return id;
    }

    /**
     * The request-identity scope of a binding: its session and its owner's predicate (each by object identity), or ''
     * for an unbound call. Dedup and cache keys are prefixed with it, so they never match across bindings.
     * @param {{session: RequestSession, current?: () => boolean}|undefined} bound
     */
    function bindingScope(bound) {
        return bound ? `\u0000bound:${idOf(bound.session)}:${bound.current ? idOf(bound.current) : 0}\u0000` : '';
    }

    /** Captures the submitting identity, including switches before the session hook observes them. */
    function captureSession() {
        const userId = ApiClient.getCurrentUserId();
        const epoch = JE.session?.getEpoch?.();
        const server = () => typeof ApiClient.serverId === 'function' ? ApiClient.serverId() : ApiClient.serverId;
        const serverId = server();
        const token = ApiClient.accessToken();
        if (requestIdentity && (requestIdentity.userId !== userId || requestIdentity.serverId !== serverId
            || requestIdentity.token !== token || requestIdentity.epoch !== epoch)) {
            responseCache.clear();
            inFlightRequests.clear();
        }
        requestIdentity = { userId, serverId, token, epoch };
        return Object.assign(() => {
            if (ApiClient.getCurrentUserId() !== userId || server() !== serverId
                || ApiClient.accessToken() !== token || JE.session?.isCurrent?.(epoch) === false) {
                throw createAbortError();
            }
        }, { userId, token });
    }

    /**
     * Build the standard Jellyfin auth headers.
     * Jellyfin 12 authenticates from the Authorization header; the legacy
     * X-Emby-Token is kept for 10.11 back-compat. X-Jellyfin-User-Id lets the
     * plugin's server side resolve the acting user.
     * @param {{userId: string, token: string}} [session] Submission snapshot.
     * @returns {Record<string, string>}
     */
    function authHeaders(session = captureSession()) {
        return {
            'X-Jellyfin-User-Id': session.userId,
            'Authorization': 'MediaBrowser Token="' + session.token + '"',
            'X-Emby-Token': session.token,
            'Accept': 'application/json'
        };
    }

    /**
     * @typedef {Object} CoreFetchOptions
     * @property {'json'|'status'} [responseMode='json'] - Status mode returns {status, body, retryAfterMs?} for every HTTP answer, without retries, dedup or caching.
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
     * @property {{session: RequestSession, current?: () => boolean}} [bound] - Deferred work: the session that
     *   asked (and its owner's predicate). Checked immediately before every send; otherwise AbortError, nothing sent.
     *   Part of the request's identity: de-duplication and caching never cross bindings or unbound callers.
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
            responseMode = 'json',
            headers = {},
            body,
            signal,
            cacheKey,
            skipCache = false,
            skipRetry = false,
            auth = true,
            timeoutMs,
            priority,
            bound
        } = options;

        const isWrite = !/^(GET|HEAD)$/i.test(method);
        // A title-action write goes out only with an owner token's binding (D46S2-R10-1): one without (a planted or
        // dropped owner) is refused before any byte goes out.
        if (isWrite && OWNED_WRITES.test(url) && !(bound && JE.isOwnerToken?.(bound.token))) {
            const message = `Jellyfin Enhanced: ${method} ${url} was sent without its owner's binding`;
            if (JE.strictOwners === true) throw new Error(message);
            if (JE.strictOwners === 'record') (JE.refusals = JE.refusals || []).push(message); else console.error(message);
            throw createUnsentAbort();
        }
        // A write without its binding while an operation acts (its press, runner or publication callback) dropped that
        // operation's owner: refused at the send, before any byte goes out (D46S2-R9-4).
        if (!bound && isWrite && JE.refuseUnboundWrite?.(`${method} ${url}`)) throw createUnsentAbort();
        // A bound request is checked against its own session before anything else (it may have been made after
        // another account signed in); the live identity is then recorded as for any request.
        const boundSession = bound ? bindRequest(bound) : null;
        if (boundSession) {
            try { boundSession(); } catch (error) { throw isWrite ? createUnsentAbort() : error; }
        }
        const live = captureSession();
        // A write: once sent, its owner ending no longer aborts it midway (it is accepted, see writeOutcome).
        let sent = false;
        const assertSession = !isWrite || !boundSession ? (boundSession || live)
            : Object.assign(() => { if (!sent) boundSession(); else live(); }, { userId: boundSession.userId, token: boundSession.token });
        const family = READ_POSTS.test(url) ? '' : familyOf(url);
        // Dedup and cache keys of a bound request are its binding's own, and a read's carry its family's write epoch.
        const scope = bindingScope(bound) + (family && !isWrite ? `\u0000epoch:${family}:${writeEpochs.get(family) || 0}\u0000` : '');
        const onSend = isWrite ? () => { if (!sent) { sent = true; bumpEpoch(family); } } : null;
        const withStatus = responseMode === 'status';
        const isGet = method.toUpperCase() === 'GET';
        const presentation = presentationGeneration;
        const sensitive = isGet && /(?:JellyfinEnhanced\/(?:native-details|jellyseerr|acquire|arr|tmdb|awards|mdblist-ratings|reviews|activity)|\/Items(?:\/|\?))/.test(url);
        /** A response started under a previous policy cannot repopulate a feed or its cache. */
        function assertPresentation() {
            if (sensitive && presentation !== presentationGeneration) throw createPresentationAbort();
        }

        // One object per request: the limiter reads it while queued, and the
        // dedup entry keeps it so a normal joiner can promote a queued low request.
        /** @type {ConcurrencyOptions} */
        const limit = { priority: priority === 'low' ? 'low' : 'normal', signal: signal || null };

        // Check cache first (GET only)
        if (isGet && !withStatus && !skipCache && cacheKey) {
            const cached = getCached(scope + cacheKey);
            if (cached) return cached;
        }

        const fetchFn = async () => {
            assertPresentation();
            assertSession();
            /** @type {Record<string, string>} */
            const requestHeaders = {
                ...(auth ? authHeaders(assertSession) : { 'Accept': 'application/json' }),
                ...headers
            };

            /** @type {RequestInit} */
            const init = { method, headers: requestHeaders };
            // Earlier unguarded responses may still be fresh in the browser's HTTP cache.
            if (sensitive) init.cache = 'no-store';
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

            try {
                const response = await fetchWithRetry(
                    url,
                    init,
                    (skipRetry || withStatus) ? { ...CONFIG.retry, maxAttempts: 1 } : undefined,
                    assertSession,
                    withStatus,
                    onSend
                );
                assertSession();
                // Tolerant JSON parse: some endpoints reply with empty bodies.
                const text = await response.text();
                assertSession();
                assertPresentation();
                let data;
                if (withStatus) {
                    try { data = text ? JSON.parse(text) : null; }
                    catch (_) { data = null; }
                } else {
                    data = text ? JSON.parse(text) : {};
                }
                assertPresentation();
                if (withStatus) {
                    const retryAfter = retryAfterMs(response);
                    return { status: response.status, body: data, ...(retryAfter > 0 ? { retryAfterMs: retryAfter } : {}) };
                }

                if (isGet && cacheKey) setCache(scope + cacheKey, data);
                return data;
            } catch (error) {
                assertSession();
                assertPresentation();
                if (sent && error && typeof error === 'object') /** @type {any} */ (error).jeSent = true;
                throw error;
            } finally {
                if (timeoutId) clearTimeout(timeoutId);
                if (unchain) unchain();
                if (sent) bumpEpoch(family);
            }
        };

        // In-flight dedup OUTSIDE the concurrency limit so only the one unique
        // fetch takes a pool slot (waiters share its promise without holding
        // slots), and re-check the cache once a slot is acquired: a prefetch that
        // completed while this call queued must not be fetched a second time.
        // The caller's signal goes to the limiter too, so a request aborted while
        // queued leaves the queue at once; dedup only shares entries between
        // callers on the same signal, so that abort already applies to every sharer, and only within one binding (or
        // between unbound callers): a binding that ends never takes another caller's request with it.
        const limitedFetch = () => withConcurrencyLimit(() => {
            assertSession();
            if (isGet && !withStatus && !skipCache && cacheKey) {
                const cached = getCached(scope + cacheKey);
                if (cached) return Promise.resolve(cached);
            }
            return fetchFn();
        }, limit);
        let pending;
        if (isGet && !withStatus && cacheKey) pending = deduplicatedFetch(scope + cacheKey, limitedFetch, signal, limit);

        // Plain GETs share concurrent identical requests too, even without a cacheKey
        // (nothing is cached). Skipped when a caller customises the headers, since the
        // response could then differ for the same URL. Each caller gets its own copy so
        // one mutating its result cannot affect the others.
        else if (isGet && !withStatus && auth && Object.keys(headers).length === 0) {
            pending = deduplicatedFetch(`${scope}GET ${url}`, limitedFetch, signal, limit).then((data) => structuredClone(data));
        } else pending = limitedFetch();
        let data;
        try { data = await pending; }
        catch (error) {
            // Not sent (its binding ended while it queued): unsent, nothing reached the server.
            if (isWrite && !sent && /** @type {any} */ (error)?.name === 'AbortError' && !/** @type {any} */ (error).jeOutcome) throw createUnsentAbort();
            throw error;
        }
        // Each deduplicated caller owns its own publication boundary too. A bound write the server answered after its
        // owner ended is accepted: the answer goes back in the abort, for its session's state only.
        if (isWrite && boundSession && sent) {
            let current = true;
            try { boundSession(); } catch (_) { current = false; }
            if (!current) {
                let sameSession = true;
                try { live(); } catch (_) { sameSession = false; }
                throw createAcceptedAbort(data, !sameSession);
            }
        }
        assertSession();
        assertPresentation();
        return data;
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

    /** Returns every HTTP status/body through the same bound plugin transport, with no automatic retry. */
    function pluginResponse(path, options) {
        return pluginFetch(path, { ...options, responseMode: 'status', skipCache: true, skipRetry: true });
    }

    /** Sends a legacy JE JSON ajax call through the session-bound core transport. */
    function ajax(options) {
        return coreFetch(options.url, {
            method: options.type || 'GET', body: options.data,
            headers: { ...(options.contentType ? { 'Content-Type': options.contentType } : {}), ...options.headers },
            signal: options.signal, skipRetry: true, bound: options.bound
        });
    }
    // ---- The server's JE build (the version handshake) ----
    // The server names its JE build (the client script's cache key, new with every build) in the bootstrap and on every
    // answer of its routes (X-JE-Build). The first one this page sees is the build it booted against (JE.serverBuild, set
    // from the bootstrap); an answer naming another means JE was updated on the server while this page kept its scripts:
    // the page asks the person to reload (once), before a save can be lost to a contract this page doesn't know.
    let reloadNotice = null;

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
        notice.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:100000;max-width:min(560px,calc(100vw - 32px));'
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
         * Compares a build the server named with the one this page booted against (the first it saw).
         * @param {*} serverBuild - The server's build, as named in an answer.
         * @returns {boolean} True when they differ (the reload notice is shown).
         */
        check(serverBuild) {
            if (typeof serverBuild !== 'string' || !serverBuild) return false;
            if (!JE.serverBuild) { JE.serverBuild = serverBuild; return false; }
            if (serverBuild === JE.serverBuild) return false;
            showReloadNotice();
            return true;
        },
        /**
         * Reads the build an answer names (a fetch Response, or the Response a failed ApiClient.ajax rejects with).
         * @param {*} response
         */
        noteAnswer(response) {
            try {
                const named = response?.headers?.get?.('X-JE-Build');
                if (named) build.check(named);
            } catch { /* An answer without readable headers names no build. */ }
        }
    };
    JE.core.build = build;

    JE.core.api = {
        fetch: coreFetch,
        ajax,
        jf,
        plugin: pluginFetch,
        pluginResponse,
        session,
        authHeaders,
        isPresentationAbort,
        writeOutcome,
        manager
    };

    console.log('🪼 Jellyfin Enhanced: API client core initialized');

})(window.JellyfinEnhanced);
