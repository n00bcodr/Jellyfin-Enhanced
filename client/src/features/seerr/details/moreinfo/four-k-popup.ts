import type { ActionContext } from '../../host-details';

/** The chevron of a split request button. */
export const SPLIT_ARROW_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M12.53 16.28a.75.75 0 01-1.06 0l-7.5-7.5a.75.75 0 011.06-1.06L12 14.69l6.97-6.97a.75.75 0 111.06 1.06l-7.5 7.5z" clip-rule="evenodd" /></svg>';

export function silent(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
}

/**
 * The 4K menu of a split button. It lives on the body, outside the modal, so the
 * render that owns the button closes it: a menu left behind would request the old
 * title under whoever is signed in by then.
 */
export function attachFourKPopup(arrow: HTMLButtonElement, context: ActionContext,
    fill: (option: HTMLButtonElement, close: () => void) => void): void {
    let menu: HTMLElement | null = null;
    const close = () => {
        if (!menu) return;
        menu.remove();
        menu = null;
        document.removeEventListener('click', onDocumentClick, true);
    };
    const onDocumentClick = (event: Event) => {
        if (!menu || !(event.target instanceof Node)) return;
        if (!menu.contains(event.target) && !arrow.contains(event.target)) close();
    };
    context.onDispose(close);
    arrow.addEventListener('click', event => {
        silent(event);
        if (!context.current()) return;
        if (menu) {
            close();
            return;
        }
        const opened = document.createElement('div');
        opened.className = 'je-4k-popup';
        const option = document.createElement('button');
        option.className = 'je-4k-popup-item';
        fill(option, close);
        opened.appendChild(option);
        document.body.appendChild(opened);
        const rect = arrow.getBoundingClientRect();
        opened.style.position = 'fixed';
        opened.style.left = `${rect.left}px`;
        opened.style.top = `${rect.bottom + 6}px`;
        requestAnimationFrame(() => {
            if (menu === opened) opened.classList.add('show');
        });
        menu = opened;
        document.addEventListener('click', onDocumentClick, true);
    });
}

/** The split button shell shared by movie and TV requests. */
export function splitButton(label: string, icon: string, tmdbId: string, mediaType: 'movie' | 'tv', arrowTitle: string, marked = true): { group: HTMLElement; main: HTMLButtonElement; arrow: HTMLButtonElement } {
    const group = document.createElement('div');
    group.className = 'jellyseerr-button-group je-more-info-button-group';
    const main = document.createElement('button');
    main.className = 'jellyseerr-request-button jellyseerr-split-main jellyseerr-button-request';
    main.innerHTML = `${icon}<span>${label}</span>`;
    main.dataset.tmdbId = tmdbId;
    main.dataset.mediaType = mediaType;
    const arrow = document.createElement('button');
    arrow.className = 'jellyseerr-split-arrow';
    arrow.innerHTML = SPLIT_ARROW_SVG;
    arrow.title = arrowTitle;
    if (marked) {
        arrow.dataset.tmdbId = tmdbId;
        arrow.dataset.toggle4k = 'true';
    }
    group.appendChild(main);
    group.appendChild(arrow);
    return { group, main, arrow };
}
