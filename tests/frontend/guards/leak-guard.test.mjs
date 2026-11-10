// L1–L6: long-lived collections are bounded, global listeners, observers and intervals are torn down, retries are
// capped and object URLs are revoked (leaks.mjs). Ratcheted by leak-guard-baseline.json. Adapted from Jellyfin
// Canopy's src/test/leak-guard.test.ts (GPL-3.0).
import test from 'node:test';
import { guard } from './guards.mjs';
import { clientProject } from './lib.mjs';
import { assertClean, assertPlantedFails, assertRatchet, scanPlanted } from './harness.mjs';

const g = guard('leak-guard');

test('L1-L6: no new leak or unbounded cache (ratchet)', t => {
  assertRatchet(t, g, g.scan(clientProject()));
});

const PLANTED_LEAKS = `
  const seen = new Map<string, number>();
  export function remember(id: string) { seen.set(id, Date.now()); }
  export function start(el: HTMLElement, blob: Blob) {
    window.addEventListener('resize', () => el.remove());
    new MutationObserver(() => el.remove()).observe(el, { childList: true });
    setInterval(() => el.remove(), 1000);
    return URL.createObjectURL(blob);
  }
  function ready() { return Boolean(document.body); }
  export function poll() { if (!ready()) setTimeout(poll, 100); }`;

for (const [rule, key] of [
  ['L1', 'L1-unbounded-cache (module) seen'],
  ['L2', 'L2-global-listener start resize'],
  ['L3', 'L3-observer start'],
  ['L4', 'L4-interval start'],
  ['L5', 'L5-retry-uncapped poll'],
  ['L6', 'L6-object-url start'],
]) {
  test(`${rule} self-test: a planted ${key.split(' ')[0]} fails`, () => {
    assertPlantedFails(g, scanPlanted(g, PLANTED_LEAKS), [key]);
  });
}

test('L1-L6 self-test: bounded caches and torn-down resources pass', () => {
  const v = scanPlanted(g, `
    const seen = new Map<string, number>();
    const TABLE = new Map<string, string>();
    ['a', 'b'].forEach(k => TABLE.set(k, k));
    export function remember(id: string) { if (seen.size > 100) seen.delete(seen.keys().next().value!); seen.set(id, 1); }
    export function start(el: HTMLElement, blob: Blob, signal: AbortSignal, lifecycle: { track<T>(r: T): T }) {
      window.addEventListener('resize', () => el.remove(), { signal });
      document.addEventListener('keydown', () => el.remove(), { once: true });
      const listening = { signal };
      document.addEventListener('scroll', () => el.remove(), listening);
      const observer = new MutationObserver(() => el.remove());
      observer.observe(el, { childList: true });
      lifecycle.track(new ResizeObserver(() => el.remove()));
      const timer = setInterval(() => el.remove(), 1000);
      el.addEventListener('click', () => { observer.disconnect(); clearInterval(timer); });
      const url = URL.createObjectURL(blob);
      URL.revokeObjectURL(url);
    }
    export function poll(attempt = 0) { if (attempt < 20) setTimeout(() => poll(attempt + 1), 100); }`);
  assertClean(g, v);
});
