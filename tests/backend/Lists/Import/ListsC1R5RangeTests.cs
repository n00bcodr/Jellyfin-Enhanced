using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;

namespace JE.Tests;

public class ListsC1R5RangeTests
{
    [Theory]
    [InlineData("declared")]
    [InlineData("advertised")]
    [InlineData("detail")]
    [InlineData("row")]
    [InlineData("last")]
    [InlineData("next")]
    [InlineData("selected")]
    [InlineData("explicit")]
    [InlineData("huge")]
    public void EverySourceCanExposeAnUncoveredSeason(string source)
    {
        var b = ListsC1R4TotalityTests.Coherent("series") with { DeclaredSeasonCount = null };
        var e = source switch
        {
            "declared" => b with { DeclaredSeasonCount = 3 },
            "advertised" => b with { Seasons = b.Seasons.Append(new CompletionSeason(3, 1, null)).ToArray() },
            "detail" => b with { DetailSeasons = b.DetailSeasons!.Append(new CompletionSeason(3, 1, null)).ToArray() },
            "row" => b with { Details = b.Details!.Append(new PlaceholderEpisode { S = 3, E = 1 }).ToArray() },
            "last" => b with { Last = new PlaceholderEpisode { S = 3, E = 1 } },
            "next" => b with { Next = new PlaceholderEpisode { S = 3, E = 1 } },
            "selected" => b with { Season = 3 },
            "explicit" => b with { ExplicitScope = new[] { new EpisodeCoord(3, 1) } },
            _ => b with { Last = new PlaceholderEpisode { S = int.MaxValue, E = int.MaxValue } },
        };
        Assert.Contains("season_range_uncovered", CompletionEvaluator.Disagreements(e));
        Assert.Null(CompletionEvaluator.Reconcile(e, ListsC1R4TotalityTests.Today).Authority);
    }

    [Fact]
    public void RowsCannotSkipAnEpisodeEvenWhenEveryCountIsRelabelledToAgree()
    {
        var b = ListsC1R4TotalityTests.Coherent("series");
        var e = b with { Details = new[] { b.Details![0], new PlaceholderEpisode { S = 1, E = 3, AirDate = "2011-04-24" } },
            Last = new PlaceholderEpisode { S = 1, E = 3, AirDate = "2011-04-24" } };
        Assert.Contains("episode_range_uncovered", CompletionEvaluator.Disagreements(e));
        Assert.Null(CompletionEvaluator.Reconcile(e, ListsC1R4TotalityTests.Today).Authority);
    }

    [Fact]
    public void VersionThreeAuthorityCannotSurviveTheStrongerCoverageContract()
    {
        var e = ListsC1R4TotalityTests.Coherent("series");
        var a = Assert.IsType<CompletionAuthority>(CompletionEvaluator.Reconcile(e, ListsC1R4TotalityTests.Today).Authority);
        var p = new Placeholder { Kind = "series", TmdbId = 1399, CompletionAuthority = new CompletionAuthority
        { EvidenceVersion = 3, Scope = a.Scope, Fingerprint = a.Fingerprint, ReconciledAt = a.ReconciledAt,
            Episodes = a.Episodes, CanComplete = true } };
        Assert.Equal("unknown", CompletionEvaluator.Read(p, ListsC1R4TotalityTests.Today).State);
    }
}
