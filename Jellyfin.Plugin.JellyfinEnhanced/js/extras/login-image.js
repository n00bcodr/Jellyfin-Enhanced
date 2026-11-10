(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function createFeatureContext(feature, core, slots) {
    const own = {};
    const bind = (keys, target) => {
      for (const key of keys) {
        Object.defineProperty(own, key, {
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
      own,
      peer: (name) => core[name]
    };
  }

  // client/src/features/chrome/host.ts
  function preLoginChromeContext(JE, facades) {
    return createFeatureContext("chrome", JE, { facades });
  }
  function ensureBridge() {
    const host = window;
    if (!host.JellyfinEnhanced) host.JellyfinEnhanced = {};
    return host.JellyfinEnhanced;
  }
  function hostClient() {
    const host = window;
    return host.ApiClient;
  }

  // client/src/features/chrome/login-image.ts
  var MAX_ATTEMPTS = 200;
  var URL_PATTERN = /url\(['"]?(.*?)['"]?\)/;
  function backgroundUrl(style) {
    const match = style?.match(URL_PATTERN);
    return match?.[1] ? match[1] : null;
  }
  function cleanImageUrl(rawUrl, quality, origin) {
    try {
      const url = new URL(rawUrl, origin);
      url.searchParams.delete("width");
      url.searchParams.delete("height");
      url.searchParams.delete("tag");
      url.searchParams.set("quality", quality.toString());
      return url.toString();
    } catch (error) {
      console.error("🪼 Jellyfin Enhanced: Login Image - Invalid URL", error);
      return rawUrl;
    }
  }
  function baseImageUrl(fullUrl, origin) {
    try {
      const url = new URL(fullUrl, origin);
      url.searchParams.delete("quality");
      return url.toString();
    } catch {
      return fullUrl;
    }
  }
  function createLoginImage(readClient) {
    const imageCache = /* @__PURE__ */ new Map();
    let attempts = 0;
    let attemptTimer = null;
    let updateTimeout = null;
    let initialUpdate = null;
    let attached = null;
    let watchingRoutes = false;
    const origin = () => window.location.origin;
    const userImageUrl = (userId, quality = 40) => `${origin()}/Users/${userId}/Images/Primary?quality=${quality}`;
    function isUserLoggedIn() {
      try {
        return !!readClient()?._currentUser?.Id;
      } catch (error) {
        console.error("🪼 Jellyfin Enhanced: Login Image - Error checking login status.", error);
        return false;
      }
    }
    function nameInput() {
      const input = document.getElementById("txtManualName");
      return input instanceof HTMLInputElement ? input : null;
    }
    const loginForm = () => document.querySelector(".manualLoginForm");
    const userLabel = () => loginForm()?.querySelector('label[for="txtManualName"]') ?? null;
    function userCard(container, username) {
      for (const card of container.querySelectorAll(".cardContent[data-username]")) {
        if (card.dataset.username === username) return card;
      }
      return null;
    }
    function preloadImage(url) {
      return new Promise((resolve, reject) => {
        const cached = imageCache.get(url);
        if (cached) {
          resolve(cached);
          return;
        }
        const img = new Image();
        img.onload = () => {
          imageCache.set(url, img);
          resolve(img);
        };
        img.onerror = () => reject(new Error("Failed to load image"));
        img.src = url;
      });
    }
    function preloadAllUserImages() {
      const container = document.getElementById("divUsers");
      if (!container) return;
      container.querySelectorAll(".cardContent[data-username]").forEach((card) => {
        const raw = backgroundUrl(card.querySelector(".cardImageContainer")?.style.backgroundImage);
        if (raw) preloadImage(cleanImageUrl(baseImageUrl(raw, origin()), 90, origin())).catch(() => {
        });
      });
    }
    function resetFormState() {
      const input = nameInput();
      const label = userLabel();
      if (input) input.style.display = "";
      if (label) label.style.display = "";
      document.getElementById("userProfileImageContainer")?.remove();
    }
    function displayProgressiveImage(base, username, imageContainer, input, label) {
      const highQualityUrl = cleanImageUrl(base, 90, origin());
      const img = document.createElement("img");
      img.alt = `Profile picture for ${username}`;
      img.style.cssText = `
            width: clamp(120px, 18vw, 180px);
            height: clamp(120px, 18vw, 180px);
            object-fit: cover;
            display: block;
            margin: 0 auto 20px auto;
        `;
      const hideName = () => {
        if (input) input.style.display = "none";
        if (label) label.style.display = "none";
      };
      if (imageCache.has(highQualityUrl)) {
        img.src = highQualityUrl;
        imageContainer.appendChild(img);
        hideName();
        return;
      }
      img.style.opacity = "0";
      img.style.transition = "opacity 0.2s ease-in-out";
      let loaded = false;
      img.onerror = () => {
        console.warn("🪼 Jellyfin Enhanced: Login Image - Failed to load image");
        if (img.isConnected) resetFormState();
      };
      img.onload = () => {
        if (loaded) return;
        loaded = true;
        img.style.opacity = "1";
        imageCache.set(highQualityUrl, img);
      };
      img.src = highQualityUrl;
      imageContainer.appendChild(img);
      hideName();
    }
    function updateProfilePicture() {
      const input = nameInput();
      const form = loginForm();
      const label = userLabel();
      if (!input || !form || form.classList.contains("hide")) {
        resetFormState();
        return;
      }
      const username = input.value.trim();
      if (!username) {
        resetFormState();
        return;
      }
      let userId = null;
      let base = null;
      const cards = document.getElementById("divUsers");
      const card = cards ? userCard(cards, username) : null;
      if (card) {
        userId = card.dataset.userid || null;
        const raw = backgroundUrl(card.querySelector(".cardImageContainer")?.style.backgroundImage);
        if (raw) base = baseImageUrl(raw, origin());
      }
      if (userId && !base) base = baseImageUrl(userImageUrl(userId, 40), origin());
      if (!base) {
        resetFormState();
        return;
      }
      let imageContainer = document.getElementById("userProfileImageContainer");
      if (!imageContainer) {
        imageContainer = document.createElement("div");
        imageContainer.id = "userProfileImageContainer";
        imageContainer.style.cssText = `
                text-align: center;
                margin-bottom: 20px;
                min-height: clamp(140px, 20vw, 200px);
            `;
        const inputContainer = form.querySelector(".inputContainer");
        if (inputContainer) form.insertBefore(imageContainer, inputContainer);
        else form.prepend(imageContainer);
      }
      imageContainer.innerHTML = "";
      displayProgressiveImage(base, username, imageContainer, input, label);
    }
    function debouncedUpdate() {
      if (updateTimeout !== null) clearTimeout(updateTimeout);
      updateTimeout = setTimeout(() => {
        updateTimeout = null;
        updateProfilePicture();
      }, 50);
    }
    function applyProgressiveLoadingToCards() {
      const container = document.getElementById("divUsers");
      if (!container) return;
      container.querySelectorAll(".cardImageContainer").forEach((card, index) => {
        if (card.dataset.progressiveLoaded === "true") return;
        card.dataset.progressiveLoaded = "true";
        const raw = backgroundUrl(card.style.backgroundImage);
        if (!raw) return;
        const base = baseImageUrl(raw, origin());
        const lowQualityUrl = cleanImageUrl(base, 5, origin());
        const highQualityUrl = cleanImageUrl(base, 90, origin());
        const blurOverlay = document.createElement("div");
        blurOverlay.className = "progressive-blur-overlay";
        blurOverlay.style.cssText = `
                position: absolute;
                inset: 0;
                background-image: url("${lowQualityUrl}");
                background-size: cover;
                background-position: center;
                filter: blur(8px);
                transition: opacity 0.3s ease-in-out;
                pointer-events: none;
                z-index: 1;
                overflow: hidden;
            `;
        if (getComputedStyle(card).position === "static") card.style.position = "relative";
        card.style.overflow = "hidden";
        card.appendChild(blurOverlay);
        card.style.backgroundImage = `url("${highQualityUrl}")`;
        const highQuality = new Image();
        highQuality.onload = () => {
          blurOverlay.style.opacity = "0";
          setTimeout(() => {
            if (blurOverlay.parentNode) blurOverlay.remove();
          }, 300);
        };
        highQuality.onerror = () => {
          console.warn(`🪼 Jellyfin Enhanced: Login Image - Card ${index + 1} high quality failed, keeping low quality`);
          card.style.backgroundImage = `url("${lowQualityUrl}")`;
          if (blurOverlay.parentNode) blurOverlay.remove();
        };
        highQuality.src = highQualityUrl;
      });
    }
    function cleanup() {
      attached?.dispose();
      attached = null;
      if (updateTimeout !== null) {
        clearTimeout(updateTimeout);
        updateTimeout = null;
      }
      if (initialUpdate !== null) {
        clearTimeout(initialUpdate);
        initialUpdate = null;
      }
    }
    function setupObservers() {
      const input = nameInput();
      const form = loginForm();
      if (!input || !form) {
        console.error("🪼 Jellyfin Enhanced: Login Image - Required elements not found.");
        return false;
      }
      if (attached && attached.input === input && attached.form === form && input.isConnected) return true;
      cleanup();
      const onInput = () => debouncedUpdate();
      input.addEventListener("input", onInput);
      const formObserver = new MutationObserver(() => {
        if (!form.classList.contains("hide")) debouncedUpdate();
        else resetFormState();
      });
      formObserver.observe(form, { attributes: true, attributeFilter: ["class"] });
      let cardsObserver = null;
      const cards = document.getElementById("divUsers");
      if (cards) {
        cardsObserver = new MutationObserver(() => {
          applyProgressiveLoadingToCards();
          preloadAllUserImages();
        });
      }
      attached = {
        input,
        form,
        dispose() {
          input.removeEventListener("input", onInput);
          formObserver.disconnect();
          cardsObserver?.disconnect();
        }
      };
      if (!form.classList.contains("hide")) {
        initialUpdate = setTimeout(() => {
          initialUpdate = null;
          updateProfilePicture();
        }, 100);
      } else {
        resetFormState();
      }
      applyProgressiveLoadingToCards();
      preloadAllUserImages();
      if (cards && cardsObserver) cardsObserver.observe(cards, { childList: true, subtree: true });
      return true;
    }
    function watchRoutes() {
      if (watchingRoutes) return;
      watchingRoutes = true;
      const recheck = () => {
        if (isUserLoggedIn()) {
          cleanup();
          return;
        }
        if (attached && attached.input.isConnected && attached.input === nameInput()) return;
        attempts = 0;
        initializeLoginImage();
      };
      window.addEventListener("hashchange", recheck);
      window.addEventListener("popstate", recheck);
      document.addEventListener("viewshow", recheck);
    }
    function initializeLoginImage() {
      if (attemptTimer !== null) {
        clearTimeout(attemptTimer);
        attemptTimer = null;
      }
      if (isUserLoggedIn()) {
        watchRoutes();
        return;
      }
      if (nameInput() && loginForm()) {
        const fresh = !attached;
        if (setupObservers() && fresh) console.log("🪼 Jellyfin Enhanced: Login Image initialized");
        window.addEventListener("beforeunload", cleanup);
        watchRoutes();
        return;
      }
      attempts++;
      if (attempts < MAX_ATTEMPTS) attemptTimer = setTimeout(initializeLoginImage, 100);
      else watchRoutes();
    }
    return { initializeLoginImage };
  }

  // client/src/features/chrome/login-image-entry.ts
  var loginImage = createLoginImage(() => hostClient());
  preLoginChromeContext(ensureBridge(), ["initializeLoginImage"]).own.initializeLoginImage = loginImage.initializeLoginImage;
  loginImage.initializeLoginImage();
})();
})();
//# sourceMappingURL=login-image.js.map
