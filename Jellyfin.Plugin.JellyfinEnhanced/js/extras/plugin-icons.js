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

    function replaceIcons() {
        if (isProcessing) return;
        isProcessing = true;

        try {
            // Only run on dashboard pages
            if (!document.body.classList.contains('dashboardDocument')) {
                return;
            }

            // Jellyfin Enhanced
            const jellyfinLink = document.querySelector('a[href*="Jellyfin%20Enhanced"]');
            if (jellyfinLink) {
                const iconDiv = jellyfinLink.querySelector('.MuiListItemIcon-root');
                if (iconDiv) {
                    const oldSvg = iconDiv.querySelector('svg');
                    if (oldSvg && oldSvg.dataset.testid === 'FolderIcon') {
                        const img = document.createElement('img');
                        img.src = 'http://cdn.jsdelivr.net/gh/n00bcodr/jellyfish/logos/favicon.ico';
                        img.style.width = '24px';
                        img.style.height = '24px';
                        img.alt = 'Jellyfin Enhanced';
                        oldSvg.replaceWith(img);
                    }
                }
            }

            // JavaScript Injector
            const jsLink = document.querySelector('a[href*="JavaScript%20Injector"]');
            if (jsLink) {
                const iconDiv = jsLink.querySelector('.MuiListItemIcon-root');
                if (iconDiv) {
                    const oldSvg = iconDiv.querySelector('svg');
                    if (oldSvg && oldSvg.dataset.testid === 'FolderIcon') {
                        const img = document.createElement('img');
                        img.src = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/javascript.svg';
                        img.style.width = '24px';
                        img.style.height = '24px';
                        img.alt = 'JavaScript';
                        oldSvg.replaceWith(img);
                    }
                }
            }

            // Material Icons
            const materialIconConfigs = [
                {
                    selector: 'a[href*="Intro%20Skipper"]',
                    icon: 'redo'
                },
                {
                    selector: 'a[href*="reports"]',
                    icon: 'insert_chart_outlined'
                },
                {
                    selector: 'a[href*="Jellysleep"]',
                    icon: 'dark_mode'
                },
                {
                    selector: 'a[href*="Home%20Screen%20Sections"]',
                    icon: 'dashboard_customize'
                },
                {
                    selector: 'a[href*="File%20Transformation"]',
                    icon: 'file_open'
                }
            ];

            materialIconConfigs.forEach(config => {
                const link = document.querySelector(config.selector);
                if (!link) return;

                const iconDiv = link.querySelector('.MuiListItemIcon-root');
                if (!iconDiv) return;

                const oldSvg = iconDiv.querySelector('svg');
                if (oldSvg && oldSvg.dataset.testid === 'FolderIcon') {
                    // Create material icon
                    const materialIcon = document.createElement('span');
                    materialIcon.className = 'material-icons plugin-material-icon';
                    materialIcon.textContent = config.icon;
                    materialIcon.setAttribute('aria-hidden', 'true');

                    oldSvg.replaceWith(materialIcon);
                }
            });
        } finally {
            isProcessing = false;
        }
    }

    let debounceTimer;
    function debouncedReplaceIcons() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(replaceIcons, 100);
    }

    async function initialize() {
        // Inject CSS for Material Icons
        injectCSS();

        replaceIcons();

        const observer = new MutationObserver(debouncedReplaceIcons);
        observer.observe(document.body, { childList: true, subtree: true });
        window.addEventListener('hashchange', debouncedReplaceIcons);
    }

    if (window.JellyfinEnhanced) {
        window.JellyfinEnhanced.initializePluginIcons = initialize;
    }

})();
