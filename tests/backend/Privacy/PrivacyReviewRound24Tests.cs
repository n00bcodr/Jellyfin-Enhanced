#pragma warning disable ASPDEPR004, ASPDEPR008 // TestServer over a WebHostBuilder: the in-process host the delivery tests drive
using System.Net;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Chapters;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Controller.Trickplay;
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
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace JE.Tests;

/// <summary>
/// Review round 24 and the full-track audit's held findings (one commit point for complete answers; live and complete
/// verdict inputs; correct read-set mechanics; precision; one complete per-item decision). Round 23's read-set and byte gate
/// held as structure, but a streamed answer cannot take back bytes the client already read (D46-R24-1) and a 304 was
/// confirmed before the response's start callbacks ran (-2); ownership was compared with remembered facts, so an episode the
/// host moved before announcing it kept its old show (-3); cached tag entries supplied their own old series key (-4); episode
/// numbering (-5), a movie answer's own playback position (-6), the chapter and trickplay timelines (-7) and the host's
/// specials setting (-8) were read without being recorded; the watched state a batch query established was not remembered,
/// so the first progress save after a start looked like a watched change (-9); a policy save during the gate's walk was
/// blessed by the epoch sampled after it (-10); a remembered boundary backdated the whole read-set (-11); every image read
/// the playback position (-12). The audit: guarded extras' images (AX-01) and native logos (AX-02) were not protected, a
/// shared address picked one candidate (AX-03), provider answers kept later season names (AX-11), and search hints, the
/// activity log and tag data ignored the advanced next-episode reveal (AX-13). Uses only the surface the pre-fix build has,
/// so the same file runs against it.
/// </summary>
[Collection("Plugin singleton")]
public class PrivacyReviewRound24Tests
{
    private static Guid Role(string role) => Guid.Parse(PrivacyHostShapeModelTests.Data.Roles[role]);
    private static PrivacyHostShapeModelTests.Shot Shot(string file) => PrivacyHostShapeModelTests.Data.Shots.Single(s => s.File == file);
    private static void Guard(PrivacyHostShapeModelTests.Rig rig, Guid viewer) => rig.Commit(PrivacyHostShapeModelTests.Rules.Single(r => r.Id == "sg-series"), viewer);
    private static void Updated(PrivacyHostShapeModelTests.Rig rig, BaseItem item)
        => rig.Library.Raise(l => l.ItemUpdated += null, rig.Library.Object, new ItemChangeEventArgs { Item = item, UpdateReason = ItemUpdateType.MetadataImport });

    private static void Progress(Mock<IUserDataManager> data, Guid user, BaseItem item, bool played, long position)
        => data.Raise(d => d.UserDataSaved += null, data.Object, new UserDataSaveEventArgs
        {
            UserId = user, Item = item, SaveReason = UserDataSaveReason.PlaybackProgress,
            UserData = new UserItemData { Key = "k", Played = played, PlaybackPositionTicks = position },
        });

    /// <summary>The image filter around one image request: the action loads <paramref name="source"/>, running <paramref name="during"/> while it loads.</summary>
    private static async Task<(IActionResult Result, DefaultHttpContext Http, MemoryStream Bytes)> Image(PrivacyHostShapeModelTests.Rig rig, Guid item, IActionResult source,
        Action? during = null, string type = "Primary", IChapterManager? chapters = null, ITrickplayManager? trickplay = null, Guid? user = null,
        ISessionManager? sessions = null, IPAddress? address = null)
    {
        var identity = new RequestIdentityService(sessions ?? Mock.Of<ISessionManager>(), rig.Users.Object, new SpoilerIdentityService(rig.Users.Object, rig.F.Core.Logger), rig.F.Core.Logger);
        var resolver = new SpoilerUserResolver(rig.F.Core.Manager, rig.Library.Object, rig.F.Core.Logger, identity);
        using var next = new SpoilerNextUnwatchedService(rig.Library.Object, rig.Users.Object, rig.UserData.Object, rig.F.Core.Logger);
        using var filter = new SpoilerBlurImageFilter(rig.Library.Object, rig.Users.Object, rig.UserData.Object, chapters ?? Mock.Of<IChapterManager>(), resolver,
            new ImageBlurService(rig.F.Core.Logger), next, rig.F.Core.Logger);
        var http = new DefaultHttpContext();
        var bytes = new MemoryStream();
        http.Response.Body = bytes;
        http.Request.Method = "GET";
        if (address != null) http.Connection.RemoteIpAddress = address;
        if (trickplay != null) http.RequestServices = new ServiceCollection().AddSingleton(trickplay).BuildServiceProvider();
        if (sessions == null) http.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", (user ?? rig.Admin).ToString())], "Test"));
        var action = new ActionContext(http, new RouteData(), new ActionDescriptor
        {
            RouteValues = new Dictionary<string, string?> { ["controller"] = trickplay == null ? "Image" : "Trickplay", ["action"] = trickplay == null ? "GetItemImage" : "GetTrickplayTileImage" },
        }, new ModelStateDictionary());
        var executing = new ActionExecutingContext(action, [], new Dictionary<string, object?> { ["itemId"] = item, ["imageType"] = type, ["imageIndex"] = 0, ["width"] = 320, ["index"] = 0 }, new object());
        var executed = new ActionExecutedContext(action, [], new object()) { Result = source };
        await filter.OnActionExecutionAsync(executing, async () => { await Task.Yield(); during?.Invoke(); return executed; });
        return (executed.Result!, http, bytes);
    }

