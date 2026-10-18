using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Microsoft.Extensions.Hosting;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Ready
{
    /// <summary>What a person's Ready playlist looks like to them (and, read-only, to an administrator).</summary>
    /// <param name="Enabled">The administrator's switch is in effect.</param>
    /// <param name="OptedIn">The person turned it on.</param>
    /// <param name="State"><see cref="ReadyState"/>.</param>
    /// <param name="Reason">Why it is in its state (a short code), or null.</param>
    /// <param name="PlaylistId">The managed playlist (its owner only), or null.</param>
    /// <param name="Entries">How many versions it holds as last confirmed.</param>
    /// <param name="RetentionDays">Days an entry stays.</param>
    /// <param name="CanRemove">There is a playlist the person may remove.</param>
    public sealed record ReadyStatus(bool Enabled, bool OptedIn, string State, string? Reason, Guid? PlaylistId, int Entries, int RetentionDays, bool CanRemove);

    /// <summary>
    /// The private Ready playlist (Requests &amp; downloads, phase 4f). For each person who turned it on, one Jellyfin playlist
    /// of theirs, private and shared with nobody, holds the exact versions of what they asked for or follow that is ready to
    /// watch (<see cref="ReadyCopySelector"/>). Its identity is the server, the owner, the playlist id and the create marker
    /// its own folder carries: never a name.
    /// <list type="bullet">
    /// <item><description>One person's work at a time (an async lock per person; never a database transaction, a settings lock or
    /// 4c1's list Lifecycle lock around a Jellyfin call). Every write is generation- and epoch-checked, and the binding and the
    /// switch are read again after every await.</description></item>
    /// <item><description>Create: the marker, the id Jellyfin will give the playlist and the time are recorded first; the playlist is
    /// made under a name carrying the marker, verified (owner, private, no shares, marker), recorded, then named. After a crash
    /// in between only that id is taken, and only while it is JE's own create (made then, empty, the person's, private, the
    /// marker): never a playlist the person made under that name.</description></item>
    /// <item><description>Right before every Jellyfin change the switch, the binding (opted in, this epoch, this playlist), the
    /// person and the playlist as Jellyfin stored it are checked again, with no await before the call (<see cref="ReadyGate"/>).</description></item>
    /// <item><description>Change: the raw membership is read fresh (entries Jellyfin keeps by path only resolved, duplicates and
    /// dangling entries kept as such); when it differs, the desired membership is journalled and set in one Jellyfin update
    /// (exactly these versions, in order), then read back; only what was observed is confirmed. After a crash the next run
    /// starts from what Jellyfin has, so nothing is ever added twice.</description></item>
    /// <item><description>A playlist missing on two consecutive reads a minute apart was deleted by the person: not made again until
    /// they turn it on again. Turning it off keeps it as it is; Remove deletes only it, and only while it is still private
    /// (shared or public: kept as it is and no longer managed). Shared, public or another owner's: no more writes. A JE restore needs the person to turn it on again first (D47); a foreign or unverifiable binding is never
    /// changed.</description></item>
    /// <item><description>Jellyfin events only bump an epoch and queue bounded work (no database, no lock, no wait on the event
    /// thread); a sweep every few minutes catches what events don't say (hidden content, access, expiry).</description></item>
    /// </list>
    /// </summary>
    public sealed class ReadyPlaylistService : IHostedService, IDisposable
    {
        /// <summary>The playlist's display name (the person may rename it; its identity doesn't depend on it).</summary>
        public const string PlaylistName = "Ready to watch";

        /// <summary>Most queued events (more are dropped; the sweep covers them).</summary>
        public const int QueueCapacity = 1024;

        /// <summary>Two reads at least this far apart must both find the playlist missing before it counts as deleted.</summary>
        internal static readonly TimeSpan MissingConfirm = TimeSpan.FromMinutes(1);

        /// <summary>How often every opted-in person's playlist is looked at.</summary>
        internal static readonly TimeSpan SweepEvery = TimeSpan.FromMinutes(5);

        /// <summary>How long items Jellyfin refused to add aren't asked for again.</summary>
        internal static readonly TimeSpan RefusedFor = TimeSpan.FromMinutes(30);

        /// <summary>
        /// An interrupted create is JE's own only when Jellyfin made that playlist within this long after the create was
        /// recorded (its folder's creation time; a little before allows for clock rounding).
        /// </summary>
        internal static readonly TimeSpan CreateWindow = TimeSpan.FromMinutes(1);

        private readonly ReadyPlaylistStore _store;
        private readonly IReadyPlaylistHost _host;
        private readonly IReadyInterestSource _interests;
        private readonly ReadyCopySelector _selector;
        private readonly IReadyPrivacy _privacy;
        private readonly IArrJellyfinView _view;
        private readonly Func<PluginConfiguration?> _config;
        private readonly Func<DateTimeOffset> _now;
        private readonly string _server;
        private readonly Logger? _logger;
        private readonly ConcurrentDictionary<Guid, SemaphoreSlim> _gates = new();
        private readonly ConcurrentDictionary<Guid, (HashSet<Guid> Ids, DateTimeOffset Until)> _refused = new();
        private readonly Channel<Work> _queue = Channel.CreateBounded<Work>(new BoundedChannelOptions(QueueCapacity) { FullMode = BoundedChannelFullMode.Wait, SingleReader = true });
        private readonly SemaphoreSlim _wake = new(0, int.MaxValue);
        private long _epoch;
        private int _overflow;
        private int _queued;
        private CancellationTokenSource? _loop;
        private Task? _loopTask;

        /// <summary>Creates the service (DI).</summary>
        public ReadyPlaylistService(ReadyPlaylistStore store, IReadyPlaylistHost host, IReadyInterestSource interests, ReadyCopySelector selector, IReadyPrivacy privacy, IArrJellyfinView view, MediaBrowser.Controller.IServerApplicationHost app, Logger logger)
            : this(store, host, interests, selector, privacy, view, null, null, ServerId(app), logger)
        {
        }

        /// <summary>Creates the service with an explicit configuration, clock and server identity (tests).</summary>
        internal ReadyPlaylistService(ReadyPlaylistStore store, IReadyPlaylistHost host, IReadyInterestSource interests, ReadyCopySelector selector, IReadyPrivacy privacy, IArrJellyfinView view, Func<PluginConfiguration?>? config, Func<DateTimeOffset>? now, string server, Logger? logger)
        {
            _store = store;
            _host = host;
            _interests = interests;
            _selector = selector;
            _privacy = privacy;
            _view = view;
            _config = config ?? (() => JellyfinEnhanced.Instance?.Configuration);
            _now = now ?? (() => DateTimeOffset.UtcNow);
            _server = server;
            _logger = logger;
        }

        /// <summary>This server's identity (Jellyfin's SystemId).</summary>
        public string Server => _server;

        /// <summary>Queued events not processed yet (tests).</summary>
        internal int QueuedCount => Volatile.Read(ref _queued);

        private static string ServerId(MediaBrowser.Controller.IServerApplicationHost app)
            => string.IsNullOrEmpty(app.SystemId) ? "unknown" : app.SystemId.Replace("-", string.Empty, StringComparison.Ordinal).ToLowerInvariant();

        private enum WorkKind
        {
            Dirty,
            Arrival,
            ItemGone,
            PlaylistGone,
            All,
        }

        private sealed record Work(WorkKind Kind, Guid Id, IReadOnlyList<TitleKey>? Keys);

        // ------------------------------------------------------------------ events (non-blocking: an epoch and a bounded queue)

        /// <summary>A person's playlist should be looked at soon (watched, permissions changed, settings opened).</summary>
        public void MarkDirty(Guid user) => Enqueue(new Work(WorkKind.Dirty, user, null));

        /// <summary>A movie or episode arrived or changed: the people interested in it get a look.</summary>
        public void OnArrival(IReadOnlyList<TitleKey> keys)
        {
            if (keys.Count > 0) Enqueue(new Work(WorkKind.Arrival, Guid.Empty, keys));
        }

        /// <summary>Jellyfin removed an item (a playlist, or a movie or episode): an epoch bump and a queued look.</summary>
        public void OnItemRemoved(Guid itemId, bool isPlaylist)
        {
            Interlocked.Increment(ref _epoch);
            Enqueue(new Work(isPlaylist ? WorkKind.PlaylistGone : WorkKind.ItemGone, itemId, null));
        }

        /// <summary>A JE restore replaced the database: everyone is looked at (the restore policy already holds their playlists).</summary>
        public void OnRestored()
        {
            Interlocked.Increment(ref _epoch);
            Enqueue(new Work(WorkKind.All, Guid.Empty, null));
        }

        private void Enqueue(Work work)
        {
            if (_queue.Writer.TryWrite(work))
            {
                Interlocked.Increment(ref _queued);
                if (_wake.CurrentCount < 4) _wake.Release();
            }
            else
            {
                Interlocked.Exchange(ref _overflow, 1);
            }
        }

        /// <summary>Processes what is queued: the people it concerns get one look each (tests step it; the loop runs it).</summary>
        internal async Task<int> RunPendingAsync(CancellationToken cancellationToken = default)
        {
            var users = new HashSet<Guid>();
            var all = Interlocked.Exchange(ref _overflow, 0) == 1;
            while (_queue.Reader.TryRead(out var work))
            {
                Interlocked.Decrement(ref _queued);
                switch (work.Kind)
                {
                    case WorkKind.Dirty:
                        users.Add(work.Id);
                        break;
                    case WorkKind.All:
                        all = true;
                        break;
                    case WorkKind.Arrival:
                        foreach (var u in Safe(() => _interests.Interested(work.Keys!)) ?? Array.Empty<Guid>()) users.Add(u);
                        break;
                    case WorkKind.PlaylistGone:
                        if (Safe(() => _store.ByPlaylist(_server, work.Id)) is { } owner) users.Add(owner.UserId);
                        break;
                    case WorkKind.ItemGone:
                        foreach (var b in Safe(() => _store.OptedIn(_server)) ?? Array.Empty<ReadyBinding>())
                        {
                            if (b.Confirmed.Contains(work.Id)) users.Add(b.UserId);
                        }

                        break;
                }
            }

            if (all)
            {
                foreach (var b in Safe(() => _store.OptedIn(_server)) ?? Array.Empty<ReadyBinding>()) users.Add(b.UserId);
            }

            var done = 0;
            foreach (var user in users)
            {
                cancellationToken.ThrowIfCancellationRequested();
                await ReconcileAsync(user, cancellationToken).ConfigureAwait(false);
                done++;
            }

            return done;
        }

        // ------------------------------------------------------------------ settings and status

        /// <summary>The person's Ready playlist as they see it.</summary>
        public ReadyStatus Status(Guid user)
        {
            var config = _config();
            var enabled = ReadyFlags.Playlist(config);
            var b = _store.Available ? _store.Binding(_server, user) : null;
            if (b == null) return new ReadyStatus(enabled, false, ReadyState.Off, null, null, 0, ReadyFlags.RetentionDays(config), false);
            var removable = b.PlaylistId is Guid id && _host.Get(id) is { } info && info.OwnerId == user && info.HasMarker(b.Marker);
            return new ReadyStatus(enabled, b.OptedIn, b.State, b.Reason, b.PlaylistId, b.Confirmed.Count, ReadyFlags.RetentionDays(config), removable || (b.PlaylistId != null && b.State == ReadyState.Privacy));
        }

        /// <summary>
        /// The person turns their Ready playlist on (a new epoch: after a deletion, removal or restore it is made or checked
        /// again) or off (it stays as it is, no more changes). Refused (nothing stored) while the switch is off.
        /// </summary>
        public async Task<ReadyStatus> SetPlaylistAsync(Guid user, bool on, CancellationToken cancellationToken = default)
        {
            if (!ReadyFlags.Playlist(_config()) || !_store.Available) return Status(user);
            var gate = _gates.GetOrAdd(user, _ => new SemaphoreSlim(1, 1));
            await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                if (on) _store.OptIn(_server, user, _now());
                else _store.OptOut(_server, user, _now());
            }
            finally
            {
                gate.Release();
            }

            if (on) MarkDirty(user);
            return Status(user);
        }

        /// <summary>
        /// Removes the person's managed playlist (only that one, and only while it is verifiably theirs and private: their own,
        /// carrying the marker, not public and shared with nobody, as Jellyfin stored it right before the delete) and records
        /// it as removed: it isn't made again until they turn it on again. <c>removed</c>; <c>kept</c> (shared or public: left
        /// as it is, no longer managed); <c>not_ours</c> (the binding is dropped but the playlist is left alone);
        /// <c>nothing</c>; <c>changed</c> (the settings changed meanwhile: nothing done) or <c>off</c>.
        /// </summary>
        public async Task<string> RemoveAsync(Guid user, CancellationToken cancellationToken = default)
        {
            if (!_store.Available) return "nothing";
            var gate = _gates.GetOrAdd(user, _ => new SemaphoreSlim(1, 1));
            await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                var generation = _store.Generation;
                var b = _store.Binding(_server, user);
                if (b?.PlaylistId is not Guid id) return "nothing";
                Interlocked.Increment(ref _epoch);
                var refused = await _host.DeleteAsync(id, stored => RemoveGate(generation, user, b, id, stored)).ConfigureAwait(false);
                switch (refused)
                {
                    case null or "gone":
                        _store.Removed(generation, _server, user, b.Revision, _now());
                        return "removed";
                    case "kept":
                        _store.Removed(generation, _server, user, b.Revision, _now(), "kept");
                        return "kept";
                    case "not_ours":
                        _store.Removed(generation, _server, user, b.Revision, _now());
                        return "not_ours";
                    default:
                        return refused;
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger?.Warning($"Ready playlist: could not remove a playlist ({ex.GetType().Name}).");
                return "error";
            }
            finally
            {
                gate.Release();
            }
        }

        // Right before the delete: the switch, the binding unchanged since Remove read it, and the playlist as stored now: gone
        // (nothing to delete), not the person's verifiable one (left alone), shared or public (kept), else deleted.
        private string? RemoveGate(long generation, Guid user, ReadyBinding read, Guid playlist, ReadyPlaylistInfo? stored)
        {
            if (_store.Generation != generation) return "changed";
            if (!ReadyFlags.Playlist(_config())) return "off";
            if (_store.Binding(_server, user) is not { } now || now.Revision != read.Revision || now.PlaylistId != playlist) return "changed";
            if (stored == null) return "gone";
            if (stored.OwnerId != user || !stored.HasMarker(read.Marker)) return "not_ours";
            return stored.PrivateTo(user) ? null : "kept";
        }

        // ------------------------------------------------------------------ reconciliation

        /// <summary>
        /// One look at a person's Ready playlist: make or check it, choose its entries, change it to match and confirm what
        /// Jellyfin then has. Returns <c>off</c>, <c>not_active</c>, <c>no_user</c>, <c>unreadable</c>, <c>missing</c>,
        /// <c>deleted</c>, <c>privacy</c>, <c>changed</c>, <c>native_error</c>, <c>unchanged</c> or <c>updated</c>. Never throws
        /// for a failed Jellyfin call (the journal is left for the next run).
        /// </summary>
        public async Task<string> ReconcileAsync(Guid user, CancellationToken cancellationToken = default)
        {
            if (!ReadyFlags.Playlist(_config()) || !_store.Available) return "off";
            var gate = _gates.GetOrAdd(user, _ => new SemaphoreSlim(1, 1));
            await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                return await ReconcileLockedAsync(user, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger?.Warning($"Ready playlist: a change failed and will be retried ({ex.GetType().Name}: {ex.Message}).");
                return "native_error";
            }
            finally
            {
                gate.Release();
            }
        }

        private async Task<string> ReconcileLockedAsync(Guid user, CancellationToken cancellationToken)
        {
            var generation = _store.Generation;
            var b = _store.Binding(_server, user);
            if (b == null || !b.OptedIn || b.State != ReadyState.Active) return "not_active";
            var viewer = _view.Viewer(user);
            if (viewer == null) return "no_user";
            var now = _now();
            var epoch = b.Epoch;

            // 1. The playlist: made under its marker, or the bound one checked in full.
            Guid playlist;
            if (b.PlaylistId is Guid bound)
            {
                var info = _host.Get(bound);
                if (info == null) return Missing(generation, user, epoch, now);
                if (Unsafe(info, b, user) is { } reason) return Privacy(generation, user, epoch, reason, now);
                // Read and checked: an earlier missing read doesn't count towards a deletion any more.
                if (b.MissingCount > 0 || b.MissingSince != null) _store.ClearMissing(generation, _server, user, epoch, now);
                playlist = bound;
            }
            else
            {
                // JE's own create a crash interrupted (recorded before it, made then), else a new one under a new marker.
                var made = Interrupted(b, user);
                var marker = made != null ? b.Marker! : Guid.NewGuid().ToString("N");
                if (made == null)
                {
                    var name = CreateName(marker);
                    if (!_store.BeginCreate(generation, _server, user, epoch, marker, _host.NewPlaylistId(name), now)) return "changed";
                    var (id, refused) = await _host.CreateAsync(user, name, Gate(generation, user, epoch, null, marker, null)).ConfigureAwait(false);
                    if (refused != null) return Refused(generation, user, epoch, refused, now);
                    if (!Still(generation, user, epoch) || id is not Guid madeId) return "changed";
                    made = _host.Get(madeId);
                }

                if (made == null || !made.PrivateTo(user) || !made.HasMarker(marker)) return "changed";
                if (!_store.Bind(generation, _server, user, epoch, made.Id, now)) return "changed";
                if (!string.Equals(made.Name, PlaylistName, StringComparison.Ordinal))
                {
                    // JE's name only while the stored name is still the create's own (a name the person gave it stays).
                    var createName = CreateName(marker);
                    var renamed = await _host.RenameAsync(made.Id, user, PlaylistName, Gate(generation, user, epoch, made.Id, marker,
                        stored => string.Equals(stored.Name, createName, StringComparison.Ordinal) ? null : "named")).ConfigureAwait(false);
                    if (renamed is not (null or "named")) return Refused(generation, user, epoch, renamed, now);
                    if (!Still(generation, user, epoch)) return "changed";
                }

                playlist = made.Id;
                b = _store.Binding(_server, user)!;
            }

            // 2. What it should hold now.
            var interests = _interests.For(user);
            var hides = _privacy.Load(user);
            if (interests == null || hides == null) return "unreadable";
            var selection = _selector.Select(viewer, interests, hides, _store.Entries(_server, user), now, ReadyFlags.RetentionDays(_config()));
            if (!_store.SaveEntries(generation, _server, user, epoch, selection.Rows, selection.Removed, now)) return "changed";
            var desired = selection.Desired;

            // 3. Change it to match, reading Jellyfin back after every change; confirm only what was observed.
            var raw = _host.Entries(playlist);
            if (raw.SequenceEqual(desired))
            {
                if (b.PendingOperation != null || !b.Confirmed.SequenceEqual(raw)) _store.Confirm(generation, _server, user, epoch, raw, now);
                return "unchanged";
            }

            // Items Jellyfin refused lately aren't asked for again on every pass (they are after a while).
            if (_refused.TryGetValue(user, out var refusedLately) && refusedLately.Until > now && raw.SequenceEqual(desired.Where(id => !refusedLately.Ids.Contains(id))))
            {
                if (b.PendingOperation != null || !b.Confirmed.SequenceEqual(raw)) _store.Confirm(generation, _server, user, epoch, raw, now);
                return "unchanged";
            }

            if (!_store.BeginChange(generation, _server, user, epoch, desired, now)) return "changed";
            // One change: exactly the desired versions in order (duplicates, entries Jellyfin keeps by path only and
            // entries that resolve to nothing go with it), made only if everything still holds right before it (switch, opt-in,
            // person, playlist as stored); then read back, and only what Jellyfin then has is confirmed.
            var notSet = await _host.SetAsync(playlist, desired, user, Gate(generation, user, epoch, playlist, b.Marker, null)).ConfigureAwait(false);
            if (notSet != null) return Refused(generation, user, epoch, notSet, now);
            if (!Still(generation, user, epoch)) return "changed";
            raw = _host.Entries(playlist);
            _store.Confirm(generation, _server, user, epoch, raw, now);
            var refused2 = desired.Where(id => !raw.Contains(id)).ToHashSet();
            if (refused2.Count > 0)
            {
                _refused[user] = (refused2, now + RefusedFor);
                _logger?.Info($"Ready playlist: Jellyfin didn't add {refused2.Count} item(s); they are tried again later.");
            }
            else
            {
                _refused.TryRemove(user, out _);
            }

            return "updated";
        }

        /// <summary>The name a playlist is made under: the display name and the create's marker (its folder keeps it).</summary>
        internal static string CreateName(string marker) => PlaylistName + " (" + marker + ")";

        // The playlist an interrupted create made, when the evidence says it is JE's own: the id recorded before the create
        // call, made within the window after it, still empty, the person's, private and carrying the marker. A playlist the
        // person made under that name (the name shows the marker) fails at least the time or the contents, so it's never
        // adopted; without that evidence nothing is.
        private ReadyPlaylistInfo? Interrupted(ReadyBinding b, Guid user)
        {
            if (b.Marker == null || b.CreateId is not Guid id || b.CreateAt is not long at) return null;
            var found = _host.Get(id);
            if (found == null || found.Id != id || !found.PrivateTo(user) || !found.HasMarker(b.Marker)) return null;
            var created = found.Created.ToUnixTimeMilliseconds();
            if (created < at - 5000 || created > at + (long)CreateWindow.TotalMilliseconds) return null;
            return _host.Entries(id).Count == 0 ? found : null;
        }

        // The last check before a Jellyfin change (run by the host with no await before its call): the database, the switch,
        // the binding (opted in and active at this epoch, naming this playlist, or none and this marker for a create), the
        // person, and the playlist as Jellyfin stored it now (owner, marker, private; plus any extra condition).
        private ReadyGate Gate(long generation, Guid user, long epoch, Guid? playlist, string? marker, Func<ReadyPlaylistInfo, string?>? extra)
            => stored =>
            {
                if (_store.Generation != generation) return "changed";
                if (!ReadyFlags.Playlist(_config())) return "off";
                if (_store.Binding(_server, user) is not { OptedIn: true, State: ReadyState.Active } now || now.Epoch != epoch || now.PlaylistId != playlist) return "changed";
                if (marker != null && !string.Equals(now.Marker, marker, StringComparison.Ordinal)) return "changed";
                if (_view.Viewer(user) == null) return "no_user";
                if (playlist == null) return null;
                if (stored == null) return "missing";
                return Unsafe(stored, now, user) ?? extra?.Invoke(stored);
            };

        // A change the gate didn't let through: a missing playlist counts towards a deletion, a privacy or identity change
        // stops the writes, anything else (switch off, opt-out, a new epoch, the person gone) just ends this look.
        private string Refused(long generation, Guid user, long epoch, string reason, DateTimeOffset now) => reason switch
        {
            "missing" => Missing(generation, user, epoch, now),
            "owner_changed" or "identity" or "public" or "shared" => Privacy(generation, user, epoch, reason, now),
            _ => reason,
        };

        // Owner, privacy and marker, as the playlist is now; null when it is safe to change.
        private static string? Unsafe(ReadyPlaylistInfo info, ReadyBinding b, Guid user)
        {
            if (info.OwnerId != user) return "owner_changed";
            if (!info.HasMarker(b.Marker)) return "identity";
            if (info.OpenAccess) return "public";
            if (info.ShareCount > 0) return "shared";
            return null;
        }

        private string Missing(long generation, Guid user, long epoch, DateTimeOffset now)
        {
            var b = _store.NoteMissing(generation, _server, user, epoch, now);
            if (b is { MissingCount: >= 2, MissingSince: long since } && now.ToUnixTimeMilliseconds() - since >= (long)MissingConfirm.TotalMilliseconds)
            {
                _store.SetState(generation, _server, user, epoch, ReadyState.Deleted, "deleted_in_jellyfin", now);
                _logger?.Info("Ready playlist: a person deleted their Ready playlist; it isn't made again until they turn it on again.");
                return "deleted";
            }

            return "missing";
        }

        private string Privacy(long generation, Guid user, long epoch, string reason, DateTimeOffset now)
        {
            _store.SetState(generation, _server, user, epoch, ReadyState.Privacy, reason, now);
            return "privacy";
        }

        // After an await: the database is the same, the switch still on and the binding still opted in at this epoch.
        private bool Still(long generation, Guid user, long epoch)
            => _store.Generation == generation && ReadyFlags.Playlist(_config())
               && _store.Binding(_server, user) is { OptedIn: true, State: ReadyState.Active } b && b.Epoch == epoch;

        private T? Safe<T>(Func<T?> read)
            where T : class
        {
            try
            {
                return read();
            }
            catch (Exception ex)
            {
                _logger?.Warning($"Ready playlist: a read failed ({ex.GetType().Name}).");
                return null;
            }
        }

        // ------------------------------------------------------------------ hosted loop

        /// <inheritdoc />
        public Task StartAsync(CancellationToken cancellationToken)
        {
            Backup.JeBackupService.DataRestored += OnRestored;
            _loop = new CancellationTokenSource();
            var token = _loop.Token;
            // A fresh execution context: no caller's AsyncLocal (a list continuation, an automation context) reaches the loop.
            using (ExecutionContext.SuppressFlow())
            {
                _loopTask = Task.Run(() => LoopAsync(token), CancellationToken.None);
            }

            return Task.CompletedTask;
        }

        /// <inheritdoc />
        public async Task StopAsync(CancellationToken cancellationToken)
        {
            Backup.JeBackupService.DataRestored -= OnRestored;
            try
            {
                _loop?.Cancel();
            }
            catch (ObjectDisposedException)
            {
            }

            if (_loopTask is not { } loop) return;
            try
            {
                await loop.WaitAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
            }
        }

        private async Task LoopAsync(CancellationToken token)
        {
            var nextSweep = DateTimeOffset.UtcNow + TimeSpan.FromSeconds(90);
            while (!token.IsCancellationRequested)
            {
                try
                {
                    if (await _wake.WaitAsync(TimeSpan.FromSeconds(30), token).ConfigureAwait(false))
                    {
                        // A burst of library events settles first (a scan, a season pack, media probing).
                        await Task.Delay(TimeSpan.FromSeconds(5), token).ConfigureAwait(false);
                    }

                    if (DateTimeOffset.UtcNow >= nextSweep)
                    {
                        nextSweep = DateTimeOffset.UtcNow + SweepEvery;
                        if (ReadyFlags.Playlist(_config())) Interlocked.Exchange(ref _overflow, 1);
                    }

                    if (ReadyFlags.Playlist(_config())) await RunPendingAsync(token).ConfigureAwait(false);
                    else
                    {
                        while (_queue.Reader.TryRead(out _)) Interlocked.Decrement(ref _queued);
                    }
                }
                catch (OperationCanceledException) when (token.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception ex)
                {
                    _logger?.Warning($"Ready playlist: a round failed ({ex.GetType().Name}: {ex.Message}).");
                }
            }
        }

        /// <inheritdoc />
        public void Dispose()
        {
            Backup.JeBackupService.DataRestored -= OnRestored;
            var loop = Interlocked.Exchange(ref _loop, null);
            if (loop == null) return;
            try
            {
                loop.Cancel();
            }
            catch (ObjectDisposedException)
            {
            }

            loop.Dispose();
        }
    }
}
