// X1: every value interpolated into HTML is escaped or recognisably safe (escape.mjs, taint.mjs). Ratcheted by
// escape-guard-baseline.json. Adapted from Jellyfin Canopy's src/test/escape-guard.test.ts (GPL-3.0).
import test from 'node:test';
import { guard } from './guards.mjs';
import { clientProject } from './lib.mjs';
import { assertClean, assertPlantedFails, assertRatchet, scanPlanted } from './harness.mjs';

const g = guard('escape-guard');

test('X1: no new unescaped value reaches an HTML sink (ratchet)', t => {
  assertRatchet(t, g, g.scan(clientProject()));
});

test('X1 self-test: a raw item field in a markup template fails', () => {
  const v = scanPlanted(g, `
    export function renderCard(el: HTMLElement, item: { Name: string }) {
      el.innerHTML = \`<div class="card">\${item.Name}</div>\`;
    }`);
  assertPlantedFails(g, v, ['X1 renderCard']);
});

test('X1 self-test: concatenation, insertAdjacentHTML, document.write and toast are sinks', () => {
  const v = scanPlanted(g, `
    export function concat(el: HTMLElement, value: string) { el.innerHTML = '<b>' + value + '</b>'; }
    export function adjacent(el: HTMLElement, html: string) { el.insertAdjacentHTML('beforeend', html); }
    export function written(text: string) { document.write(text); }
    export function toasted(JE: { toast(h: string): void }, title: string) { JE.toast(\`Saved \${title}\`); }`);
  assertPlantedFails(g, v, ['X1 concat', 'X1 adjacent', 'X1 written', 'X1 toasted']);
});

test('X1 self-test: a builder parameter fails when one caller passes raw data; translation params are not escaped', () => {
  const v = scanPlanted(g, `
    function cell(label: string) { return \`<td>\${label}</td>\`; }
    export function row(el: HTMLElement, item: { Name: string }, JE: { t(k: string, p?: object): string }) {
      el.innerHTML = cell('fixed') + cell(item.Name);
      el.innerHTML = \`<p>\${JE.t('greeting', { name: item.Name })}</p>\`;
    }`);
  assertPlantedFails(g, v, ['X1 cell', 'X1 row']);
});

test('X1 self-test: escaped, numeric, constant, translated and contract-safe values pass', () => {
  const v = scanPlanted(g, `
    const ICON = '<svg viewBox="0 0 1 1"></svg>';
    function cell(label: string) { return \`<td>\${label}</td>\`; }
    export function render(el: HTMLElement, item: { Name: string; Count: number }, escapeHtml: (s: unknown) => string,
                           JE: { t(k: string, p?: object): string; icon(n: string): string }) {
      const name = escapeHtml(item.Name);
      const items = ['a', 'b'].map(k => \`<li data-k="\${k}">\${k}</li>\`).join('');
      let html = '';
      for (const k of ['x', 'y']) html += \`<span>\${k}</span>\`;
      el.innerHTML = \`<div title="\${name}">\${ICON}\${Number(item.Count) || 0}\${item.Count.toFixed(1)}\`
        + \`\${cell('x')}\${cell(escapeHtml(item.Name))}\${items}\${html}\${JE.t('n_items', { count: Number(item.Count) + 1 })}\`
        + \`\${JE.icon('star')}\${encodeURIComponent(item.Name)}\${item.Name.length}</div>\`;
    }`);
  assertClean(g, v);
});
