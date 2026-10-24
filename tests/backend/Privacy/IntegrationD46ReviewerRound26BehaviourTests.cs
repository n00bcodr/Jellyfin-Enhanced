using System.Diagnostics;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Model.Entities;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class IntegrationD46ReviewerRound26BehaviourTests(Xunit.Abstractions.ITestOutputHelper output)
{
    [Theory]
    [InlineData(1000)]
    [InlineData(10000)]
    public void HiddenPolicyTiming(int count)
    {
        using var f = new CoreFixture();
        var user = Guid.NewGuid().ToString("N");
        var state = new UserHiddenContent();
        for(var i=0;i<count;i++) {var id=Guid.NewGuid().ToString("N");state.Items[id]=new HiddenContentItem {ItemId=id,Type="Movie",HideScope="global"};}
        f.Manager.SaveUserConfiguration(user,"hidden-content.json",state);
        using var scope=PrivacyReadSet.Begin();
        f.Manager.RecordPolicyRead(user,"hidden-content.json",state);
        Assert.True(scope.Reads.Valid());
        var allocation=GC.GetAllocatedBytesForCurrentThread();
        var timer=Stopwatch.StartNew();
        const int n=20;
        for(var i=0;i<n;i++) Assert.True(scope.Reads.Valid());
        timer.Stop();
        Assert.Equal(1, f.Manager.PolicyNormalizations);
        output.WriteLine($"HC rules={count}; per-check ms={timer.Elapsed.TotalMilliseconds/n:F3}; allocation bytes={(GC.GetAllocatedBytesForCurrentThread()-allocation)/n}");
        if (count == 10000) Assert.True(timer.Elapsed.TotalMilliseconds/n < 5, $"Complete unchanged policy check exceeded budget: {timer.Elapsed.TotalMilliseconds/n:F3}ms");
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void LargeItemCheckCost(bool direct)
    {
        const int count = 10000;
        var items = Enumerable.Range(0,count).Select(_ => new MediaBrowser.Controller.Entities.TV.Episode {Id=Guid.NewGuid(),SeriesId=Guid.Empty}).ToDictionary(x=>x.Id);
        var lib = new Moq.Mock<MediaBrowser.Controller.Library.ILibraryManager>();
        lib.Setup(l=>l.GetItemList(Moq.It.IsAny<MediaBrowser.Controller.Entities.InternalItemsQuery>())).Returns((MediaBrowser.Controller.Entities.InternalItemsQuery q) => q.ItemIds.Select(id=>(MediaBrowser.Controller.Entities.BaseItem)items[id]).ToList());
        lib.Setup(l=>l.GetItemById(Moq.It.IsAny<Guid>())).Returns((Guid id)=>items[id]);
        if(direct) lib.As<IPrivacyItemMemory>().Setup(l=>l.Peek(Moq.It.IsAny<Guid>())).Returns((Guid id)=>items[id]);
        using var scope=PrivacyReadSet.Begin();
        PrivacyReads.Items(lib.Object,items.Keys);
        var timer=Stopwatch.StartNew();
        for(var i=0;i<3;i++) Assert.True(scope.Reads.Valid(),scope.Reads.Failure);
        timer.Stop();
        var lookups=lib.Invocations.Count(i=>i.Method.Name=="GetItemById");
        output.WriteLine($"items={count}; direct={direct}; 3-check ms={timer.Elapsed.TotalMilliseconds:F2}; library lookups incl observation={lookups}");
        Assert.Equal(direct ? 0 : 4*count,lookups);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1000)]
    [InlineData(10000)]
    public async Task UnguardedImageTimingWithRules(int count)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var state=new UserSpoilerBlur();
        for(var i=0;i<count;i++) state.Series[Guid.NewGuid().ToString("N")]=new();
        rig.F.Core.Manager.SaveUserConfiguration(rig.Viewer.ToString("N"), "spoilerblur.json",state);
        var ep=rig.Items.Values.OfType<MediaBrowser.Controller.Entities.TV.Episode>().First();
        for(var i=0;i<2;i++) {var warm=await PrivacyReviewRound25Tests.Image(rig,ep.Id,user:rig.Viewer); await PrivacyReviewRound25Tests.Write(warm);warm.Bytes.Dispose();}
        var timer=Stopwatch.StartNew();
        const int n=10;
        for(var i=0;i<n;i++) {var a=await PrivacyReviewRound25Tests.Image(rig,ep.Id,user:rig.Viewer);await PrivacyReviewRound25Tests.Write(a);Assert.Equal(200,a.Http.Response.StatusCode);a.Bytes.Dispose();}
        output.WriteLine($"unprotected image; unrelated rules={count}; complete request ms={timer.Elapsed.TotalMilliseconds/n:F2}");
    }

    [Fact]
    public async Task ProviderGuardedMovieHasSameRatingOnAllTagPaths()
    {
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: false, stripTags: false,
            edit: entries => { var e = entries.Values.First(x => x.Type == "Movie"); e.TmdbId = "1234"; e.CommunityRating = 7.5f; });
        var item = site.Items[site.Movie];
        item.SetProviderId(MetadataProvider.Tmdb, "1234");
        item.CommunityRating = 7.5f;
        site.State.ProviderTitles["movie:tmdb:1234"] = new();
        site.Fixture.Core.Manager.SaveUserConfiguration(site.Alice.Id.ToString("N"), "spoilerblur.json", site.State);
        SpoilerUserResolver.InvalidateUser(site.Alice.Id.ToString("N"));
        using var direct = JsonDocument.Parse(site.TagData(site.Movie));
        using var bulk = JsonDocument.Parse(await site.TagCache());
        static float? Score(JsonElement e) => e.TryGetProperty("CommunityRating", out var s) && s.ValueKind != JsonValueKind.Null ? s.GetSingle() : null;
        var policy = SpoilerTagDataStripper.CreatePolicy(site.Fixture.Plugin.Configuration, site.State)!;
        var native = site.Stripper.StripEntry(policy, site.Alice, item, new TagCacheEntry { Type = "Movie", TmdbId = "1234", CommunityRating = 7.5f }, out var stripped);
        var d = Score(direct.RootElement.GetProperty("Items")[0]);
        var b = Score(bulk.RootElement.GetProperty("items").GetProperty(site.Movie.ToString("N")));
        output.WriteLine($"POST={d?.ToString() ?? "null"}; GET={b?.ToString() ?? "null"}; native={native.CommunityRating}; stripped={stripped}");
        Assert.Equal(new float?[] { null, null, null }, new float?[] { d, b, native.CommunityRating });
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1000)]
    [InlineData(10000)]
    public void PolicyReadTiming(int count)
    {
        using var f = new CoreFixture();
        var user = Guid.NewGuid().ToString("N");
        var state = new UserSpoilerBlur();
        for (var i = 0; i < count; i++) state.Series[Guid.NewGuid().ToString("N")] = new();
        f.Manager.SaveUserConfiguration(user, "spoilerblur.json", state);
        using var scope = PrivacyReadSet.Begin();
        f.Manager.RecordPolicyRead(user, "spoilerblur.json", state);
        Assert.True(scope.Reads.Valid());
        var allocated = GC.GetAllocatedBytesForCurrentThread();
        var timer = Stopwatch.StartNew();
        const int n = 20;
        for (var i = 0; i < n; i++) Assert.True(scope.Reads.Valid());
        timer.Stop();
        Assert.Equal(1, f.Manager.PolicyNormalizations);
        if (count == 10000) Assert.True(timer.Elapsed.TotalMilliseconds/n < 5, $"Complete unchanged policy check exceeded budget: {timer.Elapsed.TotalMilliseconds/n:F3}ms");
        output.WriteLine($"rules={count}; per-check ms={timer.Elapsed.TotalMilliseconds/n:F3}; allocation bytes={(GC.GetAllocatedBytesForCurrentThread()-allocated)/n}");
    }
}
