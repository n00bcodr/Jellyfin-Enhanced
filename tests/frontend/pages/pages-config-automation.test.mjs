import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness } from '../helpers/harness.mjs';
import { repositoryRoot } from '../helpers/discovery.mjs';
// Stage 1 fix round 12: the fragments' writes go through the page's own origin contract (jeAdminSend and the rest).
import { adminOriginSource } from '../helpers/config-page.mjs';

const page = readFileSync(resolve(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced/Configuration/configPage.html'), 'utf8');
function section(start, end) {
    const from = page.indexOf(start);
    const to = page.indexOf(end, from);
    assert.ok(from >= 0 && to > from, start);
    return page.slice(from, to);
}
const html = section('                            <!-- Requests & downloads, phase 4', '                            <!-- /Requests & downloads, phase 4 -->');
const functions = section('        /** The automation recipes the page lists', '        async function jeArrMigrationError(e) {');
const createEl = section('        function createEl(tag, attrs, children) {', '        // ==================== Stored credentials');
const parents = section('        var PARENT_DEPS = [', '        ];') + '        ];';

/**
 * A harness with the phase-4 section and its functions, and a stub ApiClient that answers the status route.
 * @param {object} [status] Status body (or an Error to fail).
 * @returns {{h: object, calls: Array}} Harness and recorded calls.
 */
function setup(status) {
    const h = createHarness({ html });
    const calls = [];
    h.window.ApiClient = {
        // Stage 1 fix round 12: the signed-in administrator (the page's writes go out only while it is the same one).
        getCurrentUserId: () => 'admin-a',
        getUrl: path => path,
        ajax: async options => {
            calls.push(options);
            if (status instanceof Error) throw status;
            return options.type === 'GET' ? status : {};
        },
    };
    h.window.eval(`${adminOriginSource()}
${createEl} ${functions} ${parents} window.load = jeLoadArrAutomationSettings; window.save = jeSaveArrAutomationSettings; window.statusNow = jeArrAutomationStatus; window.deps = PARENT_DEPS;`);
    return { h, calls };
}

const instances = {
    RadarrInstances: JSON.stringify([{ Id: 'r1', Name: 'Radarr' }]),
    SonarrInstances: JSON.stringify([{ Id: 's1', Name: 'Sonarr' }]),
};

test('phase-4 automation settings round trip: switches, budgets, recipe modes, kill switches (kept for gone instances)', t => {
    const { h } = setup();
    t.after(() => h.close());
    const config = {
        ...instances,
        ArrPhase4Enabled: true, ArrPhase4AutomationEnabled: true, ArrAutomationShadowOverride: true, ArrAutomationKillAll: false, ArrAutomationFree: true,
        ArrAutomationHouseholdAddsPerDay: 5, ArrAutomationSearchesPerHour: 7, ArrAutomationSearchesPerDay: 70, ArrAutomationSeerrPostsPerDay: 3,
        ArrAutomationSourceFetchesPerHour: 9, ArrAutomationDeltaWorkPerHour: 99,
        ArrAutomationRecipes: JSON.stringify({ auto_season: { mode: 'auto', killed: true }, auto_movie: { mode: 'NONSENSE' } }),
        ArrAutomationKilledInstances: 'S1,gone-instance',
    };
    h.window.load(config);
    assert.equal(h.document.getElementById('arrAutomationRecipe_auto_season').value, 'auto');
    assert.equal(h.document.getElementById('arrAutomationKill_auto_season').checked, true);
    assert.equal(h.document.getElementById('arrAutomationRecipe_auto_movie').value, 'shadow');   // unknown reads as Shadow
    assert.equal(h.document.getElementById('arrAutomationRecipe_keep_up').value, 'shadow');      // not stored: Shadow
    const targets = [...h.document.querySelectorAll('#arrAutomationKilledTargets input')];
    assert.deepEqual(targets.map(i => [i.dataset.target, i.checked]), [['r1', false], ['s1', true], ['seerr', false]]);
    const out = {};
    h.window.save(out);
    assert.equal(out.ArrAutomationShadowOverride, true);
    assert.equal(out.ArrAutomationFree, true);
    assert.deepEqual([out.ArrAutomationHouseholdAddsPerDay, out.ArrAutomationSearchesPerHour, out.ArrAutomationSearchesPerDay, out.ArrAutomationSeerrPostsPerDay, out.ArrAutomationSourceFetchesPerHour, out.ArrAutomationDeltaWorkPerHour], [5, 7, 70, 3, 9, 99]);
    const recipes = JSON.parse(out.ArrAutomationRecipes);
    assert.deepEqual(recipes.auto_season, { mode: 'auto', killed: true });
    assert.deepEqual(recipes.auto_movie, { mode: 'shadow', killed: false });
    assert.equal(Object.keys(recipes).length, 7);
    assert.deepEqual(out.ArrAutomationKilledInstances.split(',').sort(), ['gone-instance', 's1']);

    h.document.getElementById('arrAutomationHouseholdAddsPerDay').value = '-4';
    h.document.getElementById('arrAutomationSearchesPerHour').value = 'abc';
    h.document.getElementById('arrAutomationKillTarget_2').checked = true;
    h.window.save(out);
    assert.equal(out.ArrAutomationHouseholdAddsPerDay, 0);
    assert.equal(out.ArrAutomationSearchesPerHour, 30);
    assert.ok(out.ArrAutomationKilledInstances.split(',').includes('seerr'));
});

test('defaults: an older saved configuration loads every phase-4 switch off and the documented budgets', t => {
    const { h } = setup();
    t.after(() => h.close());
    h.window.load({});
    const out = {};
    h.window.save(out);
    assert.equal(out.ArrPhase4Enabled, false);
    assert.equal(out.ArrPhase4AutomationEnabled, false);
    assert.equal(out.ArrAutomationShadowOverride, false);
    assert.equal(out.ArrAutomationKillAll, false);
    assert.deepEqual([out.ArrAutomationHouseholdAddsPerDay, out.ArrAutomationSearchesPerHour, out.ArrAutomationSearchesPerDay, out.ArrAutomationSeerrPostsPerDay], [20, 30, 300, 20]);
    assert.ok(Object.values(JSON.parse(out.ArrAutomationRecipes)).every(r => r.mode === 'shadow' && r.killed === false));
    assert.equal(out.ArrAutomationKilledInstances, '');
});

const LIST_IMPORT_SWITCHES = ['ArrPhase4ListImportEnabled', 'ArrPhase4ListSourcesEnabled', 'ArrPhase4ListMdblistEnabled', 'ArrPhase4ListMdblistApiEnabled',
    'ArrPhase4ListTmdbEnabled', 'ArrPhase4ListChronolistsEnabled', 'ArrPhase4ListTraktEnabled', 'ArrPhase4ListImdbEnabled', 'ArrPhase4ListJeMetadataEnabled'];

test('list import and sources (phase 4c2): every switch defaults off, round-trips, and hangs under its parent', t => {
    const { h } = setup();
    t.after(() => h.close());
    h.window.load({});
    const off = {};
    h.window.save(off);
    for (const key of LIST_IMPORT_SWITCHES) assert.equal(off[key], false, key);
    h.window.load(Object.fromEntries(LIST_IMPORT_SWITCHES.map(k => [k, true])));
    const on = {};
    h.window.save(on);
    for (const key of LIST_IMPORT_SWITCHES) assert.equal(on[key], true, key);
    assert.ok(!('ArrListTraktApiKey' in on), 'the Trakt client ID is a stored credential, saved with the other secrets');
    const child = (parent, id) => h.window.deps.some(d => d.parent === parent && d.children.includes(id));
    assert.ok(child('arrPhase4ListAuthoringEnabled', 'arrPhase4ListImportEnabled'));
    assert.ok(child('arrPhase4ListImportEnabled', 'arrPhase4ListSourcesEnabled'));
    for (const id of ['arrPhase4ListMdblistEnabled', 'arrPhase4ListTmdbEnabled', 'arrPhase4ListChronolistsEnabled', 'arrPhase4ListTraktEnabled', 'arrPhase4ListImdbEnabled'])
        assert.ok(child('arrPhase4ListSourcesEnabled', id), id);
    assert.ok(child('arrPhase4ListMdblistEnabled', 'arrPhase4ListMdblistApiEnabled'));
    assert.ok(child('arrPhase4ListTraktEnabled', 'arrListTraktApiKey'));
    assert.ok(child('arrPhase4ListPlaceholdersEnabled', 'arrPhase4ListJeMetadataEnabled'));
});

test('the switch hierarchy: phase 4 under phase 1, the engine under phase 4 and phase 3, the rollout guard under nothing', t => {
    const { h } = setup();
    t.after(() => h.close());
    const deps = h.window.deps;
    const child = (parent, id) => deps.find(d => d.parent === parent).children.includes(id);
    assert.ok(child('arrPhase1Enabled', 'arrPhase4Enabled'));
    assert.ok(child('arrPhase4Enabled', 'arrPhase4AutomationEnabled'));
    assert.ok(child('arrPhase3Enabled', 'arrPhase4AutomationEnabled'));
    for (const id of ['arrAutomationKillAll', 'arrAutomationHouseholdAddsPerDay', 'arrAutomationFree', 'arrAutomationRecipe_auto_season', 'arrAutomationRecipe_list_sync_requests'])
        assert.ok(child('arrPhase4AutomationEnabled', id), id);
    assert.ok(!deps.some(d => d.children.includes('arrAutomationShadowOverride')), 'the rollout guard is never disabled by a parent');
    assert.match(h.document.querySelector('label:has(#arrAutomationShadowOverride) span').textContent, /^Rollout guard: Shadow only/);
});

test('the status panel lists the guard, budgets with their time, breakers, held work, the Seerr boundary and the notice', async t => {
    const status = {
        phase4: { enabled: true, effective: true }, engine: { enabled: true, effective: true }, shadowOverride: true, killAll: true, backend: 'seerr',
        recipes: [{ id: 'auto_season', mode: 'auto', effective: 'shadow', reason: 'shadow_override', killed: false }, { id: 'release_day', mode: 'auto' }],
        budgets: [{ category: 'seerr_post', scopeName: 'Seerr', window: '24h', used: 20, limit: 20, uncertain: 1, nextSlotAt: '2026-10-18T06:00:00Z' }, { category: 'backfill_search', scopeName: 'x', window: '1h', used: 0, limit: 10, reserved: true }],
        targets: [{ id: 'r1', name: 'Radarr', breakerFailures: 5, breakerOpenUntil: '2026-10-17T07:00:00Z' }, { id: 'seerr', name: 'Seerr' }],
        held: { budget_exhausted: 2, shadow_override: 0 },
        migration: { kind: 'upgrade', at: '2026-10-17T06:00:00Z', autoSeason: true, autoMovie: false, notice: 'pending', grants: [{ userId: 'u1', name: 'Dad' }] },
    };
    const { h, calls } = setup(status);
    t.after(() => h.close());
    await h.window.statusNow();
    const text = h.document.getElementById('arrAutomationStatus').textContent;
    assert.match(text, /Rollout guard on/);
    assert.match(text, /Kill switch on/);
    assert.match(text, /in effect: shadow\) \(rollout guard on\)/);
    assert.match(text, /Requests sent to Seerr, Seerr, last 24h: 20 of 20 \(1 waiting for a read-back\); room again/);
    assert.doesNotMatch(text, /Backfill/);
    assert.match(text, /Radarr: automatic sends paused after 5 failures/);
    assert.match(text, /2 automatic request\(s\) waiting: budget used up/);
    assert.doesNotMatch(text, /rollout guard\./);
    assert.match(text, /Once Seerr accepts a request, Seerr and its Sonarr\/Radarr decide/);
    assert.match(text, /next season Auto, next movie Off/);
    assert.match(text, /Managers keep their automatic requests going ahead .*Dad/);
    const buttons = [...h.document.querySelectorAll('#arrAutomationStatus button')];
    assert.equal(buttons.length, 2);
    buttons[0].click();
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(JSON.parse(calls.find(c => c.type === 'POST').data), { target: 'r1' });
    assert.equal(calls.find(c => c.type === 'POST').url, '/JellyfinEnhanced/arr/admin/automation/breakers/reset');
    buttons[1].click();
    await new Promise(r => setTimeout(r, 0));
    assert.ok(calls.some(c => c.type === 'POST' && c.url === '/JellyfinEnhanced/arr/admin/automation/notice/dismiss'));
});

test('a refused status read says who may read it, and nothing else', async t => {
    const error = Object.assign(new Error('403'), { status: 403 });
    const { h } = setup(error);
    t.after(() => h.close());
    await h.window.statusNow();
    assert.match(h.document.getElementById('arrAutomationStatus').textContent, /^✗ Only administrators can read this/);
});
