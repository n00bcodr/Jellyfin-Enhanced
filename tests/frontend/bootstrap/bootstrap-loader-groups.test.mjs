import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred, plain } from '../helpers/harness.mjs';
import { manifestModules, rawGroups, resolveGroups } from '../helpers/eval-reads.mjs';
import { BOOT_MODULES, TAB_MODULES, bootLoader, defines, until } from '../helpers/loader-harness.mjs';

// The component-group loader in plugin.js (ensureGroups, FEATURE_GROUPS, FEATURE_INITIALIZERS, FEATURE_PAGES,
// watchGroupTriggers, JE.loader). The loader is real; the bundle route and per-file loading are simulated by
// helpers/loader-harness.mjs, which serves `g=` lists from the groups the test gives, exactly as
// Services/ClientScriptBundle.cs does. Most tests use small synthetic groups (each module a test body that
// records it ran and defines spy initializers) so each test controls which groups exist.

const only = (log, prefix) => log.filter(entry => entry.startsWith(prefix));
const modulesRun = log => log.filter(entry => entry.endsWith('.js'));
const flush = async (window) => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => window.setTimeout(resolve, 0)); };

// A small world: core is the three boot modules plus one test module; four groups, listed in a different order
// from their modules' manifest order so the run order shows which one wins (the groups file's).
const BASIC_GROUPS = [
  { id: 'tags', note: 'poster tags', modules: ['fake/tags-1.js', 'fake/tags-2.js'] },
  { id: 'details', note: 'details page', modules: ['fake/details-1.js'] },
  { id: 'reviews', note: 'reviews', modules: ['fake/reviews-1.js'] },
  { id: 'hidden-content', note: 'hidden content', modules: ['fake/hidden-content-1.js'] }
];
const BASIC_MANIFEST = [...BOOT_MODULES, 'fake/core-1.js', 'fake/hidden-content-1.js', 'fake/tags-1.js', 'fake/details-1.js', 'fake/reviews-1.js', 'fake/tags-2.js'];
const BASIC_MODULES = {
  'fake/core-1.js': defines('initializeEnhancedScript'),
  'fake/tags-1.js': defines('initializeQualityTags', 'initializeGenreTags'),
  'fake/tags-2.js': defines('tagPipeline.initialize'),
  'fake/reviews-1.js': defines('initializeReviewsScript'),
  'fake/hidden-content-1.js': defines('initializeHiddenContent')
};
const basic = (t, options = {}) => bootLoader(t, { manifest: BASIC_MANIFEST, groups: BASIC_GROUPS, modules: BASIC_MODULES,
  publicConfig: { HiddenContentEnabled: true, ShowReviews: true }, userSettings: { QualityTagsEnabled: true, GenreTagsEnabled: false }, ...options });

test('boot asks for one bundle of the needed groups in file order, runs them in order, then stage 6 for those groups only', async t => {
  const boot = basic(t, { modules: { ...BASIC_MODULES,
    // A core module that defines the Reviews initializer: the reviews group is not loaded, so it must not run.
    'fake/core-1.js': defines('initializeEnhancedScript', 'initializeReviewsScript') } });
  await boot.booted();
  assert.deepEqual(boot.asked, ['core,tags,hidden-content']);
  assert.ok(boot.requests[0].url.includes('&v=1.2.3-build123'));
  assert.deepEqual(modulesRun(boot.log), [...BOOT_MODULES, 'fake/core-1.js', 'fake/tags-1.js', 'fake/tags-2.js', 'fake/hidden-content-1.js']);
  // FEATURE_INITIALIZERS order, each under its condition (genre tags off), none of a group that is not loaded.
  assert.deepEqual(only(boot.log, 'init:'), ['init:initializeEnhancedScript', 'init:initializeQualityTags', 'init:tagPipeline.initialize', 'init:initializeHiddenContent']);
  assert.ok(boot.log.indexOf('init:initializeEnhancedScript') > boot.log.indexOf('fake/hidden-content-1.js'), 'stage 6 runs after every boot module');
  assert.deepEqual(plain(boot.plugin.loader.state()), { core: 'ready', tags: 'ready', 'hidden-content': 'ready' });
  assert.deepEqual(plain(boot.plugin.loader.needed()), ['core', 'tags', 'hidden-content']);
  assert.equal(boot.plugin.initialized, true);
  assert.deepEqual(plain(boot.window.__JE_BUNDLES), {}, 'the loader takes each group it asked for');
});

test('a group whose rule turns true on a navigation loads alone, initializes once, and is not asked for again', async t => {
  const boot = basic(t);
  await boot.booted();
  const bootLog = boot.log.length;
  assert.deepEqual(await boot.navigate('#/details?id=1'), [boot.requests[1]]);
  assert.deepEqual(boot.asked, ['core,tags,hidden-content', 'details,reviews']);
  assert.deepEqual(boot.log.slice(bootLog), ['fake/details-1.js', 'fake/reviews-1.js', 'init:initializeReviewsScript']);
  // Back to Home and to another details page: nothing new to load, nothing initialized again.
  assert.deepEqual(await boot.navigate('#/home'), []);
  assert.deepEqual(await boot.navigate('#/details?id=2'), []);
  assert.equal(only(boot.log, 'init:initializeReviewsScript').length, 1);
  assert.equal(only(boot.log, 'init:initializeQualityTags').length, 1, 'a group loaded later does not re-run the boot groups\' initializers');
});

