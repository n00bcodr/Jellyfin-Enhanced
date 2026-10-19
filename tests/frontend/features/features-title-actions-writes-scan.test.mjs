import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { jsRoot } from '../helpers/harness.mjs';

// D46 slice 2 review round 5 (shape 2): writes require a binding, enforced. Every plugin POST/PUT/DELETE/PATCH in the
// module graph the action bar reaches, and every Seerr requestMedia/requestTvSeasons call anywhere, passes `bound` (the
// core transport's operation binding; undefined natively). A function whose write forwards its caller's binding
// (`bound: options?.bound`) makes its callers sites too; a function that binds whatever its callers send
// (`{ ...options, bound: <its own> }`) covers them. The scan counts the sites per file so it cannot pass empty, and
// the planted bypasses below must each fail it. Runtime behaviour is tested in the title-actions transport and
// scopes suites; this scan finds the next bypass.

// @babel/parser ships with the istanbul-lib-instrument devDependency; resolve it through that package.
const { parse } = createRequire(createRequire(import.meta.url).resolve('istanbul-lib-instrument'))('@babel/parser');

/** The modules the action bar reaches (title actions → owners → their nested owners), and how. */
export const GRAPH = {
  'arr/actions/title-actions.js': 'the action bar: operations, admission, dispatch',
  'arr/actions/title-actions-sheet.js': 'the More sheet (the offer)',
  'arr/actions/title-actions-hosts.js': 'rows, cards, proxies, the More Info window host',
  'core/session-action.js': 'operation capture, bindings and scopes',
  'arr/ask/ask-sheet.js': 'Request: the request sheet, one-tap ask, the mount\'s Request/Search (row primary)',
  'arr/ask/ask-core.js': 'the asks, Searches and cancel the sheet and mount send',
  'arr/ask/ask-seerr.js': 'Seerr\'s Request button in JE mode (captured into the sheet)',
  'arr/manage/manage-drawer.js': 'Manage: the drawer\'s reads and writes',
  'arr/notify/notify-core.js': 'Follow (setFollow) and Remind',
  'arr/notify/notify-follow.js': 'the Follow/Remind controls a library row\'s More sheet proxies',
  'jellyseerr/api.js': 'Report (reportIssue) and Seerr requests',
  'jellyseerr/issue-reporter.js': 'the Report form',
  'jellyseerr/modal.js': 'the Seerr modal shell (Report, season, movie, collection)',
  'jellyseerr/moreinfo/more-info-modal-init.js': 'the More Info window (Request with JE requests off)',
  'jellyseerr/moreinfo/more-info-modal-actions.js': 'the window\'s request buttons and 4K popup',
  'jellyseerr/moreinfo/more-info-modal-actions-tv.js': 'the window\'s TV request buttons and 4K popups',
  'jellyseerr/moreinfo/more-info-modal-render.js': 'the window\'s content (Collection card)',
  'jellyseerr/moreinfo/more-info-modal-seasons.js': 'the window\'s seasons',
  'jellyseerr/moreinfo/more-info-modal-data.js': 'the window\'s reads',
  'jellyseerr/ui/ui-request-modals.js': 'the movie and Collection request modals (nested owners)',
  'jellyseerr/ui/ui-season-modal.js': 'the season request modal (nested owner)',
  'jellyseerr/ui/ui-quota.js': 'the quota dialog after a refused request',
  'enhanced/spoilerguard/state.js': 'Spoiler Guard writes',
  'enhanced/spoilerguard/seerr-toggle.js': 'the Guard toggle the sheet adapts',
  'enhanced/spoilerguard/detail-button.js': 'the library Guard button',
  'enhanced/spoilerguard/dialog.js': 'the Guard confirmation',
  'enhanced/hiddencontent/hidden-content-data.js': 'Hide rules (title rule writes)',
  'enhanced/hiddencontent/hidden-content-buttons.js': 'the Hide controls the sheet adapts',
  'enhanced/hiddencontent/hidden-content-dialogs.js': 'the Hide confirmation',
  'enhanced/hiddencontent/hidden-content-save.js': 'a library item\'s Hide persists through the shared save',
};

