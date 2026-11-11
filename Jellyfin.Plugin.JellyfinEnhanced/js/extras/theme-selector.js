(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function featureContext(feature, core, slots) {
    const shared = core.core?.featureContext;
    if (typeof shared !== "function") {
      throw new Error(`${feature}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);
    }
    return shared(feature, core, slots);
  }

  // client/src/features/chrome/host.ts
  function chromeContext(JE2, facades) {
    return featureContext("chrome", JE2, { facades });
  }
  function hostClient() {
    const host = window;
    return host.ApiClient;
  }
  function optionalBridge() {
    const host = window;
    return host.JellyfinEnhanced;
  }

  // client/src/features/chrome/theme-selector.ts
  var THEMES = Object.freeze({
    "Default": "",
    "Aurora": "aurora.css",
    "Banana": "banana.css",
    "Coal": "coal.css",
    "Coral": "coral.css",
    "Forest": "forest.css",
    "Grass": "grass.css",
    "Jellyblue": "jellyblue.css",
    "Jellyflix": "jellyflix.css",
    "Jellypurple": "jellypurple.css",
    "Lavender": "lavender.css",
    "Liquid Glass": "liquidglass.css",
    "Midnight": "midnight.css",
    "Mint": "mint.css",
    "Ocean": "ocean.css",
    "Peach": "peach.css",
    "Watermelon": "watermelon.css"
  });
  var LOG = "🪼 Jellyfin Enhanced: Jellyfish Theme Selector:";
  var CSS_STYLE_ID = "jellyfin-theme-selector-css";
  var SELECTOR_ID = "jellyfin-theme-selector";
  var INIT_DELAY = 250;
  var NOTIFICATION_DELAY = 1e3;
  var DEBOUNCE_DELAY = 100;
  var TRANSITION_DURATION = 300;
  var APPLIED_KEY = "jellyfin-theme-applied";
  function themeImport(baseUrl, filename) {
    return filename ? `@import url("${baseUrl}${filename}");` : "";
  }
  function themeNameFor(baseUrl, stored) {
    for (const [name, filename] of Object.entries(THEMES)) {
      if (themeImport(baseUrl, filename) === stored) return name;
    }
    return "Default";
  }
  var BLOCK_START = "/* Jellyfin Enhanced theme selector: start */";
  var BLOCK_END = "/* Jellyfin Enhanced theme selector: end */";
  function splitCustomCss(baseUrl, stored) {
    const start = stored.indexOf(BLOCK_START);
    const end = start < 0 ? -1 : stored.indexOf(BLOCK_END, start);
    if (end >= 0) {
      return {
        theme: themeNameFor(baseUrl, stored.slice(start + BLOCK_START.length, end).trim()),
        rest: stored.slice(0, start) + stored.slice(end + BLOCK_END.length).replace(/^\n/, "")
      };
    }
    const newline = stored.indexOf("\n");
    const theme = themeNameFor(baseUrl, (newline < 0 ? stored : stored.slice(0, newline)).trim());
    return { theme, rest: theme === "Default" ? stored : newline < 0 ? "" : stored.slice(newline + 1) };
  }
  function withTheme(rest, value) {
    if (!value || !rest) return value || rest;
    return `${BLOCK_START}
${value}
${BLOCK_END}
${rest}`;
  }
  function utcDay(date) {
    return date.toISOString().split("T")[0] ?? "";
  }
  function createThemeSelector(JE2, readClient) {
    const baseUrl = JE2.cdn.url("jellyfish", "colors/");
    let observer = null;
    let debounceTimer;
    let sessionHooked = false;
    const storageKey = (userId, key) => `${userId}-${key}`;
    function read(userId, key, fallback = null) {
      try {
        const value = localStorage.getItem(storageKey(userId, key));
        return value === null ? fallback : value;
      } catch (error) {
        console.error("🪼 Jellyfin Enhanced: Theme selector storage read error", error);
        return fallback;
      }
    }
    function write(userId, key, value) {
      try {
        localStorage.setItem(storageKey(userId, key), value);
        return true;
      } catch (error) {
        console.error("🪼 Jellyfin Enhanced: Theme selector storage write error", error);
        return false;
      }
    }
    function remove(userId, key) {
      try {
        localStorage.removeItem(storageKey(userId, key));
        return true;
      } catch (error) {
        console.error(`${LOG} localStorage remove error:`, error);
        return false;
      }
    }
    const isRandomEnabled = (userId) => read(userId, "randomThemeEnabled") === "true";
    function currentUserId() {
      try {
        const userId = readClient()?.getCurrentUserId?.();
        if (typeof userId === "string" && userId.trim() !== "") return userId;
      } catch (error) {
        console.error(`${LOG} Error extracting user ID:`, error);
      }
      console.error(`${LOG} Could not extract user ID`);
      return null;
    }
    function stillSignedIn(userId) {
      try {
        return readClient()?.getCurrentUserId?.() === userId;
      } catch {
        return false;
      }
    }
    function setTheme(userId, filename, name = "Default") {
      const value = withTheme(splitCustomCss(baseUrl, read(userId, "customCss", "") ?? "").rest, themeImport(baseUrl, filename));
      if (value) write(userId, "customCss", value);
      else remove(userId, "customCss");
      console.log(filename ? `${LOG} Theme set to: ${name}` : `${LOG} Theme cleared (default)`);
    }
    function notify(message) {
      const host = window;
      try {
        if (host.Dashboard?.alert) host.Dashboard.alert(message);
        else if (host.require) host.require(["toast"], (toast) => toast(message));
        else console.log(`${LOG} Notification: ${message}`);
      } catch (error) {
        console.error(`${LOG} Failed to show notification:`, error);
      }
    }
    function checkPostRefreshNotification() {
      try {
        const pending = sessionStorage.getItem(APPLIED_KEY);
        if (pending) {
          sessionStorage.removeItem(APPLIED_KEY);
          setTimeout(() => notify(`Theme applied: ${pending}`), NOTIFICATION_DELAY);
        }
      } catch (error) {
        console.error(`${LOG} Session storage error:`, error);
      }
    }
    function rememberApplied(label, context) {
      try {
        sessionStorage.setItem(APPLIED_KEY, label);
      } catch (error) {
        console.error(`${LOG} ${context}`, error);
      }
    }
    function applyRandomThemeIfNeeded() {
      const userId = currentUserId();
      if (!userId || !isRandomEnabled(userId)) return;
      const today = utcDay(/* @__PURE__ */ new Date());
      if (today === read(userId, "lastRandomThemeDate")) {
        console.log(`${LOG} Random theme already applied for today.`);
        return;
      }
      console.log(`${LOG} New day detected! Applying a random theme.`);
      const names = Object.keys(THEMES).filter((name2) => name2 !== "Default");
      const name = names[Math.floor(Math.random() * names.length)] ?? "Default";
      setTheme(userId, THEMES[name] ?? "", name);
      write(userId, "lastRandomThemeDate", today);
      rememberApplied(`Random Daily (${name})`, "Could not set session storage:");
      window.location.reload();
    }
    function injectCustomCss() {
      if (document.getElementById(CSS_STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = CSS_STYLE_ID;
      style.textContent = `
            #theme-selector-body {
                display: flex !important;
                align-items: center;
                justify-content: flex-start;
                flex-direction: row;
                flex-wrap: wrap;
                gap: 1em;
                padding: .4em .75em;
            }
            #theme-selector-select {
                max-width: 200px !important;
                min-width: 150px !important;
                transition: opacity ${TRANSITION_DURATION}ms ease;
            }
            #theme-selector-select:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
            #random-theme-button {
                padding: 0.5em 0.5em !important;
                height: auto !important;
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: 0.3em;
                background-color: transparent;
                border-radius: 10px;
                transition: background-color 0.3s ease, opacity ${TRANSITION_DURATION}ms ease;
            }
            #random-theme-button:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
            #random-theme-button.active {
                background-color: #4CAF50;
                color: white;
            }
            .theme-applying {
                opacity: 0;
                transition: opacity ${TRANSITION_DURATION}ms ease;
            }
            .theme-applied {
                opacity: 1;
                transition: opacity ${TRANSITION_DURATION}ms ease;
            }
        `;
      document.head.appendChild(style);
      console.log(`${LOG} Custom CSS injected`);
    }
    function icon(name, className = "material-icons") {
      const element = document.createElement("span");
      element.className = className;
      element.textContent = name;
      element.setAttribute("aria-hidden", "true");
      return element;
    }
    function guardOwner(userId, container) {
      if (stillSignedIn(userId)) return true;
      console.warn(`${LOG} Signed-in user changed; discarding the previous user's selector.`);
      container.remove();
      scheduleCheck();
      return false;
    }
    function createSelect(userId, container) {
      const select = document.createElement("select");
      select.setAttribute("is", "emby-select");
      select.className = "emby-select-withcolor emby-select";
      select.id = "theme-selector-select";
      select.setAttribute("aria-label", "Select theme");
      select.removeAttribute("label");
      const selected = splitCustomCss(baseUrl, read(userId, "customCss", "") ?? "").theme;
      for (const name of Object.keys(THEMES)) {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        if (name === selected) option.selected = true;
        select.appendChild(option);
      }
      select.addEventListener("change", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!guardOwner(userId, container)) return;
        const name = select.value;
        const filename = THEMES[name];
        if (filename === void 0) return;
        select.disabled = true;
        const random = document.getElementById("random-theme-button");
        if (random instanceof HTMLButtonElement) random.disabled = true;
        document.body.classList.add("theme-applying");
        setTheme(userId, filename, name);
        rememberApplied(name, "Session storage error:");
        setTimeout(() => {
          console.log(`${LOG} Reloading to apply theme: ${name}`);
          window.location.reload();
        }, TRANSITION_DURATION);
      });
      return select;
    }
    function createRandomButton(userId, container) {
      const button = document.createElement("button");
      button.setAttribute("is", "emby-button");
      button.className = "emby-button";
      button.id = "random-theme-button";
      button.setAttribute("aria-label", "Toggle random daily theme");
      button.setAttribute("title", "Random daily theme");
      const text = document.createElement("span");
      text.style.fontSize = "0.85em";
      const update = () => {
        const enabled = isRandomEnabled(userId);
        button.classList.toggle("active", enabled);
        text.textContent = enabled ? "Daily" : "";
        button.setAttribute("aria-pressed", enabled.toString());
      };
      button.appendChild(icon("shuffle"));
      button.appendChild(text);
      update();
      button.addEventListener("click", () => {
        if (!guardOwner(userId, container)) return;
        const next = !isRandomEnabled(userId);
        write(userId, "randomThemeEnabled", String(next));
        notify(`Random daily theme turned ${next ? "ON" : "OFF"}.`);
        console.log(`${LOG} Random daily theme set to: ${next}`);
        update();
        if (next) applyRandomThemeIfNeeded();
      });
      return button;
    }
    function buildSelector(userId) {
      const container = document.createElement("div");
      container.className = "theme-selector-container listItem-border";
      container.id = SELECTOR_ID;
      container.dataset.jeThemeUser = userId;
      const item = document.createElement("div");
      item.className = "listItem";
      item.id = "theme-selector-item";
      const palette = icon("palette", "material-icons listItemIcon listItemIcon-transparent");
      palette.id = "theme-selector-icon";
      const body = document.createElement("div");
      body.className = "listItemBody";
      body.id = "theme-selector-body";
      const label = document.createElement("div");
      label.className = "listItemBodyText";
      label.id = "theme-selector-label";
      label.textContent = "Theme";
      body.appendChild(label);
      body.appendChild(createRandomButton(userId, container));
      body.appendChild(createSelect(userId, container));
      item.appendChild(palette);
      item.appendChild(body);
      container.appendChild(item);
      return container;
    }
    function injectThemeSelector() {
      try {
        const target = document.querySelector(".verticalSection .headerUsername");
        const section = target?.closest(".verticalSection");
        if (!section) return false;
        const userId = currentUserId();
        if (!userId) return false;
        console.log(`${LOG} Creating theme selector element...`);
        section.appendChild(buildSelector(userId));
        console.log(`${LOG} Successfully injected!`);
        return true;
      } catch (error) {
        console.error(`${LOG} Injection error:`, error);
        return false;
      }
    }
    const isOnPreferencesPage = () => !!(document.querySelector(".headerUsername") && document.querySelector(".lnkUserProfile"));
    function check() {
      const existing = document.getElementById(SELECTOR_ID);
      if (existing && existing instanceof HTMLElement && existing.dataset.jeThemeUser && !stillSignedIn(existing.dataset.jeThemeUser)) existing.remove();
      if (isOnPreferencesPage() && !document.getElementById(SELECTOR_ID)) {
        console.log(`${LOG} Preferences page detected and selector is missing. Injecting...`);
        injectThemeSelector();
      }
    }
    function scheduleCheck() {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(check, DEBOUNCE_DELAY);
    }
    function initialize() {
      const client = readClient();
      if (!client || typeof client.getCurrentUserId !== "function") {
        console.log(`${LOG} Waiting for ApiClient...`);
        setTimeout(initialize, INIT_DELAY);
        return;
      }
      console.log(`${LOG} ApiClient is available. Starting persistent element monitoring.`);
      applyRandomThemeIfNeeded();
      injectCustomCss();
      checkPostRefreshNotification();
      if (observer) {
        observer.unsubscribe();
        observer = null;
      }
      if (JE2.helpers?.onBodyMutation) {
        observer = JE2.helpers.onBodyMutation("theme-selector", scheduleCheck);
      } else {
        const native = new MutationObserver(scheduleCheck);
        native.observe(document.body, { childList: true, subtree: true });
        observer = { unsubscribe: () => native.disconnect() };
      }
      if (!sessionHooked && JE2.session) {
        sessionHooked = true;
        JE2.session.onUserChange("theme-selector", () => {
          document.getElementById(SELECTOR_ID)?.remove();
          scheduleCheck();
        });
      }
    }
    return { initialize };
  }

  // client/src/features/chrome/theme-selector-entry.ts
  var JE = optionalBridge();
  if (JE) chromeContext(JE, ["initializeThemeSelector"]).own.initializeThemeSelector = createThemeSelector(JE, () => hostClient()).initialize;
})();
})();
//# sourceMappingURL=theme-selector.js.map
