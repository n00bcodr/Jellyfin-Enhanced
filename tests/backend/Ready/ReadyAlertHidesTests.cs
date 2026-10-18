using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Ready;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.Sqlite;

namespace JE.Tests;

/// <summary>
/// 4f round 2b and review round 3 (D46, D53): no alert reveals a title, season or episode the recipient has hidden or can't
/// open, on any channel (the TV message, ntfy, e-mail, the bell and its toasts). One decision, given every physical copy of
/// the title (a title-level rule on any copy hides the title; a copy rule hides that copy), is made when the alert is
/// produced and again right before each individual send (a summary's fallback included) and on every bell read. Rules that
/// can't be read never let an alert through: production and outbound sends wait for them (bounded), the bell names nothing.
/// </summary>
[Collection("Plugin singleton")]
public class ReadyAlertHidesTests
{
    private const string Dune = "movie:tmdb:693134";
    private const string Show = "tv:tvdb:371980";

    private sealed class Alerts : IDisposable
    {
        public IntegrationNotificationsTests.Rig Rig { get; }
        public FakeReadyPrivacy Privacy { get; } = new();
        public FakeReadySessionHost Sessions { get; } = new();
        public NotifyDispatcher Dispatcher { get; }
        public NotificationService Service { get; }

        private Alerts(IntegrationNotificationsTests.Rig rig)
        {
            Rig = rig;
            rig.Config.ArrPhase4Enabled = true;
            rig.Config.ArrPhase4ReadyMessagesEnabled = true;
            rig.Phones(rig.Emma);
            rig.Prefs(rig.Emma, p => p.NativeReadyMessages = true);
            Sessions.Add(rig.Emma.UserId, "tv", rig.Arr.Now.UtcDateTime);
            var channel = new ReadyNativeChannel(new ReadyPlaylistStore(rig.Db), new ReadySessionMessages(Sessions, () => rig.Arr.Now.UtcDateTime), Privacy, rig.View, null, () => rig.Arr.Now);
            Dispatcher = new NotifyDispatcher(rig.NotifyStore, new NtfySender(rig.Ntfy), new EmailSender(rig.Mail), null, () => rig.Config, () => rig.Arr.Now, rig.Users, rig.View, rig.Status.Aliases, native: channel);
            Service = new NotificationService(rig.NotifyStore, rig.Status, rig.Requests, rig.View, rig.Feed, rig.Store, rig.Users, Dispatcher, null, null, () => rig.Config, () => rig.Arr.Now, rig.Hub, rig.Bridge);
        }

        public static async Task<Alerts> Start(Action<IntegrationNotificationsTests.Rig>? setup = null)
            => new(await IntegrationNotificationsTests.Started(r =>
            {
                r.Request(1, 693134, r.Emma);
                setup?.Invoke(r);
            }));

        public Guid Emma => Rig.Emma.UserId;

        /// <summary>One look at the titles (alerts produced), then (optionally) one delivery round.</summary>
        public async Task Step(bool send, params string[] keys)
        {
            await Rig.Requests.RefreshAsync(default);
            await Service.TickAsync(default);
            if (keys.Length > 0) await Service.EvaluateAsync(keys, null, default);
            Service.FlushBatches(Rig.Arr.Now);
            if (send) await Dispatcher.RunOnceAsync(default);
        }

        public Guid AddMovieCopy(string key, string library, params Guid[] visibleTo)
        {
            var id = Guid.NewGuid();
            Rig.View.AddCopy(TitleKey.Parse(key)!, new JfCopy { ItemId = id, Path = "/" + library + "/" + id.ToString("N"), LibraryName = library, DateCreated = Rig.Arr.Now.UtcDateTime }, visibleTo);
            Rig.View.Rev++;
            return id;
        }

        public IReadOnlyList<(string Channel, string Status)> Deliveries(long notification)
        {
            using var c = new SqliteConnection("Data Source=" + Rig.Db.FilePath + ";Pooling=False");
            c.Open();
            using var cmd = c.CreateCommand();
            cmd.CommandText = "SELECT channel, status FROM deliveries WHERE notification_id=$n ORDER BY id";
            cmd.Parameters.AddWithValue("$n", notification);
            using var r = cmd.ExecuteReader();
            var list = new List<(string, string)>();
            while (r.Read()) list.Add((r.GetString(0), r.GetString(1)));
            return list;
        }

