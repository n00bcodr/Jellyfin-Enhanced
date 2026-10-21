using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Chapters;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Moq;

namespace JE.Tests;

/// <summary>
/// Review round 23 (read-set validation; the gate guards the bytes; precision, not panic; the 10.11 ownership fallback
/// batched). Round 22's one gate validated a hand-assembled identity: a native retry reused the request's resolved
/// identities (D46-R23-1), an item's first library update after start-up was ignored (-2), strip and advanced settings were
/// not in the revision (-3), collection membership memos outlived the collection's change (-4); the gate sat at the
/// controller's return, not where bytes leave: an image load that started with the master switch off skipped it (-5), a 304
/// confirmed a cached unprotected image (-6), the tag cache's deferred writer sent after the gate (-7); every watched-state
/// save invalidated, so playback progress withheld correct answers (-8); 10.11's owner fallback looked the same folder up
/// once per clip (-9) and named a featurette "Extra" (-10). Uses only the surface the pre-fix build has, so the same file runs
/// against it.
/// </summary>
[Collection("Plugin singleton")]
public class PrivacyReviewRound23Tests
{
    private static PrivacyHostShapeModelTests.Rule Rule(string id) => PrivacyHostShapeModelTests.Rules.Single(r => r.Id == id);
    private static Guid Role(string role) => Guid.Parse(PrivacyHostShapeModelTests.Data.Roles[role]);
    private static PrivacyHostShapeModelTests.Shot Shot(string file) => PrivacyHostShapeModelTests.Data.Shots.Single(s => s.File == file);

    private static void Updated(Mock<ILibraryManager> library, BaseItem item) => library.Raise(l => l.ItemUpdated += null, library.Object,
        new ItemChangeEventArgs { Item = item, UpdateReason = ItemUpdateType.MetadataImport });

    private static string Serialize(object value) => JsonSerializer.Serialize(value, value.GetType(), PrivacyHostShapeModelTests.Json);

