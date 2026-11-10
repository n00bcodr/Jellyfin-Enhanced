/**
 * Small typed DOM readers shared by the panel sections. They keep the legacy
 * semantics (a missing required control still throws) while narrowing
 * element types by runtime checks rather than casts.
 */

/** The element with this id, or a TypeError like the legacy `getElementById(id).x` access. */
export function requireId(id: string): HTMLElement {
    const element = document.getElementById(id);
    if (!element) throw new TypeError(`Missing panel control #${id}`);
    return element;
}

/** The input with this id, or null when absent or not an input. */
export function inputById(id: string): HTMLInputElement | null {
    const element = document.getElementById(id);
    return element instanceof HTMLInputElement ? element : null;
}

/** The select with this id, or null when absent or not a select. */
export function selectById(id: string): HTMLSelectElement | null {
    const element = document.getElementById(id);
    return element instanceof HTMLSelectElement ? element : null;
}

/** A required input (legacy code dereferenced it unconditionally). */
export function requireInput(id: string): HTMLInputElement {
    const element = requireId(id);
    if (!(element instanceof HTMLInputElement)) throw new TypeError(`Panel control #${id} is not an input`);
    return element;
}

/** The event target as an Element (text nodes and windows are not). */
export function targetElement(event: Event): Element | null {
    return event.target instanceof Element ? event.target : null;
}

/** The nearest ancestor-or-self of an event target matching a selector. */
export function closestTarget(event: Event, selector: string): HTMLElement | null {
    const found = targetElement(event)?.closest(selector);
    return found instanceof HTMLElement ? found : null;
}

/** First match of a selector as an HTMLElement. */
export function queryElement(root: ParentNode, selector: string): HTMLElement | null {
    const found = root.querySelector(selector);
    return found instanceof HTMLElement ? found : null;
}

/** First match of a selector as an input. */
export function queryInput(root: ParentNode, selector: string): HTMLInputElement | null {
    const found = root.querySelector(selector);
    return found instanceof HTMLInputElement ? found : null;
}

/** First match of a selector as a select. */
export function querySelect(root: ParentNode, selector: string): HTMLSelectElement | null {
    const found = root.querySelector(selector);
    return found instanceof HTMLSelectElement ? found : null;
}

/** First match of a selector as a button. */
export function queryButton(root: ParentNode, selector: string): HTMLButtonElement | null {
    const found = root.querySelector(selector);
    return found instanceof HTMLButtonElement ? found : null;
}

/** Every HTMLElement matching a selector. */
export function queryElements(root: ParentNode, selector: string): HTMLElement[] {
    return Array.from(root.querySelectorAll(selector)).filter((node): node is HTMLElement => node instanceof HTMLElement);
}

/** The value a form control carries (legacy `e.target.value`), undefined for other targets. */
export function controlValue(target: EventTarget | null): string | undefined {
    return target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement
        ? target.value : undefined;
}

/** Whether a checkable input is checked (legacy `e.target.checked`), undefined for other targets. */
export function controlChecked(target: EventTarget | null): boolean | undefined {
    return target instanceof HTMLInputElement ? target.checked : undefined;
}

/** Disable or enable a control when it is a form control that supports it. */
export function setDisabled(node: Element | null | undefined, disabled: boolean): void {
    if (node instanceof HTMLButtonElement || node instanceof HTMLInputElement || node instanceof HTMLSelectElement
        || node instanceof HTMLTextAreaElement || node instanceof HTMLFieldSetElement || node instanceof HTMLOptionElement) node.disabled = disabled;
}

/** Whether a node is a disabled form control. */
export function isDisabled(node: Element | null | undefined): boolean {
    return (node instanceof HTMLButtonElement || node instanceof HTMLInputElement || node instanceof HTMLSelectElement
        || node instanceof HTMLTextAreaElement || node instanceof HTMLFieldSetElement || node instanceof HTMLOptionElement) && node.disabled;
}

/** Focus an element when it can take focus. */
export function focusElement(node: Element | null | undefined, options?: FocusOptions): void {
    if (node instanceof HTMLElement || node instanceof SVGElement) node.focus(options);
}
