#pragma warning disable ASPDEPR004, ASPDEPR008 // TestServer over WebHostBuilder, as the other MVC harnesses here.
using System.Collections;
using System.IO.Pipelines;
using System.Net;
using System.Net.WebSockets;
using System.Reflection;
using System.Runtime.Loader;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Extensions.Json;
using Jellyfin.Plugin.JellyfinEnhanced;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using MediaBrowser.Controller.Net;
using MediaBrowser.Controller.Net.WebSocketMessages;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Session;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

namespace JE.Tests;

/// <summary>An answer of every result type MVC (and the host or JE) can produce, each carrying an item's DTO where the
/// type can carry a body at all.</summary>
[Route("JeLegacyResults")]
internal sealed class JeLegacyResultsController(LegacyCollageScenario scenario) : ControllerBase
{
    [HttpGet("{variant}/{item}", Name = "JeLegacyResults")]
    public IActionResult Make(string variant, string item) => LegacyResultTypes.Variants[variant].Make(new LegacyResultTypes.Ctx(scenario, scenario.Names[item]));
}

/// <summary>A result type written by hand: JSON in small flushed chunks, as a streaming answer is.</summary>
public sealed class StreamedJsonResult(byte[] json) : IActionResult
{
    public async Task ExecuteResultAsync(ActionContext context)
    {
        context.HttpContext.Response.ContentType = "application/json; charset=utf-8";
        for (var i = 0; i < json.Length; i += 7)
        {
            await context.HttpContext.Response.Body.WriteAsync(json.AsMemory(i, Math.Min(7, json.Length - i)));
            await context.HttpContext.Response.Body.FlushAsync();
        }
    }
}

/// <summary>A result type written by hand through the response's pipe writer.</summary>
public sealed class PipeJsonResult(byte[] json) : IActionResult
{
    public async Task ExecuteResultAsync(ActionContext context)
    {
        context.HttpContext.Response.ContentType = "application/json";
        await context.HttpContext.Response.StartAsync();
        var writer = context.HttpContext.Response.BodyWriter;
        await writer.WriteAsync(json.AsMemory(0, json.Length / 2));
        await writer.FlushAsync();
        await writer.WriteAsync(json.AsMemory(json.Length / 2));
        await writer.FlushAsync();
    }
}

/// <summary>Every result type the test knows how to answer with, by variant.</summary>
public static class LegacyResultTypes
{
    /// <summary>One request's material.</summary>
    public sealed class Ctx
    {
        internal Ctx(LegacyCollageScenario scenario, Guid id)
        {
            Dtos = new[] { scenario.Dto(id) };
            Json = JsonSerializer.SerializeToUtf8Bytes(Dtos, JsonDefaults.PascalCaseOptions);
            Camel = JsonSerializer.SerializeToUtf8Bytes(Dtos, JsonDefaults.CamelCaseOptions);
            Root = scenario.Root;
        }

        public BaseItemDto[] Dtos { get; }

        public byte[] Json { get; }

        public byte[] Camel { get; }

        public string Root { get; }

        public string File(string name)
        {
            var path = Path.Combine(Root, "wwwroot", name);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            System.IO.File.WriteAllBytes(path, Json);
            return path;
        }
    }

    private static readonly ClaimsPrincipal Someone = new(new ClaimsIdentity(new[] { new Claim(ClaimTypes.Name, "x") }, "test"));

    private static async IAsyncEnumerable<BaseItemDto> Streamed(BaseItemDto[] dtos)
    {
        foreach (var dto in dtos)
        {
            await Task.Yield();
            yield return dto;
        }
    }

