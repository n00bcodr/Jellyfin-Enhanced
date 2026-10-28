#pragma warning disable ASPDEPR004, ASPDEPR008
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.AspNetCore.TestHost;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class PrivacyMediaStreamingTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AuthenticatedFileStreamDeliversItsFirstBlockBeforeItsProducerCompletes(bool startExplicitly)
    {
        // Retain the soundness review's non-seekable FileStreamResult producer, including explicit StartAsync.
        // Use the actual pinned controller descriptor for the new contract and replace its delay-based client race
        // with the server's deterministic flush barrier, then read the client's prefix while the producer is held.
        using var host = JellyfinApiAssembly.Load();
        var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var finish = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var startedAtFlush = false;
        using var server = new TestServer(new WebHostBuilder()
            .ConfigureServices(services => { services.AddLogging(); services.AddControllers(); })
            .Configure(app => app.Run(async http =>
            {
                http.User = TestCallers.Principal(Guid.NewGuid(), false);
                var action = Action(http, host, "Audio", "GetAudioStream");
                Assert.False(PrivacyResponseGuard.Owns(action.ActionDescriptor));
                var owner = new PrivacyCommitFilter();
                await owner.OnResourceExecutionAsync(new ResourceExecutingContext(action, [], []), async () =>
                {
                    var result = new FileStreamResult(new ProducerStream(async () =>
                    {
                        if (startExplicitly) await http.Response.StartAsync();
                    }, async () =>
                    {
                        await http.Response.Body.FlushAsync();
                        startedAtFlush = http.Response.HasStarted;
                        ready.TrySetResult();
                        await finish.Task.WaitAsync(TimeSpan.FromSeconds(10));
                    }), "audio/mpeg");
                    var delivery = new ResultExecutingContext(action, [], result, new object());
                    owner.OnResultExecuting(delivery);
                    await delivery.Result.ExecuteResultAsync(action);
                    return new ResourceExecutedContext(action, []);
                });
            })));
        using var client = server.CreateClient();
        var receive = client.GetAsync("/Audio/fixture/stream", HttpCompletionOption.ResponseHeadersRead);
        byte[]? early = null;
        try
        {
            await ready.Task.WaitAsync(TimeSpan.FromSeconds(10));
            if (startedAtFlush)
            {
                var headers = await receive.WaitAsync(TimeSpan.FromSeconds(10));
                var stream = await headers.Content.ReadAsStreamAsync();
                early = new byte[4];
                await stream.ReadExactlyAsync(early.AsMemory()).AsTask().WaitAsync(TimeSpan.FromSeconds(10));
                Assert.False(finish.Task.IsCompleted);
            }
        }
        finally { finish.TrySetResult(); }
        using var response = await receive.WaitAsync(TimeSpan.FromSeconds(10));
        var rest = await response.Content.ReadAsByteArrayAsync();
        Assert.Equal(new byte[] { 1, 2, 3, 4 }, (early ?? []).Concat(rest).ToArray());
        Assert.Equal(200, (int)response.StatusCode);
        Assert.True(startedAtFlush, "The authenticated media transport did not start at its flushed first block.");
        Assert.NotNull(early);
    }

    private static ActionContext Action(HttpContext http, JellyfinApiAssembly host, string controller, string method)
        => new(http, new(), MediaResponseContractArchitectureTests.Descriptor(host.Actions().Single(a => a.Controller.Name == controller + "Controller" && a.Method.Name == method)));

    private static async Task Run(ActionContext action, ApiPluginFixture fixture, bool collage, Func<Task> write)
    {
        var resource = new ResourceExecutingContext(action, [], []);
        var markers = LegacyCollageWithhold.MarkerDirectories(Path.Combine(fixture.Core.Root, "stream-markers"));
        foreach (var directory in markers) Directory.CreateDirectory(directory);
        var projection = new LegacyCollageBody(new LegacyCollageWithhold(markers, Mock.Of<ILibraryManager>()), fixture.Core.Logger);
        await new PrivacyCommitFilter().OnResourceExecutionAsync(resource, async () =>
        {
            async Task<ResourceExecutedContext> Result() { await write(); return new ResourceExecutedContext(action, []); }
            if (!collage) return await Result();
            ResourceExecutedContext? executed = null;
            await projection.OnResourceExecutionAsync(resource, async () => executed = await Result());
            return executed!;
        });
    }

    [Theory]
    [InlineData("Videos", "GetVideoStream", "video/mp4", false)]
    [InlineData("Audio", "GetAudioStream", "audio/mpeg", false)]
    [InlineData("Videos", "GetVideoStream", "video/mp4", true)]
    [InlineData("Audio", "GetAudioStream", "audio/mpeg", true)]
    public async Task FlushedFirstBytesReachTransportWhileTheResultIsStillOpen(string controller, string method, string type, bool collage)
    {
        using var fixture = new ApiPluginFixture(); using var host = JellyfinApiAssembly.Load();
        using var transport = new CountingTransport(); var http = new DefaultHttpContext(); http.Response.Body = transport;
        var action = Action(http, host, controller, method);
        var flushed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var finish = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var pending = Run(action, fixture, collage, async () =>
        {
            // The executor chooses its type after resource entry. The route contract was already decided.
            http.Response.ContentType = type;
            await http.Response.Body.WriteAsync(new byte[] { 1, 2, 3, 4 });
            await http.Response.Body.FlushAsync(); flushed.SetResult();
            await finish.Task;
        });
        var reached = await Task.WhenAny(flushed.Task, pending).WaitAsync(TimeSpan.FromSeconds(10));
        if (reached == pending) await pending;
        await flushed.Task;
        var prefix = transport.Bytes; var flushes = transport.Flushes; var completed = pending.IsCompleted;
        finish.SetResult(); await pending;
        Assert.False(completed); Assert.Equal(4, prefix); Assert.True(flushes > 0);
        Assert.Equal(4, transport.Bytes);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task TwoHundredMiBStreamsHaveZeroHeldBytesAndBoundedAllocation(bool collage)
    {
        using var fixture = new ApiPluginFixture(); using var host = JellyfinApiAssembly.Load();
        using var transport = new CountingTransport(); var http = new DefaultHttpContext(); http.Response.Body = transport;
        var block = new byte[1024 * 1024]; long lag = 0, allocated = 0;
        await Run(Action(http, host, "Videos", "GetVideoStream"), fixture, collage, async () =>
        {
            http.Response.ContentType = "video/mp4";
            // The counting transport completes writes synchronously, so unrelated test threads cannot affect this bound.
            var before = GC.GetAllocatedBytesForCurrentThread();
            for (var i = 1; i <= 200; i++)
            {
                await http.Response.Body.WriteAsync(block);
                lag = Math.Max(lag, (long)i * block.Length - transport.Bytes);
            }
            allocated = GC.GetAllocatedBytesForCurrentThread() - before;
        });
        Assert.Equal(200L * block.Length, transport.Bytes);
        Assert.Equal(0, lag); // Measured at every write, including both sides of the former 128 MiB release threshold.
        Assert.True(allocated < 8 * 1024 * 1024, $"Streaming allocated {allocated} bytes for a reused 1 MiB block.");
    }

    [Theory]
    [InlineData("application/json")]
    [InlineData("text/html")]
    [InlineData("video/mp4")]
    public async Task MetadataIncludingAMisleadingBinaryTypeIsWithheldUntilFinalValidation(string type)
    {
        using var fixture = new ApiPluginFixture(); using var host = JellyfinApiAssembly.Load();
        fixture.Plugin.Configuration.HiddenContentEnabled = true;
        using var provider = new ServiceCollection().BuildServiceProvider();
        var viewer = Guid.NewGuid();
        using var transport = new CountingTransport(); var http = new DefaultHttpContext(); http.Request.Method = "GET"; http.Response.Body = transport;
        http.RequestServices = provider;
        await Run(Action(http, host, "Videos", "GetAdditionalPart"), fixture, false, async () =>
        {
            using (var scope = PrivacyReadSet.Begin())
            {
                HiddenContentPolicy.Load(fixture.Core.Manager, viewer);
                PrivacyResponseGuard.Install(http, scope.Reads);
            }
            http.Response.ContentType = type;
            await http.Response.Body.WriteAsync("title-bearing metadata"u8.ToArray()); await http.Response.Body.FlushAsync();
            Assert.Equal(0, transport.Bytes);
            fixture.Core.Manager.SaveUserConfiguration(viewer.ToString("N"), "hidden-content.json", new UserHiddenContent
            {
                Settings = new() { FilterDiscovery = true }, Items = new() { ["movie:tmdb:42"] = new() { Type = "Movie", TmdbId = "42" } },
            });
        });
        Assert.Equal(503, http.Response.StatusCode); Assert.Equal(0, transport.Bytes);
    }

    [Fact]
    public async Task AnExistingPrivacyClassificationOverridesTheMediaException()
    {
        using var fixture = new ApiPluginFixture(); using var host = JellyfinApiAssembly.Load();
        using var transport = new CountingTransport(); var http = new DefaultHttpContext(); http.Response.Body = transport;
        using var scope = PrivacyReadSet.Begin();
        var guard = PrivacyResponseGuard.Install(http, scope.Reads)!;
        await Run(Action(http, host, "Videos", "GetVideoStream"), fixture, true, async () =>
        {
            http.Response.ContentType = "video/mp4";
            await http.Response.Body.WriteAsync(new byte[16]); await http.Response.Body.FlushAsync();
            Assert.Equal(0, transport.Bytes); Assert.False(guard.Committed);
        });
        Assert.True(guard.Committed); Assert.Equal(16, transport.Bytes);
    }

    [Theory]
    [InlineData("stream")]
    [InlineData("file")]
    [InlineData("range")]
    [InlineData("pipe")]
    public async Task HostMediaExecutorsKeepTheirLengthRangeAndWriteContracts(string executor)
    {
        using var fixture = new ApiPluginFixture(); using var host = JellyfinApiAssembly.Load();
        var services = new ServiceCollection(); services.AddLogging(); services.AddControllers();
        using var provider = services.BuildServiceProvider();
        using var transport = new CountingTransport(); var http = new DefaultHttpContext(); http.Request.Method = "GET";
        http.RequestServices = provider; http.Response.Body = transport;
        var action = Action(http, host, "Videos", "GetVideoStream");
        await Run(action, fixture, true, async () =>
        {
            if (executor == "pipe")
            {
                http.Response.ContentType = "video/mp4";
                await http.Response.BodyWriter.WriteAsync(new byte[16]); await http.Response.BodyWriter.FlushAsync();
            }
            else
            {
                var path = Path.Combine(fixture.Core.Root, "owned-media.mp4"); await File.WriteAllBytesAsync(path, new byte[16]);
                if (executor == "range") http.Request.Headers.Range = "bytes=4-7";
                IActionResult result = executor == "stream" ? new FileStreamResult(File.OpenRead(path), "video/mp4")
                    : new PhysicalFileResult(path, "video/mp4") { EnableRangeProcessing = true };
                await result.ExecuteResultAsync(action);
            }
            Assert.Equal(executor == "range" ? 4 : 16, transport.Bytes);
        });
        Assert.Equal(executor == "range" ? 206 : 200, http.Response.StatusCode);
        if (executor == "range") Assert.Equal("bytes 4-7/16", http.Response.Headers.ContentRange.ToString());
    }

    private sealed class ProducerStream(Func<Task> begin, Func<Task> wait) : Stream
    {
        private int _at;
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override int Read(byte[] buffer, int offset, int count) => ReadAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();
        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken ct)
            => ReadAsync(buffer.AsMemory(offset, count), ct).AsTask();
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default)
        {
            if (_at < 4)
            {
                if (_at == 0) await begin();
                var bytes = new byte[] { 1, 2, 3, 4 };
                var count = Math.Min(buffer.Length, 4 - _at);
                bytes.AsMemory(_at, count).CopyTo(buffer);
                _at += count;
                return count;
            }
            await wait();
            return 0;
        }
    }

    private sealed class CountingTransport : Stream
    {
        public long Bytes { get; private set; }
        public int Flushes { get; private set; }
        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => Bytes;
        public override long Position { get => Bytes; set => throw new NotSupportedException(); }
        public override void Flush() => Flushes++;
        public override Task FlushAsync(CancellationToken ct) { Flush(); return Task.CompletedTask; }
        public override void Write(byte[] buffer, int offset, int count) => Bytes += count;
        public override void Write(ReadOnlySpan<byte> buffer) => Bytes += buffer.Length;
        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken ct = default) { Bytes += buffer.Length; return ValueTask.CompletedTask; }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
    }
}
