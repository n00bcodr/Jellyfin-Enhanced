/**
 * @file Requests & downloads, phase 4c3b: the entry menu and the note and custom-entry editors of list authoring.
 * Presenters only: they draw into a root their caller owns, every write through their own effects on the caller's
 * ticket (lp.surface: nothing is drawn for a ticket that ended, or once the presenter is destroyed, even by a paint held
 * for the Spoiler policy), every word through the ticket's guarded words, and send nothing; the caller confirms and
 * sends (lp.authoring).
 * Nothing runs on load.
 *
 * - {@link menuItems}: what this person may do with an entry, from the server's actions (lp.authoring.capabilities):
 *   Move up/down only where the row can't be dragged (and never in a collection, whose order is the server's), edit
 *   note, link a custom entry, remove. Request stays on the row.
 * - {@link noteEditor}: the note in a 300-character field; for an entry Spoiler Guard covers (by the ticket's policy;
 *   while it loads everything is covered) the note and the title stay out of the text, labels and tooltips.
 * - {@link customForm}: type, title, year, release date and note, each error in words next to its field; a candidate
 *   without an identity (an arr result without TMDB) can prefill the words only.
 *
 * Internal: lp.actions { KEYS, menuItems, noteEditor, customForm }.
 */
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const lp = JE.internals.arrListPages = JE.internals.arrListPages || {};

    /** The words these presenters use (the English handoff checks them). */
    const KEYS = Object.freeze([
        'arr_lists_author_move_up', 'arr_lists_author_move_down', 'arr_lists_author_note', 'arr_lists_author_link',
        'arr_lists_author_remove', 'arr_lists_author_note_label', 'arr_lists_author_note_label_guarded', 'arr_lists_author_note_count',
        'arr_lists_author_err_title', 'arr_lists_author_err_year', 'arr_lists_author_err_date', 'arr_lists_author_err_note',
        'arr_lists_author_err_type', 'arr_lists_author_custom_title', 'arr_lists_author_custom_type', 'arr_lists_author_custom_year',
        'arr_lists_author_custom_date', 'arr_lists_author_custom_date_hint', 'arr_lists_author_custom_note', 'arr_lists_note_hidden',
        'arr_lists_kind_movie', 'arr_lists_kind_series'
    ]);

    /**
     * The menu of an entry.
     * @param {Object} view The list view (its order and actions).
     * @param {Object} entry The entry.
     * @param {{canDrag?: boolean}} [options] Whether the row can be dragged here.
     * @returns {Array<{id: string, key: string, icon: string, danger?: boolean}>} Items.
     */
    function menuItems(view, entry, options = {}) {
        const can = lp.authoring.capabilities(view, entry);
        const items = [];
        if (can.reorder && options.canDrag !== true && Array.isArray(view.order)) {
            const index = view.order.indexOf(`p:${entry.id}`);
            if (index > 0) items.push({ id: 'move-up', key: 'arr_lists_author_move_up', icon: 'arrow_upward' });
            if (index >= 0 && index < view.order.length - 1) items.push({ id: 'move-down', key: 'arr_lists_author_move_down', icon: 'arrow_downward' });
        }
        if (can.note) items.push({ id: 'note', key: 'arr_lists_author_note', icon: 'edit_note' });
        if (can.link) items.push({ id: 'link', key: 'arr_lists_author_link', icon: 'link' });
        if (can.remove) items.push({ id: 'remove', key: 'arr_lists_author_remove', icon: 'delete', danger: true });
        return items;
    }

    /**
     * Shows a field's error (or clears every one) in the form's alert region.
     * @param {Object} fx The presenter's effects.
     * @param {Object} w Its words.
     * @param {HTMLElement} root Root.
     * @param {Object} result A validation result.
     */
    function report(fx, w, root, result) {
        fx.paint(null, () => {
            for (const field of root.querySelectorAll('[name]')) {
                if (!result.ok && field.name === result.field) field.setAttribute('aria-invalid', 'true');
                else field.removeAttribute('aria-invalid');
            }
            const alert = root.querySelector('[role="alert"]');
            if (alert) lp.surface.put.text(alert, result.ok ? w.none : w.key(result.key));
        }, 'report');
    }

    /**
     * A labelled field.
     * @param {string} tag Tag.
     * @param {string} name Name.
     * @param {Object} label Words.
     * @returns {{wrap: HTMLElement, field: HTMLElement}} Field.
     */
    function field(tag, name, label) {
        const put = lp.surface.put;
        const wrap = put.el('label', 'je-list-author-field');
        wrap.appendChild(put.el('span', 'je-list-author-label', label));
        const input = document.createElement(tag);
        input.name = name;
        wrap.appendChild(input);
        return { wrap, field: input };
    }

    /**
     * The note editor of an entry.
     * @param {{ticket: Object, root: HTMLElement, ph: Object}} options The caller's ticket and root, the entry.
     * @returns {{read: function(): Object, destroy: function(): void}} Editor.
     */
    function noteEditor({ ticket, root, ph }) {
        const put = lp.surface.put;
        const fx = lp.surface.effects({ ticket });
        const w = lp.surface.words(ticket);
        fx.paint(null, () => {
            // Words made now, when the paint runs: the Spoiler policy is the resolved one.
            const covered = w.covered(ph);
            const box = put.el('div', 'je-list-note-editor');
            const label = covered ? w.key('arr_lists_author_note_label_guarded') : w.key('arr_lists_author_note_label', { title: w.title(ph, ph.title || '') });
            const { wrap, field: area } = field('textarea', 'note', label);
            area.setAttribute('maxlength', String(lp.authoring.LIMITS.note));
            put.attr(area, 'aria-label', label);
            const note = w.note(ph, ph.note || '');
            put.value(area, note);
            box.appendChild(wrap);
            if (covered && ph.note) box.appendChild(put.el('div', 'je-list-note-hidden', w.key('arr_lists_note_hidden')));
            box.appendChild(put.el('div', 'je-list-note-count', w.key('arr_lists_author_note_count', { count: note.text.length, max: lp.authoring.LIMITS.note })));
            const alert = put.el('div', 'je-list-author-error');
            alert.setAttribute('role', 'alert');
            box.appendChild(alert);
            root.appendChild(box);
        }, 'note-editor');
        return {
            /** @returns {Object} The note, validated (its error shown). */
            read() {
                const area = root.querySelector('textarea[name="note"]');
                const result = lp.authoring.validateNote(area ? area.value : '');
                report(fx, w, root, result);
                return result;
            },
            /** Takes the editor away, for good (nothing held for the Spoiler policy draws it again). */
            destroy() {
                fx.destroy();
                lp.gate.erase(() => root.querySelectorAll('.je-list-note-editor').forEach(n => n.remove()));
            }
        };
    }

    /**
     * The custom entry form.
     * @param {{ticket: Object, root: HTMLElement}} options The caller's ticket and root.
     * @returns {{read: function(): Object, prefill: function(Object): void, destroy: function(): void}} Form.
     */
    function customForm({ ticket, root }) {
        const put = lp.surface.put;
        const fx = lp.surface.effects({ ticket });
        const w = lp.surface.words(ticket);
        fx.paint(null, () => {
            const form = put.el('div', 'je-list-custom-form');
            const type = field('select', 'type', w.key('arr_lists_author_custom_type'));
            for (const [value, key] of [['movie', 'arr_lists_kind_movie'], ['tv', 'arr_lists_kind_series']]) {
                const option = put.el('option', '', w.key(key));
                put.data(option, value);
                type.field.appendChild(option);
            }
            form.appendChild(type.wrap);
            const title = field('input', 'title', w.key('arr_lists_author_custom_title'));
            title.field.setAttribute('maxlength', String(lp.authoring.LIMITS.title));
            form.appendChild(title.wrap);
            const year = field('input', 'year', w.key('arr_lists_author_custom_year'));
            year.field.setAttribute('inputmode', 'numeric');
            form.appendChild(year.wrap);
            const date = field('input', 'date', w.key('arr_lists_author_custom_date'));
            put.attr(date.field, 'placeholder', w.key('arr_lists_author_custom_date_hint'));
            form.appendChild(date.wrap);
            const note = field('textarea', 'note', w.key('arr_lists_author_custom_note'));
            note.field.setAttribute('maxlength', String(lp.authoring.LIMITS.note));
            form.appendChild(note.wrap);
            const alert = put.el('div', 'je-list-author-error');
            alert.setAttribute('role', 'alert');
            form.appendChild(alert);
            root.appendChild(form);
        }, 'custom-form');
        const value = name => root.querySelector(`[name="${name}"]`)?.value ?? '';
        return {
            /** @returns {Object} The entry, validated (its error shown). */
            read() {
                const result = lp.authoring.validateCustom({ type: value('type') || 'movie', title: value('title'), year: value('year'), date: value('date'), note: value('note') });
                report(fx, w, root, result);
                return result;
            },
            /**
             * Fills in the words of a title without an identity (never an id); its year follows the date policy.
             * @param {{title?: string, year?: number, mediaType?: string}} words Words.
             */
            prefill(words) {
                fx.paint(null, () => {
                    const node = name => root.querySelector(`[name="${name}"]`);
                    const kind = words?.mediaType === 'tv' ? 'tv' : 'movie';
                    const entry = { kind: kind === 'tv' ? 'series' : 'movie', mediaType: kind };
                    if (node('title')) put.value(node('title'), w.name(String(words?.title || '').slice(0, lp.authoring.LIMITS.title)));
                    if (node('year')) put.value(node('year'), w.year(entry, { year: words?.year }));
                    if (node('type')) put.data(node('type'), kind);
                }, 'prefill');
            },
            /** Takes the form away, for good. */
            destroy() {
                fx.destroy();
                lp.gate.erase(() => root.querySelectorAll('.je-list-custom-form').forEach(n => n.remove()));
            }
        };
    }

    lp.actions = Object.freeze({ KEYS, menuItems, noteEditor, customForm });
})(window.JellyfinEnhanced);
