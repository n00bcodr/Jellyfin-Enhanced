using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>Body of POST acquire/household/rules (administrators): only named parts change.</summary>
    public sealed record HouseholdRulesSave
    {
        /// <summary>The conditions per role (replaces the stored set).</summary>
        [JsonPropertyName("rules")] public HouseholdRuleSet? Rules { get; init; }

        /// <summary>The household streaming country (ISO 3166-1; empty clears it).</summary>
        [JsonPropertyName("streamingCountry")] public string? StreamingCountry { get; init; }

        /// <summary>The household's streaming services (TMDB provider ids; empty clears them).</summary>
        [JsonPropertyName("streamingServices")] public int[]? StreamingServices { get; init; }

        /// <summary>Group quota pools in precedence order (replaces the stored list).</summary>
        [JsonPropertyName("pools")] public List<GroupQuotaPool>? Pools { get; init; }
    }

    /// <summary>What Seerr says about its own request rules (Seerr handling), read-only; null parts weren't readable.</summary>
    /// <param name="Available">Seerr answered.</param>
    /// <param name="OverrideRules">Seerr's override rules as it describes them, or null when it can't describe them.</param>
    /// <param name="AutoApprove">New Seerr users' requests are approved automatically (Seerr's default permissions), or null.</param>
    /// <param name="MovieQuota">Seerr's default movie quota (limit/days), or null.</param>
    /// <param name="TvQuota">Seerr's default series quota (limit/days), or null.</param>
    public sealed record SeerrRulesView(bool Available, IReadOnlyList<JsonElement>? OverrideRules, bool? AutoApprove, object? MovieQuota, object? TvQuota);

    /// <summary>
    /// The household rules editor behind the Requests page's Household tab (phase 4b): reads and saves the fixed
    /// conditions per role, the household streaming country and services, and the group pools (administrators; Jellyfin
    /// Enhanced handling). In Seerr mode the editors are closed and Seerr's own rules are shown read-only, as Seerr
    /// describes them. Saves validate everything before writing and land on the live configuration under the lock a
    /// configuration-page save takes.
    /// </summary>
    public sealed class HouseholdRulesService
    {
        private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };
        private readonly RequestService _service;
        private readonly ArrChangeFeed _feed;
        private readonly Action<PluginConfiguration> _save;
        private readonly Func<string, CancellationToken, Task<IReadOnlyList<RuleProvider>?>> _providers;
        private readonly Func<CancellationToken, Task<SeerrRulesView>> _seerr;

        /// <summary>Creates the service (DI): TMDB's watch-provider list through the shared cache, Seerr's rules over its API.</summary>
        public HouseholdRulesService(RequestService service, ArrChangeFeed feed, TmdbResponseCache tmdb, IHttpClientFactory http)
            : this(service, feed, _ => JellyfinEnhanced.Instance?.SaveConfiguration(), (country, ct) => ProvidersAsync(tmdb, country, ct), ct => SeerrAsync(http, ct))
        {
        }

        /// <summary>Creates the service over explicit saves and reads (tests).</summary>
        internal HouseholdRulesService(RequestService service, ArrChangeFeed feed, Action<PluginConfiguration> save,
            Func<string, CancellationToken, Task<IReadOnlyList<RuleProvider>?>> providers, Func<CancellationToken, Task<SeerrRulesView>> seerr)
        {
            _service = service;
            _feed = feed;
            _save = save;
            _providers = providers;
            _seerr = seerr;
        }

        /// <summary>The request service.</summary>
        public RequestService Requests => _service;

        /// <summary>
        /// The rules as an administrator edits them: which parts are in effect, the conditions, streaming settings, pools
        /// with their use, and the choices (roles, actions, genres). In Seerr mode, Seerr's own rules read-only.
        /// </summary>
        /// <param name="ct">Cancellation.</param>
        public async Task<byte[]> ReadAsync(CancellationToken ct)
        {
            var config = _service.Policy.Configuration;
            var seerr = config.ArrRequestBackend == "seerr" ? await _seerr(ct).ConfigureAwait(false) : null;
            var pools = GroupQuotaPolicy.Parse(config.ArrGroupQuotaPools);
            var now = DateTimeOffset.UtcNow;
            var body = new
            {
                outcome = "accepted",
                reason = "household_rules",
                certainty = "Succeeded",
                message = "Household rules",
                backend = config.ArrRequestBackend is "je" or "seerr" ? config.ArrRequestBackend : "status_only",
                enabled = HouseholdFlags.Rules(config),
                conditions = HouseholdFlags.RulesApply(config),
                poolsEnabled = HouseholdFlags.Pools(config),
                // Seerr mode: the editors are closed; JE adds no rules or pools on top of Seerr's.
                editable = HouseholdFlags.RulesApply(config),
                rules = HouseholdRules.Parse(config.ArrHouseholdRules),
                streamingCountry = HouseholdRules.ValidCountry(config.ArrHouseholdStreamingCountry) ? config.ArrHouseholdStreamingCountry : string.Empty,
                streamingServices = HouseholdRules.Services(config.ArrHouseholdStreamingServices).OrderBy(i => i).ToArray(),
                pools = pools.Select(p => new
                {
                    id = p.Id,
                    name = p.Name,
                    limit = p.Limit,
                    roles = p.Roles,
                    users = p.Users,
                    used = _service.Ledger.Database.Available ? _service.Ledger.PoolQuota(new GroupPoolBinding(p.Id, p.Name, p.Limit, Math.Clamp(config.ArrRequestQuotaWindowDays, 1, 365)), now).Used : (int?)null,
                }).ToArray(),
                windowDays = Math.Clamp(config.ArrRequestQuotaWindowDays, 1, 365),
                choices = new
                {
                    roles = HouseholdRules.RuledRoles.Select(r => r.ToLowerInvariant()),
                    poolRoles = GroupQuotaPolicy.PoolRoles.Select(r => r == "*" ? r : r.ToLowerInvariant()),
                    actions = HouseholdRules.Actions,
                    genres = HouseholdRules.Genres.OrderBy(g => g.Value, StringComparer.Ordinal).Select(g => new { id = g.Key, name = g.Value }),
                },
                seerr,
            };
            return JsonSerializer.SerializeToUtf8Bytes(body, Json);
        }

        /// <summary>
        /// Saves the conditions, streaming settings and pools (administrators; checked by the caller). Every part is
        /// validated before anything is written. Refused while the rules don't apply (off, or Seerr handling: Seerr's
        /// rules are Seerr's), and pools while group quotas are off. Saved values are read back.
        /// </summary>
        /// <param name="caller">The administrator.</param>
        /// <param name="body">What changes.</param>
        public RequestOutcome Save(StatusViewer caller, HouseholdRulesSave? body)
        {
            if (body == null) return RequestOutcome.Refused("invalid_input", 400);
            var config0 = _service.Policy.Configuration;
            if (!HouseholdFlags.Rules(config0)) return RequestOutcome.Refused("feature_disabled");
            if (config0.ArrRequestBackend != "je") return RequestOutcome.Refused("rules_seerr_owned", 409) with { Message = "Seerr handles requests: its own rules apply, and Jellyfin Enhanced adds none." };
            if (body.Pools != null && !HouseholdFlags.Pools(config0)) return RequestOutcome.Refused("feature_disabled");
            string? rules = null, pools = null, country = null, services = null;
            if (body.Rules != null)
            {
                var set = body.Rules with { Roles = new Dictionary<string, HouseholdRoleRules>(body.Rules.Roles ?? new(), StringComparer.OrdinalIgnoreCase) };
                if (HouseholdRules.Validate(set) is { } refusal) return RequestOutcome.Refused(refusal, 400);
                rules = HouseholdRules.Store(set);
            }

            if (body.StreamingCountry != null)
            {
                var value = body.StreamingCountry.Trim().ToUpperInvariant();
                if (value.Length > 0 && !HouseholdRules.ValidCountry(value)) return RequestOutcome.Refused("invalid_country", 400);
                country = value;
            }

            if (body.StreamingServices != null)
            {
                if (body.StreamingServices.Length > 100 || body.StreamingServices.Any(i => i <= 0)) return RequestOutcome.Refused("invalid_services", 400);
                services = string.Join(",", body.StreamingServices.Distinct().OrderBy(i => i).Select(i => i.ToString(CultureInfo.InvariantCulture)));
            }

            if (body.Pools != null)
            {
                if (GroupQuotaPolicy.Validate(body.Pools) is { } refusal) return RequestOutcome.Refused(refusal, 400);
                pools = GroupQuotaPolicy.Store(body.Pools);
            }

            lock (JellyfinEnhanced.AnalyticsCredentialLock)
            {
                var config = _service.Policy.Configuration;
                if (rules != null) config.ArrHouseholdRules = rules;
                if (country != null) config.ArrHouseholdStreamingCountry = country;
                if (services != null) config.ArrHouseholdStreamingServices = services;
                if (pools != null) config.ArrGroupQuotaPools = pools;
                var written = (config.ArrHouseholdRules, config.ArrHouseholdStreamingCountry, config.ArrHouseholdStreamingServices, config.ArrGroupQuotaPools);
                try
                {
                    _save(config);
                }
                catch (Exception)
                {
                    return RequestOutcome.Refused("save_failed", 500, "unavailable") with { Message = "The household rules couldn't be saved. Try again." };
                }

                var live = _service.Policy.Configuration;
                if ((live.ArrHouseholdRules, live.ArrHouseholdStreamingCountry, live.ArrHouseholdStreamingServices, live.ArrGroupQuotaPools) != written)
                    return RequestOutcome.Refused("save_failed", 500, "unavailable") with { Message = "The household rules couldn't be saved. Try again." };
            }

            _feed.Bump(new[] { ArrTitleKey.RequestsState });
            return RequestOutcome.Accepted(caller.UserId.ToString("N", CultureInfo.InvariantCulture), "saved", 200) with { Message = "Household rules saved." };
        }

        /// <summary>The streaming services TMDB lists for a country (movies and series together), or null when unreadable.</summary>
        /// <param name="country">ISO 3166-1 code.</param>
        /// <param name="ct">Cancellation.</param>
        public Task<IReadOnlyList<RuleProvider>?> ServicesAsync(string country, CancellationToken ct) => _providers(country, ct);

        private static async Task<IReadOnlyList<RuleProvider>?> ProvidersAsync(TmdbResponseCache tmdb, string country, CancellationToken ct)
        {
            var key = JellyfinEnhanced.Instance?.Configuration.GetTmdbApiKey();
            if (string.IsNullOrEmpty(key)) return null;
            var list = new Dictionary<int, RuleProvider>();
            var any = false;
            foreach (var media in new[] { "movie", "tv" })
            {
                var answer = await tmdb.GetAsync("watch/providers/" + media, "?watch_region=" + Uri.EscapeDataString(country), key, ct).ConfigureAwait(false);
                if (!answer.IsSuccess) continue;
                any = true;
                try
                {
                    using var doc = JsonDocument.Parse(answer.Content);
                    if (!doc.RootElement.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array) continue;
                    foreach (var p in results.EnumerateArray())
                    {
                        if (p.TryGetProperty("provider_id", out var id) && id.TryGetInt32(out var n) && n > 0 && !list.ContainsKey(n))
                            list[n] = new RuleProvider(n, p.TryGetProperty("provider_name", out var name) && name.ValueKind == JsonValueKind.String ? (name.GetString() ?? string.Empty).Trim() : string.Empty);
                    }
                }
                catch (JsonException)
                {
                    // Unreadable answer: nothing from it.
                }
            }

            return any ? list.Values.OrderBy(p => p.Name, StringComparer.OrdinalIgnoreCase).ToList() : null;
        }

        /// <summary>Seerr's own request rules (Seerr handling), read-only.</summary>
        /// <param name="ct">Cancellation.</param>
        public Task<SeerrRulesView> SeerrRulesAsync(CancellationToken ct) => _seerr(ct);

        private static async Task<SeerrRulesView> SeerrAsync(IHttpClientFactory http, CancellationToken ct)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            var url = config?.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault()?.Trim().TrimEnd('/');
            if (config == null || string.IsNullOrEmpty(url)) return new SeerrRulesView(false, null, null, null, null);
            var client = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(http);
            async Task<JsonElement?> Get(string path)
            {
                try
                {
                    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                    timeout.CancelAfter(TimeSpan.FromSeconds(8));
                    using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(HttpMethod.Get, url + path, config.GetJellyseerrApiKey());
                    using var response = await client.SendAsync(request, timeout.Token).ConfigureAwait(false);
                    var (body, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, url + path, timeout.Token).ConfigureAwait(false);
                    if (error != null || body == null) return null;
                    using var doc = JsonDocument.Parse(body);
                    return doc.RootElement.Clone();
                }
                catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException or JsonException or InvalidOperationException)
                {
                    return null;
                }
            }

            var main = await Get("/api/v1/settings/main").ConfigureAwait(false);
            var rules = await Get("/api/v1/overrideRule").ConfigureAwait(false);
            bool? auto = null;
            object? Quota(string kind) => main is { } m && m.TryGetProperty("defaultQuotas", out var q) && q.ValueKind == JsonValueKind.Object
                && q.TryGetProperty(kind, out var part) && part.ValueKind == JsonValueKind.Object
                ? new { limit = part.TryGetProperty("quotaLimit", out var l) && l.TryGetInt32(out var li) ? li : (int?)null, days = part.TryGetProperty("quotaDays", out var d) && d.TryGetInt32(out var di) ? di : (int?)null }
                : null;
            if (main is { } settings && settings.TryGetProperty("defaultPermissions", out var bits) && bits.TryGetInt64(out var value))
                auto = (value & (long)(JellyseerrPermission.ADMIN | JellyseerrPermission.AUTO_APPROVE)) != 0;
            // Seerr describes its override rules as a list; anything else is "can't describe" (shown as unknown).
            var list = rules is { ValueKind: JsonValueKind.Array } array ? array.EnumerateArray().Take(100).ToList() : null;
            return new SeerrRulesView(main != null || rules != null, list, auto, Quota("movie"), Quota("tv"));
        }
    }
}
