// Stage 1 fix round 11: every write JE sends on the signed-in person's behalf goes out through one function,
// JE.core.userWrite.send(binding, transmit), which checks the session the change was made in immediately before the request
// is built (RBS1-R11-1: a save waiting in the API limiter went out with the next person's credentials; RBS1-R11-2: a home-row
// hide waiting for a Hidden Content save went out as the next person). This scan finds every raw request in the client
// (fetch, any ApiClient.ajax, ApiClient.fetch) that writes (a method or type other than GET or HEAD, or one it can't read)
// and fails unless it is sent from inside a userWrite.send call, or is listed below with the reason it isn't a person's
// write. The core fetch (JE.core.api.fetch/plugin/jf) sends every write through userWrite.send itself, once its limiter slot
// is granted and again before a retry. Runtime tests: features-user-write-session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { jsRoot } from '../helpers/harness.mjs';

/** The index of the parenthesis closing the one at `open` (strings and template literals skipped). */
function closing(source, open) {
  let depth = 0, quote = null;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === '\'' || c === '`') { quote = c; continue; }
    if (c === '/' && source[i + 1] === '/') { i = source.indexOf('\n', i); if (i < 0) return -1; continue; }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

/** The index of the brace closing the one at `open` (strings skipped). */
function closingBrace(source, open) {
  let depth = 0, quote = null;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === '\'' || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

/** The arguments of a call, split at their top-level commas. */
function topLevelArguments(text) {
  const parts = [];
  let depth = 0, quote = null, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === '\'' || c === '`') { quote = c; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts.map(part => part.trim()).filter(Boolean);
}

/**
 * Every raw request of one source that writes and isn't sent from inside a userWrite.send call. A request's options are
 * read where they are written in the call: a method/type that is a literal GET or HEAD (or none: GET) reads; any other
 * literal, or one the scan can't see (a variable, a computed value), writes.
 */
export function unboundWrites(file, source) {
  const found = [];
  const sends = [];
  for (const match of source.matchAll(/userWrite\.send\(/g)) {
    const open = match.index + match[0].length - 1;
    sends.push([open, closing(source, open)]);
  }
  // A function a userWrite.send call is handed by name (`const transmit = () => …; userWrite.send(binding, transmit, …)`).
  for (const match of source.matchAll(/const ([\w$]+) = (?:async )?(?:\([^)]*\)|[\w$]+) => /g)) {
    if (!new RegExp(`userWrite\\.send\\([^,()]+,\\s*${match[1].replace('$', '\\$')}\\b`).test(source)) continue;
    const at = match.index + match[0].length;
    const end = source[at] === '{' ? closingBrace(source, at) : source[at] === '(' ? closing(source, at) : source.indexOf(';', at);
    sends.push([at - 1, end]);
  }
  for (const match of source.matchAll(/(?<![\w.$])fetch\(|\b([\w$]+)\.ajax\(|\bApiClient\.fetch\(/g)) {
    if (match[1] === 'userWrite') continue;
    // The core transport's ajax adapter (JE.core.api.ajax, integration je12) is the core fetch: its writes go through
    // userWrite.send in coreFetch (and core-origin-scan's rule C requires their origin).
    if (match[1] === 'api' && source.slice(Math.max(0, match.index - 8), match.index).endsWith('core.')) continue;
    const open = match.index + match[0].length - 1;
    const args = topLevelArguments(source.slice(open + 1, closing(source, open)));
    const ajax = match[0] !== 'fetch(';
    const options = ajax ? args[0] : args[1];
    const key = ajax ? 'type' : 'method';
    let writes;
    if (options === undefined) writes = false;
    else if (!options.startsWith('{')) writes = true;
    else {
      const literal = new RegExp(`\\b${key}\\s*:\\s*(['"\`])(\\w+)\\1`).exec(options);
      if (literal) writes = !['GET', 'HEAD'].includes(literal[2].toUpperCase());
      else writes = new RegExp(`\\b${key}\\b`).test(options) || /\.\.\./.test(options);
    }
    if (!writes) continue;
    if (sends.some(([from, to]) => from < match.index && match.index < to)) continue;
    const line = source.slice(0, match.index).split('\n').length;
    found.push({ file, line, call: source.slice(match.index, closing(source, open) + 1).replace(/\s+/g, ' ') });
  }
  return found;
}

// Raw requests that aren't a person's write, by file and a text of the call, with the reason.
const NOT_A_PERSONS_WRITE = [
  // The core fetch's own network call: its writes reach it only through userWrite.send (fetchFn) and the per-attempt check.
  ['core/api-client.js', 'fetch(url, options)'],
  // Reads that send their list of ids in the body (no state changes on the server).
  ['arr/lists/list-grid.js', '/JellyfinEnhanced/acquire/lists/summaries'],
  ['tags/tag-pipeline.js', '/JellyfinEnhanced/tag-data/'],
  ['enhanced/itemdetails/features-details-media-info.js', '/JellyfinEnhanced/tag-data/'],
  // The live updates' long poll (a read of the person's events; ROUTE is the live route).
  ['arr/live/arr-live.js', 'fetch(ApiClient.getUrl(ROUTE)'],
  // The pause screen's item read (its one caller passes GET options).
  ['enhanced/player/pausescreen.js', 'fetch(url, options)'],
];
const allowed = entry => NOT_A_PERSONS_WRITE.some(([file, text]) => entry.file === file && entry.call.includes(text));
const shown = entry => `${entry.file}:${entry.line} ${entry.call.slice(0, 120)}`;

function sources() {
  const files = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (name !== 'locales') walk(path); } else if (name.endsWith('.js')) files.push(path);
    }
  };
  walk(jsRoot);
  return files.map(path => [relative(jsRoot, path), readFileSync(path, 'utf8')]);
}

test('R11 scan: every write on the person\'s behalf goes out through JE.core.userWrite.send', () => {
  const found = sources().flatMap(([file, source]) => unboundWrites(file, source)).filter(entry => !allowed(entry)).map(shown);
  assert.deepEqual(found, [], `writes sent outside JE.core.userWrite.send:\n${found.join('\n')}`);
});

test('R11 scan: the core fetch sends its writes through userWrite.send after the limiter, and checks again before a retry', () => {
  const api = readFileSync(join(jsRoot, 'core/api-client.js'), 'utf8');
  // Round 12: the core fetch never takes a session of its own for a write: without the origin it is handed, it is refused.
  // Integration je12: an owner-bound write (the title actions' `bound`) carries its origin in its binding's session.
  assert.match(api, /const binding = write \? \(options\.session \|\| originOfBound\(bound\)\) : null;/);
  assert.match(api, /if \(write && !binding\) return JE\.core\.userWrite\.send\(null, \(\) => Promise\.resolve\(\), url\);/);
  assert.match(api, /const fetchFn = \(\) => \(binding \? JE\.core\.userWrite\.send\(binding, sendRequest, url\) : sendRequest\(\)\);/);
  assert.match(api, /withConcurrencyLimit\(\(\) => \{[\s\S]*?return fetchFn\(\);/, 'fetchFn runs inside the limiter slot');
  assert.match(api, /if \(binding && attempt > 1 && !JE\.core\.userWrite\.isBound\(binding\)\)/);
  const queue = readFileSync(join(jsRoot, 'core/mutation-queue.js'), 'utf8');
  assert.match(queue, /return transmit\(origin\);/, 'a queue hands its write the origin it was made in');
  // Every listed exception still names a raw write (an allow-list entry that matches nothing any more is removed).
  const writes = sources().flatMap(([file, source]) => unboundWrites(file, source));
  for (const [file, text] of NOT_A_PERSONS_WRITE) {
    assert.ok(writes.some(entry => entry.file === file && entry.call.includes(text)), `${file}: ${text}`);
  }
});

test('R11 scan finds planted writes outside userWrite.send', () => {
  const plants = [
    // A document save sent with Jellyfin's ApiClient directly.
    "async function save(url, data) { await ApiClient.ajax({ type: 'PATCH', url, data }); }",
    // A home-row hide after an await, sent as whoever is signed in by then.
    "async function hide(id) { await flush(); return ApiClient.ajax({ type: 'POST', url: ApiClient.getUrl(`/JellyfinEnhanced/continue-watching/hide/${id}`) }); }",
    // A raw fetch whose method comes from its caller.
    "async function call(path, method) { return fetch(ApiClient.getUrl(path), { method, headers: JE.core.api.authHeaders() }); }",
    // Options built elsewhere.
    "function send(url, options) { return fetch(url, options); }",
    // Another client's ajax.
    "function play(ac, id) { return ac.ajax({ type: 'POST', url: ac.getUrl(`/Sessions/${id}/Playing`) }); }",
    // A send that is next to userWrite.send but outside it.
    "function both(b, r) { JE.core.userWrite.send(b, () => Promise.resolve(), 'x'); return ApiClient.ajax({ type: 'DELETE', url: r }); }",
    // A named transmit that no userWrite.send is handed.
    "async function call(p, m) { const transmit = () => fetch(p, { method: m }); return transmit(); }"
  ];
  for (const plant of plants) assert.equal(unboundWrites('plant.js', plant).length, 1, plant);
  // And the shapes it accepts.
  for (const ok of [
    "function read(u) { return ApiClient.ajax({ type: 'GET', url: u, dataType: 'json' }); }",
    "function read(u) { return fetch(u); }",
    "function head(u) { return fetch(u, { method: 'HEAD' }); }",
    "function save(b, r) { return JE.core.userWrite.send(b, () => ApiClient.ajax({ type: 'POST', url: r }), r); }",
    "function save(b, r) { return JE.core.userWrite.ajax(b, { type: 'POST', url: r }); }",
    "async function call(b, p, m) { const transmit = () => fetch(p, { method: m }); return b ? JE.core.userWrite.send(b, transmit, p) : transmit(); }"
  ]) assert.deepEqual(unboundWrites('ok.js', ok), [], ok);
});
