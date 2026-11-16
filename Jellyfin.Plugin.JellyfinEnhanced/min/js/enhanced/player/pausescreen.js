(() => {
"use strict";(()=>{function f(o){let c=window.JellyfinEnhanced?.core?.sharedModules?.[o];if(!c)throw new Error(`${o} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return c}function p(o,c){return o[c]}var L=f("features/player/wire"),P=p(L,"decodeItem");var I=p(L,"record");function R(o,c,u,e,t){let s=o.firstElementChild,r=e>0?Math.max(0,Math.min(100,u/e*100)):0;s instanceof HTMLElement&&(s.style.width=`${r}%`);let n=c.querySelector(".progress-time"),a=c.querySelector(".progress-ends-at"),l=c.querySelector(".progress-percentage");if(n&&(n.textContent=`${M(u)} / ${M(e)}`),l&&(l.textContent=t("pausescreen_watched_percent",{percent:Math.round(r)})),a)if(e>0&&u<e){let d=e-u,m=new Date(Date.now()+d*1e3).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"});a.textContent=t("pausescreen_ends_at",{time:m})}else a.textContent=""}function M(o){if(!isFinite(o)||o<=0)return"0:00";let c=Math.floor(o%60).toString().padStart(2,"0"),u=Math.floor(o/60%60).toString().padStart(2,"0"),e=Math.floor(o/3600);return e>0?`${e}:${u}:${c}`:`${Number(u)}:${c}`}function O(o,c){return!!c?.isConnected&&!!o.isVideoPage?.()}var C="[data-je-own-keys]";function A(o){let c=localStorage.getItem("jellyfin_credentials");if(!c)return null;try{let u=I(JSON.parse(c)),e=Array.isArray(u.Servers)?u.Servers.map(I):[],t=null;try{t=o()}catch{t=null}let s=t?e.find(r=>r.Id===t):e[0];return s&&typeof s.AccessToken=="string"&&typeof s.UserId=="string"?{token:s.AccessToken,userId:s.UserId}:null}catch{return null}}var j=f("features/player/lifetime"),B=p(j,"createPlayerLifetime");var D=`
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

          `;var U=D;var H=f("features/player/host"),V=p(H,"playerHost");var{JE:i,ApiClient:y,ctx:E}=V(),S=B(i,"pause-screen"),F=6;i.initializePauseScreen=function(){if(!i.currentSettings.pauseScreenEnabled){i.pauseScreenInstance?.destroy(),console.log("🪼 Jellyfin Enhanced: Custom Pause Screen is disabled.");return}if(i.pauseScreenInstance?.overlay?.isConnected)return;i.pauseScreenInstance?.destroy();let o=()=>E.own.nowPlaying;class c{constructor(){this.generation=0;this.destroyed=!1;this.currentVideo=null;this.currentItemId=null;this.readyItemId=null;this.syncing=0;this.userId=null;this.token=null;this.cleanupListeners=null;this.imgBlobCache=new Map;this.imgProbeCache=new Map;this.itemCache=new Map;this.fetchAbort=null;this.observer=null;this.prevFocused=null;this.pauseScreenDelayMs=(i.currentSettings.pauseScreenDelaySeconds??5)*1e3;this.pauseScreenTimer=null;this.lastUserInteractionAt=Date.now();this.interactionListeners=null;this._dismissedThisPause=!1;this.overlay=document.createElement("div");this.overlayContent=document.createElement("div");this.overlayLogo=document.createElement("img");this.overlayPlot=document.createElement("div");this.overlayDetails=document.createElement("div");this.overlayDisc=document.createElement("img");this.overlayBackdrop=document.createElement("div");this.progressWrap=document.createElement("div");this.progressBar=document.createElement("div");this.progressMeta=document.createElement("div");this.focusStart=document.createElement("div");this.focusEnd=document.createElement("div");this.closeButton=document.createElement("button");this.keyboardListener=null;this.imageRequests=new Set;this.init()}init(){let e=this.getCredentials();if(!e){console.error("🪼 Jellyfin Enhanced: Jellyfin credentials not found");return}this.userId=e.userId,this.token=e.token,this.releaseReset=S.onReset(()=>{!this.destroyed&&!O(i,this.currentVideo)&&this.clearState()}),this.releaseUser=i.session?.onUserChange("pause-screen",()=>{if(!this.destroyed){this.clearState();for(let t of this.imgBlobCache.values())URL.revokeObjectURL(t);this.imgBlobCache.clear(),this.imgProbeCache.clear(),this.itemCache.clear(),this.userId=null,this.token=null,this.credentialTimer=window.setTimeout(()=>{if(this.destroyed)return;let t=this.getCredentials();this.userId=t?.userId||null,this.token=t?.token||null},0)}}),this.injectStyles(),this.createOverlay(),this.setupKeyboardAccessibility(),this.setupVideoObserver(),this.setupInteractionListeners()}getCredentials(){return A(()=>(typeof y.serverId=="function"?y.serverId():y.serverId)||null)}injectStyles(){let e=document.createElement("style");e.id="pause-screen-style",e.textContent=U,document.head.appendChild(e)}createOverlay(){this.overlay=document.createElement("div"),this.overlay.id="pause-screen-overlay",this.overlay.setAttribute("role","dialog"),this.overlay.setAttribute("aria-hidden","true"),this.overlay.setAttribute("aria-modal","true"),this.focusStart=document.createElement("div"),this.focusStart.id="pause-screen-focus-start",this.focusStart.tabIndex=0,this.focusEnd=document.createElement("div"),this.focusEnd.id="pause-screen-focus-end",this.focusEnd.tabIndex=0,this.overlayContent=document.createElement("div"),this.overlayContent.id="pause-screen-content",this.overlayContent.tabIndex=-1,this.overlayBackdrop=document.createElement("div"),this.overlayBackdrop.id="pause-screen-backdrop",this.overlayLogo=document.createElement("img"),this.overlayLogo.id="pause-screen-logo",this.overlayDetails=document.createElement("div"),this.overlayDetails.id="pause-screen-details",this.overlayPlot=document.createElement("div"),this.overlayPlot.id="pause-screen-plot",this.progressWrap=document.createElement("div"),this.progressWrap.id="pause-screen-progress-wrap",this.progressBar=document.createElement("div"),this.progressBar.id="pause-screen-progress-bar";let e=document.createElement("span");this.progressBar.appendChild(e),this.progressMeta=document.createElement("div"),this.progressMeta.id="pause-screen-progress-meta",this.progressMeta.innerHTML=`
              <span class="progress-time"></span>
              <span class="progress-percentage"></span>
              <span class="progress-ends-at"></span>
          `,this.progressWrap.appendChild(this.progressBar),this.progressWrap.appendChild(this.progressMeta),this.overlayDisc=document.createElement("img"),this.overlayDisc.id="pause-screen-disc";let t=document.createElement("button");t.id="pause-screen-close-btn",t.innerHTML="&times;",t.onclick=()=>{this.hideOverlay(!0)},this.closeButton=t,this.overlayContent.appendChild(this.overlayBackdrop),this.overlayContent.appendChild(this.overlayLogo),this.overlayContent.appendChild(this.overlayDetails),this.overlayContent.appendChild(this.overlayPlot),this.overlayContent.appendChild(this.progressWrap),this.overlayContent.appendChild(t),this.overlay.appendChild(this.focusStart),this.overlay.appendChild(this.overlayContent),this.overlay.appendChild(this.overlayDisc),this.overlay.appendChild(this.focusEnd),document.body.appendChild(this.overlay);let s=n=>{(n.target===this.overlay||n.target===this.overlayContent)&&(i.state?.pauseScreenClickTimer&&clearTimeout(i.state.pauseScreenClickTimer),i.state.pauseScreenClickTimer=window.setTimeout(()=>{i.state.pauseScreenClickTimer=null,this.hideOverlay(),this.currentVideo?.paused&&this.currentVideo.play().catch(a=>console.warn("Play blocked",a))},500))};this.overlay.addEventListener("click",s),this.overlay.addEventListener("touchstart",s,{passive:!0});let r=n=>{this.overlay.getAttribute("aria-hidden")==="false"&&(n.target===this.focusStart&&this.overlayContent.focus(),n.target===this.focusEnd&&this.overlayContent.focus())};this.focusStart.addEventListener("focus",r),this.focusEnd.addEventListener("focus",r)}handleRemoteKey(e){let t=()=>{e.preventDefault(),e.stopImmediatePropagation()};return e.key==="ArrowUp"||e.key==="ArrowRight"?(t(),this.closeButton.focus(),!0):e.key==="ArrowDown"||e.key==="ArrowLeft"?(t(),this.overlayContent.focus(),!0):e.key==="Escape"||e.key==="BrowserBack"||e.keyCode===10009||e.keyCode===461?(t(),this.hideOverlay(!0),!0):e.key==="Enter"&&document.activeElement===this.closeButton?(t(),this.hideOverlay(!0),!0):!1}setupKeyboardAccessibility(){this.keyboardListener=e=>{if(!(e.target instanceof Element&&e.target.closest(C))&&this.overlay.getAttribute("aria-hidden")==="false"){if(i.core.ui.isTvLayout()&&this.handleRemoteKey(e))return;(e.code==="Space"||e.code==="Enter")&&(e.preventDefault(),e.stopPropagation(),this.hideOverlay(),this.currentVideo&&this.currentVideo.paused&&this.currentVideo.play().catch(t=>console.warn("🪼 Jellyfin Enhanced: Play() blocked:",t))),e.code==="Tab"&&(this.overlay.contains(document.activeElement)||(this.overlayContent.focus(),e.preventDefault()))}},document.addEventListener("keydown",this.keyboardListener,{capture:!0})}setupVideoObserver(){this.observer=i.helpers.onBodyMutation("pausescreen",()=>this.checkForVideoChanges()),this.checkForVideoChanges()}resetPauseScreenTimer(){this.lastUserInteractionAt=Date.now(),this.schedulePauseOverlayDelay()}schedulePauseOverlayDelay(){if(this.pauseScreenTimer&&(clearTimeout(this.pauseScreenTimer),this.pauseScreenTimer=null),!this.currentVideo||!this.currentVideo.paused||this.currentVideo.ended||this._dismissedThisPause)return;let e=()=>{let t=this.currentVideo;if(!t||!t.paused||t.ended){this.pauseScreenTimer=null;return}if(document.querySelector(C)){this.pauseScreenTimer=setTimeout(e,500);return}let s=Date.now()-this.lastUserInteractionAt;if(s>=this.pauseScreenDelayMs){if(this.syncing){this.pauseScreenTimer=setTimeout(e,250);return}this.pauseScreenTimer=null;let n=o().itemIdFromSource(t);if(n&&n!==this.readyItemId){this.syncItem(t).then(()=>this.schedulePauseOverlayDelay());return}this.readyItemId&&this.readyItemId===this.currentItemId&&this.showOverlay();return}let r=Math.max(100,this.pauseScreenDelayMs-s);this.pauseScreenTimer=setTimeout(e,r)};this.pauseScreenTimer=setTimeout(e,this.pauseScreenDelayMs)}setupInteractionListeners(){let e=null,t=null,s=15,r=()=>this.resetPauseScreenTimer(),n=["mousedown","click","touchstart","touchmove","keydown","wheel"];this.interactionListeners=n.map(l=>{let d=r;return document.addEventListener(l,d,{passive:!0}),{event:l,listener:d}});let a=l=>{if(!(l instanceof MouseEvent))return;let d=l.clientX,h=l.clientY;e!==null&&t!==null?Math.sqrt(Math.pow(d-e,2)+Math.pow(h-t,2))>s&&r():(e=d,t=h),e=d,t=h};document.addEventListener("mousemove",a,{passive:!0}),this.interactionListeners.push({event:"mousemove",listener:a})}checkForVideoChanges(){let e=document.querySelector(".videoPlayerContainer video");e&&e!==this.currentVideo?this.handleVideoChange(e):!e&&this.currentVideo&&this.clearState()}async handleVideoChange(e){this.clearState(),this.currentVideo=e,this.cleanupListeners=this.attachVideoListeners(e),this.itemCache.clear(),this.imgProbeCache.clear();let t=o(),s=t.itemIdFromSource(e)||t.itemIdFromRoute();s&&(this.currentItemId=s,await this.fetchItemInfo(s))}invalidateIdentity(){this.generation++;for(let e of this.imageRequests)e.abort();this.imageRequests.clear(),this.overlay.getAttribute("aria-hidden")==="false"&&this.hideOverlay(),this.clearDisplayData(),this.pauseScreenTimer&&(clearTimeout(this.pauseScreenTimer),this.pauseScreenTimer=null),this.fetchAbort&&(this.fetchAbort.abort(),this.fetchAbort=null),this.currentItemId=null,this.readyItemId=null}async syncItem(e){let t=e.currentSrc,s=this.generation;this.syncing++;try{let r=await o().resolveItemId(e);return this.destroyed||s!==this.generation||e!==this.currentVideo||e.currentSrc!==t?null:r?((r!==this.currentItemId||r!==this.readyItemId)&&(this.currentItemId=r,this.readyItemId=null,await this.fetchItemInfo(r)),this.readyItemId===r?r:null):(this.invalidateIdentity(),null)}finally{this.syncing--}}attachVideoListeners(e){let t=()=>{if(e===this.currentVideo&&!e.ended){this.syncItem(e).then(a=>{a&&e===this.currentVideo&&e.paused&&this.schedulePauseOverlayDelay()}),this.updateProgressStatic(),this.pauseScreenTimer&&(clearTimeout(this.pauseScreenTimer),this.pauseScreenTimer=null);let n=E.peer("resumeRatingsPolling");typeof n=="function"&&n(),this._dismissedThisPause=!1,this.lastUserInteractionAt=Date.now(),this.resetPauseScreenTimer()}},s=()=>{if(e===this.currentVideo){this.pauseScreenTimer&&(clearTimeout(this.pauseScreenTimer),this.pauseScreenTimer=null);let n=E.peer("pauseRatingsPolling");typeof n=="function"&&n(),this.hideOverlay()}},r=()=>{e===this.currentVideo&&this.invalidateIdentity()};return e.addEventListener("pause",t),e.addEventListener("play",s),e.addEventListener("loadstart",r),e.addEventListener("emptied",r),()=>{e.removeEventListener("pause",t),e.removeEventListener("play",s),e.removeEventListener("loadstart",r),e.removeEventListener("emptied",r)}}showOverlay(){window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches?this.overlayDisc.style.animation="none":this.overlayDisc.style.animation="",this.prevFocused=document.activeElement,document.documentElement.classList.add("pause-screen-active"),this.overlay.setAttribute("aria-hidden","false"),this.overlayContent.focus()}hideOverlay(e=!1){document.documentElement.classList.remove("pause-screen-active"),this.overlay.setAttribute("aria-hidden","true"),e&&(this._dismissedThisPause=!0),this.prevFocused&&document.contains(this.prevFocused)&&this.prevFocused instanceof HTMLElement&&this.prevFocused.focus()}clearDisplayData(){this.overlayPlot.textContent="",this.overlayDetails.innerHTML="",this.overlayLogo.removeAttribute("src"),this.overlayDisc.removeAttribute("src"),this.overlayBackdrop.style.backgroundImage="",this.setProgress(0,0)}async fetchItemInfo(e){let t=++this.generation;this.clearDisplayData(),this.fetchAbort?.abort(),this.fetchAbort=new AbortController;try{let s=this.itemCache.get(e);if(!s){let r=await this.fetchWithRetry(y.getUrl(`/Items/${e}`),{headers:{Authorization:'MediaBrowser Token="'+this.token+'"',"X-Emby-Token":this.token??"",Accept:"application/json"},signal:this.fetchAbort.signal});if(this.destroyed||t!==this.generation||!r)return;s={item:r,domain:y.serverAddress()},this.itemCache.set(e,s)}await this.displayItemInfo(s.item,s.domain,e),!this.destroyed&&t===this.generation&&(this.readyItemId=e)}catch(s){if(this.destroyed||t!==this.generation)return;s instanceof Error&&s.name==="AbortError"||(console.error("🪼 Jellyfin Enhanced: Error fetching item info:",s),this.overlayPlot.textContent=i.t("pausescreen_fetch_error"))}}async fetchWithRetry(e,t,s=2){for(let r=0;r<=s;r++)try{let n=await fetch(e,t);if(!n.ok)throw new Error(`HTTP ${n.status}`);return P(await n.json())}catch(n){if(r===s||t.signal?.aborted)throw n;let a=t.signal??S.lease().signal;if(await S.sleep(1e3*(r+1),a),a.aborted)throw new DOMException("Cancelled","AbortError")}}async displayItemInfo(e,t,s){let r=this.generation,n=e.ProductionYear||"",a=e.OfficialRating||"",l=this.formatRuntime(e.RunTimeTicks);this.overlayDetails.replaceChildren();for(let[g,v]of[[n,!1],[a,!0],[l,!1]]){if(!g)continue;let b=document.createElement("span");b.textContent=String(g),v&&(b.className="mediaInfoOfficialRating",b.setAttribute("rating",String(g))),this.overlayDetails.appendChild(b)}this.overlayPlot.textContent=e.Overview||i.t("pausescreen_no_description");let d=g=>g.map(v=>`${v}${v.includes("?")?"&":"?"}maxWidth=${Math.round((window.screen.width||1920)*(window.devicePixelRatio||1))}`),h=d(this.getLogoUrls(e,t,s)),m=d(this.getDiscUrls(e,t,s)),w=d(this.getBackdropUrls(e,t,s)),[k,x,T]=await Promise.all([this.firstAvailableBlobURL(h),this.firstAvailableBlobURL(m),this.firstAvailableBlobURL(w)]);this.destroyed||r!==this.generation||(k&&(this.overlayLogo.src=k),x&&(this.overlayDisc.src=x),T&&(this.overlayBackdrop.style.backgroundImage=`url("${T}")`),this.updateProgressStatic())}formatRuntime(e){if(!e)return"";let t=Math.floor(e/6e8),s=Math.floor(t/60),r=t%60;return s>0?`${s}h ${r}m`:`${r}m`}updateProgressStatic(){if(!this.currentVideo)return this.setProgress(0,0);let e=Number.isFinite(this.currentVideo.currentTime)?this.currentVideo.currentTime:0,t=Number.isFinite(this.currentVideo.duration)?this.currentVideo.duration:0;this.setProgress(e,t)}setProgress(e,t){R(this.progressBar,this.progressMeta,e,t,(s,r)=>i.t(s,r))}async firstAvailableBlobURL(e){let t=this.generation;for(let s of e){if(this.destroyed||t!==this.generation)return null;if(!s)continue;let r=await this.probeImage(s);if(this.destroyed||t!==this.generation)return null;if(!r)continue;let n=await this.toBlobURL(s);if(this.destroyed||t!==this.generation)return null;if(n)return n}return null}async probeImage(e,t=2500){let s=this.generation;if(this.destroyed)return!1;if(this.imgProbeCache.has(e))return this.imgProbeCache.get(e);let r=new AbortController;this.imageRequests.add(r);let n=window.setTimeout(()=>r.abort(),t);try{let a=await fetch(e,{method:"HEAD",headers:{Authorization:'MediaBrowser Token="'+this.token+'"',"X-Emby-Token":this.token??""},signal:r.signal});if(clearTimeout(n),this.destroyed||s!==this.generation)return!1;let l=a.ok;return this.imgProbeCache.set(e,l),l}catch{return this.destroyed||s!==this.generation||this.imgProbeCache.set(e,!1),!1}finally{clearTimeout(n),this.imageRequests.delete(r)}}async toBlobURL(e,t=5e3){let s=this.generation;if(this.destroyed)return null;let r=this.imgBlobCache.get(e);if(r)return this.imgBlobCache.delete(e),this.imgBlobCache.set(e,r),r;let n=new AbortController;this.imageRequests.add(n);let a=window.setTimeout(()=>n.abort(),t);try{let l=await fetch(e,{headers:{Authorization:'MediaBrowser Token="'+this.token+'"',"X-Emby-Token":this.token??""},signal:n.signal});if(clearTimeout(a),this.destroyed||s!==this.generation||!l.ok)return null;let d=await l.blob();if(this.destroyed||s!==this.generation)return null;let h=URL.createObjectURL(d);this.imgBlobCache.set(e,h);for(let[m,w]of this.imgBlobCache)this.imgBlobCache.size>F&&(URL.revokeObjectURL(w),this.imgBlobCache.delete(m));return h}catch{return null}finally{clearTimeout(a),this.imageRequests.delete(n)}}getLogoUrls(e,t,s){let r=[];return e.ImageTags?.Logo&&r.push(`${t}/Items/${encodeURIComponent(s)}/Images/Logo?tag=${encodeURIComponent(e.ImageTags.Logo)}`),e.ParentId&&r.push(`${t}/Items/${encodeURIComponent(e.ParentId)}/Images/Logo`),e.SeriesId&&r.push(`${t}/Items/${encodeURIComponent(e.SeriesId)}/Images/Logo`),r}getDiscUrls(e,t,s){let r=[`${t}/Items/${encodeURIComponent(s)}/Images/Disc`];return e.ParentId&&r.push(`${t}/Items/${encodeURIComponent(e.ParentId)}/Images/Disc`),e.SeriesId&&r.push(`${t}/Items/${encodeURIComponent(e.SeriesId)}/Images/Disc`),r}getBackdropUrls(e,t,s){let r=[`${t}/Items/${encodeURIComponent(s)}/Images/Backdrop`];return e.ParentId&&r.push(`${t}/Items/${encodeURIComponent(e.ParentId)}/Images/Backdrop`),e.SeriesId&&r.push(`${t}/Items/${encodeURIComponent(e.SeriesId)}/Images/Backdrop`),r}clearState(){this.generation++,i.state?.pauseScreenClickTimer&&(clearTimeout(i.state.pauseScreenClickTimer),i.state.pauseScreenClickTimer=null);for(let e of this.imageRequests)e.abort();this.imageRequests.clear(),this.hideOverlay(),this.clearDisplayData(),this.pauseScreenTimer&&(clearTimeout(this.pauseScreenTimer),this.pauseScreenTimer=null),this.cleanupListeners&&(this.cleanupListeners(),this.cleanupListeners=null),this.fetchAbort&&(this.fetchAbort.abort(),this.fetchAbort=null),this.currentItemId=null,this.readyItemId=null,this.currentVideo=null}destroy(){this.destroyed=!0,typeof this.releaseReset=="function"&&this.releaseReset(),typeof this.releaseUser=="function"&&this.releaseUser(),clearTimeout(this.credentialTimer),this.keyboardListener&&(document.removeEventListener("keydown",this.keyboardListener,{capture:!0}),this.keyboardListener=null),this.overlay&&this.clearState(),this.observer&&(this.observer.unsubscribe(),this.observer=null),this.interactionListeners&&(this.interactionListeners.forEach(({event:t,listener:s})=>{document.removeEventListener(t,s)}),this.interactionListeners=null);for(let t of this.imgBlobCache.values())URL.revokeObjectURL(t);this.imgBlobCache.clear(),this.imgProbeCache.clear(),this.itemCache.clear(),this.overlay?.parentNode&&this.overlay.parentNode.removeChild(this.overlay);let e=document.getElementById("pause-screen-style");e&&e.remove()}}i.pauseScreenInstance=new c,console.log("🪼 Jellyfin Enhanced: Custom Pause Screen initialized.")};})();
})();
