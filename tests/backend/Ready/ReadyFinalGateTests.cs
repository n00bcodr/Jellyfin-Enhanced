using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Ready;
using World = JE.Tests.ReadyProvenanceAndWaitsTests.World;

namespace JE.Tests;

/// <summary>
/// 4f round 9 (4f-r8-1, D53): one final gate, nothing handed in. A delivery's own awaited preparation can't outlive the
/// switches it is judged by: the master switch turned off while a single delivery (or a summary's survivor, sent one by one)
/// is being prepared sends nothing, settles nothing and leaves it pending; it goes once notifications are back on. Through
/// the real NotifyDispatcher, NotificationService, RequestLedger and RequestService over a real acquire.db.
/// </summary>
[Collection("Plugin singleton")]
public class ReadyFinalGateTests
{
    private static readonly string[] Keys = Enumerable.Range(0, 5).Select(i => "movie:tmdb:" + (7100 + i)).ToArray();

    private static string Name(string key) => "Film " + key.Split(':')[^1];

    // Quiet hours from an hour ago to an hour from now (UTC): held sends come due two hours on.
    private static void Quiet(World w, StatusViewer who)
        => w.Rig.Prefs(who, p =>
        {
            p.QuietHours = true;
            p.QuietFrom = w.Rig.Arr.Now.UtcDateTime.AddHours(-1).ToString("HH:mm", System.Globalization.CultureInfo.InvariantCulture);
            p.QuietTo = w.Rig.Arr.Now.UtcDateTime.AddHours(1).ToString("HH:mm", System.Globalization.CultureInfo.InvariantCulture);
            p.UtcOffsetMinutes = 0;
        });

    // The kid's requests for the first `count` titles declined during their quiet hours: one bell row each, with a phone and an
    // e-mail delivery held until the quiet hours end. Returns each title's notification id.
    private static async Task<Dictionary<string, long>> HeldDeclines(World w, int count)
    {
        var kid = w.Rig.Kid;
        var ids = new List<string>();
        for (var i = 0; i < count; i++) ids.Add(await w.Ask(kid, Keys[i], "kid-" + i));
        Quiet(w, kid);
        foreach (var id in ids) await w.Decide(id, NotifyKind.Declined);
        await w.Step(true);
        var rows = w.Rig.Inbox(kid).Where(r => r.Kind == NotifyKind.Declined).ToDictionary(r => r.Key!, r => r.Id);
        Assert.Equal(count, rows.Count);
        Assert.All(rows.Values, id => Assert.All(w.Deliveries(id), d => Assert.Equal("pending", d.Status)));
        Assert.Equal(0, Messages(w));
        return rows;
    }

    private static int Messages(World w) => w.Rig.Pushes.Count + w.Rig.Mail.Sent.Count;

    private static void AssertStatus(World w, long notification, string status)
        => Assert.All(w.Deliveries(notification), d => Assert.Equal(status, d.Status));

    // Runs `change` inside the kid's nth awaited preparation of the round (1-based), once.
    private static void AtPreparation(World w, int nth, Action change, Action? also = null, int alsoAt = 0)
    {
        var kid = w.Rig.Kid.UserId;
        var n = 0;
        w.Policy.Visibility = (who, input) =>
        {
            if (who != kid) return Task.CompletedTask;
            n++;
            if (n == alsoAt) also?.Invoke();
            if (n == nth) change();
            return Task.CompletedTask;
        };
    }

    [Fact]
    public async Task NotificationsSwitchedOffDuringASingleDeliverysPreparationSendNothingAndItGoesOnceTheyAreBack()
    {
        // 4f-r8-1: the round read the switch, then the delivery awaited its preparation and was decided and sent with the
        // configuration read before it.
        using var w = await ReadyProvenanceAndWaitsTests.JeWorld();
        var rows = await HeldDeclines(w, 1);
        var row = rows[Keys[0]];
        AtPreparation(w, 1, () => w.Rig.Config.ArrNotificationsEnabled = false);
        w.Rig.Arr.Now = w.Rig.Arr.Now.AddHours(2);
        await w.Dispatcher.RunOnceAsync(default);

        Assert.Equal(0, Messages(w));
        AssertStatus(w, row, "pending");

        // Back on: it goes (phone and e-mail), once.
        w.Policy.Visibility = null;
        w.Rig.Config.ArrNotificationsEnabled = true;
        await w.Dispatcher.RunOnceAsync(default);
        AssertStatus(w, row, "sent");
        Assert.Single(w.Rig.Pushes);
        Assert.Single(w.Rig.Mail.Sent);
        Assert.True(w.Told(Name(Keys[0])));
    }

