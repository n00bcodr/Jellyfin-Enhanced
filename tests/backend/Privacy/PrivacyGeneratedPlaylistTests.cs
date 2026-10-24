using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using System.Text;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.DependencyInjection;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class PrivacyGeneratedPlaylistTests
{
    // Execute the pinned host's actual shared master generator, rather than guessing what its annotation means.
    internal sealed class HostRuntime : AssemblyLoadContext, IDisposable
    {
        private readonly string _directory = Path.GetDirectoryName(JellyfinApiAssembly.Pinned(JellyfinApiAssembly.CurrentLine).Path)!;
        internal Assembly Api { get; }
        public HostRuntime() : base(isCollectible: true) => Api = LoadFromAssemblyPath(Path.Combine(_directory, "Jellyfin.Api.dll"));
        protected override Assembly? Load(AssemblyName name)
        {
            var shared = Default.Assemblies.FirstOrDefault(a => a.GetName().Name == name.Name);
            if (shared != null) return shared;
            var path = Path.Combine(_directory, name.Name + ".dll");
            return File.Exists(path) ? LoadFromAssemblyPath(path) : null;
        }
        public void Dispose() => Unload();
        internal byte[] Master(string kind, string title)
        {
            var helper = Api.GetType("Jellyfin.Api.Helpers.DynamicHlsHelper", true)!;
            var append = helper.GetMethod("AddSubtitles", BindingFlags.Instance | BindingFlags.NonPublic)!;
            var state = RuntimeHelpers.GetUninitializedObject(append.GetParameters()[0].ParameterType);
            var request = Activator.CreateInstance(Api.GetType("Jellyfin.Api.Models.StreamingDtos.Hls" + kind + "RequestDto", true)!)!;
            request.GetType().GetProperty("MediaSourceId")!.SetValue(request, "owned-source");
            state.GetType().GetProperty("Request")!.SetValue(state, request);
            var delivery = state.GetType().GetProperty("SubtitleDeliveryMethod")!;
            delivery.SetValue(state, Enum.Parse(delivery.PropertyType, "Hls"));
            var streamType = append.GetParameters()[1].ParameterType.GenericTypeArguments[0];
            var stream = Activator.CreateInstance(streamType)!;
            foreach (var (name, value) in new[] { ("Title", title), ("Language", "eng"), ("Codec", "srt") })
                streamType.GetProperty(name)!.SetValue(stream, value);
            var type = streamType.GetProperty("Type")!; type.SetValue(stream, Enum.Parse(type.PropertyType, "Subtitle"));
            var streams = Array.CreateInstance(streamType, 1); streams.SetValue(stream, 0);
            var text = new StringBuilder("#EXTM3U\n");
            append.Invoke(RuntimeHelpers.GetUninitializedObject(helper), [state, streams, text, new System.Security.Claims.ClaimsPrincipal()]);
            text.Append("#EXT-X-IMAGE-STREAM-INF:BANDWIDTH=100,RESOLUTION=320x180,CODECS=\"jpeg\",URI=\"trickplay.m3u8\"\n");
            text.Append("#EXT-X-STREAM-INF:BANDWIDTH=1000,SUBTITLES=\"subs\"\nmain.m3u8\n");
            Assert.Contains(title, text.ToString());
            return Encoding.UTF8.GetBytes(text.ToString());
        }
    }

    private sealed class Rig : IDisposable
    {
        internal readonly ApiPluginFixture Fixture = new();
        internal readonly Guid Viewer = Guid.NewGuid();
        internal readonly Movie Item = new() { Id = Guid.NewGuid(), Name = "Owned movie" };
        internal readonly Mock<ILibraryManager> Library = new();
        internal readonly MemoryStream Transport = new();
        internal readonly DefaultHttpContext Http = new();
        internal readonly ServiceProvider Services;
        internal readonly TitlePresentationResultFilter Gate;
        internal readonly SpoilerPresentation Spoilers;
        internal readonly SpoilerFieldStripFilter Strip;
        internal readonly PrivacyCommitFilter Owner = new();
        internal Rig(bool guarded, bool reveal)
        {
            Fixture.Plugin.Configuration.SpoilerBlurEnabled = true;
            Fixture.Plugin.Configuration.SpoilerReplaceTitle = !reveal;
            Fixture.Plugin.Configuration.SpoilerStripOverview = !reveal;
            if (guarded) Guard();
            Library.Setup(l => l.GetItemById(Item.Id)).Returns(Item);
            Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => q.ItemIds.Contains(Item.Id) ? [Item] : []);
            var users = new Mock<IUserManager>();
            users.Setup(u => u.GetUserById(Viewer)).Returns(new Jellyfin.Database.Implementations.Entities.User("viewer", "default", "default") { Id = Viewer });
            var data = Mock.Of<IUserDataManager>();
            var resolver = new SpoilerUserResolver(Fixture.Core.Manager, Library.Object, Fixture.Core.Logger, null!);
            Strip = new SpoilerFieldStripFilter(resolver, Library.Object, users.Object, data,
                new SpoilerNextUnwatchedService(Library.Object, users.Object, data, Fixture.Core.Logger));
            Spoilers = new SpoilerPresentation(Fixture.Core.Manager, Library.Object, users.Object, data);
            Gate = new TitlePresentationResultFilter(Fixture.Core.Manager, Spoilers, Library.Object,
                Mock.Of<MediaBrowser.Controller.IServerApplicationHost>(), Strip);
            var services = new ServiceCollection(); services.AddLogging(); services.AddControllers();
            Services = services.BuildServiceProvider(); Http.RequestServices = Services;
            Http.Request.Method = "GET"; Http.User = TestCallers.Principal(Viewer, false); Http.Response.Body = Transport;
        }
        internal void Guard() => Fixture.Core.Manager.SaveUserConfiguration(Viewer.ToString("N"), "spoilerblur.json",
            new UserSpoilerBlur { Movies = new() { [Item.Id.ToString("N")] = new() } });
        internal ActionContext Action(JellyfinApiAssembly host, string kind)
        {
            var action = new ActionContext(Http, new(), MediaResponseContractArchitectureTests.Descriptor(host.Actions().Single(a => a.Controller.Name == "DynamicHlsController" && a.Method.Name == "GetMasterHls" + kind + "Playlist")));
            action.RouteData.Values["itemId"] = Item.Id;
            return action;
        }
        public void Dispose() { Services.Dispose(); Transport.Dispose(); Fixture.Dispose(); }
    }

    [Theory]
    [InlineData("Video", true, false)]
    [InlineData("Audio", true, false)]
    [InlineData("Video", true, true)]
    [InlineData("Audio", true, true)]
    [InlineData("Video", false, false)]
    [InlineData("Audio", false, false)]
    public async Task GeneratedMasterUsesTheJsonTitleFamilyRuleAndValidatesBeforeFirstByte(string kind, bool guarded, bool reveal)
    {
        using var runtime = new HostRuntime(); using var host = JellyfinApiAssembly.Load(); using var rig = new Rig(guarded, reveal);
        var bytes = runtime.Master(kind, "R9_PRIVATE_TRACK_TITLE");
        var action = rig.Action(host, kind);
        await rig.Owner.OnResourceExecutionAsync(new ResourceExecutingContext(action, [], []), async () =>
        {
            rig.Gate.OnResourceExecuting(new ResourceExecutingContext(action, [], []));
            var delivery = new ResultExecutingContext(action, [], new FileContentResult(bytes, "application/vnd.apple.mpegurl"), new object());
            rig.Owner.OnResultExecuting(delivery); rig.Gate.OnResultExecuting(delivery);
            var projected = Encoding.UTF8.GetString(Assert.IsType<FileContentResult>(delivery.Result).FileContents);
            Assert.Equal(!guarded || reveal, projected.Contains("R9_PRIVATE_TRACK_TITLE"));
            Assert.Equal(!guarded, projected.Contains("#EXT-X-IMAGE-STREAM-INF"));
            await delivery.Result.ExecuteResultAsync(action); await rig.Http.Response.Body.FlushAsync();
            Assert.Equal(0, rig.Transport.Length);
            return new ResourceExecutedContext(action, []);
        });
        Assert.Equal(200, rig.Http.Response.StatusCode);
        var text = Encoding.UTF8.GetString(rig.Transport.ToArray());
        var final = TitlePresentationGate.Read(rig.Fixture.Core.Manager, rig.Spoilers, rig.Viewer, rig.Library.Object);
        var identity = rig.Spoilers.Resolve([rig.Item.Id], rig.Viewer, final.Spoilers)[rig.Item.Id];
        var jsonKeepsTitle = !guarded || rig.Strip.RevealFor(identity, final.Spoilers!.State, rig.Fixture.Plugin.Configuration, rig.Viewer).TitleFamily;
        Assert.Equal(jsonKeepsTitle, text.Contains("R9_PRIVATE_TRACK_TITLE"));
        Assert.Contains("main.m3u8", text); Assert.Contains("TYPE=SUBTITLES", text);
        if (!jsonKeepsTitle) { Assert.Contains("NAME=\"Subtitle 1\"", text); Assert.Contains("LANGUAGE=\"und\"", text); }
    }

    [Theory]
    [InlineData("Video")]
    [InlineData("Audio")]
    public async Task GeneratedMasterWithholdsAnAnswerWhosePolicyChangesAfterItsExecutor(string kind)
    {
        using var runtime = new HostRuntime(); using var host = JellyfinApiAssembly.Load(); using var rig = new Rig(false, false);
        var action = rig.Action(host, kind);
        await rig.Owner.OnResourceExecutionAsync(new ResourceExecutingContext(action, [], []), async () =>
        {
            rig.Gate.OnResourceExecuting(new ResourceExecutingContext(action, [], []));
            var result = new ResultExecutingContext(action, [], new FileContentResult(runtime.Master(kind, "R9_PRIVATE_TRACK_TITLE"), "application/vnd.apple.mpegurl"), new object());
            rig.Gate.OnResultExecuting(result); await result.Result.ExecuteResultAsync(action);
            rig.Guard();
            return new ResourceExecutedContext(action, []);
        });
        Assert.Equal(503, rig.Http.Response.StatusCode); Assert.Empty(rig.Transport.ToArray());
    }

    [Fact]
    public async Task GeneratedMasterRejectsAnUnescapedHostTrackTitle()
    {
        using var runtime = new HostRuntime(); using var host = JellyfinApiAssembly.Load(); using var rig = new Rig(true, false);
        var action = rig.Action(host, "Video");
        await rig.Owner.OnResourceExecutionAsync(new ResourceExecutingContext(action, [], []), async () =>
        {
            var result = new ResultExecutingContext(action, [], new FileContentResult(runtime.Master("Video", "private\"\nINJECTED_TITLE"), "application/vnd.apple.mpegurl"), new object());
            rig.Gate.OnResultExecuting(result); await result.Result.ExecuteResultAsync(action);
            return new ResourceExecutedContext(action, []);
        });
        Assert.Equal(503, rig.Http.Response.StatusCode); Assert.Empty(rig.Transport.ToArray());
    }
}
