import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

const id = '0123456789abcdef0123456789abcdef';
const rules = [{ Id: 'tag:1a2b3c4d5e6f7081', Label: 'Plot fact' }];
const cases = [
  ['genre', 'Genre', 'genretags', 'genre-tag', { Genres: ['Mystery'] }],
  ['language', 'Language', 'languagetags', 'language-flag', { MediaStreams: [{ Type: 'Audio', Language: 'en' }] }],
  ['quality', 'Quality', 'qualitytags', 'quality-overlay-label', { MediaStreams: [{ Type: 'Video', Height: 2160, Codec: 'hevc' }] }],
  ['rating', 'Rating', 'ratingtags', 'rating-tag', { CommunityRating: 8.1 }],
  ['ageRating', 'AgeRating', 'ageratingtags', 'age-rating-tag', { OfficialRating: 'PG-13' }],
  ['awards', 'Awards', 'awardstags', 'awards-tag', { Awards: { OscarWinner: true } }],
  ['logos', 'Logo', 'logotags', 'je-logo-chip', { Logos: [{ kind: 'network', name: 'Northwind' }] }],
  ['custom', 'Custom', 'customtags', 'custom-tag', { CustomTags: [rules[0].Id] }],
];
async function page(t, group, store, prefetched, answer, responseStamp = prefetched) {
  const [name, init, file, chip] = group;
  const idle = [], timers = new Map(), saves = [], calls = [];
  let seq = 0;
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k,v) => store.set(k,String(v)), removeItem: k => store.delete(k),
    key: i => [...store.keys()][i] ?? null, get length() { return store.size; } };
  const h = createHarness({ html: `<div class="card" data-id="${id}" data-type="Movie"><div class="cardScalable"><div class="cardImageContainer"></div></div></div>`,
    JE: { currentSettings: { [`${init[0].toLowerCase()+init.slice(1)}TagsEnabled`]: true, qualityTagsPreferredAudioLanguage: 'none' },
      pluginConfig: { TagCacheServerMode: false, CustomTagRules: rules, AwardsTagsEnabled: true },
      t: k => k, cdn: { flagSvg: c => `/flags/${c}.svg` },
      takePrefetched: k => { if(prefetched instanceof Error) throw prefetched; return k === 'TagStripRevision' ? prefetched : undefined; },
      _cacheManager: { register: f => saves.push(f), markDirty() {} }, helpers: { onBodyMutation() {}, onNavigate() {}, addCSS() {} } },
    apiClient: { ajax: async o => { calls.push(o.url); return { Items: [{ Id: id, Type: 'Movie', ...answer }], StripRevision: responseStamp }; } },
    globals: { requestIdleCallback: f => idle.push(f), setTimeout: (f,ms) => { timers.set(++seq,{ f,ms }); return seq; }, clearTimeout: n => timers.delete(n) } });
  Object.defineProperty(h.window, 'localStorage', { value: storage, configurable: true });
  t.after(() => h.close());
  for (const f of ['core/ui-kit.js', 'core/media-language.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/tag-layout-styles.js', 'tags/rating-sources.js', 'tags/tag-pipeline.js', `tags/${file}.js`]) h.load(f);
  h.JE[`initialize${init}Tags`](); h.JE.tagPipeline.initialize();
  const flush = async () => { for (let n=0;n<8;n++) {
    await new Promise(r => setImmediate(r));
    while (idle.length) idle.shift()({ timeRemaining: () => 50, didTimeout: false });
    for (const [n,timer] of [...timers]) if (timer.ms === 150) { timers.delete(n); timer.f(); }
  } };
  await flush(); for (const save of saves) save();
  return { h, calls, chips: () => h.document.querySelectorAll(`.${chip}`).length, flush };
}
for (const group of cases) test(`${group[0]} shares authoritative fallback validation across pages and empty guarded answers`, async t => {
  const store = new Map(), data = group[4];
  const first = await page(t,group,store,'none',data);
  assert.equal(first.calls.length,1); assert.ok(first.chips()>0);
  const again = await page(t,group,store,'none',data);
  assert.equal(again.calls.length,0,'authoritative unstripped answer persists'); assert.ok(again.chips()>0);
  const guarded = await page(t,group,store,'g2:guarded',{});
  assert.equal(guarded.calls.length,1); assert.equal(guarded.chips(),0);
  guarded.h.JE.tagPipeline.clearProcessed(); guarded.h.JE.tagPipeline.scheduleScan(); await guarded.flush();
  assert.equal(guarded.calls.length,1,'matching empty result is a page-local hit');
  const guardedReload = await page(t,group,store,'g2:guarded',{});
  assert.equal(guardedReload.calls.length,1,'guarded answers never persist across pages'); assert.equal(guardedReload.chips(),0);
  const restored = await page(t,group,store,'none',data);
  assert.equal(restored.calls.length,1); assert.ok(restored.chips()>0);
  const unknown = await page(t,group,store,undefined,data,'none');
  assert.equal(unknown.calls.length,1,'failed/missing bootstrap is unknown'); assert.ok(unknown.chips()>0);
});

