using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>Why a title folder of an instance resolves to no Jellyfin library.</summary>
    public static class ArrLibraryProblem
    {
        /// <summary>The title has no folder path.</summary>
        public const string NoPath = "no_path";

        /// <summary>The (mapped) folder is inside no Jellyfin library.</summary>
        public const string NotInLibrary = "not_in_library";

        /// <summary>Another instance has the very same root folder with no path mapping either: whose disk Jellyfin sees there can't be told.</summary>
        public const string SharedRoot = "shared_root";

        /// <summary>
        /// No path mapping applies and the root folders of this instance or of another usable one
        /// aren't known yet (its system snapshot hasn't been read, or can't be): whether the arr's
        /// own path is another instance's disk too can't be told.
        /// </summary>
        public const string RootsUnknown = "roots_unknown";

        /// <summary>The instance is no longer configured.</summary>
        public const string NoInstance = "no_instance";
    }

    /// <summary>
    /// Where an instance's title lands in Jellyfin: the libraries a user must be able to open to see
    /// it (<see cref="Libraries"/>), or none known (<see cref="Problem"/> says why).
    /// </summary>
    /// <param name="Libraries">The Jellyfin library (collection folder) ids, or null when unresolved.</param>
    /// <param name="Via">linked (the instance's linked libraries), mapped (a path mapping) or same_path (the arr's path as it is).</param>
    /// <param name="Problem">One of <see cref="ArrLibraryProblem"/> when unresolved.</param>
    public sealed record ArrLibraryTarget(IReadOnlyList<Guid>? Libraries, string? Via, string? Problem)
    {
        /// <summary>True when the libraries are known.</summary>
        public bool Resolved => Libraries is { Count: > 0 };
    }

    /// <summary>
    /// Resolves an arr instance's title folder through its longest path mapping and the deepest
    /// Jellyfin library that holds it. With no mapping, an unambiguous shared-disk path can resolve
    /// only when every usable instance's root folders are known and no other unmapped instance
    /// shares the title's root. A resolved destination is constrained to the instance's linked
    /// libraries when configured; otherwise those linked libraries are the fallback, then unresolved.
    /// Answers come from memory only (the system snapshots' root folders, the registry and
    /// Jellyfin's library list), are decided against the registry entry and snapshots of the very
    /// read they are cached under, and are dropped as soon as any of them changes; Jellyfin's
    /// library list is read again at most every <see cref="LibrariesTtl"/>.
    /// </summary>
    public sealed class ArrInstanceLibraries
    {
        /// <summary>How long Jellyfin's library list (names and folders) is reused.</summary>
        public static readonly TimeSpan LibrariesTtl = TimeSpan.FromSeconds(30);

        private const int MaxCacheEntries = 20_000;

        private readonly ArrStateStore _store;
        internal SeerrParentalFilter? Parental { get; set; }
        private readonly Func<IReadOnlyList<JfLibraryRoot>> _library;
        private readonly Func<DateTimeOffset> _now;
        private readonly object _gate = new();
        private volatile LibraryRead? _libraries;
        private State? _state;

        /// <summary>Creates the resolver (DI).</summary>
        public ArrInstanceLibraries(ArrStateStore store, IJellyfinLibraryAccess library)
            : this(store, library, (Func<DateTimeOffset>?)null)
        {
        }

        /// <summary>Creates the resolver with a clock (tests).</summary>
        internal ArrInstanceLibraries(ArrStateStore store, IJellyfinLibraryAccess library, Func<DateTimeOffset>? now)
            : this(store, library.Libraries, now)
        {
        }

        internal ArrInstanceLibraries(ArrStateStore store, Func<IReadOnlyList<JfLibraryRoot>> libraries, Func<DateTimeOffset>? now)
        {
            _store = store;
            _library = libraries;
            _now = now ?? (() => DateTimeOffset.UtcNow);
        }

        /// <summary>Jellyfin's libraries as last read (at most <see cref="LibrariesTtl"/> old).</summary>
        public IReadOnlyList<JfLibraryRoot> Libraries() => CurrentLibraries().Libraries;

        /// <summary>The libraries a title of <paramref name="instance"/> whose folder (as the arr sees it) is <paramref name="arrPath"/> lands in.</summary>
        public ArrLibraryTarget Resolve(ArrConnection instance, string? arrPath)
        {
            var state = CurrentState();
            // The instance as the registry read behind this answer has it (mappings and linked
            // libraries), not the caller's copy, which may be older.
            var current = state.Registry.FirstOrDefault(i => string.Equals(i.Id, instance.Id, StringComparison.OrdinalIgnoreCase));
            if (current == null) return new ArrLibraryTarget(null, null, ArrLibraryProblem.NoInstance);
            var key = (current.Id, BridgePaths.Norm(arrPath ?? string.Empty));
            if (state.Cache.TryGetValue(key, out var hit)) return hit;
            var linked = Linked(current);
            var target = string.IsNullOrWhiteSpace(arrPath) ? new ArrLibraryTarget(null, null, ArrLibraryProblem.NoPath) : Decide(current, key.Item2, state);
            if (!target.Resolved || (linked.Count > 0 && !target.Libraries!.Any(linked.Contains)))
                target = linked.Count > 0 ? new ArrLibraryTarget(linked, "linked", null) : new ArrLibraryTarget(null, null, target.Problem ?? ArrLibraryProblem.NotInLibrary);
            if (state.Cache.Count > MaxCacheEntries) state.Cache.Clear();
            // Into the cache of the read it was decided from: once the inputs change, nobody reads it.
            state.Cache[key] = target;
            return target;
        }

        /// <summary>A title's library from its indexed folder, or the folder included in queue/history before the index is warm.</summary>
        internal ArrLibraryTarget ResolveTitle(ArrConnection instance, TitleKey key)
        {
            var library = _store.PeekLibrary(instance.Id);
            var path = key.IsMovie ? library?.MovieByTmdb(key.NumericId ?? 0)?.Path : library?.SeriesByTvdb(key.NumericId ?? 0)?.Path;
            path ??= _store.PeekQueue(instance.Id)?.Records.FirstOrDefault(r => (key.IsMovie ? r.TmdbId : r.TvdbId) == key.NumericId)?.TitlePath;
            path ??= _store.PeekHistory(instance.Id)?.Records.FirstOrDefault(r => (key.IsMovie ? r.TmdbId : r.TvdbId) == key.NumericId)?.TitlePath;
            return Resolve(instance, path);
        }

        /// <summary>
        /// True when <paramref name="user"/> may open one of <paramref name="libraries"/>: a folder
        /// blocked for them never counts, then "all libraries" lets everything else in, otherwise only
        /// the libraries they were given.
        /// </summary>
        public static bool CanOpen(User user, IReadOnlyList<Guid> libraries)
        {
            var blocked = user.GetPreferenceValues<Guid>(PreferenceKind.BlockedMediaFolders);
            var all = user.HasPermission(PermissionKind.EnableAllFolders);
            var enabled = all ? Array.Empty<Guid>() : user.GetPreferenceValues<Guid>(PreferenceKind.EnabledFolders);
            foreach (var library in libraries)
            {
                if (blocked.Contains(library)) continue;
                if (all || enabled.Contains(library)) return true;
            }
            return false;
        }

        /// <summary>True when the user can open a resolved target, or every library for an unresolved target.</summary>
        public static bool CanOpen(User user, ArrLibraryTarget target, IReadOnlyList<JfLibraryRoot>? knownLibraries = null)
            => target.Libraries is { Count: > 0 } libraries ? CanOpen(user, libraries) : CanOpenEveryLibrary(user, knownLibraries);

        /// <summary>True when library access is unrestricted, including blocked folders.</summary>
        public static bool CanOpenEveryLibrary(User user, IReadOnlyList<JfLibraryRoot>? knownLibraries = null)
        {
            if (user.GetPreferenceValues<Guid>(PreferenceKind.BlockedMediaFolders).Length > 0) return false;
            if (user.HasPermission(PermissionKind.EnableAllFolders)) return true;
            return knownLibraries is { Count: > 0 } && knownLibraries.All(l => Guid.TryParse(l.Id, out var id) && id != Guid.Empty && CanOpen(user, new[] { id }));
        }

        /// <summary>Whether an absent title's copy may contribute status for this viewer, including their own request.</summary>
        internal bool CanSeeAbsent(StatusViewer viewer, ArrConnection instance, string? path, bool asked)
            => !AbsentParentalEnabled ? viewer.IsAdmin || asked || (!viewer.HasParentalLimit && viewer.Handle is User legacyUser && CanOpen(legacyUser, Resolve(instance, path), Libraries())) :
               (!viewer.HasParentalLimit || MaySeeAbsent(viewer, instance, path)) && (asked || (viewer.Handle is User user && CanOpen(user, Resolve(instance, path), Libraries())));

        internal static bool AbsentParentalEnabled => JellyfinEnhanced.Instance?.Configuration is { ArrIntegrationEnabled: true, ArrPhase1Enabled: true, ArrPhase3Enabled: true };

        /// <summary>Cache-only parental check for an absent indexed copy.</summary>
        internal bool MaySeeAbsent(StatusViewer viewer, ArrConnection instance, string? path, TitleKey? key = null)
        {
            if (!AbsentParentalEnabled || !viewer.HasParentalLimit) return true;
            var library = _store.PeekLibrary(instance.Id);
            var tmdb = key?.Provider == "tmdb" ? key.NumericId : null;
            if (!tmdb.HasValue && path != null)
                tmdb = instance.Kind == ArrKind.Radarr ? library?.Movies.FirstOrDefault(m => m.Path == path)?.TmdbId : library?.Series.FirstOrDefault(m => m.Path == path)?.TmdbId;
            if (!tmdb.HasValue && key?.Provider == "tvdb") tmdb = library?.SeriesByTvdb(key.NumericId ?? 0)?.TmdbId;
            return Parental?.MaySeeAbsent(instance.Kind == ArrKind.Radarr ? "movie" : "tv", tmdb ?? 0, viewer.UserId.ToString("N"), out _) == true;
        }

        /// <summary>Cache-only rating decision by canonical key, resolving TVDB to TMDB through indexed copies.</summary>
        internal bool MaySeeAbsent(StatusViewer viewer, TitleKey key)
        {
            if (!AbsentParentalEnabled || !viewer.HasParentalLimit) return true;
            var tmdb = key.Provider == "tmdb" ? key.NumericId : null;
            foreach (var instance in _store.Registry.All())
            {
                if (tmdb.HasValue) break;
                if (!key.IsMovie && key.Provider == "tvdb") tmdb = _store.PeekLibrary(instance.Id)?.SeriesByTvdb(key.NumericId ?? 0)?.TmdbId;
            }
            return Parental?.MaySeeAbsent(key.IsMovie ? "movie" : "tv", tmdb ?? 0, viewer.UserId.ToString("N"), out _) == true;
        }

        /// <summary>A token that changes with mappings, linked libraries, roots and Jellyfin library locations.</summary>
        internal string Revision => CurrentState().Revision;

        private static List<Guid> Linked(ArrConnection instance)
        {
            var ids = new List<Guid>();
            foreach (var raw in instance.LinkedLibraryIds)
            {
                if (Guid.TryParse(raw, out var id) && id != Guid.Empty && !ids.Contains(id)) ids.Add(id);
            }
            return ids;
        }

        private static ArrLibraryTarget Decide(ArrConnection instance, string path, State state)
        {
            if (!BridgePaths.Safe(path)) return new ArrLibraryTarget(null, null, ArrLibraryProblem.NotInLibrary);
            var (mapped, mapping) = BridgePaths.Map(path, Mappings(instance));
            if (mapping == null)
            {
                // The arr's own path: Jellyfin sees the same disk there only if no other instance
                // could mean another disk by it, which needs every instance's root folders.
                if (state.RootsOf(instance.Id) is not { } own) return new ArrLibraryTarget(null, null, ArrLibraryProblem.RootsUnknown);
                var root = RootOf(own, path) ?? BridgePaths.Parent(path) ?? path;
                foreach (var other in state.Registry)
                {
                    if (!other.Usable || string.Equals(other.Id, instance.Id, StringComparison.OrdinalIgnoreCase)) continue;
                    if (state.RootsOf(other.Id) is not { } roots) return new ArrLibraryTarget(null, null, ArrLibraryProblem.RootsUnknown);
                    if (!roots.Any(r => !string.IsNullOrWhiteSpace(r.Path) && BridgePaths.SamePath(r.Path, root))) continue;
                    if (BridgePaths.Map(root, Mappings(other)).Mapping == null) return new ArrLibraryTarget(null, null, ArrLibraryProblem.SharedRoot);
                }
            }

            var (library, _) = BridgePaths.LibraryOf(mapped, state.Libraries);
            if (library == null || !Guid.TryParse(library.Id, out var libraryId) || libraryId == Guid.Empty)
                return new ArrLibraryTarget(null, null, ArrLibraryProblem.NotInLibrary);
            return new ArrLibraryTarget(new[] { libraryId }, mapping != null ? "mapped" : "same_path", null);
        }

        // The longest of an instance's root folders that holds the path, or null.
        private static string? RootOf(IReadOnlyList<ArrDiskEntry> roots, string path)
        {
            string? best = null;
            foreach (var root in roots)
            {
                if (string.IsNullOrWhiteSpace(root.Path) || !BridgePaths.IsUnder(path, root.Path)) continue;
                var norm = BridgePaths.Norm(root.Path);
                if (best == null || norm.Length > best.Length) best = norm;
            }
            return best;
        }

        private static List<Model.Arr.ArrPathMapping> Mappings(ArrConnection instance)
            => instance.PathMappings.Where(m => !string.IsNullOrWhiteSpace(m.ArrPath) && !string.IsNullOrWhiteSpace(m.JellyfinPath)).ToList();

        // Everything an answer depends on, read once: the registry (mappings, linked libraries,
        // usable), each instance's system snapshot (root folders) and Jellyfin's library folders.
        // The cache stays while a fresh read is the same; otherwise this read replaces it.
        private State CurrentState()
        {
            var (libraries, libraryStamp) = CurrentLibraries();
            var registry = _store.Registry.All();
            var systems = registry.Select(i => _store.PeekSystem(i.Id)).ToArray();
            var stamp = new Stamp(libraryStamp, registry, systems);
            lock (_gate)
            {
                if (_state == null || !_state.Stamp.Same(stamp)) _state = new State(stamp, libraries, registry, systems);
                return _state;
            }
        }

        // The registry list is rebuilt whenever the configuration changes and a snapshot object is
        // replaced on every read, so the same objects mean the same answers.
        private sealed record Stamp(string Libraries, object Registry, object?[] Systems)
        {
            public bool Same(Stamp other)
                => string.Equals(Libraries, other.Libraries, StringComparison.Ordinal)
                   && ReferenceEquals(Registry, other.Registry)
                   && Systems.Length == other.Systems.Length
                   && Systems.Zip(other.Systems).All(p => ReferenceEquals(p.First, p.Second));
        }

        // One read of the inputs and the answers decided from it.
        private sealed class State
        {
            private readonly ArrSystemSnapshot?[] _systems;

            public State(Stamp stamp, IReadOnlyList<JfLibraryRoot> libraries, IReadOnlyList<ArrConnection> registry, ArrSystemSnapshot?[] systems)
            {
                Stamp = stamp;
                Libraries = libraries;
                Registry = registry;
                _systems = systems;
            }

            public Stamp Stamp { get; }

            public string Revision { get; } = Guid.NewGuid().ToString("N");

            public IReadOnlyList<JfLibraryRoot> Libraries { get; }

            public IReadOnlyList<ArrConnection> Registry { get; }

            public ConcurrentDictionary<(string Instance, string Path), ArrLibraryTarget> Cache { get; } = new();

            // An instance's root folders as this read has them, or null when not known (no snapshot).
            public IReadOnlyList<ArrDiskEntry>? RootsOf(string instanceId)
            {
                for (var i = 0; i < Registry.Count; i++)
                {
                    if (string.Equals(Registry[i].Id, instanceId, StringComparison.OrdinalIgnoreCase)) return _systems[i]?.RootFolders;
                }
                return null;
            }
        }

        // Jellyfin's library list, its stamp and when it was read (one object, so they stay together).
        private sealed record LibraryRead(IReadOnlyList<JfLibraryRoot> Libraries, string Stamp, DateTimeOffset At);

        private (IReadOnlyList<JfLibraryRoot> Libraries, string Stamp) CurrentLibraries()
        {
            var now = _now();
            if (_libraries is { } known && now - known.At < LibrariesTtl) return (known.Libraries, known.Stamp);
            IReadOnlyList<JfLibraryRoot> libraries;
            try
            {
                libraries = _library();
            }
            catch (Exception)
            {
                libraries = Array.Empty<JfLibraryRoot>();
            }
            var stamp = string.Join(";", libraries.OrderBy(l => l.Id, StringComparer.Ordinal).Select(l => l.Id + "=" + string.Join(",", l.Locations)));
            _libraries = new LibraryRead(libraries, stamp, now);
            return (libraries, stamp);
        }
    }
}
