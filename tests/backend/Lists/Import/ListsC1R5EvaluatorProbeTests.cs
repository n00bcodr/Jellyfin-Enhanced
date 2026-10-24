using System.Diagnostics;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Xunit.Abstractions;
namespace JE.Tests;
public class ListsC1R5EvaluatorProbeTests(ITestOutputHelper output)
{
    [Fact]
    public void LastSeasonBeyondDeclaredCountCannotGrantComplete()
    {
        var e = ListsC1R4TotalityTests.Coherent("series");
        e = e with { Seasons = e.Seasons.Select(x => x with { Number = 3 }).ToArray(),
            DetailSeasons = e.DetailSeasons!.Select(x => x with { Number = 3 }).ToArray(),
            Details = e.Details!.Select(x => new PlaceholderEpisode { S=3, E=x.E, AirDate=x.AirDate }).ToArray(),
            Last = new PlaceholderEpisode { S=3, E=2, AirDate="2011-04-24" } };
        var r = CompletionEvaluator.Reconcile(e, ListsC1R4TotalityTests.Today);
        var p = new Placeholder { MediaType="tv", Kind="series", TmdbId=1399, CompletionAuthority=r.Authority, CompletionReason=r.Reason };
        p.Filled.AddRange(new[] {1,2}.Select(n => new FilledEpisode { S=3, E=n, ItemId="filled" }));
        var v=CompletionEvaluator.Read(p,ListsC1R4TotalityTests.Today);
        var oracle = (bool)typeof(ListsC1R4TotalityTests).GetMethod("Oracle", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!.Invoke(null, new object[] { e, p.Filled.Select(x=>new EpisodeCoord(x.S,x.E)).ToHashSet() })!;
        output.WriteLine($"oracle={oracle}");
        output.WriteLine($"declared={e.DeclaredSeasonCount} last={e.Last.S}:{e.Last.E} failures={string.Join(',',CompletionEvaluator.Disagreements(e))} verdict={v.State}");
        Assert.False(v.IsComplete);
    }
}
