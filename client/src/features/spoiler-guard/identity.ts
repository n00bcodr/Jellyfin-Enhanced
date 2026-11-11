import { own } from './ownership';
import { spoilerHost } from './host';
const { JE, internal, ApiClient } = spoilerHost();
const owner = own(JE, 'identity', false);
    const logPrefix = '🪼 Jellyfin Enhanced [SpoilerGuard]:';
    let primed = false;

    /**
     * Point the cookie at `userId`, or delete it when there is none. The server answers the bare id with the value
     * it signed for that user ("<id>.<signature>"), which alone it trusts: keep that one rather than overwrite it.
     */
    function writeIdentityCookie(userId: string | null | undefined): void {
        if (!userId) {
            document.cookie = 'je-spoiler-uid=; path=/; SameSite=Lax; Max-Age=0';
            return;
        }
        const signedFor = /(?:^|;\s*)je-spoiler-uid=([^;.]*)\./.exec(document.cookie)?.[1];
        const plain = (id: string) => decodeURIComponent(id).replace(/-/g, '').toLowerCase();
        if (signedFor !== undefined && plain(signedFor) === plain(userId)) return;
        document.cookie = `je-spoiler-uid=${encodeURIComponent(userId)}; path=/; SameSite=Lax`;
    }

    internal.setIdentityCookie = function() {
        try {
            writeIdentityCookie(typeof ApiClient?.getCurrentUserId === 'function' ? ApiClient.getCurrentUserId() : null);
        } catch (e) {
            console.warn(`${logPrefix} identity cookie set failed:`, e);
        }
    };

    internal.primeIdentityCookie = function() {
        if (primed) return;
        primed = true;
        internal.setIdentityCookie();
        let tries = 0;
        try {
            const poll = function() {
                const userId = typeof ApiClient?.getCurrentUserId === 'function' ? ApiClient.getCurrentUserId() : null;
                if (userId) {
                    internal.setIdentityCookie();
                    return;
                } else if (++tries >= 20) {
                    return;
                }
                owner.later(poll, 250);
            };
            owner.later(poll, 250);
        } catch (_) { /* init() still writes it once */ }
    };

    internal.primeIdentityCookie();

    // The cookie identifies the browser to the server for anonymous <img>
    // requests, so it must follow user switches: rewrite it for the incoming
    // user (the change payload carries the new id — ApiClient may not expose
    // it yet at reset time) and delete it on logout so the server never
    // resolves the previous user's spoiler policy.
    JE.session?.onUserChange('spoilerguard-identity', (change) => {
        try {
            writeIdentityCookie(change.userId);
        } catch (e) {
            console.warn(`${logPrefix} identity cookie update on user switch failed:`, e);
        }
    });
