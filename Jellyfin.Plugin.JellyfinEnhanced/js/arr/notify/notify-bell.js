/**
 * @file Requests & downloads, phase 2: the bell in the header with the unread count, and its inbox
 * panel: newest first, unread dot, poster, text, "5 min ago", Play for what is ready, Mark all read,
 * Load older, and a footer with the user's phone alerts / quiet hours and a link to the "Requests &
 * alerts" settings. An administrators' stuck-download digest reads as a count with Open Overview and a
 * Details list it expands in place, so one digest never fills a phone screen. A dialog on desktop, a bottom sheet on phones; Escape closes it and focus goes
 * back to the bell.
 */
(function (JE) {
    'use strict';

    const N = (JE.internals = JE.internals || {}).arrNotify = JE.internals.arrNotify || {};
    const BUTTON_ID = 'je-notify-bell';
    let panel = null;
    let opener = null;
    let observer = null;
    let started = false;
    // Digests whose list is open while the panel is (cleared when it closes).
    const expanded = new Set();

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
     * @param {string} name Icon name.
     * @returns {HTMLElement} Icon.
     */
    function icon(name) {
        const i = el('span', 'material-icons', name);
        i.setAttribute('aria-hidden', 'true');
        return i;
    }

    /**
     * Updates the bell's badge and label.
     * @returns {void}
     */
    function syncBadge() {
        const button = document.getElementById(BUTTON_ID);
        if (!button) return;
        const count = JE.arrNotify.unread;
        const badge = button.querySelector('.je-notify-badge');
        if (badge) {
            badge.textContent = count > 99 ? '99+' : String(count);
            badge.hidden = count === 0;
        }
        const label = count ? JE.arrNotify.tr('arr_notify_bell_unread', { n: count }) : JE.arrNotify.tr('arr_notify_bell');
        button.title = label;
        button.setAttribute('aria-label', label);
        button.dataset.headerLabel = JE.arrNotify.tr('arr_notify_bell');
    }

    /**
     * Puts the bell into JE's header tray (again after Jellyfin rebuilds the header).
     * @returns {void}
     */
    function inject() {
        if (!JE.arrNotify.enabled() || document.getElementById(BUTTON_ID)) return;
        const tray = JE.helpers?.getHeaderButtonTray?.();
        if (!tray || document.getElementById(BUTTON_ID)) return;
        const button = el('button', 'headerButton headerButtonRight paper-icon-button-light je-notify-bell');
        button.id = BUTTON_ID;
        button.type = 'button';
        button.setAttribute('is', 'paper-icon-button-light');
        button.setAttribute('aria-haspopup', 'dialog');
        button.appendChild(icon('notifications'));
        const badge = el('span', 'je-notify-badge');
        badge.hidden = true;
        badge.setAttribute('aria-hidden', 'true');
        button.appendChild(badge);
        button.addEventListener('click', (e) => {
            e.stopPropagation();
            toggle(button);
        });
        tray.insertBefore(button, tray.firstChild);
        syncBadge();
    }

    /**
     * Opens or closes the inbox.
     * @param {HTMLElement} [from] The control that opened it (focus returns there).
     * @returns {void}
     */
    function toggle(from) {
        if (panel) close();
        else openPanel(from);
    }

    /**
     * Opens the inbox panel.
     * @param {HTMLElement} [from] Opener.
     * @returns {void}
     */
    function openPanel(from) {
        if (panel) return;
        opener = from || document.getElementById(BUTTON_ID);
        panel = el('div', 'je-notify-panel');
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'false');
        panel.setAttribute('aria-label', JE.arrNotify.tr('arr_notify_title'));
        panel.tabIndex = -1;
        document.body.appendChild(panel);
        position();
        render();
        opener?.setAttribute('aria-expanded', 'true');
        panel.focus();
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('click', onOutside, true);
        window.addEventListener('resize', position);
        JE.arrNotify.refresh();
        JE.arrNotify.loadPrefs(false).then(() => { if (panel) render(); });
    }

    /**
     * Closes the inbox panel (focus back to the bell).
     * @returns {void}
     */
    function close() {
        if (!panel) return;
        panel.remove();
        panel = null;
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('click', onOutside, true);
        window.removeEventListener('resize', position);
        expanded.clear();
        opener?.setAttribute('aria-expanded', 'false');
        if (opener && opener.isConnected) opener.focus();
        opener = null;
    }

    /**
     * Escape closes; Tab stays inside the panel.
     * @param {KeyboardEvent} e Event.
     * @returns {void}
     */
    function onKey(e) {
        if (!panel) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            close();
            return;
        }
        if (e.key === 'Tab') {
            const focusables = Array.from(panel.querySelectorAll('button, a[href]')).filter(n => !n.disabled);
            if (!focusables.length) return;
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            if (!panel.contains(document.activeElement)) {
                // Focus fell out of the panel (a control it was on went away): back to its start.
                e.preventDefault();
                (e.shiftKey ? last : first).focus();
                return;
            }
            if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        }
    }

    /**
     * A click outside the panel (and not on the bell) closes it.
     * @param {MouseEvent} e Event.
     * @returns {void}
     */
    function onOutside(e) {
        if (!panel) return;
        const bell = document.getElementById(BUTTON_ID);
        if (panel.contains(e.target) || (bell && bell.contains(e.target))) return;
        close();
    }

    /**
     * Places the panel under the bell on wide screens; phones get a bottom sheet (CSS).
     * @returns {void}
     */
    function position() {
        if (!panel) return;
        const bell = document.getElementById(BUTTON_ID);
        if (window.innerWidth <= 600 || !bell) {
            panel.style.top = '';
            panel.style.right = '';
            return;
        }
        const r = bell.getBoundingClientRect();
        panel.style.top = `${Math.round(r.bottom + 6)}px`;
        panel.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right - 8))}px`;
    }

    /**
     * One inbox row.
     * @param {Object} item Inbox item.
     * @returns {HTMLElement} Row.
     */
    function buildItem(item) {
        const row = el('div', 'je-notify-item' + (item.read ? '' : ' je-notify-unread'));
        row.dataset.id = String(item.id);
        const dot = el('span', 'je-notify-dot');
        dot.setAttribute('aria-hidden', 'true');
        row.appendChild(dot);
        const src = JE.arrNotify.posterUrl(item);
        if (src) {
            const img = el('img', 'je-notify-poster');
            img.alt = '';
            img.loading = 'lazy';
            img.src = src;
            // A Jellyfin item without its image yet (just added): TMDB's poster, else the icon.
            img.addEventListener('error', () => {
                const fallback = JE.arrNotify.posterUrl(Object.assign({}, item, { params: Object.assign({}, item.params, { image: null }) }));
                if (fallback && img.src !== fallback) {
                    img.src = fallback;
                    return;
                }
                const ph = el('span', 'je-notify-poster je-notify-poster-empty');
                ph.appendChild(icon('notifications'));
                img.replaceWith(ph);
            });
            row.appendChild(img);
        } else {
            const ph = el('span', 'je-notify-poster je-notify-poster-empty');
            ph.appendChild(icon(item.kind === 'approval' ? 'how_to_reg' : item.kind === 'remind' ? 'campaign' : /instance|disk|stuck/.test(item.kind) ? 'warning' : 'notifications'));
            row.appendChild(ph);
        }
        const body = el('button', 'je-notify-body');
        body.type = 'button';
        const text = el('div', 'je-notify-text');
        text.appendChild(N.buildText(item));
        body.appendChild(text);
        body.appendChild(el('div', 'je-notify-time', JE.arrNotify.ago(item.createdAt)));
        body.addEventListener('click', (e) => { const owner = JE.ownerOf(e); close(); JE.arrNotify.open(item, owner); });
        if (item.kind === 'stuck_digest') row.appendChild(digest(item, body));
        else row.appendChild(body);
        if (item.itemId && (item.kind === 'ready' || item.kind === 'episodes')) {
            const play = el('button', 'je-notify-play');
            play.type = 'button';
            play.appendChild(icon('play_arrow'));
            play.appendChild(document.createTextNode(JE.arrNotify.tr('arr_notify_play')));
            play.addEventListener('click', (e) => { const owner = JE.ownerOf(e); close(); JE.arrNotify.open(item, owner); });
            row.appendChild(play);
        }
        return row;
    }

    /**
     * A stuck-download digest's column: its count (the row's button), then Open Overview and a Details
     * toggle, then the downloads it lists (title, instance and reason in Overview's words), shown on demand.
     * The toggle only shows or hides the list in place (no redraw), and the list scrolls on its own.
     * @param {Object} item Inbox item.
     * @param {HTMLElement} body The row's text button.
     * @returns {HTMLElement} Column.
     */
    function digest(item, body) {
        const col = el('div', 'je-notify-main');
        col.appendChild(body);
        const entries = N.digestEntries(item);
        const actions = el('div', 'je-notify-digest-actions');
        const open = el('button', 'je-notify-digest-open');
        open.type = 'button';
        open.appendChild(icon('open_in_new'));
        open.appendChild(document.createTextNode(JE.arrNotify.tr('arr_notify_digest_open')));
        open.addEventListener('click', (e) => { const owner = JE.ownerOf(e); close(); JE.arrNotify.open(item, owner); });
        actions.appendChild(open);
        col.appendChild(actions);
        if (!entries.length) return col;
        const list = el('ul', 'je-notify-digest-list');
        list.id = `je-notify-digest-${String(item.id).replace(/[^A-Za-z0-9_-]/g, '')}`;
        for (const entry of entries) {
            const li = el('li');
            if (entry.text) {
                li.textContent = entry.text;
            } else {
                li.appendChild(el('strong', '', entry.scope ? `${entry.title} ${entry.scope}` : entry.title));
                const rest = [entry.instance, entry.reason].filter(Boolean).join(' · ');
                if (rest) li.appendChild(document.createTextNode(` · ${rest}`));
            }
            list.appendChild(li);
        }
        const more = Number(item.params?.count) - entries.length;
        if (more > 0 && !entries[0].text) list.appendChild(el('li', 'je-notify-digest-more', JE.arrNotify.tr('arr_notify_digest_more', { n: more })));
        const toggle = el('button', 'je-notify-digest-toggle');
        toggle.type = 'button';
        toggle.setAttribute('aria-controls', list.id);
        const show = (on) => {
            list.hidden = !on;
            toggle.setAttribute('aria-expanded', on ? 'true' : 'false');
            toggle.textContent = JE.arrNotify.tr(on ? 'arr_notify_digest_hide' : 'arr_notify_digest_show', { n: entries.length });
        };
        show(expanded.has(item.id));
        toggle.addEventListener('click', () => {
            const on = !expanded.has(item.id);
            if (on) expanded.add(item.id); else expanded.delete(item.id);
            show(on);
        });
        actions.appendChild(toggle);
        col.appendChild(list);
        return col;
    }

    /**
     * The footer line: phone alerts and quiet hours, plus the settings button.
     * @returns {HTMLElement} Footer.
     */
    function buildFooter() {
        const foot = el('div', 'je-notify-foot');
        const prefs = JE.arrNotify.prefs;
        const bits = [];
        if (prefs) {
            const phone = prefs.ntfy ? JE.arrNotify.tr('arr_notify_phone_on') : JE.arrNotify.tr('arr_notify_phone_off');
            bits.push(phone);
            if (prefs.email) bits.push(JE.arrNotify.tr('arr_notify_email_on'));
            if (prefs.quietHours) bits.push(JE.arrNotify.tr('arr_notify_quiet_summary', { from: prefs.quietFrom, to: prefs.quietTo }));
        }
        const line = el('span', 'je-notify-foot-text', bits.join(' · '));
        line.prepend(icon('smartphone'));
        foot.appendChild(line);
        const settings = el('button', 'je-notify-settings');
        settings.type = 'button';
        settings.title = JE.arrNotify.tr('arr_notify_settings');
        settings.setAttribute('aria-label', JE.arrNotify.tr('arr_notify_settings'));
        settings.appendChild(icon('settings'));
        // The press's owner opens the panel (taken before the inbox it was made in closes).
        settings.addEventListener('click', (e) => { const owner = JE.ownerOf?.(e); close(); N.openSettings?.(owner); });
        foot.appendChild(settings);
        return foot;
    }

    /**
     * Renders the panel from the current inbox state (keeps focus on the same control).
     * @returns {void}
     */
    function render() {
        if (!panel) return;
        const active = panel.contains(document.activeElement) ? document.activeElement : null;
        const focusedId = active?.closest?.('.je-notify-item')?.dataset.id;
        // A row's own control (Play, a digest's Open Overview or Details) gets focus back after the redraw.
        const focusedRowControl = ['je-notify-play', 'je-notify-digest-open', 'je-notify-digest-toggle'].find(c => active?.classList?.contains(c)) || null;
        const focusedControl = ['je-notify-markall', 'je-notify-more', 'je-notify-settings'].find(c => active?.classList?.contains(c)) || null;
        const rowsBefore = new Set(Array.from(panel.querySelectorAll('.je-notify-item')).map(r => r.dataset.id));
        panel.textContent = '';
        const head = el('div', 'je-notify-head');
        head.appendChild(el('h2', 'je-notify-title', JE.arrNotify.tr('arr_notify_title')));
        const unread = JE.arrNotify.unread;
        if (unread) head.appendChild(el('span', 'je-notify-new', JE.arrNotify.tr('arr_notify_new', { n: unread })));
        const all = el('button', 'je-notify-markall', JE.arrNotify.tr('arr_notify_mark_all'));
        all.type = 'button';
        all.disabled = unread === 0;
        all.addEventListener('click', () => JE.arrNotify.markRead(null));
        head.appendChild(all);
        panel.appendChild(head);
        const list = el('div', 'je-notify-list');
        const items = JE.arrNotify.items;
        if (!items.length) list.appendChild(el('div', 'je-notify-empty', JE.arrNotify.tr('arr_notify_empty')));
        items.forEach(item => list.appendChild(buildItem(item)));
        if (JE.arrNotify.more) {
            const more = el('button', 'je-notify-more', JE.arrNotify.tr('arr_notify_more'));
            more.type = 'button';
            more.addEventListener('click', () => JE.arrNotify.loadMore());
            list.appendChild(more);
        }
        panel.appendChild(list);
        panel.appendChild(buildFooter());
        if (focusedId) {
            const row = Array.from(panel.querySelectorAll('.je-notify-item')).find(r => r.dataset.id === focusedId);
            const target = row && ((focusedRowControl && row.querySelector('.' + focusedRowControl)) || row.querySelector('.je-notify-body'));
            if (target) target.focus();
            else panel.focus();
        } else if (focusedControl) {
            // The same control again; when it is gone or disabled (all read, nothing older), the
            // first row that came with "Show older", else the first row, else the panel.
            const same = panel.querySelector('.' + focusedControl);
            const added = focusedControl === 'je-notify-more' ? Array.from(panel.querySelectorAll('.je-notify-item')).find(r => !rowsBefore.has(r.dataset.id)) : null;
            const target = (same && !same.disabled ? same : null)
                || added?.querySelector('.je-notify-body')
                || panel.querySelector('.je-notify-body');
            (target || panel).focus();
        }
    }

    /**
     * Starts the bell (behind the notifications switch).
     * @returns {void}
     */
    function initialize() {
        if (started || !JE.arrNotify?.enabled()) return;
        started = true;
        JE.arrNotify.onChange((what) => {
            syncBadge();
            if (panel && (what === 'inbox' || what === 'prefs')) render();
        });
        const look = () => { if (!document.getElementById(BUTTON_ID)) inject(); };
        observer = JE.helpers?.onBodyMutation ? JE.helpers.onBodyMutation('arr-notify-bell', look) : null;
        setTimeout(look, 500);
        document.addEventListener('viewshow', () => close());
    }

    JE.session?.onUserChange?.('arr-notify-bell', () => {
        close();
        document.getElementById(BUTTON_ID)?.remove();
    });

    N.openBell = () => openPanel(document.getElementById(BUTTON_ID));
    N.closeBell = close;
    N.initializeBell = initialize;
    N.renderBell = render;
})(window.JellyfinEnhanced);
