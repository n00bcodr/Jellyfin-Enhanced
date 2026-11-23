import type { PageModules } from './modules';
import { asObject, num, shown, type JsonObject } from '../domain/config';
import type { ServiceCard, ServiceUsage } from './types';
import { requestFailure, requestFailureWithBody } from '../domain/http';
import { asControl, asHtml, asInput } from './dom';
import { MIRROR } from '../engine/schema';

/** Dependencies this module calls; members are resolved lazily, after every module exists. */
export type ServiceStatusDeps = Pick<PageModules, 'context' | 'connections' | 'tabs'>;

export function createServiceStatus(m: ServiceStatusDeps) {
    const { ApiClient } = m.context;

        /**
         * Reads `.value` from a selector, returning '' if the element is missing.
         * Logs once per missing selector so DOM/JS mismatches surface in devtools
         * instead of throwing silently through a querySelector chain.
         * @param {string} sel - CSS selector
         * @returns {string} Trimmed value, or '' if element not found
         */
        var _jeMissingSelectorsWarned = Object.create(null);

        function readFieldValue(sel: string) : string {
            var el = asControl(document.querySelector(sel));
            if (!el) {
                if (!_jeMissingSelectorsWarned[sel]) {
                    _jeMissingSelectorsWarned[sel] = true;
                    console.warn('[JE] status dashboard: selector "' + sel + '" not found');
                }
                return '';
            }
            return (el.value || '').trim();
        }

        /**
         * Merged Service Status renderer.
         *
         * Replaces the legacy status-card grid + Integration Health checklist
         * with a single card list that sources:
         *   - config state from the live form (key/URL/API-key presence, *arr
         *     instance counts, Seerr URL list),
         *   - test-result state from the connection-test cache (so a green
         *     "connected" or red "failed" card reflects the latest probe).
         *
         * Card states (drive the left-border accent and icon):
         *   - 'ok'      green    — configured; latest test passed (or no test
         *                           run yet but no negative signal)
         *   - 'warn'    amber    — configured partially (e.g. Seerr URL but no
         *                           API key) OR connection-test returned
         *                           amber (reachable but not healthy)
         *   - 'error'   red      — connection-test returned error
         *   - 'pending' grey dot — enabled + complete config, no cached result
         *   - 'off'     faded    — disabled / no config entered yet
         *
         * Each card is a <button> that jumps to the relevant settings tab.
         */
        // Remaining request budget per service, read from the server (MDBList account status, DoesTheDogDie rate-limit headers).
        var _jeUsage: Record<string, ServiceUsage | undefined> = {};
        var dddMeasured = false;

        var _jeUsageAt: Record<string, number | undefined> = {};

        function jeLoadServiceUsage(id: string) : void {
            var now = Date.now();
            const loadedAt = _jeUsageAt[id];
            if (loadedAt && now - loadedAt < 60000) return;
            _jeUsageAt[id] = now;
            var done = function(v: ServiceUsage): void { _jeUsage[id] = v; try { renderServiceStatusDashboard(); } catch (e) { /* dashboard not mounted */ } };
            if (id === 'mdblist') {
                ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('/JellyfinEnhanced/mdblist-ratings/account-status'), dataType: 'json' }).then(function(response) {
                    const st = asObject(response);
                    var secs = num(st.RateLimitResetUnixSeconds);
                    var hours = secs ? Math.max(0, Math.round((secs * 1000 - Date.now()) / 3600000)) : null;
                    done({ remaining: typeof st.RateLimitRemaining === 'number' ? st.RateLimitRemaining : null, limit: num(st.RateLimit) || null,
                           extra: (st.Plan ? shown(st.Plan) + ' plan' : '') + (hours != null ? ' · resets in ' + hours + 'h' : '') });
                }).catch(function(e) {
                    done({ error: requestFailure(e).status === 502 ? 'Could not reach MDBList (key may be invalid)' : 'Could not read MDBList usage' });
                });
            } else if (id === 'ddd') {
                var read = function(refresh: boolean): Promise<unknown> {
                    return ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('/JellyfinEnhanced/ddd/usage', refresh ? { refresh: true } : {}), dataType: 'json' });
                };
                read(false).then(function(u) {
                    // Unknown after a restart: spend one request to measure it, once per page.
                    if (u && asObject(u).RemainingMonth == null && !dddMeasured) { dddMeasured = true; return read(true); }
                    return u;
                }).then(function(response) {
                    const u = asObject(response);
                    done({ remaining: typeof u.RemainingMonth === 'number' ? u.RemainingMonth : null, limit: num(u.LimitMonth) || 5000 });
                }).catch(function() { done({ error: 'Could not read DoesTheDogDie usage' }); });
            }
        }

        // Maintainerr card (*arr tab, its linked copy under Services, and the Overview's Service Status): the server's
        // last read of the Leaving soon source and its Home Screen Sections row (GET admin/leaving-soon), and Refresh now
        // (POST admin/leaving-soon/refresh). Upstream 481a10ee keeps this as JEAdmin.maintainerr in sections.js.
        var MAINTAINERR_ROW: Readonly<Record<string, string>> = {
            registered: 'Home row: registered with Home Screen Sections.',
            'hss-missing': 'Home row: Home Screen Sections is not installed, so there is no row.',
            'ft-missing': 'Home row: registered, but File Transformation is not installed, so Home Screen Sections cannot draw it.',
            failed: 'Home row: registration failed (see the plugin log).',
            off: '',
            unknown: 'Home row: waiting for Home Screen Sections to load.'
        };
        var maintainerrBusy = false;
        /** The last answer, or { failed: true } when it could not be read; null before the first. */
        var maintainerrLast: JsonObject | null = null;

        function maintainerrWhen(ms: unknown): string {
            if (typeof ms !== 'number' || !Number.isFinite(ms)) return '\u2014';
            try { return new Date(ms).toLocaleString(); } catch (e) { return new Date(ms).toISOString(); }
        }

        function paintMaintainerr(s: JsonObject | null, failed: boolean): void {
            var state = asHtml(document.getElementById('maintainerrStatusLine'));
            var icon = asHtml(document.getElementById('maintainerrStatusIndicator'));
            var row = asHtml(document.getElementById('maintainerrRowLine'));
            var button = asControl(document.getElementById('maintainerrRefreshBtn'));
            if (!state) return;
            if (button) button.disabled = maintainerrBusy || !(s && s.Configured === true);
            var text: string, kind: string;
            if (failed || !s) { text = 'Status unavailable.'; kind = 'warn'; }
            else if (s.Configured !== true) { text = 'No source set. Turn on Maintainerr or Reclaimerr, enter its address and save.'; kind = 'off'; }
            else if (s.LastError) { text = 'Last read failed: ' + shown(s.LastError) + '.'; kind = 'error'; }
            else if (s.LastSuccess) { kind = 'ok'; text = num(s.Items) + ' item(s) leaving (' + num(s.Dated) + ' with a date). Last read ' + maintainerrWhen(s.LastSuccess) + ', next ' + maintainerrWhen(s.NextRefresh) + '.'; }
            else { text = 'Not read yet.'; kind = 'warn'; }
            state.textContent = text;
            if (icon) {
                icon.textContent = kind === 'ok' ? 'check_circle' : kind === 'error' ? 'error' : kind === 'off' ? 'remove_circle_outline' : 'info';
                icon.style.color = kind === 'ok' ? '#4caf50' : kind === 'error' ? '#f44336' : '';
            }
            if (row) row.textContent = s && s.Maintainerr === true && typeof s.HomeRow === 'string' ? (MAINTAINERR_ROW[s.HomeRow] ?? '') : '';
        }

        /** Read the state (or read Maintainerr again first), then repaint the card and the Overview's Service Status. */
        function loadMaintainerr(refresh: boolean): Promise<void> {
            if (maintainerrBusy) return Promise.resolve();
            maintainerrBusy = true;
            var pending = asHtml(document.getElementById('maintainerrStatusLine'));
            var reclaimerr = !!asInput(document.getElementById('ReclaimerrEnabled'))?.checked || (maintainerrLast !== null && maintainerrLast.Provider === 'reclaimerr');
            if (pending) pending.textContent = refresh ? 'Reading ' + (reclaimerr ? 'Reclaimerr' : 'Maintainerr') + '\u2026' : 'Loading status\u2026';
            var button = asControl(document.getElementById('maintainerrRefreshBtn'));
            if (button) button.disabled = true;
            var url = ApiClient.getUrl('JellyfinEnhanced/admin/leaving-soon' + (refresh ? '/refresh' : ''));
            return ApiClient.ajax({ type: refresh ? 'POST' : 'GET', url: url, dataType: 'json' }).then(function(answer) {
                return { status: asObject(answer), failed: false };
            }, function() {
                return { status: null, failed: true };
            }).then(function(result) {
                maintainerrBusy = false;
                if (m.context.lifecycle.disposed) return;
                maintainerrLast = result.failed ? { failed: true } : result.status;
                paintMaintainerr(result.status, result.failed);
                try { renderServiceStatusDashboard(); } catch (e) { /* dashboard not mounted */ }
            });
        }

        function renderServiceStatusDashboard() : void {
            const root = asHtml(document.getElementById('je-service-dashboard'));
            if (!root) return;

            var cards: ServiceCard[] = [];
            function pushCard(opts: ServiceCard): void { cards.push(opts); }

            // TMDB — no dedicated test endpoint; presence-based state only.
            var tmdbKey = readFieldValue('#TMDB_API_KEY');
            pushCard({
                id: 'tmdb',
                name: 'TMDB',
                tab: 'services',
                scrollTo: '#TMDB_API_KEY',
                state: tmdbKey ? 'ok' : 'off',
                detail: tmdbKey ? 'API key set' : 'No API key',
                icon: 'vpn_key'
            });

            // Seerr
            var seerrEnabled = asInput(document.getElementById('jellyseerrEnabled'));
            var seerrUrls = readFieldValue('#jellyseerrUrls');
            var seerrKey = readFieldValue('#JellyseerrApiKey');
            if (seerrEnabled && seerrEnabled.checked) {
                if (seerrUrls && seerrKey) {
                    var r = m.connections.checklistRowState('seerr', 'Configured, not yet verified');
                    var urlCount = seerrUrls.split(/\r?\n/).filter(function(u) { return u.trim(); }).length;
                    pushCard({
                        id: 'seerr', name: 'Seerr', tab: 'seerr', icon: 'bolt',
                        state: r.state === 'amber' ? 'warn' : r.state === 'pending' ? 'pending' : r.state,
                        detail: r.detail + (urlCount > 1 ? ' · ' + urlCount + ' URLs' : '')
                    });
                } else {
                    pushCard({
                        id: 'seerr', name: 'Seerr', tab: 'seerr', icon: 'bolt', state: 'warn',
                        detail: !seerrUrls && !seerrKey ? 'Enabled but URL and API key missing'
                            : !seerrUrls ? 'URL missing' : 'API key missing'
                    });
                }
            } else if (seerrUrls || seerrKey) {
                pushCard({
                    id: 'seerr', name: 'Seerr', tab: 'seerr', icon: 'bolt', state: 'off',
                    detail: 'Configured but integration disabled'
                });
            }

            // Sonarr / Radarr — one card per instance, reusing test-cache keys
            ['sonarr', 'radarr'].forEach(function(type) {
                var list = asHtml(document.getElementById(type + 'InstancesList'));
                if (!list) return;
                var arrCards = list.querySelectorAll<HTMLElement>('.arr-instance-card');
                arrCards.forEach(function(card) {
                    var urlEl = asControl(card.querySelector('.arr-instance-url'));
                    var keyEl = asControl(card.querySelector('.arr-instance-apikey'));
                    var nameEl = asControl(card.querySelector('.arr-instance-name'));
                    if (!urlEl || !keyEl) return;
                    var urlVal = (urlEl.value || '').trim();
                    var keyVal = (keyEl.value || '').trim();
                    if (!urlVal && !keyVal) return;
                    var nameVal = (nameEl && nameEl.value ? nameEl.value.trim() : '')
                                  || (type === 'sonarr' ? 'Sonarr' : 'Radarr');
                    var cacheKey = type + ':' + m.connections._jeNormalizeArrUrl(urlVal);
                    var icon = type === 'sonarr' ? 'tv' : 'movie';

                    // Disabled instances (Enabled checkbox unchecked) render as
                    // a grayed-out "Disabled" card regardless of test-cache
                    // state — a stale red/green badge on a disabled entry is
                    // misleading because the instance isn't being used.
                    var enCb = asInput(card.querySelector('.arr-instance-enabled'));
                    var isDisabled = enCb && !enCb.checked;
                    if (isDisabled) {
                        pushCard({
                            id: cacheKey, name: nameVal, tab: 'arr', icon: icon, state: 'off',
                            detail: 'Disabled'
                        });
                        return;
                    }

                    if (!urlVal || !keyVal) {
                        pushCard({
                            id: cacheKey, name: nameVal, tab: 'arr', icon: icon, state: 'warn',
                            detail: !urlVal ? 'URL missing' : 'API key missing'
                        });
                        return;
                    }
                    var r = m.connections.checklistRowState(cacheKey, 'Configured, not yet verified');
                    pushCard({
                        id: cacheKey, name: nameVal, tab: 'arr', icon: icon,
                        state: r.state === 'amber' ? 'warn' : r.state === 'pending' ? 'pending' : r.state,
                        detail: r.detail
                    });
                });
            });

            // Bazarr — no test endpoint; URL presence is the best signal
            var bazarrUrl = readFieldValue('#bazarrUrl');
            var bazarrMappings = readFieldValue('#bazarrUrlMappings');
            if (bazarrUrl || bazarrMappings) {
                pushCard({
                    id: 'bazarr', name: 'Bazarr', tab: 'arr', icon: 'subtitles',
                    state: bazarrUrl ? 'ok' : 'warn',
                    detail: bazarrUrl ? 'URL configured' : 'Only URL mappings set'
                });
            }

            // Shoko — no test endpoint; URL + API key presence is the best signal
            var shokoUrl = readFieldValue('#shokoUrl');
            var shokoApiKey = readFieldValue('#shokoApiKey');
            if (shokoUrl || shokoApiKey) {
                pushCard({
                    id: 'shoko', name: 'Shoko', tab: 'arr', icon: 'live_tv',
                    state: (shokoUrl && shokoApiKey) ? 'ok' : 'warn',
                    detail: (shokoUrl && shokoApiKey) ? 'URL and API key configured' : (!shokoUrl ? 'URL missing' : 'API key missing')
                });
            }

            // Maintainerr: always listed. With an address, the server's last read of it (admin/leaving-soon) is the state.
            // The card follows the removal tool that is on (Reclaimerr or Maintainerr); neither on is "not set up".
            var reclaimerrOn = !!asInput(document.querySelector('#ReclaimerrEnabled'))?.checked;
            var maintainerrOn = !reclaimerrOn && !!asInput(document.querySelector('#LeavingSoonMaintainerrEnabled'))?.checked;
            var maintainerrUrl = reclaimerrOn ? readFieldValue('#ReclaimerrUrl') : (maintainerrOn ? readFieldValue('#LeavingSoonMaintainerrUrl') : '');
            var maintainerrCard: ServiceCard = { id: 'maintainerr', name: reclaimerrOn ? 'Reclaimerr' : 'Maintainerr', tab: 'arr', icon: 'auto_delete', scrollTo: reclaimerrOn ? '#ReclaimerrUrl' : '#LeavingSoonMaintainerrUrl', state: 'off', detail: '' };
            if (!maintainerrUrl) {
                maintainerrCard.detail = 'Not set up';
            } else {
                var ms = maintainerrLast;
                if (!ms) {
                    maintainerrCard.state = 'pending';
                    maintainerrCard.detail = 'Checking...';
                    void loadMaintainerr(false);
                } else if (ms.failed === true || ms.Maintainerr !== true) {
                    maintainerrCard.state = 'warn';
                    maintainerrCard.detail = ms.failed === true ? 'Status unavailable' : 'Address not saved yet';
                } else if (ms.LastError) {
                    maintainerrCard.state = 'error';
                    maintainerrCard.detail = 'Last read failed: ' + shown(ms.LastError);
                } else if (ms.LastSuccess) {
                    maintainerrCard.state = 'ok';
                    maintainerrCard.detail = num(ms.Items) + ' item(s) leaving';
                } else {
                    maintainerrCard.state = 'pending';
                    maintainerrCard.detail = 'Configured, not yet read';
                }
            }
            pushCard(maintainerrCard);

            // MDBList and DoesTheDogDie: always listed, with the remaining request budget once it has been read.
            [
                { id: 'mdblist', name: 'MDBList', icon: 'star_rate', on: '#mdblistRatingsEnabled', key: '#mdblistApiKey', period: 'today' },
                { id: 'ddd', name: 'DoesTheDogDie', icon: 'pets', on: '#doesTheDogDieEnabled', key: '#doesTheDogDieApiKey', period: 'this month' }
            ].forEach(function(s) {
                var enabled = !!(asInput(document.querySelector(s.on)) || {}).checked;
                var hasKey = !!readFieldValue(s.key);
                if (!hasKey && !enabled) {
                    pushCard({ id: s.id, name: s.name, tab: 'services', icon: s.icon, state: 'off', detail: 'Not set up' });
                    return;
                }
                if (!hasKey) {
                    pushCard({ id: s.id, name: s.name, tab: 'services', icon: s.icon, state: 'warn', detail: 'Enabled but API key missing' });
                    return;
                }
                jeLoadServiceUsage(s.id);
                var u = _jeUsage[s.id];
                var card: ServiceCard = { id: s.id, name: s.name, tab: 'services', icon: s.icon, scrollTo: s.key, state: 'off', detail: '' };
                if (!u) {
                    card.state = enabled ? 'pending' : 'off';
                    card.detail = enabled ? 'Checking usage...' : 'Disabled';
                } else if (u.error) {
                    card.state = 'error';
                    card.detail = u.error;
                } else if (u.remaining == null) {
                    card.state = enabled ? 'ok' : 'off';
                    card.detail = (enabled ? 'Key set' : 'Disabled') + ' · usage not measured yet';
                } else {
                    var ratio = u.limit ? u.remaining / u.limit : null;
                    card.state = !enabled ? 'off' : (ratio != null && ratio < 0.1 ? 'warn' : 'ok');
                    card.ratio = ratio;
                    card.detail = u.remaining.toLocaleString() + (u.limit ? ' / ' + u.limit.toLocaleString() : '') + ' left ' + s.period + (u.extra ? ' · ' + u.extra : '') + (enabled ? '' : ' · disabled');
                }
                pushCard(card);
            });

            // Services that only need a key or a toggle: state comes from the form, no network call.
            [
                { id: 'anilist', name: 'AniList', icon: 'reviews', on: '#showAnilistReviews', tab: 'services', okMsg: 'Reviews enabled, no key needed' },
                { id: 'translate', name: 'Review translation', icon: 'translate', on: '#reviewTranslationEnabled', key: '#reviewTranslationUrl', tab: 'elsewhere', keyMsg: 'Server URL missing', okMsg: 'Server URL set' }
            ].forEach(function(s) {
                var onEl = asInput(document.querySelector(s.on));
                if (!onEl || !onEl.checked) return;
                var hasKey = s.key ? !!readFieldValue(s.key) : true;
                pushCard({
                    id: s.id, name: s.name, tab: s.tab, icon: s.icon,
                    state: hasKey ? 'ok' : 'warn',
                    detail: hasKey ? (s.okMsg || 'API key set') : s.keyMsg ?? ''
                });
            });

            root.textContent = '';
            if (cards.length === 0) {
                var empty = document.createElement('div');
                empty.className = 'je-checklist-empty';
                empty.textContent = 'Configure TMDB, Seerr, or an *arr instance to see its status here.';
                root.appendChild(empty);
                return;
            }

            // Order: warn/error first, then pending, then ok, then off (faded)
            var ord: Readonly<Record<string, number>> = { error: 0, warn: 1, pending: 2, ok: 3, off: 4 };
            cards.sort(function(a, b) { return (ord[a.state] ?? 99) - (ord[b.state] ?? 99); });

            cards.forEach(function(c) {
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'je-service-card je-state-' + c.state;
                btn.setAttribute('data-target', c.tab);
                btn.setAttribute('data-status-id', c.id);
                var iconEl = document.createElement('i');
                iconEl.className = 'material-icons je-service-icon';
                iconEl.setAttribute('aria-hidden', 'true');
                iconEl.textContent = c.state === 'ok'      ? 'check_circle'
                                   : c.state === 'warn'    ? 'warning'
                                   : c.state === 'error'   ? 'error'
                                   : c.state === 'pending' ? 'hourglass_empty'
                                   : (c.icon || 'radio_button_unchecked');
                btn.appendChild(iconEl);
                var body = document.createElement('div');
                body.className = 'je-service-body';
                var nameEl = document.createElement('div');
                nameEl.className = 'je-service-name';
                nameEl.textContent = c.name;
                body.appendChild(nameEl);
                var detail = document.createElement('div');
                detail.className = 'je-service-detail';
                detail.textContent = c.detail;
                body.appendChild(detail);
                if (c.ratio != null) {
                    var bar = document.createElement('div');
                    bar.className = 'je-service-bar';
                    var fill = document.createElement('span');
                    fill.style.width = Math.max(2, Math.min(100, Math.round(c.ratio * 100))) + '%';
                    bar.appendChild(fill);
                    body.appendChild(bar);
                }
                btn.appendChild(body);
                btn.addEventListener('click', function() {
                    m.tabs.jeJumpToTab(c.tab, c.scrollTo);
                });
                root.appendChild(btn);
            });
        }

        // Back-compat: older code paths still call these by name. Delegate both
        // to the unified renderer instead of maintaining dead duplicates.
        function updateStatusDashboard() : void { renderServiceStatusDashboard(); }

    /**
     * Import Jellyfin users (upstream da3d9ee9): Reclaimerr's own import through the token, so every Jellyfin user without a
     * Reclaimerr account gets one, linked to them, with the ticked permissions and pages. Nothing is stored here: Reclaimerr
     * keeps the link.
     */
    function wireImportUsers(): void {
        var button = asControl(document.getElementById('reclaimerrImportUsersBtn'));
        if (!button) return;
        var target = button;
        var boxesIn = function(id: string): HTMLInputElement[] {
            return Array.from(document.querySelectorAll('#' + id + ' input')).map(asInput).filter(function(box): box is HTMLInputElement { return box !== null; });
        };
        // Set in script rather than markup so nothing else on the page can change the starting ticks.
        var start: Record<string, readonly string[]> = { reclaimerrNewPerms: ['request'], reclaimerrNewPages: ['requests', 'candidates', 'settings'] };
        Object.keys(start).forEach(function(id) {
            var on = start[id] ?? [];
            // The Services tab's copy of this card has its own boxes (no ids, so the page's mirroring passes them by): a tick
            // in either copy is made in the other, and the button, whichever copy it is clicked in, sends what both show.
            var copies = [id, id + MIRROR];
            copies.forEach(function(own, index) {
                boxesIn(own).forEach(function(box) { box.checked = on.includes(box.value); });
                var other = copies[1 - index] ?? '';
                document.getElementById(own)?.addEventListener('change', function(e) {
                    var changed = asInput(e.target instanceof Element ? e.target : null);
                    if (!changed) return;
                    var value = changed.value, checked = changed.checked;
                    boxesIn(other).forEach(function(twin) { if (twin.value === value) twin.checked = checked; });
                }, { signal: m.context.lifecycle.signal });
            });
        });
        var ticked = function(id: string): string[] {
            return boxesIn(id).filter(function(box) { return box.checked; }).map(function(box) { return box.value; });
        };
        var names = function(value: unknown): string[] {
            return Array.isArray(value) ? value.filter(function(s): s is string { return typeof s === 'string'; }) : [];
        };
        target.addEventListener('click', function() {
            var line = asHtml(document.getElementById('reclaimerrImportUsersLine'));
            var pages = ticked('reclaimerrNewPages');
            if (!pages.length) { if (line) line.textContent = 'Pick at least one page.'; return; }
            if (!window.confirm('Create and link a Reclaimerr account for every Jellyfin user who has none?')) return;
            target.disabled = true;
            if (line) line.textContent = 'Importing\u2026';
            ApiClient.ajax({ type: 'POST', url: ApiClient.getUrl('JellyfinEnhanced/reclaimerr/import-users'), data: JSON.stringify({ permissions: ticked('reclaimerrNewPerms'), pages: pages }), contentType: 'application/json', dataType: 'json' }).then(function(answer) {
                if (m.context.lifecycle.disposed) return;
                var result = asObject(answer);
                var review = names(result.needsReview), skipped = names(result.skipped);
                var parts = ['Created ' + names(result.created).length, 'already linked ' + (typeof result.alreadyLinked === 'number' ? result.alreadyLinked : 0)];
                if (review.length) parts.push('to confirm in Reclaimerr: ' + review.join(', '));
                if (skipped.length) parts.push('not imported: ' + skipped.join('; '));
                if (line) line.textContent = parts.join(', ') + '.';
            }, function(err: unknown) {
                return requestFailureWithBody(err).then(function(failure) {
                    if (m.context.lifecycle.disposed || !line) return;
                    var reason = typeof failure.body?.error === 'string' ? failure.body.error : '';
                    line.textContent = 'Could not import the users: ' + (reason || failure.status || failure.message || 'request failed');
                });
            }).then(function() { target.disabled = false; });
        }, { signal: m.context.lifecycle.signal });
    }

    /**
     * Reclaimerr user audit (upstream da3d9ee9): the token's missing scopes and setup problems first, then a card for each user
     * with issues (in the Seerr permission audit's style), the users the sign-in check never reached (in grey: their link is
     * fine, only their Request permission is unknown), the users with none folded away, and the administrators apart (in grey
     * too: they are not checked, so they are not counted as OK; upstream 7762f8e1). Built with textContent only: names and
     * reasons come from Jellyfin and Reclaimerr. Drawn into the card and into its Services-tab copy alike: the copy only follows
     * a box that holds plain text, and this one holds elements.
     */
    function wireUserAudit(): void {
        var button = asControl(document.getElementById('reclaimerrAuditBtn'));
        if (!button) return;
        var target = button;
        var node = function(tag: string, cls: string | null, text?: string): HTMLElement {
            var n = document.createElement(tag);
            if (cls) n.className = cls;
            if (text != null) n.textContent = text;
            return n;
        };
        var icon = function(name: string): HTMLElement { var i = node('i', 'material-icons', name); i.setAttribute('aria-hidden', 'true'); return i; };
        var chip = function(kind: string, iconName: string, text: string): HTMLElement {
            var c = node('span', 'je-audit-chip je-audit-chip-' + kind);
            c.append(icon(iconName), document.createTextNode(text));
            return c;
        };
        var boxes = function(): HTMLElement[] {
            return [asHtml(document.getElementById('reclaimerrAuditResult')), asHtml(document.getElementById('reclaimerrAuditResult' + MIRROR))].filter(function(b): b is HTMLElement { return b !== null; });
        };
        var text = function(value: unknown): string { return typeof value === 'string' ? value : ''; };
        var issuesOf = function(u: JsonObject): string[] {
            return Array.isArray(u.issues) ? u.issues.filter(function(i): i is string { return typeof i === 'string'; }) : [];
        };
        var label = function(u: JsonObject): string { return text(u.jellyfinUsername) + (text(u.reclaimerrUsername) ? ' \u2192 ' + text(u.reclaimerrUsername) : ''); };
        var folded = function(title: string, list: JsonObject[], kind?: string): HTMLElement {
            var details = node('details', 'je-audit-ok-section');
            details.append(node('summary', null, title));
            var ul = node('ul', 'je-audit-ok-names' + (kind ? ' je-audit-' + kind + '-names' : ''));
            list.forEach(function(u) { ul.append(node('li', null, label(u))); });
            details.append(ul);
            return details;
        };
        function paint(out: HTMLElement, data: JsonObject): void {
            var users = Array.isArray(data.users) ? data.users.map(asObject) : [];
            var setup = issuesOf(data);
            var version = text(data.version);
            var flagged = users.filter(function(u) { return issuesOf(u).length > 0; });
            var unchecked = users.filter(function(u) { return !issuesOf(u).length && u.checked === false; });
            var fine = users.filter(function(u) { return !issuesOf(u).length && u.checked !== false; });
            // Administrators are not checked (they mark with the API token): neither a problem nor counted with the users who passed.
            var admins = fine.filter(function(u) { return u.admin === true; });
            var ok = fine.filter(function(u) { return u.admin !== true; });
            var clean = !setup.length && !flagged.length && !unchecked.length;
            var summary = node('div', 'je-audit-summary');
            summary.append(node('div', 'je-audit-summary-title', clean
                ? (admins.length && !ok.length ? 'Nothing to check: all ' + admins.length + ' user(s) are administrators.'
                    : 'All ' + ok.length + ' user(s) are set up' + (admins.length ? '; ' + admins.length + ' administrator(s) not checked' : '') + '.')
                    + (version ? ' Reclaimerr ' + version + '.' : '')
                : 'Audit complete' + (version ? ' (Reclaimerr ' + version + ')' : '') + ', review the items below.'));
            if (!clean) {
                var chips = node('div', 'je-audit-summary-chips');
                if (setup.length) chips.append(chip('warn', 'settings', setup.length + ' setup'));
                if (flagged.length) chips.append(chip('warn', 'warning', flagged.length + ' with issues'));
                if (unchecked.length) chips.append(chip('unlinked', 'help', unchecked.length + ' not checked'));
                if (ok.length) chips.append(chip('ok', 'check_circle', ok.length + ' OK'));
                if (admins.length) chips.append(chip('unlinked', 'admin_panel_settings', admins.length + ' administrator(s)'));
                summary.append(chips);
            }
            out.append(summary);
            var cards = node('div', 'je-audit-cards');
            if (setup.length) {
                var card = node('div', 'je-audit-card je-audit-card-warn');
                var head = node('div', 'je-audit-card-header');
                var who = node('span', 'je-audit-card-user');
                who.append(icon('settings'), document.createTextNode('Setup'));
                head.append(who);
                var list = node('ul', 'je-audit-card-issues');
                setup.forEach(function(issue) { list.append(node('li', null, issue)); });
                card.append(head, list);
                cards.append(card);
            }
            flagged.forEach(function(u) {
                var linked = u.linked === true;
                var userCard = node('div', 'je-audit-card ' + (linked ? 'je-audit-card-warn' : 'je-audit-card-unlinked'));
                var userHead = node('div', 'je-audit-card-header');
                var name = node('span', 'je-audit-card-user');
                name.append(icon(linked ? 'person' : 'person_off'), document.createTextNode(label(u)));
                userHead.append(name, linked ? chip('warn', 'warning', 'Needs attention') : chip('unlinked', 'link_off', 'Not linked'));
                var userIssues = node('ul', 'je-audit-card-issues');
                issuesOf(u).forEach(function(issue) { userIssues.append(node('li', null, issue)); });
                userCard.append(userHead, userIssues);
                cards.append(userCard);
            });
            if (cards.childNodes.length) out.append(cards);
            // Not reached by the sign-in check (see Setup): linked to one active account, but whether they may request is unknown.
            if (unchecked.length) out.append(folded('Show ' + unchecked.length + ' linked user(s) whose Request permission was not checked (see Setup)', unchecked, 'unchecked'));
            if (ok.length && !clean) out.append(folded('Show ' + ok.length + ' user(s) with no issues', ok));
            if (admins.length && !clean) out.append(folded('Show ' + admins.length + ' administrator(s), not checked: they mark with the API token', admins, 'unchecked'));
        }
        target.addEventListener('click', function() {
            if (!boxes().length) return;
            target.disabled = true;
            target.textContent = 'Running\u2026';
            boxes().forEach(function(out) { out.style.display = 'none'; out.textContent = ''; });
            ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('JellyfinEnhanced/reclaimerr/user-audit'), dataType: 'json' }).then(function(answer) {
                return { data: asObject(answer), failure: '' };
            }, function(err: unknown) {
                return requestFailureWithBody(err).then(function(failure) {
                    var reason = typeof failure.body?.error === 'string' ? failure.body.error : '';
                    return { data: null, failure: 'Audit failed: ' + (reason || failure.status || failure.message || 'request failed') };
                });
            }).then(function(result) {
                if (m.context.lifecycle.disposed) return;
                boxes().forEach(function(out) {
                    out.textContent = '';
                    if (result.data) paint(out, result.data); else out.append(node('div', 'je-audit-error', result.failure));
                    out.style.display = 'block';
                });
                target.disabled = false;
                target.textContent = 'Run Audit';
            });
        }, { signal: m.context.lifecycle.signal });
    }

    /** Runs this module's start-up work, in the page's original order. */
    function wire(): void {
        // Maintainerr and Reclaimerr are one choice: switching either on switches the other off (upstream da0ea773).
        document.addEventListener('change', function(e) {
            var target = asInput(e.target instanceof Element ? e.target : null);
            if (!target || !target.checked || (target.id !== 'LeavingSoonMaintainerrEnabled' && target.id !== 'ReclaimerrEnabled')) return;
            var other = asInput(document.getElementById(target.id === 'ReclaimerrEnabled' ? 'LeavingSoonMaintainerrEnabled' : 'ReclaimerrEnabled'));
            if (other && other.checked) { other.checked = false; other.dispatchEvent(new Event('change', { bubbles: true })); }
        }, { signal: m.context.lifecycle.signal });
        wireImportUsers();
        wireUserAudit();
        // The Maintainerr card: Refresh now, and a fresh read whenever the Services tab (its linked copy) is opened,
        // since the server's answer changes while the page is open (schedule, other administrators).
        var refreshButton = asControl(document.getElementById('maintainerrRefreshBtn'));
        if (refreshButton) {
            refreshButton.addEventListener('click', function() { void loadMaintainerr(true); }, { signal: m.context.lifecycle.signal });
            document.addEventListener('click', function(e) {
                var target = e.target instanceof Element ? e.target : null;
                if (target && target.closest('.jellyfin-tab-button[data-tab="services"]')) m.context.lifecycle.timeout(function() { void loadMaintainerr(false); }, 0);
            }, { signal: m.context.lifecycle.signal });
            m.context.lifecycle.timeout(function() { void loadMaintainerr(false); }, 0);
        }
    }

    return {
        wire,
        renderServiceStatusDashboard,
        updateStatusDashboard,
        loadMaintainerr,
    };
}
