// Stage 1 fix round 10: source scans of the document writers' shape, each checked against planted violations (a scan that
// finds nothing in a plant proves nothing). Runtime tests of the same rules: ApiDocumentRevisionCounterTests,
// CoreHostConfigurationFenceTests, ApiHostConfigurationRouteTests, bootstrap-settings-order, features-spoiler-session,
// features-arr-notify-order, pages-config-lifecycle, core-build-handshake.
//  5. Revisions count writes (server): a per-user document's revision is "{incarnation}.{writes}", never derived from its
//     content; every change of the file moves it on (a save, a quarantine, a restore), an incarnation begins on every start,
//     restore, migration and removal; If-Match is read as strict entity tags (a weak tag never matches).
//  6. Every writer is fenced (server): a restore puts each person's document in place under that document's lock; every
//     configuration write goes through SaveConfiguration, which moves the generation on; Jellyfin's plugin-configuration
//     route (UpdateConfiguration) refuses an earlier generation, and its filter answers that visibly.
//  7. One session-bound queue per document (client): every write of a per-user document goes out on its document's queue,
//     and the queue checks the session right before each send.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { jsRoot } from '../helpers/harness.mjs';
import { repositoryRoot } from '../helpers/discovery.mjs';

const serverRoot = resolve(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced');
const server = path => readFileSync(resolve(serverRoot, path), 'utf8');
const client = path => readFileSync(resolve(jsRoot, path), 'utf8');

/** The body of the first member whose declaration matches `signature` (from its first "{" to the matching "}"). */
function member(source, signature) {
  const match = signature.exec(source);
  if (!match) return null;
  const at = match.index;
  const open = source.indexOf('{', at + match[0].length - 1);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(at, i + 1);
  }
  return source.slice(at);
}

const FILES = {
  manager: 'Configuration/UserConfigurationManager.cs',
  backup: 'Services/Backup/JeBackupService.cs',
  plugin: 'JellyfinEnhanced.cs',
  registrator: 'PluginServiceRegistrator.cs',
  filter: 'Services/HostConfigurationRouteFilter.cs',
  store: 'js/enhanced/config.js',
  queue: 'js/core/mutation-queue.js'
};
const read = name => FILES[name].startsWith('js/') ? client(FILES[name].slice(3)) : server(FILES[name]);

