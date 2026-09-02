# Community Analytics

Jellyfin Enhanced can optionally report a small set of anonymous usage statistics back to a
community analytics project, entirely **opt-in and off by default**. Nothing is sent unless an
admin turns it on from the plugin's config page (**Admin → Usage Statistics**), and that page shows
the exact payload before it's ever sent.

This page shows the current aggregate results, live, straight from the same database every opted-in
install reports to. It reads six public, read-only views. No per-install data, no IP addresses, no
identifying information of any kind is exposed here or anywhere in this system.

!!! info "What these numbers are, and aren't"
    These figures cover **only installs that have explicitly opted in**. <br>They are not a total
    install count for Jellyfin Enhanced, and shouldn't be read as one, since opting in is off by
    default, so this is a self-selected sample, not a census. Use it to see feature-usage
    *trends among reporting installs*, not overall adoption or reach.

## What's collected

The config page's **Preview** button always shows the exact JSON that would be sent, built from
the same code that does the real send. What follows is the
detailed breakdown of what that JSON can contain.

### Always included
(even with every option below unchecked)

Turning the master toggle on alone, with all three categories below left unchecked, sends only:

- A random install ID (server-minted, never derived from anything about you or your server)
- The plugin version
- The Jellyfin server version and build target (`jf10`/`jf12`)
- The reporting period's start date

Enough to answer "how many installs are on the latest version" and nothing else.

!!! info
    Despite the heading, "always" means "with every report", not "unconditionally": nothing at all
    is sent until the master toggle is enabled and saved.

### Feature toggle states

Every `bool` setting in the plugin's config (on/off only), reflected automatically, so a newly
added toggle is automatically added in the next sync. See the **Feature toggle adoption** section below
for the live, current, complete list, grouped by settings-page section.

Also included: two derived "is a key configured" flags (`TmdbEnabled`, `MdblistEnabled`), showing
whether a TMDB/MDBList API key is set, **never the key itself**, and a small, explicitly hand-picked
set of non-boolean fixed-choice settings, since a string *could* be a URL or API key and only
specific ones are ever safe to include:

- Icon style (`IconStyle`)
- Maintenance Mode action (`MaintenanceModeAction`), and whether it applies to all users or a
  selection (`MaintenanceModeAffectedUsers`, sent only as `all`/`selected` — the actual user
  selection never leaves your server)
- Tag overlay positions (`QualityTagsPosition`, `GenreTagsPosition`, `LanguageTagsPosition`, `RatingTagsPosition`)
- Language tag priority list (`LanguageTagsPriority`) — normalized before sending: only tokens
  shaped like language codes (e.g. `en,ja,fr`) are included, anything else typed into that box is
  dropped

No other string setting is ever included: URLs, API keys, branding text/images, and every other
free-text field are permanently excluded by design, not by an admin-configurable option.

### Feature usage counts

- **Seerr requests submitted**: a counter that goes up by one each time you submit a request, sent
  each report, then reset to zero, so it tracks recent activity rather than an ever-growing total.
- **Item totals**: bookmarks, hidden-content items, spoiler-blur items, and reviews. Instead of
  counting an action, the plugin just counts what's currently in each file, every time it reports.
  Shown on the dashboard as: total count, how many installs have at least one, and how many
  installs reported at all.

Counts only, always: never which items, never any title or content, never who specifically.

### Data file sizes

Byte size only (never contents) of the custom branding folder, if anything has been uploaded there
(logo/banner/favicon images). This answers "is this feature actually used" the same way the usage
counts above do for other features.

## Live Dashboard

<p id="je-analytics-loading">Loading live data…</p>
<p id="je-analytics-error-banner" class="je-analytics-error" hidden></p>

### Installs & Versions

<div id="je-section-versions"></div>

### Current Totals

<p class="je-section-subtitle">Across reporting installs</p>

<div id="je-section-totals"></div>

### Feature Usage

<p class="je-section-subtitle">Last 45 days</p>

<div id="je-section-usage"></div>

### Feature Toggle Adoption

<div id="je-section-flags"></div>

### Settings Distribution

<div id="je-section-settings"></div>

<p class="je-analytics-updated" id="je-analytics-updated"></p>

