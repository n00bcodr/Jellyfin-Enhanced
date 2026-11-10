(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function createFeatureContext(feature, core, slots) {
    const own2 = {};
    const bind = (keys, target) => {
      for (const key of keys) {
        Object.defineProperty(own2, key, {
          enumerable: true,
          get: () => target()[key],
          set: (value) => {
            target()[key] = value;
          }
        });
      }
    };
    bind(slots.facades ?? [], () => core);
    const internalsObject = slots.internalsObject;
    if (slots.internalSlots?.length) {
      if (!internalsObject) throw new Error(`${feature}: internal slots need the host's internalsObject accessor`);
      bind(slots.internalSlots, internalsObject);
    }
    return {
      feature,
      core,
      own: own2,
      peer: (name) => core[name]
    };
  }

  // client/src/features/chrome/host.ts
  function preLoginChromeContext(JE2, facades) {
    return createFeatureContext("chrome", JE2, { facades });
  }
  function ensureBridge() {
    const host = window;
    if (!host.JellyfinEnhanced) host.JellyfinEnhanced = {};
    return host.JellyfinEnhanced;
  }
  function optionalBridge() {
    const host = window;
    return host.JellyfinEnhanced;
  }

  // client/src/features/chrome/splashscreen.ts
  var SPLASH_TIMING = Object.freeze({
    progressUpdateInterval: 150,
    fadeOutDuration: 400,
    completionDuration: 300,
    hardTimeout: 2e4,
    removalInterval: 100,
    removalDuration: 5e3
  });
  var READY_SELECTORS = [
    ".manualLoginForm",
    "#mainAnimatedPage",
    ".homeSectionsContainer",
    ".pageContainer",
    ".slides-container",
    ".backdrop-container",
    // Baseline element-name selector; it matches nothing on 12.x but is kept verbatim.
    "customTabButton_0",
    ".editorsChoiceItemBanner"
  ];
  var DEFAULT_IMAGE = "/web/assets/img/banner-light.png";
  function nextProgress(progress, lastIncrement, random) {
    if (progress >= 95) return { progress, lastIncrement };
    const increment = Math.max(0.5, lastIncrement * 0.98);
    return { progress: Math.min(95, progress + increment * (0.8 + random * 0.4)), lastIncrement: increment };
  }
  function isElementShown(element) {
    return element instanceof HTMLElement && element.offsetParent !== null;
  }
  function isUIReady() {
    for (const selector of READY_SELECTORS) {
      const element = document.querySelector(selector);
      if (isElementShown(element) || element && selector === "#mainAnimatedPage") return true;
    }
    return false;
  }
  function createSplashScreen(readConfig) {
    let splashElement = null;
    let styleElement = null;
    let permanentBlockStyle = null;
    let readyObserver = null;
    let mediaBarBlocker = null;
    let progressTimer = null;
    let hardTimeout = null;
    let detachReadyListeners = null;
    let isHidden = false;
    function installPreemptiveStyles() {
      try {
        const style = document.createElement("style");
        style.id = "je-preempt-styles";
        style.textContent = `
                html.je-splash-booting .bar-loading,
                html.je-splash-booting #page-loader,
                html.je-splash-booting #splashscreen,
                html.je-splash-booting .splash,
                html.je-splash-booting [data-plugin-splash] {
                    display: none !important;
                }
            `;
        document.documentElement.classList.add("je-splash-booting");
        (document.head || document.documentElement).appendChild(style);
      } catch (error) {
        console.warn("🪼 Jellyfin Enhanced: Failed to install preemptive styles", error);
      }
    }
    function installPermanentBlock() {
      if (permanentBlockStyle) return;
      try {
        permanentBlockStyle = document.createElement("style");
        permanentBlockStyle.id = "je-permanent-block";
        permanentBlockStyle.textContent = `
                #page-loader,
                .bar-loading:not(.je-loading),
                #splashscreen:not(.je-loading),
                .splash:not(.je-loading),
                [data-plugin-splash]:not(.je-loading) {
                    display: none !important;
                    opacity: 0 !important;
                    visibility: hidden !important;
                    pointer-events: none !important;
                }
            `;
        document.head.appendChild(permanentBlockStyle);
        console.log("🪼 Jellyfin Enhanced: Permanent splash block installed");
      } catch (error) {
        console.warn("🪼 Jellyfin Enhanced: Failed to install permanent block", error);
      }
    }
    function removeMediaBarSplash() {
      document.querySelectorAll("#page-loader, .bar-loading:not(.je-loading)").forEach((element) => {
        if (element.parentNode) {
          console.log("🪼 Jellyfin Enhanced: Removing media-bar splash element");
          element.remove();
        }
      });
    }
    function startMediaBarBlocker() {
      if (mediaBarBlocker) return;
      mediaBarBlocker = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          mutation.addedNodes.forEach((node) => {
            if (node instanceof HTMLElement && (node.id === "page-loader" || node.classList.contains("bar-loading") && !node.classList.contains("je-loading"))) {
              console.log("🪼 Jellyfin Enhanced: Blocking media-bar splash attempt");
              node.remove();
            }
          });
        }
      });
      mediaBarBlocker.observe(document.body, { childList: true, subtree: false });
    }
    function hideSplashScreen(reason) {
      if (isHidden) return;
      isHidden = true;
      if (progressTimer !== null) {
        clearInterval(progressTimer);
        progressTimer = null;
      }
      if (hardTimeout !== null) {
        clearTimeout(hardTimeout);
        hardTimeout = null;
      }
      if (readyObserver) {
        readyObserver.disconnect();
        readyObserver = null;
      }
      detachReadyListeners?.();
      detachReadyListeners = null;
      const progressBar = document.getElementById("je-progress-bar");
      const unfilledBar = document.getElementById("je-unfilled-bar");
      const completeRemoval = () => {
        if (splashElement) splashElement.style.opacity = "0";
        setTimeout(() => {
          splashElement?.remove();
          splashElement = null;
          styleElement?.remove();
          styleElement = null;
          document.body.classList.remove("je-splash-active");
          const removalInterval = setInterval(removeMediaBarSplash, SPLASH_TIMING.removalInterval);
          setTimeout(() => clearInterval(removalInterval), SPLASH_TIMING.removalDuration);
          if (reason) console.log(`🪼 Jellyfin Enhanced: Splash screen hidden → ${reason}`);
        }, SPLASH_TIMING.fadeOutDuration);
      };
      if (progressBar && unfilledBar) {
        progressBar.style.transition = "width 300ms ease-in-out";
        progressBar.style.width = "100%";
        unfilledBar.style.width = "0%";
        setTimeout(completeRemoval, SPLASH_TIMING.completionDuration);
      } else {
        completeRemoval();
      }
    }
    function startProgressAnimation() {
      const progressBar = document.getElementById("je-progress-bar");
      const unfilledBar = document.getElementById("je-unfilled-bar");
      if (!progressBar || !unfilledBar) return;
      let state = { progress: 0, lastIncrement: 5 };
      progressTimer = setInterval(() => {
        if (state.progress >= 95) return;
        state = nextProgress(state.progress, state.lastIncrement, Math.random());
        progressBar.style.width = state.progress + "%";
        unfilledBar.style.width = 100 - state.progress + "%";
      }, SPLASH_TIMING.progressUpdateInterval);
    }
    function startReadyObserver() {
      if (readyObserver) return;
      if (isUIReady()) {
        hideSplashScreen("UI already ready");
        return;
      }
      readyObserver = new MutationObserver(() => {
        removeMediaBarSplash();
        if (document.querySelector(".bar-loading:not(.je-loading)")) document.body.classList.add("je-splash-active");
        if (isUIReady()) hideSplashScreen("core UI detected");
      });
      readyObserver.observe(document.body, { childList: true, subtree: true });
      const onHash = () => {
        if (isUIReady()) hideSplashScreen("hashchange ready");
      };
      const onVisibility = () => {
        if (!document.hidden && isUIReady()) hideSplashScreen("visibilitychange ready");
      };
      window.addEventListener("hashchange", onHash);
      document.addEventListener("visibilitychange", onVisibility);
      detachReadyListeners = () => {
        window.removeEventListener("hashchange", onHash);
        document.removeEventListener("visibilitychange", onVisibility);
      };
    }
    function buildSplash(imageUrl) {
      const splash2 = document.createElement("div");
      splash2.className = "je-loading";
      splash2.innerHTML = `
            <div class="je-loader-content">
                <h1><img alt="Server Logo" decoding="async" fetchpriority="high" referrerpolicy="no-referrer"></h1>
                <div class="je-progress">
                    <div id="je-progress-bar"></div>
                    <div class="je-gap"></div>
                    <div id="je-unfilled-bar"></div>
                </div>
            </div>
        `;
      splash2.querySelector("img")?.setAttribute("src", imageUrl);
      return splash2;
    }
    function createSplash() {
      if (splashElement) return;
      installPermanentBlock();
      startMediaBarBlocker();
      removeMediaBarSplash();
      styleElement = document.createElement("style");
      styleElement.id = "je-splash-styles";
      styleElement.textContent = `
            body.je-splash-active .bar-loading:not(.je-loading) { display: none !important; }
            body.je-splash-active #page-loader { display: none !important; }
            .je-loading {
                z-index: 99999999 !important;
                position: fixed;
                inset: 0;
                background: #000;
                display: flex;
                align-items: center;
                justify-content: center;
                opacity: 1;
                transition: opacity 0.4s ease-in-out;
                overflow: hidden;
            }
            .je-loader-content {
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 20px;
                width: 250px;
            }
            .je-loading h1 {
                width: 250px;
                height: 250px;
                display: flex;
                justify-content: center;
                align-items: center;
                margin: 0;
            }
            .je-loading h1 img {
                width: 250px;
                max-height: 250px;
                object-fit: contain;
                opacity: 1;
                transition: opacity 0.5s ease-in-out;
            }
            .je-progress {
                width: 200px;
                height: 6px;
                display: flex;
                align-items: center;
                position: relative;
            }
            #je-progress-bar {
                height: 5px;
                background: #fff;
                border-radius: 2px;
                width: 0;
            }
            .je-gap {
                width: 6px;
                height: 5px;
                flex-shrink: 0;
            }
            #je-unfilled-bar {
                height: 5px;
                background: #686868;
                border-radius: 2px;
                flex-grow: 1;
            }
        `;
      document.head.appendChild(styleElement);
      const configured = readConfig()?.SplashScreenImageUrl;
      splashElement = buildSplash(typeof configured === "string" && configured ? configured : DEFAULT_IMAGE);
      document.body.appendChild(splashElement);
      startProgressAnimation();
      startReadyObserver();
      hardTimeout = setTimeout(() => hideSplashScreen("hard timeout 20s"), SPLASH_TIMING.hardTimeout);
      if (isHidden && hardTimeout !== null) {
        clearTimeout(hardTimeout);
        hardTimeout = null;
      }
    }
    function cleanup() {
      document.documentElement.classList.remove("je-splash-booting");
      document.getElementById("je-preempt-styles")?.remove();
      permanentBlockStyle?.remove();
      permanentBlockStyle = null;
      mediaBarBlocker?.disconnect();
      mediaBarBlocker = null;
    }
    function initializeSplashScreen() {
      if (!readConfig()?.EnableCustomSplashScreen) {
        cleanup();
        console.log("🪼 Jellyfin Enhanced: Custom splash screen disabled");
        return;
      }
      if (isHidden) return;
      if (!document.body) {
        document.addEventListener("DOMContentLoaded", initializeSplashScreen, { once: true });
        return;
      }
      document.body.classList.add("je-splash-active");
      document.documentElement.classList.remove("je-splash-booting");
      document.getElementById("je-preempt-styles")?.remove();
      installPermanentBlock();
      startMediaBarBlocker();
      removeMediaBarSplash();
      createSplash();
      console.log("🪼 Jellyfin Enhanced: Splash screen initialized");
    }
    return { installPreemptiveStyles, initializeSplashScreen, hide: () => hideSplashScreen("requested by plugin.js") };
  }

  // client/src/features/chrome/splashscreen-entry.ts
  var JE = ensureBridge();
  var splash = createSplashScreen(() => optionalBridge()?.pluginConfig);
  splash.installPreemptiveStyles();
  var own = preLoginChromeContext(JE, ["initializeSplashScreen", "hideSplashScreen"]).own;
  own.initializeSplashScreen = splash.initializeSplashScreen;
  own.hideSplashScreen = splash.hide;
  console.log("🪼 Jellyfin Enhanced: Splash screen module loaded.");
})();
})();
//# sourceMappingURL=splashscreen.js.map
