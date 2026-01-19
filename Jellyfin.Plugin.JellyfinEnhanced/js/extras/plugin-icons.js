// /js/extras/plugin-icons.js
// Replaces default plugin icons with custom icons on the dashboard

(function () {
    let processedLinks = new WeakSet();

    function replaceIcons() {
        if (!document.body.classList.contains('dashboardDocument')) return;

        const iconConfigs = [
            {
                selector: 'a[href*="Jellyfin%20Enhanced"]',
                type: 'img',
                src: 'http://cdn.jsdelivr.net/gh/n00bcodr/jellyfish/logos/favicon.ico',
                alt: 'Jellyfin Enhanced'
            },
            {
                selector: 'a[href*="JavaScript%20Injector"]',
                type: 'svg',
                svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 630 630"><rect fill="#f7df1e" width="630" height="630"/><path d="M423.2 492.19c12.69 20.72 29.2 35.95 58.4 35.95 24.53 0 40.2-12.26 40.2-29.2 0-20.3-16.1-27.49-43.1-39.3l-14.8-6.35c-42.72-18.2-71.1-41-71.1-89.2 0-44.4 33.83-78.2 86.7-78.2 37.64 0 64.7 13.1 84.2 47.4l-46.1 29.6c-10.15-18.2-21.1-25.37-38.1-25.37-17.34 0-28.33 11-28.33 25.37 0 17.76 11 24.95 36.4 35.95l14.8 6.34c50.3 21.57 78.7 43.56 78.7 93 0 53.3-41.87 82.5-98.1 82.5-54.98 0-90.5-26.2-107.88-60.54zm-209.13 5.13c9.3 16.5 17.76 30.45 38.1 30.45 19.45 0 31.72-7.61 31.72-37.2v-201.3h59.2v202.1c0 61.3-35.94 89.2-88.4 89.2-47.4 0-74.85-24.53-88.81-54.075z"/></svg>'
            },
            {
                selector: 'a[href*="Intro%20Skipper"]',
                type: 'svg',
                path: 'M480-200q-50 0-85-35t-35-85q0-50 35-85t85-35q50 0 85 35t35 85q0 50-35 85t-85 35ZM163-480q14-119 104-199.5T479-760q73 0 135 29.5T720-650v-110h80v280H520v-80h168q-32-54-86.5-87T480-680q-88 0-155 57t-81 143h-81Z'
            },
            {
                selector: 'a[href*="reports"]',
                type: 'svg',
                path: 'M280-280h80v-200h-80v200Zm320 0h80v-400h-80v400Zm-160 0h80v-120h-80v120Zm0-200h80v-80h-80v80ZM200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm0-80h560v-560H200v560Zm0-560v560-560Z'
            },
            {
                selector: 'a[href*="Jellysleep"]',
                type: 'svg',
                path: 'M600-640 480-760l120-120 120 120-120 120Zm200 120-80-80 80-80 80 80-80 80ZM483-80q-84 0-157.5-32t-128-86.5Q143-253 111-326.5T79-484q0-146 93-257.5T409-880q-18 99 11 193.5T520-521q71 71 165.5 100T879-410q-26 144-138 237T483-80Zm0-80q88 0 163-44t118-121q-86-8-163-43.5T463-465q-61-61-97-138t-43-163q-77 43-120.5 118.5T159-484q0 135 94.5 229.5T483-160Zm-20-305Z'
            },
            {
                selector: 'a[href*="Home%20Screen%20Sections"]',
                type: 'svg',
                path: 'M120-840h320v320H120v-320Zm80 80v160-160Zm320-80h320v320H520v-320Zm80 80v160-160ZM120-440h320v320H120v-320Zm80 80v160-160Zm440-80h80v120h120v80H720v120h-80v-120H520v-80h120v-120Zm-40-320v160h160v-160H600Zm-400 0v160h160v-160H200Zm0 400v160h160v-160H200Z'
            },
            {
                selector: 'a[href*="File%20Transformation"]',
                type: 'svg',
                path: 'M480-480ZM202-65l-56-57 118-118h-90v-80h226v226h-80v-89L202-65Zm278-15v-80h240v-440H520v-200H240v400h-80v-400q0-33 23.5-56.5T240-880h320l240 240v480q0 33-23.5 56.5T720-80H480Z'
            }
        ];

        iconConfigs.forEach(config => {
            const link = document.querySelector(config.selector);
            if (!link || processedLinks.has(link)) return;

            const iconDiv = link.querySelector('.MuiListItemIcon-root');
            if (!iconDiv) return;

            const oldSvg = iconDiv.querySelector('svg');
            if (!oldSvg || oldSvg.dataset.testid !== 'FolderIcon') return;

            processedLinks.add(link);

            if (config.type === 'img') {
                const img = document.createElement('img');
                img.src = config.src;
                img.style.width = '24px';
                img.style.height = '24px';
                img.alt = config.alt;
                oldSvg.replaceWith(img);
            } else if (config.type === 'svg') {
                if (config.svg) {
                    const parser = new DOMParser();
                    const svgDoc = parser.parseFromString(config.svg, 'image/svg+xml');
                    const newSvg = svgDoc.documentElement;
                    newSvg.style.width = '24px';
                    newSvg.style.height = '24px';
                    oldSvg.replaceWith(newSvg);
                } else {
                    oldSvg.innerHTML = `<path d="${config.path}"/>`;
                    oldSvg.setAttribute('viewBox', '0 -960 960 960');
                }
            }
        });
    }

    function initialize() {
        console.log('🪼 Jellyfin Enhanced: Plugin Icons initializing...');

        replaceIcons();

        const observer = new MutationObserver((mutations) => {
            let shouldCheck = false;
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === 1 && (node.matches?.('a[href*="configurationpage"]') || node.querySelector?.('a[href*="configurationpage"]'))) {
                        shouldCheck = true;
                        break;
                    }
                }
                if (shouldCheck) break;
            }
            if (shouldCheck && document.body.classList.contains('dashboardDocument')) {
                replaceIcons();
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
        console.log('🪼 Jellyfin Enhanced: Plugin Icons initialized.');
    }

    window.PluginIconsInit = initialize;
})();
