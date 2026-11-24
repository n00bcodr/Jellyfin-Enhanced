/** Focuses a More Info modal's first enabled action, else its Close button. */
export function focusFirstAction(modal: HTMLElement): void {
    (modal.querySelector<HTMLElement>('.je-more-info-actions button:not([disabled])') ?? modal.querySelector<HTMLElement>('.modal-close'))?.focus();
}
