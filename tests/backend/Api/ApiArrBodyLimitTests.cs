using System.Net;
using System.Reflection;
using System.Security.Claims;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.AspNetCore.Mvc.Routing;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace JE.Tests;

/// <summary>
/// Request bodies of the arr, acquire, notify and backup routes are capped before model binding
/// with a structured 413 (Jellyfin's exception middleware turns Kestrel's own 413 into a 500):
/// every route that takes a body carries the cap; exactly the cap passes, one byte more doesn't,
/// whether declared or streamed (chunked), counted in bytes (multibyte text); the change feed and
/// the webhook answer the same way. Administrators' arr answers are <c>private, no-store</c>; user
/// status and hub answers keep their own <c>private, no-cache</c> and ETag.
/// </summary>
[Collection("Plugin singleton")]
public class ApiArrBodyLimitTests
{
    // ------------------------------------------------------------------ reflection scans

    [Fact]
    public void EveryRouteThatTakesABodyIsCapped()
    {
        var withBody = ApiArrRouteMatrixTests.Actions()
            .Where(a => a.Action.GetParameters().Any(p => p.GetCustomAttribute<FromBodyAttribute>() != null))
            .ToList();
        Assert.True(withBody.Count >= 20, $"found {withBody.Count}");
        foreach (var (method, route, action) in withBody)
        {
            var cap = action.GetCustomAttribute<BodyLimitAttribute>();
            Assert.True(cap != null, $"{method} {route} takes a body without [BodyLimit]");
            Assert.InRange(cap!.Bytes, 1, 1024 * 1024);
        }
        // Kestrel's own limit would be a 500 behind Jellyfin: only the webhook (which catches it) and the backup uploads keep one.
        var kestrel = ApiArrRouteMatrixTests.Actions().Where(a => a.Action.GetCustomAttribute<RequestSizeLimitAttribute>() != null).Select(a => a.Route).Distinct().OrderBy(r => r);
        Assert.Equal(new[] { "admin/backup/inspect", "admin/backup/restore", "arr/hook/{instanceId}" }, kestrel);
        Assert.Equal(64 * 1024, typeof(NotifyController).GetMethod(nameof(NotifyController.MarkRead))!.GetCustomAttribute<BodyLimitAttribute>()!.Bytes);
        Assert.Equal(256 * 1024, typeof(ArrLiveController).GetMethod(nameof(ArrLiveController.GetChanges))!.GetCustomAttribute<BodyLimitAttribute>()!.Bytes);
    }

    [Fact]
    public void AdministratorsArrAnswersArePrivateNoStoreAndUserAnswersKeepTheirETags()
    {
        static bool Private(MethodInfo m) => m.GetCustomAttribute<PrivateResponseAttribute>() != null || m.DeclaringType!.GetCustomAttribute<PrivateResponseAttribute>() != null;
        var actions = ApiArrRouteMatrixTests.Actions();
        var admin = actions.Where(a => a.Route.StartsWith("arr/admin", StringComparison.Ordinal)).ToList();
        Assert.True(admin.Count >= 20, $"found {admin.Count}");
        foreach (var (method, route, action) in admin)
            Assert.True(Private(action), $"{method} {route} has no [PrivateResponse]");
        // User status, hub and notification routes are cached by the browser with their ETag (private, no-cache).
        // The list import review is the exception: its answers (candidates, library ids) are never stored (4c2a SEC-07).
        foreach (var (method, route, action) in actions.Where(a => a.Route.StartsWith("acquire/", StringComparison.Ordinal) && !a.Route.StartsWith("acquire/lists/import/", StringComparison.Ordinal)))
            Assert.False(Private(action), $"{method} {route} must not be no-store");
        foreach (var (method, route, action) in actions.Where(a => a.Route.StartsWith("acquire/lists/import/", StringComparison.Ordinal)))
            Assert.True(Private(action), $"{method} {route} has no [PrivateResponse]");
        Assert.False(Private(typeof(RequestsHubController).GetMethod(nameof(RequestsHubController.GetHub))!));
    }

    [Fact]
    public void ThePrivateResponseFilterSetsCacheControlOnlyAndOnEveryResult()
    {
        var http = new DefaultHttpContext();
        http.Response.Headers.ETag = "\"abc\"";
        http.Response.Headers.Vary = "Accept";
        http.Response.Headers.CacheControl = "private, no-cache";
        var context = new ResultExecutingContext(new ActionContext(http, new RouteData(), new ActionDescriptor()), new List<IFilterMetadata>(), new ForbidResult(), new object());
        new PrivateResponseAttribute().OnResultExecuting(context);
        Assert.Equal("private, no-store", http.Response.Headers.CacheControl.ToString());
        Assert.Equal(("\"abc\"", "Accept"), (http.Response.Headers.ETag.ToString(), http.Response.Headers.Vary.ToString()));
    }

