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
