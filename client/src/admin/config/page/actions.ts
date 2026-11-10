import type { PageModules } from './modules';
import { isAbortError, requestFailureWithBody } from '../domain/http';
import type { WriteScope } from '../domain/write-scope';
import { asObject } from '../domain/config';
import { asControl, asHtml, asInput, needControl, needHtml } from './dom';

/** Dependencies this module calls; members are resolved lazily, after every module exists. */
export type ActionsDeps = Pick<PageModules, 'context' | 'arrTests' | 'connections' | 'displayCards' | 'mediaTagsTab' | 'probes' | 'serviceStatus' | 'whatsNew'>;

export function createActions(m: ActionsDeps) {
    const { ApiClient, Dashboard, JEAdmin, pluginId } = m.context;

        /** Ask every client to drop its tag caches on its next load (Overview quick action), inside jeHoldMediaTags as Save. */
        function jeClearClientTagCaches(): Promise<void> {
            return m.mediaTagsTab.jeRunHeldWrite(jeClearClientTagCachesNow);
        }

        async function jeClearClientTagCachesNow(scope: WriteScope) : Promise<void> {
            if (await JEAdmin.confirm("Clear all client caches?\n\nThis will force all clients to clear their quality and genre tag caches on next page load.")) {
                scope.throwIfStale();
                Dashboard.showLoadingMsg();
                try {
                    const config = await ApiClient.getPluginConfiguration(pluginId);
                    scope.throwIfStale();
                    config.ClearLocalStorageTimestamp = Date.now();
                    await ApiClient.updatePluginConfiguration(pluginId, config);
                    scope.throwIfStale();
                    Dashboard.hideLoadingMsg();
                    Dashboard.alert({
                        title: 'Success',
                        message: 'Cache clear signal sent. All clients will clear their caches on next page load.'
                    });
                } catch (e) {
                    Dashboard.hideLoadingMsg();
                    if (isAbortError(e)) throw e;
                    console.error('Failed to set cache clear timestamp:', e);
                    Dashboard.alert({
                        title: 'Error',
                        message: 'Failed to set cache clear timestamp. Check server logs for details.'
                    });
                }
            }
        }

        async function triggerSeerrScanNow() : Promise<void> {
            const urls = (needControl(document.querySelector('#jellyseerrUrls')).value || '').split('\n').map(u => u.trim()).filter(Boolean);
            const apiKey = (needControl(document.querySelector('#JellyseerrApiKey')).value || '').trim();
            const btn = needControl(document.querySelector('#triggerSeerrScanNowBtn'));
            const status = needHtml(document.querySelector('#triggerSeerrScanNowStatus'));

            if (!urls.length || !apiKey) {
                Dashboard.alert({ title: 'Missing Information', message: 'Please provide at least one Seerr URL and an API key in the Setup section above.' });
                return;
            }

            btn.disabled = true;
            status.textContent = 'sync';
            status.className = 'material-icons status-check';
            status.style.color = '#00a4dc';

            let triggered = false;
            let lastError = '';
            for (const url of urls) {
                try {
                    const triggerUrl = ApiClient.getUrl('/JellyfinEnhanced/jellyseerr/trigger-recently-added-scan', { url: url });
                    const res = await ApiClient.ajax({ type: 'POST', url: triggerUrl, dataType: 'json', headers: { 'X-Arr-ApiKey': apiKey } });
                    if (asObject(res).ok) {
                        triggered = true;
                        break;
                    }
                } catch (e) {
                    console.error('Seerr scan trigger failed for ' + url + ':', e);
                    lastError = m.arrTests.connectionErrorMessage(await requestFailureWithBody(e), 'Seerr', url);
                }
            }

            btn.disabled = false;
            status.classList.remove('status-check');

            if (triggered) {
                status.textContent = 'check_circle';
                status.style.color = '#52b54b';
                Dashboard.alert({ title: 'Scan Triggered', message: 'Triggered "Jellyfin Recently Added Scan" in Seerr' });
            } else {
                status.textContent = 'error';
                status.style.color = '#dc3545';
                Dashboard.alert({ title: 'Trigger Failed', message: lastError || 'Could not trigger a scan against any provided URL.' });
            }
        }

        /**
         * Quick Action: re-test every external-service connection by proxying
         * clicks to the existing per-service test buttons. Preserves the per-
         * button UX (spinners, toasts, status-card updates) without duplicating
         * logic. Does NOT fabricate a cache — Phase 4 layers a real test cache
         * on top.
         *
         * Services invoked:
         *   - TMDB: one `.testTmdbBtn` click (multiple copies exist across tabs
         *     but any one test updates the shared status card)
         *   - Seerr: `#testJellyseerrBtn` when Seerr is enabled + URL + key set
         *   - Sonarr / Radarr: every `.arr-instance-test` inside the instance
         *     lists that has a URL + API key populated
         *
         * Skipping an unconfigured service is intentional — clicking a test
         * button with empty fields would pop a Dashboard.alert per service,
         * which is noisy for a "one-shot retest" action.
         */
        // Client-side throttle + in-flight lock for the Re-test-all batch.
        // The button is disabled for the full cooldown window so rapid
        // clicks can't fire ~8 parallel external-API tests per click. This
        // is NOT a security boundary — a determined user could still spam
        // via devtools — it's a guardrail against well-intentioned double-
        // clicks and page-reload retries.
        // Minimum time the Re-test-all button stays disabled even if every
        // test finishes instantly. Acts as the rate-limit floor so rapid
        // re-clicks can't fire dozens of external API tests per second.
        var RETEST_ALL_MIN_COOLDOWN_MS = 4 * 1000;

        // Hard upper bound for the polling loop. If a test still hasn't
        // resolved after this long, we force-release anyway so the UI
        // doesn't sit "Retesting…" forever on a hung connection.
        var RETEST_ALL_MAX_WAIT_MS = 25 * 1000;

        var _jeRetestAllCooldownUntil = 0;

        var _jeRetestAllReenableTimer: ReturnType<typeof setTimeout> | undefined;

        var _jeRetestAllPollTimer: ReturnType<typeof setInterval> | undefined;

        function _setRetestAllButtonLabel(btn: HTMLElement, text: string) : void {
            if (!btn) return;
            var labelEl = asHtml(btn.querySelector('.je-quick-action-title'));
            if (labelEl) labelEl.textContent = text;
        }

        const retestAllConnectionsBtn = asControl(document.getElementById('retestAllConnectionsBtn'));

        /**
         * Quick Action: clear every client's tag caches (the same signal as
         * the Media Tags tab's Server section sends).
         */
        var clearTagCachesQuickBtn = asHtml(document.getElementById('clearTagCachesQuickBtn'));

        /**
         * Syncs the "Clear all client tag caches" quick-action button visibility
         * with the server-mode toggle — it's only relevant when server-side cache
         * is disabled.
         */
        function updateClearTagCachesQuickBtnVisibility() : void {
            if (!clearTagCachesQuickBtn || !m.displayCards._jeMediaTagsConfig) return;
            clearTagCachesQuickBtn.style.display = m.displayCards._jeMediaTagsConfig.TagCacheServerMode !== false ? 'none' : '';
        }

    /** Runs this module's start-up work, in the page's original order. */
    function wire(): void {
        m.probes.testJellyseerrBtn.addEventListener('click', m.probes.testJellyseerrConnection);

        needHtml(document.querySelector('#triggerSeerrScanNowBtn')).addEventListener('click', triggerSeerrScanNow);

        if (retestAllConnectionsBtn) {
            const retestButton = retestAllConnectionsBtn;
            const retestTitle = retestButton.querySelector('.je-quick-action-title');
            const _retestAllOriginalLabel = retestTitle ? retestTitle.textContent ?? '' : 'Re-test all service connections';

            retestAllConnectionsBtn.addEventListener('click', function() {
                // Throttle: block rapid re-clicks within the cooldown window.
                var now = Date.now();
                if (now < _jeRetestAllCooldownUntil) {
                    var remainSec = Math.ceil((_jeRetestAllCooldownUntil - now) / 1000);
                    try {
                        Dashboard.alert({
                            title: 'Please wait',
                            message: 'Re-test is rate-limited. Try again in ' + remainSec + ' s.'
                        });
                    } catch (e) { /* ignore */ }
                    return;
                }

                // Invalidate the cache up front so every checklist row flips
                // to "pending" immediately; the individual test handlers will
                // repopulate it as they finish.
                try { m.connections.clearConnectionTestCache(); } catch (e) { /* renderChecklist logs */ }

                // Suppress per-test Dashboard.alert dialogs for the duration
                // of this batch — per-service indicators + the Integration
                // Health rows already communicate results.
                m.connections._jeSuppressTestAlerts = true;
                _jeRetestAllCooldownUntil = now + RETEST_ALL_MIN_COOLDOWN_MS;
                retestAllConnectionsBtn.disabled = true;
                _setRetestAllButtonLabel(retestAllConnectionsBtn, 'Retesting…');

                var tested = 0;

                // TMDB — one click is enough; pages share the same backing key
                var tmdbBtn = asControl(document.querySelector('.testTmdbBtn'));
                if (tmdbBtn && !tmdbBtn.disabled) { tmdbBtn.click(); tested++; }

                // Seerr — only if enabled with a URL + key (otherwise button
                // would show a "missing info" toast, which is noisy for a
                // batch re-test action).
                var seerrEnabled = asInput(document.querySelector('#jellyseerrEnabled'));
                var seerrUrls = asControl(document.querySelector('#jellyseerrUrls'));
                var seerrKey = asControl(document.querySelector('#JellyseerrApiKey'));
                if (seerrEnabled && seerrEnabled.checked
                    && seerrUrls && seerrUrls.value.trim()
                    && seerrKey && seerrKey.value.trim()
                    && m.probes.testJellyseerrBtn && !m.probes.testJellyseerrBtn.disabled) {
                    m.probes.testJellyseerrBtn.click();
                    tested++;
                }

                // Sonarr / Radarr — per-instance tests. The per-instance test
                // function itself guards against empty URL/API-key, so we
                // don't need to re-check here; we just skip already-disabled
                // buttons (mid-flight tests).
                var arrBtns = document.querySelectorAll<HTMLElement>('.arr-instance-test');
                arrBtns.forEach(function(btn) {
                    var card = btn.closest('.arr-instance-card');
                    if (!card) return;
                    var urlEl = asControl(card.querySelector('.arr-instance-url'));
                    var keyEl = asControl(card.querySelector('.arr-instance-apikey'));
                    if (!urlEl || !keyEl) return;
                    if (!urlEl.value.trim() || !keyEl.value.trim()) return;
                    if (retestButton.disabled) return;
                    btn.click();
                    tested++;
                });

                // Always refresh the dashboard dots so the user sees feedback
                // even when no service was re-tested.
                try { m.serviceStatus.updateStatusDashboard(); } catch (e) { /* logged inside */ }

                if (tested === 0) {
                    m.connections._jeSuppressTestAlerts = false;
                    retestButton.disabled = false;
                    _setRetestAllButtonLabel(retestButton, _retestAllOriginalLabel);
                    _jeRetestAllCooldownUntil = 0; // reset cooldown — nothing fired
                    try {
                        Dashboard.alert({
                            title: 'Nothing to re-test',
                            message: 'Enable and configure at least one service (TMDB, Seerr, Sonarr, or Radarr) before running a re-test.'
                        });
                    } catch (e) { /* ignore */ }
                    return;
                }

                // The individual test functions don't return promises
                // (they're event handlers fired via .click()), so we poll
                // the DOM for the "in-flight" signal each test sets on
                // start: the `.status-check` class on its status indicator.
                // When no indicators still carry that class, every test
                // has resolved — release the button immediately. Falls
                // back to a hard max-wait so a hung request doesn't leave
                // the button stuck on "Retesting…".
                clearTimeout(_jeRetestAllReenableTimer);
                clearInterval(_jeRetestAllPollTimer);
                var batchStartedAt = Date.now();
                function releaseRetestBatch() {
                    clearInterval(_jeRetestAllPollTimer);
                    clearTimeout(_jeRetestAllReenableTimer);
                    m.connections._jeSuppressTestAlerts = false;
                    retestButton.disabled = false;
                    _setRetestAllButtonLabel(retestButton, _retestAllOriginalLabel);
                    try { m.whatsNew.renderChecklist(); } catch (e) { /* logged */ }
                }
                _jeRetestAllPollTimer = setInterval(function() {
                    var elapsed = Date.now() - batchStartedAt;
                    // `.status-check` is applied on test START and removed on
                    // test RESOLVE (success or failure), so it's an accurate
                    // "in-flight" signal for the three test functions.
                    var inFlight = document.querySelectorAll<HTMLElement>('.status-check').length;
                    // Release when BOTH:
                    //  - no tests still in flight (UI has caught up), and
                    //  - the min-cooldown floor has elapsed (rate limit).
                    // The floor ensures a user who hits retest-all with zero
                    // real tests configured still has the button disabled long
                    // enough to prevent double-run, and covers the first-tick
                    // race where indicators haven't swapped to 'sync' yet.
                    if (inFlight === 0 && elapsed >= RETEST_ALL_MIN_COOLDOWN_MS) {
                        releaseRetestBatch();
                    } else if (elapsed >= RETEST_ALL_MAX_WAIT_MS) {
                        console.warn('[JE] retest-all: giving up on ' + inFlight + ' in-flight test(s) after ' + elapsed + 'ms');
                        releaseRetestBatch();
                    }
                }, 300);
                // Hard-stop safety net in case setInterval is suspended
                // (backgrounded tab, browser throttling, etc.).
                _jeRetestAllReenableTimer = setTimeout(releaseRetestBatch, RETEST_ALL_MAX_WAIT_MS + 500);
            });
        }

        if (clearTagCachesQuickBtn) {
            clearTagCachesQuickBtn.addEventListener('click', jeClearClientTagCaches);
        }
    }

    return {
        wire,
        updateClearTagCachesQuickBtnVisibility,
    };
}
