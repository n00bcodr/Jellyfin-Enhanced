import type { PageModules } from './modules';
import { asObject } from '../domain/config';
import { requestFailure, requestFailureWithBody } from '../domain/http';
import { asHtml, closestTo, needControl, needHtml } from './dom';

/** Dependencies this module calls; members are resolved lazily, after every module exists. */
export type ProbesDeps = Pick<PageModules, 'context' | 'arrTests' | 'connections' | 'gatedHelp'>;

export function createProbes(m: ProbesDeps) {
    const { ApiClient, Dashboard } = m.context;

            const testJellyseerrBtn = needControl(document.getElementById('testJellyseerrBtn'));

            const jellyseerrStatusIndicator = needHtml(document.getElementById('jellyseerrStatusIndicator'));

            const tmdbStatusIndicator = asHtml(document.getElementById('tmdbStatusIndicator'));

        async function testJellyseerrConnection() : Promise<void> {
            const urls = (needControl(document.querySelector('#jellyseerrUrls')).value || '').split('\n').map(u => u.trim()).filter(Boolean);
            const apiKey = (needControl(document.querySelector('#JellyseerrApiKey')).value || '').trim();

            if (!urls.length || !apiKey) {
                Dashboard.alert({ title: 'Missing Information', message: 'Please provide at least one Seerr URL and an API key to test the connection.' });
                return;
            }

            const _testToken = m.connections.beginConnectionTest();
            testJellyseerrBtn.disabled = true;
            jellyseerrStatusIndicator.textContent = 'sync';
            jellyseerrStatusIndicator.classList.add('status-check');
            jellyseerrStatusIndicator.style.color = 'var(--primary-accent-color, #00a4dc)';

            let validated = false;
            let lastError = '';
            for (const url of urls) {
                try {
                    const validationUrl = ApiClient.getUrl(`/JellyfinEnhanced/jellyseerr/validate`, {
                        url: url
                    });

                    const res = await ApiClient.ajax({ type: 'GET', url: validationUrl, dataType: 'json', headers: { 'X-Arr-ApiKey': apiKey } });

                    if (asObject(res).ok) {
                        validated = true;
                        break;
                    }
                } catch (e) {
                    console.error(`Seerr validation failed for ${url}:`, e);
                    lastError = m.arrTests.connectionErrorMessage(await requestFailureWithBody(e), 'Seerr', url);
                }
            }

            testJellyseerrBtn.disabled = false;
            jellyseerrStatusIndicator.classList.remove('status-check');

            if (validated) {
                jellyseerrStatusIndicator.textContent = 'check_circle';
                jellyseerrStatusIndicator.style.color = '#52b54b';
                try { m.connections.setConnectionTestResult('seerr', 'ok', 'Connected', _testToken); } catch (e) { /* cache is best-effort */ }
                m.connections.jeTestAlert({ title: 'Success', message: 'Successfully connected to Seerr!' });
            } else {
                jellyseerrStatusIndicator.textContent = 'error';
                jellyseerrStatusIndicator.style.color = '#dc3545';
                try { m.connections.setConnectionTestResult('seerr', 'error', (lastError && lastError.length < 80) ? lastError : 'Connection failed', _testToken); } catch (e) { /* cache is best-effort */ }
                m.connections.jeTestAlert({ title: 'Connection Failed', message: lastError || 'Could not connect to any provided URL.' });
            }
        }

        async function runTmdbTest(event: Event): Promise<void> {
            const apiKey = (needControl(document.querySelector('#TMDB_API_KEY')).value || '').trim();

            if (!apiKey) {
                Dashboard.alert({ title: 'Missing Information', message: 'Please provide a TMDB API key to test the connection.' });
                return;
            }

            const _testToken = m.connections.beginConnectionTest();

            // Determine which status indicator to update based on button context
            const button = closestTo(event, 'button');
            const statusIndicator = asHtml(button?.parentElement?.querySelector('.material-icons') ?? null) ?? needHtml(tmdbStatusIndicator);

            // Disable all test buttons during the test
            const allTestButtons = document.querySelectorAll<HTMLButtonElement>('.testTmdbBtn');
            allTestButtons.forEach(btn => btn.disabled = true);

            statusIndicator.textContent = 'sync';
            statusIndicator.classList.add('status-check');
            statusIndicator.style.color = 'var(--primary-accent-color, #00a4dc)';

            try {
                const validationUrl = ApiClient.getUrl(`/JellyfinEnhanced/tmdb/validate`, { apiKey: apiKey });
                await ApiClient.ajax({ type: 'GET', url: validationUrl });

                statusIndicator.textContent = 'check_circle';
                statusIndicator.style.color = '#52b54b';
                try { m.connections.setConnectionTestResult('tmdb', 'ok', 'API key valid', _testToken); } catch (err) { /* cache is best-effort */ }
                m.connections.jeTestAlert({ title: 'Success', message: 'Successfully connected to TMDB!' });

            } catch (e) {
                console.error('TMDB validation failed:', e);
                const status = requestFailure(e).status;
                var errorMessage: string;
                if (status === 401) {
                    errorMessage = 'The API key is invalid. Check that you copied it correctly.';
                } else if (status === 500 || status === 0 || !status) {
                    errorMessage = 'Could not reach TMDB servers. Check your network connection.';
                } else {
                    errorMessage = 'Connection failed (error ' + status + '). Check the key and your network.';
                }

                statusIndicator.textContent = 'error';
                statusIndicator.style.color = '#dc3545';
                try {
                    var shortDetail = status === 401 ? 'API key rejected'
                        : (status === 500 || status === 0 || !status) ? 'Unreachable'
                        : 'Error ' + status;
                    m.connections.setConnectionTestResult('tmdb', 'error', shortDetail, _testToken);
                } catch (err) { /* cache is best-effort */ }
                m.connections.jeTestAlert({ title: 'Connection Failed', message: errorMessage });
            } finally {
                allTestButtons.forEach(btn => btn.disabled = false);
                if (statusIndicator) {
                    statusIndicator.classList.remove('status-check');
                }
            }
        }

    /** The dependency gates read the result, so they refresh after every test. */
    async function testTmdbConnection(event: Event): Promise<void> {
        await runTmdbTest(event);
        m.gatedHelp.updateAllDependencies();
    }

    /** Runs this module's start-up work, in the page's original order. */
    function wire(): void {

    }

    return {
        wire,
        testJellyseerrBtn,
        testJellyseerrConnection,
        testTmdbConnection,
    };
}
