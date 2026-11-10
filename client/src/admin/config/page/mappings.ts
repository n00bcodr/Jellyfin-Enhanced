import type { PageModules } from './modules';
import { asControl, asHtml, asSelect, needControl, needHtml } from './dom';
import type { ArrType, MappingDef } from './types';

/** Dependencies this module calls; members are resolved lazily, after every module exists. */
export type MappingsDeps = Pick<PageModules, 'context'>;

export function createMappings(m: MappingsDeps) {
    const { Dashboard } = m.context;

        // === URL Mapping Validation ===
        /**
         * Appends an issue message div to a validation result container.
         * @param {HTMLElement} container - The container element to append to
         * @param {string} text - The issue message text
         */
        function addIssue(container: HTMLElement, text: string) : void {
            var div = document.createElement('div');
            div.style.cssText = 'margin-bottom: 0.5em;';
            div.textContent = text;
            container.appendChild(div);
        }

        /**
         * Validates URL mapping entries for syntactic correctness.
         * @param {Array<Object>} mappingDefs - Array of mapping definitions with inputId and expectedService
         * @param {string} btnId - DOM id of the validate button
         * @param {string} resultDivId - DOM id of the results container
         */
        async function validateMappingSet(mappingDefs: readonly MappingDef[], btnId: string, resultDivId: string) : Promise<void> {
            var btn = needControl(document.getElementById(btnId));
            var resultDiv = needHtml(document.getElementById(resultDivId));
            // Update button label safely whether the markup wraps the text
            // in a <span> (legacy emby-button pattern) or has bare text content.
            // The previous implementation assumed a <span> always existed and
            // threw `Cannot set properties of null` when it didn't, which silently
            // killed the rest of validation (button stayed disabled, result div
            // stayed empty, no error surfaced to the admin).
            function setBtnLabel(text: string): void {
                var span = asHtml(btn.querySelector('span'));
                if (span) span.textContent = text;
                else btn.textContent = text;
            }
            btn.disabled = true;
            setBtnLabel('Validating...');
            resultDiv.textContent = '';
            resultDiv.style.display = 'block';
            resultDiv.style.backgroundColor = 'color-mix(in srgb, var(--primary-accent-color, #00a4dc) 10%, transparent)';
            resultDiv.style.borderLeft = '4px solid var(--primary-accent-color, #00a4dc)';
            resultDiv.textContent = 'Testing URLs...';

            // Collect all pairs with basic format validation first
            var pairs: Array<{ left: string; right: string; service: string; label: string }> = [];
            var formatIssues: string[] = [];

            mappingDefs.forEach(function(m) {
                var textarea = asControl(document.getElementById(m.id));
                if (!textarea) return;
                textarea.value.split('\n').forEach(function(line, idx) {
                    var trimmed = line.trim();
                    if (!trimmed) return;
                    var lineLabel = m.service + ' line ' + (idx + 1);
                    var parts = trimmed.split('|');
                    if (parts.length !== 2) {
                        formatIssues.push(lineLabel + ': Invalid format. Use jellyfin_url|' + m.service.toLowerCase() + '_url separated by a pipe (|).');
                        return;
                    }
                    var left = (parts[0] ?? '').trim();
                    var right = (parts[1] ?? '').trim();
                    if (!left || !right) {
                        formatIssues.push(lineLabel + ': Both sides of the pipe must have a URL.');
                        return;
                    }
                    if (!left.match(/^https?:\/\//i)) {
                        formatIssues.push(lineLabel + ': Left side (' + left + ') should start with http:// or https://.');
                        return;
                    }
                    if (!right.match(/^https?:\/\//i)) {
                        formatIssues.push(lineLabel + ': Right side (' + right + ') should start with http:// or https://.');
                        return;
                    }
                    pairs.push({ left: left, right: right, service: m.service, label: lineLabel });
                });
            });

            if (formatIssues.length > 0 && pairs.length === 0) {
                resultDiv.textContent = '';
                resultDiv.style.backgroundColor = 'rgba(220, 53, 69, 0.15)';
                resultDiv.style.borderLeft = '4px solid #dc3545';
                formatIssues.forEach(function(i) { addIssue(resultDiv, i); });
                btn.disabled = false;
                setBtnLabel('Validate Mappings');
                return;
            }

            if (pairs.length === 0 && formatIssues.length === 0) {
                resultDiv.style.display = 'none';
                btn.disabled = false;
                setBtnLabel('Validate Mappings');
                return;
            }

            // Syntax-only validation: ensure each URL parses as a valid URL
            // and that the two sides of a mapping aren't identical. We used to
            // probe each URL server-side (and fall back to a browser probe) and
            // identify whether the far end was actually Sonarr/Radarr/Jellyfin/…
            // but mappings are only used to rewrite link hrefs, so "is this
            // URL parseable and distinct from its pair" is the only thing that
            // actually needs to hold. Probing breaks for anyone behind an auth
            // proxy (Authentik, Authelia, Cloudflare Access, …) because the
            // backend never reaches the service to identify it.
            var issues = formatIssues.slice();
            var warnings: string[] = [];
            var good = 0;

            pairs.forEach(function(p) {
                var leftTrim  = p.left.replace(/\/+$/, '');
                var rightTrim = p.right.replace(/\/+$/, '');

                function urlOk(u: string): boolean {
                    try { var parsed = new URL(u); return !!parsed.host; }
                    catch (e) { return false; }
                }

                if (!urlOk(p.left)) {
                    issues.push(p.label + ': Left side (' + p.left + ') is not a valid URL.');
                    return;
                }
                if (!urlOk(p.right)) {
                    issues.push(p.label + ': Right side (' + p.right + ') is not a valid URL.');
                    return;
                }
                if (leftTrim.toLowerCase() === rightTrim.toLowerCase()) {
                    issues.push(p.label + ': Both sides are the same URL. Left should be Jellyfin, right should be ' + p.service + '.');
                    return;
                }

                good++;
            });

            // Display results
            resultDiv.textContent = '';
            if (issues.length === 0 && warnings.length === 0) {
                resultDiv.style.backgroundColor = 'rgba(82, 181, 75, 0.15)';
                resultDiv.style.borderLeft = '4px solid #52b54b';
                var icon = document.createElement('i');
                icon.className = 'material-icons';
                icon.style.cssText = 'vertical-align: middle; color: #52b54b; margin-right: 0.5em;';
                icon.textContent = 'check_circle';
                resultDiv.appendChild(icon);
                resultDiv.appendChild(document.createTextNode(good + ' mapping' + (good !== 1 ? 's' : '') + ' verified.'));
            } else {
                if (issues.length > 0) {
                    resultDiv.style.backgroundColor = 'rgba(220, 53, 69, 0.15)';
                    resultDiv.style.borderLeft = '4px solid #dc3545';
                    issues.forEach(function(i) { addIssue(resultDiv, i); });
                } else {
                    resultDiv.style.backgroundColor = 'rgba(255, 193, 7, 0.15)';
                    resultDiv.style.borderLeft = '4px solid #ffc107';
                }
                warnings.forEach(function(w) { addIssue(resultDiv, w); });
                if (good > 0) {
                    addIssue(resultDiv, good + ' other mapping' + (good !== 1 ? 's' : '') + ' verified.');
                }
            }

            btn.disabled = false;
            setBtnLabel('Validate Mappings');
        }

        // Per-service mapping validation helpers. Each service's Validate button
        // collects only its own instances' mappings (plus Bazarr's single field),
        // feeds them through validateMappingSet, and cleans up any temp textareas
        // it creates. Split from the old "validate everything" button so results
        // land next to the service being tested.
        function _jeValidateInstanceMappings(type: ArrType, btnId: string, resultId: string, displayName: string) : void {
            var mappingDefs: MappingDef[] = [];
            var createdTempIds: string[] = [];
            // Wipe orphan temp textareas from a prior run (lets us also accept
            // those leftover from a previous failed validation with the same
            // prefix).
            document.querySelectorAll<HTMLElement>('textarea[data-arr-validate-temp-' + type + '="true"]').forEach(function(el) { el.remove(); });

            var listId = type + 'InstancesList';
            document.querySelectorAll<HTMLElement>('#' + listId + ' .arr-instance-card').forEach(function(card, idx) {
                var name = needControl(card.querySelector('.arr-instance-name')).value.trim() || (displayName + ' ' + (idx + 1));
                var textarea = asControl(card.querySelector('.arr-instance-urlmappings'));
                if (textarea && textarea.value.trim()) {
                    var tempId = 'arr-validate-' + type + '-' + idx;
                    var temp = document.createElement('textarea');
                    temp.id = tempId;
                    temp.value = textarea.value;
                    temp.style.display = 'none';
                    temp.setAttribute('data-arr-validate-temp-' + type, 'true');
                    document.body.appendChild(temp);
                    createdTempIds.push(tempId);
                    mappingDefs.push({ id: tempId, service: name });
                }
            });

            if (mappingDefs.length === 0) {
                Dashboard.alert({ title: 'No Mappings', message: 'No URL mappings configured for ' + displayName + '. Expand an instance card and fill in the URL Mappings field to validate.' });
                return;
            }
            var cleanup = function() {
                createdTempIds.forEach(function(id) {
                    var el = asHtml(document.getElementById(id));
                    if (el) el.remove();
                });
            };
            validateMappingSet(mappingDefs, btnId, resultId)
                .finally(cleanup)
                .catch(function(err) {
                    // Without an explicit .catch, a thrown rejection (missing btn
                    // node, pre-await TypeError, failed Promise.all inside the
                    // validator) would leave the Validate button stuck on its
                    // disabled/"Validating..." state and the admin with no visible
                    // signal beyond an Uncaught (in promise) message in devtools.
                    console.error('[JE] mapping validation crashed:', err);
                    var btn = asControl(document.getElementById(btnId));
                    if (btn) {
                        btn.disabled = false;
                        var span = asHtml(btn.querySelector('span'));
                        if (span) span.textContent = 'Validate Mappings';
                        else btn.textContent = 'Validate Mappings';
                    }
                    try {
                        Dashboard.alert({ title: 'Validation error', message: 'Mapping validation crashed unexpectedly, check the browser console for details.' });
                    } catch (alertErr) {
                        console.warn('[JE] Dashboard.alert threw during validation-error notify:', alertErr);
                        try { window.alert('Validation error: ' + ((err && err.message) || err)); } catch (_) { /* last-resort notify — if alert() itself throws we've given up */ }
                    }
                });
        }

        var validateSonarrMappingsBtn = asHtml(document.getElementById('validateSonarrMappingsBtn'));

        var validateRadarrMappingsBtn = asHtml(document.getElementById('validateRadarrMappingsBtn'));

        // Safety-net wrapper used by the three mapping-validate buttons.
        // Mirrors the .catch + button-reset handler inside _jeValidateInstanceMappings
        // so Bazarr/Seerr direct callers get the same treatment. Without this,
        // a rejected validateMappingSet() promise would leave the button stuck on
        // "Validating..." with only an Uncaught (in promise) in devtools.
        function _jeRunMappingValidation(mappingDefs: readonly MappingDef[], btnId: string, resultId: string) : void {
            validateMappingSet(mappingDefs, btnId, resultId).catch(function(err) {
                console.error('[JE] mapping validation crashed:', err);
                var b = asControl(document.getElementById(btnId));
                if (b) {
                    b.disabled = false;
                    var span = asHtml(b.querySelector('span'));
                    if (span) span.textContent = 'Validate Mappings';
                    else b.textContent = 'Validate Mappings';
                }
                try {
                    Dashboard.alert({ title: 'Validation error', message: 'Mapping validation crashed unexpectedly, check the browser console for details.' });
                } catch (alertErr) {
                    console.warn('[JE] Dashboard.alert threw during validation-error notify:', alertErr);
                    try { window.alert('Validation error: ' + ((err && err.message) || err)); } catch (_) { /* last-resort notify — if alert() itself throws we've given up */ }
                }
            });
        }

        var validateBazarrMappingsBtn = asHtml(document.getElementById('validateBazarrMappingsBtn'));

        var validateShokoMappingsBtn = asHtml(document.getElementById('validateShokoMappingsBtn'));

        var validateSeerrMappingsBtn = asHtml(document.getElementById('validateSeerrMappingsBtn'));

    /** Runs this module's start-up work, in the page's original order. */
    function wire(): void {
        if (validateSonarrMappingsBtn) {
            validateSonarrMappingsBtn.addEventListener('click', function() {
                _jeValidateInstanceMappings('sonarr', 'validateSonarrMappingsBtn', 'sonarrMappingsValidationResult', 'Sonarr');
            });
        }

        if (validateRadarrMappingsBtn) {
            validateRadarrMappingsBtn.addEventListener('click', function() {
                _jeValidateInstanceMappings('radarr', 'validateRadarrMappingsBtn', 'radarrMappingsValidationResult', 'Radarr');
            });
        }

        if (validateBazarrMappingsBtn) {
            validateBazarrMappingsBtn.addEventListener('click', function() {
                var mappings = asControl(document.getElementById('bazarrUrlMappings'));
                if (!mappings || !mappings.value.trim()) {
                    Dashboard.alert({ title: 'No Mappings', message: 'No Bazarr URL mappings configured. Fill in the Bazarr URL Mappings field above to validate.' });
                    return;
                }
                _jeRunMappingValidation(
                    [{ id: 'bazarrUrlMappings', service: 'Bazarr' }],
                    'validateBazarrMappingsBtn', 'bazarrMappingsValidationResult'
                );
            });
        }

        if (validateShokoMappingsBtn) {
            validateShokoMappingsBtn.addEventListener('click', function() {
                var mappings = asControl(document.getElementById('shokoUrlMappings'));
                if (!mappings || !mappings.value.trim()) {
                    Dashboard.alert({ title: 'No Mappings', message: 'No Shoko URL mappings configured. Fill in the Shoko URL Mappings field above to validate.' });
                    return;
                }
                _jeRunMappingValidation(
                    [{ id: 'shokoUrlMappings', service: 'Shoko' }],
                    'validateShokoMappingsBtn', 'shokoMappingsValidationResult'
                );
            });
        }

        if (validateSeerrMappingsBtn) {
            validateSeerrMappingsBtn.addEventListener('click', function() {
                _jeRunMappingValidation(
                    [{ id: 'jellyseerrUrlMappings', service: 'Seerr' }],
                    'validateSeerrMappingsBtn', 'seerrMappingsValidationResult'
                );
            });
        }
    }

    return {
        wire,

    };
}
