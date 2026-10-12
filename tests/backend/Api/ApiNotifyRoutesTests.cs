using System.Security.Claims;
using System.Text.Json;
using System.Text.RegularExpressions;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

/// <summary>
/// The notification routes ("Requests &amp; downloads", phase 2): behind their switch and a signed-in
/// user; each user only ever sees and changes their own inbox, follows and settings; topics and
/// addresses are validated (no user-chosen endpoint); e-mail needs a code (rate-limited, attempts
/// capped); "Remind" rules; administrators' routes are theirs only and never return a secret; the
/// inbox feed key reaches its owner only.
/// </summary>
[Collection("Plugin singleton")]
public class ApiNotifyRoutesTests
{
    private const string Dune = "movie:tmdb:693134";

    private static NotifyController Controller(IntegrationNotificationsTests.Rig rig, StatusViewer? viewer)
    {
        var controller = new NotifyController(rig.Service, rig.Dispatcher, new NtfySender(rig.Ntfy), new EmailSender(rig.Mail), rig.Users)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
            Config = () => rig.Config,
            Now = () => rig.Arr.Now,
        };
        controller.HttpContext.User = viewer == null
            ? new ClaimsPrincipal(new ClaimsIdentity(Array.Empty<Claim>(), "test"))
            : new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", viewer.UserId.ToString())], "test"));
        return controller;
    }

    private sealed record Reply(int Status, string Body)
    {
        public JsonElement Json => JsonDocument.Parse(Body).RootElement;
    }

    private static Reply Of(IActionResult result) => result switch
    {
        ObjectResult obj => new Reply(obj.StatusCode ?? 200, JsonSerializer.Serialize(obj.Value)),
        ForbidResult => new Reply(403, string.Empty),
        StatusCodeResult code => new Reply(code.StatusCode, string.Empty),
        _ => throw new InvalidOperationException(result.GetType().Name),
    };

    private static async Task<Reply> Of(Task<IActionResult> result) => Of(await result);

    [Fact]
    public async Task EveryRouteIsBehindTheSwitchAndNeedsAUser()
    {
        using var rig = await IntegrationNotificationsTests.Started();
        rig.Config.ArrPhase2Enabled = false;
        Assert.Equal((403, "feature_disabled"), Code(Of(Controller(rig, rig.Emma).GetInbox(null, null))));
        Assert.Equal((403, "feature_disabled"), Code(await Of(Controller(rig, rig.Emma).PutFollow(new FollowRequest { Key = Dune, On = true }, default))));
        rig.Config.ArrPhase2Enabled = true;
        rig.Config.ArrNotificationsEnabled = false;
        Assert.Equal((403, "feature_disabled"), Code(Of(Controller(rig, rig.Emma).GetPrefs())));
        rig.Config.ArrNotificationsEnabled = true;
        Assert.Equal((403, "user_required"), Code(Of(Controller(rig, null).GetInbox(null, null))));
        Assert.Equal(200, Of(Controller(rig, rig.Emma).GetInbox(null, null)).Status);
    }

    private static (int, string?) Code(Reply r) => (r.Status, r.Body.Length > 0 && r.Json.TryGetProperty("code", out var c) ? c.GetString() : null);

    [Fact]
    public async Task EachUserReadsAndMarksOnlyTheirOwnInbox()
    {
        using var rig = await IntegrationNotificationsTests.Started();
        rig.Service.SendTest(rig.Emma.UserId);
        rig.Arr.Now = rig.Arr.Now.AddSeconds(1);
        rig.Service.SendTest(rig.Emma.UserId);
        rig.Service.SendTest(rig.Sam.UserId);
        var emma = Of(Controller(rig, rig.Emma).GetInbox(null, 1)).Json;
        Assert.Equal((2, true, 1), (emma.GetProperty("unread").GetInt32(), emma.GetProperty("more").GetBoolean(), emma.GetProperty("items").GetArrayLength()));
        var newest = emma.GetProperty("items")[0];
        Assert.Equal(("test", "#/requests"), (newest.GetProperty("kind").GetString(), newest.GetProperty("link").GetString()));
        var older = Of(Controller(rig, rig.Emma).GetInbox(newest.GetProperty("id").GetInt64(), 10)).Json;
        Assert.Equal(1, older.GetProperty("items").GetArrayLength());
        // Sam can't mark Emma's notification read (it isn't his), only his own.
        var samId = Of(Controller(rig, rig.Sam).GetInbox(null, null)).Json.GetProperty("items")[0].GetProperty("id").GetInt64();
        var cross = Of(Controller(rig, rig.Sam).MarkRead(new NotifyReadRequest { Ids = new List<long> { newest.GetProperty("id").GetInt64() } })).Json;
        Assert.Equal((0, 1), (cross.GetProperty("changed").GetInt32(), cross.GetProperty("unread").GetInt32()));
        var own = Of(Controller(rig, rig.Sam).MarkRead(new NotifyReadRequest { Ids = new List<long> { samId } })).Json;
        Assert.Equal((1, 0), (own.GetProperty("changed").GetInt32(), own.GetProperty("unread").GetInt32()));
        Assert.Equal(2, Of(Controller(rig, rig.Emma).MarkRead(new NotifyReadRequest { All = true })).Json.GetProperty("changed").GetInt32());
        Assert.Equal(400, Of(Controller(rig, rig.Emma).MarkRead(new NotifyReadRequest())).Status);
        Assert.DoesNotContain(rig.Sam.UserId.ToString("N"), Of(Controller(rig, rig.Emma).GetInbox(null, null)).Body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task SettingsAreValidatedAndCarryNoAdministratorSecrets()
    {
        using var rig = await IntegrationNotificationsTests.Started();
        var c = Controller(rig, rig.Emma);
        var body = Of(c.GetPrefs());
        Assert.Equal(("http://ntfy.lan", true), (body.Json.GetProperty("channels").GetProperty("ntfy").GetProperty("server").GetString(), body.Json.GetProperty("channels").GetProperty("email").GetProperty("available").GetBoolean()));
        Assert.Equal("Dad", body.Json.GetProperty("contact").GetString());
        foreach (var secret in new[] { "NTFY-TOKEN-SECRET", "SMTP-PASS-SECRET", "smtp.lan", "jellyfin@home.test" })
            Assert.DoesNotContain(secret, body.Body, StringComparison.Ordinal);
        Assert.Equal((400, "invalid_time"), Code(Of(c.PutPrefs(new NotifyPrefsRequest { QuietFrom = "25:00" }))));
        Assert.Equal((400, "invalid_time_zone"), Code(Of(c.PutPrefs(new NotifyPrefsRequest { TimeZone = "../../etc/passwd x" }))));
        Assert.Equal((400, "email_not_verified"), Code(Of(c.PutPrefs(new NotifyPrefsRequest { Email = true }))));
        Assert.Equal((400, "ntfy_topic_missing"), Code(Of(c.PutPrefs(new NotifyPrefsRequest { Ntfy = true }))));
        var saved = Of(c.PutPrefs(new NotifyPrefsRequest { QuietHours = true, QuietFrom = "21:30", QuietTo = "06:45", TimeZone = "Europe/London", UtcOffsetMinutes = 60, Episodes = false })).Json.GetProperty("prefs");
        Assert.Equal((true, "21:30", "06:45", false, true), (saved.GetProperty("quietHours").GetBoolean(), saved.GetProperty("quietFrom").GetString(), saved.GetProperty("quietTo").GetString(), saved.GetProperty("episodes").GetBoolean(), saved.GetProperty("ready").GetBoolean()));
        // Only administrators see the admin-alert switch.
        Assert.Equal(JsonValueKind.Null, saved.TryGetProperty("adminAlerts", out var a) ? a.ValueKind : JsonValueKind.Null);

        // Topics: a name on the administrator's server, never an address.
        foreach (var bad in new[] { "http://evil.example/x", "../admin", "short", "a/b/c/d/e/f/g" })
            Assert.Equal((400, "invalid_topic"), Code(Of(c.SetTopic(new NotifyTopicRequest { Topic = bad }))));
        var made = Of(c.SetTopic(new NotifyTopicRequest { Generate = true })).Json.GetProperty("prefs");
        Assert.Matches("^je-[a-z2-7]{26}$", made.GetProperty("ntfyTopic").GetString());
        Assert.True(made.GetProperty("ntfy").GetBoolean());
        var cleared = Of(c.SetTopic(new NotifyTopicRequest { Topic = "" })).Json.GetProperty("prefs");
        Assert.False(cleared.GetProperty("ntfy").GetBoolean());
    }

    [Fact]
    public async Task EmailNeedsTheCodeSentToItWithResendsAndAttemptsLimited()
    {
        using var rig = await IntegrationNotificationsTests.Started();
        var c = Controller(rig, rig.Emma);
        Assert.Equal((400, "invalid_address"), Code(await Of(c.StartEmail(new NotifyEmailRequest { Address = "me@home.test\r\nBcc: all@x.y" }, default))));
        Assert.Equal(200, (await Of(c.StartEmail(new NotifyEmailRequest { Address = "emma@home.test" }, default))).Status);
        var mail = Assert.Single(rig.Mail.Sent);
        Assert.Equal("emma@home.test", mail.To);
        var code = Regex.Match(mail.Subject, @"\d{6}").Value;
        Assert.Equal((429, "too_soon"), Code(await Of(c.StartEmail(new NotifyEmailRequest { Address = "emma@home.test" }, default))));
        // Not verified until the code is entered; wrong codes are counted and capped.
        Assert.False(Of(c.GetPrefs()).Json.GetProperty("prefs").TryGetProperty("emailAddress", out var none) && none.ValueKind == JsonValueKind.String);
        var wrong = code == "000000" ? "111111" : "000000";
        Assert.Equal((400, "wrong_code"), Code(Of(c.VerifyEmail(new NotifyEmailRequest { Code = wrong }))));
        var ok = Of(c.VerifyEmail(new NotifyEmailRequest { Code = code })).Json.GetProperty("prefs");
        Assert.Equal(("emma@home.test", true), (ok.GetProperty("emailAddress").GetString(), ok.GetProperty("email").GetBoolean()));
        Assert.Equal((400, "no_pending_code"), Code(Of(c.VerifyEmail(new NotifyEmailRequest { Code = code }))));

        // Another code: five wrong attempts lock it.
        rig.Arr.Now = rig.Arr.Now.AddMinutes(2);
        Assert.Equal(200, (await Of(c.StartEmail(new NotifyEmailRequest { Address = "emma2@home.test" }, default))).Status);
        var code2 = Regex.Match(rig.Mail.Sent[^1].Subject, @"\d{6}").Value;
        var bad = code2 == "000000" ? "111111" : "000000";
        for (var i = 0; i < 5; i++) Assert.Equal(400, Of(c.VerifyEmail(new NotifyEmailRequest { Code = bad })).Status);
        Assert.Equal((429, "too_many_attempts"), Code(Of(c.VerifyEmail(new NotifyEmailRequest { Code = code2 }))));
        // At most five codes a day.
        for (var i = 0; i < 3; i++)
        {
            rig.Arr.Now = rig.Arr.Now.AddMinutes(2);
            Assert.Equal(200, (await Of(c.StartEmail(new NotifyEmailRequest { Address = "emma3@home.test" }, default))).Status);
        }
        rig.Arr.Now = rig.Arr.Now.AddMinutes(2);
        Assert.Equal((429, "too_many_today"), Code(await Of(c.StartEmail(new NotifyEmailRequest { Address = "emma3@home.test" }, default))));
        rig.Config.ArrEmailEnabled = false;
        Assert.Equal((409, "email_not_set_up"), Code(await Of(c.StartEmail(new NotifyEmailRequest { Address = "emma@home.test" }, default))));
        Assert.Equal(200, Of(c.RemoveEmail()).Status);
        Assert.False(Of(c.GetPrefs()).Json.GetProperty("prefs").GetProperty("email").GetBoolean());
    }

    [Fact]
    public async Task FollowsAreValidatedAndListedWithRequestsAndMutes()
    {
        using var rig = await IntegrationNotificationsTests.Started(r => r.Request(1, 693134, r.Emma));
        var c = Controller(rig, rig.Emma);
        Assert.Equal((400, "invalid_key"), Code(await Of(c.PutFollow(new FollowRequest { Key = "tv:tvdb:1:s1:e2", On = true }, default))));
        Assert.Equal((400, "invalid_key"), Code(await Of(c.PutFollow(new FollowRequest { Key = "<script>", On = true }, default))));
        Assert.Equal(200, (await Of(c.PutFollow(new FollowRequest { Key = "tv:tvdb:371980:s2", On = true }, default))).Status);
        var list = Of(c.GetFollows()).Json;
        Assert.Equal("season", list.GetProperty("follows")[0].GetProperty("kind").GetString());
        Assert.Equal(Dune, list.GetProperty("requested")[0].GetString());
        // Stopping an automatic follow (an own request) mutes it.
        Assert.Equal(200, (await Of(c.PutFollow(new FollowRequest { Key = Dune, On = false }, default))).Status);
        Assert.Equal(Dune, Of(c.GetFollows()).Json.GetProperty("muted")[0].GetString());
        Assert.Equal((403, "not_allowed"), Code(await Of(Controller(rig, rig.Kid).PutFollow(new FollowRequest { Key = "movie:tmdb:4242", On = true }, default))));
        Assert.Empty(Of(Controller(rig, rig.Sam).GetFollows()).Json.GetProperty("follows").EnumerateArray());
    }

    [Fact]
    public async Task RemindIsForStuckTitlesOnceADay()
    {
        using var rig = await IntegrationNotificationsTests.Started(r => r.Request(1, 693134, r.Emma));
        var c = Controller(rig, rig.Emma);
        Assert.Equal((409, "not_stuck"), Code(await Of(c.Remind(new RemindRequest { Key = Dune }, default))));
        rig.Radarr.Queue.Add(FakeArr.RadarrQueueRow(2, 693134, "Dune Part Two", state: "importBlocked", status: "warning"));
        await rig.Store.RefreshForEventAsync(rig.Arr.Instance("RadarrZ").Id, ArrSnapshotKind.Queue, force: true);
        Assert.Equal(200, (await Of(c.Remind(new RemindRequest { Key = Dune }, default))).Status);
        Assert.Equal((429, "too_soon"), Code(await Of(c.Remind(new RemindRequest { Key = Dune }, default))));
        Assert.Equal((409, "admin"), Code(await Of(Controller(rig, rig.Admin).Remind(new RemindRequest { Key = Dune }, default))));
        Assert.Equal((400, "invalid_id"), Code(await Of(c.Remind(new RemindRequest { Key = Dune, ItemId = "x" }, default))));
        Assert.Equal((404, "not_found"), Code(await Of(c.Remind(new RemindRequest { Key = Dune, ItemId = Guid.NewGuid().ToString() }, default))));
    }

    [Fact]
    public async Task AdministratorRoutesAreAdminOnlyAndNeverReturnASecret()
    {
        using var rig = await IntegrationNotificationsTests.Started();
        rig.Phones(rig.Emma);
        Assert.Equal(403, Of(Controller(rig, rig.Emma).GetAdmin()).Status);
        Assert.Equal(403, Of(Controller(rig, rig.Emma).AssignTopic(rig.Sam.UserId.ToString(), new NotifyTopicRequest { Generate = true })).Status);
        Assert.Equal(403, (await Of(Controller(rig, rig.Emma).AdminTest(new NotifyAdminTestRequest { Channel = "ntfy", Topic = "je-abcdefgh" }, default))).Status);
        var admin = Of(Controller(rig, rig.Admin).GetAdmin());
        Assert.Equal(200, admin.Status);
        // No credential, and no user's e-mail address (only whether one is confirmed).
        foreach (var secret in new[] { "NTFY-TOKEN-SECRET", "SMTP-PASS-SECRET", rig.Emma.UserId.ToString("N")[..8] + "@" })
            Assert.DoesNotContain(secret, admin.Body, StringComparison.Ordinal);
        Assert.True(admin.Json.GetProperty("channels").GetProperty("ntfy").GetProperty("tokenSet").GetBoolean());
        Assert.True(admin.Json.GetProperty("users").EnumerateArray().Single().GetProperty("emailVerified").GetBoolean());
        // Assigning a topic turns the user's phone alerts on with it.
        var assigned = Of(Controller(rig, rig.Admin).AssignTopic(rig.Sam.UserId.ToString(), new NotifyTopicRequest { Topic = "sam-family-topic" })).Json;
        Assert.Equal(("sam-family-topic", true), (assigned.GetProperty("topic").GetString(), assigned.GetProperty("ntfy").GetBoolean()));
        rig.Users.Gone.Add(rig.Kid.UserId);
        Assert.Equal(404, Of(Controller(rig, rig.Admin).AssignTopic(rig.Kid.UserId.ToString(), new NotifyTopicRequest { Generate = true })).Status);
        // The test send goes to the configured server with the stored token; e-mail too.
        var push = (await Of(Controller(rig, rig.Admin).AdminTest(new NotifyAdminTestRequest { Channel = "ntfy", Topic = "je-admin-test" }, default))).Json;
        Assert.True(push.GetProperty("ok").GetBoolean());
        Assert.Equal(("http://ntfy.lan/", "Bearer NTFY-TOKEN-SECRET-123"), (rig.Pushes[^1].Url, rig.Pushes[^1].Auth));
        var mail = (await Of(Controller(rig, rig.Admin).AdminTest(new NotifyAdminTestRequest { Channel = "email", Address = "owner@home.test" }, default))).Json;
        Assert.True(mail.GetProperty("ok").GetBoolean());
        Assert.Equal((400, "invalid_channel"), Code(await Of(Controller(rig, rig.Admin).AdminTest(new NotifyAdminTestRequest { Channel = "webhook" }, default))));
    }

    [Fact]
    public void InboxKeysReachTheirOwnerOnly()
    {
        var me = new User("me", "default", "default") { Id = Guid.NewGuid() };
        var other = new User("other", "default", "default") { Id = Guid.NewGuid() };
        var users = new Mock<IUserManager>();
        users.Setup(m => m.GetUserById(me.Id)).Returns(me);
        users.Setup(m => m.GetUserById(other.Id)).Returns(other);
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(new List<BaseItem>());
        using var arr = new FakeArr();
        var audience = new ArrFeedAudience(library.Object, users.Object, arr.Store(), null, new FakeJellyfinView(), null);
        var changes = new List<ArrFeedChange> { new(ArrTitleKey.UserInbox(me.Id), 1, null), new(ArrTitleKey.UserInbox(other.Id), 2, null) };
        Assert.Equal(new[] { ArrTitleKey.UserInbox(me.Id) }, audience.Visible(me.Id, false, changes));
        Assert.Equal(new[] { ArrTitleKey.UserInbox(other.Id) }, audience.Visible(other.Id, true, changes));
        Assert.True(ArrTitleKey.IsFeedKey(ArrTitleKey.UserInbox(me.Id)));
        Assert.False(ArrTitleKey.IsFeedKey("ntf:u:" + me.Id.ToString("N").ToUpperInvariant()));
        Assert.False(ArrTitleKey.TryParseUserInbox("ntf:u:xyz", out _));
    }

    [Fact]
    public async Task AnAdministratorMadeANormalUserNoLongerSeesAdministratorsAlerts()
    {
        using var rig = await IntegrationNotificationsTests.Started();
        rig.Arr.Now = rig.Arr.Now.AddMinutes(1);
        rig.Seerr.Requests.Add(FakeSeerr.Request(7, "movie", 693134, 1, rig.Emma.UserId, rig.Arr.Now.UtcDateTime, userName: "Emma"));
        await rig.Step();
        Assert.True(rig.Service.SendTest(rig.Admin.UserId));
        var before = Of(Controller(rig, rig.Admin).GetInbox(null, null)).Json;
        Assert.Equal(2, before.GetProperty("unread").GetInt32());
        // Made a normal user: the approval (household requests) is no longer theirs to read.
        rig.View.Users[rig.Admin.UserId] = new StatusViewer { UserId = rig.Admin.UserId, IsAdmin = false, PolicyRevision = "demoted" };
        var after = Of(Controller(rig, rig.Admin).GetInbox(null, null)).Json;
        Assert.Equal(1, after.GetProperty("unread").GetInt32());
        Assert.Equal("test", Assert.Single(after.GetProperty("items").EnumerateArray()).GetProperty("kind").GetString());
        Assert.Equal(0, Of(Controller(rig, rig.Admin).MarkRead(new NotifyReadRequest { All = true })).Json.GetProperty("unread").GetInt32());
    }

    [Fact]
    public async Task EmailLimitsHoldAgainstRequestsAtOnce()
    {
        using var rig = await IntegrationNotificationsTests.Started();
        // Ten "send me a code" at once: one code goes out.
        var starts = await Task.WhenAll(Enumerable.Range(0, 10).Select(_ => Task.Run(() => Of(Controller(rig, rig.Emma).StartEmail(new NotifyEmailRequest { Address = "emma@home.test" }, default)))));
        Assert.Single(starts, r => r.Status == 200);
        Assert.Single(rig.Mail.Sent);
        var code = Regex.Match(rig.Mail.Sent[0].Subject, @"\d{6}").Value;
        var wrong = code == "000000" ? "111111" : "000000";
        // Forty wrong codes at once: five are tried, the rest refused.
        var tries = await Task.WhenAll(Enumerable.Range(0, 40).Select(_ => Task.Run(() => Of(Controller(rig, rig.Emma).VerifyEmail(new NotifyEmailRequest { Code = wrong })))));
        Assert.Equal(5, tries.Count(r => r.Status == 400));
        Assert.Equal(35, tries.Count(r => r.Status == 429));
        Assert.Equal((429, "too_many_attempts"), Code(Of(Controller(rig, rig.Emma).VerifyEmail(new NotifyEmailRequest { Code = code }))));
    }

    [Fact]
    public async Task SendMeATestIsOncePerHalfMinuteEvenWhenAskedManyTimesAtOnce()
    {
        using var rig = await IntegrationNotificationsTests.Started();
        rig.Phones(rig.Emma);
        var replies = await Task.WhenAll(Enumerable.Range(0, 20).Select(_ => Task.Run(() => Of(Controller(rig, rig.Emma).SendTest()))));
        Assert.Single(replies, r => r.Status == 200);
        Assert.Equal(19, replies.Count(r => r.Status == 429));
        Assert.Single(rig.Inbox(rig.Emma), n => n.Kind == "test");
        rig.Arr.Now = rig.Arr.Now.AddSeconds(29);
        Assert.Equal((429, "too_soon"), Code(Of(Controller(rig, rig.Emma).SendTest())));
        rig.Arr.Now = rig.Arr.Now.AddSeconds(2);
        Assert.Equal(200, Of(Controller(rig, rig.Emma).SendTest()).Status);
        await rig.Dispatcher.RunOnceAsync(default);
        Assert.Equal(2, rig.Pushes.Count);
    }

    [Fact]
    public async Task TheInboxStopsNamingATitleTheUserCanNoLongerOpen()
    {
        using var rig = await IntegrationNotificationsTests.Started(r => r.Request(1, 693134, r.Emma));
        await rig.Step(Dune);
        var item = rig.Arrive(Dune);
        await rig.Step(Dune);
        var shown = Of(Controller(rig, rig.Emma).GetInbox(null, null)).Json.GetProperty("items")[0];
        Assert.Equal(("Dune Part Two", item.ToString("N")), (shown.GetProperty("params").GetProperty("title").GetString(), shown.GetProperty("itemId").GetString()));
        // The film moves to a library Emma can't open: the row stays (still counted), without the title.
        rig.View.CopiesByKey[Dune] = new() { (new JfCopy { ItemId = item, Path = "/media/" + Dune }, new HashSet<Guid> { rig.Admin.UserId }) };
        var body = Of(Controller(rig, rig.Emma).GetInbox(null, null));
        var hidden = body.Json.GetProperty("items")[0];
        Assert.Equal(("ready", "#/requests", JsonValueKind.Null, JsonValueKind.Null), (hidden.GetProperty("kind").GetString(), hidden.GetProperty("link").GetString(), hidden.GetProperty("itemId").ValueKind, hidden.GetProperty("key").ValueKind));
        Assert.False(hidden.GetProperty("params").TryGetProperty("title", out _));
        Assert.DoesNotContain("Dune", body.Body, StringComparison.Ordinal);
        Assert.DoesNotContain("693134", body.Body, StringComparison.Ordinal);
        Assert.DoesNotContain(item.ToString("N"), body.Body, StringComparison.Ordinal);
        Assert.Equal(1, body.Json.GetProperty("unread").GetInt32());
    }
}