        public (int Unread, JsonElement Items) Bell()
        {
            var controller = new NotifyController(Rig.Service, Dispatcher, new NtfySender(Rig.Ntfy), new EmailSender(Rig.Mail), Rig.Users)
            {
                ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
                Config = () => Rig.Config,
                Now = () => Rig.Arr.Now,
            };
            controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", Emma.ToString())], "test"));
            var result = (ObjectResult)controller.GetInbox(null, null);
            var root = JsonDocument.Parse(JsonSerializer.Serialize(result.Value)).RootElement;
            return (root.GetProperty("unread").GetInt32(), root.GetProperty("items"));
        }

        public bool Told(string text)
            => Rig.Pushes.Any(p => p.Body.ToJsonString().Contains(text, StringComparison.Ordinal))
               || Rig.Mail.Sent.Any(m => m.Subject.Contains(text, StringComparison.Ordinal) || m.Text.Contains(text, StringComparison.Ordinal))
               || Sessions.Sent.Any(s => s.Header.Contains(text, StringComparison.Ordinal) || s.Text.Contains(text, StringComparison.Ordinal));

        public void Dispose()
        {
            Dispatcher.Dispose();
            Service.Dispose();
            Rig.Dispose();
        }
    }

    private static ReadyHides TitleRule(string key) => new(Array.Empty<Guid>(), Array.Empty<Guid>(), new[] { key });

    private static ReadyHides ItemRule(Guid item, bool title = true) => new(new[] { item }, Array.Empty<Guid>(), Array.Empty<string>(), title ? new[] { item } : null);

    private static ReadyHides SeriesRule(Guid series) => new(new[] { series }, new[] { series }, Array.Empty<string>(), new[] { series });

    private static void AssertNameless(JsonElement row)
    {
        Assert.Equal(JsonValueKind.Null, row.GetProperty("key").ValueKind);
        Assert.Equal(JsonValueKind.Null, row.GetProperty("itemId").ValueKind);
        Assert.False(row.GetProperty("params").TryGetProperty("title", out _));
        Assert.False(row.GetProperty("params").TryGetProperty("image", out _));
    }

    // ------------------------------------------------------------------ a single Ready alert (round 2b)

    [Theory]
    [InlineData("tmdb")]
    [InlineData("item")]
    [InlineData("other_copy")]
    public async Task AMovieHiddenBeforeItIsReadyMakesNoAlertOnAnyChannel(string rule)
    {
        using var a = await Alerts.Start();
        var other = Guid.NewGuid();
        var item = Guid.NewGuid();
        a.Privacy.Rules[a.Emma] = rule switch
        {
            "tmdb" => TitleRule("movie:tmdb:693134"),
            "item" => ItemRule(item),
            _ => ItemRule(other),
        };
        a.Rig.View.AddCopy(TitleKey.Parse(Dune)!, new JfCopy { ItemId = item, Path = "/movies/dune", LibraryName = "Movies", DateCreated = a.Rig.Arr.Now.UtcDateTime });
        // A second physical copy (another library) arrives with it; the person's rule is on that copy's movie.
        if (rule == "other_copy") a.Rig.View.AddCopy(TitleKey.Parse(Dune)!, new JfCopy { ItemId = other, Path = "/kids/dune", LibraryName = "Kids", DateCreated = a.Rig.Arr.Now.UtcDateTime });
        a.Rig.View.Rev++;
        await a.Step(true, Dune);

        Assert.DoesNotContain(a.Rig.Inbox(a.Rig.Emma), r => r.Kind == NotifyKind.Ready);
        Assert.Empty(a.Rig.Pushes);
        Assert.Empty(a.Rig.Mail.Sent);
        Assert.Empty(a.Sessions.Sent);
        Assert.Equal(0, a.Bell().Unread);

        // Hidden when it became ready: that arrival is never announced later (unhiding isn't "it became ready").
        a.Privacy.Rules.Remove(a.Emma);
        await a.Step(true, Dune);
        Assert.DoesNotContain(a.Rig.Inbox(a.Rig.Emma), r => r.Kind == NotifyKind.Ready);
        Assert.Empty(a.Rig.Pushes);
    }

