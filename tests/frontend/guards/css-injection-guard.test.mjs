// X2: every value interpolated into CSS text is numeric, constant or validated (css.mjs). escapeHtml does not count.
// Ratcheted by css-injection-guard-baseline.json. Adapted from Jellyfin Canopy's src/test/css-injection-guard.test.ts
// (GPL-3.0).
import test from 'node:test';
import { guard } from './guards.mjs';
import { clientProject } from './lib.mjs';
import { assertClean, assertPlantedFails, assertRatchet, scanPlanted } from './harness.mjs';

const g = guard('css-injection-guard');

test('X2: no new unvalidated value reaches CSS text (ratchet)', t => {
  assertRatchet(t, g, g.scan(clientProject()));
});

test('X2 self-test: config values in cssText, addCSS, a <style> element and a style attribute fail', () => {
  const v = scanPlanted(g, `
    import packageCss from 'some-package/theme.css';
    import outsideCss from '../../../../outside.css';
    export function bare() { const style = document.createElement('style'); style.textContent = packageCss + outsideCss; }
    export function paint(el: HTMLElement, cfg: { Color: string }) { el.style.cssText = \`color: \${cfg.Color}\`; }
    export function sheet(JE: { helpers: { addCSS(id: string, css: string): void } }, accent: string) {
      JE.helpers.addCSS('je-x', \`.je-x { background: \${accent}; }\`);
    }
    export function styleTag(css: string) { const style = document.createElement('style'); style.textContent = css; }
    export function attr(el: HTMLElement, color: string, escapeHtml: (s: string) => string) {
      el.innerHTML = \`<span style="color: \${escapeHtml(color)}">x</span>\`;
    }`);
  assertPlantedFails(g, v, ['X2 bare', 'X2 paint', 'X2 sheet', 'X2 styleTag', 'X2 attr']);
});

test('X2 self-test: numbers, constants, validated colours, CSS.escape and .css text imports pass', () => {
  const v = scanPlanted(g, `
    import sheetCss from './planted.css';
    const ACCENT = '#00a4dc';
    function isCssColor(v: unknown): v is string { return typeof v === 'string'; }
    export function paint(el: HTMLElement, cfg: { Size: string; Color: string; Id: string }) {
      const size = Number(cfg.Size) || 12;
      const color = isCssColor(cfg.Color) ? cfg.Color : ACCENT;
      el.style.cssText = \`font-size: \${size}px; color: \${isCssColor(cfg.Color) ? cfg.Color : '#fff'}\`;
      el.innerHTML = \`<span style="width: \${Math.round(size * 2)}px; border-color: \${ACCENT}">x</span>\`;
      el.setAttribute('style', \`--id: \${CSS.escape(cfg.Id)}; opacity: \${size > 3 ? 1 : 0.5}\`);
      el.style.color = color;
      const style = document.createElement('style');
      style.textContent = sheetCss;
    }`);
  assertClean(g, v);
});
