/**
 * @file Settings panel provenance: decorates the panel rows (elements with a
 * data-setting-key) from the server's per-key state (JE.settingsMeta). A row an
 * administrator locks, or whose feature the administrator turned off, is
 * disabled with a one-line explanation. Other rows say how they relate to the
 * server default only when that tells the user something ("Server default",
 * "Your choice", "Differs from the server default"), with a "Use server
 * default" button that makes the setting follow the default again; the panel
 * also offers "Use server defaults for everything". All wording is translated
 * text and is written with textContent only.
 */
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.enhancedUi = JE.internals.enhancedUi || {};

    const NOTE_CLASS = 'je-setting-provenance';
    const CONTROL_SELECTOR = 'input, select, textarea, button';
    // Set on the controls this module disabled, so a later pass re-enables only those.
    const DISABLED_MARK = 'data-je-provenance-disabled';
    // The keys each panel's previous pass saw following the server default (panel root → Set).
    const previousFollowing = new WeakMap();

    // English text for a locale that does not have a key yet (JE.t returns the key on a miss).
    const FALLBACKS = {
        panel_provenance_locked: 'Set by your administrator.',
        panel_provenance_locked_your_choice: 'Your choice ({value}) comes back if this is unlocked.',
        panel_provenance_locked_previous: 'Your previous setting ({value}) comes back if this is unlocked.',
        panel_provenance_reach_native: 'Also applies to poster images in native TV and phone apps such as Android TV and Swiftfin.',
        panel_provenance_unavailable: 'Your administrator has turned this feature off, so this setting has no effect.',
        panel_provenance_on: 'On',
        panel_provenance_off: 'Off',
        panel_provenance_following: 'Server default',
        panel_provenance_chosen: 'Your choice · Server default is {value}',
        panel_provenance_chosen_plain: 'Your choice',
        panel_provenance_changed_by_admin: 'Set by your administrator · you can change it',
        panel_provenance_differs: 'Differs from the server default ({value})',
        panel_provenance_differs_plain: 'Differs from the server default',
        panel_provenance_use_default: 'Use server default',
        panel_provenance_follow_failed: "Couldn't switch to the server default. Try again.",
        panel_provenance_follow_all: 'Use server defaults for everything',
        panel_provenance_follow_all_confirm: 'This changes {changes} of your settings. {total} settings will follow the server default from now on.',
        panel_provenance_follow_all_confirm_none: 'None of your settings change. {total} settings will follow the server default from now on.',
        panel_provenance_follow_all_apply: 'Use server defaults',
        panel_provenance_follow_all_cancel: 'Cancel',
        panel_provenance_follow_all_done: 'Your settings now follow the server defaults. Reload the page to apply every change.',
        panel_provenance_follow_all_done_none: 'Your settings now follow the server defaults.'
    };
    const FOLLOW_CLASS = 'je-provenance-follow';
    const FOLLOW_ALL_CLASS = 'je-provenance-follow-all';

    /**
     * JE.t with the English fallback above for a key the loaded locale lacks.
     * @param {string} key Translation key.
     * @param {object} [params] Placeholder values.
     * @returns {string}
     */
    function text(key, params) {
        let result = null;
        try { result = typeof JE.t === 'function' ? JE.t(key, params) : null; } catch (e) { result = null; }
        if (result && result !== key) return result;
        return Object.entries(params || {}).reduce((out, [name, value]) => out.split(`{${name}}`).join(String(value)), FALLBACKS[key] || key);
    }

    /**
     * The controls a keyed element owns: the element itself when it is a control, else the
     * controls inside it that are not inside a nested keyed element. Expander buttons
     * (aria-expanded) only show or hide other rows and stay usable.
     * @param {Element} element An element with data-setting-key.
     * @returns {Element[]}
     */
    function ownControls(element) {
        if (element.matches(CONTROL_SELECTOR)) return [element];
        return Array.from(element.querySelectorAll(CONTROL_SELECTOR))
            .filter(control => control.closest('[data-setting-key]') === element && !control.hasAttribute('aria-expanded')
                && !control.closest(`.${NOTE_CLASS}`));
    }

    /**
     * A stored value as the row shows it: the matching option, preset or position label from the
     * row itself, On/Off for a switch, or the number. Null when it cannot be named.
     * @param {Element} element The keyed element.
     * @param {*} value The value.
     * @returns {string|null}
     */
    function describeValue(element, value) {
        if (value === true) return text('panel_provenance_on');
        if (value === false) return text('panel_provenance_off');
        if (value === null || value === undefined) return null;
        const wanted = String(value);
        const select = element.matches('select') ? element : element.querySelector('select');
        const option = select && Array.from(select.options).find(entry => entry.value === wanted);
        if (option) return option.textContent.trim() || null;
        const named = Array.from(element.querySelectorAll('[data-preset-index], [data-pos]'))
            .find(entry => (entry.dataset.presetIndex ?? entry.dataset.pos) === wanted);
        if (named) return named.getAttribute('aria-label') || null;
        return typeof value === 'number' ? wanted : null;
    }

    /**
     * Shows a key's current value (JE.currentSettings) on its row, which the panel may have
     * rendered from an older document or while a lock enforced another value: a single switch
     * or dropdown directly; preset and position pickers redraw their selection, and the tag
     * order buttons re-sort their rows, on the `je:setting-sync` event (ui-panel-settings.js
     * listens on the keyed element).
     * @param {Element} element The keyed element.
     * @param {Element[]} controls The key's own controls.
     * @param {*} value The current value.
     */
    function showEffectiveValue(element, controls, value) {
        if (controls.length === 1) {
            const [control] = controls;
            if (control.matches('input[type="checkbox"]') && typeof value === 'boolean') control.checked = value;
            else if (control.matches('input[type="number"]') && typeof value === 'number') control.value = String(value);
            else if (control.matches('select') && value !== undefined && value !== null
                && Array.from(control.options).some(entry => entry.value === String(value))) control.value = String(value);
        }
        element.dispatchEvent(new CustomEvent('je:setting-sync'));
    }

    /**
     * The notes block of a row: the last child of the row box, created on first use.
     * @param {Element} host The row box.
     * @returns {HTMLElement}
     */
    function notesFor(host) {
        let notes = Array.from(host.children).find(child => child.classList.contains(NOTE_CLASS));
        if (!notes) {
            notes = document.createElement('div');
            notes.className = NOTE_CLASS;
            Object.assign(notes.style, {
                flexBasis: '100%', marginTop: '8px', fontSize: '12px', lineHeight: '1.4', color: 'rgba(255,255,255,0.75)'
            });
            host.appendChild(notes);
        }
        return notes;
    }

    /**
     * How a setting that is neither locked nor gated relates to the server default, as one note
     * line, or null when there is nothing worth saying: "Server default" (following it; only on a
     * row's own key, so nested settings stay quiet), "Your choice · Server default is X" or "Set by
     * your administrator · you can change it" (chosen), "Differs from the server default (X)" (an
     * older value that is not the default). No label for an older value equal to the default, or for
     * a key without a server default. A group (the tag order) is described once for all its keys.
     * @param {Element} element The keyed element.
     * @param {string[]} keys The key, or every key of the element's group.
     * @param {object} meta Camel-cased settings Meta.
     * @param {boolean} ownRow Whether the element is its row's own key.
     * @returns {{text: string, follow: string[]}|null} The text, and the keys "Use server default" makes follow (none: no button).
     */
    function defaultLine(element, keys, meta, ownRow) {
        const defaults = meta.defaults && typeof meta.defaults === 'object' ? meta.defaults : {};
        const has = key => Object.prototype.hasOwnProperty.call(defaults, key);
        const list = name => new Set(Array.isArray(meta[name]) ? meta[name] : []);
        const following = list('following');
        const chosen = list('chosen');
        const changedByAdmin = list('changedByAdmin');
        const differs = list('differs');
        const inheritable = keys.filter(has);
        if (!inheritable.length) return null;
        const follow = inheritable.filter(key => !following.has(key));
        if (!follow.length) return ownRow ? { text: text('panel_provenance_following'), follow: [] } : null;
        // A single key names the default's value; a group (or an unnamed value) does not.
        const value = keys.length === 1 ? describeValue(element, defaults[keys[0]]) : null;
        if (follow.some(key => chosen.has(key))) {
            if (follow.every(key => !chosen.has(key) || changedByAdmin.has(key))) {
                return { text: text('panel_provenance_changed_by_admin'), follow };
            }
            return { text: value ? text('panel_provenance_chosen', { value }) : text('panel_provenance_chosen_plain'), follow };
        }
        if (follow.some(key => differs.has(key))) {
            return { text: value ? text('panel_provenance_differs', { value }) : text('panel_provenance_differs_plain'), follow };
        }
        return null;
    }

    /**
     * Decorates every keyed row in the panel from JE.settingsMeta; safe to run again (it first
     * undoes its previous pass).
     * @param {HTMLElement} help The panel root.
     * @param {string[]} [changedKeys] Keys whose value changed since the panel drew them (another
     *   device, the administrator, "Use server default"): their controls show the new value.
     */
    function decorate(help, changedKeys) {
        // Rows the previous pass locked show the enforced value: an unlock shows the user's again.
        const wasLocked = new Set(Array.from(help.querySelectorAll('[data-je-provenance="locked"]')));
        help.querySelectorAll(`.${NOTE_CLASS}`).forEach(note => note.remove());
        help.querySelectorAll(`[${DISABLED_MARK}]`).forEach(control => {
            control.disabled = false;
            control.removeAttribute(DISABLED_MARK);
        });
        help.querySelectorAll('[data-je-provenance]').forEach(element => {
            element.removeAttribute('data-je-provenance');
            element.removeAttribute('aria-disabled');
        });

        const meta = JE.settingsMeta || {};
        const locked = new Set(Array.isArray(meta.locked) ? meta.locked : []);
        const chosen = new Set(Array.isArray(meta.chosen) ? meta.chosen : []);
        const saved = meta.saved && typeof meta.saved === 'object' ? meta.saved : {};
        const reach = meta.reach && typeof meta.reach === 'object' ? meta.reach : {};
        const unavailable = meta.unavailable && typeof meta.unavailable === 'object' ? meta.unavailable : {};
        const settings = JE.currentSettings || {};
        const elements = Array.from(help.querySelectorAll('[data-setting-key]'));
        // A group (the quality tag order) is saved as a whole, so one locked member disables every member.
        const lockedGroups = new Set(elements
            .filter(element => element.dataset.settingGroup && locked.has(element.dataset.settingKey))
            .map(element => element.dataset.settingGroup));
        const noted = new Set();
        const changed = new Set(Array.isArray(changedKeys) ? changedKeys : []);
        // A key that starts or stops following can show something else with the same value (a
        // followed subtitle style shows its preset's colours), so its row is synced too.
        const following = new Set(Array.isArray(meta.following) ? meta.following : []);
        const followedBefore = previousFollowing.get(help);
        if (followedBefore) {
            following.forEach(key => { if (!followedBefore.has(key)) changed.add(key); });
            followedBefore.forEach(key => { if (!following.has(key)) changed.add(key); });
        }
        previousFollowing.set(help, following);
        // Synced once the pass is done, so a listener that redraws controls sees this pass's state.
        const toSync = [];

        elements.forEach((element) => {
            const key = element.dataset.settingKey;
            const group = element.dataset.settingGroup;
            const isLocked = locked.has(key) || lockedGroups.has(group);
            const isUnavailable = !isLocked && Object.prototype.hasOwnProperty.call(unavailable, key);
            if (locked.has(key) || changed.has(key) || (!isLocked && wasLocked.has(element))) toSync.push(element);
            if (!isLocked && !isUnavailable) {
                const noteKey = group ? `group:${group}` : key;
                if (noted.has(noteKey)) return;
                noted.add(noteKey);
                const host = element.closest('[data-setting-row]') || element;
                const ownRow = host.dataset.settingKey === key;
                const keys = group
                    ? Array.from(new Set(elements.filter(member => member.dataset.settingGroup === group).map(member => member.dataset.settingKey)))
                    : [key];
                const line = defaultLine(element, keys, meta, ownRow);
                if (!line) return;
                const label = ownRow ? '' : (element.dataset.settingLabel || '');
                const row = document.createElement('div');
                Object.assign(row.style, { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 10px' });
                const span = document.createElement('span');
                span.textContent = label ? `${label}: ${line.text}` : line.text;
                row.appendChild(span);
                if (line.follow.length) {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = FOLLOW_CLASS;
                    button.dataset.followKeys = line.follow.join(',');
                    button.textContent = text('panel_provenance_use_default');
                    if (label) button.setAttribute('aria-label', `${label}: ${text('panel_provenance_use_default')}`);
                    Object.assign(button.style, {
                        background: 'transparent', border: '1px solid rgba(255,255,255,0.3)', borderRadius: '4px', color: 'inherit',
                        font: 'inherit', fontSize: '12px', padding: '2px 8px', minHeight: '24px', cursor: 'pointer'
                    });
                    row.appendChild(button);
                }
                notesFor(host).appendChild(row);
                return;
            }

            const controls = ownControls(element);
            controls.forEach((control) => {
                if (control.disabled) return;
                control.disabled = true;
                control.setAttribute(DISABLED_MARK, '');
            });
            element.setAttribute('aria-disabled', 'true');
            element.setAttribute('data-je-provenance', isLocked ? 'locked' : 'unavailable');

            // One note per key (the order buttons share their key); members of a locked group only
            // carry a note when their own key is locked.
            if (noted.has(key) || (isLocked && !locked.has(key))) return;
            noted.add(key);
            if (group) noted.add(`group:${group}`);

            const lines = [];
            if (isLocked) {
                let line = text('panel_provenance_locked');
                const own = saved[key];
                // A key that follows the server default keeps following it after an unlock, so its
                // saved copy does not come back.
                if (!following.has(key) && Object.prototype.hasOwnProperty.call(saved, key) && JSON.stringify(own) !== JSON.stringify(settings[key])) {
                    const value = describeValue(element, own);
                    if (value) line += ' ' + text(chosen.has(key) ? 'panel_provenance_locked_your_choice' : 'panel_provenance_locked_previous', { value });
                }
                lines.push(line);
                if (reach[key] === 'Both') lines.push(text('panel_provenance_reach_native'));
            } else {
                lines.push(text('panel_provenance_unavailable'));
            }

            const host = element.closest('[data-setting-row]') || element;
            const label = host.dataset.settingKey === key ? '' : (element.dataset.settingLabel || '');
            const notes = notesFor(host);
            lines.forEach((line, index) => {
                const row = document.createElement('div');
                row.textContent = index === 0 && label ? `${label}: ${line}` : line;
                notes.appendChild(row);
            });
        });

        toSync.forEach(element => showEffectiveValue(element, ownControls(element), settings[element.dataset.settingKey]));
        renderFollowAll(help, meta);
    }

    /**
     * The keys "Use server defaults for everything" would make follow (every key with a server
     * default that is neither locked nor following yet) and how many of them would visibly change.
     * @param {object} meta Camel-cased settings Meta.
     * @returns {{keys: string[], changes: number}}
     */
    function followAllPlan(meta) {
        const defaults = meta.defaults && typeof meta.defaults === 'object' ? meta.defaults : {};
        const locked = new Set(Array.isArray(meta.locked) ? meta.locked : []);
        const following = new Set(Array.isArray(meta.following) ? meta.following : []);
        const differs = new Set(Array.isArray(meta.differs) ? meta.differs : []);
        const keys = Object.keys(defaults).filter(key => !locked.has(key) && !following.has(key));
        return { keys, changes: keys.filter(key => differs.has(key)).length };
    }

    /**
     * Adds (or refreshes) the "Use server defaults for everything" control below the section list:
     * shown only while some setting does not follow its server default. Its confirmation says first
     * how many values will visibly change.
     * @param {HTMLElement} help The panel root.
     * @param {object} meta Camel-cased settings Meta.
     */
    function renderFollowAll(help, meta) {
        const nav = help.querySelector('.je-panel-nav');
        if (!nav) return;
        let block = nav.querySelector(`.${FOLLOW_ALL_CLASS}`);
        const plan = followAllPlan(meta);
        if (!block) {
            if (!plan.keys.length) return;
            block = document.createElement('div');
            block.className = FOLLOW_ALL_CLASS;
            Object.assign(block.style, { marginTop: 'auto', paddingTop: '10px', borderTop: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12px' });
            const start = document.createElement('button');
            start.type = 'button';
            start.dataset.followAll = 'start';
            start.textContent = text('panel_provenance_follow_all');
            const confirm = document.createElement('div');
            confirm.dataset.followAll = 'confirm';
            confirm.hidden = true;
            const summary = document.createElement('div');
            summary.dataset.followAll = 'summary';
            summary.style.marginBottom = '8px';
            const actions = document.createElement('div');
            Object.assign(actions.style, { display: 'flex', gap: '8px', flexWrap: 'wrap' });
            const apply = document.createElement('button');
            apply.type = 'button';
            apply.dataset.followAll = 'apply';
            apply.textContent = text('panel_provenance_follow_all_apply');
            const cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.dataset.followAll = 'cancel';
            cancel.textContent = text('panel_provenance_follow_all_cancel');
            actions.append(apply, cancel);
            confirm.append(summary, actions);
            const status = document.createElement('div');
            status.dataset.followAll = 'status';
            status.setAttribute('role', 'status');
            status.setAttribute('aria-live', 'polite');
            [start, apply, cancel].forEach(button => Object.assign(button.style, {
                background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '6px', color: '#fff',
                font: 'inherit', fontSize: '12px', padding: '6px 10px', minHeight: '24px', cursor: 'pointer', textAlign: 'left'
            }));
            block.append(start, confirm, status);
            nav.appendChild(block);
        }
        const start = block.querySelector('[data-follow-all="start"]');
        const confirm = block.querySelector('[data-follow-all="confirm"]');
        start.hidden = !plan.keys.length || !confirm.hidden;
        if (!plan.keys.length) confirm.hidden = true;
        // An open confirmation always shows the numbers of the current state.
        block.querySelector('[data-follow-all="summary"]').textContent = plan.changes
            ? text('panel_provenance_follow_all_confirm', { changes: plan.changes, total: plan.keys.length })
            : text('panel_provenance_follow_all_confirm_none', { total: plan.keys.length });
    }

    /**
     * After "Use server default" on a row, applies the new value the way the row's own control
     * would (its change handler runs the live effect; the save it starts finds nothing to send).
     * Only rows with a single switch, dropdown or number box; the others show the value and take
     * effect when the page reloads.
     * @param {HTMLElement} help The panel root.
     * @param {string[]} keys The keys that now follow the default.
     * @param {object} before Their values before.
     */
    function applyFollowedValues(help, keys, before) {
        const settings = JE.currentSettings || {};
        keys.forEach((key) => {
            if (JSON.stringify(before[key]) === JSON.stringify(settings[key])) return;
            help.querySelectorAll('[data-setting-key]').forEach((element) => {
                if (element.dataset.settingKey !== key) return;
                const controls = ownControls(element);
                if (controls.length !== 1 || !controls[0].matches('input[type="checkbox"], input[type="number"], select')) return;
                const [control] = controls;
                showEffectiveValue(element, controls, settings[key]);
                // A control that cannot show the value (an option not loaded yet) would save its own.
                const shows = control.matches('input[type="checkbox"]') ? control.checked === settings[key] : control.value === String(settings[key]);
                if (shows) control.dispatchEvent(new Event('change', { bubbles: true }));
            });
        });
    }

    /**
     * Handles the "Use server default" buttons and the "Use server defaults for everything" control.
     * @param {HTMLElement} help The panel root.
     * @param {MouseEvent} event The click.
     */
    function onClick(help, event) {
        const target = event.target instanceof Element ? event.target : null;
        const button = target?.closest(`.${FOLLOW_CLASS}, [data-follow-all]`);
        if (!button || !help.contains(button) || button.disabled || typeof JE.settings?.follow !== 'function') return;
        const block = button.closest(`.${FOLLOW_ALL_CLASS}`);
        const role = button.dataset.followAll;
        if (block && (role === 'start' || role === 'cancel')) {
            block.querySelector('[data-follow-all="status"]').textContent = '';
            block.querySelector('[data-follow-all="confirm"]').hidden = role === 'cancel';
            renderFollowAll(help, JE.settingsMeta || {});
            (role === 'start' ? block.querySelector('[data-follow-all="apply"]') : block.querySelector('[data-follow-all="start"]'))?.focus();
            return;
        }
        if (block && role !== 'apply') return;
        const plan = followAllPlan(JE.settingsMeta || {});
        const keys = block ? plan.keys : (button.dataset.followKeys || '').split(',').filter(Boolean);
        if (!keys.length) return;
        const before = Object.fromEntries(keys.map(key => [key, (JE.currentSettings || {})[key]]));
        const status = block ? block.querySelector('[data-follow-all="status"]') : null;
        button.disabled = true;
        JE.settings.follow(keys).then(({ rejected }) => {
            if (rejected.length) throw new Error(rejected.map(r => `${r.key} (${r.reason})`).join(', '));
            if (block) {
                block.querySelector('[data-follow-all="confirm"]').hidden = true;
                renderFollowAll(help, JE.settingsMeta || {});
                status.textContent = text(plan.changes ? 'panel_provenance_follow_all_done' : 'panel_provenance_follow_all_done_none');
            } else {
                applyFollowedValues(help, keys, before);
            }
        }).catch((error) => {
            console.warn('🪼 Jellyfin Enhanced: Could not switch settings to the server default:', error);
            const message = text('panel_provenance_follow_failed');
            if (status) status.textContent = message;
            else if (button.isConnected) {
                const line = document.createElement('div');
                line.setAttribute('role', 'alert');
                line.textContent = message;
                button.parentElement?.after(line);
            }
        }).finally(() => {
            if (button.isConnected) button.disabled = false;
        });
    }

    /**
     * Decorates the open panel, and again whenever saved settings or their state change while
     * it is open (a patch answer can report a lock the panel did not know about).
     * @param {object} ctx Shared panel context assembled in ui-panel.js.
     */
    internal.decorateSettingsProvenance = function(ctx) {
        const help = ctx?.help || document.getElementById('jellyfin-enhanced-panel');
        if (!help) return;
        decorate(help);
        const onSettingsChanged = (event) => { if (help.isConnected) decorate(help, event?.detail?.keys); };
        document.addEventListener('je:settings-changed', onSettingsChanged);
        // Once per panel element: the panel is rebuilt each time it opens.
        if (!help.dataset.jeProvenanceWired) {
            help.dataset.jeProvenanceWired = 'true';
            help.addEventListener('click', event => onClick(help, event));
        }
        if (typeof ctx?.onPanelClose === 'function') {
            ctx.onPanelClose(() => document.removeEventListener('je:settings-changed', onSettingsChanged));
        }
    };
})(window.JellyfinEnhanced);
