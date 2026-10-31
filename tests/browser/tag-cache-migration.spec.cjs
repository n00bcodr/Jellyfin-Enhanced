const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const root = path.resolve(__dirname, '../..');
const currentSource = readFileSync(path.join(root, 'Jellyfin.Plugin.JellyfinEnhanced/js/tags/tag-cache-store.js'), 'utf8');

const currentSchema = Number(currentSource.match(/const ENTRY_SCHEMA = (\d+);/)[1]);

test('v1 tag cache upgrades in place while personal preferences and current-schema field unions survive', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async schema => {
    localStorage.setItem('personal-settings-sentinel', JSON.stringify({ tagScale: 'largest', tagGap: 'roomy', languageTagsPriority: 'French' }));
    // Version 1, exactly the integration branch's stores and key formats.
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('JellyfinEnhanced', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('tagCacheMeta', { keyPath: 'scope' });
        r.result.createObjectStore('tagCacheItems');
      };
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    const tx = db.transaction(['tagCacheMeta', 'tagCacheItems'], 'readwrite');
    tx.objectStore('tagCacheMeta').put({ scope: 'server:A', version: 42, timestamp: 20, entrySchema: schema, filterRevision: 'unchanged', servedAt: 10 });
    tx.objectStore('tagCacheItems').put({ Type: 'Movie', Awards: ['oscar'], Logos: [{ kind: 'studio', name: 'Oracle' }], CustomTags: ['tag:oracle'], sentinel: 'survives' }, 'server:A|item');
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    db.close();
  }, currentSchema);
  await page.reload(); // Closes the baseline connection, as a new plugin page would.
  await page.evaluate(source => { window.JellyfinEnhanced = {}; (0, eval)(source); }, currentSource);
  const result = await page.evaluate(async () => {
    const s = JellyfinEnhanced.tagCacheStore;
    const original = await s.getMany('server:A', ['item']);
    await s.putPosterColours('server:A', 1, new Map(Array.from({ length: 2005 }, (_, i) => ['art' + i, [100, 50, 20]])), 2000);
    await s.putPosterColours('server:B', 1, new Map([['other', [20, 50, 100]]]), 2000);
    await s.clearOtherScopes('server:A');
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('JellyfinEnhanced'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const result = { version: db.version, stores: [...db.objectStoreNames], meta: original.meta, entry: original.entries.get('item'),
      own: (await s.getPosterColours('server:A', 1)).size, other: (await s.getPosterColours('server:B', 1)).size,
      personal: JSON.parse(localStorage.getItem('personal-settings-sentinel')) };
    db.close();
    return result;
  });
  expect(result.version).toBe(2);
  expect(result.stores).toEqual(['posterColours', 'tagCacheItems', 'tagCacheMeta']);
  expect(result.meta).toMatchObject({ version: 42, entrySchema: currentSchema, timestamp: 20, filterRevision: 'unchanged' });
  expect(result.entry).toMatchObject({ sentinel: 'survives', Awards: ['oscar'], Logos: [{ kind: 'studio', name: 'Oracle' }], CustomTags: ['tag:oracle'] });
  expect(result.personal).toEqual({ tagScale: 'largest', tagGap: 'roomy', languageTagsPriority: 'French' });
  expect([result.own, result.other]).toEqual([2000, 0]);
});
