// Stage 1 fix round 8: two source scans over every client writer of a per-user document or of JE's own configuration,
// each checked against planted violations (a scan that finds nothing in a plant proves nothing).
//  1. Baseline = server-acknowledged state: every assignment of what a save compares against sits in a read or an
//     acknowledgement handler (and, where the handler also runs on failure, behind its success).
//  2. No whole-document writer: no client sends a whole per-user document or JE's whole configuration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { jsRoot } from '../helpers/harness.mjs';
import { configPagePath, configPageParts } from '../helpers/config-page.mjs';

// @babel/parser ships with the istanbul-lib-instrument devDependency; resolve it through that package.
const { parse } = createRequire(createRequire(import.meta.url).resolve('istanbul-lib-instrument'))('@babel/parser');
const read = path => readFileSync(resolve(jsRoot, path), 'utf8');
const ast = source => parse(source, { sourceType: 'script', allowReturnOutsideFunction: true, errorRecovery: true });

/** Calls `visit(node, ancestors)` for every node. */
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
/** The name of a function node: its own, or the variable, property or assignment it is the value of. */
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
/** The nearest named enclosing function (anonymous callbacks are looked through). */
function enclosingName(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (!isFunction(ancestors[i])) continue;
    const name = functionName(ancestors[i], ancestors[i - 1]);
    if (name !== '(anonymous)') return { name, fn: ancestors[i] };
  }
  return { name: '(top level)', fn: null };
}
const rootName = node => node.type === 'Identifier' ? node.name : node.type === 'MemberExpression' ? rootName(node.object) : null;
const memberPath = node => node.type === 'Identifier' ? node.name
  : node.type === 'MemberExpression' && !node.computed ? `${memberPath(node.object)}.${node.property.name}` : node.type === 'MemberExpression' ? `${memberPath(node.object)}[]` : '?';

/**
 * Every assignment to a tracked baseline, with the rule it breaks (none: allowed).
 * `rules`: [{ target(path) → bool, allowed: { functionName: check(assignment, ancestors, fn) → true | reason } }]
 */
function baselineViolations(source, rules) {
  const found = [];
  walk(ast(source), (node, ancestors) => {
    let target, value;
    if (node.type === 'AssignmentExpression') { target = memberPath(node.left); value = node.right; }
    else if (node.type === 'ObjectProperty' && ancestors.at(-1)?.type === 'ObjectExpression'
      && ((ancestors.at(-2)?.type === 'VariableDeclarator' && ancestors.at(-2).id.name === 'state')
        || (ancestors.at(-2)?.type === 'AssignmentExpression' && memberPath(ancestors.at(-2).left) === 'state'))) { target = `state.${node.key.name}`; value = node.value; }
    // What the store takes as a document's boot read: the object bootDocument hands back.
    else if (node.type === 'ObjectProperty' && node.key.name === 'persisted' && enclosingName(ancestors).name === 'bootDocument') { target = 'boot.persisted'; value = node.value; }
    // Round 9: a document handed to the store's one taking helper.
    else if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'takeDocument') { target = 'takeDocument()'; value = node.arguments[1]; }
    // Round 10: an operation's answer taken (in the server's order) by settleAnswer.
    else if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'settleAnswer') { target = 'settleAnswer()'; value = node.arguments[1]; }
    else return;
    for (const rule of rules) {
      if (!rule.target(target)) continue;
      const { name, fn } = enclosingName(ancestors);
      const check = rule.allowed[name] || rule.allowed['*'];
      const verdict = check ? check(node, ancestors, fn, value) : `assigned in ${name}, not a read or acknowledgement handler`;
      if (verdict !== true) found.push(`${target} in ${name}: ${verdict}`);
    }
  });
  return found;
}

const ok = () => true;
const calls = (value, callee) => value?.type === 'CallExpression' && memberPath(value.callee).split('.').at(-1) === callee;
const insideIf = test => (node, ancestors) => ancestors.some(a => a.type === 'IfStatement' && test(a.test)) || 'not behind the success check';
const afterAwait = callee => (node, ancestors, fn) => {
  let awaited = false;
  walk(fn.body, inner => { if (inner.type === 'AwaitExpression' && inner.start < node.start && JSON.stringify(memberPath(inner.argument?.callee || {})).includes(callee)) awaited = true; });
  return awaited || `before the answer of ${callee}`;
};
const either = (...checks) => (...args) => checks.map(check => check(...args)).find(v => v === true) ?? checks[0](...args);
const clears = (node, ancestors, fn, value) => (value?.type === 'NullLiteral' || (value?.type === 'ObjectExpression' && value.properties.length === 0)) || 'not a reset';

