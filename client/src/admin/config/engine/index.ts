import type { AdminConfig, JsonValue } from '../domain/config';
import type { AdminEngine, DashboardSource, EngineDashboard, MountOptions } from './api';
import { alertBox, confirmBox } from './dialogs';
import { MountLifecycle } from './lifecycle';
import { initMasonry } from './masonry';
import { wireMirrors, syncMirrors } from './mirrors';
import { allFields, boundFields, esc, fieldsOf, isPerUser, propOf, sectionHtml, type RenderState } from './render';
import type { FieldSpec, SectionSpec, ShowIf, UiValue } from './schema';
import { mountShell } from './shell';

type ChangedField = { props: string[]; labels: string[] };

function controlOf(id: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null {
    const element = document.getElementById(id);
    return element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement ? element : null;
}

function isChecked(control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): boolean {
    return control instanceof HTMLInputElement && control.checked;
}

function read(field: FieldSpec): UiValue | undefined {
    const control = controlOf(field.id);
    if (!control) return undefined;
    return field.type === 'toggle' ? isChecked(control) : control.value;
}

function conditionHolds(controlId: string, equals: string | undefined): boolean {
    const element = controlOf(controlId);
    if (!element) return true;
    if (equals !== undefined) return element.value === equals;
    return element.type === 'checkbox' ? isChecked(element) : !!element.value;
}

/** A section whose main toggle is off hides its sub-settings (search mode and the main toggle itself keep them reachable). */
function syncCollapse(): void {
    document.querySelectorAll('.jea-section').forEach(section => {
        const main = section.querySelector<HTMLInputElement>('.je-main-feature input');
        section.classList.toggle('jea-off', !!main && !main.checked);
    });
}

function syncPos(): void {
    document.querySelectorAll<HTMLElement>('.jea-pos').forEach(group => {
        const select = controlOf(group.dataset.for ?? '');
        group.querySelectorAll<HTMLElement>('.jea-pos-cell').forEach(cell => cell.classList.toggle('on', !!select && select.value === cell.dataset.pos));
    });
}

const conditionOf = (showIf: ShowIf): { id: string; equals?: string | number | boolean | undefined } => (typeof showIf === 'string' ? { id: showIf } : showIf);

/** A text-like field's stored value: its own conversion, or the value as it stands. */
function convert(field: Extract<FieldSpec, { type: 'text' | 'password' | 'textarea' | 'select' | 'position' }>, value: string | number, config: AdminConfig): JsonValue {
    if (!field.toConfig) return value;
    return field.type === 'select' || field.type === 'position' ? field.toConfig(value, config) : field.toConfig(String(value), config);
}

/** Create the engine published as window.JEAdmin. */
export function createEngine(): AdminEngine {
    const sections: Record<string, SectionSpec> = {};
    const perUserProps = new Set<string>();
    const base: Record<string, UiValue | undefined> = {};
    const render: RenderState = { perUserProps, inits: [] };
    const changedByBanner = new WeakMap<Element, ChangedField>();
    let mounted: MountLifecycle | null = null;
    let loadSettle: number | undefined;

    /** Per-field showIf: hide the row and its description until the controlling toggle (or select value) matches. */
    function syncShowIf(): void {
        document.querySelectorAll<HTMLElement>('[data-jea-showif]').forEach(wrapper => {
            wrapper.classList.toggle('jea-dep-hidden', !conditionHolds(wrapper.dataset.jeaShowif ?? '', wrapper.dataset.jeaEquals));
        });
        allFields(sections).forEach(field => {
            if (!field.showIf) return;
            const condition = conditionOf(field.showIf);
            const on = conditionHolds(condition.id, condition.equals === undefined ? undefined : String(condition.equals));
            const control = document.getElementById(field.id);
            const row = control && control.closest('.jea-row');
            if (row) row.classList.toggle('jea-dep-hidden', !on);
            const description = document.querySelector('.je-setting-description[data-desc-for="' + field.id + '"]');
            if (description) description.classList.toggle('jea-dep-hidden', !on);
        });
    }

    /** Show the banner in each section with per-user fields that differ from the last loaded or applied values. */
    function refresh(): void {
        syncMirrors();
        syncCollapse();
        syncPos();
        syncShowIf();
        Object.values(sections).forEach(section => {
            const fields = fieldsOf(section, sections);
            const first = fields[0] && document.getElementById(fields[0].id);
            const box = first && first.closest('fieldset');
            const banner = box && box.querySelector<HTMLElement>('.jea-apply');
            if (!banner) return;
            const changed = fields.filter(field => isPerUser(field, perUserProps) && base[field.id] !== undefined && read(field) !== base[field.id]);
            banner.hidden = !changed.length;
            changedByBanner.set(banner, { props: changed.map(propOf), labels: changed.map(field => field.label ?? '') });
            const text = banner.querySelector('.jea-apply-text');
            if (text) {
                text.innerHTML = '<strong>Save and apply the changes below to all users</strong>'
                    + '<ul>' + changed.map(field => '<li>' + esc(field.label) + '</li>').join('') + '</ul>'
                    + '<span class="jea-apply-hint">Users keep their own values until you apply this.</span>';
            }
        });
    }

    function wireMount(lifecycle: MountLifecycle): void {
        const { signal } = lifecycle;
        document.addEventListener('click', event => {
            const cell = event.target instanceof Element ? event.target.closest<HTMLElement>('.jea-pos-cell') : null;
            if (!cell || !(cell.parentElement instanceof HTMLElement)) return;
            const select = controlOf(cell.parentElement.dataset.for ?? '');
            if (!select) return;
            select.value = cell.dataset.pos ?? '';
            select.dispatchEvent(new Event('change', { bubbles: true }));
            syncPos();
        }, { signal });
        mountShell(lifecycle);
        wireMirrors(lifecycle);
        initMasonry(lifecycle);
        document.querySelectorAll<HTMLElement>('.jea-section').forEach(section => {
            section.addEventListener('change', refresh, { signal });
            section.addEventListener('input', refresh, { signal });
            // Reuses the Overview quick action, which saves first and asks for confirmation.
            section.querySelector('.jea-apply-btn')?.addEventListener('click', () => document.getElementById('resetAllUserSettingsBtn')?.click(), { signal });
            // Hands the changed settings to the page script, which saves and calls apply-user-settings.
            section.querySelector('.jea-apply-sel')?.addEventListener('click', () => {
                const banner = section.querySelector('.jea-apply');
                const changed = banner ? changedByBanner.get(banner) : undefined;
                if (changed && changed.props.length) document.dispatchEvent(new CustomEvent('jea-apply-selected', { detail: changed }));
            }, { signal });
        });
    }

    const engine: AdminEngine = {
        sections,
        mountShell() {
            mountShell(new MountLifecycle());
        },
        alert: alertBox,
        confirm: confirmBox,
        dashboardShim(real?: DashboardSource): EngineDashboard {
            const source = real ?? {};
            return {
                showLoadingMsg: () => source.showLoadingMsg?.(),
                hideLoadingMsg: () => source.hideLoadingMsg?.(),
                processPluginConfigurationUpdateResult: result => source.processPluginConfigurationUpdateResult?.(result),
                alert: options => engine.alert(options),
                confirm: (message, title, callback) => engine.confirm(message, title).then(accepted => {
                    if (typeof callback === 'function') callback(accepted);
                    return accepted;
                }),
            };
        },
        // Register section definitions (called by Configuration/admin/*.js).
        define(definitions) {
            Object.assign(sections, definitions);
        },
        // Replace every <div data-je-section="key"> with its rendered fieldset. Run before the page script queries ids.
        mount(root, options) {
            (root ?? document).querySelectorAll('[data-je-section]').forEach(placeholder => {
                const key = placeholder.getAttribute('data-je-section') ?? '';
                const section = sections[key];
                if (section) placeholder.outerHTML = sectionHtml(section, sections, render);
                else console.warn('[JE] No section definition for', key);
            });
            render.inits.splice(0).forEach(init => init(document));
            if (options?.shell === false) return;
            mounted?.dispose();
            mounted = options?.lifecycle ?? new MountLifecycle();
            wireMount(mounted);
        },
        load(config: AdminConfig) {
            boundFields(sections).forEach(field => {
                const control = controlOf(field.id);
                if (!control) return;
                const raw = config[field.prop];
                const value = field.fromConfig ? field.fromConfig(raw, config) : raw;
                if (field.type === 'toggle') {
                    if (control instanceof HTMLInputElement) control.checked = field.default === true ? value !== false : value === true;
                } else {
                    control.value = String((value === undefined || value === null || value === '') ? (field.default !== undefined ? field.default : '') : value);
                }
                base[field.id] = read(field);
            });
            refresh();
            // Manual fields are loaded by the page right after this call; once they have, record their baselines
            // (for the per-user banner) and re-sync collapse.
            window.clearTimeout(loadSettle);
            loadSettle = window.setTimeout(() => {
                allFields(sections).forEach(field => { if (field.manual) base[field.id] = read(field); });
                refresh();
            }, 0);
        },
        collect(config: AdminConfig) {
            boundFields(sections).forEach(field => {
                const control = controlOf(field.id);
                if (!control) return;
                if (field.type === 'toggle') {
                    const value = isChecked(control);
                    config[field.prop] = field.toConfig ? field.toConfig(value, config) : value;
                } else if (field.type === 'number') {
                    const value = control.value === '' ? (field.default !== undefined ? field.default : 0) : Number(control.value);
                    config[field.prop] = field.toConfig ? field.toConfig(value, config) : value;
                } else {
                    const value = control.value || (field.default !== undefined ? field.default : '');
                    config[field.prop] = convert(field, value, config);
                }
            });
            return config;
        },
        // Call after the overwrite succeeds so the banners clear.
        markApplied() {
            allFields(sections).forEach(field => { base[field.id] = read(field); });
            refresh();
        },
        setPerUser(properties) {
            properties.forEach(property => perUserProps.add(property));
        },
    };
    return engine;
}