    /// <summary>Variant → (result type, factory, whether it carries the DTO in its body, the exact body when it is bytes the test made).</summary>
    public static readonly Dictionary<string, (Type Type, Func<Ctx, IActionResult> Make, bool Body, Func<Ctx, byte[]>? Exact)> Variants = new(StringComparer.Ordinal)
    {
        ["ObjectResult"] = (typeof(ObjectResult), c => new ObjectResult(c.Dtos), true, null),
        ["ObjectResult-async"] = (typeof(ObjectResult), c => new ObjectResult(Streamed(c.Dtos)), true, null),
        ["OkObjectResult"] = (typeof(OkObjectResult), c => new OkObjectResult(c.Dtos), true, null),
        ["CreatedResult"] = (typeof(CreatedResult), c => new CreatedResult("/x", c.Dtos), true, null),
        ["CreatedAtActionResult"] = (typeof(CreatedAtActionResult), c => new CreatedAtActionResult("Make", "JeLegacyResults", new { variant = "x", item = "y" }, c.Dtos), true, null),
        ["CreatedAtRouteResult"] = (typeof(CreatedAtRouteResult), c => new CreatedAtRouteResult("JeLegacyResults", new { variant = "x", item = "y" }, c.Dtos), true, null),
        ["AcceptedResult"] = (typeof(AcceptedResult), c => new AcceptedResult("/x", c.Dtos), true, null),
        ["AcceptedAtActionResult"] = (typeof(AcceptedAtActionResult), c => new AcceptedAtActionResult("Make", "JeLegacyResults", new { variant = "x", item = "y" }, c.Dtos), true, null),
        ["AcceptedAtRouteResult"] = (typeof(AcceptedAtRouteResult), c => new AcceptedAtRouteResult("JeLegacyResults", new { variant = "x", item = "y" }, c.Dtos), true, null),
        ["BadRequestObjectResult"] = (typeof(BadRequestObjectResult), c => new BadRequestObjectResult(c.Dtos), true, null),
        ["NotFoundObjectResult"] = (typeof(NotFoundObjectResult), c => new NotFoundObjectResult(c.Dtos), true, null),
        ["ConflictObjectResult"] = (typeof(ConflictObjectResult), c => new ConflictObjectResult(c.Dtos), true, null),
        ["UnauthorizedObjectResult"] = (typeof(UnauthorizedObjectResult), c => new UnauthorizedObjectResult(c.Dtos), true, null),
        ["UnprocessableEntityObjectResult"] = (typeof(UnprocessableEntityObjectResult), c => new UnprocessableEntityObjectResult(c.Dtos), true, null),
        ["JsonResult"] = (typeof(JsonResult), c => new JsonResult(c.Dtos), true, null),
        ["JsonResult-utf16"] = (typeof(JsonResult), c => new JsonResult(c.Dtos) { ContentType = "application/json; charset=utf-16" }, true, null),
        ["ObjectResult-accept16"] = (typeof(ObjectResult), c => new ObjectResult(c.Dtos), true, null),
        ["ContentResult"] = (typeof(ContentResult), c => new ContentResult { Content = Encoding.UTF8.GetString(c.Json), ContentType = "application/json" }, true, c => c.Json),
        ["ContentResult-camel"] = (typeof(ContentResult), c => new ContentResult { Content = Encoding.UTF8.GetString(c.Camel), ContentType = "application/json; profile=\"CamelCase\"" }, true, c => c.Camel),
        ["ContentResult-text"] = (typeof(ContentResult), c => new ContentResult { Content = Encoding.UTF8.GetString(c.Json), ContentType = "text/plain" }, true, c => c.Json),
        ["ContentResult-untyped"] = (typeof(ContentResult), c => new ContentResult { Content = Encoding.UTF8.GetString(c.Json) }, true, c => c.Json),
        ["ContentResult-utf16"] = (typeof(ContentResult), c => new ContentResult { Content = Encoding.UTF8.GetString(c.Json), ContentType = "application/json; charset=utf-16" }, true, c => c.Json),
        ["FileContentResult"] = (typeof(FileContentResult), c => new FileContentResult(c.Json, "application/json"), true, c => c.Json),
        ["FileStreamResult"] = (typeof(FileStreamResult), c => new FileStreamResult(new MemoryStream(c.Json), "application/json"), true, c => c.Json),
        ["PhysicalFileResult"] = (typeof(PhysicalFileResult), c => new PhysicalFileResult(c.File("answer.json"), "application/json"), true, c => c.Json),
        ["VirtualFileResult"] = (typeof(VirtualFileResult), c => { c.File("virtual.json"); return new VirtualFileResult("virtual.json", "application/json"); }, true, c => c.Json),
        ["StreamedJsonResult"] = (typeof(StreamedJsonResult), c => new StreamedJsonResult(c.Json), true, c => c.Json),
        ["PipeJsonResult"] = (typeof(PipeJsonResult), c => new PipeJsonResult(c.Json), true, c => c.Json),
        // Result types that carry no body of the action's own (a status, a redirect, an authentication handler's answer).
        ["OkResult"] = (typeof(OkResult), _ => new OkResult(), false, null),
        ["NoContentResult"] = (typeof(NoContentResult), _ => new NoContentResult(), false, null),
        ["NotFoundResult"] = (typeof(NotFoundResult), _ => new NotFoundResult(), false, null),
        ["BadRequestResult"] = (typeof(BadRequestResult), _ => new BadRequestResult(), false, null),
        ["UnauthorizedResult"] = (typeof(UnauthorizedResult), _ => new UnauthorizedResult(), false, null),
        ["ConflictResult"] = (typeof(ConflictResult), _ => new ConflictResult(), false, null),
        ["UnprocessableEntityResult"] = (typeof(UnprocessableEntityResult), _ => new UnprocessableEntityResult(), false, null),
        ["UnsupportedMediaTypeResult"] = (typeof(UnsupportedMediaTypeResult), _ => new UnsupportedMediaTypeResult(), false, null),
        ["StatusCodeResult"] = (typeof(StatusCodeResult), _ => new StatusCodeResult(418), false, null),
        ["AntiforgeryValidationFailedResult"] = (typeof(AntiforgeryValidationFailedResult), _ => new AntiforgeryValidationFailedResult(), false, null),
        ["EmptyResult"] = (typeof(EmptyResult), _ => new EmptyResult(), false, null),
        ["ForbidResult"] = (typeof(ForbidResult), _ => new ForbidResult(), false, null),
        ["ChallengeResult"] = (typeof(ChallengeResult), _ => new ChallengeResult(), false, null),
        ["SignInResult"] = (typeof(Microsoft.AspNetCore.Mvc.SignInResult), _ => new Microsoft.AspNetCore.Mvc.SignInResult(Someone), false, null),
        ["SignOutResult"] = (typeof(SignOutResult), _ => new SignOutResult(), false, null),
        ["RedirectResult"] = (typeof(RedirectResult), _ => new RedirectResult("/x"), false, null),
        ["LocalRedirectResult"] = (typeof(LocalRedirectResult), _ => new LocalRedirectResult("/x"), false, null),
        ["RedirectToActionResult"] = (typeof(RedirectToActionResult), _ => new RedirectToActionResult("Make", "JeLegacyResults", new { variant = "x", item = "y" }), false, null),
        ["RedirectToRouteResult"] = (typeof(RedirectToRouteResult), _ => new RedirectToRouteResult("JeLegacyResults", new { variant = "x", item = "y" }), false, null),
        ["RedirectToPageResult"] = (typeof(RedirectToPageResult), _ => new RedirectToPageResult("/x"), false, null),
    };