    private static FileContentResult Original() => new(PosterBlurTests.Source(), "image/png");

    private static bool IsOriginal(IActionResult result) => result is FileContentResult file && file.FileContents.SequenceEqual(PosterBlurTests.Source());

    // ---------------------------------------------------------------------------------------------------------------
    // Shape 1: one commit point. Nothing protected leaves before the complete answer is validated; a 304 is confirmed at
    // the header commit.

    /// <summary>A server whose one request runs <paramref name="handler"/>; the client collects every byte it can read.</summary>
    private static async Task<(int? Status, string Body)> Fetch(Func<HttpContext, Func<Task>, Task> handler, Action<IServiceCollection>? services = null)
    {
        var seen = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var server = new TestServer(new WebHostBuilder()
            .ConfigureServices(s => { s.AddControllers(); services?.Invoke(s); })
            .Configure(app => app.Run(http => handler(http, () => Task.WhenAny(seen.Task, Task.Delay(TimeSpan.FromSeconds(2)))))));
        using var client = server.CreateClient();
        var body = new MemoryStream();
        int? status = null;
        try
        {
            using var response = await client.GetAsync("/", HttpCompletionOption.ResponseHeadersRead);
            status = (int)response.StatusCode;
            await using var stream = await response.Content.ReadAsStreamAsync();
            var buffer = new byte[4096];
            int read;
            while ((read = await stream.ReadAsync(buffer).AsTask().WaitAsync(TimeSpan.FromSeconds(10))) > 0)
            {
                body.Write(buffer, 0, read);
                seen.TrySetResult();
            }
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or OperationCanceledException) { }
        return (status, Encoding.UTF8.GetString(body.ToArray()));
    }

