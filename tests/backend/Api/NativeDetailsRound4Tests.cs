#if JF12
// Partial of ApiNativeDetailsTests, whose rig and the native-details pages it drives are Jellyfin 12 only (the plugin
// compiles them under JF12), like the rest of that class.
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;
public partial class ApiNativeDetailsTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Round4EightyColdImagesAreBoundedBeforeTaskRetentionAndRecover(bool admin)
    {
        await using var rig = new AdmissionRig();
        var viewer = rig.Rig.Person(admin: admin, linked: false);
        if (!admin) viewer.MaxParentalRatingScore = 16;
        rig.Hold = false;
        var page = SyntheticId.Movie(693134);
        await rig.Read(viewer.Id, page);
        rig.Rig.ImageGate = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var sends = 0;
        using var observer = MetadataTaskProbe.Observe(e => { if (e.Kind == "transport") Interlocked.Increment(ref sends); });
        Task<Run> Read(int i)
        {
            var tag = rig.Rig.Artwork.Mint(Id(page), ImageType.Primary, 0, "/fixture" + i + ".jpg", viewer.Id, rig.Rig.Policy.Revision(viewer));
            return Call(rig.Rig, "Image", "GetItemImage", null, new() { ["itemId"] = Id(page), ["imageType"] = ImageType.Primary, ["tag"] = tag, ["maxWidth"] = 300 });
        }
        var reads = Enumerable.Range(1, 80).Select(Read).ToArray();
        try
        {
            Assert.Equal(8, rig.Rig.Artwork.InFlightCount);
            Assert.Equal(8, sends);
            Assert.Equal(0, rig.Admission.Count());
            Assert.Equal(72, reads.Count(r => r.IsCompletedSuccessfully && Status(r.Result.Result) == 404));
        }
        finally { rig.Rig.ImageGate.TrySetResult(); await Task.WhenAll(reads).WaitAsync(TimeSpan.FromSeconds(20)); }
        Assert.Equal(8, reads.Count(r => Status(r.Result.Result) == 200));
        Assert.Equal(0, rig.Rig.Artwork.InFlightCount);
        Assert.Equal(200, Status((await Read(80)).Result));
        Assert.Contains("image.tmdb.org", rig.Rig.Hosts);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Round4ImageAndMetadataBurstsHaveIndependentTransportOwners(bool imagesFirst)
    {
        await using var rig = new AdmissionRig();
        var viewer = rig.Rig.Person(linked: false);
        rig.Hold = false;
        var page = SyntheticId.Movie(693134);
        await rig.Read(viewer.Id, page);
        rig.Hold = true;
        rig.Rig.ImageGate = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var imageSends = 0;
        using var observer = MetadataTaskProbe.Observe(e => { if (e.Kind == "transport" && e.Owner is MetadataAdmission a && a.Owner.StartsWith("image:")) Interlocked.Increment(ref imageSends); });
        var metadata = Enumerable.Range(1, 8).Select(i => rig.Read(viewer.Id, SyntheticId.Movie(694000+i))).ToArray();
        var images = Enumerable.Range(1, 8).Select(i =>
        {
            var tag = rig.Rig.Artwork.Mint(Id(page), ImageType.Primary, 0, "/independent"+i+".jpg", viewer.Id, rig.Rig.Policy.Revision(viewer));
            return Call(rig.Rig, "Image", "GetItemImage", null, new() { ["itemId"] = Id(page), ["imageType"] = ImageType.Primary, ["tag"] = tag });
        }).ToArray();
        try
        {
            Assert.Equal(8, rig.Admission.Count());
            Assert.Equal(8, rig.Rig.Artwork.InFlightCount);
            Assert.Equal(8, imageSends);
            if (imagesFirst)
            {
                rig.Rig.ImageGate.TrySetResult();
                await Task.WhenAll(images).WaitAsync(TimeSpan.FromSeconds(5));
                Assert.All(images, r => Assert.Equal(200, Status(r.Result.Result)));
                Assert.All(metadata, r => Assert.False(r.IsCompleted));
            }
            else
            {
                rig.Release();
                await Task.WhenAll(metadata).WaitAsync(TimeSpan.FromSeconds(5));
                Assert.All(metadata, r => Assert.Equal(AbsentLookup.Found, r.Result.Outcome));
                Assert.All(images, r => Assert.False(r.IsCompleted));
            }
        }
        finally { rig.Release(); rig.Rig.ImageGate.TrySetResult(); await Task.WhenAll(metadata.Cast<Task>().Concat(images)).WaitAsync(TimeSpan.FromSeconds(20)); }
    }

    [Fact]
    public async Task Round4DiscoveryRefusesUnknownEvidenceAndSameQueryRecoversAfterDrain()
    {
        using var ledger = new IntegrationRequestLedgerTests.Rig();
        await using var rig = new AdmissionRig();
        var person = rig.Rig.Person(linked: false);
        person.MaxParentalRatingScore = 16;
        var viewer = new StatusViewer { UserId = person.Id, Handle = person, PolicyRevision = "r4", HasParentalLimit = true };
        ledger.View.Users[person.Id] = viewer;
        ledger.Policy.People[person.Id] = ledger.Policy.People[ledger.Member] with { UserId = person.Id };
        var gate = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var held = Enumerable.Range(1, 8).Select(i => rig.Admission.Read("r4-held:" + i, person.Id, () => (false, false), () => gate.Task, false, default)).ToArray();
        var body = IntegrationRequestDiscoverTests.Page(IntegrationRequestDiscoverTests.Movie(960100, "Allowed movie"));
        var service = new DiscoverService(ledger.Service, null, DiscoverService.ParentalCheck(rig.Rig.Parental),
            (_, _, _) => Task.FromResult<string?>(body), (_, _) => Array.Empty<RecentTitle>(), _ => HiddenTitles.None, () => DateTimeOffset.UtcNow);
        var controller = new AcquireDiscoverController(service) { ControllerContext = new() { HttpContext = new DefaultHttpContext { User = TestCallers.Principal(person.Id, false) } } };
        IActionResult? first = null;
        try { first = await controller.Search("capacity").WaitAsync(TimeSpan.FromSeconds(5)); }
        finally { gate.TrySetResult(true); rig.Release(); await Task.WhenAll(held).WaitAsync(TimeSpan.FromSeconds(20)); }
        var retry = await service.SearchAsync(viewer, "capacity", 1, null, default).WaitAsync(TimeSpan.FromSeconds(5));
        Assert.NotNull(retry);
        Assert.Single(retry.Results);
        var refused = Assert.IsType<ObjectResult>(first);
        Assert.Equal(503, refused.StatusCode);
        Assert.Equal("1", controller.Response.Headers["Retry-After"]);
        Assert.Equal("metadata_busy", Assert.IsType<RequestOutcome>(refused.Value).Reason);
    }

    [Theory]
    [InlineData("proxy-company")]
    [InlineData("discover-search")]
    public async Task Round4NinthColdProxyAndSearchRequestsHaveTypedRetryContract(string route)
    {
        using var ledger = new IntegrationRequestLedgerTests.Rig();
        await using var rig = new AdmissionRig();
        var viewer = rig.Rig.Person(linked: false);
        var discover = new DiscoverService(ledger.Service, null!, rig.Rig.Parental, rig.Cache, Mock.Of<ILibraryManager>(), rig.Rig.Plugin.Core.Manager);
        var controllers = new List<ControllerBase>();
        Task<IActionResult> Read(int i)
        {
            if (route == "proxy-company")
            {
                var c = ApiAssetTests.Controller(rig.Rig.Plugin.Core, rig.Cache, rig.Rig.Parental, rig.Rig.Plugin.Core.Manager, Mock.Of<ILibraryManager>());
                c.HttpContext.User = Me(viewer);
                c.Request.QueryString = new QueryString("?query=Round4Company" + i);
                controllers.Add(c);
                return c.ProxyTmdbRequest("search/company");
            }
            var controller = new AcquireDiscoverController(discover) { ControllerContext = new() { HttpContext = new DefaultHttpContext { User = TestCallers.Principal(ledger.Member, false) } } };
            controllers.Add(controller);
            return controller.Search("Round4Title"+i);
        }
        var held = Enumerable.Range(1, 8).Select(Read).ToArray();
        try
        {
            var refused = Assert.IsType<ObjectResult>(await Read(9).WaitAsync(TimeSpan.FromSeconds(5)));
            Assert.Equal(503, refused.StatusCode);
            Assert.Equal("1", controllers.Last().Response.Headers["Retry-After"]);
            var body = Assert.IsType<RequestOutcome>(refused.Value);
            Assert.Equal("unavailable", body.Outcome);
            Assert.Equal("metadata_busy", body.Reason);
            Assert.Equal("Failed", body.Certainty.ToString());
            Assert.False(string.IsNullOrWhiteSpace(body.Message));
            Assert.Equal(8, rig.Admission.Count());
        }
        finally { rig.Release(); await Task.WhenAll(held).WaitAsync(TimeSpan.FromSeconds(20)); }
    }
}
#endif
