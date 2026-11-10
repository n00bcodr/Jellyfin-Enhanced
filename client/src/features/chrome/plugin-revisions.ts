import type { ChromeCore } from './host';

export interface PluginRevisionsBridge {
    core: ChromeCore;
    initializePluginRevisions?: () => void;
}

/** The version that opens a dashboard revision label ("10.11.0.0 — notes"), or null. */
export function revisionVersion(label: string | null | undefined): string | null {
    return label?.match(/^\s*(\d+(?:\.\d+){1,3})(?=\s|—|$)/)?.[1] ?? null;
}

const HIDDEN_CLASS = 'je-duplicate-plugin-revision';
const ROUTE = /^#\/dashboard\/plugins\/[^/?]+/;

/** One visible revision per version on every plugin's dashboard page. Re-initialization replaces the previous run. */
export function initializePluginRevisions(JE: PluginRevisionsBridge): void {
    const lifecycle = JE.core.lifecycle.register('plugin-revisions');
    lifecycle.teardown();

    const style = document.createElement('style');
    style.textContent = `#addPluginPage .${HIDDEN_CLASS} { display: none !important; }`;
    document.head.appendChild(style);
    let frame = 0;
    let stopped = false;

    function update(): void {
        frame = 0;
        if (stopped) return;
        const page = document.getElementById('addPluginPage');
        if (!page) return;
        // Keep the first row in each list, matching the server's resolver.
        // The catalog already filters incompatible targetAbi values.
        const lists = new Map<Element | null, Set<string>>();
        for (const row of page.querySelectorAll('.MuiAccordion-root')) {
            const summary = row.querySelector(':scope > .MuiAccordion-heading > .MuiAccordionSummary-root');
            const version = revisionVersion(summary?.querySelector('.MuiAccordionSummary-content')?.textContent);
            if (!version) {
                row.classList.remove(HIDDEN_CLASS);
                continue;
            }
            let seen = lists.get(row.parentElement);
            if (!seen) lists.set(row.parentElement, seen = new Set());
            // React owns these nodes and their install handlers. Hide only;
            // never remove/reorder them or change the package response.
            row.classList.toggle(HIDDEN_CLASS, seen.has(version));
            seen.add(version);
        }
    }

    function schedule(): void {
        if (!stopped && !frame && ROUTE.test(location.hash)) frame = requestAnimationFrame(update);
    }

    // The shared observer (childList only) cannot feed our class changes back into
    // another scan. Navigation also covers pushState changes.
    lifecycle.track(JE.core.dom.onBodyMutation('plugin-revisions', schedule));
    lifecycle.track(JE.core.navigation.onNavigate(schedule));
    lifecycle.track(() => {
        stopped = true;
        cancelAnimationFrame(frame);
        document.querySelectorAll('.' + HIDDEN_CLASS).forEach(row => row.classList.remove(HIDDEN_CLASS));
        style.remove();
    });
    schedule();
}
