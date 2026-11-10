export function required<T extends HTMLElement>(root: ParentNode, selector: string): T {
 const element = root.querySelector<T>(selector);
 if (!element) throw new Error('Missing bookmark control: ' + selector);
 return element;
}
