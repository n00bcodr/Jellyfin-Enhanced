using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>An explicit completion decision; Unknown never supplies implicit scope authority.</summary>
    public sealed record CompletionVerdict(string State, string? Reason, IReadOnlyList<EpisodeCoord> Missing,
        int? EvidenceVersion = null, string? Fingerprint = null, DateTime? ReconciledAt = null, string? Origin = null)
    {
        /// <summary>Whether reconciliation and all required fills permit retirement.</summary>
        public bool IsComplete => State == "complete";
        /// <summary>A positively declared exact user scope is independent of provider freshness.</summary>
        public bool IndependentScope => State != "unknown" && Origin == "explicit_declaration";
        internal static CompletionVerdict Unknown(string reason) => new("unknown", reason, Array.Empty<EpisodeCoord>());
    }

    internal sealed record CompletionSeason(int Number, int EpisodeCount, string? AirDate);
    internal sealed record CompletionEvidence(string Scope, string Kind, int? Season, bool ShowValid, bool? InProduction,
        bool ProductionContradiction, int? DeclaredSeasonCount, string? DetailPremiere, IReadOnlyList<CompletionSeason> Seasons, IReadOnlyList<PlaceholderEpisode>? Details,
        PlaceholderEpisode? Last, PlaceholderEpisode? Next, DateTime Today, IReadOnlyList<EpisodeCoord>? ExplicitScope = null, IReadOnlyList<CompletionSeason>? DetailSeasons = null);
    internal sealed record CompletionReconciliation(CompletionAuthority? Authority, string? Reason);

    /// <summary>The only owner of evidence reconciliation, persisted positive authority and completion decisions.</summary>
    public static class CompletionEvaluator
    {
        internal const int EvidenceVersion = 2;

        internal static string Scope(Placeholder p) => JsonSerializer.Serialize(new object?[]
        {
            p.Kind, p.TmdbId, p.TmdbId == null ? p.TvdbId : null, p.TmdbId == null ? p.ImdbId : null, p.SeasonNumber,
            p.Kind == PlaceholderKinds.Episodes ? p.Episodes.Select(e => new EpisodeCoord(e.S, e.E)).OrderBy(c => c).ToArray() : null,
        });

        internal static CompletionReconciliation Reconcile(CompletionEvidence evidence, DateTime reconciledAt)
        {
            CompletionReconciliation Unknown(string reason) => new(null, reason);
            if (!evidence.ShowValid || evidence.InProduction == null) return Unknown("show_evidence_unavailable");
            if (evidence.ProductionContradiction) return Unknown("production_contradiction");
            var series = evidence.Kind == PlaceholderKinds.Series;
            var seasons = evidence.Seasons.Where(s => series ? s.Number >= 1 : s.Number == evidence.Season).OrderBy(s => s.Number).ToList();
            if (seasons.Count == 0 || seasons.Any(s => s.EpisodeCount <= 0)
                || seasons.Sum(s => (long)s.EpisodeCount) >= PlaceholderProgress.MaxExpected) return Unknown("season_bounds_unknown");
            if (evidence.DeclaredSeasonCount is int declared && declared != evidence.Seasons.Count(s => s.Number >= 1))
                return Unknown("show_season_count_contradiction");
            if (!series && evidence.DetailPremiere != null && seasons[0].AirDate != null && evidence.DetailPremiere != seasons[0].AirDate)
                return Unknown("season_premiere_contradiction");
            bool Relevant(PlaceholderEpisode e) => series ? e.S >= 1 : e.S == evidence.Season;
            var last = evidence.Last;
            var next = evidence.Next;
            foreach (var known in new[] { last, next }.OfType<PlaceholderEpisode>())
            {
                var info = evidence.Seasons.FirstOrDefault(s => s.Number == known.S);
                if (info == null || known.E < 1 || known.E > info.EpisodeCount) return Unknown("coordinate_count_contradiction");
            }
            var sameOrder = last != null && next != null && last.S >= 1 && next.S >= 1;
            if (sameOrder && Coord(last!).CompareTo(Coord(next!)) >= 0) return Unknown("last_next_order_contradiction");
            if (last?.AirDate != null && !Aired(last, evidence.Today)) return Unknown("last_aired_in_future");
            if (sameOrder && Aired(next!, evidence.Today)) return Unknown("known_aired_watermark_contradiction");
            if (last?.AirDate != null && next?.AirDate != null && string.CompareOrdinal(last.AirDate, next.AirDate) > 0)
                return Unknown("last_next_date_contradiction");
            if (last?.AirDate != null && evidence.Seasons.Any(s => IsPast(s.AirDate, evidence.Today) && string.CompareOrdinal(s.AirDate, last.AirDate) > 0))
                return Unknown("premiere_after_last_aired");
            foreach (var detail in evidence.DetailSeasons ?? Array.Empty<CompletionSeason>())
            {
                var info = evidence.Seasons.FirstOrDefault(s => s.Number == detail.Number);
                if (info == null || detail.AirDate != null && info.AirDate != null && detail.AirDate != info.AirDate)
                    return Unknown("season_premiere_contradiction");
            }
            if (evidence.Details == null) return Unknown(series ? "series_rows_unavailable" : "season_rows_unavailable");
            var rows = evidence.Details.Select(Copy).ToList();
            foreach (var row in rows)
            {
                var info = evidence.Seasons.FirstOrDefault(s => s.Number == row.S);
                if (info == null || row.E < 1 || row.E > info.EpisodeCount) return Unknown("row_count_contradiction");
            }
            if (rows.GroupBy(Coord).Any(g => g.Count() != 1)) return Unknown("duplicate_episode_coordinate");
            if (next != null && Relevant(next) && rows.All(e => Coord(e) != Coord(next))) rows.Add(Copy(next));
            var expected = rows.Where(Relevant).OrderBy(e => e.S).ThenBy(e => e.E).ToList();
            foreach (var info in seasons)
            {
                var group = expected.Where(e => e.S == info.Number).ToList();
                if (group.Count != info.EpisodeCount || group.Where((e, i) => e.E != i + 1).Any()) return Unknown("season_rows_incomplete");
            }
            foreach (var known in new[] { last, next }.OfType<PlaceholderEpisode>())
            {
                var row = rows.FirstOrDefault(e => Coord(e) == Coord(known));
                if (row == null && Relevant(known) || row != null && known.AirDate != null && row.AirDate != known.AirDate)
                    return Unknown("coordinate_date_contradiction");
                if (ReferenceEquals(known, last) && row?.AirDate != null && !Aired(row, evidence.Today))
                    return Unknown("last_aired_in_future");
            }
            var lastDate = last?.AirDate ?? (last == null ? null : rows.FirstOrDefault(e => Coord(e) == Coord(last))?.AirDate);
            if (lastDate != null && (evidence.Seasons.Any(s => IsPast(s.AirDate, evidence.Today) && string.CompareOrdinal(s.AirDate, lastDate) > 0)
                || rows.Any(e => Aired(e, evidence.Today) && string.CompareOrdinal(e.AirDate, lastDate) > 0)))
                return Unknown("episode_after_last_aired");
            if (last is { S: >= 1 } && rows.Any(e => e.S >= 1 && (Coord(e).CompareTo(Coord(last)) <= 0 && e.AirDate != null && !Aired(e, evidence.Today))))
                return Unknown("aired_watermark_contradiction");
            bool KnownAired(PlaceholderEpisode e) => Aired(e, evidence.Today)
                || last is { S: >= 1 } && e.S >= 1 && Coord(e).CompareTo(Coord(last)) <= 0
                || last != null && Coord(e) == Coord(last)
                || e.E == 1 && IsPast(seasons.First(s => s.Number == e.S).AirDate, evidence.Today);
            foreach (var info in seasons)
            {
                if (info.AirDate != null && !IsPast(info.AirDate, evidence.Today) && expected.Any(e => e.S == info.Number && KnownAired(e)))
                    return Unknown("future_premiere_has_aired_episodes");
                if (IsPast(info.AirDate, evidence.Today) && expected.First(e => e.S == info.Number && e.E == 1).AirDate is string premiereDate
                    && !IsPast(premiereDate, evidence.Today)) return Unknown("premiere_rows_contradiction");
            }
            var explicitScope = evidence.Kind == PlaceholderKinds.Episodes;
            if (explicitScope)
            {
                var chosen = evidence.ExplicitScope;
                if (chosen == null || chosen.Count == 0 || chosen.Any(c => !expected.Any(e => Coord(e) == c)))
                    return Unknown("explicit_scope_unproven");
                expected = expected.Where(e => chosen.Contains(Coord(e))).ToList();
            }
            var canComplete = explicitScope || (series ? evidence.InProduction == false : evidence.InProduction == false || expected.All(KnownAired));
            var fingerprint = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(evidence))));
            return new(new CompletionAuthority
            {
                EvidenceVersion = EvidenceVersion, Fingerprint = fingerprint, ReconciledAt = reconciledAt,
                Scope = evidence.Scope, Episodes = expected.Select(e => new CompletionEpisode(e.S, e.E, e.AirDate, e.Title, KnownAired(e))).ToArray(), CanComplete = canComplete,
            }, null);
        }

        /// <summary>Read a verdict using positive reconciliation authority and current library fills only.</summary>
        /// <param name="placeholder">Stored entry.</param>
        /// <param name="today">UTC date.</param>
        /// <returns>The explicit verdict, including a reason or missing obligations.</returns>
        public static CompletionVerdict Read(Placeholder placeholder, DateTime today)
        {
            var a = placeholder.CompletionAuthority;
            // Compatibility only: an old negative flag can deny proof, never create it.
            if (placeholder.ExpectedUncertain || a == null) return CompletionVerdict.Unknown(placeholder.CompletionReason ?? "reconciliation_required");
            if (a.EvidenceVersion != EvidenceVersion || a.Fingerprint?.Length != 64 || a.ReconciledAt == default
                || a.Scope != Scope(placeholder) || a.Episodes == null || a.Episodes.Count == 0 || a.Episodes.Count > (placeholder.Kind == PlaceholderKinds.Episodes ? ListRules.MaxEpisodes : PlaceholderProgress.MaxExpected - 1))
                return CompletionVerdict.Unknown("authority_invalid_or_scope_changed");
            var verdict = FilledVerdict(placeholder, a.Episodes.Where(e => placeholder.Kind == PlaceholderKinds.Episodes || e.KnownAired || e.AirDate == null || IsPast(e.AirDate, today)).Select(e => new EpisodeCoord(e.S, e.E)), a.CanComplete, a);
            if (placeholder.Kind != PlaceholderKinds.Episodes && verdict.Missing.Count > 0
                && verdict.Missing.All(c => a.Episodes.Any(e => e.S == c.S && e.E == c.E && e.AirDate == null && !e.KnownAired)))
                return CompletionVerdict.Unknown("episode_airing_unproven");
            return verdict;
        }

        private static CompletionVerdict FilledVerdict(Placeholder p, IEnumerable<EpisodeCoord> obligations, bool canComplete, CompletionAuthority? a)
        {
            var required = obligations.Distinct().ToArray();
            var filled = PlaceholderProgress.FilledCoords(p);
            var missing = required.Where(c => !filled.Contains(c)).ToArray();
            return new CompletionVerdict(canComplete && required.Length > 0 && missing.Length == 0 ? "complete" : "incomplete",
                !canComplete ? "still_in_production_or_unaired" : required.Length == 0 ? "no_aired_obligations" : missing.Length > 0 ? "missing_episodes" : null,
                missing, a?.EvidenceVersion, a?.Fingerprint, a?.ReconciledAt, a?.Origin);
        }

        /// <summary>Reconciled regular seasons for derived acquisition; empty when the verdict is Unknown.</summary>
        /// <param name="p">Stored entry.</param>
        /// <returns>Positively reconciled scope seasons.</returns>
        public static IReadOnlyList<int> ScopeSeasons(Placeholder p) => Read(p, DateTime.UtcNow).State == "unknown"
            ? Array.Empty<int>() : p.CompletionAuthority?.Episodes.Where(e => e.S >= 1).Select(e => e.S).Distinct().OrderBy(s => s).ToArray() ?? Array.Empty<int>();

        // A new explicit user declaration is positive evidence of the chosen scope. Reload never calls this factory.
        internal static CompletionAuthority? DeclareEpisodes(Placeholder p, DateTime at)
        {
            if (p.Kind != PlaceholderKinds.Episodes || p.Episodes.Count == 0 || p.Episodes.Count > ListRules.MaxEpisodes
                || p.Episodes.Any(e => e.S != p.SeasonNumber || e.E < 1)
                || p.Episodes.Select(Coord).Distinct().Count() != p.Episodes.Count) return null;
            var scope = Scope(p);
            return new CompletionAuthority
            {
                EvidenceVersion = EvidenceVersion, Scope = scope, ReconciledAt = at, CanComplete = true, Origin = "explicit_declaration",
                Fingerprint = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("explicit_user_scope|" + scope))),
                Episodes = p.Episodes.Select(e => new CompletionEpisode(e.S, e.E, e.AirDate, e.Title)).ToArray(),
            };
        }

        /// <summary>Reconciled explicit episode scope; empty when the verdict is Unknown.</summary>
        /// <param name="p">Stored entry.</param>
        /// <returns>Positively declared or refreshed episode coordinates.</returns>
        public static IReadOnlyList<EpisodeCoord> ScopeEpisodes(Placeholder p) => Read(p, DateTime.UtcNow).State == "unknown"
            ? Array.Empty<EpisodeCoord>() : p.CompletionAuthority!.Episodes.Select(e => new EpisodeCoord(e.S, e.E)).ToArray();

        // Display facts must never alias or mutate the persisted proof's immutable coordinates.
        internal static List<PlaceholderEpisode>? DisplayEpisodes(CompletionAuthority? authority) => authority?.Episodes
            .Select(e => new PlaceholderEpisode { S = e.S, E = e.E, AirDate = e.AirDate, Title = e.Title }).ToList();

        private static bool IsPast(string? date, DateTime today) => date != null && ListRules.TryParseDate(date, out var d) && d.Date <= today.Date;
        private static bool Aired(PlaceholderEpisode e, DateTime today) => IsPast(e.AirDate, today);
        private static EpisodeCoord Coord(PlaceholderEpisode e) => new(e.S, e.E);
        private static PlaceholderEpisode Copy(PlaceholderEpisode e) => new() { S = e.S, E = e.E, AirDate = e.AirDate, Title = e.Title };
    }
}