    /// <summary>Result types nothing in the host or JE can produce, and why.</summary>
    public static readonly Dictionary<string, string> Excluded = new(StringComparer.Ordinal)
    {
        ["Microsoft.AspNetCore.Mvc.ViewResult"] = "renders a Razor view: neither the host nor JE has one",
        ["Microsoft.AspNetCore.Mvc.PartialViewResult"] = "renders a Razor view: neither the host nor JE has one",
        ["Microsoft.AspNetCore.Mvc.ViewComponentResult"] = "renders a view component: neither the host nor JE has one",
        ["Microsoft.AspNetCore.Mvc.RazorPages.PageResult"] = "renders a Razor page: neither the host nor JE has one",
    };
}

/// <summary>The scenario's answer-boundary and WebSocket-corpus runs (see LegacyCollageHost).</summary>
public static partial class LegacyCollageHostEntry
{
    // Every concrete result type of ASP.NET Core MVC and of the release's and JE's own assemblies, and every action return
    // type the release's and JE's controllers declare.
    private static JsonObject ResultTypes(HttpClient client, Guid viewer)
    {
        var context = AssemblyLoadContext.GetLoadContext(typeof(LegacyCollageHostEntry).Assembly)!;
        Assembly? Load(string name)
        {
            try { return context.LoadFromAssemblyName(new AssemblyName(name)); }
            catch (FileNotFoundException) { return null; }
        }

        var assemblies = new[] { "Microsoft.AspNetCore.Mvc.Core", "Microsoft.AspNetCore.Mvc.ViewFeatures", "Microsoft.AspNetCore.Mvc.RazorPages", "Jellyfin.Api", "Jellyfin.Plugin.JellyfinEnhanced" }
            .Select(Load).OfType<Assembly>().ToList();
        static IEnumerable<Type> Types(Assembly a)
        {
            try { return a.GetExportedTypes(); }
            catch (ReflectionTypeLoadException e) { return e.Types.OfType<Type>(); }
        }

        var universe = assemblies.SelectMany(Types)
            .Where(t => t.IsClass && !t.IsAbstract && !t.ContainsGenericParameters && (typeof(IActionResult).IsAssignableFrom(t) || typeof(IResult).IsAssignableFrom(t)))
            .Select(t => t.FullName!).Distinct().OrderBy(n => n, StringComparer.Ordinal).ToList();

        var declared = new JsonArray();
        foreach (var assembly in assemblies.Where(a => a.GetName().Name is "Jellyfin.Api" or "Jellyfin.Plugin.JellyfinEnhanced"))
        {
            foreach (var controller in Types(assembly).Where(t => t.IsClass && !t.IsAbstract && typeof(ControllerBase).IsAssignableFrom(t)))
            {
                foreach (var method in controller.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly).Where(m => !m.IsSpecialName && m.GetCustomAttribute<NonActionAttribute>() == null))
                {
                    var type = method.ReturnType;
                    while (type.IsGenericType && type.GetGenericTypeDefinition().FullName is "System.Threading.Tasks.Task`1" or "System.Threading.Tasks.ValueTask`1")
                        type = type.GetGenericArguments()[0];
                    string kind = type.IsGenericType && type.GetGenericTypeDefinition() == typeof(ActionResult<>) ? "ActionResult<T>"
                        : typeof(IResult).IsAssignableFrom(type) ? "IResult:" + type.FullName
                        : typeof(IActionResult).IsAssignableFrom(type) ? (type.IsAbstract || type.IsInterface ? "any:" + type.FullName : "concrete:" + type.FullName)
                        : type == typeof(void) || type == typeof(Task) ? "none" : "value";
                    declared.Add(new JsonObject { ["assembly"] = assembly.GetName().Name, ["action"] = controller.Name + "." + method.Name, ["kind"] = kind });
                }
            }
        }

