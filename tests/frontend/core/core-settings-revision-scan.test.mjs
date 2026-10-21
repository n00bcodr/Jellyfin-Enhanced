// Stage 1 fix round 9: two source scans, each checked against planted violations (a scan that finds nothing in a plant
// proves nothing). Runtime tests of the same rules: bootstrap-settings-pending, pages-config-pending,
// ApiUserDocumentRevisionTests.
//  3. Every change source advances the revision: wherever a page takes what the server holds (a read, a save's answer,
//     another route's write it acknowledges), that step moves the document's revision on, and a read is taken only if
//     the revision is still the one it began with.
//  4. Every whole-document writer is fenced: every server route that replaces a per-user document whole checks the
//     revision the writer read, under the document's lock (UserConfigurationManager.ReplaceUserDocument / SaveUserSettings);
//     no route or service writes a per-user document whole any other way, except the listed ones (with their reason).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { jsRoot } from '../helpers/harness.mjs';
import { repositoryRoot } from '../helpers/discovery.mjs';
import { configPageParts } from '../helpers/config-page.mjs';

const { parse } = createRequire(createRequire(import.meta.url).resolve('istanbul-lib-instrument'))('@babel/parser');
const read = path => readFileSync(resolve(jsRoot, path), 'utf8');
const ast = source => parse(source, { sourceType: 'script', allowReturnOutsideFunction: true, errorRecovery: true });

function walk(node, visit, ancestors = []) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, ancestors);
  const next = [...ancestors, node];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra') continue;
    if (Array.isArray(value)) value.forEach(child => walk(child, visit, next));
    else if (value && typeof value.type === 'string') walk(value, visit, next);
  }
}
const isFunction = node => /Function/.test(node.type) || node.type === 'ObjectMethod' || node.type === 'ClassMethod';
function functionName(fn, parent) {
  if (fn.id?.name) return fn.id.name;
  if (parent?.type === 'VariableDeclarator') return parent.id.name;
  if (parent?.type === 'ObjectProperty' || parent?.type === 'ObjectMethod') return parent.key.name || parent.key.value;
  if (parent?.type === 'AssignmentExpression') {
    const left = parent.left;
    return left.type === 'MemberExpression' ? (left.property.name || left.property.value) : left.name;
  }
  return '(anonymous)';
}
function enclosingName(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (!isFunction(ancestors[i])) continue;
    const name = functionName(ancestors[i], ancestors[i - 1]);
    if (name !== '(anonymous)') return { name, fn: ancestors[i] };
  }
  return { name: '(top level)', fn: null };
}
const memberPath = node => node.type === 'Identifier' ? node.name
  : node.type === 'MemberExpression' && !node.computed ? `${memberPath(node.object)}.${node.property.name}` : node.type === 'MemberExpression' ? `${memberPath(node.object)}[]` : '?';
const text = (source, node) => source.slice(node.start, node.end);
/** Whether `node` sits in the consequent of an if whose test mentions `word` (or in code after `if (!…word…) return`). */
const guardedBy = (source, word) => (node, ancestors) => ancestors.some((a, i) => a.type === 'IfStatement' && ancestors[i + 1] === a.consequent && text(source, a.test).includes(word));
const isClear = value => value?.type === 'NullLiteral' || (value?.type === 'ObjectExpression' && value.properties.length === 0)
  || (value?.type === 'ArrayExpression' && value.elements.length === 0);
/** Every function body (by name) in the source, and every assignment (target path, value, enclosing name, ancestors). */
function shape(source) {
  const functions = new Map();
  const assignments = [];
  const calls = [];
  walk(ast(source), (node, ancestors) => {
    if (isFunction(node)) {
      const name = functionName(node, ancestors.at(-1));
      if (name !== '(anonymous)' && !functions.has(name)) functions.set(name, node);
    }
    if (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression') {
      const target = memberPath(node.type === 'AssignmentExpression' ? node.left : node.argument);
      assignments.push({ node, target, value: node.right, ancestors, ...enclosingName(ancestors) });
    }
    if (node.type === 'CallExpression') calls.push({ node, callee: memberPath(node.callee), ancestors, ...enclosingName(ancestors) });
  });
  return { functions, assignments, calls };
}
const bumps = (source, fn, counter) => {
  let found = false;
  walk(fn?.body, inner => {
    if (inner.type === 'UpdateExpression' && memberPath(inner.argument) === counter) found = true;
    if (inner.type === 'AssignmentExpression' && memberPath(inner.left) === counter && inner.operator === '+=') found = true;
  });
  return found;
};

