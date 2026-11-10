import type { PageModules } from './modules';
import type { AlertOptions, ChecklistRowState, ConnectionStatus, ConnectionTestResult } from './types';

/** Dependencies this module calls; members are resolved lazily, after every module exists. */
export type ConnectionsDeps = Pick<PageModules, 'context' | 'misc' | 'whatsNew'>;

export function createConnections(m: ConnectionsDeps) {
    const { Dashboard } = m.context;

        // ==============================================================
        // Connection-test cache + Integration Health checklist (phase 4).
        // The checklist on Overview is a live health view of every
        // integration the admin has turned on. It renders rows purely
        // from (live config) + (cached test results), so it doesn't
        // hammer external services on every render. TTL keeps results
        // fresh without forcing probes on every click. The "Re-test all"
        // Quick Action clears the cache and re-invokes every test.
        // ==============================================================
        var CONNECTION_TEST_CACHE_TTL_MS = 5 * 60 * 1000;

        var _jeConnectionTestCache = new Map<string, ConnectionTestResult>();

        // Generation counter for the cache. Every clear bumps it; any
        // write that was captured (via beginConnectionTest) at a prior
        // generation is dropped. Closes the race where a user clicks a
        // per-service Test button, then clicks Re-test-all, then the
        // original click's async result resolves and writes a stale
        // ok/error over the fresh result. See design review H2.
        var _jeCacheGeneration = 0;

        /**
         * Capture the current cache generation. Tests call this at START
         * and pass the returned token to setConnectionTestResult. A token
         * older than the current generation means the cache was cleared
         * mid-test and this write is stale — it gets dropped.
         */
        function beginConnectionTest() : number {
            return _jeCacheGeneration;
        }

        // When true, per-service tests skip their own Dashboard.alert
        // success/failure dialog. The Re-test-all Quick Action sets this
        // for the duration of a batch and shows a single aggregate dialog
        // at the end, instead of stacking 8+ modal prompts the admin has
        // to dismiss one by one.
        var _jeSuppressTestAlerts = false;

        /**
         * Dashboard.alert that respects the batch-mode suppression flag.
         * Use inside any per-service test function where a Dashboard.alert
         * is part of the individual-test UX but would spam the admin when
         * the test fires as part of a batch re-test.
         */
        function jeTestAlert(opts: AlertOptions) : void {
            if (_jeSuppressTestAlerts) return;
            try { Dashboard.alert(opts); } catch (e) {
                console.warn('[JE] Dashboard.alert threw:', e);
            }
        }

        /**
         * Write a test result into the cache and refresh the checklist.
         * Safe to call multiple times; last write wins within the same
         * generation. Cache-refresh is guarded against exceptions so a
         * bug in renderChecklist can't cascade and break the actual
         * test flow.
         * @param {string} key  e.g. 'tmdb', 'seerr', 'sonarr:<normalizedUrl>'
         * @param {'ok'|'error'} status
         * @param {string} detail short human message shown in the row
         * @param {number} [token] optional generation token from
         *   beginConnectionTest; stale tokens are silently dropped.
         */
        function setConnectionTestResult(key: string, status: ConnectionStatus, detail: string, token?: number) : void {
            if (token !== undefined && token !== _jeCacheGeneration) {
                // Stale write from a test that was issued before the last
                // cache clear. Drop it so a fresher (in-flight) test's
                // result isn't overwritten by a stale ok/error.
                return;
            }
            var now = Date.now();
            _jeConnectionTestCache.set(key, {
                status: status,
                detail: detail || '',
                at: now
            });
            // Also persist to localStorage so the checklist can show "Last
            // tested <date>" after a page reload, instead of falling back
            // to "Configured — not yet verified" as if nothing was ever
            // checked. Wrapped in try/catch because localStorage is
            // best-effort (private mode, quota, disabled storage, etc.).
            try {
                localStorage.setItem('je_conn_test_' + key, JSON.stringify({
                    status: status,
                    detail: detail || '',
                    at: now
                }));
            } catch (e) { /* persistence is best-effort */ }
            try { m.whatsNew.renderChecklist(); } catch (e) {
                console.warn('[JE] renderChecklist threw after setConnectionTestResult:', e);
            }
        }

        /**
         * Read a previously-persisted test result for a connection key.
         * Returns null if no record, malformed JSON, or storage unavailable.
         * Unlike the in-memory cache there is NO TTL — the persisted entry
         * is meant to outlive page reloads so the admin always sees the
         * date of the most recent verification, however long ago it was.
         */
        function getPersistedTestResult(key: string) : ConnectionTestResult | null {
            var storageKey = 'je_conn_test_' + key;
            try {
                var raw = localStorage.getItem(storageKey);
                if (!raw) return null;
                var rec = JSON.parse(raw);
                if (!rec || typeof rec.at !== 'number' || typeof rec.status !== 'string') {
                    // Self-heal: drop the bad entry so subsequent renders don't keep
                    // re-parsing it and so the row falls cleanly back to "not tested".
                    try { localStorage.removeItem(storageKey); } catch (e) {}
                    return null;
                }
                return rec;
            } catch (e) {
                // Parse error → treat as corrupt and remove.
                try { localStorage.removeItem(storageKey); } catch (rmErr) {}
                return null;
            }
        }

        /**
         * Format a timestamp for the checklist's "Last tested" line:
         *   - same day  → "Last tested 3:45 PM"
         *   - other day → "Last tested Apr 20, 2026"
         */
        function formatLastTested(ts: number) : string {
            var d = new Date(ts);
            var now = new Date();
            if (d.toDateString() === now.toDateString()) {
                return 'Last tested ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
            }
            return 'Last tested ' + m.misc.formatDateDMY(d);
        }

        /**
         * Build a checklist row from cached / persisted test data.
         *  - Fresh in-memory hit  → row reflects the live status + detail
         *  - Persisted-only hit   → row keeps the last known state but
         *    swaps the detail line for "Last tested <date>"
         *  - No data              → row stays 'pending' with the supplied
         *    fallback text
         */
        function checklistRowState(cacheKey: string, fallbackDetail: string) : ChecklistRowState {
            var live = getConnectionTestResult(cacheKey);
            if (live) return { state: live.status, detail: live.detail };
            var persisted = getPersistedTestResult(cacheKey);
            if (persisted) return { state: persisted.status, detail: formatLastTested(persisted.at) };
            return { state: 'pending', detail: fallbackDetail };
        }

        /**
         * Read a test result from the cache. Returns null on miss OR on
         * expiry — callers render the row as "pending" in that case.
         */
        function getConnectionTestResult(key: string) : ConnectionTestResult | null {
            var entry = _jeConnectionTestCache.get(key);
            if (!entry) return null;
            if (Date.now() - entry.at > CONNECTION_TEST_CACHE_TTL_MS) {
                _jeConnectionTestCache.delete(key);
                return null;
            }
            return entry;
        }

        /**
         * Drop every cached result. Used by the Re-test-all Quick Action
         * so rows immediately show "pending" while tests fire.
         */
        function clearConnectionTestCache() : void {
            _jeConnectionTestCache.clear();
            _jeCacheGeneration++;
            // Also drop persisted entries; otherwise checklistRowState falls back
            // to the "Last tested <date>" line and rows stay green/red instead of
            // showing pending while the new tests fire.
            try {
                var doomed = [];
                for (var i = 0; i < localStorage.length; i++) {
                    var k = localStorage.key(i);
                    if (k && k.indexOf('je_conn_test_') === 0) doomed.push(k);
                }
                doomed.forEach(function(k) { localStorage.removeItem(k); });
            } catch (e) { /* private mode / quota — best-effort */ }
            try { m.whatsNew.renderChecklist(); } catch (e) {
                console.warn('[JE] renderChecklist threw after clearConnectionTestCache:', e);
            }
        }

        /**
         * Drop the persisted "Last tested <date>" entry for a given service when
         * the inputs that produced that test result change (new TMDB key, new Seerr
         * URL, etc.) — otherwise the checklist would keep claiming the old key
         * worked. Wired up in the load/change handlers for the relevant inputs.
         */
        function invalidatePersistedTest(key: string) : void {
            try { localStorage.removeItem('je_conn_test_' + key); } catch (e) {}
            // Clear in-memory copy too so the row immediately drops to pending.
            _jeConnectionTestCache.delete(key);
            try { m.whatsNew.renderChecklist(); } catch (e) {}
        }

        /**
         * Normalize an arr-instance URL into a cache key fragment.
         * Trim, lowercase, strip trailing slashes so minor differences
         * don't fork the cache.
         */
        function _jeNormalizeArrUrl(url: string) : string {
            return (url || '').trim().toLowerCase().replace(/\/+$/, '');
        }

    /** Runs this module's start-up work, in the page's original order. */
    function wire(): void {

    }

    return {
        wire,
        _jeNormalizeArrUrl,
        get _jeSuppressTestAlerts() { return _jeSuppressTestAlerts; },
        set _jeSuppressTestAlerts(value) { _jeSuppressTestAlerts = value; },
        beginConnectionTest,
        checklistRowState,
        clearConnectionTestCache,
        invalidatePersistedTest,
        jeTestAlert,
        setConnectionTestResult,
    };
}