    // ------------------------------------------------------------------ the real pipeline

    private sealed class RigActivator(ApiArrRouteMatrixTests.Rig rig) : IControllerActivator
    {
        public object Create(ControllerContext context)
        {
            var type = context.ActionDescriptor.ControllerTypeInfo.AsType();
            var controller = rig.Controllers(context.HttpContext.User).Single(c => c.GetType() == type);
            controller.ControllerContext = context;
            return controller;
        }

        public void Release(ControllerContext context, object controller) { }
    }

    /// <summary>Signs in the user named by the X-Test-User header (none: anonymous).</summary>
    private sealed class HeaderAuthentication(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder)
        : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
    {
        protected override Task<AuthenticateResult> HandleAuthenticateAsync()
        {
            if (!Guid.TryParse(Request.Headers["X-Test-User"], out var id)) return Task.FromResult(AuthenticateResult.NoResult());
            var principal = TestCallers.Principal(id, Request.Headers["X-Test-Admin"] == "1");
            return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(new ClaimsIdentity(principal.Claims, "test")), "test")));
        }
    }

    /// <summary>The real routing, authentication, authorisation, filters and model binding over the rig's controllers.</summary>
    private sealed class Pipeline : IDisposable
    {
        private readonly IHost _host;

        public Pipeline(ApiArrRouteMatrixTests.Rig rig)
        {
            _host = new HostBuilder().ConfigureWebHost(web => web.UseTestServer().ConfigureServices(services =>
            {
                services.AddLogging();
                services.AddRouting();
                services.AddAuthentication("test").AddScheme<AuthenticationSchemeOptions, HeaderAuthentication>("test", _ => { });
                services.AddAuthorization();
                services.AddControllers().AddApplicationPart(typeof(NotifyController).Assembly);
                services.AddSingleton<IControllerActivator>(new RigActivator(rig));
            }).Configure(app =>
            {
                app.UseRouting();
                app.UseAuthentication();
                app.UseAuthorization();
                app.UseEndpoints(e => e.MapControllers());
            })).Start();
        }

        public HttpClient CreateClient() => _host.GetTestServer().CreateClient();

        public void Dispose() => _host.Dispose();
    }

    private static Pipeline Server(ApiArrRouteMatrixTests.Rig rig) => new(rig);

    private static HttpRequestMessage Post(string route, HttpContent content, Guid user)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, "/JellyfinEnhanced/" + route) { Content = content };
        request.Headers.Add("X-Test-User", user.ToString());
        return request;
    }

    /// <summary>A mark-read body of exactly <paramref name="bytes"/> bytes (valid JSON, padded with spaces).</summary>
    private static byte[] ReadBody(int bytes, string ids = "1")
    {
        var json = "{\"ids\":[" + ids + "]";
        return Encoding.UTF8.GetBytes(json + new string(' ', bytes - json.Length - 1) + "}");
    }

    private static ByteArrayContent Json(byte[] body)
    {
        var content = new ByteArrayContent(body);
        content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/json");
        return content;
    }

    /// <summary>The same bytes without a Content-Length (sent chunked).</summary>
    private static StreamContent Chunked(byte[] body)
    {
        var content = new StreamContent(new NoLengthStream(body));
        content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/json");
        return content;
    }

    private sealed class NoLengthStream(byte[] data) : MemoryStream(data)
    {
        public override bool CanSeek => false;
    }

    private static async Task AssertTooLarge(HttpResponseMessage response, int limit)
    {
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, response.StatusCode);
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.Equal(("payload_too_large", limit), (body.RootElement.GetProperty("code").GetString(), body.RootElement.GetProperty("limitBytes").GetInt32()));
    }

    [Fact]
    public async Task ExactlyTheCapPassesAndOneByteMoreIsAStructured413DeclaredOrChunked()
    {
        using var rig = new ApiArrRouteMatrixTests.Rig(await IntegrationNotificationsTests.Started());
        using var server = Server(rig);
        using var client = server.CreateClient();
        var emma = rig.N.Emma.UserId;
        const int cap = NotifyController.MaxReadBodyBytes;

        using (var atCap = await client.SendAsync(Post("acquire/notify/read", Json(ReadBody(cap)), emma)))
            Assert.Equal(HttpStatusCode.OK, atCap.StatusCode);
        using (var atCapChunked = await client.SendAsync(Post("acquire/notify/read", Chunked(ReadBody(cap)), emma)))
            Assert.Equal(HttpStatusCode.OK, atCapChunked.StatusCode);
        using (var over = await client.SendAsync(Post("acquire/notify/read", Json(ReadBody(cap + 1)), emma)))
            await AssertTooLarge(over, cap);
        using (var overChunked = await client.SendAsync(Post("acquire/notify/read", Chunked(ReadBody(cap + 1)), emma)))
            await AssertTooLarge(overChunked, cap);

        // Counted in bytes: 30 000 characters of three bytes each are 90 000 bytes.
        var multibyte = Encoding.UTF8.GetBytes("{\"ids\":[1],\"note\":\"" + new string('€', 30_000) + "\"}");
        Assert.True(multibyte.Length > cap && multibyte.Length / 3 < cap);
        using (var wide = await client.SendAsync(Post("acquire/notify/read", Chunked(multibyte), emma)))
            await AssertTooLarge(wide, cap);

        // An empty body reaches the action (which says what's missing), never a 413.
        using (var empty = await client.SendAsync(Post("acquire/notify/read", Json(Array.Empty<byte>()), emma)))
            Assert.NotEqual(HttpStatusCode.RequestEntityTooLarge, empty.StatusCode);
        // The default cap (16 KiB) on another route; a refusal reads nothing more and stores nothing.
        using (var prefs = await client.SendAsync(Post("acquire/notify/ntfy/topic", Json(ReadBody(BodyLimitAttribute.DefaultBytes + 1)), emma)))
            await AssertTooLarge(prefs, BodyLimitAttribute.DefaultBytes);
        // Anonymous callers are refused before any body is read.
        var anonymous = new HttpRequestMessage(HttpMethod.Post, "/JellyfinEnhanced/acquire/notify/read") { Content = Json(ReadBody(cap + 1)) };
        using (var refused = await client.SendAsync(anonymous))
            Assert.Equal(HttpStatusCode.Unauthorized, refused.StatusCode);
    }

    [Fact]
    public async Task ThroughThePipelineAdminAnswersAreNoStoreAndUserAnswersKeepTheirOwnHeaders()
    {
        using var rig = new ApiArrRouteMatrixTests.Rig(await IntegrationNotificationsTests.Started());
        using var server = Server(rig);
        using var client = server.CreateClient();
        async Task<(HttpStatusCode Status, string? CacheControl, bool ETag)> Get(string route, Guid user, bool admin)
        {
            var request = new HttpRequestMessage(HttpMethod.Get, "/JellyfinEnhanced/" + route);
            request.Headers.Add("X-Test-User", user.ToString());
            if (admin) request.Headers.Add("X-Test-Admin", "1");
            using var response = await client.SendAsync(request);
            // HttpClient re-orders the directives: compared as "private, no-…" whatever their order.
            var cache = response.Headers.CacheControl is { } cc ? "private, " + (cc.NoStore ? "no-store" : cc.NoCache ? "no-cache" : "?") + (cc.Private ? string.Empty : " (not private)") : null;
            return (response.StatusCode, cache, response.Headers.Contains("ETag"));
        }
        Assert.Equal((HttpStatusCode.OK, "private, no-store", false), await Get("arr/admin/hub/overview", rig.N.Admin.UserId, true));
        Assert.Equal((HttpStatusCode.OK, "private, no-store", false), await Get("arr/admin/state", rig.N.Admin.UserId, true));
        Assert.Equal((HttpStatusCode.OK, "private, no-store", false), await Get("arr/admin/audit", rig.N.Admin.UserId, true));
        // A refusal is no-store too.
        Assert.Equal((HttpStatusCode.Forbidden, "private, no-store", false), await Get("arr/admin/notify", rig.N.Emma.UserId, false));
        // The user's own status keeps private, no-cache with its ETag.
        Assert.Equal((HttpStatusCode.OK, "private, no-cache", true), await Get("acquire/status?keys=movie:tmdb:693134", rig.N.Emma.UserId, false));
    }

    [Fact]
    public async Task TheChangeFeedAndTheWebhookAnswerAnOversizedBodyWithTheSame413()
    {
        using var rig = new ApiArrRouteMatrixTests.Rig(await IntegrationNotificationsTests.Started());
        using var server = Server(rig);
        using var client = server.CreateClient();
        var emma = rig.N.Emma.UserId;

        var keys = "{\"keys\":[" + string.Join(",", Enumerable.Range(1, 20_000).Select(i => "\"movie:tmdb:" + i + "\"")) + "]}";
        using (var feed = await client.SendAsync(Post("acquire/changes", Chunked(Encoding.UTF8.GetBytes(keys)), emma)))
            await AssertTooLarge(feed, ArrLiveController.MaxChangesBodyBytes);

        var instance = rig.N.Arr.Instance("RadarrZ").Id;
        var hook = new HttpRequestMessage(HttpMethod.Post, "/JellyfinEnhanced/arr/hook/" + instance) { Content = Chunked(new byte[Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live.ArrWebhookReceiver.MaxBodyBytes + 1]) };
        using (var big = await client.SendAsync(hook))
            await AssertTooLarge(big, Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live.ArrWebhookReceiver.MaxBodyBytes);
    }

    [Fact]
    public async Task TheFilterTurnsTheServersOwn413IntoTheStructuredAnswer()
    {
        var http = new DefaultHttpContext();
        http.Request.Body = new ThrowingStream();
        var context = new ResourceExecutingContext(new ActionContext(http, new RouteData(), new ActionDescriptor()), new List<IFilterMetadata>(), new List<IValueProviderFactory>());
        var ran = false;
        await new BodyLimitAttribute().OnResourceExecutionAsync(context, () => { ran = true; return Task.FromResult<ResourceExecutedContext>(null!); });
        Assert.False(ran);
        var result = Assert.IsType<ObjectResult>(context.Result);
        Assert.Equal(413, result.StatusCode);
        Assert.Contains("payload_too_large", JsonSerializer.Serialize(result.Value));
    }

    [Fact]
    public async Task ADeclaredLengthOverTheCapIsRefusedWithoutReadingTheBody()
    {
        var http = new DefaultHttpContext();
        var body = new CountingStream(new byte[BodyLimitAttribute.DefaultBytes + 1]);
        http.Request.Body = body;
        http.Request.ContentLength = BodyLimitAttribute.DefaultBytes + 1;
        var context = new ResourceExecutingContext(new ActionContext(http, new RouteData(), new ActionDescriptor()), new List<IFilterMetadata>(), new List<IValueProviderFactory>());
        await new BodyLimitAttribute().OnResourceExecutionAsync(context, () => Task.FromResult<ResourceExecutedContext>(null!));
        Assert.Equal(413, Assert.IsType<ObjectResult>(context.Result).StatusCode);
        Assert.Equal(0, body.Reads);
    }

    [Fact]
    public async Task ACallerThatGoesAwayWhileSendingGetsNoAnswerAndNoError()
    {
        // A closed tab or a replaced poll: the body read is cancelled with the request. No answer, nothing for
        // Jellyfin's error log, the action never runs.
        using var gone = new CancellationTokenSource();
        gone.Cancel();
        foreach (var failure in new Exception[] { new OperationCanceledException(gone.Token), new IOException("The client reset the request stream.") })
        {
            var http = new DefaultHttpContext { RequestAborted = gone.Token };
            http.Request.Body = new FailingStream(failure);
            http.Request.ContentLength = 40;
            var context = new ResourceExecutingContext(new ActionContext(http, new RouteData(), new ActionDescriptor()), new List<IFilterMetadata>(), new List<IValueProviderFactory>());
            var ran = false;
            await new BodyLimitAttribute().OnResourceExecutionAsync(context, () => { ran = true; return Task.FromResult<ResourceExecutedContext>(null!); });
            Assert.IsType<EmptyResult>(context.Result);
            Assert.False(ran);
        }

        // A read failure while the caller is still there is not swallowed.
        var live = new DefaultHttpContext();
        live.Request.Body = new FailingStream(new IOException("disk"));
        live.Request.ContentLength = 40;
        var still = new ResourceExecutingContext(new ActionContext(live, new RouteData(), new ActionDescriptor()), new List<IFilterMetadata>(), new List<IValueProviderFactory>());
        await Assert.ThrowsAsync<IOException>(() => new BodyLimitAttribute().OnResourceExecutionAsync(still, () => Task.FromResult<ResourceExecutedContext>(null!)));
    }

    private sealed class FailingStream(Exception failure) : MemoryStream
    {
        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) => throw failure;
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) => throw failure;
    }

    private sealed class CountingStream(byte[] data) : MemoryStream(data)
    {
        public int Reads;
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) { Reads++; return base.ReadAsync(buffer, cancellationToken); }
        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) { Reads++; return base.ReadAsync(buffer, offset, count, cancellationToken); }
    }

    private sealed class ThrowingStream : MemoryStream
    {
        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) => throw new BadHttpRequestException("Request body too large.", 413);
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) => throw new BadHttpRequestException("Request body too large.", 413);
    }
}
