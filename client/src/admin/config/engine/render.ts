import type { Attributes, FieldSpec, MarkupItem, OwnSection, SectionItem, SectionMap, SectionSpec, ShowIf } from './schema';
import { MIRROR, isField } from './schema';

const ENTITIES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
export const esc = (value: unknown): string => String(value).replace(/[&<>"]/g, c => ENTITIES[c] ?? c);

const mirrorCondition = (c: ShowIf): ShowIf => (typeof c === 'string' ? c + MIRROR : { ...c, id: c.id + MIRROR });

const mirrorMarkup = (html: string): string =>
    html.replace(/\b(id|for)="([^"]+)"/g, (_match: string, key: string, value: string) => key + '="' + value + MIRROR + '"');

function mirrorItem(item: SectionItem): SectionItem {
    const copy = { ...item };
    if (copy.type === 'group') copy.items = copy.items.map(mirrorItem);
    if (copy.id) copy.id += MIRROR;
    if (isField(copy) && copy.id) {
        copy.manual = true;
        delete copy.prop;
        delete copy.toConfig;
        delete copy.fromConfig;
        delete copy.perUser;
    }
    if (copy.showIf) copy.showIf = mirrorCondition(copy.showIf);
    if (copy.type === 'note' || copy.type === 'html' || copy.type === 'custom') copy.html = mirrorMarkup(copy.html);
    if (copy.type === 'custom') delete copy.init;
    return copy;
}

/** What a section holds: its own items, or the linked copy of another section's. */
export function itemsOf(section: SectionSpec, sections: SectionMap): readonly SectionItem[] {
    if (section.mirrorOf !== undefined) {
        const source = sections[section.mirrorOf];
        return (source?.items ?? source?.fields ?? []).map(mirrorItem);
    }
    return section.items ?? section.fields ?? [];
}

const flat = (items: readonly SectionItem[]): SectionItem[] => items.flatMap(item => (item.type === 'group' ? flat(item.items) : [item]));

/** Every field with an id (including manual ones). */
export function fieldsOf(section: SectionSpec, sections: SectionMap): FieldSpec[] {
    return flat(itemsOf(section, sections)).filter((item): item is FieldSpec => !!item.id && isField(item));
}

export function allFields(sections: SectionMap): FieldSpec[] {
    return Object.values(sections).flatMap(section => fieldsOf(section, sections));
}

/** Fields the engine loads and saves itself. */
export function boundFields(sections: SectionMap): Array<FieldSpec & { prop: string }> {
    return allFields(sections).filter((field): field is FieldSpec & { prop: string } => !!field.prop && !field.manual);
}

const attributes = (values: Attributes | undefined): string =>
    Object.entries(values ?? {}).map(([key, value]) => ` ${key}="${esc(value)}"`).join('');

/** Manual fields have no prop, so the id is capitalised. */
export function propOf(field: FieldSpec): string {
    return field.prop || (field.id ? field.id[0]?.toUpperCase() + field.id.slice(1) : '');
}

export function isPerUser(field: FieldSpec, perUserProps: ReadonlySet<string>): boolean {
    return field.perUser === true || (field.perUser !== false && perUserProps.has(propOf(field)));
}

const BADGE = '<i class="material-icons jea-badge" aria-label="Per-user setting" title="Each user has a personal copy. Existing users keep theirs until you overwrite it.">group</i>';

/** A long description reads as a wall of text, so each sentence gets its own line (unless the author already structured it). */
export function breakLines(html: string | null | undefined): string | null | undefined {
    if (!html || html.length < 140 || /<(br|ul|li|p)\b/i.test(html)) return html;
    return html.replace(/([.!?])\s+(?=[A-Z])/g, (match: string, end: string, offset: number, text: string) =>
        (/(e\.g|i\.e|etc|vs|cf)\.$/i.test(text.slice(Math.max(0, offset - 5), offset + 1)) ? match : end + '<br>'));
}

function descriptionHtml(field: FieldSpec): string {
    return field.desc
        ? `<div class="je-setting-description" data-desc-for="${field.id}"${attributes(field.descAttrs)}><div class="fieldDescription${field.descClass ? ' ' + field.descClass : ''}">${breakLines(field.desc)}</div></div>`
        : '';
}

function optionsHtml(options: ReadonlyArray<readonly [string, string]>): string {
    return options.map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('');
}

function fieldHtml(field: FieldSpec, perUserProps: ReadonlySet<string>): string {
    const desc = descriptionHtml(field);
    const label = field.label ?? '';
    const perUser = isPerUser(field, perUserProps);
    if (field.type === 'toggle') {
        return `<div class="checkboxContainer jea-row${field.main ? ' je-main-feature' : ''}${field.rowClass ? ' ' + field.rowClass : ''}"${attributes(field.rowAttrs)}><label class="jea-toggle"><input id="${field.id}" type="checkbox" class="jea-switch"${attributes(field.attrs)}/><span>${esc(label)}</span>${perUser ? BADGE : ''}</label></div>${desc}`;
    }
    if (field.type === 'position') {
        // Same 2x2 corner picker as the Enhanced panel. A hidden <select> with the same id keeps load/save working.
        const cells = ['top-left', 'top-right', 'bottom-left', 'bottom-right'].map(p => `<button type="button" class="jea-pos-cell" data-pos="${p}" title="${p.replace('-', ' ')}" aria-label="${p.replace('-', ' ')}"></button>`).join('');
        return `<div class="checkboxContainer jea-row jea-pos-row${field.rowClass ? ' ' + field.rowClass : ''}"${attributes(field.rowAttrs)}><label class="jea-pos-label" for="${field.id}">${esc(label || 'Position')}</label><div class="jea-pos" role="group" aria-label="${esc(label || 'Position')}" data-for="${field.id}">${cells}</div><select id="${field.id}" name="${field.id}" hidden${attributes(field.attrs)}>${optionsHtml(field.options)}</select></div>${desc}`;
    }
    const labelHtml = `<label class="inputLabel" for="${field.id}">${esc(label)}${perUser ? BADGE : ''}</label>`;
    let control: string;
    if (field.type === 'select') {
        control = `<select id="${field.id}" name="${field.id}" class="jea-input"${attributes(field.attrs)}>${optionsHtml(field.options)}</select>`;
    } else if (field.type === 'textarea') {
        control = `<textarea id="${field.id}" name="${field.id}" class="jea-input"${attributes(field.attrs)} rows="${field.rows || 3}" placeholder="${esc(field.placeholder || '')}"></textarea>`;
    } else if (field.type === 'number') {
        control = `<input id="${field.id}" name="${field.id}" type="number" class="jea-input"${attributes(field.attrs)} ${field.min !== undefined ? `min="${field.min}"` : ''} ${field.max !== undefined ? `max="${field.max}"` : ''} ${field.step !== undefined ? `step="${field.step}"` : ''} placeholder="${esc(field.placeholder || '')}"/>`;
    } else {
        control = `<input id="${field.id}" name="${field.id}" type="${field.type === 'password' ? 'password' : 'text'}" class="jea-input"${attributes(field.attrs)} autocomplete="off" placeholder="${esc(field.placeholder || '')}"/>`;
    }
    const inline = field.type === 'number' || field.type === 'select';
    return `<div class="inputContainer jea-row${inline ? ' jea-inline' : ''}${field.rowClass ? ' ' + field.rowClass : ''}"${attributes(field.rowAttrs)}>${labelHtml}${control}</div>${desc}`;
}

function showIfWrapper(item: MarkupItem, html: string): string {
    const condition = item.showIf;
    if (condition === undefined) return html;
    const id = typeof condition === 'string' ? condition : condition.id;
    const equals = typeof condition === 'string' ? undefined : condition.equals;
    return `<div data-jea-showif="${esc(id)}"${equals !== undefined ? ` data-jea-equals="${esc(equals)}"` : ''}>${html}</div>`;
}

/** A linked copy looks like its source, without the source's id. */
function sectionLook(source: SectionSpec): Pick<SectionSpec, 'attrs' | 'icon' | 'iconImg'> {
    const { attrs, icon, iconImg } = source;
    return { ...(attrs ? { attrs } : {}), ...(icon ? { icon } : {}), ...(iconImg ? { iconImg } : {}) };
}

export interface RenderState {
    perUserProps: ReadonlySet<string>;
    /** Collected custom-item callbacks, run once the section is in the DOM. */
    inits: Array<(root: Document) => void>;
}

function markupHtml(item: MarkupItem, state: RenderState): string {
    switch (item.type) {
        case 'note': return `<div class="jea-note jea-note-${item.tone || 'info'}">${item.html}</div>`;
        case 'html': return item.html;
        case 'custom':
            if (item.init) state.inits.push(item.init);
            return item.html;
        case 'button': return `<div class="jea-actions"><button type="button" id="${item.id}" class="jea-btn${item.variant ? ' jea-btn-' + item.variant : ''}">${esc(item.label)}</button>${item.hint ? `<span class="jea-hint">${item.hint}</span>` : ''}</div>`;
        case 'group': return `<details class="jea-group"${item.open ? ' open' : ''}><summary>${esc(item.title)}</summary><div class="jea-group-body">${item.items.map(child => itemHtml(child, state)).join('')}</div></details>`;
    }
}

function itemHtml(item: SectionItem, state: RenderState): string {
    return isField(item) ? fieldHtml(item, state.perUserProps) : showIfWrapper(item, markupHtml(item, state));
}

/** The fieldset a section renders to. */
export function sectionHtml(input: SectionSpec, sections: SectionMap, state: RenderState): string {
    const source = input.mirrorOf !== undefined ? sections[input.mirrorOf] : undefined;
    const section: OwnSection | SectionSpec = source
        ? { title: source.title ?? '', ...sectionLook(source), items: itemsOf(input, sections), class: ((source.class || '') + ' jea-mirror').trim() }
        : input;
    const icon = section.iconImg ? `<img class="je-legend-icon-img" data-je-cdn="${esc(section.iconImg)}" alt="">`
        : (section.icon ? `<i class="material-icons je-legend-icon" aria-hidden="true">${section.icon}</i>` : '');
    const items = itemsOf(section, sections);
    // The main toggle stays visible; everything after it sits in .jea-sub, which collapses while the main toggle is off.
    const mainIndex = items.findIndex(item => isField(item) && item.main);
    const top = mainIndex < 0 ? [] : items.slice(0, mainIndex + 1);
    const rest = mainIndex < 0 ? items : items.slice(mainIndex + 1);
    const body = top.map(item => itemHtml(item, state)).join('') + (rest.length ? `<div class="jea-sub">${rest.map(item => itemHtml(item, state)).join('')}</div>` : '');
    const banner = fieldsOf(section, sections).some(field => isPerUser(field, state.perUserProps))
        ? '<div class="jea-apply" hidden><div class="jea-apply-text"></div><span class="jea-apply-actions"><button type="button" class="jea-btn jea-btn-primary jea-apply-sel" title="Copies only the settings listed here into the personal settings of every user">Apply the above</button><button type="button" class="jea-btn jea-apply-btn" title="Copies every plugin setting that users also hold personally into every user, replacing their own values">Apply all plugin settings</button></span></div>' : '';
    return `<fieldset class="jea-section${section.class ? ' ' + section.class : ''}"${section.id ? ` id="${section.id}"` : ''}${attributes(section.attrs)}><legend class="sectionTitle">${icon}${esc(section.title ?? '')}</legend><div class="configSection">${body}</div>${banner}</fieldset>`;
}
