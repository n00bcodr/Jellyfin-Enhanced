// R3, R5, R6: no new body-wide MutationObserver, no setInterval DOM detection, no runtime load of a remote asset
// (perf.mjs). Ratcheted by performance-rules-guard-baseline.json. Adapted from Jellyfin Canopy's
// scripts/check-performance-rules.js and CONTRIBUTING.md "Performance rules" (GPL-3.0).
import test from 'node:test';
import { guard } from './guards.mjs';
import { clientProject } from './lib.mjs';
import { assertClean, assertPlantedFails, assertRatchet, scanPlanted } from './harness.mjs';

const g = guard('performance-rules-guard');

test('R3/R5/R6: no new body-wide observer, DOM polling interval or remote asset (ratchet)', t => {
  assertRatchet(t, g, g.scan(clientProject()));
});

test('R3 self-test: a body-wide subtree observer fails', () => {
  const v = scanPlanted(g, `
    export function watch(cb: MutationCallback) { new MutationObserver(cb).observe(document.body, { childList: true, subtree: true }); }`);
  assertPlantedFails(g, v, ['R3-body-observer watch']);
});

test('R5 self-test: a setInterval that polls the DOM fails', () => {
  const v = scanPlanted(g, `
    function found() { return document.querySelector('.itemDetailPage') !== null; }
    export function waitForPage(go: () => void) { const id = setInterval(() => { if (found()) { clearInterval(id); go(); } }, 100); }`);
  assertPlantedFails(g, v, ['R5-interval-dom waitForPage']);
});

test('R6 self-test: remote fetch, remote script and remote CSS imports fail', () => {
  const v = scanPlanted(g, `
    export function loadLocale() { return fetch('https://raw.githubusercontent.com/x/y/main/en.json'); }
    export function loadScript() { const s = document.createElement('script'); s.src = 'https://cdn.example.com/lib.js'; document.head.append(s); }
    export const FONT_CSS = "@import url('https://fonts.googleapis.com/css2?family=Inter');";`);
  assertPlantedFails(g, v, ['R6-remote-asset loadLocale', 'R6-remote-asset loadScript', 'R6-remote-asset (module)']);
});

test('R3/R5/R6 self-test: page-scoped observers, data polls, local assets and links pass', () => {
  const v = scanPlanted(g, `
    export function ok(page: HTMLElement, refresh: () => void, cb: MutationCallback) {
      new MutationObserver(cb).observe(page, { childList: true, subtree: true });
      new MutationObserver(cb).observe(document.body, { childList: true });
      setInterval(() => refresh(), 30000);
      void fetch('/JellyfinEnhanced/locales/en.json');
      page.innerHTML = '<a href="https://github.com/n00bcodr/Jellyfin-Enhanced" target="_blank">GitHub</a>';
    }`);
  assertClean(g, v);
});
