#pragma warning disable ASPDEPR004, ASPDEPR008 // TestServer over a WebHostBuilder: the in-process host the delivery tests drive
using System.Net;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Chapters;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Activity;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;
using MediaBrowser.Model.Search;
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
/// The commit point, the live and recorded verdict inputs, precision, and the one per-item decision, by their own surface
/// (review round 24's shapes): a held answer leaves only through a validated commit; the facts a decision read are
/// compared with the host's live items (10.11's listed extras normalised); every host timeline a decision reads is in its
/// read-set (a planted read is caught); a decision depends on the playback position only where it uses it; and every
/// representation of an item (its item answer, its image, a search hint, an activity entry) gets the same decision.
/// </summary>
[Collection("Plugin singleton")]
public class PrivacyCommitAndDecisionTests
{
    private static Guid Role(string role) => Guid.Parse(PrivacyHostShapeModelTests.Data.Roles[role]);
    private static PrivacyHostShapeModelTests.Shot Shot(string file) => PrivacyHostShapeModelTests.Data.Shots.Single(s => s.File == file);
    private static void Guard(PrivacyHostShapeModelTests.Rig rig, Guid viewer) => rig.Commit(PrivacyHostShapeModelTests.Rules.Single(r => r.Id == "sg-series"), viewer);

    // ---------------------------------------------------------------------------------------------------------------
    // The commit point.

