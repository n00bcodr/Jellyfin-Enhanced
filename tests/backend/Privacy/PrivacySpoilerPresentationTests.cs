using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Xunit;

namespace JE.Tests;

public class PrivacySpoilerPresentationTests
{
    private static PluginConfiguration Config() => new() { SpoilerBlurEnabled = true, SpoilerBlurArtwork = true,
        SpoilerKeepMoviePosters = false, SpoilerStripOverview = true, SpoilerStripRatings = true,
        SpoilerStripCast = true, SpoilerStripTags = true, SpoilerStripTaglines = true,
        SpoilerStripPremiereDate = true, SpoilerStripReviews = true, SpoilerReplaceTitle = true };
    private static UserSpoilerBlur State() => new() { PendingTmdb = new() { ["movie:42"] = new() } };

    [Theory]
    [InlineData("last_episode_to_air")][InlineData("next_episode_to_air")]
    [InlineData("lastEpisodeToAir")][InlineData("nextEpisodeToAir")]
    public void NestedEpisodePolicyIsIndependentOfDates(string field)
    {
        var state = new UserSpoilerBlur { PendingTmdb = new() { ["tv:42"] = new() } };
        state.Prefs.HideAirDate = false;
        var raw = new JsonObject { [field] = JsonNode.Parse("""{"name":"secret","overview":"secret","voteAverage":9,"vote_average":9,"stillPath":"/secret.jpg","still_path":"/secret.jpg","air_date":"2030-01-01"}""") }.ToJsonString();
        var row = JsonNode.Parse(new SpoilerPresentationContext(state, Config()).Project(raw, "tv:tmdb:42"))![field]!;
        Assert.Equal("", row["name"]!.ToString());
        foreach (var name in new[] { "overview", "voteAverage", "vote_average", "stillPath", "still_path" }) Assert.Null(row[name]);
        Assert.Equal("2030-01-01", row["air_date"]!.ToString());
    }

    [Fact]
    public void SnakeCaseLastAirDateUsesDatePolicy()
    {
        var state = new UserSpoilerBlur { PendingTmdb = new() { ["tv:42"] = new() } };
        Assert.Null(JsonNode.Parse(new SpoilerPresentationContext(state, Config()).Project("""{"last_air_date":"2030-01-01"}""", "tv:tmdb:42"))!["last_air_date"]);
    }

    [Theory]
    [InlineData("movie:tmdb:42", null, "posters")]
    [InlineData("movie:tmdb:42", null, "logos")]
    [InlineData("tv:tmdb:42", "episode", "stills")]
    [InlineData("tv:tmdb:42", null, "stills")]
    public void StandaloneAndEmbeddedImageArraysUseTypedRouteScope(string title, string? scope, string array)
    {
        var state = new UserSpoilerBlur { ProviderTitles = new() { [title] = new() } };
        var policy = new SpoilerPresentationContext(state, Config());
        var raw = new JsonObject { [array] = new JsonArray(new JsonObject { ["file_path"] = "/secret.jpg" }) }.ToJsonString();
        Assert.Empty((JsonArray)JsonNode.Parse(policy.ProjectResource(raw, title, "images", scopeKind: scope))![array]!);
        var embedded = JsonNode.Parse(policy.Project("{\"images\":" + raw + "}", title, scopeKind: scope))!;
        Assert.Empty((JsonArray)embedded["images"]![array]!);
    }

    [Theory]
    [InlineData("results")][InlineData("cast")][InlineData("crew")][InlineData("parts")]
    [InlineData("items")][InlineData("requests")][InlineData("events")][InlineData("mine")][InlineData("soon")][InlineData("ready")]
    public void EveryKnownFeedStripsEachResultsOwnFieldsWithoutMutatingRawSource(string field)
    {
        var source = new JsonObject { [field] = new JsonArray(
            new JsonObject { ["id"] = 42, ["mediaType"] = "movie", ["title"] = "Entry point", ["overview"] = "secret",
                ["posterPath"] = "/secret.jpg", ["backdropPath"] = "/backdrop.jpg", ["voteAverage"] = 9.1,
                ["releaseDate"] = "2030-01-01", ["character"] = "secret role", ["tagline"] = "secret", ["reviews"] = "secret" },
            new JsonObject { ["id"] = 42, ["mediaType"] = "tv", ["name"] = "Other kind", ["overview"] = "public" }) }.ToJsonString();
        var projected = JsonNode.Parse(new SpoilerPresentationContext(State(), Config()).Project(source))!;
        var guarded = projected[field]![0]!;
        foreach (var name in new[] { "overview", "posterPath", "backdropPath", "voteAverage", "releaseDate", "character", "tagline", "reviews" }) Assert.Null(guarded[name]);
        Assert.Equal("Entry point", guarded["title"]!.ToString());
        Assert.Equal(2030, guarded["year"]!.GetValue<int>());
        Assert.True(guarded["jeSpoiler"]!["guarded"]!.GetValue<bool>());
        Assert.False(projected[field]![1]!["jeSpoiler"]!["guarded"]!.GetValue<bool>());
        Assert.Contains("secret", source); Assert.DoesNotContain("secret", projected.ToJsonString());
        var other = new SpoilerPresentationContext(new(), Config()).Project(source);
        Assert.Contains("secret", other);
    }

