using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>The immutable, normalized scope confirmed by the caller. Folder/profile edits are admin-only.</summary>
    public sealed record MutationInput
    {
        /// <summary>Canonical title key, without a season or episode suffix.</summary>
        public string Key { get; init; } = string.Empty;
        /// <summary>movie, seasons, episodes, future, or next_season.</summary>
        public string Scope { get; init; } = "movie";
        /// <summary>standard or 4k.</summary>
        public string Variant { get; init; } = "standard";
        /// <summary>Explicit season numbers; future includes the current season.</summary>
        public int[] Seasons { get; init; } = Array.Empty<int>();
        /// <summary>Explicit episode coordinates.</summary>
        public RequestEpisode[] Episodes { get; init; } = Array.Empty<RequestEpisode>();
        /// <summary>Optional administrator-selected target.</summary>
        public string? InstanceId { get; init; }
        /// <summary>Optional administrator-selected quality profile.</summary>
        public int? ProfileId { get; init; }
        /// <summary>Optional administrator-selected root folder.</summary>
        public string? RootFolder { get; init; }
        /// <summary>Creates a stable canonical input, or null when invalid.</summary>
        public MutationInput? Normalize()
        {
            var key = TitleKey.Parse(Key);
            if (key == null || key.Season.HasValue || Variant is not ("standard" or "4k") ||
                Scope is not ("movie" or "seasons" or "episodes" or "future" or "next_season") ||
                Seasons == null || Episodes == null || Seasons.Length > 200 || Episodes.Length > 1000 ||
                Seasons.Any(s => s < 0 || s > 10000) || Episodes.Any(e => e == null || e.Season < 0 || e.Season > 10000 || e.Episode < 1 || e.Episode > 100000) ||
                InstanceId?.Length > 80 || RootFolder?.Length > 1024 || ProfileId is <= 0) return null;
            if (key.IsMovie != (Scope == "movie") || (Scope == "movie" && (Seasons.Length != 0 || Episodes.Length != 0)) ||
                (Scope == "episodes" && (Episodes.Length == 0 || Seasons.Length != 0)) ||
                (Scope is "seasons" or "future" or "next_season" && (Seasons.Length == 0 || Episodes.Length != 0)) ||
                (Scope is "future" or "next_season" && Seasons.Distinct().Count() != 1)) return null;
            return this with { Key = key.ToString(), Seasons = Seasons.Distinct().OrderBy(s => s).ToArray(), Episodes = Episodes.Distinct().OrderBy(e => e.Season).ThenBy(e => e.Episode).ToArray() };
        }
        /// <summary>Canonical JSON preserved in the job.</summary>
        [JsonIgnore] public string Canonical => JsonSerializer.Serialize(this);
        /// <summary>Fingerprint of the confirmed input.</summary>
        [JsonIgnore] public string Fingerprint => Hash(Canonical);
        internal static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
        internal IEnumerable<int> SeasonNumbers => Scope == "episodes" ? Episodes.Select(e => e.Season).Distinct() : Seasons;
        internal bool Covers(RequestEpisode episode) => Seasons.Contains(episode.Season) || Episodes.Contains(episode);
        internal MutationInput? Extra(IEnumerable<MutationInput> covered)
        {
            var all = covered.Where(c => c.Key == Key && c.Variant == Variant && (InstanceId == null || c.InstanceId == null || c.InstanceId == InstanceId)).ToArray();
            if (Scope == "movie") return all.Length == 0 ? this : null;
            if (Scope == "episodes")
            {
                var extra = Episodes.Where(e => !all.Any(c => c.Covers(e))).ToArray();
                return extra.Length == 0 ? null : this with { Episodes = extra };
            }
            var seasons = Seasons.Where(s => !all.Any(c => c.Seasons.Contains(s))).ToArray();
            if (Scope == "future" && !all.Any(c => c.Scope == "future")) return this with { Seasons = seasons.Length == 0 ? Seasons : seasons };
            return seasons.Length == 0 ? null : this with { Seasons = seasons };
        }
    }
    /// <summary>Where a want came from: a person's ask (the default), a recipe, or an import from Seerr.</summary>
    /// <param name="Kind">interactive, automation, or seerr_import.</param>
    /// <param name="Source">The recipe name, or the JE-assigned Seerr source id for imports.</param>
    public sealed record RequestOrigin(string Kind, string? Source = null)
    {
        /// <summary>A recipe acting on a person's behalf (auto season, auto movie).</summary>
        public const string AutomationKind = "automation";
        /// <summary>A request imported from Seerr during the authority transfer.</summary>
        public const string SeerrImportKind = "seerr_import";
        /// <summary>An automation origin for one recipe.</summary>
        public static RequestOrigin Automation(string recipe) => new(AutomationKind, recipe);
    }
    /// <summary>A single episode coordinate.</summary>
    public sealed record RequestEpisode(int Season, int Episode);
    /// <summary>Family Search payload: the title key in scope (a movie, or a series with a season and an episode) and one idempotency key per press.</summary>
    public sealed record RequestSearchBody(string? Key, string? IdempotencyKey);
    /// <summary>Create payload; the id is scoped to the signed-in requester.</summary>
    public sealed record CreateRequest(string ClientRequestId, MutationInput Input);
    /// <summary>Approval edits; omitted input preserves the confirmed scope.</summary>
    public sealed record ApproveRequest(MutationInput? Input = null);
    /// <summary>A decline explanation shown to the requester as plain text.</summary>
    public sealed record DeclineRequest(string Reason);
    /// <summary>Bulk approval is bounded and each row is independently authorized.</summary>
    public sealed record BulkApproveRequest(string[] Ids);
    /// <summary>A durable request and its private backend context. API responses project this record.</summary>
    /// <remarks><c>OriginKind</c> is where the intent came from (interactive, automation or seerr_import).</remarks>
    public sealed record RequestWant(string Id, string AcquisitionId, Guid UserId, string ClientRequestId, string Fingerprint,
        MutationInput Input, string Status, string Reason, int Cost, string ParentalSignature, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, bool Follower = false, MutationInput? OwnedInput = null, string TargetKey = "", string OriginKind = "interactive");
    /// <summary>
    /// Authorization facts captured at approval, never returned to a browser. <c>SeerrSeasons</c> (and <c>SeerrUser</c>
    /// when approval didn't know it) are bound right before a Seerr request is sent: the exact seasons and account it
    /// went out with, so a later read-back looks for exactly that.
    /// </summary>
    public sealed record RequestAuthorization(Guid Requester, Guid? Approver, string Action, string Scope, string Variant,
        string Backend, string InstanceId, string ConnectionGeneration, string PolicyRevision, string? SeerrSource = null,
        int? SeerrUser = null, long SeerrPermissions = 0, bool Edited = false, int[]? SeerrSeasons = null);
    /// <summary>One scope that went out to a target (see <see cref="RequestLedger.Dispatches"/>).</summary>
    /// <param name="TargetKey">The backend target it went to.</param>
    /// <param name="Input">The scope that went out.</param>
    /// <param name="At">When it went out: the send was confirmed, or (a request moved from Seerr) it was asked for there.</param>
    public sealed record RequestDispatch(string TargetKey, MutationInput Input, DateTimeOffset At);
    /// <summary>One durable upstream action. <c>Uncertain</c>: its last outcome left the upstream state unknown (maybe or partly sent).</summary>
    public sealed record RequestJob(string Id, string WantId, MutationInput Input, RequestAuthorization Authorization,
        string State, int Attempts, DateTimeOffset NextAttempt, string Reason, string IdempotencyKey, string Fingerprint, bool Uncertain = false);
    /// <summary>The request API outcome contract; messages are safe household wording.</summary>
    public sealed record RequestOutcome
    {
        /// <summary>Outcome name.</summary>
        [JsonPropertyName("outcome")] public string Outcome { get; init; } = "accepted";
        /// <summary>Stable reason code.</summary>
        [JsonPropertyName("reason")] public string Reason { get; init; } = "awaiting_approval";
        /// <summary>Action certainty.</summary>
        [JsonPropertyName("certainty"), JsonConverter(typeof(JsonStringEnumConverter))] public ArrActionStatus Certainty { get; init; } = ArrActionStatus.Succeeded;
        /// <summary>Safe display text.</summary>
        [JsonPropertyName("message")] public string Message { get; init; } = "Asked! We'll let you know.";
        /// <summary>Want id, when recorded.</summary>
        [JsonPropertyName("requestId")] public string? RequestId { get; init; }
        /// <summary>HTTP status of this outcome.</summary>
        [JsonIgnore] public int HttpStatus { get; init; } = 201;
        /// <summary>Constructs a success result.</summary>
        public static RequestOutcome Accepted(string id, string reason, int status = 201) => new() { RequestId = id, Reason = reason, HttpStatus = status };
        /// <summary>Constructs a refusal, conflict, or retryable failure.</summary>
        public static RequestOutcome Refused(string reason, int status = 403, string outcome = "denied") => new()
        {
            Outcome = outcome, Reason = reason, HttpStatus = status,
            Certainty = status == 503 ? ArrActionStatus.Failed : ArrActionStatus.Rejected,
            Message = status == 503 ? "Couldn't ask right now. Try again later." : status == 429 ? "You've used this week's requests." : "This one can't be asked for here.",
        };
    }
    /// <summary>
    /// The caller's own request capabilities, for the request controls (Request, Get it, the request
    /// sheet). Never another person's; no instance, profile, folder or Seerr detail.
    /// </summary>
    public sealed record RequestCapabilities
    {
        /// <summary>The caller's household role: watcher, kid, member, manager or admin.</summary>
        [JsonPropertyName("role")] public string Role { get; init; } = "watcher";
        /// <summary>The caller may ask for titles at all (role and request backend): movies, series or both.</summary>
        [JsonPropertyName("canRequest")] public bool CanRequest { get; init; }
        /// <summary>The caller may ask for movies (in Seerr mode Seerr's per-kind request permissions decide).</summary>
        [JsonPropertyName("canRequestMovies")] public bool CanRequestMovies { get; init; }
        /// <summary>The caller may ask for series (in Seerr mode Seerr's per-kind request permissions decide).</summary>
        [JsonPropertyName("canRequestSeries")] public bool CanRequestSeries { get; init; }
        /// <summary>The caller may approve other people's asks.</summary>
        [JsonPropertyName("canApprove")] public bool CanApprove { get; init; }
        /// <summary>The caller's asks always wait for an OK (Kid, or the Approve everything preset).</summary>
        [JsonPropertyName("asksFirst")] public bool AsksFirst { get; init; }
        /// <summary>The caller may ask for 4K movies.</summary>
        [JsonPropertyName("can4kMovies")] public bool Can4kMovies { get; init; }
        /// <summary>The caller may ask for 4K series.</summary>
        [JsonPropertyName("can4kSeries")] public bool Can4kSeries { get; init; }
        /// <summary>Request authority: je or seerr.</summary>
        [JsonPropertyName("backend")] public string Backend { get; init; } = "seerr";
        /// <summary>What the household calls the person who OKs requests (empty: the client's neutral word).</summary>
        [JsonPropertyName("contact")] public string Contact { get; init; } = string.Empty;
        /// <summary>Episodes a Member gets free per window before each five count as one request.</summary>
        [JsonPropertyName("freeEpisodes")] public int FreeEpisodes { get; init; } = 5;
    }
    /// <summary>A quota charge; expiries use a strict rolling window.</summary>
    public sealed record QuotaCharge(int Cost, DateTimeOffset At, double EstimatedGb = 0, string? WantId = null);
    /// <summary>Quota projection, including the next time a usable slot returns.</summary>
    public sealed record QuotaProjection(
        [property: JsonPropertyName("used")] int Used,
        [property: JsonPropertyName("limit")] int? Limit,
        [property: JsonPropertyName("remaining")] int? Remaining,
        [property: JsonPropertyName("nextSlotAt")] DateTimeOffset? NextSlotAt,
        [property: JsonPropertyName("usedGb")] double UsedGb,
        [property: JsonPropertyName("available")] bool Available = true,
        [property: JsonPropertyName("episodes"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? Episodes = null);
    /// <summary>Pure projection of timestamped charges; it does no I/O.</summary>
    public static class QuotaProjector
    {
        /// <summary>Projects a complete ledger. A lowered limit walks enough expiries to free one slot.</summary>
        public static QuotaProjection Project(IEnumerable<QuotaCharge> charges, int? limit, TimeSpan window, DateTimeOffset now, bool complete = true)
        {
            if (!complete) return new(0, limit, null, null, 0, false);
            var active = charges.Where(c => c.At > now - window && c.At <= now && c.Cost >= 0).OrderBy(c => c.At).ToArray();
            var used = active.Sum(c => c.Cost);
            var left = used;
            DateTimeOffset? next = null;
            foreach (var group in active.Where(c => c.Cost > 0).GroupBy(c => c.At))
            {
                left -= group.Sum(c => c.Cost);
                if (!limit.HasValue || used < limit.Value || left < limit.Value) { next = group.Key + window; break; }
            }
            return new(used, limit, limit.HasValue ? Math.Max(0, limit.Value - used) : null, next, active.Sum(c => c.EstimatedGb));
        }
    }
}
