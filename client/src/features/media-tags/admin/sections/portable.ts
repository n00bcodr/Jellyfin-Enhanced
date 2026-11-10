/**
 * @file Media Tags admin tab, Server tab: export and import of the
 * server-wide Media Tags settings, and the presets offered to users.
 *
 * Export is the server's document (GET admin/media-tags/export: every field
 * this page writes, never an API key or the custom rule key). Import saves
 * the page's pending edits, asks the server what a document would change
 * (POST admin/media-tags/preview, the field patch's own checks), and after a
 * confirmation writes the changed fields through the page's working copy, so
 * they are saved by the locked field patch with the values this page read: a
 * field another administrator changed meanwhile is refused and waits for Keep
 * mine / Take theirs, like any edit on this page. The offered presets are one
 * field (TagOfferedPresets, a JSON array, at most 20) that the server
 * validates like every other. The dialogs and file helpers are the settings
 * panel's (settingspanel/ui-panel-tag-portable.js).
 */
/*! Lexical index of this module's declarations, in the order Shared/MediaTags/MediaTagsPageFields.cs (the field
 *  patch's allowlist), Features/Admin/Services/WhatsNewService.cs and scripts/generate_config_flag_groups.py read them
 *  from the generated file. Not code: tests/frontend/features/media-tags/admin/admin-tags-rewrite.test.mjs keeps it equal
 *  to the sections this module registers and to what those readers found in the JavaScript module.
registerSection({
    tab: 'server',
    title: 'Import & export',
registerSection({
    tab: 'server',
    title: 'Presets for users',
        { id: 'tagOfferedPresets', key: 'TagOfferedPresets', type: 'custom', label: 'Presets for users' },
*/
import type { JsonValue } from '../../../../contracts/generated';
import { apiClient, currentUserId, settingsUi } from '../host';
import type { PortableDialog, TagPortableTools } from '../../settings/ui-panel-tag-portable';
import { closest, find, findAs } from '../dom';
import type { PageContext } from '../types';
import { configOf, copy, isObject, type Config, type JsonObject } from '../values';
import { installSection } from './install';

const MAX_OFFERED = 20;
const MAX_NAME = 60;
const MAX_DESCRIPTION = 240;

/** One change an import preview lists. */
interface PreviewChange { field: string; from: JsonValue; to: JsonValue }

/** The offered presets the configuration holds (malformed text reads as none). */
function offered(config: Config): JsonObject[] {
    try {
        const parsed: unknown = JSON.parse(String(config.TagOfferedPresets || '') || '[]');
        const value = copy(parsed);
        return Array.isArray(value) ? value.filter(isObject) : [];
    } catch {
        return [];
    }
}

/** A new preset id from its name: lower-case letters, digits and hyphens, unique in the list. */
function presetId(name: string, presets: readonly JsonObject[]): string {
    const base = String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'preset';
    let id: string;
    do id = `${base}-${Math.random().toString(36).slice(2, 8)}`; while (presets.some((p) => p.id === id));
    return id;
}

/** A JSON request to the server (path under JellyfinEnhanced/). */
function request(type: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const client = apiClient();
    return client.ajax({
        type,
        url: client.getUrl(`/JellyfinEnhanced/${path}`),
        dataType: 'json',
        ...(body ? { data: JSON.stringify(body), contentType: 'application/json' } : {}),
    });
}

/** The changes of an import preview answer (entries without a field name are not changes). */
function changesOf(answer: unknown): PreviewChange[] {
    const raw: unknown = answer && typeof answer === 'object' ? Reflect.get(answer, 'changes') : undefined;
    const out: PreviewChange[] = [];
    for (const c of Array.isArray(raw) ? raw : []) {
        if (!c || typeof c !== 'object') continue;
        const field: unknown = Reflect.get(c, 'field');
        if (typeof field !== 'string') continue;
        out.push({ field, from: copy(Reflect.get(c, 'from') ?? null), to: copy(Reflect.get(c, 'to') ?? null) });
    }
    return out;
}

/** A member of an untrusted answer object. */
const member = (value: unknown, key: string): unknown => (value && typeof value === 'object' ? Reflect.get(value, key) : undefined);

