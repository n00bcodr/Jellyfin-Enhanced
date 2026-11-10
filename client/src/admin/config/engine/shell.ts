import type { MountLifecycle } from './lifecycle';
import { syncMirrors } from './mirrors';

/** Sidebar groups. Tabs not listed (e.g. ones added by Custom Tabs) stay at the end, ungrouped. */
const NAV_GROUPS: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['Appearance', ['display', 'media-tags', 'elsewhere']],
    ['Behaviour', ['playback', 'pages', 'extras', 'keyboard']],
    ['Connections', ['services', 'seerr', 'arr']],
    ['Server', ['admin']],
    ['About', ['about', 'docs']],
];

const textOf = (element: Element): string => Array.from(element.childNodes).filter(node => node.nodeType === 3).map(node => node.textContent).join('').trim();

function sectionTitle(fieldset: Element): string {
    const legend = fieldset.querySelector(':scope > legend');
    return legend ? textOf(legend) : '';
}

/** Focus mode: picking a card (or a group inside it) in the sidebar shows only that on screen; picking the tab itself shows everything. */
function showAll(tab: Element | null): void {
    if (!tab) return;
    const button = document.querySelector('.jellyfin-tab-button[data-tab="' + tab.id + '"]');
    if (button && button.nextElementSibling) button.nextElementSibling.querySelectorAll('.jea-nav-leaf.on').forEach(leaf => leaf.classList.remove('on'));
    tab.classList.remove('jea-focused');
    tab.querySelectorAll(':scope > fieldset.jea-focus').forEach(fieldset => fieldset.classList.remove('jea-focus'));
}

