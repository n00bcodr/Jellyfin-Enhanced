/**
 * @file The declared fields' values and markup: what a field shows for a
 * configuration, what its control holds, and the control rows themselves.
 */
import type { JsonValue } from '../../../contracts/generated';
import { isDisabled } from './dom';
import { fmt, type FmtParams } from './format';
import type { FieldDef } from './types';
import type { Config } from './values';

/** Escaping and the page's text, bound to the JE escaper at call time. */
export interface TextKit {
    esc(value: unknown): string;
    tx(text: unknown, params?: FmtParams): string;
    perUserMark(): string;
}

const checkbox = (f: FieldDef): boolean => f.type === 'switch' || f.type === 'enable' || f.type === 'ordered';

/**
 * The value a field shows for a configuration.
 * @param f - Field declaration.
 * @param config
 * @returns {JsonValue|undefined}
 */
export function fieldValue(f: FieldDef, config: Config): JsonValue | undefined {
    if (f.secret) return '';
    const raw = config[f.key];
    if (f.read) return f.read(raw, config);
    if (checkbox(f)) return raw === true;
    if (f.type === 'number') {
        const n = Number(raw);
        return Number.isFinite(n) && raw !== null && raw !== '' ? n : f.fallback;
    }
    if (raw === null || raw === undefined) return f.fallback ?? '';
    return f.type === 'pills' || f.type === 'select' ? String(raw) : raw;
}

/**
 * The value a field's control holds, as the configuration stores it.
 * @param f
 * @param el - The control (or, for pills, its group).
 * @param config - For fields whose value depends on another.
 * @returns {JsonValue}
 */
export function controlValue(f: FieldDef, el: Element, config: Config): JsonValue {
    let value: JsonValue;
    const input = el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement ? el : null;
    if (checkbox(f)) value = el instanceof HTMLInputElement ? el.checked : false;
    else if (f.type === 'pills') {
        const chosen = el.querySelector('input:checked');
        value = chosen instanceof HTMLInputElement ? chosen.value : (f.fallback ?? null);
    } else if (f.type === 'number') {
        const n = Math.round(Number(input?.value));
        let out = Number.isFinite(n) ? n : f.fallback;
        if (f.min !== undefined && Number.isFinite(f.min)) out = Math.max(f.min, Number(out));
        if (f.max !== undefined && Number.isFinite(f.max)) out = Math.min(f.max, Number(out));
        value = typeof out === 'number' && !Number.isFinite(out) ? null : (out ?? null);
    } else value = input ? input.value : '';
    if (f.type === 'text' || f.type === 'textarea') value = String(value).trim();
    return f.write ? f.write(value, config) : value;
}

/**
 * An option's label: "=" shows it as written, anything else is page text.
 * @param kit
 * @param label
 * @returns {string}
 */
const optionLabel = (kit: TextKit, label: string): string => (label.startsWith('=') ? kit.esc(label.slice(1)) : kit.tx(label));

/**
 * One field's markup.
 * @param kit
 * @param f
 * @param config
 * @returns {string}
 */
