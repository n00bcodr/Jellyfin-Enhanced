using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Microsoft.AspNetCore.Http;
using R = JE.Tests.IntegrationEditionAvailabilityTests;
using M = JE.Tests.IntegrationEditionMaskedTests;

namespace JE.Tests;

/// <summary>
/// Edition round 19, part A (D53: every response proven fresh at publication). Every route that returns copy facts takes
/// what Jellyfin decides for the viewer (who they are now, what they may open, what the library hides from them, what Hidden
/// Content hides, the edition settings) after its last await, and answers from that or fails closed; a cached answer is filed
/// under every one of those revisions. "Deleted", "hidden from this viewer" and "unknown" are three different things: only a
/// deleted item hands over to another copy.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationEditionFreshnessTests
{
    private static readonly TitleKey Movie = TitleKey.Parse("movie:tmdb:45745")!;
    private static readonly TitleKey Tv = TitleKey.Parse("tv:tvdb:78874")!;

    // ------------------------------------------------------------------ ED-AX-2: Discover and search

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ADiscoverOrSearchCardNeverNamesACopyTheViewerLostDuringTheMetadataRead(bool search)
    {
        using var r = new IntegrationRequestLedgerTests.Rig();
        var viewer = r.View.Users[r.Kid];
        var copy = Guid.NewGuid();
        var key = TitleKey.Parse("movie:tmdb:1")!;
        r.View.AddCopy(key, new JfCopy { ItemId = copy, Path = "/media/restricted/movie.mkv", LibraryName = "Restricted" });
        r.View.AddItem(new JfItemRef { ItemId = copy, Kind = "movie", Key = key, Path = "/media/restricted/movie.mkv" });
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var service = new DiscoverService(r.Service, null, (_, _, _, _) => Task.FromResult(false),
            async (_, _, _) => { entered.TrySetResult(); await release.Task; return IntegrationRequestDiscoverTests.Page(IntegrationRequestDiscoverTests.Movie(1, "Restricted film")); },
            (_, _) => Array.Empty<RecentTitle>(), _ => HiddenTitles.None, () => r.Now);
        var controller = new AcquireDiscoverController(service) { ControllerContext = new() { HttpContext = new DefaultHttpContext() } };
        controller.HttpContext.User = TestCallers.Principal(r.Kid, false);
        var pending = search ? controller.Search("film", 1, null, default) : controller.Discover("trending", "movie", 1, null, default);
        await entered.Task;
        var changed = r.View.Revoke(viewer, parental: true, hide: copy);
        release.SetResult();
        var result = IntegrationRequestDiscoverTests.Read(await pending, controller);
        Assert.Null(r.View.Resolve(copy, changed));
        if (result.Status != 200) return; // failed closed
        var cards = result.Body.GetProperty("answer").GetProperty("results").EnumerateArray().ToList();
        Assert.DoesNotContain(cards, c => c.TryGetProperty("itemId", out var id) && id.GetString() == copy.ToString("N"));
        Assert.DoesNotContain(cards, c => c.GetProperty("inLibrary").GetBoolean());
    }

    // ------------------------------------------------------------------ ED-AX-3: season rows (library and absent)

    [Fact]
    public async Task SeasonRowsLeaveOutAnEpisodeTheLibraryHidFromTheViewerDuringTheMetadataRead()
    {
        using var r = new IntegrationRequestLedgerTests.Rig();
        var viewer = r.View.AddUser(false, parental: true);
        r.Policy.People[viewer.UserId] = r.Policy.People[r.Kid] with { UserId = viewer.UserId };
        var series = Guid.NewGuid(); var season = Guid.NewGuid(); var ep = Guid.NewGuid();
        r.View.AddItem(new JfItemRef { ItemId = series, Kind = "series", Key = Tv, Path = "/media/tv/Firefly" });
        r.View.AddItem(new JfItemRef { ItemId = season, Kind = "season", Key = Tv.WithSeason(1), Season = 1, SeriesId = series, TmdbId = 1437 });
        r.View.AddEpisode(series, new JfEpisode { ItemId = ep, Season = 1, Episode = 2, Virtual = true });
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var service = new SeasonRowsService(r.View, r.Ledger, r.Policy, null, async (_, _, _, _) =>
        {
            entered.TrySetResult(); await release.Task;
            return "{\"episodes\":[{\"episode_number\":2,\"name\":\"Restricted episode\",\"overview\":\"Private synopsis\"}]}";
        }, () => r.Now);
        var pending = service.ForSeasonAsync(viewer, season, null, default);
        await entered.Task;
        var old = r.View.EpisodesBySeries[series][0];
        r.View.EpisodesBySeries[series][0] = (old.Episode, new HashSet<Guid> { r.Admin });
        r.View.Rev++;
        Assert.True(Assert.Single(r.View.Episodes(series, 1, viewer, true)).Hidden);
        release.SetResult();
        var rows = await pending;
        Assert.True(rows == null || rows.Episodes.All(e => e.Title != "Restricted episode" && e.Overview != "Private synopsis" && e.Episode != 2), JsonSerializer.Serialize(rows));
    }

    [Fact]
    public async Task AbsentSeasonRowsFailClosedWhenTheLibraryChangedDuringTheMetadataRead()
    {
        using var r = new IntegrationRequestLedgerTests.Rig();
        var viewer = r.View.Users[r.Member];
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var gate = true;
        var service = new SeasonRowsService(r.View, r.Ledger, r.Policy, null, async (_, _, _, _) =>
        {
            if (gate) { entered.SetResult(); await release.Task; }
            return "{\"episodes\":[{\"episode_number\":1,\"name\":\"One\"},{\"episode_number\":2,\"name\":\"Two\",\"overview\":\"Private synopsis\"}]}";
        }, () => r.Now);
        // The page (what the library hides from the viewer) was read for the library as it was.
        var page = new AbsentTitle { PageId = Guid.NewGuid(), Kind = "season", Title = TitleKey.Parse("tv:tvdb:393189")!, TmdbId = 83867, Season = 1, SeriesPageId = Guid.NewGuid() };
        var pending = service.ForAbsentSeasonAsync(viewer, page, null, default);
        await entered.Task;
        r.View.Rev++; // a library change (an episode it now has and hides from them, say) while the metadata was read
        release.SetResult();
        Assert.Null(await pending);
        // Control: nothing changed, the rows are answered.
        gate = false;
        Assert.NotNull(await service.ForAbsentSeasonAsync(viewer, page, null, default));
    }

    // ------------------------------------------------------------------ ED-AX-13: every edition setting is in the cache key

    [Fact]
    public async Task TurningOnStandardNeedsANonFourKCopyChangesTheCachedRequestStatusAtOnce()
    {
        using var rig = new R.Rig(R.Layout.OneItem, R.Has.Uhd, true);
        var scopes = new Dictionary<TitleKey, ArrStatusService.RequestScope> { [Movie] = new(Array.Empty<int>(), false, null) };
        Task<StatusBody> Read() => rig.Service.ForTitlesAsync(rig.Member, new[] { Movie }, "fresh", "same", x => JsonSerializer.SerializeToUtf8Bytes(x.Single().Status.Stage.ToString()), default, scopes);
        await Read(); await Task.Delay(30);
        var before = await Read();
        Assert.Equal("\"ready\"", System.Text.Encoding.UTF8.GetString(before.Json));
        rig.Arr.Plugin.Plugin.Configuration.ArrStandardNeedsNonFourK = true;
        var after = await Read();
        var fresh = await rig.Requested(R.Part.Movie, false);
        Assert.NotEqual(StatusStage.Ready, fresh.Status.Stage);
        Assert.Equal(JsonSerializer.Serialize(fresh.Status.Stage.ToString()), System.Text.Encoding.UTF8.GetString(after.Json));
    }

    // ------------------------------------------------------------------ ED-AX-16: deleted, hidden and unknown are different

    [Fact]
    public void AnArrivalStaysWithItsCopyWhenTheShownItemIsHiddenAndHandsOverOnlyWhenItIsDeleted()
    {
        using var rig = new R.Rig(R.Layout.GroupedFolders, R.Has.Both, false);
        var shown = rig.View.EpisodesBySeries[rig.HdCopy].Single(x => x.Episode.Episode == 1).Episode.ItemId;
        var sibling = rig.View.EpisodesBySeries[rig.UhdCopy].Single(x => x.Episode.Episode == 1).Episode.ItemId;
        // Hidden from this viewer now (it still exists): never "deleted", so never another copy's episode.
        var changed = rig.View.Revoke(rig.Member, parental: true, hide: shown);
        Assert.NotNull(rig.View.Resolve(shown, rig.Admin));
        Assert.Null(rig.Service.ArrivedItem(changed, Tv.WithEpisode(1, 1), shown, rig.HdCopy));
        // Deleted (Jellyfin removed it once the grouped folder's file came): the grouped sibling takes over, as before.
        rig.View.EpisodesBySeries[rig.HdCopy].RemoveAll(x => x.Episode.ItemId == shown);
        rig.View.Items.Remove(shown);
        rig.View.Rev++;
        Assert.Equal(sibling, rig.Service.ArrivedItem(rig.Member, Tv.WithEpisode(1, 1), shown, rig.HdCopy));
    }

    // ------------------------------------------------------------------ the gate, over every route that returns copy facts

    /// <summary>The status routes: the viewer loses the 4K copy while the arr facts are read; nothing of it is answered.</summary>
    [Theory]
    [InlineData("item")]
    [InlineData("cards")]
    [InlineData("keys")]
    public async Task AStatusRouteAnswersOnlyWhatTheViewerMayOpenOnceItsReadsAreDone(string route)
    {
        using var rig = new R.Rig(R.Layout.SeparateLibraries, R.Has.Both, true);
        var viewer = rig.Member;
        var once = 0;
        rig.Radarr4k!.Before = (_, _) =>
        {
            if (Interlocked.Increment(ref once) == 1) viewer = rig.View.Revoke(rig.Member, parental: true, hide: rig.UhdCopy);
            return Task.CompletedTask;
        };
        switch (route)
        {
            case "item":
                Assert.Empty(M.Items(await rig.Service.ForItemAsync(rig.Member, rig.UhdCopy, default)));
                break;
            case "cards":
                Assert.Empty(M.Items(await rig.Service.ForBatchAsync(rig.Member, new[] { rig.UhdCopy }, Array.Empty<TitleKey>(), default)));
                break;
            default:
            {
                var body = await rig.Service.ForBatchAsync(rig.Member, Array.Empty<Guid>(), new[] { Movie }, default);
                Assert.DoesNotContain(rig.UhdCopy.ToString("N"), System.Text.Encoding.UTF8.GetString(body.Json));
                break;
            }
        }
        Assert.Null(rig.View.Resolve(rig.UhdCopy, viewer));
    }
}
