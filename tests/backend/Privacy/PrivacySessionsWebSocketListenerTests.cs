using System.Reflection;
using System.Text.Json;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Net;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Dto;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using User = Jellyfin.Database.Implementations.Entities.User;

namespace Jellyfin.Api.WebSocketListeners
{
    /// <summary>Stands in for the host's own session listener (matched by its full type name).</summary>
    public sealed class SessionInfoWebSocketListener : IWebSocketListener
    {
        public Task ProcessMessageAsync(WebSocketMessageInfo message) => Task.CompletedTask;

        public Task ProcessWebSocketConnectedAsync(IWebSocketConnection connection, Microsoft.AspNetCore.Http.HttpContext httpContext) => Task.CompletedTask;
    }
}

namespace JE.Tests
{
    /// <summary>
    /// The dashboard's live session updates (WebSocket "Sessions"): the native listener is replaced where the host can
    /// build session DTOs for it, and each update is projected for the receiving connection's viewer like the REST answer.
    /// </summary>
    [Collection("Plugin singleton")]
    public class PrivacySessionsWebSocketListenerTests
    {
        [Fact]
        public void TheNativeSessionListenerIsReplacedOnlyWhereTheHostBuildsSessionDtos()
        {
            var services = new ServiceCollection();
            services.AddSingleton<IWebSocketListener, Jellyfin.Api.WebSocketListeners.SessionInfoWebSocketListener>();
            new Jellyfin.Plugin.JellyfinEnhanced.PluginServiceRegistrator().RegisterServices(services, Mock.Of<IServerApplicationHost>());
            var listeners = services.Where(d => d.ServiceType == typeof(IWebSocketListener)).Select(d => d.ImplementationType).ToArray();
            if (PrivacySessionsWebSocketListener.Supported)
                Assert.Equal(new[] { typeof(PrivacySessionsWebSocketListener) }, listeners);
            else
                // 10.11.0's ISessionManager has no ToSessionInfoDto: the host's own listener stays (later 10.11 hosts have it).
                Assert.Equal(new[] { typeof(Jellyfin.Api.WebSocketListeners.SessionInfoWebSocketListener) }, listeners);
        }

#if !NET9_0
        private static async Task<string> Update(PrivacyHostShapeModelTests.Rig rig, Guid viewer, bool admin)
        {
            var shot = PrivacyHostShapeModelTests.Data.Shots.Single(s => s.File == "Session.GetSessions.admin.json");
            var dtos = (List<SessionInfoDto>)PrivacyHostShapeModelTests.Value(shot);
            var manager = new Mock<ISessionManager>();
            var sessions = dtos.Select(d => new SessionInfo(manager.Object, NullLogger.Instance) { Id = d.Id!, UserId = d.UserId, DeviceId = d.DeviceId! }).ToList();
            manager.SetupGet(m => m.Sessions).Returns(sessions);
            manager.Setup(m => m.ToSessionInfoDto(It.IsAny<SessionInfo>())).Returns((SessionInfo s) => dtos.Single(d => d.Id == s.Id));
            var user = new User(admin ? "real-admin" : "real-viewer", "default", "default") { Id = viewer };
            user.SetPermission(PermissionKind.IsAdministrator, admin);
            var connection = new Mock<IWebSocketConnection>();
            connection.SetupGet(c => c.AuthorizationInfo).Returns(new AuthorizationInfo { User = user });
            await using var listener = new PrivacySessionsWebSocketListener(NullLogger<PrivacySessionsWebSocketListener>.Instance, manager.Object, rig.Gate());
            var send = typeof(PrivacySessionsWebSocketListener).GetMethod("GetDataToSendForConnection", BindingFlags.Instance | BindingFlags.NonPublic)!;
            var data = await (Task<IEnumerable<SessionInfoDto>>)send.Invoke(listener, new object[] { connection.Object })!;
            return JsonSerializer.Serialize(data.ToList(), Jellyfin.Extensions.Json.JsonDefaults.Options);
        }

        [Fact]
        public async Task AnAdministratorsDashboardUpdateLosesAnotherAccountsHiddenAndGuardedTitles()
        {
            using var rig = new PrivacyHostShapeModelTests.Rig();
            var original = await Update(rig, rig.Admin, admin: true);
            Assert.Contains("D46 R17 Hidden", original);
            Assert.Contains("Secret ending r17", original);
            rig.Commit(PrivacyHostShapeModelTests.Rules.Single(r => r.Id == "hc-movie"), rig.Admin);
            var hidden = await Update(rig, rig.Admin, admin: true);
            Assert.DoesNotContain("D46 R17 Hidden", hidden);
            Assert.Contains("Secret ending r17", hidden);
            rig.Commit(PrivacyHostShapeModelTests.Rules.Single(r => r.Id == "sg-series"), rig.Admin);
            var guarded = await Update(rig, rig.Admin, admin: true);
            Assert.DoesNotContain("Secret ending r17", guarded);
            // Every session is still in the update.
            Assert.Equal(JsonDocument.Parse(original).RootElement.GetArrayLength(), JsonDocument.Parse(guarded).RootElement.GetArrayLength());
        }

        [Fact]
        public async Task AViewersUpdateKeepsTheNativeFilterAndTheirOwnRules()
        {
            using var rig = new PrivacyHostShapeModelTests.Rig();
            var own = await Update(rig, rig.Viewer, admin: false);
            using var document = JsonDocument.Parse(own);
            Assert.All(document.RootElement.EnumerateArray(), s => Assert.Equal(rig.Viewer, Guid.Parse(s.GetProperty("UserId").GetString()!)));
            Assert.Contains("D46 R17 Hidden", own);
            rig.Commit(PrivacyHostShapeModelTests.Rules.Single(r => r.Id == "hc-movie"), rig.Viewer);
            Assert.DoesNotContain("D46 R17 Hidden", await Update(rig, rig.Viewer, admin: false));
        }
#endif
    }
}
