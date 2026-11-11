(() => {
"use strict";
(() => {
  // client/src/features/shared/panel-host.ts
  function panelHost() {
    const host = window;
    if (!host.JellyfinEnhanced) throw new TypeError("Jellyfin Enhanced must load before the settings panel");
    return host.JellyfinEnhanced;
  }

  // client/src/features/settings-panel/host.ts
  function registry(JE) {
    JE.internals = JE.internals || {};
    return JE.internals.enhancedUi = JE.internals.enhancedUi || {};
  }

  // client/src/features/settings-panel/release-markdown.ts
  var isCallout = (value) => value === "WARNING" || value === "NOTE" || value === "TIP" || value === "IMPORTANT";
  function markdownToHtml(text, escapeHtml, icons) {
    if (!text) return "";
    const colors = {
      WARNING: { border: "#f0ad4e", bg: "rgba(240, 173, 78, 0.1)", icon: icons.WARNING },
      NOTE: { border: "#00a4dc", bg: "rgba(0, 164, 220, 0.1)", icon: icons.NOTE },
      TIP: { border: "#28a745", bg: "rgba(40, 167, 69, 0.1)", icon: icons.TIP },
      IMPORTANT: { border: "#dc3545", bg: "rgba(220, 53, 69, 0.1)", icon: icons.IMPORTANT }
    };
    return escapeHtml(text).replace(/^&gt;\s*\[!(WARNING|NOTE|TIP|IMPORTANT)\]\s*\r?\n((?:&gt;.*(?:\r?\n|$))+)/gm, (_match, type, content) => {
      const noteContent = content.replace(/^&gt;\s?/gm, "");
      const style = isCallout(type) ? colors[type] : colors.NOTE;
      return `<div style="padding: 12px 16px; border-left: 4px solid ${style.border}; background-color: ${style.bg}; margin: 12px 0; border-radius: 4px;"><strong>${style.icon} ${type}:</strong><br>${noteContent}</div>`;
    }).replace(/^### (.*$)/gm, '<h4 style="font-size: 1.1em; margin: 1em 0 0 0; font-weight: 600; color: rgba(255,255,255,0.9);">$1</h4>').replace(/^## (.*$)/gm, '<h3 style="font-size: 1.25em; margin: 1.2em 0 0 0; font-weight: 600; color: rgba(255,255,255,0.95);">$1</h3>').replace(/^# (.*$)/gm, '<h2 style="font-size: 1.4em; margin: 1.2em 0 0 0; font-weight: 700;">$1</h2>').replace(/`([^`]+)`/g, '<code style="background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 3px; font-family: monospace; font-size: 0.9em;">$1</code>').replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" style="color: var(--primary-accent-color, #00a4dc); text-decoration: underline; text-decoration-color: rgba(0, 164, 220, 0.3);">$1</a>').replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>").replace(/^\d+\.\s+(.*)$/gm, (_match, item) => `<ol style="margin: 0; padding-left: 20px;"><li style="margin: 4px 0;">${item}</li></ol>`).replace(/<\/ol>\s*<ol[^>]*>/g, "").replace(/^[-*]\s+(.*)$/gm, (_match, item) => `<ul style="margin: 0; padding-left: 20px;"><li style="margin: 4px 0;">${item}</li></ul>`).replace(/<\/ul>\s*<ul[^>]*>/g, "").replace(/\\\s*\n/g, "<br>").replace(/\n\n+/g, "<br><br>").replace(/\n/g, "<br>").replace(/(<br>\s*){3,}/g, "<br><br>");
  }
  function decodeRelease(value, repository) {
    const record = value !== null && typeof value === "object" ? value : {};
    const field = (name) => Object.prototype.hasOwnProperty.call(record, name) ? Reflect.get(record, name) : void 0;
    const body = field("body");
    const publishedAt = field("published_at");
    const url = field("html_url");
    return {
      body: typeof body === "string" ? body : void 0,
      tagName: field("tag_name"),
      published: publishedAt === null ? /* @__PURE__ */ new Date(0) : typeof publishedAt === "string" || typeof publishedAt === "number" ? new Date(publishedAt) : /* @__PURE__ */ new Date(NaN),
      htmlUrl: typeof url === "string" && /^https?:\/\//i.test(url) ? url : `https://github.com/${repository}/releases/latest`
    };
  }
  function releaseNotesText(body) {
    return body ? body.length > 3e3 ? body.substring(0, 3e3) + "..." : body : "No release notes available.";
  }

  // client/src/features/settings-panel/ui-release-notes.ts
  function installUiReleaseNotes(JE) {
    const internal = registry(JE);
    const GITHUB_REPO = "n00bcodr/Jellyfin-Enhanced";
    const escapeHtml = JE.escapeHtml;
    async function showReleaseNotesNotification() {
      let release;
      try {
        const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
        if (!response.ok) throw new Error("Failed to fetch release data");
        release = decodeRelease(await response.json(), GITHUB_REPO);
      } catch (error) {
        console.error("🪼 Jellyfin Enhanced: Failed to fetch release notes:", error);
        JE.toast(JE.icon(JE.IconName.ERROR) + " " + JE.t("release_notes_load_failed"));
        return;
      }
      const notificationId = "jellyfin-release-notes-notification";
      const existing = document.getElementById(notificationId);
      if (existing) existing.remove();
      const notification = document.createElement("div");
      notification.id = notificationId;
      let autoCloseTimer = null;
      let isMouseInside = false;
      const AUTOCLOSE_DELAY = 2e4;
      const closePanel = () => {
        if (document.getElementById(notificationId)) {
          notification.style.transform = "translateY(-50%) translateX(100%)";
          setTimeout(() => notification.remove(), 300);
        }
      };
      const resetAutoCloseTimer = () => {
        if (autoCloseTimer) clearTimeout(autoCloseTimer);
        autoCloseTimer = setTimeout(() => {
          if (!isMouseInside) {
            closePanel();
          }
        }, AUTOCLOSE_DELAY);
      };
      notification.addEventListener("mouseenter", () => {
        isMouseInside = true;
        if (autoCloseTimer) clearTimeout(autoCloseTimer);
      });
      notification.addEventListener("mouseleave", () => {
        isMouseInside = false;
        resetAutoCloseTimer();
      });
      const themeVars = JE.themer?.getThemeVariables() || {};
      const panelBg = themeVars.panelBg;
      const panelBorder = `1px solid ${themeVars.primaryAccent}`;
      const textColor = themeVars.textColor;
      Object.assign(notification.style, {
        position: "fixed",
        top: "50%",
        right: "20px",
        transform: "translateY(-50%) translateX(100%)",
        background: panelBg,
        color: textColor,
        padding: "0",
        borderRadius: "12px",
        zIndex: 999999,
        fontSize: "14px",
        fontWeight: "500",
        boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
        backdropFilter: `blur(50px)`,
        border: panelBorder,
        width: "600px",
        maxWidth: "90vw",
        maxHeight: "85vh",
        transition: "transform 0.3s ease-out",
        fontFamily: "inherit",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden"
      });
      const releaseNotes = releaseNotesText(release.body);
      const markdown = (text) => markdownToHtml(text, escapeHtml, {
        WARNING: JE.icon(JE.IconName.WARNING),
        NOTE: JE.icon(JE.IconName.NOTE),
        TIP: JE.icon(JE.IconName.INFO),
        IMPORTANT: JE.icon(JE.IconName.ERROR)
      });
      notification.innerHTML = `
            <div style="padding: 20px; border-bottom: 1px solid rgba(255,255,255,0.1); flex-shrink: 0;">
                <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 8px;">
                    <div style="width: 40px; height: 40px; background: #3e74f2bd; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 18px;">${JE.icon(JE.IconName.CLIPBOARD)}</div>
                    <div style="flex: 1;">
                        <div style="font-weight: 600; font-size: 16px; color: #779aeadc;">${escapeHtml(JE.t("release_notes_latest"))}</div>
                        <div style="font-size: 12px; color: rgba(255,255,255,0.7);">${escapeHtml(release.tagName)} - ${escapeHtml(release.published.toLocaleDateString(JE.core?.mediaLanguage?.uiLocale?.() || void 0))}</div>
                    </div>
                    <button onclick="this.closest('#jellyfin-release-notes-notification').remove()" style="background: rgba(255,255,255,0.1); border: none; color: #fff; font-size: 20px; cursor: pointer; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; transition: background 0.2s; flex-shrink: 0;" onmouseover="this.style.background='rgba(255,255,255,0.2)'" onmouseout="this.style.background='rgba(255,255,255,0.1)'">×</button>
                </div>
            </div>
            <div style="flex: 1; overflow-y: auto; padding: 20px; font-size: 13px; color: rgba(255,255,255,0.85); line-height: 1.6;">
                ${markdown(releaseNotes)}
            </div>
            <div style="padding: 16px 20px; border-top: 1px solid rgba(255,255,255,0.1); display: flex; gap: 10px; flex-shrink: 0; background: rgba(0,0,0,0.2);">
                <a href="${escapeHtml(release.htmlUrl)}" target="_blank" style="flex: 1; background: #3e74f2bd; border: 1px solid #779aeadc; color: white; text-decoration: none; padding: 10px 16px; border-radius: 6px; font-size: 13px; font-weight: 500; text-align: center; transition: background 0.2s;" onmouseover="this.style.background='#5284f3'" onmouseout="this.style.background='#3e74f2bd'">${escapeHtml(JE.t("release_notes_view_full"))}</a>
                <button onclick="this.closest('#jellyfin-release-notes-notification').remove()" style="background: #f25151b5; border: 1px solid #f2515133; color: white; padding: 10px 16px; border-radius: 6px; font-size: 13px; font-family: inherit; font-weight: 500; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#f36161'" onmouseout="this.style.background='#f25151b5'">${escapeHtml(JE.t("release_notes_close"))}</button>
            </div>
        `;
      document.body.appendChild(notification);
      setTimeout(() => {
        notification.style.transform = "translateY(-50%) translateX(0)";
      }, 10);
      resetAutoCloseTimer();
    }
    internal.GITHUB_REPO = GITHUB_REPO;
    internal.showReleaseNotesNotification = showReleaseNotesNotification;
  }
  installUiReleaseNotes(panelHost());
})();
})();
//# sourceMappingURL=ui-release-notes.js.map
