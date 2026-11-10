import type { MountLifecycle } from './lifecycle';
import { MIRROR } from './schema';

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
const isFormField = (element: Element): element is Field =>
    element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement;

const copies = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('[id$="' + MIRROR + '"]'));
const sourceOf = (mirror: Element): HTMLElement | null => document.getElementById(mirror.id.slice(0, -MIRROR.length));

function copyValue(source: Field, mirror: Field): void {
    if (mirror instanceof HTMLInputElement && mirror.type === 'checkbox') {
        if (source instanceof HTMLInputElement) mirror.checked = source.checked;
    } else {
        if (source instanceof HTMLSelectElement && mirror.innerHTML !== source.innerHTML) mirror.innerHTML = source.innerHTML;
        if (mirror.value !== source.value) mirror.value = source.value;
    }
    mirror.disabled = source.disabled;
}

function copyLeaf(source: HTMLElement, mirror: HTMLElement): void {
    if (mirror.children.length) return;
    mirror.className = source.className;
    mirror.style.cssText = source.style.cssText;
    const html = source.innerHTML.replace(/\sid="[^"]*"/g, '');
    if (mirror.innerHTML !== html) mirror.innerHTML = html;
}

/** Originals can change without an event (the page loads values straight in), so copy them across now and then. */
export function syncMirrors(): void {
    copies().forEach(mirror => {
        const source = sourceOf(mirror);
        if (!source) return;
        if (isFormField(mirror)) {
            if (isFormField(source)) copyValue(source, mirror);
        } else if (mirror.tagName !== 'BUTTON') {
            copyLeaf(source, mirror);
        }
    });
}

export function wireMirrors(lifecycle: MountLifecycle): void {
    const { signal } = lifecycle;
    copies().forEach(mirror => {
        const source = sourceOf(mirror);
        if (!source) return;
        if (isFormField(mirror)) {
            if (!isFormField(source)) return;
            const toSource = (event: Event): void => {
                if (mirror instanceof HTMLInputElement && mirror.type === 'checkbox') {
                    if (source instanceof HTMLInputElement) source.checked = mirror.checked;
                } else {
                    source.value = mirror.value;
                }
                source.dispatchEvent(new Event(event.type, { bubbles: true }));
            };
            mirror.addEventListener('input', toSource, { signal });
            mirror.addEventListener('change', toSource, { signal });
            const toMirror = (): void => copyValue(source, mirror);
            source.addEventListener('input', toMirror, { signal });
            source.addEventListener('change', toMirror, { signal });
        } else if (mirror.tagName === 'BUTTON') {
            mirror.addEventListener('click', () => source.click(), { signal });
        } else {
            lifecycle.track(new MutationObserver(() => copyLeaf(source, mirror))).observe(source, { attributes: true, childList: true, characterData: true, subtree: true });
        }
    });
    syncMirrors();
}