    [Fact]
    public void ChildPolicyHonorsS0S1ExemptionAndUserOptOutsWithoutOriginalFallbacks()
    {
        var state = new UserSpoilerBlur { ProviderTitles = new() { ["tv:tmdb:42"] = new() } };
        var policy = new SpoilerPresentationContext(state, Config());
        var raw = """{"name":"Show","overview":"secret","seasons":[{"seasonNumber":1,"name":"S1","overview":"first","posterPath":"/s1.jpg"},{"seasonNumber":2,"overview":"later","posterPath":"/s2.jpg"}],"episodes":[{"seasonNumber":2,"episodeNumber":1,"name":"secret title","originalName":"secret alternative","overview":"secret","airDate":"2030-01-01","stillPath":"/still.jpg"}]}""";
        var projected = JsonNode.Parse(policy.Project(raw, "tv:tmdb:42"))!;
        Assert.Equal("first", projected["seasons"]![0]!["overview"]!.ToString());
        Assert.Null(projected["seasons"]![1]!["overview"]);Assert.Null(projected["seasons"]![1]!["posterPath"]);
        var episode = projected["episodes"]![0]!;Assert.Equal("",episode["name"]!.ToString());Assert.Null(episode["originalName"]);Assert.Null(episode["airDate"]);Assert.Null(episode["stillPath"]);
        state.Prefs.HideAirDate = false;
        var allowed = new SpoilerPresentationContext(state, Config());
        Assert.False(allowed.MissingRow("tv:tmdb:42").AirDate);
        Assert.NotEqual(policy.Revision, allowed.Revision);
    }

    [Fact]
    public void MovieArtworkAndProviderSubresourcesUseTheSameCapsAndRevision()
    {
        var config = Config();var state = State();var guarded = new SpoilerPresentationContext(state, config);
        Assert.True(guarded.ProtectArtwork("movie:tmdb:42", "movie", "Primary"));
        Assert.Equal("null", guarded.ProjectResource("{\"criticsScore\":99}","movie:tmdb:42","ratings"));
        Assert.Equal("{\"results\":[]}",guarded.ProjectResource("{\"results\":[{\"content\":\"secret\"}]}","movie:tmdb:42","reviews"));
        Assert.Equal("{\"results\":[]}",guarded.ProjectResource("{\"results\":[{\"release_dates\":[\"secret\"]}]}","movie:tmdb:42","release_dates"));
        config.SpoilerKeepMoviePosters=true;config.SpoilerBlurArtwork=false;
        var kept = new SpoilerPresentationContext(state,config);
        Assert.False(kept.ProtectArtwork("movie:tmdb:42","movie","Primary"));Assert.False(kept.ProtectArtwork("movie:tmdb:42","movie","Backdrop"));Assert.NotEqual(guarded.Revision,kept.Revision);
        state.Prefs.HideRatings=false;var opted = new SpoilerPresentationContext(state,config);
        Assert.False(opted.HidesRatings("movie:tmdb:42"));
        config.SpoilerBlurEnabled=false;Assert.Equal("{\"overview\":\"raw\"}",new SpoilerPresentationContext(state,config).Project("{\"overview\":\"raw\"}","movie:tmdb:42"));
    }

