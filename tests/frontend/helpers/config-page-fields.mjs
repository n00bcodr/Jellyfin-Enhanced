import assert from 'node:assert/strict';
import { configPage, fieldBytes } from './config-page.mjs';

// Every asynchronously filled field of the configuration page, as the persisted-bytes cases drive it. Each spec says:
// the stored configuration, which request fills the field (route) and when it is made (at script load once, per
// configuration read, or once cached), how the administrator changes it while the list loads (if the control allows
// it) and after it loaded, and how to read the field's bytes from a saved configuration.
const BASE = { JellyseerrUrls: '', JellyseerrUrlMappings: '', Shortcuts: [] };

const instance = extra => JSON.stringify([{ Id: 'r1', Name: 'Radarr', Url: 'http://radarr.test', ApiKey: 'k', UrlMappings: '', Enabled: true, ...extra }]);
const radarrRow = saved => saved && JSON.parse(saved.RadarrInstances || '[]')[0];

/** Opens the first Radarr card (its add defaults load only then). */
async function openRadarrCard(p) {
  const details = p.document.querySelector('#radarrInstancesList details.arr-instance-card') || p.document.querySelector('#radarrInstancesList details');
  details.open = true;
  details.dispatchEvent(new p.window.Event('toggle'));
  await p.flush();
}
const choose = (selector, value) => p => p.choose(selector, value);
const tick = (selector) => p => p.choose(p.document.querySelector(selector), true);

