# Community Analytics

Jellyfin Enhanced can optionally report a small set of anonymous usage statistics back to a
community analytics project, entirely **opt-in and off by default**. Nothing is sent unless an
admin turns it on from the plugin's config page (**Admin → Usage Statistics**), and that page shows
the exact payload before it's ever sent.

This page shows the current aggregate results, live, straight from the same database every opted-in
install reports to. It reads three public, read-only views. No per-install data, no IP addresses, no
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
    These are **only** sent when the toggle is enabled and saved incase title "Always Included"
    might is a bit misleading.

### Feature toggle states

Every `bool` setting in the plugin's config (on/off only), reflected automatically, so a newly
added toggle is automatically added in the next sync. See the **Feature toggle adoption** section below
for the live, current, complete list, grouped by settings-page section.

Also included: two derived "is a key configured" flags (`TmdbEnabled`, `MdblistEnabled`), showing
whether a TMDB/MDBList API key is set, **never the key itself**, and a small, explicitly hand-picked
set of non-boolean fixed-choice settings, since a string *could* be a URL or API key and only
specific ones are ever safe to include:

- Icon style (`IconStyle`)
- Maintenance Mode action and affected-users choice (`MaintenanceModeAction`, `MaintenanceModeAffectedUsers`)
- Tag overlay positions (`QualityTagsPosition`, `GenreTagsPosition`, `LanguageTagsPosition`, `RatingTagsPosition`)
- Language tag priority list (`LanguageTagsPriority`, language codes only, e.g. `en,ja,fr`)

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

  async function fetchView(name, query) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${name}?${query || "select=*"}`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
    });
    if (!res.ok) throw new Error(`${name}: ${res.status}`);
    return res.json();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
  }

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
    const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  }

  // Prefers the real label text captured from the config page itself (see
  // FLAG_LABELS_MAP below) over the algorithmic humanize() fallback, so e.g.
  // "RecommendationsUseNativeTab" reads as "Add Recommendations as a native
  // Home tab" (its actual checkbox text) instead of "Recommendations Use
  // Native Tab".
  function labeledName(rawName) {
    const display = FLAG_LABELS_MAP[rawName] || humanize(rawName);
    return `${escapeHtml(display)}<br/><code class="je-flag-raw">${escapeHtml(rawName)}</code>`;
  }

  // A "jf10" build reports a jellyfin_version starting with "12." (or a
  // "jf12" build reporting "10." / "11.") when someone installs the build
  // for the other major version: both run since the request-time
  // injection middleware is plain ASP.NET and works on either runtime, but
  // it's still worth surfacing as its own signal rather than only the
  // matched pairing.
  function isTargetMismatch(target, jellyfinVersion) {
    if (!jellyfinVersion) return false;
    const majorIsTwelve = jellyfinVersion.startsWith('12.');
    return (target === 'jf10' && majorIsTwelve) || (target === 'jf12' && !majorIsTwelve);
  }

  function renderVersionCards(rows) {
    const totalInstalls = rows.reduce((sum, r) => sum + r.install_count, 0);
    const byTarget = {};
    rows.forEach(r => { byTarget[r.jellyfin_target] = (byTarget[r.jellyfin_target] || 0) + r.install_count; });

    let html = `<div class="je-stat-cards">
      <div class="je-stat-card"><div class="je-stat-value">${totalInstalls}</div><div class="je-stat-label">Reporting installs</div></div>`;
    Object.keys(byTarget).sort().forEach(target => {
      html += `<div class="je-stat-card"><div class="je-stat-value">${byTarget[target]}</div><div class="je-stat-label">on ${escapeHtml(target)}</div></div>`;
    });
    html += `</div>`;

    html += `<table class="je-analytics-table"><thead><tr><th>Plugin Target</th><th>Jellyfin target</th><th>Jellyfin version</th><th>Installs</th><th>Most recently seen</th></tr></thead><tbody>`;
    rows.sort((a, b) => b.install_count - a.install_count).forEach(r => {
      const seen = formatDateDMY(new Date(r.most_recent_seen));
      const mismatch = isTargetMismatch(r.jellyfin_target, r.jellyfin_version);
      const versionCell = mismatch
        ? `<span class="je-analytics-mismatch" title="This build target doesn't match the running server's major version">${escapeHtml(r.jellyfin_version)} ⚠</span>`
        : escapeHtml(r.jellyfin_version);
      html += `<tr><td>${escapeHtml(r.plugin_version)}</td><td>${escapeHtml(r.jellyfin_target)}</td><td>${versionCell}</td><td>${r.install_count}</td><td>${seen}</td></tr>`;
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

  function renderUsageTable(rows) {
    const deltaRows = rows.filter(r => !r.feature_key.startsWith(TOTAL_COUNT_PREFIX));
    if (!deltaRows.length) {
      return `<p><em>No usage-count data reported yet. This fills in once opted-in installs have accumulated activity over a reporting cycle.</em></p>`;
    }
    // Most recent period only, top 20 by total count.
    const latestPeriod = deltaRows.reduce((max, r) => r.period > max ? r.period : max, deltaRows[0].period);
    const latest = deltaRows.filter(r => r.period === latestPeriod).sort((a, b) => b.total_count - a.total_count).slice(0, 20);
    const maxCount = Math.max(...latest.map(r => r.total_count), 1);

    let html = `<p>Most recent reporting period: <strong>${formatDateDMY(new Date(`${latestPeriod}T00:00:00`))}</strong></p>`;
    html += `<table class="je-analytics-table"><thead><tr><th>Feature key</th><th>Total uses</th><th>Installs reporting it</th><th></th></tr></thead><tbody>`;
    latest.forEach(r => {
      const pct = Math.round((r.total_count / maxCount) * 100);
      html += `<tr><td>${labeledName(r.feature_key)}</td><td>${r.total_count}</td><td>${r.install_count}</td>
        <td style="width:120px;"><div class="je-analytics-bar-track"><div class="je-analytics-bar-fill" style="width:${pct}%;"></div></div></td></tr>`;
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
    const totalRows = rows.filter(r => r.feature_key.startsWith(TOTAL_COUNT_PREFIX));
    if (!totalRows.length) {
      return `<p><em>No total-count data reported yet.</em></p>`;
    }
    const latestPeriod = totalRows.reduce((max, r) => r.period > max ? r.period : max, totalRows[0].period);
    const latest = totalRows.filter(r => r.period === latestPeriod).sort((a, b) => a.feature_key.localeCompare(b.feature_key));

    let html = `<div class="je-stat-cards">`;
    latest.forEach(r => {
      const label = humanize(r.feature_key.slice(TOTAL_COUNT_PREFIX.length));
      html += `<div class="je-stat-card">
        <div class="je-stat-value">${r.total_count}</div>
        <div class="je-stat-label">${escapeHtml(label)}</div>
        <div class="je-stat-label">${r.nonzero_install_count} of ${r.install_count} reporting installs</div>
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
    return FLAG_GROUPS_MAP[flagName] || 'Other';
  }

  function renderFlagRates(rows) {
    const reporting = rows.filter(r => r.reporting_count > 0);
    if (!reporting.length) {
      return `<p><em>No config-flag data reported yet.</em></p>`;
    }

    const groups = {};
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
      const items = groups[g].sort((a, b) => a.flag_name.localeCompare(b.flag_name));
      let rowsHtml = items.map(r => `<tr><td>${labeledName(r.flag_name)}</td><td>${r.enabled_pct}%</td>
        <td style="width:120px;"><div class="je-analytics-bar-track"><div class="je-analytics-bar-fill" style="width:${r.enabled_pct}%;"></div></div></td></tr>`).join('');
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

    const bySetting = {};
    rows.forEach(r => { (bySetting[r.setting_name] = bySetting[r.setting_name] || []).push(r); });

    const names = Object.keys(bySetting).sort((a, b) => a.localeCompare(b));

    return names.map((name, i) => {
      const values = bySetting[name].slice().sort((a, b) => b.install_count - a.install_count);
      const total = values.reduce((sum, v) => sum + v.install_count, 0);
      const rowsHtml = values.map(v => {
        const pct = total > 0 ? Math.round((v.install_count / total) * 100) : 0;
        return `<tr><td>${escapeHtml(v.setting_value)}</td><td>${v.install_count}</td><td>${pct}%</td>
          <td style="width:120px;"><div class="je-analytics-bar-track"><div class="je-analytics-bar-fill" style="width:${pct}%;"></div></div></td></tr>`;
      }).join('');
      return `<details class="je-flag-group"${i === 0 ? ' open' : ''}>
        <summary>${labeledName(name)} (${total} reporting)</summary>
        <table class="je-analytics-table"><thead><tr><th>Value</th><th>Installs</th><th>%</th><th></th></tr></thead>
        <tbody>${rowsHtml}</tbody></table>
      </details>`;
    }).join('');
  }

  async function render() {
    const el = document.getElementById("je-analytics-dashboard");
    try {
      const [versionRows, usageRows, flagRows, settingRows] = await Promise.all([
        fetchView("v_version_adoption"),
        fetchView("v_feature_usage_totals"),
        fetchView("v_config_flag_rates", "select=*&order=enabled_pct.desc"),
        fetchView("v_config_setting_values", "select=*"),
        loadFlagGroups()
      ]);

      el.innerHTML = `
        <h3>Installs &amp; versions</h3>
        ${renderVersionCards(versionRows)}
        <h3>Current totals (across reporting installs)</h3>
        ${renderTotalCounts(usageRows)}
        <h3>Feature usage (most recent period)</h3>
        ${renderUsageTable(usageRows)}
        <h3>Feature toggle adoption</h3>
        ${renderFlagRates(flagRows)}
        <h3>Settings distribution</h3>
        ${renderSettingValues(settingRows)}
        <div class="je-analytics-updated">Loaded live just now from the community analytics project. Refresh this page any time for current numbers.</div>
      `;
    } catch (err) {
      el.innerHTML = `<p class="je-analytics-error">Couldn't load live analytics data right now (${escapeHtml(err.message)}). Try refreshing.</p>`;
    }
  }

  render();
})();
</script>
