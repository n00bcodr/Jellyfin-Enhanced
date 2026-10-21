using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Moq;

namespace JE.Tests;

/// <summary>
/// Review round 22 (freshness belongs to the one delivery gate; the verdict identity is every input with its revision;
/// memos of verdict inputs are keyed on input revisions). Round 21 re-read the policy files at a few named sites, so the
/// tag cache's review lookups ran after its check (D46-R22-1), a poster compared only the policy file while the episode's
/// watched state changed (D46-R22-2), a negative "not an extra" memo outlived the item being attached to a guarded series
/// (D46-R22-3), and the native gate looked items up after its policy read (D46-R22-4). Uses only the endpoints' and filters'
/// existing surface (the gate is named, not referenced), so the same file runs against the pre-fix build.
/// </summary>
[Collection("Plugin singleton")]
public class PrivacyReviewRound22Tests
{
    // ---------------------------------------------------------------------------------------------------------------
    // Shape 1: every protected answer leaves through the one delivery gate, after its last blocking step.

    [Fact]
    public void EveryProtectedEmitterReachesTheDeliveryGateAfterItsLastBlockingStep()
    {
        var scan = PrivacyDeliveryScan.Run();
        Assert.True(scan.Emitters.Count > 0, "no emitter derived");
        var ungated = scan.Emitters.Where(e => e.Covered == null).ToList();
        Assert.True(ungated.Count == 0, ungated.Count + " protected emitters reach no delivery gate:\n" + string.Join("\n", ungated.Select(e => e.Name)));
        Assert.True(scan.Gate != null, "the plugin has no delivery gate (Services.PrivacyDelivery)");
        Assert.True(scan.LateSteps.Count == 0, "blocking steps after the gate call:\n" + string.Join("\n", scan.LateSteps));
    }

    [Fact]
    public void TheDerivedEmittersAreListed()
    {
        // The table the report carries (JE_DELIVERY_SCAN_OUT names a file to write it to).
        var scan = PrivacyDeliveryScan.Run();
        var lines = scan.Emitters.Select(e => e.Name + "\t" + (e.Covered ?? "NONE")).OrderBy(l => l, StringComparer.Ordinal).ToList();
        if (Environment.GetEnvironmentVariable("JE_DELIVERY_SCAN_OUT") is { Length: > 0 } path) File.WriteAllLines(path, lines);
        Assert.NotEmpty(lines);
    }

    /// <summary>An emitter that reads a policy, looks an item up after its check and answers (the shape of D46-R22-1/-4).</summary>
    private static class PlantedEmitter
    {
        public static object Answer(UserConfigurationManager manager, ILibraryManager library, Guid viewer)
        {
            var policy = HiddenContentPolicy.Load(manager, viewer);
            var item = library.GetItemById(viewer);
            return policy.IsEmpty ? item : new object();
        }
    }

    [Fact]
    public void TheScanFindsAnEmitterWithoutTheGate()
    {
        var scan = PrivacyDeliveryScan.Run([typeof(PlantedEmitter).GetMethod(nameof(PlantedEmitter.Answer))!], typeof(PlantedEmitter).Assembly);
        Assert.Contains(scan.Emitters, e => e.Name.EndsWith("PlantedEmitter.Answer", StringComparison.Ordinal) && e.Covered == null);
    }

    /// <summary>A stand-in gate and a method that looks an item up after calling it (the scan's late-step control).</summary>
    private static class StandInGate
    {
        public static bool Current(Guid viewer) => viewer != Guid.Empty;
    }

    private static class PlantedLateStep
    {
        public static object? Answer(ILibraryManager library, Guid viewer)
            => StandInGate.Current(viewer) ? library.GetItemById(viewer) : null;
    }

    [Fact]
    public void TheScanFindsABlockingStepAfterTheGate()
    {
        var scan = PrivacyDeliveryScan.Run([], typeof(PlantedLateStep).Assembly, typeof(StandInGate));
        Assert.Contains(scan.LateSteps, l => l.Contains("PlantedLateStep.Answer", StringComparison.Ordinal) && l.Contains("GetItemById", StringComparison.Ordinal));
        Assert.DoesNotContain(scan.LateSteps, l => !l.Contains("PlantedLateStep", StringComparison.Ordinal));
    }

