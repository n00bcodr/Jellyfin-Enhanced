using System.Security.Claims;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests;

/// <summary>
/// 4f review round 1 (security-5): every writer of a person's notification settings changes only its own fields, in one
/// transaction. A change made by someone else between the writer's read and its write (here: the person turning native
/// Ready messages off, and an e-mail address being confirmed or a topic set) is never undone, so a revoked consent stays
/// revoked.
/// </summary>
[Collection("Plugin singleton")]
public class ApiNotifyPrefsWritersTests
{
    private const string Verified = "verified@home.test";
    private const string Topic = "je-concurrent-topic";

    private static NotifyController Controller(IntegrationNotificationsTests.Rig rig, StatusViewer viewer)
    {
        var controller = new NotifyController(rig.Service, rig.Dispatcher, new NtfySender(rig.Ntfy), new EmailSender(rig.Mail), rig.Users)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
            Config = () => rig.Config,
            Now = () => rig.Arr.Now,
        };
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", viewer.UserId.ToString())], "test"));
        return controller;
    }

    private static int Status(IActionResult result) => result switch
    {
        ObjectResult obj => obj.StatusCode ?? 200,
        StatusCodeResult code => code.StatusCode,
        _ => throw new InvalidOperationException(result.GetType().Name),
    };

    /// <summary>
    /// The person consented to native messages; the writer runs and, right after it read the settings, the person opts out
    /// and (for writers that don't own them) an address is confirmed or a topic set elsewhere.
    /// </summary>
    private static async Task Race(string writer, Func<IntegrationNotificationsTests.Rig, Task<IActionResult>> write, Action<IntegrationNotificationsTests.Rig>? prepare = null)
    {
        using var rig = await IntegrationNotificationsTests.Started();
        var emma = rig.Emma.UserId;
        var seeded = rig.NotifyStore.Prefs(emma);
        seeded.NativeReadyMessages = true;
        seeded.NtfyTopic = "je-topic-before-race";
        if (writer == "remove_email") seeded.EmailAddress = "emma@home.test";
        rig.NotifyStore.SavePrefs(emma, seeded, rig.Arr.Now);
        prepare?.Invoke(rig);
        var ownsEmail = writer is "verify_email" or "remove_email";
        var ownsTopic = writer is "assign_topic" or "set_topic";
        var fired = 0;
        rig.NotifyStore.PrefsRead = user =>
        {
            if (user != emma || Interlocked.Exchange(ref fired, 1) == 1) return;
            rig.NotifyStore.UpdatePrefs(emma, p =>
            {
                p.NativeReadyMessages = false;
                if (!ownsEmail) p.EmailAddress = Verified;
                if (!ownsTopic) p.NtfyTopic = Topic;
            }, rig.Arr.Now);
        };
        Assert.Equal(200, Status(await write(rig)));
        // A writer that reads nothing before its own transaction leaves no gap: the opt-out then lands right after it.
        if (fired == 0) rig.NotifyStore.PrefsRead!(emma);
        rig.NotifyStore.PrefsRead = null;
        Assert.Equal(1, fired);
        var after = rig.NotifyStore.Prefs(emma);
        Assert.False(after.NativeReadyMessages);
        if (!ownsEmail) Assert.Equal(Verified, after.EmailAddress);
        if (!ownsTopic) Assert.Equal(Topic, after.NtfyTopic);
    }

    [Fact]
    public Task AnAdministratorsTopicAssignmentNeverRestoresARevokedConsent()
        => Race("assign_topic", rig => Task.FromResult(Controller(rig, rig.Admin).AssignTopic(rig.Emma.UserId.ToString(), new NotifyTopicRequest { Generate = true })));

    [Fact]
    public Task APersonsOwnTopicChangeNeverRestoresARevokedConsent()
        => Race("set_topic", rig => Task.FromResult(Controller(rig, rig.Emma).SetTopic(new NotifyTopicRequest { Generate = true })));

    [Fact]
    public Task RemovingTheAddressNeverRestoresARevokedConsent()
        => Race("remove_email", rig => Task.FromResult(Controller(rig, rig.Emma).RemoveEmail()));

    [Fact]
    public Task ChangingSettingsNeverRestoresARevokedConsent()
        => Race("prefs", rig => Task.FromResult(Controller(rig, rig.Emma).PutPrefs(new NotifyPrefsRequest { HideTitles = true })));

    [Fact]
    public async Task ConfirmingAnAddressNeverRestoresARevokedConsent()
    {
        string? code = null;
        await Race("verify_email", rig => Task.FromResult(Controller(rig, rig.Emma).VerifyEmail(new NotifyEmailRequest { Code = code })), rig =>
        {
            Assert.Equal(200, Status(Controller(rig, rig.Emma).StartEmail(new NotifyEmailRequest { Address = "emma@home.test" }, default).GetAwaiter().GetResult()));
            code = Regex.Match(rig.Mail.Sent[^1].Subject, @"\d{6}").Value;
        });
    }
}
