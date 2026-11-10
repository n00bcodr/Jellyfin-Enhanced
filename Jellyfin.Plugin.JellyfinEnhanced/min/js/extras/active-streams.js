(() => {
"use strict";(()=>{function ce(e,t,a){let c=t.core?.featureContext;if(typeof c!="function")throw new Error(`${e}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);return c(e,t,a)}function le(e,t){return ce("chrome",e,{facades:t})}function pe(){let e=window;if(!e.JellyfinEnhanced)throw new Error("Jellyfin Enhanced must initialize before chrome modules");return e.JellyfinEnhanced}function ue(){return window.ApiClient}function V(e){return typeof e=="string"&&e.length>0?e:null}function Fe(e){let t=null,a=null;try{t=V(e?.getCurrentUserId?.())}catch{}try{let c=e?.serverId;a=V(typeof c=="function"?c.call(e):c)||V(e?._serverInfo?.Id)}catch{}return{userId:t,serverId:a}}function ge(e,t){let a=Fe(t),c=null;try{c=typeof e?.getEpoch=="function"?e.getEpoch():null}catch{c=null}let g=x=>{try{return V(x())}catch{return null}},f=g(()=>t?.accessToken?.()),j=g(()=>t?.getUrl?.("/"));return{userId:a.userId,serverId:a.serverId,epoch:c,client:t,credentialsCurrent:()=>g(()=>t?.accessToken?.())===f&&g(()=>t?.getUrl?.("/"))===j}}function fe(e,t){return e.client===t.client&&e.credentialsCurrent()&&t.credentialsCurrent()&&e.userId===t.userId&&e.serverId===t.serverId&&e.epoch===t.epoch}var me=`
#je-active-streams {
  position: relative;
  overflow: visible;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  flex-shrink: 0;
}
#je-active-streams.je-as-in-osd {
  width: 48px;
  height: 48px;
  color: inherit;
  background: none;
  border: 0;
  cursor: pointer;
}
#je-active-streams .je-as-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  transition: color 0.3s;
}
#je-active-streams .je-as-sup {
  position: absolute;
  top: 2px;
  right: 2px;
  min-width: 12px;
  padding: 0;
  font-size: 11px;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: -0.15px;
  pointer-events: none;
  text-align: center;
  white-space: nowrap;
  transition: color 0.3s;
}
#je-active-streams .je-as-sup:empty { display: none; }
#je-active-streams.je-as-active .je-as-icon,
#je-active-streams.je-as-active .je-as-sup { color: var(--je-as-accent, #00a4dc); }
#je-active-streams.je-as-err .je-as-icon   { color: #b91c1c; }
#je-active-streams.je-as-err .je-as-sup    { color: #991b1b; }

/* Panel */
#je-active-streams-panel {
  position: fixed;
  right: 12px;
  width: 360px;
  max-width: calc(100vw - 16px);
  max-height: calc(100vh - 72px);
  overflow-y: auto;
  background: rgba(18,18,18,0.97);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 10px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.7);
  z-index: 9999;
  padding: 12px;
  display: none;
  flex-direction: column;
  gap: 10px;
  box-sizing: border-box;
}
#je-active-streams-panel.je-as-panel-open { display: flex; }

.je-as-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
}
.je-as-panel-title {
  font-size: 13px;
  font-weight: 600;
  color: rgba(255,255,255,0.85);
  letter-spacing: 0.3px;
}
.je-as-panel-close {
  background: none;
  border: none;
  color: rgba(255,255,255,0.4);
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  padding: 0;
  display: flex;
  align-items: center;
}
.je-as-panel-close:hover { color: rgba(255,255,255,0.8); }
.je-as-panel-empty {
  font-size: 13px;
  color: rgba(255,255,255,0.35);
  text-align: center;
  padding: 20px 0;
}

