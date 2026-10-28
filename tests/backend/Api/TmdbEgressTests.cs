using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using System.Diagnostics.Metrics;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;
using MediaBrowser.Controller;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class TmdbEgressTests
{
    [Theory]
    [InlineData("api.themoviedb.org")]
    [InlineData("image.tmdb.org")]
    [InlineData("images.tmdb.org")]
    public async Task EgressR5EightyAdminProbesRefuseTypedWithoutSocketsOrAdmission(string host)
    {
        using var plugin = new ApiPluginFixture();
        plugin.Plugin.Configuration.ArrRequestBackend = "je";
        var refused = 0L;
        using var listener = new MeterListener { InstrumentPublished = (instrument, meter) => {
            if (instrument.Meter.Name == "JellyfinEnhanced.TmdbEgress") meter.EnableMeasurementEvents(instrument);
        } };
        listener.SetMeasurementEventCallback<long>((_, value, _, _) => Interlocked.Add(ref refused, value));
        listener.Start();
        var sends = 0;
        using var net = new IntegrationTransport((_, _) => { Interlocked.Increment(ref sends); return Task.FromResult(IntegrationTransport.Response("{}", 404)); });
        var controller = ApiAssetTests.Controller(plugin.Core, net);
        var viewer = Guid.NewGuid();
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity(new[] {
            new Claim("Jellyfin-UserId", viewer.ToString()), new Claim(ClaimTypes.Role, "Administrator") }, "test"));
        var admission = new ViewerMetadataAdmission();
        using var scope = ViewerMetadataAdmission.ForViewer(viewer);
        var events = 0;
        using var observation = MetadataTaskProbe.Observe(_ => events++);
        var results = await Task.WhenAll(Enumerable.Range(0, 80).Select(_ => controller.IdentifyUrl("https://" + host + "/3/movie/1"))).WaitAsync(TimeSpan.FromSeconds(20));
        Assert.Equal(0, sends);
        Assert.Equal(0, events);
        Assert.Equal(80, refused);
        Assert.Equal(0, admission.Count());
        Assert.All(results, result => {
            var typed = Assert.IsType<BadRequestObjectResult>(result);
            var body = JsonSerializer.SerializeToElement(typed.Value);
            Assert.False(body.GetProperty("reachable").GetBoolean());
            Assert.Equal("unavailable", body.GetProperty("outcome").GetString());
            Assert.Equal("tmdb_admission_required", body.GetProperty("code").GetString());
            Assert.Equal("tmdb_admission_required", body.GetProperty("reason").GetString());
            Assert.Equal("TMDB hosts are checked through the metadata source; use the TMDB test instead", body.GetProperty("message").GetString());
        });
    }

    // A supplied factory really constructs a bare HttpClient. The production acquisition boundary
    // must attach its guard; the test never manually installs one on this client.
    private sealed class BareFactory : IHttpClientFactory
    {
        internal int Sends;
        public HttpClient CreateClient(string name) => new(new Sink(this));
        private sealed class Sink(BareFactory owner) : HttpMessageHandler
        {
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            { Interlocked.Increment(ref owner.Sends); return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = request }); }
        }
    }

    [Fact]
    public async Task EgressR5PlantedBareFactoryClientIsRefusedAtRuntime()
    {
        var factory = new BareFactory();
        using var client = SeerrHttpHelper.CreateClient(factory);
        var error = await Record.ExceptionAsync(() => client.GetAsync("https://api.themoviedb.org/3/movie/1"));
        Assert.NotNull(error);
        Assert.Equal("TmdbEgressRefusedException", error.GetType().Name);
        Assert.Equal(0, factory.Sends);
    }

    [Fact]
    public async Task EgressR5CopiedCapabilityCannotCreateASecondSendWhileOwnerIsLive()
    {
        var factory = new BareFactory();
        using var admission = new MetadataAdmission("test-replay");
        using var response = await TmdbTransport.GetAsync(factory, "https://api.themoviedb.org/3/movie/1", admission, CancellationToken.None);
        Assert.Equal(0, admission.Sends.CurrentCount); // The first body still owns its send turn.
        using var replay = new HttpRequestMessage(HttpMethod.Get, response.RequestMessage!.RequestUri);
        foreach (var option in response.RequestMessage.Options)
            replay.Options.Set(new HttpRequestOptionsKey<object?>(option.Key), option.Value);
        using var client = SeerrHttpHelper.CreateClient(factory);
        var error = await Record.ExceptionAsync(() => client.SendAsync(replay));
        Assert.Equal("TmdbEgressRefusedException", error?.GetType().Name);
        Assert.Equal(1, factory.Sends);
    }

    [Theory]
    [InlineData("api.themoviedb.org")]
    [InlineData("image.tmdb.org")]
    [InlineData("images.tmdb.org")]
    public async Task EgressR5ReservedHostHeaderCannotHideBehindAGenericTarget(string host)
    {
        var factory = new BareFactory();
        using var client = SeerrHttpHelper.CreateClient(factory);
        using var request = new HttpRequestMessage(HttpMethod.Get, "https://provider.invalid/metadata");
        request.Headers.Host = host;
        var error = await Record.ExceptionAsync(() => client.SendAsync(request));
        Assert.Equal("TmdbEgressRefusedException", error?.GetType().Name);
        Assert.Equal(0, factory.Sends);
    }

    [Fact]
    public async Task EgressNonTmdbAdminProbeRetainsReachability()
    {
        using var plugin = new ApiPluginFixture();
        var sends = 0;
        using var net = new IntegrationTransport((_, _) => { sends++; return Task.FromResult(IntegrationTransport.Response("<title>Bazarr</title>", 200, "text/html")); });
        var controller = ApiAssetTests.Controller(plugin.Core, net);
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim(ClaimTypes.Role, "Administrator") }, "test"));
        var result = Assert.IsType<OkObjectResult>(await controller.IdentifyUrl("http://127.0.0.1:18799"));
        var body = JsonSerializer.SerializeToElement(result.Value);
        Assert.True(body.GetProperty("reachable").GetBoolean());
        Assert.Equal("Bazarr", body.GetProperty("service").GetString());
        Assert.Equal(4, sends);
    }

    private static ServiceProvider ProductionHttp(Action<IServiceCollection>? configure = null)
    {
        var registered = new ServiceCollection();
        new PluginServiceRegistrator().RegisterServices(registered, Mock.Of<IServerApplicationHost>());
        // Real production HTTP descriptors only; no unrelated hosted services are started.
        var services = new ServiceCollection();
        foreach (var d in registered.Where(d => d.ServiceType == typeof(IHttpClientFactory)
            || d.ServiceType == typeof(IHttpMessageHandlerFactory) || d.ServiceType == typeof(HttpMessageHandlerBuilder)
            || d.ServiceType == typeof(IHttpMessageHandlerBuilderFilter)
            || d.ServiceType.Namespace?.StartsWith("Microsoft.Extensions.", StringComparison.Ordinal) == true
            || d.ServiceType == typeof(Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation.AutomationTransportHandler)
            || d.ServiceType == typeof(Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends.SeerrIsolationTransportHandler)
            || d.ServiceType == typeof(Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends.EffectiveRequestsBackend))) ((IServiceCollection)services).Add(d);
        services.AddLogging();
        services.AddMetrics();
        configure?.Invoke(services);
        return services.BuildServiceProvider();
    }

    [Fact]
    public void ProductionPluginNamesLeaveTheHostUnnamedRedirectPolicyIndependent()
    {
        using var services = ProductionHttp();
        HttpMessageHandler handler = services.GetRequiredService<IHttpMessageHandlerFactory>().CreateHandler(string.Empty);
        while (handler is DelegatingHandler delegating) handler = delegating.InnerHandler!;
        Assert.True(handler switch
        {
            HttpClientHandler http => http.AllowAutoRedirect,
            SocketsHttpHandler sockets => sockets.AllowAutoRedirect,
            _ => throw new InvalidOperationException("Unreviewed host primary: " + handler.GetType().Name),
        });
    }

    [Theory]
    [InlineData("JellyfinEnhanced.Tmdb")]
    [InlineData("JellyfinEnhanced.Http")]
    [InlineData("JellyfinEnhancedSeerr")]
    [InlineData("JellyfinEnhanced.Arr")]
    [InlineData("JellyfinEnhanced.Notify")]
    [InlineData("JellyfinEnhanced.ListSources")]
    public async Task EgressArchitectureEveryProductionNamedPipelineRefusesWithoutNetwork(string name)
    {
        var recorder = new RecordingPrimaryFilter();
        using var services = ProductionHttp(s => s.AddSingleton<IHttpMessageHandlerBuilderFilter>(recorder));
        // Actual production handlers; only the socket-facing primary is replaced by a recorder.
        using var client = services.GetRequiredService<IHttpClientFactory>().CreateClient(name);
        var error = await Record.ExceptionAsync(() => client.GetAsync("https://api.themoviedb.org/3/movie/1"));
        Assert.Equal("TmdbEgressRefusedException", error?.GetType().Name);
        Assert.Equal(0, recorder.Sends);
    }

    private sealed class TmdbPipelineProbe : IHttpMessageHandlerBuilderFilter
    {
        internal readonly List<(string Name, bool Redirects, bool GuardFirst)> Pipelines = new();
        internal readonly List<HttpRequestMessage> Sent = new();
        internal bool Redirect = true;
        public Action<HttpMessageHandlerBuilder> Configure(Action<HttpMessageHandlerBuilder> next) => builder =>
        {
            next(builder);
            var redirects = builder.PrimaryHandler switch {
                HttpClientHandler h => h.AllowAutoRedirect,
                SocketsHttpHandler h => h.AllowAutoRedirect,
                _ => throw new InvalidOperationException("Expected the actual production primary.")
            };
            Pipelines.Add((builder.Name!, redirects, builder.AdditionalHandlers.FirstOrDefault() is TmdbEgressHandler));
            builder.PrimaryHandler.Dispose();
            builder.PrimaryHandler = new Sink(this);
        };
        private sealed class Sink(TmdbPipelineProbe owner) : HttpMessageHandler
        {
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
            {
                Assert.True(TmdbEgressHandler.HasCapability(request));
                owner.Sent.Add(request);
                var response = IntegrationTransport.Response("{}", owner.Redirect ? 302 : owner.Sent.Count == 1 ? 503 : 200);
                if (owner.Redirect) response.Headers.Location = new Uri("https://redirect-target.invalid/escaped");
                return Task.FromResult(response);
            }
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task TmdbR7ActualSelectedPipelineRefusesCrossHostRedirects(bool images)
    {
        var probe = new TmdbPipelineProbe();
        // Capture AFTER every production builder/filter has configured its real primary.
        using var services = ProductionHttp(s => s.Insert(0, ServiceDescriptor.Singleton<IHttpMessageHandlerBuilderFilter>(probe)));
        var factory = services.GetRequiredService<IHttpClientFactory>();
        using var admission = new MetadataAdmission("r7-redirect", images);
        using var response = await TmdbTransport.GetAsync(factory,
            images ? "https://image.tmdb.org/t/p/w300/fixture.jpg" : "https://api.themoviedb.org/3/person/1", admission, default);
        var pipeline = Assert.Single(probe.Pipelines);
        Assert.False(pipeline.Redirects, "The actual transport-selected primary must never follow redirects below the guard.");
        Assert.True(pipeline.GuardFirst);
        Assert.Equal("JellyfinEnhanced.Tmdb", pipeline.Name);
        Assert.Equal(HttpStatusCode.Found, response.StatusCode); // unavailable upstream, never a successful fact
        Assert.Single(probe.Sent);
        Assert.NotEqual("redirect-target.invalid", probe.Sent[0].RequestUri!.Host);
    }

    [Theory]
    [InlineData("")]
    [InlineData("JellyfinEnhanced.ListSources")]
    public async Task TmdbR7EveryRetryHasAFreshCapabilityThroughProductionGuards(string clientName)
    {
        var probe = new TmdbPipelineProbe { Redirect = false };
        using var services = ProductionHttp(s => s.Insert(0, ServiceDescriptor.Singleton<IHttpMessageHandlerBuilderFilter>(probe)));
        var factory = services.GetRequiredService<IHttpClientFactory>();
        using var admission = new MetadataAdmission("r7-retry");
        using (var first = await TmdbTransport.GetAsync(factory, "https://api.themoviedb.org/3/person/1", admission, default, clientName))
            Assert.Equal(HttpStatusCode.ServiceUnavailable, first.StatusCode);
        using (var retry = await TmdbTransport.GetAsync(factory, "https://api.themoviedb.org/3/person/1", admission, default, clientName))
            Assert.Equal(HttpStatusCode.OK, retry.StatusCode);
        Assert.Equal(2, probe.Sent.Count);
        Assert.NotSame(probe.Sent[0], probe.Sent[1]);
        Assert.All(probe.Sent, r => Assert.True(TmdbEgressHandler.HasCapability(r)));
    }

    private sealed class RecordingPrimaryFilter : IHttpMessageHandlerBuilderFilter
    {
        internal int Sends;
        public Action<HttpMessageHandlerBuilder> Configure(Action<HttpMessageHandlerBuilder> next) => builder =>
        { next(builder); builder.PrimaryHandler = new Sink(this); };
        private sealed class Sink(RecordingPrimaryFilter owner) : HttpMessageHandler
        {
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            { Interlocked.Increment(ref owner.Sends); return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = request }); }
        }
    }

    [Fact]
    public async Task EgressArchitectureAdmittedApiAndImageSendsTraverseBothProductionGuards()
    {
        var recorder = new RecordingPrimaryFilter();
        using var services = ProductionHttp(s => s.AddSingleton<IHttpMessageHandlerBuilderFilter>(recorder));
        var factory = services.GetRequiredService<IHttpClientFactory>();
        using var metadata = new MetadataAdmission("test-metadata");
        using (var response = await TmdbTransport.GetAsync(factory, "https://api.themoviedb.org/3/movie/1", metadata, CancellationToken.None))
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var image = new MetadataAdmission("test-image", images: true);
        using (var response = await TmdbTransport.GetAsync(factory, "https://image.tmdb.org/t/p/w300/a.jpg", image, CancellationToken.None))
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(2, recorder.Sends);
    }

    [Fact]
    public async Task EgressAdmissionIsExplicitLiveAndBoundToRequestAndImageKind()
    {
        var factory = new BareFactory();
        using var client = SeerrHttpHelper.CreateClient(factory);
        using var admission = new MetadataAdmission("test");
        // An ambient capability cannot authorize a generic sender.
        await Assert.ThrowsAsync<TmdbEgressRefusedException>(() => client.GetAsync("https://api.themoviedb.org/3/movie/1"));
        using (var response = await TmdbTransport.GetAsync(factory, "https://api.themoviedb.org/3/movie/1", admission, CancellationToken.None))
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var request = new HttpRequestMessage(HttpMethod.Get, "https://api.themoviedb.org/3/movie/1");
        TmdbEgressHandler.Attach(request, admission);
        request.RequestUri = new Uri("https://image.tmdb.org/t/p/w300/a.jpg");
        await Assert.ThrowsAsync<TmdbEgressRefusedException>(() => client.SendAsync(request));
        using var wrongHost = new HttpRequestMessage(HttpMethod.Get, "https://api.themoviedb.org/3/movie/1");
        TmdbEgressHandler.Attach(wrongHost, admission);
        wrongHost.Headers.Host = "image.tmdb.org";
        await Assert.ThrowsAsync<TmdbEgressRefusedException>(() => client.SendAsync(wrongHost));
        using var expired = new HttpRequestMessage(HttpMethod.Get, "https://api.themoviedb.org/3/movie/2");
        TmdbEgressHandler.Attach(expired, admission);
        admission.Dispose();
        await Assert.ThrowsAsync<TmdbEgressRefusedException>(() => client.SendAsync(expired));
        Assert.Equal(1, factory.Sends);
        using var image = new MetadataAdmission("test-image", images: true);
        using var imageResponse = await TmdbTransport.GetAsync(factory, "https://image.tmdb.org/t/p/w300/a.jpg", image, CancellationToken.None);
        Assert.Equal(2, factory.Sends);
    }

    [Fact]
    public async Task EgressRedirectsReenterGuardAndNonTmdbRedirectsStillWork()
    {
        var sends = 0;
        using var sink = new IntegrationTransport((request, _) => {
            sends++;
            var response = IntegrationTransport.Response("{}");
            if (request.RequestUri!.AbsolutePath == "/start") { response.StatusCode = HttpStatusCode.Found; response.Headers.Location = new Uri("https://api.themoviedb.org/3/movie/1"); }
            else if (request.RequestUri.AbsolutePath == "/safe") { response.StatusCode = HttpStatusCode.Found; response.Headers.Location = new Uri("/end", UriKind.Relative); }
            return Task.FromResult(response);
        });
        using var client = new HttpClient(new TmdbRedirectHandler { InnerHandler = new TmdbEgressHandler { InnerHandler = sink } });
        await Assert.ThrowsAsync<TmdbEgressRefusedException>(() => client.GetAsync("https://example.invalid/start"));
        Assert.Equal(1, sends);
        using var response = await client.GetAsync("https://example.invalid/safe");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(3, sends);
    }

    [Fact]
    public async Task EgressArchitectureEveryClientConstructionSiteReachesRuntimeGuard()
    {
        var compilation = WriteGateWalk.Plugin.Compilation;
        var inventory = new List<object>();
        var registered = new HashSet<string>(StringComparer.Ordinal);
        static bool ClientType(ITypeSymbol? type)
        {
            if (type is not INamedTypeSymbol named) return false;
            if (named.TypeArguments.Any(ClientType)) return true;
            for (var current = named; current != null; current = current.BaseType)
                if (current.ToDisplayString() is "System.Net.Http.HttpClient" or "System.Net.Http.HttpMessageInvoker") return true;
            return false;
        }
        foreach (var tree in compilation.SyntaxTrees)
        {
            var model = compilation.GetSemanticModel(tree);
            foreach (var node in tree.GetRoot().DescendantNodes().Where(n => n is Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax or Microsoft.CodeAnalysis.CSharp.Syntax.BaseObjectCreationExpressionSyntax))
            {
                if (model.GetSymbolInfo(node).Symbol is not Microsoft.CodeAnalysis.IMethodSymbol method) continue;
                var type = method.ContainingType.ToDisplayString();
                if (method.Name == "AddHttpClient" && type == "Microsoft.Extensions.DependencyInjection.HttpClientFactoryServiceCollectionExtensions")
                {
                    var call = Assert.IsType<Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax>(node);
                    Assert.NotEmpty(call.ArgumentList.Arguments);
                    var name = model.GetConstantValue(call.ArgumentList.Arguments[0].Expression);
                    Assert.True(name.HasValue && name.Value is string text && PluginHttp.Owns(text), "HTTP registration needs an explicit guarded plugin name");
                    registered.Add((string)name.Value!);
                }
                var construction = method.MethodKind == MethodKind.Constructor && ClientType(method.ContainingType);
                var acquisition = method.MethodKind != MethodKind.Constructor && ClientType(method.ReturnType);
                var delegatedArr = method.MethodKind == MethodKind.DelegateInvoke
                    && node is Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax { Expression: Microsoft.CodeAnalysis.CSharp.Syntax.IdentifierNameSyntax receiver }
                    && model.GetSymbolInfo(receiver).Symbol is IFieldSymbol { Name: "_http" } field
                    && field.ContainingType.ToDisplayString() == "Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.ArrClient";
                if (method.MethodKind == MethodKind.Constructor && type == "Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.ArrClient")
                {
                    Assert.Equal("Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.ArrClientFactory", model.GetEnclosingSymbol(node.SpanStart)?.ContainingType?.ToDisplayString());
                    var created = Assert.IsAssignableFrom<Microsoft.CodeAnalysis.CSharp.Syntax.BaseObjectCreationExpressionSyntax>(node);
                    var producer = Assert.Single(created.ArgumentList!.Arguments.Where(argument =>
                        model.GetTypeInfo(argument.Expression).ConvertedType is INamedTypeSymbol { Name: "Func", Arity: 1 } function
                        && function.TypeArguments[0].ToDisplayString() == "System.Net.Http.HttpClient"));
                    Assert.True(producer.Expression is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedLambdaExpressionSyntax { Body: Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax guarded }
                        && (model.GetSymbolInfo(guarded).Symbol as IMethodSymbol)?.ContainingType.ToDisplayString() == "Jellyfin.Plugin.JellyfinEnhanced.Services.PluginHttp",
                        "The arr delegate must be produced by guarded acquisition");
                }
                if (acquisition && !delegatedArr)
                    Assert.True(type is "System.Net.Http.IHttpClientFactory" or "System.Net.Http.HttpClientFactoryExtensions"
                        or "Jellyfin.Plugin.JellyfinEnhanced.Services.PluginHttp" or "Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr.SeerrHttpHelper",
                        "Client obtained outside guarded acquisition: " + TmdbTransportArchitectureTests.Identity(node, model));
                if (!acquisition && !construction) continue;
                var enclosing = model.GetEnclosingSymbol(node.SpanStart)?.ContainingType?.ToDisplayString();
                var identity = TmdbTransportArchitectureTests.Identity(node, model);
                if (type is "System.Net.Http.IHttpClientFactory" or "System.Net.Http.HttpClientFactoryExtensions")
                {
                    if (enclosing == "Jellyfin.Plugin.JellyfinEnhanced.Services.TmdbTransport")
                        Assert.Contains(node.Ancestors().OfType<Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax>(), wrapper =>
                            (model.GetSymbolInfo(wrapper).Symbol as IMethodSymbol)?.GetDocumentationCommentId()
                                == "M:Jellyfin.Plugin.JellyfinEnhanced.Services.PluginHttp.CheckedClient(System.Net.Http.HttpClient)");
                    else Assert.Equal("Jellyfin.Plugin.JellyfinEnhanced.Services.PluginHttp", enclosing);
                }
                if (construction)
                {
                    Assert.True(enclosing is "Jellyfin.Plugin.JellyfinEnhanced.Services.PluginHttp" or "Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live.ArrLiveService", identity);
                    Assert.Contains(node.DescendantNodes(), child => model.GetTypeInfo(child).Type?.ToDisplayString() == "Jellyfin.Plugin.JellyfinEnhanced.Services.TmdbEgressHandler");
                }
                var factory = new BareFactory();
                using var client = type == "Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr.SeerrHttpHelper"
                    ? SeerrHttpHelper.CreateClient(factory) : PluginHttp.CreateClient(factory);
                await Assert.ThrowsAsync<TmdbEgressRefusedException>(() => client.GetAsync("https://image.tmdb.org/t/p/w300/a.jpg"));
                Assert.Equal(0, factory.Sends);
                inventory.Add(new { identity, line = node.GetLocation().GetLineSpan().StartLinePosition.Line + 1, handler = true });
            }
        }
        Assert.Equal(new[] { TmdbTransport.ClientName, PluginHttp.DefaultClient, SeerrHttpHelper.NamedClient,
            Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.ArrHttp.ClientName,
            Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify.NotifyEndpoints.ClientName,
            Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources.SourceHttp.ClientName }.Order(), registered.Order());
        Assert.True(inventory.Count > 50);
        if (Environment.GetEnvironmentVariable("JE_EGRESS_INVENTORY") is { } path)
            File.WriteAllText(path, JsonSerializer.Serialize(inventory, new JsonSerializerOptions { WriteIndented = true }));
    }

    [Fact]
    public async Task EgressArchitectureActualArrWebSocketInvokerHasRuntimeGuard()
    {
        var type = typeof(Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live.ArrLiveService);
        var instance = System.Runtime.CompilerServices.RuntimeHelpers.GetUninitializedObject(type);
        type.GetMethod("Connector", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(instance, null);
        using var invoker = (HttpMessageInvoker)type.GetField("_invoker", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(instance)!;
        using var request = new HttpRequestMessage(HttpMethod.Get, "https://image.tmdb.org/t/p/w300/a.jpg");
        await Assert.ThrowsAsync<TmdbEgressRefusedException>(() => invoker.SendAsync(request, CancellationToken.None));
    }

    [Fact]
    public void EgressInventoryHashesForReviewedPrimitives()
    {
        if (Environment.GetEnvironmentVariable("JE_EGRESS_SYMBOLS") is { } path)
            File.WriteAllText(path, JsonSerializer.Serialize(TmdbTransportArchitectureTests.HttpSites(WriteGateWalk.Plugin.Compilation)));
    }

    [Fact]
    public void EgressArchitectureProductionPrimariesCannotRedirectBehindTheGuard()
    {
        using var services = ProductionHttp();
        var factory = services.GetRequiredService<IHttpMessageHandlerFactory>();
        foreach (var name in new[] { TmdbTransport.ClientName, PluginHttp.DefaultClient, SeerrHttpHelper.NamedClient,
            Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.ArrHttp.ClientName,
            Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify.NotifyEndpoints.ClientName,
            Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources.SourceHttp.ClientName })
        {
            var current = factory.CreateHandler(name);
            var guards = 0;
            while (current is DelegatingHandler handler)
            {
                if (current is TmdbEgressHandler) guards++;
                current = handler.InnerHandler!;
            }
            Assert.Equal(1, guards);
            Assert.False(current switch {
                HttpClientHandler http => http.AllowAutoRedirect,
                SocketsHttpHandler sockets => sockets.AllowAutoRedirect,
                _ => throw new InvalidOperationException("Unreviewed production primary: " + current.GetType().Name),
            });
        }
    }

}
