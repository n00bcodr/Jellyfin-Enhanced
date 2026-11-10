import type { Dependencies } from "./types";

import { runtime } from './runtime';
import downloadsCss from './downloads.css';
export function install(deps: Dependencies) {
  const {JE, P, host, getApi} = deps;
  const life = runtime(deps);
  if(life.installed.has('styles'))return;
  life.installed.add('styles');

  



  // CSS Styles - minimal styling to fit Jellyfin's theme
  const CSS_STYLES = downloadsCss;

  /**
   * Inject CSS styles
   */
  function injectStyles() {
    if (document.getElementById("je-downloads-styles")) return;
    JE.core.ui.injectCss("je-downloads-styles", CSS_STYLES);

    // Inject dynamic theme colors
    injectThemeColors();
  }

  /**
   * Inject dynamic theme colors
   */
  function injectThemeColors() {
    const themeVars = JE.themer?.getThemeVariables() || {};
    const primaryAccent = themeVars.primaryAccent || '#00a4dc';

    JE.core.ui.injectCss("je-downloads-theme-colors", `
      .je-requests-tab.emby-button.active,
      .je-issues-tab.emby-button.active,
      .je-downloads-tab.emby-button.active {
        background: ${primaryAccent} !important;
        border-color: ${primaryAccent} !important;
      }
      .je-request-watch-btn {
        background: ${primaryAccent} !important;
      }
    `);
  }

  P.injectStyles = injectStyles;

}
