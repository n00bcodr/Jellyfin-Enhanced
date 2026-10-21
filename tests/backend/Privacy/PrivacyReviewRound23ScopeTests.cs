using System.Net;
using System.Security.Claims;
using System.Text;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Chapters;
using MediaBrowser.Controller.Entities;
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
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace JE.Tests;

/// <summary>
/// The same two shapes as review round 23, found by the track-wide audit at more sites: an image decision validated the
/// configuration object it captured (not the admin's saved one), returned its protected form before validating, and left
/// the advanced next-episode boundary out of what it read; an image cache token did not follow the verdict it was made
/// from; a native answer's deferred write sent after a guard was saved; the tag cache judged an entry by its stored series
/// after the library moved it; advanced reveal boundaries ignored library additions; and 10.11's owner-list fallback let an
/// extra keep its own vocabulary. Uses only the surface the pre-fix build has.
/// </summary>
[Collection("Plugin singleton")]
public class PrivacyReviewRound23ScopeTests
{
    private static Guid Role(string role) => PrivacyHostShapeModelTests.G(PrivacyHostShapeModelTests.Data.Roles[role]);
    private static PrivacyHostShapeModelTests.Shot Shot(string file) => PrivacyHostShapeModelTests.Data.Shots.Single(s => s.File == file);
    private static void Guard(PrivacyHostShapeModelTests.Rig rig, Guid viewer) => rig.Commit(PrivacyHostShapeModelTests.Rules.Single(x => x.Id == "sg-series"), viewer);

    private static BaseItemDto EpisodeDto(PrivacyHostShapeModelTests.Rig rig, Guid? id = null)
    {
        var e = (Episode)rig.Items[id ?? Role("episode:show-e1")];
        return new BaseItemDto { Id = e.Id, Type = BaseItemKind.Episode, SeriesId = e.SeriesId, SeasonId = e.SeasonId, Name = "Scope episode reveal r23",
            Overview = "Scope synopsis r23", ParentIndexNumber = 1, IndexNumber = e.IndexNumber ?? 1, UserData = new UserItemDataDto { Key = "scope", Played = false } };
    }

    /// <summary>The image filter around one image action (the host loads it while <paramref name="during"/> runs).</summary>
    private static async Task<IActionResult> Image(PrivacyHostShapeModelTests.Rig rig, Guid itemId, IActionResult source, Action? during = null, string imageType = "Primary")
    {
        var sessions = new Mock<ISessionManager>();
        var identity = new RequestIdentityService(sessions.Object, rig.Users.Object, new SpoilerIdentityService(rig.Users.Object, rig.F.Core.Logger), rig.F.Core.Logger);
        var resolver = new SpoilerUserResolver(rig.F.Core.Manager, rig.Library.Object, rig.F.Core.Logger, identity);
        using var next = new SpoilerNextUnwatchedService(rig.Library.Object, rig.Users.Object, rig.UserData.Object, rig.F.Core.Logger);
        using var filter = new SpoilerBlurImageFilter(rig.Library.Object, rig.Users.Object, rig.UserData.Object, Mock.Of<IChapterManager>(), resolver,
            new ImageBlurService(rig.F.Core.Logger), next, rig.F.Core.Logger);
        var http = new DefaultHttpContext();
        http.Request.Method = "GET";
        http.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", rig.Admin.ToString())], "Test"));
        var action = new ActionContext(http, new RouteData(), new ActionDescriptor { RouteValues = new Dictionary<string, string?> { ["controller"] = "Image", ["action"] = "GetItemImage" } }, new ModelStateDictionary());
        var executing = new ActionExecutingContext(action, [], new Dictionary<string, object?> { ["itemId"] = itemId, ["imageType"] = imageType, ["imageIndex"] = 0 }, new object());
        var executed = new ActionExecutedContext(action, [], new object()) { Result = source };
        await filter.OnActionExecutionAsync(executing, async () => { await Task.Yield(); during?.Invoke(); return executed; });
        return executed.Result!;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // The gate guards the bytes.

    [Fact]
    public async Task ArtworkProtectionSavedWhileABackdropLoadsApplies()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        Guard(rig, rig.Admin);
        rig.F.Plugin.Configuration.SpoilerBlurArtwork = false;
        var source = new FileContentResult(PosterBlurTests.Source(), "image/png");
        // The admin saves the settings (a new configuration object) while the backdrop loads.
        var result = await Image(rig, Role("episode:show-e1"), source,
            () => rig.F.Plugin.UpdateConfiguration(new PluginConfiguration { SpoilerBlurEnabled = true, SpoilerBlurArtwork = true, SpoilerBlurMode = "blur" }), "Backdrop");
        Assert.True(rig.F.Plugin.Configuration.SpoilerBlurArtwork);
        Assert.NotSame(source, result);
    }

