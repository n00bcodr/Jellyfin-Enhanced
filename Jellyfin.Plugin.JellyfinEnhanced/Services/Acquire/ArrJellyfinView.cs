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
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>
    /// <see cref="IArrJellyfinView"/> over the real library and user managers. Visibility is always
    /// Jellyfin's own item check plus physical ancestry under a current location of a library the viewer can access.
    /// </summary>
    public sealed class ArrJellyfinView : IArrJellyfinView, IDisposable
    {
        private readonly ILibraryManager _libraryManager;

        /// <summary>The current library topology (folders, names, enabled, paths) as text; set by the live view.</summary>
        internal static Func<string>? LibraryTopology;
        private readonly IUserManager _userManager;
        private readonly ILogger<ArrJellyfinView>? _logger;
        private readonly BridgeImportReadiness? _readiness;
        private long _revision;

        /// <summary>Native rows per copy-query page; the eligible copy budget is separate.</summary>
        internal const int CopyPageSize = 100;

        /// <summary>
        /// The copy scan bound: native rows the viewer may observe (under a current location of a library they may
        /// open) per lookup. Rows retained from removed paths and rows of libraries they can't open never count, so
        /// reaching it can't tell hidden records apart from absence.
        /// </summary>
        internal const int CopyObservableBound = 1000;

        /// <summary>The work ceiling: native pages per lookup, every row counted, so a lookup always ends.</summary>
        internal const int CopyPageCeiling = 100;

        /// <summary>Distinct eligible copies a lookup lists; a further one makes it incomplete.</summary>
        internal const int CopyBudget = 20;
        private static readonly TimeSpan BoundLogEvery = TimeSpan.FromHours(1);
        private const int BoundLogTitles = 256;
        private readonly Dictionary<string, DateTimeOffset> _boundLogged = new(StringComparer.Ordinal);

        /// <summary>Creates the view and starts following library changes (and the import readiness gate, when given).</summary>
        public ArrJellyfinView(ILibraryManager libraryManager, IUserManager userManager, ILogger<ArrJellyfinView>? logger = null, BridgeImportReadiness? readiness = null)
        {
            _libraryManager = libraryManager;
            LibraryTopology = () =>
            {
                var topology = new StringBuilder();
                foreach (var folder in (libraryManager.GetVirtualFolders() ?? new List<VirtualFolderInfo>()).OrderBy(f => f.ItemId, StringComparer.Ordinal).ThenBy(f => f.Name, StringComparer.Ordinal))
                {
                    topology.Append('|').Append(folder.ItemId).Append(':').Append(folder.Name).Append(folder.LibraryOptions?.Enabled == false ? '-' : '+');
                    foreach (var path in (folder.Locations ?? Array.Empty<string>()).OrderBy(p => p, StringComparer.Ordinal)) topology.Append(':').Append(path);
                }

                return topology.ToString();
            };
            _userManager = userManager;
            _logger = logger;
            _libraryManager.ItemAdded += OnItemChanged;
            _libraryManager.ItemUpdated += OnItemChanged;
            _libraryManager.ItemRemoved += OnItemChanged;
            _readiness = readiness;
            // An import that starts or stops awaiting its metadata changes what is Ready: cached compositions read again.
            if (_readiness != null) _readiness.Changed += OnReadinessChanged;
        }

        /// <inheritdoc />
        public long Revision => Interlocked.Read(ref _revision);

        /// <summary>Observable rows per lookup before the scan bound (<see cref="CopyObservableBound"/>; tests lower it).</summary>
        internal int ObservableBound { get; set; } = CopyObservableBound;

        /// <summary>Native pages per lookup before the work ceiling (<see cref="CopyPageCeiling"/>; tests lower it).</summary>
        internal int PageCeiling { get; set; } = CopyPageCeiling;

        /// <summary>The clock of the once-per-title-per-hour bound log (tests move it).</summary>
        internal Func<DateTimeOffset> Clock { get; set; } = () => DateTimeOffset.UtcNow;

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
            // Edition (play edge join): removed/moved libraries may never emit ItemRemoved when Jellyfin cancels cleanup.
            // Their current topology is also part of the viewer's scope, so a cached Ready/4K body cannot outlive that scope.
            fingerprint.Append(LibraryTopology?.Invoke() ?? string.Empty);
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
        public bool? ItemExists(Guid itemId)
        {
            if (itemId == Guid.Empty) return null;
            try
            {
                return _libraryManager.GetItemById(itemId) != null;
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                // A library read that failed tells nothing.
                return null;
            }
        }

        /// <inheritdoc />
        public JfItemRef? Resolve(Guid itemId, StatusViewer viewer)
        {
            if (viewer.Handle is not User) return null;
            var libraries = LiveLibraries(viewer);
            var item = Openable(itemId, viewer, libraries);
            switch (item)
            {
                case Movie movie:
                {
                    // The library lets an instance with linked libraries match this item on the batch route too.
                    var library = LibraryOf(movie, viewer, libraries);
                    return new JfItemRef
                    {
                        ItemId = movie.Id,
                        Kind = "movie",
                        Key = TitleKey.ForMovie(movie.GetProviderId(MetadataProvider.Tmdb), movie.GetProviderId(MetadataProvider.Imdb)),
                        Path = movie.Path,
                        DateCreated = Utc(movie.DateCreated),
                        LibraryId = library?.Id.ToString("N", CultureInfo.InvariantCulture),
                        LibraryName = library?.Name,
                        Placeholder = !Playable(movie),
                        AwaitingMetadata = Awaiting(movie),
                        Versions = Playable(movie) ? movie.MediaSourceCount : 0,
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
                        Placeholder = Placeholder(episode),
                        AwaitingMetadata = Awaiting(episode),
                        Path = episode.Path,
                        DateCreated = Utc(episode.DateCreated),
                        Versions = Playable(episode) ? episode.MediaSourceCount : 0,
                        PrimaryId = PrimaryOf(episode),
                    };
                }
                default:
                    return null;
            }
        }

        /// <summary>
        /// Reads the physical native identity used by parental evidence: an absolute file or series-folder path,
        /// not a virtual item. This preserves the local-evidence contract, including disc metadata; it does not
        /// inspect video sources or confer user access. The caller must still verify identity and native entitlement.
        /// </summary>
        internal static JfItemRef LocalEvidenceItem(BaseItem item) => new()
        {
            ItemId = item.Id,
            Kind = item is Movie ? "movie" : "series",
            Path = item.Path,
            Virtual = item.IsVirtualItem,
            Placeholder = string.IsNullOrWhiteSpace(item.Path) || !Path.IsPathFullyQualified(item.Path),
        };

        /// <inheritdoc />
        /// <remarks>
        /// Complete only on established exhaustion: every query read to its short page. Every other stop leaves rows or
        /// queries unread and returns what it saw as incomplete: the observable-row bound, the page ceiling, a copy past
        /// the eligible budget (<see cref="CopyBudget"/>), and a viewer the view can't check. At most <see cref="CopyBudget"/>
        /// copies: what the pages, cards and request checks show or pick from (presentation). Privacy decisions read
        /// <see cref="TitleCopyIds"/> instead.
        /// </remarks>
        public CopyLookup Copies(TitleKey titleKey, StatusViewer viewer, IReadOnlyCollection<TitleKey>? aliases = null)
        {
            var user = viewer.Handle as User;
            // Nothing read: no proof of absence (and, like every incomplete read, never cached).
            if (user == null && !viewer.IsLibraryContext)
            {
                CopyLookupBound.Note();
                return CopyLookup.Incomplete(Array.Empty<JfCopy>());
            }
            // The key and its aliases of the same kind, one query per set of distinct providers
            // (Jellyfin matches any of the ids a query names; an item is listed once).
            var libraries = LiveLibraries(viewer);
            var queries = TitleAliases.ProviderQueries(titleKey, aliases ?? Array.Empty<TitleKey>(), maxQueries: null);
            var items = new List<BaseItem>();
            var found = new HashSet<Guid>();
            int pages = 0, rowsRead = 0, observable = 0, searched = 0;
            string? bound = null;
            foreach (var providers in queries)
            {
                if (bound != null) break;
                searched++;
                for (var page = 0; ; page++)
                {
                    if (pages == PageCeiling)
                    {
                        bound = "work ceiling of " + PageCeiling.ToString(CultureInfo.InvariantCulture) + " native pages";
                        break;
                    }
                    // A native limit precedes LibraryOf. Retained or duplicate rows must not spend the
                    // eligible budget. Explicit, unchanged ordering keeps offsets stable between pages.
                    var rows = _libraryManager.GetItemList(new InternalItemsQuery
                    {
                        IncludeItemTypes = new[] { titleKey.IsMovie ? BaseItemKind.Movie : BaseItemKind.Series },
                        HasAnyProviderId = providers,
                        Recursive = true,
                        StartIndex = page * CopyPageSize,
                        Limit = CopyPageSize,
                        OrderBy = new[] { (ItemSortBy.SortName, SortOrder.Ascending), (ItemSortBy.DateCreated, SortOrder.Ascending) },
                        DtoOptions = new DtoOptions(false),
                    });
                    pages++;
                    rowsRead += rows.Count;
                    foreach (var item in rows)
                    {
                        // LibraryOf(includeHidden) membership: a current location of a current library. Only rows of a
                        // library the viewer may open count toward the bound (Jellyfin's query has no current-location
                        // filter, and live rows of other libraries stay policy facts, so the count is taken here).
                        var roots = CurrentRoots(item, libraries);
                        if (roots.Count == 0) continue;
                        if (roots.Exists(f => libraries[f.Id].Openable)) observable++;
                        if (found.Contains(item.Id)) continue;
                        // A full budget still reads on: only the end of every query proves there is no other copy.
                        if (items.Count == CopyBudget)
                        {
                            bound = "budget of " + CopyBudget.ToString(CultureInfo.InvariantCulture) + " eligible copies";
                            break;
                        }
                        found.Add(item.Id);
                        items.Add(item);
                    }
                    // A full page is not evidence of absence, even when every row was filtered.
                    if (bound != null || rows.Count < CopyPageSize) break;
                    if (observable >= ObservableBound)
                    {
                        bound = "bound of " + ObservableBound.ToString(CultureInfo.InvariantCulture) + " observable native rows";
                        break;
                    }
                }
            }
            if (bound != null) ReachedBound(titleKey, bound, pages, rowsRead, observable, items.Count, searched, queries.Count);
            var copies = new List<JfCopy>(items.Count);
            foreach (var item in items)
            {
                // Keep inaccessible LIVE copies as invisible policy facts, never orphaned rows.
                var library = LibraryOf(item, viewer, libraries, includeHidden: true);
                if (library == null) continue;
                copies.Add(new JfCopy
                {
                    ItemId = item.Id,
                    Visible = LibraryOf(item, viewer, libraries) != null,
                    LibraryId = library?.Id.ToString("N", CultureInfo.InvariantCulture),
                    LibraryName = library?.Name,
                    Path = item.Path,
                    DateCreated = Utc(item.DateCreated),
                });
            }
            // Any stop before exhaustion proves nothing about absence: what was seen comes back as an incomplete answer.
            return bound != null ? CopyLookup.Incomplete(copies) : CopyLookup.Complete(copies);
        }

        /// <inheritdoc />
        public IReadOnlyList<Guid>? TitleCopyIds(TitleKey titleKey, IReadOnlyCollection<TitleKey>? aliases = null)
        {
            // Jellyfin's id query with no Limit: one complete read per set of distinct providers (no page to miss an item, no
            // cap), every library, nobody's visibility. A failed query means the set isn't known: null, never a partial list.
            try
            {
                var found = new HashSet<Guid>();
                foreach (var providers in TitleAliases.AllProviderQueries(titleKey, aliases ?? Array.Empty<TitleKey>()))
                {
                    found.UnionWith(_libraryManager.GetItemIds(new InternalItemsQuery
                    {
                        IncludeItemTypes = new[] { titleKey.IsMovie ? BaseItemKind.Movie : BaseItemKind.Series },
                        HasAnyProviderId = providers,
                        Recursive = true,
                    }));
                }

                found.Remove(Guid.Empty);
                return found.ToList();
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                return null;
            }
        }

        /// <inheritdoc />
        public IReadOnlyList<JfEpisode> Episodes(Guid seriesItemId, int? season, StatusViewer viewer, bool includeVirtual)
        {
            if (viewer.Handle is not User user) return Array.Empty<JfEpisode>();
            var libraries = LiveLibraries(viewer);
            if (Openable(seriesItemId, viewer, libraries) is not Series series) return Array.Empty<JfEpisode>();
            var options = new DtoOptions(false);
            IEnumerable<BaseItem> items;
            if (season.HasValue)
            {
                var seasonItem = series.GetSeasons(user, options).OfType<Season>().FirstOrDefault(s => s.IndexNumber == season.Value && LibraryOf(s, viewer, libraries) != null);
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
                if (!s.HasValue || !e.IndexNumber.HasValue || LibraryOf(e, viewer, libraries) == null) continue;
                seen.Add(e.Id);
                list.Add(new JfEpisode
                {
                    ItemId = e.Id,
                    Season = s.Value,
                    Episode = e.IndexNumber.Value,
                    EpisodeEnd = e.IndexNumberEnd,
                    Virtual = e.IsMissingEpisode,
                    Placeholder = Placeholder(e),
                    AwaitingMetadata = Awaiting(e),
                    DateCreated = Utc(e.DateCreated),
                });
            }
            if (!viewer.IsAdmin && viewer.HasParentalLimit) AddHidden(series, season, user, includeVirtual, seen, list, viewer, libraries);
            return list;
        }

        /// <summary>
        /// Adds the episodes of the series that Jellyfin hides from this viewer (their own rating or
        /// tags, or a hidden season), with or without a file, as numbers only: without them the
        /// composer would read an episode Sonarr has a file for as "almost ready" for ever, and show
        /// Sonarr's status for missing episodes the viewer may not see.
        /// </summary>
        private void AddHidden(Series series, int? season, User user, bool includeVirtual, HashSet<Guid> seen, List<JfEpisode> list, StatusViewer viewer, IReadOnlyDictionary<Guid, LiveLibrary> libraries)
        {
            // No user on the query: every episode of the series, real or virtual, whoever may see it.
            var all = _libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { BaseItemKind.Episode },
                AncestorIds = new[] { series.Id },
                Recursive = true,
                DtoOptions = new DtoOptions(false),
            });
            var candidates = all.OfType<Episode>().Where(e => LibraryOf(e, viewer, libraries, includeHidden: true, requireLibraryAccess: true) != null).Select(e => new EpisodeFacts(e.Id, e.ParentIndexNumber, e.IndexNumber, e.IndexNumberEnd, e.IsMissingEpisode || e.IsVirtualItem));
            list.AddRange(HiddenEpisodes(candidates, season, seen, includeVirtual, () => VisibleEpisodeIds(series, season, user, viewer, libraries)));
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
        private HashSet<Guid> VisibleEpisodeIds(Series series, int? season, User user, StatusViewer viewer, IReadOnlyDictionary<Guid, LiveLibrary> libraries)
        {
            var options = new DtoOptions(false);
            IEnumerable<BaseItem> items;
            if (season.HasValue)
            {
                var seasonItem = series.GetSeasons(user, options).OfType<Season>().FirstOrDefault(s => s.IndexNumber == season.Value && LibraryOf(s, viewer, libraries) != null);
                items = seasonItem?.GetEpisodes(user, options, true) ?? new List<BaseItem>();
            }
            else
            {
                items = series.GetEpisodes(user, options, true);
            }
            return items.Where(i => LibraryOf(i, viewer, libraries) != null).Select(i => i.Id).ToHashSet();
        }

        /// <inheritdoc />
        /// <remarks>
        /// Two native queries, both by the series item's own ancestry (never its presentation key, which automatic series
        /// grouping shares between folders): the viewer's (Jellyfin's parental filter) and, for a viewer with parental limits,
        /// the unfiltered one, whose rows the viewer's leaves out are the hidden numbers. Every row must belong to this
        /// series item and to a current location of a current library, like every other read of the view.
        /// </remarks>
        public JfSeriesFolder SeriesFolder(Guid seriesItemId, StatusViewer viewer)
        {
            if (viewer.Handle is not User user) return JfSeriesFolder.Empty;
            var libraries = LiveLibraries(viewer);
            if (Openable(seriesItemId, viewer, libraries) is not Series series) return JfSeriesFolder.Empty;
            var shown = _libraryManager.GetItemList(new InternalItemsQuery(user)
            {
                IncludeItemTypes = new[] { BaseItemKind.Season, BaseItemKind.Episode },
                AncestorIds = new[] { series.Id },
                Recursive = true,
                DtoOptions = new DtoOptions(false),
            });
            var seasonNumbers = SeasonNumbersOf(shown);
            var episodes = new List<JfEpisode>();
            var seasons = new List<JfSeason>();
            var seen = new HashSet<Guid>();
            foreach (var item in shown)
            {
                if (seen.Contains(item.Id) || LibraryOf(item, viewer, libraries) == null) continue;
                seen.Add(item.Id);
                if (item is Season season && season.SeriesId.Equals(series.Id) && season.IndexNumber is int number)
                {
                    // Like Jellyfin's season list: a missing season only for a viewer who shows missing episodes.
                    if (!season.IsVirtualItem || viewer.DisplayMissingEpisodes) seasons.Add(new JfSeason { ItemId = season.Id, Season = number });
                }
                else if (item is Episode e && FolderEpisode(e, series.Id) && (e.ParentIndexNumber ?? seasonNumbers.GetValueOrDefault(e.SeasonId)) is int s)
                {
                    episodes.Add(new JfEpisode { ItemId = e.Id, Season = s, Episode = e.IndexNumber!.Value, EpisodeEnd = e.IndexNumberEnd, Virtual = e.IsMissingEpisode, Placeholder = Placeholder(e), AwaitingMetadata = Awaiting(e), DateCreated = Utc(e.DateCreated) });
                }
                else
                {
                    seen.Remove(item.Id);
                }
            }
            if (!viewer.IsAdmin && viewer.HasParentalLimit)
            {
                // No user on the query: every season and episode of the folder, whoever may see it.
                var all = _libraryManager.GetItemList(new InternalItemsQuery
                {
                    IncludeItemTypes = new[] { BaseItemKind.Season, BaseItemKind.Episode },
                    AncestorIds = new[] { series.Id },
                    Recursive = true,
                    DtoOptions = new DtoOptions(false),
                }).Where(i => LibraryOf(i, viewer, libraries, includeHidden: true, requireLibraryAccess: true) != null).ToList();
                var allNumbers = SeasonNumbersOf(all);
                var candidates = all.OfType<Episode>().Where(e => FolderEpisode(e, series.Id))
                    .Select(e => new EpisodeFacts(e.Id, e.ParentIndexNumber ?? allNumbers.GetValueOrDefault(e.SeasonId), e.IndexNumber, e.IndexNumberEnd, e.IsMissingEpisode || e.IsVirtualItem));
                // The viewer's list holds the missing episodes they may see, so a missing one it leaves out is hidden.
                episodes.AddRange(HiddenEpisodes(candidates, null, seen, seenIncludesVirtual: true, () => seen));
                var folderSeasons = all.OfType<Season>().Where(s => s.SeriesId.Equals(series.Id)).Select(s => (s.Id, s.IndexNumber));
                foreach (var number in HiddenSeasonNumbers(folderSeasons, seasons.Select(s => s.Season), id => seen.Contains(id) || Openable(id, viewer, libraries) != null))
                    seasons.Add(new JfSeason { Season = number, Hidden = true });
            }
            return new JfSeriesFolder { Episodes = episodes, Seasons = seasons };
        }

        /// <summary>The season number of each season item among <paramref name="items"/> (for an episode without its own).</summary>
        private static Dictionary<Guid, int?> SeasonNumbersOf(IEnumerable<BaseItem> items)
        {
            var numbers = new Dictionary<Guid, int?>();
            foreach (var season in items.OfType<Season>()) numbers.TryAdd(season.Id, season.IndexNumber);
            return numbers;
        }

        /// <summary>A numbered episode of exactly this series item, never another item's version (its primary stands for it).</summary>
        private static bool FolderEpisode(Episode e, Guid seriesId)
            => e.SeriesId.Equals(seriesId) && e.IndexNumber.HasValue && !IsAnotherItemsVersion(e);

        /// <inheritdoc />
        public IReadOnlyList<JfSeason> Seasons(Guid seriesItemId, StatusViewer viewer)
        {
            if (viewer.Handle is not User user) return Array.Empty<JfSeason>();
            var libraries = LiveLibraries(viewer);
            if (Openable(seriesItemId, viewer, libraries) is not Series series) return Array.Empty<JfSeason>();
            var list = series.GetSeasons(user, new DtoOptions(false)).OfType<Season>()
                .Where(s => s.IndexNumber.HasValue && LibraryOf(s, viewer, libraries) != null)
                .Select(s => new JfSeason { ItemId = s.Id, Season = s.IndexNumber!.Value })
                .ToList();
            if (!viewer.IsAdmin && viewer.HasParentalLimit) AddHiddenSeasons(series, user, list, viewer, libraries);
            return list;
        }

        /// <inheritdoc />
        public IReadOnlyList<Guid> SeriesParts(Guid seriesItemId, int season, int? episode, StatusViewer viewer)
        {
            if (viewer.Handle is not User user) return Array.Empty<Guid>();
            var libraries = LiveLibraries(viewer);
            if (Openable(seriesItemId, viewer, libraries) is not Series series) return Array.Empty<Guid>();
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
            return SeriesPartIds(items.Where(i => LibraryOf(i, viewer, libraries) != null), series.Id, season, episode);
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
            var libraries = LiveLibraries(viewer);
            foreach (var id in candidates)
            {
                // Jellyfin ids an item by its path and type: the deleted item is the one a path the holder keeps
                // as a version had as an item of the holder's type (10.11 gives the version itself another id, as a Video).
                if (Openable(id, viewer, libraries) is not Video video) continue;
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
        {
            var libraries = LiveLibraries(viewer);
            return Openable(itemId, viewer, libraries) is Video video and (Movie or Episode)
                ? (readDimensions ? SourcesOf(video, viewer, libraries) : ItsOwnSource(video)) : Array.Empty<JfSource>();
        }

        /// <summary>One current library's locations and root access, frozen for a lookup.</summary>
        private sealed record LiveLibrary(string[] Locations, bool Openable);

        /// <summary>
        /// Current virtual libraries and native root access, read once per lookup. Neither cached collection
        /// ancestry nor PhysicalLocationsList establishes membership after one path of a library is removed.
        /// </summary>
        private Dictionary<Guid, LiveLibrary> LiveLibraries(StatusViewer viewer)
        {
            var libraries = new Dictionary<Guid, LiveLibrary>();
            if (!viewer.IsLibraryContext && viewer.Handle is not User) return libraries;
            foreach (var folder in _libraryManager.GetVirtualFolders())
            {
                if (folder.LibraryOptions?.Enabled == false || !Guid.TryParse(folder.ItemId, out var id) || id == Guid.Empty || libraries.ContainsKey(id)) continue;
                var locations = (folder.Locations ?? Array.Empty<string>()).Where(p => !string.IsNullOrWhiteSpace(p)).ToArray();
                var allowed = viewer.IsLibraryContext || (viewer.Handle is User user && _libraryManager.GetItemById<BaseItem>(id, user) is Folder);
                libraries[id] = new LiveLibrary(locations, allowed);
            }
            return libraries;
        }

        /// <summary>
        /// The authoritative native-query boundary: the item must physically belong to a CURRENT location of a
        /// CURRENT enabled mapped library. Virtual seasons/episodes inherit their own physical parent's path,
        /// never a grouped presentation-key peer's. Access and item-level policy apply unless collecting live
        /// invisible policy facts; those still require physical membership. Orphans can never become hidden facts.
        /// </summary>
        private Folder? LibraryOf(BaseItem item, StatusViewer viewer, IReadOnlyDictionary<Guid, LiveLibrary> libraries,
            bool includeHidden = false, bool requireLibraryAccess = false, string? sourcePath = null)
        {
            var path = PhysicalPath(item, sourcePath);
            if (path == null) return null;
            var folders = CurrentRoots(item, libraries, path);
            var library = folders.FirstOrDefault(f => libraries[f.Id].Openable);
            if (library == null && includeHidden && !requireLibraryAccess) library = folders.FirstOrDefault();
            if (library == null) return null;
            return includeHidden || viewer.IsLibraryContext || (viewer.Handle is User user && _libraryManager.GetItemById<BaseItem>(item.Id, user) != null)
                ? library : null;
        }

        /// <summary>
        /// The physical path membership is judged by: the source's, the item's own, or for a pathless season or episode
        /// its own nearest physical parent's (never a grouped presentation-key peer's). Null when there is none.
        /// </summary>
        private static string? PhysicalPath(BaseItem item, string? sourcePath = null)
        {
            var path = sourcePath ?? item.Path;
            if (string.IsNullOrEmpty(path) && item is Season or Episode)
            {
                var seen = new HashSet<Guid> { item.Id };
                var parent = item.GetParent();
                while (parent != null && seen.Add(parent.Id))
                {
                    if (!string.IsNullOrEmpty(parent.Path)) { path = parent.Path; break; }
                    parent = parent.GetParent();
                }
            }
            return string.IsNullOrEmpty(path) ? null : path;
        }

        /// <summary>
        /// The current enabled libraries whose CURRENT locations hold the item physically (the membership part of
        /// <see cref="LibraryOf"/>, before access and item policy). Empty for a row retained from a removed path.
        /// </summary>
        private List<Folder> CurrentRoots(BaseItem item, IReadOnlyDictionary<Guid, LiveLibrary> libraries, string? path = null)
        {
            path ??= PhysicalPath(item);
            if (path == null) return new List<Folder>();
            return _libraryManager.GetCollectionFolders(item)
                .Where(f => libraries.TryGetValue(f.Id, out var live) && live.Locations.Any(p => BridgePaths.IsUnder(path, p)))
                .ToList();
        }

        /// <summary>
        /// A copy lookup reached its bound: the flow's watches are told (<see cref="CopyLookupBound"/>), and it is logged
        /// once per title per hour with the bound and counts (no viewer, library or path).
        /// </summary>
        private void ReachedBound(TitleKey key, string bound, int pages, int rows, int observable, int copies, int searched, int queries)
        {
            CopyLookupBound.Note();
            var now = Clock();
            var title = key.Title.ToString();
            lock (_boundLogged)
            {
                if (_boundLogged.TryGetValue(title, out var last) && now - last < BoundLogEvery) return;
                if (_boundLogged.Count >= BoundLogTitles)
                {
                    foreach (var old in _boundLogged.Where(e => now - e.Value >= BoundLogEvery).Select(e => e.Key).ToList()) _boundLogged.Remove(old);
                    if (_boundLogged.Count >= BoundLogTitles) _boundLogged.Clear();
                }
                _boundLogged[title] = now;
            }
            _logger?.LogWarning(
                "Jellyfin copy lookup for {Title} reached its {Bound} ({Pages} pages, {Rows} native rows, {Observable} observable rows, {Copies} eligible copies, {Searched} of {Queries} provider queries); this read is incomplete (absence not proven) and is not cached.",
                title, bound, pages, rows, observable, copies, searched, queries);
        }

        /// <summary>The item only when the shared current-location and visibility predicate accepts it.</summary>
        private BaseItem? Openable(Guid itemId, StatusViewer viewer, IReadOnlyDictionary<Guid, LiveLibrary> libraries)
        {
            var item = _libraryManager.GetItemById(itemId);
            return item != null && LibraryOf(item, viewer, libraries) != null ? item : null;
        }

        /// <inheritdoc />
        public IReadOnlyList<JfEpisodeSources> EpisodeSources(Guid seriesItemId, int? season, StatusViewer viewer, bool readDimensions = true)
        {
            var libraries = LiveLibraries(viewer);
            if (Openable(seriesItemId, viewer, libraries) is not Series series) return Array.Empty<JfEpisodeSources>();
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
                if (!OwnPlayableEpisode(e, series.Id, season) || LibraryOf(e, viewer, libraries) == null) continue;
                var sources = readDimensions ? SourcesOf(e, viewer, libraries) : ItsOwnSource(e);
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
            if (viewer.Handle is not User) return Array.Empty<Guid>();
            var libraries = LiveLibraries(viewer);
            if (Openable(seriesItemId, viewer, libraries) is not Series series) return Array.Empty<Guid>();
            var key = series.PresentationUniqueKey;
            if (string.IsNullOrEmpty(key)) return Array.Empty<Guid>();
            return _libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { BaseItemKind.Series },
                PresentationUniqueKey = key,
                Recursive = true,
                DtoOptions = new DtoOptions(false),
            }).Where(i => !i.Id.Equals(series.Id) && i is Series && LibraryOf(i, viewer, libraries) != null).Select(i => i.Id).ToList();
        }

        /// <summary>
        /// A movie's or episode's own file as its one source, without reading its media sources (dimensions unknown).
        /// None for a missing (virtual) item or a placeholder.
        /// </summary>
        private List<JfSource> ItsOwnSource(Video video)
            => Playable(video) ? new List<JfSource> { new() { SourceId = video.Id, ItemId = video.Id, BackingItemId = video.Id, Path = video.Path, AwaitingMetadata = Awaiting(video), DateCreated = Utc(video.DateCreated) } } : new List<JfSource>();

        /// <summary>A just-imported movie or episode (or version) whose metadata the bridge hasn't confirmed yet (<see cref="BridgeImportReadiness"/>).</summary>
        private bool Awaiting(BaseItem item, string? path = null) => _readiness?.Pending(item.Id, path ?? item.Path) == true;

        /// <summary>True for a movie or episode with a file (a missing episode is a virtual item without one).</summary>
        internal static bool Playable(Video video) => !video.IsVirtualItem && !video.IsPlaceHolder && !string.IsNullOrEmpty(video.Path);

        /// <summary>A listed (not missing) episode that plays nothing: a stub file (Jellyfin's IsPlaceHolder) or no file path.</summary>
        private static bool Placeholder(Episode e) => !e.IsMissingEpisode && !Playable(e);

        /// <summary>
        /// The playable sources of a movie or episode as Jellyfin plays them (its media sources, every version
        /// included), each with its video stream's dimensions. None for a missing (virtual) item or a placeholder.
        /// A version played by another item counts only when the viewer can open that item (Jellyfin's own check:
        /// library access and parental limits); the library context opens every one in a current library. A native
        /// shortcut (a ".strm" file) plays its remote address as the shortcut item's own source (Jellyfin 10.11 and 12.x:
        /// the item's own id, remote, its probed streams): it is bound to that local item, whose own path decides library
        /// membership, with the remote source's dimensions; any other non-file source is bound to nothing.
        /// </summary>
        private List<JfSource> SourcesOf(Video video, StatusViewer viewer, IReadOnlyDictionary<Guid, LiveLibrary> libraries)
        {
            var list = new List<JfSource>();
            if (!Playable(video)) return list;
            foreach (var source in video.GetMediaSources(false))
            {
                if (string.IsNullOrEmpty(source.Path) || source.Type == MediaSourceType.Placeholder) continue;
                var id = Guid.TryParse(source.Id, out var parsed) ? parsed : video.Id;
                var shortcut = source.Protocol != MediaProtocol.File;
                if (shortcut && !(video.IsShortcut && id.Equals(video.Id))) continue;
                var stream = source.MediaStreams?.Where(s => s.Type == MediaStreamType.Video).OrderByDescending(s => (s.Width ?? 0) * (long)(s.Height ?? 0)).FirstOrDefault();
                // The item that plays exactly this file: the primary for its own path, else the version's item by
                // source id, else by path. A source with none is not credited to the primary (nothing could insert it),
                // nor is one whose item the viewer can't open (a linked version in another library, or one rated above
                // their limit).
                var version = shortcut || BridgePaths.SamePath(source.Path, video.Path) ? video
                    : (!id.Equals(video.Id) ? _libraryManager.GetItemById(id) as Video : null);
                // Some native sources name the primary id. Their own backing path still decides membership.
                if (!shortcut && (version == null || string.IsNullOrEmpty(version.Path) || !BridgePaths.SamePath(source.Path, version.Path)))
                    version = _libraryManager.FindByPath(source.Path, false) as Video;
                if (version == null || LibraryOf(version, viewer, libraries) == null
                    || LibraryOf(version, viewer, libraries, sourcePath: shortcut ? version.Path : source.Path) == null) continue;
                list.Add(new JfSource
                {
                    SourceId = id,
                    ItemId = video.Id,
                    BackingItemId = version.Id,
                    Width = stream?.Width,
                    Height = stream?.Height,
                    Path = shortcut ? version.Path : source.Path,
                    AwaitingMetadata = Awaiting(version, shortcut ? version.Path : source.Path),
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
        private void AddHiddenSeasons(Series series, User user, List<JfSeason> list, StatusViewer viewer, IReadOnlyDictionary<Guid, LiveLibrary> libraries)
        {
            var all = _libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { BaseItemKind.Season },
                AncestorIds = new[] { series.Id },
                Recursive = true,
                DtoOptions = new DtoOptions(false),
            });
            var seasons = all.OfType<Season>().Where(s => LibraryOf(s, viewer, libraries, includeHidden: true, requireLibraryAccess: true) != null).Select(s => (s.Id, s.IndexNumber));
            foreach (var number in HiddenSeasonNumbers(seasons, list.Select(s => s.Season), id => Openable(id, viewer, libraries) != null))
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
            if (_readiness != null) _readiness.Changed -= OnReadinessChanged;
        }

        private void OnReadinessChanged() => Interlocked.Increment(ref _revision);

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
