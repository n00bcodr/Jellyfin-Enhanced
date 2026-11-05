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
          this.seriesGenreCache = new Map();
          this.trimCache = new Map();
          this.fetchAbort = null;
          this.observer = null;
          this.prevFocused = null;

          // Pause screen delay state
          this.pauseScreenDelayMs = (JE.currentSettings.pauseScreenDelaySeconds ?? 5) * 1000;
          this.pauseScreenTimer = null;
          this.endsAtTimer = null;
          this.resizeListener = null;
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
          this.overlayPoster = null;
          this.overlayMain = null;
          this.overlayTitle = null;
          this.overlaySubtitle = null;
          this.overlayGenres = null;
          this.progressHint = null;
          this.resumeButton = null;
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
            for (const [src, url] of this.trimCache) if (url !== src) URL.revokeObjectURL(url);
            this.trimCache.clear();
            this.imgBlobCache.clear();
            this.imgProbeCache.clear();
            this.itemCache.clear();
            this.seriesGenreCache.clear();
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
              --pause-screen-overlay-bg: rgba(10, 10, 14, .6);
              --pause-screen-blur: 8px;
              --pause-screen-accent: var(--theme-primary-color, var(--primary-accent-color, #00a4dc));
              --pause-screen-gutter-x: clamp(24px, 6vw, 110px);
              --pause-screen-gutter-y: clamp(20px, 5vh, 64px);
              --pause-screen-logo-max-w: min(46vw, 640px);
              --pause-screen-logo-max-h: 22vh;
              --pause-screen-text-size: clamp(14px, 1.2vw, 24px);
              --pause-screen-meta-size: clamp(14px, 1.2vw, 24px);
              --pause-screen-hint-size: clamp(14px, 1.1vw, 21px);
              --pause-screen-plot-font: clamp(15px, 1.3vw, 26px);
              --pause-screen-plot-lines: 4;
              --pause-screen-plot-max-w: 56ch;
              --pause-screen-progress-height: 4px;
              --pause-screen-progress-radius: 999px;
              --pause-screen-disc-w: clamp(220px, 20vw, 360px);
              --pause-screen-disc-rot-sec: 90s;
              --pause-screen-poster-w: clamp(170px, 16vw, 300px);
              --pause-screen-still-w: clamp(240px, 26vw, 500px);
            }

            #pause-screen-overlay {
              position: fixed; inset: 0;
              display: none;
              z-index: 99;
              color: #fff;
              font-family: inherit;
              background: var(--pause-screen-overlay-bg);
            }
            #pause-screen-overlay[aria-hidden="false"] { display: block; animation: pause-screen-fade .28s ease-out; transition: opacity .25s ease-out; }
            #pause-screen-overlay.is-resuming { opacity: 0; }
            @keyframes pause-screen-fade { from { opacity: 0; } to { opacity: 1; } }
            @keyframes pause-screen-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }

            .pause-screen-active .videoOsdBottom { opacity: 0 !important; pointer-events: none !important; }
            .pause-screen-active #je-playback-rating-badge { display: none !important; }

            /* To show back button when paused */
            .pause-screen-active .skinHeader.osdHeader {
                z-index: 100 !important;
                opacity: 0.9 !important;
                visibility: visible !important;
                background: transparent !important;
                width: 10vw !important;
                transform: none !important;
                top: 0 !important;
            }
            .pause-screen-active .skinHeader.osdHeader .headerRight,
            .pause-screen-active .skinHeader.osdHeader .pageTitle,
            .pause-screen-active .skinHeader.osdHeader .videoOsd-appBar > :not(button) {
                display: none !important;
            }
            .pause-screen-active .skinHeader.osdHeader .videoOsd-appBar { align-items: flex-start !important; }

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
              overflow: hidden;
              backdrop-filter: blur(28px) brightness(0.6);
              outline: none;
            }

            /* Backdrop image (under everything), softened so the text stays readable */
            #pause-screen-backdrop {
              position: absolute; inset: -4%;
              background-position: center;
              background-size: cover;
              filter: blur(var(--pause-screen-blur));
              opacity: .78;
              pointer-events: none;
            }
            #pause-screen-backdrop.is-still {
              inset: -10%;
              filter: blur(clamp(24px, 2.2vw, 44px)) saturate(1.2);
              opacity: .72;
            }
            .pause-screen-scrim {
              position: absolute; inset: 0;
              pointer-events: none;
              background:
                linear-gradient(90deg, rgba(8,9,13,.88) 0%, rgba(8,9,13,.66) 36%, rgba(8,9,13,.28) 64%, rgba(8,9,13,.18) 100%),
                linear-gradient(180deg, rgba(8,9,13,.42) 0%, rgba(8,9,13,0) 26%, rgba(8,9,13,0) 60%, rgba(8,9,13,.84) 100%);
            }

            .pause-screen-layout {
              position: absolute; inset: 0;
              display: grid;
              grid-template-columns: minmax(0, 1fr) auto;
              align-items: center;
              column-gap: clamp(24px, 4vw, 80px);
              padding: var(--pause-screen-gutter-y) var(--pause-screen-gutter-x) calc(var(--pause-screen-gutter-y) + 110px);
              box-sizing: border-box;
            }
            .pause-screen-main {
              display: flex; flex-direction: column; align-items: flex-start;
              gap: clamp(10px, 1.6vh, 20px);
              min-width: 0;
              max-width: min(100%, 60vw);
              animation: pause-screen-rise .4s ease-out;
            }
            #pause-screen-logo {
              display: block;
              max-width: var(--pause-screen-logo-max-w);
              max-height: var(--pause-screen-logo-max-h);
              width: auto; height: auto;
              object-fit: contain; object-position: left center;
              margin-bottom: clamp(2px, .8vh, 10px);
              filter: drop-shadow(0 6px 24px rgba(0,0,0,.45));
            }
            #pause-screen-title {
              margin: 0;
              font-size: clamp(30px, 4.4vw, 68px);
              line-height: 1.04; font-weight: 700; letter-spacing: -.012em;
              text-shadow: 0 2px 18px rgba(0,0,0,.5);
              text-wrap: balance;
            }
            .pause-screen-main.has-logo #pause-screen-title,
            .pause-screen-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
            #pause-screen-subtitle {
              font-size: clamp(18px, 1.75vw, 34px);
              font-weight: 600; line-height: 1.25;
              text-shadow: 0 1px 12px rgba(0,0,0,.4);
            }
            #pause-screen-subtitle .pause-screen-episode-code { opacity: .75; font-weight: 500; margin-right: .55em; }
            #pause-screen-details {
              display: flex; flex-wrap: wrap; align-items: center;
              gap: .35em 1em;
              font-size: var(--pause-screen-text-size);
              color: rgba(255,255,255,.92);
            }
            #pause-screen-details .mediaInfoOfficialRating { font-size: .85em; margin: 0; }
            #pause-screen-details .mediaInfoOfficialRating.is-light { color: #111 !important; text-shadow: none !important; }
            #pause-screen-details .pause-screen-score,
            #pause-screen-details .pause-screen-score > span[aria-hidden] { display: inline-flex; align-items: center; gap: .2em; }
            #pause-screen-details .pause-screen-score .material-icons { font-size: 1.15em; color: #f2b01e; }
            #pause-screen-details .pause-screen-date-short { display: none; }
            #pause-screen-genres {
              font-size: var(--pause-screen-text-size);
              color: #d0d0d0;
              margin-top: calc(-1 * clamp(4px, .8vh, 10px));
            }
            #pause-screen-plot {
              font-size: var(--pause-screen-plot-font);
              line-height: 1.5;
              color: #f0f0f0;
              max-width: var(--pause-screen-plot-max-w);
              display: -webkit-box; -webkit-box-orient: vertical;
              -webkit-line-clamp: var(--pause-screen-plot-lines);
              overflow: hidden;
              text-align: left;
              text-wrap: pretty;
              text-shadow: 0 1px 2px rgba(0,0,0,.45);
            }

            .pause-screen-art { display: flex; align-items: center; justify-content: flex-end; min-width: 0; }
            #pause-screen-disc {
              width: var(--pause-screen-disc-w);
              height: auto; display: block;
              border-radius: 50%;
              animation: pause-screen-spin var(--pause-screen-disc-rot-sec) linear infinite;
              filter: drop-shadow(0 18px 40px rgba(0,0,0,.55));
            }
            #pause-screen-poster.is-still { width: var(--pause-screen-still-w); aspect-ratio: 16 / 9; }
            #pause-screen-poster {
              width: var(--pause-screen-poster-w);
              aspect-ratio: 2 / 3;
              object-fit: cover; display: block;
              border-radius: 12px;
              box-shadow: 0 12px 32px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.08);
            }
            #pause-screen-poster:not(.is-still) { filter: brightness(.9); }

            @keyframes pause-screen-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

            /* Progress UI */
            .pause-screen-footer {
              position: absolute;
              left: var(--pause-screen-gutter-x); right: var(--pause-screen-gutter-x);
              bottom: var(--pause-screen-gutter-y);
            }
            #pause-screen-progress-wrap { user-select: none; }
            #pause-screen-progress-bar {
              width: 100%;
              height: var(--pause-screen-progress-height);
              border-radius: var(--pause-screen-progress-radius);
              background: #30343b;
              box-shadow: 0 0 0 1px #9ca3af;
              overflow: hidden;
              position: relative;
            }
            #pause-screen-progress-bar > span {
              display: block;
              height: 100%;
              width: 0%;
              background: var(--pause-screen-accent);
              border-radius: inherit;
            }
            #pause-screen-progress-meta {
              margin-top: .75em;
              display: flex; justify-content: space-between; align-items: center;
              gap: .5em 2em; flex-wrap: wrap;
              font-size: var(--pause-screen-meta-size);
              color: rgba(255,255,255,.88);
              font-variant-numeric: tabular-nums;
            }
            #pause-screen-progress-meta .pause-screen-meta-group { display: inline-flex; align-items: center; gap: .6em; flex-wrap: wrap; }
            .pause-screen-status { display: inline-flex; align-items: center; gap: .25em; font-weight: 600; color: #fff; }
            .pause-screen-status .material-icons { font-size: 1.5em; margin-left: -.18em; }
            #pause-screen-progress-meta .progress-percentage { display: none; }
            #pause-screen-progress-meta .progress-time:not(:empty)::before,
            #pause-screen-progress-meta .progress-percentage:not(:empty)::before,
            #pause-screen-progress-meta .progress-ends-at:not(:empty)::before { content: '·'; opacity: .5; margin-right: .6em; }
            .pause-screen-actions {
              display: flex; flex-wrap: wrap; align-items: center;
              gap: .4em 1em;
              margin-top: .6em;
            }
            .pause-screen-resume {
              display: inline-flex; align-items: center; gap: 8px;
              min-height: 44px;
              padding: 0 16px 0 12px;
              background: rgba(255,255,255,.10);
              border: 1px solid rgba(255,255,255,.28);
              border-radius: 6px;
              color: #fff;
              font: inherit;
              font-size: max(14px, var(--pause-screen-hint-size));
              font-weight: 600;
              line-height: 1.2;
              cursor: pointer;
              transition: background .2s, border-color .2s;
            }
            .pause-screen-resume .material-icons { font-size: 1.4em; }
            .pause-screen-resume:hover { background: rgba(255,255,255,.18); border-color: rgba(255,255,255,.45); }
            .pause-screen-resume:focus-visible { outline: 2px solid #fff; outline-offset: 4px; background: #fff; border-color: #fff; color: #111; }
            @media (min-width: 1200px) {
              .pause-screen-resume { min-height: 48px; font-size: 18px; background: #ededed; border-color: #ededed; color: #111; }
              .pause-screen-resume:hover { background: #fff; border-color: #fff; }
            }
            @media (min-width: 1600px) { .pause-screen-resume { min-height: 56px; font-size: 24px; padding: 0 22px 0 12px; gap: 10px; } }
            /* Older TV browsers (webOS 5/6, Tizen ≤ 6.5) have no :focus-visible; give the remote a focus style anyway */
            .layout-tv .pause-screen-resume:focus { outline: 3px solid #fff; outline-offset: 4px; background: #fff; border-color: #fff; color: #111; }
            .layout-tv #pause-screen-close-btn:focus { outline: 2px solid #fff; outline-offset: 2px; background: rgba(20,20,24,.6); border-color: rgba(255,255,255,.35); }
            .pause-screen-hint {
              font-size: var(--pause-screen-hint-size);
              line-height: 1.4;
              color: rgba(255,255,255,.85);
            }
            @media (min-width: 1600px) { .pause-screen-resume:focus-visible { outline-width: 3px; } }
            #pause-screen-close-btn {
              position: absolute;
              top: 2px;
              right: 16px;
              min-width: 44px; height: 44px;
              padding: 0 10px;
              background: transparent;
              border: 1px solid transparent;
              color: #fff;
              border-radius: 22px;
              display: flex;
              align-items: center;
              justify-content: center;
              gap: 4px;
              font: inherit;
              font-size: 15px;
              cursor: pointer;
              z-index: 2;
              transition: background 0.2s, border-color .2s;
            }
            #pause-screen-close-btn .material-icons { font-size: 24px; }
            #pause-screen-close-btn .pause-screen-close-label { display: inline; padding-right: 4px; }
            @media (min-width: 1600px) { #pause-screen-close-btn { font-size: 20px; } }
            #pause-screen-close-btn:hover,
            #pause-screen-close-btn:focus-visible {
              background: rgba(20,20,24,.6);
              border-color: rgba(255,255,255,.35);
            }

            #pause-screen-close-btn:focus-visible {
              outline: 2px solid #fff;
              outline-offset: 2px;
            }
            @media (min-width: 1600px) { #pause-screen-close-btn:focus-visible { outline-width: 3px; } }
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

            /* Large screens: thicker track and bigger playback facts for distance viewing */
            @media (min-width: 1200px) {
              :root { --pause-screen-progress-height: 6px; --pause-screen-meta-size: max(var(--pause-screen-text-size), min(28px, calc(1.89vw - 8.3px))); }
              .pause-screen-main:not(.has-logo) #pause-screen-title { font-size: clamp(56px, 4.4vw, 88px); line-height: 1.08; max-width: 18ch; }
            }
            @media (min-width: 1600px) {
              :root { --pause-screen-progress-height: 8px; }
            }

            /* Narrow landscape (tablets, phones on their side): no room for the art column, text spans the width */
            @media (max-width: 1000px) {
              .pause-screen-layout { grid-template-columns: minmax(0, 1fr); }
              .pause-screen-art { display: none; }
              .pause-screen-main { max-width: 100%; }
              :root { --pause-screen-logo-max-w: min(60vw, 520px); }
              .pause-screen-scrim {
                background: linear-gradient(180deg, rgba(8,9,13,.55) 0%, rgba(8,9,13,.70) 20%, rgba(8,9,13,.70) 75%, rgba(8,9,13,.92) 100%);
              }
            }

            /* Portrait phone and tablet: one column, left-aligned, footer pinned */
            @media (max-width: 768px), (max-width: 1000px) and (orientation: portrait) {
              :root {
                --pause-screen-gutter-x: clamp(20px, 5vw, 48px);
                --pause-screen-gutter-y: 22px;
                --pause-screen-logo-max-w: 78vw;
                --pause-screen-logo-max-h: 18vh;
                --pause-screen-text-size: clamp(14px, 2vw, 18px);
                --pause-screen-meta-size: clamp(14px, 2vw, 18px);
                --pause-screen-hint-size: clamp(14px, 2vw, 18px);
                --pause-screen-plot-font: clamp(15px, 2.2vw, 20px);
                --pause-screen-plot-lines: 4;
              }
              #pause-screen-close-btn { opacity: .85; }
              .pause-screen-layout { padding-top: 76px; padding-bottom: 176px; align-items: end; }
              @media (min-height: 800px) and (orientation: portrait) {
                :root { --pause-screen-plot-lines: 7; --pause-screen-plot-font: clamp(16px, 2.2vw, 20px); --pause-screen-meta-size: clamp(16px, 2vw, 18px); --pause-screen-hint-size: clamp(15px, 2vw, 18px); }
              }
              @media (min-height: 740px) and (orientation: portrait) {
                .pause-screen-layout {
                  grid-template-columns: auto minmax(0, 1fr);
                  grid-template-areas: "logo logo" "title title" "sub sub" "art facts" "art genres" "plot plot";
                  align-content: start; align-items: start; row-gap: 0; column-gap: 16px;
                }
                .pause-screen-main { display: contents; }
                .pause-screen-main > * { margin-bottom: 12px; }
                #pause-screen-logo { grid-area: logo; margin-bottom: 16px; }
                #pause-screen-title { grid-area: title; margin: 0 0 16px; }
                #pause-screen-subtitle { grid-area: sub; }
                .pause-screen-art { display: flex; grid-area: art; align-self: start; justify-content: flex-start; min-height: 0; margin-bottom: 12px; }
                #pause-screen-details { grid-area: facts; align-self: end; }
                #pause-screen-genres { grid-area: genres; align-self: start; margin-top: 0; }
                #pause-screen-plot { grid-area: plot; margin-top: 4px; }
                #pause-screen-poster { width: 96px; }
                #pause-screen-disc { width: 112px; animation: none; }
                /* an episode still goes under the episode line, full width */
                #pause-screen-overlay.has-still .pause-screen-layout { grid-template-areas: "logo logo" "title title" "sub sub" "art art" "facts facts" "genres genres" "plot plot"; }
                #pause-screen-overlay.has-still .pause-screen-art { align-self: start; }
                #pause-screen-poster.is-still { width: 100%; max-width: 420px; }
              }
              #pause-screen-title { font-size: clamp(28px, 8vw, 40px); }
              #pause-screen-subtitle { font-size: 18px; }
              #pause-screen-details .pause-screen-date-long { display: none; }
              #pause-screen-details .pause-screen-date-short { display: inline; }
              #pause-screen-progress-meta { flex-direction: column; align-items: flex-start; gap: .35em; }
              #pause-screen-close-btn { top: 4px; right: 8px; }
            }

            /* Phone landscape: short viewport */
            @media (max-height: 500px) and (orientation: landscape) {
              :root {
                --pause-screen-gutter-y: 14px;
                --pause-screen-logo-max-w: min(38vw, 320px);
                --pause-screen-logo-max-h: clamp(56px, 20vh, 80px);
                --pause-screen-plot-lines: 3;
                --pause-screen-plot-max-w: min(100%, 68ch);
                --pause-screen-text-size: 14px;
                --pause-screen-meta-size: 14px;
                --pause-screen-hint-size: 14px;
                --pause-screen-plot-font: 14px;
              }
              .pause-screen-layout { padding-top: 56px; padding-bottom: 108px; }
              .pause-screen-main { gap: 8px; }
              #pause-screen-subtitle { font-size: 16px; }
              #pause-screen-details .pause-screen-date-long { display: none; }
              #pause-screen-details .pause-screen-date-short { display: inline; }
              #pause-screen-progress-meta { margin-top: .4em; }
              .pause-screen-actions { margin-top: .3em; }
            }
            @media (max-height: 500px) and (orientation: landscape) and (min-width: 700px) {
              .pause-screen-layout { grid-template-columns: minmax(0, 1fr) auto; column-gap: 24px; }
              .pause-screen-art { display: flex; }
              #pause-screen-poster { width: 135px; }
              #pause-screen-poster.is-still { width: 240px; }
              #pause-screen-disc { width: 150px; }
            }

            @media (forced-colors: active) {
              #pause-screen-progress-bar { border: 1px solid CanvasText; }
              #pause-screen-progress-bar > span { background: Highlight; forced-color-adjust: none; }
            }

            /* Reduced motion: no spin, no fade */
            @media (prefers-reduced-motion: reduce) {
              #pause-screen-disc { animation: none !important; }
              #pause-screen-overlay[aria-hidden="false"], .pause-screen-main { animation: none !important; }
              #pause-screen-overlay[aria-hidden="false"], #pause-screen-close-btn, .pause-screen-resume { transition: none !important; }
            }

            /* Hide absent images and empty text slots */
            #pause-screen-logo:not([src]), #pause-screen-disc:not([src]), #pause-screen-poster:not([src]) { display: none; }
            #pause-screen-title:empty, #pause-screen-subtitle:empty, #pause-screen-genres:empty, .pause-screen-hint:empty { display: none; }

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
          this.overlay.setAttribute("aria-label", JE.t('pausescreen_paused'));
          this.overlay.setAttribute("aria-describedby", "pause-screen-progress-meta pause-screen-hint");

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

          // Backdrop layer and the gradient scrim that keeps the text readable over it
          this.overlayBackdrop = document.createElement("div");
          this.overlayBackdrop.id = "pause-screen-backdrop";
          const scrim = document.createElement("div");
          scrim.className = "pause-screen-scrim";

          // Two-column layout: text on the left, art on the right
          const layout = document.createElement("div");
          layout.className = "pause-screen-layout";
          this.overlayMain = document.createElement("div");
          this.overlayMain.className = "pause-screen-main";
          const art = document.createElement("div");
          art.className = "pause-screen-art";

          // UI nodes
          this.overlayLogo = document.createElement("img");
          this.overlayLogo.id = "pause-screen-logo";
          this.overlayLogo.alt = "";

          // Text title, shown only when no logo image is available
          this.overlayTitle = document.createElement("div");
          this.overlayTitle.id = "pause-screen-title";
          this.overlayTitle.setAttribute("role", "heading");
          this.overlayTitle.setAttribute("aria-level", "1");

          // Episode line (season/episode code and episode name)
          this.overlaySubtitle = document.createElement("div");
          this.overlaySubtitle.id = "pause-screen-subtitle";

          this.overlayDetails = document.createElement("div");
          this.overlayDetails.id = "pause-screen-details";

          this.overlayGenres = document.createElement("div");
          this.overlayGenres.id = "pause-screen-genres";

          this.overlayPlot = document.createElement("div");
          this.overlayPlot.id = "pause-screen-plot";

          this.overlayDisc = document.createElement("img");
          this.overlayDisc.id = "pause-screen-disc";
          this.overlayDisc.alt = "";

          this.overlayPoster = document.createElement("img");
          this.overlayPoster.id = "pause-screen-poster";
          this.overlayPoster.alt = "";

          // Footer: progress bar, playback facts and the resume hint
          const footer = document.createElement("div");
          footer.className = "pause-screen-footer";
          this.progressWrap = document.createElement("div");
          this.progressWrap.id = "pause-screen-progress-wrap";
          this.progressBar = document.createElement("div");
          this.progressBar.id = "pause-screen-progress-bar";
          this.progressBar.setAttribute("role", "progressbar");
          this.progressBar.setAttribute("aria-valuemin", "0");
          this.progressBar.setAttribute("aria-valuemax", "100");
          this.progressBar.setAttribute("aria-label", JE.t('pausescreen_progress_label'));
          const fill = document.createElement("span");
          this.progressBar.appendChild(fill);
          this.progressMeta = document.createElement("div");
          this.progressMeta.id = "pause-screen-progress-meta";
          const statusLabel = JE.core.ui.escapeHtml(JE.t('pausescreen_paused'));
          this.progressMeta.innerHTML = `
              <span class="pause-screen-meta-group">
                <span class="pause-screen-status"><span class="material-icons" aria-hidden="true">pause</span>${statusLabel}</span>
                <span class="progress-time"></span>
                <span class="progress-percentage"></span>
              </span>
              <span class="pause-screen-meta-group">
                <span class="progress-left"></span>
                <span class="progress-ends-at"></span>
              </span>
          `;
          const actions = document.createElement("div");
          actions.className = "pause-screen-actions";
          this.resumeButton = document.createElement("button");
          this.resumeButton.type = "button";
          this.resumeButton.id = "pause-screen-resume";
          this.resumeButton.className = "pause-screen-resume";
          this.resumeButton.innerHTML = `<span class="material-icons" aria-hidden="true">play_arrow</span><span>${JE.core.ui.escapeHtml(JE.t('pausescreen_resume_label'))}</span>`;
          this.resumeButton.addEventListener('click', (e) => { e.stopPropagation(); this.resume(); });
          // The input hint ("Space or click anywhere") describes the dialog; the button is the named action.
          this.progressHint = document.createElement("span");
          this.progressHint.className = "pause-screen-hint";
          this.progressHint.id = "pause-screen-hint";
          actions.appendChild(this.resumeButton);
          actions.appendChild(this.progressHint);
          this.progressWrap.appendChild(this.progressBar);
          this.progressWrap.appendChild(this.progressMeta);
          this.progressWrap.appendChild(actions);
          footer.appendChild(this.progressWrap);

          const closeButton = document.createElement("button");
          closeButton.id = "pause-screen-close-btn";
          closeButton.type = "button";
          closeButton.setAttribute("aria-label", JE.t('pausescreen_dismiss'));
          closeButton.title = JE.t('pausescreen_dismiss');
          closeButton.innerHTML = `<span class="material-icons" aria-hidden="true">close</span><span class="pause-screen-close-label" aria-hidden="true">${JE.core.ui.escapeHtml(JE.t('pausescreen_hide'))}</span>`;
          closeButton.onclick = () => {
              this.hideOverlay(true);
          };
          this.closeButton = closeButton;

          // Assemble
          this.overlayMain.appendChild(this.overlayLogo);
          this.overlayMain.appendChild(this.overlayTitle);
          this.overlayMain.appendChild(this.overlaySubtitle);
          this.overlayMain.appendChild(this.overlayDetails);
          this.overlayMain.appendChild(this.overlayGenres);
          this.overlayMain.appendChild(this.overlayPlot);
          art.appendChild(this.overlayDisc);
          art.appendChild(this.overlayPoster);
          layout.appendChild(this.overlayMain);
          layout.appendChild(art);

          this.overlayContent.appendChild(this.overlayBackdrop);
          this.overlayContent.appendChild(scrim);
          this.overlayContent.appendChild(layout);
          this.overlayContent.appendChild(footer);
          this.overlayContent.appendChild(closeButton);

          this.overlay.appendChild(this.focusStart);
          this.overlay.appendChild(this.overlayContent);
          this.overlay.appendChild(this.focusEnd);

          document.body.appendChild(this.overlay);

          // Pointer/touch anywhere but the close button resumes
          const tryResume = (event) => {
            if (event.target?.closest?.('#pause-screen-close-btn, #pause-screen-resume')) return;
            // Introduce a delay to allow for long-press detection; fade right away so the tap reads as taken
            this.overlay.classList.add('is-resuming');
            JE.state.pauseScreenClickTimer = setTimeout(() => this.resume(), 500);
          };
          this.overlay.addEventListener('click', tryResume);
          this.overlay.addEventListener('touchstart', tryResume, { passive: true });

          // Focus trap behavior
          const trap = (e) => {
            if (this.overlay.getAttribute('aria-hidden') === 'false') {
              if (e.target === this.focusStart) this.resumeButton.focus();
              if (e.target === this.focusEnd) this.resumeButton.focus();
            }
          };
          this.focusStart.addEventListener('focus', trap);
          this.focusEnd.addEventListener('focus', trap);
        }

        /** Hides the overlay and resumes playback (the overlay's primary action). */
        resume() {
          this.hideOverlay();
          if (this.currentVideo?.paused) {
            const r = this.currentVideo.play();
            if (r && typeof r.catch === 'function') r.catch(err => console.warn("🪼 Jellyfin Enhanced: Play() blocked:", err));
          }
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
            this.resumeButton.focus();
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
                if (document.activeElement === this.closeButton) {
                  // The focused × keeps its own meaning: hide the details, stay paused.
                  this.hideOverlay(true);
                  return;
                }
                this.resume();
              }
              // Tab moves between the two controls: resume and hide
              if (e.code === 'Tab') {
                e.preventDefault();
                e.stopPropagation();
                (document.activeElement === this.resumeButton ? this.closeButton : this.resumeButton).focus();
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

        /**
         * The resume hint for the way this device is driven: remote, touch or keyboard/mouse.
         * @returns {string}
         */
        resumeHint() {
          if (JE.core?.ui?.isTvLayout?.()) return JE.t('pausescreen_resume_hint_tv');
          if (window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches) return JE.t('pausescreen_resume_hint_touch');
          return JE.t('pausescreen_resume_hint');
        }

        showOverlay() {
            if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                this.overlayDisc.style.animation = 'none';
            } else {
                this.overlayDisc.style.animation = '';
            }
            this.progressHint.textContent = this.resumeHint();
            // "Ends at" is relative to now: recompute when the overlay shows and keep it honest while it stays up.
            this.updateProgressStatic();
            if (this.endsAtTimer) clearInterval(this.endsAtTimer);
            this.endsAtTimer = setInterval(() => this.updateProgressStatic(), 60000);
            this.prevFocused = document.activeElement;
            document.documentElement.classList.add('pause-screen-active');
            this.overlay.setAttribute('aria-hidden', 'false');
            this.alignCloseButton();
            this.resumeButton.focus();
            this.fitOverview();
            if (!this.resizeListener) {
              this.resizeListener = () => { if (this.overlay.getAttribute('aria-hidden') === 'false') { this.fitOverview(); this.alignCloseButton(); } };
              window.addEventListener('resize', this.resizeListener);
            }
            }

        /** Puts the × on the same line as Jellyfin's back arrow, wherever the player's header lays it out. */
        alignCloseButton() {
          // Jellyfin 12 can keep a stale, zero-size OSD header around; use the one that is actually laid out.
          const candidates = document.querySelectorAll('.skinHeader.osdHeader .videoOsd-appBar > button:first-child, .skinHeader.osdHeader .headerBackButton');
          let rect = null;
          for (const el of candidates) {
            const r = el.getBoundingClientRect();
            if (r.height > 0 && r.width > 0) { rect = r; break; }
          }
          if (rect && rect.height > 0) {
            this.closeButton.style.top = `${Math.max(0, Math.round(rect.top + rect.height / 2 - 22))}px`;
          } else {
            this.closeButton.style.top = '';
          }
        }

        hideOverlay(dismissed = false) {
            if (this.endsAtTimer) { clearInterval(this.endsAtTimer); this.endsAtTimer = null; }
            this.overlay.classList.remove('is-resuming');
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
          this.overviewText = '';
          this.overlayPlot.textContent = "";
          this.overlayDetails.innerHTML = "";
          this.overlayTitle.textContent = "";
          this.overlaySubtitle.textContent = "";
          this.overlayGenres.textContent = "";
          this.overlayMain.classList.remove('has-logo');
          this.overlayLogo.removeAttribute('src');
          this.overlayDisc.removeAttribute('src');
          this.overlayPoster.removeAttribute('src');
          this.overlayBackdrop.style.backgroundImage = '';
          this.overlayBackdrop.classList.remove('is-still');
          this.overlay.classList.remove('has-still');
          this.overlay.setAttribute('aria-label', JE.t('pausescreen_paused'));
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
          const isEpisode = item.Type === 'Episode';

          // Title text is the fallback for a missing logo; episodes show the series name there.
          const titleText = (isEpisode ? (item.SeriesName || item.Name) : item.Name) || '';
          this.overlayTitle.textContent = titleText;
          this.renderSubtitle(item);
          const spokenLine = [...this.overlaySubtitle.querySelectorAll('.pause-screen-sr, .pause-screen-episode-name')].map(n => n.textContent.trim()).filter(Boolean).join(' ');
          const nameParts = [titleText, spokenLine].filter(Boolean);
          this.overlay.setAttribute('aria-label', nameParts.length ? `${JE.t('pausescreen_paused')}: ${nameParts.join(', ')}` : JE.t('pausescreen_paused'));
          this.renderDetails(item);
          this.overlayGenres.textContent = (Array.isArray(item.Genres) ? item.Genres : []).slice(0, 3).join(' · ');
          this.overviewText = item.Overview || JE.t('pausescreen_no_description');
          this.overlayPlot.textContent = this.overviewText;
          if (this.overlay.getAttribute('aria-hidden') === 'false') this.fitOverview();

          // Images: preload to blob URLs (cached)
          const logoUrls = this.getLogoUrls(item, domain, itemId);
          const discUrls = this.getDiscUrls(item, domain, itemId);
          const backdropUrls = this.getBackdropUrls(item, domain, itemId);

          const [logoURL, discURL, backdropURL] = await Promise.all([
            this.firstAvailableBlobURL(logoUrls),
            this.firstAvailableBlobURL(discUrls),
            this.firstAvailableBlobURL(backdropUrls)
          ]);
          // Art column: disc art first; for an episode its own still (16:9), then a poster.
          let stillURL = null, posterURL = null;
          if (!discURL) {
            if (isEpisode && item.ImageTags?.Primary) stillURL = await this.firstAvailableBlobURL([`${domain}/Items/${itemId}/Images/Primary?maxWidth=1000&tag=${item.ImageTags.Primary}`]);
            if (!stillURL) posterURL = await this.firstAvailableBlobURL(this.getPosterUrls(item, domain, itemId));
          }
          const trimmedLogoURL = logoURL ? await this.trimTransparentEdges(logoURL) : null;

          if (this.destroyed || generation !== this.generation) return;
          if (trimmedLogoURL) {
            this.overlayLogo.src = trimmedLogoURL;
            this.overlayMain.classList.add('has-logo');
          }
          if (discURL) this.overlayDisc.src = discURL;
          this.overlayPoster.classList.toggle('is-still', !!stillURL);
          if (stillURL || posterURL) this.overlayPoster.src = stillURL || posterURL;
          const backdropChoice = stillURL || backdropURL;
          this.overlayBackdrop.classList.toggle('is-still', !!stillURL);
          this.overlay.classList.toggle('has-still', !!stillURL);
          if (backdropChoice) this.overlayBackdrop.style.backgroundImage = `url("${backdropChoice}")`;

          // Episodes rarely carry genres of their own; borrow the series' list.
          if (isEpisode && !this.overlayGenres.textContent && item.SeriesId) {
            this.fillSeriesGenres(item.SeriesId, generation);
          }

          // Set static progress snapshot if paused
          this.updateProgressStatic();
        }

        /**
         * Trims the overview to whole sentences that fit the clamped box, so a glance reads an
         * edited synopsis rather than a cut-off fragment. Falls back to the plain clamp when even
         * the first sentence overflows. Runs when the overlay is visible (layout is needed).
         */
        fitOverview() {
          const full = this.overviewText || '';
          const el = this.overlayPlot;
          if (!full || !el || el.clientHeight === 0) return;
          el.textContent = full;
          const overflows = () => el.scrollHeight > el.clientHeight + 2;
          if (!overflows()) return;
          const ends = [];
          const re = /[.!?…]["'”’)\]]*\s+/g;
          let m;
          while ((m = re.exec(full)) !== null) ends.push(m.index + m[0].length);
          for (let i = ends.length - 1; i >= 0; i--) {
            const cut = full.slice(0, ends[i]).trim();
            if (cut.length < full.length * 0.35 && i > 0) continue;
            el.textContent = cut;
            if (!overflows()) return;
          }
          el.textContent = full;
        }

        /**
         * Episode line: "S3 · E2" plus the episode name. Empty for anything but an episode.
         * @param {object} item - The Jellyfin item DTO.
         */
        renderSubtitle(item) {
          this.overlaySubtitle.replaceChildren();
          if (item.Type !== 'Episode') return;
          const season = item.ParentIndexNumber;
          const episode = item.IndexNumber;
          if (Number.isFinite(season) && Number.isFinite(episode)) {
            const code = document.createElement('span');
            code.className = 'pause-screen-episode-code';
            const episodeText = Number.isFinite(item.IndexNumberEnd) && item.IndexNumberEnd > episode ? `${episode}–${item.IndexNumberEnd}` : String(episode);
            code.textContent = JE.t('pausescreen_episode_code', { season, episode: episodeText });
            code.setAttribute('aria-hidden', 'true');
            const spoken = document.createElement('span');
            spoken.className = 'pause-screen-sr';
            spoken.textContent = JE.t('pausescreen_episode_spoken', { season, episode: episodeText });
            this.overlaySubtitle.appendChild(code);
            this.overlaySubtitle.appendChild(spoken);
            this.overlaySubtitle.appendChild(document.createTextNode(' '));
          }
          if (item.Name) {
            const name = document.createElement('span');
            name.className = 'pause-screen-episode-name';
            name.textContent = item.Name;
            this.overlaySubtitle.appendChild(name);
          }
        }

        /**
         * Facts row: date, official rating, runtime and community score.
         * @param {object} item - The Jellyfin item DTO.
         */
        renderDetails(item) {
          const premiere = item.Type === 'Episode' && item.PremiereDate ? new Date(item.PremiereDate) : null;
          const when = premiere && Number.isFinite(premiere.getTime()) ? this.formatDate(item.PremiereDate) : (item.ProductionYear || '');
          const whenShort = premiere && Number.isFinite(premiere.getTime()) ? String(premiere.getFullYear()) : '';
          const rating = item.OfficialRating || '';
          const runtime = this.formatRuntime(item.RunTimeTicks);
          const score = Number.isFinite(item.CommunityRating) && item.CommunityRating > 0 ? item.CommunityRating.toFixed(1) : '';
          this.overlayDetails.replaceChildren();
          for (const [value, kind] of [[when, 'text'], [rating, 'rating'], [runtime, 'text'], [score, 'score']]) {
            if (!value) continue;
            const span = document.createElement('span');
            if (kind === 'score') {
              span.className = 'pause-screen-score';
              const visible = document.createElement('span');
              visible.setAttribute('aria-hidden', 'true');
              const star = document.createElement('span');
              star.className = 'material-icons';
              star.textContent = 'star';
              visible.appendChild(star);
              visible.appendChild(document.createTextNode(String(value)));
              const sr = document.createElement('span');
              sr.className = 'pause-screen-sr';
              sr.textContent = JE.t('pausescreen_community_rating', { score: String(value) });
              span.appendChild(visible);
              span.appendChild(sr);
            } else if (kind === 'text' && value === when && whenShort && whenShort !== when) {
              // Phones get the year only; the full date is more than they can spend on it.
              const long = document.createElement('span'); long.className = 'pause-screen-date-long'; long.textContent = String(value);
              const short = document.createElement('span'); short.className = 'pause-screen-date-short'; short.textContent = whenShort;
              span.className = 'pause-screen-date';
              span.appendChild(long); span.appendChild(short);
            } else if (kind === 'rating') {
              span.className = 'mediaInfoOfficialRating';
              span.setAttribute('rating', String(value));
              span.textContent = String(value);
            } else {
              span.textContent = String(value);
            }
            this.overlayDetails.appendChild(span);
          }
          this.markLightBadges();
        }

        /**
         * Rating badges inherit Jellyfin's fills (yellow PG, orange PG-13, ...). White lettering
         * on the light ones is under 4.5:1, so those get dark lettering instead.
         */
        markLightBadges() {
          for (const badge of this.overlayDetails.querySelectorAll('.mediaInfoOfficialRating')) {
            let light = false;
            try {
              const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(badge).backgroundColor || '');
              if (m) {
                const [r, g, b] = [m[1], m[2], m[3]].map(v => { const c = Number(v) / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
                const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                light = (luminance + 0.05) / 0.05 < 4.5 ? false : (1.05 / (luminance + 0.05)) < 4.5;
              }
            } catch { light = false; }
            badge.classList.toggle('is-light', light);
          }
        }

        /**
         * Fills the genre line from the series when the episode has none.
         * @param {string} seriesId - The parent series id.
         * @param {number} generation - The display generation this belongs to.
         */
        async fillSeriesGenres(seriesId, generation) {
          try {
            let genres = this.seriesGenreCache.get(seriesId);
            if (!genres) {
              const series = await this.fetchWithRetry(ApiClient.getUrl(`/Items/${seriesId}`), {
                headers: { "Authorization": 'MediaBrowser Token="' + this.token + '"', "X-Emby-Token": this.token, "Accept": "application/json" },
                signal: this.fetchAbort?.signal
              }, 0);
              genres = Array.isArray(series?.Genres) ? series.Genres : [];
              this.seriesGenreCache.set(seriesId, genres);
            }
            if (this.destroyed || generation !== this.generation) return;
            this.overlayGenres.textContent = genres.slice(0, 3).join(' · ');
          } catch {
            // Genres are decoration; a failed lookup just leaves the line empty.
          }
        }

        /**
         * Crops the transparent padding many logo files carry, so the gap under the logo is the same for every title.
         * @param {string} blobURL - Object URL of the logo image.
         * @returns {Promise<string>} An object URL of the cropped image, or the input when nothing can be cropped.
         */
        async trimTransparentEdges(blobURL) {
          if (this.trimCache.has(blobURL)) return this.trimCache.get(blobURL);
          const keep = () => { this.trimCache.set(blobURL, blobURL); return blobURL; };
          try {
            if (typeof HTMLCanvasElement === 'undefined') return keep();
            const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = blobURL; });
            const w = img.naturalWidth, h = img.naturalHeight;
            if (!w || !h || w * h > 4_000_000) return keep();
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) return keep();
            ctx.drawImage(img, 0, 0);
            const data = ctx.getImageData(0, 0, w, h).data;
            let top = h, left = w, right = -1, bottom = -1;
            for (let y = 0; y < h; y++) {
              for (let x = 0; x < w; x++) {
                if (data[(y * w + x) * 4 + 3] > 8) {
                  if (y < top) top = y;
                  if (y > bottom) bottom = y;
                  if (x < left) left = x;
                  if (x > right) right = x;
                }
              }
            }
            if (right < 0) return keep();
            const pad = 2;
            left = Math.max(0, left - pad); top = Math.max(0, top - pad);
            right = Math.min(w - 1, right + pad); bottom = Math.min(h - 1, bottom + pad);
            const cw = right - left + 1, ch = bottom - top + 1;
            if (cw >= w - 4 && ch >= h - 4) return keep();
            const out = document.createElement('canvas');
            out.width = cw; out.height = ch;
            out.getContext('2d').drawImage(canvas, left, top, cw, ch, 0, 0, cw, ch);
            const blob = await new Promise(resolve => out.toBlob(resolve, 'image/png'));
            if (!blob) return keep();
            const url = URL.createObjectURL(blob);
            this.trimCache.set(blobURL, url);
            return url;
          } catch {
            return keep();
          }
        }

        /**
         * The locale Jellyfin formats its own clock with (its date/time setting lands on <html lang>),
         * so "Ends at" reads like the player's.
         * @returns {string|undefined}
         */
        locale() {
          const lang = document.documentElement.lang;
          return lang && /^[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(lang) ? lang : undefined;
        }

        /**
         * Short localized date, e.g. "22 Mar 2023".
         * @param {string} iso - ISO date string.
         * @returns {string}
         */
        formatDate(iso) {
          const d = new Date(iso);
          if (!Number.isFinite(d.getTime())) return '';
          try {
            return d.toLocaleDateString(this.locale(), { year: 'numeric', month: 'short', day: 'numeric' });
          } catch {
            return String(d.getFullYear());
          }
        }

        formatRuntime(runTimeTicks) {
          if (!runTimeTicks) return "";
          return this.formatDuration(Math.floor(runTimeTicks / 600000000));
        }

        /**
         * "1h 48m" / "48m" from a whole number of minutes.
         * @param {number} totalMinutes
         * @returns {string}
         */
        formatDuration(totalMinutes) {
          if (!Number.isFinite(totalMinutes) || totalMinutes < 0) return "";
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
          this.progressBar.setAttribute('aria-valuenow', String(Math.round(pct)));
          const remainingSeconds = duration > 0 && current < duration ? duration - current : 0;
          const leftText = remainingSeconds > 0 ? JE.t('pausescreen_time_left', { time: this.formatDuration(Math.max(1, Math.round(remainingSeconds / 60))) }) : '';
          const valueText = duration > 0 ? [JE.t('pausescreen_watched_percent', { percent: Math.round(pct) }), `${this.formatClock(current)} / ${this.formatClock(duration)}`, leftText].filter(Boolean).join(', ') : '';
          if (valueText) this.progressBar.setAttribute('aria-valuetext', valueText); else this.progressBar.removeAttribute('aria-valuetext');

          const timeEl = this.progressMeta.querySelector('.progress-time');
          const endsAtEl = this.progressMeta.querySelector('.progress-ends-at');
          const leftEl = this.progressMeta.querySelector('.progress-left');
          const percentageEl = this.progressMeta.querySelector('.progress-percentage');

          if (timeEl) {
            timeEl.textContent = duration > 0 ? `${this.formatClock(current)} / ${this.formatClock(duration)}` : '';
          }

          if (percentageEl) {
            percentageEl.textContent = duration > 0 ? JE.t('pausescreen_watched_percent', { percent: Math.round(pct) }) : '';
          }

          if (leftEl) leftEl.textContent = leftText;

          if (endsAtEl) {
            if (remainingSeconds > 0) {
              const endTime = new Date(Date.now() + remainingSeconds * 1000);
              const formattedEndTime = endTime.toLocaleTimeString(this.locale(), { hour: 'numeric', minute: '2-digit' });
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

        /**
         * Poster candidates, series poster first for episodes (their own primary image is a 16:9 still).
         * @param {object} item
         * @param {string} domain
         * @param {string} itemId
         * @returns {string[]}
         */
        getPosterUrls(item, domain, itemId) {
          const urls = [];
          if (item.SeasonId) urls.push(`${domain}/Items/${item.SeasonId}/Images/Primary?maxHeight=900`);
          if (item.SeriesId) urls.push(`${domain}/Items/${item.SeriesId}/Images/Primary?maxHeight=900`);
          if (item.Type !== 'Episode' && item.ImageTags?.Primary) urls.push(`${domain}/Items/${itemId}/Images/Primary?maxHeight=900&tag=${item.ImageTags.Primary}`);
          if (!item.SeriesId && item.ParentId && item.Type !== 'Movie') urls.push(`${domain}/Items/${item.ParentId}/Images/Primary?maxHeight=900`);
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
          for (const [src, url] of this.trimCache) if (url !== src) URL.revokeObjectURL(url);
          this.trimCache.clear();
          if (this.endsAtTimer) { clearInterval(this.endsAtTimer); this.endsAtTimer = null; }
          if (this.resizeListener) { window.removeEventListener('resize', this.resizeListener); this.resizeListener = null; }
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
