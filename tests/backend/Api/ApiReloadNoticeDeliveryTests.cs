using System.Security.Claims;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Session;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace JE.Tests;

/// <summary>
/// Stage 1 fix round 11: a page of an earlier build learns from the identity of the code that runs. The reload notice for
/// a refused write reaches a page only through a connected controller of its session, so it is held until one connects and
/// only a delivered notice counts towards the per-device limit (RBS1-R11-9: a session without a connected socket "got" the
/// notice, which went nowhere and used up the limit; a held one was dropped when the session started before its socket
/// connected). The server's build is the running assembly's identity, not the DLL file's time (RBS1-R11-11: the same DLL
/// copied again announced a new build), and the entry script carries the build it is served by (RBS1-R11-10).
/// </summary>
[Collection("Plugin singleton")]
public class ApiReloadNoticeDeliveryTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ASessionWithoutAConnectedControllerGetsTheNoticeOnceOneConnects(bool startsLater)
    {
        var manager = new Mock<ISessionManager>();
        var person = Guid.NewGuid();
        var device = "notice-" + Guid.NewGuid().ToString("N");
        var session = new SessionInfo(manager.Object, NullLogger.Instance) { Id = "s-" + device, DeviceId = device, UserId = person, Client = "Jellyfin Web" };
        var sessions = startsLater ? new List<SessionInfo>() : new List<SessionInfo> { session };
        manager.SetupGet(x => x.Sessions).Returns(() => sessions.ToArray());
        var delivered = 0;
        // Jellyfin (10.11 and 12.2) hands a message to the session's controllers: without a connected one it goes nowhere,
        // although the call completes.
        manager.Setup(x => x.SendMessageCommand(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<MessageCommand>(), It.IsAny<CancellationToken>()))
            .Callback(() => { if (session.SessionControllers.Any(c => c.IsSessionActive)) delivered++; })
            .Returns(Task.CompletedTask);
        var user = new ClaimsPrincipal(new ClaimsIdentity(new[]
        {
            new Claim("Jellyfin-UserId", person.ToString()), new Claim("Jellyfin-DeviceId", device), new Claim("Jellyfin-IsApiKey", "false"),
        }, "test"));
        var delay = ClientReloadNotice.DeliveryDelay;
        ClientReloadNotice.DeliveryDelay = TimeSpan.Zero;
        try
        {
            Assert.False(ClientReloadNotice.Send(manager.Object, user, ClientReloadNotice.SettingsText, null));
            Assert.Equal(0, delivered);
            if (startsLater)
            {
                // An HTTP request can start the session before a hidden tab connects its socket again.
                sessions.Add(session);
                manager.Raise(x => x.SessionStarted += null, new SessionEventArgs { SessionInfo = session });
                await Task.Delay(40);
                Assert.Equal(0, delivered);
            }

            var controller = new Mock<ISessionController>();
            controller.SetupGet(x => x.IsSessionActive).Returns(true);
            session.AddController(controller.Object);
            manager.Raise(x => x.SessionControllerConnected += null, new SessionEventArgs { SessionInfo = session });
            manager.Raise(x => x.SessionStarted += null, new SessionEventArgs { SessionInfo = session });
            await Task.Delay(100);
            Assert.Equal(1, delivered);
        }
        finally { ClientReloadNotice.DeliveryDelay = delay; }
    }

    [Fact]
    public void AConnectedSessionIsToldAtOnceAndOnlyOnceInAFewMinutes()
    {
        var manager = new Mock<ISessionManager>();
        var person = Guid.NewGuid();
        var device = "notice-" + Guid.NewGuid().ToString("N");
        var session = new SessionInfo(manager.Object, NullLogger.Instance) { Id = "s-" + device, DeviceId = device, UserId = person, Client = "Jellyfin Web" };
        var controller = new Mock<ISessionController>();
        controller.SetupGet(x => x.IsSessionActive).Returns(true);
        session.AddController(controller.Object);
        manager.SetupGet(x => x.Sessions).Returns(() => new[] { session });
        manager.Setup(x => x.SendMessageCommand(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<MessageCommand>(), It.IsAny<CancellationToken>())).Returns(Task.CompletedTask);
        var user = new ClaimsPrincipal(new ClaimsIdentity(new[]
        {
            new Claim("Jellyfin-UserId", person.ToString()), new Claim("Jellyfin-DeviceId", device), new Claim("Jellyfin-IsApiKey", "false"),
        }, "test"));
        Assert.True(ClientReloadNotice.Send(manager.Object, user, ClientReloadNotice.SettingsText, null));
        Assert.False(ClientReloadNotice.Send(manager.Object, user, ClientReloadNotice.SettingsText, null));
        manager.Verify(x => x.SendMessageCommand(It.IsAny<string>(), session.Id, It.IsAny<MessageCommand>(), It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public void TheSameAssemblyCopiedAgainKeepsItsBuild()
    {
        using var f = new ApiPluginFixture();
        var assembly = typeof(Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced).Assembly.Location;
        var at = File.GetLastWriteTimeUtc(assembly);
        try
        {
            var before = f.Plugin.ScriptCacheKey;
            File.SetLastWriteTimeUtc(assembly, at.AddSeconds(30));
            Assert.Equal(before, f.Plugin.ScriptCacheKey);
            Assert.StartsWith(f.Plugin.Version + "-", before, StringComparison.Ordinal);
        }
        finally { File.SetLastWriteTimeUtc(assembly, at); }
    }

    [Fact]
    public void TheEntryScriptNamesTheBuildItIsServedBy()
    {
        using var f = new ApiPluginFixture();
        using var stream = Assert.IsType<FileStreamResult>(ApiAssetTests.Controller(f.Core).GetMainScript()).FileStream;
        var script = new StreamReader(stream).ReadToEnd();
        Assert.Contains($"const EMBEDDED_BUILD = '{f.Plugin.ScriptCacheKey}';", script);
        Assert.DoesNotContain("const EMBEDDED_BUILD = '__JE_PAGE_BUILD__'", script);
    }
}
