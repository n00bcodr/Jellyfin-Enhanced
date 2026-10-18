import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness } from '../helpers/harness.mjs';
import { repositoryRoot } from '../helpers/discovery.mjs';

const page = readFileSync(resolve(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced/Configuration/configPage.html'), 'utf8');
function section(start, end) {
    const from = page.indexOf(start);
    const to = page.indexOf(end, from);
    assert.ok(from >= 0 && to > from);
    return page.slice(from, to);
}
const html = section('                            <div class="checkboxContainer"><label><input id="arrPhase3Enabled"', '                            <div class="checkboxContainer"><label><input id="arrPhase2Enabled"');
const load = section("            document.querySelector('#arrPhase3Enabled').checked", "            document.querySelector('#arrPhase2Enabled').checked");
const save = section("            config.ArrPhase3Enabled =", "            config.ArrPhase2Enabled =");
const parents = section('        var PARENT_DEPS = [', '        ];') + '        ];';
const serverOwned = section('        var jeArrServerOwnedIds', '        /**\n         * Copies the phase-2 notification settings');

test('durable request settings round trip through actual config-page wiring without load traffic', t => {
    const h = createHarness({ html });
    t.after(() => h.close());
    h.window.eval(`${serverOwned} window.loadRequests = function(config) { ${load} }; window.saveRequests = function(config) { ${save} }; ${parents} window.requestParents = PARENT_DEPS;`);
    const config = {
        ArrPhase3Enabled: false, ArrRequestBackend: 'seerr', ArrRequest4kMoviesEnabled: false, ArrRequest4kSeriesEnabled: false, ArrStandardNeedsNonFourK: false, ArrRequestPreset: 'ask_first', ArrRequestDefaultRole: 'Watcher', ArrRequestUsers: '{}', ArrRequestRoles: '{}',
        ArrRequestQuotaLimit: 0, ArrRequestQuotaWindowDays: 7, ArrRequestSeriesThreshold: 4, ArrRequestDeclineCooldownDays: 7, ArrRequestPendingLimit: 10,
        ArrRequestQuotaGb: 0, ArrRequestStaleDays: 30, ArrRequestChargeFutureSeasons: true, ArrKidsHideSearch: false
    };
    h.window.loadRequests(config);
    const result = {};
    h.window.saveRequests(result);
    assert.deepEqual(result, config);
    h.document.getElementById('arrRequestUsers').value = '{"person":{"Role":"Manager","FourKInstances":["4k"]}}';
    h.document.getElementById('arrRequestBackend').value = 'je';
    h.document.getElementById('arrPhase3Enabled').checked = true;
    h.document.getElementById('arrRequestQuotaLimit').value = '3';
    h.document.getElementById('arrKidsHideSearch').checked = true;
    h.document.getElementById('arrStandardNeedsNonFourK').checked = true;
    h.window.saveRequests(result);
    assert.equal(result.ArrKidsHideSearch, true);
    assert.equal(result.ArrStandardNeedsNonFourK, true);
    assert.match(h.document.querySelector('label:has(#arrStandardNeedsNonFourK) span').textContent, /^Standard requests need a non-4K copy$/);
    assert.match(h.document.querySelector('label:has(#arrKidsHideSearch) span').textContent, /^Hide free-text search from Kids$/);
    assert.equal(result.ArrRequestBackend, 'je');
    assert.equal(result.ArrRequestQuotaLimit, 3);
    assert.equal(result.ArrPhase3Enabled, true);
    assert.equal(JSON.parse(result.ArrRequestUsers).person.Role, 'Manager');
    const phase1 = h.window.requestParents.find(p => p.parent === 'arrPhase1Enabled');
    const phase3 = h.window.requestParents.find(p => p.parent === 'arrPhase3Enabled');
    assert.ok(phase1.children.includes('arrPhase3Enabled'));
    // Every setting except the phase switch itself, plus the "Move requests from Seerr" button and the phase-4
    // automation engine (it needs phase 3 as well as phase 4).
    assert.equal(phase3.children.length, Object.keys(config).length + 1);
    assert.ok(phase3.children.includes('arrPhase4AutomationEnabled'));
    assert.ok(phase3.children.includes('arrSeerrMigrationBtn'));
    assert.ok(h.document.getElementById('arrSeerrMigrationBtn'));
    assert.ok(h.document.getElementById('arrSeerrMigrationResult'));
    assert.equal(h.document.querySelector('#arrRequestLabEnabled'), null);
});

test('a save from a page opened before a Household edit or a Seerr move keeps the server\'s household and request handling', t => {
    const h = createHarness({ html });
    t.after(() => h.close());
    h.window.eval(`${serverOwned} window.loadRequests = function(config) { ${load} }; window.saveRequests = function(config) { ${save} };`);
    const loaded = {
        ArrPhase3Enabled: true, ArrRequestBackend: 'seerr', ArrRequest4kMoviesEnabled: false, ArrRequest4kSeriesEnabled: false, ArrRequestPreset: 'ask_first', ArrRequestDefaultRole: 'Member',
        ArrRequestUsers: '{"kid":{"Role":"Member"}}', ArrRequestRoles: '{}', ArrRequestQuotaLimit: 0, ArrRequestQuotaWindowDays: 7, ArrRequestSeriesThreshold: 4, ArrRequestDeclineCooldownDays: 7,
        ArrRequestPendingLimit: 10, ArrRequestQuotaGb: 0, ArrRequestStaleDays: 30, ArrRequestChargeFutureSeasons: true, ArrKidsHideSearch: false
    };
    h.window.loadRequests(loaded);
    // Meanwhile, on the server: the Household tab made the child a Kid, set the default role and a limit,
    // and a move from Seerr switched request handling to Jellyfin Enhanced.
    const server = { ...loaded, ArrRequestUsers: '{"kid":{"Role":"Kid"}}', ArrRequestDefaultRole: 'Watcher', ArrRequestQuotaLimit: 3, ArrRequestBackend: 'je', ArrRequestRoles: '{"Kid":{"QuotaLimit":2}}' };
    // This page only changes an unrelated setting, and the house rules on purpose.
    h.document.getElementById('arrRequestStaleDays').value = '45';
    h.document.getElementById('arrRequestPreset').value = 'open_house';
    const saved = { ...server };
    h.window.saveRequests(saved);
    assert.equal(saved.ArrRequestStaleDays, 45);
    assert.equal(saved.ArrRequestPreset, 'open_house');            // changed here: the page's value
    assert.equal(saved.ArrRequestUsers, '{"kid":{"Role":"Kid"}}');  // untouched here: the server's
    assert.equal(saved.ArrRequestDefaultRole, 'Watcher');
    assert.equal(saved.ArrRequestQuotaLimit, 3);
    assert.equal(saved.ArrRequestRoles, '{"Kid":{"QuotaLimit":2}}');
    assert.equal(saved.ArrRequestBackend, 'je');
    // The page now shows what was saved, and a deliberate edit of a household field on it still wins.
    assert.equal(h.document.getElementById('arrRequestUsers').value, '{"kid":{"Role":"Kid"}}');
    assert.equal(h.document.getElementById('arrRequestBackend').value, 'je');
    h.document.getElementById('arrRequestUsers').value = '{"kid":{"Role":"Watcher"}}';
    const again = { ...server };
    h.window.saveRequests(again);
    assert.equal(again.ArrRequestUsers, '{"kid":{"Role":"Watcher"}}');
    assert.equal(again.ArrRequestBackend, 'je');
});

test('a save sends the server values it read, so the server can keep an edit that lands before the save does', t => {
    const h = createHarness({ html });
    t.after(() => h.close());
    h.window.eval(`${serverOwned} window.loadRequests = function(config) { ${load} }; window.saveRequests = function(config) { ${save} };`);
    const loaded = {
        ArrPhase3Enabled: true, ArrRequestBackend: 'seerr', ArrRequest4kMoviesEnabled: false, ArrRequest4kSeriesEnabled: false, ArrRequestPreset: 'ask_first', ArrRequestDefaultRole: 'Member',
        ArrRequestUsers: '{}', ArrRequestRoles: '{}', ArrRequestQuotaLimit: 0, ArrRequestQuotaWindowDays: 7, ArrRequestSeriesThreshold: 4, ArrRequestDeclineCooldownDays: 7,
        ArrRequestPendingLimit: 10, ArrRequestQuotaGb: 0, ArrRequestStaleDays: 30, ArrRequestChargeFutureSeasons: true, ArrKidsHideSearch: false
    };
    h.window.loadRequests(loaded);
    h.document.getElementById('arrRequestPreset').value = 'open_house';
    const saved = { ...loaded, ArrRequestQuotaLimit: 3 };
    h.window.saveRequests(saved);
    assert.deepEqual(JSON.parse(saved.ArrServerOwnedSeen), {
        ArrRequestBackend: 'seerr', ArrRequestPreset: 'ask_first', ArrRequestDefaultRole: 'Member', ArrRequestRoles: '{}', ArrRequestUsers: '{}', ArrRequestQuotaLimit: '3'
    });
    assert.equal(saved.ArrRequestPreset, 'open_house');
});
