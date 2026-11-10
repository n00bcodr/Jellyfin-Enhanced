import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHarness, deferred, jsonResponse, plain } from '../helpers/harness.mjs';

function setup(t, options = {}) {
 const h = createHarness(options); t.after(() => h.close());
 h.loadShared = name => {
  // Optional isolated generated artifacts while another shared-checkout owner is compiling.
  if (process.env.JE_SHARED_ASSETS) h.window.eval(readFileSync(`${process.env.JE_SHARED_ASSETS}/${name}.js`, 'utf8'));
  else h.load(`enhanced/${name}.js`);
 };
 return h;
}
function core(h) { for (const n of ['navigation','session','lifecycle','dom-observer','ui-kit']) h.load(`core/${n}.js`); }

test('shared item cache isolates server/token changes and rejects stale continuations', async t => {
 let server = 'one', token = 'one'; const pending = [];
 const h = setup(t, {apiClient: {serverId: () => server, accessToken: () => token, getItem: () => { const d = deferred(); pending.push(d); return d.promise; }}});
 h.loadShared('helpers');
 const old = h.JE.helpers.getItemCached('x'); server = 'two';
 const fresh = h.JE.helpers.getItemCached('x');
 pending[0].resolve({Id:'x', Name:'private'}); assert.equal(await old, null);
 pending[1].resolve({Id:'x', Name:'current'}); assert.equal((await fresh).Name,'current');
 token = 'new-token'; const renewed = h.JE.helpers.getItemCached('x'); assert.equal(pending.length,3);
 pending[2].resolve({Id:'x'}); await renewed;
});

test('item cache validates unknown responses and an older rejection cannot evict a newer promise', async t => {
 const pending=[];const h=setup(t,{apiClient:{getItem:()=>{const d=deferred();pending.push(d);return d.promise;}}});h.loadShared('helpers');
 const old=h.JE.helpers.getItemCached('x');const fresh=h.JE.helpers.getItemCached('x',{forceRefresh:true});
 pending[0].reject(new Error('old'));await assert.rejects(old,/old/);
 const joined=h.JE.helpers.getItemCached('x');assert.equal(pending.length,2);
 pending[1].resolve({Id:'x'});await Promise.all([fresh,joined]);
 const malformed=h.JE.helpers.getItemCached('bad');pending[2].resolve({Id:42});await assert.rejects(malformed,/Invalid Jellyfin item Id/);
 const retry=h.JE.helpers.getItemCached('bad');pending[3].resolve({Id:'bad'});await retry;
});

test('helper owner survives repeated entry evaluation and session A-B-A revokes old work', async t => {
 const d=deferred();let user='a';const h=setup(t,{apiClient:{getCurrentUserId:()=>user,getItem:()=>d.promise}});core(h);h.loadShared('helpers');
 const owner=h.JE.helpers;h.loadShared('helpers');assert.equal(h.JE.helpers,owner);
 const old=owner.getItemCached('x');user='b';h.JE.session.checkNow('test');user='a';h.JE.session.checkNow('test');d.resolve({Id:'x'});assert.equal(await old,null);
});

test('cleared avatar promises cannot repopulate cache or delete newer in-flight work', async t => {
 const pending=[];const h=setup(t,{fetch:()=>{const d=deferred();pending.push(d);return d.promise;}});h.loadShared('helpers');
 let created=0;h.window.URL.createObjectURL=()=>`blob:${++created}`;h.window.URL.revokeObjectURL=()=>{};
 const path='/JellyfinEnhanced/proxy/avatar?path=one';const old=h.JE.helpers.resolveProtectedAvatarUrl(path);await Promise.resolve();
 h.JE.helpers.clearAvatarObjectUrlCache(true);const fresh=h.JE.helpers.resolveProtectedAvatarUrl(path);await Promise.resolve();
 pending[0].resolve(new Response('old'));assert.equal(await old,'');assert.equal(created,0);
 const joined=h.JE.helpers.resolveProtectedAvatarUrl(path);await Promise.resolve();assert.equal(pending.length,2);
 pending[1].resolve(new Response('fresh'));assert.deepEqual(await Promise.all([fresh,joined]),['blob:1','blob:1']);
});

