using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>One person's household settings in a save (both fields replace the person's overrides).</summary>
    public sealed record HouseholdUserSave
    {
        /// <summary>Watcher, Kid, Member or Manager; null removes the override (the default role applies).</summary>
        [JsonPropertyName("role")] public string? Role { get; init; }

        /// <summary>Rolling request limit (-1 unlimited, 0 preset default, 1..10000); null removes the override.</summary>
        [JsonPropertyName("quotaLimit")] public int? QuotaLimit { get; init; }
    }

    /// <summary>A role's defaults in a save.</summary>
    public sealed record HouseholdRoleSave
    {
        /// <summary>Rolling request limit for the role (-1 unlimited, 0 preset default, 1..10000); null removes it.</summary>
        [JsonPropertyName("quotaLimit")] public int? QuotaLimit { get; init; }
    }

    /// <summary>Body of POST acquire/household (administrators): every part is optional and only named parts change.</summary>
    public sealed record HouseholdSave
    {
        /// <summary>ask_first, open_house or approve_everything.</summary>
        [JsonPropertyName("preset")] public string? Preset { get; init; }

        /// <summary>Role of people without an override: Watcher, Kid, Member or Manager.</summary>
        [JsonPropertyName("defaultRole")] public string? DefaultRole { get; init; }

        /// <summary>The household's rolling request limit (-1 unlimited, 0 preset default, 1..10000).</summary>
        [JsonPropertyName("quotaLimit")] public int? QuotaLimit { get; init; }

        /// <summary>Per-role defaults, keyed by role.</summary>
        [JsonPropertyName("roles")] public Dictionary<string, HouseholdRoleSave>? Roles { get; init; }

        /// <summary>Per-person overrides, keyed by Jellyfin user id.</summary>
        [JsonPropertyName("users")] public Dictionary<string, HouseholdUserSave>? Users { get; init; }
    }

    /// <summary>
    /// The Household tab: who is in the household with their role, request use and open requests
    /// (Managers see the people who share a library with them; Admins see everyone, plus 4K holders,
    /// overrides, the preset and defaults) and the administrators' save of roles, presets and quotas
    /// into the plugin configuration. Jellyfin administrators are always Admin; no save can make
    /// anyone Admin.
    /// </summary>
    public sealed class HouseholdService
    {
        /// <summary>Roles a save may give (household rules off).</summary>
        public static readonly IReadOnlyList<string> Roles = new[] { "Watcher", "Kid", "Member", "Manager" };

        /// <summary>Roles a save may give while household rules are on (phase 4b adds Trusted).</summary>
        public static readonly IReadOnlyList<string> RulesRoles = new[] { "Watcher", "Kid", "Member", "Trusted", "Manager" };

        /// <summary>The roles that can be given now.</summary>
        /// <param name="config">Configuration.</param>
        public static IReadOnlyList<string> RolesFor(PluginConfiguration config) => HouseholdFlags.Rules(config) ? RulesRoles : Roles;

        /// <summary>Household presets.</summary>
        public static readonly IReadOnlyList<string> Presets = new[] { "ask_first", "open_house", "approve_everything" };

        /// <summary>Most people listed.</summary>
        public const int MaxPeople = 500;

        /// <summary>Most open requests listed per person.</summary>
        public const int MaxRequestsPerPerson = 5;

        private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };
        private static readonly JsonSerializerOptions Stored = new() { PropertyNameCaseInsensitive = true };
        private readonly RequestHubProjection _hub;
        private readonly ArrChangeFeed _feed;
        private readonly Action<PluginConfiguration> _save;

        /// <summary>Creates the service; saves go through the plugin's own configuration save (DI).</summary>
        public HouseholdService(RequestHubProjection hub, ArrChangeFeed feed)
            : this(hub, feed, _ => JellyfinEnhanced.Instance?.SaveConfiguration())
        {
        }

        /// <summary>Creates the service with an explicit save (tests).</summary>
        internal HouseholdService(RequestHubProjection hub, ArrChangeFeed feed, Action<PluginConfiguration> save)
        {
            _hub = hub;
            _feed = feed;
            _save = save;
        }

        private RequestService Service => _hub.Service;

        /// <summary>
        /// The household as the caller (a Manager or Admin) may see it. Managers get the people who
        /// share at least one library with them (and themselves): name, role, request use and their
        /// open requests on titles the Manager can see. Admins get everyone, plus overrides, 4K holders,
        /// a parental-limit hint and the household settings.
        /// </summary>
        public async Task<StatusBody> ReadAsync(StatusViewer caller, CancellationToken ct)
        {
            var viewer = Service.Identity(caller.UserId);
            var admin = viewer.Role == "Admin";
            var config = Service.Policy.Configuration;
            var all = _hub.Directory.Libraries();
            var me = _hub.Directory.Person(caller.UserId);
            var people = _hub.Directory.People()
                .Where(p => !p.Disabled && p.Id != Guid.Empty)
                .Where(p => admin || p.Id == caller.UserId || (me != null && me.SharesLibraryWith(p, all)))
                .OrderBy(p => p.Name, StringComparer.OrdinalIgnoreCase).ThenBy(p => p.Id)
                .Take(MaxPeople).ToList();
            var overrides = ReadMap<RequestUserSettings>(config.ArrRequestUsers);
            // One row (and one count) per title edition: a person's ask and the Seerr request it was linked to when
            // requests moved are one title, not two.
            var open = new Dictionary<Guid, List<RequestWant>>();
            var shown = new Dictionary<Guid, List<RequestWant>>();
            var rows = new List<TitleRequests>();
            foreach (var person in people)
            {
                var wants = Service.Ledger.List(person.Id, false)
                    .Where(w => w.Status is "pending" or "queued" or "sent" or "stale")
                    .OrderByDescending(w => w.CreatedAt).ToList();
                open[person.Id] = LedgerRequestFacts.PerTitle(wants).Select(r => r.Row).ToList();
                // The rows shown are built from the requests the caller can see, so a merged row never carries the
                // seasons, status or progress of a member hidden from them.
                var visible = LedgerRequestFacts.PerTitle(wants.Where(w => Service.Policy.Evaluate(caller.UserId, w.Input).Visible)).Take(MaxRequestsPerPerson).ToList();
                shown[person.Id] = visible.Select(r => r.Row).ToList();
                rows.AddRange(visible);
            }
            var meta = await _hub.MetaAsync(rows.Select(r => r.Row.Input.Key), caller, ct).ConfigureAwait(false);
            // Where each shown request's part has got to (downloading, almost ready, ...), not just "on the way".
            var parts = await _hub.PartStatusesAsync(rows, caller, ct).ConfigureAwait(false);
            var list = people.Select(p =>
            {
                var facts = Service.Identity(p.Id);
                var quota = Service.Quota(p.Id);
                var own = open[p.Id];
                var entry = overrides.FirstOrDefault(o => Guid.TryParse(o.Key, out var id) && id == p.Id).Value;
                var caps = admin ? Service.Me(p.Id) : null;
                var roles = RolesFor(config);
                return new
                {
                    id = p.Id.ToString("N", CultureInfo.InvariantCulture),
                    name = p.Name,
                    role = facts.Role.ToLowerInvariant(),
                    you = p.Id == caller.UserId,
                    quota = new { used = quota.Used, limit = quota.Limit, available = quota.Available },
                    active = own.Count,
                    waiting = own.Count(w => w.Status == "pending"),
                    requests = shown[p.Id].Select(w =>
                    {
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
                            group = RequestHubProjection.Group(w.Status),
                            partStatus = parts.GetValueOrDefault(w.Id),
                            createdAt = w.CreatedAt,
                            title = title.Title,
                            year = title.Year,
                            poster = title.Poster,
                            itemId = title.ItemId,
                        };
                    }).ToArray(),
                    admin = admin ? new
                    {
                        jellyfinAdmin = p.IsAdmin,
                        roleOverride = entry?.Role is { } r && roles.Contains(r) ? r.ToLowerInvariant() : null,
                        quotaOverride = entry?.QuotaLimit,
                        fourK = caps!.Can4kMovies || caps.Can4kSeries,
                        parentalLimit = p.HasParentalLimit,
                        pool = facts.Pool?.Name,
                    } : null,
                };
            }).ToArray();
            var roleDefaults = ReadMap<RequestUserSettings>(config.ArrRequestRoles);
            var settings = admin ? new
            {
                backend = config.ArrRequestBackend is "je" or "seerr" ? config.ArrRequestBackend : "status_only",
                preset = Presets.Contains(config.ArrRequestPreset) ? config.ArrRequestPreset : "ask_first",
                defaultRole = RequestPolicy.NormalizeRole(config.ArrRequestDefaultRole, HouseholdFlags.Rules(config)).ToLowerInvariant(),
                quotaLimit = config.ArrRequestQuotaLimit,
                windowDays = Math.Clamp(config.ArrRequestQuotaWindowDays, 1, 365),
                roles = Roles.ToDictionary(r => r.ToLowerInvariant(), r => new { quotaLimit = roleDefaults.GetValueOrDefault(r)?.QuotaLimit }),
                // Phase 4b: which household-rule features are in effect (the Trusted role, the conditions, group pools).
                rules = HouseholdFlags.Rules(config) ? new { trusted = true, conditions = HouseholdFlags.RulesApply(config), pools = HouseholdFlags.Pools(config) } : null,
            } : null;
            var bytes = JsonSerializer.SerializeToUtf8Bytes(new { outcome = "accepted", reason = "household", certainty = "Succeeded", message = "Household", canEdit = admin, people = list, settings }, Json);
            return RequestHubProjection.Body(caller.UserId, viewer, "household", bytes);
        }

        /// <summary>
        /// Saves roles, per-person quota overrides, role defaults, the preset and the default role
        /// (administrators only; checked by the caller). Every value is validated before anything is
        /// written; unknown people and the Admin role are refused. Other configuration fields, and the
        /// overrides' other parts (4K grants, GB caps), are kept.
        /// </summary>
        public RequestOutcome Save(StatusViewer caller, HouseholdSave? body)
        {
            if (body == null) return RequestOutcome.Refused("invalid_input", 400);
            if (body.Preset != null && !Presets.Contains(body.Preset)) return RequestOutcome.Refused("invalid_preset", 400);
            var config0 = Service.Policy.Configuration;
            if (RoleRefusal(body.DefaultRole, config0) is { } defaultRefusal) return RequestOutcome.Refused(defaultRefusal, 400);
            if (!QuotaValid(body.QuotaLimit)) return RequestOutcome.Refused("invalid_quota", 400);
            if (body.Roles != null)
            {
                if (body.Roles.Count > Roles.Count) return RequestOutcome.Refused("invalid_input", 400);
                foreach (var (role, value) in body.Roles)
                {
                    // Role limits exist for the roles that have a limit (Trusted, like Managers, has none).
                    if ((RoleRefusal(role, config0) ?? (Roles.Contains(Canonical(role)) ? null : "invalid_role")) is { } roleRefusal) return RequestOutcome.Refused(roleRefusal, 400);
                    if (value == null || !QuotaValid(value.QuotaLimit)) return RequestOutcome.Refused("invalid_quota", 400);
                }
            }
            var users = new Dictionary<Guid, HouseholdUserSave>();
            if (body.Users != null)
            {
                if (body.Users.Count > MaxPeople) return RequestOutcome.Refused("invalid_input", 400);
                foreach (var (raw, value) in body.Users)
                {
                    if (!Guid.TryParse(raw, out var id) || id == Guid.Empty || value == null) return RequestOutcome.Refused("invalid_user", 400);
                    if (_hub.Directory.Person(id) == null) return RequestOutcome.Refused("unknown_user", 400);
                    if (RoleRefusal(value.Role, config0) is { } userRefusal) return RequestOutcome.Refused(userRefusal, 400);
                    if (!QuotaValid(value.QuotaLimit)) return RequestOutcome.Refused("invalid_quota", 400);
                    users[id] = value;
                }
            }
            // Under the lock a config-page save takes to swap the configuration object, so the edit lands on the
            // live configuration and neither save can overwrite the other; the saved values are read back.
            lock (JellyfinEnhanced.AnalyticsCredentialLock)
            {
                var config = Service.Policy.Configuration;
                Dictionary<string, RequestUserSettings> storedUsers;
                Dictionary<string, RequestUserSettings> storedRoles;
                try
                {
                    storedUsers = JsonSerializer.Deserialize<Dictionary<string, RequestUserSettings>>(string.IsNullOrWhiteSpace(config.ArrRequestUsers) ? "{}" : config.ArrRequestUsers, Stored) ?? new();
                    storedRoles = JsonSerializer.Deserialize<Dictionary<string, RequestUserSettings>>(string.IsNullOrWhiteSpace(config.ArrRequestRoles) ? "{}" : config.ArrRequestRoles, Stored) ?? new();
                }
                catch (JsonException)
                {
                    // Never overwrite settings that can't be read: an administrator fixes them first.
                    return RequestOutcome.Refused("configuration_unreadable", 409);
                }
                foreach (var (id, value) in users)
                {
                    var keys = storedUsers.Keys.Where(k => Guid.TryParse(k, out var parsed) && parsed == id).ToList();
                    var current = keys.Select(k => storedUsers[k]).FirstOrDefault() ?? new RequestUserSettings();
                    foreach (var key in keys) storedUsers.Remove(key);
                    var next = current with { Role = value.Role == null ? null : Canonical(value.Role), QuotaLimit = value.QuotaLimit };
                    if (next.Role != null || next.QuotaLimit != null || next.FourKInstances != null || next.QuotaGb != null)
                        storedUsers[id.ToString("N", CultureInfo.InvariantCulture)] = next;
                }
                if (body.Roles != null)
                {
                    foreach (var (role, value) in body.Roles)
                    {
                        var name = Roles.First(r => string.Equals(r, role, StringComparison.OrdinalIgnoreCase));
                        var current = storedRoles.GetValueOrDefault(name) ?? new RequestUserSettings();
                        var next = current with { QuotaLimit = value.QuotaLimit };
                        if (next.QuotaLimit != null || next.FourKInstances != null || next.QuotaGb != null || next.Role != null) storedRoles[name] = next;
                        else storedRoles.Remove(name);
                    }
                }
                if (body.Users != null) config.ArrRequestUsers = JsonSerializer.Serialize(storedUsers, new JsonSerializerOptions { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull });
                if (body.Roles != null) config.ArrRequestRoles = JsonSerializer.Serialize(storedRoles, new JsonSerializerOptions { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull });
                if (body.Preset != null) config.ArrRequestPreset = body.Preset;
                if (body.DefaultRole != null) config.ArrRequestDefaultRole = Canonical(body.DefaultRole);
                if (body.QuotaLimit.HasValue) config.ArrRequestQuotaLimit = body.QuotaLimit.Value;
                var written = (config.ArrRequestUsers, config.ArrRequestRoles, config.ArrRequestPreset, config.ArrRequestDefaultRole, config.ArrRequestQuotaLimit);
                try
                {
                    _save(config);
                }
                catch (Exception)
                {
                    return RequestOutcome.Refused("save_failed", 500, "unavailable") with { Message = "The household couldn't be saved. Try again." };
                }
                var live = Service.Policy.Configuration;
                if ((live.ArrRequestUsers, live.ArrRequestRoles, live.ArrRequestPreset, live.ArrRequestDefaultRole, live.ArrRequestQuotaLimit) != written)
                    return RequestOutcome.Refused("save_failed", 500, "unavailable") with { Message = "The household couldn't be saved. Try again." };
            }
            _feed.Bump(new[] { ArrTitleKey.RequestsState });
            return RequestOutcome.Accepted(caller.UserId.ToString("N", CultureInfo.InvariantCulture), "saved", 200) with { Message = "Household saved." };
        }

        private static string Canonical(string role) => RulesRoles.First(r => string.Equals(r, role, StringComparison.OrdinalIgnoreCase));

        // Trusted can be given only while household rules are on.
        private static string? RoleRefusal(string? role, PluginConfiguration config)
        {
            if (role == null) return null;
            if (string.Equals(role, "Admin", StringComparison.OrdinalIgnoreCase)) return "admin_role_refused";
            return RolesFor(config).Any(r => string.Equals(r, role, StringComparison.OrdinalIgnoreCase)) ? null : "invalid_role";
        }

        private static bool QuotaValid(int? limit) => limit is null or (>= -1 and <= 10000);

        private static Dictionary<string, T> ReadMap<T>(string? json)
        {
            try
            {
                return JsonSerializer.Deserialize<Dictionary<string, T>>(string.IsNullOrWhiteSpace(json) ? "{}" : json, Stored) ?? new();
            }
            catch (JsonException)
            {
                return new();
            }
        }
    }
}
