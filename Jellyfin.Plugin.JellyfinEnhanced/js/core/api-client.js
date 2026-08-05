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
            maxConcurrent: 8,
            maxQueueSize: 100
        }
    };

    // In-flight request deduplication
    /** @type {Map<string, Promise<any>>} */
    const inFlightRequests = new Map();

    // Response cache with TTL
    /** @type {Map<string, {data: any, timestamp: number}>} */
    const responseCache = new Map();

    // AbortController management per page/context
    /** @type {Map<string, AbortController>} */
    const activeControllers = new Map();

    // Concurrency control
    let activeCount = 0;
    /** @type {Array<Function>} */
    const pendingQueue = [];

    // Metrics (debug-gated)
    const metrics = {
        enabled: false,
        /** @type {Map<string, any>} */
        sections: new Map(),
        /** @type {Array<any>} */
        requests: []
    };

    /**
     * Sleep utility with jitter support
     * @param {number} ms
     */
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
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
     * @returns {Promise<Response>}
     */
    async function fetchWithRetry(url, options = {}, retryConfig = CONFIG.retry) {
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
                const response = await fetch(url, options);

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

                if (!isRetryable(null, response.status)) {
                    throw lastError;
                }
            } catch (error) {
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
                const delay = calculateBackoff(attempt, retryConfig);
                if (metrics.enabled) {
                    console.debug(`${logPrefix} Retry ${attempt}/${retryConfig.maxAttempts} for ${url} in ${delay}ms`);
                }
                await sleep(delay);
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
     */
    function deduplicatedFetch(key, fetchFn, signal) {
        // If a signal is provided, don't deduplicate - each caller needs their own abortable request
        // This prevents one caller's abort from affecting others
        if (signal) {
            return fetchFn();
        }

        if (inFlightRequests.has(key)) {
            if (metrics.enabled) {
                console.debug(`${logPrefix} Reusing in-flight request for ${key}`);
            }
            return inFlightRequests.get(key);
        }

        const promise = fetchFn()
            .finally(() => {
                inFlightRequests.delete(key);
            });

        inFlightRequests.set(key, promise);
        return promise;
    }

    /**
     * Execute function with concurrency limit
     * @param {() => Promise<any>} fn
     */
    async function withConcurrencyLimit(fn) {
        // Wait if at capacity
        if (activeCount >= CONFIG.concurrency.maxConcurrent) {
            // Check queue size limit
            if (pendingQueue.length >= CONFIG.concurrency.maxQueueSize) {
                throw new Error('Request queue full - too many pending requests');
            }
            await new Promise(resolve => pendingQueue.push(resolve));
        }

        activeCount++;
        try {
            return await fn();
        } finally {
            activeCount--;
            // Release next queued request
            if (pendingQueue.length > 0) {
                const next = pendingQueue.shift();
                if (next) next();
            }
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
            requests: metrics.requests.slice()
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
    }

    // Abort all in-flight requests on SPA navigation so that mid-fetch results
    // from page A don't land on page B with stale state. Modules continue to
    // do their own per-section cleanup; this is a belt-and-braces global
    // handler. Uses the deduplicated navigation pipeline, which covers
    // popstate, hashchange AND pushState transitions.
    JE.core.navigation.onNavigate(() => {
        try { abortAllRequests(); } catch (_) { /* never propagate */ }
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
     * @property {string} [cacheKey] - Enables response cache + in-flight dedup (GET only).
     * @property {boolean} [skipCache=false] - Bypass the response cache.
     * @property {boolean} [skipRetry=false] - Limit to a single attempt.
     * @property {boolean} [auth=true] - Include the Jellyfin auth headers.
     * @property {number} [timeoutMs] - Per-request timeout; aborts via AbortController.
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
            timeoutMs
        } = options;

        const isGet = method.toUpperCase() === 'GET';

        // Check cache first (GET only)
        if (isGet && !skipCache && cacheKey) {
            const cached = getCached(cacheKey);
            if (cached) return cached;
        }

        const fetchFn = async () => {
            /** @type {Record<string, string>} */
            const requestHeaders = {
                ...(auth ? authHeaders() : { 'Accept': 'application/json' }),
                ...headers
            };

            /** @type {RequestInit} */
            const init = { method, headers: requestHeaders };

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
                    skipRetry ? { ...CONFIG.retry, maxAttempts: 1 } : undefined
                );
                // Tolerant JSON parse: some endpoints reply with empty bodies.
                const text = await response.text();
                const data = text ? JSON.parse(text) : {};

                if (isGet && cacheKey) {
                    setCache(cacheKey, data);
                }
                return data;
            } finally {
                if (timeoutId) clearTimeout(timeoutId);
                if (unchain) unchain();
            }
        };

        // Concurrency limit + in-flight dedup (GET with a cache key only)
        return withConcurrencyLimit(() =>
            (isGet && cacheKey)
                ? deduplicatedFetch(cacheKey, fetchFn)
                : fetchFn()
        );
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

    JE.core.api = {
        fetch: coreFetch,
        jf,
        plugin: pluginFetch,
        authHeaders,
        manager
    };

    console.log('🪼 Jellyfin Enhanced: API client core initialized');

})(window.JellyfinEnhanced);
