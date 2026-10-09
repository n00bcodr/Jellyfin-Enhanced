using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace JE.Tests;

internal sealed class IntegrationEnvironment : IDisposable
{
    public string Root { get; } = Path.Combine(Path.GetTempPath(), "je-integrations-" + Guid.NewGuid());
    public Mock<IApplicationPaths> Paths { get; } = new();
    public Jellyfin.Plugin.JellyfinEnhanced.Logger Logger { get; }
    public IntegrationEnvironment()
    {
        Directory.CreateDirectory(Root);
        Paths.SetupGet(p => p.PluginsPath).Returns(Root);
        Paths.SetupGet(p => p.LogDirectoryPath).Returns(Root);
        Logger = new(Paths.Object, NullLoggerFactory.Instance);
    }
    public void Dispose() => Directory.Delete(Root, true);
}
