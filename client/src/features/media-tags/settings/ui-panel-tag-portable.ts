/**
 * @file Media Tags import, export and presets: the hub's Presets and
 * Import & export cards (bottom of the Layout tab), and the dialogs, file and
 * clipboard helpers the Media Tags admin tab reuses
 * (js/enhanced/admintags/sections/portable.js).
 *
 * A document is `{"v":1,"kind":"je-media-tags-user","settings":{…}}` with the
 * server's PascalCase field names (Shared/MediaTags/MediaTagsPortable.cs); a preset adds
 * an id, a name and a description. Every import is checked by the server first
 * (POST user-settings/{id}/media-tags/preview, the settings save path's
 * validators): the dialog shows what changes and which fields are skipped, and
 * only after a confirmation are the changed fields written into the user's
 * document and saved the usual way. The panel then opens again on the new
 * settings with Undo for a few seconds.
 */
import type { JsonValue } from '../../../contracts/generated';
import { apiClient, optionalApiClient, panelHost, registry, type PanelBridge, type PanelApiClient } from './host';
import type { PanelContext } from '../../settings-panel/public-api';
import { closestTarget, focusElement, queryButton, queryElement, queryElements, setDisabled } from '../../shared/dom';
import { decodePresets, decodePreview, exportedParts, isPresetSource, refusal, savedPreset, statusOf, type PortableChange, type Preset, type PresetList, type PresetSource } from './portable-model';
import { isJson } from '../../shared/settings-values';

type Deps = Pick<PanelBridge, 'internals' | 'core' | 'currentSettings' | 'userConfig' | 'escapeHtml' | 't' | 'session' | 'toCamelCase'
    | 'isSettingInherited' | 'setSettingInherited' | 'saveUserSettings' | 'reinitializeTagLayout' | 'showEnhancedPanel'
    | 'initializeQualityTags' | 'initializeGenreTags' | 'initializeLanguageTags' | 'initializeRatingTags' | 'initializeAgeRatingTags'
    | 'initializeStatusTags' | 'initializeAwardsTags' | 'initializeLogoTags' | 'initializeCustomTags'
    | 'reinitializeQualityTags' | 'reinitializeGenreTags' | 'reinitializeLanguageTags' | 'reinitializeRatingTags' | 'reinitializeAgeRatingTags'
    | 'reinitializeStatusTags' | 'reinitializeAwardsTags' | 'reinitializeLogoTags' | 'reinitializeCustomTags'>;

const PRESET_KIND = 'je-media-tags-preset';
const UNDO_MS = 10000;
const MAX_NAME = 60;
const MAX_DESCRIPTION = 240;
/** Values longer than this are cut in the change list (the whole value is still applied). */
const MAX_VALUE_TEXT = 80;
const ERROR_CODES = ['not-json', 'not-object', 'kind', 'version', 'newer', 'settings', 'name', 'description', 'empty', 'full', 'save'];
const SKIP_REASONS = ['unknown', 'secret', 'signal', 'invalid'];

/** Fields the settings show under their own label (the label key the control uses). */
const FIELD_LABELS: Readonly<Record<string, string>> = {
    TagLayout: 'common_layout',
    TagLabelDensity: 'panel_settings_ui_tag_density',
    TagScale: 'tag_scale_label',
    TagGap: 'tag_gap_label',
    TagEdgeSpacing: 'panel_settings_ui_tag_edge', TagKindLooks: 'tag_kind_looks_title',
    TagStylePreset: 'panel_settings_ui_tag_style_preset',
};
/** Group switches, by the group's vocabulary key. */
const GROUP_FIELDS: Readonly<Record<string, string>> = {
    QualityTagsEnabled: 'quality', GenreTagsEnabled: 'genre', LanguageTagsEnabled: 'language', RatingTagsEnabled: 'rating',
    AgeRatingTagsEnabled: 'age_rating', StatusTagsEnabled: 'status', AwardsTagsEnabled: 'awards', LogoTagsEnabled: 'logos', CustomTagsEnabled: 'custom',
};
const own = <T>(map: Readonly<Record<string, T>>, key: string): T | undefined => Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;

/** A modal dialog drawn inside a host (the settings panel or the admin page). */
export interface PortableDialog {
    el: HTMLElement; body: HTMLElement; foot: HTMLElement;
    status(message: string, kind?: string): void;
    close(): void; focusFirst(): void; closed(): boolean;
}
export interface ButtonOptions { primary?: boolean; icon?: string; params?: Record<string, string | number> }
/** The dialogs, file and clipboard helpers the Media Tags admin tab reuses (internal.tagPortable). */
export interface TagPortableTools {
    openDialog(options: { host: HTMLElement; title: string; className?: string; onClose?: () => void }): PortableDialog;
    previewHtml(preview: unknown, opts?: { summary?: boolean }): string;
    valueText(value: unknown, field?: string): string;
    fieldName(field: unknown): string;
    errorText(code: string, params?: Record<string, string | number>): string;
    errorOf(err: unknown): Promise<{ code: string; max?: unknown }>;
    parseDocument(text: unknown): { document?: object; error?: string };
    download(document: unknown, name: string): void;
    copyText(text: string, fallback?: HTMLTextAreaElement): Promise<boolean>;
    readFile(file: File): Promise<string>;
    sourceHtml(hintKey: string): string;
    wireSource(dialog: PortableDialog): void;
    buttonHtml(action: string, labelKey: string, opts?: ButtonOptions): string;
    injectDialogCss(): void;
    stamp(): string;
}
/** Opened again after an import (internal.tagPortableReopen). */
export interface TagPortableReopen { messageKey: string | null }
export type WireTagPortable = (hub: HTMLElement, ctx: Partial<Pick<PanelContext, 'help' | 'closePanel' | 'openPane' | 'resetAutoCloseTimer'>>, hooks: { announce(message: string): void }) => () => void;

