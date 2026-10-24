using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Xunit.Abstractions;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class ListsC1R5HiddenTruthTests(ITestOutputHelper output)
{
    private const int Seed = 551002, Cases = 7200;
    private static readonly DateTime Today = new(2026, 10, 24);
    // Truth exists before any view. No oracle reconstructs it from CompletionEvidence.
    private sealed record TrueEpisode(int S, int E, string Date);
    private sealed record Truth(int Seasons, TrueEpisode[] Episodes, bool InProduction);
    private sealed record View(Truth Truth, CompletionEvidence Evidence, HashSet<EpisodeCoord> Statements,
        HashSet<EpisodeCoord> Fills, int Mutation);
    private static EpisodeCoord Coord(TrueEpisode e) => new(e.S, e.E);
    private static PlaceholderEpisode Row(TrueEpisode e) => new() { S = e.S, E = e.E, AirDate = e.Date };
    private static Truth MakeTruth(Random random, bool production = false)
    {
        var n = random.Next(1, 6);
        var episodes = new List<TrueEpisode>();
        for (var s = 0; s <= n; s++)
        {
            var count = random.Next(2, 6);
            for (var e = 1; e <= count; e++)
                episodes.Add(new(s, e, new DateTime(2010 + s, 1, 1).AddDays(e - 1).ToString("yyyy-MM-dd")));
        }
        if (production) episodes[^1] = episodes[^1] with { Date = "2099-01-01" };
        return new(n, episodes.ToArray(), production);
    }

    private static View Derive(Truth truth, Random random, int mutation, string kind)
    {
        var selected = kind == "series" ? (int?)null : random.Next(4) == 0 ? 0 : random.Next(1, truth.Seasons + 1);
        var p = new Placeholder { MediaType = "tv", Kind = kind, TmdbId = 1399, SeasonNumber = selected };
        bool InScope(int s) => kind == "series" ? s > 0 : s == selected;
        var advertised = truth.Episodes.GroupBy(e => e.S).Select(g => new CompletionSeason(g.Key, g.Count(), g.First().Date)).ToArray();
        var rows = truth.Episodes.Where(e => InScope(e.S)).Select(Row).ToArray();
        var resources = advertised.Where(s => InScope(s.Number)).ToArray();
        var last = Row(truth.Episodes.Last(e => e.S > 0 && string.CompareOrdinal(e.Date, "2026-10-24") <= 0));
        if (kind == "episodes") p.Episodes = rows.ToList();
        var evidence = new CompletionEvidence(CompletionEvaluator.Scope(p), kind, selected, true, truth.InProduction, false,
            truth.Seasons, selected.HasValue ? truth.Episodes.First(e => e.S == selected).Date : null,
            advertised, rows, last, null, Today, kind == "episodes" ? rows.Select(e => new EpisodeCoord(e.S, e.E)).ToArray() : null,
            DetailSeasons: resources);
        // Transform each view independently. The oracle compares actual emitted facts with the hidden truth;
        // it never trusts a mutation label to decide whether the resulting evidence is contradictory.
        switch (mutation)
        {
            case 1: // All peers omit an interior season, but an upper ordinal still exposes the hole (S1/S3).
                if (truth.Seasons >= 3)
                {
                    evidence = evidence with { Seasons = advertised.Where(s => s.Number != 2).ToArray(),
                        DetailSeasons = resources.Where(s => s.Number != 2).ToArray(), Details = rows.Where(e => e.S != 2).ToArray(),
                        DeclaredSeasonCount = truth.Seasons - 1 };
                }
                break;
            case 2: // Consistently relabel every peer; cardinality still agrees, identities do not.
                evidence = evidence with { Seasons = advertised.Select(s => s.Number == 0 ? s : s with { Number = s.Number + 2 }).ToArray(),
                    DetailSeasons = resources.Select(s => s.Number == 0 ? s : s with { Number = s.Number + 2 }).ToArray(),
                    Details = rows.Select(e => new PlaceholderEpisode { S = e.S == 0 ? 0 : e.S + 2, E = e.E, AirDate = e.AirDate }).ToArray(),
                    Last = new PlaceholderEpisode { S = last.S + 2, E = last.E, AirDate = last.AirDate } };
                break;
            case 3: evidence = evidence with { Seasons = advertised.Where(s => s.Number != 1).ToArray() }; break;
            case 4: evidence = evidence with { DeclaredSeasonCount = truth.Seasons - 1 }; break;
            case 5: evidence = evidence with { DeclaredSeasonCount = truth.Seasons + 1 }; break;
            case 6: evidence = evidence with { DetailSeasons = resources.Skip(1).ToArray(), Details = rows.Where(e => e.S != resources[0].Number).ToArray() }; break;
            case 7: evidence = evidence with { Details = rows.Where(e => e.E != 2).ToArray() }; break;
            case 8: evidence = evidence with { Seasons = advertised.Select(s => InScope(s.Number) ? s with { EpisodeCount = s.EpisodeCount - 1 } : s).ToArray() }; break;
            case 9: evidence = evidence with { DetailSeasons = resources.Select(s => s with { EpisodeCount = s.EpisodeCount + 1 }).ToArray() }; break;
            case 10: evidence = evidence with { DetailPremiere = null, Seasons = advertised.Select(s => s with { AirDate = null }).ToArray() }; break;
            case 11: evidence = evidence with { DetailSeasons = resources.Select(s => s with { AirDate = "2099-01-01" }).ToArray() }; break;
            case 12: evidence = evidence with { Details = rows.Select((e, i) => i == 0 ? new PlaceholderEpisode { S = e.S, E = e.E, AirDate = "2099-01-01" } : e).ToArray() }; break;
            case 13: evidence = evidence with { Details = rows.Select((e, i) => i == 0 ? new PlaceholderEpisode { S = e.S, E = e.E, AirDate = null } : e).ToArray() }; break;
            case 14: evidence = evidence with { Details = null, DetailSeasons = null }; break;
            case 15: evidence = evidence with { Last = new PlaceholderEpisode { S = truth.Seasons + 2, E = 1 } }; break;
            case 16: evidence = evidence with { Next = new PlaceholderEpisode { S = last.S, E = last.E + 2 } }; break;
            case 17: evidence = evidence with { Seasons = advertised.Where(s => s.Number != 0).ToArray() }; break;
            case 18: evidence = evidence with { Last = null }; break;
            case 19: evidence = evidence with { DeclaredSeasonCount = null }; break;
            case 20: // Independently drop an advertised season and a different detail resource.
                evidence = evidence with { Seasons = advertised.Where(s => s.Number != truth.Seasons).ToArray(),
                    Details = rows.Where(e => e.S != 1).ToArray(), DetailSeasons = resources.Where(s => s.Number != 1).ToArray() }; break;
            case 21: evidence = evidence with { Last = new PlaceholderEpisode { S = last.S, E = last.E, AirDate = null } }; break;
            case 22: // Joint episode omission with a retained maximum coordinate exposes the interior gap.
                evidence = evidence with { Details = rows.Where(e => e.E != 1).ToArray(),
                    Seasons = advertised.Select(s => InScope(s.Number) ? s with { EpisodeCount = s.EpisodeCount - 1 } : s).ToArray(),
                    DetailSeasons = resources.Select(s => s with { EpisodeCount = s.EpisodeCount - 1 }).ToArray() }; break;
        }
        var statements = (evidence.Details ?? Array.Empty<PlaceholderEpisode>()).Concat(new[] { evidence.Last, evidence.Next }.OfType<PlaceholderEpisode>())
            .Where(e => InScope(e.S)).Select(e => new EpisodeCoord(e.S, e.E)).ToHashSet();
        // Fill only observed coordinates, so jointly omitted truth cannot be accidentally rescued by test setup.
        var fills = statements.Where(_ => mutation != 23 || random.Next(2) == 0).ToHashSet();
        return new(truth, evidence, statements, fills, mutation);
    }

    // Flatten emitted claims into atomic facts. This is a serialization of each source's statements, not a
    // reconciliation algorithm: no source is compared to another, no ordinal ranges or KnownAired bits are inferred.
    private static IEnumerable<(string Key, string Value)> Facts(CompletionEvidence e)
    {
        if (e.DeclaredSeasonCount is int count) yield return ("seasons", count.ToString());
        if (e.InProduction is bool production) yield return ("production", production.ToString());
        foreach (var season in e.Seasons.Concat(e.DetailSeasons ?? Array.Empty<CompletionSeason>()))
        {
            yield return ($"count:{season.Number}", season.EpisodeCount.ToString());
            if (season.AirDate != null) yield return ($"date:{season.Number}:1", season.AirDate);
        }
        if (e.DetailPremiere != null) yield return ($"date:{e.Season}:1", e.DetailPremiere);
        foreach (var row in (e.Details ?? Array.Empty<PlaceholderEpisode>()).Concat(new[] { e.Last, e.Next }.OfType<PlaceholderEpisode>()))
        {
            yield return ($"episode:{row.S}:{row.E}", "exists");
            if (row.AirDate != null) yield return ($"date:{row.S}:{row.E}", row.AirDate);
        }
    }

    private static Dictionary<string, string> TruthFacts(Truth truth)
    {
        var facts = new Dictionary<string, string> { ["seasons"] = truth.Seasons.ToString(), ["production"] = truth.InProduction.ToString() };
        foreach (var season in truth.Episodes.GroupBy(e => e.S)) facts[$"count:{season.Key}"] = season.Count().ToString();
        foreach (var episode in truth.Episodes)
        {
            facts[$"episode:{episode.S}:{episode.E}"] = "exists";
            facts[$"date:{episode.S}:{episode.E}"] = episode.Date;
        }
        return facts;
    }

    // The entire oracle: equality to pre-existing truth, all true episodes filled, no false emitted fact.
    private static bool Oracle(View view)
    {
        var expected = view.Truth.Episodes.Where(e => view.Evidence.Kind == "series" ? e.S > 0 : e.S == view.Evidence.Season).Select(Coord).ToHashSet();
        var truth = TruthFacts(view.Truth);
        return !(view.Evidence.Kind == "series" && view.Truth.InProduction)
            && Facts(view.Evidence).All(f => truth.TryGetValue(f.Key, out var value) && value == f.Value)
            && view.Statements.SetEquals(expected) && expected.IsSubsetOf(view.Fills);
    }

    private static CompletionVerdict Evaluate(View view)
    {
        var e = view.Evidence;
        var result = CompletionEvaluator.Reconcile(e, Today);
        var p = new Placeholder { MediaType = "tv", Kind = e.Kind, TmdbId = 1399, SeasonNumber = e.Season,
            CompletionAuthority = result.Authority, CompletionReason = result.Reason };
        if (e.Kind == "episodes") p.Episodes = (e.ExplicitScope ?? Array.Empty<EpisodeCoord>()).Select(c => new PlaceholderEpisode { S = c.S, E = c.E }).ToList();
        p.Filled.AddRange(view.Fills.Select(c => new FilledEpisode { S = c.S, E = c.E, ItemId = "filled" }));
        return CompletionEvaluator.Read(p, Today);
    }

    [Fact]
    public void LossyViewsCannotCompleteBeyondTheirHiddenTruth()
    {
        var random = new Random(Seed);
        var violations = new List<int>();
        var complete = 0;
        var omissions = 0;
        for (var i = 0; i < Cases; i++)
        {
            var truth = MakeTruth(random, i % 17 == 0);
            var view = Derive(truth, random, i % 24, new[] { "series", "season", "episodes" }[random.Next(3)]);
            if (!Oracle(view)) omissions++;
            if (Evaluate(view).IsComplete)
            {
                complete++;
                if (!Oracle(view)) violations.Add(i);
            }
        }
        output.WriteLine($"seed={Seed} cases={Cases} complete={complete} truthDenials={omissions} violations={violations.Count} first={string.Join(',', violations.Take(20))}");
        Assert.True(complete > 100);
        Assert.True(violations.Count == 0, $"Hidden truth violations={violations.Count}; first={string.Join(',', violations.Take(20))}");
    }

    [Fact]
    public void FullyPresentCoherentTruthHasZeroUnknownFalseNegatives()
    {
        var random = new Random(Seed + 1);
        var unknown = 0;
        var incomplete = 0;
        const int controls = 1500;
        for (var i = 0; i < controls; i++)
        {
            var view = Derive(MakeTruth(random), random, 0, i % 2 == 0 ? "series" : "season");
            Assert.True(Oracle(view));
            var verdict = Evaluate(view);
            if (verdict.State == "unknown") { unknown++; if (unknown <= 3) output.WriteLine($"kind={view.Evidence.Kind} reason={verdict.Reason} evidence={System.Text.Json.JsonSerializer.Serialize(view.Evidence)}"); }
            if (!verdict.IsComplete) incomplete++;
        }
        output.WriteLine($"seed={Seed + 1} coherentControls={controls} unknown={unknown} notComplete={incomplete} falseNegativeRate={(double)unknown / controls:P2}");
        Assert.Equal(0, unknown);
        Assert.Equal(0, incomplete);
    }
    [Fact]
    public void MissingDetailDatesWithDatedLastRemainAnExplicitConservativeLimit()
    {
        const int controls = 200;
        var unknown = 0;
        var recovered = 0;
        for (var i = 0; i < controls; i++)
        {
            var kind = i % 2 == 0 ? "series" : "season";
            var e = ListsC1R4TotalityTests.Coherent(kind);
            var truth = new Truth(1, e.Details!.Select(r => new TrueEpisode(r.S, r.E, r.AirDate!)).ToArray(), false);
            e = e with { Details = e.Details.Select(r => new PlaceholderEpisode { S = r.S, E = r.E }).ToArray() };
            var coordinates = truth.Episodes.Select(Coord).ToHashSet();
            var v = new View(truth, e, coordinates, coordinates, 0);
            Assert.True(Oracle(v)); // Full identity/fill truth; null dates are absent, not false emitted dates.
            var verdict = Evaluate(v);
            Assert.Equal("unknown", verdict.State);
            Assert.Equal("coordinate_date_contradiction", verdict.Reason);
            unknown++;
            // An undated peer restores the established compatible undated-obligation path without changing fills.
            v = v with { Evidence = e with { Last = new PlaceholderEpisode { S = 1, E = 2 } } };
            Assert.True(Evaluate(v).IsComplete);
            recovered++;
        }
        output.WriteLine($"datePartialControls={controls} unknown={unknown} falseNegativeRate=100% undatedPeerComplete={recovered}");
    }

}
