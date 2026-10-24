/**
 * @file Requests & downloads, phase 3: shared helpers of the Requests page's household tabs
 * (Approvals, Household), the request ledger rows of My requests and the home chip bar. Intent
 * tokens for every remote list (an answer is only shown while the token it was asked under is still
 * the current one: same tab, filter and user, newest read), the caller's request capabilities (once
 * per user), scope words ("Season 2", "S2E8"), posters and "2 h ago". Exposes
 * JE.internals.arrHub.ext; registers nothing on its own.
 */
(function (JE) {
    'use strict';

    const H = (JE.internals = JE.internals || {}).arrHub = JE.internals.arrHub || {};
    const X = H.ext = H.ext || {};
    const caps = { epoch: null, value: undefined, promise: null };

    /**
     * Translates through the shared status helper.
     * @param {string} key en.json key.
     * @param {Object} [params] Parameters.
     * @returns {string} Text.
     */
    function tr(key, params) {
        return JE.arrStatus ? JE.arrStatus.tr(key, params) : key;
    }

    /**
     * Creates an element.
     * @param {string} tag Tag.
     * @param {string} [cls] Classes.
     * @param {string} [text] Text (set through textContent).
     * @returns {HTMLElement} Element.
     */
    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    /**
     * A material icon (hidden from assistive technology; the words carry the meaning).
     * @param {string} name Icon name.
     * @param {string} [cls] Extra class.
     * @returns {HTMLElement} Icon.
     */
    function icon(name, cls) {
        if (JE.arrStatus?.icon) return JE.arrStatus.icon(name, cls);
        const span = el('span', `material-icons${cls ? ' ' + cls : ''}`, name);
        span.setAttribute('aria-hidden', 'true');
        return span;
    }

    /**
     * A real button with an optional icon.
     * @param {string} cls Classes.
     * @param {string} label Visible text.
     * @param {string} [iconName] Icon name.
     * @param {string} [focusId] Focus id (data-je-focus) so focus comes back after a redraw.
     * @returns {HTMLButtonElement} Button.
     */
    function button(cls, label, iconName, focusId) {
        const b = el('button', cls);
        b.type = 'button';
        if (iconName) b.appendChild(icon(iconName));
        b.appendChild(document.createTextNode(label));
        if (focusId) b.dataset.jeFocus = focusId;
        return b;
    }

    /**
     * Marks a control busy without disabling it (a disabled control drops keyboard and D-pad focus);
     * its handler checks the busy state itself.
     * @param {HTMLElement} control Control.
     * @param {boolean} on Busy.
     * @returns {void}
     */
    function busy(control, on) {
        if (on) control.setAttribute('aria-disabled', 'true');
        else control.removeAttribute('aria-disabled');
    }

    /**
     * The current session epoch (a user switch changes it).
     * @returns {number} Epoch.
     */
    function epoch() {
        return JE.session?.getEpoch ? JE.session.getEpoch() : 0;
    }

    /**
     * An intent-token source for one remote list. Each read takes a new token naming what it asks
     * for (tab, query, filter, page) plus the user epoch and a sequence number; only an answer whose
     * token is still the current one, under the same user, may be shown.
     * @param {string} tab The list's tab name.
     * @returns {{next: function(Object=): Object, current: function(): (Object|null), isCurrent: function(Object): boolean, drop: function(): void}} Source.
     */
    function intent(tab) {
        let seq = 0;
        let current = null;
        return {
            next(parts) {
                current = Object.freeze({ tab, query: '', filter: '', page: 0, ...(parts || {}), epoch: epoch(), seq: ++seq });
                return current;
            },
            current: () => current,
            isCurrent: token => !!token && token === current && token.epoch === epoch(),
            drop() {
                current = null;
            }
        };
    }

    /**
     * Reads a plugin route as JSON through the request client (every HTTP answer resolves).
     * @param {string} path Path under /JellyfinEnhanced.
     * @param {{method?: string, body?: Object}} [options] Options.
     * @returns {Promise<{status: number, body: Object|null}>} Answer (status 0 when nothing came back).
     */
    /**
     * Whether a write's answer was lost after it went out (it may be stored): shown as "couldn't confirm", never as
     * failed, and the page reads the server again.
     * @param {{status: number, error?: *}} answer
     * @returns {boolean}
     */
    function unconfirmed(answer) {
        return !!answer?.error && !answer.error.sessionChanged && JE.core.userWrite.outcome(answer.error) === 'uncertain';
    }

    async function call(path, options) {
        if (!JE.arrAsk?.call) return { status: 0, body: null };
        try {
            return await JE.arrAsk.call(path, options);
        } catch (err) {
            return { status: 0, body: null, error: err };
        }
    }

    /**
     * The caller's request capabilities: undefined while they are being read, null when the feature
     * is off or the server can't say. A read that finishes redraws the Requests page if it shows.
     * @returns {Object|null|undefined} Capabilities.
     */
    function capabilities() {
        if (!JE.arrAsk?.enabled?.()) return null;
        const now = epoch();
        if (caps.epoch !== now) {
            caps.epoch = now;
            caps.value = undefined;
            caps.promise = null;
        }
        if (caps.value !== undefined) return caps.value;
        if (!caps.promise) {
            const asked = now;
            caps.promise = Promise.resolve(JE.arrAsk.me()).then((value) => {
                if (caps.epoch !== asked || epoch() !== asked) return;
                caps.value = value || null;
                caps.promise = null;
                if (H.state?.visible) H.render?.();
            }, () => {
                if (caps.epoch !== asked) return;
                caps.value = null;
                caps.promise = null;
                if (H.state?.visible) H.render?.();
            });
        }
        return undefined;
    }

    /**
     * Whether the caller is a Manager or an Admin: true, false, or 'pending' while unknown.
     * @returns {boolean|string} Approver.
     */
    function approver() {
        const value = capabilities();
        if (value === undefined) return 'pending';
        return !!value && (value.role === 'manager' || value.role === 'admin');
    }

    /**
     * True when the caller is a (Jellyfin) administrator by their request capabilities.
     * @returns {boolean} Admin.
     */
    function isAdmin() {
        return capabilities()?.role === 'admin';
    }

    /**
     * The household contact word ("Dad"), or the neutral word.
     * @returns {string} Contact.
     */
    function contact() {
        const value = capabilities();
        return (value?.contact || '').trim() || tr('arr_contact_default');
    }

    /**
     * The scope of a request in family words: "Movie", "Season 2", "Seasons 1–3", "S2E8",
     * "S2E8, S2E9", "12 episodes", "Next season (Season 3)", "Season 3 and new ones".
     * @param {{scope: string, seasons?: number[], episodes?: Array<{season: number, episode: number}>}} item Request.
     * @returns {string} Text.
     */
    function scopeText(item) {
        const seasons = Array.isArray(item?.seasons) ? item.seasons : [];
        const episodes = Array.isArray(item?.episodes) ? item.episodes : [];
        switch (item?.scope) {
            case 'movie': return tr('arr_approvals_scope_movie');
            case 'episodes':
                if (episodes.length > 0 && episodes.length <= 3) {
                    return episodes.map(e => tr('arr_approvals_scope_episode', { season: e.season, episode: e.episode })).join(', ');
                }
                return tr('arr_approvals_scope_episodes', { count: episodes.length });
            case 'next_season': return tr('arr_approvals_scope_next', { season: seasons[0] ?? '' });
            case 'future': return tr('arr_approvals_scope_future', { season: seasons[0] ?? '' });
            default:
                return typeof H.seasonsText === 'function' ? H.seasonsText(seasons) : seasons.join(', ');
        }
    }

    /** Stages a request's own state already says: a part in one of them needs no pill of its own. */
    const OWN_STAGES = new Set(['asked', 'notHere', 'none']);

    /**
     * Where the part a request asks for has got to, in family words ("Downloading · 45%", "Ready"), or ''
     * when the server sent no status for it.
     * @param {Object|null|undefined} status The part's status (a request's partStatus).
     * @returns {string} Text.
     */
    function partText(status) {
        if (!status || typeof JE.arrStatus?.familyText !== 'function') return '';
        return JE.arrStatus.familyText(status, { contact: contact() });
    }

    /**
     * The status pill of the part a request asks for (without administrators' lines or a journey), or null when
     * there is none or it says no more than the request's own state (waiting for an OK, not here yet).
     * @param {Object|null|undefined} status The part's status (a request's partStatus).
     * @returns {HTMLElement|null} Pill.
     */
    function partPill(status) {
        if (!status || OWN_STAGES.has(status.stage) || typeof JE.arrStatus?.buildPill !== 'function') return null;
        return JE.arrStatus.buildPill({ ...status, admin: null, journey: null }, { contact: contact() });
    }

    /**
     * "2 h ago" for an ISO date ('' when unknown).
     * @param {string} iso ISO date.
     * @returns {string} Text.
     */
    function ago(iso) {
        const age = iso && JE.arrStatus?.ageText ? JE.arrStatus.ageText(iso) : '';
        return age ? tr('arr_approvals_ago', { age }) : '';
    }

    /**
     * The poster of a request card: the caller's own Jellyfin item when there is one, else the TMDB
     * poster (path checked again here), else an icon.
     * @param {{itemId?: string, poster?: string, kind?: string}} item Request.
     * @param {string} [cls] Classes.
     * @returns {HTMLElement} Poster.
     */
    function poster(item, cls) {
        const classes = cls || 'je-hub-poster';
        let src = null;
        if (typeof item?.itemId === 'string' && /^[0-9a-f]{32}$/i.test(item.itemId) && typeof ApiClient !== 'undefined' && typeof ApiClient.getImageUrl === 'function') {
            src = ApiClient.getImageUrl(item.itemId, { type: 'Primary', maxHeight: 300 });
        } else if (typeof item?.poster === 'string' && /^\/[A-Za-z0-9_.-]+$/.test(item.poster)) {
            src = `https://image.tmdb.org/t/p/w185${item.poster}`;
        }
        if (src) {
            const img = el('img', classes);
            img.loading = 'lazy';
            img.alt = '';
            img.src = src;
            return img;
        }
        const empty = el('div', `${classes} je-hub-poster-empty`);
        empty.appendChild(icon(item?.kind === 'tv' ? 'tv' : 'movie'));
        return empty;
    }

    /**
     * The title of a request with its year ("Toy Story 5 (2026)"), or the untitled word.
     * @param {{title?: string, year?: number}} item Request.
     * @returns {string} Text.
     */
    function titleText(item) {
        const name = typeof item?.title === 'string' && item.title.trim() ? item.title.trim() : tr('arr_hub_untitled');
        return item?.year ? `${name} (${item.year})` : name;
    }

    /**
     * True in Jellyfin's TV layout (no text fields there; focus rings and large targets).
     * @returns {boolean} TV layout.
     */
    function isTv() {
        return document.documentElement.classList.contains('layout-tv') || document.body?.classList.contains('layout-tv') === true;
    }

    /**
     * The control that has focus inside a container (its data-je-focus id), if any.
     * @param {HTMLElement|null} root Container.
     * @returns {string|null} Focus id ('' for an unnamed control, null when focus is elsewhere).
     */
    function focusedId(root) {
        const active = document.activeElement;
        if (!root || !active || !root.contains(active)) return null;
        return active.closest('[data-je-focus]')?.dataset.jeFocus || '';
    }

    /**
     * Puts focus back on the control with the same focus id after a redraw, else on the first of
     * the fallbacks found, else on the page's selected tab (only when focus was in the container).
     * @param {HTMLElement} root Container.
     * @param {string|null} id Focus id from before the redraw.
     * @param {string[]} [fallbacks] Focus ids to try next.
     * @returns {void}
     */
    function restoreFocus(root, id, fallbacks) {
        if (id === null || root.contains(document.activeElement)) return;
        const nodes = [...root.querySelectorAll('[data-je-focus]')];
        const target = [id, ...(fallbacks || [])].map(f => nodes.find(n => n.dataset.jeFocus === f && !n.disabled)).find(Boolean)
            || document.querySelector('#je-requests-hub-page .je-hub-tab[aria-selected="true"]');
        target?.focus({ preventScroll: true });
    }

    /**
     * Follows feed keys with one re-read per burst.
     * @param {string[]} keys Feed keys.
     * @param {Function} callback Called (at most once per 300 ms) after a change.
     * @returns {() => void} Stop following.
     */
    function follow(keys, callback) {
        if (!JE.arrStatus?.subscribe) return () => {};
        let timer = null;
        const off = JE.arrStatus.subscribe(keys, () => {
            if (timer) return;
            timer = setTimeout(() => {
                timer = null;
                callback();
            }, 300);
        });
        return () => {
            if (timer) clearTimeout(timer);
            timer = null;
            off();
        };
    }

    /**
     * The caller's own request-list feed key (req:u:<id>), when signed in.
     * @returns {string|null} Key.
     */
    function userKey() {
        const id = typeof ApiClient !== 'undefined' && typeof ApiClient.getCurrentUserId === 'function' ? ApiClient.getCurrentUserId() : null;
        return id ? 'req:u:' + String(id).replace(/-/g, '').toLowerCase() : null;
    }

    JE.session?.onUserChange?.('arr-hub-ext', () => {
        caps.epoch = null;
        caps.value = undefined;
        caps.promise = null;
    });

    Object.assign(X, {
        tr, el, icon, button, busy, epoch, intent, call, unconfirmed, capabilities, approver, isAdmin, contact,
        scopeText, ago, poster, titleText, isTv, focusedId, restoreFocus, follow, userKey, partText, partPill
    });
    H.extraTabs = H.extraTabs || [];
    H.starters = H.starters || [];
})(window.JellyfinEnhanced);
