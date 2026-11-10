import type { PageModules } from './modules';
import { closestTo, asHtml } from './dom';
import type { BannerGroup } from './types';

/** Dependencies this module calls; members are resolved lazily, after every module exists. */
export type BannersDeps = Pick<PageModules, 'context'>;

export function createBanners(m: BannersDeps) {
    const { lifecycle } = m.context;

        // Collapsible info banners
        //
        // When the "Descriptions" toggle is off, every inline info banner is
        // folded into a small (i) icon next to its anchor (fieldset legend, or
        // the parent container of the checkbox the banner describes). Clicking
        // the icon toggles the banner(s) open in place; clicking outside closes
        // them. Multiple banners sharing an anchor toggle together under a
        // single icon.
        //
        // Anchor detection:
        //  - Banner inside a <div class="je-setting-description" data-desc-for="id">
        //    → anchor is the nearest .checkboxContainer / .inputContainer that
        //      contains the input with that id. We attach to the container (as a
        //      sibling of the <label>) so clicking the trigger can't forward to
        //      the checkbox via the label's click behavior.
        //  - Otherwise → anchor is the nearest <legend class="sectionTitle">
        //    inside the same <fieldset>.
        //
        // All banners matching are marked .je-banner-managed; the CSS in
        // jeAdmin.css handles visibility keyed off body.je-hide-descriptions
        // and the .je-banner-open toggle.
        // Tracks every wired banner group so we can re-sync the parent-
        // checkbox gating (see below) when loadConfig runs AFTER wiring.
        var _jeBannerGroups: BannerGroup[] = [];

        /**
         * Re-syncs every gated banner group's parent-off state. Called from
         * updateAllDependencies so programmatic `checkbox.checked = x` applied
         * during loadConfig picks up correctly (a direct assignment doesn't
         * fire the 'change' event we listen to otherwise).
         */
        function syncAllBannerParents() : void {
            _jeBannerGroups.forEach(function(group) {
                if (!group.parentCheckbox) return;
                _jeSyncBannerParent(group);
            });
        }

        function _jeSyncBannerParent(group: BannerGroup) : void {
            var off = !group.parentCheckbox?.checked;
            group.banners.forEach(function(b) {
                b.classList.toggle('je-banner-parent-off', off);
                if (off) b.classList.remove('je-banner-open');
            });
            group.trigger.classList.toggle('je-banner-parent-off', off);
            if (off) group.trigger.setAttribute('aria-expanded', 'false');
        }

    /** Runs this module's start-up work, in the page's original order. */
    function wire(): void {
        (function wireCollapsibleBanners() {
            var banners = document.querySelectorAll<HTMLElement>('.je-info-banner-inline, .je-info-banner-inline-center');
            if (!banners.length) return;

            function findAnchor(banner: HTMLElement): HTMLElement | null {
                // Explicit overrides on the banner itself:
                //   data-banner-anchor="legend"       → force fieldset legend
                //   data-banner-anchor="#elementId"   → force arbitrary element
                // Used for banners that live inside one setting's description
                // wrapper but are semantically about the whole fieldset (e.g.
                // "How to Use Bookmarks:" under bookmarksUseCustomTabs).
                var override = banner.getAttribute('data-banner-anchor');
                if (override === 'legend') {
                    var fsOverride = banner.closest('fieldset');
                    if (fsOverride) {
                        var legendOverride = asHtml(fsOverride.querySelector('legend.sectionTitle'));
                        if (legendOverride) return legendOverride;
                    }
                } else if (override && override.charAt(0) === '#') {
                    var el = asHtml(document.querySelector(override));
                    if (el) return el;
                }

                var descWrapper = banner.closest('.je-setting-description[data-desc-for]');
                if (descWrapper) {
                    var targetId = descWrapper.getAttribute('data-desc-for');
                    var target = asHtml(document.getElementById(targetId ?? ''));
                    if (target) {
                        var container = asHtml(target.closest('.checkboxContainer, .inputContainer'));
                        if (container) return container;
                    }
                }
                var fieldset = banner.closest('fieldset');
                if (fieldset) {
                    var legend = asHtml(fieldset.querySelector('legend.sectionTitle'));
                    if (legend) return legend;
                }
                return null;
            }

            // Find the parent checkbox whose "checked" state gates this banner
            // (auto-detect via nearest .je-setting-description[data-desc-for="X"]
            // where #X is a checkbox). Explicit opt-out: data-banner-no-gate="true"
            // on the banner disables the gating for that specific banner.
            function findParentCheckbox(banner: HTMLElement): HTMLInputElement | null {
                if (banner.getAttribute('data-banner-no-gate') === 'true') return null;
                var descWrapper = banner.closest('.je-setting-description[data-desc-for]');
                if (!descWrapper) return null;
                var targetId = descWrapper.getAttribute('data-desc-for');
                var target = asHtml(document.getElementById(targetId ?? ''));
                if (target instanceof HTMLInputElement && target.type === 'checkbox') return target;
                return null;
            }

            // Group banners by anchor; also capture the shared parent checkbox
            // (we assume all banners under one anchor share the same gate —
            // currently true because they live in the same .je-setting-description).
            var anchorMap = new Map<HTMLElement, { banners: HTMLElement[]; parentCheckbox: HTMLInputElement | null }>();
            banners.forEach(function(banner, idx) {
                banner.classList.add('je-banner-managed');
                if (!banner.id) banner.id = 'je-banner-' + idx + '-' + Math.random().toString(36).slice(2, 8);
                var anchor = findAnchor(banner);
                if (!anchor) {
                    // Future contributors adding a banner outside a fieldset / outside
                    // any .je-setting-description[data-desc-for] will end up here —
                    // the banner gets `je-banner-managed` (so CSS hides it when
                    // descriptions-off) but no trigger icon. Without a log, the
                    // banner would just disappear when the admin toggles
                    // descriptions off with no way to get it back.
                    console.warn('[JE] banner has no anchor — collapse trigger will not be wired:', banner.id || banner);
                    return;
                }
                const entry = anchorMap.get(anchor) ?? { banners: [], parentCheckbox: findParentCheckbox(banner) };
                entry.banners.push(banner);
                anchorMap.set(anchor, entry);
            });

            anchorMap.forEach(function(data, anchor) {
                if (anchor.dataset.jeBannerWired === '1') return;
                anchor.dataset.jeBannerWired = '1';

                var trigger = document.createElement('button');
                trigger.type = 'button';
                trigger.className = 'je-banner-trigger';
                trigger.setAttribute('aria-expanded', 'false');
                var labelText = data.banners.length > 1 ? 'Show ' + data.banners.length + ' info panels' : 'Show info';
                trigger.setAttribute('aria-label', labelText);
                trigger.title = labelText;
                var icon = document.createElement('i');
                icon.className = 'material-icons';
                icon.setAttribute('aria-hidden', 'true');
                icon.textContent = 'info';
                trigger.appendChild(icon);
                anchor.appendChild(trigger);

                var group = { banners: data.banners, trigger: trigger, parentCheckbox: data.parentCheckbox };
                _jeBannerGroups.push(group);

                trigger.addEventListener('click', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    var nextOpen = trigger.getAttribute('aria-expanded') !== 'true';
                    trigger.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
                    data.banners.forEach(function(b) {
                        b.classList.toggle('je-banner-open', nextOpen);
                    });
                });

                // Gate on the parent checkbox: when unchecked, hide banners
                // and surface the trigger icon (same UX as descriptions-off
                // mode). Initial sync runs here; syncAllBannerParents() is
                // also called from updateAllDependencies so loadConfig's
                // programmatic .checked assignments pick up correctly.
                if (data.parentCheckbox) {
                    _jeSyncBannerParent(group);
                    data.parentCheckbox.addEventListener('change', function() {
                        _jeSyncBannerParent(group);
                    });
                }
            });

            // Outside-click closes every open banner. Clicks inside an open
            // banner (e.g. code copy button, links) don't close it.
            document.addEventListener('click', function(e) {
                if (!e.target) return;
                if (closestTo(e, '.je-banner-trigger, .je-banner-managed')) return;
                document.querySelectorAll<HTMLElement>('.je-banner-trigger[aria-expanded="true"]').forEach(function(t) {
                    t.setAttribute('aria-expanded', 'false');
                });
                document.querySelectorAll<HTMLElement>('.je-banner-managed.je-banner-open').forEach(function(b) {
                    b.classList.remove('je-banner-open');
                });
            }, { signal: lifecycle.signal });
        })();
    }

    return {
        wire,
        syncAllBannerParents,
    };
}
