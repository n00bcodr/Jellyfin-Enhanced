(() => {
"use strict";
(() => {
  var __typeError = (msg) => {
    throw TypeError(msg);
  };
  var __accessCheck = (obj, member, msg) => member.has(obj) || __typeError("Cannot " + msg);
  var __privateGet = (obj, member, getter) => (__accessCheck(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
  var __privateAdd = (obj, member, value) => member.has(obj) ? __typeError("Cannot add the same private member more than once") : member instanceof WeakSet ? member.add(obj) : member.set(obj, value);

  // client/src/host/admin-config-host.ts
  function globals() {
    return window;
  }
  function engine() {
    return globals().JEAdmin;
  }
  function publishEngine(value) {
    window.JEAdmin = value;
  }

  // client/src/admin/config/engine/schema.ts
  var NON_FIELD = ["note", "html", "button", "custom", "group"];
  function isField(item) {
    return !NON_FIELD.includes(item.type);
  }
  var MIRROR = "--mirror";

  // client/src/admin/config/engine/render.ts
  var ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  var esc = (value) => String(value).replace(/[&<>"]/g, (c) => ENTITIES[c] ?? c);
  var mirrorCondition = (c) => typeof c === "string" ? c + MIRROR : { ...c, id: c.id + MIRROR };
  var mirrorMarkup = (html) => html.replace(/\b(id|for)="([^"]+)"/g, (_match, key, value) => key + '="' + value + MIRROR + '"');
  function mirrorItem(item) {
    const copy = { ...item };
    if (copy.type === "group") copy.items = copy.items.map(mirrorItem);
    if (copy.id) copy.id += MIRROR;
    if (isField(copy) && copy.id) {
      copy.manual = true;
      delete copy.prop;
      delete copy.toConfig;
      delete copy.fromConfig;
      delete copy.perUser;
    }
    if (copy.showIf) copy.showIf = mirrorCondition(copy.showIf);
    if (copy.type === "note" || copy.type === "html" || copy.type === "custom") copy.html = mirrorMarkup(copy.html);
    if (copy.type === "custom") delete copy.init;
    return copy;
  }
  function itemsOf(section, sections) {
    if (section.mirrorOf !== void 0) {
      const source = sections[section.mirrorOf];
      return (source?.items ?? source?.fields ?? []).map(mirrorItem);
    }
    return section.items ?? section.fields ?? [];
  }
  var flat = (items) => items.flatMap((item) => item.type === "group" ? flat(item.items) : [item]);
  function fieldsOf(section, sections) {
    return flat(itemsOf(section, sections)).filter((item) => !!item.id && isField(item));
  }
  function allFields(sections) {
    return Object.values(sections).flatMap((section) => fieldsOf(section, sections));
  }
  function boundFields(sections) {
    return allFields(sections).filter((field) => !!field.prop && !field.manual);
  }
  var attributes = (values) => Object.entries(values ?? {}).map(([key, value]) => ` ${key}="${esc(value)}"`).join("");
  function propOf(field) {
    return field.prop || (field.id ? field.id[0]?.toUpperCase() + field.id.slice(1) : "");
  }
  function isPerUser(field, perUserProps) {
    return field.perUser === true || field.perUser !== false && perUserProps.has(propOf(field));
  }
  var BADGE = '<i class="material-icons jea-badge" aria-label="Per-user setting" title="Each user has a personal copy. Existing users keep theirs until you overwrite it.">group</i>';
  function breakLines(html) {
    if (!html || html.length < 140 || /<(br|ul|li|p)\b/i.test(html)) return html;
    return html.replace(/([.!?])\s+(?=[A-Z])/g, (match, end, offset, text) => /(e\.g|i\.e|etc|vs|cf)\.$/i.test(text.slice(Math.max(0, offset - 5), offset + 1)) ? match : end + "<br>");
  }
  function descriptionHtml(field) {
    return field.desc ? `<div class="je-setting-description" data-desc-for="${field.id}"${attributes(field.descAttrs)}><div class="fieldDescription${field.descClass ? " " + field.descClass : ""}">${breakLines(field.desc)}</div></div>` : "";
  }
  function optionsHtml(options) {
    return options.map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join("");
  }
  function fieldHtml(field, perUserProps) {
    const desc = descriptionHtml(field);
    const label = field.label ?? "";
    const perUser = isPerUser(field, perUserProps);
    if (field.type === "toggle") {
      return `<div class="checkboxContainer jea-row${field.main ? " je-main-feature" : ""}${field.rowClass ? " " + field.rowClass : ""}"${attributes(field.rowAttrs)}><label class="jea-toggle"><input id="${field.id}" type="checkbox" class="jea-switch"${attributes(field.attrs)}/><span>${esc(label)}</span>${perUser ? BADGE : ""}</label></div>${desc}`;
    }
    if (field.type === "position") {
      const cells = ["top-left", "top-right", "bottom-left", "bottom-right"].map((p) => `<button type="button" class="jea-pos-cell" data-pos="${p}" title="${p.replace("-", " ")}" aria-label="${p.replace("-", " ")}"></button>`).join("");
      return `<div class="checkboxContainer jea-row jea-pos-row${field.rowClass ? " " + field.rowClass : ""}"${attributes(field.rowAttrs)}><label class="jea-pos-label" for="${field.id}">${esc(label || "Position")}</label><div class="jea-pos" role="group" aria-label="${esc(label || "Position")}" data-for="${field.id}">${cells}</div><select id="${field.id}" name="${field.id}" hidden${attributes(field.attrs)}>${optionsHtml(field.options)}</select></div>${desc}`;
    }
    const labelHtml = `<label class="inputLabel" for="${field.id}">${esc(label)}${perUser ? BADGE : ""}</label>`;
    let control;
    if (field.type === "select") {
      control = `<select id="${field.id}" name="${field.id}" class="jea-input"${attributes(field.attrs)}>${optionsHtml(field.options)}</select>`;
    } else if (field.type === "textarea") {
      control = `<textarea id="${field.id}" name="${field.id}" class="jea-input"${attributes(field.attrs)} rows="${field.rows || 3}" placeholder="${esc(field.placeholder || "")}"></textarea>`;
    } else if (field.type === "number") {
      control = `<input id="${field.id}" name="${field.id}" type="number" class="jea-input"${attributes(field.attrs)} ${field.min !== void 0 ? `min="${field.min}"` : ""} ${field.max !== void 0 ? `max="${field.max}"` : ""} ${field.step !== void 0 ? `step="${field.step}"` : ""} placeholder="${esc(field.placeholder || "")}"/>`;
    } else {
      control = `<input id="${field.id}" name="${field.id}" type="${field.type === "password" ? "password" : "text"}" class="jea-input"${attributes(field.attrs)} autocomplete="off" placeholder="${esc(field.placeholder || "")}"/>`;
    }
    const inline = field.type === "number" || field.type === "select";
    return `<div class="inputContainer jea-row${inline ? " jea-inline" : ""}${field.rowClass ? " " + field.rowClass : ""}"${attributes(field.rowAttrs)}>${labelHtml}${control}</div>${desc}`;
  }
  function showIfWrapper(item, html) {
    const condition = item.showIf;
    if (condition === void 0) return html;
    const id = typeof condition === "string" ? condition : condition.id;
    const equals = typeof condition === "string" ? void 0 : condition.equals;
    return `<div data-jea-showif="${esc(id)}"${equals !== void 0 ? ` data-jea-equals="${esc(equals)}"` : ""}>${html}</div>`;
  }
  function sectionLook(source) {
    const { attrs, icon, iconImg } = source;
    return { ...attrs ? { attrs } : {}, ...icon ? { icon } : {}, ...iconImg ? { iconImg } : {} };
  }
  function markupHtml(item, state) {
    switch (item.type) {
      case "note":
        return `<div class="jea-note jea-note-${item.tone || "info"}">${item.html}</div>`;
      case "html":
        return item.html;
      case "custom":
        if (item.init) state.inits.push(item.init);
        return item.html;
      case "button":
        return `<div class="jea-actions"><button type="button" id="${item.id}" class="jea-btn${item.variant ? " jea-btn-" + item.variant : ""}">${esc(item.label)}</button>${item.hint ? `<span class="jea-hint">${item.hint}</span>` : ""}</div>`;
      case "group":
        return `<details class="jea-group"${item.open ? " open" : ""}><summary>${esc(item.title)}</summary><div class="jea-group-body">${item.items.map((child) => itemHtml(child, state)).join("")}</div></details>`;
    }
  }
  function itemHtml(item, state) {
    return isField(item) ? fieldHtml(item, state.perUserProps) : showIfWrapper(item, markupHtml(item, state));
  }
  function sectionHtml(input, sections, state) {
    const source = input.mirrorOf !== void 0 ? sections[input.mirrorOf] : void 0;
    const section = source ? { title: source.title ?? "", ...sectionLook(source), items: itemsOf(input, sections), class: ((source.class || "") + " jea-mirror").trim() } : input;
    const icon = section.iconImg ? `<img class="je-legend-icon-img" data-je-cdn="${esc(section.iconImg)}" alt="">` : section.icon ? `<i class="material-icons je-legend-icon" aria-hidden="true">${section.icon}</i>` : "";
    const items = itemsOf(section, sections);
    const mainIndex = items.findIndex((item) => isField(item) && item.main);
    const top = mainIndex < 0 ? [] : items.slice(0, mainIndex + 1);
    const rest = mainIndex < 0 ? items : items.slice(mainIndex + 1);
    const body = top.map((item) => itemHtml(item, state)).join("") + (rest.length ? `<div class="jea-sub">${rest.map((item) => itemHtml(item, state)).join("")}</div>` : "");
    const banner = fieldsOf(section, sections).some((field) => isPerUser(field, state.perUserProps)) ? '<div class="jea-apply" hidden><div class="jea-apply-text"></div><span class="jea-apply-actions"><button type="button" class="jea-btn jea-btn-primary jea-apply-sel" title="Copies only the settings listed here into the personal settings of every user">Apply the above</button><button type="button" class="jea-btn jea-apply-btn" title="Copies every plugin setting that users also hold personally into every user, replacing their own values">Apply all plugin settings</button></span></div>' : "";
    return `<fieldset class="jea-section${section.class ? " " + section.class : ""}"${section.id ? ` id="${section.id}"` : ""}${attributes(section.attrs)}><legend class="sectionTitle">${icon}${esc(section.title ?? "")}</legend><div class="configSection">${body}</div>${banner}</fieldset>`;
  }

  // client/src/admin/config/engine/dialogs.ts
  function safeHtml(text) {
    return esc(text ?? "").replace(/&lt;(\/?(?:br|b|strong|em|i|code|ul|li|p))\s*\/?&gt;/gi, "<$1>").replace(/\r?\n/g, "<br>");
  }
  function dialog({ title, message, confirmLabel, cancelLabel, danger }) {
    return new Promise((resolve) => {
      const previous = document.activeElement;
      const wrap = document.createElement("div");
      wrap.className = "jea-dialog-backdrop";
      wrap.innerHTML = `<div class="jea-dialog" role="dialog" aria-modal="true" aria-label="${esc(title || "Message")}"><h3 class="jea-dialog-title">${esc(title || "")}</h3><div class="jea-dialog-body">${safeHtml(message)}</div><div class="jea-dialog-actions">${cancelLabel ? `<button type="button" class="jea-btn" data-r="0">${esc(cancelLabel)}</button>` : ""}<button type="button" class="jea-btn ${danger ? "jea-btn-danger" : "jea-btn-primary"}" data-r="1">${esc(confirmLabel || "OK")}</button></div></div>`;
      const done = (value) => {
        document.removeEventListener("keydown", onKey, true);
        wrap.remove();
        if (previous instanceof HTMLElement) previous.focus();
        resolve(value);
      };
      const onKey = (event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          done(false);
        }
      };
      wrap.addEventListener("click", (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const button = target ? target.closest("[data-r]") : null;
        if (button) done(button.dataset.r === "1");
        else if (target === wrap && !cancelLabel) done(true);
      });
      document.addEventListener("keydown", onKey, true);
      (document.getElementById("JellyfinEnhancedPage") || document.body).appendChild(wrap);
      wrap.querySelector('[data-r="1"]')?.focus();
    });
  }
  function alertBox(input) {
    const options = typeof input === "string" ? { message: input } : input ?? {};
    return dialog({ title: options.title, message: options.message || options.text }).then(() => {
      if (typeof options.callback === "function") options.callback();
    });
  }
  function confirmBox(message, title, danger) {
    return dialog({ title: title || "Please confirm", message, confirmLabel: "Confirm", cancelLabel: "Cancel", danger: !!danger });
  }

  // client/src/admin/config/engine/lifecycle.ts
  var _controller, _timers, _intervals, _frames, _observers, _cleanups;
  var MountLifecycle = class {
    constructor() {
      __privateAdd(this, _controller, new AbortController());
      __privateAdd(this, _timers, /* @__PURE__ */ new Set());
      __privateAdd(this, _intervals, /* @__PURE__ */ new Set());
      __privateAdd(this, _frames, /* @__PURE__ */ new Set());
      __privateAdd(this, _observers, /* @__PURE__ */ new Set());
      __privateAdd(this, _cleanups, /* @__PURE__ */ new Set());
    }
    get signal() {
      return __privateGet(this, _controller).signal;
    }
    get disposed() {
      return __privateGet(this, _controller).signal.aborted;
    }
    track(observer) {
      __privateGet(this, _observers).add(observer);
      if (this.disposed) observer.disconnect();
      return observer;
    }
    /** A timer that never fires after disposal. */
    timeout(callback, delay) {
      if (this.disposed) return 0;
      const id = window.setTimeout(() => {
        __privateGet(this, _timers).delete(id);
        callback();
      }, delay);
      __privateGet(this, _timers).add(id);
      return id;
    }
    interval(callback, delay) {
      if (this.disposed) return 0;
      const id = window.setInterval(callback, delay);
      __privateGet(this, _intervals).add(id);
      return id;
    }
    frame(callback) {
      if (this.disposed) return 0;
      const id = window.requestAnimationFrame(() => {
        __privateGet(this, _frames).delete(id);
        callback();
      });
      __privateGet(this, _frames).add(id);
      return id;
    }
    onDispose(cleanup) {
      if (this.disposed) cleanup();
      else __privateGet(this, _cleanups).add(cleanup);
    }
    dispose() {
      if (this.disposed) return;
      __privateGet(this, _controller).abort();
      __privateGet(this, _timers).forEach((id) => window.clearTimeout(id));
      __privateGet(this, _intervals).forEach((id) => window.clearInterval(id));
      __privateGet(this, _frames).forEach((id) => window.cancelAnimationFrame(id));
      __privateGet(this, _observers).forEach((observer) => observer.disconnect());
      __privateGet(this, _cleanups).forEach((cleanup) => cleanup());
      __privateGet(this, _timers).clear();
      __privateGet(this, _intervals).clear();
      __privateGet(this, _frames).clear();
      __privateGet(this, _observers).clear();
      __privateGet(this, _cleanups).clear();
    }
  };
  _controller = new WeakMap();
  _timers = new WeakMap();
  _intervals = new WeakMap();
  _frames = new WeakMap();
  _observers = new WeakMap();
  _cleanups = new WeakMap();

  // client/src/admin/config/engine/masonry.ts
  var GAP = 20;
  var MIN_COL = 500;
  var placements = /* @__PURE__ */ new WeakMap();
  var tabColumns = /* @__PURE__ */ new WeakMap();
  function placementOf(element) {
    let placement = placements.get(element);
    if (!placement) placements.set(element, placement = {});
    return placement;
  }
  var isWide = (element) => element.tagName !== "FIELDSET" || element.matches(".je-fieldset-wide, .je-overview-section");
  var heightOf = (element) => element.getBoundingClientRect().height;
  var htmlChildren = (tab) => Array.from(tab.children).filter((c) => c instanceof HTMLElement);
  function unpack(tab) {
    if (!tab.classList.contains("jea-masonry")) return;
    tab.classList.remove("jea-masonry");
    tab.style.removeProperty("--jea-cols");
    htmlChildren(tab).forEach((element) => {
      element.style.gridColumn = "";
      element.style.gridRow = "";
    });
  }
  function layoutTab(tab, repackRequested) {
    const form = document.getElementById("JellyfinEnhancedForm");
    if (!tab.classList.contains("active") || tab.id === "docs" || tab.classList.contains("jea-focused") || form && form.classList.contains("je-search-mode")) {
      unpack(tab);
      return;
    }
    let repack = repackRequested;
    const columns = Math.max(1, Math.floor((tab.clientWidth + GAP) / (MIN_COL + GAP)));
    if (tabColumns.get(tab) !== columns) {
      repack = true;
      tabColumns.set(tab, columns);
    }
    if (!tab.classList.contains("jea-masonry")) tab.classList.add("jea-masonry");
    tab.style.setProperty("--jea-cols", String(columns));
    const items = htmlChildren(tab).filter((element) => getComputedStyle(element).display !== "none");
    if (repack) {
      items.forEach((element) => {
        element.style.gridColumn = isWide(element) ? "1 / -1" : "1";
        element.style.gridRow = "auto";
        delete placementOf(element).column;
      });
    }
    const ends = new Array(columns).fill(0);
    items.forEach((element) => {
      const height = Math.ceil(heightOf(element));
      if (isWide(element)) {
        const start = Math.max(...ends);
        element.style.gridColumn = "1 / -1";
        element.style.gridRow = start + 1 + " / span " + (height + GAP);
        ends.fill(start + height + GAP);
        return;
      }
      const placement = placementOf(element);
      if (placement.column === void 0) {
        placement.column = ends.indexOf(Math.min(...ends));
        element.style.gridColumn = String(placement.column + 1);
      }
      const column = placement.column;
      const end = ends[column] ?? 0;
      element.style.gridRow = end + 1 + " / span " + (height + GAP);
      ends[column] = end + height + GAP;
    });
  }
  function initMasonry(lifecycle) {
    const form = document.getElementById("JellyfinEnhancedForm");
    if (!form || typeof ResizeObserver === "undefined") return;
    const activeTabs = () => form.querySelectorAll(".jellyfin-tab-content.active");
    let pending = null;
    const schedule = (repack) => {
      if (pending) {
        pending.repack = pending.repack || repack;
        return;
      }
      pending = { repack };
      lifecycle.frame(() => {
        const request = pending;
        pending = null;
        activeTabs().forEach((tab) => layoutTab(tab, request?.repack ?? false));
      });
    };
    const resizes = lifecycle.track(new ResizeObserver(() => schedule(false)));
    const watch = (tab) => htmlChildren(tab).forEach((element) => {
      const placement = placementOf(element);
      if (!placement.watched) {
        placement.watched = true;
        resizes.observe(element);
      }
    });
    form.querySelectorAll(".jellyfin-tab-content").forEach((tab) => {
      watch(tab);
      let signature = tab.className.replace(/jea-masonry/g, "").trim();
      lifecycle.track(new MutationObserver(() => {
        const now = tab.className.replace(/jea-masonry/g, "").trim();
        if (now !== signature) {
          signature = now;
          layoutTab(tab, true);
        }
      })).observe(tab, { attributes: true, attributeFilter: ["class"] });
      lifecycle.track(new MutationObserver(() => {
        watch(tab);
        schedule(false);
      })).observe(tab, { childList: true });
    });
    lifecycle.track(new MutationObserver(() => activeTabs().forEach((tab) => layoutTab(tab, true)))).observe(form, { attributes: true, attributeFilter: ["class"] });
    let timer;
    window.addEventListener("resize", () => {
      window.clearTimeout(timer);
      timer = lifecycle.timeout(() => schedule(true), 120);
    }, { signal: lifecycle.signal });
    activeTabs().forEach((tab) => layoutTab(tab, true));
  }

  // client/src/admin/config/engine/mirrors.ts
  var isFormField = (element) => element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement;
  var copies = () => Array.from(document.querySelectorAll('[id$="' + MIRROR + '"]'));
  var sourceOf = (mirror) => document.getElementById(mirror.id.slice(0, -MIRROR.length));
  function copyValue(source, mirror) {
    if (mirror instanceof HTMLInputElement && mirror.type === "checkbox") {
      if (source instanceof HTMLInputElement) mirror.checked = source.checked;
    } else {
      if (source instanceof HTMLSelectElement && mirror.innerHTML !== source.innerHTML) mirror.innerHTML = source.innerHTML;
      if (mirror.value !== source.value) mirror.value = source.value;
    }
    mirror.disabled = source.disabled;
  }
  function copyLeaf(source, mirror) {
    if (mirror.children.length) return;
    mirror.className = source.className;
    mirror.style.cssText = source.style.cssText;
    const html = source.innerHTML.replace(/\sid="[^"]*"/g, "");
    if (mirror.innerHTML !== html) mirror.innerHTML = html;
  }
  function syncMirrors() {
    copies().forEach((mirror) => {
      const source = sourceOf(mirror);
      if (!source) return;
      if (isFormField(mirror)) {
        if (isFormField(source)) copyValue(source, mirror);
      } else if (mirror.tagName !== "BUTTON") {
        copyLeaf(source, mirror);
      }
    });
  }
  function wireMirrors(lifecycle) {
    const { signal } = lifecycle;
    copies().forEach((mirror) => {
      const source = sourceOf(mirror);
      if (!source) return;
      if (isFormField(mirror)) {
        if (!isFormField(source)) return;
        const toSource = (event) => {
          if (mirror instanceof HTMLInputElement && mirror.type === "checkbox") {
            if (source instanceof HTMLInputElement) source.checked = mirror.checked;
          } else {
            source.value = mirror.value;
          }
          source.dispatchEvent(new Event(event.type, { bubbles: true }));
        };
        mirror.addEventListener("input", toSource, { signal });
        mirror.addEventListener("change", toSource, { signal });
        const toMirror = () => copyValue(source, mirror);
        source.addEventListener("input", toMirror, { signal });
        source.addEventListener("change", toMirror, { signal });
      } else if (mirror.tagName === "BUTTON") {
        mirror.addEventListener("click", () => source.click(), { signal });
      } else {
        lifecycle.track(new MutationObserver(() => copyLeaf(source, mirror))).observe(source, { attributes: true, childList: true, characterData: true, subtree: true });
      }
    });
    syncMirrors();
  }

  // client/src/admin/config/engine/shell.ts
  var NAV_GROUPS = [
    ["Appearance", ["display", "media-tags", "elsewhere"]],
    ["Behaviour", ["playback", "pages", "extras", "keyboard"]],
    ["Connections", ["services", "seerr", "arr"]],
    ["Server", ["admin"]],
    ["About", ["about", "docs"]]
  ];
  var textOf = (element) => Array.from(element.childNodes).filter((node) => node.nodeType === 3).map((node) => node.textContent).join("").trim();
  function sectionTitle(fieldset) {
    const legend = fieldset.querySelector(":scope > legend");
    return legend ? textOf(legend) : "";
  }
  function showAll(tab) {
    if (!tab) return;
    const button = document.querySelector('.jellyfin-tab-button[data-tab="' + tab.id + '"]');
    if (button && button.nextElementSibling) button.nextElementSibling.querySelectorAll(".jea-nav-leaf.on").forEach((leaf) => leaf.classList.remove("on"));
    tab.classList.remove("jea-focused");
    tab.querySelectorAll(":scope > fieldset.jea-focus").forEach((fieldset) => fieldset.classList.remove("jea-focus"));
  }
  function focusCard(tab, card, group) {
    tab.classList.add("jea-focused");
    tab.querySelectorAll(":scope > fieldset").forEach((fieldset) => fieldset.classList.toggle("jea-focus", fieldset === card));
    if (group) {
      card.querySelectorAll(".jea-group").forEach((other) => {
        other.open = other === group;
      });
      group.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }
  function topGroups(card) {
    return Array.from(card.querySelectorAll(".jea-group")).filter((group) => !group.parentElement?.closest(".jea-group"));
  }
  function buildTree(bar, lifecycle) {
    const { signal } = lifecycle;
    bar.querySelectorAll(".jellyfin-tab-button").forEach((button) => {
      const tab = document.getElementById(button.dataset.tab ?? "");
      if (!tab) return;
      button.addEventListener("click", () => showAll(tab), { signal });
      const cards = Array.from(tab.querySelectorAll(":scope > fieldset")).filter((card) => sectionTitle(card));
      if (cards.length < 2) return;
      const tree = document.createElement("div");
      tree.className = "jea-nav-tree";
      const open = (action) => {
        if (button.classList.contains("active")) action();
        else {
          button.click();
          lifecycle.timeout(action, 350);
        }
      };
      const mark = (leaf, sub) => {
        tree.querySelectorAll(".jea-nav-leaf").forEach((other) => other.classList.toggle("on", other === leaf || other === sub));
      };
      cards.forEach((card) => {
        const link = document.createElement("a");
        link.href = "#";
        link.className = "jea-nav-leaf";
        link.textContent = sectionTitle(card);
        link.addEventListener("click", (event) => {
          event.preventDefault();
          open(() => {
            focusCard(tab, card);
            mark(link);
          });
        }, { signal });
        tree.appendChild(link);
        const groups = topGroups(card);
        if (groups.length >= 2) {
          const sub = document.createElement("div");
          sub.className = "jea-nav-subtree";
          groups.forEach((group) => {
            const subLink = document.createElement("a");
            subLink.href = "#";
            subLink.className = "jea-nav-leaf jea-nav-sub";
            subLink.textContent = (group.querySelector(":scope > summary")?.textContent ?? "").trim();
            subLink.addEventListener("click", (event) => {
              event.preventDefault();
              open(() => {
                focusCard(tab, card, group);
                mark(link, subLink);
              });
            }, { signal });
            sub.appendChild(subLink);
          });
          tree.appendChild(sub);
        }
      });
      button.after(tree);
    });
    const search = document.getElementById("settingsSearchInput");
    if (search instanceof HTMLInputElement) {
      search.addEventListener("input", () => {
        if (search.value) document.querySelectorAll(".jellyfin-tab-content.jea-focused").forEach(showAll);
      }, { signal });
    }
  }
  function mountShell(lifecycle) {
    const { signal } = lifecycle;
    const bar = document.querySelector(".je-tab-bar");
    const header = document.querySelector(".je-sticky-header");
    const form = document.getElementById("JellyfinEnhancedForm");
    const parent = header?.parentNode;
    if (!bar || !header || !parent || !form || document.querySelector(".jea-layout")) return;
    const layout = document.createElement("div");
    layout.className = "jea-layout";
    const nav = document.createElement("nav");
    nav.className = "jea-nav";
    nav.setAttribute("aria-label", "Settings sections");
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "jea-nav-toggle";
    toggle.setAttribute("aria-expanded", "false");
    toggle.innerHTML = '<i class="material-icons" aria-hidden="true">menu</i><span class="jea-nav-current"></span>';
    const main = document.createElement("div");
    main.className = "jea-main";
    const version = document.querySelector('script[plugin="Jellyfin Enhanced"]')?.getAttribute("version");
    const title = header.querySelector("h2.sectionTitle");
    if (version && title && !title.querySelector(".jea-ver")) {
      const chip = document.createElement("span");
      chip.className = "jea-ver";
      chip.textContent = "v" + version.split("-")[0];
      title.appendChild(chip);
    }
    parent.insertBefore(layout, header.nextSibling);
    layout.append(nav, main);
    nav.append(toggle, bar);
    while (layout.nextSibling) main.appendChild(layout.nextSibling);
    NAV_GROUPS.forEach(([name, ids]) => {
      const buttons = ids.flatMap((id) => {
        const button = bar.querySelector('[data-tab="' + id + '"]');
        return button ? [button] : [];
      });
      if (!buttons.length) return;
      const heading = document.createElement("div");
      heading.className = "jea-nav-group";
      heading.textContent = name;
      bar.appendChild(heading);
      buttons.forEach((button) => bar.appendChild(button));
    });
    const grouped = new Set(NAV_GROUPS.flatMap((group) => group[1]));
    Array.from(bar.querySelectorAll(".jellyfin-tab-button")).reverse().forEach((button) => {
      if (!grouped.has(button.dataset.tab ?? "")) bar.prepend(button);
    });
    buildTree(bar, lifecycle);
    const backdrop = document.createElement("div");
    backdrop.className = "jea-nav-backdrop";
    nav.appendChild(backdrop);
    const head = document.createElement("div");
    head.className = "jea-drawer-head";
    head.innerHTML = '<span>Settings</span><button type="button" class="jea-drawer-close" aria-label="Close menu"><i class="material-icons" aria-hidden="true">close</i></button>';
    bar.prepend(head);
    const locked = [];
    const scrollParent = () => {
      for (let node = nav.parentElement; node; node = node.parentElement) {
        const overflow = getComputedStyle(node).overflowY;
        if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) return node;
      }
      return document.scrollingElement;
    };
    const lock = (on) => {
      if (on) {
        [scrollParent(), document.documentElement, document.body].forEach((element) => {
          if (element instanceof HTMLElement && !locked.some((entry) => entry.element === element)) {
            locked.push({ element, previous: element.style.overflow });
            element.style.overflow = "hidden";
          }
        });
      } else {
        for (let entry = locked.pop(); entry; entry = locked.pop()) entry.element.style.overflow = entry.previous;
      }
    };
    const setOpen = (open) => {
      nav.classList.toggle("jea-open", open);
      toggle.setAttribute("aria-expanded", String(open));
      lock(open);
    };
    lifecycle.onDispose(() => lock(false));
    backdrop.addEventListener("click", () => setOpen(false), { signal });
    head.querySelector(".jea-drawer-close")?.addEventListener("click", () => setOpen(false), { signal });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && nav.classList.contains("jea-open")) setOpen(false);
    }, { signal });
    window.addEventListener("resize", () => {
      if (window.innerWidth > 900 && nav.classList.contains("jea-open")) setOpen(false);
    }, { signal });
    const label = () => {
      const active = bar.querySelector(".jellyfin-tab-button.active h3");
      const current = toggle.querySelector(".jea-nav-current");
      if (current) current.textContent = active ? textOf(active) : "Settings";
    };
    label();
    lifecycle.track(new MutationObserver(label)).observe(bar, { subtree: true, attributes: true, attributeFilter: ["class"] });
    toggle.addEventListener("click", () => setOpen(!nav.classList.contains("jea-open")), { signal });
    bar.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest(".jea-drawer-head")) return;
      lifecycle.timeout(() => {
        label();
        setOpen(false);
        syncMirrors();
      }, 0);
    }, { signal });
  }

  // client/src/admin/config/engine/index.ts
  function controlOf(id) {
    const element = document.getElementById(id);
    return element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement ? element : null;
  }
  function isChecked(control) {
    return control instanceof HTMLInputElement && control.checked;
  }
  function read(field) {
    const control = controlOf(field.id);
    if (!control) return void 0;
    return field.type === "toggle" ? isChecked(control) : control.value;
  }
  function conditionHolds(controlId, equals) {
    const element = controlOf(controlId);
    if (!element) return true;
    if (equals !== void 0) return element.value === equals;
    return element.type === "checkbox" ? isChecked(element) : !!element.value;
  }
  function syncCollapse() {
    document.querySelectorAll(".jea-section").forEach((section) => {
      const main = section.querySelector(".je-main-feature input");
      section.classList.toggle("jea-off", !!main && !main.checked);
    });
  }
  function syncPos() {
    document.querySelectorAll(".jea-pos").forEach((group) => {
      const select = controlOf(group.dataset.for ?? "");
      group.querySelectorAll(".jea-pos-cell").forEach((cell) => cell.classList.toggle("on", !!select && select.value === cell.dataset.pos));
    });
  }
  var conditionOf = (showIf) => typeof showIf === "string" ? { id: showIf } : showIf;
  function convert(field, value, config) {
    if (!field.toConfig) return value;
    return field.type === "select" || field.type === "position" ? field.toConfig(value, config) : field.toConfig(String(value), config);
  }
  function createEngine() {
    const sections = {};
    const perUserProps = /* @__PURE__ */ new Set();
    const base = {};
    const render = { perUserProps, inits: [] };
    const changedByBanner = /* @__PURE__ */ new WeakMap();
    let mounted = null;
    let loadSettle;
    function syncShowIf() {
      document.querySelectorAll("[data-jea-showif]").forEach((wrapper) => {
        wrapper.classList.toggle("jea-dep-hidden", !conditionHolds(wrapper.dataset.jeaShowif ?? "", wrapper.dataset.jeaEquals));
      });
      allFields(sections).forEach((field) => {
        if (!field.showIf) return;
        const condition = conditionOf(field.showIf);
        const on = conditionHolds(condition.id, condition.equals === void 0 ? void 0 : String(condition.equals));
        const control = document.getElementById(field.id);
        const row = control && control.closest(".jea-row");
        if (row) row.classList.toggle("jea-dep-hidden", !on);
        const description = document.querySelector('.je-setting-description[data-desc-for="' + field.id + '"]');
        if (description) description.classList.toggle("jea-dep-hidden", !on);
      });
    }
    function refresh() {
      syncMirrors();
      syncCollapse();
      syncPos();
      syncShowIf();
      Object.values(sections).forEach((section) => {
        const fields = fieldsOf(section, sections);
        const first = fields[0] && document.getElementById(fields[0].id);
        const box = first && first.closest("fieldset");
        const banner = box && box.querySelector(".jea-apply");
        if (!banner) return;
        const changed = fields.filter((field) => isPerUser(field, perUserProps) && base[field.id] !== void 0 && read(field) !== base[field.id]);
        banner.hidden = !changed.length;
        changedByBanner.set(banner, { props: changed.map(propOf), labels: changed.map((field) => field.label ?? "") });
        const text = banner.querySelector(".jea-apply-text");
        if (text) {
          text.innerHTML = "<strong>Save and apply the changes below to all users</strong><ul>" + changed.map((field) => "<li>" + esc(field.label) + "</li>").join("") + '</ul><span class="jea-apply-hint">Users keep their own values until you apply this.</span>';
        }
      });
    }
    function wireMount(lifecycle) {
      const { signal } = lifecycle;
      document.addEventListener("click", (event) => {
        const cell = event.target instanceof Element ? event.target.closest(".jea-pos-cell") : null;
        if (!cell || !(cell.parentElement instanceof HTMLElement)) return;
        const select = controlOf(cell.parentElement.dataset.for ?? "");
        if (!select) return;
        select.value = cell.dataset.pos ?? "";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        syncPos();
      }, { signal });
      mountShell(lifecycle);
      wireMirrors(lifecycle);
      initMasonry(lifecycle);
      document.querySelectorAll(".jea-section").forEach((section) => {
        section.addEventListener("change", refresh, { signal });
        section.addEventListener("input", refresh, { signal });
        section.querySelector(".jea-apply-btn")?.addEventListener("click", () => document.getElementById("resetAllUserSettingsBtn")?.click(), { signal });
        section.querySelector(".jea-apply-sel")?.addEventListener("click", () => {
          const banner = section.querySelector(".jea-apply");
          const changed = banner ? changedByBanner.get(banner) : void 0;
          if (changed && changed.props.length) document.dispatchEvent(new CustomEvent("jea-apply-selected", { detail: changed }));
        }, { signal });
      });
    }
    const engine2 = {
      sections,
      mountShell() {
        mountShell(new MountLifecycle());
      },
      alert: alertBox,
      confirm: confirmBox,
      dashboardShim(real) {
        const source = real ?? {};
        return {
          showLoadingMsg: () => source.showLoadingMsg?.(),
          hideLoadingMsg: () => source.hideLoadingMsg?.(),
          processPluginConfigurationUpdateResult: (result) => source.processPluginConfigurationUpdateResult?.(result),
          alert: (options) => engine2.alert(options),
          confirm: (message, title, callback) => engine2.confirm(message, title).then((accepted) => {
            if (typeof callback === "function") callback(accepted);
            return accepted;
          })
        };
      },
      // Register section definitions (called by Configuration/admin/*.js).
      define(definitions) {
        Object.assign(sections, definitions);
      },
      // Replace every <div data-je-section="key"> with its rendered fieldset. Run before the page script queries ids.
      mount(root, options) {
        (root ?? document).querySelectorAll("[data-je-section]").forEach((placeholder) => {
          const key = placeholder.getAttribute("data-je-section") ?? "";
          const section = sections[key];
          if (section) placeholder.outerHTML = sectionHtml(section, sections, render);
          else console.warn("[JE] No section definition for", key);
        });
        render.inits.splice(0).forEach((init) => init(document));
        if (options?.shell === false) return;
        mounted?.dispose();
        mounted = options?.lifecycle ?? new MountLifecycle();
        wireMount(mounted);
      },
      load(config) {
        boundFields(sections).forEach((field) => {
          const control = controlOf(field.id);
          if (!control) return;
          const raw = config[field.prop];
          const value = field.fromConfig ? field.fromConfig(raw, config) : raw;
          if (field.type === "toggle") {
            if (control instanceof HTMLInputElement) control.checked = field.default === true ? value !== false : value === true;
          } else {
            control.value = String(value === void 0 || value === null || value === "" ? field.default !== void 0 ? field.default : "" : value);
          }
          base[field.id] = read(field);
        });
        refresh();
        window.clearTimeout(loadSettle);
        loadSettle = window.setTimeout(() => {
          allFields(sections).forEach((field) => {
            if (field.manual) base[field.id] = read(field);
          });
          refresh();
        }, 0);
      },
      collect(config) {
        boundFields(sections).forEach((field) => {
          const control = controlOf(field.id);
          if (!control) return;
          if (field.type === "toggle") {
            const value = isChecked(control);
            config[field.prop] = field.toConfig ? field.toConfig(value, config) : value;
          } else if (field.type === "number") {
            const value = control.value === "" ? field.default !== void 0 ? field.default : 0 : Number(control.value);
            config[field.prop] = field.toConfig ? field.toConfig(value, config) : value;
          } else {
            const value = control.value || (field.default !== void 0 ? field.default : "");
            config[field.prop] = convert(field, value, config);
          }
        });
        return config;
      },
      // Call after the overwrite succeeds so the banners clear.
      markApplied() {
        allFields(sections).forEach((field) => {
          base[field.id] = read(field);
        });
        refresh();
      },
      setPerUser(properties) {
        properties.forEach((property) => perUserProps.add(property));
      }
    };
    return engine2;
  }

  // client/src/admin/config/engine-entry.ts
  if (!engine()) publishEngine(createEngine());
})();
})();
//# sourceMappingURL=jeAdmin.js.map
