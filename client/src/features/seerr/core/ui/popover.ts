import { bindViewOrigin, isViewCurrent } from '../runtime';
import type { SeerrCoreHost } from '../../host-core';
import type { InlineProgressInput, SeerrUiFacade } from '../contract';
import { capitalize, formatEtaText, progressPercent } from '../display';
import { DISPLAY, resolveDisplayStatus } from '../status';
import type { SeerrMediaItem } from '../types';
import { LOG_UI, escapeWith, firstInstall, groupInternals } from '../runtime';
import { ICONS } from './icon-markup';

/** Download-progress hover popover and the 4K request popup. */
export function installPopover(host: SeerrCoreHost): void {
    const { JE, document, window } = host;
    if (!firstInstall(JE, 'ui-popover')) return;
    const ui: Partial<SeerrUiFacade> = JE.jellyseerrUI ||= {};
    const internals = groupInternals(JE);
    const state = internals.state;
    const escapeHtml = escapeWith(JE);
    const icons = () => internals.icons ?? ICONS;

    function ensureHoverPopover(): HTMLElement {
        if (!state.jellyseerrHoverPopover) {
            const popover = document.createElement('div');
            popover.className = 'jellyseerr-hover-popover';
            document.body.appendChild(popover);
            state.jellyseerrHoverPopover = popover;
        }
        return state.jellyseerrHoverPopover;
    }
    const etaText = (downloadStatus: unknown): string | null => {
        try { return formatEtaText(downloadStatus, Date.now()); } catch { return null; }
    };

    /** Fills the popover with the item's download progress; null when it has none to show. */
    function fillHoverPopover(item: SeerrMediaItem): HTMLElement | null {
        const downloads = [...(item.mediaInfo?.downloadStatus || []), ...(item.mediaInfo?.downloadStatus4k || [])];
        if (downloads.length === 0) {
            console.debug(`${LOG_UI} No download status found`);
            return null;
        }
        const popover = ensureHoverPopover();
        let html = '';
        // Download fields come from Seerr and are escaped before interpolation.
        for (const download of downloads) {
            const percent = progressPercent(download.size, download.sizeLeft);
            const status = (download.status || '').toLowerCase();
            const isQueued = status === 'queued';
            const isWarning = status === 'warning';
            if (percent === null && !isQueued && !isWarning) continue;
            const title = escapeHtml(download.title ?? '') || JE.t('jellyseerr_popover_downloading');
            // A null size counts as no size (shown queued), as before.
            if (isQueued || download.size === null || (typeof download.size === 'number' && download.size <= 0)) {
                html += `
                    <div class="jellyseerr-popover-item">
                        <div class="title">${title}</div>
                        <div class="jellyseerr-hover-progress"><div class="bar" style="width:0%;"></div></div>
                        <div class="row">
                            <div>0%</div>
                            <div class="status">Queued</div>
                        </div>
                    </div>`;
            } else {
                // A warning without size data shows no progress rather than "NaN%".
                const shown = percent ?? 0;
                const statusDisplay = isWarning ? 'Warning' : capitalize(download.status || 'Downloading');
                const eta = etaText(download);
                html += `
                    <div class="jellyseerr-popover-item">
                        <div class="title">${title}</div>
                        <div class="jellyseerr-hover-progress"><div class="bar" style="width:${shown}%;"></div></div>
                        <div class="row">
                            <div>${shown}%</div>
                            <div class="status">${escapeHtml(statusDisplay)}</div>
                            ${eta ? `<div class="eta">${escapeHtml(eta)}</div>` : ''}
                        </div>
                    </div>`;
            }
        }
        popover.innerHTML = html;
        console.debug(`${LOG_UI} Popover filled for ${downloads.length} download item(s)`);
        return popover;
    }

    function positionHoverPopover(element: HTMLElement, x: number, y: number): void {
        const padding = 12;
        const rect = element.getBoundingClientRect();
        const newX = Math.min(Math.max(x + 14, padding), window.innerWidth - rect.width - padding);
        const newY = Math.min(Math.max(y - rect.height - 14, padding), window.innerHeight - rect.height - padding);
        element.style.transform = `translate(${newX}px, ${newY}px)`;
    }
    function showAt(popover: HTMLElement, item: SeerrMediaItem, x: number, y: number): void {
        positionHoverPopover(popover, x, y);
        popover.classList.add('show');
        popover.dataset.tmdbId = String(item.id);
        popover.dataset.clientX = String(x);
        popover.dataset.clientY = String(y);
    }

    /** Hides the popover unless a tap locked it open. */
    function hideHoverPopover(): void {
        const popover = state.jellyseerrHoverPopover;
        if (popover && !state.jellyseerrHoverLock) {
            popover.classList.remove('show');
            delete popover.dataset.tmdbId;
            delete popover.dataset.clientX;
            delete popover.dataset.clientY;
        }
    }
    function toggleHoverPopoverLock(lockState?: boolean): void {
        state.jellyseerrHoverLock = typeof lockState === 'boolean' ? lockState : !state.jellyseerrHoverLock;
    }

    function createInlineProgress(downloadStatus: InlineProgressInput | null | undefined): HTMLElement | null {
        const percent = progressPercent(downloadStatus?.size, downloadStatus?.sizeLeft);
        if (!downloadStatus || percent === null) return null;
        const container = document.createElement('div');
        container.className = 'jellyseerr-inline-progress';
        container.innerHTML = `
            <div class="jellyseerr-inline-progress-bar"><div class="jellyseerr-inline-progress-fill" style="width: ${percent}%"></div></div>
            <div class="jellyseerr-inline-progress-text">${percent}% • ${escapeHtml(capitalize(downloadStatus.status || 'downloading'))}</div>`;
        return container;
    }

    function hide4KPopup(): void {
        if (state.active4KPopup) {
            state.active4KPopup.remove();
            state.active4KPopup = null;
        }
    }
    /** The 4K request menu under a split button. */
    function show4KPopup(buttonGroup: HTMLElement, item: SeerrMediaItem): void {
        if (!isViewCurrent(host, buttonGroup)) return;
        hide4KPopup();
        const popup = document.createElement('div');
        bindViewOrigin(host, popup);
        popup.className = 'jellyseerr-4k-popup';
        const button = document.createElement('button');
        button.className = 'jellyseerr-4k-popup-item';
        const display4k = resolveDisplayStatus(item.mediaInfo ? item.mediaInfo.status4k : 1, false);
        if (display4k === DISPLAY.AVAILABLE) {
            button.innerHTML = `<span>4K Available</span>${icons().available}`;
            button.disabled = true;
            button.classList.add('jellyseerr-4k-available', 'chip-available');
        } else if (display4k === DISPLAY.PENDING || display4k === DISPLAY.REQUESTED || display4k === DISPLAY.PROCESSING) {
            button.innerHTML = `<span>4K Requested</span>${icons().pending}`;
            button.disabled = true;
            button.classList.add(display4k === DISPLAY.PROCESSING ? 'chip-processing' : 'chip-pending');
        } else if (display4k === DISPLAY.BLOCKED) {
            button.innerHTML = `<span>${JE.t('jellyseerr_btn_blocklisted')}</span>${icons().cancel}`;
            button.disabled = true;
            button.classList.add('chip-blocklisted');
        } else {
            button.innerHTML = `<span>${JE.t('jellyseerr_btn_request_4k')}</span>`;
            button.dataset.tmdbId = String(item.id);
            button.dataset.mediaType = item.mediaType || 'movie';
            button.dataset.action = 'request4k';
            button.classList.add('chip-requested');
        }
        popup.appendChild(button);
        document.body.appendChild(popup);
        state.active4KPopup = popup;
        const rect = buttonGroup.getBoundingClientRect();
        popup.style.position = 'fixed';
        popup.style.left = `${rect.left}px`;
        popup.style.top = `${rect.bottom + 4}px`;
        popup.style.width = `${rect.width}px`;
        window.setTimeout(() => popup.classList.add('show'), 10);
    }

    // One set of hover listeners per element, reading the element's current
    // item: reconfiguring a button replaces what it shows instead of stacking
    // another set of listeners with the old item.
    const hoverItems = new WeakMap<HTMLElement, SeerrMediaItem>();
    const hoverBound = new WeakSet<HTMLElement>();
    function addDownloadProgressHover(button: HTMLElement, item: SeerrMediaItem): void {
        hoverItems.set(button, item);
        if (hoverBound.has(button)) return;
        hoverBound.add(button);
        const show = (event: MouseEvent | FocusEvent) => {
            const current = hoverItems.get(button);
            const popover = current ? fillHoverPopover(current) : null;
            if (!current || !popover) return;
            const target = event.target instanceof Element ? event.target : button;
            const clientX = (event instanceof MouseEvent && event.clientX) || target.getBoundingClientRect().right;
            const clientY = (event instanceof MouseEvent && event.clientY) || target.getBoundingClientRect().top - 8;
            showAt(popover, current, clientX, clientY);
        };
        button.addEventListener('mouseenter', show);
        button.addEventListener('mousemove', event => {
            const popover = state.jellyseerrHoverPopover;
            if (popover?.classList.contains('show') && !state.jellyseerrHoverLock) {
                popover.dataset.clientX = String(event.clientX);
                popover.dataset.clientY = String(event.clientY);
                positionHoverPopover(popover, event.clientX, event.clientY);
            }
        });
        button.addEventListener('mouseleave', () => ui.hideHoverPopover?.());
        button.addEventListener('focus', show);
        button.addEventListener('blur', () => {
            ui.toggleHoverPopoverLock?.(false);
            ui.hideHoverPopover?.();
        });
        // A tap (not a swipe) toggles the popover; swipes keep scrolling the row.
        JE.core?.ui?.addTouchTapListener?.(button, event => {
            event.preventDefault();
            const current = hoverItems.get(button);
            const popover = current ? fillHoverPopover(current) : null;
            if (!current || !popover) return;
            const rect = button.getBoundingClientRect();
            ui.toggleHoverPopoverLock?.();
            if (state.jellyseerrHoverLock) showAt(popover, current, rect.left + rect.width / 2, rect.top - 8);
            else popover.classList.remove('show');
        });
    }
    /** The element no longer has downloads to show (it was reconfigured). */
    function clearDownloadProgressHover(button: HTMLElement): void {
        hoverItems.delete(button);
    }

    ui.hideHoverPopover = hideHoverPopover;
    ui.toggleHoverPopoverLock = toggleHoverPopoverLock;
    ui.formatEtaText = etaText;
    internals.ensureHoverPopover = ensureHoverPopover;
    internals.formatEtaText = etaText;
    internals.fillHoverPopover = fillHoverPopover;
    internals.positionHoverPopover = positionHoverPopover;
    internals.createInlineProgress = createInlineProgress;
    internals.hide4KPopup = hide4KPopup;
    internals.show4KPopup = show4KPopup;
    internals.addDownloadProgressHover = addDownloadProgressHover;
    internals.clearDownloadProgressHover = clearDownloadProgressHover;
}
