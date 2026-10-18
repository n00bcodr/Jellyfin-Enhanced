/**
 * @file Requests & downloads, phase 4f: the "Ready to watch" section of the Jellyfin Enhanced panel (per person). Two
 * personal choices, both off until the person turns them on: a private "Ready to watch" playlist JE keeps up to date
 * (with its state: being made, up to date, turned off and kept, deleted by the person, removed, restored from a backup,
 * no longer private), with an explicit Remove; and a short message on a TV or app signed in as the person when
 * something is ready. Settings live on the server; every change is saved at once. Answers that arrive after the
 * account changed, or after a newer request, are ignored; a failed save puts the controls back as they were.
 * Shown even while notifications are off (the playlist doesn't need them).
 */
(function (JE) {
    'use strict';

    const R = (JE.internals = JE.internals || {}).arrReady = JE.internals.arrReady || {};
    const PANE = 'ready-to-watch';
    /** Requests started by this module: an answer to an older one is dropped. */
    let generation = 0;

    /**
     * True when either Ready feature is in effect on the server.
     * @returns {boolean} Enabled.
     */
    function enabled() {
        const c = JE.pluginConfig || {};
        return c.ArrReadyPlaylistEnabled === true || c.ArrReadyMessagesEnabled === true;
    }

    /**
     * Translates.
     * @param {string} key Key.
     * @param {Object} [params] Parameters.
     * @returns {string} Text.
     */
    function tr(key, params) {
        return typeof JE.t === 'function' ? JE.t(key, params) : key;
    }

    /**
     * Creates an element with text (never HTML).
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
     * The account's epoch (moves on when the signed-in user changes).
     * @returns {*} Epoch.
     */
    function epoch() {
        return JE.session?.getEpoch?.();
    }

    /**
     * Calls the Ready settings route.
     * @param {string} path Path under the plugin.
     * @param {string} method Method.
     * @param {Object} [body] Body.
     * @returns {Promise<Object>} Answer.
     */
    function api(path, method, body) {
        return JE.core.api.plugin(path, { method: method || 'GET', body, skipCache: true, skipRetry: true, timeoutMs: 15000 });
    }

    /**
     * The section's frame for the panel template (empty while neither feature is on).
     * @returns {string} HTML (static, escaped text only; the content is built as DOM).
     */
    function buildSettingsHtml() {
        if (!enabled()) return '';
        const escape = typeof JE.escapeHtml === 'function' ? JE.escapeHtml : (v) => String(v).replace(/[&<>"']/g, ch => '&#' + ch.charCodeAt(0) + ';');
        return `<section class="je-pane" data-pane="${PANE}">
            <h3 class="je-pane-title"><span class="material-icons" aria-hidden="true" style="font-size:20px">playlist_play</span> ${escape(tr('arr_ready_panel_title'))}</h3>
            <div class="je-arr-ready" style="padding: 0 16px 16px 16px;"><div class="je-arr-ready-loading">${escape(tr('arr_ready_panel_loading'))}</div></div>
        </section>`;
    }

    /**
     * A labelled checkbox row.
     * @param {string} focus Its place for focus across re-renders.
     * @param {string} label Label text.
     * @param {string} desc Description text.
     * @param {boolean} checked Checked.
     * @param {(on: boolean) => void} onChange Change handler.
     * @returns {HTMLElement} Row.
     */
    function checkbox(focus, label, desc, checked, onChange) {
        const row = el('label', 'je-arr-alerts-check');
        const box = /** @type {HTMLInputElement} */ (el('input'));
        box.type = 'checkbox';
        box.checked = !!checked;
        box.dataset.jeFocus = focus;
        box.addEventListener('change', () => onChange(box.checked));
        row.appendChild(box);
        const text = el('div');
        text.appendChild(el('div', 'je-arr-alerts-label', label));
        if (desc) text.appendChild(el('div', 'je-arr-alerts-desc', desc));
        row.appendChild(text);
        return row;
    }

    /**
     * The text for the playlist's state.
     * @param {Object} p The playlist part of the answer.
     * @returns {string} Text.
     */
    function stateText(p) {
        switch (p.state) {
            case 'active': return p.playlistId ? tr('arr_ready_state_active', { count: p.entries }) : tr('arr_ready_state_making');
            case 'deleted': return tr('arr_ready_state_deleted');
            case 'removed': return tr('arr_ready_state_removed');
            case 'renew': return tr('arr_ready_state_renew');
            case 'privacy': return tr('arr_ready_state_privacy');
            default: return p.playlistId ? tr('arr_ready_state_off_kept') : '';
        }
    }

    /**
     * Draws the section from an answer, keeping focus on the same control.
     * @param {HTMLElement} host Pane content.
     * @param {Object} data The settings answer.
     * @param {string} [note] A one-line note (saved, failed …).
     * @returns {void}
     */
    function render(host, data, note) {
        const active = host.contains(document.activeElement) ? document.activeElement : null;
        const focusKey = active?.dataset?.jeFocus || null;
        host._jeReady = data;
        host.textContent = '';
        if (note) {
            const n = el('div', 'je-arr-alerts-note', note);
            n.setAttribute('role', 'status');
            host.appendChild(n);
        }
        if (!data) {
            host.appendChild(el('div', 'je-arr-alerts-desc', tr('arr_ready_panel_unavailable')));
            return;
        }
        const p = data.playlist || {};
        if (p.enabled) {
            const group = el('div', 'je-arr-alerts-group je-arr-ready-playlist');
            group.appendChild(el('h4', null, tr('arr_ready_playlist_heading')));
            group.appendChild(checkbox('ready-playlist', tr('arr_ready_playlist_label'), tr('arr_ready_playlist_desc', { days: p.retentionDays }), p.optedIn,
                on => save(host, { readyPlaylist: on })));
            const state = stateText(p);
            if (state) group.appendChild(el('div', 'je-arr-alerts-desc je-arr-ready-state', state));
            const row = el('div', 'je-arr-alerts-row');
            if (p.playlistId && /^[0-9a-f]{32}$/i.test(p.playlistId) && p.state !== 'privacy') {
                const open = /** @type {HTMLAnchorElement} */ (el('a', 'je-arr-alerts-link', tr('arr_ready_open')));
                open.href = '#/details?id=' + p.playlistId;
                open.dataset.jeFocus = 'ready-open';
                row.appendChild(open);
            }
            if (p.canRemove) row.appendChild(removeButton(host));
            if (row.childNodes.length) group.appendChild(row);
            host.appendChild(group);
        }
        const m = data.messages || {};
        if (m.enabled) {
            const group = el('div', 'je-arr-alerts-group je-arr-ready-messages');
            group.appendChild(el('h4', null, tr('arr_ready_messages_heading')));
            group.appendChild(checkbox('ready-messages', tr('arr_ready_messages_label'), tr('arr_ready_messages_desc'), m.optedIn,
                on => save(host, { nativeReadyMessages: on })));
            const recent = m.recent || {};
            if (m.optedIn && (recent.accepted || recent.suppressed || recent.unknown)) {
                group.appendChild(el('div', 'je-arr-alerts-desc', tr('arr_ready_messages_recent', { accepted: recent.accepted || 0, suppressed: (recent.suppressed || 0) + (recent.unknown || 0) })));
            }
            host.appendChild(group);
        }
        if (!focusKey) return;
        const same = Array.from(host.querySelectorAll('[data-je-focus]')).find(n => n.dataset.jeFocus === focusKey);
        const target = same && !same.disabled ? same : host.querySelector('input, button, a[href]');
        if (target) target.focus();
    }

    /**
     * The Remove button: a first press asks, a second within a few seconds removes (no browser dialog: TV remotes).
     * @param {HTMLElement} host Pane content.
     * @returns {HTMLButtonElement} Button.
     */
    function removeButton(host) {
        const b = /** @type {HTMLButtonElement} */ (el('button', 'je-arr-alerts-btn', tr('arr_ready_remove')));
        b.type = 'button';
        b.dataset.jeFocus = 'ready-remove';
        let armed = 0;
        b.addEventListener('click', async (e) => {
            e.preventDefault();
            if (!armed || Date.now() - armed > 5000) {
                armed = Date.now();
                b.textContent = tr('arr_ready_remove_confirm');
                return;
            }
            armed = 0;
            b.disabled = true;
            const gen = ++generation;
            const at = epoch();
            try {
                const res = await api('/acquire/ready/remove', 'POST', {});
                if (!current(host, gen, at)) return;
                render(host, res?.status || host._jeReady, tr(res?.outcome === 'not_ours' ? 'arr_ready_not_ours' : 'arr_ready_removed'));
            } catch (_) {
                if (!current(host, gen, at)) return;
                render(host, host._jeReady, tr('arr_ready_save_failed'));
            }
        });
        return b;
    }

    /**
     * True when an answer still belongs on screen: the section is there, no newer request started, same account.
     * @param {HTMLElement} host Pane content.
     * @param {number} gen The request's generation.
     * @param {*} at The account epoch when it started.
     * @returns {boolean} Current.
     */
    function current(host, gen, at) {
        return host.isConnected && gen === generation && epoch() === at;
    }

    /**
     * Saves a change and draws the answer; a failure draws the last good state again (the control goes back).
     * @param {HTMLElement} host Pane content.
     * @param {Object} change Fields.
     * @returns {Promise<void>}
     */
    async function save(host, change) {
        const before = host._jeReady;
        host.querySelectorAll('input, button').forEach(n => { n.disabled = true; });
        const gen = ++generation;
        const at = epoch();
        try {
            const res = await api('/acquire/ready', 'PUT', change);
            if (!current(host, gen, at)) return;
            render(host, res);
        } catch (_) {
            if (!current(host, gen, at)) return;
            render(host, before, tr('arr_ready_save_failed'));
        }
    }

    /**
     * Loads the person's settings into the section.
     * @param {HTMLElement} host Pane content.
     * @returns {Promise<void>}
     */
    async function load(host) {
        const gen = ++generation;
        const at = epoch();
        try {
            const res = await api('/acquire/ready', 'GET');
            if (!current(host, gen, at)) return;
            render(host, res);
        } catch (_) {
            if (!current(host, gen, at)) return;
            render(host, null);
        }
    }

    /**
     * Fills the section once the panel is open.
     * @param {Object} ctx Panel context (help = the panel element).
     * @returns {void}
     */
    function wireSettings(ctx) {
        const host = ctx?.help?.querySelector?.(`section[data-pane="${PANE}"] .je-arr-ready`);
        if (!host || !enabled()) return;
        load(host);
    }

    R.buildSettingsHtml = buildSettingsHtml;
    R.wireSettings = wireSettings;
    R.render = render;
})(window.JellyfinEnhanced);
