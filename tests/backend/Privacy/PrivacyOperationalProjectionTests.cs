using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Secrets;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Routing;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class PrivacyOperationalProjectionTests
{
    internal static void Inject(object target, string field, object value)
        => target.GetType().GetField(field, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(target, value);

    internal static SpoilerPresentation Guard(ApiPluginFixture fixture, Guid user, string title, bool ratings = true)
    {
        var config = fixture.Plugin.Configuration;
        config.SpoilerBlurEnabled = true;
        config.SpoilerReplaceTitle = true;
        config.SpoilerStripOverview = true;
        config.SpoilerStripSeriesOverview = true;
        config.SpoilerStripRatings = ratings;
        config.SpoilerStripPremiereDate = false;
        config.SpoilerBlurArtwork = true;
        config.SpoilerKeepMoviePosters = false;
        fixture.Core.Manager.SaveUserConfiguration(user.ToString("N"), "spoilerblur.json",
            new UserSpoilerBlur { ProviderTitles = new() { [title] = new() } });
        return new(fixture.Core.Manager, Mock.Of<ILibraryManager>(), Mock.Of<IUserManager>(), Mock.Of<IUserDataManager>());
    }

    internal static JsonNode Final(ApiPluginFixture fixture, SpoilerPresentation spoilers, Guid user, string path, IActionResult result)
    {
        var http = new DefaultHttpContext();
        http.Request.Path = "/JellyfinEnhanced/" + path;
        http.Request.Method = "GET";
        http.User = TestCallers.Principal(user, false);
        var context = new ResultExecutingContext(new ActionContext(http, new RouteData(), new ActionDescriptor()),
            new List<IFilterMetadata>(), result, new object());
        new TitlePresentationResultFilter(fixture.Core.Manager, spoilers, Mock.Of<ILibraryManager>(),
            Mock.Of<MediaBrowser.Controller.IServerApplicationHost>(), null!).OnResultExecuting(context);
        return JsonNode.Parse(context.Result switch
        {
            ContentResult content => content.Content!,
            FileContentResult file => Encoding.UTF8.GetString(file.FileContents),
            _ => throw new InvalidOperationException(context.Result.GetType().Name)
        })!;
    }

    [Fact]
    public async Task CalendarControllerThroughFinalGateKeepsEpisodeCoordinatesAndAvailableFilter()
    {
        using var f = new ApiPluginFixture();
        var user = Guid.NewGuid();
        var spoilers = Guard(f, user, "tv:tmdb:42");
        f.Plugin.Configuration.CalendarPageEnabled = true;
        f.Plugin.Configuration.CalendarFilterByLibraryAccess = false;
        f.Plugin.Configuration.SonarrInstances = """[{"Name":"TV","Url":"http://127.0.0.1/sonarr","ApiKey":"test"}]""";
        f.Plugin.Configuration.RadarrInstances = "[]";
        SecretsMigration.MigrateStored(f.Plugin.Configuration, f.Plugin.Secrets);
        var episode = Guid.NewGuid();
        var database = new IntegrationCalendarTests.CalendarDatabase();
        using (var db = database.CreateDbContext())
        {
            db.BaseItemProviders.Add(new BaseItemProvider { Item = null!, ItemId = episode, ProviderId = "Tvdb", ProviderValue = "9001" });
            db.SaveChanges();
        }
        using var transport = new IntegrationTransport((request, _) => Task.FromResult(IntegrationTransport.Response(
            request.RequestUri!.AbsolutePath.EndsWith("system/status") ? """{"appName":"Sonarr","version":"4.0.0"}""" :
            """[{"id":9,"tvdbId":9001,"seasonNumber":2,"episodeNumber":3,"title":"secret episode","overview":"secret plot","airDateUtc":"2026-10-10T12:00:00Z","hasFile":true,"monitored":true,"series":{"id":1,"tmdbId":42,"tvdbId":123,"title":"Series","images":[{"coverType":"poster","remoteUrl":"/poster.jpg"},{"coverType":"fanart","remoteUrl":"/secret-art.jpg"}]}}]""")));
        using var store = new ArrStateStore(new ArrClientFactory(transport, new ArrInstanceRegistry()), null, null,
            () => new DateTimeOffset(2030, 1, 1, 0, 0, 0, TimeSpan.Zero), null);
        var controller = ApiAssetTests.Controller(f.Core, f.Core.Manager, transport, database, store, spoilers);
        controller.HttpContext.User = TestCallers.Principal(user, true);
        controller.Request.QueryString = new QueryString("?start=2026-10-01&end=2026-11-01");
        var result = Final(f, spoilers, user, "arr/calendar", await controller.GetCalendarEvents());
        var row = Assert.Single(result["events"]!.AsArray())!;
        Assert.Equal("Sonarr", row["source"]?.ToString());
        Assert.Equal(2, row["seasonNumber"]?.GetValue<int>());
        Assert.Equal(3, row["episodeNumber"]?.GetValue<int>());
        Assert.Equal("Episode", row["releaseType"]?.ToString());
        Assert.True(row["hasFile"]?.GetValue<bool>());
        Assert.Equal(episode.ToString(), row["itemEpisodeId"]?.ToString());
        Assert.Equal("S02E03", row["subtitle"]?.ToString());
        Assert.Single(result["events"]!.AsArray(), e => e?["hasFile"]?.GetValue<bool>() == true);
        Assert.NotNull(row["releaseDate"]); // dates are explicitly permitted
        Assert.Null(row["episodeTitle"]);
        Assert.DoesNotContain("secret", row.ToJsonString());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ActualApprovalsKeepOverQuotaAndParentalAssessmentIndependentOfReviewRatings(bool stripRatings)
    {
        using var f = new ApiPluginFixture();
        using var r = new IntegrationRequestLedgerTests.Rig();
        var spoilers = Guard(f, r.Manager, "tv:tmdb:42", stripRatings);
        r.Policy.People[r.Kid] = r.Policy.People[r.Kid] with { Limit = 0 };
        r.View.Users[r.Kid] = new StatusViewer { UserId = r.Kid, HasParentalLimit = true };
        var input = new MutationInput { Key = "tv:tmdb:42", Scope = "seasons", Seasons = new[] { 2 } };
        var want = await r.Create(r.Kid, input);
        Assert.Equal("over_quota", r.Ledger.Find(want.RequestId!)!.Reason);
        var directory = new IntegrationRequestHouseholdTests.FakeDirectory();
        directory.People[r.Kid] = new HouseholdPerson { Id = r.Kid, Name = "Child", HasParentalLimit = true };
        var projection = new RequestHubProjection(r.Service, directory, null,
            (_, _, _) => Task.FromResult<HubTitleMeta?>(new() { Title = "Series", Rating = "PG", Poster = "/poster.jpg" }), () => r.Now);
        Inject(projection, "_presentation", spoilers);
        var body = await projection.ApprovalsAsync(new StatusViewer { UserId = r.Manager }, default);
        var result = Final(f, spoilers, r.Manager, "acquire/requests/approvals", new FileContentResult(body.Json, "application/json"));
        var row = Assert.Single(result["items"]!.AsArray())!;
        Assert.True(row["overQuota"]?.GetValue<bool>());
        Assert.Equal("PG", row["rating"]?["label"]?.ToString());
        Assert.True(row["rating"]?["within"]?.GetValue<bool>());
        Assert.Equal(2, row["seasons"]?[0]?.GetValue<int>());
        Assert.Equal(0, row["requester"]?["quota"]?["limit"]?.GetValue<int>());
        Assert.True(row["canApprove"]?.GetValue<bool>());
        Assert.False(row["okd"]?.GetValue<bool>());
        Assert.Equal(want.RequestId, row["id"]?.ToString());
        var injected = row.AsObject();
        injected["overview"] = "secret";
        injected["backdrop"] = "/secret.jpg";
        injected["voteAverage"] = 9;
        injected["rating"]!["unknown_envelope"] = new JsonObject { ["overview"] = "secret" };
        // The final filter must select the same adapter and still reject nested unknown fields.
        var again = Final(f, spoilers, r.Manager, "acquire/requests/approvals",
            new ContentResult { Content = result.ToJsonString(), ContentType = "application/json" });
        Assert.DoesNotContain("secret", again.ToJsonString());
        Assert.Equal(!stripRatings, again["items"]![0]!.AsObject().ContainsKey("voteAverage"));
        Assert.Equal("PG", again["items"]![0]?["rating"]?["label"]?.ToString());
    }

    [Fact]
    public async Task ActualMineKeepsRequestScopeCoordinatesAndCancellationControls()
    {
        using var f = new ApiPluginFixture();
        using var r = new IntegrationRequestLedgerTests.Rig();
        var spoilers = Guard(f, r.Kid, "tv:tmdb:42");
        var want = await r.Create(r.Kid, new MutationInput { Key = "tv:tmdb:42", Scope = "episodes", Episodes = new[] { new RequestEpisode(2, 3) } });
        var projection = new RequestHubProjection(r.Service, new IntegrationRequestHouseholdTests.FakeDirectory(), null,
            (_, _, _) => Task.FromResult<HubTitleMeta?>(new() { Title = "Series", Poster = "/safe-series.jpg" }), () => r.Now);
        Inject(projection, "_presentation", spoilers);
        var body = await projection.MineAsync(new StatusViewer { UserId = r.Kid }, default);
        var result = Final(f, spoilers, r.Kid, "acquire/requests/mine", new FileContentResult(body.Json, "application/json"));
        var row = Assert.Single(result["items"]!.AsArray())!;
        Assert.Equal(2, row["episodes"]?[0]?["season"]?.GetValue<int>());
        Assert.Equal(3, row["episodes"]?[0]?["episode"]?.GetValue<int>());
        Assert.True(row["canCancel"]?.GetValue<bool>());
        Assert.Equal(want.RequestId, Assert.Single(row["cancelIds"]!.AsArray())?.ToString());
        Assert.Equal("pending", row["status"]?.ToString());
        Assert.Equal("episodes", row["scope"]?.ToString());
    }
    [Fact]
    public async Task ActualRawLedgerListKeepsGroupedMembersRequesterAndJobReceipts()
    {
        using var f = new ApiPluginFixture();
        using var r = new IntegrationRequestLedgerTests.Rig();
        var spoilers = Guard(f, r.Admin, "movie:tmdb:603");
        var want = await r.Create(r.Admin);
        var controller = r.Controller(r.Admin);
        var result = Final(f, spoilers, r.Admin, "acquire/requests", await controller.List("mine", default));
        var row = Assert.Single(result["items"]!.AsArray())!;
        Assert.Equal(r.Admin.ToString(), row["requesterId"]?.ToString());
        Assert.Equal(want.RequestId, Assert.Single(row["members"]!.AsArray())?["id"]?.ToString());
        Assert.NotEmpty(row["jobs"]!.AsArray());
        Assert.NotEmpty(row["members"]![0]!["jobs"]!.AsArray());
        Assert.True(row["canApprove"]?.GetValue<bool>());
        Assert.Equal("queued", row["status"]?.ToString());
    }

    [Fact]
    public void StandaloneStatusAdapterKeepsEveryOperationalFieldAndProtectsInjectedTitleFields()
    {
        using var f = new ApiPluginFixture();
        var user = Guid.NewGuid();
        var spoilers = Guard(f, user, "movie:tmdb:42");
        const string raw = """{"contact":"Dad","lookingHours":72,"items":[{"key":"movie:tmdb:42","liveKey":"movie:tmdb:42","itemId":"shown","openItemId":"playable","kind":"movie","versions":2,"stage":"downloading","reason":{"code":"queued","params":{"held":"quota","sent":"1","since":"2026-10-01","pct":"25","eta":"60"}},"attention":true,"quiet":false,"progress":{"percent":25,"etaSeconds":60},"askedSeasons":[2],"journey":[{"stage":"asked","at":"2026-10-01","state":"done","byYou":true}],"summary":{"aired":3,"ready":2},"seasons":[{"season":2,"stage":"looking","summary":{"missing":1}}],"episodes":[{"key":"tv:tmdb:42:s2:e3","season":2,"episode":3,"row":true,"stage":"ready","itemId":"episode"}],"actions":["cancel"],"overview":"secret","posterPath":"/secret.jpg","unknown":{"overview":"secret"}}]}""";
        var result = Final(f, spoilers, user, "acquire/status", new ContentResult { Content = raw, ContentType = "application/json" });
        var row = Assert.Single(result["items"]!.AsArray())!;
        var original = JsonNode.Parse(raw)!["items"]![0]!.AsObject();
        foreach (var pair in original.Where(p => p.Key is not ("overview" or "posterPath" or "unknown")))
            Assert.True(JsonNode.DeepEquals(pair.Value, row[pair.Key]), pair.Key);
        Assert.DoesNotContain("secret", result.ToJsonString());
    }

    [Fact]
    public void TargetedStatusRemainsReadableForAHiddenTitle()
    {
        using var f = new ApiPluginFixture();
        var user = Guid.NewGuid();
        var spoilers = Guard(f, user, "movie:tmdb:42");
        f.Plugin.Configuration.HiddenContentEnabled = true;
        f.Core.Manager.SaveUserConfiguration(user.ToString("N"), "hidden-content.json", new UserHiddenContent
        { Items = new() { ["movie:tmdb:42"] = new() { Type = "Movie", TmdbId = "42" } } });
        var result = Final(f, spoilers, user, "acquire/status", new ContentResult
        { Content = """{"items":[{"key":"movie:tmdb:42","stage":"asked","actions":["cancel"],"overview":"secret"}]}""", ContentType = "application/json" });
        Assert.Equal("asked", Assert.Single(result["items"]!.AsArray())?["stage"]?.ToString());
        Assert.DoesNotContain("secret", result.ToJsonString());
    }

    [Theory]
    [InlineData("/api/v1/request", "page")]
    [InlineData("/api/v1/watchlist", "page")]
    [InlineData("discover/movie", "page")]
    [InlineData("movie/42", "title")]
    [InlineData("tv/42/season/2", "season")]
    [InlineData("tv/42/season/2/episode/3", "episode")]
    [InlineData("person/42", "person")]
    [InlineData("collection/42", "collection")]
    [InlineData("/api/v1/movie/42/ratingscombined", "ratingscombined")]
    public void ProviderPathsSelectDeclaredResources(string path, string expected)
        => Assert.Equal(expected, ProviderPresentationSchema.ProviderResource(path));

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void KnownCombinedRatingMetricsFollowTheRatingPreferenceAndKeepUnknownFieldsProtected(bool stripRatings)
    {
        var spoilers = new SpoilerPresentationContext(new UserSpoilerBlur { ProviderTitles = new() { ["movie:tmdb:42"] = new() } },
            new PluginConfiguration { SpoilerBlurEnabled = true, SpoilerStripRatings = stripRatings });
        const string raw = """{"rt":{"year":2024,"criticsScore":92,"audienceScore":95},"imdb":{"criticsScore":8.4,"criticsScoreCount":798620},"unknown_envelope":{"overview":"secret"}}""";
        var projected = spoilers.ProjectResource(raw, "movie:tmdb:42", "ratingscombined");
        Assert.DoesNotContain("secret", projected);
        if (stripRatings) { Assert.Equal("null", projected); return; }
        var result = JsonNode.Parse(projected)!;
        Assert.Equal(2024, result["rt"]?["year"]?.GetValue<int>());
        Assert.Equal(798620, result["imdb"]?["criticsScoreCount"]?.GetValue<int>());
        Assert.Equal(92, result["rt"]?["criticsScore"]?.GetValue<int>());
        Assert.Equal(95, result["rt"]?["audienceScore"]?.GetValue<int>());
    }

    [Theory]
    [InlineData("")]
    [InlineData("future-undeclared-envelope")]
    public void MissingOrUnknownResourceFailsLoudly(string resource)
    {
        var policy = new TitlePresentationPolicy(HiddenContentPolicy.Build(null), null);
        Assert.ThrowsAny<ArgumentException>(() => policy.Project("{}", "requests", null, resource));
    }

}
