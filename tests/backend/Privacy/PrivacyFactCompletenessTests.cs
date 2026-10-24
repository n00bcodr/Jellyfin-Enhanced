#pragma warning disable ASPDEPR004, ASPDEPR008 // TestServer over a WebHostBuilder: the in-process host the delivery tests drive
using System.Reflection;
using System.Text;
using System.Text.Json;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Moq;

namespace JE.Tests;

/// <summary>
/// Every input a protected answer consumes is a fact compared with its live source at every check: a remembered answer
/// (the next-episode boundary, a season's watched evidence, a collection's membership of a title, a title's provider key,
/// a request's resolved identities) replays the complete proof its computation recorded; absence is a fact; a policy
/// document, a watched state and 10.11's owner listings are read again from their sources (no save epoch or event stands in
/// for them); the commit's check is complete on a host without start callbacks and for a 304. Equality is precise: an
/// unrelated collection member or a new link order keeps a permitted poster. Tag work is bounded by distinct inputs, and a
/// guarded later season's watched evidence is the same on both sides of the sixteen-season prefilter. Uses only the surface
/// the pre-fix build has, so the same file runs against it.
/// </summary>
[Collection("Plugin singleton")]
public class PrivacyFactCompletenessTests(Xunit.Abstractions.ITestOutputHelper output)
{
    private static Guid Role(string role) => Guid.Parse(PrivacyHostShapeModelTests.Data.Roles[role]);

    private static bool IsOriginal(IActionResult result) => result is FileContentResult file && file.FileContents.SequenceEqual(PosterBlurTests.Source());

