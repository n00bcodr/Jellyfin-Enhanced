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
public class PrivacyRuntimeSchemaTests
{
    private static TitlePresentationPolicy Policy(bool guarded = true, bool artwork = true, bool cast = true)
        => new(HiddenContentPolicy.Build(new UserHiddenContent { Items = new() { ["tv:tmdb:42"] = new() { Type="Series", TmdbId="42" } } }),
            new SpoilerPresentationContext(new UserSpoilerBlur { ProviderTitles = guarded ? new() { ["tv:tmdb:42"]=new(), ["movie:tmdb:42"]=new() } : new() },
                new PluginConfiguration { SpoilerBlurEnabled=true, SpoilerBlurArtwork=artwork, SpoilerKeepMoviePosters=false,
                    SpoilerReplaceTitle=true, SpoilerStripOverview=true, SpoilerStripSeriesOverview=true, SpoilerStripCast=cast,
                    SpoilerStripCastMode="All", SpoilerStripRatings=true, SpoilerStripPremiereDate=true, SpoilerStripReviews=true,
                    SpoilerStripTags=true, SpoilerStripTaglines=true }));

    [Theory]
    [InlineData("credits")][InlineData("aggregate_credits")]
    public void HiddenTitleIdCollisionKeepsCreditPeopleButFiltersFilmographyTitles(string resource)
    {
        const string raw="""{"cast":[{"id":42,"name":"Person","character":"Public"}],"crew":[{"id":42,"name":"Crew"}]}""";
        var credits=JsonNode.Parse(Policy().Project(raw,"discovery","tv:tmdb:51",resource,"tv"))!;
        Assert.Single(credits["cast"]!.AsArray()); Assert.Single(credits["crew"]!.AsArray());
        var filmography=JsonNode.Parse(Policy().Project("""{"cast":[{"id":42,"media_type":"tv"},{"id":51,"media_type":"tv"}]}""","discovery",title:null,resource:"combined_credits"))!;
        Assert.Single(filmography["cast"]!.AsArray()); Assert.Equal(51,filmography["cast"]![0]!["id"]!.GetValue<int>());
    }

    [Fact]
    public void GuardedCalendarUsesSeriesArtworkAndEpisodeTextPolicies()
    {
        const string raw="""[{"type":"Series","source":"Sonarr","tmdbId":42,"title":"Series","episodeTitle":"secret","subtitle":"S02E03 - secret","seasonNumber":2,"episodeNumber":3,"posterUrl":"/safe.jpg","backdropUrl":"/safe-backdrop.jpg"}]""";
        var policy=Policy(artwork:false);
        // Keep this title visible on calendar while exercising its guard.
        policy=policy with { Hidden=HiddenContentPolicy.Build(null) };
        var result=JsonNode.Parse(policy.Project(raw,"calendar",null,"calendar"))![0]!;
        Assert.Equal("/safe.jpg",result["posterUrl"]?.ToString());
        Assert.Equal("/safe-backdrop.jpg",result["backdropUrl"]?.ToString());
        Assert.Equal("Series",result["title"]?.ToString()); Assert.Equal("S02E03",result["subtitle"]?.ToString());
        Assert.Null(result["episodeTitle"]);
    }