// ---- Scan 3: every change source advances the revision ----

/** The settings store (config.js): one helper takes a document; it moves the revision on; reads are fenced. */
function storeViolations(source) {
  const found = [];
  const { functions, assignments, calls } = shape(source);
  const take = functions.get('takeDocument');
  if (!take) return ['takeDocument is missing'];
  if (!bumps(source, take, 'state.revision')) found.push('takeDocument does not move the revision on');
  for (const a of assignments) {
    if (!/\.(persisted|readOk)$/.test(a.target) || a.name === 'takeDocument') continue;
    found.push(`${a.target} assigned in ${a.name} without takeDocument (the revision stays)`);
  }
  // A queued operation is the other revision step (its answer is taken through takeDocument).
  for (const a of assignments) {
    if (a.target === 'state.revision' && !['takeDocument', 'queueOperation'].includes(a.name)) found.push(`state.revision moved in ${a.name}`);
  }
  // What each caller hands takeDocument: a read only behind the revision check it took before the request (and, round 10,
  // never older than the document held, in the server's order).
  const READS = { readUserSettings: 'revision === state.revision', noteSettingsRead: 'revision !== state.revision' };
  for (const c of calls.filter(c => c.callee === 'takeDocument')) {
    if (READS[c.name]) {
      const ok = c.name === 'noteSettingsRead'
        ? text(source, c.fn.body).indexOf(READS[c.name]) !== -1 && text(source, c.fn.body).indexOf(READS[c.name]) < c.node.start - c.fn.body.start
        : guardedBy(source, READS[c.name])(c.node, c.ancestors) && (c.name !== 'readUserSettings' || guardedBy(source, 'newerRevision(')(c.node, c.ancestors));
      if (!ok) found.push(`takeDocument in ${c.name}: a read taken without the revision check`);
    } else if (!['adoptBootDocuments', 'acknowledgeUserDocumentChange', 'settleAnswer'].includes(c.name)) {
      found.push(`takeDocument called from ${c.name}`);
    }
  }
  // Round 10: a userConfig object's documents are adopted as it is assigned, in the server's order (newerRevision), or
  // without revisions only while only boot documents were taken.
  const rebase = calls.find(c => c.callee === 'takeDocument' && c.name === 'adoptBootDocuments');
  const adopt = functions.get('adoptBootDocuments');
  if (!rebase || !guardedBy(source, 'take')(rebase.node, rebase.ancestors) || !adopt
    || !/state\.revision === state\.bootRevision/.test(text(source, adopt.body)) || !/newerRevision\(/.test(text(source, adopt.body))) {
    found.push('a boot document taken over a newer read or answer');
  }
  if (!/set: value => \{[^}]*adoptBootDocuments\(\)/.test(source)) found.push('a new userConfig object is not adopted as it is assigned');
  // Round 10: an operation's answer is taken whole only when nothing came from outside since it was sent, or when it is
  // newer in the server's order; otherwise its operation is applied to the document held.
  const settle = functions.get('settleAnswer');
  if (!settle || !/state\.outsideTakes === entry\.outsideAt/.test(text(source, settle.body)) || !/newerRevision\(/.test(text(source, settle.body))) {
    found.push('an answer taken whole whatever reached the store since it was sent');
  }
  // Every revision step a module of the store's documents makes outside it: the home-row hide's answer is acknowledged.
  return found;
}

/**
 * Spoiler Guard's preferences (round 10): saves go out on the preferences' one session queue (its revision moves on with
 * each save queued and answered); the state read takes Prefs only behind that revision.
 */
function spoilerViolations(source) {
  const found = [];
  const { functions, assignments, calls } = shape(source);
  for (const a of assignments.filter(a => a.target === 'userPrefs' && !isClear(a.value))) {
    if (a.name === 'stateRead') {
      if (!guardedBy(source, 'prefsQueue.revision')(a.node, a.ancestors)) found.push('the state read takes Prefs without the revision check');
    } else if (a.name !== 'acknowledged') found.push(`userPrefs assigned in ${a.name}`);
  }
  if (!/const prefsQueue = JE\.core\.mutationQueue\(/.test(source)) found.push('the preferences have no session queue');
  const sends = calls.filter(c => c.callee === 'request' && c.name === 'setUserPrefs');
  if (!sends.length || sends.some(c => !c.ancestors.some(a => a.type === 'CallExpression' && memberPath(a.callee) === 'prefsQueue.send'))) {
    found.push('a preference save sent outside the session queue');
  }
  if (!functions.get('setUserPrefs')) found.push('setUserPrefs is missing');
  return found;
}

/** Notification preferences (round 10): every change goes out on the person's session queue; a read is taken only behind it. */
function notifyViolations(source) {
  const found = [];
  const { functions, calls } = shape(source);
  if (!/const prefsQueue = JE\.core\.mutationQueue\(/.test(source)) found.push('the notification preferences have no session queue');
  const sends = calls.filter(c => c.callee === 'api' && c.name === 'prefsCall');
  if (!sends.length || sends.some(c => !c.ancestors.some(a => a.type === 'CallExpression' && memberPath(a.callee) === 'prefsQueue.send'))) {
    found.push('a preference change sent outside the session queue');
  }
  const apply = calls.find(c => c.callee === 'applyPrefs' && c.name === 'loadPrefs');
  if (!apply || !guardedBy(source, 'prefsQueue.revision')(apply.node, apply.ancestors)) found.push('a preference read taken whatever changed meanwhile');
  if (!functions.get('prefsCall')) found.push('prefsCall is missing');
  return found;
}

/** The configuration page: every function that takes what the server holds moves _jeConfigRevision on; reads are fenced. */
function pageViolations(source) {
  const found = [];
  const { functions, assignments, calls } = shape(source);
  const takers = new Set(assignments.filter(a => /^_jeBase(\.|\[|$)|^_jeSent(\.|\[|$)/.test(a.target) && !isClear(a.value)).map(a => a.name));
  for (const name of takers) {
    if (!bumps(source, functions.get(name), '_jeConfigRevision')) found.push(`${name} takes what the server holds without moving the revision on`);
  }
  // A configuration read is drawn only while the revision is the one it began with and no save is out (round 10: a dropped
  // read is read again after the saves; a save moves the revision on as it begins and as it ends, whatever its outcome).
  for (const c of calls.filter(c => /getPluginConfiguration$/.test(c.callee))) {
    if (c.name === 'loadConfig') {
      const then = c.ancestors.at(-2)?.type === 'CallExpression' ? c.ancestors.at(-2).arguments[0] : null;
      if (!then || !text(source, then).includes('revision !== _jeConfigRevision') || !text(source, then).includes('jeSaveOutstanding()')) found.push('loadConfig draws a read without the revision check');
      if (!then || !text(source, then).includes('_jeRefreshWanted = true')) found.push('a read dropped for overlapping a save is not read again');
      if (!then || !text(source, then).includes('jeKeepUnsaved(')) found.push('a refresh draws over the administrator\'s unsaved changes');
    } else if (c.name === 'jeRedrawSavedFields') {
      if (!text(source, c.fn.body).includes('revision !== _jeConfigRevision')) found.push('the post-save redraw draws a read without the revision check');
    } else if (!['persistCustomTabsOwnedFlags', 'jeConfigReadRetry'].includes(c.name) && takers.has(c.name)) {
      found.push(`${c.name} reads the configuration and takes it`);
    }
  }
  // The save's request is bracketed: the revision moves on in the finally of the try that awaits it (a failed save too).
  let bracketed = false;
  walk(functions.get('jeSaveNow')?.body, inner => {
    if (inner.type === 'TryStatement' && inner.finalizer && text(source, inner.block).includes('jePatchConfiguration(')
      && text(source, inner.finalizer).includes('_jeConfigRevision++')) bracketed = true;
  });
  if (!bracketed) found.push('a save (or a failed one) does not move the revision on when it ends');
  if (!/addEventListener\('beforeunload'[\s\S]{0,200}jeSaveOutstanding\(\)/.test(source)) found.push('leaving the page does not warn while a save is out');
  return found;
}

const pageSource = () => configPageParts().scripts.join('\n;\n');
const CHANGE_SOURCES = [
  ['enhanced/config.js', () => read('enhanced/config.js'), storeViolations],
  ['enhanced/spoilerguard/state.js', () => read('enhanced/spoilerguard/state.js'), spoilerViolations],
  ['arr/notify/notify-core.js', () => read('arr/notify/notify-core.js'), notifyViolations],
  ['configPage.html', pageSource, pageViolations]
];

test('scan 3: every change source advances the revision, and reads are taken only behind it', () => {
  for (const [name, source, violations] of CHANGE_SOURCES) assert.deepEqual(violations(source()), [], name);
  // The acknowledged external write (the home-row hide) goes through the store's acknowledgement.
  assert.match(read('enhanced/hiddencontent/hidden-content-data.js'), /JE\.internals\.acknowledgeUserDocumentChange\('hidden-content\.json'/);
});

const replace = (source, anchor, line) => {
  assert.ok(source.includes(anchor), `plant anchor missing: ${anchor}`);
  return source.replace(anchor, line);
};
const CHANGE_PLANTS = [
  ['store: an acknowledged write taken without the revision (the R9-3 shape)', 'enhanced/config.js',
    "takeDocument(state, applyOperation(fileName, previousPersisted, copyDocument(operation)), true, typeof serverRevision === 'string' ? serverRevision : undefined);",
    'state.persisted = applyOperation(fileName, previousPersisted, copyDocument(operation));'],
  ['store: the helper no longer moves the revision on', 'enhanced/config.js', '        state.revision++;\n        if (outside) state.outsideTakes++;', '        if (outside) state.outsideTakes++;'],
  ['store: a read taken whatever changed meanwhile', 'enhanced/config.js',
    'if (read && !hadPending && !state.pending.length && revision === state.revision && readRevision === state.readRevision',
    'if (read'],
  ['store: a read older than the document held taken (server order)', 'enhanced/config.js',
    '            && newerRevision(state.serverRevision, readServerRevision) !== true) {', '            ) {'],
  ['store: a boot document taken over a newer answer', 'enhanced/config.js',
    'const take = order === undefined ? state.revision === state.bootRevision : order;', 'const take = true;'],
  ['store: a new userConfig object adopted only when looked at (the R10-6 shape)', 'enhanced/config.js',
    'set: value => { recordRead(value); userConfig = value; adoptBootDocuments(); }', 'set: value => { recordRead(value); userConfig = value; }'],
  ['store: a late answer taken whole over an acknowledged write (the R10-5 shape)', 'enhanced/config.js',
    '(state.outsideTakes === entry.outsideAt || order === true)', 'true'],
  ['Spoiler Guard: the state read takes Prefs whatever changed meanwhile', 'enhanced/spoilerguard/state.js',
    'if (readRevision === prefsQueue.revision && !prefsQueue.pending && !pendingPrefs.length) userPrefs = value.Prefs || {};', 'userPrefs = value.Prefs || {};'],
  ['Spoiler Guard: a save sent outside the session queue (the R10-1 shape)', 'enhanced/spoilerguard/state.js',
    "const save = prefsQueue.send(() => request('/spoiler-blur/user-prefs', { method: 'PATCH', body: { Set: set }, skipRetry: true }));",
    "const save = request('/spoiler-blur/user-prefs', { method: 'PATCH', body: { Set: set }, skipRetry: true });"],
  ['notifications: a change sent outside the session queue (the R10-8 shape)', 'arr/notify/notify-core.js',
    'const res = await prefsQueue.send(() => api(path, { method, body }));', 'const res = await api(path, { method, body });'],
  ['notifications: a read taken whatever changed meanwhile', 'arr/notify/notify-core.js',
    'if (revision === prefsQueue.revision && !prefsQueue.pending) applyPrefs(body);', 'applyPrefs(body);'],
  ['page: a value the server holds taken without moving the revision on', 'configPage.html',
    '            if (_jeSent) _jeSent[field] = value;\n            _jeConfigRevision++;', '            if (_jeSent) _jeSent[field] = value;'],
  ['page: a configuration read drawn whatever changed meanwhile', 'configPage.html',
    'if (_jeConfigReadOk && (revision !== _jeConfigRevision || jeSaveOutstanding())) {', 'if (false) {'],
  ['page: a failed save does not move the revision on (the R10-7 shape)', 'configPage.html',
    '                    _jeInFlight = null;\n                    _jeConfigRevision++;', '                    _jeInFlight = null;'],
  ['page: a dropped refresh is not read again (the R10-12 shape)', 'configPage.html', '                    _jeRefreshWanted = true;\n', ''],
  ['page: a refresh draws over unsaved changes', 'configPage.html', 'const kept = _jeConfigReadOk ? jeKeepUnsaved(read) : null;', 'const kept = null;'],
  ['page: leaving does not warn while a save is out (the R10-11 shape)', 'configPage.html',
    "if (!jeSaveOutstanding() && !(saveDock && saveDock.classList.contains('je-dirty'))) return;", "if (!(saveDock && saveDock.classList.contains('je-dirty'))) return;"],
  ['page: the post-save redraw drawn whatever changed meanwhile', 'configPage.html',
    'if (revision !== _jeConfigRevision) return;', '']
];
for (const [label, name, anchor, line] of CHANGE_PLANTS) {
  test(`scan 3 finds a plant: ${label}`, () => {
    const [, source, violations] = CHANGE_SOURCES.find(([n]) => n === name);
    assert.deepEqual(violations(source()), [], 'the real source is clean');
    assert.ok(violations(replace(source(), anchor, line)).length > 0, 'the plant is reported');
  });
}

// ---- Scan 4: every whole-document writer is fenced (server) ----

const serverRoot = resolve(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced');
function csFiles(folder = serverRoot) {
  const files = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory() && !['bin', 'obj', 'js', 'Configuration-docs'].includes(entry.name)) files.push(...csFiles(path));
    else if (entry.name.endsWith('.cs')) files.push([path.slice(serverRoot.length + 1), readFileSync(path, 'utf8')]);
  }
  return files;
}
/** The body of the member that starts at `index` (from its first "{" to the matching "}"). */
function bodyAt(source, index) {
  const open = source.indexOf('{', index);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1);
  }
  return source.slice(open);
}
/** Every route method: [file, verb, template, name, body]. */
function routes(files) {
  const out = [];
  for (const [file, source] of files) {
    for (const m of source.matchAll(/\[Http(Get|Post|Put|Patch|Delete)\("([^"]*)"\)\]/g)) {
      const signature = /public\s+(?:async\s+)?[\w<>?,\s]+?\s(\w+)\s*\(/.exec(source.slice(m.index));
      out.push([file, m[1].toUpperCase(), m[2], signature?.[1], bodyAt(source, m.index + (signature?.index ?? 0))]);
    }
  }
  return out;
}
// A per-user document's route (the whole document, not an item route such as bookmark.json/add).
const DOCUMENT_ROUTE = /^(user-settings\/\{userId\}\/[a-z-]+\.json|spoiler-blur\/user-prefs)$/;
// The gates: a whole replacement compares the revision sent (RequestedRevision) under the file lock.
const FENCED = body => /FencedReplace\(|SaveUserSettings\([^;]*RequestedRevision\(\)/.test(body)
  || (/RequestedRevision\(\)/.test(body) && /IfMatchAllows\(/.test(body) && /RmwUser(Configuration|Document)/.test(body));
// An operation route changes only what it names, under the file lock.
const OPERATION = body => /PatchUserDocument<|RmwUser(Configuration|Document)|PatchUserSettings(Revision)?\(|SetPersonalConsent\(/.test(body);

// Writers of a per-user document outside the routes, each with why it needs no revision.
const SERVICE_WRITERS = {
  'Configuration/UserConfigurationManager.cs': {
    SaveUserSettings: 'the settings gate: compares the revision sent (IfMatchAllows) under the settings lock',
    SetPersonalConsent: 'an operation (one consent) under the settings lock',
    PatchUserSettingsRevision: 'an operation (fields) under the settings lock',
    SeedUserSettings: 'writes only while the person has no settings (under the lock)',
    ResetUserSettings: 'the administrator\'s explicit "reset all users" (confirmed), under the lock',
    RmwUserDocument: 'the operation helper: read, change and save under the file lock',
    ReplaceUserDocument: 'the whole-document gate: compares the revision sent under the file lock',
    SaveProcessedWatchlistItems: 'server-owned watchlist bookkeeping; no client reads or writes it'
  },
  'Services/Acquire/Users/AdminUserSettingsService.cs': {
    Patch: 'Dashboard user pages: per-group revision (revision_conflict) under the settings lock'
  }
};
/** Where a whole save of a per-user document sits: [file, enclosing member]. */
function serviceWriters(files) {
  const found = [];
  for (const [file, source] of files) {
    for (const m of source.matchAll(/\bSaveUserConfiguration\(/g)) {
      if (/public void SaveUserConfiguration\($/.test(source.slice(Math.max(0, m.index - 30), m.index + 22))) continue;
      const before = source.slice(0, m.index);
      const member = [...before.matchAll(/(?:public|private|internal)\s+(?:static\s+)?(?:async\s+)?[\w<>()?,\s]+?\s(\w+)(?:<\w+>)?\s*\(/g)].at(-1)?.[1];
      found.push([file, member]);
    }
  }
  return found;
}

function fenceViolations(files) {
  const found = [];
  const all = routes(files);
  for (const [file, verb, template, name, body] of all) {
    if (!DOCUMENT_ROUTE.test(template) || verb === 'GET' || verb === 'DELETE') continue;
    if (verb === 'PATCH') {
      if (!OPERATION(body)) found.push(`${file} ${verb} ${template} (${name}) is not an operation under the lock`);
    } else if (!FENCED(body)) found.push(`${file} ${verb} ${template} (${name}) replaces a document without the revision check`);
  }
  // Every read route of a document hands its revision out.
  for (const [file, verb, template, name, body] of all) {
    if (verb === 'GET' && DOCUMENT_ROUTE.test(template) && !/AnswerRevision\(|DocumentAnswer\(/.test(body)) found.push(`${file} GET ${template} (${name}) hands out no revision`);
  }
  for (const [file, member] of serviceWriters(files)) {
    if (!SERVICE_WRITERS[file]?.[member]) found.push(`${file}: ${member} writes a per-user document whole`);
  }
  // Notification preferences change under the person's lock (UpdatePrefs), never read and stored apart.
  for (const [file, source] of files) {
    if (file.startsWith('Controllers/') && /Store\.SavePrefs\(/.test(source)) found.push(`${file} stores notification preferences outside UpdatePrefs`);
  }
  return found;
}

test('scan 4: every server route that replaces a per-user document whole checks the revision the writer read', () => {
  const files = csFiles();
  const documentRoutes = routes(files).filter(([, verb, template]) => DOCUMENT_ROUTE.test(template) && (verb === 'POST' || verb === 'PUT'));
  assert.ok(documentRoutes.length >= 8, documentRoutes.map(r => r[2]).join());
  assert.deepEqual(fenceViolations(files), []);
});

const CONTROLLER = 'Controllers/JellyfinEnhancedController.cs';
const FENCE_PLANTS = [
  ['the old Hidden Content POST (the R9-2 shape)', CONTROLLER,
    'var refused = FencedReplace(authorizedUserId, "hidden-content.json", userConfiguration, out var outcome);',
    '_userConfigurationManager.SaveUserConfiguration(authorizedUserId, "hidden-content.json", userConfiguration); IActionResult? refused = null; var outcome = UserConfigurationManager.DocumentWrite.Saved;'],
  ['a whole-preferences POST without the check', CONTROLLER,
    ': !UserConfigurationManager.IfMatchAllows(expected, current))', ': false)'],
  ['a settings POST that sends no revision to the gate', CONTROLLER,
    'SaveUserSettings(authorizedUserId, userConfiguration, RequestedRevision());', 'SaveUserSettings(authorizedUserId, userConfiguration);'],
  ['a read route that hands out no revision', CONTROLLER,
    'return DocumentAnswer(triggers, revision);', 'return Ok(triggers);'],
  ['a new service writing a document whole', 'Configuration/UserConfigurationManager.cs',
    'public static bool IfMatchAllows(string? ifMatch, string current)',
    'public void ImportDocument(string userId, string fileName, object doc) { SaveUserConfiguration(userId, fileName, doc); }\n        public static bool IfMatchAllows(string? ifMatch, string current)'],
  ['notification preferences stored apart from their read', 'Controllers/NotifyController.cs',
    'Store.ClearEmailCode(user);', 'Store.ClearEmailCode(user); Store.SavePrefs(user, Store.Prefs(user), now);']
];
for (const [label, name, anchor, line] of FENCE_PLANTS) {
  test(`scan 4 finds a plant: ${label}`, () => {
    const files = csFiles();
    assert.deepEqual(fenceViolations(files), [], 'the real source is clean');
    const planted = files.map(([n, source]) => [n, n === name ? replace(source, anchor, line) : source]);
    assert.ok(fenceViolations(planted).length > 0, 'the plant is reported');
  });
}
