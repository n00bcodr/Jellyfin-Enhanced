using System.Net;
using System.Net.Sockets;
using System.Text;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using Microsoft.Extensions.DependencyInjection;
using Moq;

namespace JE.Tests;

/// <summary>The Leaving soon page's size for the one movie version that is leaving: only Reclaimerr knows which copy it is.</summary>
[Collection("Plugin singleton")]
public sealed class IntegrationReclaimerrVersionSizeTests : IDisposable
{
    private readonly ApiPluginFixture _f = new();
    private readonly Mock<ILibraryManager> _library = new();
    private readonly ILibraryManager? _previousLibrary = BaseItem.LibraryManager;

    public IntegrationReclaimerrVersionSizeTests() => BaseItem.LibraryManager = _library.Object;

    public void Dispose()
    {
        BaseItem.LibraryManager = _previousLibrary!;
        _f.Dispose();
    }

    private sealed class Server : IDisposable
    {
        private readonly HttpListener _listener = new();
        public string Url { get; }
        public List<string> Seen { get; } = new();
        public Func<string, string> Answer { get; set; } = _ => "{}";

        public Server()
        {
            var probe = new TcpListener(IPAddress.Loopback, 0);
            probe.Start();
            var port = ((IPEndPoint)probe.LocalEndpoint).Port;
            probe.Stop();
            Url = $"http://127.0.0.1:{port}";
            _listener.Prefixes.Add(Url + "/");
            _listener.Start();
            _ = Task.Run(async () =>
            {
                while (true)
                {
                    HttpListenerContext context;
                    try { context = await _listener.GetContextAsync(); } catch { return; }
                    try
                    {
                        var path = context.Request.Url!.PathAndQuery;
                        lock (Seen) Seen.Add(path);
                        var bytes = Encoding.UTF8.GetBytes(Answer(path));
                        context.Response.ContentType = "application/json";
                        context.Response.ContentLength64 = bytes.Length;
                        await context.Response.OutputStream.WriteAsync(bytes);
                    }
                    catch { /* client gone */ }
                    finally { try { context.Response.Close(); } catch { } }
                }
            });
        }

        public void Dispose() => _listener.Close();
    }

    private ReclaimerrActions Actions(Server server)
    {
        var config = _f.Plugin.Configuration;
        config.ReclaimerrEnabled = true;
        config.ReclaimerrUrl = server.Url;
        config.ReclaimerrToken = "rcl_token";
        config.ReclaimerrUsername = "jellyfin-enhanced";
        config.ReclaimerrActAsUser = true;
        var services = new ServiceCollection();
        LeavingSoonService.AddHttpClient(services);
        var clients = services.BuildServiceProvider().GetRequiredService<IHttpClientFactory>();
        var leaving = new LeavingSoonService(clients, Path.Combine(_f.Core.Root, "leaving-soon.json"), _library.Object, _f.Core.Logger) { Timeout = TimeSpan.FromSeconds(5) };
        var cache = new TagCacheService(_library.Object, _f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), _f.Core.Logger, new MatroskaLanguageCache(_f.Core.Paths.Object, _f.Core.Logger), leavingSoonService: leaving);
        return new ReclaimerrActions(clients, leaving, cache, _f.Core.Logger) { Timeout = TimeSpan.FromSeconds(5) };
    }

    private static Movie Film()
    {
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Jailer 2" };
        movie.SetProviderId(MetadataProvider.Tmdb, "555");
        return movie;
    }

    [Fact]
    public async Task A_scheduled_deletion_gives_its_own_estimate_and_it_is_kept_between_asks()
    {
        using var server = new Server();
        server.Answer = path => path == "/api/media/scheduled-deletions"
            ? "[{\"id\":4,\"state\":\"scheduled\",\"target\":{\"estimated_space_bytes\":3221225472}},{\"id\":5,\"state\":\"scheduled\",\"target\":{\"estimated_space_bytes\":1}}]"
            : "{}";
        var actions = Actions(server);
        Assert.Equal(3221225472L, await actions.VersionSizeAsync(Film(), -4, _f.Plugin.Configuration, CancellationToken.None));
        Assert.Equal(3221225472L, await actions.VersionSizeAsync(Film(), -4, _f.Plugin.Configuration, CancellationToken.None));
        Assert.Single(server.Seen.Where(p => p == "/api/media/scheduled-deletions"));
    }

    [Fact]
    public async Task A_candidate_gives_the_size_of_the_version_it_names_not_of_another_copy()
    {
        using var server = new Server();
        server.Answer = path =>
        {
            if (path == "/api/v1/candidates/9") return "{\"id\":9,\"scope\":\"version\",\"movie_version_id\":22,\"tmdb_id\":555}";
            if (path.StartsWith("/api/media/movies?")) return "{\"items\":[{\"tmdb_id\":999,\"versions\":[{\"id\":22,\"size\":7}]},{\"tmdb_id\":555,\"versions\":[{\"id\":21,\"size\":8000000000},{\"id\":22,\"size\":3400000000}]}]}";
            return "{}";
        };
        var actions = Actions(server);
        Assert.Equal(3400000000L, await actions.VersionSizeAsync(Film(), 9, _f.Plugin.Configuration, CancellationToken.None));
    }

    [Fact]
    public async Task Without_an_answer_the_size_is_unknown_instead_of_wrong()
    {
        using var server = new Server();
        server.Answer = path => path == "/api/v1/candidates/9" ? "{\"id\":9,\"scope\":\"version\",\"tmdb_id\":555}" : "{\"items\":[]}";
        var actions = Actions(server);
        Assert.Null(await actions.VersionSizeAsync(Film(), 9, _f.Plugin.Configuration, CancellationToken.None));
        Assert.Null(await actions.VersionSizeAsync(Film(), 0, _f.Plugin.Configuration, CancellationToken.None));
    }
}
