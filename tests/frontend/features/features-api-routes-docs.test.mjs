import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// docs/advanced/api.md against the checked-in route inventory
// (tests/docs/production-inventory.json, kept current by
// tests/inventory/generate.py --check): its two route totals and its endpoint
// tables follow the controllers, so a new or removed route cannot leave them stale.

const inventory = JSON.parse(readFileSync(new URL('../../docs/production-inventory.json', import.meta.url), 'utf8'));
const api = readFileSync(new URL('../../../docs/advanced/api.md', import.meta.url), 'utf8');

/** A route as "VERB path" relative to /JellyfinEnhanced/, path parameters and queries blanked. */
const key = (verb, path) => `${verb} ${path.replace(/^\/?JellyfinEnhanced\//, '').replace(/\?.*$/, '').replace(/\{[^}]*\}/g, '{}').toLowerCase()}`;

const routes = new Set(inventory.routes.map(r => key(r.verb, r.path)));
const rows = new Set([...api.matchAll(/^\|\s*((?:GET|POST|PUT|DELETE|PATCH)(?:\s*[,/]\s*(?:GET|POST|PUT|DELETE|PATCH))*)\s*\|\s*`([^`]+)`/gm)]
  .flatMap(m => m[1].split(/\s*[,/]\s*/).map(verb => key(verb, m[2]))));

test('api.md states the inventory\'s route total in both places', () => {
  assert.equal(routes.size, inventory.counts.routes, 'every inventory route is a distinct method and path');
  assert.equal(Number(api.match(/covers the (\d+) method\/path entries/)[1]), routes.size);
  assert.equal(Number(api.match(/enumerate all (\d+) controller method\/path entries/)[1]), routes.size);
});

test('api.md has an endpoint table row for every route and none for a route that does not exist', () => {
  assert.deepEqual([...routes].filter(r => !rows.has(r)), [], 'routes without a row');
  assert.deepEqual([...rows].filter(r => !routes.has(r)), [], 'rows without a route');
});
