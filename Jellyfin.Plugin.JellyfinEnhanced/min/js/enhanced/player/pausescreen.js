(() => {
"use strict";(()=>{function L(a,l,h,e,t){let r=a.firstElementChild,s=e>0?Math.max(0,Math.min(100,h/e*100)):0;r instanceof HTMLElement&&(r.style.width=`${s}%`);let n=l.querySelector(".progress-time"),i=l.querySelector(".progress-ends-at"),c=l.querySelector(".progress-percentage");if(n&&(n.textContent=`${T(h)} / ${T(e)}`),c&&(c.textContent=t("pausescreen_watched_percent",{percent:Math.round(s)})),i)if(e>0&&h<e){let d=e-h,m=new Date(Date.now()+d*1e3).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"});i.textContent=t("pausescreen_ends_at",{time:m})}else i.textContent=""}function T(a){if(!isFinite(a)||a<=0)return"0:00";let l=Math.floor(a%60).toString().padStart(2,"0"),h=Math.floor(a/60%60).toString().padStart(2,"0"),e=Math.floor(a/3600);return e>0?`${e}:${h}:${l}`:`${Number(h)}:${l}`}function P(a,l){return!!l?.isConnected&&!!a.isVideoPage?.()}function f(a){let l=window.JellyfinEnhanced?.core?.sharedModules?.[a];if(!l)throw new Error(`${a} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return l}function p(a,l){return a[l]}var U=f("features/player/lifetime"),M=p(U,"createPlayerLifetime");var R=`
            :root {
              --pause-screen-overlay-bg: rgba(0,0,0,.78);
              --pause-screen-blur: 50px;
              --pause-screen-logo-max-w: 45vw;
              --pause-screen-logo-max-h: 20vh;
              --pause-screen-logo-top: 20vh;
              --pause-screen-logo-left: 8vw;

              --pause-screen-details-top: 45vh;
              --pause-screen-details-left: 8vw;
              --pause-screen-details-gap: 2rem;
              --pause-screen-text-size: 1.2rem;

              --pause-screen-plot-top: 55vh;
              --pause-screen-plot-left: 8vw;
              --pause-screen-plot-max-w: 50vw;
              --pause-screen-plot-font: 1.25rem;

              --pause-screen-progress-top: 85vh;
              --pause-screen-progress-width: 48vw;
              --pause-screen-progress-height: 6px;
              --pause-screen-progress-radius: 999px;

              --pause-screen-disc-w: 26vw;
              --pause-screen-disc-right: 5vw;
              --pause-screen-disc-rot-sec: 60s;
            }

            #pause-screen-overlay {
              position: fixed; inset: 0;
              display: none;
              z-index: 99;
              color: #fff;
              font-family: inherit;
              background: var(--pause-screen-overlay-bg);
            }
            #pause-screen-overlay[aria-hidden="false"] { display: flex; }

            .pause-screen-active .videoOsdBottom { opacity: 0 !important; pointer-events: none !important; }

            /* To show back button when paused */
            .pause-screen-active .skinHeader.osdHeader {
                z-index: 100 !important;
                opacity: 0.9 !important;
                visibility: visible !important;
                background: transparent !important;
                width: 10vw !important;

            }
            .pause-screen-active .skinHeader.osdHeader .headerRight {
                display: none !important;
            }

            .pause-screen-active .skinHeader.osdHeader {
                visibility: hidden !important;
            }

            .pause-screen-active .headerBackButton,
            .pause-screen-active .skinHeader.osdHeader .videoOsd-appBar > button:first-child {
                visibility: visible !important;
            }

            #pause-screen-content {
              position: relative;
              width: 100%; height: 100%;
              backdrop-filter: blur(var(--pause-screen-blur)) brightness(0.5);
              outline: none;
            }

            /* Backdrop image (under everything) */
            #pause-screen-backdrop {
              position: absolute; inset: 0;
              background-position: center;
              background-size: cover;
              opacity: .28;
              pointer-events: none;
            }

            #pause-screen-logo {
              position: absolute;
              max-width: var(--pause-screen-logo-max-w);
              max-height: var(--pause-screen-logo-max-h);
              width: auto; height: auto;
              top: var(--pause-screen-logo-top);
              left: var(--pause-screen-logo-left);
              display: block;
              object-fit: contain;
            }

            #pause-screen-details {
              position: absolute;
              top: var(--pause-screen-details-top);
              left: var(--pause-screen-details-left);
              display: flex; gap: var(--pause-screen-details-gap); align-items: center;
              font-size: var(--pause-screen-text-size);
            }

            #pause-screen-plot {
              position: absolute;
              top: var(--pause-screen-plot-top);
              left: var(--pause-screen-plot-left);
              max-width: var(--pause-screen-plot-max-w);
              height: 25vh; /* Adjusted height */
              display: block;
              font-size: var(--pause-screen-plot-font);
              line-height: 1.6;
              overflow-y: auto;
              text-align: left;
            }

            #pause-screen-disc {
              position: absolute;
              top: calc(50vh - (var(--pause-screen-disc-w) / 2));
              right: var(--pause-screen-disc-right);
              width: var(--pause-screen-disc-w);
              height: auto;
              display: block;
              animation: pause-screen-spin var(--pause-screen-disc-rot-sec) linear infinite;
              z-index: 1;
              filter: brightness(80%);
            }

            @keyframes pause-screen-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

            /* Progress UI */
            #pause-screen-progress-wrap {
              position: absolute;
              top: var(--pause-screen-progress-top);
              left: var(--pause-screen-details-left);
              width: var(--pause-screen-progress-width);
              user-select: none;
            }
            #pause-screen-progress-bar {
              width: 100%;
              height: var(--pause-screen-progress-height);
              border-radius: var(--pause-screen-progress-radius);
              background: rgba(255,255,255,.18);
              overflow: hidden;
              position: relative;
            }
            #pause-screen-progress-bar > span {
              display: block;
              height: 100%;
              width: 0%;
              background: rgba(255,255,255,.9);
            }
            #pause-screen-progress-meta {
              margin-top: .5rem;
              font-size: 0.9rem;
              opacity: .9;
              display: flex;
            }
            #pause-screen-progress-meta span::before {
              content: '•';
              margin: 1em;
            }
            #pause-screen-progress-meta .progress-ends-at::after {
              content: '•';
              margin: 1em;
            }
            #pause-screen-close-btn {
              position: absolute;
              top: 20px;
              right: 20px;
              background: rgba(0,0,0,0.1);
              border: 1px solid rgba(255,255,255,0.2);
              color: white;
              width: 1.5em;
              height: 1.5em;
              border-radius: 50%;
              font-size: 1.5em;
              display: flex;
              align-items: center;
              justify-content: center;
              cursor: pointer;
              z-index: 2;
              transition: background 0.2s;
            }
            #pause-screen-close-btn:hover,
            #pause-screen-close-btn:focus-visible {
              background: rgba(0,0,0,0.8);
            }
            #pause-screen-close-btn:focus-visible {
              outline: 2px solid #fff;
              outline-offset: 2px;
            }
            /* Accessibility helpers */
            #pause-screen-focus-start, #pause-screen-focus-end {
              position: fixed; width:1px; height:1px; overflow:hidden; clip: rect(0 0 0 0);
            }
            /* Make this selector more specific to override other plugins */
            #pause-screen-progress-meta .progress-percentage {
                font-size: inherit !important;
                font-weight: normal !important;
                color: inherit !important;
                min-width: auto !important;
                text-align: left !important;
            }

            /* Tablet */
            @media (max-width: 1400px) {
              :root {
                --pause-screen-logo-max-w: 40vw;
                --pause-screen-logo-top: 18vh;
                --pause-screen-logo-left: 6vw;
                --pause-screen-details-top: 42vh;
                --pause-screen-details-left: 6vw;
                --pause-screen-plot-top: 50vh;
                --pause-screen-plot-left: 6vw;
                --pause-screen-plot-max-w: 48vw;
                --pause-screen-disc-w: 24vw;
                --pause-screen-disc-right: 4vw;
                --pause-screen-progress-width: 44vw;
              }
            }

            /* Narrow / Portrait Mobile - Hides Disc */
            @media (max-width: 768px) {
              :root {
                --pause-screen-logo-max-w: 70vw;
                --pause-screen-logo-top: 12vh;
                --pause-screen-logo-left: 50%;
                --pause-screen-progress-width: 80vw;
                --pause-screen-progress-top: 88vh;
              }
              #pause-screen-logo { transform: translateX(-50%); }
              #pause-screen-details {
                left: 50%; transform: translateX(-50%);
                top: 32vh; font-size: 14px; justify-content: center;
              }
              #pause-screen-plot {
                top: 40vh; left: 50%; transform: translateX(-50%);
                max-width: 85vw; text-align: center; font-size: 15px; height: 45vh;
              }
              #pause-screen-disc {
                display: none; /* Hide disc on mobile layouts */
              }
            }

            /* Mobile Landscape */
            @media (max-height: 500px) and (orientation: landscape) {
              :root {
                --pause-screen-logo-max-h: 18vh;
                --pause-screen-logo-top: 8vh;
                --pause-screen-details-top: 30vh;
                --pause-screen-plot-top: 40vh;
                --pause-screen-plot-max-w: 45vw;
                --pause-screen-plot-font: 14px;
                --pause-screen-progress-top: 78vh;
                --pause-screen-disc-w: 22vw;
              }
              #pause-screen-plot { height: 35vh; }
              #pause-screen-disc { display: block; } /* Show disc again in landscape */
            }

            /* Reduced motion: stop spin */
            @media (prefers-reduced-motion: reduce) {
              #pause-screen-disc { animation: none !important; }
            }

            /* Hide absent images */
            #pause-screen-logo:not([src]), #pause-screen-disc:not([src]) { display: none; }

          `;var O=R;var j=f("features/player/host"),A=p(j,"playerHost");var B=f("features/player/wire"),D=p(B,"decodeItem");var I=p(B,"record");var{JE:o,ApiClient:y,ctx:C}=A(),k=M(o,"pause-screen"),$=6;o.initializePauseScreen=function(){if(!o.currentSettings.pauseScreenEnabled){o.pauseScreenInstance?.destroy(),console.log("🪼 Jellyfin Enhanced: Custom Pause Screen is disabled.");return}if(o.pauseScreenInstance?.overlay?.isConnected)return;o.pauseScreenInstance?.destroy();let a=()=>C.own.nowPlaying;class l{constructor(){this.generation=0;this.destroyed=!1;this.currentVideo=null;this.currentItemId=null;this.readyItemId=null;this.syncing=0;this.userId=null;this.token=null;this.cleanupListeners=null;this.imgBlobCache=new Map;this.imgProbeCache=new Map;this.itemCache=new Map;this.fetchAbort=null;this.observer=null;this.prevFocused=null;this.pauseScreenDelayMs=(o.currentSettings.pauseScreenDelaySeconds??5)*1e3;this.pauseScreenTimer=null;this.lastUserInteractionAt=Date.now();this.interactionListeners=null;this._dismissedThisPause=!1;this.overlay=document.createElement("div");this.overlayContent=document.createElement("div");this.overlayLogo=document.createElement("img");this.overlayPlot=document.createElement("div");this.overlayDetails=document.createElement("div");this.overlayDisc=document.createElement("img");this.overlayBackdrop=document.createElement("div");this.progressWrap=document.createElement("div");this.progressBar=document.createElement("div");this.progressMeta=document.createElement("div");this.focusStart=document.createElement("div");this.focusEnd=document.createElement("div");this.closeButton=document.createElement("button");this.keyboardListener=null;this.imageRequests=new Set;this.init()}init(){let e=this.getCredentials();if(!e){console.error("🪼 Jellyfin Enhanced: Jellyfin credentials not found");return}this.userId=e.userId,this.token=e.token,this.releaseReset=k.onReset(()=>{!this.destroyed&&!P(o,this.currentVideo)&&this.clearState()}),this.releaseUser=o.session?.onUserChange("pause-screen",()=>{if(!this.destroyed){this.clearState();for(let t of this.imgBlobCache.values())URL.revokeObjectURL(t);this.imgBlobCache.clear(),this.imgProbeCache.clear(),this.itemCache.clear(),this.userId=null,this.token=null,this.credentialTimer=window.setTimeout(()=>{if(this.destroyed)return;let t=this.getCredentials();this.userId=t?.userId||null,this.token=t?.token||null},0)}}),this.injectStyles(),this.createOverlay(),this.setupKeyboardAccessibility(),this.setupVideoObserver(),this.setupInteractionListeners()}getCredentials(){let e=localStorage.getItem("jellyfin_credentials");if(!e)return null;try{let t=I(JSON.parse(e)),r=Array.isArray(t.Servers)?t.Servers.map(I):[],s=null;try{s=(typeof y.serverId=="function"?y.serverId():y.serverId)||null}catch{s=null}let n=s?r.find(i=>i.Id===s):r[0];return n&&typeof n.AccessToken=="string"&&typeof n.UserId=="string"?{token:n.AccessToken,userId:n.UserId}:null}catch{return null}}injectStyles(){let e=document.createElement("style");e.id="pause-screen-style",e.textContent=O,document.head.appendChild(e)}createOverlay(){this.overlay=document.createElement("div"),this.overlay.id="pause-screen-overlay",this.overlay.setAttribute("role","dialog"),this.overlay.setAttribute("aria-hidden","true"),this.overlay.setAttribute("aria-modal","true"),this.focusStart=document.createElement("div"),this.focusStart.id="pause-screen-focus-start",this.focusStart.tabIndex=0,this.focusEnd=document.createElement("div"),this.focusEnd.id="pause-screen-focus-end",this.focusEnd.tabIndex=0,this.overlayContent=document.createElement("div"),this.overlayContent.id="pause-screen-content",this.overlayContent.tabIndex=-1,this.overlayBackdrop=document.createElement("div"),this.overlayBackdrop.id="pause-screen-backdrop",this.overlayLogo=document.createElement("img"),this.overlayLogo.id="pause-screen-logo",this.overlayDetails=document.createElement("div"),this.overlayDetails.id="pause-screen-details",this.overlayPlot=document.createElement("div"),this.overlayPlot.id="pause-screen-plot",this.progressWrap=document.createElement("div"),this.progressWrap.id="pause-screen-progress-wrap",this.progressBar=document.createElement("div"),this.progressBar.id="pause-screen-progress-bar";let e=document.createElement("span");this.progressBar.appendChild(e),this.progressMeta=document.createElement("div"),this.progressMeta.id="pause-screen-progress-meta",this.progressMeta.innerHTML=`
              <span class="progress-time"></span>
              <span class="progress-percentage"></span>
              <span class="progress-ends-at"></span>
          `,this.progressWrap.appendChild(this.progressBar),this.progressWrap.appendChild(this.progressMeta),this.overlayDisc=document.createElement("img"),this.overlayDisc.id="pause-screen-disc";let t=document.createElement("button");t.id="pause-screen-close-btn",t.innerHTML="&times;",t.onclick=()=>{this.hideOverlay(!0)},this.closeButton=t,this.overlayContent.appendChild(this.overlayBackdrop),this.overlayContent.appendChild(this.overlayLogo),this.overlayContent.appendChild(this.overlayDetails),this.overlayContent.appendChild(this.overlayPlot),this.overlayContent.appendChild(this.progressWrap),this.overlayContent.appendChild(t),this.overlay.appendChild(this.focusStart),this.overlay.appendChild(this.overlayContent),this.overlay.appendChild(this.overlayDisc),this.overlay.appendChild(this.focusEnd),document.body.appendChild(this.overlay);let r=n=>{(n.target===this.overlay||n.target===this.overlayContent)&&(o.state?.pauseScreenClickTimer&&clearTimeout(o.state.pauseScreenClickTimer),o.state.pauseScreenClickTimer=window.setTimeout(()=>{o.state.pauseScreenClickTimer=null,this.hideOverlay(),this.currentVideo?.paused&&this.currentVideo.play().catch(i=>console.warn("Play blocked",i))},500))};this.overlay.addEventListener("click",r),this.overlay.addEventListener("touchstart",r,{passive:!0});let s=n=>{this.overlay.getAttribute("aria-hidden")==="false"&&(n.target===this.focusStart&&this.overlayContent.focus(),n.target===this.focusEnd&&this.overlayContent.focus())};this.focusStart.addEventListener("focus",s),this.focusEnd.addEventListener("focus",s)}handleRemoteKey(e){let t=()=>{e.preventDefault(),e.stopImmediatePropagation()};return e.key==="ArrowUp"||e.key==="ArrowRight"?(t(),this.closeButton.focus(),!0):e.key==="ArrowDown"||e.key==="ArrowLeft"?(t(),this.overlayContent.focus(),!0):e.key==="Escape"||e.key==="BrowserBack"||e.keyCode===10009||e.keyCode===461?(t(),this.hideOverlay(!0),!0):e.key==="Enter"&&document.activeElement===this.closeButton?(t(),this.hideOverlay(!0),!0):!1}setupKeyboardAccessibility(){this.keyboardListener=e=>{if(this.overlay.getAttribute("aria-hidden")==="false"){if(o.core.ui.isTvLayout()&&this.handleRemoteKey(e))return;(e.code==="Space"||e.code==="Enter")&&(e.preventDefault(),e.stopPropagation(),this.hideOverlay(),this.currentVideo&&this.currentVideo.paused&&this.currentVideo.play().catch(t=>console.warn("🪼 Jellyfin Enhanced: Play() blocked:",t))),e.code==="Tab"&&(this.overlay.contains(document.activeElement)||(this.overlayContent.focus(),e.preventDefault()))}},document.addEventListener("keydown",this.keyboardListener,{capture:!0})}setupVideoObserver(){this.observer=o.helpers.onBodyMutation("pausescreen",()=>this.checkForVideoChanges()),this.checkForVideoChanges()}resetPauseScreenTimer(){this.lastUserInteractionAt=Date.now(),this.schedulePauseOverlayDelay()}schedulePauseOverlayDelay(){if(this.pauseScreenTimer&&(clearTimeout(this.pauseScreenTimer),this.pauseScreenTimer=null),!this.currentVideo||!this.currentVideo.paused||this.currentVideo.ended||this._dismissedThisPause)return;let e=()=>{let t=this.currentVideo;if(!t||!t.paused||t.ended){this.pauseScreenTimer=null;return}let r=Date.now()-this.lastUserInteractionAt;if(r>=this.pauseScreenDelayMs){if(this.syncing){this.pauseScreenTimer=setTimeout(e,250);return}this.pauseScreenTimer=null;let n=a().itemIdFromSource(t);if(n&&n!==this.readyItemId){this.syncItem(t).then(()=>this.schedulePauseOverlayDelay());return}this.readyItemId&&this.readyItemId===this.currentItemId&&this.showOverlay();return}let s=Math.max(100,this.pauseScreenDelayMs-r);this.pauseScreenTimer=setTimeout(e,s)};this.pauseScreenTimer=setTimeout(e,this.pauseScreenDelayMs)}setupInteractionListeners(){let e=null,t=null,r=15,s=()=>this.resetPauseScreenTimer(),n=["mousedown","click","touchstart","touchmove","keydown","wheel"];this.interactionListeners=n.map(c=>{let d=s;return document.addEventListener(c,d,{passive:!0}),{event:c,listener:d}});let i=c=>{if(!(c instanceof MouseEvent))return;let d=c.clientX,u=c.clientY;e!==null&&t!==null?Math.sqrt(Math.pow(d-e,2)+Math.pow(u-t,2))>r&&s():(e=d,t=u),e=d,t=u};document.addEventListener("mousemove",i,{passive:!0}),this.interactionListeners.push({event:"mousemove",listener:i})}checkForVideoChanges(){let e=document.querySelector(".videoPlayerContainer video");e&&e!==this.currentVideo?this.handleVideoChange(e):!e&&this.currentVideo&&this.clearState()}async handleVideoChange(e){this.clearState(),this.currentVideo=e,this.cleanupListeners=this.attachVideoListeners(e),this.itemCache.clear(),this.imgProbeCache.clear();let t=a(),r=t.itemIdFromSource(e)||t.itemIdFromRoute();r&&(this.currentItemId=r,await this.fetchItemInfo(r))}invalidateIdentity(){this.generation++;for(let e of this.imageRequests)e.abort();this.imageRequests.clear(),this.overlay.getAttribute("aria-hidden")==="false"&&this.hideOverlay(),this.clearDisplayData(),this.pauseScreenTimer&&(clearTimeout(this.pauseScreenTimer),this.pauseScreenTimer=null),this.fetchAbort&&(this.fetchAbort.abort(),this.fetchAbort=null),this.currentItemId=null,this.readyItemId=null}async syncItem(e){let t=e.currentSrc,r=this.generation;this.syncing++;try{let s=await a().resolveItemId(e);return this.destroyed||r!==this.generation||e!==this.currentVideo||e.currentSrc!==t?null:s?((s!==this.currentItemId||s!==this.readyItemId)&&(this.currentItemId=s,this.readyItemId=null,await this.fetchItemInfo(s)),this.readyItemId===s?s:null):(this.invalidateIdentity(),null)}finally{this.syncing--}}attachVideoListeners(e){let t=()=>{if(e===this.currentVideo&&!e.ended){this.syncItem(e).then(i=>{i&&e===this.currentVideo&&e.paused&&this.schedulePauseOverlayDelay()}),this.updateProgressStatic(),this.pauseScreenTimer&&(clearTimeout(this.pauseScreenTimer),this.pauseScreenTimer=null);let n=C.peer("resumeRatingsPolling");typeof n=="function"&&n(),this._dismissedThisPause=!1,this.lastUserInteractionAt=Date.now(),this.resetPauseScreenTimer()}},r=()=>{if(e===this.currentVideo){this.pauseScreenTimer&&(clearTimeout(this.pauseScreenTimer),this.pauseScreenTimer=null);let n=C.peer("pauseRatingsPolling");typeof n=="function"&&n(),this.hideOverlay()}},s=()=>{e===this.currentVideo&&this.invalidateIdentity()};return e.addEventListener("pause",t),e.addEventListener("play",r),e.addEventListener("loadstart",s),e.addEventListener("emptied",s),()=>{e.removeEventListener("pause",t),e.removeEventListener("play",r),e.removeEventListener("loadstart",s),e.removeEventListener("emptied",s)}}showOverlay(){window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches?this.overlayDisc.style.animation="none":this.overlayDisc.style.animation="",this.prevFocused=document.activeElement,document.documentElement.classList.add("pause-screen-active"),this.overlay.setAttribute("aria-hidden","false"),this.overlayContent.focus()}hideOverlay(e=!1){document.documentElement.classList.remove("pause-screen-active"),this.overlay.setAttribute("aria-hidden","true"),e&&(this._dismissedThisPause=!0),this.prevFocused&&document.contains(this.prevFocused)&&this.prevFocused instanceof HTMLElement&&this.prevFocused.focus()}clearDisplayData(){this.overlayPlot.textContent="",this.overlayDetails.innerHTML="",this.overlayLogo.removeAttribute("src"),this.overlayDisc.removeAttribute("src"),this.overlayBackdrop.style.backgroundImage="",this.setProgress(0,0)}async fetchItemInfo(e){let t=++this.generation;this.clearDisplayData(),this.fetchAbort?.abort(),this.fetchAbort=new AbortController;try{let r=this.itemCache.get(e);if(!r){let s=await this.fetchWithRetry(y.getUrl(`/Items/${e}`),{headers:{Authorization:'MediaBrowser Token="'+this.token+'"',"X-Emby-Token":this.token??"",Accept:"application/json"},signal:this.fetchAbort.signal});if(this.destroyed||t!==this.generation||!s)return;r={item:s,domain:y.serverAddress()},this.itemCache.set(e,r)}await this.displayItemInfo(r.item,r.domain,e),!this.destroyed&&t===this.generation&&(this.readyItemId=e)}catch(r){if(this.destroyed||t!==this.generation)return;r instanceof Error&&r.name==="AbortError"||(console.error("🪼 Jellyfin Enhanced: Error fetching item info:",r),this.overlayPlot.textContent=o.t("pausescreen_fetch_error"))}}async fetchWithRetry(e,t,r=2){for(let s=0;s<=r;s++)try{let n=await fetch(e,t);if(!n.ok)throw new Error(`HTTP ${n.status}`);return D(await n.json())}catch(n){if(s===r||t.signal?.aborted)throw n;let i=t.signal??k.lease().signal;if(await k.sleep(1e3*(s+1),i),i.aborted)throw new DOMException("Cancelled","AbortError")}}async displayItemInfo(e,t,r){let s=this.generation,n=e.ProductionYear||"",i=e.OfficialRating||"",c=this.formatRuntime(e.RunTimeTicks);this.overlayDetails.replaceChildren();for(let[g,v]of[[n,!1],[i,!0],[c,!1]]){if(!g)continue;let b=document.createElement("span");b.textContent=String(g),v&&(b.className="mediaInfoOfficialRating",b.setAttribute("rating",String(g))),this.overlayDetails.appendChild(b)}this.overlayPlot.textContent=e.Overview||o.t("pausescreen_no_description");let d=g=>g.map(v=>`${v}${v.includes("?")?"&":"?"}maxWidth=${Math.round((window.screen.width||1920)*(window.devicePixelRatio||1))}`),u=d(this.getLogoUrls(e,t,r)),m=d(this.getDiscUrls(e,t,r)),w=d(this.getBackdropUrls(e,t,r)),[E,S,x]=await Promise.all([this.firstAvailableBlobURL(u),this.firstAvailableBlobURL(m),this.firstAvailableBlobURL(w)]);this.destroyed||s!==this.generation||(E&&(this.overlayLogo.src=E),S&&(this.overlayDisc.src=S),x&&(this.overlayBackdrop.style.backgroundImage=`url("${x}")`),this.updateProgressStatic())}formatRuntime(e){if(!e)return"";let t=Math.floor(e/6e8),r=Math.floor(t/60),s=t%60;return r>0?`${r}h ${s}m`:`${s}m`}updateProgressStatic(){if(!this.currentVideo)return this.setProgress(0,0);let e=Number.isFinite(this.currentVideo.currentTime)?this.currentVideo.currentTime:0,t=Number.isFinite(this.currentVideo.duration)?this.currentVideo.duration:0;this.setProgress(e,t)}setProgress(e,t){L(this.progressBar,this.progressMeta,e,t,(r,s)=>o.t(r,s))}async firstAvailableBlobURL(e){let t=this.generation;for(let r of e){if(this.destroyed||t!==this.generation)return null;if(!r)continue;let s=await this.probeImage(r);if(this.destroyed||t!==this.generation)return null;if(!s)continue;let n=await this.toBlobURL(r);if(this.destroyed||t!==this.generation)return null;if(n)return n}return null}async probeImage(e,t=2500){let r=this.generation;if(this.destroyed)return!1;if(this.imgProbeCache.has(e))return this.imgProbeCache.get(e);let s=new AbortController;this.imageRequests.add(s);let n=window.setTimeout(()=>s.abort(),t);try{let i=await fetch(e,{method:"HEAD",headers:{Authorization:'MediaBrowser Token="'+this.token+'"',"X-Emby-Token":this.token??""},signal:s.signal});if(clearTimeout(n),this.destroyed||r!==this.generation)return!1;let c=i.ok;return this.imgProbeCache.set(e,c),c}catch{return this.destroyed||r!==this.generation||this.imgProbeCache.set(e,!1),!1}finally{clearTimeout(n),this.imageRequests.delete(s)}}async toBlobURL(e,t=5e3){let r=this.generation;if(this.destroyed)return null;let s=this.imgBlobCache.get(e);if(s)return this.imgBlobCache.delete(e),this.imgBlobCache.set(e,s),s;let n=new AbortController;this.imageRequests.add(n);let i=window.setTimeout(()=>n.abort(),t);try{let c=await fetch(e,{headers:{Authorization:'MediaBrowser Token="'+this.token+'"',"X-Emby-Token":this.token??""},signal:n.signal});if(clearTimeout(i),this.destroyed||r!==this.generation||!c.ok)return null;let d=await c.blob();if(this.destroyed||r!==this.generation)return null;let u=URL.createObjectURL(d);this.imgBlobCache.set(e,u);for(let[m,w]of this.imgBlobCache)this.imgBlobCache.size>$&&(URL.revokeObjectURL(w),this.imgBlobCache.delete(m));return u}catch{return null}finally{clearTimeout(i),this.imageRequests.delete(n)}}getLogoUrls(e,t,r){let s=[];return e.ImageTags?.Logo&&s.push(`${t}/Items/${encodeURIComponent(r)}/Images/Logo?tag=${encodeURIComponent(e.ImageTags.Logo)}`),e.ParentId&&s.push(`${t}/Items/${encodeURIComponent(e.ParentId)}/Images/Logo`),e.SeriesId&&s.push(`${t}/Items/${encodeURIComponent(e.SeriesId)}/Images/Logo`),s}getDiscUrls(e,t,r){let s=[`${t}/Items/${encodeURIComponent(r)}/Images/Disc`];return e.ParentId&&s.push(`${t}/Items/${encodeURIComponent(e.ParentId)}/Images/Disc`),e.SeriesId&&s.push(`${t}/Items/${encodeURIComponent(e.SeriesId)}/Images/Disc`),s}getBackdropUrls(e,t,r){let s=[`${t}/Items/${encodeURIComponent(r)}/Images/Backdrop`];return e.ParentId&&s.push(`${t}/Items/${encodeURIComponent(e.ParentId)}/Images/Backdrop`),e.SeriesId&&s.push(`${t}/Items/${encodeURIComponent(e.SeriesId)}/Images/Backdrop`),s}clearState(){this.generation++,o.state?.pauseScreenClickTimer&&(clearTimeout(o.state.pauseScreenClickTimer),o.state.pauseScreenClickTimer=null);for(let e of this.imageRequests)e.abort();this.imageRequests.clear(),this.hideOverlay(),this.clearDisplayData(),this.pauseScreenTimer&&(clearTimeout(this.pauseScreenTimer),this.pauseScreenTimer=null),this.cleanupListeners&&(this.cleanupListeners(),this.cleanupListeners=null),this.fetchAbort&&(this.fetchAbort.abort(),this.fetchAbort=null),this.currentItemId=null,this.readyItemId=null,this.currentVideo=null}destroy(){this.destroyed=!0,typeof this.releaseReset=="function"&&this.releaseReset(),typeof this.releaseUser=="function"&&this.releaseUser(),clearTimeout(this.credentialTimer),this.keyboardListener&&(document.removeEventListener("keydown",this.keyboardListener,{capture:!0}),this.keyboardListener=null),this.overlay&&this.clearState(),this.observer&&(this.observer.unsubscribe(),this.observer=null),this.interactionListeners&&(this.interactionListeners.forEach(({event:t,listener:r})=>{document.removeEventListener(t,r)}),this.interactionListeners=null);for(let t of this.imgBlobCache.values())URL.revokeObjectURL(t);this.imgBlobCache.clear(),this.imgProbeCache.clear(),this.itemCache.clear(),this.overlay?.parentNode&&this.overlay.parentNode.removeChild(this.overlay);let e=document.getElementById("pause-screen-style");e&&e.remove()}}o.pauseScreenInstance=new l,console.log("🪼 Jellyfin Enhanced: Custom Pause Screen initialized.")};})();
})();
