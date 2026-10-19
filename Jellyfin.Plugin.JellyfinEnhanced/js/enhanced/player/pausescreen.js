// /js/enhanced/player/pausescreen.js
// Jellyfin Pause Screen (enhanced)
// This script is a modified version of the original Jellyfin Pause Screen script by BobHasNoSoul.
// Original source: https://github.com/BobHasNoSoul/Jellyfin-PauseScreen

(function (JE) {
  'use strict';

  JE.initializePauseScreen = function() {
    // Only run if the feature is enabled in the user's settings
    if (!JE.currentSettings.pauseScreenEnabled) {
        JE.pauseScreenInstance?.destroy();
        console.log('🪼 Jellyfin Enhanced: Custom Pause Screen is disabled.');
        return;
    }
      if (JE.pauseScreenInstance?.overlay?.isConnected) return;
      JE.pauseScreenInstance?.destroy();
      const nowPlaying = () => JE.internals.nowPlaying;

      class JellyfinPauseScreen {
        constructor() {
          // State
          this.generation = 0;
          this.destroyed = false;
          this.currentVideo = null;
          this.currentItemId = null;
          this.readyItemId = null;
          this.syncing = 0;
          this.userId = null;
          this.token = null;
          this.cleanupListeners = null;
          this.imgBlobCache = new Map();
          this.imgProbeCache = new Map();
          this.itemCache = new Map();
          this.fetchAbort = null;
          this.observer = null;
          this.prevFocused = null;

          // Pause screen delay state
          this.pauseScreenDelayMs = (JE.currentSettings.pauseScreenDelaySeconds ?? 5) * 1000;
          this.pauseScreenTimer = null;
          this.lastUserInteractionAt = Date.now();
          this.interactionListeners = null;
          this._dismissedThisPause = false;

          // DOM refs
          this.overlay = null;
          this.overlayContent = null;
          this.overlayLogo = null;
          this.overlayPlot = null;
          this.overlayDetails = null;
          this.overlayDisc = null;
          this.overlayBackdrop = null;
          this.progressWrap = null;
          this.progressBar = null;
          this.progressMeta = null;
          this.focusStart = null;
          this.focusEnd = null;
          this.closeButton = null;

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

          // Credentials are captured once above; without this they would keep
          // serving the PREVIOUS user's token after an SPA user switch. The
          // re-read is deferred a tick because the reset fires before the host
          // finishes writing the new credentials to localStorage.
          JE.session?.onUserChange('pause-screen', () => {
            if (this.destroyed) return;
            this.clearState();
            for (const url of this.imgBlobCache.values()) URL.revokeObjectURL(url);
            this.imgBlobCache.clear();
            this.imgProbeCache.clear();
            this.itemCache.clear();
            this.userId = null;
            this.token = null;
            setTimeout(() => {
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
            const parsed = JSON.parse(creds);
            const servers = Array.isArray(parsed.Servers) ? parsed.Servers : [];
            // Prefer the ACTIVE server's entry — with multiple stored servers
            // Servers[0] may hold another server's user id/token.
            let activeServerId = null;
            try {
              activeServerId = (typeof ApiClient.serverId === 'function' ? ApiClient.serverId() : ApiClient.serverId) || null;
            } catch { activeServerId = null; }
            // Fail closed: when the active server is known but has no stored
            // entry, do NOT fall back to another server's token/user id.
            const server = activeServerId
              ? servers.find(s => s.Id === activeServerId)
              : servers[0];
            return server ? { token: server.AccessToken, userId: server.UserId } : null;
          } catch {
            return null;
          }
        }

        injectStyles() {
          const style = document.createElement("style");
          style.id = "pause-screen-style";
          style.textContent = `
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
          document.head.appendChild(style);
        }

        createOverlay() {
          // Root overlay
          this.overlay = document.createElement("div");
          this.overlay.id = "pause-screen-overlay";
          this.overlay.setAttribute("role", "dialog");
          this.overlay.setAttribute("aria-hidden", "true");
          this.overlay.setAttribute("aria-modal", "true");

          this.focusStart = document.createElement('div');
          this.focusStart.id = 'pause-screen-focus-start';
          this.focusStart.tabIndex = 0;

          this.focusEnd = document.createElement('div');
          this.focusEnd.id = 'pause-screen-focus-end';
          this.focusEnd.tabIndex = 0;

          // Content wrapper
          this.overlayContent = document.createElement("div");
          this.overlayContent.id = "pause-screen-content";
          this.overlayContent.tabIndex = -1;

          // Backdrop layer
          this.overlayBackdrop = document.createElement("div");
          this.overlayBackdrop.id = "pause-screen-backdrop";

          // UI nodes
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

          // Assemble
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

          // Pointer/touch to resume
          const tryResume = (event) => {
            if (event.target === this.overlay || event.target === this.overlayContent) {
                // Introduce a delay to allow for long-press detection
                JE.state.pauseScreenClickTimer = setTimeout(() => {
                    this.hideOverlay();
                    if (this.currentVideo?.paused) this.currentVideo.play();
                }, 500);
            }
          };
          this.overlay.addEventListener('click', tryResume);
          this.overlay.addEventListener('touchstart', tryResume, { passive: true });

          // Focus trap behavior
          const trap = (e) => {
            if (this.overlay.getAttribute('aria-hidden') === 'false') {
              if (e.target === this.focusStart) this.overlayContent.focus();
              if (e.target === this.focusEnd) this.overlayContent.focus();
            }
          };
          this.focusStart.addEventListener('focus', trap);
          this.focusEnd.addEventListener('focus', trap);
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

          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
            swallow();
            this.closeButton.focus();
            return true;
          }
          if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
            swallow();
            this.overlayContent.focus();
            return true;
          }
          if (e.key === 'Escape' || e.key === 'BrowserBack' || e.keyCode === 10009 || e.keyCode === 461) {
            swallow();
            this.hideOverlay(true);
            return true;
          }
          if (e.key === 'Enter' && document.activeElement === this.closeButton) {
            swallow();
            this.hideOverlay(true);
            return true;
          }
          return false;
        }

        setupKeyboardAccessibility() {
          // Space/Enter resumes when overlay visible
          this.keyboardListener = (e) => {
            if (this.overlay.getAttribute('aria-hidden') === 'false') {
              if (JE.core.ui.isTvLayout() && this.handleRemoteKey(e)) return;
              if (e.code === 'Space' || e.code === 'Enter') {
                e.preventDefault();
                e.stopPropagation(); // stop Jellyfin binding
                this.hideOverlay();
                if (this.currentVideo && this.currentVideo.paused) {
                    this.currentVideo.play().catch(err => console.warn("🪼 Jellyfin Enhanced: Play() blocked:", err));
                }
              }
              // Keep Tab inside
              if (e.code === 'Tab') {
                // force focus to content if outside
                if (!this.overlay.contains(document.activeElement)) {
                  this.overlayContent.focus();
                  e.preventDefault();
                }
              }
            }
          };
          document.addEventListener('keydown', this.keyboardListener, { capture: true });
        }

        setupVideoObserver() {
          this.observer = JE.helpers.onBodyMutation('pausescreen', () => this.checkForVideoChanges());
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

          // User already dismissed the pause screen for this pause — don't show again
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
          // Track last mouse position for movement threshold
          let lastMouseX = null;
          let lastMouseY = null;
          const MOUSE_MOVE_THRESHOLD = 15; // pixels - only reset if moved more than this

          const resetTimer = () => this.resetPauseScreenTimer();

          // Events that always reset the timer
          const resetEvents = ['mousedown', 'click', 'touchstart', 'touchmove', 'keydown', 'wheel'];

          this.interactionListeners = resetEvents.map(event => {
            const listener = resetTimer;
            document.addEventListener(event, listener, { passive: true });
            return { event, listener };
          });

          // Handle mousemove based on threshold
          const handleMouseMove = (e) => {
            const currentX = e.clientX;
            const currentY = e.clientY;

            if (lastMouseX !== null && lastMouseY !== null) {
              const distanceMoved = Math.sqrt(
                Math.pow(currentX - lastMouseX, 2) + Math.pow(currentY - lastMouseY, 2)
              );
              // Only reset if movement exceeds threshold
              if (distanceMoved > MOUSE_MOVE_THRESHOLD) {
                resetTimer();
              }
            } else {
              // First movement, record position
              lastMouseX = currentX;
              lastMouseY = currentY;
            }

            // Update last position
            lastMouseX = currentX;
            lastMouseY = currentY;
          };

          document.addEventListener('mousemove', handleMouseMove, { passive: true });
          this.interactionListeners.push({ event: 'mousemove', listener: handleMouseMove });
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

          // Clear item cache on video change so a new item always fetches fresh data
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
          if (this.overlay.getAttribute('aria-hidden') === 'false') this.hideOverlay();
          this.clearDisplayData();
          if (this.pauseScreenTimer) {
            clearTimeout(this.pauseScreenTimer);
            this.pauseScreenTimer = null;
          }
          if (this.fetchAbort) { this.fetchAbort.abort(); this.fetchAbort = null; }
          this.currentItemId = null;
          this.readyItemId = null;
        }

        /** Identifies the playing item and loads its details; null when it can't be identified. */
        async syncItem(video) {
          const source = video.currentSrc;
          this.syncing++;
          try {
            const itemId = await nowPlaying().resolveItemId(video);
            if (this.destroyed || video !== this.currentVideo || video.currentSrc !== source) return null;
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
              this.syncItem(video).then(itemId => {
                if (itemId && video === this.currentVideo && video.paused) this.schedulePauseOverlayDelay();
              });
              this.updateProgressStatic();

              // Clear any existing timer
              if (this.pauseScreenTimer) {
                clearTimeout(this.pauseScreenTimer);
                this.pauseScreenTimer = null;
              }

              // Resume colored ratings polling when paused
              if (typeof JE?.resumeRatingsPolling === 'function') {
                JE.resumeRatingsPolling();
              }

              // New pause event — allow the pause screen to show again
              this._dismissedThisPause = false;
              this.lastUserInteractionAt = Date.now();
              this.resetPauseScreenTimer();
            }
          };

          const handlePlay = () => {
            if (video === this.currentVideo) {
              // Clear the timer if video starts playing
              if (this.pauseScreenTimer) {
                clearTimeout(this.pauseScreenTimer);
                this.pauseScreenTimer = null;
              }
              // Pause colored ratings polling when playing
              if (typeof JE?.pauseRatingsPolling === 'function') {
                JE.pauseRatingsPolling();
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
            if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                this.overlayDisc.style.animation = 'none';
            } else {
                this.overlayDisc.style.animation = '';
            }
            this.prevFocused = document.activeElement;
            document.documentElement.classList.add('pause-screen-active');
            this.overlay.setAttribute('aria-hidden', 'false');
            this.overlayContent.focus();
            }

        hideOverlay(dismissed = false) {
            document.documentElement.classList.remove('pause-screen-active');
            this.overlay.setAttribute('aria-hidden', 'true');
            if (dismissed) {
                this._dismissedThisPause = true;
            }
            if (this.prevFocused && document.contains(this.prevFocused)) {
                this.prevFocused.focus();
            }
        }
        clearDisplayData() {
          this.overlayPlot.textContent = "";
          this.overlayDetails.innerHTML = "";
          this.overlayLogo.removeAttribute('src');
          this.overlayDisc.removeAttribute('src');
          this.overlayBackdrop.style.backgroundImage = '';
          // reset progress
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
                    headers: { "Authorization": 'MediaBrowser Token="' + this.token + '"', "X-Emby-Token": this.token, "Accept": "application/json" },
                    signal: this.fetchAbort.signal
                });
                if (this.destroyed || generation !== this.generation) return;
                record = { item: itemResp, domain: ApiClient.serverAddress() };
                this.itemCache.set(itemId, record);
                }
                await this.displayItemInfo(record.item, record.domain, itemId);
                if (!this.destroyed && generation === this.generation) this.readyItemId = itemId;
            } catch (err) {
                if (this.destroyed || generation !== this.generation) return;
                if (err.name !== 'AbortError') {
                console.error("🪼 Jellyfin Enhanced: Error fetching item info:", err);
                this.overlayPlot.textContent = JE.t('pausescreen_fetch_error');
                }
            }
            }

        async fetchWithRetry(url, options, maxRetries = 2) {
          for (let i = 0; i <= maxRetries; i++) {
            try {
              const response = await fetch(url, options);
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              return await response.json();
            } catch (error) {
              if (i === maxRetries) throw error;
              await new Promise(r => setTimeout(r, 1000 * (i + 1)));
            }
          }
        }

        async displayItemInfo(item, domain, itemId) {
          const generation = this.generation;
          // Details
          const year = item.ProductionYear || "";
          const rating = item.OfficialRating || "";
          const runtime = this.formatRuntime(item.RunTimeTicks);
          this.overlayDetails.replaceChildren();
          for (const [value, isRating] of [[year, false], [rating, true], [runtime, false]]) {
            if (!value) continue;
            const span = document.createElement('span');
            span.textContent = String(value);
            if (isRating) {
              span.className = 'mediaInfoOfficialRating';
              span.setAttribute('rating', String(value));
            }
            this.overlayDetails.appendChild(span);
          }

          this.overlayPlot.textContent = item.Overview || JE.t('pausescreen_no_description');

          // Images: preload to blob URLs (cached)
          const logoUrls = this.getLogoUrls(item, domain, itemId);
          const discUrls = this.getDiscUrls(item, domain, itemId);
          const backdropUrls = this.getBackdropUrls(item, domain, itemId);

          const [logoURL, discURL, backdropURL] = await Promise.all([
            this.firstAvailableBlobURL(logoUrls),
            this.firstAvailableBlobURL(discUrls),
            this.firstAvailableBlobURL(backdropUrls)
          ]);

          if (this.destroyed || generation !== this.generation) return;
          if (logoURL) this.overlayLogo.src = logoURL;
          if (discURL) this.overlayDisc.src = discURL;
          if (backdropURL) this.overlayBackdrop.style.backgroundImage = `url("${backdropURL}")`;

          // Set static progress snapshot if paused
          this.updateProgressStatic();
        }

        formatRuntime(runTimeTicks) {
          if (!runTimeTicks) return "";
          const totalMinutes = Math.floor(runTimeTicks / 600000000);
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
          const fill = this.progressBar.firstElementChild;
          const pct = duration > 0 ? Math.max(0, Math.min(100, (current / duration) * 100)) : 0;
          fill.style.width = `${pct}%`;

          const timeEl = this.progressMeta.querySelector('.progress-time');
          const endsAtEl = this.progressMeta.querySelector('.progress-ends-at');
          const percentageEl = this.progressMeta.querySelector('.progress-percentage');

          if (timeEl) {
            timeEl.textContent = `${this.formatClock(current)} / ${this.formatClock(duration)}`;
          }

          if (percentageEl) {
            percentageEl.textContent = JE.t('pausescreen_watched_percent', { percent: Math.round(pct) });
          }

          if (endsAtEl) {
            if (duration > 0 && current < duration) {
              const remainingSeconds = duration - current;
              const endTime = new Date(Date.now() + remainingSeconds * 1000);
              const formattedEndTime = endTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
              endsAtEl.textContent = JE.t('pausescreen_ends_at', { time: formattedEndTime });
            } else {
              endsAtEl.textContent = ''; // Clear it if video is over
            }
          }
        }
        formatClock(sec) {
          if (!isFinite(sec) || sec <= 0) return "0:00";
          const s = Math.floor(sec % 60).toString().padStart(2, '0');
          const m = Math.floor((sec / 60) % 60).toString().padStart(2, '0');
          const h = Math.floor(sec / 3600);
          return h > 0 ? `${h}:${m}:${s}` : `${Number(m)}:${s}`;
        }

        // ------- Image helpers (blob cache) -------
        async firstAvailableBlobURL(urls) {
          const generation = this.generation;
          for (const url of urls) {
            if (!url) continue;
            const ok = await this.probeImage(url);
            if (this.destroyed || generation !== this.generation) return null;
            if (!ok) continue;
            const blobURL = await this.toBlobURL(url);
            if (blobURL) return blobURL;
          }
          return null;
        }
        async probeImage(url, timeoutMs = 2500) {
          const generation = this.generation;
          if (this.imgProbeCache.has(url)) return this.imgProbeCache.get(url);
          try {
            const ctl = new AbortController();
            const t = setTimeout(() => ctl.abort(), timeoutMs);
            const res = await fetch(url, {
              method: "HEAD",
              headers: { "Authorization": 'MediaBrowser Token="' + this.token + '"', "X-Emby-Token": this.token },
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
          }
        }
        async toBlobURL(url, timeoutMs = 5000) {
          const generation = this.generation;
          if (this.imgBlobCache.has(url)) return this.imgBlobCache.get(url);
          try {
            const ctl = new AbortController();
            const t = setTimeout(() => ctl.abort(), timeoutMs);
            const res = await fetch(url, {
              headers: { "Authorization": 'MediaBrowser Token="' + this.token + '"', "X-Emby-Token": this.token },
              signal: ctl.signal
            });
            clearTimeout(t);
            if (!res.ok) return null;
            const blob = await res.blob();
            if (this.destroyed || generation !== this.generation) return null;
            const obj = URL.createObjectURL(blob);
            this.imgBlobCache.set(url, obj);
            return obj;
          } catch {
            return null;
          }
        }

        getLogoUrls(item, domain, itemId) {
          const urls = [];
          if (item.ImageTags?.Logo) {
            urls.push(`${domain}/Items/${itemId}/Images/Logo?tag=${item.ImageTags.Logo}`);
          }
          if (item.ParentId) urls.push(`${domain}/Items/${item.ParentId}/Images/Logo`);
          if (item.SeriesId) urls.push(`${domain}/Items/${item.SeriesId}/Images/Logo`);
          return urls;
        }

        getDiscUrls(item, domain, itemId) {
          const urls = [`${domain}/Items/${itemId}/Images/Disc`];
          if (item.ParentId) urls.push(`${domain}/Items/${item.ParentId}/Images/Disc`);
          if (item.SeriesId) urls.push(`${domain}/Items/${item.SeriesId}/Images/Disc`);
          return urls;
        }

        getBackdropUrls(item, domain, itemId) {
          const urls = [
            `${domain}/Items/${itemId}/Images/Backdrop`,
          ];
          if (item.ParentId) urls.push(`${domain}/Items/${item.ParentId}/Images/Backdrop`);
          if (item.SeriesId) urls.push(`${domain}/Items/${item.SeriesId}/Images/Backdrop`);
          return urls;
        }

        clearState() {
          this.generation++;
          this.hideOverlay();
          this.clearDisplayData();

          // Clear pause screen timer
          if (this.pauseScreenTimer) {
            clearTimeout(this.pauseScreenTimer);
            this.pauseScreenTimer = null;
          }

          if (this.cleanupListeners) { this.cleanupListeners(); this.cleanupListeners = null; }
          if (this.fetchAbort) { this.fetchAbort.abort(); this.fetchAbort = null; }
          this.currentItemId = null;
          this.readyItemId = null;
          this.currentVideo = null;
        }

        destroy() {
          this.destroyed = true;
          if (this.keyboardListener) {
            document.removeEventListener('keydown', this.keyboardListener, { capture: true });
            this.keyboardListener = null;
          }
          if (this.overlay) this.clearState();
          if (this.observer) { this.observer.unsubscribe(); this.observer = null; }

          // Clean up interaction listeners
          if (this.interactionListeners) {
            this.interactionListeners.forEach(({ event, listener }) => {
              document.removeEventListener(event, listener);
            });
            this.interactionListeners = null;
          }

          // Revoke blob URLs
          for (const url of this.imgBlobCache.values()) URL.revokeObjectURL(url);
          this.imgBlobCache.clear();
          this.imgProbeCache.clear();
          this.itemCache.clear();
          if (this.overlay?.parentNode) this.overlay.parentNode.removeChild(this.overlay);
          const css = document.getElementById("pause-screen-style");
          if (css) css.remove();
        }
      }
      // Boot
      JE.pauseScreenInstance = new JellyfinPauseScreen();
        console.log('🪼 Jellyfin Enhanced: Custom Pause Screen initialized.');
    };

})(window.JellyfinEnhanced);
