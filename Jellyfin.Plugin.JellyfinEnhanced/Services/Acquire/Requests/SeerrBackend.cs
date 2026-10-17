using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>Seerr's request settings, read fresh. <c>Partial</c> is three-state: a value that isn't a real boolean is unknown.</summary>
    /// <param name="Partial">Partial (per-season) series requests: true, false or unknown (null).</param>
    /// <param name="Specials">Specials (season 0) can be requested; a missing flag counts as off.</param>
    /// <param name="Movie4k">A 4K Radarr is set up in Seerr.</param>
    /// <param name="Series4k">A 4K Sonarr is set up in Seerr.</param>
    public sealed record SeerrRequestSettings(bool? Partial, bool Specials, bool Movie4k, bool Series4k);

    /// <summary>A series' seasons as Seerr describes them (see <see cref="SeerrBackend.SeasonFactsAsync"/>).</summary>
    /// <param name="Started">Regular seasons that have started, ascending.</param>
    /// <param name="Covered">Seasons already requested by anyone (not declined), processing or available in the edition.</param>
    /// <param name="Declined">Seasons a request for the edition named and Seerr declined, and nothing covers.</param>
    public sealed record SeerrSeasonFacts(IReadOnlyList<int> Started, IReadOnlySet<int> Covered, IReadOnlySet<int> Declined);

    /// <summary>
    /// Seerr request mode: sends each approved request to Seerr as the person who asked
    /// (<c>X-Api-User</c> with JE's key), so Seerr's own permissions, quotas, approvals and override rules
    /// apply. <c>is4k</c> is always sent. The sent seasons are always a subset of what the person
    /// confirmed: with partial requests off or unknown, only a request for the whole series is sent.
    /// The account named in <c>X-Api-User</c> is confirmed by a fresh read right before every POST.
    /// A POST whose answer is lost is "maybe sent" and is never sent to another Seerr address; a fresh,
    /// scoped read of the title settles it. A 409 or a 202 "No seasons available" counts as success only
    /// with a JSON body and a fresh read that shows the scope already requested or available.
    /// </summary>
    public sealed class SeerrBackend : IRequestBackend
    {
        /// <summary>How long prepared identity facts may be used for policy decisions.</summary>
        internal static readonly TimeSpan PreparedFor = TimeSpan.FromMinutes(10);

        private static readonly TimeSpan IdsFor = TimeSpan.FromMinutes(10);
        private static readonly TimeSpan MissingIdFor = TimeSpan.FromSeconds(60);
        private static readonly TimeSpan SettingsFor = TimeSpan.FromSeconds(15);
        private static readonly TimeSpan ReadTimeout = TimeSpan.FromSeconds(15);
        private static readonly TimeSpan WriteTimeout = TimeSpan.FromSeconds(30);
        private const int MaxBody = 4 * 1024 * 1024;
        private const int MaxUserPages = 50;
        private const int Declined = 3;

        private readonly IHttpClientFactory _http;
        private readonly SeerrRequestReadModel _model;
        private readonly TitleAliases? _aliases;
        private readonly Func<PluginConfiguration?> _config;
        private readonly Func<DateTimeOffset> _now;
        private readonly Func<string, int, int[], bool>? _bind;
        private readonly Action<Guid>? _linked;
        private readonly Func<TitleKey, CancellationToken, Task<int?>>? _findTmdb;
        private readonly ConcurrentDictionary<Guid, Prepared> _prepared = new();
        private readonly ConcurrentDictionary<string, (int? Id, DateTimeOffset At)> _ids = new(StringComparer.Ordinal);
        private SettingsRead? _settings;

        /// <summary>
        /// Creates the backend (DI); each send is bound on its ledger job before it leaves, and a person's requests waiting
        /// for a Seerr account are woken (and the outbox signalled) as soon as Seerr links one to them. A title known only
        /// by its TVDB or IMDb id is found on TMDB through the shared cache.
        /// </summary>
        public SeerrBackend(IHttpClientFactory http, SeerrRequestReadModel model, TitleAliases aliases, RequestLedger ledger, RequestOutboxSignal signal, TmdbResponseCache tmdb)
            : this(http, model, aliases, () => JellyfinEnhanced.Instance?.Configuration, () => DateTimeOffset.UtcNow, ledger.BindSeerrSend, user => Wake(ledger, signal, user),
                (key, ct) => RequestHubProjection.TmdbIdOfAsync(tmdb, key, ct))
        {
        }

        // Wakes a person's requests waiting for a Seerr account. Never fails the read that noticed the link: a wake that
        // doesn't happen (the database is being restored) leaves them to their next hourly check.
        private static void Wake(RequestLedger ledger, RequestOutboxSignal signal, Guid user)
        {
            try
            {
                if (ledger.WakeUnlinked(user, DateTimeOffset.UtcNow) > 0) signal.Pulse();
            }
            catch (Exception ex) when (ex is InvalidOperationException or Microsoft.Data.Sqlite.SqliteException or IOException)
            {
                // Checked again at the next interval.
            }
        }

        /// <summary>
        /// Creates the backend over explicit configuration and time (tests). <paramref name="bind"/> records a job's
        /// account and seasons before its POST (see <see cref="RequestLedger.BindSeerrSend"/>); null: not recorded.
        /// <paramref name="linked"/> hears of a person Seerr now links an account to after it didn't (or for the first
        /// time since a start). <paramref name="findTmdb"/> names the TMDB id of a title no arr or Seerr request links one
        /// to (null: such a title is held).
        /// </summary>
        internal SeerrBackend(IHttpClientFactory http, SeerrRequestReadModel model, TitleAliases? aliases, Func<PluginConfiguration?> config, Func<DateTimeOffset> now, Func<string, int, int[], bool>? bind = null, Action<Guid>? linked = null,
            Func<TitleKey, CancellationToken, Task<int?>>? findTmdb = null)
        {
            _http = http;
            _model = model;
            _aliases = aliases;
            _config = config;
            _now = now;
            _bind = bind;
            _linked = linked;
            _findTmdb = findTmdb;
        }

        private sealed record SettingsRead(string Source, SeerrRequestSettings Settings, DateTimeOffset At);

        private sealed record Prepared(string Source, int? SeerrUser, long Permissions, SeerrRequestSettings? Settings,
            QuotaProjection? Movie, int MovieDays, QuotaProjection? Tv, int TvDays, DateTimeOffset At);

        private enum Delivery
        {
            Answered,
            NotSent,
            MaybeSent,
        }

        private sealed record Raw(Delivery Delivery, int Status, bool Json, string Body);

        // ---------------- identity, permissions, quota ----------------

        /// <inheritdoc />
        public async Task PrepareAsync(Guid user, MutationInput input, CancellationToken ct)
        {
            var config = _config();
            var source = config == null ? null : _model.SourceOf(config);
            if (config == null || source == null)
            {
                _prepared.TryRemove(user, out _);
                return;
            }
            var settings = await SettingsAsync(config, source, fresh: false, ct).ConfigureAwait(false);
            int? id = null;
            long permissions = 0;
            QuotaProjection? movie = null, tv = null;
            int movieDays = 7, tvDays = 7;
            if (!JellyseerrUserImportHelper.GetBlockedUserIds(config.JellyseerrImportBlockedUsers).Contains(user.ToString("N")))
            {
                var (found, known) = await UserIdAsync(config, source, user, ct).ConfigureAwait(false);
                // Seerr didn't answer: keep what was known for policy decisions (an unknown identity never grants
                // anything). Sending never relies on it: the account is confirmed again right before every POST.
                if (!known) return;
                id = found;
            }
            if (id is int seerrId)
            {
                var account = await GetAsync(config, "/api/v1/user/" + seerrId.ToString(CultureInfo.InvariantCulture), ct).ConfigureAwait(false);
                if (account is { } a && string.Equals(Str(a, "jellyfinUserId"), user.ToString("N"), StringComparison.OrdinalIgnoreCase)
                    && a.TryGetProperty("permissions", out var bits) && bits.ValueKind == JsonValueKind.Number && bits.TryGetInt64(out var value))
                {
                    permissions = value;
                    if (await GetAsync(config, $"/api/v1/user/{seerrId.ToString(CultureInfo.InvariantCulture)}/quota", ct).ConfigureAwait(false) is { } quota)
                    {
                        (movie, movieDays) = Quota(quota, "movie", user, true, source);
                        (tv, tvDays) = Quota(quota, "tv", user, false, source);
                    }
                }
                else if (account == null)
                {
                    // Seerr didn't answer: keep what was known (confirmed again before any POST, as above).
                    return;
                }
                else
                {
                    // The account now belongs to someone else: forget the mapping.
                    _ids.TryRemove(source + "|" + user.ToString("N"), out _);
                    id = null;
                }
            }
            var before = _prepared.TryGetValue(user, out var held) && held.Source == source ? held : null;
            _prepared[user] = new Prepared(source, id, permissions, settings, movie, movieDays, tv, tvDays, _now());
            // Seerr links an account to the person now (it didn't, or nothing was known since a start): requests that
            // were waiting for one are checked at once.
            if (id != null && before?.SeerrUser == null) _linked?.Invoke(user);
        }

        /// <inheritdoc />
        public RequestBackendBinding Binding(Guid user, MutationInput input)
        {
            var config = _config();
            var source = config == null ? null : _model.SourceOf(config);
            if (source == null || !_prepared.TryGetValue(user, out var p) || p.Source != source || _now() - p.At > PreparedFor) return new RequestBackendBinding(Source: source);
            var movie = TitleKey.Parse(input.Key)?.IsMovie ?? true;
            bool Has(JellyseerrPermission bit) => (p.Permissions & (long)bit) == (long)bit;
            var admin = Has(JellyseerrPermission.ADMIN);
            var canRequest = p.SeerrUser != null && (admin || Has(JellyseerrPermission.REQUEST) || Has(movie ? JellyseerrPermission.REQUEST_MOVIE : JellyseerrPermission.REQUEST_TV));
            // Seerr's own 4K permission decides (a Jellyfin administrator gets no bypass).
            var can4k = p.SeerrUser != null && (admin || Has(JellyseerrPermission.REQUEST_4K) || Has(movie ? JellyseerrPermission.REQUEST_4K_MOVIE : JellyseerrPermission.REQUEST_4K_TV));
            var canManage = p.SeerrUser != null && (admin || Has(JellyseerrPermission.MANAGE_REQUESTS));
            var fourKEnabled = p.Settings != null && (movie ? p.Settings.Movie4k : p.Settings.Series4k);
            // Partial requests off, or not a real on/off: only a request for the whole series is sent (see SendAsync).
            var wholeSeries = p.Settings is { Partial: not true };
            // Prepared facts say who the person is: no account means Seerr answered that none is linked to them.
            return new RequestBackendBinding(source, p.SeerrUser, p.SeerrUser == null ? 0 : p.Permissions, fourKEnabled, can4k, canManage,
                movie ? p.Movie : p.Tv, movie ? p.MovieDays : p.TvDays, canRequest, wholeSeries, SeerrUnlinked: p.SeerrUser == null);
        }

        // Seerr's quota for one media type; "used" must be a real number or nothing is known.
        private (QuotaProjection? Projection, int Days) Quota(JsonElement quota, string type, Guid user, bool movie, string source)
        {
            if (!quota.TryGetProperty(type, out var q) || q.ValueKind != JsonValueKind.Object || Int(q, "used") is not int used || used < 0) return (null, 7);
            var limit = Int(q, "limit") is int l && l > 0 ? l : (int?)null;
            var days = Math.Clamp(Int(q, "days") is int d && d > 0 ? d : 7, 1, 365);
            DateTimeOffset? next = null;
            var (heldSource, all, _) = _model.Current;
            if (limit != null && heldSource == source)
                next = NextSlot(all.Where(r => r.RequestedBy == user && r.IsMovie == movie), used, limit.Value, days, movie);
            return (new QuotaProjection(used, limit, limit is int max ? Math.Max(0, max - used) : null, next, 0), days);
        }

        /// <summary>
        /// When the next of a person's Seerr requests leaves the quota window (Seerr's quota answer says how many count, not
        /// when they were made): from their requests in the read model that Seerr counts (not declined, made within
        /// <paramref name="days"/>), each counting its seasons (a series) or one (a movie). When the read model doesn't
        /// hold exactly <paramref name="used"/> (a request made since its last read, one Seerr no longer counts, or more
        /// requests than it keeps), it is the latest the slot can free up: what it doesn't hold counts as made now, and
        /// what it holds beyond Seerr's count is taken to be the oldest (not counted).
        /// </summary>
        internal DateTimeOffset? NextSlot(IEnumerable<SeerrRequestRecord> mine, int used, int limit, int days, bool movie)
        {
            var since = _now().AddDays(-days);
            var counted = mine.Where(r => r.Status != Declined && r.CreatedAt is DateTime c && c > since.UtcDateTime)
                .Select(r => new QuotaCharge(movie ? 1 : Math.Max(1, r.Seasons.Count), new DateTimeOffset(DateTime.SpecifyKind(r.CreatedAt!.Value, DateTimeKind.Utc))))
                .OrderBy(c => c.At).ToList();
            var excess = counted.Sum(c => c.Cost) - used;
            var charges = new List<QuotaCharge>();
            foreach (var charge in counted)
            {
                var drop = Math.Clamp(excess, 0, charge.Cost);
                excess -= drop;
                if (charge.Cost > drop) charges.Add(charge with { Cost = charge.Cost - drop });
            }
            if (excess < 0) charges.Add(new QuotaCharge(-excess, _now()));
            return QuotaProjector.Project(charges, limit, TimeSpan.FromDays(days), _now()).NextSlotAt;
        }

        // The Seerr account linked to a Jellyfin user (by Seerr's jellyfinUserId), cached per Seerr identity and user.
        // Known is false when Seerr's user list couldn't be read completely (nothing is concluded then).
        private async Task<(int? Id, bool Known)> UserIdAsync(PluginConfiguration config, string source, Guid user, CancellationToken ct)
        {
            var cacheKey = source + "|" + user.ToString("N");
            if (_ids.TryGetValue(cacheKey, out var cached) && _now() - cached.At < (cached.Id == null ? MissingIdFor : IdsFor)) return (cached.Id, true);
            const int take = 100;
            for (var page = 0; page < MaxUserPages; page++)
            {
                var list = await GetAsync(config, $"/api/v1/user?take={take}&skip={(page * take).ToString(CultureInfo.InvariantCulture)}&sort=created", ct).ConfigureAwait(false);
                if (list is not { } json || !json.TryGetProperty("results", out var rows) || rows.ValueKind != JsonValueKind.Array) return (null, false);
                var count = 0;
                foreach (var row in rows.EnumerateArray())
                {
                    count++;
                    if (string.Equals(Str(row, "jellyfinUserId"), user.ToString("N"), StringComparison.OrdinalIgnoreCase) && Int(row, "id") is int id && id > 0)
                    {
                        _ids[cacheKey] = (id, _now());
                        return (id, true);
                    }
                }
                var total = json.TryGetProperty("pageInfo", out var info) && info.ValueKind == JsonValueKind.Object ? Int(info, "results") : null;
                if (count < take || total is int t && (page + 1) * take >= t)
                {
                    _ids[cacheKey] = (null, _now());
                    return (null, true);
                }
            }
            return (null, false);
        }

        /// <summary>How long Seerr's last-read 4K server settings count as known (see <see cref="FourKServer"/>).</summary>
        private static readonly TimeSpan FourKKnownFor = TimeSpan.FromHours(1);

        /// <inheritdoc />
        /// <remarks>Seerr's 4K Radarr/Sonarr setting as last read from the Seerr configured now (within the last hour).</remarks>
        public bool? FourKServer(bool movie)
        {
            var config = _config();
            var source = config == null ? null : _model.SourceOf(config);
            var held = Volatile.Read(ref _settings);
            if (source == null || held == null || held.Source != source || _now() - held.At > FourKKnownFor) return null;
            return movie ? held.Settings.Movie4k : held.Settings.Series4k;
        }

        private async Task<SeerrRequestSettings?> SettingsAsync(PluginConfiguration config, string source, bool fresh, CancellationToken ct)
        {
            var held = Volatile.Read(ref _settings);
            if (!fresh && held != null && held.Source == source && _now() - held.At < SettingsFor) return held.Settings;
            if (await GetAsync(config, "/api/v1/settings/public", ct).ConfigureAwait(false) is not { } json) return null;
            static bool? Tri(JsonElement e, string name) => e.TryGetProperty(name, out var v) ? v.ValueKind switch { JsonValueKind.True => true, JsonValueKind.False => false, _ => null } : null;
            var settings = new SeerrRequestSettings(Tri(json, "partialRequestsEnabled"), Tri(json, "enableSpecialEpisodes") == true, Tri(json, "movie4kEnabled") == true, Tri(json, "series4kEnabled") == true);
            Volatile.Write(ref _settings, new SettingsRead(source, settings, _now()));
            return settings;
        }

        // ---------------- send ----------------

        /// <inheritdoc />
        public Task<RequestBackendResult> SendAsync(RequestJob job, Func<string?> finalGuard, CancellationToken ct) => SendAsync(job, finalGuard, null, ct);

        // An automatic request's hold (kill switch, mode change, Shadow override) waits and is checked again by itself.
        private static RequestBackendResult Refused(RequestJob job, string refusal)
            => AutomationHolds.IsWait(refusal) ? BackendResults.Held(job.WantId, false, refusal, "Automatic requests to Seerr are held (" + refusal + ").", AutomationHolds.WaitFor(refusal)) : RequestBackendResult.Hold(refusal);

        /// <inheritdoc />
        /// <remarks>
        /// Automatic work counts Jellyfin Enhanced's own POSTs to Seerr only (its separately labelled budget). Once Seerr
        /// accepts a request, what Seerr and its Sonarr/Radarr do with it is Seerr's: no per-arr budget, disk check or kill
        /// switch of Jellyfin Enhanced reaches it.
        /// </remarks>
        public async Task<RequestBackendResult> SendAsync(RequestJob job, Func<string?> finalGuard, ISendAdmission? admission, CancellationToken ct)
        {
            if (finalGuard() is { } refusal) return Refused(job, refusal);
            var config = _config();
            var source = config == null ? null : _model.SourceOf(config);
            if (config == null || source == null) return BackendResults.Retry("backend_unavailable", "Seerr isn't configured.");
            if (source != job.Authorization.SeerrSource) return BackendResults.Hold("identity_changed", "Seerr's address or API key changed after this request was approved.");
            // The account it goes out as: the one it was approved with or, for a request approved while Seerr didn't say
            // who the person is, the account Seerr links to them now (the outbox guard has made every check again with
            // that account's permissions).
            if ((job.Authorization.SeerrUser ?? PreparedAccount(job.Authorization.Requester, source)) is not int seerrUser)
                return PreparedUnlinked(job.Authorization.Requester, source)
                    ? BackendResults.Later("seerr_user_unlinked", "The person has no Seerr account linked; the request goes out once they have one.", RequestOutbox.UnlinkedRecheck)
                    : BackendResults.Retry("backend_unavailable", "The person's Seerr account isn't known.");
            var input = job.Input;
            if (RequestLedger.HasRouting(input))
                return BackendResults.Hold("invalid_defaults", "Instance, profile and folder choices can't be sent to Seerr; Seerr picks its own server.");
            var key = TitleKey.Parse(input.Key);
            if (key == null) return BackendResults.Failed("invalid_input", "The request's title key can't be read.");
            if (await TmdbOfAsync(key, ct).ConfigureAwait(false) is not int tmdb) return BackendResults.Hold("title_not_found", "Seerr needs the title's TMDB id, which isn't known yet.");
            var is4k = input.Variant == "4k";
            string body;
            int[] seasons = Array.Empty<int>();
            if (key.IsMovie)
            {
                body = JsonSerializer.Serialize(new { mediaType = "movie", mediaId = tmdb, is4k });
            }
            else
            {
                if (input.Scope == "episodes")
                    return BackendResults.Hold("seerr_whole_season_only", "Seerr takes whole seasons only; single episodes can't be sent to it.");
                // Re-read at send time: the policy that applies is the one Seerr has now.
                var settings = await SettingsAsync(config, source, fresh: true, ct).ConfigureAwait(false);
                if (settings == null) return BackendResults.Retry("backend_unavailable", "Seerr's request settings couldn't be read.");
                seasons = input.Seasons.Where(s => s > 0 || settings.Specials).Distinct().OrderBy(s => s).ToArray();
                if (seasons.Length == 0) return BackendResults.Hold("seerr_specials_off", "Seerr doesn't take requests for specials.");
                if (settings.Partial != true)
                {
                    // Partial requests off or unknown: only the whole series may go (never more than was confirmed).
                    var details = await GetAsync(config, "/api/v1/tv/" + tmdb.ToString(CultureInfo.InvariantCulture), ct).ConfigureAwait(false);
                    if (details is not { } tv) return BackendResults.Retry("backend_unavailable", "Seerr couldn't describe the series' seasons.");
                    var all = SeasonNumbers(tv).Where(s => s > 0 || settings.Specials).ToArray();
                    if (all.Length == 0 || all.Any(s => !seasons.Contains(s)))
                        return BackendResults.Hold("seerr_whole_series_only", settings.Partial == false
                            ? "Seerr takes whole-series requests only; this asks for some seasons."
                            : "Seerr's partial-request setting couldn't be read as on or off, so only whole-series requests are sent.");
                    seasons = all.OrderBy(s => s).ToArray();
                }
                body = JsonSerializer.Serialize(new { mediaType = "tv", mediaId = tmdb, is4k, seasons });
            }
            // One address only: a POST is never repeated against another Seerr address, and the account check and the
            // reads that confirm the request are made at that same address.
            var url = Urls(config).FirstOrDefault();
            if (url == null) return BackendResults.Retry("backend_unavailable", "Seerr has no address.");
            // X-Api-User only ever names the account Seerr links to the person right now: confirmed by a fresh read
            // immediately before the POST (prepared identity facts can be minutes old, and a failed refresh keeps them).
            var (account, gone) = await FetchAsync(config, "/api/v1/user/" + seerrUser.ToString(CultureInfo.InvariantCulture), ct, url).ConfigureAwait(false);
            if (account is not { } linked)
                return gone
                    ? Unlinked(job.Authorization.Requester, source, "The Seerr account this request was approved for no longer exists.")
                    : BackendResults.Retry("backend_unavailable", "Seerr couldn't confirm the person's account; nothing was sent.");
            if (!string.Equals(Str(linked, "jellyfinUserId"), job.Authorization.Requester.ToString("N"), StringComparison.OrdinalIgnoreCase))
                return Unlinked(job.Authorization.Requester, source, "That Seerr account is no longer linked to the person who asked.");
            if (finalGuard() is { } late) return Refused(job, late);
            if (admission?.Admit(SendWriteKind.Post, "post") is { } limited) return BackendResults.Held(job.WantId, false, limited.Reason, "Seerr: " + limited.Message, limited.Wait);
            // What goes out is recorded first (the account and the exact seasons), so a read-back looks for exactly that,
            // whatever Seerr's settings or account links say by then.
            if (_bind != null && !_bind(job.Id, seerrUser, seasons))
                return BackendResults.Retry("backend_unavailable", "The request couldn't be recorded before sending; nothing was sent.");
            var raw = await RawAsync(HttpMethod.Post, url + "/api/v1/request", config.GetJellyseerrApiKey(), seerrUser, body, WriteTimeout, ct).ConfigureAwait(false);
            // Any answer means the POST reached Seerr (a refusal included); a lost answer may have.
            admission?.Settled(SendWriteKind.Post, "post", raw.Delivery switch { Delivery.NotSent => SendWriteResult.NotSent, Delivery.MaybeSent => SendWriteResult.MaybeSent, _ => SendWriteResult.Sent });
            switch (raw.Delivery)
            {
                case Delivery.NotSent:
                    return BackendResults.Retry("backend_unavailable", "Seerr couldn't be reached; nothing was sent.");
                case Delivery.MaybeSent:
                    return BackendResults.Maybe(job.WantId, "Seerr's answer was lost; a fresh read decides whether the request exists.");
            }
            switch (raw.Status)
            {
                case 200 or 201 when raw.Json:
                {
                    // Seerr leaves out seasons that are already requested or on their way and creates the rest: the request
                    // counts once a fresh read shows every sent season covered and this person's new request among them.
                    var verify = await VerifyAsync(config, url, job, key, tmdb, seasons, seerrUser, CreatedId(raw.Body), ct).ConfigureAwait(false);
                    return verify.Matched == true
                        ? BackendResults.Done(job.WantId, "accepted", verify.Reason, "Asked in Seerr.", 201)
                        : BackendResults.Maybe(job.WantId, "Seerr accepted the request, but a fresh read doesn't show it yet.");
                }
                case 202 when raw.Json && Message(raw.Body) is { } message && message.Contains("no seasons", StringComparison.OrdinalIgnoreCase):
                {
                    var verify = await VerifyAsync(config, url, job, key, tmdb, seasons, null, null, ct).ConfigureAwait(false);
                    return verify.Matched == true
                        ? BackendResults.Done(job.WantId, "nothing_to_request", verify.Reason, "Every season asked for is already requested or available in Seerr.")
                        : BackendResults.Failed("seerr_conflict", "Seerr said there were no seasons to request, but a fresh read doesn't show them requested.");
                }
                case 409 when raw.Json:
                {
                    var verify = await VerifyAsync(config, url, job, key, tmdb, seasons, null, null, ct).ConfigureAwait(false);
                    return verify.Matched == true
                        ? BackendResults.Done(job.WantId, "already_requested", verify.Reason, "Already requested in Seerr; following that request.")
                        : BackendResults.Failed("seerr_conflict", "Seerr reported a conflict, but a fresh read doesn't show the title requested.");
                }
                case 202 when raw.Json:
                    return BackendResults.Maybe(job.WantId, "Seerr accepted the request without creating one; a fresh read decides.");
                case 409:
                    return BackendResults.Failed("seerr_conflict", "Seerr reported a conflict without a readable answer.");
                case 403 when raw.Json:
                {
                    var text = Message(raw.Body) ?? string.Empty;
                    if (text.Contains("quota", StringComparison.OrdinalIgnoreCase)) return BackendResults.Hold("quota_exceeded", "Seerr refused: over this person's Seerr quota.");
                    if (text.Contains("4k", StringComparison.OrdinalIgnoreCase)) return BackendResults.Hold("requests_4k_required", "Seerr refused: no 4K request permission.");
                    if (text.Contains("blocklist", StringComparison.OrdinalIgnoreCase) || text.Contains("blacklist", StringComparison.OrdinalIgnoreCase)) return BackendResults.Hold("blocked", "Seerr refused: the title is on its blocklist.");
                    return BackendResults.Hold("seerr_refused", "Seerr refused the request for this person.");
                }
                case 401 or 403:
                    return BackendResults.Hold("service_down", "Seerr rejected Jellyfin Enhanced's API key.");
                case 400 or 422:
                    return BackendResults.Failed("seerr_rejected", "Seerr rejected the request as invalid.");
                case >= 300 and < 400:
                    return BackendResults.Retry("backend_unavailable", "Seerr answered with a redirect (a proxy in front of it?); nothing was sent.");
                case >= 200 and < 300:
                    // A success status without JSON is a proxy's page, not Seerr.
                    return BackendResults.Retry("backend_unavailable", "Something other than Seerr answered; nothing was sent.");
                default:
                    // 5xx and anything unexpected: Seerr may have created the request before failing.
                    return BackendResults.Maybe(job.WantId, $"Seerr answered HTTP {raw.Status.ToString(CultureInfo.InvariantCulture)}; a fresh read decides whether the request exists.");
            }
        }

        /// <inheritdoc />
        public async Task<RequestBackendResult> ReadBackAsync(RequestJob job, CancellationToken ct)
        {
            var config = _config();
            var source = config == null ? null : _model.SourceOf(config);
            if (config == null || source == null || source != job.Authorization.SeerrSource)
                return BackendResults.Maybe(job.WantId, "The Seerr this request was sent to is no longer configured; check it there.", "identity_changed");
            var key = TitleKey.Parse(job.Input.Key);
            if (key == null || await TmdbOfAsync(key, ct).ConfigureAwait(false) is not int tmdb) return BackendResults.Maybe(job.WantId, "The title can't be read back from Seerr.", "title_not_found");
            // Read where requests are sent.
            var url = Urls(config).FirstOrDefault();
            if (url == null) return BackendResults.Maybe(job.WantId, "Seerr has no address; the request stays unconfirmed.", "service_down");
            var seasons = Array.Empty<int>();
            if (!key.IsMovie && job.Authorization.SeerrSeasons is { Length: > 0 } sent)
            {
                // Exactly the seasons the send recorded before it went out.
                seasons = sent;
            }
            else if (!key.IsMovie)
            {
                // Not recorded (sent without a ledger): the seasons that went out by Seerr's settings now: specials only
                // while Seerr takes them (a specials-only request can only have gone out while it did). With partial
                // requests off the whole series went, which covers these.
                var settings = await SettingsAsync(config, source, fresh: true, ct).ConfigureAwait(false);
                if (settings == null) return BackendResults.Maybe(job.WantId, "Seerr couldn't be read; the request stays unconfirmed.", "service_down");
                seasons = job.Input.Seasons.Where(s => s > 0 || settings.Specials).Distinct().ToArray();
                if (seasons.Length == 0) seasons = job.Input.Seasons.Distinct().ToArray();
            }
            // Whose request to look for: the account it was approved with, else the one Seerr links to the person now
            // (the account a request approved without one was sent as).
            var own = job.Authorization.SeerrUser;
            if (own == null)
            {
                var (found, known) = await UserIdAsync(config, source, job.Authorization.Requester, ct).ConfigureAwait(false);
                if (!known) return BackendResults.Maybe(job.WantId, "Seerr couldn't be read; the request stays unconfirmed.", "service_down");
                if (found == null) return BackendResults.Maybe(job.WantId, "The person no longer has a Seerr account; check the request there.", "identity_changed");
                own = found;
            }
            var verify = await VerifyAsync(config, url, job, key, tmdb, seasons, own, null, ct).ConfigureAwait(false);
            return verify.Matched switch
            {
                true => BackendResults.Done(job.WantId, "accepted", verify.Reason, "Confirmed in Seerr."),
                // The person's request is there but doesn't cover every season sent (another person's request that
                // covered the rest was declined or removed meanwhile): sent, not finished. The next attempt sends again
                // as the same account; Seerr takes only the seasons nobody has requested.
                false when verify.Theirs => BackendResults.Resume(job.WantId, "Seerr has this person's request, but not every season asked for is requested; the rest is sent again."),
                false => BackendResults.NotThere("Seerr has no matching request from this person."),
                _ => BackendResults.Maybe(job.WantId, "Seerr couldn't be read; the request stays unconfirmed.", "service_down"),
            };
        }

        /// <summary>
        /// Fresh scoped read (never the cached read model) of a title's requests in Seerr at <paramref name="url"/> only:
        /// media type, TMDB id, edition and seasons. Every asked season must be covered by a request of anyone's (not
        /// declined) or be processing or available, and a movie must be requested or on its way. With
        /// <paramref name="own"/> the person's own part must be there too: their request with id
        /// <paramref name="created"/> (from Seerr's answer), else a request of theirs for the movie or for at least one
        /// of the asked seasons. <c>Theirs</c>: that own part is there (even when the seasons aren't all covered).
        /// </summary>
        private async Task<(bool? Matched, string Reason, bool Theirs)> VerifyAsync(PluginConfiguration config, string url, RequestJob job, TitleKey key, int tmdb, int[] seasons, int? own, int? created, CancellationToken ct)
        {
            var details = await GetAsync(config, $"/api/v1/{(key.IsMovie ? "movie" : "tv")}/{tmdb.ToString(CultureInfo.InvariantCulture)}", ct, url).ConfigureAwait(false);
            if (details is not { } json) return (null, "service_down", false);
            var is4k = job.Input.Variant == "4k";
            if (!json.TryGetProperty("mediaInfo", out var media) || media.ValueKind != JsonValueKind.Object) return (false, "not_sent", false);
            var requests = media.TryGetProperty("requests", out var list) && list.ValueKind == JsonValueKind.Array ? list.EnumerateArray().ToList() : new List<JsonElement>();
            var edition = requests.Where(r => (r.TryGetProperty("is4k", out var k) && k.ValueKind == JsonValueKind.True) == is4k && Int(r, "status") is int status && status != Declined).ToList();
            var mine = own == null ? edition : edition.Where(r => r.TryGetProperty("requestedBy", out var by) && by.ValueKind == JsonValueKind.Object && Int(by, "id") == own
                && (created == null || Int(r, "id") == created)).ToList();
            var reason = mine.Any(r => Int(r, "status") == 1) && !mine.Any(r => Int(r, "status") is 2 or 5) ? "awaiting_approval" : "looking";
            if (key.IsMovie)
            {
                if (own != null) return (mine.Count > 0, reason, mine.Count > 0);
                if (edition.Count > 0) return (true, reason, false);
                return (Int(media, is4k ? "status4k" : "status") is >= 3 and <= 5, "looking", false);
            }
            var covered = edition.SelectMany(SeasonsOf).ToHashSet();
            if (media.TryGetProperty("seasons", out var mediaSeasons) && mediaSeasons.ValueKind == JsonValueKind.Array)
            {
                foreach (var season in mediaSeasons.EnumerateArray())
                {
                    if (Int(season, is4k ? "status4k" : "status") is >= 3 and <= 5 && Int(season, "seasonNumber") is int n) covered.Add(n);
                }
            }
            var all = seasons.Length > 0 && seasons.All(covered.Contains);
            if (own == null) return (all, reason, false);
            var theirs = created != null ? mine.Count > 0 : mine.Any(r => SeasonsOf(r).Any(seasons.Contains));
            return (all && theirs, reason, theirs);
        }

        /// <summary>
        /// A series' seasons as Seerr describes them right now (one fresh read of its details, never the cached request
        /// list), for following new seasons of "Keep getting new episodes" requests: the regular seasons that have
        /// started (episodes listed and a first air date on or before today), those that are already covered in
        /// <paramref name="variant"/>'s edition (requested by anyone and not declined, or processing or available), and
        /// those Seerr declined for it (never asked for again behind its back).
        /// Null when Seerr isn't configured, the series' TMDB id isn't known, or Seerr couldn't be read.
        /// </summary>
        /// <param name="titleKey">The series' title key.</param>
        /// <param name="variant">standard or 4k.</param>
        /// <param name="ct">Cancellation.</param>
        internal async Task<SeerrSeasonFacts?> SeasonFactsAsync(string titleKey, string variant, CancellationToken ct)
        {
            var config = _config();
            if (config == null || _model.SourceOf(config) == null) return null;
            if (TitleKey.Parse(titleKey) is not { IsMovie: false } key || await TmdbOfAsync(key, ct).ConfigureAwait(false) is not int tmdb) return null;
            if (await GetAsync(config, "/api/v1/tv/" + tmdb.ToString(CultureInfo.InvariantCulture), ct).ConfigureAwait(false) is not { } tv) return null;
            var today = _now().UtcDateTime.Date;
            var started = new SortedSet<int>();
            if (tv.TryGetProperty("seasons", out var seasons) && seasons.ValueKind == JsonValueKind.Array)
            {
                foreach (var season in seasons.EnumerateArray())
                {
                    if (Int(season, "seasonNumber") is not int n || n <= 0 || Int(season, "episodeCount") is not > 0) continue;
                    if (Str(season, "airDate") is { } aired && DateTime.TryParse(aired, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var first) && first.Date <= today)
                        started.Add(n);
                }
            }
            var is4k = variant == "4k";
            var covered = new HashSet<int>();
            var declined = new HashSet<int>();
            if (tv.TryGetProperty("mediaInfo", out var media) && media.ValueKind == JsonValueKind.Object)
            {
                if (media.TryGetProperty("requests", out var list) && list.ValueKind == JsonValueKind.Array)
                {
                    foreach (var request in list.EnumerateArray().Where(r => (r.TryGetProperty("is4k", out var k) && k.ValueKind == JsonValueKind.True) == is4k && Int(r, "status") is int))
                        (Int(request, "status") == Declined ? declined : covered).UnionWith(SeasonsOf(request));
                }
                if (media.TryGetProperty("seasons", out var mediaSeasons) && mediaSeasons.ValueKind == JsonValueKind.Array)
                {
                    foreach (var season in mediaSeasons.EnumerateArray())
                    {
                        if (Int(season, is4k ? "status4k" : "status") is >= 3 and <= 5 && Int(season, "seasonNumber") is int n) covered.Add(n);
                    }
                }
            }
            declined.ExceptWith(covered);
            return new SeerrSeasonFacts(started.ToArray(), covered, declined);
        }

        private static IEnumerable<int> SeasonsOf(JsonElement request)
            => request.TryGetProperty("seasons", out var s) && s.ValueKind == JsonValueKind.Array ? s.EnumerateArray().Select(x => Int(x, "seasonNumber") ?? -1) : Enumerable.Empty<int>();

        // The id of the request Seerr's 2xx answer describes, when it names one.
        private static int? CreatedId(string body)
        {
            try
            {
                using var doc = JsonDocument.Parse(body);
                return doc.RootElement.ValueKind == JsonValueKind.Object && Int(doc.RootElement, "id") is int id && id > 0 ? id : null;
            }
            catch (JsonException)
            {
                return null;
            }
        }

        // The account prepared for a person (fresh, same Seerr), or null.
        private int? PreparedAccount(Guid user, string source)
            => _prepared.TryGetValue(user, out var p) && p.Source == source && _now() - p.At <= PreparedFor ? p.SeerrUser : null;

        // Fresh prepared facts (same Seerr) say Seerr links no account to the person.
        private bool PreparedUnlinked(Guid user, string source)
            => _prepared.TryGetValue(user, out var p) && p.Source == source && _now() - p.At <= PreparedFor && p.SeerrUser == null;

        // The account isn't (or is no longer) the person's: forget the mapping and hold the request for a person.
        private RequestBackendResult Unlinked(Guid user, string source, string message)
        {
            _ids.TryRemove(source + "|" + user.ToString("N"), out _);
            _prepared.TryRemove(user, out _);
            return BackendResults.Hold("identity_changed", message);
        }

        // ---------------- transport ----------------

        private int? TmdbOf(TitleKey key)
            => key.Provider == "tmdb" ? key.NumericId : _aliases?.Of(key).FirstOrDefault(a => a.Provider == "tmdb")?.NumericId;

        // The TMDB id Seerr knows a title by: from the arr libraries and Seerr's requests, else (a title nothing here holds
        // yet, known by its TVDB or IMDb id: a series asked for from its page before any arr has it) TMDB's find.
        private async Task<int?> TmdbOfAsync(TitleKey key, CancellationToken ct)
            => TmdbOf(key) ?? (_findTmdb == null ? null : await _findTmdb(key.Title, ct).ConfigureAwait(false));

        private static List<string> Urls(PluginConfiguration config)
            => (config.JellyseerrUrls ?? string.Empty).Split(new[] { '\r', '\n', ',' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(u => u.Trim().TrimEnd('/')).Where(u => u.Length > 0).ToList();

        private async Task<JsonElement?> GetAsync(PluginConfiguration config, string path, CancellationToken ct, string? only = null)
            => (await FetchAsync(config, path, ct, only).ConfigureAwait(false)).Json;

        // A read from the first address that answers with JSON (reads, unlike the POST, may try the next address), or
        // from <only> alone (the address a request goes to: its account check and confirming reads never fail over).
        // Missing: Seerr answered that the thing doesn't exist (404), as opposed to no usable answer at all.
        private async Task<(JsonElement? Json, bool Missing)> FetchAsync(PluginConfiguration config, string path, CancellationToken ct, string? only = null)
        {
            foreach (var url in only != null ? new List<string> { only } : Urls(config))
            {
                var raw = await RawAsync(HttpMethod.Get, url + path, config.GetJellyseerrApiKey(), null, null, ReadTimeout, ct).ConfigureAwait(false);
                if (raw.Delivery != Delivery.Answered || !raw.Json) continue;
                if (raw.Status == 404) return (null, true);
                if (raw.Status is < 200 or >= 300) continue;
                try
                {
                    using var doc = JsonDocument.Parse(raw.Body);
                    return (doc.RootElement.Clone(), false);
                }
                catch (JsonException)
                {
                    continue;
                }
            }
            return (null, false);
        }

        private async Task<Raw> RawAsync(HttpMethod method, string url, string key, int? apiUser, string? body, TimeSpan timeout, CancellationToken ct)
        {
            if (string.IsNullOrEmpty(key)) return new Raw(Delivery.NotSent, 0, false, string.Empty);
            using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
            budget.CancelAfter(timeout);
            var client = SeerrHttpHelper.CreateClient(_http);
            using var request = SeerrHttpHelper.BuildRequest(method, url, key, apiUser?.ToString(CultureInfo.InvariantCulture), body);
            HttpResponseMessage? response = null;
            try
            {
                response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, budget.Token).ConfigureAwait(false);
                var status = (int)response.StatusCode;
                var json = SeerrHttpHelper.IsJsonContentType(response);
                try
                {
                    return new Raw(Delivery.Answered, status, json, await ReadCappedAsync(response, budget.Token).ConfigureAwait(false));
                }
                catch (Exception ex) when (ex is IOException or HttpRequestException or OperationCanceledException && !ct.IsCancellationRequested)
                {
                    // The status arrived, the body didn't. For a read that is an unreadable answer; a write may have been
                    // acted on (a 201 means the request was created), so only a fresh read can tell.
                    return new Raw(method == HttpMethod.Get ? Delivery.Answered : Delivery.MaybeSent, status, false, string.Empty);
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (OperationCanceledException)
            {
                return new Raw(method == HttpMethod.Get ? Delivery.NotSent : Delivery.MaybeSent, 0, false, string.Empty);
            }
            catch (HttpRequestException ex) when (ex.HttpRequestError is HttpRequestError.NameResolutionError or HttpRequestError.ConnectionError or HttpRequestError.SecureConnectionError or HttpRequestError.ProxyTunnelError)
            {
                return new Raw(Delivery.NotSent, 0, false, string.Empty);
            }
            catch (HttpRequestException)
            {
                return new Raw(method == HttpMethod.Get ? Delivery.NotSent : Delivery.MaybeSent, 0, false, string.Empty);
            }
            finally
            {
                response?.Dispose();
            }
        }

        private static async Task<string> ReadCappedAsync(HttpResponseMessage response, CancellationToken ct)
        {
            await using var stream = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            var buffer = new byte[16 * 1024];
            using var memory = new MemoryStream();
            int read;
            while ((read = await stream.ReadAsync(buffer, ct).ConfigureAwait(false)) > 0)
            {
                if (memory.Length + read > MaxBody) throw new IOException("Seerr's answer is too large.");
                memory.Write(buffer, 0, read);
            }
            return Encoding.UTF8.GetString(memory.GetBuffer(), 0, (int)memory.Length);
        }

        private static string? Message(string body)
        {
            try
            {
                using var doc = JsonDocument.Parse(body);
                return doc.RootElement.ValueKind == JsonValueKind.Object ? Str(doc.RootElement, "message") : null;
            }
            catch (JsonException)
            {
                return null;
            }
        }

        private static int[] SeasonNumbers(JsonElement tv)
            => tv.TryGetProperty("seasons", out var seasons) && seasons.ValueKind == JsonValueKind.Array
                ? seasons.EnumerateArray().Select(s => Int(s, "seasonNumber")).Where(n => n is >= 0).Select(n => n!.Value).Distinct().ToArray()
                : Array.Empty<int>();

        private static int? Int(JsonElement e, string name) => DirectArrBackend.Int(e, name);

        private static string? Str(JsonElement e, string name) => DirectArrBackend.Str(e, name);
    }
}