// The Seerr chain (after), and the settings panel's companion (with).
const CHAIN_GROUPS = [
  { id: 'tags', modules: ['fake/tags-1.js'] },
  { id: 'hidden-content', modules: ['fake/hidden-content-1.js'] },
  { id: 'hidden-content-page', after: ['hidden-content'], modules: ['fake/hidden-content-page-1.js'] },
  { id: 'settings', after: ['tags'], modules: ['fake/settings-1.js'] },
  { id: 'seerr-api', modules: ['fake/seerr-api-1.js'] },
  { id: 'seerr', after: ['seerr-api'], modules: ['fake/seerr-1.js'] },
  { id: 'recommendations', after: ['seerr'], modules: ['fake/recommendations-1.js'] }
];
const CHAIN_MANIFEST = [...BOOT_MODULES, ...CHAIN_GROUPS.flatMap(group => group.modules).reverse()];

for (const hidden of [true, false]) test(`"after" groups and "with" companions load in one request in file order (Hidden Content ${hidden ? 'on' : 'off'})`, async t => {
  const boot = bootLoader(t, { manifest: CHAIN_MANIFEST, groups: CHAIN_GROUPS,
    publicConfig: { HiddenContentEnabled: hidden, HiddenContentUseNativeTab: true, JellyseerrEnabled: true } });
  await boot.booted();
  assert.deepEqual(boot.asked, [hidden ? 'core,hidden-content,seerr-api' : 'core,seerr-api']);
  const before = boot.log.length;
  await boot.plugin.loader.ensure(['settings']);
  // settings is after tags; with Hidden Content on it brings the page (whose own dependency is already loaded).
  assert.deepEqual(boot.asked.slice(1), [hidden ? 'tags,hidden-content-page,settings' : 'tags,settings']);
  assert.deepEqual(boot.log.slice(before), hidden ? ['fake/tags-1.js', 'fake/hidden-content-page-1.js', 'fake/settings-1.js'] : ['fake/tags-1.js', 'fake/settings-1.js']);
  await boot.plugin.loader.ensure(['recommendations']);
  assert.equal(boot.asked.at(-1), 'seerr,recommendations', 'seerr-api is loaded already and is not asked for again');
});

test('batches run strictly in the order they were asked for, even when a later request arrives first', async t => {
  const slow = deferred();
  const boot = bootLoader(t, { manifest: [...BOOT_MODULES, 'fake/awards-1.js', 'fake/reviews-1.js'],
    groups: [{ id: 'reviews', modules: ['fake/reviews-1.js'] }, { id: 'awards', modules: ['fake/awards-1.js'] }],
    modules: { 'fake/reviews-1.js': defines('initializeReviewsScript'), 'fake/awards-1.js': defines('initializeAwardsScript') },
    publicConfig: { ShowReviews: true, ShowAwards: true },
    bundle: ids => (ids && ids.includes('reviews') ? { hold: slow.promise } : undefined) });
  await boot.booted();
  const before = boot.log.length;
  const first = boot.plugin.loader.ensure(['reviews']);
  const second = boot.plugin.loader.ensure(['awards']);
  await until(() => boot.arrivals.includes('awards'));
  await flush(boot.window);
  assert.deepEqual(boot.log.slice(before), [], 'the awards batch waits for the reviews batch asked for before it');
  slow.resolve();
  await second;
  await first;
  assert.deepEqual(boot.arrivals.slice(-2), ['awards', 'reviews']);
  assert.deepEqual(boot.log.slice(before), ['fake/reviews-1.js', 'init:initializeReviewsScript', 'fake/awards-1.js', 'init:initializeAwardsScript']);
});

// Stand-in exports: settings (showEnhancedPanel) and seerr (jellyseerrMoreInfo.open).
const STAND_IN_GROUPS = [
  { id: 'tags', modules: ['fake/tags-1.js'] },
  { id: 'settings', after: ['tags'], modules: ['fake/settings-1.js'] },
  { id: 'seerr-api', modules: ['fake/seerr-api-1.js'] },
  { id: 'seerr', after: ['seerr-api'], modules: ['fake/seerr-1.js'] }
];
const standIns = (t, modules, options = {}) => bootLoader(t, { manifest: [...BOOT_MODULES, ...STAND_IN_GROUPS.flatMap(group => group.modules)],
  groups: STAND_IN_GROUPS, modules, publicConfig: { JellyseerrEnabled: true, JellyseerrShowSearchResults: true }, ...options });

