(() => {
"use strict";
(() => {
  // client/src/features/shared/wire.ts
  function currentLease(session, getApi) {
    const epoch = session?.getEpoch(), user = getApi?.()?.getCurrentUserId(), server = getApi?.()?.getUrl("/");
    return () => (epoch === void 0 || session?.isCurrent(epoch) === true) && user === getApi?.()?.getCurrentUserId() && server === getApi?.()?.getUrl("/");
  }
  function record(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function object(value) {
    if (!record(value)) throw Error("Invalid response object");
    return value;
  }
  function string(value) {
    if (typeof value !== "string") throw Error("Invalid response string");
    return value;
  }
  function number(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) throw Error("Invalid response number");
    return value;
  }
  function optionalString(value) {
    return value == null ? void 0 : string(value);
  }
  function optionalNumber(value) {
    return value == null ? void 0 : number(value);
  }
  function optionalBoolean(value) {
    if (value == null) return void 0;
    if (typeof value !== "boolean") throw Error("Invalid response boolean");
    return value;
  }
  function array(value, decode) {
    if (!Array.isArray(value)) throw Error("Invalid response array");
    return value.map(decode);
  }

  // client/src/features/activity/model.ts
  function readItem(value) {
    const v = object(value), tags = v.ImageTags == null ? {} : object(v.ImageTags);
    return {
      Id: string(v.Id),
      Name: string(v.Name),
      SeriesName: optionalString(v.SeriesName),
      SeriesId: optionalString(v.SeriesId),
      SeasonNumber: optionalNumber(v.SeasonNumber),
      EpisodeNumber: optionalNumber(v.EpisodeNumber),
      RunTimeTicks: optionalNumber(v.RunTimeTicks),
      HasThumbImage: optionalBoolean(v.HasThumbImage),
      HasPrimaryImage: optionalBoolean(v.HasPrimaryImage),
      SeriesHasThumbImage: optionalBoolean(v.SeriesHasThumbImage),
      SeriesHasPrimaryImage: optionalBoolean(v.SeriesHasPrimaryImage),
      ImageTags: { Thumb: optionalString(tags.Thumb), Primary: optionalString(tags.Primary) },
      ParentThumbImageTag: optionalString(v.ParentThumbImageTag),
      ParentThumbItemId: optionalString(v.ParentThumbItemId),
      SeriesPrimaryImageTag: optionalString(v.SeriesPrimaryImageTag)
    };
  }
  function readEntry(value) {
    const v = object(value);
    return { ActivityType: string(v.ActivityType), UserId: string(v.UserId), UserName: string(v.UserName), UserHasPrimaryImage: optionalBoolean(v.UserHasPrimaryImage), Timestamp: number(v.Timestamp), Item: readItem(v.Item), Rating: optionalNumber(v.Rating), Content: optionalString(v.Content), Completed: optionalBoolean(v.Completed), Progress: optionalNumber(v.Progress) };
  }
  function readFeed(value) {
    return array(object(value).items, readEntry);
  }
  function readSessions(value) {
    return array(value, object).filter((v) => v.NowPlayingItem != null).map((v) => {
      const ps = v.PlayState == null ? {} : object(v.PlayState);
      return { UserId: string(v.UserId), UserName: string(v.UserName), UserHasPrimaryImage: optionalBoolean(v.UserHasPrimaryImage), NowPlayingItem: readItem(v.NowPlayingItem), PlayState: { IsPaused: optionalBoolean(ps.IsPaused), PositionTicks: optionalNumber(ps.PositionTicks) } };
    });
  }

  // client/src/host/context.ts
  function featureContext(feature, core, slots) {
    const shared = core.core?.featureContext;
    if (typeof shared !== "function") {
      throw new Error(`${feature}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);
    }
    return shared(feature, core, slots);
  }

  // client/src/features/activity/host.ts
  function activityHost() {
    const host = window, JE = host.JellyfinEnhanced;
    const ctx = JE && featureContext("activity", JE, {
      facades: ["activityPage", "initializeActivityIcons", "stopActivityIconsMonitoring"]
    });
    return { host, ctx, getApi: () => host.ApiClient, Emby: host.Emby };
  }

  // client/src/features/activity/activity-page.ts
  (function() {
    "use strict";
    const { ctx: context, getApi, Emby } = activityHost();
    if (!context) return;
    const ctx = context, JE = ctx.core;
    const ApiClient = () => {
      const apiCandidate = getApi();
      if (!apiCandidate) throw Error("Jellyfin API unavailable");
      return apiCandidate;
    };
    if (!JE?.pluginConfig?.ActivityFeedEnabled) {
      return;
    }
    const LOG = "🪼 Jellyfin Enhanced: Activity Feed:";
    const ACTIVE_STREAMS_POLL_MS = 15e3;
    const translate = (key, fallback) => {
      const value = JE.t(key);
      return value && value !== key ? value : fallback;
    };
    const getAccentColor = () => {
      try {
        return JE?.themer?.getThemeVariables?.()?.primaryAccent || "#00a4dc";
      } catch (_) {
        return "#00a4dc";
      }
    };
    const applyThemeVars = () => {
      document.documentElement.style.setProperty("--je-activity-accent", getAccentColor());
    };
    function navigateToItem(itemId) {
      if (!itemId) return;
      try {
        if (typeof Emby !== "undefined" && Emby.Page?.showItem) {
          Emby.Page.showItem(itemId);
          return;
        }
      } catch (_) {
      }
      window.location.hash = `#!/details?id=${itemId}`;
    }
    const injectStyles = () => {
      if (document.getElementById("je-activity-feed-styles")) return;
      const style = document.createElement("style");
      style.id = "je-activity-feed-styles";
      style.textContent = `
.je-activity-feed { width: 100%; box-sizing: border-box; padding: 20px 3vw 48px; }
.je-activity-topbar {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 20px;
}
.je-activity-title { font-size: 24px; font-weight: 700; color: rgba(255,255,255,0.95); }
.je-activity-refresh-btn {
  background: none; border: none; cursor: pointer;
  color: rgba(255,255,255,0.75); padding: 8px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
}
.je-activity-refresh-btn:hover { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.95); }
.je-activity-refresh-btn .material-icons { font-size: 22px; transition: transform 0.5s ease; }
.je-activity-refresh-btn.je-activity-refresh-spin .material-icons { transform: rotate(360deg); }
.je-activity-filter, .je-activity-more { color: inherit; background: rgba(128,128,128,.15); border: 1px solid rgba(128,128,128,.5); border-radius: 5px; padding: 8px; font: inherit; }
.je-activity-section { margin-bottom: 32px; }
.je-activity-section-header {
  display: flex; align-items: center; gap: 10px;
  font-size: 20px; font-weight: 700; color: rgba(255,255,255,0.95);
  padding: 0 6px 10px; border-bottom: 2px solid rgba(255,255,255,0.12);
  margin-bottom: 4px;
}
.je-activity-section-header .material-icons { font-size: 22px; opacity: 0.85; }
.je-activity-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 6px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
}
.je-activity-avatar {
  width: 48px; height: 48px; border-radius: 50%;
  flex-shrink: 0; object-fit: cover;
  background: rgba(255,255,255,0.08);
}
.je-activity-icon {
  width: 48px; height: 48px; border-radius: 50%;
  flex-shrink: 0; display: flex; align-items: center; justify-content: center;
  background: rgba(255,255,255,0.08);
  font-size: 24px;
}
.je-activity-icon.je-activity-watched { color: var(--je-activity-accent, #00a4dc); }
.je-activity-icon.je-activity-watching { color: var(--je-activity-accent, #00a4dc); opacity: 0.8; }
.je-activity-icon.je-activity-favorited { color: #e0457b; }
.je-activity-icon.je-activity-reviewed { color: #f2b01e; }
.je-activity-body { flex: 1 1 auto; min-width: 0; }
.je-activity-line { font-size: 17px; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: rgba(255,255,255,0.92); }
.je-activity-user { font-weight: 700; }
.je-activity-item-name { font-weight: 700; color: inherit; text-decoration: none; cursor: pointer; }
.je-activity-item-name:hover { text-decoration: underline; }
.je-activity-time { font-size: 13px; opacity: 0.65; margin-top: 4px; }
.je-activity-content {
  font-size: 15px; opacity: 0.85; margin-top: 6px; line-height: 1.4;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.je-activity-rating { margin-top: 4px; display: inline-flex; align-items: center; gap: 0.5em; }
.je-activity-rating-star { position: relative; display: inline-block; width: 15px; height: 15px; color: rgba(255,255,255,0.28); }
.je-activity-rating-star svg { position: absolute; top: 0; left: 0; width: 100%; height: 100%; display: block; }
.je-activity-rating-star-fill { color: #f2b01e; }
.je-activity-progress {
  margin-top: 6px; height: 4px; border-radius: 2px;
  background: rgba(255,255,255,0.12); overflow: hidden; max-width: 320px;
}
.je-activity-progress-fill { height: 100%; background: var(--je-activity-accent, #00a4dc); }
.je-activity-thumb {
  border-radius: 4px; object-fit: cover;
  flex-shrink: 0; background: rgba(255,255,255,0.08); cursor: pointer;
}
.je-activity-thumb.je-thumb-landscape { width: 120px; height: 68px; }
.je-activity-thumb.je-thumb-portrait { width: 56px; height: 84px; }
.je-activity-empty, .je-activity-error { opacity: 0.7; text-align: center; padding: 32px 16px; font-size: 15px; }
@media (min-width: 900px) {
  .je-activity-row { padding: 16px 10px; }
}
@media (max-width: 600px) {
  .je-activity-feed { padding: 14px 0px 32px; }
  .je-activity-topbar { margin-bottom: 14px; }
  .je-activity-title { font-size: 20px; }
  .je-activity-filter, .je-activity-more { color: inherit; background: rgba(128,128,128,.15); border: 1px solid rgba(128,128,128,.5); border-radius: 5px; padding: 8px; font: inherit; }
.je-activity-section { margin-bottom: 22px; }
  .je-activity-section-header { font-size: 17px; padding: 0 2px 8px; }
  .je-activity-row { padding: 10px 2px; gap: 10px; }
  .je-activity-avatar, .je-activity-icon { width: 40px; height: 40px; font-size: 20px; }
  .je-activity-thumb.je-thumb-landscape { width: 92px; height: 52px; }
  .je-activity-thumb.je-thumb-portrait { width: 46px; height: 69px; }
  .je-activity-line { font-size: 15px; white-space: normal; }
  .je-activity-content { font-size: 14px; }
}
`;
      document.head.appendChild(style);
    };
    const VERB_ICON = { Watched: "play_circle", Favorited: "favorite", Reviewed: "rate_review" };
    const VERB_KEY = { Watched: "activity_verb_watched", Favorited: "activity_verb_favorited", Reviewed: "activity_verb_reviewed" };
    const STAR_POLYGON = '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>';
    function starIconHtml(fillFraction) {
      const pct = Math.round(Math.max(0, Math.min(1, fillFraction)) * 100);
      return `<span class="je-activity-rating-star" aria-hidden="true">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${STAR_POLYGON}</svg>
            <svg class="je-activity-rating-star-fill" style="clip-path: inset(0 ${100 - pct}% 0 0);" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${STAR_POLYGON}</svg>
        </span>`;
    }
    function getItemDisplayName(item) {
      if (item.SeriesName && item.SeasonNumber != null && item.EpisodeNumber != null) {
        return `${item.SeriesName} - S${item.SeasonNumber}:E${item.EpisodeNumber} - ${item.Name}`;
      }
      return item.SeriesName || item.Name;
    }
    function relativeTime(ms) {
      const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1e3));
      if (diffSec < 60) return JE.t("activity_time_just_now") || "just now";
      const units = [
        ["y", 31536e3],
        ["mo", 2592e3],
        ["w", 604800],
        ["d", 86400],
        ["h", 3600],
        ["m", 60]
      ];
      for (const [abbr, secs] of units) {
        const n = Math.floor(diffSec / secs);
        if (n >= 1) {
          const tpl = JE.t("activity_time_ago") || "{time} ago";
          return tpl.replace("{time}", `${n}${abbr}`);
        }
      }
      return JE.t("activity_time_just_now") || "just now";
    }
    function buildAvatarElement(userId, hasPrimaryImage) {
      if (!hasPrimaryImage) {
        const icon = document.createElement("div");
        icon.className = "je-activity-icon je-activity-avatar-icon";
        icon.innerHTML = '<i class="material-icons">person</i>';
        return icon;
      }
      const avatar = document.createElement("img");
      avatar.className = "je-activity-avatar";
      avatar.alt = "";
      avatar.src = ApiClient().getUrl(`Users/${userId}/Images/Primary`) + "?height=72&quality=80";
      avatar.onerror = () => {
        avatar.replaceWith(buildAvatarElement(userId, false));
      };
      return avatar;
    }
    function renderRow(entry) {
      const row = document.createElement("div");
      row.className = "je-activity-row";
      row.appendChild(buildAvatarElement(entry.UserId, entry.UserHasPrimaryImage));
      const body = document.createElement("div");
      body.className = "je-activity-body";
      const line = document.createElement("div");
      line.className = "je-activity-line";
      const verbText = JE.t(VERB_KEY[entry.ActivityType] || "") || entry.ActivityType.toLowerCase();
      line.innerHTML = `<span class="je-activity-user"></span> ${verbText} <a href="#" class="je-activity-item-name"></a>`;
      line.querySelector(".je-activity-user").textContent = entry.UserName;
      const nameLink = line.querySelector(".je-activity-item-name");
      nameLink.textContent = getItemDisplayName(entry.Item);
      nameLink.addEventListener("click", (e) => {
        e.preventDefault();
        navigateToItem(entry.Item.Id);
      });
      body.appendChild(line);
      const time = document.createElement("div");
      time.className = "je-activity-time";
      time.textContent = relativeTime(entry.Timestamp);
      body.appendChild(time);
      if (entry.ActivityType === "Reviewed") {
        if (entry.Rating) {
          const rating = document.createElement("div");
          rating.className = "je-activity-rating";
          rating.innerHTML = Array.from(
            { length: 5 },
            (_, index) => starIconHtml(Math.max(0, Math.min(1, (entry.Rating || 0) - index)))
          ).join("");
          body.appendChild(rating);
        }
        if (entry.Content) {
          const content = document.createElement("div");
          content.className = "je-activity-content";
          content.textContent = entry.Content;
          body.appendChild(content);
        }
      }
      row.appendChild(body);
      row.appendChild(buildItemVisual(entry.Item, entry.ActivityType));
      return row;
    }
    function renderWatchRow(entry) {
      const row = document.createElement("div");
      row.className = "je-activity-row";
      row.appendChild(buildAvatarElement(entry.UserId, entry.UserHasPrimaryImage));
      const body = document.createElement("div");
      body.className = "je-activity-body";
      const line = document.createElement("div");
      line.className = "je-activity-line";
      const verbKey = entry.Completed ? "activity_verb_completed_watching" : "activity_verb_watched";
      const verbFallback = entry.Completed ? "completed watching" : "watched";
      const verbText = JE.t(verbKey) || verbFallback;
      line.innerHTML = `<span class="je-activity-user"></span> ${verbText} <a href="#" class="je-activity-item-name"></a>`;
      line.querySelector(".je-activity-user").textContent = entry.UserName;
      const nameLink = line.querySelector(".je-activity-item-name");
      nameLink.textContent = getItemDisplayName(entry.Item);
      nameLink.addEventListener("click", (e) => {
        e.preventDefault();
        navigateToItem(entry.Item.Id);
      });
      body.appendChild(line);
      const time = document.createElement("div");
      time.className = "je-activity-time";
      time.textContent = relativeTime(entry.Timestamp);
      body.appendChild(time);
      if (!entry.Completed) {
        const pct = Math.round(Math.min(1, entry.Progress || 0) * 100);
        const bar = document.createElement("div");
        bar.className = "je-activity-progress";
        const fill = document.createElement("div");
        fill.className = "je-activity-progress-fill";
        fill.style.width = `${pct}%`;
        bar.appendChild(fill);
        body.appendChild(bar);
      }
      row.appendChild(body);
      row.appendChild(buildItemVisual(entry.Item, entry.Completed ? "Watched" : "Watching"));
      return row;
    }
    function buildItemVisual(item, activityType) {
      let posterId, imageType;
      if (item.HasThumbImage) {
        posterId = item.Id;
        imageType = "Thumb";
      } else if (item.SeriesHasThumbImage) {
        posterId = item.SeriesId;
        imageType = "Thumb";
      } else if (item.SeriesHasPrimaryImage) {
        posterId = item.SeriesId;
        imageType = "Primary";
      } else if (item.HasPrimaryImage) {
        posterId = item.Id;
        imageType = "Primary";
      }
      if (posterId) {
        const thumb = document.createElement("img");
        thumb.className = `je-activity-thumb ${imageType === "Thumb" ? "je-thumb-landscape" : "je-thumb-portrait"}`;
        thumb.src = ApiClient().getImageUrl(posterId, { type: imageType || "Primary", width: imageType === "Thumb" ? 120 : 56, quality: 80 });
        thumb.alt = "";
        thumb.addEventListener("click", () => {
          navigateToItem(item.Id);
        });
        return thumb;
      }
      const icon = document.createElement("div");
      icon.className = `je-activity-icon je-activity-${activityType.toLowerCase()}`;
      icon.style.cursor = "pointer";
      icon.innerHTML = `<i class="material-icons">${VERB_ICON[activityType] || "play_circle"}</i>`;
      icon.addEventListener("click", () => {
        navigateToItem(item.Id);
      });
      return icon;
    }
    function renderSessionRow(session) {
      const item = session.NowPlayingItem;
      const ps = session.PlayState || {};
      const row = document.createElement("div");
      row.className = "je-activity-row";
      row.appendChild(buildAvatarElement(session.UserId, session.UserHasPrimaryImage));
      const body = document.createElement("div");
      body.className = "je-activity-body";
      const line = document.createElement("div");
      line.className = "je-activity-line";
      const stateText = ps.IsPaused ? JE.t("activity_verb_active_paused") || "paused watching" : JE.t("activity_verb_active_watching") || "is watching";
      line.innerHTML = `<span class="je-activity-user"></span> ${stateText} <a href="#" class="je-activity-item-name"></a>`;
      line.querySelector(".je-activity-user").textContent = session.UserName;
      const nameLink = line.querySelector(".je-activity-item-name");
      nameLink.textContent = item.SeriesName || item.Name;
      nameLink.addEventListener("click", (e) => {
        e.preventDefault();
        navigateToItem(item.Id);
      });
      body.appendChild(line);
      const dur = item.RunTimeTicks || 0;
      const pos = ps.PositionTicks || 0;
      if (dur > 0) {
        const bar = document.createElement("div");
        bar.className = "je-activity-progress";
        const fill = document.createElement("div");
        fill.className = "je-activity-progress-fill";
        fill.style.width = `${Math.min(100, pos / dur * 100).toFixed(1)}%`;
        bar.appendChild(fill);
        body.appendChild(bar);
      }
      row.appendChild(body);
      let posterId, posterTag, posterType;
      if (item.ImageTags?.Thumb) {
        posterId = item.Id;
        posterTag = item.ImageTags.Thumb;
        posterType = "Thumb";
      } else if (item.ParentThumbImageTag && item.ParentThumbItemId) {
        posterId = item.ParentThumbItemId;
        posterTag = item.ParentThumbImageTag;
        posterType = "Thumb";
      } else if (item.SeriesPrimaryImageTag && item.SeriesId) {
        posterId = item.SeriesId;
        posterTag = item.SeriesPrimaryImageTag;
        posterType = "Primary";
      } else if (item.ImageTags?.Primary) {
        posterId = item.Id;
        posterTag = item.ImageTags.Primary;
        posterType = "Primary";
      }
      if (posterTag && posterId) {
        const thumb = document.createElement("img");
        thumb.className = `je-activity-thumb ${posterType === "Thumb" ? "je-thumb-landscape" : "je-thumb-portrait"}`;
        thumb.src = ApiClient().getImageUrl(posterId, { type: posterType || "Primary", tag: posterTag, width: posterType === "Thumb" ? 120 : 56, quality: 80 });
        thumb.alt = "";
        thumb.addEventListener("click", () => {
          navigateToItem(item.Id);
        });
        row.appendChild(thumb);
      } else {
        const icon = document.createElement("div");
        icon.className = "je-activity-icon je-activity-watched";
        icon.style.cursor = "pointer";
        icon.innerHTML = `<i class="material-icons">${ps.IsPaused ? "pause_circle" : "play_circle"}</i>`;
        icon.addEventListener("click", () => {
          navigateToItem(item.Id);
        });
        row.appendChild(icon);
      }
      return row;
    }
    function renderSection(parent, title, icon) {
      const section = document.createElement("div");
      section.className = "je-activity-section";
      const header = document.createElement("div");
      header.className = "je-activity-section-header";
      header.innerHTML = `<i class="material-icons">${icon}</i><span></span>`;
      header.querySelector("span").textContent = title;
      section.appendChild(header);
      const body = document.createElement("div");
      body.className = "je-activity-section-body";
      body.innerHTML = JE.core.ui.skeletonGridHtml(2, { minWidth: "100%", height: "3.5em" });
      section.appendChild(body);
      parent.appendChild(section);
      return { section, body };
    }
    function fillSection(body, items, rowFn, emptyText) {
      body.textContent = "";
      if (!items || items.length === 0) {
        body.innerHTML = `<div class="je-activity-empty">${emptyText}</div>`;
        return;
      }
      for (const item of items) body.appendChild(rowFn(item));
    }
    let activeStreamsPollTimer = null;
    let pollGeneration = 0;
    let streamsRequest = 0;
    let activeContainer;
    let activeIdentity = () => true;
    let removeRouteListener;
    let disconnectObserver;
    ctx.own.activityPage?.stopPolling();
    JE.session?.onUserChange("activity-page", stopActiveStreamsPolling);
    function stopActiveStreamsPolling() {
      pollGeneration++;
      activeContainer?.replaceChildren();
      activeContainer = void 0;
      removeRouteListener?.();
      removeRouteListener = void 0;
      disconnectObserver?.disconnect();
      disconnectObserver = void 0;
      if (activeStreamsPollTimer) {
        clearInterval(activeStreamsPollTimer);
        activeStreamsPollTimer = null;
      }
    }
    async function refreshActiveStreams(section, body, generation) {
      const request = ++streamsRequest;
      try {
        const sessions = readSessions(await JE.core.api.plugin("/active-streams/sessions", { skipCache: true }));
        if (generation !== pollGeneration || request !== streamsRequest || !section.isConnected || !activeIdentity()) return;
        const active = (sessions || []).filter((s) => s.NowPlayingItem);
        fillSection(body, active, renderSessionRow, JE.t("active_streams_none") || "No Active Streams");
      } catch (e) {
        if (generation !== pollGeneration || request !== streamsRequest || !section.isConnected || !activeIdentity()) return;
        if (!record(e) || e.status !== 403 && e.status !== 404 && e.status !== 401) {
          body.replaceChildren();
          const message = document.createElement("div");
          message.className = "je-activity-error";
          message.textContent = JE.t("activity_error") || "Failed to load recent activity.";
          body.append(message);
          return;
        }
        if (activeStreamsPollTimer) {
          clearInterval(activeStreamsPollTimer);
          activeStreamsPollTimer = null;
        }
        section.remove();
      }
    }
    function activityRoute(hash) {
      const normalized = hash.replace(/^#!/, "#");
      const question = normalized.indexOf("?");
      if (question < 0) return normalized;
      const path = normalized.slice(0, question);
      if (path !== "#/home" && path !== "#/home.html") return normalized;
      const params = new URLSearchParams(normalized.slice(question + 1));
      const tab = params.get("tab");
      if (tab === null || !/^\d+$/.test(tab) || !Number.isSafeInteger(Number(tab))) return normalized;
      params.set("tab", String(Number(tab)));
      if (params.get("jeTab") === "activity") params.delete("jeTab");
      params.sort();
      return path + "?" + params.toString();
    }
    async function renderForCustomTab(host) {
      applyThemeVars();
      stopActiveStreamsPolling();
      const generation = pollGeneration;
      activeIdentity = currentLease(JE.session, getApi);
      const identity = activeIdentity;
      host.textContent = "";
      const container = document.createElement("div");
      container.className = "je-activity-feed";
      host.appendChild(container);
      activeContainer = container;
      const route = activityRoute(window.location.hash);
      const onRoute = () => {
        if (activityRoute(window.location.hash) !== route && generation === pollGeneration) stopActiveStreamsPolling();
      };
      window.addEventListener("hashchange", onRoute);
      removeRouteListener = () => window.removeEventListener("hashchange", onRoute);
      const current = () => activityRoute(window.location.hash) === route && generation === pollGeneration && container.isConnected && identity();
      disconnectObserver = new MutationObserver(() => {
        if (!container.isConnected && generation === pollGeneration) stopActiveStreamsPolling();
      });
      disconnectObserver.observe(document.body, { childList: true, subtree: true });
      const config = JE.pluginConfig || {};
      const topBar = document.createElement("div");
      topBar.className = "je-activity-topbar";
      const titleEl = document.createElement("div");
      titleEl.className = "je-activity-title";
      titleEl.textContent = JE.t("activity_title") || "Activity";
      const refreshBtn = document.createElement("button");
      refreshBtn.type = "button";
      refreshBtn.className = "je-activity-refresh-btn";
      refreshBtn.title = "Refresh";
      refreshBtn.setAttribute("aria-label", "Refresh");
      refreshBtn.innerHTML = '<i class="material-icons">refresh</i>';
      topBar.appendChild(titleEl);
      topBar.appendChild(refreshBtn);
      container.appendChild(topBar);
      const filters = document.createElement("select");
      filters.className = "je-activity-filter";
      filters.setAttribute("aria-label", translate("activity_filter", "Activity type"));
      for (const [value, label] of [["", translate("activity_filter_all", "All activity")], ["Watched", translate("activity_section_watch_history", "Watch history")], ["Reviewed", translate("panel_settings_spoiler_guard_override_reviews", "Reviews")], ["Favorited", translate("activity_filter_favorites", "Favorites")]]) {
        const option = document.createElement("option");
        option.value = value || "";
        option.textContent = label || "";
        filters.append(option);
      }
      topBar.append(filters);
      let feed = [];
      let limit = 50;
      let feedRequest = 0;
      let feedError = false;
      const more = document.createElement("button");
      more.className = "je-activity-more";
      more.textContent = translate("activity_load_more", "Load more");
      more.hidden = true;
      let activeSection = null;
      if (config.ActiveStreamsEnabled && config.ActivityFeedShowActiveStreams) {
        activeSection = renderSection(
          container,
          JE.t("activity_section_active_streams") || "Active Streams",
          "cast"
        );
      }
      let watch = null;
      if (config.ActivityFeedShowWatched) {
        watch = renderSection(container, JE.t("activity_section_watch_history") || "Watch History", "history");
      }
      let reviews = null;
      if (config.ActivityFeedShowFavorited || config.ActivityFeedShowReviewed) {
        reviews = renderSection(
          container,
          JE.t("panel_settings_spoiler_guard_override_reviews") || "Reviews",
          "rate_review"
        );
      }
      container.append(more);
      function paintFeed() {
        const selected = filters.value;
        if (watch) {
          watch.section.hidden = !!selected && selected !== "Watched";
          fillSection(watch.body, feed.filter((i) => i.ActivityType === "Watched"), renderWatchRow, JE.t("activity_empty") || "No recent activity yet.");
        }
        if (reviews) {
          reviews.section.hidden = selected === "Watched";
          fillSection(reviews.body, feed.filter((i) => (i.ActivityType === "Reviewed" || i.ActivityType === "Favorited") && (!selected || i.ActivityType === selected)).sort((a, b) => b.Timestamp - a.Timestamp), renderRow, JE.t("activity_empty") || "No recent activity yet.");
        }
        more.hidden = feed.length < limit || limit >= 200;
      }
      filters.onchange = () => {
        if (current() && !feedError) paintFeed();
      };
      more.onclick = async () => {
        if (more.disabled || !current()) return;
        more.disabled = true;
        const previous = limit;
        limit = Math.min(200, limit + 50);
        const request = feedRequest + 1;
        try {
          if (!await loadAll() && request === feedRequest) limit = previous;
        } finally {
          if (current()) more.disabled = false;
        }
      };
      async function loadAll() {
        if (!current()) return false;
        const request = ++feedRequest;
        let succeeded = true;
        const tasks = [];
        if (activeSection) {
          tasks.push(refreshActiveStreams(activeSection.section, activeSection.body, generation));
        }
        if (watch || reviews) {
          tasks.push((async () => {
            try {
              const data = await JE.core.api.plugin(limit === 50 ? "/activity" : `/activity?limit=${limit}`, { skipCache: true });
              const items = readFeed(data);
              if (!current() || request !== feedRequest) return;
              feedError = false;
              feed = items;
              paintFeed();
            } catch (e) {
              if (!current() || request !== feedRequest) return;
              succeeded = false;
              feedError = true;
              console.warn(`${LOG} Failed to load activity feed`, e);
              const errorText = JE.t("activity_error") || "Failed to load recent activity.";
              if (watch) watch.body.innerHTML = `<div class="je-activity-error">${errorText}</div>`;
              if (reviews) reviews.body.innerHTML = `<div class="je-activity-error">${errorText}</div>`;
            }
          })());
        }
        await Promise.all(tasks);
        return succeeded && current() && request === feedRequest;
      }
      refreshBtn.addEventListener("click", () => {
        if (refreshBtn.disabled) return;
        refreshBtn.disabled = true;
        refreshBtn.classList.add("je-activity-refresh-spin");
        loadAll().finally(() => {
          refreshBtn.disabled = false;
          refreshBtn.classList.remove("je-activity-refresh-spin");
        });
      });
      await loadAll();
      if (!current()) return;
      if (activeSection?.section.isConnected) {
        activeStreamsPollTimer = setInterval(() => {
          if (generation !== pollGeneration) return;
          if (!container.isConnected || !identity()) {
            stopActiveStreamsPolling();
            return;
          }
          if (document.visibilityState === "hidden") return;
          if (activeSection) refreshActiveStreams(activeSection.section, activeSection.body, generation);
        }, ACTIVE_STREAMS_POLL_MS);
      }
    }
    ctx.own.activityPage = {
      injectStyles,
      renderForCustomTab,
      stopPolling: stopActiveStreamsPolling
    };
  })();
})();
})();
//# sourceMappingURL=activity-page.js.map
