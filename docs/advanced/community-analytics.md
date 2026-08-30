# Community Analytics

Jellyfin Enhanced can optionally report a small set of anonymous usage statistics back to a
community analytics project, entirely **opt-in and off by default**. Nothing is sent unless an
admin turns it on from the plugin's config page (**Admin → Usage Statistics**), and that page shows
the exact payload before it's ever sent.

This page shows the current aggregate results, live, straight from the same database every opted-in
install reports to. It reads four public, read-only views. No per-install data, no IP addresses, no
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

<div id="je-analytics-dashboard">
  <p id="je-analytics-loading">Loading live data…</p>
</div>

<style>
#je-analytics-dashboard { margin-top: 1.5em; }
.je-stat-cards { display: flex; flex-wrap: wrap; gap: 1em; margin: 1em 0; }
.je-stat-card {
  flex: 1 1 200px;
  border: 1px solid var(--md-default-fg-color--lightest, #ddd);
  border-radius: 8px;
  padding: 1em 1.2em;
}
.je-stat-card .je-stat-value { font-size: 1.8em; font-weight: 700; }
.je-stat-card .je-stat-label { opacity: 0.7; font-size: 0.85em; }
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

  // Hard cap on rows pulled from any one view. The report_stats/register_install
  // RPCs are reachable by anyone holding the anon key on this page, so a
  // distinct plugin_version/target/flag_name/setting_name string is
  // attacker-mintable; without a limit a flood of forged installs would make
  // every visitor's browser download and render thousands of rows. Each
  // renderer additionally slices to what it displays.
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

  // Numeric coercion for every count/percentage field before it goes into
  // innerHTML. These come from the public views and are ultimately derived
  // from attacker-forgeable report_stats input; the string fields are already
  // escapeHtml'd, so coercing the numeric ones closes the last report-derived
  // path into the DOM (and keeps style="width:N%" well-formed and the
  // sort/reduce/Math math honest against a non-numeric value).
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

  // Fallback only: same heuristic as the config page's own
  // jeHumanizeSettingId. Used when FLAG_LABELS_MAP has nothing for a name
  // (e.g. a "total.*" analytics key, which was never a config-page control
  // to begin with).
  function humanize(name) {
    // String() guard: name can originate from a report-supplied field.
    const s = String(name == null ? '' : name);
    const spaced = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  }

  // Prefers the real label text captured from the config page itself (see
  // FLAG_LABELS_MAP below) over the algorithmic humanize() fallback, so e.g.
  // "RecommendationsUseNativeTab" reads as "Add Recommendations as a native
  // Home tab" (its actual checkbox text) instead of "Recommendations Use
  // Native Tab".
  function labeledName(rawName) {
    // hasOwnProperty guard: rawName is report-supplied, so a name like
    // "toString" or "constructor" would otherwise pull a function off
    // Object.prototype instead of a label.
    const display = Object.prototype.hasOwnProperty.call(FLAG_LABELS_MAP, rawName)
      ? FLAG_LABELS_MAP[rawName] : humanize(rawName);
    return `${escapeHtml(display)}<br/><code class="je-flag-raw">${escapeHtml(rawName)}</code>`;
  }

  // A "jf10" build reports a jellyfin_version starting with "12." (or a
  // "jf12" build reporting "10." / "11.") when someone installs the build
  // for the other major version: both run since the request-time
  // injection middleware is plain ASP.NET and works on either runtime, but
  // it's still worth surfacing as its own signal rather than only the
  // matched pairing.
  function isTargetMismatch(target, jellyfinVersion) {
    // Compare major-version ranges (jf10 <-> 10.x/11.x, jf12 <-> 12.x and
    // later) rather than keying on startsWith('12.'), which would flag every
    // jf12 install the day Jellyfin 13 ships and miss a jf10 build on it.
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
    // Cap per-target cards BY COUNT: a distinct jellyfin_target is
    // attacker-mintable, and an alphabetical cut would let forged names that
    // sort first evict the genuine jf10/jf12 cards.
    Object.keys(byTarget).sort((a, b) => byTarget[b] - byTarget[a]).slice(0, 12).forEach(target => {
      html += `<div class="je-stat-card"><div class="je-stat-value">${byTarget[target]}</div><div class="je-stat-label">on ${escapeHtml(target)}</div></div>`;
    });
    html += `</div>`;

    html += `<table class="je-analytics-table"><thead><tr><th>Plugin Target</th><th>Jellyfin target</th><th>Jellyfin version</th><th>Installs</th><th>Most recently seen</th></tr></thead><tbody>`;
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

  // "total.*" keys are point-in-time snapshots (current item counts read
  // straight off disk, e.g. total.bookmarks) reported through the same
  // usage_events pipeline as real per-period action counters (e.g.
  // bookmarks.created), but the two mean very different things, so they're
  // rendered in separate sections rather than one table that could be misread
  // either way.
  const TOTAL_COUNT_PREFIX = 'total.';

  // Periods are report-supplied and the anon key is public, so treat them as
  // hostile: validate the shape strictly (a pseudo-date like "2026-08-2z"
  // passes a lexicographic compare and renders as NaN), reject the future,
  // and aggregate over a TRAILING WINDOW rather than "the single most recent
  // period" — genuine installs report period STARTS up to 30 days old, so
  // one forged row stamped with today's date would otherwise become the only
  // period shown and hide every real install's rows.
  const PERIOD_RE = /^\d{4}-\d{2}-\d{2}$/;
  const TODAY = new Date().toISOString().slice(0, 10);
  const WINDOW_DAYS = 45; // max reporting interval (30d) + slack
  const WINDOW_START = new Date(Date.now() - WINDOW_DAYS * 864e5).toISOString().slice(0, 10);
  function recentValidPeriods(rows) {
    return rows.filter(r => typeof r.period === 'string' && PERIOD_RE.test(r.period)
      && r.period <= TODAY && r.period >= WINDOW_START);
  }

  function renderUsageTable(rows) {
    const deltaRows = recentValidPeriods(rows).filter(r => !String(r.feature_key || '').startsWith(TOTAL_COUNT_PREFIX));
    if (!deltaRows.length) {
      return `<p><em>No usage-count data reported yet. This fills in once opted-in installs have accumulated activity over a reporting cycle.</em></p>`;
    }
    // Aggregate per key across the whole window: counts sum (per-period
    // deltas), install counts take the max — the same install can appear in
    // several periods, so summing those would double-count it.
    const byKey = Object.create(null);
    deltaRows.forEach(r => {
      const k = String(r.feature_key || '');
      const e = byKey[k] || (byKey[k] = { total: 0, installs: 0 });
      e.total += num(r.total_count);
      e.installs = Math.max(e.installs, num(r.install_count));
    });
    const latest = Object.keys(byKey).map(k => ({ key: k, total: byKey[k].total, installs: byKey[k].installs }))
      .sort((a, b) => b.total - a.total).slice(0, 20);
    const maxCount = Math.max(...latest.map(r => r.total), 1);

    let html = `<p>Activity reported over the trailing <strong>${WINDOW_DAYS}-day</strong> window (top 20 keys):</p>`;
    html += `<table class="je-analytics-table"><thead><tr><th>Feature key</th><th>Total uses</th><th>Installs reporting it</th><th></th></tr></thead><tbody>`;
    latest.forEach(r => {
      const barPct = pct(Math.round((r.total / maxCount) * 100));
      html += `<tr><td>${labeledName(r.key)}</td><td>${r.total}</td><td>${r.installs}</td>
        <td style="width:120px;"><div class="je-analytics-bar-track"><div class="je-analytics-bar-fill" style="width:${barPct}%;"></div></div></td></tr>`;
    });
    html += `</tbody></table>`;
    return html;
  }

  // Current totals (not deltas) summed across every reporting install's most
  // recent report: "how many bookmarks exist right now, across every
  // opted-in server", not "how many were created this period". Adoption
  // (nonzero_install_count) comes straight from the view, no per-user
  // scanning needed: a per-install total.X of 0 vs. >0 is all it takes to
  // know whether that install has any at all.
  function renderTotalCounts(rows) {
    const totalRows = recentValidPeriods(rows).filter(r => String(r.feature_key || '').startsWith(TOTAL_COUNT_PREFIX));
    if (!totalRows.length) {
      return `<p><em>No total-count data reported yet.</em></p>`;
    }
    // Point-in-time snapshots: per key keep only its most recent period's row
    // (summing across periods would double-count the same installs).
    const byKey = Object.create(null);
    totalRows.forEach(r => {
      const k = String(r.feature_key || '');
      if (!byKey[k] || r.period > byKey[k].period) byKey[k] = r;
    });
    // Cap BY COUNT, not alphabetically: total.* keys are attacker-mintable
    // via direct report_stats calls, and an alphabetical slice would let a
    // few forged names that sort first evict every genuine card. Rank by
    // count for the cut, then alphabetical for display.
    const latest = Object.values(byKey)
      .sort((a, b) => num(b.total_count) - num(a.total_count)).slice(0, 24)
      .sort((a, b) => String(a.feature_key).localeCompare(String(b.feature_key)));

    let html = `<div class="je-stat-cards">`;
    latest.forEach(r => {
      const label = humanize(String(r.feature_key).slice(TOTAL_COUNT_PREFIX.length));
      html += `<div class="je-stat-card">
        <div class="je-stat-value">${num(r.total_count)}</div>
        <div class="je-stat-label">${escapeHtml(label)}</div>
        <div class="je-stat-label">${num(r.nonzero_install_count)} of ${num(r.install_count)} reporting installs</div>
      </div>`;
    });
    html += `</div>`;
    return html;
  }

  // Both generated from configPage.html's own fieldset/legend/label
  // structure by scripts/generate_config_flag_groups.py (run automatically
  // before every docs build), so a setting's group and display text here
  // always match what's actually on the config page, with nothing to
  // hand-maintain. A setting genuinely absent from the config page
  // (internal bookkeeping, no admin-facing control) has neither and falls
  // back to "Other" / the algorithmic humanize().
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

    return groupNames.map((g, i) => {
      // Cap rows per group BY reporting_count, then alphabetical for display:
      // flag_name is attacker-mintable via report_stats, and an alphabetical
      // cut would let forged names that sort first evict genuine rows.
      const items = groups[g]
        .sort((a, b) => num(b.reporting_count) - num(a.reporting_count)).slice(0, 200)
        .sort((a, b) => String(a.flag_name).localeCompare(String(b.flag_name)));
      let rowsHtml = items.map(r => `<tr><td>${labeledName(r.flag_name)}</td><td>${pct(r.enabled_pct)}%</td>
        <td style="width:120px;"><div class="je-analytics-bar-track"><div class="je-analytics-bar-fill" style="width:${pct(r.enabled_pct)}%;"></div></div></td></tr>`).join('');
      return `<details class="je-flag-group"${i === 0 ? ' open' : ''}>
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

    return names.map((name, i) => {
      // Cap values per setting too — setting_value is equally forgeable.
      const values = bySetting[name].slice().sort((a, b) => num(b.install_count) - num(a.install_count)).slice(0, 100);
      const total = values.reduce((sum, v) => sum + num(v.install_count), 0);
      const rowsHtml = values.map(v => {
        const barPct = total > 0 ? pct(Math.round((num(v.install_count) / total) * 100)) : 0;
        return `<tr><td>${escapeHtml(v.setting_value)}</td><td>${num(v.install_count)}</td><td>${barPct}%</td>
          <td style="width:120px;"><div class="je-analytics-bar-track"><div class="je-analytics-bar-fill" style="width:${barPct}%;"></div></div></td></tr>`;
      }).join('');
      return `<details class="je-flag-group"${i === 0 ? ' open' : ''}>
        <summary>${labeledName(name)} (${total} reporting)</summary>
        <table class="je-analytics-table"><thead><tr><th>Value</th><th>Installs</th><th>%</th><th></th></tr></thead>
        <tbody>${rowsHtml}</tbody></table>
      </details>`;
    }).join('');
  }

  // One poisoned view's data must not blank the whole dashboard: a section
  // that throws renders its own error line while every other section still
  // shows.
  function renderSection(titleHtml, fn, rows) {
    let body;
    try {
      body = fn(rows);
    } catch (err) {
      body = `<p class="je-analytics-error">Couldn't render this section (${escapeHtml(err && err.message ? err.message : err)}).</p>`;
    }
    return `<h3>${titleHtml}</h3>${body}`;
  }

  async function render() {
    const el = document.getElementById("je-analytics-dashboard");
    try {
      // Explicit order= on every view: with the row limit in fetchView, an
      // unordered query would let PostgREST truncate an arbitrary subset once
      // a view outgrows the limit — ordering makes the kept rows the newest/
      // biggest ones deterministically.
      const [versionRows, usageRows, flagRows, settingRows] = await Promise.all([
        fetchView("v_version_adoption", "select=*&order=most_recent_seen.desc"),
        fetchView("v_feature_usage_totals", "select=*&order=period.desc"),
        fetchView("v_config_flag_rates", "select=*&order=enabled_pct.desc"),
        fetchView("v_config_setting_values", "select=*&order=install_count.desc"),
        loadFlagGroups()
      ]);

      el.innerHTML = `
        ${renderSection('Installs &amp; versions', renderVersionCards, versionRows)}
        ${renderSection('Current totals (across reporting installs)', renderTotalCounts, usageRows)}
        ${renderSection('Feature usage (most recent period)', renderUsageTable, usageRows)}
        ${renderSection('Feature toggle adoption', renderFlagRates, flagRows)}
        ${renderSection('Settings distribution', renderSettingValues, settingRows)}
        <div class="je-analytics-updated">Loaded live just now from the community analytics project. Refresh this page any time for current numbers.</div>
      `;
    } catch (err) {
      el.innerHTML = `<p class="je-analytics-error">Couldn't load live analytics data right now (${escapeHtml(err.message)}). Try refreshing.</p>`;
    }
  }

  render();
})();
</script>
