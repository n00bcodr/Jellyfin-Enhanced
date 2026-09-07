// One visible revision per version on every plugin's dashboard page.
(function (JE) {
    'use strict';

    JE.initializePluginRevisions = function () {
        const lifecycle = JE.core.lifecycle.register('plugin-revisions');
        lifecycle.teardown();

        const hiddenClass = 'je-duplicate-plugin-revision';
        const style = document.createElement('style');
        style.textContent = `#addPluginPage .${hiddenClass} { display: none !important; }`;
        document.head.appendChild(style);
        let frame = 0;
        let stopped = false;

        function update() {
            frame = 0;
            if (stopped) return;
            const page = document.getElementById('addPluginPage');
            if (!page) return;

            // Keep the first row in each list, matching the server's resolver.
            // The catalog already filters incompatible targetAbi values.
            const lists = new Map();
            for (const row of page.querySelectorAll('.MuiAccordion-root')) {
                const summary = row.querySelector(':scope > .MuiAccordion-heading > .MuiAccordionSummary-root');
                const label = summary?.querySelector('.MuiAccordionSummary-content')?.textContent;
                const version = label?.match(/^\s*(\d+(?:\.\d+){1,3})(?=\s|—|$)/)?.[1];
                if (!version) {
                    row.classList.remove(hiddenClass);
                    continue;
                }
                let seen = lists.get(row.parentElement);
                if (!seen) lists.set(row.parentElement, seen = new Set());
                // React owns these nodes and their install handlers. Hide only;
                // never remove/reorder them or change the package response.
                row.classList.toggle(hiddenClass, seen.has(version));
                seen.add(version);
            }
        }

        function schedule() {
            if (!stopped && !frame && /^#\/dashboard\/plugins\/[^/?]+/.test(location.hash)) {
                frame = requestAnimationFrame(update);
            }
        }

        // Use the shared observer (childList only), so our class changes cannot
        // feed back into another scan. Navigation also covers pushState changes.
        lifecycle.track(JE.core.dom.onBodyMutation('plugin-revisions', schedule));
        lifecycle.track(JE.core.navigation.onNavigate(schedule));
        lifecycle.track(() => {
            stopped = true;
            cancelAnimationFrame(frame);
            document.querySelectorAll('.' + hiddenClass).forEach(row => row.classList.remove(hiddenClass));
            style.remove();
        });
        schedule();
    };
})(window.JellyfinEnhanced);