    [Theory]
    [InlineData("tmdb")]
    [InlineData("item")]
    [InlineData("other_copy")]
    [InlineData("revoked")]
    public async Task AMovieHiddenAfterItsAlertWasMadeIsSuppressedAtEverySend(string change)
    {
        using var a = await Alerts.Start();
        var item = a.Rig.Arrive(Dune, a.Emma, a.Rig.Sam.UserId);
        await a.Step(false, Dune);
        var row = Assert.Single(a.Rig.Inbox(a.Rig.Emma), r => r.Kind == NotifyKind.Ready);
        Assert.Equal(3, a.Deliveries(row.Id).Count);

        switch (change)
        {
            case "tmdb":
                a.Privacy.Rules[a.Emma] = TitleRule("movie:tmdb:693134");
                break;
            case "item":
                a.Privacy.Rules[a.Emma] = ItemRule(item);
                break;
            case "other_copy":
                // A movie rule made on another physical copy of the same title hides the title.
                a.Privacy.Rules[a.Emma] = ItemRule(a.AddMovieCopy(Dune, "Kids"));
                break;
            default:
                // The library is taken away from the person.
                a.Rig.View.CopiesByKey[Dune].Single(c => c.Copy.ItemId == item).VisibleTo!.Remove(a.Emma);
                break;
        }

        await a.Dispatcher.RunOnceAsync(default);
        Assert.False(a.Told("Dune"));
        Assert.Empty(a.Rig.Pushes);
        Assert.Empty(a.Rig.Mail.Sent);
        Assert.Empty(a.Sessions.Sent);
        Assert.All(a.Deliveries(row.Id), d => Assert.Equal("suppressed", d.Status));
        // The bell keeps the row (unread count unchanged) without what names the title (Q-4FFIX2-6).
        var (unread, items) = a.Bell();
        Assert.Equal(1, unread);
        AssertNameless(items[0]);
    }

    [Fact]
    public async Task NothingHiddenLeavesTheWordingAndDeliveryOfEveryChannelUnchanged()
    {
        using var a = await Alerts.Start();
        // Another title is hidden; Dune isn't.
        a.Privacy.Rules[a.Emma] = TitleRule("movie:tmdb:1");
        var item = a.Rig.Arrive(Dune);
        await a.Step(true, Dune);
        var row = Assert.Single(a.Rig.Inbox(a.Rig.Emma), r => r.Kind == NotifyKind.Ready);
        Assert.All(a.Deliveries(row.Id), d => Assert.Equal("sent", d.Status));
        Assert.Equal("Dune Part Two is ready to watch", (string)Assert.Single(a.Rig.Pushes).Body["title"]!);
        Assert.Equal("Dune Part Two is ready to watch", Assert.Single(a.Rig.Mail.Sent).Subject);
        var shown = Assert.Single(a.Sessions.Sent);
        Assert.Equal(("Dune Part Two is ready to watch", "Dune Part Two (2010) is in the library."), (shown.Header, shown.Text));
        var bell = a.Bell().Items[0];
        Assert.Equal((Dune, item.ToString("N"), "Dune Part Two"), (bell.GetProperty("key").GetString(), bell.GetProperty("itemId").GetString(), bell.GetProperty("params").GetProperty("title").GetString()));
    }

    // ------------------------------------------------------------------ unreadable rules: wait, never proceed (r3 behaviour-2)

    [Fact]
    public async Task UnreadableRulesAtProductionMakeNoAlertUntilTheyCanBeRead()
    {
        using var a = await Alerts.Start();
        a.Privacy.Rules[a.Emma] = null;
        a.Rig.Arrive(Dune);
        await a.Step(true, Dune);
        Assert.DoesNotContain(a.Rig.Inbox(a.Rig.Emma), r => r.Kind == NotifyKind.Ready);
        Assert.Empty(a.Rig.Pushes);
        Assert.Empty(a.Sessions.Sent);

        // Readable again (nothing hidden): the next look announces it as usual.
        a.Privacy.Rules.Remove(a.Emma);
        await a.Step(true, Dune);
        Assert.Single(a.Rig.Inbox(a.Rig.Emma), r => r.Kind == NotifyKind.Ready);
        Assert.Equal("Dune Part Two is ready to watch", (string)Assert.Single(a.Rig.Pushes).Body["title"]!);
    }

