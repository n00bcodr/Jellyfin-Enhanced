// /js/extras/activity-page.js
// Core Activity Feed renderer: three sections -- Active Streams (live, reuses
// GET /JellyfinEnhanced/active-streams/sessions), Watch History (threshold-
// gated "Watched" entries from GET /JellyfinEnhanced/activity, distinguishing
// started-vs-finished), and Reviews (Reviewed + Favorited entries merged).
// Exposes JE.activityPage = { injectStyles, renderForCustomTab } so any host
// container -- the native Home tab, a Custom Tabs panel, or the Plugin Pages
// standalone page -- can mount the same rendering logic. See
// activity-custom-tab.js for the container-finding/mounting side.

(function (JE) {
    'use strict';

    if (!window.JellyfinEnhanced?.pluginConfig?.ActivityFeedEnabled) {
        return;
    }

    const LOG = '🪼 Jellyfin Enhanced: Activity Feed:';
    const ACTIVE_STREAMS_POLL_MS = 15000;

    // ── Theme-aware accent color ────────────────────────────────────────────
    const getAccentColor = () => {
        try {
            return JE?.themer?.getThemeVariables?.()?.primaryAccent || '#00a4dc';
        } catch (_) {
            return '#00a4dc';
        }
    };

    const applyThemeVars = () => {
        document.documentElement.style.setProperty('--je-activity-accent', getAccentColor());
    };

    // ── Navigation ───────────────────────────────────────────────────────────
    // Same pattern used across the plugin (active-streams.js, requests-page,
    // random-button): prefer Emby.Page.showItem so it navigates within the
    // SPA instead of triggering an app-link/deep-link handler, falling back
    // to a plain hash change if that API isn't available.
    function navigateToItem(itemId) {
        if (!itemId) return;
        try {
            if (typeof Emby !== 'undefined' && Emby.Page?.showItem) {
                Emby.Page.showItem(itemId);
                return;
            }
        } catch (_) { /* fall through to hash */ }
        window.location.hash = `#!/details?id=${itemId}`;
    }

    // ── CSS ──────────────────────────────────────────────────────────────────
    const injectStyles = () => {
        if (document.getElementById('je-activity-feed-styles')) return;
        const style = document.createElement('style');
        style.id = 'je-activity-feed-styles';
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

    // ── Helpers ──────────────────────────────────────────────────────────────
    const VERB_ICON = { Watched: 'play_circle', Favorited: 'favorite', Reviewed: 'rate_review' };
    const VERB_KEY = { Watched: 'activity_verb_watched', Favorited: 'activity_verb_favorited', Reviewed: 'activity_verb_reviewed' };

    // Matches reviews.js's own copy and JE.icons.LUCIDE.star in icons.js.
    const STAR_POLYGON = '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>';
    function starIconHtml(fillFraction) {
        const pct = Math.round(Math.max(0, Math.min(1, fillFraction)) * 100);
        return `<span class="je-activity-rating-star" aria-hidden="true">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${STAR_POLYGON}</svg>
            <svg class="je-activity-rating-star-fill" style="clip-path: inset(0 ${100 - pct}% 0 0);" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${STAR_POLYGON}</svg>
        </span>`;
    }

    /** "Series Name - S1:E3 - Episode Title" for episodes, plain Name otherwise. */
    function getItemDisplayName(item) {
        if (item.SeriesName && item.SeasonNumber != null && item.EpisodeNumber != null) {
            return `${item.SeriesName} - S${item.SeasonNumber}:E${item.EpisodeNumber} - ${item.Name}`;
        }
        return item.SeriesName || item.Name;
    }

    // Compact abbreviations (5m, 2h, 3d, 1w, 4mo, 1y) rather than full unit
    // words -- cross-language-understandable at a glance (same convention as
    // most social feeds), so only the "{time} ago" / "just now" wrapper needs
    // translating, not every unit word in every language.
    function relativeTime(ms) {
        const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
        if (diffSec < 60) return JE.t('activity_time_just_now') || 'just now';
        const units = [
            ['y', 31536000], ['mo', 2592000], ['w', 604800],
            ['d', 86400], ['h', 3600], ['m', 60]
        ];
        for (const [abbr, secs] of units) {
            const n = Math.floor(diffSec / secs);
            if (n >= 1) {
                const tpl = JE.t('activity_time_ago') || '{time} ago';
                return tpl.replace('{time}', `${n}${abbr}`);
            }
        }
        return JE.t('activity_time_just_now') || 'just now';
    }

    /** Reviews section row: Reviewed (rating + snippet) or Favorited. */
    function renderRow(entry) {
        const row = document.createElement('div');
        row.className = 'je-activity-row';

        const avatar = document.createElement('img');
        avatar.className = 'je-activity-avatar';
        avatar.src = ApiClient.getUrl(`Users/${entry.UserId}/Images/Primary`) + '?height=72&quality=80';
        avatar.alt = '';
        avatar.onerror = () => { avatar.style.visibility = 'hidden'; };
        row.appendChild(avatar);

        const body = document.createElement('div');
        body.className = 'je-activity-body';

        const line = document.createElement('div');
        line.className = 'je-activity-line';
        const verbText = JE.t(VERB_KEY[entry.ActivityType]) || entry.ActivityType.toLowerCase();
        line.innerHTML = `<span class="je-activity-user"></span> ${verbText} <a href="#" class="je-activity-item-name"></a>`;
        line.querySelector('.je-activity-user').textContent = entry.UserName;
        const nameLink = line.querySelector('.je-activity-item-name');
        nameLink.textContent = getItemDisplayName(entry.Item);
        nameLink.addEventListener('click', (e) => { e.preventDefault(); navigateToItem(entry.Item.Id); });
        body.appendChild(line);

        const time = document.createElement('div');
        time.className = 'je-activity-time';
        time.textContent = relativeTime(entry.Timestamp);
        body.appendChild(time);

        if (entry.ActivityType === 'Reviewed') {
            if (entry.Rating) {
                const rating = document.createElement('div');
                rating.className = 'je-activity-rating';
                rating.innerHTML = Array.from({ length: 5 }, (_, index) =>
                    starIconHtml(Math.max(0, Math.min(1, entry.Rating - index)))
                ).join('');
                body.appendChild(rating);
            }
            if (entry.Content) {
                const content = document.createElement('div');
                content.className = 'je-activity-content';
                content.textContent = entry.Content;
                body.appendChild(content);
            }
        }

        row.appendChild(body);
        row.appendChild(buildItemVisual(entry.Item, entry.ActivityType));
        return row;
    }

    /** Watch History section row: "watched" (partial) vs "completed watching", plus a highest-ever progress bar. */
    function renderWatchRow(entry) {
        const row = document.createElement('div');
        row.className = 'je-activity-row';

        const avatar = document.createElement('img');
        avatar.className = 'je-activity-avatar';
        avatar.src = ApiClient.getUrl(`Users/${entry.UserId}/Images/Primary`) + '?height=72&quality=80';
        avatar.alt = '';
        avatar.onerror = () => { avatar.style.visibility = 'hidden'; };
        row.appendChild(avatar);

        const body = document.createElement('div');
        body.className = 'je-activity-body';

        const line = document.createElement('div');
        line.className = 'je-activity-line';
        const verbKey = entry.Completed ? 'activity_verb_completed_watching' : 'activity_verb_watched';
        const verbFallback = entry.Completed ? 'completed watching' : 'watched';
        const verbText = JE.t(verbKey) || verbFallback;
        line.innerHTML = `<span class="je-activity-user"></span> ${verbText} <a href="#" class="je-activity-item-name"></a>`;
        line.querySelector('.je-activity-user').textContent = entry.UserName;
        const nameLink = line.querySelector('.je-activity-item-name');
        nameLink.textContent = getItemDisplayName(entry.Item);
        nameLink.addEventListener('click', (e) => { e.preventDefault(); navigateToItem(entry.Item.Id); });
        body.appendChild(line);

        const time = document.createElement('div');
        time.className = 'je-activity-time';
        time.textContent = relativeTime(entry.Timestamp);
        body.appendChild(time);

        // A completed watch is fully done -- a full-width bar would be pure
        // noise. Only show progress for a still-partial watch.
        if (!entry.Completed) {
            const pct = Math.round(Math.min(1, entry.Progress || 0) * 100);
            const bar = document.createElement('div');
            bar.className = 'je-activity-progress';
            const fill = document.createElement('div');
            fill.className = 'je-activity-progress-fill';
            fill.style.width = `${pct}%`;
            bar.appendChild(fill);
            body.appendChild(bar);
        }

        row.appendChild(body);
        row.appendChild(buildItemVisual(entry.Item, entry.Completed ? 'Watched' : 'Watching'));
        return row;
    }

    /**
     * Thumbnail if the item (or its series) has one, otherwise a
     * type-colored icon badge. Both link to the item. For episodes, prefers
     * the series' own Thumb/Primary over the episode's - an episode's own
     * Primary is often just an arbitrary auto-extracted video frame, not a
     * designed image.
     */
    function buildItemVisual(item, activityType) {
        let posterId, imageType;
        if (item.HasThumbImage) {
            posterId = item.Id; imageType = 'Thumb';
        } else if (item.SeriesHasThumbImage) {
            posterId = item.SeriesId; imageType = 'Thumb';
        } else if (item.SeriesHasPrimaryImage) {
            posterId = item.SeriesId; imageType = 'Primary';
        } else if (item.HasPrimaryImage) {
            posterId = item.Id; imageType = 'Primary';
        }

        if (posterId) {
            const thumb = document.createElement('img');
            thumb.className = `je-activity-thumb ${imageType === 'Thumb' ? 'je-thumb-landscape' : 'je-thumb-portrait'}`;
            thumb.src = ApiClient.getImageUrl(posterId, { type: imageType, width: imageType === 'Thumb' ? 120 : 56, quality: 80 });
            thumb.alt = '';
            thumb.addEventListener('click', () => { navigateToItem(item.Id); });
            return thumb;
        }
        const icon = document.createElement('div');
        icon.className = `je-activity-icon je-activity-${activityType.toLowerCase()}`;
        icon.style.cursor = 'pointer';
        icon.innerHTML = `<i class="material-icons">${VERB_ICON[activityType] || 'play_circle'}</i>`;
        icon.addEventListener('click', () => { navigateToItem(item.Id); });
        return icon;
    }

    /** Active Streams section row -- live now-playing session. */
    function renderSessionRow(session) {
        const item = session.NowPlayingItem;
        const ps = session.PlayState || {};

        const row = document.createElement('div');
        row.className = 'je-activity-row';

        const avatar = document.createElement('img');
        avatar.className = 'je-activity-avatar';
        avatar.src = ApiClient.getUrl(`Users/${session.UserId}/Images/Primary`) + '?height=72&quality=80';
        avatar.alt = '';
        avatar.onerror = () => { avatar.style.visibility = 'hidden'; };
        row.appendChild(avatar);

        const body = document.createElement('div');
        body.className = 'je-activity-body';

        const line = document.createElement('div');
        line.className = 'je-activity-line';
        const stateText = ps.IsPaused
            ? (JE.t('activity_verb_active_paused') || 'paused watching')
            : (JE.t('activity_verb_active_watching') || 'is watching');
        line.innerHTML = `<span class="je-activity-user"></span> ${stateText} <a href="#" class="je-activity-item-name"></a>`;
        line.querySelector('.je-activity-user').textContent = session.UserName;
        const nameLink = line.querySelector('.je-activity-item-name');
        nameLink.textContent = item.SeriesName || item.Name;
        nameLink.addEventListener('click', (e) => { e.preventDefault(); navigateToItem(item.Id); });
        body.appendChild(line);

        const dur = item.RunTimeTicks || 0;
        const pos = ps.PositionTicks || 0;
        if (dur > 0) {
            const bar = document.createElement('div');
            bar.className = 'je-activity-progress';
            const fill = document.createElement('div');
            fill.className = 'je-activity-progress-fill';
            fill.style.width = `${Math.min(100, (pos / dur) * 100).toFixed(1)}%`;
            bar.appendChild(fill);
            body.appendChild(bar);
        }

        row.appendChild(body);

        // Prefer a Thumb image (own, then inherited from season/series) since
        // it matches the landscape row layout; fall back to the series
        // poster over the episode's own Primary (same convention as the
        // Active Streams header widget), then the item's own Primary.
        let posterId, posterTag, posterType;
        if (item.ImageTags?.Thumb) {
            posterId = item.Id; posterTag = item.ImageTags.Thumb; posterType = 'Thumb';
        } else if (item.ParentThumbImageTag && item.ParentThumbItemId) {
            posterId = item.ParentThumbItemId; posterTag = item.ParentThumbImageTag; posterType = 'Thumb';
        } else if (item.SeriesPrimaryImageTag && item.SeriesId) {
            posterId = item.SeriesId; posterTag = item.SeriesPrimaryImageTag; posterType = 'Primary';
        } else if (item.ImageTags?.Primary) {
            posterId = item.Id; posterTag = item.ImageTags.Primary; posterType = 'Primary';
        }
        if (posterTag && posterId) {
            const thumb = document.createElement('img');
            thumb.className = `je-activity-thumb ${posterType === 'Thumb' ? 'je-thumb-landscape' : 'je-thumb-portrait'}`;
            thumb.src = ApiClient.getImageUrl(posterId, { type: posterType, tag: posterTag, width: posterType === 'Thumb' ? 120 : 56, quality: 80 });
            thumb.alt = '';
            thumb.addEventListener('click', () => { navigateToItem(item.Id); });
            row.appendChild(thumb);
        } else {
            const icon = document.createElement('div');
            icon.className = 'je-activity-icon je-activity-watched';
            icon.style.cursor = 'pointer';
            icon.innerHTML = `<i class="material-icons">${ps.IsPaused ? 'pause_circle' : 'play_circle'}</i>`;
            icon.addEventListener('click', () => { navigateToItem(item.Id); });
            row.appendChild(icon);
        }

        return row;
    }

    /** Creates a titled section (header + body) and appends it to parent. Returns the body element to fill. */
    function renderSection(parent, title, icon) {
        const section = document.createElement('div');
        section.className = 'je-activity-section';

        const header = document.createElement('div');
        header.className = 'je-activity-section-header';
        header.innerHTML = `<i class="material-icons">${icon}</i><span></span>`;
        header.querySelector('span').textContent = title;
        section.appendChild(header);

        const body = document.createElement('div');
        body.className = 'je-activity-section-body';
        section.appendChild(body);

        parent.appendChild(section);
        return { section, body };
    }

    function fillSection(body, items, rowFn, emptyText) {
        body.textContent = '';
        if (!items || items.length === 0) {
            body.innerHTML = `<div class="je-activity-empty">${emptyText}</div>`;
            return;
        }
        for (const item of items) body.appendChild(rowFn(item));
    }

    let activeStreamsPollTimer = null;
    function stopActiveStreamsPolling() {
        if (activeStreamsPollTimer) {
            clearInterval(activeStreamsPollTimer);
            activeStreamsPollTimer = null;
        }
    }

    async function refreshActiveStreams(section, body) {
        try {
            const sessions = await JE.core.api.plugin('/active-streams/sessions');
            const active = (sessions || []).filter(s => s.NowPlayingItem);
            fillSection(body, active, renderSessionRow, JE.t('active_streams_none') || 'No Active Streams');
        } catch (e) {
            // Feature disabled or this viewer isn't allowed to see it -- drop
            // the whole section rather than show an error for something that
            // isn't actually broken.
            stopActiveStreamsPolling();
            section.remove();
        }
    }

    /**
     * Renders the feed into the given host element (a native tab panel, a
     * Custom Tabs panel, or the Plugin Pages standalone page's container --
     * all equally valid mount points, this doesn't care which).
     * @param {HTMLElement} host
     */
    async function renderForCustomTab(host) {
        applyThemeVars();
        stopActiveStreamsPolling();
        host.textContent = '';
        const container = document.createElement('div');
        container.className = 'je-activity-feed';
        host.appendChild(container);

        const config = JE.pluginConfig || {};

        // Top bar: title + manual refresh (re-fetches every section in place,
        // no full page reload).
        const topBar = document.createElement('div');
        topBar.className = 'je-activity-topbar';
        const titleEl = document.createElement('div');
        titleEl.className = 'je-activity-title';
        titleEl.textContent = JE.t('activity_title') || 'Activity';
        const refreshBtn = document.createElement('button');
        refreshBtn.type = 'button';
        refreshBtn.className = 'je-activity-refresh-btn';
        refreshBtn.title = 'Refresh';
        refreshBtn.innerHTML = '<i class="material-icons">refresh</i>';
        topBar.appendChild(titleEl);
        topBar.appendChild(refreshBtn);
        container.appendChild(topBar);

        // Each section is only created (header included) when its admin
        // toggle is on -- an empty section with a heading and nothing under
        // it is worse than no section at all.
        let activeSection = null;
        if (config.ActiveStreamsEnabled && config.ActivityFeedShowActiveStreams) {
            activeSection = renderSection(
                container, JE.t('activity_section_active_streams') || 'Active Streams', 'cast');
        }

        let watch = null;
        if (config.ActivityFeedShowWatched) {
            watch = renderSection(container, JE.t('activity_section_watch_history') || 'Watch History', 'history');
        }

        let reviews = null;
        if (config.ActivityFeedShowFavorited || config.ActivityFeedShowReviewed) {
            reviews = renderSection(
                container, JE.t('panel_settings_spoiler_guard_override_reviews') || 'Reviews', 'rate_review');
        }

        async function loadAll() {
            const tasks = [];
            if (activeSection) {
                tasks.push(refreshActiveStreams(activeSection.section, activeSection.body));
            }

            if (watch || reviews) {
                const emptyText = JE.t('activity_empty') || 'No recent activity yet.';
                tasks.push((async () => {
                    try {
                        const data = await JE.core.api.plugin('/activity');
                        const items = data?.items || [];

                        if (watch) {
                            fillSection(watch.body, items.filter(i => i.ActivityType === 'Watched'), renderWatchRow, emptyText);
                        }
                        if (reviews) {
                            const merged = items
                                .filter(i => i.ActivityType === 'Reviewed' || i.ActivityType === 'Favorited')
                                .sort((a, b) => b.Timestamp - a.Timestamp);
                            fillSection(reviews.body, merged, renderRow, emptyText);
                        }
                    } catch (e) {
                        console.warn(`${LOG} Failed to load activity feed`, e);
                        const errorText = JE.t('activity_error') || 'Failed to load recent activity.';
                        if (watch) watch.body.innerHTML = `<div class="je-activity-error">${errorText}</div>`;
                        if (reviews) reviews.body.innerHTML = `<div class="je-activity-error">${errorText}</div>`;
                    }
                })());
            }

            await Promise.all(tasks);
        }

        refreshBtn.addEventListener('click', () => {
            if (refreshBtn.disabled) return;
            refreshBtn.disabled = true;
            refreshBtn.classList.add('je-activity-refresh-spin');
            loadAll().finally(() => {
                refreshBtn.disabled = false;
                refreshBtn.classList.remove('je-activity-refresh-spin');
            });
        });

        await loadAll();

        if (activeSection) {
            activeStreamsPollTimer = setInterval(
                () => refreshActiveStreams(activeSection.section, activeSection.body), ACTIVE_STREAMS_POLL_MS);
        }
    }

    window.JellyfinEnhanced.activityPage = {
        injectStyles,
        renderForCustomTab
    };

})(window.JellyfinEnhanced);
