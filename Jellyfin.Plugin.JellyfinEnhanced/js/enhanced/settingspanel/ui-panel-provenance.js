/**
 * @file Settings panel provenance: decorates the panel rows (elements with a
 * data-setting-key) from the server's per-key state (JE.settingsMeta). A row an
 * administrator locks, or whose feature the administrator turned off, is
 * disabled with a one-line explanation. All wording is translated text and is
 * written with textContent only.
 */
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.enhancedUi = JE.internals.enhancedUi || {};

    const NOTE_CLASS = 'je-setting-provenance';
    const CONTROL_SELECTOR = 'input, select, textarea, button';
    // Set on the controls this module disabled, so a later pass re-enables only those.
    const DISABLED_MARK = 'data-je-provenance-disabled';

    // English text for a locale that does not have a key yet (JE.t returns the key on a miss).
    const FALLBACKS = {
        panel_provenance_locked: 'Set by your administrator.',
        panel_provenance_locked_your_choice: 'Your choice ({value}) comes back if this is unlocked.',
        panel_provenance_locked_previous: 'Your previous setting ({value}) comes back if this is unlocked.',
        panel_provenance_reach_native: 'Also applies to poster images in native TV and phone apps such as Android TV and Swiftfin.',
        panel_provenance_unavailable: 'Your administrator has turned this feature off, so this setting has no effect.',
        panel_provenance_on: 'On',
        panel_provenance_off: 'Off'
    };

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
            .filter(control => control.closest('[data-setting-key]') === element && !control.hasAttribute('aria-expanded'));
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
     * Decorates every keyed row in the panel from JE.settingsMeta; safe to run again (it first
     * undoes its previous pass).
     * @param {HTMLElement} help The panel root.
     */
    function decorate(help) {
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
        // Synced once the pass is done, so a listener that redraws controls sees this pass's state.
        const toSync = [];

        elements.forEach((element) => {
            const key = element.dataset.settingKey;
            const isLocked = locked.has(key) || lockedGroups.has(element.dataset.settingGroup);
            const isUnavailable = !isLocked && Object.prototype.hasOwnProperty.call(unavailable, key);
            if (locked.has(key) || (!isLocked && wasLocked.has(element))) toSync.push(element);
            if (!isLocked && !isUnavailable) return;

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

            const lines = [];
            if (isLocked) {
                let line = text('panel_provenance_locked');
                const own = saved[key];
                if (Object.prototype.hasOwnProperty.call(saved, key) && JSON.stringify(own) !== JSON.stringify(settings[key])) {
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
        const onSettingsChanged = () => { if (help.isConnected) decorate(help); };
        document.addEventListener('je:settings-changed', onSettingsChanged);
        if (typeof ctx?.onPanelClose === 'function') {
            ctx.onPanelClose(() => document.removeEventListener('je:settings-changed', onSettingsChanged));
        }
    };
})(window.JellyfinEnhanced);