export function fieldHtml(kit: TextKit, f: FieldDef, config: Config): string {
    const { esc, tx } = kit;
    const value = fieldValue(f, config);
    const descId = f.desc ? `${f.id}Desc` : '';
    const described = descId ? ` aria-describedby="${descId}"` : '';
    const data = `data-je-field="${esc(f.key)}" data-je-setting-id="${esc(f.id)}"`;
    // A per-user setting in a card that is not marked as a whole carries the marker itself.
    const label = tx(f.label) + (f.scope === 'new' ? ` ${kit.perUserMark()}` : '');
    const desc = f.desc ? `<span class="je-ta-switch-desc" id="${descId}">${tx(f.desc, f.descParams)}</span>` : '';
    const text = `<span class="je-ta-switch-text"><span class="je-ta-switch-name" data-je-label>${label}</span>${desc}</span>`;
    const labelled = `<span class="je-ta-switch-text"><label class="je-ta-switch-name" for="${esc(f.id)}" data-je-label>${label}</label>${desc}</span>`;
    switch (f.type) {
        case 'switch':
            return `<label class="je-ta-switch${f.master ? ' je-ta-switch--master' : ''}" data-field-row="${esc(f.id)}"><input type="checkbox" id="${esc(f.id)}" ${data} ${value ? 'checked' : ''}${described}>${text}</label>`;
        case 'select':
            return `<div class="je-ta-field" data-field-row="${esc(f.id)}">${labelled}`
                + `<span class="je-ta-field-control"><select id="${esc(f.id)}" ${data}${described}>${(f.options || []).map(([v, k]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${optionLabel(kit, k)}</option>`).join('')}</select></span></div>`;
        case 'number':
        case 'text':
            return `<div class="je-ta-field" data-field-row="${esc(f.id)}">${labelled}`
                + `<span class="je-ta-field-control${f.wide ? ' je-ta-field-control--wide' : ''}"><input type="${f.secret ? 'password' : f.type}" id="${esc(f.id)}" ${data} value="${esc(value)}"${f.secret ? ' autocomplete="new-password" spellcheck="false"' : ''}${f.mask ? ' class="je-ta-masked" autocomplete="off" spellcheck="false"' : ''}${f.type === 'number' ? ` min="${f.min}" max="${f.max}" inputmode="numeric"` : ''}${f.pattern ? ` pattern="${esc(f.pattern)}"` : ''}${f.placeholder ? ` placeholder="${tx(f.placeholder)}"` : ''}${described}>${f.unit ? `<span class="je-ta-unit">${tx(f.unit)}</span>` : ''}</span></div>`;
        case 'textarea':
            return `<div class="je-ta-field je-ta-field--block" data-field-row="${esc(f.id)}">${labelled}`
                + `<span class="je-ta-field-control"><textarea id="${esc(f.id)}" ${data} rows="${f.rows || 4}" spellcheck="false"${f.pattern ? ` pattern="${esc(f.pattern)}"` : ''}${f.placeholder ? ` placeholder="${tx(f.placeholder)}"` : ''}${described}>${esc(value)}</textarea></span></div>`;
        case 'pills':
            return `<div class="je-ta-field" data-field-row="${esc(f.id)}"><span class="je-ta-switch-text"><span class="je-ta-switch-name" id="${esc(f.id)}Label" data-je-label>${label}</span>${desc}</span>`
                + `<span class="je-ta-field-control"><span class="je-ta-pills" role="radiogroup" id="${esc(f.id)}" ${data} aria-labelledby="${esc(f.id)}Label"${described}>${(f.options || []).map(([v, k]) => `<label class="je-ta-pill"><input type="radio" name="${esc(f.id)}" value="${esc(v)}" ${String(v) === String(value) ? 'checked' : ''}><span>${optionLabel(kit, k)}</span></label>`).join('')}</span></span></div>`;
        default:
            return '';
    }
}

/**
 * The ordered fields of a section as one reorderable list, sorted by their
 * order keys (ties: declaration order).
 * @param kit
 * @param fields - Consecutive `ordered` fields.
 * @param config
 * @returns {string}
 */
export function orderedHtml(kit: TextKit, fields: readonly FieldDef[], config: Config): string {
    const { esc, tx } = kit;
    const ranked = fields.map((f, i) => {
        const stored = f.orderKey === undefined ? undefined : config[f.orderKey];
        return { f, i, n: Number.isFinite(Number(stored)) ? Number(stored) : Number(f.defaultOrder) };
    }).sort((a, b) => (a.n - b.n) || (Number(a.f.defaultOrder) - Number(b.f.defaultOrder)) || (a.i - b.i));
    // Phone: the order buttons show only in reorder mode (the button above the list).
    return `<button type="button" class="je-ta-button je-ta-reorder" data-order-reorder aria-pressed="false"><span class="material-icons" aria-hidden="true">swap_vert</span><span>${tx('Reorder categories')}</span></button>`
        + `<ol class="je-ta-order" data-ordered-list>${ranked.map(({ f }, i) => {
            const name = fmt(f.label);
            return `<li data-ordered="${esc(f.id)}"><span class="je-ta-rank" aria-hidden="true">${i + 1}</span>`
                + `<label><input type="checkbox" id="${esc(f.id)}" data-je-field="${esc(f.key)}" data-je-setting-id="${esc(f.id)}" ${config[f.key] === true ? 'checked' : ''}><span class="je-ta-order-name" data-je-label>${esc(name)}</span></label>`
                + `<button type="button" class="je-ta-icon-btn" data-move="-1" aria-label="${tx('Move {name} up', { name })}" ${i === 0 ? 'disabled' : ''}><span class="material-icons" aria-hidden="true">arrow_upward</span></button>`
                + `<button type="button" class="je-ta-icon-btn" data-move="1" aria-label="${tx('Move {name} down', { name })}" ${i === ranked.length - 1 ? 'disabled' : ''}><span class="material-icons" aria-hidden="true">arrow_downward</span></button></li>`;
        }).join('')}</ol>`;
}

/**
 * A section's declared fields: switches, other fields and ordered lists in
 * runs, in declaration order. Enable, custom and section-placed fields are skipped.
 * @param kit
 * @param fields
 * @param config
 * @returns {string}
 */
export function fieldsHtml(kit: TextKit, fields: readonly FieldDef[] | undefined, config: Config): string {
    const out: string[] = [];
    let run: FieldDef[] = [];
    let kind = '';
    const flush = () => {
        if (!run.length) return;
        if (kind === 'ordered') out.push(orderedHtml(kit, run, config));
        else out.push(`<div class="${kind === 'switch' ? 'je-ta-switches' : 'je-ta-fields'}">${run.map((f) => fieldHtml(kit, f, config)).join('')}</div>`);
        run = [];
    };
    // Fields sharing a `more` key sit under one closed disclosure (its key names it), as the page's advanced groups do.
    let more = '';
    const close = () => { if (more) out.push('</div></details>'); more = ''; };
    for (const f of fields || []) {
        if (f.type === 'enable' || f.type === 'custom' || f.place === 'section') continue;
        const k = f.type === 'switch' ? 'switch' : f.type === 'ordered' ? 'ordered' : 'field';
        if ((f.more || '') !== more) {
            flush(); close(); kind = '';
            if (f.more) { more = f.more; out.push(`<details class="je-ta-more" data-more="${kit.esc(more)}"><summary class="je-ta-more-toggle"><span class="material-icons" aria-hidden="true">expand_more</span>${kit.tx(more)}</summary><div class="je-ta-more-body">`); }
        }
        if (k !== kind || f.break) flush();
        kind = k;
        run.push(f);
    }
    flush();
    close();
    return out.join('');
}

/**
 * Replace a list's markup, keeping keyboard focus on the same control of the
 * new markup: a redraw that is not the administrator's own action (a poll,
 * another view's save, a late answer) must not drop focus to the page.
 * @param list
 * @param html
 * @param selectorOf - The focused control's selector within the list, or null when it is not kept.
 */
export function redrawList(list: Element, html: string, selectorOf: (el: HTMLElement) => string | null): void {
    const active = document.activeElement;
    const selector = active instanceof HTMLElement && active !== list && list.contains(active) ? selectorOf(active) : null;
    list.innerHTML = html;
    const again = selector ? list.querySelector(selector) : null;
    if (again instanceof HTMLElement && !isDisabled(again)) again.focus({ preventScroll: true });
}
