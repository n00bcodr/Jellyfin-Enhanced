using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Globalization;
using Microsoft.Extensions.DependencyInjection;
using Moq;

namespace JE.Tests;

/// <summary>
/// Approving a Reclaimerr deletion request on a day. An older Reclaimerr ignores <c>scheduled_at</c> and deletes at once, so the day is
/// only sent to one whose OpenAPI names the approve body that takes it; omitting the field keeps the old call exactly.
/// </summary>
[Collection("Plugin singleton")]
public sealed class IntegrationReclaimerrApprovalTimingTests : IDisposable
{
    private readonly ApiPluginFixture _f = new();
    private readonly Mock<ILibraryManager> _library = new();
    private readonly ILibraryManager? _previousLibrary = BaseItem.LibraryManager;
    private static readonly DateTimeOffset Fixed = new(2026, 11, 20, 12, 0, 0, TimeSpan.Zero);

    public IntegrationReclaimerrApprovalTimingTests() => BaseItem.LibraryManager = _library.Object;

    public void Dispose()
    {
        BaseItem.LibraryManager = _previousLibrary!;
        _f.Dispose();
    }

    private sealed class Server : IDisposable
    {
        private readonly HttpListener _listener = new();
        public string Url { get; }
        public List<(string Method, string Path, string Body)> Seen { get; } = new();
        public bool Supports { get; set; }
        public Dictionary<string, string> Extra { get; } = new();

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
                        using var reader = new StreamReader(context.Request.InputStream);
                        var body = await reader.ReadToEndAsync();
                        var path = context.Request.Url!.PathAndQuery;
                        lock (Seen) Seen.Add((context.Request.HttpMethod, path, body));
                        var answer = Extra.TryGetValue(path, out var extra) ? extra
                            : path == "/openapi.json"
                            ? "{\"components\":{\"schemas\":{\"ReviewDeleteRequest\":{}" + (Supports ? ",\"ApproveDeleteRequest\":{}" : string.Empty) + "}}}"
                            : "{}";
                        var bytes = Encoding.UTF8.GetBytes(answer);
                        context.Response.ContentType = "application/json";
                        context.Response.ContentLength64 = bytes.Length;
                        await context.Response.OutputStream.WriteAsync(bytes);
                    }
                    catch { /* client gone */ }
                    finally { try { context.Response.Close(); } catch { } }
                }
            });
        }

        public List<(string Method, string Path, string Body)> Posts { get { lock (Seen) return Seen.Where(s => s.Method == "POST").ToList(); } }

        public void Dispose() => _listener.Close();
    }

    private ReclaimerrActions Actions(Server server)
    {
        var config = _f.Plugin.Configuration;
        config.ReclaimerrEnabled = true;
        config.LeavingSoonMaintainerrActions = true;
        config.ReclaimerrUrl = server.Url;
        config.ReclaimerrToken = "rcl_token";
        config.ReclaimerrUsername = "jellyfin-enhanced";
        config.ReclaimerrActAsUser = true;
        var services = new ServiceCollection();
        LeavingSoonService.AddHttpClient(services);
        var clients = services.BuildServiceProvider().GetRequiredService<IHttpClientFactory>();
        var leaving = new LeavingSoonService(clients, Path.Combine(_f.Core.Root, "leaving-soon.json"), _library.Object, _f.Core.Logger) { Timeout = TimeSpan.FromSeconds(5) };
        var cache = new TagCacheService(_library.Object, _f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), _f.Core.Logger, new MatroskaLanguageCache(_f.Core.Paths.Object, _f.Core.Logger), leavingSoonService: leaving);
        return new ReclaimerrActions(clients, leaving, cache, _f.Core.Logger) { Timeout = TimeSpan.FromSeconds(5), Now = () => Fixed };
    }

    private static JsonElement Body((string Method, string Path, string Body) post) => JsonDocument.Parse(post.Body).RootElement;

    [Fact]
    public async Task Scheduling_is_supported_only_when_the_approve_body_that_takes_a_day_is_in_the_OpenAPI()
    {
        using var server = new Server();
        var actions = Actions(server);
        Assert.False(await actions.SchedulingSupportedAsync(_f.Plugin.Configuration, CancellationToken.None));
        server.Supports = true;
        // Kept for ten minutes, so a new answer is read by a new instance.
        Assert.True(await Actions(server).SchedulingSupportedAsync(_f.Plugin.Configuration, CancellationToken.None));
    }

    [Fact]
    public async Task Approving_without_a_day_sends_the_old_body_so_an_older_Reclaimerr_behaves_as_before()
    {
        using var server = new Server();
        await Actions(server).ReviewRequestAsync(7, true, "ok", null, _f.Plugin.Configuration, CancellationToken.None);
        var post = Assert.Single(server.Posts);
        Assert.Equal("/api/delete-requests/7/approve", post.Path);
        var body = Body(post);
        Assert.Equal("ok", body.GetProperty("admin_notes").GetString());
        Assert.False(body.TryGetProperty("scheduled_at", out _), "omitting it is what asks for Reclaimerr's grace period");
        Assert.DoesNotContain(server.Seen, s => s.Path == "/openapi.json");
    }

    [Fact]
    public async Task Approving_now_sends_scheduled_at_null_and_on_a_day_sends_that_moment_in_UTC()
    {
        using var server = new Server { Supports = true };
        var actions = Actions(server);
        await actions.ReviewRequestAsync(7, true, null, null, _f.Plugin.Configuration, CancellationToken.None, ReclaimerrActions.ApprovalTiming.Now);
        var now = Body(server.Posts[0]);
        Assert.True(now.TryGetProperty("scheduled_at", out var nothing));
        Assert.Equal(JsonValueKind.Null, nothing.ValueKind);

        await actions.ReviewRequestAsync(8, true, null, null, _f.Plugin.Configuration, CancellationToken.None, ReclaimerrActions.ApprovalTiming.OnDate, new DateTimeOffset(2026, 12, 10, 18, 30, 0, TimeSpan.FromHours(5.5)));
        var later = server.Posts[1];
        Assert.Equal("/api/delete-requests/8/approve", later.Path);
        Assert.Equal("2026-12-10T13:00:00Z", Body(later).GetProperty("scheduled_at").GetString());
    }

    [Fact]
    public async Task A_day_is_refused_without_calling_approve_when_Reclaimerr_cannot_schedule_or_the_day_is_past_or_missing()
    {
        using var server = new Server { Supports = false };
        var ex = await Assert.ThrowsAsync<MaintainerrActions.ActionException>(() => Actions(server).ReviewRequestAsync(7, true, null, null, _f.Plugin.Configuration, CancellationToken.None, ReclaimerrActions.ApprovalTiming.OnDate, Fixed.AddDays(3)));
        Assert.Contains("cannot schedule", ex.Message);
        await Assert.ThrowsAsync<MaintainerrActions.ActionException>(() => Actions(server).ReviewRequestAsync(7, true, null, null, _f.Plugin.Configuration, CancellationToken.None, ReclaimerrActions.ApprovalTiming.Now));
        Assert.Empty(server.Posts);

        using var modern = new Server { Supports = true };
        var actions = Actions(modern);
        await Assert.ThrowsAsync<MaintainerrActions.ActionException>(() => actions.ReviewRequestAsync(7, true, null, null, _f.Plugin.Configuration, CancellationToken.None, ReclaimerrActions.ApprovalTiming.OnDate, Fixed.AddDays(-1)));
        await Assert.ThrowsAsync<MaintainerrActions.ActionException>(() => actions.ReviewRequestAsync(7, true, null, null, _f.Plugin.Configuration, CancellationToken.None, ReclaimerrActions.ApprovalTiming.OnDate, null));
        Assert.Empty(modern.Posts);
    }

    [Fact]
    public async Task An_approval_reads_the_Leaving_soon_facts_again_at_once_and_a_denial_does_not()
    {
        using var server = new Server { Supports = true };
        var actions = Actions(server);
        await actions.ReviewRequestAsync(8, false, null, null, _f.Plugin.Configuration, CancellationToken.None);
        Assert.DoesNotContain(server.Seen, s => s.Path.StartsWith("/api/v1/candidates"));
        await actions.ReviewRequestAsync(7, true, null, null, _f.Plugin.Configuration, CancellationToken.None, ReclaimerrActions.ApprovalTiming.OnDate, Fixed.AddDays(5));
        Assert.Contains(server.Seen, s => s.Path.StartsWith("/api/v1/candidates"));
    }

    [Fact]
    public void The_mapping_reads_both_ways_so_a_Reclaimerr_account_is_found_for_its_Jellyfin_name()
    {
        var config = _f.Plugin.Configuration;
        config.ReclaimerrUserMap = "Sudhakar = Sudhakar\nATM = ATM_user\n  Home =Home_user \nbroken\n=nothing";
        Assert.Equal("ATM", ReclaimerrSession.MappedJellyfinUser(config, "ATM_user"));
        Assert.Equal("ATM", ReclaimerrSession.MappedJellyfinUser(config, "atm_user"));
        Assert.Equal("Home", ReclaimerrSession.MappedJellyfinUser(config, "Home_user"));
        Assert.Null(ReclaimerrSession.MappedJellyfinUser(config, "Nobody"));
        Assert.Equal("ATM_user", ReclaimerrSession.MappedUser(config, "ATM"));
    }

    [Fact]
    public async Task A_Reclaimerr_account_is_named_by_the_mapping_else_by_the_Jellyfin_login_Reclaimerr_linked_to_it()
    {
        using var server = new Server();
        server.Extra["/api/account/users"] = "[{\"id\":18,\"username\":\"Pat_user\"},{\"id\":19,\"username\":\"Sam_user\"}]";
        server.Extra["/api/account/users/media-identities"] = "[{\"source_service\":\"jellyfin\",\"username\":\"Pat\",\"user_id\":18}]";
        var config = _f.Plugin.Configuration;
        config.ReclaimerrUserMap = "ATM = ATM_user";
        var actions = Actions(server);
        Assert.Equal("ATM", await actions.JellyfinNameOfAsync(config, "ATM_user", CancellationToken.None));
        Assert.Empty(server.Seen);
        Assert.Equal("pat", await actions.JellyfinNameOfAsync(config, "Pat_user", CancellationToken.None));
        Assert.Null(await actions.JellyfinNameOfAsync(config, "Sam_user", CancellationToken.None));
        Assert.Null(await actions.JellyfinNameOfAsync(config, "", CancellationToken.None));
    }

    [Fact]
    public async Task The_grace_period_is_read_from_Reclaimerr_and_unknown_when_it_cannot_be()
    {
        using var server = new Server();
        server.Extra["/api/settings/general"] = "{\"delete_request_grace_period_days\":14}";
        Assert.Equal(14, await Actions(server).GracePeriodDaysAsync(_f.Plugin.Configuration, CancellationToken.None));

        using var older = new Server();
        older.Extra["/api/settings/general"] = "{\"auto_delete_movie_delay_days\":14}";
        Assert.Null(await Actions(older).GracePeriodDaysAsync(_f.Plugin.Configuration, CancellationToken.None));
    }

    [Fact]
    public async Task Denying_never_carries_a_day()
    {
        using var server = new Server { Supports = true };
        await Actions(server).ReviewRequestAsync(7, false, null, null, _f.Plugin.Configuration, CancellationToken.None, ReclaimerrActions.ApprovalTiming.Now);
        var post = Assert.Single(server.Posts);
        Assert.Equal("/api/delete-requests/7/deny", post.Path);
        Assert.False(Body(post).TryGetProperty("scheduled_at", out _));
    }
}