test('avatar hydration rejects a recycled image source', async t => {
 const d=deferred();const h=setup(t,{html:'<img class="je-request-avatar" data-avatar-src="/JellyfinEnhanced/proxy/avatar?one">',fetch:()=>d.promise});h.loadShared('helpers');
 h.window.URL.createObjectURL=()=> 'blob:old';h.window.URL.revokeObjectURL=()=>{};
 const img=h.document.querySelector('img');h.JE.helpers.hydrateAvatarImages(h.document);img.setAttribute('data-avatar-src','/other');
 d.resolve(new Response('image'));await new Promise(r=>setTimeout(r,10));assert.equal(img.getAttribute('src'),null);
});

test('sidebar replacement unregister cannot remove its successor and releases the last subscription', t => {
 const h=setup(t);core(h);h.loadShared('helpers');const helpers=h.JE.helpers;
 const old=helpers.onSidebarRebuilt('x','.x',()=>{});const fresh=helpers.onSidebarRebuilt('x','.x',()=>{});old();
 assert.equal(h.JE.core.dom.getBodySubscriberCount(),1);fresh();assert.equal(h.JE.core.dom.getBodySubscriberCount(),0);
});

test('nested tabs reconcile class activation and teardown removes mutation work', async t => {
 const h=setup(t,{html:'<div class="page"><div class="tabContent"><div id="target"></div></div></div>'});core(h);h.loadShared('helpers');
 const target=h.document.querySelector('#target');assert.equal(h.JE.helpers.isActiveTabContainer(target),false);
 let calls=0;const life=h.JE.helpers.observeTabContainers('test','#target',()=>calls++);
 await new Promise(r=>setTimeout(r,60));const before=calls;
 target.parentElement.classList.add('is-active');await new Promise(r=>setTimeout(r,60));assert.ok(calls>before);assert.equal(h.JE.helpers.isActiveTabContainer(target),true);
 life.teardown();const stopped=calls;target.parentElement.hidden=true;await new Promise(r=>setTimeout(r,60));assert.equal(calls,stopped);
});

