using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>
    /// What a season page's control was drawn to do (D53, edition round 19: the server decides every press), sent with the
    /// press: the season page it sits on, its mode, the exact episodes (and, for an ask Seerr takes as whole seasons, the
    /// exact seasons and the whole-series policy it was drawn under), the copy it acts for, the edition, and where it lands
    /// (an opaque destination token for an ask, the instance for an administrator's Search). The server works every part out
    /// again, fresh, right before it records or sends anything, and refuses any difference (<see cref="PressChecks"/>).
    /// </summary>
    public sealed record PressIntent
    {
        /// <summary>The season page item the control was drawn on (32 hex digits).</summary>
        [JsonPropertyName("item")] public string? Item { get; init; }

        /// <summary>get (an ask) or search.</summary>
        [JsonPropertyName("mode")] public string? Mode { get; init; }

        /// <summary>The episode numbers of that season the control names.</summary>
        [JsonPropertyName("episodes")] public int[]? Episodes { get; init; }

        /// <summary>The copy binding's role it acts for (standard, 4k, …); null: a title-wide control.</summary>
        [JsonPropertyName("copy")] public string? Copy { get; init; }

        /// <summary>The edition it names: standard or 4k.</summary>
        [JsonPropertyName("variant")] public string? Variant { get; init; }

        /// <summary>Where an ask under the binding lands, as the page was told (<see cref="PressChecks.DestinationToken"/>).</summary>
        [JsonPropertyName("dest")] public string? Dest { get; init; }

        /// <summary>An administrator's Search: the instance it runs on.</summary>
        [JsonPropertyName("instance")] public string? Instance { get; init; }

        /// <summary>Seerr mode: the control was drawn while Seerr took whole-series requests only.</summary>
        [JsonPropertyName("whole")] public bool Whole { get; init; }

        /// <summary>Seerr mode: the exact seasons an ask the page rounded up to whole seasons names (null: not rounded).</summary>
        [JsonPropertyName("seasons")] public int[]? Seasons { get; init; }
    }

    /// <summary>The server's fresh answer to a press (<see cref="ArrStatusService.PressAsync"/>).</summary>
    /// <param name="Refusal">Null: still exactly what was drawn; else <c>press_changed</c> or <c>press_unverified</c>.</param>
    /// <param name="Command">
    /// The command the check resolved (D53, edition round 21: validation returns the command that executes): present exactly
    /// when <paramref name="Refusal"/> is null. It is the only thing the caller sends, records and fingerprints.
    /// </param>
    public sealed record PressProof(string? Refusal, PressCommand? Command = null)
    {
        /// <summary>The press no longer does what it was drawn to do.</summary>
        public static PressProof Changed { get; } = new(PressChecks.Changed);
    }

    /// <summary>
    /// What a season page's press does, as the server's check resolved it from the facts it read for the check (D53, edition
    /// round 21: one immutable object is checked, executed, recorded and fingerprinted; nothing chosen before the check
    /// survives into it): the route, the page and title, the season and its episode numbers (or, for a title-wide Seerr ask,
    /// its seasons), the copy and edition, where it lands (the instance; Seerr mode: none, Seerr picks) and, for a Search, the
    /// Sonarr series and episode ids of exactly those episodes on that instance, from the episode list read at the check.
    /// </summary>
    public sealed record PressCommand
    {
        /// <summary><see cref="PressChecks.Ask"/>, <see cref="PressChecks.Household"/> or <see cref="PressChecks.Admin"/>.</summary>
        public required string Route { get; init; }

        /// <summary>The season page item the press was made on.</summary>
        public required Guid Page { get; init; }

        /// <summary>The title, under the key the press named it by.</summary>
        public required TitleKey Title { get; init; }

        /// <summary>The season.</summary>
        public required int Season { get; init; }

        /// <summary>The episode numbers of that season the press names (sorted, distinct).</summary>
        public required IReadOnlyList<int> Episodes { get; init; }

        /// <summary>A title-wide Seerr ask's seasons (sorted, distinct); null for every other press.</summary>
        public IReadOnlyList<int>? Seasons { get; init; }

        /// <summary>The copy's role it acts for; null: a title-wide control.</summary>
        public string? Copy { get; init; }

        /// <summary>standard or 4k.</summary>
        public required string Edition { get; init; }

        /// <summary>The instance it lands on (an ask's target, a Search's Sonarr); null for a Seerr-mode ask (Seerr picks).</summary>
        public string? Instance { get; init; }

        /// <summary>The destination the press itself declared (an ask's token, an administrator's instance; none for a household Search).</summary>
        public string? Declared { get; init; }

        /// <summary>A Search: the Sonarr series id on <see cref="Instance"/>.</summary>
        public int? SeriesId { get; init; }

        /// <summary>A Search: the Sonarr episode ids it searches (exactly the episodes it names, or the subset it was asked to prove).</summary>
        public IReadOnlyList<int> EpisodeIds { get; init; } = Array.Empty<int>();

        /// <summary>
        /// The connection the check read <see cref="Instance"/> through (D53, edition round 22): the command is sent, recorded and
        /// read back only on it (<see cref="Arr.ArrClientFactory.Bound(Arr.ArrClient, bool)"/>). Server-only; null for a Seerr ask.
        /// </summary>
        [JsonIgnore]
        internal Arr.ArrClient? Connection { get; init; }

        /// <summary>True while <see cref="Connection"/> is still the instance's connection (the final gate before a write).</summary>
        [JsonIgnore]
        internal Func<bool>? StillBound { get; init; }

        /// <summary>The press's identity for a retry key (see <see cref="PressChecks.Fingerprint"/>).</summary>
        public string Fingerprint => PressChecks.Fingerprint(Route, Page, Title, Seasons != null ? "seasons:" + string.Join(",", Seasons) : Scope(Season, Episodes), Copy, Edition, Declared);

        /// <summary>The ask it records (an ask's command): exactly its episodes, or a title-wide Seerr ask's seasons; no routing field.</summary>
        public MutationInput AskInput() => Seasons != null
            ? new MutationInput { Key = Title.Title.ToString(), Scope = "seasons", Variant = Edition, Seasons = Seasons.ToArray() }
            : new MutationInput { Key = Title.Title.ToString(), Scope = "episodes", Variant = Edition, Episodes = Episodes.Select(e => new RequestEpisode(Season, e)).ToArray() };

        /// <summary>The scope words of a season's episodes in a fingerprint.</summary>
        internal static string Scope(int season, IEnumerable<int> episodes)
            => "episodes:" + season.ToString(System.Globalization.CultureInfo.InvariantCulture) + ":" + string.Join(",", episodes.Distinct().OrderBy(n => n));
    }

    /// <summary>The comparison of a press with the season page as the server works it out now (no I/O).</summary>
    internal static class PressChecks
    {
        /// <summary>The refusal of a press that no longer does what it was drawn to do (409; the page redraws and says so).</summary>
        public const string Changed = "press_changed";

        /// <summary>The refusal of a press whose facts couldn't be read again now (409; the page says nothing was sent).</summary>
        public const string Unverified = "press_unverified";

        /// <summary>The routes a press goes to.</summary>
        public const string Ask = "ask";

        /// <summary>A household Search.</summary>
        public const string Household = "household";

        /// <summary>An administrator's Search.</summary>
        public const string Admin = "admin";

        /// <summary>True for a press refusal (a typed conflict).</summary>
        public static bool IsRefusal(string? code) => code is Changed or Unverified or Conflict;

        /// <summary>
        /// The refusal of a retry key already used for another press (D53, edition round 21: a key replays only the identical
        /// press; 409, nothing is sent and the first press's receipt is not given).
        /// </summary>
        public const string Conflict = "idempotency_conflict";

        /// <summary>The household words of a press refusal.</summary>
        public static string Message(string code) => code switch
        {
            Unverified => "This couldn't be checked right now, so nothing was sent.",
            Conflict => "This repeats another press, so nothing was sent.",
            _ => "This changed since the page was shown, so nothing was sent.",
        };

        /// <summary>
        /// An opaque token for where an ask lands (the request target's instance id; Seerr mode has none, D80): the page echoes
        /// it with the press and learns nothing from it (instance ids are never given to anyone but administrators).
        /// </summary>
        public static string DestinationToken(string kind, string id)
            => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("je-press-destination|" + kind + "|" + id)), 0, 8).ToLowerInvariant();

        /// <summary>An episode that is simply not there with nothing under way for it (the page's isMissing).</summary>
        private static bool Missing(EpisodeStatus ep)
            => ep.Stage is StatusStage.Looking or StatusStage.NotHere && !ep.Attention && ep.Reason.Code is not (StatusReasonCode.ServiceDown or StatusReasonCode.Failed);

        /// <summary>
        /// Null when the press still does exactly what it was drawn to do on <paramref name="season"/> (the season page composed
        /// now for the viewer, its copy binding reached now); else <see cref="Changed"/>. <paramref name="input"/>: the ask
        /// sent (route <see cref="Ask"/>); <paramref name="wholeNow"/>: Seerr's whole-series policy read now (Seerr mode).
        /// </summary>
        public static string? Compare(PressIntent intent, string route, TitleStatus season, int seasonNumber, MutationInput? input, bool seerr, bool? wholeNow, bool admin)
            => Compare(intent, route, season, seasonNumber, input, seerr, wholeNow, admin, out _);

        /// <summary><see cref="Compare(PressIntent, string, TitleStatus, int, MutationInput?, bool, bool?, bool)"/>, with the copy binding the press is under now (null: title-wide).</summary>
        public static string? Compare(PressIntent intent, string route, TitleStatus season, int seasonNumber, MutationInput? input, bool seerr, bool? wholeNow, bool admin, out CopyBinding? binding)
        {
            binding = null;
            var numbers = (intent.Episodes ?? Array.Empty<int>()).Distinct().OrderBy(n => n).ToArray();
            if (numbers.Length == 0) return Changed;
            var eps = season.Episodes ?? Array.Empty<EpisodeStatus>();
            var named = new List<EpisodeStatus>();
            foreach (var n in numbers)
            {
                // Every episode it names is still missing with nothing under way for it (arrived, or now downloading: changed).
                if (eps.FirstOrDefault(e => e.Episode == n) is not { } ep || !Missing(ep)) return Changed;
                named.Add(ep);
            }
            // The binding its episodes are under now (the page's bindingOf: the first copy gap among them), and that it is the one
            // the control acted for (a title-wide control stays title-wide, a copy's stays that copy's).
            var gap = named.Select(e => e.CopyGap).FirstOrDefault(g => g != null);
            if (!string.Equals(gap, intent.Copy, StringComparison.Ordinal)) return Changed;
            var bound = gap == null ? null : season.Copy is { } copy && copy.Role == gap ? copy : new CopyBinding { Role = gap };
            binding = bound;
            switch (route)
            {
                case Ask:
                {
                    if (input == null || intent.Mode != "get" || !string.Equals(input.Variant, intent.Variant, StringComparison.Ordinal)) return Changed;
                    if (bound != null && !(bound.Ask && bound.Variant == intent.Variant && bound.Dest != null && string.Equals(bound.Dest, intent.Dest, StringComparison.Ordinal))) return Changed;
                    // A title-wide ask declares no destination of a copy (the page drew none).
                    if (bound == null && (intent.Variant != "standard" || intent.Dest != null)) return Changed;
                    if (seerr)
                    {
                        // Seerr takes whole seasons: the exact seasons it was drawn with, under the whole-series policy it was drawn under.
                        if (wholeNow == null) return Unverified;
                        if (wholeNow.Value != intent.Whole || input.Scope != "seasons" || intent.Seasons is not { Length: > 0 } seasons) return Changed;
                        if (!input.Seasons.OrderBy(s => s).SequenceEqual(seasons.Distinct().OrderBy(s => s))) return Changed;
                        if (!intent.Whole && !input.Seasons.SequenceEqual(new[] { seasonNumber })) return Changed;
                        if (intent.Whole && !input.Seasons.Contains(seasonNumber)) return Changed;
                        return null;
                    }
                    // JE mode: exactly its episodes of that season.
                    if (input.Scope != "episodes" || !input.Episodes.All(e => e.Season == seasonNumber)
                        || !input.Episodes.Select(e => e.Episode).OrderBy(e => e).SequenceEqual(numbers)) return Changed;
                    return null;
                }
                case Household:
                    if (intent.Mode != "search") return Changed;
                    return bound != null && !bound.Search ? Changed : null;
                case Admin:
                    if (intent.Mode != "search" || !admin) return Changed;
                    return bound != null && !string.Equals(bound.InstanceId, intent.Instance, StringComparison.OrdinalIgnoreCase) ? Changed : null;
                default:
                    return Changed;
            }
        }

        /// <summary>
        /// The command an administrator's Search from a season page runs (D53, edition round 20: the executed command IS the
        /// validated intent): the instance and the exact episodes of the season the press names, never the request's parallel
        /// fields. The request's own fields must say the same (the instance, a season key or one of its episodes, the episodes
        /// when given), or nothing runs: null (<see cref="Changed"/>).
        /// </summary>
        /// <param name="intent">The press.</param>
        /// <param name="instanceId">The request's instance.</param>
        /// <param name="key">The request's key.</param>
        /// <param name="episodes">The request's episodes (null: none named).</param>
        /// <returns>The instance, the season key and its episode numbers to search; null when the request says otherwise.</returns>
        public static (string Instance, TitleKey Season, int[] Episodes)? AdminCommand(PressIntent intent, string? instanceId, TitleKey key, int[]? episodes)
        {
            var numbers = (intent.Episodes ?? Array.Empty<int>()).Distinct().OrderBy(n => n).ToArray();
            if (intent.Mode != "search" || string.IsNullOrWhiteSpace(intent.Instance) || numbers.Length == 0 || numbers.Any(n => n < 1)) return null;
            if (!string.Equals(intent.Instance, instanceId, StringComparison.OrdinalIgnoreCase) || key.IsMovie || key.Season is not int season) return null;
            if (key.Episode is int one && !(numbers.Length == 1 && numbers[0] == one)) return null;
            if (episodes is { Length: > 0 } && !episodes.Distinct().OrderBy(n => n).SequenceEqual(numbers)) return null;
            return (intent.Instance!, key.Title.WithSeason(season), numbers);
        }

        /// <summary>
        /// A press's identity for a retry key (D53, edition round 21: a key replays only the identical press): the route, the page,
        /// the title, the scope (the season's episodes, or a title-wide Seerr ask's seasons), the copy, the edition and the
        /// destination the press declared. The check's command (<see cref="PressCommand.Fingerprint"/>) and the request before any
        /// check (<see cref="RequestFingerprint"/>) give the same text for the same press; any difference is another press.
        /// </summary>
        public static string Fingerprint(string route, Guid page, TitleKey title, string scope, string? copy, string edition, string? declared)
            => MutationInput.Hash(string.Join("\n", "press", route, page.ToString("N"), title.Title.ToString(), scope, copy ?? "-", edition, (declared ?? "-").ToLowerInvariant()));

        /// <summary>
        /// <see cref="Fingerprint"/> of a press as its request describes it, before anything is checked (a retry is matched by
        /// it): an ask by its (normalized) input, a Search by its key and the intent's episodes; null when the request names no
        /// page or title.
        /// </summary>
        public static string? RequestFingerprint(PressIntent intent, string route, TitleKey? key, MutationInput? input)
        {
            if (!Guid.TryParseExact(intent.Item, "N", out var page) || page == Guid.Empty) return null;
            var edition = intent.Variant ?? "standard";
            if (route == Ask)
            {
                if (input == null || TitleKey.Parse(input.Key) is not { } title) return null;
                var scope = input.Scope == "seasons" ? "seasons:" + string.Join(",", input.Seasons.Distinct().OrderBy(n => n))
                    : input.Episodes.Select(e => e.Season).Distinct().ToList() is [var season] ? PressCommand.Scope(season, input.Episodes.Select(e => e.Episode)) : "episodes:?";
                return Fingerprint(route, page, title, scope, intent.Copy, input.Variant, intent.Dest);
            }
            if (key == null || key.IsMovie || key.Season is not int searched) return null;
            return Fingerprint(route, page, key, PressCommand.Scope(searched, Numbers(key, intent)), intent.Copy, edition, route == Admin ? intent.Instance : null);
        }

        /// <summary>
        /// Every field of a press as one canonical text (D53, edition round 22: a retry key replays only the identical request):
        /// the page, mode, episodes, copy, edition, destination, instance, whole-series policy and seasons, in a fixed form.
        /// </summary>
        public static string Canonical(PressIntent intent)
            => JsonSerializer.Serialize(new
            {
                item = Guid.TryParseExact(intent.Item, "N", out var page) ? page.ToString("N") : intent.Item,
                mode = intent.Mode, episodes = (intent.Episodes ?? Array.Empty<int>()).Distinct().OrderBy(n => n).ToArray(),
                copy = intent.Copy, variant = intent.Variant, dest = intent.Dest?.ToLowerInvariant(), instance = intent.Instance?.ToLowerInvariant(),
                whole = intent.Whole, seasons = intent.Seasons?.Distinct().OrderBy(n => n).ToArray(),
            });

        // Schema-2 request receipts used this text. It is only a migration comparison, never a new request identity.
        private static string LegacyCanonical(PressIntent intent)
            => string.Join("\n", "intent",
                Guid.TryParseExact(intent.Item, "N", out var page) ? page.ToString("N") : (intent.Item ?? "-"),
                intent.Mode ?? "-",
                string.Join(",", (intent.Episodes ?? Array.Empty<int>()).Distinct().OrderBy(n => n)),
                intent.Copy ?? "-",
                intent.Variant ?? "-",
                (intent.Dest ?? "-").ToLowerInvariant(),
                (intent.Instance ?? "-").ToLowerInvariant(),
                intent.Whole ? "whole" : "part",
                intent.Seasons == null ? "-" : string.Join(",", intent.Seasons.Distinct().OrderBy(n => n)));

        /// <summary>
        /// The identity of a create request as it was made (see <see cref="CreateRequest.Identity"/>): a plain ask by its input
        /// alone (as before), anything else by its operation, its whole input (instance, profile and root folder included) and
        /// its whole press.
        /// </summary>
        public static string RequestIdentity(string? operation, PressIntent? intent, MutationInput normalized)
            => operation == null && intent == null ? normalized.Fingerprint
                : MutationInput.Hash(string.Join("\n", "request", operation ?? "ask", normalized.Canonical, intent == null ? "-" : Canonical(intent)));

        /// <summary>Complete incoming Search identity, separate from the checked command's execution fingerprint.</summary>
        public static string IncomingIdentity(string route, TitleKey key, PressIntent? intent, string? instance = null, int[]? episodes = null)
            => MutationInput.Hash(JsonSerializer.Serialize(new
            { route, key = key.ToString(), instance = instance?.ToLowerInvariant(), episodes = episodes?.Distinct().OrderBy(n => n).ToArray(), expect = intent == null ? null : Canonical(intent) }));

        internal static string LegacyRequestIdentity(string? operation, PressIntent? intent, MutationInput normalized)
            => operation == null && intent == null ? normalized.Fingerprint
                : MutationInput.Hash(string.Join("\n", "request", operation ?? "ask", normalized.Canonical, intent == null ? "-" : LegacyCanonical(intent)));

        /// <summary>The episode numbers of a season a search key names (one episode), or the intent's for a season key.</summary>
        public static IReadOnlyList<int> Numbers(TitleKey key, PressIntent? intent)
            => key.Episode is int one ? new[] { one } : (intent?.Episodes ?? Array.Empty<int>()).Distinct().OrderBy(n => n).ToArray();
    }
}