test('a stand-in export loads its group, then makes the same call once on the real function', async t => {
  const boot = standIns(t, { 'fake/settings-1.js': defines('showEnhancedPanel'), 'fake/seerr-1.js': defines('jellyseerrMoreInfo.open', 'initializeJellyseerrScript') });
  await boot.booted();
  const JE = boot.plugin;
  assert.equal(JE.showEnhancedPanel.jeLazyGroup, 'settings');
  assert.equal(JE.jellyseerrMoreInfo.open.jeLazyGroup, 'seerr');
  // Stage 6 and the boot triggers left the stand-ins alone: nothing asked for their groups.
  assert.deepEqual(boot.asked, ['core,seerr-api']);
  assert.equal(JE.loader.state().settings, undefined);

  assert.equal(await JE.showEnhancedPanel('shortcuts', { focus: true }), 'result:showEnhancedPanel');
  assert.deepEqual(boot.asked.slice(1), ['tags,settings']);
  assert.deepEqual(plain(boot.calls.filter(call => call.path === 'showEnhancedPanel')), [{ path: 'showEnhancedPanel', args: ['shortcuts', { focus: true }] }]);
  assert.equal(JE.showEnhancedPanel.jeLazyGroup, undefined, 'the module replaced the stand-in');

  assert.equal(await JE.jellyseerrMoreInfo.open(42, 'movie'), 'result:jellyseerrMoreInfo.open');
  assert.equal(boot.asked.at(-1), 'seerr');
  assert.deepEqual(plain(boot.calls.filter(call => call.path === 'jellyseerrMoreInfo.open')), [{ path: 'jellyseerrMoreInfo.open', args: [42, 'movie'] }]);
  assert.equal(JE.jellyseerrMoreInfo.open.jeLazyGroup, undefined);
  // The group's own stage-6 entry ran once when it loaded, after its modules.
  assert.deepEqual(only(boot.log, 'init:initializeJellyseerrScript'), ['init:initializeJellyseerrScript']);
  assert.equal(boot.asked.length, 3, 'nothing else was asked for');
});

test('a stand-in whose group does not define the function logs that it is not available', async t => {
  const boot = standIns(t, {}, { expectedConsoleErrors: [/'showEnhancedPanel' is not available \(component group 'settings' did not load\)/] });
  await boot.booted();
  assert.equal(await boot.plugin.showEnhancedPanel(), undefined);
  assert.equal(boot.plugin.loader.state().settings, 'ready');
});

test('a failed bundle request loads that batch\'s files one by one, in order, async=false', async t => {
  const boot = basic(t, { bundle: () => ({ fail: true }) });
  await boot.booted();
  const expected = [...BOOT_MODULES, 'fake/core-1.js', 'fake/tags-1.js', 'fake/tags-2.js', 'fake/hidden-content-1.js'];
  assert.deepEqual(boot.files.map(entry => entry.name), expected);
  assert.ok(boot.files.every(entry => entry.async === false));
  assert.deepEqual(modulesRun(boot.log), expected);
  assert.deepEqual(only(boot.log, 'init:'), ['init:initializeEnhancedScript', 'init:initializeQualityTags', 'init:tagPipeline.initialize', 'init:initializeHiddenContent']);
  assert.deepEqual(plain(boot.plugin.loader.state()), { core: 'ready', tags: 'ready', 'hidden-content': 'ready' });
});

test('a bundle that defines some of its groups loads only the missing groups\' files, keeping the run order', async t => {
  const boot = basic(t, { bundle: ids => (ids && ids.includes('tags') ? { define: ids.filter(id => id !== 'tags') } : undefined) });
  await boot.booted();
  assert.deepEqual(boot.files.map(entry => entry.name), ['fake/tags-1.js', 'fake/tags-2.js']);
  assert.deepEqual(modulesRun(boot.log), [...BOOT_MODULES, 'fake/core-1.js', 'fake/tags-1.js', 'fake/tags-2.js', 'fake/hidden-content-1.js']);
});

test('a lazy batch of which nothing arrives is forgotten, and asked for again after a pause, not on every trigger', async t => {
  let offline = true;
  const boot = basic(t, { expectedConsoleErrors: [/Failed to load script 'fake\/details-1\.js'/, /Failed to load script 'fake\/reviews-1\.js'/],
    bundle: ids => (offline && ids && ids.includes('details') ? { fail: true } : undefined),
    file: () => (offline ? 'error' : 'ok') });
  await boot.booted();
  await boot.navigate('#/details?id=1');
  assert.deepEqual(boot.files.map(entry => entry.name), ['fake/details-1.js', 'fake/reviews-1.js']);
  assert.equal(boot.plugin.loader.state().details, undefined);
  assert.equal(boot.plugin.loader.state().reviews, undefined);
  // Still unreachable as far as the loader knows: further page changes inside the pause ask for nothing,
  // so a server that is restarting is not sent a request per navigation or DOM change.
  offline = false;
  await boot.navigate('#/details?id=2');
  await boot.navigate('#/details?id=3');
  assert.deepEqual(boot.asked, ['core,tags,hidden-content', 'details,reviews']);
  assert.equal(boot.plugin.loader.state().details, undefined);
  // Once the pause is over, the next trigger asks again.
  const now = boot.window.Date.now;
  boot.window.Date.now = () => now() + 6000;
  t.after(() => { boot.window.Date.now = now; });
  await boot.navigate('#/details?id=4');
  assert.deepEqual(boot.asked, ['core,tags,hidden-content', 'details,reviews', 'details,reviews']);
  assert.equal(boot.plugin.loader.state().details, 'ready');
  assert.deepEqual(only(boot.log, 'init:initializeReviewsScript'), ['init:initializeReviewsScript']);
});

