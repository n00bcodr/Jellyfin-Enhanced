import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred } from '../../helpers/harness.mjs';
import { contractValue } from '../../contracts/fixtures.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));

/** The real dialog host with a minimal template, over the real settings save path and contract. */
function panelHarness(t, { revision = 'loaded-r1', isAdmin = false, hostAdmin, ajax } = {}) {
  const requests = [];
  const h = createHarness({
    html: '<button id="opener">open</button>',
    JE: {
      pluginConfig: { HelpPanelAutocloseDelay: 60000 },
      userConfig: { settings: { isAdmin, autoPauseEnabled: false }, settingsRevision: revision, shortcuts: { Shortcuts: [] } },
      currentSettings: {},
      t: key => key, toast() {}, keyListener() {}, initializeShortcuts() {}, state: { activeShortcuts: { x: '1' } },
      themer: { getThemeVariables: () => ({ panelBg: '#000', secondaryBg: '#111', primaryAccent: '#0af', altAccent: '#222', blur: '0px', textColor: '#fff', logo: '' }) },
    },
    apiClient: { ajax: async request => { requests.push(request); return ajax ? ajax(request) : null; },
      ...(hostAdmin === undefined ? {} : { getCurrentUser: async () => ({ Id: 'user-a', Policy: { IsAdministrator: hostAdmin } }) }) },
    globals: { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) },
  });
  t.after(() => h.close());
  h.load('contracts/bootstrap.js');
  for (const file of ['core/ui-kit.js', 'enhanced/config.js']) h.load(file);
  h.JE.currentSettings = h.JE.loadSettings();
  h.JE.escapeHtml = h.JE.core.ui.escapeHtml;
  h.JE.toCamelCase = value => Object.fromEntries(Object.entries(value).map(([k, v]) => [k.charAt(0).toLowerCase() + k.slice(1), v]));
  h.window.Element.prototype.getClientRects = function () { return [{ width: 1, height: 1 }]; };
  h.load('enhanced/settingspanel/ui-panel.js');
  const ui = h.JE.internals.enhancedUi;
  ui.buildPanelHtml = () => '<div class="panel-header"><div id="jePanelTitle">JE</div><button id="closeSettingsPanel">x</button></div>'
    + '<div class="je-panel-body"><nav class="je-panel-nav"><div class="je-panel-nav-items"></div></nav>'
    + '<div class="je-panel-main"><section class="je-pane" data-pane="ui"><h3 class="je-pane-title">UI</h3></section></div></div>';
  const snapshot = (rev, settings = {}) => contractValue('RevisionedSettingsResponse', { Revision: rev, Settings: { IsAdmin: isAdmin, ...settings } });
  const posts = () => requests.filter(r => r.type === 'POST' && r.url.endsWith('/settings-document')).map(r => JSON.parse(r.data));
  return { ...h, ui, requests, posts, snapshot, panel: () => h.document.getElementById('jellyfin-enhanced-panel') };
}

