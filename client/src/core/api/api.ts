import { createCache } from './cache';
import { abortable, cancellation } from './cancellation';
import { createDedup } from './dedup';
import { createMetrics } from './metrics';
import { retryFetch } from './retry';
import { createScheduler } from './scheduler';
import { abortError, DecodeError, type ApiConfig, type ApiDependencies, type ConcurrencyOptions,
    type Decoder, type IdentityLease, type RequestOptions, type RetryConfig } from './types';

/** One factory invocation per installed API; imported helpers contain no module-level state. */
export function createApi(deps: ApiDependencies) {
    const CONFIG: ApiConfig = {
        retry: { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 5000, jitterFactor: 0.3,
            retryableStatuses: [408, 429, 500, 502, 503, 504], timeoutBudgetMs: 15000 },
        cache: { ttlMs: 30 * 60 * 1000, maxEntries: 200 },
        concurrency: { maxConcurrent: 4, maxQueueSize: 100, maxLowConcurrent: 2, maxLowQueueSize: 200 }
    };
    const measurements = createMetrics(deps.now, deps.debug);
    const { metrics } = measurements;
    const scheduler = createScheduler(CONFIG.concurrency, deps.now, (priority, waitMs) => {
        if (metrics.enabled) metrics.queueWaits.push({ priority, waitMs });
    });
    const cache = createCache(CONFIG.cache, deps.wallNow);
    const dedup = createDedup(deps.controller, scheduler.promote);
    const controllers = new Map<string, AbortController>();
    interface LegacyEntry { promise: Promise<unknown>; signal: AbortSignal | null; limit?: ConcurrencyOptions }
    const legacy = new Map<string, LegacyEntry>();
    const scheduledOptions = new WeakMap<ConcurrencyOptions, ConcurrencyOptions>();
    const record: Parameters<typeof retryFetch>[5] = metric => { if (metrics.enabled) metrics.requests.push(metric); };
    function clearCacheMatching(pattern: string): void {
        cache.clearMatching(pattern); dedup.forget(pattern);
        for (const key of legacy.keys()) if (key.includes(pattern)) legacy.delete(key);
    }
    function clearCache(): void { cache.clear(); dedup.forget(); legacy.clear(); }
    function abortAllRequests(): void {
        for (const controller of controllers.values()) controller.abort();
        controllers.clear(); dedup.forget(); legacy.clear();
    }
    deps.onIdentityChange(() => { clearCache(); scheduler.cancelAll(); abortAllRequests(); });
    deps.onNavigate(() => { abortAllRequests(); scheduler.demote(); });
    function getCached(key: string): unknown { deps.acquireLease().throwIfStale(); return cache.get(key); }
    function setCache(key: string, data: unknown, requestedAt?: number): void {
        deps.acquireLease().throwIfStale(); cache.set(key, data, requestedAt);
    }
    async function fetchWithRetry(url: string, options: RequestInit = {}, config: RetryConfig = CONFIG.retry): Promise<Response> {
        const lease = deps.acquireLease();
        return retryFetch(deps, url, options, config, lease, record);
    }
    async function withConcurrencyLimit<T>(fn: () => Promise<T>, options: ConcurrencyOptions = {}): Promise<T> {
        const lease = deps.acquireLease();
        const cancel = cancellation(deps, [lease.signal, options.signal]);
        const scheduled: ConcurrencyOptions = { ...options, signal: cancel.signal };
        scheduledOptions.set(options, scheduled);
        try {
            return await scheduler.run(async () => {
                lease.throwIfStale();
                const result = await abortable(fn(), cancel.signal); lease.throwIfStale(); return result;
            }, scheduled);
        } finally { scheduledOptions.delete(options); cancel.dispose(); }
    }
    /** Legacy callbacks close over their own signal, so share only within that signal group. */
    function deduplicatedFetch(key: string, fn: () => Promise<unknown>, signal?: AbortSignal, limit?: ConcurrencyOptions): Promise<unknown> {
        const lease = deps.acquireLease();
        if (signal?.aborted) return Promise.reject(abortError());
        const existing = legacy.get(key);
        if (existing && existing.signal === (signal || null)) {
            if (existing.limit && limit?.priority !== 'low') {
                scheduler.promote(scheduledOptions.get(existing.limit) || existing.limit);
                existing.limit.priority = 'normal';
            }
            return existing.promise;
        }
        const cancel = cancellation(deps, [lease.signal, signal]);
        let pending: Promise<unknown>;
        try { lease.throwIfStale(); pending = fn(); }
        catch (error) { cancel.dispose(); return Promise.reject(error); }
        const promise = abortable(pending, cancel.signal).then(value => { lease.throwIfStale(); return value; });
        const entry: LegacyEntry = { promise, signal: signal || null, ...(limit ? { limit } : {}) };
        const release = () => { if (legacy.get(key) === entry) legacy.delete(key); };
        cancel.signal.addEventListener('abort', release, { once: true });
        legacy.set(key, entry);
        const cleanup = () => { release(); cancel.signal.removeEventListener('abort', release); cancel.dispose(); };
        void promise.then(cleanup, cleanup);
        return promise;
    }
    const manager = {
        fetchWithRetry, deduplicatedFetch, withConcurrencyLimit,
        getAbortSignal(key: string): AbortSignal {
            controllers.get(key)?.abort(); const controller = deps.controller(); controllers.set(key, controller); return controller.signal;
        },
        abortAllRequests,
        abortRequest(key: string) { controllers.get(key)?.abort(); controllers.delete(key); },
        getCached, setCache, clearCache, clearCacheMatching,
        cacheStamp() { deps.acquireLease().throwIfStale(); return cache.stamp(); },
        ...measurements, CONFIG
    };
    async function request(url: string, options: RequestOptions, lease: IdentityLease): Promise<unknown> {
        lease.throwIfStale();
        const method = options.method || 'GET';
        const isGet = method.toUpperCase() === 'GET';
        const priority = options.priority === 'low' ? 'low' : 'normal';
        // Deadline belongs to this subscriber and starts before admission, including cache/dedup.
        const subscriber = cancellation(deps, [lease.signal, options.signal], options.timeoutMs);
        const requestedAt = cache.stamp();
        try {
            if (subscriber.signal.aborted) throw abortError();
            if (isGet && options.cacheKey && !options.skipCache) {
                const cached = cache.get(options.cacheKey); if (cached !== null) return cached;
            }
            const start = async (signal: AbortSignal, limit: ConcurrencyOptions): Promise<unknown> => {
                const transport = cancellation(deps, [signal, lease.signal]);
                try {
                    return await scheduler.run(async () => {
                        lease.throwIfStale();
                        if (isGet && options.cacheKey && !options.skipCache) {
                            const cached = cache.get(options.cacheKey); if (cached !== null) return cached;
                        }
                        const headers: Record<string, string> = {
                            ...(options.auth === false ? { Accept: 'application/json' } : lease.headers), ...options.headers
                        };
                        const init: RequestInit = { method, headers, signal: transport.signal };
                        if (limit.priority === 'low') init.priority = 'low';
                        if (options.body !== undefined) {
                            if (typeof options.body === 'string') init.body = options.body;
                            else {
                                const body = JSON.stringify(options.body);
                                if (body !== undefined) init.body = body;
                                if (!Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
                            }
                        }
                        const response = await retryFetch(deps, url, init,
                            options.skipRetry ? { ...CONFIG.retry, maxAttempts: 1 } : CONFIG.retry, lease, record, options.retrySafe);
                        const text = await abortable(response.text(), transport.signal);
                        lease.throwIfStale();
                        const data: unknown = text ? JSON.parse(text) : {};
                        if (isGet && options.cacheKey) cache.set(options.cacheKey, data, requestedAt);
                        return data;
                    }, limit);
                } finally { transport.dispose(); }
            };
            let result: unknown;
            if (isGet && options.cacheKey) {
                result = await dedup.run(options.cacheKey, start, subscriber.signal, priority);
            } else if (isGet && options.auth !== false && Object.keys(options.headers || {}).length === 0) {
                result = deps.clone(await dedup.run(`GET ${url}`, start, subscriber.signal, priority));
            } else {
                result = await abortable(start(subscriber.signal, { priority, signal: subscriber.signal }), subscriber.signal);
            }
            lease.throwIfStale();
            return result;
        } finally { subscriber.dispose(); }
    }
    function guarded(url: string, options: RequestOptions, lease: IdentityLease): Promise<unknown> {
        return request(url, options, lease).then(value => {
            lease.throwIfStale();
            if (options.signal?.aborted) throw abortError();
            return value;
        });
    }
    const fetch = (url: string, options: RequestOptions = {}) => guarded(url, options, deps.acquireLease());
    function jf(path: string, options: RequestOptions = {}): Promise<unknown> {
        const lease = deps.acquireLease(); return guarded(lease.resolve(path), options, lease);
    }
    const plugin = (path: string, options?: RequestOptions) => jf(`/JellyfinEnhanced${path}`, options);
    /** Decode every response, including cache hits; no generic assertion masquerades as validation. */
    async function decoded<T>(pending: Promise<unknown>, decode: Decoder<T>, lease: IdentityLease): Promise<T> {
        const value = await pending;
        lease.throwIfStale();
        let result: T;
        try { result = decode(value); } catch (error) { throw new DecodeError(error); }
        lease.throwIfStale();
        return result;
    }
    return { fetch, jf, plugin, manager,
        authHeaders: () => ({ ...deps.acquireLease().headers }),
        fetchDecoded: <T>(url: string, decode: Decoder<T>, options?: RequestOptions) => {
            const lease = deps.acquireLease(); return decoded(fetch(url, options), decode, lease);
        },
        jfDecoded: <T>(path: string, decode: Decoder<T>, options?: RequestOptions) => {
            const lease = deps.acquireLease(); return decoded(jf(path, options), decode, lease);
        },
        pluginDecoded: <T>(path: string, decode: Decoder<T>, options?: RequestOptions) => {
            const lease = deps.acquireLease(); return decoded(plugin(path, options), decode, lease);
        }
    };
}
export type CoreApi = ReturnType<typeof createApi>;
