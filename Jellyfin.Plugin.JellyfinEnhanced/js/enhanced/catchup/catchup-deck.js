/**
 * @file Catch Up card deck: cards, drag and keyboard gestures, the season picker and undo.
 * Mounted by catchup-page.js through JE.internals.catchUp.deck.mount().
 *
 * Right = watched, left = dismiss, up = watchlist (Likes), down = open details.
 */
(function () {
  'use strict';

  const JE = window.JellyfinEnhanced;
  if (!JE?.pluginConfig?.CatchUpEnabled) return;
  const S = JE.internals.catchUp;
  const { state, tt, h, icon, ACTIONS, ACT_NAME } = S;

  const THRESHOLD = 110;   // drag distance in px that counts as a swipe
  const REFILL_AT = 6;     // refill when this few cards are left
  const FLY = { right: [1, 0], left: [-1, 0], up: [0, -1] };
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* storage blocked */ } },
  };

  /** Elements of the mounted deck, null when the page isn't showing. */
  let ui = null;

  const liveCards = () => [...ui.stage.querySelectorAll('.je-catchup-card:not(.leaving)')];
  const topCard = () => { const c = liveCards(); return c[c.length - 1]; };
  const toast = (msg) => { try { JE.toast(msg); } catch (_) { /* toast is cosmetic */ } };

  // Cards
  /** Builds the info line: year · runtime or season count · rating · genres. */
  function subline(item) {
    let length = '';
    if (state.mode === 'Series') {
      if (item.ChildCount) length = tt('catchup_seasons', '{n} season(s)', { n: item.ChildCount });
    } else if (item.RunTimeTicks) {
      length = tt('catchup_minutes', '{n} min', { n: Math.round(item.RunTimeTicks / 6e8) });
    }
    return [item.ProductionYear, length, item.CommunityRating ? '★ ' + item.CommunityRating.toFixed(1) : '', (item.Genres || []).slice(0, 2).join(', ')]
      .filter(Boolean).join(' · ');
  }

  function cardEl(item) {
    const el = h('div', 'je-catchup-card');
    el.item = item;
    const img = document.createElement('img');
    img.draggable = false; img.alt = ''; img.src = S.imageUrl(S.imageOf(item), 700);
    const meta = h('div', 'je-catchup-meta');
    meta.append(h('h2', '', item.Name), h('p', '', subline(item)), h('div', 'ov', item.Overview || ''));
    el.append(img, meta,
      h('div', 'je-catchup-stamp r', tt('catchup_stamp_watched', 'WATCHED')), h('div', 'je-catchup-stamp l', tt('catchup_stamp_dismiss', 'DISMISS')),
      h('div', 'je-catchup-stamp u', tt('catchup_stamp_watchlist', 'WATCHLIST')), h('div', 'je-catchup-stamp d', tt('catchup_stamp_open', 'OPEN')));
    attachDrag(el);
    return el;
  }

  function render() {
    if (!ui) return;
    liveCards().forEach((c) => { if (S.isHidden(c.item)) c.remove(); });
    state.queue = state.queue.filter((i) => !S.isHidden(i));
    const have = liveCards();
    while (have.length < 2 && state.queue.length) { const c = cardEl(state.queue.shift()); ui.stage.prepend(c); have.unshift(c); }
    liveCards().forEach((c, i, all) => c.classList.toggle('back', i < all.length - 1));
    ui.empty.style.display = liveCards().length ? 'none' : 'flex';


    if (state.queue.length < REFILL_AT) S.refill().then((n) => { if (n && liveCards().length < 2) render(); }).catch(() => {});
  }

  // Actions
  const flash = (el, k) => { const s = el.querySelector('.je-catchup-stamp.' + k); if (s) s.style.opacity = 1; };
  function resetCard(el) {
    el.style.transition = 'transform .25s'; el.style.transform = '';
    el.querySelectorAll('.je-catchup-stamp').forEach((x) => { x.style.opacity = 0; });
  }

  /** Applies a swipe in direction `dir`. `opts` holds the chosen seasons for shows. */
  function fire(dir, opts) {
    const el = topCard();
    if (!el || (state.pickerOpen && !opts)) return;
    if (dir === 'right' && state.mode === 'Series' && !opts) return pickSeasons(el);
    if (dir === 'down') {
      S.logSwipe(el.item, 'down', null, true);
      S.navigateToItem(el.item.Id);
      resetCard(el);
      return;
    }
    const [x, y] = FLY[dir], item = el.item, act = ACTIONS[dir];
    flash(el, dir[0]);
    el.style.transition = 'transform .3s ease-in, opacity .3s';
    el.style.transform = `translate(${x * innerWidth}px, ${y * innerHeight}px) rotate(${x * 25}deg)`;
    el.style.opacity = 0;
    el.classList.add('leaving'); el.classList.remove('back');
    setTimeout(() => el.remove(), 300);
    state.undoStack.push({ item, dir, opts });
    act.run(item, opts)
      .then(() => S.logSwipe(item, dir, opts, true))
      .catch((e) => { toast(tt('catchup_failed', 'Failed: {error}', { error: e.message })); S.logSwipe(item, dir, opts, false); });
    render();
  }

  async function undo() {
    const last = state.undoStack.pop();
    if (!last) return;
    let ok = true;
    try { await ACTIONS[last.dir].undo(last.item, last.opts); } catch (e) { ok = false; toast(tt('catchup_failed', 'Failed: {error}', { error: e.message })); }
    S.logEvent({ type: 'swipe', action: 'undo', undoOf: ACT_NAME[last.dir], itemId: last.item.Id, ok });
    const live = liveCards();
    state.queue.unshift(last.item, ...live.map((c) => c.item));
    live.forEach((c) => c.remove());
    render();
  }

  // Season picker (shows)
  /** Selecting a season selects every earlier one; selecting a selected season again unticks only that one. */
  async function pickSeasons(el) {
    const item = el.item;
    state.pickerOpen = true; resetCard(el);
    let seasons = [];
    try {
      const r = await S.jf(`/Shows/${item.Id}/Seasons?userId=${S.userId()}&Fields=ChildCount`);
      seasons = (r.Items || []).filter((x) => x.IndexNumber > 0).sort((a, b) => a.IndexNumber - b.IndexNumber);
    } catch (e) { state.pickerOpen = false; return toast(tt('catchup_failed', 'Failed: {error}', { error: e.message })); }
    if (seasons.length < 2) { state.pickerOpen = false; return fire('right', { seasons: null, numbers: ['all'] }); } // single season: no question needed

    const p = ui.picker;
    p.title.textContent = item.Name;
    p.grid.replaceChildren();
    const sel = new Set(), btns = [];
    const paint = () => {
      btns.forEach((b, k) => b.classList.toggle('on', sel.has(k)));
      const n = sel.size;
      p.ok.disabled = !n;
      p.ok.textContent = !n ? tt('catchup_picker_select', 'Select seasons')
        : tt('catchup_picker_mark', 'Mark {n} season(s) watched', { n });
    };
    seasons.forEach((s, k) => {
      const total = s.ChildCount || 0, left = s.UserData?.UnplayedItemCount ?? total, seen = Math.max(0, total - left);
      const b = h('button', seen && seen >= total ? 'done' : '', String(s.IndexNumber));
      if (total) b.append(h('small', '', `${seen}/${total}`));
      b.onclick = () => { if (sel.has(k)) sel.delete(k); else for (let j = 0; j <= k; j++) sel.add(j); paint(); };
      btns.push(b); p.grid.append(b);
    });
    const close = () => { p.root.style.display = 'none'; state.pickerOpen = false; };
    p.ok.onclick = () => {
      const picked = [...sel].sort((a, b) => a - b), all = picked.length === seasons.length;
      close();
      fire('right', { seasons: all ? null : picked.map((k) => seasons[k].Id), numbers: all ? ['all'] : picked.map((k) => String(seasons[k].IndexNumber)) });
    };
    p.cancel.onclick = close;
    paint();
    p.root.style.display = 'flex';
  }

  // Drag gestures
  function attachDrag(el) {
    let sx = 0, sy = 0, dragging = false;
    const stamp = (k) => el.querySelector('.je-catchup-stamp.' + k);
    el.addEventListener('pointerdown', (e) => {
      if (el.classList.contains('back')) return;
      dragging = true; sx = e.clientX; sy = e.clientY; el.setPointerCapture(e.pointerId); el.style.transition = 'none';
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy, horiz = Math.abs(dx) > Math.abs(dy);
      const o = (k) => Math.min(1, Math.max(0, k / THRESHOLD));
      el.style.transform = `translate(${dx}px,${dy}px) rotate(${dx / 20}deg)`;
      stamp('r').style.opacity = horiz && dx > 0 ? o(dx) : 0;
      stamp('l').style.opacity = horiz && dx < 0 ? o(-dx) : 0;
      stamp('u').style.opacity = !horiz && dy < 0 ? o(-dy) : 0;
      stamp('d').style.opacity = !horiz && dy > 0 ? o(dy) : 0;
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      const dx = e.clientX - sx, dy = e.clientY - sy, horiz = Math.abs(dx) > Math.abs(dy);
      const committed = Math.max(Math.abs(dx), Math.abs(dy)) > THRESHOLD;
      el.style.transition = 'transform .25s';
      if (committed) fire(horiz ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
      // Down opens the title and right on a show opens the picker. The card stays in both cases, so snap it back.
      if (!committed || (!horiz && dy > 0) || (horiz && dx > 0 && state.mode === 'Series')) resetCard(el);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  // Dialogs
  function buildPicker() {
    const root = h('div', 'je-catchup-modal'), box = h('div', 'box');
    const title = h('h3'), grid = h('div', 'je-catchup-grid');
    const ok = h('button', 'primary'), cancel = h('button', 'ghost', tt('catchup_picker_cancel', 'Cancel'));
    box.append(title, h('p', '', tt('catchup_picker_help', 'Select the seasons you have watched. Selecting a later season selects all the earlier ones too; select a selected season again to untick just that one.')), grid, ok, cancel);
    root.append(box);
    return { root, title, grid, ok, cancel };
  }

  // Mount
  /**
   * Builds the deck UI inside `main` (header with tabs, stage, buttons, hint).
   * @param {HTMLElement} root the .je-catchup root (modals attach here)
   * @param {HTMLElement} main the column that holds the deck
   * @returns {{ start: Function, headActions: HTMLElement }}
   */
  function mount(root, main) {
    const head = h('div', 'je-catchup-head');
    const headActions = h('div', 'je-catchup-headbtns');
    head.append(h('div', 'je-catchup-title', tt('catchup_title', 'Catch Up')), headActions);

    const tabs = h('div', 'je-catchup-tabs');
    [['Movie', tt('catchup_tab_movies', 'Movies')], ['Series', tt('catchup_tab_shows', 'Shows')]].forEach(([mode, label]) => {
      const b = h('button', '', label); b.dataset.mode = mode;
      b.onclick = () => { if (state.mode === mode) return; state.mode = mode; store.set('je-catchup-mode', mode); start(); };
      tabs.append(b);
    });

    const stage = h('div', 'je-catchup-stage'), empty = h('div', 'je-catchup-empty', tt('catchup_empty', 'Nothing more to show here.'));
    stage.append(empty);

    const buttons = h('div', 'je-catchup-buttons');
    const cap = (k, f) => { const w = tt(k, f); return w[0] + w.slice(1).toLowerCase(); };
    [['z', 'undo', tt('catchup_btn_rewind', 'Rewind (Backspace)'), undo], ['l', 'x', `${cap('catchup_stamp_dismiss', 'DISMISS')} (←)`, () => fire('left')],
      ['d', 'info', `${cap('catchup_stamp_open', 'OPEN')} (↓)`, () => fire('down')], ['u', 'bookmark', `${cap('catchup_stamp_watchlist', 'WATCHLIST')} (↑)`, () => fire('up')],
      ['r', 'check', `${cap('catchup_stamp_watched', 'WATCHED')} (→)`, () => fire('right')]].forEach(([cls, ic, title, fn]) => {
      const b = h('button', cls); b.title = title; b.setAttribute('aria-label', title); b.append(icon(ic)); b.onclick = fn; buttons.append(b);
    });
    const hint = h('div', 'je-catchup-hint', tt('catchup_hint', '→ watched · ← dismiss · ↑ watchlist · ↓ open · Backspace = rewind'));

    const picker = buildPicker();
    main.append(head, tabs, stage, buttons, hint);
    root.append(picker.root);

    ui = { root, stage, empty, picker, tabs };

    // Keyboard shortcuts work only while the deck is on screen and no dialog is open.
    const onKey = (e) => {
      if (!document.contains(root)) { document.removeEventListener('keydown', onKey); if (ui && ui.root === root) ui = null; return; }
      const activityModal = root.querySelector('.je-catchup-activity.open') && !root.classList.contains('docked');
      if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName) || state.pickerOpen || activityModal) return;
      const dir = { ArrowRight: 'right', ArrowLeft: 'left', ArrowUp: 'up', ArrowDown: 'down' }[e.key];
      if (dir) { e.preventDefault(); fire(dir); } else if (e.key === 'Backspace' || e.key === 'z') undo();
    };
    document.addEventListener('keydown', onKey);

    const saved = store.get('je-catchup-mode');
    state.mode = saved === 'Series' ? 'Series' : 'Movie';
    return { start, headActions };
  }

  /** (Re)loads the deck for the current mode. */
  async function start() {
    if (!ui) return;
    ui.tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === state.mode));
    S.loadDismissed();
    state.queue = []; state.seen = new Set(); state.undoStack = [];
    ui.stage.querySelectorAll('.je-catchup-card').forEach((c) => c.remove());
    try { await S.refill(); } catch (e) { toast(tt('catchup_failed', 'Failed: {error}', { error: e.message })); }
    render();
  }

  S.deck = { mount, start };
})();
