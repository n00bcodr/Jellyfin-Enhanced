using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    // Shared "does auto-enable apply to this title?" gate for the three
    // Spoiler Guard auto-enable modes (first play, Seerr request, library
    // add). Two dimensions, both admin-configured:
    //
    //   * content type — SpoilerAutoEnableSeries / SpoilerAutoEnableMovies
    //   * library      — SpoilerAutoEnableLibraryIds, a comma-separated
    //                    allow-list of library (CollectionFolder) ids; empty
    //                    means every library.
    //
    // Both default to "everything", so an install that never touches the
    // scope keeps the exact auto-enable behaviour it had before the scope
    // existed.
    public static class SpoilerAutoEnableFilter
    {
        // The raw allow-list string is parsed on every call for the rare
        // paths (first play, per-flush in the library-add batcher), so cache
        // the last parse keyed by the raw string: config saves are rare, the
        // string is reference-stable between them, and an ordinal compare on
        // a miss is still cheaper than re-splitting.
        private static string? _cachedRaw;
        private static HashSet<Guid>? _cachedIds;
        private static readonly object _cacheLock = new();

        public static bool AllowsType(PluginConfiguration? cfg, bool isSeries)
        {
            if (cfg == null) return false;
            return isSeries ? cfg.SpoilerAutoEnableSeries : cfg.SpoilerAutoEnableMovies;
        }

        // Null = no library restriction configured (every library qualifies).
        public static HashSet<Guid>? GetAllowedLibraryIds(PluginConfiguration? cfg)
        {
            var raw = cfg?.SpoilerAutoEnableLibraryIds;
            if (string.IsNullOrWhiteSpace(raw)) return null;

            lock (_cacheLock)
            {
                if (string.Equals(raw, _cachedRaw, StringComparison.Ordinal)) return _cachedIds;

                var ids = new HashSet<Guid>();
                foreach (var part in raw.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                {
                    if (Guid.TryParse(part, out var id) && id != Guid.Empty) ids.Add(id);
                }
                _cachedRaw = raw;
                // An allow-list made only of unparsable junk is treated as
                // "no restriction" rather than "nothing qualifies" — the
                // config page only ever writes ids it got from Jellyfin, so
                // this can only happen from a hand-edited XML.
                _cachedIds = ids.Count > 0 ? ids : null;
                return _cachedIds;
            }
        }

        // Library ids (CollectionFolder ids) the item belongs to. A title can
        // sit in more than one library when two libraries share a path.
        public static List<Guid> GetLibraryIds(ILibraryManager libraryManager, BaseItem item)
        {
            try
            {
                return libraryManager.GetCollectionFolders(item).Select(f => f.Id).ToList();
            }
            catch
            {
                return new List<Guid>();
            }
        }

        public static bool AllowsLibrary(PluginConfiguration? cfg, ILibraryManager libraryManager, BaseItem item)
        {
            var allowed = GetAllowedLibraryIds(cfg);
            if (allowed == null) return true;
            return AllowsLibrary(allowed, GetLibraryIds(libraryManager, item));
        }

        public static bool AllowsLibrary(HashSet<Guid>? allowed, IReadOnlyList<Guid> itemLibraryIds)
        {
            if (allowed == null) return true;
            for (var i = 0; i < itemLibraryIds.Count; i++)
            {
                if (allowed.Contains(itemLibraryIds[i])) return true;
            }
            return false;
        }
    }
}
