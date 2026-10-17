using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Threading;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>
    /// One fixed condition's actions: what happens when the title matches it, and when it doesn't. Each is <c>none</c>
    /// (the condition says nothing), <c>approve</c> (goes ahead without an OK), <c>review</c> (waits for an OK) or
    /// <c>deny</c> (refused).
    /// </summary>
    public record HouseholdRuleActions
    {
        /// <summary>Action when the title matches.</summary>
        [JsonPropertyName("match")] public string Match { get; init; } = HouseholdRules.None;

        /// <summary>Action when it doesn't.</summary>
        [JsonPropertyName("otherwise")] public string Otherwise { get; init; } = HouseholdRules.None;

        /// <summary>True when either action does something.</summary>
        [JsonIgnore] public bool Active => Match != HouseholdRules.None || Otherwise != HouseholdRules.None;
    }

    /// <summary>Rating: matches when the title's certification in <see cref="Country"/> is at or below <see cref="Max"/>.</summary>
    public sealed record HouseholdRatingRule : HouseholdRuleActions
    {
        /// <summary>The highest certification that matches (e.g. <c>PG-13</c>).</summary>
        [JsonPropertyName("max")] public string Max { get; init; } = string.Empty;

        /// <summary>The country whose certifications are compared (ISO 3166-1).</summary>
        [JsonPropertyName("country")] public string Country { get; init; } = "US";
    }

    /// <summary>Genre: matches when the title has any of the listed TMDB genres.</summary>
    public sealed record HouseholdGenreRule : HouseholdRuleActions
    {
        /// <summary>TMDB genre ids (movie and series genres).</summary>
        [JsonPropertyName("ids")] public int[] Ids { get; init; } = Array.Empty<int>();
    }

    /// <summary>Original language: matches when the title's original language is one of the listed ones.</summary>
    public sealed record HouseholdLanguageRule : HouseholdRuleActions
    {
        /// <summary>ISO 639-1 codes (lower case).</summary>
        [JsonPropertyName("codes")] public string[] Codes { get; init; } = Array.Empty<string>();
    }

    /// <summary>Size: matches when the request's size estimate is at or below <see cref="MaxGb"/>.</summary>
    public sealed record HouseholdSizeRule : HouseholdRuleActions
    {
        /// <summary>The largest estimate (GB) that matches.</summary>
        [JsonPropertyName("maxGb")] public double MaxGb { get; init; }
    }

    /// <summary>Streaming: matches when the title streams on a service the household has (the household country and services).</summary>
    public sealed record HouseholdStreamingRule : HouseholdRuleActions;

    /// <summary>The conditions of one role.</summary>
    public sealed record HouseholdRoleRules
    {
        /// <summary>Rating condition.</summary>
        [JsonPropertyName("rating")] public HouseholdRatingRule? Rating { get; init; }

        /// <summary>Genre condition.</summary>
        [JsonPropertyName("genre")] public HouseholdGenreRule? Genre { get; init; }

        /// <summary>Original-language condition.</summary>
        [JsonPropertyName("language")] public HouseholdLanguageRule? Language { get; init; }

        /// <summary>Size-estimate condition.</summary>
        [JsonPropertyName("size")] public HouseholdSizeRule? Size { get; init; }

        /// <summary>Streaming-service condition.</summary>
        [JsonPropertyName("streaming")] public HouseholdStreamingRule? Streaming { get; init; }

        /// <summary>True when a condition that needs the title's metadata does something.</summary>
        [JsonIgnore] public bool NeedsFacts => Rating?.Active == true || Genre?.Active == true || Language?.Active == true || Streaming?.Active == true;

        /// <summary>True when any condition does something.</summary>
        [JsonIgnore] public bool Any => NeedsFacts || Size?.Active == true;
    }

    /// <summary>The household's rule set: conditions per role (kid, member, trusted).</summary>
    public sealed record HouseholdRuleSet
    {
        /// <summary>Conditions keyed by role, lower case.</summary>
        [JsonPropertyName("roles")] public Dictionary<string, HouseholdRoleRules> Roles { get; init; } = new(StringComparer.OrdinalIgnoreCase);

        /// <summary>The conditions of a role, or null (none, or a role rules don't apply to).</summary>
        /// <param name="role">Household role.</param>
        public HouseholdRoleRules? For(string role)
            => HouseholdRules.RuledRoles.Contains(role, StringComparer.OrdinalIgnoreCase) && Roles.TryGetValue(role, out var rules) && rules.Any ? rules : null;
    }

    /// <summary>
    /// One condition's part in a verdict: which condition, the action it took, whether the title matched it (null:
    /// unknown), and the family-safe facts behind it (the title's value and the household's limit).
    /// </summary>
    /// <param name="Condition">rating, genre, language, size or streaming.</param>
    /// <param name="Action">approve, review or deny.</param>
    /// <param name="Matched">The title matched (null: the fact isn't known, so it goes for a look).</param>
    /// <param name="Value">The title's value (certification, genre ids, language, GB estimate, service names).</param>
    /// <param name="Limit">The household's limit (max certification, listed genres/languages, GB).</param>
    public sealed record HouseholdRuleHit(
        [property: JsonPropertyName("condition")] string Condition,
        [property: JsonPropertyName("action")] string Action,
        [property: JsonPropertyName("matched")] bool? Matched,
        [property: JsonPropertyName("value")] string? Value,
        [property: JsonPropertyName("limit")] string? Limit);

    /// <summary>
    /// What the household's rules say about a request: <c>none</c> (the preset decides), <c>approve</c>, <c>review</c>
    /// or <c>deny</c>, with the conditions behind it and the versions of the rules and facts it was worked out from.
    /// </summary>
    /// <param name="Verdict">none, approve, review or deny.</param>
    /// <param name="Hits">Conditions that took an action.</param>
    /// <param name="RulesVersion">Fingerprint of the rule set.</param>
    /// <param name="FactsVersion">Fingerprint of the title facts (empty when none were needed).</param>
    public sealed record HouseholdRuleVerdict(
        [property: JsonPropertyName("verdict")] string Verdict,
        [property: JsonPropertyName("hits")] IReadOnlyList<HouseholdRuleHit> Hits,
        [property: JsonPropertyName("rules")] string RulesVersion,
        [property: JsonPropertyName("facts")] string FactsVersion)
    {
        /// <summary>The stored form (want rule detail).</summary>
        [JsonIgnore] public string Json => JsonSerializer.Serialize(this);

        /// <summary>Reads a stored verdict; null when absent or unreadable.</summary>
        /// <param name="json">Stored JSON.</param>
        public static HouseholdRuleVerdict? Read(string? json)
        {
            if (string.IsNullOrWhiteSpace(json)) return null;
            try { return JsonSerializer.Deserialize<HouseholdRuleVerdict>(json); }
            catch (JsonException) { return null; }
        }

        /// <summary>A short English rationale for logs and outcome messages (the client words it in the person's language).</summary>
        public string Text()
        {
            var parts = Hits.Where(h => h.Action == Verdict || (Verdict == HouseholdRules.Review && h.Matched == null)).Select(h => h.Matched == null
                ? h.Condition + " not known"
                : h.Condition + " " + (h.Value ?? "?") + (h.Limit == null ? string.Empty : " (limit " + h.Limit + ")"));
            return string.Join("; ", parts);
        }
    }

    /// <summary>
    /// The household's fixed request conditions (phase 4b, F24): per role (Kid, Member, Trusted; Managers and
    /// administrators approve requests and are not ruled), rating, genre, original language, size estimate and
    /// "already on a streaming service the household has". Not a general rule language. Precedence after the mandatory
    /// identity/access/rating/edition gates: any deny refuses, else any review (or a fact that isn't known) waits for an
    /// OK, else any approve goes ahead, else the preset decides. A Kid's approve never skips the OK.
    /// </summary>
    public static class HouseholdRules
    {
        /// <summary>No action.</summary>
        public const string None = "none";
        /// <summary>Goes ahead.</summary>
        public const string Approve = "approve";
        /// <summary>Waits for an OK.</summary>
        public const string Review = "review";
        /// <summary>Refused.</summary>
        public const string Deny = "deny";

        /// <summary>Roles the conditions apply to.</summary>
        public static readonly IReadOnlyList<string> RuledRoles = new[] { "Kid", "Member", "Trusted" };

        /// <summary>The actions a condition may take.</summary>
        public static readonly IReadOnlyList<string> Actions = new[] { None, Approve, Review, Deny };

        /// <summary>TMDB's movie and series genres (id, English name): the genre condition's choices.</summary>
        public static readonly IReadOnlyDictionary<int, string> Genres = new Dictionary<int, string>
        {
            [28] = "Action", [12] = "Adventure", [16] = "Animation", [35] = "Comedy", [80] = "Crime", [99] = "Documentary",
            [18] = "Drama", [10751] = "Family", [14] = "Fantasy", [36] = "History", [27] = "Horror", [10402] = "Music",
            [9648] = "Mystery", [10749] = "Romance", [878] = "Science Fiction", [10770] = "TV Movie", [53] = "Thriller",
            [10752] = "War", [37] = "Western", [10759] = "Action & Adventure", [10762] = "Kids", [10763] = "News",
            [10764] = "Reality", [10765] = "Sci-Fi & Fantasy", [10766] = "Soap", [10767] = "Talk", [10768] = "War & Politics",
        };

        private static readonly JsonSerializerOptions Options = new() { PropertyNameCaseInsensitive = true };
        private static readonly Regex Country = new("^[A-Z]{2}$", RegexOptions.CultureInvariant);
        private static readonly Regex Language = new("^[a-z]{2,3}$", RegexOptions.CultureInvariant);
        private static Parsed _parsed = new(null, new HouseholdRuleSet());

        /// <summary>The stored rule set (empty when unset or unreadable), parsed once per stored value.</summary>
        /// <param name="json">Stored JSON.</param>
        public static HouseholdRuleSet Parse(string? json)
        {
            var held = Volatile.Read(ref _parsed);
            if (string.Equals(held.Json, json, StringComparison.Ordinal)) return held.Set;
            HouseholdRuleSet set;
            try
            {
                set = string.IsNullOrWhiteSpace(json) ? new HouseholdRuleSet() : JsonSerializer.Deserialize<HouseholdRuleSet>(json, Options) ?? new HouseholdRuleSet();
                set = set with { Roles = new Dictionary<string, HouseholdRoleRules>(set.Roles ?? new(), StringComparer.OrdinalIgnoreCase) };
                if (Validate(set) != null) set = new HouseholdRuleSet();
            }
            catch (JsonException)
            {
                set = new HouseholdRuleSet();
            }

            Volatile.Write(ref _parsed, new Parsed(json, set));
            return set;
        }

        private sealed record Parsed(string? Json, HouseholdRuleSet Set);

        /// <summary>Why a rule set can't be saved (an error code), or null when it is valid.</summary>
        /// <param name="set">The rule set.</param>
        public static string? Validate(HouseholdRuleSet? set)
        {
            if (set?.Roles == null) return "invalid_rules";
            if (set.Roles.Count > RuledRoles.Count) return "invalid_rules";
            foreach (var (role, rules) in set.Roles)
            {
                if (!RuledRoles.Contains(role, StringComparer.OrdinalIgnoreCase)) return "invalid_role";
                if (rules == null) return "invalid_rules";
                foreach (var actions in new HouseholdRuleActions?[] { rules.Rating, rules.Genre, rules.Language, rules.Size, rules.Streaming })
                {
                    if (actions != null && (!Actions.Contains(actions.Match) || !Actions.Contains(actions.Otherwise))) return "invalid_action";
                }

                if (rules.Rating is { Active: true } rating && (string.IsNullOrWhiteSpace(rating.Max) || rating.Max.Length > 20 || rating.Max.Any(char.IsControl) || !Country.IsMatch(rating.Country ?? string.Empty))) return "invalid_rating";
                if (rules.Genre is { } genre && (genre.Ids == null || genre.Ids.Length > 50 || genre.Ids.Any(id => !Genres.ContainsKey(id)) || (genre.Active && genre.Ids.Length == 0))) return "invalid_genre";
                if (rules.Language is { } language && (language.Codes == null || language.Codes.Length > 50 || language.Codes.Any(c => c == null || !Language.IsMatch(c)) || (language.Active && language.Codes.Length == 0))) return "invalid_language";
                if (rules.Size is { Active: true } size && (double.IsNaN(size.MaxGb) || size.MaxGb < 0.1 || size.MaxGb > 100000)) return "invalid_size";
            }

            return null;
        }

        /// <summary>Normalises a valid set for storage (roles canonical lower case, lists sorted and distinct).</summary>
        /// <param name="set">A valid rule set.</param>
        public static string Store(HouseholdRuleSet set)
        {
            var roles = set.Roles.ToDictionary(p => p.Key.ToLowerInvariant(), p => p.Value with
            {
                Genre = p.Value.Genre == null ? null : p.Value.Genre with { Ids = p.Value.Genre.Ids.Distinct().OrderBy(i => i).ToArray() },
                Language = p.Value.Language == null ? null : p.Value.Language with { Codes = p.Value.Language.Codes.Distinct(StringComparer.Ordinal).OrderBy(c => c, StringComparer.Ordinal).ToArray() },
                Rating = p.Value.Rating == null ? null : p.Value.Rating with { Max = p.Value.Rating.Max.Trim(), Country = p.Value.Rating.Country.ToUpperInvariant() },
            });
            return JsonSerializer.Serialize(new HouseholdRuleSet { Roles = roles });
        }

        /// <summary>Parses the household's streaming services setting (TMDB provider ids).</summary>
        /// <param name="value">Comma-separated ids.</param>
        public static IReadOnlySet<int> Services(string? value)
            => (value ?? string.Empty).Split(new[] { ',', ';', ' ', '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(s => int.TryParse(s, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var id) ? id : 0)
                .Where(id => id > 0).ToHashSet();

        /// <summary>True when a streaming country is a valid ISO 3166-1 code.</summary>
        /// <param name="value">The country.</param>
        public static bool ValidCountry(string? value) => value != null && Country.IsMatch(value);

        /// <summary>
        /// Works out the verdict for one request. <paramref name="facts"/> null with conditions that need them: those
        /// facts are unknown (a look). The streaming condition is inactive until the household country and services are set.
        /// </summary>
        /// <param name="rules">The requester's role's conditions.</param>
        /// <param name="rulesVersion">The rule set's fingerprint.</param>
        /// <param name="facts">The title's facts, or null.</param>
        /// <param name="estimateGb">The request's size estimate.</param>
        /// <param name="country">The household streaming country (empty: streaming inactive).</param>
        /// <param name="services">The household's services.</param>
        /// <param name="score">Scores a certification in a country (null: can't be scored).</param>
        public static HouseholdRuleVerdict Evaluate(HouseholdRoleRules rules, string rulesVersion, RuleFactSet? facts, double estimateGb, string? country, IReadOnlySet<int> services, Func<string, string, int?> score)
        {
            var hits = new List<HouseholdRuleHit>();
            void Add(string condition, HouseholdRuleActions actions, bool? matched, string? value, string? limit)
            {
                var action = matched == null ? Review : matched.Value ? actions.Match : actions.Otherwise;
                if (action != None) hits.Add(new HouseholdRuleHit(condition, action, matched, value, limit));
            }

            if (rules.Rating is { Active: true } rating)
            {
                var cert = facts?.Certification(rating.Country);
                var titleScore = cert == null ? null : score(cert, rating.Country);
                var maxScore = score(rating.Max, rating.Country);
                Add("rating", rating, titleScore == null || maxScore == null ? null : titleScore <= maxScore, cert, rating.Max);
            }

            if (rules.Genre is { Active: true } genre)
            {
                var have = facts?.Genres;
                var matched = have?.Where(g => genre.Ids.Contains(g)).ToArray();
                Add("genre", genre, have == null ? null : matched!.Length > 0, have == null ? null : string.Join(",", matched!.Length > 0 ? matched : have.Take(5)), string.Join(",", genre.Ids));
            }

            if (rules.Language is { Active: true } language)
            {
                var original = facts?.OriginalLanguage;
                Add("language", language, original == null ? null : language.Codes.Contains(original, StringComparer.OrdinalIgnoreCase), original, string.Join(",", language.Codes));
            }

            if (rules.Size is { Active: true } size)
                Add("size", size, estimateGb <= size.MaxGb, Math.Round(estimateGb, 1).ToString("0.#", System.Globalization.CultureInfo.InvariantCulture), size.MaxGb.ToString("0.#", System.Globalization.CultureInfo.InvariantCulture));

            if (rules.Streaming is { Active: true } streaming && ValidCountry(country) && services.Count > 0)
            {
                var on = facts?.ProvidersIn(country!);
                var mine = on?.Where(p => services.Contains(p.Id)).ToArray();
                Add("streaming", streaming, on == null ? null : mine!.Length > 0, mine is { Length: > 0 } ? string.Join(", ", mine.Select(p => p.Name).Take(3)) : null, country);
            }

            var verdict = hits.Any(h => h.Action == Deny) ? Deny : hits.Any(h => h.Action == Review) ? Review : hits.Any(h => h.Action == Approve) ? Approve : None;
            return new HouseholdRuleVerdict(verdict, hits, rulesVersion, rules.NeedsFacts ? facts?.Version ?? "unknown" : string.Empty);
        }

        /// <summary>A stable fingerprint of a stored rule set and the streaming settings.</summary>
        /// <param name="json">Stored rules.</param>
        /// <param name="country">Streaming country.</param>
        /// <param name="services">Streaming services.</param>
        public static string Version(string? json, string? country, string? services)
            => MutationInput.Hash((json ?? string.Empty) + "|" + (country ?? string.Empty) + "|" + (services ?? string.Empty))[..16];
    }
}
