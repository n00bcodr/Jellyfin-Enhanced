(function(JE) {
    'use strict';

    JE.themer = {
        supportedThemes: {
            // Jellyfish Theme
            jellyfish: {
                name: 'Jellyfish',
                uniqueIdentifier: '--theme-updated-on',
                variables: {
                    panelBg: '--primary-background-transparent',
                    panelBgFallback: 'rgba(0,0,0,0.95)',
                    secondaryBg: '--secondary-background-transparent',
                    secondaryBgFallback: 'rgba(0,0,0,0.2)',
                    primaryAccent: '--primary-accent-color',
                    primaryAccentFallback: '#00A4DC',
                    textColor: '--text-color',
                    textColorFallback: '#FFFFFF',
                    altAccent: '--alt-accent-color',
                    altAccentFallback: '#ffffff20',
                    blur: '--blur',
                    blurFallback: '20px',
                    logo: '--logo',
                    logoFallback: ''
                }
            },

            // ElegantFin Theme
            elegantfin: {
                name: 'ElegantFin',
                uniqueIdentifier: '--elegantFinFooterText',
                variables: {
                    panelBg: '--headerColor',
                    panelBgFallback: 'rgba(30, 40, 54, 0.9)',
                    secondaryBg: '--drawerColor',
                    secondaryBgFallback: 'rgba(30, 40, 54, 0.8)',
                    primaryAccent: '--activeColor',
                    primaryAccentFallback: 'rgb(119, 91, 244)',
                    textColor: '--textColor',
                    textColorFallback: '#FFFFFF',
                    altAccent: '--selectorBackgroundColor',
                    altAccentFallback: 'rgb(55, 65, 81)',
                    blur: '--blurDefault',
                    blurFallback: 'blur(5px)',
                    logo: null, // ElegantFin doesn't use a separate CSS variable for logo
                    logoFallback: ''
                }
            },

            // Zesty Theme
            zesty: {
                name: 'Zesty',
                uniqueIdentifier: '--honey-yellow',
                variables: {
                    panelBg: '--darkest',
                    panelBgFallback: 'rgba(24, 24, 24, 0.95)',
                    secondaryBg: '--dark',
                    secondaryBgFallback: 'rgba(32, 32, 32, 0.8)',
                    primaryAccent: '--accent',
                    primaryAccentFallback: 'rgb(78, 116, 247)',
                    textColor: '--white',
                    textColorFallback: '#F3F2F3',
                    altAccent: '--dark-highlight',
                    altAccentFallback: 'rgba(255,255,255,0.1)',
                    blur: '--rounding',
                    blurFallback: '12px',
                    logo: null, // Zesty doesn't use a separate CSS variable for logo
                    logoFallback: 'https://cdn.jsdelivr.net/gh/stpnwf/ZestyTheme@latest/images/logo/jellyfin-logo-light.png'
                }
            },

            // Default/fallback theme
            default: {
                name: 'Default',
                uniqueIdentifier: null, // No identifier - this is the fallback
                variables: {
                    panelBg: null,
                    panelBgFallback: 'linear-gradient(135deg, rgba(0,0,0,0.95), rgba(20,20,20,0.95))',
                    secondaryBg: null,
                    secondaryBgFallback: 'rgba(0,0,0,0.2)',
                    primaryAccent: null,
                    primaryAccentFallback: '#00A4DC',
                    textColor: null,
                    textColorFallback: '#FFFFFF',
                    altAccent: null,
                    altAccentFallback: 'rgba(255,255,255,0.1)',
                    blur: null,
                    blurFallback: '20px',
                    logo: null,
                    logoFallback: ''
                }
            }
        },

        activeTheme: null,

        /**
         * Detect the currently active theme
         * @returns {Object} The detected theme configuration
         */
        detectActiveTheme() {
            const rootStyle = getComputedStyle(document.documentElement);

            // Check each theme by its unique identifier
            for (const [themeKey, theme] of Object.entries(this.supportedThemes)) {
                // Skip if no identifier is found and fallback to default theme
                if (!theme.uniqueIdentifier) continue;

                const identifierValue = rootStyle.getPropertyValue(theme.uniqueIdentifier).trim();

                // If the unique identifier exists and is not empty use the variables from the theme
                if (identifierValue && identifierValue !== '' && identifierValue !== 'none') {
                    console.log(`🪼 Jellyfin Enhanced: Detected ${theme.name} theme`);
                    this.activeTheme = { key: themeKey, ...theme };
                    return this.activeTheme;
                }
            }

            // Default fallback
            console.log('🪼 Jellyfin Enhanced: Using default theme (no specific theme detected)');
            this.activeTheme = { key: 'default', ...this.supportedThemes.default };
            return this.activeTheme;
        },

        /**
         * Get a theme variable value with fallback
         * @param {string} variableKey - The key from the theme's variables object
         * @returns {string} The CSS value or fallback value
         */
        getThemeVariable(variableKey) {
            if (!this.activeTheme) {
                this.detectActiveTheme();
            }

            const theme = this.activeTheme;
            const cssVariable = theme.variables[variableKey];
            const fallbackValue = theme.variables[variableKey + 'Fallback'];

            if (!cssVariable) {
                return fallbackValue || '';
            }

            const rootStyle = getComputedStyle(document.documentElement);
            const value = rootStyle.getPropertyValue(cssVariable).trim();

            // Special handling for logo variable (URL extraction)
            if (variableKey === 'logo' && value) {
                return value.replace(/url\(['"]?(.*?)['"]?\)/i, '$1');
            }

            // Special handling for RGB values that need wrapping
            if (value && /^\d+,\s*\d+,\s*\d+$/.test(value)) {
                return `rgb(${value})`;
            }

            return value || fallbackValue || '';
        },

        /**
         * Get all theme variables for the current theme
         * @returns {Object} Object with all theme variable values
         */
        getThemeVariables() {
            if (!this.activeTheme) {
                this.detectActiveTheme();
            }

            const variables = {};
            const variableKeys = Object.keys(this.activeTheme.variables).filter(key => !key.endsWith('Fallback'));

            for (const key of variableKeys) {
                variables[key] = this.getThemeVariable(key);
            }

            return variables;
        },

        /**
         * Register a new theme (useful for adding themes dynamically)
         * @param {string} themeKey - Unique identifier for the theme
         * @param {Object} themeConfig - Theme configuration object with uniqueIdentifier and variables
         */
        registerTheme(themeKey, themeConfig) {
            this.supportedThemes[themeKey] = themeConfig;
            console.log(`🪼 Jellyfin Enhanced: Registered theme - ${themeConfig.name} (identifier: ${themeConfig.uniqueIdentifier})`);
        },

        // /**
        //  * Re-detect theme (useful for manual theme switches)
        //  */
        // redetectTheme() {
        //     this.activeTheme = null;
        //     return this.detectActiveTheme();
        // },

        /**
         * Initialize theme detection (runs once on page load)
         */
        init() {
            this.detectActiveTheme();
        }
    };

})(window.JellyfinEnhanced);