/**
 * Say in a dialog why nothing is shown: its loading line is hidden and, with
 * `retry`, Retry is offered (the same button when there is one, so a focused
 * Retry keeps focus; busy buttons are aria-disabled, not replaced).
 */
function failed(P: TagPortableTools | null, d: PortableDialog, message: string, retry = false): void {
    const line = find(d.body, '[data-pt-loading]');
    if (line) line.hidden = true;
    d.status(message, 'error');
    if (!retry || !P) return;
    const again = d.foot.querySelector('[data-pt-action="retry"]');
    if (again) { again.removeAttribute('aria-disabled'); return; }
    const close = d.foot.querySelector('[data-pt-action="close"]') ? P.buttonHtml('close', 'Close') : P.buttonHtml('cancel', 'Cancel');
    d.foot.innerHTML = close + P.buttonHtml('retry', 'Retry', { primary: true });
    find(d.foot, '[data-pt-action="retry"]')?.focus();
}

/** Start a Retry once: false while one is already working. */
function startRetry(button: Element | null): boolean {
    if (!button || button.getAttribute('aria-disabled') === 'true') return false;
    button.setAttribute('aria-disabled', 'true');
    return true;
}

/** The action a click in a dialog's footer names. */
const actionOf = (e: Event): string | null => closest(e, '[data-pt-action]')?.getAttribute('data-pt-action') ?? null;

