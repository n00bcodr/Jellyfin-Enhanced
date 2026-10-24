using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;
using R7 = JE.Tests.ListsSourceReviewR7FixTests;
using World = JE.Tests.ListsSourceReviewR6FixTests.World;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class ListsC1JoinTests
{
    private static readonly DateTime Today = new(2025, 9, 1, 0, 0, 0, DateTimeKind.Utc);

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task ValidShowResourceStaysCachedWhileOnlyDetailedEvidenceGrantsSeriesScope(bool tmdb, bool details)
    {
        using var w = new World();
        Configure(w, tmdb);
        var prefix = tmdb ? R7.Tmdb : R7.SeerrA;
        w.Answer(prefix + "tv/1412", Body(R7.MetaShowBody));
        if (details) w.Answer(prefix + "tv/1412/season/1", Body(R7.MetaSeasonBody));
        else if (!tmdb) w.Answer(R7.SeerrB + "tv/1412/season/1", "{}", 503);
        var p = R7.Prefilled(PlaceholderKinds.Series);
        var seerr = new ListMetadataService(w.Transport, w.Plugin.Core.Logger);
        var je = new TmdbListMetadataSource(w.Cache, w.Plugin.Core.Logger);
        Task<PlaceholderMetadata?> Fetch() => tmdb
            ? je.FetchAsync(p, TimeSpan.FromHours(12), Today, default)
            : seerr.FetchAsync(p, TimeSpan.FromHours(12), Today, default);
        var first = Assert.IsType<PlaceholderMetadata>(await Fetch());
        ListMetadataService.Apply(p, first);
        var second = Assert.IsType<PlaceholderMetadata>(await Fetch());
        Assert.Equal("2012-10-10", second.ReleaseDate);
        Assert.Equal(1, w.Calls.Count(c => c.At == prefix + "tv/1412"));
        Assert.Equal(details, p.CompletionAuthority != null);
        Assert.Equal(details, ListRules.RequestInput(p) != null);
        if (details)
        {
            Assert.Equal(new[] { 1 }, CompletionEvaluator.ScopeSeasons(p));
            Assert.Equal(3, p.CompletionAuthority!.Episodes.Count);
            Assert.Equal(1, w.Calls.Count(c => c.At == prefix + "tv/1412/season/1"));
            Assert.Equal("incomplete", CompletionEvaluator.Read(p, Today).State);
        }
        else
        {
            Assert.True(first.Partial);
            Assert.Null(first.Expected);
            Assert.Equal("unknown", CompletionEvaluator.Read(p, Today).State);
            Assert.Empty(CompletionEvaluator.ScopeSeasons(p));
            Assert.Null(ListRules.RequestInput(p));
        }
        if (tmdb) Assert.DoesNotContain(w.Calls, c => c.At.StartsWith("seerr-", StringComparison.Ordinal));
        string Body(string body) => tmdb ? R7.Snake(body) : body;
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task NullableDetailDateNeedsADatedCoordinatePeerToBeACompositionConflict(bool tmdb, bool datedPeer)
    {
        using var w = new World();
        Configure(w, tmdb);
        var prefix = tmdb ? R7.Tmdb : R7.SeerrA;
        var show = datedPeer ? R7.MetaShowWithDatedFirstPeer() : R7.MetaShowBody;
        w.Answer(prefix + "tv/1412", Body(show));
        w.Answer(prefix + "tv/1412/season/1", Body(R7.Mutate(R7.MetaSeasonBody, "episodes[0].airDate", "null")));
        var p = R7.Prefilled(PlaceholderKinds.Season);
        var seerr = new ListMetadataService(w.Transport, w.Plugin.Core.Logger);
        var je = new TmdbListMetadataSource(w.Cache, w.Plugin.Core.Logger);
        Task<PlaceholderMetadata?> Fetch() => tmdb
            ? je.FetchAsync(p, TimeSpan.FromHours(12), Today, default)
            : seerr.FetchAsync(p, TimeSpan.FromHours(12), Today, default);
        var first = Assert.IsType<PlaceholderMetadata>(await Fetch());
        ListMetadataService.Apply(p, first);
        await Fetch();
        Assert.Equal(2, w.Total); // both individually valid resources stay cached in either composition
        Assert.Equal(datedPeer, first.Partial);
        Assert.Equal(!datedPeer, p.CompletionAuthority != null);
        Assert.Equal(datedPeer ? "unknown" : "incomplete", CompletionEvaluator.Read(p, Today).State);
        if (datedPeer) Assert.Equal("coordinate_date_contradiction", p.CompletionReason);
        string Body(string body) => tmdb ? R7.Snake(body) : body;
    }

    private static void Configure(World w, bool tmdb)
    {
        ImportTestFlags.AllOn(w.Plugin.Plugin.Configuration);
        w.Plugin.Plugin.Configuration.ArrPhase4ListJeMetadataEnabled = true;
        if (tmdb) w.Plugin.Plugin.Configuration.ArrRequestBackend = "je";
    }
}
