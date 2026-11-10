/** Checked views of the page's elements. A guard returns null (as*) or throws (need*) for anything else. */
export type FormControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement;

function missing(kind: string, element: Element | null): Error {
    return new TypeError(element ? `Expected ${kind}, found <${element.tagName.toLowerCase()}>` : `Expected ${kind}, found nothing`);
}

function guard<T extends Element>(test: (element: Element) => element is T, kind: string) {
    return {
        as: (element: Element | null): T | null => (element && test(element) ? element : null),
        need: (element: Element | null): T => {
            if (element && test(element)) return element;
            throw missing(kind, element);
        },
    };
}

const html = guard((e): e is HTMLElement => e instanceof HTMLElement, 'an HTML element');
const input = guard((e): e is HTMLInputElement => e instanceof HTMLInputElement, 'an input');
const select = guard((e): e is HTMLSelectElement => e instanceof HTMLSelectElement, 'a select');
const anchor = guard((e): e is HTMLAnchorElement => e instanceof HTMLAnchorElement, 'a link');
const image = guard((e): e is HTMLImageElement => e instanceof HTMLImageElement, 'an image');
const control = guard((e): e is FormControl => e instanceof HTMLInputElement || e instanceof HTMLSelectElement
    || e instanceof HTMLTextAreaElement || e instanceof HTMLButtonElement, 'a form control');

export const asHtml = html.as;
export const needHtml = html.need;
export const asInput = input.as;
export const needInput = input.need;
export const asSelect = select.as;
export const needSelect = select.need;
export const asAnchor = anchor.as;
export const needAnchor = anchor.need;
export const asImg = image.as;
export const needImg = image.need;
export const asControl = control.as;
export const needControl = control.need;

/** The element an event started on, when it is one. */
export function eventElement(event: Event): HTMLElement | null {
    return event.target instanceof HTMLElement ? event.target : null;
}

/** The nearest ancestor of an event's target matching a selector. */
export function closestTo(event: Event, selector: string): HTMLElement | null {
    return event.target instanceof Element ? asHtml(event.target.closest(selector)) : null;
}

/** An element's visible label: its text without the Material icon ligature names, which read as raw words. */
export function plainLabel(element: Element): string {
    const clone = element.cloneNode(true);
    if (!(clone instanceof Element)) return '';
    clone.querySelectorAll('i.material-icons, img').forEach(icon => icon.remove());
    return (clone.textContent ?? '').trim();
}

/** Every form control under a root, in document order. */
export function formControls(root: ParentNode): Array<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement> {
    return Array.from(root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea'));
}

/** Whether a control holds a checked state rather than a value. */
export function isCheckable(control: Element): control is HTMLInputElement {
    return control instanceof HTMLInputElement && (control.type === 'checkbox' || control.type === 'radio');
}

/** The JSON object a CustomEvent carries, empty for anything else. */
export function eventDetail(event: Event): { [key: string]: unknown } {
    if (!(event instanceof CustomEvent)) return {};
    const detail: unknown = event.detail;
    return typeof detail === 'object' && detail !== null ? { ...detail } : {};
}