/** Write sites in the graph that stay unbound, each with its reason (anything else unbound fails). */
export const EXCLUDED = {
  'arr/notify/notify-core.js': { '/acquire/notify/read': 'the bell panel marks its own inbox read; no title action reaches it' },
  'enhanced/hiddencontent/hidden-content-save.js': {
    '*': 'the shared, debounced whole-document save: binding it to one operation would drop unrelated edits (r4 Part B exclusion); the operation is checked at the accept',
  },
};

/** Expected write sites per file (graph files and requestMedia/requestTvSeasons callers): a scan that finds fewer is broken. */
export const SITES = {
  'arr/ask/ask-core.js': 4,
  'arr/manage/manage-drawer.js': 3,
  'arr/notify/notify-core.js': 3,
  'jellyseerr/api.js': 4,
  'jellyseerr/moreinfo/more-info-modal-actions.js': 4,
  'jellyseerr/ui/ui-request-modals.js': 2,
  'jellyseerr/ui/ui-season-modal.js': 3,
  'jellyseerr/ui/ui-buttons.js': 2,
  'jellyseerr/jellyseerr.js': 2,
  'enhanced/spoilerguard/state.js': 9,
  'enhanced/hiddencontent/hidden-content-data.js': 1,
  'enhanced/hiddencontent/hidden-content-save.js': 3,
  'arr/ask/ask-sheet.js': 5,
  'arr/ask/ask-seerr.js': 1,
};

const WRITE = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
const SEERR = new Set(['requestMedia', 'requestTvSeasons']);
const keyName = p => p.key?.name ?? p.key?.value;
const calleeName = node => node.callee?.type === 'Identifier' ? node.callee.name : node.callee?.property?.name;
const objects = node => node.arguments.filter(a => a.type === 'ObjectExpression');
const hasBound = node => objects(node).some(o => o.properties.some(p => p.type !== 'SpreadElement' && keyName(p) === 'bound'));
const literals = value => value?.type === 'StringLiteral' ? [value.value.toUpperCase()]
  : value?.type === 'ConditionalExpression' ? [...literals(value.consequent), ...literals(value.alternate)] : [];
/** The write method an object argument names (method/type), if any. */
const writeMethod = node => objects(node).flatMap(o => o.properties.filter(p => p.type !== 'SpreadElement' && ['method', 'type'].includes(keyName(p))).flatMap(p => literals(p.value))).find(m => WRITE.has(m));
const firstString = node => { const a = node.arguments[0]; return a?.type === 'StringLiteral' ? a.value : a?.type === 'TemplateLiteral' ? a.quasis.map(q => q.value.raw).join('*') : ''; };

const cache = new Map();
const parsed = text => { if (!cache.has(text)) cache.set(text, parse(text, { sourceType: 'script', errorRecovery: false })); return cache.get(text); };

/** Walks with the enclosing function's name and parameters. */
function walk(node, visit, fn = null) {
  if (!node || typeof node !== 'object') return;
  let scope = fn;
  if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod'].includes(node.type))
    // A closure sees its enclosing functions' parameters (a wrapper's queued task still sends its caller's options).
    scope = { name: node.id?.name || node.jeName || fn?.name || null, params: [...node.params.flatMap(p => p.type === 'Identifier' ? [p.name] : p.type === 'AssignmentPattern' && p.left.type === 'Identifier' ? [p.left.name] : []), ...(fn?.params || [])] };
  if (node.type === 'AssignmentExpression' && node.right?.type?.includes('Function')) node.right.jeName = node.left.property?.name || node.left.name;
  if (node.type === 'VariableDeclarator' && node.init?.type?.includes('Function')) node.init.jeName = node.id.name;
  visit(node, scope);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'jeName' || !value || typeof value !== 'object') continue;
    if (Array.isArray(value)) value.forEach(v => walk(v, visit, scope)); else walk(value, visit, scope);
  }
}

