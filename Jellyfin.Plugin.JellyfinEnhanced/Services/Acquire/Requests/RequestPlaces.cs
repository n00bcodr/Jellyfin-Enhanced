using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>
    /// Where an approved request would land: the Jellyfin library its instance's root folder holds
    /// titles for (a name, never a path) and the free space of that drive.
    /// </summary>
    /// <param name="Library">Jellyfin library name, when the folder maps to exactly one.</param>
    /// <param name="FreeBytes">Free space of the drive holding the root folder.</param>
    public sealed record RequestPlace(string? Library, long FreeBytes);

    /// <summary>Display facts of where a request would go, for the approval cards.</summary>
    public interface IRequestPlaces
    {
        /// <summary>
        /// Where <paramref name="titleKey"/> would land on <paramref name="instanceId"/>: <paramref name="rootFolder"/>
        /// when the request names one, else the title's own folder when the instance has it already,
        /// else the instance's default root folder, else its only root folder; null when unknown.
        /// </summary>
        Task<RequestPlace?> PlaceAsync(string instanceId, string? rootFolder, string titleKey, CancellationToken ct);

        /// <summary>The name of a usable 4K instance that already has a file of the title; null when none does.</summary>
        string? FourKHolder(string titleKey);
    }

    /// <summary>
    /// <see cref="IRequestPlaces"/> from the shared snapshots: the system facts' disk space and root
    /// folders (read once when not in memory yet, then kept by the store), the instance registry and
    /// library mapping (<see cref="ArrInstanceLibraries"/>), and the library indexes in memory.
    /// </summary>
    public sealed class RequestPlaces : IRequestPlaces
    {
        private readonly ArrStateStore _store;
        private readonly ArrInstanceLibraries _libraries;

        /// <summary>Creates the place facts (DI).</summary>
        public RequestPlaces(ArrStateStore store, ArrInstanceLibraries libraries)
        {
            _store = store;
            _libraries = libraries;
        }

        /// <inheritdoc />
        public async Task<RequestPlace?> PlaceAsync(string instanceId, string? rootFolder, string titleKey, CancellationToken ct)
        {
            if (string.IsNullOrEmpty(instanceId) || _store.Registry.Get(instanceId) is not { Usable: true } instance) return null;
            // The disk facts in memory, else one (cached, shared) read of the instance's system facts.
            var system = _store.PeekSystem(instance.Id) ?? (await _store.GetSystemAsync(instance, ct).ConfigureAwait(false)).Value;
            var root = rootFolder
                ?? (TitleKey.Parse(titleKey) is { } key ? Held(instance, key)?.Path : null)
                ?? instance.Defaults?.RootFolderPath
                ?? (system?.RootFolders is { Count: 1 } only ? only[0].Path : null);
            if (string.IsNullOrWhiteSpace(root)) return null;
            // The drive holding the folder (the arr's disk list), else the root folder's own free space.
            var disk = (system?.DiskSpace ?? Array.Empty<ArrDiskEntry>()).Concat(system?.RootFolders ?? Array.Empty<ArrDiskEntry>())
                .Where(d => d.Path != null && d.FreeSpace.HasValue && BridgePaths.IsUnder(root, d.Path))
                .OrderByDescending(d => d.Path!.Length)
                .FirstOrDefault();
            if (disk?.FreeSpace is not long free) return null;
            var target = _libraries.Resolve(instance, root);
            string? library = null;
            if (target.Libraries is { Count: 1 } ids)
            {
                var id = ids[0].ToString("N");
                library = _libraries.Libraries().FirstOrDefault(l => string.Equals(l.Id.Replace("-", string.Empty, StringComparison.Ordinal), id, StringComparison.OrdinalIgnoreCase))?.Name;
            }
            return new RequestPlace(string.IsNullOrWhiteSpace(library) ? null : library, Math.Max(0, free));
        }

        /// <inheritdoc />
        public string? FourKHolder(string titleKey)
        {
            if (TitleKey.Parse(titleKey) is not { } key) return null;
            var kind = key.IsMovie ? ArrKind.Radarr : ArrKind.Sonarr;
            foreach (var instance in _store.Registry.All().Where(i => i.Usable && i.Kind == kind && i.Role == ArrInstanceRole.FourK))
            {
                if (Held(instance, key) is { HasFile: true }) return instance.Name;
            }
            return null;
        }

        /// <summary>The title as the instance's library index in memory holds it (folder, whether it has files), or null.</summary>
        private (string? Path, bool HasFile)? Held(ArrConnection instance, TitleKey key) => HeldIn(_store.PeekLibrary(instance.Id), key);

        /// <summary>The title as a library index holds it (its folder, whether it has files), or null when it doesn't.</summary>
        /// <param name="library">An instance's library index (null: not read yet).</param>
        /// <param name="key">Title key (movie: TMDB or IMDb; series: TVDB, TMDB or IMDb).</param>
        internal static (string? Path, bool HasFile)? HeldIn(ArrLibrarySnapshot? library, TitleKey key)
        {
            if (library == null) return null;
            var title = key.Title;
            if (key.IsMovie)
            {
                var movie = title.Provider == "tmdb" && title.NumericId is int tmdb ? library.MovieByTmdb(tmdb) : library.MovieByImdb(title.Id);
                return movie == null ? null : (movie.Path, movie.HasFile);
            }
            var series = title.Provider switch
            {
                "tvdb" when title.NumericId is int tvdb => library.SeriesByTvdb(tvdb),
                "tmdb" when title.NumericId is int tmdbSeries => library.SeriesByTmdb(tmdbSeries),
                "imdb" => library.SeriesByImdb(title.Id),
                _ => null,
            };
            return series == null ? null : (series.Path, series.EpisodeFileCount > 0);
        }
    }
}
