using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Secrets;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live
{
    /// <summary>How a webhook call was answered.</summary>
    public enum ArrWebhookOutcome
    {
        /// <summary>Accepted (204): a re-read was asked for.</summary>
        Accepted,
        /// <summary>Unknown instance, no secret set up, or the wrong secret (401).</summary>
        Unauthorized,
        /// <summary>Too many calls (429).</summary>
        RateLimited,
        /// <summary>Not a JSON object (400).</summary>
        Invalid,
    }

    /// <summary>Admin view of an instance's webhook traffic since JE started.</summary>
    public sealed class ArrWebhookStats
    {
        /// <summary>Events accepted.</summary>
        public long Accepted { get; init; }

        /// <summary>Calls refused (wrong secret, rate limit, bad body).</summary>
        public long Refused { get; init; }

        /// <summary>When the last event was accepted.</summary>
        public DateTimeOffset? LastEventAt { get; init; }

        /// <summary>Its type (Grab, Download, Test, ...).</summary>
        public string? LastEventType { get; init; }

        /// <summary>When the arr's Test event last arrived.</summary>
        public DateTimeOffset? LastTestAt { get; init; }
    }

    /// <summary>
    /// The receiving end of the arrs' Connect → Webhook notifications. Each instance has its own
    /// shared secret (kept in the secrets store, sent by the arr in <see cref="SecretHeader"/>),
    /// compared in constant time. Authenticated calls are rate-limited per instance; failed calls per
    /// source address and all together. The payload is never trusted as data: only its event type
    /// and title ids are read, to choose what to re-read from the arr (the route's instance id is
    /// trusted; the payload's instance name and URL are not).
    /// </summary>
    public sealed class ArrWebhookReceiver
    {
        /// <summary>The header the arr sends the secret in.</summary>
        public const string SecretHeader = "X-JE-Hook-Secret";

        /// <summary>Secrets store name prefix (followed by the instance id).</summary>
        public const string SecretPrefix = "arrhook:";

        /// <summary>Largest body read.</summary>
        public const int MaxBodyBytes = 1024 * 1024;

        private const int MaxTitleIds = 50;

        /// <summary>Most source addresses whose failures are tracked at once.</summary>
        internal const int MaxFailureSources = 4096;

        private readonly ArrInstanceRegistry _registry;
        private readonly Func<SecretsStore?> _secrets;
        private readonly ArrLiveRouter _router;
        private readonly Func<DateTimeOffset> _now;
        private readonly TokenBucket _all;
        private readonly ConcurrentDictionary<string, TokenBucket> _perInstance = new(StringComparer.OrdinalIgnoreCase);
        private readonly ConcurrentDictionary<string, TokenBucket> _failuresPerSource = new(StringComparer.Ordinal);
        private readonly ConcurrentDictionary<string, Counters> _stats = new(StringComparer.OrdinalIgnoreCase);

        /// <summary>Creates the receiver (DI).</summary>
        public ArrWebhookReceiver(ArrInstanceRegistry registry, ArrLiveRouter router)
            : this(registry, () => JellyfinEnhanced.Instance?.Secrets, router, null)
        {
        }

        /// <summary>Creates the receiver with explicit sources (tests).</summary>
        internal ArrWebhookReceiver(ArrInstanceRegistry registry, Func<SecretsStore?> secrets, ArrLiveRouter router, Func<DateTimeOffset>? now)
        {
            _registry = registry;
            _secrets = secrets;
            _router = router;
            _now = now ?? (() => DateTimeOffset.UtcNow);
            _all = new TokenBucket(200, 50, _now);
        }

        /// <summary>The secrets store name of an instance's webhook secret.</summary>
        public static string SecretName(string instanceId) => SecretPrefix + instanceId;

        /// <summary>True when the instance has a webhook secret (JE accepts its webhooks).</summary>
        public bool HasSecret(string instanceId) => !string.IsNullOrEmpty(_secrets()?.Get(SecretName(instanceId)));

        /// <summary>
        /// The instance's secret, created (256 random bits) when it has none. Get-or-create is one
        /// step under the store's lock, so two callers always get the same secret. Throws when the
        /// store can't be written.
        /// </summary>
        public string EnsureSecret(string instanceId)
        {
            var store = _secrets() ?? throw new SecretsStoreUnavailableException("The secrets store is not available.");
            var name = SecretName(instanceId);
            string? result = null;
            store.Update(values =>
            {
                if (values.TryGetValue(name, out var existing) && !string.IsNullOrEmpty(existing))
                {
                    result = existing;
                    return false;
                }
                result = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
                values[name] = result;
                return true;
            });
            return result!;
        }

        /// <summary>Forgets an instance's secret (its webhooks are refused from then on). True if one existed.</summary>
        public bool RemoveSecret(string instanceId) => _secrets()?.Remove(SecretName(instanceId)) == true;

        /// <summary>When this receiver started (the reference for "silent" before any event arrived).</summary>
        public DateTimeOffset StartedAt { get; } = DateTimeOffset.UtcNow;

        /// <summary>
        /// True when an instance's webhook is set up (a secret exists) but has sent nothing for a day
        /// while the arr's history shows imports since then: the arr isn't delivering to Jellyfin.
        /// </summary>
        public bool IsSilent(string instanceId, ArrHistorySnapshot? history, DateTimeOffset now)
            => HasSecret(instanceId) && Silent(Stats(instanceId), history, StartedAt, now);

        /// <summary>The "silent" rule of <see cref="IsSilent"/>, on given facts.</summary>
        internal static bool Silent(ArrWebhookStats stats, ArrHistorySnapshot? history, DateTimeOffset startedAt, DateTimeOffset now)
        {
            var since = stats.LastEventAt ?? startedAt;
            if (now - since < TimeSpan.FromHours(24)) return false;
            return history != null && history.Records.Any(r => r.Date is DateTime d && d > since.UtcDateTime
                && (r.EventType ?? string.Empty).EndsWith("Imported", StringComparison.OrdinalIgnoreCase));
        }

        /// <summary>Traffic counters of an instance.</summary>
        public ArrWebhookStats Stats(string instanceId)
        {
            if (!_stats.TryGetValue(instanceId, out var c)) return new ArrWebhookStats();
            lock (c)
            {
                return new ArrWebhookStats
                {
                    Accepted = c.Accepted,
                    Refused = c.Refused,
                    LastEventAt = c.LastEventAt,
                    LastEventType = c.LastEventType,
                    LastTestAt = c.LastTestAt,
                };
            }
        }

        /// <summary>
        /// Checks and handles one webhook call. <paramref name="source"/> identifies the caller for
        /// the failure rate limit (its address). The secret is checked first: a caller with the
        /// right secret is limited only per instance, so failures from the same address (everyone
        /// behind one proxy) never lock the arr out. Failed calls are limited per address and all
        /// together. Never throws on bad input.
        /// </summary>
        public ArrWebhookOutcome Receive(string? instanceId, string? secret, ReadOnlySpan<byte> body, string? source)
        {
            var connection = _registry.Get(instanceId);
            var expected = connection == null ? null : _secrets()?.Get(SecretName(connection.Id));
            if (connection == null || string.IsNullOrEmpty(expected) || !SecretsMatch(secret, expected))
            {
                // A source (or everyone together) that keeps failing gets 429 instead of 401.
                if (!TakeFailure(source ?? "unknown") || !_all.TryTake()) return Refuse(connection?.Id, ArrWebhookOutcome.RateLimited);
                return Refuse(connection?.Id, ArrWebhookOutcome.Unauthorized);
            }

            var bucket = _perInstance.GetOrAdd(connection.Id, _ => new TokenBucket(60, 2, _now));
            if (!bucket.TryTake()) return Refuse(connection.Id, ArrWebhookOutcome.RateLimited);

            if (!TryReadHint(connection.Kind, body, out var eventType, out var kinds, out var titleIds))
            {
                return Refuse(connection.Id, ArrWebhookOutcome.Invalid);
            }

            var counters = _stats.GetOrAdd(connection.Id, _ => new Counters());
            lock (counters)
            {
                counters.Accepted++;
                counters.LastEventAt = _now();
                counters.LastEventType = eventType;
                if (eventType == "Test") counters.LastTestAt = counters.LastEventAt;
            }
            if (connection.Usable && (kinds != ArrLiveKinds.None || titleIds.Count > 0)) _router.Hint(connection.Id, kinds, titleIds);
            return ArrWebhookOutcome.Accepted;
        }

        /// <summary>
        /// Takes one failure from the source's budget; false when it is used up. The map of sources
        /// is bounded: when full, sources whose budget has refilled are forgotten (a forgotten one
        /// would start full anyway), and a new source finding it still full counts as used up, so
        /// rotating addresses can never reset anyone's budget.
        /// </summary>
        private bool TakeFailure(string source)
        {
            if (!_failuresPerSource.TryGetValue(source, out var bucket))
            {
                if (_failuresPerSource.Count >= MaxFailureSources)
                {
                    foreach (var (key, b) in _failuresPerSource)
                    {
                        if (b.Full()) _failuresPerSource.TryRemove(key, out _);
                    }
                    if (_failuresPerSource.Count >= MaxFailureSources) return false;
                }
                bucket = _failuresPerSource.GetOrAdd(source, _ => new TokenBucket(10, 0.2, _now));
            }
            return bucket.TryTake();
        }

        /// <summary>Constant-time comparison (of SHA-256 digests, so the length leaks nothing either).</summary>
        internal static bool SecretsMatch(string? given, string expected)
        {
            if (string.IsNullOrEmpty(given)) return false;
            var a = SHA256.HashData(Encoding.UTF8.GetBytes(given));
            var b = SHA256.HashData(Encoding.UTF8.GetBytes(expected));
            return CryptographicOperations.FixedTimeEquals(a, b);
        }

        /// <summary>
        /// What an event asks JE to re-read: its type, the snapshots, and the arr ids of the titles
        /// (movie or series) it names. False when the body is not a JSON object with an event type.
        /// </summary>
        internal static bool TryReadHint(ArrKind kind, ReadOnlySpan<byte> body, out string eventType, out ArrLiveKinds kinds, out IReadOnlyList<int> titleIds)
        {
            eventType = string.Empty;
            kinds = ArrLiveKinds.None;
            titleIds = Array.Empty<int>();
            if (body.Length == 0 || body.Length > MaxBodyBytes) return false;
            JsonDocument doc;
            try
            {
                var reader = new Utf8JsonReader(body, new JsonReaderOptions { MaxDepth = 32 });
                if (!JsonDocument.TryParseValue(ref reader, out var parsed) || parsed == null) return false;
                doc = parsed;
            }
            catch (JsonException)
            {
                return false;
            }
            using (doc)
            {
                var root = doc.RootElement;
                if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("eventType", out var t) || t.ValueKind != JsonValueKind.String) return false;
                var type = t.GetString() ?? string.Empty;
                eventType = type.Length > 40 ? type[..40] : type;

                var ids = new List<int>();
                void AddId(JsonElement parent, string name)
                {
                    if (parent.TryGetProperty(name, out var obj) && obj.ValueKind == JsonValueKind.Object
                        && obj.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.Number && id.TryGetInt32(out var v) && v > 0 && ids.Count < MaxTitleIds) ids.Add(v);
                }
                AddId(root, kind == ArrKind.Radarr ? "movie" : "series");

                kinds = type switch
                {
                    "Test" => ArrLiveKinds.None,
                    "Grab" => ArrLiveKinds.Queue | ArrLiveKinds.History,
                    "Download" => ArrLiveKinds.Queue | ArrLiveKinds.History,
                    "ManualInteractionRequired" => ArrLiveKinds.Queue,
                    "MovieFileDelete" or "EpisodeFileDelete" or "Rename" => ArrLiveKinds.History,
                    "MovieAdded" or "SeriesAdd" or "MovieDelete" or "SeriesDelete" => ArrLiveKinds.None,
                    "Health" or "HealthRestored" or "ApplicationUpdate" => ArrLiveKinds.System,
                    _ => ArrLiveKinds.Queue | ArrLiveKinds.History,
                };
                // Titles are re-read when their files or their existence changed.
                var rereadTitle = type is "Download" or "MovieFileDelete" or "EpisodeFileDelete" or "Rename"
                    or "MovieAdded" or "SeriesAdd" or "MovieDelete" or "SeriesDelete";
                titleIds = rereadTitle ? ids : Array.Empty<int>();
                return true;
            }
        }

        private ArrWebhookOutcome Refuse(string? instanceId, ArrWebhookOutcome outcome)
        {
            // Counted only for instances that exist (never a map entry per guessed id).
            if (instanceId != null && _registry.Get(instanceId) is { } c)
            {
                var counters = _stats.GetOrAdd(c.Id, _ => new Counters());
                lock (counters) counters.Refused++;
            }
            return outcome;
        }

        private sealed class Counters
        {
            public long Accepted;
            public long Refused;
            public DateTimeOffset? LastEventAt;
            public string? LastEventType;
            public DateTimeOffset? LastTestAt;
        }

        /// <summary>A token bucket: <c>capacity</c> calls at once, refilled at <c>perSecond</c>.</summary>
        internal sealed class TokenBucket
        {
            private readonly double _capacity;
            private readonly double _perSecond;
            private readonly Func<DateTimeOffset> _now;
            private readonly object _gate = new();
            private double _tokens;
            private DateTimeOffset _at;

            public TokenBucket(double capacity, double perSecond, Func<DateTimeOffset> now)
            {
                _capacity = capacity;
                _perSecond = perSecond;
                _now = now;
                _tokens = capacity;
                _at = now();
            }

            public bool TryTake()
            {
                lock (_gate)
                {
                    Refill();
                    if (_tokens < 1) return false;
                    _tokens -= 1;
                    return true;
                }
            }

            public bool Full()
            {
                lock (_gate)
                {
                    Refill();
                    return _tokens >= _capacity;
                }
            }

            private void Refill()
            {
                var now = _now();
                var elapsed = (now - _at).TotalSeconds;
                if (elapsed > 0) _tokens = Math.Min(_capacity, _tokens + (elapsed * _perSecond));
                _at = now;
            }
        }
    }
}