/* Session card */
.je-as-card {
  background: rgba(255,255,255,0.07);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.je-as-card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.je-as-card-info { flex: 1; min-width: 0; }
.je-as-card-title {
  font-size: 13px;
  font-weight: 600;
  color: rgba(255,255,255,0.9);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.je-as-card-subtitle {
  font-size: 11px;
  color: rgba(255,255,255,0.45);
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.je-as-state {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 4px;
  flex-shrink: 0;
  letter-spacing: 0.4px;
  text-transform: uppercase;
}
.je-as-state-playing { background: rgba(29,78,216,0.25); color: #93c5fd; }
.je-as-state-paused  { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.4); }

/* Progress */
.je-as-progress-row {
  display: flex;
  align-items: center;
  gap: 7px;
}
.je-as-progress-bar {
  flex: 1;
  height: 6px;
  background: rgba(255,255,255,0.1);
  border-radius: 3px;
  overflow: hidden;
}
.je-as-progress-fill {
  position: relative;
  z-index: 1;
  height: 100%;
  background: var(--je-as-accent, #00a4dc);
  border-radius: 3px;
  transition: width 0.4s;
}
.je-as-progress-time {
  font-size: 10px;
  color: rgba(255,255,255,0.35);
  white-space: nowrap;
}

/* Badges */
.je-as-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 2px;
}
.je-as-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
  letter-spacing: 0.3px;
}
.je-as-badge-direct    { background: rgba(16,185,129,0.15); color: #6ee7b7; }
.je-as-badge-transcode { background: rgba(245,158,11,0.15); color: #fcd34d; }
.je-as-badge-neutral   { background: rgba(255,255,255,0.07); color: rgba(255,255,255,0.45); }
.je-as-badge-reason    { background: rgba(239,68,68,0.12); color: #fca5a5; font-style: italic; }

/* User row */
.je-as-user {
  font-size: 11px;
  color: rgba(255,255,255,0.35);
  display: flex;
  align-items: center;
  gap: 4px;
}
.je-as-user .material-icons { font-size: 13px; opacity: 0.5; }
.je-as-avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}

/* Panel open animation */
@keyframes je-as-fadein {
  from { opacity: 0; transform: translateY(-6px); }
  to   { opacity: 1; transform: translateY(0); }
}
#je-active-streams-panel.je-as-panel-open {
  animation: je-as-fadein 150ms ease forwards;
}

@media (max-width: 400px) {
  #je-active-streams-panel {
    right: 8px;
    left: 8px;
    width: auto;
  }
}

/* Poster thumbnail */
.je-as-card-with-poster {
  flex-direction: row !important;
  align-items: flex-start;
  gap: 10px !important;
}
.je-as-poster {
  width: 40px;
  height: 60px;
  border-radius: 4px;
  object-fit: cover;
  flex-shrink: 0;
  background: rgba(255,255,255,0.06);
}
.je-as-poster-placeholder {
  width: 40px;
  height: 60px;
  border-radius: 4px;
  background: rgba(255,255,255,0.06);
  flex-shrink: 0;
}
.je-as-card-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }

/* Clickable title */
.je-as-card-title-link {
  cursor: pointer;
  text-decoration: none;
  color: inherit;
}
.je-as-card-title-link:hover { text-decoration: underline; }

/* Transcode buffer behind the progress bar */
.je-as-progress-bar { position: relative; }
.je-as-transcode-fill {
  position: absolute;
  top: 0; left: 0;
  z-index: 0;
  height: 100%;
  background: rgba(245,158,11,0.8);
  border-radius: 3px;
  transition: width 0.4s;
}

/* Last updated footer */
.je-as-panel-footer {
  font-size: 10px;
  color: rgba(255,255,255,0.45);
  text-align: right;
  padding-top: 6px;
  border-top: 1px solid rgba(255,255,255,0.08);
  margin-top: 2px;
}

/* Refresh button */
.je-as-refresh-btn {
  background: none;
  border: none;
  color: rgba(255,255,255,0.4);
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  padding: 0;
  display: flex;
  align-items: center;
  margin-right: 4px;
  transition: color 0.2s;
}
.je-as-refresh-btn:hover { color: rgba(255,255,255,0.8); }
.je-as-refresh-btn.je-as-refreshing { animation: je-as-spin 0.6s linear; }
@keyframes je-as-spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}