    [Fact]
    public async Task UnreadableRulesAtSendHoldPhoneAndEmailAndNameNothingInTheBell()
    {
        using var a = await Alerts.Start();
        a.Rig.Arrive(Dune);
        await a.Step(false, Dune);
        var row = Assert.Single(a.Rig.Inbox(a.Rig.Emma), r => r.Kind == NotifyKind.Ready);
        a.Privacy.Rules[a.Emma] = null;
        await a.Dispatcher.RunOnceAsync(default);
        Assert.Empty(a.Rig.Pushes);
        Assert.Empty(a.Rig.Mail.Sent);
        Assert.Empty(a.Sessions.Sent);
        // The TV message is never held; phone and e-mail wait for the rules.
        Assert.Equal(new[] { (NotifyChannel.Ntfy, "pending"), (NotifyChannel.Email, "pending"), (NotifyChannel.DisplayMessage, "suppressed") }, a.Deliveries(row.Id).OrderBy(d => d.Channel == NotifyChannel.DisplayMessage).ThenBy(d => d.Channel == NotifyChannel.Email).ToArray());
        AssertNameless(a.Bell().Items[0]);

        // Readable again: they go out with the title.
        a.Privacy.Rules.Remove(a.Emma);
        a.Rig.Arr.Now += TimeSpan.FromMinutes(6);
        await a.Dispatcher.RunOnceAsync(default);
        Assert.Equal("Dune Part Two is ready to watch", (string)Assert.Single(a.Rig.Pushes).Body["title"]!);
        Assert.Single(a.Rig.Mail.Sent);
        Assert.Equal("Dune Part Two", a.Bell().Items[0].GetProperty("params").GetProperty("title").GetString());
    }

    [Fact]
    public async Task RulesThatStayUnreadableEndTheWaitWithoutSending()
    {
        using var a = await Alerts.Start();
        a.Rig.Arrive(Dune);
        await a.Step(false, Dune);
        var row = Assert.Single(a.Rig.Inbox(a.Rig.Emma), r => r.Kind == NotifyKind.Ready);
        a.Privacy.Rules[a.Emma] = null;
        for (var i = 0; i < 6; i++)
        {
            await a.Dispatcher.RunOnceAsync(default);
            a.Rig.Arr.Now += TimeSpan.FromHours(5);
        }

        await a.Dispatcher.RunOnceAsync(default);
        Assert.Empty(a.Rig.Pushes);
        Assert.All(a.Deliveries(row.Id), d => Assert.Equal("suppressed", d.Status));
    }

