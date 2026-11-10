/**
 * @file Small DOM helpers for markup the admin tab wrote itself: a missing
 * node there is a defect, so lookups narrow by element type instead of casting.
 */

type Control = HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/**
 * Whether an element is a control whose `disabled` property is set (other
 * elements have none, as the legacy `el.disabled` checks read them).
 * @param el
 * @returns {boolean}
 */
export function isDisabled(el: Element | null | undefined): boolean {
    return el instanceof HTMLButtonElement || el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement
        ? el.disabled : false;
}

/**
 * Set a control's `disabled` property (no-op for other elements).
 * @param el
 * @param disabled
 */
export function setDisabled(el: Element | null | undefined, disabled: boolean): void {
    if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) el.disabled = disabled;
}

/**
 * The first HTML element matching a selector, or null.
 * @param scope
 * @param selector
 * @returns {HTMLElement|null}
 */
export function find(scope: ParentNode | null | undefined, selector: string): HTMLElement | null {
    const el = scope?.querySelector(selector);
    return el instanceof HTMLElement ? el : null;
}

/**
 * The first element of a type matching a selector, or null.
 * @param scope
 * @param selector
 * @param type - The element constructor.
 * @returns {T|null}
 */
export function findAs<T extends Element>(scope: ParentNode | null | undefined, selector: string, type: abstract new () => T): T | null {
    const el = scope?.querySelector(selector);
    return el instanceof type ? el : null;
}

/**
 * The matching HTML element, which markup this module drew must hold.
 * @param scope
 * @param selector
 * @returns {HTMLElement}
 */
export function must(scope: ParentNode | null | undefined, selector: string): HTMLElement {
    const el = find(scope, selector);
    if (!el) throw new Error(`Media Tags admin markup is incomplete: ${selector}`);
    return el;
}

/**
 * The matching element of a type, which markup this module drew must hold.
 * @param scope
 * @param selector
 * @param type
 * @returns {T}
 */
export function mustAs<T extends Element>(scope: ParentNode | null | undefined, selector: string, type: abstract new () => T): T {
    const el = findAs(scope, selector, type);
    if (!el) throw new Error(`Media Tags admin markup is incomplete: ${selector}`);
    return el;
}

/**
 * Every HTML element matching a selector.
 * @param scope
 * @param selector
 * @returns {HTMLElement[]}
 */
export function all(scope: ParentNode | null | undefined, selector: string): HTMLElement[] {
    return scope ? Array.from(scope.querySelectorAll(selector)).filter((el): el is HTMLElement => el instanceof HTMLElement) : [];
}

/**
 * Every element of a type matching a selector.
 * @param scope
 * @param selector
 * @param type
 * @returns {T[]}
 */
export function allAs<T extends Element>(scope: ParentNode | null | undefined, selector: string, type: abstract new () => T): T[] {
    return scope ? Array.from(scope.querySelectorAll(selector)).filter((el): el is T => el instanceof type) : [];
}

/**
 * The event target's closest HTML element matching a selector.
 * @param event
 * @param selector
 * @returns {HTMLElement|null}
 */
export function closest(event: Event, selector: string): HTMLElement | null {
    const target = event.target;
    const el = target instanceof Element ? target.closest(selector) : null;
    return el instanceof HTMLElement ? el : null;
}

/**
 * The event target as an HTML element.
 * @param event
 * @returns {HTMLElement|null}
 */
export function targetOf(event: Event): HTMLElement | null {
    return event.target instanceof HTMLElement ? event.target : null;
}

/**
 * The focused HTML element, or null.
 * @returns {HTMLElement|null}
 */
export function activeElement(): HTMLElement | null {
    const el = document.activeElement;
    return el instanceof HTMLElement ? el : null;
}

/**
 * Focus an element when it is an HTML element.
 * @param el
 * @param options
 */
export function focus(el: Element | null | undefined, options?: FocusOptions): void {
    if (el instanceof HTMLElement) el.focus(options);
}

/** A form control the page reads a value from. */
export type ValueControl = Control;
/**
 * Whether an element is a form control with a value.
 * @param el
 * @returns {boolean}
 */
export function isValueControl(el: Element | null | undefined): el is ValueControl {
    return el instanceof HTMLButtonElement || el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement;
}