for (const startBeforeOpening of [true, false]) test(`refresh preserves queued saves started ${startBeforeOpening ? 'before' : 'during'} opening`, async t => {
  const get=deferred(), firstPost=deferred();let count=0;
  const h=panelHarness(t,{ajax:req=>req.type==='GET'?get.promise:++count===1?firstPost.promise:{Revision:`r${count+1}`}});
  const loaded=h.JE.currentSettings;
  const opening=startBeforeOpening?null:h.JE.showEnhancedPanel();
  loaded.autoPauseEnabled=true;
  const first=h.JE.saveUserSettings('settings.json',loaded,{throwOnError:true});await tick();
  const pendingOpening=opening??h.JE.showEnhancedPanel();
  loaded.autoResumeEnabled=true;
  const second=h.JE.saveUserSettings('settings.json',loaded,{throwOnError:true});
  get.resolve(h.snapshot('r2',{AutoPauseEnabled:true,AutoResumeEnabled:false}));await pendingOpening;
  firstPost.resolve({Revision:'r2'});await Promise.all([first,second]);
  assert.equal(h.JE.currentSettings,loaded);assert.equal(loaded.autoResumeEnabled,true);
  loaded.autoPauseEnabled=false;await h.JE.saveUserSettings('settings.json',loaded,{throwOnError:true});
  assert.equal(h.posts().at(-1).Settings.autoResumeEnabled,true,'next edit retains acknowledged queued value');
  assert.equal(h.posts().at(-1).Revision,'r3');
});
test('a local unsaved edit during refresh keeps the loaded object',async t=>{
 const response=deferred();const h=panelHarness(t,{ajax:()=>response.promise});const loaded=h.JE.currentSettings;
 const opening=h.JE.showEnhancedPanel();loaded.autoResumeEnabled=true;response.resolve(h.snapshot('r2'));await opening;
 assert.equal(h.JE.currentSettings,loaded);assert.equal(loaded.autoResumeEnabled,true);
});
for(const policy of [true,false,undefined])test(`missing document recovers only with authenticated matching admin policy (${policy})`,async t=>{
 const toasts=[];const h=panelHarness(t,{revision:null,ajax:req=>req.type==='POST'?{Revision:'r3'}:req.url.endsWith('/Users/Me')?{Policy:{IsAdministrator:policy}}:contractValue('RevisionedSettingsResponse',{Revision:'admin-r2',Settings:{IsAdmin:true}})});
 delete h.JE.userConfig.settings;h.JE.currentSettings=h.JE.loadSettings();h.JE.toast=m=>toasts.push(m);h.window.console.warn=()=>{};
 await h.JE.showEnhancedPanel();assert.equal(h.requests.some(r=>r.url.endsWith('/Users/Me')),true);
 if(policy===true){assert.ok(h.panel());assert.equal(h.JE.userConfig.settingsRevision,'admin-r2');await h.JE.saveUserSettings('settings.json',h.JE.currentSettings,{throwOnError:true});assert.equal(h.posts()[0].Revision,'admin-r2');}
 else {assert.equal(h.panel(),null);assert.equal(h.JE.userConfig.settingsRevision,null);assert.equal(h.posts().length,0);assert.match(toasts.at(-1),/try opening/);}
});
for(const cancel of ['navigation','second toggle'])test(`pending panel opening is cancelled by ${cancel}`,async t=>{
 const response=deferred(),callbacks=new Set();const h=panelHarness(t,{ajax:()=>response.promise});
 h.JE.core.navigation={onNavigate(fn){callbacks.add(fn);return()=>callbacks.delete(fn);}};
 const opening=h.JE.showEnhancedPanel();assert.equal(callbacks.size,1);
 if(cancel==='navigation')for(const fn of [...callbacks])fn();else await h.JE.showEnhancedPanel();
 assert.equal(callbacks.size,0,'cancel releases subscription even while GET is pending');
 response.resolve(null);await opening;assert.equal(h.panel(),null);assert.equal(h.document.querySelector('[inert]'),null);
});
function languageHarness(t,{post=async()=>({Revision:'r2'}),github=async()=>({ok:false}),locales=async()=>['fr','de']}={}){
 let user='user-a',epoch=0;const closes=[],toasts=[],timers=[],posts=[];
 const h=createHarness({html:'<select id="displayLanguageSelect"><option value="">Auto</option></select>',JE:{pluginConfig:{},userConfig:{settings:{displayLanguage:'fr'},settingsRevision:'r1',shortcuts:{Shortcuts:[]}},t:k=>k,toast:m=>toasts.push(m),session:{getEpoch:()=>epoch}},apiClient:{getCurrentUserId:()=>user,ajax:async req=>{if(req.type==='POST'){posts.push(req);return post(req);}return req.url.endsWith('/locales')?locales():[];}},fetch:github});
 t.after(()=>h.close());h.load('enhanced/config.js');h.JE.currentSettings=h.JE.loadSettings();
 h.window.setTimeout=(fn,ms)=>{timers.push({fn,ms});return timers.length;};h.window.clearTimeout=()=>{};
 h.load('enhanced/settingspanel/ui-panel-language.js');h.JE.internals.enhancedUi.wireLanguageControls({resetAutoCloseTimer(){},onClose:fn=>closes.push(fn)});
 return {...h,select:h.document.querySelector('select'),toasts,timers,posts,close:()=>closes.forEach(fn=>fn()),switchUser(){epoch++;user='user-b';h.JE.userConfig={settings:{displayLanguage:'en'},settingsRevision:'b1',shortcuts:{Shortcuts:[]}};h.JE.currentSettings=h.JE.loadSettings();}};
}
// BUG-015: the choices are the plugin's embedded locales only; the panel never asks GitHub.
test('bundled locale choices render with no GitHub request and keep the chosen language',async t=>{
 const fetched=[];const h=languageHarness(t,{github:url=>{fetched.push(String(url));return new Promise(()=>{});}});await tick();
 assert.deepEqual(Array.from(h.select.options,o=>o.value),['','de','fr']);assert.equal(h.select.value,'fr');
 h.select.value='de';h.select.dispatchEvent(new h.window.Event('change'));await tick();await tick();
 assert.equal(h.select.value,'de');assert.equal([...h.select.options].filter(o=>o.value==='de').length,1);assert.deepEqual(fetched,[]);
});
test('rejected language write rolls back and reports no success or reload',async t=>{
 const h=languageHarness(t,{post:async()=>{throw Error('409 conflict');}});await tick();h.select.value='de';h.select.dispatchEvent(new h.window.Event('change'));await tick();await tick();
 assert.equal(h.window.localStorage.getItem('user-a-language'),null);assert.equal(h.toasts.includes('toast_language_changed'),false);assert.equal(h.timers.some(x=>x.ms===1500),false);
 assert.equal(h.JE.currentSettings.displayLanguage,'fr');assert.equal(h.select.value,'fr');assert.equal(h.select.disabled,false);
});
for(const reason of ['closed','account changed'])test(`language acknowledgement after ${reason} reconciles only its own document without UI side effects`,async t=>{
 const receipt=deferred();const h=languageHarness(t,{post:()=>receipt.promise});await tick();h.select.value='de';h.select.dispatchEvent(new h.window.Event('change'));await tick();assert.equal(h.posts.length,1);
 if(reason==='closed')h.close();else h.switchUser();receipt.resolve({Revision:'r2'});await tick();await tick();
 assert.equal(h.window.localStorage.getItem('user-a-language'),reason==='closed'?'de':null);assert.equal(h.window.localStorage.getItem('user-b-language'),null);assert.equal(h.toasts.includes('toast_language_changed'),false);assert.equal(h.timers.some(x=>x.ms===1500),false);
});
test('closed language panel ignores a late locale list',async t=>{
 const late=deferred();const h=languageHarness(t,{locales:()=>late.promise});await tick();h.close();
 late.resolve(['es','fr']);await tick();await tick();assert.equal([...h.select.options].some(o=>o.value==='es'),false);
});

