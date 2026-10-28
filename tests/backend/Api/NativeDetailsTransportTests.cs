#if JF12
// Partial of ApiNativeDetailsTests, whose rig and the native-details pages it drives are Jellyfin 12 only (the plugin
// compiles them under JF12), like the rest of that class.
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

public partial class ApiNativeDetailsTests
{
    [Fact]
    public async Task TmdbAdmissionDiscoverEvidenceRetainsEachEffectiveViewer()
    {
        await using var rig = new AdmissionRig();
        var people = Enumerable.Range(0, 2).Select(_ => rig.Rig.Person(linked: false)).ToArray();
        foreach (var person in people) person.MaxParentalRatingScore = 16;
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        rig.Rig.RatingGate = gate;
        var audit = new MetadataAudit();
        using var observation = MetadataTaskProbe.Observe(audit.Observe);
        var check = DiscoverService.ParentalCheck(rig.Rig.Parental);
        var reads = people.SelectMany((person, v) => Enumerable.Range(0, 8).Select(i => check("movie", 910000 + 100 * v + i,
            new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.StatusViewer { UserId = person.Id, Handle = person, HasParentalLimit = true }, CancellationToken.None))).ToArray();
        var message = $"admitted={rig.Admission.Count()}; anonymous={audit.Peak.GetValueOrDefault(Guid.Empty)}; first={audit.Peak.GetValueOrDefault(people[0].Id)}; second={audit.Peak.GetValueOrDefault(people[1].Id)}; secondCompleted={reads.Skip(8).Count(t => t.IsCompleted)}";
        try { Assert.True(audit.Peak.GetValueOrDefault(people[1].Id) == 8, message); }
        finally
        {
            gate.TrySetResult();
            rig.Release();
            await Task.WhenAll(reads).WaitAsync(TimeSpan.FromSeconds(20));
        }
        audit.AssertSound();
    }

    [Theory]
    [InlineData("proxy-company")]
    [InlineData("discover-search")]
    public async Task TmdbAdmissionActualProxyAndSearchBoundEightyColdTasks(string route)
    {
        using var ledger = new IntegrationRequestLedgerTests.Rig();
        await using var rig = new AdmissionRig();
        var viewer = rig.Rig.Person(linked: false);
        var audit = new MetadataAudit();
        using var observation = MetadataTaskProbe.Observe(audit.Observe);
        var discover = new DiscoverService(ledger.Service, null!, rig.Rig.Parental, rig.Cache,
            Mock.Of<ILibraryManager>(), rig.Rig.Plugin.Core.Manager);
        Task<IActionResult> Read(int i)
        {
            if (route == "proxy-company")
            {
                var c = ApiAssetTests.Controller(rig.Rig.Plugin.Core, rig.Cache, rig.Rig.Parental,
                    rig.Rig.Plugin.Core.Manager, Mock.Of<ILibraryManager>());
                c.HttpContext.User = Me(viewer);
                c.Request.QueryString = new QueryString("?query=Company" + i);
                return c.ProxyTmdbRequest("search/company");
            }
            var controller = new AcquireDiscoverController(discover)
            {
                ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext
                { User = TestCallers.Principal(ledger.Member, false) } },
            };
            return controller.Search("Title" + i);
        }
        var reads = Enumerable.Range(1, 80).Select(Read).ToArray();
        var raw = (System.Collections.IDictionary)typeof(TmdbResponseCache)
            .GetField("_inFlight", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.GetValue(rig.Cache)!;
        var count = raw.Count;
        var message = $"route={route}; raw={count}; admitted={rig.Admission.Count()}; external={audit.ExternalCreations}; unowned={audit.Violations.Count}; completed={reads.Count(t => t.IsCompleted)}";
        try
        {
            Assert.True(count <= 8, message);
            Assert.Equal(8, rig.Admission.Count());
            Assert.Equal(72, reads.Count(t => t.IsCompletedSuccessfully));
            Assert.Empty(audit.Violations);
        }
        finally
        {
            rig.Release();
            await Task.WhenAll(reads).WaitAsync(TimeSpan.FromSeconds(20));
        }
        audit.AssertSound();
    }

    [Fact]
    public async Task TmdbAdmissionListAccessCarriesBothEffectiveViewers()
    {
        await using var rig = new AdmissionRig();
        var people = Enumerable.Range(0, 2).Select(_ => rig.Rig.Person(linked: false)).ToArray();
        foreach (var person in people) person.MaxParentalRatingScore = 16;
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        rig.Rig.RatingGate = gate;
        var access = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.ListAccessService(
            Mock.Of<Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.IListHost>(), rig.Rig.Callers.Users.Object, rig.Rig.Parental, rig.Rig.Plugin.Core.Logger);
        var audit = new MetadataAudit();
        using var observation = MetadataTaskProbe.Observe(audit.Observe);
        var reads = people.SelectMany((person, v) => Enumerable.Range(0, 8).Select(i =>
            access.CheckTitleAsync("movie", 920000 + v * 100 + i, person.Id.ToString("N"), CancellationToken.None))).ToArray();
        try
        {
            Assert.Equal(8, audit.Peak.GetValueOrDefault(people[0].Id));
            Assert.Equal(8, audit.Peak.GetValueOrDefault(people[1].Id));
            Assert.Equal(0, audit.Peak.GetValueOrDefault(Guid.Empty));
        }
        finally { gate.TrySetResult(); rig.Release(); await Task.WhenAll(reads).WaitAsync(TimeSpan.FromSeconds(20)); }
        audit.AssertSound();
    }

