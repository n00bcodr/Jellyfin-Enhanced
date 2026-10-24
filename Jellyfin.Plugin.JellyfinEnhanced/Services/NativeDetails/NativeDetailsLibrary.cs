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
    /// What the library itself holds of a title, judged for one viewer (both Jellyfin targets: the native details pages
    /// use it on 12, the list import's physical-title projection on 12 and 10.11): every copy in any library
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

        /// <summary>The copies the viewer can open (Jellyfin's own check for them), in library order.</summary>
        public IReadOnlyList<Guid> Shown { get; init; } = Array.Empty<Guid>();

        /// <summary>Copies exist and the viewer can open none of them.</summary>
        public bool Hidden { get; init; }

        /// <summary>Season numbers the library has but no season item of which the viewer can open.</summary>
        public IReadOnlySet<int> HiddenSeasons { get; init; } = new HashSet<int>();

        /// <summary>Episode numbers (of the season asked for) the library has but the viewer can't open.</summary>
        public IReadOnlySet<int> HiddenEpisodes { get; init; } = new HashSet<int>();

        /// <summary>
        /// When every season was asked for: the episodes (season, number) the library has but the viewer
        /// can't open, in seasons they can (a hidden season's episodes are covered by <see cref="HiddenSeasons"/>).
        /// </summary>
        public IReadOnlySet<(int Season, int Episode)> HiddenSeriesEpisodes { get; init; } = new HashSet<(int Season, int Episode)>();

        /// <summary>Season numbers the viewer can open in the library, with the season item (a real one, not a placeholder).</summary>
        public IReadOnlyDictionary<int, Guid> VisibleSeasons { get; init; } = new Dictionary<int, Guid>();

        /// <summary>
        /// Episode numbers (of the season asked for) the viewer can open in the library, with the episode item (a file,
        /// not a missing-episode placeholder): each number a multi-episode file holds maps to that file.
        /// </summary>
        public IReadOnlyDictionary<int, Guid> VisibleEpisodes { get; init; } = new Dictionary<int, Guid>();

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
        // Provider queries per title: the native pages' TMDB id and its aliases; the import's every-id identity (each
        // query carries one value of each provider, so this bounds the distinct values per provider).
        private const int MaxAliasQueries = 4;
        private const int MaxIdentityQueries = 8;
        private static readonly TimeSpan Ttl = TimeSpan.FromSeconds(30);

        private readonly ILibraryManager _library;
        private readonly TitleAliases? _aliases;
        private readonly Func<long>? _revision;
        private ConcurrentDictionary<string, (long Revision, DateTime At, PhysicalTitle Value)> _cache = new(StringComparer.Ordinal);
        private readonly ConcurrentDictionary<string, (long Revision, DateTime At, bool Value)> _without = new(StringComparer.Ordinal);

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
        /// <param name="everySeason">With no <paramref name="season"/>: the hidden episodes of every season too (<see cref="PhysicalTitle.HiddenSeriesEpisodes"/>).</param>
        /// <returns>The physical title.</returns>
        public PhysicalTitle Read(User viewer, string viewerRevision, bool movie, int tmdb, int? season, bool everySeason = false)
        {
            everySeason &= season == null && !movie;
            return Cached(viewer, viewerRevision, movie, tmdb.ToString(CultureInfo.InvariantCulture), season?.ToString(CultureInfo.InvariantCulture) ?? (everySeason ? "*" : "-"), () => Compute(viewer, movie, TmdbKeys(movie, tmdb), MaxAliasQueries, season, everySeason));
        }

        /// <summary>
        /// What the library holds of a title for a viewer, asked under EVERY id the caller knows it by (the list import,
        /// review round 2, 4c2-R2-B1): a copy held only under its TVDB or IMDb id is found as well as one under TMDB. The
        /// arr libraries' and Seerr's aliases of each id are added as for <see cref="Read(User, string, bool, int, int?, bool)"/>.
        /// </summary>
        /// <param name="viewer">The effective viewer.</param>
        /// <param name="viewerRevision">The viewer's policy revision (part of the cache key).</param>
        /// <param name="movie">Movie (else series).</param>
        /// <param name="keys">Every key the title is known by (its TMDB, TVDB and IMDb ids; seasons ignored).</param>
        /// <param name="season">The season whose episodes are wanted, or null.</param>
        /// <returns>The physical title (<see cref="PhysicalTitle.None"/> without a usable key or a copy).</returns>
        public PhysicalTitle Read(User viewer, string viewerRevision, bool movie, IReadOnlyCollection<TitleKey> keys, int? season)
        {
            var titles = keys.Where(k => k.IsMovie == movie).Select(k => k.Title).Distinct().OrderBy(k => k.ToString(), StringComparer.Ordinal).ToList();
            if (titles.Count == 0) return PhysicalTitle.None;
            return Cached(viewer, viewerRevision, movie, string.Join(',', titles), season?.ToString(CultureInfo.InvariantCulture) ?? "-", () => Compute(viewer, movie, titles, MaxIdentityQueries, season, false));
        }

        /// <summary>
        /// True when the library holds copies (movies or series, any library) that carry none of <paramref name="providers"/>'
        /// ids, so a lookup under those ids alone can't find every copy of a title (no network I/O; cached like the reads).
        /// </summary>
        /// <param name="movie">Movies (else series).</param>
        /// <param name="providers">Providers of the ids at hand: "tmdb", "tvdb", "imdb".</param>
        /// <returns>True when such copies exist (or the library can't be asked: then the caller can't rely on those ids).</returns>
        public bool HoldsCopiesWithout(bool movie, IReadOnlyCollection<string> providers)
        {
            var key = "without|" + (movie ? "m" : "t") + "|" + string.Join(',', providers.OrderBy(p => p, StringComparer.Ordinal));
            var revision = _revision?.Invoke();
            if (revision is long r && _without.TryGetValue(key, out var hit) && hit.Revision == r && DateTime.UtcNow - hit.At < Ttl) return hit.Value;
            var value = (_library.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { movie ? BaseItemKind.Movie : BaseItemKind.Series },
                HasTmdbId = providers.Contains("tmdb") ? false : null,
                HasTvdbId = !movie && providers.Contains("tvdb") ? false : null,
                HasImdbId = providers.Contains("imdb") ? false : null,
                Recursive = true,
                Limit = 1,
                DtoOptions = new DtoOptions(false),
            }) ?? new List<BaseItem>()).Count > 0;
            if (revision is long now)
            {
                if (_without.Count >= MaxEntries) _without.Clear();
                _without[key] = (now, DateTime.UtcNow, value);
            }

            return value;
        }

        private static IReadOnlyList<TitleKey> TmdbKeys(bool movie, int tmdb) =>
            TitleKey.Parse((movie ? "movie" : "tv") + ":tmdb:" + tmdb.ToString(CultureInfo.InvariantCulture)) is { } key && tmdb > 0 ? new[] { key } : Array.Empty<TitleKey>();

        /// <summary>
        /// The title's copies only (<see cref="PhysicalTitle.Copies"/>, <see cref="PhysicalTitle.Shown"/>,
        /// <see cref="PhysicalTitle.Hidden"/>; no season or episode facts), for lists of many titles.
        /// </summary>
        /// <param name="viewer">The effective viewer.</param>
        /// <param name="viewerRevision">The viewer's policy revision (part of the cache key).</param>
        /// <param name="movie">Movie (else series).</param>
        /// <param name="tmdb">TMDB id.</param>
        /// <returns>The physical title, without season or episode facts.</returns>
        public PhysicalTitle ReadCopies(User viewer, string viewerRevision, bool movie, int tmdb)
            => Cached(viewer, viewerRevision, movie, tmdb.ToString(CultureInfo.InvariantCulture), "c", () => Copies(viewer, movie, TmdbKeys(movie, tmdb), MaxAliasQueries).Title);

        private PhysicalTitle Cached(User viewer, string viewerRevision, bool movie, string title, string part, Func<PhysicalTitle> compute)
        {
            using var __factsOperation0 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            var key = string.Join('|', viewer.Id.ToString("N", CultureInfo.InvariantCulture), viewerRevision, movie ? "m" : "t", title, part);
            var revision = _revision?.Invoke();
            if (revision is long r && _cacheFacts.TryGetValue(key, out var hit) && hit.Revision == r && DateTime.UtcNow - hit.At < Ttl) return hit.Value;
            var value = compute();
            if (revision is long now)
            {
                if (_cacheFacts.Count >= MaxEntries) _cacheFacts.Clear();
                _cacheFacts[key] = (now, DateTime.UtcNow, value);
            }

            return value;
        }

        /// <summary>Every copy of the title in any library (no user on the query), and which of them the viewer can open.</summary>
        private (PhysicalTitle Title, HashSet<Guid> Shown) Copies(User viewer, bool movie, IReadOnlyList<TitleKey> keys, int maxQueries)
        {
            if (keys.Count == 0) return (PhysicalTitle.None, new HashSet<Guid>());
            var key = keys[0];
            var aliases = keys.Skip(1).Concat(keys.SelectMany(k => _aliases?.Of(k) ?? (IReadOnlyList<TitleKey>)Array.Empty<TitleKey>())).ToList();
            var copies = new List<BaseItem>();
            var seen = new HashSet<Guid>();
            // "No copy" (and "the viewer can open none") is only an answer once every alias query has been read to its
            // end: the shared builder caps one call at four queries, so the aliases go in slices that each fit, and no
            // query has a row limit. A capped read could hide a copy the viewer can open, or prove an absence it never saw.
            // (maxQueries, the import's every-id bound, is met too: every slice is read.)
            _ = maxQueries;
            IEnumerable<TitleKey[]> slices = aliases.Count == 0 ? new[] { Array.Empty<TitleKey>() } : aliases.Chunk(3);
            foreach (var providers in slices.SelectMany(slice => TitleAliases.ProviderQueries(key, slice)))
            {
                // No user on the query: every copy in any library, whoever may see it.
                var found = _library.GetItemList(new InternalItemsQuery
                {
                    IncludeItemTypes = new[] { movie ? BaseItemKind.Movie : BaseItemKind.Series },
                    HasAnyProviderId = providers,
                    Recursive = true,
                    DtoOptions = new DtoOptions(false),
                });
                foreach (var item in found ?? new List<BaseItem>())
                {
                    if (seen.Add(item.Id)) copies.Add(item);
                }
            }

            if (copies.Count == 0) return (PhysicalTitle.None, new HashSet<Guid>());
            var ids = copies.Select(c => c.Id).ToArray();
            var shownInOrder = ids.Where(id => CanOpen(id, viewer)).ToArray();
            var shown = shownInOrder.ToHashSet();
            return (new PhysicalTitle { Copies = ids, Shown = shownInOrder, Hidden = shown.Count == 0 }, shown);
        }

        private PhysicalTitle Compute(User viewer, bool movie, IReadOnlyList<TitleKey> keys, int maxQueries, int? season, bool everySeason)
        {
            var (title, shown) = Copies(viewer, movie, keys, maxQueries);
            if (title.Copies.Count == 0 || title.Hidden || movie) return title;
            var ids = title.Copies.ToArray();

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
            // The seasons the viewer can open: a list of the title's seasons shows these as they are, never
            // a stand-in from public data.
            var visibleSeasons = new Dictionary<int, Guid>();
            foreach (var s in seasons.Where(s => !s.IsVirtualItem && !hiddenSeasons.Contains(s.IndexNumber!.Value)))
            {
                if (!visibleSeasons.ContainsKey(s.IndexNumber!.Value) && Visible(s.Id, s.SeriesId)) visibleSeasons[s.IndexNumber.Value] = s.Id;
            }

            var hiddenEpisodes = new HashSet<int>();
            var hiddenSeriesEpisodes = new HashSet<(int Season, int Episode)>();
            var visibleEpisodes = new Dictionary<int, Guid>();
            // The season asked for, or every season the viewer can see (a hidden season hides all of its episodes).
            var wanted = seasons.Where(s => season is int number ? s.IndexNumber == number && !hiddenSeasons.Contains(number) : everySeason && !hiddenSeasons.Contains(s.IndexNumber!.Value)).ToList();
            if (wanted.Count > 0)
            {
                var numberOf = wanted.GroupBy(s => s.Id).ToDictionary(g => g.Key, g => g.First().IndexNumber!.Value);
                var episodes = (_library.GetItemList(new InternalItemsQuery
                {
                    IncludeItemTypes = new[] { BaseItemKind.Episode },
                    AncestorIds = numberOf.Keys.ToArray(),
                    Recursive = true,
                    DtoOptions = new DtoOptions(false),
                }) ?? new List<BaseItem>()).OfType<Episode>().Where(e => e.IndexNumber.HasValue);
                var visible = new HashSet<(int Season, int Episode)>();
                var hidden = new HashSet<(int Season, int Episode)>();
                foreach (var e in episodes)
                {
                    // Under one season: that season; under several, the episode's own (else the season item holding it).
                    int? inSeason = season ?? e.ParentIndexNumber ?? (numberOf.TryGetValue(e.SeasonId, out var held) ? held : null);
                    if (inSeason is not int s) continue;
                    var first = e.IndexNumber!.Value;
                    var last = Math.Clamp(e.IndexNumberEnd ?? first, first, first + MaxRange);
                    var numbers = Enumerable.Range(first, last - first + 1).Select(n => (s, n));
                    if (Visible(e.Id, e.SeriesId))
                    {
                        visible.UnionWith(numbers);
                        // A file the viewer can open stands for its episodes in the asked season's list: every
                        // number a multi-episode file (E01-E02) holds, so none of them is drawn as missing.
                        if (season is int only && !e.IsVirtualItem && s == only)
                        {
                            foreach (var (_, n) in numbers) visibleEpisodes.TryAdd(n, e.Id);
                        }
                    }
                    else
                    {
                        hidden.UnionWith(numbers);
                    }
                }

                // A number some visible item carries (another copy, a multi-part file) is not hidden.
                hidden.ExceptWith(visible);
                if (season is int asked) hiddenEpisodes.UnionWith(hidden.Where(p => p.Season == asked).Select(p => p.Episode));
                else hiddenSeriesEpisodes.UnionWith(hidden);
            }

            return new PhysicalTitle
            {
                Copies = ids,
                Shown = title.Shown,
                HiddenSeasons = hiddenSeasons,
                HiddenEpisodes = hiddenEpisodes,
                HiddenSeriesEpisodes = hiddenSeriesEpisodes,
                VisibleSeasons = visibleSeasons,
                VisibleEpisodes = visibleEpisodes,
            };
        }

        private bool CanOpen(Guid id, User viewer) => _library.GetItemById<BaseItem>(id, viewer) != null;
        private readonly global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.State<ConcurrentDictionary<string, (long Revision, DateTime At, PhysicalTitle Value)>> _cacheFactsOwner = new();
        private ConcurrentDictionary<string, (long Revision, DateTime At, PhysicalTitle Value)> _cacheFacts { get => _cacheFactsOwner.Read(ref _cache, () => new(StringComparer.Ordinal)); set => _cacheFactsOwner.Store(ref _cache, value); }
    }
}
