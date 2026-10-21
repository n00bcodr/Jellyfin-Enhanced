using System.Text.Json;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Ready;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Users;
using MediaBrowser.Controller.Library;
using Moq;

namespace JE.Tests;

/// <summary>
/// Dashboard → Users (D43): a person's Ready playlist and native-message consents, stored and in effect, with their switches,
/// read-only. An administrator can't turn either on (or off) for a person.
/// </summary>
public class ReadyAdminUsersTests
{
    [Fact]
    public async Task TheUsersPageShowsStoredAndEffectiveReadyConsentsAndNeverWritesThem()
    {
        using var files = new CoreFixture();
        using var r = new IntegrationRequestLedgerTests.Rig();
        ((User)r.View.Users[r.Admin].Handle!).SetPermission(PermissionKind.IsAdministrator, true);
        var users = new Mock<IUserManager>();
        users.Setup(x => x.GetUserById(It.IsAny<Guid>())).Returns((Guid id) => r.View.Users.TryGetValue(id, out var v) ? (User)v.Handle! : null);
        var config = r.Policy.Configuration;
        config.ArrPhase4Enabled = true;
        config.ArrPhase4ReadyPlaylistEnabled = true;
        var host = new FakeReadyPlaylistHost();
        var store = new ReadyPlaylistStore(r.Db);
        var editions = new EditionAvailability(r.View, () => config, (k, v) => r.View.Copies(k, v).Display);
        var ready = new ReadyPlaylistService(store, host, new FakeReadyInterests(), new ReadyCopySelector(editions, new FakeReadyLibrary(), null), new FakeReadyPrivacy(), r.View, () => config, () => r.Now, "server-a", null);
        var service = new AdminUserSettingsService(r.Service, users.Object, files.Manager, r.Audit, _ => { }, ready: ready);
        JsonElement Read() => JsonDocument.Parse(JsonSerializer.Serialize(service.Read(r.Member).Body)).RootElement.GetProperty("ready");

        var before = Read();
        Assert.True(before.GetProperty("playlistGate").GetBoolean());
        Assert.False(before.GetProperty("playlistStored").GetBoolean());
        Assert.False(before.GetProperty("playlistEffective").GetBoolean());
        Assert.False(before.GetProperty("messagesGate").GetBoolean());
        Assert.False(before.GetProperty("messagesStored").GetBoolean());

        await ready.SetPlaylistAsync(r.Member, true);
        new NotifyStore(r.Db).UpdatePrefs(r.Member, p => p.NativeReadyMessages = true, r.Now);
        var after = Read();
        Assert.True(after.GetProperty("playlistStored").GetBoolean());
        Assert.True(after.GetProperty("playlistEffective").GetBoolean());
        Assert.Equal(ReadyState.Active, after.GetProperty("state").GetString());
        Assert.True(after.GetProperty("messagesStored").GetBoolean());
        Assert.False(after.GetProperty("messagesEffective").GetBoolean());   // the switch is off

        // No administrator write path: a "ready" group is refused and nothing changes.
        var patch = service.Patch(r.Admin, r.Member, "ready", JsonDocument.Parse("{\"revision\":\"x\",\"readyPlaylist\":false}").RootElement);
        Assert.NotEqual(200, patch.Status);
        Assert.True(store.Binding("server-a", r.Member)!.OptedIn);
        Assert.False(store.Binding("server-a", r.Kid) is { OptedIn: true });
        Assert.Empty(host.Calls);
    }
}
