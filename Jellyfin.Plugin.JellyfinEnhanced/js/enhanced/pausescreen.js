// /js/enhanced/pausescreen.js
// Jellyfin Pause Screen (enhanced)
// This script is a modified version of the original Jellyfin Pause Screen script by BobHasNoSoul.
// Original source: https://github.com/BobHasNoSoul/Jellyfin-PauseScreen

(function (JE) {
  'use strict';

  JE.initializePauseScreen = function() {
    // Only run if the feature is enabled in the user's settings
    if (!JE.currentSettings.pauseScreenEnabled) {
        console.log('🪼 Jellyfin Enhanced: Custom Pause Screen is disabled.');
        return;
    }
      class JellyfinPauseScreen {
        constructor() {
          // State
          this.currentVideo = null;
          this.currentItemId = null;
          this.userId = null;
          this.token = null;
          this.lastItemIdCheck = 0;
          this.cleanupListeners = null;
          this.imgBlobCache = new Map();
          this.imgProbeCache = new Map();
          this.itemCache = new Map();
          this.fetchAbort = null;
          this.observer = null;
          this.prevFocused = null;

          // Pause screen delay state
          this.pauseScreenTimer = null;
          this.interactionListeners = null;

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
            const server = parsed.Servers?.[0];
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

            .pause-screen-active .headerBackButton {
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
            #pause-screen-close-btn:hover {
              background: rgba(0,0,0,0.8);
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
              this.hideOverlay();
          };

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

        setupKeyboardAccessibility() {
          // Space/Enter resumes when overlay visible
          document.addEventListener('keydown', (e) => {
            if (this.overlay.getAttribute('aria-hidden') === 'false') {
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
          }, { capture: true });
        }

        setupVideoObserver() {
          this.observer = new MutationObserver(() => this.checkForVideoChanges());
          this.observer.observe(document.body, { childList: true, subtree: true });
          this.checkForVideoChanges();
        }

        setupInteractionListeners() {
          // Track last mouse position for movement threshold
          let lastMouseX = null;
          let lastMouseY = null;
          const MOUSE_MOVE_THRESHOLD = 15; // pixels - only reset if moved more than this

          const resetTimer = () => {
            if (this.pauseScreenTimer) {
              clearTimeout(this.pauseScreenTimer);
              this.pauseScreenTimer = null;
            }
            // If video is paused, restart the pause screen timer
            if (this.currentVideo && this.currentVideo.paused && !this.currentVideo.ended) {
              this.pauseScreenTimer = setTimeout(() => {
                if (this.pauseScreenTimer && this.currentVideo === this.currentVideo && this.currentVideo.paused && !this.currentVideo.ended) {
                  this.showOverlay();
                }
                this.pauseScreenTimer = null;
              }, 3000);
            }
          };

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

          const itemId = this.checkForItemId(true);
          if (itemId) {
            this.currentItemId = itemId;
            await this.fetchItemInfo(itemId);
          }
        }

        checkForItemId(force = false) {
          const now = Date.now();
          if (!force && now - this.lastItemIdCheck < 500) return this.currentItemId;
          this.lastItemIdCheck = now;

          const selectors = [
            '.videoOsdBottom-hidden > div:nth-child(1) > div:nth-child(4) > button:nth-child(3)',
            'div.page:nth-child(3) > div:nth-child(3) > div:nth-child(1) > div:nth-child(4) > button:nth-child(3)',
            '.btnUserRating'
          ];
          for (const selector of selectors) {
            const el = document.querySelector(selector);
            const dataId = el?.getAttribute('data-id');
            if (dataId) return dataId;
          }
          return null;
        }

        attachVideoListeners(video) {
          const handlePause = () => {
            if (video === this.currentVideo && !video.ended) {
              const newItemId = this.checkForItemId(true);
              if (newItemId && newItemId !== this.currentItemId) {
                this.currentItemId = newItemId;
                this.fetchItemInfo(newItemId);
              }
              this.updateProgressStatic();

              // Clear any existing timer
              if (this.pauseScreenTimer) {
                clearTimeout(this.pauseScreenTimer);
                this.pauseScreenTimer = null;
              }

              // Set up delayed pause screen with 3-second delay
              this.pauseScreenTimer = setTimeout(() => {
                if (this.pauseScreenTimer && video === this.currentVideo && video.paused && !video.ended) {
                  this.showOverlay();
                }
                this.pauseScreenTimer = null;
              }, 3000);
            }
          };

          const handlePlay = () => {
            if (video === this.currentVideo) {
              // Clear the timer if video starts playing
              if (this.pauseScreenTimer) {
                clearTimeout(this.pauseScreenTimer);
                this.pauseScreenTimer = null;
              }
              this.hideOverlay();
            }
          };

          video.addEventListener("pause", handlePause);
          video.addEventListener("play", handlePlay);
          return () => {
            video.removeEventListener("pause", handlePause);
            video.removeEventListener("play", handlePlay);
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

        hideOverlay() {
            document.documentElement.classList.remove('pause-screen-active');
            this.overlay.setAttribute('aria-hidden', 'true');
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
            this.clearDisplayData();
            this.fetchAbort?.abort();
            this.fetchAbort = new AbortController();

            try {
                const domain = window.location.origin;
                let record = this.itemCache.get(itemId);
                if (!record) {
                const itemResp = await this.fetchWithRetry(ApiClient.getUrl(`/Items/${itemId}`), {
                    headers: { "X-Emby-Token": this.token, "Accept": "application/json" },
                    signal: this.fetchAbort.signal
                });
                record = { item: itemResp, domain: ApiClient.serverAddress() };
                this.itemCache.set(itemId, record);
                }
                await this.displayItemInfo(record.item, record.domain, itemId);
            } catch (err) {
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
          // Details
          const year = item.ProductionYear || "";
          const rating = item.OfficialRating || "";
          const runtime = this.formatRuntime(item.RunTimeTicks);
          this.overlayDetails.innerHTML = [
            year && `<span>${year}</span>`,
            rating && `<span class="mediaInfoOfficialRating" rating="${rating}">${rating}</span>`,
            runtime && `<span>${runtime}</span>`
          ].filter(Boolean).join('');

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
          for (const url of urls) {
            if (!url) continue;
            const ok = await this.probeImage(url);
            if (!ok) continue;
            const blobURL = await this.toBlobURL(url);
            if (blobURL) return blobURL;
          }
          return null;
        }
        async probeImage(url, timeoutMs = 2500) {
          if (this.imgProbeCache.has(url)) return this.imgProbeCache.get(url);
          try {
            const ctl = new AbortController();
            const t = setTimeout(() => ctl.abort(), timeoutMs);
            const res = await fetch(url, {
              method: "HEAD",
              headers: { "X-Emby-Token": this.token },
              signal: ctl.signal
            });
            clearTimeout(t);
            const ok = res.ok;
            this.imgProbeCache.set(url, ok);
            return ok;
          } catch {
            this.imgProbeCache.set(url, false);
            return false;
          }
        }
        async toBlobURL(url, timeoutMs = 5000) {
          if (this.imgBlobCache.has(url)) return this.imgBlobCache.get(url);
          try {
            const ctl = new AbortController();
            const t = setTimeout(() => ctl.abort(), timeoutMs);
            const res = await fetch(url, {
              headers: { "X-Emby-Token": this.token },
              signal: ctl.signal
            });
            clearTimeout(t);
            if (!res.ok) return null;
            const blob = await res.blob();
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
          this.currentVideo = null;
        }

        destroy() {
          this.clearState();
          if (this.observer) { this.observer.disconnect(); this.observer = null; }

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
      new JellyfinPauseScreen();
        console.log('🪼 Jellyfin Enhanced: Custom Pause Screen initialized.');
    };

})(window.JellyfinEnhanced);