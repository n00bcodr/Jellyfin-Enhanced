import { decodeSeerr } from './wire';
import { own } from './ownership';
import { spoilerHost } from './host';
const { JE, internal, ctx } = spoilerHost();
const owner = own(JE, 'seerr-toggle', true);
    const logPrefix = '🪼 Jellyfin Enhanced [SpoilerGuard]:';

    internal.buildSeerrToggle = function(raw, mediaType) {
        const data = decodeSeerr(raw);
        const token = owner.lease();
        if (JE.pluginConfig?.SpoilerBlurEnabled !== true) return null;
        if (mediaType !== 'tv' && mediaType !== 'movie') return null;
        const tmdbId = data?.id;
        if (!tmdbId) return null;

        const jellyfinMediaId = data?.mediaInfo?.jellyfinMediaId || null;
        const displayName = data?.title || data?.name || '';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'je-spoiler-pending-btn';
        button.dataset.jeTmdbId = String(tmdbId);
        button.dataset.jeMediaType = mediaType;

        const icon = document.createElement('span');
        icon.className = 'material-icons';
        const label = document.createElement('span');
        button.appendChild(icon);
        button.appendChild(label);

        // Only the collection can switch this guard off, so here it's a status, not a control.
        const inherited = data?.jeSpoilerGuardInherited === true;

        // The server's verdict also covers what ids alone can't: a title guarded through
        // a collection, or one whose Seerr id doesn't match this library.
        function isEnabled() {
            return data?.jeSpoilerGuard === true || internal.isTmdbEnabled(mediaType, tmdbId, jellyfinMediaId);
        }

        function refresh() {
            if (!token.current()) { button.disabled = true; return; }
            const enabled = isEnabled();
            // "Pending" only fits a title that hasn't arrived yet.
            const onLabel = internal.isTmdbPending(mediaType, tmdbId) ? 'spoiler_blur_pending_button_on' : 'spoiler_blur_button_on';
            const text = JE.t(enabled ? onLabel : 'spoiler_blur_pending_button_off');
            button.classList.toggle('je-spoiler-pending-on', enabled);
            button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
            // A locale without the hint yet gets the key back, so it keeps the label.
            const hint = JE.t('spoiler_blur_inherited_hint');
            button.title = inherited && hint !== 'spoiler_blur_inherited_hint' ? hint : text;
            button.disabled = inherited || (internal.isStateLoaded() && !internal.isLoadOk());
            icon.textContent = enabled ? 'blur_on' : 'blur_off';
            label.textContent = text;
        }

        refresh();
        internal.whenLoaded().then(refresh).catch(function() {});
        owner.listen(button, 'click', function(event) {
            event.preventDefault();
            event.stopPropagation();
            if (button.disabled) return;
            button.disabled = true;
            let wasEnabled = isEnabled();
            const modal = button.closest('.je-more-info-modal');
            const epoch = JE.session ? JE.session.getEpoch() : 0;
            const sameUser = () => token.current() && (!JE.session || JE.session.isCurrent(epoch));
            const sameView = () => sameUser() && button.isConnected && modal?.isConnected === true
                && button.closest('.je-more-info-modal') === modal
                && !('_isClosing' in modal && modal._isClosing === true);
            void (async function() {
                let changed = false;
                try {
                    await internal.whenLoaded();
                    if (!sameView() || !internal.isLoadOk()) return;
                    wasEnabled = isEnabled();
                    if (wasEnabled) {
                        // Each step checks first: requests go out as whoever is signed in now.
                        if (!sameView() || !await internal.confirmDisableSpoiler() || !sameView()) return;
                        const result = await internal.disableForTmdb(mediaType, tmdbId);
                        if (!sameView()) return;
                        // The server's list reaches what a TMDB id can't: an item without
                        // one, and a title held twice, where that id leads to one copy.
                        const items = data?.jeSpoilerGuardItems || [];
                        const outcomes = await Promise.allSettled(items.map(id => sameView() ? (mediaType === 'tv' ? internal.disableForSeries(id) : internal.disableForMovie(id)) : Promise.resolve()));
                        if (!sameView()) return;
                        const removed = result?.removed !== false || outcomes.some(outcome => outcome.status === 'fulfilled');
                        const failed = !removed || outcomes.some(outcome => outcome.status === 'rejected');
                        JE.toast?.(JE.t(failed ? 'spoiler_blur_pending_error_toast' : 'spoiler_blur_pending_disabled_toast'));
                        // Anything that went through still has to reach the modal.
                        if (!removed) return;
                    } else {
                        const result = await internal.enableForTmdb(mediaType, tmdbId, displayName);
                        if (!sameView()) return;
                        JE.toast?.(JE.t(result?.promoted === 'pending' ? 'spoiler_blur_pending_enabled_toast' : 'spoiler_blur_enabled_toast'));
                    }
                    changed = true;
                } catch (e) {
                    if (!sameView()) return;
                    console.warn(`${logPrefix} Seerr toggle failed:`, e);
                    JE.toast?.(JE.t('spoiler_blur_pending_error_toast'));
                } finally {
                    if (sameView()) refresh();
                    button.disabled = inherited || !sameView() || !internal.isLoadOk();
                }
                // Reopened so the modal shows what the server now sends for this title, unless
                // it has since been closed, replaced or left behind by a change of user.
                if (changed && sameView()) {
                    try { await ctx.peer('jellyseerrMoreInfo')?.open?.(tmdbId, mediaType); }
                    catch (error) { if (sameView()) console.warn(`${logPrefix} Seerr refresh failed:`, error); }
                }
            })();
        });
        return button;
    };

    internal.appendSeerrToggle = function(mount, raw, mediaType) {
        if (!mount) return;
        try {
            const button = internal.buildSeerrToggle(raw, mediaType);
            if (button) mount.appendChild(button);
        } catch (e) {
            console.warn(`${logPrefix} Seerr toggle render failed:`, e);
        }
    };
