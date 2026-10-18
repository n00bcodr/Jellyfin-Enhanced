using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Ready;
using Microsoft.Data.Sqlite;

namespace JE.Tests;

/// <summary>
/// Native Ready messages (DisplayMessage) in the durable notification dispatch: the session classifier, then the dispatcher
/// with Jellyfin's sessions in memory. SupportedCommands, no session, another person's, a shared session, no transport,
/// playing, paused, unknown and stale state, busy on another of the person's sessions, the final recheck right before the
/// send, quiet hours, an opt-out or switch-off at delivery, stale overlays after notifications were off, Hidden Content (and
/// rules that can't be read), hidden titles, a summary for several at once, a claim that survives a restart and an unknown
/// outcome, never sent twice, and an unknown channel that never becomes an e-mail.
/// </summary>
public class ReadyMessagesTests
{
    private static readonly DateTime Now = new(2026, 10, 18, 9, 0, 0, DateTimeKind.Utc);

    [Theory]
    [InlineData("eligible", ReadySessionVerdict.Eligible)]
    [InlineData("unsupported", ReadySessionVerdict.Unsupported)]
    [InlineData("nobody", ReadySessionVerdict.WrongUser)]
    [InlineData("other", ReadySessionVerdict.WrongUser)]
    [InlineData("shared", ReadySessionVerdict.Shared)]
    [InlineData("transport", ReadySessionVerdict.NoTransport)]
    [InlineData("playing", ReadySessionVerdict.Playing)]
    [InlineData("paused", ReadySessionVerdict.Paused)]
    [InlineData("unknown", ReadySessionVerdict.Unknown)]
    [InlineData("between", ReadySessionVerdict.Unknown)]
    [InlineData("stale", ReadySessionVerdict.Stale)]
    public void TheClassifierOnlyCallsTheRecipientsOwnIdleSupportedSessionEligible(string state, ReadySessionVerdict expected)
    {
        var me = Guid.NewGuid();
        var s = new ReadySessionSnapshot
        {
            Id = "s", UserId = state switch { "nobody" => Guid.Empty, "other" => Guid.NewGuid(), _ => me },
            SupportsDisplayMessage = state != "unsupported", AdditionalUsers = state == "shared" ? 1 : 0, ActiveTransport = state != "transport",
            Playing = state == "playing", Paused = state == "paused", PlayStateKnown = state != "unknown",
            LastPlaybackEvent = state == "between" ? Now.AddSeconds(-10) : Now.AddHours(-1), LastActivity = state == "stale" ? Now.AddHours(-2) : Now.AddMinutes(-1),
        };
        Assert.Equal(expected, ReadySessionMessages.Classify(s, me, Now));
    }

    internal sealed class World : IDisposable
    {
        public CoreFixture Core { get; } = new();
        public AcquireDatabase Db { get; }
        public NotifyStore Notify { get; }
        public ReadyPlaylistStore Store { get; }
        public FakeReadySessionHost Sessions { get; } = new();
        public FakeReadyPrivacy Privacy { get; } = new();
        public FakeJellyfinView View { get; } = new() { ResolveAnyItem = true };
        public IntegrationNotificationsTests.FakeUsers Users { get; } = new();
        public IntegrationNotificationsTests.FakeMail Mail { get; } = new();
        public PluginConfiguration Config { get; } = new()
        {
            ArrIntegrationEnabled = true, ArrPhase1Enabled = true, ArrPhase2Enabled = true, ArrNotificationsEnabled = true,
            ArrPhase4Enabled = true, ArrPhase4ReadyMessagesEnabled = true,
        };
        public DateTimeOffset At { get; set; } = new(Now);
        public NotifyDispatcher Dispatcher { get; private set; } = null!;
        public StatusViewer Emma { get; }
        public StatusViewer Sam { get; }
        public Guid Movie { get; } = Guid.NewGuid();
        public static readonly TitleKey Sintel = TitleKey.Parse("movie:tmdb:45745")!;

        public World()
        {
            Db = new AcquireDatabase(Path.Combine(Core.Root, AcquireDatabase.FileName));
            Notify = new NotifyStore(Db);
            Store = new ReadyPlaylistStore(Db);
            Emma = View.AddUser(admin: false);
            Sam = View.AddUser(admin: false);
            View.AddItem(new JfItemRef { ItemId = Movie, Kind = "movie", Key = Sintel, Path = "/m/sintel.mkv" });
            View.AddCopy(Sintel, new JfCopy { ItemId = Movie, Path = "/m/sintel.mkv" });
            Prefs(Emma, p => p.NativeReadyMessages = true);
            Restart();
        }

