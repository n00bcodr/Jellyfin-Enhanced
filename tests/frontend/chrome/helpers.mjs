// Shared helpers for the chrome slice's focused tests. Scripts load from CHROME_JS
// (default: published production outputs) so the same specs run against the pinned
// baseline JS (artifacts/rewrite-chrome/baseline-js) for before/after evidence, and
// against the published production outputs after publication.
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
export const chromeRoot = resolve(process.env.CHROME_JS || resolve(here, '../../../Jellyfin.Plugin.JellyfinEnhanced/js'));
export const chromeJs = path => resolve(chromeRoot, path);
export const isBaseline = chromeRoot.includes('baseline-js');

/** A deterministic virtual clock installed as the page's timer globals. */
export function fakeClock() {
  let now = 0, seq = 0;
  const timers = new Map();
  const add = (fn, ms, repeat) => { const id = ++seq; timers.set(id, { fn, at: now + Math.max(0, ms || 0), every: repeat ? Math.max(1, ms || 0) : 0 }); return id; };
  const globals = {
    setTimeout: (fn, ms) => add(fn, ms, false), clearTimeout: id => { timers.delete(id); },
    setInterval: (fn, ms) => add(fn, ms, true), clearInterval: id => { timers.delete(id); }
  };
  return {
    globals,
    get pending() { return timers.size; },
    /** Advance virtual time, running due timers in order and letting microtasks/observers settle between them. */
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await settle();
        let next = null;
        for (const [id, timer] of timers) if (timer.at <= end && (!next || timer.at < next[1].at || (timer.at === next[1].at && id < next[0]))) next = [id, timer];
        if (!next) break;
        const [id, timer] = next;
        now = timer.at;
        if (timer.every) timer.at += timer.every; else timers.delete(id);
        timer.fn();
      }
      now = end;
      await settle();
    }
  };
}
export async function settle(turns = 5) { for (let i = 0; i < turns; i++) await new Promise(resolve => setImmediate(resolve)); }
export async function until(fn, message = 'condition did not become true') {
  const deadline = performance.now() + 3000;
  while (!fn() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(fn(), message);
}
/** A minimal JE.session with an explicit epoch and reset fan-out, as client/src/core/session.ts exposes it. */
export function fakeSession(readUser) {
  let epoch = 1;
  const handlers = new Map();
  return {
    getUserId: () => readUser(), getServerId: () => 'server-a', getEpoch: () => epoch, isCurrent: e => e === epoch,
    onUserChange(name, callback) { handlers.set(name, callback); return () => handlers.delete(name); },
    /** Advance the epoch and run every reset handler, like a real transition. */
    change() { epoch++; for (const callback of [...handlers.values()]) callback({ epoch }); return epoch; },
    get epoch() { return epoch; }, handlers
  };
}
