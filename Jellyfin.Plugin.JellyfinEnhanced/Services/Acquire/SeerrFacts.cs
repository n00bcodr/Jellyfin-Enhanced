using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using Microsoft.Extensions.Hosting;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>
    /// The only handout of Seerr facts. Readers and ownership caches are private implementation details.
    /// Every handout records its admission epoch in the enclosing publication, including cache hits.
    /// The publication owns the composed answer across later awaits, rather than just the inner read.
    /// </summary>
    public sealed partial class SeerrFacts : IArrRequestFacts, IHostedService, IDisposable
    {
        internal static EffectiveRequestsBackend.FactLock CacheMutation() => EffectiveRequestsBackend.Shared.LockFacts();
        public static T ReadSeerrCached<T>(Func<T> read, T inactive) => EffectiveRequestsBackend.Shared.Facts.Cached(read, inactive);
        public static Task<T> ReadSeerrAsync<T>(SeerrUse use, Func<long, Task<T>> read) => EffectiveRequestsBackend.Shared.Facts.ReadAsync(use, read);
        public static T PublishSeerr<T>(long epoch, Func<T> result) => EffectiveRequestsBackend.Shared.Facts.Publish(epoch, result);
        public static bool TryPublishSeerr(long epoch, Action effect) => EffectiveRequestsBackend.Shared.TryPublishSeerr(epoch, effect);
        public static Task<T> RunSeerrAsync<T>(SeerrUse use, CancellationToken ct, Func<CancellationToken, Task<T>> read) => EffectiveRequestsBackend.Shared.RunSeerrAsync(use, ct, read);

        private readonly SeerrRequestReadModel _model;
        private readonly SeerrMigrationReader _migration;
        private readonly EffectiveRequestsBackend _owner;
        public const int MaxRequests = SeerrRequestReadModel.MaxRequests;
        public const int PageSize = SeerrRequestReadModel.PageSize;
        public const int MaxMetaPerRefresh = SeerrRequestReadModel.MaxMetaPerRefresh;
        internal const int MaxResponseBytes = SeerrMigrationReader.MaxResponseBytes;

        public SeerrFacts(IHttpClientFactory http, ArrChangeFeed feed, Logger logger, RequestOutboxEvents events)
            : this(http, feed, logger, null, null, events) { }
        internal SeerrFacts(IHttpClientFactory http, ArrChangeFeed? feed = null, Logger? logger = null, Func<PluginConfiguration?>? config = null, Func<DateTimeOffset>? now = null, RequestOutboxEvents? events = null)
        {
            _owner = config == null ? EffectiveRequestsBackend.Shared : new EffectiveRequestsBackend(config);
            _model = new(http, feed, logger, config, now, events, _owner);
            _migration = new(http);
        }
        private T Model<T>(Func<T> read, T inactive) => _owner.Facts.Cached(read, inactive, _model.FactsEpoch);
        public long Revision => Model(() => _model.Revision, 0L);
        public bool Active => _owner.Facts.Cached(() => _model.Active, false);
        public bool Loaded => Model(() => _model.Loaded, false);
        public SeerrReadModelState State => Model(() => _model.State, new SeerrReadModelState());
        public IReadOnlyList<SeerrRequestRecord> All => Model(() => _model.All, Array.Empty<SeerrRequestRecord>());
        public string? Source => Model(() => _model.Source, (string?)null);
        public (string? Source, IReadOnlyList<SeerrRequestRecord> All, int? Floor) Current => Model(() => _model.Current, ((string?)null, (IReadOnlyList<SeerrRequestRecord>)Array.Empty<SeerrRequestRecord>(), (int?)null));
        internal string? CurrentSource => _owner.Facts.Cached(() => _model.CurrentSource, (string?)null);
        internal string? SourceOf(PluginConfiguration? config) => _owner.Facts.Cached(() => _model.SourceOf(config), (string?)null);
        public static bool IsActive(PluginConfiguration? config) => SeerrRequestReadModel.IsActive(config);
        public static bool IsActive(PluginConfiguration? config, bool hasApiKey) => SeerrRequestReadModel.IsActive(config, hasApiKey);
        public IReadOnlyList<SeerrRequestRecord> ForUser(Guid user) => Model(() => _model.ForUser(user), Array.Empty<SeerrRequestRecord>());
        public IReadOnlyList<SeerrRequestRecord> ForTitle(TitleKey title) => Model(() => _model.ForTitle(title), Array.Empty<SeerrRequestRecord>());
        public SeerrTitleMeta? Meta(bool movie, int? tmdb) => Model(() => _model.Meta(movie, tmdb), (SeerrTitleMeta?)null);
        public RequestFacts? For(TitleKey key, StatusViewer viewer) => Model(() => _model.For(key, viewer), (RequestFacts?)null);
        public RequestFacts? ForEpisode(TitleKey key, int season, int episode, StatusViewer viewer) => Model(() => _model.ForEpisode(key, season, episode, viewer), (RequestFacts?)null);
        public RequestFacts? ForSeason(TitleKey key, int season, StatusViewer viewer) => Model(() => _model.ForSeason(key, season, viewer), (RequestFacts?)null);
        public RequestFacts? ForPart(TitleKey key, bool fourK, IReadOnlyList<int> seasons, IReadOnlyList<(int Season, int Episode)> episodes, StatusViewer viewer) => Model(() => _model.ForPart(key, fourK, seasons, episodes, viewer), (RequestFacts?)null);
        public PartAvailability? AvailabilityForPart(TitleKey key, bool fourK, IReadOnlyList<int> seasons, IReadOnlyList<(int Season, int Episode)> episodes, StatusViewer viewer) => Model(() => _model.AvailabilityForPart(key, fourK, seasons, episodes, viewer), (PartAvailability?)null);
        public bool AskedBy(TitleKey key, Guid user) => Model(() => _model.AskedBy(key, user), false);
        public bool Requested(TitleKey key) => Model(() => _model.Requested(key), false);
        public bool AskedLatelyBy(TitleKey key, Guid user) => Model(() => _model.AskedLatelyBy(key, user), false);
        public bool RequestedLately(TitleKey key) => Model(() => _model.RequestedLately(key), false);
        internal static PartAvailability AvailabilityOf(IReadOnlyList<SeerrRequestRecord> rows) => EffectiveRequestsBackend.Shared.Facts.Cached(() => SeerrRequestReadModel.AvailabilityOf(rows), new PartAvailability(false, null, null));
        internal static RequestFacts? FactsOf(IReadOnlyList<SeerrRequestRecord> rows, Guid user) => EffectiveRequestsBackend.Shared.Facts.Cached(() => SeerrRequestReadModel.FactsOf(rows, user), (RequestFacts?)null);
        internal static SeerrRequestRecord? Parse(JsonElement item) => SeerrRequestReadModel.Parse(item);
        public static string AddressFingerprint(PluginConfiguration config) => SeerrMigrationReader.AddressFingerprint(config);
        public Task<SeerrMigrationRead> ReadAsync(PluginConfiguration config, CancellationToken ct) => _owner.Facts.ReadAsync(SeerrUse.RequestRead, _ => _migration.ReadAsync(config, ct));
        internal TimeSpan CallTimeout { get => _migration.CallTimeout; set => _migration.CallTimeout = value; }
        internal TimeSpan Budget { get => _migration.Budget; set => _migration.Budget = value; }
        public Task<bool> RefreshAsync(CancellationToken ct) => _model.RefreshAsync(ct);
        public void RequestRefresh() => _model.RequestRefresh();
        public void Touch() => _model.Touch();
        public Task StartAsync(CancellationToken ct) => _model.StartAsync(ct);
        public Task StopAsync(CancellationToken ct) => _model.StopAsync(ct);
        public void Dispose() => _model.Dispose();
        internal int HeldBelowWindow { get => _model.HeldBelowWindow; set => _model.HeldBelowWindow = value; }
        internal bool Due() => _model.Due();
        internal DateTimeOffset? RequestedAt => _model.RequestedAt;
        internal DateTimeOffset? WatchedAt => _model.WatchedAt;

        public static Task<IReadOnlySet<(int TmdbId, string MediaType)>?> OwnershipAsync(string key, Func<Task<IReadOnlySet<(int TmdbId, string MediaType)>?>> read)
            => OwnershipCache.Shared.GetAsync(key, read);
        internal static void ClearOwnership() => OwnershipCache.Shared.Clear();

        // An internal handle keeps legacy cache-clock tests on the public accessor path too.
        internal sealed class OwnershipCache
        {
            private readonly SeerrAskedProofCache _cache;
            internal OwnershipCache(Func<long>? now = null, TimeSpan? wait = null) { _cache = new(now, wait); }
            private OwnershipCache(SeerrAskedProofCache cache) { _cache = cache; }
            internal static OwnershipCache Shared { get; } = new(SeerrAskedProofCache.Shared);
            internal static TimeSpan Fresh => SeerrAskedProofCache.Fresh;
            internal static TimeSpan MaxStale => SeerrAskedProofCache.MaxStale;
            internal void Clear() => _cache.Clear();
            internal Task<IReadOnlySet<(int TmdbId, string MediaType)>?> GetAsync(string key, Func<Task<IReadOnlySet<(int TmdbId, string MediaType)>?>> read)
                => EffectiveRequestsBackend.Shared.Facts.ReadAsync(SeerrUse.RequestRead, _ => _cache.GetAsync(key, read));
        }

        /// <summary>Owns a composed answer even when its caller is not an MVC action.</summary>
        internal static T Compose<T>(Func<T> build)
        {
            using var publication = BeginPublication();
            var value = build();
            return publication.Publish(() => value);
        }
        internal static async Task<T> ComposeAsync<T>(Func<Task<T>> build)
        {
            using var publication = BeginPublication();
            var value = await build().ConfigureAwait(false);
            return publication.Publish(() => value);
        }

        private static readonly AsyncLocal<Publication?> Pending = new();
        /// <summary>Owns the final composition; merely entering a scope does not make JE/local work Seerr-dependent.</summary>
        public static Publication BeginPublication() => new();
        public sealed class Publication : IDisposable
        {
            private readonly Publication? _parent;
            internal long Generation { get; }
            internal bool Tainted { get; private set; }
            internal bool Retained => _background?.HasAdmission == true || _parent?.Retained == true;
            internal bool LegacyRetained => _background?.HasLegacyAdmission == true || _parent?.LegacyRetained == true;
            internal bool RetainedGeneration => _background?.HasFactsAdmission == true || _parent?.RetainedGeneration == true;
            internal void MarkTainted() { Tainted = true; Helpers.UserCacheRegistry.MarkTainted(); _parent?.MarkTainted(); }
            private readonly Background? _background;
            private long _factsDependency;
            private int _factsRetainDependency;
            internal bool FactsRetainDependency => Volatile.Read(ref _factsRetainDependency) != 0 || _parent?.FactsRetainDependency == true;
            internal long FactsDependency => Volatile.Read(ref _factsDependency) is var own && own != 0 ? own : _parent?.FactsDependency ?? 0;
            internal void IncludeFacts(long generation, bool tainted)
            {
                if (Volatile.Read(ref _factsDependency) == generation && (!tainted || FactsRetainDependency)) return;
                var inherited = FactsDependency;
                if (inherited != 0 && inherited != generation) throw new BackendDisabledException("configuration_changed");
                if (tainted && _parent?.RetainedGeneration != true) _background?.IncludeFacts(generation);
                _parent?.IncludeFacts(generation, tainted);
                if (tainted) Volatile.Write(ref _factsRetainDependency, 1);
                Interlocked.CompareExchange(ref _factsDependency, generation, 0);
            }
            private readonly Dictionary<EffectiveRequestsBackend, long> _dependencies = new();
            private readonly EffectiveReadScope _effectiveScope = new();
            /// <summary>
            /// Enlists a backend-neutral read admitted under EffectiveRequestsBackend.Shared.Current. Unlike a Seerr
            /// dependency this permits strict-JE metadata/history reads with submissions off, but rejects epoch changes.
            /// </summary>
            public void EnlistEffective(EffectiveBackendSnapshot snapshot) => IncludeEffective(EffectiveRequestsBackend.Shared, snapshot.Epoch);
            internal void IncludeEffective(EffectiveRequestsBackend owner, long epoch) => _effectiveScope.Include(owner, epoch);
            internal KeyValuePair<EffectiveRequestsBackend, long>[] EffectiveDependencies() => _effectiveScope.Dependencies();
            internal Publication(bool retain = false, CancellationToken ct = default)
            {
                _parent = Pending.Value;
                Generation = _parent?.Generation ?? Helpers.UserCacheRegistry.Begin().Generation;
                _background = retain ? new Background(ct) : null;
                // A writer entered after a warm-cache lookup must retain that original input before any wait.
                try { if (_parent?.FactsRetainDependency == true && _parent?.RetainedGeneration != true && _parent?.FactsDependency is > 0 and var facts) _background?.IncludeFacts(facts); }
                catch { _background?.Dispose(); _effectiveScope.Dispose(); throw; }
                Pending.Value = this;
            }
            internal CancellationToken Token => _background?.Token ?? CancellationToken.None;
            internal void Include(EffectiveRequestsBackend owner, long epoch)
            {
                var admitted = _parent?.Epoch(owner) ?? epoch;
                // Refused admission must not taint an otherwise independent optional result.
                _background?.Include(owner, admitted);
                _parent?.Include(owner, epoch);
                lock (_dependencies) _dependencies.TryAdd(owner, admitted);
            }
            internal KeyValuePair<EffectiveRequestsBackend, long>[] Dependencies()
            {
                var all = _parent?.Dependencies().ToDictionary(e => e.Key, e => e.Value) ?? new Dictionary<EffectiveRequestsBackend, long>();
                lock (_dependencies) foreach (var pair in _dependencies) all.TryAdd(pair.Key, pair.Value);
                return all.ToArray();
            }
            internal long? Epoch(EffectiveRequestsBackend owner)
            {
                lock (_dependencies) return _dependencies.TryGetValue(owner, out var epoch) ? epoch : _parent?.Epoch(owner);
            }
            internal BackendPublicationStamp CaptureCommitStamp()
            {
                Publish(() => true);
                return new(Dependencies(), EffectiveDependencies(), FactsDependency, LegacyRetained);
            }
            public T Publish<T>(Func<T> result)
            {
                KeyValuePair<EffectiveRequestsBackend, long>[] dependencies;
                lock (_dependencies) dependencies = System.Linq.Enumerable.ToArray(_dependencies);
                T Check(int index) => index == dependencies.Length ? result() : dependencies[index].Key.CommitSeerr(dependencies[index].Value, () => Check(index + 1));
                var effective = EffectiveDependencies();
                T CheckEffective(int index) => index == effective.Length ? Check(0) : effective[index].Key.CommitEffective(effective[index].Value, () => CheckEffective(index + 1));
                var facts = FactsDependency;
                // A test/custom provider owner can differ from Shared. Never nest its monitor under Shared's:
                // durable cache-dependent effects retain the shared admission, while result composition checks both ends.
                // A native version-zero backend-selector save has no isolation semantics for an already admitted
                // legacy Seerr send. Cache lookups/stores still reject old tickets; adoption into v1 still rejects it.
                var legacySend = LegacyRetained && EffectiveRequestsBackend.Shared.Current.IsolationVersion == 0;
                if (facts != 0 && !legacySend) EffectiveRequestsBackend.Shared.CommitFacts(facts, () => true);
                var value = CheckEffective(0);
                if (facts != 0 && !(legacySend && EffectiveRequestsBackend.Shared.Current.IsolationVersion == 0)) EffectiveRequestsBackend.Shared.CommitFacts(facts, () => true);
                return value;
            }
            public void Dispose() { if (Pending.Value == this) Pending.Value = _parent; _background?.Dispose(); _effectiveScope.Dispose(); }
        }

        /// <summary>One epoch-aware implementation for async reads, cache reads, snapshots and publication effects.</summary>
        internal sealed class Access(EffectiveRequestsBackend owner)
        {
            internal void Include(long epoch) => Pending.Value?.Include(owner, epoch);
            internal T Publish<T>(long epoch, Func<T> result)
            {
                owner.CheckSeerr(SeerrUse.RequestRead, epoch).Demand();
                Include(epoch);
                var admitted = Pending.Value?.Epoch(owner) ?? epoch;
                return owner.CommitSeerr(admitted, () => owner.CommitSeerr(epoch, () => Mark(result()).Value));
            }
            internal T Cached<T>(Func<T> read, T inactive, long? epoch = null)
            {
                var admission = owner.CheckSeerr(SeerrUse.RequestRead, epoch);
                if (!admission.Allowed) return inactive;
                try { return Publish(epoch ?? admission.Epoch, read); }
                catch (BackendDisabledException) { return inactive; }
            }
            internal async Task<T> RunAsync<T>(SeerrUse use, CancellationToken ct, Func<CancellationToken, Task<T>> work)
            {
                using var publication = BeginPublication();
                using var operation = owner.AdmitSeerr(use, ct, Pending.Value?.Epoch(owner));
                Include(operation.Epoch);
                try
                {
                    var value = await work(operation.Token).ConfigureAwait(false);
                    return operation.Publish(() => publication.Publish(() => value));
                }
                catch (BackendDisabledException) when (operation.Token.IsCancellationRequested)
                {
                    operation.Token.ThrowIfCancellationRequested();
                    throw;
                }
            }
            internal async Task<T> ReadAsync<T>(SeerrUse use, Func<long, Task<T>> read)
            {
                using var publication = BeginPublication();
                var admission = owner.CheckSeerr(use, Pending.Value?.Epoch(owner));
                admission.Demand();
                Include(admission.Epoch);
                var value = await read(admission.Epoch).ConfigureAwait(false);
                return publication.Publish(() => Publish(admission.Epoch, () => value));
            }
        }
    }
}