    [Fact]
    public async Task AGuardSavedWhileAnAnswerIsStillBeingWrittenSendsNothingItProtects()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var saved = false;
        var (status, body) = await Fetch(async (http, clientRead) =>
        {
            var first = Encoding.UTF8.GetBytes("{\"overview\":\"R25 protected first half of the answer\",");
            var last = Encoding.UTF8.GetBytes("\"name\":\"R25 last\"}");
            var text = PrivacyDelivery.Deliver(rig.Viewer, () => { rig.F.Core.Manager.GetUserConfiguration<UserSpoilerBlur>(rig.Viewer.ToString("N"), "spoilerblur.json"); return "built"; }, http);
            Assert.NotNull(text);
            http.Response.ContentLength = first.Length + last.Length;
            await http.Response.Body.WriteAsync(first);
            await http.Response.Body.FlushAsync();
            // A slow transport: the rest of the answer is written later (the client may already be reading).
            await clientRead();
            Guard(rig, rig.Viewer);
            saved = true;
            try { await http.Response.Body.WriteAsync(last); } catch (Exception) { }
        });
        Assert.True(saved);
        Assert.DoesNotContain("R25 protected first half", body);
        Assert.NotEqual(200, status ?? 0);
    }

    [Fact]
    public async Task ACompleteAnswerWhoseInputsHoldIsDelivered()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var (status, body) = await Fetch(async (http, _) =>
        {
            var answer = Encoding.UTF8.GetBytes("{\"overview\":\"R25 correct answer\"}");
            Assert.NotNull(PrivacyDelivery.Deliver(rig.Viewer, () => { rig.F.Core.Manager.GetUserConfiguration<UserSpoilerBlur>(rig.Viewer.ToString("N"), "spoilerblur.json"); return "built"; }, http));
            http.Response.ContentLength = answer.Length;
            await http.Response.Body.WriteAsync(answer.AsMemory(0, 10));
            await http.Response.Body.WriteAsync(answer.AsMemory(10));
        });
        Assert.Equal(200, status);
        Assert.Equal("{\"overview\":\"R25 correct answer\"}", body);
    }

    /// <summary>Serializes episode DTOs, saving a guard once while the host's executor is past the first ones (after its first flush).</summary>
    private sealed class SaveWhileWriting(Action save, int at) : System.Text.Json.Serialization.JsonConverter<BaseItemDto>
    {
        private int _written;

        public override BaseItemDto? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) => throw new NotSupportedException();

        public override void Write(Utf8JsonWriter writer, BaseItemDto value, JsonSerializerOptions options)
        {
            if (++_written == at) save();
            writer.WriteStartObject();
            writer.WriteString("Id", value.Id.ToString("N"));
            writer.WriteString("Name", value.Name);
            writer.WriteString("Overview", value.Overview);
            writer.WriteEndObject();
        }
    }

    [Fact]
    public async Task AGuardSavedWhileTheHostWritesALongNativeAnswerLeavesNoProtectedText()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var shot = Shot("TvShows.GetEpisodes.json");
        var template = PrivacyHostShapeModelTests.Context(shot, rig.Viewer);
        var ep = (Episode)rig.Items[Role("episode:show-e1")];
        var saved = false;
        var converter = new SaveWhileWriting(() => { Guard(rig, rig.Viewer); saved = true; }, 120);
        var (status, body) = await Fetch(async (http, _) =>
        {
            http.User = template.HttpContext.User;
            var action = new ActionContext(http, template.RouteData, template.ActionDescriptor);
            var gate = rig.Gate();
            gate.OnResourceExecuting(new ResourceExecutingContext(action, [], []));
            // Long enough that the host's serializer hands the answer over in several writes.
            var dtos = Enumerable.Range(0, 200).Select(i => new BaseItemDto
            {
                Id = ep.Id, Type = BaseItemKind.Episode, SeriesId = ep.SeriesId, ParentIndexNumber = 1, IndexNumber = 1,
                Name = "R25 native protected title", Overview = "R25 native protected synopsis " + new string('x', 400), UserData = new UserItemDataDto { Played = false, Key = "k" },
            }).ToArray();
            var result = new ResultExecutingContext(action, [], new ObjectResult(new QueryResult<BaseItemDto>(dtos)), new object());
            gate.OnResultExecuting(result);
            try { await result.Result.ExecuteResultAsync(action); } catch (Exception) { }
        }, services => services.AddControllers().AddJsonOptions(o => o.JsonSerializerOptions.Converters.Add(converter)));
        Assert.True(saved);
        Assert.DoesNotContain("R25 native protected synopsis", body);
        Assert.DoesNotContain("R25 native protected title", body);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AValidatorIsConfirmedOnlyAtTheHeaderCommit(bool saveWhileStarting)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var saved = false;
        using var server = new TestServer(new WebHostBuilder().Configure(app => app.Run(async http =>
        {
            var text = PrivacyDelivery.Deliver(rig.Viewer, () => { rig.F.Core.Manager.GetUserConfiguration<UserSpoilerBlur>(rig.Viewer.ToString("N"), "spoilerblur.json"); return "old unprotected client copy"; }, http);
            Assert.NotNull(text);
            http.Response.Headers.ETag = "\"unprotected-copy\"";
            // Another start callback (the host's or a later filter's) runs as the headers are committed.
            http.Response.OnStarting(() => { if (saveWhileStarting) { Guard(rig, rig.Viewer); saved = true; } return Task.CompletedTask; });
            await PrivacyResponseGuard.Confirm(http, new StatusCodeResult(304)).ExecuteResultAsync(new ActionContext(http, new RouteData(), new ActionDescriptor()));
        })));
        using var client = server.CreateClient();
        using var response = await client.GetAsync("/");
        Assert.Equal(saveWhileStarting, saved);
        Assert.Equal(!saveWhileStarting, response.StatusCode == HttpStatusCode.NotModified);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Shape 2: live and complete verdict inputs.

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void AnEpisodeTheHostMovedBeforeAnnouncingItIsJudgedByItsLiveShow(bool eventBeforeGate)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        Guard(rig, rig.Admin);
        var ep = (Episode)rig.Items[Role("episode:show-e1")];
        var guarded = ep.SeriesId;
        var plain = new Series { Id = Guid.NewGuid(), Name = "Plain" };
        rig.Items[plain.Id] = plain;
        ep.SeriesId = plain.Id;
        var moved = false;
        rig.UserData.Setup(d => d.GetUserData(It.IsAny<Jellyfin.Database.Implementations.Entities.User>(), ep)).Returns(() =>
        {
            // The host moves the item in memory, and saves and announces it later.
            if (!moved) { moved = true; ep.SeriesId = guarded; if (eventBeforeGate) Updated(rig, ep); }
            return new UserItemData { Key = "k", Played = false };
        });
        var context = PrivacyHostShapeModelTests.Context(Shot("ActivityLog.GetLogEntries.json"), rig.Admin);
        var gate = rig.Gate();
        gate.OnResourceExecuting(new ResourceExecutingContext(context, [], []));
        var entry = new ActivityLogEntry("R25 protected old episode text", "VideoPlayback", rig.Admin) { ItemId = ep.Id.ToString("N") };
        var delivery = new ResultExecutingContext(context, [], new ObjectResult(new QueryResult<ActivityLogEntry>([entry])), new object());
        gate.OnResultExecuting(delivery);
        var text = JsonSerializer.Serialize(Assert.IsAssignableFrom<ObjectResult>(delivery.Result).Value);
        Assert.True(moved);
        Assert.DoesNotContain("R25 protected old episode text", text);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task ACachedTagEntrysOwnSeriesKeyNeverDecidesItsVerdict(bool hidden, bool freshSnapshot)
    {
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: false, stripTags: true, edit: entries =>
        {
            foreach (var e in entries.Values.Where(e => e.Type is "Episode" or "Season")) e.SeriesTmdbId = freshSnapshot ? "5678" : "1234";
        });
        if (hidden)
        {
            var hc = new UserHiddenContent { Settings = new() { FilterLibrary = true } };
            hc.Items["tv:tmdb:5678"] = new() { Type = "Series", TmdbId = "5678" };
            site.Fixture.Core.Manager.SaveUserConfiguration(site.Alice.Id.ToString("N"), "hidden-content.json", hc);
            HiddenContentResponseFilter.InvalidateUser(site.Alice.Id.ToString("N"));
        }
        else
        {
            site.State.ProviderTitles["tv:tmdb:5678"] = new();
            site.Fixture.Core.Manager.SaveUserConfiguration(site.Alice.Id.ToString("N"), "spoilerblur.json", site.State);
            SpoilerUserResolver.InvalidateUser(site.Alice.Id.ToString("N"));
        }
        // The show's key is now 5678 (the host saved and announced it); its cached entries were built with 1234.
        site.Items[site.Series].SetProviderId(MetadataProvider.Tmdb, "5678");
        site.Updated(site.Series);
        var (status, body, _) = await site.TagCacheResponse();
        Assert.Equal(200, status);
        Assert.DoesNotContain(site.Sentinels.In(body), p => p.StartsWith("episodeEntry.StreamData", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RenumberingAnEarlierEpisodeWhileTheNextOnesImageLoadsRevokesItsReveal(bool renumber)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        Guard(rig, rig.Admin);
        var current = (Episode)rig.Items[Role("episode:show-e1")];
        current.IndexNumber = 2; current.ParentIndexNumber = 1;
        var earlier = new Episode { Id = Guid.NewGuid(), SeriesId = current.SeriesId, SeasonId = current.SeasonId, IndexNumber = 3, ParentIndexNumber = 1 };
        rig.Items[earlier.Id] = earlier;
        rig.Library.Raise(l => l.ItemAdded += null, rig.Library.Object, new ItemChangeEventArgs { Item = earlier });
        rig.F.Plugin.Configuration.SpoilerAdvancedMode = true;
        rig.F.Plugin.Configuration.SpoilerNextEpisodeStripImage = false;
        rig.Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => q.ItemIds is { Length: > 0 }
            ? q.ItemIds.Select(i => rig.Items.GetValueOrDefault(i)).OfType<BaseItem>().ToList()
            : new[] { current, earlier }.OrderBy(e => e.IndexNumber).Cast<BaseItem>().Take(1).ToList());
        var (result, _, _) = await Image(rig, current.Id, Original(), () => { if (renumber) { earlier.IndexNumber = 1; Updated(rig, earlier); } });
        Assert.Equal(!renumber, IsOriginal(result));
    }

    [Fact]
    public async Task AChapterThatMovesPastTheResumePointWhileItsImageLoadsIsProtected()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var movie = rig.Items[Role("movie:guarded")];
        // A warm host: the movie's first update after the start is not what invalidates.
        Updated(rig, movie);
        var state = new UserSpoilerBlur(); state.Movies[movie.Id.ToString("N")] = new();
        rig.F.Core.Manager.SaveUserConfiguration(rig.Admin.ToString("N"), "spoilerblur.json", state);
        rig.UserData.Setup(d => d.GetUserData(It.IsAny<Jellyfin.Database.Implementations.Entities.User>(), movie)).Returns(new UserItemData { Key = "k", Played = false, PlaybackPositionTicks = 100 });
        var chapters = new Mock<IChapterManager>();
        var chapter = new ChapterInfo { StartPositionTicks = 10 };
        chapters.Setup(c => c.GetChapter(movie.Id, 0)).Returns(() => chapter);
        var (result, _, _) = await Image(rig, movie.Id, Original(), () => { chapter.StartPositionTicks = 200; Updated(rig, movie); }, "Chapter", chapters.Object);
        chapters.Verify(c => c.GetChapter(movie.Id, 0), Times.AtLeastOnce());
        Assert.False(IsOriginal(result), "the chapter now starts past the resume point, but its original image was sent");
    }

    [Fact]
    public async Task ATrickplayIntervalChangedWhileItsTileLoadsIsProtected()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        Guard(rig, rig.Admin);
        var ep = (Episode)rig.Items[Role("episode:show-e1")];
        Updated(rig, ep);
        rig.UserData.Setup(d => d.GetUserData(It.IsAny<Jellyfin.Database.Implementations.Entities.User>(), ep)).Returns(new UserItemData { Key = "k", Played = false, PlaybackPositionTicks = TimeSpan.FromSeconds(5).Ticks });
        var manager = new Mock<ITrickplayManager>();
        var info = new Jellyfin.Database.Implementations.Entities.TrickplayInfo { TileWidth = 1, TileHeight = 1, Interval = 1000 };
        manager.Setup(m => m.GetTrickplayResolutions(ep.Id)).ReturnsAsync(new Dictionary<int, Jellyfin.Database.Implementations.Entities.TrickplayInfo> { [320] = info });
        var (result, _, _) = await Image(rig, ep.Id, Original(), () => { info.Interval = 10000; Updated(rig, ep); }, trickplay: manager.Object);
        manager.Verify(m => m.GetTrickplayResolutions(ep.Id), Times.AtLeastOnce());
        Assert.False(IsOriginal(result), "the tile now reaches past the resume point, but its original image was sent");
    }

    [Fact]
    public async Task TheHostsSpecialsInSeasonsSettingIsAnInputOfASeasonImage()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        Guard(rig, rig.Admin);
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
            var (result, _, _) = await Image(rig, season.Id, Original(), () => hostConfig.DisplaySpecialsWithinSeasons = false);
            Assert.DoesNotContain(special, season.GetEpisodes(user, new MediaBrowser.Controller.Dto.DtoOptions(false), false));
            Assert.False(IsOriginal(result), "the season holds no watched episode any more, but its original poster was sent");
        }
        finally { BaseItem.ConfigurationManager = previous; }
    }

    [Fact]
    public async Task AMoviesChapterRevealFollowsItsLivePlaybackPosition()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var movie = rig.Items[Role("movie:guarded")];
        var state = new UserSpoilerBlur(); state.Movies[movie.Id.ToString("N")] = new();
        rig.F.Core.Manager.SaveUserConfiguration(rig.Viewer.ToString("N"), "spoilerblur.json", state);
        rig.F.Plugin.Configuration.SpoilerStripChapters = true;
        long position = 1000;
        rig.UserData.Setup(d => d.GetUserData(It.IsAny<Jellyfin.Database.Implementations.Entities.User>(), movie))
            .Returns(() => new UserItemData { Key = "k", Played = false, PlaybackPositionTicks = position });
        PrivacyReads.UserData(rig.UserData.Object, rig.Users.Object.GetUserById(rig.Viewer)!, movie);
        var action = PrivacyHostShapeModelTests.Context(Shot("Items.GetItems.json"), rig.Viewer);
        var gate = rig.Gate();
        gate.OnResourceExecuting(new ResourceExecutingContext(action, [], []));
        var dto = new BaseItemDto
        {
            Id = movie.Id, Type = BaseItemKind.Movie, Name = movie.Name,
            UserData = new UserItemDataDto { Key = "k", Played = false, PlaybackPositionTicks = position },
            Chapters = [new ChapterInfo { StartPositionTicks = 500, Name = "R25 chapter past the new resume point" }],
        };
        var result = new ResultExecutingContext(action, [], new ObjectResult(new QueryResult<BaseItemDto>([dto])), new object());
        gate.OnResultExecuting(result);
        Assert.Contains("R25 chapter past the new resume point", JsonSerializer.Serialize(Assert.IsAssignableFrom<ObjectResult>(result.Result).Value));
        // The viewer rewinds before the answer is written.
        position = 0;
        Progress(rig.UserData, rig.Viewer, movie, false, position);
        using var provider = new ServiceCollection().AddLogging().AddControllers().Services.BuildServiceProvider();
        action.HttpContext.RequestServices = provider;
        using var body = new MemoryStream();
        action.HttpContext.Response.Body = body;
        await result.Result.ExecuteResultAsync(action);
        Assert.DoesNotContain("R25 chapter past the new resume point", Encoding.UTF8.GetString(body.ToArray()));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task TheFirstProgressSaveAfterAStartDoesNotCutACorrectTagCache(bool seedWatched)
    {
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: true, stripTags: true);
        typeof(PrivacyReviewRound19Tests.TagSite).GetMethod("SignIn", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.Invoke(site, null);
        var http = site.Controller.HttpContext;
        http.Request.Method = "GET";
        var responseFeature = new StartedResponseFeature();
        http.Features.Set<Microsoft.AspNetCore.Http.Features.IHttpResponseFeature>(responseFeature);
        var lifetime = new Mock<Microsoft.AspNetCore.Http.Features.IHttpRequestLifetimeFeature>();
        var aborted = false;
        lifetime.Setup(l => l.Abort()).Callback(() => aborted = true);
        http.Features.Set(lifetime.Object);
        if (seedWatched) site.UserData.Object.GetUserData(site.Alice, site.Items[site.Episode]);
        long declared = 0;
        using var output = new FirstWriteStream(() =>
        {
            declared = http.Response.ContentLength ?? 0;
            Progress(site.UserData, site.Alice.Id, site.Items[site.Episode], false, TimeSpan.TicksPerSecond);
        }, () => responseFeature.Started = true);
        http.Response.Body = output;
        var answer = site.Controller.GetTagCache(site.Alice.Id);
        await answer.ExecuteResultAsync(new ActionContext(http, new RouteData(), new ActionDescriptor()));
        Assert.True(declared > 1, "the tag cache never began writing");
        Assert.True(output.Length == declared && !aborted, $"seedWatched={seedWatched}: a progress save that left the watched state as it was cut the tag cache: aborted={aborted}, status={http.Response.StatusCode}, bytes={output.Length}/{declared}");
    }

    private sealed class FirstWriteStream(Action during, Action? sent = null) : MemoryStream
    {
        private bool _first = true;

        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (_first) { _first = false; await Task.Yield(); during(); }
            await base.WriteAsync(buffer, cancellationToken);
            sent?.Invoke();
        }

        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
            => WriteAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();
    }

    private sealed class StartedResponseFeature : Microsoft.AspNetCore.Http.Features.HttpResponseFeature
    {
        public bool Started;

        public override bool HasStarted => Started;
    }

    [Fact]
    public void AProgressSaveAfterABatchEstablishedTheWatchedStateIsNotAWatchedChange()
    {
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: true, stripTags: true);
        var config = site.Fixture.Plugin.Configuration;
        var state = site.Fixture.Core.Manager.GetUserConfiguration<UserSpoilerBlur>(site.Alice.Id.ToString("N"), "spoilerblur.json");
        var policy = SpoilerTagDataStripper.CreatePolicy(config, state)!;
        var items = new Dictionary<string, Jellyfin.Plugin.JellyfinEnhanced.Model.TagCacheEntry>(StringComparer.Ordinal)
        {
            [site.Episode.ToString("N")] = new() { Type = "Episode", SeriesId = site.Series.ToString("N"), SeasonNumber = 1, EpisodeNumber = 3 },
        };
        using var scope = PrivacyReadSet.Begin();
        site.Stripper.StripTagCache(policy, site.Alice, items);
        // The batch query established that the episode is unwatched: a progress save that keeps it unwatched changes no verdict.
        Progress(site.UserData, site.Alice.Id, site.Items[site.Episode], false, TimeSpan.TicksPerSecond);
        Assert.True(scope.Reads.Valid(), "a routine progress save invalidated an answer that only read the watched state");
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Shape 3: read-set mechanics. Shape 4: precision.

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void APolicySavedWhileTheGateRereadsIsNotTakenAsChecked(bool byteRecheck)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        using var scope = PrivacyReadSet.Begin();
        rig.F.Core.Manager.GetUserConfiguration<UserSpoilerBlur>(rig.Viewer.ToString("N"), "spoilerblur.json");
        var armed = false;
        // The last named input's re-read is where the save lands: after the policy document was compared, before the walk ends.
        scope.Reads.Revision("last reread checkpoint", "same", () => { if (armed) { armed = false; Guard(rig, rig.Viewer); } return "same"; });
        Assert.True(scope.Reads.Valid());
        if (byteRecheck) rig.F.Core.Manager.SaveUserConfiguration(rig.Admin.ToString("N"), "hidden-content.json", new UserHiddenContent());
        armed = true;
        if (byteRecheck) scope.Reads.StillValid(); else scope.Reads.Valid();
        Assert.False(armed, "the save happened within the walk");
        Assert.False(scope.Reads.StillValid(), "the old guard document was accepted as checked under the epoch of the new one");
    }

    [Fact]
    public void ARememberedBoundaryDoesNotBackdateTheOtherItemsOfTheAnswer()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var viewer = rig.Viewer;
        Guard(rig, viewer);
        rig.F.Plugin.Configuration.SpoilerAdvancedMode = true;
        var first = (Episode)rig.Items[Role("episode:show-e1")];
        first.ParentIndexNumber = 1; first.IndexNumber = 1;
        var next = (SpoilerNextUnwatchedService)typeof(PrivacyHostShapeModelTests.Rig).GetField("_next", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.GetValue(rig)!;
        next.BoundaryComputerForTest = (_, _) => new(first.Id, 1, 1);
        next.GetBoundary(viewer, first.SeriesId);
        var otherSeries = new Series { Id = Guid.NewGuid(), Name = "Unrelated plain show" };
        var other = new Episode { Id = Guid.NewGuid(), SeriesId = otherSeries.Id, SeasonId = Guid.NewGuid(), IndexNumber = 1, ParentIndexNumber = 1 };
        rig.Items[otherSeries.Id] = otherSeries; rig.Items[other.Id] = other;
        // An update completed before this request (it does not touch the remembered boundary).
        rig.Library.Raise(l => l.ItemUpdated += null, rig.Library.Object, new ItemChangeEventArgs { Item = other, UpdateReason = ItemUpdateType.MetadataImport });
        BaseItemDto Dto(Episode e) => new()
        {
            Id = e.Id, Type = BaseItemKind.Episode, SeriesId = e.SeriesId, SeasonId = e.SeasonId,
            Name = "Correct episode name", Overview = "Correct overview", ParentIndexNumber = 1, IndexNumber = 1, UserData = new() { Key = "k", Played = false },
        };
        var shot = Shot("Items.GetItems.json");
        var context = PrivacyHostShapeModelTests.Context(shot, viewer);
        var gate = rig.Gate();
        gate.OnResourceExecuting(new ResourceExecutingContext(context, [], []));
        var delivery = new ResultExecutingContext(context, [], new ObjectResult(new QueryResult<BaseItemDto>([Dto(first), Dto(other)])), new object());
        gate.OnResultExecuting(delivery);
        Assert.True(delivery.Result is ObjectResult, $"a stable answer was withheld: {(delivery.Result as StatusCodeResult)?.StatusCode}");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RoutinePlaybackProgressNeverWithholdsAnEpisodePoster(bool played)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        Guard(rig, rig.Admin);
        var episode = rig.Items[Role("episode:show-e1")];
        if (played) rig.Played.Add((rig.Admin, episode.Id));
        var (result, http, bytes) = await Image(rig, episode.Id, Original());
        var expected = Assert.IsType<FileContentResult>(result).FileContents.Length;
        Progress(rig.UserData, rig.Admin, episode, played, TimeSpan.TicksPerSecond);
        using var provider = new ServiceCollection().AddLogging().AddControllers().Services.BuildServiceProvider();
        http.RequestServices = provider;
        await result.ExecuteResultAsync(new ActionContext(http, new RouteData(), new ActionDescriptor()));
        Assert.True(http.Response.StatusCode == 200 && bytes.Length == expected,
            $"progress with Played={played} withheld or cut the poster: status={http.Response.StatusCode}, bytes={bytes.Length}/{expected}");
    }

    [Fact]
    public async Task AnUnprotectedImagesNotModifiedStaysNotModified()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var (result, http, _) = await Image(rig, Role("episode:show-e1"), new StatusCodeResult(304));
        using var provider = new ServiceCollection().AddLogging().AddControllers().Services.BuildServiceProvider();
        http.RequestServices = provider;
        await result.ExecuteResultAsync(new ActionContext(http, new RouteData(), new ActionDescriptor()));
        Assert.Equal(304, http.Response.StatusCode);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Shape 5: one complete per-item decision, consumed by every representation.

    [Fact]
    public async Task AGuardedShowsExtraImageIsProtectedLikeItsItem()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        Guard(rig, rig.Admin);
        var series = Role("series:show");
        var extra = new Video { Id = Guid.NewGuid(), OwnerId = series, ExtraType = ExtraType.Featurette, Path = "/media/Guarded show/featurettes/reveal.mp4", Name = "R25 featurette reveal" };
        rig.Items[extra.Id] = extra;
        var (result, _, _) = await Image(rig, extra.Id, Original());
        Assert.False(IsOriginal(result), "a guarded show's featurette image was sent as it is");
    }

    [Fact]
    public async Task AGuardedEpisodesLogoFollowsTheArtworkProtection()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        Guard(rig, rig.Admin);
        rig.F.Plugin.Configuration.SpoilerBlurArtwork = true;
        var provider = new SpoilerPresentationContext(new UserSpoilerBlur { ProviderTitles = new() { ["tv:tmdb:42"] = new() } }, rig.F.Plugin.Configuration);
        Assert.True(provider.ProtectArtwork("tv:tmdb:42", "episode", "Logo", 2));
        var (result, _, _) = await Image(rig, Role("episode:show-e1"), Original(), type: "Logo");
        Assert.False(IsOriginal(result), "the provider answer protects a guarded episode's logo, the native image did not");
    }

    [Fact]
    public async Task ASharedAddressImageIsProtectedForEveryPlausibleViewer()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        Guard(rig, rig.Admin);
        Guard(rig, rig.Viewer);
        var id = Role("episode:show-e1");
        // The first candidate has watched the episode; the second has not.
        rig.Played.Add((rig.Admin, id));
        var sessions = new Mock<ISessionManager>();
        var address = IPAddress.Parse("203.0.113.143");
        sessions.SetupGet(s => s.Sessions).Returns(new[]
        {
            new SessionInfo(sessions.Object, NullLogger.Instance) { UserId = rig.Admin, RemoteEndPoint = address.ToString() },
            new SessionInfo(sessions.Object, NullLogger.Instance) { UserId = rig.Viewer, RemoteEndPoint = address.ToString() },
        });
        var (result, _, _) = await Image(rig, id, Original(), sessions: sessions.Object, address: address);
        Assert.False(IsOriginal(result), "an anonymous request from a shared address got the original for one viewer who has not watched it");
    }

    [Theory]
    [InlineData("season")]
    [InlineData("title")]
    [InlineData("translations")]
    public void ALaterSeasonsNameLeavesProviderAnswers(string resource)
    {
        var presentation = new SpoilerPresentationContext(new UserSpoilerBlur { ProviderTitles = new() { ["tv:tmdb:42"] = new() } },
            new PluginConfiguration { SpoilerBlurEnabled = true, SpoilerReplaceTitle = true });
        var raw = resource switch
        {
            "title" => """{"seasons":[{"season_number":2,"name":"R25 season reveal"}]}""",
            "translations" => """{"translations":[{"data":{"name":"R25 season reveal"}}]}""",
            _ => """{"season_number":2,"name":"R25 season reveal"}""",
        };
        Assert.DoesNotContain("R25 season reveal", presentation.ProjectResource(raw, "tv:tmdb:42", resource, "tv", resource == "title" ? "tv" : "season", 2));
    }

    [Theory]
    [InlineData(1, true)]
    [InlineData(2, false)]
    public void AFirstSeasonsNameAndAnUnstrippedNameStay(int season, bool replace)
    {
        var presentation = new SpoilerPresentationContext(new UserSpoilerBlur { ProviderTitles = new() { ["tv:tmdb:42"] = new() } },
            new PluginConfiguration { SpoilerBlurEnabled = true, SpoilerReplaceTitle = replace });
        var raw = JsonSerializer.Serialize(new { season_number = season, name = "R25 allowed season" });
        Assert.Contains("R25 allowed season", presentation.ProjectResource(raw, "tv:tmdb:42", "season", "tv", "season", season));
    }

    private static PrivacyHostShapeModelTests.Rig AdvancedRig(Guid viewer, out Episode next)
    {
        var rig = new PrivacyHostShapeModelTests.Rig();
        Guard(rig, viewer);
        var config = rig.F.Plugin.Configuration;
        config.SpoilerAdvancedMode = true;
        config.SpoilerNextEpisodeStripTitle = false;
        var episode = (Episode)rig.Items[Role("episode:show-e1")];
        rig.Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => q.ItemIds is { Length: > 0 }
            ? q.ItemIds.Select(i => rig.Items.GetValueOrDefault(i)).OfType<BaseItem>().ToList() : new List<BaseItem> { episode });
        next = episode;
        return rig;
    }

    [Fact]
    public async Task SearchHintsRevealTheNextEpisodesTitleLikeItsItem()
    {
        var shot = Shot("Search.GetSearchHints.json");
        using var rig = AdvancedRig(shot.Viewer == "viewer" ? Role("user:viewer") : Role("user:admin"), out var next);
        var viewer = shot.Viewer == "viewer" ? rig.Viewer : rig.Admin;
        var state = rig.F.Core.Manager.GetUserConfiguration<UserSpoilerBlur>(viewer.ToString("N"), "spoilerblur.json");
        var dto = new BaseItemDto { Id = next.Id, Type = BaseItemKind.Episode, SeriesId = next.SeriesId, SeasonId = next.SeasonId, Name = "R25 next episode title", ParentIndexNumber = 1, IndexNumber = next.IndexNumber ?? 1, UserData = new() { Key = "k", Played = false } };
        Assert.Equal("R25 next episode title", rig.Strip.StripLibraryItem(dto, PrivacyIdentities.Of(rig.Library.Object, next), state, rig.F.Plugin.Configuration, viewer).Name);
        var hint = new SearchHint { Id = next.Id, Type = BaseItemKind.Episode, Name = "R25 next episode title", ParentIndexNumber = 1, IndexNumber = next.IndexNumber };
        var (_, body) = await PrivacyHostShapeModelTests.Deliver(rig, shot, answer: new SearchHintResult([hint], 1));
        Assert.Contains("R25 next episode title", body);
    }

    [Fact]
    public async Task TheActivityLogRevealsTheNextEpisodesTitleLikeItsItem()
    {
        var shot = Shot("ActivityLog.GetLogEntries.json");
        using var rig = AdvancedRig(shot.Viewer == "viewer" ? Role("user:viewer") : Role("user:admin"), out var next);
        var viewer = shot.Viewer == "viewer" ? rig.Viewer : rig.Admin;
        var answer = new QueryResult<ActivityLogEntry> { Items = [new("Member is playing R25 permitted next title", "VideoPlayback", viewer) { Id = 1, ItemId = next.Id.ToString("N") }] };
        var (_, body) = await PrivacyHostShapeModelTests.Deliver(rig, shot, answer: answer);
        Assert.Contains("R25 permitted next title", body);
    }

    [Fact]
    public void TagDataRevealsTheNextEpisodesTitleLikeItsItem()
    {
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: true, stripTags: true);
        var config = site.Fixture.Plugin.Configuration;
        config.SpoilerAdvancedMode = true;
        config.SpoilerNextEpisodeStripTitle = false;
        site.Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => q.ItemIds is { Length: > 0 }
            ? q.ItemIds.Select(i => site.Items.GetValueOrDefault(i)).OfType<BaseItem>().ToList() : new List<BaseItem> { site.Items[site.Episode] });
        Assert.Contains(site.Items[site.Episode].Name, site.TagData(site.Episode));
    }
}
