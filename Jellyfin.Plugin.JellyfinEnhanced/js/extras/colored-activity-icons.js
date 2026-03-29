// /js/extras/colored-activity-icons.js
// Replaces activity icons with Material Design icons and adds colors

(function() {
    'use strict';

    // Inject CSS to hide original SVG icons ONLY in Activity & Alerts
    function injectCSS() {
        const styleId = 'activity-icons-hide-svg';
        if (document.getElementById(styleId)) return;

        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
        a[href^="#/dashboard/activity"] .MuiAvatar-root > svg {
          display: none !important;
        }
        a[href^="#/dashboard/activity"] .MuiAvatar-root .material-icons {
          font-family: 'Material Icons';
          font-size: 18px;
          line-height: 1;
          display: inline-block;
          -webkit-font-smoothing: antialiased;
        }
        a[href^="#/dashboard/activity"] .MuiAvatar-root {
          display: inline-flex !important;
          align-items: center !important;
          justify-content: center !important;
          color: #fff !important;
        }
      `;
        document.head.appendChild(style);
    }

    // Activity text is matched top-to-bottom; first match wins.
    // when one phrase contains another order the longer phrase first (e.g., "uninstalled" before "installed").
    const ICON_MAP = [
        // English
        { text: 'successfully authenticated', icon: 'key', color: '#2e4ed6' },
        { text: 'installation failed', icon: 'warning', color: '#ee3b3bff' },
        { text: 'failed login', icon: 'security_update_warning', color: '#f44336' },
        { text: 'finished playing', icon: 'check_circle', color: '#4caf50' },
        { text: 'is downloading', icon: 'download', color: '#607d8b' },
        { text: 'has been changed', icon: 'key', color: '#ada130ff' },
        { text: 'has been created', icon: 'plus', color: '#2ed62eff' },
        { text: 'disconnected', icon: 'logout', color: '#be7404' },
        { text: 'is playing', icon: 'play_arrow', color: '#2196f3' },
        { text: 'uninstalled', icon: 'delete', color: '#c3342a' },
        { text: 'installed', icon: 'inventory_2', color: '#c957ddff' },
        { text: 'is online', icon: 'login', color: 'green' },
        { text: 'updated', icon: 'update', color: '#00bcd4' },

        // Catalan
        { text: 'intent de connexió fallit', icon: 'security_update_warning', color: '#f44336' },
        { text: 'autenticació correcta', icon: 'key', color: '#2e4ed6' },
        { text: 'instal·lació fallida', icon: 'warning', color: '#ee3b3bff' },
        { text: 'ha començat a reproduir', icon: 'play_arrow', color: '#2196f3' },
        { text: 'ha parat de reproduir', icon: 'check_circle', color: '#4caf50' },
        { text: 'està descarregant', icon: 'download', color: '#607d8b' },
        { text: "s'ha desconnectat", icon: 'logout', color: '#be7404' },
        { text: 'està connectat', icon: 'login', color: 'green' },
        { text: "S'ha canviat", icon: 'key', color: '#ada130ff' },
        { text: "S'ha creat", icon: 'plus', color: '#2ed62eff' },
        { text: 'desinstal·lat', icon: 'delete', color: '#c3342a' },
        { text: "s'ha instal·lat", icon: 'inventory_2', color: '#c957ddff' },
        { text: 'actualitzat', icon: 'update', color: '#00bcd4' },

        // Polish
        { text: 'został pomyślnie uwierzytelniony', icon: 'key', color: '#2e4ed6' },
        { text: 'Nieudana próba logowania', icon: 'security_update_warning', color: '#f44336' },
        { text: 'nieudana', icon: 'warning', color: '#ee3b3bff' },
        { text: 'zakończył odtwarzanie', icon: 'check_circle', color: '#4caf50' },
        { text: 'pobiera', icon: 'download', color: '#607d8b' },
        { text: 'zostało zmienione', icon: 'key', color: '#ada130ff' },
        { text: 'został utworzony', icon: 'plus', color: '#2ed62eff' },
        { text: 'został rozłączony', icon: 'logout', color: '#be7404' },
        { text: 'odtwarza', icon: 'play_arrow', color: '#2196f3' },
        { text: 'odinstalowane', icon: 'delete', color: '#c3342a' },
        { text: 'zostało zainstalowane', icon: 'inventory_2', color: '#c957ddff' },
        { text: 'połączył się z', icon: 'login', color: 'green' },
        { text: 'zaktualizowane', icon: 'update', color: '#00bcd4' }
    ];

    let isProcessing = false;
    let observer = null;
    let debounceTimer = null;

    function updateActivityIcons() {
        if (isProcessing) return;
        isProcessing = true;

        try {
            // Check if activity links are visible
            const activityLinks = document.querySelectorAll('a[href^="#/dashboard/activity"]');

            if (activityLinks.length === 0) {
                isProcessing = false;
                return;
            }

            activityLinks.forEach(anchor => {
                const textEl = anchor.querySelector('.MuiTypography-body1');
                const avatar = anchor.querySelector('.MuiAvatar-root');

                if (!textEl || !avatar) return;

                const text = textEl.textContent.toLowerCase();
                const match = ICON_MAP.find(item => text.includes(item.text));

                if (!match) return;

                // Mark as processed to avoid re-processing
                const dataAttr = 'data-jellyfin-enhanced-activity-icon';
                if (avatar.hasAttribute(dataAttr)) {
                    const existing = avatar.querySelector('.material-icons');
                    if (existing?.textContent === match.icon &&
                        avatar.style.backgroundColor === match.color) return;
                }

                avatar.innerHTML = `<span class="material-icons">${match.icon}</span>`;
                avatar.style.setProperty('background-color', match.color, 'important');
                avatar.setAttribute(dataAttr, 'true');
            });
        } finally {
            isProcessing = false;
        }
    }

    function debouncedUpdateActivityIcons() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(updateActivityIcons, 100);
    }

    function startMonitoring() {
        if (observer) return;

        observer = new MutationObserver((mutations) => {
            let shouldProcess = false;

            mutations.forEach((mutation) => {
                if (mutation.type === 'childList') {
                    const target = mutation.target;

                    // Check if activity links section was modified
                    if (target.matches && (
                        target.matches('a[href^="#/dashboard/activity"]') ||
                        target.querySelector('a[href^="#/dashboard/activity"]') ||
                        target.closest('a[href^="#/dashboard/activity"]')
                    )) {
                        shouldProcess = true;
                    }

                    // Check for activity page container changes
                    if (target.classList && (target.classList.contains('dashboardDocument') || target.classList.contains('activityPage'))) {
                        shouldProcess = true;
                    }
                }
            });

            if (shouldProcess) {
                debouncedUpdateActivityIcons();
            }
        });

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
    }

    function initialize() {
        // Inject CSS for Material Icons
        injectCSS();
        updateActivityIcons();
        startMonitoring();

        // Re-process icons when navigating to activity page or configuration page
        window.addEventListener('hashchange', (event) => {
            const hash = window.location.hash;
            if (hash.includes('#/dashboard/activity') || hash.includes('#/configurationpage')) {
                // Use a longer timeout to ensure page is rendered
                setTimeout(updateActivityIcons, 300);
            }
        });
    }

    if (window.JellyfinEnhanced) {
        window.JellyfinEnhanced.initializeActivityIcons = initialize;
        window.JellyfinEnhanced.stopActivityIconsMonitoring = stopMonitoring;
    }

})();
