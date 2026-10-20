// Phase 4f (D29): the configuration page's Ready block: the Ready playlist switch (under phase 4 and phase 3, not
// notifications), its lifetime (1–90 days, 30 by default) and the native Ready messages switch (under phase 4 and
// notifications), loaded and saved with the phase-4 settings, both off by default.
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
    assert.ok(from >= 0 && to > from, start);
    return page.slice(from, to);
}
const html = section('                            <!-- Requests & downloads, phase 4', '                            <!-- /Requests & downloads, phase 4 -->');
const functions = section('        /** The automation recipes the page lists', '        async function jeArrMigrationError(e) {');
const createEl = section('        function createEl(tag, attrs, children) {', '        // ==================== Stored credentials');
const parents = section('        var PARENT_DEPS = [', '        ];') + '        ];';

function setup(t) {
    const h = createHarness({ html });
    t.after(() => h.close());
    h.window.ApiClient = { getUrl: path => path, ajax: async () => ({}) };
    h.window.eval(`${createEl} ${functions} ${parents} window.load = jeLoadArrAutomationSettings; window.save = jeSaveArrAutomationSettings; window.deps = PARENT_DEPS;`);
    return h;
}

const ids = ['arrPhase4ReadyPlaylistEnabled', 'arrReadyRetentionDays', 'arrPhase4ReadyMessagesEnabled'];

test('the Ready block has a real label and a description for each setting, and no ${', t => {
    const block = section('<!-- Phase 4f: Ready playlist and native Ready messages -->', '<!-- /Phase 4f: Ready playlist and native Ready messages -->');
    const h = setup(t);
    for (const id of ids) {
        assert.ok(block.includes(`id="${id}"`), id);
        const input = h.document.getElementById(id);
        const label = input.closest('label')?.querySelector('span') || h.document.querySelector(`label[for="${id}"]`);
        assert.ok(label && label.textContent.trim().length > 5, `${id} has a label`);
    }
    for (const id of ['arrPhase4ReadyPlaylistEnabled', 'arrPhase4ReadyMessagesEnabled']) assert.ok(block.includes(`data-desc-for="${id}"`), id);
    assert.match(block, /keeps each playlist as it is/);
    assert.match(block, /turns it on again/);
    const days = h.document.getElementById('arrReadyRetentionDays');
    assert.deepEqual([days.type, days.min, days.max], ['number', '1', '90']);
    assert.ok(!block.includes('${'), 'Jellyfin rewrites ${ in the config page');
});

test('Ready settings round trip, off by default, the lifetime clamped to 1–90 and 30 by default', t => {
    const h = setup(t);
    h.window.load({});
    let out = {};
    h.window.save(out);
    assert.deepEqual([out.ArrPhase4ReadyPlaylistEnabled, out.ArrPhase4ReadyMessagesEnabled, out.ArrReadyRetentionDays], [false, false, 30]);
    h.window.load({ ArrPhase4ReadyPlaylistEnabled: true, ArrPhase4ReadyMessagesEnabled: true, ArrReadyRetentionDays: 14 });
    out = {};
    h.window.save(out);
    assert.deepEqual([out.ArrPhase4ReadyPlaylistEnabled, out.ArrPhase4ReadyMessagesEnabled, out.ArrReadyRetentionDays], [true, true, 14]);
    for (const [typed, want] of [['0', 1], ['91', 90], ['', 30], ['x', 30], ['45', 45]]) {
        h.document.getElementById('arrReadyRetentionDays').value = typed;
        out = {};
        h.window.save(out);
        assert.equal(out.ArrReadyRetentionDays, want, typed);
    }
});

test('the hierarchy: the playlist under phase 4 and phase 3 (not notifications), messages under phase 4 and notifications', t => {
    const deps = setup(t).window.deps;
    const parentsOf = id => JSON.parse(JSON.stringify(deps.filter(d => d.children.includes(id)).map(d => d.parent).sort()));
    assert.deepEqual(parentsOf('arrPhase4ReadyPlaylistEnabled'), ['arrPhase3Enabled', 'arrPhase4Enabled']);
    assert.deepEqual(parentsOf('arrPhase4ReadyMessagesEnabled'), ['arrNotificationsEnabled', 'arrPhase4Enabled']);
    assert.deepEqual(parentsOf('arrReadyRetentionDays'), ['arrPhase4ReadyPlaylistEnabled']);
});