<style>
#je-analytics-error-banner { margin: 1em 0; }
.je-section-subtitle { opacity: 0.65; font-size: 0.9em; margin-top: -0.6em; }
.je-stat-cards { display: flex; flex-wrap: wrap; gap: 1em; margin: 1em 0; }
.je-stat-card {
  flex: 1 1 200px;
  border: 1px solid var(--md-default-fg-color--lightest, #ddd);
  border-radius: 8px;
  padding: 1em 1.2em;
}
.je-stat-card .je-stat-value { font-size: 1.8em; font-weight: 700; }
.je-stat-card .je-stat-label { opacity: 0.7; font-size: 0.85em; }
.je-stat-card .je-stat-label-primary { font-size: 1.05em; font-weight: 600; margin-top: 0.4em; }
.je-stat-card .je-stat-label-secondary { opacity: 0.65; font-size: 0.6em; margin-top: 0.15em; }
.je-analytics-table { width: 100%; border-collapse: collapse; margin: 1em 0; }
.je-analytics-table th, .je-analytics-table td {
  text-align: left; padding: 0.4em 0.7em; border-bottom: 1px solid var(--md-default-fg-color--lightest, #ddd);
  font-size: 0.9em;
}
.je-analytics-bar-track {
  background: var(--md-default-fg-color--lightest, #eee);
  border-radius: 4px; height: 8px; width: 100%; overflow: hidden;
}
.je-analytics-bar-fill { background: var(--md-accent-fg-color, #7c4dff); height: 100%; }
.je-analytics-updated { font-size: 0.8em; opacity: 0.6; margin-top: 1.5em; }
.je-analytics-error { color: #c0392b; }
.je-analytics-mismatch { color: #d35400; font-weight: 600; }
.je-flag-group { border: 1px solid var(--md-default-fg-color--lightest, #ddd); border-radius: 8px; margin: 0.6em 0; padding: 0.2em 1em; }
.je-flag-group summary { cursor: pointer; padding: 0.6em 0; font-weight: 600; }
.je-flag-group table { margin-top: 0; margin-bottom: 0.8em; }
.je-flag-raw { opacity: 0.55; font-size: 0.8em; }
</style>

<script>
(function() {
  const SUPABASE_URL = "https://cgsdfzfdoxunzoofzhgd.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_ShFKE3ognn7ZgncCGmCR-A_R1tPApiW";

  // Hard cap on rows pulled from any one view. report_stats is reachable by
  // anyone holding the anon key, so a flood of forged installs shouldn't be
  // able to make every visitor download/render unbounded rows.
  const MAX_ROWS = 500;

  async function fetchView(name, query) {
    const q = query || "select=*";
    const withLimit = /(^|&)limit=/.test(q) ? q : `${q}&limit=${MAX_ROWS}`;
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${name}?${withLimit}`, {
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

  // Prefers the config page's real label text over the humanize() fallback.
  function labeledName(rawName) {
    // hasOwnProperty guard: rawName is report-supplied, so a name like
    // "toString" or "constructor" would otherwise pull a function off
    // Object.prototype instead of a label.
    const display = Object.prototype.hasOwnProperty.call(FLAG_LABELS_MAP, rawName)
      ? FLAG_LABELS_MAP[rawName] : humanize(rawName);
    return `${escapeHtml(display)}<br/><code class="je-flag-raw">${escapeHtml(rawName)}</code>`;
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
      <div class="je-stat-card"><div class="je-stat-value">${totalInstalls}</div><div class="je-stat-label">Reporting installs</div></div>`;
    // Cap BY COUNT, not alphabetically: jellyfin_target is attacker-mintable.
    Object.keys(byTarget).sort((a, b) => byTarget[b] - byTarget[a]).slice(0, 12).forEach(target => {
      html += `<div class="je-stat-card"><div class="je-stat-value">${byTarget[target]}</div><div class="je-stat-label">on ${escapeHtml(target)}</div></div>`;
    });
    html += `</div>`;

    html += `<table class="je-analytics-table"><thead><tr><th>Plugin Version</th><th>Jellyfin Target</th><th>Jellyfin Version</th><th>Installs</th><th>Recently Seen On</th></tr></thead><tbody>`;
    rows.sort((a, b) => num(b.install_count) - num(a.install_count)).slice(0, 50).forEach(r => {
      const seen = formatDateDMY(new Date(r.most_recent_seen));
      const mismatch = isTargetMismatch(r.jellyfin_target, r.jellyfin_version);
      const versionCell = mismatch
        ? `<span class="je-analytics-mismatch" title="This build target doesn't match the running server's major version">${escapeHtml(r.jellyfin_version)} ⚠</span>`
        : escapeHtml(r.jellyfin_version);
      html += `<tr><td>${escapeHtml(r.plugin_version)}</td><td>${escapeHtml(r.jellyfin_target)}</td><td>${versionCell}</td><td>${num(r.install_count)}</td><td>${seen}</td></tr>`;
    });
    html += `</tbody></table>`;
    return html;
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
    html += `<table class="je-analytics-table"><thead><tr><th>Feature key</th><th>Total uses</th><th>Installs reporting it</th><th></th></tr></thead><tbody>`;
    rows.forEach(r => {
      const barPct = pct(Math.round((num(r.total_count) / maxCount) * 100));
      html += `<tr><td>${labeledName(String(r.feature_key || ''))}</td><td>${num(r.total_count)}</td><td>${num(r.install_count)}</td>
        <td style="width:120px;"><div class="je-analytics-bar-track"><div class="je-analytics-bar-fill" style="width:${barPct}%;"></div></div></td></tr>`;
    });
    html += `</tbody></table>`;
    return html;
  }

  // Current totals (not deltas), summed from v_current_totals, which picks
  // each install's own latest report before summing -- installs report on
  // staggered schedules, so picking a single global "most recent period"
  // would drop every install that didn't happen to report that exact date.
  // brandingRow (from v_branding_usage) is folded in as a count-only card.
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

  // Both generated from configPage.html's fieldset/legend/label structure by
  // scripts/generate_config_flag_groups.py, run before every docs build. A
  // setting absent from the config page falls back to "Other" / humanize().
  let FLAG_GROUPS_MAP = {};
  let FLAG_LABELS_MAP = {};

  async function loadFlagGroups() {
    try {
      const res = await fetch('../config-flag-groups.json');
      if (res.ok) {
        const data = await res.json();
        FLAG_GROUPS_MAP = data.groups || {};
        FLAG_LABELS_MAP = data.labels || {};
      }
    } catch (err) {
      // Non-fatal: everything just falls into "Other" / humanize() until this loads.
    }
  }

  function groupFor(flagName) {
    // Same hasOwnProperty guard as labeledName: flagName is report-supplied.
    return Object.prototype.hasOwnProperty.call(FLAG_GROUPS_MAP, flagName)
      ? FLAG_GROUPS_MAP[flagName] : 'Other';
  }

  function renderFlagRates(rows) {
    const reporting = rows.filter(r => num(r.reporting_count) > 0);
    if (!reporting.length) {
      return `<p><em>No config-flag data reported yet.</em></p>`;
    }

    const groups = Object.create(null);
    reporting.forEach(r => {
      const g = groupFor(r.flag_name);
      (groups[g] = groups[g] || []).push(r);
    });

    // Named groups alphabetically first, "Other" always last.
    const groupNames = Object.keys(groups).sort((a, b) => {
      if (a === 'Other') return 1;
      if (b === 'Other') return -1;
      return a.localeCompare(b);
    });

    return groupNames.map(g => {
      // Cap rows per group BY reporting_count, then alphabetical for display:
      // flag_name is attacker-mintable via report_stats, and an alphabetical
      // cut would let forged names that sort first evict genuine rows.
      const items = groups[g]
        .sort((a, b) => num(b.reporting_count) - num(a.reporting_count)).slice(0, 200)
        .sort((a, b) => String(a.flag_name).localeCompare(String(b.flag_name)));
      let rowsHtml = items.map(r => `<tr><td>${labeledName(r.flag_name)}</td><td>${pct(r.enabled_pct)}%</td>
        <td style="width:120px;"><div class="je-analytics-bar-track"><div class="je-analytics-bar-fill" style="width:${pct(r.enabled_pct)}%;"></div></div></td></tr>`).join('');
      return `<details class="je-flag-group">
        <summary>${escapeHtml(g)} (${items.length})</summary>
        <table class="je-analytics-table"><thead><tr><th>Feature toggle</th><th>% of reporting installs with it ON</th><th></th></tr></thead>
        <tbody>${rowsHtml}</tbody></table>
      </details>`;
    }).join('');
  }

  // Groups by setting_name and shows the distribution of values reported for
  // it (e.g. IconStyle: lucide 62%, material 38%), not a % ON like
  // renderFlagRates, since these aren't booleans.
  function renderSettingValues(rows) {
    if (!rows.length) {
      return `<p><em>No settings data reported yet.</em></p>`;
    }

    // Object.create(null): setting_name is report-supplied, and a name like
    // "toString" hitting an inherited member would throw and blank the page.
    const bySetting = Object.create(null);
    rows.forEach(r => { (bySetting[r.setting_name] = bySetting[r.setting_name] || []).push(r); });

    // Cap BY total reporting installs, then alphabetical for display:
    // setting_name is attacker-mintable, and an alphabetical cut would let
    // forged names that sort first evict the genuine settings.
    const totalFor = name => bySetting[name].reduce((s, v) => s + num(v.install_count), 0);
    const names = Object.keys(bySetting)
      .sort((a, b) => totalFor(b) - totalFor(a)).slice(0, 100)
      .sort((a, b) => a.localeCompare(b));

    return names.map(name => {
      // Cap values per setting too — setting_value is equally forgeable.
      const values = bySetting[name].slice().sort((a, b) => num(b.install_count) - num(a.install_count)).slice(0, 100);
      const total = values.reduce((sum, v) => sum + num(v.install_count), 0);
      const rowsHtml = values.map(v => {
        const barPct = total > 0 ? pct(Math.round((num(v.install_count) / total) * 100)) : 0;
        return `<tr><td>${escapeHtml(v.setting_value)}</td><td>${num(v.install_count)}</td><td>${barPct}%</td>
          <td style="width:120px;"><div class="je-analytics-bar-track"><div class="je-analytics-bar-fill" style="width:${barPct}%;"></div></div></td></tr>`;
      }).join('');
      return `<details class="je-flag-group">
        <summary>${labeledName(name)} (${total} reporting)</summary>
        <table class="je-analytics-table"><thead><tr><th>Value</th><th>Installs</th><th>%</th><th></th></tr></thead>
        <tbody>${rowsHtml}</tbody></table>
      </details>`;
    }).join('');
  }

  // One poisoned view must not blank the whole dashboard: a section that
  // throws renders its own error line into its own div, every other section
  // still shows. Headings are static Markdown (so the sidebar TOC picks them
  // up at build time); this only fills the content div underneath each one.
  function setSection(id, fn, ...args) {
    const el = document.getElementById(id);
    if (!el) return;
    try {
      el.innerHTML = fn(...args);
    } catch (err) {
      el.innerHTML = `<p class="je-analytics-error">Couldn't render this section (${escapeHtml(err && err.message ? err.message : err)}).</p>`;
    }
  }

  async function render() {
    const loadingEl = document.getElementById('je-analytics-loading');
    const errorEl = document.getElementById('je-analytics-error-banner');
    try {
      // Explicit order= on every view: an unordered query plus fetchView's row
      // limit would let PostgREST truncate an arbitrary subset once a view
      // outgrows it, instead of deterministically keeping the top rows.
      const [versionRows, windowRows, totalRows, brandingRows, flagRows, settingRows] = await Promise.all([
        fetchView("v_version_adoption", "select=*&order=most_recent_seen.desc"),
        fetchView("v_feature_usage_window", "select=*&order=total_count.desc&limit=20"),
        fetchView("v_current_totals", "select=*&order=total_count.desc&limit=24"),
        fetchView("v_branding_usage", "select=*"),
        fetchView("v_config_flag_rates", "select=*&order=enabled_pct.desc"),
        fetchView("v_config_setting_values", "select=*&order=install_count.desc"),
        loadFlagGroups()
      ]);

      setSection('je-section-versions', renderVersionCards, versionRows);
      setSection('je-section-totals', renderTotalCounts, totalRows, brandingRows[0]);
      setSection('je-section-usage', renderUsageTable, windowRows);
      setSection('je-section-flags', renderFlagRates, flagRows);
      setSection('je-section-settings', renderSettingValues, settingRows);

      const updatedEl = document.getElementById('je-analytics-updated');
      if (updatedEl) updatedEl.textContent = 'Loaded live just now from the community analytics project. Refresh this page any time for current numbers.';
      if (loadingEl) loadingEl.remove();
    } catch (err) {
      if (loadingEl) loadingEl.remove();
      if (errorEl) {
        errorEl.hidden = false;
        errorEl.textContent = `Couldn't load live analytics data right now (${err.message}). Try refreshing.`;
      }
    }
  }

  render();
})();
</script>
