import type { PageModules } from './modules';
import { asObject, text } from '../domain/config';
import { asControl, asHtml, asInput, needControl, needHtml } from './dom';
import type { AdminConfig, JsonObject } from '../domain/config';
import type { ArrType, ArrInstance, ElementAttributes } from './types';

/** Dependencies this module calls; members are resolved lazily, after every module exists. */
export type ArrDeps = Pick<PageModules, 'context' | 'arrTests' | 'gatedHelp' | 'serviceStatus'>;

export function createArr(m: ArrDeps) {
    const { ApiClient, Dashboard } = m.context;

        // ==================== Multi-Instance Arr Management ====================

        interface ImportRow {
            checkbox: HTMLInputElement;
            inst: JsonObject;
            url: string;
            jellyfinInternalInput: HTMLInputElement | null;
            jellyfinExternalInput: HTMLInputElement | null;
        }

        function createEl<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: ElementAttributes, children?: readonly (Node | null | undefined)[]): HTMLElementTagNameMap[K] {
            var el = document.createElement(tag);
            if (attrs) {
                Object.entries(attrs).forEach(function([k, raw]) {
                    if (raw === undefined) return;
                    const value = String(raw);
                    if (k === 'textContent') el.textContent = value;
                    else if (k === 'className') el.className = value;
                    else el.setAttribute(k, value);
                });
            }
            if (children) {
                children.forEach(function(c) { if (c) el.appendChild(c); });
            }
            return el;
        }

        function createInstanceCard(type: ArrType, instance: ArrInstance, startOpen?: boolean) : HTMLElement {
            var defaultName = type === 'sonarr' ? 'Sonarr' : 'Radarr';
            var namePlaceholder = type === 'sonarr' ? 'e.g., TV Shows, Anime' : 'e.g., Movies, 4K Movies';
            var urlPlaceholder = type === 'sonarr' ? 'e.g., http://192.168.1.100:8989' : 'e.g., http://192.168.1.100:7878';

            // Default Enabled to true when the stored JSON omits the field (backwards compat with
            // configs written before the Enabled flag existed).
            var initiallyEnabled = instance.Enabled !== false;

            // Enabled toggle lives in the summary row so admins can flip it without expanding
            // the card. stopPropagation on pointer events prevents the <details> from toggling
            // open/closed when the user clicks the checkbox itself.
            // Styled via .arr-instance-enabled CSS (see jeAdmin.css). We intentionally
            // do NOT use is="emby-checkbox" — that custom element expects a <label> wrapper
            // with a sibling <span>, which we can't provide inside a <details><summary> row
            // without breaking the flex layout of the name/URL/disabled chip.
            var ariaName = (instance.Name || '').trim() || defaultName;
            var enabledCheckbox = createEl('input', {
                type: 'checkbox',
                className: 'arr-instance-enabled',
                'aria-label': 'Enable ' + ariaName + ' instance',
                title: 'Uncheck to skip this instance in all fan-out paths (links, calendar, queue, tag sync) without deleting its URL/API key'
            });
            if (initiallyEnabled) enabledCheckbox.checked = true;
            ['click', 'mousedown', 'keydown'].forEach(function(evt) {
                enabledCheckbox.addEventListener(evt, function(e) { e.stopPropagation(); });
            });

            // Summary row (visible when collapsed). Order: [▶ disclosure] [☑ enabled] [name] [(disabled)] [url]
            var summaryDisabledSpan = createEl('span', {
                className: 'arr-instance-summary-disabled',
                textContent: '(disabled)',
                style: 'color: #e5a00d; font-size: 0.85em; margin-right: 0.5em; display: ' + (initiallyEnabled ? 'none' : 'inline')
            });
            var summaryNameSpan = createEl('span', { className: 'arr-instance-summary-name', textContent: instance.Name || defaultName });
            var summaryUrlSpan = createEl('span', { className: 'arr-instance-summary-url', textContent: instance.Url || '' });
            var summaryEl = document.createElement('summary');
            summaryEl.appendChild(enabledCheckbox);
            summaryEl.appendChild(summaryNameSpan);
            summaryEl.appendChild(summaryDisabledSpan);
            summaryEl.appendChild(summaryUrlSpan);

            // Body header: [name input (flex:1)] [Remove]. The Enabled toggle used to live here
            // too, which crowded the row and left the name input pinched against it. Moved to
            // the summary above so this row has only the rename + remove affordances.
            var nameInput = createEl('input', { className: 'arr-instance-name jea-input', type: 'text', placeholder: namePlaceholder, value: instance.Name || '', style: 'flex:1' });
            var removeBtn = createEl('button', { className: 'arr-instance-remove', type: 'button', title: 'Remove instance', textContent: 'Remove' });
            var header = createEl('div', { className: 'arr-instance-header' }, [nameInput, removeBtn]);

            var urlLabel = createEl('label', { className: 'inputLabel inputLabelUnfocused', textContent: 'URL' });
            var urlInput = createEl('input', { className: 'arr-instance-url jea-input', type: 'text', placeholder: urlPlaceholder, value: instance.Url || '' });
            var defaultPort = type === 'sonarr' ? '8989' : '7878';
            var urlDesc = createEl('div', { className: 'fieldDescription', textContent: 'The Jellyfin server uses this URL to talk to ' + (type === 'sonarr' ? 'Sonarr' : 'Radarr') + ' directly. If your public URL sits behind an auth proxy (Authentik, Authelia, Cloudflare Access, etc.), put the INTERNAL address here (e.g. http://' + type + ':' + defaultPort + ' or http://192.168.x.y:' + defaultPort + ') and use the URL Mappings below to redirect user-facing links to the public URL.' });
            var urlContainer = createEl('div', { className: 'inputContainer', style: 'margin-top: 0.5em;' }, [urlLabel, urlInput, urlDesc]);

            var apiLabel = createEl('label', { className: 'inputLabel inputLabelUnfocused', textContent: 'API Key' });
            var apiInput = createEl('input', { className: 'arr-instance-apikey jea-input', type: 'text', autocomplete: 'off', placeholder: 'API key (find in Settings > General > Security)', value: instance.ApiKey || '' });
            var statusIcon = createEl('span', { className: 'material-icons arr-instance-status', style: 'transition: color 0.3s ease;' });
            var testBtn = createEl('button', { className: 'jea-btn arr-instance-test', type: 'button' });
            testBtn.appendChild(createEl('span', { textContent: 'Test' }));
            var apiRow = createEl('div', { style: 'display: flex; align-items: center; gap: 1em;' }, [apiInput, statusIcon, testBtn]);
            var apiDesc = createEl('div', { className: 'fieldDescription', textContent: 'Find this in ' + (type === 'sonarr' ? 'Sonarr' : 'Radarr') + ' under Settings > General > Security > API Key' });
            var apiContainer = createEl('div', { className: 'inputContainer', style: 'margin-top: 0.5em;' }, [apiLabel, apiRow, apiDesc]);

            // URL Mappings shown inline (no nested <details>) — the whole card already
            // expands behind its own <details>, so doubling up on collapses hides a
            // frequently-edited field one extra click deep.
            var mappingsLabel = createEl('label', { className: 'inputLabel inputLabelUnfocused', textContent: 'URL Mappings (optional)' });
            var mappingsTextarea = createEl('textarea', { className: 'arr-instance-urlmappings jea-input', style: 'display:block; min-height: 5em; margin-top: 0.25em;', placeholder: 'jellyfin_url|arr_url (one per line)' });
            mappingsTextarea.value = instance.UrlMappings || '';
            var mappingsDesc = createEl('div', { className: 'fieldDescription', textContent: 'Map Jellyfin access URLs to this instance\'s URL. Format: jellyfin_url|arr_url (one per line). Useful for reverse-proxy setups.' });
            var mappingsContainer = createEl('div', { className: 'inputContainer', style: 'margin-top: 0.5em;' }, [mappingsLabel, mappingsTextarea, mappingsDesc]);

            var body = createEl('div', { className: 'arr-instance-card-body' }, [header, urlContainer, apiContainer, mappingsContainer]);

            // The card is a <details> element
            var card = document.createElement('details');
            card.className = 'arr-instance-card';
            if (!initiallyEnabled) card.classList.add('arr-instance-disabled');
            card.dataset.type = type;
            if (startOpen) card.open = true;
            card.appendChild(summaryEl);
            card.appendChild(body);

            // Keep summary text in sync with name/url inputs
            nameInput.addEventListener('input', function() {
                var n = nameInput.value.trim() || defaultName;
                summaryNameSpan.textContent = n;
                enabledCheckbox.setAttribute('aria-label', 'Enable ' + n + ' instance');
            });
            urlInput.addEventListener('input', function() {
                summaryUrlSpan.textContent = urlInput.value.trim();
            });

            // Toggle visual dim state + summary "(disabled)" chip when the Enabled checkbox
            // changes. The backend is the authority — this is UI feedback only until Save.
            // Also re-renders the Overview Service Status card so a disabled instance
            // instantly shows as "Disabled" instead of a stale red/green badge.
            //
            // setBodyDisabled marks every form control inside the card body read-only when
            // the toggle is off so edits can't silently persist — collectInstancesFromDom
            // reads input values directly and respects the Enabled flag on save.
            function setBodyDisabled(disabled: boolean): void {
                body.querySelectorAll<HTMLElement>('input, textarea, button, select').forEach(function(el) {
                    if (disabled) {
                        el.setAttribute('disabled', '');
                    } else {
                        el.removeAttribute('disabled');
                    }
                });
            }
            setBodyDisabled(!initiallyEnabled);
            enabledCheckbox.addEventListener('change', function() {
                var en = enabledCheckbox.checked;
                summaryDisabledSpan.style.display = en ? 'none' : 'inline';
                card.classList.toggle('arr-instance-disabled', !en);
                setBodyDisabled(!en);
                try { m.serviceStatus.renderServiceStatusDashboard(); } catch (e) {
                    console.warn('[JE] renderServiceStatusDashboard threw from arr-instance enable-toggle:', e);
                }
            });

            // Confirm before removing
            removeBtn.addEventListener('click', function(e) {
                e.preventDefault();
                var instName = nameInput.value.trim() || defaultName;
                Dashboard.confirm('Remove "' + instName + '" from the instance list? The change takes effect when you click Save. If you leave the page without saving, the instance is kept.\n\nTip: If you just want to stop using it temporarily, uncheck Enabled instead; that preserves the URL and API key.', 'Remove Instance', function(confirmed) {
                    if (confirmed) {
                        card.remove();
                        m.gatedHelp.updateAllDependencies();
                    }
                });
            });

            testBtn.addEventListener('click', function() { m.arrTests.testInstanceConnection(card); });
            apiInput.style.flex = '1';
            return card;
        }

        // Tracks whether each instance-list JSON parsed cleanly on load.
        // When false, saveArrInstances refuses to overwrite the stored value and legacy fields
        // to avoid turning a read-side corruption into permanent data loss.
        var _arrParseOK = { sonarr: true, radarr: true };

        function tryParseInstanceList(raw: string, type: ArrType, container: HTMLElement) : ArrInstance[] {
            if (!raw) { _arrParseOK[type] = true; return []; }
            try {
                var parsed = JSON.parse(raw);
                if (!Array.isArray(parsed)) throw new Error(type + 'Instances JSON is not an array');
                _arrParseOK[type] = true;
                return parsed;
            } catch (e) {
                _arrParseOK[type] = false;
                console.error('[JE Config] Failed to parse ' + type + 'Instances — refusing to overwrite on save:', e, raw);
                insertCorruptBanner(container, type);
                return [];
            }
        }

        function insertCorruptBanner(container: HTMLElement, type: ArrType) : void {
            var label = type === 'sonarr' ? 'Sonarr' : 'Radarr';
            var banner = document.createElement('div');
            banner.className = 'arr-corrupt-banner';
            banner.setAttribute('data-arr-corrupt', type);
            banner.style.cssText = 'padding: 0.8em 1em; margin-bottom: 1em; border: 1px solid #dc3545; background: rgba(220,53,69,0.15); border-radius: 4px;';

            var heading = document.createElement('strong');
            heading.textContent = '⚠ Stored ' + label + ' instance configuration is corrupted.';
            var detail = document.createElement('div');
            detail.style.marginTop = '0.3em';
            detail.textContent = 'The saved JSON could not be parsed. Saving this page will NOT overwrite the stored value or the legacy ' +
                label + ' URL/API key, so existing configuration is preserved. To recover: either fix the stored JSON directly in Jellyfin\'s plugin config, ' +
                'or click the button below to reset this list (destroys the unreadable value).';
            banner.appendChild(heading);
            banner.appendChild(detail);

            var resetBtn = document.createElement('button');
            resetBtn.className = 'jea-btn';
            resetBtn.style.marginTop = '0.6em';
            resetBtn.type = 'button';
            resetBtn.textContent = 'Reset ' + label + ' instances (clears stored value)';
            resetBtn.addEventListener('click', function() {
                Dashboard.confirm(
                    'Reset the corrupt ' + label + ' instance configuration? The stored JSON is unreadable so any instances it contained cannot be recovered. You will need to add them again. The reset takes effect when you click Save.',
                    'Reset Instances',
                    function(confirmed) {
                        if (!confirmed) return;
                        _arrParseOK[type] = true;
                        banner.remove();
                        // On next Save, the empty array will be written and legacy fields cleared normally.
                    }
                );
            });
            banner.appendChild(resetBtn);

            container.appendChild(banner);
        }

        function loadArrInstances(config: AdminConfig) : void {
            var sonarrList = needHtml(document.querySelector('#sonarrInstancesList'));
            var radarrList = needHtml(document.querySelector('#radarrInstancesList'));
            sonarrList.textContent = '';
            radarrList.textContent = '';
            _arrParseOK = { sonarr: true, radarr: true };

            var sonarrInstances = tryParseInstanceList(text(config.SonarrInstances), 'sonarr', sonarrList);
            var radarrInstances = tryParseInstanceList(text(config.RadarrInstances), 'radarr', radarrList);

            // Migration: only when parse succeeded AND no instances but legacy fields are populated.
            // Skip migration when parse failed — the legacy fields may be stale or already migrated.
            if (_arrParseOK.sonarr && sonarrInstances.length === 0 && config.SonarrUrl && config.SonarrApiKey) {
                sonarrInstances.push({
                    Name: 'Sonarr',
                    Url: text(config.SonarrUrl),
                    ApiKey: text(config.SonarrApiKey),
                    UrlMappings: text(config.SonarrUrlMappings)
                });
            }
            if (_arrParseOK.radarr && radarrInstances.length === 0 && config.RadarrUrl && config.RadarrApiKey) {
                radarrInstances.push({
                    Name: 'Radarr',
                    Url: text(config.RadarrUrl),
                    ApiKey: text(config.RadarrApiKey),
                    UrlMappings: text(config.RadarrUrlMappings)
                });
            }

            sonarrInstances.forEach(function(inst) {
                sonarrList.appendChild(createInstanceCard('sonarr', inst));
            });
            radarrInstances.forEach(function(inst) {
                radarrList.appendChild(createInstanceCard('radarr', inst));
            });
        }

        // Requests Page requirements line — hides once at least one of Sonarr/Radarr
        // AND Seerr have URL + API key configured (Sonarr and Radarr are each optional
        // on their own — the backend just skips whichever one is unconfigured — but at
        // least one of the two is needed for the page to show anything). Shows a dynamic
        // list of what's still missing otherwise. The surrounding info banner itself
        // stays visible; only the "Requirements:" sentence toggles. Runs off the live DOM
        // so typing a URL/API key updates immediately without needing a save-and-reload.
        function updateRequestsRequirementsBanner() : void {
            var line = asHtml(document.getElementById('requestsPageRequirementsLine'));
            if (!line) return;
            var list = needHtml(document.getElementById('requestsPageRequirementsList'));

            function hasCompleteInstance(listId: string): boolean {
                var root = asHtml(document.getElementById(listId));
                if (!root) return false;
                // Walk each instance card (the <details class="arr-instance-card"> element
                // built by createInstanceCard). Matching on the real card wrapper avoids
                // closest() landing on the inner .inputContainer div, which only contains
                // the URL input and misses the API-key sibling.
                var cards = root.querySelectorAll<HTMLElement>('.arr-instance-card');
                for (var i = 0; i < cards.length; i++) {
                    var urlEl = asControl(cards[i]?.querySelector('.arr-instance-url') ?? null);
                    var apiEl = asControl(cards[i]?.querySelector('.arr-instance-apikey') ?? null);
                    var url = urlEl ? (urlEl.value || '').trim() : '';
                    var api = apiEl ? (apiEl.value || '').trim() : '';
                    if (url && api) return true;
                }
                return false;
            }

            var sonarrOK = hasCompleteInstance('sonarrInstancesList');
            var radarrOK = hasCompleteInstance('radarrInstancesList');
            var seerrUrlsEl = asControl(document.getElementById('jellyseerrUrls'));
            var seerrKeyEl = asControl(document.getElementById('JellyseerrApiKey'));
            var seerrOK = seerrUrlsEl && (seerrUrlsEl.value || '').trim().length > 0 &&
                          seerrKeyEl && (seerrKeyEl.value || '').trim().length > 0;

            if ((sonarrOK || radarrOK) && seerrOK) {
                line.style.display = 'none';
                return;
            }

            var missing = [];
            if (!sonarrOK && !radarrOK) missing.push('Sonarr or Radarr');
            if (!seerrOK) missing.push('Seerr');
            var missingText;
            if (missing.length === 1) {
                missingText = missing[0] + ' (URL and API key)';
            } else {
                missingText = missing.join(' and ') + ' (URL and API key each)';
            }
            if (list) list.textContent = 'Still to configure: ' + missingText + '.';
            line.style.display = '';
        }

        function collectInstancesFromDom(selector: string, defaultName: string): { instances: ArrInstance[]; incomplete: string[] } {
            var out: ArrInstance[] = [];
            var incomplete: string[] = [];
            document.querySelectorAll<HTMLElement>(selector).forEach(function(card) {
                const url = needControl(card.querySelector('.arr-instance-url')).value.trim();
                const apiKey = needControl(card.querySelector('.arr-instance-apikey')).value.trim();
                if (url && apiKey) {
                    var enabledCb = asInput(card.querySelector('.arr-instance-enabled'));
                    out.push({
                        Name: needControl(card.querySelector('.arr-instance-name')).value.trim() || defaultName,
                        Url: url,
                        ApiKey: apiKey,
                        UrlMappings: needControl(card.querySelector('.arr-instance-urlmappings')).value || '',
                        // Default to true when the checkbox is missing (shouldn't happen, but
                        // guards against DOM surgery from another script).
                        Enabled: enabledCb ? enabledCb.checked : true
                    });
                } else if (url && !apiKey) {
                    // Card has a URL but no API key — it would be silently dropped. Collect the
                    // name so we can warn the admin before the save commits.
                    incomplete.push(needControl(card.querySelector('.arr-instance-name')).value.trim() || defaultName);
                }
            });
            return { instances: out, incomplete: incomplete };
        }

        function saveArrInstances(config: AdminConfig) : string[] {
            // Only overwrite stored state when the load parse succeeded. Otherwise leave the stored
            // JSON AND legacy fields untouched so the admin can recover the original value.
            var incompleteWarnings: string[] = [];

            if (_arrParseOK.sonarr) {
                var sonarrResult = collectInstancesFromDom('#sonarrInstancesList .arr-instance-card', 'Sonarr');
                var sonarrInstances = sonarrResult.instances;
                sonarrResult.incomplete.forEach(function(name: string) {
                    incompleteWarnings.push('Sonarr instance "' + name + '" has a URL but no API key, so it was not saved.');
                });
                config.SonarrInstances = JSON.stringify(sonarrInstances);
                if (sonarrInstances.length > 0) {
                    const first = sonarrInstances[0];
                    config.SonarrUrl = first?.Url;
                    config.SonarrApiKey = first?.ApiKey;
                    config.SonarrUrlMappings = first?.UrlMappings;
                } else {
                    config.SonarrUrl = '';
                    config.SonarrApiKey = '';
                    config.SonarrUrlMappings = '';
                }
            }

            if (_arrParseOK.radarr) {
                var radarrResult = collectInstancesFromDom('#radarrInstancesList .arr-instance-card', 'Radarr');
                var radarrInstances = radarrResult.instances;
                radarrResult.incomplete.forEach(function(name: string) {
                    incompleteWarnings.push('Radarr instance "' + name + '" has a URL but no API key, so it was not saved.');
                });
                config.RadarrInstances = JSON.stringify(radarrInstances);
                if (radarrInstances.length > 0) {
                    const first = radarrInstances[0];
                    config.RadarrUrl = first?.Url;
                    config.RadarrApiKey = first?.ApiKey;
                    config.RadarrUrlMappings = first?.UrlMappings;
                } else {
                    config.RadarrUrl = '';
                    config.RadarrApiKey = '';
                    config.RadarrUrlMappings = '';
                }
            }

            return incompleteWarnings;
        }

        /** Reconstructs a Sonarr/Radarr instance's own URL from Seerr's settings shape. */
        function buildArrUrlFromSeerrInstance(inst: JsonObject) : string {
            var scheme = inst.useSsl ? 'https://' : 'http://';
            var base = text(inst.baseUrl).trim();
            if (base && base.charAt(0) !== '/') base = '/' + base;
            return scheme + inst.hostname + ':' + inst.port + base;
        }

        /**
         * Wires the "Import from Seerr" button for one *arr type: fetches
         * Seerr's own configured instances (admin-only endpoint, since the
         * response includes each instance's real API key) and shows an
         * inline checklist to import from, skipping ones already present by
         * matching on the reconstructed URL.
         */
        function wireSeerrArrImport(type: ArrType) : void {
            var label = type === 'sonarr' ? 'Sonarr' : 'Radarr';
            var importBtn = asHtml(document.getElementById('import' + label + 'FromSeerr'));
            const picker = asHtml(document.getElementById(type + 'SeerrImportPicker'));
            const list = asHtml(document.getElementById(type + 'InstancesList'));
            if (!importBtn || !picker || !list) return;

            importBtn.addEventListener('click', function() {
                // Second click while open just closes it.
                if (picker.style.display !== 'none') {
                    picker.style.display = 'none';
                    picker.innerHTML = '';
                    return;
                }

                picker.innerHTML = '';
                picker.style.display = 'block';
                picker.appendChild(createEl('div', { className: 'fieldDescription', textContent: 'Fetching instances from Seerr...' }));

                Promise.all([
                    ApiClient.ajax({
                        type: 'GET',
                        url: ApiClient.getUrl('/JellyfinEnhanced/jellyseerr/settings/' + type),
                        dataType: 'json'
                    }),
                    ApiClient.ajax({
                        type: 'GET',
                        url: ApiClient.getUrl('/JellyfinEnhanced/jellyfin-urls'),
                        dataType: 'json'
                    }).catch(function() { return {}; }) // best-effort; falls back to an editable guess below
                ]).then(function(results) {
                    var instances = results[0];
                    var jellyfinExternalUrl = text(asObject(results[1]).externalUrl);
                    var jellyfinInternalUrl = text(asObject(results[1]).internalUrl);
                    picker.innerHTML = '';
                    if (!Array.isArray(instances) || instances.length === 0) {
                        picker.appendChild(createEl('div', { className: 'fieldDescription', textContent: 'Seerr has no ' + label + ' instances configured.' }));
                        return;
                    }

                    var existingUrls = Array.from(list.querySelectorAll<HTMLInputElement>('.arr-instance-url')).map(function(el) { return el.value.trim(); });
                    var rows: ImportRow[] = [];

                    instances.forEach(function(inst) {
                        var url = buildArrUrlFromSeerrInstance(inst);
                        var alreadyImported = existingUrls.indexOf(url) !== -1;

                        var checkbox = createEl('input', { type: 'checkbox' });
                        checkbox.checked = !alreadyImported;
                        checkbox.disabled = alreadyImported;

                        var title = (inst.name || label) + (inst.is4k ? ' (4K)' : '') + (alreadyImported ? ' (already imported)' : '');
                        var details = url + (inst.activeProfileName ? ' · ' + inst.activeProfileName : '');

                        var textChildren = [
                            createEl('div', { className: 'je-arr-seerr-import-row-title', textContent: title }),
                            createEl('div', { className: 'je-arr-seerr-import-row-summary', textContent: details })
                        ];
                        if (inst.externalUrl) {
                            textChildren.push(createEl('div', { className: 'je-arr-seerr-import-row-summary', textContent: 'public: ' + inst.externalUrl }));
                        }

                        // Seerr's settings endpoint gives us both sides of the arr instance
                        // (internal hostname/port/baseUrl AND externalUrl), so mirror that
                        // with both sides of the Jellyfin URL Mapping too: internal Jellyfin
                        // URL -> internal arr URL, external Jellyfin URL -> external arr URL.
                        // Both prefer values read from Jellyfin's own server-side network
                        // detection (LAN bind address / Published Server URIs) over guessing
                        // from the admin's current browser origin; still editable either way.
                        var jellyfinInternalInput = null;
                        var jellyfinExternalInput = null;
                        if (!alreadyImported) {
                            function mappingCell(defaultValue: string, placeholder: string): HTMLInputElement {
                                return createEl('input', { type: 'text', value: defaultValue, placeholder: placeholder });
                            }

                            jellyfinInternalInput = mappingCell(jellyfinInternalUrl || window.location.origin, 'Your Jellyfin internal/LAN URL');
                            var internalRow = createEl('tr', {}, [
                                createEl('td', { className: 'je-arr-seerr-mapping-row-label', textContent: 'Internal' }),
                                createEl('td', {}, [jellyfinInternalInput]),
                                createEl('td', { className: 'je-arr-seerr-mapping-target', textContent: url })
                            ]);

                            var tableRows = [internalRow];
                            if (inst.externalUrl) {
                                jellyfinExternalInput = mappingCell(jellyfinExternalUrl || window.location.origin, 'Your Jellyfin external/public URL');
                                tableRows.push(createEl('tr', {}, [
                                    createEl('td', { className: 'je-arr-seerr-mapping-row-label', textContent: 'External' }),
                                    createEl('td', {}, [jellyfinExternalInput]),
                                    createEl('td', { className: 'je-arr-seerr-mapping-target', textContent: inst.externalUrl })
                                ]));
                            }

                            var instanceName = inst.name || label;
                            var autoFilledSomething = (jellyfinInternalUrl ? 1 : 0) + (inst.externalUrl && jellyfinExternalUrl ? 1 : 0) > 0;
                            var mappingNote = autoFilledSomething
                                ? 'Auto-filled from Jellyfin\'s network config. Confirm before saving!'
                                : 'Could not auto-detect. Please confirm both URLs before saving.';

                            textChildren.push(createEl('table', { className: 'je-arr-seerr-mapping-table' }, [
                                createEl('thead', {}, [createEl('tr', {}, [
                                    createEl('th', {}),
                                    createEl('th', { textContent: 'Jellyfin' }),
                                    createEl('th', { textContent: instanceName })
                                ])]),
                                createEl('tbody', {}, tableRows)
                            ]));
                            textChildren.push(createEl('div', { className: 'je-arr-seerr-mapping-note', textContent: mappingNote }));
                            textChildren.push(createEl('div', { className: 'je-arr-seerr-mapping-note', textContent: 'You can add more or edit these even after importing.' }));
                        }

                        var rowLabel = createEl('label', {
                            className: 'je-arr-seerr-import-row',
                            style: alreadyImported ? 'opacity:0.55;cursor:default;' : 'cursor:pointer;'
                        }, [checkbox, createEl('div', { className: 'je-arr-seerr-import-row-text' }, textChildren)]);

                        rows.push({ checkbox: checkbox, inst: inst, url: url, jellyfinInternalInput: jellyfinInternalInput, jellyfinExternalInput: jellyfinExternalInput });
                        picker.appendChild(rowLabel);
                    });

                    var importSelectedBtn = createEl('button', { type: 'button', className: 'jea-btn', textContent: 'Import Selected' });
                    var cancelBtn = createEl('button', { type: 'button', className: 'jea-btn', textContent: 'Cancel' });
                    picker.appendChild(createEl('div', { style: 'display:flex;gap:0.75em;margin-top:0.75em;' }, [importSelectedBtn, cancelBtn]));

                    cancelBtn.addEventListener('click', function() {
                        picker.style.display = 'none';
                        picker.innerHTML = '';
                    });

                    importSelectedBtn.addEventListener('click', function() {
                        var imported = 0;
                        rows.forEach(function(row) {
                            if (row.checkbox.disabled || !row.checkbox.checked) return;
                            // One line per side the admin confirmed/edited: internal
                            // Jellyfin URL -> internal arr URL, external Jellyfin URL ->
                            // external arr URL. Mirrors the two sides Seerr's own settings
                            // endpoint gave us for the arr instance.
                            var mappingLines = [];
                            var jellyfinInternalUrl = row.jellyfinInternalInput ? row.jellyfinInternalInput.value.trim() : '';
                            if (jellyfinInternalUrl) mappingLines.push(jellyfinInternalUrl + '|' + row.url);
                            var jellyfinExternalUrl = row.jellyfinExternalInput ? row.jellyfinExternalInput.value.trim() : '';
                            if (row.inst.externalUrl && jellyfinExternalUrl) mappingLines.push(jellyfinExternalUrl + '|' + row.inst.externalUrl);
                            var urlMappings = mappingLines.join('\n');
                            list.appendChild(createInstanceCard(type, {
                                Name: text(row.inst.name) || label,
                                Url: row.url,
                                ApiKey: text(row.inst.apiKey),
                                UrlMappings: urlMappings
                            }, false));
                            imported++;
                        });
                        picker.style.display = 'none';
                        picker.innerHTML = '';
                        m.gatedHelp.updateAllDependencies();
                        if (imported > 0) {
                            try {
                                Dashboard.alert({ title: 'Imported', message: imported + ' instance(s) imported from Seerr. Review the URL/API key below, then click Save.' });
                            } catch (e) { /* Dashboard.alert unavailable, non-fatal */ }
                        }
                    });
                }).catch(function(err) {
                    // Same responseText-parsing convention as connectionErrorMessage()
                    // above -- ApiClient.ajax errors expose responseText, not responseJSON.
                    var message = 'Could not fetch instances from Seerr.';
                    try {
                        var txt = err && (err.responseText || (err.response && err.response.text)) || '';
                        if (typeof txt === 'string' && txt.trim().charAt(0) === '{') {
                            var body = JSON.parse(txt);
                            if (body && body.error) message = body.error;
                        }
                    } catch (parseErr) { /* not JSON, use default message */ }
                    picker.innerHTML = '';
                    picker.appendChild(createEl('div', { className: 'fieldDescription', style: 'color:#ff6b6b;', textContent: message }));
                    console.warn('[JE] Seerr ' + type + ' settings import failed:', err);
                });
            });
        }

    /** Runs this module's start-up work, in the page's original order. */
    function wire(): void {
        // Bind add-instance buttons
        needHtml(document.querySelector('#addSonarrInstance')).addEventListener('click', function() {
            needHtml(document.querySelector('#sonarrInstancesList')).appendChild(
                createInstanceCard('sonarr', { Name: '', Url: '', ApiKey: '', UrlMappings: '' }, true)
            );
            m.gatedHelp.updateAllDependencies();
        });

        needHtml(document.querySelector('#addRadarrInstance')).addEventListener('click', function() {
            needHtml(document.querySelector('#radarrInstancesList')).appendChild(
                createInstanceCard('radarr', { Name: '', Url: '', ApiKey: '', UrlMappings: '' }, true)
            );
            m.gatedHelp.updateAllDependencies();
        });

        wireSeerrArrImport('sonarr');

        wireSeerrArrImport('radarr');
    }

    return {
        wire,
        loadArrInstances,
        saveArrInstances,
        updateRequestsRequirementsBanner,
    };
}
