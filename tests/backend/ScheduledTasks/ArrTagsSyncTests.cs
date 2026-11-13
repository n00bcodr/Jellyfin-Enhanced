using System.Net;
using Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Moq;

namespace JE.Tests;

/// <summary>
/// The *arr tag sync against mocked Radarr and Sonarr instances. A service that could not be read is
/// unknown, not "no tags": "Clear old tags before sync" must not strip its items' tags that run.
/// </summary>
[Collection("Plugin singleton")]
public class ArrTagsSyncTests
{
    private const int RadarrMain = 7878, RadarrSecond = 7879, Sonarr = 8989;
    private const string Prefix = "Arr: ";

    // Movie 101 is in both Radarr instances, movie 103 in neither; series tt201 is in Sonarr.
    private static string Healthy(int port, string path) => (port, path) switch
    {
        (RadarrMain, "/api/v3/tag") => "[{\"id\":1,\"label\":\"alice\"},{\"id\":2,\"label\":\"bob\"}]",
        (RadarrMain, "/api/v3/movie") => "[{\"tmdbId\":101,\"tags\":[1]},{\"tmdbId\":102,\"tags\":[2]}]",
        (RadarrSecond, "/api/v3/tag") => "[{\"id\":5,\"label\":\"carol\"}]",
        (RadarrSecond, "/api/v3/movie") => "[{\"tmdbId\":101,\"tags\":[5]}]",
        (Sonarr, "/api/v3/tag") => "[{\"id\":1,\"label\":\"dave\"}]",
        (Sonarr, "/api/v3/series") => "[{\"tvdbId\":9,\"imdbId\":\"tt201\",\"tags\":[1]}]",
        _ => throw new InvalidOperationException($"Unexpected request to port {port}: {path}")
    };

    // How an instance that is down, broken or empty answers.
    private static Task<HttpResponseMessage> Failing(string failure, string path) => failure switch
    {
        // Reachable and readable, with no tags and no titles: a real answer, not a failure.
        "empty" => Task.FromResult(IntegrationTransport.Response("[]")),
        "network" => throw new HttpRequestException("Connection refused"),
        "timeout" => throw new TaskCanceledException("The request was canceled due to the configured HttpClient.Timeout"),
        "401" => Task.FromResult(IntegrationTransport.Response("[]", 401)),
        "503" => Task.FromResult(IntegrationTransport.Response("[]", 503)),
        "html" => Task.FromResult(IntegrationTransport.Response("<html>login</html>", 200, "text/html")),
        "truncated" => Task.FromResult(IntegrationTransport.Response("[{\"id\":1,\"lab")),
        "null" => Task.FromResult(IntegrationTransport.Response("null")),
        // The tag list answers, the movie or series list does not.
        "list-500" => Task.FromResult(path.EndsWith("/tag", StringComparison.Ordinal)
            ? IntegrationTransport.Response("[{\"id\":1,\"label\":\"alice\"}]")
            : IntegrationTransport.Response("{\"message\":\"Internal error\"}", 500)),
        _ => throw new ArgumentOutOfRangeException(nameof(failure), failure, null)
    };

    private sealed class Library
    {
        public readonly Movie Matched = new() { Id = Guid.NewGuid(), Name = "Matched movie", Tags = ["Keep", "Arr: stale"], ProviderIds = new() { ["Tmdb"] = "101" } };
        public readonly Movie Unmatched = new() { Id = Guid.NewGuid(), Name = "Unmatched movie", Tags = ["Arr: old", "Keep"], ProviderIds = new() { ["Tmdb"] = "103" } };
        public readonly Series Show = new() { Id = Guid.NewGuid(), Name = "Show", Tags = ["Arr: stale", "Keep"], ProviderIds = new() { ["Imdb"] = "tt201" } };
        public readonly Mock<ILibraryManager> Manager = new();
        public int Writes;

        public Library()
        {
            Manager.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(new BaseItem[] { Matched, Unmatched, Show });
            Manager.Setup(l => l.UpdateItemAsync(It.IsAny<BaseItem>(), It.IsAny<BaseItem>(), ItemUpdateType.MetadataEdit, It.IsAny<CancellationToken>()))
                .Callback(() => Interlocked.Increment(ref Writes)).Returns(Task.CompletedTask);
        }
    }