    [Fact]
    public async Task AnUnguardSavedWhileAProtectedImageLoadsDeliversTheOriginal()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        Guard(rig, rig.Admin);
        var source = new FileContentResult(PosterBlurTests.Source(), "image/png");
        var result = await Image(rig, Role("episode:show-e1"), source, () =>
        {
            rig.F.Core.Manager.SaveUserConfiguration(rig.Admin.ToString("N"), "spoilerblur.json", new UserSpoilerBlur());
            SpoilerUserResolver.InvalidateUser(rig.Admin.ToString("N"));
        });
        Assert.Same(source, result);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AnEpisodeImageFollowsItsOwnWatchedState(bool watched)
    {
        // Control (holds on the base too).
        using var rig = new PrivacyHostShapeModelTests.Rig();
        Guard(rig, rig.Admin);
        var id = Role("episode:show-e1");
        if (watched) rig.Played.Add((rig.Admin, id));
        var source = new FileContentResult(PosterBlurTests.Source(), "image/png");
        Assert.Equal(watched, ReferenceEquals(source, await Image(rig, id, source)));
    }

    private sealed class SlowClient(Action during) : MemoryStream
    {
        public bool Written;

        private async Task Before()
        {
            if (Written) return;
            Written = true;
            await Task.Yield();
            during();
        }

        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default) { await Before(); await base.WriteAsync(buffer, cancellationToken); }

