(() => {
"use strict";
(() => {
  // client/src/features/player/pause-view.ts
  function renderPauseProgress(progressBar, progressMeta, current, duration, t) {
    const fill = progressBar.firstElementChild;
    const pct = duration > 0 ? Math.max(0, Math.min(100, current / duration * 100)) : 0;
    if (fill instanceof HTMLElement) fill.style.width = `${pct}%`;
    const timeEl = progressMeta.querySelector(".progress-time");
    const endsAtEl = progressMeta.querySelector(".progress-ends-at");
    const percentageEl = progressMeta.querySelector(".progress-percentage");
    if (timeEl) {
      timeEl.textContent = `${formatClock(current)} / ${formatClock(duration)}`;
    }
    if (percentageEl) {
      percentageEl.textContent = t("pausescreen_watched_percent", { percent: Math.round(pct) });
    }
    if (endsAtEl) {
      if (duration > 0 && current < duration) {
        const remainingSeconds = duration - current;
        const endTime = new Date(Date.now() + remainingSeconds * 1e3);
        const formattedEndTime = endTime.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        endsAtEl.textContent = t("pausescreen_ends_at", { time: formattedEndTime });
      } else {
        endsAtEl.textContent = "";
      }
    }
  }
  function formatClock(sec) {
    if (!isFinite(sec) || sec <= 0) return "0:00";
    const s = Math.floor(sec % 60).toString().padStart(2, "0");
    const m = Math.floor(sec / 60 % 60).toString().padStart(2, "0");
    const h = Math.floor(sec / 3600);
    return h > 0 ? `${h}:${m}:${s}` : `${Number(m)}:${s}`;
  }
  function continuesPlayback(JE2, video) {
    return !!video?.isConnected && !!JE2.isVideoPage?.();
  }

  // client/src/host/context.ts
  function sharedModule(id) {
    const namespace = window.JellyfinEnhanced?.core?.sharedModules?.[id];
    if (!namespace) throw new Error(`${id} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);
    return namespace;
  }
  function sharedExport(namespace, name) {
    return namespace[name];
  }

  // client/generated-shared/stub/client/src/features/player/lifetime.ts
  var shared = /* @__PURE__ */ sharedModule("features/player/lifetime");
  var export0 = /* @__PURE__ */ sharedExport(shared, "createPlayerLifetime");

  // client/src/features/player/pause-screen.css
  var pause_screen_default = `
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

          `;

  // client/src/features/player/pause-styles.ts
  var pauseStyles = pause_screen_default;

  // client/generated-shared/stub/client/src/features/player/host.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/player/host");
  var export02 = /* @__PURE__ */ sharedExport(shared2, "playerHost");

  // client/generated-shared/stub/client/src/features/player/wire.ts
  var shared3 = /* @__PURE__ */ sharedModule("features/player/wire");
  var export03 = /* @__PURE__ */ sharedExport(shared3, "decodeItem");
  var export4 = /* @__PURE__ */ sharedExport(shared3, "record");

  // client/src/features/player/pausescreen.ts
  var { JE, ApiClient, ctx } = export02();
  var lifetime = export0(JE, "pause-screen");
  var MAX_KEPT_IMAGES = 6;
  JE.initializePauseScreen = function() {
    if (!JE.currentSettings.pauseScreenEnabled) {
      JE.pauseScreenInstance?.destroy();
      console.log("🪼 Jellyfin Enhanced: Custom Pause Screen is disabled.");
      return;
    }
    if (JE.pauseScreenInstance?.overlay?.isConnected) return;
    JE.pauseScreenInstance?.destroy();
    const nowPlaying = () => ctx.own.nowPlaying;
    class JellyfinPauseScreen {
      constructor() {
        this.generation = 0;
        this.destroyed = false;
        this.currentVideo = null;
        this.currentItemId = null;
        this.readyItemId = null;
        this.syncing = 0;
        this.userId = null;
        this.token = null;
        this.cleanupListeners = null;
        this.imgBlobCache = /* @__PURE__ */ new Map();
        this.imgProbeCache = /* @__PURE__ */ new Map();
        this.itemCache = /* @__PURE__ */ new Map();
        this.fetchAbort = null;
        this.observer = null;
        this.prevFocused = null;
        this.pauseScreenDelayMs = (JE.currentSettings.pauseScreenDelaySeconds ?? 5) * 1e3;
        this.pauseScreenTimer = null;
        this.lastUserInteractionAt = Date.now();
        this.interactionListeners = null;
        this._dismissedThisPause = false;
        this.overlay = document.createElement("div");
        this.overlayContent = document.createElement("div");
        this.overlayLogo = document.createElement("img");
        this.overlayPlot = document.createElement("div");
        this.overlayDetails = document.createElement("div");
        this.overlayDisc = document.createElement("img");
        this.overlayBackdrop = document.createElement("div");
        this.progressWrap = document.createElement("div");
        this.progressBar = document.createElement("div");
        this.progressMeta = document.createElement("div");
        this.focusStart = document.createElement("div");
        this.focusEnd = document.createElement("div");
        this.closeButton = document.createElement("button");
        this.keyboardListener = null;
        this.imageRequests = /* @__PURE__ */ new Set();
        this.init();
      }
      init() {
        const credentials = this.getCredentials();
        if (!credentials) {
          console.error("🪼 Jellyfin Enhanced: Jellyfin credentials not found");
          return;
        }
        this.userId = credentials.userId;
        this.token = credentials.token;
        this.releaseReset = lifetime.onReset(() => {
          if (!this.destroyed && !continuesPlayback(JE, this.currentVideo)) this.clearState();
        });
        this.releaseUser = JE.session?.onUserChange("pause-screen", () => {
          if (this.destroyed) return;
          this.clearState();
          for (const url of this.imgBlobCache.values()) URL.revokeObjectURL(url);
          this.imgBlobCache.clear();
          this.imgProbeCache.clear();
          this.itemCache.clear();
          this.userId = null;
          this.token = null;
          this.credentialTimer = window.setTimeout(() => {
            if (this.destroyed) return;
            const fresh = this.getCredentials();
            this.userId = fresh?.userId || null;
            this.token = fresh?.token || null;
          }, 0);
        });
        this.injectStyles();
        this.createOverlay();
        this.setupKeyboardAccessibility();
        this.setupVideoObserver();
        this.setupInteractionListeners();
      }
      getCredentials() {
        const creds = localStorage.getItem("jellyfin_credentials");
        if (!creds) return null;
        try {
          const parsed = export4(JSON.parse(creds));
          const servers = Array.isArray(parsed.Servers) ? parsed.Servers.map(export4) : [];
          let activeServerId = null;
          try {
            activeServerId = (typeof ApiClient.serverId === "function" ? ApiClient.serverId() : ApiClient.serverId) || null;
          } catch {
            activeServerId = null;
          }
          const server = activeServerId ? servers.find((s) => s.Id === activeServerId) : servers[0];
          return server && typeof server.AccessToken === "string" && typeof server.UserId === "string" ? { token: server.AccessToken, userId: server.UserId } : null;
        } catch {
          return null;
        }
      }
      injectStyles() {
        const style = document.createElement("style");
        style.id = "pause-screen-style";
        style.textContent = pauseStyles;
        document.head.appendChild(style);
      }
      createOverlay() {
        this.overlay = document.createElement("div");
        this.overlay.id = "pause-screen-overlay";
        this.overlay.setAttribute("role", "dialog");
        this.overlay.setAttribute("aria-hidden", "true");
        this.overlay.setAttribute("aria-modal", "true");
        this.focusStart = document.createElement("div");
        this.focusStart.id = "pause-screen-focus-start";
        this.focusStart.tabIndex = 0;
        this.focusEnd = document.createElement("div");
        this.focusEnd.id = "pause-screen-focus-end";
        this.focusEnd.tabIndex = 0;
        this.overlayContent = document.createElement("div");
        this.overlayContent.id = "pause-screen-content";
        this.overlayContent.tabIndex = -1;
        this.overlayBackdrop = document.createElement("div");
        this.overlayBackdrop.id = "pause-screen-backdrop";
        this.overlayLogo = document.createElement("img");
        this.overlayLogo.id = "pause-screen-logo";
        this.overlayDetails = document.createElement("div");
        this.overlayDetails.id = "pause-screen-details";
        this.overlayPlot = document.createElement("div");
        this.overlayPlot.id = "pause-screen-plot";
        this.progressWrap = document.createElement("div");
        this.progressWrap.id = "pause-screen-progress-wrap";
        this.progressBar = document.createElement("div");
        this.progressBar.id = "pause-screen-progress-bar";
        const fill = document.createElement("span");
        this.progressBar.appendChild(fill);
        this.progressMeta = document.createElement("div");
        this.progressMeta.id = "pause-screen-progress-meta";
        this.progressMeta.innerHTML = `
              <span class="progress-time"></span>
              <span class="progress-percentage"></span>
              <span class="progress-ends-at"></span>
          `;
        this.progressWrap.appendChild(this.progressBar);
        this.progressWrap.appendChild(this.progressMeta);
        this.overlayDisc = document.createElement("img");
        this.overlayDisc.id = "pause-screen-disc";
        const closeButton = document.createElement("button");
        closeButton.id = "pause-screen-close-btn";
        closeButton.innerHTML = "&times;";
        closeButton.onclick = () => {
          this.hideOverlay(true);
        };
        this.closeButton = closeButton;
        this.overlayContent.appendChild(this.overlayBackdrop);
        this.overlayContent.appendChild(this.overlayLogo);
        this.overlayContent.appendChild(this.overlayDetails);
        this.overlayContent.appendChild(this.overlayPlot);
        this.overlayContent.appendChild(this.progressWrap);
        this.overlayContent.appendChild(closeButton);
        this.overlay.appendChild(this.focusStart);
        this.overlay.appendChild(this.overlayContent);
        this.overlay.appendChild(this.overlayDisc);
        this.overlay.appendChild(this.focusEnd);
        document.body.appendChild(this.overlay);
        const tryResume = (event) => {
          if (event.target === this.overlay || event.target === this.overlayContent) {
            if (JE.state?.pauseScreenClickTimer) clearTimeout(JE.state.pauseScreenClickTimer);
            JE.state.pauseScreenClickTimer = window.setTimeout(() => {
              JE.state.pauseScreenClickTimer = null;
              this.hideOverlay();
              if (this.currentVideo?.paused) this.currentVideo.play().catch((error) => console.warn("Play blocked", error));
            }, 500);
          }
        };
        this.overlay.addEventListener("click", tryResume);
        this.overlay.addEventListener("touchstart", tryResume, { passive: true });
        const trap = (e) => {
          if (this.overlay.getAttribute("aria-hidden") === "false") {
            if (e.target === this.focusStart) this.overlayContent.focus();
            if (e.target === this.focusEnd) this.overlayContent.focus();
          }
        };
        this.focusStart.addEventListener("focus", trap);
        this.focusEnd.addEventListener("focus", trap);
      }
      /**
       * D-pad handling for TV layouts: the arrows stay on the overlay instead of
       * reaching the player behind it, and Back closes only the overlay.
       * @param {KeyboardEvent} e
       * @returns {boolean} True when the event was consumed.
       */
      handleRemoteKey(e) {
        const swallow = () => {
          e.preventDefault();
          e.stopImmediatePropagation();
        };
        if (e.key === "ArrowUp" || e.key === "ArrowRight") {
          swallow();
          this.closeButton.focus();
          return true;
        }
        if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
          swallow();
          this.overlayContent.focus();
          return true;
        }
        if (e.key === "Escape" || e.key === "BrowserBack" || e.keyCode === 10009 || e.keyCode === 461) {
          swallow();
          this.hideOverlay(true);
          return true;
        }
        if (e.key === "Enter" && document.activeElement === this.closeButton) {
          swallow();
          this.hideOverlay(true);
          return true;
        }
        return false;
      }
      setupKeyboardAccessibility() {
        this.keyboardListener = (e) => {
          if (this.overlay.getAttribute("aria-hidden") === "false") {
            if (JE.core.ui.isTvLayout() && this.handleRemoteKey(e)) return;
            if (e.code === "Space" || e.code === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              this.hideOverlay();
              if (this.currentVideo && this.currentVideo.paused) {
                this.currentVideo.play().catch((err) => console.warn("🪼 Jellyfin Enhanced: Play() blocked:", err));
              }
            }
            if (e.code === "Tab") {
              if (!this.overlay.contains(document.activeElement)) {
                this.overlayContent.focus();
                e.preventDefault();
              }
            }
          }
        };
        document.addEventListener("keydown", this.keyboardListener, { capture: true });
      }
      setupVideoObserver() {
        this.observer = JE.helpers.onBodyMutation("pausescreen", () => this.checkForVideoChanges());
        this.checkForVideoChanges();
      }
      resetPauseScreenTimer() {
        this.lastUserInteractionAt = Date.now();
        this.schedulePauseOverlayDelay();
      }
      schedulePauseOverlayDelay() {
        if (this.pauseScreenTimer) {
          clearTimeout(this.pauseScreenTimer);
          this.pauseScreenTimer = null;
        }
        if (!this.currentVideo || !this.currentVideo.paused || this.currentVideo.ended) {
          return;
        }
        if (this._dismissedThisPause) {
          return;
        }
        const tryShowWhenIdle = () => {
          const video = this.currentVideo;
          if (!video || !video.paused || video.ended) {
            this.pauseScreenTimer = null;
            return;
          }
          const idleFor = Date.now() - this.lastUserInteractionAt;
          if (idleFor >= this.pauseScreenDelayMs) {
            if (this.syncing) {
              this.pauseScreenTimer = setTimeout(tryShowWhenIdle, 250);
              return;
            }
            this.pauseScreenTimer = null;
            const sourceId = nowPlaying().itemIdFromSource(video);
            if (sourceId && sourceId !== this.readyItemId) {
              this.syncItem(video).then(() => this.schedulePauseOverlayDelay());
              return;
            }
            if (this.readyItemId && this.readyItemId === this.currentItemId) this.showOverlay();
            return;
          }
          const remainingDelay = Math.max(100, this.pauseScreenDelayMs - idleFor);
          this.pauseScreenTimer = setTimeout(tryShowWhenIdle, remainingDelay);
        };
        this.pauseScreenTimer = setTimeout(tryShowWhenIdle, this.pauseScreenDelayMs);
      }
      setupInteractionListeners() {
        let lastMouseX = null;
        let lastMouseY = null;
        const MOUSE_MOVE_THRESHOLD = 15;
        const resetTimer = () => this.resetPauseScreenTimer();
        const resetEvents = ["mousedown", "click", "touchstart", "touchmove", "keydown", "wheel"];
        this.interactionListeners = resetEvents.map((event) => {
          const listener = resetTimer;
          document.addEventListener(event, listener, { passive: true });
          return { event, listener };
        });
        const handleMouseMove = (e) => {
          if (!(e instanceof MouseEvent)) return;
          const currentX = e.clientX;
          const currentY = e.clientY;
          if (lastMouseX !== null && lastMouseY !== null) {
            const distanceMoved = Math.sqrt(
              Math.pow(currentX - lastMouseX, 2) + Math.pow(currentY - lastMouseY, 2)
            );
            if (distanceMoved > MOUSE_MOVE_THRESHOLD) {
              resetTimer();
            }
          } else {
            lastMouseX = currentX;
            lastMouseY = currentY;
          }
          lastMouseX = currentX;
          lastMouseY = currentY;
        };
        document.addEventListener("mousemove", handleMouseMove, { passive: true });
        this.interactionListeners.push({ event: "mousemove", listener: handleMouseMove });
      }
      checkForVideoChanges() {
        const video = document.querySelector(".videoPlayerContainer video");
        if (video && video !== this.currentVideo) {
          this.handleVideoChange(video);
        } else if (!video && this.currentVideo) {
          this.clearState();
        }
      }
      async handleVideoChange(video) {
        this.clearState();
        this.currentVideo = video;
        this.cleanupListeners = this.attachVideoListeners(video);
        this.itemCache.clear();
        this.imgProbeCache.clear();
        const np = nowPlaying();
        const itemId = np.itemIdFromSource(video) || np.itemIdFromRoute();
        if (itemId) {
          this.currentItemId = itemId;
          await this.fetchItemInfo(itemId);
        }
      }
      /** Clears the current item and its details after a source change. */
      invalidateIdentity() {
        this.generation++;
        for (const request of this.imageRequests) request.abort();
        this.imageRequests.clear();
        if (this.overlay.getAttribute("aria-hidden") === "false") this.hideOverlay();
        this.clearDisplayData();
        if (this.pauseScreenTimer) {
          clearTimeout(this.pauseScreenTimer);
          this.pauseScreenTimer = null;
        }
        if (this.fetchAbort) {
          this.fetchAbort.abort();
          this.fetchAbort = null;
        }
        this.currentItemId = null;
        this.readyItemId = null;
      }
      /** Identifies the playing item and loads its details; null when it can't be identified. */
      async syncItem(video) {
        const source = video.currentSrc;
        const generation = this.generation;
        this.syncing++;
        try {
          const itemId = await nowPlaying().resolveItemId(video);
          if (this.destroyed || generation !== this.generation || video !== this.currentVideo || video.currentSrc !== source) return null;
          if (!itemId) {
            this.invalidateIdentity();
            return null;
          }
          if (itemId !== this.currentItemId || itemId !== this.readyItemId) {
            this.currentItemId = itemId;
            this.readyItemId = null;
            await this.fetchItemInfo(itemId);
          }
          return this.readyItemId === itemId ? itemId : null;
        } finally {
          this.syncing--;
        }
      }
      attachVideoListeners(video) {
        const handlePause = () => {
          if (video === this.currentVideo && !video.ended) {
            this.syncItem(video).then((itemId) => {
              if (itemId && video === this.currentVideo && video.paused) this.schedulePauseOverlayDelay();
            });
            this.updateProgressStatic();
            if (this.pauseScreenTimer) {
              clearTimeout(this.pauseScreenTimer);
              this.pauseScreenTimer = null;
            }
            const resumeRatingsPolling = ctx.peer("resumeRatingsPolling");
            if (typeof resumeRatingsPolling === "function") {
              resumeRatingsPolling();
            }
            this._dismissedThisPause = false;
            this.lastUserInteractionAt = Date.now();
            this.resetPauseScreenTimer();
          }
        };
        const handlePlay = () => {
          if (video === this.currentVideo) {
            if (this.pauseScreenTimer) {
              clearTimeout(this.pauseScreenTimer);
              this.pauseScreenTimer = null;
            }
            const pauseRatingsPolling = ctx.peer("pauseRatingsPolling");
            if (typeof pauseRatingsPolling === "function") {
              pauseRatingsPolling();
            }
            this.hideOverlay();
          }
        };
        const handleSourceChange = () => {
          if (video === this.currentVideo) this.invalidateIdentity();
        };
        video.addEventListener("pause", handlePause);
        video.addEventListener("play", handlePlay);
        video.addEventListener("loadstart", handleSourceChange);
        video.addEventListener("emptied", handleSourceChange);
        return () => {
          video.removeEventListener("pause", handlePause);
          video.removeEventListener("play", handlePlay);
          video.removeEventListener("loadstart", handleSourceChange);
          video.removeEventListener("emptied", handleSourceChange);
        };
      }
      showOverlay() {
        if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          this.overlayDisc.style.animation = "none";
        } else {
          this.overlayDisc.style.animation = "";
        }
        this.prevFocused = document.activeElement;
        document.documentElement.classList.add("pause-screen-active");
        this.overlay.setAttribute("aria-hidden", "false");
        this.overlayContent.focus();
      }
      hideOverlay(dismissed = false) {
        document.documentElement.classList.remove("pause-screen-active");
        this.overlay.setAttribute("aria-hidden", "true");
        if (dismissed) {
          this._dismissedThisPause = true;
        }
        if (this.prevFocused && document.contains(this.prevFocused)) {
          if (this.prevFocused instanceof HTMLElement) this.prevFocused.focus();
        }
      }
      clearDisplayData() {
        this.overlayPlot.textContent = "";
        this.overlayDetails.innerHTML = "";
        this.overlayLogo.removeAttribute("src");
        this.overlayDisc.removeAttribute("src");
        this.overlayBackdrop.style.backgroundImage = "";
        this.setProgress(0, 0);
      }
      async fetchItemInfo(itemId) {
        const generation = ++this.generation;
        this.clearDisplayData();
        this.fetchAbort?.abort();
        this.fetchAbort = new AbortController();
        try {
          let record = this.itemCache.get(itemId);
          if (!record) {
            const itemResp = await this.fetchWithRetry(ApiClient.getUrl(`/Items/${itemId}`), {
              headers: { "Authorization": 'MediaBrowser Token="' + this.token + '"', "X-Emby-Token": this.token ?? "", "Accept": "application/json" },
              signal: this.fetchAbort.signal
            });
            if (this.destroyed || generation !== this.generation) return;
            if (!itemResp) return;
            record = { item: itemResp, domain: ApiClient.serverAddress() };
            this.itemCache.set(itemId, record);
          }
          await this.displayItemInfo(record.item, record.domain, itemId);
          if (!this.destroyed && generation === this.generation) this.readyItemId = itemId;
        } catch (err) {
          if (this.destroyed || generation !== this.generation) return;
          if (!(err instanceof Error && err.name === "AbortError")) {
            console.error("🪼 Jellyfin Enhanced: Error fetching item info:", err);
            this.overlayPlot.textContent = JE.t("pausescreen_fetch_error");
          }
        }
      }
      async fetchWithRetry(url, options, maxRetries = 2) {
        for (let i = 0; i <= maxRetries; i++) {
          try {
            const response = await fetch(url, options);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return export03(await response.json());
          } catch (error) {
            if (i === maxRetries || options.signal?.aborted) throw error;
            const signal = options.signal ?? lifetime.lease().signal;
            await lifetime.sleep(1e3 * (i + 1), signal);
            if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
          }
        }
      }
      async displayItemInfo(item, domain, itemId) {
        const generation = this.generation;
        const year = item.ProductionYear || "";
        const rating = item.OfficialRating || "";
        const runtime = this.formatRuntime(item.RunTimeTicks);
        this.overlayDetails.replaceChildren();
        for (const [value, isRating] of [[year, false], [rating, true], [runtime, false]]) {
          if (!value) continue;
          const span = document.createElement("span");
          span.textContent = String(value);
          if (isRating) {
            span.className = "mediaInfoOfficialRating";
            span.setAttribute("rating", String(value));
          }
          this.overlayDetails.appendChild(span);
        }
        this.overlayPlot.textContent = item.Overview || JE.t("pausescreen_no_description");
        const fit = (urls) => urls.map((url) => `${url}${url.includes("?") ? "&" : "?"}maxWidth=${Math.round((window.screen.width || 1920) * (window.devicePixelRatio || 1))}`);
        const logoUrls = fit(this.getLogoUrls(item, domain, itemId));
        const discUrls = fit(this.getDiscUrls(item, domain, itemId));
        const backdropUrls = fit(this.getBackdropUrls(item, domain, itemId));
        const [logoURL, discURL, backdropURL] = await Promise.all([
          this.firstAvailableBlobURL(logoUrls),
          this.firstAvailableBlobURL(discUrls),
          this.firstAvailableBlobURL(backdropUrls)
        ]);
        if (this.destroyed || generation !== this.generation) return;
        if (logoURL) this.overlayLogo.src = logoURL;
        if (discURL) this.overlayDisc.src = discURL;
        if (backdropURL) this.overlayBackdrop.style.backgroundImage = `url("${backdropURL}")`;
        this.updateProgressStatic();
      }
      formatRuntime(runTimeTicks) {
        if (!runTimeTicks) return "";
        const totalMinutes = Math.floor(runTimeTicks / 6e8);
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
      }
      // ------- Progress UI -------
      updateProgressStatic() {
        if (!this.currentVideo) return this.setProgress(0, 0);
        const cur = Number.isFinite(this.currentVideo.currentTime) ? this.currentVideo.currentTime : 0;
        const dur = Number.isFinite(this.currentVideo.duration) ? this.currentVideo.duration : 0;
        this.setProgress(cur, dur);
      }
      setProgress(current, duration) {
        renderPauseProgress(this.progressBar, this.progressMeta, current, duration, (key, params) => JE.t(key, params));
      }
      // ------- Image helpers (blob cache, the most recently used kept) -------
      async firstAvailableBlobURL(urls) {
        const generation = this.generation;
        for (const url of urls) {
          if (this.destroyed || generation !== this.generation) return null;
          if (!url) continue;
          const ok = await this.probeImage(url);
          if (this.destroyed || generation !== this.generation) return null;
          if (!ok) continue;
          const blobURL = await this.toBlobURL(url);
          if (this.destroyed || generation !== this.generation) return null;
          if (blobURL) return blobURL;
        }
        return null;
      }
      async probeImage(url, timeoutMs = 2500) {
        const generation = this.generation;
        if (this.destroyed) return false;
        if (this.imgProbeCache.has(url)) return this.imgProbeCache.get(url);
        const ctl = new AbortController();
        this.imageRequests.add(ctl);
        const t = window.setTimeout(() => ctl.abort(), timeoutMs);
        try {
          const res = await fetch(url, {
            method: "HEAD",
            headers: { "Authorization": 'MediaBrowser Token="' + this.token + '"', "X-Emby-Token": this.token ?? "" },
            signal: ctl.signal
          });
          clearTimeout(t);
          if (this.destroyed || generation !== this.generation) return false;
          const ok = res.ok;
          this.imgProbeCache.set(url, ok);
          return ok;
        } catch {
          if (this.destroyed || generation !== this.generation) return false;
          this.imgProbeCache.set(url, false);
          return false;
        } finally {
          clearTimeout(t);
          this.imageRequests.delete(ctl);
        }
      }
      async toBlobURL(url, timeoutMs = 5e3) {
        const generation = this.generation;
        if (this.destroyed) return null;
        const kept = this.imgBlobCache.get(url);
        if (kept) {
          this.imgBlobCache.delete(url);
          this.imgBlobCache.set(url, kept);
          return kept;
        }
        const ctl = new AbortController();
        this.imageRequests.add(ctl);
        const t = window.setTimeout(() => ctl.abort(), timeoutMs);
        try {
          const res = await fetch(url, {
            headers: { "Authorization": 'MediaBrowser Token="' + this.token + '"', "X-Emby-Token": this.token ?? "" },
            signal: ctl.signal
          });
          clearTimeout(t);
          if (this.destroyed || generation !== this.generation || !res.ok) return null;
          const blob = await res.blob();
          if (this.destroyed || generation !== this.generation) return null;
          const obj = URL.createObjectURL(blob);
          this.imgBlobCache.set(url, obj);
          for (const [key, old] of this.imgBlobCache) if (this.imgBlobCache.size > MAX_KEPT_IMAGES) {
            URL.revokeObjectURL(old);
            this.imgBlobCache.delete(key);
          }
          return obj;
        } catch {
          return null;
        } finally {
          clearTimeout(t);
          this.imageRequests.delete(ctl);
        }
      }
      getLogoUrls(item, domain, itemId) {
        const urls = [];
        if (item.ImageTags?.Logo) {
          urls.push(`${domain}/Items/${encodeURIComponent(itemId)}/Images/Logo?tag=${encodeURIComponent(item.ImageTags.Logo)}`);
        }
        if (item.ParentId) urls.push(`${domain}/Items/${encodeURIComponent(item.ParentId)}/Images/Logo`);
        if (item.SeriesId) urls.push(`${domain}/Items/${encodeURIComponent(item.SeriesId)}/Images/Logo`);
        return urls;
      }
      getDiscUrls(item, domain, itemId) {
        const urls = [`${domain}/Items/${encodeURIComponent(itemId)}/Images/Disc`];
        if (item.ParentId) urls.push(`${domain}/Items/${encodeURIComponent(item.ParentId)}/Images/Disc`);
        if (item.SeriesId) urls.push(`${domain}/Items/${encodeURIComponent(item.SeriesId)}/Images/Disc`);
        return urls;
      }
      getBackdropUrls(item, domain, itemId) {
        const urls = [
          `${domain}/Items/${encodeURIComponent(itemId)}/Images/Backdrop`
        ];
        if (item.ParentId) urls.push(`${domain}/Items/${encodeURIComponent(item.ParentId)}/Images/Backdrop`);
        if (item.SeriesId) urls.push(`${domain}/Items/${encodeURIComponent(item.SeriesId)}/Images/Backdrop`);
        return urls;
      }
      clearState() {
        this.generation++;
        if (JE.state?.pauseScreenClickTimer) {
          clearTimeout(JE.state.pauseScreenClickTimer);
          JE.state.pauseScreenClickTimer = null;
        }
        for (const request of this.imageRequests) request.abort();
        this.imageRequests.clear();
        this.hideOverlay();
        this.clearDisplayData();
        if (this.pauseScreenTimer) {
          clearTimeout(this.pauseScreenTimer);
          this.pauseScreenTimer = null;
        }
        if (this.cleanupListeners) {
          this.cleanupListeners();
          this.cleanupListeners = null;
        }
        if (this.fetchAbort) {
          this.fetchAbort.abort();
          this.fetchAbort = null;
        }
        this.currentItemId = null;
        this.readyItemId = null;
        this.currentVideo = null;
      }
      destroy() {
        this.destroyed = true;
        if (typeof this.releaseReset === "function") this.releaseReset();
        if (typeof this.releaseUser === "function") this.releaseUser();
        clearTimeout(this.credentialTimer);
        if (this.keyboardListener) {
          document.removeEventListener("keydown", this.keyboardListener, { capture: true });
          this.keyboardListener = null;
        }
        if (this.overlay) this.clearState();
        if (this.observer) {
          this.observer.unsubscribe();
          this.observer = null;
        }
        if (this.interactionListeners) {
          this.interactionListeners.forEach(({ event, listener }) => {
            document.removeEventListener(event, listener);
          });
          this.interactionListeners = null;
        }
        for (const url of this.imgBlobCache.values()) URL.revokeObjectURL(url);
        this.imgBlobCache.clear();
        this.imgProbeCache.clear();
        this.itemCache.clear();
        if (this.overlay?.parentNode) this.overlay.parentNode.removeChild(this.overlay);
        const css = document.getElementById("pause-screen-style");
        if (css) css.remove();
      }
    }
    JE.pauseScreenInstance = new JellyfinPauseScreen();
    console.log("🪼 Jellyfin Enhanced: Custom Pause Screen initialized.");
  };
})();
})();
//# sourceMappingURL=pausescreen.js.map