    private static string Instances(params (string Name, string Url)[] instances) =>
        "[" + string.Join(",", instances.Select(i => $"{{\"Name\":\"{i.Name}\",\"Url\":\"{i.Url}\",\"ApiKey\":\"test-key\",\"Enabled\":true}}")) + "]";

    /// <summary>
    /// Runs the sync with two Radarr instances and one Sonarr (unless <paramref name="radarr"/> or
    /// <paramref name="sonarr"/> replaces a stored list); the ports in <paramref name="down"/> answer with <paramref name="failure"/>.
    /// </summary>
    private static async Task<(Library Library, string Log)> Sync(ApiPluginFixture f, string failure, int[] down, string? radarr = null, string? sonarr = null)
    {
        var config = f.Plugin.Configuration;
        config.ArrTagsSyncEnabled = true;
        config.ArrTagsClearOldTags = true;
        config.ArrTagsPrefix = Prefix;
        config.RadarrInstances = radarr ?? Instances(("Main", $"http://127.0.0.1:{RadarrMain}"), ("Second", $"http://127.0.0.1:{RadarrSecond}"));
        config.SonarrInstances = sonarr ?? Instances(("Shows", $"http://127.0.0.1:{Sonarr}"));
        var library = new Library();
        using var transport = new IntegrationTransport((request, _) =>
        {
            Assert.Equal("test-key", Assert.Single(request.Headers.GetValues("X-Api-Key")));
            var port = request.RequestUri!.Port;
            var path = request.RequestUri.AbsolutePath;
            return down.Contains(port) ? Failing(failure, path) : Task.FromResult(IntegrationTransport.Response(Healthy(port, path)));
        });
        var previous = BaseItem.LibraryManager;
        BaseItem.LibraryManager = library.Manager.Object;
        try
        {
            await new ArrTagsSyncTask(library.Manager.Object, transport, f.Core.Logger).ExecuteAsync(new Progress<double>(), default);
        }
        finally { BaseItem.LibraryManager = previous; }
        return (library, File.ReadAllText(f.Core.Logger.CurrentLogFilePath));
    }

    [Fact]
    public async Task NormalSyncReplacesStalePrefixedTagsMergesInstancesAndKeepsOtherTags()
    {
        using var f = new ApiPluginFixture();
        var (library, log) = await Sync(f, "none", []);

        Assert.Equal(new[] { "Keep", "Arr: alice", "Arr: carol" }, library.Matched.Tags);
        // An item no answering instance lists loses its prefixed tags, as before.
        Assert.Equal(new[] { "Keep" }, library.Unmatched.Tags);
        Assert.Equal(new[] { "Keep", "Arr: dave" }, library.Show.Tags);
        Assert.Equal(3, library.Writes);
        Assert.DoesNotContain("could not be read", log);
    }

    [Fact]
    public async Task AServiceThatAnswersWithNoTagsStillClearsItsItems()
    {
        using var f = new ApiPluginFixture();
        // Reachable instances whose tags were all removed: "no tags" clears, as before.
        var (library, log) = await Sync(f, "empty", [RadarrMain, RadarrSecond, Sonarr]);

        Assert.Equal(new[] { "Keep" }, library.Matched.Tags);
        Assert.Equal(new[] { "Keep" }, library.Unmatched.Tags);
        Assert.Equal(new[] { "Keep" }, library.Show.Tags);
        Assert.DoesNotContain("could not be read", log);
    }

    [Theory]
    [InlineData("network")]
    [InlineData("timeout")]
    public async Task OneRadarrInstanceDownKeepsMovieTagsAndStillAddsTheOtherInstancesTags(string failure)
    {
        using var f = new ApiPluginFixture();
        var (library, log) = await Sync(f, failure, [RadarrSecond]);

        // The second instance may still list these movies: their synced tags stay, and the
        // instance that answered adds its own.
        Assert.Equal(new[] { "Keep", "Arr: stale", "Arr: alice" }, library.Matched.Tags);
        Assert.Equal(new[] { "Arr: old", "Keep" }, library.Unmatched.Tags);
        Assert.Equal(new[] { "Keep", "Arr: dave" }, library.Show.Tags);
        Assert.Contains("Radarr could not be read", log);
        Assert.DoesNotContain("Sonarr could not be read", log);
    }

