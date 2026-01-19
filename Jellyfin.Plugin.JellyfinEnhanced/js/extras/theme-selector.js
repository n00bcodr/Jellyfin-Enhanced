// /js/extras/theme-selector.js
// Theme selector for Jellyfish theme color variants

(function() {
    'use strict';

    const THEMES = Object.freeze({
        'Default': '',
        'Aurora': 'aurora.css',
        'Banana': 'banana.css',
        'Coal': 'coal.css',
        'Coral': 'coral.css',
        'Forest': 'forest.css',
        'Grass': 'grass.css',
        'Jellyblue': 'jellyblue.css',
        'Jellyflix': 'jellyflix.css',
        'Jellypurple': 'jellypurple.css',
        'Lavender': 'lavender.css',
        'Midnight': 'midnight.css',
        'Mint': 'mint.css',
        'Ocean': 'ocean.css',
        'Peach': 'peach.css',
        'Watermelon': 'watermelon.css'
    });

    const THEME_BASE_URL = 'https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfish/colors/';
    const RANDOM_THEME_DEFAULT = false;
    const CSS_STYLE_ID = 'jellyfin-theme-selector-css';
    const SELECTOR_ID = 'jellyfin-theme-selector';
    const INIT_DELAY = 250;
    const NOTIFICATION_DELAY = 1000;
    const DEBOUNCE_DELAY = 100;
    const TRANSITION_DURATION = 300;

    const getThemeImport = (filename) => filename ? `@import url("${THEME_BASE_URL}${filename}");` : '';

    const getStorageKey = (userId, key) => `${userId}-${key}`;

    const getLocalStorageValue = (userId, key, defaultValue = null) => {
        try {
            const value = localStorage.getItem(getStorageKey(userId, key));
            return value === null ? defaultValue : value;
        } catch (e) {
            console.error('🪼 Jellyfin Enhanced: Theme selector storage read error', e);
            return defaultValue;
        }
    };

    const setLocalStorageValue = (userId, key, value) => {
        try {
            localStorage.setItem(getStorageKey(userId, key), value);
            return true;
        } catch (e) {
            console.error('🪼 Jellyfin Enhanced: Theme selector storage write error', e);
            return false;
        }
    };

    const removeLocalStorageValue = (userId, key) => {
        try {
            localStorage.removeItem(getStorageKey(userId, key));
            return true;
        } catch (e) {
            console.error('[🪼🎨Jellyfish Theme Selector] localStorage remove error:', e);
            return false;
        }
    };

    // --- Random Theme Functions ---
    const isRandomThemeEnabled = (userId) => {
        const setting = getLocalStorageValue(userId, 'randomThemeEnabled');
        return setting === null ? RANDOM_THEME_DEFAULT : setting === 'true';
    };

    const setRandomThemeEnabled = (userId, isEnabled) => {
        setLocalStorageValue(userId, 'randomThemeEnabled', isEnabled);
    };

    const getLastRandomDate = (userId) => getLocalStorageValue(userId, 'lastRandomThemeDate');

    const setLastRandomDate = (userId, date) => {
        setLocalStorageValue(userId, 'lastRandomThemeDate', date);
    };

    const getTodayDate = () => new Date().toISOString().split('T')[0];

    // --- CSS Injection ---
    const injectCustomCss = () => {
        if (document.getElementById(CSS_STYLE_ID)) return;

        const style = document.createElement('style');
        style.id = CSS_STYLE_ID;
        style.textContent = `
            #theme-selector-body {
                display: flex !important;
                align-items: center;
                justify-content: flex-start;
                flex-direction: row;
                flex-wrap: wrap;
                gap: 1em;
                padding: .4em .75em;
            }
            #theme-selector-select {
                max-width: 200px !important;
                min-width: 150px !important;
                transition: opacity ${TRANSITION_DURATION}ms ease;
            }
            #theme-selector-select:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
            #random-theme-button {
                padding: 0.5em 0.5em !important;
                height: auto !important;
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: 0.3em;
                background-color: transparent;
                border-radius: 10px;
                transition: background-color 0.3s ease, opacity ${TRANSITION_DURATION}ms ease;
            }
            #random-theme-button:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
            #random-theme-button.active {
                background-color: #4CAF50;
                color: white;
            }
            .theme-applying {
                opacity: 0;
                transition: opacity ${TRANSITION_DURATION}ms ease;
            }
            .theme-applied {
                opacity: 1;
                transition: opacity ${TRANSITION_DURATION}ms ease;
            }
        `;
        document.head.appendChild(style);
        console.log('[🪼🎨Jellyfish Theme Selector] Custom CSS injected');
    };



    // --- User ID Extraction ---
    const extractUserId = () => {
        try {
            const userId = window.ApiClient?.getCurrentUserId?.();
            if (userId && userId.trim() !== '') return userId;
        } catch (e) {
            console.error('[🪼🎨Jellyfish Theme Selector] Error extracting user ID:', e);
        }
        console.error('[🪼🎨Jellyfish Theme Selector] Could not extract user ID');
        return null;
    };

    // --- Theme Management ---
    const getCurrentTheme = (userId) => getLocalStorageValue(userId, 'customCss', '');

    const setTheme = (userId, themeFilename, themeName = 'Default') => {
        const themeValue = getThemeImport(themeFilename);
        if (themeValue) {
            setLocalStorageValue(userId, 'customCss', themeValue);
            console.log(`[🪼🎨Jellyfish Theme Selector] Theme set to: ${themeName}`);
        } else {
            removeLocalStorageValue(userId, 'customCss');
            console.log('[🪼🎨Jellyfish Theme Selector] Theme cleared (default)');
        }
    };

    // --- Notifications ---
    const showNotification = (message) => {
        try {
            if (window.Dashboard?.alert) {
                window.Dashboard.alert(message);
            } else if (window.require) {
                window.require(['toast'], (toast) => toast(message));
            } else {
                console.log(`[🪼🎨Jellyfish Theme Selector] Notification: ${message}`);
            }
        } catch (e) {
            console.error('[🪼🎨Jellyfish Theme Selector] Failed to show notification:', e);
        }
    };

    const checkPostRefreshNotification = () => {
        try {
            const pendingNotification = sessionStorage.getItem('jellyfin-theme-applied');
            if (pendingNotification) {
                sessionStorage.removeItem('jellyfin-theme-applied');
                setTimeout(() => showNotification(`Theme applied: ${pendingNotification}`), NOTIFICATION_DELAY);
            }
        } catch (e) {
            console.error('[🪼🎨Jellyfish Theme Selector] Session storage error:', e);
        }
    };

    // --- Random Theme Logic ---
    const applyRandomThemeIfNeeded = () => {
        const userId = extractUserId();
        if (!userId || !isRandomThemeEnabled(userId)) return;

        const today = getTodayDate();
        const lastDate = getLastRandomDate(userId);

        if (today !== lastDate) {
            console.log('[🪼🎨Jellyfish Theme Selector] New day detected! Applying a random theme.');
            const availableThemes = Object.keys(THEMES).filter(name => name !== 'Default');
            const randomThemeName = availableThemes[Math.floor(Math.random() * availableThemes.length)];
            const randomThemeFilename = THEMES[randomThemeName];

            setTheme(userId, randomThemeFilename, randomThemeName);
            setLastRandomDate(userId, today);

            try {
                sessionStorage.setItem('jellyfin-theme-applied', `Random Daily (${randomThemeName})`);
            } catch (e) {
                console.error('[🪼🎨Jellyfish Theme Selector] Could not set session storage:', e);
            }
            window.location.reload();
        } else {
            console.log('[🪼🎨Jellyfish Theme Selector] Random theme already applied for today.');
        }
    };

    // --- UI Creation ---
    const createIcon = (iconName, className = 'material-icons') => {
        const icon = document.createElement('span');
        icon.className = className;
        icon.textContent = iconName;
        icon.setAttribute('aria-hidden', 'true');
        return icon;
    };

    const createThemeSelect = (userId, currentThemeValue) => {
        const select = document.createElement('select');
        select.setAttribute('is', 'emby-select');
        select.className = 'emby-select-withcolor emby-select';
        select.id = 'theme-selector-select';
        select.setAttribute('aria-label', 'Select theme');
        select.removeAttribute('label');

        let selectedThemeName = 'Default';
        for (const [name, filename] of Object.entries(THEMES)) {
            const themeValue = getThemeImport(filename);
            if (themeValue === currentThemeValue) {
                selectedThemeName = name;
                break;
            }
        }

        Object.keys(THEMES).forEach(themeName => {
            const option = document.createElement('option');
            option.value = themeName;
            option.textContent = themeName;
            if (themeName === selectedThemeName) option.selected = true;
            select.appendChild(option);
        });

        select.addEventListener('change', (e) => {
            e.preventDefault();
            e.stopPropagation();

            const newThemeName = e.target.value;
            const newThemeFilename = THEMES[newThemeName];

            // Disable controls during transition
            select.disabled = true;
            const randomButton = document.getElementById('random-theme-button');
            if (randomButton) randomButton.disabled = true;

            // Add fade-out class
            document.body.classList.add('theme-applying');

            // Save to localStorage
            setTheme(userId, newThemeFilename, newThemeName);

            // Store notification for after reload
            try {
                sessionStorage.setItem('jellyfin-theme-applied', newThemeName);
            } catch (e) {
                console.error('[🪼🎨Jellyfish Theme Selector] Session storage error:', e);
            }

            // Wait for fade-out transition, then reload
            setTimeout(() => {
                console.log(`[🪼🎨Jellyfish Theme Selector] Reloading to apply theme: ${newThemeName}`);
                window.location.reload();
            }, TRANSITION_DURATION);
        });

        return select;
    };

    const createRandomButton = (userId) => {
        const button = document.createElement('button');
        button.setAttribute('is', 'emby-button');
        button.className = 'emby-button';
        button.id = 'random-theme-button';
        button.setAttribute('aria-label', 'Toggle random daily theme');
        button.setAttribute('title', 'Random daily theme');

        const icon = createIcon('shuffle');
        const text = document.createElement('span');
        text.style.fontSize = '0.85em';

        const updateButtonState = () => {
            const isEnabled = isRandomThemeEnabled(userId);
            button.classList.toggle('active', isEnabled);
            text.textContent = isEnabled ? 'Daily' : '';
            button.setAttribute('aria-pressed', isEnabled.toString());
        };

        button.appendChild(icon);
        button.appendChild(text);
        updateButtonState();

        button.addEventListener('click', () => {
            const newState = !isRandomThemeEnabled(userId);
            setRandomThemeEnabled(userId, newState);
            showNotification(`Random daily theme turned ${newState ? 'ON' : 'OFF'}.`);
            console.log(`[🪼🎨Jellyfish Theme Selector] Random daily theme set to: ${newState}`);
            updateButtonState();

            if (newState) {
                applyRandomThemeIfNeeded();
            }
        });

        return button;
    };

    const createThemeSelector = (userId) => {
        const container = document.createElement('div');
        container.className = 'theme-selector-container listItem-border';
        container.id = SELECTOR_ID;

        const listItem = document.createElement('div');
        listItem.className = 'listItem';
        listItem.id = 'theme-selector-item';

        const icon = createIcon('palette', 'material-icons listItemIcon listItemIcon-transparent');
        icon.id = 'theme-selector-icon';

        const contentDiv = document.createElement('div');
        contentDiv.className = 'listItemBody';
        contentDiv.id = 'theme-selector-body';

        const textLabel = document.createElement('div');
        textLabel.className = 'listItemBodyText';
        textLabel.id = 'theme-selector-label';
        textLabel.textContent = 'Theme';

        const currentThemeValue = getCurrentTheme(userId);
        const select = createThemeSelect(userId, currentThemeValue);
        const randomButton = createRandomButton(userId);

        contentDiv.appendChild(textLabel);
        contentDiv.appendChild(randomButton);
        contentDiv.appendChild(select);
        listItem.appendChild(icon);
        listItem.appendChild(contentDiv);
        container.appendChild(listItem);

        return container;
    };

    // --- DOM Injection ---
    const injectThemeSelector = () => {
        try {
            const targetDiv = document.querySelector('.verticalSection .headerUsername');
            if (!targetDiv) return false;

            const parentSection = targetDiv.closest('.verticalSection');
            if (!parentSection) return false;

            const userId = extractUserId();
            if (!userId) return false;

            console.log('[🪼🎨Jellyfish Theme Selector] Creating theme selector element...');
            const themeSelector = createThemeSelector(userId);
            parentSection.appendChild(themeSelector);
            console.log('[🪼🎨Jellyfish Theme Selector] Successfully injected!');
            return true;
        } catch (e) {
            console.error('[🪼🎨Jellyfish Theme Selector] Injection error:', e);
            return false;
        }
    };

    const isOnPreferencesPage = () => {
        try {
            return !!(document.querySelector('.headerUsername') && document.querySelector('.lnkUserProfile'));
        } catch (e) {
            return false;
        }
    };

    // --- Initialization ---
    let observerInstance = null;
    let debounceTimer = null;

    const initialize = () => {
        if (typeof ApiClient === 'undefined' || typeof ApiClient.getCurrentUserId !== 'function') {
            console.log('[🪼🎨Jellyfish Theme Selector] Waiting for ApiClient...');
            setTimeout(initialize, INIT_DELAY);
            return;
        }

        console.log('[🪼🎨Jellyfish Theme Selector] ApiClient is available. Starting persistent element monitoring.');
        applyRandomThemeIfNeeded();
        injectCustomCss();
        checkPostRefreshNotification();

        // Cleanup existing observer if present
        if (observerInstance) {
            observerInstance.disconnect();
        }

        observerInstance = new MutationObserver(() => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                const selectorExists = document.getElementById(SELECTOR_ID);
                if (isOnPreferencesPage() && !selectorExists) {
                    console.log('[🪼🎨Jellyfish Theme Selector] Preferences page detected and selector is missing. Injecting...');
                    injectThemeSelector();
                }
            }, DEBOUNCE_DELAY);
        });

        observerInstance.observe(document.body, {
            childList: true,
            subtree: true
        });
    };

    window.ThemeSelectorInit = initialize;

})();