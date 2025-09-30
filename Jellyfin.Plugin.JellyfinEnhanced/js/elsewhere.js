/**
 * @file Manages the "Jellyfin Elsewhere" feature to find streaming providers.
 */
(function(JE) {
    'use strict';

    /**
     * Initializes the Jellyfin Elsewhere script.
     * It will only run if a TMDB API key is configured.
     */
    JE.initializeElsewhereScript = function() {
        if (!JE.pluginConfig.ElsewhereEnabled) {
            console.log('🪼 Jellyfin Enhanced: 🎬 Jellyfin Elsewhere: Feature is disabled in plugin settings.');
            return;
        }
        // --- Configuration ---
        const TMDB_API_KEY = JE.pluginConfig.TMDB_API_KEY || '';
        const DEFAULT_REGION = JE.pluginConfig.DEFAULT_REGION || 'US';
        const DEFAULT_PROVIDERS = JE.pluginConfig.DEFAULT_PROVIDERS ? JE.pluginConfig.DEFAULT_PROVIDERS.replace(/'/g, '').replace(/\n/g, ',').split(',').map(s => s.trim()).filter(s => s) : [];
        const IGNORE_PROVIDERS = JE.pluginConfig.IGNORE_PROVIDERS ? JE.pluginConfig.IGNORE_PROVIDERS.replace(/'/g, '').replace(/\n/g, ',').split(',').map(s => s.trim()).filter(s => s) : [];

        if (!TMDB_API_KEY) {
            console.log('🪼 Jellyfin Enhanced: 🎬 Jellyfin Elsewhere: No TMDB API key configured, skipping initialization');
            return;
        }

        let userRegion = DEFAULT_REGION;
        let userRegions = []; // Multiple regions for search
        let userServices = []; // Empty by default - will show all services from settings region
        let availableRegions = {};
        let availableProviders = [];

        console.log('🪼 Jellyfin Enhanced: 🎬 Jellyfin Elsewhere starting...');

        // Load regions and providers from GitHub repo
        function loadRegionsAndProviders() {
            fetch(`https://raw.githubusercontent.com/n00bcodr/Jellyfin-Elsewhere/refs/heads/main/resources/regions.txt`)
                .then(response => response.ok ? response.text() : Promise.reject())
                .then(text => {
                    const lines = text.trim().split('\n');
                    lines.forEach(line => {
                        if (line.startsWith('#')) return;
                        const [code, name] = line.split('\t');
                        if (code && name) {
                            availableRegions[code] = name;
                        }
                    });
                })
                .catch(() => {
                    // Fallback to hardcoded regions
                    availableRegions = {
                        'US': 'United States', 'GB': 'United Kingdom', 'IN': 'India', 'CA': 'Canada',
                        'DE': 'Germany', 'FR': 'France', 'JP': 'Japan', 'AU': 'Australia',
                        'BR': 'Brazil', 'MX': 'Mexico', 'IE': 'Ireland', 'IT': 'Italy',
                        'ES': 'Spain', 'NL': 'Netherlands', 'SE': 'Sweden', 'NO': 'Norway',
                        'DK': 'Denmark', 'FI': 'Finland'
                    };
                });

                 // Load providers
            fetch(`https://raw.githubusercontent.com/n00bcodr/Jellyfin-Elsewhere/refs/heads/main/resources/providers.txt`)
                .then(response => response.ok ? response.text() : Promise.reject())
                .then(text => {
                    availableProviders = text.trim().split('\n')
                        .filter(line => !line.startsWith('#') && line.trim() !== '');
                })
                .catch(() => {
                    availableProviders = [
                        // Fallback to hardcoded providers
                        'Netflix', 'Amazon Prime Video', 'Disney Plus', 'HBO Max',
                        'Hulu', 'Apple TV Plus', 'Paramount Plus', 'Peacock',
                        'JioCinema', 'Disney+ Hotstar', 'ZEE5', 'SonyLIV'
                    ];
                });
        }

        function createMaterialIcon(iconName, size = '18px') {
            const icon = document.createElement('span');
            icon.className = 'material-icons';
            icon.textContent = iconName;
            icon.style.fontSize = size;
            icon.style.lineHeight = '1';
            return icon;
        }

        function createAutocompleteInput(placeholder, options, selectedValues, onSelect) {
            const container = document.createElement('div');
            container.style.cssText = 'position: relative; margin-bottom: 6px;';

            let debounceTimer;

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
            let filteredOptions = [];

            function updateSelected() {
                selectedContainer.innerHTML = '';
                selectedValues.forEach(value => {
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
                });
            }

            function showDropdown(options) {
                dropdown.innerHTML = '';
                dropdown.style.display = 'block';
                filteredOptions = options;
                selectedIndex = -1;

                options.forEach((option, index) => {
                    const item = document.createElement('div');
                    item.textContent = option;
                    item.style.cssText = `
                        padding: 10px;
                        cursor: pointer;
                        border-bottom: 1px solid #333;
                        color: #fff;
                        font-size: 14px;
                    `;
                    item.dataset.index = index;

                    item.onmouseenter = () => {
                        clearSelection();
                        item.style.background = '#333';
                        selectedIndex = index;
                    };

                    item.onmouseleave = () => {
                        item.style.background = '#1a1a1a';
                    };

                    item.onclick = () => selectOption(option);
                    dropdown.appendChild(item);
                });
            }

            function clearSelection() {
                dropdown.querySelectorAll('div').forEach(item => {
                    item.style.background = '#1a1a1a';
                });
            }

            function updateSelection() {
                clearSelection();
                if (selectedIndex >= 0 && selectedIndex < filteredOptions.length) {
                    const item = dropdown.querySelector(`[data-index="${selectedIndex}"]`);
                    if (item) {
                        item.style.background = '#333';
                        item.scrollIntoView({ block: 'nearest' });
                    }
                }
            }

            function selectOption(option) {
                if (!selectedValues.includes(option)) {
                    selectedValues.push(option);
                    updateSelected();
                    onSelect(selectedValues);
                }
                input.value = '';
                dropdown.style.display = 'none';
                selectedIndex = -1;
            }

            input.oninput = () => {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    const value = input.value.toLowerCase();
                    if (value.length === 0) {
                        dropdown.style.display = 'none';
                        return;
                    }
                    const filtered = options.filter(option =>
                        option.toLowerCase().includes(value) && !selectedValues.includes(option)
                    );
                    showDropdown(filtered);
                }, 300);
            };

            input.onkeydown = (e) => {
                if (dropdown.style.display === 'none') return;

                switch (e.key) {
                    case 'ArrowDown':
                        e.preventDefault();
                        selectedIndex = Math.min(selectedIndex + 1, filteredOptions.length - 1);
                        updateSelection();
                        break;
                    case 'ArrowUp':
                        e.preventDefault();
                        selectedIndex = Math.max(selectedIndex - 1, -1);
                        updateSelection();
                        break;
                    case 'Enter':
                        e.preventDefault();
                        if (selectedIndex >= 0 && selectedIndex < filteredOptions.length) {
                            selectOption(filteredOptions[selectedIndex]);
                        }
                        break;
                    case 'Escape':
                        dropdown.style.display = 'none';
                        selectedIndex = -1;
                        break;
                }
            };

            input.onblur = (e) => {
                // Delay hiding to allow clicks on dropdown items
                setTimeout(() => {
                    if (!dropdown.contains(document.activeElement)) {
                        dropdown.style.display = 'none';
                    }
                }, 200);
            };

            container.appendChild(input);
            container.appendChild(dropdown);
            container.appendChild(selectedContainer);

            updateSelected();
            return container;
        }
        // Create settings modal
        function createSettingsModal() {
            const modal = document.createElement('div');
            modal.id = 'streaming-settings-modal';
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

            const content = document.createElement('div');
            content.style.cssText = `
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
            `;

            content.innerHTML = `
                <h3 style="margin-top: 0; margin-bottom: 16px; color: #fff; font-size: 18px; font-weight: bolder;">${JE.t('elsewhere_settings_title')}</h3>

                <div style="margin-bottom: 16px;">
                    <label style="display: block; margin-bottom: 6px; font-weight: 600; color: #ccc;">${JE.t('elsewhere_settings_country')}</label>
                    <select id="region-select" style="width: 100%; padding: 12px; border: 1px solid #444; border-radius: 6px; background: #2a2a2a; color: #fff; font-size: 14px;">
                        ${Object.entries(availableRegions).map(([code, name]) =>
                            `<option value="${code}" ${code === userRegion ? 'selected' : ''}>${name}</option>`
                        ).join('')}
                    </select>
                </div>

                <div style="margin-bottom: 16px;">
                    <label style="display: block; margin-bottom: 5px; font-weight: 600; color: #ccc;">${JE.t('elsewhere_settings_other_countries')}</label>
                    <div id="regions-autocomplete"></div>
                </div>

               <div style="margin-bottom: 16px;">
                    <label style="display: block; margin-bottom: 6px; font-weight: 600; color: #ccc;">${JE.t('elsewhere_settings_providers')}</label>
                    <div id="services-autocomplete"></div>
                </div>

                <div style="display: flex; gap: 12px; justify-content: flex-end;">
                    <button id="cancel-settings" style="padding: 10px 18px; border: 1px solid #444; background: #2a2a2a; color: #fff; border-radius: 6px; cursor: pointer; font-size: 14px;">${JE.t('elsewhere_settings_cancel')}</button>
                    <button id="save-settings" style="padding: 10px 18px; border: none; background: #0078d4; color: white; border-radius: 6px; cursor: pointer; font-size: 14px;">${JE.t('elsewhere_settings_save')}</button>
                </div>
            `;

            modal.appendChild(content);
            document.body.appendChild(modal);

            // Add autocomplete for regions
            const regionsContainer = content.querySelector('#regions-autocomplete');
            const regionOptions = Object.entries(availableRegions).map(([code, name]) => `${name} (${code})`);
            const regionsAutocomplete = createAutocompleteInput(
                JE.t('elsewhere_settings_add_countries_placeholder'),
                regionOptions,
                userRegions.map(code => `${availableRegions[code] || code} (${code})`),
                (selected) => {}
            );
            regionsContainer.appendChild(regionsAutocomplete);

            // Add autocomplete for services
            const servicesContainer = content.querySelector('#services-autocomplete');
            const servicesAutocomplete = createAutocompleteInput(
                JE.t('elsewhere_settings_add_providers_placeholder'),
                availableProviders,
                userServices.slice(),
                (selected) => {}
            );
            servicesContainer.appendChild(servicesAutocomplete);

            document.getElementById('cancel-settings').onclick = () => {
                modal.style.display = 'none';
            };

            document.getElementById('save-settings').onclick = () => {
                userRegion = document.getElementById('region-select').value;

                // Get selected regions from autocomplete
                const selectedRegions = [];
                regionsContainer.querySelectorAll('.selected-tag').forEach(tag => {
                    const text = tag.textContent.replace('×', '').trim();
                    const match = text.match(/\(([A-Z]{2})\)$/);
                    if (match) {
                        selectedRegions.push(match[1]);
                    }
                });
                userRegions = selectedRegions;

                // Get selected services from autocomplete
                const selectedServices = [];
                servicesContainer.querySelectorAll('.selected-tag').forEach(tag => {
                    selectedServices.push(tag.textContent.replace('×', '').trim());
                });
                userServices = selectedServices;

                modal.style.display = 'none';
                localStorage.setItem('streaming-settings', JSON.stringify({
                    region: userRegion,
                    regions: userRegions,
                    services: userServices
                }));
            };

            // Close on backdrop click
            modal.onclick = (e) => {
                if (e.target === modal) {
                    modal.style.display = 'none';
                }
            };
        }

        // Load saved settings
        function loadSettings() {
            const saved = localStorage.getItem('streaming-settings');
            if (saved) {
                try {
                    const settings = JSON.parse(saved);
                    userRegion = settings.region || DEFAULT_REGION;
                    userRegions = settings.regions || [];
                    userServices = settings.services || [];
                } catch (e) {
                    console.log('🪼 Jellyfin Enhanced: 🎬 Jellyfin Elsewhere: Error loading settings:', e);
                }
            }
        }

        function createServiceBadge(service, tmdbId, mediaType) {
            const badge = document.createElement('div');
            badge.style.cssText = `
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
            `;

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

            logo.onerror = () => logo.style.display = 'none';
            badge.appendChild(logo);

            const text = document.createElement('span');
            text.textContent = service.provider_name;
            badge.appendChild(text);

            // Hover effects
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

        // Fetch streaming data
        function fetchStreamingData(tmdbId, mediaType, callback) {
            const url = `${ApiClient.getUrl(`/JellyfinEnhanced/tmdb/${mediaType}/${tmdbId}/watch/providers`)}?`;
            fetch(url, {
                headers: {
                    "X-Emby-Token": ApiClient.accessToken()
                }
            })
                .then(response => {
                    if (response.ok) {
                        return response.json();
                    } else {
                        throw new Error(`API Error: ${response.status}`);
                    }
                })
                .then(data => callback(null, data))
                .catch(error => {
                    let errorMessage;
                    const errorMessageText = error.message || '';

                    // Check 1: Network error (browser couldn't connect)
                    if (error instanceof TypeError && errorMessageText === 'Failed to fetch') {
                        errorMessage = 'TMDB API is unreachable.';

                    // Check 2: Invalid API Key error
                    } else if (errorMessageText.includes('401')) {
                        errorMessage = 'Invalid TMDB API Key.';

                    // Check 3: Item not found
                    } else if (errorMessageText.includes('404')) {
                        errorMessage = 'The requested item could not be found on TMDB.';

                    // Check 4: Rate limit error
                    } else if (errorMessageText.includes('429')) {
                        errorMessage = 'Too many requests. Please wait a moment and try again.';

                    // Check 5: TMDB server-side issues (e.g., 500, 502, 503, 504)
                    } else if (errorMessageText.startsWith('API Error: 5')) {
                        errorMessage = 'The TMDB service is temporarily unavailable. Please try again later.';

                    // Fallback: All other errors
                    } else {
                        errorMessage = errorMessageText || 'An unknown error occurred';
                    }

                    callback(errorMessage);
                });
        }

        // Process streaming data for default region (auto-load)
        function processDefaultRegionData(data, tmdbId, mediaType) {
            const regionData = data.results[DEFAULT_REGION];

            const container = document.createElement('div');
            container.style.cssText = `
                margin: 10px 0;
                padding: 12px;
                background: rgba(0, 0, 0, 0.2);
                border-radius: 8px;
                border: 1px solid rgba(255, 255, 255, 0.1);
                backdrop-filter: blur(10px);
                position: relative;
            `;

            // Create header with title and controls
            const header = document.createElement('div');
            header.style.cssText = `
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 10px;
            `;

            // Create clickable title that links to JustWatch
            const title = document.createElement('a');

            // Check if services are available in default region
            const hasServices = regionData && regionData.flatrate && regionData.flatrate.length > 0;

            if (hasServices) {
                title.textContent = JE.t('elsewhere_panel_available_in', { region: availableRegions[DEFAULT_REGION] || DEFAULT_REGION });
            } else {
                title.textContent = JE.t('elsewhere_panel_not_available_in', { region: availableRegions[DEFAULT_REGION] || DEFAULT_REGION });
            }

            title.style.cssText = `
                font-weight: 600;
                font-size: 14px;
                text-decoration: none;
                cursor: pointer;
                color: #fff;
                flex: 1;
            `;

            // Add JustWatch link if available
            if (regionData && regionData.link) {
                title.setAttribute('is', 'emby-linkbutton');
                title.classList.add('elsewhere-link-reset');
                title.href = regionData.link;
                title.target = '_blank';
                title.rel = 'noopener noreferrer';
                title.title = 'JustWatch';
                title.style.padding = '0';
                title.style.margin = '0';
            }

             // Create controls container
            const controls = document.createElement('div');
            controls.style.cssText = `
                display: flex;
                gap: 8px;
                align-items: center;
            `;

            // Search button with Material Icon
            const searchButton = document.createElement('button');
            const searchIcon = createMaterialIcon('search', '16px');
            searchButton.appendChild(searchIcon);
            searchButton.appendChild(document.createTextNode(''));

            searchButton.style.cssText = `
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
            `;

            searchButton.onmouseenter = () => {
                searchButton.style.background = 'rgba(255, 255, 255, 0.2)';
            };

            searchButton.onmouseleave = () => {
                searchButton.style.background = 'rgba(255, 255, 255, 0.1)';
            };

            // Settings button with Material Icon
            const settingsButton = document.createElement('button');
            const settingsIcon = createMaterialIcon('settings', '16px');
            settingsButton.appendChild(settingsIcon);

            settingsButton.title = 'Settings';
            settingsButton.style.cssText = `
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

            settingsButton.onmouseenter = () => {
                settingsButton.style.background = 'rgba(255, 255, 255, 0.2)';
            };

            settingsButton.onmouseleave = () => {
                settingsButton.style.background = 'rgba(255, 255, 255, 0.1)';
            };

            settingsButton.onclick = () => {
                const modal = document.getElementById('streaming-settings-modal');
                if (modal) {
                    modal.style.display = 'flex';
                }
            };

            controls.appendChild(searchButton);
            controls.appendChild(settingsButton);
            header.appendChild(title);
            header.appendChild(controls);
            container.appendChild(header);

            // Only show services if they exist
            if (hasServices) {
                // Filter services based on DEFAULT_PROVIDERS
                let services = regionData.flatrate;
                if (DEFAULT_PROVIDERS.length > 0) {
                    services = services.filter(service =>
                        DEFAULT_PROVIDERS.includes(service.provider_name)
                    );
                }

                // Apply ignore list using regular expressions
                if (IGNORE_PROVIDERS.length > 0) {
                    try {
                        // 'i' for case-insensitive
                        const ignorePatterns = IGNORE_PROVIDERS.map(pattern => new RegExp(pattern, 'i'));
                        services = services.filter(service =>
                            !ignorePatterns.some(regex => regex.test(service.provider_name))
                        );
                    } catch (e) {
                        console.error('🪼 Jellyfin Enhanced: 🎬 Jellyfin Elsewhere: Invalid regex in IGNORE_PROVIDERS.', e);
                    }
                }

                if (services.length === 0) {
                    const noServices = document.createElement('div');
                    noServices.textContent = DEFAULT_PROVIDERS.length > 0
                        ? 'No configured services available'
                        : 'Not available on any streaming services';
                    noServices.style.cssText = 'color: #999; font-size: 13px; margin-bottom: 12px;';
                    container.appendChild(noServices);
                } else {
                    const servicesContainer = document.createElement('div');
                    servicesContainer.style.cssText = 'display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 12px;';

                    services.forEach(service => {
                        servicesContainer.appendChild(createServiceBadge(service, tmdbId, mediaType));
                    });

                    container.appendChild(servicesContainer);
                }
            }

            // Create manual result container for search results
            const resultContainer = document.createElement('div');
            resultContainer.id = 'streaming-result-container';
            container.appendChild(resultContainer);

            // Add click handler for manual lookup (multiple regions)
            searchButton.onclick = () => {
                searchButton.disabled = true;
                searchButton.innerHTML = '';
                const loadingIcon = createMaterialIcon('refresh', '16px');
                loadingIcon.style.animation = 'spin 1s linear infinite';
                searchButton.appendChild(loadingIcon);
                searchButton.appendChild(document.createTextNode(' Searching...'));
                searchButton.style.opacity = '0.7';
                resultContainer.innerHTML = '';

                // Add spinning animation
                const style = document.createElement('style');
                style.textContent = `
                    @keyframes spin {
                        0% { transform: rotate(0deg); }
                        100% { transform: rotate(360deg); }
                    }
                `;
                if (!document.querySelector('style[data-jellyfin-elsewhere]')) {
                    style.setAttribute('data-jellyfin-elsewhere', 'true');
                    document.head.appendChild(style);
                }

                fetchStreamingData(tmdbId, mediaType, (error, data) => {
                    searchButton.disabled = false;
                    searchButton.innerHTML = '';
                    const searchIcon = createMaterialIcon('search', '16px');
                    searchButton.appendChild(searchIcon);
                    searchButton.appendChild(document.createTextNode(''));
                    searchButton.style.opacity = '1';

                    if (error) {
                        resultContainer.innerHTML = `<div style="color: #ff6b6b; font-size: 13px; margin-top: 8px;">Error: ${error}</div>`;
                        return;
                    }

                    // Show results for multiple regions
                    const regionsToSearch = userRegions.length > 0 ? userRegions : [userRegion];

                    let hasAnyResults = false;
                    const unavailableRegions = [];

                    regionsToSearch.forEach((region, index) => {
                        const regionData = data.results[region];
                        const hasServices = regionData && regionData.flatrate && regionData.flatrate.length > 0;

                        if (hasServices) {
                            // Filter services based on user preferences
                            let services = regionData.flatrate;
                            if (userServices.length > 0) {
                                services = services.filter(service =>
                                    userServices.includes(service.provider_name)
                                );
                            }

                            if (services.length > 0) {
                                hasAnyResults = true;
                                const regionResult = processRegionData(data, tmdbId, mediaType, region, true);
                                if (regionResult) {
                                    if (index > 0 || unavailableRegions.length > 0) {
                                        regionResult.style.marginTop = '6px';
                                    }
                                    resultContainer.appendChild(regionResult);
                                }
                            } else {
                                unavailableRegions.push(region);
                            }
                        } else {
                            unavailableRegions.push(region);
                        }
                    });

                    // Show unavailable regions first if there are any
                    if (unavailableRegions.length > 0) {
                        const unavailableContainer = createUnavailableRegionsDisplay(unavailableRegions);
                        resultContainer.insertBefore(unavailableContainer, resultContainer.firstChild);
                    }

                    // If no results found anywhere, show a general message
                    if (!hasAnyResults && unavailableRegions.length === 0) {
                        const noServices = document.createElement('div');
                        noServices.style.cssText = 'color: #6c757d; font-size: 13px; margin-top: 8px;';
                        noServices.textContent = `No streaming services available in selected regions`;
                        resultContainer.appendChild(noServices);
                    }
                });
            };

            return container;
        }

        // Create display for unavailable regions
        function createUnavailableRegionsDisplay(unavailableRegions) {
            const container = document.createElement('div');
            container.style.cssText = `
                margin: 0 0 6px 0;
                padding: 12px;
                border-radius: 8px;
                border: 1px solid rgba(139, 19, 19, 0.6);
                background: rgba(139, 19, 19, 0.3);
                backdrop-filter: blur(10px);
                position: relative;
            `;

            // Create header with title and close button
            const header = document.createElement('div');
            header.style.cssText = `
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 0;
            `;

            const title = document.createElement('div');
            const regionNames = unavailableRegions.map(region => availableRegions[region] || region);
            const regionText = regionNames.length === 1 ? regionNames[0] :
                              regionNames.length === 2 ? regionNames.join(' and ') :
                              regionNames.slice(0, -1).join(', ') + ' and ' + regionNames[regionNames.length - 1];

            title.textContent = `Not available on any streaming services in ${regionText}`;
            title.style.cssText = `
                font-weight: 600;
                font-size: 14px;
                color: rgb(255, 20, 20);
                flex: 1;
            `;

            // Create close button
            const closeButton = document.createElement('button');
            const closeIcon = createMaterialIcon('close', '16px');
            closeButton.appendChild(closeIcon);
            closeButton.title = 'Close';
            closeButton.style.cssText = `
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

            closeButton.onmouseenter = () => {
                closeButton.style.background = 'rgba(255, 0, 0, 0.2)';
                closeButton.style.borderColor = 'rgba(255, 0, 0, 0.3)';
            };

            closeButton.onmouseleave = () => {
                closeButton.style.background = 'rgba(255, 255, 255, 0.1)';
                closeButton.style.borderColor = 'rgba(255, 255, 255, 0.2)';
            };

            closeButton.onclick = () => {
                container.remove();
            };

            header.appendChild(title);
            header.appendChild(closeButton);
            container.appendChild(header);

            return container;
        }

        // Process streaming data for a specific region
        function processRegionData(data, tmdbId, mediaType, region, showAvailable = false) {
            const regionData = data.results[region];
            if (!regionData || !regionData.flatrate) {
                return null;
            }

            // Filter services based on user preferences
            const services = regionData.flatrate.filter(service =>
                userServices.length === 0 || userServices.includes(service.provider_name)
            );

            // Don't show container if no services match filters
            if (services.length === 0) {
                return null;
            }

            const container = document.createElement('div');
            container.style.cssText = `
                margin: 10px 0 0 0;
                padding: 12px;
                background: rgba(0, 0, 0, 0.3);
                border-radius: 8px;
                border: 1px solid rgba(255, 255, 255, 0.1);
                backdrop-filter: blur(10px);
                position: relative;
            `;

            // Create header with title and close button
            const header = document.createElement('div');
            header.style.cssText = `
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 10px;
            `;

            // Create clickable title that links to JustWatch
            const title = document.createElement('a');
            title.textContent = JE.t('elsewhere_panel_available_in_region', { region: availableRegions[region] || region });
            title.style.cssText = `
                font-weight: 600;
                font-size: 14px;
                text-decoration: none;
                cursor: pointer;
                color: #fff;
                flex: 1;
            `;

            // Add JustWatch link if available and enabled
            if (regionData.link) {
                title.setAttribute('is', 'emby-linkbutton');
                title.classList.add('elsewhere-link-reset');
                title.href = regionData.link;
                title.target = '_blank';
                title.rel = 'noopener noreferrer';
                title.title = 'JustWatch';
                title.style.padding = '0';
                title.style.margin = '0';
            }

            // Create close button
            const closeButton = document.createElement('button');
            const closeIcon = createMaterialIcon('close', '16px');
            closeButton.appendChild(closeIcon);
            closeButton.title = JE.t('elsewhere_panel_close_tooltip');
            closeButton.style.cssText = `
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

            closeButton.onmouseenter = () => {
                closeButton.style.background = 'rgba(255, 0, 0, 0.2)';
                closeButton.style.borderColor = 'rgba(255, 0, 0, 0.3)';
            };

            closeButton.onmouseleave = () => {
                closeButton.style.background = 'rgba(255, 255, 255, 0.1)';
                closeButton.style.borderColor = 'rgba(255, 255, 255, 0.2)';
            };

            closeButton.onclick = () => {
                container.remove();
            };

            header.appendChild(title);
            header.appendChild(closeButton);
            container.appendChild(header);

            const servicesContainer = document.createElement('div');
            servicesContainer.style.cssText = 'display: flex; flex-wrap: wrap; gap: 3px;';

            services.forEach(service => {
                servicesContainer.appendChild(createServiceBadge(service, tmdbId, mediaType));
            });

            container.appendChild(servicesContainer);

            return container;
        }

        // Auto-load streaming data on page load (default region only)
        function autoLoadStreamingData(tmdbId, mediaType, container) {
            fetchStreamingData(tmdbId, mediaType, (error, data) => {
                if (error) {
                    const errorDiv = document.createElement('div');
                    errorDiv.style.cssText = 'font-size: 13px; margin-top: 8px; color: #ff6b6b;';
                    errorDiv.textContent = `Error: ${error}`;
                    container.appendChild(errorDiv);
                    return;
                }

                // Show default region results automatically
                const defaultResult = processDefaultRegionData(data, tmdbId, mediaType);
                if (defaultResult) {
                    container.appendChild(defaultResult);
                }
            });
        }

        // Add buttons to detail pages
        function addStreamingLookup() {
            const detailSections = document.querySelectorAll('.detailSectionContent');

            detailSections.forEach(section => {
                // Skip if already processed
                if (section.querySelector('.streaming-lookup-container')) return;

                // Look for TMDB link to get ID and media type
                const tmdbLinks = section.querySelectorAll('a[href*="themoviedb.org"]');
                if (tmdbLinks.length === 0) return;

                const tmdbLink = tmdbLinks[0];
                const match = tmdbLink.href.match(/themoviedb\.org\/(movie|tv)\/(\d+)/);
                if (!match) return;

                const mediaType = match[1];
                const tmdbId = match[2];

                // Create container
                const container = document.createElement('div');
                container.className = 'streaming-lookup-container';
                container.style.cssText = 'margin: 16px 0;';

                // Auto-load streaming data for default region
                autoLoadStreamingData(tmdbId, mediaType, container);

                // Insert after external links or at the end
                const externalLinks = section.querySelector('.itemExternalLinks');
                if (externalLinks) {
                    externalLinks.parentNode.insertBefore(container, externalLinks.nextSibling);
                } else {
                    section.appendChild(container);
                }
            });
        }
        // --- Initialization ---
        loadRegionsAndProviders();
        loadSettings();
        setTimeout(createSettingsModal, 2000);
        setInterval(addStreamingLookup, 2000);
        setTimeout(addStreamingLookup, 1000);

        console.log('🪼 Jellyfin Enhanced: 🎬 Jellyfin Elsewhere loaded!');
    };

})(window.JellyfinEnhanced);