    [Theory]
    [InlineData("tv:tmdb:42", "tv")][InlineData("movie:tmdb:42", "movie")]
    public void LogoPathsAndNativeArtworkUseTheSamePolicy(string title, string kind)
    {
        var policy = new SpoilerPresentationContext(new UserSpoilerBlur { ProviderTitles = new() { [title] = new() } }, Config());
        Assert.True(policy.ProtectArtwork(title, kind, "Logo"));
        var result = policy.Project("""{"logoPath":"/secret.png","logo_path":"/secret.png","logoUrl":"/secret.png","logo":"/secret.png"}""", title);
        Assert.DoesNotContain("secret", result);
    }

    [Theory]
    [InlineData("events")][InlineData("results")][InlineData("items")]
    public void CalendarEpisodeUsesSeriesIdentityAndEpisodePreferences(string field)
    {
        var state = new UserSpoilerBlur { ProviderTitles = new() { ["tv:tmdb:42"] = new() } };
        state.Prefs.HideSeriesDescriptions = false;
        var raw = """{"source":"Sonarr","id":"sonarr|instance|999","type":"Series","tmdbId":42,"title":"Series entry","subtitle":"S02E03 - secret","episodeTitle":"secret","episode_title":"secret","seasonNumber":2,"episodeNumber":3,"overview":"secret","releaseDate":"2030-01-01","releaseDateLocal":"2030-01-01","airDateUtc":"2030-01-01","airDate":"2030-01-01","posterUrl":"/safe-series-poster.jpg","backdropUrl":"/secret.jpg"}""";
        var projected = JsonNode.Parse(new SpoilerPresentationContext(state, Config()).ProjectResource("{\"" + field + "\":[" + raw + "]}", null, "calendar"))![field]![0]!;
        Assert.DoesNotContain("secret", projected.ToJsonString());
        Assert.Equal("Series entry", projected["title"]!.ToString());
        Assert.Equal("S02E03", projected["subtitle"]!.ToString());
        Assert.True(projected["jeSpoiler"]!["overview"]!.GetValue<bool>());
        foreach (var date in new[] { "releaseDate", "releaseDateLocal", "airDateUtc", "airDate" }) Assert.Null(projected[date]);
        state.Prefs.ReplaceEpisodeTitles = false; state.Prefs.HideAirDate = false;
        var allowed = new SpoilerPresentationContext(state, Config()).ProjectResource("[" + raw + "]", null, "calendar");
        Assert.Contains("secret", allowed); Assert.Contains("releaseDateLocal", allowed);
    }

    [Fact]
    public void CalendarMovieStripsEveryPreciseDateAlias()
    {
        var raw = """[{"source":"Radarr","type":"Movie","tmdbId":42,"releaseDateLocal":"2030-01-01","physicalRelease":"2030-01-01","digitalRelease":"2030-01-01","inCinemas":"2030-01-01","physical_release":"2030-01-01","digital_release":"2030-01-01","in_cinemas":"2030-01-01"}]""";
        Assert.DoesNotContain("2030-01-01", new SpoilerPresentationContext(State(), Config()).Project(raw));
    }

    [Theory]
    [InlineData("recommendations")][InlineData("similar")]
    public void AppendedListsUseEachResultsPolicyAndRecommendationSurface(string field)
    {
        var raw = "{\"id\":51,\"name\":\"Public seed\",\"" + field + "\":{\"page\":1,\"results\":[{\"id\":42,\"overview\":\"secret\",\"backdrop_path\":\"/secret.jpg\"},{\"id\":43,\"overview\":\"public\"}]}}";
        var state = new UserSpoilerBlur { ProviderTitles = new() { ["tv:tmdb:42"] = new() } };
        var result = JsonNode.Parse(new SpoilerPresentationContext(state, Config()).Project(raw, "tv:tmdb:51"))!;
        Assert.DoesNotContain("secret", result.ToJsonString());
        Assert.Equal("public", result[field]!["results"]![1]!["overview"]!.ToString());
        var hidden = HiddenContentPolicy.Build(new UserHiddenContent { Settings = new() { FilterDiscovery=false, FilterRecommendations=true }, Items = new() { ["tv:tmdb:42"] = new() { Type="Series", TmdbId="42" } } }, true);
        Assert.Single((JsonArray)JsonNode.Parse(TitleFeedProjection.Hidden(raw, hidden, "discovery", "tv"))![field]!["results"]!);
    }

    [Fact]
    public void UnknownPolicySuppressesSensitiveDataWhileUnrelatedViewerRemainsUnchanged()
    {
        var unknown = new SpoilerPresentationContext(new(),Config(),unavailable:true);
        Assert.True(unknown.Guarded("movie:tmdb:42"));Assert.True(unknown.HidesRatings("tv:tmdb:51"));
        Assert.False(new SpoilerPresentationContext(new(),Config()).Guarded("movie:tmdb:42"));
    }
}

