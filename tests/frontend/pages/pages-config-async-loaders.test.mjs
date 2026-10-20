import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repositoryRoot } from '../helpers/discovery.mjs';

// Stage 1 fix round 6: enumerate, don't remember. Every request the configuration page (and the Dashboard user pages and
// the settings panel) makes to read something is listed here. On the configuration page a read that fills a control the
// save writes must be one of the page's asynchronously filled fields (a "je-async-loader: <field>" marker naming a field
// made with jeAsyncField, whose completion settles through it); every other read is in the manifest with the reason it
// fills no saved control. A new read that is in neither fails, and so do the planted bypasses at the end.
const pagePath = resolve(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced/Configuration/configPage.html');
const page = readFileSync(pagePath, 'utf8');
const jsFile = path => readFileSync(resolve(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced/js', path), 'utf8');

const READ_CALL = /ApiClient\.(ajax|getJSON|getVirtualFolders|getUsers|getUser|getCurrentUser|getPluginConfiguration|getItem|getSessions|fetch)\s*\(|(?<![.\w])fetch\s*\(|\bapi\.(read|summary)\s*\(|\bJE\.readUserSettings\s*\(/;
const WRITE_METHOD = /\b(type|method):\s*'(POST|PUT|DELETE|PATCH)'/;

/** Every read call site of a source: line number, the call line and the five after it, and a marker above it. */
export function readSites(source) {
  const lines = source.split('\n');
  const sites = [];
  lines.forEach((line, i) => {
    if (!READ_CALL.test(line) || /^\s*(\/\/|\*)/.test(line)) return;
    const window = lines.slice(i, i + 6).join('\n');
    // The call's own options: its line and the next ones up to another call.
    let end = i + 1;
    while (end < Math.min(lines.length, i + 5) && !READ_CALL.test(lines[end])) end++;
    if (!/type:\s*'GET'/.test(line) && WRITE_METHOD.test(lines.slice(i, end).join('\n'))) return;
    const marker = lines.slice(Math.max(0, i - 3), i).map(l => /je-async-loader:\s*(.+)$/.exec(l)).find(Boolean);
    sites.push({ line: i + 1, window, fields: marker ? marker[1].split(',').map(s => s.trim()) : null });
  });
  return sites;
}

// Configuration page reads that fill no control a save writes, each with its reason. Each anchor matches one site.
const PAGE_MANIFEST = [
  ["headers: { 'X-Arr-ApiKey': apiKey }", 'Test button for an *arr connection: shows a result line'],
  ["await ApiClient.ajax({ type: 'GET', url: validationUrl });", 'Test button for a Seerr address: shows a result line'],
  ["url: ApiClient.getUrl('/Plugins'),", 'installed plugins: enables or disables dependent controls, never sets a value'],
  ['function checkCustomTabsConfigCompat() {\n            ApiClient.ajax({', "the Custom Tabs plugin's configuration: shape check for a banner"],
  ["            return ApiClient.ajax({\n                type: 'GET',\n                url: ApiClient.getUrl('/Plugins/' + CUSTOM_TABS_PLUGIN_ID", "the Custom Tabs plugin's configuration: read right before JE's own narrow write to it"],
  ['var fresh = await ApiClient.getPluginConfiguration(pluginId);\n            if (!fresh) return;', 'after a save: credential placeholders and *arr cards rebuilt from the saved configuration (each only if unedited when drawn)'],
  ["/JellyfinEnhanced/arr/admin/instances'), dataType: 'json' });", 'Check button: lists the saved instances'],
  ["/JellyfinEnhanced/arr/admin/notify'), dataType: 'json' });", 'notification status display'],
  ["type: what === 'provision' ? 'POST' : 'DELETE',", 'not a read: provisions or removes a webhook (method chosen at run time)'],
  ["/JellyfinEnhanced/arr/admin/live'), dataType: 'json' });", 'live-updates status display'],
  ["/JellyfinEnhanced/arr/admin/automation/status'), dataType: 'json' });", 'automation status display'],
  ["/JellyfinEnhanced/acquire/migration/seerr'), dataType: 'json' });", 'Seerr migration status display'],
  ["url: ApiClient.getUrl('/JellyfinEnhanced/jellyseerr/settings/' + type),", "admin-started import of Seerr's *arr instances: fills new cards from the admin's pick"],
  ["url: ApiClient.getUrl('/JellyfinEnhanced/jellyfin-urls'),", 'the same import: suggests the address *arr should call'],
  ["ApiClient.getJSON(ApiClient.getUrl('JellyfinEnhanced/spoiler-blur/apply-existing/status'))", 'Spoiler Guard apply-to-existing progress display'],
  ['ApiClient.getJSON(previewUrl)', 'Spoiler Guard apply-to-existing preview (counts)'],
  ["ApiClient.getUrl('JellyfinEnhanced/tag-styles/catalog')", 'the list of tags to style: the saved overrides come from the stored JSON model (tagStyles.serialize), never from the list'],
  ['ApiClient.getPluginConfiguration(pluginId).then((config) => {', 'the configuration read itself: until it succeeds no whole save runs (jeConfigSaveAllowed)'],
  ['const fresh = await ApiClient.getPluginConfiguration(pluginId);\n                    CUSTOM_TAB_MANAGED_ENTRIES', 'Custom Tabs owned flags: cache rollback after a failed write'],
  ["url: ApiClient.getUrl('/JellyfinEnhanced/MaintenanceMode/Status'),", "the server's clock, shown under the maintenance window"],
  ["fetch(ApiClient.getUrl('/JellyfinEnhanced/BrandingStatus')", 'branding image previews (files, not configuration)'],
  ["fetch(ApiClient.getUrl('/JellyfinEnhanced/BrandingImage'", 'a branding image preview'],
  ["url: ApiClient.getUrl('/JellyfinEnhanced/host-compat'),", 'plugin build banner'],
  ["url: ApiClient.getUrl('/JellyfinEnhanced/whats-new'),", '"new" badges on settings'],
  ['url: validationUrl, dataType: \'json\', headers: { \'X-Arr-ApiKey\': apiKeyVal }', 'path-mapping validation button: shows a result'],
  ["url: ApiClient.getUrl('/JellyfinEnhanced/jellyseerr/permission-audit'),", 'Seerr permission audit report'],
  ["const status = await ApiClient.ajax({ type: 'GET', url: url, dataType: 'json' });", 'MDBList account status display']
];

/** Registered field names (jeAsyncField('<name>', ...)). */
const registered = source => new Set([...source.matchAll(/jeAsyncField\('([^']+)'/g)].map(m => m[1]));

/** The configuration fields the page saves through a registered field (spec.field). */
const savedFields = source => [...source.matchAll(/jeAsyncField\('[^']+', \{ field: '([^']+)'/g)].map(m => m[1]);

/** Checks a configuration page source; returns the problems (empty when it holds). */
export function checkConfigPage(source) {
  const problems = [];
  const sites = readSites(source);
  const fields = registered(source);
  const lines = source.split('\n');
  const used = new Set();
  const anchorHits = new Map(PAGE_MANIFEST.map(([anchor]) => [anchor, 0]));
  for (const site of sites) {
    if (site.fields) {
      for (const field of site.fields) {
        used.add(field);
        if (!fields.has(field)) problems.push(`line ${site.line}: loader for "${field}", which is not a jeAsyncField`);
      }
      // The completion goes through the field: a settle() follows in the loader.
      if (!/\.settle\(/.test(lines.slice(site.line - 1, site.line + 119).join('\n'))) problems.push(`line ${site.line}: loader never settles its field`);
      continue;
    }
    const context = lines.slice(Math.max(0, site.line - 3), site.line + 5).join('\n');
    const hits = PAGE_MANIFEST.filter(([anchor]) => context.includes(anchor));
    if (hits.length !== 1) { problems.push(`line ${site.line}: unregistered read (${site.window.split('\n')[0].trim()})`); continue; }
    anchorHits.set(hits[0][0], anchorHits.get(hits[0][0]) + 1);
  }
  for (const [anchor, count] of anchorHits) if (count !== 1) problems.push(`manifest entry matched ${count} sites: ${anchor}`);
  for (const field of fields) if (!used.has(field)) problems.push(`field "${field}" has no loader marked for it`);
  // The save writes a registered field only through the field (saveInto / value()), never from its control.
  const build = source.slice(source.indexOf('function jeFormConfig(base, quiet)'), source.indexOf('async function runCustomTabsSync('));
  for (const field of savedFields(source)) {
    if (new RegExp(`config\\.${field}\\s*=`).test(build)) problems.push(`jeFormConfig writes ${field} directly`);
  }
  // No direct writes to a registered select's value by id outside the field helpers.
  for (const id of ['DefaultLanguage', 'qualityTagsPreferredAudioLanguage', 'autoMovieRequestServer', 'autoMovieRequestProfile', 'autoMovieRequestRootFolder']) {
    const direct = new RegExp(`(querySelector\\('#${id}'\\)|getElementById\\('${id}'\\))\\.value\\s*=[^=]`);
    if (direct.test(source)) problems.push(`#${id} is set directly instead of through jeSelectValue`);
  }
  return { problems, sites };
}

test('every read on the configuration page is a registered field loader or a listed non-control read', () => {
  const { problems, sites } = checkConfigPage(page);
  assert.deepEqual(problems, []);
  const loaders = sites.filter(s => s.fields);
  // Counted: 12 marked loader sites for the page's 12 kinds of asynchronously filled field, 27 other reads (round 7: a
  // save, the Custom Tabs owned flags and the cache-clear stamp no longer read first; they send only their changes).
  assert.equal(loaders.length, 12);
  assert.equal(sites.length - loaders.length, PAGE_MANIFEST.length);
  assert.equal(PAGE_MANIFEST.length, 27);
  assert.deepEqual([...registered(page)].sort(), [
    'AutoMovieRequestCustomProfileId', 'AutoMovieRequestCustomRootFolder', 'AutoMovieRequestCustomServerId', 'DEFAULT_REGION', 'DefaultLanguage',
    'JellyseerrImportBlockedUsers', 'MaintenanceModeAffectedUsers', 'QualityTagsPreferredAudioLanguage', 'SpoilerAutoEnableLibraryIds',
    'TagCacheExcludedLibraryIds', 'arr instance Defaults', 'arr instance LinkedLibraryIds'
  ]);
});

test('the configuration page has no template-literal interpolation (the dashboard rewrites it)', () => {
  assert.equal(page.includes('${'), false);
});

// Planted bypasses: each must make the check fail.
const LAST = '    })();\n</script>';
const plant = snippet => page.slice(0, page.lastIndexOf(LAST)) + snippet + page.slice(page.lastIndexOf(LAST));

test('planted: a new loader that sets a select directly fails the scan', () => {
  const planted = plant(`
        function loadNewList() {
            ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('/JellyfinEnhanced/new-list'), dataType: 'json' }).then(function(list) {
                var select = document.querySelector('#autoMovieRequestQualityMode');
                select.value = list[0];
            });
        }
`);
  const { problems } = checkConfigPage(planted);
  assert.deepEqual(problems.map(p => p.replace(/^line \d+: /, '')), ["unregistered read (ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('/JellyfinEnhanced/new-list'), dataType: 'json' }).then(function(list) {)"]);
});

test('planted: a loader marked for a field that is not registered fails the scan', () => {
  const planted = plant(`
        function loadOther() {
            // je-async-loader: SomethingElse
            ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('/JellyfinEnhanced/other'), dataType: 'json' }).then(function(x) { _x.settle(1, true); });
        }
`);
  assert.match(checkConfigPage(planted).problems.join('\n'), /"SomethingElse", which is not a jeAsyncField/);
});

test('planted: a marked loader whose completion bypasses the field fails the scan', () => {
  const planted = plant(`
        function loadBypass() {
            // je-async-loader: DefaultLanguage
            ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('/JellyfinEnhanced/locales2'), dataType: 'json' }).then(function(list) {
                document.getElementById('DefaultLanguage').value = list[0];
            });
        }
`);
  const problems = checkConfigPage(planted).problems.join('\n');
  assert.match(problems, /never settles its field/);
  assert.match(problems, /#DefaultLanguage is set directly/);
});

test('planted: the save writing a registered field from its control fails the scan', () => {
  const planted = page.replace('            _jeDefaultLanguageField.saveInto(config);', "            config.DefaultLanguage = document.querySelector('#DefaultLanguage').value || '';");
  assert.notEqual(planted, page);
  assert.match(checkConfigPage(planted).problems.join('\n'), /jeFormConfig writes DefaultLanguage directly/);
});

// The Dashboard user pages and the settings panel: no whole-form save exists there. The user pages send only the fields
// the administrator changed (with the revision they were read at); the panel saves one field per change event through
// the settings store, which refuses whole documents until it has read them. Their reads, counted:
const USER_PAGE_MANIFEST = [
  ['arr/adminusers/admin-users.js', 'ApiClient.getUser(ApiClient.getCurrentUserId())', 'administrator check before anything is shown'],
  ['arr/adminusers/admin-users.js', 'api.summary(request.signal)', 'per-user summary on the user cards (display)'],
  ['arr/adminusers/admin-users.js', 'api.read(id, request.signal)', 'the form is drawn only from this read; a save sends only changed fields with their revision'],
  ['arr/adminusers/admin-users-api.js', "const response = await fetch(ApiClient.getUrl('/JellyfinEnhanced/' + path), {", 'the transport behind read / summary / patch'],
  ['enhanced/settingspanel/ui-panel.js', "if (!await JE.readUserSettings('settings.json')) return;", 'the settings document read when the panel opens'],
  ['enhanced/settingspanel/ui-panel-language.js', "ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('/JellyfinEnhanced/locales'), dataType: 'json' }),", 'language list: shown; saved only on the person\'s change (one field)'],
  ['enhanced/settingspanel/ui-panel-language.js', "ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('/Localization/Cultures'), dataType: 'json' })", 'language names for that list'],
  ['enhanced/settingspanel/ui-panel-language.js', "const ghResp = await fetch('https://api.github.com", 'language list (GitHub probe): as above'],
  ['enhanced/settingspanel/ui-panel-settings.js', "const cultures = await ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('/Localization/Cultures'), dataType: 'json' });", 'audio language list: shown; saved only on the person\'s change (one field)'],
  ['enhanced/settingspanel/ui-panel-settings.js', 'await ApiClient.getSessions({ ControllableByUserId: userId })', 'devices for the remote-control picker (no setting)'],
  ['enhanced/settingspanel/ui-panel-settings.js', "ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl(`/Users/${userId}/Items?IncludeItemTypes=Playlist,BoxSet", 'random-source list: shown; saved only on the person\'s change (one field)'],
  ['enhanced/settingspanel/ui-panel-settings.js', 'const saved = await ApiClient.getItem(userId, savedId)', 'the name of a saved random source the list lacks (display)'],
  ['enhanced/settingspanel/ui-release-notes.js', 'const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);', 'release notes (display)']
];
const USER_PAGE_FILES = ['arr/adminusers/admin-users.js', 'arr/adminusers/admin-user-tabs.js', 'arr/adminusers/admin-users-api.js',
  'enhanced/settingspanel/ui-entry-points.js', 'enhanced/settingspanel/ui-panel.js', 'enhanced/settingspanel/ui-panel-hidden-content.js',
  'enhanced/settingspanel/ui-panel-language.js', 'enhanced/settingspanel/ui-panel-settings.js', 'enhanced/settingspanel/ui-panel-shortcut-editor.js',
  'enhanced/settingspanel/ui-panel-template.js', 'enhanced/settingspanel/ui-release-notes.js'];

test('every read on the Dashboard user pages and in the settings panel is listed, and none feeds a whole-form save', () => {
  const problems = [];
  const matched = new Map(USER_PAGE_MANIFEST.map(entry => [entry, 0]));
  let count = 0;
  for (const file of USER_PAGE_FILES) {
    const source = jsFile(file);
    for (const site of readSites(source)) {
      count++;
      const lines = source.split('\n');
      const context = lines[site.line - 1];
      const hits = USER_PAGE_MANIFEST.filter(([f, anchor]) => f === file && context.includes(anchor));
      if (hits.length !== 1) problems.push(`${file}:${site.line}: unlisted read (${site.window.split('\n')[0].trim()})`);
      else matched.set(hits[0], matched.get(hits[0]) + 1);
    }
    // Writes there are per field: the panel through JE.updateSettings({ <one key> }) / consents, the user pages through
    // api.patch(changes). No caller hands the store a whole form or JE.currentSettings.
    if (/saveUserSettings\('settings\.json',\s*JE\.currentSettings/.test(source)) problems.push(`${file}: saves JE.currentSettings whole`);
  }
  for (const [entry, n] of matched) if (n !== 1) problems.push(`manifest entry matched ${n} sites: ${entry[1]}`);
  assert.deepEqual(problems, []);
  assert.equal(count, USER_PAGE_MANIFEST.length);
  assert.equal(count, 13);
});