    [Fact]
    public async Task UnreadableRulesAtBatchFlushKeepTheBatchUntilTheyCanBeRead()
    {
        var series = Guid.NewGuid();
        using var a = await Alerts.Start(r =>
        {
            r.Request(2, 95396, r.Emma, type: "tv", tvdb: 371980, seasons: new[] { 2 });
            r.View.AddCopy(TitleKey.Parse(Show)!, new JfCopy { ItemId = series, DateCreated = r.Arr.Now.UtcDateTime.AddDays(-30) });
            r.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = r.Arr.Now.UtcDateTime.AddDays(-30) });
        });
        await a.Step(false, Show);
        for (var i = 0; i < 2; i++) a.Rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = i + 1, DateCreated = a.Rig.Arr.Now.UtcDateTime });
        a.Privacy.Rules[a.Emma] = null;
        await a.Step(true, Show);
        a.Rig.Arr.Now += TimeSpan.FromMinutes(11);
        await a.Step(true, Show);
        // No bell row, no toast, nothing sent: the batch waits.
        Assert.DoesNotContain(a.Rig.Inbox(a.Rig.Emma), r => r.Kind == NotifyKind.Episodes);
        Assert.Empty(a.Rig.Pushes);
        Assert.NotNull(a.Rig.NotifyStore.Batch(a.Emma, Show));

        a.Privacy.Rules.Remove(a.Emma);
        a.Rig.Arr.Now += TimeSpan.FromMinutes(6);
        await a.Step(true, Show);
        var payload = NotifyDispatcher.Payload(Assert.Single(a.Rig.Inbox(a.Rig.Emma), r => r.Kind == NotifyKind.Episodes).Payload);
        Assert.Equal("2", payload["count"]);
        Assert.Single(a.Rig.Pushes);
    }

    // ------------------------------------------------------------------ the whole title, every copy (r3 security-3)

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ASeriesRuleOnAnotherCopyHidesABatchFromTheCopyThatHasTheEpisodes(bool atProduction)
    {
        var copyA = Guid.NewGuid();
        var copyB = Guid.NewGuid();
        using var a = await Alerts.Start(r =>
        {
            r.Request(2, 95396, r.Emma, type: "tv", tvdb: 371980, seasons: new[] { 2 });
            r.View.AddCopy(TitleKey.Parse(Show)!, new JfCopy { ItemId = copyA, Path = "/kids/severance", LibraryName = "Kids", DateCreated = r.Arr.Now.UtcDateTime.AddDays(-30) });
            r.View.AddCopy(TitleKey.Parse(Show)!, new JfCopy { ItemId = copyB, Path = "/tv/severance", LibraryName = "TV", DateCreated = r.Arr.Now.UtcDateTime.AddDays(-30) });
            r.View.AddEpisode(copyB, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = r.Arr.Now.UtcDateTime.AddDays(-30) });
        });
        await a.Step(false, Show);
        var files = new[] { Guid.NewGuid(), Guid.NewGuid() };
        if (atProduction) a.Privacy.Rules[a.Emma] = SeriesRule(copyA);
        for (var i = 0; i < 2; i++) a.Rig.View.AddEpisode(copyB, new JfEpisode { ItemId = files[i], Season = 2, Episode = i + 1, DateCreated = a.Rig.Arr.Now.UtcDateTime });
        await a.Step(false, Show);
        a.Rig.Arr.Now += TimeSpan.FromMinutes(11);
        await a.Step(false, Show);
        if (atProduction)
        {
            Assert.DoesNotContain(a.Rig.Inbox(a.Rig.Emma), r => r.Kind == NotifyKind.Episodes);
            await a.Dispatcher.RunOnceAsync(default);
            Assert.False(a.Told("Severance"));
            Assert.Empty(a.Rig.Pushes);
            return;
        }

        var row = Assert.Single(a.Rig.Inbox(a.Rig.Emma), r => r.Kind == NotifyKind.Episodes);
        a.Privacy.Rules[a.Emma] = SeriesRule(copyA);
        await a.Dispatcher.RunOnceAsync(default);
        Assert.False(a.Told("Severance"));
        Assert.False(a.Told("episodes"));
        Assert.Empty(a.Rig.Pushes);
        Assert.Empty(a.Sessions.Sent);
        Assert.All(a.Deliveries(row.Id), d => Assert.Equal("suppressed", d.Status));
        AssertNameless(a.Bell().Items[0]);
    }

    // ------------------------------------------------------------------ each send decided at its own moment (r3 behaviour-1)

    [Fact]
    public async Task EachAlertOfASummaryFallbackIsDecidedRightBeforeItsOwnSend()
    {
        using var a = await Alerts.Start();
        var keys = new[] { "movie:tmdb:11", "movie:tmdb:12", "movie:tmdb:13", "movie:tmdb:14" };
        var names = new[] { "Gone Movie", "First Movie", "Second Movie", "Third Movie" };
        var ids = new List<long>();
        for (var i = 0; i < 4; i++)
        {
            // The first is for a copy the person can't open any more: four due, three go, so they go one by one.
            var item = i == 0 ? Guid.NewGuid() : a.Rig.Arrive(keys[i]);
            var payload = new Dictionary<string, string> { ["type"] = "movie", ["title"] = names[i] };
            ids.Add(a.Rig.NotifyStore.Add(a.Emma, "ready|" + keys[i], NotifyKind.Ready, keys[i], item.ToString("N"), payload, new[] { (NotifyChannel.Ntfy, a.Rig.Arr.Now) }, a.Rig.Arr.Now)!.Value);
        }

        // While the first push is in flight the person hides the other two.
        a.Rig.OnPush = () =>
        {
            a.Privacy.Rules[a.Emma] = new ReadyHides(Array.Empty<Guid>(), Array.Empty<Guid>(), new[] { keys[2], keys[3] });
            return Task.CompletedTask;
        };
        await a.Dispatcher.RunOnceAsync(default);
        var push = Assert.Single(a.Rig.Pushes);
        Assert.Equal("First Movie is ready to watch", (string)push.Body["title"]!);
        Assert.False(a.Told("Second Movie"));
        Assert.False(a.Told("Third Movie"));
        Assert.Equal(new[] { "suppressed", "sent", "suppressed", "suppressed" }, ids.Select(id => Assert.Single(a.Deliveries(id)).Status).ToArray());
    }

    [Fact]
    public async Task TheBellReadsHiddenContentOncePerRequest()
    {
        using var a = await Alerts.Start();
        var loads = 0;
        a.Privacy.OnLoad = _ => loads++;
        for (var i = 0; i < 3; i++)
        {
            var key = "movie:tmdb:2" + i.ToString(System.Globalization.CultureInfo.InvariantCulture);
            var item = a.Rig.Arrive(key);
            a.Rig.NotifyStore.Add(a.Emma, "ready|" + key, NotifyKind.Ready, key, item.ToString("N"), new Dictionary<string, string> { ["title"] = "M" + i.ToString(System.Globalization.CultureInfo.InvariantCulture) }, Array.Empty<(string, DateTimeOffset)>(), a.Rig.Arr.Now);
        }

        loads = 0;
        var (_, items) = a.Bell();
        Assert.Equal(3, items.GetArrayLength());
        Assert.Equal(1, loads);
    }
}