[Collection("Plugin singleton")]
public class PrivacySpoilerContextTests
{
    [Fact]
    public void CastModeAndSafeNavigationMetadataSurviveDateProjection()
    {
        var state = new UserSpoilerBlur { PendingTmdb = new() { ["movie:42"] = new() } };
        var config = new PluginConfiguration { SpoilerBlurEnabled = true, SpoilerStripCast = true, SpoilerStripCastMode = "GuestStars", SpoilerStripPremiereDate = true };
        var raw = """{"title":"Film","releaseDate":"2024-02-27","credits":{"cast":[{"name":"Regular"}],"guestStars":[{"name":"Secret"}]},"releases":{"results":[{"iso_3166_1":"US","release_dates":[{"release_date":"2024-02-27","certification":"PG-13"}]}]}}""";
        var projected = JsonNode.Parse(new SpoilerPresentationContext(state,config).Project(raw,"movie:tmdb:42"))!;
        Assert.Equal(2024,projected["year"]!.GetValue<int>());Assert.Null(projected["releaseDate"]);Assert.Null(projected["releases"]);
        Assert.Equal("PG-13",projected["contentRatings"]!["results"]![0]!["rating"]!.ToString());
        Assert.NotNull(projected["credits"]!["cast"]);Assert.Null(projected["credits"]!["guestStars"]);
        config.SpoilerStripCastMode="All";
        Assert.Null(JsonNode.Parse(new SpoilerPresentationContext(state,config).Project(raw,"movie:tmdb:42"))!["credits"]);
    }

    [Fact]
    public void ContextLoadsOnceAndProjectsHundredsOfCardsWithoutLibraryReads()
    {
        using var fixture = new ApiPluginFixture();fixture.Plugin.Configuration.SpoilerBlurEnabled=true;
        var viewer=Guid.NewGuid();var state=new UserSpoilerBlur { PendingTmdb=new() { ["movie:42"]=new() } };
        fixture.Core.Manager.SaveUserConfiguration(viewer.ToString("N"),"spoilerblur.json",state);
        var library=new Moq.Mock<MediaBrowser.Controller.Library.ILibraryManager>(Moq.MockBehavior.Strict);
        var users=new Moq.Mock<MediaBrowser.Controller.Library.IUserManager>();
        var service=new SpoilerPresentation(fixture.Core.Manager,library.Object,users.Object,new Moq.Mock<MediaBrowser.Controller.Library.IUserDataManager>().Object);
        var http=new Microsoft.AspNetCore.Http.DefaultHttpContext();var context=service.Load(viewer,http);
        Assert.Same(context,service.Load(viewer,http));
        for(var i=0;i<300;i++) Assert.DoesNotContain("secret",context.Project("{\"overview\":\"secret\"}","movie:tmdb:42"));
        Assert.Empty(library.Invocations);
    }
}

[Collection("Plugin singleton")]
public class PrivacyD46RoundOneTests
{
    [Fact]
    public void SpoilerLibraryRulesCoverEntryTwoThousandAndOneInBoundedBatches()
    {
        using var f = new ApiPluginFixture(); f.Plugin.Configuration.SpoilerBlurEnabled = true;
        var viewer = Guid.NewGuid(); var person = new Jellyfin.Database.Implementations.Entities.User("viewer", "default", "default") { Id = viewer };
        var ids = Enumerable.Range(0, 2001).Select(_ => Guid.NewGuid()).ToArray();
        var state = new UserSpoilerBlur(); foreach (var id in ids) state.Series[id.ToString("N")] = new();
        f.Core.Manager.SaveUserConfiguration(viewer.ToString("N"), "spoilerblur.json", state);
        var users = new Moq.Mock<MediaBrowser.Controller.Library.IUserManager>(); users.Setup(u => u.GetUserById(viewer)).Returns(person);
        var library = new Moq.Mock<MediaBrowser.Controller.Library.ILibraryManager>();
        library.Setup(l => l.GetItemList(Moq.It.IsAny<MediaBrowser.Controller.Entities.InternalItemsQuery>()))
            .Returns((MediaBrowser.Controller.Entities.InternalItemsQuery q) => q.ItemIds.Select(id => (MediaBrowser.Controller.Entities.BaseItem)new MediaBrowser.Controller.Entities.TV.Series { Id = id, ProviderIds = new Dictionary<string,string> { ["Tmdb"] = (Array.IndexOf(ids,id)+1).ToString() } }).ToList());
        var context = new SpoilerPresentation(f.Core.Manager, library.Object, users.Object, Moq.Mock.Of<MediaBrowser.Controller.Library.IUserDataManager>()).Load(viewer);
        Assert.True(context.Guarded("tv:tmdb:2001")); Assert.Equal(2, library.Invocations.Count);
        Assert.All(library.Invocations, call => Assert.InRange(((MediaBrowser.Controller.Entities.InternalItemsQuery)call.Arguments[0]).ItemIds.Length, 1, 2000));
    }

