# Live Dashboard

!!! note "About the dashboard"

    The dashboard reads aggregate results from public views. Visiting this page makes browser requests to the analytics service, Google Fonts and external tab-icon assets, even if your Jellyfin server has never enabled reporting. These requests are separate from installation reports.

    The figures show trends among installations that choose to report. They do not count all JE installations.

Browse aggregate results from participating installations. Usage covers the last 45 days; totals show current stored entries.

1. Use the facet buttons to select a settings tab.
2. Type to filter a table.
3. Click a column heading to sort; click it again to reverse the order.

Data reloads when you arrive on the page or refresh your browser. A version warning means the build target does not match the Jellyfin major version.

??? note "Details"

    **Feature Toggle Adoption** lists settings present in reporting data. New or unreported settings may be absent; it is not a complete configuration catalog.

    Labels and defaults come from the generated settings map. Unknown labels use readable versions of property names, and unknown groups use Other.

    Queries have these limits:

    | Data | Limit |
    | --- | --- |
    | Versions | Up to 500 rows fetched; the largest 50 fetched groups appear in the version table |
    | Usage | 20 rows |
    | Current totals | 24 rows |
    | Feature flags | 500 rows |
    | Setting values | 500 rows |

    Settings percentages use the fetched value rows for each setting. These limits can further reduce the sample.

<div id="je-analytics-dashboard" markdown>

<p id="je-analytics-loading">Loading live data…</p>
<p id="je-analytics-error-banner" class="je-analytics-error" hidden></p>

## Installs & Versions

<div id="je-section-versions"></div>

## Current Totals

<p class="je-section-subtitle">Across reporting installs</p>

<div id="je-section-totals"></div>

## Feature Usage

<p class="je-section-subtitle">Last 45 days</p>

<div id="je-section-usage"></div>

## Feature Toggle Adoption

<div id="je-section-flags"></div>

## Settings Distribution

<div id="je-section-settings"></div>

<p class="je-analytics-updated" id="je-analytics-updated"></p>

</div>

<style>
/* Same Material Icons font the config page's tabs use; this docs page is a
   separate static site so it needs its own copy loaded. */
