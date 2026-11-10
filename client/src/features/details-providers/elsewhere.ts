/** "Jellyfin Elsewhere": streaming providers for a title, per region, on its details page. */
import { api, bridge } from './host';
import type { ElsewhereBridge } from './host';
import type { ElsewhereSettings } from '../../contracts/generated';
import { sessionLease, hashItemId, lookupDetailsItem, visibleDetailPage } from './page';
import { externalLink, pathSegment, safeHref } from './links';
import { field, int, list } from './wire';
import {
    FALLBACK_PROVIDERS, FALLBACK_REGIONS, applyProviderFilters, decodeWatchProviders, groupSeasonsByProviders,
    isDefaultSeasonOrder, joinRegionNames, mapWithLimit, parseProviderList, parseProviders, parseRegions,
    readUserElsewhere, regionOf, seasonLabelParts, streamingErrorMessage
} from './elsewhere-domain';
import type { ProviderFilters, SeasonEntry, StreamingService, WatchProviders } from './elsewhere-domain';

const JE = bridge<ElsewhereBridge>('Jellyfin Elsewhere');
const LOG = '🪼 Jellyfin Enhanced: 🎬 Jellyfin Elsewhere:';

interface SeasonContext { kind: 'series' | 'season'; seriesId: string; tmdbId: string; seasonNumber: number | null }
interface SeasonView { servicesOverride?: StreamingService[]; link?: string | undefined; groups?: { label: string; services: StreamingService[] }[] }