installSection((A, JE) => {
    /** The shared dialogs and helpers. */
    const tools = (): TagPortableTools | null => settingsUi(JE)?.tagPortable || null;

    /** Read the configuration again after an import: every editor shows what was stored. */
    async function reloadPage(ctx: PageContext): Promise<void> {
        try {
            const fresh = configOf(await apiClient().getPluginConfiguration(A.PLUGIN_ID));
            if (ctx.isCurrent() && fresh) ctx.reload(fresh);
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: could not reload the configuration', err);
        }
    }

    A.registerSection({
        id: 'server-portable',
        tab: 'server',
        order: 30,
        title: 'Import & export',
        hint: 'Copy these server-wide Media Tags settings to another server, or keep a backup. You can also import your own settings from the Enhanced panel as the defaults. An import shows what changes and is saved like any edit on this page.',
        render(ctx, body) {
            const P = tools();
            body.innerHTML = `<div class="je-ta-actions">
                    <button type="button" class="je-ta-button" id="jeTaExport"><span class="material-icons" aria-hidden="true">download</span>${ctx.tx('Export server settings')}</button>
                    <button type="button" class="je-ta-button" id="jeTaImport"><span class="material-icons" aria-hidden="true">upload</span>${ctx.tx('Import server settings')}</button>
                </div>
                <p class="je-ta-hint">${ctx.tx('API keys and the custom rule key are never exported or imported.')}</p>`;
            if (!P) return;
            P.injectDialogCss();
            let dialog: PortableDialog | null = null;
            const show = (titleKey: string): PortableDialog => {
                dialog?.close();
                const opened = P.openDialog({ host: ctx.root, title: A.fmt(titleKey), onClose: () => { dialog = null; } });
                dialog = opened;
                return opened;
            };
            ctx.signal.addEventListener('abort', () => dialog?.close());

            const exportHint = ctx.tx('Every setting on this page: defaults, groups, Tag Styles, custom rules, award lists, logo choices, status windows, cache options and offered presets.');
            body.querySelector('#jeTaExport')?.addEventListener('click', async () => {
                const d = show('Export server Media Tags settings');
                d.body.innerHTML = `<p class="je-pt-hint">${exportHint}</p><p class="je-pt-hint" data-pt-loading>${ctx.tx('Loading…')}</p>`;
                d.foot.innerHTML = P.buttonHtml('close', 'Close');
                const load = async (): Promise<void> => {
                    let document: unknown;
                    try {
                        // Edits not saved yet belong in the export: a save that failed or is
                        // refused (Keep mine / Take theirs) would export the stored settings
                        // instead of the ones this page shows.
                        const saved = await ctx.flush();
                        if (!ctx.isCurrent() || d.closed()) return;
                        if (!saved) {
                            failed(P, d, A.fmt('Not exported: changes on this page are not saved yet. Retry the save, or choose Keep mine or Take theirs, then export again.'), true);
                            return;
                        }
                        document = await request('GET', 'admin/media-tags/export');
                    } catch (err) {
                        if (!ctx.isCurrent() || d.closed()) return;
                        console.warn('🪼 Jellyfin Enhanced: could not export the Media Tags settings', err);
                        failed(P, d, A.fmt('Could not read the settings. Try again.'), true);
                        return;
                    }
                    if (!ctx.isCurrent() || d.closed()) return;
                    d.status('');
                    showExport(d, document);
                };
                d.foot.onclick = (e) => {
                    const button = closest(e, '[data-pt-action]');
                    const action = button?.getAttribute('data-pt-action');
                    if (action === 'close') d.close();
                    else if (action === 'retry' && startRetry(button)) {
                        const line = find(d.body, '[data-pt-loading]');
                        if (line) line.hidden = false;
                        d.status(A.fmt('Checking…'));
                        void load();
                    }
                };
                d.focusFirst();
                await load();
            }, { signal: ctx.signal });

            /** The export step: the document with Download and Copy. */
            const showExport = (d: PortableDialog, document: unknown): void => {
                const json = JSON.stringify(document, null, 2);
                const settings = member(document, 'settings');
                const count = settings && typeof settings === 'object' ? Object.keys(settings).length : 0;
                d.body.innerHTML = `<p class="je-pt-hint">${exportHint}</p>
                    <details class="je-pt-doc"><summary class="je-pt-doc-toggle"><span class="material-icons" aria-hidden="true">expand_more</span>${ctx.tx('Show the settings document ({count} {count|setting|settings})', { count })}</summary>
                    <label class="je-pt-label" for="jeTaExportText">${ctx.tx('Settings document ({count} {count|setting|settings})', { count })}</label>
                    <textarea id="jeTaExportText" class="je-pt-text" rows="12" readonly spellcheck="false">${ctx.esc(json)}</textarea></details>`;
                d.foot.innerHTML = P.buttonHtml('close', 'Close') + P.buttonHtml('copy', 'Copy', { icon: 'content_copy' }) + P.buttonHtml('download', 'Download', { icon: 'download', primary: true });
                d.foot.onclick = async (e) => {
                    const action = actionOf(e);
                    if (action === 'download') {
                        P.download(document, `jellyfin-media-tags-server-${P.stamp()}`);
                        d.status(A.fmt('Downloaded.'));
                    } else if (action === 'copy') d.status(A.fmt(await P.copyText(json, findAs(d.body, 'textarea', HTMLTextAreaElement) ?? undefined) ? 'Copied' : 'Could not copy. Select the text and copy it yourself.'));
                    else if (action === 'close') d.close();
                };
                find(d.foot, '[data-pt-action="download"]')?.focus();
            };

            /** Write a preview's changes through the page and offer Undo. */
            const apply = async (d: PortableDialog, changes: PreviewChange[]): Promise<void> => {
                // What the server held when the preview compared it (the page read it
                // again just before): Undo puts it back, never an older copy of the page.
                const before: Config = Object.fromEntries(changes.map((c) => [c.field, copy(c.from ?? null)]));
                // Written against that value too: a listed change is sent (Expected = what the
                // preview compared) even if this page's copy of the field already equals it.
                ctx.setMany(Object.fromEntries(changes.map((c) => [c.field, c.to])), { base: before });
                const saved = await ctx.flush();
                if (!ctx.isCurrent()) return;
                if (!saved) {
                    // A field another administrator changed meanwhile (or a failed save): the save indicator offers the choice.
                    d.status(A.fmt('Another administrator changed some of these settings meanwhile: choose Keep mine or Take theirs at the top of the page. The other settings were saved.'), 'error');
                    return;
                }
                d.close();
                await reloadPage(ctx);
                ctx.snack(A.fmt('{count} server {count|setting|settings} changed.', { count: changes.length }), () => {
                    ctx.setMany(before);
                    void ctx.flush().then((ok) => (ok ? reloadPage(ctx) : null));
                }, () => body.querySelector('#jeTaImport'));
            };

            body.querySelector('#jeTaImport')?.addEventListener('click', () => {
                const d = show('Import server Media Tags settings');
                const notSaved = () => A.fmt('Not previewed: changes on this page are not saved yet. Retry the save, or choose Keep mine or Take theirs, then preview again.');
                /**
                 * Ask the server what the document changes, compared with what this page
                 * shows: edits not saved yet (on their way, failed or refused) are saved
                 * first, else the server would compare with settings the page no longer
                 * shows and leave out a field the page changed.
                 */
                const preview = async (document: object, note?: string): Promise<void> => {
                    d.status(A.fmt('Checking…'));
                    const saved = await ctx.flush();
                    if (!ctx.isCurrent() || d.closed()) return;
                    if (!saved) { d.status(notSaved(), 'error'); return; }
                    // A field this page never edited can be older here than on the server
                    // (another administrator or tab saved it since): read the settings again,
                    // so the page and the preview compare the same values and Apply writes
                    // every listed change with the value the preview started from.
                    let fresh: Config | null = null;
                    try {
                        fresh = configOf(await apiClient().getPluginConfiguration(A.PLUGIN_ID));
                    } catch (err) {
                        if (!ctx.isCurrent() || d.closed()) return;
                        console.warn('🪼 Jellyfin Enhanced: could not read the configuration before the import preview', err);
                    }
                    if (!ctx.isCurrent() || d.closed()) return;
                    if (!fresh) { d.status(A.fmt('Could not read the settings. Try again.'), 'error'); return; }
                    ctx.reload(fresh);
                    let answer: unknown;
                    try {
                        answer = await request('POST', 'admin/media-tags/preview', document);
                    } catch (err) {
                        if (!ctx.isCurrent() || d.closed()) return;
                        const { code } = await P.errorOf(err);
                        // The shared text says "for users"; this page also takes server exports and personal exports.
                        d.status(code === 'kind' ? A.fmt('This is not a Media Tags settings document. Paste an export from this page, or your own export from the Enhanced panel.') : P.errorText(code), 'error');
                        return;
                    }
                    if (!ctx.isCurrent() || d.closed()) return;
                    d.status(note || '');
                    const changes = changesOf(answer);
                    // The page's values of every field the document sets, as the preview compared them.
                    const imported = member(answer, 'imported');
                    const fields = new Set([...Object.keys(imported && typeof imported === 'object' ? imported : {}), ...changes.map((c) => c.field)]);
                    const snapshot = () => JSON.stringify(Array.from(fields, (f) => ctx.config[f] ?? null));
                    const compared = snapshot();
                    d.body.innerHTML = P.previewHtml(answer || {});
                    d.foot.innerHTML = P.buttonHtml('back', 'Back') + P.buttonHtml('cancel', 'Cancel')
                        + (changes.length ? P.buttonHtml('apply', A.fmt('Apply {count} {count|change|changes}', { count: changes.length }), { primary: true }) : '');
                    d.foot.onclick = async (ev) => {
                        const button = closest(ev, '[data-pt-action]');
                        const next = button?.dataset.ptAction;
                        if (next === 'back') { d.status(''); step(); d.focusFirst(); }
                        else if (next === 'cancel') d.close();
                        else if (next === 'apply' && button instanceof HTMLButtonElement) {
                            const ok = await ctx.confirm(A.fmt('Change {count} server {count|setting|settings} for everyone?', { count: changes.length }), A.fmt('Import server Media Tags settings'));
                            if (!ok || d.closed()) return;
                            button.disabled = true;
                            // Edited on this page since the preview: it no longer says what Apply changes.
                            const settled = await ctx.flush();
                            if (!ctx.isCurrent() || d.closed()) return;
                            if (!settled) { button.disabled = false; d.status(notSaved(), 'error'); return; }
                            if (snapshot() !== compared) { await preview(document, A.fmt('Settings on this page changed since the preview. This is the preview again: check it, then apply.')); return; }
                            await apply(d, changes);
                            if (!d.closed()) button.disabled = false;
                        }
                    };
                    (find(d.foot, '[data-pt-action="apply"]') || find(d.foot, '[data-pt-action="cancel"]'))?.focus();
                };
                const step = (): void => {
                    d.body.innerHTML = P.sourceHtml('Choose a server export, or your own export from the Enhanced panel to make your settings the defaults, or paste its text. Settings the server does not accept are listed and skipped.');
                    d.foot.innerHTML = P.buttonHtml('cancel', 'Cancel') + P.buttonHtml('next', 'Check', { primary: true });
                    P.wireSource(d);
                    d.foot.onclick = async (e) => {
                        const action = actionOf(e);
                        if (action === 'cancel') { d.close(); return; }
                        if (action !== 'next') return;
                        const parsed = P.parseDocument(findAs(d.body, '[data-pt-paste]', HTMLTextAreaElement)?.value);
                        if (parsed.error) { d.status(P.errorText(parsed.error), 'error'); return; }
                        if (parsed.document) await preview(parsed.document);
                    };
                    d.focusFirst();
                };
                step();
            }, { signal: ctx.signal });
        },
    });

    A.registerSection({
        id: 'server-presets',
        tab: 'server',
        order: 40,
        title: 'Presets for users',
        hint: 'Offer these presets in every user\'s Presets list, next to the built-in ones. Up to 20.',
        fields: [
            { id: 'tagOfferedPresets', key: 'TagOfferedPresets', type: 'custom', label: 'Presets for users' },
        ],
        render(ctx, body) {
            const P = tools();
            body.innerHTML = `<div class="je-ta-offered" data-offered aria-live="polite"></div>
                <div class="je-ta-actions">
                    <button type="button" class="je-ta-button" id="jeTaOfferMine"><span class="material-icons" aria-hidden="true">person</span>${ctx.tx('Offer my settings')}</button>
                    <button type="button" class="je-ta-button" id="jeTaOfferImport"><span class="material-icons" aria-hidden="true">file_open</span>${ctx.tx('Offer from a file')}</button>
                </div>`;
            if (!P) return;
            P.injectDialogCss();
            let dialog: PortableDialog | null = null;
            const show = (titleKey: string): PortableDialog => {
                dialog?.close();
                const opened = P.openDialog({ host: ctx.root, title: A.fmt(titleKey), onClose: () => { dialog = null; } });
                dialog = opened;
                return opened;
            };
            ctx.signal.addEventListener('abort', () => dialog?.close());

            /** Name a checked preset and offer it. */
            const nameStep = (d: PortableDialog, checked: { name: string; description: string; imported: JsonObject; skipped: JsonValue[] }): void => {
                d.body.innerHTML = `<p class="je-pt-hint">${ctx.tx('{count} {count|setting|settings}. Name the preset as users will see it.', { count: Object.keys(checked.imported).length })}</p>
                    <label class="je-pt-label" for="jeTaOfferName">${ctx.tx('Name')}</label>
                    <input id="jeTaOfferName" class="je-pt-input" type="text" maxlength="${MAX_NAME}" value="${ctx.esc(checked.name || '')}" data-pt-autofocus>
                    <label class="je-pt-label" for="jeTaOfferDesc">${ctx.tx('Description (optional)')}</label>
                    <textarea id="jeTaOfferDesc" class="je-pt-input" rows="2" maxlength="${MAX_DESCRIPTION}">${ctx.esc(checked.description || '')}</textarea>
                    ${checked.skipped.length ? P.previewHtml({ skipped: checked.skipped }, { summary: false }) : ''}`;
                d.foot.innerHTML = P.buttonHtml('cancel', 'Cancel') + P.buttonHtml('offer', 'Offer', { primary: true });
                // This dialog's preset, once offered: a retry after a failed or refused
                // save replaces it instead of adding another copy.
                let offeredId = '';
                d.foot.onclick = async (e) => {
                    const button = closest(e, '[data-pt-action]');
                    if (button?.dataset.ptAction === 'cancel') { d.close(); return; }
                    if (button?.dataset.ptAction !== 'offer' || !(button instanceof HTMLButtonElement)) return;
                    const nameInput = findAs(d.body, '#jeTaOfferName', HTMLInputElement);
                    const name = nameInput?.value.trim() || '';
                    const description = findAs(d.body, '#jeTaOfferDesc', HTMLTextAreaElement)?.value.trim() || '';
                    if (!name) { d.status(P.errorText('name'), 'error'); nameInput?.focus(); return; }
                    const presets = offered(ctx.config);
                    const again = offeredId ? presets.findIndex((p) => p.id === offeredId) : -1;
                    if (again < 0 && presets.length >= MAX_OFFERED) { d.status(A.fmt('{max} presets are offered already. Remove one first.', { max: MAX_OFFERED }), 'error'); return; }
                    if (again < 0 && !offeredId) offeredId = presetId(name, presets);
                    const preset: JsonObject = { v: 1, kind: 'je-media-tags-preset', id: offeredId, name, description, settings: checked.imported };
                    if (again < 0) presets.push(preset);
                    else presets[again] = preset;
                    button.disabled = true;
                    ctx.set('TagOfferedPresets', JSON.stringify(presets));
                    const saved = await ctx.flush();
                    if (!ctx.isCurrent() || d.closed()) return;
                    if (!saved) { button.disabled = false; d.status(A.fmt('Not saved. Try again.'), 'error'); return; }
                    d.close();
                    ctx.snack(A.fmt('{name} is offered to users.', { name }));
                };
                d.focusFirst();
            };

            /** Check a document as a preset (the user preview endpoint: the settings save path's validators); retry offers Retry when it fails. */
            const check = async (d: PortableDialog, document: unknown, retry = false): Promise<void> => {
                d.status(A.fmt('Checking…'));
                let preview: unknown;
                try {
                    preview = await request('POST', `user-settings/${currentUserId(apiClient())}/media-tags/preview`, document);
                } catch (err) {
                    if (!ctx.isCurrent() || d.closed()) return;
                    const { code } = await P.errorOf(err);
                    if (!ctx.isCurrent() || d.closed()) return;
                    failed(P, d, P.errorText(code), retry);
                    return;
                }
                if (!ctx.isCurrent() || d.closed()) return;
                d.status('');
                const importedRaw = copy(member(preview, 'imported') ?? null);
                const skippedRaw = copy(member(preview, 'skipped') ?? null);
                const skipped = Array.isArray(skippedRaw) ? skippedRaw : [];
                if (!isObject(importedRaw) || !Object.keys(importedRaw).length) {
                    d.body.innerHTML = P.previewHtml({ skipped }, { summary: false });
                    d.status(P.errorText('empty'), 'error');
                    return;
                }
                const textOf = (value: unknown): string => (value ? String(value) : '');
                nameStep(d, {
                    name: textOf(member(preview, 'name')) || textOf(member(document, 'name')),
                    description: textOf(member(preview, 'description')) || textOf(member(document, 'description')),
                    imported: importedRaw,
                    skipped,
                });
            };

            body.querySelector('#jeTaOfferMine')?.addEventListener('click', async () => {
                const d = show('Offer a preset');
                d.body.innerHTML = `<p class="je-pt-hint" data-pt-loading>${ctx.tx('Loading…')}</p>`;
                d.foot.innerHTML = P.buttonHtml('cancel', 'Cancel');
                const load = async (): Promise<void> => {
                    d.status(A.fmt('Checking…'));
                    try {
                        // The export reads the stored settings: a change of the administrator's
                        // own settings that failed to save would offer older ones instead.
                        try {
                            if (JE.currentSettings) await JE.saveUserSettings?.('settings.json', JE.currentSettings, { throwOnError: true, isCurrent: ctx.isCurrent });
                        } catch (err) {
                            if (!ctx.isCurrent() || d.closed()) return;
                            console.warn('🪼 Jellyfin Enhanced: your own Media Tags settings are not saved yet', err);
                            failed(P, d, A.fmt('Not offered: your latest change to your own Media Tags settings is not saved yet. Check the connection, then try again.'), true);
                            return;
                        }
                        if (!ctx.isCurrent() || d.closed()) return;
                        const mine = await request('GET', `user-settings/${currentUserId(apiClient())}/media-tags/export`);
                        if (!ctx.isCurrent() || d.closed()) return;
                        await check(d, mine, true);
                    } catch (err) {
                        if (!ctx.isCurrent() || d.closed()) return;
                        console.warn('🪼 Jellyfin Enhanced: could not read your Media Tags settings', err);
                        failed(P, d, A.fmt('Could not read the settings. Try again.'), true);
                    }
                };
                d.foot.onclick = (e) => {
                    const button = closest(e, '[data-pt-action]');
                    const action = button?.getAttribute('data-pt-action');
                    if (action === 'cancel') d.close();
                    else if (action === 'retry' && startRetry(button)) {
                        const line = find(d.body, '[data-pt-loading]');
                        if (line) line.hidden = false;
                        void load();
                    }
                };
                d.focusFirst();
                await load();
            }, { signal: ctx.signal });

            body.querySelector('#jeTaOfferImport')?.addEventListener('click', () => {
                const d = show('Offer a preset');
                d.body.innerHTML = P.sourceHtml('Choose a preset or settings file, or paste one a user shared.');
                d.foot.innerHTML = P.buttonHtml('cancel', 'Cancel') + P.buttonHtml('next', 'Check', { primary: true });
                P.wireSource(d);
                d.foot.onclick = (e) => {
                    const action = actionOf(e);
                    if (action === 'cancel') { d.close(); return; }
                    if (action !== 'next') return;
                    const parsed = P.parseDocument(findAs(d.body, '[data-pt-paste]', HTMLTextAreaElement)?.value);
                    if (parsed.error) { d.status(P.errorText(parsed.error), 'error'); return; }
                    void check(d, parsed.document);
                };
                d.focusFirst();
            }, { signal: ctx.signal });

            body.querySelector('[data-offered]')?.addEventListener('click', async (e) => {
                const button = closest(e, '[data-offer-action]');
                const item = button?.closest('[data-offer-id]');
                if (!button || !item) return;
                const presets = offered(ctx.config);
                const preset = presets.find((p) => p.id === item.getAttribute('data-offer-id'));
                if (!preset) return;
                const presetName = String(preset.name ?? '');
                if (button.dataset.offerAction === 'share') {
                    const copied = await P.copyText(JSON.stringify(preset, null, 2));
                    ctx.snack(A.fmt(copied ? '{name} copied. Paste it to share it.' : 'Could not copy. Select the text and copy it yourself.', { name: presetName }));
                    return;
                }
                const ok = await ctx.confirm(A.fmt('Stop offering {name}? Users who applied it keep their settings.', { name: presetName }), A.fmt('Remove'));
                if (!ok) return;
                const rest = presets.filter((p) => p !== preset);
                ctx.set('TagOfferedPresets', rest.length ? JSON.stringify(rest) : '');
                // The row is gone: focus the list's first action instead.
                find(body, '#jeTaOfferMine')?.focus();
                ctx.snack(A.fmt('{name} removed.', { name: presetName }), () => ctx.set('TagOfferedPresets', JSON.stringify(presets)));
            }, { signal: ctx.signal });
        },
        refresh(ctx, body) {
            const box = find(body, '[data-offered]');
            if (!box || !body) return;
            const presets = offered(ctx.config);
            const count = `<p class="je-ta-hint">${ctx.tx('{count} of {max} offered', { count: presets.length, max: MAX_OFFERED })}</p>`;
            // Redrawn by other views' saves and the library list answer too: keep focus on the same preset's button.
            A.redrawList(box, count + (presets.length ? `<ul class="je-ta-list je-ta-offered-list">${presets.map((p) => `<li data-offer-id="${ctx.esc(p.id)}">
                    <span class="je-ta-offered-text"><strong>${ctx.esc(p.name)}</strong>${p.description ? `<span class="je-ta-hint">${ctx.esc(p.description)}</span>` : ''}</span>
                    <span class="je-ta-offered-buttons">
                        <button type="button" class="je-ta-button" data-offer-action="share" aria-label="${ctx.tx('Share {name} (copies it)', { name: String(p.name) })}">${ctx.tx('Share')}</button>
                        <button type="button" class="je-ta-button" data-offer-action="remove" aria-label="${ctx.tx('Remove {name}', { name: String(p.name) })}">${ctx.tx('Remove')}</button>
                    </span></li>`).join('')}</ul>` : `<p class="je-ta-hint">${ctx.tx('No presets offered yet.')}</p>`), (el) => {
                const id = el.closest('[data-offer-id]')?.getAttribute('data-offer-id');
                const act = el.dataset.offerAction;
                return id && act ? `[data-offer-id="${id.replace(/["\\]/g, '\\$&')}"] [data-offer-action="${act}"]` : null;
            });
            const full = presets.length >= MAX_OFFERED;
            for (const id of ['#jeTaOfferMine', '#jeTaOfferImport']) {
                const button = findAs(body, id, HTMLButtonElement);
                if (button) button.disabled = full;
            }
        },
    });
});
