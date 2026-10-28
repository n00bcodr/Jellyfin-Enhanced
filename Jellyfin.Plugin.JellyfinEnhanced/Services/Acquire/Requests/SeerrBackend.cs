using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;
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
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>Seerr's request settings, read fresh. <c>Partial</c> is three-state: a value that isn't a real boolean is unknown.</summary>
    /// <param name="Partial">Partial (per-season) series requests: true, false or unknown (null).</param>
    /// <param name="Specials">Specials (season 0) can be requested; a missing flag counts as off.</param>
    /// <param name="Movie4k">A 4K Radarr is set up in Seerr.</param>
    /// <param name="Series4k">A 4K Sonarr is set up in Seerr.</param>
    public sealed record SeerrRequestSettings(bool? Partial, bool Specials, bool Movie4k, bool Series4k);

    /// <summary>
    /// What a season page's title-wide Seerr ask is checked against when it is pressed (D53, edition round 19). Seerr picks the
    /// server a request goes to (D80, edition round 20: Seerr mode is out of scope for edition awareness): Jellyfin Enhanced
    /// never names one, proves one, nor offers a copy-qualified ask in Seerr mode.
    /// </summary>
    public interface ISeerrRequestSettings
    {
        /// <summary>
        /// Whether Seerr takes whole-series requests only now (its partial-request setting off, or not a real on/off), read
        /// again now; null when it can't be read.
        /// </summary>
        /// <param name="ct">Cancellation.</param>
        /// <returns>True, false, or null (unknown).</returns>
        Task<bool?> WholeSeriesOnlyAsync(CancellationToken ct);
    }

    /// <summary>A series' seasons as Seerr describes them (see <see cref="SeerrBackend.SeasonFactsAsync"/>).</summary>
    /// <param name="Started">Regular seasons that have started, ascending.</param>
    /// <param name="Covered">Seasons already requested by anyone (not declined), processing or available in the edition.</param>
    /// <param name="Declined">Seasons a request for the edition named and Seerr declined, and nothing covers.</param>
    public sealed record SeerrSeasonFacts(IReadOnlyList<int> Started, IReadOnlySet<int> Covered, IReadOnlySet<int> Declined);

    /// <summary>A quality profile of a Seerr Radarr/Sonarr server (see <see cref="SeerrServerOptions"/>).</summary>
    /// <param name="Id">The arr's profile id.</param>
    /// <param name="Name">Its name.</param>
    public sealed record SeerrProfileOption(int Id, string Name);

    /// <summary>
    /// What an administrator may choose on a Seerr request for one of Seerr's Radarr/Sonarr servers: its id, name,
    /// edition and defaults, its quality profiles and root folders, and the options stamp a choice is made against
    /// (bound to the Seerr source, the media kind and these facts; no address or key of Seerr or the arr).
    /// </summary>
    /// <param name="Id">Seerr's server id (starts at 0).</param>
    /// <param name="Name">The server's name in Seerr.</param>
    /// <param name="Is4k">The server takes 4K requests.</param>
    /// <param name="IsDefault">Seerr's default server for its edition.</param>
    /// <param name="DefaultProfileId">The profile Seerr uses when none is chosen.</param>
    /// <param name="DefaultRootFolder">The root folder Seerr uses when none is chosen.</param>
    /// <param name="Profiles">Quality profiles.</param>
    /// <param name="RootFolders">Root folder paths.</param>
    /// <param name="Options">The options stamp.</param>
    public sealed record SeerrServerOptions(int Id, string Name, bool Is4k, bool IsDefault, int? DefaultProfileId, string? DefaultRootFolder,
        IReadOnlyList<SeerrProfileOption> Profiles, IReadOnlyList<string> RootFolders, string Options);

    /// <summary>
    /// Seerr request mode: sends each approved request to Seerr as the person who asked
    /// (<c>X-Api-User</c> with JE's key), so Seerr's own permissions, quotas, approvals and override rules
    /// apply. <c>is4k</c> is always sent. The sent seasons are always a subset of what the person
    /// confirmed: with partial requests off or unknown, only a request for the whole series is sent.
    /// The account named in <c>X-Api-User</c> is confirmed by a fresh read right before every POST.
    /// A POST whose answer is lost is "maybe sent" and is never sent to another Seerr address; a fresh,
    /// scoped read of the title settles it. A 409 or a 202 "No seasons available" counts as success only
    /// with a JSON body and a fresh read that shows the scope already requested or available; for a request with
    /// administrator Seerr options, only by requests at the chosen server, profile and root folder (else it is held).
    /// A created request (and a read-back) with options counts only when every season asked for is covered there.
    /// </summary>
    public sealed class SeerrBackend : IRequestBackend, ISeerrRequestSettings
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
        private readonly SeerrFacts _model;
        private readonly TitleAliases? _aliases;
        private readonly Func<PluginConfiguration?> _config;
        private readonly Func<DateTimeOffset> _now;
        private readonly Func<string, int, int[], bool>? _bind;
        private readonly Action<Guid>? _linked;
        private readonly Func<TitleKey, CancellationToken, Task<int?>>? _findTmdb;
        // The person's prepared Seerr facts and their Seerr account id, on the ticket protocol (Helpers.WrittenStateCache):
        // a read that began before the mapping was found to belong to someone else (a preparation or a send that finds the
        // account reassigned) is never kept, so it can't put the old account back. Every entry lives from the START of
        // its earliest input's read, never longer than any input: a prepared entry ends with the account mapping it used
        // (Until) and its Seerr settings with their own read (SettingsUntil); the same deadlines are checked on the
        // stored times as well.
        private readonly SeerrFacts.PreparedCache<Guid, Prepared> _prepared = new(PreparedFor, 10000);
        private readonly SeerrFacts.PreparedCache<string, (int? Id, long At, SeerrAccountAuthority.Ticket Authority)> _ids = new(IdsFor, 10000, StringComparer.Ordinal);
        private readonly Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.Cache<ServerList> _serverLists = new();
        private readonly Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.Cache<ServerDetails> _serverDetails = new();
        private SettingsRead? _settings;

        /// <summary>The binding verdict for Seerr options that fit Seerr's servers now.</summary>
        internal const string OptionsValid = "valid";
        /// <summary>The binding verdict while Seerr's servers aren't known lately (never a guess).</summary>
        internal const string OptionsUnknown = "unknown";
        /// <summary>How long a read of Seerr's servers (and of one server's profiles and folders) counts.</summary>
        internal static readonly TimeSpan ServersFor = TimeSpan.FromSeconds(60);
        private const int MaxServers = 16;
        private const int MaxProfiles = 500;
        private const int MaxRoots = 200;
        private const int MaxCachedServerReads = 256;

        /// <summary>
        /// Creates the backend (DI); each send is bound on its ledger job before it leaves, and a person's requests waiting
        /// for a Seerr account are woken (and the outbox signalled) as soon as Seerr links one to them. A title known only
        /// by its TVDB or IMDb id is found on TMDB through the shared cache.
        /// </summary>
        public SeerrBackend(IHttpClientFactory http, SeerrFacts model, TitleAliases aliases, RequestLedger ledger, RequestOutboxSignal signal, TmdbResponseCache tmdb)
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
        internal SeerrBackend(IHttpClientFactory http, SeerrFacts model, TitleAliases? aliases, Func<PluginConfiguration?> config, Func<DateTimeOffset> now, Func<string, int, int[], bool>? bind = null, Action<Guid>? linked = null,
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

        // At: when the read of Seerr's settings began (monotonic ticks, Helpers.MonotonicClock).
        private sealed record SettingsRead(string Source, SeerrRequestSettings Settings, long At);

        // Until: the earliest deadline of the identity facts (the account mapping and the reads made here); SettingsUntil:
        // Seerr's settings end with their own read (they are the settings this preparation was given, possibly read before it).
        // Both on the monotonic clock (ticks): the one clock every derived deadline here is counted on (the wall clock is
        // kept for calendar dates only: quota windows). Authority: the person's Seerr account authority the facts were
        // worked out under; they are used only while it is current.
        private sealed record Prepared(string Source, int? SeerrUser, long Permissions, SeerrRequestSettings? Settings,
            QuotaProjection? Movie, int MovieDays, QuotaProjection? Tv, int TvDays, long Until, long SettingsUntil, SeerrAccountAuthority.Ticket Authority, bool LinkPending = false);

        private enum Delivery
        {
            Answered,
            NotSent,
            MaybeSent,
        }

        private sealed record Raw(Delivery Delivery, int Status, bool Json, string Body);

        // Connection: a digest of where and how Seerr reaches the server (its address, port, SSL, base URL and API key),
        // private: only ever part of the options stamp, so a server repointed under the same name is a changed choice.
        private sealed record ServerEntry(int Id, string Name, bool Is4k, bool IsDefault, int? ActiveProfileId, string? ActiveDirectory, string Connection);

        private sealed record ServerList(IReadOnlyList<ServerEntry> Servers, long At);

        private sealed record ServerDetails(IReadOnlyList<SeerrProfileOption> Profiles, IReadOnlyList<string> Roots, long At);

        // ---------------- identity, permissions, quota ----------------

        /// <inheritdoc />
        public Task PrepareAsync(Guid user, MutationInput input, CancellationToken ct) => PrepareCoreAsync(user, input, ct, true);

        /// <summary>Refreshes administrator status through GETs only, without waking request processing or importing users.</summary>
        public Task PrepareAdminReadAsync(Guid user, CancellationToken ct) => PrepareCoreAsync(user, new MutationInput { Key = "movie:tmdb:1" }, ct, false);

        private async Task PrepareCoreAsync(Guid user, MutationInput input, CancellationToken ct, bool notifyLinked)
        {
            if (!EffectiveRequestsBackend.AllowsSeerr(_config())) { _prepared.Invalidate(user); return; }
            await Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.RunSeerrAsync(SeerrUse.Identity, ct, async token => { await PrepareAdmittedAsync(user, input, token, notifyLinked).ConfigureAwait(false); return true; }).ConfigureAwait(false);
        }

        private async Task PrepareAdmittedAsync(Guid user, MutationInput input, CancellationToken ct, bool notifyLinked)
        {
            if (!EffectiveRequestsBackend.AllowsSeerr(_config())) { _prepared.Invalidate(user); return; }
            // Taken before anything is read: an unlink while this runs ends what it read; its facts live from here (on the
            // monotonic clock). The person's Seerr account authority too: a newer read of their account link (here or
            // anywhere: the proxy, another preparation) ends this one, and nothing it found is kept.
            var ticket = _prepared.Begin();
            var start = Helpers.MonotonicClock.Now();
            var ticketAt = start;
            var config = _config();
            var source = config == null ? null : _model.SourceOf(config);
            var authority = SeerrAccountAuthority.Capture(SeerrAccountAuthority.SourceOf(config), SeerrAccountAuthority.PersonOf(user));
            if (config == null || source == null)
            {
                _prepared.Invalidate(user);
                return;
            }
            // Seerr options: Seerr's servers and the chosen one's profiles and folders (read briefly cached), for the binding.
            if (input.HasSeerrOptions && input.SeerrServerId is int server && TitleKey.Parse(input.Key) is { } titleKey)
            {
                var kind = ServiceKind(titleKey.IsMovie);
                if (await ServerListAsync(config, source, kind, fresh: false, ct).ConfigureAwait(false) is { } list && list.Servers.Any(s => s.Id == server))
                    await ServerDetailsAsync(config, source, kind, server, fresh: false, ct).ConfigureAwait(false);
            }
            var (settings, settingsAt) = await SettingsReadAsync(config, source, fresh: false, ct).ConfigureAwait(false);
            // The identity facts end with the earliest input: this preparation's own reads, or the account mapping it used.
            var until = start + PreparedFor.Ticks;
            int? id = null;
            long permissions = 0;
            QuotaProjection? movie = null, tv = null;
            int movieDays = 7, tvDays = 7;
            if (!JellyseerrUserImportHelper.GetBlockedUserIds(config.JellyseerrImportBlockedUsers).Contains(user.ToString("N")))
            {
                var (found, known, mappedAt, mappedUnder) = await UserIdReadAsync(config, source, user, authority, ct).ConfigureAwait(false);
                // Seerr didn't answer (or a newer read of the person's account came in meanwhile): keep what was known for
                // policy decisions (an unknown identity never grants anything). Sending never relies on it: the account is
                // confirmed again right before every POST.
                if (!known) return;
                authority = mappedUnder;
                id = found;
                // No account: that answer is the mapping's own (it ends with it). An account is confirmed below by a read
                // of it made now.
                if (found == null && mappedAt + MissingIdFor.Ticks < until) until = mappedAt + MissingIdFor.Ticks;
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
                    // The account now belongs to someone else: a fresh observation that the person has lost it. Recorded
                    // with this preparation's authority (refused when a newer read came in meanwhile: nothing is kept then),
                    // it ends every preparation and lookup running now; the mapping is forgotten. What this one found (no
                    // account) is kept under the ticket and authority taken after that end, as short as a missing mapping.
                    if (!SeerrAccountAuthority.Admit(ref authority, null)) return;
                    Reassigned(user, source);
                    ticket = _prepared.Begin();
                    ticketAt = Helpers.MonotonicClock.Now();
                    id = null;
                    if (start + MissingIdFor.Ticks < until) until = start + MissingIdFor.Ticks;
                }
            }
            // Published only while the person's account authority is still the one these facts were worked out under.
            if (!SeerrAccountAuthority.IsCurrent(authority, _config())) return;
            var before = _prepared.TryGet(user, out var held) && held.Source == source && SeerrAccountAuthority.IsCurrent(held.Authority) ? held : null;
            var linkPending = id != null && (before?.SeerrUser != id || before?.LinkPending == true);
            var settingsUntil = settingsAt + SettingsFor.Ticks < until ? settingsAt + SettingsFor.Ticks : until;
            _prepared.Set(user, ticket, new Prepared(source, id, permissions, settings, movie, movieDays, tv, tvDays, until, settingsUntil, authority, !notifyLinked && linkPending), Life(ticketAt, until));
            // Seerr links an account to the person now (it didn't, or nothing was known since a start): requests that
            // were waiting for one are checked at once.
            if (notifyLinked && linkPending) _linked?.Invoke(user);
        }

        // The prepared facts of a person, when they may be used: the same Seerr, inside their own deadline, and under the
        // person's current Seerr account authority.
        private Prepared? Usable(Guid user, string source)
            => _prepared.TryGet(user, out var p) && p.Source == source && Helpers.MonotonicClock.Now() < p.Until
               && SeerrAccountAuthority.IsCurrent(p.Authority, _config()) ? p : null;

        /// <inheritdoc />
        public RequestBackendBinding Binding(Guid user, MutationInput input)
            => Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.ReadSeerrCached(() => BindingCore(user, input), new RequestBackendBinding());

        private RequestBackendBinding BindingCore(Guid user, MutationInput input)
        {
            if (!EffectiveRequestsBackend.AllowsSeerr(_config())) return new RequestBackendBinding();
            var config = _config();
            var source = config == null ? null : _model.SourceOf(config);
            var (options, optionsStamp) = source != null && input.HasSeerrOptions ? HeldOptions(source, input) : (null, null);
            if (source == null || Usable(user, source) is not { } p) return new RequestBackendBinding(Source: source, SeerrOptions: options, SeerrOptionsStamp: optionsStamp);
            // Seerr's settings end with their own read: past it they aren't known (as when Seerr didn't answer).
            var known = Helpers.MonotonicClock.Now() < p.SettingsUntil ? p.Settings : null;
            var movie = TitleKey.Parse(input.Key)?.IsMovie ?? true;
            bool Has(JellyseerrPermission bit) => (p.Permissions & (long)bit) == (long)bit;
            var admin = Has(JellyseerrPermission.ADMIN);
            var canRequest = p.SeerrUser != null && (admin || Has(JellyseerrPermission.REQUEST) || Has(movie ? JellyseerrPermission.REQUEST_MOVIE : JellyseerrPermission.REQUEST_TV));
            // Seerr's own 4K permission decides (a Jellyfin administrator gets no bypass).
            var can4k = p.SeerrUser != null && (admin || Has(JellyseerrPermission.REQUEST_4K) || Has(movie ? JellyseerrPermission.REQUEST_4K_MOVIE : JellyseerrPermission.REQUEST_4K_TV));
            var canManage = p.SeerrUser != null && (admin || Has(JellyseerrPermission.MANAGE_REQUESTS));
            var fourKEnabled = known != null && (movie ? known.Movie4k : known.Series4k);
            // Partial requests off, or not a real on/off: only a request for the whole series is sent (see SendAsync).
            var wholeSeries = known is { Partial: not true };
            // Prepared facts say who the person is: no account means Seerr answered that none is linked to them.
            return new RequestBackendBinding(source, p.SeerrUser, p.SeerrUser == null ? 0 : p.Permissions, fourKEnabled, can4k, canManage,
                movie ? p.Movie : p.Tv, movie ? p.MovieDays : p.TvDays, canRequest, wholeSeries, SeerrUnlinked: p.SeerrUser == null, SeerrOptions: options, SeerrOptionsStamp: optionsStamp);
        }

        // ---------------- administrator Seerr request options ----------------

        private static string ServiceKind(bool movie) => movie ? "radarr" : "sonarr";

        /// <summary>
        /// Seerr's Radarr (movies) or Sonarr (series) servers and, for each, its quality profiles, root folders and options
        /// stamp, for an administrator's choice: read from the Seerr configured now (briefly cached), never including an
        /// address or key. Null when Seerr isn't configured or couldn't be read completely (nothing is guessed then).
        /// </summary>
        /// <param name="movie">Movies (Radarr) or series (Sonarr).</param>
        /// <param name="ct">Cancellation.</param>
        public async Task<IReadOnlyList<SeerrServerOptions>?> RequestOptionsAsync(bool movie, CancellationToken ct)
        {
            if (!EffectiveRequestsBackend.AllowsSeerr(_config())) return null;
            return await Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.RunSeerrAsync(SeerrUse.RequestRead, ct, token => RequestOptionsAdmittedAsync(movie, token)).ConfigureAwait(false);
        }

        private async Task<IReadOnlyList<SeerrServerOptions>?> RequestOptionsAdmittedAsync(bool movie, CancellationToken ct)
        {
            if (!EffectiveRequestsBackend.AllowsSeerr(_config())) return null;
            var config = _config();
            var source = config == null ? null : _model.SourceOf(config);
            if (config == null || source == null) return null;
            var kind = ServiceKind(movie);
            if (await ServerListAsync(config, source, kind, fresh: false, ct).ConfigureAwait(false) is not { } list) return null;
            var servers = new List<SeerrServerOptions>(list.Servers.Count);
            foreach (var server in list.Servers)
            {
                if (await ServerDetailsAsync(config, source, kind, server.Id, fresh: false, ct).ConfigureAwait(false) is not { } details) return null;
                servers.Add(new SeerrServerOptions(server.Id, server.Name, server.Is4k, server.IsDefault, server.ActiveProfileId, server.ActiveDirectory,
                    details.Profiles, details.Roots, OptionsStamp(source, kind, server, details)));
            }
            return servers;
        }

        /// <summary>
        /// The options stamp of one Seerr server: a hash of the Seerr source, the media kind, the server's id, name and
        /// edition, the digest of its connection (where Seerr sends to), its profiles (ids and names) and its root folders,
        /// sorted. Deterministic; no address or key can be read from it.
        /// </summary>
        private static string OptionsStamp(string source, string kind, ServerEntry server, ServerDetails details)
            => MutationInput.Hash(JsonSerializer.Serialize(new object[]
            {
                source, kind, server.Id, server.Name, server.Is4k, server.Connection,
                details.Profiles.OrderBy(p => p.Id).Select(p => new object[] { p.Id, p.Name }).ToArray(),
                details.Roots.OrderBy(r => r, StringComparer.Ordinal).ToArray(),
            }));

        /// <summary>
        /// Whether an input's Seerr options fit Seerr's servers as last read (memory only, within <see cref="ServersFor"/>):
        /// <see cref="OptionsValid"/>; <c>seerr_options_changed</c> when the server is gone or its stamp differs (the facts
        /// the choice was made against changed); <c>seerr_options_invalid</c> when the stamp matches but the edition,
        /// profile or folder doesn't belong to that server; <see cref="OptionsUnknown"/> when they aren't known lately.
        /// With the server's current stamp when known.
        /// </summary>
        private (string Verdict, string? Stamp) HeldOptions(string source, MutationInput input)
        {
            if (TitleKey.Parse(input.Key) is not { } key || input.SeerrServerId is not int server) return (OptionsUnknown, null);
            var kind = ServiceKind(key.IsMovie);
            var now = Helpers.MonotonicClock.Now();
            var list = _serverLists.TryGetValue(source + "|" + kind, out var heldList) && now - heldList.At < ServersFor.Ticks ? heldList : null;
            var details = _serverDetails.TryGetValue(source + "|" + kind + "|" + server.ToString(CultureInfo.InvariantCulture), out var heldDetails) && now - heldDetails.At < ServersFor.Ticks ? heldDetails : null;
            return CheckOptions(source, kind, input, list, details);
        }

        private static (string Verdict, string? Stamp) CheckOptions(string source, string kind, MutationInput input, ServerList? list, ServerDetails? details)
        {
            if (list == null) return (OptionsUnknown, null);
            var server = list.Servers.FirstOrDefault(s => s.Id == input.SeerrServerId);
            if (server == null) return ("seerr_options_changed", null);
            if (details == null) return (OptionsUnknown, null);
            var stamp = OptionsStamp(source, kind, server, details);
            if (!string.Equals(stamp, input.SeerrOptions, StringComparison.OrdinalIgnoreCase)) return ("seerr_options_changed", stamp);
            if (server.Is4k != (input.Variant == "4k") || !details.Profiles.Any(p => p.Id == input.SeerrProfileId)
                || input.SeerrRootFolder == null || !details.Roots.Any(r => BridgePaths.SamePath(r, input.SeerrRootFolder)))
                return ("seerr_options_invalid", stamp);
            return (OptionsValid, stamp);
        }

        // Seerr's servers of one kind (GET /api/v1/service/radarr|sonarr) with where Seerr reaches each (its settings,
        // GET /api/v1/settings/radarr|sonarr, read with Jellyfin Enhanced's administrator key; only a digest is kept),
        // cached per Seerr source for ServersFor; fresh reads always go to Seerr (and replace what is held). Null when
        // Seerr didn't answer with both lists, or a server's connection isn't in its settings (never guessed).
        private async Task<ServerList?> ServerListAsync(PluginConfiguration config, string source, string kind, bool fresh, CancellationToken ct, string? only = null)
        {
            var cacheKey = source + "|" + kind;
            if (!fresh && _serverLists.TryGetValue(cacheKey, out var held) && Helpers.MonotonicClock.Now() - held.At < ServersFor.Ticks) return held;
            // Counted from the start of the read.
            var at = Helpers.MonotonicClock.Now();
            if (await GetAsync(config, "/api/v1/service/" + kind, ct, only).ConfigureAwait(false) is not { ValueKind: JsonValueKind.Array } json) return null;
            if (await GetAsync(config, "/api/v1/settings/" + kind, ct, only).ConfigureAwait(false) is not { ValueKind: JsonValueKind.Array } settings) return null;
            var connections = new Dictionary<int, string>();
            foreach (var row in settings.EnumerateArray())
            {
                if (row.ValueKind != JsonValueKind.Object || Int(row, "id") is not int id) continue;
                connections[id] = MutationInput.Hash(JsonSerializer.Serialize(new object?[]
                {
                    Str(row, "hostname")?.Trim().ToLowerInvariant(), Int(row, "port"), row.TryGetProperty("useSsl", out var ssl) && ssl.ValueKind == JsonValueKind.True,
                    Str(row, "baseUrl")?.Trim().TrimEnd('/'), MutationInput.Hash(Str(row, "apiKey") ?? string.Empty),
                }));
            }
            var servers = new List<ServerEntry>();
            foreach (var row in json.EnumerateArray())
            {
                if (servers.Count >= MaxServers) break;
                if (row.ValueKind != JsonValueKind.Object || Int(row, "id") is not int id || id < 0 || servers.Any(s => s.Id == id)) continue;
                if (!connections.TryGetValue(id, out var connection)) return null;
                servers.Add(new ServerEntry(id, Bounded(Str(row, "name")) ?? string.Empty, row.TryGetProperty("is4k", out var k) && k.ValueKind == JsonValueKind.True,
                    row.TryGetProperty("isDefault", out var d) && d.ValueKind == JsonValueKind.True, Int(row, "activeProfileId") is int profile && profile > 0 ? profile : null,
                    Str(row, "activeDirectory") is { Length: > 0 and <= 1024 } directory ? directory : null, connection));
            }
            var list = new ServerList(servers, at);
            if (_serverLists.Count >= MaxCachedServerReads) _serverLists.Clear();
            _serverLists[cacheKey] = list;
            return list;
        }

        /// <inheritdoc />
        public bool RepresentsSeerrServer(string? source, MutationInput input, string url, string apiKey)
            => Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.ReadSeerrCached(() => RepresentsSeerrServerCore(source, input, url, apiKey), false);

        private bool RepresentsSeerrServerCore(string? source, MutationInput input, string url, string apiKey)
        {
            if (!EffectiveRequestsBackend.AllowsSeerr(_config())) return false;
            if (source == null || TitleKey.Parse(input.Key) is not { } key || input.SeerrServerId is not int id
                || !Uri.TryCreate(url, UriKind.Absolute, out var uri) || string.IsNullOrEmpty(apiKey)) return false;
            var kind = key.IsMovie ? "radarr" : "sonarr";
            if (!_serverLists.TryGetValue(source + "|" + kind, out var list) || Helpers.MonotonicClock.Now() - list.At >= ServersFor.Ticks) return false;
            var server = list.Servers.SingleOrDefault(s => s.Id == id);
            var connection = MutationInput.Hash(JsonSerializer.Serialize(new object?[]
            {
                uri.Host.Trim().ToLowerInvariant(), uri.Port, uri.Scheme == Uri.UriSchemeHttps,
                uri.AbsolutePath.TrimEnd('/'), MutationInput.Hash(apiKey),
            }));
            return server != null && string.Equals(server.Connection, connection, StringComparison.Ordinal);
        }

        // One server's quality profiles and root folders (GET /api/v1/service/{kind}/{id}), cached like the list.
        private async Task<ServerDetails?> ServerDetailsAsync(PluginConfiguration config, string source, string kind, int server, bool fresh, CancellationToken ct, string? only = null)
        {
            var cacheKey = source + "|" + kind + "|" + server.ToString(CultureInfo.InvariantCulture);
            if (!fresh && _serverDetails.TryGetValue(cacheKey, out var held) && Helpers.MonotonicClock.Now() - held.At < ServersFor.Ticks) return held;
            // Counted from the start of the read.
            var at = Helpers.MonotonicClock.Now();
            if (await GetAsync(config, "/api/v1/service/" + kind + "/" + server.ToString(CultureInfo.InvariantCulture), ct, only).ConfigureAwait(false) is not { ValueKind: JsonValueKind.Object } json) return null;
            var profiles = new List<SeerrProfileOption>();
            if (json.TryGetProperty("profiles", out var p) && p.ValueKind == JsonValueKind.Array)
            {
                foreach (var row in p.EnumerateArray())
                {
                    if (profiles.Count >= MaxProfiles) break;
                    if (row.ValueKind == JsonValueKind.Object && Int(row, "id") is int id && id > 0 && profiles.All(x => x.Id != id))
                        profiles.Add(new SeerrProfileOption(id, Bounded(Str(row, "name")) ?? string.Empty));
                }
            }
            var roots = new List<string>();
            if (json.TryGetProperty("rootFolders", out var r) && r.ValueKind == JsonValueKind.Array)
            {
                foreach (var row in r.EnumerateArray())
                {
                    if (roots.Count >= MaxRoots) break;
                    if (row.ValueKind == JsonValueKind.Object && Str(row, "path") is { Length: > 0 and <= 1024 } path && !roots.Contains(path, StringComparer.Ordinal))
                        roots.Add(path);
                }
            }
            var details = new ServerDetails(profiles, roots, at);
            if (_serverDetails.Count >= MaxCachedServerReads) _serverDetails.Clear();
            _serverDetails[cacheKey] = details;
            return details;
        }

        private static string? Bounded(string? text) => text == null ? null : text.Length <= 200 ? text : text[..200];

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
            var authority = SeerrAccountAuthority.Capture(SeerrAccountAuthority.SourceOf(config), SeerrAccountAuthority.PersonOf(user));
            var (id, known, _, _) = await UserIdReadAsync(config, source, user, authority, ct).ConfigureAwait(false);
            return (id, known);
        }

        // The same, with when the mapping's read began (a held one's own read, on the monotonic clock; it ends IdsFor, or
        // MissingIdFor for no account, after that) and the person's Seerr account authority it holds under. A held mapping
        // is served only under the authority it was read under; a fresh one is recorded with the authority the caller took
        // before reading anything (<paramref name="authority"/>): refused (unknown) when a newer read of the person's
        // account came in meanwhile, else every lookup and preparation running from before it ends when it changes or
        // loses the link (a complete list without the person included).
        private async Task<(int? Id, bool Known, long At, SeerrAccountAuthority.Ticket Authority)> UserIdReadAsync(PluginConfiguration config, string source, Guid user, SeerrAccountAuthority.Ticket authority, CancellationToken ct)
        {
            var cacheKey = source + "|" + user.ToString("N");
            // Taken before Seerr's user list is read, and the read's instant with it.
            var ticket = _ids.Begin();
            var at = Helpers.MonotonicClock.Now();
            if (_ids.TryGet(cacheKey, out var cached) && cached.Authority == authority
                && Helpers.MonotonicClock.Now() - cached.At < (cached.Id == null ? MissingIdFor : IdsFor).Ticks) return (cached.Id, true, cached.At, authority);
            const int take = 100;
            for (var page = 0; page < MaxUserPages; page++)
            {
                var list = await GetAsync(config, $"/api/v1/user?take={take}&skip={(page * take).ToString(CultureInfo.InvariantCulture)}&sort=created", ct).ConfigureAwait(false);
                if (list is not { } json || !json.TryGetProperty("results", out var rows) || rows.ValueKind != JsonValueKind.Array) return (null, false, at, authority);
                var count = 0;
                foreach (var row in rows.EnumerateArray())
                {
                    count++;
                    if (string.Equals(Str(row, "jellyfinUserId"), user.ToString("N"), StringComparison.OrdinalIgnoreCase) && Int(row, "id") is int id && id > 0)
                    {
                        // What Seerr links now: recorded (a lookup of the Seerr proxy, or a preparation, naming another
                        // account ends); kept under the authority it holds under.
                        if (!SeerrAccountAuthority.Admit(ref authority, id)) return (null, false, at, authority);
                        _ids.Set(cacheKey, ticket, (id, at, authority), IdsFor);
                        return (id, true, at, authority);
                    }
                }
                var total = json.TryGetProperty("pageInfo", out var info) && info.ValueKind == JsonValueKind.Object ? Int(info, "results") : null;
                if (count < take || total is int t && (page + 1) * take >= t)
                {
                    // Seerr links no account to the person: that ends every lookup and preparation running from before.
                    if (!SeerrAccountAuthority.Admit(ref authority, null)) return (null, false, at, authority);
                    _ids.Set(cacheKey, ticket, (null, at, authority), MissingIdFor);
                    return (null, true, at, authority);
                }
            }
            return (null, false, at, authority);
        }

        /// <summary>How long Seerr's last-read 4K server settings count as known (see <see cref="FourKServer"/>).</summary>
        private static readonly TimeSpan FourKKnownFor = TimeSpan.FromHours(1);

        /// <inheritdoc />
        /// <remarks>Seerr's 4K Radarr/Sonarr setting as last read from the Seerr configured now (within the last hour).</remarks>
        public bool? FourKServer(bool movie)
            => Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.ReadSeerrCached(() => FourKServerCore(movie), (bool?)null);

        private bool? FourKServerCore(bool movie)
        {
            using var __factsOperation0 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            if (!EffectiveRequestsBackend.AllowsSeerr(_config())) return null;
            var config = _config();
            var source = config == null ? null : _model.SourceOf(config);
            var held = _settingsFacts;
            if (source == null || held == null || held.Source != source || Helpers.MonotonicClock.Now() - held.At > FourKKnownFor.Ticks) return null;
            return movie ? held.Settings.Movie4k : held.Settings.Series4k;
        }

        // ---------------- the whole-series setting ----------------

        /// <inheritdoc />
        public async Task<bool?> WholeSeriesOnlyAsync(CancellationToken ct)
        {
            if (!EffectiveRequestsBackend.AllowsSeerr(_config())) return null;
            return await Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.RunSeerrAsync(SeerrUse.RequestRead, ct, WholeSeriesOnlyAdmittedAsync).ConfigureAwait(false);
        }

        private async Task<bool?> WholeSeriesOnlyAdmittedAsync(CancellationToken ct)
        {
            if (!EffectiveRequestsBackend.AllowsSeerr(_config())) return null;
            var config = _config();
            var source = config == null ? null : _model.SourceOf(config);
            if (config == null || source == null) return null;
            var settings = await SettingsAsync(config, source, fresh: true, ct).ConfigureAwait(false);
            return settings == null ? null : settings.Partial != true;
        }

        private async Task<SeerrRequestSettings?> SettingsAsync(PluginConfiguration config, string source, bool fresh, CancellationToken ct)
            => (await SettingsReadAsync(config, source, fresh, ct).ConfigureAwait(false)).Settings;

        // Seerr's request settings and when their read began (a held read's own instant; they count SettingsFor from it).
        private async Task<(SeerrRequestSettings? Settings, long At)> SettingsReadAsync(PluginConfiguration config, string source, bool fresh, CancellationToken ct)
        {
            using var __factsOperation1 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            var held = _settingsFacts;
            if (!fresh && held != null && held.Source == source && Helpers.MonotonicClock.Now() - held.At < SettingsFor.Ticks) return (held.Settings, held.At);
            var at = Helpers.MonotonicClock.Now();
            if (await GetAsync(config, "/api/v1/settings/public", ct).ConfigureAwait(false) is not { } json) return (null, at);
            static bool? Tri(JsonElement e, string name) => e.TryGetProperty(name, out var v) ? v.ValueKind switch { JsonValueKind.True => true, JsonValueKind.False => false, _ => null } : null;
            var settings = new SeerrRequestSettings(Tri(json, "partialRequestsEnabled"), Tri(json, "enableSpecialEpisodes") == true, Tri(json, "movie4kEnabled") == true, Tri(json, "series4kEnabled") == true);
            _settingsFacts = new SettingsRead(source, settings, at);
            return (settings, at);
        }

        // How long an entry whose inputs end at until may be kept, from start (monotonic ticks; never negative).
        private static TimeSpan Life(long start, long until) => until > start ? TimeSpan.FromTicks(until - start) : TimeSpan.Zero;

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
            if (!EffectiveRequestsBackend.AllowsSeerr(_config())) return BackendResults.Hold("backend_disabled", "The request's original backend is disabled.");
            return await Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.RunSeerrAsync(SeerrUse.RequestWrite, ct, token => SendAdmittedAsync(job, finalGuard, admission, token)).ConfigureAwait(false);
        }

        private async Task<RequestBackendResult> SendAdmittedAsync(RequestJob job, Func<string?> finalGuard, ISendAdmission? admission, CancellationToken ct)
        {
            if (!EffectiveRequestsBackend.AllowsSeerr(_config())) return BackendResults.Hold("backend_disabled", "The request's original backend is disabled.");
            if (finalGuard() is { } refusal) return Refused(job, refusal);
            var config = _config();
            var source = config == null ? null : _model.SourceOf(config);
            // Taken before the account is read: the POST goes only while it is still the person's account as last read.
            var authority = SeerrAccountAuthority.Capture(SeerrAccountAuthority.SourceOf(config), SeerrAccountAuthority.PersonOf(job.Authorization.Requester));
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
            if (input.HasArrRouting)
                return BackendResults.Hold("invalid_defaults", "Instance, profile and folder choices can't be sent to Seerr; Seerr picks its own server.");
            // Seerr options are checked again right before the POST (below); while the switch is off nothing is read.
            if (input.HasSeerrOptions && !HouseholdFlags.SeerrOptions(config))
                return BackendResults.Hold("seerr_options_disabled", "Seerr server, profile and folder choices are turned off; nothing was sent.");
            var key = TitleKey.Parse(input.Key);
            if (key == null) return BackendResults.Failed("invalid_input", "The request's title key can't be read.");
            if (await TmdbOfAsync(key, ct).ConfigureAwait(false) is not int tmdb) return BackendResults.Hold("title_not_found", "Seerr needs the title's TMDB id, which isn't known yet.");
            var is4k = input.Variant == "4k";
            System.Text.Json.Nodes.JsonObject payload;
            int[] seasons = Array.Empty<int>();
            if (key.IsMovie)
            {
                payload = new System.Text.Json.Nodes.JsonObject { ["mediaType"] = "movie", ["mediaId"] = tmdb, ["is4k"] = is4k };
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
                payload = new System.Text.Json.Nodes.JsonObject
                {
                    ["mediaType"] = "tv",
                    ["mediaId"] = tmdb,
                    ["is4k"] = is4k,
                    ["seasons"] = new System.Text.Json.Nodes.JsonArray(seasons.Select(n => (System.Text.Json.Nodes.JsonNode?)n).ToArray()),
                };
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
            // The fresh read is an observation of the person's account: refused when a newer one came in while it ran.
            if (!SeerrAccountAuthority.Admit(ref authority, seerrUser))
                return BackendResults.Retry("backend_unavailable", "The person's Seerr account was read again meanwhile; nothing was sent.");
            if (input.HasSeerrOptions)
            {
                // The account it goes out as must still hold Seerr's advanced-request permission (Seerr applies the
                // choices for that account), and the choices must still fit Seerr's servers, read fresh at this address.
                // Anything else holds the request: never Seerr's defaults instead, never another backend.
                if (!(linked.TryGetProperty("permissions", out var bits) && bits.ValueKind == JsonValueKind.Number && bits.TryGetInt64(out var permissions) && RequestPolicy.SeerrAdvanced(permissions)))
                    return BackendResults.Hold("seerr_advanced_required", "The Seerr account no longer has Seerr's advanced request permission; nothing was sent.");
                var kind = ServiceKind(key.IsMovie);
                if (await ServerListAsync(config, source, kind, fresh: true, ct, url).ConfigureAwait(false) is not { } servers)
                    return BackendResults.Retry("backend_unavailable", "Seerr's servers couldn't be read; nothing was sent.");
                ServerDetails? details = null;
                if (input.SeerrServerId is int serverId && servers.Servers.Any(x => x.Id == serverId)
                    && (details = await ServerDetailsAsync(config, source, kind, serverId, fresh: true, ct, url).ConfigureAwait(false)) == null)
                    return BackendResults.Retry("backend_unavailable", "Seerr's server details couldn't be read; nothing was sent.");
                if (CheckOptions(source, kind, input, servers, details).Verdict != OptionsValid)
                    return BackendResults.Hold("seerr_options_changed", "Seerr's servers, profiles or root folders changed since this request was made; nothing was sent.");
                payload["serverId"] = input.SeerrServerId;
                payload["profileId"] = input.SeerrProfileId;
                payload["rootFolder"] = input.SeerrRootFolder;
            }
            var body = payload.ToJsonString();
            if (finalGuard() is { } late) return Refused(job, late);
            if (admission?.Admit(SendWriteKind.Post, "post") is { } limited) return BackendResults.Held(job.WantId, false, limited.Reason, "Seerr: " + limited.Message, limited.Wait);
            // What goes out is recorded first (the account and the exact seasons), so a read-back looks for exactly that,
            // whatever Seerr's settings or account links say by then.
            if (_bind != null && !_bind(job.Id, seerrUser, seasons))
            {
                // Nothing went out: the POST's budget slot, admitted just above, is given back.
                admission?.Settled(SendWriteKind.Post, "post", SendWriteResult.NotSent);
                return BackendResults.Retry("backend_unavailable", "The request couldn't be recorded before sending; nothing was sent.");
            }
            // Never as an account that stopped being the person's after it was confirmed (or at another Seerr): checked after
            // the waits for admission and recording, before the key and the last gate (both read the configuration's secrets).
            if (!SeerrAccountAuthority.IsCurrent(authority, _config()))
            {
                admission?.Settled(SendWriteKind.Post, "post", SendWriteResult.NotSent);
                return BackendResults.Retry("backend_unavailable", "The person's Seerr account changed before the request went out; nothing was sent.");
            }
            // The key is read before the last gate (reading it can log through a callback), so nothing but the POST follows it.
            var apiKey = config.GetJellyseerrApiKey();
            // Admitting and recording wait for the database (one writer at a time, none during a restore): the gate is
            // asked again after them, so nothing waits between its last answer and the POST. Refused here, nothing went out.
            if (finalGuard() is { } last)
            {
                admission?.Settled(SendWriteKind.Post, "post", SendWriteResult.NotSent);
                return Refused(job, last);
            }

            Raw raw;
            try
            {
                raw = await RawAsync(HttpMethod.Post, url + "/api/v1/request", apiKey, seerrUser, body, WriteTimeout, ct).ConfigureAwait(false);
            }
            catch (AutomationTransportRefusedException refused)
            {
                // Refused by the transport's own check, the last one before the POST is handed on: nothing went out, and
                // its reservation is released already. A budget waits for its next free slot, as when the admission refuses.
                return refused.Hold.Reason is AutomationHolds.BudgetExhausted or AutomationHolds.AccountingUnavailable
                    ? BackendResults.Held(job.WantId, false, refused.Hold.Reason, "Seerr: " + refused.Hold.Message, refused.Hold.Wait)
                    : Refused(job, refused.Hold.Reason);
            }
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
                        if (verify.Reason == OptionsMismatch) return OptionsNotApplied(job);
                        if (verify.Reason == PartlyElsewhere) return PartlyNotApplied(job);
                        return verify.Matched == true
                            ? BackendResults.Done(job.WantId, "accepted", verify.Reason, "Asked in Seerr.", 201)
                            : BackendResults.Maybe(job.WantId, "Seerr accepted the request, but a fresh read doesn't show it yet.");
                    }
                case 202 when raw.Json && Message(raw.Body) is { } message && message.Contains("no seasons", StringComparison.OrdinalIgnoreCase):
                    {
                        var verify = await VerifyAsync(config, url, job, key, tmdb, seasons, null, null, ct).ConfigureAwait(false);
                        if (verify.Reason == OptionsMismatch) return CoveredElsewhere();
                        return verify.Matched == true
                            ? BackendResults.Done(job.WantId, "nothing_to_request", verify.Reason, "Every season asked for is already requested or available in Seerr.")
                            : BackendResults.Failed("seerr_conflict", "Seerr said there were no seasons to request, but a fresh read doesn't show them requested.");
                    }
                case 409 when raw.Json:
                    {
                        var verify = await VerifyAsync(config, url, job, key, tmdb, seasons, null, null, ct).ConfigureAwait(false);
                        if (verify.Reason == OptionsMismatch) return CoveredElsewhere();
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
            if (!EffectiveRequestsBackend.AllowsSeerr(_config())) return BackendResults.Maybe(job.WantId, "The original backend is disabled; delivery remains unconfirmed.", "backend_disabled");
            return await Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.RunSeerrAsync(SeerrUse.RequestRead, ct, token => ReadBackAdmittedAsync(job, token)).ConfigureAwait(false);
        }

        private async Task<RequestBackendResult> ReadBackAdmittedAsync(RequestJob job, CancellationToken ct)
        {
            if (!EffectiveRequestsBackend.AllowsSeerr(_config())) return BackendResults.Maybe(job.WantId, "The original backend is disabled; delivery remains unconfirmed.", "backend_disabled");
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
            if (verify.Reason == OptionsMismatch) return OptionsNotApplied(job);
            if (verify.Reason == PartlyElsewhere) return PartlyNotApplied(job);
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
        /// <summary>
        /// <see cref="VerifyAsync"/>'s reason when the job carries Seerr options and the person's request is there, but
        /// not with the chosen server, profile or root folder.
        /// </summary>
        private const string OptionsMismatch = "seerr_options_mismatch";

        /// <summary>
        /// <see cref="VerifyAsync"/>'s reason when the job carries Seerr options and the person's request is there with them,
        /// but not every season asked for is covered at the chosen destination (some only elsewhere).
        /// </summary>
        private const string PartlyElsewhere = "seerr_options_partly_elsewhere";

        // Seerr made the person's request with the options chosen, but some seasons asked for are requested or on their way
        // elsewhere: held for a person after the write (certainty unknown: neither cancelled nor sent again).
        private static RequestBackendResult PartlyNotApplied(RequestJob job)
            => BackendResults.HoldAfterWrite(job.WantId, "seerr_options_changed", "Seerr has this person's request at the server, profile and root folder chosen, but some seasons asked for are requested or on their way elsewhere; check it in Seerr.");

        // The person's request is in Seerr with other options than chosen: held for a person (the written request stays;
        // its certainty stays unknown, so it is neither cancelled nor sent again).
        private static RequestBackendResult OptionsNotApplied(RequestJob job)
            => BackendResults.HoldAfterWrite(job.WantId, "seerr_options_changed", "Seerr has this person's request, but not with the server, profile or root folder chosen; check it in Seerr.");

        // Seerr created nothing (a 409 or a 202 "no seasons") because the title is already requested or on its way, but not
        // with the server, profile or root folder chosen: held for a person, never counted as this request's success.
        private static RequestBackendResult CoveredElsewhere()
            => BackendResults.Hold("seerr_options_changed", "Seerr already has this title requested or on its way, but not with the server, profile or root folder chosen; nothing new was sent.");

        // A Seerr request carries the chosen server, profile and root folder.
        private static bool SameOptions(JsonElement request, MutationInput input)
            => RequestDestination.SeerrHas(input, Int(request, "serverId"), Int(request, "profileId"), Str(request, "rootFolder"));

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
            // A request carrying Seerr options counts only with those options; the person's request with other options is
            // not a match (and is never resent over).
            if (own != null && job.Input.HasSeerrOptions)
            {
                // (For a series, only the person's requests naming a season asked for here.)
                var relevant = key.IsMovie ? mine : mine.Where(r => SeasonsOf(r).Any(seasons.Contains)).ToList();
                if (relevant.Count > 0 && !relevant.Any(r => SameOptions(r, job.Input))) return (false, OptionsMismatch, false);
                mine = mine.Where(r => SameOptions(r, job.Input)).ToList();
            }
            // Seerr created nothing (409, 202): with Seerr options, only requests at the chosen server, profile and root
            // folder count as covering it. Covered only by another request's options, or by the title already processing
            // or available (no request shows where), it is not a match: OptionsMismatch.
            var routed = own == null && job.Input.HasSeerrOptions;
            if (routed) mine = edition.Where(r => SameOptions(r, job.Input)).ToList();
            var reason = mine.Any(r => Int(r, "status") == 1) && !mine.Any(r => Int(r, "status") is 2 or 5) ? "awaiting_approval" : "looking";
            if (key.IsMovie)
            {
                if (own != null) return (mine.Count > 0, reason, mine.Count > 0);
                if (routed)
                    return mine.Count > 0 ? (true, reason, false)
                        : edition.Count > 0 || Int(media, is4k ? "status4k" : "status") is >= 3 and <= 5 ? (false, OptionsMismatch, false) : (false, "looking", false);
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
            if (routed)
            {
                var atChoice = mine.SelectMany(SeasonsOf).ToHashSet();
                return seasons.Length > 0 && seasons.All(atChoice.Contains) ? (true, reason, false) : all ? (false, OptionsMismatch, false) : (false, reason, false);
            }
            if (own == null) return (all, reason, false);
            var theirs = created != null ? mine.Count > 0 : mine.Any(r => SeasonsOf(r).Any(seasons.Contains));
            // With Seerr options every season asked for must be covered at the chosen destination (anyone's request with the
            // chosen options). One covered only by a request elsewhere, or only processing or available (no request shows
            // where), isn't: the person's part is written, so it is held after the write.
            if (job.Input.HasSeerrOptions && all && theirs)
            {
                var atChoice = edition.Where(r => SameOptions(r, job.Input)).SelectMany(SeasonsOf).ToHashSet();
                if (!seasons.All(atChoice.Contains)) return (false, PartlyElsewhere, true);
            }
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
            if (!EffectiveRequestsBackend.AllowsSeerr(_config())) return null;
            return await Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.RunSeerrAsync(SeerrUse.Metadata, ct, token => SeasonFactsAdmittedAsync(titleKey, variant, token)).ConfigureAwait(false);
        }

        private async Task<SeerrSeasonFacts?> SeasonFactsAdmittedAsync(string titleKey, string variant, CancellationToken ct)
        {
            if (!EffectiveRequestsBackend.AllowsSeerr(_config())) return null;
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
            => Usable(user, source)?.SeerrUser;

        // Fresh prepared facts (same Seerr) say Seerr links no account to the person.
        private bool PreparedUnlinked(Guid user, string source)
            => Usable(user, source) is { SeerrUser: null };

        // The account isn't (or is no longer) the person's: forget the mapping and hold the request for a person.
        private RequestBackendResult Unlinked(Guid user, string source, string message)
        {
            Reassigned(user, source);
            return BackendResults.Hold("identity_changed", message);
        }

        // The account Seerr linked to the person is no longer theirs: every cache that depends on that link ends, and every
        // read of it running now can't put it back: the mapping, the prepared facts, and the Seerr proxy's own account
        // lookups (which would otherwise keep acting as the old account for their lifetime).
        private void Reassigned(Guid user, string source)
        {
            _ids.Invalidate(source + "|" + user.ToString("N"));
            _prepared.Invalidate(user);
            // The person's Seerr account authority records the loss (it moves unless an observation of it is already in).
            SeerrAccountAuthority.Observed(SeerrAccountAuthority.SourceOf(_config()), SeerrAccountAuthority.PersonOf(user), null);
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
            if (!EffectiveRequestsBackend.AllowsSeerr(_config())) throw new BackendDisabledException("backend_disabled");
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
        private readonly global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.State<SettingsRead?> _settingsFactsOwner = new();
        private SettingsRead? _settingsFacts { get => _settingsFactsOwner.Read(ref _settings, () => default!); set => _settingsFactsOwner.Store(ref _settings, value); }
    }
}
