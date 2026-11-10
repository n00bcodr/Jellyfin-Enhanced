import type { Dependencies } from './types';
export interface Lease { current():boolean; }
export interface Runtime {
 installed:Set<string>; cleanup(callback:()=>void):void; capture(lane?:string):Lease; captureIdentity():Lease; invalidate():void; dispose():void;
 listen(target:EventTarget,event:string,callback:EventListener,capture?:boolean):void;
 mutations:Map<string,'pending'|'succeeded'|'failed'|'uncertain'>;
}
/** One owner stored on the feature facade, even when this module is bundled eight times. */
export function runtime(deps:Dependencies):Runtime {
 if(deps.P.runtime)return deps.P.runtime;
 const {JE,P,host}=deps;
 let generation=0,disposed=false;
 const lanes=new Map<string,number>();const removers:(()=>void)[]=[];
 const identityLease = (): Lease => {
  const api=host.ApiClient, epoch=JE.session?.getEpoch();
  const serverId=()=>typeof api?.serverId==='function'?api.serverId():api?.serverId;
  const identity=api?.getCurrentUserId(),server=api?.serverAddress?.(),base=api?.getUrl('/'),token=api?.accessToken?.(),id=serverId();
  return {current:()=>!disposed && host.ApiClient===api
   && (epoch===undefined || JE.session?.isCurrent(epoch)===true)
   && api?.getCurrentUserId()===identity && api?.serverAddress?.()===server
   && api?.getUrl('/')===base && api?.accessToken?.()===token && serverId()===id};
 };
 const owner:Runtime={cleanup(callback){removers.push(callback);},installed:new Set(),mutations:new Map(),
 captureIdentity:identityLease,
 capture(lane){
  const version=generation,identity=identityLease();
  const route=host.location.pathname+host.location.hash;
  const container=P.state?._customTabContainer || document.getElementById('je-downloads-container');
  const serial=lane?(lanes.get(lane)||0)+1:0;if(lane)lanes.set(lane,serial);
  return {current:()=>!disposed && generation===version && (!lane||lanes.get(lane)===serial)
   && identity.current()
   && host.location.pathname+host.location.hash===route
   && (!container || container.isConnected && !container.closest('.hide, [hidden]') && (!container.closest('.tabContent') || container.closest('.tabContent')?.classList.contains('is-active')===true))};
 },
 invalidate(){generation++;if(P.state){P.state.isLoading=false;if(P.state.searchDebounceTimer!==null){clearTimeout(P.state.searchDebounceTimer);P.state.searchDebounceTimer=null;}}},
 listen(target,event,callback,capture=false){target.addEventListener(event,callback,capture);removers.push(()=>target.removeEventListener(event,callback,capture));},
 dispose(){disposed=true;owner.invalidate();removers.splice(0).forEach(remove=>remove());if(P.state?.pollTimer){clearInterval(P.state.pollTimer);P.state.pollTimer=null;}}
 };
 P.runtime=owner;
 owner.listen(host,'hashchange',()=>owner.invalidate());
 owner.listen(host,'popstate',()=>owner.invalidate());
 owner.listen(host,'je:navigate',()=>owner.invalidate());
 owner.listen(document,'viewhide',event=>{if(event.target instanceof Element && (event.target.id==='je-downloads-page'||event.target.contains(P.state?._customTabContainer || document.getElementById('je-downloads-container'))))owner.invalidate();});
 JE.core?.lifecycle?.register('arr-requests-page').track(()=>owner.dispose());
 return owner;
}