test('two factory groups reject raw hot entries, preserve unknown stored copies, bind writes to response provenance and invalidate both tiers', t => {
  const callbacks = new Map(), saves = [], changes = new Map(); let stamp = 'none';
  const h = createHarness({ JE: { pluginConfig: { TagCacheServerMode: false }, currentSettings: { on: true },
    session: { getUserId: () => 'a', getServerId: () => 's', onUserChange: (k,f) => changes.set(k,f) },
    _cacheManager: { register: f => saves.push(f), markDirty() {} },
    tagPipeline: { tagStripRevision: () => stamp, registerRenderer: (k,r) => callbacks.set(k,r) } } });
  t.after(() => h.close()); h.load('core/tag-renderer-base.js');
  for (const name of ['one','two']) {
    const ctx = h.JE.core.tagRenderer.register(name, { logPrefix:name, settingKey:'on', containerClass:name, taggedAttr:name,
      cache:{ key:name, legacyPrefix:`old-${name}`, hotBucket:name }, pipeline:{ render(c,el,item) { c.setPersistent(item.Id,item.data); } } });
    const r = callbacks.get(name), write = (value,revision) => r.render(null,{Id:'item',data:value},{stripRevision:revision});
    write('kept','none'); saves.at(-1)(); stamp = null;
    assert.equal(ctx.hot.get('item'),undefined); assert.equal(ctx.getPersistent('item'),undefined);
    assert.ok(h.window.localStorage.getItem(name).includes('kept'),'unknown does not initially destroy storage');
    stamp = 'g2:new'; write([], 'g2:response');
    assert.equal(h.JE._hotCache[name].get('item').stripRevision,'g2:response','stamp belongs to the response, not mutable current authority');
    assert.equal(ctx.hot.get('item'),undefined,'mismatched response is a miss');
    stamp = 'none'; h.JE._hotCache[name].set('item',{data:'legacy'});
    assert.equal(ctx.hot.get('item'),undefined,'a direct raw hot entry is untrusted');
    write('kept','none'); r.onServerCacheRefresh(['item']); assert.equal(ctx.hot.get('item'),undefined); assert.equal(ctx.getPersistent('item'),undefined);
    write('kept','none'); changes.get(`tag-cache-${name}`)({serverId:'s',userId:'b'}); assert.equal(ctx.hot.size,0); assert.equal(h.window.localStorage.getItem(name),null);
    stamp = 'none';
  }
});

test('a failed bootstrap read and a missing response stamp stay unknown and cannot bless a saved fallback', async t => {
  const group=cases[0],store=new Map();
  await page(t,group,store,'none',group[4]);
  const failed=await page(t,group,store,new Error('bootstrap unavailable'),group[4],null);
  assert.equal(failed.calls.length,1);
  assert.equal(failed.h.JE.tagPipeline.tagStripRevision(),null);
  assert.equal(failed.h.JE._hotCache.genre.size,0,'unknown response provenance never authorizes a hot write');
  const next=await page(t,group,store,undefined,group[4],null);
  assert.equal(next.calls.length,1,'unknown provenance requires a fresh answer on the next page');
});
