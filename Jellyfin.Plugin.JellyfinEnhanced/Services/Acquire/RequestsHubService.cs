using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
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
    }

    /// <summary>One of the viewer's own requests on the Requests page (one per title, all its requests merged).</summary>
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

        /// <summary>When it became ready (Jellyfin added it), for the Ready tab.</summary>
        public DateTime? ReadyAt { get; init; }

        /// <summary>Release or next air date, when there is one.</summary>
        public DateTime? NextDate { get; init; }

        /// <summary>The group (<see cref="HubGroup"/>).</summary>
        public string Group { get; init; } = HubGroup.OnTheWay;

        /// <summary>The title's status (family shape; admins also get its admin block).</summary>
        public TitleStatus Status { get; init; } = new();
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

        /// <summary>My requests: needs OK, on the way, not out yet, said no.</summary>
        public IReadOnlyList<HubEntry> Mine { get; init; } = Array.Empty<HubEntry>();

        /// <summary>Coming soon: own requests with a date in the next 60 days, soonest first.</summary>
        public IReadOnlyList<HubEntry> Soon { get; init; } = Array.Empty<HubEntry>();

        /// <summary>Ready: own requests that arrived in the last 14 days, newest first.</summary>
        public IReadOnlyList<HubEntry> Ready { get; init; } = Array.Empty<HubEntry>();

        /// <summary>Administrators only; absent for everyone else.</summary>
        public HubAdmin? Admin { get; init; }
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

        private readonly ArrStatusService _status;
        private readonly SeerrRequestReadModel _requests;
        private readonly Func<PluginConfiguration?> _config;

        /// <summary>The service (DI).</summary>
        public RequestsHubService(ArrStatusService status, SeerrRequestReadModel requests)
            : this(status, requests, null)
        {
        }

        /// <summary>The service with explicit configuration (tests).</summary>
        internal RequestsHubService(ArrStatusService status, SeerrRequestReadModel requests, Func<PluginConfiguration?>? config)
        {
            _status = status;
            _requests = requests;
            _config = config ?? (() => JellyfinEnhanced.Instance?.Configuration);
        }

        /// <summary>The status service (viewer lookup, request counter).</summary>
        public ArrStatusService Status => _status;

        /// <summary>Phase 1 and the Requests page are on.</summary>
        public bool Enabled => _status.Enabled && _config()?.ArrRequestsHubEnabled == true;

        /// <summary>The Requests page body for the viewer.</summary>
        public Task<StatusBody> ForViewerAsync(StatusViewer viewer, CancellationToken cancellationToken)
        {
            _requests.Touch();
            var config = _config();
            var entries = _requests.ForUser(viewer.UserId)
                .GroupBy(r => r.Key!.ToString())
                .Select(g => g.ToList())
                .OrderByDescending(g => g.Max(r => r.CreatedAt ?? DateTime.MinValue))
                .Take(MaxTitles)
                .ToList();
            var keys = entries.Select(g => g[0].Key!).ToList();
            // Each title is judged by the part asked for: a request for Season 3 of a series Jellyfin
            // already has isn't "Ready", nor is a 4K request for a title Jellyfin has in standard
            // quality. And by the viewer's own requests only: someone else's OK'd request for the
            // same title doesn't make theirs "OK'd".
            var scopes = new Dictionary<TitleKey, ArrStatusService.RequestScope>();
            foreach (var records in entries)
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
                // Seerr's word on the variant asked for (a 4K request holds the 4K state).
                var available = asked.Where(r => r.Active && r.MediaStatus == 5).ToList();
                scopes[records[0].Key!.Title] = new ArrStatusService.RequestScope(
                    seasons,
                    only4k,
                    SeerrRequestReadModel.FactsOf(records, viewer.UserId),
                    available.Count > 0,
                    available.Select(r => r.UpdatedAt ?? r.CreatedAt).Where(d => d.HasValue).DefaultIfEmpty(null).Max());
            }
            var state = _requests.State;
            var adminTabs = viewer.IsAdmin
                ? (config?.DownloadsPageEnabled == true ? "d" : "-") + (config?.CalendarPageEnabled == true ? "c" : "-") + (state.LastError ?? string.Empty) + state.LastReadAt?.UtcTicks.ToString(CultureInfo.InvariantCulture)
                : string.Empty;
            var what = string.Join("|", _requests.Active ? "on" : "off", _requests.Loaded ? "loaded" : "-", state.LastError == null ? "ok" : "err", adminTabs);
            return _status.ForTitlesAsync(viewer, keys, "hub", what, titles => Build(viewer, entries, titles, config, state), cancellationToken, scopes);
        }

        private byte[] Build(StatusViewer viewer, List<List<SeerrRequestRecord>> entries, IReadOnlyList<ArrStatusService.KeyedStatus> titles, PluginConfiguration? config, SeerrReadModelState state)
        {
            var now = _status.Now.UtcDateTime;
            var byKey = titles.ToDictionary(t => t.Key.ToString(), StringComparer.Ordinal);
            var mine = new List<HubEntry>();
            var soon = new List<HubEntry>();
            var ready = new List<HubEntry>();
            foreach (var records in entries)
            {
                var first = records[0];
                if (!byKey.TryGetValue(first.Key!.ToString(), out var composed)) continue;
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
                if (entry.Group != HubGroup.Declined && entry.NextDate is DateTime next && next > now && next - now <= SoonWithin) soon.Add(entry);
            }
            var (contact, lookingHours) = _status.Texts();
            var response = new HubResponse
            {
                Contact = contact,
                LookingHours = lookingHours,
                Seerr = new HubSeerr { Configured = _requests.Active, Loaded = _requests.Loaded, Unavailable = state.LastError != null },
                Mine = mine.OrderBy(e => GroupOrder(e.Group)).ThenByDescending(e => e.AskedAt ?? DateTime.MinValue).ToList(),
                Soon = soon.OrderBy(e => e.NextDate).ToList(),
                Ready = ready.OrderByDescending(e => e.ReadyAt ?? DateTime.MinValue).ToList(),
                Admin = viewer.IsAdmin
                    ? new HubAdmin { Downloads = config?.DownloadsPageEnabled == true, Calendar = config?.CalendarPageEnabled == true, Seerr = state }
                    : null,
            };
            return JsonSerializer.SerializeToUtf8Bytes(response, Json);
        }

        private static int GroupOrder(string group) => group switch
        {
            HubGroup.NeedsOk => 0,
            HubGroup.OnTheWay => 1,
            HubGroup.NotOut => 2,
            _ => 3,
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
            var next = status.NextDate ?? status.Summary?.NextAir ?? (meta?.NextDate is DateTime seerrDate && seerrDate > now ? seerrDate : null);
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
                Group = group,
                Status = status,
            };
        }
    }
}