    private static int _authors;

    /// <summary>A review whose author the tag cache resolves (the first lookup of a new author) runs <paramref name="during"/>.</summary>
    private static void ReviewLookupRuns(PrivacyReviewRound19Tests.TagSite site, Action during)
    {
        var config = site.Fixture.Plugin.Configuration;
        config.ShowUserReviews = true; config.ShowUserRatingOnPosters = true;
        var author = new Jellyfin.Database.Implementations.Entities.User("author" + Interlocked.Increment(ref _authors), "default", "default") { Id = Guid.NewGuid() };
        site.Fixture.Core.Manager.UpsertReview(author.Id.ToString("N"), "tv", "1399", "Fine", 4, "2026-10-21T00:00:00Z");
        var armed = true;
        site.Users.Setup(u => u.GetUserById(author.Id)).Returns(() =>
        {
            if (armed) { armed = false; during(); }
            return author;
        });
    }

    [Fact]
    public async Task GuardingASeriesWhileTheTagCachesReviewRatingsLoadDeliversNoProtectedText()
    {
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: false, stripTags: true, extras: true);
        ReviewLookupRuns(site, () => site.Guard(site.Series));
        var (status, body, _) = await site.TagCacheResponse();
        Assert.Equal(200, status);
        var leaked = site.Sentinels.In(body).Where(p => p.StartsWith("episode", StringComparison.Ordinal) || p.StartsWith("seriesExtra", StringComparison.Ordinal)).ToList();
        Assert.True(leaked.Count == 0, "tag cache: " + leaked.Count + " guarded members delivered, e.g. " + string.Join(", ", leaked.Take(20)));
        Assert.NotNull(JsonNode.Parse(body)!["reviewRatings"]);
    }

    [Fact]
    public async Task ARevalidationDuringTheReviewLookupIsNotAnswered304()
    {
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: false, stripTags: true, extras: true);
        var config = site.Fixture.Plugin.Configuration;
        config.ShowUserReviews = true; config.ShowUserRatingOnPosters = true;
        var (_, open, etag) = await site.TagCacheResponse();
        Assert.Contains(site.Sentinels.Planted.Keys, k => open.Contains(k, StringComparison.Ordinal));
        ReviewLookupRuns(site, () => site.Guard(site.Series));
        var (status, body, fresh) = await site.TagCacheResponse(ifNoneMatch: etag);
        Assert.Equal(200, status);
        Assert.NotEqual(etag, fresh);
        Assert.DoesNotContain(site.Sentinels.In(body), p => p.StartsWith("episode", StringComparison.Ordinal));
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Shape 2: the verdict identity is every input with its revision (policies, the item's watched state, its ownership).

    private static Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.PosterTagComposer Composer(PrivacyReviewRound19Tests.TagSite site)
    {
        var logger = site.Fixture.Core.Logger;
        var provider = new Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.PosterTagDataProvider(site.Cache, site.Library.Object, site.Stripper, site.Resolver,
            new Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.PosterTagReviewRatings(site.Fixture.Core.Manager, new Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.PosterTagUserCache(site.Users.Object), logger), null!, logger);
        return new Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.PosterTagComposer(provider,
            Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.CompositeImageCache.Create(null, 1 << 20, 0, 1, TimeSpan.FromSeconds(5), _ => { }),
            Microsoft.Extensions.DependencyInjection.ServiceCollectionContainerBuilderExtensions.BuildServiceProvider(new Microsoft.Extensions.DependencyInjection.ServiceCollection()));
    }

    [Fact]
    public async Task AGuardedEpisodeMarkedUnwatchedWhileItsPosterRendersIsDrawnStripped()
    {
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: false, stripTags: true);
        site.Guard(site.Series);
        site.SetPlayed(site.Episode, true);
        var composer = Composer(site);
        var settings = Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.PosterTagSettings.Create(null, site.Fixture.Plugin.Configuration);
        var loading = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var arrive = new TaskCompletionSource<byte[]>(TaskCreationOptions.RunContinuationsAsynchronously);
        var image = new Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.PosterTagBaseImage("image/jpeg", "r23", () => { loading.TrySetResult(); return arrive.Task; });
        var compose = composer.ComposeAsync(new Microsoft.AspNetCore.Http.DefaultHttpContext(), site.Items[site.Episode], site.Alice, settings, false, image, 90, useCache: false, CancellationToken.None);
        await loading.Task.WaitAsync(TimeSpan.FromSeconds(10));
        site.SetPlayed(site.Episode, false);
        arrive.SetResult([]);
        var result = await compose.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.True(result.SpoilerStripped, "the poster of an episode marked unwatched while it rendered is drawn from its stripped data");

        // Control: a watched episode's poster, with nothing changing, keeps its tags.
        var steady = await composer.ComposeAsync(new Microsoft.AspNetCore.Http.DefaultHttpContext(), site.Items[site.Episode], site.Alice, settings, false,
            new Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.PosterTagBaseImage("image/jpeg", "r23b", () => Task.FromResult(Array.Empty<byte>())), 90, useCache: false, CancellationToken.None);
        Assert.True(steady.SpoilerStripped, "still unwatched");
        site.SetPlayed(site.Episode, true);
        var watched = await composer.ComposeAsync(new Microsoft.AspNetCore.Http.DefaultHttpContext(), site.Items[site.Episode], site.Alice, settings, false,
            new Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.PosterTagBaseImage("image/jpeg", "r23c", () => Task.FromResult(Array.Empty<byte>())), 90, useCache: false, CancellationToken.None);
        Assert.False(watched.SpoilerStripped, "a watched episode's poster keeps its tags");
    }

    [Fact]
    public async Task AGuardedEpisodeMarkedUnwatchedWhileTheTagCacheComposesIsStripped()
    {
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: true, stripTags: true);
        site.SetPlayed(site.Episode, true);
        var (_, watched, _) = await site.TagCacheResponse();
        Assert.Contains(site.Sentinels.In(watched), p => p.StartsWith("episodeEntry", StringComparison.Ordinal));
        // The bounded played-state query answers "watched", then the viewer marks the episode unwatched before the answer leaves.
        var armed = true;
        site.Library.Setup(x => x.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
        {
            if (q.IsPlayed != true) return [site.Movie, site.Episode, site.Season];
            var played = (q.ItemIds ?? []).Where(site.Played.Contains).ToArray();
            if (armed) { armed = false; site.SetPlayed(site.Episode, false); }
            return played;
        });
        var (status, body, _) = await site.TagCacheResponse();
        Assert.Equal(200, status);
        var leaked = site.Sentinels.In(body).Where(p => p.StartsWith("episodeEntry", StringComparison.Ordinal)).ToList();
        Assert.True(leaked.Count == 0, "tag cache: " + string.Join(", ", leaked.Take(20)));
    }

    [Fact]
    public async Task AnUnrelatedWatchedChangeNeverWithholdsTheAnswer()
    {
        // Another viewer's saves, and this viewer's saves of items the answer does not hold, move none of its verdicts.
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: true, stripTags: true);
        var other = Guid.NewGuid();
        site.Items[other] = new MediaBrowser.Controller.Entities.Movies.Movie { Id = other };
        var calls = 0;
        site.Library.Setup(x => x.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
        {
            if (q.IsPlayed != true) return [site.Movie, site.Episode, site.Season];
            calls++;
            site.SetPlayed(other, calls % 2 == 0);
            site.UserData.Raise(d => d.UserDataSaved += null, site.UserData.Object, new UserDataSaveEventArgs
            {
                UserId = Guid.NewGuid(), Item = site.Items[site.Episode], SaveReason = UserDataSaveReason.TogglePlayed, UserData = new UserItemData { Key = "k" },
            });
            return (q.ItemIds ?? []).Where(site.Played.Contains).ToArray();
        });
        var (status, body, _) = await site.TagCacheResponse();
        Assert.Equal(200, status);
        Assert.Equal(1, calls);
        Assert.Contains(site.Episode.ToString("N"), body, StringComparison.Ordinal);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Shape 3: memos of verdict inputs are keyed on input revisions (library ownership events), never content timestamps.

    private static Video Unowned(PrivacyReviewRound19Tests.TagSite site)
    {
        var video = (Video)site.Items[site.SeriesExtra];
        video.OwnerId = Guid.Empty;
        video.ExtraType = null;
        return video;
    }

    private static string FilterRevision(string body) => JsonNode.Parse(body)!["filterRevision"]!.ToString();

    [Fact]
    public async Task AnUnownedVideoAttachedToAGuardedSeriesIsStrippedOnTheNextLoads()
    {
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: true, stripTags: true, extras: true);
        var video = Unowned(site);
        bool Leaks(string body) => site.Sentinels.In(body).Any(p => p.StartsWith("seriesExtra", StringComparison.Ordinal));
        var (_, before, _) = await site.TagCacheResponse();
        Assert.True(Leaks(before), "an unowned video is nobody's extra: its own values");
        var (_, delta0, _) = await site.TagCacheResponse(since: 150);
        Assert.Equal(FilterRevision(before), FilterRevision(delta0));

        // A library refresh attaches it to the guarded series (the host saves the item and raises ItemUpdated).
        video.OwnerId = site.Series;
        video.ExtraType = ExtraType.Featurette;
        site.Updated(site.SeriesExtra);

        var (_, delta, _) = await site.TagCacheResponse(since: 150);
        Assert.NotEqual(FilterRevision(before), FilterRevision(delta));
        Assert.False(Leaks(delta), "the delta strips the newly attached extra");
        var (_, full, _) = await site.TagCacheResponse();
        Assert.False(Leaks(full), "the full load strips the newly attached extra");
        Assert.Equal(FilterRevision(full), FilterRevision(delta));
        Assert.Contains(site.SeriesExtra.ToString("N"), full, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnEntryTheLibraryCouldNotResolveIsNeverRememberedAsNotAnExtra()
    {
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: true, stripTags: true, extras: true);
        // The library cannot resolve the guarded series' extra for a moment (a scan replacing it), then can again, unchanged.
        var extra = site.Items[site.SeriesExtra];
        site.Items.Remove(site.SeriesExtra);
        await site.TagCacheResponse();
        site.Items[site.SeriesExtra] = extra;
        var (_, body, _) = await site.TagCacheResponse();
        var leaked = site.Sentinels.In(body).Where(p => p.StartsWith("seriesExtra", StringComparison.Ordinal)).ToList();
        Assert.True(leaked.Count == 0, "tag cache: " + string.Join(", ", leaked.Take(20)));
        var (_, delta, _) = await site.TagCacheResponse(since: 150);
        Assert.Equal(FilterRevision(body), FilterRevision(delta));
    }

    /// <summary>
    /// The host's 10.11.11 shape (live, D46 r23): a clip in another library's folder that the owner's scan attaches is
    /// owned in the host's live item (and listed in the owner's extras) while its stored row, which the batched lookup
    /// reads, still names no owner.
    /// </summary>
    private static Video StaleRow(PrivacyReviewRound19Tests.TagSite site)
    {
        var video = (Video)site.Items[site.SeriesExtra];
        video.Path = "/media/Guarded show/featurettes/" + Path.GetFileName(video.Path);
        var row = new Video { Id = video.Id, Name = video.Name, Path = video.Path };
        site.Library.Setup(x => x.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
            (q.ItemIds ?? []).Select(i => i == site.SeriesExtra ? row : site.Items.GetValueOrDefault(i)).OfType<BaseItem>().ToList());
        return video;
    }

    [Fact]
    public async Task AnExtraTheHostServesAheadOfItsStoredRowIsJudgedByTheHostsLiveItem()
    {
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: true, stripTags: true, extras: true);
        StaleRow(site);
        var (_, body, _) = await site.TagCacheResponse();
        var leaked = site.Sentinels.In(body).Where(p => p.StartsWith("seriesExtra", StringComparison.Ordinal)).ToList();
        Assert.True(leaked.Count == 0, "tag cache: " + string.Join(", ", leaked.Take(20)));
    }

