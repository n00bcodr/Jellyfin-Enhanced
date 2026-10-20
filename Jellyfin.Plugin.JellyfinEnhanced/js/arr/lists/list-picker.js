/**
 * @file Requests & downloads, phase 4c3b: "Add to a list" before a list is chosen. A presenter on an origin
 * (lp.surface): it draws into a root its caller owns, through the origin's and the chosen list's tickets, and reads the
 * person's editable lists only through the reader it is given (b2 wires the list transport). It sends nothing: the
 * caller confirms and sends (lp.authoring). Nothing runs on load; nothing registers itself.
 *
 * - The lists: the person's own playlists first, then playlists shared with them (labelled with their owner), the
 *   collections they may edit, a new playlist (private unless they deliberately make it public) and, for collection
 *   managers only, a new collection. Position: end or start (playlists only; a collection keeps the server's order).
 *   "After a row" belongs to the list page's own Add title, not here.
 * - Choosing an existing list makes it the origin's target (its own ticket and generation).
 * - {@link showResult}: what happened (added, added from the library, partly from the library, not added), with a link
 *   back to the list, only while the origin and that target are current.
 * - {@link canOffer}: the offer gate for an external Add to list: the household switch (effective ArrListAddToListEnabled
 *   under list authoring), a movie or show with a TMDB id, and not an accessible real library item (Jellyfin's own Add
 *   to playlist/collection stays the control there). Page display settings don't hide it.
 *
 * Internal: lp.picker { KEYS, POSITIONS, create, createBody, showResult, canOffer }.
 */
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const lp = JE.internals.arrListPages = JE.internals.arrListPages || {};

    const KEYS = Object.freeze([
        'arr_lists_picker_label', 'arr_lists_picker_playlists', 'arr_lists_picker_collections', 'arr_lists_picker_owned_by',
        'arr_lists_picker_new_playlist', 'arr_lists_picker_new_collection', 'arr_lists_picker_name', 'arr_lists_picker_public',
        'arr_lists_picker_position', 'arr_lists_picker_end', 'arr_lists_picker_start', 'arr_lists_picker_failed',
        'arr_lists_picker_added', 'arr_lists_picker_added_real', 'arr_lists_picker_added_partly', 'arr_lists_picker_skipped',
        'arr_lists_picker_open_list'
    ]);
    const POSITIONS = Object.freeze(['end', 'start']);
    const ID_RE = /^[0-9a-f]{32}$/;

    /** @param {string} key Key. @param {Object} [params] Parameters. @returns {string} Words. */
    const tr = (key, params) => lp.render.tr(key, params);

    /**
     * Whether an external Add to list is offered for a title.
     * @param {{type?: string, tmdbId?: number, absent?: boolean, shownItemId?: string}|null} context The title.
     * @param {Object} config Public config (effective flags).
     * @returns {{offer: boolean, reason?: string}} Decision.
     */
    function canOffer(context, config) {
        if (!(config?.ArrListsEnabled === true && config.ArrListAuthoringEnabled === true && config.ArrListAddToListEnabled === true)) return { offer: false, reason: 'off' };
        if (!context || (context.type !== 'movie' && context.type !== 'tv') || !(Number.isInteger(context.tmdbId) && context.tmdbId > 0)) return { offer: false, reason: 'invalid' };
        if (context.absent !== true && context.shownItemId) return { offer: false, reason: 'native_real' };
        return { offer: true };
    }

    /**
     * The body of a new list holding one entry (its request id comes with the person's confirmation).
     * @param {{create: 'playlist'|'collection', name: string, isPublic?: boolean}} form The picker's form.
     * @param {Object} placeholder NewPlaceholderDto.
     * @returns {Object} Body.
     */
    function createBody(form, placeholder) {
        const entries = [{ type: 'placeholder', placeholder }];
        return form.create === 'playlist' ? { name: form.name, isPublic: form.isPublic === true, entries } : { name: form.name, entries };
    }

    /**
     * The picker.
     * @param {{origin: Object, root: HTMLElement, media: Object, editableLists: function(AbortSignal): Promise<{status: number, body: *}>}} options Options.
     * @returns {{ready: Promise<void>, choose: function(string): void, form: function(): Object|null, destroy: function(): void}} Picker.
     */
    function create({ origin, root, editableLists }) {
        const el = lp.render.el;
        let lists = null;
        let destroyed = false;
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const check = origin.intent('lists');
        const q = sel => root.querySelector(`.je-list-picker ${sel}`);

        /** Shows the fields of the chosen value. @param {string} [choice] Choice (default: the select's). */
        function sync(choice) {
            origin.paint(null, origin.ticket, () => {
                const value = choice ?? q('select[name="list"]')?.value ?? '';
                const fresh = q('[data-je-new]');
                if (fresh) fresh.hidden = !value.startsWith('new-');
                const pub = q('[data-je-public]');
                if (pub) pub.hidden = value !== 'new-playlist';
                const position = q('[data-je-position]');
                if (position) position.hidden = !(value === 'new-playlist' || value.startsWith('playlist:'));
            }, 'picker-sync');
        }

        /** @param {Object} body EditableListsDto. @returns {boolean} Drawn now. */
        function draw(body) {
            const own = (body.playlists || []).filter(p => p.isOwn === true);
            const shared = (body.playlists || []).filter(p => p.isOwn !== true);
            return origin.paint(check, origin.ticket, () => {
                const box = el('div', 'je-list-picker');
                const label = el('label', 'je-list-author-field');
                label.appendChild(el('span', 'je-list-author-label', tr('arr_lists_picker_label')));
                const select = document.createElement('select');
                select.name = 'list';
                const group = (key, items, kind) => {
                    const valid = items.filter(i => ID_RE.test(String(i?.id || '')));
                    if (!valid.length) return;
                    const g = document.createElement('optgroup');
                    g.label = tr(key);
                    for (const item of valid) {
                        const text = kind === 'playlist' && item.isOwn !== true && item.ownerName ? tr('arr_lists_picker_owned_by', { name: item.name, owner: item.ownerName }) : item.name;
                        const option = el('option', '', text);
                        option.value = `${kind}:${item.id}`;
                        g.appendChild(option);
                    }
                    select.appendChild(g);
                };
                group('arr_lists_picker_playlists', own.concat(shared), 'playlist');
                group('arr_lists_picker_collections', body.collections || [], 'collection');
                const add = (value, key) => { const o = el('option', '', tr(key)); o.value = value; select.appendChild(o); };
                add('new-playlist', 'arr_lists_picker_new_playlist');
                if (body.canManageCollections === true) add('new-collection', 'arr_lists_picker_new_collection');
                label.appendChild(select);
                box.appendChild(label);
                const fresh = el('div', 'je-list-picker-new');
                fresh.dataset.jeNew = '';
                const nameLabel = el('label', 'je-list-author-field');
                nameLabel.appendChild(el('span', 'je-list-author-label', tr('arr_lists_picker_name')));
                const name = document.createElement('input');
                name.name = 'name';
                name.setAttribute('maxlength', String(lp.authoring.LIMITS.title));
                nameLabel.appendChild(name);
                fresh.appendChild(nameLabel);
                const pubLabel = el('label', 'je-list-picker-public');
                pubLabel.dataset.jePublic = '';
                const pub = document.createElement('input');
                pub.type = 'checkbox';
                pub.name = 'public';
                pub.checked = false;
                pubLabel.append(pub, el('span', '', tr('arr_lists_picker_public')));
                fresh.appendChild(pubLabel);
                box.appendChild(fresh);
                const positionLabel = el('label', 'je-list-author-field');
                positionLabel.dataset.jePosition = '';
                positionLabel.appendChild(el('span', 'je-list-author-label', tr('arr_lists_picker_position')));
                const position = document.createElement('select');
                position.name = 'position';
                for (const value of POSITIONS) {
                    const o = el('option', '', tr(`arr_lists_picker_${value}`));
                    o.value = value;
                    position.appendChild(o);
                }
                positionLabel.appendChild(position);
                box.appendChild(positionLabel);
                root.appendChild(box);
            }, 'picker');
        }

        const ready = (async () => {
            let answer = null;
            try {
                answer = await editableLists(controller?.signal);
            } catch {
                answer = null;
            }
            if (destroyed || check() !== true) return;
            if (answer?.status !== 200 || !answer.body || typeof answer.body !== 'object') {
                origin.paint(check, origin.ticket, () => root.appendChild(el('div', 'je-list-picker-failed', tr('arr_lists_picker_failed'))), 'picker');
                return;
            }
            // Drawn now, or once the viewer's Spoiler policy is known (the gate holds it until then).
            lists = answer.body;
            draw(answer.body);
            sync();
        })();

        /** Follows the person's choice. @param {Event} e Change. */
        const onChange = (e) => {
            if (e.target?.matches?.('.je-list-picker select[name="list"]') && root.contains(e.target)) picker.choose(e.target.value);
        };
        root.addEventListener('change', onChange);

        const picker = {
            ready,
            /**
             * Chooses a list (an existing one becomes the origin's target) or a new one.
             * @param {string} value 'playlist:<id>', 'collection:<id>', 'new-playlist' or 'new-collection'.
             */
            choose(value) {
                if (!lists || destroyed) return;
                const select = q('select[name="list"]');
                if (!select || ![...select.options].some(o => o.value === value)) return;
                origin.paint(null, origin.ticket, () => { select.value = value; }, 'picker-choice');
                const [kind, id] = value.split(':');
                if (id) origin.selectTarget(id, { listKind: kind });
                sync(value);
            },
            /**
             * What the person chose.
             * @returns {Object|null} {create, name, isPublic?, position} for a new list, {listKind, listId, position} for an
             *   existing one; null before the lists are shown.
             */
            form() {
                if (!lists || destroyed || !origin.current() || !q('select[name="list"]')) return null;
                const value = q('select[name="list"]')?.value || '';
                const position = POSITIONS.includes(q('select[name="position"]')?.value) ? q('select[name="position"]').value : 'end';
                const name = lp.authoring.clean(q('input[name="name"]')?.value);
                if (value === 'new-playlist') return { create: 'playlist', name, isPublic: q('input[name="public"]')?.checked === true, position };
                if (value === 'new-collection') return { create: 'collection', name, position: null };
                const [kind, id] = value.split(':');
                if (!ID_RE.test(id || '')) return null;
                return kind === 'playlist' ? { listKind: 'playlist', listId: id, position } : { listKind: 'collection', listId: id, position: null };
            },
            /** Stops the read and takes the picker away. */
            destroy() {
                destroyed = true;
                controller?.abort();
                root.removeEventListener('change', onChange);
                lp.gate.erase(() => root.querySelectorAll('.je-list-picker, .je-list-picker-failed').forEach(n => n.remove()));
            }
        };
        return picker;
    }

    /**
     * Says what an add did, with a link back to the list, only while the origin and that target are current.
     * @param {{origin: Object, target: Object, root: HTMLElement, listId: string, name: string, result: Object}} options Options.
     * @returns {boolean} Shown.
     */
    function showResult({ origin, target, root, listId, name, result }) {
        if (!target || !ID_RE.test(String(listId || '')) || target.listId !== listId || !target.current()) return false;
        const el = lp.render.el;
        const added = (result?.added || []).length;
        const real = (result?.addedAsItems || []).length;
        const key = added && real ? 'arr_lists_picker_added_partly' : real ? 'arr_lists_picker_added_real' : added ? 'arr_lists_picker_added' : 'arr_lists_picker_skipped';
        return origin.paint(null, target.ticket, () => {
            const box = el('div', 'je-list-picker-result');
            box.setAttribute('role', 'status');
            box.appendChild(el('span', '', tr(key, { list: name })));
            const link = el('a', 'je-list-picker-link', tr('arr_lists_picker_open_list', { list: name }));
            link.setAttribute('href', `#/details?id=${listId}`);
            box.append(' ', link);
            root.appendChild(box);
        }, 'picker-result');
    }

    lp.picker = Object.freeze({ KEYS, POSITIONS, create, createBody, showResult, canOffer });
})(window.JellyfinEnhanced);
