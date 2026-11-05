/** The Custom rules editor: bounded rows, existing library suggestions and reserved labels. */
(function(JE) {
    'use strict';
    /** A string from the locale files, escaped for markup. */
    const tr = (key, params) => (typeof JE.t === 'function' ? JE.t(key, params) : key);
    const trHtml = (key, params) => String(tr(key, params)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const customHtml = () => `<div id="customTagRules" class="je-ct-rules" role="table" aria-describedby="customTagRulesHelp">
                                        <div class="je-ct-row je-ct-head" role="row">
                                            <span role="columnheader">${trHtml('custom_tags_rules_col_match')}</span><span role="columnheader">${trHtml('custom_tags_rules_col_value')}</span><span role="columnheader">${trHtml('custom_tags_rules_col_label')}</span><span role="columnheader">${trHtml('custom_tags_rules_col_icon')}</span><span role="columnheader"><span class="je-ct-sr">${trHtml('custom_tags_rules_col_remove')}</span></span>
                                        </div>
                                        <div id="customTagRuleRows" role="rowgroup"></div>
                                    </div>
                                    <div class="je-ct-actions">
                                        <button id="customTagRuleAdd" is="emby-button" type="button" class="raised raised-mini emby-button"><span>${trHtml('custom_tags_rules_add')}</span></button>
                                        <span id="customTagRulesStatus" class="fieldDescription" role="status" aria-live="polite"></span>
                                    </div>
                                    <datalist id="customTagTagOptions"></datalist>
                                    <datalist id="customTagCollectionOptions"></datalist>`;
    function createCustomTagRules(root, onChange = () => {}, isCurrent = () => true) {
        const byId = (id) => root.querySelector('#' + id);

        var MAX_RULES = 20;
        var MAX_LABEL = 24;
        // The genre icons the bundled Material Symbols subset carries (js/tags/customtags.js ICONS).
        var ICONS = ['theaters', 'sports_martial_arts', 'explore', 'animation', 'mood', 'local_police', 'article', 'theater_comedy',
            'family_restroom', 'auto_awesome', 'history_edu', 'skull', 'music_note', 'psychology_alt', 'favorite', 'science', 'tv',
            'psychology', 'military_tech', 'landscape', 'domino_mask', 'music_video', 'menu_book', 'sports_soccer', 'quiz', 'live_tv'];
        var rows = [];
        var sourcesLoaded = false;
        var onLabels = null;

        /** Read a key in either case (the server sends PascalCase). */
        function pick(obj, key) {
            if (!obj || typeof obj !== 'object') return undefined;
            if (obj[key] !== undefined && obj[key] !== null) return obj[key];
            var pascal = key.charAt(0).toUpperCase() + key.slice(1);
            return obj[pascal] !== undefined && obj[pascal] !== null ? obj[pascal] : undefined;
        }

        /**
         * Trimmed, with runs of white space and control characters as one space, as
         * the server stores names and labels (CustomTagRuleSet.Collapse).
         */
        function clean(text) {
            return String(text || '').replace(/[\p{White_Space}\p{Cc}]+/gu, ' ').replace(/^ | $/g, '');
        }

        /**
         * A label of punctuation only, such as "*" (Tag Styles' whole-group key): the
         * server drops such rules. The definition is CustomTagRuleSet.IsReservedLabel's:
         * every Unicode scalar value (the u flag matches code points, so U+10100 is one)
         * is in general category P or has the White_Space property.
         */
        function isReservedLabel(text) {
            var label = clean(text);
            return label !== '' && /^[\p{P}\p{White_Space}]+$/u.test(label);
        }

        /**
         * The rows as the server stores them: complete rows only, labels cut to
         * 24 characters, repeated match/name pairs dropped (the first wins).
         * @returns {Array<{Match: string, Value: string, Label: string, Icon: string|null}>}
         */
        function collectRules() {
            var seen = {};
            var out = [];
            rows.forEach(function (r) {
                var value = clean(r.value);
                var label = clean(r.label).slice(0, MAX_LABEL).replace(/ $/, '');
                var key = r.match + ':' + value.toLowerCase();
                if (!value || !label || isReservedLabel(label) || seen[key] || out.length >= MAX_RULES) return;
                seen[key] = true;
                out.push({ Match: r.match, Value: value, Label: label, Icon: ICONS.indexOf(r.icon) >= 0 ? r.icon : null });
            });
            return out;
        }

        /** @returns {string[]} The distinct labels of the complete rows, in table order (Tag Styles' custom labels). */
        function labels() {
            var out = [];
            collectRules().forEach(function (r) { if (out.indexOf(r.Label) < 0) out.push(r.Label); });
            return out;
        }

        /** Tell the page (unsaved-changes check, Tag Styles) that the rules changed. */
        function changed() {
            var box = byId('customTagRules');
            if (!isCurrent()) return;
            onChange(collectRules());
            if (typeof onLabels === 'function') onLabels();
        }

        /** The library's tags and collections for the name suggestions, fetched once. */
        function loadSources() {
            if (sourcesLoaded || typeof ApiClient === 'undefined') return;
            sourcesLoaded = true;
            var userId = ApiClient.getCurrentUserId();
            var fill = function (id, names) {
                var list = byId(id);
                if (!isCurrent() || !list) return;
                list.textContent = '';
                names.slice().sort(function (a, b) { return a.localeCompare(b); }).forEach(function (name) {
                    var option = document.createElement('option');
                    option.value = name;
                    list.appendChild(option);
                });
            };
            // Filters2 lists every library's tags (the legacy Filters needs a parent folder).
            ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('Items/Filters2', { UserId: userId, Recursive: true }), dataType: 'json' })
                .then(function (r) { fill('customTagTagOptions', (r && Array.isArray(r.Tags) ? r.Tags : []).filter(Boolean)); })
                .catch(function () { /* suggestions only */ });
            ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('Items', { UserId: userId, IncludeItemTypes: 'BoxSet', Recursive: true, SortBy: 'SortName', EnableImages: false, EnableUserData: false }), dataType: 'json' })
                .then(function (r) { fill('customTagCollectionOptions', (r && Array.isArray(r.Items) ? r.Items : []).map(function (i) { return i.Name; }).filter(Boolean)); })
                .catch(function () { /* suggestions only */ });
        }

        /** Redraw the rows from the state (keyboard focus stays on the same control of the same row). */
        function render() {
            var box = byId('customTagRuleRows');
            if (!box) return;
            var active = document.activeElement;
            var keep = null;
            if (active && box.contains(active)) {
                var activeRow = active.closest('.je-ct-row');
                var activeCell = active.closest('[role="cell"]');
                keep = activeRow && activeCell ? {
                    index: activeRow.dataset.index,
                    cell: activeCell.className,
                    start: typeof active.selectionStart === 'number' ? active.selectionStart : null,
                    end: typeof active.selectionEnd === 'number' ? active.selectionEnd : null
                } : null;
            }
            box.textContent = '';
            if (!rows.length) {
                var empty = document.createElement('div');
                empty.className = 'je-ct-empty fieldDescription';
                empty.textContent = tr('custom_tags_rules_empty');
                box.appendChild(empty);
            }
            rows.forEach(function (r, index) {
                var n = index + 1;
                var row = document.createElement('div');
                row.className = 'je-ct-row';
                row.setAttribute('role', 'row');
                row.dataset.index = String(index);
                var cell = function (cls, control) {
                    var c = document.createElement('span');
                    c.className = cls;
                    c.setAttribute('role', 'cell');
                    c.appendChild(control);
                    row.appendChild(c);
                    return control;
                };
                var match = document.createElement('select');
                match.setAttribute('aria-label', tr('custom_tags_rules_match_aria', { n: n }));
                [['tag', tr('custom_tags_rules_match_tag')], ['collection', tr('custom_tags_rules_match_collection')]].forEach(function (o) {
                    var option = document.createElement('option');
                    option.value = o[0];
                    option.textContent = o[1];
                    option.selected = r.match === o[0];
                    match.appendChild(option);
                });
                match.addEventListener('change', function () { r.match = match.value; value.setAttribute('list', r.match === 'collection' ? 'customTagCollectionOptions' : 'customTagTagOptions'); changed(); });
                cell('je-ct-match', match);
                var value = document.createElement('input');
                value.type = 'text';
                value.maxLength = 200;
                value.value = r.value;
                value.placeholder = tr('custom_tags_rules_value_placeholder');
                value.setAttribute('list', r.match === 'collection' ? 'customTagCollectionOptions' : 'customTagTagOptions');
                value.setAttribute('aria-label', tr('custom_tags_rules_value_aria', { n: n }));
                value.setAttribute('aria-invalid', String(!clean(r.value)));
                value.addEventListener('focus', loadSources);
                value.addEventListener('input', function () { r.value = value.value; value.setAttribute('aria-invalid', String(!clean(r.value))); changed(); });
                cell('je-ct-value', value);
                var label = document.createElement('input');
                label.type = 'text';
                label.maxLength = MAX_LABEL;
                label.value = r.label;
                label.placeholder = tr('custom_tags_rules_label_placeholder');
                label.setAttribute('aria-label', tr('custom_tags_rules_label_aria', { n: n }));
                var hint = document.createElement('span');
                hint.className = 'je-ct-hint fieldDescription';
                hint.id = 'customTagRuleLabelHint' + index;
                label.setAttribute('aria-describedby', hint.id);
                var checkLabel = function () {
                    var reserved = isReservedLabel(r.label);
                    label.setAttribute('aria-invalid', String(!clean(r.label) || reserved));
                    hint.textContent = reserved ? tr('custom_tags_rules_reserved') : '';
                    hint.hidden = !reserved;
                };
                checkLabel();
                label.addEventListener('input', function () { r.label = label.value; checkLabel(); changed(); });
                cell('je-ct-label', label).parentNode.appendChild(hint);
                var icon = document.createElement('select');
                icon.setAttribute('aria-label', tr('custom_tags_rules_icon_aria', { n: n }));
                [''].concat(ICONS).forEach(function (name) {
                    var option = document.createElement('option');
                    option.value = name;
                    option.textContent = name ? name.replace(/_/g, ' ') : tr('custom_tags_rules_no_icon');
                    option.selected = (r.icon || '') === name;
                    icon.appendChild(option);
                });
                icon.addEventListener('change', function () { r.icon = icon.value || null; changed(); });
                cell('je-ct-icon', icon);
                var remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'raised raised-mini je-ct-remove';
                remove.setAttribute('aria-label', tr('custom_tags_rules_remove_aria', { n: n }));
                remove.innerHTML = '<i class="material-icons" aria-hidden="true">delete</i>';
                remove.addEventListener('click', function () {
                    rows.splice(index, 1);
                    render();
                    var next = root.querySelector('#customTagRuleRows .je-ct-row[data-index="' + Math.min(index, rows.length - 1) + '"] .je-ct-remove')
                        || byId('customTagRuleAdd');
                    if (next) next.focus();
                    changed();
                });
                cell('je-ct-remove-cell', remove);
                box.appendChild(row);
            });
            if (keep) {
                var again = box.querySelector('.je-ct-row[data-index="' + keep.index + '"] [class="' + keep.cell + '"] select, '
                    + '.je-ct-row[data-index="' + keep.index + '"] [class="' + keep.cell + '"] input, '
                    + '.je-ct-row[data-index="' + keep.index + '"] [class="' + keep.cell + '"] button');
                if (again) {
                    again.focus({ preventScroll: true });
                    if (keep.start !== null && typeof again.setSelectionRange === 'function') {
                        try { again.setSelectionRange(keep.start, keep.end); } catch (e) { /* not a text field */ }
                    }
                }
            }
            var add = byId('customTagRuleAdd');
            if (add) add.disabled = rows.length >= MAX_RULES;
            var status = byId('customTagRulesStatus');
            if (status) status.textContent = tr('custom_tags_rules_count', { count: rows.length, max: MAX_RULES });
        }

        /** Load the stored rules into the table. */
        function load(config) {
            rows = (Array.isArray(config.CustomTagRules) ? config.CustomTagRules : []).slice(0, MAX_RULES).map(function (r) {
                var match = String(pick(r, 'match') || '').toLowerCase();
                return {
                    match: match === 'collection' ? 'collection' : 'tag',
                    value: String(pick(r, 'value') || ''),
                    label: String(pick(r, 'label') || ''),
                    icon: ICONS.indexOf(String(pick(r, 'icon') || '')) >= 0 ? String(pick(r, 'icon')) : null
                };
            });
            render();
            if (typeof onLabels === 'function') onLabels();
        }

        /** Write the rules onto the configuration being saved. */
        function collect(config) {
            config.CustomTagRules = collectRules();
        }

        byId('customTagRuleAdd').addEventListener('click', function () {
            if (rows.length >= MAX_RULES) return;
            rows.push({ match: 'tag', value: '', label: '', icon: null });
            render();
            var inputs = root.querySelectorAll('#customTagRuleRows .je-ct-row:last-child input');
            if (inputs[0]) inputs[0].focus();
            changed();
        });


        return {
            load: load,
            collect: collect,
            labels: labels,
            snapshot: function () { return JSON.stringify(collectRules()); },
            onLabelsChanged: function (fn) { onLabels = fn; }
        };
    }
    // Drawn when read, so the table speaks the language loaded by then.
    Object.defineProperty(JE.adminTags, 'CUSTOM_HTML', { get: customHtml, configurable: true, enumerable: true });
    JE.adminTags.createCustomTagRules = createCustomTagRules;
})(window.JellyfinEnhanced);