        // The actions MVC itself discovers on those controllers (the walk above must be exactly these).
        var discovered = new JsonArray();
        using (var discovery = new TestServer(new Microsoft.AspNetCore.Hosting.WebHostBuilder().ConfigureServices(services =>
            {
                var mvc = services.AddControllers().ConfigureApplicationPartManager(parts => parts.ApplicationParts.Clear());
                foreach (var assembly in assemblies.Where(a => a.GetName().Name is "Jellyfin.Api" or "Jellyfin.Plugin.JellyfinEnhanced")) mvc.AddApplicationPart(assembly);
            }).Configure(app => { app.UseRouting(); app.UseEndpoints(e => e.MapControllers()); })))
        {
            foreach (var action in discovery.Services.GetRequiredService<Microsoft.AspNetCore.Mvc.Infrastructure.IActionDescriptorCollectionProvider>().ActionDescriptors.Items
                .OfType<ControllerActionDescriptor>().Select(a => a.MethodInfo).Distinct())
                discovered.Add(new JsonObject { ["assembly"] = action.DeclaringType!.Assembly.GetName().Name, ["action"] = action.DeclaringType.Name + "." + action.Name });
        }

        var runs = new JsonArray();
        foreach (var (variant, spec) in LegacyResultTypes.Variants)
        {
            foreach (var item in new[] { "legacy", "unrelated", "playlistslibrary" })
            {
                var request = new HttpRequestMessage(HttpMethod.Get, "/JeLegacyResults/" + variant + "/" + item);
                request.Headers.Add("X-Test-User", viewer.ToString("N"));
                if (variant.EndsWith("-accept16", StringComparison.Ordinal))
                {
                    // The answer is negotiated in UTF-16 (a client that asks for it, as /Search/Hints answers it).
                    request.Headers.TryAddWithoutValidation("Accept", "application/json");
                    request.Headers.TryAddWithoutValidation("Accept-Charset", "utf-16");
                }
                var row = new JsonObject { ["variant"] = variant, ["type"] = spec.Type.FullName, ["item"] = item, ["body"] = spec.Body };
                try
                {
                    var response = client.SendAsync(request).GetAwaiter().GetResult();
                    row["status"] = (int)response.StatusCode;
                    row["contentType"] = response.Content.Headers.ContentType?.ToString();
                    row["contentLength"] = response.Content.Headers.ContentLength;
                    var bytes = response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult();
                    // In the character set it says it is in.
                    var charset = response.Content.Headers.ContentType?.CharSet;
                    row["charset"] = charset;
                    row["text"] = (string.IsNullOrEmpty(charset) ? Encoding.UTF8 : Encoding.GetEncoding(charset.Trim('"'))).GetString(bytes);
                    row["length"] = bytes.Length;
                }
                catch (Exception ex)
                {
                    // The test server hands an action's unhandled exception to its client: nothing was sent.
                    row["status"] = -1;
                    row["error"] = ex.GetType().Name;
                    row["text"] = string.Empty;
                }

                runs.Add(row);
            }
        }

