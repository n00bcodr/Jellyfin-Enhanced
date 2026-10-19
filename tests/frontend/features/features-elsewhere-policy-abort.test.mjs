// A Hidden Content / Spoiler Guard save while Elsewhere's watch-provider request runs aborts that request (its answer
// belonged to the old policy). That is not an error: the section asks again under the new policy and shows the result.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness} from '../helpers/harness.mjs';

const tick=()=>new Promise(r=>setImmediate(r));
const PROVIDERS={results:{US:{link:'https://tmdb.test/watch',flatrate:[{provider_id:8,provider_name:'Netflix',logo_path:'/n.png',display_priority:1}]}}};

function setup(t,aborts){
 const calls=[];
 const h=createHarness({html:'<div class="detailSectionContent"><div class="itemExternalLinks"><a href="https://www.themoviedb.org/movie/603">TMDB</a></div></div>',
  apiClient:{getUrl:path=>'http://jellyfin.test'+path,getCurrentUserId:()=>'viewer'},
  JE:{t:(k,args)=>args?.error?`${k}: ${args.error}`:k,pluginConfig:{ElsewhereEnabled:true,TmdbEnabled:true,DEFAULT_REGION:'US',ElsewhereSeasonProviders:false},
   helpers:{createObserver(){},onViewPage(){},debounce:fn=>fn},cdn:{url:(_,f)=>'http://cdn.test/'+f},userConfig:{elsewhere:{}},
   core:{api:{isPresentationAbort:e=>e?.name==='AbortError'&&e.presentationChanged===true,fetch:async url=>{
    calls.push(url);
    if(url.includes('/watch/providers')){
     if(calls.filter(u=>u.includes('/watch/providers')).length<=aborts)throw Object.defineProperty(new DOMException('Presentation policy changed','AbortError'),'presentationChanged',{value:true});
     return structuredClone(PROVIDERS);
    }
    return url.includes('regions')?{results:[{iso_3166_1:'US',english_name:'United States'}]}:{results:[]};
   }}}},
  fetch:async()=>({ok:false,text:async()=>''})});
 t.after(()=>h.close());
 h.window.requestIdleCallback=(fn)=>h.window.setTimeout(fn,0);
 h.load('elsewhere/elsewhere.js');h.JE.initializeElsewhereScript();
 return {h,calls,section:()=>h.document.querySelector('.streaming-lookup-container')};
}
async function settle(){for(let i=0;i<40;i++)await tick();}

for(const aborts of [1,2])test(`a watch-provider request aborted ${aborts}x by a policy change is asked again, not shown as an error`,async t=>{
 const {h,calls,section}=setup(t,aborts);await settle();
 assert.ok(section(),'the section is mounted');
 assert.equal(calls.filter(u=>u.includes('/watch/providers')).length,aborts+1,'asked again under the new policy');
 assert.doesNotMatch(section().textContent,/elsewhere_panel_error|Presentation policy changed/,'no error is shown');
 assert.match(section().textContent,/Netflix/,'the providers answered under the new policy are shown');
});

test('a request that keeps being aborted stops after three attempts and shows nothing',async t=>{
 const {calls,section}=setup(t,99);await settle();
 assert.equal(calls.filter(u=>u.includes('/watch/providers')).length,3);
 assert.doesNotMatch(section().textContent,/elsewhere_panel_error|Presentation policy changed/);
});
