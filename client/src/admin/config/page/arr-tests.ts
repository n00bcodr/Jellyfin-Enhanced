import type { PageModules } from './modules';
import { shown } from '../domain/config';
import { requestFailureWithBody, type RequestFailure } from '../domain/http';
import { needControl, needHtml } from './dom';

/** Dependencies this module calls; members are resolved lazily, after every module exists. */
export type ArrTestsDeps = Pick<PageModules, 'context' | 'connections' | 'gatedHelp'>;

export function createArrTests(m: ArrTestsDeps) {
    const { ApiClient, Dashboard } = m.context;

        // === Arr Service Test Buttons ===

        /**
         * Produces a user-friendly error message from a connection test failure.
         * @param {Object} error - The ajax error object with a status property
         * @param {string} serviceName - Display name of the service
         * @param {string} url - The URL that was tested
         * @returns {string} Human-readable error message
         */
        function connectionErrorMessage(failure: RequestFailure, serviceName: string, url: string): string {
            // surface backend's typed code/cf-ray so admins
            // see actionable messages (HtmlResponse, Cloudflare5xx, etc.)
            // instead of "API key rejected" for everything.
            // Jellyfin's ApiClient.ajax errors don't expose responseJSON;
            // they expose responseText. Parse it ourselves.
            var body = failure.body;
            if (body && body.code && body.message) {
                var prefix = body.cfRay ? '[' + serviceName + ' cf-ray=' + shown(body.cfRay) + '] ' : '';
                return prefix + shown(body.message);
            }
            if (failure.status === 502) return 'Could not reach ' + url + '. Check the URL is correct and ' + serviceName + ' is running.';
            if (failure.status === 504) return 'Connection timed out. The server may be unreachable.';
            if (failure.status === 401) return 'The API key was rejected. Check the key is correct.';
            if (failure.status === 403) return 'Permission denied. Check the API key has the correct permissions, or that CSRF protection is not enabled in ' + serviceName + '.';
            if (failure.status === 400) return 'Missing URL or API key.';
            if (failure.status === 404) return 'The URL responded but did not look like a valid ' + serviceName + ' instance (HTTP 404 on /api/v1/user). It may be a reverse-proxy auth challenge.';
            return 'Connection to ' + serviceName + ' failed (error ' + (failure.status || 'unknown') + ').';
        }

        async function testInstanceConnection(card: HTMLElement) : Promise<void> {
            var type = card.dataset.type;
            var urlVal = (needControl(card.querySelector('.arr-instance-url')).value || '').trim();
            var apiKeyVal = (needControl(card.querySelector('.arr-instance-apikey')).value || '').trim();
            var nameVal = needControl(card.querySelector('.arr-instance-name')).value.trim() || (type === 'sonarr' ? 'Sonarr' : 'Radarr');
            var btn = needControl(card.querySelector('.arr-instance-test'));
            var indicator = needHtml(card.querySelector('.arr-instance-status'));

            if (!urlVal || !apiKeyVal) {
                Dashboard.alert({ title: 'Missing Information', message: 'Please provide both a URL and API key to test the connection.' });
                return;
            }

            var _testToken = m.connections.beginConnectionTest();
            btn.disabled = true;
            indicator.textContent = 'sync';
            // Don't wipe the indicator's class wholesale with `className = ...` —
            // that drops `arr-instance-status`, the identifier used to re-query
            // this element on subsequent Test clicks. classList.add leaves the
            // identifier class intact so repeated tests on the same card work.
            indicator.classList.add('status-check');
            indicator.style.color = 'var(--primary-accent-color, #00a4dc)';

            var arrCacheKey = type + ':' + m.connections._jeNormalizeArrUrl(urlVal);
            try {
                var endpoint = type === 'sonarr' ? 'sonarr' : 'radarr';
                var validationUrl = ApiClient.getUrl('/JellyfinEnhanced/arr/validate/' + endpoint, { url: urlVal });
                await ApiClient.ajax({ type: 'GET', url: validationUrl, dataType: 'json', headers: { 'X-Arr-ApiKey': apiKeyVal } });

                indicator.textContent = 'check_circle';
                indicator.style.color = '#52b54b';
                indicator.classList.remove('status-check');
                try { m.connections.setConnectionTestResult(arrCacheKey, 'ok', 'Connected', _testToken); } catch (err) { /* cache is best-effort */ }
                m.connections.jeTestAlert({ title: 'Success', message: 'Successfully connected to ' + nameVal + '!' });
            } catch (e) {
                indicator.classList.remove('status-check');
                indicator.textContent = 'error';
                indicator.style.color = '#dc3545';

                const failed = await requestFailureWithBody(e);
                var msg = connectionErrorMessage(failed, nameVal, urlVal);
                try {
                    var shortArrDetail = failed.status === 401 ? 'API key rejected'
                        : (failed.status === 500 || failed.status === 0 || !failed.status) ? 'Unreachable'
                        : 'Error ' + failed.status;
                    m.connections.setConnectionTestResult(arrCacheKey, 'error', shortArrDetail, _testToken);
                } catch (err) { /* cache is best-effort */ }
                m.connections.jeTestAlert({ title: 'Connection Failed', message: msg });
            } finally {
                btn.disabled = false;
            }

            m.gatedHelp.updateAllDependencies();
        }

    /** Runs this module's start-up work, in the page's original order. */
    function wire(): void {

    }

    return {
        wire,
        connectionErrorMessage,
        testInstanceConnection,
    };
}
