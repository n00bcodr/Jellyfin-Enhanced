/**
 * @file Media Tags import, export and presets: the hub's Presets and
 * Import & export cards (bottom of the Layout tab), and the dialogs, file and
 * clipboard helpers the Media Tags admin page reuses
 * (js/enhanced/admintags/sections/portable.js).
 *
 * A document is `{"v":1,"kind":"je-media-tags-user","settings":{…}}` with the
 * server's PascalCase field names (Helpers/MediaTagsPortable.cs); a preset adds
 * an id, a name and a description. Every import is checked by the server first
 * (POST user-settings/{id}/media-tags/preview, the settings save path's
 * validators): the dialog shows what changes and which fields are skipped, and
 * only after a confirmation are the changed fields written into the user's
 * document and saved the usual way. The panel then opens again on the new
 * settings with Undo for a few seconds.
 */
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.enhancedUi = JE.internals.enhancedUi || {};

    const USER_KIND = 'je-media-tags-user';
    const PRESET_KIND = 'je-media-tags-preset';
    const UNDO_MS = 10000;
    const MAX_NAME = 60;
    const MAX_DESCRIPTION = 240;
    /** Values longer than this are cut in the change list (the whole value is still applied). */
    const MAX_VALUE_TEXT = 80;

    /**
     * The group switches an import can change, and how the page follows each
     * one live (the same calls the group editor's switches make).
     */
    const GROUP_SWITCHES = [
        { key: 'qualityTagsEnabled', group: 'quality', container: 'quality-overlay-container', init: 'initializeQualityTags', reinit: 'reinitializeQualityTags' },
        { key: 'genreTagsEnabled', group: 'genre', container: 'genre-overlay-container', init: 'initializeGenreTags', reinit: 'reinitializeGenreTags' },
        { key: 'languageTagsEnabled', group: 'language', container: 'language-overlay-container', init: 'initializeLanguageTags', reinit: 'reinitializeLanguageTags' },
        { key: 'ratingTagsEnabled', group: 'rating', container: 'rating-overlay-container', init: 'initializeRatingTags', reinit: 'reinitializeRatingTags' },
        { key: 'ageRatingTagsEnabled', group: 'ageRating', container: 'age-rating-overlay-container', init: 'initializeAgeRatingTags', reinit: 'reinitializeAgeRatingTags' },
        { key: 'statusTagsEnabled', group: 'status', container: 'status-overlay-container', init: 'initializeStatusTags', reinit: 'reinitializeStatusTags' },
        { key: 'awardsTagsEnabled', group: 'awards', container: 'awards-overlay-container', init: 'initializeAwardsTags', reinit: 'reinitializeAwardsTags' },
        { key: 'logoTagsEnabled', group: 'logos', container: 'logo-overlay-container', init: 'initializeLogoTags', reinit: 'reinitializeLogoTags' },
        { key: 'customTagsEnabled', group: 'custom', container: 'custom-overlay-container', init: 'initializeCustomTags', reinit: 'reinitializeCustomTags' },
    ];

    const esc = (value) => JE.escapeHtml(String(value ?? ''));
    /** @param {string} key @param {Object} [params] @returns {string} Translated and escaped. */
    const tx = (key, params) => esc(JE.t(key, params));

    /**
     * The last import applied in this browser tab, for Undo after the panel
     * opened again: the changes it made, until when Undo is offered and
     * whether the session that made it is still the signed-in one.
     * @type {{changes: Array<{field: string, from: *, to: *}>, until: number, count: number, isCurrent: () => boolean}|null}
     */
    let lastImport = null;

    // ── Shared helpers (the admin page uses them too) ───────────────────

    /** @param {string} field - A PascalCase field. @returns {string} Its name spelled out ("Tag Group Caps"). */
    const fieldName = (field) => String(field).replace(/([a-z0-9])([A-Z])/g, '$1 $2');

    /**
     * A value as one short line for the change list.
     * @param {*} value
     * @returns {string}
     */
    function valueText(value) {
        if (value === null || value === undefined) return JE.t('tag_portable_value_inherit');
        if (typeof value === 'boolean') return JE.t(value ? 'tag_portable_value_on' : 'tag_portable_value_off');
        const text = typeof value === 'string' ? (value === '' ? JE.t('tag_portable_value_empty') : value) : JSON.stringify(value);
        return text.length > MAX_VALUE_TEXT ? `${text.slice(0, MAX_VALUE_TEXT - 1)}…` : text;
    }

    /**
     * The change list and the skipped list of a preview.
     * @param {{changes?: Array<{field: string, from: *, to: *}>, skipped?: Array<{field: string, reason: string, detail?: string}>}} preview
     * @param {{summary?: boolean}} [opts] - summary: false leaves out the "N changes" line.
     * @returns {string}
     */
    function previewHtml(preview, opts = {}) {
        const changes = preview.changes || [];
        const skipped = preview.skipped || [];
        const rows = changes.map((c) => `<li class="je-pt-change"><span class="je-pt-field">${esc(fieldName(c.field))}</span>`
            + `<span class="je-pt-values"><span class="je-pt-from">${esc(valueText(c.from))}</span><span class="je-pt-arrow" aria-label="${tx('tag_portable_becomes')}">→</span><span class="je-pt-to">${esc(valueText(c.to))}</span></span></li>`).join('');
        const skips = skipped.map((s) => `<li class="je-pt-skip"><span class="je-pt-field">${esc(fieldName(s.field))}</span>`
            + `<span class="je-pt-reason">${tx(`tag_portable_skip_${['unknown', 'secret', 'signal', 'invalid'].includes(s.reason) ? s.reason : 'unknown'}`)}${s.detail ? ` <span class="je-pt-detail">(${esc(s.detail)})</span>` : ''}</span></li>`).join('');
        return (opts.summary === false ? '' : `<p class="je-pt-summary" data-je-summary>${tx(changes.length ? 'tag_portable_changes_count' : 'tag_portable_no_changes', { count: changes.length })}</p>`)
            + (changes.length ? `<ul class="je-pt-changes" aria-label="${tx('tag_portable_changes')}">${rows}</ul>` : '')
            + (skipped.length ? `<h4 class="je-pt-subtitle">${tx('tag_portable_skipped_count', { count: skipped.length })}</h4><p class="je-pt-hint">${tx('tag_portable_skipped_desc')}</p><ul class="je-pt-skips">${skips}</ul>` : '');
    }

    /**
     * The message for a document the server refused as a whole.
     * @param {string} code - not-json, not-object, kind, version, newer, settings, name, description, empty, full, save.
     * @param {Object} [params]
     * @returns {string}
     */
    const errorText = (code, params) => JE.t(`tag_portable_error_${['not-json', 'not-object', 'kind', 'version', 'newer', 'settings', 'name', 'description', 'empty', 'full', 'save'].includes(code) ? code : 'save'}`.replace(/-/g, '_'), params);

    /**
     * The `error` code of a refused request (a fetch Response from ApiClient.ajax), or 'save'.
     * @param {*} err
     * @returns {Promise<{code: string, max?: number}>}
     */
    async function errorOf(err) {
        try {
            const body = typeof err?.json === 'function' ? await err.json() : err;
            if (body && typeof body.error === 'string') return { code: body.error, max: body.max };
        } catch { /* not JSON */ }
        return { code: 'save' };
    }

    /**
     * Parse pasted or loaded text as a JSON document.
     * @param {string} text
     * @returns {{document?: Object, error?: string}}
     */
    function parseDocument(text) {
        try {
            const document = JSON.parse(String(text || '').trim());
            if (!document || typeof document !== 'object' || Array.isArray(document)) return { error: 'not-object' };
            return { document };
        } catch {
            return { error: 'not-json' };
        }
    }

    /**
     * Offer a document as a file download.
     * @param {Object} document
     * @param {string} name - File name without extension.
     */
    function download(document, name) {
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

    /**
     * Copy text to the clipboard (the textarea fallback where the async API is missing or refused).
     * @param {string} text
     * @param {HTMLTextAreaElement} [fallback] - Selected and copied when the API fails.
     * @returns {Promise<boolean>}
     */
    async function copyText(text, fallback) {
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch { /* fall back */ }
        if (!fallback) return false;
        fallback.focus();
        fallback.select();
        try { return window.document.execCommand('copy'); } catch { return false; }
    }

    /**
     * Read a chosen file as text.
     * @param {File} file
     * @returns {Promise<string>}
     */
    function readFile(file) {
        if (typeof file.text === 'function') return file.text();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(reader.error);
            reader.readAsText(file);
        });
    }

    /** @returns {string} A date stamp for file names (2026-10-31). */
    const stamp = () => new Date().toISOString().slice(0, 10);

    /**
     * A modal dialog drawn inside `host` (the settings panel or the admin
     * page): focus moves in and is kept there, Escape and Cancel close it and
     * focus returns to the control that opened it. Escape is not passed on,
     * so it never closes the settings panel behind it.
     * @param {{host: HTMLElement, title: string, className?: string, onClose?: () => void}} options
     * @returns {{el: HTMLElement, body: HTMLElement, foot: HTMLElement, status: (message: string, kind?: string) => void, close: () => void, focusFirst: () => void, closed: () => boolean}}
     */
    function openDialog({ host, title, className = '', onClose }) {
        const opener = /** @type {HTMLElement|null} */ (window.document.activeElement);
        const id = `jePt${Math.random().toString(36).slice(2, 8)}`;
        const backdrop = window.document.createElement('div');
        backdrop.className = `je-pt-backdrop ${className}`.trim();
        backdrop.innerHTML = `<div class="je-pt-dialog" role="dialog" aria-modal="true" aria-labelledby="${id}Title" tabindex="-1">`
            + `<div class="je-pt-head"><h3 class="je-pt-title" id="${id}Title">${esc(title)}</h3><button type="button" class="je-pt-close" data-pt-close aria-label="${tx('awards_close')}"><span class="material-icons" aria-hidden="true">close</span></button></div>`
            + '<div class="je-pt-body"></div><p class="je-pt-status" role="status" aria-live="polite"></p><div class="je-pt-foot"></div></div>';
        host.appendChild(backdrop);
        const dialog = /** @type {HTMLElement} */ (backdrop.firstElementChild);
        const statusEl = /** @type {HTMLElement} */ (dialog.querySelector('.je-pt-status'));
        let isClosed = false;
        const focusables = () => Array.from(dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href]'))
            .filter((el) => !el.closest('[hidden]'));
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
            const list = focusables();
            if (!list.length) return;
            e.stopPropagation();
            const at = list.indexOf(/** @type {HTMLElement} */ (window.document.activeElement));
            if (e.shiftKey && at <= 0) { e.preventDefault(); list[list.length - 1].focus(); }
            else if (!e.shiftKey && at === list.length - 1) { e.preventDefault(); list[0].focus(); }
        });
        backdrop.addEventListener('click', (e) => {
            if (/** @type {HTMLElement} */ (e.target).closest('[data-pt-close]')) close();
        });
        const focusFirst = () => {
            const first = /** @type {HTMLElement|undefined} */ (dialog.querySelector('[data-pt-autofocus]') || focusables().find((el) => !el.matches('[data-pt-close]')));
            (first || dialog).focus({ preventScroll: true });
        };
        return {
            el: dialog,
            body: /** @type {HTMLElement} */ (dialog.querySelector('.je-pt-body')),
            foot: /** @type {HTMLElement} */ (dialog.querySelector('.je-pt-foot')),
            status(message, kind = '') {
                statusEl.textContent = message;
                statusEl.dataset.kind = kind;
            },
            close,
            focusFirst,
            closed: () => isClosed,
        };
    }

    /**
     * The "load a file or paste" step of an import.
     * @param {string} hintKey
     * @returns {string}
     */
    function sourceHtml(hintKey) {
        return `<p class="je-pt-hint">${tx(hintKey)}</p>
            <label class="je-pt-file"><span class="material-icons" aria-hidden="true">upload_file</span><span>${tx('tag_portable_choose_file')}</span><input type="file" accept=".json,application/json" data-pt-file></label>
            <label class="je-pt-label" for="jePtPaste">${tx('tag_portable_paste')}</label>
            <textarea id="jePtPaste" class="je-pt-text" rows="8" spellcheck="false" data-pt-paste data-pt-autofocus placeholder='{"v":1,"kind":"je-media-tags-user","settings":{…}}'></textarea>`;
    }

    /**
     * Wire a source step: a chosen file fills the paste box.
     * @param {ReturnType<typeof openDialog>} dialog
     */
    function wireSource(dialog) {
        const file = /** @type {HTMLInputElement} */ (dialog.body.querySelector('[data-pt-file]'));
        const paste = /** @type {HTMLTextAreaElement} */ (dialog.body.querySelector('[data-pt-paste]'));
        file?.addEventListener('change', async () => {
            const chosen = file.files?.[0];
            if (!chosen) return;
            try {
                paste.value = await readFile(chosen);
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
        .je-pt-hint { margin: 4px 0 10px; font-size: 12.5px; line-height: 1.45; color: rgba(255,255,255,0.7); }
        .je-pt-label { display: block; margin: 10px 0 4px; font-size: 13px; font-weight: 600; }
        .je-pt-text, .je-pt-input { box-sizing: border-box; width: 100%; padding: 8px; border-radius: 6px; border: 1px solid #5a606b; background: #12141a; color: #fff; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
        .je-pt-input { font: inherit; font-size: 14px; min-height: 40px; }
        .je-pt-text[readonly] { color: #d6dbe4; }
        .je-pt-file { position: relative; display: inline-flex; align-items: center; gap: 6px; min-height: 40px; padding: 0 12px; border-radius: 6px; border: 1px dashed rgba(255,255,255,0.35); cursor: pointer; font-size: 13px; font-weight: 600; }
        .je-pt-file input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
        .je-pt-file:focus-within { outline: 2px solid #fff; outline-offset: 2px; }
        .je-pt-summary { margin: 4px 0 8px; font-weight: 600; }
        .je-pt-subtitle { margin: 14px 0 2px; font-size: 13px; font-weight: 600; color: #ffd699; }
        .je-pt-changes, .je-pt-skips { list-style: none; margin: 0 0 6px; padding: 0; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; }
        .je-pt-change, .je-pt-skip { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 2px 12px; padding: 7px 10px; font-size: 13px; }
        .je-pt-change + .je-pt-change, .je-pt-skip + .je-pt-skip { border-top: 1px solid rgba(255,255,255,0.07); }
        .je-pt-field { font-weight: 600; }
        .je-pt-values { display: inline-flex; flex-wrap: wrap; gap: 6px; min-width: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
        .je-pt-from { color: rgba(255,255,255,0.6); text-decoration: line-through; overflow-wrap: anywhere; }
        .je-pt-to { color: #8fe3a5; overflow-wrap: anywhere; }
        .je-pt-arrow { color: rgba(255,255,255,0.5); }
        .je-pt-reason { color: #ffd699; font-size: 12.5px; }
        .je-pt-detail { color: rgba(255,255,255,0.6); }
        .je-pt-status { min-height: 18px; margin: 8px 16px 0; font-size: 12.5px; color: #8fe3a5; }
        .je-pt-status[data-kind="error"] { color: #ff8a80; }
        .je-pt-foot { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; padding: 10px 16px 14px; }
        .je-pt-btn { display: inline-flex; align-items: center; gap: 6px; min-height: 40px; padding: 0 14px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.25); background: rgba(255,255,255,0.06); color: #fff; font: inherit; font-size: 13.5px; font-weight: 600; cursor: pointer; white-space: nowrap; }
        .je-pt-btn:hover { background: rgba(255,255,255,0.12); }
        .je-pt-btn[data-primary] { background: #00a4dc; border-color: #00a4dc; }
        .je-pt-btn[data-primary]:hover { background: #0aa9e0; }
        .je-pt-btn:disabled { opacity: 0.45; cursor: default; }
        .je-pt-btn .material-icons { font-size: 18px; }
        :is(.je-pt-btn, .je-pt-close, .je-pt-text, .je-pt-input):focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
        @media (max-width: 480px) {
            .je-pt-backdrop { padding: 8px; }
            .je-pt-foot .je-pt-btn { flex: 1 1 auto; justify-content: center; }
        }
    `;

    /** Inject the dialogs' stylesheet once. */
    const injectDialogCss = () => JE.core?.ui?.injectCss?.('je-tag-portable-dialog', DIALOG_CSS);

    /**
     * A footer button.
     * @param {string} action
     * @param {string} labelKey
     * @param {{primary?: boolean, icon?: string, params?: Object}} [opts]
     * @returns {string}
     */
    const buttonHtml = (action, labelKey, opts = {}) => `<button type="button" class="je-pt-btn" data-pt-action="${esc(action)}"${opts.primary ? ' data-primary' : ''}>${opts.icon ? `<span class="material-icons" aria-hidden="true">${esc(opts.icon)}</span>` : ''}${tx(labelKey, opts.params)}</button>`;

    internal.tagPortable = { openDialog, previewHtml, valueText, fieldName, errorText, errorOf, parseDocument, download, copyText, readFile, sourceHtml, wireSource, buttonHtml, injectDialogCss, stamp };

    // ── The hub's cards ────────────────────────────────────────────────

    /** @returns {string} The user id the requests are for. */
    const userId = () => (typeof ApiClient !== 'undefined' && ApiClient.getCurrentUserId?.()) || '';
    /** @param {string} path @returns {string} */
    const userUrl = (path) => ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId()}/media-tags/${path}`);
    /** @returns {string} The server the requests go to. */
    const serverId = () => {
        try {
            return (typeof ApiClient !== 'undefined' && (typeof ApiClient.serverId === 'function' ? ApiClient.serverId() : ApiClient.serverId)) || '';
        } catch {
            return '';
        }
    };

    /**
     * Capture the signed-in session (user, server and JE.session epoch) at the
     * start of an operation. The check stays true only while that session
     * lasts: A → B → A and the same user id on another server both end it, so
     * a late answer never writes into, or offers Undo to, the next account.
     * @returns {() => boolean}
     */
    function sessionCheck() {
        const user = userId();
        const server = serverId();
        const epoch = JE.session?.getEpoch?.();
        return () => userId() === user && serverId() === server && JE.session?.getEpoch?.() === epoch;
    }

    /**
     * The hub's two cards for the Layout tab.
     * @returns {string}
     */
    internal.buildTagPortableHtml = function() {
        return `
            <section class="je-mth-card je-mth-tp" id="jeMthPresets" aria-labelledby="jeMthPresetsTitle">
                <h4 class="je-mth-card-title" id="jeMthPresetsTitle">${tx('tag_presets_title')}</h4>
                <p class="je-mth-hint">${tx('tag_presets_desc')}</p>
                <div class="je-mth-tp-list" data-tp-list aria-live="polite"><p class="je-mth-hint">${tx('hidden_content_admin_loading')}</p></div>
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
        #jellyfin-enhanced-panel .je-mth-tp-count { font-weight: 400; color: rgba(255,255,255,0.55); text-transform: none; letter-spacing: 0; }
    `;

    /**
     * Converts a server value (PascalCase objects) the way settings.json is
     * read into JE.currentSettings (JE.toCamelCase: object keys, not arrays).
     * @param {*} value
     * @returns {*}
     */
    const toClient = (value) => (typeof JE.toCamelCase === 'function' ? JE.toCamelCase({ v: value }).v : value);

    /** @param {string} field @returns {string} The camelCase settings key of a PascalCase field. */
    const clientKey = (field) => field.charAt(0).toLowerCase() + field.slice(1);

    /**
     * Write changed fields into the user's document and save it through the
     * normal settings save (which normalises them once more), then follow the
     * new group switches on the page. A null value keeps (or makes) the field
     * follow the administrator: it is saved as null, never as today's default.
     * @param {Array<{field: string, to: *}>} changes
     * @param {() => boolean} isCurrent - The session the import belongs to (sessionCheck).
     * @returns {Promise<boolean>} False when that session ended first (nothing
     *   more is done for it); rejects when the save failed (nothing is kept then).
     */
    async function writeChanges(changes, isCurrent) {
        const settings = JE.currentSettings;
        const before = {};
        const inheritedBefore = {};
        const wasOn = Object.fromEntries(GROUP_SWITCHES.map((g) => [g.key, !!settings[g.key]]));
        const nativeBefore = JE.userConfig?.settings?.useNativePosterTags;
        for (const change of changes) {
            const key = clientKey(change.field);
            before[key] = settings[key];
            inheritedBefore[key] = JE.isSettingInherited?.(settings, key) === true;
            const value = toClient(change.to);
            if (key === 'useNativePosterTags') {
                // Saved as chosen (null stays "not chosen", which is on).
                JE.userConfig = JE.userConfig || {};
                JE.userConfig.settings = JE.userConfig.settings || {};
                JE.userConfig.settings.useNativePosterTags = value;
                settings.useNativePosterTags = value !== false;
            } else if (JE.setSettingInherited?.(settings, key, value === null)) {
                // Shown resolved, saved as null while inherited (config.js).
                if (value !== null) settings[key] = value;
            } else settings[key] = value;
        }
        try {
            // Queued saves read the document at their turn: one for a session that
            // ended by then is dropped, never sent for the next account.
            await JE.saveUserSettings('settings.json', settings, { throwOnError: true, isCurrent });
        } catch (err) {
            // Another session's documents are not this import's to roll back.
            if (!isCurrent()) throw err;
            Object.assign(settings, before);
            for (const [key, inherited] of Object.entries(inheritedBefore)) {
                if (JE.setSettingInherited?.(settings, key, inherited)) settings[key] = before[key];
            }
            if (JE.userConfig?.settings && 'useNativePosterTags' in before) JE.userConfig.settings.useNativePosterTags = nativeBefore;
            throw err;
        }
        if (!isCurrent()) return false;
        JE.core?.tagLayout?.invalidateSettings?.();
        for (const g of GROUP_SWITCHES) {
            const on = !!settings[g.key];
            try {
                if (on && !wasOn[g.key]) JE[g.init]?.();
                else if (on) JE[g.reinit]?.();
                else if (wasOn[g.key]) internal.removeTagGroup?.(g.group, g.container);
            } catch (err) {
                console.warn(`🪼 Jellyfin Enhanced: could not redraw the ${g.group} tags after an import`, err);
            }
        }
        JE.reinitializeTagLayout?.();
        return true;
    }

    /**
     * Wire the hub's cards. Called by wireMediaTagsHub; returns the teardown.
     * @param {HTMLElement} hub - #jeMediaTagsHub.
     * @param {Object} ctx - Panel context (help, closePanel, openPane, resetAutoCloseTimer).
     * @param {{announce: (message: string) => void}} hooks
     * @returns {() => void}
     */
    internal.wireTagPortable = function(hub, ctx, hooks) {
        const presetsCard = /** @type {HTMLElement|null} */ (hub.querySelector('#jeMthPresets'));
        const portableCard = /** @type {HTMLElement|null} */ (hub.querySelector('#jeMthPortable'));
        if (!presetsCard || !portableCard || typeof ApiClient === 'undefined') return () => {};
        JE.core?.ui?.injectCss?.('je-media-tags-portable', CARD_CSS);
        injectDialogCss();
        const host = /** @type {HTMLElement} */ (ctx.help || hub);
        const list = /** @type {HTMLElement} */ (presetsCard.querySelector('[data-tp-list]'));
        const undoBar = /** @type {HTMLElement} */ (portableCard.querySelector('[data-tp-undo]'));
        const touch = () => { try { ctx.resetAutoCloseTimer?.(); } catch { /* panel closing */ } };
        const viewSession = sessionCheck();
        let disposed = false;
        /** @type {ReturnType<typeof openDialog>|null} */
        let dialog = null;
        let undoTimer = null;
        /** @type {{max: number, builtIn: Object[], offered: Object[], mine: Object[]}|null} */
        let presets = null;

        /** @returns {boolean} Whether answers still belong to this view and its session. */
        const live = () => !disposed && viewSession();

        /** @param {Object} preset @returns {{name: string, description: string}} A preset's shown name (built-ins are translated). */
        const presetText = (preset, source) => source === 'builtIn'
            ? { name: JE.t(JE.core.tagLayout.VOCABULARY_KEYS.builtin[`${preset.id}`]), description: JE.t(JE.core.tagLayout.VOCABULARY_KEYS.builtin[`${preset.id}_desc`]) }
            : { name: String(preset.name || ''), description: String(preset.description || '') };

        /** Draw the presets list. */
        const drawPresets = () => {
            if (!presets) return;
            const group = (source, titleKey, items, count) => items.length || source === 'mine' ? `
                <div class="je-mth-tp-group" data-tp-source="${source}">
                    <h5 class="je-mth-tp-group-title">${tx(titleKey)}${count ? ` <span class="je-mth-tp-count">${esc(count)}</span>` : ''}</h5>
                    ${items.length ? `<ul class="je-mth-tp-items">${items.map((p, i) => {
                        const text = presetText(p, source);
                        return `<li class="je-mth-tp-item" data-tp-index="${i}">
                            <div class="je-mth-tp-text"><div class="je-mth-tp-name" data-je-label>${esc(text.name)}</div>${text.description ? `<div class="je-mth-tp-desc">${esc(text.description)}</div>` : ''}</div>
                            <div class="je-mth-tp-buttons">
                                <button type="button" class="je-mth-button" data-tp="apply" aria-label="${tx('tag_presets_apply_named', { name: text.name })}">${tx('tag_presets_apply')}</button>
                                <button type="button" class="je-mth-button" data-tp="share" aria-label="${tx('tag_presets_share_named', { name: text.name })}">${tx('tag_presets_share')}</button>
                                ${source === 'mine' ? `<button type="button" class="je-mth-button" data-tp="delete" aria-label="${tx('admin_tags_rules_delete', { name: text.name })}">${tx('reviews_delete')}</button>` : ''}
                            </div>
                        </li>`;
                    }).join('')}</ul>` : `<p class="je-mth-hint">${tx('tag_presets_none_yet')}</p>`}
                </div>` : '';
            list.innerHTML = group('builtIn', 'tag_presets_builtin', presets.builtIn)
                + group('offered', 'tag_presets_offered', presets.offered)
                + group('mine', 'tag_presets_mine', presets.mine, JE.t('tag_looks_condition_count', { count: presets.mine.length, max: presets.max }));
            // A full list: saving or importing another is off until one is deleted.
            const full = presets.mine.length >= presets.max;
            for (const button of presetsCard.querySelectorAll('[data-tp="save-preset"], [data-tp="import-preset"]')) {
                /** @type {HTMLButtonElement} */ (button).disabled = full;
                /** @type {HTMLElement} */ (button).title = full ? JE.t('tag_presets_full', { max: presets.max }) : '';
            }
        };

        /** Load (or reload) the presets list. */
        const loadPresets = async () => {
            try {
                const answer = await ApiClient.ajax({ type: 'GET', url: userUrl('presets'), dataType: 'json' });
                if (!live()) return;
                presets = { max: Number(answer?.max) || 10, builtIn: answer?.builtIn || [], offered: answer?.offered || [], mine: answer?.mine || [] };
                drawPresets();
            } catch (err) {
                if (!live()) return;
                console.warn('🪼 Jellyfin Enhanced: could not load the Media Tags presets', err);
                list.innerHTML = `<p class="je-mth-off">${tx('tag_presets_load_failed')}</p>`;
            }
        };

        /**
         * Save the panel's settings before the server reads them: the preview
         * compares with, and the export reads, the stored settings.json. An edit
         * still on its way is waited for; one kept after a failed save is sent
         * again.
         * @param {() => boolean} isCurrent - The operation's session (sessionCheck).
         * @returns {Promise<boolean>} False when the save failed (the panel keeps the edit).
         */
        const saveFirst = async (isCurrent) => {
            try {
                await JE.saveUserSettings('settings.json', JE.currentSettings, { throwOnError: true, isCurrent });
                return true;
            } catch (err) {
                console.warn('🪼 Jellyfin Enhanced: the Media Tags settings are not saved yet', err);
                return false;
            }
        };

        /**
         * The user's own export, after the panel's settings were saved.
         * @param {() => boolean} isCurrent - The operation's session (sessionCheck).
         * @returns {Promise<{document?: Object, unsaved?: boolean}|null>} unsaved when
         *   the save failed (nothing was exported); null when that session ended first.
         */
        const fetchExport = async (isCurrent) => {
            const saved = await saveFirst(isCurrent);
            if (!isCurrent()) return null;
            if (!saved) return { unsaved: true };
            return { document: await ApiClient.ajax({ type: 'GET', url: userUrl('export'), dataType: 'json' }) };
        };

        /**
         * The panel's values of some fields (with their inherited state), to see
         * whether they changed since a preview compared them.
         * @param {string[]} fields - PascalCase fields.
         * @returns {string}
         */
        const clientSnapshot = (fields) => JSON.stringify(fields.map((field) => {
            const key = clientKey(field);
            const settings = JE.currentSettings || {};
            return [settings[key] ?? null, JE.isSettingInherited?.(settings, key) === true,
                key === 'useNativePosterTags' ? JE.userConfig?.settings?.useNativePosterTags ?? null : null];
        }));

        /**
         * Show or hide a dialog's loading line (hidden while its status says why nothing loads).
         * @param {ReturnType<typeof openDialog>} d
         * @param {boolean} on
         */
        const showLoading = (d, on) => {
            const line = /** @type {HTMLElement|null} */ (d.body.querySelector('[data-pt-loading]'));
            if (line) line.hidden = !on;
        };

        /**
         * Open a dialog in the panel (one at a time).
         * @param {string} title
         * @returns {ReturnType<typeof openDialog>}
         */
        const show = (title) => {
            dialog?.close();
            dialog = openDialog({ host, title, onClose: () => { dialog = null; touch(); } });
            dialog.el.addEventListener('input', touch);
            dialog.el.addEventListener('click', touch);
            return dialog;
        };

        // ── Export ──
        const openExport = async () => {
            const current = sessionCheck();
            const d = show(JE.t('tag_portable_export_title'));
            d.body.innerHTML = `<p class="je-pt-hint">${tx('tag_portable_export_desc')}</p><p class="je-pt-hint" data-pt-loading>${tx('hidden_content_admin_loading')}</p>`;
            d.foot.innerHTML = buttonHtml('close', 'awards_close');
            d.foot.onclick = (e) => {
                const action = /** @type {HTMLElement} */ (e.target).closest('[data-pt-action]')?.getAttribute('data-pt-action');
                if (action === 'retry') { d.foot.innerHTML = buttonHtml('close', 'awards_close'); showLoading(d, true); d.status(JE.t('tag_portable_checking')); load(); }
                else if (action === 'close') d.close();
            };
            d.focusFirst();
            const load = async () => {
                let result;
                try {
                    result = await fetchExport(current);
                } catch (err) {
                    if (!live() || !current() || d.closed()) return;
                    console.warn('🪼 Jellyfin Enhanced: could not export the Media Tags settings', err);
                    d.status(JE.t('tag_portable_export_failed'), 'error');
                    return;
                }
                if (!live() || !current() || d.closed() || !result) return;
                if (result.unsaved) {
                    // The stored settings are not the ones the panel shows: no export of them.
                    showLoading(d, false);
                    d.status(JE.t('tag_portable_export_unsaved'), 'error');
                    d.foot.innerHTML = buttonHtml('retry', 'admin_tags_retry', { primary: true }) + buttonHtml('close', 'awards_close');
                    /** @type {HTMLElement|null} */ (d.foot.querySelector('[data-pt-action="retry"]'))?.focus();
                    return;
                }
                d.status('');
                showExport(d, result.document);
            };
            await load();
        };

        /**
         * The export step: the document with Download and Copy.
         * @param {ReturnType<typeof openDialog>} d
         * @param {Object} document
         */
        const showExport = (d, document) => {
            const text = JSON.stringify(document, null, 2);
            d.body.innerHTML = `<p class="je-pt-hint">${tx('tag_portable_export_desc')}</p>
                <label class="je-pt-label" for="jePtExport">${tx('tag_portable_export_document', { count: Object.keys(document?.settings || {}).length })}</label>
                <textarea id="jePtExport" class="je-pt-text" rows="12" readonly spellcheck="false">${esc(text)}</textarea>`;
            d.foot.innerHTML = buttonHtml('download', 'tag_portable_download', { icon: 'download', primary: true }) + buttonHtml('copy', 'tag_portable_copy', { icon: 'content_copy' }) + buttonHtml('close', 'awards_close');
            const area = /** @type {HTMLTextAreaElement} */ (d.body.querySelector('textarea'));
            d.foot.onclick = async (e) => {
                const action = /** @type {HTMLElement} */ (e.target).closest('[data-pt-action]')?.getAttribute('data-pt-action');
                if (action === 'download') {
                    download(document, `jellyfin-media-tags-${stamp()}`);
                    d.status(JE.t('tag_portable_downloaded'));
                } else if (action === 'copy') {
                    d.status(JE.t(await copyText(text, area) ? 'tag_portable_copied' : 'tag_portable_copy_failed'), '');
                } else if (action === 'close') d.close();
            };
            /** @type {HTMLElement|null} */ (d.foot.querySelector('[data-pt-action="download"]'))?.focus();
        };

        // ── Import (a document, or a preset to apply) ──
        /**
         * Ask the server what a document would change and show it, with Apply.
         * The panel's settings are saved first (an edit on its way or kept after a
         * failed save), else the server would compare with settings the panel no
         * longer shows and leave out a field the panel changed.
         * @param {ReturnType<typeof openDialog>} d
         * @param {Object} document
         * @param {() => void} [back] - Shows the source step again.
         * @param {string} [note] - Status shown with the preview.
         */
        const showPreview = async (d, document, back, note) => {
            const current = sessionCheck();
            d.status(JE.t('tag_portable_checking'));
            showLoading(d, true);
            const saved = await saveFirst(current);
            if (!live() || !current() || d.closed()) return;
            if (!saved) {
                showLoading(d, false);
                d.status(JE.t('tag_portable_import_unsaved'), 'error');
                // On the source step Check tries again; elsewhere Retry does.
                if (d.body.querySelector('[data-pt-paste]')) return;
                d.foot.innerHTML = (back ? buttonHtml('back', 'tag_portable_back') : '') + buttonHtml('cancel', 'jellyseerr_modal_cancel')
                    + buttonHtml('retry', 'admin_tags_retry', { primary: true });
                d.foot.onclick = (e) => {
                    const action = /** @type {HTMLElement} */ (e.target).closest('[data-pt-action]')?.getAttribute('data-pt-action');
                    if (action === 'back') back?.();
                    else if (action === 'cancel') d.close();
                    else if (action === 'retry') showPreview(d, document, back, note);
                };
                /** @type {HTMLElement|null} */ (d.foot.querySelector('[data-pt-action="retry"]'))?.focus();
                return;
            }
            let preview;
            try {
                preview = await ApiClient.ajax({ type: 'POST', url: userUrl('preview'), data: JSON.stringify(document), contentType: 'application/json', dataType: 'json' });
            } catch (err) {
                if (!live() || d.closed()) return;
                const { code } = await errorOf(err);
                d.status(errorText(code), 'error');
                return;
            }
            if (!live() || !current() || d.closed()) return;
            d.status(note || '');
            const changes = preview?.changes || [];
            // The panel's values of every field the document sets, as the preview compared them.
            const fields = Array.from(new Set([...Object.keys(preview?.imported || {}), ...changes.map((c) => c.field)]));
            const compared = clientSnapshot(fields);
            d.body.innerHTML = (preview?.name ? `<p class="je-pt-hint">${tx('tag_portable_preset_named', { name: preview.name })}</p>` : '') + previewHtml(preview || {});
            d.foot.innerHTML = (back ? buttonHtml('back', 'tag_portable_back') : '') + buttonHtml('cancel', 'jellyseerr_modal_cancel')
                + (changes.length ? buttonHtml('apply', 'tag_portable_apply_count', { primary: true, params: { count: changes.length } }) : '');
            d.foot.onclick = async (e) => {
                const button = /** @type {HTMLButtonElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-pt-action]'));
                const action = button?.dataset.ptAction;
                if (action === 'back') back?.();
                else if (action === 'cancel') d.close();
                else if (action === 'apply' && button) {
                    // Changed in the panel since the preview: it no longer says what Apply changes.
                    if (clientSnapshot(fields) !== compared) {
                        showPreview(d, document, back, JE.t('tag_portable_import_changed'));
                        return;
                    }
                    button.disabled = true;
                    d.status(JE.t('tag_portable_applying'));
                    try {
                        await apply(changes);
                    } catch (err) {
                        if (!live() || d.closed()) return;
                        console.warn('🪼 Jellyfin Enhanced: could not apply the imported Media Tags settings', err);
                        button.disabled = false;
                        d.status(JE.t('tag_portable_apply_failed'), 'error');
                    }
                }
            };
            /** @type {HTMLElement|null} */ (d.foot.querySelector('[data-pt-action="apply"]') || d.foot.querySelector('[data-pt-action="cancel"]'))?.focus();
        };

        /**
         * The import dialog: a file or pasted text, then the preview.
         * @param {{titleKey: string, hintKey: string, nextKey?: string, onDocument: (d: ReturnType<typeof openDialog>, doc: Object, back: () => void) => void}} options
         */
        const openSource = ({ titleKey, hintKey, onDocument, nextKey = 'tag_portable_preview' }) => {
            const d = show(JE.t(titleKey));
            const step = () => {
                d.body.innerHTML = sourceHtml(hintKey);
                d.foot.innerHTML = buttonHtml('cancel', 'jellyseerr_modal_cancel') + buttonHtml('next', nextKey, { primary: true });
                wireSource(d);
                d.foot.onclick = (e) => {
                    const action = /** @type {HTMLElement} */ (e.target).closest('[data-pt-action]')?.getAttribute('data-pt-action');
                    if (action === 'cancel') { d.close(); return; }
                    if (action !== 'next') return;
                    const text = /** @type {HTMLTextAreaElement} */ (d.body.querySelector('[data-pt-paste]')).value;
                    const parsed = parseDocument(text);
                    if (parsed.error) { d.status(errorText(parsed.error), 'error'); return; }
                    onDocument(d, /** @type {Object} */ (parsed.document), () => { d.status(''); step(); d.focusFirst(); });
                };
                d.focusFirst();
            };
            step();
        };

        /**
         * Apply a preview's changes, then open the panel again on the new
         * settings with Undo.
         * @param {Array<{field: string, from: *, to: *}>} changes
         * @param {{undo?: boolean}} [opts] - undo: this is the Undo itself (no new Undo).
         */
        const apply = async (changes, opts = {}) => {
            const current = sessionCheck();
            if (!live() || !await writeChanges(changes, current)) return;
            // Published only while the import's session lasts; a closed panel
            // of that session still offers it when opened again.
            if (!opts.undo) lastImport = { changes, until: Date.now() + UNDO_MS, count: changes.length, isCurrent: current };
            if (!live()) return;
            dialog?.close();
            reopen(opts.undo ? 'tag_portable_undone' : null);
        };

        /**
         * Open the panel again (every control reads the new settings) on the Media Tags Layout tab.
         * @param {string|null} messageKey - Announced after it opened.
         */
        const reopen = (messageKey) => {
            internal.tagPortableReopen = { messageKey };
            ctx.closePanel?.();
            Promise.resolve(JE.showEnhancedPanel?.()).catch((err) => console.warn('🪼 Jellyfin Enhanced: could not open the settings again', err));
        };

        /** Show Undo for what is left of the last import's window. */
        const drawUndo = () => {
            clearTimeout(undoTimer);
            const left = lastImport ? lastImport.until - Date.now() : 0;
            if (!lastImport || left <= 0 || !lastImport.isCurrent() || !live()) {
                undoBar.hidden = true;
                undoBar.innerHTML = '';
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
        /** @param {HTMLElement} button @returns {{preset: Object, source: string}|null} */
        const presetOf = (button) => {
            const item = button.closest('[data-tp-index]');
            const source = button.closest('[data-tp-source]')?.getAttribute('data-tp-source');
            if (!item || !source || !presets) return null;
            const preset = presets[source]?.[Number(item.getAttribute('data-tp-index'))];
            return preset ? { preset, source } : null;
        };

        /** @param {Object} preset @param {string} source @returns {Object} The preset as shared: the shown name, no server id for built-ins. */
        const shareable = (preset, source) => {
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
                const button = /** @type {HTMLButtonElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-pt-action]'));
                if (button?.dataset.ptAction === 'cancel') { d.close(); return; }
                if (button?.dataset.ptAction !== 'save') return;
                const name = /** @type {HTMLInputElement} */ (d.body.querySelector('#jePtName')).value.trim();
                const description = /** @type {HTMLTextAreaElement} */ (d.body.querySelector('#jePtDesc')).value.trim();
                if (!name) { d.status(errorText('name'), 'error'); /** @type {HTMLElement} */ (d.body.querySelector('#jePtName')).focus(); return; }
                const current = sessionCheck();
                button.disabled = true;
                try {
                    const exported = await fetchExport(current);
                    if (!live() || !current() || d.closed() || !exported) return;
                    if (exported.unsaved) {
                        // A preset of the stored settings would not be what the panel shows.
                        button.disabled = false;
                        d.status(JE.t('tag_presets_save_unsaved'), 'error');
                        return;
                    }
                    await savePreset(d, { v: exported.document.v, kind: PRESET_KIND, name, description, settings: exported.document.settings }, current);
                } catch (err) {
                    if (!live() || !current() || d.closed()) return;
                    button.disabled = false;
                    d.status(errorText((await errorOf(err)).code, { max: presets?.max || 10 }), 'error');
                }
            };
            d.focusFirst();
        };

        /**
         * Save a preset to the user's list and report what was skipped.
         * @param {ReturnType<typeof openDialog>} d
         * @param {Object} document
         * @param {() => boolean} [isCurrent] - The operation's session (sessionCheck); the
         *   preset is posted only while it lasts, so always to the user who asked.
         */
        const savePreset = async (d, document, isCurrent = sessionCheck()) => {
            if (!live() || !isCurrent()) return;
            const answer = await ApiClient.ajax({ type: 'POST', url: userUrl('presets'), data: JSON.stringify(document), contentType: 'application/json', dataType: 'json' });
            if (!live() || !isCurrent()) return;
            await loadPresets();
            const skipped = answer?.skipped || [];
            if (!skipped.length || d.closed()) {
                d.close();
                hooks.announce(JE.t('tag_presets_saved', { name: answer?.preset?.name || document.name }));
                return;
            }
            d.body.innerHTML = `<p class="je-pt-summary">${tx('tag_presets_saved', { name: answer?.preset?.name || document.name })}</p>` + previewHtml({ skipped }, { summary: false });
            d.foot.innerHTML = buttonHtml('close', 'awards_close', { primary: true });
            d.foot.onclick = () => d.close();
            d.focusFirst();
        };

        const openImportPreset = () => openSource({
            titleKey: 'tag_presets_import_title',
            hintKey: 'tag_presets_import_desc',
            nextKey: 'tag_presets_import_button',
            onDocument: async (d, document) => {
                if (!document.name) { d.status(errorText('name'), 'error'); return; }
                try {
                    await savePreset(d, document);
                } catch (err) {
                    if (!live() || d.closed()) return;
                    d.status(errorText((await errorOf(err)).code, { max: presets?.max || 10 }), 'error');
                }
            },
        });

        const sharePreset = async (preset, source, button) => {
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
                const action = /** @type {HTMLElement} */ (e.target).closest('[data-pt-action]')?.getAttribute('data-pt-action');
                if (action === 'download') download(shareable(preset, source), `jellyfin-media-tags-preset-${String(preset.id || 'shared')}`);
                if (action === 'close') d.close();
            };
            const area = /** @type {HTMLTextAreaElement} */ (d.body.querySelector('textarea'));
            area.focus();
            area.select();
        };

        const deletePreset = async (preset) => {
            try {
                await ApiClient.ajax({ type: 'DELETE', url: userUrl(`presets/${encodeURIComponent(preset.id)}`) });
            } catch (err) {
                // Already gone (another device deleted it): the reload shows that.
                if (err?.status !== 404) console.warn('🪼 Jellyfin Enhanced: could not delete the preset', err);
            }
            if (!live()) return;
            await loadPresets();
            hooks.announce(JE.t('tag_presets_deleted', { name: preset.name }));
            /** @type {HTMLElement|null} */ (presetsCard.querySelector('[data-tp="save-preset"]'))?.focus();
        };

        const onClick = (e) => {
            const button = /** @type {HTMLButtonElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-tp]'));
            // A panel left from another session starts nothing.
            if (!button || button.disabled || !live()) return;
            const action = button.dataset.tp;
            touch();
            if (action === 'export') openExport();
            else if (action === 'import') openSource({ titleKey: 'tag_portable_import_title', hintKey: 'tag_portable_import_desc', onDocument: (d, doc, back) => showPreview(d, doc, back) });
            else if (action === 'undo') undo();
            else if (action === 'save-preset') openSavePreset();
            else if (action === 'import-preset') openImportPreset();
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
                else if (action === 'delete') deletePreset(found.preset);
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
                const target = /** @type {HTMLElement|null} */ (undoBar.querySelector('button') || portableCard.querySelector('[data-tp="import"]'));
                // Scroll the pane only: scrollIntoView would also move the panel's own (clipped) box.
                const main = /** @type {HTMLElement|null} */ (portableCard.closest('.je-panel-main'));
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

    /** Forget the last import's Undo (a user switch). */
    JE.session?.onUserChange?.('tag-portable', () => {
        lastImport = null;
        internal.tagPortableReopen = null;
    });
})(window.JellyfinEnhanced);
