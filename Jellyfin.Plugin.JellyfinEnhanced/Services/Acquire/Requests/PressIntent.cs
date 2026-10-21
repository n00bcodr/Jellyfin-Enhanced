using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
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
    public sealed record PressProof(string? Refusal)
    {
        /// <summary>The press no longer does what it was drawn to do.</summary>
        public static PressProof Changed { get; } = new(PressChecks.Changed);
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
        public static bool IsRefusal(string? code) => code is Changed or Unverified;

        /// <summary>The household words of a press refusal.</summary>
        public static string Message(string code) => code == Unverified
            ? "This couldn't be checked right now, so nothing was sent."
            : "This changed since the page was shown, so nothing was sent.";

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
        {
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
            switch (route)
            {
                case Ask:
                {
                    if (input == null || intent.Mode != "get" || !string.Equals(input.Variant, intent.Variant, StringComparison.Ordinal)) return Changed;
                    if (bound != null && !(bound.Ask && bound.Variant == intent.Variant && bound.Dest != null && string.Equals(bound.Dest, intent.Dest, StringComparison.Ordinal))) return Changed;
                    if (bound == null && intent.Variant != "standard") return Changed;
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

        /// <summary>The episode numbers of a season a search key names (one episode), or the intent's for a season key.</summary>
        public static IReadOnlyList<int> Numbers(TitleKey key, PressIntent? intent)
            => key.Episode is int one ? new[] { one } : (intent?.Episodes ?? Array.Empty<int>()).Distinct().OrderBy(n => n).ToArray();
    }
}