/* ── Broadcast button ──────────────────────────────────────────────────── */
.je-as-broadcast-btn {
  background: none;
  border: none;
  color: rgba(255,255,255,0.4);
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  padding: 0;
  display: flex;
  align-items: center;
  margin-right: 4px;
  transition: color 0.2s;
}
.je-as-broadcast-btn:hover { color: var(--je-as-accent, #00a4dc); }
.je-as-broadcast-btn.je-as-broadcast-active { color: var(--je-as-accent, #00a4dc); }

/* ── Broadcast compose form ────────────────────────────────────────────── */
.je-as-broadcast-form {
  display: none;
  flex-direction: column;
  gap: 6px;
  padding: 10px 0 4px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  animation: je-as-fadein 150ms ease forwards;
}
.je-as-broadcast-form.je-as-broadcast-form-open {
  display: flex;
}
.je-as-broadcast-input,
.je-as-broadcast-textarea {
  background: rgba(255,255,255,0.07);
  border: 1px solid rgba(255,255,255,0.15);
  border-radius: 6px;
  color: #fff;
  padding: 8px 10px;
  font-size: 12px;
  font-family: inherit;
  outline: none;
  width: 100%;
  box-sizing: border-box;
  transition: border-color 0.2s;
}
.je-as-broadcast-input:focus,
.je-as-broadcast-textarea:focus {
  border-color: var(--je-as-accent, #00a4dc);
}
.je-as-broadcast-input::placeholder,
.je-as-broadcast-textarea::placeholder {
  color: rgba(255,255,255,0.3);
  font-style: italic;
}
.je-as-broadcast-textarea {
  resize: vertical;
  min-height: 72px;
}
.je-as-broadcast-field-label {
  font-size: 11px;
  font-weight: 600;
  color: rgba(255,255,255,0.65);
  letter-spacing: 0.3px;
  text-transform: uppercase;
  margin-bottom: 2px;
}

.je-as-broadcast-timeout-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.je-as-broadcast-timeout-label {
  font-size: 11px;
  color: rgba(255,255,255,0.45);
  white-space: nowrap;
}
.je-as-broadcast-timeout-input {
  background: rgba(255,255,255,0.07);
  border: 1px solid rgba(255,255,255,0.15);
  border-radius: 6px;
  color: #fff;
  padding: 6px 8px;
  font-size: 12px;
  font-family: inherit;
  outline: none;
  width: 72px;
  box-sizing: border-box;
  transition: border-color 0.2s;
}
.je-as-broadcast-timeout-input:focus {
  border-color: var(--je-as-accent, #00a4dc);
}
.je-as-broadcast-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.je-as-broadcast-send {
  background: var(--je-as-accent, #00a4dc);
  border: none;
  border-radius: 6px;
  color: #fff;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  padding: 6px 14px;
  transition: opacity 0.2s;
}
.je-as-broadcast-send:hover { opacity: 0.85; }
.je-as-broadcast-send:disabled { opacity: 0.5; cursor: not-allowed; }
.je-as-broadcast-cancel {
  background: rgba(255,255,255,0.08);
  border: 1px solid rgba(255,255,255,0.15);
  border-radius: 6px;
  color: rgba(255,255,255,0.7);
  cursor: pointer;
  font-size: 12px;
  padding: 6px 12px;
  transition: background 0.2s;
}
.je-as-broadcast-cancel:hover { background: rgba(255,255,255,0.14); }
.je-as-broadcast-result {
  font-size: 11px;
  padding: 5px 8px;
  border-radius: 5px;
  display: none;
}
.je-as-broadcast-result.je-as-broadcast-ok {
  display: block;
  background: rgba(16,185,129,0.15);
  color: #6ee7b7;
}
.je-as-broadcast-result.je-as-broadcast-err {
  display: block;
  background: rgba(239,68,68,0.12);
  color: #fca5a5;
}
.je-as-broadcast-field-note {
  font-size: 10px;
  color: rgba(255,193,7,0.8);
  line-height: 1.4;
  padding: 3px 0 1px;
}`;var be=me;var q="🪼 Jellyfin Enhanced:",He=5e3,B=e=>typeof e=="object"&&e!==null&&!Array.isArray(e),b=e=>typeof e=="string"?e:void 0,h=e=>typeof e=="number"&&Number.isFinite(e)?e:void 0,G=e=>typeof e=="boolean"?e:void 0;function Z(e){for(let t of Object.keys(e))e[t]===void 0&&delete e[t];return e}function X(e,t){return B(e)?Z(t(e)):void 0}function ze(e){return B(e)?Z({UserId:b(e.UserId),UserName:b(e.UserName),UserHasPrimaryImage:G(e.UserHasPrimaryImage),Client:b(e.Client),DeviceName:b(e.DeviceName),RemoteEndPoint:b(e.RemoteEndPoint),NowPlayingItem:X(e.NowPlayingItem,t=>({Id:b(t.Id),Name:b(t.Name),SeriesName:b(t.SeriesName),RunTimeTicks:h(t.RunTimeTicks),ProductionYear:h(t.ProductionYear),ParentIndexNumber:h(t.ParentIndexNumber),IndexNumber:h(t.IndexNumber),ImageTags:B(t.ImageTags)?Object.fromEntries(Object.entries(t.ImageTags).filter(a=>typeof a[1]=="string")):void 0,SeriesId:b(t.SeriesId),SeriesPrimaryImageTag:b(t.SeriesPrimaryImageTag),MediaStreams:Array.isArray(t.MediaStreams)?t.MediaStreams.filter(B).map(a=>Z({Type:b(a.Type),Codec:b(a.Codec),BitRate:h(a.BitRate)})):void 0})),PlayState:X(e.PlayState,t=>({IsPaused:G(t.IsPaused),PositionTicks:h(t.PositionTicks),PlayMethod:b(t.PlayMethod)})),TranscodingInfo:X(e.TranscodingInfo,t=>({IsVideoDirect:G(t.IsVideoDirect),VideoCodec:b(t.VideoCodec),AudioCodec:b(t.AudioCodec),Bitrate:h(t.Bitrate),CompletionPercentage:h(t.CompletionPercentage),TranscodeReasons:Array.isArray(t.TranscodeReasons)?t.TranscodeReasons.filter(a=>typeof a=="string"):void 0,Width:h(t.Width),Height:h(t.Height),Framerate:h(t.Framerate)}))}):null}function he(e){return Array.isArray(e)?e.map(ze).filter(t=>t!==null):null}function _e(e){if(!B(e))throw new Error("Invalid broadcast response");let t=h(e.sent),a=h(e.skipped);if(t===void 0||a===void 0)throw new Error("Invalid broadcast response");let c=Array.isArray(e.errors)?e.errors.map(String):[];return{sent:t,skipped:a,errors:c}}function xe(e){if(!e)return"0:00";let t=Math.floor(e/1e7),a=Math.floor(t/3600),c=Math.floor(t%3600/60),g=t%60;return a>0?`${a}:${String(c).padStart(2,"0")}:${String(g).padStart(2,"0")}`:`${c}:${String(g).padStart(2,"0")}`}var ye=e=>{let t=Math.round(e/1e3);return t>=1e3?`${(t/1e3).toFixed(1)} Mbps`:`${t} kbps`};function Ve(e){let t=[],a=e.TranscodingInfo,c=e.PlayState||{};if(a&&a.IsVideoDirect===!1)t.push({label:"Transcoding",cls:"je-as-badge-transcode"}),a.VideoCodec&&t.push({label:a.VideoCodec.toUpperCase(),cls:"je-as-badge-neutral"}),a.AudioCodec&&t.push({label:a.AudioCodec.toUpperCase(),cls:"je-as-badge-neutral"}),a.Bitrate&&t.push({label:ye(a.Bitrate),cls:"je-as-badge-neutral"}),a.Width&&a.Height&&t.push({label:`${a.Width}×${a.Height}`,cls:"je-as-badge-neutral"}),a.Framerate&&t.push({label:`${Math.round(a.Framerate)}fps`,cls:"je-as-badge-neutral"});else{t.push({label:"Direct Play",cls:"je-as-badge-direct"});let g=e.NowPlayingItem?.MediaStreams?.find(f=>f.Type==="Video");g?.Codec&&t.push({label:g.Codec.toUpperCase(),cls:"je-as-badge-neutral"}),g?.BitRate&&t.push({label:ye(g.BitRate),cls:"je-as-badge-neutral"})}if(c.PlayMethod==="Transcode"&&a?.TranscodeReasons?.length){let g=e.NowPlayingItem?.MediaStreams||[];for(let f of a.TranscodeReasons){t.push({label:f.replace(/([A-Z])/g," $1").trim(),cls:"je-as-badge-reason"});let j=f==="AudioCodecNotSupported"?[g.find(y=>y.Type==="Audio")?.Codec,a.AudioCodec]:f==="VideoCodecNotSupported"?[g.find(y=>y.Type==="Video")?.Codec,a.VideoCodec]:null,[x,A]=j??[];x&&A&&x.toLowerCase()!==A.toLowerCase()&&t.push({label:`${x.toUpperCase()} → ${A.toUpperCase()}`,cls:"je-as-badge-reason"})}}return t}function qe(e){let t=e.filter(f=>f.NowPlayingItem&&!f.PlayState?.IsPaused),a=e.filter(f=>f.NowPlayingItem&&f.PlayState?.IsPaused),c=t.length+a.length;if(c===0)return{icon:"play_circle",sup:"",active:!1,title:"No active streams"};if(t.length===0)return{icon:"pause_circle",sup:`${c}`,active:!0,title:`${c} stream${c>1?"s":""} paused`};if(c===1)return{icon:"person",sup:"1",active:!0,title:"1 active stream"};let g=a.length?`, ${a.length} paused`:"";return{icon:"group",sup:`${c}`,active:!0,title:`${t.length} playing${g}`}}function We(e,t){let a=e.split("|"),c=a[0]||"{count} Active Stream",g=a[1]||a[0]||"{count} Active Streams";return(t===1?c:g).replace("{count}",String(t))}function je(e,t){let a=window,c=!1,g=null,f=null,j=null,x=null,A="",y=!1,E=null,k=0,M=null,H=!1,I=(n,r)=>e.t?.(n)||r,J=()=>ge(e.session,t()),W=()=>e.helpers?.isAdmin?.()===!0,Ce=()=>W()||e.pluginConfig?.ActiveStreamsAllUsers===!0,z=()=>M!==null&&fe(M,J());function we(){try{return e.themer?.getThemeVariables?.()?.primaryAccent||"#00a4dc"}catch{return"#00a4dc"}}let ee=()=>{document.documentElement.style.setProperty("--je-as-accent",we())};function Se(){if(document.getElementById("je-active-streams-styles"))return;let n=document.createElement("style");n.id="je-active-streams-styles",n.textContent=be,document.head.appendChild(n)}async function ke(n){if(n){let r=he(e.takePrefetched?.("ActiveStreamSessions",He));if(r)return r}try{return he(await e.core.api.plugin("/active-streams/sessions"))}catch{return null}}function o(n,r,s){let i=document.createElement(n);return r&&(i.className=r),s!==void 0&&(i.textContent=s),i}function N(n,r){let s=o("span","material-icons",n);return r&&(s.style.fontSize=r),s}function Ie(n){try{a.Emby?.Page?.showItem?a.Emby.Page.showItem(n):window.location.hash=`#!/details?id=${n}`}catch{window.location.hash=`#!/details?id=${n}`}}function Pe(n,r){let s=t(),i=n.PlayState||{},l=r.SeriesName||r.Name||"Unknown",p=r.SeriesName?`S${String(r.ParentIndexNumber||0).padStart(2,"0")}E${String(r.IndexNumber||0).padStart(2,"0")} · ${r.Name}`:r.ProductionYear?String(r.ProductionYear):"",d=i.PositionTicks||0,m=r.RunTimeTicks||0,P=m?Math.min(100,d/m*100).toFixed(1):0,v=o("div","je-as-card je-as-card-with-poster"),$=()=>o("div","je-as-poster-placeholder"),C=!!(r.SeriesId&&r.SeriesPrimaryImageTag),L=C?r.SeriesId:r.Id,T=C?r.SeriesPrimaryImageTag:r.ImageTags?.Primary;if(T&&L&&s){let u=o("img","je-as-poster");u.alt="",u.loading="lazy",u.src=s.getImageUrl(L,{type:"Primary",tag:T,height:120,quality:80}),u.addEventListener("error",()=>{u.replaceWith($())}),v.appendChild(u)}else v.appendChild($());let w=o("div","je-as-card-main"),R=o("div","je-as-card-top"),F=o("div","je-as-card-info"),Y=o("div","je-as-card-title"),oe=r.Id;if(oe&&s){let u=o("a","je-as-card-title-link",l);u.href="#",u.addEventListener("click",S=>{S.preventDefault(),Ie(oe)}),Y.appendChild(u)}else Y.textContent=l;F.appendChild(Y),p&&F.appendChild(o("div","je-as-card-subtitle",p));let $e=o("span",`je-as-state ${i.IsPaused?"je-as-state-paused":"je-as-state-playing"}`,i.IsPaused?I("downloads_status_paused","Paused"):I("toast_playing","Playing"));R.appendChild(F),R.appendChild($e),w.appendChild(R);let K=n.TranscodingInfo;if(m){let u=o("div","je-as-progress-row"),S=o("div","je-as-progress-bar");if(K&&K.CompletionPercentage!=null){let de=o("div","je-as-transcode-fill");de.style.width=`${Math.min(100,K.CompletionPercentage).toFixed(1)}%`,S.appendChild(de)}let ie=o("div","je-as-progress-fill");ie.style.width=`${P}%`,S.appendChild(ie),u.appendChild(S),u.appendChild(o("span","je-as-progress-time",`${xe(d)} / ${xe(m)}`)),w.appendChild(u)}let se=o("div","je-as-badges");for(let u of Ve(n))se.appendChild(o("span",`je-as-badge ${u.cls}`,u.label));w.appendChild(se);let U=o("div","je-as-user");if(n.UserId&&n.UserHasPrimaryImage&&s){let u=o("img","je-as-avatar");u.alt="",u.src=s.getUrl(`Users/${n.UserId}/Images/Primary`)+"?height=20&quality=80";let S=N("person");S.style.display="none",u.addEventListener("error",()=>{u.style.display="none",S.style.display="inline"}),U.appendChild(u),U.appendChild(S)}else U.appendChild(N("person"));if(U.appendChild(o("span",void 0,[n.UserName,n.Client,n.DeviceName].filter(Boolean).join(" · "))),w.appendChild(U),n.RemoteEndPoint){let u=o("div","je-as-user");u.appendChild(N("router")),u.appendChild(o("span",void 0,n.RemoteEndPoint)),w.appendChild(u)}return v.appendChild(w),v}function Te(n){let r=document.getElementById("je-active-streams-panel");if(!r)return;let s=(n||[]).filter(d=>d.NowPlayingItem),i=r.querySelector(".je-as-panel-title");i&&(i.textContent=n===null?I("active_streams_unavailable","Sessions unavailable"):s.length?We(I("active_streams_count","{count} Active Stream|{count} Active Streams"),s.length):I("active_streams_none","No Active Streams"));let l=r.querySelector(".je-as-panel-body");if(!l)return;if(l.replaceChildren(),n===null)l.appendChild(o("div","je-as-panel-error",I("active_streams_load_failed","Could not load active streams. Try refreshing.")));else if(!s.length)l.appendChild(o("div","je-as-panel-empty",I("active_streams_none","No active streams")));else for(let d of s)d.NowPlayingItem&&l.appendChild(Pe(d,d.NowPlayingItem));let p=r.querySelector(".je-as-panel-footer");p||(p=o("div","je-as-panel-footer"),r.appendChild(p)),n===null?p.textContent=x?I("active_streams_last_success","Last successful update: {time}").replace("{time}",x.toLocaleTimeString()):"":x&&(p.textContent=`Updated ${x.toLocaleTimeString()}`)}async function _(n=!1){let r=k,s=await ke(n);if(r!==k||!z())return;s!==null&&(x=new Date);let i=document.getElementById("je-active-streams");if(!i)return;let l=i.querySelector(".je-as-icon"),p=i.querySelector(".je-as-sup");if(i.classList.remove("je-as-active","je-as-err"),!s)l&&(l.textContent="cast"),p&&(p.textContent=""),i.classList.add("je-as-err"),i.title="Failed to fetch sessions";else{let d=qe(s);l&&(l.textContent=d.icon),p&&(p.textContent=d.sup),d.active&&i.classList.add("je-as-active"),i.title=d.title}c&&Te(s)}function te(n){n.result.className="je-as-broadcast-result",n.result.textContent="",n.text.value="",n.header.value="",n.timeout.value="10"}function Be(n){y=!y,n.button.classList.toggle("je-as-broadcast-active",y),n.form.classList.toggle("je-as-broadcast-form-open",y),y&&(te(n),n.text.focus())}function ne(n){y=!1,n.button.classList.remove("je-as-broadcast-active"),n.form.classList.remove("je-as-broadcast-form-open"),te(n)}async function Ee(n,r,s,i,l){let p;try{let d=_e(await e.core.api.plugin("/active-streams/broadcast",{method:"POST",body:{header:n||null,text:r,timeoutMs:s},skipRetry:!0})),m=d.errors.length?` (${d.errors.length} error${d.errors.length>1?"s":""})`:"";p={ok:!0,text:`Sent to ${d.sent} of ${d.sent+d.skipped} sessions${m}`}}catch(d){let m=B(d)?d.status:void 0,P=d instanceof Error?d.message:String(d);p=m?{ok:!1,text:`Error: ${(B(d)?b(d.responseText):void 0)||P}`}:{ok:!1,text:`Failed: ${P}`}}l===k&&(i.className=`je-as-broadcast-result ${p.ok?"je-as-broadcast-ok":"je-as-broadcast-err"}`,i.textContent=p.text)}function Ae(n){if(n.querySelector(".je-as-broadcast-btn"))return;let r=n.querySelector(".je-as-panel-header");if(!r)return;let s=o("div","je-as-broadcast-form"),i=o("input","je-as-broadcast-input");i.type="text",i.placeholder="e.g. Server Message",i.maxLength=200;let l=o("textarea","je-as-broadcast-textarea");l.placeholder="e.g. Server shutting down in 10 minutes",l.maxLength=1e3;let p=o("div","je-as-broadcast-timeout-row"),d=o("input","je-as-broadcast-timeout-input");d.type="number",d.value="10",d.min="1",d.max="3600",p.appendChild(o("span","je-as-broadcast-timeout-label","Timeout (s):")),p.appendChild(d);let m=o("div","je-as-broadcast-result"),P=o("div","je-as-broadcast-actions"),v=o("button","je-as-broadcast-send","Send"),$=o("button","je-as-broadcast-cancel","Cancel");P.appendChild($),P.appendChild(v),s.appendChild(o("div","je-as-broadcast-field-label","Title (optional)")),s.appendChild(i),s.appendChild(o("div","je-as-broadcast-field-label","Message (required)")),s.appendChild(l),s.appendChild(o("div","je-as-broadcast-field-note","⚠ Title may not show on all clients (web UI). Message is always visible.")),s.appendChild(p),s.appendChild(m),s.appendChild(P);let C=o("button","je-as-broadcast-btn");C.setAttribute("aria-label","Broadcast message to all sessions"),C.title="Broadcast message",C.appendChild(N("campaign","18px")),r.insertBefore(C,r.querySelector(".je-as-panel-close")),n.insertBefore(s,n.querySelector(".je-as-panel-body"));let L={button:C,form:s,result:m,text:l,header:i,timeout:d};C.addEventListener("click",T=>{T.stopPropagation(),Be(L)}),$.addEventListener("click",T=>{T.stopPropagation(),ne(L)}),v.addEventListener("click",T=>{T.stopPropagation(),(async()=>{let w=l.value.trim();if(!w){l.focus();return}if(!z()||!H||!W()){console.warn(`${q} Active Streams: broadcast refused, the signed-in account changed.`),O();return}let R=k,F=parseFloat(d.value)||10;v.disabled=!0,m.className="je-as-broadcast-result",m.textContent="",await Ee(i.value.trim()||void 0,w,Math.round(F*1e3),m,R),R===k&&(v.disabled=!1,E!==null&&clearTimeout(E),E=setTimeout(()=>{E=null,ne(L)},3e3))})()})}function Me(){if(!z()){O();return}let n=document.getElementById("je-active-streams-panel");if(n){if(c=!c,c){let r=document.getElementById("je-active-streams");n.style.top=r?.closest(".osdHeader, .videoOsd-appBar")?r.getBoundingClientRect().bottom+2+"px":A}n.classList.toggle("je-as-panel-open",c),c&&_()}}function Ne(){if(document.getElementById("je-active-streams-panel"))return;let n=o("div");n.id="je-active-streams-panel";let r=o("div","je-as-panel-header"),s=o("button","je-as-panel-close");s.setAttribute("aria-label","Close sessions panel"),s.appendChild(N("close","18px")),s.addEventListener("click",p=>{p.stopPropagation(),c=!1,n.classList.remove("je-as-panel-open")}),r.appendChild(o("span","je-as-panel-title","Sessions")),r.appendChild(s),n.appendChild(r),n.appendChild(o("div","je-as-panel-body")),document.body.appendChild(n);let i=e.helpers?.getHeaderBottom?.()??0;i>0&&(n.style.top=i+2+"px",A=n.style.top);let l=o("button","je-as-refresh-btn");l.setAttribute("aria-label","Refresh sessions"),l.title="Refresh",l.appendChild(N("refresh","18px")),l.addEventListener("click",p=>{p.stopPropagation(),l.classList.add("je-as-refreshing"),l.addEventListener("animationend",()=>l.classList.remove("je-as-refreshing"),{once:!0}),_()}),r.insertBefore(l,s),H&&Ae(n),j=p=>{let d=document.getElementById("je-active-streams"),m=p.target;c&&m instanceof Node&&!n.contains(m)&&d&&!d.contains(m)&&(c=!1,n.classList.remove("je-as-panel-open"))},document.addEventListener("click",j)}function Le(){let n=document.querySelector(".videoOsd-appBar");if(n){let r=[...n.querySelectorAll('[aria-controls="app-sync-play-menu"], [aria-controls="app-remote-play-menu"]')];return(r.find(i=>i.offsetParent!==null)||r[0])?.parentElement||null}return document.querySelector(".skinHeader.osdHeader .headerRight")}function re(n){let r=!!n.closest(".osdHeader, .videoOsd-appBar");n.classList.toggle("je-as-in-osd",r),n.classList.toggle("headerButton",!r),n.classList.toggle("headerButtonRight",!r)}function D(n=0,r=k){if(r!==k||document.getElementById("je-active-streams")||n>20)return;let s=e.isVideoPage?.()?Le():e.helpers?.getHeaderButtonTray?.()??null;if(!s){setTimeout(()=>D(n+1,r),500);return}if(document.getElementById("je-active-streams"))return;let i=o("button","headerButton headerButtonRight paper-icon-button-light");i.id="je-active-streams",i.type="button",i.setAttribute("is","paper-icon-button-light"),i.title="No active streams",i.dataset.headerLabel=e.t?.("activity_section_active_streams")??"";let l=o("i","material-icons je-as-icon","play_circle");l.setAttribute("aria-hidden","true");let p=o("span","je-as-sup");p.setAttribute("aria-hidden","true"),i.appendChild(l),i.appendChild(p),i.addEventListener("click",d=>{d.stopPropagation(),Me()}),s.insertBefore(i,s.firstChild),re(i),Ne(),ee(),_(!0)}function Re(){if(g)return;let n=()=>{let r=document.getElementById("je-active-streams");r?re(r):D(0)};if(e.helpers?.onBodyMutation)g=e.helpers.onBodyMutation("active-streams",n);else{let r=new MutationObserver(n);r.observe(document.body,{childList:!0,subtree:!0}),g={unsubscribe:()=>r.disconnect()}}}function ae(){if(e.pluginConfig?.ActiveStreamsEnabled&&!(M&&z())){if(M&&O(),!Ce()){console.log(`${q} Active Streams: skipping — not visible for this user.`);return}console.log(`${q} Active Streams: initializing.`),M=J(),H=W(),Se(),Re(),D(0),f=e.core.lifecycle.register("active-streams"),f.track(e.core.navigation.onNavigate(()=>{ee(),document.getElementById("je-active-streams")&&_()}))}}function O(){console.log(`${q} Active Streams: destroying.`),k++,M=null,H=!1,g?.unsubscribe(),g=null,f&&(f.teardown(),f=null),j&&(document.removeEventListener("click",j),j=null),E!==null&&(clearTimeout(E),E=null),document.getElementById("je-active-streams")?.remove(),document.getElementById("je-active-streams-panel")?.remove(),document.getElementById("je-active-streams-styles")?.remove(),c=!1,y=!1,x=null}function Oe(){e.session?.onUserChange("active-streams",O),document.addEventListener("je:user-data-loaded",n=>{let r=n instanceof CustomEvent&&B(n.detail)?h(n.detail.epoch):void 0;r!==void 0&&typeof e.session?.isCurrent=="function"&&!e.session.isCurrent(r)||ae()})}return{initialize:ae,destroy:O,bindSession:Oe}}var ve=pe(),Q=je(ve,()=>ue());le(ve,["activeStreams"]).own.activeStreams={initialize:Q.initialize,destroy:Q.destroy};Q.bindSession();})();
})();
