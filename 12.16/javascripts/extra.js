/* Jellyfin Enhanced docs: small presentational helpers (no dependencies).
   Nothing here changes wording; it only adds classes and attributes for the theme.
   Runs on every page, including Material's instant navigation. */
(function () {
  "use strict";

  var each = function (list, fn) { Array.prototype.forEach.call(list, fn); };

  /* Table cells that say exactly "On" or "Off" get JE's status glyph (check / ring).
     The text stays as it is. */
  function markStates(root) {
    root.querySelectorAll(".md-typeset table:not([class]) td").forEach(function (td) {
      if (td.childElementCount !== 0) return;
      var text = td.textContent.trim();
      if (text !== "On" && text !== "Off") return;
      var mark = document.createElement("span");
      mark.className = "je-state je-state--" + text.toLowerCase();
      mark.textContent = text;
      td.textContent = "";
      td.appendChild(mark);
    });
  }

  /* On phones, simple tables (2-4 columns, one header row) become one card per row.
     The CSS switches cells to display: block, so ARIA roles keep the table semantics
     and each cell carries its column name for the visible label. */
  function stackTables(root) {
    root.querySelectorAll(".md-typeset table:not([class])").forEach(function (table) {
      if (table.dataset.jeStack) return;
      var head = table.tHead && table.tHead.rows.length === 1 && table.tHead.rows[0];
      var body = table.tBodies.length === 1 && table.tBodies[0];
      if (!head || !body || head.cells.length < 2 || head.cells.length > 4 ||
          table.querySelector("[colspan], [rowspan]")) {
        table.dataset.jeStack = "no";
        return;
      }
      var labels = [];
      each(head.cells, function (th) {
        th.setAttribute("role", "columnheader");
        labels.push(th.textContent.trim());
      });
      table.setAttribute("role", "table");
      table.tHead.setAttribute("role", "rowgroup");
      body.setAttribute("role", "rowgroup");
      // a column's values may sit beside their label only when every one of them is a short
      // one-liner ("On", "Off", "5", "Admin"), so the cards of one table line up (fitShort)
      var inline = labels.map(function (label, i) {
        return i > 0 && Array.prototype.every.call(body.rows, function (row) {
          var cell = row.cells[i];
          return !cell || (cell.textContent.trim().length <= 26 && !cell.querySelector("p, ul, ol, pre, div, table, br"));
        });
      });
      each(table.rows, function (row) { row.setAttribute("role", "row"); });
      each(body.rows, function (row) {
        each(row.cells, function (cell, i) {
          cell.setAttribute("role", "cell");
          if (labels[i]) cell.setAttribute("data-label", labels[i]);
          if (inline[i]) cell.setAttribute("data-je-short", "");
        });
      });
      table.dataset.jeStack = "stack";
      // "Setting | Default | What it does" with short defaults: shared column widths (CSS)
      if (labels.length === 3 && /^Default\b/.test(labels[1]) && shortValues(body, 1)) {
        table.dataset.jeCols = "settings";
      }
    });
  }
  /* Phones: a short column's values sit beside their label (je-cell--short) unless one of
     them would wrap under it (narrow phone, long label, long code name); then the whole column
     keeps the label above, like longer values. Hidden tables (closed details, other tabs) are
     measured when they open; everything is re-measured when the width changes. */
  var phone = window.matchMedia ? window.matchMedia("(max-width: 44.984375em)") : null;
  function fitShort(root) {
    var cells = root.querySelectorAll('.md-typeset table[data-je-stack="stack"] td[data-je-short]');
    each(cells, function (td) { td.classList.add("je-cell--short"); });
    if (!phone || !phone.matches) return;
    var wrapped = [];
    each(cells, function (td) {
      var style = getComputedStyle(td);
      var line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.6;
      if (td.getBoundingClientRect().height > line * 1.5) wrapped.push(td);
    });
    wrapped.forEach(function (td) {
      var i = td.cellIndex;
      each(td.parentNode.parentNode.rows, function (row) {
        if (row.cells[i]) row.cells[i].classList.remove("je-cell--short");
      });
    });
  }
  document.addEventListener("toggle", function (e) { if (e.target.open) fitShort(e.target); }, true);
  document.addEventListener("change", function (e) {
    // linked content tabs switch every set with the same label, so re-fit the whole page
    if (e.target.closest && e.target.closest(".tabbed-set")) {
      requestAnimationFrame(function () { fitShort(document.querySelector(".md-content") || document); });
    }
  });
  var fitWidth = window.innerWidth, fitFrame = 0;
  window.addEventListener("resize", function () {
    if (window.innerWidth === fitWidth || fitFrame) return;
    fitFrame = requestAnimationFrame(function () {
      fitFrame = 0;
      fitWidth = window.innerWidth;
      fitShort(document);
    });
  }, { passive: true });

  // every cell in the column is short ("On", "Whole library", "500 ms"): no message or path
  function shortValues(body, col) {
    return Array.prototype.every.call(body.rows, function (row) {
      var text = row.cells[col] ? row.cells[col].textContent.trim() : "";
      return text.length <= 30 && text.split(/\s+/).every(function (word) { return word.length <= 16; });
    });
  }

  /* A paragraph that is only a bold lead-in ("How to use:") becomes a small label
     above the steps that follow. */
  function markLabels(root) {
    root.querySelectorAll(".md-typeset > p, .md-typeset details > p, .md-typeset .admonition > p, .md-typeset .tabbed-block > p").forEach(function (p) {
      var strong = p.firstElementChild;
      if (!strong || strong.tagName !== "STRONG" || p.childElementCount !== 1) return;
      var text = p.textContent.trim();
      if (text === strong.textContent.trim() && /:$/.test(text) && text.length < 80) {
        p.classList.add("je-label");
      }
    });
  }

  /* Tall, narrow phone captures get a height cap so they don't fill several screens.
     Very wide, very short captures (a whole header bar) keep a readable size and scroll
     sideways inside their paragraph instead of shrinking to a sliver. */
  function sizeImage(img) {
    var w = img.naturalWidth, h = img.naturalHeight;
    if (w && h / w > 1.3 && w < 1000) img.classList.add("je-img--tall");
    var p = img.closest("p");
    if (w >= 1200 && h && w / h >= 12 && p && !p.textContent.trim() && p.querySelectorAll("img").length === 1) {
      img.classList.add("je-img--strip");
      p.classList.add("je-strip");
      scrollRow(p);
    }
  }
  function markImages(root) {
    root.querySelectorAll(".md-typeset a.glightbox img").forEach(function (img) {
      if (img.complete) sizeImage(img);
      else img.addEventListener("load", function () { sizeImage(img); }, { once: true });
    });
  }

  /* Sideways-scrolling rows (top tabs, section chips, wide tables): fade whichever edge
     has more content behind it, like JE's settings tab bar, and centre the active pill. */
  var rows = [];
  function updateFades(el) {
    var max = el.scrollWidth - el.clientWidth;
    el.classList.toggle("je-fade-left", max > 4 && el.scrollLeft > 4);
    el.classList.toggle("je-fade-right", max > 4 && el.scrollLeft < max - 4);
  }
  function scrollRow(el, activeSelector) {
    if (!el) return;
    rows.push(el);
    if (!el.dataset.jeRow) {
      el.dataset.jeRow = "1";
      el.addEventListener("scroll", function () { updateFades(el); }, { passive: true });
    }
    var active = activeSelector && el.querySelector(activeSelector);
    if (active && el.scrollWidth > el.clientWidth) {
      el.scrollLeft = Math.max(0, active.offsetLeft - el.offsetLeft - (el.clientWidth - active.offsetWidth) / 2);
    }
    updateFades(el);
  }
  window.addEventListener("resize", function () { rows.forEach(updateFades); }, { passive: true });

  /* "Reduce motion": looping screen recordings start paused (their controls still play them). */
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)");
  function calmVideos(root) {
    if (!reduceMotion || !reduceMotion.matches) return;
    root.querySelectorAll("video[autoplay]").forEach(function (video) {
      video.removeAttribute("autoplay");
      video.pause();
    });
  }

  /* Search results name the area too ("Spoiler Guard" above "Features"), using the
     page-to-area map from the site navigation that every page already contains. */
  var areaOf = null;
  function buildAreas() {
    areaOf = {};
    document.querySelectorAll(".md-nav--primary > .md-nav__list > .md-nav__item--nested").forEach(function (item) {
      var title = item.querySelector(":scope > nav > .md-nav__title");
      if (!title) return;
      var name = title.textContent.trim();
      item.querySelectorAll("a.md-nav__link[href]").forEach(function (a) {
        areaOf[a.href.split(/[?#]/)[0]] = name;
      });
    });
  }
  function labelResults(list) {
    if (!areaOf) buildAreas();
    list.querySelectorAll(".md-search-result__item > .md-search-result__link").forEach(function (link) {
      var heading = link.querySelector(".md-search-result__article h1");
      var name = areaOf[link.href.split(/[?#]/)[0]];
      if (!heading || !name || heading.querySelector(".je-search-area")) return;
      var tag = document.createElement("span");
      tag.className = "je-search-area";
      tag.textContent = name;
      heading.insertBefore(tag, heading.firstChild);
    });
  }
  var results = document.querySelector(".md-search-result__list");
  if (results && window.MutationObserver) {
    new MutationObserver(function () { labelResults(results); }).observe(results, { childList: true });
  }

  function init() {
    var content = document.querySelector(".md-content") || document;
    rows = [];
    calmVideos(content);
    markStates(content);
    stackTables(content);
    fitShort(content);
    if (document.fonts) document.fonts.ready.then(function () { fitShort(content); });
    markLabels(content);
    markImages(content);
    scrollRow(document.querySelector(".md-tabs__list"), ".md-tabs__item--active");
    scrollRow(document.querySelector(".je-sectionbar__pages"), ".je-chip--active");
    content.querySelectorAll(".md-typeset__scrollwrap").forEach(function (wrap) { scrollRow(wrap); });
  }

  // Material's instant navigation swaps pages without a reload: re-run on every page.
  if (window.document$ && typeof window.document$.subscribe === "function") {
    window.document$.subscribe(init);
  } else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