    [Theory]
    [InlineData("radarr")]
    [InlineData("sonarr")]
    public async Task OneServiceDownKeepsItsItemsTagsAndTheOtherServiceStillSyncs(string service)
    {
        using var f = new ApiPluginFixture();
        var (library, _) = service == "radarr"
            ? await Sync(f, "network", [RadarrMain, RadarrSecond])
            : await Sync(f, "network", [Sonarr]);

        if (service == "radarr")
        {
            Assert.Equal(new[] { "Keep", "Arr: stale" }, library.Matched.Tags);
            Assert.Equal(new[] { "Arr: old", "Keep" }, library.Unmatched.Tags);
            Assert.Equal(new[] { "Keep", "Arr: dave" }, library.Show.Tags);
        }
        else
        {
            Assert.Equal(new[] { "Keep", "Arr: alice", "Arr: carol" }, library.Matched.Tags);
            Assert.Equal(new[] { "Keep" }, library.Unmatched.Tags);
            Assert.Equal(new[] { "Arr: stale", "Keep" }, library.Show.Tags);
        }
    }

    [Theory]
    [InlineData("network")]
    [InlineData("timeout")]
    [InlineData("503")]
    public async Task EveryInstanceDownChangesNoItem(string failure)
    {
        using var f = new ApiPluginFixture();
        var (library, log) = await Sync(f, failure, [RadarrMain, RadarrSecond, Sonarr]);

        Assert.Equal(new[] { "Keep", "Arr: stale" }, library.Matched.Tags);
        Assert.Equal(new[] { "Arr: old", "Keep" }, library.Unmatched.Tags);
        Assert.Equal(new[] { "Arr: stale", "Keep" }, library.Show.Tags);
        Assert.Equal(0, library.Writes);
        Assert.Contains("Radarr could not be read", log);
        Assert.Contains("Sonarr could not be read", log);
    }

    // An instance that answers, but with an error status or something that is not its tag list.
    [Theory]
    [InlineData("radarr", "401")][InlineData("radarr", "503")][InlineData("radarr", "html")][InlineData("radarr", "truncated")][InlineData("radarr", "null")][InlineData("radarr", "list-500")]
    [InlineData("sonarr", "401")][InlineData("sonarr", "503")][InlineData("sonarr", "html")][InlineData("sonarr", "truncated")][InlineData("sonarr", "null")][InlineData("sonarr", "list-500")]
    public async Task AnInstanceThatAnswersWithAnErrorKeepsItsServicesTags(string service, string failure)
    {
        using var f = new ApiPluginFixture();
        var (library, _) = service == "radarr"
            ? await Sync(f, failure, [RadarrMain, RadarrSecond])
            : await Sync(f, failure, [Sonarr]);

        var (unread, answered, expected) = service == "radarr"
            ? ((BaseItem)library.Matched, (BaseItem)library.Show, new[] { "Keep", "Arr: dave" })
            : (library.Show, library.Matched, new[] { "Keep", "Arr: alice", "Arr: carol" });
        Assert.Equal(service == "radarr" ? new[] { "Keep", "Arr: stale" } : new[] { "Arr: stale", "Keep" }, unread.Tags);
        Assert.Equal(expected, answered.Tags);
    }

    // A stored instance list that cannot be parsed, or an instance URL the request guard refuses,
    // is no answer either.
    [Theory]
    [InlineData("radarr", "corrupt")][InlineData("radarr", "refused")]
    [InlineData("sonarr", "corrupt")][InlineData("sonarr", "refused")]
    public async Task AnInstanceListThatCannotBeUsedKeepsItsServicesTags(string service, string failure)
    {
        using var f = new ApiPluginFixture();
        var stored = failure == "corrupt" ? "[{\"Name\":\"Main\",\"Url\":\"http://127.0.0.1:7" : Instances(("Main", "http://169.254.169.254"));
        var (library, _) = service == "radarr"
            ? await Sync(f, "none", [], radarr: stored)
            : await Sync(f, "none", [], sonarr: stored);

        if (service == "radarr")
        {
            Assert.Equal(new[] { "Keep", "Arr: stale" }, library.Matched.Tags);
            Assert.Equal(new[] { "Arr: old", "Keep" }, library.Unmatched.Tags);
            Assert.Equal(new[] { "Keep", "Arr: dave" }, library.Show.Tags);
        }
        else
        {
            Assert.Equal(new[] { "Keep", "Arr: alice", "Arr: carol" }, library.Matched.Tags);
            Assert.Equal(new[] { "Arr: stale", "Keep" }, library.Show.Tags);
        }
    }
}
