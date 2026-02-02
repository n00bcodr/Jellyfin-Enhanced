/**
 * Calendar Custom Tab
 * Creates <div class="jellyfinenhanced calendar"></div> for CustomTabs plugin
 */

(function () {
  'use strict';

  if (!window.JellyfinEnhanced?.pluginConfig?.CalendarPageEnabled) {
    return;
  }

  // Inject custom styles
  const style = document.createElement('style');
  style.textContent = `
    .jellyfinenhanced.calendar {
      padding: 12px 3vw;
    }
    #indexPage:has(.tabContent.is-active .jellyfinenhanced.calendar) {
      backdrop-filter: blur(12px);
      background: rgba(0, 0, 0, 0.4);
    }
  `;
  document.head.appendChild(style);

  // Wait for JE.calendarPage to be ready
  function waitForCalendar(callback) {
    const check = setInterval(() => {
      const JE = window.JE || window.JellyfinEnhanced;
      if (JE?.calendarPage) {
        clearInterval(check);
        callback(JE);
      }
    }, 100);
  }

  // Render calendar when container appears
  function renderCalendar(container, JE) {
    container.classList.remove('hide');
    container.style.display = '';

    container.innerHTML = '<div id="je-calendar-container"></div>';

    // Use dedicated custom tab rendering method
    JE.calendarPage.renderForCustomTab?.();

    // Handle event clicks
    if (typeof JE.calendarPage.handleEventClick === 'function') {
      document.addEventListener("click", JE.calendarPage.handleEventClick);
    }
  }

  // Watch for container to appear
  function watchForContainer(JE) {
    const container = document.querySelector('.jellyfinenhanced.calendar');
    if (container) {
      renderCalendar(container, JE);
      return;
    }

    const observer = new MutationObserver(() => {
      const container = document.querySelector('.jellyfinenhanced.calendar');
      if (container) {
        observer.disconnect();
        renderCalendar(container, JE);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Initialize
  waitForCalendar((JE) => {
    watchForContainer(JE);
  });

})();