function focusCard(tab: Element, card: Element, group?: HTMLDetailsElement): void {
    tab.classList.add('jea-focused');
    tab.querySelectorAll(':scope > fieldset').forEach(fieldset => fieldset.classList.toggle('jea-focus', fieldset === card));
    if (group) {
        card.querySelectorAll<HTMLDetailsElement>('.jea-group').forEach(other => { other.open = other === group; });
        group.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
}

function topGroups(card: Element): HTMLDetailsElement[] {
    return Array.from(card.querySelectorAll<HTMLDetailsElement>('.jea-group')).filter(group => !group.parentElement?.closest('.jea-group'));
}

/** Sidebar tree: under the active tab, one link per card on that tab. Clicking jumps to the card; the one in view is highlighted. */
function buildTree(bar: Element, lifecycle: MountLifecycle): void {
    const { signal } = lifecycle;
    bar.querySelectorAll<HTMLElement>('.jellyfin-tab-button').forEach(button => {
        const tab = document.getElementById(button.dataset.tab ?? '');
        if (!tab) return;
        button.addEventListener('click', () => showAll(tab), { signal });
        const cards = Array.from(tab.querySelectorAll(':scope > fieldset')).filter(card => sectionTitle(card));
        if (cards.length < 2) return;
        const tree = document.createElement('div');
        tree.className = 'jea-nav-tree';
        const open = (action: () => void): void => {
            if (button.classList.contains('active')) action();
            else { button.click(); lifecycle.timeout(action, 350); }
        };
        const mark = (leaf: Element, sub?: Element): void => {
            tree.querySelectorAll('.jea-nav-leaf').forEach(other => other.classList.toggle('on', other === leaf || other === sub));
        };
        cards.forEach(card => {
            const link = document.createElement('a');
            link.href = '#';
            link.className = 'jea-nav-leaf';
            link.textContent = sectionTitle(card);
            link.addEventListener('click', event => {
                event.preventDefault();
                open(() => { focusCard(tab, card); mark(link); });
            }, { signal });
            tree.appendChild(link);
            const groups = topGroups(card);
            if (groups.length >= 2) {
                const sub = document.createElement('div');
                sub.className = 'jea-nav-subtree';
                groups.forEach(group => {
                    const subLink = document.createElement('a');
                    subLink.href = '#';
                    subLink.className = 'jea-nav-leaf jea-nav-sub';
                    subLink.textContent = (group.querySelector(':scope > summary')?.textContent ?? '').trim();
                    subLink.addEventListener('click', event => {
                        event.preventDefault();
                        open(() => { focusCard(tab, card, group); mark(link, subLink); });
                    }, { signal });
                    sub.appendChild(subLink);
                });
                tree.appendChild(sub);
            }
        });
        button.after(tree);
    });
    const search = document.getElementById('settingsSearchInput');
    if (search instanceof HTMLInputElement) {
        search.addEventListener('input', () => {
            if (search.value) document.querySelectorAll('.jellyfin-tab-content.jea-focused').forEach(showAll);
        }, { signal });
    }
}

/**
 * Turn the horizontal tab strip into a grouped sidebar (a menu on phones). Moves existing nodes, so the
 * page's own tab, drag and search handlers keep working; they all look elements up by selector.
 */
export function mountShell(lifecycle: MountLifecycle): void {
    const { signal } = lifecycle;
    const bar = document.querySelector<HTMLElement>('.je-tab-bar');
    const header = document.querySelector('.je-sticky-header');
    const form = document.getElementById('JellyfinEnhancedForm');
    const parent = header?.parentNode;
    if (!bar || !header || !parent || !form || document.querySelector('.jea-layout')) return;
    const layout = document.createElement('div');
    layout.className = 'jea-layout';
    const nav = document.createElement('nav');
    nav.className = 'jea-nav';
    nav.setAttribute('aria-label', 'Settings sections');
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'jea-nav-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = '<i class="material-icons" aria-hidden="true">menu</i><span class="jea-nav-current"></span>';
    const main = document.createElement('div');
    main.className = 'jea-main';
    const version = document.querySelector('script[plugin="Jellyfin Enhanced"]')?.getAttribute('version');
    const title = header.querySelector('h2.sectionTitle');
    if (version && title && !title.querySelector('.jea-ver')) {
        const chip = document.createElement('span');
        chip.className = 'jea-ver';
        chip.textContent = 'v' + version.split('-')[0];
        title.appendChild(chip);
    }
    parent.insertBefore(layout, header.nextSibling);
    layout.append(nav, main);
    nav.append(toggle, bar);
    while (layout.nextSibling) main.appendChild(layout.nextSibling);

    // Insert a heading before each group's first tab and gather the group's other tabs after it, in listed order.
    NAV_GROUPS.forEach(([name, ids]) => {
        const buttons = ids.flatMap(id => {
            const button = bar.querySelector('[data-tab="' + id + '"]');
            return button ? [button] : [];
        });
        if (!buttons.length) return;
        const heading = document.createElement('div');
        heading.className = 'jea-nav-group';
        heading.textContent = name;
        bar.appendChild(heading);
        buttons.forEach(button => bar.appendChild(button));
    });
    // Overview (and anything unlisted) goes first.
    const grouped = new Set(NAV_GROUPS.flatMap(group => group[1]));
    Array.from(bar.querySelectorAll<HTMLElement>('.jellyfin-tab-button')).reverse().forEach(button => {
        if (!grouped.has(button.dataset.tab ?? '')) bar.prepend(button);
    });

    buildTree(bar, lifecycle);

    // Phone drawer: dimmed backdrop, a header with a close button, and the page behind is locked while it is open.
    const backdrop = document.createElement('div');
    backdrop.className = 'jea-nav-backdrop';
    nav.appendChild(backdrop);
    const head = document.createElement('div');
    head.className = 'jea-drawer-head';
    head.innerHTML = '<span>Settings</span><button type="button" class="jea-drawer-close" aria-label="Close menu"><i class="material-icons" aria-hidden="true">close</i></button>';
    bar.prepend(head);

    const locked: Array<{ element: HTMLElement; previous: string }> = [];
    const scrollParent = (): Element | null => {
        for (let node = nav.parentElement; node; node = node.parentElement) {
            const overflow = getComputedStyle(node).overflowY;
            if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) return node;
        }
        return document.scrollingElement;
    };
    const lock = (on: boolean): void => {
        if (on) {
            [scrollParent(), document.documentElement, document.body].forEach(element => {
                if (element instanceof HTMLElement && !locked.some(entry => entry.element === element)) {
                    locked.push({ element, previous: element.style.overflow });
                    element.style.overflow = 'hidden';
                }
            });
        } else {
            for (let entry = locked.pop(); entry; entry = locked.pop()) entry.element.style.overflow = entry.previous;
        }
    };
    const setOpen = (open: boolean): void => {
        nav.classList.toggle('jea-open', open);
        toggle.setAttribute('aria-expanded', String(open));
        lock(open);
    };
    // A view dropped with the drawer open must not leave the document scroll-locked.
    lifecycle.onDispose(() => lock(false));
    backdrop.addEventListener('click', () => setOpen(false), { signal });
    head.querySelector('.jea-drawer-close')?.addEventListener('click', () => setOpen(false), { signal });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && nav.classList.contains('jea-open')) setOpen(false);
    }, { signal });
    // Leaving the phone layout (rotate, resize) must not leave the page locked.
    window.addEventListener('resize', () => {
        if (window.innerWidth > 900 && nav.classList.contains('jea-open')) setOpen(false);
    }, { signal });

    const label = (): void => {
        const active = bar.querySelector('.jellyfin-tab-button.active h3');
        const current = toggle.querySelector('.jea-nav-current');
        if (current) current.textContent = active ? textOf(active) : 'Settings';
    };
    label();
    // A tab shown without a click (restored from the session, opened by an address or a link) relabels the phone menu too.
    lifecycle.track(new MutationObserver(label)).observe(bar, { subtree: true, attributes: true, attributeFilter: ['class'] });
    toggle.addEventListener('click', () => setOpen(!nav.classList.contains('jea-open')), { signal });
    // Tab clicks are handled by the page; close the phone menu after the active class has moved.
    bar.addEventListener('click', event => {
        if (event.target instanceof Element && event.target.closest('.jea-drawer-head')) return;
        lifecycle.timeout(() => { label(); setOpen(false); syncMirrors(); }, 0);
    }, { signal });
}
