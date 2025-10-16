/**
 * @file Manages all UI components for the Jellyfin Enhanced plugin.
 */
(function(JE) {
    'use strict';

    const GITHUB_REPO = 'n00bcodr/Jellyfin-Enhanced';

    /**
     * Helper function to determine if the current page is the video player.
     * @returns {boolean} True if the current page is the video player.
     */
    JE.isVideoPage = () => window.location.hash.startsWith('#/video');

    /**
     * Helper function to determine if the current page is an item details page.
     * @returns {boolean} True if on an item details page.
     */
    JE.isDetailsPage = () => window.location.hash.includes('/details?id=');

    /**
     * Displays a short-lived toast notification.
     * @param {string} key The localization key for the text to display.
     * @param {number} [duration=JE.CONFIG.TOAST_DURATION] The duration to show the toast.
     */
    JE.toast = (key, duration = JE.CONFIG.TOAST_DURATION) => {
        const getJellyfinThemeVariable = (variableName, defaultValue) => {
            const rootStyle = getComputedStyle(document.documentElement);
            const value = rootStyle.getPropertyValue(variableName).trim();
            return value ? value : defaultValue;
        };

        const isJellyfishThemeActive = getJellyfinThemeVariable('--theme-updated-on', '') !== '' || getJellyfinThemeVariable('--theme-name', '').toLowerCase().includes('jellyfish');
        let toastBg, toastBorder;

        if (isJellyfishThemeActive) {
            toastBg = getJellyfinThemeVariable('--secondary-background-transparent', 'rgba(0,0,0,0.6)');
            toastBorder = `1px solid ${getJellyfinThemeVariable('--primary-accent-color', 'rgba(255,255,255,0.1)')}`;
        } else {
            toastBg = 'linear-gradient(135deg, rgba(0,0,0,0.9), rgba(40,40,40,0.9))';
            toastBorder = '1px solid rgba(255,255,255,0.1)';
        }

        const t = document.createElement('div');
        t.className = 'jellyfin-enhanced-toast';
        Object.assign(t.style, {
            position: 'fixed',
            bottom: '20px',
            right: '20px',
            transform: 'translateX(100%)',
            background: toastBg,
            color: '#fff',
            padding: '10px 14px',
            borderRadius: '8px',
            zIndex: 99999,
            fontSize: 'clamp(13px, 2vw, 16px)',
            textShadow: '-1px -1px 10px black',
            fontWeight: '500',
            boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
            backdropFilter: `blur(30px)`,
            border: toastBorder,
            transition: 'transform 0.3s ease-out',
            maxWidth: 'clamp(280px, 80vw, 350px)'
        });
        t.innerHTML = key; // Note: The calling function should now pass the localized string
        document.body.appendChild(t);
        setTimeout(() => t.style.transform = 'translateX(0)', 10);
        setTimeout(() => {
            t.style.transform = 'translateX(100%)';
            setTimeout(() => t.remove(), 300);
        }, duration);
    };

    /**
     * Fetches the latest GitHub release notes and displays them in a notification panel.
     */
    async function showReleaseNotesNotification() {
        let release;
        try {
            const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
            if (!response.ok) throw new Error('Failed to fetch release data');
            release = await response.json();
        } catch (error) {
            console.error('🪼 Jellyfin Enhanced: Failed to fetch release notes:', error);
            JE.toast('❌ Could not load release notes.');
            return;
        }

        const notificationId = 'jellyfin-release-notes-notification';
        const existing = document.getElementById(notificationId);
        if (existing) existing.remove();

        const notification = document.createElement('div');
        notification.id = notificationId;

        // --- Release notes autoclose ---
        let autoCloseTimer = null;
        let isMouseInside = false;
        const AUTOCLOSE_DELAY = 20000; // 20 seconds

        const closePanel = () => {
            if (document.getElementById(notificationId)) {
                notification.style.transform = 'translateX(100%)';
                setTimeout(() => notification.remove(), 300);
            }
        };

        const resetAutoCloseTimer = () => {
            if (autoCloseTimer) clearTimeout(autoCloseTimer);
            autoCloseTimer = setTimeout(() => {
                if (!isMouseInside) {
                    closePanel();
                }
            }, AUTOCLOSE_DELAY);
        };

        notification.addEventListener('mouseenter', () => {
            isMouseInside = true;
            if (autoCloseTimer) clearTimeout(autoCloseTimer);
        });
        notification.addEventListener('mouseleave', () => {
            isMouseInside = false;
            resetAutoCloseTimer();
        });

        const getJellyfinThemeVariable = (variableName, defaultValue) => {
            const rootStyle = getComputedStyle(document.documentElement);
            const value = rootStyle.getPropertyValue(variableName).trim();
            return value || defaultValue;
        };

        const isJellyfishThemeActive = getJellyfinThemeVariable('--theme-updated-on', '') !== '' || getJellyfinThemeVariable('--theme-name', '').toLowerCase().includes('jellyfish');

        let panelBg, panelBorder, textColor;
        if (isJellyfishThemeActive) {
            panelBg = getJellyfinThemeVariable('--primary-background-transparent', 'rgba(0,0,0,0.95)');
            panelBorder = `1px solid ${getJellyfinThemeVariable('--primary-accent-color', 'rgba(255,255,255,0.1)')}`;
            textColor = getJellyfinThemeVariable('--text-color', '#fff');
        } else {
            panelBg = 'linear-gradient(135deg, rgba(0,0,0,0.95), rgba(20,20,20,0.95))';
            panelBorder = '1px solid rgba(255,255,255,0.1)';
            textColor = '#fff';
        }

        Object.assign(notification.style, {
            position: 'fixed',
            top: '20px',
            right: '20px',
            background: panelBg,
            color: textColor,
            padding: '20px',
            borderRadius: '12px',
            zIndex: 999999,
            fontSize: '14px',
            fontWeight: '500',
            boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
            backdropFilter: `blur(50px)`,
            border: panelBorder,
            maxWidth: '500px',
            transform: 'translateX(100%)',
            transition: 'transform 0.3s ease-out',
            fontFamily: 'inherit'
        });

        const markdownToHtml = (text) => {
            if (!text) return '';
            return text
                // Blockquotes
                .replace(/^>\s*\[!NOTE\]\s*\r?\n((?:>.*(?:\r?\n|$))+)/gm, (match, content) => {
                    const noteContent = content.replace(/^>\s?/gm, '');
                    return `<div style="padding: 10px; border-left: 4px solid #f0ad4e; background-color: rgba(240, 173, 78, 0.1); margin: 10px 0;"><strong>NOTE:</strong><br>${noteContent}</div>`;
                })
                // Headings (with reduced margins)
                .replace(/^## (.*$)/gm, '<h3 style="font-size: 1.2em; margin: 0.75em 0 0;">$1</h3>')
                .replace(/^# (.*$)/gm, '<h2 style="font-size: 1.4em; margin: 0.75em 0 0;">$1</h2>')
                // Links
                .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" style="color: var(--primary-accent-color, #00a4dc); text-decoration: none;">$1</a>')
                // Bold and Italic
                .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                .replace(/\*(.*?)\*/g, '<em>$1</em>')
                // Lists (simple)
                .replace(/^\* (.*$)/gm, (match, item) => `<ul><li style="margin-left: 20px;">${item}</li></ul>`)
                .replace(/<\/ul>\s*<ul>/g, '') // Merge adjacent lists that were separated by a newline
                // General newlines
                .replace(/\n/g, '<br>')
                // Collapse multiple line breaks into one to reduce gaps
                .replace(/(<br>\s*){2,}/g, '<br>');
        };

        const releaseNotes = release.body ?
            (release.body.length > 1500 ? release.body.substring(0, 200) + '...' : release.body) :
            'No release notes available.';

        notification.innerHTML = `
            <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
                <div style="width: 40px; height: 40px; background: #3e74f2bd; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 18px;">📋</div>
                <div>
                    <div style="font-weight: 600; font-size: 16px; color: #779aeadc;">Latest Release Notes</div>
                    <div style="font-size: 12px; color: rgba(255,255,255,0.7);">${release.tag_name}</div>
                </div>
            </div>
            <div style="margin-bottom: 17px; font-size: 13px; color: rgba(255,255,255,0.8); line-height: 1.4; max-height: 300px; overflow-y: auto;">
                ${markdownToHtml(releaseNotes)}
            </div>
            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                <a href="${release.html_url}" target="_blank" style="background: #3e74f2bd; border: 1px solid #779aeadc; color: white; text-decoration: none; padding: 8px 12px; border-radius: 6px; font-size: 12px; font-weight: 500;">View on GitHub</a>
                <button onclick="this.parentElement.parentElement.remove()" style="background: #f25151b5; border: 1px solid #f2515133; color: white; padding: 8px 12px; border-radius: 6px; font-size: 12px; font-family: inherit; font-weight: 500; cursor: pointer;">✕ Close</button>
            </div>
        `;

        document.body.appendChild(notification);
        setTimeout(() => { notification.style.transform = 'translateX(0)'; }, 10);

        resetAutoCloseTimer();
    }

    /**
     * Injects custom CSS for plugin features.
     */
    JE.injectGlobalStyles = () => {
        const styleId = 'jellyfin-enhanced-styles';
        if (document.getElementById(styleId)) return;
        const style = document.createElement('style');
        style.id = styleId;
        style.innerHTML = `
            @keyframes dice { 0%, 100% { transform: rotate(0deg) scale(1); } 10%, 30%, 50% { transform: rotate(-10deg) scale(1.1); } 20%, 40% { transform: rotate(10deg) scale(1.1); } 60% { transform: rotate(360deg) scale(1); } }
            button#randomItemButton:not(.loading):hover .material-icons { animation: dice 1.5s; }
            .layout-desktop #enhancedSettingsBtn { display: none !important; }
            .remove-continue-watching-button { transition: all 0.2s ease; }
            .remove-continue-watching-button .material-icons { width: 24px; text-align: center; transition: transform 0.2s ease, color 0.2s ease; }
            .remove-continue-watching-button:hover .material-icons { transform: scale(1.1); color: #ff6b6b; }
            .remove-continue-watching-button:active .material-icons { transform: scale(0.95); }
            .remove-continue-watching-button:disabled { opacity: 0.6; cursor: not-allowed; }
            .remove-continue-watching-button:disabled .material-icons { transform: none !important; }
            .layout-mobile #jellyfin-enhanced-panel { width: 95vw; max-width: 95vw; }
            .layout-mobile #jellyfin-enhanced-panel .shortcuts-container { flex-direction: column; }
            .layout-mobile #jellyfin-enhanced-panel #settings-content { width: auto !important; }
            .layout-mobile #jellyfin-enhanced-panel .panel-main-content { padding: 0 15px; }
            .layout-mobile #jellyfin-enhanced-panel .panel-footer { flex-direction: row; gap: 16px; }
            .layout-mobile #jellyfin-enhanced-panel .close-helptext { display: none; }
            .layout-mobile #jellyfin-enhanced-panel .footer-buttons { flex-direction: column; align-items: flex-end !important; width: 100%; gap: 10px; }
            .layout-mobile #jellyfin-enhanced-panel .footer-buttons > * { justify-content: center; }
            @keyframes longPressGlow { from { box-shadow: 0 0 5px 2px var(--primary-accent-color, #fff); } to { box-shadow: 0 0 8px 15px transparent; } }
            .headerUserButton.long-press-active { animation: longPressGlow 750ms ease-out; }
            #jellyfin-enhanced-panel kbd {
                background-color: rgba(255,255,255,0.1);
                border: 1px solid rgba(255,255,255,0.2);
                border-radius: 4px;
                padding: 2px 6px;
                font-size: 0.9em;
                font-family: inherit;
                box-shadow: 0 1px 1px rgba(0,0,0,0.2);
            }
        `;
        document.head.appendChild(style);
    };

    /**
     * Adds the "Jellyfin Enhanced" menu button to the sidebar.
     */
    JE.addPluginMenuButton = () => {
        const addMenuButton = (sidebar) => {
            let pluginSettingsSection = sidebar.querySelector('.pluginMenuOptions');

            if (!pluginSettingsSection) {
                pluginSettingsSection = document.createElement('div');
                pluginSettingsSection.className = 'pluginMenuOptions';
                pluginSettingsSection.innerHTML = '<h3 class="sidebarHeader">Plugin Settings</h3>';

                const settingsSection = sidebar.querySelector('.navMenuOption[href*="settings"]')?.closest('.drawerSection');
                if (settingsSection && settingsSection.nextSibling) {
                    sidebar.insertBefore(pluginSettingsSection, settingsSection.nextSibling);
                } else {
                    sidebar.appendChild(pluginSettingsSection);
                }
            }

            if (!pluginSettingsSection.querySelector('#jellyfinEnhancedSettingsLink')) {
                const jellyfinEnhancedLink = document.createElement('a');
                jellyfinEnhancedLink.setAttribute('is', 'emby-linkbutton');
                jellyfinEnhancedLink.className = 'lnkMediaFolder navMenuOption emby-button';
                jellyfinEnhancedLink.href = '#';
                jellyfinEnhancedLink.id = 'jellyfinEnhancedSettingsLink';
                jellyfinEnhancedLink.innerHTML = `
                    <span class="material-icons navMenuOptionIcon" aria-hidden="true">tune</span>
                    <span class="sectionName navMenuOptionText">Jellyfin Enhanced</span>
                `;

                jellyfinEnhancedLink.addEventListener('click', (e) => {
                    e.preventDefault();
                    JE.showEnhancedPanel();
                });

                pluginSettingsSection.appendChild(jellyfinEnhancedLink);
            }
        };

        const observer = new MutationObserver(() => {
            const sidebar = document.querySelector('.mainDrawer-scrollContainer');
            if (sidebar && !sidebar.querySelector('#jellyfinEnhancedSettingsLink')) {
                addMenuButton(sidebar);
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
    };

    /**
     * Injects the "Jellyfin Enhanced" settings button into the video player OSD.
     */
    JE.addOsdSettingsButton = () => {
        if (document.getElementById('enhancedSettingsBtn')) return;
        const controlsContainer = document.querySelector('.videoOsdBottom .buttons.focuscontainer-x');
        if (!controlsContainer) return;
        const nativeSettingsButton = controlsContainer.querySelector('.btnVideoOsdSettings');
        if (!nativeSettingsButton) return;

        const enhancedSettingsBtn = document.createElement('button');
        enhancedSettingsBtn.id = 'enhancedSettingsBtn';
        enhancedSettingsBtn.setAttribute('is', 'paper-icon-button-light');
        enhancedSettingsBtn.className = 'autoSize paper-icon-button-light';
        enhancedSettingsBtn.title = 'Jellyfin Enhanced';
        enhancedSettingsBtn.innerHTML = '<span class="largePaperIconButton material-icons" aria-hidden="true">tune</span>';

        enhancedSettingsBtn.onclick = (e) => {
            e.stopPropagation();
            JE.showEnhancedPanel();
        };

        nativeSettingsButton.parentElement.insertBefore(enhancedSettingsBtn, nativeSettingsButton);
    };

    /**
     * Toggles the main settings and help panel for the plugin.
     */
    JE.showEnhancedPanel = () => {
        const panelId = 'jellyfin-enhanced-panel';
        const existing = document.getElementById(panelId);
        if (existing) {
            existing.remove();
            return;
        }
        // Get the Jellyfish theme variables to apply consistent styles.
        const getJellyfinThemeVariable = (variableName, defaultValue) => {
            const rootStyle = getComputedStyle(document.documentElement);
            const value = rootStyle.getPropertyValue(variableName).trim();
            return value ? value : defaultValue;
        };

        const isJellyfishThemeActive = getJellyfinThemeVariable('--theme-updated-on', '') !== '' || getJellyfinThemeVariable('--theme-name', '').toLowerCase().includes('jellyfish');
        let panelBgColor, secondaryBg, headerFooterBg, primaryAccentColor, toggleAccentColor, kbdBackground, presetBoxBackground, detailsBackground, panelBlurValue, githubButtonBg, releaseNotesBg, checkUpdatesBorder, releaseNotesTextColor, logoUrl;
        if (isJellyfishThemeActive) {
            panelBgColor = getJellyfinThemeVariable('--primary-background-transparent', 'rgba(0,0,0,0.95)');
            secondaryBg = getJellyfinThemeVariable('--secondary-background-transparent', 'rgba(0,0,0,0.2)');
            headerFooterBg = secondaryBg;
            detailsBackground = secondaryBg;
            primaryAccentColor = getJellyfinThemeVariable('--primary-accent-color', '#00A4DC');
            toggleAccentColor = primaryAccentColor;
            kbdBackground = getJellyfinThemeVariable('--alt-accent-color', '#ffffff20');
            presetBoxBackground = getJellyfinThemeVariable('--alt-accent-color', '#ffffff20');
            panelBlurValue = getJellyfinThemeVariable('--blur', '20px');
            githubButtonBg = 'rgba(102, 179, 255, 0.1)';
            releaseNotesBg = primaryAccentColor;
            checkUpdatesBorder = `1px solid ${primaryAccentColor}`;
            releaseNotesTextColor = getJellyfinThemeVariable('--text-color', '#000000');
            const rawLogoValue = getJellyfinThemeVariable('--logo', '');
            logoUrl = rawLogoValue.replace(/url\(['"]?(.*?)['"]?\)/i, '$1');
        } else {
            panelBgColor = 'linear-gradient(135deg, rgba(0,0,0,0.95), rgba(20,20,20,0.95))';
            headerFooterBg = 'linear-gradient(135deg, rgba(0,0,0,0.95), rgba(20,20,20,0.95))';
            detailsBackground = 'rgba(0,0,0,0.2)';
            primaryAccentColor = '#00A4DC';
            toggleAccentColor = '#AA5CC3';
            kbdBackground = 'rgba(255,255,255,0.1)';
            presetBoxBackground = 'rgba(255,255,255,0.05)';
            panelBlurValue = '20px';
            githubButtonBg = 'rgba(102, 179, 255, 0.1)';
            releaseNotesBg = 'linear-gradient(135deg, #AA5CC3, #00A4DC)';
            checkUpdatesBorder = `1px solid ${primaryAccentColor}`;
            releaseNotesTextColor = '#FFFFFF';
        }

        const help = document.createElement('div');
        help.id = panelId;
        Object.assign(help.style, {
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            background: 'rgb(24, 24, 24)',
            color: '#fff',
            padding: '0',
            borderRadius: '16px',
            zIndex: 999999,
            fontSize: '14px',
            backdropFilter: `blur(${panelBlurValue})`,
            minWidth: '350px',
            maxWidth: '90vw',
            maxHeight: '90vh',
            boxShadow: '0 10px 30px rgba(0,0,0,0.7)',
            border: '1px solid rgba(255,255,255,0.1)',
            overflow: 'hidden',
            cursor: 'grab',
            display: 'flex',
            fontFamily: 'inherit',
            flexDirection: 'column'
        });

        const shortcuts = JE.pluginConfig.Shortcuts.reduce((acc, s) => ({ ...acc, [s.Name]: s }), {});
        // --- Draggable Panel Logic ---------
        let isDragging = false;
        let offset = { x: 0, y: 0 };
        let autoCloseTimer = null;
        let isMouseInside = false;

        const resetAutoCloseTimer = () => {
            if (autoCloseTimer) clearTimeout(autoCloseTimer);
            autoCloseTimer = setTimeout(() => {
                if (!isMouseInside && document.getElementById(panelId)) {
                    help.remove();
                    document.removeEventListener('keydown', closeHelp);
                    document.removeEventListener('mousemove', handleMouseMove);
                    document.removeEventListener('mouseup', handleMouseUp);
                    if (!JE.pluginConfig.DisableAllShortcuts) {
                        document.addEventListener('keydown', JE.keyListener);
                    }
                }
            }, JE.CONFIG.HELP_PANEL_AUTOCLOSE_DELAY);
        };

        const handleMouseDown = (e) => {
            if (e.target.closest('.preset-box, button, a, details, input')) return;
            isDragging = true;
            offset = { x: e.clientX - help.getBoundingClientRect().left, y: e.clientY - help.getBoundingClientRect().top };
            help.style.cursor = 'grabbing';
            e.preventDefault();
            resetAutoCloseTimer();
        };

        const handleMouseMove = (e) => {
            if (isDragging) {
                help.style.left = `${e.clientX - offset.x}px`;
                help.style.top = `${e.clientY - offset.y}px`;
                help.style.transform = 'none';
            }
            resetAutoCloseTimer();
        };

        const handleMouseUp = () => {
            isDragging = false;
            help.style.cursor = 'grab';
            resetAutoCloseTimer();
        };

        help.addEventListener('mousedown', handleMouseDown);
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
        // Reset the auto-close timer when the mouse enters or leaves the panel.
        help.addEventListener('mouseenter', () => { isMouseInside = true; if (autoCloseTimer) clearTimeout(autoCloseTimer); });
        help.addEventListener('mouseleave', () => { isMouseInside = false; resetAutoCloseTimer(); });
        help.addEventListener('click', resetAutoCloseTimer);
        help.addEventListener('wheel', (e) => { e.stopPropagation(); resetAutoCloseTimer(); });

        const generatePresetHTML = (presets, type) => {
            return presets.map((preset, index) => {
                let previewStyle = '';
                if (type === 'style') {
                    previewStyle = `background-color: ${preset.bgColor}; color: ${preset.textColor}; border: 1px solid rgba(255,255,255,0.3); text-shadow: #000000 0px 0px 3px;`;
                } else if (type === 'font-size') {
                    previewStyle = `font-size: ${preset.size}em; color: #fff; text-shadow: 0 0 4px rgba(0,0,0,0.8);`;
                } else if (type === 'font-family') {
                    previewStyle = `font-family: ${preset.family}; color: #fff; text-shadow: 0 0 4px rgba(0,0,0,0.8); font-size: 1.5em;`;
                }
                return `
                    <div class="preset-box ${type}-preset" data-preset-index="${index}" title="${preset.name}" style="display: flex; justify-content: center; align-items: center; padding: 8px; border: 2px solid transparent; border-radius: 8px; cursor: pointer; transition: all 0.2s; background: ${presetBoxBackground}; min-height: 30px;" onmouseover="this.style.background='rgba(255,255,255,0.3)'" onmouseout="this.style.background='${presetBoxBackground}'">
                        <span style="display: inline-block; ${type === 'style' ? `width: 40px; height: 25px; border-radius: 4px; line-height: 25px;` : ''} ${previewStyle} text-align: center; font-weight: bold;">${preset.previewText}</span>
                    </div>`;
            }).join('');
        };

        const userShortcuts = JE.userShortcutManager.load();
        help.innerHTML = `
            <style>
                #jellyfin-enhanced-panel .tabs { display: flex; border-bottom: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.2); }
                #jellyfin-enhanced-panel .tab-button { font-family: inherit; flex: 1; padding: 14px; text-align: center; cursor: pointer; background: transparent; border: none; color: rgba(255,255,255,0.6); font-size: 15px; font-weight: 600; transition: all 0.2s; border-bottom: 2px solid transparent; background: ${panelBgColor}; }
                #jellyfin-enhanced-panel .tab-button:hover { background: ${panelBgColor}; color: #fff; }
                #jellyfin-enhanced-panel .tab-button.active { color: #fff; border-bottom-color: ${primaryAccentColor}; background: ${headerFooterBg}; }
                #jellyfin-enhanced-panel .tab-content { display: none; }
                #jellyfin-enhanced-panel .tab-content.active { display: block; }
                @keyframes shake { 10%, 90% { transform: translateX(-1px); } 20%, 80% { transform: translateX(2px); } 30%, 50%, 70% { transform: translateX(-4px); } 40%, 60% { transform: translateX(4px); } }
                .shake-error { animation: shake 0.5s ease-in-out; }
            </style>
            <div style="padding: 18px 20px; border-bottom: 1px solid rgba(255,255,255,0.1); background: ${headerFooterBg};">
                <div style="font-size: 24px; font-weight: 700; margin-bottom: 8px; text-align: center; background: ${primaryAccentColor}; -webkit-background-clip: text; -webkit-text-fill-color: transparent;">🪼 Jellyfin Enhanced</div>
                <div style="text-align: center; font-size: 12px; color: rgba(255,255,255,0.8);">${JE.t('panel_version', { version: JE.pluginVersion })}</div>
            </div>
            <div class="tabs">
                ${!JE.pluginConfig.DisableAllShortcuts ? `<button class="tab-button" data-tab="shortcuts">${JE.t('panel_shortcuts_tab')}</button>` : ''}
                <button class="tab-button" data-tab="settings">${JE.t('panel_settings_tab')}</button>
            </div>
            <div class="panel-main-content" style="padding: 0 20px; flex: 1; overflow-y: auto; position: relative; background: ${panelBgColor};">
                 ${!JE.pluginConfig.DisableAllShortcuts ? `
                 <div id="shortcuts-content" class="tab-content" style="padding-top: 20px; padding-bottom: 20px;">
                 <div class="shortcuts-container" style="display: flex; flex-wrap: wrap; gap: 20px; margin-bottom: 24px;">
                        <div style="flex: 1; min-width: 400px;">
                            <h3 style="margin: 0 0 12px 0; font-size: 18px; color: ${primaryAccentColor}; font-family: inherit;">${JE.t('panel_shortcuts_global')}</h3>
                            <div style="display: grid; gap: 8px; font-size: 14px;">
                                ${JE.pluginConfig.Shortcuts.filter((s, index, self) => s.Category === 'Global' && index === self.findIndex(t => t.Name === s.Name)).map(action => `
                                    <div style="display: flex; justify-content: space-between; align-items: center;">
                                        <span class="shortcut-key" tabindex="0" data-action="${action.Name}" style="background:${kbdBackground}; padding:2px 8px; border-radius:3px; cursor:pointer; transition: all 0.2s;">${JE.state.activeShortcuts[action.Name]}</span>
                                        <div style="display: flex; align-items: center; gap: 8px;">
                                            ${userShortcuts.hasOwnProperty(action.Name) ? `<span title="Modified by user" class="modified-indicator" style="color:${primaryAccentColor}; font-size: 20px; line-height: 1;">•</span>` : ''}
                                            <span>${JE.t('shortcut_' + action.Name)}</span>
                                        </div>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                        <div style="flex: 1; min-width: 400px;">
                            <h3 style="margin: 0 0 12px 0; font-size: 18px; color: ${primaryAccentColor}; font-family: inherit;">${JE.t('panel_shortcuts_player')}</h3>
                            <div style="display: grid; gap: 8px; font-size: 14px;">
                                ${['CycleAspectRatio', 'ShowPlaybackInfo', 'SubtitleMenu', 'CycleSubtitleTracks', 'CycleAudioTracks', 'IncreasePlaybackSpeed', 'DecreasePlaybackSpeed', 'ResetPlaybackSpeed', 'BookmarkCurrentTime', 'GoToSavedBookmark'].map(action => `
                                    <div style="display: flex; justify-content: space-between; align-items: center;">
                                        <span class="shortcut-key" tabindex="0" data-action="${action}" style="background:${kbdBackground}; padding:2px 8px; border-radius:3px; cursor:pointer; transition: all 0.2s;">${JE.state.activeShortcuts[action]}</span>
                                        <div style="display: flex; align-items: center; gap: 8px;">
                                            ${userShortcuts.hasOwnProperty(action) ? `<span class="modified-indicator" title="Modified by user" style="color:${primaryAccentColor}; font-size: 20px; line-height: 1;">•</span>` : ''}
                                            <span>${JE.t('shortcut_' + action)}</span>
                                        </div>
                                    </div>
                                `).join('')}
                                <div style="display: flex; justify-content: space-between;">
                                    <span style="background:${kbdBackground}; padding:2px 8px; border-radius:3px;">0-9</span>
                                    <span>${JE.t('shortcut_JumpToPercentage')}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div style="text-align: center; font-size: 11px; color: rgba(255,255,255,0.6);">
                    ${JE.t('panel_shortcuts_footer')}
                    </div>
                </div>` : ''}
                <div id="settings-content" class="tab-content" style="padding-top: 20px; padding-bottom: 20px; width: 50vw;">
                    <details style="margin-bottom: 16px; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; background: ${detailsBackground};">
                        <summary style="padding: 16px; font-weight: 600; color: ${primaryAccentColor}; cursor: pointer; user-select: none; font-family: inherit;">⏯️ ${JE.t('panel_settings_playback')}</summary>
                        <div style="padding: 0 16px 16px 16px;">
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="autoPauseToggle" ${JE.currentSettings.autoPauseEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JE.t('panel_settings_auto_pause')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_auto_pause_desc')}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="pauseScreenToggle" ${JE.currentSettings.pauseScreenEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JE.t('panel_settings_custom_pause_screen')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_custom_pause_screen_desc')}</div></div>
                                </label>
                            </div>
                           <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="autoResumeToggle" ${JE.currentSettings.autoResumeEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JE.t('panel_settings_auto_resume')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_auto_resume_desc')}</div></div>
                                </label>
                            </div>
                            <div style="padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="autoPipToggle" ${JE.currentSettings.autoPipEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JE.t('panel_settings_auto_pip')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_auto_pip_desc')}</div></div>
                                </label>
                            </div>
                        </div>
                    </details>
                    <details style="margin-bottom: 16px; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; background: ${detailsBackground};">
                        <summary style="padding: 16px; font-weight: 600; color: ${primaryAccentColor}; cursor: pointer; user-select: none; font-family: inherit;">↪️ ${JE.t('panel_settings_auto_skip')}</summary>
                        <div style="font-size:12px; color:rgba(255,255,255,0.6); margin-left: 18px; margin-bottom: 10px;">${JE.t('panel_settings_auto_skip_depends')}</div>
                        <div style="padding: 0 16px 16px 16px;">
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="autoSkipIntroToggle" ${JE.currentSettings.autoSkipIntro ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JE.t('panel_settings_auto_skip_intro')}</div></div>
                                </label>
                            </div>
                            <div style="padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="autoSkipOutroToggle" ${JE.currentSettings.autoSkipOutro ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JE.t('panel_settings_auto_skip_outro')}</div></div>
                                </label>
                            </div>
                        </div>
                    </details>
                    <details style="margin-bottom: 16px; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; background: ${detailsBackground};">
                        <summary style="padding: 16px; font-weight: 600; color: ${primaryAccentColor}; cursor: pointer; user-select: none; font-family: inherit;">📝 ${JE.t('panel_settings_subtitles')}</summary>
                        <div style="padding: 0 16px 16px 16px;">
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="disableCustomSubtitleStyles" ${JE.currentSettings.disableCustomSubtitleStyles ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JE.t('panel_settings_disable_custom_styles')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_disable_custom_styles_desc')}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 16px;"><div style="font-weight: 600; margin-bottom: 8px;">${JE.t('panel_settings_subtitles_style')}</div><div id="subtitle-style-presets-container" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(70px, 1fr)); gap: 8px;">${generatePresetHTML(JE.subtitlePresets, 'style')}</div></div>
                            <div style="margin-bottom: 16px;"><div style="font-weight: 600; margin-bottom: 8px;">${JE.t('panel_settings_subtitles_size')}</div><div id="font-size-presets-container" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(70px, 1fr)); gap: 8px;">${generatePresetHTML(JE.fontSizePresets, 'font-size')}</div></div>
                            <div style="margin-bottom: 16px;"><div style="font-weight: 600; margin-bottom: 8px;">${JE.t('panel_settings_subtitles_font')}</div><div id="font-family-presets-container" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(70px, 1fr)); gap: 8px;">${generatePresetHTML(JE.fontFamilyPresets, 'font-family')}</div></div>
                        </div>
                    </details>
                    <details style="margin-bottom: 16px; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; background: ${detailsBackground};">
                        <summary style="padding: 16px; font-weight: 600; color: ${primaryAccentColor}; cursor: pointer; user-select: none; font-family: inherit;">🎲 ${JE.t('panel_settings_random_button')}</summary>
                        <div style="padding: 0 16px 16px 16px;">
                            <div style="margin-bottom:16px; padding:12px; background:${presetBoxBackground}; border-radius:6px; border-left:3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;"><input type="checkbox" id="randomButtonToggle" ${JE.currentSettings.randomButtonEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;"><div><div style="font-weight:500;">${JE.t('panel_settings_random_button_enable')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_random_button_enable_desc')}</div></div></label>
                                <br>
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;"><input type="checkbox" id="randomUnwatchedOnly" ${JE.currentSettings.randomUnwatchedOnly ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;"><div><div style="font-weight:500;">${JE.t('panel_settings_random_button_unwatched')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_random_button_unwatched_desc')}</div></div></label>
                            </div>
                            <div style="font-weight:500; margin-bottom:8px;">${JE.t('panel_settings_random_button_types')}</div>
                            <div style="display:flex; gap:16px; padding:12px; background:${presetBoxBackground}; border-radius:6px; border-left:3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;"><input type="checkbox" id="randomIncludeMovies" ${JE.currentSettings.randomIncludeMovies ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;"><span>${JE.t('panel_settings_random_button_movies')}</span></label>
                                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;"><input type="checkbox" id="randomIncludeShows" ${JE.currentSettings.randomIncludeShows ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;"><span>${JE.t('panel_settings_random_button_shows')}</span></label>
                            </div>
                        </div>
                    </details>
                    <details style="margin-bottom: 16px; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; background: ${detailsBackground};">
                        <summary style="padding: 16px; font-weight: 600; color: ${primaryAccentColor}; cursor: pointer; user-select: none; font-family: inherit;">🖥️ ${JE.t('panel_settings_ui')}</summary>
                        <div style="padding: 0 16px 16px 16px;">
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="showFileSizesToggle" ${JE.currentSettings.showFileSizes ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JE.t('panel_settings_ui_file_sizes')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_ui_file_sizes_desc')}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="showAudioLanguagesToggle" ${JE.currentSettings.showAudioLanguages ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JE.t('panel_settings_ui_audio_languages')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_ui_audio_languages_desc')}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="qualityTagsToggle" ${JE.currentSettings.qualityTagsEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JE.t('panel_settings_ui_quality_tags')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_ui_quality_tags_desc')}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="genreTagsToggle" ${JE.currentSettings.genreTagsEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JE.t('panel_settings_ui_genre_tags')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_ui_genre_tags_desc')}</div></div>
                                </label>
                            </div>
                            <div style="padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="removeContinueWatchingToggle" ${JE.currentSettings.removeContinueWatchingEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JE.t('panel_settings_ui_remove_continue_watching')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_ui_remove_continue_watching_desc')}</div><div style="font-size:12px; font-weight: bold; color:rgba(255, 55, 55, 1); margin-top:2px;">${JE.t('panel_settings_ui_remove_continue_watching_warning')}</div></div>
                                </label>
                            </div>
                        </div>
                    </details>
                </div>
            </div>
            <div class="panel-footer" style="padding: 16px 20px; border-top: 1px solid rgba(255,255,255,0.1); background: ${headerFooterBg}; display: flex; justify-content: space-between; align-items: center;">
                <div class="close-helptext" style="font-size:12px; color:rgba(255,255,255,0.5);">${JE.t('panel_footer_close')}</div>
                ${logoUrl ? `<img src="${logoUrl}" class="footer-logo" alt="Theme Logo" style="height: 40px;">` : ''}
                <div class="footer-buttons" style="display:flex; gap:12px; align-items:center;">
                    <button id="releaseNotesBtn" style="font-family:inherit; background:${releaseNotesBg}; color:${releaseNotesTextColor}; border:${checkUpdatesBorder}; padding:4px 8px; border-radius:6px; font-size:12px; font-weight:500; cursor:pointer; transition:all 0.2s; display:flex; align-items:center; gap:6px;" onmouseover="this.style.background='${primaryAccentColor}'" onmouseout="this.style.background='${releaseNotesBg}'">${JE.t('panel_footer_release_notes')}</button>
                    <a href="https://github.com/${GITHUB_REPO}/" target="_blank" style="color:${primaryAccentColor}; text-decoration:none; display:flex; align-items:center; gap:6px; font-size:12px; padding:4px 8px; border-radius:4px; background:${githubButtonBg}; transition:background 0.2s;" onmouseover="this.style.background='rgba(102, 179, 255, 0.2)'" onmouseout="this.style.background='${githubButtonBg}'"><svg height="12" viewBox="0 0 24 24" width="12" fill="currentColor"><path d="M12 1C5.923 1 1 5.923 1 12c0 4.867 3.149 8.979 7.521 10.436.55.096.756-.233.756-.522 0-.262-.013-1.128-.013-2.049-2.764.509-3.479-.674-3.699-1.292-.124-.317-.66-1.293-1.127-1.554-.385-.207-.936-.715-.014-.729.866-.014 1.485.797 1.691 1.128.99 1.663 2.571 1.196 3.204.907.096-.715.385-1.196.701-1.471-2.448-.275-5.005-1.224-5.005-5.432 0-1.196.426-2.186 1.128-2.956-.111-.275-.496-1.402.11-2.915 0 0 .921-.288 3.024 1.128a10.193 10.193 0 0 1 2.75-.371c.936 0 1.871.123 2.75.371 2.104-1.43 3.025-1.128 3.025-1.128.605 1.513.221 2.64.111 2.915.701.77 1.127 1.747 1.127 2.956 0 4.222-2.571 5.157-5.019 5.432.399.344.743 1.004.743 2.035 0 1.471-.014 2.654-.014 3.025 0 .289.206.632.756.522C19.851 20.979 23 16.854 23 12c0-6.077-4.922-11-11-11Z"></path></svg> ${JE.t('panel_footer_contribute')}</a>
                </div>
            </div>
            <button id="closeSettingsPanel" style="position:absolute; top:24px; right:24px; background:rgba(255,255,255,0.1); border:none; color:#fff; font-size:16px; cursor:pointer; width:28px; height:28px; border-radius:50%; display:flex; align-items:center; justify-content:center; transition:background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.2)'" onmouseout="this.style.background='rgba(255,255,255,0.1)'">✕</button>
        `;

        document.body.appendChild(help);

        // --- Shortcut Key Binding Logic ---
        if (!JE.pluginConfig.DisableAllShortcuts) {
            const shortcutKeys = help.querySelectorAll('.shortcut-key');
            shortcutKeys.forEach(keyElement => {
                const getOriginalKey = () => JE.state.activeShortcuts[keyElement.dataset.action];

                keyElement.addEventListener('click', () => keyElement.focus());

                keyElement.addEventListener('focus', () => {
                    keyElement.textContent = JE.t('panel_shortcuts_listening');
                    keyElement.style.borderColor = primaryAccentColor;
                    keyElement.style.width = '100px';
                });

                keyElement.addEventListener('blur', () => {
                    keyElement.textContent = getOriginalKey();
                    keyElement.style.borderColor = 'transparent';
                    keyElement.style.width = 'auto';
                });

                keyElement.addEventListener('keydown', (e) => {
                    e.preventDefault();
                    e.stopPropagation();

                    const labelWrapper = keyElement.nextElementSibling;

                    if (e.key === 'Backspace') {
                        const action = keyElement.dataset.action;

                        // Load, modify, and save the user's custom shortcuts
                        const userShortcuts = JE.userShortcutManager.load();
                        delete userShortcuts[action];
                        JE.userShortcutManager.save(userShortcuts);

                        // Find the original server default key from the plugin's configuration
                        const defaultConfig = JE.pluginConfig.Shortcuts.find(s => s.Name === action);
                        const defaultKey = defaultConfig ? defaultConfig.Key : '';

                        // Update the active shortcuts in memory and what's shown on screen
                        JE.state.activeShortcuts[action] = defaultKey;
                        keyElement.textContent = defaultKey;
                        const indicator = labelWrapper.querySelector('.modified-indicator');
                        if (indicator) {
                            indicator.remove();
                        }
                        keyElement.blur(); // Exit the "Listening..." mode
                        return;
                    }

                    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) {
                        return; // Don't allow setting only a modifier key
                    }

                    const combo = (e.metaKey ? 'Meta+' : '') + (e.ctrlKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey ? 'Shift+' : '') + (e.key.match(/^[a-zA-Z]$/) ? e.key.toUpperCase() : e.key);
                    const action = keyElement.dataset.action;
                    const existingAction = Object.keys(JE.state.activeShortcuts).find(name => JE.state.activeShortcuts[name] === combo);
                    if (existingAction && existingAction !== action) {
                        keyElement.style.background = 'rgb(255 0 0 / 60%)';
                        keyElement.classList.add('shake-error');
                        setTimeout(() => {
                            keyElement.classList.remove('shake-error');
                            if (document.activeElement === keyElement) {
                                keyElement.style.background = kbdBackground;
                            }
                        }, 500);
                            // Reject the new keybinding and stop the function
                        return;
                    }
                    // Save the new shortcut
                    const userShortcuts = JE.userShortcutManager.load();
                    userShortcuts[action] = combo;
                    JE.userShortcutManager.save(userShortcuts);

                    // Update active shortcuts
                    JE.state.activeShortcuts[action] = combo;

                    // Update the UI and exit edit mode
                    keyElement.textContent = combo;
                    if (labelWrapper && !labelWrapper.querySelector('.modified-indicator')) {
                        const indicator = document.createElement('span');
                        indicator.className = 'modified-indicator';
                        indicator.title = 'Modified by user';
                        indicator.style.cssText = `color:${primaryAccentColor}; font-size: 20px; line-height: 1;`;
                        indicator.textContent = '•';
                        labelWrapper.prepend(indicator);
                    }
                    keyElement.blur(); // Triggers the blur event to clean up styles
                });
            });
        }
        resetAutoCloseTimer();

        // --- Tab Logic ---
        const tabButtons = help.querySelectorAll('.tab-button');
        const tabContents = help.querySelectorAll('.tab-content');
        const tabsContainer = help.querySelector('.tabs');

        if (JE.pluginConfig.DisableAllShortcuts) {
            // If shortcuts are disabled, hide the tab bar and show settings directly.
            if (tabsContainer) {
                tabsContainer.style.display = 'none';
            }
            const settingsContent = help.querySelector('#settings-content');
            if (settingsContent) {
                settingsContent.classList.add('active');
            }
        } else {
            // --- Remember last opened tab ---
            const lastTab = JE.currentSettings.lastOpenedTab || 'shortcuts';
            tabButtons.forEach(btn => btn.classList.remove('active'));
            tabContents.forEach(content => content.classList.remove('active'));
            const activeTabButton = help.querySelector(`.tab-button[data-tab="${lastTab}"]`);
            if(activeTabButton) activeTabButton.classList.add('active');
            const activeTabContent = help.querySelector(`#${lastTab}-content`);
            if(activeTabContent) activeTabContent.classList.add('active');

            tabButtons.forEach(button => {
                button.addEventListener('click', () => {
                    const tab = button.dataset.tab;
                    tabButtons.forEach(btn => btn.classList.remove('active'));
                    button.classList.add('active');
                    tabContents.forEach(content => {
                        content.classList.remove('active');
                        if (content.id === `${tab}-content`) {
                            content.classList.add('active');
                        }
                    });
                    JE.currentSettings.lastOpenedTab = tab;
                    JE.saveSettings(JE.currentSettings);
                    resetAutoCloseTimer();
                });
            });
        }

        // Autoscroll when details sections open
        const allDetails = help.querySelectorAll('details');
        allDetails.forEach((details, index) => {
            details.addEventListener('toggle', () => {
                if (details.open) {
                    setTimeout(() => {
                        details.scrollIntoView({ behavior: 'smooth', block: index === 0 ? 'center' : 'nearest' });
                    }, 150);
                }
                resetAutoCloseTimer();
            });
        });

        // --- Event Handlers for Settings Panel ---
        const closeHelp = (ev) => {
            if ((ev.type === 'keydown' && (ev.key === 'Escape' || ev.key === '?')) || (ev.type === 'click' && ev.target.id === 'closeSettingsPanel')) {
                ev.stopPropagation();
                if (autoCloseTimer) clearTimeout(autoCloseTimer);
                help.remove();
                document.removeEventListener('keydown', closeHelp);
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
                if (!JE.pluginConfig.DisableAllShortcuts) {
                    document.addEventListener('keydown', JE.keyListener);
                }
            }
        };

        const createToast = (featureKey, isEnabled) => {
            const feature = JE.t(featureKey);
            const status = JE.t(isEnabled ? 'status_enabled' : 'status_disabled');
            return JE.t('toast_feature_status', { feature, status });
        };
        document.addEventListener('keydown', closeHelp);
        document.getElementById('closeSettingsPanel').addEventListener('click', closeHelp);

        if (!JE.pluginConfig.DisableAllShortcuts) {
            document.removeEventListener('keydown', JE.keyListener);
        }

        document.getElementById('autoPauseToggle').addEventListener('change', (e) => { JE.currentSettings.autoPauseEnabled = e.target.checked; JE.saveSettings(JE.currentSettings); JE.toast(createToast('feature_auto_pause', e.target.checked)); resetAutoCloseTimer(); });
        document.getElementById('autoResumeToggle').addEventListener('change', (e) => { JE.currentSettings.autoResumeEnabled = e.target.checked; JE.saveSettings(JE.currentSettings); JE.toast(createToast('feature_auto_resume', e.target.checked)); resetAutoCloseTimer(); });
        document.getElementById('autoPipToggle').addEventListener('change', (e) => { JE.currentSettings.autoPipEnabled = e.target.checked; JE.saveSettings(JE.currentSettings); JE.toast(createToast('feature_auto_pip', e.target.checked)); resetAutoCloseTimer(); });
        document.getElementById('autoSkipIntroToggle').addEventListener('change', (e) => { JE.currentSettings.autoSkipIntro = e.target.checked; JE.saveSettings(JE.currentSettings); JE.toast(createToast('feature_auto_skip_intro', e.target.checked)); resetAutoCloseTimer(); });
        document.getElementById('autoSkipOutroToggle').addEventListener('change', (e) => { JE.currentSettings.autoSkipOutro = e.target.checked; JE.saveSettings(JE.currentSettings); JE.toast(createToast('feature_auto_skip_outro', e.target.checked)); resetAutoCloseTimer(); });
        document.getElementById('randomButtonToggle').addEventListener('change', (e) => { JE.currentSettings.randomButtonEnabled = e.target.checked; JE.saveSettings(JE.currentSettings); JE.toast(createToast('feature_random_button', e.target.checked)); JE.addRandomButton(); resetAutoCloseTimer(); });
        document.getElementById('randomUnwatchedOnly').addEventListener('change', (e) => { JE.currentSettings.randomUnwatchedOnly = e.target.checked; JE.saveSettings(JE.currentSettings); JE.toast(createToast('feature_unwatched_only', e.target.checked)); resetAutoCloseTimer(); });
        document.getElementById('randomIncludeMovies').addEventListener('change', (e) => { if (!e.target.checked && !document.getElementById('randomIncludeShows').checked) { e.target.checked = true; JE.toast(JE.t('toast_at_least_one_item_type')); return; } JE.currentSettings.randomIncludeMovies = e.target.checked; JE.saveSettings(JE.currentSettings); JE.toast(JE.t('toast_random_selection_status', { item_type: 'Movies', status: e.target.checked ? JE.t('selection_included') : JE.t('selection_excluded') })); resetAutoCloseTimer(); });
        document.getElementById('randomIncludeShows').addEventListener('change', (e) => { if (!e.target.checked && !document.getElementById('randomIncludeMovies').checked) { e.target.checked = true; JE.toast(JE.t('toast_at_least_one_item_type')); return; } JE.currentSettings.randomIncludeShows = e.target.checked; JE.saveSettings(JE.currentSettings); JE.toast(JE.t('toast_random_selection_status', { item_type: 'Shows', status: e.target.checked ? JE.t('selection_included') : JE.t('selection_excluded') })); resetAutoCloseTimer(); });
        document.getElementById('releaseNotesBtn').addEventListener('click', async () => { await showReleaseNotesNotification(); resetAutoCloseTimer(); });
        document.getElementById('showFileSizesToggle').addEventListener('change', (e) => { JE.currentSettings.showFileSizes = e.target.checked; JE.saveSettings(JE.currentSettings); JE.toast(createToast('feature_file_size_display', e.target.checked)); if (!e.target.checked) { document.querySelectorAll('.mediaInfoItem-fileSize').forEach(el => el.remove()); } resetAutoCloseTimer(); });
        document.getElementById('showAudioLanguagesToggle').addEventListener('change', (e) => { JE.currentSettings.showAudioLanguages = e.target.checked; JE.saveSettings(JE.currentSettings); JE.toast(createToast('feature_audio_language_display', e.target.checked)); if (!e.target.checked) { document.querySelectorAll('.mediaInfoItem-audioLanguage').forEach(el => el.remove()); } else { JE.runLanguageCheck(); } resetAutoCloseTimer(); });
        document.getElementById('removeContinueWatchingToggle').addEventListener('change', (e) => { JE.currentSettings.removeContinueWatchingEnabled = e.target.checked; JE.saveSettings(JE.currentSettings); JE.toast(createToast('feature_remove_continue_watching', e.target.checked)); resetAutoCloseTimer(); });
        document.getElementById('qualityTagsToggle').addEventListener('change', (e) => { JE.currentSettings.qualityTagsEnabled = e.target.checked; JE.saveSettings(JE.currentSettings); JE.toast(`${createToast('feature_quality_tags', e.target.checked)}.<br> Refresh page to apply.`); resetAutoCloseTimer(); });
        document.getElementById('genreTagsToggle').addEventListener('change', (e) => { JE.currentSettings.genreTagsEnabled = e.target.checked; JE.saveSettings(JE.currentSettings); JE.toast(`${createToast('feature_genre_tags', e.target.checked)}.<br> Refresh page to apply.`); if (!e.target.checked) { document.querySelectorAll('.genre-overlay-container').forEach(el => el.remove()); } resetAutoCloseTimer(); });
        document.getElementById('pauseScreenToggle').addEventListener('change', (e) => { JE.currentSettings.pauseScreenEnabled = e.target.checked; JE.saveSettings(JE.currentSettings); JE.toast(`${createToast('feature_custom_pause_screen', e.target.checked)}.<br> Refresh page to apply.`); resetAutoCloseTimer(); });
        document.getElementById('disableCustomSubtitleStyles').addEventListener('change', (e) => { JE.currentSettings.disableCustomSubtitleStyles = e.target.checked; JE.saveSettings(JE.currentSettings); JE.toast(createToast('feature_disable_custom_subtitle_styles', e.target.checked)); JE.applySavedStylesWhenReady(); resetAutoCloseTimer(); });

        const setupPresetHandlers = (containerId, presets, type) => {
            const container = document.getElementById(containerId);
            if (!container) return;

            container.addEventListener('click', (e) => {
                const presetBox = e.target.closest(`.${type}-preset`);
                if (!presetBox) return;

                const presetIndex = parseInt(presetBox.dataset.presetIndex, 10);
                const selectedPreset = presets[presetIndex];

                if (selectedPreset) {
                    if (type === 'style') {
                        JE.currentSettings.selectedStylePresetIndex = presetIndex;
                        const fontSizeIndex = JE.currentSettings.selectedFontSizePresetIndex ?? 2;
                        const fontFamilyIndex = JE.currentSettings.selectedFontFamilyPresetIndex ?? 0;
                        const fontSize = JE.fontSizePresets[fontSizeIndex].size;
                        const fontFamily = JE.fontFamilyPresets[fontFamilyIndex].family;
                        JE.applySubtitleStyles(selectedPreset.textColor, selectedPreset.bgColor, fontSize, fontFamily, selectedPreset.textShadow);
                        JE.toast(JE.t('toast_subtitle_style', { style: selectedPreset.name }));
                    } else if (type === 'font-size') {
                        JE.currentSettings.selectedFontSizePresetIndex = presetIndex;
                        const styleIndex = JE.currentSettings.selectedStylePresetIndex ?? 0;
                        const fontFamilyIndex = JE.currentSettings.selectedFontFamilyPresetIndex ?? 0;
                        const stylePreset = JE.subtitlePresets[styleIndex];
                        const fontFamily = JE.fontFamilyPresets[fontFamilyIndex].family;
                        JE.applySubtitleStyles(stylePreset.textColor, stylePreset.bgColor, selectedPreset.size, fontFamily, stylePreset.textShadow);
                        JE.toast(JE.t('toast_subtitle_size', { size: selectedPreset.name }));
                    } else if (type === 'font-family') {
                        JE.currentSettings.selectedFontFamilyPresetIndex = presetIndex;
                        const styleIndex = JE.currentSettings.selectedStylePresetIndex ?? 0;
                        const fontSizeIndex = JE.currentSettings.selectedFontSizePresetIndex ?? 2;
                        const stylePreset = JE.subtitlePresets[styleIndex];
                        const fontSize = JE.fontSizePresets[fontSizeIndex].size;
                        JE.applySubtitleStyles(stylePreset.textColor, stylePreset.bgColor, fontSize, selectedPreset.family, stylePreset.textShadow);
                        JE.toast(JE.t('toast_subtitle_font', { font: selectedPreset.name }));
                    }

                    JE.saveSettings(JE.currentSettings);
                    container.querySelectorAll('.preset-box').forEach(box => {
                        box.style.border = '2px solid transparent';
                    });
                    presetBox.style.border = `2px solid ${primaryAccentColor}`;
                    resetAutoCloseTimer();
                }
            });

            let currentIndex;
            if (type === 'style') {
                currentIndex = JE.currentSettings.selectedStylePresetIndex ?? 0;
            } else if (type === 'font-size') {
                currentIndex = JE.currentSettings.selectedFontSizePresetIndex ?? 2;
            } else if (type === 'font-family') {
                currentIndex = JE.currentSettings.selectedFontFamilyPresetIndex ?? 0;
            }

            const activeBox = container.querySelector(`[data-preset-index="${currentIndex}"]`);
            if (activeBox) {
                activeBox.style.border = `2px solid ${primaryAccentColor}`;
            }
        };

        setupPresetHandlers('subtitle-style-presets-container', JE.subtitlePresets, 'style');
        setupPresetHandlers('font-size-presets-container', JE.fontSizePresets, 'font-size');
        setupPresetHandlers('font-family-presets-container', JE.fontFamilyPresets, 'font-family');
    };

})(window.JellyfinEnhanced);