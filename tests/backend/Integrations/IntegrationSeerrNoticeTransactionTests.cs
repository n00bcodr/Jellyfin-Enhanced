using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using N = JE.Tests.IntegrationNotificationsTests;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class IntegrationSeerrNoticeTransactionTests
{
    private static int Rows(N.Rig r, string table) => r.Db.Read(c =>
    { using var cmd = c.CreateCommand(); cmd.CommandText = "SELECT COUNT(*) FROM " + table; return Convert.ToInt32(cmd.ExecuteScalar()); });

    [Fact]
    public async Task ApprovalFanoutAndEveryChannelRollBackTogetherThenRecoverOnceAfterRestart()
    {
        using var r = await N.Started();
        var second = r.View.AddUser(admin: true); r.Users.AdminIds.Add(second.UserId);
        r.Phones(r.Admin, second);
        r.Prefs(r.Admin, p => p.AdminAlerts = true); r.Prefs(second, p => p.AdminAlerts = true);
        r.Arr.Now = r.Arr.Now.AddMinutes(1);
        r.Request(71, 693134, r.Emma, status: 1, created: r.Arr.Now.UtcDateTime);
        await r.Requests.RefreshAsync(default);
        r.Db.Write((c,t) => { using var cmd = c.CreateCommand(); cmd.Transaction = t;
            cmd.CommandText = "CREATE TRIGGER abort_second_recipient BEFORE INSERT ON notifications WHEN NEW.user_id='" + second.UserId.ToString("N") + "' BEGIN SELECT RAISE(ABORT, 'write unavailable'); END";
            return cmd.ExecuteNonQuery(); });
        Assert.Throws<Microsoft.Data.Sqlite.SqliteException>(() => r.Service.ScanRequests(r.Arr.Now));
        Assert.Empty(r.Inbox(r.Admin)); Assert.Empty(r.Inbox(second));
        Assert.False(r.NotifyStore.SeerrSeen().ContainsKey(71)); Assert.Equal(0, Rows(r, "deliveries"));
        r.Db.Write((c,t) => { using var cmd = c.CreateCommand(); cmd.Transaction = t; cmd.CommandText = "DROP TRIGGER abort_second_recipient"; return cmd.ExecuteNonQuery(); });
        r.Open(); await r.Step(); await r.Step();
        Assert.Single(r.Inbox(r.Admin), n => n.Kind == "approval"); Assert.Single(r.Inbox(second), n => n.Kind == "approval");
        Assert.Equal(1, r.NotifyStore.SeerrSeen()[71]); Assert.Equal(4, Rows(r, "deliveries"));
    }
    [Fact]
    public async Task ADatabaseRestoreRevisitsSeerrEvenWhenTheReadModelRevisionDidNotChange()
    {
        using var r = await N.Started(x => x.Request(72, 693134, x.Emma, status: 1));
        var pending = r.Db.Snapshot()!;
        r.Seerr.Requests[0]["status"] = 3;
        await r.Step(); Assert.Single(r.Inbox(r.Emma), n => n.Kind == "declined");
        var revision = r.Requests.Revision;
        r.Db.ReplaceWith(pending);
        await r.Service.TickAsync(default, force: true);
        Assert.Equal(revision, r.Requests.Revision);
        Assert.Single(r.Inbox(r.Emma), n => n.Kind == "declined");
        Assert.Equal(3, r.NotifyStore.SeerrSeen()[72]);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ApprovalDraftingCannotConsumeAChangedSourceOrARestoredDatabase(bool restore)
    {
        using var r = await N.Started();
        var second = r.View.AddUser(admin: true); r.Users.AdminIds.Add(second.UserId);
        r.Phones(r.Admin, second);
        r.Prefs(r.Admin, p => p.AdminAlerts = true); r.Prefs(second, p => p.AdminAlerts = true);
        var snapshot = r.Db.Snapshot()!;
        r.Arr.Now = r.Arr.Now.AddMinutes(1);
        r.Request(73, 693134, r.Emma, status: 1, created: r.Arr.Now.UtcDateTime);
        await r.Requests.RefreshAsync(default);
        var count = 0;
        var policy = new IntegrationRequestLedgerTests.Policy();
        policy.Adjust = (_, _, facts) =>
        {
            if (++count == 2)
            {
                Assert.Empty(r.Inbox(r.Admin)); Assert.Empty(r.Inbox(second));
                if (restore) r.Db.ReplaceWith(snapshot);
                else r.Config.JellyseerrUrls = "http://replacement.invalid:5055";
            }
            return facts with { Visible = true };
        };
        using var dispatcher = new NotifyDispatcher(r.NotifyStore, new NtfySender(r.Ntfy), new EmailSender(r.Mail), null,
            () => r.Config, () => r.Arr.Now, r.Users, r.View, r.Status.Aliases, policy: policy, requests: r.Requests);
        using var service = new NotificationService(r.NotifyStore, r.Status, r.Requests, r.View, r.Feed,
            r.Store, r.Users, dispatcher, null, null, () => r.Config, () => r.Arr.Now, policy: policy);
        Assert.False(service.ScanRequests(r.Arr.Now));
        Assert.Equal(2, count);
        Assert.Empty(r.Inbox(r.Admin)); Assert.Empty(r.Inbox(second));
        Assert.False(r.NotifyStore.SeerrSeen().ContainsKey(73)); Assert.Equal(0, Rows(r, "deliveries"));
        if (restore)
        {
            r.Open(); await r.Step(); await r.Step();
            Assert.Single(r.Inbox(r.Admin), n => n.Kind == "approval");
            Assert.Single(r.Inbox(second), n => n.Kind == "approval");
            Assert.Equal(4, Rows(r, "deliveries"));
        }
        else
        {
            await r.Requests.RefreshAsync(default);
            Assert.True(service.ScanRequests(r.Arr.Now));
            Assert.Empty(r.Inbox(r.Admin)); Assert.Empty(r.Inbox(second));
            Assert.Equal(1, r.NotifyStore.SeerrSeen()[73]);
        }
    }

}
