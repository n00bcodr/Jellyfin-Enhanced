import type { LoaderNamespace, Translations } from '../../host/bootstrap-pages-host';
import type { ConfigLoader } from './config-loader';
import { reinitializeUserTags } from './features';
import { isRecord } from './keys';
import { seedDisplayLanguage } from './user-config';

export async function loadTranslations(JE: LoaderNamespace): Promise<Translations> {
    if (typeof JE.loadTranslations === 'function') return JE.loadTranslations();
    console.warn('🪼 Jellyfin Enhanced: Translations module not loaded, falling back to empty translations');
    return {};
}

/** Reload a signed-in user's scoped data, stopping as soon as another switch happens. */
async function rebootstrapUser(JE: LoaderNamespace, config: ConfigLoader, userId: string, epoch: number, detail: unknown): Promise<void> {
    const session = JE.session;
    if (!session?.isCurrent(epoch)) return; // Switched again already.
    try {
        // The reset stripped the previous user's private config; the server omits it for non-admins.
        if (!await config.reloadUserScopedData(userId, () => session.isCurrent(epoch))) return;
        JE.currentSettings = JE.loadSettings();
        JE.initializeShortcuts();
        seedDisplayLanguage(JE, userId);
        reinitializeUserTags(JE);
        // Translations follow the per-user language choice.
        try {
            const translations = await loadTranslations(JE);
            if (!session.isCurrent(epoch)) return;
            if (translations) JE.translations = translations;
        } catch { /* Keep the previous translations. */ }
        // The new user's data is live, so views (bookmarks, hidden content, …) can re-render from it.
        document.dispatchEvent(new CustomEvent('je:user-data-loaded', { detail }));
        console.log('🪼 Jellyfin Enhanced: Reloaded user-scoped data after user switch.');
    } catch (error) {
        console.error('🪼 Jellyfin Enhanced: Failed to reload user data after user switch:', error);
    }
}

/**
 * Clear the boot-time per-user globals on any identity transition and reload them after
 * a switch: the SPA never reloads index.html on logout/login, so without this every
 * module keeps serving the previous user's data. Runs once, after js/core/session.js loads.
 */
export function registerSessionIntegration(JE: LoaderNamespace, config: ConfigLoader): void {
    if (!JE.session) {
        console.error('🪼 Jellyfin Enhanced: session.js missing — user-switch handling disabled.');
        return;
    }
    // Synchronous, so nothing can read user A's data under user B.
    JE.session.onUserChange('plugin-globals', config.resetUserScopedGlobals);
    document.addEventListener('je:user-changed', event => {
        const detail: unknown = event instanceof CustomEvent ? event.detail : null;
        if (!isRecord(detail)) return;
        const { userId, epoch } = detail;
        if (typeof userId !== 'string' || !userId || typeof epoch !== 'number') return; // Logged out: stay reset.
        // One macrotask: the transition fires from inside the setAuthenticationInfo wrapper
        // BEFORE the host installs the new token, and the fetches need that token.
        setTimeout(() => { void rebootstrapUser(JE, config, userId, epoch, detail); }, 0);
    });
}
