/**
 * @file Requests & downloads, phase 2: "Notify me" / "Following" on movie, series and season pages
 * (an icon button in the action row), in Seerr's more-info window and on Requests page rows (a text
 * button), and "Remind {contact}" next to a status that is taking longer than usual (family members
 * only; at most once a day per title, the server decides). Every button shows the same follow state
 * and updates when it changes anywhere.
 */
(function (JE) {
    'use strict';

    const N = (JE.internals = JE.internals || {}).arrNotify = JE.internals.arrNotify || {};
    const FOLLOWABLE = /^(movie:(tmdb|imdb):[A-Za-z0-9]+|tv:(tvdb|tmdb|imdb):[A-Za-z0-9]+(:s\d+)?)$/;
    let listening = false;

    /**
     * Creates an element.
     * @param {string} tag Tag.
     * @param {string} [cls] Classes.
     * @param {string} [text] Text.
     * @returns {HTMLElement} Element.
     */
    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    /**
     * A material icon.
     * @param {string} name Icon.
     * @param {string} [cls] Extra class.
     * @returns {HTMLElement} Icon.
     */
    function icon(name, cls) {
        const i = el('span', 'material-icons' + (cls ? ' ' + cls : ''), name);
        i.setAttribute('aria-hidden', 'true');
        return i;
    }

    /**
     * True for a key one can follow (movie, series or season).
     * @param {string} key Key.
     * @returns {boolean} Followable.
     */
    function followable(key) {
        return typeof key === 'string' && FOLLOWABLE.test(key);
    }

    /**
     * The label of a follow button for a key.
     * @param {string} key Key.
     * @param {boolean} following Following now.
     * @returns {string} Label.
     */
    function label(key, following) {
        const series = /^tv:/.test(key) && !/:s\d+$/.test(key);
        if (following) return JE.arrNotify.tr(series ? 'arr_notify_following_episodes' : 'arr_notify_following');
        return JE.arrNotify.tr(series ? 'arr_notify_follow_episodes' : 'arr_notify_follow');
    }

    /**
     * Brings every follow button on the page in line with the follow state.
     * @returns {void}
     */
    function syncAll() {
        document.querySelectorAll('.je-notify-follow[data-key]').forEach(update);
    }

    /**
     * Updates one follow button.
     * @param {HTMLElement} button Button.
     * @returns {void}
     */
    function update(button) {
        const key = button.dataset.key;
        const following = JE.arrNotify.isFollowing(key);
        const text = label(key, following);
        button.setAttribute('aria-pressed', following ? 'true' : 'false');
        button.title = following && JE.arrNotify.followsAsRequester(key) ? JE.arrNotify.tr('arr_notify_following_requested') : text;
        button.setAttribute('aria-label', text);
        button.classList.toggle('je-notify-following', following);
        const ic = button.querySelector('.je-notify-follow-icon');
        if (ic) ic.textContent = following ? 'notifications_active' : 'notifications_none';
        const t = button.querySelector('.je-notify-follow-text');
        if (t) t.textContent = text;
    }

    /**
     * Toggles the follow of a button's key.
     * @param {HTMLElement} button Button.
     * @param {Object} owner The press's owner (JE.ownerOf(event)).
     * @returns {Promise<void>}
     */
    async function toggle(button, owner) {
        if (button.getAttribute('aria-busy') === 'true') return;
        const key = button.dataset.key;
        const on = !JE.arrNotify.isFollowing(key);
        button.setAttribute('aria-busy', 'true');
        const res = await JE.arrNotify.setFollow(key, on, owner);
        button.removeAttribute('aria-busy');
        if (res.code === 'user_changed') return;
        if (!res.ok) {
            const msg = res.code === 'unconfirmed' ? 'arr_write_unconfirmed' : res.code === 'not_allowed' ? 'arr_notify_follow_not_allowed' : res.code === 'too_many' ? 'arr_notify_follow_too_many' : 'arr_notify_follow_failed';
            if (typeof JE.toast === 'function') JE.toast(JE.escapeHtml ? JE.escapeHtml(JE.arrNotify.tr(msg)) : JE.arrNotify.tr(msg), 3000);
        }
        syncAll();
    }

    /**
     * A follow button.
     * @param {string} key Key.
     * @param {'icon'|'text'} style Icon button (details action row) or text button.
     * @param {string} cls Classes.
     * @returns {HTMLElement} Button.
     */
    function followButton(key, style, cls) {
        const button = el('button', cls + ' je-notify-follow');
        button.type = 'button';
        button.dataset.key = key;
        if (style === 'icon') {
            const content = el('div', 'detailButton-content');
            content.appendChild(icon('notifications_none', 'detailButton-icon je-notify-follow-icon'));
            button.appendChild(content);
        } else {
            button.appendChild(icon('notifications_none', 'je-notify-follow-icon'));
            button.appendChild(el('span', 'je-notify-follow-text'));
        }
        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggle(button, JE.ownerOf(e));
        });
        update(button);
        return button;
    }

    /**
     * "Remind {contact}" for a status that needs attention (family members only).
     * @param {Object} status Status.
     * @param {string} contact What the family calls the owner.
     * @param {string|null} itemId Jellyfin item shown, if any.
     * @returns {HTMLElement} Button.
     */
    function remindButton(status, contact, itemId) {
        const who = contact || JE.arrNotify.tr('arr_contact_default');
        const button = el('button', 'je-notify-remind');
        button.type = 'button';
        button.appendChild(icon('campaign'));
        const text = el('span', null, JE.arrNotify.tr('arr_notify_remind_button', { contact: who }));
        button.appendChild(text);
        button.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (button.getAttribute('aria-disabled') === 'true') return;
            const owner = JE.ownerOf(e);
            // The reminder belongs to this click's session (its origin), through the write and what its answer shows.
            const origin = JE.core.userWrite.origin();
            button.setAttribute('aria-disabled', 'true');
            const res = await JE.arrNotify.remind(status.key, itemId, owner, origin);
            if (res.code === 'user_changed') return;
            if (res.ok) text.textContent = JE.arrNotify.tr('arr_notify_reminded', { contact: who });
            else if (res.code === 'unconfirmed') text.textContent = JE.arrNotify.tr('arr_write_unconfirmed');
            else if (res.code === 'too_soon') text.textContent = JE.arrNotify.tr('arr_notify_reminded_already', { contact: who });
            else {
                text.textContent = JE.arrNotify.tr('arr_notify_remind_failed');
                button.removeAttribute('aria-disabled');
            }
        });
        return button;
    }

    /**
     * Details page: the follow icon in the action row and Remind next to the pill. Called by the
     * status surface after each render (null status: remove).
     * @param {HTMLElement|null} page Details page.
     * @param {Object|null} status Item status.
     * @param {Object} [ctx] Response context (contact).
     * @returns {void}
     */
    function attachDetails(page, status, ctx) {
        if (!page) return;
        page.querySelectorAll('.je-notify-follow-details, .je-notify-remind-details').forEach(n => n.remove());
        if (!JE.arrNotify?.enabled() || !status) return;
        const key = status.kind === 'episode' ? null : status.key;
        const host = page.querySelector('.mainDetailButtons') || page.querySelector('.detailButtons');
        if (key && followable(key) && host) {
            listen();
            JE.arrNotify.loadFollows(false).then(syncAll);
            host.appendChild(followButton(key, 'icon', 'button-flat detailButton emby-button je-notify-follow-details'));
        }
        if (status.attention && !status.admin) {
            const block = page.querySelector('.je-arr-status[data-je-arr-surface="details"]');
            if (block) {
                const remind = remindButton(status, ctx?.contact || '', status.itemId || null);
                remind.classList.add('je-notify-remind-details');
                block.appendChild(remind);
            }
        }
    }

    /**
     * Seerr's more-info window: Notify me / Following (and Remind) under the pill.
     * @param {HTMLElement} mount The modal's status mount.
     * @param {Object|null} status The title's status, if any.
     * @param {string} key The modal's title key.
     * @param {Object} [ctx] Response context (contact).
     * @returns {void}
     */
    function attachModal(mount, status, key, ctx) {
        if (!mount) return;
        mount.querySelectorAll('.je-notify-modal-actions').forEach(n => n.remove());
        if (!JE.arrNotify?.enabled() || !followable(key)) return;
        listen();
        const row = el('div', 'je-notify-modal-actions');
        row.appendChild(followButton(key, 'text', 'je-notify-chip'));
        if (status && status.attention && !status.admin) row.appendChild(remindButton(status, ctx?.contact || '', null));
        mount.appendChild(row);
        JE.arrNotify.loadFollows(false).then(syncAll);
    }

    /**
     * A Requests page row: Following / Notify me.
     * @param {Object} entry Hub entry.
     * @param {HTMLElement} buttons The row's button box.
     * @returns {void}
     */
    function rowButton(entry, buttons) {
        if (!JE.arrNotify?.enabled() || !buttons || !followable(entry?.key)) return;
        listen();
        const button = followButton(entry.key, 'text', 'je-hub-btn je-notify-chip');
        button.dataset.jeFocus = `follow:${entry.key}`;
        buttons.appendChild(button);
        JE.arrNotify.loadFollows(false).then(syncAll);
    }

    /**
     * Keeps the buttons in step with the follow state (once).
     * @returns {void}
     */
    function listen() {
        if (listening || !JE.arrNotify) return;
        listening = true;
        JE.arrNotify.onChange((what) => { if (what === 'follows') syncAll(); });
    }

    N.attachDetails = attachDetails;
    N.attachModal = attachModal;
    N.rowButton = rowButton;
    N.followable = followable;
})(window.JellyfinEnhanced);
