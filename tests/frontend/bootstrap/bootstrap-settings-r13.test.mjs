import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsServer, tab } from '../helpers/settings-tabs.mjs';
const settle = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
test('R13: a recovery read rejected by revision fencing must not leave an older uncertain operation on top of a newer consent',async t=>{
 const s=settingsServer({Settings:{AutoResumeEnabled:false,AutoMovieRequests:false},Shortcuts:{Shortcuts:[]},Bookmark:{Bookmarks:{}},Elsewhere:{},HiddenContent:{Items:{},Settings:{}}});
 let first=true;
 const h=await tab(t,s,{ajax:req=>{if(req.type==='PATCH'&&req.url.endsWith('/settings.json')&&first){first=false;throw new TypeError('lost before commit');}}});
 const gate=s.hold('settings.json','GET');
 await h.JE.updateSettings({autoResumeEnabled:true});await gate.reached;
 await h.JE.setPersonalConsent('autoMovieRequests',true,{throwOnError:true});
 gate.release();await settle();
 const writesBefore=s.writes.length;await h.JE.saveUserSettings('settings.json',{...h.JE.currentSettings},{throwOnError:true});
 assert.equal(h.JE.currentSettings.autoResumeEnabled,false);
});
