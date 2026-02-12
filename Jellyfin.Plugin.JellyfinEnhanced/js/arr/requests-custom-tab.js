/**
 * Requests Custom Tab
 * Creates <div class="jellyfinenhanced requests"></div> for CustomTabs plugin
 */

(function () {
  'use strict';

  if (!window.JellyfinEnhanced?.pluginConfig?.DownloadsPageEnabled) {
    return;
  }

  // Only initialize if custom tabs are enabled
  if (!window.JellyfinEnhanced?.pluginConfig?.DownloadsUseCustomTabs) {
    return;
  }

  // Inject custom styles
  const style = document.createElement('style');
  style.textContent = `
    .jellyfinenhanced.requests {
      padding: 12px 3vw;
    }
    .backgroundContainer.withBackdrop:has(~ .mainAnimatedPages #indexPage .tabContent.is-active .jellyfinenhanced.requests) {
      background: rgba(0, 0, 0, 0.7) !important;
    }
  `;
  document.head.appendChild(style);

  // Wait for JE.downloadsPage to be ready
  function waitForDownloads(callback) {
    const check = setInterval(() => {
      const JE = window.JE || window.JellyfinEnhanced;
      if (JE?.downloadsPage) {
        clearInterval(check);
        callback(JE);
      }
    }, 100);
  }

  // Render downloads when container appears
  function renderDownloads(container, JE) {
    container.classList.remove('hide');
    container.style.display = '';

    container.innerHTML = '<div id="je-downloads-container"></div>';

    // Use dedicated custom tab rendering method
    JE.downloadsPage.renderForCustomTab?.();
  }

  // Watch for container to appear
  function watchForContainer(JE) {
    const container = document.querySelector('.jellyfinenhanced.requests');
    if (container) {
      renderDownloads(container, JE);
      return;
    }

    const observer = new MutationObserver(() => {
      const container = document.querySelector('.jellyfinenhanced.requests');
      if (container) {
        observer.disconnect();
        renderDownloads(container, JE);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Initialize
  waitForDownloads((JE) => {
    watchForContainer(JE);
  });

})();
