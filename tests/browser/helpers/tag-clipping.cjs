/**
 * Clipping detector for poster tag chips. `detectTagClipping` runs inside the
 * page (page.evaluate) and depends on nothing outside its own body, so the
 * fixture specs and authorized lab scripts share it.
 */

/**
 * Inspect every painted chip under `root` and report what is cut, spilled,
 * wrapped, overlapping or outside its card.
 * @param {{root?: string, tolerance?: number}} [options]
 * @returns {{chips: number, findings: object[], intentional: object[]}}
 */
function detectTagClipping(options = {}) {
  const tol = options.tolerance ?? 0.5;
  const scope = document.querySelector(options.root || 'body');
  const BOX = '.quality-overlay-label, .rating-tag, .age-rating-tag, .status-tag, .awards-tag, .je-logo-chip, .custom-tag, .language-chip';
  const CHIP = `${BOX}, .je-tag-more, .genre-tag, .language-flag, .je-tag-dots, .je-tag-pill`;
  const LABELS = '.rating-text, .custom-tag-text, .je-logo-text, .je-tag-fit-text, .awards-tag > span:last-child';
  // The card's own box ends the ancestor walk: panels and pages may scroll.
  const CARD_END = '.cardBox, .card, .listItem, .je-mtp-card, .je-tie-card';
  const findings = [];
  const intentional = [];
  const round = (r) => ({ x: +r.left.toFixed(1), y: +r.top.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) });
  const painted = (el) => {
    for (let a = el; a; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
      if (a.matches(CARD_END)) break;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const outside = (r, b, x = true, y = true) => (x && (r.left < b.left - tol || r.right > b.right + tol))
    || (y && (r.top < b.top - tol || r.bottom > b.bottom + tol));
  const clips = (value) => /hidden|clip|auto|scroll/.test(value);
  /** Text the browser really ellipsizes: a nowrap block container clipping its overflow. */
  const ellipsized = (el) => {
    const s = getComputedStyle(el);
    return s.textOverflow === 'ellipsis' && clips(s.overflowX) && /nowrap|pre/.test(s.whiteSpace)
      && !/flex|grid|contents/.test(s.display);
  };
  const lineCount = (el) => {
    const tops = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim() || node.parentElement.closest('.genre-text') && getComputedStyle(node.parentElement.closest('.genre-text')).position === 'absolute') continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const b of range.getClientRects()) {
        if (b.width < 0.5 || b.height < 0.5) continue;
        const mid = b.top + b.height / 2;
        if (!tops.some((t) => Math.abs(t.mid - mid) < Math.min(t.h, b.height) / 2)) tops.push({ mid, h: b.height });
      }
    }
    return tops.length;
  };

  const all = Array.from(scope ? scope.querySelectorAll(CHIP) : [])
    .filter((el) => !el.parentElement.closest(CHIP) && el.closest('.je-tag-host, .je-tag-caption'));
  const shown = [];
  for (const chip of all) {
    const holder = chip.closest('.je-tag-slot, .je-tag-caption');
    const host = chip.closest('.je-tag-host');
    const card = chip.closest('[data-id], [data-sample], .je-tie-card');
    const id = {
      card: card?.dataset.sample || card?.dataset.id || '',
      slot: holder?.dataset.jeSlot || 'caption',
      group: chip.closest('[data-je-group]')?.dataset.jeGroup || '',
      chip: chip.className.split(' ')[0],
      text: (chip.textContent || chip.getAttribute('alt') || chip.title || '').replace(/\s+/g, ' ').trim().slice(0, 40),
    };
    if (chip.closest('[data-je-overflow]')) { intentional.push({ ...id, type: 'hidden-overflow' }); continue; }
    if (!painted(chip)) continue;
    const r = chip.getBoundingClientRect();
    const fitted = !!chip.closest('[data-je-fit-width]');
    shown.push({ chip, holder, host, r, id });
    if (chip.matches('.je-tag-more')) intentional.push({ ...id, type: 'more-chip' });
    if (fitted) intentional.push({ ...id, type: 'fit-width', w: +r.width.toFixed(1) });

    // (a) cut by a clipping ancestor, up to the card's own box.
    for (let a = chip.parentElement; a; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.display !== 'contents') {
        const x = clips(s.overflowX), y = clips(s.overflowY);
        if ((x || y) && outside(r, a.getBoundingClientRect(), x, y)) {
          (fitted ? intentional : findings).push({ ...id, type: 'ancestor-clip', ancestor: a.className.split(' ')[0], rect: round(r), clip: round(a.getBoundingClientRect()) });
          break;
        }
      }
      if (a.matches(CARD_END)) break;
    }
    // (b) label wider than its box without a real ellipsis.
    // A genre circle's floating name is positioned outside it on purpose.
    const floating = chip.matches('.genre-tag') && Array.from(chip.querySelectorAll('.genre-text')).some((t) => getComputedStyle(t).position === 'absolute');
    for (const label of floating ? [] : [chip, ...chip.querySelectorAll(LABELS)]) {
      if (label !== chip && !painted(label)) continue;
      if (label.clientWidth > 0 && label.scrollWidth > label.clientWidth + 1 && !ellipsized(label)) {
        findings.push({ ...id, type: 'text-overflow', label: label.className.split(' ')[0], scroll: label.scrollWidth, client: label.clientWidth });
      } else if (label.clientWidth > 0 && label.scrollWidth > label.clientWidth + 1) {
        intentional.push({ ...id, type: 'ellipsis', label: label.className.split(' ')[0] });
      }
    }
    // (c) a chip's text on two lines.
    if (!chip.matches('.je-tag-dots, .language-flag')) {
      const lines = lineCount(chip);
      if (lines > 1) findings.push({ ...id, type: 'wrapped', lines, rect: round(r) });
    }
    // (e) outside the card's image (captions live below it, inside their strip).
    if (host && outside(r, host.getBoundingClientRect())) findings.push({ ...id, type: 'outside-card', rect: round(r), image: round(host.getBoundingClientRect()) });
    // (f) its own group box is narrower or shorter than the chip.
    const group = chip.closest('[data-je-group]');
    if (group && group.contains(chip) && getComputedStyle(group).display !== 'contents' && outside(r, group.getBoundingClientRect())) {
      findings.push({ ...id, type: 'container-trim', rect: round(r), container: round(group.getBoundingClientRect()) });
    }
  }
  // (d) chips of different slots on the same card overlapping.
  for (let i = 0; i < shown.length; i++) {
    for (let j = i + 1; j < shown.length; j++) {
      const a = shown[i], b = shown[j];
      if (!a.host || a.host !== b.host || a.holder === b.holder) continue;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w > tol && h > tol) findings.push({ ...a.id, type: 'slot-overlap', other: { ...b.id }, overlap: [+w.toFixed(1), +h.toFixed(1)] });
    }
  }
  return { chips: shown.length, findings, intentional };
}

/**
 * Every layout × size × density (× Corners edge) × Resting/Hover combination.
 * @returns {Array<{layout: string, scale: string, density: string, edge: string, hover: boolean}>}
 */
function clippingConfigurations() {
  const out = [];
  for (const layout of ['corners', 'bands', 'caption', 'summary', 'minimal']) {
    for (const scale of ['smaller', 'default', 'larger', 'largest']) {
      for (const density of ['full', 'compact']) {
        for (const edge of layout === 'corners' ? ['default', 'tight', 'flush'] : ['default']) {
          for (const hover of [false, true]) out.push({ layout, scale, density, edge, hover });
        }
      }
    }
  }
  return out;
}

module.exports = { detectTagClipping, clippingConfigurations };
