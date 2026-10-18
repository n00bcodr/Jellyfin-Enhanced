using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Globalization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class PrivacyTmdbAppendTests
{
    // This table is the public append contract. Adding an envelope requires a policy assertion here.
    public static TheoryData<string, string, bool> Envelopes => new()
    {
        { "recommendations", "{\"results\":[{\"id\":42,\"overview\":\"secret\"},{\"id\":43,\"overview\":\"public\"}]}", false },
        { "similar", "{\"results\":[{\"id\":42,\"overview\":\"secret\"},{\"id\":43,\"overview\":\"public\"}]}", false },
        { "credits", "{\"cast\":[{\"name\":\"secret\"}],\"crew\":[]}", true },
        { "aggregate_credits", "{\"cast\":[{\"name\":\"secret\",\"roles\":[{\"character\":\"secret\"}]}],\"crew\":[]}", true },
        { "images", "{\"posters\":[],\"backdrops\":[{\"file_path\":\"/secret.jpg\"}],\"logos\":[{\"file_path\":\"/secret.png\"}]}", true },
        { "videos", "{\"results\":[{\"name\":\"secret\",\"key\":\"secret\"}]}", true },
        { "keywords", "{\"results\":[{\"id\":1,\"name\":\"secret\"}]}", true },
        { "reviews", "{\"results\":[{\"content\":\"secret\"}]}", true },
        { "release_dates", "{\"results\":[{\"release_dates\":[{\"release_date\":\"secret\",\"certification\":\"PG\"}]}]}", true },
        { "content_ratings", "{\"results\":[{\"iso_3166_1\":\"US\",\"rating\":\"PG\"}]}", true },
        { "watch/providers", "{\"results\":{\"US\":{\"link\":\"https://example.com\",\"flatrate\":[]}}}", true },
        { "external_ids", "{\"imdb_id\":\"tt1234\",\"tvdb_id\":1234}", true }
    };

    [Theory]
    [InlineData("credits")][InlineData("aggregate_credits")]
    public void CreditPeopleCannotBeMistakenForAnUnrelatedGuardedTitle(string envelope)
    {
        var policy = new SpoilerPresentationContext(new UserSpoilerBlur { ProviderTitles=new() { ["tv:tmdb:42"]=new() } },
            new PluginConfiguration { SpoilerBlurEnabled=true,SpoilerStripCast=true,SpoilerStripCastMode="All" });
        var raw = """{"cast":[{"id":42,"name":"Person","character":"Public role"}],"crew":[]}""";
        var standalone = JsonNode.Parse(policy.ProjectResource(raw,"tv:tmdb:51",envelope,"tv"))!;
        Assert.Equal("Public role",standalone["cast"]![0]!["character"]?.ToString());
        var appended = policy.Project(new JsonObject { [envelope]=JsonNode.Parse(raw) }.ToJsonString(),"tv:tmdb:51",fallbackKind:"tv");
        Assert.Equal("Public role",JsonNode.Parse(appended)![envelope]!["cast"]![0]!["character"]?.ToString());
    }

    [Fact]
    public void AllowlistAndProjectionContractCannotDrift()
        => Assert.Equal(TmdbAppendProjection.Envelopes.Order(), Envelopes.Select(row => (string)row[0]).Order());

    [Theory]
    [MemberData(nameof(Envelopes))]
    public void EveryAllowedAppendEnvelopeIsProjected(string envelope, string body, bool guardSeed)
    {
        var state = new UserSpoilerBlur { ProviderTitles = new() { ["tv:tmdb:42"] = new() } };
        var config = new PluginConfiguration { SpoilerBlurEnabled=true, SpoilerStripOverview=true, SpoilerStripCast=true,
            SpoilerStripCastMode="All", SpoilerBlurArtwork=true, SpoilerStripTags=true, SpoilerStripPremiereDate=true, SpoilerStripReviews=true };
        var schema = envelope is "recommendations" or "similar" ? "page" : envelope == "aggregate_credits" ? "credits" : envelope;
        PrivacyProviderSchemaTests.Classify(JsonNode.Parse(body)!.AsObject(), schema, envelope);
        var seed = guardSeed ? "tv:tmdb:42" : "tv:tmdb:51";
        var raw = new JsonObject { [envelope] = JsonNode.Parse(body) }.ToJsonString();
        var result = new SpoilerPresentationContext(state, config).Project(raw, seed);
        Assert.DoesNotContain("secret", result);
        if (envelope is "recommendations" or "similar") Assert.Contains("public", result);
        if (envelope is "content_ratings" or "watch/providers" or "external_ids")
            Assert.True(JsonNode.DeepEquals(JsonNode.Parse(body), JsonNode.Parse(result)![envelope]));
    }

    [Theory]
    [InlineData("?append_to_response=translations", "tv/42")]
    [InlineData("?append_to_response=recommendations,unknown", "tv/42")]
    [InlineData("?append_to_response=", "tv/42")]
    [InlineData("?append_to_response=season/1", "tv/42")]
    [InlineData("?append_to_response=recommendations&append_to_response=unknown", "tv/42")]
    [InlineData("?append%5Fto%5Fresponse=unknown", "tv/42")]
    [InlineData("", "tv/42?append_to_response=unknown")]
    [InlineData("", "tv/42%3Fappend_to_response%3Dunknown")]
    [InlineData("?append_to_response=recommendations", "person/42")]
    public async Task UnsupportedAppendFailsClosedBeforeUpstream(string query, string path)
    {
        using var f = new ApiPluginFixture(); f.Plugin.Configuration.TMDB_API_KEY="test";
        using var transport = new IntegrationTransport((_,_) => Task.FromResult(IntegrationTransport.Response("{}")));
        using var cache = new TmdbResponseCache(transport, TimeProvider.System);
        var parental = new SeerrParentalFilter(transport, Mock.Of<IUserManager>(), Mock.Of<ILocalizationManager>(), Mock.Of<IServerConfigurationManager>(), f.Core.Logger);
        var c = ApiAssetTests.Controller(f.Core, cache, parental);
        c.HttpContext.User = JellyfinEnhanced.Tests.PrivacyPolicyTests.Principal(Guid.NewGuid());
        c.HttpContext.Request.QueryString = new QueryString(query);
        var result = await c.ProxyTmdbRequest(path);
        Assert.Equal(400, result switch { ObjectResult obj=>obj.StatusCode, StatusCodeResult status=>status.StatusCode, _=>null });
        Assert.Equal(0, transport.Calls);
    }
}
