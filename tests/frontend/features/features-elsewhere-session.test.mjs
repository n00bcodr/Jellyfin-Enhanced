// D46 r16 (review round 15, D46-R15-1): Elsewhere's watch-provider request belongs to the session that asked. A
// privacy save in the same session aborts it and it is asked again under that session; another account signing in
// while it runs aborts it too, but then nothing is asked again (never with the new account's token) and nothing is
// shown in the first account's section. Real core modules: navigation, session, api-client, session-action.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness, deferred, jsonResponse} from '../helpers/harness.mjs';

const tick=()=>new Promise(r=>setImmediate(r));
async function settle(){for(let i=0;i<60;i++)await tick();}
const PROVIDERS={results:{US:{link:'https://tmdb.test/watch',flatrate:[{provider_id:8,provider_name:'Netflix',logo_path:'/n.png',display_priority:1}]}}};

function setup(t){
 let user='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',token='token-a';
 const sent=[],held=[];
 const h=createHarness({html:'<div class="detailSectionContent"><div class="itemExternalLinks"><a href="https://www.themoviedb.org/movie/603">TMDB</a></div></div>',
  apiClient:{getCurrentUserId:()=>user,accessToken:()=>token,serverId:()=>'server-a',
   setAuthenticationInfo(nextToken,nextUser){token=nextToken;user=nextUser;}},
  JE:{t:(k,args)=>args?.error?`${k}: ${args.error}`:k,pluginConfig:{ElsewhereEnabled:true,TmdbEnabled:true,DEFAULT_REGION:'US',ElsewhereSeasonProviders:false},
   helpers:{createObserver(){},onViewPage(){},debounce:fn=>fn},cdn:{url:(_,f)=>'http://cdn.test/'+f},userConfig:{elsewhere:{}}},
  fetch:async(url,options)=>{
   if(String(url).includes('/watch/providers')){
    sent.push(options.headers['X-Emby-Token']);
    const answer=deferred();held.push(answer);
    return answer.promise;
   }
   if(String(url).includes('cdn.test'))return {ok:false,text:async()=>''};
   return jsonResponse(String(url).includes('regions')?{results:[{iso_3166_1:'US',english_name:'United States'}]}:{results:[]});
  }});
 t.after(()=>h.close());
 h.window.requestIdleCallback=(fn)=>h.window.setTimeout(fn,0);
 for(const m of ['navigation','session','api-client'])h.load('core/'+m+'.js');
 h.JE.core.api.manager.CONFIG.retry.baseDelayMs=1;
 h.load('elsewhere/elsewhere.js');h.JE.initializeElsewhereScript();
 return {h,sent,held,section:()=>h.document.querySelector('.streaming-lookup-container'),
  switchAccount(){h.window.ApiClient.setAuthenticationInfo('token-b','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');},
  policyChanged(){h.window.dispatchEvent(new h.window.Event('je-hidden-content-changed'));}};
}

test('a privacy save in the same session asks again with that session and shows the providers',async t=>{
 const {sent,held,section,policyChanged}=setup(t);await settle();
 assert.equal(sent.length,1);
 policyChanged();
 held[0].resolve(jsonResponse(PROVIDERS));await settle();
 assert.deepEqual(sent,['token-a','token-a'],'asked again, as the same session');
 held[1].resolve(jsonResponse(PROVIDERS));await settle();
 assert.match(section().textContent,/Netflix/);
 assert.doesNotMatch(section().textContent,/elsewhere_panel_error|Presentation policy changed/);
});

for(const order of ['switch, then the answer','switch with a privacy save, then the answer'])
test(`another account signing in mid-request is never asked for it and nothing is shown (${order})`,async t=>{
 const {sent,held,section,switchAccount,policyChanged}=setup(t);await settle();
 assert.equal(sent.length,1);
 switchAccount();
 if(order.includes('privacy'))policyChanged();
 held[0].resolve(jsonResponse(PROVIDERS));await settle();
 assert.deepEqual(sent,['token-a'],'nothing is sent with the new account\'s token');
 assert.doesNotMatch(section()?.textContent||'',/Netflix|elsewhere_panel_error|Presentation policy changed|Request aborted/);
});