export const FIELDS = [
  {
    name: 'Maintenance Mode affected users', field: 'MaintenanceModeAffectedUsers', route: 'mmUsers', reload: 'pageshow',
    config: { MaintenanceModeAffectedUsers: '["u1"]' },
    pendingChange: choose('#mmUsers_all', true), pendingExpected: '"all"',
    loadedChange: tick('.je-mm-user-cb[value="u2"]'), loadedExpected: JSON.stringify('["u1","u2"]'),
    stale: [{ id: 'zz', username: 'stale', hasImage: false }], staleGone: p => !p.document.querySelector('.je-mm-user-cb[value="zz"]')
  },
  {
    name: 'tag-cache excluded libraries', field: 'TagCacheExcludedLibraryIds', route: 'virtualFolders', reload: 'pageshow',
    config: { TagCacheExcludedLibraryIds: 'AAAA0000-0000-0000-0000-000000000001' },
    loadedChange: tick('#tagCacheExcludedLibraryList [data-library-id="bbbb0000000000000000000000000002"]'),
    loadedExpected: JSON.stringify('aaaa0000000000000000000000000001,bbbb0000000000000000000000000002'),
    stale: [{ Name: 'Stale', ItemId: 'ffff0000000000000000000000000009', CollectionType: 'movies' }],
    staleGone: p => !p.document.querySelector('#tagCacheExcludedLibraryList [data-library-id="ffff0000000000000000000000000009"]')
  },
  {
    name: 'Spoiler Guard auto-enable libraries', field: 'SpoilerAutoEnableLibraryIds', route: 'virtualFolders', routeIndex: 1, reload: 'pageshow',
    config: { SpoilerAutoEnableLibraryIds: 'cccc0000000000000000000000000003,gone' },
    loadedChange: tick('#spoilerAutoEnableLibraryList [data-library-id="aaaa0000000000000000000000000001"]'),
    loadedExpected: JSON.stringify('aaaa0000000000000000000000000001,cccc0000000000000000000000000003'),
    stale: [{ Name: 'Stale', ItemId: 'ffff0000000000000000000000000009', CollectionType: 'movies' }],
    staleGone: p => !p.document.querySelector('#spoilerAutoEnableLibraryList [data-library-id="ffff0000000000000000000000000009"]')
  },
  {
    name: 'Seerr import blocklist', field: 'JellyseerrImportBlockedUsers', route: 'users', reload: 'pageshow',
    config: { JellyseerrImportBlockedUsers: 'AA-11\ncc33' },
    loadedChange: tick('.blockedUserCheckbox[data-userid="bb22"]'), loadedExpected: JSON.stringify('cc33,bb22,aa11'),
    stale: [{ Name: 'stale', Id: 'zz-99' }], staleGone: p => !p.document.querySelector('.blockedUserCheckbox[data-userid="zz99"]')
  },
  {
    name: 'Default UI Language', field: 'DefaultLanguage', route: 'locales', reload: 'once',
    config: { DefaultLanguage: 'de' },
    pendingChange: choose('#DefaultLanguage', ''), pendingExpected: '""',
    loadedChange: choose('#DefaultLanguage', 'fr'), loadedExpected: '"fr"', select: '#DefaultLanguage'
  },
  {
    name: 'sound-tag audio language', field: 'QualityTagsPreferredAudioLanguage', route: 'cultures', reload: 'once',
    config: { QualityTagsPreferredAudioLanguage: 'ja' },
    pendingChange: choose('#qualityTagsPreferredAudioLanguage', ''), pendingExpected: '""',
    loadedChange: choose('#qualityTagsPreferredAudioLanguage', 'fr'), loadedExpected: '"fr"', select: '#qualityTagsPreferredAudioLanguage'
  },
  {
    name: 'Default Region', field: 'DEFAULT_REGION', route: 'regions', reload: 'pageshow',
    config: { DEFAULT_REGION: 'nz' },
    pendingChange: choose('#DEFAULT_REGION', 'DE'), pendingExpected: '"DE"',
    loadedChange: choose('#DEFAULT_REGION', 'AT'), loadedExpected: '"AT"', select: '#DEFAULT_REGION',
    stale: { ok: true, text: async () => 'XX\tStale land\n' }, staleGone: p => !p.document.querySelector('#DEFAULT_REGION option[value="XX"]')
  },
  {
    name: 'auto-movie Radarr server', field: 'AutoMovieRequestCustomServerId', route: 'radarrServers', reload: 'pageshow',
    config: { AutoMovieRequestQualityMode: 'custom', AutoMovieRequestCustomServerId: 2, AutoMovieRequestCustomProfileId: 7, AutoMovieRequestCustomRootFolder: '/films' },
    loadedChange: choose('#autoMovieRequestServer', '0'), loadedExpected: '0', select: '#autoMovieRequestServer',
    stale: [{ id: 9, name: 'Stale' }], staleGone: p => !p.document.querySelector('#autoMovieRequestServer option[value="9"]')
  },
  {
    name: 'auto-movie quality profile', field: 'AutoMovieRequestCustomProfileId', route: 'radarrDetails', reload: 'pageshow',
    config: { AutoMovieRequestQualityMode: 'custom', AutoMovieRequestCustomServerId: 2, AutoMovieRequestCustomProfileId: 7, AutoMovieRequestCustomRootFolder: '/films' },
    loadedChange: choose('#autoMovieRequestProfile', '4'), loadedExpected: '4', select: '#autoMovieRequestProfile',
    stale: { profiles: [{ id: 99, name: 'Stale' }], rootFolders: [] }, staleGone: p => !p.document.querySelector('#autoMovieRequestProfile option[value="99"]')
  },
  {
    name: 'auto-movie root folder', field: 'AutoMovieRequestCustomRootFolder', route: 'radarrDetails', reload: 'pageshow',
    config: { AutoMovieRequestQualityMode: 'custom', AutoMovieRequestCustomServerId: 2, AutoMovieRequestCustomProfileId: 7, AutoMovieRequestCustomRootFolder: '/films' },
    loadedChange: choose('#autoMovieRequestRootFolder', '/movies'), loadedExpected: '"/movies"', select: '#autoMovieRequestRootFolder',
    stale: { profiles: [], rootFolders: [{ path: '/stale' }] }, staleGone: p => !p.document.querySelector('#autoMovieRequestRootFolder option[value="/stale"]')
  },
  {
    name: '*arr instance add defaults', field: 'RadarrInstances[0].Defaults', route: 'addOptions', reload: 'pageshow', prepare: openRadarrCard,
    config: { RadarrInstances: instance({ Defaults: { QualityProfileId: 42, RootFolderPath: '/data/movies', Tags: [3, 2] } }) },
    bytes: saved => JSON.stringify(radarrRow(saved)?.Defaults),
    loadedChange: p => p.choose(p.document.querySelector('#radarrInstancesList .arr-instance-add-profile'), '5'),
    loadedExpected: JSON.stringify({ QualityProfileId: 5, RootFolderPath: '/data/movies', Tags: [2, 3] }),
    stale: { profiles: [{ id: 99, name: 'Stale' }], rootFolders: [{ path: '/stale' }] },
    staleGone: p => !p.document.querySelector('#radarrInstancesList .arr-instance-add-profile option[value="99"]')
  },
  {
    name: '*arr instance linked libraries', field: 'RadarrInstances[0].LinkedLibraryIds', route: 'arrLibraries', reload: 'cached',
    config: { RadarrInstances: instance({ LinkedLibraryIds: ['BBBB0000-0000-0000-0000-000000000002', 'gone0000'] }) },
    bytes: saved => JSON.stringify(radarrRow(saved)?.LinkedLibraryIds),
    loadedChange: tick('#radarrInstancesList .arr-instance-library[data-library-id="aaaa0000000000000000000000000001"]'),
    loadedExpected: JSON.stringify(['aaaa0000000000000000000000000001', 'bbbb0000000000000000000000000002', 'gone0000']),
    stale: [{ Name: 'Stale', ItemId: 'ffff0000000000000000000000000009' }],
    staleGone: p => !p.document.querySelector('#radarrInstancesList .arr-instance-library[data-library-id="ffff0000000000000000000000000009"]')
  }
];

/** The field's bytes in a saved configuration. */
export const bytesOf = (spec, saved) => spec.bytes ? spec.bytes(saved) : fieldBytes(saved, spec.field);

/** Holds the spec's next list request (an earlier request on the same route goes through). */
function holdList(p, spec) {
  for (let i = 0; i < (spec.routeIndex || 0); i++) p.hold(spec.route).resolve();
  return p.hold(spec.route);
}