    [Fact]
    public async Task AHeldAnswerItsWriterNeverCommittedLeavesNothing()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        using var server = new TestServer(new WebHostBuilder().Configure(app => app.Run(async http =>
        {
            Assert.NotNull(PrivacyDelivery.Deliver(rig.Viewer, () => "built", http));
            // No declared length and no commit: the host starts the response at the end of the request.
            await http.Response.Body.WriteAsync(Encoding.UTF8.GetBytes("{\"overview\":\"R25 never committed\"}"));
        })));
        using var client = server.CreateClient();
        using var response = await client.GetAsync("/");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.DoesNotContain("R25 never committed", await response.Content.ReadAsStringAsync());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task TheOutermostFilterCommitsAHeldAnswerAfterItsResult(bool savedWhileWritten)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var http = new DefaultHttpContext();
        using var body = new MemoryStream();
        http.Response.Body = body;
        var action = new ActionContext(http, new RouteData(), new ActionDescriptor(), new ModelStateDictionary());
        var executing = new ResourceExecutingContext(action, [], []);
        await new PrivacyCommitFilter().OnResourceExecutionAsync(executing, async () =>
        {
            PrivacyDelivery.Deliver(rig.Viewer, () => { rig.F.Core.Manager.GetUserConfiguration<UserSpoilerBlur>(rig.Viewer.ToString("N"), "spoilerblur.json"); return "built"; }, http);
            // A chunked answer (no declared length): the result writes it in pieces.
            await http.Response.Body.WriteAsync(Encoding.UTF8.GetBytes("{\"overview\":"));
            if (savedWhileWritten) Guard(rig, rig.Viewer);
            await http.Response.Body.WriteAsync(Encoding.UTF8.GetBytes("\"R25 chunked answer\"}"));
            return new ResourceExecutedContext(action, []);
        });
        Assert.Equal(savedWhileWritten ? 503 : 200, http.Response.StatusCode);
        Assert.Equal(!savedWhileWritten, Encoding.UTF8.GetString(body.ToArray()).Contains("R25 chunked answer", StringComparison.Ordinal));
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Live and recorded inputs.

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void AJudgedItemTheHostChangedWithoutAnnouncingItFailsTheGate(bool moved)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var episode = (Episode)rig.Items[Role("episode:show-e1")];
        using var scope = PrivacyReadSet.Begin();
        PrivacyIdentities.Of(rig.Library.Object, episode);
        if (moved) episode.SeriesId = Guid.NewGuid();
        Assert.Equal(!moved, scope.Reads.Valid());
        if (moved) Assert.Contains("library change", scope.Reads.Failure);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void AMoveTheHostHasNotSavedYetFailsTheGate(bool moved)
    {
        // The host changes an item in memory first (stamping it), then saves the row and announces it. A judgment reads the
        // host's view (the newer in-memory item), so a move already in memory is judged by its new show; one the host makes
        // in memory after the judgment fails the gate before the row is saved.
        var library = new Mock<ILibraryManager>();
        var guarded = Guid.NewGuid();
        var row = new Episode { Id = Guid.NewGuid(), SeriesId = Guid.NewGuid(), SeasonId = Guid.NewGuid(), ParentIndexNumber = 1, IndexNumber = 2, DateLastSaved = DateTime.UtcNow.AddMinutes(-5) };
        var memory = new Episode { Id = row.Id, SeriesId = moved ? guarded : row.SeriesId, SeasonId = row.SeasonId, ParentIndexNumber = 1, IndexNumber = 2, DateLastSaved = DateTime.UtcNow };
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => (q.ItemIds ?? []).Contains(row.Id) ? [row] : []);
        library.Setup(l => l.GetItemById(row.Id)).Returns(memory);
        using (var scope = PrivacyReadSet.Begin())
        {
            Assert.Equal(moved ? guarded : row.SeriesId, PrivacyIdentities.Resolve(library.Object, [row.Id])[row.Id].OwnerId);
            Assert.True(scope.Reads.Valid(), scope.Reads.Failure);
        }
        using (var scope = PrivacyReadSet.Begin())
        {
            PrivacyIdentities.Resolve(library.Object, [row.Id]);
            var next = new Episode { Id = row.Id, SeriesId = Guid.NewGuid(), SeasonId = row.SeasonId, ParentIndexNumber = 1, IndexNumber = 2, DateLastSaved = DateTime.UtcNow.AddMinutes(1) };
            if (moved) library.Setup(l => l.GetItemById(row.Id)).Returns(next);
            Assert.Equal(!moved, scope.Reads.Valid());
            if (moved) Assert.Contains("library change", scope.Reads.Failure);
        }
    }

    [Fact]
    public void AnOlderCachedInstanceThanTheStoredRowIsNotTheLiveItem()
    {
        // A cached instance the host has not refreshed (older than the row it saved since) disagrees with the row: the row is
        // the live item, so an answer judged by it holds (10.11 keeps such instances after a refresh move).
        var library = new Mock<ILibraryManager>();
        var row = new Episode { Id = Guid.NewGuid(), SeriesId = Guid.NewGuid(), SeasonId = Guid.NewGuid(), ParentIndexNumber = 1, IndexNumber = 2, DateLastSaved = DateTime.UtcNow };
        var stale = new Episode { Id = row.Id, SeriesId = Guid.NewGuid(), SeasonId = row.SeasonId, ParentIndexNumber = 1, IndexNumber = 2, DateLastSaved = DateTime.UtcNow.AddMinutes(-5) };
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => (q.ItemIds ?? []).Contains(row.Id) ? [row] : []);
        library.Setup(l => l.GetItemById(row.Id)).Returns(stale);
        using var scope = PrivacyReadSet.Begin();
        PrivacyIdentities.Resolve(library.Object, [row.Id]);
        Assert.True(scope.Reads.Valid(), scope.Reads.Failure);
    }

    [Fact]
    public void ARenumberedEpisodeIsALibraryChange()
    {
        var library = new Mock<ILibraryManager>();
        PrivacyInputs.Observe(library.Object, null);
        var episode = new Episode { Id = Guid.NewGuid(), SeriesId = Guid.NewGuid(), SeasonId = Guid.NewGuid(), ParentIndexNumber = 1, IndexNumber = 3 };
        library.Raise(l => l.ItemAdded += null, library.Object, new ItemChangeEventArgs { Item = episode });
        var since = PrivacyInputs.Now;
        episode.IndexNumber = 1;
        library.Raise(l => l.ItemUpdated += null, library.Object, new ItemChangeEventArgs { Item = episode, UpdateReason = ItemUpdateType.MetadataEdit });
        Assert.True(PrivacyInputs.ChangedSince(since, Guid.Empty, id => id == episode.SeriesId), "a renumbering moved nothing that reads the series' order");
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void AFirstSeenUpdateIsDecidedByTheFactsTheAnswerJudgedBy(bool changed)
    {
        // After a start nothing is known; the host's first update of an item (a background task touching it) says nothing
        // about whether it changed. Every read records what the decision judged the item by, and that is compared with the
        // live item: an update that changed none of it moves nothing, one that changed it (a new key) does.
        var library = new Mock<ILibraryManager>();
        var movie = new MediaBrowser.Controller.Entities.Movies.Movie { Id = Guid.NewGuid(), Name = "R25 first seen" };
        library.Setup(l => l.GetItemById(movie.Id)).Returns(movie);
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns([movie]);
        PrivacyInputs.Observe(library.Object, null);
        using var scope = PrivacyReadSet.Begin();
        PrivacyReads.Item(library.Object, movie.Id);
        if (changed) movie.SetProviderId(MetadataProvider.Tmdb, "4242");
        library.Raise(l => l.ItemUpdated += null, library.Object, new ItemChangeEventArgs { Item = movie, UpdateReason = ItemUpdateType.ImageUpdate });
        Assert.Equal(!changed, scope.Reads.Valid());
    }

    [Fact]
    public async Task FirstUpdatesAfterAStartNeverWithholdACorrectTagCache()
    {
        // Every attempt sees the host's first update of an episode in the answer (its facts as they were, never known since
        // the start): the answer judged it by the facts it recorded, which the live item still has, so nothing is withheld.
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: true, stripTags: true);
        var touched = 0;
        site.Library.Setup(x => x.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
        {
            site.Library.Raise(l => l.ItemUpdated += null, site.Library.Object, new ItemChangeEventArgs { Item = site.Items[site.Episode], UpdateReason = ItemUpdateType.ImageUpdate });
            touched++;
            return (q.ItemIds ?? []).Select(i => site.Items.GetValueOrDefault(i)).OfType<BaseItem>().ToList();
        });
        var (status, _, _) = await site.TagCacheResponse();
        Assert.True(touched > 0);
        Assert.Equal(200, status);
    }

