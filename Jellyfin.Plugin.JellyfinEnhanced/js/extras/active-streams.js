// /js/extras/active-streams.js
// Shows a live Active Streams counter in the Jellyfin header.

(function (JE) {
    'use strict';

    const LOG = '🪼 Jellyfin Enhanced:';
    const POLL_INTERVAL = 15000;

    // ── State ────────────────────────────────────────────────────────────────
    let _pollTimer = null;
    let _panelOpen = false;
    let _observer = null;
    let _hashListener = null;
    let _outsideClickListener = null;
    let _lastUpdated = null;

    // ── Helpers ──────────────────────────────────────────────────────────────
    const ticksToTime = (ticks) => {
        if (!ticks) return '0:00';
        const totalSec = Math.floor(ticks / 10000000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        return `${m}:${String(s).padStart(2, '0')}`;
    };

    // ── Theme-aware colours ──────────────────────────────────────────────────
    const getAccentColor = () => {
        try {
            return JE?.themer?.getThemeVariables?.()?.primaryAccent || '#00a4dc';
        } catch (_) {
            return '#00a4dc';
        }
    };

    const applyThemeVars = () => {
        document.documentElement.style.setProperty('--je-as-accent', getAccentColor());
    };

    // ── CSS injection ────────────────────────────────────────────────────────
    const injectStyles = () => {
        if (document.getElementById('je-active-streams-styles')) return;
        const style = document.createElement('style');
        style.id = 'je-active-streams-styles';
        style.textContent = `
#je-active-streams {
  position: relative;
  overflow: visible;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  flex-shrink: 0;
}
#je-active-streams .je-as-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  transition: color 0.3s;
}
#je-active-streams .je-as-sup {
  position: absolute;
  top: 2px;
  right: 2px;
  min-width: 12px;
  padding: 0;
  font-size: 11px;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: -0.15px;
  pointer-events: none;
  text-align: center;
  white-space: nowrap;
  transition: color 0.3s;
}
#je-active-streams .je-as-sup:empty { display: none; }
#je-active-streams.je-as-active .je-as-icon,
#je-active-streams.je-as-active .je-as-sup { color: var(--je-as-accent, #00a4dc); }
#je-active-streams.je-as-err .je-as-icon   { color: #b91c1c; }
#je-active-streams.je-as-err .je-as-sup    { color: #991b1b; }

/* Panel */
#je-active-streams-panel {
  position: fixed;
  right: 12px;
  width: 360px;
  max-height: calc(100vh - 72px);
  overflow-y: auto;
  background: rgba(18,18,18,0.97);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 10px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.7);
  z-index: 9999;
  padding: 12px;
  display: none;
  flex-direction: column;
  gap: 10px;
}
#je-active-streams-panel.je-as-panel-open { display: flex; }

.je-as-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
}
.je-as-panel-title {
  font-size: 13px;
  font-weight: 600;
  color: rgba(255,255,255,0.85);
  letter-spacing: 0.3px;
}
.je-as-panel-close {
  background: none;
  border: none;
  color: rgba(255,255,255,0.4);
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  padding: 0;
  display: flex;
  align-items: center;
}
.je-as-panel-close:hover { color: rgba(255,255,255,0.8); }
.je-as-panel-empty {
  font-size: 13px;
  color: rgba(255,255,255,0.35);
  text-align: center;
  padding: 20px 0;
}

/* Session card */
.je-as-card {
  background: rgba(255,255,255,0.07);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.je-as-card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.je-as-card-info { flex: 1; min-width: 0; }
.je-as-card-title {
  font-size: 13px;
  font-weight: 600;
  color: rgba(255,255,255,0.9);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.je-as-card-subtitle {
  font-size: 11px;
  color: rgba(255,255,255,0.45);
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.je-as-state {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 4px;
  flex-shrink: 0;
  letter-spacing: 0.4px;
  text-transform: uppercase;
}
.je-as-state-playing { background: rgba(29,78,216,0.25); color: #93c5fd; }
.je-as-state-paused  { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.4); }

/* Progress */
.je-as-progress-row {
  display: flex;
  align-items: center;
  gap: 7px;
}
.je-as-progress-bar {
  flex: 1;
  height: 3px;
  background: rgba(255,255,255,0.1);
  border-radius: 2px;
  overflow: hidden;
}
.je-as-progress-fill {
  height: 100%;
  background: var(--je-as-accent, #00a4dc);
  border-radius: 2px;
  transition: width 0.4s;
}
.je-as-progress-time {
  font-size: 10px;
  color: rgba(255,255,255,0.35);
  white-space: nowrap;
}

/* Badges */
.je-as-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 2px;
}
.je-as-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
  letter-spacing: 0.3px;
}
.je-as-badge-direct    { background: rgba(16,185,129,0.15); color: #6ee7b7; }
.je-as-badge-transcode { background: rgba(245,158,11,0.15); color: #fcd34d; }
.je-as-badge-neutral   { background: rgba(255,255,255,0.07); color: rgba(255,255,255,0.45); }
.je-as-badge-reason    { background: rgba(239,68,68,0.12); color: #fca5a5; font-style: italic; }

/* User row */
.je-as-user {
  font-size: 11px;
  color: rgba(255,255,255,0.35);
  display: flex;
  align-items: center;
  gap: 4px;
}
.je-as-user .material-icons { font-size: 13px; opacity: 0.5; }
.je-as-avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}

/* Panel open animation */
@keyframes je-as-fadein {
  from { opacity: 0; transform: translateY(-6px); }
  to   { opacity: 1; transform: translateY(0); }
}
#je-active-streams-panel.je-as-panel-open {
  animation: je-as-fadein 150ms ease forwards;
}

/* Poster thumbnail */
.je-as-card-with-poster {
  flex-direction: row !important;
  align-items: flex-start;
  gap: 10px !important;
}
.je-as-poster {
  width: 40px;
  height: 60px;
  border-radius: 4px;
  object-fit: cover;
  flex-shrink: 0;
  background: rgba(255,255,255,0.06);
}
.je-as-poster-placeholder {
  width: 40px;
  height: 60px;
  border-radius: 4px;
  background: rgba(255,255,255,0.06);
  flex-shrink: 0;
}
.je-as-card-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }

/* Clickable title */
.je-as-card-title-link {
  cursor: pointer;
  text-decoration: none;
  color: inherit;
}
.je-as-card-title-link:hover { text-decoration: underline; }

/* Last updated footer */
.je-as-panel-footer {
  font-size: 10px;
  color: rgba(255,255,255,0.45);
  text-align: right;
  padding-top: 6px;
  border-top: 1px solid rgba(255,255,255,0.08);
  margin-top: 2px;
}`;
        document.head.appendChild(style);
    };

    // ── Visibility check ─────────────────────────────────────────────────────
    // Admins always see it. Non-admins only if ActiveStreamsAllUsers is enabled.
    const isVisible = () => {
        const isAdmin = JE?.currentUser?.Policy?.IsAdministrator === true;
        if (isAdmin) return true;
        return JE?.pluginConfig?.ActiveStreamsAllUsers === true;
    };

    // ── API — uses plugin proxy so non-admins don't need Sessions permission ─
    const fetchSessions = async () => {
        try {
            const token = ApiClient?.accessToken?.() || '';
            const resp = await fetch(ApiClient.getUrl('/JellyfinEnhanced/active-streams/sessions'), {
                headers: { 'X-MediaBrowser-Token': token }
            });
            if (!resp.ok) return null;
            return await resp.json();
        } catch (_) {
            return null;
        }
    };

    // ── Badge builder ────────────────────────────────────────────────────────
    const buildBadgeElements = (session) => {
        const badges = [];
        const ts = session.TranscodingInfo;
        const ps = session.PlayState || {};

        if (ts && ts.IsVideoDirect === false) {
            badges.push({ label: 'Transcoding', cls: 'je-as-badge-transcode' });
            if (ts.VideoCodec) badges.push({ label: ts.VideoCodec.toUpperCase(), cls: 'je-as-badge-neutral' });
            if (ts.AudioCodec) badges.push({ label: ts.AudioCodec.toUpperCase(), cls: 'je-as-badge-neutral' });
            if (ts.Bitrate) {
                const kbps = Math.round(ts.Bitrate / 1000);
                badges.push({ label: kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`, cls: 'je-as-badge-neutral' });
            }
            if (ts.Width && ts.Height) {
                badges.push({ label: `${ts.Width}\u00d7${ts.Height}`, cls: 'je-as-badge-neutral' });
            }
            if (ts.Framerate) {
                badges.push({ label: `${Math.round(ts.Framerate)}fps`, cls: 'je-as-badge-neutral' });
            }
        } else {
            badges.push({ label: 'Direct Play', cls: 'je-as-badge-direct' });
            const stream = session.NowPlayingItem?.MediaStreams?.find(s => s.Type === 'Video');
            if (stream?.Codec) badges.push({ label: stream.Codec.toUpperCase(), cls: 'je-as-badge-neutral' });
            if (stream?.BitRate) {
                const kbps = Math.round(stream.BitRate / 1000);
                badges.push({ label: kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`, cls: 'je-as-badge-neutral' });
            }
        }

        if (ps.PlayMethod === 'Transcode' && ts?.TranscodeReasons?.length) {
            const reason = ts.TranscodeReasons[0].replace(/([A-Z])/g, ' $1').trim();
            badges.push({ label: reason, cls: 'je-as-badge-reason' });
        }

        return badges.map(b => {
            const span = document.createElement('span');
            span.className = `je-as-badge ${b.cls}`;
            span.textContent = b.label;
            return span;
        });
    };

    // ── Session card builder ─────────────────────────────────────────────────
    const buildSessionCard = (session) => {
        const item = session.NowPlayingItem;
        const ps = session.PlayState || {};
        const isPaused = ps.IsPaused;
        const isAdmin = JE?.currentUser?.Policy?.IsAdministrator === true;

        const title = item.SeriesName || item.Name || 'Unknown';
        const subtitle = item.SeriesName
            ? `S${String(item.ParentIndexNumber || 0).padStart(2, '0')}E${String(item.IndexNumber || 0).padStart(2, '0')} \u00b7 ${item.Name}`
            : (item.ProductionYear ? String(item.ProductionYear) : '');

        const pos = ps.PositionTicks || 0;
        const dur = item.RunTimeTicks || 0;
        const pct = dur ? Math.min(100, (pos / dur) * 100).toFixed(1) : 0;

        const card = document.createElement('div');
        card.className = 'je-as-card je-as-card-with-poster';

        // ── Poster thumbnail ─────────────────────────────────────────────────
        // For episodes, prefer the series poster over the episode thumbnail.
        const seriesTag = item.SeriesPrimaryImageTag;
        const seriesId  = item.SeriesId;
        const primaryTag = item.ImageTags?.Primary;
        const posterId  = (seriesId && seriesTag) ? seriesId : item.Id;
        const posterTag = (seriesId && seriesTag) ? seriesTag : primaryTag;
        if (posterTag && posterId && typeof ApiClient !== 'undefined') {
            const poster = document.createElement('img');
            poster.className = 'je-as-poster';
            poster.alt = '';
            poster.loading = 'lazy';
            poster.src = ApiClient.getImageUrl(posterId, { type: 'Primary', tag: posterTag, height: 120, quality: 80 });
            poster.addEventListener('error', () => { poster.replaceWith(placeholder()); });
            card.appendChild(poster);
        } else {
            card.appendChild(placeholder());
        }

        function placeholder() {
            const ph = document.createElement('div');
            ph.className = 'je-as-poster-placeholder';
            return ph;
        }

        // ── Main content column ──────────────────────────────────────────────
        const main = document.createElement('div');
        main.className = 'je-as-card-main';

        // Top row
        const top = document.createElement('div');
        top.className = 'je-as-card-top';

        const info = document.createElement('div');
        info.className = 'je-as-card-info';

        const titleEl = document.createElement('div');
        titleEl.className = 'je-as-card-title';

        // Make title clickable if we have an item ID
        if (item.Id && typeof ApiClient !== 'undefined') {
            const link = document.createElement('a');
            link.className = 'je-as-card-title-link';
            link.textContent = title;
            link.href = '#';
            link.addEventListener('click', (e) => {
                e.preventDefault();
                try {
                    if (typeof Emby !== 'undefined' && Emby.Page?.showItem) {
                        Emby.Page.showItem(item.Id);
                    } else {
                        window.location.hash = `#!/details?id=${item.Id}`;
                    }
                } catch (_) {
                    window.location.hash = `#!/details?id=${item.Id}`;
                }
            });
            titleEl.appendChild(link);
        } else {
            titleEl.textContent = title;
        }
        info.appendChild(titleEl);

        if (subtitle) {
            const subEl = document.createElement('div');
            subEl.className = 'je-as-card-subtitle';
            subEl.textContent = subtitle;
            info.appendChild(subEl);
        }

        const stateEl = document.createElement('span');
        stateEl.className = `je-as-state ${isPaused ? 'je-as-state-paused' : 'je-as-state-playing'}`;
        stateEl.textContent = isPaused
            ? (JE.t?.('downloads_status_paused') || 'Paused')
            : (JE.t?.('toast_playing') || 'Playing');

        top.appendChild(info);
        top.appendChild(stateEl);
        main.appendChild(top);

        // Progress row
        if (dur) {
            const progressRow = document.createElement('div');
            progressRow.className = 'je-as-progress-row';

            const bar = document.createElement('div');
            bar.className = 'je-as-progress-bar';
            const fill = document.createElement('div');
            fill.className = 'je-as-progress-fill';
            fill.style.width = `${pct}%`;
            bar.appendChild(fill);

            const timeEl = document.createElement('span');
            timeEl.className = 'je-as-progress-time';
            timeEl.textContent = `${ticksToTime(pos)} / ${ticksToTime(dur)}`;

            progressRow.appendChild(bar);
            progressRow.appendChild(timeEl);
            main.appendChild(progressRow);
        }

        // Badges
        const badgesRow = document.createElement('div');
        badgesRow.className = 'je-as-badges';
        buildBadgeElements(session).forEach(b => badgesRow.appendChild(b));
        main.appendChild(badgesRow);

        // User row
        const userRow = document.createElement('div');
        userRow.className = 'je-as-user';

        if (session.UserId && typeof ApiClient !== 'undefined') {
            const img = document.createElement('img');
            img.className = 'je-as-avatar';
            img.alt = '';
            img.src = ApiClient.getUrl(`Users/${session.UserId}/Images/Primary`) + '?height=20&quality=80';

            const fallback = document.createElement('span');
            fallback.className = 'material-icons';
            fallback.textContent = 'person';
            fallback.style.display = 'none';

            img.addEventListener('error', () => {
                img.style.display = 'none';
                fallback.style.display = 'inline';
            });

            userRow.appendChild(img);
            userRow.appendChild(fallback);
        } else {
            const icon = document.createElement('span');
            icon.className = 'material-icons';
            icon.textContent = 'person';
            userRow.appendChild(icon);
        }

        const clientParts = [session.UserName, session.Client, session.DeviceName].filter(Boolean);
        const userLabel = document.createElement('span');
        userLabel.textContent = clientParts.join(' \u00b7 ');
        userRow.appendChild(userLabel);

        // ApplicationVersion removed — not useful to display

        main.appendChild(userRow);

        // RemoteEndPoint — admin only
        if (isAdmin && session.RemoteEndPoint) {
            const ipRow = document.createElement('div');
            ipRow.className = 'je-as-user';
            const ipIcon = document.createElement('span');
            ipIcon.className = 'material-icons';
            ipIcon.textContent = 'router';
            const ipLabel = document.createElement('span');
            ipLabel.textContent = session.RemoteEndPoint;
            ipRow.appendChild(ipIcon);
            ipRow.appendChild(ipLabel);
            main.appendChild(ipRow);
        }

        card.appendChild(main);
        return card;
    };

    // ── Panel renderer ───────────────────────────────────────────────────────
    const renderPanel = (sessions) => {
        const panel = document.getElementById('je-active-streams-panel');
        if (!panel) return;

        const active = (sessions || []).filter(s => s.NowPlayingItem);

        const titleEl = panel.querySelector('.je-as-panel-title');
        if (titleEl) {
            if (active.length) {
                const tpl = JE.t?.('active_streams_count') || '{count} Active Stream|{count} Active Streams';
                const parts = tpl.split('|');
                const singular = parts[0] || '{count} Active Stream';
                const plural = parts[1] || parts[0] || '{count} Active Streams';
                titleEl.textContent = (active.length === 1 ? singular : plural).replace('{count}', active.length);
            } else {
                titleEl.textContent = JE.t?.('active_streams_none') || 'No Active Streams';
            }
        }

        const body = panel.querySelector('.je-as-panel-body');
        if (!body) return;

        while (body.firstChild) body.removeChild(body.firstChild);

        if (!active.length) {
            const empty = document.createElement('div');
            empty.className = 'je-as-panel-empty';
            empty.textContent = JE.t?.('active_streams_none') || 'No active streams';
            body.appendChild(empty);
        } else {
            active.forEach(session => body.appendChild(buildSessionCard(session)));
        }

        // Last-updated footer
        let footer = panel.querySelector('.je-as-panel-footer');
        if (!footer) {
            footer = document.createElement('div');
            footer.className = 'je-as-panel-footer';
            panel.appendChild(footer);
        }
        if (_lastUpdated) {
            footer.textContent = `Updated ${_lastUpdated.toLocaleTimeString()}`;
        }
    };

    // ── Counter updater ──────────────────────────────────────────────────────
    const updateCounter = async () => {
        const sessions = await fetchSessions();
        _lastUpdated = new Date();
        const btn = document.getElementById('je-active-streams');
        if (!btn) return;

        const iconEl = btn.querySelector('.je-as-icon');
        const supEl = btn.querySelector('.je-as-sup');
        btn.classList.remove('je-as-active', 'je-as-err');

        if (!sessions) {
            iconEl.textContent = 'person_off';
            supEl.textContent = '';
            btn.classList.add('je-as-err');
            btn.title = 'Failed to fetch sessions';
        } else {
            const active = sessions.filter(s => s.NowPlayingItem && !s.PlayState?.IsPaused);
            const count = active.length;
            iconEl.textContent = count === 1 ? 'person' : 'group';
            supEl.textContent = count ? `${count}` : '';
            if (count) btn.classList.add('je-as-active');
            btn.title = count ? `${count} active stream${count > 1 ? 's' : ''}` : 'No active streams';
        }

        if (_panelOpen) renderPanel(sessions);
    };

    // ── Polling ──────────────────────────────────────────────────────────────
    const startPolling = () => {
        if (_pollTimer) clearInterval(_pollTimer);
        updateCounter();
        _pollTimer = setInterval(updateCounter, POLL_INTERVAL);
    };

    const stopPolling = () => {
        if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    };

    // ── Panel ────────────────────────────────────────────────────────────────
    const togglePanel = () => {
        const panel = document.getElementById('je-active-streams-panel');
        if (!panel) return;
        _panelOpen = !_panelOpen;
        panel.classList.toggle('je-as-panel-open', _panelOpen);
        if (_panelOpen) updateCounter();
    };

    const injectPanel = () => {
        if (document.getElementById('je-active-streams-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'je-active-streams-panel';

        const header = document.createElement('div');
        header.className = 'je-as-panel-header';

        const titleEl = document.createElement('span');
        titleEl.className = 'je-as-panel-title';
        titleEl.textContent = 'Sessions';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'je-as-panel-close';
        closeBtn.setAttribute('aria-label', 'Close sessions panel');
        const closeIcon = document.createElement('span');
        closeIcon.className = 'material-icons';
        closeIcon.style.fontSize = '18px';
        closeIcon.textContent = 'close';
        closeBtn.appendChild(closeIcon);
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            _panelOpen = false;
            panel.classList.remove('je-as-panel-open');
        });

        header.appendChild(titleEl);
        header.appendChild(closeBtn);

        const body = document.createElement('div');
        body.className = 'je-as-panel-body';

        panel.appendChild(header);
        panel.appendChild(body);
        document.body.appendChild(panel);

        const skinHeader = document.querySelector('.skinHeader');
        if (skinHeader) {
            panel.style.top = (skinHeader.getBoundingClientRect().height + 2) + 'px';
        }

        _outsideClickListener = (e) => {
            const btn = document.getElementById('je-active-streams');
            if (_panelOpen && !panel.contains(e.target) && btn && !btn.contains(e.target)) {
                _panelOpen = false;
                panel.classList.remove('je-as-panel-open');
            }
        };
        document.addEventListener('click', _outsideClickListener);
    };

    // ── Header button ────────────────────────────────────────────────────────
    const tryInjectHeader = (attempts = 0) => {
        if (document.getElementById('je-active-streams')) return;
        if (attempts > 20) return;

        const headerRight = document.querySelector('.headerRight');
        if (!headerRight) {
            setTimeout(() => tryInjectHeader(attempts + 1), 500);
            return;
        }

        const btn = document.createElement('button');
        btn.id = 'je-active-streams';
        btn.type = 'button';
        btn.setAttribute('is', 'paper-icon-button-light');
        btn.className = 'headerButton headerButtonRight paper-icon-button-light';
        btn.title = 'No active streams';

        const icon = document.createElement('i');
        icon.className = 'material-icons je-as-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = 'person';

        const sup = document.createElement('span');
        sup.className = 'je-as-sup';
        sup.setAttribute('aria-hidden', 'true');

        btn.appendChild(icon);
        btn.appendChild(sup);
        btn.addEventListener('click', (e) => { e.stopPropagation(); togglePanel(); });

        headerRight.insertBefore(btn, headerRight.firstChild);
        injectPanel();
        applyThemeVars();
        startPolling();
    };

    // ── Observer ─────────────────────────────────────────────────────────────
    const startObserver = () => {
        if (_observer) return;
        const callback = () => {
            if (!document.getElementById('je-active-streams')) tryInjectHeader(0);
        };
        if (JE?.helpers?.onBodyMutation) {
            _observer = JE.helpers.onBodyMutation('active-streams', callback);
        } else {
            const mo = new MutationObserver(callback);
            mo.observe(document.body, { childList: true, subtree: true });
            _observer = { unsubscribe() { mo.disconnect(); } };
        }
    };

    const stopObserver = () => {
        if (_observer) { _observer.unsubscribe(); _observer = null; }
    };

    // ── Public API ───────────────────────────────────────────────────────────
    JE.activeStreams = {
        initialize() {
            if (!JE?.pluginConfig?.ActiveStreamsEnabled) {
                return;
            }
            if (!isVisible()) {
                console.log(`${LOG} Active Streams: skipping — not visible for this user.`);
                return;
            }
            console.log(`${LOG} Active Streams: initializing.`);
            injectStyles();
            startObserver();
            tryInjectHeader(0);
            _hashListener = () => applyThemeVars();
            window.addEventListener('hashchange', _hashListener);
        },

        destroy() {
            console.log(`${LOG} Active Streams: destroying.`);
            stopPolling();
            stopObserver();
            if (_hashListener) { window.removeEventListener('hashchange', _hashListener); _hashListener = null; }
            if (_outsideClickListener) { document.removeEventListener('click', _outsideClickListener); _outsideClickListener = null; }
            document.getElementById('je-active-streams')?.remove();
            document.getElementById('je-active-streams-panel')?.remove();
            document.getElementById('je-active-streams-styles')?.remove();
            _panelOpen = false;
        }
    };

})(window.JellyfinEnhanced);