test('a group that keeps failing is retried on a timer with a growing pause, and loads without another trigger once it can', async t => {
  let offline = true;
  const boot = basic(t, { expectedConsoleErrors: [/Failed to load script 'fake\/details-1\.js'/, /Failed to load script 'fake\/reviews-1\.js'/],
    bundle: ids => (offline && ids && ids.includes('details') ? { fail: true } : undefined),
    file: () => (offline ? 'error' : 'ok') });
  await boot.booted();
  // Capture the loader's retry timers instead of waiting for them; every other timer runs as usual.
  const timers = [];
  const setTimeoutReal = boot.window.setTimeout;
  boot.window.setTimeout = (callback, delay, ...rest) => (delay >= 4000 ? timers.push({ callback, delay }) : setTimeoutReal(callback, delay, ...rest));
  const now = boot.window.Date.now;
  let clock = 0;
  boot.window.Date.now = () => now() + clock;
  t.after(() => { boot.window.setTimeout = setTimeoutReal; boot.window.Date.now = now; });
  const fire = async () => { const timer = timers.shift(); clock += timer.delay; timer.callback(); await boot.plugin.loader.settled(); await flush(boot.window); };

  await boot.navigate('#/details?id=1');
  assert.equal(timers.length, 1);
  assert.ok(timers[0].delay >= 5000 && timers[0].delay < 5200, `first pause ${timers[0].delay}`);
  await fire(); // still unreachable: fails again and schedules the next attempt itself, further away
  assert.deepEqual(boot.asked, ['core,tags,hidden-content', 'details,reviews', 'details,reviews']);
  assert.equal(timers.length, 1);
  assert.ok(timers[0].delay >= 10000 && timers[0].delay < 10200, `second pause ${timers[0].delay}`);
  offline = false;
  await fire(); // reachable again: no navigation or other trigger needed
  assert.equal(boot.plugin.loader.state().details, 'ready');
  assert.deepEqual(only(boot.log, 'init:initializeReviewsScript'), ['init:initializeReviewsScript']);
  assert.equal(timers.length, 0);
});

test('a failed group the page no longer needs is not retried', async t => {
  const boot = basic(t, { expectedConsoleErrors: [/Failed to load script 'fake\/details-1\.js'/, /Failed to load script 'fake\/reviews-1\.js'/],
    bundle: ids => (ids && ids.includes('details') ? { fail: true } : undefined), file: () => 'error' });
  await boot.booted();
  const timers = [];
  const setTimeoutReal = boot.window.setTimeout;
  boot.window.setTimeout = (callback, delay, ...rest) => (delay >= 4000 ? timers.push({ callback, delay }) : setTimeoutReal(callback, delay, ...rest));
  t.after(() => { boot.window.setTimeout = setTimeoutReal; });
  await boot.navigate('#/details?id=1');
  assert.equal(timers.length, 1);
  await boot.navigate('#/home');
  const now = boot.window.Date.now;
  boot.window.Date.now = () => now() + 6000;
  t.after(() => { boot.window.Date.now = now; });
  timers.shift().callback();
  await boot.plugin.loader.settled();
  await flush(boot.window);
  assert.deepEqual(boot.asked, ['core,tags,hidden-content', 'details,reviews']);
  assert.equal(timers.length, 0);
});

test('an explicit request for a group that failed to load does not wait for the pause', async t => {
  let offline = true;
  const boot = basic(t, { expectedConsoleErrors: [/Failed to load script 'fake\/details-1\.js'/, /Failed to load script 'fake\/reviews-1\.js'/],
    bundle: ids => (offline && ids && ids.includes('details') ? { fail: true } : undefined),
    file: () => (offline ? 'error' : 'ok') });
  await boot.booted();
  await boot.navigate('#/details?id=1');
  assert.equal(boot.plugin.loader.state().details, undefined);
  offline = false;
  await boot.plugin.loader.ensure(['details']);
  assert.equal(boot.plugin.loader.state().details, 'ready');
});

