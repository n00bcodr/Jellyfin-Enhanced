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
        /// <summary>
        /// True when two inputs ask for some of the same part of a title in the same edition: the movie; a season both
        /// name (whole seasons, next season, "keep getting"); an episode one names in a season the other names whole;
        /// an episode both name.
        /// </summary>
        internal bool Overlaps(MutationInput other)
        {
            if (Key != other.Key || Variant != other.Variant) return false;
            if (Scope == "movie" || other.Scope == "movie") return Scope == other.Scope;
            if (Scope == "episodes" && other.Scope == "episodes") return Episodes.Intersect(other.Episodes).Any();
            if (Scope == "episodes") return Episodes.Any(e => other.Seasons.Contains(e.Season));
            if (other.Scope == "episodes") return other.Episodes.Any(e => Seasons.Contains(e.Season));
            return Seasons.Intersect(other.Seasons).Any() || (Scope == "future" && other.Scope == "future");
        }
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
    /// <summary>
    /// Family Search payload: the title key in scope (a movie, or a series alone, with a season, or with a season and an episode),
    /// one idempotency key per press, and (from a season page) what the control was drawn to do (<see cref="PressIntent"/>).
    /// </summary>
    public sealed record RequestSearchBody(string? Key, string? IdempotencyKey, PressIntent? Expect = null);
    /// <summary>
    /// Create payload; the id is scoped to the signed-in requester. <c>Expect</c>: from a season page, what the control was
    /// drawn to do; the server works it out again right before recording the ask and refuses any difference (409 <c>press_changed</c>).
    /// </summary>
    public sealed record CreateRequest(string ClientRequestId, MutationInput Input, PressIntent? Expect = null)
    {
        /// <summary>
        /// What the caller asks to do with it (server-only): null for a person's ask, <c>add</c> for an administrator's add from
        /// the Manage drawer. Part of the request's identity under the person's key, never a key prefix of its own.
        /// </summary>
        [JsonIgnore] internal string? Operation { get; init; }

        /// <summary>
        /// The complete identity of the request as it was made (D53, edition round 22; set by the request service before
        /// anything is checked): every field of its input (routing included) and of its press, and its operation. The ledger
        /// remembers the client id by it; the same id with anything else is a conflict.
        /// </summary>
        [JsonIgnore] internal string? Identity { get; init; }
    }
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
        /// <summary>
        /// Outcome <c>split</c>: the ask crossed the household's series threshold, so the seasons that still fit under it
        /// went ahead (<see cref="RequestId"/>) and only the rest waits for an OK as its own request (this id).
        /// </summary>
        [JsonPropertyName("heldRequestId"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? HeldRequestId { get; init; }
        /// <summary>Outcome <c>split</c>: the season numbers that wait for an OK.</summary>
        [JsonPropertyName("heldSeasons"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int[]? HeldSeasons { get; init; }
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
        /// <summary>
        /// Seerr mode: Seerr takes a request for the whole series only (its partial-request setting is off), so the request
        /// controls offer the whole series. Single episodes are never sent to Seerr: they are asked for as their seasons.
        /// </summary>
        [JsonPropertyName("seerrWholeSeries")] public bool SeerrWholeSeries { get; init; }
        /// <summary>
        /// The administrator's "Only allow requesting one season at a time" (Seerr tab) applies: an ask covers one season
        /// (or episodes of one season). In Seerr mode only while Seerr takes partial requests, as Seerr's own season picker.
        /// </summary>
        [JsonPropertyName("singleSeason")] public bool SingleSeason { get; init; }
        /// <summary>Episodes a Member gets free per window before each five count as one request.</summary>
        [JsonPropertyName("freeEpisodes")] public int FreeEpisodes { get; init; } = 5;
        /// <summary>Asking for a new movie is paused for storage (null: it isn't); see <see cref="RequestBlock"/>.</summary>
        [JsonPropertyName("pausedMovies")] public RequestBlock? PausedMovies { get; init; }
        /// <summary>Asking for a new series is paused for storage (null: it isn't); see <see cref="RequestBlock"/>.</summary>
        [JsonPropertyName("pausedSeries")] public RequestBlock? PausedSeries { get; init; }
    }
    /// <summary>
    /// Why someone whose role may ask can't ask for a title right now, shown where Get it / Request would be instead
    /// of leaving nothing to do: <c>low_disk</c> ("Paused: storage full": the drive the download would land on is
    /// below the low-disk threshold), or the policy's refusal code when the instance it would go to can't take it
    /// (<c>instance_changed</c>, <c>invalid_instance</c>, <c>invalid_defaults</c>). Administrators also get where
    /// and how much is free; nobody else ever gets an instance name, a path or a size.
    /// </summary>
    public sealed record RequestBlock
    {
        /// <summary>Refusal code.</summary>
        [JsonPropertyName("reason")] public string Reason { get; init; } = string.Empty;
        /// <summary>Administrators: the instance name.</summary>
        [JsonPropertyName("instance"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Instance { get; init; }
        /// <summary>Administrators: the folder measured, as the arr names it.</summary>
        [JsonPropertyName("folder"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Folder { get; init; }
        /// <summary>Administrators: free bytes of the drive holding it.</summary>
        [JsonPropertyName("free"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public long? Free { get; init; }
        /// <summary>Administrators: whole percent of that drive that is free.</summary>
        [JsonPropertyName("freePercent"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? FreePercent { get; init; }
        /// <summary>Administrators: the low-disk threshold (percent free) it is below.</summary>
        [JsonPropertyName("limitPercent"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? LimitPercent { get; init; }

        /// <summary>The refusals shown in place of the request controls (anything else keeps today's behaviour).</summary>
        private static readonly HashSet<string> Shown = new(StringComparer.Ordinal) { "low_disk", "instance_changed", "invalid_instance", "invalid_defaults" };

        /// <summary>
        /// What a person is told for policy facts that refuse a title: null when nothing refuses, the role can't
        /// ask anyway (nothing to show), or the refusal is one the request controls don't explain (feature off, not
        /// visible, a change under way).
        /// </summary>
        /// <param name="facts">The policy's facts for the title.</param>
        public static RequestBlock? Of(RequestPolicyFacts facts)
            => facts.Refusal is { } refusal && facts.CanCreate && Shown.Contains(refusal)
                ? refusal == "low_disk" ? Storage(facts.Disk, facts.Role == "Admin") : new RequestBlock { Reason = refusal }
                : null;

        /// <summary>A storage pause; the instance, folder and sizes only for administrators.</summary>
        /// <param name="disk">The low-disk facts (null: none known, no block).</param>
        /// <param name="admin">The caller is a Jellyfin administrator.</param>
        public static RequestBlock? Storage(RequestDiskFacts? disk, bool admin)
            => disk == null ? null : admin
                ? new RequestBlock { Reason = "low_disk", Instance = disk.Instance, Folder = disk.Folder, Free = disk.Free, FreePercent = disk.FreePercent, LimitPercent = disk.LimitPercent }
                : new RequestBlock { Reason = "low_disk" };
    }
    /// <summary>A title's request answer for one person: may they ask for it now, and if not, why (see <see cref="RequestBlock"/>).</summary>
    public sealed record RequestTitleCheck
    {
        /// <summary>Title key checked.</summary>
        [JsonPropertyName("key")] public string Key { get; init; } = string.Empty;
        /// <summary>Edition checked: standard or 4k.</summary>
        [JsonPropertyName("variant")] public string Variant { get; init; } = "standard";
        /// <summary>The caller may ask for it now.</summary>
        [JsonPropertyName("canRequest")] public bool CanRequest { get; init; }
        /// <summary>Why not, when the controls should say so (null otherwise).</summary>
        [JsonPropertyName("blocked")] public RequestBlock? Blocked { get; init; }
    }
    /// <summary>
    /// What a request's size estimate (GB accounting) is worked out from, read from the library of the instance it goes to
    /// (in memory): the median size of a movie file there, of an episode file there, and for a series that instance holds,
    /// how many episodes each of its seasons has. A part that isn't known falls back to the fixed estimates.
    /// </summary>
    /// <param name="MovieGb">Median movie size on the instance (GB), when it holds enough movies with files.</param>
    /// <param name="EpisodeGb">Median episode file size on the instance (GB), when it holds enough series with files.</param>
    /// <param name="SeasonEpisodes">Episodes per season of the series asked for, when the instance holds it.</param>
    public sealed record RequestSizeHint(double? MovieGb = null, double? EpisodeGb = null, IReadOnlyDictionary<int, int>? SeasonEpisodes = null)
    {
        /// <summary>Episodes assumed in a season nothing describes.</summary>
        internal const int SeasonEpisodesAssumed = 10;

        /// <summary>
        /// The estimated size of <paramref name="input"/> in GB: a movie is the instance's median movie (else 8, 4K 40); an
        /// episode its median episode (else 1, 4K 4); a season its episodes (as the instance lists them, else 10) times that.
        /// An estimate, never a claim about actual disk use.
        /// </summary>
        /// <param name="input">The request (its scope and edition).</param>
        /// <param name="size">The instance's typical sizes, or null.</param>
        public static double Estimate(MutationInput input, RequestSizeHint? size)
        {
            var fourK = input.Variant == "4k";
            var episode = size?.EpisodeGb ?? (fourK ? 4 : 1);
            if (input.Scope == "movie") return size?.MovieGb ?? (fourK ? 40 : 8);
            if (input.Scope == "episodes") return input.Episodes.Length * episode;
            return input.Seasons.Sum(s => (size?.SeasonEpisodes != null && size.SeasonEpisodes.TryGetValue(s, out var n) && n > 0 ? n : SeasonEpisodesAssumed) * episode);
        }
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
