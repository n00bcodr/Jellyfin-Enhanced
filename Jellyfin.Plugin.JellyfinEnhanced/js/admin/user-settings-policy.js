/**
 * @file Admin page (Configuration/configPage.html) add-on: the "User settings policy" table on
 * the Admin tab, whose Lock column is the only place an administrator locks a per-user setting,
 * and an inline chip beside every admin control's label that is also a per-user default.
 *
 * Not part of the client bundle (not in component-scripts.json). The page loads it with a
 * versioned URL and calls window.JellyfinEnhancedAdminPolicy.decorate(page) after every
 * pageshow's loadConfig; decoration is idempotent. The save path takes LockedUserSettings
 * from applyLocks(), which answers only while `ready` is true (rows freshly rendered for this
 * visit); otherwise the saved locks are left alone.
 *
 * It also shows, when the table is opened, how many users follow, keep or changed each default
 * (with a per-user list), runs the "Apply defaults to users" dialog (preview, apply, undo) and the
 * one-time upgrade card. Those read and write only through the admin user-settings routes; nothing
 * is previewed or applied while the page has unsaved changes.
 *
 * Holds code only: every value comes from the authenticated admin routes or the page, and is
 * written with textContent; innerHTML is used only for static, value-free templates.
 */
(function () {
    'use strict';

    const REGISTRY_PATH = '/JellyfinEnhanced/admin/user-settings/registry';
    const OVERVIEW_PATH = '/JellyfinEnhanced/admin/user-settings/overview';
    const APPLY_PATH = '/JellyfinEnhanced/admin/user-settings/apply';
    const UNDO_PATH = '/JellyfinEnhanced/admin/user-settings/undo/';
    const CARD_PATH = '/JellyfinEnhanced/admin/user-settings/upgrade-card';
    const COLUMNS = 7;
    const ROW_ID_PREFIX = 'jePolicyRow-';
    const CHIP_CLASS = 'je-user-default-chip';

    const state = {
        page: null,          // the page element the rows were rendered into
        entries: [],         // lockable registry entries, in registry order
        byKey: new Map(),    // key -> { entry, checkbox, name }
        baseline: new Set(), // keys locked on the server when the rows were rendered or saved
        run: 0,              // decoration sequence; only the latest one renders
        changes: 0,          // admin edits to lock checkboxes, counted
        changedAt: new Map(), // key -> value of `changes` at its last edit
        submitted: null,     // { changes, locks }: the edit counter and the list when applyLocks() last built a save
        registry: [],        // every registry entry with an admin default (the dialog's settings)
        overview: null,      // promise of the last overview answer, dropped after every change
        dialog: null,        // the open "Apply defaults to users" dialog's state
        followNotes: new Map(), // key -> the per-user list's follow lines (with their Undo), kept while the page stays
        applyRuns: null      // the dialog's finished runs (result + Undo), kept while the page stays
    };

    const api = {
        /** True once the policy rows are rendered for the current page and applyLocks() can be trusted. */
        ready: false,
        decorate,
        applyLocks,
        pendingState,
        markSaved,
        openApplyDialog
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
     * Label text without decorative badges, hints and icon glyphs; keeps search highlights.
     * @param {Element|null} element The element.
     * @returns {string}
     */
    function textWithoutHints(element) {
        if (!element) return '';
        const clone = element.cloneNode(true);
        clone.querySelectorAll('a.' + CHIP_CLASS + ', sup, .je-new-badge, .material-icons, .dep-hint-text, .dep-required-icon, [class*="parent-hint-"], .fieldDescription, .checkboxOutline, [aria-hidden="true"], img')
            .forEach(hint => hint.remove());
        return clone.textContent.replace(/\s+/g, ' ').trim();
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
        return textWithoutHints(toggle.closest('label') && toggle.closest('label').querySelector('span')).replace(/^Enable /, '');
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
            const label = textWithoutHints(control.querySelector('label span'));
            name = label ? label + ' (order)' : '';
        } else if (control) {
            const wrapping = control.closest('label');
            const forLabel = Array.from(page.querySelectorAll('label[for]')).find(label => label.htmlFor === control.id);
            name = textWithoutHints(wrapping && wrapping.querySelector('span')) || textWithoutHints(forLabel);
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
     * Where the setting takes effect under the saved configuration, for chip tooltips.
     * @param {object} entry A registry entry.
     * @returns {string}
     */
    function reachText(entry) {
        if (entry.EffectiveReach === 'Both') return 'web overlays and poster images in native TV and phone apps';
        if (entry.Reach === 'Both') return 'Web only (native poster tags are off)';
        return 'Web only';
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
     * Container that groups defaults, so the toggle and position of one tag row, or a category
     * and its order, share one chip.
     * @param {Element} control The control or row.
     * @returns {Element}
     */
    function chipAnchor(control) {
        return control.closest('.je-quality-cat-admin-row')
            || control.closest('.je-tag-row')
            || control.closest('.checkboxContainer, .inputContainer, .selectContainer')
            || control;
    }

    /**
     * Cancels label activation without stopping the page's delegated jump handler. Native
     * keyboard activation (Enter on the link) also dispatches this click.
     * @param {MouseEvent} event The chip click.
     */
    function preventChipLabelActivation(event) {
        event.preventDefault();
    }

    /**
     * Refreshes generated control names from label text, leaving the chip's name out.
     * Keeps existing explicit names unless their reference would include the appended chip.
     * @param {HTMLLabelElement} label The chip's label.
     * @param {Element} text The element whose text names the control and receives the chip.
     */
    function nameControlWithoutChip(label, text) {
        const control = label.control || label.querySelector('input, select, textarea')
            || document.getElementById(label.htmlFor);
        if (!control) return;
        const labelledBy = control.getAttribute('aria-labelledby');
        if (labelledBy) {
            const includesChip = labelledBy.trim().split(/\s+/).some(id => {
                const source = document.getElementById(id);
                return source && source.contains(text);
            });
            if (!includesChip) return;
            control.removeAttribute('aria-labelledby');
        }
        const generated = control.dataset.jeChipName === '1';
        if (control.hasAttribute('aria-label') && !generated) return;
        const name = textWithoutHints(text);
        if (name) {
            control.setAttribute('aria-label', name);
            control.dataset.jeChipName = '1';
        } else if (generated) {
            control.removeAttribute('aria-label');
            delete control.dataset.jeChipName;
        }
    }

    /**
     * Writes (or rewrites) a chip inside each per-user default group's main control label.
     * @param {Element} page The admin page.
     */
    function renderChips(page) {
        page.querySelectorAll('a.' + CHIP_CLASS).forEach(chip => chip.remove());
        const groups = new Map();
        state.byKey.forEach((item) => {
            if (!item.control) return;
            const anchor = chipAnchor(item.control);
            if (!groups.has(anchor)) groups.set(anchor, []);
            groups.get(anchor).push(item);
        });
        groups.forEach((items, anchor) => {
            const label = anchor.querySelector('.checkboxContainer label')
                || anchor.querySelector('label');
            if (!label) return;
            const reach = reachText(items[0].entry);
            const lockedCount = items.filter(item => item.checkbox && item.checkbox.checked).length;
            const fullyLocked = lockedCount === items.length;
            const text = fullyLocked ? 'Locked for users' : lockedCount > 0 ? lockedCount + ' of ' + items.length + ' locked' : 'User default';
            let title = 'User default: each user starts with this value and can change it in their Jellyfin Enhanced panel.';
            if (fullyLocked) title = "Locked for every user: users get this value and can't change it.";
            else if (lockedCount > 0) title = 'User default: ' + lockedCount + ' of ' + items.length + ' of these settings are locked for every user; the rest each user can change in their Jellyfin Enhanced panel.';
            title += ' Applies to: ' + reach + '. ' + (lockedCount > 0 ? 'Click to change ' + (fullyLocked ? 'it' : 'them') : 'Click to lock it') + ' in User settings policy.';
            const accessibleName = title.startsWith(text) ? title : text + '. ' + title;
            const chip = jumpLink('', 'admin', '#' + ROW_ID_PREFIX + items[0].entry.Key, accessibleName);
            chip.classList.add(CHIP_CLASS);
            chip.classList.toggle('je-user-default-chip-locked', fullyLocked);
            chip.classList.toggle('je-user-default-chip-partial', lockedCount > 0 && !fullyLocked);
            chip.title = title;
            const icon = document.createElement('i');
            icon.className = 'material-icons';
            icon.setAttribute('aria-hidden', 'true');
            icon.textContent = lockedCount > 0 ? 'lock' : 'person';
            chip.append(icon, document.createTextNode(text));
            chip.addEventListener('click', preventChipLabelActivation, true);
            // Keep input + text span + checkboxOutline adjacent for emby-checkbox's checked
            // selectors, whether its upgrade runs before or after this decoration.
            const labelText = label.querySelector(':scope > input[type="checkbox"]')
                && (label.querySelector(':scope > span.checkboxLabel') || label.querySelector(':scope > span:not(.checkboxOutline)'));
            const host = labelText || label;
            nameControlWithoutChip(label, host);
            host.insertBefore(chip, host.querySelector(':scope > .dep-required-icon, :scope > .dep-hint-text'));
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
                // Only a Following key resolves to the default once unlocked; any other user gets the
                // stored value back, which for someone who never changed it can be an older default.
                line.textContent = 'Unlocking ' + item.name + ': each user\'s saved value comes back (for users who never changed it, this can be a value copied from an earlier default); users who follow your default keep it (' + value + ').';
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

    /** Updates the summary line, impact text and chips after a lock checkbox changes. */
    function refresh() {
        const page = state.page;
        if (!page) return;
        const lockedNow = Array.from(state.byKey.values()).filter(item => item.checkbox && item.checkbox.checked).length;
        const summary = page.querySelector('#jeUserSettingsPolicySummaryCount');
        if (summary) summary.textContent = state.entries.length + ' settings, ' + lockedNow + ' locked';
        renderImpact(page);
        renderChips(page);
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
        return [textWithoutHints(button && button.querySelector('h3')), textWithoutHints(legend)].filter(Boolean).join(' · ');
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
        if (state.page !== page) {
            state.followNotes = new Map();
            state.applyRuns = null;
        }
        state.page = page;
        state.registry = registry.filter(entry => entry && typeof entry.Key === 'string');
        state.entries = state.registry.filter(entry => entry.Lockable === true);
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
                cell.colSpan = COLUMNS;
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

            // Follow, Kept and Changed: filled from the overview when the table is opened.
            const countCells = ['Following', 'Kept', 'Changed'].map((column) => {
                const cell = document.createElement('td');
                cell.className = 'je-policy-num';
                cell.dataset.count = column;
                return cell;
            });

            row.append(nameCell, valueCell, reachCell, lockCell, ...countCells);
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
        bindPolicyExtras(page);
        watchControls(page);
        state.overview = null;
        if (isDetailsOpen(page)) showCounts(page);
        showUpgradeCard(page);
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

    // ── Counts, per-user list, "Apply defaults to users" and the upgrade card (design C4) ──

    const STATE_TEXT = {
        Following: 'Follows your default',
        Existing: 'Kept from before',
        Chosen: 'Their own choice',
        ChangedByAdmin: 'Set by an administrator',
        NoSettings: 'Hasn\'t used Jellyfin Enhanced yet (will get your current defaults)',
        Corrupt: 'Settings file is corrupt (left untouched)',
        Oversized: 'Settings file is too large to read (left untouched)',
        Unavailable: 'Settings file could not be read'
    };

    const SKIP_TEXT = {
        unknown: 'not a user on this server',
        'no-settings': 'hasn\'t used Jellyfin Enhanced yet, will get your current defaults',
        corrupt: 'settings file is corrupt, left untouched',
        oversized: 'settings file is too large to read, left untouched'
    };

    const FAIL_TEXT = {
        corrupt: 'the file is corrupt',
        unavailable: 'the file could not be read or written',
        oversized: 'the file is too large to read',
        error: 'unexpected error, see the server log'
    };

    const DOCUMENT_TEXT = { Settings: 'settings', HiddenContent: 'hidden-content settings', SpoilerGuard: 'Spoiler Guard preferences' };

    const MODES = [
        {
            id: 'FollowIfUnchanged',
            label: 'Follow my defaults where nothing changes today',
            note: 'Recommended. Only settings that are still a copy of your default start following it, so nobody sees a change now; they then change when you change the default. Users\' own choices are kept.'
        },
        {
            id: 'FollowAll',
            label: 'Follow my defaults for everyone selected',
            note: 'Every selected setting follows your default from now on, including ones users changed for themselves, so values change for some users.'
        },
        {
            id: 'Overwrite',
            label: 'Overwrite with my current values',
            note: 'The old behaviour: copies your current values into the selected settings, also resets every selected user\'s hidden-content settings and Spoiler Guard preferences, and users stop following your defaults. Hidden items, spoiler lists and bookmarks are never touched.'
        }
    ];

    /**
     * "1 user", "2 users".
     * @param {number} count The number.
     * @param {string} noun The singular noun.
     * @returns {string}
     */
    function plural(count, noun) {
        return count + ' ' + noun + (count === 1 ? '' : 's');
    }

    /**
     * Sends a request to an admin route; a JSON error answer is returned as { status, body }.
     * @param {string} type GET or POST.
     * @param {string} path Route path.
     * @param {object} [body] JSON body.
     * @returns {Promise<{status: number, body: *}>}
     */
    async function request(type, path, body) {
        const options = { type, url: ApiClient.getUrl(path), dataType: 'json' };
        if (body !== undefined) {
            options.contentType = 'application/json';
            options.data = JSON.stringify(body);
        }
        try {
            return { status: 200, body: await ApiClient.ajax(options) };
        } catch (error) {
            const status = error && typeof error.status === 'number' ? error.status : 0;
            let answer = null;
            try {
                if (error && typeof error.json === 'function') answer = await error.json();
            } catch (ignored) {
                answer = null;
            }
            return { status, body: answer };
        }
    }

    /**
     * Whether the admin page has unsaved changes (its save dock is marked dirty).
     * @param {Element} page The admin page.
     * @returns {boolean}
     */
    function pageIsDirty(page) {
        const dock = (page || document).querySelector('.je-save-dock');
        return !!(dock && dock.classList.contains('je-dirty'));
    }

    /**
     * Whether the policy table's details element is open.
     * @param {Element} page The admin page.
     * @returns {boolean}
     */
    function isDetailsOpen(page) {
        const details = page.querySelector('#jeUserSettingsPolicyDetails');
        return !!(details && details.open);
    }

    /**
     * The overview (counts and users), fetched once and shared until something changes.
     * @param {boolean} [fresh] Fetch again even when one is cached.
     * @returns {Promise<object|null>} Null when it could not be loaded.
     */
    function loadOverview(fresh) {
        if (!fresh && state.overview) return state.overview;
        const promise = request('GET', OVERVIEW_PATH).then((answer) => {
            if (answer.status !== 200 || !answer.body || !Array.isArray(answer.body.Settings)) {
                if (state.overview === promise) state.overview = null;
                return null;
            }
            return answer.body;
        });
        state.overview = promise;
        return promise;
    }

    /** Forgets the overview and reloads whatever shows it (counts, open per-user lists, upgrade card). */
    function overviewChanged() {
        state.overview = null;
        const page = state.page;
        if (!page || !page.isConnected) return;
        if (isDetailsOpen(page)) showCounts(page);
        refreshUserLists(page);
        showUpgradeCard(page);
    }

    /**
     * Wires the table's open/close toggle (counts load only when it is opened) and the
     * fieldset's apply button, once per page element.
     * @param {Element} page The admin page.
     */
    function bindPolicyExtras(page) {
        const details = page.querySelector('#jeUserSettingsPolicyDetails');
        if (details && !details.dataset.jeCountsBound) {
            details.dataset.jeCountsBound = '1';
            details.addEventListener('toggle', () => { if (details.open) showCounts(page); });
        }
        const button = page.querySelector('#jeApplyDefaultsBtn');
        if (button && !button.dataset.jeBound) {
            button.dataset.jeBound = '1';
            button.addEventListener('click', () => openApplyDialog());
        }
    }

    /**
     * Rewrites the lock impact text when a control that holds a locked setting's admin value
     * changes, or the quality tag categories are reordered, so the text shows the value the lock
     * would enforce now. Bound once per page element.
     * @param {Element} page The admin page.
     */
    function watchControls(page) {
        if (page.dataset.jeImpactBound) return;
        page.dataset.jeImpactBound = '1';
        const update = (event) => {
            if (state.page !== page) return;
            const target = event.target;
            const mirrored = Array.from(state.byKey.values()).some(item => item.control && (item.control === target || item.control.contains(target)));
            if (mirrored) renderImpact(page);
        };
        page.addEventListener('change', update);
        page.addEventListener('input', update);
        const order = page.querySelector('#qualityCategoriesAdmin');
        if (order && typeof MutationObserver === 'function') {
            new MutationObserver(() => { if (state.page === page) renderImpact(page); }).observe(order, { childList: true });
        }
    }

    /**
     * Fills the Follow, Kept and Changed columns from the overview; "Changed" opens the per-user list.
     * @param {Element} page The admin page.
     */
    async function showCounts(page) {
        const status = page.querySelector('#jeUserSettingsPolicyCountsStatus');
        if (status) {
            status.hidden = false;
            status.textContent = 'Counting users…';
        }
        const data = await loadOverview();
        if (state.page !== page) return;
        if (!data) {
            if (status) status.textContent = 'The user counts could not be loaded.';
            return;
        }
        const byKey = new Map(data.Settings.map(entry => [entry.Key, entry]));
        state.byKey.forEach((item, key) => {
            const counts = byKey.get(key);
            const row = page.querySelector('#' + ROW_ID_PREFIX + key);
            if (!row) return;
            row.querySelectorAll('td[data-count]').forEach((cell) => {
                cell.textContent = '';
                const value = counts ? Number(counts[cell.dataset.count]) || 0 : 0;
                const listOpen = cell.dataset.count === 'Changed' && !!row.nextElementSibling && row.nextElementSibling.classList.contains('je-policy-users');
                // An open list keeps its toggle at 0 (after the last user was made to follow), so it can still be closed.
                if (cell.dataset.count === 'Changed' && (value > 0 || listOpen)) {
                    const open = document.createElement('button');
                    open.type = 'button';
                    open.className = 'je-policy-users-toggle';
                    open.textContent = value + ' ›';
                    open.setAttribute('aria-expanded', listOpen ? 'true' : 'false');
                    open.setAttribute('aria-label', plural(value, 'user') + ' changed ' + item.name + ': show users');
                    open.addEventListener('click', () => toggleUserList(page, item, open));
                    cell.appendChild(open);
                } else {
                    cell.textContent = String(value);
                }
            });
        });
        const users = data.Users || {};
        if (status) {
            const parts = [plural(users.WithSettings || 0, 'user') + ' with settings'];
            if (users.WithoutSettings) parts.push(plural(users.WithoutSettings, 'user') + (users.WithoutSettings === 1 ? ' hasn\'t' : ' haven\'t') + ' used Jellyfin Enhanced yet');
            if (users.Orphans) parts.push(plural(users.Orphans, 'folder') + ' with no Jellyfin user');
            const unreadable = (data.Corrupt || []).length + (data.Oversized || []).length + (data.Unavailable || []).length;
            if (unreadable) parts.push(plural(unreadable, 'settings file') + ' could not be read');
            status.textContent = 'Follow: uses your default and changes with it. Kept: a copy of your default. Changed: something else. ' + parts.join(' · ') + '.';
        }
    }

    /**
     * Who a user is, for lists: the name, or the folder id for a folder with no Jellyfin user.
     * @param {object} user An overview or result entry ({ Name, Id|UserId }).
     * @returns {string}
     */
    function userLabel(user) {
        if (user && typeof user.Name === 'string' && user.Name) return user.Name;
        return 'Folder with no Jellyfin user (' + String((user && (user.Id || user.UserId)) || '?') + ')';
    }

    /**
     * Opens or closes the per-user list under a policy row.
     * @param {Element} page The admin page.
     * @param {object} item The row's state.
     * @param {HTMLButtonElement} toggle The count button.
     */
    async function toggleUserList(page, item, toggle) {
        const row = page.querySelector('#' + ROW_ID_PREFIX + item.entry.Key);
        const existing = row && row.nextElementSibling && row.nextElementSibling.classList.contains('je-policy-users') ? row.nextElementSibling : null;
        if (existing) {
            existing.remove();
            toggle.setAttribute('aria-expanded', 'false');
            return;
        }
        const listRow = document.createElement('tr');
        listRow.className = 'je-policy-users';
        const cell = document.createElement('td');
        cell.colSpan = COLUMNS;
        cell.textContent = 'Loading users…';
        listRow.appendChild(cell);
        row.insertAdjacentElement('afterend', listRow);
        toggle.setAttribute('aria-expanded', 'true');
        await loadUserList(page, listRow, item);
    }

    /**
     * Loads one setting's users into a list row. Only the latest load of a row renders; a reload
     * that fails keeps the rows shown and says so in the list's note.
     * @param {Element} page The admin page.
     * @param {Element} listRow The list row.
     * @param {object} item The policy row's state.
     */
    async function loadUserList(page, listRow, item) {
        const cell = listRow.firstElementChild;
        const load = String((Number(listRow.dataset.jeLoad) || 0) + 1);
        listRow.dataset.jeLoad = load;
        const answer = await request('GET', OVERVIEW_PATH + '/' + encodeURIComponent(item.entry.Key));
        if (!listRow.isConnected || listRow.dataset.jeLoad !== load) return;
        if (answer.status !== 200 || !answer.body || !Array.isArray(answer.body.Users)) {
            const message = cell.querySelector('.je-policy-users-message');
            if (!message) {
                cell.textContent = 'The users could not be loaded.';
                const kept = state.followNotes.get(item.entry.Key);
                if (kept && kept.childNodes.length) cell.appendChild(kept);
                return;
            }
            message.textContent = 'The list could not be refreshed: close it and open it again.';
            return;
        }
        renderUserList(page, cell, item, answer.body);
    }

    /**
     * Reloads every open per-user list on the page (after a follow, an apply or an undo changed
     * users), keeping each list's note and its Undo button.
     * @param {Element} page The admin page.
     */
    function refreshUserLists(page) {
        page.querySelectorAll('tr.je-policy-users').forEach((listRow) => {
            const row = listRow.previousElementSibling;
            const key = row && row.id && row.id.indexOf(ROW_ID_PREFIX) === 0 ? row.id.slice(ROW_ID_PREFIX.length) : null;
            const item = key ? state.byKey.get(key) : null;
            if (item && listRow.firstElementChild) loadUserList(page, listRow, item);
        });
    }

    /**
     * Renders one setting's users: name, value and state, with "Make follow default" where the user
     * has something else (values and names via textContent only). Below the table: a line for each
     * follow made from this list, with its own Undo, kept across re-renders and when the list is
     * closed and opened again or the table is rendered again (state.followNotes); and a message
     * line that later messages replace.
     * @param {Element} page The admin page.
     * @param {Element} cell The list cell.
     * @param {object} item The policy row's state.
     * @param {object} data The overview/{key} answer.
     */
    function renderUserList(page, cell, item, data) {
        let note = state.followNotes.get(item.entry.Key) || null;
        let message = cell.querySelector('.je-policy-users-message');
        cell.textContent = '';
        const table = document.createElement('table');
        table.className = 'je-policy-users-table';
        const head = document.createElement('thead');
        const headRow = document.createElement('tr');
        ['User', 'Value', 'State', ''].forEach((title) => {
            const th = document.createElement('th');
            th.scope = 'col';
            th.textContent = title;
            headRow.appendChild(th);
        });
        head.appendChild(headRow);
        table.appendChild(head);
        const body = document.createElement('tbody');
        // Users with something else first, then copies of the default, then followers, then users without settings.
        const rank = user => (['Existing', 'Chosen', 'ChangedByAdmin'].indexOf(user.State) >= 0 ? (user.SameAsDefault ? 1 : 0) : user.State === 'Following' ? 2 : 3);
        const users = data.Users.slice().sort((a, b) => rank(a) - rank(b));
        users.forEach((user) => {
            const tr = document.createElement('tr');
            const name = document.createElement('th');
            name.scope = 'row';
            name.textContent = userLabel(user);
            const value = document.createElement('td');
            const hasValue = ['Following', 'Existing', 'Chosen', 'ChangedByAdmin'].indexOf(user.State) >= 0;
            value.textContent = !hasValue ? '–' : user.Invalid ? '(invalid value)' : describeValue(item.control, user.Value);
            const stateCell = document.createElement('td');
            let text = STATE_TEXT[user.State] || String(user.State || '');
            if (user.State === 'Existing' && user.SameAsDefault) text = 'Copy of your default';
            stateCell.textContent = text;
            const action = document.createElement('td');
            const canFollow = ['Existing', 'Chosen', 'ChangedByAdmin'].indexOf(user.State) >= 0;
            if (canFollow) {
                const follow = document.createElement('button');
                follow.type = 'button';
                follow.className = 'emby-button raised je-policy-follow-btn';
                follow.textContent = 'Make follow default';
                follow.addEventListener('click', () => followForUser(page, cell, item, user, follow, data.Default));
                action.appendChild(follow);
            }
            tr.append(name, value, stateCell, action);
            body.appendChild(tr);
        });
        table.appendChild(body);
        cell.appendChild(table);
        if (!message) {
            message = document.createElement('div');
            message.className = 'je-policy-users-message';
            message.setAttribute('role', 'status');
        }
        if (!note) {
            note = document.createElement('div');
            note.className = 'je-policy-users-note';
            note.setAttribute('role', 'status');
            state.followNotes.set(item.entry.Key, note);
        }
        cell.append(message, note);
    }

    /**
     * "Make follow default" for one user and one setting (FollowAll for that pair), with undo.
     * Refused while the page has unsaved changes. Success is read from the answer for this user:
     * a user skipped or failed by the run, or one whose setting needed no change, is reported as such.
     * @param {Element} page The admin page.
     * @param {Element} cell The list cell.
     * @param {object} item The policy row's state.
     * @param {object} user The user entry.
     * @param {HTMLButtonElement} button The clicked button.
     * @param {*} defaultValue The server default the list was loaded with.
     */
    async function followForUser(page, cell, item, user, button, defaultValue) {
        const note = cell.querySelector('.je-policy-users-note');
        const message = cell.querySelector('.je-policy-users-message');
        if (pageIsDirty(page)) {
            message.textContent = 'Save your changes first: this uses your saved defaults.';
            return;
        }
        message.textContent = '';
        button.disabled = true;
        const overview = await loadOverview();
        const answer = await request('POST', APPLY_PATH, {
            Keys: [item.entry.Key], UserIds: [user.UserId], Mode: 'FollowAll', DryRun: false,
            ConfigEpoch: overview && overview.ConfigEpoch
        });
        if (answer.status === 409) {
            message.textContent = 'Your settings were saved since this list was loaded. Close the list and open it again.';
            state.overview = null;
            return;
        }
        if (answer.status !== 200 || !answer.body) {
            button.disabled = false;
            message.textContent = 'That did not work. Check the server log.';
            return;
        }
        const result = answer.body;
        const sameUser = entry => entry && String(entry.Id || '').toLowerCase() === String(user.UserId || '').toLowerCase();
        const mine = (result.PerUser || []).find(sameUser);
        if (!mine || (mine.Changed || []).indexOf(item.entry.Key) < 0) {
            button.disabled = false;
            const skipped = (result.Skipped || []).find(sameUser);
            const failed = (result.Failed || []).find(sameUser);
            message.textContent = skipped ? userLabel(user) + ': not changed, ' + (SKIP_TEXT[skipped.Reason] || String(skipped.Reason)) + '.'
                : failed ? userLabel(user) + ': not changed (' + (FAIL_TEXT[failed.Reason] || String(failed.Reason)) + ').'
                    : 'Nothing changed for ' + userLabel(user) + ': this setting changed since the list was loaded. Close the list and open it again.';
            overviewChanged();
            return;
        }
        // One line per follow, each with its own Undo: a later follow does not take an earlier one's away.
        const line = document.createElement('div');
        line.className = 'je-policy-follow-line';
        line.textContent = userLabel(user) + ' now follows your default for ' + item.name + '. ';
        if (result.UndoId) line.appendChild(undoButton(result.UndoId, line));
        else if (result.UndoUnavailable) line.appendChild(document.createTextNode('This cannot be undone: the undo record could not be saved. Check the server log.'));
        note.appendChild(line);
        // Until the list is reloaded (overviewChanged), the row shows the default it now follows.
        const userRow = button.closest('tr');
        userRow.querySelector('td:nth-of-type(1)').textContent = describeValue(item.control, defaultValue);
        userRow.querySelector('td:nth-of-type(2)').textContent = STATE_TEXT.Following;
        button.remove();
        overviewChanged();
    }

    /**
     * An Undo button for a finished run; reports what was restored and kept.
     * @param {string} undoId The run's UndoId.
     * @param {Element} target Where the result is written.
     * @returns {HTMLButtonElement}
     */
    function undoButton(undoId, target) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'emby-button raised je-apply-undo';
        button.textContent = 'Undo';
        button.addEventListener('click', async () => {
            button.disabled = true;
            const answer = await request('POST', UNDO_PATH + encodeURIComponent(undoId));
            const line = document.createElement('div');
            line.className = 'je-apply-undo-result';
            if (answer.status === 200 && answer.body) {
                const kept = Number(answer.body.Kept) || 0;
                line.textContent = 'Undone: ' + (Number(answer.body.Restored) || 0) + ' restored'
                    + (kept ? ', ' + kept + ' changed since and kept as they are' : '')
                    + (answer.body.FailedUsers ? ', ' + plural(Number(answer.body.FailedUsers), 'user') + ' could not be restored (see the server log)' : '') + '.'
                    + (answer.body.Pending ? ' Press Undo again to retry them.' : '');
                // Files that could not be read or written stay in the record: the button retries them.
                if (answer.body.Pending) button.disabled = false;
                else button.remove();
                overviewChanged();
            } else {
                line.textContent = answer.status === 409 ? 'This was already undone.'
                    : answer.status === 404 ? 'This can no longer be undone (only the last 20 runs are kept).'
                        : 'The undo did not work. Check the server log.';
                button.disabled = answer.status !== 0 && answer.status !== 500;
            }
            target.appendChild(line);
        });
        return button;
    }

    /**
     * Shows the one-time upgrade card on the Overview and Admin tabs while it is not dismissed and
     * some users still have copies of the defaults that could follow them (counted by the card route).
     * @param {Element} page The admin page.
     */
    async function showUpgradeCard(page) {
        const cards = Array.from(page.querySelectorAll('.je-upgrade-card'));
        if (!cards.length) return;
        // The card route counts on the server and keeps the count until a settings file or the
        // configuration changes, so a visit does not read every user's settings.
        const card = await request('GET', CARD_PATH);
        if (card.status !== 200 || !card.body || card.body.Dismissed !== false) {
            cards.forEach((element) => { element.hidden = true; });
            return;
        }
        const count = card.body.Adoptable ? Number(card.body.Adoptable.Users) || 0 : 0;
        cards.forEach((element) => {
            element.textContent = '';
            element.hidden = count === 0;
            if (!count) return;
            const icon = document.createElement('i');
            icon.className = 'material-icons je-info-icon';
            icon.setAttribute('aria-hidden', 'true');
            icon.textContent = 'group';
            const body = document.createElement('div');
            const text = document.createElement('div');
            text.textContent = (count === 1 ? '1 user still has' : count + ' users still have') + ' copies of your defaults from before user settings could follow them. Make them follow your defaults? Nothing changes for them now; later changes to your defaults will reach them.';
            const actions = document.createElement('div');
            actions.className = 'je-upgrade-card-actions';
            const preview = document.createElement('button');
            preview.type = 'button';
            preview.className = 'emby-button raised button-submit';
            preview.textContent = 'Preview';
            preview.addEventListener('click', () => openApplyDialog({ mode: 'FollowIfUnchanged', preview: true }));
            const dismiss = document.createElement('button');
            dismiss.type = 'button';
            dismiss.className = 'emby-button raised';
            dismiss.textContent = 'Don\'t show again';
            dismiss.addEventListener('click', async () => {
                const answer = await request('POST', CARD_PATH + '/dismiss');
                if (answer.status === 200) cards.forEach((other) => { other.hidden = true; });
            });
            actions.append(preview, dismiss);
            body.append(text, actions);
            element.append(icon, body);
        });
    }

    /**
     * The dialog's settings: every registry key with an admin default, grouped like the policy table.
     * @param {Element} page The admin page.
     * @returns {{name: string, items: {key: string, name: string}[]}[]}
     */
    function settingGroups(page) {
        const groups = new Map();
        state.registry.forEach((entry) => {
            const control = findControl(page, entry);
            const where = groupName(control) || 'Other';
            if (!groups.has(where)) groups.set(where, []);
            groups.get(where).push({ key: entry.Key, name: controlName(page, control, entry), control });
        });
        // In page order, like the policy table; settings without an admin control last.
        const position = items => items.find(item => item.control);
        return Array.from(groups, ([name, items]) => ({ name, items })).sort((a, b) => {
            const first = position(a.items), second = position(b.items);
            if (!first || !second) return (first ? 0 : 1) - (second ? 0 : 1);
            return first.control.compareDocumentPosition(second.control) & 4 ? -1 : 1;
        });
    }

    /**
     * Builds a labelled checkbox or radio (static template, values set as properties).
     * @param {string} type checkbox or radio.
     * @param {string} text Label text.
     * @param {string} [className] Label class.
     * @returns {{label: HTMLLabelElement, input: HTMLInputElement}}
     */
    function choice(type, text, className) {
        const label = document.createElement('label');
        label.className = className || 'je-apply-choice';
        label.innerHTML = type === 'radio' ? '<input type="radio"/><span></span>' : '<input type="checkbox"/><span></span>';
        label.querySelector('span').textContent = text;
        return { label, input: label.querySelector('input') };
    }

    /**
     * Opens the "Apply defaults to users" dialog: settings groups and single settings, users
     * (everyone or selected), mode, then Preview → Apply → Undo. Preview and Apply use the saved
     * configuration and are disabled while the page has unsaved changes; Apply sends back the
     * ConfigEpoch its preview used and is refused when the settings were saved since.
     * @param {{mode?: string, preview?: boolean}} [options] Preselected mode; run the preview at once.
     * @returns {boolean} False when the policy has not loaded.
     */
    function openApplyDialog(options) {
        const page = state.page || document.querySelector('#JellyfinEnhancedPage');
        options = options || {};
        if (!page || !state.registry.length) {
            if (page) setStatus(page, 'The user settings policy has not loaded, so defaults cannot be applied right now. Reload the page and try again.', true);
            return false;
        }
        closeApplyDialog();
        const opener = document.activeElement;
        const backdrop = document.createElement('div');
        backdrop.className = 'je-apply-backdrop';
        const dialog = document.createElement('div');
        dialog.className = 'je-apply-dialog';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', 'jeApplyDialogTitle');
        backdrop.appendChild(dialog);

        const title = document.createElement('h2');
        title.id = 'jeApplyDialogTitle';
        title.textContent = 'Apply defaults to users';
        const intro = document.createElement('div');
        intro.className = 'fieldDescription';
        intro.textContent = 'Uses your saved settings. Preview first: nothing changes until you press Apply, and every run can be undone.';
        const dirty = document.createElement('div');
        dirty.className = 'je-policy-status je-policy-status-error';
        dirty.textContent = 'Save your changes first: Preview and Apply use your saved settings.';
        dirty.hidden = true;

        // Settings
        const settingsSet = document.createElement('fieldset');
        settingsSet.className = 'je-apply-section';
        const settingsLegend = document.createElement('legend');
        settingsLegend.textContent = 'Settings';
        settingsSet.appendChild(settingsLegend);
        const keyBoxes = new Map();
        const groupBoxes = [];
        const groups = settingGroups(page);
        const all = choice('checkbox', 'All settings with a server default (' + state.registry.length + ')', 'je-apply-choice je-apply-all');
        all.input.checked = true;
        settingsSet.appendChild(all.label);
        const groupList = document.createElement('div');
        groupList.className = 'je-apply-groups';
        groups.forEach((group) => {
            const details = document.createElement('details');
            details.className = 'je-apply-group';
            const summary = document.createElement('summary');
            const box = choice('checkbox', group.name + ' (' + group.items.length + ')');
            box.input.checked = true;
            box.label.addEventListener('click', event => event.stopPropagation());
            summary.appendChild(box.label);
            details.appendChild(summary);
            const list = document.createElement('div');
            list.className = 'je-apply-keys';
            const boxes = group.items.map((item) => {
                const single = choice('checkbox', item.name);
                single.input.checked = true;
                single.input.dataset.key = item.key;
                keyBoxes.set(item.key, single.input);
                list.appendChild(single.label);
                return single.input;
            });
            details.appendChild(list);
            groupBoxes.push({ box: box.input, boxes });
            box.input.addEventListener('change', () => {
                boxes.forEach((input) => { input.checked = box.input.checked; });
                selectionChanged();
            });
            boxes.forEach(input => input.addEventListener('change', selectionChanged));
            groupList.appendChild(details);
        });
        all.input.addEventListener('change', () => {
            keyBoxes.forEach((input) => { input.checked = all.input.checked; });
            selectionChanged();
        });
        settingsSet.appendChild(groupList);

        // Users
        const usersSet = document.createElement('fieldset');
        usersSet.className = 'je-apply-section';
        const usersLegend = document.createElement('legend');
        usersLegend.textContent = 'Users';
        usersSet.appendChild(usersLegend);
        const everyone = choice('radio', 'Everyone');
        const selected = choice('radio', 'Selected…');
        everyone.input.name = selected.input.name = 'jeApplyUsers';
        everyone.input.checked = true;
        const userList = document.createElement('div');
        userList.className = 'je-apply-users';
        userList.hidden = true;
        const userBoxes = [];
        usersSet.append(everyone.label, selected.label, userList);
        [everyone.input, selected.input].forEach(input => input.addEventListener('change', () => {
            userList.hidden = !selected.input.checked;
            selectionChanged();
        }));

        // Mode
        const modeSet = document.createElement('fieldset');
        modeSet.className = 'je-apply-section';
        const modeLegend = document.createElement('legend');
        modeLegend.textContent = 'Mode';
        modeSet.appendChild(modeLegend);
        const modeInputs = MODES.map((mode) => {
            const radio = choice('radio', mode.label, 'je-apply-choice je-apply-mode');
            radio.input.name = 'jeApplyMode';
            radio.input.value = mode.id;
            radio.input.checked = mode.id === (options.mode || 'FollowIfUnchanged');
            const note = document.createElement('div');
            note.className = 'fieldDescription je-apply-mode-note';
            note.textContent = mode.note;
            modeSet.append(radio.label, note);
            radio.input.addEventListener('change', selectionChanged);
            return radio.input;
        });

        const summary = document.createElement('div');
        summary.className = 'je-apply-summary';
        summary.setAttribute('role', 'status');
        summary.setAttribute('aria-live', 'polite');

        const buttons = document.createElement('div');
        buttons.className = 'je-apply-buttons';
        const previewButton = document.createElement('button');
        previewButton.type = 'button';
        previewButton.className = 'emby-button raised';
        previewButton.textContent = 'Preview';
        const applyButton = document.createElement('button');
        applyButton.type = 'button';
        applyButton.className = 'emby-button raised button-submit';
        applyButton.textContent = 'Apply';
        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'emby-button raised';
        closeButton.textContent = 'Close';
        buttons.append(previewButton, applyButton, closeButton);

        const runs = applyRunsList();
        dialog.append(title, intro, dirty, settingsSet, usersSet, modeSet, summary, runs, buttons);
        page.appendChild(backdrop);

        const dialogState = { backdrop, opener, preview: null, busy: false, applying: false, timer: 0, signature: '' };
        state.dialog = dialogState;

        /** @returns {{Keys: string[], UserIds: (string[]|null), Mode: string}} The current selection. */
        function selection() {
            const keys = state.registry.map(entry => entry.Key).filter(key => keyBoxes.get(key) && keyBoxes.get(key).checked);
            const userIds = selected.input.checked ? userBoxes.filter(box => box.checked).map(box => box.value) : null;
            const mode = (modeInputs.find(input => input.checked) || modeInputs[0]).value;
            return { Keys: keys, UserIds: userIds, Mode: mode };
        }

        /** Keeps group boxes in step and forgets a preview made for another selection. */
        function selectionChanged() {
            groupBoxes.forEach(({ box, boxes }) => {
                const on = boxes.filter(input => input.checked).length;
                box.checked = on === boxes.length;
                box.indeterminate = on > 0 && on < boxes.length;
            });
            const on = Array.from(keyBoxes.values()).filter(input => input.checked).length;
            all.input.checked = on === keyBoxes.size;
            all.input.indeterminate = on > 0 && on < keyBoxes.size;
            if (dialogState.preview && JSON.stringify(selection()) !== dialogState.signature) {
                dialogState.preview = null;
                summary.textContent = 'The selection changed: preview again.';
            }
            updateButtons();
        }

        /** Enables Preview and Apply only when they can run. */
        function updateButtons() {
            const isDirty = pageIsDirty(page);
            dirty.hidden = !isDirty;
            const current = selection();
            const empty = current.Keys.length === 0 || (current.UserIds !== null && current.UserIds.length === 0);
            previewButton.disabled = dialogState.busy || isDirty || empty;
            applyButton.disabled = dialogState.busy || isDirty || empty || !dialogState.preview;
            // A real run cannot be cancelled: the dialog stays until it reports the result and its Undo.
            closeButton.disabled = dialogState.applying;
        }

        previewButton.addEventListener('click', runPreview);
        applyButton.addEventListener('click', runApply);
        closeButton.addEventListener('click', closeApplyDialog);
        backdrop.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                if (!dialogState.applying) closeApplyDialog();
            } else if (event.key === 'Tab') {
                const focusable = Array.from(dialog.querySelectorAll('button, input, summary')).filter(element => !element.disabled && element.offsetParent !== null);
                if (!focusable.length) return;
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                }
            }
        });
        dialogState.timer = setInterval(updateButtons, 1000);

        /** Runs the dry run for the current selection and shows what it would do (dropped if the selection changes meanwhile). */
        async function runPreview() {
            if (pageIsDirty(page)) return updateButtons();
            const current = selection();
            dialogState.busy = true;
            dialogState.preview = null;
            summary.textContent = 'Previewing…';
            updateButtons();
            const answer = await request('POST', APPLY_PATH, Object.assign({ DryRun: true }, current));
            dialogState.busy = false;
            if (state.dialog !== dialogState) return;
            // The selection can change while the preview runs: its answer is then for another selection.
            if (JSON.stringify(selection()) !== JSON.stringify(current)) {
                summary.textContent = 'The selection changed: preview again.';
                return updateButtons();
            }
            if (answer.status !== 200 || !answer.body) {
                summary.textContent = (answer.body && answer.body.message) || 'The preview did not work. Check the server log.';
                return updateButtons();
            }
            dialogState.preview = answer.body;
            dialogState.signature = JSON.stringify(current);
            renderResult(summary, answer.body, true);
            updateButtons();
        }

        /** Applies the previewed selection (only while it is still the one shown) with the preview's ConfigEpoch, then offers Undo. */
        async function runApply() {
            const preview = dialogState.preview;
            if (!preview || pageIsDirty(page)) return updateButtons();
            if (JSON.stringify(selection()) !== dialogState.signature) {
                dialogState.preview = null;
                summary.textContent = 'The selection changed: preview again.';
                return updateButtons();
            }
            dialogState.busy = true;
            dialogState.applying = true;
            summary.textContent = 'Applying…';
            updateButtons();
            const answer = await request('POST', APPLY_PATH, Object.assign({ DryRun: false, ConfigEpoch: preview.ConfigEpoch }, JSON.parse(dialogState.signature)));
            dialogState.busy = false;
            dialogState.applying = false;
            dialogState.preview = null;
            if (state.dialog !== dialogState) {
                // Closed some other way (the page went away): the counts still have to catch up.
                if (answer.status === 200) overviewChanged();
                return;
            }
            if (answer.status === 409) {
                summary.textContent = 'Your settings were saved since the preview. Preview again before applying.';
                return updateButtons();
            }
            if (answer.status !== 200 || !answer.body) {
                summary.textContent = (answer.body && answer.body.message) || 'Applying did not work. Check the server log.';
                return updateButtons();
            }
            // The run goes in the page-level list, not the summary: a later preview, a selection
            // change or closing the dialog must not take its Undo away.
            summary.textContent = '';
            const run = document.createElement('div');
            run.className = 'je-apply-run';
            renderResult(run, answer.body, false);
            if (answer.body.UndoId) run.appendChild(undoButton(answer.body.UndoId, run));
            runs.hidden = false;
            runs.appendChild(run);
            updateButtons();
            overviewChanged();
        }

        // Users for "Selected…": live users and folders, from the overview.
        loadOverview().then((data) => {
            if (state.dialog !== dialogState) return;
            if (!data || !Array.isArray(data.UserList)) {
                userList.textContent = 'The users could not be loaded; "Everyone" still works.';
                return;
            }
            everyone.label.querySelector('span').textContent = 'Everyone (' + data.UserList.length + ')';
            data.UserList.forEach((user) => {
                const text = userLabel(user) + (user.Settings === 'none' ? ' (hasn\'t used Jellyfin Enhanced yet)' : '');
                const box = choice('checkbox', text);
                box.input.value = user.Id;
                box.input.addEventListener('change', selectionChanged);
                userBoxes.push(box.input);
                userList.appendChild(box.label);
            });
        });

        updateButtons();
        (options.preview ? previewButton : all.input).focus();
        if (options.preview) runPreview();
        return true;
    }

    /**
     * The dialog's list of finished runs, each with its result and Undo. Kept at page level
     * (state.applyRuns) so it survives later previews and closing and reopening the dialog.
     * @returns {HTMLElement}
     */
    function applyRunsList() {
        if (state.applyRuns) return state.applyRuns;
        const runs = document.createElement('div');
        runs.className = 'je-apply-runs';
        runs.setAttribute('role', 'log');
        runs.setAttribute('aria-live', 'polite');
        runs.hidden = true;
        const label = document.createElement('div');
        label.className = 'fieldDescription';
        label.textContent = 'Applied while this page is open (each run can be undone):';
        runs.appendChild(label);
        state.applyRuns = runs;
        return runs;
    }

    /**
     * Writes a preview's or run's outcome: the headline counts, users skipped or failed by name,
     * and a per-user breakdown (all text via textContent).
     * @param {Element} target The summary element, or a finished run's line.
     * @param {object} result The apply route's answer.
     * @param {boolean} isPreview Whether it was a dry run.
     */
    function renderResult(target, result, isPreview) {
        target.textContent = '';
        const updated = Number(result.Updated) || 0;
        const keys = Number(result.KeysChanged) || 0;
        const visible = Number(result.VisibleChanges) || 0;
        const kept = Number(result.KeptChoices) || 0;
        const documents = (result.PerUser || []).filter(user => (user.Documents || []).length).length;
        const head = document.createElement('strong');
        // Users first: the setting count adds up every user's settings, so with several users it is a total.
        const inAll = updated > 1 ? ' in all' : '';
        const keptText = kept ? ' · ' + plural(kept, 'user') + (kept === 1 ? ' keeps their own value' : ' keep their own values') + ' for some settings' : '';
        let text;
        if (result.Mode === 'Overwrite') {
            text = plural(updated, 'user') + (isPreview ? ' will be updated' : ' updated') + ': ' + plural(keys, 'setting') + ' overwritten' + inAll + ' · ' + plural(visible, 'visible change')
                + (documents ? ' · hidden-content or Spoiler Guard preferences reset for ' + plural(documents, 'user') : '');
        } else {
            text = plural(updated, 'user') + (isPreview ? ' will follow' : (updated === 1 ? ' now follows' : ' now follow')) + ' your defaults for ' + plural(keys, 'setting') + inAll + ' · '
                + plural(visible, 'visible change') + keptText;
        }
        if (!updated) text = (isPreview ? 'Nothing to change' : 'Nothing needed changing') + (keptText ? ': ' + keptText.slice(3) : '') + '.';
        head.textContent = text;
        target.appendChild(head);
        if (!isPreview && result.UndoUnavailable) {
            const warning = document.createElement('div');
            warning.className = 'je-policy-status je-policy-status-error';
            warning.textContent = 'These changes cannot be undone: the undo record could not be saved. Check the server log.';
            target.appendChild(warning);
        }

        const notes = [];
        const fresh = (result.Skipped || []).filter(item => item.Reason === 'no-settings').length;
        if (fresh) notes.push(plural(fresh, 'user') + (fresh === 1 ? ' hasn\'t' : ' haven\'t') + ' used Jellyfin Enhanced yet (they will get your current defaults)');
        (result.Skipped || []).filter(item => item.Reason !== 'no-settings').forEach((item) => {
            notes.push(userLabel(item) + ': skipped, ' + (SKIP_TEXT[item.Reason] || String(item.Reason)));
        });
        (result.Failed || []).forEach((item) => {
            notes.push(userLabel(item) + ': ' + (DOCUMENT_TEXT[item.Document] || String(item.Document)) + ' not changed (' + (FAIL_TEXT[item.Reason] || String(item.Reason)) + ')');
        });
        if (notes.length) {
            const list = document.createElement('ul');
            list.className = 'je-reset-result-list';
            notes.forEach((note) => {
                const item = document.createElement('li');
                item.textContent = note;
                list.appendChild(item);
            });
            target.appendChild(list);
        }

        const perUser = (result.PerUser || []).filter(user => (user.Changed || []).length || (user.Kept || []).length || (user.Documents || []).length);
        if (perUser.length) {
            const details = document.createElement('details');
            details.className = 'je-apply-per-user';
            const label = document.createElement('summary');
            label.textContent = 'Show users (' + perUser.length + ')';
            details.appendChild(label);
            const list = document.createElement('ul');
            perUser.forEach((user) => {
                const item = document.createElement('li');
                const parts = [];
                if ((user.Changed || []).length) parts.push(plural(user.Changed.length, 'setting') + ' ' + (result.Mode === 'Overwrite' ? 'overwritten' : 'following') + ((user.Visible || []).length ? ' (' + user.Visible.length + ' visible)' : ''));
                if ((user.Kept || []).length) parts.push(user.Kept.length + ' kept as their own');
                if ((user.Documents || []).length) parts.push(user.Documents.map(name => DOCUMENT_TEXT[name] || name).join(' and ') + ' reset');
                item.textContent = userLabel(user) + ': ' + parts.join(', ');
                list.appendChild(item);
            });
            details.appendChild(list);
            target.appendChild(details);
        }
    }

    /** Closes the dialog (if open) and returns focus to what opened it. */
    function closeApplyDialog() {
        const dialogState = state.dialog;
        if (!dialogState) return;
        state.dialog = null;
        clearInterval(dialogState.timer);
        dialogState.backdrop.remove();
        if (dialogState.opener && typeof dialogState.opener.focus === 'function' && dialogState.opener.isConnected) dialogState.opener.focus();
    }

    // Loaded after the page's loadConfig already ran: decorate now.
    const loadedPage = document.querySelector('#JellyfinEnhancedPage');
    if (loadedPage && loadedPage.dataset.jeConfigLoaded) decorate(loadedPage);
})();
