// R9 "fail open, late beats never": a failed fetch surfaces an error; it is never returned, cached or rendered as an
// empty answer (error-empty.mjs). Ratcheted by error-as-empty-guard-baseline.json. Adapted from Jellyfin Canopy's
// src/test/error-as-empty-guard.test.ts and CONTRIBUTING.md rule R9 (GPL-3.0).
import test from 'node:test';
import { guard } from './guards.mjs';
import { clientProject } from './lib.mjs';
import { assertClean, assertPlantedFails, assertRatchet, scanPlanted } from './harness.mjs';

const g = guard('error-as-empty-guard');

test('R9: no new failure branch returns, caches or renders an empty answer (ratchet)', t => {
  assertRatchet(t, g, g.scan(clientProject()));
});

test('R9 self-test: a catch that returns [] fails (R9-fail-empty)', () => {
  const v = scanPlanted(g, `
    export async function loadRequests() {
      try { const r = await fetch('/requests'); return await r.json(); }
      catch (error) { console.warn('could not load', error); return []; }
    }
    export const loadIssues = () => fetch('/issues').then(r => r.json()).catch(() => ({ results: [], total: 0 }));`);
  assertPlantedFails(g, v, ['R9-fail-empty loadRequests', 'R9-fail-empty loadIssues']);
});

test('R9 self-test: a failure cached as an answer fails (R9-fail-cached)', () => {
  const v = scanPlanted(g, `
    const cache = new Map<string, unknown>();
    export function details(id: string) {
      return fetch('/d/' + id).then(r => r.json()).then(d => { cache.set(id, d); return d; }).catch(() => { cache.set(id, null); });
    }`);
  assertPlantedFails(g, v, ['R9-fail-cached details']);
});

test('R9 self-test: a failure rendered as "no results" fails (R9-fail-renders-empty)', () => {
  const v = scanPlanted(g, `
    export async function search(list: HTMLElement, JE: { t(k: string): string }) {
      try { await fetch('/search'); }
      catch { list.innerHTML = \`<p>\${JE.t('jellyseerr_no_results')}</p>\`; }
    }`);
  assertPlantedFails(g, v, ['R9-fail-renders-empty search']);
});

test('R9 self-test: failures routed to an error channel pass', () => {
  const v = scanPlanted(g, `
    const state = { items: [] as unknown[], loadError: false };
    export async function a() { try { return await fetch('/a'); } catch (e) { state.loadError = true; state.items = []; } }
    export async function b(JE: { toast(h: string): void }) { try { await fetch('/b'); } catch { JE.toast('Request failed'); return []; } }
    export async function c() { try { await fetch('/c'); } catch (e) { throw new Error('c failed'); } }
    export function d() { return fetch('/d').catch(() => ({ ok: false, items: [] })); }
    export function e() { try { return JSON.parse('[]'); } catch { return []; } }`);
  assertClean(g, v);
});
