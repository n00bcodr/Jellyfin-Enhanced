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
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;

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
            return ViewerOf(user);
        }

        /// <summary>
        /// The viewer as <paramref name="user"/> (one read of them): every fact of the viewer, its policy revision and its
        /// handle come from this same object, so what is decided with it and what it is keyed by agree.
        /// </summary>
        /// <param name="user">The user, as read.</param>
        /// <returns>The viewer.</returns>
        internal static StatusViewer ViewerOf(User user) => new()
        {
            UserId = user.Id,
            IsAdmin = user.HasPermission(PermissionKind.IsAdministrator),
            DisplayMissingEpisodes = user.DisplayMissingEpisodes,
            HasParentalLimit = HasParentalLimit(user),
            PolicyRevision = PolicyRevisionOf(user),
            Handle = user,
        };

        /// <summary>
        /// The policy revision of <paramref name="user"/> as read (<see cref="StatusViewer.PolicyRevision"/>): role,
        /// library access (all, enabled and blocked folders), parental settings and "show missing episodes"
        /// (<see cref="Helpers.UserAuthority.AppendPolicy"/>). A cache that decides with a user object keys by the
        /// revision of that same object, never by another read of the user, which a change can land between.
        /// </summary>
        /// <param name="user">The user.</param>
        /// <returns>The revision.</returns>
        public static string PolicyRevisionOf(JUser user)
        {
            var fingerprint = new StringBuilder();
            Helpers.UserAuthority.AppendPolicy(fingerprint, user);
            return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(fingerprint.ToString())), 0, 12);
        }

        /// <summary>
        /// True when Jellyfin's parental rules can hide parts of a series from this user (a rating limit,
        /// tag rules or blocked unrated items). Without them a series' seasons and episodes are visible
        /// exactly when the series is: they sit in its library.
        /// </summary>
        /// <param name="user">User.</param>
        /// <returns>True when the user has a parental limit.</returns>
        internal static bool HasParentalLimit(User user)
            => user.MaxParentalRatingScore.HasValue
                || (user.GetPreference(PreferenceKind.BlockedTags)?.Length ?? 0) > 0
                || (user.GetPreference(PreferenceKind.AllowedTags)?.Length ?? 0) > 0
                || user.GetPreferenceValues<UnratedItem>(PreferenceKind.BlockUnratedItems).Length > 0;

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
                        Versions = movie.MediaSourceCount,
                        PrimaryId = PrimaryOf(movie),
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
                        Versions = episode.IsMissingEpisode ? 0 : episode.MediaSourceCount,
                        PrimaryId = PrimaryOf(episode),
                    };
                }
                default:
                    return null;
            }
        }

        /// <inheritdoc />
        public IReadOnlyList<JfCopy> Copies(TitleKey titleKey, StatusViewer viewer, IReadOnlyCollection<TitleKey>? aliases = null)
        {
            var user = viewer.Handle as User;
            if (user == null && !viewer.IsLibraryContext) return Array.Empty<JfCopy>();
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
                    Visible = user == null || _libraryManager.GetItemById<BaseItem>(item.Id, user) != null,
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

        /// <inheritdoc />
        public IReadOnlyList<Guid> SeriesParts(Guid seriesItemId, int season, int? episode, StatusViewer viewer)
        {
            if (viewer.Handle is not User user) return Array.Empty<Guid>();
            if (_libraryManager.GetItemById<BaseItem>(seriesItemId, user) is not Series series) return Array.Empty<Guid>();
            // The series item's own folders (its ancestry), not its presentation key: with automatic series
            // grouping, Series.GetSeasons and GetEpisodes also list the other folders' items. No user on the
            // query: the caller resolves each id as the viewer.
            var items = _libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { episode.HasValue ? BaseItemKind.Episode : BaseItemKind.Season },
                AncestorIds = new[] { series.Id },
                Recursive = true,
                DtoOptions = new DtoOptions(false),
            });
            return SeriesPartIds(items, series.Id, season, episode);
        }

        /// <summary>
        /// The filter of <see cref="SeriesParts"/>: of <paramref name="items"/>, the season <paramref name="season"/>
        /// (<paramref name="episode"/> null) or the episodes of that season containing <paramref name="episode"/>
        /// (<see cref="Episode.ContainsEpisodeNumber"/>) whose own series is <paramref name="seriesId"/>, leaving out
        /// an episode that is another item's version (Jellyfin 12 adds a second file of an episode as an item owned
        /// by the first).
        /// </summary>
        internal static List<Guid> SeriesPartIds(IEnumerable<BaseItem> items, Guid seriesId, int season, int? episode)
        {
            if (seriesId.Equals(Guid.Empty)) return new List<Guid>();
            return items.Where(i => i switch
            {
                Episode e => episode is int n && e.SeriesId.Equals(seriesId) && e.ParentIndexNumber == season
                    && e.IndexNumber.HasValue && e.ContainsEpisodeNumber(n) && !IsAnotherItemsVersion(e),
                Season s => episode == null && s.SeriesId.Equals(seriesId) && s.IndexNumber == season,
                _ => false,
            }).Select(i => i.Id).ToList();
        }

        /// <inheritdoc />
        public Guid? VersionHolder(Guid itemId, IReadOnlyList<Guid> candidates, StatusViewer viewer)
        {
            if (viewer.Handle is not User user || itemId.Equals(Guid.Empty)) return null;
            foreach (var id in candidates)
            {
                // Jellyfin ids an item by its path and type: the deleted item is the one a path the holder keeps
                // as a version had as an item of the holder's type (10.11 gives the version itself another id, as a Video).
                if (_libraryManager.GetItemById<BaseItem>(id, user) is not Video video) continue;
                if (video.LocalAlternateVersions.Any(path => _libraryManager.GetNewItemId(path, video.GetType()).Equals(itemId))
                    || video.LinkedAlternateVersions.Any(link => link.ItemId is Guid linked && linked.Equals(itemId)))
                {
                    return video.Id;
                }
            }
            return null;
        }

        /// <inheritdoc />
        public IReadOnlyList<JfSource> Sources(Guid itemId, StatusViewer viewer, bool readDimensions = true)
            => Openable(itemId, viewer) is Video video and (Movie or Episode) ? (readDimensions ? SourcesOf(video, viewer) : ItsOwnSource(video)) : Array.Empty<JfSource>();

        /// <summary>The item when the viewer can open it (Jellyfin's own check), or any item for the library context.</summary>
        private BaseItem? Openable(Guid itemId, StatusViewer viewer)
            => viewer.IsLibraryContext ? _libraryManager.GetItemById(itemId)
                : viewer.Handle is User user ? _libraryManager.GetItemById<BaseItem>(itemId, user) : null;

        /// <inheritdoc />
        public IReadOnlyList<JfEpisodeSources> EpisodeSources(Guid seriesItemId, int? season, StatusViewer viewer, bool readDimensions = true)
        {
            if (Openable(seriesItemId, viewer) is not Series series) return Array.Empty<JfEpisodeSources>();
            // The series item's own folders (its ancestry), not its presentation key: another grouped folder's
            // episodes are that series item's, judged when it is a copy of its own.
            var items = _libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { BaseItemKind.Episode },
                AncestorIds = new[] { series.Id },
                Recursive = true,
                IsVirtualItem = false,
                ParentIndexNumber = season,
                DtoOptions = new DtoOptions(false),
            });
            var list = new List<JfEpisodeSources>();
            foreach (var e in items.OfType<Episode>())
            {
                if (!OwnPlayableEpisode(e, series.Id, season) || Openable(e.Id, viewer) == null) continue;
                var sources = readDimensions ? SourcesOf(e, viewer) : ItsOwnSource(e);
                list.Add(new JfEpisodeSources { ItemId = e.Id, Season = e.ParentIndexNumber!.Value, Episode = e.IndexNumber!.Value, EpisodeEnd = e.IndexNumberEnd, Sources = sources });
            }
            return list;
        }

        /// <summary>
        /// The filter of <see cref="EpisodeSources"/>: a numbered episode with a file whose own series is
        /// <paramref name="seriesId"/> (of <paramref name="season"/> when given), never another item's version.
        /// </summary>
        internal static bool OwnPlayableEpisode(Episode e, Guid seriesId, int? season)
            => !seriesId.Equals(Guid.Empty) && e.SeriesId.Equals(seriesId) && !e.IsVirtualItem && !string.IsNullOrEmpty(e.Path)
                && e.ParentIndexNumber is int s && (season == null || s == season) && e.IndexNumber.HasValue && !IsAnotherItemsVersion(e);

        /// <inheritdoc />
        public IReadOnlyList<Guid> GroupedSeries(Guid seriesItemId, StatusViewer viewer)
        {
            if (viewer.Handle is not User user) return Array.Empty<Guid>();
            if (_libraryManager.GetItemById<BaseItem>(seriesItemId, user) is not Series series) return Array.Empty<Guid>();
            var key = series.PresentationUniqueKey;
            if (string.IsNullOrEmpty(key)) return Array.Empty<Guid>();
            return _libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { BaseItemKind.Series },
                PresentationUniqueKey = key,
                Recursive = true,
                DtoOptions = new DtoOptions(false),
            }).Where(i => !i.Id.Equals(series.Id) && _libraryManager.GetItemById<BaseItem>(i.Id, user) is Series).Select(i => i.Id).ToList();
        }

        /// <summary>
        /// A movie's or episode's own file as its one source, without reading its media sources (dimensions unknown).
        /// None for a missing (virtual) item or a placeholder.
        /// </summary>
        private static List<JfSource> ItsOwnSource(Video video)
            => Playable(video) ? new List<JfSource> { new() { SourceId = video.Id, ItemId = video.Id, BackingItemId = video.Id, Path = video.Path, DateCreated = Utc(video.DateCreated) } } : new List<JfSource>();

        /// <summary>True for a movie or episode with a file (a missing episode is a virtual item without one).</summary>
        private static bool Playable(Video video) => !video.IsVirtualItem && !video.IsPlaceHolder && !string.IsNullOrEmpty(video.Path);

        /// <summary>
        /// The playable sources of a movie or episode as Jellyfin plays them (its media sources, every version
        /// included), each with its video stream's dimensions. None for a missing (virtual) item or a placeholder.
        /// A version played by another item counts only when the viewer can open that item (Jellyfin's own check:
        /// library access and parental limits); the library context opens every one.
        /// </summary>
        private List<JfSource> SourcesOf(Video video, StatusViewer viewer)
        {
            var list = new List<JfSource>();
            if (!Playable(video)) return list;
            foreach (var source in video.GetMediaSources(false))
            {
                if (source.Protocol != MediaProtocol.File || string.IsNullOrEmpty(source.Path) || source.Type == MediaSourceType.Placeholder) continue;
                var stream = source.MediaStreams?.Where(s => s.Type == MediaStreamType.Video).OrderByDescending(s => (s.Width ?? 0) * (long)(s.Height ?? 0)).FirstOrDefault();
                var id = Guid.TryParse(source.Id, out var parsed) ? parsed : video.Id;
                // The item that plays exactly this file: the primary for its own path, else the version's item by
                // source id, else by path. A source with none is not credited to the primary (nothing could insert it),
                // nor is one whose item the viewer can't open (a linked version in another library, or one rated above
                // their limit).
                var version = id.Equals(video.Id) || string.Equals(source.Path, video.Path, StringComparison.Ordinal) ? video
                    : _libraryManager.GetItemById(id) as Video ?? _libraryManager.FindByPath(source.Path, false) as Video;
                if (version == null || (!ReferenceEquals(version, video) && Openable(version.Id, viewer) is not Video)) continue;
                list.Add(new JfSource
                {
                    SourceId = id,
                    ItemId = video.Id,
                    BackingItemId = version.Id,
                    Width = stream?.Width,
                    Height = stream?.Height,
                    Path = source.Path,
                    DateCreated = Utc(version.DateCreated),
                });
            }
            return list;
        }

        /// <summary>
        /// The item a movie or episode is a version of, when Jellyfin keeps it as another item's alternate version
        /// (owned by it; 12.x keeps the item a new primary file displaced that way); null for a primary item.
        /// </summary>
        internal static Guid? PrimaryOf(Video video)
        {
#if JF12
            if (video.PrimaryVersionId is Guid primary && !primary.Equals(Guid.Empty) && !primary.Equals(video.Id)) return primary;
#else
            if (Guid.TryParse(video.PrimaryVersionId, out var primary) && !primary.Equals(Guid.Empty) && !primary.Equals(video.Id)) return primary;
#endif
            return video.ExtraType == null && !video.OwnerId.Equals(Guid.Empty) && !video.OwnerId.Equals(video.Id) ? video.OwnerId : null;
        }

        /// <summary>True for a video Jellyfin keeps as an alternate version of another item (owned by it).</summary>
        private static bool IsAnotherItemsVersion(Video video) => PrimaryOf(video) != null;

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
