using System.Reflection;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Xunit.Abstractions;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class ListsC1R4TotalityTests(ITestOutputHelper output)
{
    internal static readonly DateTime Today = new(2026, 10, 24);
    private const int Seed = 541002;
    private const int RandomCases = 6000;
    private const string Past = "2011-04-17", Later = "2011-04-24", Future = "2099-01-01";

    internal static CompletionEvidence Coherent(string kind = "season", int s = 1)
    {
        var p = new Placeholder { Kind = kind, TmdbId = 1399, SeasonNumber = kind == "series" ? null : s };
        if (kind == "episodes") p.Episodes = new() { Ep(s, 1), Ep(s, 2) };
        return new(CompletionEvaluator.Scope(p), kind, p.SeasonNumber, true, false, false, s == 0 ? 0 : 1,
            kind == "series" ? null : Past, new[] { new CompletionSeason(s, 2, Past) }, new[] { Ep(s, 1, Past), Ep(s, 2, Later) },
            Ep(s, 2, Later), null, Today, kind == "episodes" ? new[] { new EpisodeCoord(s, 1), new EpisodeCoord(s, 2) } : null,
            new[] { new CompletionSeason(s, 2, Past) });
    }

    private static PlaceholderEpisode Ep(int s, int e, string? date = null, string? title = null) => new() { S = s, E = e, AirDate = date, Title = title };

    // Named counterexamples are also part of the generator's UNPERTURBED baseline. Random exploration is additional;
    // coverage cannot disappear merely because one random seed stops hitting an important contradiction class.
    internal static IEnumerable<(string Id, CompletionEvidence Evidence)> Witnesses()
    {
        var b = Coherent();
        yield return ("season_range_uncovered", b with { DeclaredSeasonCount = null,
            Seasons = new[] { new CompletionSeason(3, 2, Past) },
            DetailSeasons = new[] { new CompletionSeason(3, 2, Past) },
            Details = new[] { Ep(3, 1, Past), Ep(3, 2, Later) }, Last = Ep(3, 2, Later) });
        yield return ("episode_range_uncovered", b with { Details = new[] { Ep(1, 1, Past) } });
        yield return ("scope_binding_unknown", b with { Scope = "" });
#if !C1_R4_BASELINE
        yield return ("specials_policy_invalid", b with { SpecialsPolicy = "include_everything" });
#endif
        yield return ("show_evidence_unavailable", b with { ShowValid = false });
        yield return ("production_contradiction", b with { ProductionContradiction = true });
        yield return ("evaluation_date_invalid", b with { Today = default });
        yield return ("evidence_date_unparseable", b with { DetailPremiere = "not-a-date" });
        yield return ("episode_title_invalid", b with { Next = Ep(1, 2, title: new string('x', ListRules.MaxTitle + 1)) });
        yield return ("season_bounds_unknown", b with { Seasons = new[] { new CompletionSeason(1, 0, Past) } });
        yield return ("show_season_count_contradiction", b with { DeclaredSeasonCount = 2 });
        yield return ("series_rows_unavailable", Coherent("series") with { Details = null });
        yield return ("season_rows_unavailable", b with { Details = null });
        yield return ("detail_season_count_contradiction", b with { DetailSeasons = new[] { new CompletionSeason(1, 3, Past) } });
        yield return ("season_premiere_contradiction", b with { DetailSeasons = new[] { new CompletionSeason(1, 2, Future) } });
        yield return ("row_count_contradiction", b with { Details = b.Details!.Append(Ep(1, 3, Later)).ToArray() });
        yield return ("duplicate_episode_coordinate", b with { Details = b.Details!.Append(Ep(1, 2, Later)).ToArray() });
        yield return ("season_rows_incomplete", b with { Details = new[] { Ep(1, 1, Past) } });
        yield return ("coordinate_count_contradiction", b with { Last = Ep(1, 3, Later) });
        yield return ("last_next_order_contradiction", b with { Next = Ep(1, 1, Future) });
        yield return ("last_aired_in_future", b with { Last = Ep(1, 2, Future) });
        yield return ("known_aired_watermark_contradiction", b with { Next = Ep(1, 2, Later) });
        yield return ("coordinate_date_contradiction", b with { Last = Ep(1, 2, "2011-04-23") });
        yield return ("last_next_date_contradiction", b with { Next = Ep(1, 2, Past) });
        yield return ("episode_after_last_aired", b with { Last = Ep(1, 1, Past) });
        yield return ("aired_watermark_contradiction", b with { Last = Ep(1, 2), Details = new[] { Ep(1, 1, Past), Ep(1, 2, Future) } });
        yield return ("episode_row_date_order_contradiction", b with { Details = new[] { Ep(1, 1, Later), Ep(1, 2, Past) } });
        // The review's detail-only future premiere: no show date can mask this source.
        yield return ("premiere_rows_contradiction", b with { DetailPremiere = Future,
            Seasons = new[] { new CompletionSeason(1, 2, null) }, DetailSeasons = new[] { new CompletionSeason(1, 2, Future) } });
        yield return ("premiere_coordinate_contradiction", b with { Last = Ep(1, 1, "2011-04-16") });
        yield return ("season_start_unproven", b with { DetailPremiere = null, Seasons = new[] { new CompletionSeason(1, 2, null) },
            DetailSeasons = new[] { new CompletionSeason(1, 2, null) }, Details = new[] { Ep(1, 1, Future), Ep(1, 2, Future) }, Last = null });
        yield return ("explicit_scope_unproven", b with { ExplicitScope = new[] { new EpisodeCoord(1, 3) } });
    }

#if !C1_R4_BASELINE
    public static IEnumerable<object[]> RuleNames() => CompletionEvaluator.Rules.Select(r => new object[] { r.Id });

    [Theory]
    [MemberData(nameof(RuleNames))]
    public void NamedRuleRejectsItsCounterexample(string id)
    {
        var witness = Assert.Single(Witnesses(), w => w.Id == id).Evidence;
        Assert.Contains(id, CompletionEvaluator.Disagreements(witness));
        var result = CompletionEvaluator.Reconcile(witness, Today);
        Assert.Null(result.Authority);
        Assert.Contains(result.Reason!, CompletionEvaluator.Disagreements(witness));
    }

    // Reflection walks ACTUAL public instance properties, including nested records/collections, not a second manual
    // field list. An added scalar, nested property or collection element property therefore fails until assigned a rule.
    internal static IEnumerable<string> Fields(Type type, string prefix = "")
    {
        foreach (var p in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            var t = Nullable.GetUnderlyingType(p.PropertyType) ?? p.PropertyType;
            var path = prefix + p.Name;
            if (t.IsGenericType && t.GetGenericTypeDefinition() == typeof(IReadOnlyList<>))
            {
                foreach (var nested in Fields(t.GetGenericArguments()[0], path + "[].")) yield return nested;
            }
            else if (t == typeof(CompletionSeason) || t == typeof(PlaceholderEpisode) || t == typeof(EpisodeCoord))
            {
                foreach (var nested in Fields(t, path + ".")) yield return nested;
            }
            else yield return path;
        }
    }

    [Fact]
    public void EveryEvidenceFieldHasAnAgreementRuleAndAPerturbation()
    {
        var fields = Fields(typeof(CompletionEvidence)).OrderBy(x => x).ToArray();
        var rules = CompletionEvaluator.Rules;
        var references = rules.SelectMany(r => r.Fields).Distinct().OrderBy(x => x).ToArray();
        Assert.Equal(fields, references); // also rejects stale/typo paths instead of letting them conceal a missing field
        Assert.Equal(rules.Count, rules.Select(r => r.Id).Distinct().Count());
        Assert.Equal(fields, Perturbations(Coherent()).Select(p => p.Field).OrderBy(x => x).ToArray());
        output.WriteLine($"topLevelFields={typeof(CompletionEvidence).GetProperties().Length} leafFields={fields.Length} rules={rules.Count}");
    }

    [Fact]
    public void ReflectionGateDetectsAnUnregisteredFutureField()
    {
        var references = CompletionEvaluator.Rules.SelectMany(r => r.Fields).ToHashSet();
        Assert.Contains(nameof(FutureEvidence.UnregisteredDate), Fields(typeof(FutureEvidence)).Except(references));
    }

    private sealed record FutureEvidence(string? UnregisteredDate);

    [Theory]
    [InlineData("season")]
    [InlineData("series")]
    public void UndatedNextRemainsAnObligationEvenWhenItsDetailRowIsFuture(string kind)
    {
        var e = Coherent(kind) with { Last = Ep(1, 1, Past), Next = Ep(1, 2), Details = new[] { Ep(1, 1, Past), Ep(1, 2, Future) } };
        var p = Filled(e, new[] { new EpisodeCoord(1, 1) });
        var a = Assert.IsType<CompletionAuthority>(CompletionEvaluator.Reconcile(e, Today).Authority);
        Assert.True(Assert.Single(a.Episodes, x => x.E == 2).KnownAired);
        Assert.Contains(new EpisodeCoord(1, 2), CompletionEvaluator.Read(p, Today).Missing);
        Assert.False(CompletionEvaluator.Read(p, Today).IsComplete);
        p.Filled.Add(new FilledEpisode { S = 1, E = 2 });
        Assert.True(CompletionEvaluator.Read(p, Today).IsComplete);
    }

    [Fact]
    public void OlderPersistedProviderAuthorityRequiresFreshReconciliation()
    {
        var e = Coherent();
        var p = Filled(e, new[] { new EpisodeCoord(1, 1), new EpisodeCoord(1, 2) });
        Assert.True(CompletionEvaluator.Read(p, Today).IsComplete);
        var old = p.CompletionAuthority!;
        p.CompletionAuthority = new CompletionAuthority { EvidenceVersion = 2, Scope = old.Scope, Fingerprint = old.Fingerprint,
            ReconciledAt = old.ReconciledAt, Episodes = old.Episodes, CanComplete = old.CanComplete };
        Assert.Equal("unknown", CompletionEvaluator.Read(p, Today).State);
    }
#endif

    private static IEnumerable<CompletionEvidence> Generate()
    {
        foreach (var w in Witnesses()) yield return w.Evidence;
        // Coherent next-only evidence exercises Complete even when the observed detail-row list is empty.
        // Its count is the observed row count (zero); the named coordinate closes the declared show total.
        yield return Coherent() with { Seasons = new[] { new CompletionSeason(1, 1, Past) },
            DetailSeasons = new[] { new CompletionSeason(1, 0, Past) }, Details = Array.Empty<PlaceholderEpisode>(),
            Last = null, Next = Ep(1, 1, Past) };
        var r = new Random(Seed);
        string? Date() => r.Next(5) switch { 0 => null, 1 => Past, 2 => Later, 3 => Future, _ => "unparseable" };
        for (var i = 0; i < RandomCases; i++)
        {
            var kind = new[] { "season", "series", "episodes" }[r.Next(3)];
            var s = kind == "series" || r.Next(4) != 0 ? 1 : 0;
            var b = Coherent(kind, s);
            // Coherent controls vary dated/undated rows, explicit scopes, specials, production and later seasons.
            // Each remaining date/count is drawn separately: no shared variable couples sibling sources.
            if (i % 4 == 0)
            {
                if (r.Next(2) == 0) b = b with { Seasons = new[] { new CompletionSeason(s, 2, null) }, DetailPremiere = null,
                    DetailSeasons = new[] { new CompletionSeason(s, 2, null) }, Last = Ep(s, 2), Details = new[] { Ep(s, 1), Ep(s, 2) } };
                if (r.Next(3) == 0) b = b with { InProduction = true };
                if (s == 1 && r.Next(3) == 0) b = AddLaterSeason(b, r.Next(2) == 0 ? Future : "2012-04-01");
                yield return b;
                continue;
            }
            var count = r.Next(1, 5);
            var rowCount = Math.Max(0, count + r.Next(-1, 2));
            var showCount = Math.Max(0, count + r.Next(-1, 2));
            var detailCount = Math.Max(0, count + r.Next(-1, 2));
            var rows = Enumerable.Range(1, rowCount).Select(n => Ep(s, n, Date())).ToArray();
            if (rows.Length > 1 && r.Next(5) == 0) rows[1].E = rows[0].E;
            PlaceholderEpisode? Coordinate() => r.Next(4) == 0 ? null : Ep(r.Next(7) == 0 ? 2 : s, r.Next(1, count + 2), Date());
            var showPremiere = Date();
            var detailPremiere = Date();
            b = b with
            {
                ShowValid = r.Next(9) != 0, InProduction = r.Next(5) switch { 0 => null, 1 => true, _ => false }, ProductionContradiction = r.Next(11) == 0,
                DeclaredSeasonCount = r.Next(5) switch { 0 => null, 1 => 2, 2 => 0, _ => 1 },
                Seasons = new[] { new CompletionSeason(s, showCount, showPremiere) },
                DetailPremiere = kind == "series" ? null : Date(), // independent of BOTH other premieres
                DetailSeasons = r.Next(7) == 0 ? null : new[] { new CompletionSeason(s, detailCount, detailPremiere) },
                Details = r.Next(13) == 0 ? null : rows, Last = Coordinate(), Next = Coordinate(),
            };
            if (kind == "episodes")
            {
                var chosen = Enumerable.Range(1, r.Next(1, count + 2)).Where(_ => r.Next(3) != 0).Select(n => new EpisodeCoord(s, n)).ToArray();
                var p = new Placeholder { Kind = kind, TmdbId = 1399, SeasonNumber = s, Episodes = chosen.Select(c => Ep(c.S, c.E)).ToList() };
                b = b with { ExplicitScope = chosen, Scope = CompletionEvaluator.Scope(p) };
            }
            if (r.Next(4) == 0)
            {
                var laterShow = new CompletionSeason(2, r.Next(3), Date());
                var laterDetail = new CompletionSeason(2, r.Next(3), Date());
                var laterRows = Enumerable.Range(1, r.Next(3)).Select(n => Ep(2, n, Date())).ToArray();
                b = b with { Seasons = b.Seasons.Append(laterShow).ToArray(), DetailSeasons = b.DetailSeasons?.Append(laterDetail).ToArray(),
                    Details = b.Details?.Concat(laterRows).ToArray(), DeclaredSeasonCount = r.Next(5) switch
                        { 0 => null, 1 => 0, 2 => 3, _ => s == 0 ? 1 : 2 } };
            }
            yield return b;
        }
    }

    private static CompletionEvidence AddLaterSeason(CompletionEvidence e, string? date) => AddLaterSeason(e, date, date, date, 1, 1, 1);

    private static CompletionEvidence AddLaterSeason(CompletionEvidence e, string? showDate, string? detailDate, string? rowDate, int showCount, int detailCount, int rowCount)
    {
        // Show/detail/episode dates and all three counts are independent in adversarial later-season cases.
        return e with
        {
            Seasons = e.Seasons.Append(new CompletionSeason(2, showCount, showDate)).ToArray(),
            DetailSeasons = e.DetailSeasons?.Append(new CompletionSeason(2, detailCount, detailDate)).ToArray(),
            Details = e.Details?.Concat(Enumerable.Range(1, rowCount).Select(n => Ep(2, n, rowDate))).ToArray(),
            DeclaredSeasonCount = e.Seasons.Count(s => s.Number >= 1) + 1,
        };
    }

    [Fact]
    public void AdversarialEvidenceHasNoUnsoundCompleteAndExercisesEveryRule()
    {
        var r = new Random(Seed + 1);
        var failures = new List<int>();
        var cases = 0;
        var complete = 0;
        var namedCases = Witnesses().Count() + 1; // rule witnesses plus the next-only positive control
#if !C1_R4_BASELINE
        var coverage = CompletionEvaluator.Rules.ToDictionary(rule => rule.Id, _ => 0);
#endif
        foreach (var e in Generate())
        {
#if !C1_R4_BASELINE
            foreach (var id in CompletionEvaluator.Disagreements(e)) coverage[id]++;
#endif
            var candidates = (e.Details ?? Array.Empty<PlaceholderEpisode>()).Select(x => new EpisodeCoord(x.S, x.E))
                .Concat(new[] { e.Last, e.Next }.OfType<PlaceholderEpisode>().Select(x => new EpisodeCoord(x.S, x.E))).Distinct();
            var fillAll = cases < namedCases || r.Next(3) == 0;
            var fills = candidates.Where(_ => fillAll || r.Next(2) == 0).ToArray();
            var p = Filled(e, fills);
            if (CompletionEvaluator.Read(p, Today).IsComplete)
            {
                complete++;
                if (!Oracle(e, fills.ToHashSet()))
                {
                    failures.Add(cases);
                    if (failures.Count <= 5) output.WriteLine($"case={cases} evidence={System.Text.Json.JsonSerializer.Serialize(e)}");
                }
            }
            cases++;
        }
        output.WriteLine($"seed={Seed} cases={cases} complete={complete} violations={failures.Count} first={string.Join(',', failures.Take(20))}");
#if !C1_R4_BASELINE
        foreach (var pair in coverage) output.WriteLine($"rule={pair.Key} rejectedBaselineCases={pair.Value}");
        Assert.All(coverage, p => Assert.True(p.Value > 0, $"Generator never exercised {p.Key}"));
#endif
        Assert.True(failures.Count == 0, $"{failures.Count} unsound Complete outcomes; first={string.Join(',', failures.Take(20))}");
        Assert.True(cases >= 5000);
        Assert.True(complete >= 100, "Must retain substantial coherent Complete controls.");
    }

    private static Placeholder Filled(CompletionEvidence e, IEnumerable<EpisodeCoord> fills)
    {
        var p = new Placeholder { MediaType = "tv", Kind = e.Kind, TmdbId = 1399, SeasonNumber = e.Season };
        if (e.Kind == "episodes") p.Episodes = (e.ExplicitScope ?? Array.Empty<EpisodeCoord>()).Select(c => Ep(c.S, c.E)).ToList();
        var result = CompletionEvaluator.Reconcile(e, Today);
        p.CompletionAuthority = result.Authority; p.CompletionReason = result.Reason;
        p.Filled.AddRange(fills.Select(c => new FilledEpisode { S = c.S, E = c.E, ItemId = "filled" }));
        return p;
    }

    // Independent oracle over facts, not rule predicates/reasons or persisted KnownAired bits. Nullable named next
    // coordinates enter this set directly, so future detail dates can never hide them from the assertion.
    private static bool Oracle(CompletionEvidence e, HashSet<EpisodeCoord> filled)
    {
        if (!e.ShowValid || e.InProduction == null || e.ProductionContradiction || e.Kind == "series" && e.InProduction != false) return false;
        var detailRows = e.Details ?? Array.Empty<PlaceholderEpisode>();
        // The oracle independently unions a named next with observed rows, preserving its own date and obligation.
        var rows = detailRows.Concat(e.Next != null && (e.Kind == "series" ? e.Next.S >= 1 : e.Next.S == e.Season)
            && detailRows.All(x => x.S != e.Next.S || x.E != e.Next.E) ? new[] { e.Next } : Array.Empty<PlaceholderEpisode>()).ToArray();
        var named = new[] { e.Last, e.Next }.OfType<PlaceholderEpisode>().ToArray();
        var required = new HashSet<EpisodeCoord>();
        bool PastDate(string? d) => d != null && ListRules.TryParseDate(d, out var parsed) && parsed <= Today;
        bool Relevant(int s) => e.Kind == "series" ? s >= 1 : s == e.Season;
        var dates = rows.Concat(named).Select(x => x.AirDate).Concat(e.Seasons.Select(s => s.AirDate))
            .Concat((e.DetailSeasons ?? Array.Empty<CompletionSeason>()).Select(s => s.AirDate)).Append(e.DetailPremiere);
        if (dates.Any(d => d != null && !ListRules.TryParseDate(d, out _))) return false;
        if (e.DeclaredSeasonCount is int count && count != e.Seasons.Count(s => s.Number > 0)) return false;
        foreach (var s in e.Seasons)
        {
            var premieres = new[] { s.AirDate, e.Season == s.Number ? e.DetailPremiere : null }
                .Concat((e.DetailSeasons ?? Array.Empty<CompletionSeason>()).Where(d => d.Number == s.Number).Select(d => d.AirDate)).OfType<string>().ToArray();
            if (premieres.Distinct().Count() > 1) return false;
            if (premieres.Any(PastDate)) required.Add(new(s.Number, 1));
            var group = rows.Where(r => r.S == s.Number).OrderBy(r => r.E).ToArray();
            if (Relevant(s.Number) && !group.Select(x => x.E).SequenceEqual(Enumerable.Range(1, Math.Clamp(s.EpisodeCount, 0, 5000)))) return false;
            if (Relevant(s.Number) && premieres.Length == 0 && group.All(x => x.AirDate != null && !PastDate(x.AirDate))
                && !named.Any(x => x.S == s.Number && (x.AirDate == null || x == e.Last))) return false;
            foreach (var resource in (e.DetailSeasons ?? Array.Empty<CompletionSeason>()).Where(x => x.Number == s.Number))
                if (resource.EpisodeCount != detailRows.Count(x => x.S == s.Number) || resource.EpisodeCount > s.EpisodeCount) return false;
            foreach (var d in premieres)
            {
                if (group.Any(x => PastDate(x.AirDate) && string.CompareOrdinal(d, x.AirDate) > 0 || x.E == 1 && x.AirDate != null && x.AirDate != d)) return false;
                if (named.Any(x => x.S == s.Number && x.AirDate != null && string.CompareOrdinal(d, x.AirDate) > 0)) return false;
                if (e.Last?.S == s.Number && !PastDate(d)) return false;
            }
        }
        foreach (var group in rows.GroupBy(x => x.S))
        {
            if (group.Select(x => x.E).Distinct().Count() != group.Count()) return false;
            var dated = group.Where(x => x.AirDate != null).OrderBy(x => x.E).ToArray();
            for (var i = 1; i < dated.Length; i++) if (string.CompareOrdinal(dated[i - 1].AirDate, dated[i].AirDate) > 0) return false;
        }
        foreach (var row in rows)
        {
            if (PastDate(row.AirDate) || row.AirDate == null) required.Add(new(row.S, row.E));
            if (!e.Seasons.Any(s => s.Number == row.S && row.E >= 1 && row.E <= s.EpisodeCount)) return false;
        }
        foreach (var n in named)
        {
            if (n.AirDate == null || n == e.Last || PastDate(n.AirDate)) required.Add(new(n.S, n.E));
            if (!e.Seasons.Any(s => s.Number == n.S && n.E >= 1 && n.E <= s.EpisodeCount)) return false;
            if (rows.Any(x => x.S == n.S && x.E == n.E && n.AirDate != null && x.AirDate != null && x.AirDate != n.AirDate)) return false;
        }
        if (e.Last != null)
        {
            var last = new EpisodeCoord(e.Last.S, e.Last.E);
            foreach (var row in rows.Where(x => x.S == e.Last.S && x.E <= e.Last.E || x.S > 0 && e.Last.S > 0 && new EpisodeCoord(x.S, x.E).CompareTo(last) <= 0)) required.Add(new(row.S, row.E));
            if (e.Last.AirDate != null && !PastDate(e.Last.AirDate)) return false;
            if (e.Next is { S: > 0 } && (new EpisodeCoord(e.Next.S, e.Next.E).CompareTo(last) <= 0 || PastDate(e.Next.AirDate))) return false;
        }
        required.RemoveWhere(c => !Relevant(c.S));
        if (e.Kind == "episodes") required = (e.ExplicitScope ?? Array.Empty<EpisodeCoord>()).ToHashSet();
        return required.Count > 0 && required.All(filled.Contains);
    }

#if !C1_R4_BASELINE
    // One changed evidence path per perturbation; all other top-level fields retain their original values.
    // For absent nullable nested resources, supply a named invalid source instead of skipping the field.
    private static IEnumerable<(string Field, CompletionEvidence Evidence)> Perturbations(CompletionEvidence e)
    {
        var s = e.Seasons[0].Number;
        var detailRows = e.Details ?? Array.Empty<PlaceholderEpisode>();
        var row = detailRows.FirstOrDefault() ?? e.Next ?? Ep(s, 1);
        // A valid opposite date is contradictory only when a sibling supplies the fact. If no sibling knows it,
        // use a present unparseable source; merely changing an unknown/future date need not contradict anything.
        string Different(string? peer) => peer == null ? "not-a-date" : peer == Future ? Past : Future;
        var firstDate = detailRows.FirstOrDefault(x => x.S == s && x.E == 1)?.AirDate;
        var showDate = e.Seasons[0].AirDate;
        var detailedDate = e.DetailSeasons?.FirstOrDefault(x => x.Number == s)?.AirDate;
        var standaloneDate = e.Season == s ? e.DetailPremiere : null;
        var namedDate = new[] { e.Last, e.Next }.OfType<PlaceholderEpisode>().FirstOrDefault(x => x.S == row.S && x.E == row.E && x.AirDate != null)?.AirDate;
        CompletionEvidence Show(Func<CompletionSeason, CompletionSeason> f) => e with { Seasons = e.Seasons.Select((x, i) => i == 0 ? f(x) : x).ToArray() };
        CompletionEvidence DetailSeason(Func<CompletionSeason, CompletionSeason> f) => e with { DetailSeasons = e.DetailSeasons is { Count: > 0 }
            ? e.DetailSeasons.Select((x, i) => i == 0 ? f(x) : x).ToArray()
            : new[] { f(e.Seasons[0] with { EpisodeCount = detailRows.Count(x => x.S == s) }) } };
        CompletionEvidence Row(PlaceholderEpisode r) => e with { Details = detailRows.Count == 0
            ? new[] { r } : detailRows.Select((x, i) => i == 0 ? r : x).ToArray() };
        yield return ("Scope", e with { Scope = "" });
        yield return ("Kind", e with { Kind = "unsupported" });
        yield return ("Season", e with { Season = -1 });
        yield return ("ShowValid", e with { ShowValid = false });
        yield return ("InProduction", e with { InProduction = null });
        yield return ("ProductionContradiction", e with { ProductionContradiction = true });
        yield return ("DeclaredSeasonCount", e with { DeclaredSeasonCount = e.Seasons.Count(x => x.Number > 0) + 1 });
        yield return ("DetailPremiere", e with { DetailPremiere = "not-a-date" });
        yield return ("Today", e with { Today = default });
        yield return ("SpecialsPolicy", e with { SpecialsPolicy = "include_everything" });
        yield return ("Seasons[].Number", Show(x => x with { Number = -1 }));
        yield return ("Seasons[].EpisodeCount", Show(x => x with { EpisodeCount = 0 }));
        yield return ("Seasons[].AirDate", Show(x => x with { AirDate = Different(detailedDate ?? standaloneDate ?? firstDate) }));
        yield return ("DetailSeasons[].Number", DetailSeason(x => x with { Number = -1 }));
        yield return ("DetailSeasons[].EpisodeCount", DetailSeason(x => x with { EpisodeCount = detailRows.Count(r => r.S == x.Number) + 1 }));
        yield return ("DetailSeasons[].AirDate", DetailSeason(x => x with { AirDate = Different(showDate ?? standaloneDate ?? firstDate) }));
        yield return ("Details[].S", Row(Ep(-1, row.E, row.AirDate, row.Title)));
        yield return ("Details[].E", Row(Ep(row.S, 0, row.AirDate, row.Title)));
        yield return ("Details[].AirDate", Row(Ep(row.S, row.E, Different(namedDate ?? (row.E == 1 ? showDate ?? detailedDate ?? standaloneDate : null)), row.Title)));
        yield return ("Details[].Title", Row(Ep(row.S, row.E, row.AirDate, new string('x', ListRules.MaxTitle + 1))));
        foreach (var which in new[] { "Last", "Next" })
        {
            var n = (which == "Last" ? e.Last : e.Next) ?? Ep(s, 1);
            foreach (var (field, value) in new[] { ("S", Ep(-1, n.E, n.AirDate, n.Title)), ("E", Ep(n.S, 0, n.AirDate, n.Title)),
                ("AirDate", Ep(n.S, n.E, Different(detailRows.FirstOrDefault(x => x.S == n.S && x.E == n.E)?.AirDate), n.Title)), ("Title", Ep(n.S, n.E, n.AirDate, new string('x', ListRules.MaxTitle + 1))) })
                yield return (which + "." + field, which == "Last" ? e with { Last = value } : e with { Next = value });
        }
        var chosen = e.ExplicitScope ?? new[] { new EpisodeCoord(s, 1) };
        yield return ("ExplicitScope[].S", e with { ExplicitScope = chosen.Select((c, i) => i == 0 ? c with { S = -1 } : c).ToArray() });
        yield return ("ExplicitScope[].E", e with { ExplicitScope = chosen.Select((c, i) => i == 0 ? c with { E = 0 } : c).ToArray() });
    }

    [Fact]
    public void EveryGeneratedCompleteDeniesEverySingleFieldContradiction()
    {
        var controls = 0;
        var nextOnlyControls = 0;
        var perturbations = 0;
        var fields = Fields(typeof(CompletionEvidence)).OrderBy(x => x).ToArray();
        foreach (var e in Generate())
        {
            var fills = (e.Details ?? Array.Empty<PlaceholderEpisode>())
                .Concat(new[] { e.Last, e.Next }.OfType<PlaceholderEpisode>())
                .Select(r => new EpisodeCoord(r.S, r.E)).Distinct().ToArray();
            if (!CompletionEvaluator.Read(Filled(e, fills), Today).IsComplete) continue;
            controls++;
            if (e.Details is { Count: 0 }) nextOnlyControls++;
            var mutations = Perturbations(e).ToArray();
            Assert.Equal(fields, mutations.Select(x => x.Field).OrderBy(x => x).ToArray());
            foreach (var mutation in mutations)
            {
                Assert.False(CompletionEvaluator.Read(Filled(mutation.Evidence, fills), Today).IsComplete,
                    $"control={controls} field={mutation.Field} preserved Complete");
                perturbations++;
            }
        }
        output.WriteLine($"seed={Seed} completeControls={controls} fields={fields.Length} metamorphicPerturbations={perturbations} violations=0 nextOnlyControls={nextOnlyControls}");
        Assert.True(controls >= 100);
        Assert.True(nextOnlyControls > 0, "Named-next-only Complete controls must exercise empty-row perturbations.");
        Assert.Equal(controls * fields.Length, perturbations);
    }
#endif
}
