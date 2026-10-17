using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Stamps
{
    /// <summary>
    /// <see cref="IStampLibrary"/> over Jellyfin. Item reads go through the library manager's item cache; access is
    /// Jellyfin's own check (<c>GetItemById(id, user)</c>: library access and parental limits); users come from the
    /// poster-tag user cache (a Jellyfin 12 user lookup costs a database transaction).
    /// </summary>
    public sealed class JellyfinStampLibrary : IStampLibrary, IDisposable
    {
        private const int MaxCopies = 50;

        private readonly ILibraryManager _libraryManager;
        private readonly IUserDataManager _userData;
        private readonly PosterTagUserCache _users;

        /// <summary>Creates the adapter and follows library changes (DI).</summary>
        /// <param name="libraryManager">Library manager.</param>
        /// <param name="userData">User data manager.</param>
        /// <param name="users">User cache.</param>
        public JellyfinStampLibrary(ILibraryManager libraryManager, IUserDataManager userData, PosterTagUserCache users)
        {
            _libraryManager = libraryManager;
            _userData = userData;
            _users = users;
            _libraryManager.ItemAdded += OnAdded;
            _libraryManager.ItemUpdated += OnUpdated;
            _libraryManager.ItemRemoved += OnRemoved;
        }

        /// <inheritdoc />
        public event Action<StampItem>? Added;

        /// <inheritdoc />
        public event Action<StampItem>? Updated;

        /// <inheritdoc />
        public event Action<StampItem>? Removed;

        /// <inheritdoc />
        public StampItem? Item(Guid id) => id == Guid.Empty ? null : From(_libraryManager.GetItemById(id));

        /// <inheritdoc />
        public bool CanOpen(Guid userId, Guid itemId)
        {
            if (_users.Get(userId) is not { } user) return false;
            return _libraryManager.GetItemById<BaseItem>(itemId, user) != null;
        }

        /// <inheritdoc />
        public (bool Played, DateTime? LastPlayed)? UserData(Guid userId, Guid itemId)
        {
            if (_users.Get(userId) is not { } user || _libraryManager.GetItemById(itemId) is not { } item) return null;
            var data = _userData.GetUserData(user, item);
            if (data == null) return null;
            DateTime? last = data.LastPlayedDate is DateTime at ? DateTime.SpecifyKind(at, DateTimeKind.Utc) : null;
            return (data.Played, last);
        }

        /// <inheritdoc />
        public IReadOnlyList<StampItem> FourKVideos()
        {
            var found = new Dictionary<Guid, StampItem>();
            foreach (var query in new[]
            {
                new InternalItemsQuery { MinWidth = AcquisitionCopyPolicy.FourKWidth },
                new InternalItemsQuery { MinHeight = AcquisitionCopyPolicy.FourKHeight },
            })
            {
                query.IncludeItemTypes = new[] { BaseItemKind.Movie, BaseItemKind.Episode };
                query.Recursive = true;
                query.IsVirtualItem = false;
                // A movie's title keys are its provider ids, which are only read from the database when asked for.
                query.DtoOptions = new DtoOptions(false) { Fields = new[] { ItemFields.ProviderIds } };
                foreach (var item in _libraryManager.GetItemList(query))
                {
                    if (!found.ContainsKey(item.Id) && From(item) is { FourK: true } stamp) found[item.Id] = stamp;
                }
            }

            return found.Values.ToList();
        }

        /// <inheritdoc />
        public IReadOnlyList<StampItem> AddedSince(DateTime since)
        {
            var items = _libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { BaseItemKind.Movie, BaseItemKind.Episode },
                MinDateCreated = since,
                Recursive = true,
                IsVirtualItem = false,
                DtoOptions = new DtoOptions(false),
            });
            var list = new List<StampItem>(items.Count);
            foreach (var item in items)
            {
                if (From(item) is { Virtual: false } stamp) list.Add(stamp);
            }

            return list;
        }

        /// <inheritdoc />
        public IReadOnlyList<StampItem> OtherCopies(StampItem item)
        {
            var copies = new List<StampItem>();
            if (item.Keys.Count == 0) return copies;
            var queries = TitleAliases.ProviderQueries(item.Keys[0], item.Keys.Skip(1));
            if (item.Kind == "movie")
            {
                foreach (var providers in queries)
                {
                    foreach (var other in _libraryManager.GetItemList(new InternalItemsQuery
                    {
                        IncludeItemTypes = new[] { BaseItemKind.Movie },
                        HasAnyProviderId = providers,
                        Recursive = true,
                        IsVirtualItem = false,
                        Limit = MaxCopies,
                        DtoOptions = new DtoOptions(false),
                    }))
                    {
                        if (other.Id != item.Id && copies.All(c => c.Id != other.Id) && From(other) is { } copy) copies.Add(copy);
                    }
                }

                return copies;
            }

            if (item.Kind != "episode" || item.Season is not int season || item.Episode is not int episode) return copies;
            var series = new HashSet<Guid>();
            if (item.SeriesId is Guid own && own != Guid.Empty) series.Add(own);
            foreach (var providers in queries)
            {
                foreach (var other in _libraryManager.GetItemList(new InternalItemsQuery
                {
                    IncludeItemTypes = new[] { BaseItemKind.Series },
                    HasAnyProviderId = providers,
                    Recursive = true,
                    Limit = 20,
                    DtoOptions = new DtoOptions(false),
                }))
                {
                    series.Add(other.Id);
                }
            }

            var last = item.EpisodeEnd is int end && end >= episode ? end : episode;
            foreach (var seriesId in series)
            {
                foreach (var other in _libraryManager.GetItemList(new InternalItemsQuery
                {
                    IncludeItemTypes = new[] { BaseItemKind.Episode },
                    AncestorIds = new[] { seriesId },
                    ParentIndexNumber = season,
                    Recursive = true,
                    IsVirtualItem = false,
                    DtoOptions = new DtoOptions(false),
                }))
                {
                    if (other.Id == item.Id || copies.Any(c => c.Id == other.Id) || From(other) is not { } copy || copy.Episode is not int e) continue;
                    var otherLast = copy.EpisodeEnd is int oe && oe >= e ? oe : e;
                    if (e <= last && otherLast >= episode) copies.Add(copy);
                    if (copies.Count >= MaxCopies) return copies;
                }
            }

            return copies;
        }

        /// <inheritdoc />
        public Guid? ItemAtPath(string path)
        {
            if (string.IsNullOrWhiteSpace(path)) return null;
            return _libraryManager.FindByPath(path, false) is { } item && (item is Movie || item is Episode) ? item.Id : null;
        }

        /// <inheritdoc />
        public void Dispose()
        {
            _libraryManager.ItemAdded -= OnAdded;
            _libraryManager.ItemUpdated -= OnUpdated;
            _libraryManager.ItemRemoved -= OnRemoved;
        }

        /// <summary>The stamp view of a Jellyfin item, or null for any other kind of item.</summary>
        /// <param name="item">Item.</param>
        /// <returns>The stamp item.</returns>
        internal static StampItem? From(BaseItem? item)
        {
            switch (item)
            {
                case Movie movie:
                    return new StampItem
                    {
                        Id = movie.Id,
                        Kind = "movie",
                        Keys = TitleAliases.FromProviderIds(true, movie.GetProviderId(MetadataProvider.Tmdb), null, movie.GetProviderId(MetadataProvider.Imdb)),
                        Width = movie.Width,
                        Height = movie.Height,
                        DateCreated = Utc(movie.DateCreated),
                        Virtual = movie.IsVirtualItem,
                        Path = movie.Path,
                    };
                case Episode episode:
                    return new StampItem
                    {
                        Id = episode.Id,
                        Kind = "episode",
                        Keys = SeriesKeys(episode.Series),
                        SeriesId = episode.SeriesId == Guid.Empty ? null : episode.SeriesId,
                        SeasonId = episode.SeasonId == Guid.Empty ? null : episode.SeasonId,
                        Season = episode.ParentIndexNumber,
                        Episode = episode.IndexNumber,
                        EpisodeEnd = episode.IndexNumberEnd,
                        Width = episode.Width,
                        Height = episode.Height,
                        DateCreated = Utc(episode.DateCreated),
                        Virtual = episode.IsMissingEpisode || episode.IsVirtualItem,
                        Path = episode.Path,
                    };
                case Season season:
                    return new StampItem
                    {
                        Id = season.Id,
                        Kind = "season",
                        Keys = SeriesKeys(season.Series),
                        SeriesId = season.SeriesId == Guid.Empty ? null : season.SeriesId,
                        Season = season.IndexNumber,
                        DateCreated = Utc(season.DateCreated),
                        Virtual = season.LocationType == LocationType.Virtual,
                    };
                case Series series:
                    return new StampItem
                    {
                        Id = series.Id,
                        Kind = "series",
                        Keys = SeriesKeys(series),
                        DateCreated = Utc(series.DateCreated),
                    };
                default:
                    return null;
            }
        }

        private static IReadOnlyList<TitleKey> SeriesKeys(Series? series)
            => series == null
                ? Array.Empty<TitleKey>()
                : TitleAliases.FromProviderIds(false, series.GetProviderId(MetadataProvider.Tmdb), series.GetProviderId(MetadataProvider.Tvdb), series.GetProviderId(MetadataProvider.Imdb));

        private static DateTime Utc(DateTime value) => value.Kind == DateTimeKind.Unspecified ? DateTime.SpecifyKind(value, DateTimeKind.Utc) : value.ToUniversalTime();

        private void OnAdded(object? sender, ItemChangeEventArgs e) => Raise(Added, e);

        private void OnUpdated(object? sender, ItemChangeEventArgs e) => Raise(Updated, e);

        private void OnRemoved(object? sender, ItemChangeEventArgs e) => Raise(Removed, e);

        private static void Raise(Action<StampItem>? handler, ItemChangeEventArgs? e)
        {
            if (handler == null || e?.Item is not (Movie or Episode)) return;
            try
            {
                if (From(e.Item) is { } item) handler(item);
            }
            catch (Exception)
            {
                // A library event must never fail because of acquisition badges.
            }
        }
    }

    /// <summary>
    /// <see cref="IStampInterests"/> over the request ledger (a person's own requests that weren't cancelled or declined),
    /// Seerr's requests and follows. A person who muted the title has no interest in it.
    /// </summary>
    public sealed class StampInterests : IStampInterests
    {
        private readonly RequestLedger _ledger;
        private readonly SeerrRequestReadModel _requests;
        private readonly NotifyStore _follows;
        private readonly TitleAliases _aliases;

        /// <summary>Creates the reader (DI).</summary>
        /// <param name="ledger">Request ledger.</param>
        /// <param name="requests">Seerr's requests.</param>
        /// <param name="follows">Follows.</param>
        /// <param name="aliases">Title aliases.</param>
        public StampInterests(RequestLedger ledger, SeerrRequestReadModel requests, NotifyStore follows, TitleAliases aliases)
        {
            _ledger = ledger;
            _requests = requests;
            _follows = follows;
            _aliases = aliases;
        }

        /// <inheritdoc />
        public IReadOnlyList<StampInterest> For(IReadOnlyList<TitleKey> keys)
        {
            var titles = new List<TitleKey>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var key in keys)
            {
                foreach (var k in new[] { key.Title }.Concat(_aliases.Of(key)))
                {
                    if (seen.Add(k.ToString())) titles.Add(k);
                }
            }

            var list = new List<StampInterest>();
            if (titles.Count == 0) return list;
            var muted = new HashSet<Guid>();
            if (_follows.Available)
            {
                var follows = _follows.FollowsOfTitles(seen);
                foreach (var f in follows.Where(f => f.Muted && TitleKey.Parse(f.Key)?.Season == null)) muted.Add(f.UserId);
                foreach (var f in follows.Where(f => !f.Muted && !muted.Contains(f.UserId)))
                {
                    if (TitleKey.Parse(f.Key) is not { } parsed) continue;
                    list.Add(new StampInterest(f.UserId, f.CreatedAt.UtcDateTime, false, parsed.Season == null, parsed.Season is int s ? new[] { s } : Array.Empty<int>(), Array.Empty<(int, int)>(), "follow"));
                }
            }

            if (_ledger.Database.Available)
            {
                foreach (var want in titles.SelectMany(t => _ledger.ForTitle(t.ToString())).DistinctBy(w => w.Id))
                {
                    if (want.Status is "cancelled" or "declined" || muted.Contains(want.UserId)) continue;
                    var input = want.Input;
                    var all = input.Scope == "future";
                    list.Add(new StampInterest(
                        want.UserId,
                        want.CreatedAt.UtcDateTime,
                        input.Variant == "4k",
                        all,
                        input.Scope is "seasons" or "next_season" or "future" ? input.Seasons : Array.Empty<int>(),
                        input.Episodes.Select(e => (e.Season, e.Episode)).ToArray(),
                        "request"));
                }
            }

            foreach (var record in titles.SelectMany(_requests.ForTitle).DistinctBy(r => r.Id))
            {
                if (record.RequestedBy is not Guid user || !record.Active || record.CreatedAt is not DateTime created || muted.Contains(user)) continue;
                var at = created.Kind == DateTimeKind.Unspecified ? DateTime.SpecifyKind(created, DateTimeKind.Utc) : created.ToUniversalTime();
                list.Add(new StampInterest(user, at, record.Is4k, !record.IsMovie && record.Seasons.Count == 0, record.Seasons, Array.Empty<(int, int)>(), "seerr"));
            }

            return list;
        }
    }

    /// <summary>
    /// <see cref="IStampUpgrades"/> over the arr history snapshots in memory: an import of a movie or episode whose old
    /// file the arr deleted for "Upgrade" (within a few minutes of the import), with the imported path mapped to
    /// Jellyfin's view of the disk the way the bridge maps it. Never calls an arr.
    /// </summary>
    public sealed class ArrHistoryStampUpgrades : IStampUpgrades
    {
        private static readonly TimeSpan Pairing = TimeSpan.FromMinutes(10);

        private readonly ArrStateStore _store;
        private readonly IJellyfinLibraryAccess _library;

        /// <summary>Creates the reader (DI).</summary>
        /// <param name="store">Arr snapshots.</param>
        /// <param name="library">Jellyfin library folders (path case).</param>
        public ArrHistoryStampUpgrades(ArrStateStore store, IJellyfinLibraryAccess library)
        {
            _store = store;
            _library = library;
        }

        /// <inheritdoc />
        public IReadOnlyList<StampUpgradeImport> Since(DateTime since)
        {
            var list = new List<StampUpgradeImport>();
            IReadOnlyList<JfLibraryRoot>? libraries = null;
            foreach (var instance in _store.Registry.All().Where(c => c.Usable))
            {
                if (_store.PeekHistory(instance.Id) is not { } history) continue;
                foreach (var import in Pair(history.Records, since))
                {
                    libraries ??= _library.Libraries();
                    var path = BridgePaths.InLibraryCase(JellyfinBridge.Map(instance, import.ImportedPath!), libraries);
                    list.Add(new StampUpgradeImport(instance.Id + ":" + import.Id.ToString(System.Globalization.CultureInfo.InvariantCulture), path, import.Date!.Value));
                }
            }

            return list;
        }

        /// <summary>The imports in these records that replaced a file deleted for "Upgrade" (pure; tests).</summary>
        /// <param name="records">History records (any order).</param>
        /// <param name="since">Only imports at or after this time (UTC).</param>
        /// <returns>The upgrade imports.</returns>
        internal static IReadOnlyList<ArrHistoryEntry> Pair(IReadOnlyList<ArrHistoryEntry> records, DateTime since)
        {
            var deletions = records
                .Where(r => r.Date is DateTime && r.EventType != null && r.EventType.EndsWith("FileDeleted", StringComparison.OrdinalIgnoreCase)
                    && string.Equals(r.Reason, "Upgrade", StringComparison.OrdinalIgnoreCase) && Subject(r) != null)
                .ToList();
            var list = new List<ArrHistoryEntry>();
            if (deletions.Count == 0) return list;
            foreach (var import in records)
            {
                if (import.Date is not DateTime at || at < since || import.EventType == null || !import.EventType.EndsWith("Imported", StringComparison.OrdinalIgnoreCase)) continue;
                if (string.IsNullOrWhiteSpace(import.ImportedPath) || Subject(import) is not { } subject) continue;
                if (deletions.Any(d => Subject(d) == subject && (d.Date!.Value - at).Duration() <= Pairing)) list.Add(import);
            }

            return list;
        }

        private static string? Subject(ArrHistoryEntry r) => r.EpisodeId is int e ? "e" + e : r.MovieId is int m ? "m" + m : null;
    }

    /// <summary>A person's acquisition badge preferences (read on the server, never from a request body).</summary>
    public interface IAcquisitionBadgePreferences
    {
        /// <summary>Web poster-card badges: null follows the administrator, false hides them.</summary>
        /// <param name="user">The person.</param>
        /// <returns>The preference.</returns>
        bool? WebBadges(Guid user);
    }

    /// <summary>Badge preferences from each person's Jellyfin Enhanced settings (<c>settings.json</c>).</summary>
    public sealed class UserSettingsBadgePreferences : IAcquisitionBadgePreferences
    {
        private readonly Configuration.UserConfigurationManager _users;

        /// <summary>Creates the reader (DI).</summary>
        /// <param name="users">User settings.</param>
        public UserSettingsBadgePreferences(Configuration.UserConfigurationManager users)
        {
            _users = users;
        }

        /// <inheritdoc />
        public bool? WebBadges(Guid user)
            => _users.GetUserConfiguration<Configuration.UserSettings>(user.ToString("N"), "settings.json").AcquisitionBadges;
    }

    /// <summary>Removes a deleted person's stamp facts.</summary>
    public sealed class AcquisitionStampUserPurge : MediaBrowser.Controller.Events.IEventConsumer<Jellyfin.Data.Events.Users.UserDeletedEventArgs>
    {
        private readonly AcquisitionStampStore _store;
        private readonly Logger _logger;

        /// <summary>Creates the consumer (DI).</summary>
        /// <param name="store">Stamp store.</param>
        /// <param name="logger">JE logger.</param>
        public AcquisitionStampUserPurge(AcquisitionStampStore store, Logger logger)
        {
            _store = store;
            _logger = logger;
        }

        /// <inheritdoc />
        public System.Threading.Tasks.Task OnEvent(Jellyfin.Data.Events.Users.UserDeletedEventArgs eventArgs)
        {
            if (eventArgs?.Argument is { } user && user.Id != Guid.Empty)
            {
                try
                {
                    _store.PurgeUser(user.Id);
                }
                catch (Exception ex)
                {
                    _logger.Debug($"Acquisition badges: removing a deleted user's stamps failed: {ex.Message}");
                }
            }

            return System.Threading.Tasks.Task.CompletedTask;
        }
    }
}
