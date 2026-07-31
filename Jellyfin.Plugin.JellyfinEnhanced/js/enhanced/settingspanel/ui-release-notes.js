/**
 * @file Latest-release notes notification panel fetched from GitHub.
 * Split from ui.js (code motion; bodies verbatim).
 */
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.enhancedUi = JE.internals.enhancedUi || {};

    const GITHUB_REPO = 'n00bcodr/Jellyfin-Enhanced';

    const escapeHtml = JE.escapeHtml;

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
            JE.toast(JE.icon(JE.IconName.ERROR) + ' Could not load release notes.');
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

        /**
         * Converts a markdown string to safe HTML. Escapes raw HTML before applying
         * markdown transforms so that API-sourced text cannot inject tags.
         * @param {string} text - Raw markdown text (may contain untrusted content).
         * @returns {string} HTML string safe for innerHTML assignment.
         */
        const markdownToHtml = (text) => {
            if (!text) return '';
            // Escape all HTML first so raw tags like <script> or <img onerror=...>
            // are neutralised before the markdown regex chain builds its own HTML.
            return escapeHtml(text)
                // Blockquotes with callouts — match &gt; since input is now escaped
                .replace(/^&gt;\s*\[!(WARNING|NOTE|TIP|IMPORTANT)\]\s*\r?\n((?:&gt;.*(?:\r?\n|$))+)/gm, (match, type, content) => {
                    const noteContent = content.replace(/^&gt;\s?/gm, '');
                    const colors = {
                        WARNING: { border: '#f0ad4e', bg: 'rgba(240, 173, 78, 0.1)', icon: JE.icon(JE.IconName.WARNING) },
                        NOTE: { border: '#00a4dc', bg: 'rgba(0, 164, 220, 0.1)', icon: JE.icon(JE.IconName.NOTE) },
                        TIP: { border: '#28a745', bg: 'rgba(40, 167, 69, 0.1)', icon: JE.icon(JE.IconName.INFO) },
                        IMPORTANT: { border: '#dc3545', bg: 'rgba(220, 53, 69, 0.1)', icon: JE.icon(JE.IconName.ERROR) }
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
                .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" style="color: var(--primary-accent-color, #00a4dc); text-decoration: underline; text-decoration-color: rgba(0, 164, 220, 0.3);">$1</a>')
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
                    <div style="width: 40px; height: 40px; background: #3e74f2bd; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 18px;">${JE.icon(JE.IconName.CLIPBOARD)}</div>
                    <div style="flex: 1;">
                        <div style="font-weight: 600; font-size: 16px; color: #779aeadc;">Latest Release Notes</div>
                        <div style="font-size: 12px; color: rgba(255,255,255,0.7);">${escapeHtml(release.tag_name)} - ${escapeHtml(new Date(release.published_at).toLocaleDateString())}</div>
                    </div>
                    <button onclick="this.closest('#jellyfin-release-notes-notification').remove()" style="background: rgba(255,255,255,0.1); border: none; color: #fff; font-size: 20px; cursor: pointer; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; transition: background 0.2s; flex-shrink: 0;" onmouseover="this.style.background='rgba(255,255,255,0.2)'" onmouseout="this.style.background='rgba(255,255,255,0.1)'">×</button>
                </div>
            </div>
            <div style="flex: 1; overflow-y: auto; padding: 20px; font-size: 13px; color: rgba(255,255,255,0.85); line-height: 1.6;">
                ${markdownToHtml(releaseNotes)}
            </div>
            <div style="padding: 16px 20px; border-top: 1px solid rgba(255,255,255,0.1); display: flex; gap: 10px; flex-shrink: 0; background: rgba(0,0,0,0.2);">
                <a href="${escapeHtml(release.html_url)}" target="_blank" style="flex: 1; background: #3e74f2bd; border: 1px solid #779aeadc; color: white; text-decoration: none; padding: 10px 16px; border-radius: 6px; font-size: 13px; font-weight: 500; text-align: center; transition: background 0.2s;" onmouseover="this.style.background='#5284f3'" onmouseout="this.style.background='#3e74f2bd'">View Full Release on GitHub</a>
                <button onclick="this.closest('#jellyfin-release-notes-notification').remove()" style="background: #f25151b5; border: 1px solid #f2515133; color: white; padding: 10px 16px; border-radius: 6px; font-size: 13px; font-family: inherit; font-weight: 500; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#f36161'" onmouseout="this.style.background='#f25151b5'">Close</button>
            </div>
        `;

        document.body.appendChild(notification);
        setTimeout(() => { notification.style.transform = 'translateY(-50%) translateX(0)'; }, 10);

        resetAutoCloseTimer();
    }

    // Shared with the panel modules (footer contribute link + release-notes button).
    internal.GITHUB_REPO = GITHUB_REPO;
    internal.showReleaseNotesNotification = showReleaseNotesNotification;

})(window.JellyfinEnhanced);