/** Runs only when the server reports TMDB is configured. */
JE.initializeElsewhereScript = function initializeElsewhereScript() {
    const config = JE.pluginConfig;
    if (!config.ElsewhereEnabled) {
        console.log(`${LOG} Feature is disabled in plugin settings.`);
        return;
    }
    const TmdbEnabled = !!config.TmdbEnabled;
    const DEFAULT_REGION = config.DEFAULT_REGION || 'US';
    const filters: ProviderFilters = { defaults: parseProviderList(config.DEFAULT_PROVIDERS), ignore: parseProviderList(config.IGNORE_PROVIDERS) };
    const BRANDING_TEXT = config.ElsewhereCustomBrandingText || '';
    const BRANDING_IMAGE_URL = config.ElsewhereCustomBrandingImageUrl || '';
    const SEASON_PROVIDERS_ADMIN = config.ElsewhereSeasonProviders !== false;

    if (!TmdbEnabled) {
        console.log(`${LOG} TMDB is not configured, skipping initialization`);
        return;
    }

    let userRegion = DEFAULT_REGION;
    let userRegions: string[] = [];
    let userServices: string[] = [];
    let availableRegions: Record<string, string> = {};
    let availableProviders: string[] = [];
    let userSeasonProviders = true;
    let settingsGeneration = 0;
    let formRequest = 0;
    const filterServices = (services: StreamingService[] | undefined) =>
        applyProviderFilters(services, filters, error => console.error(`${LOG} Invalid regex in IGNORE_PROVIDERS.`, error));
    const regionName = (code: string) => (Object.prototype.hasOwnProperty.call(availableRegions, code) ? availableRegions[code] : undefined) || code;

    console.log('🪼 Jellyfin Enhanced: 🎬 Jellyfin Elsewhere starting...');

    function loadRegionsAndProviders(): void {
        fetch(JE.cdn.url('elsewhere-res', 'regions.txt'))
            .then(response => response.ok ? response.text() : Promise.reject(new Error(`HTTP ${response.status}`)))
            .then(body => { availableRegions = { ...availableRegions, ...parseRegions(body) }; })
            .catch(() => { availableRegions = { ...FALLBACK_REGIONS }; });
        fetch(JE.cdn.url('elsewhere-res', 'providers.txt'))
            .then(response => response.ok ? response.text() : Promise.reject(new Error(`HTTP ${response.status}`)))
            .then(body => { availableProviders = parseProviders(body); })
            .catch(() => { availableProviders = [...FALLBACK_PROVIDERS]; });
    }

    function createMaterialIcon(iconName: string, size = '18px'): HTMLSpanElement {
        const icon = document.createElement('span');
        icon.className = 'material-icons';
        icon.textContent = iconName;
        icon.style.fontSize = size;
        icon.style.lineHeight = '1';
        return icon;
    }

    function createAutocompleteInput(placeholder: string, options: readonly string[], selectedValues: string[]): HTMLDivElement {
        const container = document.createElement('div');
        container.style.cssText = 'position: relative; margin-bottom: 6px;';

        let debounceTimer: number | undefined;
        const filterOptions = (filterText: string) => {
            const value = filterText.toLowerCase();
            if (value.length === 0) {
                dropdown.style.display = 'none';
                return;
            }
            showDropdown(options.filter(option => option.toLowerCase().includes(value) && !selectedValues.includes(option)));
        };
        // helpers.debounce when available, for consistent behavior
        const debounce = JE.helpers.debounce;
        let pendingText = '';
        const debouncedFilter = debounce ? debounce.call(JE.helpers, () => filterOptions(pendingText), 300) : null;

        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = placeholder;
        input.style.cssText = `
                width: 100%;
                padding: 10px;
                border: 1px solid #444;
                border-radius: 6px;
                box-sizing: border-box;
                background: #2a2a2a;
                color: #fff;
                font-size: 14px;
            `;

        const dropdown = document.createElement('div');
        dropdown.style.cssText = `
                position: absolute;
                top: 100%;
                left: 0;
                right: 0;
                background: #1a1a1a;
                border: 1px solid #444;
                border-top: none;
                border-radius: 6px;
                max-height: 200px;
                overflow-y: auto;
                display: none;
                z-index: 1000;
            `;

        const selectedContainer = document.createElement('div');
        selectedContainer.style.cssText = `
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
                margin-top: 6px;
            `;

        let selectedIndex = -1;
        let filteredOptions: string[] = [];

        function updateSelected(): void {
            selectedContainer.replaceChildren();
            for (const value of selectedValues) {
                const tag = document.createElement('span');
                tag.className = 'selected-tag';
                tag.style.cssText = `
                        background: #0078d4;
                        color: white;
                        padding: 4px 10px;
                        border-radius: 16px;
                        font-size: 12px;
                        display: inline-flex;
                        align-items: center;
                        gap: 6px;
                    `;
                tag.textContent = value;
                tag.dataset.value = value;
                const remove = document.createElement('span');
                remove.textContent = '×';
                remove.style.cssText = 'cursor: pointer; font-weight: bold; font-size: 14px;';
                remove.onclick = () => {
                    const index = selectedValues.indexOf(value);
                    if (index > -1) {
                        selectedValues.splice(index, 1);
                        updateSelected();
                    }
                };
                tag.appendChild(remove);
                selectedContainer.appendChild(tag);
            }
        }

        function showDropdown(matches: string[]): void {
            dropdown.replaceChildren();
            dropdown.style.display = 'block';
            filteredOptions = matches;
            selectedIndex = -1;
            matches.forEach((option, index) => {
                const item = document.createElement('div');
                item.textContent = option;
                item.style.cssText = `
                        padding: 10px;
                        cursor: pointer;
                        border-bottom: 1px solid #333;
                        color: #fff;
                        font-size: 14px;
                    `;
                item.dataset.index = String(index);
                item.onmouseenter = () => {
                    clearSelection();
                    item.style.background = '#333';
                    selectedIndex = index;
                };
                item.onmouseleave = () => { item.style.background = '#1a1a1a'; };
                item.onclick = () => selectOption(option);
                dropdown.appendChild(item);
            });
        }
        function clearSelection(): void {
            dropdown.querySelectorAll<HTMLElement>('div').forEach(item => { item.style.background = '#1a1a1a'; });
        }
        function updateSelection(): void {
            clearSelection();
            if (selectedIndex >= 0 && selectedIndex < filteredOptions.length) {
                const item = dropdown.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`);
                if (item) {
                    item.style.background = '#333';
                    item.scrollIntoView({ block: 'nearest' });
                }
            }
        }
        function selectOption(option: string): void {
            if (!selectedValues.includes(option)) {
                selectedValues.push(option);
                updateSelected();
            }
            input.value = '';
            dropdown.style.display = 'none';
            selectedIndex = -1;
        }

        input.oninput = () => {
            if (debouncedFilter) {
                pendingText = input.value;
                debouncedFilter();
            } else {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => filterOptions(input.value), 300);
            }
        };
        input.onkeydown = event => {
            if (dropdown.style.display === 'none') return;
            switch (event.key) {
                case 'ArrowDown':
                    event.preventDefault();
                    selectedIndex = Math.min(selectedIndex + 1, filteredOptions.length - 1);
                    updateSelection();
                    break;
                case 'ArrowUp':
                    event.preventDefault();
                    selectedIndex = Math.max(selectedIndex - 1, -1);
                    updateSelection();
                    break;
                case 'Enter': {
                    event.preventDefault();
                    const option = filteredOptions[selectedIndex];
                    if (selectedIndex >= 0 && option !== undefined) selectOption(option);
                    break;
                }
                case 'Escape':
                    dropdown.style.display = 'none';
                    selectedIndex = -1;
                    break;
            }
        };
        input.onblur = () => {
            // Delay hiding to allow clicks on dropdown items
            setTimeout(() => {
                if (!dropdown.contains(document.activeElement)) dropdown.style.display = 'none';
            }, 200);
        };

        container.append(input, dropdown, selectedContainer);
        updateSelected();
        return container;
    }

    const MODAL_ID = 'streaming-settings-modal';
    function closeSettingsForm(): void {
        const modal = document.getElementById(MODAL_ID);
        if (modal instanceof HTMLElement) { modal.style.display = 'none'; modal.replaceChildren(); }
    }
    function settingsModal(): HTMLDivElement {
        const existing = document.getElementById(MODAL_ID);
        if (existing instanceof HTMLDivElement) return existing;
        const modal = document.createElement('div');
        modal.id = MODAL_ID;
        modal.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0,0,0,0.85);
                display: none;
                z-index: 10000;
                align-items: center;
                justify-content: center;
            `;
        // Close on backdrop click
        modal.onclick = event => {
            if (event.target === modal) modal.style.display = 'none';
        };
        document.body.appendChild(modal);
        return modal;
    }

    function element<K extends keyof HTMLElementTagNameMap>(tag: K, cssText: string, textContent?: string): HTMLElementTagNameMap[K] {
        const node = document.createElement(tag);
        node.style.cssText = cssText;
        if (textContent !== undefined) node.textContent = textContent;
        return node;
    }

    /**
     * (Re)renders the settings form from the current user's settings. Built
     * on every open, so it shows the signed-in user's choices after an SPA
     * account switch and regions loaded after start-up.
     */
    function renderSettingsContent(modal: HTMLDivElement, source: object): void {
        const sameSession = sessionLease(JE.session);
        const generation = settingsGeneration;
        const current = () => sameSession() && generation === settingsGeneration;
        let saving = false;
        const content = element('div', `
                background: #181818;
                padding: 20px;
                border-radius: 8px;
                max-width: 500px;
                width: 90%;
                max-height: 80vh;
                overflow-y: auto;
                color: #fff;
                border: 1px solid #333;
                box-shadow: 0 8px 32px rgba(0,0,0,0.5);
            `);
        content.appendChild(element('h3', 'margin-top: 0; margin-bottom: 16px; color: #fff; font-size: 18px; font-weight: bolder;', JE.t('elsewhere_settings_title')));

        const countryBlock = element('div', 'margin-bottom: 16px;');
        const countryHeader = element('div', 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;');
        countryHeader.appendChild(element('label', 'font-weight: 600; color: #ccc;', JE.t('elsewhere_settings_country')));
        const resetRegionBtn = element('button', 'display: flex; align-items: center; justify-content: center; background: transparent; border: none; color: #999; cursor: pointer; padding: 2px; border-radius: 4px;');
        resetRegionBtn.type = 'button';
        resetRegionBtn.id = 'reset-region-btn';
        resetRegionBtn.title = 'Reset to plugin default';
        resetRegionBtn.appendChild(createMaterialIcon('restart_alt', '16px'));
        countryHeader.appendChild(resetRegionBtn);
        countryBlock.appendChild(countryHeader);
        const regionSelect = element('select', 'width: 100%; padding: 12px; border: 1px solid #444; border-radius: 6px; background: #2a2a2a; color: #fff; font-size: 14px;');
        regionSelect.id = 'region-select';
        for (const [code, name] of Object.entries(availableRegions)) {
            const option = document.createElement('option');
            option.value = code;
            option.textContent = name;
            if (code === userRegion) option.selected = true;
            regionSelect.appendChild(option);
        }
        // A CDN catalog is optional. Keep the actual stored selection, plus the
        // admin default needed by Reset, even if that catalog is late/incomplete.
        for (const code of new Set([userRegion, DEFAULT_REGION])) {
            if (Array.from(regionSelect.options).some(option => option.value === code)) continue;
            const option = document.createElement('option');
            option.value = code;
            option.textContent = code;
            regionSelect.appendChild(option);
        }
        regionSelect.value = userRegion;
        countryBlock.appendChild(regionSelect);
        content.appendChild(countryBlock);

        const regionsBlock = element('div', 'margin-bottom: 16px;');
        regionsBlock.appendChild(element('label', 'display: block; margin-bottom: 5px; font-weight: 600; color: #ccc;', JE.t('elsewhere_settings_other_countries')));
        const regionsContainer = document.createElement('div');
        regionsContainer.id = 'regions-autocomplete';
        regionsBlock.appendChild(regionsContainer);
        content.appendChild(regionsBlock);

        const servicesBlock = element('div', 'margin-bottom: 16px;');
        servicesBlock.appendChild(element('label', 'display: block; margin-bottom: 6px; font-weight: 600; color: #ccc;', JE.t('elsewhere_settings_providers')));
        const servicesContainer = document.createElement('div');
        servicesContainer.id = 'services-autocomplete';
        servicesBlock.appendChild(servicesContainer);
        content.appendChild(servicesBlock);

        let seasonCheckbox: HTMLInputElement | null = null;
        if (SEASON_PROVIDERS_ADMIN) {
            const seasonLabel = element('label', 'display: flex; align-items: center; gap: 8px; margin-bottom: 16px; color: #ccc; cursor: pointer;');
            seasonCheckbox = element('input', 'width: 16px; height: 16px; cursor: pointer;');
            seasonCheckbox.type = 'checkbox';
            seasonCheckbox.id = 'season-providers-checkbox';
            seasonCheckbox.checked = userSeasonProviders;
            seasonLabel.append(seasonCheckbox, element('span', '', JE.t('elsewhere_settings_season_providers')));
            content.appendChild(seasonLabel);
        }

        const buttons = element('div', 'display: flex; gap: 12px; justify-content: flex-end;');
        const cancel = element('button', 'padding: 10px 18px; border: 1px solid #444; background: #2a2a2a; color: #fff; border-radius: 6px; cursor: pointer; font-size: 14px;', JE.t('elsewhere_settings_cancel'));
        cancel.id = 'cancel-settings';
        const save = element('button', 'padding: 10px 18px; border: none; background: #0078d4; color: white; border-radius: 6px; cursor: pointer; font-size: 14px;', JE.t('elsewhere_settings_save'));
        save.id = 'save-settings';
        buttons.append(cancel, save);
        content.appendChild(buttons);

        // Reset the region dropdown to the admin-configured default
        resetRegionBtn.onmouseenter = () => { resetRegionBtn.style.color = '#fff'; };
        resetRegionBtn.onmouseleave = () => { resetRegionBtn.style.color = '#999'; };
        resetRegionBtn.onclick = () => { regionSelect.value = DEFAULT_REGION; };

        const regionOptions = Object.entries(availableRegions).map(([code, name]) => `${name} (${code})`);
        regionsContainer.appendChild(createAutocompleteInput(
            JE.t('elsewhere_settings_add_countries_placeholder'), regionOptions, userRegions.map(code => `${regionName(code)} (${code})`)));
        servicesContainer.appendChild(createAutocompleteInput(
            JE.t('elsewhere_settings_add_providers_placeholder'), availableProviders, userServices.slice()));

        cancel.onclick = () => { modal.style.display = 'none'; };
        save.onclick = async () => {
            if (saving || !current() || !modal.isConnected || modal.style.display === 'none') return;
            saving = true;
            save.disabled = true;
            const region = regionSelect.value;
            const selectedRegions: string[] = [];
            regionsContainer.querySelectorAll<HTMLElement>('.selected-tag').forEach(tag => {
                const match = (tag.dataset.value ?? '').match(/\(([A-Z]{2})\)$/);
                if (match?.[1]) selectedRegions.push(match[1]);
            });
            const regions = selectedRegions;
            const selectedServices: string[] = [];
            servicesContainer.querySelectorAll<HTMLElement>('.selected-tag').forEach(tag => {
                selectedServices.push((tag.dataset.value ?? '').trim());
            });
            const services = selectedServices;
            const seasonProviders = seasonCheckbox?.checked ?? userSeasonProviders;
            const elsewhereSettings: ElsewhereSettings = {
                ...source, Region: region, Regions: regions, Services: services, SeasonProviders: seasonProviders
            };
            try {
                await JE.saveUserSettings('elsewhere.json', elsewhereSettings, { throwOnError: true, isCurrent: current });
                if (!current()) return;
                JE.userConfig.elsewhere = elsewhereSettings;
                loadSettings();
            } catch (_) {
                if (current() && modal.isConnected) {
                    let error = content.querySelector('.je-elsewhere-save-error');
                    if (!error) { error = document.createElement('p'); error.className = 'je-elsewhere-save-error'; error.setAttribute('role', 'alert'); buttons.before(error); }
                    error.textContent = settingsText('elsewhere_settings_save_failed', 'Could not save your choices. Try again.');
                }
            } finally { saving = false; if (current()) save.disabled = false; }
        };
        modal.replaceChildren(content);
    }
    function validPreferenceDocument(value: unknown): value is object {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
        const region = field(value, 'Region');
        const regions = field(value, 'Regions');
        const services = field(value, 'Services');
        const season = field(value, 'SeasonProviders');
        return (region == null || typeof region === 'string')
            && (regions == null || (Array.isArray(regions) && regions.every(x => typeof x === 'string')))
            && (services == null || (Array.isArray(services) && services.every(x => typeof x === 'string')))
            && (season == null || typeof season === 'boolean');
    }
    function settingsText(key: string, fallback: string): string {
        const text = JE.t(key);
        return text && text !== key ? text : fallback;
    }
    function openSettings(): void {
        const modal = settingsModal();
        const request = ++formRequest;
        const sameSession = sessionLease(JE.session);
        const current = () => request === formRequest && sameSession() && modal.isConnected && modal.style.display !== 'none';
        modal.replaceChildren(element('p', 'color: #fff;', settingsText('elsewhere_settings_loading', 'Loading your settings…')));
        modal.style.display = 'flex';
        const client = api();
        const user = client.getCurrentUserId();
        // A bootstrap fallback cannot prove the user's preferences were read.
        // A form always requires its own acknowledged, identity-bound document.
        void Promise.resolve().then(() => {
            if (!current() || !user) throw new Error('Settings opening cancelled');
            return client.ajax({ type: 'GET', url: client.getUrl(`/JellyfinEnhanced/user-settings/${user}/elsewhere.json?_=${Date.now()}`), dataType: 'json' });
        }).then(response => {
            if (!current()) return;
            if (!validPreferenceDocument(response)) throw new Error('Invalid Elsewhere settings document');
            const settings = readUserElsewhere(response, DEFAULT_REGION);
            userRegion = settings.region;
            userRegions = settings.regions;
            userServices = settings.services;
            userSeasonProviders = settings.seasonProviders;
            invalidateProviderPanels();
            renderSettingsContent(modal, response);
            addStreamingLookup();
        }).catch(() => {
            if (!current()) return;
            const message = element('div', 'padding: 24px; background: #181818; color: #fff;', settingsText('elsewhere_settings_load_failed', 'Your settings could not be loaded. No changes were saved.'));
            const retry = element('button', '', settingsText('elsewhere_settings_retry', 'Retry'));
            retry.type = 'button'; retry.onclick = openSettings;
            const cancel = element('button', '', JE.t('elsewhere_settings_cancel'));
            cancel.type = 'button'; cancel.onclick = () => { modal.style.display = 'none'; formRequest++; };
            message.append(retry, cancel); modal.replaceChildren(message);
        });
    }

    function invalidateProviderPanels(): void {
        settingsGeneration++;
        document.querySelectorAll('.streaming-lookup-container').forEach(panel => panel.remove());
        seasonProvidersCache.clear();
        tmdbSeasonNumbersCache.clear();
        seasonFallbackInFlight.clear();
    }
    function loadSettings(rebuild = true): void {
        const settings = readUserElsewhere(JE.userConfig.elsewhere, DEFAULT_REGION);
        userRegion = settings.region;
        userRegions = settings.regions;
        userServices = settings.services;
        userSeasonProviders = settings.seasonProviders;
        if (!rebuild) return;
        formRequest++;
        closeSettingsForm();
        invalidateProviderPanels();
        if (rebuild) addStreamingLookup();
    }
    document.addEventListener('je:user-data-loaded', () => loadSettings());
    JE.session?.onUserChange('elsewhere', () => {
        userRegion = DEFAULT_REGION;
        userRegions = [];
        userServices = [];
        userSeasonProviders = true;
        formRequest++;
        closeSettingsForm();
        invalidateProviderPanels();
    });

    function createServiceBadge(service: StreamingService): HTMLDivElement {
        const badge = element('div', `
                display: inline-flex;
                align-items: center;
                padding: 6px 10px;
                margin: 3px 5px 3px 0;
                border-radius: 8px;
                font-size: 13px;
                font-weight: 500;
                color: #fff;
                white-space: nowrap;
                transition: all 500ms ease;
                background: rgba(255, 255, 255, 0.1);
                border: 1px solid rgba(255, 255, 255, 0.2);
                backdrop-filter: blur(10px);
            `);
        const logo = document.createElement('img');
        logo.src = `https://image.tmdb.org/t/p/w92${service.logo_path}`;
        logo.alt = service.provider_name;
        logo.style.cssText = `
                width: 20px;
                height: 20px;
                margin-right: 8px;
                object-fit: contain;
                border-radius: 4px;
            `;
        logo.onerror = () => { logo.style.display = 'none'; };
        badge.appendChild(logo);
        const label = document.createElement('span');
        label.textContent = service.provider_name;
        badge.appendChild(label);
        badge.onmouseenter = () => {
            badge.style.transform = 'translateY(-2px)';
            badge.style.background = 'rgba(255, 255, 255, 0.2)';
            badge.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.3)';
        };
        badge.onmouseleave = () => {
            badge.style.transform = 'translateY(0)';
            badge.style.background = 'rgba(255, 255, 255, 0.1)';
            badge.style.boxShadow = 'none';
        };
        return badge;
    }

    // Kept in the core response cache (30 minutes, dropped on a user switch;
    // the same key the Seerr TMDB helper uses): a revisit costs no request.
    function fetchStreamingData(tmdbId: string, mediaType: string, callback: (error: string | null, data: WatchProviders | null) => void): void {
        const sameSession = sessionLease(JE.session);
        const generation = settingsGeneration;
        const current = () => sameSession() && generation === settingsGeneration;
        const path = `/${mediaType}/${pathSegment(tmdbId)}/watch/providers`;
        const url = api().getUrl(`/JellyfinEnhanced/tmdb${path}`);
        JE.core.api.fetch(url, { cacheKey: `tmdb:${path}` })
            .then(data => { if (current()) callback(null, decodeWatchProviders(data)); })
            .catch((error: unknown) => { if (current()) callback(streamingErrorMessage(error), null); });
    }

    // Per-season providers. Only for the default (aired) season order: TMDB's
    // season numbers would not line up with an alternate Jellyfin order.
    const SEASON_FETCH_CONCURRENCY = 4;
    const seasonProvidersCache = new Map<string, Promise<WatchProviders | null>>();
    const tmdbSeasonNumbersCache = new Map<string, Promise<Set<number> | null>>();

    function fetchSeasonProviders(tmdbId: string, seasonNumber: number): Promise<WatchProviders | null> {
        const key = `${tmdbId}:${seasonNumber}`;
        let pending = seasonProvidersCache.get(key);
        if (!pending) {
            const url = api().getUrl(`/JellyfinEnhanced/tmdb/tv/${pathSegment(tmdbId)}/season/${seasonNumber}/watch/providers`);
            pending = JE.core.api.fetch(url).then(decodeWatchProviders).catch(() => {
                seasonProvidersCache.delete(key);
                return null;
            });
            seasonProvidersCache.set(key, pending);
        }
        return pending;
    }
    function fetchTmdbSeasonNumbers(tmdbId: string): Promise<Set<number> | null> {
        let pending = tmdbSeasonNumbersCache.get(tmdbId);
        if (!pending) {
            const url = api().getUrl(`/JellyfinEnhanced/tmdb/tv/${pathSegment(tmdbId)}`);
            pending = JE.core.api.fetch(url)
                .then(data => {
                    const seasons = field(data, 'seasons');
                    return Array.isArray(seasons) ? new Set(seasons.map(season => int(field(season, 'season_number'))).filter((n): n is number => n !== undefined)) : null;
                })
                .catch(() => {
                    tmdbSeasonNumbersCache.delete(tmdbId);
                    return null;
                });
            tmdbSeasonNumbersCache.set(tmdbId, pending);
        }
        return pending;
    }
    async function fetchJellyfinSeasonNumbers(seriesId: string): Promise<number[]> {
        const client = api();
        const url = client.getUrl(`Shows/${seriesId}/Seasons`, { userId: client.getCurrentUserId() ?? '' });
        const result = await JE.core.api.fetch(url);
        return list(field(result, 'Items'))
            .map(season => field(season, 'IndexNumber'))
            .filter((number): number is number => Number.isInteger(number))
            .sort((a, b) => a - b);
    }

    async function resolveSeasonContext(expectedTmdbId?: string): Promise<SeasonContext | null> {
        if (!SEASON_PROVIDERS_ADMIN || !userSeasonProviders) return null;
        const itemId = hashItemId();
        if (!itemId) return null;
        const item = await lookupDetailsItem(JE.helpers, itemId, false);
        if (!item) return null;
        let series;
        let seasonNumber: number | null = null;
        if (item.Type === 'Series') {
            series = item;
        } else if (item.Type === 'Season' && item.SeriesId && Number.isInteger(item.IndexNumber)) {
            series = await lookupDetailsItem(JE.helpers, item.SeriesId, false);
            seasonNumber = item.IndexNumber ?? null;
        } else {
            return null;
        }
        if (!series || !series.Id || !isDefaultSeasonOrder(series.DisplayOrder)) return null;
        const tmdbId = series.ProviderIds.Tmdb;
        if (!tmdbId || (expectedTmdbId && tmdbId !== expectedTmdbId)) return null;
        return { kind: seasonNumber === null ? 'series' : 'season', seriesId: series.Id, tmdbId, seasonNumber };
    }

    function formatSeasonLabel(seasonNumbers: number[]): string {
        const parts = seasonLabelParts(seasonNumbers);
        if (parts.single !== null) return JE.t('elsewhere_season_label', { number: parts.single });
        if (parts.specialsOnly) return JE.t('jellyseerr_season_specials');
        const ranges = [...parts.ranges];
        if (parts.hasSpecials) ranges.push(JE.t('jellyseerr_season_specials'));
        return JE.t('elsewhere_seasons_label', { range: ranges.join(', ') });
    }

    async function buildSeasonView(ctx: SeasonContext, seriesData: WatchProviders): Promise<SeasonView | null> {
        const seriesServices = filterServices(regionOf(seriesData, userRegion)?.flatrate);
        const tmdbSeasons = await fetchTmdbSeasonNumbers(ctx.tmdbId);
        const seasonNumbers = ctx.kind === 'season' && ctx.seasonNumber !== null
            ? [ctx.seasonNumber]
            : await fetchJellyfinSeasonNumbers(ctx.seriesId);
        if (seasonNumbers.length === 0) return null;

        const entries = await mapWithLimit(seasonNumbers, SEASON_FETCH_CONCURRENCY, async (number): Promise<SeasonEntry | null> => {
            const knownToTmdb = !tmdbSeasons || tmdbSeasons.has(number);
            const data = knownToTmdb ? await fetchSeasonProviders(ctx.tmdbId, number) : null;
            const own = filterServices(regionOf(data, userRegion)?.flatrate);
            if (own.length > 0) return { number, services: own, link: regionOf(data, userRegion)?.link };
            if (number === 0) return null;
            return { number, services: seriesServices, link: undefined };
        });
        const seasons = entries.filter((entry): entry is SeasonEntry => !!entry);
        const [first] = seasons;
        if (!first) return null;
        if (ctx.kind === 'season') return { servicesOverride: first.services, link: first.link };
        const groups = groupSeasonsByProviders(seasons);
        return groups ? { groups: groups.map(group => ({ label: formatSeasonLabel(group.numbers), services: group.services })) } : null;
    }

    function controlButton(className: string, icon: string, extraCss: string): HTMLButtonElement {
        const button = document.createElement('button');
        button.className = className;
        button.appendChild(createMaterialIcon(icon, '16px'));
        button.style.cssText = extraCss;
        button.onmouseenter = () => { button.style.background = 'rgba(255, 255, 255, 0.2)'; };
        button.onmouseleave = () => { button.style.background = 'rgba(255, 255, 255, 0.1)'; };
        return button;
    }
    function closeButton(target: HTMLElement): HTMLButtonElement {
        const button = document.createElement('button');
        button.appendChild(createMaterialIcon('close', '16px'));
        button.style.cssText = `
                display: flex;
                align-items: center;
                justify-content: center;
                background: rgba(255, 255, 255, 0.1);
                color: #fff;
                border: 1px solid rgba(255, 255, 255, 0.2);
                padding: 6px;
                border-radius: 4px;
                cursor: pointer;
                transition: all 500ms ease;
                width: 28px;
                height: 28px;
            `;
        button.onmouseenter = () => {
            button.style.background = 'rgba(255, 0, 0, 0.2)';
            button.style.borderColor = 'rgba(255, 0, 0, 0.3)';
        };
        button.onmouseleave = () => {
            button.style.background = 'rgba(255, 255, 255, 0.1)';
            button.style.borderColor = 'rgba(255, 255, 255, 0.2)';
        };
        button.onclick = () => target.remove();
        return button;
    }

    // The default region's results (auto-loaded). userRegion is the effective
    // region: the user's override if set, else the admin's DEFAULT_REGION.
    function processDefaultRegionData(data: WatchProviders, tmdbId: string, mediaType: string, seasonView: SeasonView = {}): HTMLDivElement {
        const regionData = regionOf(data, userRegion);
        const container = element('div', `
                margin: 10px 0;
                padding: 12px;
                background: rgba(0, 0, 0, 0.2);
                border-radius: 8px;
                border: 1px solid rgba(255, 255, 255, 0.1);
                backdrop-filter: blur(10px);
                position: relative;
            `);
        const header = element('div', `
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 10px;
            `);

        const hasServices = !!regionData?.flatrate && regionData.flatrate.length > 0;
        let filteredServices = hasServices ? filterServices(regionData?.flatrate) : [];
        if (seasonView.servicesOverride) filteredServices = seasonView.servicesOverride;
        const seasonGroups = seasonView.groups || null;
        const linkUrl = seasonView.link || regionData?.link || '';
        const hasFilteredServices = !!seasonGroups || filteredServices.length > 0;
        const brandedEmpty = !hasFilteredServices && !!BRANDING_TEXT;

        // Clickable title linking to JustWatch
        const title = externalLink(JE.helpers, (hasFilteredServices && linkUrl) ? linkUrl : '#', { title: 'JustWatch' });
        if (hasFilteredServices) {
            title.textContent = JE.t('elsewhere_panel_available_in', { region: regionName(userRegion) });
        } else if (BRANDING_TEXT) {
            // Custom branding when nothing is available and branding is configured
            title.textContent = BRANDING_TEXT;
            title.classList.add('elsewhere-custom-branding');
            title.style.cursor = 'default';
            if (BRANDING_IMAGE_URL) {
                title.style.display = 'flex';
                title.style.alignItems = 'center';
                title.style.gap = '8px';
                const icon = document.createElement('img');
                icon.src = BRANDING_IMAGE_URL;
                icon.alt = 'Custom Branding';
                icon.className = 'elsewhere-custom-branding-icon';
                icon.style.cssText = `
                        width: 24px;
                        height: 24px;
                        object-fit: contain;
                        margin-left: 4px;
                    `;
                icon.onerror = () => { icon.style.display = 'none'; };
                title.appendChild(icon);
            }
        } else {
            title.textContent = JE.t('elsewhere_panel_not_available_in', { region: regionName(userRegion) });
        }
        title.style.cssText = `
                font-weight: 600;
                font-size: 14px;
                text-decoration: none;
                cursor: pointer;
                color: #fff;
                flex: 1;
                text-align: left;
                display: flex;
                align-items: flex-end;
            `;
        if (hasFilteredServices && linkUrl) {
            title.classList.add('elsewhere-link-reset');
            title.href = safeHref(linkUrl);
            title.style.padding = '0';
            title.style.margin = '0';
        } else if (brandedEmpty) {
            title.style.cursor = 'default';
        }

        const controls = element('div', `
                display: flex;
                gap: 8px;
                align-items: center;
            `);
        const searchButton = controlButton('elsewhere-search-button', 'search', `
                display: flex;
                align-items: center;
                gap: 6px;
                background: rgba(255, 255, 255, 0.1);
                color: #fff;
                border: 1px solid rgba(255, 255, 255, 0.2);
                padding: 6px 12px;
                border-radius: 4px;
                font-size: 12px;
                font-weight: 500;
                cursor: pointer;
                transition: all 500ms ease;
                opacity: ${brandedEmpty ? '0' : '1'};
            `);
        searchButton.appendChild(document.createTextNode(''));
        const settingsButton = controlButton('elsewhere-settings-button', 'settings', `
                display: flex;
                align-items: center;
                justify-content: center;
                background: rgba(255, 255, 255, 0.1);
                color: #fff;
                border: 1px solid rgba(255, 255, 255, 0.2);
                padding: 6px;
                border-radius: 4px;
                cursor: pointer;
                transition: all 500ms ease;
                width: 28px;
                height: 28px;
                opacity: ${brandedEmpty ? '0' : '1'};
            `);
        settingsButton.onclick = () => openSettings();
        controls.append(searchButton, settingsButton);
        header.append(title, controls);
        container.appendChild(header);

        // Show the buttons on hover when custom branding replaces the panel.
        if (brandedEmpty) {
            container.onmouseenter = () => {
                searchButton.style.opacity = '1';
                settingsButton.style.opacity = '1';
            };
            container.onmouseleave = () => {
                searchButton.style.opacity = '0';
                settingsButton.style.opacity = '0';
            };
        }

        if (hasServices || hasFilteredServices) {
            if (seasonGroups) {
                for (const group of seasonGroups) {
                    container.appendChild(element('div', 'font-size: 12px; font-weight: 600; color: #aaa; margin: 4px 0 2px;', group.label));
                    const groupServices = element('div', 'display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px;');
                    for (const service of group.services) groupServices.appendChild(createServiceBadge(service));
                    container.appendChild(groupServices);
                }
            } else if (hasFilteredServices) {
                const servicesContainer = element('div', 'display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 12px;');
                for (const service of filteredServices) servicesContainer.appendChild(createServiceBadge(service));
                container.appendChild(servicesContainer);
            } else if (filters.defaults.length > 0) {
                // Services exist but all were filtered out by the provider preferences
                container.appendChild(element('div', 'color: #999; font-size: 13px; margin-bottom: 12px;', JE.t('elsewhere_panel_no_configured_services')));
            }
        }

        // Manual multi-region search results
        const resultContainer = document.createElement('div');
        resultContainer.id = 'streaming-result-container';
        container.appendChild(resultContainer);

        searchButton.onclick = () => {
            searchButton.disabled = true;
            searchButton.replaceChildren();
            const loadingIcon = createMaterialIcon('refresh', '16px');
            loadingIcon.style.animation = 'spin 1s linear infinite';
            searchButton.append(loadingIcon, document.createTextNode(' ' + JE.t('elsewhere_panel_search_button')));
            searchButton.style.opacity = '0.7';
            resultContainer.replaceChildren();
            if (!document.querySelector('style[data-jellyfin-elsewhere]')) {
                const style = document.createElement('style');
                style.textContent = `
                    @keyframes spin {
                        0% { transform: rotate(0deg); }
                        100% { transform: rotate(360deg); }
                    }
                `;
                style.setAttribute('data-jellyfin-elsewhere', 'true');
                document.head.appendChild(style);
            }

            fetchStreamingData(tmdbId, mediaType, (error, result) => {
                searchButton.disabled = false;
                searchButton.replaceChildren(createMaterialIcon('search', '16px'), document.createTextNode(''));
                searchButton.style.opacity = '1';
                if (error || !result) {
                    resultContainer.replaceChildren(element('div', 'color: #ff6b6b; font-size: 13px; margin-top: 8px;', JE.t('elsewhere_panel_error', { error: error ?? '' })));
                    return;
                }
                const regionsToSearch = userRegions.length > 0 ? userRegions : [userRegion];
                let hasAnyResults = false;
                const unavailableRegions: string[] = [];
                regionsToSearch.forEach((region, index) => {
                    const data = regionOf(result, region);
                    const offered = data?.flatrate ?? [];
                    const services = userServices.length > 0 ? offered.filter(service => userServices.includes(service.provider_name)) : offered;
                    if (offered.length > 0 && services.length > 0) {
                        hasAnyResults = true;
                        const regionResult = processRegionData(result, region);
                        if (regionResult) {
                            if (index > 0 || unavailableRegions.length > 0) regionResult.style.marginTop = '6px';
                            resultContainer.appendChild(regionResult);
                        }
                    } else {
                        unavailableRegions.push(region);
                    }
                });
                // Unavailable regions first
                if (unavailableRegions.length > 0) {
                    resultContainer.insertBefore(createUnavailableRegionsDisplay(unavailableRegions), resultContainer.firstChild);
                }
                if (!hasAnyResults && unavailableRegions.length === 0) {
                    resultContainer.appendChild(element('div', 'color: #6c757d; font-size: 13px; margin-top: 8px;', JE.t('elsewhere_panel_no_services_in_regions')));
                }
            });
        };
        return container;
    }

    function createUnavailableRegionsDisplay(unavailableRegions: string[]): HTMLDivElement {
        const container = element('div', `
                margin: 0 0 6px 0;
                padding: 12px;
                border-radius: 8px;
                border: 1px solid rgba(139, 19, 19, 0.6);
                background: rgba(139, 19, 19, 0.3);
                backdrop-filter: blur(10px);
                position: relative;
            `);
        const header = element('div', `
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 0;
            `);
        const title = element('div', `
                font-weight: 600;
                font-size: 14px;
                color: rgb(255, 20, 20);
                flex: 1;
            `, JE.t('elsewhere_panel_not_available_in_regions', { regions: joinRegionNames(unavailableRegions.map(regionName)) }));
        const close = closeButton(container);
        close.title = 'Close';
        header.append(title, close);
        container.appendChild(header);
        return container;
    }

    // One region's results (manual search).
    function processRegionData(data: WatchProviders, region: string): HTMLDivElement | null {
        const regionData = regionOf(data, region);
        if (!regionData?.flatrate) return null;
        const services = regionData.flatrate.filter(service => userServices.length === 0 || userServices.includes(service.provider_name));
        if (services.length === 0) return null;

        const container = element('div', `
                margin: 10px 0 0 0;
                padding: 12px;
                background: rgba(0, 0, 0, 0.3);
                border-radius: 8px;
                border: 1px solid rgba(255, 255, 255, 0.1);
                backdrop-filter: blur(10px);
                position: relative;
            `);
        const header = element('div', `
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 10px;
            `);
        const title = externalLink(JE.helpers, regionData.link || '#', { title: 'JustWatch' });
        title.textContent = JE.t('elsewhere_panel_available_in_region', { region: regionName(region) });
        title.style.cssText = `
                font-weight: 600;
                font-size: 14px;
                text-decoration: none;
                cursor: pointer;
                color: #fff;
                flex: 1;
                text-align: left;
            `;
        if (regionData.link) {
            title.classList.add('elsewhere-link-reset');
            title.href = safeHref(regionData.link);
            title.style.padding = '0';
            title.style.margin = '0';
        }
        header.append(title, closeButton(container));
        container.appendChild(header);
        const servicesContainer = element('div', 'display: flex; flex-wrap: wrap; gap: 3px;');
        for (const service of services) servicesContainer.appendChild(createServiceBadge(service));
        container.appendChild(servicesContainer);
        return container;
    }

    function autoLoadStreamingData(tmdbId: string, mediaType: string, container: HTMLElement): void {
        const sameSession = sessionLease(JE.session);
        const generation = settingsGeneration;
        const current = () => sameSession() && generation === settingsGeneration && container.isConnected;
        fetchStreamingData(tmdbId, mediaType, async (error, data) => {
            if (!current()) return;
            if (error || !data) {
                container.appendChild(element('div', 'font-size: 13px; margin-top: 8px; color: #ff6b6b;', JE.t('elsewhere_panel_error', { error: error ?? '' })));
                return;
            }
            let seasonView: SeasonView = {};
            if (mediaType === 'tv' && SEASON_PROVIDERS_ADMIN && userSeasonProviders) {
                try {
                    const ctx = await resolveSeasonContext(tmdbId);
                    if (!current()) return;
                    if (ctx) seasonView = (await buildSeasonView(ctx, data)) || {};
                } catch (e) {
                    console.warn(`${LOG} Per-season providers unavailable, using series providers.`, e);
                }
            }
            if (current()) container.appendChild(processDefaultRegionData(data, tmdbId, mediaType, seasonView));
        });
    }

    function mountStreamingLookup(section: Element, tmdbId: string, mediaType: string): void {
        const container = document.createElement('div');
        container.className = 'streaming-lookup-container';
        container.style.cssText = 'margin: 16px 0;';
        autoLoadStreamingData(tmdbId, mediaType, container);
        // Insert after external links or at the end
        const externalLinks = section.querySelector('.itemExternalLinks');
        if (externalLinks?.parentNode) externalLinks.parentNode.insertBefore(container, externalLinks.nextSibling);
        else section.appendChild(container);
    }

    /**
     * Season pages may lack a TMDB link: derive the series' TMDB id from the
     * item. Scoped to the visible detail page, so a hidden cached view (which
     * Jellyfin keeps in the DOM) neither blocks it nor receives its panel.
     */
    const seasonFallbackInFlight = new Set<string>();
    function mountSeasonPageFallback(section: Element): void {
        if (!SEASON_PROVIDERS_ADMIN || !userSeasonProviders) return;
        const page: ParentNode = section.closest('#itemDetailPage') ?? document;
        if (page !== document && page !== visibleDetailPage()) return;
        if (page.querySelector('.streaming-lookup-container')) return;
        if (section !== page.querySelector('.detailSectionContent')) return;
        const itemId = hashItemId();
        if (!itemId || seasonFallbackInFlight.has(itemId)) return;
        seasonFallbackInFlight.add(itemId);
        const sameSession = sessionLease(JE.session);
        const generation = settingsGeneration;
        resolveSeasonContext()
            .then(ctx => {
                if (!sameSession() || generation !== settingsGeneration || !ctx || ctx.kind !== 'season') return;
                if (!section.isConnected || hashItemId() !== itemId || page.querySelector('.streaming-lookup-container')) return;
                mountStreamingLookup(section, ctx.tmdbId, 'tv');
            })
            .catch(() => { /* not a season page / item unavailable */ })
            .finally(() => seasonFallbackInFlight.delete(itemId));
    }

    function addStreamingLookup(): void {
        document.querySelectorAll('.detailSectionContent').forEach(section => {
            const page = section.closest('#itemDetailPage');
            if (page && page !== visibleDetailPage()) return;
            if (section.querySelector('.streaming-lookup-container')) return;
            // The TMDB link gives the id and media type
            const tmdbLink = section.querySelector<HTMLAnchorElement>('a[href*="themoviedb.org"]');
            if (!tmdbLink) {
                mountSeasonPageFallback(section);
                return;
            }
            const match = tmdbLink.href.match(/themoviedb\.org\/(movie|tv)\/(\d+)/);
            if (!match?.[1] || !match[2]) return;
            mountStreamingLookup(section, match[2], match[1]);
        });
    }

    // --- Initialization ---
    loadRegionsAndProviders();
    loadSettings(false);
    const idle = (callback: () => void, timeout: number, fallbackDelay: number) => {
        if (typeof requestIdleCallback !== 'undefined') requestIdleCallback(callback, { timeout });
        else setTimeout(callback, fallbackDelay);
    };
    // The hidden modal exists from start-up; its form is rendered when opened.
    idle(() => { settingsModal(); }, 2000, 2000);

    let processingElsewhere = false;
    const scheduleStreamingLookup = () => {
        if (processingElsewhere) return;
        processingElsewhere = true;
        idle(() => {
            addStreamingLookup();
            processingElsewhere = false;
        }, 500, 100);
    };
    // childList-only routes this through the shared body observer; a cached
    // detail page re-shown by a class toggle is covered by the view-show hook.
    JE.helpers.createObserver('elsewhere', scheduleStreamingLookup, document.body, { childList: true, subtree: true });
    JE.helpers.onViewPage(scheduleStreamingLookup);
    // Initial check
    idle(() => addStreamingLookup(), 1000, 1000);

    console.log('🪼 Jellyfin Enhanced: 🎬 Jellyfin Elsewhere loaded!');
};
