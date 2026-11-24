(() => {
"use strict";(()=>{function le(e,t,o){let d=t.core?.featureContext;if(typeof d!="function")throw new Error(`${e}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);return d(e,t,o)}function ce(e,t){return le("chrome",e,{facades:t})}function ue(){let e=window;if(!e.JellyfinEnhanced)throw new Error("Jellyfin Enhanced must initialize before chrome modules");return e.JellyfinEnhanced}function pe(){return window.ApiClient}function q(e){return typeof e=="string"&&e.length>0?e:null}function $e(e){let t=null,o=null;try{t=q(e?.getCurrentUserId?.())}catch{}try{let d=e?.serverId;o=q(typeof d=="function"?d.call(e):d)||q(e?._serverInfo?.Id)}catch{}return{userId:t,serverId:o}}function fe(e,t){let o=$e(t),d=null;try{d=typeof e?.getEpoch=="function"?e.getEpoch():null}catch{d=null}let f=x=>{try{return q(x())}catch{return null}},m=f(()=>t?.accessToken?.()),j=f(()=>t?.getUrl?.("/"));return{userId:o.userId,serverId:o.serverId,epoch:d,client:t,credentialsCurrent:()=>f(()=>t?.accessToken?.())===m&&f(()=>t?.getUrl?.("/"))===j}}function me(e,t){return e.client===t.client&&e.credentialsCurrent()&&t.credentialsCurrent()&&e.userId===t.userId&&e.serverId===t.serverId&&e.epoch===t.epoch}var ge=`
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
}`;var be=ge;function he(e,t){let d=document.createElement.call(document,e,t);return d.getAttribute("is")!==t&&d.setAttribute("is",t),d}var V="🪼 Jellyfin Enhanced:",ze=5e3,P=e=>typeof e=="object"&&e!==null&&!Array.isArray(e),b=e=>typeof e=="string"?e:void 0,h=e=>typeof e=="number"&&Number.isFinite(e)?e:void 0,G=e=>typeof e=="boolean"?e:void 0;function Z(e){for(let t of Object.keys(e))e[t]===void 0&&delete e[t];return e}function X(e,t){return P(e)?Z(t(e)):void 0}function _e(e){return P(e)?Z({UserId:b(e.UserId),UserName:b(e.UserName),UserHasPrimaryImage:G(e.UserHasPrimaryImage),Client:b(e.Client),DeviceName:b(e.DeviceName),RemoteEndPoint:b(e.RemoteEndPoint),NowPlayingItem:X(e.NowPlayingItem,t=>({Id:b(t.Id),Name:b(t.Name),SeriesName:b(t.SeriesName),RunTimeTicks:h(t.RunTimeTicks),ProductionYear:h(t.ProductionYear),ParentIndexNumber:h(t.ParentIndexNumber),IndexNumber:h(t.IndexNumber),ImageTags:P(t.ImageTags)?Object.fromEntries(Object.entries(t.ImageTags).filter(o=>typeof o[1]=="string")):void 0,SeriesId:b(t.SeriesId),SeriesPrimaryImageTag:b(t.SeriesPrimaryImageTag),MediaStreams:Array.isArray(t.MediaStreams)?t.MediaStreams.filter(P).map(o=>Z({Type:b(o.Type),Codec:b(o.Codec),BitRate:h(o.BitRate)})):void 0})),PlayState:X(e.PlayState,t=>({IsPaused:G(t.IsPaused),PositionTicks:h(t.PositionTicks),PlayMethod:b(t.PlayMethod)})),TranscodingInfo:X(e.TranscodingInfo,t=>({IsVideoDirect:G(t.IsVideoDirect),VideoCodec:b(t.VideoCodec),AudioCodec:b(t.AudioCodec),Bitrate:h(t.Bitrate),CompletionPercentage:h(t.CompletionPercentage),TranscodeReasons:Array.isArray(t.TranscodeReasons)?t.TranscodeReasons.filter(o=>typeof o=="string"):void 0,Width:h(t.Width),Height:h(t.Height),Framerate:h(t.Framerate)}))}):null}function xe(e){return Array.isArray(e)?e.map(_e).filter(t=>t!==null):null}function qe(e){if(!P(e))throw new Error("Invalid broadcast response");let t=h(e.sent),o=h(e.skipped);if(t===void 0||o===void 0)throw new Error("Invalid broadcast response");let d=Array.isArray(e.errors)?e.errors.map(String):[];return{sent:t,skipped:o,errors:d}}function ye(e){if(!e)return"0:00";let t=Math.floor(e/1e7),o=Math.floor(t/3600),d=Math.floor(t%3600/60),f=t%60;return o>0?`${o}:${String(d).padStart(2,"0")}:${String(f).padStart(2,"0")}`:`${d}:${String(f).padStart(2,"0")}`}var je=e=>{let t=Math.round(e/1e3);return t>=1e3?`${(t/1e3).toFixed(1)} Mbps`:`${t} kbps`};function Ve(e){let t=[],o=e.TranscodingInfo,d=e.PlayState||{};if(o&&o.IsVideoDirect===!1)t.push({label:"Transcoding",cls:"je-as-badge-transcode"}),o.VideoCodec&&t.push({label:o.VideoCodec.toUpperCase(),cls:"je-as-badge-neutral"}),o.AudioCodec&&t.push({label:o.AudioCodec.toUpperCase(),cls:"je-as-badge-neutral"}),o.Bitrate&&t.push({label:je(o.Bitrate),cls:"je-as-badge-neutral"}),o.Width&&o.Height&&t.push({label:`${o.Width}×${o.Height}`,cls:"je-as-badge-neutral"}),o.Framerate&&t.push({label:`${Math.round(o.Framerate)}fps`,cls:"je-as-badge-neutral"});else{t.push({label:"Direct Play",cls:"je-as-badge-direct"});let f=e.NowPlayingItem?.MediaStreams?.find(m=>m.Type==="Video");f?.Codec&&t.push({label:f.Codec.toUpperCase(),cls:"je-as-badge-neutral"}),f?.BitRate&&t.push({label:je(f.BitRate),cls:"je-as-badge-neutral"})}if(d.PlayMethod==="Transcode"&&o?.TranscodeReasons?.length){let f=e.NowPlayingItem?.MediaStreams||[];for(let m of o.TranscodeReasons){t.push({label:m.replace(/([A-Z])/g," $1").trim(),cls:"je-as-badge-reason"});let j=m==="AudioCodecNotSupported"?[f.find(y=>y.Type==="Audio")?.Codec,o.AudioCodec]:m==="VideoCodecNotSupported"?[f.find(y=>y.Type==="Video")?.Codec,o.VideoCodec]:null,[x,M]=j??[];x&&M&&x.toLowerCase()!==M.toLowerCase()&&t.push({label:`${x.toUpperCase()} → ${M.toUpperCase()}`,cls:"je-as-badge-reason"})}}return t}function De(e){let t=e.filter(m=>m.NowPlayingItem&&!m.PlayState?.IsPaused),o=e.filter(m=>m.NowPlayingItem&&m.PlayState?.IsPaused),d=t.length+o.length;if(d===0)return{icon:"play_circle",sup:"",active:!1,title:"No active streams"};if(t.length===0)return{icon:"pause_circle",sup:`${d}`,active:!0,title:`${d} stream${d>1?"s":""} paused`};if(d===1)return{icon:"person",sup:"1",active:!0,title:"1 active stream"};let f=o.length?`, ${o.length} paused`:"";return{icon:"group",sup:`${d}`,active:!0,title:`${t.length} playing${f}`}}function We(e,t){let o=e.split("|"),d=o[0]||"{count} Active Stream",f=o[1]||o[0]||"{count} Active Streams";return(t===1?d:f).replace("{count}",String(t))}function ve(e,t){let o=window,d=!1,f=null,m=null,j=null,x=null,M="",y=!1,B=null,T=0,L=null,U=!1,I=(n,r)=>e.t?.(n)||r,J=()=>fe(e.session,t()),D=()=>e.helpers?.isAdmin?.()===!0,we=()=>D()||e.pluginConfig?.ActiveStreamsAllUsers===!0,z=()=>L!==null&&me(L,J());function Se(){try{return e.themer?.getThemeVariables?.()?.primaryAccent||"#00a4dc"}catch{return"#00a4dc"}}let ee=()=>{document.documentElement.style.setProperty("--je-as-accent",Se())};function Te(){if(document.getElementById("je-active-streams-styles"))return;let n=document.createElement("style");n.id="je-active-streams-styles",n.textContent=be,document.head.appendChild(n)}async function Ie(n){if(n){let r=xe(e.takePrefetched?.("ActiveStreamSessions",ze));if(r)return r}try{return xe(await e.core.api.plugin("/active-streams/sessions"))}catch{return null}}function a(n,r,s){let i=document.createElement(n);return r&&(i.className=r),s!==void 0&&(i.textContent=s),i}function A(n,r){let s=a("span","material-icons",n);return r&&(s.style.fontSize=r),s}function Ee(n){try{o.Emby?.Page?.showItem?o.Emby.Page.showItem(n):window.location.hash=`#!/details?id=${n}`}catch{window.location.hash=`#!/details?id=${n}`}}function ke(n,r){let s=t(),i=n.PlayState||{},c=r.SeriesName||r.Name||"Unknown",u=r.SeriesName?`S${String(r.ParentIndexNumber||0).padStart(2,"0")}E${String(r.IndexNumber||0).padStart(2,"0")} · ${r.Name}`:r.ProductionYear?String(r.ProductionYear):"",l=i.PositionTicks||0,g=r.RunTimeTicks||0,E=g?Math.min(100,l/g*100).toFixed(1):0,v=a("div","je-as-card je-as-card-with-poster"),O=()=>a("div","je-as-poster-placeholder"),C=!!(r.SeriesId&&r.SeriesPrimaryImageTag),H=C?r.SeriesId:r.Id,k=C?r.SeriesPrimaryImageTag:r.ImageTags?.Primary;if(k&&H&&s){let p=a("img","je-as-poster");p.alt="",p.loading="lazy",p.src=s.getImageUrl(H,{type:"Primary",tag:k,height:120,quality:80}),p.addEventListener("error",()=>{p.replaceWith(O())}),v.appendChild(p)}else v.appendChild(O());let w=a("div","je-as-card-main"),N=a("div","je-as-card-top"),F=a("div","je-as-card-info"),K=a("div","je-as-card-title"),ae=r.Id;if(ae&&s){let p=a("a","je-as-card-title-link",c);p.href="#",p.addEventListener("click",S=>{S.preventDefault(),Ee(ae)}),K.appendChild(p)}else K.textContent=c;F.appendChild(K),u&&F.appendChild(a("div","je-as-card-subtitle",u));let Fe=a("span",`je-as-state ${i.IsPaused?"je-as-state-paused":"je-as-state-playing"}`,i.IsPaused?I("downloads_status_paused","Paused"):I("toast_playing","Playing"));N.appendChild(F),N.appendChild(Fe),w.appendChild(N);let Y=n.TranscodingInfo;if(g){let p=a("div","je-as-progress-row"),S=a("div","je-as-progress-bar");if(Y&&Y.CompletionPercentage!=null){let de=a("div","je-as-transcode-fill");de.style.width=`${Math.min(100,Y.CompletionPercentage).toFixed(1)}%`,S.appendChild(de)}let ie=a("div","je-as-progress-fill");ie.style.width=`${E}%`,S.appendChild(ie),p.appendChild(S),p.appendChild(a("span","je-as-progress-time",`${ye(l)} / ${ye(g)}`)),w.appendChild(p)}let se=a("div","je-as-badges");for(let p of Ve(n))se.appendChild(a("span",`je-as-badge ${p.cls}`,p.label));w.appendChild(se);let $=a("div","je-as-user");if(n.UserId&&n.UserHasPrimaryImage&&s){let p=a("img","je-as-avatar");p.alt="",p.src=s.getUrl(`Users/${n.UserId}/Images/Primary`)+"?height=20&quality=80";let S=A("person");S.style.display="none",p.addEventListener("error",()=>{p.style.display="none",S.style.display="inline"}),$.appendChild(p),$.appendChild(S)}else $.appendChild(A("person"));if($.appendChild(a("span",void 0,[n.UserName,n.Client,n.DeviceName].filter(Boolean).join(" · "))),w.appendChild($),n.RemoteEndPoint){let p=a("div","je-as-user");p.appendChild(A("router")),p.appendChild(a("span",void 0,n.RemoteEndPoint)),w.appendChild(p)}return v.appendChild(w),v}function Pe(n){let r=document.getElementById("je-active-streams-panel");if(!r)return;let s=(n||[]).filter(l=>l.NowPlayingItem),i=r.querySelector(".je-as-panel-title");i&&(i.textContent=n===null?I("active_streams_unavailable","Sessions unavailable"):s.length?We(I("active_streams_count","{count} Active Stream|{count} Active Streams"),s.length):I("active_streams_none","No Active Streams"));let c=r.querySelector(".je-as-panel-body");if(!c)return;if(c.replaceChildren(),n===null)c.appendChild(a("div","je-as-panel-error",I("active_streams_load_failed","Could not load active streams. Try refreshing.")));else if(!s.length)c.appendChild(a("div","je-as-panel-empty",I("active_streams_none","No active streams")));else for(let l of s)l.NowPlayingItem&&c.appendChild(ke(l,l.NowPlayingItem));let u=r.querySelector(".je-as-panel-footer");u||(u=a("div","je-as-panel-footer"),r.appendChild(u)),n===null?u.textContent=x?I("active_streams_last_success","Last successful update: {time}").replace("{time}",x.toLocaleTimeString()):"":x&&(u.textContent=`Updated ${x.toLocaleTimeString()}`)}async function _(n=!1){let r=T,s=await Ie(n);if(r!==T||!z())return;s!==null&&(x=new Date);let i=document.getElementById("je-active-streams");if(!i)return;let c=i.querySelector(".je-as-icon"),u=i.querySelector(".je-as-sup");if(i.classList.remove("je-as-active","je-as-err"),!s)c&&(c.textContent="cast"),u&&(u.textContent=""),i.classList.add("je-as-err"),i.title="Failed to fetch sessions";else{let l=De(s);c&&(c.textContent=l.icon),u&&(u.textContent=l.sup),l.active&&i.classList.add("je-as-active"),i.title=l.title}d&&Pe(s)}function te(n){n.result.className="je-as-broadcast-result",n.result.textContent="",n.text.value="",n.header.value="",n.timeout.value="10"}function Be(n){y=!y,n.button.classList.toggle("je-as-broadcast-active",y),n.form.classList.toggle("je-as-broadcast-form-open",y),y&&(te(n),n.text.focus())}function ne(n){y=!1,n.button.classList.remove("je-as-broadcast-active"),n.form.classList.remove("je-as-broadcast-form-open"),te(n)}async function Me(n,r,s,i,c){let u;try{let l=qe(await e.core.api.plugin("/active-streams/broadcast",{method:"POST",body:{header:n||null,text:r,timeoutMs:s},skipRetry:!0})),g=l.errors.length?` (${l.errors.length} error${l.errors.length>1?"s":""})`:"";u={ok:!0,text:`Sent to ${l.sent} of ${l.sent+l.skipped} sessions${g}`}}catch(l){let g=P(l)?l.status:void 0,E=l instanceof Error?l.message:String(l);u=g?{ok:!1,text:`Error: ${(P(l)?b(l.responseText):void 0)||E}`}:{ok:!1,text:`Failed: ${E}`}}c===T&&(i.className=`je-as-broadcast-result ${u.ok?"je-as-broadcast-ok":"je-as-broadcast-err"}`,i.textContent=u.text)}function Le(n){if(n.querySelector(".je-as-broadcast-btn"))return;let r=n.querySelector(".je-as-panel-header");if(!r)return;let s=a("div","je-as-broadcast-form"),i=a("input","je-as-broadcast-input");i.type="text",i.placeholder="e.g. Server Message",i.maxLength=200;let c=a("textarea","je-as-broadcast-textarea");c.placeholder="e.g. Server shutting down in 10 minutes",c.maxLength=1e3;let u=a("div","je-as-broadcast-timeout-row"),l=a("input","je-as-broadcast-timeout-input");l.type="number",l.value="10",l.min="1",l.max="3600",u.appendChild(a("span","je-as-broadcast-timeout-label","Timeout (s):")),u.appendChild(l);let g=a("div","je-as-broadcast-result"),E=a("div","je-as-broadcast-actions"),v=a("button","je-as-broadcast-send","Send"),O=a("button","je-as-broadcast-cancel","Cancel");E.appendChild(O),E.appendChild(v),s.appendChild(a("div","je-as-broadcast-field-label","Title (optional)")),s.appendChild(i),s.appendChild(a("div","je-as-broadcast-field-label","Message (required)")),s.appendChild(c),s.appendChild(a("div","je-as-broadcast-field-note","⚠ Title may not show on all clients (web UI). Message is always visible.")),s.appendChild(u),s.appendChild(g),s.appendChild(E);let C=a("button","je-as-broadcast-btn");C.setAttribute("aria-label","Broadcast message to all sessions"),C.title="Broadcast message",C.appendChild(A("campaign","18px")),r.insertBefore(C,r.querySelector(".je-as-panel-close")),n.insertBefore(s,n.querySelector(".je-as-panel-body"));let H={button:C,form:s,result:g,text:c,header:i,timeout:l};C.addEventListener("click",k=>{k.stopPropagation(),Be(H)}),O.addEventListener("click",k=>{k.stopPropagation(),ne(H)}),v.addEventListener("click",k=>{k.stopPropagation(),(async()=>{let w=c.value.trim();if(!w){c.focus();return}if(!z()||!U||!D()){console.warn(`${V} Active Streams: broadcast refused, the signed-in account changed.`),R();return}let N=T,F=parseFloat(l.value)||10;v.disabled=!0,g.className="je-as-broadcast-result",g.textContent="",await Me(i.value.trim()||void 0,w,Math.round(F*1e3),g,N),N===T&&(v.disabled=!1,B!==null&&clearTimeout(B),B=setTimeout(()=>{B=null,ne(H)},3e3))})()})}function Ae(){if(!z()){R();return}let n=document.getElementById("je-active-streams-panel");if(n){if(d=!d,d){let r=document.getElementById("je-active-streams");n.style.top=r?.closest(".osdHeader, .videoOsd-appBar")?r.getBoundingClientRect().bottom+2+"px":M}n.classList.toggle("je-as-panel-open",d),d&&_()}}function He(){if(document.getElementById("je-active-streams-panel"))return;let n=a("div");n.id="je-active-streams-panel";let r=a("div","je-as-panel-header"),s=a("button","je-as-panel-close");s.setAttribute("aria-label","Close sessions panel"),s.appendChild(A("close","18px")),s.addEventListener("click",u=>{u.stopPropagation(),d=!1,n.classList.remove("je-as-panel-open")}),r.appendChild(a("span","je-as-panel-title","Sessions")),r.appendChild(s),n.appendChild(r),n.appendChild(a("div","je-as-panel-body")),document.body.appendChild(n);let i=e.helpers?.getHeaderBottom?.()??0;i>0&&(n.style.top=i+2+"px",M=n.style.top);let c=a("button","je-as-refresh-btn");c.setAttribute("aria-label","Refresh sessions"),c.title="Refresh",c.appendChild(A("refresh","18px")),c.addEventListener("click",u=>{u.stopPropagation(),c.classList.add("je-as-refreshing"),c.addEventListener("animationend",()=>c.classList.remove("je-as-refreshing"),{once:!0}),_()}),r.insertBefore(c,s),U&&Le(n),j=u=>{let l=document.getElementById("je-active-streams"),g=u.target;d&&g instanceof Node&&!n.contains(g)&&l&&!l.contains(g)&&(d=!1,n.classList.remove("je-as-panel-open"))},document.addEventListener("click",j)}function Ne(){let n=document.querySelector(".videoOsd-appBar");if(n){let r=[...n.querySelectorAll('[aria-controls="app-sync-play-menu"], [aria-controls="app-remote-play-menu"]')];return(r.find(i=>i.offsetParent!==null)||r[0])?.parentElement||null}return document.querySelector(".skinHeader.osdHeader .headerRight")}function re(n){let r=!!n.closest(".osdHeader, .videoOsd-appBar");n.classList.toggle("je-as-in-osd",r),n.classList.toggle("headerButton",!r),n.classList.toggle("headerButtonRight",!r)}function W(n=0,r=T){if(r!==T||document.getElementById("je-active-streams")||n>20)return;let s=e.isVideoPage?.()?Ne():e.helpers?.getHeaderButtonTray?.()??null;if(!s){setTimeout(()=>W(n+1,r),500);return}if(document.getElementById("je-active-streams"))return;let i=he("button","paper-icon-button-light");i.classList.add("headerButton","headerButtonRight","paper-icon-button-light"),i.id="je-active-streams",i.type="button",i.title="No active streams",i.dataset.headerLabel=e.t?.("activity_section_active_streams")??"";let c=a("i","material-icons je-as-icon","play_circle");c.setAttribute("aria-hidden","true");let u=a("span","je-as-sup");u.setAttribute("aria-hidden","true"),i.appendChild(c),i.appendChild(u),i.addEventListener("click",l=>{l.stopPropagation(),Ae()}),s.insertBefore(i,s.firstChild),re(i),He(),ee(),_(!0)}function Re(){if(f)return;let n=()=>{let r=document.getElementById("je-active-streams");r?re(r):W(0)};if(e.helpers?.onBodyMutation)f=e.helpers.onBodyMutation("active-streams",n);else{let r=new MutationObserver(n);r.observe(document.body,{childList:!0,subtree:!0}),f={unsubscribe:()=>r.disconnect()}}}function oe(){if(e.pluginConfig?.ActiveStreamsEnabled&&!(L&&z())){if(L&&R(),!we()){console.log(`${V} Active Streams: skipping — not visible for this user.`);return}console.log(`${V} Active Streams: initializing.`),L=J(),U=D(),Te(),Re(),W(0),m=e.core.lifecycle.register("active-streams"),m.track(e.core.navigation.onNavigate(()=>{ee(),document.getElementById("je-active-streams")&&_()}))}}function R(){console.log(`${V} Active Streams: destroying.`),T++,L=null,U=!1,f?.unsubscribe(),f=null,m&&(m.teardown(),m=null),j&&(document.removeEventListener("click",j),j=null),B!==null&&(clearTimeout(B),B=null),document.getElementById("je-active-streams")?.remove(),document.getElementById("je-active-streams-panel")?.remove(),document.getElementById("je-active-streams-styles")?.remove(),d=!1,y=!1,x=null}function Oe(){e.session?.onUserChange("active-streams",R),document.addEventListener("je:user-data-loaded",n=>{let r=n instanceof CustomEvent&&P(n.detail)?h(n.detail.epoch):void 0;r!==void 0&&typeof e.session?.isCurrent=="function"&&!e.session.isCurrent(r)||oe()})}return{initialize:oe,destroy:R,bindSession:Oe}}var Ce=ue(),Q=ve(Ce,()=>pe());ce(Ce,["activeStreams"]).own.activeStreams={initialize:Q.initialize,destroy:Q.destroy};Q.bindSession();})();
})();