    [Fact]
    public async Task TmdbAdmissionListPosterOwnerRetainsFourPlacesThroughTheOneTransport()
    {
        await using var rig = new AdmissionRig();
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var entered = 0;
        var throughTransport = 0;
        using var observation = MetadataTaskProbe.Observe(e => { if (e.Kind == "transport") Interlocked.Increment(ref throughTransport); });
        using var net = new IntegrationTransport(async (request, ct) =>
        {
            Interlocked.Increment(ref entered);
            await release.Task.WaitAsync(ct);
            var id = int.Parse(request.RequestUri!.AbsolutePath.Split('/').Last());
            return IntegrationTransport.Response(System.Text.Json.JsonSerializer.Serialize(new { id, poster_path = "/poster.jpg" }));
        });
        var metadata = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.ListMetadataService(net, rig.Rig.Plugin.Core.Logger);
        var reads = Enumerable.Range(930001, 12).Select(id => metadata.ReadTmdbPosterAsync(
            new Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders.Placeholder { Kind = "movie", MediaType = "movie", TmdbId = id, Title = "Fixture" }, CancellationToken.None)).ToArray();
        try
        {
            Assert.Equal(4, entered);
            Assert.Equal(4, throughTransport);
            Assert.All(reads, read => Assert.False(read.IsCompleted));
        }
        finally { release.TrySetResult(); await Task.WhenAll(reads).WaitAsync(TimeSpan.FromSeconds(20)); }
        Assert.Equal(12, throughTransport);
        Assert.All(reads, read => Assert.True(read.Result.Answered));
    }

    [Fact]
    public async Task TmdbAdmissionWarmBundledProxyReadsAreFreeWhileTheViewerIsFull()
    {
        await using var rig = new AdmissionRig();
        var viewer = rig.Rig.Person(linked: false);
        using var scope = ViewerMetadataAdmission.ForViewer(viewer.Id);
        rig.Hold = false;
        var warmed = await rig.Cache.GetAsync("search/company", "?query=warm", "fixture", CancellationToken.None, bundle: true);
        rig.Hold = true;
        var held = Enumerable.Range(0, 8).Select(i => rig.Cache.GetAsync("search/company", "?query=cold" + i, "fixture", CancellationToken.None, bundle: true)).ToArray();
        try
        {
            Assert.Equal(8, rig.Admission.Count());
            var cached = await rig.Cache.GetAsync("search/company", "?query=warm", "fixture", CancellationToken.None, bundle: true);
            Assert.Equal(200, cached.StatusCode);
            Assert.Equal(warmed.Content, cached.Content);
            Assert.Equal(8, rig.Admission.Count());
        }
        finally { rig.Release(); await Task.WhenAll(held).WaitAsync(TimeSpan.FromSeconds(20)); }
    }

    private sealed class MetadataLease : IDisposable { public void Dispose() { } }

    [Fact]
    public async Task TmdbAdmissionImportCacheHitsDoNotWaitForAnotherAutonomousPlace()
    {
        await using var rig = new AdmissionRig();
        static Task<IDisposable> Admit(CancellationToken _) => Task.FromResult<IDisposable>(new MetadataLease());
        rig.Hold = false;
        await rig.Cache.GetAdmittedAsync("movie/990000", "", "fixture", Admit, CancellationToken.None);
        rig.Hold = true;
        var held = Enumerable.Range(1, 4).Select(i => rig.Cache.GetAdmittedAsync("movie/" + (990000 + i), "", "fixture", Admit, CancellationToken.None)).ToArray();
        Task<TmdbResponseCache.TmdbResponse>? hit = null;
        try
        {
            Assert.Equal(5, rig.Sends);
            hit = rig.Cache.GetAdmittedAsync("movie/990000", "", "fixture", Admit, CancellationToken.None);
            Assert.True(hit.IsCompletedSuccessfully);
            Assert.Equal(200, (await hit).StatusCode);
        }
        finally { rig.Release(); await Task.WhenAll(held).WaitAsync(TimeSpan.FromSeconds(20)); if (hit != null) await hit.WaitAsync(TimeSpan.FromSeconds(20)); }
    }

    private sealed class HeldMetadataBody : HttpContent
    {
        internal TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        protected override async Task SerializeToStreamAsync(Stream stream, System.Net.TransportContext? context)
        { await Release.Task; await stream.WriteAsync(new byte[] { 123, 125 }); }
        protected override async Task SerializeToStreamAsync(Stream stream, System.Net.TransportContext? context, CancellationToken ct)
        { await Release.Task.WaitAsync(ct); await stream.WriteAsync(new byte[] { 123, 125 }, ct); }
        protected override bool TryComputeLength(out long length) { length = 0; return false; }
    }

    [Fact]
    public async Task TmdbAdmissionBodyCancellationDrainsAndReleasesItsOriginalOwner()
    {
        await using var rig = new AdmissionRig();
        using var body = new HeldMetadataBody();
        using var net = new IntegrationTransport((_, _) => Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK) { Content = body }));
        var viewer = rig.Rig.Person(linked: false);
        var read = rig.Admission.Read("body-cancellation", viewer.Id, () => (false, false), async () =>
        {
            using var abort = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));
            using var response = await TmdbTransport.GetAsync(net, "https://api.themoviedb.org/3/movie/1", MetadataAdmission.Required, abort.Token);
            await response.Content.ReadAsStringAsync(abort.Token);
            return true;
        }, false, CancellationToken.None);
        try { await Assert.ThrowsAnyAsync<OperationCanceledException>(() => read.WaitAsync(TimeSpan.FromSeconds(5))); }
        finally { body.Release.TrySetResult(); try { await read; } catch (OperationCanceledException) { } }
        Assert.Equal(0, rig.Admission.Count());
    }
}
#endif
