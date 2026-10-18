using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>Display facts of a title for the hub's request cards (no instance, profile or path).</summary>
    public sealed record HubTitleMeta
    {
        /// <summary>Title name.</summary>
        [JsonPropertyName("title")] public string? Title { get; init; }

        /// <summary>Release year.</summary>
        [JsonPropertyName("year")] public int? Year { get; init; }

        /// <summary>TMDB poster path ("/abc.jpg"), validated; the client builds the image URL.</summary>
        [JsonPropertyName("poster")] public string? Poster { get; init; }

        /// <summary>Official rating (Jellyfin's, else TMDB's certification for the server's country).</summary>
        [JsonPropertyName("rating")] public string? Rating { get; init; }

        /// <summary>A Jellyfin item of the title the caller can open.</summary>
        [JsonPropertyName("itemId")] public string? ItemId { get; init; }
    }

    /// <summary>
    /// The hub's request views over the ledger: approval cards for Managers and Admins (who asked,
    /// their role and quota use, the title's rating against a limited requester's limit, who else
    /// wants it, the ledger's size estimate, the free space where it would land and a 4K copy already
    /// here), the caller's own requests with display data, and the
    /// home chip bar's counts. Every list is filtered by the caller's current title visibility; names
    /// of other people only reach Managers and Admins; nothing names an instance, profile, folder or
    /// path. Title data comes from the caller's own Jellyfin items, else TMDB through the shared
    /// <see cref="TmdbResponseCache"/> (server key, cached, bounded per answer).
    /// </summary>
    public sealed class RequestHubProjection
    {
        /// <summary>Most cards in one answer.</summary>
        public const int MaxItems = 200;

        /// <summary>Most titles one answer resolves display data for.</summary>
        public const int MaxMetaTitles = 100;

        /// <summary>Most people named in "Also wanted by".</summary>
        public const int MaxAlsoWanted = 5;

        /// <summary>TMDB lookups running at once for one answer.</summary>
        private const int TmdbConcurrency = 4;

        /// <summary>How long one answer waits for TMDB in total.</summary>
        private static readonly TimeSpan TmdbBudget = TimeSpan.FromSeconds(6);

        /// <summary>Own finished, declined or cancelled requests stay listed this long.</summary>
        private static readonly TimeSpan KeepClosedFor = TimeSpan.FromDays(30);

        /// <summary>Reasons of a want that is held (at send, or because nothing can take its 4K copy) and needs a person to look at it.</summary>
        public static readonly IReadOnlySet<string> StuckReasons = new HashSet<string>(StringComparer.Ordinal)
        {
            "authorization_changed", "identity_changed", "configuration_changed", "instance_changed", "seerr_whole_series_only",
            "seerr_user_unlinked", RequestLedger.No4k,
        };

        private static readonly Regex PosterPath = new("^/[A-Za-z0-9_.-]{1,80}$", RegexOptions.CultureInvariant);
        private static readonly Regex ImdbId = new("^tt[0-9]{1,10}$", RegexOptions.CultureInvariant);
        private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };
        private readonly RequestService _service;
        private readonly IHouseholdDirectory _directory;
        private readonly TitleAliases? _aliases;
        private readonly Func<string, int, CancellationToken, Task<HubTitleMeta?>> _tmdb;
        private readonly Func<TitleKey, CancellationToken, Task<int?>>? _tmdbIdOf;
        private readonly Func<DateTimeOffset> _now;
        private readonly IRequestPlaces? _places;
        private readonly ArrStatusService? _status;
        private Configuration.UserConfigurationManager? _hidden;
        private MediaBrowser.Controller.Library.ILibraryManager? _library;
        private SpoilerPresentation? _presentation;

        /// <summary>Most requests in one answer that get the status of their part (the rest show their request state).</summary>
        public const int MaxPartStatuses = 60;

        /// <summary>Creates the projection over the shared TMDB cache (DI).</summary>
        public RequestHubProjection(RequestService service, IHouseholdDirectory directory, TitleAliases aliases, TmdbResponseCache tmdb, IServerConfigurationManager serverConfig, IRequestPlaces places, ArrStatusService status, Configuration.UserConfigurationManager? hidden = null, MediaBrowser.Controller.Library.ILibraryManager? library = null, SpoilerPresentation? presentation = null)
            : this(service, directory, aliases, (media, id, ct) => TmdbTitleAsync(tmdb, Region(serverConfig), media, id, ct), () => DateTimeOffset.UtcNow, places, status, (title, ct) => TmdbIdOfAsync(tmdb, title, ct))
        {
            _hidden = hidden;
            _library = library;
            _presentation = presentation;
        }

        /// <summary>Creates the projection with an explicit TMDB reader, clock, place facts and status service (tests; without one, no part statuses).</summary>
        /// <param name="tmdbIdOf">TMDB's id of a title known by its TVDB or IMDb id (TMDB's find), for one no Sonarr/Radarr or Seerr names yet.</param>
        internal RequestHubProjection(RequestService service, IHouseholdDirectory directory, TitleAliases? aliases, Func<string, int, CancellationToken, Task<HubTitleMeta?>> tmdb, Func<DateTimeOffset> now, IRequestPlaces? places = null, ArrStatusService? status = null, Func<TitleKey, CancellationToken, Task<int?>>? tmdbIdOf = null)
        {
            _service = service;
            _directory = directory;
            _aliases = aliases;
            _tmdb = tmdb;
            _tmdbIdOf = tmdbIdOf;
            _now = now;
            _places = places;
            _status = status;
        }

        /// <summary>
        /// Where exactly the part each request asks for has got to (movie and edition, seasons, single episodes), as
        /// <paramref name="caller"/> may see it: the status the Requests page shows for it (waiting for an OK, OK'd,
        /// looking, downloading, almost ready, ready). Requests on titles the caller may not ask about by key get
        /// none; at most <see cref="MaxPartStatuses"/>. Never calls an arr except to read a series' episode list.
        /// </summary>
        /// <param name="wants">Requests (already filtered for the caller).</param>
        /// <param name="caller">Who is looking.</param>
        /// <param name="ct">Cancels the reads.</param>
        internal Task<Dictionary<string, TitleStatus>> PartStatusesAsync(IEnumerable<RequestWant> wants, StatusViewer caller, CancellationToken ct)
            => PartStatusesAsync(wants.Select(w => new TitleRequests(w, new[] { w })), caller, ct);

        /// <summary>
        /// As <see cref="PartStatusesAsync(IEnumerable{RequestWant}, StatusViewer, CancellationToken)"/>, for list rows
        /// (<see cref="LedgerRequestFacts.PerTitle"/>): each row's status covers what all of its requests ask for, keyed by
        /// the row's id.
        /// </summary>
        /// <param name="rows">List rows (already filtered for the caller).</param>
        /// <param name="caller">Who is looking.</param>
        /// <param name="ct">Cancels the reads.</param>
        internal async Task<Dictionary<string, TitleStatus>> PartStatusesAsync(IEnumerable<TitleRequests> rows, StatusViewer caller, CancellationToken ct)
        {
            var result = new Dictionary<string, TitleStatus>(StringComparer.Ordinal);
            if (_status == null) return result;
            foreach (var row in rows.Take(MaxPartStatuses))
            {
                if (TitleKey.Parse(row.Row.Input.Key) is not { } key) continue;
                var title = key.ToString();
                var scope = LedgerRequestFacts.ScopeOf(row.Members, row.Row.UserId, () => _service.Ledger.Dispatches(title));
                var composed = await _status.ComposeForAsync(caller, new[] { key }, new Dictionary<TitleKey, ArrStatusService.RequestScope> { [key] = scope }, ct, loadEpisodes: true).ConfigureAwait(false);
                if (composed.Count > 0) result[row.Row.Id] = composed[0].Status;
            }
            return result;
        }

        /// <summary>The request service this projection reads.</summary>
        public RequestService Service => _service;

        /// <summary>The household directory (people and libraries).</summary>
        public IHouseholdDirectory Directory => _directory;

        /// <summary>
        /// Approval cards: every pending want the caller (a Manager or Admin) can see, oldest first,
        /// with display data. Administrators also get the reason code and job diagnostics.
        /// </summary>
        public async Task<StatusBody> ApprovalsAsync(StatusViewer caller, CancellationToken ct)
        {
            var viewer = _service.Identity(caller.UserId);
            var admin = viewer.Role == "Admin";
            var now = _now();
            var parked = Parked();
            var all = _service.Ledger.List(caller.UserId, true);
            var shown = new List<(RequestWant Want, RequestPolicyFacts Facts)>();
            foreach (var want in all)
            {
                var facts = _service.Policy.Evaluate(caller.UserId, want.Input);
                if (facts.Visible) shown.Add((want, facts));
            }
            var more = shown.Count > MaxItems;
            shown = shown.Take(MaxItems).ToList();
            var meta = await MetaAsync(shown.Select(s => s.Want.Input.Key), caller, ct).ConfigureAwait(false);
            var parts = await PartStatusesAsync(shown.Select(s => s.Want), caller, ct).ConfigureAwait(false);
            var estimates = Estimates(shown.Select(s => s.Want.Id));
            var people = new Dictionary<Guid, HouseholdPerson?>();
            HouseholdPerson? Person(Guid id) => people.TryGetValue(id, out var p) ? p : people[id] = _directory.Person(id);
            // Where each request would land (library name + rounded free space, never a path), once per
            // instance, folder and title.
            var places = new Dictionary<string, RequestPlace?>(StringComparer.Ordinal);
            if (_places != null)
            {
                foreach (var (want, _) in shown)
                {
                    var instance = _service.Policy.Evaluate(want.UserId, want.Input).InstanceId;
                    var placeKey = instance + "|" + want.Input.RootFolder + "|" + want.Input.Key;
                    if (!places.ContainsKey(placeKey)) places[placeKey] = await _places.PlaceAsync(instance, want.Input.RootFolder, want.Input.Key, ct).ConfigureAwait(false);
                }
            }
            var items = shown.Select(s =>
            {
                var w = s.Want;
                var requester = _service.Policy.Evaluate(w.UserId, w.Input);
                var requesterViewer = _service.View.Viewer(w.UserId);
                var quota = _service.Ledger.Quota(requester, now);
                var title = meta.GetValueOrDefault(w.Input.Key) ?? new HubTitleMeta();
                var stuck = StuckReasons.Contains(w.Reason) || parked.Contains(w.Id);
                var other = w.Input.Variant == "4k" ? w.Input with { Variant = "standard" } : w.Input with { Variant = "4k" };
                var otherFacts = _service.Policy.Evaluate(caller.UserId, other);
                // Only people who asked for the same part (an episode of another season isn't this request).
                var alsoWanted = _service.Ledger.ForTitle(w.Input.Key)
                    .Where(o => o.UserId != w.UserId && o.Status is "pending" or "queued" or "sent" or "stale" && o.Input.Overlaps(w.Input))
                    .Select(o => o.UserId).Distinct().Select(Person).Where(p => p != null && !p.Disabled)
                    .Select(p => p!.Name).Where(n => n.Length > 0).Distinct(StringComparer.Ordinal).Take(MaxAlsoWanted).ToArray();
                // A 4K copy that is already here (administrators also get the 4K instance's name).
                var place = places.GetValueOrDefault(requester.InstanceId + "|" + w.Input.RootFolder + "|" + w.Input.Key);
                var fourK = _places?.FourKHolder(w.Input.Key);
                return new
                {
                    id = w.Id,
                    key = w.Input.Key,
                    kind = TitleKey.Parse(w.Input.Key)?.IsMovie == true ? "movie" : "tv",
                    scope = w.Input.Scope,
                    variant = w.Input.Variant,
                    seasons = w.Input.Seasons,
                    episodes = w.Input.Episodes.Select(e => new { season = e.Season, episode = e.Episode }).ToArray(),
                    createdAt = w.CreatedAt,
                    reason = w.Reason,
                    overQuota = w.Reason == "over_quota",
                    stuck,
                    // Already OK'd (on its way, or held after its OK): nothing here waits for an OK any more.
                    okd = w.Status is not "pending",
                    cost = w.Cost,
                    title = title.Title,
                    year = title.Year,
                    poster = title.Poster,
                    itemId = title.ItemId,
                    requester = new
                    {
                        name = Person(w.UserId) is { Disabled: false } person && person.Name.Length > 0 ? person.Name : null,
                        role = requester.Role.ToLowerInvariant(),
                        quota = new { used = quota.Used, limit = quota.Limit, available = quota.Available },
                    },
                    // The title's rating against a limited requester's own limit; nothing when they have none.
                    rating = requesterViewer?.HasParentalLimit == true ? new { label = title.Rating, within = requester.Visible } : null,
                    alsoWanted,
                    estimateGb = estimates.TryGetValue(w.Id, out var gb) && gb > 0 ? (double?)Math.Round(gb, 1) : null,
                    space = place == null ? null : new { library = place.Library, freeGb = Math.Round(place.FreeBytes / 1_000_000_000.0, 1) },
                    already4k = fourK != null ? true : (bool?)null,
                    already4kIn = admin ? fourK : null,
                    // Where the part asked for is (it may be on its way or here already through someone else's request).
                    partStatus = parts.GetValueOrDefault(w.Id),
                    canApprove = viewer.CanApprove && s.Facts.CanApprove && (w.Input.Variant != "4k" || s.Facts.Can4k),
                    canSwitchVariant = viewer.CanApprove && otherFacts.CanApprove && (other.Variant != "4k" || otherFacts.Can4k),
                    admin = admin ? new { reason = w.Reason, jobs = _service.Ledger.ForWant(w.Id).Select(j => new { id = j.Id, state = j.State, attempts = j.Attempts, reason = j.Reason }).ToArray() } : null,
                };
            }).ToArray();
            var bytes = JsonSerializer.SerializeToUtf8Bytes(new { outcome = "accepted", reason = "approvals", certainty = "Succeeded", message = "Requests waiting for an OK", more, items }, Json);
            var json = System.Text.Encoding.UTF8.GetString(bytes);
            bytes = System.Text.Encoding.UTF8.GetBytes(_presentation?.Load(caller.UserId).Project(json) ?? json);
            return Body(caller.UserId, viewer, "approvals", bytes);
        }

        /// <summary>
        /// The caller's own requests in the ledger with display data: open ones always, finished,
        /// declined and cancelled ones for 30 days, one row per title edition (<see cref="LedgerRequestFacts.PerTitle"/>).
        /// <c>canCancel</c> marks rows with requests not sent yet (<c>cancelIds</c>).
        /// </summary>
        public async Task<StatusBody> MineAsync(StatusViewer caller, CancellationToken ct)
        {
            var viewer = _service.Identity(caller.UserId);
            var now = _now();
            var sending = InFlight();
            // One row per title edition: an ask and the Seerr request it was linked to when requests moved are one title.
            var hidden = _hidden == null ? HiddenContentPolicy.Build(null) : HiddenContentPolicy.Load(_hidden, caller.UserId, library: _library);
            var own = LedgerRequestFacts.PerTitle(_service.Ledger.List(caller.UserId, false)
                .Where(w => w.Status is "pending" or "queued" or "sent" or "stale" || now - w.UpdatedAt <= KeepClosedFor)
                .Where(w => _service.Policy.Evaluate(caller.UserId, w.Input).Visible)
                .Where(w => !hidden.IsHidden(TitleKey.Parse(w.Input.Key), _aliases, "requests"))
                .OrderByDescending(w => w.CreatedAt)).ToList();
            var more = own.Count > MaxItems;
            own = own.Take(MaxItems).ToList();
            var meta = await MetaAsync(own.Select(r => r.Row.Input.Key), caller, ct).ConfigureAwait(false);
            var items = own.Select(r =>
            {
                var w = r.Row;
                var cancel = r.Unsent.Where(m => !sending.Contains(m.Id)).Select(m => m.Id).ToArray();
                var title = meta.GetValueOrDefault(w.Input.Key) ?? new HubTitleMeta();
                return new
                {
                    id = w.Id,
                    key = w.Input.Key,
                    kind = TitleKey.Parse(w.Input.Key)?.IsMovie == true ? "movie" : "tv",
                    scope = w.Input.Scope,
                    variant = w.Input.Variant,
                    seasons = w.Input.Seasons,
                    episodes = w.Input.Episodes.Select(e => new { season = e.Season, episode = e.Episode }).ToArray(),
                    status = w.Status,
                    reason = w.Reason,
                    group = Group(w.Status),
                    createdAt = w.CreatedAt,
                    updatedAt = w.UpdatedAt,
                    canCancel = cancel.Length > 0,
                    // Every request the row stands for that Cancel withdraws (the row's own id may be a sent one).
                    cancelIds = cancel,
                    declineReason = w.Status == "declined" ? DeclineReason(w.Id) : null,
                    title = title.Title,
                    year = title.Year,
                    poster = title.Poster,
                    itemId = title.ItemId,
                };
            }).ToArray();
            var bytes = JsonSerializer.SerializeToUtf8Bytes(new { outcome = "accepted", reason = "mine", certainty = "Succeeded", message = "Your requests", more, items }, Json);
            var json = System.Text.Encoding.UTF8.GetString(bytes);
            bytes = System.Text.Encoding.UTF8.GetBytes(_presentation?.Load(caller.UserId).Project(json) ?? json);
            return Body(caller.UserId, viewer, "mine", bytes);
        }

        /// <summary>
        /// The home chip bar's counts for a Manager or Admin: requests waiting for their OK, and the
        /// visible ones held at send (stuck). Reads only memory and the ledger (no network).
        /// </summary>
        public StatusBody Attention(StatusViewer caller)
        {
            var viewer = _service.Identity(caller.UserId);
            var (needOk, stuck) = Counts(caller.UserId, viewer);
            var bytes = JsonSerializer.SerializeToUtf8Bytes(new { outcome = "accepted", reason = "attention", certainty = "Succeeded", message = "Needs attention", needOk, stuck }, Json);
            return Body(caller.UserId, viewer, "attention", bytes);
        }

        /// <summary>The counts behind <see cref="Attention"/>.</summary>
        internal (int NeedOk, int Stuck) Counts(Guid caller, RequestPolicyFacts viewer)
        {
            var parked = Parked();
            int needOk = 0, stuck = 0;
            foreach (var want in _service.Ledger.List(caller, true).Take(1000))
            {
                var facts = _service.Policy.Evaluate(caller, want.Input);
                if (!facts.Visible) continue;
                if (StuckReasons.Contains(want.Reason) || parked.Contains(want.Id)) stuck++;
                else if (viewer.CanApprove && facts.CanApprove && (want.Input.Variant != "4k" || facts.Can4k)) needOk++;
            }
            return (needOk, stuck);
        }

        /// <summary>The My requests group of a want state.</summary>
        internal static string Group(string status) => status switch
        {
            "pending" => "needsOk",
            "queued" or "sent" or "stale" => "onTheWay",
            "fulfilled" => "ready",
            "declined" => "declined",
            _ => "cancelled",
        };

        /// <summary>
        /// Display data per title key for one caller: their own visible Jellyfin item first (name,
        /// year, official rating), then TMDB (title, year, poster, certification) within a bounded
        /// budget. Keys past <see cref="MaxMetaTitles"/> or whose lookup fails get nothing.
        /// </summary>
        internal async Task<Dictionary<string, HubTitleMeta>> MetaAsync(IEnumerable<string> keys, StatusViewer caller, CancellationToken ct)
        {
            var result = new Dictionary<string, HubTitleMeta>(StringComparer.Ordinal);
            // A TMDB id known now, or (null) the title's TVDB/IMDb key to find it by first.
            var lookups = new List<(string Key, string Media, int? Id, TitleKey Title)>();
            foreach (var raw in keys.Distinct(StringComparer.Ordinal).Take(MaxMetaTitles))
            {
                if (TitleKey.Parse(raw) is not { } key) continue;
                var aliases = _aliases?.Of(key) ?? Array.Empty<TitleKey>();
                var copy = _service.View.Copies(key, caller, aliases).FirstOrDefault(c => c.Visible);
                var item = copy == null ? null : _directory.Item(copy.ItemId);
                result[raw] = new HubTitleMeta
                {
                    Title = string.IsNullOrWhiteSpace(item?.Name) ? null : item!.Name,
                    Year = item?.Year,
                    Rating = item?.OfficialRating,
                    ItemId = copy?.ItemId.ToString("N", CultureInfo.InvariantCulture),
                };
                var tmdb = key.Provider == "tmdb" ? key.NumericId : aliases.FirstOrDefault(a => a.Provider == "tmdb")?.NumericId;
                if (copy == null && tmdb is > 0) lookups.Add((raw, key.IsMovie ? "movie" : "tv", tmdb.Value, key));
                // Nothing names its TMDB id yet (a series asked for from its own page before any Sonarr has it): found by its id.
                else if (copy == null && tmdb == null && _tmdbIdOf != null && key.Provider is "tvdb" or "imdb") lookups.Add((raw, key.IsMovie ? "movie" : "tv", null, key));
            }
            if (lookups.Count == 0) return result;
            using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
            budget.CancelAfter(TmdbBudget);
            using var gate = new SemaphoreSlim(TmdbConcurrency);
            var answers = await Task.WhenAll(lookups.Select(async l =>
            {
                try
                {
                    await gate.WaitAsync(budget.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    return (l.Key, (HubTitleMeta?)null);
                }
                try
                {
                    var id = l.Id ?? await _tmdbIdOf!(l.Title, budget.Token).ConfigureAwait(false);
                    return (l.Key, id is int found and > 0 ? await _tmdb(l.Media, found, budget.Token).ConfigureAwait(false) : null);
                }
                catch (Exception) when (!ct.IsCancellationRequested)
                {
                    return (l.Key, (HubTitleMeta?)null);
                }
                finally
                {
                    gate.Release();
                }
            })).ConfigureAwait(false);
            ct.ThrowIfCancellationRequested();
            foreach (var (key, tmdb) in answers)
            {
                if (tmdb == null) continue;
                var known = result[key];
                result[key] = known with
                {
                    Title = known.Title ?? tmdb.Title,
                    Year = known.Year ?? tmdb.Year,
                    Poster = tmdb.Poster != null && PosterPath.IsMatch(tmdb.Poster) ? tmdb.Poster : null,
                    Rating = known.Rating ?? tmdb.Rating,
                };
            }
            return result;
        }

        /// <summary>Wants with a job parked for a person to look at.</summary>
        private HashSet<string> Parked() => _service.Ledger.Database.Read(c =>
        {
            using var command = RequestLedger.Cmd(c, null, "SELECT DISTINCT want_id FROM jobs WHERE state='parked'");
            using var reader = command.ExecuteReader();
            var set = new HashSet<string>(StringComparer.Ordinal);
            while (reader.Read()) set.Add(reader.GetString(0));
            return set;
        });

        /// <summary>Wants with a send under way or of unknown outcome (they can't be cancelled).</summary>
        private HashSet<string> InFlight() => _service.Ledger.Database.Read(c =>
        {
            using var command = RequestLedger.Cmd(c, null, "SELECT DISTINCT want_id FROM jobs WHERE state IN ('sending','maybe_sent','succeeded') OR json_extract(outcome,'$.certainty')='Unknown'");
            using var reader = command.ExecuteReader();
            var set = new HashSet<string>(StringComparer.Ordinal);
            while (reader.Read()) set.Add(reader.GetString(0));
            return set;
        });

        /// <summary>The ledger's size estimate (GB) of each want's held or charged reservations.</summary>
        private Dictionary<string, double> Estimates(IEnumerable<string> wantIds)
        {
            var ids = wantIds.ToHashSet(StringComparer.Ordinal);
            if (ids.Count == 0) return new Dictionary<string, double>(StringComparer.Ordinal);
            return _service.Ledger.Database.Read(c =>
            {
                using var command = RequestLedger.Cmd(c, null, "SELECT want_id,SUM(estimated_gb) FROM reservations WHERE state IN ('held','charged') GROUP BY want_id");
                using var reader = command.ExecuteReader();
                var map = new Dictionary<string, double>(StringComparer.Ordinal);
                while (reader.Read())
                {
                    var id = reader.GetString(0);
                    if (ids.Contains(id)) map[id] = reader.IsDBNull(1) ? 0 : reader.GetDouble(1);
                }
                return map;
            });
        }

        private string? DeclineReason(string wantId) => _service.Ledger.Database.Read(c =>
        {
            using var command = RequestLedger.Cmd(c, null, "SELECT reason FROM approvals WHERE want_id=$id AND action='declined' ORDER BY created_at DESC LIMIT 1", ("$id", wantId));
            return command.ExecuteScalar() as string;
        });

        /// <summary>A private body whose ETag covers the caller, their role, the policy revision and the bytes.</summary>
        internal static StatusBody Body(Guid user, RequestPolicyFacts viewer, string view, byte[] bytes)
        {
            var stamp = user.ToString("N", CultureInfo.InvariantCulture) + "|" + viewer.Role + "|" + viewer.Revision + "|" + view + "|";
            var hash = SHA256.HashData(Encoding.UTF8.GetBytes(stamp).Concat(bytes).ToArray());
            return new StatusBody(bytes, "\"" + Convert.ToHexString(hash, 0, 20) + "\"");
        }

        private static string Region(IServerConfigurationManager serverConfig)
        {
            var code = serverConfig.Configuration.MetadataCountryCode;
            return string.IsNullOrWhiteSpace(code) ? "US" : code.Trim().ToUpperInvariant();
        }

        /// <summary>TMDB's id of a title known by its TVDB or IMDb id (TMDB's find, through the shared cache), or null.</summary>
        internal static async Task<int?> TmdbIdOfAsync(TmdbResponseCache tmdb, TitleKey title, CancellationToken ct)
        {
            var key = JellyfinEnhanced.Instance?.Configuration.GetTmdbApiKey();
            var source = title.Provider switch { "tvdb" => "tvdb_id", "imdb" => "imdb_id", _ => null };
            if (string.IsNullOrEmpty(key) || source == null || string.IsNullOrWhiteSpace(title.Id)) return null;
            if (title.Provider == "tvdb" ? title.NumericId is not > 0 : !ImdbId.IsMatch(title.Id)) return null;
            var found = await tmdb.GetAsync("find/" + Uri.EscapeDataString(title.Id), "?external_source=" + source, key, ct, bundle: true).ConfigureAwait(false);
            return found.IsSuccess ? FoundTmdbId(found.Content, title.IsMovie) : null;
        }

        /// <summary>The first TMDB id of the kind asked for in a TMDB find answer, or null.</summary>
        internal static int? FoundTmdbId(string answer, bool movie)
        {
            try
            {
                using var doc = JsonDocument.Parse(answer);
                if (!doc.RootElement.TryGetProperty(movie ? "movie_results" : "tv_results", out var results) || results.ValueKind != JsonValueKind.Array) return null;
                foreach (var r in results.EnumerateArray())
                {
                    if (r.TryGetProperty("id", out var id) && id.TryGetInt32(out var found) && found > 0) return found;
                }
            }
            catch (JsonException)
            {
            }
            return null;
        }

        /// <summary>Title, year, poster and certification of a TMDB title through the shared cache (server key).</summary>
        private static async Task<HubTitleMeta?> TmdbTitleAsync(TmdbResponseCache tmdb, string region, string media, int id, CancellationToken ct)
        {
            var key = JellyfinEnhanced.Instance?.Configuration.GetTmdbApiKey();
            if (string.IsNullOrEmpty(key)) return null;
            var path = media + "/" + id.ToString(CultureInfo.InvariantCulture);
            var details = await tmdb.GetAsync(path, string.Empty, key, ct, bundle: true).ConfigureAwait(false);
            if (!details.IsSuccess) return null;
            var ratings = await tmdb.GetAsync(path + "/" + (media == "movie" ? "release_dates" : "content_ratings"), string.Empty, key, ct, bundle: true).ConfigureAwait(false);
            return ParseTmdb(media, details.Content, ratings.IsSuccess ? ratings.Content : null, region);
        }

        /// <summary>Reads a TMDB details answer (and its release dates / content ratings) into display facts.</summary>
        internal static HubTitleMeta? ParseTmdb(string media, string details, string? ratings, string region)
        {
            try
            {
                using var doc = JsonDocument.Parse(details);
                var root = doc.RootElement;
                string? Text(string name) => root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
                var title = Text(media == "movie" ? "title" : "name");
                var date = Text(media == "movie" ? "release_date" : "first_air_date");
                int? year = date is { Length: >= 4 } && int.TryParse(date.AsSpan(0, 4), NumberStyles.None, CultureInfo.InvariantCulture, out var y) ? y : null;
                var poster = Text("poster_path");
                return new HubTitleMeta
                {
                    Title = string.IsNullOrWhiteSpace(title) ? null : title.Trim(),
                    Year = year,
                    Poster = poster != null && PosterPath.IsMatch(poster) ? poster : null,
                    Rating = ratings == null ? null : Certification(media, ratings, region),
                };
            }
            catch (JsonException)
            {
                return null;
            }
        }

        private static string? Certification(string media, string ratings, string region)
        {
            try
            {
                using var doc = JsonDocument.Parse(ratings);
                if (!doc.RootElement.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array) return null;
                foreach (var country in results.EnumerateArray())
                {
                    if (!country.TryGetProperty("iso_3166_1", out var code) || code.GetString() != region) continue;
                    if (media != "movie")
                        return country.TryGetProperty("rating", out var r) && r.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(r.GetString()) ? Short(r.GetString()!) : null;
                    if (!country.TryGetProperty("release_dates", out var dates) || dates.ValueKind != JsonValueKind.Array) return null;
                    foreach (var release in dates.EnumerateArray())
                    {
                        if (release.TryGetProperty("certification", out var cert) && cert.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(cert.GetString())) return Short(cert.GetString()!);
                    }
                    return null;
                }
                return null;
            }
            catch (JsonException)
            {
                return null;
            }
        }

        private static string Short(string value) => value.Trim().Length > 12 ? value.Trim()[..12] : value.Trim();
    }
}