/** A page with the spec's stored configuration; `gateAtLoad` holds the list a script-load field requests at once. */
export function open(t, spec, { gateAtLoad = false } = {}) {
  let gate;
  const p = configPage(t, {
    config: { ...BASE, ...spec.config },
    before: gateAtLoad ? page => { gate = holdList(page, spec); } : undefined
  });
  p.storedBytes = bytesOf(spec, p.server.config);
  p.gate = gate;
  return p;
}

/** At most one temporary option in the field's select. */
function assertOnePlaceholder(p, spec) {
  if (!spec.select) return;
  assert.ok(p.document.querySelectorAll(`${spec.select} option[data-je-placeholder]`).length <= 1, 'at most one temporary option');
}

/** Loads the page with the list held (for a script-load field, the hold made at load), ready for the case. */
async function pending(t, spec) {
  if (spec.reload === 'once') {
    const p = open(t, spec, { gateAtLoad: true });
    await p.pageshow();
    return { p, gate: p.gate };
  }
  const p = open(t, spec);
  const gate = holdList(p, spec);
  await p.pageshow();
  if (spec.prepare) await spec.prepare(p);
  return { p, gate };
}

async function loaded(t, spec) {
  const p = open(t, spec);
  await p.pageshow();
  if (spec.prepare) await spec.prepare(p);
  return p;
}

/**
 * The generated cases: six per field. Each asserts the persisted bytes of the field after the save. Bounded: one page
 * per case, a fixed list of fields, no unbounded comparisons (strings only).
 */
export const CASES = {
  'save while the list is pending keeps the stored bytes': async (t, spec) => {
    const { p } = await pending(t, spec);
    const saved = await p.save();
    assert.equal(bytesOf(spec, saved), p.storedBytes);
  },
  'save after the list failed keeps the stored bytes': async (t, spec) => {
    const { p, gate } = await pending(t, spec);
    await gate.reject();
    assertOnePlaceholder(p, spec);
    const saved = await p.save();
    assert.equal(bytesOf(spec, saved), p.storedBytes);
  },
  'save after the list loaded, unchanged, keeps the stored bytes': async (t, spec) => {
    const p = await loaded(t, spec);
    assertOnePlaceholder(p, spec);
    const saved = await p.save();
    assert.equal(bytesOf(spec, saved), p.storedBytes);
  },
  'an admin change is saved, also one made while the list loads': async (t, spec) => {
    if (spec.pendingChange) {
      const { p, gate } = await pending(t, spec);
      await spec.pendingChange(p);
      await gate.resolve();
      assertOnePlaceholder(p, spec);
      const saved = await p.save();
      assert.equal(bytesOf(spec, saved), spec.pendingExpected, 'the change made while the list loaded survives its arrival');
    }
    const p = await loaded(t, spec);
    await spec.loadedChange(p);
    const saved = await p.save();
    assert.equal(bytesOf(spec, saved), spec.loadedExpected);
  },
  'loaded, then a reload that fails: a save keeps the stored bytes': async (t, spec) => {
    if (spec.reload === 'pageshow') {
      const p = await loaded(t, spec);
      const gate = holdList(p, spec);
      await p.pageshow();
      if (spec.prepare) await spec.prepare(p);
      await gate.reject();
      const saved = await p.save();
      assert.equal(bytesOf(spec, saved), p.storedBytes);
      return;
    }
    if (spec.reload === 'cached') {
      // The list is read once per page and cached: a failed read is read again by the next configuration read.
      const { p, gate } = await pending(t, spec);
      await gate.reject();
      await p.pageshow();
      const saved = await p.save();
      assert.equal(bytesOf(spec, saved), p.storedBytes);
      return;
    }
    // Read once per page: the reload that fails is the configuration read (the form keeps the read before it).
    const p = await loaded(t, spec);
    const read = p.hold('pluginConfig');
    await p.pageshow();
    await read.reject();
    const saved = await p.save();
    assert.equal(bytesOf(spec, saved), p.storedBytes);
  },
  'overlapping loads: a superseded completion is ignored': async (t, spec) => {
    if (spec.reload === 'once') {
      // One list for the page; two configuration reads while it loads: the later stored value is shown and kept.
      const { p, gate } = await pending(t, spec);
      p.server.config[spec.field] = 'fr';
      await p.pageshow();
      await gate.resolve();
      assertOnePlaceholder(p, spec);
      assert.equal(p.$(spec.select).value, 'fr');
      const saved = await p.save();
      assert.equal(bytesOf(spec, saved), '"fr"');
      return;
    }
    const p = open(t, spec);
    const first = holdList(p, spec);
    await p.pageshow();
    if (spec.prepare) await spec.prepare(p);
    const second = spec.reload === 'cached' ? first : holdList(p, spec);
    await p.pageshow();
    if (spec.prepare) await spec.prepare(p);
    if (spec.reload === 'cached') {
      await first.resolve();
    } else {
      await second.resolve();
      await first.resolve(spec.stale);
      assert.ok(spec.staleGone(p), 'the superseded list is not shown');
    }
    assertOnePlaceholder(p, spec);
    const saved = await p.save();
    assert.equal(bytesOf(spec, saved), p.storedBytes);
  }
};
