using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Microsoft.Extensions.Hosting;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>One targeted refresh the bridge ran (or decided against), for the System tab.</summary>
    public sealed class BridgeRefresh
    {
        /// <summary>When it was decided (UTC).</summary>
        public DateTimeOffset At { get; init; }

        /// <summary>Instance name.</summary>
        public string Instance { get; init; } = string.Empty;

        /// <summary>The file as the arr sees it.</summary>
        public string ArrPath { get; init; } = string.Empty;

        /// <summary>The file as Jellyfin sees it.</summary>
        public string JellyfinPath { get; init; } = string.Empty;

        /// <summary>The folder refreshed (or where it stopped).</summary>
        public string? Folder { get; init; }

        /// <summary>That folder's kind (season, series, folder).</summary>
        public string? FolderKind { get; init; }

        /// <summary>refresh, present, library_root, left_to_scan, outside_library, no_ancestor, scan_running, failed.</summary>
        public string Outcome { get; init; } = string.Empty;

        /// <summary>True when Jellyfin had an item for the file afterwards.</summary>
        public bool Found { get; init; }

        /// <summary>How long the refresh took.</summary>
        public long Ms { get; init; }

        /// <summary>An error, when it failed.</summary>
        public string? Error { get; init; }
    }

    /// <summary>A file an arr imported that Jellyfin has no item for (yet).</summary>
    public sealed class BridgeMissing
    {
        /// <summary>Instance id.</summary>
        public string InstanceId { get; init; } = string.Empty;

        /// <summary>Instance name.</summary>
        public string Instance { get; init; } = string.Empty;

        /// <summary>Sonarr or Radarr.</summary>
        public string Kind { get; init; } = string.Empty;

        /// <summary>Title.</summary>
        public string? Title { get; init; }

        /// <summary>Year (movies).</summary>
        public int? Year { get; init; }

        /// <summary>The title key.</summary>
        public string? Key { get; init; }

        /// <summary>Season.</summary>
        public int? Season { get; init; }

        /// <summary>Episode.</summary>
        public int? Episode { get; init; }

        /// <summary>The arr's id of the movie or series.</summary>
        public int? ArrId { get; init; }

        /// <summary>The file as the arr sees it.</summary>
        public string ArrPath { get; init; } = string.Empty;

        /// <summary>The file as Jellyfin sees it (after path mapping).</summary>
        public string JellyfinPath { get; init; } = string.Empty;

        /// <summary>When the arr imported it (UTC).</summary>
        public DateTime ImportedAt { get; init; }

        /// <summary>not_scanned (Jellyfin can see it; it hasn't picked it up), not_visible (Jellyfin can't see the file there: path mapping or mount), outside_library (no Jellyfin library contains it).</summary>
        public string Problem { get; init; } = string.Empty;

        /// <summary>The Jellyfin library the file belongs to.</summary>
        public string? Library { get; init; }
    }

    /// <summary>A title an arr has files for that Jellyfin doesn't list at all (by provider id).</summary>
    public sealed class BridgeMissingTitle
    {
        /// <summary>Instance id.</summary>
        public string InstanceId { get; init; } = string.Empty;

        /// <summary>Instance name.</summary>
        public string Instance { get; init; } = string.Empty;

        /// <summary>Title.</summary>
        public string Title { get; init; } = string.Empty;

        /// <summary>Year.</summary>
        public int? Year { get; init; }

        /// <summary>Title key.</summary>
        public string? Key { get; init; }

        /// <summary>The title's folder as the arr sees it.</summary>
        public string? ArrPath { get; init; }

        /// <summary>The folder as Jellyfin sees it.</summary>
        public string? JellyfinPath { get; init; }

        /// <summary>Same problem words as <see cref="BridgeMissing.Problem"/>.</summary>
        public string Problem { get; init; } = string.Empty;
    }

    /// <summary>The library-wide list (capped) and how many there are in all.</summary>
    public sealed class BridgeMissingTitles
    {
        /// <summary>Titles (at most 50 per instance).</summary>
        public IReadOnlyList<BridgeMissingTitle> Titles { get; init; } = Array.Empty<BridgeMissingTitle>();

        /// <summary>How many there are per instance id.</summary>
        public IReadOnlyDictionary<string, int> Counts { get; init; } = new Dictionary<string, int>();
    }

    /// <summary>One configured path mapping, checked.</summary>
    public sealed class PathDoctorMapping
    {
        /// <summary>Arr side.</summary>
        public string ArrPath { get; init; } = string.Empty;

        /// <summary>Jellyfin side.</summary>
        public string JellyfinPath { get; init; } = string.Empty;

        /// <summary>Jellyfin can see the folder.</summary>
        public bool Exists { get; init; }

        /// <summary>The library that contains it.</summary>
        public string? Library { get; init; }
    }

    /// <summary>One arr root folder, as Jellyfin sees it.</summary>
    public sealed class PathDoctorRoot
    {
        /// <summary>The arr's root folder.</summary>
        public string ArrPath { get; init; } = string.Empty;

        /// <summary>The same folder for Jellyfin (mapped, or the same path).</summary>
        public string JellyfinPath { get; init; } = string.Empty;

        /// <summary>A configured mapping was used.</summary>
        public bool Mapped { get; init; }

        /// <summary>Jellyfin can see the folder.</summary>
        public bool Exists { get; init; }

        /// <summary>The library that contains it.</summary>
        public string? Library { get; init; }

        /// <summary>
        /// null (fine), not_visible (Jellyfin can't see the folder), not_in_library (no library contains
        /// it), or, only with the Calendar page and its "filter by library access" on, shared_root
        /// (another instance has the same root and neither maps it) or roots_unknown (no mapping
        /// applies and another instance's root folders can't be read yet).
        /// </summary>
        public string? Problem { get; init; }

        /// <summary>
        /// True only with the Calendar page and its "filter by library access" on: users who aren't
        /// administrators don't see this root's upcoming titles because no library can be told for
        /// it, and the instance has no linked libraries.
        /// </summary>
        public bool HiddenFromMembers { get; init; }
    }

    /// <summary>A title both sides have, compared.</summary>
    public sealed class PathDoctorSample
    {
        /// <summary>Title.</summary>
        public string Title { get; init; } = string.Empty;

        /// <summary>The title's folder for the arr.</summary>
        public string ArrPath { get; init; } = string.Empty;

        /// <summary>Where the mappings say Jellyfin should find it.</summary>
        public string Expected { get; init; } = string.Empty;

        /// <summary>Where Jellyfin actually has it.</summary>
        public string Actual { get; init; } = string.Empty;

        /// <summary>They agree.</summary>
        public bool Match { get; init; }
    }

    /// <summary>The path doctor's report for one instance.</summary>
    public sealed class PathDoctorInstance
    {
        /// <summary>Instance id.</summary>
        public string InstanceId { get; init; } = string.Empty;

        /// <summary>Instance name.</summary>
        public string Instance { get; init; } = string.Empty;

        /// <summary>ok, problem or unknown (nothing to compare yet).</summary>
        public string Verdict { get; init; } = "unknown";

        /// <summary>Configured mappings.</summary>
        public IReadOnlyList<PathDoctorMapping> Mappings { get; init; } = Array.Empty<PathDoctorMapping>();

        /// <summary>The arr's root folders.</summary>
        public IReadOnlyList<PathDoctorRoot> Roots { get; init; } = Array.Empty<PathDoctorRoot>();

        /// <summary>Titles compared.</summary>
        public IReadOnlyList<PathDoctorSample> Samples { get; init; } = Array.Empty<PathDoctorSample>();

        /// <summary>A mapping learned from the samples that would fix them, if one fits all.</summary>
        public PathDoctorMapping? Suggestion { get; init; }
    }

    /// <summary>What Scan now did.</summary>
    public sealed class BridgeScanResult
    {
        /// <summary>refreshed (the folder was refreshed), added (a brand-new folder was added on its own), present (Jellyfin already has it), refused.</summary>
        public string Outcome { get; init; } = string.Empty;

        /// <summary>The library.</summary>
        public string? Library { get; init; }

        /// <summary>The folder refreshed.</summary>
        public string? Folder { get; init; }

        /// <summary>Jellyfin has an item for the path afterwards.</summary>
        public bool Found { get; init; }

        /// <summary>Why it was refused.</summary>
        public string? Reason { get; init; }
    }

    /// <summary>
    /// The Jellyfin bridge (Requests &amp; downloads, phase 2): makes arr imports show up in Jellyfin
    /// without a library scan, and tells administrators when they don't.
    /// <list type="bullet">
    /// <item><description><b>Targeted refresh.</b> When an instance's history gains an import (read
    /// because SignalR/webhooks said a file arrived), the file's path is mapped to Jellyfin's view
    /// (the instance's path mappings) and the nearest folder Jellyfin already has is validated
    /// non-recursively with only the new paths (about 0.1–2 s instead of a 60 s+ library scan), then
    /// each new folder below it in turn (a new season folder). A TV library's root is never
    /// refreshed, scanned or reported to Jellyfin's monitor (any of those re-validates every series): a
    /// brand-new series folder is added on its own, through Jellyfin's resolver for that one folder,
    /// whatever the library's real-time monitoring, and then hydrated inside it. Refreshes are debounced per folder,
    /// one at a time per folder, bounded in time, and wait while Jellyfin's library scan runs.</description></item>
    /// <item><description><b>Ready means ready.</b> Every import is held "Almost ready" in the readiness gate
    /// (<see cref="BridgeImportReadiness"/>) from before its refresh; the file must stop changing before Jellyfin
    /// reads it; once the refresh that added it ends, its metadata is read back, a skeleton (the raw folder name, no
    /// overview, poster or media info) gets one scoped hydration (remote metadata and images in full, its title and
    /// overview replaced; never the library), and it is published Ready exactly once after the read-back confirms it
    /// (or after a bounded wait, with what is missing logged). A file Jellyfin lists without its metadata (after a
    /// restart, Scan now) is repaired the same way.</description></item>
    /// <item><description><b>In Sonarr/Radarr, not in Jellyfin.</b> Recent imports Jellyfin has no item
    /// for (with why: not scanned yet, file not visible to Jellyfin, outside every library), and
    /// titles an arr has files for that Jellyfin doesn't list at all.</description></item>
    /// <item><description><b>Path doctor.</b> Each instance's root folders and path mappings as
    /// Jellyfin sees them, compared on titles both sides have, with a learned mapping when the
    /// paths disagree.</description></item>
    /// <item><description><b>Scan now.</b> An administrator's targeted refresh of one imported path (a brand-new
    /// series folder added on its own), with the item's metadata read back and repaired.</description></item>
    /// </list>
    /// Only acts while "Requests &amp; downloads" phases 1 and 2 are on (and targeted refresh is).
    /// </summary>
    public sealed class JellyfinBridge : IHostedService, IDisposable
    {
        private const int RecentSize = 50;
        private const int MaxImportsChecked = 300;
        private const int MaxScanWaits = 20;
        /// <summary>Folder levels refreshed one after the other for one file (series → new season folder → …).</summary>
        private const int MaxLevels = 3;
        /// <summary>Outcome: a new folder in a library without real-time monitoring, left to Jellyfin's next library scan.</summary>
        internal const string LeftToScan = "left_to_scan";
        /// <summary>Outcome: the refresh was waiting (or about to go a level deeper) when its switch was turned off: not run.</summary>
        internal const string SwitchedOff = "switched_off";
        private static readonly TimeSpan ImportWindow = TimeSpan.FromMinutes(30);
        private static readonly TimeSpan MissingWindow = TimeSpan.FromDays(7);

        /// <summary>How long one folder refresh may run before it is cancelled (Jellyfin may spend long on remote metadata inside it).</summary>
        internal TimeSpan RefreshBudget { get; set; } = TimeSpan.FromMinutes(2);

        /// <summary>How long Scan now waits for Jellyfin to list a path once its folder refresh has started.</summary>
        internal TimeSpan ScanNowWait { get; set; } = TimeSpan.FromSeconds(20);

        /// <summary>
        /// How long Scan now waits for its folder refresh to start while an earlier refresh of the same
        /// folder still runs. Past it the answer goes back; the file is followed through in the background.
        /// </summary>
        internal TimeSpan ScanNowQueueWait { get; set; } = TimeSpan.FromSeconds(40);

        /// <summary>
        /// How long to wait, one after the other, for Jellyfin to number an imported episode (its metadata does, a
        /// moment after the refresh adds it) before the missing episode of its slot can be told apart.
        /// </summary>
        internal TimeSpan[] MissingTwinWaits { get; set; } = { TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(3), TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(30) };

        /// <summary>How long one hydration may take before it is asked for again (Jellyfin's refresh queue reports no completion).</summary>
        internal TimeSpan HydrationAttemptTimeout { get; set; } = TimeSpan.FromSeconds(90);

        /// <summary>How often a just-imported item's metadata is read back while it is followed.</summary>
        internal TimeSpan HydrationPoll { get; set; } = TimeSpan.FromSeconds(2);

        /// <summary>The waits before the second and third hydration of one import (bounded retries with backoff).</summary>
        internal TimeSpan[] HydrationBackoff { get; set; } = { TimeSpan.FromSeconds(30), TimeSpan.FromMinutes(2) };

        /// <summary>The longest wait for imported files to stop changing; Jellyfin is asked to read them after it anyway (logged).</summary>
        internal TimeSpan StableMaxWait { get; set; } = TimeSpan.FromMinutes(2);

        /// <summary>Overrides <see cref="PluginConfiguration.ArrBridgeStableSeconds"/> (tests).</summary>
        internal TimeSpan? StableQuietOverride { get; set; }

        /// <summary>Overrides <see cref="PluginConfiguration.ArrBridgeMetadataWaitMinutes"/> (tests).</summary>
        internal TimeSpan? MetadataWaitOverride { get; set; }

        /// <summary>How long an imported file must stay unchanged before Jellyfin reads it.</summary>
        private TimeSpan StableQuiet => StableQuietOverride ?? TimeSpan.FromSeconds(Math.Clamp(_config()?.ArrBridgeStableSeconds ?? 3, 0, 60));

        /// <summary>How long a just-imported title waits for its metadata before it is published Ready anyway.</summary>
        private TimeSpan MetadataWait => MetadataWaitOverride ?? TimeSpan.FromMinutes(Math.Clamp(_config()?.ArrBridgeMetadataWaitMinutes ?? 10, 1, 120));
        private static readonly TimeSpan ScanWait = TimeSpan.FromSeconds(30);
        private static readonly TimeSpan MissingCacheFor = TimeSpan.FromSeconds(15);
        private static readonly TimeSpan TitlesCacheFor = TimeSpan.FromMinutes(2);

        private readonly ArrStateStore _store;
        private readonly IJellyfinLibraryAccess _library;
        private readonly Logger? _logger;
        private readonly Func<PluginConfiguration?> _config;
        private readonly Func<DateTimeOffset> _now;
        private readonly Func<TimeSpan, CancellationToken, Task> _delay;
        private readonly object _lock = new();
        private readonly Dictionary<Guid, Task> _running = new();
        private readonly Dictionary<Guid, QueuedRefresh> _waiting = new();
        // New top folders being added (one at a time per folder).
        private readonly HashSet<string> _creating = new(StringComparer.Ordinal);
        private readonly BridgeImportReadiness _readiness;
        // The imports the readiness gate follows, by Jellyfin path: which import (generation) and its title key (bounded).
        private readonly Dictionary<string, (string Generation, string? Key)> _imports = new(StringComparer.Ordinal);
        // Hydration jobs running, one per import (path and generation).
        private readonly HashSet<string> _hydrationJobs = new(StringComparer.Ordinal);
        // When a hydration of each item was last asked for (UTC, as Jellyfin stamps refreshes), whichever job asked.
        private readonly Dictionary<Guid, (DateTime At, HydrationScope Scope)> _hydrationAsked = new();
        private long _generationSeq;
        private readonly HashSet<string> _historyLoads = new(StringComparer.OrdinalIgnoreCase);
        /// <summary>Files whose missing twins are being removed (with their retries), under the bridge's lock.</summary>
        private readonly HashSet<string> _twinFiles = new(StringComparer.Ordinal);
        // Items asked to be read again after an import at their own path, and when (one ask per item per window).
        private readonly Dictionary<Guid, DateTimeOffset> _rereadAt = new();
        private readonly CancellationTokenSource _stop = new();
        private readonly List<Pending> _pending = new();
        private readonly LinkedList<BridgeRefresh> _recent = new();
        // Background work in flight (debounced batches, history loads, refreshes, follow-ups): a stop waits for it.
        private readonly HashSet<Task> _work = new();
        private bool _scheduled;
        private bool _subscribed;
        private bool _stopped;
        private long _refreshes;
        private long _found;
        // The "not in Jellyfin" list with the generation it was read under: a refresh that changes it bumps the generation,
        // and a list read before that (under an older one) is never served, even if it is stored after.
        private (DateTimeOffset At, IReadOnlyList<BridgeMissing> Value, long Generation)? _missing;
        private long _missingGeneration;
        private (DateTimeOffset At, BridgeMissingTitles Value)? _titles;

        /// <summary>The bridge (DI).</summary>
        public JellyfinBridge(ArrStateStore store, IJellyfinLibraryAccess library, Logger logger, BridgeImportReadiness readiness)
            : this(store, library, logger, null, null, null, readiness)
        {
        }

        /// <summary>The bridge with explicit configuration, clock, delay and readiness gate (tests; a private gate when none is given).</summary>
        internal JellyfinBridge(ArrStateStore store, IJellyfinLibraryAccess library, Logger? logger, Func<PluginConfiguration?>? config, Func<DateTimeOffset>? now, Func<TimeSpan, CancellationToken, Task>? delay, BridgeImportReadiness? readiness = null)
        {
            _store = store;
            _library = library;
            _logger = logger;
            _config = config ?? (() => JellyfinEnhanced.Instance?.Configuration);
            _now = now ?? (() => DateTimeOffset.UtcNow);
            _delay = delay ?? ((t, ct) => Task.Delay(t, ct));
            _instanceLibraries = new ArrInstanceLibraries(store, library, now);
            _readiness = readiness ?? new BridgeImportReadiness(null, now);
        }

        /// <summary>The readiness gate this bridge feeds (tests).</summary>
        internal BridgeImportReadiness Readiness => _readiness;

        // The same rule the Calendar uses for titles not in Jellyfin yet (which roots members can't see).
        private readonly ArrInstanceLibraries _instanceLibraries;

        /// <summary>How long imports are gathered before their folders are refreshed (one refresh per folder for a burst).</summary>
        internal TimeSpan Debounce { get; set; } = TimeSpan.FromSeconds(1);

        /// <summary>True when phases 1 and 2 are on.</summary>
        public bool Enabled => Phase2(_config());

        /// <summary>True when targeted refresh runs after imports.</summary>
        public bool RefreshEnabled => _config() is { ArrTargetedRefreshEnabled: true } c && Phase2(c);

        /// <summary>Folder refreshes run (after imports and Scan now) and how many files they found.</summary>
        public (long Refreshes, long Found) Stats => (Interlocked.Read(ref _refreshes), Interlocked.Read(ref _found));

        /// <summary>The newest refresh decisions, newest first.</summary>
        public IReadOnlyList<BridgeRefresh> Recent()
        {
            lock (_lock) return _recent.ToList();
        }

        internal static bool Phase2(PluginConfiguration? c) => c is { ArrIntegrationEnabled: true, ArrPhase1Enabled: true, ArrPhase2Enabled: true };

        /// <summary>A folder refresh may run: Scan now (an administrator's click) needs phase 2 on, work after imports also targeted refresh.</summary>
        private bool Allowed(bool manual) => manual ? Enabled : RefreshEnabled;

        /// <inheritdoc />
        public Task StartAsync(CancellationToken cancellationToken)
        {
            Subscribe();
            return Task.CompletedTask;
        }

        /// <inheritdoc />
        /// <remarks>
        /// Stops following the arrs, cancels the work in flight (waiting batches, folder refreshes and
        /// their follow-ups) and waits for it to end, or until Jellyfin stops waiting. Nothing new
        /// starts afterwards.
        /// </remarks>
        public async Task StopAsync(CancellationToken cancellationToken)
        {
            Unsubscribe();
            Task[] work;
            lock (_lock)
            {
                _stopped = true;
                _pending.Clear();
                work = _work.ToArray();
            }
            try
            {
                _stop.Cancel();
            }
            catch (ObjectDisposedException)
            {
                // already disposed
            }
            try
            {
                await Task.WhenAll(work).WaitAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (Exception)
            {
                // Jellyfin stopped waiting, or the work ended cancelled or failed (each logs its own).
            }
        }

        /// <summary>True once stopped: nothing new is queued or started (tests).</summary>
        internal bool Stopped
        {
            get
            {
                lock (_lock) return _stopped;
            }
        }

        /// <summary>Background work in flight (tests).</summary>
        internal int WorkInFlight
        {
            get
            {
                lock (_lock) return _work.Count;
            }
        }

        /// <summary>Hydration jobs guarded as running (tests).</summary>
        internal int HydrationJobsHeld
        {
            get
            {
                lock (_lock) return _hydrationJobs.Count;
            }
        }

        /// <summary>Runs right after background work starts, before the caller goes on (tests interleave other calls there).</summary>
        internal Action<Task>? AfterStart { get; set; }

        // Starts background work that a stop waits for; after the stop, nothing starts (a completed task).
        private Task Track(Func<Task> work) => TryTrack(work, out var task) ? task : Task.CompletedTask;

        // Starts background work that a stop waits for; false (nothing started) once stopped. Only a
        // refusal tells the caller the work won't run: a task already completed may simply have been quick.
        private bool TryTrack(Func<Task> work, out Task task)
        {
            lock (_lock)
            {
                if (_stopped)
                {
                    task = Task.CompletedTask;
                    return false;
                }
                using (ExecutionContext.SuppressFlow()) task = Task.Run(work);
                _work.Add(task);
            }
            _ = task.ContinueWith(
                t =>
                {
                    lock (_lock) _work.Remove(t);
                },
                CancellationToken.None,
                TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
            AfterStart?.Invoke(task);
            return true;
        }

        /// <summary>Starts following the store (tests call it directly).</summary>
        internal void Subscribe()
        {
            lock (_lock)
            {
                if (_subscribed) return;
                _subscribed = true;
            }
            _store.SnapshotChanged += OnSnapshotChanged;
        }

        private void Unsubscribe()
        {
            lock (_lock)
            {
                if (!_subscribed) return;
                _subscribed = false;
            }
            _store.SnapshotChanged -= OnSnapshotChanged;
        }

        /// <inheritdoc />
        public void Dispose()
        {
            Unsubscribe();
            lock (_lock) _stopped = true;
            try
            {
                _stop.Cancel();
            }
            catch (ObjectDisposedException)
            {
                // already disposed
            }
        }

        // ------------------------------------------------------------------ targeted refresh

        /// <summary>
        /// A history refresh: imports that are new since the previous snapshot and recent are queued
        /// for a targeted refresh. The first read (after a start, or once the instance is read again
        /// from scratch) replays every import of the last 30 minutes: one made while Jellyfin was
        /// restarting, or queued but not refreshed yet when it stopped, still gets its refresh; the
        /// ones Jellyfin already lists need nothing and leave no trace. A library read of an instance whose history isn't in
        /// memory loads it, so live events keep it current from then on (after a restart nothing else
        /// may read it until a page is opened, and imports would go unnoticed).
        /// </summary>
        private void OnSnapshotChanged(ArrSnapshotChange change)
        {
            if (change.Kind == ArrSnapshotKind.Library)
            {
                if (RefreshEnabled && _store.PeekHistory(change.Instance.Id) == null) LoadHistory(change.Instance);
                return;
            }
            if (change.Kind != ArrSnapshotKind.History || change.After is not ArrHistorySnapshot after) return;
            if (!RefreshEnabled) return;
            var known = change.Before is ArrHistorySnapshot before ? new HashSet<int>(before.Records.Select(r => r.Id)) : null;
            var now = _now().UtcDateTime;
            foreach (var record in after.Records)
            {
                if (known != null && known.Contains(record.Id)) continue;
                if (!IsImport(record) || string.IsNullOrWhiteSpace(record.ImportedPath)) continue;
                // A replay needs the import's date to be sure it is recent.
                if (record.Date is DateTime at ? now - at > ImportWindow : known == null) continue;
                // The import record names this generation of the file: a later import of the same path is another one.
                var generation = change.Instance.Id + ":" + record.Id.ToString(CultureInfo.InvariantCulture);
                Enqueue(change.Instance, record.ImportedPath!, 0, known == null, generation, KeyOf(change.Instance.Kind, record.TmdbId, record.TvdbId, record.SeasonNumber, record.EpisodeNumber));
            }
        }

        /// <summary>Loads an instance's history in the background (once at a time per instance).</summary>
        private void LoadHistory(ArrConnection instance)
        {
            lock (_lock)
            {
                if (!_historyLoads.Add(instance.Id)) return;
            }
            var started = TryTrack(async () =>
            {
                try
                {
                    await _store.GetHistoryAsync(instance, _stop.Token).ConfigureAwait(false);
                }
                catch (Exception ex) when (ex is OperationCanceledException or ObjectDisposedException)
                {
                    // shutting down
                }
                catch (Exception ex)
                {
                    _logger?.Warning($"Jellyfin bridge: reading {instance.Name}'s history failed ({ex.GetType().Name}).");
                }
                finally
                {
                    lock (_lock) _historyLoads.Remove(instance.Id);
                }
            }, out _);
            // Refused (stopped): the work that would have cleared the guard never runs. Work that ran
            // clears it itself (a newer load may own it by now).
            if (!started) lock (_lock) _historyLoads.Remove(instance.Id);
        }

        /// <summary>Queues a targeted refresh of one imported file (arr path) of an instance, as one import (<paramref name="generation"/>).</summary>
        internal void Enqueue(ArrConnection instance, string arrPath, int waits, bool replay = false, string? generation = null, string? key = null)
        {
            bool schedule;
            lock (_lock)
            {
                // Stopped: nothing new is queued.
                if (_stopped || _pending.Count >= 500) return;
                _pending.Add(new Pending(instance, arrPath, waits, replay, generation, key));
                schedule = !_scheduled;
                _scheduled = true;
            }
            if (!schedule) return;
            _ = Track(() => DrainLaterAsync(Debounce));
        }

        private async Task DrainLaterAsync(TimeSpan wait)
        {
            try
            {
                await _delay(wait, _stop.Token).ConfigureAwait(false);
                List<Pending> batch;
                lock (_lock)
                {
                    batch = _pending.ToList();
                    _pending.Clear();
                    _scheduled = false;
                }
                if (!RefreshEnabled || batch.Count == 0) return;
                await RunBatchAsync(batch).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // shutting down
            }
            catch (Exception ex)
            {
                _logger?.Warning($"Jellyfin bridge: a targeted refresh failed ({ex.GetType().Name}: {ex.Message}).");
            }
        }

        /// <summary>
        /// Plans every queued file, then refreshes each folder once. A file in new folders (a new
        /// season folder) needs one refresh per level: the nearest folder Jellyfin has is validated
        /// non-recursively, which adds the new folder but doesn't look inside it, so the new folder is
        /// then validated in turn (at most <see cref="MaxLevels"/> levels).
        /// </summary>
        internal async Task RunBatchAsync(IReadOnlyList<Pending> batch)
        {
            if (_library.LibraryScanRunning)
            {
                // Jellyfin's own scan is walking the libraries; refresh after it (bounded).
                foreach (var p in batch)
                {
                    if (p.Waits >= MaxScanWaits)
                    {
                        Record(p.Instance, p.ArrPath, Map(p.Instance, p.ArrPath), null, null, "scan_running", false, 0, null);
                        continue;
                    }
                    lock (_lock) _pending.Add(p with { Waits = p.Waits + 1 });
                }
                bool schedule;
                lock (_lock)
                {
                    schedule = !_scheduled;
                    _scheduled = true;
                }
                if (schedule) _ = Track(() => DrainLaterAsync(ScanWait));
                return;
            }

            var libraries = _library.Libraries();
            // Every import Jellyfin doesn't list yet is held "Almost ready" from now on, before any refresh can add its
            // item; then the files get time to stop changing before Jellyfin reads them (a copy still being written is
            // never probed). The arr's import record stays what starts this; the samples only make sure it is finished.
            var steady = new List<string>();
            foreach (var p in batch)
            {
                var first = BridgePaths.Plan(Map(p.Instance, p.ArrPath), libraries, _library.FindByPath);
                if (first.Outcome is RefreshOutcome.OutsideLibrary or RefreshOutcome.Present) continue;
                BeginImport(first.File, p.Generation ?? NewGeneration(p.Instance), p.Key ?? ImportKey(p.Instance, p.ArrPath));
                steady.Add(first.File);
            }
            if (steady.Count > 0) await WaitStableAsync(steady).ConfigureAwait(false);
            // Files Jellyfin didn't list when the batch began: found later in it (a new series' hydration adds every file
            // of the folder at once) they are new arrivals, never upgrades to read again.
            var arriving = new HashSet<string>(steady, StringComparer.Ordinal);

            var handedOff = new HashSet<string>(StringComparer.Ordinal);
            var created = new Dictionary<string, JfCreatedItem?>(StringComparer.Ordinal);
            var work = batch.Select(p => (Item: p, File: Map(p.Instance, p.ArrPath), Ms: 0L)).ToList();
            for (var level = 0; work.Count > 0; level++)
            {
                var groups = new Dictionary<Guid, (RefreshPlan Plan, List<(Pending Item, string File, long Ms, RefreshPlan Plan)> Files, HashSet<string> Paths)>();
                var next = new List<(Pending Item, string File, long Ms)>();
                foreach (var (p, mapped, before) in work)
                {
                    var plan = BridgePaths.Plan(mapped, libraries, _library.FindByPath);
                    // The file as Jellyfin writes it (a Windows library folder's own casing).
                    var file = plan.File;
                    switch (plan.Outcome)
                    {
                        case RefreshOutcome.Refresh:
                            if (!groups.TryGetValue(plan.AncestorId!.Value, out var group))
                            {
                                group = (plan, new List<(Pending, string, long, RefreshPlan)>(), new HashSet<string>(StringComparer.Ordinal));
                                groups[plan.AncestorId.Value] = group;
                            }
                            if (group.Paths.Count == 0) foreach (var sibling in NewSiblings(plan)) group.Paths.Add(sibling);
                            group.Files.Add((p, file, before, plan));
                            foreach (var path in plan.RefreshPaths) group.Paths.Add(path);
                            break;
                        case RefreshOutcome.LibraryRoot when NewTopFolder(plan) is { } top:
                        {
                            // A brand-new series: that one folder is added on its own (never the library's folder).
                            if (!created.TryGetValue(top, out var made)) created[top] = made = CreateNewFolder(plan, top);
                            if (made == null)
                            {
                                LeaveToScan(p, file, plan, handedOff);
                                break;
                            }
                            if (made.Kind is not ("series" or "movie") && level + 1 < MaxLevels)
                            {
                                // A plain folder (a mixed library): its own refresh adds the file, next level.
                                next.Add((p, file, before));
                                break;
                            }
                            var has = _library.FindByPath(file) != null;
                            if (has) Interlocked.Increment(ref _found);
                            Record(p.Instance, p.ArrPath, file, plan.Ancestor, plan.AncestorKind, NewFolder, has, before, null);
                            // The file's item appears once the new series is hydrated (its episodes found inside it).
                            if (!has) Hydrate(p.Instance, p.ArrPath, file, null);
                            break;
                        }
                        case RefreshOutcome.LibraryRoot:
                        case RefreshOutcome.NoAncestor:
                            HandOff(p, file, plan, handedOff);
                            break;
                        case RefreshOutcome.Present when p.Replay:
                            // Replayed after a start and already listed: nothing to tell, but a skeleton (an item Jellyfin
                            // added without its metadata before the restart) is repaired.
                            Hydrate(p.Instance, p.ArrPath, file, null);
                            break;
                        case RefreshOutcome.Present:
                            // Already listed: an upgrade imported at the same path (or Jellyfin's own monitor came
                            // first). Jellyfin keeps the item and its old media info, so it reads the file again.
                            // An earlier import of it still held is replaced by this one (its follow-up stops; this one
                            // is published instead); an established item keeps its Ready while it is read again.
                            if (!arriving.Contains(file))
                            {
                                if (_readiness.Pending(Guid.Empty, file)) BeginImport(file, p.Generation ?? NewGeneration(p.Instance), p.Key ?? ImportKey(p.Instance, p.ArrPath));
                                if (plan.AncestorId is Guid present && plan.AncestorKind is "movie" or "episode") ReRead(present, file);
                            }
                            Record(p.Instance, p.ArrPath, file, plan.Ancestor, plan.AncestorKind, plan.Outcome, true, before, null);
                            break;
                        default:
                            Record(p.Instance, p.ArrPath, file, plan.Ancestor, plan.AncestorKind, plan.Outcome, plan.Outcome == RefreshOutcome.Present, before, null);
                            break;
                    }
                }

                foreach (var (folderId, (plan, files, paths)) in groups)
                {
                    // Wait for each file, or for the new folder it is in when that folder is new too.
                    var waitFor = files.Select(f => NextLevel(f.Plan) ?? f.File).Distinct(StringComparer.Ordinal).ToList();
                    var (_, ms, error, pending, off) = await RefreshAndWaitAsync(folderId, paths.ToList(), waitFor, RefreshBudget, RefreshBudget, false, _stop.Token).ConfigureAwait(false);
                    if (off)
                    {
                        foreach (var (item, file, before, _) in files) Record(item.Instance, item.ArrPath, file, plan.Ancestor, plan.AncestorKind, SwitchedOff, false, before + ms, null);
                        _logger?.Info($"Jellyfin bridge: targeted refresh was switched off; {plan.Ancestor} was not refreshed for {files.Count} imported file(s).");
                        continue;
                    }
                    var foundHere = 0;
                    foreach (var (item, file, before, own) in files)
                    {
                        var has = _library.FindByPath(file) != null;
                        if (!has && error == null && level + 1 < MaxLevels && NextLevel(own) is { } folder && _library.FindByPath(folder) is { IsFolder: true })
                        {
                            // Jellyfin added the new folder; the file inside it needs that folder's refresh.
                            next.Add((item, file, before + ms));
                            continue;
                        }
                        if (has)
                        {
                            foundHere++;
                            Interlocked.Increment(ref _found);
                        }
                        // Its metadata is judged once this refresh has ended (it reads the new item's metadata itself).
                        Record(item.Instance, item.ArrPath, file, plan.Ancestor, plan.AncestorKind, error == null ? RefreshOutcome.Refresh : "failed", has, before + ms, error, pending);
                        // Stopped waiting before the refresh ran or ended (one before it overran): the
                        // rest of the way once it has.
                        if (!has && error == null && pending != null) FollowThrough(pending, folderId, item.Instance, item.ArrPath, file, MaxLevels - level - 1, RefreshOutcome.Refresh, false);
                    }
                    if (error != null) _logger?.Warning($"Jellyfin bridge: refreshing {plan.Ancestor} failed ({error}).");
                    else _logger?.Info($"Jellyfin bridge: refreshed {plan.Ancestor} for {files.Count} imported file(s); {foundHere} in Jellyfin after {ms} ms.");
                }
                work = next;
            }
            lock (_lock) { _missingGeneration++; _missing = null; }
        }

        /// <summary>The new folder directly inside the plan's folder that holds the file (null when the file sits in that folder).</summary>
        private static string? NextLevel(RefreshPlan plan) => plan.RefreshPaths.Count > 1 ? plan.RefreshPaths[^1] : null;

        /// <summary>The new folder directly inside a library's own folder that holds the file (null when the file sits in that folder itself).</summary>
        private static string? NewTopFolder(RefreshPlan plan) => plan.Outcome == RefreshOutcome.LibraryRoot && plan.RefreshPaths.Count > 1 ? plan.RefreshPaths[^1] : null;

        /// <summary>
        /// A file whose nearest folder Jellyfin has is nothing at all (no item for its library's folder), or a TV (or
        /// mixed) library's root when it can't be added on its own: never refreshed by JE (that would re-validate every
        /// series). Without any item for the library's folder, a library with real-time monitoring gets the path reported
        /// to its monitor, as its own watcher would; otherwise the file is listed under "not in Jellyfin" (with Scan now)
        /// until the next library scan.
        /// </summary>
        private void HandOff(Pending p, string file, RefreshPlan plan, HashSet<string> handedOff)
        {
            var folder = plan.RefreshPaths.LastOrDefault() ?? file;
            if (plan.Outcome != RefreshOutcome.NoAncestor || plan.Library?.RealtimeMonitor != true)
            {
                LeaveToScan(p, file, plan, handedOff);
                return;
            }
            if (handedOff.Add(folder))
            {
                _library.ReportChanged(folder);
                _logger?.Info($"Jellyfin bridge: {file} needs a new folder in {plan.Ancestor}; left to Jellyfin's library monitor.");
            }
            Record(p.Instance, p.ArrPath, file, plan.Ancestor, plan.AncestorKind, plan.Outcome, false, 0, null);
        }

        /// <summary>A file JE can't bring in itself: left to Jellyfin's next library scan (and listed with Scan now); no longer held.</summary>
        private void LeaveToScan(Pending p, string file, RefreshPlan plan, HashSet<string> handedOff)
        {
            var folder = plan.RefreshPaths.LastOrDefault() ?? file;
            if (handedOff.Add(folder)) _logger?.Info($"Jellyfin bridge: {file} needs a new folder in {plan.Ancestor} that JE can't add on its own; left to Jellyfin's next library scan.");
            Record(p.Instance, p.ArrPath, file, plan.Ancestor, plan.AncestorKind, LeftToScan, false, 0, null);
            EndImport(file);
        }

        /// <summary>Outcome: a brand-new folder in a library's own folder was added on its own (never the library's folder).</summary>
        internal const string NewFolder = "new_folder";

        /// <summary>
        /// A file in a folder Jellyfin doesn't have, directly inside a TV (or mixed) library's own folder (a brand-new
        /// series): that one folder is added the way Jellyfin's scan would add it (its resolver reads only that folder,
        /// under the library's folder), whatever the library's real-time monitoring, and a new series then has its
        /// metadata read in full inside it (its seasons and episodes are found and hydrated there, nothing else). The
        /// library's own folder is never validated, scanned or reported to Jellyfin's monitor, so every other series stays
        /// untouched. One at a time per folder; when Jellyfin's monitor added it first, that item is used. Null when
        /// nothing resolves there.
        /// </summary>
        private JfCreatedItem? CreateNewFolder(RefreshPlan plan, string top)
        {
            lock (_lock)
            {
                if (!_creating.Add(top))
                {
                    var known = _library.FindByPath(top);
                    return known == null ? null : new JfCreatedItem(known.Id, known.Kind, false);
                }
            }
            try
            {
                var watch = Stopwatch.StartNew();
                JfCreatedItem? made;
                try
                {
                    made = _library.CreateChildFolder(plan.AncestorId!.Value, top);
                }
                catch (Exception ex) when (ex is not OutOfMemoryException)
                {
                    _logger?.Warning($"Jellyfin bridge: adding the new folder {top} failed ({ex.GetType().Name}: {ex.Message}).");
                    made = null;
                }
                if (made == null)
                {
                    _logger?.Info($"Jellyfin bridge: Jellyfin's resolver made nothing of the new folder {top}.");
                    return null;
                }
                _logger?.Info($"Jellyfin bridge: {(made.Created ? "added" : "found (Jellyfin's monitor came first)")} the new folder {top} as {made.Kind} {made.Id:N} in {watch.ElapsedMilliseconds} ms; only that folder was read ({plan.Ancestor} itself was not refreshed or scanned).");
                // A new series and everything in it are new: one hydration of the series, inside it.
                if (made.Kind == "series") AskHydration(made.Id, HydrationScope.SeriesTree, top);
                lock (_lock) { _missingGeneration++; _missing = null; }
                return made;
            }
            finally
            {
                lock (_lock) _creating.Remove(top);
            }
        }

        /// <summary>
        /// Everything directly inside the folder to refresh that Jellyfin doesn't have yet (at most 200).
        /// A refresh limited to some new paths still adds the other new files it finds there, but
        /// without their metadata (an episode without its season); so every new entry is looked at.
        /// </summary>
        private IEnumerable<string> NewSiblings(RefreshPlan plan)
        {
            if (plan.Ancestor == null) return Array.Empty<string>();
            return _library.Entries(plan.Ancestor).Select(BridgePaths.Norm).Where(e => _library.FindByPath(e) == null).Take(200).ToList();
        }

        /// <summary>
        /// Refreshes one folder (one refresh per folder at a time: a new one runs after the running
        /// one, which may have looked before the new file arrived, or joins the one already waiting) and
        /// waits until Jellyfin has every path in <paramref name="waitFor"/> (none: until the refresh ends), the refresh ends, or
        /// <paramref name="wait"/> passes from when the refresh started (it may first wait up to
        /// <paramref name="queueWait"/> behind the one before it). Jellyfin indexes a new file within a
        /// fraction of a second but may spend much longer fetching its metadata inside the same call;
        /// that part carries on in the background (bounded by <see cref="RefreshBudget"/>).
        /// Returns the paths found, how long it took to find them, an error when the refresh failed,
        /// and the refresh itself when it hadn't ended (<see cref="FollowThrough"/>).
        /// </summary>
        private async Task<(HashSet<string> Found, long Ms, string? Error, Task? Pending, bool Off)> RefreshAndWaitAsync(Guid folderId, IReadOnlyList<string> paths, IReadOnlyList<string> waitFor, TimeSpan wait, TimeSpan queueWait, bool manual, CancellationToken cancellationToken)
        {
            var watch = Stopwatch.StartNew();
            var queued = StartRefresh(folderId, paths, manual);
            var refresh = queued.Task!;
            var found = new HashSet<string>(StringComparer.Ordinal);
            long foundAt = 0;
            TimeSpan? startedAt = null;
            while (true)
            {
                foreach (var f in waitFor)
                {
                    if (!found.Contains(f) && _library.FindByPath(f) != null) found.Add(f);
                }
                // Nothing to wait for (an item being repaired): the refresh itself is waited for.
                var all = waitFor.Count > 0 && found.Count == waitFor.Count;
                if (all && foundAt == 0) foundAt = watch.ElapsedMilliseconds;
                // The wait counts from when this refresh started, not from when it was queued.
                if (startedAt == null && queued.Begun.Task.IsCompleted) startedAt = watch.Elapsed;
                var timedOut = startedAt is TimeSpan began ? watch.Elapsed - began >= wait : watch.Elapsed >= queueWait;
                if (all || refresh.IsCompleted || timedOut || cancellationToken.IsCancellationRequested) break;
                try
                {
                    await _delay(TimeSpan.FromMilliseconds(100), cancellationToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }
            string? error = null;
            if (refresh.IsFaulted) error = refresh.Exception!.GetBaseException() is var e ? e.GetType().Name + ": " + e.Message : null;
            else if (refresh.IsCanceled && !_stop.IsCancellationRequested) error = "The refresh ran out of time.";
            if (refresh.IsCompleted)
            {
                foreach (var f in waitFor)
                {
                    if (!found.Contains(f) && _library.FindByPath(f) != null) found.Add(f);
                }
            }
            return (found, foundAt > 0 ? foundAt : watch.ElapsedMilliseconds, error, refresh.IsCompleted ? null : refresh, refresh.IsCompleted && queued.SwitchedOff);
        }

        /// <summary>
        /// A caller stopped waiting for a folder refresh before it ran or ended (Scan now's answer goes
        /// back; an import batch moves on), with <paramref name="file"/> not in Jellyfin yet: once that
        /// refresh has ended, the file is carried the rest of the way in the background — the new
        /// folder that refresh added is refreshed in turn, up to <paramref name="levels"/> more levels.
        /// </summary>
        private void FollowThrough(Task refresh, Guid folderId, ArrConnection instance, string arrPath, string file, int levels, string outcome, bool manual)
        {
            if (levels <= 0) return;
            _ = Track(async () =>
            {
                try
                {
                    await refresh.ConfigureAwait(false);
                }
                catch (Exception)
                {
                    // However it ended: the file is looked for again.
                }
                await FollowThroughAsync(folderId, instance, arrPath, file, levels, outcome, manual).ConfigureAwait(false);
            });
        }

        private async Task FollowThroughAsync(Guid folderId, ArrConnection instance, string arrPath, string file, int levels, string outcome, bool manual)
        {
            try
            {
                var plan = BridgePaths.Plan(file, _library.Libraries(), _library.FindByPath);
                // Found meanwhile, or nothing deeper to refresh (the refresh didn't add the next folder).
                if (plan.Outcome == RefreshOutcome.Present)
                {
                    Interlocked.Increment(ref _found);
                    Record(instance, arrPath, file, BridgePaths.Parent(file), null, outcome, true, 0, null);
                    lock (_lock) { _missingGeneration++; _missing = null; }
                }
                if (plan.Outcome != RefreshOutcome.Refresh || plan.AncestorId == folderId || _stop.IsCancellationRequested) return;
                // An import's follow-through needs targeted refresh on; Scan now's needs phase 2 on.
                if (!Allowed(manual))
                {
                    Record(instance, arrPath, file, plan.Ancestor, plan.AncestorKind, SwitchedOff, false, 0, null);
                    return;
                }
                var paths = NewSiblings(plan).Concat(plan.RefreshPaths).Distinct(StringComparer.Ordinal).ToList();
                var (_, ms, error, pending, off) = await RefreshAndWaitAsync(plan.AncestorId!.Value, paths, new[] { NextLevel(plan) ?? file }, RefreshBudget, RefreshBudget, manual, _stop.Token).ConfigureAwait(false);
                if (off)
                {
                    Record(instance, arrPath, file, plan.Ancestor, plan.AncestorKind, SwitchedOff, false, ms, null);
                    return;
                }
                var has = _library.FindByPath(file) != null;
                if (has) Interlocked.Increment(ref _found);
                Record(instance, arrPath, file, plan.Ancestor, plan.AncestorKind, error == null ? outcome : "failed", has, ms, error);
                lock (_lock) { _missingGeneration++; _missing = null; }
                if (has || error != null) return;
                if (pending != null) FollowThrough(pending, plan.AncestorId!.Value, instance, arrPath, file, levels - 1, outcome, manual);
                else if (levels > 1 && NextLevel(plan) != null) await FollowThroughAsync(plan.AncestorId!.Value, instance, arrPath, file, levels - 1, outcome, manual).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                _logger?.Warning($"Jellyfin bridge: following {file} through failed ({ex.GetType().Name}: {ex.Message}).");
            }
        }

        /// <summary>
        /// Queues a refresh of one folder, in one step under the lock: at most one refresh of a
        /// folder runs and at most one waits behind it. A request while one is already waiting (not
        /// started) joins it (its paths are added) instead of queueing another, so refreshes of one
        /// folder never overlap however long one takes: Jellyfin's <c>ValidateChildren</c> has no
        /// lock of its own. The waiting one starts only when the running one has ended (each is
        /// bounded by <see cref="RefreshBudget"/> through cancellation).
        /// </summary>
        private QueuedRefresh StartRefresh(Guid folderId, IReadOnlyList<string> paths, bool manual)
        {
            lock (_lock)
            {
                if (_waiting.TryGetValue(folderId, out var waiting) && !waiting.Started)
                {
                    foreach (var path in paths)
                    {
                        if (!waiting.Paths.Contains(path, StringComparer.Ordinal)) waiting.Paths.Add(path);
                    }

                    waiting.Manual |= manual;
                    return waiting;
                }

                _running.TryGetValue(folderId, out var previous);
                var queued = new QueuedRefresh(paths) { Manual = manual };
                queued.Task = Track(() => RefreshAfterAsync(previous, folderId, queued));

                var refresh = queued.Task;
                _running[folderId] = refresh;
                if (previous != null && !previous.IsCompleted) _waiting[folderId] = queued;
                _ = refresh.ContinueWith(
                    t =>
                    {
                        lock (_lock)
                        {
                            if (_running.TryGetValue(folderId, out var current) && ReferenceEquals(current, t)) _running.Remove(folderId);
                            if (_waiting.TryGetValue(folderId, out var w) && ReferenceEquals(w, queued)) _waiting.Remove(folderId);
                        }

                        // Ended without starting (the bridge stopped): nobody waits for a start.
                        queued.Begun.TrySetResult();
                    },
                    CancellationToken.None,
                    TaskContinuationOptions.None,
                    TaskScheduler.Default);
                return queued;
            }
        }

        /// <summary>
        /// Waits for the folder's previous refresh to end (however it ends; never a timeout, so two
        /// never overlap), then refreshes it with every path gathered meanwhile, within
        /// <see cref="RefreshBudget"/>.
        /// </summary>
        private async Task RefreshAfterAsync(Task? previous, Guid folderId, QueuedRefresh queued)
        {
            if (previous != null)
            {
                try
                {
                    await previous.WaitAsync(_stop.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (_stop.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception)
                {
                    // Cancelled or failed (recorded when it ran): this refresh runs regardless.
                }
            }

            List<string> paths;
            bool manual;
            lock (_lock)
            {
                queued.Started = true;
                if (_waiting.TryGetValue(folderId, out var w) && ReferenceEquals(w, queued)) _waiting.Remove(folderId);
                paths = queued.Paths.ToList();
                manual = queued.Manual;
            }

            queued.Begun.TrySetResult();

            // The switches are checked when the refresh is about to run, not when it was asked for:
            // one that waited behind a slow refresh while its switch was turned off doesn't run.
            if (!Allowed(manual))
            {
                queued.SwitchedOff = true;
                return;
            }

            using var budget = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token);
            budget.CancelAfter(RefreshBudget);
            // Every folder refresh run counts (after imports and Scan now alike; requests that joined
            // a waiting one share its run), so the System tab's summary and its list agree.
            Interlocked.Increment(ref _refreshes);
            await _library.RefreshFolderAsync(folderId, paths, budget.Token).ConfigureAwait(false);
        }

        /// <summary>A folder refresh waiting for the running one; requests made meanwhile add their paths (under the bridge's lock).</summary>
        private sealed class QueuedRefresh
        {
            public QueuedRefresh(IReadOnlyList<string> paths) => Paths = paths.Distinct(StringComparer.Ordinal).ToList();

            public List<string> Paths { get; }

            public bool Started { get; set; }

            /// <summary>Asked for by an administrator (Scan now) and not only after imports (under the bridge's lock).</summary>
            public bool Manual { get; set; }

            /// <summary>Not run: its switch was off when its turn came.</summary>
            public bool SwitchedOff { get; set; }

            /// <summary>Completes when the refresh starts running (or ends without running).</summary>
            public TaskCompletionSource Begun { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

            public Task? Task { get; set; }
        }

        /// <summary>
        /// Asks Jellyfin to read a movie or episode again whose file was imported at the path it already has (an
        /// upgrade): its media info, dimensions and versions are re-read, so the new file's resolution counts (a 4K
        /// request, the version picker). Once per item within <see cref="ReReadWindow"/> (Sonarr reports a
        /// multi-episode file once per episode).
        /// </summary>
        private void ReRead(Guid itemId, string file)
        {
            var now = _now();
            lock (_lock)
            {
                if (_rereadAt.TryGetValue(itemId, out var at) && now - at < ReReadWindow) return;
                if (_rereadAt.Count >= 200)
                {
                    foreach (var old in _rereadAt.Where(kv => now - kv.Value >= ReReadWindow).Select(kv => kv.Key).ToList()) _rereadAt.Remove(old);
                }
                _rereadAt[itemId] = now;
            }
            try
            {
                if (_library.QueueFileRefresh(itemId)) _logger?.Info($"Jellyfin bridge: {file} was imported again at the same path; asked Jellyfin to read it again.");
            }
            catch (Exception ex)
            {
                _logger?.Warning($"Jellyfin bridge: asking Jellyfin to read {file} again failed ({ex.GetType().Name}).");
            }
        }

        /// <summary>How long one item's re-read stands for further imports of the same file.</summary>
        internal static readonly TimeSpan ReReadWindow = TimeSpan.FromMinutes(2);

        private void Record(ArrConnection instance, string arrPath, string file, string? folder, string? kind, string outcome, bool found, long ms, string? error, Task? owner = null)
        {
            // Listed is not ready: its metadata is read back (after the refresh that added it) and repaired when needed; it
            // is held by its item id from here on (before anything hears that it was found).
            if (found) Hydrate(instance, arrPath, file, owner);
            lock (_lock)
            {
                _recent.AddFirst(new BridgeRefresh
                {
                    At = _now(), Instance = instance.Name, ArrPath = arrPath, JellyfinPath = file, Folder = folder, FolderKind = kind,
                    Outcome = outcome, Found = found, Ms = ms, Error = error,
                });
                while (_recent.Count > RecentSize) _recent.RemoveLast();
            }
            if (!found) return;
            RemoveMissingTwins(file);
            RaiseIndexed(instance, arrPath);
        }

        /// <summary>
        /// Jellyfin keeps listing a missing (virtual) episode for a slot a file now fills until its next
        /// series refresh, which removes it ("a physical episode now exists for this slot"). A targeted
        /// refresh of a season folder doesn't refresh the series, so the bridge removes those by Jellyfin's
        /// own rule: the season, Next up and an open page of the missing episode then have the one that plays.
        /// Jellyfin numbers the new episode a moment after adding it; until then the bridge looks again
        /// after each of <see cref="MissingTwinWaits"/>. A file is handled once at a time (Sonarr reports a
        /// multi-episode file once per episode).
        /// </summary>
        private void RemoveMissingTwins(string file)
        {
            lock (_lock)
            {
                if (!_twinFiles.Add(file)) return;
            }
            RemoveMissingTwins(file, 0);
        }

        private void RemoveMissingTwins(string file, int attempt)
        {
            var again = false;
            try
            {
                int removed;
                try
                {
                    removed = _library.RemoveMissingTwins(file);
                }
                catch (Exception ex)
                {
                    _logger?.Warning($"Jellyfin bridge: removing the missing episode {file} fills failed ({ex.GetType().Name}).");
                    return;
                }
                if (removed > 0) _logger?.Info($"Jellyfin bridge: removed {removed} missing (virtual) episode(s) that {file} now fills.");
                if (removed >= 0 || attempt >= MissingTwinWaits.Length) return;
                var wait = MissingTwinWaits[attempt];
                again = TryTrack(async () =>
                {
                    try
                    {
                        await _delay(wait, _stop.Token).ConfigureAwait(false);
                    }
                    catch (Exception ex) when (ex is OperationCanceledException or ObjectDisposedException)
                    {
                        Done(file);
                        return;
                    }
                    if (RefreshEnabled) RemoveMissingTwins(file, attempt + 1);
                    else Done(file);
                }, out _);
            }
            finally
            {
                if (!again) Done(file);
            }

            void Done(string path)
            {
                lock (_lock) _twinFiles.Remove(path);
            }
        }

        // ------------------------------------------------------------------ readiness: stable files, hydration, Ready

        /// <summary>A new import generation for a file an arr record doesn't name (Scan now, a repair).</summary>
        private string NewGeneration(ArrConnection instance)
            => instance.Id + ":je" + Interlocked.Increment(ref _generationSeq).ToString(CultureInfo.InvariantCulture) + "@" + _now().UtcTicks.ToString(CultureInfo.InvariantCulture);

        /// <summary>The title key of an imported file, from the instance's history in memory (the import record).</summary>
        private string? ImportKey(ArrConnection instance, string arrPath)
        {
            var record = _store.PeekHistory(instance.Id)?.Records.FirstOrDefault(r => IsImport(r) && string.Equals(r.ImportedPath, arrPath, StringComparison.Ordinal));
            return record == null ? null : KeyOf(instance.Kind, record.TmdbId, record.TvdbId, record.SeasonNumber, record.EpisodeNumber);
        }

        /// <summary>
        /// Holds one import of <paramref name="file"/> as "Almost ready" (<see cref="BridgeImportReadiness"/>) from now on,
        /// before Jellyfin is asked for anything that could add its item.
        /// </summary>
        private void BeginImport(string file, string generation, string? key)
        {
            _readiness.MaxHold = MetadataWait + TimeSpan.FromMinutes(5);
            _readiness.Begin(file, generation, key);
            lock (_lock)
            {
                if (_imports.Count >= 500 && !_imports.ContainsKey(file)) _imports.Remove(_imports.Keys.First());
                _imports[file] = (generation, key);
            }
            _logger?.Info($"Jellyfin bridge: import {generation} of {file}{(key != null ? " (" + key + ")" : string.Empty)} is held as Almost ready until its metadata is read back.");
        }

        /// <summary>Stops holding the current import of <paramref name="file"/> without publishing it (JE can't bring it in; nothing to call Ready).</summary>
        private void EndImport(string file)
        {
            string generation;
            lock (_lock)
            {
                if (!_imports.Remove(file, out var import)) return;
                generation = import.Generation;
            }
            _readiness.Drop(file, generation);
        }

        /// <summary>
        /// Waits until every file keeps its size and last write across <see cref="StableQuiet"/> (looked at twice, from a
        /// fresh look at the disk; looked at again while either changes), at most <see cref="StableMaxWait"/>. A file
        /// Jellyfin's process can't see isn't waited for (the plan and the "not in Jellyfin" list explain it).
        /// </summary>
        private async Task WaitStableAsync(IReadOnlyList<string> files)
        {
            var quiet = StableQuiet;
            if (quiet <= TimeSpan.Zero) return;
            var watch = Stopwatch.StartNew();
            var last = new Dictionary<string, (long, DateTime)>(StringComparer.Ordinal);
            foreach (var f in files.Distinct(StringComparer.Ordinal))
            {
                if (_library.FileStamp(f) is { } stamp) last[f] = stamp;
            }
            var changing = last.Keys.ToList();
            var told = false;
            while (changing.Count > 0)
            {
                await _delay(quiet, _stop.Token).ConfigureAwait(false);
                var still = new List<string>();
                foreach (var f in changing)
                {
                    if (_library.FileStamp(f) is not { } now) continue;
                    if (now != last[f]) still.Add(f);
                    last[f] = now;
                }
                if (still.Count == 0) break;
                if (watch.Elapsed >= StableMaxWait)
                {
                    _logger?.Warning($"Jellyfin bridge: {still.Count} imported file(s) still changing after {(long)watch.Elapsed.TotalSeconds} s (first: {still[0]}); asking Jellyfin to read them anyway.");
                    break;
                }
                if (!told) _logger?.Info($"Jellyfin bridge: {still[0]}{(still.Count > 1 ? $" and {still.Count - 1} more" : string.Empty)} still changing; waiting for it to stop before Jellyfin reads it.");
                told = true;
                changing = still;
            }
            if (told) _logger?.Info($"Jellyfin bridge: imported file(s) stopped changing after {watch.ElapsedMilliseconds} ms.");
        }

        /// <summary>
        /// Asks Jellyfin for one hydration of an item (<see cref="IJellyfinLibraryAccess.QueueHydration"/>), once per item per
        /// <see cref="HydrationAttemptTimeout"/> whichever job asks. Returns when it was asked (now, or by the earlier ask
        /// still running), or null when Jellyfin refused it.
        /// </summary>
        private DateTime? AskHydration(Guid itemId, HydrationScope scope, string label)
        {
            var now = DateTime.UtcNow;
            lock (_lock)
            {
                if (_hydrationAsked.TryGetValue(itemId, out var earlier) && now - earlier.At < HydrationAttemptTimeout) return earlier.At;
                if (_hydrationAsked.Count >= 500)
                {
                    foreach (var old in _hydrationAsked.Where(kv => now - kv.Value.At >= HydrationAttemptTimeout).Select(kv => kv.Key).ToList()) _hydrationAsked.Remove(old);
                }
                _hydrationAsked[itemId] = (now, scope);
            }
            bool queued;
            try
            {
                queued = _library.QueueHydration(itemId, scope);
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                _logger?.Warning($"Jellyfin bridge: asking Jellyfin to read {label}'s metadata failed ({ex.GetType().Name}: {ex.Message}).");
                queued = false;
            }
            if (!queued)
            {
                lock (_lock) _hydrationAsked.Remove(itemId);
                return null;
            }
            _logger?.Info($"Jellyfin bridge: asked Jellyfin to read {label}'s metadata in full ({scope}, item {itemId:N}: metadata and images FullRefresh, title and overview replaced, locked fields and existing artwork kept, high priority).");
            return now;
        }

        /// <summary>When a hydration of the item with <paramref name="scope"/> was asked for and may still be running (any job's), or null.</summary>
        private DateTime? Asked(Guid itemId, HydrationScope scope)
        {
            lock (_lock) return _hydrationAsked.TryGetValue(itemId, out var asked) && asked.Scope == scope && DateTime.UtcNow - asked.At < HydrationAttemptTimeout ? asked.At : null;
        }

        /// <summary>
        /// Follows one listed (or about to be listed) imported file until it is Ready: in the background, one job per import.
        /// <paramref name="owner"/> is the folder refresh that added it, still running: it reads the new item's metadata
        /// itself, so the item is judged only once it has ended (however it ended). An import the gate doesn't hold (an item
        /// already listed: a restart's replay, an upgrade, Scan now) is only repaired when it is a skeleton.
        /// </summary>
        private void Hydrate(ArrConnection instance, string arrPath, string file, Task? owner)
        {
            string generation;
            string? key;
            bool held;
            lock (_lock)
            {
                if (_imports.TryGetValue(file, out var import))
                {
                    (generation, key) = import;
                    held = true;
                }
                else
                {
                    generation = NewGeneration(instance);
                    key = null;
                    held = false;
                }
            }
            held = held && _readiness.Following(file, generation);
            // Held by its item id too from the moment Jellyfin lists it (not only by its path), while the refresh that
            // added it still runs.
            if (held && _library.FindByPath(file) is { } listed) _readiness.Attach(file, generation, listed.Id);
            key ??= ImportKey(instance, arrPath);
            var job = file + "\n" + generation;
            lock (_lock)
            {
                if (!_hydrationJobs.Add(job)) return;
            }
            var started = TryTrack(async () =>
            {
                try
                {
                    await HydrateAsync(file, generation, key, held, owner).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    // shutting down
                }
                catch (Exception ex) when (ex is not OutOfMemoryException)
                {
                    _logger?.Warning($"Jellyfin bridge: following {file}'s metadata failed ({ex.GetType().Name}: {ex.Message}).");
                }
                finally
                {
                    lock (_lock) _hydrationJobs.Remove(job);
                }
            }, out _);
            if (!started) lock (_lock) _hydrationJobs.Remove(job);
        }

        /// <summary>
        /// The readiness loop of one import: reads the item back every <see cref="HydrationPoll"/>; publishes it Ready once
        /// its metadata is complete (<see cref="BridgeHydration"/>); otherwise asks for a hydration of what is missing (its
        /// series' own metadata, the movie or episode itself) at most three times with backoff, never beside a hydration
        /// still running for it (a new series' own hydration reaches its episodes); publishes it with what is missing once
        /// the hydrations ended with only optional artwork or text missing, once the asks are used up, or after the wait
        /// (<see cref="MetadataWait"/>). A newer import of the same file takes over (this one stops).
        /// </summary>
        private async Task HydrateAsync(string file, string generation, string? key, bool held, Task? owner)
        {
            var watch = Stopwatch.StartNew();
            if (owner != null)
            {
                try
                {
                    await owner.WaitAsync(_stop.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (_stop.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception)
                {
                    // However it ended (a fault after Jellyfin added the item included): the item is judged now.
                }
            }
            var maxRounds = 1 + HydrationBackoff.Length;
            var rounds = 0;
            // This job's last round: what it asked for and when (UTC, as Jellyfin stamps a refresh that ended without a failure).
            var asked = new List<(Guid Id, DateTime At)>();
            TimeSpan roundAt = TimeSpan.Zero;
            var seen = false;
            string? lastSaid = null;
            while (true)
            {
                _stop.Token.ThrowIfCancellationRequested();
                if (held && !_readiness.Following(file, generation))
                {
                    _logger?.Info($"Jellyfin bridge: import {generation} of {file} was replaced by a newer import; its follow-up stops.");
                    return;
                }
                var item = _library.FindByPath(file);
                var facts = item == null ? null : _library.ReadFacts(item.Id);
                if (facts == null)
                {
                    if (watch.Elapsed >= MetadataWait)
                    {
                        if (held) EndImport(file);
                        _logger?.Info($"Jellyfin bridge: {file} still isn't in Jellyfin after {(long)watch.Elapsed.TotalSeconds} s; no longer held (listed under not in Jellyfin).");
                        return;
                    }
                    await _delay(HydrationPoll, _stop.Token).ConfigureAwait(false);
                    continue;
                }
                if (!seen)
                {
                    seen = true;
                    lock (_lock) { _missingGeneration++; _missing = null; }
                }
                var judged = BridgeHydration.Judge(facts);
                if (!held)
                {
                    // Already listed before this import was followed: only a skeleton is repaired (and held meanwhile).
                    if (!judged.Skeletal) return;
                    BeginImport(file, generation, key);
                    held = true;
                    _logger?.Info($"Jellyfin bridge: {file} is in Jellyfin without its metadata ({judged.Describe()}); repairing it.");
                }
                _readiness.Attach(file, generation, facts.Id);
                if (judged.Complete)
                {
                    Publish(file, generation, key, null, watch.Elapsed, rounds);
                    return;
                }
                var said = judged.Describe();
                if (said != lastSaid)
                {
                    _logger?.Info($"Jellyfin bridge: readiness of {file} ({facts.Kind} {facts.Id:N}) after {watch.ElapsedMilliseconds} ms: missing {said}.");
                    _readiness.Note(file, generation, "missing " + said);
                    lastSaid = said;
                }

                // The last round ended: everything it asked for was refreshed without a failure since, or its time ran out.
                var settled = asked.All(a => Refreshed(a.Id, facts) is DateTime r && r >= a.At) || watch.Elapsed - roundAt >= HydrationAttemptTimeout;
                // A new series' own hydration (asked when JE added it) reaches this episode: it is the first round.
                var tree = facts.Kind == "episode" && !facts.SeriesId.Equals(Guid.Empty) ? Asked(facts.SeriesId, HydrationScope.SeriesTree) : null;
                var treeRunning = tree is DateTime t && !(facts.LastRefreshed >= t);
                if (judged.OnlySoftMissing && !treeRunning && rounds > 0 && settled)
                {
                    // Everything it needs is there; one full hydration later, what is still missing the provider doesn't have.
                    Publish(file, generation, key, said, watch.Elapsed, rounds);
                    return;
                }
                if (watch.Elapsed >= MetadataWait || (rounds >= maxRounds && settled && !treeRunning))
                {
                    Publish(file, generation, key, "metadata pending: " + said, watch.Elapsed, rounds);
                    return;
                }
                var due = rounds == 0 || watch.Elapsed - roundAt >= HydrationBackoff[Math.Min(rounds - 1, HydrationBackoff.Length - 1)];
                if (!treeRunning && settled && due && rounds < maxRounds)
                {
                    asked.Clear();
                    var seriesMissing = judged.Missing.Any(m => m.StartsWith("series ", StringComparison.Ordinal));
                    // The series' own title, overview and poster: its own metadata only (its other episodes are left as they are).
                    if (seriesMissing && facts.Series != null && AskHydration(facts.SeriesId, HydrationScope.ItemOnly, "the series of " + file) is DateTime s1) asked.Add((facts.SeriesId, s1));
                    var ownMissing = judged.Missing.Concat(judged.SoftMissing).Any(m => !m.StartsWith("series ", StringComparison.Ordinal));
                    if (ownMissing && AskHydration(facts.Id, HydrationScope.Item, file) is DateTime s2) asked.Add((facts.Id, s2));
                    rounds++;
                    roundAt = watch.Elapsed;
                }
                await _delay(HydrationPoll, _stop.Token).ConfigureAwait(false);
            }
        }

        /// <summary>When an item this job asked about was last refreshed without a failure: the item itself or its series.</summary>
        private static DateTime? Refreshed(Guid id, JfItemFacts facts)
            => id.Equals(facts.Id) ? facts.LastRefreshed : facts.Series != null && id.Equals(facts.Series.Id) ? facts.Series.LastRefreshed : facts.LastRefreshed;

        /// <summary>Publishes one import Ready (once; only the file's current import), logs how long it took and wakes what waits for it.</summary>
        private void Publish(string file, string generation, string? key, string? missing, TimeSpan took, int rounds)
        {
            if (!_readiness.Release(file, generation, missing)) return;
            lock (_lock)
            {
                if (_imports.TryGetValue(file, out var import) && import.Generation == generation) _imports.Remove(file);
            }
            if (missing == null) _logger?.Info($"Jellyfin bridge: {file} has its metadata after {(long)took.TotalMilliseconds} ms ({rounds} hydration round(s) asked); published Ready.");
            else _logger?.Info($"Jellyfin bridge: {file} published Ready after {(long)took.TotalMilliseconds} ms with {missing} ({rounds} hydration round(s) asked).");
            if (key == null) return;
            try
            {
                Hydrated?.Invoke(key);
            }
            catch (Exception ex)
            {
                _logger?.Warning($"Jellyfin bridge: telling others about a Ready import failed ({ex.GetType().Name}).");
            }
        }

        /// <summary>
        /// Raised with the title key of an imported file once its metadata was read back and it was published Ready (or
        /// published after the bounded wait): what waits for the title (the notifications' Ready and new-episode checks)
        /// looks again. Unlike <see cref="Indexed"/>, this is the moment it may count as Ready. Handlers must be quick.
        /// </summary>
        public event Action<string>? Hydrated;

        /// <summary>
        /// Raised with the title key of an imported file (movie, or the episode's key) once Jellyfin
        /// has an item for it after a refresh, so what waits for the title (the notifications' Ready
        /// and new-episode checks) looks again at once instead of waiting for Jellyfin's metadata
        /// events. Handlers run on the refresh's thread and must be quick.
        /// </summary>
        public event Action<string>? Indexed;

        // The title of an imported file, from the instance's history in memory (the import record).
        private void RaiseIndexed(ArrConnection instance, string arrPath)
        {
            var handler = Indexed;
            if (handler == null) return;
            try
            {
                var record = _store.PeekHistory(instance.Id)?.Records.FirstOrDefault(r => IsImport(r) && string.Equals(r.ImportedPath, arrPath, StringComparison.Ordinal));
                if (record == null || KeyOf(instance.Kind, record.TmdbId, record.TvdbId, record.SeasonNumber, record.EpisodeNumber) is not { } key) return;
                handler(key);
            }
            catch (Exception ex)
            {
                _logger?.Warning($"Jellyfin bridge: telling others about an indexed file failed ({ex.GetType().Name}).");
            }
        }

        /// <summary>An arr path as Jellyfin sees it, through the instance's path mappings.</summary>
        internal static string Map(ArrConnection instance, string arrPath)
            => BridgePaths.Map(arrPath, instance.PathMappings.ToList()).Path;

        private static bool IsImport(ArrHistoryEntry h)
            => h.EventType != null && h.EventType.EndsWith("Imported", StringComparison.OrdinalIgnoreCase);

        /// <summary>An import, a deleted file or a renamed file (grabs, failures and ignored downloads leave the file as it was).</summary>
        private static bool ChangesFile(ArrHistoryEntry h)
            => h.EventType != null && (h.EventType.EndsWith("Imported", StringComparison.OrdinalIgnoreCase)
                || h.EventType.EndsWith("FileDeleted", StringComparison.OrdinalIgnoreCase)
                || h.EventType.EndsWith("FileRenamed", StringComparison.OrdinalIgnoreCase));

        // ------------------------------------------------------------------ Scan now

        /// <summary>
        /// Scan now for one arr path (a file or folder) of an instance: refuses paths outside every
        /// Jellyfin library; refreshes the nearest folder Jellyfin has; adds a brand-new folder of a TV
        /// (or mixed) library on its own (never a scan of that library); and has the file's metadata
        /// read back and repaired (an item Jellyfin lists without its title, overview or artwork).
        /// </summary>
        public async Task<BridgeScanResult> ScanNowAsync(ArrConnection instance, string arrPath, CancellationToken cancellationToken)
        {
            var plan = BridgePaths.Plan(Map(instance, arrPath), _library.Libraries(), _library.FindByPath);
            var file = plan.File;
            var repair = false;
            switch (plan.Outcome)
            {
                case RefreshOutcome.OutsideLibrary:
                    return new BridgeScanResult { Outcome = "refused", Reason = "outside_library" };
                case RefreshOutcome.Present:
                {
                    // Jellyfin has an item at the path: refresh it from its folder anyway (an admin asked;
                    // an item added without its metadata, e.g. an episode without its season, is repaired).
                    var again = BridgePaths.Plan(file, _library.Libraries(), path => path == file ? null : _library.FindByPath(path));
                    if (again.Outcome != RefreshOutcome.Refresh)
                    {
                        // Nothing to refresh it from: its metadata is still read back and repaired when it is a skeleton.
                        Hydrate(instance, arrPath, file, null);
                        return new BridgeScanResult { Outcome = "present", Library = plan.Library?.Name, Found = true };
                    }
                    plan = again;
                    repair = true;
                    goto case RefreshOutcome.Refresh;
                }
                case RefreshOutcome.Refresh:
                {
                    // A file Jellyfin doesn't list yet is held "Almost ready" until its metadata is read back.
                    if (!repair) BeginImport(file, NewGeneration(instance), ImportKey(instance, arrPath));
                    // One level at a time: a new folder is added by its parent's refresh, then refreshed itself.
                    long ms = 0;
                    string? error = null;
                    var found = false;
                    var switchedOff = false;
                    for (var level = 0; ; level++)
                    {
                        var paths = NewSiblings(plan).Concat(plan.RefreshPaths).Distinct(StringComparer.Ordinal).ToList();
                        var (_, took, failure, pending, off) = await RefreshAndWaitAsync(plan.AncestorId!.Value, paths, repair ? Array.Empty<string>() : new[] { NextLevel(plan) ?? file }, ScanNowWait, ScanNowQueueWait, true, cancellationToken).ConfigureAwait(false);
                        ms += took;
                        error = failure;
                        if (off)
                        {
                            switchedOff = true;
                            break;
                        }
                        found = _library.FindByPath(file) != null;
                        if (!found && error == null && pending != null)
                        {
                            // The refresh hadn't run or ended in time (one before it overran): the answer
                            // goes back now; the file is followed through once it has.
                            FollowThrough(pending, plan.AncestorId!.Value, instance, arrPath, file, MaxLevels - level - 1, "scan_now", true);
                            break;
                        }
                        if (found || error != null || level + 1 >= MaxLevels || NextLevel(plan) == null || cancellationToken.IsCancellationRequested) break;
                        var deeper = BridgePaths.Plan(file, _library.Libraries(), _library.FindByPath);
                        if (deeper.Outcome != RefreshOutcome.Refresh || deeper.AncestorId == plan.AncestorId) break;
                        plan = deeper;
                    }
                    if (found) Interlocked.Increment(ref _found);
                    Record(instance, arrPath, file, plan.Ancestor, plan.AncestorKind, switchedOff ? SwitchedOff : error == null ? "scan_now" : "failed", found, ms, error);
                    lock (_lock) { _missingGeneration++; _missing = null; }
                    return new BridgeScanResult { Outcome = "refreshed", Library = plan.Library?.Name, Folder = plan.Ancestor, Found = found };
                }
                case RefreshOutcome.LibraryRoot when NewTopFolder(plan) is { } top:
                {
                    // A brand-new series: that one folder is added on its own and hydrated inside it (never a library scan).
                    if (!Enabled) return new BridgeScanResult { Outcome = "refused", Reason = SwitchedOff };
                    BeginImport(file, NewGeneration(instance), ImportKey(instance, arrPath));
                    var made = CreateNewFolder(plan, top);
                    if (made == null)
                    {
                        EndImport(file);
                        Record(instance, arrPath, file, plan.Ancestor, plan.AncestorKind, "failed", false, 0, "Jellyfin could not add the new folder.");
                        return new BridgeScanResult { Outcome = "refused", Reason = "not_resolved" };
                    }
                    if (made.Kind is not ("series" or "movie"))
                    {
                        // A plain folder (a mixed library): refreshed in turn like any folder Jellyfin has.
                        var deeper = BridgePaths.Plan(file, _library.Libraries(), _library.FindByPath);
                        if (deeper.Outcome == RefreshOutcome.Refresh)
                        {
                            plan = deeper;
                            goto case RefreshOutcome.Refresh;
                        }
                    }
                    var watch = Stopwatch.StartNew();
                    Hydrate(instance, arrPath, file, null);
                    // The episode appears once the new series' own hydration has found it (inside the series).
                    while (_library.FindByPath(file) == null && watch.Elapsed < ScanNowWait && !cancellationToken.IsCancellationRequested)
                    {
                        try
                        {
                            await _delay(TimeSpan.FromMilliseconds(250), cancellationToken).ConfigureAwait(false);
                        }
                        catch (OperationCanceledException)
                        {
                            break;
                        }
                    }
                    var has = _library.FindByPath(file) != null;
                    if (has) Interlocked.Increment(ref _found);
                    Record(instance, arrPath, file, plan.Ancestor, plan.AncestorKind, NewFolder, has, watch.ElapsedMilliseconds, null);
                    lock (_lock) { _missingGeneration++; _missing = null; }
                    return new BridgeScanResult { Outcome = "added", Library = plan.Library?.Name, Folder = top, Found = has };
                }
                default:
                    // No item for the library's folder, or a file loose in a TV library's own folder: JE never scans a
                    // library for it (that re-validates every series); Jellyfin's own scan picks it up.
                    Record(instance, arrPath, file, plan.Ancestor, plan.AncestorKind, LeftToScan, false, 0, null);
                    return new BridgeScanResult { Outcome = "refused", Library = plan.Library?.Name, Reason = plan.Outcome };
            }
        }

        // ------------------------------------------------------------------ in the arr, not in Jellyfin

        /// <summary>
        /// Recent imports (last 7 days, the newest file event per movie/episode still the import) whose file
        /// Jellyfin has no item for, from the history snapshots in memory. Cached for 15 seconds.
        /// </summary>
        public IReadOnlyList<BridgeMissing> NotInJellyfin()
        {
            var now = _now();
            long generation;
            lock (_lock)
            {
                if (_missing is { } cached && cached.Generation == _missingGeneration && now - cached.At < MissingCacheFor) return cached.Value;
                generation = _missingGeneration;
            }
            var libraries = _library.Libraries();
            var list = new List<BridgeMissing>();
            var checkedCount = 0;
            foreach (var instance in _store.Registry.All().Where(c => c.Usable))
            {
                if (_store.PeekHistory(instance.Id) is not { } history) continue;
                var library = _store.PeekLibrary(instance.Id);
                var seen = new HashSet<string>(StringComparer.Ordinal);
                foreach (var h in history.Records)
                {
                    var subject = h.EpisodeId is int e ? "e" + e.ToString(CultureInfo.InvariantCulture)
                        : h.MovieId is int m ? "m" + m.ToString(CultureInfo.InvariantCulture) : null;
                    // Only events that change the file decide (a later grab or failed upgrade doesn't
                    // replace the file Jellyfin still lacks); the newest of those per movie/episode.
                    if (subject == null || !ChangesFile(h) || !seen.Add(subject)) continue;
                    if (!IsImport(h) || string.IsNullOrWhiteSpace(h.ImportedPath) || h.Date is not DateTime at || now.UtcDateTime - at > MissingWindow) continue;
                    if (h.MovieId is int movieId && library?.MovieById(movieId) is { HasFile: false }) continue;   // removed since
                    if (++checkedCount > MaxImportsChecked) break;
                    var file = BridgePaths.InLibraryCase(Map(instance, h.ImportedPath!), libraries);
                    if (_library.FindByPath(file) != null) continue;
                    var (lib, _) = BridgePaths.LibraryOf(file, libraries);
                    var problem = lib == null ? "outside_library" : _library.FileExists(file) ? "not_scanned" : "not_visible";
                    list.Add(new BridgeMissing
                    {
                        InstanceId = instance.Id,
                        Instance = instance.Name,
                        Kind = instance.Kind.ToString(),
                        Title = h.Title,
                        Year = h.Year,
                        Key = KeyOf(instance.Kind, h.TmdbId, h.TvdbId, h.SeasonNumber, h.EpisodeNumber),
                        Season = h.SeasonNumber,
                        Episode = h.EpisodeNumber,
                        ArrId = h.MovieId ?? h.SeriesId,
                        ArrPath = h.ImportedPath!,
                        JellyfinPath = file,
                        ImportedAt = at,
                        Problem = problem,
                        Library = lib?.Name,
                    });
                }
            }
            var result = list.OrderBy(x => x.ImportedAt).ToList();
            lock (_lock) _missing = (now, result, generation);
            return result;
        }

        /// <summary>
        /// Titles an arr has files for that Jellyfin doesn't list by any of their provider ids (whole
        /// libraries, from memory; at most 50 per instance listed). Cached for two minutes.
        /// </summary>
        public BridgeMissingTitles MissingTitles()
        {
            var now = _now();
            lock (_lock)
            {
                if (_titles is { } cached && now - cached.At < TitlesCacheFor) return cached.Value;
            }
            var (movies, series) = _library.ProviderIndex();
            var libraries = _library.Libraries();
            var titles = new List<BridgeMissingTitle>();
            var counts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            foreach (var instance in _store.Registry.All().Where(c => c.Usable))
            {
                if (_store.PeekLibrary(instance.Id) is not { } snapshot) continue;
                var count = 0;
                IEnumerable<(string Title, int? Year, string? Key, string? Path)> missing = instance.Kind == ArrKind.Radarr
                    ? snapshot.Movies.Where(m => m.HasFile && !(m.TmdbId is int t && movies.Contains("tmdb:" + t.ToString(CultureInfo.InvariantCulture))) && !(m.ImdbId != null && movies.Contains("imdb:" + m.ImdbId)))
                        .Select(m => (m.Title, m.Year, KeyOf(ArrKind.Radarr, m.TmdbId, null, null, null), m.Path))
                    : snapshot.Series.Where(s => s.EpisodeFileCount > 0 && !(s.TvdbId is int v && series.Contains("tvdb:" + v.ToString(CultureInfo.InvariantCulture))) && !(s.TmdbId is int t && series.Contains("tmdb:" + t.ToString(CultureInfo.InvariantCulture))) && !(s.ImdbId != null && series.Contains("imdb:" + s.ImdbId)))
                        .Select(s => (s.Title, (int?)null, KeyOf(ArrKind.Sonarr, s.TmdbId, s.TvdbId, null, null), s.Path));
                foreach (var (title, year, key, path) in missing)
                {
                    count++;
                    if (count > 50) continue;
                    var jf = path != null ? BridgePaths.InLibraryCase(Map(instance, path), libraries) : null;
                    var (lib, _) = jf != null ? BridgePaths.LibraryOf(jf, libraries) : (null, null);
                    titles.Add(new BridgeMissingTitle
                    {
                        InstanceId = instance.Id, Instance = instance.Name, Title = title, Year = year, Key = key, ArrPath = path, JellyfinPath = jf,
                        Problem = jf == null || lib == null ? "outside_library" : _library.DirectoryExists(jf) ? "not_scanned" : "not_visible",
                    });
                }
                counts[instance.Id] = count;
            }
            var result = new BridgeMissingTitles { Titles = titles, Counts = counts };
            lock (_lock) _titles = (now, result);
            return result;
        }

        internal static string? KeyOf(ArrKind kind, int? tmdb, int? tvdb, int? season, int? episode)
        {
            // Provider id 0 is "none" (the arrs send it for titles they couldn't match), never a key.
            if (kind == ArrKind.Radarr) return tmdb is > 0 and int t ? "movie:tmdb:" + t.ToString(CultureInfo.InvariantCulture) : null;
            if (tvdb is not > 0) return null;
            var v = tvdb.Value;
            var key = "tv:tvdb:" + v.ToString(CultureInfo.InvariantCulture);
            if (season is int s) key += ":s" + s.ToString(CultureInfo.InvariantCulture);
            if (season.HasValue && episode is int e) key += ":e" + e.ToString(CultureInfo.InvariantCulture);
            return key;
        }

        // ------------------------------------------------------------------ path doctor

        /// <summary>
        /// The path doctor for every usable instance: its root folders (from the system snapshot) and
        /// path mappings as Jellyfin sees them, and up to three titles both sides have compared
        /// (provider ids), with a learned mapping when they disagree.
        /// </summary>
        public IReadOnlyList<PathDoctorInstance> PathDoctor()
        {
            var cfg = _config();
            var calendarFiltered = cfg is { CalendarPageEnabled: true, CalendarFilterByLibraryAccess: true };
            var libraries = _library.Libraries();
            var result = new List<PathDoctorInstance>();
            foreach (var instance in _store.Registry.All().Where(c => c.Usable))
            {
                var mappings = instance.PathMappings.Where(m => !string.IsNullOrWhiteSpace(m.ArrPath) && !string.IsNullOrWhiteSpace(m.JellyfinPath)).ToList();
                var mapped = mappings.Select(m => new PathDoctorMapping
                {
                    ArrPath = m.ArrPath, JellyfinPath = m.JellyfinPath, Exists = _library.DirectoryExists(m.JellyfinPath),
                    Library = BridgePaths.LibraryOf(m.JellyfinPath, libraries).Library?.Name,
                }).ToList();
                var roots = new List<PathDoctorRoot>();
                foreach (var root in _store.PeekSystem(instance.Id)?.RootFolders ?? Array.Empty<ArrDiskEntry>())
                {
                    if (string.IsNullOrWhiteSpace(root.Path)) continue;
                    var (jf, mapping) = BridgePaths.Map(root.Path, mappings);
                    var exists = _library.DirectoryExists(jf);
                    var lib = BridgePaths.LibraryOf(jf, libraries).Library;
                    var target = calendarFiltered ? _instanceLibraries.Resolve(instance, root.Path) : null;
                    roots.Add(new PathDoctorRoot
                    {
                        ArrPath = root.Path, JellyfinPath = jf, Mapped = mapping != null, Exists = exists, Library = lib?.Name,
                        Problem = !exists ? "not_visible" : target?.Problem is ArrLibraryProblem.SharedRoot or ArrLibraryProblem.RootsUnknown ? target.Problem : lib == null ? "not_in_library" : null,
                        HiddenFromMembers = target != null && !target.Resolved,
                    });
                }
                var samples = new List<PathDoctorSample>();
                var snapshot = _store.PeekLibrary(instance.Id);
                IEnumerable<(string Title, string Path, bool Movie, string Provider, string Id)> candidates = instance.Kind == ArrKind.Radarr
                    ? (snapshot?.Movies ?? Array.Empty<ArrMovieEntry>()).Where(m => m.HasFile && m.Path != null && m.TmdbId is > 0)
                        .OrderByDescending(m => m.Added ?? DateTime.MinValue)
                        .Select(m => (m.Title, m.Path!, true, "tmdb", m.TmdbId!.Value.ToString(CultureInfo.InvariantCulture)))
                    : (snapshot?.Series ?? Array.Empty<ArrSeriesEntry>()).Where(s => s.EpisodeFileCount > 0 && s.Path != null && s.TvdbId is > 0)
                        .OrderByDescending(s => s.Added ?? DateTime.MinValue)
                        .Select(s => (s.Title, s.Path!, false, "tvdb", s.TvdbId!.Value.ToString(CultureInfo.InvariantCulture)));
                var looked = 0;
                foreach (var (title, path, movie, provider, id) in candidates)
                {
                    if (samples.Count >= 3 || ++looked > 10) break;
                    if (_library.ItemPathByProvider(movie, provider, id) is not { } actual) continue;
                    var folder = movie ? BridgePaths.ItemFolder(actual) : BridgePaths.Norm(actual);
                    var expected = BridgePaths.Map(path, mappings).Path;
                    samples.Add(new PathDoctorSample { Title = title, ArrPath = path, Expected = expected, Actual = folder, Match = BridgePaths.SamePath(expected, folder) });
                }
                var wrong = samples.Where(s => !s.Match).ToList();
                var learned = wrong.Count > 0 ? BridgePaths.LearnMapping(wrong.Select(s => (s.ArrPath, s.Actual))) : null;
                // Root folders Jellyfin sees inside a library are a match too (a new instance has no
                // title on both sides yet); "unknown" only when there is nothing at all to compare.
                var verdict = wrong.Count > 0 || roots.Any(r => r.Problem != null || r.HiddenFromMembers) ? "problem" : samples.Count > 0 || roots.Count > 0 ? "ok" : "unknown";
                result.Add(new PathDoctorInstance
                {
                    InstanceId = instance.Id,
                    Instance = instance.Name,
                    Verdict = verdict,
                    Mappings = mapped,
                    Roots = roots,
                    Samples = samples,
                    Suggestion = learned is { } l ? new PathDoctorMapping { ArrPath = l.ArrPath, JellyfinPath = l.JellyfinPath, Exists = _library.DirectoryExists(l.JellyfinPath) } : null,
                });
            }
            return result;
        }

        /// <summary>A file queued for a targeted refresh.</summary>
        /// <param name="Instance">The instance that imported it.</param>
        /// <param name="ArrPath">The file as the arr sees it.</param>
        /// <param name="Waits">How often it waited for Jellyfin's library scan.</param>
        /// <param name="Replay">Replayed from the first history read (it may have been found already).</param>
        /// <param name="Generation">The import it is (instance and arr history record), or null (one is made up).</param>
        /// <param name="Key">The import's title key, when known.</param>
        internal sealed record Pending(ArrConnection Instance, string ArrPath, int Waits, bool Replay = false, string? Generation = null, string? Key = null);
    }
}
