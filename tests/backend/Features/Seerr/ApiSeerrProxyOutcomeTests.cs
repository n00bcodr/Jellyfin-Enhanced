using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Seerr;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Seerr;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Parental;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Globalization;
using Microsoft.AspNetCore.Mvc;
using Moq;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Seerr.Services;

namespace JE.Tests.Features.Seerr;

/// <summary>
/// The Seerr proxy's write outcomes (docs/rewrite/seerr-proxy-outcomes.md): a write handed to a
/// Seerr URL is never retried or failed over, and every failed write says whether it may have
/// been applied. Reads keep their bounded retry and failover. Drives the real controller routes
/// through the production client shape (SeerrCsrfHandler over the primary handler). These tests
/// only inspect the serialized envelope, so they also compile against the baseline controller.
/// </summary>
[Collection("Plugin singleton")]
public class ApiSeerrProxyOutcomeTests
{
    private const string RequestBody = "{\"mediaType\":\"movie\",\"mediaId\":550}";

    /// <summary>Production client shape: SeerrCsrfHandler over a primary handler (PluginServiceRegistrator).</summary>
    private sealed class SeerrClientFactory(Func<HttpMessageHandler> primary) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(new SeerrCsrfHandler { InnerHandler = primary() }, true);
    }

    /// <summary>Synthetic Seerr instances: answers the user lookup and CSRF probe, routes everything else to <see cref="Reply"/>.</summary>
    private sealed class FakeSeerr : HttpMessageHandler
    {
        public Func<Guid> User { get; init; } = Guid.NewGuid;
        public Func<JellyseerrPermission> Permissions { get; init; } = () => JellyseerrPermission.REQUEST;
        public ConcurrentQueue<(string Host, string Method, string Path)> Calls { get; } = new();
        public Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> Reply { get; set; } =
            (_, _) => Task.FromResult(Json("{\"id\":99}", 201));

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var uri = request.RequestUri!;
            Calls.Enqueue((uri.Host, request.Method.Method, uri.PathAndQuery));
            if (request.Method == HttpMethod.Get && uri.PathAndQuery.StartsWith("/api/v1/user?", StringComparison.Ordinal))
                return Json(JsonSerializer.Serialize(new { results = new[] { new { id = 27, jellyfinUserId = User().ToString("N"), permissions = (int)Permissions() } } }));
            if (request.Method == HttpMethod.Get && uri.AbsolutePath == "/api/v1/status") return Json("{}");
            return await Reply(request, ct);
        }

        /// <summary>Non-lookup traffic for a host, excluding the CSRF probe and user lookup.</summary>
        public int Count(string host, string method) => Calls.Count(c => c.Host == host && c.Method == method && !c.Path.StartsWith("/api/v1/user?") && c.Path != "/api/v1/status");
    }

    private sealed class Proxy : IDisposable
    {
        public ApiPluginFixture Plugin { get; } = new();
        public Guid UserId { get; } = Guid.NewGuid();
        public JellyseerrPermission Permissions { get; set; } = JellyseerrPermission.REQUEST;
        public string HostA { get; } = "seerr-a-" + Guid.NewGuid().ToString("N") + ".invalid";
        public string HostB { get; } = "seerr-b-" + Guid.NewGuid().ToString("N") + ".invalid";
        public FakeSeerr Fake { get; }
        public JeSeerrController Controller { get; }

        public Proxy(string? urls = null, Func<HttpMessageHandler>? primary = null)
        {
            SeerrCaches.ClearAllSeerrCachesOnConfigChange();
            var config = Plugin.Plugin.Configuration;
            config.JellyseerrEnabled = true;
            config.JellyseerrAutoImportUsers = false;
            config.JellyseerrUrls = urls ?? $"http://{HostA}\nhttp://{HostB}";
            config.JellyseerrApiKey = "test-secret";
            config.SpoilerAutoEnableOnSeerrRequest = false;
            Fake = new FakeSeerr { User = () => UserId, Permissions = () => Permissions };
            var factory = new SeerrClientFactory(primary ?? (() => new Forwarder(Fake)));
            var users = Mock.Of<IUserManager>();
            var filter = new SeerrParentalFilter(factory, users, Mock.Of<ILocalizationManager>(), Mock.Of<IServerConfigurationManager>(), Plugin.Core.Logger);
            Controller = (JeSeerrController)ApiAssetTests.Controller(typeof(JeSeerrController), Plugin.Core, factory, users, filter);
            SetUser(admin: false);
        }

        public void SetUser(bool admin) => Controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([
            new Claim("Jellyfin-UserId", UserId.ToString()), new Claim(ClaimTypes.Role, admin ? "Administrator" : "User")], "test"));

        public Task<IActionResult> Request() => Controller.JellyseerrRequest(JsonSerializer.Deserialize<JsonElement>(RequestBody));

        public void Dispose() { SeerrCaches.ClearAllSeerrCachesOnConfigChange(); Plugin.Dispose(); }
    }

    /// <summary>Lets each HttpClient own (and dispose) its handler while the fake's state is shared.</summary>
    private sealed class Forwarder(FakeSeerr fake) : HttpMessageHandler
    {
        private readonly HttpMessageInvoker _invoker = new(fake, false);
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) => _invoker.SendAsync(request, ct);
    }

    private static HttpResponseMessage Json(string body, int status = 200) =>
        new((HttpStatusCode)status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    /// <summary>The envelope as the Jellyfin host serializes it.</summary>
    private static (int Status, JsonElement Body) Failure(IActionResult result)
    {
        var obj = Assert.IsAssignableFrom<ObjectResult>(result);
        var json = JsonSerializer.Serialize(obj.Value, Jellyfin.Extensions.Json.JsonDefaults.Options);
        return (obj.StatusCode ?? 0, JsonSerializer.Deserialize<JsonElement>(json));
    }

    private static string? Outcome(JsonElement body) =>
        body.TryGetProperty("requestOutcome", out var v) ? v.GetString() : null;

    public static TheoryData<string> LostReplies() => new() { "response-ended", "client-timeout", "io-reset", "handler-cancelled", "tls" };

    private static Exception LostReply(string kind) => kind switch
    {
        "response-ended" => new HttpRequestException(HttpRequestError.ResponseEnded, "The response ended prematurely."),
        // HttpClient.Timeout surfaces as TaskCanceledException wrapping TimeoutException; the browser did not cancel.
        "client-timeout" => new TaskCanceledException("The request was canceled due to the configured HttpClient.Timeout of 15 seconds elapsing.", new TimeoutException()),
        "io-reset" => new HttpRequestException(HttpRequestError.Unknown, "An error occurred while sending the request.", new IOException("reset", new SocketException((int)SocketError.ConnectionReset))),
        "handler-cancelled" => new OperationCanceledException("cancelled by host shutdown"),
        "tls" => new HttpRequestException(HttpRequestError.SecureConnectionError, "The SSL connection could not be established."),
        _ => throw new ArgumentOutOfRangeException(nameof(kind)),
    };

    [Theory]
    [MemberData(nameof(LostReplies))]
    public async Task SentWriteWithLostReplyIsUnknownAndIsNotSentToAnotherUrl(string kind)
    {
        using var p = new Proxy();
        p.Fake.Reply = (request, _) => request.RequestUri!.Host == p.HostA ? Task.FromException<HttpResponseMessage>(LostReply(kind)) : Task.FromResult(Json("{\"id\":1}", 201));

        var result = await p.Request();

        Assert.Equal(1, p.Fake.Count(p.HostA, "POST"));
        Assert.Equal(0, p.Fake.Count(p.HostB, "POST"));
        var (status, body) = Failure(result);
        Assert.Equal(502, status);
        Assert.Equal("unreachable", body.GetProperty("code").GetString());
        Assert.Equal("unknown", Outcome(body));
        // Non-admins never see the upstream host or exception text.
        Assert.DoesNotContain("seerr-a-", body.GetRawText());
        Assert.Equal("Can't reach Seerr right now. Please try again in a moment.", body.GetProperty("message").GetString());
    }

    [Fact]
    public async Task AdminSeesTheFailedUrlOnAnUnknownWrite()
    {
        using var p = new Proxy();
        p.SetUser(admin: true);
        p.Fake.Reply = (_, _) => Task.FromException<HttpResponseMessage>(LostReply("response-ended"));
        var (_, body) = Failure(await p.Request());
        Assert.Equal("unknown", Outcome(body));
        Assert.Contains(p.HostA, body.GetProperty("message").GetString());
        Assert.Equal(0, p.Fake.Count(p.HostB, "POST"));
    }

    public static TheoryData<int, string?, string, int, string> UnusableReplies() => new()
    {
        // upstream status, content type (null = no body), body, proxy status, code
        { 200, "text/html", "<html>login</html>", 502, "HtmlResponse" },
        { 201, "application/json", "", 502, "ParseError" },
        { 201, "application/json", "{\"id\":", 502, "ParseError" },
        { 204, null, "", 502, "HtmlResponse" },
        { 302, "text/html", "", 502, "UpstreamRedirect" },
        { 403, "text/html", "<html>blocked by proxy</html>", 502, "HtmlResponse" },
        { 408, "application/json", "{\"message\":\"timeout\"}", 408, "UpstreamError" },
        { 500, "application/json", "{\"message\":\"Radarr failed\"}", 500, "UpstreamError" },
        { 503, "application/json", "{\"message\":\"busy\"}", 503, "UpstreamError" },
        { 504, "text/html", "<html>gateway timeout</html>", 502, "HtmlResponse" },
        { 522, "text/html", "<html>cf</html>", 502, "Cloudflare5xx" },
    };

    [Theory]
    [MemberData(nameof(UnusableReplies))]
    public async Task AnsweredWriteWithoutUsableSuccessIsUnknownAndIsNotSentAgain(int upstream, string? type, string text, int proxyStatus, string code)
    {
        using var p = new Proxy();
        p.Fake.Reply = (request, _) =>
        {
            if (request.RequestUri!.Host != p.HostA) return Task.FromResult(Json("{\"id\":1}", 201));
            var response = new HttpResponseMessage((HttpStatusCode)upstream);
            if (type != null) response.Content = new StringContent(text, Encoding.UTF8, type);
            if (upstream == 302) response.Headers.Location = new Uri("http://auth.invalid/login");
            return Task.FromResult(response);
        };

        var result = await p.Request();

        Assert.Equal(1, p.Fake.Count(p.HostA, "POST"));
        Assert.Equal(0, p.Fake.Count(p.HostB, "POST"));
        var (status, body) = Failure(result);
        Assert.Equal(proxyStatus, status);
        Assert.Equal(code, body.GetProperty("code").GetString());
        Assert.Equal("unknown", Outcome(body));
        Assert.DoesNotContain("seerr-a-", body.GetRawText());
        Assert.DoesNotContain("auth.invalid", body.GetRawText());
    }

    [Theory]
    [InlineData(400, 400, "UpstreamError")]
    [InlineData(401, 401, "Unauthorized")]
    [InlineData(403, 403, "Forbidden")]
    [InlineData(404, 404, "UpstreamError")]
    [InlineData(409, 409, "UpstreamError")]
    [InlineData(429, 429, "UpstreamError")]
    public async Task ExplicitSeerrRejectionStaysDefiniteAndIsNotSentAgain(int upstream, int proxyStatus, string code)
    {
        using var p = new Proxy();
        // Seerr's own JSON error body, e.g. a quota or permission refusal.
        p.Fake.Reply = (request, _) => Task.FromResult(request.RequestUri!.Host == p.HostA
            ? Json("{\"message\":\"Movie Quota exceeded.\"}", upstream)
            : Json("{\"id\":1}", 201));

        var result = await p.Request();

        Assert.Equal(1, p.Fake.Count(p.HostA, "POST"));
        Assert.Equal(0, p.Fake.Count(p.HostB, "POST"));
        var (status, body) = Failure(result);
        Assert.Equal(proxyStatus, status);
        Assert.Equal(code, body.GetProperty("code").GetString());
        Assert.Equal(upstream, body.GetProperty("httpStatus").GetInt32());
        Assert.Equal("rejected", Outcome(body));
        Assert.True(body.GetProperty("error").GetBoolean());
        Assert.DoesNotContain("Quota exceeded", body.GetRawText());
        Assert.DoesNotContain("seerr-a-", body.GetRawText());
    }

    [Fact]
    public async Task IssueWritesFollowTheSameRules()
    {
        using var p = new Proxy { Permissions = JellyseerrPermission.CREATE_ISSUES };
        p.Fake.Reply = (request, _) => request.RequestUri!.Host == p.HostA
            ? Task.FromException<HttpResponseMessage>(LostReply("response-ended"))
            : Task.FromResult(Json("{\"id\":1}", 201));
        var (_, body) = Failure(await p.Controller.ReportJellyseerrIssue(JsonSerializer.Deserialize<JsonElement>("{\"issueType\":1,\"message\":\"x\",\"mediaId\":3}")));
        Assert.Equal("unknown", Outcome(body));
        Assert.Equal(0, p.Fake.Count(p.HostB, "POST"));

        p.Permissions = JellyseerrPermission.REQUEST;
        SeerrCaches.ClearAllSeerrCachesOnConfigChange();
        var (status, denied) = Failure(await p.Controller.ReportJellyseerrIssue(JsonSerializer.Deserialize<JsonElement>("{\"issueType\":1}")));
        Assert.Equal(403, status);
        Assert.Equal("no_issue_permission", denied.GetProperty("code").GetString());
        Assert.Equal("not_sent", Outcome(denied));
        Assert.Equal(1, p.Fake.Count(p.HostA, "POST"));
    }

    [Fact]
    public async Task SuccessfulWriteIsUnchanged()
    {
        using var p = new Proxy();
        p.Fake.Reply = (_, _) => Task.FromResult(Json("{\"id\":42,\"status\":1}", 201));
        var result = Assert.IsType<ContentResult>(await p.Request());
        Assert.Equal("{\"id\":42,\"status\":1}", result.Content);
        Assert.Equal("application/json", result.ContentType);
        Assert.Equal(1, p.Fake.Count(p.HostA, "POST"));
        Assert.Equal(0, p.Fake.Count(p.HostB, "POST"));
    }

    [Fact]
    public async Task WritesRefusedBeforeDispatchAreNotSent()
    {
        using var p = new Proxy { Permissions = JellyseerrPermission.NONE };
        var (status, body) = Failure(await p.Request());
        Assert.Equal(403, status);
        Assert.Equal("no_request_permission", body.GetProperty("code").GetString());
        Assert.Equal("not_sent", Outcome(body));
        // The permission envelope never carried error:true; it still does not.
        Assert.False(body.TryGetProperty("error", out _));

        p.Plugin.Plugin.Configuration.JellyseerrImportBlockedUsers = p.UserId.ToString("N");
        SeerrCaches.ClearAllSeerrCachesOnConfigChange();
        (status, body) = Failure(await p.Request());
        Assert.Equal(403, status);
        Assert.Equal("blocked", body.GetProperty("code").GetString());
        Assert.Equal("not_sent", Outcome(body));
        p.Plugin.Plugin.Configuration.JellyseerrImportBlockedUsers = string.Empty;

        p.Plugin.Plugin.Configuration.JellyseerrEnabled = false;
        (status, body) = Failure(await p.Request());
        Assert.Equal(503, status);
        Assert.Equal("not_configured", body.GetProperty("code").GetString());
        Assert.Equal("not_sent", Outcome(body));
        Assert.Equal(0, p.Fake.Calls.Count(c => c.Method == "POST"));
    }

    [Fact]
    public async Task SeerrUnreachableBeforeTheUserLookupIsNotSent()
    {
        // Every Seerr URL fails the user lookup and the reachability probe: this 502 is pre-dispatch.
        using var down = new Proxy(primary: () => new Failing());
        var (status, body) = Failure(await down.Request());
        Assert.Equal(502, status);
        Assert.Equal("unreachable", body.GetProperty("code").GetString());
        Assert.Equal("not_sent", Outcome(body));
    }

    [Fact]
    public async Task UnlinkedUserWriteIsNotSent()
    {
        // Seerr answers the lookup, but with nobody linked to this Jellyfin user.
        using var p = new Proxy(primary: () => new Forwarder(new FakeSeerr { User = Guid.NewGuid }));
        var (status, body) = Failure(await p.Request());
        Assert.Equal(404, status);
        Assert.Equal("unlinked", body.GetProperty("code").GetString());
        Assert.Equal("not_sent", Outcome(body));
    }

    private sealed class Failing : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) =>
            Task.FromException<HttpResponseMessage>(new HttpRequestException(HttpRequestError.ConnectionError, "refused", new SocketException((int)SocketError.ConnectionRefused)));
    }

    [Fact]
    public async Task UnknownWriteEvictsTheTitlesCachedDetailsButARejectionDoesNot()
    {
        using var p = new Proxy();
        var reads = 0;
        var write = "lost";
        p.Fake.Reply = (request, _) =>
        {
            if (request.Method == HttpMethod.Get) { reads++; return Task.FromResult(Json("{\"id\":550,\"mediaInfo\":null}")); }
            return write == "lost"
                ? Task.FromException<HttpResponseMessage>(LostReply("response-ended"))
                : Task.FromResult(Json("{\"message\":\"quota\"}", 403));
        };
        await p.Controller.GetMovie(550);
        await p.Controller.GetMovie(550);
        Assert.Equal(1, reads);
        Assert.Equal("unknown", Outcome(Failure(await p.Request()).Body));
        await p.Controller.GetMovie(550);
        Assert.Equal(2, reads);
        write = "rejected";
        Assert.Equal("rejected", Outcome(Failure(await p.Request()).Body));
        await p.Controller.GetMovie(550);
        Assert.Equal(2, reads);
    }

    [Fact]
    public async Task ReadsKeepBoundedRetryAndFailoverAndCarryNoOutcome()
    {
        using var p = new Proxy();
        p.Fake.Reply = (request, _) => Task.FromResult(request.RequestUri!.Host == p.HostA
            ? Json("{\"message\":\"tmdb burst\"}", 503)
            : Json("{\"id\":7,\"name\":\"Show\"}"));
        Assert.IsType<ContentResult>(await p.Controller.GetTvShow(7));
        Assert.Equal(3, p.Fake.Count(p.HostA, "GET"));
        Assert.Equal(1, p.Fake.Count(p.HostB, "GET"));

        // Exceptions also fail reads over, and the read envelope has no outcome.
        SeerrCaches.ClearAllSeerrCachesOnConfigChange();
        p.Fake.Calls.Clear();
        p.Fake.Reply = (_, _) => Task.FromException<HttpResponseMessage>(LostReply("response-ended"));
        var (status, body) = Failure(await p.Controller.GetTvShow(8));
        Assert.Equal(502, status);
        Assert.Equal("unreachable", body.GetProperty("code").GetString());
        Assert.Null(Outcome(body));
        Assert.Equal(1, p.Fake.Count(p.HostA, "GET"));
        Assert.Equal(1, p.Fake.Count(p.HostB, "GET"));
    }

    [Fact]
    public async Task BrowserCancelledReadDoesNotFailOver()
    {
        using var p = new Proxy();
        using var abort = new CancellationTokenSource();
        p.Controller.HttpContext.RequestAborted = abort.Token;
        p.Fake.Reply = async (_, ct) =>
        {
            abort.Cancel();
            await Task.Delay(Timeout.Infinite, ct);
            return Json("{}");
        };
        var result = Assert.IsType<StatusCodeResult>(await p.Controller.GetTvShow(9));
        Assert.Equal(499, result.StatusCode);
        Assert.Equal(1, p.Fake.Count(p.HostA, "GET"));
        Assert.Equal(0, p.Fake.Count(p.HostB, "GET"));
    }

    [Fact]
    public async Task BrowserAbortDoesNotCancelOrRepeatAWrite()
    {
        using var p = new Proxy();
        using var abort = new CancellationTokenSource();
        p.Controller.HttpContext.RequestAborted = abort.Token;
        p.Fake.Reply = async (_, ct) =>
        {
            abort.Cancel();
            await Task.Delay(50, ct);
            return Json("{\"id\":5}", 201);
        };
        Assert.IsType<ContentResult>(await p.Request());
        Assert.Equal(1, p.Fake.Count(p.HostA, "POST"));
        Assert.Equal(0, p.Fake.Count(p.HostB, "POST"));
    }

    // ---- Real sockets: the exception shapes come from the actual .NET HTTP stack, not from a fake. ----

    private sealed record LoopbackReply(string Mode, int Status = 200, string Body = "{}", bool KeepAlive = false);

    /// <summary>Minimal HTTP/1.1 server on 127.0.0.1 that can accept a request and then drop or cut the reply.</summary>
    private sealed class LoopbackSeerr : IAsyncDisposable
    {
        private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
        private readonly CancellationTokenSource _stop = new();
        private readonly Task _accept;
        private readonly List<TcpClient> _clients = new();
        public ConcurrentQueue<(string Method, string Path, int Connection)> Requests { get; } = new();
        public Func<string, string, LoopbackReply> Reply { get; set; } = (_, _) => new LoopbackReply("full");
        public string BaseUrl { get; }
        // A unique sub-path keeps SeerrCsrfHandler's static per-base-URL cache from leaking between tests on a reused port.
        private readonly string _prefix = "/" + Guid.NewGuid().ToString("N");
        private int _connections;

        public LoopbackSeerr()
        {
            _listener.Start();
            BaseUrl = $"http://127.0.0.1:{((IPEndPoint)_listener.LocalEndpoint).Port}{_prefix}";
            _accept = AcceptAsync();
        }

        public int Count(string method) => Requests.Count(r => r.Method == method && !r.Path.StartsWith("/api/v1/user?") && r.Path != "/api/v1/status");

        private async Task AcceptAsync()
        {
            try
            {
                while (!_stop.IsCancellationRequested)
                {
                    var client = await _listener.AcceptTcpClientAsync(_stop.Token);
                    lock (_clients) _clients.Add(client);
                    _ = ServeAsync(client, Interlocked.Increment(ref _connections));
                }
            }
            catch (OperationCanceledException) { }
            catch (ObjectDisposedException) { }
            catch (SocketException) { }
        }

        private async Task ServeAsync(TcpClient client, int connection)
        {
            try
            {
                var stream = client.GetStream();
                while (true)
                {
                    var request = await ReadRequestAsync(stream, _stop.Token);
                    if (request == null) return;
                    var (method, path) = request.Value;
                    if (path.StartsWith(_prefix, StringComparison.Ordinal)) path = path[_prefix.Length..];
                    Requests.Enqueue((method, path, connection));
                    var reply = Reply(method, path);
                    var body = Encoding.UTF8.GetBytes(reply.Body);
                    if (reply.Mode == "drop") { client.Client.Close(); return; }
                    var declared = reply.Mode == "truncate" ? body.Length + 64 : body.Length;
                    var head = $"HTTP/1.1 {reply.Status} X\r\nContent-Type: application/json\r\nContent-Length: {declared}\r\nConnection: {(reply.KeepAlive ? "keep-alive" : "close")}\r\n\r\n";
                    await stream.WriteAsync(Encoding.ASCII.GetBytes(head), _stop.Token);
                    await stream.WriteAsync(body, _stop.Token);
                    await stream.FlushAsync(_stop.Token);
                    if (reply.Mode == "truncate" || !reply.KeepAlive) { client.Client.Close(); return; }
                }
            }
            catch (Exception) when (_stop.IsCancellationRequested) { }
            catch (IOException) { }
            catch (SocketException) { }
            catch (ObjectDisposedException) { }
        }

        private static async Task<(string Method, string Path)?> ReadRequestAsync(Stream stream, CancellationToken ct)
        {
            var head = new List<byte>();
            var one = new byte[1];
            while (head.Count < 4 || head[^4] != '\r' || head[^3] != '\n' || head[^2] != '\r' || head[^1] != '\n')
            {
                if (await stream.ReadAsync(one, ct) == 0) return null;
                head.Add(one[0]);
            }
            var lines = Encoding.ASCII.GetString(head.ToArray()).Split("\r\n");
            var start = lines[0].Split(' ');
            var length = 0;
            foreach (var line in lines)
                if (line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase)) length = int.Parse(line["Content-Length:".Length..].Trim());
            // The request counts as received only once its whole body has arrived.
            if (length > 0) await stream.ReadExactlyAsync(new byte[length], ct);
            return (start[0], start[1]);
        }

        public async ValueTask DisposeAsync()
        {
            _stop.Cancel();
            _listener.Stop();
            lock (_clients) foreach (var c in _clients) c.Dispose();
            try { await _accept; } catch (Exception) { }
            _stop.Dispose();
        }
    }

    private static Func<HttpMessageHandler> ProductionPrimary => () => new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false };

    private static Func<string, string, LoopbackReply> SeerrReplies(Guid user, LoopbackReply write, bool keepAlive = false) => (method, path) =>
        path.StartsWith("/api/v1/user?", StringComparison.Ordinal)
            ? new LoopbackReply("full", 200, JsonSerializer.Serialize(new { results = new[] { new { id = 27, jellyfinUserId = user.ToString("N"), permissions = (int)JellyseerrPermission.REQUEST } } }), keepAlive)
            : method == "GET" ? new LoopbackReply("full", 200, "{}", keepAlive) : write;

    private static int ClosedLoopbackPort()
    {
        var probe = new TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        var port = ((IPEndPoint)probe.LocalEndpoint).Port;
        probe.Stop();
        return port;
    }

    [Theory]
    [InlineData("drop")]
    [InlineData("truncate")]
    public async Task RealSocketAcceptedWriteWithLostReplyIsUnknownWithOneSendAcrossUrls(string mode)
    {
        await using var a = new LoopbackSeerr();
        await using var b = new LoopbackSeerr();
        using var p = new Proxy($"{a.BaseUrl}\n{b.BaseUrl}", ProductionPrimary);
        a.Reply = SeerrReplies(p.UserId, new LoopbackReply(mode, 201, "{\"id\":1}"));
        b.Reply = SeerrReplies(p.UserId, new LoopbackReply("full", 201, "{\"id\":2}"));

        var result = await p.Request();

        Assert.Equal(1, a.Count("POST"));
        Assert.Equal(0, b.Count("POST"));
        var (status, body) = Failure(result);
        Assert.Equal(502, status);
        Assert.Equal("unknown", Outcome(body));
    }

    [Fact]
    public async Task RealSocketWriteOnAReusedConnectionIsSentOnce()
    {
        await using var a = new LoopbackSeerr();
        await using var b = new LoopbackSeerr();
        using var p = new Proxy($"{a.BaseUrl}\n{b.BaseUrl}", ProductionPrimary);
        // The CSRF probe leaves a pooled keep-alive connection that the write then reuses.
        a.Reply = SeerrReplies(p.UserId, new LoopbackReply("drop"), keepAlive: true);
        b.Reply = SeerrReplies(p.UserId, new LoopbackReply("full", 201, "{\"id\":2}"));

        var result = await p.Request();

        Assert.Equal(1, a.Count("POST"));
        Assert.Equal(0, b.Count("POST"));
        var (_, body) = Failure(result);
        Assert.Equal("unknown", Outcome(body));
        // The write really did travel on the probe's pooled connection, the case where the
        // platform could have resent it after a silent close.
        var post = Assert.Single(a.Requests, r => r.Method == "POST");
        Assert.Contains(a.Requests, r => r.Method == "GET" && r.Path == "/api/v1/status" && r.Connection == post.Connection);
    }

    [Fact]
    public async Task RealSocketRefusedConnectionFailsTheWriteOverToTheNextUrl()
    {
        await using var b = new LoopbackSeerr();
        using var p = new Proxy($"http://127.0.0.1:{ClosedLoopbackPort()}\n{b.BaseUrl}", ProductionPrimary);
        b.Reply = SeerrReplies(p.UserId, new LoopbackReply("full", 201, "{\"id\":2}"));

        var result = Assert.IsType<ContentResult>(await p.Request());

        Assert.Equal("{\"id\":2}", result.Content);
        Assert.Equal(1, b.Count("POST"));
    }

    [Fact]
    public async Task RealSocketAllUrlsRefusedIsNotSent()
    {
        var port = ClosedLoopbackPort();
        await using var users = new LoopbackSeerr();
        // Link the user through a reachable instance first (the user cache), then point every URL at refused ports.
        using var p = new Proxy($"{users.BaseUrl}", ProductionPrimary);
        users.Reply = SeerrReplies(p.UserId, new LoopbackReply("full", 201, "{\"id\":2}"));
        Assert.IsType<ContentResult>(await p.Controller.GetTvShow(1));
        p.Plugin.Plugin.Configuration.JellyseerrUrls = $"http://127.0.0.1:{port}\nhttp://127.0.0.1:{ClosedLoopbackPort()}";

        var (status, body) = Failure(await p.Request());

        Assert.Equal(502, status);
        Assert.Equal("unreachable", body.GetProperty("code").GetString());
        Assert.Equal("not_sent", Outcome(body));
        Assert.Equal(0, users.Count("POST"));
    }
}
