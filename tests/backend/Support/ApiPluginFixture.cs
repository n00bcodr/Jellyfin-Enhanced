using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Model.Serialization;
using Moq;
using Plugin = Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced;

namespace JE.Tests;

[CollectionDefinition("Plugin singleton", DisableParallelization = true)]
public class ApiPluginCollection { }

internal sealed class ApiPluginFixture : IDisposable
{
    public CoreFixture Core { get; } = new();
    public Plugin Plugin { get; }
    private readonly Plugin? previous = Plugin.Instance;
    public ApiPluginFixture()
    {
        Core.Paths.SetupGet(p => p.PluginConfigurationsPath).Returns(Path.Combine(Core.Root, "config"));
        Core.Paths.SetupGet(p => p.WebPath).Returns(Path.Combine(Core.Root, "web"));
        var host = new Mock<IServerApplicationHost>();
        host.SetupGet(h => h.ApplicationVersion).Returns(new Version(HostCompatibilityService.BuiltFor == "jf12" ? "12.0.0" : "10.11.0"));
        host.SetupGet(h => h.ApplicationVersionString).Returns("test-host");
        var xml = new Mock<IXmlSerializer>();
        xml.Setup(s => s.DeserializeFromFile(typeof(PluginConfiguration), It.IsAny<string>())).Returns(() => new PluginConfiguration());
        Plugin = new Plugin(Core.Paths.Object, Mock.Of<IServerConfigurationManager>(), xml.Object, Core.Logger, null!, new HostCompatibilityService(host.Object));
    }
    public void Dispose()
    {
        typeof(Plugin).GetProperty(nameof(Plugin.Instance))!.SetValue(null, previous);
        Core.Dispose();
    }
}
