using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live
{
    /// <summary>What JE found in an arr's Connect list for one of its instances (admin view, never the secret).</summary>
    public sealed class ArrWebhookState
    {
        /// <summary>The arr could be read.</summary>
        [JsonPropertyName("readable")]
        public bool Readable { get; init; }

        /// <summary>Why not (when not readable).</summary>
        [JsonPropertyName("error")]
        public string? Error { get; init; }

        /// <summary>JE holds a secret for this instance (accepts its webhooks).</summary>
        [JsonPropertyName("secretSet")]
        public bool SecretSet { get; init; }

        /// <summary>Webhook connections in the arr that point at this instance's JE address.</summary>
        [JsonPropertyName("webhooks")]
        public IReadOnlyList<ArrWebhookEntry> Webhooks { get; init; } = Array.Empty<ArrWebhookEntry>();

        /// <summary>The address JE would set up (from the setting), when it is valid.</summary>
        [JsonPropertyName("expectedUrl")]
        public string? ExpectedUrl { get; init; }
    }

    /// <summary>One webhook connection in an arr.</summary>
    public sealed class ArrWebhookEntry
    {
        /// <summary>Its id in the arr.</summary>
        [JsonPropertyName("id")]
        public int Id { get; init; }

        /// <summary>Its name in the arr.</summary>
        [JsonPropertyName("name")]
        public string Name { get; init; } = string.Empty;

        /// <summary>Where it sends to.</summary>
        [JsonPropertyName("url")]
        public string Url { get; init; } = string.Empty;

        /// <summary>It carries JE's current secret.</summary>
        [JsonPropertyName("secretMatches")]
        public bool SecretMatches { get; init; }

        /// <summary>Events it is switched on for (onGrab, onDownload, ...).</summary>
        [JsonPropertyName("events")]
        public IReadOnlyList<string> Events { get; init; } = Array.Empty<string>();
    }

    /// <summary>Copy-paste instructions for setting the webhook up by hand (admin only; holds the secret).</summary>
    public sealed class ArrWebhookManualSetup
    {
        /// <summary>Webhook URL to paste.</summary>
        [JsonPropertyName("url")]
        public string Url { get; init; } = string.Empty;

        /// <summary>HTTP method.</summary>
        [JsonPropertyName("method")]
        public string Method { get; init; } = "POST";

        /// <summary>Header name.</summary>
        [JsonPropertyName("headerName")]
        public string HeaderName { get; init; } = ArrWebhookReceiver.SecretHeader;

        /// <summary>Header value (the secret).</summary>
        [JsonPropertyName("headerValue")]
        public string HeaderValue { get; init; } = string.Empty;

        /// <summary>The "Notification Triggers" to tick, as the arr labels them.</summary>
        [JsonPropertyName("triggers")]
        public IReadOnlyList<string> Triggers { get; init; } = Array.Empty<string>();
    }

    /// <summary>
    /// Sets up, checks and removes JE's webhook in an arr (Settings → Connect → Webhook), with the
    /// administrator's consent. Writes go through <see cref="ArrActionRunner"/> (audited, one
    /// idempotency key per click, read back afterwards). Setting up is idempotent: JE's existing
    /// webhook for the instance (found by its address) is updated rather than duplicated, extra
    /// copies are removed, and the secret is kept. The arr tests a new or changed webhook by sending
    /// a Test event, so a successful save proves the arr can reach Jellyfin.
    /// </summary>
    public sealed class ArrWebhookProvisioner
    {
        /// <summary>Path of the receiver route, followed by the instance id.</summary>
        public const string HookPath = "/JellyfinEnhanced/arr/hook/";

        /// <summary>The webhook's name in the arr.</summary>
        public const string WebhookName = "Jellyfin Enhanced";

        private readonly ArrClientFactory _clients;
        private readonly ArrActionRunner _runner;
        private readonly ArrWebhookReceiver _receiver;
        private readonly Func<DateTimeOffset> _now;
        private readonly ConcurrentDictionary<string, SemaphoreSlim> _gates = new(StringComparer.OrdinalIgnoreCase);

        /// <summary>Creates the provisioner (DI).</summary>
        public ArrWebhookProvisioner(ArrClientFactory clients, ArrActionRunner runner, ArrWebhookReceiver receiver)
            : this(clients, runner, receiver, null)
        {
        }

        /// <summary>Creates the provisioner with a clock (tests).</summary>
        internal ArrWebhookProvisioner(ArrClientFactory clients, ArrActionRunner runner, ArrWebhookReceiver receiver, Func<DateTimeOffset>? now)
        {
            _clients = clients;
            _runner = runner;
            _receiver = receiver;
            _now = now ?? (() => DateTimeOffset.UtcNow);
        }

        /// <summary>
        /// Normalises "Jellyfin's address as the arr sees it": an absolute http(s) URL without
        /// credentials, query or fragment, at most 512 characters, no trailing slash.
        /// </summary>
        public static bool TryNormalizeJellyfinUrl(string? value, out string url)
        {
            url = string.Empty;
            var text = (value ?? string.Empty).Trim();
            if (text.Length == 0 || text.Length > 512) return false;
            if (!Uri.TryCreate(text, UriKind.Absolute, out var uri)) return false;
            if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) return false;
            if (!string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment)) return false;
            url = uri.GetLeftPart(UriPartial.Path).TrimEnd('/');
            return true;
        }

        /// <summary>The webhook address for an instance.</summary>
        public static string HookUrl(string jellyfinUrl, string instanceId) => jellyfinUrl.TrimEnd('/') + HookPath + instanceId;

        /// <summary>Reads the arr's Connect list and reports JE's webhooks for the instance.</summary>
        public async Task<ArrWebhookState> GetStateAsync(ArrConnection instance, string? jellyfinUrl, CancellationToken cancellationToken)
        {
            var expected = TryNormalizeJellyfinUrl(jellyfinUrl, out var u) ? HookUrl(u, instance.Id) : null;
            var secretSet = _receiver.HasSecret(instance.Id);
            var client = _clients.For(instance.Id);
            if (!client.Ok) return new ArrWebhookState { Readable = false, Error = client.Error!.Message, SecretSet = secretSet, ExpectedUrl = expected };
            var list = await client.Value!.GetAsync<List<JsonElement>>("notification", null, ArrCallClass.Read, cancellationToken).ConfigureAwait(false);
            if (!list.Ok) return new ArrWebhookState { Readable = false, Error = list.Error!.Message, SecretSet = secretSet, ExpectedUrl = expected };
            var secret = secretSet ? _receiver.EnsureSecret(instance.Id) : null;
            return new ArrWebhookState
            {
                Readable = true,
                SecretSet = secretSet,
                ExpectedUrl = expected,
                Webhooks = Ours(list.Value!, instance.Id).Select(n => Describe(n, secret)).ToList(),
            };
        }

        /// <summary>Copy-paste setup (creates the secret if there is none). Holds the secret: admin only, audited by the caller.</summary>
        public ArrWebhookManualSetup ManualSetup(ArrConnection instance, string jellyfinUrl) => new()
        {
            Url = HookUrl(jellyfinUrl, instance.Id),
            HeaderValue = _receiver.EnsureSecret(instance.Id),
            Triggers = instance.Kind == ArrKind.Radarr
                ? new[] { "On Grab", "On File Import", "On File Upgrade", "On Rename", "On Movie Added", "On Movie Delete", "On Movie File Delete", "On Movie File Delete For Upgrade", "On Health Issue", "On Health Restored", "On Application Update", "On Manual Interaction Required" }
                : new[] { "On Grab", "On File Import", "On Import Complete", "On File Upgrade", "On Rename", "On Series Add", "On Series Delete", "On Episode File Delete", "On Episode File Delete For Upgrade", "On Health Issue", "On Health Restored", "On Application Update", "On Manual Interaction Required" },
        };

        /// <summary>Creates or updates JE's webhook in the arr (audited write).</summary>
        public async Task<ArrActionOutcome> ProvisionAsync(ArrConnection instance, string jellyfinUrl, Guid userId, string? userName, string idempotencyKey, CancellationToken cancellationToken)
        {
            var hookUrl = HookUrl(jellyfinUrl, instance.Id);
            var identity = ArrActionRunner.Identity("webhook.provision", instance.Id, "notification:webhook", hookUrl);
            return await _runner.SingleFlightAsync(userId, idempotencyKey, identity, async token =>
            {
                var gate = Gate(instance.Id);
                await gate.WaitAsync(token).ConfigureAwait(false);
                try { return await ProvisionLockedAsync(instance, hookUrl, userId, userName, idempotencyKey, token).ConfigureAwait(false); }
                finally { gate.Release(); }
            }, () => new ArrActionOutcome { Status = ArrActionStatus.Rejected, Conflict = true, Message = "This repeats another action." }, cancellationToken).ConfigureAwait(false);
        }

        // One set-up or removal at a time per instance: a removal forgetting the secret must never
        // interleave with a set-up writing it into the arr.
        private SemaphoreSlim Gate(string instanceId) => _gates.GetOrAdd(instanceId, _ => new SemaphoreSlim(1, 1));

        private async Task<ArrActionOutcome> ProvisionLockedAsync(ArrConnection instance, string hookUrl, Guid userId, string? userName, string idempotencyKey, CancellationToken cancellationToken)
        {
            var started = _now();
            string? secret = null;
            // One connection for the whole set-up (D53, edition round 22): what is read, written, read back and tested goes to the
            // server the instance pointed at when the action started; after a save that points it elsewhere nothing is written.
            var bound = _clients.For(instance.Id);
            return await _runner.RunAsync(new ArrActionRequest
            {
                Action = "webhook.provision",
                InstanceId = instance.Id,
                Target = "notification:webhook",
                UserId = userId,
                UserName = userName,
                IdempotencyKey = idempotencyKey,
                Binding = bound.Ok ? ArrClientFactory.Tag(bound.Value!) : null,
                Fingerprint = ArrActionRunner.Identity("webhook.provision", instance.Id, "notification:webhook", hookUrl),
                Tier = ArrActionTier.Change,
                Details = new Dictionary<string, string> { ["url"] = hookUrl },
                Execute = async ct =>
                {
                    var client = bound.Ok ? _clients.Bound(bound.Value!) : bound;
                    if (!client.Ok) return client.Error;
                    secret = _receiver.EnsureSecret(instance.Id);
                    var existing = await client.Value!.GetAsync<List<JsonElement>>("notification", null, ArrCallClass.Read, ct).ConfigureAwait(false);
                    if (!existing.Ok) return existing.Error;
                    var schema = await client.Value.GetAsync<List<JsonElement>>("notification/schema", null, ArrCallClass.Read, ct).ConfigureAwait(false);
                    if (!schema.Ok) return schema.Error;
                    var template = schema.Value!.FirstOrDefault(s => Str(s, "implementation") == "Webhook");
                    if (template.ValueKind != JsonValueKind.Object) return new ArrError(ArrErrorKind.Validation, "This app version has no Webhook connection type.");

                    var ours = Ours(existing.Value!, instance.Id).ToList();
                    var name = WebhookName;
                    if (ours.Count == 0 && existing.Value!.Any(n => string.Equals(Str(n, "name"), WebhookName, StringComparison.OrdinalIgnoreCase)))
                    {
                        name = WebhookName + " (" + new Uri(hookUrl).Authority + ")";
                    }
                    var resource = Build(template, ours.Count > 0 ? Str(ours[0], "name") ?? name : name, hookUrl, secret);
                    ArrResult<NoContent> saved;
                    if (ours.Count > 0)
                    {
                        var id = Int(ours[0], "id") ?? 0;
                        resource["id"] = id;
                        saved = await client.Value.SendAsync<NoContent>(HttpMethod.Put, "notification/" + id.ToString(CultureInfo.InvariantCulture), resource, null, ct).ConfigureAwait(false);
                    }
                    else
                    {
                        saved = await client.Value.SendAsync<NoContent>(HttpMethod.Post, "notification", resource, null, ct).ConfigureAwait(false);
                    }
                    if (!saved.Ok) return saved.Error;
                    foreach (var extra in ours.Skip(1))
                    {
                        if (Int(extra, "id") is int extraId)
                            await client.Value.SendAsync<NoContent>(HttpMethod.Delete, "notification/" + extraId.ToString(CultureInfo.InvariantCulture), null, null, ct).ConfigureAwait(false);
                    }
                    return null;
                },
                ReadBack = async ct =>
                {
                    var client = bound;
                    if (!client.Ok || secret == null) return new ArrReadBack { Confirmed = null, Summary = "Could not check the result." };
                    var list = await client.Value!.GetAsync<List<JsonElement>>("notification", null, ArrCallClass.Read, ct).ConfigureAwait(false);
                    if (!list.Ok) return new ArrReadBack { Confirmed = null, Summary = "Could not check the result." };
                    var raw = Ours(list.Value!, instance.Id).ToList();
                    var ours = raw.Select(n => Describe(n, secret)).ToList();
                    var ok = ours.Count == 1 && string.Equals(ours[0].Url, hookUrl, StringComparison.OrdinalIgnoreCase) && ours[0].SecretMatches;
                    if (!ok) return new ArrReadBack { Confirmed = false, Summary = $"{ours.Count} matching webhook(s) found; expected one with the current address and secret." };

                    // The arr tests a new or changed webhook when saving it; an unchanged one is not
                    // re-tested, so ask for a test to prove the arr still reaches Jellyfin.
                    string? testError = null;
                    if (!Tested(instance.Id, started))
                    {
                        var test = await client.Value.SendAsync<NoContent>(HttpMethod.Post, "notification/test", JsonNode.Parse(raw[0].GetRawText()), null, ct).ConfigureAwait(false);
                        if (!test.Ok) testError = test.Error!.Message;
                    }
                    return new ArrReadBack
                    {
                        Confirmed = true,
                        Summary = Tested(instance.Id, started)
                            ? "Webhook set up; the test event reached Jellyfin."
                            : "Webhook set up, but its test event did not reach Jellyfin" + (testError != null ? " (" + testError.TrimEnd('.') + ")" : string.Empty) + ". Check Jellyfin's address as " + instance.Name + " sees it.",
                    };
                },
            }, cancellationToken).ConfigureAwait(false);
        }

        /// <summary>
        /// Removes JE's webhook(s) for the instance from the arr and forgets the secret (audited
        /// write). The secret is forgotten inside the action, after the deletes worked, so a
        /// replayed click (same idempotency key) never forgets a secret set up since.
        /// </summary>
        public async Task<ArrActionOutcome> RemoveAsync(ArrConnection instance, Guid userId, string? userName, string idempotencyKey, CancellationToken cancellationToken)
        {
            var identity = ArrActionRunner.Identity("webhook.remove", instance.Id, "notification:webhook");
            return await _runner.SingleFlightAsync(userId, idempotencyKey, identity, async token =>
            {
                var gate = Gate(instance.Id);
                await gate.WaitAsync(token).ConfigureAwait(false);
                try { return await RemoveLockedAsync(instance, userId, userName, idempotencyKey, token).ConfigureAwait(false); }
                finally { gate.Release(); }
            }, () => new ArrActionOutcome { Status = ArrActionStatus.Rejected, Conflict = true, Message = "This repeats another action." }, cancellationToken).ConfigureAwait(false);
        }

        private async Task<ArrActionOutcome> RemoveLockedAsync(ArrConnection instance, Guid userId, string? userName, string idempotencyKey, CancellationToken cancellationToken)
        {
            // One connection for the whole removal (see ProvisionLockedAsync).
            var bound = _clients.For(instance.Id);
            return await _runner.RunAsync(new ArrActionRequest
            {
                Action = "webhook.remove",
                InstanceId = instance.Id,
                Target = "notification:webhook",
                UserId = userId,
                UserName = userName,
                IdempotencyKey = idempotencyKey,
                Binding = bound.Ok ? ArrClientFactory.Tag(bound.Value!) : null,
                Tier = ArrActionTier.Change,
                Execute = async ct =>
                {
                    var client = bound.Ok ? _clients.Bound(bound.Value!) : bound;
                    if (!client.Ok) return client.Error;
                    var list = await client.Value!.GetAsync<List<JsonElement>>("notification", null, ArrCallClass.Read, ct).ConfigureAwait(false);
                    if (!list.Ok) return list.Error;
                    foreach (var n in Ours(list.Value!, instance.Id))
                    {
                        if (Int(n, "id") is not int id) continue;
                        var deleted = await client.Value.SendAsync<NoContent>(HttpMethod.Delete, "notification/" + id.ToString(CultureInfo.InvariantCulture), null, null, ct).ConfigureAwait(false);
                        if (!deleted.Ok && deleted.Error!.Kind != ArrErrorKind.NotFound) return deleted.Error;
                    }
                    _receiver.RemoveSecret(instance.Id);
                    return null;
                },
                ReadBack = async ct =>
                {
                    var client = bound;
                    if (!client.Ok) return new ArrReadBack { Confirmed = null, Summary = "Could not check the result." };
                    var list = await client.Value!.GetAsync<List<JsonElement>>("notification", null, ArrCallClass.Read, ct).ConfigureAwait(false);
                    if (!list.Ok) return new ArrReadBack { Confirmed = null, Summary = "Could not check the result." };
                    var left = Ours(list.Value!, instance.Id).Count();
                    return new ArrReadBack { Confirmed = left == 0, Summary = left == 0 ? "No Jellyfin Enhanced webhook left." : $"{left} webhook(s) still there." };
                },
            }, cancellationToken).ConfigureAwait(false);
        }

        private bool Tested(string instanceId, DateTimeOffset since) => _receiver.Stats(instanceId).LastTestAt is { } t && t >= since;

        /// <summary>JE's webhooks for an instance: Webhook connections whose URL ends with this instance's hook path.</summary>
        internal static IEnumerable<JsonElement> Ours(IEnumerable<JsonElement> notifications, string instanceId)
        {
            var suffix = HookPath + instanceId;
            return notifications.Where(n => Str(n, "implementation") == "Webhook"
                && FieldValue(n, "url") is { ValueKind: JsonValueKind.String } url
                && (url.GetString() ?? string.Empty).TrimEnd('/').EndsWith(suffix, StringComparison.OrdinalIgnoreCase));
        }

        private static ArrWebhookEntry Describe(JsonElement n, string? secret)
        {
            var header = FieldValue(n, "headers");
            var matches = false;
            if (secret != null && header is { ValueKind: JsonValueKind.Array } headers)
            {
                foreach (var h in headers.EnumerateArray())
                {
                    if (string.Equals(Str(h, "key"), ArrWebhookReceiver.SecretHeader, StringComparison.OrdinalIgnoreCase)
                        && Str(h, "value") is { } v && ArrWebhookReceiver.SecretsMatch(v, secret)) matches = true;
                }
            }
            var events = new List<string>();
            if (n.ValueKind == JsonValueKind.Object)
            {
                foreach (var p in n.EnumerateObject())
                {
                    if (p.Name.StartsWith("on", StringComparison.Ordinal) && p.Value.ValueKind == JsonValueKind.True) events.Add(p.Name);
                }
            }
            return new ArrWebhookEntry
            {
                Id = Int(n, "id") ?? 0,
                Name = Str(n, "name") ?? string.Empty,
                Url = FieldValue(n, "url") is { ValueKind: JsonValueKind.String } u ? u.GetString() ?? string.Empty : string.Empty,
                SecretMatches = matches,
                Events = events,
            };
        }

        // The arr's own Webhook template with JE's address, secret header and every event it supports.
        private static JsonObject Build(JsonElement template, string name, string hookUrl, string secret)
        {
            var resource = JsonNode.Parse(template.GetRawText())!.AsObject();
            resource.Remove("id");
            resource["name"] = name;
            resource["tags"] = new JsonArray();
            resource["includeHealthWarnings"] = false;
            foreach (var p in template.EnumerateObject())
            {
                if (!p.Name.StartsWith("supportsOn", StringComparison.Ordinal)) continue;
                var flag = "on" + p.Name["supportsOn".Length..];
                if (resource.ContainsKey(flag)) resource[flag] = p.Value.ValueKind == JsonValueKind.True;
            }
            if (resource["fields"] is JsonArray fields)
            {
                foreach (var f in fields.OfType<JsonObject>())
                {
                    switch (f["name"]?.GetValue<string>())
                    {
                        case "url": f["value"] = hookUrl; break;
                        case "method": f["value"] = 1; break;
                        case "username": f["value"] = string.Empty; break;
                        case "password": f["value"] = string.Empty; break;
                        case "headers": f["value"] = new JsonArray(new JsonObject { ["key"] = ArrWebhookReceiver.SecretHeader, ["value"] = secret }); break;
                    }
                }
            }
            return resource;
        }

        private static JsonElement? FieldValue(JsonElement n, string field)
        {
            if (n.ValueKind != JsonValueKind.Object || !n.TryGetProperty("fields", out var fields) || fields.ValueKind != JsonValueKind.Array) return null;
            foreach (var f in fields.EnumerateArray())
            {
                if (Str(f, "name") == field && f.TryGetProperty("value", out var v)) return v;
            }
            return null;
        }

        private static string? Str(JsonElement e, string name)
            => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

        private static int? Int(JsonElement e, string name)
            => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i) ? i : null;
    }
}