@import url('https://fonts.googleapis.com/icon?family=Material+Icons');
.je-pill-icon {
  font-family: 'Material Icons'; font-weight: normal; font-style: normal;
  font-size: 1.1em; line-height: 1; letter-spacing: normal; text-transform: none;
  white-space: nowrap; word-wrap: normal; direction: ltr;
  -webkit-font-smoothing: antialiased; vertical-align: -0.2em; margin-right: 0.3em;
}
.je-pill-icon-img { width: 1em; height: 1em; vertical-align: -0.15em; margin-right: 0.3em; }
#je-analytics-error-banner { margin: 1em 0; }
.je-section-subtitle { opacity: 0.65; font-size: 0.9em; margin-top: -0.6em; }
.je-stat-cards { display: flex; flex-wrap: wrap; gap: 1em; margin: 1em 0; }
.je-stat-card.je-stat-card-hero { flex-basis: 100%; }
.je-stat-card {
  flex: 1 1 110px;
  min-width: 0;
  border: 1px solid var(--md-default-fg-color--lightest, #ddd);
  border-radius: 8px;
  padding: 1em 1.2em;
}
.je-stat-card .je-stat-value { font-size: 1.8em; font-weight: 700; }
.je-stat-card .je-stat-label { opacity: 0.7; font-size: 0.85em; }
.je-stat-card .je-stat-label-primary { font-size: 1.05em; font-weight: 600; margin-top: 0.4em; }
.je-stat-card .je-stat-label-secondary { opacity: 0.65; font-size: 0.6em; margin-top: 0.15em; }
.je-table-scroll { overflow-x: auto; }
.je-analytics-table { width: 100%; border-collapse: collapse; margin: 1em 0; }
.je-analytics-table th, .je-analytics-table td {
  text-align: left; padding: 0.4em 0.7em; border-bottom: 1px solid var(--md-default-fg-color--lightest, #ddd);
  font-size: 0.9em; vertical-align: top;
}
.je-analytics-bar-track {
  background: var(--md-default-fg-color--lightest, #eee);
  border-radius: 4px; height: 8px; width: 100%; overflow: hidden;
}
.je-analytics-bar-fill { background: var(--md-accent-fg-color, #7c4dff); height: 100%; }
.je-analytics-updated { font-size: 0.8em; opacity: 0.6; margin-top: 1.5em; }
.je-analytics-error { color: #c0392b; }
.je-analytics-mismatch { color: #d35400; font-weight: 600; }
.je-pill-row { display: flex; flex-wrap: wrap; gap: 0.4em; margin-bottom: 0.6em; }
.je-pill {
  cursor: pointer; font: inherit; font-size: 0.85em; padding: 0.3em 0.8em;
  border: 1px solid var(--md-default-fg-color--lightest, #ddd); border-radius: 999px;
  background: transparent; color: inherit;
}
.je-pill:hover { opacity: 0.8; }
.je-pill-active { background: var(--md-accent-fg-color, #7c4dff); border-color: transparent; color: rgba(0, 0, 0, 0.87); }
.je-table-search {
  display: block; width: 100%; max-width: 320px; margin-bottom: 0.6em;
  padding: 0.4em 0.6em; border: 1px solid var(--md-default-fg-color--lightest, #ddd);
  border-radius: 6px; background: transparent; color: inherit; font: inherit;
}
.je-sortable-th { user-select: none; white-space: nowrap; }
.je-sortable-th button {
  font: inherit; color: inherit; font-weight: inherit; text-align: inherit;
  background: none; border: none; padding: 0; width: 100%; cursor: pointer;
}
.je-sortable-th button:hover { opacity: 0.75; }
.je-sortable-th button:focus-visible { outline: 2px solid var(--je-link); outline-offset: 2px; }
.je-sort-active { font-weight: 700; }
.je-pct-cell { display: inline-flex; align-items: center; gap: 0.5em; white-space: nowrap; }
.je-inline-bar-track {
  flex: 0 0 auto;
  width: 100px; height: 8px; border-radius: 4px; overflow: hidden;
  background: var(--md-default-fg-color--lightest, #eee);
}
.je-inline-bar-track .je-analytics-bar-fill { height: 100%; }
</style>

<script>
(function() {
  // Instant navigation may execute this page script more than once.
  if (window.jeAnalyticsDashboard) window.jeAnalyticsDashboard.dispose();
  let activeRoot = null;
  let activeController = null;
  let subscription = null;
  const SUPABASE_URL = "https://cgsdfzfdoxunzoofzhgd.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_ShFKE3ognn7ZgncCGmCR-A_R1tPApiW";

  // Hard cap on rows pulled from any one view. report_stats is reachable by
  // anyone holding the anon key, so a flood of forged installs shouldn't be
  // able to make every visitor download/render unbounded rows.
  const MAX_ROWS = 500;

  async function fetchView(name, query, signal) {
    const q = query || "select=*";
    const withLimit = /(^|&)limit=/.test(q) ? q : `${q}&limit=${MAX_ROWS}`;
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${name}?${withLimit}`, {
      signal,
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
    });
    if (!res.ok) throw new Error(`${name}: ${res.status}`);
    return res.json();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
  }

  // Coerces report-derived fields before they hit innerHTML/style="width:N%".
  function num(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }
  function pct(v) { return Math.max(0, Math.min(100, num(v))); }

  // Bar first, percentage after, both in a nowrap span: a leading number of
  // variable width (6% vs 100%) would otherwise misalign the bars, and a
  // squeezed cell could wrap the number onto its own line above the bar.
  function barCell(p) {
    return `<span class="je-pct-cell"><div class="je-inline-bar-track"><div class="je-analytics-bar-fill" style="width:${p}%;"></div></div>${p}%</span>`;
  }

  // Same "DD-MMM-YYYY" convention as the config page's own formatDateDMY --
  // explicit instead of toLocaleDateString() so it doesn't vary by the
  // visitor's browser locale.
  const DATE_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function formatDateDMY(d) {
    const day = String(d.getDate()).padStart(2, '0');
    return `${day}-${DATE_MONTHS[d.getMonth()]}-${d.getFullYear()}`;
  }

  // Fallback for names with no config-page label (e.g. "total.*" keys).
  function humanize(name) {
    // String() guard: name can originate from a report-supplied field.
    const s = String(name == null ? '' : name);
    const spaced = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  }

  // Prefers the config page's real label over the humanize() fallback; the
  // raw PropertyName is a hover title rather than always-visible text.
  function labeledName(rawName) {
    // hasOwnProperty guard: rawName is report-supplied, so a name like
    // "toString" or "constructor" would otherwise pull a function off
    // Object.prototype instead of a label.
    const display = Object.prototype.hasOwnProperty.call(FLAG_LABELS_MAP, rawName)
      ? FLAG_LABELS_MAP[rawName] : humanize(rawName);
    return `<span title="${escapeHtml(rawName)}">${escapeHtml(display)}</span>`;
  }

  // Flags a jf10 build running on a v12+ server or vice versa (both work,
  // since the injection middleware is plain ASP.NET on either runtime, but
  // it's the wrong build for that server). Compares major-version ranges
  // rather than startsWith('12.'), so this doesn't misfire once Jellyfin 13 ships.
  function isTargetMismatch(target, jellyfinVersion) {
    const major = parseInt(jellyfinVersion, 10);
    if (!Number.isFinite(major)) return false;
    return (target === 'jf10' && major >= 12) || (target === 'jf12' && major < 12);
  }

  function renderVersionCards(rows) {
    const totalInstalls = rows.reduce((sum, r) => sum + num(r.install_count), 0);
    // Object.create(null) wherever report-supplied strings become keys: an
    // inherited name like "hasOwnProperty" must index nothing.
    const byTarget = Object.create(null);
    rows.forEach(r => { byTarget[r.jellyfin_target] = (byTarget[r.jellyfin_target] || 0) + num(r.install_count); });

    let html = `<div class="je-stat-cards">
      <div class="je-stat-card je-stat-card-hero"><div class="je-stat-value">${totalInstalls}</div><div class="je-stat-label">Reporting installs</div></div>`;
    // Cap BY COUNT, not alphabetically: jellyfin_target is attacker-mintable.
    Object.keys(byTarget).sort((a, b) => byTarget[b] - byTarget[a]).slice(0, 12).forEach(target => {
      html += `<div class="je-stat-card"><div class="je-stat-value">${byTarget[target]}</div><div class="je-stat-label">on ${escapeHtml(target)}</div></div>`;
    });
    html += `</div>`;

    // Cap BY COUNT before sorting, so the cap keeps the biggest groups.
    const items = rows.slice().sort((a, b) => num(b.install_count) - num(a.install_count)).slice(0, 50).map(r => ({
      pluginVersion: String(r.plugin_version == null ? '' : r.plugin_version),
      target: String(r.jellyfin_target == null ? '' : r.jellyfin_target),
      jfVersion: String(r.jellyfin_version == null ? '' : r.jellyfin_version),
      installs: num(r.install_count),
      seenTs: new Date(r.most_recent_seen).getTime() || 0,
      mismatch: isTargetMismatch(r.jellyfin_target, r.jellyfin_version),
    }));

    // Zero-padded segments so "12.10.0" sorts after "12.9.0" as a string compare.
    const versionKey = v => String(v).split('.').map(p => String(parseInt(p, 10) || 0).padStart(6, '0')).join('.');

    const columns = [
      { key: 'plugin', label: 'Plugin Version', sortValue: i => versionKey(i.pluginVersion), text: i => i.pluginVersion, render: i => escapeHtml(i.pluginVersion) },
      { key: 'target', label: 'Jellyfin Target', sortValue: i => i.target, render: i => escapeHtml(i.target) },
      { key: 'jf', label: 'Jellyfin Version', sortValue: i => versionKey(i.jfVersion), text: i => i.jfVersion,
        render: i => i.mismatch
          ? `<span class="je-analytics-mismatch" title="This build target doesn't match the running server's major version">${escapeHtml(i.jfVersion)} ⚠</span>`
          : escapeHtml(i.jfVersion) },
      { key: 'installs', label: 'Installs', firstDir: 'desc', sortValue: i => i.installs, render: i => String(i.installs) },
      { key: 'seen', label: 'Recently Seen On', firstDir: 'desc', sortValue: i => i.seenTs, text: i => formatDateDMY(new Date(i.seenTs)), render: i => formatDateDMY(new Date(i.seenTs)) },
    ];

    // Faceted by build target so the jf10/jf12 split is one click away.
    const table = renderSortableTable(items, columns, 'installs', 'target', 'desc');
    return { html: html + table.html, mount: table.mount };
  }

  // "total.*" keys are point-in-time snapshots (e.g. total.bookmarks), sent
  // through the same pipeline as per-period action counters (e.g.
  // bookmarks.created) but rendered separately since they mean different things.
  const TOTAL_COUNT_PREFIX = 'total.';

  const WINDOW_DAYS = 45; // must match v_feature_usage_window's own interval

  // Sourced from v_feature_usage_window: count(distinct install_id) done
  // server-side, since taking Math.max(install_count) across per-period rows
  // client-side undercounts once different installs land in different periods.
  function renderUsageTable(rows) {
    if (!rows.length) {
      return `<p><em>No usage-count data reported yet. This fills in once opted-in installs have accumulated activity over a reporting cycle.</em></p>`;
    }
    const maxCount = Math.max(...rows.map(r => num(r.total_count)), 1);
    let html = rows.length >= 20 ? `<p>Showing the top 20 keys.</p>` : '';
    html += `<div class="je-table-scroll"><table class="je-analytics-table"><thead><tr><th>Feature key</th><th>Total uses</th><th>Installs reporting it</th><th></th></tr></thead><tbody>`;
    rows.forEach(r => {
      const barPct = pct(Math.round((num(r.total_count) / maxCount) * 100));
      html += `<tr><td>${labeledName(String(r.feature_key || ''))}</td><td>${num(r.total_count)}</td><td>${num(r.install_count)}</td>
        <td style="width:120px;"><div class="je-analytics-bar-track"><div class="je-analytics-bar-fill" style="width:${barPct}%;"></div></div></td></tr>`;
    });
    html += `</tbody></table></div>`;
    return html;
  }

  // Current totals (not deltas), summed from v_current_totals, which picks
  // each install's own latest report before summing (installs report on
  // staggered schedules). brandingRow is folded in as a count-only card.
  function renderTotalCounts(rows, brandingRow) {
    if (!rows.length && !brandingRow) {
      return `<p><em>No total-count data reported yet.</em></p>`;
    }
    // Already aggregated server-side and capped/ordered by the fetch itself;
    // just order alphabetically for display.
    const latest = rows.slice().sort((a, b) => String(a.feature_key).localeCompare(String(b.feature_key)));

    let html = `<div class="je-stat-cards">`;
    latest.forEach(r => {
      const label = humanize(String(r.feature_key).slice(TOTAL_COUNT_PREFIX.length));
      html += `<div class="je-stat-card">
        <div class="je-stat-value">${num(r.total_count)}</div>
        <div class="je-stat-label-primary">${escapeHtml(label)}</div>
        <div class="je-stat-label-secondary">Present on ${num(r.nonzero_install_count)} of ${num(r.install_count)} reporting installs</div>
      </div>`;
    });
    if (brandingRow) {
      html += `<div class="je-stat-card">
        <div class="je-stat-value">${num(brandingRow.nonzero_install_count)}</div>
        <div class="je-stat-label-primary">Using Custom branding</div>
        <div class="je-stat-label-secondary">Used on ${num(brandingRow.nonzero_install_count)} of ${num(brandingRow.install_count)} reporting installs</div>
      </div>`;
    }
    html += `</div>`;
    return html;
  }

  // All generated by scripts/generate_config_flag_groups.py before every
  // docs build. A setting absent from the config page falls back to
  // "Other"/humanize(); one absent from defaults just shows no default.
  let FLAG_GROUPS_MAP = {};
  let FLAG_LABELS_MAP = {};
  let FLAG_TABS_MAP = {};
  let TAB_ICONS_MAP = {};
  let FLAG_DEFAULTS_MAP = {};

  async function loadFlagGroups(signal) {
    try {
      const res = await fetch(new URL('../config-flag-groups.json', window.location.href), { signal });
      if (res.ok) {
        const data = await res.json();
        FLAG_GROUPS_MAP = data.groups || {};
        FLAG_LABELS_MAP = data.labels || {};
        FLAG_TABS_MAP = data.tabs || {};
        TAB_ICONS_MAP = data.tabIcons || {};
        FLAG_DEFAULTS_MAP = data.defaults || {};
      }
    } catch (err) {
      // Non-fatal: everything just falls into "Other" / humanize() until this loads.
    }
  }

  // {type: "material", value: ligature} or {type: "img", src: url}; no icon
  // for "Other" (unmapped names) or if this tab genuinely has none.
  function iconFor(tabName) {
    const icon = TAB_ICONS_MAP[tabName];
    if (!icon) return '';
    if (icon.type === 'material') return `<i class="je-pill-icon" aria-hidden="true">${escapeHtml(icon.value)}</i>`;
    if (icon.type === 'img') return `<img class="je-pill-icon-img" src="${escapeHtml(icon.src)}" alt="" />`;
    return '';
  }

  function groupFor(flagName) {
    // Same hasOwnProperty guard as labeledName: flagName is report-supplied.
    return Object.prototype.hasOwnProperty.call(FLAG_GROUPS_MAP, flagName)
      ? FLAG_GROUPS_MAP[flagName] : 'Other';
  }

  function tabFor(flagName) {
    return Object.prototype.hasOwnProperty.call(FLAG_TABS_MAP, flagName)
      ? FLAG_TABS_MAP[flagName] : 'Other';
  }

  // Flat, sortable/filterable table with optional facet pills (e.g. by
  // "tab") above it. columns: {key, label, render(row), sortValue(row),
  // text(row) -- optional search haystack, defaults to sortValue}. Returns
  // {html, mount}; setSection calls mount(container) after insertion to
  // wire up click-to-sort/type-to-filter/pill-click via event delegation.
  function renderSortableTable(rows, columns, initialSortKey, facetKey, initialSortDir) {
    const uid = Math.random().toString(36).slice(2);
    const tbodyId = 'je-tbody-' + uid;
    let sortKey = initialSortKey || columns[0].key;
    let sortDir = initialSortDir || 'asc';
    let filterText = '';
    let activeFacet = null; // null = "All"

    const facetCol = facetKey ? columns.find(c => c.key === facetKey) : null;

    function haystack(row) {
      return columns.map(c => String((c.text || c.sortValue)(row))).join(' ').toLowerCase();
    }

    function visibleRows() {
      let filtered = facetCol && activeFacet !== null
        ? rows.filter(r => facetCol.sortValue(r) === activeFacet) : rows;
      if (filterText) filtered = filtered.filter(r => haystack(r).includes(filterText));
      const col = columns.find(c => c.key === sortKey);
      const dir = sortDir === 'asc' ? 1 : -1;
      return filtered.slice().sort((a, b) => {
        const av = col.sortValue(a), bv = col.sortValue(b);
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
      });
    }

    function renderRows() {
      const list = visibleRows();
      if (!list.length) return `<tr><td colspan="${columns.length}"><em>No matches.</em></td></tr>`;
      return list.map(row => `<tr>${columns.map(c => `<td>${c.render(row)}</td>`).join('')}</tr>`).join('');
    }

    function renderHead() {
      return columns.map(c => {
        const active = c.key === sortKey;
        return `<th class="je-sortable-th${active ? ' je-sort-active' : ''}" data-sort-key="${escapeHtml(c.key)}"${active ? ` aria-sort="${sortDir === 'asc' ? 'ascending' : 'descending'}"` : ''}><button type="button">${escapeHtml(c.label)}${active ? `<span aria-hidden="true">${sortDir === 'asc' ? ' ▲' : ' ▼'}</span>` : ''}</button></th>`;
      }).join('');
    }

    function facetCounts() {
      const counts = Object.create(null);
      rows.forEach(r => {
        const v = facetCol.sortValue(r);
        counts[v] = (counts[v] || 0) + 1;
      });
      return counts;
    }

    function renderPills() {
      if (!facetCol) return '';
      const counts = facetCounts();
      const names = Object.keys(counts).sort((a, b) => {
        if (a === 'Other') return 1;
        if (b === 'Other') return -1;
        return a.localeCompare(b);
      });
      // Icons are tab-icon data specifically, so only show them when this
      // facet actually is the tab column.
      const pill = (value, label, active, iconHtml) =>
        `<button type="button" class="je-pill${active ? ' je-pill-active' : ''}" aria-pressed="${active}" data-facet-value="${escapeHtml(value)}">${iconHtml || ''}${escapeHtml(label)}</button>`;
      return pill('', `All (${rows.length})`, activeFacet === null, '')
        + names.map(n => pill(n, `${n} (${counts[n]})`, activeFacet === n, facetKey === 'tab' ? iconFor(n) : '')).join('');
    }

    const html = `
      <div class="je-pill-row">${renderPills()}</div>
      <input type="text" class="je-table-search" placeholder="Filter…" />
      <div class="je-table-scroll"><table class="je-analytics-table"><thead><tr>${renderHead()}</tr></thead>
      <tbody id="${tbodyId}">${renderRows()}</tbody></table></div>
    `;

    function mount(container) {
      const pillRow = container.querySelector('.je-pill-row');
      const input = container.querySelector('.je-table-search');
      const thead = container.querySelector('thead');
      const tbody = container.querySelector('#' + tbodyId);

      if (pillRow) {
        pillRow.addEventListener('click', e => {
          const btn = e.target.closest('button[data-facet-value]');
          if (!btn) return;
          activeFacet = btn.dataset.facetValue || null;
          pillRow.innerHTML = renderPills();
          tbody.innerHTML = renderRows();
          pillRow.querySelector('.je-pill-active')?.focus();
        });
      }

      input.addEventListener('input', () => {
        filterText = input.value.trim().toLowerCase();
        tbody.innerHTML = renderRows();
      });

      thead.addEventListener('click', e => {
        const th = e.target.closest('th[data-sort-key]');
        if (!th) return;
        const key = th.dataset.sortKey;
        // Re-click flips direction; a new column starts at its natural
        // direction (numeric/date columns: biggest/newest first).
        if (key === sortKey) {
          sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          sortDir = columns.find(c => c.key === key).firstDir || 'asc';
          sortKey = key;
        }
        thead.innerHTML = renderHead();
        tbody.innerHTML = renderRows();
        thead.querySelector('.je-sort-active button').focus();
      });
    }

    return { html, mount };
  }

  function renderFlagRates(rows) {
    const reporting = rows.filter(r => num(r.reporting_count) > 0);
    if (!reporting.length) {
      return `<p><em>No config-flag data reported yet.</em></p>`;
    }

    const items = reporting.map(r => {
      // hasOwnProperty guard: r.flag_name is report-supplied.
      const hasDefault = Object.prototype.hasOwnProperty.call(FLAG_DEFAULTS_MAP, r.flag_name);
      return {
        tab: tabFor(r.flag_name),
        group: groupFor(r.flag_name),
        flagName: r.flag_name,
        label: Object.prototype.hasOwnProperty.call(FLAG_LABELS_MAP, r.flag_name) ? FLAG_LABELS_MAP[r.flag_name] : humanize(r.flag_name),
        defaultOn: hasDefault ? FLAG_DEFAULTS_MAP[r.flag_name] : null,
        enabledPct: pct(r.enabled_pct),
      };
    });

    const columns = [
      { key: 'tab', label: 'Tab', sortValue: i => i.tab, render: i => escapeHtml(i.tab) },
      { key: 'group', label: 'Group', sortValue: i => i.group, render: i => escapeHtml(i.group) },
      { key: 'toggle', label: 'Feature toggle', sortValue: i => i.label, text: i => `${i.label} ${i.flagName}`, render: i => labeledName(i.flagName) },
      { key: 'default', label: 'Default', sortValue: i => i.defaultOn === null ? -1 : (i.defaultOn ? 1 : 0), render: i => i.defaultOn === null ? '—' : (i.defaultOn ? 'ON' : 'OFF') },
      { key: 'pct', label: '% ON', sortValue: i => i.enabledPct, render: i => barCell(i.enabledPct) },
    ];

    // Faceted by tab, sorted by group -- sorting by tab would be a no-op
    // once narrowed to one pill.
    return renderSortableTable(items, columns, 'group', 'tab');
  }

  // One row per (setting, value) pair -- e.g. IconStyle contributes a
  // "lucide" row and a "material" row, each with its own install share.
  function renderSettingValues(rows) {
    if (!rows.length) {
      return `<p><em>No settings data reported yet.</em></p>`;
    }

    // Object.create(null): setting_name is report-supplied, and a name like
    // "toString" hitting an inherited member would throw and blank the page.
    const bySetting = Object.create(null);
    rows.forEach(r => { (bySetting[r.setting_name] = bySetting[r.setting_name] || []).push(r); });

    const items = [];
    Object.keys(bySetting).forEach(name => {
      const values = bySetting[name];
      const total = values.reduce((sum, v) => sum + num(v.install_count), 0);
      // hasOwnProperty guard: name is report-supplied.
      const hasDefault = Object.prototype.hasOwnProperty.call(FLAG_DEFAULTS_MAP, name);
      const defaultValue = hasDefault ? String(FLAG_DEFAULTS_MAP[name]) : null;
      // Always humanize(), never the config page's short contextual label
      // (e.g. "Position") -- on the real config page that's unambiguous
      // because it's visually nested under a "Quality Tags"/"Genre Tags"/etc.
      // heading, but flattened into one table it isn't, and the Group column
      // ("Media Tags") is too coarse to disambiguate on its own.
      const label = humanize(name);
      values.forEach(v => {
        items.push({
          tab: tabFor(name),
          group: groupFor(name),
          settingName: name,
          label,
          value: String(v.setting_value),
          installCount: num(v.install_count),
          sharePct: total > 0 ? pct(Math.round((num(v.install_count) / total) * 100)) : 0,
          isDefault: defaultValue !== null && String(v.setting_value) === defaultValue,
        });
      });
    });

    const columns = [
      { key: 'tab', label: 'Tab', sortValue: i => i.tab, render: i => escapeHtml(i.tab) },
      { key: 'group', label: 'Group', sortValue: i => i.group, render: i => escapeHtml(i.group) },
      { key: 'setting', label: 'Setting', sortValue: i => i.label, text: i => `${i.label} ${i.settingName}`, render: i => `<span title="${escapeHtml(i.settingName)}">${escapeHtml(i.label)}</span>` },
      { key: 'value', label: 'Value', sortValue: i => i.value, render: i => escapeHtml(i.value) + (i.isDefault ? ' <em>(default)</em>' : '') },
      { key: 'installs', label: 'Installs', sortValue: i => i.installCount, render: i => String(i.installCount) },
      { key: 'share', label: '%', sortValue: i => i.sharePct, render: i => barCell(i.sharePct) },
    ];

    // Faceted by tab, sorted by group -- sorting by tab would be a no-op
    // once narrowed to one pill.
    return renderSortableTable(items, columns, 'group', 'tab');
  }

  // A section that throws renders its own error line rather than blanking
  // the whole dashboard. Accepts a plain HTML string or {html, mount} (for
  // renderers needing to wire up interactivity once inserted into the DOM).
  function setSection(id, fn, ...args) {
    const el = document.getElementById(id);
    if (!el) return;
    try {
      const result = fn(...args);
      if (result && typeof result === 'object' && typeof result.mount === 'function') {
        el.innerHTML = result.html;
        result.mount(el);
      } else {
        el.innerHTML = result;
      }
    } catch (err) {
      el.innerHTML = `<p class="je-analytics-error">Couldn't render this section (${escapeHtml(err && err.message ? err.message : err)}).</p>`;
    }
  }

  async function render(root, signal) {
    const loadingEl = document.getElementById('je-analytics-loading');
    const errorEl = document.getElementById('je-analytics-error-banner');
    try {
      // Explicit order= on every view: an unordered query plus fetchView's row
      // limit would let PostgREST truncate an arbitrary subset once a view
      // outgrows it, instead of deterministically keeping the top rows.
      const [versionRows, windowRows, totalRows, brandingRows, flagRows, settingRows] = await Promise.all([
        fetchView("v_version_adoption", "select=*&order=most_recent_seen.desc", signal),
        fetchView("v_feature_usage_window", "select=*&order=total_count.desc&limit=20", signal),
        fetchView("v_current_totals", "select=*&order=total_count.desc&limit=24", signal),
        fetchView("v_branding_usage", "select=*", signal),
        fetchView("v_config_flag_rates", "select=*&order=enabled_pct.desc", signal),
        fetchView("v_config_setting_values", "select=*&order=install_count.desc", signal),
        loadFlagGroups(signal)
      ]);

      if (signal.aborted || !root.isConnected || root !== activeRoot) return;

      setSection('je-section-versions', renderVersionCards, versionRows);
      setSection('je-section-totals', renderTotalCounts, totalRows, brandingRows[0]);
      setSection('je-section-usage', renderUsageTable, windowRows);
      setSection('je-section-flags', renderFlagRates, flagRows);
      setSection('je-section-settings', renderSettingValues, settingRows);

      const updatedEl = document.getElementById('je-analytics-updated');
      if (updatedEl) updatedEl.textContent = 'Loaded live just now from the community analytics project. Refresh this page any time for current numbers.';
      if (loadingEl) loadingEl.remove();
    } catch (err) {
      if (signal.aborted || !root.isConnected || root !== activeRoot) return;
      if (loadingEl) loadingEl.remove();
      if (errorEl) {
        errorEl.hidden = false;
        errorEl.textContent = `Couldn't load live analytics data right now (${err.message}). Try refreshing.`;
      }
    }
  }

  function onPage() {
    const root = document.getElementById('je-analytics-dashboard');
    if (root === activeRoot) return;
    if (activeController) activeController.abort();
    activeRoot = root;
    activeController = null;
    if (!root) return;
    activeController = new AbortController();
    render(root, activeController.signal);
  }

  window.jeAnalyticsDashboard = {
    dispose() {
      if (activeController) activeController.abort();
      if (subscription) subscription.unsubscribe();
      activeRoot = null;
    }
  };
  if (typeof document$ !== 'undefined') subscription = document$.subscribe(onPage);
  onPage();
})();
</script>
