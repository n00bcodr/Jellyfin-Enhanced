#if JF12
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails
{
    /// <summary>
    /// What the library itself holds of a title, judged for one viewer: every copy in any library
    /// (no user on the query), then Jellyfin's own visibility. A synthetic page must never stand in
    /// for a library row Jellyfin hides from the viewer (parental rating, custom rating, tags, library
    /// access), so hidden copies, seasons and episodes are named here.
    /// </summary>
    public sealed class PhysicalTitle
    {
        /// <summary>No copy anywhere: nothing hidden.</summary>
        public static readonly PhysicalTitle None = new();

        /// <summary>Every library copy of the title (any library, whoever may see it).</summary>
        public IReadOnlyList<Guid> Copies { get; init; } = Array.Empty<Guid>();

        /// <summary>Copies exist and the viewer can open none of them.</summary>
        public bool Hidden { get; init; }

        /// <summary>Season numbers the library has but no season item of which the viewer can open.</summary>
        public IReadOnlySet<int> HiddenSeasons { get; init; } = new HashSet<int>();

        /// <summary>Episode numbers (of the season asked for) the library has but the viewer can't open.</summary>
        public IReadOnlySet<int> HiddenEpisodes { get; init; } = new HashSet<int>();

        /// <summary>True when the title, a season or an episode of a synthetic id is hidden from the viewer.</summary>
        /// <param name="id">Synthetic id.</param>
        /// <returns>True when hidden.</returns>
        public bool Hides(SyntheticId id)
        {
            if (Hidden) return true;
            if (id.Kind is SyntheticKind.Season or SyntheticKind.Episode && HiddenSeasons.Contains(id.Season)) return true;
            return id.Kind == SyntheticKind.Episode && HiddenEpisodes.Contains(id.Episode);
        }
    }

    /// <summary>
    /// Reads <see cref="PhysicalTitle"/>s from the library (no network I/O), cached per viewer policy
    /// revision and library revision for a short while (artwork asks once per image).
    /// </summary>
    public sealed class NativeDetailsLibrary
    {
        private const int MaxEntries = 2000;
        private const int MaxRange = 50;
        private static readonly TimeSpan Ttl = TimeSpan.FromSeconds(30);

        private readonly ILibraryManager _library;
        private readonly TitleAliases? _aliases;
        private readonly Func<long>? _revision;
        private readonly ConcurrentDictionary<string, (long Revision, DateTime At, PhysicalTitle Value)> _cache = new(StringComparer.Ordinal);

        /// <summary>Creates the reader.</summary>
        /// <param name="library">Library manager.</param>
        /// <param name="aliases">The title's other provider ids (TVDB/IMDb), when known.</param>
        /// <param name="revision">Library revision (changes on every add/update/remove); without it nothing is cached.</param>
        public NativeDetailsLibrary(ILibraryManager library, TitleAliases? aliases = null, Func<long>? revision = null)
        {
            _library = library;
            _aliases = aliases;
            _revision = revision;
        }

        /// <summary>What the library holds of a title for a viewer.</summary>
        /// <param name="viewer">The effective viewer.</param>
        /// <param name="viewerRevision">The viewer's policy revision (part of the cache key).</param>
        /// <param name="movie">Movie (else series).</param>
        /// <param name="tmdb">TMDB id.</param>
        /// <param name="season">The season whose episodes are wanted, or null.</param>
        /// <returns>The physical title.</returns>
        public PhysicalTitle Read(User viewer, string viewerRevision, bool movie, int tmdb, int? season)
        {
            var key = string.Join('|', viewer.Id.ToString("N", CultureInfo.InvariantCulture), viewerRevision, movie ? "m" : "t", tmdb.ToString(CultureInfo.InvariantCulture), season?.ToString(CultureInfo.InvariantCulture) ?? "-");
            var revision = _revision?.Invoke();
            if (revision is long r && _cache.TryGetValue(key, out var hit) && hit.Revision == r && DateTime.UtcNow - hit.At < Ttl) return hit.Value;
            var value = Compute(viewer, movie, tmdb, season);
            if (revision is long now)
            {
                if (_cache.Count >= MaxEntries) _cache.Clear();
                _cache[key] = (now, DateTime.UtcNow, value);
            }

            return value;
        }

        private PhysicalTitle Compute(User viewer, bool movie, int tmdb, int? season)
        {
            var key = TitleKey.Parse((movie ? "movie" : "tv") + ":tmdb:" + tmdb.ToString(CultureInfo.InvariantCulture));
            if (key == null || tmdb <= 0) return PhysicalTitle.None;
            var aliases = _aliases?.Of(key) ?? (IReadOnlyList<TitleKey>)Array.Empty<TitleKey>();
            var copies = new List<BaseItem>();
            var seen = new HashSet<Guid>();
            foreach (var providers in TitleAliases.ProviderQueries(key, aliases))
            {
                // No user on the query: every copy in any library, whoever may see it.
                var found = _library.GetItemList(new InternalItemsQuery
                {
                    IncludeItemTypes = new[] { movie ? BaseItemKind.Movie : BaseItemKind.Series },
                    HasAnyProviderId = providers,
                    Recursive = true,
                    Limit = 20,
                    DtoOptions = new DtoOptions(false),
                });
                foreach (var item in found ?? new List<BaseItem>())
                {
                    if (seen.Add(item.Id)) copies.Add(item);
                }
            }

            if (copies.Count == 0) return PhysicalTitle.None;
            var ids = copies.Select(c => c.Id).ToArray();
            var shown = ids.Where(id => CanOpen(id, viewer)).ToHashSet();
            if (shown.Count == 0) return new PhysicalTitle { Copies = ids, Hidden = true };
            if (movie) return new PhysicalTitle { Copies = ids };

            // Without parental rules a season or episode is visible exactly when its series is (it sits in
            // that series' library); with them, Jellyfin's own check per item (rating, custom rating,
            // inherited and own tags, the parent chain).
            var parental = ArrJellyfinView.HasParentalLimit(viewer);
            bool Visible(Guid id, Guid series) => parental || series == Guid.Empty ? CanOpen(id, viewer) : shown.Contains(series);

            var seasons = (_library.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { BaseItemKind.Season },
                AncestorIds = ids,
                Recursive = true,
                DtoOptions = new DtoOptions(false),
            }) ?? new List<BaseItem>()).OfType<Season>().Where(s => s.IndexNumber.HasValue).ToList();
            var hiddenSeasons = seasons.GroupBy(s => s.IndexNumber!.Value)
                .Where(g => !g.Any(s => Visible(s.Id, s.SeriesId)))
                .Select(g => g.Key)
                .ToHashSet();

            var hiddenEpisodes = new HashSet<int>();
            if (season is int number && !hiddenSeasons.Contains(number))
            {
                var holders = seasons.Where(s => s.IndexNumber == number).Select(s => s.Id).ToArray();
                if (holders.Length > 0)
                {
                    var episodes = (_library.GetItemList(new InternalItemsQuery
                    {
                        IncludeItemTypes = new[] { BaseItemKind.Episode },
                        AncestorIds = holders,
                        Recursive = true,
                        DtoOptions = new DtoOptions(false),
                    }) ?? new List<BaseItem>()).OfType<Episode>().Where(e => e.IndexNumber.HasValue);
                    var visible = new HashSet<int>();
                    foreach (var e in episodes)
                    {
                        var first = e.IndexNumber!.Value;
                        var last = Math.Clamp(e.IndexNumberEnd ?? first, first, first + MaxRange);
                        var numbers = Enumerable.Range(first, last - first + 1);
                        if (Visible(e.Id, e.SeriesId)) visible.UnionWith(numbers);
                        else hiddenEpisodes.UnionWith(numbers);
                    }

                    // A number some visible item carries (another copy, a multi-part file) is not hidden.
                    hiddenEpisodes.ExceptWith(visible);
                }
            }

            return new PhysicalTitle { Copies = ids, HiddenSeasons = hiddenSeasons, HiddenEpisodes = hiddenEpisodes };
        }

        private bool CanOpen(Guid id, User viewer) => _library.GetItemById<BaseItem>(id, viewer) != null;
    }
}
#endif
