using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr
{
    /// <summary>
    /// The store's live-update surface (Requests &amp; downloads, phase 1): change notifications for
    /// the change feed, in-place library patches from SignalR, refreshes triggered by live hints
    /// (SignalR messages, webhooks), targeted re-reads of single titles, and "someone is watching"
    /// marks from long-polling browsers. All arr calls made here run in the background (never on
    /// a request's counter).
    /// </summary>
    public sealed partial class ArrStateStore
    {
        /// <summary>Most titles re-read one by one per call; more than that reads the whole library.</summary>
        public const int MaxTitleRereads = 50;

        private long _titleStamp;

        /// <summary>
        /// Raised after a snapshot changed (a refresh that succeeded, or a live patch), on the thread
        /// that changed it. Handlers must be quick and must not throw.
        /// </summary>
        public event Action<ArrSnapshotChange>? SnapshotChanged;

        /// <summary>The library index in memory for an instance (no read is started, nothing is marked as read).</summary>
        public ArrLibrarySnapshot? PeekLibrary(string instanceId)
            => _states.TryGetValue(instanceId, out var state) ? state.Library.Peek().Value : null;

        /// <summary>
        /// The library index in memory for an instance and the error of its latest read when that
        /// failed after the index was loaded (no read is started).
        /// </summary>
        public (ArrLibrarySnapshot? Value, ArrError? Error) PeekLibraryState(string instanceId)
        {
            if (!_states.TryGetValue(instanceId, out var state)) return (null, null);
            var peek = state.Library.Peek();
            return (peek.Value, peek.Error);
        }

        /// <summary>The queue in memory for an instance (no read is started).</summary>
        public ArrQueueSnapshot? PeekQueue(string instanceId)
            => _states.TryGetValue(instanceId, out var state) ? state.Queue.Peek().Value : null;

        /// <summary>The recent history in memory for an instance (no read is started).</summary>
        public ArrHistorySnapshot? PeekHistory(string instanceId)
            => _states.TryGetValue(instanceId, out var state) ? state.History.Peek().Value : null;

        /// <summary>The system facts (health, disk, root folders, tasks) in memory for an instance (no read is started).</summary>
        public ArrSystemSnapshot? PeekSystem(string instanceId)
            => _states.TryGetValue(instanceId, out var state) ? state.System.Peek().Value : null;

        /// <summary>
        /// Adds, replaces (by arr id) or removes titles in the in-memory library index, when one is
        /// loaded. A refresh running at the same time keeps the patch, and a single-title re-read
        /// that started before it never undoes it. Returns true when something changed.
        /// </summary>
        public bool PatchLibrary(string instanceId, IReadOnlyCollection<ArrMovieEntry> movies, IReadOnlyCollection<ArrSeriesEntry> series, IReadOnlyCollection<int> removedIds)
        {
            if (!_states.TryGetValue(instanceId, out var state)) return false;
            var ids = new HashSet<int>(movies.Select(m => m.Id).Concat(series.Select(s => s.Id)).Concat(removedIds));
            (ArrLibrarySnapshot Before, ArrLibrarySnapshot After)? changed;
            lock (state.TitleGate)
            {
                StampTitles(state, ids);
                changed = state.Library.Patch(library => library.With(movies, series, removedIds));
            }
            if (changed is not { } c) return false;
            Raise(new ArrSnapshotChange(state.Client.Connection, ArrSnapshotKind.Library, c.Before, c.After, ids));
            // A series edit that changed its seasons (monitoring, episode counts) changed its
            // episodes too: re-read them when someone has.
            foreach (var s in series)
            {
                if (c.Before.SeriesById(s.Id) is { } old && c.After.SeriesById(s.Id) is { } now && !SameSeasons(old, now)) RefreshEpisodesAfterChange(state, s.Id);
            }
            return true;
        }

        private static bool SameSeasons(ArrSeriesEntry a, ArrSeriesEntry b)
            => a.Seasons.Count == b.Seasons.Count && a.Seasons.Zip(b.Seasons).All(p => ArrLibraryFacts.Same(p.First, p.Second));

        /// <summary>
        /// Re-reads a series' loaded episodes after the arr changed them. A read already running may
        /// have read the arr before the change, so it is waited for and another one runs after it.
        /// Runs in the background; does nothing when nobody has read the episodes.
        /// </summary>
        private void RefreshEpisodesAfterChange(InstanceState state, int seriesId)
        {
            if (state.ExistingEpisodes(seriesId) is not { HasValue: true, Retired: false } episodes) return;
            _ = StartBackground(async () =>
            {
                try
                {
                    if (episodes.Inflight is { } running)
                    {
                        try
                        {
                            await running.ConfigureAwait(false);
                        }
                        catch (Exception)
                        {
                            // its outcome is recorded by the slot
                        }
                    }
                    await episodes.StartRefresh(_backgroundCalls, _now, _shutdownToken).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    _logger?.Warning($"Arr state: re-reading episodes after a change failed ({ex.GetType().Name}).");
                }
                return true;
            }, false);
        }

        // Callers hold state.TitleGate.
        private void StampTitles(InstanceState state, IEnumerable<int> ids)
        {
            if (state.TitleStamps.Count > 100_000) state.TitleStamps.Clear();
            foreach (var id in ids) state.TitleStamps[id] = Interlocked.Increment(ref _titleStamp);
        }

        // Applies one title re-read, unless something newer about that title landed after the read
        // started: a live patch of it, or a whole-library read that started later. A library read
        // that started later and is still running replaces it when it lands (the patch is not kept
        // for it).
        private void ApplyTitleRead(InstanceState state, int id, long stampAtStart, DateTimeOffset startedAt, Func<ArrLibrarySnapshot, ArrLibrarySnapshot?> patch)
        {
            (ArrLibrarySnapshot Before, ArrLibrarySnapshot After)? changed;
            lock (state.TitleGate)
            {
                if (state.TitleStamps.TryGetValue(id, out var stamp) && stamp > stampAtStart) return;
                if (state.Library.LoadedAt > startedAt) return;
                StampTitles(state, new[] { id });
                changed = state.Library.Patch(patch, startedAt);
            }
            if (changed is { } c) Raise(new ArrSnapshotChange(state.Client.Connection, ArrSnapshotKind.Library, c.Before, c.After, new HashSet<int> { id }));
        }

        /// <summary>
        /// Refreshes one snapshot because a live hint says it changed. A refresh already running may
        /// have read the arr before the change, so it is waited for and another one runs after it.
        /// Snapshots nobody uses (not loaded and not read recently) are left alone, and so is one that
        /// is backing off after failures unless <paramref name="force"/> (a reconnect: the arr is back).
        /// Returns false when nothing was refreshed.
        /// </summary>
        public async Task<bool> RefreshForEventAsync(string instanceId, ArrSnapshotKind kind, bool force = false)
        {
            var connection = _factory.Registry.Get(instanceId);
            if (connection == null || StateFor(connection, out _) is not { } state) return false;
            var slot = state.Slot(kind);
            var now = _now();
            if (!slot.HasValue && now - slot.LastInterest > PolicyFor(kind, state, now).Interest) return false;
            if (!force && slot.InBackoff(now)) return false;
            if (slot.Inflight is { } running)
            {
                try
                {
                    await running.ConfigureAwait(false);
                }
                catch (Exception)
                {
                    // its outcome is recorded by the slot
                }
            }
            try
            {
                await slot.StartRefresh(_backgroundCalls, _now, _shutdownToken).ConfigureAwait(false);
            }
            catch (ObjectDisposedException)
            {
                return false;
            }
            return true;
        }

        /// <summary>
        /// Re-reads single titles (Radarr <c>movie/{id}</c>, Sonarr <c>series/{id}</c>) and patches the
        /// library index: a title the arr no longer has (404) is removed. More than
        /// <see cref="MaxTitleRereads"/> ids, or no index in memory, refreshes the whole library
        /// instead. Returns the number of titles re-read, including partial progress when the
        /// store shuts down. Explicit caller cancellation of an admitted reread still throws
        /// <see cref="OperationCanceledException"/>.
        /// </summary>
        public Task<int> RefreshTitlesAsync(string instanceId, IReadOnlyCollection<int> arrIds, CancellationToken cancellationToken)
        {
            // Never on a request's counter; owned through publication and observers at shutdown.
            return StartBackground(() => RefreshTitlesCoreAsync(instanceId, arrIds, cancellationToken), 0);
        }

        /// <summary>
        /// Marks the given snapshots of every usable instance as read now ("someone is watching"), so
        /// the reconciler keeps them current at the watched pace and loads the ones not loaded yet.
        /// </summary>
        public void KeepWarm(IEnumerable<ArrSnapshotKind> kinds)
        {
            var now = _now();
            var list = kinds.ToList();
            foreach (var kind in Enum.GetValues<ArrKind>())
            {
                foreach (var connection in Instances(kind))
                {
                    if (StateFor(connection, out _) is not { } state) continue;
                    foreach (var k in list) state.Slot(k).Touch(now);
                }
            }
        }

        private async Task<int> RefreshTitlesCoreAsync(string instanceId, IReadOnlyCollection<int> arrIds, CancellationToken cancellationToken)
        {
            ArrCallCounter.Current.Value = _backgroundCalls;
            cancellationToken.ThrowIfCancellationRequested();
            var connection = _factory.Registry.Get(instanceId);
            if (connection == null || StateFor(connection, out _) is not { } state) return 0;
            var ids = arrIds.Where(id => id > 0).Distinct().ToList();
            if (ids.Count == 0) return 0;
            var library = state.Library.Peek().Value;
            if (library == null) return 0;
            if (ids.Count > MaxTitleRereads)
            {
                await RefreshForEventAsync(instanceId, ArrSnapshotKind.Library).WaitAsync(cancellationToken).ConfigureAwait(false);
                return 0;
            }

            using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _shutdownToken);
            var read = 0;
            var first = true;
            try
            {
                foreach (var id in ids)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (_shutdownToken.IsCancellationRequested) break;
                    // Live updates switched off while the titles were being read: no more arr calls for them.
                    if (!first && !Live.ArrLiveFlags.Enabled(_config())) break;
                    first = false;
                    // Each title is applied as soon as it is read, unless a newer patch beat it.
                    var stamp = Interlocked.Read(ref _titleStamp);
                    var startedAt = _now();
                    var path = (connection.Kind == ArrKind.Radarr ? "movie/" : "series/") + id.ToString(System.Globalization.CultureInfo.InvariantCulture);
                    if (connection.Kind == ArrKind.Radarr)
                    {
                        var r = await state.Client.GetAsync<ArrWireMovie>(path, null, ArrCallClass.Read, linked.Token).ConfigureAwait(false);
                        if (r.Ok)
                        {
                            var wire = r.Value!;
                            ApplyTitleRead(state, id, stamp, startedAt, lib => lib.With(new[] { ArrStateLoaders.MergeMovie(lib.MovieById(id), wire) }, Array.Empty<ArrSeriesEntry>(), Array.Empty<int>()));
                        }
                        else if (r.Error!.Kind == ArrErrorKind.NotFound) ApplyTitleRead(state, id, stamp, startedAt, lib => lib.With(Array.Empty<ArrMovieEntry>(), Array.Empty<ArrSeriesEntry>(), new[] { id }));
                        else continue;
                    }
                    else
                    {
                        var r = await state.Client.GetAsync<ArrWireSeries>(path, null, ArrCallClass.Read, linked.Token).ConfigureAwait(false);
                        if (r.Ok)
                        {
                            var wire = r.Value!;
                            ApplyTitleRead(state, id, stamp, startedAt, lib => lib.With(Array.Empty<ArrMovieEntry>(), new[] { ArrStateLoaders.MergeSeries(lib.SeriesById(id), wire) }, Array.Empty<int>()));
                            // The series' files changed: its episodes (episode chips, season rows), when
                            // someone has read them, are read again too.
                            RefreshEpisodesAfterChange(state, id);
                        }
                        else if (r.Error!.Kind == ArrErrorKind.NotFound) ApplyTitleRead(state, id, stamp, startedAt, lib => lib.With(Array.Empty<ArrMovieEntry>(), Array.Empty<ArrSeriesEntry>(), new[] { id }));
                        else continue;
                    }
                    read++;
                }
            }
            catch (OperationCanceledException) when (_shutdownToken.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
            {
                // ArrClient sees the linked token as its caller's cancellation. Here a store stop
                // is a normal end to background rereading; keep completed patches and their count.
            }
            return read;
        }

        private void WireLiveChanges(InstanceState state)
        {
            var connection = state.Client.Connection;
            state.Library.Replaced += (before, after) => Raise(new ArrSnapshotChange(connection, ArrSnapshotKind.Library, before, after, null));
            state.Queue.Replaced += (before, after) => Raise(new ArrSnapshotChange(connection, ArrSnapshotKind.Queue, before, after, null));
            state.History.Replaced += (before, after) => Raise(new ArrSnapshotChange(connection, ArrSnapshotKind.History, before, after, null));
            state.Calendar.Replaced += (before, after) => Raise(new ArrSnapshotChange(connection, ArrSnapshotKind.Calendar, before, after, null));
            state.System.Replaced += (before, after) => Raise(new ArrSnapshotChange(connection, ArrSnapshotKind.System, before, after, null));
            state.EpisodesReplaced = (before, after) => Raise(new ArrSnapshotChange(connection, ArrSnapshotKind.Episodes, before, after, null));
        }

        private void Raise(ArrSnapshotChange change)
        {
            var handlers = SnapshotChanged;
            if (handlers == null) return;
            foreach (var handler in handlers.GetInvocationList().Cast<Action<ArrSnapshotChange>>())
            {
                try
                {
                    handler(change);
                }
                catch (Exception ex)
                {
                    _logger?.Warning($"Arr state: a change observer failed ({ex.GetType().Name}).");
                }
            }
        }
    }

    /// <summary>
    /// One snapshot change: which instance and snapshot, the value before (null on the first load)
    /// and after. <see cref="ChangedIds"/> lists the arr ids a library patch touched (null: compare
    /// the whole snapshot).
    /// </summary>
    public sealed record ArrSnapshotChange(ArrConnection Instance, ArrSnapshotKind Kind, object? Before, object After, IReadOnlyCollection<int>? ChangedIds);
}