/**
 * Scans `sources` ({file: text}). Returns every site ({file, line, kind, bound, excluded}) and the failures.
 * Graph files: transport-level writes and calls to their forwarders/wrappers; every file: Seerr request calls.
 */
export function scan(sources) {
  const sites = []; const failures = [];
  const forwarders = new Set(); const wrappers = new Set();
  // Graph modules, and any other module that names a Seerr request (each parse is cached by its text).
  const asts = Object.fromEntries(Object.entries(sources).filter(([file, text]) => file in GRAPH || /requestMedia|requestTvSeasons/.test(text))
    .map(([file, text]) => [file, parsed(text)]));
  // Pass 1: functions whose write forwards a caller's binding, and functions that bind whatever their callers send.
  for (const file of Object.keys(GRAPH)) {
    if (!asts[file]) continue;
    walk(asts[file], (node, fn) => {
      if (node.type !== 'CallExpression' || !fn?.name) return;
      for (const o of objects(node)) {
        const bound = o.properties.find(p => p.type !== 'SpreadElement' && keyName(p) === 'bound');
        if (!bound) continue;
        const value = bound.shorthand ? { type: 'Identifier', name: 'bound' } : bound.value;
        const fromCaller = value.type === 'Identifier' ? fn.params.includes(value.name)
          : ['MemberExpression', 'OptionalMemberExpression'].includes(value.type) && value.property?.name === 'bound' && fn.params.includes(value.object?.name);
        if (fromCaller && writeMethod(node)) forwarders.add(fn.name);
        if (!fromCaller && o.properties.some(p => p.type === 'SpreadElement' && fn.params.includes(p.argument?.name))) wrappers.add(fn.name);
      }
    });
  }
  // Pass 2: the sites.
  for (const [file, ast] of Object.entries(asts)) {
    const inGraph = file in GRAPH;
    walk(ast, (node) => {
      if (node.type !== 'CallExpression') return;
      const name = calleeName(node);
      const line = node.loc.start.line;
      if (SEERR.has(name)) {
        const ok = hasBound(node);
        sites.push({ file, line, kind: name, bound: ok });
        if (!ok) failures.push(`${file}:${line} ${name}(…) without bound`);
        return;
      }
      if (!inGraph) return;
      const method = writeMethod(node);
      const forwarded = forwarders.has(name) && !method;
      if (!method && !forwarded) return;
      // `post(path, body, bound)` takes its binding positionally.
      const ok = hasBound(node) || wrappers.has(name) || (name === 'post' && node.arguments.length >= 3 && !(node.arguments[2].type === 'Identifier' && node.arguments[2].name === 'undefined'));
      const path = firstString(node);
      const excluded = EXCLUDED[file]?.['*'] || EXCLUDED[file]?.[path];
      sites.push({ file, line, kind: method || name, path, bound: ok, excluded: !!excluded });
      if (!ok && !excluded) failures.push(`${file}:${line} ${method || name} ${path} without bound`);
    });
  }
  // Counted per file: a scan that finds fewer (or more) sites than expected has stopped seeing them.
  const counts = {};
  for (const site of sites) counts[site.file] = (counts[site.file] || 0) + 1;
  for (const [file, expected] of Object.entries(SITES)) if ((counts[file] || 0) !== expected) failures.push(`${file}: ${counts[file] || 0} write sites, expected ${expected}`);
  for (const file of Object.keys(counts)) if (!(file in SITES)) failures.push(`${file}: ${counts[file]} write sites not in the expected table`);
  return { sites, failures, forwarders, wrappers };
}

/** Every module under js/ (requestMedia/requestTvSeasons callers are checked everywhere). */
export function readSources() {
  const out = {};
  (function read(dir) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (name !== 'locales') read(path); } else if (name.endsWith('.js')) out[relative(jsRoot, path)] = readFileSync(path, 'utf8');
    }
  })(jsRoot);
  return out;
}

const SOURCES = readSources();

test('every graph module exists and parses', () => {
  for (const file of Object.keys(GRAPH)) assert.ok(SOURCES[file], `${file} is in the action bar's module graph`);
});

