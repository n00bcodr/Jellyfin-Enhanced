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
        // Use the theme system to get appropriate colors
        const themeVars = JE.themer?.getThemeVariables() || {};
        const toastBg = themeVars.secondaryBg || 'linear-gradient(135deg, rgba(0,0,0,0.9), rgba(40,40,40,0.9))';
        const toastBorder = `1px solid ${themeVars.primaryAccent || 'rgba(255,255,255,0.1)'}`;
        const blurValue = themeVars.blur || '30px';

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
            backdropFilter: `blur(${blurValue})`,
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
                notification.style.transform = 'translateY(-50%) translateX(100%)';
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

        // Get styles from themer
        const themeVars = JE.themer?.getThemeVariables() || {};
        const panelBg = themeVars.panelBg;
        const panelBorder = `1px solid ${themeVars.primaryAccent}`;
        const textColor = themeVars.textColor;

        Object.assign(notification.style, {
            position: 'fixed',
            top: '50%',
            right: '20px',
            transform: 'translateY(-50%) translateX(100%)',
            background: panelBg,
            color: textColor,
            padding: '0',
            borderRadius: '12px',
            zIndex: 999999,
            fontSize: '14px',
            fontWeight: '500',
            boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
            backdropFilter: `blur(50px)`,
            border: panelBorder,
            width: '600px',
            maxWidth: '90vw',
            maxHeight: '85vh',
            transition: 'transform 0.3s ease-out',
            fontFamily: 'inherit',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden'
        });

        const markdownToHtml = (text) => {
            if (!text) return '';
            return text
                // Blockquotes with callouts (WARNING, NOTE, etc.)
                .replace(/^>\s*\[!(WARNING|NOTE|TIP|IMPORTANT)\]\s*\r?\n((?:>.*(?:\r?\n|$))+)/gm, (match, type, content) => {
                    const noteContent = content.replace(/^>\s?/gm, '');
                    const colors = {
                        WARNING: { border: '#f0ad4e', bg: 'rgba(240, 173, 78, 0.1)', icon: '⚠️' },
                        NOTE: { border: '#00a4dc', bg: 'rgba(0, 164, 220, 0.1)', icon: '📝' },
                        TIP: { border: '#28a745', bg: 'rgba(40, 167, 69, 0.1)', icon: '💡' },
                        IMPORTANT: { border: '#dc3545', bg: 'rgba(220, 53, 69, 0.1)', icon: '❗' }
                    };
                    const style = colors[type] || colors.NOTE;
                    return `<div style="padding: 12px 16px; border-left: 4px solid ${style.border}; background-color: ${style.bg}; margin: 12px 0; border-radius: 4px;"><strong>${style.icon} ${type}:</strong><br>${noteContent}</div>`;
                })
                // Headings (with better spacing)
                .replace(/^### (.*$)/gm, '<h4 style="font-size: 1.1em; margin: 1em 0 0 0; font-weight: 600; color: rgba(255,255,255,0.9);">$1</h4>')
                .replace(/^## (.*$)/gm, '<h3 style="font-size: 1.25em; margin: 1.2em 0 0 0; font-weight: 600; color: rgba(255,255,255,0.95);">$1</h3>')
                .replace(/^# (.*$)/gm, '<h2 style="font-size: 1.4em; margin: 1.2em 0 0 0; font-weight: 700;">$1</h2>')
                // Code blocks (inline)
                .replace(/`([^`]+)`/g, '<code style="background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 3px; font-family: monospace; font-size: 0.9em;">$1</code>')
                // Links
                .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" style="color: var(--primary-accent-color, #00a4dc); text-decoration: underline; text-decoration-color: rgba(0, 164, 220, 0.3);">$1</a>')
                // Bold and Italic
                .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
                .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                .replace(/\*(.+?)\*/g, '<em>$1</em>')
                // Numbered lists
                .replace(/^\d+\.\s+(.*)$/gm, (match, item) => `<ol style="margin: 0; padding-left: 20px;"><li style="margin: 4px 0;">${item}</li></ol>`)
                .replace(/<\/ol>\s*<ol[^>]*>/g, '') // Merge adjacent numbered lists
                // Bullet lists
                .replace(/^[-*]\s+(.*)$/gm, (match, item) => `<ul style="margin: 0; padding-left: 20px;"><li style="margin: 4px 0;">${item}</li></ul>`)
                .replace(/<\/ul>\s*<ul[^>]*>/g, '') // Merge adjacent lists
                // Handle backslash at end of line as line break (markdown line break)
                .replace(/\\\s*\n/g, '<br>')
                // General newlines (double newline - paragraph break, single - line break)
                .replace(/\n\n+/g, '<br><br>')
                .replace(/\n/g, '<br>')
                // Collapse excessive line breaks (max 2)
                .replace(/(<br>\s*){3,}/g, '<br><br>');
        };

        const releaseNotes = release.body ?
            (release.body.length > 3000 ? release.body.substring(0, 3000) + '...' : release.body) :
            'No release notes available.';

        notification.innerHTML = `
            <div style="padding: 20px; border-bottom: 1px solid rgba(255,255,255,0.1); flex-shrink: 0;">
                <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 8px;">
                    <div style="width: 40px; height: 40px; background: #3e74f2bd; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 18px;">📋</div>
                    <div style="flex: 1;">
                        <div style="font-weight: 600; font-size: 16px; color: #779aeadc;">Latest Release Notes</div>
                        <div style="font-size: 12px; color: rgba(255,255,255,0.7);">${release.tag_name} - ${new Date(release.published_at).toLocaleDateString()}</div>
                    </div>
                    <button onclick="this.closest('#jellyfin-release-notes-notification').remove()" style="background: rgba(255,255,255,0.1); border: none; color: #fff; font-size: 20px; cursor: pointer; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; transition: background 0.2s; flex-shrink: 0;" onmouseover="this.style.background='rgba(255,255,255,0.2)'" onmouseout="this.style.background='rgba(255,255,255,0.1)'">×</button>
                </div>
            </div>
            <div style="flex: 1; overflow-y: auto; padding: 20px; font-size: 13px; color: rgba(255,255,255,0.85); line-height: 1.6;">
                ${markdownToHtml(releaseNotes)}
            </div>
            <div style="padding: 16px 20px; border-top: 1px solid rgba(255,255,255,0.1); display: flex; gap: 10px; flex-shrink: 0; background: rgba(0,0,0,0.2);">
                <a href="${release.html_url}" target="_blank" style="flex: 1; background: #3e74f2bd; border: 1px solid #779aeadc; color: white; text-decoration: none; padding: 10px 16px; border-radius: 6px; font-size: 13px; font-weight: 500; text-align: center; transition: background 0.2s;" onmouseover="this.style.background='#5284f3'" onmouseout="this.style.background='#3e74f2bd'">View Full Release on GitHub</a>
                <button onclick="this.closest('#jellyfin-release-notes-notification').remove()" style="background: #f25151b5; border: 1px solid #f2515133; color: white; padding: 10px 16px; border-radius: 6px; font-size: 13px; font-family: inherit; font-weight: 500; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#f36161'" onmouseout="this.style.background='#f25151b5'">Close</button>
            </div>
        `;

        document.body.appendChild(notification);
        setTimeout(() => { notification.style.transform = 'translateY(-50%) translateX(0)'; }, 10);

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
            @font-face {
              font-family: 'Material Symbols Rounded';
              font-style: normal;
              font-weight: 400;
              src: url(https://fonts.gstatic.com/s/materialsymbolsrounded/v258/syl0-zNym6YjUruM-QrEh7-nyTnjDwKNJ_190FjpZIvDmUSVOK7BDB_Qb9vUSzq3wzLK-P0J-V_Zs-QtQth3-jOcbTCVpeRL2w5rwZu2rIelXxc.woff2) format('woff2');
            }
            .mediaInfoItem-fileSize .material-icons,
            .mediaInfoItem-watchProgress .material-icons,
            .mediaInfoItem-audioLanguage .material-icons {
              font-family: 'Material Symbols Rounded' !important;
              line-height: 1;
              letter-spacing: normal;
              text-transform: none;
              display: inline-block;
              white-space: nowrap;
              word-wrap: normal;
              direction: ltr;
              -webkit-font-feature-settings: 'liga';
              -webkit-font-smoothing: antialiased;
            }
            .jellyseerr-issue-radio-group {
              display: flex;
              justify-content: center;
              flex-wrap: wrap;
              gap: 12px;
              margin-top: 12px;
            }
            .jellyseerr-radio-label {
                display: inline-flex;
                align-items: center;
                gap: 8px;
                cursor: pointer;
                position: relative;
            }
            .jellyseerr-radio-input {
                position: absolute;
                opacity: 0;
                width: 1px;
                height: 1px;
                margin: 0;
                padding: 0;
                clip: rect(0 0 0 0);
                border: 0;
            }
            .jellyseerr-radio-option {
                padding: 8px 12px;
                border-radius: 6px;
                border: 2px solid rgba(255,255,255,0.2);
                background-color: rgba(255,255,255,0.05);
                transition: all 0.2s ease;
                user-select: none;
                font-weight: 500;
                display: inline-flex;
                align-items: center;
            }
            .jellyseerr-radio-input:checked + .jellyseerr-radio-option {
                border-color: var(--primary-accent-color, #1e88e5);
                background-color: var(--primary-accent-color, #1e88e5);
                color: white;
            }
            .jellyseerr-radio-input:focus + .jellyseerr-radio-option {
                box-shadow: 0 0 0 4px rgba(30,136,229,0.12);
                outline: none;
            }
            .jellyseerr-radio-input:hover + .jellyseerr-radio-option {
                border-color: var(--primary-accent-color, #1e88e5);
                background-color: rgba(30,136,229,0.1);
            }
            .jellyseerr-issue-textarea {
              max-width: 96%;
              box-sizing: border-box;
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
     * Injects the "Jellyfin Enhanced" link into the user preferences menu (mypreferencesmenu.html).
     * Adds it as the last item in the first vertical section (after Controls).
     */
    JE.addUserPreferencesLink = () => {
        const addLinkToMenu = () => {
            const menuContainer = document.querySelector('#myPreferencesMenuPage:not(.hide) .verticalSection');
            if (!menuContainer) return false;

            // Check if link already exists
            if (document.querySelector('#jellyfinEnhancedUserPrefsLink')) return true;

            // Create the link element matching Jellyfin's structure
            const enhancedLink = document.createElement('a');
            enhancedLink.id = 'jellyfinEnhancedUserPrefsLink';
            enhancedLink.setAttribute('is', 'emby-linkbutton');
            enhancedLink.setAttribute('data-ripple', 'false');
            enhancedLink.href = '#';
            enhancedLink.className = 'listItem-border emby-button';
            enhancedLink.style.display = 'block';
            enhancedLink.style.padding = '0';
            enhancedLink.style.margin = '0';

            enhancedLink.innerHTML = `
                <div class="listItem">
                    <span class="material-icons listItemIcon listItemIcon-transparent tune" aria-hidden="true"></span>
                    <div class="listItemBody">
                        <div class="listItemBodyText">Advanced Settings (Jellyfin Enhanced)</div>
                    </div>
                </div>
            `;

            enhancedLink.addEventListener('click', (e) => {
                e.preventDefault();
                JE.showEnhancedPanel();
            });

            // Insert at the end of the first vertical section
            menuContainer.appendChild(enhancedLink);
            return true;
        };

        // Try to add immediately
        if (addLinkToMenu()) return;

        // If not found, observe for when the menu is loaded and visible
        const observer = new MutationObserver(() => {
            if (addLinkToMenu()) {
                observer.disconnect();
            }
        });

        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
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
        // Get theme-appropriate styles
        const themeVars = JE.themer.getThemeVariables();
        const currentTheme = JE.themer.activeTheme;

        // Define theme-aware variables
        const panelBgColor = themeVars.panelBg;
        const secondaryBg = themeVars.secondaryBg;
        const headerFooterBg = themeVars.secondaryBg;
        const detailsBackground = themeVars.secondaryBg;
        const primaryAccentColor = themeVars.primaryAccent;
        const toggleAccentColor = primaryAccentColor;
        const kbdBackground = themeVars.altAccent;
        const presetBoxBackground = themeVars.altAccent;
        const panelBlurValue = themeVars.blur;
        const githubButtonBg = `rgba(102, 179, 255, 0.1)`;
        const releaseNotesBg = primaryAccentColor;
        const checkUpdatesBorder = `1px solid ${primaryAccentColor}`;
        const releaseNotesTextColor = themeVars.textColor;
        const logoUrl = themeVars.logo;

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

        const pluginShortcuts = Array.isArray(JE.pluginConfig.Shortcuts) ? JE.pluginConfig.Shortcuts : [];
        const shortcuts = pluginShortcuts.reduce((acc, s) => ({ ...acc, [s.Name]: s }), {});

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

        const userShortcuts = (JE.userConfig.shortcuts.Shortcuts || []).reduce((acc, s) => {
            acc[s.Name] = s;
            return acc;
        }, {});

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
                                ${['CycleAspectRatio', 'ShowPlaybackInfo', 'SubtitleMenu', 'CycleSubtitleTracks', 'CycleAudioTracks', 'IncreasePlaybackSpeed', 'DecreasePlaybackSpeed', 'ResetPlaybackSpeed', 'BookmarkCurrentTime', 'OpenEpisodePreview'].map(action => `
                                    <div style="display: flex; justify-content: space-between; align-items: center;">
                                        <span class="shortcut-key" tabindex="0" data-action="${action}" style="background:${kbdBackground}; padding:2px 8px; border-radius:3px; cursor:pointer; transition: all 0.2s;">${JE.state.activeShortcuts[action]}</span>
                                        <div style="display: flex; align-items: center; gap: 8px;">
                                            ${userShortcuts.hasOwnProperty(action) ? `<span class="modified-indicator" title="Modified by user" style="color:${primaryAccentColor}; font-size: 20px; line-height: 1;">•</span>` : ''}
                                            <span>${JE.t('shortcut_' + action)}${action === 'OpenEpisodePreview' ? ' <span style="font-size: 11px; opacity: 0.7;" title="Requires InPlayerEpisodePreview plugin from https://github.com/Namo2/InPlayerEpisodePreview/">ⓘ</span>' : ''}</span>
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
                        <summary style="padding: 16px; font-weight: 600; color: ${primaryAccentColor}; cursor: pointer; user-select: none; font-family: inherit;">${JE.icon(JE.IconName.PLAYBACK)} ${JE.t('panel_settings_playback')}</summary>
                        <div style="padding: 0 16px 16px 16px;">
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="autoPauseToggle" ${JE.currentSettings.autoPauseEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JE.t('panel_settings_auto_pause')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_auto_pause_desc')}</div></div>
                                </label>
                            </div>
                           <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="autoResumeToggle" ${JE.currentSettings.autoResumeEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JE.t('panel_settings_auto_resume')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_auto_resume_desc')}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="autoPipToggle" ${JE.currentSettings.autoPipEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JE.t('panel_settings_auto_pip')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_auto_pip_desc')}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="longPress2xEnabled" ${JE.currentSettings.longPress2xEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JE.t('panel_settings_long_press_2x_speed')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_long_press_desc')}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="pauseScreenToggle" ${JE.currentSettings.pauseScreenEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JE.t('panel_settings_custom_pause_screen')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_custom_pause_screen_desc')}</div></div>
                                </label>
                            </div>
                        </div>
                    </details>
                    <details style="margin-bottom: 16px; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; background: ${detailsBackground};">
                        <summary style="padding: 16px; font-weight: 600; color: ${primaryAccentColor}; cursor: pointer; user-select: none; font-family: inherit;">${JE.icon(JE.IconName.SKIP)} ${JE.t('panel_settings_auto_skip')}</summary>
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
                        <summary style="padding: 16px; font-weight: 600; color: ${primaryAccentColor}; cursor: pointer; user-select: none; font-family: inherit;">${JE.icon(JE.IconName.SUBTITLES)} ${JE.t('panel_settings_subtitles')}</summary>
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
                        <summary style="padding: 16px; font-weight: 600; color: ${primaryAccentColor}; cursor: pointer; user-select: none; font-family: inherit;">${JE.icon(JE.IconName.RANDOM)} ${JE.t('panel_settings_random_button')}</summary>
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
                        <summary style="padding: 16px; font-weight: 600; color: ${primaryAccentColor}; cursor: pointer; user-select: none; font-family: inherit;">${JE.icon(JE.IconName.UI)} ${JE.t('panel_settings_ui')}</summary>
                        <div style="padding: 0 16px 16px 16px;">
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="showWatchProgressToggle" ${JE.currentSettings.showWatchProgress ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JE.t('panel_settings_ui_watch_progress')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_ui_watch_progress_desc')}</div></div>
                                </label>
                            </div>
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
                                <label style="display: flex; align-items: center; justify-content: space-between; cursor: pointer;">
                                    <div style="display: flex; align-items: center; gap: 12px;">
                                        <input type="checkbox" id="qualityTagsToggle" ${JE.currentSettings.qualityTagsEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500;">${JE.t('panel_settings_ui_quality_tags')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_ui_quality_tags_desc')}</div></div>
                                    </div>
                                    <div class="position-selector" data-setting="qualityTagsPosition" style="display:grid; grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr; gap:2px; width:32px; height:32px; border:1px solid rgba(255,255,255,0.3); border-radius:4px; padding:3px; cursor:pointer; flex-shrink:0;" title="Click to change position">
                                        <div data-pos="top-left" style="border-radius:2px; transition:background 0.2s;"></div>
                                        <div data-pos="top-right" style="border-radius:2px; transition:background 0.2s;"></div>
                                        <div data-pos="bottom-left" style="border-radius:2px; transition:background 0.2s;"></div>
                                        <div data-pos="bottom-right" style="border-radius:2px; transition:background 0.2s;"></div>
                                    </div>
                                </label>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; justify-content: space-between; cursor: pointer;">
                                    <div style="display: flex; align-items: center; gap: 12px;">
                                        <input type="checkbox" id="genreTagsToggle" ${JE.currentSettings.genreTagsEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500;">${JE.t('panel_settings_ui_genre_tags')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_ui_genre_tags_desc')}</div></div>
                                    </div>
                                    <div class="position-selector" data-setting="genreTagsPosition" style="display:grid; grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr; gap:2px; width:32px; height:32px; border:1px solid rgba(255,255,255,0.3); border-radius:4px; padding:3px; cursor:pointer; flex-shrink:0;" title="Click to change position">
                                        <div data-pos="top-left" style="border-radius:2px; transition:background 0.2s;"></div>
                                        <div data-pos="top-right" style="border-radius:2px; transition:background 0.2s;"></div>
                                        <div data-pos="bottom-left" style="border-radius:2px; transition:background 0.2s;"></div>
                                        <div data-pos="bottom-right" style="border-radius:2px; transition:background 0.2s;"></div>
                                    </div>
                                </label>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; justify-content: space-between; cursor: pointer;">
                                    <div style="display: flex; align-items: center; gap: 12px;">
                                        <input type="checkbox" id="languageTagsToggle" ${JE.currentSettings.languageTagsEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500;">${JE.t('panel_settings_ui_language_tags')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_ui_language_tags_desc')}</div></div>
                                    </div>
                                    <div class="position-selector" data-setting="languageTagsPosition" style="display:grid; grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr; gap:2px; width:32px; height:32px; border:1px solid rgba(255,255,255,0.3); border-radius:4px; padding:3px; cursor:pointer; flex-shrink:0;" title="Click to change position">
                                        <div data-pos="top-left" style="border-radius:2px; transition:background 0.2s;"></div>
                                        <div data-pos="top-right" style="border-radius:2px; transition:background 0.2s;"></div>
                                        <div data-pos="bottom-left" style="border-radius:2px; transition:background 0.2s;"></div>
                                        <div data-pos="bottom-right" style="border-radius:2px; transition:background 0.2s;"></div>
                                    </div>
                                </label>
                            </div>
                                <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                    <label style="display: flex; align-items: center; justify-content: space-between; cursor: pointer;">
                                        <div style="display: flex; align-items: center; gap: 12px;">
                                            <input type="checkbox" id="ratingTagsToggle" ${JE.currentSettings.ratingTagsEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                            <div><div style="font-weight:500;">${JE.t('panel_settings_ui_rating_tags')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JE.t('panel_settings_ui_rating_tags_desc')}</div></div>
                                        </div>
                                        <div class="position-selector" data-setting="ratingTagsPosition" style="display:grid; grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr; gap:2px; width:32px; height:32px; border:1px solid rgba(255,255,255,0.3); border-radius:4px; padding:3px; cursor:pointer; flex-shrink:0;" title="Click to change position">
                                            <div data-pos="top-left" style="border-radius:2px; transition:background 0.2s;"></div>
                                            <div data-pos="top-right" style="border-radius:2px; transition:background 0.2s;"></div>
                                            <div data-pos="bottom-left" style="border-radius:2px; transition:background 0.2s;"></div>
                                            <div data-pos="bottom-right" style="border-radius:2px; transition:background 0.2s;"></div>
                                        </div>
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
                    <details style="margin-bottom: 16px; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; background: ${detailsBackground};">
                        <summary style="padding: 16px; font-weight: 600; color: ${primaryAccentColor}; cursor: pointer; user-select: none; font-family: inherit;">🌐 ${JE.t('panel_settings_language')}</summary>
                        <div style="padding: 0 16px 16px 16px;">
                            <div style="margin-bottom: 16px;">
                                <div style="font-weight: 600; margin-bottom: 8px;">${JE.t('panel_settings_language_display')}</div>
                                <select id="displayLanguageSelect" style="width: 100%; padding: 12px; background: ${presetBoxBackground}; color: #fff; border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; font-size: 14px; cursor: pointer; font-family: inherit;">
                                    <option value="" style="background: rgba(30,30,30,1); color: #fff;">Auto</option>
                                    <!-- Languages will be populated dynamically -->
                                </select>
                                <div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:8px;">${JE.t('panel_settings_language_display_desc')}</div>
                            </div>
                            <div style="padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <button id="clearTranslationCacheButton" style="width: 100%; padding: 12px; background: ${toggleAccentColor}; color: white; border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; font-family: inherit; transition: opacity 0.2s;" onmouseover="this.style.opacity='0.8'" onmouseout="this.style.opacity='1'">
                                    ${JE.t('panel_settings_language_clear_cache')}
                                </button>
                                <div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:8px;">${JE.t('panel_settings_language_clear_cache_desc')}</div>
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
                    const action = keyElement.dataset.action;

                    if (e.key === 'Backspace') {
                        const defaultConfig = pluginShortcuts.find(s => s.Name === action);
                        const defaultKey = defaultConfig ? defaultConfig.Key : '';

                        const shortcutIndex = JE.userConfig.shortcuts.Shortcuts.findIndex(s => s.Name === action);
                        if (shortcutIndex > -1) {
                            JE.userConfig.shortcuts.Shortcuts.splice(shortcutIndex, 1);
                        }

                        JE.saveUserSettings('shortcuts.json', JE.userConfig.shortcuts);

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

                    // Update or add the shortcut override
                    let userShortcut = JE.userConfig.shortcuts.Shortcuts.find(s => s.Name === action);
                    if (userShortcut) {
                        userShortcut.Key = combo;
                    } else {
                        const defaultConfig = pluginShortcuts.find(s => s.Name === action);
                        JE.userConfig.shortcuts.Shortcuts.push({ ...defaultConfig, Key: combo });
                    }
                    JE.saveUserSettings('shortcuts.json', JE.userConfig.shortcuts);

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
                    JE.saveUserSettings('settings.json', JE.currentSettings);
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

        const addSettingToggleListener = (id, settingKey, featureKey, requiresRefresh = false) => {
            document.getElementById(id).addEventListener('change', (e) => {
                JE.currentSettings[settingKey] = e.target.checked;
                JE.saveUserSettings('settings.json', JE.currentSettings);
                let toastMessage = createToast(featureKey, e.target.checked);

                // Handle tag features with dynamic re-initialization
                if (id === 'qualityTagsToggle') {
                    if (e.target.checked) {
                        // Initialize for the first time if enabling
                        if (typeof JE.initializeQualityTags === 'function') {
                            JE.initializeQualityTags();
                        }
                    } else {
                        // Remove all tags if disabling
                        document.querySelectorAll('.quality-overlay-container').forEach(el => el.remove());
                    }
                    requiresRefresh = false; // No longer needs refresh
                } else if (id === 'genreTagsToggle') {
                    if (e.target.checked) {
                        if (typeof JE.initializeGenreTags === 'function') {
                            JE.initializeGenreTags();
                        }
                    } else {
                        document.querySelectorAll('.genre-overlay-container').forEach(el => el.remove());
                    }
                    requiresRefresh = false;
                } else if (id === 'languageTagsToggle') {
                    if (e.target.checked) {
                        if (typeof JE.initializeLanguageTags === 'function') {
                            JE.initializeLanguageTags();
                        }
                    } else {
                        document.querySelectorAll('.language-overlay-container').forEach(el => el.remove());
                    }
                    requiresRefresh = false;
                } else if (id === 'ratingTagsToggle') {
                    if (e.target.checked) {
                        if (typeof JE.initializeRatingTags === 'function') {
                            JE.initializeRatingTags();
                        }
                    } else {
                        document.querySelectorAll('.rating-overlay-container').forEach(el => el.remove());
                    }
                    requiresRefresh = false;
                }

                if (requiresRefresh) {
                    toastMessage += ".<br> Refresh page to apply.";
                }
                JE.toast(toastMessage);
                if (id === 'randomButtonToggle') JE.addRandomButton();
                if (id === 'showWatchProgressToggle' && !e.target.checked) document.querySelectorAll('.mediaInfoItem-watchProgress').forEach(el => el.remove());
                if (id === 'showFileSizesToggle' && !e.target.checked) document.querySelectorAll('.mediaInfoItem-fileSize').forEach(el => el.remove());
                if (id === 'showAudioLanguagesToggle' && !e.target.checked) document.querySelectorAll('.mediaInfoItem-audioLanguage').forEach(el => el.remove());
                resetAutoCloseTimer();
            });
        };

        addSettingToggleListener('autoPauseToggle', 'autoPauseEnabled', 'feature_auto_pause');
        addSettingToggleListener('autoResumeToggle', 'autoResumeEnabled', 'feature_auto_resume');
        addSettingToggleListener('autoPipToggle', 'autoPipEnabled', 'feature_auto_pip');
        addSettingToggleListener('autoSkipIntroToggle', 'autoSkipIntro', 'feature_auto_skip_intro');
        addSettingToggleListener('autoSkipOutroToggle', 'autoSkipOutro', 'feature_auto_skip_outro');
        addSettingToggleListener('randomButtonToggle', 'randomButtonEnabled', 'feature_random_button');
        addSettingToggleListener('randomUnwatchedOnly', 'randomUnwatchedOnly', 'feature_unwatched_only');
        addSettingToggleListener('showWatchProgressToggle', 'showWatchProgress', 'feature_watch_progress_display');
        addSettingToggleListener('showFileSizesToggle', 'showFileSizes', 'feature_file_size_display');
        addSettingToggleListener('showAudioLanguagesToggle', 'showAudioLanguages', 'feature_audio_language_display');
        addSettingToggleListener('removeContinueWatchingToggle', 'removeContinueWatchingEnabled', 'feature_remove_continue_watching');
        addSettingToggleListener('qualityTagsToggle', 'qualityTagsEnabled', 'feature_quality_tags', true);
        addSettingToggleListener('genreTagsToggle', 'genreTagsEnabled', 'feature_genre_tags', true);
        addSettingToggleListener('pauseScreenToggle', 'pauseScreenEnabled', 'feature_custom_pause_screen', true);
        addSettingToggleListener('languageTagsToggle', 'languageTagsEnabled', 'feature_language_tags', true);
        addSettingToggleListener('ratingTagsToggle', 'ratingTagsEnabled', 'feature_rating_tags', true);
        addSettingToggleListener('disableCustomSubtitleStyles', 'disableCustomSubtitleStyles', 'feature_disable_custom_subtitle_styles', true);
        addSettingToggleListener('longPress2xEnabled', 'longPress2xEnabled', 'feature_long_press_2x_speed');

        document.getElementById('randomIncludeMovies').addEventListener('change', (e) => { if (!e.target.checked && !document.getElementById('randomIncludeShows').checked) { e.target.checked = true; JE.toast(JE.t('toast_at_least_one_item_type')); return; } JE.currentSettings.randomIncludeMovies = e.target.checked; JE.saveUserSettings('settings.json', JE.currentSettings); JE.toast(JE.t('toast_random_selection_status', { item_type: 'Movies', status: e.target.checked ? JE.t('selection_included') : JE.t('selection_excluded') })); resetAutoCloseTimer(); });
        document.getElementById('randomIncludeShows').addEventListener('change', (e) => { if (!e.target.checked && !document.getElementById('randomIncludeMovies').checked) { e.target.checked = true; JE.toast(JE.t('toast_at_least_one_item_type')); return; } JE.currentSettings.randomIncludeShows = e.target.checked; JE.saveUserSettings('settings.json', JE.currentSettings); JE.toast(JE.t('toast_random_selection_status', { item_type: 'Shows', status: e.target.checked ? JE.t('selection_included') : JE.t('selection_excluded') })); resetAutoCloseTimer(); });

        document.getElementById('releaseNotesBtn').addEventListener('click', async () => { await showReleaseNotesNotification(); resetAutoCloseTimer(); });

        // --- Position Selectors ---
        const positionSelectors = help.querySelectorAll('.position-selector');
        positionSelectors.forEach(selector => {
            const settingKey = selector.dataset.setting;
            const cells = selector.querySelectorAll('[data-pos]');

            // Highlight current position
            const updateHighlight = () => {
                const currentPos = JE.currentSettings[settingKey] || 'top-left';
                cells.forEach(cell => {
                    if (cell.dataset.pos === currentPos) {
                        cell.style.background = primaryAccentColor;
                    } else {
                        cell.style.background = 'rgba(255,255,255,0.1)';
                    }
                });
            };
            updateHighlight();

            // Click handler
            selector.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const cell = e.target.closest('[data-pos]');
                if (!cell) return;

                const newPos = cell.dataset.pos;
                JE.currentSettings[settingKey] = newPos;
                JE.saveUserSettings('settings.json', JE.currentSettings);
                updateHighlight();

                // Reinitialize tags dynamically based on which position changed
                if (settingKey === 'qualityTagsPosition' && JE.currentSettings.qualityTagsEnabled) {
                    if (typeof JE.reinitializeQualityTags === 'function') {
                        JE.reinitializeQualityTags();
                    }
                } else if (settingKey === 'genreTagsPosition' && JE.currentSettings.genreTagsEnabled) {
                    if (typeof JE.reinitializeGenreTags === 'function') {
                        JE.reinitializeGenreTags();
                    }
                } else if (settingKey === 'languageTagsPosition' && JE.currentSettings.languageTagsEnabled) {
                    if (typeof JE.reinitializeLanguageTags === 'function') {
                        JE.reinitializeLanguageTags();
                    }
                } else if (settingKey === 'ratingTagsPosition' && JE.currentSettings.ratingTagsEnabled) {
                    if (typeof JE.reinitializeRatingTags === 'function') {
                        JE.reinitializeRatingTags();
                    }
                }

                JE.toast(`Position updated!`);
                resetAutoCloseTimer();
            });
        });

        // --- Language Settings ---
        const displayLanguageSelect = document.getElementById('displayLanguageSelect');
        if (displayLanguageSelect) {
            // Get current user ID for localStorage key
            const userId = ApiClient.getCurrentUserId();
            const languageKey = `${userId}-language`;

            // Get saved language from localStorage as well
            const localStorageLang = localStorage.getItem(languageKey);
            const savedLanguage = JE.currentSettings.displayLanguage || localStorageLang || '';

            console.log('🪼 Jellyfin Enhanced: Current language setting:', {
                fromSettings: JE.currentSettings.displayLanguage,
                fromLocalStorage: localStorageLang,
                willUse: savedLanguage
            });

            // Populate language options from Jellyfin's cultures
            (async () => {
                const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/n00bcodr/Jellyfin-Enhanced/main/Jellyfin.Plugin.JellyfinEnhanced/js/locales';
                const AVAILABLE_LANGUAGES_CACHE_KEY = 'JE_available_languages';
                const AVAILABLE_LANGUAGES_CACHE_TS_KEY = 'JE_available_languages_ts';
                const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

                // Custom languages not in Jellyfin's official culture list
                const CUSTOM_LANGUAGES = {
                    'pr': { Name: 'Pirate', DisplayName: "Pirate", TwoLetterISOLanguageName: 'pr' }
                };

                let supportedJELanguages = [];

                // Try to load from cache first
                const cachedLanguages = localStorage.getItem(AVAILABLE_LANGUAGES_CACHE_KEY);
                const cachedTimestamp = localStorage.getItem(AVAILABLE_LANGUAGES_CACHE_TS_KEY);

                if (cachedLanguages && cachedTimestamp) {
                    const age = Date.now() - parseInt(cachedTimestamp, 10);
                    if (age < CACHE_DURATION) {
                        console.log('🪼 Jellyfin Enhanced: Using cached available languages (age: ' + Math.round(age / 1000 / 60) + ' minutes)');
                        supportedJELanguages = JSON.parse(cachedLanguages);
                    }
                }

                // If no valid cache, fetch from GitHub
                if (supportedJELanguages.length === 0) {
                    // Fetch cultures from Jellyfin API
                    const cultures = await ApiClient.ajax({
                        type: 'GET',
                        url: ApiClient.getUrl('/Localization/Cultures'),
                        dataType: 'json'
                    });

                    console.log('🪼 Jellyfin Enhanced: Loaded', cultures.length, 'cultures from Jellyfin API');

                    // Check which languages have translation files available on GitHub
                    const checkPromises = cultures.map(async (culture) => {
                        const langCode = culture.TwoLetterISOLanguageName;
                        try {
                            const response = await fetch(`${GITHUB_RAW_BASE}/${langCode}.json`, { method: 'HEAD' });
                            if (response.ok) {
                                supportedJELanguages.push(culture);
                                console.log('🪼 Jellyfin Enhanced: Found translation for:', culture.Name, '('+langCode+')');
                            }
                        } catch (err) {
                            // Translation file doesn't exist
                        }
                    });

                    await Promise.all(checkPromises);

                    // Add custom languages that have translation files
                    for (const langCode in CUSTOM_LANGUAGES) {
                        try {
                            const response = await fetch(`${GITHUB_RAW_BASE}/${langCode}.json`, { method: 'HEAD' });
                            if (response.ok) {
                                supportedJELanguages.push(CUSTOM_LANGUAGES[langCode]);
                                console.log('🪼 Jellyfin Enhanced: Found translation for:', CUSTOM_LANGUAGES[langCode].Name, '('+langCode+')');
                            }
                        } catch (err) {
                            // Translation file doesn't exist
                        }
                    }

                    console.log('🪼 Jellyfin Enhanced: Found', supportedJELanguages.length, 'supported cultures with translations');

                    // Cache the results
                    try {
                        localStorage.setItem(AVAILABLE_LANGUAGES_CACHE_KEY, JSON.stringify(supportedJELanguages));
                        localStorage.setItem(AVAILABLE_LANGUAGES_CACHE_TS_KEY, Date.now().toString());
                        console.log('🪼 Jellyfin Enhanced: Cached available languages list');
                    } catch (err) {
                        console.warn('🪼 Jellyfin Enhanced: Failed to cache available languages', err);
                    }
                }

                // Sort by Name
                supportedJELanguages.sort((a, b) => a.Name.localeCompare(b.Name));

                // Add options using TwoLetterISOLanguageName as value and Name as display
                supportedJELanguages.forEach(culture => {
                    const langCode = culture.TwoLetterISOLanguageName;
                    const option = document.createElement('option');
                    option.value = langCode;
                    option.textContent = culture.Name;
                    option.style.background = 'rgba(30,30,30,1)';
                    option.style.color = '#fff';
                    displayLanguageSelect.appendChild(option);
                });

                // Normalize saved language code (e.g., en-GB -> en)
                let normalizedLanguage = '';
                if (savedLanguage) {
                    normalizedLanguage = savedLanguage.split('-')[0].toLowerCase();
                }

                // Set the saved language after options are added
                if (normalizedLanguage) {
                    displayLanguageSelect.value = normalizedLanguage;
                }
                console.log('🪼 Jellyfin Enhanced: Set language dropdown to:', savedLanguage || 'Auto', 'Normalized to:', normalizedLanguage, 'Select element value is now:', displayLanguageSelect.value);
            })();

            // Save language on change
            displayLanguageSelect.addEventListener('change', async (e) => {
                const newLang = e.target.value;

                // Map language codes to full culture codes for localStorage
                let fullCultureCode = newLang;
                if (newLang === 'en') {
                    fullCultureCode = 'en-GB';
                }

                // Check if translation file exists
                let translationExists = true;
                if (newLang) {
                    try {
                        const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/n00bcodr/Jellyfin-Enhanced/main/Jellyfin.Plugin.JellyfinEnhanced/js/locales';
                        const response = await fetch(`${GITHUB_RAW_BASE}/${newLang}.json`, { method: 'HEAD' });
                        translationExists = response.ok;
                    } catch (err) {
                        // Assume it exists if we can't check (offline mode)
                        translationExists = true;
                    }
                }

                // Save to settings.json (use base language code)
                JE.currentSettings.displayLanguage = newLang;
                await JE.saveUserSettings('settings.json', JE.currentSettings);

                // Save to localStorage (use full culture code)
                if (fullCultureCode) {
                    localStorage.setItem(languageKey, fullCultureCode);
                } else {
                    // Set empty value instead of removing key
                    localStorage.setItem(languageKey, '');
                }

                if (newLang && !translationExists) {
                    JE.toast(`⚠️ Translation file not available for selected language. Falling back to English.`);
                } else {
                    JE.toast(JE.t('toast_language_changed'));
                }
                setTimeout(() => window.location.reload(), 1500);
            });
        }

        // Clear translation cache button
        const clearTranslationCacheButton = document.getElementById('clearTranslationCacheButton');
        if (clearTranslationCacheButton) {
            clearTranslationCacheButton.addEventListener('click', () => {
                const cacheKeys = [];
                const CACHE_PREFIX = 'JE_translation_';
                const CACHE_TIMESTAMP_PREFIX = 'JE_translation_ts_';

                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (key && (key.startsWith(CACHE_PREFIX) || key.startsWith(CACHE_TIMESTAMP_PREFIX))) {
                        cacheKeys.push(key);
                    }
                }

                cacheKeys.forEach(key => localStorage.removeItem(key));

                // Also clear language availability cache so new languages are detected
                localStorage.removeItem('JE_available_languages');
                localStorage.removeItem('JE_available_languages_ts');

                JE.toast(JE.t('toast_translation_cache_cleared', { count: cacheKeys.length }));
                setTimeout(() => window.location.reload(), 2000);
                resetAutoCloseTimer();
            });
        }

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

                    JE.saveUserSettings('settings.json', JE.currentSettings);
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