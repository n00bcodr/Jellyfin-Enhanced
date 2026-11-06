const { test, expect } = require('@playwright/test');
const s = require('./helpers/settings-surfaces.cjs');

// Standing guard (round 21): on every settings surface (admin Media Tags page, personal hub, item editor),
// at 420, 900 and 1400px (and 1100/1280, where grid columns are narrowest) and in both themes, no text runs past the button, chip or label it is in
// (scrollWidth ≤ clientWidth + 1 unless an ellipsis is intended or the box scrolls). Found in a demo
// review: "Apply defaults to all users" ran past its Quick links button. Poster tags in the live previews
// have their own fitting guards and are left out here.

/** Open every tab (and every row) of a surface in turn, collecting what overflows in each. */
function sweep(page, surface) {
  return page.evaluate(async (surface) => {
    const settle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const root = surface === 'admin' ? document.querySelector('.je-tag-admin') : surface === 'hub' ? document.querySelector('#jeMediaTagsHub') : document.querySelector('.je-tie, [class*="je-tie"]')?.closest('[role="dialog"], .dialog, body') || document.body;
    const overflows = new Set();
    // Every line of text must stay inside the content box (inside the padding) of the box that holds it:
    // its nearest block-level ancestor, typically a button, chip, pill or label.
    const check = (where) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!parent || parent.closest('.je-tag-host, .je-tag-caption, .je-mtp-art, svg, [data-je-overflow], .material-icons, .material-icons-outlined, .material-symbols-outlined, .je-msym, .je-msym-outlined, option, script, style')) continue;
        let box = parent;
        while (box && ['inline', 'contents'].includes(getComputedStyle(box).display)) box = box.parentElement;
        if (!box) continue;
        const cs = getComputedStyle(box);
        if (cs.display === 'none' || cs.visibility === 'hidden' || !box.getClientRects().length || box.clientWidth === 0) continue;
        if (box.clientWidth <= 1 && cs.position === 'absolute') continue; // screen-reader-only text
        if (cs.textOverflow === 'ellipsis' || ['auto', 'scroll'].includes(cs.overflowX)) continue;
        const outer = box.getBoundingClientRect();
        const left = outer.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
        const right = outer.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
        // Word by word: the space a line breaks at hangs past the box in some engines (Firefox counts it in a
        // range's rectangles), but no word may run past it.
        const range = document.createRange();
        const lines = [];
        for (const word of node.textContent.matchAll(/\S+/g)) {
          range.setStart(node, word.index);
          range.setEnd(node, word.index + word[0].length);
          for (const r of range.getClientRects()) if (r.width > 0) { r.word = word[0]; lines.push(r); }
        }
        const past = Math.max(0, ...lines.map((r) => Math.max(left - r.left, r.right - right)));
        const worst = lines.find((r) => Math.max(left - r.left, r.right - right) === past);
        if (past > 1) {
          const text = (box.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50);
          overflows.add(`${where}: <${box.tagName.toLowerCase()}${box.className ? ` class="${String(box.className).slice(0, 40)}"` : ''}> "${text}" runs ${Math.round(past)}px past its box at "${worst && worst.word}"`);
        }
      }
    };
    const tabs = Array.from(root.querySelectorAll('[role="tab"]'));
    for (const tab of tabs.length ? tabs : [null]) {
      if (tab) { /** @type {HTMLElement} */ (tab).click(); await settle(); }
      for (const opener of root.querySelectorAll('.je-ta-expand[aria-expanded="false"], .je-tge-expand[aria-expanded="false"], .je-tie-gopen[aria-expanded="false"]:not([disabled])')) {
        if (opener.getClientRects().length) /** @type {HTMLElement} */ (opener).click();
      }
      await settle();
      check(tab ? tab.dataset.tab || tab.textContent.trim() : surface);
    }
    return [...overflows];
  }, surface);
}

for (const surface of ['admin', 'hub', 'itemEditor']) {
  test(`no text overflows its control on the ${surface} settings at 420, 900, 1100, 1280 and 1400px, dark and light`, async ({ page }) => {
    test.setTimeout(180000);
    const failures = [];
    for (const theme of ['dark', 'light']) {
      for (const width of [420, 900, 1100, 1280, 1400]) {
        await page.setViewportSize({ width, height: 900 });
        if (surface === 'admin') await s.adminPage(page, { theme });
        else if (surface === 'hub') await s.hub(page, { theme });
        else await s.itemEditor(page, { theme });
        failures.push(...(await sweep(page, surface)).map((f) => `${theme} ${width}px ${f}`));
      }
    }
    expect(failures).toEqual([]);
  });
}
