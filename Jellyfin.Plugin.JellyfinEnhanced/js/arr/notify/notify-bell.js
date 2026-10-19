/**
 * @file Requests & downloads, phase 2: the bell in the header with the unread count, and its inbox
 * panel: newest first, unread dot, poster, text, "5 min ago", Play for what is ready, Mark all read,
 * Load older, and a footer with the user's phone alerts / quiet hours and a link to the "Requests &
 * alerts" settings. A dialog on desktop, a bottom sheet on phones; Escape closes it and focus goes
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
        body.addEventListener('click', () => { close(); JE.arrNotify.open(item); });
        row.appendChild(body);
        if (item.itemId && (item.kind === 'ready' || item.kind === 'episodes')) {
            const play = el('button', 'je-notify-play');
            play.type = 'button';
            play.appendChild(icon('play_arrow'));
            play.appendChild(document.createTextNode(JE.arrNotify.tr('arr_notify_play')));
            play.addEventListener('click', () => { close(); JE.arrNotify.open(item); });
            row.appendChild(play);
        }
        return row;
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
        settings.addEventListener('click', () => { close(); N.openSettings?.(); });
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
        const focusedPlay = active?.classList?.contains('je-notify-play');
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
            const target = row && (focusedPlay ? row.querySelector('.je-notify-play') : row.querySelector('.je-notify-body'));
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
