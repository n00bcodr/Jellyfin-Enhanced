using System.Security.Claims;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;

namespace JE.Tests;

public partial class ApiNativeDetailsTests
{
    // Counts task CREATIONS, including the server queue, independently checks each external
    // factory's inherited owner, and retains peaks after completion. HTTP send counts alone
    // cannot detect the original failure (many tasks waiting before their first send).
    private sealed class MetadataAudit
    {
        private readonly object _lock = new();
        private readonly Dictionary<object, Guid> _owners = new();
        public Dictionary<Guid, int> Peak { get; } = new();
        public List<string> Violations { get; } = new();
        public int ServerPeak { get; private set; }
        public int ExternalCreations { get; private set; }
        public int Creations { get; private set; }

        public void Observe(MetadataTaskEvent e)
        {
            lock (_lock)
            {
                if (e.Kind == "created")
                {
                    Creations++;
                    _owners.Add(e.Owner!, e.Viewer!.Value);
                    var count = _owners.Values.Count(v => v == e.Viewer);
                    Peak[e.Viewer.Value] = Math.Max(Peak.GetValueOrDefault(e.Viewer.Value), count);
                    ServerPeak = Math.Max(ServerPeak, _owners.Count);
                    if (count > 8 || _owners.Count > 48) Violations.Add("task admission limit exceeded");
                }
                else if (e.Kind == "completed") _owners.Remove(e.Owner!);
                else
                {
                    ExternalCreations++;
                    if (e.Owner == null || !_owners.TryGetValue(e.Owner, out var viewer) || viewer != e.Viewer)
                        Violations.Add("external metadata task has no live viewer admission: " + e.Path);
                }
            }
        }

        public void AssertSound()
        {
            lock (_lock)
            {
                Assert.Empty(Violations);
                Assert.Empty(_owners);
            }
        }
    }

