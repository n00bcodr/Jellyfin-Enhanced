import type { PageModules } from './modules';
import { asObject, asObjects, num, shown, text } from '../domain/config';
import { requestFailureWithBody } from '../domain/http';
import { asControl, asHtml, asInput, needControl, needHtml } from './dom';
import type { JsonObject } from '../domain/config';

/** Dependencies this module calls; members are resolved lazily, after every module exists. */
export type SpoilerDeps = Pick<PageModules, 'context'>;

export function createSpoiler(m: SpoilerDeps) {
    const { ApiClient, Dashboard, lifecycle } = m.context;

        // SpoilerAutoEnableLibraryIds as loaded, and whether the checkbox
        // list has been rendered from it yet. Until it has (VirtualFolders
        // still loading, or failed) a save round-trips the stored value
        // untouched instead of silently resetting it to "every library".
        var _spoilerAutoEnableLibrariesRaw = '';

        var _spoilerAutoEnableLibrariesRendered = false;

        /**
         * Renders the Spoiler Guard auto-enable library allow-list as one
         * checkbox per movie / TV / mixed library, pre-ticking the ids stored
         * in SpoilerAutoEnableLibraryIds (comma-separated). Ids that no longer
         * resolve to a library are flagged and dropped on the next save.
         * @param {string} selectedRaw - Stored comma-separated library ids
         */
        function renderSpoilerAutoEnableLibraries(selectedRaw: string) : void {
            const host = asHtml(document.getElementById('spoilerAutoEnableLibraryList'));
            if (!host) return;
            _spoilerAutoEnableLibrariesRaw = String(selectedRaw || '');
            _spoilerAutoEnableLibrariesRendered = false;
            var selected = _spoilerAutoEnableLibrariesRaw.split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
            ApiClient.getJSON(ApiClient.getUrl('Library/VirtualFolders')).then(function (folders) {
                host.innerHTML = '';
                var eligible = asObjects(folders).filter(function (f) {
                    var t = text(f.CollectionType).toLowerCase();
                    // Untyped ("mixed") libraries can hold both shows and movies.
                    return f.ItemId && (t === 'tvshows' || t === 'movies' || t === '');
                });
                var known: Record<string, boolean> = {};
                eligible.forEach(function (f) {
                    var id = String(f.ItemId).replace(/-/g, '').toLowerCase();
                    known[id] = true;
                    var wrap = document.createElement('div');
                    wrap.className = 'checkboxContainer';
                    var label = document.createElement('label');
                    var input = document.createElement('input');
                    input.type = 'checkbox';
                    input.className = 'spoilerAutoEnableLibrary jea-switch';
                    label.className = 'jea-toggle';
                    input.setAttribute('data-library-id', shown(f.ItemId));
                    input.checked = selected.indexOf(id) !== -1;
                    var span = document.createElement('span');
                    var type = text(f.CollectionType).toLowerCase();
                    span.textContent = f.Name + (type === 'tvshows' ? ' (TV shows)' : type === 'movies' ? ' (Movies)' : ' (Mixed)');
                    label.appendChild(input);
                    label.appendChild(span);
                    wrap.appendChild(label);
                    host.appendChild(wrap);
                });
                if (!eligible.length) {
                    host.innerHTML = '<div class="fieldDescription">No movie or TV libraries found.</div>';
                }
                // Ids saved earlier whose library has since been deleted: the
                // server can't match them (so, if they were the only ones,
                // nothing auto-enables) until the admin saves again.
                var stale = selected.filter(function (id) { return !known[id]; });
                if (stale.length) {
                    var note = document.createElement('div');
                    note.className = 'fieldDescription';
                    note.textContent = stale.length === 1
                        ? '1 previously selected library no longer exists and will be dropped when you save.'
                        : stale.length + ' previously selected libraries no longer exist and will be dropped when you save.';
                    host.appendChild(note);
                }
                _spoilerAutoEnableLibrariesRendered = true;
            }).catch(function () {
                host.innerHTML = '<div class="fieldDescription">Could not load the library list. Saving keeps the current selection.</div>';
            });
        }

        /**
         * Collects the ticked auto-enable libraries back into the stored
         * comma-separated form (dashless lowercase ids, matching Jellyfin's
         * VirtualFolders ItemId format). Empty string = every library. If the
         * list hasn't rendered, returns the stored value unchanged.
         * @returns {string}
         */
        function collectSpoilerAutoEnableLibraries() : string {
            if (!_spoilerAutoEnableLibrariesRendered) return _spoilerAutoEnableLibrariesRaw;
            var ids: string[] = [];
            document.querySelectorAll<HTMLInputElement>('#spoilerAutoEnableLibraryList input.spoilerAutoEnableLibrary').forEach(function (el) {
                if (el.checked) ids.push(String(el.getAttribute('data-library-id') || '').replace(/-/g, '').toLowerCase());
            });
            return ids.filter(Boolean).join(',');
        }

        /**
         * Plain-text summary of an "apply to existing titles" run from the
         * server (SpoilerExistingTitlesApplier.Summary, PascalCase like the
         * rest of Jellyfin's JSON).
         * @param {Object} s - Run summary
         * @returns {string}
         */
        function describeSpoilerApplyExistingRun(s: JsonObject): string {
            var armed = num(s.SeriesArmed) + num(s.MoviesArmed);
            var parts = [armed + ' Spoiler Guard entr' + (armed === 1 ? 'y' : 'ies') + ' added (' + (s.SeriesArmed || 0) + ' series, ' + (s.MoviesArmed || 0) + ' movies) for ' + (s.UsersAffected || 0) + ' user' + (s.UsersAffected === 1 ? '' : 's')];
            parts.push((s.AlreadyArmed || 0) + ' already guarded');
            parts.push((s.SkippedWatched || 0) + ' fully watched');
            if (s.SkipStarted) parts.push((s.SkippedStarted || 0) + ' started');
            var summary = parts.join(', ') + ' skipped.';
            if (s.UsersFailed) summary += ' ' + s.UsersFailed + ' user' + (s.UsersFailed === 1 ? '' : 's') + ' could not be updated (see the server log).';
            return summary;
        }

        /**
         * Joins plain-text lines into the HTML body Jellyfin's alert/confirm
         * dialogs render (they treat the message as sanitized HTML, so plain
         * newlines collapse). Each line is escaped; user names come from the server.
         * @param {string[]} lines - Plain-text lines ('' = blank line)
         * @returns {string}
         */
        function spoilerApplyExistingLinesHtml(lines: readonly string[]) : string {
            var div = document.createElement('div');
            return lines.map(function (line) {
                div.textContent = line;
                return div.innerHTML;
            }).join('<br>');
        }

        /**
         * Resolves to the `message` of a failed JellyfinEnhanced API call
         * (ApiClient rejects with the fetch Response), or null.
         * @param {*} err - Rejection value from ApiClient.getJSON / ajax
         * @returns {Promise<string|null>}
         */
        function spoilerApplyExistingErrorMessage(err: unknown): Promise<string | null> {
            return requestFailureWithBody(err).then(function (failure) { return text(failure.body?.message) || null; });
        }

        /**
         * Polls the apply-to-existing-titles status until the run started by
         * this page has finished, mirroring progress and then the result into
         * the status line under the button.
         * @param {number} completedRunsBefore - Server's finished-run counter just before this run started
         */
        function pollSpoilerApplyExisting(completedRunsBefore: number) : void {
            var statusEl = needHtml(document.getElementById('spoilerApplyExistingStatus'));
            var btn = needControl(document.getElementById('spoilerApplyExistingBtn'));
            var idleTicks = 0;
            var tick = function () {
                ApiClient.getJSON(ApiClient.getUrl('JellyfinEnhanced/spoiler-blur/apply-existing/status')).then(function (response) {
                    const st = asObject(response);
                    var finished = num(st.completedRuns) > completedRunsBefore && st.lastRun;
                    if (!finished) {
                        // Idle without a new result for a while: the task
                        // never ran (or the server restarted); stop polling.
                        idleTicks = st.state === 'Idle' ? idleTicks + 1 : 0;
                        if (idleTicks > 10) {
                            btn.disabled = false;
                            statusEl.textContent = 'The run did not report back; check Dashboard > Scheduled Tasks and the server log.';
                            return;
                        }
                        statusEl.textContent = 'Applying… ' + (typeof st.progress === 'number' ? Math.round(st.progress) + '%' : '');
                        lifecycle.timeout(tick, 1000);
                        return;
                    }
                    var last = asObject(st.lastRun);
                    btn.disabled = false;
                    if (last.Error) {
                        statusEl.textContent = 'Apply failed: ' + last.Error;
                    } else if (last.Cancelled) {
                        statusEl.textContent = 'Cancelled. Users processed before the cancel keep their new entries; run it again to finish (nothing is added twice).';
                    } else {
                        statusEl.textContent = 'Done in ' + (num(last.ElapsedMs) / 1000).toFixed(1) + ' s. ' + describeSpoilerApplyExistingRun(last);
                    }
                }).catch(function () {
                    btn.disabled = false;
                    statusEl.textContent = 'Lost track of the run; check Dashboard > Scheduled Tasks and the server log.';
                });
            };
            tick();
        }

    /** Runs this module's start-up work, in the page's original order. */
    function wire(): void {
        /**
         * "Apply to existing titles now…": dry-runs the saved auto-enable
         * scope, shows what would be armed, and on confirmation starts the
         * "Spoiler Guard: apply to existing titles" scheduled task.
         */
        (function wireSpoilerApplyExisting() {
            const btn = asControl(document.getElementById('spoilerApplyExistingBtn'));
            const statusEl = asHtml(document.getElementById('spoilerApplyExistingStatus'));
            if (!btn || !statusEl) return;
            btn.addEventListener('click', function () {
                if (asHtml(document.querySelector('.je-save-dock.je-dirty'))) {
                    Dashboard.alert({ title: 'Save first', message: 'This uses the saved auto-enable settings. Save your changes, then try again.' });
                    return;
                }
                var skipStarted = !!(asInput(document.getElementById('spoilerApplyExistingSkipStarted')) || {}).checked;
                btn.disabled = true;
                statusEl.textContent = 'Counting titles…';
                var previewUrl = ApiClient.getUrl('JellyfinEnhanced/spoiler-blur/apply-existing/preview', { skipStarted: skipStarted });
                ApiClient.getJSON(previewUrl).then(function (preview) {
                    const p = asObject(preview);
                    statusEl.textContent = '';
                    var armed = num(p.SeriesArmed) + num(p.MoviesArmed);
                    var scope = 'In the saved scope: ' + p.SeriesInScope + ' series and ' + p.MoviesInScope + ' movies.';
                    var skipped = 'Skipped: ' + (p.AlreadyArmed || 0) + ' already guarded, ' + (p.SkippedWatched || 0) + ' fully watched' + (p.SkipStarted ? ', ' + (p.SkippedStarted || 0) + ' started' : '') + '.'
                        + (p.UsersFailed ? ' ' + p.UsersFailed + ' user' + (p.UsersFailed === 1 ? '' : 's') + ' could not be read (see the server log).' : '');
                    if (armed === 0) {
                        btn.disabled = false;
                        Dashboard.alert({ title: 'Nothing to apply', message: spoilerApplyExistingLinesHtml([scope, '', 'Every user who can see them already has them guarded or has watched them.', skipped]) });
                        return;
                    }
                    var lines = [
                        scope,
                        '',
                        'This adds ' + armed + ' Spoiler Guard entr' + (armed === 1 ? 'y' : 'ies') + ', one per title per user (' + p.SeriesArmed + ' series, ' + p.MoviesArmed + ' movies), for ' + p.UsersAffected + ' user' + (p.UsersAffected === 1 ? '' : 's') + ':'
                    ];
                    asObjects(p.PerUser).forEach(function (u) {
                        var n = num(u.Series) + num(u.Movies);
                        if (n > 0) lines.push('• ' + u.UserName + (u.IsDisabled ? ' (disabled)' : '') + ': ' + n + ' (' + u.Series + ' series, ' + u.Movies + ' movies)');
                    });
                    lines.push('');
                    lines.push(skipped);
                    lines.push('Users can switch it off again per title. Running this again later re-arms titles they switched off, unless they have watched them.');
                    Dashboard.confirm(spoilerApplyExistingLinesHtml(lines), 'Apply Spoiler Guard to existing titles?', function (confirmed) {
                        if (!confirmed) { btn.disabled = false; return; }
                        statusEl.textContent = 'Starting…';
                        ApiClient.ajax({
                            type: 'POST',
                            url: ApiClient.getUrl('JellyfinEnhanced/spoiler-blur/apply-existing', { skipStarted: skipStarted }),
                            dataType: 'json'
                        }).then(function (res) {
                            const started = asObject(res).completedRuns;
                            if (typeof started === 'number') {
                                pollSpoilerApplyExisting(started);
                            } else {
                                btn.disabled = false;
                                statusEl.textContent = 'Started. Follow it in Dashboard > Scheduled Tasks.';
                            }
                        }).catch(function (err) {
                            spoilerApplyExistingErrorMessage(err).then(function (msg) {
                                btn.disabled = false;
                                statusEl.textContent = 'Could not start the run: ' + (msg || 'see Dashboard > Scheduled Tasks and the server log.');
                            });
                        });
                    });
                }).catch(function (err) {
                    spoilerApplyExistingErrorMessage(err).then(function (msg) {
                        btn.disabled = false;
                        statusEl.textContent = 'Could not count titles: ' + (msg || 'check the server log.');
                    });
                });
            });
        })();
    }

    return {
        wire,
        collectSpoilerAutoEnableLibraries,
        renderSpoilerAutoEnableLibraries,
    };
}