        return new JsonObject
        {
            ["universe"] = new JsonArray(universe.Select(u => (JsonNode?)u).ToArray()),
            ["declared"] = declared,
            ["discovered"] = discovered,
            ["runs"] = runs,
        };
    }

    // The exact bytes each body-carrying variant put in its body, per scenario item (the served control's expectation).
    private static JsonObject ExactBodies(LegacyCollageScenario scenario)
    {
        var exact = new JsonObject();
        foreach (var (variant, spec) in LegacyResultTypes.Variants.Where(v => v.Value.Exact != null))
            foreach (var item in new[] { "legacy", "unrelated", "playlistslibrary" })
                exact[variant + "/" + item] = Encoding.UTF8.GetString(spec.Exact!(new LegacyResultTypes.Ctx(scenario, scenario.Names[item])));
        return exact;
    }

    // ── WebSocket corpus ────────────────────────────────────────────────

    private sealed class RecordingSocket : WebSocket
    {
        public List<byte[]> Sent { get; } = new();
        public override WebSocketCloseStatus? CloseStatus => null;
        public override string? CloseStatusDescription => null;
        public override WebSocketState State => WebSocketState.Open;
        public override string? SubProtocol => null;
        public override void Abort() { }
        public override Task CloseAsync(WebSocketCloseStatus closeStatus, string? statusDescription, CancellationToken cancellationToken) => Task.CompletedTask;
        public override Task CloseOutputAsync(WebSocketCloseStatus closeStatus, string? statusDescription, CancellationToken cancellationToken) => Task.CompletedTask;
        public override void Dispose() { }
        public override Task<WebSocketReceiveResult> ReceiveAsync(ArraySegment<byte> buffer, CancellationToken cancellationToken) => throw new NotSupportedException();
        public override Task SendAsync(ArraySegment<byte> buffer, WebSocketMessageType messageType, bool endOfMessage, CancellationToken cancellationToken)
        {
            Sent.Add(buffer.ToArray());
            return Task.CompletedTask;
        }
    }

    /// <summary>The DisplayMessage a dashboard sends, with arguments whose names differ only in case.</summary>
    public static MediaBrowser.Model.Session.GeneralCommand DisplayMessage() => new()
    {
        Name = GeneralCommandType.DisplayMessage,
        ControllingUserId = Guid.Parse("4f0c0a1a-6d55-4c34-9a8d-3b1b2c5d6e7f"),
        Arguments = { ["Header"] = "Server notice", ["Text"] = "Maintenance at 22:00 — ünïcödé ✓ <b>&</b>", ["text"] = "lower-case twin", ["TimeoutMs"] = "5000" },
    };

    // Every outbound WebSocket message type of the release, with payloads as the host fills them (the served items' DTOs
    // where a payload holds one), written by the release's own WebSocketConnection once straight to a socket and once
    // through JE's projecting socket while JE has markers (so the projection runs) and nothing in them is withheld.
    private static JsonArray Corpus(TestServer server, LegacyCollageScenario scenario)
    {
        var withhold = server.Services.GetRequiredService<LegacyCollageWithhold>();
        var logger = server.Services.GetRequiredService<Logger>();
        var connection = LegacySocketHost.HostType("Emby.Server.Implementations", "Emby.Server.Implementations.HttpServer.WebSocketConnection");
        var rows = new JsonArray();
        foreach (var (name, message) in CorpusMessages(scenario))
        {
            var row = new JsonObject { ["name"] = name, ["idle"] = withhold.Begin().Idle };
            try
            {
                var host = new RecordingSocket();
                var je = new RecordingSocket();
                Send(connection, host, message);
                Send(connection, new LegacyCollageSockets.ProjectingSocket(je, withhold, logger), message);
                row["host"] = host.Sent.Count == 1 ? Encoding.UTF8.GetString(host.Sent[0]) : null;
                row["sent"] = je.Sent.Count;
                row["equal"] = host.Sent.Count == 1 && je.Sent.Count == 1 && host.Sent[0].AsSpan().SequenceEqual(je.Sent[0]);
            }
            catch (Exception ex)
            {
                row["error"] = (ex is TargetInvocationException { InnerException: { } inner } ? inner : ex).ToString();
            }

            rows.Add(row);
        }

        return rows;
    }

    private static void Send(Type connectionType, WebSocket socket, object message)
    {
        var logger = Activator.CreateInstance(typeof(Microsoft.Extensions.Logging.Abstractions.NullLogger<>).MakeGenericType(connectionType))!;
        var connection = connectionType.GetConstructors().Single(c => c.GetParameters().Length == 4)
            .Invoke(new object?[] { logger, socket, new MediaBrowser.Controller.Net.AuthorizationInfo { Token = "t", Client = "c", DeviceId = "d", Device = "d", Version = "1" }, IPAddress.Loopback });
        Type? payload = null;
        for (var b = message.GetType(); b != null && payload == null; b = b.BaseType)
            if (b.IsGenericType && b.GetGenericTypeDefinition() == typeof(OutboundWebSocketMessage<>)) payload = b.GetGenericArguments()[0];
        var send = payload == null
            ? connectionType.GetMethods().Single(m => m.Name == "SendAsync" && !m.IsGenericMethod && m.GetParameters()[0].ParameterType.IsInstanceOfType(message))
            : connectionType.GetMethods().Single(m => m.Name == "SendAsync" && m.IsGenericMethod).MakeGenericMethod(payload);
        ((Task)send.Invoke(connection, new object[] { message, CancellationToken.None })!).GetAwaiter().GetResult();
    }

    private static IEnumerable<(string Name, object Message)> CorpusMessages(LegacyCollageScenario scenario)
    {
        var fill = new Filler(scenario);
        foreach (var (type, _) in OutboundMessages())
        {
            if (fill.Make(type, 0) is { } message)
            {
                if (type.Name == "GeneralCommandMessage") type.GetProperty("Data")!.SetValue(message, DisplayMessage());
                yield return (type.Name, message);
            }
        }

        // What SessionManager sends through a session controller's SendMessage<T>: SyncPlay group updates of every kind,
        // and the general command as a dashboard's "Send message" makes it.
        foreach (var update in typeof(MediaBrowser.Model.SyncPlay.PlayQueueUpdate).Assembly.GetTypes().Where(t => t.IsClass && !t.IsAbstract && !t.ContainsGenericParameters && t.Namespace == "MediaBrowser.Model.SyncPlay" && t.BaseType is { IsGenericType: true } b && b.GetGenericTypeDefinition().Name == "GroupUpdate`1"))
            yield return ("SyncPlayGroupUpdate:" + update.Name, Generic(update, fill.Make(update, 0), SessionMessageType.SyncPlayGroupUpdate));
        yield return ("GeneralCommand:DisplayMessage", Generic(typeof(MediaBrowser.Model.Session.GeneralCommand), DisplayMessage(), SessionMessageType.GeneralCommand));
    }

    private static object Generic(Type payload, object? data, SessionMessageType type)
    {
        var message = Activator.CreateInstance(typeof(OutboundWebSocketMessage<>).MakeGenericType(payload))!;
        message.GetType().GetProperty("Data")!.SetValue(message, data);
        message.GetType().GetProperty("MessageType")!.SetValue(message, type);
        message.GetType().GetProperty("MessageId")!.SetValue(message, Guid.Parse("0a1b2c3d-4e5f-4061-8293-a4b5c6d7e8f9"));
        return message;
    }

    // Fills a payload graph the way the host's own objects are filled: every settable value, text with characters a
    // re-encoding would change, dictionaries with keys that differ only in case, item DTOs of served items.
    private sealed class Filler(LegacyCollageScenario scenario)
    {
        private int _n;

        public object? Make(Type t, int depth)
        {
            var n = ++_n;
            if (t == typeof(string)) return "Text " + n + " — ünïcödé ✓ <b>&</b> \"q\"";
            if (t == typeof(bool)) return true;
            if (t == typeof(Guid)) return new Guid(n, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10);
            if (t == typeof(DateTime)) return new DateTime(2025, 6, 1, 12, 30, 15, DateTimeKind.Utc).AddMilliseconds(n);
            if (t == typeof(DateTimeOffset)) return new DateTimeOffset(2025, 6, 1, 12, 30, 15, TimeSpan.Zero);
            if (t == typeof(TimeSpan)) return TimeSpan.FromSeconds(n);
            if (t == typeof(Version)) return new Version(10, n);
            if (t == typeof(double) || t == typeof(float) || t == typeof(decimal)) return Convert.ChangeType(n + 0.5, t, System.Globalization.CultureInfo.InvariantCulture);
            if (t.IsPrimitive) return Convert.ChangeType(n % 100 + 1, t, System.Globalization.CultureInfo.InvariantCulture);
            if (t.IsEnum) return Enum.GetValues(t).Cast<object>().Skip(1).FirstOrDefault() ?? Enum.GetValues(t).Cast<object>().First();
            if (Nullable.GetUnderlyingType(t) is { } inner) return Make(inner, depth);
            if (t == typeof(BaseItemDto)) return scenario.Dto(scenario.Names[n % 2 == 0 ? "unrelated" : "custom"]);
            if (depth > 5 || t == typeof(object) || typeof(Stream).IsAssignableFrom(t) || typeof(Delegate).IsAssignableFrom(t)) return null;
            if (t.IsArray)
            {
                var array = Array.CreateInstance(t.GetElementType()!, 2);
                array.SetValue(Make(t.GetElementType()!, depth + 1), 0);
                array.SetValue(Make(t.GetElementType()!, depth + 1), 1);
                return array;
            }

            if (t.IsGenericType && t.GetGenericArguments().Length == 2 && typeof(IDictionary).IsAssignableFrom(t.IsInterface ? typeof(Dictionary<,>).MakeGenericType(t.GetGenericArguments()) : t))
            {
                var dictionary = (IDictionary)Activator.CreateInstance(typeof(Dictionary<,>).MakeGenericType(t.GetGenericArguments()))!;
                var (key, value) = (t.GetGenericArguments()[0], t.GetGenericArguments()[1]);
                if (key == typeof(string))
                {
                    dictionary["Header"] = Make(value, depth + 1);
                    dictionary["Text"] = Make(value, depth + 1);
                    dictionary["text"] = Make(value, depth + 1);
                }
                else if (Make(key, depth + 1) is { } k)
                {
                    dictionary[k] = Make(value, depth + 1);
                }

                return dictionary;
            }

            if (t.IsGenericType && t.GetGenericArguments().Length == 1 && typeof(IEnumerable).IsAssignableFrom(t))
            {
                var element = t.GetGenericArguments()[0];
                var list = (IList)Activator.CreateInstance(typeof(List<>).MakeGenericType(element))!;
                list.Add(Make(element, depth + 1));
                list.Add(Make(element, depth + 1));
                if (t.IsAssignableFrom(list.GetType())) return list;
                var array = Array.CreateInstance(element, 2);
                list.CopyTo(array, 0);
                return t.IsAssignableFrom(array.GetType()) ? array : Activator.CreateInstance(t, list);
            }

            if (t.IsInterface || t.IsAbstract) return null;
            object? instance;
            try
            {
                var constructor = t.GetConstructor(Type.EmptyTypes) ?? t.GetConstructors().OrderByDescending(c => c.GetParameters().Length).FirstOrDefault();
                instance = constructor == null ? null : constructor.Invoke(constructor.GetParameters().Select(p => Make(p.ParameterType, depth + 1)).ToArray());
            }
            catch (TargetInvocationException)
            {
                return null;
            }

            if (instance == null) return null;
            foreach (var property in t.GetProperties(BindingFlags.Public | BindingFlags.Instance).Where(p => p.CanWrite && p.SetMethod!.IsPublic && p.GetIndexParameters().Length == 0))
            {
                try { property.SetValue(instance, Make(property.PropertyType, depth + 1)); }
                catch (Exception ex) when (ex is TargetInvocationException or ArgumentException) { }
            }

            return instance;
        }
    }
}
