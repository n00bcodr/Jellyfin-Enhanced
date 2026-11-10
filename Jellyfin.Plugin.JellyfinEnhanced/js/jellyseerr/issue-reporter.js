(() => {
"use strict";
(() => {
  // client/src/features/seerr/host-details.ts
  function bridge() {
    const host = window;
    if (!host.JellyfinEnhanced) throw new Error("Seerr details loaded before Jellyfin Enhanced");
    return host.JellyfinEnhanced;
  }
  function apiClient() {
    const host = window;
    if (!host.ApiClient) throw new Error("Jellyfin ApiClient unavailable");
    return host.ApiClient;
  }
  function translator(JE2) {
    return (key, fallback = "", params) => {
      const text = params ? JE2.t?.(key, params) : JE2.t?.(key);
      return text || fallback;
    };
  }
  function escaper(JE2) {
    return (value) => {
      if (JE2.escapeHtml) return JE2.escapeHtml(value);
      return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
    };
  }
  function identityLease(JE2) {
    const epoch = JE2.session?.getEpoch?.();
    return () => epoch === void 0 || typeof JE2.session?.isCurrent !== "function" || JE2.session.isCurrent(epoch);
  }
  var SEERR_LOG = "🪼 Jellyfin Enhanced:";

  // client/src/features/seerr/details/domain/json.ts
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function record(value) {
    return isRecord(value) ? value : null;
  }
  function str(value) {
    return typeof value === "string" ? value : void 0;
  }
  function filled(value) {
    return typeof value === "string" && value.length > 0 ? value : null;
  }
  function num(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : void 0;
  }
  function list(value) {
    return Array.isArray(value) ? value : [];
  }
  function records(value) {
    return list(value).filter(isRecord);
  }
  function idText(value) {
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return filled(value);
  }

  // client/src/features/seerr/details/issues/issue-model.ts
  function firstInt(...values) {
    const value = values.find(Boolean);
    return parseInt(String(value ?? 0), 10) || 0;
  }
  function isSeasonOrEpisode(item) {
    return item?.Type === "Season" || item?.Type === "Episode";
  }
  function seriesIdOf(item) {
    return filled(item.SeriesId) ?? filled(record(item.Series)?.Id) ?? (item.Type === "Season" ? filled(item.ParentId) : null);
  }
  function isSpecial(item) {
    if (item.Type === "Season") return firstInt(item.IndexNumber, item.SeasonNumber, item.Index) === 0;
    if (item.Type === "Episode") return firstInt(item.ParentIndexNumber, item.SeasonIndex, item.ParentIndex, item.SeasonNumber) === 0;
    return false;
  }
  function currentPosition(item) {
    if (item?.Type === "Season") return { season: firstInt(item.IndexNumber, item.SeasonNumber) || null, episode: null };
    if (item?.Type === "Episode") {
      return {
        season: firstInt(item.ParentIndexNumber, item.SeasonIndex, item.ParentIndex, item.SeasonNumber) || null,
        episode: firstInt(item.IndexNumber, item.EpisodeNumber) || null
      };
    }
    return { season: null, episode: null };
  }
  function reportSeasons(reply) {
    return records(record(reply)?.Items).map((season) => ({ seasonNumber: firstInt(season.IndexNumber, season.SeasonNumber, season.ParentIndexNumber), id: filled(season.Id), episodes: [] })).filter((season) => season.seasonNumber > 0);
  }
  function reportEpisodes(reply) {
    return records(record(reply)?.Items).map((episode) => ({
      episodeNumber: firstInt(episode.IndexNumber, episode.ParentIndexNumber, episode.Index),
      title: filled(episode.Name) ?? filled(episode.Title) ?? ""
    }));
  }
  function inferredSeasons(item) {
    const count = num(item?.SeasonCount) || list(item?.Seasons).length;
    return Array.from({ length: count }, (_, index) => ({ seasonNumber: index + 1, id: null, episodes: [] }));
  }
  function backdropSource(item) {
    const own = filled(list(item.BackdropImageTags)[0]);
    const id = filled(item.Id);
    if (own && id) return { itemId: id, tag: own };
    const inherited = filled(list(item.ParentBackdropImageTags)[0]);
    const parent = filled(item.ParentBackdropItemId) ?? filled(item.ParentId) ?? filled(item.SeriesId);
    return inherited && parent ? { itemId: parent, tag: inherited } : null;
  }
  var typeKey = (issue) => {
    const key = String(issue.issueType || issue.problemType || "unknown");
    return ["1", "2", "3", "4"].includes(key) ? key : "unknown";
  };
  function groupIssues(issues) {
    const time = (issue) => new Date(str(issue.createdAt) ?? 0).getTime() || 0;
    return ["1", "2", "3", "4", "unknown"].map((key) => ({
      key,
      issues: issues.filter((issue) => typeKey(issue) === key).sort((a, b) => time(b) - time(a))
    })).filter((group) => group.issues.length > 0);
  }
  function isResolved(status) {
    return String(status) === "2" || String(status).toLowerCase() === "resolved";
  }
  function personName(person) {
    const user = record(person);
    return filled(user?.jellyfinUsername) ?? filled(user?.displayName) ?? filled(user?.username) ?? filled(user?.email) ?? "";
  }
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function issueDate(value) {
    const text = filled(value);
    if (!text) return "";
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) return "";
    const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return `${String(date.getDate()).padStart(2, "0")}-${MONTHS[date.getMonth()]}-${date.getFullYear()} ${time}`;
  }
  function tmdbIdFromExternalUrls(urls) {
    const entries = Array.isArray(urls) ? urls : Object.values(record(urls) ?? {});
    for (const entry of entries) {
      let url = null;
      if (typeof entry === "string") {
        url = entry;
      } else if (isRecord(entry)) {
        url = filled(entry.Url) ?? filled(entry.url) ?? filled(entry.Value) ?? filled(entry.value) ?? filled(entry.Href) ?? filled(entry.href) ?? filled(entry.Link) ?? filled(entry.link) ?? filled(entry.Path) ?? filled(entry.path) ?? filled(Object.values(entry).find((value) => typeof value === "string" && value.includes("tmdb")));
      }
      if (url?.includes("tmdb")) {
        const match = /\/(\d+)/.exec(url);
        if (match?.[1]) return match[1];
      }
    }
    return null;
  }
  var matchesType = (result, mediaType) => result.mediaType === mediaType || !result.mediaType;
  function matchFromImdbSearch(results, mediaType) {
    return idText(results.find((result) => result.id && result.mediaType === mediaType)?.id) ?? idText(results.find((result) => result.id && matchesType(result, mediaType))?.id);
  }
  function matchFromTitleSearch(results, mediaType, title, year) {
    const wanted = title.toLowerCase();
    const exact = results.find((result) => {
      const name = (filled(result.title) ?? filled(result.name) ?? "").toLowerCase();
      const released = (filled(result.releaseDate) ?? filled(result.firstAirDate) ?? "").slice(0, 4);
      return result.id && matchesType(result, mediaType) && name === wanted && (year === "" || released === "" || released === year);
    });
    return idText(exact?.id) ?? idText(results.find((result) => result.id && matchesType(result, mediaType))?.id);
  }
  function itemYear(item) {
    return idText(item.ProductionYear) ?? filled(item.PremiereDate)?.slice(0, 4) ?? "";
  }

  // client/src/features/seerr/details/issues/report-markup.ts
  var REPORT_STYLES = `
            <style>
                .jellyseerr-issues-container { margin-top: 12px; }
                .jellyseerr-issues-header { font-weight: 700; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; font-size: 12px; color: #888; }
                .jellyseerr-issue-section { margin-bottom: 14px; }
                .jellyseerr-issue-section-title { display: inline-block; padding: 4px 12px; border-radius: 999px; background: rgba(100, 100, 255, 0.2); color: #b0b0ff; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; margin: 0 0 10px; }
                .jellyseerr-issue-card { border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.03); border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; }
                .jellyseerr-issue-summary { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-weight: 600; color: #e6e6e6; }
                .jellyseerr-issue-reporter { color: #9aa; font-weight: 500; }
                .jellyseerr-issue-date { color: #9aa; font-size: 12px; }
                .jellyseerr-pill { display: inline-block; padding: 2px 8px; border-radius: 999px; background: rgba(0, 150, 255, 0.15); color: #8fd1ff; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px; }
                .pill-number-open { background: rgba(0, 150, 255, 0.15); color: #8fd1ff; }
                .pill-status-open { background: rgba(255, 200, 0, 0.18); color: #ffd666; }
                .pill-number-resolved, .pill-status-resolved { background: rgba(0, 180, 60, 0.18); color: #8dffb0; }
                .jellyseerr-issue-message { margin-top: 6px; color: #ddd; white-space: pre-wrap; }
                .jellyseerr-issue-comments { margin-top: 8px; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 6px; display: grid; gap: 6px; }
                .jellyseerr-issue-comment { padding: 6px 8px; border-radius: 6px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); }
                .jellyseerr-issue-comment-meta { font-size: 12px; color: #9aa; margin-bottom: 2px; }
                .jellyseerr-issue-comment-body { color: #eaeaea; font-size: 14px; white-space: pre-wrap; }
                .jellyseerr-issues-empty { color: #9aa; padding: 8px 0; }
            </style>`;
  function reportFormHtml(types, labels) {
    return `${REPORT_STYLES}
            <div class="jellyseerr-issue-form">
                <div class="jellyseerr-form-group">
                    <label>${labels.type}</label>
                    <div class="jellyseerr-issue-radio-group">
                        ${types.map((type) => `
                            <label class="jellyseerr-radio-label">
                                <input type="radio" name="issue-type" value="${type.value}" class="jellyseerr-radio-input" required>
                                <span class="jellyseerr-radio-option">${type.icon} ${type.label}</span>
                            </label>
                        `).join("")}
                    </div>
                </div>
                <div class="jellyseerr-form-group">
                    <label for="issue-message">${labels.message}</label>
                    <textarea
                        id="issue-message"
                        class="jellyseerr-issue-textarea"
                        placeholder="${labels.placeholder}"
                        rows="4"
                    ></textarea>
                </div>
                <div id="jellyseerr-tv-controls-placeholder"></div>
                <div class="jellyseerr-issues-container" id="jellyseerr-issues-container">
                    <div class="jellyseerr-issues-header">${labels.existing}</div>
                    <div class="jellyseerr-issues-body" id="jellyseerr-issues-body">
                        <div class="jellyseerr-issues-loading" id="jellyseerr-issues-loading">${labels.loading}</div>
                    </div>
                </div>
            </div>
        `;
  }
  function tvControlsHtml(season, episode) {
    return `
                        <div class="jellyseerr-form-group">
                            <label for="issue-season">${season}</label>
                            <select id="issue-season" class="jellyseerr-select"></select>
                        </div>
                        <div class="jellyseerr-form-group">
                            <label for="issue-episode">${episode}</label>
                            <select id="issue-episode" class="jellyseerr-select"></select>
                        </div>
                    `;
  }
  function detailButtonContent(icon, iconClass = "") {
    return `
            <div class="detailButton-content">
                <span class="material-icons detailButton-icon${iconClass}" aria-hidden="true">${icon}</span>
            </div>
        `;
  }
  var INDICATOR_CSS = `
                    .jellyseerr-report-issue-icon.has-open-issues .detailButton-icon { color: #f97316 !important; }
                    .jellyseerr-report-issue-icon { position: relative; }
                    .jellyseerr-issue-count-badge {
                        position: absolute; top: 2px; right: 2px;
                        background: #f97316; color: #fff;
                        font-size: 10px; font-weight: 700;
                        border-radius: 999px; min-width: 16px; height: 16px;
                        display: flex; align-items: center; justify-content: center;
                        padding: 0 3px; pointer-events: none; line-height: 1;
                        box-shadow: 0 1px 3px rgba(0,0,0,0.5); z-index: 10;
                    }
                `;

  // client/src/features/seerr/details/issues/issue-reporter-entry.ts
  var JE = bridge();
  var logPrefix = `${SEERR_LOG} Issue Reporter:`;
  var escapeHtml = escaper(JE);
  var t = translator(JE);
  var label = (key, fallback = "") => escapeHtml(t(key, fallback));
  var toast = (message, duration) => JE.toast?.(message, duration);
  var BUTTON_CONTAINERS = [".detailButtons", ".itemActionsBottom", '[class*="ActionButtons"]', ".mainDetailButtons", ".detailButtonsContainer", '[class*="primaryActions"]', ".topBarSecondaryMenus + *"];
  var UNAVAILABLE_REASONS = {
    "no-tmdb": { aria: "TMDB ID not found", title: "TMDB ID not found for this item", toast: "TMDB ID not found for this item" },
    "no-jellyseerr": { aria: "Jellyseerr unavailable", title: "Jellyseerr is not available", toast: "Jellyseerr is not available" },
    "no-both": { aria: "Reporting services unavailable", title: "TMDB ID not found and Jellyseerr is not available", toast: "TMDB ID not found and Jellyseerr is not available" },
    "no-permissions": { aria: "Not enough permissions", title: "Not enough permissions to report", toast: "You do not have permissions to report issues" }
  };
  var openReports = /* @__PURE__ */ new Set();
  JE.session?.onUserChange?.("issue-reporter", () => {
    for (const close of [...openReports]) close();
  });
  function issueTypes() {
    const icon = (name) => {
      const key = JE.IconName?.[name];
      return key ? JE.icon?.(key) ?? "" : "";
    };
    return [
      { value: "1", label: label("jellyseerr_report_issue_type_video"), icon: icon("VIDEO") },
      { value: "2", label: label("jellyseerr_report_issue_type_audio"), icon: icon("AUDIO") },
      { value: "3", label: label("jellyseerr_report_issue_type_subtitles"), icon: icon("SUBTITLES") },
      { value: "4", label: label("jellyseerr_report_issue_type_other"), icon: icon("QUESTION") }
    ];
  }
  function fetchItem(id, userId) {
    return JE.helpers?.getItemCached ? JE.helpers.getItemCached(id, { userId }) : apiClient().getItem(userId, id);
  }
  async function getTmdbSourceItem(item) {
    if (!item || !isSeasonOrEpisode(item)) return item;
    const seriesId = seriesIdOf(item);
    const userId = apiClient().getCurrentUserId();
    if (!seriesId || !userId) return null;
    try {
      return record(await fetchItem(seriesId, userId));
    } catch (error) {
      console.debug(`${logPrefix} Could not load series ${seriesId} for ${str(item.Name)}:`, error);
      return null;
    }
  }
  function tmdbOf(item) {
    return idText(record(item?.ProviderIds)?.Tmdb);
  }
  async function checkReportingAvailability(item) {
    try {
      const client = apiClient();
      const status = await client.ajax({ type: "GET", url: client.getUrl("/JellyfinEnhanced/jellyseerr/status"), dataType: "json" });
      const active = record(status)?.active === true;
      const hasTmdb = !!tmdbOf(await getTmdbSourceItem(record(item)));
      if (!hasTmdb) return active ? "no-tmdb" : "no-both";
      return active ? "available" : "no-jellyseerr";
    } catch (error) {
      console.debug(`${logPrefix} Error checking reporting availability:`, error);
      return "available";
    }
  }
  function setOptions(select, options) {
    select.innerHTML = "";
    for (const option of options) {
      const element = document.createElement("option");
      element.value = String(option.value);
      element.textContent = option.label;
      select.appendChild(element);
    }
  }
  function selectedNumber(modal, selector) {
    return parseInt(modal.querySelector(selector)?.value ?? "", 10) || 0;
  }
  function issueCard(issue, statusLabels) {
    const createdBy = escapeHtml(personName(issue.createdBy) || "Someone");
    const createdAt = issueDate(issue.createdAt);
    const [first, ...rest] = records(issue.comments);
    const comments = rest.map((comment) => {
      const who = escapeHtml(personName(comment.user));
      const when = issueDate(comment.createdAt);
      return `<div class="jellyseerr-issue-comment"><div class="jellyseerr-issue-comment-meta">${escapeHtml(when)}${who ? ` • ${who}` : ""}</div><div class="jellyseerr-issue-comment-body">${escapeHtml(str(comment.message) ?? "")}</div></div>`;
    }).join("");
    const message = escapeHtml(filled(issue.message) ?? filled(first?.message) ?? "(No description)");
    const resolved = isResolved(issue.status);
    const statusText = statusLabels[String(issue.status)] || (resolved ? "Resolved" : "Open");
    const suffix = resolved ? "resolved" : "open";
    const summary = `<span class="jellyseerr-pill pill-number-${suffix}">#${escapeHtml(idText(issue.id))}</span><span class="jellyseerr-pill pill-status-${suffix}">${escapeHtml(statusText)}</span>${createdAt ? ` <span class="jellyseerr-issue-date">${escapeHtml(createdAt)}</span>` : ""}`;
    return `
                                    <div class="jellyseerr-issue-card">
                                        <div class="jellyseerr-issue-summary">${summary}<span class="jellyseerr-issue-reporter"> — ${createdBy}</span></div>
                                        <div class="jellyseerr-issue-message">${message}</div>
                                        ${comments ? `<div class="jellyseerr-issue-comments">${comments}</div>` : ""}
                                    </div>
                                `;
  }
  function issueSections(issues) {
    const typeLabels = {
      1: t("jellyseerr_report_issue_type_video", "Video"),
      2: t("jellyseerr_report_issue_type_audio", "Audio"),
      3: t("jellyseerr_report_issue_type_subtitles", "Subtitles"),
      4: t("jellyseerr_report_issue_type_other", "Other")
    };
    const statusLabels = { 1: t("jellyseerr_issue_open", "Open"), 2: t("jellyseerr_issue_resolved", "Resolved") };
    return groupIssues(issues).map((group) => `
                            <div class="jellyseerr-issue-section">
                                <div class="jellyseerr-issue-section-title">${escapeHtml(typeLabels[group.key] ?? "Other")}</div>
                                ${group.issues.map((issue) => issueCard(issue, statusLabels)).join("")}
                            </div>
                        `).join("");
  }
  async function loadExistingIssues(modal, tmdbId, mediaType, open) {
    const body = modal.querySelector("#jellyseerr-issues-body");
    const empty = (message) => {
      if (body) body.innerHTML = `<div class="jellyseerr-issues-empty">${escapeHtml(message)}</div>`;
    };
    try {
      const api = JE.jellyseerrAPI;
      const reply = await api?.fetchIssuesForMedia(tmdbId, mediaType, { take: 50, filter: "all" });
      if (!open()) return;
      const issues = records(record(reply)?.results);
      if (!issues.length) {
        empty(t("jellyseerr_no_issues_yet"));
        return;
      }
      const full = await Promise.all(issues.map(async (issue) => {
        try {
          return record(await api?.fetchIssueById(issue.id)) ?? issue;
        } catch {
          return issue;
        }
      }));
      if (open() && body) body.innerHTML = issueSections(full);
    } catch (error) {
      console.error(`${logPrefix} Failed to load existing issues:`, error);
      if (open()) empty(t("jellyseerr_load_issues_error"));
    }
  }
  async function serverSeasons(item, open) {
    const seriesId = item?.Type === "Series" ? filled(item.Id) : item && isSeasonOrEpisode(item) ? seriesIdOf(item) : null;
    if (!seriesId) return [];
    const client = apiClient();
    const query = (parentId, type, fields) => client.ajax({
      type: "GET",
      dataType: "json",
      url: client.getUrl("/Items", { ParentId: parentId, IncludeItemTypes: type, SortBy: "IndexNumber", SortOrder: "Ascending", Fields: fields, userId: client.getCurrentUserId() ?? "" })
    });
    const seasons = reportSeasons(await query(seriesId, "Season", "IndexNumber,SeasonNumber"));
    for (const season of seasons) {
      if (!open()) return seasons;
      if (!season.id) continue;
      try {
        season.episodes = reportEpisodes(await query(season.id, "Episode", "IndexNumber,Name"));
      } catch (error) {
        console.debug(`${logPrefix} Failed to fetch episodes for season ${season.seasonNumber}:`, error);
      }
    }
    return seasons;
  }
  async function buildTvControls(modal, item, open) {
    const placeholder = modal.querySelector("#jellyseerr-tv-controls-placeholder");
    if (!placeholder) return;
    placeholder.innerHTML = tvControlsHtml(label("jellyseerr_report_issue_season"), label("jellyseerr_report_issue_episode"));
    const seasonSelect = modal.querySelector("#issue-season");
    const episodeSelect = modal.querySelector("#issue-episode");
    if (!seasonSelect || !episodeSelect) return;
    seasonSelect.disabled = true;
    episodeSelect.disabled = true;
    let seasons = [];
    try {
      seasons = await serverSeasons(item, open);
    } catch (error) {
      console.debug(`${logPrefix} Error fetching seasons/episodes from Jellyfin:`, error);
    }
    if (!open()) return;
    if (seasons.length === 0) seasons = inferredSeasons(item);
    const allEpisodes = [{ value: 0, label: t("jellyseerr_select_all_episodes", "All episodes") }];
    const allSeasons = { value: 0, label: t("jellyseerr_select_all_seasons", "All seasons") };
    if (seasons.length === 0) {
      setOptions(seasonSelect, [allSeasons]);
      setOptions(episodeSelect, allEpisodes);
      return;
    }
    setOptions(seasonSelect, [
      ...seasons.length > 1 ? [allSeasons] : [],
      ...seasons.map((season) => ({ value: season.seasonNumber, label: `${t("jellyseerr_report_issue_season", "Season")} ${season.seasonNumber}` }))
    ]);
    seasonSelect.disabled = false;
    const showAllEpisodes = () => {
      setOptions(episodeSelect, allEpisodes);
      episodeSelect.disabled = true;
    };
    const populateEpisodes = (seasonNumber) => {
      const season = seasons.find((entry) => entry.seasonNumber === seasonNumber);
      if (!season) {
        showAllEpisodes();
        return;
      }
      setOptions(episodeSelect, [...allEpisodes, ...season.episodes.map((episode) => ({
        value: episode.episodeNumber,
        label: `${t("jellyseerr_report_issue_episode", "Episode")} ${episode.episodeNumber}${episode.title ? ` — ${episode.title}` : ""}`
      }))]);
      episodeSelect.disabled = false;
    };
    const position = currentPosition(item);
    if (position.season) {
      const value = String(position.season);
      if (Array.from(seasonSelect.options).some((option) => option.value === value)) seasonSelect.value = value;
      if (item?.Type === "Season") seasonSelect.disabled = true;
      populateEpisodes(position.season);
      if (position.episode) {
        const episode = String(position.episode);
        if (Array.from(episodeSelect.options).some((option) => option.value === episode)) episodeSelect.value = episode;
        if (item?.Type === "Episode") {
          episodeSelect.disabled = true;
          seasonSelect.disabled = true;
        }
      }
    } else if (seasons.length > 1) {
      seasonSelect.value = "0";
      showAllEpisodes();
    } else {
      const only = seasons[0]?.seasonNumber ?? 0;
      seasonSelect.value = String(only);
      populateEpisodes(only);
    }
    seasonSelect.addEventListener("change", () => {
      const value = seasonSelect.value;
      if (!value || value === "0") showAllEpisodes();
      else populateEpisodes(parseInt(value, 10));
    });
  }
  function reportFailed(error) {
    const failure = record(error);
    const status = failure?.status;
    const text = (filled(failure?.message) ?? String(error ?? "")).toLowerCase();
    if (status === 403) toast(t("jellyseerr_err_no_issue_permission"), 4e3);
    else if (text.includes("jellyseerr") || text.includes("unavailable") || status === 503 || status === 0) toast("Jellyseerr is not available", 4e3);
    else toast(t("jellyseerr_report_issue_error"), 4e3);
  }
  function showReportModal(tmdbId, itemName, mediaType, backdropUrl = null, rawItem = null) {
    const modalApi = JE.jellyseerrModal;
    const api = JE.jellyseerrAPI;
    if (!modalApi || !api) return;
    const item = record(rawItem);
    const sameAccount = identityLease(JE);
    let closed = false;
    const open = () => !closed && sameAccount();
    const leave = () => {
      closed = true;
      openReports.delete(leave);
      handle.close?.();
    };
    const handle = modalApi.create({
      title: t("jellyseerr_report_issue_title"),
      subtitle: itemName,
      bodyHtml: reportFormHtml(issueTypes(), {
        type: label("jellyseerr_report_issue_type_label"),
        message: label("jellyseerr_report_issue_message"),
        placeholder: label("jellyseerr_report_issue_message_placeholder"),
        existing: label("jellyseerr_existing_issues"),
        loading: label("jellyseerr_loading_issues")
      }),
      backdropUrl,
      buttonText: t("jellyseerr_report_issue_submit"),
      onClose() {
        closed = true;
        openReports.delete(leave);
      },
      async onSave(modal, button, closeModal) {
        if (!open()) return;
        const issueType = modal.querySelector('input[name="issue-type"]:checked')?.value;
        const message = modal.querySelector("#issue-message")?.value ?? "";
        const season = selectedNumber(modal, "#issue-season");
        const episode = selectedNumber(modal, "#issue-episode");
        if (!issueType) {
          toast("Issue Type is required", 3e3);
          return;
        }
        try {
          button.disabled = true;
          button.textContent = t("jellyseerr_report_issue_submitting");
          const result = await api.reportIssue(tmdbId, mediaType, issueType, message, season, episode);
          if (!sameAccount()) return;
          if (!result) throw new Error("No response from API");
          toast(t("jellyseerr_report_issue_success"), 3e3);
          console.log(`${logPrefix} Issue successfully reported for ${itemName}`);
          closeModal();
        } catch (error) {
          if (!sameAccount()) return;
          console.error(`${logPrefix} Error reporting issue:`, error);
          reportFailed(error);
          if (closed) return;
          button.disabled = false;
          button.textContent = t("jellyseerr_report_issue_submit");
        }
      }
    });
    openReports.add(leave);
    handle.show();
    void loadExistingIssues(handle.modalElement, tmdbId, mediaType, open);
    if (mediaType === "tv") {
      buildTvControls(handle.modalElement, item, open).catch((error) => console.debug(`${logPrefix} Error building tv controls:`, error));
    }
  }
  function createReportButton(container, tmdbId, itemName, mediaType, backdropUrl = null, item = null) {
    if (!container) {
      console.warn(`${logPrefix} Container not found for report button`);
      return null;
    }
    const button = document.createElement("button");
    button.setAttribute("is", "emby-button");
    button.className = "button-flat detailButton emby-button jellyseerr-report-issue-icon";
    button.type = "button";
    const title = t("jellyseerr_report_issue_button");
    button.setAttribute("aria-label", title);
    button.title = title;
    button.innerHTML = detailButtonContent("", " warning");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      showReportModal(tmdbId, itemName, mediaType, backdropUrl, item);
    });
    return button;
  }
  function createUnavailableButton(container, _itemName, _mediaType, reason = "unavailable") {
    if (!container) return null;
    const known = UNAVAILABLE_REASONS[reason];
    const button = document.createElement("button");
    button.setAttribute("is", "emby-button");
    button.className = "button-flat detailButton emby-button jellyseerr-report-unavailable-icon";
    button.type = "button";
    button.setAttribute("aria-label", known?.aria ?? t("jellyseerr_report_unavailable_button"));
    button.title = known?.title ?? t("jellyseerr_report_unavailable_button");
    button.setAttribute("aria-disabled", "true");
    button.style.opacity = "0.5";
    button.style.cursor = "not-allowed";
    button.innerHTML = detailButtonContent("warning_off");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toast(known?.toast ?? t("jellyseerr_report_unavailable_toast"), 4e3);
    });
    return button;
  }
  async function getTmdbIdFallback(itemName, mediaType, rawItem) {
    try {
      const item = record(rawItem);
      if (!item) return null;
      console.debug(`${logPrefix} Attempting fallback TMDB lookup for ${itemName}`);
      const fromLinks = tmdbIdFromExternalUrls(item.ExternalUrls);
      if (fromLinks) return fromLinks;
      const search = JE.jellyseerrAPI?.search;
      if (typeof search !== "function") return null;
      try {
        const imdbId = filled(record(item.ProviderIds)?.Imdb);
        if (imdbId) {
          console.debug(`${logPrefix} Trying Jellyseerr search by IMDB ID: ${imdbId}`);
          const match2 = matchFromImdbSearch(records(record(await search.call(JE.jellyseerrAPI, imdbId))?.results), mediaType);
          if (match2) {
            console.log(`${logPrefix} Found TMDB ID via Jellyseerr search (IMDB): ${match2}`);
            return match2;
          }
        }
        const year = itemYear(item);
        const name = str(item.Name) ?? "";
        const query = `${name}${year ? ` ${year}` : ""}`;
        console.debug(`${logPrefix} Trying Jellyseerr search by title: "${query}"`);
        const match = matchFromTitleSearch(records(record(await search.call(JE.jellyseerrAPI, query))?.results), mediaType, name, year);
        if (match) console.log(`${logPrefix} Found TMDB ID via Jellyseerr search (title): ${match}`);
        return match;
      } catch (error) {
        console.debug(`${logPrefix} Jellyseerr search fallback failed:`, error);
        return null;
      }
    } catch (error) {
      console.debug(`${logPrefix} Fallback lookup failed:`, error);
      return null;
    }
  }
  async function applyIssueIndicator(button, tmdbId, mediaType) {
    if (!JE.pluginConfig?.JellyseerrShowIssueIndicator) return;
    const sameAccount = identityLease(JE);
    try {
      const reply = await JE.jellyseerrAPI?.fetchIssuesForMedia(tmdbId, mediaType, { take: 50, filter: "open" });
      if (!button.isConnected || !sameAccount()) return;
      const count = list(record(reply)?.results).length;
      if (count === 0) return;
      if (!document.getElementById("je-issue-indicator-style")) {
        const style = document.createElement("style");
        style.id = "je-issue-indicator-style";
        style.textContent = INDICATOR_CSS;
        document.head.appendChild(style);
      }
      button.classList.add("has-open-issues");
      const badge = document.createElement("span");
      badge.className = "jellyseerr-issue-count-badge";
      badge.textContent = count > 9 ? "9+" : String(count);
      button.appendChild(badge);
      const tooltip = `${count} ${t("jellyseerr_issue_open", "Open")} ${t("jellyseerr_existing_issues", "Issues")} - ${t("jellyseerr_report_issue_button", "Report issue")}`;
      button.title = tooltip;
      button.setAttribute("aria-label", tooltip);
    } catch (error) {
      console.debug(`${logPrefix} applyIssueIndicator failed:`, error);
    }
  }
  function findButtonContainer(page) {
    for (const selector of BUTTON_CONTAINERS) {
      const found = page.querySelector(selector);
      if (found) return found;
    }
    const buttons = page.querySelectorAll("button");
    return buttons[buttons.length - 1]?.parentElement ?? null;
  }
  function placeButton(container, button) {
    const more = container.querySelector(".btnMoreCommands");
    if (more) container.insertBefore(button, more);
    else container.appendChild(button);
  }
  function itemIdFromHash() {
    return new URLSearchParams(window.location.hash.split("?")[1]).get("id");
  }
  var hasButton = (page) => !!page.querySelector(".jellyseerr-report-issue-icon, .jellyseerr-report-unavailable-icon");
  function backdropUrlOf(item) {
    const source = backdropSource(item);
    return source ? apiClient().getUrl(`Items/${source.itemId}/Images/Backdrop`, { tag: source.tag, quality: 40 }) : null;
  }
  async function addButton(page, itemId, userId) {
    const sameAccount = identityLease(JE);
    const stillWanted = () => sameAccount() && page.isConnected && !page.classList.contains("hide") && itemIdFromHash() === itemId && !hasButton(page);
    const item = record(await fetchItem(itemId, userId));
    if (!item) {
      console.debug(`${logPrefix} Could not fetch item data`);
      return false;
    }
    if (!stillWanted()) return false;
    const isTvLike = item.Type === "Series" || item.Type === "Season" || item.Type === "Episode";
    if (!isTvLike && item.Type !== "Movie") {
      console.debug(`${logPrefix} Skipping ${str(item.Name)}: unsupported item type (${str(item.Type)}) — not a Movie/Series/Season/Episode`);
      return false;
    }
    if (isSpecial(item)) {
      console.debug(`${logPrefix} Skipping ${str(item.Name)}: special (season 0)`);
      return false;
    }
    const mediaType = isTvLike ? "tv" : "movie";
    const availability = await checkReportingAvailability(item);
    if (!stillWanted()) return false;
    if (availability === "no-tmdb" || availability === "no-both") {
      console.debug(`${logPrefix} Skipping ${str(item.Name)}: no TMDB ID available, nothing to report against`);
      return false;
    }
    if (availability !== "available") {
      console.debug(`${logPrefix} Reporting not available: ${availability}`);
      const container2 = findButtonContainer(page);
      const unavailable = createUnavailableButton(container2, "", "", availability);
      if (!container2 || !unavailable) return false;
      placeButton(container2, unavailable);
      console.log(`${logPrefix} Added unavailable report button (${availability})`);
      return true;
    }
    const tmdbItem = await getTmdbSourceItem(item);
    if (!stillWanted()) return false;
    let tmdbId = tmdbOf(tmdbItem);
    console.debug(`${logPrefix} Checking item: ${str(item.Name)} (type=${str(item.Type)}, mediaType=${mediaType}, TMDB: ${tmdbId})`);
    if (!tmdbId) {
      tmdbId = tmdbItem ? await issueReporter.getTmdbIdFallback(str(tmdbItem.Name) ?? "", mediaType, tmdbItem) : null;
      if (!tmdbId) {
        console.debug(`${logPrefix} No TMDB ID could be resolved for ${str(item.Name)} (fallback also failed), skipping button`);
        return false;
      }
      console.log(`${logPrefix} Found TMDB ID via fallback: ${tmdbId}`);
      if (!stillWanted()) return false;
    }
    const container = findButtonContainer(page);
    if (!container) {
      console.debug(`${logPrefix} Could not find button container for ${str(item.Name)}`);
      return false;
    }
    const name = str(item.Name) ?? "";
    const button = createReportButton(container, tmdbId, name, mediaType, backdropUrlOf(item), item);
    if (!button) return false;
    placeButton(container, button);
    console.log(`${logPrefix} ✓ Report issue button added to ${name} (${mediaType}, TMDB: ${tmdbId})`);
    void applyIssueIndicator(button, tmdbId, mediaType);
    return true;
  }
  var running = /* @__PURE__ */ new WeakMap();
  async function tryAddButton() {
    const page = document.querySelector("#itemDetailPage:not(.hide)");
    if (!page) return false;
    if (!JE.pluginConfig?.JellyseerrEnabled || !JE.pluginConfig?.JellyseerrShowReportButton) {
      console.debug(`${logPrefix} Jellyseerr integration or report button disabled, skipping`);
      return false;
    }
    if (hasButton(page)) {
      console.debug(`${logPrefix} Report button already exists`);
      return true;
    }
    try {
      const itemId = itemIdFromHash();
      if (!itemId) {
        console.debug(`${logPrefix} No item ID in URL`);
        return false;
      }
      const userId = apiClient().getCurrentUserId();
      if (!userId) {
        console.debug(`${logPrefix} No user ID found`);
        return false;
      }
      const active = running.get(page);
      if (active?.itemId === itemId) return await active.run;
      const run = addButton(page, itemId, userId).finally(() => {
        if (running.get(page)?.run === run) running.delete(page);
      });
      running.set(page, { itemId, run });
      return await run;
    } catch (error) {
      console.warn(`${logPrefix} Error adding button:`, error);
      return false;
    }
  }
  var initialized = false;
  async function initialize() {
    if (!JE.pluginConfig?.JellyseerrEnabled || !JE.pluginConfig?.JellyseerrShowReportButton) {
      console.debug(`${logPrefix} Jellyseerr integration or report-button feature disabled, skipping initialization`);
      return;
    }
    if (initialized) return;
    JE.jellyseerrUI?.addMainStyles?.();
    console.log(`${logPrefix} Initializing... (verifying Jellyseerr status)`);
    try {
      const client = apiClient();
      const status = JE.takePrefetched?.("SeerrStatus") || await client.ajax({ type: "GET", url: client.getUrl("/JellyfinEnhanced/jellyseerr/status"), dataType: "json" });
      if (!record(status)?.active) {
        console.debug(`${logPrefix} Jellyseerr status check returned inactive, skipping reporter init`);
        return;
      }
    } catch (error) {
      console.warn(`${logPrefix} Failed to verify Jellyseerr status, skipping reporter init:`, error);
      return;
    }
    if (initialized) return;
    initialized = true;
    const handleViewShow = () => {
      setTimeout(() => {
        void issueReporter.tryAddButton();
      }, 100);
    };
    document.addEventListener("viewshow", handleViewShow);
    setTimeout(handleViewShow, 500);
    console.log(`${logPrefix} ✓ Initialized issue reporter with viewshow listener`);
  }
  var issueReporter = {
    checkReportingAvailability,
    showReportModal,
    createReportButton,
    createUnavailableButton,
    getTmdbIdFallback,
    applyIssueIndicator,
    tryAddButton,
    initialize
  };
  JE.jellyseerrIssueReporter = issueReporter;
})();
})();
//# sourceMappingURL=issue-reporter.js.map