/** Scan 5: revisions count writes. */
function revisionViolations(src) {
  const found = [];
  const revisionOf = member(src.manager, /public string RevisionOf\(/);
  if (!revisionOf) found.push('RevisionOf is missing');
  else {
    if (!/_writes/.test(revisionOf) || !/_incarnation/.test(revisionOf)) found.push('a revision is not "{incarnation}.{writes}"');
    if (/SHA256|HashData|Serialize|GetUserConfiguration/.test(revisionOf)) found.push('a revision is derived from the document');
  }
  // Core's DocumentRevision (the access revision's per-document part) counts versions; one derived from the content is
  // the R10-4 shape.
  const documentRevision = member(src.manager, /static string DocumentRevision\(/);
  if (documentRevision && /SHA256|HashData|Serialize|GetUserConfiguration/.test(documentRevision)) found.push('a content revision of a document exists');
  const save = member(src.manager, /public void SaveUserConfiguration\(/);
  // (D46's privacy save epoch may move between the two, inside the same bracket.)
  if (!save || !/File\.Move\(tempPath, configPath, overwrite: true\);\s*(Interlocked\.Increment\(ref _saveEpoch\);\s*)?(\/\/[^\n]*\n\s*)*Advance\(configPath\);/.test(save)) found.push('a save does not move the revision on once the file is in place');
  const quarantine = member(src.manager, /private void BackupCorruptFile\(/);
  if (!quarantine || (quarantine.match(/Advance\(filePath\)/g) || []).length < 2) found.push('a quarantined file keeps its revision');
  for (const [name, signature] of [['the start-up folder migration', /private void MigrateCaseVariantUserDirs\(/], ['a removed folder', /public bool DeleteUserData\(/]]) {
    if (!/NewIncarnation\(\)/.test(member(src.manager, signature) || '')) found.push(`${name} keeps the incarnation`);
  }
  const allows = member(src.manager, /public static bool IfMatchAllows\(/);
  if (!allows || !/TryParseStrictList/.test(allows) || !/!tag\.IsWeak/.test(allows)) found.push('If-Match is not read as strict strong entity tags');
  if (/static bool SameRevision\(/.test(src.manager)) found.push('a lenient revision comparison exists');
  return found;
}

/** Scan 6: every writer is fenced. */
function fenceViolations(src) {
  const found = [];
  const restore = member(src.backup, /public JeRestoreResult Restore\(/);
  if (!restore || !/PersonalDocument\(relative\) is \{ \} document\) UserConfigurationManager\.PlaceUserFile\(/.test(restore)) found.push('a restore writes people\'s documents past their locks');
  if (!restore || !/UserConfigurationManager\.NewIncarnation\(\)/.test(restore)) found.push('a restore keeps the incarnation');
  const place = member(src.manager, /internal static void PlaceUserFile\(/);
  if (!place || !/lock \(FileLock\(personFolder, fileName\)\)/.test(place) || !/Advance\(path\)/.test(place)) found.push('a placed document is not under its lock with its revision moved on');
  const saveConfiguration = member(src.plugin, /public override void SaveConfiguration\(PluginConfiguration config\)/);
  if (!saveConfiguration || !/config\.ConfigurationGeneration = next;/.test(saveConfiguration) || !/base\.SaveConfiguration\(config\)/.test(saveConfiguration)) {
    found.push('a configuration write does not move the generation on');
  }
  const update = member(src.plugin, /public override void UpdateConfiguration\(BasePluginConfiguration configuration\)/);
  if (!update || !/incoming\.ConfigurationGeneration != current\.ConfigurationGeneration/.test(update) || !/throw new ConfigurationConflictException/.test(update)) {
    found.push('Jellyfin\'s plugin-configuration route applies an earlier generation');
  }
  const restoreConfiguration = member(src.plugin, /internal Services\.Secrets\.SecretsMigration\.Report RestoreConfiguration\(/);
  if (!restoreConfiguration || /\bUpdateConfiguration\(/.test(restoreConfiguration)) found.push('a restored configuration goes through the host route\'s check');
  if (/SerializeToFile\(/.test(src.plugin.replace(saveConfiguration || '', ''))) found.push('the configuration is written past SaveConfiguration');
  if (!/o\.Filters\.AddService<Services\.HostConfigurationRouteFilter>\(\)/.test(src.registrator)) found.push('the host route\'s filter is not registered');
  if (!/executed\.Exception is ConfigurationConflictException/.test(src.filter) || !/ClientReloadNotice\.FromSession/.test(src.filter)) found.push('the host route\'s refusal is not answered visibly');
  return found;
}

/** Scan 7: one session-bound queue per document. */
function queueViolations(src) {
  const found = [];
  const operation = member(src.store, /const queueOperation = async \(fileName, operation, options = \{\}\) => /);
  if (!operation || !/state\.queue\.send\(async \(\) => \{/.test(operation)) found.push('a per-user document write goes out past its queue');
  if (/\.chain\.then\(/.test(src.store)) found.push('a per-user document has a chain of its own');
  if (!/state\.queue = JE\.core\.mutationQueue\(`settings:\$\{fileName\}`, \{ isCurrent: \(\) => isActiveDocument\(created\) \}\)/.test(src.store)) found.push('a document\'s queue is not bound to its session');
  const send = member(src.queue, /send\(transmit\) \{/);
  if (!send || !/const run = chain\.then\(\(\) => \{\s*if \(!current\(\)\)/.test(send)) found.push('the queue does not check the session right before each send');
  if (!/JE\.session\.onUserChange\(`mutation-queue:\$\{name\}`/.test(src.queue)) found.push('an account switch does not cancel the queue');
  return found;
}

const sources = () => Object.fromEntries(Object.keys(FILES).map(name => [name, read(name)]));
const SCANS = [['scan 5', revisionViolations], ['scan 6', fenceViolations], ['scan 7', queueViolations]];

test('scans 5-7: revisions count writes, every writer is fenced, one session-bound queue per document', () => {
  const src = sources();
  for (const [name, violations] of SCANS) assert.deepEqual(violations(src), [], name);
});

const PLANTS = [
  ['scan 5', 'a revision derived from the content (the R10-4 shape)', 'manager',
    'return incarnation + "." + (_writes.TryGetValue(path, out var n) ? n : 0).ToString(System.Globalization.CultureInfo.InvariantCulture);',
    'return Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(System.Text.Json.JsonSerializer.Serialize(GetUserConfiguration<object>(userId, fileName)))));'],
  ['scan 5', 'a save that keeps the revision', 'manager', '                    Advance(configPath);\n', ''],
  ['scan 5', 'a weak If-Match accepted (the R10-9 shape)', 'manager', '!tag.IsWeak && ', ''],
  ['scan 5', 'a lenient If-Match reading', 'manager', 'TryParseStrictList', 'TryParseList'],
  ['scan 5', 'a removed folder keeps the incarnation', 'manager', 'Directory.Delete(userDir, recursive: true));\n                NewIncarnation();', 'Directory.Delete(userDir, recursive: true));'],
  ['scan 6', 'a restore past the document locks (the R10-3 shape)', 'backup',
    'if (PersonalDocument(relative) is { } document) UserConfigurationManager.PlaceUserFile(document.Person, document.File, target, Place);', 'Place();'],
  ['scan 6', 'a restore that keeps the incarnation', 'backup', 'if (written > 0) UserConfigurationManager.NewIncarnation();', ''],
  ['scan 6', 'the host route applying an earlier generation (the R10-2 shape)', 'plugin',
    'if (configuration is PluginConfiguration incoming && current != null && incoming.ConfigurationGeneration != current.ConfigurationGeneration)', 'if (false)'],
  ['scan 6', 'a configuration write that keeps the generation', 'plugin', '                config.ConfigurationGeneration = next;\n', ''],
  ['scan 6', 'a restored configuration through the host route', 'plugin', '                    ApplyConfiguration(_ => restored);', '                    UpdateConfiguration(restored);'],
  ['scan 6', 'the host route\'s filter unregistered', 'registrator', '                o.Filters.AddService<Services.HostConfigurationRouteFilter>();\n', ''],
  ['scan 7', 'a write sent past its document\'s queue', 'store', 'const save = state.queue.send(async () => {', 'const save = (async () => {'],
  ['scan 7', 'a queue that checks the session only after the answer (the R10-1 shape)', 'queue',
    '                const run = chain.then(() => {\n                    if (!current()) {', '                const run = chain.then(() => {\n                    if (false) {'],
  ['scan 7', 'an account switch that leaves the queue running', 'queue', 'JE.session.onUserChange(`mutation-queue:${name}`', 'JE.session.onUserChange?.call(null, `mutation-queue-off:${name}`']
];
for (const [scan, label, file, anchor, line] of PLANTS) {
  test(`${scan} finds a plant: ${label}`, () => {
    const src = sources();
    const violations = SCANS.find(([name]) => name === scan)[1];
    assert.deepEqual(violations(src), [], 'the real source is clean');
    assert.ok(src[file].includes(anchor), `plant anchor missing: ${anchor}`);
    const planted = { ...src, [file]: src[file].replace(anchor, line) };
    assert.ok(violations(planted).length > 0, 'the plant is reported');
  });
}
