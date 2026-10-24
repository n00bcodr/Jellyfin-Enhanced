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
        PlaceholderEpisode? Last, PlaceholderEpisode? Next, DateTime Today, IReadOnlyList<EpisodeCoord>? ExplicitScope = null, IReadOnlyList<CompletionSeason>? DetailSeasons = null, string SpecialsPolicy = "regular_series_selected_season");
    internal sealed record CompletionReconciliation(CompletionAuthority? Authority, string? Reason);

    /// <summary>The only owner of evidence reconciliation, persisted positive authority and completion decisions.</summary>
    public static class CompletionEvaluator
    {
        internal const int EvidenceVersion = 4;

        internal static string Scope(Placeholder p) => JsonSerializer.Serialize(new object?[]
        {
            p.Kind, p.TmdbId, p.TmdbId == null ? p.TvdbId : null, p.TmdbId == null ? p.ImdbId : null, p.SeasonNumber,
            p.Kind == PlaceholderKinds.Episodes ? p.Episodes.Select(e => new EpisodeCoord(e.S, e.E)).OrderBy(c => c).ToArray() : null,
        });

        // Each rule declares exact evidence paths. The reflection gate recursively inventories the model, including
        // nested season/episode/coordinate properties, so adding a field requires an explicit reconciliation policy.
        internal sealed record AgreementRule(string Id, IReadOnlyList<string> Fields, Func<Agreement, bool> Agrees);

        internal static IReadOnlyList<AgreementRule> Rules { get; } = new AgreementRule[]
        {
            new("scope_binding_unknown", new[] { "Scope", "Kind", "Season", "ExplicitScope[].S", "ExplicitScope[].E" },
                c => ScopeAgrees(c.E)),
            new("specials_policy_invalid", new[] { "SpecialsPolicy", "Kind", "Season", "Seasons[].Number", "Details[].S" },
                c => c.E.SpecialsPolicy == "regular_series_selected_season"),
            new("show_evidence_unavailable", new[] { "ShowValid", "InProduction" },
                c => c.E.ShowValid && c.E.InProduction.HasValue),
            new("production_contradiction", new[] { "ProductionContradiction", "InProduction" },
                c => !c.E.ProductionContradiction),
            new("evaluation_date_invalid", new[] { "Today" }, c => c.E.Today != default),
            new("evidence_date_unparseable", new[] { "Today", "DetailPremiere", "Seasons[].AirDate", "DetailSeasons[].AirDate", "Details[].AirDate", "Last.AirDate", "Next.AirDate" },
                c => c.Dates.All(d => d == null || ListRules.TryParseDate(d, out _))),
            // Titles are bounded display data, never positive airing evidence. Contracts/Clip enforce the same bound.
            new("episode_title_invalid", new[] { "Details[].Title", "Last.Title", "Next.Title" },
                c => c.Rows.Concat(c.Named).All(e => e.Title == null || e.Title.Length <= ListRules.MaxTitle)),
            new("season_bounds_unknown", new[] { "Kind", "Season", "Seasons[].Number", "Seasons[].EpisodeCount" },
                c => c.E.Seasons != null && c.Selected.Count > 0 && c.Seasons.All(s => s.Number >= 0 && s.EpisodeCount >= 0)
                    && c.Seasons.Select(s => s.Number).Distinct().Count() == c.Seasons.Count
                    && c.Selected.All(s => s.EpisodeCount > 0) && c.Selected.Sum(s => (long)s.EpisodeCount) < PlaceholderProgress.MaxExpected),
            new("show_season_count_contradiction", new[] { "DeclaredSeasonCount", "Seasons[].Number", "DetailSeasons[].Number", "Details[].S", "Last.S", "Next.S", "Season", "ExplicitScope[].S" },
                c => c.E.DeclaredSeasonCount == null || c.E.DeclaredSeasonCount >= 0
                    && c.E.DeclaredSeasonCount == c.Seasons.Count(s => s.Number >= 1)
                    && c.E.DeclaredSeasonCount >= c.MaxReferencedSeason),
            new("season_range_uncovered", new[] { "Kind", "Today", "Seasons[].AirDate", "DeclaredSeasonCount", "Season", "Seasons[].Number", "Seasons[].EpisodeCount", "DetailSeasons[].Number", "DetailSeasons[].EpisodeCount", "Details[].S", "Details[].E", "Last.S", "Last.E", "Next.S", "Next.E", "ExplicitScope[].S" },
                c => c.MaxSeason < PlaceholderProgress.MaxExpected && c.PositiveSeasons.Count(s => s >= 1 && s <= c.MaxSeason) == c.MaxSeason),
            // Keep the existing probe reason: the adapter uses it to fetch the regular-season resources.
            new("series_rows_unavailable", new[] { "Kind", "Details[].S", "DetailSeasons[].Number" },
                c => !c.Series || c.E.Details != null),
            new("season_rows_unavailable", new[] { "Kind", "Details[].S", "DetailSeasons[].Number" },
                c => c.Series || c.E.Details != null),
            // Scope is explicit: unselected advertised counts establish consistency/presence only. Series
            // needs detail or named coordinates throughout 1..N; selected seasons need their own coordinates.
            // Keep these after the unavailable-row probes so adapters still know when to fetch detail resources.
            new("series_season_detail_uncovered", new[] { "Kind", "DeclaredSeasonCount", "Season", "Seasons[].Number", "DetailSeasons[].Number", "DetailSeasons[].EpisodeCount", "Details[].S", "Details[].E", "Last.S", "Last.E", "Next.S", "Next.E", "ExplicitScope[].S" },
                c => !c.Series || c.DetailCoveredSeasons.Count(s => s >= 1 && s <= c.MaxSeason) == c.MaxSeason),
            new("selected_season_detail_uncovered", new[] { "Kind", "Season", "Details[].S", "Details[].E", "Next.S", "Next.E" },
                c => c.Series || c.E.Season.HasValue && c.RowCoordinates.TryGetValue(c.E.Season.Value, out var rows) && rows.Count > 0),
            new("episode_range_uncovered", new[] { "Kind", "Season", "Seasons[].Number", "Seasons[].EpisodeCount", "DetailSeasons[].Number", "DetailSeasons[].EpisodeCount", "Details[].S", "Details[].E", "Last.S", "Last.E", "Next.S", "Next.E", "ExplicitScope[].S", "ExplicitScope[].E" },
                c => c.EpisodeBounds.All(p => (c.Series ? p.Key < 1 : p.Key != c.E.Season)
                    || p.Value > 0 && p.Value < PlaceholderProgress.MaxExpected
                        && c.RowCoordinates.TryGetValue(p.Key, out var rows) && rows.Count == p.Value
                        && rows.All(e => e >= 1 && e <= p.Value))),
            new("detail_season_count_contradiction", new[] { "Seasons[].Number", "Seasons[].EpisodeCount", "DetailSeasons[].Number", "DetailSeasons[].EpisodeCount", "Details[].S" },
                c => c.DetailSeasons.Select(s => s.Number).Distinct().Count() == c.DetailSeasons.Count
                    && c.DetailSeasons.All(d => c.Seasons.Any(s => s.Number == d.Number && d.EpisodeCount >= 0 && d.EpisodeCount <= s.EpisodeCount)
                        && c.RawRows.Count(e => e.S == d.Number) == d.EpisodeCount)),
            new("season_premiere_contradiction", new[] { "Season", "DetailPremiere", "Seasons[].AirDate", "Seasons[].Number", "DetailSeasons[].AirDate", "DetailSeasons[].Number" },
                c => c.Seasons.All(s => c.Premieres(s.Number).Where(d => d != null).Distinct().Count() <= 1)
                    && (c.E.DetailPremiere == null || c.E.Season.HasValue && c.Seasons.Any(s => s.Number == c.E.Season))),
            new("row_count_contradiction", new[] { "Seasons[].Number", "Seasons[].EpisodeCount", "Details[].S", "Details[].E" },
                c => c.Rows.All(e => c.Exists(e))),
            new("duplicate_episode_coordinate", new[] { "Details[].S", "Details[].E" },
                c => c.Rows.Select(Coord).Distinct().Count() == c.Rows.Count),
            new("season_rows_incomplete", new[] { "Kind", "Season", "Seasons[].Number", "Seasons[].EpisodeCount", "Details[].S", "Details[].E" },
                c => c.Selected.All(s => c.Rows.Count(e => e.S == s.Number) == s.EpisodeCount
                    && c.Rows.Where(e => e.S == s.Number).Select(e => e.E).OrderBy(e => e).SequenceEqual(Enumerable.Range(1, Math.Clamp(s.EpisodeCount, 0, PlaceholderProgress.MaxExpected))))),
            new("coordinate_count_contradiction", new[] { "Seasons[].Number", "Seasons[].EpisodeCount", "Last.S", "Last.E", "Next.S", "Next.E" },
                c => c.Named.All(c.Exists)),
            new("last_next_order_contradiction", new[] { "Last.S", "Last.E", "Next.S", "Next.E" },
                c => !c.RegularPair || Coord(c.E.Last!).CompareTo(Coord(c.E.Next!)) < 0),
            new("last_aired_in_future", new[] { "Today", "Last.S", "Last.E", "Last.AirDate", "Details[].S", "Details[].E", "Details[].AirDate" },
                c => c.E.Last == null || (c.E.Last.AirDate == null || Aired(c.E.Last, c.E.Today))
                    && c.Rows.Where(e => Coord(e) == Coord(c.E.Last)).All(e => e.AirDate == null || Aired(e, c.E.Today))),
            new("known_aired_watermark_contradiction", new[] { "Today", "Last.S", "Next.S", "Next.AirDate" },
                c => !c.RegularPair || !Aired(c.E.Next!, c.E.Today)),
            new("coordinate_date_contradiction", new[] { "Kind", "Season", "Last.S", "Last.E", "Last.AirDate", "Next.S", "Next.E", "Next.AirDate", "Details[].S", "Details[].E", "Details[].AirDate" },
                c => c.Named.All(n => (!c.Relevant(n) || c.Rows.Any(e => Coord(e) == Coord(n)))
                    && c.Rows.Where(e => Coord(e) == Coord(n)).All(e => n.AirDate == null || n.AirDate == e.AirDate))),
            new("last_next_date_contradiction", new[] { "Last.AirDate", "Next.AirDate", "Details[].S", "Details[].E", "Details[].AirDate" },
                c => c.DateOf(c.E.Last) == null || c.DateOf(c.E.Next) == null || string.CompareOrdinal(c.DateOf(c.E.Last), c.DateOf(c.E.Next)) <= 0),
            new("episode_after_last_aired", new[] { "Today", "Last.S", "Last.E", "Last.AirDate", "Seasons[].AirDate", "DetailSeasons[].AirDate", "DetailPremiere", "Details[].AirDate", "Details[].S", "Details[].E" },
                c => c.DateOf(c.E.Last) is not string lastDate || !c.AllPremieres.Any(d => IsPast(d, c.E.Today) && string.CompareOrdinal(d, lastDate) > 0)
                    && !c.Rows.Any(e => Aired(e, c.E.Today) && string.CompareOrdinal(e.AirDate, lastDate) > 0)),
            new("aired_watermark_contradiction", new[] { "Today", "Last.S", "Last.E", "Details[].S", "Details[].E", "Details[].AirDate" },
                c => !c.Rows.Any(e => c.AtOrBeforeLast(e) && e.AirDate != null && !Aired(e, c.E.Today))),
            new("episode_row_date_order_contradiction", new[] { "Details[].S", "Details[].E", "Details[].AirDate" },
                c => c.Rows.Where(e => e.AirDate != null).GroupBy(e => e.S).All(g =>
                    g.OrderBy(e => e.E).Zip(g.OrderBy(e => e.E).Skip(1), (a, b) => a.E == b.E || string.CompareOrdinal(a.AirDate, b.AirDate) <= 0).All(agrees => agrees))),
            new("premiere_rows_contradiction", new[] { "Today", "Season", "DetailPremiere", "Seasons[].Number", "Seasons[].AirDate", "DetailSeasons[].Number", "DetailSeasons[].AirDate", "Details[].S", "Details[].E", "Details[].AirDate", "Last.S", "Last.E" },
                c => c.Seasons.All(s => c.Premieres(s.Number).Where(d => d != null).All(d =>
                    c.Rows.Where(e => e.S == s.Number).All(e =>
                        !(Aired(e, c.E.Today) && string.CompareOrdinal(d, e.AirDate) > 0)
                        && !(e.E == 1 && e.AirDate != null && d != e.AirDate)
                        && !(c.KnownAired(e) && !IsPast(d, c.E.Today)))))),
            new("premiere_coordinate_contradiction", new[] { "Today", "Season", "DetailPremiere", "Seasons[].Number", "Seasons[].AirDate", "DetailSeasons[].Number", "DetailSeasons[].AirDate", "Last.S", "Last.E", "Last.AirDate", "Next.S", "Next.E", "Next.AirDate" },
                c => c.Named.All(n => c.Premieres(n.S).Where(d => d != null).All(d =>
                    (n.AirDate == null || string.CompareOrdinal(d, n.AirDate) <= 0 && (n.E != 1 || d == n.AirDate))
                    && (n != c.E.Last || IsPast(d, c.E.Today))))),
            new("season_start_unproven", new[] { "Kind", "Season", "Today", "DetailPremiere", "Seasons[].Number", "Seasons[].AirDate", "DetailSeasons[].Number", "DetailSeasons[].AirDate", "Details[].S", "Details[].E", "Details[].AirDate", "Last.S", "Last.E", "Last.AirDate", "Next.S", "Next.E", "Next.AirDate" },
                c => c.Selected.All(s => c.Premieres(s.Number).Any(d => d != null)
                    || c.Rows.Any(e => e.S == s.Number && (e.AirDate == null || c.KnownAired(e))))),
            new("explicit_scope_unproven", new[] { "Kind", "Season", "ExplicitScope[].S", "ExplicitScope[].E", "Details[].S", "Details[].E" },
                c => c.E.Kind == PlaceholderKinds.Episodes
                    ? c.E.ExplicitScope is { Count: > 0 } chosen && chosen.Count <= ListRules.MaxEpisodes
                        && chosen.Distinct().Count() == chosen.Count && chosen.All(x => x.S == c.E.Season && c.Rows.Any(e => Coord(e) == x))
                    : c.E.ExplicitScope == null),
        };

        // A rule may be evaluated even when an earlier rule failed. These projections therefore never assume that
        // identities, counts, dates or resource coverage have already been validated by another predicate.
        internal sealed class Agreement
        {
            internal Agreement(CompletionEvidence evidence)
            {
                E = evidence;
                Seasons = evidence.Seasons ?? Array.Empty<CompletionSeason>();
                DetailSeasons = evidence.DetailSeasons ?? Array.Empty<CompletionSeason>();
                RawRows = evidence.Details ?? Array.Empty<PlaceholderEpisode>();
                // A named next coordinate can supply the final missing row (the established coherent next control).
                // DetailSeasons counts observed detail rows, not a second advertised show total; validate that count
                // against RawRows, then validate the union against the show's advertised episode count.
                Rows = evidence.Details != null && evidence.Next != null && Relevant(evidence.Next)
                    && RawRows.All(e => Coord(e) != Coord(evidence.Next)) ? RawRows.Append(evidence.Next).ToArray() : RawRows;
                Selected = Seasons.Where(s => Series ? s.Number >= 1 : s.Number == E.Season).ToArray();
                Named = new[] { E.Last, E.Next }.OfType<PlaceholderEpisode>().ToArray();
                // Range bounds include every source, even resources/coordinates absent from the advertised list.
                // Never enumerate an untrusted ordinal: coverage is a set cardinality within a bounded range.
                var explicitRows = (E.ExplicitScope ?? Array.Empty<EpisodeCoord>()).ToArray();
                MaxReferencedSeason = Seasons.Select(s => s.Number).Concat(DetailSeasons.Select(s => s.Number))
                    .Concat(RawRows.Concat(Named).Select(e => e.S)).Concat(explicitRows.Select(e => e.S))
                    .Append(E.Season ?? 0).Append(0).Max();
                MaxSeason = Math.Max(MaxReferencedSeason, E.DeclaredSeasonCount ?? 0);
                // For an unselected season, an advertised positive episode count proves its existence;
                // selected scopes additionally require the complete row/coordinate closure below.
                var maxOccupiedSeason = RawRows.Concat(Named).Where(e => e.E > 0).Select(e => e.S)
                    .Concat(Seasons.Concat(DetailSeasons).Where(s => s.EpisodeCount > 0).Select(s => s.Number)).Append(E.Season ?? 0).Max();
                PositiveSeasons = Seasons.Where(s => s.EpisodeCount > 0
                        // An explicitly announced empty future season is present, not an unexplained gap.
                        // This exception is for an earlier selected scope only; series/selected rows stay unproven.
                        || !Series && s.Number > maxOccupiedSeason && s.EpisodeCount == 0
                            && s.AirDate != null && ListRules.TryParseDate(s.AirDate, out var premiere) && premiere.Date > E.Today.Date).Select(s => s.Number)
                    .Concat(DetailSeasons.Where(s => s.EpisodeCount > 0).Select(s => s.Number))
                    .Concat(RawRows.Concat(Named).Where(e => e.E > 0).Select(e => e.S)).ToHashSet();
                DetailCoveredSeasons = DetailSeasons.Where(s => s.EpisodeCount > 0).Select(s => s.Number)
                    .Concat(RawRows.Concat(Named).Where(e => e.E > 0).Select(e => e.S)).ToHashSet();
                EpisodeBounds = Seasons.Concat(DetailSeasons).Select(s => (S: s.Number, E: s.EpisodeCount))
                    .Concat(RawRows.Concat(Named).Select(e => (e.S, e.E))).Concat(explicitRows.Select(e => (e.S, e.E)))
                    .GroupBy(e => e.S).ToDictionary(g => g.Key, g => g.Max(e => e.E));
                RowCoordinates = Rows.GroupBy(e => e.S).ToDictionary(g => g.Key, g => g.Select(e => e.E).ToHashSet());
            }

            internal int MaxReferencedSeason { get; }
            internal int MaxSeason { get; }
            internal HashSet<int> PositiveSeasons { get; }
            internal HashSet<int> DetailCoveredSeasons { get; }
            // Find the first missing regular season in O(S log S), without enumerating an untrusted upper bound.
            internal int FirstSeasonWithoutDetail
            {
                get
                {
                    var next = 1;
                    foreach (var s in RowCoordinates.Where(p => p.Value.Count > 0 && EpisodeBounds.TryGetValue(p.Key, out var bound)
                        && p.Value.Count == bound && p.Value.All(e => e >= 1 && e <= bound))
                        .Select(p => p.Key).Where(s => s >= 1 && s <= MaxSeason).OrderBy(s => s))
                    {
                        if (s != next) break;
                        next++;
                    }
                    return next <= MaxSeason ? next : 0;
                }
            }
            internal IReadOnlyDictionary<int, int> EpisodeBounds { get; }
            internal IReadOnlyDictionary<int, HashSet<int>> RowCoordinates { get; }
            internal CompletionEvidence E { get; }
            internal bool Series => E.Kind == PlaceholderKinds.Series;
            internal bool RegularPair => E.Last is { S: >= 1 } && E.Next is { S: >= 1 };
            internal IReadOnlyList<CompletionSeason> Seasons { get; }
            internal IReadOnlyList<CompletionSeason> DetailSeasons { get; }
            internal IReadOnlyList<CompletionSeason> Selected { get; }
            internal IReadOnlyList<PlaceholderEpisode> RawRows { get; }
            internal IReadOnlyList<PlaceholderEpisode> Rows { get; }
            internal IReadOnlyList<PlaceholderEpisode> Named { get; }
            internal IEnumerable<string?> AllPremieres => Seasons.Select(s => s.AirDate).Concat(DetailSeasons.Select(s => s.AirDate)).Append(E.DetailPremiere);
            internal IEnumerable<string?> Dates => AllPremieres.Concat(Rows.Concat(Named).Select(e => e.AirDate));
            internal bool Relevant(PlaceholderEpisode e) => Series ? e.S >= 1 : e.S == E.Season;
            internal bool Exists(PlaceholderEpisode e) => Seasons.Any(s => s.Number == e.S && e.E >= 1 && e.E <= s.EpisodeCount);
            internal IEnumerable<string?> Premieres(int s) => Seasons.Where(x => x.Number == s).Select(x => x.AirDate)
                .Concat(DetailSeasons.Where(x => x.Number == s).Select(x => x.AirDate)).Append(E.Season == s ? E.DetailPremiere : null);
            internal string? DateOf(PlaceholderEpisode? e) => e?.AirDate ?? (e == null ? null : Rows.FirstOrDefault(r => Coord(r) == Coord(e))?.AirDate);

            // Required named coordinates are independent of the nullable/future date of their detailed row. KnownAired
            // is the persisted obligation bit as well as positive airing evidence; neither a future row nor Read can erase it.
            internal bool AtOrBeforeLast(PlaceholderEpisode e) => E.Last != null
                && (e.S == E.Last.S && e.E <= E.Last.E || E.Last.S >= 1 && e.S >= 1 && Coord(e).CompareTo(Coord(E.Last)) <= 0);
            internal bool KnownAired(PlaceholderEpisode e) => Aired(e, E.Today)
                || AtOrBeforeLast(e)
                || Named.Any(n => Coord(n) == Coord(e) && (n == E.Last || n.AirDate == null))
                || e.E == 1 && Premieres(e.S).Any(d => IsPast(d, E.Today));
        }

        internal static IReadOnlyList<string> Disagreements(CompletionEvidence evidence)
        {
            var agreement = new Agreement(evidence);
            // Materialize the whole table, rather than stopping at the first mismatch. Tests count every fired rule.
            return Rules.Where(rule => !rule.Agrees(agreement)).Select(rule => rule.Id).ToArray();
        }

        internal static CompletionReconciliation Reconcile(CompletionEvidence evidence, DateTime reconciledAt)
        {
            var failures = Disagreements(evidence);
            if (failures.Count > 0) return new(null, failures[0]);
            var agreement = new Agreement(evidence);
            var expected = agreement.Rows.Where(agreement.Relevant).OrderBy(e => e.S).ThenBy(e => e.E).ToArray();
            var explicitScope = evidence.Kind == PlaceholderKinds.Episodes;
            if (explicitScope) expected = expected.Where(e => evidence.ExplicitScope!.Contains(Coord(e))).ToArray();
            var canComplete = explicitScope || (agreement.Series ? evidence.InProduction == false : evidence.InProduction == false || expected.All(agreement.KnownAired));
            var fingerprint = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(evidence))));
            return new(new CompletionAuthority
            {
                EvidenceVersion = EvidenceVersion, Fingerprint = fingerprint, ReconciledAt = reconciledAt,
                Scope = evidence.Scope,
                SeriesCoverageReason = !agreement.Series && agreement.FirstSeasonWithoutDetail is > 0 and var missingSeason
                    ? $"series unknown: season {missingSeason} has no {(agreement.RawRows.Any(e => e.S == missingSeason) ? "full " : string.Empty)}detail evidence" : null,
                Episodes = expected.Select(e => new CompletionEpisode(e.S, e.E, e.AirDate, e.Title, agreement.KnownAired(e))).ToArray(), CanComplete = canComplete,
            }, null);
        }

        private static bool ScopeAgrees(CompletionEvidence e)
        {
            if (e.Kind is not (PlaceholderKinds.Series or PlaceholderKinds.Season or PlaceholderKinds.Episodes)
                || (e.Kind == PlaceholderKinds.Series ? e.Season != null : e.Season is not >= 0)) return false;
            try
            {
                using var scope = JsonDocument.Parse(e.Scope ?? string.Empty);
                var a = scope.RootElement;
                return a.ValueKind == JsonValueKind.Array && a.GetArrayLength() == 6 && a[0].GetString() == e.Kind
                    && (e.Season == null ? a[4].ValueKind == JsonValueKind.Null : a[4].TryGetInt32(out var s) && s == e.Season)
                    && (e.Kind != PlaceholderKinds.Episodes || a[5].ValueKind == JsonValueKind.Array
                        && (JsonSerializer.Deserialize<EpisodeCoord[]>(a[5].GetRawText()) ?? Array.Empty<EpisodeCoord>())
                            .OrderBy(x => x).SequenceEqual((e.ExplicitScope ?? Array.Empty<EpisodeCoord>()).OrderBy(x => x)));
            }
            catch (Exception ex) when (ex is JsonException or InvalidOperationException or FormatException) { return false; }
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
                !canComplete ? "still_in_production_or_unaired" : required.Length == 0 ? "no_aired_obligations" : missing.Length > 0 ? "missing_episodes" : CompleteReason(p, a),
                missing, a?.EvidenceVersion, a?.Fingerprint, a?.ReconciledAt, a?.Origin);
        }

        // Reasons describe the authority's exact scope; a positive season reason never asserts series completion.
        private static string CompleteReason(Placeholder p, CompletionAuthority? a)
        {
            var scope = p.Kind == PlaceholderKinds.Series ? "series"
                : p.Kind == PlaceholderKinds.Episodes ? $"season {p.SeasonNumber} episodes" : $"season {p.SeasonNumber}";
            return scope + " complete" + (a?.SeriesCoverageReason is string note ? "; " + note : string.Empty);
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
    }
}