    // ---------------------------------------------------------------------------------------------------------------
    // Remembered answers replay their proof.

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ARememberedNextEpisodeIsComparedWithTheLiveQueryOnReuse(bool changed)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var series = Guid.NewGuid();
        var first = new SpoilerNextUnwatchedService.NextUnwatchedBoundary(Guid.NewGuid(), 1, 2);
        var answer = (SpoilerNextUnwatchedService.NextUnwatchedBoundary?)first;
        using var next = new SpoilerNextUnwatchedService(rig.Library.Object, rig.Users.Object, rig.UserData.Object, rig.F.Core.Logger)
        {
            BoundaryComputerForTest = (_, _) => answer,
        };
        using (PrivacyReadSet.Begin()) Assert.Equal(first, next.GetBoundary(rig.Viewer, series));
        using var scope = PrivacyReadSet.Begin();
        // The remembered boundary is reused; the viewer's next episode moves without any event the plugin sees.
        Assert.Equal(first, next.GetBoundary(rig.Viewer, series));
        if (changed) answer = new SpoilerNextUnwatchedService.NextUnwatchedBoundary(Guid.NewGuid(), 1, 3);
        Assert.Equal(!changed, scope.Reads.Valid());
    }

    [Fact]
    public async Task ARememberedSeasonWatchedAnswerIsComparedWithTheLiveSeasonOnReuse()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        rig.Commit(PrivacyHostShapeModelTests.Rules.Single(r => r.Id == "sg-series"), rig.Admin);
        var series = (Series)rig.Items[Role("series:show")];
        series.PresentationUniqueKey = "fact-series";
        var season = (Season)rig.Items[Role("season:show-s1")];
        season.IndexNumber = 2; season.PresentationUniqueKey = "fact-season-2";
        var episode = new Episode { Id = Guid.NewGuid(), SeriesId = series.Id, SeasonId = season.Id, ParentIndexNumber = 2, IndexNumber = 1 };
        rig.Items[episode.Id] = episode;
        rig.Played.Add((rig.Admin, episode.Id));
        rig.Library.Setup(l => l.GetItemById<Series>(series.Id)).Returns(series);
        rig.Library.Setup(l => l.Sort(It.IsAny<IEnumerable<BaseItem>>(), It.IsAny<Jellyfin.Database.Implementations.Entities.User>(), It.IsAny<IEnumerable<ItemSortBy>>(), It.IsAny<Jellyfin.Database.Implementations.Enums.SortOrder>()))
            .Returns((IEnumerable<BaseItem> rows, Jellyfin.Database.Implementations.Entities.User _, IEnumerable<ItemSortBy> _, Jellyfin.Database.Implementations.Enums.SortOrder _) => rows);
        rig.Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => q.ItemIds is { Length: > 0 }
            ? q.ItemIds.Select(i => rig.Items.GetValueOrDefault(i)).OfType<BaseItem>().ToList() : new List<BaseItem> { episode });
        var manager = new Mock<IServerConfigurationManager>();
        manager.SetupGet(m => m.Configuration).Returns(new MediaBrowser.Model.Configuration.ServerConfiguration());
        var previous = BaseItem.ConfigurationManager;
        BaseItem.ConfigurationManager = manager.Object;
        try
        {
            // The first image remembers that the viewer watched part of the season: its poster passes.
            var warm = await PrivacyReviewRound25Tests.Image(rig, season.Id);
            Assert.True(IsOriginal(warm.Result));
            // The second reuses that answer; the viewer's watched state is undone before its commit, with no event.
            var answer = await PrivacyReviewRound25Tests.Image(rig, season.Id);
            rig.Played.Remove((rig.Admin, episode.Id));
            await PrivacyReviewRound25Tests.Write(answer);
            Assert.False(answer.Bytes.ToArray().SequenceEqual(PosterBlurTests.Source()), "a season no longer watched was committed with its original poster from a remembered answer");
        }
        finally { BaseItem.ConfigurationManager = previous; }
    }

    /// <summary>A guarded collection and a movie it may link (the rig's guarded movie), with the admin guarding the collection.</summary>
    private static (BoxSet Set, BaseItem Movie) GuardedCollection(PrivacyHostShapeModelTests.Rig rig, params Guid[] members)
    {
        var movie = rig.Items[Role("movie:guarded")];
        var set = new BoxSet { Id = Guid.NewGuid(), Name = "fact set", LinkedChildren = members.Select(m => new LinkedChild { ItemId = m }).ToArray() };
        rig.Items[set.Id] = set;
        var state = new UserSpoilerBlur(); state.Collections[set.Id.ToString("N")] = new();
        rig.F.Core.Manager.SaveUserConfiguration(rig.Admin.ToString("N"), "spoilerblur.json", state);
        SpoilerUserResolver.InvalidateUser(rig.Admin.ToString("N"));
        rig.F.Plugin.Configuration.SpoilerKeepMoviePosters = false;
        return (set, movie);
    }

    [Fact]
    public async Task AWarmCollectionMembershipIsComparedWithTheLiveLinks()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var (set, movie) = GuardedCollection(rig);
        PrivacyIdentities.ForgetCollections();
        // The first image remembers that the guarded collection does not link the movie.
        Assert.True(IsOriginal((await PrivacyReviewRound25Tests.Image(rig, movie.Id)).Result));
        var answer = await PrivacyReviewRound25Tests.Image(rig, movie.Id);
        Assert.True(IsOriginal(answer.Result));
        // The host links it before the commit, without an event yet.
        set.LinkedChildren = [new LinkedChild { ItemId = movie.Id }];
        await PrivacyReviewRound25Tests.Write(answer);
        Assert.False(answer.Bytes.ToArray().SequenceEqual(PosterBlurTests.Source()), "a remembered 'not a member' answer released the poster of a movie the guarded collection now links");
    }

    [Theory]
    [InlineData("member")]
    [InlineData("order")]
    public async Task AnUnrelatedMemberOrANewLinkOrderKeepsAPermittedPoster(string change)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var others = Enumerable.Range(0, 3).Select(_ => new Movie { Id = Guid.NewGuid(), Name = "fact other" }).ToArray();
        foreach (var other in others) rig.Items[other.Id] = other;
        var (set, movie) = GuardedCollection(rig, others.Select(o => o.Id).ToArray());
        PrivacyIdentities.ForgetCollections();
        var answer = await PrivacyReviewRound25Tests.Image(rig, movie.Id);
        Assert.True(IsOriginal(answer.Result));
        // The host saves and announces a change of the collection that leaves the movie outside it.
        set.LinkedChildren = change == "member"
            ? set.LinkedChildren.Append(new LinkedChild { ItemId = Guid.NewGuid() }).ToArray()
            : set.LinkedChildren.Reverse().ToArray();
        rig.Library.Raise(l => l.ItemUpdated += null, rig.Library.Object, new ItemChangeEventArgs { Item = set, UpdateReason = ItemUpdateType.MetadataEdit });
        await PrivacyReviewRound25Tests.Write(answer);
        Assert.True(answer.Bytes.ToArray().SequenceEqual(PosterBlurTests.Source()), "an unchanged membership predicate cost a permitted poster its bytes");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ARememberedProviderKeyIsComparedWithTheLiveTitleOnReuse(bool changed)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var movie = new Movie { Id = Guid.NewGuid(), Name = "fact keyed movie" };
        movie.SetProviderId(MetadataProvider.Tmdb, "7");
        rig.Items[movie.Id] = movie;
        var state = new UserSpoilerBlur();
        state.ProviderTitles["movie:tmdb:42"] = new SpoilerBlurPendingEntry();
        var resolver = new SpoilerUserResolver(rig.F.Core.Manager, rig.Library.Object, rig.F.Core.Logger, null!);
        using (PrivacyReadSet.Begin()) Assert.False(resolver.IsMovieInSpoilerScope(state, movie.Id));
        using var scope = PrivacyReadSet.Begin();
        Assert.False(resolver.IsMovieInSpoilerScope(state, movie.Id));
        // The title's key is corrected to the guarded one before the commit (the plugin hears of it later).
        if (changed) movie.SetProviderId(MetadataProvider.Tmdb, "42");
        Assert.Equal(!changed, scope.Reads.Valid());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void AReusedIdentityReplaysEveryOwnerHop(bool moved)
    {
        // An extra of an episode belongs to the episode's series: the episode is an intermediate hop of its proof.
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var episode = (Episode)rig.Items[Role("episode:show-e1")];
        var extra = new Video { Id = Guid.NewGuid(), OwnerId = episode.Id, ExtraType = ExtraType.Featurette, Name = "fact featurette" };
        rig.Items[extra.Id] = extra;
        var other = new Series { Id = Guid.NewGuid(), Name = "fact other show" };
        rig.Items[other.Id] = other;
        var http = new DefaultHttpContext();
        using (PrivacyReadSet.Begin()) Assert.Equal(episode.SeriesId, PrivacyIdentities.Resolve(rig.Library.Object, [extra.Id], http)[extra.Id].OwnerId);
        using var scope = PrivacyReadSet.Begin();
        PrivacyIdentities.Resolve(rig.Library.Object, [extra.Id], http);
        // The episode moves to another show before the commit, without an event yet.
        if (moved) episode.SeriesId = other.Id;
        Assert.Equal(!moved, scope.Reads.Valid());
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Absence is a fact.

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void AnOwnerTheLibraryLackedThatAppearsBeforeTheCommitIsAChange(bool appears)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var series = new Series { Id = Guid.NewGuid(), Name = "fact keyed show" };
        series.SetProviderId(MetadataProvider.Tmdb, "5");
        var episode = new Episode { Id = Guid.NewGuid(), SeriesId = series.Id, ParentIndexNumber = 1, IndexNumber = 1 };
        rig.Items[episode.Id] = episode;
        using var scope = PrivacyReadSet.Begin();
        // The series row cannot be read: the episode is judged by its series id alone (no provider key).
        var identity = PrivacyIdentities.Of(rig.Library.Object, episode);
        Assert.Equal(series.Id, identity.OwnerId);
        Assert.Null(identity.TitleKey);
        if (appears) rig.Items[series.Id] = series;
        Assert.Equal(!appears, scope.Reads.Valid());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void AnItemTheLibraryLackedThatJoinsBeforeTheCommitIsAChange(bool joins)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var movie = new Movie { Id = Guid.NewGuid(), Name = "fact late movie" };
        using var scope = PrivacyReadSet.Begin();
        Assert.Null(PrivacyReads.Item(rig.Library.Object, movie.Id));
        if (joins) rig.Items[movie.Id] = movie;
        Assert.Equal(!joins, scope.Reads.Valid());
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Sources read again: the policy document, the watched state, 10.11's listings.

    [Fact]
    public void APolicyDocumentReplacedOnDiskIsSeenAtTheCommit()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var user = rig.Admin.ToString("N");
        var state = new UserSpoilerBlur();
        rig.F.Core.Manager.SaveUserConfiguration(user, "spoilerblur.json", state);
        using var scope = PrivacyReadSet.Begin();
        rig.F.Core.Manager.RecordPolicyRead(user, "spoilerblur.json", state);
        Assert.True(scope.Reads.Valid(), scope.Reads.Failure);
        // Another process replaces the document (a restore, an edit): no save of this plugin's.
        var replaced = new UserSpoilerBlur(); replaced.Series[Guid.NewGuid().ToString("N")] = new();
        File.WriteAllText(Path.Combine(rig.F.Core.ConfigRoot, user, "spoilerblur.json"), Newtonsoft.Json.JsonConvert.SerializeObject(replaced));
        Assert.False(scope.Reads.StillValid(), "a policy document replaced on disk was accepted at the commit");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void AWatchedStateADecisionReadIsComparedWithTheStore(bool changed)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var episode = (Episode)rig.Items[Role("episode:show-e1")];
        var user = rig.Users.Object.GetUserById(rig.Viewer)!;
        rig.Played.Add((rig.Viewer, episode.Id));
        using var scope = PrivacyReadSet.Begin();
        PrivacyReads.Item(rig.Library.Object, episode.Id);
        Assert.True(PrivacyReads.UserData(rig.UserData.Object, user, episode)?.Played);
        // The host's store says otherwise before the commit (its event not delivered yet).
        if (changed) rig.Played.Remove((rig.Viewer, episode.Id));
        Assert.Equal(!changed, scope.Reads.Valid());
    }