function translations(t, fetch) {
 const h=setup(t,{JE:{pluginVersion:'v',cdn:{url:(source,path)=>`http://jellyfin.test/cdn/${source}/${path}`}},apiClient:{getCurrentUser:()=>({Id:'a'})},fetch});h.loadShared('translations');return h;
}
test('overlapping language loads publish newest dictionary and plural metadata together', async t => {
 const d=deferred();const h=translations(t,url=>url.endsWith('/fr.json')?d.promise:Promise.resolve(jsonResponse({hello:'English',fallback:'English fallback'})));
 h.window.localStorage.setItem('a-language','fr');const old=h.JE.loadTranslations();await new Promise(r=>setTimeout(r,0));
 h.window.localStorage.setItem('a-language','en');const fresh=h.JE.loadTranslations();assert.equal((await fresh).hello,'English');
 d.resolve(jsonResponse({hello:'Français'}));assert.equal((await old).hello,'English');assert.equal(h.JE.translationsLang,'en');assert.equal(h.JE.translationsFromEnglish,null);
});
test('language changes without a second explicit load restart stale work', async t => {
 const d=deferred();const h=translations(t,url=>url.endsWith('/fr.json')?d.promise:Promise.resolve(jsonResponse({hello:'English'})));
 h.window.localStorage.setItem('a-language','fr');const old=h.JE.loadTranslations();await new Promise(r=>setTimeout(r,0));h.window.localStorage.setItem('a-language','en');
 d.resolve(jsonResponse({hello:'Français'}));assert.equal((await old).hello,'English');
});
test('malformed cached dictionaries refetch while legitimate translation markup survives',async t=>{
 const h=translations(t,async()=>jsonResponse({hello:'<b>Hello</b> {name}'}));const store=h.window.localStorage;
 store.setItem('JE_translation_en_v','{"hello":42}');store.setItem('JE_translation_ts_en_v',String(Date.now()));
 assert.equal((await h.JE.loadTranslations()).hello,'<b>Hello</b> {name}');
});
test('unavailable storage still loads bundled strings',async t=>{
 const h=translations(t,async()=>jsonResponse({hello:'Hi'}));Object.defineProperty(h.window,'localStorage',{get(){throw new Error('disabled');}});
 assert.equal((await h.JE.loadTranslations()).hello,'Hi');
});
test('all 33 shipped locale dictionaries remain valid and contain only string values',()=>{
 const files=['ar','bg','ca','cs','da','de','en-GB','en-US','en','es','et','fa','fi','fr','gsw','he','hu','it','ko','ml','nl','no','pl','pr','pt-BR','pt','ru','sk','sv','tr','uk','zh-CN','zh-HK'];
 for(const lang of files){const values=JSON.parse(readFileSync(`Jellyfin.Plugin.JellyfinEnhanced/js/locales/${lang}.json`));assert.ok(Object.keys(values).length);assert.ok(Object.values(values).every(v=>typeof v==='string'),lang);}
});
test('all 44 icons retain emoji, SVG and Material variants and call-time settings',t=>{
 const h=setup(t,{JE:{pluginConfig:{}}});core(h);h.loadShared('icons');assert.equal(Object.keys(h.JE.IconName).length,44);
 for(const name of Object.values(h.JE.IconName)){
  h.JE.pluginConfig.IconStyle='emoji';assert.match(h.JE.icon(name),/je-emoji/);
  h.JE.pluginConfig.IconStyle='lucide';assert.match(h.JE.icon(name),/<svg/);
  h.JE.pluginConfig.IconStyle='mui';assert.match(h.JE.icon(name),/material-icons/);
 }
 const owner=h.JE.icons;h.loadShared('icons');assert.equal(h.JE.icons,owner);assert.equal(h.document.querySelectorAll('#je-emoji-font').length,1);
 h.JE.pluginConfig.UseIcons=false;assert.equal(h.JE.icon('play'),'');
});
test('theme hooks preserve registered variables, RGB and logo extraction',t=>{
 const h=setup(t,{JE:{cdn:{url:(s,p)=>`/cdn/${s}/${p}`}}});h.loadShared('themer');const theme=h.JE.themer;
 assert.equal(theme.detectActiveTheme().key,'default');assert.equal(theme.getThemeVariable('primaryAccent'),'#00A4DC');
 theme.registerTheme('custom',{name:'Custom',uniqueIdentifier:'--custom',variables:{primaryAccent:'--accent',primaryAccentFallback:'#fff',logo:'--logo',logoFallback:''}});
 const style=h.document.documentElement.style;style.setProperty('--custom','yes');style.setProperty('--accent','1, 2, 3');style.setProperty('--logo','url("/image.png")');
 assert.equal(theme.detectActiveTheme().key,'custom');assert.deepEqual(plain(theme.getThemeVariables()),{primaryAccent:'rgb(1, 2, 3)',logo:'/image.png'});
 h.loadShared('themer');assert.equal(h.JE.themer,theme);
});
test('glyph text and external URLs cannot introduce executable DOM while SVG markup survives',t=>{
 const h=setup(t,{JE:{pluginConfig:{IconStyle:'lucide'}}});core(h);h.loadShared('helpers');h.loadShared('icons');
 const element=h.document.createElement('div');element.innerHTML=h.JE.icons.wrapEmoji('<img src=x onerror=alert(1)>');assert.equal(element.querySelector('img'),null);assert.match(element.textContent,/<img/);
 element.innerHTML=h.JE.icon('play');assert.ok(element.querySelector('svg polygon'));
 for(const url of ['javascript:alert(1)','java\nscript:alert(1)','data:text/html,<script>alert(1)</script>']) assert.equal(h.JE.helpers.createExternalLink(url).getAttribute('href'),'#');
 const link=h.JE.helpers.createExternalLink('https://example.com/path',{text:'<b>Title</b>'});assert.equal(link.querySelector('b'),null);assert.equal(link.getAttribute('is'),'emby-linkbutton');assert.equal(link.rel,'noopener noreferrer');
});