export function installUiPanelTagPortable(JE: Deps): void {
    const internal = registry(JE);

    /**
     * The group switches an import can change, and how the page follows each
     * one live (the same calls the group editor's switches make).
     */
    const GROUP_SWITCHES: ReadonlyArray<{ key: string; group: string; container: string; init(): void; reinit(): void }> = [
        { key: 'qualityTagsEnabled', group: 'quality', container: 'quality-overlay-container', init: () => JE.initializeQualityTags?.(), reinit: () => JE.reinitializeQualityTags?.() },
        { key: 'genreTagsEnabled', group: 'genre', container: 'genre-overlay-container', init: () => JE.initializeGenreTags?.(), reinit: () => JE.reinitializeGenreTags?.() },
        { key: 'languageTagsEnabled', group: 'language', container: 'language-overlay-container', init: () => JE.initializeLanguageTags?.(), reinit: () => JE.reinitializeLanguageTags?.() },
        { key: 'ratingTagsEnabled', group: 'rating', container: 'rating-overlay-container', init: () => JE.initializeRatingTags?.(), reinit: () => JE.reinitializeRatingTags?.() },
        { key: 'ageRatingTagsEnabled', group: 'ageRating', container: 'age-rating-overlay-container', init: () => JE.initializeAgeRatingTags?.(), reinit: () => JE.reinitializeAgeRatingTags?.() },
        { key: 'statusTagsEnabled', group: 'status', container: 'status-overlay-container', init: () => JE.initializeStatusTags?.(), reinit: () => JE.reinitializeStatusTags?.() },
        { key: 'awardsTagsEnabled', group: 'awards', container: 'awards-overlay-container', init: () => JE.initializeAwardsTags?.(), reinit: () => JE.reinitializeAwardsTags?.() },
        { key: 'logoTagsEnabled', group: 'logos', container: 'logo-overlay-container', init: () => JE.initializeLogoTags?.(), reinit: () => JE.reinitializeLogoTags?.() },
        { key: 'customTagsEnabled', group: 'custom', container: 'custom-overlay-container', init: () => JE.initializeCustomTags?.(), reinit: () => JE.reinitializeCustomTags?.() },
    ];

    const esc = (value: unknown) => JE.escapeHtml(String(value ?? ''));
    /** Translated and escaped. */
    const tx = (key: string, params?: Record<string, string | number>) => esc(JE.t(key, params));

    /**
     * The last import applied in this browser tab, for Undo after the panel
     * opened again: the changes it made, until when Undo is offered and
     * whether the session that made it is still the signed-in one.
     */
    let lastImport: { changes: PortableChange[]; until: number; count: number; isCurrent: () => boolean } | null = null;

    // ── Shared helpers (the admin page uses them too) ───────────────────

    /** A field's name as the settings label it ("Tag size", "Genre tags"), else spelled out ("Tag Group Caps"). */
    const fieldName = (field: unknown): string => {
        const key = String(field);
        const vocab = JE.core?.tagLayout?.VOCABULARY_KEYS;
        const label = own(FIELD_LABELS, key);
        if (label && JE.t(label) !== label) return JE.t(label);
        const groupKey = own(GROUP_FIELDS, key);
        const groupLabel = groupKey ? vocab?.group?.[groupKey] : undefined;
        if (groupLabel) {
            const group = JE.t(groupLabel);
            if (group !== groupLabel) return JE.t('tag_portable_field_group', { group });
        }
        return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    };

    /** A field's value as the option the settings show for it ("115%", "Corners"), or null. */
    function optionText(field: string, value: unknown): string | null {
        const L = JE.core?.tagLayout;
        if (!L || typeof value !== 'string' || !value) return null;
        const vocab = L.VOCABULARY_KEYS;
        let key: string | undefined;
        if (field === 'TagScale' && L.TAG_SCALES?.[value] !== undefined) return L.sizeLabel('scale', value);
        if (field === 'TagLayout') key = vocab.layout?.[value];
        else if (field === 'TagLabelDensity') key = `panel_settings_ui_tag_density_${value}`;
        else if (field === 'TagGap') key = vocab.gap?.[value];
        else if (field === 'TagEdgeSpacing') key = vocab.edge?.[value];
        else if (field === 'TagStylePreset') key = vocab.preset?.[value];
        if (!key) return null;
        const text = JE.t(key);
        return text === key ? null : text;
    }

    /** A value as one short line for the change list (`field` names the value as its option). */
    function valueText(value: unknown, field?: string): string {
        if (value === null || value === undefined) return JE.t('tag_portable_value_inherit');
        if (typeof value === 'boolean') return JE.t(value ? 'tag_portable_value_on' : 'tag_portable_value_off');
        const option = field ? optionText(field, value) : null;
        if (option) return option;
        const text = typeof value === 'string' ? (value === '' ? JE.t('tag_portable_value_empty') : value) : String(JSON.stringify(value));
        return text.length > MAX_VALUE_TEXT ? `${text.slice(0, MAX_VALUE_TEXT - 1)}…` : text;
    }

    /** The change list and the skipped list of a preview (summary: false leaves out the "N changes" line). */
    function previewHtml(preview: unknown, opts: { summary?: boolean } = {}): string {
        const { changes, skipped } = decodePreview(preview);
        const rows = changes.map((c) => `<li class="je-pt-change"><span class="je-pt-field" data-je-field="${esc(c.field)}">${esc(fieldName(c.field))}</span>`
            + `<span class="je-pt-values"><span class="je-pt-sr">${tx('tag_portable_was')} </span><span class="je-pt-from">${esc(valueText(c.from, String(c.field)))}</span><span class="je-pt-arrow" aria-hidden="true">→</span><span class="je-pt-sr"> ${tx('tag_portable_becomes')} </span><span class="je-pt-to">${esc(valueText(c.to, String(c.field)))}</span></span></li>`).join('');
        const skips = skipped.map((s) => `<li class="je-pt-skip"><span class="je-pt-field" data-je-field="${esc(s.field)}">${esc(fieldName(s.field))}</span>`
            + `<span class="je-pt-reason">${tx(`tag_portable_skip_${typeof s.reason === 'string' && SKIP_REASONS.includes(s.reason) ? s.reason : 'unknown'}`)}${s.detail ? ` <span class="je-pt-detail">(${esc(s.detail)})</span>` : ''}</span></li>`).join('');
        return (opts.summary === false ? '' : `<p class="je-pt-summary" data-je-summary>${tx(changes.length ? 'tag_portable_changes_count' : 'tag_portable_no_changes', { count: changes.length })}</p>`)
            + (changes.length ? `<ul class="je-pt-changes" aria-label="${tx('tag_portable_changes')}">${rows}</ul>` : '')
            + (skipped.length ? `<h4 class="je-pt-subtitle">${tx('tag_portable_skipped_count', { count: skipped.length })}</h4><p class="je-pt-hint">${tx('tag_portable_skipped_desc')}</p><ul class="je-pt-skips">${skips}</ul>` : '');
    }

    /** The message for a document the server refused as a whole. */
    const errorText = (code: string, params?: Record<string, string | number>) => JE.t(`tag_portable_error_${ERROR_CODES.includes(code) ? code : 'save'}`.replace(/-/g, '_'), params);

    /** The `error` code of a refused request (a fetch Response from ApiClient.ajax), or 'save'. */
    async function errorOf(err: unknown): Promise<{ code: string; max?: unknown }> {
        try {
            const json: unknown = err !== null && typeof err === 'object' ? Reflect.get(err, 'json') : undefined;
            const body: unknown = typeof json === 'function' ? await Reflect.apply(json, err, []) : err;
            return refusal(body);
        } catch { /* not JSON */ }
        return { code: 'save' };
    }

    /** Parse pasted or loaded text as a JSON document. */
    function parseDocument(text: unknown): { document?: object; error?: string } {
        try {
            const document: unknown = JSON.parse(String(text || '').trim());
            if (!document || typeof document !== 'object' || Array.isArray(document)) return { error: 'not-object' };
            return { document };
        } catch {
            return { error: 'not-json' };
        }
    }

    /** Offer a document as a file download (`name` without extension). */
    function download(document: unknown, name: string): void {
        const blob = new Blob([`${JSON.stringify(document, null, 2)}\n`], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = window.document.createElement('a');
        a.href = url;
        a.download = `${name}.json`;
        a.style.display = 'none';
        window.document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    /** Copy text to the clipboard (the textarea fallback where the async API is missing or refused). */
    async function copyText(text: string, fallback?: HTMLTextAreaElement): Promise<boolean> {
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch { /* fall back */ }
        if (!fallback) return false;
        // The document may sit in a closed disclosure: show it to select it.
        fallback.closest('details')?.setAttribute('open', '');
        fallback.focus();
        fallback.select();
        try { return window.document.execCommand('copy'); } catch { return false; }
    }

    /** Read a chosen file as text. */
    function readFile(file: File): Promise<string> {
        if (typeof file.text === 'function') return file.text();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(reader.error);
            reader.readAsText(file);
        });
    }

    /** A date stamp for file names (2026-10-31). */
    const stamp = () => new Date().toISOString().slice(0, 10);

    /**
     * A modal dialog drawn inside `host` (the settings panel or the admin
     * page): focus moves in and is kept there, Escape and Cancel close it and
     * focus returns to the control that opened it. Escape is not passed on,
     * so it never closes the settings panel behind it.
     */
    function openDialog({ host, title, className = '', onClose }: { host: HTMLElement; title: string; className?: string; onClose?: () => void }): PortableDialog {
        const active = window.document.activeElement;
        const opener = active instanceof HTMLElement ? active : null;
        const id = `jePt${Math.random().toString(36).slice(2, 8)}`;
        const backdrop = window.document.createElement('div');
        backdrop.className = `je-pt-backdrop ${className}`.trim();
        backdrop.innerHTML = `<div class="je-pt-dialog" role="dialog" aria-modal="true" aria-labelledby="${id}Title" tabindex="-1">`
            + `<div class="je-pt-head"><h3 class="je-pt-title" id="${id}Title">${esc(title)}</h3><button type="button" class="je-pt-close" data-pt-close aria-label="${tx('awards_close')}"><span class="material-icons" aria-hidden="true">close</span></button></div>`
            + '<div class="je-pt-body"></div><p class="je-pt-status" role="status" aria-live="polite"></p><div class="je-pt-foot"></div></div>';
        host.appendChild(backdrop);
        const dialog = backdrop.firstElementChild;
        const statusEl = dialog?.querySelector('.je-pt-status');
        const body = dialog?.querySelector('.je-pt-body');
        const foot = dialog?.querySelector('.je-pt-foot');
        if (!(dialog instanceof HTMLElement) || !(statusEl instanceof HTMLElement) || !(body instanceof HTMLElement) || !(foot instanceof HTMLElement)) {
            throw new TypeError('The dialog markup is incomplete');
        }
        let isClosed = false;
        // Tab order: disclosure rows included; nothing inside a closed disclosure, hidden or taken out of it.
        const focusables = () => queryElements(dialog, 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], summary')
            .filter((el) => !el.closest('[hidden]') && !(el.tagName !== 'SUMMARY' && el.closest('details:not([open])')) && el.tabIndex >= 0);
        const close = () => {
            if (isClosed) return;
            isClosed = true;
            backdrop.remove();
            onClose?.();
            if (opener?.isConnected) opener.focus({ preventScroll: true });
        };
        dialog.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                close();
                return;
            }
            if (e.key !== 'Tab') return;
            const items = focusables();
            const first = items[0];
            const last = items[items.length - 1];
            if (!first || !last) return;
            e.stopPropagation();
            const at = items.findIndex((el) => el === window.document.activeElement);
            if (e.shiftKey && at <= 0) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && at === items.length - 1) { e.preventDefault(); first.focus(); }
        });
        backdrop.addEventListener('click', (e) => {
            if (closestTarget(e, '[data-pt-close]')) close();
        });
        const focusFirst = () => {
            const first = queryElement(dialog, '[data-pt-autofocus]') || focusables().find((el) => !el.matches('[data-pt-close]'));
            (first || dialog).focus({ preventScroll: true });
        };
        return {
            el: dialog,
            body,
            foot,
            status(message, kind = '') {
                statusEl.textContent = message;
                statusEl.dataset.kind = kind;
            },
            close,
            focusFirst,
            closed: () => isClosed,
        };
    }

    /** The "load a file or paste" step of an import. */
    function sourceHtml(hintKey: string): string {
        return `<p class="je-pt-hint">${tx(hintKey)}</p>
            <label class="je-pt-file"><span class="material-icons" aria-hidden="true">upload_file</span><span>${tx('tag_portable_choose_file')}</span><input type="file" accept=".json,application/json" data-pt-file></label>
            <label class="je-pt-label" for="jePtPaste">${tx('tag_portable_paste')}</label>
            <textarea id="jePtPaste" class="je-pt-text" rows="8" spellcheck="false" data-pt-paste data-pt-autofocus placeholder='{"v":1,"kind":"je-media-tags-user","settings":{…}}'></textarea>`;
    }

    /** Wire a source step: a chosen file fills the paste box. */
    function wireSource(dialog: PortableDialog): void {
        const file = dialog.body.querySelector('[data-pt-file]');
        const paste = dialog.body.querySelector('[data-pt-paste]');
        if (!(file instanceof HTMLInputElement)) return;
        file.addEventListener('change', async () => {
            const chosen = file.files?.[0];
            if (!chosen) return;
            try {
                const text = await readFile(chosen);
                if (!(paste instanceof HTMLTextAreaElement)) throw new TypeError('The paste box is missing');
                paste.value = text;
                dialog.status(JE.t('tag_portable_file_loaded', { name: chosen.name }));
            } catch {
                dialog.status(errorText('not-json'), 'error');
            }
        });
    }

    /** The dialogs' stylesheet: used in the settings panel and on the admin page. */
    const DIALOG_CSS = `
        .je-pt-backdrop { position: fixed; inset: 0; z-index: 100000; display: flex; align-items: flex-start; justify-content: center; padding: 24px 12px; box-sizing: border-box; background: rgba(0,0,0,0.6); overflow-y: auto; }
        .je-pt-dialog { width: min(640px, 100%); box-sizing: border-box; margin: auto 0; padding: 0; border-radius: 10px; border: 1px solid rgba(255,255,255,0.18); background: #1d2026; color: #fff; box-shadow: 0 10px 40px rgba(0,0,0,0.5); font-size: 14px; text-align: left; }
        .je-pt-dialog:focus { outline: none; }
        .je-pt-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px 6px 16px; }
        .je-pt-title { margin: 0; font-size: 17px; font-weight: 600; }
        .je-pt-close { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border: 0; border-radius: 6px; background: transparent; color: #fff; cursor: pointer; }
        .je-pt-close:hover { background: rgba(255,255,255,0.08); }
        .je-pt-body { padding: 0 16px; max-height: min(60vh, 520px); overflow-y: auto; }
        .je-pt-hint { margin: 4px 0 10px; font-size: 13px; line-height: 1.45; color: rgba(255,255,255,0.7); }
        .je-pt-label { display: block; margin: 10px 0 4px; font-size: 13px; font-weight: 600; }
        .je-pt-text, .je-pt-input { box-sizing: border-box; width: 100%; padding: 8px; border-radius: 6px; border: 1px solid #80868f; background: #12141a; color: #fff; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
        .je-pt-input { font: inherit; font-size: 14px; min-height: 40px; }
        .je-pt-text[readonly] { color: #d6dbe4; }
        .je-pt-file { position: relative; display: inline-flex; align-items: center; gap: 6px; min-height: 40px; padding: 0 12px; border-radius: 6px; border: 1px dashed rgba(255,255,255,0.35); cursor: pointer; font-size: 13px; font-weight: 600; }
        .je-pt-file input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
        .je-pt-file:focus-within { outline: 2px solid #fff; outline-offset: 2px; }
        .je-pt-summary { margin: 4px 0 8px; font-weight: 600; }
        .je-pt-doc { margin: 4px 0 8px; border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; }
        .je-pt-doc > :not(summary) { margin-left: 10px; margin-right: 10px; }
        .je-pt-doc > textarea { width: calc(100% - 20px); margin-bottom: 10px; }
        .je-pt-doc-toggle { display: flex; align-items: center; gap: 6px; min-height: 44px; padding: 0 10px 0 6px; list-style: none; cursor: pointer; font-weight: 600; border-radius: 8px; }
        .je-pt-doc-toggle::-webkit-details-marker { display: none; }
        .je-pt-doc-toggle:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
        .je-pt-doc-toggle .material-icons { font-size: 20px; transition: transform 0.2s ease; }
        .je-pt-doc[open] > .je-pt-doc-toggle .material-icons { transform: rotate(180deg); }
        .je-pt-subtitle { margin: 14px 0 2px; font-size: 13px; font-weight: 600; color: #ffd699; }
        .je-pt-changes, .je-pt-skips { list-style: none; margin: 0 0 6px; padding: 0; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; }
        .je-pt-change, .je-pt-skip { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 2px 12px; padding: 9px 12px; font-size: 14px; }
        .je-pt-change + .je-pt-change, .je-pt-skip + .je-pt-skip { border-top: 1px solid rgba(255,255,255,0.07); }
        .je-pt-field { font-weight: 600; }
        .je-pt-values { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 6px; min-width: 0; font-size: 13px; }
        .je-pt-from { color: rgba(255,255,255,0.62); text-decoration: line-through; overflow-wrap: anywhere; }
        .je-pt-to { color: #8fe3a5; font-weight: 600; overflow-wrap: anywhere; }
        .je-pt-arrow { color: rgba(255,255,255,0.5); }
        .je-pt-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
        .je-pt-reason { color: #ffd699; font-size: 13px; }
        .je-pt-detail { color: rgba(255,255,255,0.6); }
        .je-pt-status { min-height: 18px; margin: 8px 16px 0; font-size: 13px; color: #8fe3a5; }
        .je-pt-status:empty { min-height: 0; margin-top: 0; }
        .je-pt-status[data-kind="error"] { color: #ff8a80; }
        .je-pt-foot { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; padding: 10px 16px 14px; }
        .je-pt-btn { display: inline-flex; align-items: center; gap: 6px; min-height: 40px; padding: 0 14px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.46); background: rgba(255,255,255,0.06); color: #fff; font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; white-space: nowrap; }
        .je-pt-btn:hover { background: rgba(255,255,255,0.12); }
        .je-pt-btn[data-primary] { background: #0077a3; border-color: #0077a3; }
        .je-pt-btn[data-primary]:hover { background: #00688f; }
        .je-pt-btn:is(:disabled, [aria-disabled="true"]) { opacity: 0.45; cursor: default; }
        .je-pt-btn .material-icons { font-size: 18px; }
        :is(.je-pt-btn, .je-pt-close, .je-pt-text, .je-pt-input):focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
        @media (max-width: 480px) {
            .je-pt-backdrop { padding: 8px; }
            .je-pt-foot .je-pt-btn { flex: 1 1 auto; justify-content: center; }
            .je-pt-btn, .je-pt-file { min-height: 44px; }
            .je-pt-close { width: 44px; height: 44px; }
            .je-pt-text, .je-pt-input { font-size: 16px; }
        }
    `;

    /** Inject the dialogs' stylesheet once. */
    const injectDialogCss = () => { JE.core?.ui?.injectCss?.('je-tag-portable-dialog', DIALOG_CSS); };

    /** A footer button. */
    const buttonHtml = (action: string, labelKey: string, opts: ButtonOptions = {}) => `<button type="button" class="je-pt-btn" data-pt-action="${esc(action)}"${opts.primary ? ' data-primary' : ''}>${opts.icon ? `<span class="material-icons" aria-hidden="true">${esc(opts.icon)}</span>` : ''}${tx(labelKey, opts.params)}</button>`;

    const tools: TagPortableTools = { openDialog, previewHtml, valueText, fieldName, errorText, errorOf, parseDocument, download, copyText, readFile, sourceHtml, wireSource, buttonHtml, injectDialogCss, stamp };
    internal.tagPortable = tools;

    // ── The hub's cards ────────────────────────────────────────────────

    /** The user id the requests are for. */
    const userId = () => optionalApiClient()?.getCurrentUserId?.() || '';
    const userUrl = (path: string) => apiClient().getUrl(`/JellyfinEnhanced/user-settings/${userId()}/media-tags/${path}`);
    /** The server the requests go to. */
    const serverId = () => {
        try {
            const client = optionalApiClient();
            return (client && (typeof client.serverId === 'function' ? client.serverId() : client.serverId)) || '';
        } catch {
            return '';
        }
    };

    /**
     * Capture the signed-in session (user, server and JE.session epoch) at the
     * start of an operation. The check stays true only while that session
     * lasts: A → B → A and the same user id on another server both end it, so
     * a late answer never writes into, or offers Undo to, the next account.
     */
    function sessionCheck(): () => boolean {
        const user = userId();
        const server = serverId();
        const epoch = JE.session?.getEpoch?.();
        return () => userId() === user && serverId() === server && JE.session?.getEpoch?.() === epoch;
    }

    /** The hub's two cards for the Layout tab. */
    internal.buildTagPortableHtml = function() {
        return `
            <section class="je-mth-card je-mth-tp" id="jeMthPresets" aria-labelledby="jeMthPresetsTitle">
                <h4 class="je-mth-card-title" id="jeMthPresetsTitle">${tx('tag_presets_title')}</h4>
                <p class="je-mth-hint">${tx('tag_presets_desc')}</p>
                <div class="je-mth-tp-list" data-tp-list aria-live="polite"><p class="je-mth-hint">${tx('hidden_content_admin_loading')}</p></div>
                <div class="je-mth-tp-error" data-tp-error role="alert" hidden><span data-tp-error-text></span><button type="button" class="je-mth-button" data-tp="delete-retry">${tx('admin_tags_retry')}</button></div>
                <div class="je-mth-actions">
                    <button type="button" class="je-mth-button" data-tp="save-preset"><span class="material-icons" aria-hidden="true">bookmark_add</span><span data-je-label>${tx('tag_presets_save')}</span></button>
                    <button type="button" class="je-mth-button" data-tp="import-preset"><span class="material-icons" aria-hidden="true">file_open</span><span data-je-label>${tx('tag_presets_import')}</span></button>
                </div>
            </section>
            <section class="je-mth-card je-mth-tp" id="jeMthPortable" aria-labelledby="jeMthPortableTitle">
                <h4 class="je-mth-card-title" id="jeMthPortableTitle">${tx('tag_portable_title')}</h4>
                <p class="je-mth-hint">${tx('tag_portable_desc')}</p>
                <div class="je-mth-tp-undo" data-tp-undo role="status" hidden></div>
                <div class="je-mth-actions">
                    <button type="button" class="je-mth-button" data-tp="export"><span class="material-icons" aria-hidden="true">download</span><span data-je-label>${tx('tag_portable_export')}</span></button>
                    <button type="button" class="je-mth-button" data-tp="import"><span class="material-icons" aria-hidden="true">upload</span><span data-je-label>${tx('tag_portable_import')}</span></button>
                </div>
            </section>`;
    };

    /** The cards' stylesheet (panel-scoped). */
    const CARD_CSS = `
        #jellyfin-enhanced-panel .je-mth-tp-list { display: flex; flex-direction: column; gap: 10px; }
        #jellyfin-enhanced-panel .je-mth-tp-group-title { margin: 4px 0 4px; font-size: 12px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: rgba(255,255,255,0.6); }
        #jellyfin-enhanced-panel .je-mth-tp-items { list-style: none; margin: 0; padding: 0; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; }
        #jellyfin-enhanced-panel .je-mth-tp-item { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 12px; padding: 8px 10px 8px 12px; }
        #jellyfin-enhanced-panel .je-mth-tp-item + .je-mth-tp-item { border-top: 1px solid rgba(255,255,255,0.08); }
        #jellyfin-enhanced-panel .je-mth-tp-text { flex: 1 1 220px; min-width: 0; }
        #jellyfin-enhanced-panel .je-mth-tp-name { font-size: 14px; font-weight: 600; }
        #jellyfin-enhanced-panel .je-mth-tp-desc { font-size: 12px; line-height: 1.4; color: rgba(255,255,255,0.65); }
        #jellyfin-enhanced-panel .je-mth-tp-buttons { display: flex; flex-wrap: wrap; gap: 6px; }
        #jellyfin-enhanced-panel .je-mth-tp-buttons .je-mth-button { min-height: 34px; padding: 0 10px; }
        #jellyfin-enhanced-panel .je-mth-tp-undo { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 4px 0 6px; padding: 8px 10px; border-radius: 6px; background: rgba(0,164,220,0.14); border: 1px solid rgba(0,164,220,0.4); font-size: 13px; }
        #jellyfin-enhanced-panel .je-mth-tp-undo[hidden] { display: none; }
        #jellyfin-enhanced-panel .je-mth-tp-error { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 8px 0 0; padding: 8px 10px; border-radius: 6px; background: rgba(255,138,128,0.12); border: 1px solid rgba(255,138,128,0.45); font-size: 13px; }
        #jellyfin-enhanced-panel .je-mth-tp-error[hidden] { display: none; }
        #jellyfin-enhanced-panel .je-mth-tp-count { font-weight: 400; color: rgba(255,255,255,0.55); text-transform: none; letter-spacing: 0; }
    `;
    /**
     * Converts a server value (PascalCase objects) the way settings.json is
     * read into JE.currentSettings (JE.toCamelCase: object keys, not arrays).
     * Only JSON can be stored in the settings document.
     */
    const toClient = (value: unknown): JsonValue => {
        const converted: unknown = typeof JE.toCamelCase === 'function' ? Reflect.get(Object(JE.toCamelCase({ v: value })), 'v') : value;
        if (converted === undefined) return null;
        if (!isJson(converted)) throw new TypeError('An imported value is not JSON');
        return converted;
    };

    /** The camelCase settings key of a PascalCase field. */
    const clientKey = (field: unknown) => { const name = String(field); return name.charAt(0).toLowerCase() + name.slice(1); };

    /**
     * Write changed fields into the user's document and save it through the
     * normal settings save (which normalises them once more), then follow the
     * new group switches on the page. A null value keeps (or makes) the field
     * follow the administrator: it is saved as null, never as today's default.
     * A failed save rolls back only what the import still owns: a field the
     * panel changed while the save was on its way keeps that newer edit.
     * Resolves false when the import's session ended first (nothing more is
     * done for it); rejects when the save failed (nothing is kept then).
     */
    async function writeChanges(changes: readonly PortableChange[], isCurrent: () => boolean): Promise<boolean> {
        const settings = JE.currentSettings;
        const before: Record<string, JsonValue | undefined> = {};
        const inheritedBefore: Record<string, boolean> = {};
        const wasOn = Object.fromEntries(GROUP_SWITCHES.map((g) => [g.key, !!settings[g.key]]));
        const nativeBefore = JE.userConfig?.settings?.useNativePosterTags;
        let nativeWritten: JsonValue | undefined;
        for (const change of changes) {
            const key = clientKey(change.field);
            before[key] = settings[key];
            inheritedBefore[key] = JE.isSettingInherited?.(settings, key) === true;
            const value = toClient(change.to);
            if (key === 'useNativePosterTags') {
                // Saved as chosen (null stays "not chosen", which is on).
                JE.userConfig = JE.userConfig || { shortcuts: { Shortcuts: [] } };
                JE.userConfig.settings = JE.userConfig.settings || {};
                JE.userConfig.settings.useNativePosterTags = value;
                nativeWritten = value;
                settings.useNativePosterTags = value !== false;
            } else if (JE.setSettingInherited?.(settings, key, value === null)) {
                // Shown resolved, saved as null while inherited (config.js).
                if (value !== null) settings[key] = value;
            } else settings[key] = value;
        }
        // What the import wrote, to tell its fields from a newer edit at rollback.
        const owned = (key: string) => JSON.stringify([settings[key] ?? null, JE.isSettingInherited?.(settings, key) === true]);
        const written = Object.fromEntries(Object.keys(before).map((key) => [key, owned(key)]));
        let rolledBack = false;
        /**
         * Runs in the save queue, before the next queued save reads the
         * document, and only while the import's session lasts (config.js).
         */
        const rollback = () => {
            rolledBack = true;
            for (const key of Object.keys(before)) {
                if (owned(key) !== written[key]) continue;
                if (key === 'useNativePosterTags') {
                    const native = JE.userConfig?.settings;
                    if (native?.useNativePosterTags !== nativeWritten) continue;
                    if (native) native.useNativePosterTags = nativeBefore;
                }
                settings[key] = before[key];
                if (JE.setSettingInherited?.(settings, key, inheritedBefore[key] === true)) settings[key] = before[key];
            }
        };
        try {
            // Queued saves read the document at their turn: one for a session that
            // ended by then is dropped, never sent for the next account.
            await JE.saveUserSettings('settings.json', settings, { throwOnError: true, isCurrent, onError: rollback });
        } catch (err) {
            // The tags drawn meanwhile may show the import's values: draw them again.
            if (rolledBack && isCurrent()) {
                JE.core?.tagLayout?.invalidateSettings?.();
                JE.reinitializeTagLayout?.();
            }
            throw err;
        }
        if (!isCurrent()) return false;
        JE.core?.tagLayout?.invalidateSettings?.();
        for (const g of GROUP_SWITCHES) {
            const on = !!settings[g.key];
            try {
                if (on && !wasOn[g.key]) g.init();
                else if (on) g.reinit();
                else if (wasOn[g.key]) internal.removeTagGroup?.(g.group, g.container);
            } catch (err) {
                console.warn(`🪼 Jellyfin Enhanced: could not redraw the ${g.group} tags after an import`, err);
            }
        }
        JE.reinitializeTagLayout?.();
        return true;
    }

    /**
     * Wire the hub's cards. Called by wireMediaTagsHub (`hub` is
     * #jeMediaTagsHub); returns the teardown.
     */
    const wireTagPortable: WireTagPortable = function(hub, ctx, hooks) {
        const presetsCard = queryElement(hub, '#jeMthPresets');
        const portableCard = queryElement(hub, '#jeMthPortable');
        const client: PanelApiClient | undefined = optionalApiClient();
        if (!presetsCard || !portableCard || !client) return () => {};
        const list = queryElement(presetsCard, '[data-tp-list]');
        const undoBar = queryElement(portableCard, '[data-tp-undo]');
        const deleteError = queryElement(presetsCard, '[data-tp-error]');
        if (!list || !undoBar || !deleteError) return () => {};
        JE.core?.ui?.injectCss?.('je-media-tags-portable', CARD_CSS);
        injectDialogCss();
        const host = ctx.help || hub;
        const touch = () => { try { ctx.resetAutoCloseTimer?.(); } catch { /* panel closing */ } };
        const viewSession = sessionCheck();
        let disposed = false;
        let dialog: PortableDialog | null = null;
        let undoTimer: ReturnType<typeof setTimeout> | undefined;
        let presets: PresetList | null = null;
        /** The preset whose deletion failed (Retry deletes it). */
        let failedDelete: { id: unknown; name: string } | null = null;
        const ajax = (request: Parameters<PanelApiClient['ajax']>[0]) => apiClient().ajax(request);

        /** Whether answers still belong to this view and its session. */
        const live = () => !disposed && viewSession();

        /** A preset's shown name (built-ins are translated). */
        const presetText = (preset: Preset, source: PresetSource) => {
            if (source !== 'builtIn') return { name: String(preset.name || ''), description: String(preset.description || '') };
            const builtin = JE.core.tagLayout?.VOCABULARY_KEYS.builtin;
            return { name: JE.t(builtin?.[`${preset.id}`] ?? ''), description: JE.t(builtin?.[`${preset.id}_desc`] ?? '') };
        };

        /** Draw the presets list. */
        const drawPresets = () => {
            if (!presets) return;
            const loaded = presets;
            const group = (source: PresetSource, titleKey: string, items: readonly Preset[], count?: string) => items.length || source === 'mine' ? `
                <div class="je-mth-tp-group" data-tp-source="${source}">
                    <h5 class="je-mth-tp-group-title">${tx(titleKey)}${count ? ` <span class="je-mth-tp-count">${esc(count)}</span>` : ''}</h5>
                    ${items.length ? `<ul class="je-mth-tp-items">${items.map((p, i) => {
                        const text = presetText(p, source);
                        return `<li class="je-mth-tp-item" data-tp-index="${i}" data-tp-id="${esc(p.id ?? '')}">
                            <div class="je-mth-tp-text"><div class="je-mth-tp-name" data-je-label>${esc(text.name)}</div>${text.description ? `<div class="je-mth-tp-desc">${esc(text.description)}</div>` : ''}</div>
                            <div class="je-mth-tp-buttons">
                                <button type="button" class="je-mth-button" data-tp="apply" aria-label="${tx('tag_presets_apply_named', { name: text.name })}">${tx('tag_presets_apply')}</button>
                                <button type="button" class="je-mth-button" data-tp="share" aria-label="${tx('tag_presets_share_named', { name: text.name })}">${tx('tag_presets_share')}</button>
                                ${source === 'mine' ? `<button type="button" class="je-mth-button" data-tp="delete" aria-label="${tx('admin_tags_rules_delete', { name: text.name })}">${tx('reviews_delete')}</button>` : ''}
                            </div>
                        </li>`;
                    }).join('')}</ul>` : `<p class="je-mth-hint">${tx('tag_presets_none_yet')}</p>`}
                </div>` : '';
            // Redrawn after a save, a delete or a reload: keep keyboard focus on the same preset's button.
            const active = window.document.activeElement;
            const keep = active instanceof HTMLElement && list.contains(active) && active.dataset.tp ? {
                source: active.closest('[data-tp-source]')?.getAttribute('data-tp-source'),
                id: active.closest('[data-tp-id]')?.getAttribute('data-tp-id'),
                action: active.dataset.tp,
            } : null;
            list.innerHTML = group('builtIn', 'tag_presets_builtin', loaded.builtIn)
                + group('offered', 'tag_presets_offered', loaded.offered)
                + group('mine', 'tag_presets_mine', loaded.mine, JE.t('tag_looks_condition_count', { count: loaded.mine.length, max: loaded.max }));
            if (keep) {
                const again = Array.from(list.querySelectorAll(`[data-tp-source="${keep.source}"] [data-tp="${keep.action}"]`))
                    .find((el) => el.closest('[data-tp-id]')?.getAttribute('data-tp-id') === keep.id);
                focusElement(again || presetsCard.querySelector('[data-tp="save-preset"]:not([disabled])'), { preventScroll: true });
            }
            // A full list: saving or importing another is off until one is deleted.
            const full = loaded.mine.length >= loaded.max;
            for (const button of queryElements(presetsCard, '[data-tp="save-preset"], [data-tp="import-preset"]')) {
                setDisabled(button, full);
                button.title = full ? JE.t('tag_presets_full', { max: loaded.max }) : '';
            }
        };

        /** Load (or reload) the presets list. */
        const loadPresets = async () => {
            try {
                const answer = await ajax({ type: 'GET', url: userUrl('presets'), dataType: 'json' });
                if (!live()) return;
                presets = decodePresets(answer);
                drawPresets();
            } catch (err) {
                if (!live()) return;
                console.warn('🪼 Jellyfin Enhanced: could not load the Media Tags presets', err);
                const hadFocus = list.contains(window.document.activeElement);
                list.innerHTML = `<p class="je-mth-off">${tx('tag_presets_load_failed')}</p>`;
                if (hadFocus) focusElement(presetsCard.querySelector('[data-tp="save-preset"]'), { preventScroll: true });
            }
        };

        /**
         * Save the panel's settings before the server reads them: the preview
         * compares with, and the export reads, the stored settings.json. An edit
         * still on its way is waited for; one kept after a failed save is sent
         * again. False when the save failed (the panel keeps the edit).
         */
        const saveFirst = async (isCurrent: () => boolean) => {
            try {
                await JE.saveUserSettings('settings.json', JE.currentSettings, { throwOnError: true, isCurrent });
                return true;
            } catch (err) {
                console.warn('🪼 Jellyfin Enhanced: the Media Tags settings are not saved yet', err);
                return false;
            }
        };

        /**
         * The user's own export, after the panel's settings were saved:
         * unsaved when the save failed (nothing was exported); null when that
         * session ended first.
         */
        const fetchExport = async (isCurrent: () => boolean): Promise<{ document?: unknown; unsaved?: boolean } | null> => {
            const saved = await saveFirst(isCurrent);
            if (!isCurrent()) return null;
            if (!saved) return { unsaved: true };
            return { document: await ajax({ type: 'GET', url: userUrl('export'), dataType: 'json' }) };
        };

        /**
         * The panel's values of some fields (with their inherited state), to see
         * whether they changed since a preview compared them.
         */
        const clientSnapshot = (fields: readonly unknown[]) => JSON.stringify(fields.map((field) => {
            const key = clientKey(field);
            const settings = JE.currentSettings || {};
            return [settings[key] ?? null, JE.isSettingInherited?.(settings, key) === true,
                key === 'useNativePosterTags' ? JE.userConfig?.settings?.useNativePosterTags ?? null : null];
        }));

        /** Show or hide a dialog's loading line (hidden while its status says why nothing loads). */
        const showLoading = (d: PortableDialog, on: boolean) => {
            const line = queryElement(d.body, '[data-pt-loading]');
            if (line) line.hidden = !on;
        };

        /** Open a dialog in the panel (one at a time). */
        const show = (title: string): PortableDialog => {
            dialog?.close();
            const opened = openDialog({ host, title, onClose: () => { dialog = null; touch(); } });
            dialog = opened;
            opened.el.addEventListener('input', touch);
            opened.el.addEventListener('click', touch);
            return opened;
        };
        /** The footer action a click chose. */
        const actionOf = (e: Event) => closestTarget(e, '[data-pt-action]');

        // ── Export ──
        const openExport = async () => {
            const current = sessionCheck();
            const d = show(JE.t('tag_portable_export_title'));
            d.body.innerHTML = `<p class="je-pt-hint">${tx('tag_portable_export_desc')}</p><p class="je-pt-hint" data-pt-loading>${tx('hidden_content_admin_loading')}</p>`;
            d.foot.innerHTML = buttonHtml('close', 'awards_close');
            d.foot.onclick = (e) => {
                const button = actionOf(e);
                const action = button?.getAttribute('data-pt-action');
                if (button && action === 'retry') {
                    // Busy, not replaced: a focused Retry keeps focus inside the dialog.
                    if (button.getAttribute('aria-disabled') === 'true') return;
                    button.setAttribute('aria-disabled', 'true');
                    showLoading(d, true);
                    d.status(JE.t('tag_portable_checking'));
                    load();
                } else if (action === 'close') d.close();
            };
            d.focusFirst();
            /** Offer Retry again: the same button when there is one (focus stays on it). */
            const offerRetry = () => {
                const retry = d.foot.querySelector('[data-pt-action="retry"]');
                if (retry) { retry.removeAttribute('aria-disabled'); return; }
                d.foot.innerHTML = buttonHtml('close', 'awards_close') + buttonHtml('retry', 'admin_tags_retry', { primary: true });
                focusElement(d.foot.querySelector('[data-pt-action="retry"]'));
            };
            const load = async () => {
                let result: { document?: unknown; unsaved?: boolean } | null;
                try {
                    result = await fetchExport(current);
                } catch (err) {
                    if (!live() || !current() || d.closed()) return;
                    console.warn('🪼 Jellyfin Enhanced: could not export the Media Tags settings', err);
                    showLoading(d, false);
                    d.status(JE.t('tag_portable_export_failed'), 'error');
                    offerRetry();
                    return;
                }
                if (!live() || !current() || d.closed() || !result) return;
                if (result.unsaved) {
                    // The stored settings are not the ones the panel shows: no export of them.
                    showLoading(d, false);
                    d.status(JE.t('tag_portable_export_unsaved'), 'error');
                    offerRetry();
                    return;
                }
                d.status('');
                showExport(d, result.document);
            };
            await load();
        };

        /** The export step: the document with Download and Copy. */
        const showExport = (d: PortableDialog, document: unknown) => {
            const text = JSON.stringify(document, null, 2);
            const { fieldCount } = exportedParts(document);
            d.body.innerHTML = `<p class="je-pt-hint">${tx('tag_portable_export_desc')}</p>
                <details class="je-pt-doc"><summary class="je-pt-doc-toggle"><span class="material-icons" aria-hidden="true">expand_more</span>${tx('tag_portable_show_document', { count: fieldCount })}</summary>
                <label class="je-pt-label" for="jePtExport">${tx('tag_portable_export_document', { count: fieldCount })}</label>
                <textarea id="jePtExport" class="je-pt-text" rows="12" readonly spellcheck="false">${esc(text)}</textarea></details>`;
            d.foot.innerHTML = buttonHtml('close', 'awards_close') + buttonHtml('copy', 'tag_portable_copy', { icon: 'content_copy' }) + buttonHtml('download', 'tag_portable_download', { icon: 'download', primary: true });
            const area = d.body.querySelector('textarea');
            d.foot.onclick = async (e) => {
                const action = actionOf(e)?.getAttribute('data-pt-action');
                if (action === 'download') {
                    download(document, `jellyfin-media-tags-${stamp()}`);
                    d.status(JE.t('tag_portable_downloaded'));
                } else if (action === 'copy') {
                    d.status(JE.t(await copyText(text, area ?? undefined) ? 'tag_portable_copied' : 'tag_portable_copy_failed'), '');
                } else if (action === 'close') d.close();
            };
            focusElement(d.foot.querySelector('[data-pt-action="download"]'));
        };

        // ── Import (a document, or a preset to apply) ──
        /**
         * Ask the server what a document would change and show it, with Apply.
         * The panel's settings are saved first (an edit on its way or kept after a
         * failed save), else the server would compare with settings the panel no
         * longer shows and leave out a field the panel changed. `back` shows the
         * source step again; `note` is shown with the preview.
         */
        const showPreview = async (d: PortableDialog, document: object, back?: () => void, note?: string): Promise<void> => {
            const current = sessionCheck();
            d.status(JE.t('tag_portable_checking'));
            showLoading(d, true);
            /**
             * Say why nothing is shown, without the loading line. On the source
             * step Check tries again; elsewhere Retry does (the same button when
             * there is one, so a focused Retry keeps focus).
             */
            const failed = (message: string) => {
                showLoading(d, false);
                d.status(message, 'error');
                if (d.body.querySelector('[data-pt-paste]')) return;
                const again = d.foot.querySelector('[data-pt-action="retry"]');
                if (again) { again.removeAttribute('aria-disabled'); return; }
                d.foot.innerHTML = (back ? buttonHtml('back', 'tag_portable_back') : '') + buttonHtml('cancel', 'jellyseerr_modal_cancel')
                    + buttonHtml('retry', 'admin_tags_retry', { primary: true });
                d.foot.onclick = (e) => {
                    const button = actionOf(e);
                    const action = button?.getAttribute('data-pt-action');
                    if (action === 'back') back?.();
                    else if (action === 'cancel') d.close();
                    else if (button && action === 'retry' && button.getAttribute('aria-disabled') !== 'true') {
                        button.setAttribute('aria-disabled', 'true');
                        showPreview(d, document, back, note);
                    }
                };
                focusElement(d.foot.querySelector('[data-pt-action="retry"]'));
            };
            const saved = await saveFirst(current);
            if (!live() || !current() || d.closed()) return;
            if (!saved) {
                failed(JE.t('tag_portable_import_unsaved'));
                return;
            }
            let answer: unknown;
            try {
                answer = await ajax({ type: 'POST', url: userUrl('preview'), data: JSON.stringify(document), contentType: 'application/json', dataType: 'json' });
            } catch (err) {
                if (!live() || d.closed()) return;
                const { code } = await errorOf(err);
                if (!live() || !current() || d.closed()) return;
                failed(errorText(code));
                return;
            }
            if (!live() || !current() || d.closed()) return;
            d.status(note || '');
            const preview = decodePreview(answer);
            const changes = preview.changes;
            // The panel's values of every field the document sets, as the preview compared them.
            const fields = Array.from(new Set([...preview.imported, ...changes.map((c) => c.field)]));
            const compared = clientSnapshot(fields);
            d.body.innerHTML = (preview.name ? `<p class="je-pt-hint">${tx('tag_portable_preset_named', { name: String(preview.name) })}</p>` : '') + previewHtml(answer || {});
            d.foot.innerHTML = (back ? buttonHtml('back', 'tag_portable_back') : '') + buttonHtml('cancel', 'jellyseerr_modal_cancel')
                + (changes.length ? buttonHtml('apply', 'tag_portable_apply_count', { primary: true, params: { count: changes.length } }) : '');
            d.foot.onclick = async (e) => {
                const button = actionOf(e);
                const action = button?.dataset.ptAction;
                if (action === 'back') back?.();
                else if (action === 'cancel') d.close();
                else if (action === 'apply' && button) {
                    // Changed in the panel since the preview: it no longer says what Apply changes.
                    if (clientSnapshot(fields) !== compared) {
                        showPreview(d, document, back, JE.t('tag_portable_import_changed'));
                        return;
                    }
                    setDisabled(button, true);
                    d.status(JE.t('tag_portable_applying'));
                    try {
                        await apply(changes);
                    } catch (err) {
                        if (!live()) return;
                        console.warn('🪼 Jellyfin Enhanced: could not apply the imported Media Tags settings', err);
                        // Closed while the save was on its way: say it on the panel instead.
                        if (d.closed()) { hooks.announce(JE.t('tag_portable_apply_failed')); return; }
                        setDisabled(button, false);
                        d.status(JE.t('tag_portable_apply_failed'), 'error');
                    }
                }
            };
            focusElement(d.foot.querySelector('[data-pt-action="apply"]') || d.foot.querySelector('[data-pt-action="cancel"]'));
        };

        /** The import dialog: a file or pasted text, then the preview. */
        const openSource = ({ titleKey, hintKey, onDocument, nextKey = 'tag_portable_preview' }: {
            titleKey: string; hintKey: string; nextKey?: string; onDocument: (d: PortableDialog, doc: object, back: () => void) => void;
        }) => {
            const d = show(JE.t(titleKey));
            const step = () => {
                d.body.innerHTML = sourceHtml(hintKey);
                d.foot.innerHTML = buttonHtml('cancel', 'jellyseerr_modal_cancel') + buttonHtml('next', nextKey, { primary: true });
                wireSource(d);
                d.foot.onclick = (e) => {
                    const action = actionOf(e)?.getAttribute('data-pt-action');
                    if (action === 'cancel') { d.close(); return; }
                    if (action !== 'next') return;
                    const paste = d.body.querySelector('[data-pt-paste]');
                    if (!(paste instanceof HTMLTextAreaElement)) throw new TypeError('The paste box is missing');
                    const parsed = parseDocument(paste.value);
                    if (parsed.error || !parsed.document) { d.status(errorText(parsed.error ?? 'not-object'), 'error'); return; }
                    onDocument(d, parsed.document, () => { d.status(''); step(); d.focusFirst(); });
                };
                d.focusFirst();
            };
            step();
        };

        /**
         * Apply a preview's changes, then open the panel again on the new
         * settings with Undo (`undo`: this is the Undo itself, no new Undo).
         */
        const apply = async (changes: readonly PortableChange[], opts: { undo?: boolean } = {}) => {
            const current = sessionCheck();
            if (!live() || !await writeChanges(changes, current)) return;
            // Published only while the import's session lasts; a closed panel
            // of that session still offers it when opened again.
            if (!opts.undo) lastImport = { changes: changes.slice(), until: Date.now() + UNDO_MS, count: changes.length, isCurrent: current };
            if (!live()) return;
            dialog?.close();
            reopen(opts.undo ? 'tag_portable_undone' : null);
        };

        /** Open the panel again (every control reads the new settings) on the Media Tags Layout tab; `messageKey` is announced after it opened. */
        const reopen = (messageKey: string | null) => {
            internal.tagPortableReopen = { messageKey };
            ctx.closePanel?.();
            Promise.resolve(JE.showEnhancedPanel?.()).catch((err) => console.warn('🪼 Jellyfin Enhanced: could not open the settings again', err));
        };

        /** Show Undo for what is left of the last import's window. */
        const drawUndo = () => {
            clearTimeout(undoTimer);
            const left = lastImport ? lastImport.until - Date.now() : 0;
            if (!lastImport || left <= 0 || !lastImport.isCurrent() || !live()) {
                // Undo used or expired while it had focus: hand focus to Import beside it.
                const hadFocus = undoBar.contains(window.document.activeElement);
                undoBar.hidden = true;
                undoBar.innerHTML = '';
                if (hadFocus) focusElement(portableCard.querySelector('[data-tp="import"]'), { preventScroll: true });
                return;
            }
            undoBar.hidden = false;
            undoBar.innerHTML = `<span>${tx('tag_portable_applied', { count: lastImport.count })}</span><button type="button" class="je-mth-button" data-tp="undo">${tx('hidden_content_undo')}</button>`;
            undoTimer = setTimeout(() => { if (!disposed) drawUndo(); }, left);
        };

        const undo = async () => {
            const last = lastImport;
            if (!last || !last.isCurrent() || !live()) return;
            lastImport = null;
            drawUndo();
            try {
                await apply(last.changes.map((c) => ({ field: c.field, from: c.to, to: c.from })), { undo: true });
            } catch (err) {
                console.warn('🪼 Jellyfin Enhanced: could not undo the Media Tags import', err);
                if (live()) hooks.announce(JE.t('tag_portable_apply_failed'));
            }
        };

        // ── Presets ──
        const presetOf = (button: HTMLElement): { preset: Preset; source: PresetSource } | null => {
            const item = button.closest('[data-tp-index]');
            const source = button.closest('[data-tp-source]')?.getAttribute('data-tp-source');
            if (!item || !isPresetSource(source) || !presets) return null;
            const preset = presets[source][Number(item.getAttribute('data-tp-index'))];
            return preset ? { preset, source } : null;
        };

        /** The preset as shared: the shown name, no server id for built-ins. */
        const shareable = (preset: Preset, source: PresetSource) => {
            const text = presetText(preset, source);
            return { v: preset.v || 1, kind: PRESET_KIND, name: text.name, description: text.description, settings: preset.settings || {} };
        };

        const openSavePreset = () => {
            const d = show(JE.t('tag_presets_save'));
            d.body.innerHTML = `<p class="je-pt-hint">${tx('tag_presets_save_desc')}</p>
                <label class="je-pt-label" for="jePtName">${tx('tag_presets_name')}</label>
                <input id="jePtName" class="je-pt-input" type="text" maxlength="${MAX_NAME}" data-pt-autofocus required>
                <label class="je-pt-label" for="jePtDesc">${tx('tag_presets_description')}</label>
                <textarea id="jePtDesc" class="je-pt-input" rows="2" maxlength="${MAX_DESCRIPTION}"></textarea>`;
            d.foot.innerHTML = buttonHtml('cancel', 'jellyseerr_modal_cancel') + buttonHtml('save', 'elsewhere_settings_save', { primary: true });
            d.foot.onclick = async (e) => {
                const button = actionOf(e);
                if (button?.dataset.ptAction === 'cancel') { d.close(); return; }
                if (!button || button.dataset.ptAction !== 'save') return;
                const nameInput = d.body.querySelector('#jePtName');
                const descInput = d.body.querySelector('#jePtDesc');
                if (!(nameInput instanceof HTMLInputElement) || !(descInput instanceof HTMLTextAreaElement)) return;
                const name = nameInput.value.trim();
                const description = descInput.value.trim();
                if (!name) { d.status(errorText('name'), 'error'); nameInput.focus(); return; }
                const current = sessionCheck();
                setDisabled(button, true);
                try {
                    const exported = await fetchExport(current);
                    if (!live() || !current() || d.closed() || !exported) return;
                    if (exported.unsaved) {
                        // A preset of the stored settings would not be what the panel shows.
                        setDisabled(button, false);
                        d.status(JE.t('tag_presets_save_unsaved'), 'error');
                        return;
                    }
                    const parts = exportedParts(exported.document);
                    await savePreset(d, { v: parts.v, kind: PRESET_KIND, name, description, settings: parts.settings }, current);
                } catch (err) {
                    if (!live() || !current() || d.closed()) return;
                    setDisabled(button, false);
                    d.status(errorText((await errorOf(err)).code, { max: presets?.max || 10 }), 'error');
                }
            };
            d.focusFirst();
        };

        /**
         * Save a preset to the user's list and report what was skipped. The
         * preset is posted only while the operation's session lasts, so always
         * to the user who asked.
         */
        const savePreset = async (d: PortableDialog, document: object, isCurrent: () => boolean = sessionCheck()) => {
            if (!live() || !isCurrent()) return;
            const answer = await ajax({ type: 'POST', url: userUrl('presets'), data: JSON.stringify(document), contentType: 'application/json', dataType: 'json' });
            if (!live() || !isCurrent()) return;
            await loadPresets();
            const saved = savedPreset(answer);
            const shownName = String(saved.name || Reflect.get(document, 'name'));
            if (!saved.skipped.length || d.closed()) {
                d.close();
                hooks.announce(JE.t('tag_presets_saved', { name: shownName }));
                return;
            }
            d.body.innerHTML = `<p class="je-pt-summary">${tx('tag_presets_saved', { name: shownName })}</p>` + previewHtml({ skipped: saved.skipped }, { summary: false });
            d.foot.innerHTML = buttonHtml('close', 'awards_close', { primary: true });
            d.foot.onclick = () => d.close();
            d.focusFirst();
        };

        const openImportPreset = () => openSource({
            titleKey: 'tag_presets_import_title',
            hintKey: 'tag_presets_import_desc',
            nextKey: 'tag_presets_import_button',
            onDocument: async (d, document) => {
                if (!Reflect.get(document, 'name')) { d.status(errorText('name'), 'error'); return; }
                try {
                    await savePreset(d, document);
                } catch (err) {
                    if (!live() || d.closed()) return;
                    d.status(errorText((await errorOf(err)).code, { max: presets?.max || 10 }), 'error');
                }
            },
        });

        const sharePreset = async (preset: Preset, source: PresetSource, button: HTMLElement) => {
            const text = JSON.stringify(shareable(preset, source), null, 2);
            if (await copyText(text)) {
                hooks.announce(JE.t('tag_presets_shared', { name: presetText(preset, source).name }));
                const old = button.textContent;
                button.textContent = JE.t('tag_portable_copied');
                setTimeout(() => { if (button.isConnected) button.textContent = old; }, 1500);
                return;
            }
            // No clipboard here: show the text to copy by hand.
            const d = show(JE.t('tag_presets_share_title', { name: presetText(preset, source).name }));
            d.body.innerHTML = `<p class="je-pt-hint">${tx('tag_presets_share_desc')}</p><textarea class="je-pt-text" rows="10" readonly spellcheck="false" aria-label="${tx('tag_presets_share_title', { name: presetText(preset, source).name })}">${esc(text)}</textarea>`;
            d.foot.innerHTML = buttonHtml('download', 'tag_portable_download', { icon: 'download' }) + buttonHtml('close', 'awards_close', { primary: true });
            d.foot.onclick = (e) => {
                const action = actionOf(e)?.getAttribute('data-pt-action');
                if (action === 'download') download(shareable(preset, source), `jellyfin-media-tags-preset-${String(preset.id || 'shared')}`);
                if (action === 'close') d.close();
            };
            const area = d.body.querySelector('textarea');
            area?.focus();
            area?.select();
        };

        /**
         * Show (or hide, with null) why a preset is still listed, with Retry.
         * Updated in place, so a focused Retry keeps focus.
         */
        const showDeleteError = (preset: { id: unknown; name: string } | null) => {
            failedDelete = preset;
            deleteError.hidden = !preset;
            const text = deleteError.querySelector('[data-tp-error-text]');
            if (text) text.textContent = preset ? JE.t('tag_presets_delete_failed', { name: preset.name }) : '';
        };

        const deletePreset = async (preset: { id: unknown; name: string }) => {
            try {
                await ajax({ type: 'DELETE', url: userUrl(`presets/${encodeURIComponent(String(preset.id))}`) });
            } catch (err) {
                // Already gone (another device deleted it): the reload shows that.
                if (statusOf(err) !== 404) {
                    console.warn('🪼 Jellyfin Enhanced: could not delete the preset', err);
                    if (!live()) return;
                    // Still there: say so (never "deleted"), keep the row and offer Retry.
                    showDeleteError(preset);
                    focusElement(deleteError.querySelector('[data-tp="delete-retry"]'));
                    return;
                }
            }
            if (!live()) return;
            showDeleteError(null);
            await loadPresets();
            hooks.announce(JE.t('tag_presets_deleted', { name: preset.name }));
            focusElement(presetsCard.querySelector('[data-tp="save-preset"]'));
        };

        const onClick = (e: MouseEvent) => {
            const button = closestTarget(e, '[data-tp]');
            // A panel left from another session starts nothing.
            if (!button || (button instanceof HTMLButtonElement && button.disabled) || !live()) return;
            const action = button.dataset.tp;
            touch();
            if (action === 'export') openExport();
            else if (action === 'import') openSource({ titleKey: 'tag_portable_import_title', hintKey: 'tag_portable_import_desc', onDocument: (d, doc, back) => showPreview(d, doc, back) });
            else if (action === 'undo') undo();
            else if (action === 'save-preset') openSavePreset();
            else if (action === 'import-preset') openImportPreset();
            else if (action === 'delete-retry') { if (failedDelete) deletePreset(failedDelete); }
            else {
                const found = presetOf(button);
                if (!found) return;
                if (action === 'apply') {
                    const d = show(JE.t('tag_presets_apply_named', { name: presetText(found.preset, found.source).name }));
                    d.body.innerHTML = `<p class="je-pt-hint" data-pt-loading>${tx('hidden_content_admin_loading')}</p>`;
                    d.foot.innerHTML = buttonHtml('cancel', 'jellyseerr_modal_cancel');
                    d.foot.onclick = () => d.close();
                    d.focusFirst();
                    showPreview(d, shareable(found.preset, found.source));
                } else if (action === 'share') sharePreset(found.preset, found.source, button);
                else if (action === 'delete') deletePreset({ id: found.preset.id, name: String(found.preset.name) });
            }
        };
        presetsCard.addEventListener('click', onClick);
        portableCard.addEventListener('click', onClick);

        const presetsLoaded = loadPresets();
        drawUndo();
        // Opened again after an import: back on the Layout tab, at the Undo
        // (once the presets list above it has its height).
        const reopened = internal.tagPortableReopen;
        if (reopened) {
            internal.tagPortableReopen = null;
            presetsLoaded.then(() => setTimeout(() => {
                if (disposed) return;
                ctx.openPane?.('media-tags');
                internal.mediaTagsHub?.openTab?.('layout');
                const target = queryButton(undoBar, 'button') || queryElement(portableCard, '[data-tp="import"]');
                // Scroll the pane only: scrollIntoView would also move the panel's own (clipped) box.
                const main = portableCard.closest('.je-panel-main');
                if (main && target) {
                    const box = main.getBoundingClientRect();
                    main.scrollTop += target.getBoundingClientRect().top - box.top - box.height / 2;
                }
                target?.focus({ preventScroll: true });
                if (reopened.messageKey) hooks.announce(JE.t(reopened.messageKey));
                else if (lastImport?.isCurrent()) hooks.announce(JE.t('tag_portable_applied', { count: lastImport.count }));
            }, 0));
        }

        return () => {
            disposed = true;
            clearTimeout(undoTimer);
            dialog?.close();
            presetsCard.removeEventListener('click', onClick);
            portableCard.removeEventListener('click', onClick);
        };
    };
    internal.wireTagPortable = wireTagPortable;

    /** Forget the last import's Undo (a user switch). */
    JE.session?.onUserChange?.('tag-portable', () => {
        lastImport = null;
        internal.tagPortableReopen = null;
    });
}

installUiPanelTagPortable(panelHost());
