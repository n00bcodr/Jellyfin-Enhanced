// Actual web Status renderer vs the native resolver, with fixed time and remote facts.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHarness } from '../../frontend/helpers/harness.mjs';
import rows from './status-fixtures.mjs';
const en = JSON.parse(readFileSync(new URL('../../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json', import.meta.url), 'utf8'));
const seriesId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const pascalToCamel = o => Object.fromEntries(Object.entries(o).map(([k,v]) => [k[0].toLowerCase()+k.slice(1), v]));
for (const row of rows) {
    process.env.TZ = row.zone || 'UTC';
    const renderers = new Map();
    const settings = { statusTagsEnabled: true, statusTagsSeriesStatus: false, ...pascalToCamel(row.settings || {}) };
    const plugin = { StatusTagsEnabled: true, StatusTagsTrending: true, TmdbEnabled: true, TMDB_API_KEY: 'fixture', ...row.plugin };
    if (!plugin.TMDB_API_KEY) plugin.TmdbEnabled = false;
    // The public flag the server derives from a Leaving soon source (never the source itself).
    plugin.LeavingSoonAvailable = !!(plugin.LeavingSoonCollections || plugin.LeavingSoonMaintainerrUrl);
    const translate = (key, params = {}) => Object.entries(params).reduce((text, [k,v]) => text.replaceAll(`{${k}}`, String(v)), en[key] || key);
    const h = createHarness({
        html: '<div class="card" data-id="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer"></div><div class="je-tag-host"></div></div><div class="cardText">Title</div></div></div>',
        globals: { IntersectionObserver: class { constructor(cb) { this.cb=cb; } observe(target) { queueMicrotask(()=>this.cb([{target,isIntersecting:true}])); } unobserve() {} disconnect() {} } },
        JE: { currentSettings: settings, pluginConfig: plugin, t: translate, helpers: { onBodyMutation() { return ()=>{}; }, onNavigate() {} }, session: { getUserId: ()=> 'fixture', onUserChange() {} },
            tagPipeline: { registerRenderer: (name,r)=>renderers.set(name,r), getRenderer: name=>renderers.get(name), peekItemFacts: ()=>row.parent || null, peekServerEntry: ()=>row.parent || null, clearProcessed() {}, scheduleScan() {} } },
        apiClient: { getUrl: (path, params)=>`${path}?${new URLSearchParams(params)}`, ajax: async ({url}) => url.includes('/trending')
            ? { source:row.rankSource||(plugin.TMDB_API_KEY?'tmdb-day':null),movies:(plugin.TMDB_API_KEY||row.rankSource) && row.rank?{'1':row.rank}:{},series:(plugin.TMDB_API_KEY||row.rankSource) && row.rank?{'1':row.rank}:{} }
            : { [seriesId]: row.schedule || null } }
    });
    try {
        h.window.Date.now = () => row.now;
        h.document.documentElement.lang = row.locale || 'en-US';
        for (const script of ['core/ui-kit.js','core/tag-renderer-base.js','core/tag-layout.js','tags/status-vocabulary.js','tags/statustags.js']) h.load(script);
        // Native uses Corners for title/hover layouts; this fixture only selects supported layouts.
        h.JE.initializeStatusTags();
        const host = h.document.querySelector('.je-tag-host');
        if (renderers.get('status').isEnabled()) renderers.get('status').renderFromServerCache(host, row.entry, seriesId);
        await new Promise(resolve=>setTimeout(resolve,80));
        const chip = host.querySelector('.status-tag');
        row.web = chip ? { key: chip.dataset.jeStatus, text: chip.textContent } : null;
        const aliases = {just_added:'added',new_movie:'newMovie',new_series:'newSeries',new_episode:'newEpisode',trending_today:'trending',trending_week:'trending',
            leaving_soon:'leaving',leaving_today:'leaving',leaving_tomorrow:'leaving',leaving_days:'leaving'};
        const expected = row.expected ? { key:aliases[row.expected.key] || row.expected.key, text:row.expected.text } : null;
        assert.deepEqual(row.web, expected, row.name);
    } finally { h.close(); }
}
writeFileSync(new URL('./data/status-fixtures.json',import.meta.url),JSON.stringify(rows,null,2));
console.log(`Status web fixtures: ${rows.length} passed`);