        public override async Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) { await Before(); await base.WriteAsync(buffer, offset, count, cancellationToken); }
    }

    [Fact]
    public async Task TheHostsExecutorHandsTheTransportOnlyACommittedAnswer()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var shot = Shot("TvShows.GetEpisodes.json");
        var viewer = shot.Viewer == "viewer" ? rig.Viewer : rig.Admin;
        var context = PrivacyHostShapeModelTests.Context(shot, viewer);
        var delivery = new ResultExecutingContext(context, [], new ObjectResult(PrivacyHostShapeModelTests.Value(shot)), new object());
        rig.Gate().OnResultExecuting(delivery);
        // The host's executor writes the body afterwards; the transport's first write waits on the client.
        bool? committed = null;
        using var body = new SlowClient(() => { committed = PrivacyResponseGuard.Find(context.HttpContext)?.Committed; Guard(rig, viewer); });
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddControllers();
        using var provider = services.BuildServiceProvider();
        context.HttpContext.RequestServices = provider;
        context.HttpContext.Response.Body = body;
        await delivery.Result.ExecuteResultAsync(context);
        Assert.True(body.Written, "the host's executor never wrote the body");
        // Nothing reached the client before the complete answer was validated; a guard saved while the client reads it
        // applies to the next answer (the one written while it is saved is AGuardSavedWhileTheHostWritesALongNativeAnswerLeavesNoProtectedText).
        Assert.True(committed, "a byte reached the client before the answer was validated");
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Read-set: every dependency of a verdict, and caches derived from the verdict.

    [Fact]
    public async Task AnEarlierEpisodeMarkedUnwatchedWhileTheNextOnesImageLoadsRevokesItsReveal()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        Guard(rig, rig.Admin);
        var current = (Episode)rig.Items[Role("episode:show-e1")];
        current.IndexNumber = 2;
        var earlier = new Episode { Id = Guid.NewGuid(), SeriesId = current.SeriesId, SeasonId = current.SeasonId, ParentIndexNumber = 1, IndexNumber = 1 };
        rig.Items[earlier.Id] = earlier;
        rig.Played.Add((rig.Admin, earlier.Id));
        var config = rig.F.Plugin.Configuration;
        config.SpoilerAdvancedMode = true;
        config.SpoilerNextEpisodeStripImage = false;
        // The first unwatched episode is the boundary: the current one while the earlier one is watched.
        rig.Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => q.ItemIds is { Length: > 0 }
            ? q.ItemIds.Select(i => rig.Items.GetValueOrDefault(i)).OfType<BaseItem>().ToList()
            : new List<BaseItem> { rig.Played.Contains((rig.Admin, earlier.Id)) ? current : earlier });
        var source = new FileContentResult(PosterBlurTests.Source(), "image/png");
        var result = await Image(rig, current.Id, source, () =>
        {
            rig.Played.Remove((rig.Admin, earlier.Id));
            rig.UserData.Raise(u => u.UserDataSaved += null, rig.UserData.Object, new UserDataSaveEventArgs { Item = earlier, UserId = rig.Admin, UserData = new UserItemData { Key = "k", Played = false } });
        });
        Assert.NotSame(source, result);
    }

    [Fact]
    public async Task AWatchedEpisodesImageTokenChangesWhenTheFinalGateGuardsIt()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var shot = Shot("UserLibrary.GetItem.episode.json");
        var viewer = shot.Viewer == "viewer" ? rig.Viewer : rig.Admin;
        Guard(rig, viewer);
        var dto = EpisodeDto(rig);
        dto.UserData!.Played = true;
        dto.ImageTags = new() { [ImageType.Primary] = "abcdef1234567890abcdef1234567890ab" };
        rig.Played.Add((viewer, dto.Id));
        var context = PrivacyHostShapeModelTests.Context(shot, viewer);
        var gate = rig.Gate();
        gate.OnResourceExecuting(new ResourceExecutingContext(context, [], []));
        var answer = new ObjectResult(dto);
        var executed = new ActionExecutedContext(context, [], new object()) { Result = answer };
        await rig.Strip.OnActionExecutionAsync(new ActionExecutingContext(context, [], new Dictionary<string, object?>(), new object()), () => Task.FromResult(executed));
        var watched = Assert.IsAssignableFrom<BaseItemDto>(answer.Value);
        var old = watched.ImageTags[ImageType.Primary];
        // The viewer marks it unwatched before the answer is delivered.
        rig.Played.Remove((viewer, dto.Id));
        rig.UserData.Raise(u => u.UserDataSaved += null, rig.UserData.Object, new UserDataSaveEventArgs { Item = rig.Items[dto.Id], UserId = viewer, UserData = new UserItemData { Key = "k", Played = false } });
        var delivery = new ResultExecutingContext(context, [], answer, new object());
        gate.OnResultExecuting(delivery);
        var now = Assert.IsAssignableFrom<BaseItemDto>(Assert.IsAssignableFrom<ObjectResult>(delivery.Result).Value);
        Assert.DoesNotContain("Scope episode", now.Name);
        Assert.False(now.UserData!.Played);
        Assert.NotEqual(old, now.ImageTags[ImageType.Primary]);
    }

    [Fact]
    public void AnImageTokenChangesWhenTheAdvancedImageRevealIsRevoked()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        Guard(rig, rig.Admin);
        var config = rig.F.Plugin.Configuration;
        config.SpoilerAdvancedMode = true;
        config.SpoilerNextEpisodeStripImage = false;
        var e = (Episode)rig.Items[Role("episode:show-e1")];
        rig.Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => q.ItemIds is { Length: > 0 }
            ? q.ItemIds.Select(i => rig.Items.GetValueOrDefault(i)).OfType<BaseItem>().ToList() : new List<BaseItem> { e });
        var state = rig.F.Core.Manager.GetUserConfiguration<UserSpoilerBlur>(rig.Admin.ToString("N"), "spoilerblur.json");
        var identity = PrivacyIdentities.Of(rig.Library.Object, e);
        BaseItemDto Fresh()
        {
            var dto = EpisodeDto(rig);
            dto.ImageTags = new() { [ImageType.Primary] = "abcdef1234567890abcdef1234567890ab" };
            return dto;
        }
        var before = rig.Strip.StripLibraryItem(Fresh(), identity, state, config, rig.Admin).ImageTags[ImageType.Primary];
        config.SpoilerNextEpisodeStripImage = true;
        var after = rig.Strip.StripLibraryItem(Fresh(), identity, state, config, rig.Admin).ImageTags[ImageType.Primary];
        Assert.NotEqual(before, after);
        Assert.EndsWith("abcdef1234567890abcdef1234567890ab", after);
    }

    [Fact]
    public async Task TheTagCacheJudgesAnEpisodeByItsCurrentSeriesAfterAMove()
    {
        var old = Guid.NewGuid();
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: true, stripTags: true, edit: entries =>
        {
            foreach (var e in entries.Values.Where(e => e.Type == "Episode")) { e.SeriesId = old.ToString("N"); e.SeriesTmdbId = "99999"; }
        });
        site.Items[old] = new Series { Id = old, Name = "old unguarded series" };
        ((Episode)site.Items[site.Episode]).SeriesId = old;
        Assert.Contains(site.Sentinels.In(await site.TagCache()), p => p.StartsWith("episode", StringComparison.Ordinal));
        // The library moves the episode into the guarded series (its cached entry still names the old one).
        ((Episode)site.Items[site.Episode]).SeriesId = site.Series;
        site.Updated(site.Episode);
        Assert.DoesNotContain(site.Sentinels.In(await site.TagCache()), p => p.StartsWith("episode", StringComparison.Ordinal));
    }

    [Fact]
    public async Task TheTagCacheHidesAnEpisodeByItsCurrentSeriesAfterAMove()
    {
        var old = Guid.NewGuid();
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: false, stripTags: true, edit: entries =>
        {
            foreach (var e in entries.Values.Where(e => e.Type == "Episode")) { e.SeriesId = old.ToString("N"); e.SeriesTmdbId = "99999"; }
        });
        site.Items[old] = new Series { Id = old, Name = "old series" };
        ((Episode)site.Items[site.Episode]).SeriesId = old;
        var user = site.Alice.Id.ToString("N");
        site.Fixture.Core.Manager.SaveUserConfiguration(user, "hidden-content.json", new UserHiddenContent
        {
            Settings = new() { FilterLibrary = true },
            Items = new() { [site.Series.ToString("N")] = new HiddenContentItem { ItemId = site.Series.ToString("N"), Type = "Series", HideScope = "global" } },
        });
        HiddenContentResponseFilter.InvalidateUser(user);
        Assert.Contains(site.Sentinels.In(await site.TagCache()), p => p.StartsWith("episode", StringComparison.Ordinal));
        ((Episode)site.Items[site.Episode]).SeriesId = site.Series;
        site.Updated(site.Episode);
        Assert.DoesNotContain(site.Sentinels.In(await site.TagCache()), p => p.StartsWith("episode", StringComparison.Ordinal));
    }

    [Fact]
    public async Task AnEarlierUnwatchedEpisodeAddedToTheLibraryRevokesTheNextEpisodeReveal()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var shot = Shot("TvShows.GetEpisodes.json");
        var viewer = shot.Viewer == "viewer" ? rig.Viewer : rig.Admin;
        Guard(rig, viewer);
        var config = rig.F.Plugin.Configuration;
        config.SpoilerAdvancedMode = true;
        config.SpoilerNextEpisodeStripTitle = false;
        config.SpoilerCurrentSeasonStripTitle = true;
        var next = (Episode)rig.Items[Role("episode:show-e1")];
        next.IndexNumber = 2;
        rig.Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => q.ItemIds is { Length: > 0 }
            ? q.ItemIds.Select(i => rig.Items.GetValueOrDefault(i)).OfType<BaseItem>().ToList() : new List<BaseItem> { next });
        var (_, first) = await PrivacyHostShapeModelTests.Deliver(rig, shot, answer: new QueryResult<BaseItemDto> { Items = [EpisodeDto(rig)] });
        Assert.Contains("Scope episode reveal r23", first);
        // A library scan imports an earlier, unwatched episode: it is the next episode now.
        next = new Episode { Id = Guid.NewGuid(), SeriesId = next.SeriesId, SeasonId = next.SeasonId, ParentIndexNumber = 1, IndexNumber = 1, Name = "earlier episode" };
        rig.Items[next.Id] = next;
        rig.Library.Raise(l => l.ItemAdded += null, rig.Library.Object, new ItemChangeEventArgs { Item = next });
        var (_, after) = await PrivacyHostShapeModelTests.Deliver(rig, shot, answer: new QueryResult<BaseItemDto> { Items = [EpisodeDto(rig)] });
        Assert.DoesNotContain("Scope episode reveal r23", after);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // The 10.11 owner-list fallback, for an extra's vocabulary.

