import type { SeerrCoreHost } from '../host-core';
import type { ModalInstance, ModalOptions, SeerrModalFacade } from './contract';
import { decodeAdvancedData, isRecord, isSafeTmdbImagePath } from './decode';
import type { RootFolder } from './types';
import { escapeWith, firstInstall } from './runtime';

const LOG = '🪼 Jellyfin Enhanced: Jellyseerr Modal:';
const FOCUSABLE_TRAP = 'button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
const FOCUSABLE_FIRST = 'button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex="0"]';
const TV_BACK_KEYS = ['Escape', 'BrowserBack', 'GoBack'];

export function formatBytes(bytes: number): string {
    if (!bytes || bytes <= 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i] ?? 'Bytes'}`;
}
/** A Root Folder option: "{path} ({free space})" when Seerr reports the free space. */
export function formatFolderLabel(folder: RootFolder): string {
    return typeof folder.freeSpace === 'number' ? `${folder.path} (${formatBytes(folder.freeSpace)})` : folder.path;
}

/** The request modal shell shared by every Seerr request and issue dialog. */
export function installModal(host: SeerrCoreHost): void {
    const { JE, document, window } = host;
    if (!firstInstall(JE, 'modal')) return;
    const escapeHtml = escapeWith(JE);
    const historyKey = 'jeSeerrModal';
    let nextModal = 0;
    const retiredEntries = new Map<string, string>();
    const historyToken = (): string | null => {
        const state: unknown = window.history.state;
        return isRecord(state) && typeof state[historyKey] === 'string' ? state[historyKey] : null;
    };
    // A parent may be disposed while a nested dialog owns the current entry.
    // Returning to that retired entry should finish returning to the host page.
    window.addEventListener('popstate', () => {
        const token = historyToken();
        if (token && retiredEntries.get(token) === window.location.href) {
            retiredEntries.delete(token);
            window.history.back();
        }
    });

    /**
     * Jellyfin's own select list on a TV closes through history.back(), which
     * would close this dialog too. On the TV layout a select opens an
     * in-dialog list instead, and Back closes that list only.
     */
    function enableTvSelectPicker(modalElement: HTMLElement, bodyEl: HTMLElement): () => void {
        let picker: HTMLElement | null = null;
        let owner: HTMLSelectElement | null = null;
        const closePicker = (restoreFocus = true) => {
            if (!picker) return;
            document.removeEventListener('keydown', onPickerKey, true);
            picker.remove();
            picker = null;
            if (restoreFocus) owner?.focus();
            owner = null;
        };
        function onPickerKey(event: KeyboardEvent): void {
            if (!TV_BACK_KEYS.includes(event.key) && event.keyCode !== 10009 && event.keyCode !== 461) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            closePicker();
        }
        const openPicker = (select: HTMLSelectElement) => {
            closePicker();
            owner = select;
            const list = document.createElement('div');
            list.className = 'jellyseerr-tv-picker';
            list.setAttribute('role', 'listbox');
            for (const option of Array.from(select.options)) {
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'jellyseerr-tv-picker-option focusable';
                item.setAttribute('role', 'option');
                item.setAttribute('aria-selected', String(option.value === select.value));
                item.textContent = option.textContent;
                item.addEventListener('click', () => {
                    select.value = option.value;
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                    closePicker();
                });
                list.appendChild(item);
            }
            picker = list;
            select.insertAdjacentElement('afterend', list);
            document.addEventListener('keydown', onPickerKey, true);
            const selected = list.querySelector('[aria-selected="true"]') || list.firstElementChild;
            if (selected instanceof HTMLElement) selected.focus();
        };
        const intercept = (event: Event) => {
            const select = event.target instanceof Element ? event.target.closest('select') : null;
            if (!select || !bodyEl.contains(select)) return;
            if (event.type === 'keydown' && (!(event instanceof KeyboardEvent) || event.key !== 'Enter')) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (event.type !== 'mousedown') openPicker(select);
        };
        for (const type of ['mousedown', 'click', 'keydown']) modalElement.addEventListener(type, intercept, true);
        return () => {
            document.removeEventListener('keydown', onPickerKey, true);
            for (const type of ['mousedown', 'click', 'keydown']) modalElement.removeEventListener(type, intercept, true);
            closePicker(false);
        };
    }

    function create(options: ModalOptions): ModalInstance {
        const { title, subtitle, bodyHtml, backdropPath, backdropUrl, onSave, onClose, buttonText } = options;
        const modalElement = document.createElement('div');
        modalElement.className = 'jellyseerr-season-modal';
        modalElement.setAttribute('role', 'dialog');
        modalElement.setAttribute('aria-modal', 'true');
        modalElement.setAttribute('tabindex', '-1');
        let backdropImage: string;
        if (backdropUrl) backdropImage = `url('${escapeHtml(backdropUrl)}')`;
        else if (backdropPath && isSafeTmdbImagePath(backdropPath)) backdropImage = `url('https://image.tmdb.org/t/p/w1280${escapeHtml(backdropPath)}')`;
        else backdropImage = 'linear-gradient(45deg, #3b82f6, #8b5cf6)';

        const contentEl = document.createElement('div');
        contentEl.className = 'jellyseerr-season-content';
        contentEl.setAttribute('role', 'document');
        contentEl.setAttribute('aria-labelledby', 'jellyseerr-modal-title');
        const headerEl = document.createElement('div');
        headerEl.className = 'jellyseerr-season-header';
        headerEl.style.cssText = `background-image: ${backdropImage}; background-size: cover; background-position: center;`;
        const titleEl = document.createElement('div');
        titleEl.id = 'jellyseerr-modal-title';
        titleEl.className = 'jellyseerr-season-title';
        titleEl.textContent = title;
        const subtitleEl = document.createElement('div');
        subtitleEl.className = 'jellyseerr-season-subtitle';
        subtitleEl.textContent = subtitle;
        headerEl.append(titleEl, subtitleEl);
        const bodyEl = document.createElement('div');
        bodyEl.className = 'jellyseerr-modal-body';
        bodyEl.style.cssText = 'padding: 24px; max-height: calc(80vh - 200px); overflow-y: auto;';
        // Body markup is built by this group's callers, which escape every value they interpolate.
        bodyEl.innerHTML = bodyHtml;
        const footerEl = document.createElement('div');
        footerEl.className = 'jellyseerr-modal-footer';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'jellyseerr-modal-button jellyseerr-modal-button-secondary';
        cancelBtn.setAttribute('aria-label', JE.t('jellyseerr_modal_cancel'));
        cancelBtn.textContent = JE.t('jellyseerr_modal_cancel');
        const primaryBtn = document.createElement('button');
        primaryBtn.className = 'jellyseerr-modal-button jellyseerr-modal-button-primary';
        const primaryLabel = buttonText || JE.t('jellyseerr_modal_request');
        primaryBtn.setAttribute('aria-label', primaryLabel);
        primaryBtn.textContent = primaryLabel;
        footerEl.append(cancelBtn, primaryBtn);
        contentEl.append(headerEl, bodyEl, footerEl);
        modalElement.appendChild(contentEl);

        const handleKeydown = (event: KeyboardEvent) => {
            if (!ownsHistory()) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                close();
                return;
            }
            if (event.key !== 'Tab') return;
            const focusable = Array.from(modalElement.querySelectorAll<HTMLElement>(FOCUSABLE_TRAP));
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (!first || !last) return;
            if (event.shiftKey) {
                if (document.activeElement === first || document.activeElement === modalElement) {
                    event.preventDefault();
                    last.focus();
                }
            } else if (document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };
        const disposePicker = JE.core?.ui?.isTvLayout?.() ? enableTvSelectPicker(modalElement, bodyEl) : () => {};

        let isClosing = false;
        let shown = false;
        const token = String(Date.now()) + ':' + String(++nextModal);
        let openedUrl = '';
        const ownsHistory = () => shown && historyToken() === token && window.location.href === openedUrl;
        const dismiss = (restoreHistory: boolean) => {
            if (isClosing) return;
            isClosing = true;
            disposePicker();
            if (typeof onClose === 'function') {
                try { onClose(); } catch (error) { console.error(LOG + ' onClose handler failed:', error); }
            }
            window.removeEventListener('popstate', onHistoryChange);
            document.removeEventListener('keydown', handleKeydown);
            modalElement.classList.remove('show');
            modalElement.setAttribute('aria-hidden', 'true');
            if (!document.querySelector('.jellyseerr-season-modal:not([aria-hidden="true"])')) {
                document.body.classList.remove('jellyseerr-modal-is-open');
            }
            window.setTimeout(() => modalElement.remove(), 300);
            // onClose can synchronously navigate or show a replacement modal.
            // Decide only after those callbacks, against the current owned entry.
            if (restoreHistory && shown) {
                if (ownsHistory()) window.history.back();
                else retiredEntries.set(token, openedUrl);
            }
        };
        const close = () => dismiss(true);
        const onHistoryChange = (event: PopStateEvent) => {
            // Closing a child returns to this still-open parent. Read the event
            // snapshot too: another listener can change history during dispatch.
            const state: unknown = event.state;
            if (!isRecord(state) || state[historyKey] !== token || !ownsHistory()) dismiss(false);
        };
        const show = () => {
            if (shown || isClosing) return;
            shown = true;
            openedUrl = window.location.href;
            // A dialog still in its exit animation goes now, so this one owns its ids and labels.
            for (const closing of Array.from(document.querySelectorAll('.jellyseerr-season-modal[aria-hidden="true"]'))) closing.remove();
            document.body.appendChild(modalElement);
            document.body.classList.add('jellyseerr-modal-is-open');
            const previous: unknown = window.history.state;
            window.history.pushState({ ...(isRecord(previous) ? previous : {}), [historyKey]: token }, '', openedUrl);
            window.addEventListener('popstate', onHistoryChange);
            document.addEventListener('keydown', handleKeydown);
            window.setTimeout(() => {
                if (isClosing || !modalElement.isConnected) return;
                modalElement.classList.add('show');
                const first = modalElement.querySelector(FOCUSABLE_FIRST);
                if (first instanceof HTMLElement) first.focus();
                else modalElement.focus();
            }, 10);
        };
        cancelBtn.addEventListener('click', close);
        modalElement.addEventListener('click', event => { if (event.target === modalElement) close(); });
        primaryBtn.addEventListener('click', () => { void onSave(modalElement, primaryBtn, close); });
        return { modalElement, show, close };
    }

    function createAdvancedOptionsHTML(idPrefix: string): string {
        const id = escapeHtml(idPrefix);
        return `
            <div class="jellyseerr-advanced-options">
                <h3>${JE.t('jellyseerr_advanced_options')}</h3>
                <div class="jellyseerr-form-row">
                    <div class="jellyseerr-form-group">
                        <label for="${id}-server">${JE.t('jellyseerr_server_select')}</label>
                        <select is="emby-select" id="${id}-server" class="emby-select"></select>
                    </div>
                    <div class="jellyseerr-form-group">
                        <label for="${id}-quality">${JE.t('jellyseerr_quality_select')}</label>
                        <select is="emby-select" id="${id}-quality" class="emby-select"></select>
                    </div>
                </div>
                <div class="jellyseerr-form-row">
                    <div class="jellyseerr-form-group">
                        <label for="${id}-folder">${JE.t('jellyseerr_folder_select')}</label>
                        <select is="emby-select" id="${id}-folder" class="emby-select"></select>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Fills the server / quality / folder selects. With `is4k` given, only a
     * default server of that mode is preselected (Seerr flags one regular and
     * one 4K default).
     */
    function populateAdvancedOptions(modalElement: HTMLElement, value: unknown, idPrefix: string, is4k?: boolean): void {
        const data = decodeAdvancedData(value);
        // The prefix becomes part of element ids (createAdvancedOptionsHTML): only a plain token.
        if (!/^[A-Za-z0-9_-]+$/.test(idPrefix)) return;
        let attempts = 0;
        const maxAttempts = 50; // emby-select upgrades asynchronously; give it 5 s
        const interval = window.setInterval(() => {
            const find = (suffix: string) => {
                const element = modalElement.querySelector(`#${idPrefix}-${suffix}`);
                return element instanceof HTMLSelectElement ? element : null;
            };
            const serverSelect = find('server');
            const qualitySelect = find('quality');
            const folderSelect = find('folder');
            if (!serverSelect || !qualitySelect || !folderSelect) {
                attempts++;
                if (attempts > maxAttempts) {
                    window.clearInterval(interval);
                    console.error(`${LOG} Could not find advanced options elements in modal after ${maxAttempts} attempts.`);
                }
                return;
            }
            window.clearInterval(interval);
            serverSelect.innerHTML = '<option value="">Select Server...</option>';
            qualitySelect.innerHTML = '<option value="">Select Quality...</option>';
            folderSelect.innerHTML = '<option value="">Select Folder...</option>';
            // Seerr's own order (e.g. 4K first) is not meaningful: list by name.
            const sorted = [...data.servers].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            for (const server of sorted) {
                const option = document.createElement('option');
                option.value = String(server.id);
                option.textContent = server.name || `Server ${server.id}`;
                if (server.isDefault && (is4k === undefined || !!server.is4k === !!is4k)) option.selected = true;
                serverSelect.appendChild(option);
            }
            const updateServerDependentOptions = () => {
                const selected = data.servers.find(server => String(server.id) === serverSelect.value);
                qualitySelect.innerHTML = '<option value="">Select Quality...</option>';
                folderSelect.innerHTML = '<option value="">Select Folder...</option>';
                if (!selected) return;
                for (const profile of selected.qualityProfiles) {
                    const option = document.createElement('option');
                    option.value = String(profile.id);
                    option.textContent = profile.name || `Profile ${profile.id}`;
                    if (profile.id === selected.activeProfileId) option.selected = true;
                    qualitySelect.appendChild(option);
                }
                for (const folder of selected.rootFolders) {
                    const option = document.createElement('option');
                    option.value = folder.path;
                    option.textContent = formatFolderLabel(folder);
                    if (folder.path === selected.activeDirectory) option.selected = true;
                    folderSelect.appendChild(option);
                }
            };
            serverSelect.addEventListener('change', updateServerDependentOptions);
            if (serverSelect.value) updateServerDependentOptions();
        }, 100);
    }

    const modal: SeerrModalFacade = { create, createAdvancedOptionsHTML, populateAdvancedOptions };
    JE.jellyseerrModal = modal;
}