    [Fact]
    public async Task NotificationsSwitchedOffDuringTheEmailDeliverysPreparationLeaveItPendingAfterThePhoneOneWent()
    {
        // The second channel's delivery: its own preparation (after the phone push went) is what the switch is judged after.
        using var w = await ReadyProvenanceAndWaitsTests.JeWorld();
        var rows = await HeldDeclines(w, 1);
        var row = rows[Keys[0]];
        AtPreparation(w, 2, () => w.Rig.Config.ArrNotificationsEnabled = false);
        w.Rig.Arr.Now = w.Rig.Arr.Now.AddHours(2);
        await w.Dispatcher.RunOnceAsync(default);

        Assert.Single(w.Rig.Pushes);
        Assert.Empty(w.Rig.Mail.Sent);
        Assert.Equal(new[] { "sent", "pending" }, w.Deliveries(row).Select(d => d.Status));

        w.Policy.Visibility = null;
        w.Rig.Config.ArrNotificationsEnabled = true;
        await w.Dispatcher.RunOnceAsync(default);
        AssertStatus(w, row, "sent");
        Assert.Single(w.Rig.Pushes);
        Assert.Single(w.Rig.Mail.Sent);
    }

    [Theory]
    [InlineData(6)]
    [InlineData(8)]
    public async Task NotificationsSwitchedOffDuringASurvivorsOwnPreparationInTheFallbackSendNothingMore(int nth)
    {
        // The summary's one-by-one fallback: five held declines, two hidden during the last member's preparation, three left
        // (under the summary threshold) go one by one, each prepared again. The switch goes off during the first survivor's
        // (6th preparation) or the last survivor's (8th) own preparation: that one and everything after it stays pending.
        using var w = await ReadyProvenanceAndWaitsTests.JeWorld();
        var kid = w.Rig.Kid;
        var rows = await HeldDeclines(w, 5);
        var order = new List<string>();
        var kidId = kid.UserId;
        var n = 0;
        w.Policy.Visibility = (who, input) =>
        {
            if (who != kidId) return Task.CompletedTask;
            n++;
            if (n <= 5) order.Add(input.Key);
            if (n == 5) w.Privacy.Rules[kidId] = new ReadyHides(Array.Empty<Guid>(), Array.Empty<Guid>(), new[] { order[0], order[1] });
            if (n == nth) w.Rig.Config.ArrNotificationsEnabled = false;
            return Task.CompletedTask;
        };
        w.Rig.Arr.Now = w.Rig.Arr.Now.AddHours(2);
        await w.Dispatcher.RunOnceAsync(default);

        var survivors = Keys.Except(order.Take(2)).ToList();
        var pushedBefore = nth == 6 ? 0 : 2;
        Assert.Equal(pushedBefore, w.Rig.Pushes.Count);
        Assert.Empty(w.Rig.Mail.Sent);
        for (var i = 0; i < survivors.Count; i++)
        {
            var statuses = w.Deliveries(rows[survivors[i]]).Select(d => d.Status).ToList();
            Assert.Equal(new[] { i < pushedBefore ? "sent" : "pending", "pending" }, statuses);
        }

        // The two hidden ones: the phone deliveries suppressed in the summary's pass; their e-mails weren't looked at yet.
        foreach (var hidden in order.Take(2)) Assert.Equal(new[] { "suppressed", "pending" }, w.Deliveries(rows[hidden]).Select(d => d.Status));

        // Back on: what stayed pending goes (the e-mails as one by one too: three survivors).
        w.Policy.Visibility = null;
        w.Rig.Config.ArrNotificationsEnabled = true;
        await w.Dispatcher.RunOnceAsync(default);
        foreach (var key in survivors) AssertStatus(w, rows[key], "sent");
        foreach (var hidden in order.Take(2)) AssertStatus(w, rows[hidden], "suppressed");
        Assert.Equal(3, w.Rig.Pushes.Count);
        Assert.Equal(3, w.Rig.Mail.Sent.Count);
        Assert.False(w.Told("new notifications"));
    }
}
