using System.Collections.Concurrent;
using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class PersonEnrichmentTests
{
    private sealed class Rig : IAsyncDisposable
    {
        internal readonly ApiPluginFixture Plugin = new();
        internal readonly ViewerMetadataAdmission Admission = new();
        internal readonly TaskCompletionSource Release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal readonly ConcurrentDictionary<int, int> Sends = new();
        internal readonly Person[] People;
        internal readonly TmdbResponseCache Cache;
        private readonly IntegrationTransport _net;
        private readonly Mock<ILibraryManager> _library = new();
        private readonly List<Task> _reads = new();
        internal int Active, Peak;
        internal bool Hold = true;

        internal Rig(int count = 240)
        {
            Plugin.Plugin.Configuration.ArrRequestBackend = "je";
            Plugin.Plugin.Configuration.TMDB_API_KEY = "fixture";
            People = Enumerable.Range(1, count).Select(i => new Person { Id = Guid.NewGuid(), Name = "Person " + i,
                ProviderIds = new() { ["Tmdb"] = i.ToString(System.Globalization.CultureInfo.InvariantCulture) } }).ToArray();
            _library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
                People.Where(p => q.ItemIds.Contains(p.Id)).Cast<BaseItem>().ToList());
            foreach (var person in People) _library.Setup(l => l.GetItemById(person.Id)).Returns(person);
            _net = new IntegrationTransport(async (req, ct) =>
            {
                Assert.Equal("api.themoviedb.org", req.RequestUri!.Host);
                var id = int.Parse(req.RequestUri.AbsolutePath.Split('/').Last(), System.Globalization.CultureInfo.InvariantCulture);
                Sends.AddOrUpdate(id, 1, (_, n) => n + 1);
                var active = Interlocked.Increment(ref Active);
                int peak;
                do { peak = Volatile.Read(ref Peak); } while (active > peak && Interlocked.CompareExchange(ref Peak, active, peak) != peak);
                try
                {
                    if (Hold) await Release.Task.WaitAsync(ct);
                    return IntegrationTransport.Response("""{"birthday":"1980-01-02","place_of_birth":"Fixture city"}""");
                }
                finally { Interlocked.Decrement(ref Active); }
            });
            Cache = new TmdbResponseCache(_net, TimeProvider.System, Admission);
        }

        internal async Task<IActionResult> Read(Guid viewer, IEnumerable<Person> people, bool single = false)
        {
            var controller = ApiAssetTests.Controller(Plugin.Core, _library.Object, Cache);
            controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("Jellyfin-UserId", viewer.ToString()) }, "fixture"));
            using var scope = ViewerMetadataAdmission.ForViewer(viewer);
            var read = single ? controller.GetPersonInfo(people.Single().Id) : controller.GetPeopleInfo(string.Join(",", people.Select(p => p.Id)));
            _reads.Add(read);
            return await read;
        }

        internal int Warnings => File.Exists(Plugin.Core.Logger.CurrentLogFilePath)
            ? File.ReadLines(Plugin.Core.Logger.CurrentLogFilePath).Count(l => l.Contains("[WARN]", StringComparison.Ordinal)) : 0;

        public async ValueTask DisposeAsync()
        {
            Release.TrySetResult();
            try { await Task.WhenAll(_reads).WaitAsync(TimeSpan.FromSeconds(30)); }
            finally { Cache.Dispose(); _net.Dispose(); Plugin.Dispose(); }
        }
    }

    private static void Full(IActionResult result, int count)
    {
        var json = JsonSerializer.SerializeToElement(Assert.IsType<OkObjectResult>(result).Value);
        var people = json.GetProperty("people").EnumerateObject().ToArray();
        Assert.Equal(count, people.Length);
        Assert.All(people, p => Assert.Equal("Fixture city", p.Value.GetProperty("birthPlace").GetString()));
    }

    [Fact]
    public async Task PersonLargeCastUsesOnePlacePerChunkAndEventuallyFillsAll120()
    {
        await using var rig = new Rig();
        var viewer = Guid.NewGuid();
        var first = rig.Read(viewer, rig.People.Take(100));
        var second = rig.Read(viewer, rig.People.Skip(100).Take(20));
        try { Assert.Equal(2, rig.Admission.Count()); }
        finally { rig.Release.TrySetResult(); }
        Full(await first, 100); Full(await second, 20);
        Assert.InRange(rig.Peak, 1, 8);
        Assert.Equal(120, rig.Sends.Count);
        Assert.Equal(0, rig.Warnings);
    }

    [Fact]
    public async Task PersonTwoViewersHaveIndependentLargeCastBursts()
    {
        await using var rig = new Rig();
        var a = Guid.NewGuid(); var b = Guid.NewGuid();
        var reads = new[] { rig.Read(a, rig.People.Take(100)), rig.Read(a, rig.People.Skip(100).Take(20)),
            rig.Read(b, rig.People.Skip(120).Take(100)), rig.Read(b, rig.People.Skip(220).Take(20)) };
        try { Assert.Equal(4, rig.Admission.Count()); }
        finally { rig.Release.TrySetResult(); }
        var answers = await Task.WhenAll(reads);
        for (var i = 0; i < answers.Length; i++) Full(answers[i], i % 2 == 0 ? 100 : 20);
        Assert.InRange(rig.Peak, 1, 8);
        Assert.Equal(240, rig.Sends.Count);
        Assert.Equal(0, rig.Warnings);
    }

    [Fact]
    public async Task PersonOverlappingConcurrentChunksCoalesceEachPerson()
    {
        await using var rig = new Rig();
        var reads = new[] { rig.Read(Guid.NewGuid(), rig.People.Take(30)), rig.Read(Guid.NewGuid(), rig.People.Skip(10).Take(30)) };
        rig.Release.TrySetResult();
        foreach (var answer in await Task.WhenAll(reads)) Full(answer, 30);
        Assert.Equal(40, rig.Sends.Count);
        Assert.All(rig.Sends.Values, n => Assert.Equal(1, n));
        Assert.Equal(0, rig.Warnings);
    }

    [Fact]
    public async Task PersonCachedBatchBypassesSaturatedViewerAdmission()
    {
        await using var rig = new Rig();
        rig.Hold = false;
        var viewer = Guid.NewGuid();
        Full(await rig.Read(viewer, rig.People.Take(30)), 30);
        rig.Hold = true;
        var occupied = Enumerable.Range(0, 8).Select(i => rig.Read(viewer, rig.People.Skip(40 + i).Take(1), single: true)).ToArray();
        try
        {
            Assert.Equal(8, rig.Admission.Count());
            var cached = rig.Read(viewer, rig.People.Take(30));
            Full(await cached.WaitAsync(TimeSpan.FromSeconds(2)), 30);
            Assert.Equal(8, rig.Admission.Count());
        }
        finally { rig.Release.TrySetResult(); await Task.WhenAll(occupied); }
        Assert.Equal(0, rig.Warnings);
    }

    [Fact]
    public async Task PersonRefusedChunkIsQuietTypedPendingAndRetryFillsIt()
    {
        await using var rig = new Rig();
        var viewer = Guid.NewGuid();
        var occupied = Enumerable.Range(0, 8).Select(i => rig.Read(viewer, rig.People.Skip(i).Take(1), single: true)).ToArray();
        try
        {
            var result = Assert.IsType<ObjectResult>(await rig.Read(viewer, rig.People.Skip(20).Take(100)));
            Assert.Equal(503, result.StatusCode);
            var json = JsonSerializer.SerializeToElement(result.Value);
            Assert.True(json.GetProperty("pending").GetBoolean());
            Assert.Equal("metadata_busy", json.GetProperty("reason").GetString());
            Assert.Equal(0, rig.Warnings);
        }
        finally { rig.Release.TrySetResult(); await Task.WhenAll(occupied); }
        Full(await rig.Read(viewer, rig.People.Skip(20).Take(100)), 100);
        Assert.Equal(0, rig.Warnings);
    }

    [Fact]
    public async Task PersonRefusalWarningCountIsBoundedForFourBursts()
    {
        await using var rig = new Rig();
        var viewer = Guid.NewGuid();
        var occupied = Enumerable.Range(0, 8).Select(i => rig.Read(viewer, rig.People.Skip(i).Take(1), single: true)).ToArray();
        try
        {
            for (var burst = 0; burst < 4; burst++)
            {
                await rig.Read(viewer, rig.People.Skip(20).Take(100));
                Assert.InRange(rig.Warnings, 0, burst + 1);
            }
        }
        finally { rig.Release.TrySetResult(); await Task.WhenAll(occupied); }
    }
}
