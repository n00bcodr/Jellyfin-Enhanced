using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>
    /// <see cref="IArrJellyfinView"/> over the real library and user managers. Visibility is always
    /// Jellyfin's own check (<c>GetItemById(id, user)</c>: library access and parental limits).
    /// </summary>
    public sealed class ArrJellyfinView : IArrJellyfinView, IDisposable
    {
        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private long _revision;

        /// <summary>Creates the view and starts following library changes.</summary>
        public ArrJellyfinView(ILibraryManager libraryManager, IUserManager userManager)
        {
            _libraryManager = libraryManager;
            _userManager = userManager;
            _libraryManager.ItemAdded += OnItemChanged;
            _libraryManager.ItemUpdated += OnItemChanged;
            _libraryManager.ItemRemoved += OnItemChanged;
        }

        /// <inheritdoc />
        public long Revision => Interlocked.Read(ref _revision);

        /// <inheritdoc />
        public StatusViewer? Viewer(Guid userId)
        {
            // An API key's user id is the empty GUID, which Jellyfin 12 refuses to look up (it throws).
            var user = Helpers.ArrCaller.Find(userId, _userManager);
            if (user == null || user.HasPermission(PermissionKind.IsDisabled)) return null;
            var isAdmin = user.HasPermission(PermissionKind.IsAdministrator);
            var allFolders = user.HasPermission(PermissionKind.EnableAllFolders);
            var folders = allFolders ? Array.Empty<Guid>() : user.GetPreferenceValues<Guid>(PreferenceKind.EnabledFolders);
            var blockedTags = user.GetPreference(PreferenceKind.BlockedTags) ?? Array.Empty<string>();
            var allowedTags = user.GetPreference(PreferenceKind.AllowedTags) ?? Array.Empty<string>();
            var blockedUnrated = user.GetPreferenceValues<UnratedItem>(PreferenceKind.BlockUnratedItems);
            // Folders blocked through the user policy API: library access in another form (like
            // EnabledFolders), so part of the fingerprint but not a parental limit. A series' seasons
            // and episodes always sit in the series' own library, so they never hide parts of it.
            var blockedFolders = user.GetPreferenceValues<Guid>(PreferenceKind.BlockedMediaFolders);
            var parental = user.MaxParentalRatingScore.HasValue || blockedTags.Length > 0 || allowedTags.Length > 0 || blockedUnrated.Length > 0;

            var fingerprint = new StringBuilder();
            fingerprint.Append(isAdmin ? 'A' : 'U').Append('|').Append(allFolders ? '*' : '-').Append('|');
            foreach (var f in folders.OrderBy(f => f)) fingerprint.Append(f.ToString("N", CultureInfo.InvariantCulture)).Append(',');
            fingerprint.Append('|').Append(user.MaxParentalRatingScore?.ToString(CultureInfo.InvariantCulture) ?? "-")
                .Append('.').Append(user.MaxParentalRatingSubScore?.ToString(CultureInfo.InvariantCulture) ?? "-").Append('|');
            foreach (var t in blockedTags.OrderBy(t => t, StringComparer.Ordinal)) fingerprint.Append(t).Append(',');
            fingerprint.Append('|');
            foreach (var t in allowedTags.OrderBy(t => t, StringComparer.Ordinal)) fingerprint.Append(t).Append(',');
            fingerprint.Append('|');
            foreach (var u in blockedUnrated.OrderBy(u => u)) fingerprint.Append((int)u).Append(',');
            fingerprint.Append('|');
            foreach (var f in blockedFolders.OrderBy(f => f)) fingerprint.Append(f.ToString("N", CultureInfo.InvariantCulture)).Append(',');
            fingerprint.Append('|').Append(user.DisplayMissingEpisodes ? 'M' : '-');

            return new StatusViewer
            {
                UserId = user.Id,
                IsAdmin = isAdmin,
                DisplayMissingEpisodes = user.DisplayMissingEpisodes,
                HasParentalLimit = parental,
                PolicyRevision = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(fingerprint.ToString())), 0, 12),
                Handle = user,
            };
        }

        /// <inheritdoc />
        public JfItemRef? Resolve(Guid itemId, StatusViewer viewer)
        {
            if (viewer.Handle is not User user) return null;
            var item = _libraryManager.GetItemById<BaseItem>(itemId, user);
            switch (item)
            {
                case Movie movie:
                {
                    // The library lets an instance with linked libraries match this item on the batch route too.
                    var library = _libraryManager.GetCollectionFolders(movie).FirstOrDefault();
                    return new JfItemRef
                    {
                        ItemId = movie.Id,
                        Kind = "movie",
                        Key = TitleKey.ForMovie(movie.GetProviderId(MetadataProvider.Tmdb), movie.GetProviderId(MetadataProvider.Imdb)),
                        Path = movie.Path,
                        DateCreated = Utc(movie.DateCreated),
                        LibraryId = library?.Id.ToString("N", CultureInfo.InvariantCulture),
                        LibraryName = library?.Name,
                    };
                }
                case Series series:
                    return new JfItemRef
                    {
                        ItemId = series.Id,
                        Kind = "series",
                        Key = SeriesKey(series),
                        Path = series.Path,
                        DateCreated = Utc(series.DateCreated),
                    };
                case Season season:
                {
                    var series = season.Series;
                    var number = season.IndexNumber;
                    return new JfItemRef
                    {
                        ItemId = season.Id,
                        Kind = "season",
                        Key = series != null && number.HasValue ? SeriesKey(series)?.WithSeason(number.Value) : null,
                        SeriesId = series?.Id,
                        Season = number,
                        Virtual = season.LocationType == LocationType.Virtual,
                        Path = season.Path,
                        DateCreated = Utc(season.DateCreated),
                        TmdbId = TmdbOf(series),
                    };
                }
                case Episode episode:
                {
                    var series = episode.Series;
                    var season = episode.ParentIndexNumber;
                    var number = episode.IndexNumber;
                    return new JfItemRef
                    {
                        ItemId = episode.Id,
                        Kind = "episode",
                        Key = series != null && season.HasValue && number.HasValue ? SeriesKey(series)?.WithEpisode(season.Value, number.Value) : null,
                        SeriesId = series?.Id,
                        Season = season,
                        Episode = number,
                        EpisodeEnd = episode.IndexNumberEnd,
                        Virtual = episode.IsMissingEpisode,
                        Path = episode.Path,
                        DateCreated = Utc(episode.DateCreated),
                    };
                }
                default:
                    return null;
            }
        }

        /// <inheritdoc />
        public IReadOnlyList<JfCopy> Copies(TitleKey titleKey, StatusViewer viewer, IReadOnlyCollection<TitleKey>? aliases = null)
        {
            if (viewer.Handle is not User user) return Array.Empty<JfCopy>();
            // The key and its aliases of the same kind, one query per set of distinct providers
            // (Jellyfin matches any of the ids a query names; an item is listed once).
            var queries = TitleAliases.ProviderQueries(titleKey, aliases ?? Array.Empty<TitleKey>());
            var items = new List<BaseItem>();
            var found = new HashSet<Guid>();
            foreach (var providers in queries)
            {
                foreach (var item in _libraryManager.GetItemList(new InternalItemsQuery
                {
                    IncludeItemTypes = new[] { titleKey.IsMovie ? BaseItemKind.Movie : BaseItemKind.Series },
                    HasAnyProviderId = providers,
                    Recursive = true,
                    Limit = 20,
                    DtoOptions = new DtoOptions(false),
                }))
                {
                    if (items.Count < 20 && found.Add(item.Id)) items.Add(item);
                }
            }
            var copies = new List<JfCopy>(items.Count);
            foreach (var item in items)
            {
                var library = _libraryManager.GetCollectionFolders(item).FirstOrDefault();
                copies.Add(new JfCopy
                {
                    ItemId = item.Id,
                    Visible = _libraryManager.GetItemById<BaseItem>(item.Id, user) != null,
                    LibraryId = library?.Id.ToString("N", CultureInfo.InvariantCulture),
                    LibraryName = library?.Name,
                    Path = item.Path,
                    DateCreated = Utc(item.DateCreated),
                });
            }
            return copies;
        }

        /// <inheritdoc />
        public IReadOnlyList<JfEpisode> Episodes(Guid seriesItemId, int? season, StatusViewer viewer, bool includeVirtual)
        {
            if (viewer.Handle is not User user) return Array.Empty<JfEpisode>();
            if (_libraryManager.GetItemById<BaseItem>(seriesItemId, user) is not Series series) return Array.Empty<JfEpisode>();
            var options = new DtoOptions(false);
            IEnumerable<BaseItem> items;
            if (season.HasValue)
            {
                var seasonItem = series.GetSeasons(user, options).OfType<Season>().FirstOrDefault(s => s.IndexNumber == season.Value);
                if (seasonItem == null) return Array.Empty<JfEpisode>();
                items = seasonItem.GetEpisodes(user, options, includeVirtual);
            }
            else
            {
                items = series.GetEpisodes(user, options, includeVirtual);
            }
            var list = new List<JfEpisode>();
            var seen = new HashSet<Guid>();
            foreach (var e in items.OfType<Episode>())
            {
                var s = e.ParentIndexNumber ?? season;
                if (!s.HasValue || !e.IndexNumber.HasValue) continue;
                seen.Add(e.Id);
                list.Add(new JfEpisode
                {
                    ItemId = e.Id,
                    Season = s.Value,
                    Episode = e.IndexNumber.Value,
                    EpisodeEnd = e.IndexNumberEnd,
                    Virtual = e.IsMissingEpisode,
                    DateCreated = Utc(e.DateCreated),
                });
            }
            if (!viewer.IsAdmin && viewer.HasParentalLimit) AddHidden(series, season, user, includeVirtual, seen, list);
            return list;
        }

        /// <summary>
        /// Adds the episodes of the series that Jellyfin hides from this viewer (their own rating or
        /// tags, or a hidden season), with or without a file, as numbers only: without them the
        /// composer would read an episode Sonarr has a file for as "almost ready" for ever, and show
        /// Sonarr's status for missing episodes the viewer may not see.
        /// </summary>
        private void AddHidden(Series series, int? season, User user, bool includeVirtual, HashSet<Guid> seen, List<JfEpisode> list)
        {
            // No user on the query: every episode of the series, real or virtual, whoever may see it.
            var all = _libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { BaseItemKind.Episode },
                AncestorIds = new[] { series.Id },
                Recursive = true,
                DtoOptions = new DtoOptions(false),
            });
            var candidates = all.OfType<Episode>().Select(e => new EpisodeFacts(e.Id, e.ParentIndexNumber, e.IndexNumber, e.IndexNumberEnd, e.IsMissingEpisode || e.IsVirtualItem));
            list.AddRange(HiddenEpisodes(candidates, season, seen, includeVirtual, () => VisibleEpisodeIds(series, season, user)));
        }

        /// <summary>One episode of the unfiltered query (what the hidden-episode rule needs of it).</summary>
        internal readonly record struct EpisodeFacts(Guid Id, int? Season, int? Episode, int? EpisodeEnd, bool Virtual);

        /// <summary>
        /// The episodes of <paramref name="all"/> (every episode of the series, whoever may see it) the
        /// user's list (<paramref name="seen"/>) left out because Jellyfin hides them, as numbers only.
        /// A real episode missing from the list is hidden. A virtual one only when the user's list
        /// including missing episodes (<paramref name="seen"/> when it already did, else
        /// <paramref name="visibleWithMissing"/>, read once and only when needed) leaves it out too:
        /// one left out only because missing episodes weren't asked for (or aren't shown) is not hidden.
        /// </summary>
        internal static List<JfEpisode> HiddenEpisodes(IEnumerable<EpisodeFacts> all, int? season, HashSet<Guid> seen, bool seenIncludesVirtual, Func<HashSet<Guid>> visibleWithMissing)
        {
            var hidden = new List<JfEpisode>();
            var visibleVirtual = seenIncludesVirtual ? seen : null;
            foreach (var e in all)
            {
                if (seen.Contains(e.Id) || e.Season is not int s || e.Episode is not int n) continue;
                if (season.HasValue && s != season) continue;
                if (e.Virtual)
                {
                    visibleVirtual ??= visibleWithMissing();
                    if (visibleVirtual.Contains(e.Id)) continue;
                }
                hidden.Add(new JfEpisode { Season = s, Episode = n, EpisodeEnd = e.EpisodeEnd, Virtual = e.Virtual, Hidden = true });
            }
            return hidden;
        }

        /// <summary>Ids of the episodes the user may see, missing ones included.</summary>
        private static HashSet<Guid> VisibleEpisodeIds(Series series, int? season, User user)
        {
            var options = new DtoOptions(false);
            IEnumerable<BaseItem> items;
            if (season.HasValue)
            {
                var seasonItem = series.GetSeasons(user, options).OfType<Season>().FirstOrDefault(s => s.IndexNumber == season.Value);
                items = seasonItem?.GetEpisodes(user, options, true) ?? new List<BaseItem>();
            }
            else
            {
                items = series.GetEpisodes(user, options, true);
            }
            return items.Select(i => i.Id).ToHashSet();
        }

        /// <inheritdoc />
        public IReadOnlyList<JfSeason> Seasons(Guid seriesItemId, StatusViewer viewer)
        {
            if (viewer.Handle is not User user) return Array.Empty<JfSeason>();
            if (_libraryManager.GetItemById<BaseItem>(seriesItemId, user) is not Series series) return Array.Empty<JfSeason>();
            var list = series.GetSeasons(user, new DtoOptions(false)).OfType<Season>()
                .Where(s => s.IndexNumber.HasValue)
                .Select(s => new JfSeason { ItemId = s.Id, Season = s.IndexNumber!.Value })
                .ToList();
            if (!viewer.IsAdmin && viewer.HasParentalLimit) AddHiddenSeasons(series, user, list);
            return list;
        }

        /// <summary>
        /// Adds the seasons Jellyfin hides from this viewer, as numbers only. The user's season list
        /// can't tell: it also leaves out missing seasons when the user doesn't show missing episodes.
        /// So every season of the series (no user, real and virtual) is checked with Jellyfin's own
        /// visibility check; a number counts as hidden only when no season item with it is visible.
        /// </summary>
        private void AddHiddenSeasons(Series series, User user, List<JfSeason> list)
        {
            var all = _libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { BaseItemKind.Season },
                AncestorIds = new[] { series.Id },
                Recursive = true,
                DtoOptions = new DtoOptions(false),
            });
            var seasons = all.OfType<Season>().Select(s => (s.Id, s.IndexNumber));
            foreach (var number in HiddenSeasonNumbers(seasons, list.Select(s => s.Season), id => _libraryManager.GetItemById<BaseItem>(id, user) != null))
                list.Add(new JfSeason { Season = number, Hidden = true });
        }

        /// <summary>
        /// The season numbers of <paramref name="all"/> (every season of the series, real and virtual)
        /// that no season item the user can open carries: <paramref name="listed"/> (the user's list)
        /// first, then Jellyfin's own check (<paramref name="canOpen"/>) for the rest.
        /// </summary>
        internal static List<int> HiddenSeasonNumbers(IEnumerable<(Guid Id, int? Number)> all, IEnumerable<int> listed, Func<Guid, bool> canOpen)
        {
            var visible = listed.ToHashSet();
            var hidden = new SortedSet<int>();
            foreach (var (id, index) in all)
            {
                if (index is not int number || visible.Contains(number)) continue;
                if (canOpen(id)) visible.Add(number);
                else hidden.Add(number);
            }
            return hidden.Where(n => !visible.Contains(n)).ToList();
        }

        /// <summary>Stops following library changes.</summary>
        public void Dispose()
        {
            _libraryManager.ItemAdded -= OnItemChanged;
            _libraryManager.ItemUpdated -= OnItemChanged;
            _libraryManager.ItemRemoved -= OnItemChanged;
        }

        /// <summary>The TMDB id of a series, when Jellyfin has one.</summary>
        private static int? TmdbOf(Series? series)
            => int.TryParse(series?.GetProviderId(MetadataProvider.Tmdb), NumberStyles.None, CultureInfo.InvariantCulture, out var id) && id > 0 ? id : null;

        private static TitleKey? SeriesKey(Series series)
            => TitleKey.ForSeries(series.GetProviderId(MetadataProvider.Tvdb), series.GetProviderId(MetadataProvider.Tmdb), series.GetProviderId(MetadataProvider.Imdb));

        private static DateTime? Utc(DateTime value)
        {
            if (value.Year < 1900) return null;
            return value.Kind == DateTimeKind.Unspecified ? DateTime.SpecifyKind(value, DateTimeKind.Utc) : value.ToUniversalTime();
        }

        private void OnItemChanged(object? sender, ItemChangeEventArgs e)
        {
            if (e.Item is Movie or Series or Season or Episode) Interlocked.Increment(ref _revision);
        }
    }
}
