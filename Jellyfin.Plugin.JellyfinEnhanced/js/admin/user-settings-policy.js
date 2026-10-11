/**
 * @file Admin page (Configuration/configPage.html) add-on: the "User settings policy" table on
 * the Admin tab, whose Lock column is the only place an administrator locks a per-user setting,
 * and a small badge under every admin control that is also a per-user default.
 *
 * Not part of the client bundle (not in component-scripts.json). The page loads it with a
 * versioned URL and calls window.JellyfinEnhancedAdminPolicy.decorate(page) after every
 * pageshow's loadConfig; decoration is idempotent. The save path takes LockedUserSettings
 * from applyLocks(), which answers only while `ready` is true (rows freshly rendered for this
 * visit); otherwise the saved locks are left alone.
 *
 * Holds code only: every value comes from the authenticated registry route or the page, and is
 * written with textContent; innerHTML is used only for one static, value-free checkbox template.
 */
(function () {
    'use strict';

    const REGISTRY_PATH = '/JellyfinEnhanced/admin/user-settings/registry';
    const ROW_ID_PREFIX = 'jePolicyRow-';
    const BADGE_CLASS = 'je-user-default-badge';

    const state = {
        page: null,          // the page element the rows were rendered into
        entries: [],         // lockable registry entries, in registry order
        byKey: new Map(),    // key -> { entry, checkbox, name }
        baseline: new Set(), // keys locked on the server when the rows were rendered or saved
        run: 0,              // decoration sequence; only the latest one renders
        changes: 0,          // admin edits to lock checkboxes, counted
        changedAt: new Map(), // key -> value of `changes` at its last edit
        submitted: null      // { changes, locks }: the edit counter and the list when applyLocks() last built a save
    };

    const api = {
        /** True once the policy rows are rendered for the current page and applyLocks() can be trusted. */
        ready: false,
        decorate,
        applyLocks,
        pendingState,
        markSaved
    };
    window.JellyfinEnhancedAdminPolicy = api;

    /**
     * Words a camelCase or PascalCase key ("AutoPipEnabled" -> "Auto pip enabled") when the page
     * has no label for it.
     * @param {string} key The setting key.
     * @returns {string}
     */
    function wordsFromKey(key) {
        const words = String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
        return words.charAt(0).toUpperCase() + words.slice(1);
    }

    /**
     * The admin control (or data-order-key row) a registry entry points at.
     * @param {Element} page The admin page.
     * @param {object} entry A registry entry.
     * @returns {Element|null}
     */
    function findControl(page, entry) {
        if (typeof entry.RowKey === 'string') {
            return Array.from(page.querySelectorAll('[data-order-key]')).find(row => row.dataset.orderKey === entry.RowKey) || null;
        }
        if (typeof entry.ControlId === 'string') {
            return Array.from(page.querySelectorAll('[id]')).find(element => element.id === entry.ControlId) || null;
        }
        return null;
    }

    /**
     * An element's own text, without nested badges and hints (a beta mark, a plugin hint).
     * @param {Element|null} element The element.
     * @returns {string}
     */
    function ownText(element) {
        if (!element) return '';
        return Array.from(element.childNodes)
            .filter(node => node.nodeType === 3)
            .map(node => node.textContent)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * The tag a control belongs to ("Quality Tags") when it sits in, or in a section after, a
     * tag row whose own label would be ambiguous alone ("Position", "Show on movies").
     * @param {Element} control The control or row.
     * @returns {string}
     */
    function tagContext(control) {
        const holder = control.closest('.je-tag-row') || control.closest('details');
        if (!holder) return '';
        let row = holder.matches('.je-tag-row') ? holder : null;
        for (let element = holder.previousElementSibling; !row && element; element = element.previousElementSibling) {
            if (element.matches('.je-tag-row')) row = element;
        }
        const toggle = row && row.querySelector('.checkboxContainer input');
        if (!toggle || toggle === control) return '';
        return ownText(toggle.closest('label') && toggle.closest('label').querySelector('span')).replace(/^Enable /, '');
    }

    /**
     * The page's own label for a control, as plain text.
     * @param {Element} page The admin page.
     * @param {Element|null} control The control or row.
     * @param {object} entry Its registry entry.
     * @returns {string}
     */
    function controlName(page, control, entry) {
        let name = '';
        if (control && control.matches('[data-order-key]')) {
            const label = ownText(control.querySelector('label span'));
            name = label ? label + ' (order)' : '';
        } else if (control) {
            const wrapping = control.closest('label');
            const forLabel = Array.from(page.querySelectorAll('label[for]')).find(label => label.htmlFor === control.id);
            name = ownText(wrapping && wrapping.querySelector('span')) || ownText(forLabel);
        }
        if (!name) return wordsFromKey(entry.Key);
        const context = control ? tagContext(control) : '';
        return context ? context + ': ' + name : name;
    }

    /**
     * A value as the admin page shows it: On/Off, the matching option's text, or the value.
     * @param {Element|null} control The admin control.
     * @param {*} value The value.
     * @returns {string}
     */
    function describeValue(control, value) {
        if (value === true) return 'On';
        if (value === false) return 'Off';
        if (control && control.tagName === 'SELECT' && value !== null && value !== undefined) {
            const option = Array.from(control.options).find(entry => entry.value === String(value));
            if (option) return option.textContent.trim();
        }
        if (value === null || value === undefined || value === '') return '(empty)';
        if (control && control.matches('[data-order-key]')) return 'position ' + value;
        return String(value);
    }

    /**
     * The value a lock would enforce once saved: the admin control's current (possibly unsaved)
     * value, or the saved admin value when the control cannot be read.
     * @param {object} item A row's state.
     * @returns {*}
     */
    function pendingAdminValue(item) {
        const control = item.control;
        if (control && control.tagName === 'INPUT' && control.type === 'checkbox') return control.checked;
        if (control && control.tagName === 'SELECT') {
            return typeof item.entry.AdminValue === 'number' ? Number(control.value) : control.value;
        }
        if (control && control.matches('[data-order-key]')) {
            const rows = Array.from(control.parentElement ? control.parentElement.querySelectorAll('[data-order-key]') : []);
            const at = rows.indexOf(control);
            if (at >= 0) return at + 1;
        }
        return item.entry.AdminValue;
    }

    /**
     * Where the setting takes effect under the saved configuration, as badge text.
     * @param {object} entry A registry entry.
     * @returns {{text: string, nativeOff: boolean}}
     */
    function reachText(entry) {
        if (entry.EffectiveReach === 'Both') return { text: 'Web + native posters', nativeOff: false };
        if (entry.Reach === 'Both') return { text: 'Web only (native poster tags are off)', nativeOff: true };
        return { text: 'Web only', nativeOff: false };
    }

    /**
     * Builds a jump link that the page's delegated .je-jump-link handler follows.
     * @param {string} text Link text.
     * @param {string} tab The tab to switch to.
     * @param {string} target CSS selector of the element to scroll to.
     * @param {string} [label] Accessible name when the text is a symbol.
     * @returns {HTMLAnchorElement}
     */
    function jumpLink(text, tab, target, label) {
        const link = document.createElement('a');
        link.href = '#';
        link.className = 'je-jump-link';
        link.dataset.jumpTab = tab;
        link.dataset.jumpTarget = target;
        link.textContent = text;
        if (label) link.setAttribute('aria-label', label);
        return link;
    }

    /**
     * Element a control's badge follows: the row or container that holds it, so the toggle and
     * position of one tag row, or a category and its order, share one badge.
     * @param {Element} control The control or row.
     * @returns {Element}
     */
    function badgeAnchor(control) {
        return control.closest('.je-quality-cat-admin-row')
            || control.closest('.je-tag-row')
            || control.closest('.checkboxContainer, .inputContainer, .selectContainer')
            || control;
    }

    /**
     * Writes (or rewrites) the badge under every control that is a per-user default.
     * @param {Element} page The admin page.
     */
    function renderBadges(page) {
        page.querySelectorAll('.' + BADGE_CLASS).forEach(badge => badge.remove());
        const groups = new Map();
        state.byKey.forEach((item) => {
            if (!item.control) return;
            const anchor = badgeAnchor(item.control);
            if (!groups.has(anchor)) groups.set(anchor, []);
            groups.get(anchor).push(item);
        });
        groups.forEach((items, anchor) => {
            const badge = document.createElement('div');
            badge.className = BADGE_CLASS;
            const reach = reachText(items[0].entry);
            const lockedCount = items.filter(item => item.checkbox && item.checkbox.checked).length;
            const label = document.createElement('span');
            label.textContent = 'User default · ';
            badge.appendChild(label);
            if (reach.nativeOff) {
                const reachLabel = document.createElement('span');
                reachLabel.textContent = 'Web only (';
                badge.appendChild(reachLabel);
                badge.appendChild(jumpLink('native poster tags are off', 'display', '#nativePosterTagsEnabled'));
                badge.appendChild(document.createTextNode(')'));
            } else {
                badge.appendChild(document.createTextNode(reach.text));
            }
            if (lockedCount > 0) {
                const locked = document.createElement('strong');
                locked.className = 'je-user-default-badge-locked';
                locked.textContent = items.length > 1 && lockedCount < items.length ? ' · ' + lockedCount + ' of ' + items.length + ' locked' : ' · Locked';
                badge.appendChild(locked);
            }
            badge.appendChild(document.createTextNode(' '));
            badge.appendChild(jumpLink('›', 'admin', '#' + ROW_ID_PREFIX + items[0].entry.Key, 'Lock or unlock in User settings policy'));
            anchor.insertAdjacentElement('afterend', badge);
        });
    }

    /**
     * Explains, before saving, what each changed lock will do.
     * @param {Element} page The admin page.
     */
    function renderImpact(page) {
        const box = page.querySelector('#jeUserSettingsPolicyImpact');
        if (!box) return;
        box.textContent = '';
        const changed = [];
        state.byKey.forEach((item, key) => {
            if (item.checkbox && item.checkbox.checked !== state.baseline.has(key)) changed.push(item);
        });
        box.hidden = changed.length === 0;
        changed.forEach((item) => {
            const line = document.createElement('div');
            const value = describeValue(item.control, pendingAdminValue(item));
            const entry = item.entry;
            if (item.checkbox.checked) {
                let where = 'Applies in the Jellyfin Enhanced web interface (also in Jellyfin for Android and webOS).';
                if (entry.EffectiveReach === 'Both') where = 'Applies to web overlays and to poster images in native TV and phone apps.';
                else if (entry.Reach === 'Both') where = 'Applies to web overlays (native poster tags are off on this server).';
                line.textContent = 'Locking ' + item.name + ' to ' + value + ': users who chose something else will see ' + value
                    + '. Their choice is kept and comes back if you unlock. ' + where;
            } else {
                line.textContent = 'Unlocking ' + item.name + ': each user\'s own choice comes back; users who never changed it keep your default (' + value + ').';
            }
            box.appendChild(line);
        });
        if (changed.length) {
            const note = document.createElement('div');
            note.className = 'je-policy-impact-note';
            note.textContent = 'Locks take effect when you save.';
            box.appendChild(note);
        }
    }

    /**
     * Shows the policy's status line (loading, failure, or the lock count).
     * @param {Element} page The admin page.
     * @param {string} message Plain text; empty hides the line.
     * @param {boolean} [isError] Styles it as a warning.
     */
    function setStatus(page, message, isError) {
        const status = page.querySelector('#jeUserSettingsPolicyStatus');
        if (!status) return;
        status.textContent = message;
        status.hidden = !message;
        status.classList.toggle('je-policy-status-error', !!isError);
    }

    /** Updates the summary line, impact text and badges after a lock checkbox changes. */
    function refresh() {
        const page = state.page;
        if (!page) return;
        const lockedNow = Array.from(state.byKey.values()).filter(item => item.checkbox && item.checkbox.checked).length;
        const summary = page.querySelector('#jeUserSettingsPolicySummaryCount');
        if (summary) summary.textContent = state.entries.length + ' settings, ' + lockedNow + ' locked';
        renderImpact(page);
        renderBadges(page);
    }

    /**
     * The tab and section a control is in ("Display · Media Tags"), as a table group heading.
     * @param {Element|null} control The control or row.
     * @returns {string}
     */
    function groupName(control) {
        const tab = control && control.closest('.jellyfin-tab-content');
        if (!tab) return '';
        const button = Array.from(document.querySelectorAll('.jellyfin-tab-button')).find(entry => entry.dataset.tab === tab.id);
        const legend = control.closest('fieldset') && control.closest('fieldset').querySelector('legend');
        return [ownText(button && button.querySelector('h3')), ownText(legend)].filter(Boolean).join(' · ');
    }

    /**
     * Renders the policy rows from the registry, keeping lock checkboxes the admin changed while
     * the registry was loading.
     * @param {Element} page The admin page.
     * @param {object[]} registry The registry route's answer.
     * @param {number} changesAtStart The edit counter when the request started.
     */
    function render(page, registry, changesAtStart) {
        const body = page.querySelector('#jeUserSettingsPolicyTable tbody');
        if (!body) throw new Error('policy table missing');
        const previous = state.page === page ? state.byKey : new Map();
        state.page = page;
        state.entries = registry.filter(entry => entry && typeof entry.Key === 'string' && entry.Lockable === true);
        state.baseline = new Set(state.entries.filter(entry => entry.Locked === true).map(entry => entry.Key));
        state.byKey = new Map();
        body.textContent = '';
        // Rows follow the page: each control's tab and section, top to bottom.
        const controls = new Map(state.entries.map(entry => [entry, findControl(page, entry)]));
        const ordered = state.entries.slice().sort((a, b) => {
            const first = controls.get(a), second = controls.get(b);
            if (!first || !second) return (first ? 0 : 1) - (second ? 0 : 1);
            if (first === second) return 0;
            return first.compareDocumentPosition(second) & 4 ? -1 : 1;
        });
        let group = null;
        ordered.forEach((entry) => {
            const control = controls.get(entry);
            const name = controlName(page, control, entry);
            const where = groupName(control);
            if (where !== group) {
                group = where;
                const heading = document.createElement('tr');
                heading.className = 'je-policy-group';
                const cell = document.createElement('th');
                cell.colSpan = 4;
                cell.scope = 'colgroup';
                cell.textContent = where || 'Other';
                heading.appendChild(cell);
                body.appendChild(heading);
            }
            const row = document.createElement('tr');
            row.id = ROW_ID_PREFIX + entry.Key;
            row.dataset.settingKey = entry.Key;

            const nameCell = document.createElement('th');
            nameCell.scope = 'row';
            const tab = control && control.closest('.jellyfin-tab-content');
            if (control && tab && control.id) nameCell.appendChild(jumpLink(name, tab.id, '#' + control.id));
            else if (control && tab && control.matches('[data-order-key]')) nameCell.appendChild(jumpLink(name, tab.id, '[data-order-key="' + entry.RowKey + '"]'));
            else nameCell.textContent = name;

            const valueCell = document.createElement('td');
            valueCell.textContent = describeValue(control, entry.AdminValue);
            const reachCell = document.createElement('td');
            reachCell.textContent = entry.EffectiveReach === 'Both' ? 'Web + native posters' : (entry.Reach === 'Both' ? 'Web (native off)' : 'Web only');

            const lockCell = document.createElement('td');
            const label = document.createElement('label');
            label.className = 'je-policy-lock';
            // Static markup (no values) so jellyfin-web upgrades it to its emby-checkbox the way it
            // upgrades its own templates; its createElement shim does not take an options object.
            label.innerHTML = '<input is="emby-checkbox" type="checkbox"/><span class="je-policy-lock-text">Lock</span>';
            const checkbox = label.querySelector('input');
            checkbox.dataset.lockKey = entry.Key;
            checkbox.setAttribute('aria-label', 'Lock ' + name + ' for every user');
            const old = previous.get(entry.Key);
            const keepEdit = old && old.checkbox && (state.changedAt.get(entry.Key) || 0) > changesAtStart;
            checkbox.checked = keepEdit ? old.checkbox.checked : entry.Locked === true;
            checkbox.addEventListener('change', () => {
                state.changes += 1;
                state.changedAt.set(entry.Key, state.changes);
                refresh();
            });
            lockCell.appendChild(label);

            row.append(nameCell, valueCell, reachCell, lockCell);
            body.appendChild(row);
            state.byKey.set(entry.Key, { entry, control, name, checkbox });
        });
    }

    /**
     * Fetches the registry and (re)renders the policy rows and control badges. Safe to call on
     * every pageshow; only the latest call renders. `ready` is false from the start of every call
     * until its render succeeds: rows from an earlier visit or save may be stale, so a save made
     * meanwhile, or after a failed reload, leaves the saved locks alone.
     * @param {Element} [page] The admin page (#JellyfinEnhancedPage).
     * @param {number} [keepAfter] Keep lock edits made after this value of the edit counter
     *   (a save's: edits made while it was in flight); default, edits made during the request.
     * @returns {Promise<boolean>} Whether the rows were rendered.
     */
    async function decorate(page, keepAfter) {
        page = page || document.querySelector('#JellyfinEnhancedPage');
        if (!page || !page.querySelector('#jeUserSettingsPolicyTable')) return false;
        api.ready = false;
        const run = ++state.run;
        const changesAtStart = typeof keepAfter === 'number' ? Math.min(keepAfter, state.changes) : state.changes;
        // A reload of rows already shown stays quiet; edits made during it are kept by render().
        if (state.page !== page) setStatus(page, 'Loading the user settings policy…');
        let registry;
        try {
            registry = await ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl(REGISTRY_PATH), dataType: 'json' });
            if (!Array.isArray(registry)) throw new Error('unexpected registry answer');
        } catch (error) {
            if (run !== state.run) return false;
            console.warn('[JE] user settings policy: registry request failed', error);
            setStatus(page, 'The user settings policy could not be loaded, so locks cannot be changed right now. Saving keeps the current locks.', true);
            return false;
        }
        if (run !== state.run || !page.isConnected) return false;
        try {
            render(page, registry, changesAtStart);
        } catch (error) {
            console.warn('[JE] user settings policy: render failed', error);
            setStatus(page, 'The user settings policy could not be shown, so locks cannot be changed right now. Saving keeps the current locks.', true);
            return false;
        }
        setStatus(page, '');
        api.ready = true;
        refresh();
        return true;
    }

    /**
     * LockedUserSettings to save: the freshly fetched list minus the rendered keys whose box is
     * unticked, plus the rendered keys whose box is ticked. Keys with no rendered row (unknown to
     * this page, or added by another admin) keep their lock. Null while not ready.
     * @param {string[]|null|undefined} fetched LockedUserSettings of the config the save starts from.
     * @returns {string[]|null}
     */
    function applyLocks(fetched) {
        if (!api.ready) return null;
        const rendered = new Map();
        state.byKey.forEach((item, key) => {
            if (item.checkbox && item.checkbox.isConnected) rendered.set(key.toLowerCase(), item);
        });
        const result = (Array.isArray(fetched) ? fetched : [])
            .filter(entry => typeof entry === 'string' && !rendered.has(entry.toLowerCase()));
        rendered.forEach((item) => { if (item.checkbox.checked) result.push(item.entry.Key); });
        state.submitted = { changes: state.changes, locks: result };
        return result;
    }

    /**
     * The unsaved lock edits as a stable string ('' when there are none), for the page's
     * unsaved-changes check.
     * @returns {string}
     */
    function pendingState() {
        const changed = [];
        state.byKey.forEach((item, key) => {
            if (item.checkbox && item.checkbox.checked !== state.baseline.has(key)) changed.push(key + '=' + item.checkbox.checked);
        });
        return changed.sort().join(',');
    }

    /**
     * Called by the page after a successful save: the saved locks become the baseline, then the
     * registry is read again (saved defaults and reach may have changed). Lock edits made after
     * applyLocks() built the save (while it was in flight) were not saved and stay as edits.
     * Does nothing unless `locked` is the very list the latest applyLocks() returned: a save made
     * while not ready left the locks alone, a reload still in flight keeps the edits made during
     * it, and a save built from the table that then failed is never confirmed by a later one.
     * @param {string[]|null|undefined} locked The LockedUserSettings that was saved.
     */
    function markSaved(locked) {
        if (!state.submitted || !Array.isArray(locked) || locked !== state.submitted.locks) return;
        const saved = new Set(locked.map(entry => String(entry).toLowerCase()));
        state.baseline = new Set(Array.from(state.byKey.keys()).filter(key => saved.has(key.toLowerCase())));
        const keepAfter = state.submitted.changes;
        state.submitted = null;
        refresh();
        if (state.page) decorate(state.page, keepAfter);
    }

    // Loaded after the page's loadConfig already ran: decorate now.
    const loadedPage = document.querySelector('#JellyfinEnhancedPage');
    if (loadedPage && loadedPage.dataset.jeConfigLoaded) decorate(loadedPage);
})();
