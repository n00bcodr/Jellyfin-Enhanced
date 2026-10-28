using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ServerCache;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using Moq;

namespace JE.Tests;

/// <summary>
/// Remote parental facts in the server-side cache (namespace <c>tmdbparental</c>): facts survive a restart, decisions never do.
/// Every "restart" is a new store, raw cache, provider and gate over the same folder.
/// </summary>
[Collection("Plugin singleton")]
public sealed class IntegrationParentalFactCacheTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "je-parental-facts-" + Guid.NewGuid().ToString("N"));
    private readonly IntegrationTmdbDiskCacheTests.Clock _clock = new() { Now = DateTimeOffset.UtcNow };
    private string _country = "US";

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, true);
    }

    private string Folder => Path.Combine(_root, ServerBlobCache.DefaultFolderName, TmdbParentalFactCache.Namespace);

    private int Facts() => Directory.Exists(Folder) ? Directory.EnumerateFiles(Folder, "*.blob", SearchOption.AllDirectories).Count() : 0;

    private ServerBlobCache Disk() => new(() => new ServerCacheSettings(true, string.Empty, 0, 0), new ServerCacheLocation(_root, Array.Empty<string>()), null,
        () => _clock.Now.UtcDateTime) { SweepDebounce = TimeSpan.Zero };

    /// <summary>One process: a gate over a fresh raw cache and facts cache on the shared folder.</summary>
    private SeerrParentalFilter Process(ApiPluginFixture plugin, IntegrationTransport transport, IEnumerable<User> users, ILibraryManager? library = null, ServerBlobCache? disk = null)
    {
        disk ??= Disk();
        var tmdb = new TmdbResponseCache(transport, _clock, null, disk);
        var provider = new TitleParentalEvidenceProvider(transport, tmdb, library, new TmdbParentalFactCache(disk, () => _clock.Now.UtcDateTime));
        var userManager = new Mock<IUserManager>();
        foreach (var user in users) userManager.Setup(m => m.GetUserById(user.Id)).Returns(user);
        var localization = new Mock<ILocalizationManager>();
        localization.Setup(m => m.GetRatingScore("G", It.IsAny<string>())).Returns(new ParentalRatingScore(1, null));
        localization.Setup(m => m.GetRatingScore("R", It.IsAny<string>())).Returns(new ParentalRatingScore(18, null));
        var server = new Mock<IServerConfigurationManager>();
        server.SetupGet(m => m.Configuration).Returns(() => new ServerConfiguration { MetadataCountryCode = _country });
        return new SeerrParentalFilter(transport, userManager.Object, localization.Object, server.Object, plugin.Core.Logger, provider);
    }

    private static ApiPluginFixture Je(string key = "test-tmdb")
    {
        var plugin = new ApiPluginFixture();
        plugin.Plugin.Configuration.ArrRequestBackend = "je";
        plugin.Plugin.Configuration.JellyseerrEnabled = false;
        plugin.Plugin.Configuration.TMDB_API_KEY = key;
        return plugin;
    }

    private static User Kid(int max = 10, bool tags = true, string role = "Kid", bool admin = false)
    {
        var user = FakeListHost.MakeUser(role, admin: admin);
        user.MaxParentalRatingScore = max;
        if (tags) user.SetPreference(PreferenceKind.BlockedTags, new[] { "Horror" });
        return user;
    }

    private static IntegrationTransport Tmdb(Func<string> body, int status = 200)
        => new((request, _) =>
        {
            Assert.Equal("api.themoviedb.org", request.RequestUri!.Host);
            return Task.FromResult(IntegrationTransport.Response(body(), status));
        });

    private static Task<bool> May(SeerrParentalFilter gate, User user, int id = 603) => gate.MaySeeAbsentAsync("movie", id, user.Id.ToString("N"), default);

    [Fact]
    public async Task AfterARestartSavedFactsDecideWithNoTmdbRequest()
    {
        using var plugin = Je();
        var kid = Kid();
        using var network = Tmdb(() => IntegrationParentalEvidenceTests.Movie(603));
        Assert.True(await May(Process(plugin, network, new[] { kid }), kid));
        await IntegrationTmdbDiskCacheTests.Until(() => Facts() == 1);
        Assert.Equal(1, network.Calls);

        var restarted = Process(plugin, network, new[] { kid });
        Assert.True(await May(restarted, kid));
        Assert.True(restarted.AbsentVerdict("movie", 603, kid.Id.ToString("N")));
        Assert.Equal(1, network.Calls);
    }

    [Fact]
    public async Task OneRecordGivesEachViewerTheirOwnDecisionAndARestrictedAdminIsNotExempt()
    {
        using var plugin = Je();
        var kid = Kid(max: 10);
        var teen = Kid(max: 20, role: "Member");
        var admin = Kid(max: 10, role: "Admin", admin: true);
        using var network = Tmdb(() => IntegrationParentalEvidenceTests.Movie(603, rating: "R"));
        Assert.True(await May(Process(plugin, network, new[] { teen }), teen));
        await IntegrationTmdbDiskCacheTests.Until(() => Facts() == 1);

        var restarted = Process(plugin, network, new[] { kid, teen, admin });
        Assert.False(await May(restarted, kid));
        Assert.True(await May(restarted, teen));
        Assert.False(await May(restarted, admin));
        Assert.Equal(1, network.Calls);
    }

    [Fact]
    public async Task AFreshLocalRatingStillWinsOverSavedRemoteFacts()
    {
        using var plugin = Je();
        var kid = Kid(tags: false);
        using var network = Tmdb(() => IntegrationParentalEvidenceTests.Movie(603, rating: "G"));
        Assert.True(await May(Process(plugin, network, new[] { kid }), kid));
        await IntegrationTmdbDiskCacheTests.Until(() => Facts() == 1);

        // The library copy was rated R since: its native rating decides at once, with no restart of the facts.
        var item = new Movie { Id = Guid.NewGuid(), Path = "/movies/a.mkv", CustomRating = "R" };
        item.ProviderIds["Tmdb"] = "603";
        var library = new Mock<ILibraryManager>();
        library.Setup(m => m.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(new List<BaseItem> { item });
        Assert.False(await May(Process(plugin, network, new[] { kid }, library.Object), kid));
        Assert.Equal(1, network.Calls);
    }

    [Theory]
    [InlineData("unrated")]
    [InlineData("adult")]
    [InlineData("failure")]
    [InlineData("partial")]
    public async Task UnscorableAdultFailedOrPartialEvidenceIsNeverSaved(string scenario)
    {
        using var plugin = Je();
        var kid = Kid();
        var body = scenario switch
        {
            "unrated" => IntegrationParentalEvidenceTests.Movie(603, rating: ""),
            "adult" => IntegrationParentalEvidenceTests.Movie(603, adult: true),
            "partial" => "{\"id\":603,\"adult\":false,\"release_dates\":{\"results\":[{\"iso_3166_1\":\"US\",\"release_dates\":[{\"certification\":\"G\"}]}]}}",
            _ => "{}",
        };
        using var network = Tmdb(() => body, scenario == "failure" ? 503 : 200);
        Assert.False(await May(Process(plugin, network, new[] { kid }), kid));
        await Task.Delay(150);
        Assert.Equal(0, Facts());
        var calls = network.Calls;
        Assert.False(await May(Process(plugin, network, new[] { kid }), kid));
        Assert.True(network.Calls > calls); // retried after a restart, never answered from a saved failure
    }

    [Fact]
    public async Task ARatingOnlyRecordNeverAnswersATagReadButATagRecordAnswersARatingRead()
    {
        using var plugin = Je();
        var ratingOnly = Kid(tags: false);
        var tagged = Kid(tags: true, role: "Member");
        using var network = Tmdb(() => IntegrationParentalEvidenceTests.Movie(603));
        Assert.True(await May(Process(plugin, network, new[] { ratingOnly }), ratingOnly));
        await IntegrationTmdbDiskCacheTests.Until(() => Facts() == 1);
        Assert.True(await May(Process(plugin, network, new[] { tagged }), tagged));
        Assert.Equal(2, network.Calls);
        await IntegrationTmdbDiskCacheTests.Until(() => Facts() == 2);

        // Only the tag record is left: it answers both kinds of read.
        foreach (var file in Directory.EnumerateFiles(Folder, "*.blob", SearchOption.AllDirectories).Where(f => !File.ReadAllText(f).Contains("\"tags\"", StringComparison.Ordinal)))
            File.Delete(file);
        var restarted = Process(plugin, network, new[] { ratingOnly, tagged });
        Assert.True(await May(restarted, ratingOnly));
        Assert.True(await May(restarted, tagged));
        Assert.Equal(2, network.Calls);
    }

    [Fact]
    public async Task AnotherCountryOrCredentialMissesTheSavedFacts()
    {
        using var plugin = Je();
        var kid = Kid();
        using var network = Tmdb(() => IntegrationParentalEvidenceTests.Movie(603));
        Assert.True(await May(Process(plugin, network, new[] { kid }), kid));
        await IntegrationTmdbDiskCacheTests.Until(() => Facts() == 1);
        _country = "GB";
        await May(Process(plugin, network, new[] { kid }), kid);
        Assert.Equal(2, network.Calls);
        _country = "US";
        plugin.Plugin.Configuration.TMDB_API_KEY = "rotated";
        await May(Process(plugin, network, new[] { kid }), kid);
        Assert.Equal(3, network.Calls);
        plugin.Plugin.Configuration.TMDB_API_KEY = "test-tmdb";
        Assert.True(await May(Process(plugin, network, new[] { kid }), kid));
        Assert.Equal(3, network.Calls);
    }

    [Fact]
    public async Task AGenerationChangeDuringTheDiskReadReleasesNoAnswer()
    {
        using var plugin = Je();
        var kid = Kid();
        using var network = Tmdb(() => IntegrationParentalEvidenceTests.Movie(603));
        Assert.True(await May(Process(plugin, network, new[] { kid }), kid));
        await IntegrationTmdbDiskCacheTests.Until(() => Facts() == 1);

        var disk = Disk();
        var gate = Process(plugin, network, new[] { kid }, disk: disk);
        var advanced = 0;
        disk.Hook = point =>
        {
            // US -> AU -> US while the saved record is being read: same configuration, new generation.
            if (point == "read" && Interlocked.Exchange(ref advanced, 1) == 0) EvidenceRevision.Advance(() => { });
        };
        Assert.False(await gate.MaySeeAbsentAsync("movie", 603, kid.Id.ToString("N"), default));
        disk.Hook = null;
        Assert.Equal(1, advanced);
        // The next check scores the same facts under the current generation.
        Assert.True(await May(gate, kid));
        Assert.Equal(1, network.Calls);
    }

    [Fact]
    public async Task FactsExpireTwentyFourHoursAfterTheirTmdbReadAndAreNeverRenewed()
    {
        using var plugin = Je();
        var kid = Kid();
        using var network = Tmdb(() => IntegrationParentalEvidenceTests.Movie(603));
        Assert.True(await May(Process(plugin, network, new[] { kid }), kid));
        await IntegrationTmdbDiskCacheTests.Until(() => Facts() == 1);
        _clock.Now += TimeSpan.FromHours(23);
        Assert.True(await May(Process(plugin, network, new[] { kid }), kid));
        Assert.Equal(1, network.Calls);
        _clock.Now += TimeSpan.FromHours(1);
        Assert.True(await May(Process(plugin, network, new[] { kid }), kid));
        Assert.Equal(2, network.Calls);
    }

    [Fact]
    public async Task ACorruptedRecordIsAMiss()
    {
        using var plugin = Je();
        var kid = Kid();
        using var network = Tmdb(() => IntegrationParentalEvidenceTests.Movie(603));
        Assert.True(await May(Process(plugin, network, new[] { kid }), kid));
        await IntegrationTmdbDiskCacheTests.Until(() => Facts() == 1);
        var file = Directory.EnumerateFiles(Folder, "*.blob", SearchOption.AllDirectories).Single();
        File.WriteAllText(file, File.ReadAllText(file).Replace("\"id\":603", "\"id\":604", StringComparison.Ordinal));
        Assert.True(await May(Process(plugin, network, new[] { kid }), kid));
        Assert.Equal(2, network.Calls);
    }
}
