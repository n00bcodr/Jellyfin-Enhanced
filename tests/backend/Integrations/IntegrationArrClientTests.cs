using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;

namespace JE.Tests;

/// <summary>
/// The hardened arr client: header-only API key, no redirects, typed errors (with the arr's stack
/// trace dropped), appName and version gates, size caps, retry/backoff for GETs only, paging and
/// cancellation.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationArrClientTests
{
    private const string Key = "arr-test-key-000000000000000000";

    private static ArrClient Client(IntegrationTransport transport, ArrKind kind = ArrKind.Radarr, string url = "http://radarr.lan:7878", List<TimeSpan>? delays = null)
        => new(new ArrConnection { Id = Guid.NewGuid().ToString(), Kind = kind, Name = "Test", Url = url }, Key,
            () => new HttpClient(transport, false) { Timeout = Timeout.InfiniteTimeSpan },
            (d, _) => { delays?.Add(d); return Task.CompletedTask; });

    private static string Status(string app, string version) => JsonSerializer.Serialize(new { appName = app, instanceName = app + "-lab", version, branch = "master", urlBase = "" });

    [Theory]
    [InlineData(ArrKind.Radarr, "Radarr", "6.0.4.10291", true, true, true, false)]
    [InlineData(ArrKind.Radarr, "Radarr", "5.5.3.8819", true, false, false, false)]
    [InlineData(ArrKind.Radarr, "Radarr", "5.6.0.8846", true, true, false, false)]
    [InlineData(ArrKind.Radarr, "Radarr", "4.7.5.7809", true, false, false, true)]
    [InlineData(ArrKind.Radarr, "Radarr", "3.2.2.5080", false, false, false, false)]
    [InlineData(ArrKind.Sonarr, "Sonarr", "4.0.20.3014", true, true, false, false)]
    [InlineData(ArrKind.Sonarr, "Sonarr", "3.0.10.1567", false, true, false, false)]
    public async Task StatusChecksTheAppAndDerivesVersionGates(ArrKind kind, string app, string version, bool supported, bool wanted, bool strictTags, bool restrictions)
    {
        using var transport = new IntegrationTransport((request, _) =>
        {
            Assert.Equal("/api/v3/system/status", request.RequestUri!.AbsolutePath);
            Assert.Equal(Key, Assert.Single(request.Headers.GetValues("X-Api-Key")));
            Assert.DoesNotContain(Key, request.RequestUri.ToString());
            return Task.FromResult(IntegrationTransport.Response(Status(app, version)));
        });
        var result = await Client(transport, kind).GetSystemStatusAsync();
        Assert.True(result.Ok);
        var caps = result.Value.Capabilities;
        Assert.Equal(supported, caps.Supported);
        Assert.Equal(wanted, caps.Has(ArrCapabilities.WantedLists));
        Assert.Equal(strictTags, caps.Has(ArrCapabilities.StrictTagLabels));
        Assert.Equal(restrictions, caps.Has(ArrCapabilities.Restrictions));
        Assert.Equal(kind == ArrKind.Sonarr && version.StartsWith('3'), caps.Has(ArrCapabilities.LanguageProfiles));
        Assert.Equal(app + "-lab", result.Value.Status.InstanceName);
    }

    [Fact]
    public async Task StatusIsCachedUntilRefreshed()
    {
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response(Status("Radarr", "6.0.0.1"))));
        var client = Client(transport);
        await client.GetSystemStatusAsync();
        await client.GetSystemStatusAsync();
        Assert.Equal(1, transport.Calls);
        await client.GetSystemStatusAsync(refresh: true);
        Assert.Equal(2, transport.Calls);
    }

    [Theory]
    [InlineData(ArrKind.Sonarr, "Radarr")]
    [InlineData(ArrKind.Radarr, "Lidarr")]
    public async Task TheWrongAppIsRejected(ArrKind kind, string app)
    {
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response(Status(app, "2.0.0.1"))));
        var result = await Client(transport, kind).GetSystemStatusAsync();
        Assert.Equal(ArrErrorKind.WrongApp, result.Error!.Kind);
        Assert.Contains(app, result.Error.Message);
    }

    [Fact]
    public async Task AnyOtherJsonAnswerIsNotAStatus()
    {
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response("""{"ServerName":"jellyfin"}""")));
        Assert.Equal(ArrErrorKind.WrongApp, (await Client(transport).GetSystemStatusAsync()).Error!.Kind);
    }

    [Theory]
    [InlineData(401, "", ArrErrorKind.Unauthorized)]
    [InlineData(403, "", ArrErrorKind.Unauthorized)]
    [InlineData(404, """{"type":"https://tools.ietf.org/html/rfc9110#section-15.5.5","title":"Not Found","status":404,"traceId":"00-ab"}""", ArrErrorKind.NotFound)]
    [InlineData(409, """{"message":"Couldn't find requested release in cache"}""", ArrErrorKind.Conflict)]
    [InlineData(500, """{"message":"Movie with ID 999 does not exist","description":"NzbDrone.Core.Datastore.ModelNotFoundException: at NzbDrone.Core.Datastore.BasicRepository`1.Get(Int32 id) in ./Radarr.Core/Datastore/BasicRepository.cs:line 75"}""", ArrErrorKind.Server)]
    public async Task ErrorShapesAreNormalisedAndStackTracesDropped(int status, string body, ArrErrorKind kind)
    {
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response(body, status)));
        var result = await Client(transport).GetAsync<JsonElement>("movie/999", callClass: ArrCallClass.Write);
        var error = result.Error!;
        Assert.Equal(kind, error.Kind);
        Assert.Equal(status, error.HttpStatus);
        Assert.DoesNotContain("BasicRepository", error.ToString());
        Assert.DoesNotContain("line 75", error.Message);
        if (status == 500) Assert.Contains("Movie with ID 999 does not exist", error.Message);
        if (status == 404) Assert.Contains("Not Found", error.Message);
    }

    [Fact]
    public async Task ValidationArraysKeepMessagesButNotAttemptedValues()
    {
        var body = """[{"propertyName":"Path","errorMessage":"Path is already configured for an existing movie","attemptedValue":"/secret/path/value","severity":"error","errorCode":"MoviePathValidator"},{"propertyName":"QualityProfileId","errorMessage":"Must be greater than '0'.","attemptedValue":0}]""";
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response(body, 400)));
        var result = await Client(transport).SendAsync<JsonElement>(HttpMethod.Post, "movie", new { title = "x" });
        var error = result.Error!;
        Assert.Equal(ArrErrorKind.Validation, error.Kind);
        Assert.Equal(["Path", "QualityProfileId"], error.Validation.Select(v => v.Property));
        Assert.Contains("already configured", error.Message);
        Assert.DoesNotContain("/secret/path/value", error.ToString());
        Assert.DoesNotContain("/secret/path/value", JsonSerializer.Serialize(error));
    }

    [Fact]
    public async Task RedirectsAreReportedNotFollowed()
    {
        using var transport = new IntegrationTransport((_, _) =>
        {
            var response = new HttpResponseMessage(HttpStatusCode.Found);
            response.Headers.Location = new Uri("https://login.example/auth");
            return Task.FromResult(response);
        });
        var result = await Client(transport).GetAsync<JsonElement>("movie");
        Assert.Equal(ArrErrorKind.Redirect, result.Error!.Kind);
        Assert.DoesNotContain("login.example", result.Error.Message);
        Assert.Equal(1, transport.Calls);
        // The production handler is configured the same way.
        using var handler = ArrHttp.CreateHandler();
        Assert.False(handler.AllowAutoRedirect);
        Assert.False(handler.UseProxy);
        Assert.NotNull(handler.ConnectCallback);
    }

    [Fact]
    public async Task AnHtmlPageIsAnInvalidResponse()
    {
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response("<html><title>Sign in</title></html>", 200, "text/html")));
        Assert.Equal(ArrErrorKind.InvalidResponse, (await Client(transport).GetAsync<JsonElement>("movie")).Error!.Kind);
    }

    [Fact]
    public async Task ResponsesOverTheCapAreRefusedWhetherDeclaredOrStreamed()
    {
        var big = "[" + string.Join(",", Enumerable.Repeat("\"" + new string('x', 1000) + "\"", 3000)) + "]"; // ~3 MB
        using var declared = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response(big)));
        var client = Client(declared);
        client.BudgetOverride = _ => (TimeSpan.FromSeconds(30), 1024 * 1024);
        Assert.Equal(ArrErrorKind.TooLarge, (await client.GetAsync<JsonElement>("movie")).Error!.Kind);

        using var streamed = new IntegrationTransport((_, _) =>
        {
            var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(new MemoryStream(Encoding.UTF8.GetBytes(big))) };
            response.Content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/json");
            response.Content.Headers.ContentLength = null;
            return Task.FromResult(response);
        });
        var streamedClient = Client(streamed);
        streamedClient.BudgetOverride = _ => (TimeSpan.FromSeconds(30), 1024 * 1024);
        Assert.Equal(ArrErrorKind.TooLarge, (await streamedClient.GetAsync<JsonElement>("movie")).Error!.Kind);
    }

    [Theory]
    [InlineData("", 200)]
    [InlineData("not json", 200)]
    [InlineData("[1,2]", 201)]
    public async Task AWriteTheArrAcceptedIsMaybeSentEvenWhenItsReplyCantBeRead(string body, int status)
    {
        // The arr committed the change; a reply JE can't use must not make it look like nothing happened.
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response(body, status)));
        var result = await Client(transport).SendAsync<Dictionary<string, int>>(HttpMethod.Delete, "queue/42", null);
        Assert.True(result.Error!.Accepted);
        Assert.True(result.Error.MaybeSent);
        Assert.Equal(status, result.Error.HttpStatus);

        var big = "{\"x\":\"" + new string('x', 4096) + "\"}";
        using var tooBig = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response(big, 200)));
        var capped = Client(tooBig);
        capped.BudgetOverride = _ => (TimeSpan.FromSeconds(30), 1024);
        var large = await capped.SendAsync<JsonElement>(HttpMethod.Post, "command", new { name = "MoviesSearch" });
        Assert.Equal(ArrErrorKind.TooLarge, large.Error!.Kind);
        Assert.True(large.Error.MaybeSent);

        // A proxy's login page answered instead of the arr: not accepted.
        using var html = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response("<html></html>", 200, "text/html")));
        var proxied = await Client(html).SendAsync<JsonElement>(HttpMethod.Post, "command", new { name = "MoviesSearch" });
        Assert.False(proxied.Error!.Accepted);
        Assert.False(proxied.Error.MaybeSent);
    }

    [Fact]
    public async Task GetsBackOffAndRetryOnTransientStatusesHonouringRetryAfter()
    {
        var replies = new Queue<HttpResponseMessage>();
        var limited = IntegrationTransport.Response("", 429);
        limited.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(TimeSpan.FromSeconds(3));
        replies.Enqueue(limited);
        replies.Enqueue(IntegrationTransport.Response("", 503));
        replies.Enqueue(IntegrationTransport.Response("[1,2]"));
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(replies.Dequeue()));
        var delays = new List<TimeSpan>();
        var result = await Client(transport, delays: delays).GetAsync<int[]>("tag");
        Assert.True(result.Ok);
        Assert.Equal([1, 2], result.Value!);
        Assert.Equal(3, transport.Calls);
        Assert.Equal(TimeSpan.FromSeconds(3), delays[0]);
        Assert.Equal(2, delays.Count);
    }

    [Fact]
    public async Task WritesAreNeverRetried()
    {
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response("", 503)));
        var result = await Client(transport).SendAsync<JsonElement>(HttpMethod.Post, "command", new { name = "MoviesSearch", movieIds = new[] { 1 } });
        Assert.Equal(ArrErrorKind.Server, result.Error!.Kind);
        Assert.Equal(1, transport.Calls);
    }

    [Fact]
    public async Task WriteBodiesAreCamelCaseJson()
    {
        string? body = null;
        using var transport = new IntegrationTransport(async (request, _) =>
        {
            body = await request.Content!.ReadAsStringAsync();
            Assert.Equal("application/json", request.Content.Headers.ContentType!.MediaType);
            return IntegrationTransport.Response("{\"id\":5}", 201);
        });
        var result = await Client(transport).SendAsync<JsonElement>(HttpMethod.Post, "command", new { Name = "MoviesSearch", MovieIds = new[] { 7 } });
        Assert.True(result.Ok);
        Assert.Equal("""{"name":"MoviesSearch","movieIds":[7]}""", body);
    }

    [Fact]
    public async Task OwnTimeoutIsAnErrorButCallerCancellationThrows()
    {
        using var slow = new IntegrationTransport(async (_, ct) => { await Task.Delay(Timeout.Infinite, ct); return IntegrationTransport.Response(); });
        var client = Client(slow);
        client.BudgetOverride = _ => (TimeSpan.FromMilliseconds(50), 1024 * 1024);
        var timedOut = await client.SendAsync<JsonElement>(HttpMethod.Post, "command", new { name = "x" });
        Assert.Equal(ArrErrorKind.Timeout, timedOut.Error!.Kind);
        Assert.True(timedOut.Error.MaybeSent);

        using var cts = new CancellationTokenSource(50);
        var caller = Client(slow);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => caller.GetAsync<JsonElement>("movie", cancellationToken: cts.Token));
    }

    /// <summary>A transport whose calls wait until released, counting how many are in flight at once.</summary>
    private sealed class Gate : IDisposable
    {
        private readonly object _lock = new();
        private readonly List<TaskCompletionSource> _waiting = new();
        public int InFlight;
        public int Peak;
        public int Started;
        public IntegrationTransport Transport { get; }

        public Gate()
        {
            Transport = new IntegrationTransport(async (_, ct) =>
            {
                var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                lock (_lock)
                {
                    _waiting.Add(release);
                    Started++;
                    InFlight++;
                    Peak = Math.Max(Peak, InFlight);
                }
                try
                {
                    await release.Task.WaitAsync(ct);
                    return IntegrationTransport.Response("[]");
                }
                finally
                {
                    lock (_lock)
                    {
                        InFlight--;
                        _waiting.Remove(release);
                    }
                }
            });
        }

        public void ReleaseOne()
        {
            lock (_lock) _waiting[0].TrySetResult();
        }

        public void ReleaseAll()
        {
            lock (_lock) foreach (var w in _waiting.ToList()) w.TrySetResult();
        }

        public async Task UntilStarted(int count)
        {
            for (var i = 0; i < 500 && Volatile.Read(ref Started) < count; i++) await Task.Delay(10);
            Assert.Equal(count, Volatile.Read(ref Started));
        }

        public void Dispose() => Transport.Dispose();
    }

    [Fact]
    public async Task TheFifthCallWaitsForAPermitAndNoMoreThanFourRunAtOnce()
    {
        using var gate = new Gate();
        var client = Client(gate.Transport);
        var calls = Enumerable.Range(0, ArrClient.MaxConcurrency + 1).Select(_ => client.GetAsync<JsonElement>("movie")).ToList();
        await gate.UntilStarted(ArrClient.MaxConcurrency);
        await Task.Delay(100);
        Assert.Equal(ArrClient.MaxConcurrency, gate.Started);        // the fifth is waiting for a permit
        gate.ReleaseOne();
        await gate.UntilStarted(ArrClient.MaxConcurrency + 1);       // ... and goes as soon as one frees
        gate.ReleaseAll();
        Assert.All(await Task.WhenAll(calls), r => Assert.True(r.Ok));
        Assert.Equal(4, gate.Peak);
    }

    [Fact]
    public async Task ACancelledWaiterDoesNotShrinkTheCapacity()
    {
        using var gate = new Gate();
        var client = Client(gate.Transport);
        var first = Enumerable.Range(0, 4).Select(_ => client.GetAsync<JsonElement>("movie")).ToList();
        await gate.UntilStarted(4);
        using (var cts = new CancellationTokenSource())
        {
            var waiter = client.GetAsync<JsonElement>("movie", cancellationToken: cts.Token);
            await Task.Delay(50);
            cts.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => waiter);
        }
        gate.ReleaseAll();
        await Task.WhenAll(first);
        // All four permits are back: four new calls run at once.
        var second = Enumerable.Range(0, 4).Select(_ => client.GetAsync<JsonElement>("movie")).ToList();
        await gate.UntilStarted(8);
        Assert.Equal(4, gate.InFlight);
        gate.ReleaseAll();
        Assert.All(await Task.WhenAll(second), r => Assert.True(r.Ok));
        Assert.Equal(4, gate.Peak);
    }

    [Fact]
    public async Task CancellingACallInFlightFreesItsPermit()
    {
        using var gate = new Gate();
        var client = Client(gate.Transport);
        using var cts = new CancellationTokenSource();
        var cancelled = client.GetAsync<JsonElement>("movie", cancellationToken: cts.Token);
        var others = Enumerable.Range(0, 3).Select(_ => client.GetAsync<JsonElement>("movie")).ToList();
        await gate.UntilStarted(4);
        var waiting = client.GetAsync<JsonElement>("movie");
        await Task.Delay(50);
        Assert.Equal(4, gate.Started);
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => cancelled);
        await gate.UntilStarted(5);                                  // the waiting call took the freed permit
        gate.ReleaseAll();
        Assert.True((await waiting).Ok);
        await Task.WhenAll(others);
        Assert.Equal(4, gate.Peak);
    }

    [Fact]
    public void TheFactoryKeepsOneClientPerInstanceUntilItsKeyOrUrlChanges()
    {
        using var arr = new FakeArr();
        arr.Configure(("Movies", ArrKind.Radarr, "http://radarr.lan:7878", "RADARR-KEY-0123456789"));
        var id = arr.Instance("Movies").Id;
        var first = arr.Factory.For(id).Value!;
        Assert.Same(first, arr.Factory.For(id).Value);               // one gate per instance, shared by every caller
        // The same instance (same id) at another address gets a fresh client (and status cache).
        var config = arr.Plugin.Plugin.Configuration;
        var rows = System.Text.Json.Nodes.JsonNode.Parse(config.RadarrInstances)!.AsArray();
        rows[0]!["Url"] = "http://radarr2.lan:7878";
        config.RadarrInstances = rows.ToJsonString();
        Assert.Equal(id, arr.Instance("Movies").Id);
        var second = arr.Factory.For(id).Value!;
        Assert.NotSame(first, second);
        Assert.Same(second, arr.Factory.For(id).Value);
    }

    [Fact]
    public async Task PagedListsFollowTotalRecordsWithAnExplicitPageSize()
    {
        var pages = new List<string>();
        using var transport = new IntegrationTransport((request, _) =>
        {
            var query = System.Web.HttpUtility.ParseQueryString(request.RequestUri!.Query);
            pages.Add(query["page"] + "/" + query["pageSize"] + "/" + query["includeMovie"]);
            var page = int.Parse(query["page"]!);
            var records = Enumerable.Range((page - 1) * 2 + 1, 2).Where(i => i <= 5).Select(i => new { id = i });
            return Task.FromResult(IntegrationTransport.Response(JsonSerializer.Serialize(new { page, pageSize = 2, totalRecords = 5, records })));
        });
        var client = Client(transport);
        var all = await client.GetAllPagesAsync<JsonElement>("queue", [new("includeMovie", "true")], pageSize: 2);
        Assert.Equal([1, 2, 3, 4, 5], all.Value!.Records.Select(r => r.GetProperty("id").GetInt32()));
        Assert.False(all.Value.Truncated);
        Assert.Equal(["1/2/true", "2/2/true", "3/2/true"], pages);

        var capped = await client.GetAllPagesAsync<JsonElement>("queue", pageSize: 2, maxRecords: 3);
        Assert.Equal(3, capped.Value!.Records.Count);
        Assert.True(capped.Value.Truncated);
        Assert.Equal(5, capped.Value.TotalRecords);
    }

    [Fact]
    public async Task PagedListsCountedByIdStopOnARepeatedPageAndReportAShortRead()
    {
        // Five rows, two per page; between pages the list reorders so page 2 repeats a row of page 1,
        // and a page past the end is answered with an earlier page (as the arrs do).
        var calls = 0;
        using var transport = new IntegrationTransport((request, _) =>
        {
            calls++;
            var page = int.Parse(System.Web.HttpUtility.ParseQueryString(request.RequestUri!.Query)["page"]!);
            int[] ids = page switch { 1 => [1, 2], 2 => [2, 3], 3 => [4, 5], _ => [4, 5] };
            return Task.FromResult(IntegrationTransport.Response(JsonSerializer.Serialize(new { page, pageSize = 2, totalRecords = 5, records = ids.Select(i => new { id = i }) })));
        });
        var client = Client(transport);

        var raw = await client.GetAllPagesAsync<JsonElement>("queue", pageSize: 2);
        Assert.Equal(6, raw.Value!.Records.Count);       // raw rows reach the total with a repeat...
        Assert.False(raw.Value.Short);                   // ...and without ids nothing can tell

        calls = 0;
        var byId = await client.GetAllPagesAsync<JsonElement>("queue", pageSize: 2, idOf: r => r.GetProperty("id").GetInt32());
        Assert.Equal([1, 2, 3, 4, 5], byId.Value!.Records.Select(r => r.GetProperty("id").GetInt32()));
        Assert.False(byId.Value.Short);
        Assert.Equal(3, calls);

        // Row 5 is never served: page 4 repeats page 3, so paging stops there, short of the total.
        using var shortTransport = new IntegrationTransport((request, _) =>
        {
            var page = int.Parse(System.Web.HttpUtility.ParseQueryString(request.RequestUri!.Query)["page"]!);
            int[] ids = page switch { 1 => [1, 2], 2 => [2, 3], _ => [3, 4] };
            return Task.FromResult(IntegrationTransport.Response(JsonSerializer.Serialize(new { page, pageSize = 2, totalRecords = 5, records = ids.Select(i => new { id = i }) })));
        });
        var shortRead = await Client(shortTransport).GetAllPagesAsync<JsonElement>("queue", pageSize: 2, idOf: r => r.GetProperty("id").GetInt32());
        Assert.Equal([1, 2, 3, 4], shortRead.Value!.Records.Select(r => r.GetProperty("id").GetInt32()));
        Assert.True(shortRead.Value.Short);
        Assert.False(shortRead.Value.Truncated);
    }

    /// <summary>Distinct rows exceeding a reported total are complete and retain the page count.</summary>
    [Fact]
    public async Task PagedListsWithMoreDistinctRowsThanTheReportedTotalAreNotShort()
    {
        using var transport = new IntegrationTransport((request, _) =>
        {
            var page = int.Parse(System.Web.HttpUtility.ParseQueryString(request.RequestUri!.Query)["page"]!);
            int[] ids = page switch { 1 => [1, 2], 2 => [3, 4], _ => [5, 6] };
            return Task.FromResult(IntegrationTransport.Response(JsonSerializer.Serialize(new { page, pageSize = 2, totalRecords = 5, records = ids.Select(i => new { id = i }) })));
        });

        var read = await Client(transport).GetAllPagesAsync<JsonElement>("queue", pageSize: 2, idOf: r => r.GetProperty("id").GetInt32());

        Assert.Null(read.Error);
        Assert.Equal([1, 2, 3, 4, 5, 6], read.Value!.Records.Select(r => r.GetProperty("id").GetInt32()));
        Assert.Equal(5, read.Value.TotalRecords);
        Assert.False(read.Value.Short);
        Assert.False(read.Value.Truncated);
        Assert.Equal(3, read.Value.Pages);
    }

    [Fact]
    public async Task UrlBaseAndAbsolutePathsAreBuiltFromTheInstanceUrl()
    {
        var seen = new List<string>();
        using var transport = new IntegrationTransport((request, _) => { seen.Add(request.RequestUri!.AbsoluteUri); return Task.FromResult(IntegrationTransport.Response("{}")); });
        var client = Client(transport, url: "http://host.lan:7878/radarr/");
        await client.GetAsync<JsonElement>("movie", [new("tmdbId", "603"), new("term", "a b&c")]);
        await client.GetAsync<JsonElement>("/ping");
        Assert.Equal(["http://host.lan:7878/radarr/api/v3/movie?tmdbId=603&term=a%20b%26c", "http://host.lan:7878/radarr/ping"], seen);
    }

    [Fact]
    public async Task MissingKeyOrBlockedUrlNeverCallsOut()
    {
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response()));
        var noKey = new ArrClient(new ArrConnection { Kind = ArrKind.Radarr, Url = "http://radarr.lan" }, "", () => new HttpClient(transport, false));
        Assert.Equal(ArrErrorKind.NotConfigured, (await noKey.GetAsync<JsonElement>("movie")).Error!.Kind);
        Assert.Equal(ArrErrorKind.BlockedUrl, (await Client(transport, url: "http://169.254.169.254").GetAsync<JsonElement>("movie")).Error!.Kind);
        Assert.Equal(ArrErrorKind.BlockedUrl, (await Client(transport, url: "file:///etc/passwd").GetAsync<JsonElement>("movie")).Error!.Kind);
        Assert.Equal(0, transport.Calls);
    }

    [Fact]
    public void TheConnectGuardRejectsBlockedAddressesForAnyHostName()
    {
        Assert.False(ArrUrlGuard.AreAddressesAllowed("radarr.lan", [IPAddress.Parse("169.254.169.254")]));
        Assert.False(ArrUrlGuard.AreAddressesAllowed("radarr.lan", [IPAddress.Parse("10.0.0.5"), IPAddress.Parse("::ffff:169.254.169.254")]));
        Assert.False(ArrUrlGuard.AreAddressesAllowed("metadata.google.internal", [IPAddress.Parse("10.0.0.5")]));
        Assert.False(ArrUrlGuard.AreAddressesAllowed("radarr.lan", []));
        Assert.True(ArrUrlGuard.AreAddressesAllowed("radarr.lan", [IPAddress.Parse("192.168.1.10")]));
        Assert.True(ArrUrlGuard.AreAddressesAllowed("host.docker.internal", [IPAddress.Parse("169.254.1.2")]));
        Assert.True(ArrUrlGuard.PassesStaticChecks("http://radarr.lan:7878"));
        Assert.False(ArrUrlGuard.PassesStaticChecks("http://169.254.169.254/latest"));
    }

    [Theory]
    [InlineData("fe80::1")]                    // IPv6 link-local
    [InlineData("fe80::1%2")]                  // scoped, as a resolver returns it
    [InlineData("febf:ffff::1")]               // top of fe80::/10
    [InlineData("64:ff9b::a9fe:a9fe")]         // NAT64 form of 169.254.169.254
    [InlineData("64:ff9b::a9fe:102")]          // NAT64 form of 169.254.1.2 (link-local)
    [InlineData("::a9fe:a9fe")]                // IPv4-compatible form of 169.254.169.254
    public void IPv6LinkLocalAndEmbeddedMetadataAddressesAreBlocked(string address)
    {
        var ip = IPAddress.Parse(address);
        Assert.False(ArrUrlGuard.AreAddressesAllowed("radarr.lan", [ip]));
        Assert.False(ArrUrlGuard.AreAddressesAllowed("radarr.lan", [IPAddress.Parse("192.168.1.10"), ip]));
        if (!address.Contains('%')) Assert.False(ArrUrlGuard.PassesStaticChecks($"http://[{address}]:7878"));
    }

    [Theory]
    [InlineData("::1")]
    [InlineData("fd12:3456::10")]
    [InlineData("2001:db8::7")]
    [InlineData("64:ff9b::c0a8:10a")]          // NAT64 form of 192.168.1.10
    public void OrdinaryIPv6AddressesStayAllowed(string address)
    {
        Assert.True(ArrUrlGuard.AreAddressesAllowed("radarr.lan", [IPAddress.Parse(address)]));
        Assert.True(ArrUrlGuard.PassesStaticChecks($"http://[{address}]:7878"));
    }

    [Fact]
    public async Task ARefusedConnectionIsUnreachableThroughTheRealTransport()
    {
        // A port that was just free on loopback: nothing listens, so the connect fails (not sent).
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        using var handler = ArrHttp.CreateHandler();
        var client = new ArrClient(new ArrConnection { Kind = ArrKind.Radarr, Url = $"http://127.0.0.1:{port}" }, Key,
            () => new HttpClient(handler, false) { Timeout = Timeout.InfiniteTimeSpan }, (_, _) => Task.CompletedTask);
        var result = await client.GetSystemStatusAsync();
        Assert.Equal(ArrErrorKind.Unreachable, result.Error!.Kind);
        Assert.False(result.Error.MaybeSent);
    }

    [Fact]
    public async Task TheRealTransportTalksToALocalServerAndSendsTheKeyAsAHeaderOnly()
    {
        var listener = new HttpListener();
        var port = FreePort();
        listener.Prefixes.Add($"http://127.0.0.1:{port}/");
        listener.Start();
        string? seenKey = null, seenUrl = null;
        var serve = Task.Run(async () =>
        {
            var ctx = await listener.GetContextAsync();
            seenKey = ctx.Request.Headers["X-Api-Key"];
            seenUrl = ctx.Request.RawUrl;
            var bytes = Encoding.UTF8.GetBytes(Status("Radarr", "6.0.4.10291"));
            ctx.Response.ContentType = "application/json";
            await ctx.Response.OutputStream.WriteAsync(bytes);
            ctx.Response.Close();
        });
        using var handler = ArrHttp.CreateHandler();
        var client = new ArrClient(new ArrConnection { Kind = ArrKind.Radarr, Url = $"http://127.0.0.1:{port}" }, Key,
            () => new HttpClient(handler, false) { Timeout = Timeout.InfiniteTimeSpan });
        var result = await client.GetSystemStatusAsync();
        await serve;
        listener.Stop();
        Assert.True(result.Ok, result.Error?.ToString());
        Assert.Equal("6.0.4.10291", result.Value.Status.Version);
        Assert.Equal(Key, seenKey);
        Assert.Equal("/api/v3/system/status", seenUrl);
    }

    [Fact]
    public async Task TheRealTransportDoesNotFollowARedirectSoTheKeyStaysWithTheConfiguredHost()
    {
        var listener = new HttpListener();
        var port = FreePort();
        listener.Prefixes.Add($"http://127.0.0.1:{port}/");
        listener.Start();
        var served = new List<string?>();
        var serve = Task.Run(async () =>
        {
            var ctx = await listener.GetContextAsync();
            lock (served) served.Add(ctx.Request.RawUrl);
            ctx.Response.StatusCode = 302;
            ctx.Response.RedirectLocation = $"http://127.0.0.1:{port}/elsewhere";
            ctx.Response.Close();
        });
        using var handler = ArrHttp.CreateHandler();
        var client = new ArrClient(new ArrConnection { Kind = ArrKind.Radarr, Url = $"http://127.0.0.1:{port}" }, Key,
            () => new HttpClient(handler, false) { Timeout = Timeout.InfiniteTimeSpan });
        var result = await client.GetAsync<JsonElement>("movie");
        await serve;
        await Task.Delay(200);
        listener.Stop();
        Assert.Equal(ArrErrorKind.Redirect, result.Error!.Kind);
        Assert.Equal(302, result.Error.HttpStatus);
        Assert.Equal(["/api/v3/movie"], served);
    }

    private static int FreePort()
    {
        var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        var port = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }
}
