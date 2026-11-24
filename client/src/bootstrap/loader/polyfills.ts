/**
 * replaceChildren() is Chrome 86+, so older Tizen and webOS TVs lack it, and jellyfin-web's core-js bundle does not
 * add DOM methods. Installed first in plugin.js: every JE module, including the admin page's, loads after it.
 */
export function installReplaceChildren(): void {
    for (const proto of [Element.prototype, Document.prototype, DocumentFragment.prototype]) {
        if (typeof proto.replaceChildren === 'function') continue;
        Object.defineProperty(proto, 'replaceChildren', {
            configurable: true, writable: true,
            value(this: ParentNode & Node, ...nodes: Array<Node | string>) {
                while (this.lastChild) this.removeChild(this.lastChild);
                this.append(...nodes);
            },
        });
    }
}
