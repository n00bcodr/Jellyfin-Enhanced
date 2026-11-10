import { esc } from './render';

export interface DialogOptions { title?: string | undefined; message?: string | undefined; confirmLabel?: string; cancelLabel?: string; danger?: boolean }
export interface AlertInput { title?: string; message?: string; text?: string; callback?: () => void }

/** Messages may carry a few trusted formatting tags; everything else is escaped. */
export function safeHtml(text: string | null | undefined): string {
    return esc(text ?? '')
        .replace(/&lt;(\/?(?:br|b|strong|em|i|code|ul|li|p))\s*\/?&gt;/gi, '<$1>')
        .replace(/\r?\n/g, '<br>');
}

export function dialog({ title, message, confirmLabel, cancelLabel, danger }: DialogOptions): Promise<boolean> {
    return new Promise(resolve => {
        const previous = document.activeElement;
        const wrap = document.createElement('div');
        wrap.className = 'jea-dialog-backdrop';
        wrap.innerHTML = `<div class="jea-dialog" role="dialog" aria-modal="true" aria-label="${esc(title || 'Message')}">`
            + `<h3 class="jea-dialog-title">${esc(title || '')}</h3>`
            + `<div class="jea-dialog-body">${safeHtml(message)}</div>`
            + `<div class="jea-dialog-actions">${cancelLabel ? `<button type="button" class="jea-btn" data-r="0">${esc(cancelLabel)}</button>` : ''}`
            + `<button type="button" class="jea-btn ${danger ? 'jea-btn-danger' : 'jea-btn-primary'}" data-r="1">${esc(confirmLabel || 'OK')}</button></div></div>`;
        const done = (value: boolean): void => {
            document.removeEventListener('keydown', onKey, true);
            wrap.remove();
            if (previous instanceof HTMLElement) previous.focus();
            resolve(value);
        };
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') { event.stopPropagation(); done(false); }
        };
        wrap.addEventListener('click', event => {
            const target = event.target instanceof Element ? event.target : null;
            const button = target ? target.closest<HTMLElement>('[data-r]') : null;
            if (button) done(button.dataset.r === '1');
            else if (target === wrap && !cancelLabel) done(true);
        });
        document.addEventListener('keydown', onKey, true);
        (document.getElementById('JellyfinEnhancedPage') || document.body).appendChild(wrap);
        wrap.querySelector<HTMLElement>('[data-r="1"]')?.focus();
    });
}

export function alertBox(input: string | AlertInput | undefined): Promise<void> {
    const options: AlertInput = typeof input === 'string' ? { message: input } : (input ?? {});
    return dialog({ title: options.title, message: options.message || options.text }).then(() => {
        if (typeof options.callback === 'function') options.callback();
    });
}

export function confirmBox(message: string, title?: string, danger?: boolean): Promise<boolean> {
    return dialog({ title: title || 'Please confirm', message, confirmLabel: 'Confirm', cancelLabel: 'Cancel', danger: !!danger });
}
