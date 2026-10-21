using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;
using static JE.Tests.FakeImportLookup;

namespace JE.Tests;

// Review round 1 (track h1, F52): an "A or B" alternative carries its own episodes; the resolver never gives it the
// first alternative's.
[Collection("Plugin singleton")]
public class ListsImportReviewR1h1Tests
{
    private static ImportEntryDto Wire(string json) => JsonSerializer.Deserialize<ImportEntryDto>(json)!;

    // "Flash 1x08 **or** Arrow <arrow>", as the paste parser sends it.
    private static ImportEntryDto FlashOrArrow(int arrowSeason, int arrowEpisode, bool arrowOpenEnded = false) => Wire(
        "{\"title\":\"Flash\",\"typeHint\":\"tv\",\"season\":1,\"episodes\":[{\"s\":1,\"e\":8}],\"alternatives\":["
        + "{\"title\":\"Flash\",\"typeHint\":\"tv\",\"season\":1,\"episodes\":[{\"s\":1,\"e\":8}]},"
        + $"{{\"title\":\"Arrow\",\"typeHint\":\"tv\",\"season\":{arrowSeason},\"episodes\":[{{\"s\":{arrowSeason},\"e\":{arrowEpisode}}}]"
        + (arrowOpenEnded ? ",\"openEnded\":true" : string.Empty) + "}]}");

    [Fact]
    public void EveryAlternativeIsValidatedWithItsOwnEpisodes()
    {
        var other = ListImportResolver.Validate(FlashOrArrow(3, 9))!;
        Assert.Equal(1, other.Alternatives[0].Season);
        Assert.Equal(new[] { 8 }, other.Alternatives[0].Episodes);
        Assert.Equal((3, PlaceholderKinds.Episodes), (other.Alternatives[1].Season, other.Alternatives[1].Kind));
        Assert.Equal(new[] { 9 }, other.Alternatives[1].Episodes);

        // Same season, other episode: Arrow 1x09, not Flash's 1x08.
        var same = ListImportResolver.Validate(FlashOrArrow(1, 9))!;
        Assert.Equal(new[] { 9 }, same.Alternatives[1].Episodes);

        var open = ListImportResolver.Validate(FlashOrArrow(2, 5, arrowOpenEnded: true))!;
        Assert.True(open.Alternatives[1].OpenEnded);
        Assert.False(open.Alternatives[0].OpenEnded);

        // A whole-show alternative stays the whole show even when it names the first one's season.
        var whole = Wire("{\"title\":\"Flash\",\"season\":1,\"episodes\":[{\"s\":1,\"e\":8}],\"alternatives\":[{\"title\":\"Flash\",\"season\":1,\"episodes\":[{\"s\":1,\"e\":8}]},{\"title\":\"Arrow\",\"season\":1}]}");
        Assert.Equal(PlaceholderKinds.Season, ListImportResolver.Validate(whole)!.Alternatives[1].Kind);

        // Alternative episodes are validated like the entry's: one season, at most 100.
        var mixed = Wire("{\"title\":\"Flash\",\"alternatives\":[{\"title\":\"Flash\"},{\"title\":\"Arrow\",\"season\":3,\"episodes\":[{\"s\":3,\"e\":9},{\"s\":4,\"e\":1}]}]}");
        Assert.Null(ListImportResolver.Validate(mixed));
        var tooMany = Wire("{\"title\":\"Flash\",\"alternatives\":[{\"title\":\"Flash\"},{\"title\":\"Arrow\",\"episodes\":["
            + string.Join(",", Enumerable.Range(1, 101).Select(e => $"{{\"s\":3,\"e\":{e}}}")) + "]}]}");
        Assert.Null(ListImportResolver.Validate(tooMany));
    }

    [Fact]
    public async Task TheOtherAlternativeResolvesToItsOwnEpisode()
    {
        using var h = new ImportHarness();
        var user = h.NewUser("u");
        var flash = Tv(60735, "The Flash", "2014-10-07", 12000);
        var arrow = Tv(1412, "Arrow", "2012-10-10", 9000);
        h.Lookup.AddSearch("Flash", flash);
        h.Lookup.AddSearch("Arrow", arrow);
        h.Lookup.AddShow(flash, new SeasonFacts(1, 23, "2014-10-07", "Season 1"));
        h.Lookup.AddShow(arrow, new SeasonFacts(1, 23, "2012-10-10", "Season 1"), new SeasonFacts(3, 23, "2014-10-08", "Season 3"));
        h.Lookup.Seasons[(60735, 1)] = Enumerable.Range(1, 23).Select(e => new EpisodeFacts(1, e, "Flash " + e, "2014-12-02")).ToList();
        h.Lookup.Seasons[(1412, 1)] = Enumerable.Range(1, 23).Select(e => new EpisodeFacts(1, e, "Arrow 1x" + e, "2012-12-01")).ToList();
        h.Lookup.Seasons[(1412, 3)] = Enumerable.Range(1, 23).Select(e => new EpisodeFacts(3, e, "Arrow 3x" + e, "2014-12-03")).ToList();

        var response = (await h.ImportResolver.ResolveAsync(new[] { FlashOrArrow(3, 9), FlashOrArrow(1, 9) }, new ImportResolveOptions
        {
            Caller = user,
            LibraryUsers = new[] { user },
            Context = new ImportCallContext("test", false),
            EmptyRetryDelay = TimeSpan.FromMilliseconds(5),
            Deadline = TimeSpan.FromSeconds(20),
        }, CancellationToken.None)).Response;

        var otherSeason = response.Results[0].Candidates.Single(c => c.TmdbId == 1412);
        Assert.Equal(1, otherSeason.Alternative);
        Assert.Equal(new[] { (3, 9) }, otherSeason.Episodes!.Select(e => (e.S, e.E)));
        Assert.Contains(h.Library.Calls, c => c.Scope.TmdbId == 1412 && c.Scope.Season == 3 && c.Scope.Episodes != null && c.Scope.Episodes.SequenceEqual(new[] { 9 }));
        Assert.DoesNotContain(h.Library.Calls, c => c.Scope.TmdbId == 1412 && c.Scope.Season == 3 && c.Scope.Episodes == null);

        var sameSeason = response.Results[1].Candidates.Single(c => c.TmdbId == 1412);
        Assert.Equal(new[] { (1, 9) }, sameSeason.Episodes!.Select(e => (e.S, e.E)));
        Assert.DoesNotContain(h.Library.Calls, c => c.Scope.TmdbId == 1412 && c.Scope.Season == 1 && c.Scope.Episodes != null && c.Scope.Episodes.Contains(8));
    }
}
