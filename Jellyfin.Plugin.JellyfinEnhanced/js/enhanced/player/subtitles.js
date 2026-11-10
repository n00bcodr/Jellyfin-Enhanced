(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function sharedModule(id) {
    const namespace = window.JellyfinEnhanced?.core?.sharedModules?.[id];
    if (!namespace) throw new Error(`${id} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);
    return namespace;
  }
  function sharedExport(namespace, name) {
    return namespace[name];
  }

  // client/generated-shared/stub/client/src/features/player/host.ts
  var shared = /* @__PURE__ */ sharedModule("features/player/host");
  var export0 = /* @__PURE__ */ sharedExport(shared, "playerHost");

  // client/generated-shared/stub/client/src/features/player/lifetime.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/player/lifetime");
  var export02 = /* @__PURE__ */ sharedExport(shared2, "createPlayerLifetime");

  // client/src/features/shared/settings-values.ts
  function isSafeCssColor(value) {
    if (typeof value !== "string") return false;
    const v = value.trim();
    if (!/^(?:#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|[a-z]+|(?:rgba?|hsla?)\([\d\s.,%/+-]*\))$/i.test(v)) return false;
    return typeof CSS === "undefined" || typeof CSS.supports !== "function" || CSS.supports("color", v);
  }
  function isSafeFontFamily(value) {
    return typeof value === "string" && /^[\w\s,.'-]+$/.test(value) && (value.split("'").length - 1) % 2 === 0;
  }

  // client/src/features/player/subtitles.ts
  var { JE, ApiClient } = export0();
  var lifetime = export02(JE, "subtitles");
  var subtitleObserver = null;
  var currentSubtitleStyle = { textColor: "", bgColor: "", fontSize: 1.2, fontFamily: "inherit", textShadow: void 0 };
  var STYLED_ATTR = "data-je-subtitle-styled";
  var ORIGINAL_STYLE_ATTR = "data-je-original-style";
  var TEXT_SELECTOR = ".videoSubtitlesInner, .videoSecondarySubtitlesInner";
  var isSafeFontSize = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
  function markStyled(el) {
    if (el.hasAttribute(STYLED_ATTR)) return;
    el.setAttribute(ORIGINAL_STYLE_ATTR, el.getAttribute("style") || "");
    el.setAttribute(STYLED_ATTR, "");
  }
  function restoreOriginalStyle(el) {
    const original = el.getAttribute(ORIGINAL_STYLE_ATTR);
    el.removeAttribute(STYLED_ATTR);
    el.removeAttribute(ORIGINAL_STYLE_ATTR);
    if (original) el.setAttribute("style", original);
    else el.removeAttribute("style");
  }
  JE.subtitlePresets = [
    { name: "Clean White", textColor: "#FFFFFFFF", bgColor: "transparent", previewText: "Aa" },
    { name: "Classic Black Box", textColor: "#FFFFFFFF", bgColor: "#000000FF", previewText: "Aa" },
    { name: "Netflix Style", textColor: "#FFFFFFFF", bgColor: "#000000B2", previewText: "Aa" },
    { name: "Cinema Yellow", textColor: "#FFFF00FF", bgColor: "#000000B2", previewText: "Aa" },
    { name: "Soft Gray", textColor: "#FFFFFFFF", bgColor: "#444444B2", previewText: "Aa" },
    { name: "High Contrast", textColor: "#000000FF", bgColor: "#FFFFFFFF", previewText: "Aa" }
  ];
  JE.fontSizePresets = [
    { name: "Tiny", size: 0.8, previewText: "Aa" },
    { name: "Small", size: 1, previewText: "Aa" },
    { name: "Normal", size: 1.2, previewText: "Aa" },
    { name: "Large", size: 1.8, previewText: "Aa" },
    { name: "Extra Large", size: 2, previewText: "Aa" },
    { name: "Gigantic", size: 3, previewText: "Aa" }
  ];
  JE.fontFamilyPresets = [
    { name: "Default", family: "inherit", previewText: "AaBb" },
    { name: "Noto Sans", family: "Noto Sans,sans-serif", previewText: "AaBb" },
    { name: "Sans Serif", family: "Arial,Helvetica,sans-serif", previewText: "AaBb" },
    { name: "Typewriter", family: "Courier New,Courier,monospace", previewText: "AaBb" },
    { name: "Roboto", family: "Roboto Mono,monospace", previewText: "AaBb" }
  ];
  var AUTO_SHADOW = "0 0 4px #000, 0 0 8px #000, 1px 1px 2px #000";
  function outlineShadow(width, color) {
    const steps = 16;
    const parts = [];
    for (let i = 0; i < steps; i++) {
      const angle = Math.PI * 2 * i / steps;
      const x = (Math.cos(angle) * width).toFixed(3);
      const y = (Math.sin(angle) * width).toFixed(3);
      parts.push(`${x}em ${y}em 0 ${color}`);
    }
    return parts.join(", ");
  }
  JE.subtitleTextEffectPresets = [
    { name: "Auto", shadow: null, previewText: "Aa" },
    { name: "None", shadow: "none", previewText: "Aa" },
    { name: "Shadow", shadow: AUTO_SHADOW, previewText: "Aa" },
    { name: "Outline", shadow: outlineShadow(0.08, "#000"), previewText: "Aa" },
    { name: "Outline + Shadow", shadow: `${outlineShadow(0.08, "#000")}, 0.12em 0.12em 0.2em rgba(0,0,0,0.85)`, previewText: "Aa" }
  ];
  JE.getSubtitleTextShadow = (bgColor, presetIndex) => {
    const index = presetIndex ?? JE.currentSettings.selectedTextEffectPresetIndex;
    const preset = typeof index === "number" && Number.isInteger(index) && JE.subtitleTextEffectPresets[index] || JE.subtitleTextEffectPresets[0];
    if (preset && preset.shadow !== null) return preset.shadow;
    return bgColor === "transparent" || bgColor === "#00000000" ? AUTO_SHADOW : "none";
  };
  JE.decodeSubtitleColor = (input, fallback) => {
    if (input === "transparent") return { swatch: fallback.fallbackSwatch, alphaValue: 0 };
    const isHex = typeof input === "string" && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(input);
    if (!isHex) return { swatch: fallback.fallbackSwatch, alphaValue: fallback.fallbackAlphaValue };
    const swatch = input.slice(0, 7);
    const alphaValue = input.length === 9 ? parseInt(input.slice(7, 9), 16) : 255;
    return { swatch, alphaValue: Number.isNaN(alphaValue) ? fallback.fallbackAlphaValue : alphaValue };
  };
  function applySubtitlePosition() {
    const containers = document.querySelectorAll(".videoSubtitles");
    if (!containers.length) return;
    const disabled = JE.currentSettings.disableCustomSubtitleStyles;
    containers.forEach((container) => {
      if (disabled) {
        if (container.hasAttribute(STYLED_ATTR)) restoreOriginalStyle(container);
      } else {
        markStyled(container);
        const xPct = JE.currentSettings.subtitleHorizontalPosition ?? 50;
        const yPct = JE.currentSettings.subtitleVerticalPosition ?? 95;
        container.style.setProperty("position", "absolute", "important");
        container.style.setProperty("left", `${xPct}%`, "important");
        container.style.setProperty("top", "auto", "important");
        container.style.setProperty("bottom", `${100 - yPct}%`, "important");
        container.style.setProperty("transform", "translateX(-50%)", "important");
        container.style.setProperty("text-align", "center", "important");
        container.style.setProperty("width", "100%", "important");
        container.style.setProperty("max-width", "none", "important");
        container.style.setProperty("gap", "0.25em", "important");
      }
    });
  }
  function removeInjectedStyles() {
    document.querySelectorAll(`.videoSubtitlesInner[${STYLED_ATTR}], .videoSecondarySubtitlesInner[${STYLED_ATTR}], .videoSubtitles[${STYLED_ATTR}]`).forEach(restoreOriginalStyle);
    const styleElement = document.querySelector("#je-html-videoplayer-cuestyle");
    if (styleElement?.sheet) {
      try {
        while (styleElement.sheet && styleElement.sheet.cssRules.length > 0) styleElement.sheet.deleteRule(0);
      } catch (e) {
      }
    }
    if (subtitleObserver) {
      subtitleObserver.unsubscribe();
      subtitleObserver = null;
    }
  }
  JE.applySubtitlePosition = applySubtitlePosition;
  function forceApplyInlineStyles(element) {
    if (!element || JE.currentSettings.disableCustomSubtitleStyles) return;
    markStyled(element);
    element.style.setProperty("background-color", currentSubtitleStyle.bgColor, "important");
    element.style.setProperty("color", currentSubtitleStyle.textColor, "important");
    element.style.setProperty("font-size", `${currentSubtitleStyle.fontSize}vw`, "important");
    element.style.setProperty("font-family", currentSubtitleStyle.fontFamily, "important");
    element.style.setProperty("text-shadow", currentSubtitleStyle.textShadow || "none", "important");
    element.style.setProperty("border-radius", "5px", "important");
    if (currentSubtitleStyle.bgColor && currentSubtitleStyle.bgColor !== "transparent") {
      element.style.setProperty("padding", "0.2em 0.4em", "important");
    } else {
      element.style.setProperty("padding", "0", "important");
    }
    element.style.setProperty("font-weight", "normal", "important");
    element.style.setProperty("font-style", "normal", "important");
    element.style.setProperty("font-variant", "normal", "important");
    if (element.classList.contains("videoSecondarySubtitlesInner")) return;
    element.style.setProperty("margin-top", "0", "important");
    element.style.setProperty("margin-bottom", "0", "important");
  }
  function startSubtitleObserver() {
    if (subtitleObserver) subtitleObserver.unsubscribe();
    subtitleObserver = JE.helpers.onBodyMutation("subtitles", (mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLElement) {
            if (node.matches(TEXT_SELECTOR)) {
              forceApplyInlineStyles(node);
            } else if (node.querySelectorAll) {
              node.querySelectorAll(TEXT_SELECTOR).forEach(forceApplyInlineStyles);
            }
            if (node.classList.contains("videoSubtitles") || node.querySelector?.(".videoSubtitles")) {
              applySubtitlePosition();
            }
          }
        }
      }
    });
  }
  JE.applySubtitleStyles = (rawTextColor, rawBgColor, rawFontSize, rawFontFamily, textShadow) => {
    const textColor = isSafeCssColor(rawTextColor) ? rawTextColor : "#FFFFFFFF";
    const bgColor = isSafeCssColor(rawBgColor) ? rawBgColor : "#00000000";
    const fontSize = isSafeFontSize(rawFontSize) ? rawFontSize : 1.2;
    const fontFamily = isSafeFontFamily(rawFontFamily) ? rawFontFamily : "inherit";
    currentSubtitleStyle = { textColor, bgColor, fontSize, fontFamily, textShadow };
    document.querySelectorAll(TEXT_SELECTOR).forEach(forceApplyInlineStyles);
    applySubtitlePosition();
    startSubtitleObserver();
    const oldStyleElement = document.querySelector("#htmlvideoplayer-cuestyle");
    if (oldStyleElement?.sheet) {
      let styleElement = document.querySelector("#je-html-videoplayer-cuestyle");
      if (!styleElement?.sheet) {
        styleElement = document.createElement("style");
        styleElement.id = "je-html-videoplayer-cuestyle";
        document.head.appendChild(styleElement);
      }
      try {
        while (styleElement.sheet && styleElement.sheet.cssRules.length > 0) styleElement.sheet.deleteRule(0);
        if (JE.currentSettings.disableCustomSubtitleStyles) return;
        const cueRule = `
                video.htmlvideoplayer::cue {
                    background-color: ${bgColor} !important;
                    color: ${textColor} !important;
                    font-size: ${fontSize}vw !important;
                    font-family: ${fontFamily} !important;
                    text-shadow: ${textShadow || "none"} !important;
                }`;
        styleElement.sheet?.insertRule(cueRule, 0);
      } catch (e) {
        console.error("🪼 Jellyfin Enhanced: Failed to apply ::cue styles:", e);
      }
    }
  };
  JE.applySavedStylesWhenReady = () => {
    if (!document.querySelector("video")) {
      if (subtitleObserver) {
        subtitleObserver.unsubscribe();
        subtitleObserver = null;
      }
      return;
    }
    if (JE.currentSettings.disableCustomSubtitleStyles) {
      removeInjectedStyles();
      return;
    }
    const textColor = isSafeCssColor(JE.currentSettings.customSubtitleTextColor) ? JE.currentSettings.customSubtitleTextColor : "#FFFFFFFF";
    const bgColor = isSafeCssColor(JE.currentSettings.customSubtitleBgColor) ? JE.currentSettings.customSubtitleBgColor : "#00000000";
    const textShadow = JE.getSubtitleTextShadow(bgColor);
    const fontSizePreset = JE.fontSizePresets[JE.currentSettings.selectedFontSizePresetIndex ?? 2];
    const fontFamilyPreset = JE.fontFamilyPresets[JE.currentSettings.selectedFontFamilyPresetIndex ?? 0];
    if (fontSizePreset && fontFamilyPreset) {
      JE.applySubtitleStyles(
        textColor,
        bgColor,
        fontSizePreset.size,
        fontFamilyPreset.family,
        textShadow
      );
    }
  };
  lifetime.onReset(removeInjectedStyles);
})();
})();
//# sourceMappingURL=subtitles.js.map