test('rejected language write after close still restores its document',async t=>{
 const receipt=deferred();const h=languageHarness(t,{post:()=>receipt.promise});await tick();h.select.value='de';h.select.dispatchEvent(new h.window.Event('change'));await tick();h.close();receipt.reject(Error('write failed'));await tick();await tick();
 assert.equal(h.JE.currentSettings.displayLanguage,'fr');assert.equal(h.window.localStorage.getItem('user-a-language'),null);assert.equal(h.toasts.includes('toast_language_changed'),false);
});


test('R2: authoritative refresh permits reverting to previously acknowledged content',async t=>{
 let postCount=0,response;const h=panelHarness(t,{hostAdmin:false,ajax:req=>req.type==='POST'?(postCount++,{Revision:'saved-'+postCount}):response});
 h.JE.toPascalCase=value=>Object.fromEntries(Object.entries(value).map(([k,v])=>[k[0].toUpperCase()+k.slice(1),v]));
 const wire=h.snapshot('loaded-r1',{AutoPauseEnabled:true}).Settings;
 h.JE.userConfig.settings=h.JE.toCamelCase(wire);h.JE.currentSettings=h.JE.loadSettings();
 await h.JE.saveUserSettings('settings.json',h.JE.currentSettings,{throwOnError:true});
 await h.JE.saveUserSettings('settings.json',h.JE.currentSettings,{throwOnError:true});
 assert.equal(postCount,1,'same document/revision still deduplicates');
 response=h.snapshot('external-r3',{...wire,AutoPauseEnabled:false});
 await h.JE.showEnhancedPanel();assert.equal(h.JE.currentSettings.autoPauseEnabled,false);
 h.JE.currentSettings.autoPauseEnabled=true;
 await h.JE.saveUserSettings('settings.json',h.JE.currentSettings,{throwOnError:true});
 assert.equal(postCount,2,'old acknowledged body cannot suppress a new revision write');
 assert.equal(h.posts()[1].Revision,'external-r3');assert.equal(h.posts()[1].Settings.AutoPauseEnabled,true);
 delete h.JE.userConfig.settingsRevision;
 await assert.rejects(h.JE.saveUserSettings('settings.json',h.JE.currentSettings,{throwOnError:true}),/revision/);
 assert.equal(postCount,2,'missing revision cannot be treated as successful deduplication');
});
test('R2: failed language save reconciles after close without any stale notification',async t=>{
 const receipt=deferred();const h=languageHarness(t,{post:()=>receipt.promise});await tick();
 h.select.value='de';h.select.dispatchEvent(new h.window.Event('change'));await tick();h.close();
 receipt.reject(Error('conflict'));await tick();await tick();
 assert.equal(h.JE.currentSettings.displayLanguage,'fr');assert.deepEqual(h.toasts,[]);assert.equal(h.timers.length,0);
});
test('R2: account change during asynchronous error reconciliation suppresses the old notification',async t=>{
 const gate=deferred(),rollback=deferred();let user='user-a',calls=0;
 const h=panelHarness(t,{ajax:()=>++calls===1?gate.promise:{Revision:'b2'}});h.window.ApiClient.getCurrentUserId=()=>user;
 const notices=[];h.JE.toast=m=>notices.push(m);
 const saving=h.JE.saveUserSettings('settings.json',h.JE.currentSettings,{throwOnError:true,onError:()=>rollback.promise});
 const rejected=assert.rejects(saving,/offline/);await tick();gate.reject(Error('offline'));await tick();
 assert.equal(h.JE.getSettingsSaveState().pending,1);
 user='user-b';h.JE.userConfig={settings:{isAdmin:false},settingsRevision:'b1',shortcuts:{Shortcuts:[]}};h.JE.currentSettings=h.JE.loadSettings();
 await h.JE.saveUserSettings('settings.json',h.JE.currentSettings,{throwOnError:true});assert.equal(calls,2);
 rollback.resolve();await rejected;assert.deepEqual(notices,[]);assert.equal(h.JE.getSettingsSaveState().pending,0);
});
function titleHarness(t){
 const gate=deferred(),requests=[],closes=[];let user='user-a',base='http://a/',token='token-a',epoch=0;
 const ids=Array.from({length:51},(_,i)=>(i+1).toString(16).padStart(32,'0'));
 const h=createHarness({html:'<div id="jeTagLooksMount"></div>',JE:{currentSettings:{tagLayoutLocks:Object.fromEntries(ids.map(id=>[id,{layout:'minimal',density:'full',lockedAt:1}]))},pluginConfig:{},t:k=>k,session:{getEpoch:()=>epoch}},
 apiClient:{getCurrentUserId:()=>user,accessToken:()=>token,getUrl:(p,q)=>base+p+'?'+new URLSearchParams(q),ajax:r=>{
   if(!r.url.includes('/Items?'))return Promise.resolve({Items:[]});
   requests.push(r.url);return new URL(r.url).searchParams.get('Ids').split(',').length===50?gate.promise:Promise.resolve({Items:[]});
 }}});
 t.after(()=>h.close());for(const f of ['core/ui-kit.js','core/tag-layout.js','core/tag-look.js','enhanced/settingspanel/ui-panel-tag-looks.js'])h.load(f);
 const panel=h.JE.internals.enhancedUi.tagLooksPanel;
 return {...h,gate,requests,ids,panel,closes,change(kind){
   if(kind==='account')user='user-b';
   if(kind==='server')base='http://b/';
   if(kind==='token')token='token-b';
   if(kind==='client')h.window.ApiClient={...h.window.ApiClient};
   if(kind==='epoch')epoch++;
   if(kind==='event')h.document.dispatchEvent(new h.window.CustomEvent('je:user-changed'));
 },wire(){h.JE.internals.enhancedUi.wireTagLooks({onClose:fn=>closes.push(fn)});panel.show();}};
}
for(const change of ['account','server','token','client','epoch','event'])test('R2: title batches stop on '+change+' change',async t=>{
 const h=titleHarness(t);const state={titles:new Map(),libraries:null,genres:null,lockedOpen:true,shown:true,editing:''};
 const work=h.panel.loadTitles(state,h.ids);assert.equal(h.requests.length,1);h.change(change);
 h.gate.resolve({Items:[{Id:h.ids[0],Name:'old private title',Type:'Movie'}]});await work;
 assert.equal(h.requests.length,1,'no remaining old IDs are sent');assert.equal(state.titles.size,0,'old response cannot populate new-account state');
});
for(const change of ['close','disconnect'])test('R2: mounted title batches stop on panel '+change,async t=>{
 const h=titleHarness(t);h.wire();await tick();const started=h.requests.length;assert.ok(started>0);
 if(change==='close')h.closes.forEach(fn=>fn());else h.document.getElementById('jeTagLooksMount').remove();
 h.gate.resolve({Items:[]});await tick();await tick();assert.equal(h.requests.length,started,'view disposal stops remaining batches');
});
test('R2: live title batches finish and cache all requested IDs',async t=>{
 const h=titleHarness(t);const state={titles:new Map(),libraries:null,genres:null,lockedOpen:true,shown:true,editing:''};
 const work=h.panel.loadTitles(state,h.ids);h.gate.resolve({Items:[{Id:h.ids[0],Name:'First movie',Type:'Movie'}]});await work;
 assert.equal(h.requests.length,2);assert.equal(state.titles.size,51);assert.equal(state.titles.get(h.ids[0]).name,'First movie');
 await h.panel.loadTitles(state,h.ids);assert.equal(h.requests.length,2,'successful data remains cached');
});
