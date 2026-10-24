using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Microsoft.AspNetCore.Mvc;
using Xunit;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class PrivacyTitleFeedTests
{
    [Theory]
    [InlineData("results")]
    [InlineData("cast")]
    [InlineData("crew")]
    [InlineData("parts")]
    [InlineData("requests")]
    [InlineData("items")]
    [InlineData("events")]
    [InlineData("mine")]
    [InlineData("soon")]
    [InlineData("ready")]
    public void KnownFeedShapesUseTypedIdentityAndPreserveUpstreamPagination(string field)
    {
        var policy = HiddenContentPolicy.Build(new UserHiddenContent { Items = new() {
            ["movie:tmdb:42"] = new() { Type = "Movie", TmdbId = "42" }
        }});
        var raw = new JsonObject { ["totalPages"] = 12, [field] = new JsonArray(
            new JsonObject { ["id"] = 42, ["mediaType"] = "movie", ["title"] = "secret" },
            new JsonObject { ["id"] = 42, ["mediaType"] = "tv", ["name"] = "allowed" }) }.ToJsonString();
        var projected = JsonNode.Parse(TitleFeedProjection.Hidden(raw, policy, "discovery", null, "page"))!;
        Assert.Equal("allowed", projected[field]![0]!["name"]!.ToString());
        Assert.Single((JsonArray)projected[field]!);
        Assert.Equal(12, projected["totalPages"]!.GetValue<int>());
        Assert.Contains("secret", raw);
        Assert.DoesNotContain("secret", projected.ToJsonString());
        Assert.Equal(raw, TitleFeedProjection.Hidden(raw, policy, "search", null, "page"));
        Assert.Equal(raw, TitleFeedProjection.Hidden(raw, HiddenContentPolicy.Build(null), "discovery", null, "page"));
    }

    [Fact]
    public void RequestDatabaseIdDoesNotMasqueradeAsTitleAndHiddenSeedHeadingIsRemoved()
    {
        var policy = HiddenContentPolicy.Build(new UserHiddenContent { Items = new() {
            ["tv:tmdb:42"] = new() { Type = "Series", TmdbId = "42" }
        }});
        var raw = """{"results":[{"id":42,"media":{"tmdbId":50,"mediaType":"tv"}},{"id":50,"media":{"tmdbId":42,"mediaType":"tv"}}],"groups":[{"key":"tv:tmdb:42","basedOn":"secret","results":[{"id":50,"mediaType":"tv"}]}]}""";
        var answer = JsonNode.Parse(TitleFeedProjection.Hidden(raw, policy, "requests", null, "page"))!;
        Assert.Equal(42, answer["results"]![0]!["id"]!.GetValue<int>());
        Assert.Single((JsonArray)answer["results"]!);
        Assert.Empty((JsonArray)answer["groups"]!);
    }

    [Fact]
    public void AtomicProviderWritesPreserveUnrelatedRulesAndRemoveLegacyAliases()
    {
        using var f = new ApiPluginFixture();
        var user = Guid.NewGuid();
        var users = new Moq.Mock<MediaBrowser.Controller.Library.IUserManager>();
        var person = new Jellyfin.Database.Implementations.Entities.User("viewer", "default", "default") { Id = user };
        users.Setup(u => u.GetUserById(user)).Returns(person);
        var c = ApiAssetTests.Controller(f.Core, f.Core.Manager, users.Object);
        c.HttpContext.User = JellyfinEnhanced.Tests.PrivacyPolicyTests.Principal(user);
        var data = new UserHiddenContent();
        data.Items["old"] = new() { TmdbId = "42", Type = "Movie", HiddenAt = "2020-01-01" };
        data.Items["tv:tmdb:42"] = new() { TmdbId = "42", Type = "Series" };
        f.Core.Manager.SaveUserConfiguration(user.ToString("N"), "hidden-content.json", data);
        Assert.IsType<OkObjectResult>(c.PutHiddenContentRule(user.ToString("N"), "movie:tmdb:42", new() { Type = "Movie", TmdbId = "42" }));
        var saved = f.Core.Manager.GetUserConfiguration<UserHiddenContent>(user.ToString("N"), "hidden-content.json");
        Assert.Equal(2, saved.Items.Count); Assert.Equal("2020-01-01", saved.Items["movie:tmdb:42"].HiddenAt);
        Assert.IsType<OkObjectResult>(c.DeleteHiddenContentRule(user.ToString("N"), "movie:tmdb:42"));
        Assert.Single(f.Core.Manager.GetUserConfiguration<UserHiddenContent>(user.ToString("N"), "hidden-content.json").Items);
        Assert.IsType<BadRequestObjectResult>(c.PutHiddenContentRule(user.ToString("N"), "movie:tmdb:42", new() { Type = "Movie", TmdbId = "42", ItemId = "4a45ad11000a938e00000000f9c67720" }));
        Assert.IsType<BadRequestObjectResult>(c.DeleteHiddenContentRule(user.ToString("N"), "tv:tmdb:2147483648"));
    }
    [Fact]
    public void ProviderBindingCoversMoreThanOneBatchWithoutPerCardQueries()
    {
        var ids=Enumerable.Range(0,2001).Select(_=>Guid.NewGuid()).ToArray();
        var library=new Moq.Mock<MediaBrowser.Controller.Library.ILibraryManager>();
        // The host's item cache (read without a lookup) holds none of them.
        library.As<IPrivacyItemMemory>();
        library.Setup(l=>l.GetItemList(Moq.It.IsAny<MediaBrowser.Controller.Entities.InternalItemsQuery>()))
            .Returns((MediaBrowser.Controller.Entities.InternalItemsQuery q)=>q.ItemIds.Select(id=>(MediaBrowser.Controller.Entities.BaseItem)new MediaBrowser.Controller.Entities.Movies.Movie { Id=id,ProviderIds=new Dictionary<string,string> { ["Tmdb"]="42" } }).ToList());
        var policy=HiddenContentPolicy.Build(new UserHiddenContent { Items=new() { ["movie:tmdb:42"]=new() { Type="Movie",TmdbId="42" } } });
        policy.BindLibraryIds(library.Object,ids);
        Assert.True(policy.IsHidden(null,ids[^1].ToString("N"),null,"library"));
        var lookups=library.Invocations.Where(call=>call.Method.DeclaringType==typeof(MediaBrowser.Controller.Library.ILibraryManager)).ToList();
        Assert.Equal(2,lookups.Count);
        Assert.All(lookups,call=>Assert.True(((MediaBrowser.Controller.Entities.InternalItemsQuery)call.Arguments[0]).ItemIds.Length<=2000));
    }

}
