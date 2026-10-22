using System.Reflection;
using System.Security.Claims;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Session;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace JE.Tests;

/// <summary>
/// Stage 1 fix round 12: a reload notice counts as delivered only once Jellyfin's send completed successfully (RBS1-R12-7).
/// The held notice was removed before it was sent and the per-device limit was spent as soon as SendMessageCommand returned
/// a task: a send that then failed was only logged, and the reconnect (or a later refused save) delivered nothing.
/// </summary>
[Collection("Plugin singleton")]
public class ApiReloadNoticeRetryTests
{
    private static ClaimsPrincipal Person(Guid id, string device, bool apiKey = false) => new(new ClaimsIdentity(new[] {
        new Claim("Jellyfin-UserId", id.ToString()), new Claim("Jellyfin-DeviceId", device),
        new Claim("Jellyfin-IsApiKey", apiKey ? "true" : "false")
    }, "test"));

    [Fact]
    public async Task AFailedDeferredNoticeMustBeRetriedWhenTheControllerReconnects()
    {
        var manager = new Mock<ISessionManager>();
        var person = Guid.NewGuid();
        var device = Guid.NewGuid().ToString("N");
        var session = new SessionInfo(manager.Object, NullLogger.Instance) { Id = device, DeviceId = device, UserId = person };
        manager.SetupGet(x => x.Sessions).Returns(() => new[] { session });
        bool fails = true;
        int delivered = 0, attempted = 0;
        manager.Setup(x => x.SendMessageCommand(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<MessageCommand>(), It.IsAny<CancellationToken>()))
            .Returns(() => { Interlocked.Increment(ref attempted); if (fails) return Task.FromException(new IOException("socket closed")); Interlocked.Increment(ref delivered); return Task.CompletedTask; });
        var principal = Person(person, device);
        var original = ClientReloadNotice.DeliveryDelay;
        ClientReloadNotice.DeliveryDelay = TimeSpan.Zero;
        try
        {
            Assert.False(ClientReloadNotice.Send(manager.Object, principal, ClientReloadNotice.SettingsText, null));
            var controller = new Mock<ISessionController>();
            controller.SetupGet(x => x.IsSessionActive).Returns(true);
            session.AddController(controller.Object);
            manager.Raise(x => x.SessionControllerConnected += null, new SessionEventArgs { SessionInfo = session });
            for (int n = 0; n < 100 && Volatile.Read(ref attempted) == 0; n++) await Task.Delay(5);
            Assert.Equal(1, attempted);
            fails = false;
            manager.Raise(x => x.SessionControllerConnected += null, new SessionEventArgs { SessionInfo = session });
            await Task.Delay(100);
            Assert.Equal(1, delivered);
        }
        finally { ClientReloadNotice.DeliveryDelay = original; }
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task AnUndeliveredNoticeIsNotLostOrThrottled(bool initiallyDisconnected, bool failFirst)
    {
        var manager = new Mock<ISessionManager>();
        var person = Guid.NewGuid();
        var device = "r12-notice-" + Guid.NewGuid();
        var session = new SessionInfo(manager.Object, NullLogger.Instance) { Id = "s-" + device, DeviceId = device, UserId = person };
        var active = !initiallyDisconnected;
        var controller = new Mock<ISessionController>();
        controller.SetupGet(x => x.IsSessionActive).Returns(() => active);
        session.AddController(controller.Object);
        manager.SetupGet(x => x.Sessions).Returns(new[] { session });
        var attempts = 0;
        var delivered = 0;
        manager.Setup(x => x.SendMessageCommand(It.IsAny<string>(), session.Id, It.IsAny<MessageCommand>(), It.IsAny<CancellationToken>()))
            .Returns(() => { attempts++; if (failFirst && attempts == 1) return Task.FromException(new IOException("socket closed before delivery")); delivered++; return Task.CompletedTask; });
        var previous = ClientReloadNotice.DeliveryDelay;
        ClientReloadNotice.DeliveryDelay = TimeSpan.Zero;
        try
        {
            ClientReloadNotice.Send(manager.Object, Person(person, device), ClientReloadNotice.SettingsText, null);
            if (initiallyDisconnected)
            {
                active = true;
                manager.Raise(x => x.SessionControllerConnected += null, new SessionEventArgs { SessionInfo = session });
            }
            await Task.Delay(100);
            Assert.Equal(1, attempts);
            // A subsequent save/connection is deliverable; failure must not consume the delivery limit.
            ClientReloadNotice.Send(manager.Object, Person(person, device), ClientReloadNotice.SettingsText, null);
            manager.Raise(x => x.SessionControllerConnected += null, new SessionEventArgs { SessionInfo = session });
            await Task.Delay(100);
            Assert.Equal(1, delivered);
        }
        finally { ClientReloadNotice.DeliveryDelay = previous; }
    }

    private static (Mock<ISessionManager> Manager, SessionInfo Session, Mock<ISessionController> Controller) Connected(Guid person, string device)
    {
        var manager = new Mock<ISessionManager>();
        var session = new SessionInfo(manager.Object, NullLogger.Instance) { Id = "s-" + device, DeviceId = device, UserId = person };
        var controller = new Mock<ISessionController>();
        controller.SetupGet(x => x.IsSessionActive).Returns(true);
        session.AddController(controller.Object);
        manager.SetupGet(x => x.Sessions).Returns(() => new[] { session });
        return (manager, session, controller);
    }

    [Theory]
    [InlineData("throw")]
    [InlineData("cancel")]
    public async Task ASendThatThrowsOrIsCancelledKeepsTheNoticeForTheNextConnection(string failure)
    {
        var person = Guid.NewGuid();
        var device = "r12-fail-" + Guid.NewGuid();
        var (manager, session, _) = Connected(person, device);
        var attempts = 0;
        var delivered = 0;
        manager.Setup(x => x.SendMessageCommand(It.IsAny<string>(), session.Id, It.IsAny<MessageCommand>(), It.IsAny<CancellationToken>()))
            .Returns(() =>
            {
                attempts++;
                if (attempts == 1)
                {
                    if (failure == "throw") throw new InvalidOperationException("no socket");
                    return Task.FromCanceled(new CancellationToken(true));
                }
                delivered++;
                return Task.CompletedTask;
            });
        var previous = ClientReloadNotice.DeliveryDelay;
        ClientReloadNotice.DeliveryDelay = TimeSpan.Zero;
        try
        {
            ClientReloadNotice.Send(manager.Object, Person(person, device), ClientReloadNotice.SettingsText, null);
            await Task.Delay(50);
            Assert.Equal(1, attempts);
            Assert.Equal(0, delivered);
            manager.Raise(x => x.SessionControllerConnected += null, new SessionEventArgs { SessionInfo = session });
            for (var n = 0; n < 100 && delivered == 0; n++) await Task.Delay(5);
            Assert.Equal(1, delivered);
            // Delivered: no more for this device within the limit.
            manager.Raise(x => x.SessionControllerConnected += null, new SessionEventArgs { SessionInfo = session });
            await Task.Delay(50);
            Assert.Equal(2, attempts);
        }
        finally { ClientReloadNotice.DeliveryDelay = previous; }
    }

    [Fact]
    public async Task ConnectionsWhileASendIsOutStartNoSecondSend()
    {
        var person = Guid.NewGuid();
        var device = "r12-flight-" + Guid.NewGuid();
        var (manager, session, _) = Connected(person, device);
        var attempts = 0;
        var gate = new TaskCompletionSource();
        manager.Setup(x => x.SendMessageCommand(It.IsAny<string>(), session.Id, It.IsAny<MessageCommand>(), It.IsAny<CancellationToken>()))
            .Returns(() => { Interlocked.Increment(ref attempts); return gate.Task; });
        var previous = ClientReloadNotice.DeliveryDelay;
        ClientReloadNotice.DeliveryDelay = TimeSpan.Zero;
        try
        {
            Assert.True(ClientReloadNotice.Send(manager.Object, Person(person, device), ClientReloadNotice.SettingsText, null));
            for (var i = 0; i < 3; i++) manager.Raise(x => x.SessionControllerConnected += null, new SessionEventArgs { SessionInfo = session });
            Assert.False(ClientReloadNotice.Send(manager.Object, Person(person, device), ClientReloadNotice.SettingsText, null));
            await Task.Delay(50);
            Assert.Equal(1, Volatile.Read(ref attempts));
            gate.SetResult();
            await Task.Delay(50);
            Assert.Equal(1, Volatile.Read(ref attempts));
        }
        finally { ClientReloadNotice.DeliveryDelay = previous; }
    }

    [Fact]
    public async Task AHeldNoticeIsNeverDeliveredToTheNextPersonOnTheDevice()
    {
        var person = Guid.NewGuid();
        var device = "r12-person-" + Guid.NewGuid();
        var manager = new Mock<ISessionManager>();
        var session = new SessionInfo(manager.Object, NullLogger.Instance) { Id = "s-" + device, DeviceId = device, UserId = person };
        manager.SetupGet(x => x.Sessions).Returns(() => new[] { session });
        var sent = 0;
        manager.Setup(x => x.SendMessageCommand(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<MessageCommand>(), It.IsAny<CancellationToken>()))
            .Returns(() => { Interlocked.Increment(ref sent); return Task.CompletedTask; });
        var previous = ClientReloadNotice.DeliveryDelay;
        ClientReloadNotice.DeliveryDelay = TimeSpan.Zero;
        try
        {
            Assert.False(ClientReloadNotice.Send(manager.Object, Person(person, device), ClientReloadNotice.SettingsText, null));
            // Someone else signs in on the device; its controller connects.
            var next = new SessionInfo(manager.Object, NullLogger.Instance) { Id = "s2-" + device, DeviceId = device, UserId = Guid.NewGuid() };
            var controller = new Mock<ISessionController>();
            controller.SetupGet(x => x.IsSessionActive).Returns(true);
            next.AddController(controller.Object);
            manager.SetupGet(x => x.Sessions).Returns(() => new[] { next });
            manager.Raise(x => x.SessionControllerConnected += null, new SessionEventArgs { SessionInfo = next });
            await Task.Delay(50);
            Assert.Equal(0, Volatile.Read(ref sent));
        }
        finally { ClientReloadNotice.DeliveryDelay = previous; }
    }

    [Fact]
    public async Task AnOlderSendCompletingDoesNotEraseANewerNoticeHeldAfterIt()
    {
        var person = Guid.NewGuid();
        var device = "r12-newer-" + Guid.NewGuid();
        var (manager, session, controller) = Connected(person, device);
        var gate = new TaskCompletionSource();
        var texts = new List<string>();
        manager.Setup(x => x.SendMessageCommand(It.IsAny<string>(), session.Id, It.IsAny<MessageCommand>(), It.IsAny<CancellationToken>()))
            .Returns<string, string, MessageCommand, CancellationToken>((_, _, command, _) => { lock (texts) texts.Add(command.Text); return texts.Count == 1 ? gate.Task : Task.CompletedTask; });
        var pending = typeof(ClientReloadNotice).GetField("_pending", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null)!;
        var held = (System.Collections.IDictionary)pending;
        var previous = ClientReloadNotice.DeliveryDelay;
        ClientReloadNotice.DeliveryDelay = TimeSpan.Zero;
        try
        {
            Assert.True(ClientReloadNotice.Send(manager.Object, Person(person, device), ClientReloadNotice.SettingsText, null));
            // While the first send is out, a newer notice is held for the device (another refused write).
            Assert.False(ClientReloadNotice.Send(manager.Object, Person(person, device), ClientReloadNotice.ConfigurationText, null));
            Assert.True(held.Contains(device));
            gate.SetException(new IOException("socket closed"));
            await Task.Delay(50);
            Assert.True(held.Contains(device), "the newer notice stays held after the older send failed");
        }
        finally { ClientReloadNotice.DeliveryDelay = previous; }
    }

    [Fact]
    public async Task AnOlderSendSucceedingLeavesTheNewerNoticeHeldForItsOwnTurn()
    {
        var person = Guid.NewGuid();
        var device = "r12-newer-ok-" + Guid.NewGuid();
        var (manager, session, controller) = Connected(person, device);
        var gate = new TaskCompletionSource();
        var texts = new List<string>();
        manager.Setup(x => x.SendMessageCommand(It.IsAny<string>(), session.Id, It.IsAny<MessageCommand>(), It.IsAny<CancellationToken>()))
            .Returns<string, string, MessageCommand, CancellationToken>((_, _, command, _) => { lock (texts) texts.Add(command.Text); return texts.Count == 1 ? gate.Task : Task.CompletedTask; });
        var held = (System.Collections.IDictionary)typeof(ClientReloadNotice).GetField("_pending", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null)!;
        var told = (System.Collections.IDictionary)typeof(ClientReloadNotice).GetField("_told", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null)!;
        var deliver = typeof(ClientReloadNotice).GetMethod("TryDeliver", BindingFlags.Static | BindingFlags.NonPublic)!;
        var previous = ClientReloadNotice.DeliveryDelay;
        ClientReloadNotice.DeliveryDelay = TimeSpan.Zero;
        try
        {
            Assert.True(ClientReloadNotice.Send(manager.Object, Person(person, device), ClientReloadNotice.SettingsText, null));
            Assert.False(ClientReloadNotice.Send(manager.Object, Person(person, device), ClientReloadNotice.ConfigurationText, null));
            // The older send completes successfully: it removes its own notice only, never the newer one held since.
            gate.SetResult();
            await Task.Delay(50);
            Assert.True(held.Contains(device), "the newer notice stays held");
            // Once the delivery interval has passed (its record of the last delivery gone), the newer notice goes out.
            told.Remove(device);
            Assert.True((bool)deliver.Invoke(null, new object?[] { manager.Object, session, null })!);
            await Task.Delay(50);
            lock (texts) Assert.Equal(new[] { ClientReloadNotice.SettingsText, ClientReloadNotice.ConfigurationText }, texts);
            Assert.False(held.Contains(device));
        }
        finally { ClientReloadNotice.DeliveryDelay = previous; }
    }
}
