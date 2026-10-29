// /js/jellyseerr/nativedetails/native-recovery.js
//
// Bounded recovery for the parts of a not-in-library title's native page that jellyfin-web loads once and never
// asks for again (experimental, Jellyfin 12 web only; used by native-details.js):
//   - artwork: jellyfin-web's lazy loader preloads an image with an off-DOM Image and handles only `load`, so an
//     image the server could not serve right now (its image admission was busy, TMDB was down, the viewer's
//     access could not be settled: 503/429 with Retry-After) stays hidden until the page is opened again.
//     images() watches the page's own artwork answers (resource timing, or a watchdog where the browser does not
//     report statuses), asks the server again itself after Retry-After with backoff and jitter, at most
//     MAX_ACTIVE at once (below the server's eight places per viewer), within MAX_ATTEMPTS and DEADLINE_MS, and
//     shows the image the way jellyfin-web shows a loaded one. A refusal or a missing file (404) ends it, so a
//     placeholder stays one; a grant minted under a policy that has since moved (404 stale-grant) gets one re-read
//     of the item under the current session for its current grant.
//   - season and episode lists: jellyfin-web reads them once (getSeasons/getEpisodes) and draws nothing when that
//     read fails. childReads() wraps those two reads for synthetic ids only: a temporary answer (429/502/503/504)
//     is asked again through JE's session-bound transport after Retry-After, and the list is drawn when it comes;
//     until then the list stays pending (nothing drawn), never a completed empty list.
// Every piece of work belongs to its page: the page ending (navigation, another viewer, sign-out) or the viewer's
// access moving ends it, and nothing it finds afterwards is drawn.
(function (JE) {
    'use strict';

    /** Recovery loads of one page at once (the server admits eight distinct images per viewer). */
    const MAX_ACTIVE = 3;
    /** Asks per image or list, the first failed one included. */
    const MAX_ATTEMPTS = 8;
    /** No ask starts later than this after the first failure. */
    const DEADLINE_MS = 60000;
    /** The wait when the answer named none (the server's own Retry-After for these answers). */
    const DEFAULT_RETRY_AFTER_MS = 2000;
    const BACKOFF_BASE_MS = 1000;
    const BACKOFF_MAX_MS = 8000;
    const JITTER_MS = 400;
    /** How long a lazily loaded image may stay hidden before it is asked for again where statuses aren't reported. */
    const WATCHDOG_MS = 8000;
    /** Answers that are worth asking again. */
    const RETRYABLE = new Set([0, 429, 500, 502, 503, 504]);
    /** A signed image of an item: /Items/<id>/Images/<Type>[/<index>]. */
    const IMAGE = /\/Items\/([0-9a-f]{32})\/Images\/([A-Za-z]+)(?:\/(\d+))?/i;
    /** The query parameter a recovery load adds, so the browser asks the server again rather than reuse a failed load. */
    const MARK = '_jer';

    /**
     * The clock and timers recovery uses (tests replace them).
     * @type {{now: () => number, setTimeout: (fn: Function, ms: number) => any, clearTimeout: (id: any) => void, random: () => number}}
     */
    const env = {
        now: () => Date.now(),
        setTimeout: (fn, ms) => window.setTimeout(fn, ms),
        clearTimeout: id => window.clearTimeout(id),
        random: () => Math.random()
    };

    /**
     * The wait before the next ask: never sooner than the server asked, backing off with each ask, plus jitter.
     * @param {number} attempts Asks made so far.
     * @param {number} retryAfterMs The answer's Retry-After (0: none named).
     * @returns {number} Milliseconds.
     */
    function delayFor(attempts, retryAfterMs) {
        const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
        return Math.max(retryAfterMs > 0 ? retryAfterMs : DEFAULT_RETRY_AFTER_MS, backoff) + Math.floor(env.random() * JITTER_MS);
    }

    /**
     * A Retry-After header in milliseconds (seconds or an HTTP date), 0 when none.
     * @param {string|null|undefined} value Header value.
     * @returns {number} Milliseconds.
     */
    function retryAfter(value) {
        if (!value) return 0;
        const seconds = Number(value);
        if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
        const at = Date.parse(value);
        return Number.isFinite(at) ? Math.max(0, at - env.now()) : 0;
    }

    /**
     * `url` with the recovery mark set to `n` (any earlier mark replaced).
     * @param {string} url Image URL.
     * @param {number} n Mark.
     * @returns {string} URL.
     */
    function marked(url, n) {
        const base = url.replace(new RegExp(`([?&])${MARK}=\\d+&?`), '$1').replace(/[?&]$/, '');
        return base + (base.includes('?') ? '&' : '?') + MARK + '=' + n;
    }

    /**
     * True while statuses of loaded resources are reported (PerformanceResourceTiming.responseStatus).
     * @returns {boolean} Supported.
     */
    function statusesReported() {
        return typeof PerformanceObserver === 'function' && typeof PerformanceResourceTiming === 'function'
            && 'responseStatus' in PerformanceResourceTiming.prototype;
    }

    /**
     * Reports every finished load of a synthetic image that did not succeed (status, or 0 for a network failure),
     * from the browser's resource timing. One observer for the page's lifetime.
     * @param {(url: string, status: number) => void} onFailure Called per failed load.
     * @param {(id: string) => boolean} isSynthetic Whether an item id is a synthetic one.
     * @returns {(() => void)|null} Stop, or null where statuses aren't reported.
     */
    function watchResources(onFailure, isSynthetic) {
        if (!statusesReported()) return null;
        let observer;
        try {
            observer = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    const timing = /** @type {PerformanceResourceTiming} */ (entry);
                    // Recovery's own asks report their answers themselves.
                    if (timing.initiatorType === 'fetch' || timing.initiatorType === 'xmlhttprequest') continue;
                    const match = IMAGE.exec(timing.name);
                    if (!match || !isSynthetic(match[1])) continue;
                    const status = Number(/** @type {any} */ (timing).responseStatus) || 0;
                    if (status >= 200 && status < 400) continue;
                    onFailure(timing.name, status);
                }
            });
            observer.observe({ type: 'resource', buffered: false });
        } catch {
            return null;
        }
        return () => observer.disconnect();
    }

    /**
     * True when `node` still waits for `url` the way jellyfin-web's lazy loader leaves an image it couldn't load
     * (the URL in data-src, the element hidden).
     * @param {Element} node Element.
     * @param {string} url Image URL.
     * @returns {boolean} Waiting.
     */
    function waiting(node, url) {
        return node.isConnected && node.getAttribute('data-src') === url;
    }

    /**
     * Shows a loaded image on `node` the way jellyfin-web shows one (background or src, data-src gone, faded in).
     * @param {HTMLElement} node Element.
     * @param {string} url The URL that loaded.
     * @returns {void}
     */
    function show(node, url) {
        if (node.tagName === 'IMG') node.setAttribute('src', url);
        else node.style.backgroundImage = "url('" + url + "')";
        node.removeAttribute('data-src');
        node.classList.add('lazy-image-fadein-fast');
        node.classList.remove('lazy-hidden');
    }

    /**
     * The current grant of an image, read again from its item (a stale grant's one repair): the image URL with the
     * item's current tag for that image, or null when the item no longer has one (or can't be read).
     * @param {string} url Image URL.
     * @param {(id: string) => Promise<any>} getItem Reads an item under the current session.
     * @returns {Promise<string|null>} New URL.
     */
    async function regrant(url, getItem) {
        const match = IMAGE.exec(url);
        if (!match) return null;
        const [, id, type, index] = match;
        let item;
        try { item = await getItem(id); } catch { return null; }
        const tag = /^backdrop$/i.test(type) ? item?.BackdropImageTags?.[Number(index) || 0] : item?.ImageTags?.[type];
        if (!tag) return null;
        const next = url.replace(/([?&]tag=)[^&]*/i, '$1' + encodeURIComponent(tag));
        return next === url ? null : next;
    }

    /**
     * One page's artwork recovery.
     * @param {Object} options Options.
     * @param {() => HTMLElement|null} options.page The page while it is live (null once it ended).
     * @param {() => boolean} options.live Whether the page (and the policy it was drawn under) still holds.
     * @param {(node: HTMLElement, url: string) => void} [options.onShown] Called for every image recovery showed.
     * @param {(id: string) => Promise<any>} [options.getItem] Reads an item under the current session (stale grants).
     * @param {{expected?: () => string|null, waiting: (url: string) => boolean, show: (url: string) => void}} [options.outside]
     *     An image of the page drawn outside its element (the backdrop): the URL jellyfin-web asked for (for the watchdog
     *     where statuses aren't reported), whether it still waits for `url`, and how to show it.
     * @returns {{failed: (url: string, status: number) => void, started: (node: HTMLElement, url: string) => void, dispose: () => void, size: () => number}} Recovery.
     */
    function images({ page, live, onShown = () => {}, getItem, outside }) {
        /** @type {Map<string, {url: string, attempts: number, first: number, timer: any, busy: boolean, repaired: boolean}>} */
        const entries = new Map();
        /** Waiting asks (urls), oldest first; at most MAX_ACTIVE run. */
        const ready = [];
        const controllers = new Set();
        /** Every pending phase's stop (an image load, an item re-read): called at its deadline or when the page ends. */
        const stops = new Set();
        /** Watchdog timers of images still loading (only where statuses aren't reported). */
        const watchdogs = new Map();
        let active = 0;
        let ended = false;
        let marks = 0;

        const alive = () => !ended && live() && !!page();
        /**
         * The page's elements still waiting for `url`.
         * @param {string} url Image URL.
         * @returns {HTMLElement[]} Elements.
         */
        const nodesOf = url => {
            const root = page();
            if (!root) return [];
            return [...root.querySelectorAll('[data-src]')].filter(n => waiting(n, url)).map(n => /** @type {HTMLElement} */ (n));
        };

        /** True once an image's recovery is past its deadline (counted from its first failure). */
        const expired = entry => env.now() - entry.first >= DEADLINE_MS;

        /**
         * `work` (a phase that holds the entry's place) bounded by the entry's deadline and the page: it settles with
         * `work`'s value, or with null at the deadline or when the page ends (whichever comes first); the place is
         * released either way.
         * @template T
         * @param {{first: number}} entry Entry.
         * @param {(stop: () => void) => Promise<T>} work The phase (given its own stop, to cancel what it started).
         * @returns {Promise<T|null>} The value, or null.
         */
        const bounded = (entry, work) => new Promise((resolve) => {
            let done = false;
            let cancel = () => {};
            const stop = () => {
                if (done) return;
                done = true;
                env.clearTimeout(timer);
                stops.delete(stop);
                cancel();
                resolve(null);
            };
            const timer = env.setTimeout(stop, Math.max(0, entry.first + DEADLINE_MS - env.now()));
            stops.add(stop);
            work(fn => { cancel = fn; }).then(value => {
                if (done) return;
                done = true;
                env.clearTimeout(timer);
                stops.delete(stop);
                resolve(value);
            }, () => stop());
        });

        /** True while anything of the page still waits for `url`. */
        const pending = url => nodesOf(url).length > 0 || outside?.waiting(url) === true;

        /** Ends one image's recovery (shown, refused, or out of attempts or time). */
        const finish = url => {
            const entry = entries.get(url);
            if (entry?.timer) env.clearTimeout(entry.timer);
            entries.delete(url);
        };

        /** Schedules the next ask of `url`, or gives up when attempts or time are spent. */
        const later = (url, retryAfterMs) => {
            const entry = entries.get(url);
            if (!entry || !alive()) return;
            const wait = delayFor(entry.attempts, retryAfterMs);
            if (entry.attempts >= MAX_ATTEMPTS || env.now() + wait - entry.first > DEADLINE_MS) { finish(url); return; }
            entry.timer = env.setTimeout(() => { entry.timer = null; ready.push(url); pump(); }, wait);
        };

        /** Starts waiting asks while there is room. */
        const pump = () => {
            while (active < MAX_ACTIVE && ready.length && alive()) {
                const url = /** @type {string} */ (ready.shift());
                const entry = entries.get(url);
                if (!entry || entry.busy) continue;
                // Waited past the deadline for a place (or nothing waits for it any more): ended, never started late.
                if (expired(entry) || !pending(url)) { finish(url); continue; }
                entry.busy = true;
                active++;
                ask(entry).finally(() => { entry.busy = false; active--; if (!ended) pump(); });
            }
        };

        /**
         * One ask of the server: the answer's status and Retry-After decide; a served image is then shown by loading
         * it as jellyfin-web would (the server holds its bytes now, so that load costs no admission place).
         * @param {{url: string, attempts: number, first: number, timer: any, busy: boolean, repaired: boolean}} entry Entry.
         * @returns {Promise<void>}
         */
        const ask = async entry => {
            const url = entry.url;
            entry.attempts++;
            const controller = new AbortController();
            controllers.add(controller);
            // The deadline holds for an ask in flight too: it is abandoned, not waited out.
            const cutoff = env.setTimeout(() => controller.abort(), Math.max(0, entry.first + DEADLINE_MS - env.now()));
            let status = 0;
            let wait = 0;
            let reason = '';
            try {
                const response = await window.fetch(marked(url, ++marks), { cache: 'no-store', signal: controller.signal });
                status = response.status;
                wait = retryAfter(response.headers.get('Retry-After'));
                reason = response.headers.get('X-JE-Art') || '';
                try { await response.body?.cancel(); } catch { /* already read */ }
            } catch {
                // No answer: a dropped connection (asked again), the deadline or the page's end (below).
            } finally {
                env.clearTimeout(cutoff);
                controllers.delete(controller);
            }
            if (controller.signal.aborted) { if (alive()) finish(url); return; }
            if (!alive()) return;
            if (status >= 200 && status < 300) { await load(entry); return; }
            if (status === 404 && reason === 'stale-grant' && !entry.repaired && getItem) {
                entry.repaired = true;
                const next = await bounded(entry, () => regrant(url, getItem));
                if (!next || !alive() || expired(entry)) { finish(url); return; }
                // The page's elements wait for the current grant now; the old one serves nothing.
                for (const node of nodesOf(url)) node.setAttribute('data-src', next);
                entries.delete(url);
                entries.set(next, { ...entry, url: next, timer: null, busy: false });
                ready.push(next);
                return;
            }
            if (!RETRYABLE.has(status)) { finish(url); return; }
            later(url, wait);
        };

        /**
         * Shows `entry`'s image on every element still waiting for it, once a load of it succeeds.
         * @param {{url: string, attempts: number}} entry Entry.
         * @returns {Promise<void>}
         */
        const load = async entry => {
            const url = entry.url;
            const fresh = marked(url, ++marks);
            // true: loaded; false: failed; null: the deadline or the page's end came first (the load is dropped).
            const loaded = await bounded(entry, onStop => new Promise((resolve) => {
                const img = new Image();
                onStop(() => { img.onload = img.onerror = null; img.src = ''; });
                img.onload = () => resolve(true);
                img.onerror = () => resolve(false);
                img.src = fresh;
            }));
            if (loaded === false) { later(url, 0); return; }
            if (loaded && alive() && !expired(entry)) {
                for (const node of nodesOf(url)) {
                    show(node, fresh);
                    onShown(node, fresh);
                }
                if (outside?.waiting(url)) outside.show(fresh);
            }
            if (alive()) finish(url);
        };

        /**
         * A load of `url` on the page failed with `status` (0: no answer): recovered unless the answer is final.
         * @param {string} url Image URL.
         * @param {number} status HTTP status.
         * @returns {void}
         */
        const failed = (url, status) => {
            if (!alive() || entries.has(url) || url.includes(MARK + '=')) return;
            if (status !== 404 && !RETRYABLE.has(status)) return;
            if (!pending(url)) return;
            entries.set(url, { url, attempts: 0, first: env.now(), timer: null, busy: false, repaired: false });
            // 404: asked at once (it tells a stale grant from a refusal); a temporary answer: after its Retry-After.
            if (status === 404) { ready.push(url); pump(); } else later(url, 0);
        };

        // Where statuses aren't reported, the backdrop has no element of the page to watch: the request jellyfin-web made for
        // it on this visit is looked for every WATCHDOG_MS (a slow one is listed only once it has ended), until the deadline.
        if (!statusesReported() && outside?.expected) {
            const key = {};
            const since = env.now();
            const check = () => {
                watchdogs.delete(key);
                if (ended || !alive()) return;
                const url = outside.expected();
                if (url && !entries.has(url) && outside.waiting(url)) failed(url, 0);
                if (env.now() + WATCHDOG_MS - since <= DEADLINE_MS) watchdogs.set(key, env.setTimeout(check, WATCHDOG_MS));
            };
            watchdogs.set(key, env.setTimeout(check, WATCHDOG_MS));
        }

        return {
            failed,
            /**
             * jellyfin-web started loading `url` into `node`. Where statuses aren't reported, an image still hidden
             * after WATCHDOG_MS is treated as a failed load.
             * @param {HTMLElement} node Element.
             * @param {string} url Image URL.
             */
            started(node, url) {
                if (statusesReported() || ended || watchdogs.has(node)) return;
                watchdogs.set(node, env.setTimeout(() => {
                    watchdogs.delete(node);
                    if (waiting(node, url) && node.classList.contains('lazy-hidden')) failed(url, 0);
                }, WATCHDOG_MS));
            },
            /** Ends every ask and timer of the page; nothing found afterwards is drawn. */
            dispose() {
                ended = true;
                for (const entry of entries.values()) if (entry.timer) env.clearTimeout(entry.timer);
                for (const timer of watchdogs.values()) env.clearTimeout(timer);
                watchdogs.clear();
                entries.clear();
                ready.length = 0;
                for (const controller of controllers) controller.abort();
                controllers.clear();
                for (const stop of [...stops]) stop();
            },
            /** @returns {number} Images being recovered. */
            size: () => entries.size
        };
    }

    /**
     * The status and Retry-After of a failed jellyfin-web read (its API client rejects with the Response).
     * @param {any} error Rejection.
     * @returns {{status: number, retryAfterMs: number}} Answer.
     */
    function answerOf(error) {
        const status = Number(error?.status) || 0;
        const header = typeof error?.headers?.get === 'function' ? error.headers.get('Retry-After') : null;
        return { status, retryAfterMs: retryAfter(header) };
    }

    /**
     * Wraps the API client's (window.ApiClient) season and episode list reads for synthetic ids: a temporary answer is asked again
     * (Retry-After, backoff, bounded) through JE's session-bound transport and the list is drawn when it comes. A read
     * whose page ended (navigation, another viewer, the access policy moved) is never settled, so nothing is drawn
     * into a page no longer shown. A final answer rejects as before.
     * @param {Object} options Options.
     * @param {(id: string) => boolean} options.isSynthetic Whether an id is a synthetic one.
     * @param {() => any} options.capture The reading page's identity, captured as the read starts.
     * @param {(captured: any) => boolean} options.live Whether that page still holds.
     * @param {(captured: any, end: () => void) => () => void} [options.watch] Registers `end`, called whenever what the page
     *     depends on may have moved (it ends the read only when the page no longer holds); returns the unregistration.
     * @returns {boolean} True when the reads are wrapped (now or already).
     */
    function childReads({ isSynthetic, capture, live, watch }) {
        const apiClient = window.ApiClient;
        if (!apiClient || apiClient.__jeNativeChildReads) return !!apiClient;
        /**
         * The read `original` (jellyfin-web's own) with the recovery for synthetic ids.
         * @param {Function} original The client's read.
         * @param {(id: string) => string} path The read's path for an id.
         * @returns {Function} The wrapped read.
         */
        const wrap = (original, path) => function (itemId, options) {
            const first = original.apply(this, arguments);
            if (!isSynthetic(String(itemId || '')) && !isSynthetic(String(options?.seasonId || ''))) return first;
            const page = capture();
            const url = () => apiClient.getUrl(path(itemId), options);
            return settle(first, url, page, live, watch);
        };
        if (typeof apiClient.getEpisodes === 'function') apiClient.getEpisodes = wrap(apiClient.getEpisodes, id => `Shows/${id}/Episodes`);
        if (typeof apiClient.getSeasons === 'function') apiClient.getSeasons = wrap(apiClient.getSeasons, id => `Shows/${id}/Seasons`);
        apiClient.__jeNativeChildReads = true;
        return true;
    }

    /**
     * The first read's answer, or, after a temporary failure, the answer of a later ask (bounded).
     * @param {Promise<any>} first jellyfin-web's own read.
     * @param {() => string} url The read's URL.
     * @param {any} page The reading page's identity.
     * @param {(captured: any) => boolean} live Whether that page still holds.
     * @param {(captured: any, end: () => void) => () => void} [watch] Registers the read's end hook.
     * @returns {Promise<any>} The list.
     */
    function settle(first, url, page, live, watch) {
        return new Promise((resolve, reject) => {
            // Every answer, jellyfin-web's own first one included, is drawn only while the page that asked still holds.
            first.then(value => { if (live(page)) resolve(value); }, (error) => {
                let answer = answerOf(error);
                if (!RETRYABLE.has(answer.status) || !JE.core?.api?.fetch) { reject(error); return; }
                const session = JE.core.api.session?.();
                // One absolute deadline from the first failure: it aborts a queued or running ask, and nothing is published
                // after it. The page's own end is the binding's (checked before the bytes go out and before the answer
                // is published) and every step's.
                const deadline = new AbortController();
                let retry = null;
                let unwatch = () => {};
                /** Ends the read's own timers and hook (settled, or its page gone). */
                const release = () => { env.clearTimeout(cutoff); if (retry) env.clearTimeout(retry); retry = null; unwatch(); };
                const cutoff = env.setTimeout(() => deadline.abort(), DEADLINE_MS);
                // The page's end aborts a queued or running ask at once (never settled); the deadline's own abort fails it.
                unwatch = watch?.(page, () => { if (!live(page)) { release(); deadline.abort(); } }) || unwatch;
                const started = env.now();
                const current = () => live(page) && !deadline.signal.aborted;
                const fail = () => { release(); reject(error); };
                let attempts = 1;
                const next = () => {
                    // The page ended: never settled (nothing is drawn into a page no longer shown).
                    if (!live(page)) { release(); return; }
                    const wait = delayFor(attempts, answer.retryAfterMs);
                    if (attempts >= MAX_ATTEMPTS || env.now() + wait - started >= DEADLINE_MS) { fail(); return; }
                    retry = env.setTimeout(async () => {
                        retry = null;
                        if (!current()) { if (live(page)) fail(); else release(); return; }
                        attempts++;
                        let result;
                        try {
                            result = await JE.core.api.fetch(url(), {
                                method: 'GET', responseMode: 'status', skipCache: true, skipRetry: true, signal: deadline.signal,
                                ...(session ? { bound: { session, current } } : {})
                            });
                        } catch (failure) {
                            // The deadline (fails as before while the page holds) or the page's end (never settled).
                            if (deadline.signal.aborted) { if (live(page)) fail(); return; }
                            if (/** @type {any} */ (failure)?.name === 'AbortError' || !live(page)) { release(); return; }
                            answer = { status: 0, retryAfterMs: 0 };
                            next();
                            return;
                        }
                        if (!current()) { if (live(page)) fail(); else release(); return; }
                        if (result.status >= 200 && result.status < 300 && result.body && Array.isArray(result.body.Items)) {
                            release();
                            resolve(result.body);
                            return;
                        }
                        answer = { status: result.status, retryAfterMs: Number(result.retryAfterMs) || 0 };
                        if (!RETRYABLE.has(answer.status)) { fail(); return; }
                        next();
                    }, wait);
                };
                next();
            });
        });
    }

    JE.internals = JE.internals || {};
    JE.internals.nativeRecovery = Object.freeze({
        images, childReads, watchResources, statusesReported, delayFor, env,
        limits: Object.freeze({ MAX_ACTIVE, MAX_ATTEMPTS, DEADLINE_MS, DEFAULT_RETRY_AFTER_MS, WATCHDOG_MS })
    });
})(window.JellyfinEnhanced);
