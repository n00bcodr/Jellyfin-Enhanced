using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>Body of <c>POST arr/admin/manage/add</c>.</summary>
    public sealed class ManageAddRequest
    {
        /// <summary>The instance to add the title to.</summary>
        [JsonPropertyName("instanceId")] public string? InstanceId { get; set; }

        /// <summary>The movie or series key.</summary>
        [JsonPropertyName("key")] public string? Key { get; set; }

        /// <summary>Quality profile (null: the instance's add default).</summary>
        [JsonPropertyName("profileId")] public int? ProfileId { get; set; }

        /// <summary>Root folder (null: the instance's add default).</summary>
        [JsonPropertyName("rootFolder")] public string? RootFolder { get; set; }

        /// <summary>Explicitly replace the observed title-wide choice while it is still known unsent.</summary>
        [JsonPropertyName("overrideChoiceVersion")] public long? OverrideChoiceVersion { get; set; }

        /// <summary>Series only: the seasons to monitor.</summary>
        [JsonPropertyName("seasons")] public int[]? Seasons { get; set; }

        /// <summary>One key per sheet: a repeated tap gets the first request back.</summary>
        [JsonPropertyName("idempotencyKey")] public string? IdempotencyKey { get; set; }
    }

    /// <summary>One choice in the add sheet.</summary>
    /// <param name="Id">Profile or tag id.</param>
    /// <param name="Name">Its name.</param>
    public sealed record AddChoice([property: JsonPropertyName("id")] int Id, [property: JsonPropertyName("name")] string Name);

    /// <summary>A root folder the instance lists.</summary>
    /// <param name="Path">Path as the arr has it.</param>
    /// <param name="FreeSpace">Free bytes, when known.</param>
    /// <param name="Accessible">Whether the arr can write there.</param>
    public sealed record AddFolder([property: JsonPropertyName("path")] string Path, [property: JsonPropertyName("freeSpace")] long? FreeSpace, [property: JsonPropertyName("accessible")] bool Accessible);

    /// <summary>A season of the title, from the arr's lookup.</summary>
    /// <param name="SeasonNumber">Season number (0: specials).</param>
    /// <param name="Monitored">Monitored in the arr now (null: not in the arr).</param>
    public sealed record AddSeason([property: JsonPropertyName("seasonNumber")] int SeasonNumber, [property: JsonPropertyName("monitored")] bool? Monitored);

    /// <summary>The add sheet's facts: administrators only (the instance's own profiles and folders).</summary>
    public sealed class AddOptions
    {
        /// <summary>True when the title can be added from Jellyfin Enhanced (else the sheet links to the arr).</summary>
        [JsonPropertyName("direct")] public bool Direct { get; init; }

        /// <summary>Why not, when <see cref="Direct"/> is false.</summary>
        [JsonPropertyName("reason")] public string? Reason { get; init; }

        /// <summary>Administrator wording for <see cref="Reason"/>.</summary>
        [JsonPropertyName("message")] public string? Message { get; init; }

        /// <summary>The instance.</summary>
        [JsonPropertyName("instance")] public object? Instance { get; init; }

        /// <summary>Quality profiles.</summary>
        [JsonPropertyName("profiles")] public IReadOnlyList<AddChoice> Profiles { get; init; } = Array.Empty<AddChoice>();

        /// <summary>Root folders.</summary>
        [JsonPropertyName("rootFolders")] public IReadOnlyList<AddFolder> RootFolders { get; init; } = Array.Empty<AddFolder>();

        /// <summary>Tags.</summary>
        [JsonPropertyName("tags")] public IReadOnlyList<AddChoice> Tags { get; init; } = Array.Empty<AddChoice>();

        /// <summary>The instance's saved add defaults.</summary>
        [JsonPropertyName("defaults")] public ArrInstanceDefaults? Defaults { get; init; }

        /// <summary>Whether the saved defaults pass the check against the current snapshot.</summary>
        [JsonPropertyName("defaultsValid")] public bool DefaultsValid { get; init; }

        /// <summary>Why the saved defaults don't pass.</summary>
        [JsonPropertyName("defaultsMessage")] public string? DefaultsMessage { get; init; }

        /// <summary>When the profiles and folders were read from the instance.</summary>
        [JsonPropertyName("asOf")] public DateTimeOffset? AsOf { get; init; }

        /// <summary>The title, when a key was given.</summary>
        [JsonPropertyName("title")] public object? Title { get; init; }
    }

    /// <summary>
    /// The Manage drawer's direct "Add to {instance}" (administrators only). The sheet's choices come from
    /// a current system snapshot of the instance; the add itself is a request in the ledger, owned by the
    /// administrator and routed to that instance, so it goes through the outbox like every request:
    /// idempotency key, final re-check, read-back, change feed and audit.
    /// </summary>
    public sealed class ArrAddService
    {
        private readonly ArrStateStore _store;
        private readonly ArrClientFactory _clients;
        private readonly RequestService _requests;
        private readonly Func<PluginConfiguration?> _config;

        /// <summary>Creates the service (DI).</summary>
        public ArrAddService(ArrStateStore store, ArrClientFactory clients, RequestService requests)
            : this(store, clients, requests, () => JellyfinEnhanced.Instance?.Configuration)
        {
        }

        /// <summary>Creates the service over an explicit configuration (tests).</summary>
        internal ArrAddService(ArrStateStore store, ArrClientFactory clients, RequestService requests, Func<PluginConfiguration?> config)
        {
            _store = store;
            _clients = clients;
            _requests = requests;
            _config = config;
        }

        /// <summary>The request service (caller resolution).</summary>
        public RequestService Requests => _requests;

        /// <summary>Phase 1 is on (the store and registry are in use).</summary>
        public bool Enabled => _config() is { ArrIntegrationEnabled: true, ArrPhase1Enabled: true };

        /// <summary>Adding from Jellyfin Enhanced is possible: phase 3 on and Jellyfin Enhanced handles requests.</summary>
        public static bool DirectOn(PluginConfiguration? config)
            => config is { ArrIntegrationEnabled: true, ArrPhase1Enabled: true, ArrPhase3Enabled: true, ArrRequestBackend: "je" };

        /// <summary>
        /// The sheet's choices for <paramref name="instanceId"/>; with <paramref name="key"/> also the title
        /// (one lookup on the instance). Null when the instance is unknown.
        /// </summary>
        public async Task<AddOptions?> OptionsAsync(string instanceId, TitleKey? key, CancellationToken ct)
        {
            var instance = _clients.Registry.Get(instanceId);
            if (instance == null) return null;
            var config = _config();
            var info = new { id = instance.Id, name = instance.Name, kind = instance.Kind.ToString(), role = instance.Role };
            if (!instance.Usable) return new AddOptions { Instance = info, Reason = "instance_unusable", Message = $"{instance.Name} is disabled.", Defaults = instance.Defaults };
            var system = await ArrAddRules.FreshSystemAsync(_store, instance, ct).ConfigureAwait(false);
            // One connection for the whole preview (D53, edition round 22): its defaults, tags and the title lookup are read through
            // the client the system facts came from, so the preview never mixes two servers' answers.
            var bound = system.ReadBy is { } read ? _clients.Bound(read) : _clients.For(instance.Id);
            var tags = await TagsAsync(instance, ct, bound.Ok ? bound.Value : null).ConfigureAwait(false);
            var check = ArrAddRules.Check(instance, system, tags);
            var profiles = system.Value?.QualityProfiles.Select(p => new AddChoice(p.Id, p.Name)).ToList() ?? new List<AddChoice>();
            var folders = system.Value?.RootFolders.Where(r => !string.IsNullOrEmpty(r.Path)).Select(r => new AddFolder(r.Path!, r.FreeSpace, r.Accessible != false)).ToList() ?? new List<AddFolder>();
            string? reason = null;
            string? message = null;
            if (!DirectOn(config))
            {
                reason = config?.ArrPhase3Enabled == true ? "seerr_mode" : "phase_off";
                message = reason == "seerr_mode"
                    ? "Seerr handles requests here, so titles are added in the arr (or Seerr) itself."
                    : "Adding from Jellyfin Enhanced needs Requests & downloads phase 3 with Jellyfin Enhanced handling requests.";
            }
            else if (system.Value == null || system.Error != null || system.Stale)
            {
                reason = "snapshot_unavailable";
                message = $"{instance.Name}'s profiles and root folders couldn't be read just now.";
            }
            else if (key != null && (instance.Kind == ArrKind.Radarr) != key.IsMovie)
            {
                reason = "kind_mismatch";
                message = $"{instance.Name} doesn't take this kind of title.";
            }
            else if (key != null && instance.Role == ArrInstanceRole.FourK && !RequestPolicy.EditionEnabled(config!, key.IsMovie))
            {
                reason = "fourk_off";
                message = "4K requests are switched off for this kind of title (Requests & downloads settings).";
            }
            object? title = null;
            if (key != null && reason == null)
            {
                var client = bound;
                if (!client.Ok)
                {
                    reason = "snapshot_unavailable";
                    message = client.Error!.Message;
                }
                else
                {
                    var lookup = await DirectArrBackend.LookupAsync(client.Value!, key.Title, ct).ConfigureAwait(false);
                    if (lookup.Error != null)
                    {
                        reason = "lookup_failed";
                        message = $"{instance.Name} couldn't look the title up: {lookup.Error.Message}";
                    }
                    else if (lookup.Row is not { } row || (!key.IsMovie && DirectArrBackend.Int(row, "tvdbId") is not > 0))
                    {
                        reason = "title_not_found";
                        message = $"{instance.Name} couldn't find this title by its id.";
                    }
                    else
                    {
                        var inArr = DirectArrBackend.Int(row, "id") is > 0;
                        var seasons = row.TryGetProperty("seasons", out var list) && list.ValueKind == JsonValueKind.Array
                            ? list.EnumerateArray().Where(s => DirectArrBackend.Int(s, "seasonNumber") is >= 0)
                                .Select(s => new AddSeason(DirectArrBackend.Int(s, "seasonNumber")!.Value, inArr ? DirectArrBackend.Bool(s, "monitored") : null))
                                .OrderBy(s => s.SeasonNumber).ToList()
                            : new List<AddSeason>();
                        title = new
                        {
                            title = DirectArrBackend.Str(row, "title"),
                            year = DirectArrBackend.Int(row, "year"),
                            inArr,
                            seasons = key.IsMovie ? null : seasons,
                        };
                    }
                }
            }
            return new AddOptions
            {
                Direct = reason == null,
                Reason = reason,
                Message = message,
                Instance = info,
                Profiles = profiles,
                RootFolders = folders,
                Tags = tags?.Select(t => new AddChoice(t.Key, t.Value)).OrderBy(t => t.Name, StringComparer.OrdinalIgnoreCase).ToList() ?? new List<AddChoice>(),
                Defaults = instance.Defaults,
                DefaultsValid = check.Defaults != null,
                DefaultsMessage = check.Defaults == null ? check.Message : null,
                AsOf = system.LoadedAt,
                Title = title,
            };
        }

        /// <summary>
        /// Records the administrator's add as a request routed to the instance (the outbox sends it).
        /// Profile and folder overrides are checked against a current snapshot first.
        /// </summary>
        public async Task<RequestOutcome> AddAsync(Guid admin, ManageAddRequest? body, CancellationToken ct)
        {
            if (!_requests.Policy.IsAdmin(admin)) return RequestOutcome.Refused("admin_required");
            if (!DirectOn(_config())) return RequestOutcome.Refused("direct_add_unavailable", 409, "unavailable") with { Message = "Adding from Jellyfin Enhanced isn't on." };
            if (body == null || string.IsNullOrWhiteSpace(body.InstanceId) || TitleKey.Parse(body.Key) is not { } parsed || parsed.Season.HasValue)
                return RequestOutcome.Refused("invalid_input", 400);
            if (string.IsNullOrWhiteSpace(body.IdempotencyKey) || body.IdempotencyKey.Length > 64 || body.IdempotencyKey.Any(char.IsControl))
                return RequestOutcome.Refused("idempotency_key_required", 400);
            var identity = MutationInput.Hash(JsonSerializer.Serialize(new { operation = "add", title = parsed.ToString(), instance = body.InstanceId.ToLowerInvariant(), body.ProfileId, body.RootFolder, seasons = body.Seasons?.Distinct().OrderBy(n => n).ToArray() }));
            // An explicitly confirmed replacement of the title's add settings is part of what was asked (one durable owner, M9).
            identity = PressChecks.WithChoiceOverride(identity, body.OverrideChoiceVersion);
            return await _requests.Ledger.Database.RetryOwners.ExecuteAsync(admin, body.IdempotencyKey, "add", identity,
                token => AddOwnedAsync(admin, body, parsed, identity, token),
                () => RequestOutcome.Refused(PressChecks.Conflict, 409), RetryOwners.UnresolvedRequest, ct, DateTimeOffset.UtcNow,
                releaseUnsent: result => result.HttpStatus >= 400).ConfigureAwait(false);
        }

        private async Task<RequestOutcome> AddOwnedAsync(Guid admin, ManageAddRequest body, TitleKey parsed, string identity, CancellationToken ct)
        {
            var instance = _clients.Registry.Get(body.InstanceId);
            if (instance == null) return RequestOutcome.Refused("not_found", 404);
            if (!instance.Usable) return RequestOutcome.Refused("instance_changed", 409);
            if ((instance.Kind == ArrKind.Radarr) != parsed.IsMovie) return RequestOutcome.Refused("invalid_instance", 400);
            int[] seasons = Array.Empty<int>();
            if (!parsed.IsMovie)
            {
                seasons = (body.Seasons ?? Array.Empty<int>()).Distinct().OrderBy(s => s).ToArray();
                if (seasons.Length is 0 or > 200 || seasons.Any(s => s is < 0 or > 10000)) return RequestOutcome.Refused("invalid_input", 400);
            }
            ArrAddDefaults? effective = null;
            if (body.ProfileId != null || body.RootFolder != null)
            {
                var system = await ArrAddRules.FreshSystemAsync(_store, instance, ct).ConfigureAwait(false);
                var check = ArrAddRules.Check(instance, system, await TagsAsync(instance, ct).ConfigureAwait(false), body.ProfileId, body.RootFolder);
                if (check.Defaults == null)
                    return RequestOutcome.Refused(check.Reason!, check.Reason == "defaults_unverified" ? 503 : 400, check.Reason == "defaults_unverified" ? "unavailable" : "denied") with { Message = check.Message };
                effective = check.Defaults;
            }
            var input = new MutationInput
            {
                Key = parsed.ToString(),
                Scope = parsed.IsMovie ? "movie" : "seasons",
                Variant = instance.Role == ArrInstanceRole.FourK ? "4k" : "standard",
                Seasons = seasons,
                InstanceId = instance.Id,
                ProfileId = effective?.ProfileId ?? body.ProfileId,
                RootFolder = effective?.RootFolder ?? body.RootFolder,
            };
            // The administrator's key, in the same namespace as their asks (D53, edition round 22): an add is told apart by its
            // operation in the request's identity, never by a key prefix of its own. An explicit choice-conflict consent travels
            // with it, and is part of that identity.
            return await _requests.CreateAsync(admin, new CreateRequest(body.IdempotencyKey!.Trim(), input, OverrideChoiceVersion: body.OverrideChoiceVersion) { Operation = "add", Identity = identity }, ct).ConfigureAwait(false);
        }

        // Tag ids and labels: from the library snapshot in memory (display labels; the add's own send checks its tag ids again),
        // else one read of the instance's tags through the given client (the preview's connection).
        private async Task<IReadOnlyDictionary<int, string>?> TagsAsync(ArrConnection instance, CancellationToken ct, ArrClient? through = null)
        {
            if (_store.PeekLibrary(instance.Id)?.Tags is { } held) return held;
            var client = through != null ? ArrResult<ArrClient>.Success(through) : _clients.For(instance.Id);
            if (!client.Ok) return null;
            var read = await client.Value!.GetAsync<List<JsonElement>>("tag", null, ArrCallClass.Read, ct).ConfigureAwait(false);
            if (!read.Ok) return null;
            return read.Value!.Where(t => DirectArrBackend.Int(t, "id") is > 0)
                .GroupBy(t => DirectArrBackend.Int(t, "id")!.Value)
                .ToDictionary(g => g.Key, g => DirectArrBackend.Str(g.First(), "label") ?? string.Empty);
        }
    }
}
