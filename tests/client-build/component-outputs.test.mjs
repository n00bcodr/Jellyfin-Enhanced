// Gate FE G's check of js/component-scripts.json and the client/entries output keys (scripts/check-component-outputs.mjs):
// restructure-base plus the approved additions, and nothing else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCheckout, componentOutputProblems, readApproved } from '../../scripts/check-component-outputs.mjs';

const SHA = 'abcaa16d21dc3a02b2f524b8b7565360c8d6878e';
const approved = readApproved({ additions: [{
  module: 'tags/new.js', after: 'tags/b.js', manifest: 'client/entries/tags.json', upstream: SHA,
  why: 'A module upstream added as a group of its own; approved for this test.',
}] });
const baseScripts = ['// a note', 'core/a.js', 'tags/b.js', 'tags/c.js'];
const baseEntries = { 'client/entries/core.json': ['js/core/a.js'], 'client/entries/tags.json': ['js/tags/b.js', 'js/tags/c.js'] };
const check = (scripts, entries = baseEntries) => componentOutputProblems({ baseScripts, scripts, baseEntries, entries, approved });
const withNew = { ...baseEntries, 'client/entries/tags.json': [...baseEntries['client/entries/tags.json'], 'js/tags/new.js'] };

test('restructure-base as it is passes, and so does an approved addition not added yet', () => {
  assert.deepEqual(check([...baseScripts]), []);
});

test('an approved addition at its place, with its output key, passes', () => {
  assert.deepEqual(check(['// a note', 'core/a.js', 'tags/b.js', 'tags/new.js', 'tags/c.js'], withNew), []);
});

test('an approved addition elsewhere, twice, or without its key fails', () => {
  assert.match(check(['// a note', 'core/a.js', 'tags/b.js', 'tags/c.js', 'tags/new.js'], withNew).join('\n'), /must come right after tags\/b\.js/);
  assert.match(check(['// a note', 'core/a.js', 'tags/b.js', 'tags/new.js', 'tags/new.js', 'tags/c.js'], withNew).join('\n'), /more than once/);
  assert.match(check(['// a note', 'core/a.js', 'tags/b.js', 'tags/new.js', 'tags/c.js']).join('\n'), /without its output key/);
  assert.match(check([...baseScripts], withNew).join('\n'), /keyed in client\/entries\/tags\.json but not in/);
  const elsewhere = { ...baseEntries, 'client/entries/core.json': ['js/core/a.js', 'js/tags/new.js'] };
  assert.match(check(['// a note', 'core/a.js', 'tags/b.js', 'tags/new.js', 'tags/c.js'], elsewhere).join('\n'), /approved for client\/entries\/tags\.json, not here/);
});

test('an addition that is not on the list fails, in the manifest and as a key', () => {
  assert.match(check(['// a note', 'core/a.js', 'tags/b.js', 'tags/other.js', 'tags/c.js']).join('\n'), /tags\/other\.js is not in restructure-base and not an approved addition/);
  assert.match(check([...baseScripts], { ...baseEntries, 'client/entries/core.json': ['js/core/a.js', 'js/core/z.js'] }).join('\n'), /js\/core\/z\.js is not in restructure-base/);
  assert.match(check([...baseScripts], { ...baseEntries, 'client/entries/more.json': ['js/x.js'] }).join('\n'), /a manifest restructure-base does not have/);
});

test('a removal, a rename, a reordering or a changed note of an existing entry fails', () => {
  assert.match(check(['// a note', 'core/a.js', 'tags/c.js']).join('\n'), /tags\/b\.js \(in restructure-base\) was removed or renamed/);
  assert.match(check(['// a note', 'core/a.js', 'tags/bb.js', 'tags/c.js']).join('\n'), /removed or renamed/);
  assert.match(check(['// a note', 'tags/b.js', 'core/a.js', 'tags/c.js']).join('\n'), /reordered/);
  assert.match(check(['// another note', 'core/a.js', 'tags/b.js', 'tags/c.js']).join('\n'), /another note.*not in restructure-base|removed or renamed/);
  assert.match(check([...baseScripts], { ...baseEntries, 'client/entries/tags.json': ['js/tags/b.js'] }).join('\n'), /js\/tags\/c\.js was removed or renamed/);
  const { 'client/entries/core.json': _core, ...without } = baseEntries;
  assert.match(check([...baseScripts], without).join('\n'), /core\.json: removed/);
});

test('the approved list must say which upstream commit and why', () => {
  const entry = { module: 'x.js', after: 'y.js', manifest: 'client/entries/x.json', upstream: SHA, why: 'A module upstream added as a group of its own; approved.' };
  assert.equal(readApproved({ additions: [entry] }).length, 1);
  assert.throws(() => readApproved({ additions: [{ ...entry, upstream: 'abcaa16d' }] }), /full 40-character/);
  assert.throws(() => readApproved({ additions: [{ ...entry, why: 'because' }] }), /why/);
  assert.throws(() => readApproved({ additions: [{ ...entry, manifest: 'elsewhere.json' }] }), /manifest/);
  assert.throws(() => readApproved({ additions: [entry, entry] }), /listed twice/);
  assert.throws(() => readApproved({}), /additions/);
});

test('this checkout passes against restructure-base', () => {
  const { problems } = checkCheckout(new URL('../..', import.meta.url).pathname);
  assert.deepEqual(problems, []);
});
