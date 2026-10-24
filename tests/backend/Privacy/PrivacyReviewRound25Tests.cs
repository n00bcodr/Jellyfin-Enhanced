#pragma warning disable ASPDEPR004, ASPDEPR008 // TestServer over a WebHostBuilder: the in-process host the delivery tests drive
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Text;
using System.Text.Json;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Chapters;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Moq;

namespace JE.Tests;

/// <summary>
/// Review round 25: every input a decision consumes is a fact compared with its live source at the one commit point, with
/// no exemption by answer size, response stage or save epoch; equality is precise (an older cached item or an unchanged
/// sibling's refresh does not cost a permitted image its bytes); tag work stays bounded; one effective rating reveal on
/// every tag path. An older cached item than its stored row made every attempt fail (D46-R25-1), an unchanged sibling's
/// first refresh invalidated a series scope (-2), a delta looked the show up once per episode (-3), POST tag data revealed
/// an advanced rating the bulk cache and native poster hid (-4); a remembered non-extra recorded no ownership (-6), answers
/// above 256 items skipped the in-memory check (-7), the header-stage check skipped the live library (-8), host timelines
/// were re-read only after a policy save (-9), collection membership was not compared (-10), special placement was not a
/// season input (-11), and a missing series row made an episode its own owner (-12). Uses only the surface the pre-fix
/// build has, so the same file runs against it.
/// </summary>
[Collection("Plugin singleton")]
public class PrivacyReviewRound25Tests(Xunit.Abstractions.ITestOutputHelper output)
{
    private static Guid Role(string role) => Guid.Parse(PrivacyHostShapeModelTests.Data.Roles[role]);

    private static void Guard(PrivacyHostShapeModelTests.Rig rig) => rig.Commit(PrivacyHostShapeModelTests.Rules.Single(r => r.Id == "sg-series"), rig.Admin);

    private static readonly MethodInfo _image = typeof(PrivacyReviewRound24Tests).GetMethod("Image", BindingFlags.NonPublic | BindingFlags.Static)!;

    /// <summary>One image request through the real image filter (round 24's driver).</summary>
    internal static Task<(IActionResult Result, DefaultHttpContext Http, MemoryStream Bytes)> Image(PrivacyHostShapeModelTests.Rig rig, Guid item, string type = "Primary",
        IChapterManager? chapters = null, Action? during = null, Guid? user = null, IActionResult? source = null)
        => (Task<(IActionResult, DefaultHttpContext, MemoryStream)>)_image.Invoke(null,
            [rig, item, source ?? new FileContentResult(PosterBlurTests.Source(), "image/png"), during, type, chapters, null, user, null, null])!;

    private static bool IsOriginal(IActionResult result) => result is FileContentResult file && file.FileContents.SequenceEqual(PosterBlurTests.Source());