#if NET9_0
    [Fact]
    public async Task OnTenElevenTheOwnersExtrasListingTheClipInvalidatesItsMemo()
    {
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: true, stripTags: true, extras: true);
        var video = StaleRow(site);
        video.OwnerId = Guid.Empty;
        video.ExtraType = null;
        var (_, before, _) = await site.TagCacheResponse();
        Assert.Contains(site.Sentinels.In(before), p => p.StartsWith("seriesExtra", StringComparison.Ordinal));
        // The owner's scan attaches the clip in memory and saves the owner with its extras (not the clip's own row).
        video.OwnerId = site.Series;
        video.ExtraType = ExtraType.Featurette;
        site.Items[site.Series].ExtraIds = [site.SeriesExtra];
        site.Updated(site.Series);
        var (_, after, _) = await site.TagCacheResponse();
        var leaked = site.Sentinels.In(after).Where(p => p.StartsWith("seriesExtra", StringComparison.Ordinal)).ToList();
        Assert.True(leaked.Count == 0, "tag cache: " + string.Join(", ", leaked.Take(20)));
    }

    [Fact]
    public async Task OnTenElevenAnExtraListedOnlyByItsOwnersExtrasIsTheOwners()
    {
        // After a restart 10.11 still lists the clip in the guarded show's saved extras (and serves it as the show's
        // featurette) while neither the clip's row nor its live item names an owner.
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: true, stripTags: true, extras: true);
        var video = StaleRow(site);
        video.OwnerId = Guid.Empty;
        video.ExtraType = null;
        var series = site.Items[site.Series];
        series.Path = "/media/Guarded show";
        series.ExtraIds = [site.SeriesExtra];
        site.Library.Setup(x => x.FindByPath("/media/Guarded show", It.IsAny<bool?>())).Returns(series);
        var (_, body, _) = await site.TagCacheResponse();
        var leaked = site.Sentinels.In(body).Where(p => p.StartsWith("seriesExtra", StringComparison.Ordinal)).ToList();
        Assert.True(leaked.Count == 0, "tag cache: " + string.Join(", ", leaked.Take(20)));
        Assert.DoesNotContain(site.Sentinels.In(site.TagData(site.SeriesExtra)), p => p.StartsWith("seriesExtra", StringComparison.Ordinal));
    }
