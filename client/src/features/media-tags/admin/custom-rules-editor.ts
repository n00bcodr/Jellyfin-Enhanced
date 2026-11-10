/**
 * @file The Custom rules editor of the Media Tags admin tab (Groups › Custom):
 * bounded rows, existing library suggestions and reserved labels. Publishes
 * JE.adminTags.CUSTOM_HTML (drawn when read) and createCustomTagRules.
 */
import { adminBridge, optionalApiClient } from './host';
import type { JsonValue } from '../../../contracts/generated';
import { find, findAs } from './dom';
import { escapeText, fmt, type FmtParams } from './format';
import type { CreateCustomRules, CustomRule } from './types';
import type { Config } from './values';
import { ICONS, MAX_LABEL, MAX_RULES, clean, collectRules, isReservedLabel, readRows, type Row } from './custom-rules-model';

const tr = fmt;
const trHtml = (key: string, params?: FmtParams): string => escapeText(String(tr(key, params)));
const customHtml = (): string => `<div id="customTagRules" class="je-ct-rules" role="table" aria-describedby="customTagRulesHelp">
                                        <div class="je-ct-row je-ct-head" role="row">
                                            <span role="columnheader">${trHtml('Match')}</span><span role="columnheader">${trHtml('Tag or collection')}</span><span role="columnheader">${trHtml('Label')}</span><span role="columnheader">${trHtml('Icon')}</span><span role="columnheader"><span class="je-ct-sr">${trHtml('Remove')}</span></span>
                                        </div>
                                        <div id="customTagRuleRows" role="rowgroup"></div>
                                    </div>
                                    <div class="je-ct-actions">
                                        <button id="customTagRuleAdd" is="emby-button" type="button" class="raised raised-mini emby-button"><span>${trHtml('Add rule')}</span></button>
                                        <span id="customTagRulesStatus" class="fieldDescription" role="status" aria-live="polite"></span>
                                    </div>
                                    <datalist id="customTagTagOptions"></datalist>
                                    <datalist id="customTagCollectionOptions"></datalist>`;

/** Names from an untrusted answer list (`answer[key]`, mapped by `name`), without blanks. */
function names(answer: unknown, key: string, name: (item: unknown) => unknown): string[] {
    const items: unknown = answer && typeof answer === 'object' ? Reflect.get(answer, key) : undefined;
    return Array.isArray(items) ? items.map(name).filter(Boolean).map(String) : [];
}

