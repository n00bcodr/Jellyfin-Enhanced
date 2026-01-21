// /js/jellyseerr/request-manager.js
// Centralized request management with deduplication, retry, caching, and cancellation
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Request Manager:';

    // Configuration
    const CONFIG = {
        retry: {
            maxAttempts: 3,
            baseDelayMs: 1000,
            maxDelayMs: 10000,
            jitterFactor: 0.3,
            retryableStatuses: [408, 429, 500, 502, 503, 504],
            timeoutBudgetMs: 30000
        },
        cache: {
            ttlMs: 5 * 60 * 1000, // 5 minutes
            maxEntries: 100
        },
        concurrency: {
            maxConcurrent: 4,
            maxQueueSize: 50
        }
    };

    // In-flight request deduplication
    const inFlightRequests = new Map();

    // Response cache with TTL
    const responseCache = new Map();

    // AbortController management per page/context
    const activeControllers = new Map();

    // Concurrency control
    let activeCount = 0;
    const pendingQueue = [];

    // Metrics (debug-gated)
    const metrics = {
        enabled: false,
        sections: new Map(),
        requests: []
    };

    /**
     * Sleep utility with jitter support
     */
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Calculate exponential backoff with jitter
     */
    function calculateBackoff(attempt, config = CONFIG.retry) {
        const exponentialDelay = config.baseDelayMs * Math.pow(2, attempt - 1);
        const clampedDelay = Math.min(exponentialDelay, config.maxDelayMs);
        const jitter = clampedDelay * config.jitterFactor * (Math.random() * 2 - 1);
        return Math.max(0, Math.round(clampedDelay + jitter));
    }

    /**
     * Check if an error/status is retryable
     */
    function isRetryable(error, status) {
        // Network errors are retryable
        if (error && !status) {
            return error.name !== 'AbortError';
        }
        return CONFIG.retry.retryableStatuses.includes(status);
    }

    /**
     * Fetch with automatic retry and exponential backoff
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
                lastError = new Error(`HTTP ${response.status}`);

                if (!isRetryable(null, response.status)) {
                    throw lastError;
                }
            } catch (error) {
                lastError = error;

                // Don't retry abort errors
                if (error.name === 'AbortError') {
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
                next();
            }
        }
    }

    /**
     * Get AbortSignal for a page/context key
     * Automatically aborts previous request for the same key
     */
    function getAbortSignal(pageKey) {
        // Abort previous controller for this key
        if (activeControllers.has(pageKey)) {
            activeControllers.get(pageKey).abort();
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
     */
    function abortRequest(pageKey) {
        if (activeControllers.has(pageKey)) {
            activeControllers.get(pageKey).abort();
            activeControllers.delete(pageKey);
        }
    }

    /**
     * Get cached response (LRU - moves accessed entry to end)
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
     */
    function setCache(key, data) {
        // Evict oldest entries if at capacity
        if (responseCache.size >= CONFIG.cache.maxEntries) {
            const oldestKey = responseCache.keys().next().value;
            responseCache.delete(oldestKey);
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
     */
    function clearCacheMatching(pattern) {
        for (const key of responseCache.keys()) {
            if (key.includes(pattern)) {
                responseCache.delete(key);
            }
        }
    }

    // Metrics API

    /**
     * Start measuring a section's load time
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

    // Note: Individual modules handle their own cleanup on hashchange
    // to ensure proper timing (new requests created AFTER abort)

    // Expose the request manager
    JE.requestManager = {
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

})(window.JellyfinEnhanced);