    [Fact]
    public void StaleFullDocumentCannotEraseNewerAtomicRule()
    {
        using var f = new ApiPluginFixture(); var viewer = Guid.NewGuid();
        var users = new Moq.Mock<MediaBrowser.Controller.Library.IUserManager>();
        users.Setup(u => u.GetUserById(viewer)).Returns(new Jellyfin.Database.Implementations.Entities.User("viewer","default","default") { Id=viewer });
        var c = ApiAssetTests.Controller(f.Core, f.Core.Manager, users.Object); c.HttpContext.User = JellyfinEnhanced.Tests.PrivacyPolicyTests.Principal(viewer);
        var stale = new UserHiddenContent();
        Assert.IsType<Microsoft.AspNetCore.Mvc.OkObjectResult>(c.PutHiddenContentRule(viewer.ToString("N"), "movie:tmdb:42", new() { Type="Movie", TmdbId="42" }));
        c.SaveUserHiddenContent(viewer.ToString("N"), stale);
        Assert.Contains("movie:tmdb:42", f.Core.Manager.GetUserConfiguration<UserHiddenContent>(viewer.ToString("N"), "hidden-content.json").Items.Keys);
    }

    [Theory]
    [InlineData(false)][InlineData(true)]
    public async Task MetadataGateRechecksAfterProviderAwait(bool awards)
    {
        using var f = new ApiPluginFixture(); var viewer=Guid.NewGuid();
        f.Plugin.Configuration.SpoilerBlurEnabled=true; f.Plugin.Configuration.SpoilerStripRatings=true;
        f.Plugin.Configuration.ShowAwards=true; f.Plugin.Configuration.MdblistRatingsEnabled=true; f.Plugin.Configuration.MdblistApiKey="test";
        var started=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var transport=new IntegrationTransport(async (_,_) => { started.TrySetResult(); await release.Task; return IntegrationTransport.Response(awards ? """{"results":{"bindings":[]}}""" : """{"ratings":[{"source":"imdb","value":99}]}"""); });
        using var mdblist=new MdblistService(transport,f.Core.Paths.Object,f.Core.Logger);
        using var wikidata=new WikidataAwardsService(transport,f.Core.Paths.Object,f.Core.Logger);
        var presentation=new SpoilerPresentation(f.Core.Manager,Moq.Mock.Of<MediaBrowser.Controller.Library.ILibraryManager>(),Moq.Mock.Of<MediaBrowser.Controller.Library.IUserManager>(),Moq.Mock.Of<MediaBrowser.Controller.Library.IUserDataManager>());
        var c=ApiAssetTests.Controller(f.Core,f.Core.Manager,mdblist,wikidata,presentation); c.HttpContext.User=JellyfinEnhanced.Tests.PrivacyPolicyTests.Principal(viewer);
        var task=awards ? c.GetAwards("movie","42",default) : c.GetMdblistRatings("movie","42",default);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        f.Core.Manager.SaveUserConfiguration(viewer.ToString("N"),"spoilerblur.json",new UserSpoilerBlur { PendingTmdb=new() { ["movie:42"]=new() } }); release.SetResult();
        var result=Assert.IsType<Microsoft.AspNetCore.Mvc.OkObjectResult>(await task);
        var json=System.Text.Json.JsonSerializer.Serialize(result.Value,new System.Text.Json.JsonSerializerOptions { PropertyNamingPolicy=System.Text.Json.JsonNamingPolicy.CamelCase });
        Assert.Contains("\"ratings\":[]",json); Assert.Contains("\"awards\":[]",json);
        Assert.Equal("private, no-store",c.Response.Headers.CacheControl.ToString());
    }
}
