/**
 * @file Latest-release notes notification panel fetched from GitHub.
 * Strict TypeScript replacement of the module split from ui.js (same markup, ids and behaviour).
 */
import { panelHost, registry, type PanelBridge } from './host';
import { decodeRelease, markdownToHtml, releaseNotesText, type ReleaseView } from './release-markdown';

export function installUiReleaseNotes(JE: Pick<PanelBridge, 'internals' | 'escapeHtml' | 'toast' | 'icon' | 'IconName' | 'themer'>): void {

    const internal = registry(JE);

    const GITHUB_REPO = 'n00bcodr/Jellyfin-Enhanced';

    const escapeHtml = JE.escapeHtml;

    /**
     * Fetches the latest GitHub release notes and displays them in a notification panel.
     */
    async function showReleaseNotesNotification() {
        let release: ReleaseView;
        try {
            const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
            if (!response.ok) throw new Error('Failed to fetch release data');
            release = decodeRelease(await response.json(), GITHUB_REPO);
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
        let autoCloseTimer: ReturnType<typeof setTimeout> | null = null;
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

        const releaseNotes = releaseNotesText(release.body);
        const markdown = (text: string) => markdownToHtml(text, escapeHtml, {
            WARNING: JE.icon(JE.IconName.WARNING), NOTE: JE.icon(JE.IconName.NOTE),
            TIP: JE.icon(JE.IconName.INFO), IMPORTANT: JE.icon(JE.IconName.ERROR)
        });

        notification.innerHTML = `
            <div style="padding: 20px; border-bottom: 1px solid rgba(255,255,255,0.1); flex-shrink: 0;">
                <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 8px;">
                    <div style="width: 40px; height: 40px; background: #3e74f2bd; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 18px;">${JE.icon(JE.IconName.CLIPBOARD)}</div>
                    <div style="flex: 1;">
                        <div style="font-weight: 600; font-size: 16px; color: #779aeadc;">Latest Release Notes</div>
                        <div style="font-size: 12px; color: rgba(255,255,255,0.7);">${escapeHtml(release.tagName)} - ${escapeHtml(release.published.toLocaleDateString())}</div>
                    </div>
                    <button onclick="this.closest('#jellyfin-release-notes-notification').remove()" style="background: rgba(255,255,255,0.1); border: none; color: #fff; font-size: 20px; cursor: pointer; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; transition: background 0.2s; flex-shrink: 0;" onmouseover="this.style.background='rgba(255,255,255,0.2)'" onmouseout="this.style.background='rgba(255,255,255,0.1)'">×</button>
                </div>
            </div>
            <div style="flex: 1; overflow-y: auto; padding: 20px; font-size: 13px; color: rgba(255,255,255,0.85); line-height: 1.6;">
                ${markdown(releaseNotes)}
            </div>
            <div style="padding: 16px 20px; border-top: 1px solid rgba(255,255,255,0.1); display: flex; gap: 10px; flex-shrink: 0; background: rgba(0,0,0,0.2);">
                <a href="${escapeHtml(release.htmlUrl)}" target="_blank" style="flex: 1; background: #3e74f2bd; border: 1px solid #779aeadc; color: white; text-decoration: none; padding: 10px 16px; border-radius: 6px; font-size: 13px; font-weight: 500; text-align: center; transition: background 0.2s;" onmouseover="this.style.background='#5284f3'" onmouseout="this.style.background='#3e74f2bd'">View Full Release on GitHub</a>
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

}

installUiReleaseNotes(panelHost());
