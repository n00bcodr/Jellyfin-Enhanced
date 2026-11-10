// canopy K1, checked on the committed outputs:
// - the featureContext implementation ships once in the served bundle, from core/ui-kit.js, and every feature script
//   that delegates to it is listed after core/ui-kit.js in js/component-scripts.json (bundle and per-file loader);
// - every component script has a minified twin under min/ (the only files the bundle serves), and only those.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { minDirectory, repositoryRoot } from '../../scripts/client-build.mjs';

const plugin = join(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced');
const componentScripts = JSON.parse(readFileSync(join(plugin, 'js/component-scripts.json'), 'utf8'))
  .map(item => item.trim()).filter(item => item && !item.startsWith('//'));
// Strings that survive minification: the implementation's own error, and the delegate's.
const IMPLEMENTATION = "internal slots need the host's internalsObject accessor";
const DELEGATE = 'JE.core.featureContext is missing';
const PROVIDER = 'core/ui-kit.js';
// Scripts that run before the bundle (client/src/bootstrap/loader/early.ts) and so carry their own copy.
const PRE_LOGIN = ['extras/login-image.js', 'others/splashscreen.js'];

const read = path => readFileSync(join(plugin, path), 'utf8');
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [relative(plugin, join(dir, entry.name)).split('\\').join('/')]);
}

test('the featureContext implementation ships once among the component scripts, in core/ui-kit.js', () => {
  for (const tree of ['js', `${minDirectory}/js`]) {
    const carriers = componentScripts.filter(path => read(`${tree}/${path}`).includes(IMPLEMENTATION));
    assert.deepEqual(carriers, [PROVIDER], tree);
  }
  const outside = walk(join(plugin, 'js')).filter(path => path.endsWith('.js') && read(path).includes(IMPLEMENTATION))
    .map(path => path.slice('js/'.length)).sort();
  assert.deepEqual(outside, [PROVIDER, ...PRE_LOGIN].sort());
});

test('every component script that delegates to the shared featureContext loads after core/ui-kit.js', () => {
  const provider = componentScripts.indexOf(PROVIDER);
  assert.ok(provider >= 0, `${PROVIDER} is not in js/component-scripts.json`);
  // canopy K1b: a script may instead reach the delegate through a shared feature host (client/shared-modules.json),
  // published by an earlier script; count those too (an over-approximation: every stub reader).
  const users = componentScripts.filter(path => { const code = read(`js/${path}`); return code.includes(DELEGATE) || code.includes('\n  // client/generated-shared/stub/'); });
  assert.ok(users.length > 90, `expected the feature scripts to delegate, found ${users.length}`);
  for (const path of users) assert.ok(componentScripts.indexOf(path) > provider, `${path} loads before ${PROVIDER}`);
  for (const path of PRE_LOGIN) assert.equal(read(`js/${path}`).includes(DELEGATE), false, `${path} runs before the bundle`);
});

test('min/ holds exactly one minified twin and map per component script, mapping the readable sources', () => {
  const expected = componentScripts.flatMap(path => [`${minDirectory}/js/${path}`, `${minDirectory}/js/${path}.map`]).sort();
  assert.deepEqual(walk(join(plugin, minDirectory)).sort(), expected);
  for (const path of componentScripts) {
    const twin = read(`${minDirectory}/js/${path}`);
    assert.ok(twin.length < read(`js/${path}`).length, `${path}: twin is not smaller`);
    assert.equal(twin.includes('sourceMappingURL'), false, `${path}: the bundle owns the source-map link`);
    const map = JSON.parse(read(`${minDirectory}/js/${path}.map`));
    assert.equal(map.sourcesContent, undefined, `${path}: the server copies sourcesContent from the readable map`);
    const readable = JSON.parse(read(`js/${path}.map`));
    for (const source of map.sources) assert.ok(readable.sources.includes(source), `${path}: ${source} is not in the readable map`);
  }
  assert.equal(existsSync(join(plugin, minDirectory, 'js/plugin.js')), false, 'only component scripts get a twin');
});
