/**
 * @file Requests & downloads, phase 2: the "Requests & alerts" section of the Jellyfin Enhanced panel
 * (per user): what to be told about, pop-ups on open pages, following own requests, phone alerts
 * (ntfy topic on the administrator's server, made up at random or typed), e-mail (an address
 * confirmed with a code), quiet hours (in the browser's time zone), hiding titles on the lock
 * screen, and a test message. Settings live on the server (not in the user's settings file); every
 * change is saved at once and the section is drawn again with focus on the same control (keyboard
 * and TV remotes keep their place). Also opens the panel at this section for the e-mail
 * "unsubscribe" link (#/home?je=alerts).
 */
(function (JE) {
    'use strict';

    const N = (JE.internals = JE.internals || {}).arrNotify = JE.internals.arrNotify || {};
    const PANE = 'requests-alerts';

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
     * Translates.
     * @param {string} key Key.
     * @param {Object} [params] Parameters.
     * @returns {string} Text.
     */
    function tr(key, params) {
        return JE.arrNotify.tr(key, params);
    }

    /**
     * The section's frame for the panel template (empty when notifications are off).
     * @returns {string} HTML (static text only; the content is built as DOM by wireSettings).
     */
    function buildSettingsHtml() {
        if (!JE.arrNotify?.enabled()) return '';
        const escape = typeof JE.escapeHtml === 'function' ? JE.escapeHtml : (v) => String(v);
        return `<section class="je-pane" data-pane="${PANE}">
            <h3 class="je-pane-title"><span class="material-icons" aria-hidden="true" style="font-size:20px">notifications</span> ${escape(tr('arr_notify_panel_title'))}</h3>
            <div class="je-arr-alerts" style="padding: 0 16px 16px 16px;"><div class="je-arr-alerts-loading">${escape(tr('arr_notify_panel_loading'))}</div></div>
        </section>`;
    }

    /**
     * The browser's time zone and offset (sent with every change, for quiet hours).
     * @returns {{timeZone: string, utcOffsetMinutes: number}} Zone.
     */
    function zone() {
        let name = '';
        try {
            name = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
        } catch (_) {
            name = '';
        }
        return { timeZone: /^[A-Za-z0-9/_+-]{1,64}$/.test(name) ? name : '', utcOffsetMinutes: -new Date().getTimezoneOffset() };
    }

    /**
     * A labelled checkbox row.
     * @param {string} labelKey Label key.
     * @param {string} [descKey] Description key.
     * @param {boolean} checked Checked.
     * @param {(on: boolean) => void} onChange Change handler.
     * @returns {HTMLElement} Row.
     */
    function checkbox(labelKey, descKey, checked, onChange) {
        const row = el('label', 'je-arr-alerts-check');
        const box = el('input');
        box.type = 'checkbox';
        box.checked = !!checked;
        box.dataset.jeFocus = labelKey;
        box.addEventListener('change', () => onChange(box.checked));
        row.appendChild(box);
        const text = el('div');
        text.appendChild(el('div', 'je-arr-alerts-label', tr(labelKey)));
        if (descKey) text.appendChild(el('div', 'je-arr-alerts-desc', tr(descKey)));
        row.appendChild(text);
        return row;
    }

    /**
     * A small button.
     * @param {string} labelKey Label key.
     * @param {() => void} onClick Handler.
     * @param {string} [focusKey] Its place for focus across re-renders (default: the label key).
     * @returns {HTMLButtonElement} Button.
     */
    function button(labelKey, onClick, focusKey) {
        const b = /** @type {HTMLButtonElement} */ (el('button', 'je-arr-alerts-btn', tr(labelKey)));
        b.type = 'button';
        b.dataset.jeFocus = focusKey || labelKey;
        b.addEventListener('click', (e) => {
            e.preventDefault();
            onClick();
        });
        return b;
    }

    /**
     * Saves a change (with the browser's zone) and re-renders.
     * @param {HTMLElement} host Pane content.
     * @param {Object} change Fields.
     * @returns {Promise<void>}
     */
    async function save(host, change) {
        const res = await N.prefsCall('/acquire/notify/prefs', 'PUT', Object.assign({}, change, zone()));
        if (!res.ok) note(host, errorText(res.code));
        render(host);
    }

    /**
     * Shows a one-line note at the top of the section.
     * @param {HTMLElement} host Pane content.
     * @param {string} text Text.
     * @returns {void}
     */
    function note(host, text) {
        let n = host.querySelector('.je-arr-alerts-note');
        if (!n) {
            n = el('div', 'je-arr-alerts-note');
            n.setAttribute('role', 'status');
            host.prepend(n);
        }
        n.textContent = text;
    }

    /**
     * An error text for a server code, falling back to a generic one.
     * @param {string} code Code.
     * @returns {string} Text.
     */
    function errorText(code) {
        return tr(ERRORS.includes(code) ? 'arr_notify_err_' + code : 'arr_notify_panel_save_failed');
    }

    /** Server error codes that have their own text in en.json (arr_notify_err_<code>). */
    const ERRORS = ['invalid_topic', 'invalid_address', 'too_soon', 'too_many_today', 'email_not_set_up', 'send_failed', 'no_pending_code', 'wrong_code', 'too_many_attempts', 'email_not_verified', 'ntfy_topic_missing', 'invalid_time'];

    /**
     * Draws the section again, keeping focus on the same control (or the first one when it is gone).
     * @param {HTMLElement} host Pane content.
     * @returns {void}
     */
    function render(host) {
        const active = host.contains(document.activeElement) ? document.activeElement : null;
        const focusKey = active?.dataset?.jeFocus || null;
        build(host);
        if (!focusKey) return;
        const same = Array.from(host.querySelectorAll('[data-je-focus]')).find(n => n.dataset.jeFocus === focusKey);
        const target = same && !same.disabled ? same : host.querySelector('input, button, a[href]');
        if (target) target.focus();
    }

    /**
     * Builds the section from the user's settings.
     * @param {HTMLElement} host Pane content.
     * @returns {void}
     */
    function build(host) {
        const prefs = JE.arrNotify.prefs;
        const channels = JE.arrNotify.channels || {};
        const keepNote = host.querySelector('.je-arr-alerts-note');
        host.textContent = '';
        if (keepNote) host.appendChild(keepNote);
        if (!prefs) {
            host.appendChild(el('div', 'je-arr-alerts-desc', tr('arr_notify_panel_unavailable')));
            return;
        }
        host.appendChild(el('p', 'je-arr-alerts-intro', tr('arr_notify_panel_intro')));

        // What to be told about.
        const what = el('div', 'je-arr-alerts-group');
        what.appendChild(el('h4', null, tr('arr_notify_panel_what')));
        what.appendChild(checkbox('arr_notify_pref_ready', 'arr_notify_pref_ready_desc', prefs.ready, on => save(host, { ready: on })));
        what.appendChild(checkbox('arr_notify_pref_episodes', 'arr_notify_pref_episodes_desc', prefs.episodes, on => save(host, { episodes: on })));
        // Only while requests go through Jellyfin Enhanced (the server sends null otherwise).
        if (prefs.approved !== null && prefs.approved !== undefined) {
            what.appendChild(checkbox('arr_notify_pref_approved', null, prefs.approved, on => save(host, { approved: on })));
        }
        what.appendChild(checkbox('arr_notify_pref_declined', null, prefs.declined, on => save(host, { declined: on })));
        what.appendChild(checkbox('arr_notify_pref_auto_follow', 'arr_notify_pref_auto_follow_desc', prefs.autoFollowRequests, on => save(host, { autoFollowRequests: on })));
        if (prefs.adminAlerts !== null && prefs.adminAlerts !== undefined) {
            what.appendChild(checkbox('arr_notify_pref_admin', 'arr_notify_pref_admin_desc', prefs.adminAlerts, on => save(host, { adminAlerts: on })));
        }
        what.appendChild(checkbox('arr_notify_pref_toasts', 'arr_notify_pref_toasts_desc', prefs.toasts, on => save(host, { toasts: on })));
        host.appendChild(what);

        // Phone (ntfy).
        const phone = el('div', 'je-arr-alerts-group');
        phone.appendChild(el('h4', null, tr('arr_notify_panel_phone')));
        if (!channels.ntfy || !channels.ntfy.available) {
            phone.appendChild(el('div', 'je-arr-alerts-desc', tr('arr_notify_panel_phone_unavailable')));
        } else {
            if (prefs.ntfyTopic) {
                phone.appendChild(checkbox('arr_notify_pref_phone', null, prefs.ntfy, on => save(host, { ntfy: on })));
                const sub = el('div', 'je-arr-alerts-desc');
                sub.appendChild(document.createTextNode(tr('arr_notify_panel_phone_subscribe', { server: channels.ntfy.server })));
                const topic = el('code', 'je-arr-alerts-topic', prefs.ntfyTopic);
                sub.appendChild(document.createTextNode(' '));
                sub.appendChild(topic);
                phone.appendChild(sub);
                const link = el('a', 'je-arr-alerts-link', tr('arr_notify_panel_phone_open'));
                link.href = `${channels.ntfy.server}/${encodeURIComponent(prefs.ntfyTopic)}`;
                link.target = '_blank';
                link.rel = 'noopener';
                phone.appendChild(link);
                if (prefs.ntfyTopicByAdmin) phone.appendChild(el('div', 'je-arr-alerts-desc', tr('arr_notify_panel_phone_by_admin')));
            } else {
                phone.appendChild(el('div', 'je-arr-alerts-desc', tr('arr_notify_panel_phone_none')));
            }
            const row = el('div', 'je-arr-alerts-row');
            row.appendChild(button(prefs.ntfyTopic ? 'arr_notify_panel_phone_new' : 'arr_notify_panel_phone_make', async () => {
                const res = await N.prefsCall('/acquire/notify/ntfy/topic', 'POST', { generate: true });
                if (!res.ok) note(host, errorText(res.code));
                render(host);
            }, 'phone-generate'));
            const input = /** @type {HTMLInputElement} */ (el('input', 'je-arr-alerts-input'));
            input.type = 'text';
            input.placeholder = tr('arr_notify_panel_phone_own');
            input.maxLength = 64;
            input.setAttribute('aria-label', tr('arr_notify_panel_phone_own'));
            input.dataset.jeFocus = 'phone-topic';
            row.appendChild(input);
            row.appendChild(button('arr_notify_panel_phone_use', async () => {
                const res = await N.prefsCall('/acquire/notify/ntfy/topic', 'POST', { topic: input.value.trim() });
                if (!res.ok) note(host, errorText(res.code));
                else if (!JE.arrNotify.prefs.ntfy) await N.prefsCall('/acquire/notify/prefs', 'PUT', Object.assign({ ntfy: true }, zone()));
                render(host);
            }));
            phone.appendChild(row);
        }
        host.appendChild(phone);

        // E-mail.
        const mail = el('div', 'je-arr-alerts-group');
        mail.appendChild(el('h4', null, tr('arr_notify_panel_email')));
        if (!channels.email || !channels.email.available) {
            mail.appendChild(el('div', 'je-arr-alerts-desc', tr('arr_notify_panel_email_unavailable')));
        } else {
            if (prefs.emailAddress) {
                mail.appendChild(checkbox('arr_notify_pref_email', null, prefs.email, on => save(host, { email: on })));
                mail.appendChild(el('div', 'je-arr-alerts-desc', tr('arr_notify_panel_email_to', { address: prefs.emailAddress })));
                mail.appendChild(button('arr_notify_panel_email_remove', async () => {
                    const res = await N.prefsCall('/acquire/notify/email', 'DELETE');
                    if (!res.ok) note(host, errorText(res.code));
                    render(host);
                }));
            }
            const row = el('div', 'je-arr-alerts-row');
            const address = /** @type {HTMLInputElement} */ (el('input', 'je-arr-alerts-input'));
            address.type = 'email';
            address.placeholder = tr('arr_notify_panel_email_placeholder');
            address.setAttribute('aria-label', tr('arr_notify_panel_email_placeholder'));
            address.dataset.jeFocus = 'email-address';
            address.value = prefs.emailPending || '';
            row.appendChild(address);
            row.appendChild(button('arr_notify_panel_email_send', async () => {
                const res = await N.prefsCall('/acquire/notify/email', 'POST', { address: address.value.trim() });
                await JE.arrNotify.loadPrefs(true);
                note(host, res.ok ? tr('arr_notify_panel_email_sent') : errorText(res.code));
                render(host);
            }));
            mail.appendChild(row);
            if (prefs.emailPending) {
                const confirm = el('div', 'je-arr-alerts-row');
                const code = /** @type {HTMLInputElement} */ (el('input', 'je-arr-alerts-input je-arr-alerts-code'));
                code.type = 'text';
                code.inputMode = 'numeric';
                code.maxLength = 6;
                code.placeholder = tr('arr_notify_panel_email_code');
                code.setAttribute('aria-label', tr('arr_notify_panel_email_code'));
                code.dataset.jeFocus = 'email-code';
                confirm.appendChild(code);
                confirm.appendChild(button('arr_notify_panel_email_confirm', async () => {
                    const res = await N.prefsCall('/acquire/notify/email/verify', 'POST', { code: code.value.trim() });
                    note(host, res.ok ? tr('arr_notify_panel_email_confirmed') : errorText(res.code));
                    render(host);
                }));
                mail.appendChild(el('div', 'je-arr-alerts-desc', tr('arr_notify_panel_email_pending', { address: prefs.emailPending })));
                mail.appendChild(confirm);
            }
        }
        host.appendChild(mail);

        // Titles on the lock screen and in e-mails: for whichever outbound channel is offered.
        if ((channels.ntfy && channels.ntfy.available) || (channels.email && channels.email.available)) {
            const privacy = el('div', 'je-arr-alerts-group');
            privacy.appendChild(checkbox('arr_notify_pref_hide_titles', 'arr_notify_pref_hide_titles_desc', prefs.hideTitles, on => save(host, { hideTitles: on })));
            host.appendChild(privacy);
        }

        // Quiet hours.
        const quiet = el('div', 'je-arr-alerts-group');
        quiet.appendChild(el('h4', null, tr('arr_notify_panel_quiet')));
        quiet.appendChild(checkbox('arr_notify_pref_quiet', 'arr_notify_pref_quiet_desc', prefs.quietHours, on => save(host, { quietHours: on })));
        const times = el('div', 'je-arr-alerts-row');
        const from = /** @type {HTMLInputElement} */ (el('input', 'je-arr-alerts-input je-arr-alerts-time'));
        from.type = 'time';
        from.value = prefs.quietFrom || '22:00';
        from.setAttribute('aria-label', tr('arr_notify_panel_quiet_from'));
        from.dataset.jeFocus = 'quiet-from';
        const to = /** @type {HTMLInputElement} */ (el('input', 'je-arr-alerts-input je-arr-alerts-time'));
        to.type = 'time';
        to.value = prefs.quietTo || '07:00';
        to.setAttribute('aria-label', tr('arr_notify_panel_quiet_to'));
        to.dataset.jeFocus = 'quiet-to';
        const saveTimes = () => { if (/^\d\d:\d\d$/.test(from.value) && /^\d\d:\d\d$/.test(to.value)) save(host, { quietFrom: from.value, quietTo: to.value }); };
        from.addEventListener('change', saveTimes);
        to.addEventListener('change', saveTimes);
        times.appendChild(el('span', 'je-arr-alerts-desc', tr('arr_notify_panel_quiet_from')));
        times.appendChild(from);
        times.appendChild(el('span', 'je-arr-alerts-desc', tr('arr_notify_panel_quiet_to')));
        times.appendChild(to);
        quiet.appendChild(times);
        host.appendChild(quiet);

        // Test.
        const test = el('div', 'je-arr-alerts-group');
        test.appendChild(button('arr_notify_panel_test', async () => {
            const res = await N.prefsCall('/acquire/notify/test', 'POST', {});
            note(host, res.ok ? tr('arr_notify_panel_test_sent') : errorText(res.code));
        }));
        host.appendChild(test);
    }

    /**
     * Fills the section once the panel is open.
     * @param {Object} ctx Panel context (help = the panel element).
     * @returns {void}
     */
    function wireSettings(ctx) {
        const host = ctx?.help?.querySelector?.(`section[data-pane="${PANE}"] .je-arr-alerts`);
        if (!host || !JE.arrNotify?.enabled()) return;
        JE.arrNotify.loadPrefs(true).then(() => {
            if (!host.isConnected) return;
            render(host);
            // The browser's zone is stored the first time (for quiet hours), without changing anything else.
            const z = zone();
            if (JE.arrNotify.prefs && z.timeZone && JE.arrNotify.prefs.timeZone !== z.timeZone) N.prefsCall('/acquire/notify/prefs', 'PUT', z);
        });
    }

    /**
     * Opens the Jellyfin Enhanced panel at this section.
     * @param {Object|Event} [owner] Who opens it (the press, or its owner): the panel's surface is theirs.
     * @returns {void}
     */
    async function openSettings(owner) {
        if (typeof JE.showEnhancedPanel !== 'function') return;
        if (!document.getElementById('jellyfin-enhanced-panel')) {
            if (JE.currentSettings) JE.currentSettings.lastOpenedTab = PANE;
            // The panel reloads the user's settings as it opens (which may restore another section): it is asked
            // for this one, and the section is also picked once the panel is there.
            await JE.showEnhancedPanel(owner, { tab: PANE });
        }
        const tab = document.querySelector(`#jellyfin-enhanced-panel .tab-button[data-tab="${PANE}"]`);
        if (tab && !tab.classList.contains('active')) tab.click();
    }

    /**
     * The e-mail "unsubscribe" link lands on #/home?je=alerts: open the section.
     * @returns {void}
     */
    function checkHash() {
        if (!JE.arrNotify?.enabled()) return;
        const hash = window.location.hash || '';
        if (!/[?&]je=alerts\b/.test(hash)) return;
        // No press opens it: the link's own page does, for the route it landed on (none once the viewer moved on).
        const route = JE.routeKey?.();
        setTimeout(() => openSettings(route === undefined ? undefined : JE.routeOwner?.(route, 'the alerts link opens the settings panel')), 800);
    }

    N.buildSettingsHtml = buildSettingsHtml;
    N.wireSettings = wireSettings;
    N.openSettings = openSettings;
    N.checkSettingsHash = checkHash;
    N.renderSettings = render;
})(window.JellyfinEnhanced);
