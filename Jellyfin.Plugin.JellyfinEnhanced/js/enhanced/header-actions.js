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
  function chromeBridge() {
    const host = window;
    if (!host.JellyfinEnhanced) throw new Error("Jellyfin Enhanced must initialize before chrome modules");
    return host.JellyfinEnhanced;
  }

  // client/src/features/chrome/header-actions.ts
  var number = (value) => parseFloat(value) || 0;
  var SOURCE_SELECTOR = ".headerButton:not(.je-header-launcher)";
  var sum = (css, properties) => properties.reduce((total, property) => total + number(css.getPropertyValue(property)), 0);
  var sides = (prefix, which, suffix = "") => which.map((side) => `${prefix}-${side}${suffix}`);
  function outerWidth(element) {
    const css = getComputedStyle(element);
    return element.getBoundingClientRect().width + number(css.marginLeft) + number(css.marginRight);
  }
  function contentWidth(element) {
    const css = getComputedStyle(element);
    return element.clientWidth - number(css.paddingLeft) - number(css.paddingRight);
  }
  var rendered = (element) => element.getClientRects().length > 0;
  var inFlow = (element) => getComputedStyle(element).position !== "absolute";
  function occupiedWidth(element) {
    const css = getComputedStyle(element);
    const children = [...element.children].filter((child) => rendered(child) && inFlow(child));
    if (number(css.flexGrow) > 0) {
      const chrome = number(css.paddingLeft) + number(css.paddingRight) + number(css.marginLeft) + number(css.marginRight);
      if (!children.length) return Math.min(outerWidth(element), chrome);
      if (css.display.includes("flex") && css.flexDirection.startsWith("row")) {
        const content = children.reduce((width, child) => width + outerWidth(child), 0);
        return Math.min(outerWidth(element), content + chrome + number(css.columnGap) * (children.length - 1));
      }
    }
    return outerWidth(element);
  }
  var isFocusable = (element) => element instanceof HTMLElement;
  var isButton = (element) => element instanceof HTMLButtonElement;
  var isDisabled = (element) => isButton(element) && element.disabled;
  function paginate(heights, gap, budget) {
    const pages = [[]];
    let used = 0;
    heights.forEach((height, index) => {
      let current = pages[pages.length - 1] ?? [];
      if (current.length && used + gap + height > budget) {
        current = [];
        pages.push(current);
        used = 0;
      }
      used += (current.length ? gap : 0) + height;
      current.push(index);
    });
    return pages;
  }
  var CSS = `
                .je-header-actions-row, .je-header-actions-host { flex-wrap: nowrap !important; }
                .je-header-actions-host { min-width: 0; }
                .je-header-buttons-tray { display: flex; align-items: center; flex: 0 0 auto; position: relative; }
                .je-header-buttons-tray > #randomItemButtonContainer,
                .je-header-buttons-tray > #je-native-tabs-group { display: contents !important; }
                .je-header-buttons-tray #je-native-tabs-separator { display: none !important; }
                .je-header-buttons-tray .headerButton { flex-shrink: 0; }
                #je-header-buttons-group .headerButton[hidden] { display: none !important; }
                .je-header-actions-host > .je-header-overflowed,
                .je-header-buttons-tray .je-header-overflowed,
                .je-header-buttons-tray:not([data-ready]) .headerButton {
                    position: absolute !important; visibility: hidden !important;
                    pointer-events: none !important; inset-inline-start: 0; top: 0;
                }
                .je-launcher-tight .headerLeft .pageTitle { display: none !important; }
                .je-header-launcher > .material-icons { font-size: 24px; width: 24px; height: 24px; }
                .je-header-launcher[aria-expanded="true"] { background: rgba(128,128,128,.2); }
                .je-launcher-panel {
                    position: fixed !important; margin: 0 !important; padding: 12px !important;
                    box-sizing: border-box; max-width: none !important; max-height: none !important;
                    min-width: 0 !important; border: 1px solid rgba(128,128,128,.25); border-radius: 8px;
                    background: var(--je-launcher-surface, var(--jf-palette-background-paper, #292929));
                    color: var(--je-launcher-text, var(--jf-palette-text-primary, #fff));
                    box-shadow: 0 8px 32px rgba(0,0,0,.45); transform: none !important;
                    overflow: visible !important; opacity: 1 !important;
                }
                .je-launcher-panel:not([open]) { display: none !important; }
                .je-launcher-panel[open] { display: block !important; }
                .je-launcher-panel::backdrop { background: rgba(0,0,0,.35); }
                .je-launcher-heading { display: flex; align-items: center; justify-content: space-between; min-height: 40px; }
                .je-launcher-heading h2 { font-size: 1rem; font-weight: 500; margin: 0 4px; }
                .je-launcher-close { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; flex-shrink: 0; padding: 0; }
                .je-launcher-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0; }
                .je-launcher-action.emby-button {
                    display: flex; align-items: center; justify-content: flex-start;
                    gap: 16px; min-height: 48px; min-width: 0; box-sizing: border-box; margin: 0; padding: 6px 12px;
                    border: 0; border-radius: 4px; color: inherit; background: transparent;
                    text-transform: none; font: inherit; cursor: pointer;
                }
                .je-launcher-action.emby-button:hover { background: rgba(128,128,128,.25); }
                .je-launcher-action:disabled { opacity: .45; cursor: default; }
                .je-launcher-panel button:focus-visible { outline: 2px solid currentColor; outline-offset: -2px; }
                .je-launcher-action[hidden], .je-launcher-pager[hidden] { display: none !important; }
                .je-launcher-icon { display: inline-flex; align-items: center; justify-content: center; min-height: 24px; flex-shrink: 0; }
                .je-launcher-icon .material-icons, .je-launcher-icon svg { font-size: 24px; width: 24px; height: 24px; }
                .je-launcher-icon .je-as-sup { margin-inline-start: 4px; font-size: .7em; }
                .je-launcher-label { font-size: .875rem; line-height: 1.2; text-align: start; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
                .je-launcher-pager { display: flex; align-items: center; justify-content: space-between; height: 36px; margin-top: 8px; }
                .je-launcher-pager button { display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 36px; padding: 0; }
                .je-launcher-pager [role="status"] { font-size: .8rem; }
            `;
  function createHeaderActions(JE2) {
    let tray = null;
    let header = null;
    let row = null;
    let ui = null;
    let frame = 0;
    let started = false;
    let pageIndex = 0;
    let compactMode = false;
    let overflowNative = [];
    const mirrors = /* @__PURE__ */ new Map();
    const observed = /* @__PURE__ */ new Set();
    const resizeObserver = new ResizeObserver(schedule);
    const sourceObserver = new MutationObserver((records) => {
      if (records.some((record) => record.target !== ui?.launcher)) schedule();
    });
    function schedule() {
      if (!frame) frame = requestAnimationFrame(update);
    }
    function onBodyMutation(records) {
      const currentRow = row;
      if (!tray?.isConnected || !currentRow?.isConnected || records.some((record) => currentRow.contains(record.target) || [...record.addedNodes].some((node) => node instanceof Element && (node.matches(".headerRight, .MuiToolbar-root") || !!node.querySelector(".headerRight, .MuiToolbar-root"))))) schedule();
    }
    function availableWidth(currentRow, currentHeader, excludedNative = []) {
      let available = contentWidth(currentRow);
      const path = [];
      for (let element = currentHeader; element && element !== currentRow; element = element.parentElement) path.unshift(element);
      let parent = currentRow;
      for (const element of path) {
        const siblings = [...parent.children].filter((child) => child !== element && inFlow(child) && rendered(child));
        available -= siblings.reduce((width, sibling) => width + occupiedWidth(sibling), 0);
        available -= number(getComputedStyle(parent).columnGap) * siblings.length;
        const css = getComputedStyle(element);
        available -= number(css.paddingLeft) + number(css.paddingRight);
        parent = element;
      }
      const native = [...currentHeader.children].filter((child) => child instanceof HTMLElement && child !== tray && !excludedNative.includes(child) && (inFlow(child) || overflowNative.includes(child)) && rendered(child));
      available -= native.reduce((width, child) => width + outerWidth(child), 0);
      available -= number(getComputedStyle(currentHeader).columnGap) * native.length;
      return Math.max(0, available - 2);
    }
    function label(key, fallback) {
      const value = JE2.t(key);
      return value && value !== key ? value : fallback;
    }
    function orderSources(currentTray) {
      const rank = (element) => element.id === "je-native-tabs-group" ? 0 : element.id === "randomItemButtonContainer" ? 1 : element === ui?.launcher ? 3 : 2;
      const children = [...currentTray.children].sort((a, b) => rank(a) - rank(b));
      let anchor = null;
      for (const child of children.reverse()) {
        if (child.nextSibling !== anchor) currentTray.insertBefore(child, anchor);
        anchor = child;
      }
    }
    function updateLabels(view) {
      const setAttr = (element, name, value) => {
        if (element.getAttribute(name) !== value) element.setAttribute(name, value);
      };
      const title = label("header_more_actions", "More from Jellyfin Enhanced");
      if (view.launcher.title !== title) view.launcher.title = title;
      setAttr(view.launcher, "aria-label", title);
      const text = label("header_more_title", "More from JE");
      if (view.heading.textContent !== text) view.heading.textContent = text;
      setAttr(view.close, "aria-label", label("awards_close", "Close"));
      setAttr(view.previous, "aria-label", label("header_previous_page", "Previous page"));
      setAttr(view.next, "aria-label", label("header_next_page", "Next page"));
    }
    function closeLauncher() {
      ui?.launcher.setAttribute("aria-expanded", "false");
      if (ui?.panel.open) ui.panel.close();
    }
    function changePage(view, delta) {
      pageIndex += delta;
      layoutPanel();
      [...view.grid.children].find((button) => isButton(button) && !button.hidden && !button.disabled)?.focus();
    }
    function layoutPanel() {
      const view = ui;
      if (!view?.panel.open) return;
      const { panel, grid, pager, launcher } = view;
      const viewport = window.visualViewport;
      const viewportWidth = viewport?.width || window.innerWidth;
      const viewportHeight = viewport?.height || window.innerHeight;
      const offsetLeft = viewport?.offsetLeft || 0;
      const offsetTop = viewport?.offsetTop || 0;
      const width = Math.min(viewportWidth - 24, 320);
      const anchor = launcher.getBoundingClientRect();
      const edge = getComputedStyle(launcher).direction === "rtl" ? anchor.left : anchor.right - width;
      const left = Math.max(offsetLeft + 12, Math.min(edge, offsetLeft + viewportWidth - width - 12));
      panel.style.left = left + "px";
      panel.style.width = width + "px";
      const focused = document.activeElement;
      const buttons = [...grid.children].filter(isButton);
      buttons.forEach((button) => {
        button.hidden = false;
      });
      pager.hidden = false;
      const panelCSS = getComputedStyle(panel);
      const chrome = sum(panelCSS, [...sides("padding", ["top", "bottom"]), ...sides("border", ["top", "bottom"], "-width")]) + view.headingBlock.getBoundingClientRect().height;
      const pagerHeight = pager.getBoundingClientRect().height + number(getComputedStyle(pager).marginTop);
      const gap = number(getComputedStyle(grid).rowGap);
      const heights = buttons.map((button) => button.getBoundingClientRect().height);
      const minimumHeight = chrome + pagerHeight + Math.max(48, ...heights);
      const top = Math.max(offsetTop + 12, Math.min(anchor.bottom + 8, offsetTop + viewportHeight - minimumHeight - 12));
      panel.style.top = top + "px";
      const available = offsetTop + viewportHeight - top - 12 - chrome;
      const totalHeight = heights.reduce((total, height) => total + height, 0) + gap * Math.max(0, buttons.length - 1);
      const paged = totalHeight > available;
      const pages = paginate(heights, gap, available - (paged ? pagerHeight : 0));
      pageIndex = Math.max(0, Math.min(pageIndex, pages.length - 1));
      const visible = new Set(pages[pageIndex] ?? []);
      buttons.forEach((button, index) => {
        button.hidden = !visible.has(index);
      });
      pager.hidden = pages.length === 1;
      view.previous.disabled = pageIndex === 0;
      view.next.disabled = pageIndex === pages.length - 1;
      const text = `${pageIndex + 1} / ${pages.length}`;
      if (view.status.textContent !== text) view.status.textContent = text;
      if (isFocusable(focused) && focused.parentElement === grid && focused.hidden || focused && pager.contains(focused) && (pager.hidden || isDisabled(focused))) {
        (buttons.find((button) => !button.hidden && !button.disabled) || view.close).focus();
      }
    }
    function createLauncher(currentTray) {
      const launcher = document.createElement("button");
      launcher.type = "button";
      launcher.id = "je-header-launcher";
      launcher.className = "headerButton headerButtonRight paper-icon-button-light je-header-launcher";
      launcher.setAttribute("is", "paper-icon-button-light");
      launcher.setAttribute("aria-haspopup", "dialog");
      launcher.setAttribute("aria-controls", "je-header-launcher-panel");
      launcher.setAttribute("aria-expanded", "false");
      launcher.innerHTML = '<span class="material-icons" aria-hidden="true">more_horiz</span>';
      currentTray.appendChild(launcher);
      const panel = document.createElement("dialog");
      panel.id = "je-header-launcher-panel";
      panel.className = "dialog je-launcher-panel";
      panel.setAttribute("aria-labelledby", "je-launcher-title");
      panel.innerHTML = `
            <div class="je-launcher-heading">
                <h2 id="je-launcher-title"></h2>
                <button type="button" class="paper-icon-button-light je-launcher-close" autofocus><span class="material-icons" aria-hidden="true">close</span></button>
            </div>
            <div class="je-launcher-grid"></div>
            <div class="je-launcher-pager" hidden>
                <button type="button" class="paper-icon-button-light" data-previous><span class="material-icons" aria-hidden="true">chevron_left</span></button>
                <span role="status" aria-live="polite"></span>
                <button type="button" class="paper-icon-button-light" data-next><span class="material-icons" aria-hidden="true">chevron_right</span></button>
            </div>`;
      const pick = (selector, guard) => {
        const element = panel.querySelector(selector);
        if (!guard(element)) throw new Error(`Header launcher template is missing ${selector}`);
        return element;
      };
      const html = (element) => element instanceof HTMLElement;
      const view = {
        launcher,
        panel,
        grid: pick(".je-launcher-grid", html),
        pager: pick(".je-launcher-pager", html),
        heading: pick("h2", html),
        headingBlock: pick(".je-launcher-heading", html),
        close: pick(".je-launcher-close", isButton),
        previous: pick("[data-previous]", isButton),
        next: pick("[data-next]", isButton),
        status: pick('[role="status"]', html)
      };
      updateLabels(view);
      document.body.appendChild(panel);
      view.close.addEventListener("click", closeLauncher);
      view.previous.addEventListener("click", () => changePage(view, -1));
      view.next.addEventListener("click", () => changePage(view, 1));
      panel.addEventListener("close", () => launcher.setAttribute("aria-expanded", "false"));
      panel.addEventListener("click", (event) => {
        if (event.target !== panel) return;
        const rect = panel.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeLauncher();
      });
      view.grid.addEventListener("keydown", (event) => {
        const buttons = [...view.grid.children].filter((button) => isButton(button) && !button.hidden && !button.disabled);
        const active = document.activeElement;
        const index = isButton(active) ? buttons.indexOf(active) : -1;
        if (index < 0) return;
        const rtl = getComputedStyle(view.grid).direction === "rtl";
        const steps = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1, ArrowDown: 1, ArrowUp: -1 };
        let next;
        const step = steps[event.key];
        if (event.key === "Home") next = 0;
        else if (event.key === "End") next = buttons.length - 1;
        else if (step !== void 0) next = Math.max(0, Math.min(buttons.length - 1, index + step));
        else return;
        event.preventDefault();
        event.stopPropagation();
        buttons[next]?.focus();
      });
      launcher.addEventListener("click", () => {
        if (panel.open) {
          closeLauncher();
          return;
        }
        pageIndex = 0;
        const paper = document.querySelector(".MuiDrawer-paper");
        if (paper) {
          const theme = getComputedStyle(paper);
          panel.style.setProperty("--je-launcher-surface", theme.backgroundColor);
          panel.style.setProperty("--je-launcher-text", theme.color);
        }
        panel.showModal();
        launcher.setAttribute("aria-expanded", "true");
        layoutPanel();
      });
      return view;
    }
    function updateMirror(source) {
      let button = mirrors.get(source);
      if (!button) {
        const created = document.createElement("button");
        created.type = "button";
        created.className = "emby-button je-launcher-action";
        created.dataset.jeHeaderAction = source.id;
        created.innerHTML = '<span class="je-launcher-icon" aria-hidden="true"></span><span class="je-launcher-label"></span>';
        created.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (isDisabled(source) || !source.isConnected) return;
          closeLauncher();
          source.click();
        });
        mirrors.set(source, created);
        button = created;
      }
      const text = source.dataset.headerLabel || source.title || source.getAttribute("aria-label") || "";
      const labelElement = button.querySelector(".je-launcher-label");
      if (labelElement && labelElement.textContent !== text) labelElement.textContent = text;
      if (button.title !== source.title) button.title = source.title;
      button.disabled = isDisabled(source);
      const icon = button.querySelector(".je-launcher-icon");
      if (icon && icon.dataset.sourceMarkup !== source.innerHTML) {
        icon.dataset.sourceMarkup = source.innerHTML;
        icon.replaceChildren(...[...source.childNodes].map((child) => child.cloneNode(true)));
        icon.querySelectorAll("[id]").forEach((element) => element.removeAttribute("id"));
      }
      return button;
    }
    function attachTray(currentTray, current) {
      if (current === header && currentTray.isConnected) return;
      closeLauncher();
      header?.classList.remove("je-header-actions-host");
      row?.classList.remove("je-header-actions-row", "je-launcher-tight");
      header = current;
      row = current.closest(".MuiToolbar-root, .headerTop") || current.parentElement;
      current.classList.add("je-header-actions-host");
      row?.classList.add("je-header-actions-row");
      current.prepend(currentTray);
      document.querySelectorAll("[data-je-header-fallback]").forEach((stale) => {
        if (stale !== current && !stale.children.length) stale.remove();
      });
      schedule();
    }
    function borrowableNative(source, previousNative) {
      if (!(source instanceof HTMLElement) || !source.matches("a[href]:not([aria-haspopup]):not([aria-controls])")) return false;
      const href = (source.getAttribute("href") ?? "").trim();
      return !!href && href !== "#" && !/^javascript:/i.test(href) && !source.hidden && rendered(source) && getComputedStyle(source).display !== "none" && (inFlow(source) || previousNative.includes(source)) && (source.getAttribute("aria-hidden") !== "true" || previousNative.includes(source));
    }
    function update() {
      frame = 0;
      const currentTray = tray;
      const view = ui;
      if (!currentTray || !view || !JE2.session.getUserId()) return;
      const current = JE2.helpers.getHeaderRightContainer();
      if (!current) {
        closeLauncher();
        return;
      }
      attachTray(currentTray, current);
      const currentRow = row;
      const currentHeader = header;
      if (!currentRow || !currentHeader || !currentRow.getClientRects().length) {
        closeLauncher();
        return;
      }
      const { launcher, panel, grid, close } = view;
      orderSources(currentTray);
      updateLabels(view);
      const sources = [...currentTray.querySelectorAll(SOURCE_SELECTOR)];
      const visibleSources = sources.filter((source) => !source.hidden && rendered(source) && getComputedStyle(source).display !== "none");
      const previousNative = overflowNative;
      const trayCSS = getComputedStyle(currentTray);
      const gap = number(trayCSS.columnGap);
      const nativeGap = number(getComputedStyle(currentHeader).columnGap);
      const chrome = sum(trayCSS, [...sides("margin", ["left", "right"]), ...sides("padding", ["left", "right"]), ...sides("border", ["left", "right"], "-width")]);
      if (currentRow.classList.contains("je-launcher-tight")) currentRow.classList.remove("je-launcher-tight");
      let available = Math.max(0, availableWidth(currentRow, currentHeader) - chrome);
      let fullWidth = visibleSources.reduce((width, source) => width + outerWidth(source), 0) + gap * Math.max(0, visibleSources.length - 1);
      launcher.style.setProperty("display", "inline-flex", "important");
      const moreWidth = outerWidth(launcher);
      if (visibleSources.length && fullWidth > available && available < moreWidth) {
        currentRow.classList.add("je-launcher-tight");
        available = Math.max(0, availableWidth(currentRow, currentHeader) - chrome);
      }
      overflowNative = available < moreWidth && visibleSources.length && currentHeader.matches(".MuiBox-root") ? [...currentHeader.children].filter((source) => borrowableNative(source, previousNative)) : [];
      if (overflowNative.length) {
        available = Math.max(0, availableWidth(currentRow, currentHeader, overflowNative) - chrome);
        fullWidth += overflowNative.reduce((width, source) => width + outerWidth(source), 0) + nativeGap * overflowNative.length;
        visibleSources.unshift(...overflowNative);
        sources.push(...overflowNative);
      }
      for (const source of previousNative) {
        if (!overflowNative.includes(source)) {
          source.classList.remove("je-header-overflowed");
          source.removeAttribute("aria-hidden");
        }
      }
      const expansionSpace = compactMode ? 8 : 0;
      const collapsed = visibleSources.length > 0 && fullWidth + expansionSpace > available;
      const pinned = ["randomItemButton", "je-active-streams"].map((id) => visibleSources.find((source) => source.id === id)).filter((source) => !!source);
      const inline = /* @__PURE__ */ new Set();
      if (collapsed) {
        let remaining = Math.max(0, available - moreWidth);
        const priority = [
          ...overflowNative,
          ...pinned,
          ...visibleSources.filter((source) => !pinned.includes(source) && !overflowNative.includes(source))
        ];
        for (const source of priority) {
          const width = outerWidth(source);
          const sourceGap = overflowNative.includes(source) ? nativeGap : gap;
          const margin = source.classList.contains("je-header-overflowed") ? 8 : 0;
          if (width + sourceGap + margin > remaining) break;
          inline.add(source);
          remaining -= width + sourceGap;
        }
      } else {
        visibleSources.forEach((source) => inline.add(source));
      }
      compactMode = collapsed;
      const display = collapsed ? "inline-flex" : "none";
      if (launcher.style.display !== display) launcher.style.setProperty("display", display, "important");
      const overflowSources = visibleSources.filter((source) => !inline.has(source));
      for (const source of sources) {
        const overflowed = collapsed && !inline.has(source);
        if (overflowed && document.activeElement && source.contains(document.activeElement)) launcher.focus();
        if (source.classList.contains("je-header-overflowed") !== overflowed) source.classList.toggle("je-header-overflowed", overflowed);
        if (overflowed && source.getAttribute("aria-hidden") !== "true") source.setAttribute("aria-hidden", "true");
        else if (!overflowed && source.hasAttribute("aria-hidden")) source.removeAttribute("aria-hidden");
      }
      if (!currentTray.dataset.ready) currentTray.dataset.ready = "true";
      if (!collapsed) {
        const focused = document.activeElement;
        const target = [...mirrors].find(([, button]) => button === focused)?.[0] || visibleSources[0];
        const restoreFocus = panel.open || focused === launcher;
        closeLauncher();
        if (restoreFocus) (target || currentHeader.querySelector(":scope > button, :scope > a"))?.focus();
      }
      const included = new Set(overflowSources);
      for (const [source, button] of mirrors) {
        if (!included.has(source)) {
          if (button === document.activeElement) close.focus();
          button.remove();
          mirrors.delete(source);
        }
      }
      let anchor = null;
      for (const source of [...overflowSources].reverse()) {
        const button = updateMirror(source);
        if (button.parentElement !== grid || button.nextSibling !== anchor) grid.insertBefore(button, anchor);
        anchor = button;
      }
      if (panel.open) layoutPanel();
      const nextObserved = /* @__PURE__ */ new Set([
        currentRow,
        currentHeader,
        ...currentRow.children,
        ...[...currentRow.children].flatMap((child) => [...child.children]),
        ...currentHeader.children,
        ...sources
      ]);
      for (const element of observed) {
        if (!nextObserved.has(element)) {
          resizeObserver.unobserve(element);
          observed.delete(element);
        }
      }
      for (const element of nextObserved) {
        if (!observed.has(element)) {
          resizeObserver.observe(element);
          observed.add(element);
        }
      }
    }
    function getTray() {
      if (!JE2.session.getUserId()) return null;
      const current = JE2.helpers.getHeaderRightContainer();
      if (!current) return null;
      let currentTray = tray;
      if (!currentTray) {
        currentTray = document.createElement("div");
        currentTray.id = "je-header-buttons-group";
        currentTray.className = "je-header-buttons-tray";
        tray = currentTray;
        ui = createLauncher(currentTray);
      }
      if (!started) {
        started = true;
        JE2.helpers.addCSS("je-header-actions-css", CSS);
        JE2.helpers.onBodyMutation("je-header-actions", onBodyMutation);
        sourceObserver.observe(currentTray, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ["title", "aria-label", "data-header-label", "disabled", "hidden", "style"]
        });
        window.addEventListener("resize", schedule);
        window.visualViewport?.addEventListener("resize", schedule);
        window.visualViewport?.addEventListener("scroll", layoutPanel);
        window.addEventListener("hashchange", closeLauncher);
        document.fonts?.addEventListener("loadingdone", schedule);
      }
      attachTray(currentTray, current);
      return currentTray;
    }
    function resetForIdentity() {
      closeLauncher();
      for (const source of overflowNative) {
        source.classList.remove("je-header-overflowed");
        source.removeAttribute("aria-hidden");
      }
      overflowNative = [];
      mirrors.forEach((button) => button.remove());
      mirrors.clear();
      if (tray && ui) tray.replaceChildren(ui.launcher);
      tray?.remove();
      header?.classList.remove("je-header-actions-host");
      row?.classList.remove("je-header-actions-row", "je-launcher-tight");
      header = row = null;
      compactMode = false;
      resizeObserver.disconnect();
      observed.clear();
    }
    return { getTray, resetForIdentity };
  }

  // client/src/features/chrome/header-actions-entry.ts
  var JE = chromeBridge();
  var actions = createHeaderActions(JE);
  JE.session.onUserChange("header-actions", actions.resetForIdentity);
  chromeContext(JE, ["headerActions"]).own.headerActions = { getTray: actions.getTray };
})();
})();
//# sourceMappingURL=header-actions.js.map
