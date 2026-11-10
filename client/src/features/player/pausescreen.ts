import { renderPauseProgress } from './pause-view';
import { createPlayerLifetime } from './lifetime';
import { pauseStyles } from './pause-styles';
import { playerHost } from './host';
import { decodeItem, decodeItems, decodeSessions, decodeSegments, type Item, type Stream, type PlayingSession, type MediaSegment, record } from './wire';
const { JE, ApiClient, ctx } = playerHost();
const lifetime = createPlayerLifetime(JE, 'pause-screen');
JE.initializePauseScreen = function() {
    // Only run if the feature is enabled in the user's settings
    if (!JE.currentSettings.pauseScreenEnabled) {
        JE.pauseScreenInstance?.destroy();
        console.log('🪼 Jellyfin Enhanced: Custom Pause Screen is disabled.');
        return;
    }
      if (JE.pauseScreenInstance?.overlay?.isConnected) return;
      JE.pauseScreenInstance?.destroy();
      const nowPlaying = () => ctx.own.nowPlaying;

      class JellyfinPauseScreen {
        generation = 0;
        destroyed = false;
        currentVideo: (HTMLVideoElement) | null = null;
        currentItemId: (string) | null = null;
        readyItemId: (string) | null = null;
        syncing = 0;
        userId: (string) | null = null;
        token: (string) | null = null;
        cleanupListeners: (() => void) | null = null;
        imgBlobCache = new Map<string, string>();
        imgProbeCache = new Map<string, boolean>();
        itemCache = new Map<string, { item: Item; domain: string }>();
        fetchAbort: (AbortController) | null = null;
        observer: (import('./host').Subscription) | null = null;
        prevFocused: (Element) | null = null;
        pauseScreenDelayMs = (JE.currentSettings.pauseScreenDelaySeconds ?? 5) * 1000;
        pauseScreenTimer: (number) | null = null;
        lastUserInteractionAt = Date.now();
        interactionListeners: ({ event: string; listener: EventListener }[]) | null = null;
        _dismissedThisPause = false;
        overlay = document.createElement('div');
        overlayContent = document.createElement('div');
        overlayLogo = document.createElement('img');
        overlayPlot = document.createElement('div');
        overlayDetails = document.createElement('div');
        overlayDisc = document.createElement('img');
        overlayBackdrop = document.createElement('div');
        progressWrap = document.createElement('div');
        progressBar = document.createElement('div');
        progressMeta = document.createElement('div');
        focusStart = document.createElement('div');
        focusEnd = document.createElement('div');
        closeButton = document.createElement('button');
        keyboardListener: ((e: KeyboardEvent) => void) | null = null;
        releaseReset: (() => void) | undefined;
        releaseUser: (() => void) | undefined;
        readonly imageRequests = new Set<AbortController>();
        credentialTimer: number | undefined;
        constructor() {
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
          this.releaseReset = lifetime.onReset(() => { if (!this.destroyed) this.clearState(); });
          this.releaseUser = JE.session?.onUserChange('pause-screen', () => {
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
            const parsed = record(JSON.parse(creds));
            const servers = Array.isArray(parsed.Servers) ? parsed.Servers.map(record) : [];
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
            return server && typeof server.AccessToken === 'string' && typeof server.UserId === 'string' ? { token: server.AccessToken, userId: server.UserId } : null;
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
          const tryResume = (event: Event) => {
            if (event.target === this.overlay || event.target === this.overlayContent) {
                // Introduce a delay to allow for long-press detection
                if (JE.state?.pauseScreenClickTimer) clearTimeout(JE.state.pauseScreenClickTimer);
                JE.state.pauseScreenClickTimer = window.setTimeout(() => {
                    JE.state.pauseScreenClickTimer = null;
                    this.hideOverlay();
                    if (this.currentVideo?.paused) this.currentVideo.play().catch(error => console.warn("Play blocked", error));
                }, 500);
            }
          };
          this.overlay.addEventListener('click', tryResume);
          this.overlay.addEventListener('touchstart', tryResume, { passive: true });

          // Focus trap behavior
          const trap = (e: Event) => {
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
        handleRemoteKey(e: KeyboardEvent) {
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
          let lastMouseX: number | null = null;
          let lastMouseY: number | null = null;
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
          const handleMouseMove: EventListener = (e) => {
            if (!(e instanceof MouseEvent)) return;
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
          const video = document.querySelector<HTMLVideoElement>(".videoPlayerContainer video");
          if (video && video !== this.currentVideo) {
            this.handleVideoChange(video);
          } else if (!video && this.currentVideo) {
            this.clearState();
          }
        }

        async handleVideoChange(video: HTMLVideoElement) {
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
          for (const request of this.imageRequests) request.abort();
          this.imageRequests.clear();
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
        async syncItem(video: HTMLVideoElement) {
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

        attachVideoListeners(video: HTMLVideoElement) {
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
              const resumeRatingsPolling = ctx.peer('resumeRatingsPolling');
              if (typeof resumeRatingsPolling === 'function') {
                resumeRatingsPolling();
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
              const pauseRatingsPolling = ctx.peer('pauseRatingsPolling');
              if (typeof pauseRatingsPolling === 'function') {
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
                if (this.prevFocused instanceof HTMLElement) this.prevFocused.focus();
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

        async fetchItemInfo(itemId: string) {
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
                if (!(err instanceof Error && err.name === 'AbortError')) {
                console.error("🪼 Jellyfin Enhanced: Error fetching item info:", err);
                this.overlayPlot.textContent = JE.t('pausescreen_fetch_error');
                }
            }
            }

        async fetchWithRetry(url: string, options: RequestInit, maxRetries = 2) {
          for (let i = 0; i <= maxRetries; i++) {
            try {
              const response = await fetch(url, options);
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              return decodeItem(await response.json());
            } catch (error) {
              if (i === maxRetries || options.signal?.aborted) throw error;
              const signal = options.signal ?? lifetime.lease().signal;
              await lifetime.sleep(1000 * (i + 1), signal);
              if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
            }
          }
        }

        async displayItemInfo(item: Item, domain: string, itemId: string) {
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

        formatRuntime(runTimeTicks: number | undefined) {
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
        setProgress(current: number, duration: number) {
          renderPauseProgress(this.progressBar, this.progressMeta, current, duration, (key, params) => JE.t(key, params));
        }

        // ------- Image helpers (blob cache) -------
        async firstAvailableBlobURL(urls: string[]) {
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
        async probeImage(url: string, timeoutMs = 2500) {
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
          } finally { clearTimeout(t); this.imageRequests.delete(ctl); }
        }
        async toBlobURL(url: string, timeoutMs = 5000) {
          const generation = this.generation;
          if (this.destroyed) return null;
          if (this.imgBlobCache.has(url)) return this.imgBlobCache.get(url);
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
            return obj;
          } catch {
            return null;
          } finally { clearTimeout(t); this.imageRequests.delete(ctl); }
        }

        getLogoUrls(item: Item, domain: string, itemId: string) {
          const urls = [];
          if (item.ImageTags?.Logo) {
            urls.push(`${domain}/Items/${itemId}/Images/Logo?tag=${item.ImageTags.Logo}`);
          }
          if (item.ParentId) urls.push(`${domain}/Items/${item.ParentId}/Images/Logo`);
          if (item.SeriesId) urls.push(`${domain}/Items/${item.SeriesId}/Images/Logo`);
          return urls;
        }

        getDiscUrls(item: Item, domain: string, itemId: string) {
          const urls = [`${domain}/Items/${itemId}/Images/Disc`];
          if (item.ParentId) urls.push(`${domain}/Items/${item.ParentId}/Images/Disc`);
          if (item.SeriesId) urls.push(`${domain}/Items/${item.SeriesId}/Images/Disc`);
          return urls;
        }

        getBackdropUrls(item: Item, domain: string, itemId: string) {
          const urls = [
            `${domain}/Items/${itemId}/Images/Backdrop`,
          ];
          if (item.ParentId) urls.push(`${domain}/Items/${item.ParentId}/Images/Backdrop`);
          if (item.SeriesId) urls.push(`${domain}/Items/${item.SeriesId}/Images/Backdrop`);
          return urls;
        }

        clearState() {
          this.generation++;
          if (JE.state?.pauseScreenClickTimer) { clearTimeout(JE.state.pauseScreenClickTimer); JE.state.pauseScreenClickTimer = null; }
          for (const request of this.imageRequests) request.abort();
          this.imageRequests.clear();
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
          if (typeof this.releaseReset === 'function') this.releaseReset();
          if (typeof this.releaseUser === 'function') this.releaseUser();
          clearTimeout(this.credentialTimer);
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