#endif

    [Fact]
    public async Task AVideoAttachedWhileItsPosterTagsAreComposedIsStripped()
    {
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: true, stripTags: true, extras: true);
        var video = Unowned(site);
        var composer = Composer(site);
        var settings = Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.PosterTagSettings.Create(null, site.Fixture.Plugin.Configuration);
        var first = await composer.ComposeAsync(new Microsoft.AspNetCore.Http.DefaultHttpContext(), video, site.Alice, settings, false,
            new Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.PosterTagBaseImage("image/jpeg", "r23d", () => Task.FromResult(Array.Empty<byte>())), 90, useCache: false, CancellationToken.None);
        Assert.False(first.SpoilerStripped, "an unowned video's poster keeps its tags");
        var loading = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var arrive = new TaskCompletionSource<byte[]>(TaskCreationOptions.RunContinuationsAsynchronously);
        var compose = composer.ComposeAsync(new Microsoft.AspNetCore.Http.DefaultHttpContext(), video, site.Alice, settings, false,
            new Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.PosterTagBaseImage("image/jpeg", "r23e", () => { loading.TrySetResult(); return arrive.Task; }), 90, useCache: false, CancellationToken.None);
        await loading.Task.WaitAsync(TimeSpan.FromSeconds(10));
        video.OwnerId = site.Series;
        video.ExtraType = ExtraType.Featurette;
        site.Updated(site.SeriesExtra);
        arrive.SetResult([]);
        Assert.True((await compose.WaitAsync(TimeSpan.FromSeconds(10))).SpoilerStripped, "attached to the guarded series while it rendered");
    }

    // ---------------------------------------------------------------------------------------------------------------
    // D46-R22-4 (and the gate's other paths): a rule saved while the gate looks the answer's items up applies.

    private static PrivacyHostShapeModelTests.Rule Rule(string id) => PrivacyHostShapeModelTests.Rules.Single(r => r.Id == id);

    /// <summary>The final gate alone, with <paramref name="during"/> run on its first library lookup of the answer's items.</summary>
    private static (IActionResult Result, string Body) GateWithLookup(PrivacyHostShapeModelTests.Rig rig, PrivacyHostShapeModelTests.Shot shot, Action during)
    {
        var viewer = shot.Viewer == "viewer" ? rig.Viewer : rig.Admin;
        var armed = true;
        rig.Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
        {
            var found = (q.ItemIds ?? []).Select(id => rig.Items.GetValueOrDefault(id)).OfType<BaseItem>().ToList();
            if (armed && found.Count > 0) { armed = false; during(); }
            return found;
        });
        var context = PrivacyHostShapeModelTests.Context(shot, viewer);
        var result = new ObjectResult(PrivacyHostShapeModelTests.Value(shot));
        var delivery = new ResultExecutingContext(context, new List<IFilterMetadata>(), result, new object());
        rig.Gate().OnResultExecuting(delivery);
        var value = (delivery.Result as ObjectResult)?.Value;
        return (delivery.Result, value == null ? "" : JsonSerializer.Serialize(value, value.GetType(), PrivacyHostShapeModelTests.Json));
    }

    [Theory]
    [InlineData("TvShows.GetEpisodes.json", "sg-series")]
    [InlineData("Items.GetItems.json", "hc-movie")]
    [InlineData("Search.GetSearchHints.titles.json", "hc-movie")]
    [InlineData("ActivityLog.GetLogEntries.json", "hc-movie")]
    public void ARuleSavedWhileTheNativeGateLooksItemsUpApplies(string file, string ruleId)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var shot = PrivacyHostShapeModelTests.Data.Shots.Single(s => s.File == file);
        var rule = Rule(ruleId);
        var viewer = shot.Viewer == "viewer" ? rig.Viewer : rig.Admin;
        var original = PrivacyHostShapeModelTests.Resource(file);
        Assert.Contains(rule.Subject, s => original.Contains(s, StringComparison.Ordinal));
        var (result, body) = GateWithLookup(rig, shot, () => rig.Commit(rule, viewer));
        Assert.IsAssignableFrom<ObjectResult>(result);
        foreach (var text in rule.Subject) Assert.DoesNotContain(text, body);
        foreach (var text in rule.Control.Where(s => original.Contains(s, StringComparison.Ordinal))) Assert.Contains(text, body);
    }

    [Fact]
    public void AnEpisodeMarkedUnwatchedWhileItsNativeAnswerIsBuiltIsStripped()
    {
        // The host builds the answer with the viewer's watched state of that moment (the DTO's own user data), the viewer
        // marks the episode unwatched before the answer is delivered: the delivered episode is stripped.
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var shot = PrivacyHostShapeModelTests.Data.Shots.Single(s => s.File == "TvShows.GetEpisodes.json");
        var viewer = shot.Viewer == "viewer" ? rig.Viewer : rig.Admin;
        rig.Commit(Rule("sg-series"), viewer);
        var episode = PrivacyHostShapeModelTests.G(PrivacyHostShapeModelTests.Data.Roles["episode:show-e1"]);
        var context = PrivacyHostShapeModelTests.Context(shot, viewer);
        var filters = new List<IFilterMetadata>();
        var gate = rig.Gate();
        gate.OnResourceExecuting(new ResourceExecutingContext(context, filters, new List<Microsoft.AspNetCore.Mvc.ModelBinding.IValueProviderFactory>()));
        // The action: the host's answer says "watched" (its user data for this viewer at the time it was built).
        rig.Played.Add((viewer, episode));
        var answer = (MediaBrowser.Model.Querying.QueryResult<MediaBrowser.Model.Dto.BaseItemDto>)PrivacyHostShapeModelTests.Value(shot);
        foreach (var dto in answer.Items.Where(i => i.Id == episode)) dto.UserData = new MediaBrowser.Model.Dto.UserItemDataDto { Played = true, Key = "k", ItemId = episode };
        rig.Played.Remove((viewer, episode));
        rig.UserData.Raise(d => d.UserDataSaved += null, rig.UserData.Object, new UserDataSaveEventArgs
        {
            UserId = viewer, Item = rig.Items[episode], SaveReason = UserDataSaveReason.TogglePlayed, UserData = new UserItemData { Key = "k", Played = false },
        });
        var delivery = new ResultExecutingContext(context, filters, new ObjectResult(answer), new object());
        gate.OnResultExecuting(delivery);
        var value = Assert.IsAssignableFrom<ObjectResult>(delivery.Result).Value!;
        var body = JsonSerializer.Serialize(value, value.GetType(), PrivacyHostShapeModelTests.Json);
        var delivered = JsonNode.Parse(body)!["Items"]!.AsArray().Single(i => i!["Id"]!.ToString() == episode.ToString("N"))!;
        Assert.DoesNotContain("Secret plot r17 episode", delivered.ToJsonString(), StringComparison.Ordinal);
    }

    [Fact]
    public void ARuleSavedWhileAJsonFeedsRowsAreResolvedApplies()
    {
        // JE's own activity feed: the final gate resolves each row's item, then projects the feed's JSON.
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var hidden = PrivacyHostShapeModelTests.G(PrivacyHostShapeModelTests.Data.Roles["movie:hidden"]);
        var plain = rig.Items.Values.OfType<MediaBrowser.Controller.Entities.Movies.Movie>().First(m => m.Id != hidden).Id;
        var armed = true;
        rig.Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
        {
            var found = (q.ItemIds ?? []).Select(id => rig.Items.GetValueOrDefault(id)).OfType<BaseItem>().ToList();
            if (armed && found.Count > 0) { armed = false; rig.Commit(Rule("hc-movie"), rig.Viewer); }
            return found;
        });
        var http = new Microsoft.AspNetCore.Http.DefaultHttpContext { User = TestCallers.Principal(rig.Viewer, false) };
        http.Request.Method = "GET";
        var descriptor = new Microsoft.AspNetCore.Mvc.Controllers.ControllerActionDescriptor
        {
            ControllerTypeInfo = typeof(Jellyfin.Plugin.JellyfinEnhanced.Controllers.JellyfinEnhancedController).GetTypeInfo(), ActionName = "GetActivityFeed",
            AttributeRouteInfo = new Microsoft.AspNetCore.Mvc.Routing.AttributeRouteInfo { Template = "JellyfinEnhanced/activity" },
        };
        var context = new ActionContext(http, new Microsoft.AspNetCore.Routing.RouteData(), descriptor);
        var feed = new { items = new[] { hidden, plain }.Select(id => new { type = "watched", item = new { id = id.ToString("N"), name = rig.Items[id].Name } }).ToArray() };
        var delivery = new ResultExecutingContext(context, new List<IFilterMetadata>(), new ObjectResult(feed), new object());
        rig.Gate().OnResultExecuting(delivery);
        var body = Assert.IsType<ContentResult>(delivery.Result).Content!;
        Assert.DoesNotContain(hidden.ToString("N"), body, StringComparison.Ordinal);
        Assert.Contains(plain.ToString("N"), body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ARuleSavedWhileSessionsAreProjectedApplies()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var shot = PrivacyHostShapeModelTests.Data.Shots.Single(s => s.File == "Session.GetSessions.admin.json");
        var rule = Rule("hc-movie");
        // A rule already applies (so the projection looks the sessions' items up); the movie is hidden during that lookup.
        rig.Commit(Rule("hc-program-later"), rig.Admin);
        var armed = true;
        rig.Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
        {
            var found = (q.ItemIds ?? []).Select(id => rig.Items.GetValueOrDefault(id)).OfType<BaseItem>().ToList();
            if (armed && found.Count > 0) { armed = false; rig.Commit(rule, rig.Admin); }
            return found;
        });
        var sessions = (List<MediaBrowser.Model.Dto.SessionInfoDto>)PrivacyHostShapeModelTests.Value(shot);
        var sent = rig.Gate().ProjectSessions(sessions, rig.Admin);
        await Task.CompletedTask;
        var body = JsonSerializer.Serialize(sent, typeof(IReadOnlyList<MediaBrowser.Model.Dto.SessionInfoDto>), PrivacyHostShapeModelTests.Json);
        foreach (var text in rule.Subject) Assert.DoesNotContain(text, body);
    }
}
