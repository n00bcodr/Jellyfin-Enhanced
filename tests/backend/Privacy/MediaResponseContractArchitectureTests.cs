using System.Reflection;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Controllers;

namespace JE.Tests;

public class MediaResponseContractArchitectureTests
{
    internal static ControllerActionDescriptor Descriptor(JellyfinApiAssembly.Action action) => new()
    {
        ControllerName = action.Controller.Name[..^"Controller".Length], ActionName = action.Method.Name,
        ControllerTypeInfo = action.Controller.GetTypeInfo(), MethodInfo = action.Method,
    };

    // Reflection permits the same tests to execute against the original production DLL: a missing contract means
    // every route is owned, so the streaming regressions fail assertions rather than failing to compile/load.
    internal static bool Streams(ActionDescriptor descriptor) => (bool?)typeof(PrivacyResponseGuard).Assembly
        .GetType("Jellyfin.Plugin.JellyfinEnhanced.Services.MediaResponseContract")?
        .GetMethod("Streams", BindingFlags.Static | BindingFlags.NonPublic)?.Invoke(null, [descriptor]) ?? false;

    private static bool Download(ActionDescriptor descriptor) => (bool?)typeof(PrivacyResponseGuard).Assembly
        .GetType("Jellyfin.Plugin.JellyfinEnhanced.Services.MediaResponseContract")?
        .GetMethod("Download", BindingFlags.Static | BindingFlags.NonPublic)?.Invoke(null, [descriptor]) ?? false;

    private static bool HostDownloadContract(JellyfinApiAssembly.Action action) => action.Method.GetCustomAttributesData().Any(a => a.AttributeType.Name == "ProducesFileAttribute"
            && a.ConstructorArguments.SelectMany(x => x.Value as IEnumerable<CustomAttributeTypedArgument> ?? [])
                .Select(x => x.Value?.ToString()).Order().SequenceEqual(new[] { "audio/*", "video/*" }));

    private static bool HostMediaContract(JellyfinApiAssembly.Action action)
    {
        // Independent oracle: the host's own response annotations, not names containing Stream or a MIME guess.
        // Trickplay's image manifests and all images remain protected. Only playback controllers participate.
        if (action.Controller.Name is not ("AudioController" or "VideosController" or "UniversalAudioController"
            or "DynamicHlsController" or "HlsSegmentController" or "LiveTvController" or "SubtitleController")) return false;
        var attributes = action.Method.GetCustomAttributesData().Select(a => a.AttributeType.Name).ToArray();
        // The generated master embeds subtitle DisplayTitle, unlike segment-timing manifests. Its host-generator
        // witness is in PrivacyGeneratedPlaylistTests; playlist annotations alone cannot establish safe transport.
        if (action.Method.Name is "GetMasterHlsVideoPlaylist" or "GetMasterHlsAudioPlaylist") return false;
        return attributes.Any(a => a is "ProducesAudioFileAttribute" or "ProducesVideoFileAttribute" or "ProducesPlaylistFileAttribute")
            || action.Controller.Name == "SubtitleController" && attributes.Contains("ProducesFileAttribute")
                && action.Method.GetParameters().Any(p => p.Name is "routeItemId" or "subtitleId");
    }

    internal static string[] Scan(IEnumerable<JellyfinApiAssembly.Action> actions, Func<ActionDescriptor, bool> streams,
        Func<ActionDescriptor, bool>? downloads = null)
        => actions.Select(a => (Action: a, Descriptor: Descriptor(a)))
            .Where(x => streams(x.Descriptor) != HostMediaContract(x.Action) || (downloads ?? Download)(x.Descriptor) != HostDownloadContract(x.Action)
                || streams(x.Descriptor) && (PrivacyResponseGuard.Owns(x.Descriptor) || x.Action.Verbs.Any(v => v is not ("GET" or "HEAD"))))
            .Select(x => x.Action.Name).Order().ToArray();

    [Fact]
    public void EveryPinnedHostMediaContractStreamsAndEveryOtherRouteRetainsItsOwner()
    {
        using var host = JellyfinApiAssembly.Load();
        Assert.Empty(Scan(host.Actions(), Streams));
        Assert.Equal(19, host.Actions().Count(HostMediaContract));
        Assert.Equal(2, host.Actions().Count(HostDownloadContract));
    }

    [Theory]
    [InlineData("Videos", "GetVideoStream", false)]
    [InlineData("Videos", "GetAdditionalPart", true)]
    [InlineData("DynamicHls", "GetMasterHlsVideoPlaylist", true)]
    [InlineData("DynamicHls", "GetMasterHlsAudioPlaylist", true)]
    public void ScanRejectsPlantedMediaAndMetadataMisclassifications(string controller, string name, bool planted)
    {
        using var host = JellyfinApiAssembly.Load();
        var action = host.Actions().Single(a => a.Controller.Name == controller + "Controller" && a.Method.Name == name);
        var findings = Scan([action], d => d is ControllerActionDescriptor a && a.ControllerName == controller && a.ActionName == name ? planted : Streams(d));
        Assert.Equal([action.Name], findings);
    }

    [Theory]
    [InlineData("GetDownload")]
    [InlineData("GetFile")]
    public void ScanRejectsPlantedRawFileResponsesMislabelledAsAlwaysOwned(string name)
    {
        using var host = JellyfinApiAssembly.Load();
        var action = host.Actions().Single(a => a.Controller.Name == "LibraryController" && a.Method.Name == name);
        Assert.Equal([action.Name], Scan([action], Streams, _ => false));
    }

    [Fact]
    public void RouteStringsAndOtherAssembliesCannotClaimTheHostMediaException()
    {
        Assert.False(Streams(new ActionDescriptor { RouteValues = new Dictionary<string, string?> { ["controller"] = "Videos", ["action"] = "GetVideoStream" } }));
        Assert.False(Streams(new ControllerActionDescriptor
        {
            ControllerName = "Videos", ActionName = "GetVideoStream", ControllerTypeInfo = GetType().GetTypeInfo(),
            MethodInfo = GetType().GetMethod(nameof(RouteStringsAndOtherAssembliesCannotClaimTheHostMediaException))!,
        }));
    }
}
