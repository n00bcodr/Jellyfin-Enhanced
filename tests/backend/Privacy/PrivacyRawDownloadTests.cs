using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.DependencyInjection;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class PrivacyRawDownloadTests
{
    [Theory]
    [InlineData(false, false, "GetDownload")]
    [InlineData(false, true, "GetDownload")]
    [InlineData(true, false, "GetDownload")]
    [InlineData(true, true, "GetDownload")]
    [InlineData(false, false, "GetFile")]
    [InlineData(false, true, "GetFile")]
    [InlineData(true, false, "GetFile")]
    [InlineData(true, true, "GetFile")]
    public async Task NativeRawDownloadExecutorDeliversBytesBeforeResourceCompletionAndRetainsRanges(bool audio, bool range, string method)
        => await Download(audio ? "audio" : "video", range, false, false, true, method);

    [Theory]
    [InlineData("photo", false, false)]
    [InlineData("book", false, false)]
    [InlineData("video", true, false)]
    [InlineData("video", false, true)]
    [InlineData("metadata", false, false)]
    public async Task MixedDownloadsAndInstalledClassificationsKeepTheOuterOwner(string kind, bool classified, bool replaceResult)
        => await Download(kind, false, classified, replaceResult, false);

    private static async Task Download(string kind, bool range, bool classified, bool replaceResult, bool streams, string method = "GetDownload")
    {
        using var fixture = new ApiPluginFixture(); using var runtime = new PrivacyGeneratedPlaylistTests.HostRuntime();
        using var host = JellyfinApiAssembly.Load();
        var path = Path.Combine(fixture.Core.Root, "owned-download" + (kind == "audio" ? ".mp3" : kind == "photo" ? ".jpg" : kind == "book" ? ".epub" : kind == "metadata" ? ".nfo" : ".mp4"));
        await File.WriteAllBytesAsync(path, Enumerable.Range(0, 64).Select(i => (byte)i).ToArray());
        BaseItem item = kind switch { "audio" => new Audio(), "photo" => new Photo(), "book" => new Book(), _ => new Video() };
        item.Id = Guid.NewGuid(); item.Path = path;
        var library = new Mock<ILibraryManager>(); library.Setup(l => l.GetItemById(item.Id)).Returns(item);
        library.Setup(l => l.GetItemById<BaseItem>(item.Id, It.IsAny<Jellyfin.Database.Implementations.Entities.User>())).Returns(item);
        library.Setup(l => l.GetItemById<BaseItem>(item.Id, It.IsAny<Guid>())).Returns(item);
        var sources = new Mock<IMediaSourceManager>();
        sources.Setup(s => s.GetPathProtocol(It.IsAny<string>())).Returns(MediaBrowser.Model.MediaInfo.MediaProtocol.File);
        var previous = BaseItem.MediaSourceManager; BaseItem.MediaSourceManager = sources.Object;
        try
        {
            var services = new ServiceCollection(); services.AddLogging(); services.AddControllers(); services.AddSingleton(library.Object);
            using var provider = services.BuildServiceProvider(); using var transport = new MemoryStream();
            var http = new DefaultHttpContext(); http.Request.Method = "GET"; http.RequestServices = provider; http.Response.Body = transport;
            if (range) http.Request.Headers.Range = "bytes=4-7";
            var action = new ActionContext(http, new(), MediaResponseContractArchitectureTests.Descriptor(host.Actions().Single(a => a.Controller.Name == "LibraryController" && a.Method.Name == method)));
            action.RouteData.Values["itemId"] = item.Id;
            if (classified) { using var read = PrivacyReadSet.Begin(); PrivacyResponseGuard.Install(http, read.Reads); }
            var controllerType = runtime.Api.GetType("Jellyfin.Api.Controllers.LibraryController", true)!;
            var constructor = controllerType.GetConstructors().Single();
            var controller = (ControllerBase)constructor.Invoke(constructor.GetParameters().Select(p => p.Name == "libraryManager" ? library.Object : null).ToArray());
            controller.ControllerContext = new ControllerContext(action);
            var owner = new PrivacyCommitFilter();
            var resource = new ResourceExecutingContext(action, [], []);
            var markers = LegacyCollageWithhold.MarkerDirectories(Path.Combine(fixture.Core.Root, "download-markers"));
            foreach (var directory in markers) Directory.CreateDirectory(directory);
            var projection = new LegacyCollageBody(new LegacyCollageWithhold(markers, library.Object), fixture.Core.Logger);
            await owner.OnResourceExecutionAsync(resource, async () =>
            {
                ResourceExecutedContext? executed = null;
                await projection.OnResourceExecutionAsync(resource, async () =>
                {
                var invocation = controllerType.GetMethod(method)!.Invoke(controller, [item.Id])!;
                if (invocation is Task pending) { await pending; invocation = pending.GetType().GetProperty("Result")!.GetValue(pending)!; }
                var result = Assert.IsType<PhysicalFileResult>(invocation);
                Assert.True(result.EnableRangeProcessing);
                var delivery = new ResultExecutingContext(action, [], result, controller);
                owner.OnResultExecuting(delivery);
                // A later filter can replace the file result: the raw contract must never release this new answer.
                if (replaceResult) delivery.Result = new ContentResult { Content = "title-bearing metadata", ContentType = "video/mp4" };
                await delivery.Result.ExecuteResultAsync(action); await http.Response.Body.FlushAsync();
                Assert.Equal(streams ? range ? 4 : 64 : 0, transport.Length);
                return executed = new ResourceExecutedContext(action, []);
                });
                return executed!;
            });
            Assert.Equal(range ? 206 : 200, http.Response.StatusCode);
            if (range)
            {
                Assert.Equal("bytes 4-7/64", http.Response.Headers.ContentRange.ToString());
                Assert.Equal("bytes", http.Response.Headers.AcceptRanges.ToString());
                Assert.Equal(new byte[] { 4, 5, 6, 7 }, transport.ToArray());
            }
            else Assert.NotEmpty(transport.ToArray());
        }
        finally { BaseItem.MediaSourceManager = previous; }
    }
}
