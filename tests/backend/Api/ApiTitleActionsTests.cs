using System.Text.Json;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;
using Moq;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Xunit;

namespace JE.Tests;

[Collection("Plugin singleton")]
public partial class ApiTitleActionsTests
{
    private sealed class Rig : IDisposable
    {
        public ApiPluginFixture Plugin { get; } = new();
        public TestCallers Callers { get; } = new();
        public NativeDetailsPolicy Policy { get; }
        public NativeDetailsFeeds Feeds { get; }
        public Action? OnPageRead { get; set; }
        private readonly HashSet<Guid> _linked = new();
        private readonly IntegrationTransport _transport;
        public Rig()
        {
            var config = Plugin.Plugin.Configuration;
            config.NativeAbsentDetailsEnabled = true;
            config.JellyseerrEnabled = true;
            config.JellyseerrUrls = "http://seerr.invalid";
            config.JellyseerrApiKey = "fixture-key";
            var source = new Mock<INativeDetailsSource>();
            source.Setup(s => s.IsSeerrLinkedAsync(It.IsAny<Guid>(), It.IsAny<CancellationToken>()))
                .Returns((Guid user, CancellationToken _) => Task.FromResult<bool?>(_linked.Contains(user)));
            source.Setup(s => s.MovieAsync(It.IsAny<int>(), It.IsAny<Guid>(), It.IsAny<CancellationToken>()))
                .Returns(async (int id, Guid _, CancellationToken _) => { await Task.Yield(); OnPageRead?.Invoke(); return Data("{\"id\":" + id + ",\"title\":\"Movie\"}"); });
            source.Setup(s => s.SeriesAsync(It.IsAny<int>(), It.IsAny<Guid>(), It.IsAny<CancellationToken>()))
                .Returns((int id, Guid _, CancellationToken _) => Task.FromResult(Data("{\"id\":" + id + ",\"name\":\"Series\"}")));
            source.Setup(s => s.SeasonAsync(It.IsAny<int>(), It.IsAny<int>(), It.IsAny<Guid>(), It.IsAny<CancellationToken>()))
                .Returns((int _, int season, Guid _, CancellationToken _) => Task.FromResult(season == 1 ? Data("{\"seasonNumber\":1,\"episodes\":[{\"episodeNumber\":2,\"seasonNumber\":1}]}") : SourceAnswer.Missing));
            var libraries = new FakeLibraryAccess();
            libraries.Libs.Add(new() { Id = Guid.NewGuid().ToString(), Name = "Movies", CollectionType = "movies" });
            libraries.Libs.Add(new() { Id = Guid.NewGuid().ToString(), Name = "TV", CollectionType = "tvshows" });
            _transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response("{\"releases\":{\"results\":[{\"iso_3166_1\":\"US\",\"release_dates\":[{\"type\":3,\"certification\":\"PG-13\"}]}]}}")));
            var localization = new Mock<MediaBrowser.Model.Globalization.ILocalizationManager>();
            localization.Setup(l => l.GetRatingScore("PG-13", "US")).Returns(new MediaBrowser.Model.Entities.ParentalRatingScore(13, null));
            var server = new Mock<MediaBrowser.Controller.Configuration.IServerConfigurationManager>();
            server.SetupGet(s => s.Configuration).Returns(new MediaBrowser.Model.Configuration.ServerConfiguration { MetadataCountryCode = "US" });
            var parental = new SeerrParentalFilter(_transport, Callers.Users.Object, localization.Object, server.Object, Plugin.Core.Logger);
            Policy = new NativeDetailsPolicy(parental, source.Object, libraries);
            var library = new Mock<MediaBrowser.Controller.Library.ILibraryManager>();
            library.Setup(l => l.GetItemList(It.IsAny<MediaBrowser.Controller.Entities.InternalItemsQuery>())).Returns(new List<MediaBrowser.Controller.Entities.BaseItem>());
            Feeds = new NativeDetailsFeeds(source.Object, Policy, parental, library.Object);
        }
        private static SourceAnswer Data(string text) => SourceAnswer.Of(JsonDocument.Parse(text).RootElement.Clone());
        public User Person(bool linked = true)
        {
            var user = Callers.Register(Guid.NewGuid(), false);
            user.SetPermission(PermissionKind.EnableAllFolders, true);
            if (linked) _linked.Add(user.Id);
            return user;
        }
        public void Dispose() { _transport.Dispose(); Plugin.Dispose(); }
    }
    private static System.Security.Claims.ClaimsPrincipal Me(User user) => TestCallers.Principal(user.Id, false);
    private static int Status(IActionResult result) => result switch
    {
        ObjectResult o => o.StatusCode ?? 200, StatusCodeResult o => o.StatusCode, _ => 200,
    };

    [Theory]
    [InlineData("movie", 693134, null, null, 200)]
    [InlineData("tv", 83867, null, null, 200)]
    [InlineData("tv", 83867, 1, null, 200)]
    [InlineData("tv", 83867, 1, 2, 200)]
    [InlineData("tv", 83867, 1, 999, 404)]
    [InlineData("tv", 83867, 2, null, 404)]
    [InlineData("movie", -1, null, null, 400)]
    [InlineData("person", 3810, null, null, 400)]
    [InlineData("movie", 693134, 1, null, 400)]
    [InlineData("tv", 83867, null, 1, 400)]
    [InlineData("tv", 83867, -1, null, 400)]
    [InlineData("tv", 83867, 65536, null, 400)]
    public async Task ActionAdmissionValidatesExactProviderScope(string type, int tmdb, int? season, int? episode, int expected)
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        var route = new TitleActionsController(rig.Feeds, rig.Policy, rig.Callers.Users.Object)
        { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = Me(viewer) } } };
        Assert.Equal(expected, Status(await route.Read(type, tmdb, season, episode)));
        Assert.Equal("private, no-store", route.Response.Headers.CacheControl.ToString());
    }

    [Theory]
    [InlineData("off", 403)]
    [InlineData("unlinked", 404)]
    [InlineData("blocked", 404)]
    [InlineData("disabled", 403)]
    [InlineData("apikey", 403)]
    [InlineData("parental", 404)]
    public async Task ActionAdmissionUsesTheExistingViewerPolicy(string scenario, int expected)
    {
        using var rig = new Rig();
        var viewer = rig.Person(linked: scenario != "unlinked");
        if (scenario == "off") rig.Plugin.Plugin.Configuration.NativeAbsentDetailsEnabled = false;
        if (scenario == "disabled") viewer.SetPermission(PermissionKind.IsDisabled, true);
        if (scenario == "blocked") rig.Plugin.Plugin.Configuration.JellyseerrImportBlockedUsers = viewer.Id.ToString("N");
        if (scenario == "parental") viewer.MaxParentalRatingScore = 10;
        var route = new TitleActionsController(rig.Feeds, rig.Policy, rig.Callers.Users.Object)
        { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = scenario == "apikey" ? TestCallers.ApiKey() : Me(viewer) } } };
        Assert.Equal(expected, Status(await route.Read("movie", 693134)));
    }

    [Theory]
    [InlineData("feature")]
    [InlineData("disabled")]
    [InlineData("blocked")]
    public async Task ActionAdmissionRechecksAfterTheSourceAwait(string revoke)
    {
        using var rig = new Rig();
        var viewer = rig.Person();
        int Reads() => rig.Callers.Users.Invocations.Count(i => i.Method.Name == nameof(MediaBrowser.Controller.Library.IUserManager.GetUserById));
        var readsAtAwait = -1;
        rig.OnPageRead = () =>
        {
            readsAtAwait = Reads();
            if (revoke == "feature") rig.Plugin.Plugin.Configuration.NativeAbsentDetailsEnabled = false;
            if (revoke == "disabled") viewer.SetPermission(PermissionKind.IsDisabled, true);
            if (revoke == "blocked") rig.Plugin.Plugin.Configuration.JellyseerrImportBlockedUsers = viewer.Id.ToString("N");
        };
        var route = new TitleActionsController(rig.Feeds, rig.Policy, rig.Callers.Users.Object)
        { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = Me(viewer) } } };
        Assert.NotEqual(200, Status(await route.Read("movie", 693134)));
        // The person was read again after the source await (the live read), never decided by the read before it.
        Assert.True(readsAtAwait >= 1 && Reads() > readsAtAwait, $"reads at the await {readsAtAwait}, at the end {Reads()}");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RealCopyUsesNativeAccessWithoutASeerrAccountAndNeverPublishesAnotherCopy(bool disabled)
    {
        using var rig = new Rig();
        var person = rig.Person(linked: false);
        person.SetPermission(PermissionKind.IsDisabled, disabled);
        var view = new FakeJellyfinView { ResolveAnyItem = true };
        view.Users[person.Id] = new StatusViewer { UserId = person.Id, Handle = person };
        var key = TitleKey.Parse("movie:tmdb:693134")!;
        var hidden = Guid.NewGuid(); var shown = Guid.NewGuid();
        view.AddCopy(key, new JfCopy { ItemId = hidden }, Guid.NewGuid());
        view.AddCopy(key, new JfCopy { ItemId = shown }, person.Id);
        view.AddCopy(key, new JfCopy { ItemId = Guid.NewGuid() }, person.Id);
        var registry = new ArrInstanceRegistry(() => rig.Plugin.Plugin.Configuration, () => null);
        using var store = new ArrStateStore(new ArrClientFactory(Mock.Of<IHttpClientFactory>(), registry), null, null, null, () => rig.Plugin.Plugin.Configuration);
        var status = new ArrStatusService(store, view, new NoRequestFacts(), () => rig.Plugin.Plugin.Configuration, null);
        rig.OnPageRead = () => throw new InvalidOperationException("Native copy does not read absent metadata");
        var route = new TitleActionsController(rig.Feeds, rig.Policy, rig.Callers.Users.Object, status)
        { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = Me(person) } } };
        var result = await route.Read("movie", 693134);
        if (disabled) Assert.Equal(403, Status(result));
        else
        {
            var body = JsonSerializer.Serialize(Assert.IsType<OkObjectResult>(result).Value);
            Assert.Contains(shown.ToString("N"), body, StringComparison.Ordinal);
            Assert.DoesNotContain(hidden.ToString("N"), body, StringComparison.Ordinal);
            Assert.DoesNotContain("Movie", body, StringComparison.Ordinal);
        }
    }

    [Theory]
    [InlineData(false, 200)]
    [InlineData(true, 404)]
    public async Task NativeArrivalResolvesTheExactEpisodeAndNeverAVirtualRow(bool virtualEpisode, int expected)
    {
        using var rig = new Rig(); var person = rig.Person(linked: false);
        var view = new FakeJellyfinView { ResolveAnyItem = true };
        view.Users[person.Id] = new StatusViewer { UserId = person.Id, Handle = person };
        var key = TitleKey.Parse("tv:tmdb:83867")!;
        var series = Guid.NewGuid(); var episode = Guid.NewGuid();
        view.AddCopy(key, new JfCopy { ItemId = series }, person.Id);
        view.AddEpisode(series, new JfEpisode { ItemId = episode, Season = 1, Episode = 2, Virtual = virtualEpisode }, person.Id);
        var registry = new ArrInstanceRegistry(() => rig.Plugin.Plugin.Configuration, () => null);
        using var store = new ArrStateStore(new ArrClientFactory(Mock.Of<IHttpClientFactory>(), registry), null, null, null, () => rig.Plugin.Plugin.Configuration);
        var status = new ArrStatusService(store, view, new NoRequestFacts(), () => rig.Plugin.Plugin.Configuration, null);
        var route = new TitleActionsController(rig.Feeds, rig.Policy, rig.Callers.Users.Object, status)
        { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = Me(person) } } };
        var result = await route.Read("tv", 83867, 1, 2);
        Assert.Equal(expected, Status(result));
        if (expected == 200) Assert.Contains(episode.ToString("N"), JsonSerializer.Serialize(Assert.IsType<OkObjectResult>(result).Value), StringComparison.Ordinal);
    }

}
