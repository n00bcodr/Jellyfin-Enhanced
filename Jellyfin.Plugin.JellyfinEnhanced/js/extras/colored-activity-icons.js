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
        .material-icons {
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

    // Add mappings in the order of decreasing length of text you want to match
    const ICON_MAP = [
        { text: 'installation failed', icon: 'warning', color: '#ee3b3bff' },
        { text: 'failed login', icon: 'security_update_warning', color: '#f44336' },
        { text: 'successfully authenticated', icon: 'key', color: '#2e4ed6' },
        { text: 'has been changed', icon: 'key', color: '#ada130ff' },
        { text: 'has been created', icon: 'plus', color: '#2ed62eff' },
        { text: 'finished playing', icon: 'check_circle', color: '#4caf50' },
        { text: 'is downloading', icon: 'download', color: '#607d8b' },
        { text: 'uninstalled', icon: 'delete', color: '#c3342a' },
        { text: 'installed', icon: 'inventory_2', color: '#c957ddff' },
        { text: 'is playing', icon: 'play_arrow', color: '#2196f3' },
        { text: 'disconnected', icon: 'logout', color: '#be7404' },
        { text: 'is online', icon: 'login', color: 'green' },
        { text: 'updated', icon: 'update', color: '#00bcd4' }
    ];

    let isProcessing = false;

    function updateActivityIcons() {
        if (isProcessing) return;
        isProcessing = true;

        try {
            // Check if activity links are visible
            const activityLinks = document.querySelectorAll('a[href^="#/dashboard/activity"]');

            if (activityLinks.length === 0) {
                return;
            }

            activityLinks.forEach(anchor => {
                const textEl = anchor.querySelector('.MuiTypography-body1');
                const avatar = anchor.querySelector('.MuiAvatar-root');

                if (!textEl || !avatar) return;

                const text = textEl.textContent.toLowerCase();
                const match = ICON_MAP.find(item => text.includes(item.text));

                if (!match) return;

                // Skip if already set correctly
                const existing = avatar.querySelector('.material-icons');
                if (existing?.textContent === match.icon &&
                    avatar.style.backgroundColor === match.color) return;

                avatar.innerHTML = `<span class="material-icons">${match.icon}</span>`;
                avatar.style.setProperty('background-color', match.color, 'important');
            });
        } finally {
            isProcessing = false;
        }
    }

    let debounceTimer;
    function debouncedUpdateActivityIcons() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(updateActivityIcons, 100);
    }

    function initialize() {
        // Inject CSS for Material Icons
        injectCSS();
        updateActivityIcons();

        const observer = new MutationObserver(debouncedUpdateActivityIcons);
        observer.observe(document.body, { childList: true, subtree: true });
        window.addEventListener('hashchange', debouncedUpdateActivityIcons);
    }

    if (window.JellyfinEnhanced) {
        window.JellyfinEnhanced.initializeActivityIcons = initialize;
    }

})();