#if NET9_0
    [Fact]
    public void OnTenElevenAnExtraListedOnlyByItsOwnerUsesTheOwnersVocabulary()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        Guard(rig, rig.Admin);
        var series = rig.Items[Role("series:show")];
        series.Path = "/media/Guarded show";
        series.Genres = ["Drama"];
        var extra = new Video { Id = Guid.NewGuid(), OwnerId = Guid.Empty, ExtraType = null, Path = "/media/Guarded show/featurettes/reveal.mp4",
            Name = "Scope featurette reveal", Genres = ["Scope spoiler genre"] };
        rig.Items[extra.Id] = extra;
        series.ExtraIds = [extra.Id];
        rig.Library.Setup(l => l.FindByPath("/media/Guarded show", It.IsAny<bool?>())).Returns(series);
        var identity = PrivacyIdentities.Of(rig.Library.Object, extra);
        Assert.Equal(series.Id, identity.OwnerId);
        var state = rig.F.Core.Manager.GetUserConfiguration<UserSpoilerBlur>(rig.Admin.ToString("N"), "spoilerblur.json");
        var dto = new BaseItemDto { Id = extra.Id, Type = BaseItemKind.Video, Name = extra.Name, Genres = extra.Genres };
        var got = rig.Strip.StripLibraryItem(dto, identity, state, rig.F.Plugin.Configuration, rig.Admin);
        Assert.DoesNotContain("Scope featurette", got.Name);
        Assert.DoesNotContain("Scope spoiler genre", got.Genres ?? []);
    }
#endif
}