#if NET9_0
    [Fact]
    public void OnTenElevenAnExtraNoListingHeldThatAListingTakesInIsAChange()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var series = rig.Items[Role("series:show")];
        series.Path = "/media/Guarded show";
        var extra = new Video { Id = Guid.NewGuid(), OwnerId = Guid.Empty, Path = "/media/Guarded show/featurettes/reveal.mp4", Name = "fact featurette" };
        rig.Items[extra.Id] = extra;
        series.ExtraIds = [];
        rig.Library.Setup(l => l.FindByPath("/media/Guarded show", It.IsAny<bool?>())).Returns(series);
        using var scope = PrivacyReadSet.Begin();
        Assert.Equal(extra.Id, PrivacyIdentities.Of(rig.Library.Object, extra).OwnerId);
        Assert.True(scope.Reads.Valid(), scope.Reads.Failure);
        // The owner lists it now (10.11 attached it in memory): it is the guarded show's extra.
        series.ExtraIds = [extra.Id];
        Assert.False(scope.Reads.Valid(), "an extra judged as nobody's was accepted after its owner's listing took it in");
    }
#endif

    // ---------------------------------------------------------------------------------------------------------------
    // The commit's check is complete on every host and stage.

    /// <summary>A transport whose start runs <paramref name="starting"/> (the host's own start, with no start callbacks).</summary>
    private sealed class StartingTransport(Stream body, Action starting) : IHttpResponseBodyFeature
    {
        public Stream Stream => body;
        public System.IO.Pipelines.PipeWriter Writer => System.IO.Pipelines.PipeWriter.Create(body);
        public void DisableBuffering() { }
        public Task StartAsync(CancellationToken cancellationToken = default) { starting(); return Task.CompletedTask; }
        public Task SendFileAsync(string path, long offset, long? count, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task CompleteAsync() => Task.CompletedTask;
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AHostWithoutStartCallbacksGetsTheCompleteCheckAtTheCommit(bool moved)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var episode = (Episode)rig.Items[Role("episode:show-e1")];
        var http = new DefaultHttpContext();
        var sent = new MemoryStream();
        // The host's transport (the response's body is its stream).
        http.Features.Set<IHttpResponseBodyFeature>(new StartingTransport(sent, () => { if (moved) episode.SeriesId = Guid.NewGuid(); }));
        using (var scope = PrivacyReadSet.Begin())
        {
            PrivacyReads.Item(rig.Library.Object, episode.Id);
            Assert.True(scope.Reads.Valid());
            PrivacyResponseGuard.Install(http, scope.Reads);
        }
        await http.Response.Body.WriteAsync(Encoding.UTF8.GetBytes("fact protected answer"));
        await PrivacyResponseGuard.CommitAsync(http);
        Assert.Equal(moved ? "" : "fact protected answer", Encoding.UTF8.GetString(sent.ToArray()));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ANotModifiedAnswerIsConfirmedOnlyByTheCompleteCheck(bool moved)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var episode = (Episode)rig.Items[Role("episode:show-e1")];
        using var server = new TestServer(new WebHostBuilder().ConfigureServices(s => s.AddLogging().AddControllers()).Configure(app => app.Run(async http =>
        {
            using (var scope = PrivacyReadSet.Begin())
            {
                PrivacyReads.Item(rig.Library.Object, episode.Id);
                Assert.True(scope.Reads.Valid());
                PrivacyResponseGuard.Install(http, scope.Reads);
            }
            // A start callback of the answer's own changes an input after the commit's first check.
            http.Response.OnStarting(() => { if (moved) episode.SeriesId = Guid.NewGuid(); return Task.CompletedTask; });
            var action = new ActionContext(http, new RouteData(), new ActionDescriptor());
            await PrivacyResponseGuard.Confirm(http, new StatusCodeResult(304)).ExecuteResultAsync(action);
            await PrivacyResponseGuard.CommitAsync(http);
        })));
        using var client = server.CreateClient();
        using var response = await client.GetAsync("/");
        Assert.Equal(moved ? 503 : 304, (int)response.StatusCode);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Bounded tag work and the later-season prefilter.

    /// <summary>A delta of <paramref name="episodes"/> unchanged episode entries spread over <paramref name="shows"/> guarded shows.</summary>
    private static async Task<(int Status, int Direct, int Lists, int Played, string Body)> Delta(int episodes, int shows, bool keyed = false)
    {
        var ids = Enumerable.Range(0, episodes).Select(_ => Guid.NewGuid()).ToArray();
        var series = Enumerable.Range(0, shows).Select(_ => Guid.NewGuid()).ToArray();
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: true, stripTags: true, edit: entries =>
        {
            for (var i = 0; i < episodes; i++) entries[ids[i].ToString("N")] = new TagCacheEntry {
                Type = "Episode", SeriesId = series[i % shows].ToString("N"), LastUpdated = 100, SeasonNumber = 1, EpisodeNumber = i + 1 };
        });
        for (var s = 0; s < shows; s++)
        {
            var show = new Series { Id = series[s], Name = "fact show" };
            show.SetProviderId(MetadataProvider.Tmdb, (9000 + s).ToString(System.Globalization.CultureInfo.InvariantCulture));
            site.Items[show.Id] = show;
            // Guarded by id, or by the show's provider key (a rider then needs each stored show's key).
            if (keyed) site.State.ProviderTitles["tv:tmdb:" + (9000 + s).ToString(System.Globalization.CultureInfo.InvariantCulture)] = new SpoilerBlurPendingEntry();
            else site.Guard(show.Id);
        }
        if (keyed) site.Guard(site.Series);
        for (var i = 0; i < episodes; i++) site.Items[ids[i]] = new Episode { Id = ids[i], SeriesId = series[i % shows], ParentIndexNumber = 1, IndexNumber = i + 1 };
        site.Library.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
            q.IsPlayed == true ? (q.ItemIds ?? []).Where(site.Played.Contains).ToArray() : site.Items.Keys.ToArray());
        site.Library.Invocations.Clear();
        var result = await site.TagCacheResponse(since: 150);
        return (result.Status, site.Library.Invocations.Count(i => i.Method.Name == "GetItemById"),
            site.Library.Invocations.Count(i => i.Method.Name == "GetItemList"),
            site.Library.Invocations.Count(i => i.Method.Name == "GetItemIds" && i.Arguments[0] is InternalItemsQuery { IsPlayed: true }), result.Body);
    }

    [Theory]
    [InlineData(2001, 1, false)]
    [InlineData(1000, 100, false)]
    [InlineData(1000, 100, true)]
    public async Task AnUnchangedDeltaReadsEachDistinctShowOnceAndEveryEntryInBatches(int episodes, int shows, bool keyed)
    {
        var (status, direct, lists, played, body) = await Delta(episodes, shows, keyed);
        output.WriteLine($"delta of {episodes} unchanged episodes over {shows} shows (guarded by {(keyed ? "key" : "id")}): GetItemById {direct}, GetItemList {lists}, played queries {played}");
        Assert.Equal(200, status);
        // Every unchanged episode of a guarded show rides with the delta, stripped.
        using var doc = JsonDocument.Parse(body);
        Assert.True(doc.RootElement.GetProperty("items").EnumerateObject().Count() >= episodes);
        Assert.True(direct < 20, $"{episodes} episodes over {shows} shows made {direct} direct item lookups");
        // Rider selection: one read per distinct show; the strip and every check: one batched read per 2000 entries.
        var bound = shows + 8 * ((episodes + 1999) / 2000 + 1);
        Assert.True(lists <= bound, $"{episodes} episodes over {shows} shows made {lists} item-list reads (bound {bound})");
    }

    /// <summary>A tag site whose guarded show has <paramref name="count"/> later seasons, each with one episode the host lists in it.</summary>
    private static (PrivacyReviewRound19Tests.TagSite Site, Season[] Seasons, Episode[] Episodes, IServerConfigurationManager? Previous) LaterSeasons(int count)
    {
        var seasons = new Season[count];
        var episodes = new Episode[count];
        var site = new PrivacyReviewRound19Tests.TagSite(rules: true, stripTags: true, edit: entries =>
        {
            foreach (var key in entries.Where(p => p.Value.Type is "Episode" or "Season").Select(p => p.Key).ToList()) entries.Remove(key);
        });
        var series = (Series)site.Items[site.Series];
        series.PresentationUniqueKey = "fact-later";
        for (var i = 0; i < count; i++)
        {
            seasons[i] = new Season { Id = Guid.NewGuid(), SeriesId = series.Id, IndexNumber = i + 2, Name = "Season " + (i + 2), PresentationUniqueKey = "fact-later-" + (i + 2), SeriesPresentationUniqueKey = "fact-later" };
            episodes[i] = new Episode { Id = Guid.NewGuid(), SeriesId = series.Id, SeasonId = seasons[i].Id, ParentIndexNumber = i + 2, IndexNumber = 1, SeriesPresentationUniqueKey = "fact-later" };
            site.Items[seasons[i].Id] = seasons[i];
            site.Items[episodes[i].Id] = episodes[i];
            // The host's typed lookup by id answers for each season too.
            var season = seasons[i];
            site.Library.Setup(l => l.GetItemById<BaseItem>(season.Id)).Returns(season);
            site.Library.Setup(l => l.GetItemById<BaseItem>(season.Id, It.IsAny<Jellyfin.Database.Implementations.Entities.User>())).Returns(season);
        }
        site.Library.Setup(l => l.GetItemById<Series>(series.Id)).Returns(series);
        site.Library.Setup(l => l.Sort(It.IsAny<IEnumerable<BaseItem>>(), It.IsAny<Jellyfin.Database.Implementations.Entities.User>(), It.IsAny<IEnumerable<ItemSortBy>>(), It.IsAny<Jellyfin.Database.Implementations.Enums.SortOrder>()))
            .Returns((IEnumerable<BaseItem> rows, Jellyfin.Database.Implementations.Entities.User _, IEnumerable<ItemSortBy> _, Jellyfin.Database.Implementations.Enums.SortOrder _) => rows);
        site.Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
        {
            if (q.ItemIds is { Length: > 0 }) return q.ItemIds.Select(i => site.Items.GetValueOrDefault(i)).OfType<BaseItem>().ToList();
            // The played-series prefilter: every played episode; a season's own episodes, by its key.
            if (q.IsPlayed == true) return episodes.Where(e => site.Played.Contains(e.Id)).Cast<BaseItem>().ToList();
            return episodes.Where(e => q.AncestorWithPresentationUniqueKey == null || seasons.Any(s => s.Id == e.SeasonId && s.PresentationUniqueKey == q.AncestorWithPresentationUniqueKey)).Cast<BaseItem>().ToList();
        });
        site.Library.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
            q.IsPlayed == true ? (q.ItemIds ?? []).Where(site.Played.Contains).ToArray() : site.Items.Keys.ToArray());
        var manager = new Mock<IServerConfigurationManager>();
        manager.SetupGet(m => m.Configuration).Returns(new MediaBrowser.Model.Configuration.ServerConfiguration());
        var previous = BaseItem.ConfigurationManager;
        BaseItem.ConfigurationManager = manager.Object;
        return (site, seasons, episodes, previous);
    }

    private static string? GenresOf(string body, Guid id)
    {
        using var doc = JsonDocument.Parse(body);
        return doc.RootElement.GetProperty("items").TryGetProperty(id.ToString("N"), out var entry) && entry.TryGetProperty("Genres", out var genres) ? genres.ToString() : null;
    }

    [Theory]
    [InlineData(16)]
    [InlineData(17)]
    public async Task ALaterSeasonsWatchedEvidenceIsTheSameAcrossThePrefilterAndComparedAtTheCommit(int count)
    {
        var (site, seasons, episodes, previous) = LaterSeasons(count);
        try
        {
            using var _ = site;
            // The season entries (genres only an exempt season keeps).
            var seasonEntries = seasons.ToDictionary(s => s.Id, s => new TagCacheEntry { Type = "Season", SeriesId = site.Series.ToString("N"), SeasonNumber = s.IndexNumber, LastUpdated = 100, Genres = ["Season genre"] });
            var policy = SpoilerTagDataStripper.CreatePolicy(site.Fixture.Plugin.Configuration, site.State)!;
            site.Played.Add(episodes[^1].Id);
            Dictionary<string, TagCacheEntry> Items() => seasonEntries.ToDictionary(p => p.Key.ToString("N"), p => p.Value);
            var stripped = Items();
            using (var scope = PrivacyReadSet.Begin())
            {
                site.Stripper.StripTagCache(policy, site.Alice, stripped);
                Assert.True(scope.Reads.Valid(), scope.Reads.Failure);
            }
            // The watched season is exempt (keeps its genres), the others are stripped, below and above the prefilter alike.
            Assert.Equal("[\"Season genre\"]", JsonSerializer.Serialize(stripped[seasons[^1].Id.ToString("N")].Genres));
            Assert.Empty(stripped[seasons[0].Id.ToString("N")].Genres!);
            // The viewer's only watched episode is unmarked before the commit, with no event yet.
            using (var scope = PrivacyReadSet.Begin())
            {
                site.Stripper.StripTagCache(policy, site.Alice, Items());
                site.Played.Remove(episodes[^1].Id);
                Assert.False(scope.Reads.Valid(), $"{count} later seasons: a season's watched evidence that changed was accepted at the commit");
            }
        }
        finally { BaseItem.ConfigurationManager = previous!; }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // One owner for vocabulary and age rating; riders replay a remembered non-extra.

    [Fact]
    public void ATagEntrysVocabularyComesFromTheSeriesTheLibraryHoldsItUnderNow()
    {
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: true, stripTags: false);
        // The cached entry names a former, plain show; the library holds the episode under the guarded show now.
        var former = new Series { Id = Guid.NewGuid(), Name = "fact former show", Genres = ["Former genre"], OfficialRating = "TV-14" };
        site.Items[former.Id] = former;
        var guarded = (Series)site.Items[site.Series];
        guarded.OfficialRating = "TV-MA";
        var entries = new Dictionary<string, TagCacheEntry>
        {
            [site.Episode.ToString("N")] = new() { Type = "Episode", SeriesId = former.Id.ToString("N"), SeasonNumber = 1, EpisodeNumber = 3, Genres = ["Former genre", "Season genre"], OfficialRating = "PG", LastUpdated = 100 },
        };
        var policy = SpoilerTagDataStripper.CreatePolicy(site.Fixture.Plugin.Configuration, site.State)!;
        site.Stripper.StripTagCache(policy, site.Alice, entries);
        var entry = entries[site.Episode.ToString("N")];
        Assert.Equal("TV-MA", entry.OfficialRating);
        Assert.DoesNotContain("Former genre", entry.Genres!);
    }

    [Fact]
    public async Task ARememberedNonExtraLeftOutOfADeltaReplaysItsOwnership()
    {
        const string sentinel = "fact clip attached to the guarded show";
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: true, stripTags: true, extras: true, edit: entries =>
        {
            var pair = entries.First(p => p.Value.Type == "Video");
            pair.Value.StreamData = new TagStreamData { ItemName = sentinel };
        });
        var clip = site.Items[site.SeriesExtra]; clip.OwnerId = Guid.Empty;
        // A full load remembers the clip as nobody's extra.
        Assert.Contains(sentinel, await site.TagCache());
        // The host attaches it to the guarded show (its event not delivered yet); a delta of nothing changed follows.
        clip.OwnerId = site.Series;
        var (status, body, _) = await site.TagCacheResponse(since: 150);
        Assert.Equal(200, status);
        Assert.DoesNotContain(sentinel, body);
        // The clip rides with the delta (stripped), so the client's stored copy of it is replaced.
        Assert.Contains(site.SeriesExtra.ToString("N"), body);
    }
}