    /// <summary>Writes an image answer the way the host does, then the outermost commit.</summary>
    internal static async Task Write((IActionResult Result, DefaultHttpContext Http, MemoryStream Bytes) answer)
    {
        using var provider = new ServiceCollection().AddLogging().AddControllers().Services.BuildServiceProvider();
        answer.Http.RequestServices = provider;
        await answer.Result.ExecuteResultAsync(new ActionContext(answer.Http, new RouteData(), new ActionDescriptor(), new ModelStateDictionary()));
        await PrivacyResponseGuard.CommitAsync(answer.Http);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Precision: permitted images keep their bytes.

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task UnguardedImagesKeepTheirBytesWhenTheHostHasAnOlderCachedItem(bool master)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        rig.F.Plugin.Configuration.SpoilerBlurEnabled = master;
        var ep = rig.Items.Values.OfType<Episode>().First();
        var row = new Episode { Id = ep.Id, SeriesId = Guid.NewGuid(), SeasonId = ep.SeasonId,
            IndexNumber = ep.IndexNumber, ParentIndexNumber = ep.ParentIndexNumber, DateLastSaved = DateTime.UtcNow };
        ep.DateLastSaved = DateTime.UtcNow.AddMinutes(-5);
        // The host's cache holds an older instance than the row it stored since (nothing is moving).
        rig.Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
            (q.ItemIds ?? []).Select(id => id == ep.Id ? row : rig.Items.GetValueOrDefault(id)).OfType<BaseItem>().ToList());
        var original = new FileContentResult(PosterBlurTests.Source(), "image/png");
        var answer = await Image(rig, ep.Id, user: rig.Viewer, source: original);
        using (answer.Bytes)
            Assert.Same(original, answer.Result);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task AScanRefreshingUnchangedSiblingsKeepsTheNextEpisodesPermittedImage(bool scanning)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var ep = (Episode)rig.Items[Role("episode:show-e1")];
        ep.ParentIndexNumber = 1; ep.IndexNumber = 1;
        rig.Commit(PrivacyHostShapeModelTests.Rules.Single(r => r.Id == "sg-series"), rig.Viewer);
        rig.F.Plugin.Configuration.SpoilerAdvancedMode = true;
        rig.F.Plugin.Configuration.SpoilerNextEpisodeStripImage = false;
        var siblings = Enumerable.Range(0, 3).Select(i => new Episode { Id = Guid.NewGuid(), SeriesId = ep.SeriesId,
            SeasonId = ep.SeasonId, ParentIndexNumber = 1, IndexNumber = 50 + i }).ToArray();
        foreach (var sibling in siblings) rig.Items[sibling.Id] = sibling;
        var refreshed = 0;
        rig.Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
        {
            if (q.Limit == 1 && q.IsPlayed == false)
            {
                // The host's first ordinary metadata refresh after startup, for a different existing episode each time.
                // No owner, numbering, key or watched-state changes take place.
                if (scanning && refreshed < siblings.Length)
                {
                    var sibling = siblings[refreshed++];
                    rig.Library.Raise(l => l.ItemUpdated += null, rig.Library.Object,
                        new ItemChangeEventArgs { Item = sibling, UpdateReason = ItemUpdateType.ImageUpdate });
                }
                return [ep];
            }
            return (q.ItemIds ?? []).Select(id => rig.Items.GetValueOrDefault(id)).OfType<BaseItem>().ToList();
        });
        var original = new FileContentResult(PosterBlurTests.Source(), "image/png");
        var answer = await Image(rig, ep.Id, user: rig.Viewer, source: original);
        using (answer.Bytes) Assert.True(ReferenceEquals(original, answer.Result), $"Image was replaced after {refreshed} unchanged sibling refreshes");
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Bounded tag work.

    [Fact]
    public async Task AnUnchangedDeltaDoesNotLookUpTheShowOnceForEveryEpisode()
    {
        const int n = 1000;
        var many = Enumerable.Range(0, n).Select(_ => Guid.NewGuid()).ToArray();
        Guid series = default;
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: true, stripTags: true, edit: entries =>
        {
            var episode = entries.Values.First(e => e.Type == "Episode");
            series = Guid.Parse(episode.SeriesId!);
            for (var i = 0; i < n; i++) entries[many[i].ToString("N")] = new TagCacheEntry {
                Type = "Episode", SeriesId = episode.SeriesId, LastUpdated = 100, SeasonNumber = 1, EpisodeNumber = i + 1 };
        });
        foreach (var id in many) site.Items[id] = new Episode { Id = id, SeriesId = series, ParentIndexNumber = 1, IndexNumber = 1 };
        site.Library.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
            q.IsPlayed == true ? (q.ItemIds ?? []).Where(site.Played.Contains).ToArray() : site.Items.Keys.ToArray());
        site.Library.Invocations.Clear();
        var result = await site.TagCacheResponse(since: 150);
        Assert.Equal(200, result.Status);
        var direct = site.Library.Invocations.Count(i => i.Method.Name == "GetItemById");
        output.WriteLine($"1000-episode unchanged delta: GetItemById {direct}, GetItemList {site.Library.Invocations.Count(i => i.Method.Name == "GetItemList")}, "
            + $"played queries {site.Library.Invocations.Count(i => i.Method.Name == "GetItemIds" && i.Arguments[0] is InternalItemsQuery { IsPlayed: true })}");
        Assert.True(direct < 20, $"A 1000-episode delta made {direct} direct item lookups");
    }

    // ---------------------------------------------------------------------------------------------------------------
    // One effective rating reveal on every tag path (Q-D46FIX26-1 (a)).

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task AdvancedRatingRevealAgreesAcrossTagDataBulkCacheAndNativePoster(bool reveal)
    {
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: true, stripTags: false, edit: entries =>
            entries.Values.First(e => e.Type == "Episode").CommunityRating = 7.5f);
        var config = site.Fixture.Plugin.Configuration;
        config.SpoilerAdvancedMode = true;
        config.SpoilerStripRatings = true;
        config.SpoilerNextEpisodeStripRatings = !reveal;
        var ep = site.Items[site.Episode];
        ep.CommunityRating = 7.5f;
        site.Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
            q.ItemIds is { Length: > 0 } ? q.ItemIds.Select(i => site.Items.GetValueOrDefault(i)).OfType<BaseItem>().ToList() : [ep]);
        using var direct = JsonDocument.Parse(site.TagData(site.Episode));
        static float? Score(JsonElement item) => item.TryGetProperty("CommunityRating", out var score) && score.ValueKind != JsonValueKind.Null ? score.GetSingle() : null;
        var expected = reveal ? 7.5f : (float?)null;
        Assert.Equal(expected, Score(direct.RootElement.GetProperty("Items")[0]));
        using var bulk = JsonDocument.Parse(await site.TagCache());
        var bulkScore = Score(bulk.RootElement.GetProperty("items").GetProperty(ep.Id.ToString("N")));
        var policy = SpoilerTagDataStripper.CreatePolicy(config, site.State)!;
        var poster = site.Stripper.StripEntry(policy, site.Alice, ep, new TagCacheEntry {
            Type = "Episode", SeriesId = site.Series.ToString("N"), SeasonNumber = 1, EpisodeNumber = 3, CommunityRating = 7.5f }, out _);
        Assert.Equal(new float?[] { expected, expected }, new float?[] { bulkScore, poster.CommunityRating });
    }

    // ---------------------------------------------------------------------------------------------------------------
    // The host's normal executors deliver complete answers (positive control), and a change between validation and commit
    // through each of them never reaches the client.

    private static IActionResult Executor(string kind, string text, byte[] bytes, string file, PrivacyResponseGuard guard) => kind switch
    {
        "json" => PrivacyResponseGuard.Guarded(new ObjectResult(text) { ContentTypes = { "application/json" } }, guard),
        "content" => new ContentResult { Content = text, ContentType = "text/plain" },
        "physical" => new PhysicalFileResult(file, "text/plain") { EnableRangeProcessing = true },
        _ => new FileStreamResult(new MemoryStream(bytes), "text/plain") { EnableRangeProcessing = true }
    };

    private static async Task<(HttpStatusCode Status, string Body)> Execute(PrivacyHostShapeModelTests.Rig rig, string kind, bool compressed, bool range,
        Func<PrivacyReadSet, Action>? input = null)
    {
        var text = new string('x', 10000);
        var bytes = Encoding.UTF8.GetBytes(text);
        var file = Path.Combine(rig.F.Core.Root, "answer.txt");
        File.WriteAllBytes(file, bytes);
        using var server = new TestServer(new WebHostBuilder().ConfigureServices(s =>
        {
            s.AddControllers(); s.AddResponseCompression();
        }).Configure(app =>
        {
            app.UseResponseCompression();
            app.Run(async http =>
            {
                using var scope = PrivacyReadSet.Begin();
                // The answer's input (a host timeline the decision read), changed after the answer was validated.
                var change = input?.Invoke(scope.Reads);
                Assert.True(scope.Reads.Valid());
                var guard = PrivacyResponseGuard.Install(http, scope.Reads)!;
                var result = Executor(kind, text, bytes, file, guard);
                change?.Invoke();
                var action = new ActionContext(http, new RouteData(), new ActionDescriptor());
                await result.ExecuteResultAsync(action);
                await PrivacyResponseGuard.CommitAsync(http);
            });
        }));
        using var client = server.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/");
        if (compressed) request.Headers.TryAddWithoutValidation("Accept-Encoding", "gzip");
        if (range) request.Headers.TryAddWithoutValidation("Range", "bytes=100-199");
        using var response = await client.SendAsync(request);
        var got = await response.Content.ReadAsByteArrayAsync();
        if (response.Content.Headers.ContentEncoding.Contains("gzip") && got.Length > 0)
        {
            using var gzip = new GZipStream(new MemoryStream(got), CompressionMode.Decompress);
            using var decoded = new MemoryStream(); await gzip.CopyToAsync(decoded); got = decoded.ToArray();
        }
        return (response.StatusCode, Encoding.UTF8.GetString(got));
    }

    [Theory]
    [InlineData("json", false, false)]
    [InlineData("json", true, false)]
    [InlineData("file", false, false)]
    [InlineData("file", false, true)]
    [InlineData("physical", false, false)]
    [InlineData("physical", false, true)]
    [InlineData("content", true, false)]
    public async Task NormalHttpExecutorsDeliverCompleteAnswers(string kind, bool compressed, bool range)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var text = new string('x', 10000);
        var (status, body) = await Execute(rig, kind, compressed, range);
        Assert.Equal(range ? HttpStatusCode.PartialContent : HttpStatusCode.OK, status);
        Assert.Equal(range ? new string('x', 100) : kind == "json" ? "\"" + text + "\"" : text, body);
    }

    [Theory]
    [InlineData("json", false, false)]
    [InlineData("json", true, false)]
    [InlineData("file", false, false)]
    [InlineData("file", false, true)]
    [InlineData("physical", false, false)]
    [InlineData("physical", false, true)]
    [InlineData("content", true, false)]
    public async Task AHostTimelineChangedBeforeTheCommitNeverLeavesThroughAnyExecutor(string kind, bool compressed, bool range)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var item = Guid.NewGuid();
        var chapter = new ChapterInfo { StartPositionTicks = 10 };
        var chapters = new Mock<IChapterManager>();
        chapters.Setup(c => c.GetChapter(item, 0)).Returns(() => chapter);
        var (status, body) = await Execute(rig, kind, compressed, range, reads =>
        {
            PrivacyReads.Chapter(chapters.Object, item, 0);
            // A chapter refresh with no policy save: the commit compares the timeline with the host's.
            return () => chapter.StartPositionTicks = 200;
        });
        Assert.DoesNotContain("x", body);
        Assert.NotEqual(range ? HttpStatusCode.PartialContent : HttpStatusCode.OK, status);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Every consumed input is compared live at the commit.

    [Fact]
    public async Task ChapterTimelineChangedAfterProjectionCannotReachTheCommit()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var movie = rig.Items[Role("movie:guarded")];
        var state = new UserSpoilerBlur(); state.Movies[movie.Id.ToString("N")] = new();
        rig.F.Core.Manager.SaveUserConfiguration(rig.Admin.ToString("N"), "spoilerblur.json", state);
        rig.UserData.Setup(d => d.GetUserData(It.IsAny<Jellyfin.Database.Implementations.Entities.User>(), movie)).Returns(new UserItemData { Key = "k", Played = false, PlaybackPositionTicks = 100 });
        var chapter = new ChapterInfo { StartPositionTicks = 10 };
        var chapters = new Mock<IChapterManager>(); chapters.Setup(c => c.GetChapter(movie.Id, 0)).Returns(() => chapter);
        var answer = await Image(rig, movie.Id, "Chapter", chapters.Object);
        Assert.IsType<FileContentResult>(answer.Result);
        Assert.Equal(PosterBlurTests.Source(), ((FileContentResult)answer.Result).FileContents);
        chapter.StartPositionTicks = 200; // host chapter refresh after Valid(), before headers or bytes
        await Write(answer);
        Assert.False(answer.Bytes.ToArray().SequenceEqual(PosterBlurTests.Source()), "Original now-unwatched chapter image was committed after the timeline changed");
    }

    [Theory]
    [InlineData(256)]
    [InlineData(257)]
    public void NewerInMemoryOwnershipMustInvalidateEveryBatchSize(int count)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        Guard(rig);
        var guarded = Role("series:show");
        var rows = Enumerable.Range(0, count).Select(_ => new Episode { Id = Guid.NewGuid(), SeriesId = Guid.NewGuid(), SeasonId = Guid.NewGuid(), ParentIndexNumber = 1, IndexNumber = 1, DateLastSaved = DateTime.UtcNow.AddMinutes(-5) }).ToArray();
        var memory = new Episode { Id = rows[0].Id, SeriesId = guarded, SeasonId = rows[0].SeasonId, ParentIndexNumber = 1, IndexNumber = 1, DateLastSaved = DateTime.UtcNow };
        rig.Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => (q.ItemIds ?? []).Select(id => rows.FirstOrDefault(r => r.Id == id)).OfType<BaseItem>().ToList());
        rig.Library.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => id == memory.Id ? memory : rows.FirstOrDefault(r => r.Id == id));
        using var scope = PrivacyReadSet.Begin();
        var identities = PrivacyIdentities.Resolve(rig.Library.Object, rows.Select(r => r.Id));
        // Judged by its stored row, the newer in-memory item names the guarded show: the commit sees it at every size.
        var judged = identities[rows[0].Id].OwnerId;
        Assert.False(judged != guarded && scope.Reads.Valid(), $"Batch size {count} validated the old unguarded owner while the newer host item belongs to the guarded show");
    }

    [Fact]
    public async Task CollectionMembershipChangedBeforeCommitCannotReleaseAnOriginalPoster()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var movie = rig.Items[Role("movie:guarded")];
        var set = new BoxSet { Id = Guid.NewGuid(), Name = "guarded set", LinkedChildren = [] }; rig.Items[set.Id] = set;
        var state = new UserSpoilerBlur(); state.Collections[set.Id.ToString("N")] = new();
        rig.F.Core.Manager.SaveUserConfiguration(rig.Admin.ToString("N"), "spoilerblur.json", state);
        rig.F.Plugin.Configuration.SpoilerKeepMoviePosters = false;
        var answer = await Image(rig, movie.Id);
        Assert.Equal(PosterBlurTests.Source(), Assert.IsType<FileContentResult>(answer.Result).FileContents);
        set.LinkedChildren = [new LinkedChild { ItemId = movie.Id }];
        set.DateLastSaved = DateTime.UtcNow; // host has prepared its new membership, before ItemUpdated
        await Write(answer);
        Assert.False(answer.Bytes.ToArray().SequenceEqual(PosterBlurTests.Source()), "A movie now linked by the guarded collection was committed with its original poster");
    }

    [Fact]
    public async Task OwnershipChangedWhileHeadersStartCannotBypassTheLastCheck()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig(); Guard(rig);
        var episode = (Episode)rig.Items[Role("episode:show-e1")];
        var guarded = episode.SeriesId;
        var plain = new Series { Id = Guid.NewGuid(), Name = "Plain show" }; rig.Items[plain.Id] = plain;
        episode.SeriesId = plain.Id;
        var sentinel = "R25 ownership changed at header start";
        using var server = new TestServer(new WebHostBuilder().ConfigureServices(s => s.AddLogging().AddControllers()).Configure(app => app.Run(async http =>
        {
            http.User = TestCallers.Principal(rig.Admin, true);
            var action = new ActionContext(http, new RouteData(), new ActionDescriptor { RouteValues = new Dictionary<string, string?> { ["controller"] = "TvShows", ["action"] = "GetEpisodes" } }, new ModelStateDictionary());
            var gate = rig.Gate(); gate.OnResourceExecuting(new ResourceExecutingContext(action, [], []));
            var dto = new BaseItemDto { Id = episode.Id, Type = BaseItemKind.Episode, Name = sentinel, Overview = sentinel, SeriesId = plain.Id, SeasonId = episode.SeasonId, IndexNumber = 1, ParentIndexNumber = 1 };
            var delivering = new ResultExecutingContext(action, [], new ObjectResult(new QueryResult<BaseItemDto>([dto])), new object());
            gate.OnResultExecuting(delivering);
            http.Response.OnStarting(() => { episode.SeriesId = guarded; episode.DateLastSaved = DateTime.UtcNow; return Task.CompletedTask; });
            await delivering.Result.ExecuteResultAsync(action);
            await PrivacyResponseGuard.CommitAsync(http);
        })));
        using var client = server.CreateClient(); using var response = await client.GetAsync("/");
        var body = await response.Content.ReadAsStringAsync();
        Assert.DoesNotContain(sentinel, body);
    }

    [Fact]
    public async Task SpecialPlacementChangesRevokeASeasonPosterReveal()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        Guard(rig);
        var series = (Series)rig.Items[Role("series:show")];
        series.PresentationUniqueKey = "r25-series";
        var season = (Season)rig.Items[Role("season:show-s1")];
        season.IndexNumber = 2; season.PresentationUniqueKey = "r25-season-2";
        var specials = new Season { Id = Guid.NewGuid(), SeriesId = series.Id, IndexNumber = 0, PresentationUniqueKey = "r25-specials" };
        var special = new Episode { Id = Guid.NewGuid(), SeriesId = series.Id, SeasonId = specials.Id, ParentIndexNumber = 0, IndexNumber = 1, AirsBeforeSeasonNumber = 2 };
        rig.Items[special.Id] = special; rig.Items[specials.Id] = specials;
        rig.Played.Add((rig.Admin, special.Id));
        rig.Library.Setup(l => l.GetItemById<Series>(series.Id)).Returns(series);
        rig.Library.Setup(l => l.GetItemById<Season>(specials.Id)).Returns(specials);
        rig.Library.Setup(l => l.Sort(It.IsAny<IEnumerable<BaseItem>>(), It.IsAny<Jellyfin.Database.Implementations.Entities.User>(), It.IsAny<IEnumerable<ItemSortBy>>(), It.IsAny<Jellyfin.Database.Implementations.Enums.SortOrder>()))
            .Returns((IEnumerable<BaseItem> rows, Jellyfin.Database.Implementations.Entities.User _, IEnumerable<ItemSortBy> _, Jellyfin.Database.Implementations.Enums.SortOrder _) => rows);
        rig.Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => q.ItemIds is { Length: > 0 }
            ? q.ItemIds.Select(i => rig.Items.GetValueOrDefault(i)).OfType<BaseItem>().ToList() : new List<BaseItem> { special });
        var hostConfig = new MediaBrowser.Model.Configuration.ServerConfiguration { DisplaySpecialsWithinSeasons = true };
        var manager = new Mock<IServerConfigurationManager>();
        manager.SetupGet(m => m.Configuration).Returns(hostConfig);
        var previous = BaseItem.ConfigurationManager;
        BaseItem.ConfigurationManager = manager.Object;
        try
        {
            var user = rig.Users.Object.GetUserById(rig.Admin)!;
            Assert.Contains(special, season.GetEpisodes(user, new MediaBrowser.Controller.Dto.DtoOptions(false), false));
            // The administrator moves specials out of the seasons while the season's image loads.
            rig.Library.Raise(l => l.ItemAdded += null, rig.Library.Object, new ItemChangeEventArgs { Item = special });
            Action moved = () => { special.AirsBeforeSeasonNumber = 3; rig.Library.Raise(l => l.ItemUpdated += null, rig.Library.Object, new ItemChangeEventArgs { Item = special, UpdateReason = ItemUpdateType.MetadataEdit }); };
            var (result, _, _) = await Image(rig, season.Id, during: moved);
            Assert.DoesNotContain(special, season.GetEpisodes(user, new MediaBrowser.Controller.Dto.DtoOptions(false), false));
            Assert.False(IsOriginal(result), "the season holds no watched episode any more, but its original poster was sent");
        }
        finally { BaseItem.ConfigurationManager = previous; }
    }

    [Theory]
    [InlineData(1)]
    [InlineData(257)]
    public async Task NativeEpisodeAnswerWithManyItemsCannotUseAFormerPlainOwner(int count)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var shot = PrivacyHostShapeModelTests.Data.Shots.Single(s => s.File == "TvShows.GetEpisodes.json");
        var viewer = shot.Viewer == "viewer" ? rig.Viewer : rig.Admin;
        rig.Commit(PrivacyHostShapeModelTests.Rules.Single(r => r.Id == "sg-series"), viewer);
        var guarded = Role("series:show");
        var plain = new Series { Id = Guid.NewGuid(), Name = "plain show" }; rig.Items[plain.Id] = plain;
        var rows = Enumerable.Range(0, count).Select(_ => new Episode { Id = Guid.NewGuid(), SeriesId = plain.Id, SeasonId = Guid.NewGuid(), ParentIndexNumber = 1, IndexNumber = 1, DateLastSaved = DateTime.UtcNow.AddMinutes(-5) }).ToArray();
        foreach (var row in rows) rig.Items[row.Id] = row;
        var memory = new Episode { Id = rows[0].Id, SeriesId = guarded, SeasonId = rows[0].SeasonId, ParentIndexNumber = 1, IndexNumber = 1, DateLastSaved = DateTime.UtcNow };
        rig.Library.Setup(l => l.GetItemById(rows[0].Id)).Returns(memory);
        var sentinel = "R25 native stale owner leak";
        var dtos = rows.Select(row => new BaseItemDto { Id = row.Id, Type = BaseItemKind.Episode, SeriesId = row.SeriesId, SeasonId = row.SeasonId, Name = row.Id == rows[0].Id ? sentinel : "plain episode", Overview = row.Id == rows[0].Id ? sentinel : "plain overview", ParentIndexNumber = 1, IndexNumber = 1 }).ToArray();
        var (_, body) = await PrivacyHostShapeModelTests.Deliver(rig, shot, answer: new QueryResult<BaseItemDto>(dtos));
        Assert.DoesNotContain(sentinel, body);
    }

    [Fact]
    public async Task RememberedNonExtraStillRegistersItsOwnershipDependency()
    {
        const string sentinel = "R25 formerly independent clip now guarded";
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: true, stripTags: true, extras: true, edit: entries =>
        {
            var pair = entries.First(p => p.Value.Type == "Video"); entries.Clear();
            pair.Value.StreamData = new TagStreamData { ItemName = sentinel };
            entries[pair.Key] = pair.Value;
        });
        var clip = site.Items[site.SeriesExtra]; clip.OwnerId = Guid.Empty;
        Assert.Contains(sentinel, await site.TagCache()); // prime the per-stripper non-extra memo
        var provider = site.Controller.HttpContext.RequestServices;
        var http = new DefaultHttpContext { RequestServices = provider, User = TestCallers.Principal(site.Alice.Id, false) };
        http.Request.Method = "GET"; using var stream = new MemoryStream(); http.Response.Body = stream;
        site.Controller.ControllerContext = new ControllerContext { HttpContext = http };
        var result = site.Controller.GetTagCache(site.Alice.Id, null); // the negative memo was consumed
        clip.OwnerId = site.Series;
        site.Updated(clip.Id); // even a fully announced ownership change, before the commit
        await result.ExecuteResultAsync(new ActionContext(http, new RouteData(), new ActionDescriptor()));
        var body = Encoding.UTF8.GetString(stream.ToArray());
        Assert.DoesNotContain(sentinel, await site.TagCache()); // control: a fresh decision does protect it
        Assert.DoesNotContain(sentinel, body);
    }

    [Fact]
    public async Task AnEpisodesKnownGuardedSeriesRemainsItsOwnerWhenTheSeriesRowIsUnavailable()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var shot = PrivacyHostShapeModelTests.Data.Shots.Single(s => s.File == "TvShows.GetEpisodes.json");
        var viewer = shot.Viewer == "viewer" ? rig.Viewer : rig.Admin;
        rig.Commit(PrivacyHostShapeModelTests.Rules.Single(r => r.Id == "sg-series"), viewer);
        if (viewer != rig.Admin) Guard(rig);
        var ep = (Episode)rig.Items[Role("episode:show-e1")];
        rig.Items.Remove(ep.SeriesId); // the episode row still explicitly names the guarded series
        const string sentinel = "R25 missing owner must not reveal episode";
        var dto = new BaseItemDto { Id = ep.Id, Type = BaseItemKind.Episode, SeriesId = ep.SeriesId, SeasonId = ep.SeasonId, Name = sentinel, Overview = sentinel, ParentIndexNumber = 1, IndexNumber = 1 };
        var (_, body) = await PrivacyHostShapeModelTests.Deliver(rig, shot, answer: new QueryResult<BaseItemDto>([dto]));
        var image = await Image(rig, ep.Id);
        Assert.False(IsOriginal(image.Result), "control: the image must follow the guarded SeriesId");
        Assert.DoesNotContain(sentinel, body);
    }
}