test('source scan: every write the action bar reaches passes its binding (counted, so it cannot pass empty)', () => {
  const { sites, failures, forwarders, wrappers } = scan(SOURCES);
  assert.deepEqual(failures, []);
  assert.ok(sites.length >= 46, `${sites.length} write sites seen`);
  assert.equal(sites.filter(s => SEERR.has(s.kind)).length, 13, 'every Seerr request call in the bundle');
  // The forwarders and wrappers the scan found are the known ones (a new one is reviewed here).
  assert.deepEqual([...forwarders].sort(), ['adminSearch', 'ask', 'cancel', 'familySearch', 'post']);
  assert.deepEqual([...wrappers].sort(), ['boundApi', 'mutateState']);
  assert.equal(sites.filter(s => s.excluded).length, 4, 'the excluded sites are exactly the listed ones');
});

/** Each planted bypass, applied to the real sources, must fail the scan with the named site. */
const PLANTED = {
  'the 4K popup\'s requestMedia without its binding': ['jellyseerr/moreinfo/more-info-modal-actions.js',
    s => s.replace("{ is4k: true }, false, data, null, { bound: JE.captureSubmitted(option).bound() })", "{ is4k: true }, false, data)"), /more-info-modal-actions\.js:\d+ requestMedia/],
  'the Collection loop\'s requestMedia without its binding': ['jellyseerr/ui/ui-request-modals.js',
    s => s.replace("searchResultItem, null, { bound });", 'searchResultItem);'), /ui-request-modals\.js:\d+ requestMedia/],
  'a requestMedia outside the graph without a binding': ['jellyseerr/jellyseerr.js',
    s => s.replace(", null, { bound: JE.captureSubmitted(button).bound() }); // Pass searchResultItem", '); // Pass searchResultItem'), /jellyseerr\.js:\d+ requestMedia/],
  'a new plugin DELETE in the action bar': ['arr/actions/title-actions-hosts.js',
    s => s.replace('function dispose() {', "function dispose() { JE.core.api.plugin('/x', { method: 'DELETE' });"), /title-actions-hosts\.js:\d+ DELETE/],
  'the drawer wrapper no longer binding its callers': ['arr/manage/manage-drawer.js',
    s => s.replace('{ ...options, bound: state.action.bound(() => current === state && (!owner || owner())) }', '{ ...options }'), /manage-drawer\.js:\d+ POST/],
  'an unbound Seerr post()': ['jellyseerr/api.js', s => s.replace("const result = await post('/issue', body, submitted.bound());", "const result = await post('/issue', body);"), /api\.js:\d+ post/],
  'the JE-mode Collection picker\'s asks without their binding': ['arr/ask/ask-seerr.js', s => s.replace('`), { bound });', '`));'), /ask-seerr\.js:\d+ ask/],
  'a Search sent without its binding': ['arr/ask/ask-sheet.js', s => s.replace('instanceId, { bound: submitted.bound() })', 'instanceId)'), /ask-sheet\.js:\d+ adminSearch/],
  'Remind without its binding': ['arr/notify/notify-core.js', s => s.replace(', bound: submitted.bound() });\n            return { ok: true, nextAt', ' });\n            return { ok: true, nextAt'), /notify-core\.js:\d+ POST \/acquire\/remind/],
  'a site the scan stops seeing (count)': ['enhanced/spoilerguard/state.js', s => s.replace(/mutateState\('\/spoiler-blur\/user-prefs'[^\n]*\n/, 'Promise.resolve()\n'), /state\.js: 8 write sites, expected 9/],
};
for (const [name, [file, plant, expected]] of Object.entries(PLANTED)) {
  test(`planted bypass fails the scan: ${name}`, () => {
    const planted = plant(SOURCES[file]);
    assert.notEqual(planted, SOURCES[file], 'the bypass was planted');
    const { failures } = scan({ ...SOURCES, [file]: planted });
    assert.ok(failures.some(f => expected.test(f)), `expected a failure matching ${expected}, got ${JSON.stringify(failures)}`);
  });
}