    /// <summary>The final gate around one native answer (resource mark first, as the host runs it); the delivered JSON.</summary>
    private static string DeliverNative(PrivacyHostShapeModelTests.Rig rig, PrivacyHostShapeModelTests.Shot shot, Guid viewer, Func<object> answer, Action? afterMark = null)
    {
        var context = PrivacyHostShapeModelTests.Context(shot, viewer);
        var gate = rig.Gate();
        gate.OnResourceExecuting(new ResourceExecutingContext(context, [], []));
        afterMark?.Invoke();
        var delivery = new ResultExecutingContext(context, [], new ObjectResult(answer()), new object());
        gate.OnResultExecuting(delivery);
        var value = Assert.IsAssignableFrom<ObjectResult>(delivery.Result).Value!;
        return Serialize(value);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Shape 1: read-set validation (every verdict input with the revision it was read at).

    [Fact]
    public void AnEpisodesFirstObservedReparentingMovesItsVerdict()
    {
        // No facts remembered for the episode (nothing judged it since the start): its first update is unknown, so changed.
        var library = new Mock<ILibraryManager>();
        PrivacyInputs.Observe(library.Object, null);
        var episode = new Episode { Id = Guid.NewGuid(), SeriesId = Guid.NewGuid(), SeasonId = Guid.NewGuid() };
        var since = PrivacyInputs.Now;
        episode.SeriesId = Guid.NewGuid();
        Updated(library, episode);
        Assert.True(PrivacyInputs.ChangedSince(since, Guid.NewGuid(), id => id == episode.Id), "the episode's first update after the start (new series) moved no verdict");
    }

    [Fact]
    public void ANativeRetryResolvesItsItemsAgainAfterTheyAreReparented()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        rig.Commit(Rule("sg-series"), rig.Viewer);
        var episode = (Episode)rig.Items[Role("episode:show-e1")];
        var guarded = episode.SeriesId;
        var plain = new Series { Id = Guid.NewGuid(), Name = "Plain series" };
        rig.Items[plain.Id] = plain;
        episode.SeriesId = plain.Id;
        var shot = Shot("TvShows.GetEpisodes.json");
        var context = PrivacyHostShapeModelTests.Context(shot, rig.Viewer);
        var gate = rig.Gate();
        gate.OnResourceExecuting(new ResourceExecutingContext(context, [], []));
        // An earlier filter of the same request resolved the episode (under the plain series) ...
        var early = PrivacyIdentities.Resolve(rig.Library.Object, [episode.Id], context.HttpContext);
        Assert.Equal(plain.Id, early[episode.Id].OwnerId);
        // ... then the library moved it into the guarded series.
        episode.SeriesId = guarded;
        episode.OwnerId = guarded;
        Updated(rig.Library, episode);
        BaseItemDto Dto() => new() { Id = episode.Id, Type = BaseItemKind.Episode, SeriesId = guarded, Name = "A secret ending from the episode r23",
            Overview = "A secret synopsis from the episode r23", IndexNumber = 1, ParentIndexNumber = 1, UserData = new UserItemDataDto { Played = false, Key = "k" } };
        var delivery = new ResultExecutingContext(context, [], new ObjectResult(new QueryResult<BaseItemDto>([Dto()])), new object());
        gate.OnResultExecuting(delivery);
        var body = Serialize(Assert.IsAssignableFrom<ObjectResult>(delivery.Result).Value!);
        // Control: without the request's earlier resolution the episode is stripped.
        context.HttpContext.Items.Remove("__JE_PRIVACY_IDENTITIES");
        var control = new ResultExecutingContext(context, [], new ObjectResult(new QueryResult<BaseItemDto>([Dto()])), new object());
        gate.OnResultExecuting(control);
        Assert.DoesNotContain("A secret synopsis", Serialize(Assert.IsAssignableFrom<ObjectResult>(control.Result).Value!));
        Assert.DoesNotContain("A secret synopsis", body);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void AnEpisodeReparentedWhileTheActivityLogIsJudgedIsStripped(bool rememberedBefore)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        rig.Commit(Rule("sg-series"), rig.Admin);
        var episode = (Episode)rig.Items[Role("episode:show-e1")];
        var guarded = episode.SeriesId;
        var plain = new Series { Id = Guid.NewGuid(), Name = "Plain series" };
        rig.Items[plain.Id] = plain;
        episode.SeriesId = plain.Id;
        if (rememberedBefore) Updated(rig.Library, episode);
        // The library moves the episode into the guarded series while the gate reads the viewer's watched state of it.
        var armed = true;
        rig.UserData.Setup(d => d.GetUserData(It.IsAny<Jellyfin.Database.Implementations.Entities.User>(), episode)).Returns(() =>
        {
            if (armed) { armed = false; episode.SeriesId = guarded; Updated(rig.Library, episode); }
            return new UserItemData { Key = "k", Played = false };
        });
        var entry = new MediaBrowser.Model.Activity.ActivityLogEntry("Playing the secret episode r23", "VideoPlayback", rig.Admin) { ItemId = episode.Id.ToString("N") };
        var body = DeliverNative(rig, Shot("ActivityLog.GetLogEntries.json"), rig.Admin,
            () => new QueryResult<MediaBrowser.Model.Activity.ActivityLogEntry>([entry]));
        Assert.False(armed, "the move ran during the judgment");
        Assert.DoesNotContain("Playing the secret episode r23", body);
    }

