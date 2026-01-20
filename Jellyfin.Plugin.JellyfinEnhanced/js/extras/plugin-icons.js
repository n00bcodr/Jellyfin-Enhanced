// /js/extras/plugin-icons.js
// Replaces default plugin icons with custom icons on the dashboard

(function () {
    'use strict';

    function injectCSS() {
        const styleId = 'plugin-icons-material';
        if (document.getElementById(styleId)) return;

        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
        .material-icons {
          font-family: 'Material Icons';
          font-size: 24px;
          line-height: 1;
          display: inline-block;
          -webkit-font-smoothing: antialiased;
        }
        .plugin-material-icon {
          display: inline-flex !important;
          align-items: center !important;
          justify-content: center !important;
        }
      `;
        document.head.appendChild(style);
    }

    let isProcessing = false;
    let observer = null;
    let customPluginsCache = null;
    let lastProcessedPluginsCount = 0;

    // Get custom plugins from server configuration
    async function getCustomPlugins() {
        // Check for test data first (used by configuration page test button)
        if (window.testCustomPluginLinks) {
            const testData = window.testCustomPluginLinks.map((plugin, index) => ({
                name: plugin.name,
                icon: plugin.icon,
                iconType: 'material',
                id: `test-${index}`
            }));
            return testData;
        }

        // Return cached data if available
        if (customPluginsCache) {
            return customPluginsCache;
        }

        try {
            // Wait for ApiClient to be available
            if (typeof ApiClient === 'undefined') {
                return [];
            }

            // Use the same API pattern as the configuration page
            const pluginId = 'f69e946a-4b3c-4e9a-8f0a-8d7c1b2c4d9b';
            const config = await ApiClient.getPluginConfiguration(pluginId);
            const customLinksText = config.CustomPluginLinks || '';
            customPluginsCache = parseCustomPluginLinks(customLinksText);
            return customPluginsCache;
        } catch (e) {
            console.warn('Failed to load custom plugins from server:', e);
        }
        return [];
    }

    // Parse custom plugin links text into plugin objects
    function parseCustomPluginLinks(text) {
        if (!text || !text.trim()) return [];

        const plugins = [];
        const lines = text.split('\n');

        lines.forEach((line, index) => {
            const trimmedLine = line.trim();
            if (!trimmedLine) return;

            const parts = trimmedLine.split('|').map(part => part.trim());
            if (parts.length >= 2) {
                plugins.push({
                    name: parts[0],
                    icon: parts[1],
                    iconType: 'material',
                    id: `custom-${index}`
                });
            }
        });

        return plugins;
    }

    function createCustomPluginLink(plugin) {
        const pluginsSection = document.querySelector('ul[aria-labelledby="plugins-subheader"]');
        if (!pluginsSection) return;

        // Check if link already exists using data attribute (similar to KefinTweaks approach)
        const existingLink = pluginsSection.querySelector(`[data-jellyfin-enhanced-plugin-id="${plugin.id}"]`);
        if (existingLink) return;

        // Get current base URL
        const baseUrl = window.location.origin + window.location.pathname;
        const pluginUrl = `${baseUrl}#/configurationpage?name=${encodeURIComponent(plugin.name)}`;

        // Create the link element
        const link = document.createElement('a');
        link.className = 'MuiButtonBase-root MuiListItemButton-root MuiListItemButton-gutters MuiListItemButton-root MuiListItemButton-gutters css-yknuxp';
        link.tabIndex = 0;
        link.href = pluginUrl;
        // Use data attribute similar to KefinTweaks pattern
        link.setAttribute('data-jellyfin-enhanced-plugin-id', plugin.id);

        // Create icon container
        const iconDiv = document.createElement('div');
        iconDiv.className = 'MuiListItemIcon-root css-5pks8q';

        // Create material icon
        const iconElement = document.createElement('span');
        iconElement.className = 'material-icons plugin-material-icon';
        iconElement.textContent = plugin.icon;
        iconElement.setAttribute('aria-hidden', 'true');

        iconDiv.appendChild(iconElement);

        // Create text container
        const textDiv = document.createElement('div');
        textDiv.className = 'MuiListItemText-root css-t3p1a1';

        const textSpan = document.createElement('span');
        textSpan.className = 'MuiTypography-root MuiTypography-body1 MuiListItemText-primary css-pl8nxc';
        textSpan.textContent = plugin.name;

        textDiv.appendChild(textSpan);

        // Assemble the link
        link.appendChild(iconDiv);
        link.appendChild(textDiv);

        // Insert the link (append to end of plugins section)
        pluginsSection.appendChild(link);
    }

    function replacePluginIcon(selector, iconConfig) {
        const link = document.querySelector(selector);
        if (!link) return false;

        const iconDiv = link.querySelector('.MuiListItemIcon-root');
        if (!iconDiv) return false;

        const oldSvg = iconDiv.querySelector('svg');
        if (!oldSvg || oldSvg.dataset.testid !== 'FolderIcon') return false;

        let iconElement;
        if (iconConfig.type === 'image') {
            iconElement = document.createElement('img');
            iconElement.src = iconConfig.src;
            iconElement.style.width = '24px';
            iconElement.style.height = '24px';
            iconElement.alt = iconConfig.alt;
        } else if (iconConfig.type === 'material') {
            iconElement = document.createElement('span');
            iconElement.className = 'material-icons plugin-material-icon';
            iconElement.textContent = iconConfig.icon;
            iconElement.setAttribute('aria-hidden', 'true');
        }

        if (iconElement) {
            oldSvg.replaceWith(iconElement);
            return true;
        }
        return false;
    }

    async function processPluginIcons() {
        if (isProcessing) return;
        isProcessing = true;

        try {
            // Find the plugins section regardless of page
            const pluginsSection = document.querySelector('ul[aria-labelledby="plugins-subheader"]');
            if (!pluginsSection) {
                return;
            }

            // Count current plugins to detect changes
            const currentPluginsCount = pluginsSection.querySelectorAll('a[href*="configurationpage"]').length;

            // Only clean up test links to avoid flickering
            const existingTestLinks = pluginsSection.querySelectorAll('[data-jellyfin-enhanced-plugin-id^="test-"]');
            existingTestLinks.forEach(link => link.remove());

            // Replace built-in plugin icons
            const iconConfigs = [
                {
                    selector: 'a[href*="Jellyfin%20Enhanced"]',
                    type: 'image',
                    src: 'http://cdn.jsdelivr.net/gh/n00bcodr/jellyfish/logos/favicon.ico',
                    alt: 'Jellyfin Enhanced'
                },
                {
                    selector: 'a[href*="JavaScript%20Injector"]',
                    type: 'image',
                    src: 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/javascript.svg',
                    alt: 'JavaScript'
                },
                {
                    selector: 'a[href*="Intro%20Skipper"]',
                    type: 'material',
                    icon: 'redo'
                },
                {
                    selector: 'a[href*="reports"]',
                    type: 'material',
                    icon: 'insert_chart_outlined'
                },
                {
                    selector: 'a[href*="Jellysleep"]',
                    type: 'material',
                    icon: 'dark_mode'
                },
                {
                    selector: 'a[href*="Home%20Screen%20Sections"]',
                    type: 'material',
                    icon: 'dashboard_customize'
                },
                {
                    selector: 'a[href*="File%20Transformation"]',
                    type: 'material',
                    icon: 'file_open'
                }
            ];

            iconConfigs.forEach(config => {
                replacePluginIcon(config.selector, config);
            });

            // Add custom user-defined plugins
            const customPlugins = await getCustomPlugins();
            customPlugins.forEach(plugin => {
                createCustomPluginLink(plugin);
            });

            lastProcessedPluginsCount = currentPluginsCount;
        } finally {
            isProcessing = false;
        }
    }

    let debounceTimer = null;

    // Monitor for changes similar to KefinTweaks approach
    function startMonitoring() {
        if (observer) return;

        observer = new MutationObserver((mutations) => {
            let shouldProcess = false;

            mutations.forEach((mutation) => {
                // Check if plugins section was modified
                if (mutation.type === 'childList') {
                    const target = mutation.target;

                    // Check if we're in the plugins section or its parent
                    if (target.matches && (
                        target.matches('ul[aria-labelledby="plugins-subheader"]') ||
                        target.querySelector('ul[aria-labelledby="plugins-subheader"]') ||
                        target.closest('ul[aria-labelledby="plugins-subheader"]')
                    )) {
                        shouldProcess = true;
                    }

                    // Check for dashboard/settings page container changes
                    if (target === document.body || (target.classList && (
                        target.classList.contains('dashboardDocument') ||
                        target.classList.contains('settingsDocument') ||
                        target.classList.contains('dashboardPage')
                    ))) {
                        shouldProcess = true;
                    }
                }
            });

            if (shouldProcess) {
                // Debounce the processing
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(processPluginIcons, 100);
            }
        });

        // Start observing
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    function stopMonitoring() {
        if (observer) {
            observer.disconnect();
            observer = null;
        }
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
    }

    // Handle page navigation
    function setupHashChangeListener() {
        window.addEventListener('hashchange', () => {
            const hash = window.location.hash;
            // Process plugin icons when navigating to dashboard, settings, or configuration pages
            if (hash.includes('#/dashboard') || hash.includes('#/settings') || hash.includes('#/configurationpage')) {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(processPluginIcons, 300);
            }
        });
    }

    async function initialize() {
        // Inject CSS for Material Icons
        injectCSS();
        setupHashChangeListener();

        // Wait for ApiClient to be available
        let retries = 0;
        const maxRetries = 10;

        const tryInitialize = async () => {
            if (typeof ApiClient !== 'undefined') {
                await processPluginIcons();
                startMonitoring();
            } else if (retries < maxRetries) {
                retries++;
                setTimeout(tryInitialize, 500);
            } else {
                console.warn('ApiClient not available after retries, custom plugin links will not work');
                // Still set up the basic icon replacement and monitoring
                await processPluginIcons();
                startMonitoring();
            }
        };

        tryInitialize();
    }

    if (window.JellyfinEnhanced) {
        window.JellyfinEnhanced.initializePluginIcons = initialize;
        window.JellyfinEnhanced.stopPluginIconsMonitoring = stopMonitoring;

        // Expose API for refreshing custom plugins
        window.JellyfinEnhanced.customPlugins = {
            refresh: () => {
                // Clear cache to force reload
                customPluginsCache = null;
                processPluginIcons();
            }
        };
    }

})();