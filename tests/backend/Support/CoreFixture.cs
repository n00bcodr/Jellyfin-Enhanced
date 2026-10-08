using Jellyfin.Plugin.JellyfinEnhanced;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace JE.Tests;

public sealed class CoreFixture : IDisposable
{
    public string Root { get; } = Path.Combine(Path.GetTempPath(), "je-regression-" + Guid.NewGuid().ToString("N"));
    public string ConfigRoot => Path.Combine(Root, "configurations", "Jellyfin.Plugin.JellyfinEnhanced");
    public Mock<IApplicationPaths> Paths { get; } = new();
    public Logger Logger { get; }
    public UserConfigurationManager Manager { get; }
    public CoreFixture()
    {
        Directory.CreateDirectory(Root);
        Paths.SetupGet(p => p.PluginsPath).Returns(Root);
        Paths.SetupGet(p => p.LogDirectoryPath).Returns(Root);
        Logger = new Logger(Paths.Object, NullLoggerFactory.Instance);
        Manager = new UserConfigurationManager(Paths.Object, Logger);
    }
    public string Write(string user, string text)
    {
        var dir = Path.Combine(ConfigRoot, user);
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "settings.json");
        File.WriteAllText(path, text);
        return path;
    }
    public void Dispose() => Directory.Delete(Root, true);
}
