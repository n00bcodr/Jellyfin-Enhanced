import { mediaTagsSurface, publishTestedPluginLinks } from '../../../host/admin-config-host';
import type { PageModules } from './modules';
import { asObject, num, shown, text } from '../domain/config';
import type { CustomPluginLink } from '../../../host/admin-config-host';
import { requestFailure } from '../domain/http';
import { asControl, asHtml, needControl, needHtml } from './dom';

/** Dependencies this module calls; members are resolved lazily, after every module exists. */
export type MiscDeps = Pick<PageModules, 'context' | 'load' | 'probes'>;

export function createMisc(m: MiscDeps) {
    const { ApiClient, Dashboard } = m.context;

        // Custom Plugin Links functionality
        const testCustomPluginLinksBtn = asHtml(document.getElementById('testCustomPluginLinksBtn'));

        const customPluginLinksTextarea = needControl(document.getElementById('customPluginLinks'));

        // Shared date formatting for the whole config page, explicit instead
        // of toLocaleString()/toLocaleDateString() so display doesn't vary by
        // the admin's browser locale. Function declarations hoist through this
        // file's single top-level IIFE, so these are callable from anywhere in
        // it regardless of where they're defined relative to the call site.
        var JE_DATE_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

        /** Formats a Date as "DD-MMM-YYYY" (e.g. "28-Aug-2026"). */
        function formatDateDMY(d: Date) : string {
            var day = String(d.getDate()).padStart(2, '0');
            var month = JE_DATE_MONTHS[d.getMonth()];
            return day + '-' + month + '-' + d.getFullYear();
        }

        /** Formats a Date as "DD-MMM-YYYY, HH:MM AM/PM" (e.g. "28-Aug-2026, 12:02 AM"). */
        function formatDateTimeDMY(d: Date) : string {
            var hours24 = d.getHours();
            var ampm = hours24 >= 12 ? 'PM' : 'AM';
            var hours12 = hours24 % 12 || 12;
            var minutes = String(d.getMinutes()).padStart(2, '0');
            return formatDateDMY(d) + ', ' + hours12 + ':' + minutes + ' ' + ampm;
        }

        /**
         * Fetches and displays live MDBList account/quota status. Tests
         * whatever's currently typed in the API key field (even if unsaved),
         * mirroring testTmdbConnection -- lets the admin verify a key before
         * hitting Save. Falls back to the saved key if the field is empty.
         */
        async function checkMdblistStatus() : Promise<void> {
            const statusLine = asHtml(document.getElementById('mdblistStatusLine'));
            const statusIndicator = asHtml(document.getElementById('mdblistStatusIndicator'));
            const apiKey = (asControl(document.querySelector('#mdblistApiKey'))?.value || '').trim();

            if (statusIndicator) {
                statusIndicator.textContent = 'sync';
                statusIndicator.classList.add('status-check');
                statusIndicator.style.color = 'var(--primary-accent-color, #00a4dc)';
            }
            if (statusLine) statusLine.textContent = 'Checking...';

            try {
                // The route checks the saved key when it gets none: only a typed key not saved yet goes in the
                // address (the route takes the key from the query string alone), and the saved key stays out of logs.
                const unsaved = apiKey && apiKey !== text(m.load.formBase.MdblistApiKey).trim();
                const url = ApiClient.getUrl('/JellyfinEnhanced/mdblist-ratings/account-status', unsaved ? { apiKey: apiKey } : {});
                const status = asObject(await ApiClient.ajax({ type: 'GET', url: url, dataType: 'json' }));

                if (statusIndicator) {
                    statusIndicator.textContent = 'check_circle';
                    statusIndicator.style.color = '#52b54b';
                }
                if (statusLine) {
                    var remaining = status.RateLimitRemaining != null ? shown(status.RateLimitRemaining) : '?';
                    var limit = status.RateLimit != null ? shown(status.RateLimit) : '?';
                    var plan = status.Plan ? shown(status.Plan) : 'Free';
                    var resetSeconds = num(status.RateLimitResetUnixSeconds);
                    var resetDate = new Date(resetSeconds * 1000);
                    var resetText = (isFinite(resetDate.getTime()) && resetSeconds > 0) ? formatDateTimeDMY(resetDate) : 'unknown';
                    statusLine.textContent = remaining + ' / ' + limit + ' requests remaining today (' + plan + ' plan) · resets ' + resetText;
                }
            } catch (e) {
                if (statusIndicator) {
                    statusIndicator.textContent = 'error';
                    statusIndicator.style.color = '#dc3545';
                }
                if (statusLine) {
                    const failedStatus = requestFailure(e).status;
                    statusLine.textContent = failedStatus === 503
                        ? 'Enter an API key to check status.'
                        : failedStatus === 502
                            ? 'Could not reach MDBList - key may be invalid.'
                            : 'Could not check MDBList account status.';
                }
            } finally {
                if (statusIndicator) statusIndicator.classList.remove('status-check');
            }
        }

        // Fallback copy method
        function fallbackCopy(text: string, btn: HTMLElement, btnText: HTMLElement): void {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            try {
                document.execCommand('copy');
                btnText.textContent = 'Copied!';
                btn.style.color = '#4CAF50';
                setTimeout(function() {
                    btnText.textContent = 'Copy';
                    btn.style.color = '';
                }, 2000);
            } catch (err) {
                console.error('Fallback copy failed: ', err);
                alert('Failed to copy to clipboard');
            }
            document.body.removeChild(textarea);
        }

    /** Runs this module's start-up work, in the page's original order. */
    function wire(): void {
        if (testCustomPluginLinksBtn) {
            testCustomPluginLinksBtn.addEventListener('click', async () => {
                const linksText = customPluginLinksTextarea.value.trim();
                if (!linksText) {
                    Dashboard.alert({
                        title: 'No Links',
                        message: 'Please add some custom plugin links first.'
                    });
                    return;
                }

                // Parse and validate the links
                const lines = linksText.split('\n');
                const validLinks: CustomPluginLink[] = [];
                const invalidLines: string[] = [];

                lines.forEach((line, index) => {
                    const trimmedLine = line.trim();
                    if (!trimmedLine) return;

                    const parts = trimmedLine.split('|').map(part => part.trim());
                    if (parts.length >= 2 && parts[0] && parts[1]) {
                        validLinks.push({ name: parts[0], icon: parts[1] });
                    } else {
                        invalidLines.push(`Line ${index + 1}: "${trimmedLine}"`);
                    }
                });

                if (invalidLines.length > 0) {
                    Dashboard.alert({
                        title: 'Invalid Format',
                        message: `The following lines have invalid format:\n\n${invalidLines.join('\n')}\n\nPlease use the format: Configuration Page Name | icon_name`
                    });
                    return;
                }

                if (validLinks.length === 0) {
                    Dashboard.alert({
                        title: 'No Valid Links',
                        message: 'No valid plugin links found. Please check the format.'
                    });
                    return;
                }

                // Test the links by temporarily adding them to the sidebar
                // Trigger the plugin icons script to refresh with test data
                const customPlugins = mediaTagsSurface()?.customPlugins;
                if (customPlugins) {
                    // Temporarily store test data
                    publishTestedPluginLinks(validLinks);
                    customPlugins.refresh?.();
                }
            });
        }

        // click handlers to all TMDB test buttons
        document.querySelectorAll<HTMLElement>('.testTmdbBtn').forEach(btn => {
            btn.addEventListener('click', m.probes.testTmdbConnection);
        });

        asHtml(document.getElementById('checkMdblistStatusBtn'))?.addEventListener('click', checkMdblistStatus);

        // Copy button handler for HTML code snippets
        document.querySelectorAll<HTMLElement>('.je-copy-html-btn').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();

                const htmlCode = btn.getAttribute('data-copy-text') ?? '';
                const btnText = needHtml(btn.querySelector('.copy-btn-text'));

                // Try clipboard API first
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(htmlCode).then(function() {
                        btnText.textContent = 'Copied!';
                        btn.style.color = '#4CAF50';
                        setTimeout(function() {
                            btnText.textContent = 'Copy';
                            btn.style.color = '';
                        }, 2000);
                    }).catch(function(err) {
                        console.error('Clipboard API failed: ', err);
                        fallbackCopy(htmlCode, btn, btnText);
                    });
                } else {
                    // Fallback for older browsers
                    fallbackCopy(htmlCode, btn, btnText);
                }
            });
        });
    }

    return {
        wire,
        checkMdblistStatus,
        formatDateDMY,
        formatDateTimeDMY,
    };
}