// The baselines: what each writer compares an edit against.
/** A value destructured, in the same function, from the boot read's record (bootDocument). */
const fromBootRecord = (node, ancestors, fn, value) => {
  if (value?.type !== 'Identifier') return 'not from the boot read record';
  let bound = false;
  walk(fn.body, inner => {
    if (inner.type === 'VariableDeclarator' && calls(inner.init, 'bootDocument') && inner.id.type === 'ObjectPattern'
      && inner.id.properties.some(p => p.value?.name === value.name)) bound = true;
  });
  return bound || 'not from the boot read record';
};
/** A member of a value bound, in the same function, to bootDocument's answer (`const boot = bootDocument(...)`; boot.persisted). */
const fromBootObject = (node, ancestors, fn, value) => {
  if (value?.type !== 'MemberExpression' || value.object.type !== 'Identifier') return 'not from the boot read record';
  let bound = false;
  walk(fn.body, inner => {
    if (inner.type === 'VariableDeclarator' && calls(inner.init, 'bootDocument') && inner.id.type === 'Identifier' && inner.id.name === value.object.name) bound = true;
  });
  return bound || 'not from the boot read record';
};
/** The boot document comes from the read record (readRecords), never from the page's userConfig object as it is now. */
const fromReadRecord = (node, ancestors, fn, value) => {
  let record = false, view = false;
  walk(value, inner => {
    if (inner.type === 'Identifier' && inner.name === 'record') record = true;
    if (inner.type === 'Identifier' && inner.name === 'own') view = true;
    if (inner.type === 'MemberExpression' && /userConfig/.test(memberPath(inner))) view = true;
  });
  return (record && !view) || 'not from the read record';
};
const STORE_RULES = [{
  target: path => path === 'boot.persisted',
  allowed: { bootDocument: fromReadRecord }
}, {
  target: path => path !== 'boot.persisted' && (path.endsWith('.persisted') || path.endsWith('.readOk')),
  allowed: {
    // The boot read's record (plugin.js), never the page's object as modules changed it.
    settingsDocument: fromBootRecord,
    // Round 9: the one helper every change source takes a document through (it moves the revision on); what each caller
    // hands it is checked below (takeDocument calls) and by core-settings-revision-scan.
    takeDocument: ok
  }
}, {
  target: path => path === 'takeDocument()',
  allowed: {
    // Round 10: a userConfig object's documents are adopted as it is assigned (adoptBootDocuments), from its read record.
    adoptBootDocuments: fromBootObject,
    readUserSettings: insideIf(test => JSON.stringify(test).includes('"read"')),
    noteSettingsRead: ok,
    acknowledgeUserDocumentChange: ok,
    // Round 10: an operation's answer, in the server's order; settleAnswer itself runs only behind the success (below).
    settleAnswer: ok
  }
}, {
  target: path => path === 'settleAnswer()',
  allowed: { queueOperation: insideIf(test => test.type === 'Identifier' && test.name === 'succeeded') }
}];
const PAGE_RULES = [{
  target: path => /^_jeBase(\.|\[|$)/.test(path) || /^_jeSent(\.|\[|$)/.test(path),
  allowed: {
    jeConfigRead: ok,
    jeAcceptStored: ok,
    jeSaveNow: afterAwait('jePatchConfiguration'),
    jeRedrawSavedFields: afterAwait('getPluginConfiguration'),
    // Round 10: a refresh keeps the baselines the page held for the fields the administrator hasn't saved.
    keepBaselines: (node, ancestors, fn, value) => (value?.type === 'MemberExpression' && ['base', 'sent'].includes(value.object.name)) || 'not the baseline the page held',
    '*': clears
  }
}, {
  // An asynchronously filled field's stored value: from a read (setStored) or a save's answer (saved).
  target: path => path === 'f.stored',
  allowed: { setStored: ok, saved: ok }
}];
const ELSEWHERE_RULES = [{ target: path => /^dialogShown(\.|\[)/.test(path), allowed: { acknowledged: ok } }];
const SPOILER_RULES = [{ target: path => path === 'userPrefs', allowed: { stateRead: ok, acknowledged: ok, '*': clears } }];
const HIDDEN_RULES = [{ target: path => path === 'hiddenData', allowed: { getHiddenData: (n, a, f, v) => calls(v, 'withParts') || 'not the store\'s document', followStore: (n, a, f, v) => calls(v, 'withParts') || 'not the store\'s document', '*': clears } }];

const pageSource = () => configPageParts().scripts.join('\n;\n');
const SOURCES = [
  ['enhanced/config.js', () => read('enhanced/config.js'), STORE_RULES],
  ['configPage.html', pageSource, PAGE_RULES],
  ['elsewhere/elsewhere.js', () => read('elsewhere/elsewhere.js'), ELSEWHERE_RULES],
  ['enhanced/spoilerguard/state.js', () => read('enhanced/spoilerguard/state.js'), SPOILER_RULES],
  ['enhanced/hiddencontent/hidden-content-data.js', () => read('enhanced/hiddencontent/hidden-content-data.js'), HIDDEN_RULES]
];

test('scan 1: every baseline assignment sits in a read or acknowledgement handler', () => {
  for (const [name, source, rules] of SOURCES) {
    assert.deepEqual(baselineViolations(source(), rules), [], name);
  }
});

/** Inserts `line` right after the first match of `anchor` (the plant must land: the anchor must exist). */
const plant = (source, anchor, line) => {
  assert.ok(source.includes(anchor), `plant anchor missing: ${anchor}`);
  return source.replace(anchor, anchor + '\n' + line + '\n');
};
const PLANTS = [
  ['store: a whole-document caller\'s object as the baseline', 'enhanced/config.js', STORE_RULES,
    "const before = fileName === 'settings.json' ? resolveSettings(state.shown) : state.shown;", 'state.persisted = copyDocument(settings);'],
  ['store: an answer applied before its success', 'enhanced/config.js', STORE_RULES,
    'const previousPersisted = state.persisted;\n                if (succeeded)', 'takeDocument(state, applyOperation(state.fileName, previousPersisted, entry));'],
  ['store: the page\'s object as the boot document (the R8-1 shape)', 'enhanced/config.js', STORE_RULES,
    'const bootDocument = fileName => {', 'const own = JE.userConfig?.[kindOf(fileName)?.view]; if (own) return { persisted: copyDocument(own), readOk: true };'],
  ['store: the page\'s object written into a document\'s state', 'enhanced/config.js', STORE_RULES,
    'const bootDocument = fileName => {', 'const view = JE.userConfig; if (view) documents.get(fileName) && (documents.get(fileName).persisted = copyDocument(view[fileName]));'],
  ['page: the form taken as saved before the answer', 'configPage.html', PAGE_RULES,
    'const now = jeFormConfig(_jeBase);', '_jeSent = JSON.parse(JSON.stringify(now));'],
  ['page: the form taken as saved by a timer', 'configPage.html', PAGE_RULES,
    'function saveConfig(e) {', 'setTimeout(function markLater() { _jeSent = jeFormConfig(_jeBase, true); }, 500);'],
  ['Elsewhere: the dialog moved on before the answer (the R8-4 shape)', 'elsewhere/elsewhere.js', ELSEWHERE_RULES,
    "if (!Object.keys(set).length) return;", 'for (const key of Object.keys(set)) dialogShown[key] = set[key];'],
  ['Spoiler Guard: preferences taken before the answer', 'enhanced/spoilerguard/state.js', SPOILER_RULES,
    'if (!Object.keys(set).length) return Promise.resolve(Object.assign({}, userPrefs));', 'userPrefs = Object.assign({}, userPrefs, set);'],
  ['Hidden Content: a private copy changed in place of an operation', 'enhanced/hiddencontent/hidden-content-data.js', HIDDEN_RULES,
    'function updateSettings(partial) {', 'hiddenData = { ...getHiddenData(), settings: { ...getHiddenData().settings, ...partial } };']
];
for (const [label, name, rules, anchor, line] of PLANTS) {
  test(`scan 1 finds a plant: ${label}`, () => {
    const source = SOURCES.find(([n]) => n === name)[1]();
    assert.equal(baselineViolations(source, rules).length, 0, 'the real source is clean');
    assert.ok(baselineViolations(plant(source, anchor, line), rules).length > 0, 'the plant is reported');
  });
}

// ---- Scan 2: no whole-document writer ----
const ROUTES = /user-settings\/|\/spoiler-blur\/user-prefs/;
const WHOLE_METHODS = /^(POST|PUT)$/i;
const RULE_ROUTE = /\/hidden-content\/rule\//;
const DOCUMENT_FILES = [...read('enhanced/config.js').matchAll(/^\s*'([a-z-]+\.json)': \{ kind:/gm)].map(m => m[1]);

/** Text of every string literal and template quasi under `node`. */
function strings(node) {
  const out = [];
  walk(node, inner => {
    if (inner.type === 'StringLiteral') out.push(inner.value);
    if (inner.type === 'TemplateElement') out.push(inner.value.raw);
  });
  return out.join(' ');
}
/** Whether an object literal under `node` (not inside a nested function) names a whole-document method. */
function wholeMethod(node) {
  let found = false;
  walk(node, inner => {
    if (inner.type !== 'ObjectProperty' || !['type', 'method'].includes(inner.key.name || inner.key.value)) return;
    if (WHOLE_METHODS.test(strings(inner.value).trim()) || strings(inner.value).split(' ').some(word => WHOLE_METHODS.test(word))) found = true;
  });
  return found;
}

function wholeWriters(files) {
  const found = [];
  for (const [name, source] of files) {
    walk(ast(source), (node, ancestors) => {
      if (node.type !== 'CallExpression') return;
      const callee = memberPath(node.callee);
      if (/updatePluginConfiguration$/.test(callee)) found.push(`${name}: ${callee} (JE's whole configuration)`);
      if (/(^|\.)saveUserSettings$/.test(callee) && node.arguments[0]?.type === 'StringLiteral' && !DOCUMENT_FILES.includes(node.arguments[0].value)) {
        found.push(`${name}: saveUserSettings('${node.arguments[0].value}') (no operations)`);
      }
      if (!node.arguments.some(arg => wholeMethod(arg))) return;
      // The route: in the call's own arguments or anywhere in the function that builds the request.
      const { fn } = enclosingName(ancestors);
      const scope = strings({ type: 'X', a: node.arguments, f: fn?.body });
      // (A title rule's own route changes one rule: the server applies it under the document's lock through the operation
      // helper, which scan 4 holds it to.)
      if (ROUTES.test(scope) && !RULE_ROUTE.test(scope)) found.push(`${name}: ${callee} sends a whole per-user document (${scope.match(ROUTES)[0]})`);
    });
  }
  return found;
}

function clientSources() {
  const files = [];
  const walkDir = folder => readdirSync(folder, { withFileTypes: true }).forEach(entry => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) walkDir(path);
    else if (entry.name.endsWith('.js')) files.push([relative(jsRoot, path), readFileSync(path, 'utf8')]);
  });
  walkDir(jsRoot);
  files.push(['configPage.html', pageSource()]);
  return files;
}

test('scan 2: no client writes a whole per-user document or JE\'s whole configuration', () => {
  const files = clientSources();
  assert.ok(files.length > 100, 'every client script is scanned');
  assert.ok(DOCUMENT_FILES.includes('hidden-content.json') && DOCUMENT_FILES.length === 6, DOCUMENT_FILES.join());
  assert.deepEqual(wholeWriters(files), []);
});

const WHOLE_PLANTS = [
  ['Hidden Content\'s old whole POST (the R8-3 shape)', 'enhanced/hiddencontent/hidden-content-save.js', 'function flushPendingSave() {',
    "ApiClient.ajax({ type: 'POST', url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${ApiClient.getCurrentUserId()}/hidden-content.json`), data: JSON.stringify(getHiddenData()) });"],
  ['a whole POST whose URL is built apart', 'enhanced/config.js', 'const queueOperation = async (fileName, operation, options = {}) => {',
    "const wholeUrl = ApiClient.getUrl(`/JellyfinEnhanced/user-settings/u/${fileName}`); ApiClient.ajax({ type: options.whole ? 'POST' : 'PATCH', url: wholeUrl });"],
  ['Spoiler Guard\'s old whole preferences POST', 'enhanced/spoilerguard/state.js', 'internal.setUserPrefs = function(next, owner) {',
    "request('/spoiler-blur/user-prefs', { method: 'POST', body: next, skipRetry: true });"],
  ['a whole save of a file without operations', 'enhanced/spoilerguard/state.js', 'internal.setUserPrefs = function(next, owner) {',
    "JE.saveUserSettings('spoilerblur.json', next);"],
  ['the configuration page saving the whole configuration', 'configPage.html', 'function saveConfig(e) {',
    'ApiClient.updatePluginConfiguration(pluginId, jeFormConfig(_jeBase));']
];
for (const [label, name, anchor, line] of WHOLE_PLANTS) {
  test(`scan 2 finds a plant: ${label}`, () => {
    const files = clientSources().map(([n, source]) => [n, n === name ? plant(source, anchor, line) : source]);
    assert.ok(wholeWriters(files).some(found => found.startsWith(name)), wholeWriters(files).join('\n') || 'nothing reported');
  });
}

test('configPage.html is the page the scans read', () => {
  assert.ok(readFileSync(configPagePath, 'utf8').includes('function jeSaveNow'));
});