#if NET9_0
    [Fact]
    public void OnTenElevenAListedExtraJudgedByItsOwnerStaysValid()
    {
        // The row names no owner (the host attached it in memory); the owner lists it. Judged by the owner, the gate's live
        // comparison normalises the row by the same rule instead of reading it as a move.
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var series = rig.Items[Role("series:show")];
        series.Path = "/media/Guarded show";
        var extra = new Video { Id = Guid.NewGuid(), OwnerId = Guid.Empty, Path = "/media/Guarded show/featurettes/reveal.mp4", Name = "R25 featurette" };
        rig.Items[extra.Id] = extra;
        series.ExtraIds = [extra.Id];
        rig.Library.Setup(l => l.FindByPath("/media/Guarded show", It.IsAny<bool?>())).Returns(series);
        using var scope = PrivacyReadSet.Begin();
        Assert.Equal(series.Id, PrivacyIdentities.Of(rig.Library.Object, extra).OwnerId);
        Assert.True(scope.Reads.Valid(), scope.Reads.Failure);
        // The owner no longer lists it: the extra's owner changed.
        series.ExtraIds = [];
        Assert.False(scope.Reads.Valid());
    }
#endif

    /// <summary>The host's chapter timeline, its reads listed (checked against the running attempt's read-set afterwards).</summary>
    private sealed class AuditedChapters
    {
        public long Start;
        public List<string> Asked { get; } = new();
        public IChapterManager Object { get; }

        public AuditedChapters(long start)
        {
            Start = start;
            var mock = new Mock<IChapterManager>();
            mock.Setup(c => c.GetChapter(It.IsAny<Guid>(), It.IsAny<int>())).Returns((Guid item, int index) =>
            {
                Asked.Add("chapter:" + item.ToString("N") + ":" + index);
                return new ChapterInfo { StartPositionTicks = Start };
            });
            Object = mock.Object;
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void EveryHostTimelineADecisionReadsIsInItsReadSet(bool planted)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var movie = rig.Items[Role("movie:guarded")];
        var chapters = new AuditedChapters(10);
        using var scope = PrivacyReadSet.Begin();
        // The accessor reads (and records) the chapter; a planted direct read does not.
        var chapter = planted ? chapters.Object.GetChapter(movie.Id, 0) : PrivacyReads.Chapter(chapters.Object, movie.Id, 0);
        Assert.Equal(10, chapter!.StartPositionTicks);
        var outside = chapters.Asked.Where(key => !scope.Reads.Named.Contains(key)).ToList();
        Assert.Equal(planted, outside.Count > 0);
        // A recorded timeline that moves fails the gate; a planted read's change goes unseen (why every read is recorded).
        chapters.Start = 200;
        Assert.Equal(planted, scope.Reads.Valid());
    }

    [Fact]
    public void ASeasonsEpisodesAreReadWithTheHostsSpecialsSetting()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var season = (Season)rig.Items[Role("season:show-s1")];
        var hostConfig = new MediaBrowser.Model.Configuration.ServerConfiguration { DisplaySpecialsWithinSeasons = true };
        var manager = new Mock<MediaBrowser.Controller.Configuration.IServerConfigurationManager>();
        manager.SetupGet(m => m.Configuration).Returns(hostConfig);
        var previous = BaseItem.ConfigurationManager;
        BaseItem.ConfigurationManager = manager.Object;
        try
        {
            rig.Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
                (q.ItemIds ?? []).Select(id => rig.Items.GetValueOrDefault(id)).OfType<BaseItem>().ToList());
            using var scope = PrivacyReadSet.Begin();
            var read = PrivacyReads.SeasonWatchedOrUnknown(rig.Library.Object, rig.UserData.Object, rig.Users.Object.GetUserById(rig.Viewer)!, season);
            Assert.Contains(PrivacyReads.SpecialsInSeasons, scope.Reads.Named);
            Assert.True(read == null || scope.Reads.HoldsWatched(rig.Viewer, season.Id));
            hostConfig.DisplaySpecialsWithinSeasons = false;
            Assert.False(scope.Reads.Valid());
        }
        finally { BaseItem.ConfigurationManager = previous; }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Precision and one decision per item.

    private static async Task<IActionResult> Image(PrivacyHostShapeModelTests.Rig rig, Guid item, Guid viewer, Action? during = null, string type = "Primary", IChapterManager? chapters = null)
    {
        var identity = new RequestIdentityService(Mock.Of<ISessionManager>(), rig.Users.Object, new SpoilerIdentityService(rig.Users.Object, rig.F.Core.Logger), rig.F.Core.Logger);
        var resolver = new SpoilerUserResolver(rig.F.Core.Manager, rig.Library.Object, rig.F.Core.Logger, identity);
        using var next = new SpoilerNextUnwatchedService(rig.Library.Object, rig.Users.Object, rig.UserData.Object, rig.F.Core.Logger);
        using var filter = new SpoilerBlurImageFilter(rig.Library.Object, rig.Users.Object, rig.UserData.Object, chapters ?? Mock.Of<IChapterManager>(), resolver,
            new ImageBlurService(rig.F.Core.Logger), next, rig.F.Core.Logger);
        var http = new DefaultHttpContext();
        http.Response.Body = new MemoryStream();
        http.Request.Method = "GET";
        http.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", viewer.ToString())], "Test"));
        var action = new ActionContext(http, new RouteData(), new ActionDescriptor { RouteValues = new Dictionary<string, string?> { ["controller"] = "Image", ["action"] = "GetItemImage" } }, new ModelStateDictionary());
        var executing = new ActionExecutingContext(action, [], new Dictionary<string, object?> { ["itemId"] = item, ["imageType"] = type, ["imageIndex"] = 0 }, new object());
        var executed = new ActionExecutedContext(action, [], new object()) { Result = new FileContentResult(PosterBlurTests.Source(), "image/png") };
        await filter.OnActionExecutionAsync(executing, async () => { await Task.Yield(); during?.Invoke(); return executed; });
        return executed.Result!;
    }

    private static bool Original(IActionResult result) => result is FileContentResult file && file.FileContents.SequenceEqual(PosterBlurTests.Source());

    [Fact]
    public async Task ARewindWhileAChapterImageLoadsProtectsTheChapterAgain()
    {
        // The chapter image's decision uses the playback position (the poster's does not; RoutinePlaybackProgress...).
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var movie = rig.Items[Role("movie:guarded")];
        var state = new UserSpoilerBlur();
        state.Movies[movie.Id.ToString("N")] = new();
        rig.F.Core.Manager.SaveUserConfiguration(rig.Admin.ToString("N"), "spoilerblur.json", state);
        long position = 100;
        rig.UserData.Setup(d => d.GetUserData(It.IsAny<Jellyfin.Database.Implementations.Entities.User>(), movie)).Returns(() => new UserItemData { Key = "k", Played = false, PlaybackPositionTicks = position });
        Assert.True(Original(await Image(rig, movie.Id, rig.Admin, type: "Chapter", chapters: new AuditedChapters(50).Object)), "a chapter before the resume point is revealed");
        var result = await Image(rig, movie.Id, rig.Admin, () =>
        {
            position = 0;
            rig.UserData.Raise(d => d.UserDataSaved += null, rig.UserData.Object, new UserDataSaveEventArgs
            {
                UserId = rig.Admin, Item = movie, SaveReason = UserDataSaveReason.PlaybackProgress,
                UserData = new UserItemData { Key = "k", Played = false, PlaybackPositionTicks = 0 },
            });
        }, "Chapter", new AuditedChapters(50).Object);
        Assert.False(Original(result), "the viewer rewound before the chapter, but its original image was sent");
    }

    public static IEnumerable<object[]> Representations() =>
    [
        ["unwatched episode", "episode:show-e1", false, false, true],
        ["watched episode", "episode:show-e1", true, false, false],
        ["next episode, its title revealed", "episode:show-e1", false, true, false],
        ["extra of a guarded show", "extra:showFeature:0", false, false, true],
    ];

    [Theory]
    [MemberData(nameof(Representations))]
    public async Task EveryRepresentationOfAnItemGetsTheSameDecision(string name, string role, bool watched, bool nextTitleRevealed, bool titleProtected)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        Guard(rig, rig.Admin);
        Guard(rig, rig.Viewer);
        var id = Role(role);
        var item = rig.Items[id];
        if (watched) { rig.Played.Add((rig.Admin, id)); rig.Played.Add((rig.Viewer, id)); }
        var config = rig.F.Plugin.Configuration;
        if (nextTitleRevealed)
        {
            config.SpoilerAdvancedMode = true;
            config.SpoilerNextEpisodeStripTitle = false;
            rig.Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => q.ItemIds is { Length: > 0 }
                ? q.ItemIds.Select(i => rig.Items.GetValueOrDefault(i)).OfType<BaseItem>().ToList() : new List<BaseItem> { item });
        }
        const string Sentinel = "R25 representation title";
        var kind = item is Episode ? BaseItemKind.Episode : BaseItemKind.Video;
        // The item answer.
        var viewer = rig.Viewer;
        var state = rig.F.Core.Manager.GetUserConfiguration<UserSpoilerBlur>(viewer.ToString("N"), "spoilerblur.json");
        var dto = new BaseItemDto { Id = id, Type = kind, Name = Sentinel, ParentIndexNumber = item.ParentIndexNumber ?? 1, IndexNumber = item.IndexNumber ?? 1,
            SeriesId = (item as Episode)?.SeriesId, UserData = new() { Key = "k", Played = watched } };
        var dtoKept = rig.Strip.StripLibraryItem(dto, PrivacyIdentities.Of(rig.Library.Object, item), state, config, viewer).Name == Sentinel;
        // A search hint and an activity entry.
        var hint = new SearchHint { Id = id, Type = kind, Name = Sentinel, ParentIndexNumber = item.ParentIndexNumber ?? 1, IndexNumber = item.IndexNumber ?? 1 };
        var (_, hints) = await PrivacyHostShapeModelTests.Deliver(rig, Shot("Search.GetSearchHints.json"), answer: new SearchHintResult([hint], 1));
        var activityShot = Shot("ActivityLog.GetLogEntries.json");
        var activityViewer = activityShot.Viewer == "viewer" ? rig.Viewer : rig.Admin;
        var (_, activity) = await PrivacyHostShapeModelTests.Deliver(rig, activityShot,
            answer: new QueryResult<ActivityLogEntry> { Items = [new("Playing " + Sentinel, "VideoPlayback", activityViewer) { Id = 1, ItemId = id.ToString("N") }] });
        var decisions = new Dictionary<string, bool>
        {
            ["item"] = !dtoKept,
            ["search hint"] = !hints.Contains(Sentinel, StringComparison.Ordinal),
            ["activity"] = !activity.Contains(Sentinel, StringComparison.Ordinal),
        };
        Assert.True(decisions.Values.All(v => v == titleProtected), $"{name}: " + string.Join(", ", decisions.Select(d => d.Key + "=" + (d.Value ? "protected" : "revealed"))));
        // Its image: protected exactly when the item is (a title reveal is not an image reveal).
        var imageProtected = !Original(await Image(rig, id, viewer));
        Assert.Equal(!watched, imageProtected);
    }
}