    private static ArrStatusController MetadataStatus(AdmissionRig rig, Jellyfin.Database.Implementations.Entities.User viewer,
        ArrStateStore store, ServiceProvider services)
    {
        var view = new FakeJellyfinView();
        view.Users[viewer.Id] = new StatusViewer { UserId = viewer.Id, Handle = viewer, HasParentalLimit = true, PolicyRevision = "test" };
        var status = new ArrStatusService(store, view, new NoRequestFacts(), () => rig.Rig.Plugin.Plugin.Configuration, null);
        return new ArrStatusController(status)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext
                {
                    RequestServices = services,
                    User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("Jellyfin-UserId", viewer.Id.ToString()) }, "test")),
                },
            },
        };
    }

    [Fact]
    public async Task MetadataArchitectureCollectionRefusesAnIncompleteEvidencePageAndRetriesWithoutLosingParts()
    {
        using var ledger = new IntegrationRequestLedgerTests.Rig();
        await using var rig = new AdmissionRig();
        var person = rig.Rig.Person(linked: false);
        person.MaxParentalRatingScore = 16;
        var viewer = new StatusViewer { UserId = person.Id, Handle = person, PolicyRevision = "collection", HasParentalLimit = true };
        ledger.View.Users[person.Id] = viewer;
        ledger.Policy.People[person.Id] = ledger.Policy.People[ledger.Member] with { UserId = person.Id };
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        rig.Rig.RatingGate = gate;
        var json = System.Text.Json.JsonSerializer.Serialize(new
        {
            parts = Enumerable.Range(797001, 10).Select(id => new { id, title = "Movie " + id, release_date = "2000-01-01" }).ToArray(),
        });
        var gaps = new CollectionGapsService(ledger.View, (_, id) => new BoxSetRef(id, 1), null, null,
            (_, _, _) => Task.FromResult<string?>(json),
            (id, user, ct) => rig.Rig.Parental.MaySeeAbsentAsync("movie", id, user.ToString(), ct),
            () => DateTimeOffset.UtcNow);
        var controller = new AcquireCollectionsController(ledger.Service, gaps)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = Me(person) } },
        };
        var pending = controller.Collection(Guid.NewGuid().ToString());
        try
        {
            Assert.False(pending.IsCompleted);
            Assert.Equal(8, rig.Admission.Count());
        }
        finally { gate.TrySetResult(); }
        Assert.Equal(503, Status(await pending.WaitAsync(TimeSpan.FromSeconds(15))));
        Assert.Equal("1", controller.Response.Headers["Retry-After"]);
        var retried = await gaps.ForCollectionAsync(viewer, Guid.NewGuid(), null, CancellationToken.None);
        Assert.Null(retried.Refusal);
        Assert.Equal(10, retried.Gaps!.Total);
        Assert.Equal(10, retried.Gaps.Missing.Count);
    }

    [Theory]
    [InlineData("collection-gaps")]
    [InlineData("season-rows")]
    public async Task MetadataArchitectureRawCollectionAndSeasonReadersRetainTheEffectiveViewer(string route)
    {
        using var ledger = new IntegrationRequestLedgerTests.Rig();
        await using var rig = new AdmissionRig();
        var person = rig.Rig.Person(linked: false);
        person.MaxParentalRatingScore = 16;
        var viewer = new StatusViewer { UserId = person.Id, Handle = person, PolicyRevision = "raw", HasParentalLimit = true };
        ledger.View.Users[person.Id] = viewer;
        ledger.Policy.People[person.Id] = ledger.Policy.People[ledger.Member] with { UserId = person.Id };
        var ids = Enumerable.Range(796001, 80).ToDictionary(_ => Guid.NewGuid(), id => id);
        // Real collection projection/final gate and raw TMDB client; fake only the library's BoxSet facts.
        var gaps = new CollectionGapsService(ledger.View, (_, id) => new BoxSetRef(id, ids[id]), null, null,
            async (id, _, ct) => (await rig.Cache.GetAsync("collection/" + id, "", "test-tmdb", ct)).Content,
            (_, _, _) => Task.FromResult(true), () => DateTimeOffset.UtcNow);
        // This public constructor uses the production TMDB season reader.
        var rows = new SeasonRowsService(ledger.View, ledger.Ledger, ledger.Policy, null!, rig.Cache);
        var audit = new MetadataAudit();
        using var observation = MetadataTaskProbe.Observe(audit.Observe);
        async Task Read(KeyValuePair<Guid, int> entry)
        {
            if (route == "collection-gaps") await gaps.ForCollectionAsync(viewer, entry.Key, null, CancellationToken.None);
            else await rows.ForAbsentSeasonAsync(viewer, new AbsentTitle
            {
                PageId = entry.Key, SeriesPageId = Guid.NewGuid(), Kind = "season", Season = 1,
                TmdbId = entry.Value, Title = TitleKey.Parse("tv:tmdb:" + entry.Value)!,
            }, null, CancellationToken.None);
        }
        var reads = ids.Select(Read).ToArray();
        try
        {
            Assert.Equal(8, rig.Admission.Count());
            Assert.Equal(8, audit.Creations);
            Assert.Equal(8, audit.Peak[person.Id]);
            Assert.Equal(72, reads.Count(t => t.IsCompletedSuccessfully));
            // These raw readers and native parental evidence consume the very same places.
            Assert.Equal(AbsentLookup.Unavailable, (await rig.Read(person.Id, SyntheticId.Movie(796999))).Outcome);
            Assert.Equal(8, audit.Creations);
        }
        finally
        {
            rig.Release();
            await Task.WhenAll(reads).WaitAsync(TimeSpan.FromSeconds(15));
        }
        Assert.Equal(8, audit.ExternalCreations);
        audit.AssertSound();
    }

    [Fact]
    public async Task MetadataArchitectureProductionRegistrationSharesOneTaskOwner()
    {
        await using var rig = new AdmissionRig();
        var registrations = new ServiceCollection();
        new Jellyfin.Plugin.JellyfinEnhanced.PluginServiceRegistrator().RegisterServices(registrations, Host());
        IServiceCollection services = new ServiceCollection();
        var types = new[] { typeof(ViewerMetadataAdmission), typeof(TmdbNativeDetailsSource), typeof(SeerrParentalFilter), typeof(TmdbResponseCache) };
        foreach (var descriptor in registrations.Where(d => types.Contains(d.ServiceType))) services.Add(descriptor);
        services.AddSingleton<MediaBrowser.Common.Configuration.IApplicationPaths>(rig.Rig.Plugin.Core.Paths.Object);
        services.AddSingleton(rig.Rig.Plugin.Core.Logger);
        services.AddSingleton(Moq.Mock.Of<MediaBrowser.Controller.Library.IUserManager>());
        services.AddSingleton(Moq.Mock.Of<MediaBrowser.Model.Globalization.ILocalizationManager>());
        services.AddSingleton(Moq.Mock.Of<MediaBrowser.Controller.Configuration.IServerConfigurationManager>());
        services.AddSingleton<System.Net.Http.IHttpClientFactory>(rig.Rig.Seerr);
        using var transport = new IntegrationTransport((_, _) => throw new InvalidOperationException("No arr calls"));
        using var store = new ArrStateStore(new ArrClientFactory(transport, new ArrInstanceRegistry()), null, rig.Rig.Plugin.Core.Logger, null, null);
        services.AddSingleton(new TitleAliases(store, null));
        using var provider = services.BuildServiceProvider();
        var owner = provider.GetRequiredService<ViewerMetadataAdmission>();
        Assert.Same(owner, provider.GetRequiredService<ViewerMetadataAdmission>());
        Assert.Same(owner, provider.GetRequiredService<TmdbResponseCache>().MetadataAdmission);
        foreach (var instance in new object[] { provider.GetRequiredService<TmdbNativeDetailsSource>(), provider.GetRequiredService<SeerrParentalFilter>() })
        {
            Assert.Same(owner, instance.GetType().GetField("_admission", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.GetValue(instance));
        }
    }

    [Fact]
    public async Task MetadataArchitectureBusyEvidenceIsRetryableAndDoesNotPoisonPolicyOrCaches()
    {
        await using var rig = new AdmissionRig();
        var viewer = rig.Rig.Person(linked: false);
        viewer.MaxParentalRatingScore = 16;
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        rig.Rig.RatingGate = gate;
        var held = Enumerable.Range(795001, 8).Select(id => rig.Read(viewer.Id, SyntheticId.Movie(id))).ToArray();
        try
        {
            var page = SyntheticId.Movie(795099);
            Assert.Equal(AbsentLookup.Unavailable, (await rig.Read(viewer.Id, page)).Outcome);
            Assert.Equal(503, Status((await Call(rig.Rig, "UserLibrary", "GetItem", Me(viewer), new() { ["itemId"] = Id(page) })).Result));
            Assert.Equal(FeedOutcome.Unavailable, (await rig.Rig.Feeds.TitleAsync(viewer, true, page.TmdbId, CancellationToken.None)).Outcome);
            var tag = rig.Rig.Artwork.Mint(Id(page), ImageType.Primary, 0, "/fixture.jpg", viewer.Id, rig.Rig.Policy.Revision(viewer));
            Assert.Equal(503, Status((await Call(rig.Rig, "Image", "GetItemImage", null, new() { ["itemId"] = Id(page), ["imageType"] = ImageType.Primary, ["tag"] = tag })).Result));
            var list = await rig.Rig.Parental.ApplyAsync("{\"parts\":[{\"id\":795099}]}", "/api/v1/collection/1", viewer.Id.ToString());
            Assert.True(list.RetryLater);
            Assert.Contains("\"parts\":[]", list.Body);
        }
        finally
        {
            gate.TrySetResult();
            rig.Release();
            await Task.WhenAll(held).WaitAsync(TimeSpan.FromSeconds(15));
        }
        Assert.Equal(AbsentLookup.Found, (await rig.Read(viewer.Id, SyntheticId.Movie(795099))).Outcome);
        viewer.MaxParentalRatingScore = 10;
        Assert.Equal(AbsentLookup.Refused, (await rig.Read(viewer.Id, SyntheticId.Movie(795099))).Outcome);
    }

    [Theory]
    [InlineData("resolver")]
    [InlineData("native")]
    [InlineData("public")]
    [InlineData("parental")]
    [InlineData("captured-policy")]
    [InlineData("status")]
    [InlineData("artwork")]
    [InlineData("collection")]
    [InlineData("parental-list")]
    [InlineData("artwork-person")]
    public async Task MetadataArchitectureEveryRestrictedViewerEntryBoundsEightyColdTaskCreations(string route)
    {
        await using var rig = new AdmissionRig();
        var viewer = rig.Rig.Person(linked: false);
        viewer.MaxParentalRatingScore = 16;
        var evidence = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        rig.Rig.RatingGate = evidence;
        var audit = new MetadataAudit();
        using var observation = MetadataTaskProbe.Observe(audit.Observe);
        using var transport = new IntegrationTransport((_, _) => throw new InvalidOperationException("No arr calls"));
        using var store = new ArrStateStore(new ArrClientFactory(transport, new ArrInstanceRegistry()), null, rig.Rig.Plugin.Core.Logger, null, () => rig.Rig.Plugin.Plugin.Configuration);
        using var services = new ServiceCollection().AddSingleton<IAbsentTitlePages>(rig.Pages).BuildServiceProvider();
        async Task Read(int id)
        {
            var page = route == "artwork-person" ? SyntheticId.Person(id) : SyntheticId.Movie(id);
            if (route == "resolver") await rig.Read(viewer.Id, page);
            else if (route == "native") await Call(rig.Rig, "UserLibrary", "GetItem", Me(viewer), new() { ["itemId"] = Id(page) });
            else if (route == "public") await rig.Rig.Feeds.TitleAsync(viewer, true, id, CancellationToken.None);
            else if (route == "parental") await rig.Rig.Parental.IsBlockedAsync("movie", id, viewer.Id.ToString(), CancellationToken.None);
            else if (route == "captured-policy") await rig.Rig.Parental.CheckAbsentAsync("movie", id, SeerrParentalFilter.PolicyFor(viewer), viewer.Id, CancellationToken.None);
            else if (route == "parental-list") await rig.Rig.Parental.ApplyAsync("{\"parts\":[{\"id\":" + id + "}]}", "/api/v1/collection/1", viewer.Id.ToString(), CancellationToken.None);
            else if (route == "status") await MetadataStatus(rig, viewer, store, services).GetItemStatus(Id(page).ToString(), CancellationToken.None);
            else if (route == "collection") await rig.Rig.Feeds.CollectionAsync(viewer, id, CancellationToken.None);
            else
            {
                var tag = rig.Rig.Artwork.Mint(Id(page), ImageType.Primary, 0, "/fixture.jpg", viewer.Id, rig.Rig.Policy.Revision(viewer));
                await Call(rig.Rig, "Image", "GetItemImage", null, new() { ["itemId"] = Id(page), ["imageType"] = ImageType.Primary, ["tag"] = tag });
            }
        }

        var reads = Enumerable.Range(770001, 80).Select(Read).ToArray();
        try
        {
            Assert.Equal(8, rig.Admission.Count());
            Assert.False(reads[7].IsCompleted); // eighth retains its place
            Assert.True(reads[8].IsCompletedSuccessfully); // ninth is refused promptly
            Assert.Equal(72, reads.Count(t => t.IsCompletedSuccessfully));
            Assert.Equal(8, audit.Creations);
            Assert.Equal(8, audit.Peak[viewer.Id]);
        }
        finally
        {
            evidence.TrySetResult();
            rig.Release();
            await Task.WhenAll(reads).WaitAsync(TimeSpan.FromSeconds(20));
        }
        Assert.True(audit.ExternalCreations >= 8);
        audit.AssertSound();
    }

    [Fact]
    public async Task MetadataArchitectureMixedRoutesShareFortyEightPlacesAndRetainCancelledOwners()
    {
        await using var rig = new AdmissionRig();
        var viewers = Enumerable.Range(0, 7).Select(_ => rig.Rig.Person(linked: false)).ToArray();
        foreach (var viewer in viewers) viewer.MaxParentalRatingScore = 16;
        var evidence = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        rig.Rig.RatingGate = evidence;
        var audit = new MetadataAudit();
        using var observation = MetadataTaskProbe.Observe(audit.Observe);
        using var abort = new CancellationTokenSource();
        var cancelled = rig.Rig.Parental.CheckAbsentAsync("movie", 780000, viewers[0].Id.ToString(), abort.Token);
        var reads = new List<Task>();
        try
        {
            abort.Cancel();
            // An aborted waiter may fail closed; its read still owns its slot.
            try { await cancelled; } catch (OperationCanceledException) { }
            for (var v = 0; v < 6; v++)
            {
                for (var i = v == 0 ? 1 : 0; i < 8; i++)
                {
                    var id = 780000 + v * 100 + i;
                    reads.Add(i % 2 == 0 ? rig.Read(viewers[v].Id, SyntheticId.Movie(id))
                        : rig.Rig.Feeds.CollectionAsync(viewers[v], id, CancellationToken.None));
                }
            }
            Assert.Equal(48, rig.Admission.Count());
            Assert.Equal(48, audit.Creations);
            var refused = await rig.Read(viewers[6].Id, SyntheticId.Movie(789999));
            Assert.Equal(AbsentLookup.Unavailable, refused.Outcome);
            Assert.Equal(FeedOutcome.Busy, (await rig.Rig.Feeds.CollectionAsync(viewers[6], 789999, CancellationToken.None)).Outcome);
            Assert.Equal(48, audit.Creations);
            // Cross-viewer joins remain free, retaining the first viewer's owner.
            reads.Add(rig.Rig.Parental.CheckAbsentAsync("movie", 780000, viewers[6].Id.ToString(), CancellationToken.None));
            Assert.Equal(48, rig.Admission.Count());
        }
        finally
        {
            evidence.TrySetResult();
            rig.Release();
            await Task.WhenAll(reads).WaitAsync(TimeSpan.FromSeconds(20));
        }
        Assert.Equal(48, audit.ServerPeak);
        Assert.All(viewers.Take(6), viewer => Assert.Equal(8, audit.Peak[viewer.Id]));
        Assert.False(audit.Peak.ContainsKey(viewers[6].Id));
        Assert.Equal(AbsentLookup.Found, (await rig.Read(viewers[6].Id, SyntheticId.Movie(789999))).Outcome);
        audit.AssertSound();
    }

    [Fact]
    public async Task MetadataArchitecturePlantedUnboundedRawTaskFactoryIsDetectedBeforeHttpSend()
    {
        await using var rig = new AdmissionRig();
        var audit = new MetadataAudit();
        using var observation = MetadataTaskProbe.Observe(audit.Observe);
        // Deliberately bypass the production owner. The raw cache's 20-send cap must not
        // make this architecture self-test pass: all 80 task creations must be observed.
        var planted = Enumerable.Range(790001, 80).Select(id => rig.Cache.GetAsync("movie/" + id, "", "fixture", CancellationToken.None)).ToArray();
        try
        {
            Assert.Equal(80, audit.ExternalCreations);
            Assert.Equal(80, audit.Violations.Count);
            Assert.ThrowsAny<Xunit.Sdk.XunitException>(audit.AssertSound);
            Assert.Equal(0, rig.Admission.Count());
        }
        finally
        {
            rig.Release();
            await Task.WhenAll(planted).WaitAsync(TimeSpan.FromSeconds(15));
        }
    }
}