    [Fact]
    public void CombinedRatingsAreSuppressedAtFinalGateAndPreservedWhenUnguarded()
    {
        const string raw="""{"rt":{"criticsScore":99},"imdb":{"criticsScore":9},"new_spoiler_field":"secret"}""";
        Assert.Equal("null",Policy().Project(raw,"details","movie:tmdb:42","ratingscombined","movie"));
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(raw),JsonNode.Parse(Policy(false).Project(raw,"details","movie:tmdb:42","ratingscombined","movie"))));
    }

    [Theory]
    [InlineData("translations", """{"id":42,"translations":[{"iso_639_1":"en","iso_3166_1":"US","name":"English","english_name":"English","data":{"title":"Entry","overview":"secret","tagline":"secret","runtime":90,"new_spoiler_field":"secret","unknown_envelope":{"overview":"secret"}}}]}""")]
    [InlineData("content_ratings", """{"id":42,"results":[{"iso_3166_1":"US","rating":"PG","new_spoiler_field":"secret","unknown_envelope":{"overview":"secret"}}]}""")]
    [InlineData("credits", """{"cast":[{"id":42,"name":"Person","new_spoiler_field":"secret","unknown_envelope":{"overview":"secret"}}]}""")]
    public void StandaloneResourcesEnforceNestedSchemaAtRuntime(string resource,string raw)
    {
        var projected=Policy(cast:false).Project(raw,"details","movie:tmdb:42",resource,"movie");
        Assert.DoesNotContain("secret",projected); Assert.DoesNotContain("new_spoiler_field",projected); Assert.DoesNotContain("unknown_envelope",projected);
        Assert.Contains("secret",Policy(false).Project(raw,"details","movie:tmdb:42",resource,"movie"));
    }

    public static IEnumerable<object[]> Fixtures()
    {
        yield return new object[] { "seerr movie ratingscombined", "ratingscombined", """{"rt":{"criticsScore":99,"audienceScore":90,"url":"https://example.com"},"imdb":{"criticsScore":9}}""" };
        yield return new object[] { "movie translations", "translations", """{"id":42,"translations":[{"iso_639_1":"en","name":"English","english_name":"English","data":{"title":"Entry","overview":"Plot","tagline":"Tagline","runtime":90}}]}""" };
        yield return new object[] { "movie MDBList ratings", "ratings", """{"found":true,"confirmed":true,"fetchedAtUnixMs":123,"ratings":[{"source":"imdb","value":9,"score":90,"votes":1,"url":"https://example.com","fresh":null}],"ids":{"imdb":"tt123","tmdb":"42"}}""" };
        yield return new object[] { "movie awards", "awards", """{"found":true,"confirmed":true,"wins":1,"nominations":2,"awards":[{"name":"Award","result":"Won","year":2020,"recipients":["Person"],"works":[]}]}""" };
        yield return new object[] { "mixed person search", "page", """{"results":[{"id":500,"mediaType":"person","name":"Person","known_for":[{"id":42,"media_type":"movie","title":"Work","overview":"Plot"}]}]}""" };
        yield return new object[] { "JE discover", "page", """{"results":[{"key":"movie:tmdb:42","title":"Entry","inLibrary":false,"jeSpoiler":{"guarded":false},"mineVariants":[{"edition":"4k","request":"pending"}]}],"groups":[{"key":"movie:tmdb:42","basedOn":"Entry","results":[{"key":"movie:tmdb:42"}]}]}""" };
        yield return new object[] { "JE requests hub", "page", """{"mine":[{"key":"movie:tmdb:42","status":{"stage":"looking","reason":{"code":"no_release_yet"},"summary":{"aired":2,"ready":1,"nextAir":"2020-01-01"},"progress":{"percent":25},"episodes":[{"key":"tv:tmdb:42:s1:e1","episode":1,"stage":"ready"}]}}],"soon":[],"ready":[]}""" };
        yield return new object[] { "JE season rows", "title", """{"series":"tv:tmdb:42","key":"tv:tmdb:42:s2","season":2,"displayMissing":true,"canRequest":true,"episodes":[{"episode":1,"title":"Episode","overview":"Plot","runtime":30,"request":"pending","still":"/still.jpg"}]}""" };
        using var stream=typeof(PrivacyProviderSchemaTests).Assembly.GetManifestResourceStream("JE.Tests.ProviderContracts.Public")!;
        using var reader=new StreamReader(stream);
        foreach(var sample in JsonNode.Parse(reader.ReadToEnd())!.AsArray())
            yield return new object[] { sample!["route"]!.ToString(), sample["schema"]!.ToString(), sample["body"]!.ToJsonString() };
        foreach(var shape in PrivacyProviderSchemaTests.Shapes)
            yield return new object[] { (string)shape[0], (string)shape[1], (string)shape[3] };
        using var nativeStream=typeof(PrivacyProviderSchemaTests).Assembly.GetManifestResourceStream("JE.Tests.ProviderContracts.Native")!;
        using var nativeReader=new StreamReader(nativeStream);
        foreach(System.Text.RegularExpressions.Match fixture in System.Text.RegularExpressions.Regex.Matches(nativeReader.ReadToEnd(),"private const string (\\w+Json) = \"\"\"(.*?)\"\"\";",System.Text.RegularExpressions.RegexOptions.Singleline))
            yield return new object[] { fixture.Groups[1].Value,fixture.Groups[1].Value switch { "PersonJson"=>"person","SeasonJson"=>"season","RecsJson"=>"page",_=>"title" },fixture.Groups[2].Value };
    }

    [Theory]
    [MemberData(nameof(Fixtures))]
    public void EveryFixtureShapeRejectsInjectedFieldsAndEnvelopesAtFinalGate(string name,string schema,string raw)
    {
        var input=JsonNode.Parse(raw)!;
        var state=new UserSpoilerBlur();
        void Inject(JsonNode node)
        {
            if(node is JsonArray rows) { foreach(var child in rows.Where(n=>n!=null).ToArray()) Inject(child!); return; }
            if(node is not JsonObject obj) return;
            foreach(var child in obj.Select(p=>p.Value).Where(n=>n is JsonObject or JsonArray).ToArray()) Inject(child!);
            if(obj["id"] is JsonValue id && int.TryParse(id.ToString(),out var n) && n>0)
                foreach(var kind in new[]{"tv","movie"}) state.ProviderTitles[$"{kind}:tmdb:{n}"]=new();
            obj["new_spoiler_field"]="injected-secret";obj["unknown_envelope"]=new JsonObject { ["overview"]="injected-secret" };
        }
        Inject(input);state.ProviderTitles["tv:tmdb:42"]=new();state.ProviderTitles["movie:tmdb:42"]=new();
        var kind=name.Contains("movie",StringComparison.OrdinalIgnoreCase)?"movie":"tv";
        var collection=name.Contains("/collection/",StringComparison.Ordinal) || name=="CollectionJson";
        string? title=schema is "person" or "page" || collection ? null : $"{kind}:tmdb:42";
        var resource=schema switch { "title"=>"title", "person"=>"person", "page"=>name.Contains("combined_credits")?"combined_credits":"recommendations", "calendar"=>"calendar", "season" or "episode"=>schema,_=>schema };
        if(collection) resource="collection";
        var node=schema=="calendar"?new JsonArray(input):input;
        var policy=new TitlePresentationPolicy(HiddenContentPolicy.Build(null),new SpoilerPresentationContext(state,new PluginConfiguration { SpoilerBlurEnabled=true }));
        var projected=policy.Project(node.ToJsonString(),"discovery",title,resource,kind,schema is "season" or "episode"?schema:null,8,6);
        // A standalone person has no title guard. Every title-owned nested schema is deny by default.
        var publicPeople = (input["results"] as JsonArray ?? input["parts"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().Count(o => (o["mediaType"] ?? o["media_type"])?.ToString() == "person");
        if(schema!="person") Assert.Equal(2*(publicPeople+(collection?1:0)), CountInjected(JsonNode.Parse(projected)!));
        else Assert.Contains("injected-secret",projected);
        var unguarded=policy with { Spoilers=Policy(false).Spoilers };
        var publicResult=unguarded.Project(node.ToJsonString(),"discovery",title,resource,kind,schema is "season" or "episode"?schema:null,8,6);
        Assert.Equal(CountInjected(node),CountInjected(JsonNode.Parse(publicResult)!));
        PreservesInput(node,JsonNode.Parse(publicResult),name);
    }

    private static void PreservesInput(JsonNode? before,JsonNode? after,string path)
    {
        if(before is JsonObject obj)
            foreach(var field in obj) { Assert.True(after is JsonObject target && target.ContainsKey(field.Key),path+"."+field.Key); PreservesInput(field.Value,after![field.Key],path+"."+field.Key); }
        else if(before is JsonArray rows)
        {
            var projected=Assert.IsType<JsonArray>(after);Assert.Equal(rows.Count,projected.Count);
            for(var i=0;i<rows.Count;i++) PreservesInput(rows[i],projected[i],path+"[]");
        }
        else Assert.True(JsonNode.DeepEquals(before,after),path);
    }

    [Fact]
    public void IndependentPublicSiblingKeepsUnknownFieldsUnderGuardedSeed()
    {
        const string raw="""{"recommendations":{"results":[{"id":42,"new_spoiler_field":"private","unknown_envelope":{"overview":"private"}},{"id":43,"new_spoiler_field":"public","unknown_envelope":{"overview":"public"}}]}}""";
        var result=JsonNode.Parse(Policy().Project(raw,"recommendations","movie:tmdb:42","title",kind:"movie"))!;
        var rows=result["recommendations"]!["results"]!;
        Assert.DoesNotContain("private",rows[0]!.ToJsonString());
        Assert.Equal("public",rows[1]!["unknown_envelope"]!["overview"]?.ToString());
    }

    private static int CountInjected(JsonNode node) => node switch {
        JsonObject obj => obj.Sum(p=>(p.Key is "new_spoiler_field" or "unknown_envelope"?1:0)+(p.Value==null?0:CountInjected(p.Value))),
        JsonArray arr => arr.Sum(n=>n==null?0:CountInjected(n)), _=>0 };

    [Fact]
    public void VideoRoleRemainsProtectedWhenSeriesDescriptionIsAllowed()
    {
        var policy=new TitlePresentationPolicy(HiddenContentPolicy.Build(null),new SpoilerPresentationContext(new UserSpoilerBlur { ProviderTitles=new() { ["tv:tmdb:42"]=new() } },
            new PluginConfiguration { SpoilerBlurEnabled=true,SpoilerStripOverview=true,SpoilerStripSeriesOverview=false }));
        const string raw="""{"results":[{"name":"secret","key":"secret","site":"YouTube"}]}""";
        Assert.DoesNotContain("secret",policy.Project(raw,"details","tv:tmdb:42","videos","tv"));
    }

    [Theory]
    [InlineData("/JellyfinEnhanced/jellyseerr/search")]
    [InlineData("/JellyfinEnhanced/tmdb/search/person")]
    [InlineData("/JellyfinEnhanced/tmdb/search/multi")]
    public void FinalSearchGateKeepsPeopleAndProjectsTheirKnownWorksByTitleRole(string path)
    {
        using var f=new ApiPluginFixture();var user=Guid.NewGuid();
        f.Plugin.Configuration.HiddenContentEnabled=true;f.Plugin.Configuration.SpoilerBlurEnabled=true;f.Plugin.Configuration.SpoilerStripOverview=true;
        f.Core.Manager.SaveUserConfiguration(user.ToString("N"),"hidden-content.json",new UserHiddenContent { Settings=new() { FilterSearch=true },Items=new() { ["tv:tmdb:42"]=new() { Type="Series",TmdbId="42" } } });
        f.Core.Manager.SaveUserConfiguration(user.ToString("N"),"spoilerblur.json",new UserSpoilerBlur { ProviderTitles=new() { ["movie:tmdb:42"]=new() } });
        var library=Mock.Of<ILibraryManager>();var service=new SpoilerPresentation(f.Core.Manager,library,Mock.Of<IUserManager>(),Mock.Of<IUserDataManager>());
        var http=new DefaultHttpContext();http.Request.Path=path;http.Request.Method="GET";http.User=JellyfinEnhanced.Tests.PrivacyPolicyTests.Principal(user);
        const string raw="""{"results":[{"id":42,"mediaType":"person","name":"Person","new_spoiler_field":"public-person","knownFor":[{"id":42,"mediaType":"movie","overview":"secret"},{"id":42,"mediaType":"tv","overview":"hidden"},{"id":43,"mediaType":"movie","overview":"public"}]},{"id":42,"mediaType":"movie","overview":"secret"}]}""";
        var action=EndpointRouting.Bind(http);
        var result=new Microsoft.AspNetCore.Mvc.Filters.ResultExecutingContext(action,new List<Microsoft.AspNetCore.Mvc.Filters.IFilterMetadata>(),new ContentResult { Content=raw,ContentType="application/json" },new object());
        new TitlePresentationResultFilter(f.Core.Manager,service,library,Mock.Of<MediaBrowser.Controller.IServerApplicationHost>(),null!).OnResultExecuting(result);
        var body=Assert.IsType<ContentResult>(result.Result).Content!;var rows=JsonNode.Parse(body)!["results"]!.AsArray();
        Assert.Equal(2,rows.Count);Assert.Equal("Person",rows[0]!["name"]?.ToString());
        Assert.Equal("public-person",rows[0]!["new_spoiler_field"]?.ToString());
        Assert.Equal(2,rows[0]!["knownFor"]!.AsArray().Count);Assert.DoesNotContain("secret",body);Assert.DoesNotContain("hidden",body);
        Assert.Equal("public",rows[0]!["knownFor"]![1]!["overview"]?.ToString());
    }

    [Theory]
    [InlineData("99")][InlineData("[99]")][InlineData("\"score\"")][InlineData("true")]
    public void RatingsRoleSuppressesEveryJsonValueShape(string raw)
    {
        Assert.Equal("null",Policy().Project(raw,"details","movie:tmdb:42","ratingscombined","movie"));
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(raw),JsonNode.Parse(Policy(false).Project(raw,"details","movie:tmdb:42","ratingscombined","movie"))));
    }

    [Fact]
    public void GuardedPageRowsProtectUnknownEnvelopeFieldsWithoutGuardingPublicSiblings()
    {
        const string raw="""{"new_spoiler_field":"secret","unknown_envelope":{"overview":"secret"},"results":[{"id":42,"new_spoiler_field":"secret"},{"id":43,"new_spoiler_field":"public","unknown_envelope":{"overview":"public"}}]}""";
        var result=JsonNode.Parse(Policy().Project(raw,"recommendations",title:null,resource:"recommendations",kind:"movie"))!;
        Assert.Null(result["new_spoiler_field"]);Assert.Null(result["unknown_envelope"]);
        Assert.Null(result["results"]![0]!["new_spoiler_field"]);
        Assert.Equal("public",result["results"]![1]!["unknown_envelope"]?["overview"]?.ToString());
        Assert.Contains("secret",Policy(false).Project(raw,"recommendations",title:null,resource:"recommendations",kind:"movie"));
    }

    [Fact]
    public void TypedResourceOwnerCannotBeReclassifiedAsPersonByPayloadDiscriminator()
    {
        const string raw="""{"id":42,"mediaType":"person","overview":"secret","new_spoiler_field":"secret"}""";
        Assert.DoesNotContain("secret",Policy().Project(raw,"details","movie:tmdb:42","title",kind:"movie"));
        Assert.Contains("secret",Policy(false).Project(raw,"details","movie:tmdb:42","title",kind:"movie"));
    }

    [Fact]
    public void DisabledMasterKeepsTypedProducerFlagsAndRawProjectCompatibility()
    {
        var policy=new SpoilerPresentationContext(new UserSpoilerBlur(),new PluginConfiguration { SpoilerBlurEnabled=false });
        Assert.False(policy.Flags("movie:tmdb:42")["guarded"]!.GetValue<bool>());
        var card=JsonNode.Parse("""{"new_spoiler_field":"public"}""")!.AsObject();
        policy.ProjectTitle(card,"movie:tmdb:42","movie");
        Assert.False(card["jeSpoiler"]!["guarded"]!.GetValue<bool>());
        Assert.Equal("public",card["new_spoiler_field"]?.ToString());
        const string raw="""{ "new_spoiler_field": "public" }""";
        Assert.Equal(raw,policy.ProjectResource(raw,"movie:tmdb:42","title"));
    }

    [Fact]
    public void UnknownFlagExtensionsSurviveOnlyWhenUnguarded()
    {
        const string raw="""{"jeSpoiler":{"guarded":true,"new_spoiler_field":"extension","unknown_envelope":{"value":"extension"}}}""";
        var publicResult=JsonNode.Parse(Policy(false).Project(raw,"details","movie:tmdb:42","title"))!;
        Assert.Equal("extension",publicResult["jeSpoiler"]?["new_spoiler_field"]?.ToString());
        Assert.Equal("extension",publicResult["jeSpoiler"]?["unknown_envelope"]?["value"]?.ToString());
        Assert.False(publicResult["jeSpoiler"]!["guarded"]!.GetValue<bool>());
        Assert.DoesNotContain("extension",Policy().Project(raw,"details","movie:tmdb:42","title"));
    }

    [Fact]
    public void UnknownEnvelopeCannotBeStringifiedIntoSafeCertification()
    {
        const string raw="""{"releases":{"results":[{"iso_3166_1":"US","release_dates":[{"certification":{"new_spoiler_field":"secret"}}]}]}}""";
        Assert.DoesNotContain("secret",Policy().Project(raw,"details","movie:tmdb:42","title"));
        Assert.Contains("secret",Policy(false).Project(raw,"details","movie:tmdb:42","title"));
    }

    [Fact]
    public void TranslatedEpisodeNamesUseEpisodeRoleWhileMovieNamesRemainSafe()
    {
        const string raw="""{"translations":[{"data":{"title":"secret","name":"secret","overview":"secret"}}]}""";
        Assert.DoesNotContain("secret",Policy().Project(raw,"details","tv:tmdb:42","translations","tv","episode",2,3));
        var movie=JsonNode.Parse(Policy().Project(raw,"details","movie:tmdb:42","translations","movie"))!;
        Assert.Equal("secret",movie["translations"]![0]!["data"]!["title"]?.ToString());
    }

    [Fact]
    public void GuardedJeRequestCardPreservesDeclaredStatusAndRequestControls()
    {
        const string raw = """{"items":[{"key":"movie:tmdb:42","title":"Entry","canCancel":true,"cancelIds":["request1"],"status":{"stage":"looking","reason":{"code":"no_release_yet"},"progress":{"percent":25,"etaSeconds":60},"actions":["search"],"nextDate":"secret"},"new_spoiler_field":"secret"}]}""";
        var result=JsonNode.Parse(Policy().Project(raw,"requests",null,"page"))!["items"]![0]!;
        Assert.Equal("looking",result["status"]?["stage"]?.ToString());
        Assert.Equal("no_release_yet",result["status"]?["reason"]?["code"]?.ToString());
        Assert.Equal(25,result["status"]?["progress"]?["percent"]?.GetValue<int>());
        Assert.True(result["canCancel"]?.GetValue<bool>()); Assert.NotNull(result["cancelIds"]);
        Assert.DoesNotContain("secret",result.ToJsonString());
    }

    [Theory]
    [InlineData("inbox", """{"items":[{"id":1,"key":"movie:tmdb:42","itemId":"library","link":"/title","kind":"ready","read":false,"params":{"title":"secret","year":"2020","count":"2","new_spoiler_field":"secret"},"new_spoiler_field":"secret","unknown_envelope":{"overview":"secret"}}]}""")]
    [InlineData("activity-row", """{"userId":"viewer","userName":"Name","activityType":"Reviewed","item":{"id":"library","name":"Entry","type":"Movie","new_spoiler_field":"secret"},"rating":9,"content":"secret","new_spoiler_field":"secret"}""")]
    [InlineData("user-reviews", """{"reviews":[{"userId":"viewer","userName":"Name","content":"secret","rating":9,"new_spoiler_field":"secret"}],"new_spoiler_field":"secret"}""")]
    [InlineData("review-ratings", """{"ratings":{"movie:42":{"average":9,"count":1,"new_spoiler_field":"secret"}}}""")]
    public void JeResourceAdaptersEnforceRuntimeDispositions(string resource,string raw)
    {
        var result=Policy().Project(raw,"requests",resource=="inbox" || resource=="review-ratings" ? null : "movie:tmdb:42",resource);
        Assert.DoesNotContain("secret",result);
        Assert.Contains("secret",Policy(false).Project(raw,"requests",resource=="inbox" || resource=="review-ratings" ? null : "movie:tmdb:42",resource));
    }

    [Theory]
    [InlineData("tv/42/new_resource")]
    [InlineData("discover/person")]
    [InlineData("discover/company")]
    public async Task UnsupportedStandaloneResourceReturns400BeforeUpstream(string path)
    {
        using var f=new ApiPluginFixture(); f.Plugin.Configuration.TMDB_API_KEY="test";
        using var transport=new IntegrationTransport((_,_)=>Task.FromResult(IntegrationTransport.Response("{}")));
        using var cache=new TmdbResponseCache(transport,TimeProvider.System);
        var parental=new SeerrParentalFilter(transport,Mock.Of<IUserManager>(),Mock.Of<ILocalizationManager>(),Mock.Of<IServerConfigurationManager>(),f.Core.Logger);
        var c=ApiAssetTests.Controller(f.Core,cache,parental);c.HttpContext.User=JellyfinEnhanced.Tests.PrivacyPolicyTests.Principal(Guid.NewGuid());
        var result=await c.ProxyTmdbRequest(path);
        Assert.Equal(400,Assert.IsAssignableFrom<ObjectResult>(result).StatusCode);Assert.Equal(0,transport.Calls);
    }
}