        /// <summary>A restart: a new dispatcher over the same database and sessions.</summary>
        public void Restart()
        {
            Dispatcher?.Dispose();
            var messages = new ReadySessionMessages(Sessions, () => At.UtcDateTime);
            var channel = new ReadyNativeChannel(Store, messages, Privacy, View, null, () => At);
            Dispatcher = new NotifyDispatcher(Notify, new NtfySender(new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response()))), new EmailSender(Mail),
                null, () => Config, () => At, Users, View, null, native: channel);
        }

        public void Prefs(StatusViewer user, Action<NotifyPrefs> change)
        {
            var p = Notify.Prefs(user.UserId);
            change(p);
            Notify.SavePrefs(user.UserId, p, At);
        }

        public long Queue(StatusViewer user, string kind = NotifyKind.Ready, DateTimeOffset? created = null, string channel = NotifyChannel.DisplayMessage, Guid? item = null)
        {
            var payload = new Dictionary<string, string> { ["title"] = "Sintel", ["year"] = "2010" };
            return Notify.Add(user.UserId, kind + "|" + Guid.NewGuid().ToString("N"), kind, Sintel.ToString(), (item ?? Movie).ToString("N"), payload, new[] { (channel, created ?? At) }, created ?? At)!.Value;
        }

        public string? Status(long notification) => Scalar("SELECT status FROM deliveries WHERE notification_id=" + notification) as string;

        public string? Reason(long notification) => Scalar("SELECT last_error FROM deliveries WHERE notification_id=" + notification) as string;

        public object? Scalar(string sql)
        {
            using var c = new SqliteConnection("Data Source=" + Db.FilePath + ";Pooling=False");
            c.Open();
            using var cmd = c.CreateCommand();
            cmd.CommandText = sql;
            return cmd.ExecuteScalar();
        }

        public void Dispose()
        {
            Dispatcher.Dispose();
            Db.Dispose();
            Core.Dispose();
        }
    }

    [Fact]
    public async Task AnIdleSupportedSessionOfTheRecipientGetsExactlyOneMessage()
    {
        using var w = new World();
        w.Sessions.Add(w.Emma.UserId, "tv", Now);
        w.Sessions.Add(w.Emma.UserId, "phone", Now, lastActivity: Now.AddMinutes(-5));
        var n = w.Queue(w.Emma);
        await w.Dispatcher.RunOnceAsync(default);
        var sent = Assert.Single(w.Sessions.Sent);
        Assert.Equal("tv", sent.Session);   // the most recently active one
        Assert.Equal("Sintel is ready to watch", sent.Header);
        Assert.Equal("Sintel (2010) is in the library.", sent.Text);
        Assert.Equal(ReadySessionMessages.DisplayTimeoutMs, sent.Timeout);
        Assert.Equal("sent", w.Status(n));
        Assert.Equal("accepted", w.Scalar("SELECT state FROM ready_message_attempts"));
        Assert.DoesNotContain("tv", (string)w.Scalar("SELECT session FROM ready_message_attempts")!, StringComparison.Ordinal);
        Assert.Equal((1, 0, 0), w.Store.Outcomes(w.Emma.UserId, w.At.AddDays(-1)));
        await w.Dispatcher.RunOnceAsync(default);
        Assert.Single(w.Sessions.Sent);
    }

    [Theory]
    [InlineData("none", "no_session")]
    [InlineData("other", "no_session")]
    [InlineData("unsupported", "unsupported")]
    [InlineData("shared", "shared_session")]
    [InlineData("transport", "no_transport")]
    [InlineData("playing", "busy")]
    [InlineData("paused", "busy")]
    [InlineData("unknown", "unknown_state")]
    [InlineData("stale", "stale_session")]
    [InlineData("busyElsewhere", "busy")]
    public async Task NoEligibleSessionEndsTheMessageWithoutQueueingIt(string setup, string reason)
    {
        using var w = new World();
        switch (setup)
        {
            case "other": w.Sessions.Add(w.Sam.UserId, "sam-tv", Now); break;
            case "unsupported": w.Sessions.Add(w.Emma.UserId, "tv", Now, supports: false); break;
            case "shared": w.Sessions.Add(w.Emma.UserId, "tv", Now, additional: 1); break;
            case "transport": w.Sessions.Add(w.Emma.UserId, "tv", Now, transport: false); break;
            case "playing": w.Sessions.Add(w.Emma.UserId, "tv", Now, playing: true); break;
            case "paused": w.Sessions.Add(w.Emma.UserId, "tv", Now, paused: true); break;
            case "unknown": w.Sessions.Add(w.Emma.UserId, "tv", Now, known: false); break;
            case "stale": w.Sessions.Add(w.Emma.UserId, "tv", Now, lastActivity: Now.AddHours(-3)); break;
            case "busyElsewhere":
                w.Sessions.Add(w.Emma.UserId, "laptop", Now);
                w.Sessions.Add(w.Emma.UserId, "tv", Now, playing: true);
                break;
        }

        var n = w.Queue(w.Emma);
        await w.Dispatcher.RunOnceAsync(default);
        Assert.Empty(w.Sessions.Sent);
        Assert.Equal("suppressed", w.Status(n));
        Assert.Contains(reason, w.Reason(n), StringComparison.Ordinal);
        // Terminal: a session that becomes idle later never gets this surprise.
        w.Sessions.All.Clear();
        w.Sessions.Add(w.Emma.UserId, "tv", Now);
        await w.Dispatcher.RunOnceAsync(default);
        Assert.Empty(w.Sessions.Sent);
    }

    [Fact]
    public async Task TheSessionIsReadAgainRightBeforeTheSend()
    {
        using var w = new World();
        w.Sessions.Add(w.Emma.UserId, "tv", Now);
        w.Sessions.OnReread = id => w.Sessions.Add(w.Emma.UserId, id, Now, playing: true);
        var n = w.Queue(w.Emma);
        await w.Dispatcher.RunOnceAsync(default);
        Assert.Empty(w.Sessions.Sent);
        Assert.Equal("suppressed", w.Status(n));
        Assert.Contains("changed_playing", w.Reason(n), StringComparison.Ordinal);
    }

    [Fact]
    public async Task QuietHoursSilenceTheMessageInsteadOfHoldingIt()
    {
        using var w = new World();
        w.Sessions.Add(w.Emma.UserId, "tv", Now);
        w.Prefs(w.Emma, p => { p.QuietHours = true; p.QuietFrom = "08:00"; p.QuietTo = "10:00"; p.TimeZone = "UTC"; });
        var n = w.Queue(w.Emma);
        await w.Dispatcher.RunOnceAsync(default);
        Assert.Empty(w.Sessions.Sent);
        Assert.Equal("suppressed", w.Status(n));
        w.At = w.At.AddHours(3);
        await w.Dispatcher.RunOnceAsync(default);
        Assert.Empty(w.Sessions.Sent);
    }

    [Theory]
    [InlineData("optOut")]
    [InlineData("switch")]
    [InlineData("phase4")]
    [InlineData("kind")]
    [InlineData("gone")]
    [InlineData("access")]
    public async Task AnOptOutSwitchOffOrLostAccessAtDeliveryEndsIt(string change)
    {
        using var w = new World();
        w.Sessions.Add(w.Emma.UserId, "tv", Now);
        var n = w.Queue(w.Emma);
        switch (change)
        {
            case "optOut": w.Prefs(w.Emma, p => p.NativeReadyMessages = false); break;
            case "switch": w.Config.ArrPhase4ReadyMessagesEnabled = false; break;
            case "phase4": w.Config.ArrPhase4Enabled = false; break;
            case "kind": w.Prefs(w.Emma, p => p.Ready = false); break;
            case "gone": w.Users.Gone.Add(w.Emma.UserId); break;
            case "access": w.View.Items[w.Movie] = w.View.Items[w.Movie] with { VisibleTo = new HashSet<Guid> { w.Sam.UserId } }; break;
        }

        await w.Dispatcher.RunOnceAsync(default);
        Assert.Empty(w.Sessions.Sent);
        Assert.Equal("suppressed", w.Status(n));
    }

    [Fact]
    public async Task AnOptOutBetweenTheChecksAndTheSendStillWins()
    {
        using var w = new World();
        w.Sessions.Add(w.Emma.UserId, "tv", Now);
        w.Sessions.OnReread = _ => w.Prefs(w.Emma, p => p.NativeReadyMessages = false);
        var n = w.Queue(w.Emma);
        await w.Dispatcher.RunOnceAsync(default);
        Assert.Empty(w.Sessions.Sent);
        Assert.Equal("suppressed", w.Status(n));
    }

    [Fact]
    public async Task MessagesQueuedWhileNotificationsWereOffNeverPopUpLater()
    {
        using var w = new World();
        w.Sessions.Add(w.Emma.UserId, "tv", Now);
        w.Config.ArrNotificationsEnabled = false;
        var n = w.Queue(w.Emma);
        await w.Dispatcher.RunOnceAsync(default);
        Assert.Equal("pending", w.Status(n));
        w.At = w.At.AddHours(2);
        w.Config.ArrNotificationsEnabled = true;
        await w.Dispatcher.RunOnceAsync(default);
        Assert.Empty(w.Sessions.Sent);
        Assert.Equal("suppressed", w.Status(n));
        Assert.Contains("stale", w.Reason(n), StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task AHiddenTitleOrRulesThatCantBeReadSilenceIt(bool unreadable)
    {
        using var w = new World();
        w.Sessions.Add(w.Emma.UserId, "tv", Now);
        w.Privacy.Rules[w.Emma.UserId] = unreadable ? null : new ReadyHides(Array.Empty<Guid>(), Array.Empty<Guid>(), new[] { "movie:tmdb:45745" });
        var n = w.Queue(w.Emma);
        await w.Dispatcher.RunOnceAsync(default);
        Assert.Empty(w.Sessions.Sent);
        Assert.Equal("suppressed", w.Status(n));
    }

    [Fact]
    public async Task HideTitlesKeepsTheTitleOutOfHeaderAndText()
    {
        using var w = new World();
        w.Sessions.Add(w.Emma.UserId, "tv", Now);
        w.Prefs(w.Emma, p => p.HideTitles = true);
        w.Queue(w.Emma);
        await w.Dispatcher.RunOnceAsync(default);
        var sent = Assert.Single(w.Sessions.Sent);
        Assert.DoesNotContain("Sintel", sent.Header + sent.Text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task SeveralAtOnceBecomeOneSummaryMessage()
    {
        using var w = new World();
        w.Sessions.Add(w.Emma.UserId, "tv", Now);
        var ids = Enumerable.Range(0, 5).Select(_ => w.Queue(w.Emma)).ToList();
        await w.Dispatcher.RunOnceAsync(default);
        var sent = Assert.Single(w.Sessions.Sent);
        Assert.StartsWith("5 ", sent.Header, StringComparison.Ordinal);
        Assert.DoesNotContain("Sintel", sent.Header + sent.Text, StringComparison.Ordinal);
        Assert.All(ids, id => Assert.Equal("sent", w.Status(id)));
    }

    [Fact]
    public async Task AClaimWithNoOutcomeAfterARestartIsNeverSentAgain()
    {
        using var w = new World();
        w.Sessions.Add(w.Emma.UserId, "tv", Now);
        var n = w.Queue(w.Emma);
        var delivery = Convert.ToInt64(w.Scalar("SELECT id FROM deliveries WHERE notification_id=" + n));
        // The server stopped right after the claim, before the command's outcome was recorded.
        Assert.True(w.Store.Claim(w.Db.Generation, delivery, w.Emma.UserId, "abc", w.At));
        w.Restart();
        await w.Dispatcher.RunOnceAsync(default);
        Assert.Empty(w.Sessions.Sent);
        Assert.Equal("suppressed", w.Status(n));
    }

    [Fact]
    public async Task ASendWhoseOutcomeIsUnknownIsRecordedAndNeverRetried()
    {
        using var w = new World();
        w.Sessions.Add(w.Emma.UserId, "tv", Now);
        w.Sessions.OnSend = _ => throw new IOException("socket closed mid-send");
        var n = w.Queue(w.Emma);
        await w.Dispatcher.RunOnceAsync(default);
        Assert.Equal("suppressed", w.Status(n));
        Assert.Equal("unknown", w.Scalar("SELECT state FROM ready_message_attempts"));
        w.Sessions.OnSend = null;
        w.Restart();
        await w.Dispatcher.RunOnceAsync(default);
        Assert.Empty(w.Sessions.Sent);
        Assert.Equal((0, 1, 1), w.Store.Outcomes(w.Emma.UserId, w.At.AddDays(-1)));
    }

    [Fact]
    public async Task ADuplicateEventIsOneNotificationAndOneMessage()
    {
        using var w = new World();
        w.Sessions.Add(w.Emma.UserId, "tv", Now);
        var payload = new Dictionary<string, string> { ["title"] = "Sintel" };
        Assert.NotNull(w.Notify.Add(w.Emma.UserId, "ready|same", NotifyKind.Ready, World.Sintel.ToString(), w.Movie.ToString("N"), payload, new[] { (NotifyChannel.DisplayMessage, w.At) }, w.At));
        w.Restart();
        Assert.Null(w.Notify.Add(w.Emma.UserId, "ready|same", NotifyKind.Ready, World.Sintel.ToString(), w.Movie.ToString("N"), payload, new[] { (NotifyChannel.DisplayMessage, w.At) }, w.At));
        await w.Dispatcher.RunOnceAsync(default);
        await w.Dispatcher.RunOnceAsync(default);
        Assert.Single(w.Sessions.Sent);
    }

    [Fact]
    public async Task AnUnknownChannelIsNeverSentAsAnEmail()
    {
        using var w = new World();
        var n = w.Queue(w.Emma, channel: "carrier-pigeon");
        await w.Dispatcher.RunOnceAsync(default);
        Assert.Empty(w.Mail.Sent);
        Assert.Equal("suppressed", w.Status(n));
    }

    [Fact]
    public async Task ARestoreWhileAMessageIsOnItsWayLeavesTheRestoredRowsAlone()
    {
        using var w = new World();
        w.Sessions.Add(w.Emma.UserId, "tv", Now);
        var n = w.Queue(w.Emma);
        var backup = w.Db.Snapshot()!;
        w.Sessions.OnSend = _ =>
        {
            w.Db.ReplaceWith(backup);
            return Task.CompletedTask;
        };
        await w.Dispatcher.RunOnceAsync(default);
        // The restored database's copy of the delivery is the backup's (its message already died by the restore policy).
        Assert.Equal("suppressed", w.Status(n));
        Assert.Null(w.Scalar("SELECT state FROM ready_message_attempts"));
    }
}

/// <summary>Native Ready messages from the notification producers, next to ntfy and e-mail (the Phase-2 rig).</summary>
[Collection("Plugin singleton")]
public class ReadyMessagesDraftTests
{
    [Fact]
    public async Task AReadyNotificationGetsANativeMessageOnlyWithBothSwitchesAndTheConsentAndPhoneAndMailStillGoOut()
    {
        using var rig = new IntegrationNotificationsTests.Rig();
        rig.Phones(rig.Emma);
        var movie = rig.Arrive("movie:tmdb:693134");
        var payload = new Dictionary<string, string> { ["title"] = "Dune: Part Two" };

        // Consent but no switch: no native delivery.
        rig.Prefs(rig.Emma, p => p.NativeReadyMessages = true);
        Assert.True(rig.Service.Notify(rig.Emma.UserId, NotifyKind.Ready, "ready|a", "movie:tmdb:693134", movie, payload, rig.Arr.Now, null));
        Assert.Equal(0L, Count(rig, NotifyChannel.DisplayMessage));

        rig.Config.ArrPhase4Enabled = true;
        rig.Config.ArrPhase4ReadyMessagesEnabled = true;
        // Switch on but no consent (missing means off): none.
        rig.Prefs(rig.Sam, p => p.Ready = true);
        Assert.True(rig.Service.Notify(rig.Sam.UserId, NotifyKind.Ready, "ready|b", "movie:tmdb:693134", movie, payload, rig.Arr.Now, null));
        Assert.Equal(0L, Count(rig, NotifyChannel.DisplayMessage));

        // Both: one native delivery next to ntfy and e-mail; not for a kind that isn't about something being ready.
        Assert.True(rig.Service.Notify(rig.Emma.UserId, NotifyKind.Ready, "ready|c", "movie:tmdb:693134", movie, payload, rig.Arr.Now, null));
        Assert.True(rig.Service.Notify(rig.Emma.UserId, NotifyKind.Declined, "declined|d", "movie:tmdb:693134", null, payload, rig.Arr.Now, null));
        Assert.Equal(1L, Count(rig, NotifyChannel.DisplayMessage));

        // No session (the app is closed): the native message ends, the phone push and the e-mail are sent.
        var sessions = new FakeReadySessionHost();
        var channel = new ReadyNativeChannel(new ReadyPlaylistStore(rig.Db), new ReadySessionMessages(sessions, () => rig.Arr.Now.UtcDateTime), new FakeReadyPrivacy(), rig.View, null, () => rig.Arr.Now);
        using var dispatcher = new NotifyDispatcher(rig.NotifyStore, new NtfySender(rig.Ntfy), new EmailSender(rig.Mail), null, () => rig.Config, () => rig.Arr.Now, rig.Users, rig.View, rig.Status.Aliases, native: channel);
        await dispatcher.RunOnceAsync(default);
        Assert.Empty(sessions.Sent);
        Assert.Contains(rig.Pushes, p => p.Body["title"]!.ToString().Contains("Dune", StringComparison.Ordinal));
        Assert.Contains(rig.Mail.Sent, m => m.Subject.Contains("Dune", StringComparison.Ordinal));
    }

    private static long Count(IntegrationNotificationsTests.Rig rig, string channel)
    {
        using var c = new SqliteConnection("Data Source=" + rig.Db.FilePath + ";Pooling=False");
        c.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM deliveries WHERE channel=$c";
        cmd.Parameters.AddWithValue("$c", channel);
        return (long)cmd.ExecuteScalar()!;
    }
}