    [Fact]
    public void EveryStripAndAdvancedSettingIsInTheDeliveryRevision()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        rig.Commit(Rule("sg-series"), rig.Viewer);
        var config = rig.F.Plugin.Configuration;
        string Revision() => TitlePresentationGate.Revision(rig.F.Core.Manager, rig.Spoilers, rig.Viewer);
        var changed = new List<string>();
        foreach (var property in typeof(PluginConfiguration).GetProperties().Where(p => p.Name.StartsWith("Spoiler", StringComparison.Ordinal) && p.CanWrite
            && (p.PropertyType == typeof(bool) || p.PropertyType == typeof(bool?))))
        {
            var before = Revision();
            var old = property.GetValue(config);
            property.SetValue(config, old is true ? false : true);
            if (Revision() == before) changed.Add(property.Name);
            property.SetValue(config, old);
        }
        Assert.True(changed.Count == 0, "settings not in the delivery revision: " + string.Join(", ", changed));
    }

    [Theory]
    [InlineData("chapters")]
    [InlineData("advanced")]
    public void AStricterStripSettingSavedDuringTheValueWalkApplies(string flag)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        rig.Commit(Rule("sg-series"), rig.Viewer);
        var config = rig.F.Plugin.Configuration;
        var episode = (Episode)rig.Items[Role("episode:show-e1")];
        var next = (SpoilerNextUnwatchedService)typeof(PrivacyHostShapeModelTests.Rig).GetField("_next", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(rig)!;
        next.BoundaryComputerForTest = (_, _) => new(episode.Id, 1, 1);
        config.SpoilerStripChapters = false;
        config.SpoilerAdvancedMode = flag == "advanced";
        config.SpoilerNextEpisodeStripTitle = false;
        config.SpoilerNextEpisodeStripOverview = false;
        var armed = true;
        rig.Library.Setup(l => l.GetItemById(episode.Id)).Returns(() =>
        {
            if (armed) { armed = false; if (flag == "chapters") config.SpoilerStripChapters = true; else config.SpoilerNextEpisodeStripOverview = true; }
            return episode;
        });
        BaseItemDto Dto() => new() { Id = episode.Id, Type = BaseItemKind.Episode, SeriesId = episode.SeriesId, ParentIndexNumber = 1, IndexNumber = 1,
            Name = "Secret title r23", Overview = "Secret overview r23", Genres = ["Drama"], UserData = new UserItemDataDto { Played = false, Key = "k" },
            Chapters = [new MediaBrowser.Model.Entities.ChapterInfo { StartPositionTicks = 0, Name = "Secret chapter r23" }] };
        var shot = Shot("TvShows.GetEpisodes.json");
        var first = DeliverNative(rig, shot, rig.Viewer, () => new QueryResult<BaseItemDto>([Dto()]));
        Assert.False(armed, "the setting was saved during the value walk");
        var secret = flag == "chapters" ? "Secret chapter r23" : "Secret overview r23";
        Assert.DoesNotContain(secret, DeliverNative(rig, shot, rig.Viewer, () => new QueryResult<BaseItemDto>([Dto()])));
        Assert.DoesNotContain(secret, first);
    }

    [Fact]
    public void AMovieAddedToAGuardedCollectionIsGuardedAtOnce()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        PrivacyIdentities.ForgetCollections();
        var movie = (Movie)rig.Items[Role("movie:guarded")];
        var set = new BoxSet { Id = Guid.NewGuid(), LinkedChildren = [] };
        rig.Items[set.Id] = set;
        rig.Library.Raise(l => l.ItemAdded += null, rig.Library.Object, new ItemChangeEventArgs { Item = set });
        var state = new UserSpoilerBlur();
        state.Collections[set.Id.ToString("N")] = new();
        rig.F.Core.Manager.SaveUserConfiguration(rig.Viewer.ToString("N"), "spoilerblur.json", state);
        Assert.False(rig.Spoilers.Load(rig.Viewer).Guarded(PrivacyIdentities.Of(rig.Library.Object, movie)));
        // The movie joins the guarded collection (the host saves the collection with its new linked child).
        set.LinkedChildren = [new LinkedChild { ItemId = movie.Id }];
        Updated(rig.Library, set);
        var context = rig.Spoilers.Load(rig.Viewer);
        Assert.True(context.Guarded(rig.Spoilers.Resolve([movie.Id], rig.Viewer, context)[movie.Id]), "the next request still used the collection's earlier members");
        var dto = new BaseItemDto { Id = movie.Id, Type = BaseItemKind.Movie, Name = "Guarded movie", Overview = "Secret collection member plot r23",
            UserData = new UserItemDataDto { Key = "k", Played = false } };
        Assert.DoesNotContain("Secret collection member plot r23", DeliverNative(rig, Shot("TvShows.GetEpisodes.json"), rig.Viewer, () => new QueryResult<BaseItemDto>([dto])));
    }

    [Fact]
    public void AnOverflowedInputLogCountsAsChangedAndSavesStayPerViewer()
    {
        // Control (holds on the base too): another viewer's saves never move this viewer's verdicts; an overflowed log does.
        var viewer = Guid.NewGuid(); var other = Guid.NewGuid(); var item = Guid.NewGuid();
        var since = PrivacyInputs.Now;
        PrivacyInputs.Record(other, [item]);
        Assert.False(PrivacyInputs.ChangedSince(since, viewer, id => id == item));
        PrivacyInputs.Record(viewer, [Guid.NewGuid()]);
        Assert.False(PrivacyInputs.ChangedSince(since, viewer, id => id == item));
        for (var i = 0; i < PrivacyInputs.Capacity; i++) PrivacyInputs.Record(other, [item]);
        Assert.True(PrivacyInputs.ChangedSince(since, viewer, _ => false));
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Shape 2: the gate guards the bytes (deferred writers, every image branch, validators).

    private static async Task<IActionResult> ImageAnswer(bool master, bool guarded, bool notModified, Action<PluginConfiguration>? during = null)
    {
        using var f = new ApiPluginFixture();
        var user = new Jellyfin.Database.Implementations.Entities.User("r23-image", "default", "default") { Id = Guid.NewGuid() };
        var movie = new Movie { Id = Guid.NewGuid() };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemById(movie.Id)).Returns(movie);
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(user.Id)).Returns(user);
        var data = new Mock<IUserDataManager>();
        data.Setup(d => d.GetUserData(user, movie)).Returns(new UserItemData { Key = "k", Played = false });
        var state = new UserSpoilerBlur();
        if (guarded) state.Movies[movie.Id.ToString("N")] = new();
        f.Core.Manager.SaveUserConfiguration(user.Id.ToString("N"), "spoilerblur.json", state);
        var identity = new RequestIdentityService(Mock.Of<ISessionManager>(), users.Object, new SpoilerIdentityService(users.Object, f.Core.Logger), f.Core.Logger);
        var resolver = new SpoilerUserResolver(f.Core.Manager, library.Object, f.Core.Logger, identity);
        using var nextService = new SpoilerNextUnwatchedService(library.Object, users.Object, data.Object, f.Core.Logger);
        using var filter = new SpoilerBlurImageFilter(library.Object, users.Object, data.Object, Mock.Of<IChapterManager>(), resolver, new ImageBlurService(f.Core.Logger), nextService, f.Core.Logger);
        f.Plugin.Configuration.SpoilerBlurEnabled = master;
        f.Plugin.Configuration.SpoilerKeepMoviePosters = false;
        var http = new DefaultHttpContext { User = TestCallers.Principal(user.Id, false) };
        http.Request.Method = "GET";
        // The browser holds the host's earlier, unprotected copy of this poster.
        if (notModified) http.Request.Headers.IfNoneMatch = "\"earlier-unprotected-poster\"";
        var action = new ActionContext(http, new RouteData(), new ActionDescriptor { RouteValues = new Dictionary<string, string?> { ["controller"] = "Image", ["action"] = "GetItemImage" } });
        var context = new ActionExecutingContext(action, [], new Dictionary<string, object?> { ["itemId"] = movie.Id, ["imageType"] = "Primary", ["imageIndex"] = 0 }, new object());
        var executed = new ActionExecutedContext(action, [], new object())
        {
            Result = notModified ? new StatusCodeResult(304) : new FileContentResult(PosterBlurTests.Source(), "image/png")
        };
        await filter.OnActionExecutionAsync(context, () =>
        {
            // While the host loads the image: a setting changes, or the viewer guards the movie.
            during?.Invoke(f.Plugin.Configuration);
            if (!guarded)
            {
                state.Movies[movie.Id.ToString("N")] = new();
                f.Core.Manager.SaveUserConfiguration(user.Id.ToString("N"), "spoilerblur.json", state);
                SpoilerUserResolver.InvalidateUser(user.Id.ToString("N"));
            }
            return Task.FromResult(executed);
        });
        return executed.Result!;
    }

    [Fact]
    public async Task SwitchingSpoilerGuardOnWhileAnImageLoadsTransformsIt()
    {
        Assert.Equal("image/jpeg", Assert.IsType<FileContentResult>(await ImageAnswer(master: true, guarded: true, notModified: false)).ContentType);
        var result = Assert.IsType<FileContentResult>(await ImageAnswer(master: false, guarded: true, notModified: false, c => c.SpoilerBlurEnabled = true));
        Assert.Equal("image/jpeg", result.ContentType);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AGuardedImageNeverConfirmsACachedUnprotectedCopy(bool guardedBefore)
    {
        var result = await ImageAnswer(master: true, guarded: guardedBefore, notModified: true);
        Assert.IsType<FileContentResult>(result);
    }

    /// <summary>A response body whose first write runs <paramref name="during"/> (the client is slow; the write waits).</summary>
    private sealed class SlowClient(Action during) : MemoryStream
    {
        private bool _first = true;
        public long WrittenBefore { get; private set; } = -1;

        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (_first)
            {
                _first = false;
                await Task.Yield();
                during();
                WrittenBefore = Length + buffer.Length;
            }
            await base.WriteAsync(buffer, cancellationToken);
        }

        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
            => WriteAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();
    }

    [Fact]
    public async Task AGuardSavedWhileTheTagCacheIsWrittenSendsNoProtectedBytes()
    {
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: false, stripTags: true, extras: true);
        typeof(PrivacyReviewRound19Tests.TagSite).GetMethod("SignIn", BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(site, null);
        var http = site.Controller.HttpContext;
        http.Request.Method = "GET";
        using var output = new SlowClient(() => site.Guard(site.Series));
        http.Response.Body = output;
        // The action returns; its result writes the body afterwards.
        var result = site.Controller.GetTagCache(site.Alice.Id);
        await result.ExecuteResultAsync(new ActionContext(http, new RouteData(), new ActionDescriptor()));
        var body = System.Text.Encoding.UTF8.GetString(output.ToArray());
        var fresh = await site.TagCacheResponse();
        Assert.DoesNotContain(site.Sentinels.In(fresh.Body), p => p.StartsWith("episode", StringComparison.Ordinal));
        Assert.DoesNotContain(site.Sentinels.In(body), p => p.StartsWith("episode", StringComparison.Ordinal));
    }

    [Fact]
    public async Task AGuardSavedWhileANativeListIsWrittenSendsNoProtectedBytesAfterIt()
    {
        // A long episode list leaves in several writes; the viewer guards the series while the first one waits on the client.
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var shot = Shot("TvShows.GetEpisodes.json");
        var series = Role("series:show");
        var episodes = Enumerable.Range(1, 400).Select(i => new BaseItemDto
        {
            Id = Guid.NewGuid(), Type = BaseItemKind.Episode, SeriesId = series, ParentIndexNumber = 1, IndexNumber = i, Name = "Secret ending r23 " + i,
            Overview = "Secret synopsis r23 " + new string('x', 400), UserData = new UserItemDataDto { Played = false, Key = "k" + i },
        }).ToArray();
        foreach (var dto in episodes) rig.Items[dto.Id] = new Episode { Id = dto.Id, SeriesId = series, IndexNumber = dto.IndexNumber, ParentIndexNumber = 1 };
        var context = PrivacyHostShapeModelTests.Context(shot, rig.Viewer);
        var services = new ServiceCollection().AddLogging().AddMvcCore().Services.BuildServiceProvider();
        context.HttpContext.RequestServices = services;
        using var output = new SlowClient(() => rig.Commit(Rule("sg-series"), rig.Viewer));
        context.HttpContext.Response.Body = output;
        var gate = rig.Gate();
        gate.OnResourceExecuting(new ResourceExecutingContext(context, [], []));
        var delivery = new ResultExecutingContext(context, [], new ObjectResult(new QueryResult<BaseItemDto>(episodes)), new object());
        gate.OnResultExecuting(delivery);
        try { await delivery.Result.ExecuteResultAsync(context); }
        catch (OperationCanceledException) { }
        var bytes = output.ToArray();
        Assert.True(output.WrittenBefore > 0 && bytes.Length >= output.WrittenBefore, "the answer did not start leaving");
        var after = System.Text.Encoding.UTF8.GetString(bytes, (int)output.WrittenBefore, bytes.Length - (int)output.WrittenBefore);
        Assert.DoesNotContain("Secret synopsis r23", after);
        Assert.DoesNotContain("Secret ending r23", after);
    }

    [Fact]
    public async Task AGuardSavedBeforeTheHostStartsWritingIsAppliedNotWithheld()
    {
        // Between the gate and the host's executor nothing has been sent yet: the answer is projected again, not withheld.
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var shot = Shot("TvShows.GetEpisodes.json");
        var viewer = shot.Viewer == "viewer" ? rig.Viewer : rig.Admin;
        var context = PrivacyHostShapeModelTests.Context(shot, viewer);
        context.HttpContext.RequestServices = new ServiceCollection().AddLogging().AddMvcCore().Services.BuildServiceProvider();
        using var output = new MemoryStream();
        context.HttpContext.Response.Body = output;
        var gate = rig.Gate();
        gate.OnResourceExecuting(new ResourceExecutingContext(context, [], []));
        var delivery = new ResultExecutingContext(context, [], new ObjectResult(PrivacyHostShapeModelTests.Value(shot)), new object());
        gate.OnResultExecuting(delivery);
        rig.Commit(Rule("sg-series"), viewer);
        await delivery.Result.ExecuteResultAsync(context);
        var body = System.Text.Encoding.UTF8.GetString(output.ToArray());
        Assert.NotEqual(503, context.HttpContext.Response.StatusCode);
        Assert.Contains("Items", body);
        Assert.DoesNotContain("Secret plot r17 episode", body);
    }

    [Fact]
    public async Task AnUnchangedGuardedTagCacheStillRevalidates304()
    {
        // Control (holds on the base too): validators still confirm an unchanged guarded copy.
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: true, stripTags: true, extras: true);
        var (status, _, etag) = await site.TagCacheResponse();
        Assert.Equal(200, status);
        Assert.False(string.IsNullOrEmpty(etag));
        var (revalidated, _, _) = await site.TagCacheResponse(ifNoneMatch: etag);
        Assert.Equal(304, revalidated);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Shape 3: precision, not panic (only a change to an input the answer read invalidates it).

    private static void Progress(Mock<IUserDataManager> data, Guid user, BaseItem item, int second) => data.Raise(d => d.UserDataSaved += null, data.Object,
        new UserDataSaveEventArgs { UserId = user, Item = item, SaveReason = UserDataSaveReason.PlaybackProgress,
            UserData = new UserItemData { Key = "k", Played = false, PlaybackPositionTicks = second * TimeSpan.TicksPerSecond } });

    [Fact]
    public async Task PlaybackProgressSavesDuringATagCacheLoadNeverWithholdIt()
    {
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: true, stripTags: true);
        var saves = 0;
        // The viewer is playing the guarded episode: every played-state read of the load overlaps a progress save.
        site.Library.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
        {
            if (q.IsPlayed != true) return new[] { site.Movie, site.Episode, site.Season };
            Progress(site.UserData, site.Alice.Id, site.Items[site.Episode], ++saves);
            return Array.Empty<Guid>();
        });
        var (status, body, _) = await site.TagCacheResponse();
        Assert.True(status == 200, $"{saves} progress saves (watched state unchanged) withheld the tag cache: HTTP {status}");
        Assert.DoesNotContain(site.Sentinels.In(body), p => p.StartsWith("episode", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void PlaybackProgressSavesDuringAnEpisodeListNeverWithholdIt(bool guarded)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var shot = Shot("TvShows.GetEpisodes.json");
        var viewer = shot.Viewer == "viewer" ? rig.Viewer : rig.Admin;
        if (guarded) rig.Commit(Rule("sg-series"), viewer);
        var episode = Role("episode:show-e1");
        var saves = 0;
        rig.Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
        {
            var found = (q.ItemIds ?? []).Select(id => rig.Items.GetValueOrDefault(id)).OfType<BaseItem>().ToList();
            Progress(rig.UserData, viewer, rig.Items[episode], ++saves);
            return found;
        });
        var context = PrivacyHostShapeModelTests.Context(shot, viewer);
        var delivery = new ResultExecutingContext(context, [], new ObjectResult(PrivacyHostShapeModelTests.Value(shot)), new object());
        rig.Gate().OnResultExecuting(delivery);
        var answer = delivery.Result as ObjectResult;
        Assert.True(answer != null, $"{saves} progress saves (watched state unchanged) withheld the episode list: {(delivery.Result as StatusCodeResult)?.StatusCode}");
        var body = Serialize(answer!.Value!);
        if (guarded) Assert.DoesNotContain("Secret plot r17 episode", body);
        else Assert.Contains("Secret plot r17 episode", body);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Shape 4: the 10.11 ownership fallback, batched and with the extra's kind.

#if NET9_0
    [Fact]
    public void OnTenElevenClipsOfOneOwnerCostOneFolderLookupPerBatch()
    {
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: true, stripTags: true, extras: true);
        var clips = Enumerable.Range(0, 50).Select(i => new Video { Id = Guid.NewGuid(), Path = $"/media/Guarded show/featurettes/clip{i}.mkv" }).ToArray();
        foreach (var clip in clips) site.Items[clip.Id] = clip;
        var series = site.Items[site.Series];
        series.Path = "/media/Guarded show";
        series.ExtraIds = clips.Select(c => c.Id).ToArray();
        var lookups = 0;
        site.Library.Setup(l => l.FindByPath(series.Path, It.IsAny<bool?>())).Returns(() => { lookups++; return series; });
        var resolved = PrivacyIdentities.Resolve(site.Library.Object, clips.Select(c => c.Id), site.Alice, site.UserData.Object);
        Assert.Equal(50, resolved.Count);
        Assert.All(resolved.Values, i => Assert.Equal(site.Series, i.OwnerId));
        Assert.True(lookups <= 1, $"one owner folder looked up {lookups} times for 50 clips");
    }

    [Fact]
    public void OnTenElevenATagDataBatchOfOneOwnersClipsLooksItsFolderUpOnce()
    {
        // Identity, naming and vocabulary of one answer share the owner lookup.
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: true, stripTags: true, extras: true);
        var clips = Enumerable.Range(0, 50).Select(i => new Video { Id = Guid.NewGuid(), Path = $"/media/Guarded show/featurettes/clip{i}.mkv", Name = "Clip reveal " + i }).ToArray();
        foreach (var clip in clips) site.Items[clip.Id] = clip;
        var series = site.Items[site.Series];
        series.Path = "/media/Guarded show";
        series.ExtraIds = clips.Select(c => c.Id).ToArray();
        var lookups = 0;
        site.Library.Setup(l => l.FindByPath(series.Path, It.IsAny<bool?>())).Returns(() => { lookups++; return series; });
        var body = site.TagData(clips.Select(c => c.Id).ToArray());
        Assert.DoesNotContain("Clip reveal", body);
        Assert.True(lookups <= 1, $"one owner folder looked up {lookups} times for a tag-data batch of 50 clips");
    }

    [Fact]
    public void OnTenElevenAFeaturetteListedOnlyByItsOwnerKeepsItsKind()
    {
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: true, stripTags: true, extras: true);
        var video = (Video)site.Items[site.SeriesExtra];
        video.Path = "/media/Guarded show/featurettes/clip.mkv";
        video.ExtraType = null;
        video.OwnerId = Guid.Empty;
        var series = site.Items[site.Series];
        series.Path = "/media/Guarded show";
        series.ExtraIds = [video.Id];
        site.Library.Setup(l => l.FindByPath(series.Path, It.IsAny<bool?>())).Returns(series);
        Assert.True(PrivacyIdentities.Of(site.Library.Object, video, site.Alice, site.UserData.Object).IsExtra);
        var item = JsonNode.Parse(site.TagData(video.Id))!["Items"]!.AsArray().Single()!;
        Assert.Equal("Featurette", item["Name"]?.ToString());
    }
#endif
}
