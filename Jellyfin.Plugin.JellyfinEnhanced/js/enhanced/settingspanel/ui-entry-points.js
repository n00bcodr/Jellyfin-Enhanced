(() => {
"use strict";
(() => {
  // client/src/features/shared/panel-host.ts
  function panelHost() {
    const host = window;
    if (!host.JellyfinEnhanced) throw new TypeError("Jellyfin Enhanced must load before the settings panel");
    return host.JellyfinEnhanced;
  }

  // client/src/features/settings-panel/ui-entry-points.ts
  var openPanel = (JE) => {
    void JE.showEnhancedPanel?.();
  };
  function installUiEntryPoints(JE) {
    JE.isVideoPage = () => window.location.hash.startsWith("#/video");
    JE.isDetailsPage = () => window.location.hash.includes("/details?id=");
    JE.addPluginMenuButton = () => {
      const addMenuButton = (sidebar) => {
        let jellyfinEnhancedSection = sidebar.querySelector(".jellyfinEnhancedSection");
        if (!jellyfinEnhancedSection) {
          jellyfinEnhancedSection = document.createElement("div");
          jellyfinEnhancedSection.className = "jellyfinEnhancedSection";
          jellyfinEnhancedSection.innerHTML = '<h3 class="sidebarHeader">Jellyfin Enhanced</h3>';
          const mediaSection = sidebar.querySelector(".libraryMenuOptions");
          if (mediaSection) {
            sidebar.insertBefore(jellyfinEnhancedSection, mediaSection);
          } else {
            sidebar.appendChild(jellyfinEnhancedSection);
          }
        }
        if (!jellyfinEnhancedSection.querySelector("#jellyfinEnhancedSettingsLink")) {
          const jellyfinEnhancedLink = document.createElement("a");
          jellyfinEnhancedLink.setAttribute("is", "emby-linkbutton");
          jellyfinEnhancedLink.className = "lnkMediaFolder navMenuOption emby-button";
          jellyfinEnhancedLink.href = "#";
          jellyfinEnhancedLink.id = "jellyfinEnhancedSettingsLink";
          jellyfinEnhancedLink.innerHTML = `
                    <span class="material-icons navMenuOptionIcon" aria-hidden="true">tune</span>
                    <span class="sectionName navMenuOptionText">Enhanced Panel</span>
                `;
          jellyfinEnhancedLink.addEventListener("click", (e) => {
            e.preventDefault();
            openPanel(JE);
          });
          jellyfinEnhancedSection.appendChild(jellyfinEnhancedLink);
        }
      };
      const addMenuButtonDebounced = JE.helpers.debounce(() => {
        if (document.getElementById("jellyfinEnhancedSettingsLink")) return;
        const sidebar = JE.helpers.getSidebarContainer();
        if (sidebar && !sidebar.querySelector("#jellyfinEnhancedSettingsLink")) {
          addMenuButton(sidebar);
        }
      }, 300);
      let menuLink = null;
      JE.helpers.onBodyMutation("ui-menu-button", () => {
        if (menuLink && menuLink.isConnected) return;
        menuLink = document.getElementById("jellyfinEnhancedSettingsLink");
        if (menuLink) return;
        addMenuButtonDebounced();
      });
    };
    JE.addOsdSettingsButton = () => {
      if (document.getElementById("enhancedSettingsBtn")) return;
      const controlsContainer = document.querySelector(".videoOsdBottom .buttons.focuscontainer-x");
      if (!controlsContainer) return;
      const nativeSettingsButton = controlsContainer.querySelector(".btnVideoOsdSettings");
      if (!nativeSettingsButton) return;
      const enhancedSettingsBtn = document.createElement("button");
      enhancedSettingsBtn.id = "enhancedSettingsBtn";
      enhancedSettingsBtn.setAttribute("is", "paper-icon-button-light");
      enhancedSettingsBtn.className = "autoSize paper-icon-button-light";
      enhancedSettingsBtn.title = "Jellyfin Enhanced";
      enhancedSettingsBtn.innerHTML = '<span class="largePaperIconButton material-icons" aria-hidden="true">tune</span>';
      enhancedSettingsBtn.onclick = (e) => {
        e.stopPropagation();
        openPanel(JE);
      };
      const parent = nativeSettingsButton.parentElement;
      if (!parent) throw new TypeError("The OSD settings button has no parent");
      parent.insertBefore(enhancedSettingsBtn, nativeSettingsButton);
    };
    JE.addUserMenuLink = () => {
      const inject = () => {
        if (document.getElementById("jellyfinEnhancedUserMenuLink")) return;
        const settingsLink = document.querySelector('#app-user-menu a[href="#/mypreferencesmenu"]');
        if (!(settingsLink instanceof HTMLAnchorElement)) return;
        const link = settingsLink.cloneNode(true);
        if (!(link instanceof HTMLAnchorElement)) return;
        link.id = "jellyfinEnhancedUserMenuLink";
        link.href = "#";
        const icon = link.querySelector("svg");
        if (icon) {
          const replacement = document.createElement("span");
          replacement.className = "material-icons";
          replacement.setAttribute("aria-hidden", "true");
          replacement.textContent = "tune";
          icon.replaceWith(replacement);
        }
        const text = link.querySelector(".MuiListItemText-primary");
        if (text) text.textContent = "Jellyfin Enhanced";
        link.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const backdrop = document.getElementById("app-user-menu")?.querySelector(":scope > .MuiBackdrop-root");
          if (backdrop instanceof HTMLElement) backdrop.click();
          openPanel(JE);
        });
        settingsLink.insertAdjacentElement("afterend", link);
      };
      inject();
      JE.helpers.onBodyMutation("user-menu-link", inject);
    };
    let userPrefsViewHookInstalled = false;
    JE.addUserPreferencesLink = () => {
      const addLinkToMenu = () => {
        const menuContainer = document.querySelector("#myPreferencesMenuPage:not(.hide) .verticalSection");
        if (!menuContainer) return false;
        if (document.querySelector("#jellyfinEnhancedUserPrefsLink")) return true;
        const enhancedLink = document.createElement("a");
        enhancedLink.id = "jellyfinEnhancedUserPrefsLink";
        enhancedLink.setAttribute("is", "emby-linkbutton");
        enhancedLink.setAttribute("data-ripple", "false");
        enhancedLink.href = "#";
        enhancedLink.className = "listItem-border emby-button";
        enhancedLink.style.display = "block";
        enhancedLink.style.padding = "0";
        enhancedLink.style.margin = "0";
        enhancedLink.innerHTML = `
                <div class="listItem">
                    <span class="material-icons listItemIcon listItemIcon-transparent tune" aria-hidden="true"></span>
                    <div class="listItemBody">
                        <div class="listItemBodyText">Jellyfin Enhanced - User Settings</div>
                    </div>
                </div>
            `;
        enhancedLink.addEventListener("click", (e) => {
          e.preventDefault();
          openPanel(JE);
        });
        menuContainer.appendChild(enhancedLink);
        return true;
      };
      if (addLinkToMenu()) return;
      if (userPrefsViewHookInstalled) return;
      userPrefsViewHookInstalled = true;
      JE.core.navigation.onViewPage(() => {
        if (!addLinkToMenu()) JE.core.dom.afterNextPaint(addLinkToMenu);
      });
    };
  }
  installUiEntryPoints(panelHost());
})();
})();
//# sourceMappingURL=ui-entry-points.js.map
