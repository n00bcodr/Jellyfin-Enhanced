/**
 * Hidden Content Custom Tab
 * Creates <div class="jellyfinenhanced hidden-content"></div> for CustomTabs plugin
 */

(function () {
  'use strict';

  if (!window.JellyfinEnhanced?.pluginConfig?.HiddenContentEnabled) {
    return;
  }

  // Only initialize if custom tabs are enabled
  if (!window.JellyfinEnhanced?.pluginConfig?.HiddenContentUseCustomTabs) {
    return;
  }

  // Inject custom styles
  const style = document.createElement('style');
  style.textContent = `
    .jellyfinenhanced.hidden-content {
      padding: 12px 3vw;
    }
    .backgroundContainer.withBackdrop:has(~ .mainAnimatedPages #indexPage .tabContent.is-active .jellyfinenhanced.hidden-content) {
      background: rgba(0, 0, 0, 0.7) !important;
    }
  `;
  document.head.appendChild(style);

  // Wait for JE.hiddenContentPage to be ready
  function waitForHiddenContent(callback) {
    const check = setInterval(() => {
      const JE = window.JE || window.JellyfinEnhanced;
      if (JE?.hiddenContentPage && JE?.hiddenContent) {
        clearInterval(check);
        callback(JE);
      }
    }, 100);
  }

  // Render hidden content when container appears
  function renderHiddenContent(container, JE) {
    if (!container || !JE.hiddenContentPage) return;

    container.classList.remove('hide');
    container.style.display = '';

    // Ensure the container has the proper child element
    if (!container.querySelector('#je-hidden-content-container')) {
      container.innerHTML = '<div id="je-hidden-content-container"></div>';
    }

    // Call the custom tab render function
    if (typeof JE.hiddenContentPage.renderForCustomTab === 'function') {
      JE.hiddenContentPage.renderForCustomTab();
    }
  }

  // Watch for container to appear
  function watchForContainer(JE) {
    const container = document.querySelector('.jellyfinenhanced.hidden-content');
    if (container) {
      renderHiddenContent(container, JE);
      return;
    }

    // Also watch for visibility changes in case it's created later
    const observer = new MutationObserver(() => {
      const container = document.querySelector('.jellyfinenhanced.hidden-content');
      if (container) {
        observer.disconnect();
        renderHiddenContent(container, JE);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Initialize
  waitForHiddenContent((JE) => {
    watchForContainer(JE);
  });

})();