test('core is marked loaded even when none of its files arrives, so boot finishes', async t => {
  const boot = bootLoader(t, { manifest: BASIC_MANIFEST, groups: BASIC_GROUPS, modules: BASIC_MODULES,
    expectedConsoleErrors: [/Failed to load script '(core|enhanced|fake)\//, /session\.js missing/],
    bundle: () => ({ fail: true }), file: () => 'error' });
  await boot.booted();
  assert.deepEqual(plain(boot.plugin.loader.state()), { core: 'ready' });
  assert.deepEqual(modulesRun(boot.log), []);
});

test('dev mode never asks for a bundle: the needed groups\' files load at boot, a lazy group\'s on demand', async t => {
  const boot = basic(t, { dev: true });
  await boot.booted();
  assert.equal(boot.scripts.some(script => script.src.includes('/bundle.js')), false);
  assert.deepEqual(boot.files.map(entry => entry.name), [...BOOT_MODULES, 'fake/core-1.js', 'fake/tags-1.js', 'fake/tags-2.js', 'fake/hidden-content-1.js']);
  await boot.navigate('#/details?id=1');
  assert.deepEqual(boot.files.slice(-2).map(entry => entry.name), ['fake/details-1.js', 'fake/reviews-1.js']);
  assert.ok(boot.files.every(entry => entry.async === false));
  assert.equal(boot.requests.length, 0);
  assert.deepEqual(only(boot.log, 'init:initializeReviewsScript'), ['init:initializeReviewsScript']);
});

// Without a usable groups file the loader is the single bundle loader it replaced.
const WHOLE_MODULES = { ...BASIC_MODULES, 'fake/details-1.js': defines('showEnhancedPanel') };
function assertWholeBundle(boot) {
  assert.deepEqual(boot.asked, ['whole']);
  assert.match(boot.requests[0].url, /\/JellyfinEnhanced\/bundle\.js\?v=1\.2\.3-build123$/);
  assert.deepEqual(modulesRun(boot.log), BASIC_MANIFEST);
  // Every initializer is "core" now: Reviews runs on Home as it always did.
  assert.deepEqual(only(boot.log, 'init:'), ['init:initializeEnhancedScript', 'init:initializeQualityTags', 'init:initializeReviewsScript', 'init:tagPipeline.initialize', 'init:initializeHiddenContent']);
  assert.deepEqual(plain(boot.plugin.loader.state()), { core: 'ready' });
  assert.equal(boot.plugin.showEnhancedPanel.jeLazyGroup, undefined, 'no stand-ins: every module has run');
  assert.equal(boot.window.__JE_BUNDLE_MODULES, undefined);
  assert.equal(boot.window.__JE_BUNDLE_PROGRESS, BASIC_MANIFEST.length);
}
const MALFORMED = {
  'no ComponentGroups': undefined,
  'a repeated group id': [{ id: 'tags', modules: ['fake/tags-1.js'] }, { id: 'tags', modules: ['fake/tags-2.js'] }],
  'a module the manifest lacks': [{ id: 'tags', modules: ['fake/tags-1.js', 'fake/missing.js'] }],
  'an "after" naming a later group': [{ id: 'reviews', after: ['tags'], modules: ['fake/reviews-1.js'] }, { id: 'tags', modules: ['fake/tags-1.js'] }]
};
for (const [label, groups] of Object.entries(MALFORMED)) test(`a bootstrap with ${label} loads the whole manifest as one bundle`, async t => {
  const boot = basic(t, { groups, modules: WHOLE_MODULES });
  await boot.booted();
  assertWholeBundle(boot);
  await boot.navigate('#/details?id=1');
  assert.equal(boot.requests.length, 1, 'nothing further is ever asked for');
});

for (const groupsFile of ['fails', 'answers']) test(`without a bootstrap, a groups file that ${groupsFile} decides between the whole bundle and groups`, async t => {
  const settings = { QualityTagsEnabled: true };
  const boot = basic(t, { modules: WHOLE_MODULES, ajax: async path => {
    if (path.endsWith('/bootstrap')) throw new Error('bootstrap down');
    if (path.endsWith('/public-config')) return { HiddenContentEnabled: true, ShowReviews: true };
    if (path.endsWith('/version')) return '1.2.3';
    if (path.endsWith('/private-config')) return {};
    if (path === '/Plugins') return [];
    if (path.endsWith('/settings.json')) return settings;
    if (path.includes('/user-settings/user-a/')) return {};
    if (path.endsWith('/component-scripts.json')) return BASIC_MANIFEST;
    if (path.endsWith('/component-groups.json')) { if (groupsFile === 'fails') throw new Error('offline'); return { groups: BASIC_GROUPS }; }
    throw new Error(`Unexpected endpoint ${path}`);
  } });
  await boot.booted();
  if (groupsFile === 'fails') assertWholeBundle(boot);
  else assert.deepEqual(boot.asked, ['core,tags,hidden-content']);
});

// User switch: the incoming user's settings are asked again.
const switching = (t, options) => bootLoader(t, { manifest: [...BOOT_MODULES, 'fake/tags-1.js', 'fake/tags-2.js'],
  groups: [{ id: 'tags', modules: ['fake/tags-1.js', 'fake/tags-2.js'] }], modules: BASIC_MODULES,
  userSettings: id => (id === 'user-b' ? { QualityTagsEnabled: true } : {}), ...options });
const dataLoaded = boot => new Promise(resolve => boot.document.addEventListener('je:user-data-loaded', event => {
  boot.log.push(`user-data-loaded:${event.detail.userId}`); resolve(event.detail.userId);
}));

test('after a user switch the incoming user\'s groups load, and initialize, before the tag re-initialization runs', async t => {
  const boot = switching(t);
  await boot.booted();
  assert.deepEqual(boot.asked, ['core']);
  const before = boot.log.length;
  const loaded = dataLoaded(boot);
  boot.switchUser('user-b');
  assert.equal(await loaded, 'user-b');
  assert.deepEqual(boot.asked, ['core', 'tags']);
  // Modules, then the group's stage 6 (quality tags, then the pipeline). The switch's re-initialization list is
  // skipped for a tags group that has only just started with this user's settings: a renderer is not started twice.
  assert.deepEqual(boot.log.slice(before), ['fake/tags-1.js', 'fake/tags-2.js', 'init:initializeQualityTags', 'init:tagPipeline.initialize',
    'user-data-loaded:user-b']);
});

test('a user switch with the tags group already loaded restarts the incoming user\'s tag types once', async t => {
  const boot = switching(t, { userSettings: () => ({ QualityTagsEnabled: true }) });
  await boot.booted();
  assert.deepEqual(boot.asked, ['core,tags']);
  const before = boot.log.length;
  const loaded = dataLoaded(boot);
  boot.switchUser('user-b');
  assert.equal(await loaded, 'user-b');
  // Nothing new to load; the re-initialization list restarts the renderer with user B's settings, as it always has.
  assert.deepEqual(boot.asked, ['core,tags']);
  assert.deepEqual(boot.log.slice(before), ['init:initializeQualityTags', 'user-data-loaded:user-b']);
});

for (const incomingTags of [false, true]) test(`a second switch while the first user's groups load initializes nothing for the stale user (next user's tags ${incomingTags ? 'on' : 'off'})`, async t => {
  const slow = deferred();
  const boot = switching(t, { bundle: ids => (ids && ids.includes('tags') ? { hold: slow.promise } : undefined),
    userSettings: id => (id === 'user-b' || (id === 'user-c' && incomingTags) ? { QualityTagsEnabled: true } : {}) });
  await boot.booted();
  const before = boot.log.length;
  const loaded = dataLoaded(boot);
  boot.switchUser('user-b');
  await until(() => boot.requests.length === 2);
  boot.switchUser('user-c');
  await until(() => boot.plugin.currentSettings && boot.plugin.currentSettings.qualityTagsEnabled === incomingTags);
  slow.resolve();
  assert.equal(await loaded, 'user-c');
  await boot.plugin.loader.settled();
  await flush(boot.window);
  // The tags group still loads (user B asked for it) and initializes with user C's settings; user B's
  // re-initialization list and "data loaded" never run, and user C's tags start exactly once.
  assert.deepEqual(boot.log.slice(before), ['fake/tags-1.js', 'fake/tags-2.js',
    ...(incomingTags ? ['init:initializeQualityTags'] : []), 'init:tagPipeline.initialize', 'user-data-loaded:user-c']);
});

test('the first plan reads the saved settings before JE.loadSettings exists', async t => {
  for (const [saved, admin, expected] of [[true, false, 'core,tags'], [false, true, 'core'], [undefined, true, 'core,tags']]) {
    const boot = switching(t, { userSettings: saved === undefined ? {} : { QualityTagsEnabled: saved }, publicConfig: { QualityTagsEnabled: admin } });
    await boot.booted();
    assert.equal(boot.asked[0], expected, `saved ${saved}, admin default ${admin}`);
    assert.equal(boot.requests[0].currentSettings, undefined);
    assert.match(String(boot.requests[0].loadSettings), /called before config\.js loaded/, 'asked before enhanced/config.js ran');
    assert.equal(boot.requests.length, 1);
  }
});

test('a boot batch of several groups runs as one paced list: one wait for idle time, not one per group', async t => {
  // Each wait for idle time can take up to 100 ms on a busy page. Waiting once per group spread a twenty-group
  // boot over a second or more, so modules that start work as they load finished before stage 6 had started
  // the features they consult (Seerr cards drawn before Hidden Content existed).
  let idleWaits = 0;
  const boot = basic(t, { url: 'http://jellyfin.test/web/index.html#/details?id=1' });
  // Wrapped before the loader's first wait (it is still waiting for the bootstrap answer).
  const idle = boot.window.requestIdleCallback;
  boot.window.requestIdleCallback = (callback, options) => { idleWaits++; return idle(callback, options); };
  await boot.booted();
  assert.deepEqual(boot.asked, ['core,tags,details,reviews,hidden-content']);
  // One before the request is made, one before the modules run.
  assert.equal(idleWaits, 2);
});

test('groups loaded for a page the user went to run in idle time; a group asked for directly does not wait for it', async t => {
  const boot = basic(t);
  await boot.booted();
  let idleWaits = 0;
  const idle = boot.window.requestIdleCallback;
  boot.window.requestIdleCallback = (callback, options) => { idleWaits++; return idle(callback, options); };
  // Navigation: requested at once (no wait before the request), run in idle time so the new view is drawn first.
  await boot.navigate('#/details?id=1');
  assert.deepEqual(boot.asked, ['core,tags,hidden-content', 'details,reviews']);
  assert.equal(idleWaits, 1);
  await boot.navigate('#/home');
  // Asked for directly (what a stand-in export does): no idle wait at all.
  idleWaits = 0;
  const direct = bootLoader(t, { manifest: BASIC_MANIFEST, groups: BASIC_GROUPS, modules: BASIC_MODULES });
  await direct.booted();
  const directIdle = direct.window.requestIdleCallback;
  let directWaits = 0;
  direct.window.requestIdleCallback = (callback, options) => { directWaits++; return directIdle(callback, options); };
  await direct.plugin.loader.ensure(['details']);
  assert.equal(direct.plugin.loader.state().details, 'ready');
  assert.equal(directWaits, 0);
});

test('an address that becomes a details page while boot is under way: the boot features start before that page\'s groups are fetched', async t => {
  // A sign-in redirect lands on its page after the loader has made its first plan. Hidden Content (and Spoiler
  // Guard) must be running before the page's own groups, whose modules start rendering as they load, arrive.
  const boot = basic(t, { bundle: (ids, index) => { if (index === 0) boot.window.location.hash = '#/details?id=1'; } });
  await boot.booted();
  assert.deepEqual(boot.asked, ['core,tags,hidden-content', 'details,reviews']);
  assert.ok(boot.log.indexOf('init:initializeHiddenContent') >= 0);
  assert.ok(boot.log.indexOf('init:initializeHiddenContent') < boot.log.indexOf('fake/details-1.js'), 'Hidden Content starts before the details groups run');
  assert.deepEqual(only(boot.log, 'init:initializeReviewsScript'), ['init:initializeReviewsScript']);
  assert.equal(boot.plugin.initialized, true);
});

test('the plan is made again once settings resolve: a group only the resolved settings need loads after the boot features start, before JE.initialized', async t => {
  // The user changes while the first batch is on its way (before session.js exists), so the boot reloads
  // user B's documents and resolves their settings; only then do the tags turn out to be needed.
  const boot = switching(t, { manifest: [...BOOT_MODULES, 'fake/core-1.js', 'fake/tags-1.js', 'fake/tags-2.js'],
    modules: { ...BASIC_MODULES, 'fake/tags-1.js': (JE, run) => {
      defines('initializeGenreTags')(JE, run);
      JE.initializeQualityTags = () => run.log.push(`init:initializeQualityTags initialized=${JE.initialized}`);
    } },
    bundle: (ids, index) => { if (index === 0) boot.setUser('user-b'); } });
  await boot.booted();
  assert.deepEqual(boot.asked, ['core', 'tags']);
  assert.equal(boot.requests[1].currentSettings.qualityTagsEnabled, true);
  // The boot groups' features start first (Hidden Content and Spoiler Guard must not wait on a second download);
  // the added group then loads and starts as its own batch, and only then is boot reported complete.
  assert.ok(boot.log.indexOf('init:initializeEnhancedScript') < boot.log.indexOf('fake/tags-1.js'));
  assert.deepEqual(boot.log.slice(boot.log.indexOf('fake/tags-1.js')), ['fake/tags-1.js', 'fake/tags-2.js',
    'init:initializeQualityTags initialized=undefined', 'init:tagPipeline.initialize']);
});

// JE's own Home tabs.
const PAGE_GROUPS = ['hidden-content-page', 'catchup', 'recommendations', 'requests-page', 'calendar-page', 'activity-page', 'leavingsoon-page', 'bookmarks-library'];
const PAGE_FLAGS = { HiddenContent: 'HiddenContentEnabled', CatchUp: 'CatchUpEnabled', Recommendations: 'RecommendationsPageEnabled', Downloads: 'DownloadsPageEnabled',
  Calendar: 'CalendarPageEnabled', ActivityFeed: 'ActivityFeedEnabled', LeavingSoonPage: 'LeavingSoonPageEnabled', Bookmarks: 'BookmarksEnabled' };
const TABBED_CONFIG = Object.fromEntries(Object.entries(PAGE_FLAGS).flatMap(([delivery, flag]) => [[flag, true], [`${delivery}UseNativeTab`, true]]));
const TAB_TITLES = { hidden_content_manage_title: 'Versteckt', catchup_title: 'Nachholen', recommendations_title: 'Empfehlungen', requests_requests: 'Anfragen',
  calendar_title: 'Kalender', activity_title: 'Aktivität', leavingsoon_title: 'Bald weg' };
const TAB_MANIFEST = [...TAB_MODULES, 'fake/tags-1.js', ...PAGE_GROUPS.map(id => `fake/${id}-1.js`)];
const TAB_GROUPS = [{ id: 'tags', modules: ['fake/tags-1.js'] }, ...PAGE_GROUPS.map(id => ({ id, modules: [`fake/${id}-1.js`] }))];
const tabbed = (t, options = {}) => bootLoader(t, { manifest: TAB_MANIFEST, groups: TAB_GROUPS, real: TAB_MODULES, translations: TAB_TITLES,
  publicConfig: TABBED_CONFIG, userSettings: { QualityTagsEnabled: true }, ...options });

/** What one registration puts in a tab: [id, title, placeholder class, icon]. */
function describeRegistration([id, title, render, icon], document) {
  const panel = document.createElement('div');
  render(panel);
  return [id, title, panel.firstElementChild?.className, icon];
}

/** The tabs the real pages' own modules register, with the same config and translations. */
async function pageModuleRegistrations(t) {
  const registered = [];
  const h = createHarness({ JE: { pluginConfig: { ...TABBED_CONFIG }, t: key => TAB_TITLES[key] || key, userConfig: {}, bookmarks: {},
    nativeTabs: { register: (...args) => registered.push(args) },
    helpers: { observeTabContainers: () => ({ teardown() {} }), isActiveTabContainer: () => false },
    core: { navigation: { onNavigate: () => () => {}, onViewPage: () => () => {} }, lifecycle: { register: () => ({ track: value => value, addListener() {}, teardown() {} }) } },
    internals: { bookmarksLibrary: { isPluginPagesActive: () => false, hookViewEvents() {}, renderIfSectionExists() {} } } } });
  t.after(() => h.close());
  for (const file of ['enhanced/hiddencontent/hidden-content-custom-tab.js', 'enhanced/catchup/catchup-custom-tab.js', 'jellyseerr/recommendations/recommendations-custom-tab.js',
    'arr/requests/requests-custom-tab.js', 'arr/calendar/calendar-custom-tab.js', 'extras/activity-custom-tab.js', 'extras/leavingsoon-custom-tab.js', 'enhanced/bookmarks/bookmarks-library-init.js']) h.load(file);
  // The Bookmarks library registers from its readiness timer.
  await until(() => registered.length === 8, 'the page modules did not register their eight tabs');
  return registered.map(args => describeRegistration(args, h.document));
}

test('the loader registers the eight Home tabs right after core, in the single bundle\'s order, exactly as the pages\' own modules do', async t => {
  const boot = tabbed(t);
  await boot.booted();
  assert.deepEqual(boot.asked, ['core,tags'], 'no page is loaded for its tab alone');
  const tabs = ['hidden-content', 'catchup', 'recommendations', 'requests', 'calendar', 'activity', 'leavingsoon', 'bookmarks'];
  assert.deepEqual(boot.log.filter(entry => entry.endsWith('.js') || entry.startsWith('tab:')),
    [...TAB_MODULES, ...tabs.map(id => `tab:${id}`), 'fake/tags-1.js']);
  const ours = boot.registrations.map(args => describeRegistration(args, boot.document));
  assert.deepEqual(ours, await pageModuleRegistrations(t));
  assert.deepEqual(plain(boot.plugin.loader.catalog().pages.map(page => page.tab[0])), tabs);
});

test('a page loads when the Home tab holding its placeholder becomes the active one', async t => {
  const boot = tabbed(t);
  await boot.booted();
  const page = boot.document.createElement('div');
  page.className = 'page';
  page.innerHTML = '<div class="tabContent"><div class="jellyfinenhanced calendar"></div></div>';
  boot.document.body.appendChild(page);
  // Two frames: the tab watcher has seen the inactive placeholder and loaded nothing for it.
  for (let i = 0; i < 2; i++) await new Promise(resolve => boot.window.requestAnimationFrame(() => boot.window.setTimeout(resolve, 0)));
  assert.deepEqual(boot.asked, ['core,tags']);
  page.firstElementChild.classList.add('is-active');
  await until(() => boot.asked.length === 2);
  await boot.plugin.loader.settled();
  assert.deepEqual(boot.asked, ['core,tags', 'calendar-page']);
  assert.equal(boot.plugin.loader.state()['calendar-page'], 'ready');
});

test('a page delivered standalone (no Home tab flag) loads at boot', async t => {
  const boot = bootLoader(t, { manifest: [...BOOT_MODULES, 'fake/calendar-page-1.js', 'fake/catchup-1.js'],
    groups: [{ id: 'catchup', modules: ['fake/catchup-1.js'] }, { id: 'calendar-page', modules: ['fake/calendar-page-1.js'] }],
    modules: { 'fake/calendar-page-1.js': defines('initializeCalendarPage') }, publicConfig: { CalendarPageEnabled: true, CatchUpEnabled: true } });
  await boot.booted();
  // Catch Up has no standalone mode: without a tab flag nothing loads it.
  assert.deepEqual(boot.asked, ['core,calendar-page']);
  assert.deepEqual(only(boot.log, 'init:'), ['init:initializeCalendarPage']);
});

test('a <video> that starts loading loads the player group, wherever the address is', async t => {
  const boot = bootLoader(t, { manifest: [...BOOT_MODULES, 'fake/player-1.js', 'fake/bookmarks-1.js'],
    groups: [{ id: 'player', modules: ['fake/player-1.js'] }, { id: 'bookmarks', modules: ['fake/bookmarks-1.js'] }],
    modules: { 'fake/player-1.js': defines('initializePauseScreen', 'initializeOsdRating'), 'fake/bookmarks-1.js': defines('initializeBookmarks') },
    publicConfig: { BookmarksEnabled: true } });
  await boot.booted();
  assert.deepEqual(boot.asked, ['core']);
  const video = boot.document.createElement('video');
  boot.document.body.appendChild(video);
  video.dispatchEvent(new boot.window.Event('loadstart')); // does not bubble: the loader listens in the capture phase
  await until(() => boot.asked.length === 2);
  await boot.plugin.loader.settled();
  assert.match(boot.window.location.hash, /home/);
  assert.deepEqual(boot.asked, ['core', 'player,bookmarks']);
  assert.deepEqual(only(boot.log, 'init:'), ['init:initializePauseScreen', 'init:initializeBookmarks', 'init:initializeOsdRating']);
  video.dispatchEvent(new boot.window.Event('play'));
  await flush(boot.window);
  assert.equal(boot.requests.length, 2);
});

test('with the real manifest and groups file, boot loads exactly the needed groups\' modules once, in order', async t => {
  const manifest = manifestModules();
  const groups = rawGroups();
  const resolved = new Map(resolveGroups(manifest, groups).map(group => [group.id, group.scripts]));
  const boot = bootLoader(t, { manifest, groups, real: TAB_MODULES,
    publicConfig: { HiddenContentEnabled: true, HiddenContentUseNativeTab: true, SpoilerBlurEnabled: true, JellyseerrEnabled: true, ActiveStreamsEnabled: true },
    userSettings: { QualityTagsEnabled: true } });
  await boot.booted();
  const bootGroups = ['core', 'tags', 'spoiler-guard', 'hidden-content', 'seerr-api', 'active-streams'];
  assert.deepEqual(boot.asked, [bootGroups.join(',')]);
  assert.deepEqual(modulesRun(boot.log), bootGroups.flatMap(id => resolved.get(id)));
  assert.ok(boot.log.indexOf('tab:hidden-content') > boot.log.indexOf(resolved.get('core').at(-1)) && boot.log.indexOf('tab:hidden-content') < boot.log.indexOf(resolved.get('tags')[0]));
  const before = boot.log.length;
  await boot.navigate('#/details?id=1');
  assert.deepEqual(boot.asked.slice(1), ['details,seerr']);
  assert.deepEqual(modulesRun(boot.log.slice(before)), ['details', 'seerr'].flatMap(id => resolved.get(id)));
  assert.equal(new Set(modulesRun(boot.log)).size, modulesRun(boot.log).length, 'no module ran twice');
});
