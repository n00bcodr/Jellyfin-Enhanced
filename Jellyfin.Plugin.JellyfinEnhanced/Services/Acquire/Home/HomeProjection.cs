using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Stamps;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Home
{
    /// <summary>One card of a home row (see docs/advanced/api.md, <c>GET acquire/home</c>).</summary>
    public sealed class HomeCard
    {
        /// <summary>Title key (also its live key).</summary>
        [JsonPropertyName("key")] public string Key { get; init; } = string.Empty;

        /// <summary>The key the change feed announces the title under, when it differs.</summary>
        [JsonPropertyName("liveKey")] public string? LiveKey { get; init; }

        /// <summary>movie or tv.</summary>
        [JsonPropertyName("kind")] public string Kind { get; init; } = "movie";

        /// <summary>TMDB id.</summary>
        [JsonPropertyName("tmdbId")] public int? TmdbId { get; init; }

        /// <summary>Title.</summary>
        [JsonPropertyName("title")] public string Title { get; init; } = string.Empty;

        /// <summary>Year.</summary>
        [JsonPropertyName("year")] public int? Year { get; init; }

        /// <summary>TMDB poster path.</summary>
        [JsonPropertyName("poster")] public string? Poster { get; init; }

        /// <summary>The Jellyfin item the viewer can open (for an arrived episode, the episode).</summary>
        [JsonPropertyName("itemId")] public string? ItemId { get; init; }

        /// <summary>For an episode card: the series item, whose poster the card shows (never the episode's still).</summary>
        [JsonPropertyName("posterItemId")] public string? PosterItemId { get; init; }

        /// <summary>The id of this card in a Home Screen Sections row: the item, else the native page id of the title.</summary>
        [JsonPropertyName("hssId")] public string? HssId { get; init; }

        /// <summary>The title's status (the viewer's shape).</summary>
        [JsonPropertyName("status")] public TitleStatus? Status { get; init; }

        /// <summary>Coming soon: the next date; Just arrived: when it first arrived.</summary>
        [JsonPropertyName("date")] public DateTime? Date { get; init; }

        /// <summary><see cref="Date"/> as a calendar day ("yyyy-MM-dd") when it has no time.</summary>
        [JsonPropertyName("day")] public string? Day { get; init; }

        /// <summary>Season of the episode the card is about.</summary>
        [JsonPropertyName("season")] public int? Season { get; init; }

        /// <summary>Number of the episode the card is about.</summary>
        [JsonPropertyName("episode")] public int? Episode { get; init; }

        /// <summary>Name of the episode the card is about.</summary>
        [JsonPropertyName("episodeTitle")] public string? EpisodeTitle { get; init; }

        /// <summary>The part asked for is the 4K copy.</summary>
        [JsonPropertyName("is4k")] public bool Is4k { get; init; }

        /// <summary>From a follow, not from the viewer's own request.</summary>
        [JsonPropertyName("follow")] public bool Follow { get; init; }
    }

    /// <summary>The home rows of one person (<c>GET acquire/home</c>). A row that is null is switched off for them.</summary>
    public sealed class HomeAnswer
    {
        /// <summary>Your requests (own, not ready yet).</summary>
        [JsonPropertyName("requests"), JsonIgnore(Condition = JsonIgnoreCondition.Never)] public List<HomeCard>? Requests { get; init; }

        /// <summary>Coming soon for you (own requests and follows dated in the next 30 days).</summary>
        [JsonPropertyName("soon"), JsonIgnore(Condition = JsonIgnoreCondition.Never)] public List<HomeCard>? Soon { get; init; }

        /// <summary>Just arrived for you (first arrived in the last 7 days; upgrades left out).</summary>
        [JsonPropertyName("arrived"), JsonIgnore(Condition = JsonIgnoreCondition.Never)] public List<HomeCard>? Arrived { get; init; }

        /// <summary>The rows are Home Screen Sections sections on this server.</summary>
        [JsonPropertyName("hss")] public bool Hss { get; init; }

        /// <summary>The administrator's strip is on for this person.</summary>
        [JsonPropertyName("ops")] public bool Ops { get; init; }
    }

    /// <summary>
    /// The viewer's home rows, from the same facts as the Requests page (their own requests in the ledger or Seerr, the
    /// status composer, Jellyfin) plus the titles they follow, each with its own window: Coming soon is 30 days and
    /// Just arrived 7 (not the page's 60 and 14). Built in memory, never calling an arr or Seerr; titles followed
    /// without a date from any arr get one from TMDB through the shared cache within a short budget. A Manager sees only
    /// their own requests here. Cached per person (policy, preferences, follows, first arrivals) with a private ETag.
    /// </summary>
    public sealed class HomeProjection
    {
        /// <summary>Most cards per row.</summary>
        public const int MaxCards = 20;

        /// <summary>How far ahead Coming soon looks.</summary>
        public static readonly TimeSpan SoonWithin = TimeSpan.FromDays(30);

        /// <summary>How far back Just arrived looks.</summary>
        public static readonly TimeSpan ArrivedWithin = TimeSpan.FromDays(7);

        /// <summary>Most followed titles one answer looks up a TMDB date for.</summary>
        private const int MaxDateLookups = 20;

        private static readonly JsonSerializerOptions Json = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        };

        private readonly RequestsHubService _hub;
        private readonly NotifyStore? _notify;
        private readonly HomeArrivals _arrivals;
        private readonly IHomePreferences _preferences;
        private readonly IHomeLibrary _library;
        private readonly Func<PluginConfiguration?> _config;
        private readonly Func<IReadOnlyList<(TitleKey Key, int Tmdb)>, CancellationToken, Task<Dictionary<string, FollowDate>>> _dates;
        private readonly Func<IEnumerable<string>, StatusViewer, CancellationToken, Task<Dictionary<string, HubTitleMeta>>> _meta;
        private readonly Func<int, SyntheticKindHint, string?> _synthetic;
        private readonly Func<bool>? _hssNow;

        /// <summary>Creates the projection (DI).</summary>
        public HomeProjection(RequestsHubService hub, NotifyStore notify, HomeArrivals arrivals, IHomePreferences preferences, ILibraryManager library, RequestHubProjection projection, TmdbResponseCache tmdb, IServerConfigurationManager serverConfig, MediaBrowser.Controller.IServerApplicationHost host, IStampLibrary sources)
            : this(hub, notify, arrivals, preferences, new JellyfinHomeLibrary(library, sources), () => JellyfinEnhanced.Instance?.Configuration,
                (keys, ct) => FollowDates.ReadAsync(tmdb, Region(serverConfig), keys, ct), projection.MetaAsync, (tmdb, kind) => SyntheticHssId(host.SystemId, tmdb, kind), () => HomeFlags.HssSections(JellyfinEnhanced.Instance?.Configuration) && HssSectionsAdapter.Present)
        {
        }

        /// <summary>Creates the projection with explicit sources (tests).</summary>
        internal HomeProjection(
            RequestsHubService hub,
            NotifyStore? notify,
            HomeArrivals arrivals,
            IHomePreferences preferences,
            IHomeLibrary library,
            Func<PluginConfiguration?> config,
            Func<IReadOnlyList<(TitleKey Key, int Tmdb)>, CancellationToken, Task<Dictionary<string, FollowDate>>> dates,
            Func<IEnumerable<string>, StatusViewer, CancellationToken, Task<Dictionary<string, HubTitleMeta>>> meta,
            Func<int, SyntheticKindHint, string?> synthetic, Func<bool>? hssNow = null)
        {
            _hub = hub;
            _notify = notify;
            _arrivals = arrivals;
            _preferences = preferences;
            _library = library;
            _config = config;
            _dates = dates;
            _meta = meta;
            _synthetic = synthetic;
            _hssNow = hssNow;
        }

        /// <summary>Which kind of title a native page id names.</summary>
        public enum SyntheticKindHint
        {
            /// <summary>A movie.</summary>
            Movie,

            /// <summary>A series.</summary>
            Series,
        }

        /// <summary>The status service (viewer lookup).</summary>
        public ArrStatusService Status => _hub.Status;

        /// <summary>The rows the person sees (switches and their own preferences).</summary>
        /// <param name="user">The person.</param>
        /// <returns>The rows.</returns>
        public HomeRowChoice Choice(Guid user) => HomeRowChoice.Of(_config(), _preferences.For(user));

        /// <summary>The viewer's home rows body (null when home rows are off).</summary>
        /// <param name="viewer">The viewer.</param>
        /// <param name="hss">The rows are Home Screen Sections sections on this server.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The body, or null.</returns>
        public async Task<StatusBody?> ForViewerAsync(StatusViewer viewer, bool hss, CancellationToken cancellationToken)
        {
            var gate = new AcquireResponseGate(Status.View, viewer.UserId, current =>
            {
                var c = _config();
                var prefs = HomeRowChoice.Of(c, _preferences.For(current.UserId));
                var follows = CurrentFollows(current.UserId);
                return string.Join("|", HomeFlags.Rows(c), prefs, HomeFlags.HssSections(c), _hssNow?.Invoke(), NotifyFlags.Enabled(c),
                    MutationInput.Hash(JsonSerializer.Serialize(c)), MutationInput.Hash(string.Join(",", follows.OrderBy(f => f.Key, StringComparer.Ordinal)
                        .ThenBy(f => f.Kind, StringComparer.Ordinal).Select(f => f.Key + ":" + f.Kind + ":" + f.CreatedAt))));
            });
            for (var attempt = 0; attempt < AcquireResponseGate.Attempts; attempt++)
            {
                if (gate.Read() is not { } policy || !HomeFlags.Rows(_config())) return null;
                try { return await PrepareAsync(policy.Viewer, _hssNow?.Invoke() ?? hss, gate, policy, cancellationToken).ConfigureAwait(false); }
                catch (AcquireResponseGate.Changed) { cancellationToken.ThrowIfCancellationRequested(); }
                // The status service's own check after its arr reads (the viewer was removed or their policy changed
                // meanwhile) is the same change: prepare again under the current policy, or fail closed.
                catch (ArrStatusService.ViewerChangedException) { cancellationToken.ThrowIfCancellationRequested(); }
            }
            return null;
        }

        private IReadOnlyList<FollowRow> CurrentFollows(Guid user)
            => !NotifyFlags.Enabled(_config()) || _notify?.Available != true ? Array.Empty<FollowRow>()
                : _notify.Follows(user).Where(f => !f.Muted && TitleKey.Parse(f.Key) != null).ToList();

        private async Task<StatusBody?> PrepareAsync(StatusViewer viewer, bool hss, AcquireResponseGate gate, AcquireResponseGate.Policy policy, CancellationToken cancellationToken)
        {
            var config = _config();
            if (!HomeFlags.Rows(config)) return null;
            _arrivals.EnsureSeeded();
            var choice = HomeRowChoice.Of(config, _preferences.For(viewer.UserId));
            // Follows count only while notifications (where "Notify me" lives) are on; muted ones are "not interested".
            var follows = choice.None || !NotifyFlags.Enabled(config) || _notify == null || !_notify.Available
                ? Array.Empty<FollowRow>()
                : (IReadOnlyList<FollowRow>)_notify.Follows(viewer.UserId).Where(f => !f.Muted && TitleKey.Parse(f.Key) != null).ToList();
            var followKeys = follows.Select(f => TitleKey.Parse(f.Key)!.Title).GroupBy(k => k.ToString(), StringComparer.Ordinal).Select(g => g.First()).ToList();
            var meta = followKeys.Count == 0 ? new Dictionary<string, HubTitleMeta>() : await _meta(followKeys.Select(k => k.ToString()), viewer, cancellationToken).ConfigureAwait(false);
            // TMDB dates for followed titles (only those soon can show; arrs' dates come first at build time).
            var lookups = new List<(TitleKey, int)>();
            if (choice.Soon)
            {
                foreach (var key in followKeys)
                {
                    var tmdb = key.Provider == "tmdb" ? key.NumericId : Status.Aliases.Of(key).FirstOrDefault(a => a.Provider == "tmdb" && a.IsMovie == key.IsMovie)?.NumericId;
                    if (tmdb is int id && id > 0 && lookups.Count < MaxDateLookups) lookups.Add((key, id));
                }
            }
            var dates = lookups.Count == 0 ? new Dictionary<string, FollowDate>() : await _dates(lookups, cancellationToken).ConfigureAwait(false);
            var what = string.Join(
                "|",
                "home2",
                policy.Revision,
                (choice.Requests ? "r" : "-") + (choice.Soon ? "s" : "-") + (choice.Arrived ? "a" : "-") + (choice.Ops && viewer.IsAdmin ? "o" : "-") + (hss ? "h" : "-"),
                _arrivals.Revision.ToString(CultureInfo.InvariantCulture),
                MutationInput.Hash(string.Join(",", follows.Select(f => f.Key + ":" + f.Kind).OrderBy(k => k, StringComparer.Ordinal))),
                MutationInput.Hash(string.Join(",", meta.OrderBy(m => m.Key, StringComparer.Ordinal).Select(m => m.Key + "=" + m.Value.Title + "/" + m.Value.Year + "/" + m.Value.Poster + "/" + m.Value.ItemId))),
                MutationInput.Hash(string.Join(",", dates.OrderBy(d => d.Key, StringComparer.Ordinal).Select(d => d.Key + "=" + d.Value))));
            return await _hub.ForHomeAsync(viewer, what, followKeys, (entries, composed) => JsonSerializer.SerializeToUtf8Bytes(Build(viewer, choice, hss, entries, composed, follows, meta, dates), Json), cancellationToken, respond => gate.Project(policy, _ => respond())).ConfigureAwait(false);
        }

        /// <summary>The rows (typed) from a body this projection made.</summary>
        /// <param name="body">The body.</param>
        /// <returns>The rows, or null when unreadable.</returns>
        public static HomeAnswer? Read(StatusBody body)
        {
            try
            {
                return JsonSerializer.Deserialize<HomeAnswer>(body.Json, Json);
            }
            catch (JsonException)
            {
                return null;
            }
        }

        private HomeAnswer Build(StatusViewer viewer, HomeRowChoice choice, bool hss, IReadOnlyList<HubEntry> entries, IReadOnlyList<ArrStatusService.KeyedStatus> composed, IReadOnlyList<FollowRow> follows, Dictionary<string, HubTitleMeta> meta, Dictionary<string, FollowDate> dates)
        {
            var now = Status.Now.UtcDateTime;
            // Followed titles only (a title the viewer asked for is the request's card). A title asked for in both editions is
            // composed once per edition (phase 4b), so the map takes the first of each title.
            var byKey = composed.GroupBy(t => t.Key.Title.ToString(), StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
            // A request's own edition (its copy to open and its arrival): never the other edition's result for the same title.
            var byEdition = composed.GroupBy(t => (t.Key.Title.ToString(), t.Only4k)).ToDictionary(g => g.Key, g => g.First());
            var requested = entries.Select(e => TitleKey.Parse(e.Key)?.Title.ToString()).OfType<string>().ToHashSet(StringComparer.Ordinal);
            // Follows of titles the viewer also asked for are the request's (one card per title).
            var followed = follows.GroupBy(f => TitleKey.Parse(f.Key)!.Title.ToString(), StringComparer.Ordinal)
                .Where(g => !requested.Contains(g.Key)).ToList();

            List<HomeCard>? requests = null;
            if (choice.Requests)
            {
                requests = entries.Where(e => e.Group is HubGroup.NeedsOk or HubGroup.OnTheWay or HubGroup.NotOut)
                    .Take(MaxCards).Select(e => Card(e)).ToList();
            }

            List<HomeCard>? soon = null;
            if (choice.Soon)
            {
                var cards = new List<(DateTime At, HomeCard Card)>();
                foreach (var e in entries)
                {
                    if (e.Group is HubGroup.Declined or HubGroup.Removed || e.NextDate is not DateTime next || !Ahead(next, e.NextDay, now)) continue;
                    var summary = e.Status.Summary;
                    cards.Add((next, Card(e, date: next, day: e.NextDay, season: summary?.NextSeason, episode: summary?.NextEpisode)));
                }
                foreach (var group in followed)
                {
                    if (!byKey.TryGetValue(group.Key, out var title)) continue;
                    var status = title.Status;
                    DateTime? next = status.NextDate ?? status.Summary?.NextAir;
                    var day = status.NextDate != null ? status.NextDay
                        : status.Summary?.NextAir is DateTime airs && status.Summary.NextAirIsDay ? StatusComposer.DayOf(airs) : null;
                    int? season = status.Summary?.NextSeason, episode = status.Summary?.NextEpisode;
                    if (next == null && dates.TryGetValue(group.Key, out var tmdb))
                    {
                        next = tmdb.Date;
                        day = StatusComposer.DayOf(tmdb.Date);
                        season = tmdb.Season;
                        episode = tmdb.Episode;
                    }
                    if (next is not DateTime at || !Ahead(at, day, now)) continue;
                    // A season follow counts only for its own season's episodes.
                    var seasons = SeasonsOf(group);
                    if (seasons != null && (season == null || !seasons.Contains(season.Value))) continue;
                    cards.Add((at, FollowCard(title, meta.GetValueOrDefault(group.Key), date: at, day: day, season: season, episode: episode)));
                }
                soon = cards.OrderBy(c => c.At).Take(MaxCards).Select(c => c.Card).ToList();
            }

            List<HomeCard>? arrived = null;
            if (choice.Arrived)
            {
                var cards = new List<(DateTime At, HomeCard Card)>();
                foreach (var e in entries)
                {
                    if (e.Group is HubGroup.Declined || TitleKey.Parse(e.Key) is not { } key || !byEdition.TryGetValue((key.Title.ToString(), e.Is4k), out var title)) continue;
                    if (key.IsMovie)
                    {
                        if (e.Group != HubGroup.Ready || title.Visible == null) continue;
                        var first = MovieArrival(key, viewer, e.Is4k, title.Visible);
                        // Fulfilment timestamps date the edition, not first content: never use them to revive an upgrade.
                        if (e.Is4k && first == null) continue;
                        if (e.Is4k && first is DateTime contentAt && e.AskedAt is DateTime askedAt && !ContentArrivalHistory.InterestPrecedes(askedAt, contentAt)) continue;
                        if (e.FirstArrivedAt is DateTime evidence && (first == null || evidence < first)) first = evidence;
                        if (first is DateTime at && now - at <= ArrivedWithin && at <= now) cards.Add((at, Card(e, date: at)));
                    }
                    else if (NewestEpisode(key, viewer, e.Seasons, e.Episodes?.Select(p => (p.Season, p.Episode)).ToList(), now, e.Is4k, e.Status.Stage == StatusStage.Ready, e.AskedAt) is { } ep)
                    {
                        cards.Add((ep.At, Card(e, date: ep.At, season: ep.Season, episode: ep.Episode, episodeTitle: ep.Name, itemId: ep.ItemId, posterItemId: ep.SeriesItemId)));
                    }
                }
                foreach (var group in followed)
                {
                    if (!byKey.TryGetValue(group.Key, out var title) || title.Visible == null || TitleKey.Parse(group.Key) is not { } key) continue;
                    if (key.IsMovie)
                    {
                        if (MovieArrival(key, viewer, false, title.Visible) is DateTime at && now - at <= ArrivedWithin && at <= now)
                            cards.Add((at, FollowCard(title, meta.GetValueOrDefault(group.Key), date: at)));
                    }
                    else if (NewestEpisode(key, viewer, SeasonsOf(group), null, now) is { } ep)
                    {
                        cards.Add((ep.At, FollowCard(title, meta.GetValueOrDefault(group.Key), date: ep.At, season: ep.Season, episode: ep.Episode, episodeTitle: ep.Name, itemId: ep.ItemId, posterItemId: ep.SeriesItemId)));
                    }
                }
                arrived = cards.OrderByDescending(c => c.At).Take(MaxCards).Select(c => c.Card).ToList();
            }

            return new HomeAnswer { Requests = requests, Soon = soon, Arrived = arrived, Hss = hss, Ops = choice.Ops && viewer.IsAdmin };

            HomeCard Card(HubEntry e, DateTime? date = null, string? day = null, int? season = null, int? episode = null, string? episodeTitle = null, string? itemId = null, string? posterItemId = null)
            {
                var item = itemId ?? e.ItemId;
                return new HomeCard
                {
                    Key = e.Key,
                    LiveKey = e.LiveKey,
                    Kind = e.Kind,
                    TmdbId = e.TmdbId,
                    Title = e.Title,
                    Year = e.Year,
                    Poster = e.Poster,
                    ItemId = item,
                    PosterItemId = posterItemId,
                    HssId = item ?? (e.TmdbId is int t ? _synthetic(t, e.Kind == "movie" ? SyntheticKindHint.Movie : SyntheticKindHint.Series) : null),
                    Status = e.Status,
                    Date = date,
                    Day = day,
                    Season = season,
                    Episode = episode,
                    EpisodeTitle = episodeTitle,
                    Is4k = e.Is4k,
                };
            }

            HomeCard FollowCard(ArrStatusService.KeyedStatus title, HubTitleMeta? m, DateTime? date = null, string? day = null, int? season = null, int? episode = null, string? episodeTitle = null, string? itemId = null, string? posterItemId = null)
            {
                var key = title.Key.Title;
                var tmdb = key.Provider == "tmdb" ? key.NumericId : Status.Aliases.Of(key).FirstOrDefault(a => a.Provider == "tmdb" && a.IsMovie == key.IsMovie)?.NumericId;
                var item = itemId ?? title.Visible?.ItemId.ToString("N", CultureInfo.InvariantCulture) ?? m?.ItemId;
                return new HomeCard
                {
                    Key = title.Status.Key.Length > 0 ? title.Status.Key : key.ToString(),
                    LiveKey = title.Status.LiveKey,
                    Kind = key.IsMovie ? "movie" : "tv",
                    TmdbId = tmdb,
                    Title = m?.Title ?? string.Empty,
                    Year = m?.Year,
                    Poster = m?.Poster,
                    ItemId = item,
                    PosterItemId = posterItemId,
                    HssId = item ?? (tmdb is int t ? _synthetic(t, key.IsMovie ? SyntheticKindHint.Movie : SyntheticKindHint.Series) : null),
                    Status = title.Status,
                    Date = date,
                    Day = day,
                    Season = season,
                    Episode = episode,
                    EpisodeTitle = episodeTitle,
                    Follow = true,
                };
            }
        }

        // A date still to come within the window: an instant after now, or a day still ahead somewhere.
        private static bool Ahead(DateTime at, string? day, DateTime now)
            => (day == null ? at > now : StatusComposer.DayStillAhead(at, now)) && at - now <= SoonWithin;

        // The seasons a follow group covers (season follows), or null for the whole title.
        private static HashSet<int>? SeasonsOf(IEnumerable<FollowRow> group)
        {
            var keys = group.Select(f => TitleKey.Parse(f.Key)!).ToList();
            if (keys.Any(k => k.Season == null)) return null;
            return keys.Select(k => k.Season!.Value).ToHashSet();
        }

        /// <summary>
        /// When a movie first arrived for the viewer: the earliest first-arrival date of the editions they can open
        /// (only the 4K copies for a 4K request). Content never recorded uses authoritative source observations before legacy creation dates.
        /// </summary>
        private DateTime? MovieArrival(TitleKey key, StatusViewer viewer, bool only4k, JfCopy visible)
        {
            DateTime? first = null;
            var copies = Status.View.Copies(key, viewer, Status.Aliases.Of(key)).Where(c => c.Visible).ToList();
            if (copies.Count == 0) copies.Add(visible);
            foreach (var copy in copies)
            {
                if (_library.Item(copy.ItemId) is not { } item)
                {
                    // An item the library no longer resolves: the copy's own date.
                    if (only4k) continue;
                    if (copy.DateCreated is DateTime created && (first == null || created < first)) first = created;
                    continue;
                }
                if (only4k && !item.FourK) continue;
                foreach (var content in item.Content)
                {
                    if (FirstContentArrival(item, content) is not DateTime at) continue;
                    var editionAt = EditionArrival(item, content, only4k);
                    if (only4k && (editionAt == null || ContentArrivalHistory.IsLaterVersion(at, editionAt.Value))) continue;
                    if (first == null || at < first) first = at;
                    // A standard ask or a follow: the title was here once any edition was (an upgrade from 1080p to 2160p
                    // in the same Radarr replaces the standard file with a 4K one).
                    if (!only4k && HomeArrivals.OtherEdition(content) is { } other && _arrivals.FirstAt(other) is DateTime earlier && earlier < first) first = earlier;
                }
            }
            return first;
        }

        // Content history is shared with badges: every source contributes to the title's first content,
        // independently of the edition requested. Unknown source observations must not fall back to DateCreated.
        private DateTime? FirstContentArrival(HomeItem item, string content)
        {
            var arrivals = item.Sources.Select(s => _arrivals.SourceAt(s.Identity)).OfType<DateTime>().ToList();
            var standard = _arrivals.EditionAt(content, false);
            var fourK = _arrivals.EditionAt(content, true);
            if (standard is DateTime hd) arrivals.Add(hd);
            if (fourK is DateTime uhd) arrivals.Add(uhd);
            if (arrivals.Count > 0) return _arrivals.FirstAtOrRecord(content, arrivals.Min());
            return item.Sources.Count == 0 ? _arrivals.FirstAtOrRecord(content, item.Created) : _arrivals.FirstAt(content);
        }

        private DateTime? EditionArrival(HomeItem item, string content, bool only4k)
        {
            if (item.Sources.Count == 0) return _arrivals.EditionAt(content, only4k) ?? item.Created;
            var arrivals = item.Sources.Where(s => !only4k || EditionAvailability.IsFourK(s.Width, s.Height))
                .Select(s => _arrivals.SourceAt(s.Identity)).OfType<DateTime>().ToList();
            return arrivals.Count == 0 ? null : arrivals.Min();
        }

        private sealed record NewEpisode(DateTime At, int Season, int Episode, string? Name, string ItemId, string SeriesItemId);

        /// <summary>
        /// The newest episode of a series that first arrived in the last 7 days among the part the viewer is interested
        /// in (requested seasons and single episodes; a followed season; else any), in a copy they can open.
        /// </summary>
        private NewEpisode? NewestEpisode(TitleKey key, StatusViewer viewer, IEnumerable<int>? seasons, IReadOnlyList<(int Season, int Episode)>? picked, DateTime now, bool only4k = false, bool ready = true, DateTime? askedAt = null)
        {
            if (!ready && only4k) return null;
            var seasonSet = seasons?.ToHashSet();
            if (seasonSet is { Count: 0 }) seasonSet = null;
            NewEpisode? best = null;
            foreach (var copy in Status.View.Copies(key, viewer, Status.Aliases.Of(key)).Where(c => c.Visible))
            {
                var seriesKey = _library.Item(copy.ItemId)?.SeriesKey;
                foreach (var e in Status.View.Episodes(copy.ItemId, null, viewer, includeVirtual: false))
                {
                    if (e.Virtual || e.Hidden || e.ItemId == Guid.Empty) continue;
                    if (only4k && _library.Item(e.ItemId) is not { FourK: true }) continue;
                    if (e.DateCreated is not DateTime created) continue;
                    var last = Math.Min(Math.Max(e.Episode, e.EpisodeEnd ?? e.Episode), e.Episode + 49);
                    for (var number = e.Episode; number <= last; number++)
                    {
                        var inScope = (seasonSet == null && picked == null) || seasonSet?.Contains(e.Season) == true
                            || picked?.Any(p => p.Season == e.Season && p.Episode == number) == true;
                        if (!inScope) continue;
                        var content = HomeArrivals.EpisodeContent(seriesKey ?? key, e.Season, number);
                        var item = _library.Item(e.ItemId);
                        var arrival = item != null ? FirstContentArrival(item, content) : created;
                        if (arrival is not DateTime first) continue;
                        var edition = item != null ? EditionArrival(item, content, only4k) : null;
                        if (only4k && (edition == null || ContentArrivalHistory.IsLaterVersion(first, edition.Value)
                            || (askedAt is DateTime interest && !ContentArrivalHistory.InterestPrecedes(interest, first)))) continue;
                        if (now - first > ArrivedWithin || first > now) continue;
                        if (best == null || first > best.At || (first == best.At && (e.Season, number).CompareTo((best.Season, best.Episode)) > 0))
                            best = new NewEpisode(first, e.Season, number, null, e.ItemId.ToString("N", CultureInfo.InvariantCulture), copy.ItemId.ToString("N", CultureInfo.InvariantCulture));
                    }
                }
            }
            if (best == null) return null;
            var name = Guid.TryParse(best.ItemId, out var id) ? _library.Item(id)?.Name : null;
            return best with { Name = string.IsNullOrWhiteSpace(name) ? null : name };
        }

        private static string Region(IServerConfigurationManager serverConfig)
        {
            var code = serverConfig.Configuration?.MetadataCountryCode;
            return string.IsNullOrWhiteSpace(code) ? "US" : code.Trim().ToUpperInvariant();
        }

        /// <summary>The Home Screen Sections id of a title that isn't in the library: its native page id (Jellyfin 12 only).</summary>
        private static string? SyntheticHssId(string serverId, int tmdb, SyntheticKindHint kind)
        {
#if JF12
            var id = kind == SyntheticKindHint.Movie ? NativeDetails.SyntheticId.Movie(tmdb) : NativeDetails.SyntheticId.Series(tmdb);
            return id.ToGuid(serverId).ToString("N", CultureInfo.InvariantCulture);
#else
            return null;
#endif
        }
    }

    /// <summary>What the home rows read about a library item.</summary>
    /// <param name="Content">Its first-arrival content keys (<see cref="HomeArrivals.ContentOf"/>).</param>
    /// <param name="Created">When Jellyfin created it (UTC).</param>
    /// <param name="FourK">A 4K copy.</param>
    /// <param name="Name">Its name.</param>
    /// <param name="SeriesKey">For a series: its key from its own provider ids.</param>
    public sealed record HomeItem(IReadOnlyList<string> Content, DateTime Created, bool FourK, string? Name, TitleKey? SeriesKey)
    {
        /// <summary>Playable source facts from the shared badge adapter.</summary>
        public IReadOnlyList<StampSource> Sources { get; init; } = Array.Empty<StampSource>();
    }

    /// <summary>The library as the home rows read it (a seam for tests).</summary>
    public interface IHomeLibrary
    {
        /// <summary>An item by id (no access check: callers pass items the viewer's copies or episodes already named), or null.</summary>
        /// <param name="id">Item id.</param>
        /// <returns>The item facts.</returns>
        HomeItem? Item(Guid id);
    }

    /// <summary>The home rows' view of Jellyfin's library.</summary>
    public sealed class JellyfinHomeLibrary : IHomeLibrary
    {
        private readonly ILibraryManager _library;
        private readonly IStampLibrary? _sources;

        /// <summary>Creates the view.</summary>
        /// <param name="library">Jellyfin's library.</param>
        public JellyfinHomeLibrary(ILibraryManager library, IStampLibrary? sources = null) { _library = library; _sources = sources; }

        /// <inheritdoc />
        public HomeItem? Item(Guid id)
        {
            if (_library.GetItemById(id) is not { } item) return null;
            var created = item.DateCreated.Kind == DateTimeKind.Local ? item.DateCreated.ToUniversalTime() : DateTime.SpecifyKind(item.DateCreated, DateTimeKind.Utc);
            var sourceItem = _sources?.Item(id);
            return new HomeItem(HomeArrivals.ContentOf(item), created, sourceItem?.FourK ?? HomeArrivals.IsFourK(item), item.Name, item is MediaBrowser.Controller.Entities.TV.Series ? HomeArrivals.SeriesKey(item) : null) { Sources = sourceItem?.Sources ?? Array.Empty<StampSource>() };
        }
    }
}
