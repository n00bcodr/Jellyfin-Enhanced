import { cdnUrl } from '../../../host/admin-config-host';
import type { PageModules } from './modules';

/** Dependencies this module calls; members are resolved lazily, after every module exists. */
export type ThemeDeps = Pick<PageModules, 'context'>;

export function createTheme(m: ThemeDeps) {
    const { lifecycle, page } = m.context;

            // Theme detector: Jellyfin's themes hard-swap theme.css (no CSS
            // variable contract) so we infer dark vs. light from the computed
            // background-color of <html>. Dark themes return something like
            // rgb(16,16,16) (sum ~48); the Light theme returns rgb(242,242,242)
            // (sum 726). Threshold at 450 bins every shipped theme correctly.
            // We also re-run on `load` in case the theme sheet hadn't applied
            // by the time our initial check ran, and once more after ~600 ms
            // to catch late Jellyfin theme swaps during dashboard navigation.
            function _jeDetectTheme() : void {
                if (!page) return;
                // Wrap the read in try/catch — during SPA detach getComputedStyle
                // can throw InvalidAccessError. If anything goes wrong we fall
                // back to dark (matches the plugin's previous default) so the
                // rest of the IIFE's listener wiring isn't aborted by a throw
                // from this purely cosmetic detector.
                try {
                    var bg = getComputedStyle(document.documentElement).backgroundColor;
                    var m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
                    if (!m) {
                        // Named colors (`black`), `transparent`, or `initial`: can't
                        // tell light vs. dark reliably. Log once so a future broken
                        // theme is diagnosable rather than silently dark.
                        console.warn('[JE] theme detector: document background is unparseable (' + bg + '); defaulting to dark');
                        page.classList.remove('je-light-theme');
                        page.classList.add('je-dark-theme');
                        return;
                    }
                    var sum = Number(m[1]) + Number(m[2]) + Number(m[3]);
                    var isLight = sum > 450;
                    page.classList.toggle('je-light-theme', isLight);
                    page.classList.toggle('je-dark-theme',  !isLight);
                } catch (e) {
                    console.warn('[JE] theme detection failed, defaulting to dark:', e);
                    page.classList.remove('je-light-theme');
                    page.classList.add('je-dark-theme');
                }
            }

    /** Runs this module's start-up work, in the page's original order. */
    function wire(): void {
            // Point every CDN-backed image on this page at the local plugin CDN route.
            // Images carry a data-je-cdn="<source>/<path>" attribute instead of a hardcoded
            // external src, so the browser never contacts an external CDN. jeCdnUrl is
            // defined in the head <script> above and is base-path-safe.
            try {
                document.querySelectorAll<HTMLImageElement>('img[data-je-cdn]').forEach((img) => {
                    img.src = cdnUrl(img.getAttribute('data-je-cdn') ?? '');
                });
            } catch (e) {
                console.warn('[JE] Failed to rewrite CDN image sources', e);
            }

            // Next frame, before it paints (the page's first frame already has
            // the right theme classes): reading the computed background here, in
            // the middle of the page's insertion, forced an extra style pass.
            requestAnimationFrame(_jeDetectTheme);

            window.addEventListener('load', _jeDetectTheme, { signal: lifecycle.signal });

            lifecycle.timeout(_jeDetectTheme, 600);
    }

    return {
        wire,

    };
}
