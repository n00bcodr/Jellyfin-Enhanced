/**
 * @file Catch Up admin activity panel: a feed and a summary of who swiped what.
 * Docked next to the deck on wide screens, a full-screen dialog otherwise. Only shown to
 * admins, and the endpoints check that again on the server.
 */
(function () {
  'use strict';

  const JE = window.JellyfinEnhanced;
  if (!JE?.pluginConfig?.CatchUpEnabled) return;
  const S = JE.internals.catchUp;
  const { tt, h, icon } = S;

  const WIDE = () => window.innerWidth >= 1100;
  const REFRESH_MS = 10000;
  const ACTIONS = ['watched', 'dismiss', 'watchlist', 'open', 'undo'];
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* storage blocked */ } },
  };

  const rtf = typeof Intl !== 'undefined' && Intl.RelativeTimeFormat ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }) : null;
  /** "5 minutes ago" in the viewer's language. */
  function ago(iso) {
    const mins = (new Date(iso) - Date.now()) / 60000;
    if (!rtf) return new Date(iso).toLocaleString();
    if (Math.abs(mins) < 1) return rtf.format(0, 'second');
    if (Math.abs(mins) < 60) return rtf.format(Math.round(mins), 'minute');
    if (Math.abs(mins) < 1440) return rtf.format(Math.round(mins / 60), 'hour');
    return rtf.format(Math.round(mins / 1440), 'day');
  }

  const itemLink = (id, name) => { const a = h('a', '', name || id); a.onclick = () => S.navigateToItem(id); return a; };
  const fetchJson = (path) => JE.core.api.plugin(path, { skipCache: true, skipRetry: true });

  /**
   * Adds the Activity button and panel. Admins only.
   * @param {HTMLElement} root the .je-catchup root (flex row: main column + this panel)
   * @param {HTMLElement} headActions container for the header buttons
   */
  async function mount(root, headActions) {
    try {
      const me = await S.jf('/Users/Me');
      if (!me?.Policy?.IsAdministrator) return;
    } catch (_) { return; }

    let view = 'feed', timer = null;
    const aside = h('div', 'je-catchup-activity'), panel = h('div', 'panel');
    const title = h('h3', '', tt('catchup_activity', 'Activity'));
    const refreshBtn = h('button', 'je-catchup-btn', tt('catchup_refresh', 'Refresh')), closeBtn = h('button', 'je-catchup-btn', tt('catchup_hide', 'Hide'));
    const head = h('div', 'ahead'); head.append(title, refreshBtn, closeBtn);

    const tabs = h('div', 'atabs');
    [['feed', tt('catchup_activity_feed', 'Feed')], ['summary', tt('catchup_activity_summary', 'Summary')]].forEach(([v, label]) => {
      const b = h('button', v === view ? 'on' : '', label); b.dataset.v = v;
      b.onclick = () => { view = v; tabs.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); load(); };
      tabs.append(b);
    });

    const filters = h('div', 'afilters');
    const userSel = h('select'); userSel.append(new Option(tt('catchup_all_users', 'All users'), ''));
    const search = h('input'); search.placeholder = tt('catchup_search_titles', 'Search titles');
    const chips = h('div', 'fchips'); chips.title = tt('catchup_filter_hint', 'Pick one or more; none = all');
    ACTIONS.forEach((a) => { const c = h('button', 'chip', a); c.dataset.a = a; c.onclick = () => { c.classList.toggle('on'); load(); }; chips.append(c); });
    filters.append(userSel, search, chips);

    const body = h('div', 'abody');
    panel.append(head, tabs, filters, body);
    aside.append(panel);
    root.append(aside);

    // rendering
    function renderFeed(d) {
      const cur = userSel.value; userSel.length = 1;
      d.users.forEach((u) => userSel.append(new Option(u, u))); userSel.value = cur;
      body.replaceChildren();
      if (!d.events.length) body.append(h('div', 'aempty', tt('catchup_activity_empty', 'No activity yet.')));
      for (const e of d.events) {
        const act = e.action || e.type, row = h('div', 'arow'), t = h('div', 't', ago(e.ts)); t.title = e.ts;
        const tag = h('span', 'tag ' + act, act === 'undo' ? `undo ${e.undoOf || ''}`.trim() : act); if (e.ok === false) tag.classList.add('fail');
        const a = h('div', 'a'); a.append(tag);
        const i = h('div', 'i'); if (e.itemId) i.append(itemLink(e.itemId, e.itemName));
        const bits = [e.kind, e.seasons?.length ? `${tt('catchup_activity_seasons', 'seasons')}: ${e.seasons.join(', ')}` : ''].filter(Boolean).join(' · ');
        i.append(h('small', '', bits));
        row.append(t, h('div', 'u', e.user), a, i); body.append(row);
      }
    }

    function renderSummary(d) {
      body.replaceChildren();
      const cards = h('div', 'ucards');
      d.users.forEach((u) => {
        const c = h('div', 'ucard'); c.append(h('b', '', u.user));
        const st = h('div', 'stats');
        [['watched', tt('catchup_stamp_watched', 'WATCHED')], ['dismiss', tt('catchup_stamp_dismiss', 'DISMISS')], ['watchlist', tt('catchup_stamp_watchlist', 'WATCHLIST')]].forEach(([k, label]) => {
          const x = h('div'); x.append(h('span', '', String(u[k])), h('small', '', label)); st.append(x);
        });
        c.append(st, h('div', 'ls', tt('catchup_activity_last_seen', 'last seen {when}', { when: u.lastSeen ? ago(u.lastSeen) : '—' })));
        cards.append(c);
      });
      body.append(cards);
      const tops = h('div', 'tops');
      [[d.topWatched, tt('catchup_top_watched', 'Most watched')], [d.topDismissed, tt('catchup_top_dismissed', 'Most dismissed')], [d.topWatchlisted, tt('catchup_top_watchlisted', 'Most watchlisted')]].forEach(([list, label]) => {
        const col = h('div'); col.append(h('h4', '', label));
        if (!list.length) col.append(h('div', 'aempty', tt('catchup_activity_empty', 'No activity yet.')));
        list.forEach((t) => { const r = h('div', 'toprow'); r.append(itemLink(t.itemId, t.name), h('span', '', `${t.count} · ${t.users.join(', ')}`)); col.append(r); });
        tops.append(col);
      });
      body.append(tops);
    }

    async function load() {
      filters.style.display = view === 'feed' ? '' : 'none';
      try {
        if (view === 'feed') {
          const q = new URLSearchParams({ limit: '300' });
          if (userSel.value) q.set('user', userSel.value);
          const acts = [...chips.querySelectorAll('.chip.on')].map((b) => b.dataset.a);
          if (acts.length) q.set('action', acts.join(','));
          if (search.value.trim()) q.set('q', search.value.trim());
          renderFeed(await fetchJson(`/catchup/events?${q}`));
        } else {
          renderSummary(await fetchJson('/catchup/summary'));
        }
      } catch (e) {
        body.replaceChildren(h('div', 'aempty', tt('catchup_failed', 'Failed: {error}', { error: e.message })));
      }
    }

    // open and dock
    const toggle = h('button', 'je-catchup-btn'); toggle.append(icon('activity'), h('span', '', tt('catchup_activity', 'Activity')));
    const isOpen = () => aside.classList.contains('open');
    function open() {
      aside.classList.add('open'); toggle.classList.add('on');
      root.classList.toggle('docked', WIDE());
      load(); clearInterval(timer); timer = setInterval(() => { if (!document.contains(root)) { clearInterval(timer); return; } load(); }, REFRESH_MS);
    }
    function close() { aside.classList.remove('open'); toggle.classList.remove('on'); root.classList.remove('docked'); clearInterval(timer); }
    /** Docks the panel on wide screens unless the admin hid it. On narrow screens it only opens on demand. */
    function layout() {
      if (!document.contains(root)) { window.removeEventListener('resize', layout); clearInterval(timer); return; }
      const want = WIDE() && store.get('je-catchup-dock') !== '0';
      if (want && !isOpen()) open();
      else if (!want && isOpen() && root.classList.contains('docked')) close();
      else if (isOpen()) root.classList.toggle('docked', WIDE());
    }
    window.addEventListener('resize', layout);

    headActions.prepend(toggle);
    // The button toggles the panel, including when it is already docked.
    toggle.onclick = () => {
      if (isOpen()) { if (root.classList.contains('docked')) store.set('je-catchup-dock', '0'); close(); }
      else { if (WIDE()) store.set('je-catchup-dock', '1'); open(); }
    };
    closeBtn.onclick = () => { if (root.classList.contains('docked')) store.set('je-catchup-dock', '0'); close(); };
    refreshBtn.onclick = load;
    aside.addEventListener('click', (e) => { if (e.target === aside && !root.classList.contains('docked')) close(); });
    userSel.onchange = load;
    let debounce; search.oninput = () => { clearTimeout(debounce); debounce = setTimeout(load, 300); };
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen() && !root.classList.contains('docked')) close(); });

    layout();
  }

  S.activity = { mount };
})();
