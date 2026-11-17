/** The Elsewhere panel's custom branding icon, shown beside the administrator's message when nothing streams. */
import { api } from './host';

/**
 * The address the icon loads from. An uploaded icon (public config's upload version) wins over the URL setting.
 * Root-relative paths to Jellyfin's own routes (/web/…, /JellyfinEnhanced/…) resolve through ApiClient, so they keep
 * working when Jellyfin runs under a base path such as /jellyfin. The administrator page's URL check resolves the same
 * way (`resolveElsewhereIconUrl` in admin/config/page/branding.ts).
 */
export function resolveBrandingIconUrl(configuredUrl: string | undefined, uploadVersion: string | undefined): string {
    const serverUrl = (path: string, query?: Record<string, string>): string | null => {
        try { return api().getUrl(path, query); } catch { return null; }
    };
    if (uploadVersion) {
        const uploaded = serverUrl('/JellyfinEnhanced/ElsewhereBrandingIcon', { v: uploadVersion });
        if (uploaded) return uploaded;
    }
    const url = String(configuredUrl || '').trim();
    if (/^\/(web|JellyfinEnhanced)\//i.test(url)) return serverUrl(url) || url;
    return url;
}

/** The icon element: 24 × 24, hidden with a console warning that says why when it cannot be loaded. */
export function brandingIcon(url: string, uploaded: boolean): HTMLImageElement {
    const icon = document.createElement('img');
    icon.src = url;
    icon.alt = 'Custom Branding';
    icon.className = 'elsewhere-custom-branding-icon';
    icon.style.cssText = `
                        width: 24px;
                        height: 24px;
                        object-fit: contain;
                        margin-left: 4px;
                    `;
    icon.onerror = () => {
        icon.style.display = 'none';
        console.warn(uploaded
            ? `🪼 Jellyfin Enhanced: the uploaded Elsewhere custom branding icon failed to load from "${url}". Re-upload it in the plugin settings.`
            : `🪼 Jellyfin Enhanced: Elsewhere custom branding icon failed to load from "${url}". It must be a web address the browser can open, not a server file path.`);
    };
    return icon;
}