const createCustomTagRules: CreateCustomRules = (root, onChange = () => {}, isCurrent = () => true) => {
    const byId = (id: string): HTMLElement | null => find(root, '#' + id);
    let rows: Row[] = [];
    let sourcesLoaded = false;
    let onLabels: (() => void) | null = null;

    /** The distinct labels of the complete rows, in table order (Tag Styles' custom labels). */
    function labels(): string[] {
        const out: string[] = [];
        collectRules(rows).forEach((r) => { if (out.indexOf(r.Label) < 0) out.push(r.Label); });
        return out;
    }

    /** Tell the page (unsaved-changes check, Tag Styles) that the rules changed. */
    function changed(): void {
        if (!isCurrent()) return;
        onChange(collectRules(rows));
        if (typeof onLabels === 'function') onLabels();
    }

    /** The library's tags and collections for the name suggestions, fetched once. */
    function loadSources(): void {
        const client = optionalApiClient();
        if (sourcesLoaded || !client) return;
        sourcesLoaded = true;
        const userId = client.getCurrentUserId?.();
        const fill = (id: string, list: string[]) => {
            const box = byId(id);
            if (!isCurrent() || !box) return;
            box.textContent = '';
            list.slice().sort((a, b) => a.localeCompare(b)).forEach((name) => {
                const option = document.createElement('option');
                option.value = name;
                box.appendChild(option);
            });
        };
        // Filters2 lists every library's tags (the legacy Filters needs a parent folder).
        client.ajax({ type: 'GET', url: client.getUrl('Items/Filters2', { UserId: userId, Recursive: true }), dataType: 'json' })
            .then((r) => fill('customTagTagOptions', names(r, 'Tags', (t) => t)))
            .catch(() => { /* suggestions only */ });
        client.ajax({ type: 'GET', url: client.getUrl('Items', { UserId: userId, IncludeItemTypes: 'BoxSet', Recursive: true, SortBy: 'SortName', EnableImages: false, EnableUserData: false }), dataType: 'json' })
            .then((r) => fill('customTagCollectionOptions', names(r, 'Items', (i) => (i && typeof i === 'object' ? Reflect.get(i, 'Name') : undefined))))
            .catch(() => { /* suggestions only */ });
    }

    /** Redraw the rows from the state (keyboard focus stays on the same control of the same row). */
    function render(): void {
        const box = byId('customTagRuleRows');
        if (!box) return;
        const active = document.activeElement;
        let keep: { index: string | undefined; cell: string; start: number | null; end: number | null } | null = null;
        if (active && box.contains(active)) {
            const activeRow = active.closest('.je-ct-row');
            const activeCell = active.closest('[role="cell"]');
            const text = active instanceof HTMLInputElement ? active : null;
            keep = activeRow instanceof HTMLElement && activeCell ? {
                index: activeRow.dataset.index,
                cell: activeCell.className,
                start: text && typeof text.selectionStart === 'number' ? text.selectionStart : null,
                end: text && typeof text.selectionEnd === 'number' ? text.selectionEnd : null,
            } : null;
        }
        box.textContent = '';
        if (!rows.length) {
            const empty = document.createElement('div');
            empty.className = 'je-ct-empty fieldDescription';
            empty.textContent = tr('No rules yet. Add one to turn a tag or collection into a chip.');
            box.appendChild(empty);
        }
        rows.forEach((r, index) => {
            const n = index + 1;
            const row = document.createElement('div');
            row.className = 'je-ct-row';
            row.setAttribute('role', 'row');
            row.dataset.index = String(index);
            const cell = <T extends HTMLElement>(cls: string, control: T): T => {
                const c = document.createElement('span');
                c.className = cls;
                c.setAttribute('role', 'cell');
                c.appendChild(control);
                row.appendChild(c);
                return control;
            };
            const value = document.createElement('input');
            const match = document.createElement('select');
            match.setAttribute('aria-label', tr('Rule {n} match', { n }));
            [['tag', tr('Tag')], ['collection', tr('Collection')]].forEach(([optionValue = '', label = '']) => {
                const option = document.createElement('option');
                option.value = optionValue;
                option.textContent = label;
                option.selected = r.match === optionValue;
                match.appendChild(option);
            });
            match.addEventListener('change', () => { r.match = match.value; value.setAttribute('list', r.match === 'collection' ? 'customTagCollectionOptions' : 'customTagTagOptions'); changed(); });
            cell('je-ct-match', match);
            value.type = 'text';
            value.maxLength = 200;
            value.value = r.value;
            value.placeholder = tr('e.g. 4K Remaster');
            value.setAttribute('list', r.match === 'collection' ? 'customTagCollectionOptions' : 'customTagTagOptions');
            value.setAttribute('aria-label', tr('Rule {n} tag or collection name', { n }));
            value.setAttribute('aria-invalid', String(!clean(r.value)));
            value.addEventListener('focus', loadSources);
            value.addEventListener('input', () => { r.value = value.value; value.setAttribute('aria-invalid', String(!clean(r.value))); changed(); });
            cell('je-ct-value', value);
            const label = document.createElement('input');
            label.type = 'text';
            label.maxLength = MAX_LABEL;
            label.value = r.label;
            label.placeholder = tr('e.g. Remaster');
            label.setAttribute('aria-label', tr('Rule {n} label', { n }));
            const hint = document.createElement('span');
            hint.className = 'je-ct-hint fieldDescription';
            hint.id = 'customTagRuleLabelHint' + index;
            label.setAttribute('aria-describedby', hint.id);
            const checkLabel = () => {
                const reserved = isReservedLabel(r.label);
                label.setAttribute('aria-invalid', String(!clean(r.label) || reserved));
                hint.textContent = reserved ? tr('Use a letter, number or symbol: punctuation alone (such as *) is reserved, and this rule will not be saved.') : '';
                hint.hidden = !reserved;
            };
            checkLabel();
            label.addEventListener('input', () => { r.label = label.value; checkLabel(); changed(); });
            cell('je-ct-label', label).parentNode?.appendChild(hint);
            const icon = document.createElement('select');
            icon.setAttribute('aria-label', tr('Rule {n} icon', { n }));
            [''].concat(ICONS).forEach((name) => {
                const option = document.createElement('option');
                option.value = name;
                option.textContent = name ? name.replace(/_/g, ' ') : tr('No icon');
                option.selected = (r.icon || '') === name;
                icon.appendChild(option);
            });
            icon.addEventListener('change', () => { r.icon = icon.value || null; changed(); });
            cell('je-ct-icon', icon);
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'raised raised-mini je-ct-remove';
            remove.setAttribute('aria-label', tr('Remove rule {n}', { n }));
            remove.innerHTML = '<i class="material-icons" aria-hidden="true">delete</i>';
            remove.addEventListener('click', () => {
                rows.splice(index, 1);
                render();
                const next = find(root, '#customTagRuleRows .je-ct-row[data-index="' + Math.min(index, rows.length - 1) + '"] .je-ct-remove')
                    || byId('customTagRuleAdd');
                if (next) next.focus();
                changed();
            });
            cell('je-ct-remove-cell', remove);
            box.appendChild(row);
        });
        if (keep) {
            const again = find(box, '.je-ct-row[data-index="' + keep.index + '"] [class="' + keep.cell + '"] select, '
                + '.je-ct-row[data-index="' + keep.index + '"] [class="' + keep.cell + '"] input, '
                + '.je-ct-row[data-index="' + keep.index + '"] [class="' + keep.cell + '"] button');
            if (again) {
                again.focus({ preventScroll: true });
                if (keep.start !== null && again instanceof HTMLInputElement) {
                    try { again.setSelectionRange(keep.start, keep.end); } catch { /* not a text field */ }
                }
            }
        }
        const add = findAs(root, '#customTagRuleAdd', HTMLButtonElement);
        if (add) add.disabled = rows.length >= MAX_RULES;
        const status = byId('customTagRulesStatus');
        if (status) status.textContent = tr('{count} of {max} rules', { count: rows.length, max: MAX_RULES });
    }

    /** Load the stored rules into the table. */
    function load(config: Config): void {
        rows = readRows(config.CustomTagRules);
        render();
        if (typeof onLabels === 'function') onLabels();
    }

    /** Write the rules onto the configuration being saved. */
    function collect(config: Config): void {
        const out: JsonValue = collectRules(rows).map((r: CustomRule) => ({ ...r }));
        config.CustomTagRules = out;
    }

    const add = byId('customTagRuleAdd');
    if (!add) throw new Error('The Custom rules table markup (CUSTOM_HTML) is missing');
    add.addEventListener('click', () => {
        if (rows.length >= MAX_RULES) return;
        rows.push({ match: 'tag', value: '', label: '', icon: null });
        render();
        const inputs = root.querySelectorAll('#customTagRuleRows .je-ct-row:last-child input');
        const first = inputs[0];
        if (first instanceof HTMLElement) first.focus();
        changed();
    });

    return {
        load,
        collect,
        labels,
        snapshot: () => JSON.stringify(collectRules(rows)),
        onLabelsChanged: (fn) => { onLabels = fn; },
    };
};

const JE = adminBridge();
const A = JE.adminTags = JE.adminTags || {};
// Drawn when read, so the table speaks the language loaded by then.
Object.defineProperty(A, 'CUSTOM_HTML', { get: customHtml, configurable: true, enumerable: true });
A.createCustomTagRules = createCustomTagRules;
