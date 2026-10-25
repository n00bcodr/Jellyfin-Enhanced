using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>One episode of a request (season and episode number).</summary>
    /// <param name="Season">Season number.</param>
    /// <param name="Episode">Episode number.</param>
    public sealed record HubEpisode(int Season, int Episode);

    /// <summary>Where a request sits on the Requests page.</summary>
    public static class HubGroup
    {
        /// <summary>Waiting for an OK.</summary>
        public const string NeedsOk = "needsOk";

        /// <summary>OK'd and on its way (looking, downloading, almost ready).</summary>
        public const string OnTheWay = "onTheWay";

        /// <summary>Not released or aired yet.</summary>
        public const string NotOut = "notOut";

        /// <summary>Ready to watch (shown for 14 days).</summary>
        public const string Ready = "ready";

        /// <summary>Declined (shown for 30 days).</summary>
        public const string Declined = "declined";

        /// <summary>
        /// Arrived, then removed from Jellyfin and the arrs ("Was here, since removed"; JE mode, shown for the
        /// 14 days a Ready request would be, counted from its arrival).
        /// </summary>
        public const string Removed = "removed";
    }

    /// <summary>One of the viewer's own requests on the Requests page (one per title and edition, its requests merged).</summary>
    public sealed class HubEntry
    {
        /// <summary>Title key.</summary>
        public string Key { get; init; } = string.Empty;

        /// <summary>The key the change feed announces the title under, when it differs.</summary>
        public string? LiveKey { get; init; }

        /// <summary>movie or tv.</summary>
        public string Kind { get; init; } = "movie";

        /// <summary>TMDB id (opens the Seerr more-info modal).</summary>
        public int? TmdbId { get; init; }

        /// <summary>Title ("" until Seerr's details are read).</summary>
        public string Title { get; init; } = string.Empty;

        /// <summary>Year.</summary>
        public int? Year { get; init; }

        /// <summary>TMDB poster path.</summary>
        public string? Poster { get; init; }

        /// <summary>The Jellyfin item the viewer can open, when there is one.</summary>
        public string? ItemId { get; init; }

        /// <summary>Seerr's state of the request: pending, approved, declined, failed or available.</summary>
        public string Request { get; init; } = "pending";

        /// <summary>Every request for this title was a 4K request.</summary>
        public bool Is4k { get; init; }

        /// <summary>Seasons asked for (series).</summary>
        public IReadOnlyList<int>? Seasons { get; init; }

        /// <summary>When the viewer first asked.</summary>
        public DateTime? AskedAt { get; init; }

        /// <summary>Single episodes asked for outside whole seasons (requests in Jellyfin Enhanced mode); null otherwise.</summary>
        public IReadOnlyList<HubEpisode>? Episodes { get; init; }

        /// <summary>When it became ready (Jellyfin added it), for the Ready tab.</summary>
        public DateTime? ReadyAt { get; init; }

        /// <summary>Release or next air date, when there is one.</summary>
        public DateTime? NextDate { get; init; }

        /// <summary><see cref="NextDate"/> as a calendar day ("yyyy-MM-dd") when it has no time (release dates).</summary>
        public string? NextDay { get; init; }

        /// <summary>The group (<see cref="HubGroup"/>).</summary>
        public string Group { get; init; } = HubGroup.OnTheWay;

        /// <summary>The title's status (family shape; admins also get its admin block).</summary>
        public TitleStatus Status { get; init; } = new();

        /// <summary>
        /// Server-side only (home rows): the earliest sign the part asked for arrived that an upgrade doesn't move (the
        /// ledger's fulfilment, Seerr's "available"), or null when there is none. Never sent.
        /// </summary>
        [JsonIgnore]
        public DateTime? FirstArrivedAt { get; init; }
    }

    /// <summary>The Requests page's Seerr line (family-safe: no address, no error text).</summary>
    public sealed class HubSeerr
    {
        /// <summary>Seerr is configured (and phase 1 on), so requests can show here.</summary>
        public bool Configured { get; init; }

        /// <summary>The request list has been read at least once.</summary>
        public bool Loaded { get; init; }

        /// <summary>The last read failed (what is shown may be out of date).</summary>
        public bool Unavailable { get; init; }

        /// <summary>
        /// Jellyfin Enhanced's own request list is the request backend (phase 3 in JE mode): requests
        /// show from it, so a Seerr that isn't set up is not a problem to report on the page.
        /// </summary>
        public bool Ledger { get; init; }
    }

    /// <summary>The Requests page's Sonarr/Radarr line (family-safe: no instance names, no error text).</summary>
    public sealed class HubArr
    {
        /// <summary>
        /// A Sonarr/Radarr's downloads can't be read right now (its queue or history is past its
        /// longest serve time): the titles it holds read "can't be checked" until it answers again.
        /// </summary>
        public bool Unavailable { get; init; }
    }

    /// <summary>Administrator-only part of the Requests page.</summary>
    public sealed class HubAdmin
    {
        /// <summary>The Downloads tab (the existing Downloads page, when it is enabled).</summary>
        public bool Downloads { get; init; }

        /// <summary>The Calendar tab (the existing Calendar page, when it is enabled).</summary>
        public bool Calendar { get; init; }

        /// <summary>The read model's state (last read, error in admin wording, calls).</summary>
        public SeerrReadModelState? Seerr { get; init; }

        /// <summary>The Overview, Activity, System and Audit tabs (phase 2); the Downloads tab then folds into Activity.</summary>
        public bool Hub { get; init; }
    }

    /// <summary>The Requests page body.</summary>
    public sealed class HubResponse
    {
        /// <summary>What the household calls the server owner, or empty.</summary>
        public string Contact { get; init; } = string.Empty;

        /// <summary>Hours after which "Looking" reads "Still looking".</summary>
        public int LookingHours { get; init; }

        /// <summary>Seerr's line.</summary>
        public HubSeerr Seerr { get; init; } = new();

        /// <summary>The Sonarr/Radarr line.</summary>
        public HubArr Arr { get; init; } = new();

        /// <summary>My requests: needs OK, on the way, not out yet, said no.</summary>
        public IReadOnlyList<HubEntry> Mine { get; init; } = Array.Empty<HubEntry>();

        /// <summary>Coming soon: own requests with a date in the next 60 days, soonest first.</summary>
        public IReadOnlyList<HubEntry> Soon { get; init; } = Array.Empty<HubEntry>();

        /// <summary>Ready: own requests that arrived in the last 14 days, newest first.</summary>
        public IReadOnlyList<HubEntry> Ready { get; init; } = Array.Empty<HubEntry>();

        /// <summary>Administrators only; absent for everyone else.</summary>
        public HubAdmin? Admin { get; init; }

        /// <summary>
        /// The user has more titles than the page lists (<see cref="RequestsHubService.MaxTitles"/>):
        /// open requests first, then the newest; the page says "Showing your newest 200 titles".
        /// </summary>
        public bool More { get; init; }
    }

    /// <summary>
    /// The Requests page (phase 1, "Seerr mode"): the viewer's own requests from the Seerr read model,
    /// each with its status from the arr snapshots and Jellyfin, grouped into My requests, Coming
    /// soon and Ready. Served from memory (no arr or Seerr call on the request), cached per user with
    /// a private ETag. Family members only ever see their own requests; administrators additionally
    /// get the Downloads/Calendar tab switches and the read model's state.
    /// </summary>
    public sealed class RequestsHubService
    {
        /// <summary>Most titles listed per user (the newest requests).</summary>
        public const int MaxTitles = 200;

        private static readonly TimeSpan ReadyFor = TimeSpan.FromDays(14);
        private static readonly TimeSpan DeclinedFor = TimeSpan.FromDays(30);
        private static readonly TimeSpan SoonWithin = TimeSpan.FromDays(60);

        private static readonly JsonSerializerOptions Json = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        };

        /// <summary>Most series whose Sonarr episode lists one Requests page read loads (the rest use what is in memory).</summary>
        private const int MaxEpisodeLoads = 20;

        private readonly ArrStatusService _status;
        private readonly SeerrFacts _requests;
        private readonly Func<PluginConfiguration?> _config;
        private readonly RequestLedger? _ledger;
        private Configuration.UserConfigurationManager? _hidden;
        private MediaBrowser.Controller.Library.ILibraryManager? _library;
        private TitleAliases? _aliases;
        private SpoilerPresentation? _presentation;
        private readonly Func<IEnumerable<string>, StatusViewer, CancellationToken, Task<Dictionary<string, HubTitleMeta>>>? _meta;

        /// <summary>The service (DI): Seerr's requests in Seerr mode, the request ledger once Jellyfin Enhanced handles requests.</summary>
        public RequestsHubService(ArrStatusService status, SeerrFacts requests, RequestLedger ledger, RequestHubProjection projection, Configuration.UserConfigurationManager? hidden = null, TitleAliases? aliases = null, MediaBrowser.Controller.Library.ILibraryManager? library = null, SpoilerPresentation? presentation = null)
            : this(status, requests, null, ledger, projection.MetaAsync)
        {
            _hidden = hidden;
            _library = library;
            _presentation = presentation;
            _aliases = aliases;
        }

        /// <summary>
        /// The service with explicit configuration (tests). Without <paramref name="ledger"/> the page always lists
        /// Seerr's requests; <paramref name="meta"/> names the ledger's titles (Jellyfin item, else TMDB).
        /// </summary>
        internal RequestsHubService(ArrStatusService status, SeerrFacts requests, Func<PluginConfiguration?>? config, RequestLedger? ledger = null, Func<IEnumerable<string>, StatusViewer, CancellationToken, Task<Dictionary<string, HubTitleMeta>>>? meta = null)
        {
            _status = status;
            _requests = requests;
            _config = config ?? (() => JellyfinEnhanced.Instance?.Configuration);
            _ledger = ledger;
            _meta = meta;
        }

        /// <summary>The status service (viewer lookup, request counter).</summary>
        public ArrStatusService Status => _status;

        /// <summary>Phase 1 and the Requests page are on.</summary>
        public bool Enabled => _status.Enabled && _config()?.ArrRequestsHubEnabled == true;

        /// <summary>
        /// The Requests page body for the viewer. Prepared again for the viewer as they are now when their policy
        /// changed while it was being prepared (see <see cref="ArrStatusService.ViewerChangedException"/>), up to
        /// <see cref="ArrStatusService.GateAttempts"/> times. Null (fail closed: the answer for a viewer who isn't
        /// there) when they were removed or disabled meanwhile, or still changing after the last attempt.
        /// </summary>
        public Task<StatusBody?> ForViewerAsync(StatusViewer viewer, CancellationToken cancellationToken)
            => Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.ComposeAsync(() => ForViewerAsyncFactsCore(viewer, cancellationToken));

        private async Task<StatusBody?> ForViewerAsyncFactsCore(StatusViewer viewer, CancellationToken cancellationToken)
        {
            for (var attempt = 1; attempt <= ArrStatusService.GateAttempts; attempt++)
            {
                try
                {
                    return await ForViewerOnceAsync(viewer, cancellationToken).ConfigureAwait(false);
                }
                catch (ArrStatusService.ViewerChangedException)
                {
                    if (_status.View.Viewer(viewer.UserId) is not { } changed) return null;
                    viewer = changed;
                }
            }
            return null;
        }

        private Task<StatusBody> ForViewerOnceAsync(StatusViewer viewer, CancellationToken cancellationToken)
        {
            var config = _config();
            if (_ledger != null && SharedRequestFacts.LedgerAuthority(config)) return ForLedgerAsync(viewer, config!, cancellationToken);
            var prepared = PrepareSeerr(viewer, config);
            return _status.ForTitlesAsync(viewer, prepared.Keys, "hub", prepared.What, composed => Build(viewer, prepared.Entries, composed, config, prepared.State, prepared.ArrDown, prepared.More), cancellationToken, presentation: PresentationGate(viewer), presentationRevision: prepared.PresentationRevision, editions: prepared.Scopes);
        }

        /// <summary>
        /// Home rows (phase 4d): the viewer's request entries as the Requests page builds them (every group, the page's
        /// own windows), composed together with <paramref name="extraKeys"/> (titles the viewer follows; no request
        /// scope) in one cached body under its own route. <paramref name="build"/> gets the entries and every composed
        /// title; <paramref name="what"/> names everything else the body depends on.
        /// </summary>
        internal Task<StatusBody> ForHomeAsync(StatusViewer viewer, string what, IReadOnlyCollection<TitleKey> extraKeys, Func<IReadOnlyList<HubEntry>, IReadOnlyList<ArrStatusService.KeyedStatus>, byte[]> build, CancellationToken cancellationToken, Func<Func<StatusBody>, StatusBody>? responseGate = null)
            => Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.ComposeAsync(() => ForHomeAsyncFactsCore(viewer, what, extraKeys, build, cancellationToken, responseGate));

        private async Task<StatusBody> ForHomeAsyncFactsCore(StatusViewer viewer, string what, IReadOnlyCollection<TitleKey> extraKeys, Func<IReadOnlyList<HubEntry>, IReadOnlyList<ArrStatusService.KeyedStatus>, byte[]> build, CancellationToken cancellationToken, Func<Func<StatusBody>, StatusBody>? responseGate = null)
        {
            var config = _config();
            var now = _status.Now.UtcDateTime;
            if (_ledger != null && SharedRequestFacts.LedgerAuthority(config))
            {
                var ledger = await PrepareLedgerAsync(viewer, config!, cancellationToken).ConfigureAwait(false);
                return await _status.ForTitlesAsync(viewer, With(ledger.Keys, extraKeys), "home", ledger.What + "|" + what, composed =>
                {
                    // Each requested edition is composed by itself (phase 4b): an entry takes its own edition's status.
                    var byKey = composed.GroupBy(t => (t.Key.ToString(), t.Only4k)).ToDictionary(g => g.Key, g => g.First());
                    var entries = ledger.Entries.Select(w => byKey.TryGetValue((w[0].Input.Key, w[0].Input.Variant == "4k"), out var c) ? LedgerEntry(w, c, ledger.Meta.GetValueOrDefault(w[0].Input.Key), now) : null).OfType<HubEntry>().ToList();
                    return build(entries, composed);
                }, cancellationToken, loadEpisodes: ledger.Load, responseGate: responseGate, editions: ledger.Scopes).ConfigureAwait(false);
            }
            var seerr = PrepareSeerr(viewer, config);
            return await _status.ForTitlesAsync(viewer, With(seerr.Keys, extraKeys), "home", seerr.What + "|" + what, composed =>
            {
                var byKey = composed.GroupBy(t => (t.Key.ToString(), t.Only4k)).ToDictionary(g => g.Key, g => g.First());
                var entries = seerr.Entries.Select(r => byKey.TryGetValue((r[0].Key!.ToString(), r[0].Is4k), out var c) ? Entry(r, c, now) : null).OfType<HubEntry>().ToList();
                return build(entries, composed);
            }, cancellationToken, responseGate: responseGate, editions: seerr.Scopes).ConfigureAwait(false);
        }

        private static List<TitleKey> With(IReadOnlyList<TitleKey> keys, IReadOnlyCollection<TitleKey> extra)
        {
            var all = keys.ToList();
            var seen = all.Select(k => k.Title.ToString()).ToHashSet(StringComparer.Ordinal);
            all.AddRange(extra.Where(k => seen.Add(k.Title.ToString())));
            return all;
        }

        private sealed record SeerrPrepared(List<List<SeerrRequestRecord>> Entries, List<TitleKey> Keys, Dictionary<(TitleKey Key, bool FourK), ArrStatusService.RequestScope> Scopes, SeerrReadModelState State, bool ArrDown, bool More, string What, string? PresentationRevision);

        private sealed record LedgerPrepared(List<List<RequestWant>> Entries, List<TitleKey> Keys, Dictionary<(TitleKey Key, bool FourK), ArrStatusService.RequestScope> Scopes, List<TitleKey> Load, Dictionary<string, HubTitleMeta> Meta, SeerrReadModelState State, bool ArrDown, bool More, string What, string? PresentationRevision);

        // The Requests page's final Hidden Content / Spoiler Guard projection (D46), read again when the body is answered.
        private Func<TitlePresentationPolicy>? PresentationGate(StatusViewer viewer)
            => _hidden == null ? null : () => TitlePresentationGate.Read(_hidden, _presentation, viewer.UserId, _library);

        private SeerrPrepared PrepareSeerr(StatusViewer viewer, PluginConfiguration? config)
        {
            _requests.Touch();
            var now = _status.Now.UtcDateTime;
            // Open requests first (an old one still waiting never drops off the end), then the newest.
            // Only titles certainly finished for the page are left out before composing: declined
            // ones older than the page keeps them. A finished one stays a candidate (after the open
            // ones, so it never pushes one out of the cap): its "Ready" days count from when it
            // arrived in Jellyfin, which only composing knows (Seerr may mark it available without
            // touching the request).
            var initial = _hidden == null ? null : TitlePresentationGate.Read(_hidden, _presentation, viewer.UserId, _library);
            var hidden = initial?.Hidden ?? HiddenContentPolicy.Build(null);
            var titles = _requests.ForUser(viewer.UserId).Where(r => !hidden.IsHidden(r.Key, _aliases, "requests"))
                .GroupBy(r => (r.Key!.ToString(), r.Is4k))
                .Select(g => g.ToList())
                .Where(g => g.Any(r => r.Active) || now - LastChange(g) <= DeclinedFor)
                .OrderBy(g => IsOpen(g) ? 0 : 1)
                .ThenByDescending(g => g.Max(r => r.CreatedAt ?? DateTime.MinValue))
                .ToList();
            var more = titles.Count > MaxTitles;
            // One edition per row (as in Jellyfin Enhanced mode): a 4K request after the standard copy arrived follows
            // the 4K copy, never shown Ready (or labelled) by the standard one.
            var entries = titles.Take(MaxTitles).ToList();
            var keys = entries.Select(g => g[0].Key!).ToList();
            // Each title is judged by the part asked for: a request for Season 3 of a series Jellyfin
            // already has isn't "Ready", nor is a 4K request for a title Jellyfin has in standard
            // quality. And by the viewer's own requests only: someone else's OK'd request for the
            // same title doesn't make theirs "OK'd".
            var scopes = new Dictionary<(TitleKey Key, bool FourK), ArrStatusService.RequestScope>();
            foreach (var records in entries)
            {
                scopes[(records[0].Key!.Title, records[0].Is4k)] = ScopeOf(records, viewer.UserId);
            }
            var state = _requests.State;
            var adminTabs = viewer.IsAdmin
                ? (config?.DownloadsPageEnabled == true ? "d" : "-") + (config?.CalendarPageEnabled == true ? "c" : "-") + (JellyfinBridge.Phase2(config) ? "h" : "-") + (state.LastError ?? string.Empty) + state.LastReadAt?.UtcTicks.ToString(CultureInfo.InvariantCulture)
                : string.Empty;
            var arrDown = ArrUnavailable();
            var what = string.Join("|", _presentation?.Load(viewer.UserId).Revision ?? "", _requests.Active ? "on" : "off", _requests.Loaded ? "loaded" : "-", state.LastError == null ? "ok" : "err", arrDown ? "arr-down" : "arr-ok", more ? "more" : "all", adminTabs);
            return new SeerrPrepared(entries, keys, scopes, state, arrDown, more, what, initial?.Revision);
        }

        /// <summary>
        /// The Requests page in Jellyfin Enhanced mode: the viewer's own requests from the request ledger, one entry per
        /// title edition, each judged by exactly the part the viewer asked for (movie and edition, seasons, single episodes) as
        /// the Seerr path judges a Seerr request: waiting for an OK, OK'd, looking, downloading, almost ready, ready
        /// (with Play) or said no. Open ones first, then the newest; fulfilled ones stay as Ready for two weeks after
        /// they arrived, declined ones for 30 days. Series asked for by season or episode have Sonarr's episode list
        /// read (a few per page) so a single episode is judged by itself, not by its season.
        /// </summary>
        private async Task<StatusBody> ForLedgerAsync(StatusViewer viewer, PluginConfiguration config, CancellationToken cancellationToken)
        {
            var prepared = await PrepareLedgerAsync(viewer, config, cancellationToken).ConfigureAwait(false);
            return await _status.ForTitlesAsync(viewer, prepared.Keys, "hub", prepared.What, composed => BuildLedger(viewer, prepared.Entries, composed, prepared.Meta, config, prepared.State, prepared.ArrDown, prepared.More), cancellationToken, loadEpisodes: prepared.Load, presentation: PresentationGate(viewer), presentationRevision: prepared.PresentationRevision, editions: prepared.Scopes).ConfigureAwait(false);
        }

        private async Task<LedgerPrepared> PrepareLedgerAsync(StatusViewer viewer, PluginConfiguration config, CancellationToken cancellationToken)
        {
            var ledger = _ledger!;
            var now = _status.Now.UtcDateTime;
            static bool Open(RequestWant w) => w.Status is "pending" or "queued" or "sent" or "stale";
            var mine = ledger.Database.Available ? ledger.List(viewer.UserId, false) : Array.Empty<RequestWant>();
            var initial = _hidden == null ? null : TitlePresentationGate.Read(_hidden, _presentation, viewer.UserId, _library);
            var hidden = initial?.Hidden ?? HiddenContentPolicy.Build(null);
            var titles = mine.Where(w => !hidden.IsHidden(TitleKey.Parse(w.Input.Key), _aliases, "requests")).Where(w => w.Status != "cancelled" && TitleKey.Parse(w.Input.Key) != null)
                .GroupBy(w => RequestDestination.Edition(w.Input))
                .Select(g => g.ToList())
                .Where(g => g.Any(w => w.Status != "declined") || now - g.Max(w => w.UpdatedAt.UtcDateTime) <= DeclinedFor)
                .OrderBy(g => g.Any(Open) ? 0 : 1)
                .ThenByDescending(g => g.Max(w => w.CreatedAt))
                .ToList();
            var more = titles.Count > MaxTitles;
            // One edition per row: a 4K ask after the standard copy arrived follows the 4K copy.
            var entries = titles.Take(MaxTitles).ToList();
            var keys = entries.Select(g => TitleKey.Parse(g[0].Input.Key)!).Distinct().ToList();
            var scopes = new Dictionary<(TitleKey Key, bool FourK), ArrStatusService.RequestScope>();
            for (var i = 0; i < entries.Count; i++)
            {
                var key = TitleKey.Parse(entries[i][0].Input.Key)!;
                scopes[(key, entries[i][0].Input.Variant == "4k")] = LedgerRequestFacts.ScopeOf(entries[i], viewer.UserId, () => ledger.Dispatches(key.ToString()));
            }
            var load = entries.Where(g => g.Any(Open)).Select(g => (Key: TitleKey.Parse(g[0].Input.Key)!, FourK: g[0].Input.Variant == "4k"))
                .Where(k => !k.Key.IsMovie && scopes[k] is var scope && (scope.Seasons.Count > 0 || scope.Episodes?.Count > 0))
                .Select(k => k.Key).Distinct().Take(MaxEpisodeLoads).ToList();
            var meta = _meta != null ? await _meta(keys.Select(k => k.ToString()), viewer, cancellationToken).ConfigureAwait(false) : new Dictionary<string, HubTitleMeta>();
            var state = _requests.State;
            var adminTabs = viewer.IsAdmin
                ? (config.DownloadsPageEnabled ? "d" : "-") + (config.CalendarPageEnabled ? "c" : "-") + (JellyfinBridge.Phase2(config) ? "h" : "-")
                : string.Empty;
            var arrDown = ArrUnavailable();
            var names = string.Join(",", meta.OrderBy(m => m.Key, StringComparer.Ordinal).Select(m => m.Key + "=" + m.Value.Title + "/" + m.Value.Year + "/" + m.Value.Poster + "/" + m.Value.ItemId));
            var what = string.Join("|", _presentation?.Load(viewer.UserId).Revision ?? "", "je", ledger.Revision.ToString(CultureInfo.InvariantCulture), arrDown ? "arr-down" : "arr-ok", more ? "more" : "all", adminTabs, MutationInput.Hash(names));
            return new LedgerPrepared(entries, keys, scopes, load, meta, state, arrDown, more, what, initial?.Revision);
        }

        private byte[] BuildLedger(StatusViewer viewer, List<List<RequestWant>> entries, IReadOnlyList<ArrStatusService.KeyedStatus> titles, Dictionary<string, HubTitleMeta> meta, PluginConfiguration config, SeerrReadModelState state, bool arrDown, bool more)
        {
            var now = _status.Now.UtcDateTime;
            var byKey = titles.ToDictionary(t => (t.Key.ToString(), t.Only4k));
            var mine = new List<HubEntry>();
            var soon = new List<HubEntry>();
            var ready = new List<HubEntry>();
            foreach (var wants in entries)
            {
                if (!byKey.TryGetValue((wants[0].Input.Key, wants[0].Input.Variant == "4k"), out var composed)) continue;
                var entry = LedgerEntry(wants, composed, meta.GetValueOrDefault(wants[0].Input.Key), now);
                if (entry == null) continue;
                if (entry.Group == HubGroup.Ready) ready.Add(entry);
                else mine.Add(entry);
                if (entry.Group != HubGroup.Declined && entry.NextDate is DateTime next && next - now <= SoonWithin
                    && (entry.NextDay == null ? next > now : StatusComposer.DayStillAhead(next, now))) soon.Add(entry);
            }
            var (contact, lookingHours) = _status.Texts();
            var response = new HubResponse
            {
                Contact = contact,
                LookingHours = lookingHours,
                Seerr = new HubSeerr { Configured = _requests.Active, Loaded = true, Unavailable = false, Ledger = true },
                Arr = new HubArr { Unavailable = arrDown },
                More = more,
                Mine = mine.OrderBy(e => GroupOrder(e.Group)).ThenByDescending(e => e.AskedAt ?? DateTime.MinValue).ToList(),
                Soon = soon.OrderBy(e => e.NextDate).ToList(),
                Ready = ready.OrderByDescending(e => e.ReadyAt ?? DateTime.MinValue).ToList(),
                Admin = viewer.IsAdmin
                    ? new HubAdmin { Downloads = config.DownloadsPageEnabled, Calendar = config.CalendarPageEnabled, Seerr = state, Hub = JellyfinBridge.Phase2(config) }
                    : null,
            };
            var json = JsonSerializer.Serialize(response, Json);
            return System.Text.Encoding.UTF8.GetBytes(_presentation?.Load(viewer.UserId).ProjectResource(json, null, "requests-hub") ?? json);
        }

        /// <summary>One title's entry from the viewer's ledger requests for it and its scoped status, or null when it is no longer worth showing.</summary>
        private HubEntry? LedgerEntry(List<RequestWant> wants, ArrStatusService.KeyedStatus composed, HubTitleMeta? meta, DateTime now)
        {
            var key = TitleKey.Parse(wants[0].Input.Key)!;
            var status = composed.Status;
            var active = wants.Where(w => w.Status is not ("declined" or "cancelled")).ToList();
            var request = active.Count == 0 ? "declined"
                : active.Any(w => w.Status == "pending") ? "pending"
                : active.All(w => w.Status == "fulfilled") ? "available"
                : "approved";
            DateTime? readyAt = null;
            string group;
            if (active.Count == 0)
            {
                if (now - wants.Max(w => w.UpdatedAt.UtcDateTime) > DeclinedFor) return null;
                group = HubGroup.Declined;
            }
            else if (status.Stage == StatusStage.Ready)
            {
                // When the part asked for arrived (else when the request was marked fulfilled).
                readyAt = (composed.Scoped ? composed.ArrivedAt : composed.Visible?.DateCreated)
                    ?? active.Where(w => w.Status == "fulfilled").Select(w => (DateTime?)w.UpdatedAt.UtcDateTime).Max()
                    ?? active.Max(w => w.UpdatedAt.UtcDateTime);
                if (readyAt is DateTime at && now - at > ReadyFor) return null;
                group = HubGroup.Ready;
            }
            else if (status.Reason?.Code == StatusReasonCode.Removed)
            {
                // Arrived once and gone since: told honestly (never "OK'd" again), for as long as it would have been Ready.
                var arrived = active.Where(w => w.Status == "fulfilled").Select(w => (DateTime?)w.UpdatedAt.UtcDateTime).Max() ?? active.Max(w => w.UpdatedAt.UtcDateTime);
                if (now - arrived > ReadyFor) return null;
                group = HubGroup.Removed;
            }
            else
            {
                group = status.Stage switch
                {
                    StatusStage.Asked => HubGroup.NeedsOk,
                    StatusStage.NotOut => HubGroup.NotOut,
                    _ => request == "pending" ? HubGroup.NeedsOk : HubGroup.OnTheWay,
                };
            }
            DateTime? next = status.NextDate ?? status.Summary?.NextAir;
            var nextDay = status.NextDate != null ? status.NextDay
                : status.Summary?.NextAir is DateTime airs && status.Summary.NextAirIsDay ? StatusComposer.DayOf(airs) : null;
            var tmdb = key.Provider == "tmdb" ? key.NumericId : _status.Aliases.Of(key).FirstOrDefault(k => k.Provider == "tmdb" && k.IsMovie == key.IsMovie)?.NumericId;
            // Whole seasons asked for, and single episodes outside them (shown as "S1E3"): of the requests still on, or
            // of the declined ones when nothing else is left.
            var shown = active.Count > 0 ? active : wants;
            var seasons = key.IsMovie ? null : shown.Where(w => w.Input.Scope != "episodes").SelectMany(w => w.Input.Seasons).Distinct().OrderBy(n => n).ToList();
            var episodes = key.IsMovie ? null : shown.Where(w => w.Input.Scope == "episodes").SelectMany(w => w.Input.Episodes)
                .Where(e => seasons == null || !seasons.Contains(e.Season)).Distinct().OrderBy(e => e.Season).ThenBy(e => e.Episode).Select(e => new HubEpisode(e.Season, e.Episode)).ToList();
            return new HubEntry
            {
                Key = status.Key,
                LiveKey = status.LiveKey,
                Kind = key.IsMovie ? "movie" : "tv",
                TmdbId = tmdb,
                Title = meta?.Title ?? string.Empty,
                Year = meta?.Year,
                Poster = meta?.Poster,
                // The copy of the part asked for (never the standard copy for a 4K request).
                ItemId = composed.Visible?.ItemId.ToString("N", CultureInfo.InvariantCulture),
                Request = request,
                Is4k = wants.All(w => w.Input.Variant == "4k"),
                Seasons = seasons is { Count: > 0 } ? seasons : null,
                Episodes = episodes is { Count: > 0 } ? episodes : null,
                AskedAt = wants.Min(w => w.CreatedAt).UtcDateTime,
                ReadyAt = readyAt,
                NextDate = next,
                NextDay = nextDay,
                Group = group,
                Status = status,
                FirstArrivedAt = active.Where(w => w.Status == "fulfilled").Select(w => (DateTime?)w.UpdatedAt.UtcDateTime).DefaultIfEmpty(null).Min(),
            };
        }

        /// <summary>A title's requests still under way: one is not declined, and neither Seerr nor its media says it is done.</summary>
        private static bool IsOpen(IReadOnlyList<SeerrRequestRecord> records)
            => records.Any(r => r.Active && r.Status != SeerrRequestStatus.Completed && r.MediaStatus != 5);

        private static DateTime LastChange(IReadOnlyList<SeerrRequestRecord> records)
            => records.Max(r => r.UpdatedAt ?? r.CreatedAt ?? DateTime.MinValue);

        /// <summary>True when any Sonarr/Radarr's queue or history has expired (see <see cref="HubArr.Unavailable"/>).</summary>
        private bool ArrUnavailable()
        {
            var store = _status.Store;
            return store.Instances(Arr.ArrKind.Radarr).Concat(store.Instances(Arr.ArrKind.Sonarr)).Any(store.PipelineExpired);
        }

        /// <summary>
        /// The part of a title one user's requests for it asked for (non-empty <paramref name="records"/>,
        /// all for the same title): the requested seasons, whether only the 4K copy was asked for, the
        /// facts of those requests only, and Seerr's word on whether that variant is available.
        /// </summary>
        internal static ArrStatusService.RequestScope ScopeOf(IReadOnlyList<SeerrRequestRecord> records, Guid userId)
        {
            var asked = records.Where(r => r.Active).DefaultIfEmpty(records[0]).ToList();
            var seasons = new List<int>();
            if (!records[0].IsMovie)
            {
                var all = asked.SelectMany(r => r.Seasons).Distinct().OrderBy(n => n).ToList();
                // Specials count only when they are all that was asked for.
                seasons = all.Where(n => n > 0).ToList();
                if (seasons.Count == 0 && all.Contains(0)) seasons.Add(0);
            }
            var only4k = asked.All(r => r.Is4k);
            // Seerr's word on the variant asked for (a 4K request holds the 4K state), and its own match of the 4K copy
            // (a hint for Play: used only when the viewer can open it). A list entry's status reads the same composition.
            var availability = SeerrFacts.AvailabilityOf(records);
            return new ArrStatusService.RequestScope(
                seasons,
                only4k,
                SeerrFacts.FactsOf(records, userId),
                availability.Available,
                availability.AvailableAt,
                availability.JellyfinItemId);
        }

        private byte[] Build(StatusViewer viewer, List<List<SeerrRequestRecord>> entries, IReadOnlyList<ArrStatusService.KeyedStatus> titles, PluginConfiguration? config, SeerrReadModelState state, bool arrDown, bool more)
        {
            var now = _status.Now.UtcDateTime;
            var byKey = titles.ToDictionary(t => (t.Key.ToString(), t.Only4k));
            var mine = new List<HubEntry>();
            var soon = new List<HubEntry>();
            var ready = new List<HubEntry>();
            foreach (var records in entries)
            {
                var first = records[0];
                if (!byKey.TryGetValue((first.Key!.ToString(), first.Is4k), out var composed)) continue;
                var entry = Entry(records, composed, now);
                if (entry == null) continue;
                switch (entry.Group)
                {
                    case HubGroup.Ready:
                        ready.Add(entry);
                        break;
                    default:
                        mine.Add(entry);
                        break;
                }
                if (entry.Group != HubGroup.Declined && entry.NextDate is DateTime next && next - now <= SoonWithin
                    && (entry.NextDay == null ? next > now : StatusComposer.DayStillAhead(next, now))) soon.Add(entry);
            }
            var (contact, lookingHours) = _status.Texts();
            var response = new HubResponse
            {
                Contact = contact,
                LookingHours = lookingHours,
                Seerr = new HubSeerr
                {
                    Configured = _requests.Active,
                    Loaded = _requests.Loaded,
                    Unavailable = state.LastError != null,
                    Ledger = config is { ArrIntegrationEnabled: true, ArrPhase1Enabled: true, ArrPhase3Enabled: true, ArrRequestBackend: "je" },
                },
                Arr = new HubArr { Unavailable = arrDown },
                More = more,
                Mine = mine.OrderBy(e => GroupOrder(e.Group)).ThenByDescending(e => e.AskedAt ?? DateTime.MinValue).ToList(),
                Soon = soon.OrderBy(e => e.NextDate).ToList(),
                Ready = ready.OrderByDescending(e => e.ReadyAt ?? DateTime.MinValue).ToList(),
                Admin = viewer.IsAdmin
                    ? new HubAdmin { Downloads = config?.DownloadsPageEnabled == true, Calendar = config?.CalendarPageEnabled == true, Seerr = state, Hub = JellyfinBridge.Phase2(config) }
                    : null,
            };
            var json = JsonSerializer.Serialize(response, Json);
            return System.Text.Encoding.UTF8.GetBytes(_presentation?.Load(viewer.UserId).ProjectResource(json, null, "requests-hub") ?? json);
        }

        private static int GroupOrder(string group) => group switch
        {
            HubGroup.NeedsOk => 0,
            HubGroup.OnTheWay => 1,
            HubGroup.NotOut => 2,
            HubGroup.Removed => 3,
            _ => 4,
        };

        /// <summary>One title's entry from its requests and status, or null when it is no longer worth showing (ready or declined long ago).</summary>
        private HubEntry? Entry(List<SeerrRequestRecord> records, ArrStatusService.KeyedStatus composed, DateTime now)
        {
            var first = records[0];
            var status = composed.Status;
            var active = records.Where(r => r.Active).ToList();
            var request = active.Count == 0 ? "declined"
                : active.Any(r => r.Status == SeerrRequestStatus.Pending) ? "pending"
                : active.Any(r => r.Status == SeerrRequestStatus.Completed || r.MediaStatus == 5) ? "available"
                : active.Any(r => r.Status == SeerrRequestStatus.Failed) ? "failed"
                : "approved";
            DateTime? readyAt = null;
            string group;
            if (active.Count == 0)
            {
                var last = records.Max(r => r.UpdatedAt ?? r.CreatedAt ?? DateTime.MinValue);
                if (now - last > DeclinedFor) return null;
                group = HubGroup.Declined;
            }
            else if (status.Stage == StatusStage.Ready)
            {
                // The status is of the part asked for (requested seasons, the 4K copy) when the request
                // named one, so "arrived" is when that part did, not when the title first came in.
                readyAt = (composed.Scoped ? composed.ArrivedAt : composed.Visible?.DateCreated) ?? active.Max(r => r.UpdatedAt);
                if (readyAt is DateTime at && now - at > ReadyFor) return null;
                group = HubGroup.Ready;
            }
            else
            {
                group = status.Stage switch
                {
                    StatusStage.Asked => HubGroup.NeedsOk,
                    StatusStage.NotOut => HubGroup.NotOut,
                    _ => request == "pending" ? HubGroup.NeedsOk : HubGroup.OnTheWay,
                };
            }
            var meta = _requests.Meta(first.IsMovie, records.Select(r => r.TmdbId).FirstOrDefault(t => t > 0));
            // The arrs' dates first; for a title no arr has yet, the date Seerr (TMDB) gives.
            // Seerr's (TMDB's) dates are calendar days; so are Radarr's release dates (NextDay).
            DateTime? next;
            string? nextDay;
            if (status.NextDate is DateTime arrDate)
            {
                next = arrDate;
                nextDay = status.NextDay;
            }
            else if (status.Summary?.NextAir is DateTime airs)
            {
                next = airs;
                // A Sonarr air date without a time is a calendar day too.
                nextDay = status.Summary.NextAirIsDay ? StatusComposer.DayOf(airs) : null;
            }
            else if (meta?.NextDate is DateTime seerrDate && StatusComposer.DayStillAhead(seerrDate, now))
            {
                next = seerrDate;
                nextDay = StatusComposer.DayOf(seerrDate);
            }
            else
            {
                next = null;
                nextDay = null;
            }
            return new HubEntry
            {
                Key = status.Key,
                LiveKey = status.LiveKey ?? (first.FeedKey is { } feed && feed != status.Key ? feed : null),
                Kind = first.IsMovie ? "movie" : "tv",
                TmdbId = records.Select(r => r.TmdbId).FirstOrDefault(t => t > 0),
                Title = meta?.Title ?? string.Empty,
                Year = meta?.Year,
                Poster = meta?.PosterPath,
                ItemId = composed.Visible?.ItemId.ToString("N", CultureInfo.InvariantCulture),
                Request = request,
                Is4k = records.All(r => r.Is4k),
                Seasons = first.IsMovie ? null : records.SelectMany(r => r.Seasons).Distinct().OrderBy(n => n).ToList(),
                AskedAt = records.Select(r => r.CreatedAt).Where(d => d.HasValue).DefaultIfEmpty(null).Min(),
                ReadyAt = readyAt,
                NextDate = next,
                NextDay = nextDay,
                Group = group,
                Status = status,
                // Seerr's "available" (its last change while available: an upgrade can only move this later, never earlier).
                FirstArrivedAt = active.Where(r => r.MediaStatus == 5 || r.Status == SeerrRequestStatus.Completed).Select(r => r.UpdatedAt).Where(d => d.HasValue).DefaultIfEmpty(null).Min(),
            };
        }
    }
}
