using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.AutoRequest;
using Xunit.Abstractions;
using Rig = JE.Tests.IntegrationEditionAvailabilityTests.Rig;
using Layout = JE.Tests.IntegrationEditionAvailabilityTests.Layout;
using Has = JE.Tests.IntegrationEditionAvailabilityTests.Has;
using M = JE.Tests.IntegrationEditionMaskedTests;

namespace JE.Tests;

/// <summary>
/// Edition round 19, part B (D53: episode identity and interval coverage). Counts come from disjoint episode identities:
/// the versions Jellyfin groups are one episode, a multi-episode file covers its whole range. Aggregates whose overlap
/// isn't known (Sonarr's file count against its queue) are never added together; they are bounded by what can be told
/// apart. Range coverage merges intervals: endpoints never overflow and the work follows the intervals, never the span.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationEditionIdentityTests(ITestOutputHelper output)
{
    private static readonly TitleKey Firefly = TitleKey.Parse("tv:tvdb:78874")!;

    /// <summary>Whether the recorder says season <paramref name="season"/>'s first <paramref name="count"/> episodes are all in the library (null when it can't say, or has no such question).</summary>
    private static bool? SeasonInLibrary(AutoRequestRecorder recorder, TitleKey series, int season, int count, Guid user)
    {
        var method = typeof(AutoRequestRecorder).GetMethod("SeasonInLibrary");
        Assert.True(method != null, "the recorder has no season coverage question");
        return (bool?)method!.Invoke(recorder, new object[] { series, season, count, user });
    }

    // ------------------------------------------------------------------ ED-AX-14: automatic next-season counts

    [Fact]
    public void TheAutomaticNextSeasonCountsGroupedVersionsOnceAndStillAsksForTheMissingEpisode()
    {
        using var rig = new Rig(Layout.GroupedFolders, Has.Both, movie: false);
        foreach (var copy in new[] { rig.HdCopy, rig.UhdCopy }) rig.View.EpisodesBySeries[copy].RemoveAll(e => e.Episode.Episode == 2);
        var recorder = new AutoRequestRecorder(null!, rig.View, null, () => rig.Arr.Now);
        // HD E1 and 4K E1 are one episode; E2 has no file anywhere.
        Assert.Equal(1, recorder.EpisodesInLibrary(Firefly, 1, rig.Member.UserId));
        Assert.False(rig.Service.Editions.AvailableRange(rig.Member, Firefly, 1, 1, 2, Edition.Standard));
        Assert.False(SeasonInLibrary(recorder, Firefly, 1, 2, rig.Member.UserId));
        Assert.True(SeasonInLibrary(recorder, Firefly, 1, 1, rig.Member.UserId));
    }

    [Fact]
    public void TheAutomaticNextSeasonCountsAMultiEpisodeFileAsEveryEpisodeItCovers()
    {
        using var rig = new Rig(Layout.SeparateLibraries, Has.Hd, movie: false, multiEpisode: true);
        var recorder = new AutoRequestRecorder(null!, rig.View, null, () => rig.Arr.Now);
        Assert.Equal(2, recorder.EpisodesInLibrary(Firefly, 1, rig.Member.UserId));
        Assert.True(SeasonInLibrary(recorder, Firefly, 1, 2, rig.Member.UserId));
        // A stub covers nothing.
        rig.View.Placeholders.Add(rig.View.EpisodesBySeries[rig.HdCopy][0].Episode.ItemId);
        Assert.Equal(0, recorder.EpisodesInLibrary(Firefly, 1, rig.Member.UserId));
        Assert.False(SeasonInLibrary(recorder, Firefly, 1, 2, rig.Member.UserId));
    }

    // ------------------------------------------------------------------ ED-AX-15: a season card's statistics

    private static async Task<JsonElementSummary> SeasonCard(Rig rig, JsonObject? queueRow, int episodeCount, int fileCount)
    {
        rig.View.EpisodesBySeries[rig.HdCopy].Clear();
        rig.Sonarr.Series[0]["seasons"] = new JsonArray(new JsonObject
        {
            ["seasonNumber"] = 1, ["monitored"] = true,
            ["statistics"] = new JsonObject { ["episodeCount"] = episodeCount, ["episodeFileCount"] = fileCount, ["totalEpisodeCount"] = episodeCount },
        });
        if (queueRow != null) rig.Sonarr.Queue.Add(queueRow);
        var page = M.SeasonPage(rig, rig.HdCopy);
        await rig.Service.ForBatchAsync(rig.Member, new[] { page }, Array.Empty<TitleKey>(), default);
        await Task.Delay(30);
        var card = Assert.Single(M.Items(await rig.Service.ForBatchAsync(rig.Member, new[] { page }, Array.Empty<TitleKey>(), default)));
        var summary = card.GetProperty("summary");
        int Of(string name) => summary.TryGetProperty(name, out var v) ? v.GetInt32() : 0;
        return new JsonElementSummary(Of("aired"), Of("ready"), Of("downloading"), Of("almostReady"), Of("missing"), summary.ToString());
    }

    private sealed record JsonElementSummary(int Aired, int Ready, int Downloading, int AlmostReady, int Missing, string Text);

    [Fact]
    public async Task ASeasonCardCountsAnImportingEpisodeOnce()
    {
        using var rig = new Rig(Layout.SeparateLibraries, Has.Hd, movie: false);
        var queue = FakeArr.SonarrQueueRow(101, "importing-e1", 1, 1, "Firefly", 78874);
        queue["status"] = "completed";
        queue["trackedDownloadState"] = "importing";
        var s = await SeasonCard(rig, queue, episodeCount: 1, fileCount: 1);
        output.WriteLine(s.Text);
        Assert.Equal((1, 1), (s.Aired, s.AlmostReady));
    }

    [Fact]
    public async Task ASeasonCardNeverCountsMoreEpisodesThanAired()
    {
        // Sonarr has files for both episodes (Jellyfin has neither yet) and E1 is downloading again: E1 is one episode.
        using var rig = new Rig(Layout.SeparateLibraries, Has.Hd, movie: false);
        var queue = FakeArr.SonarrQueueRow(101, "again-e1", 1, 1, "Firefly", 78874);
        var s = await SeasonCard(rig, queue, episodeCount: 2, fileCount: 2);
        output.WriteLine(s.Text);
        Assert.Equal(2, s.Aired);
        Assert.True(s.Ready + s.Downloading + s.AlmostReady + s.Missing <= s.Aired, s.Text);
        Assert.Equal(1, s.Downloading);
    }

    // ------------------------------------------------------------------ ED-AX-17: interval coverage

    [Fact]
    public void ARangeEndingAtTheLastPossibleEpisodeIsCovered()
    {
        using var rig = new Rig(Layout.OneItem, Has.Hd, false);
        rig.View.EpisodesBySeries[rig.HdCopy].Clear();
        rig.View.AddEpisodeFile(rig.HdCopy, Firefly, 1, 1, 1920, 1080, episodeEnd: int.MaxValue);
        Assert.True(rig.Service.Editions.Available(rig.Member, Firefly.WithEpisode(1, int.MaxValue), Edition.Standard));
        Assert.True(rig.Service.Editions.AvailableRange(rig.Member, Firefly, 1, int.MaxValue, int.MaxValue, Edition.Standard));
        Assert.True(rig.Service.Editions.AvailableRange(rig.Member, Firefly, 1, int.MaxValue - 1, int.MaxValue, Edition.Standard));
    }

    [Fact]
    public async Task RangeCoverageWorksByIntervalsNotBySpan()
    {
        using var rig = new Rig(Layout.OneItem, Has.Hd, false);
        rig.View.EpisodesBySeries[rig.HdCopy].Clear();
        // Two adjacent files cover 1..int.MaxValue; a third season has a gap at 6.
        rig.View.AddEpisodeFile(rig.HdCopy, Firefly, 1, 1, 1920, 1080, episodeEnd: 1000);
        rig.View.AddEpisodeFile(rig.HdCopy, Firefly, 1, 1001, 1920, 1080, episodeEnd: int.MaxValue);
        rig.View.AddEpisodeFile(rig.HdCopy, Firefly, 2, 1, 1920, 1080, episodeEnd: 5);
        rig.View.AddEpisodeFile(rig.HdCopy, Firefly, 2, 7, 1920, 1080, episodeEnd: int.MaxValue);
        var whole = Task.Run(() => rig.Service.Editions.AvailableRange(rig.Member, Firefly, 1, 1, int.MaxValue, Edition.Standard));
        var gap = Task.Run(() => rig.Service.Editions.AvailableRange(rig.Member, Firefly, 2, 1, int.MaxValue, Edition.Standard));
        Assert.True(await whole.WaitAsync(TimeSpan.FromSeconds(10)));
        Assert.False(await gap.WaitAsync(TimeSpan.FromSeconds(10)));
        Assert.True(rig.Service.Editions.AvailableRange(rig.Member, Firefly, 2, 1, 5, Edition.Standard));
        Assert.True(rig.Service.Editions.AvailableRange(rig.Member, Firefly, 2, 7, int.MaxValue, Edition.Standard));
        Assert.False(rig.Service.Editions.AvailableRange(rig.Member, Firefly, 2, 5, 7, Edition.Standard));
        Assert.False(rig.Service.Editions.AvailableRange(rig.Member, Firefly, 2, 3, 2, Edition.Standard));
    }
}
