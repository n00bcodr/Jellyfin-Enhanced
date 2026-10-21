using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Ready;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Playlists;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.Sqlite;
using Moq;

namespace JE.Tests;

/// <summary>
/// 4f review round 4 (D53): every ownership and privacy decision reads its evidence EXACT, COMPLETE and CURRENT, or refuses.
/// <list type="bullet">
/// <item><description>Exact: a Ready playlist is JE's only at exactly the creation time Jellyfin stored for JE's own create
/// (both hosts keep it to the whole second); a replacement stored in any other second is never stamped, written or deleted.
/// Round 6: the same stored second is refused too (the nonce comes with the create itself).</description></item>
/// <item><description>Complete: a privacy decision sees every physical copy of the title (no display cap); when that can't
/// be established it fails closed (alerts wait, the playlist leaves the title out).</description></item>
/// <item><description>Current: the last check before a membership write reads the title's copies and the rules again.</description></item>
/// <item><description>Declined and Approved, told to the requester about their own title, get the same alert decision.</description></item>
/// </list>
/// </summary>
[Collection("Plugin singleton")]
public class ReadyExactEvidenceTests
{
    private const string Dune = "movie:tmdb:693134";
    private const string Severance = "tv:tvdb:371980";
    private static readonly TitleKey Sintel = TitleKey.Parse("movie:tmdb:45745")!;
    private static readonly DateTime Arrived = ReadyWorld.Since.AddDays(2);

    private static ReadyHides TitleRule(string key) => new(Array.Empty<Guid>(), Array.Empty<Guid>(), new[] { key });

    private static ReadyHides ItemRule(Guid item) => new(new[] { item }, Array.Empty<Guid>(), Array.Empty<string>(), new[] { item });

    // Copies that sort after any random id (Jellyfin's query order here): the last of them is past a cap of 20.
    private static Guid Extra(int i) => new($"ffffff{i:x2}-0000-0000-0000-{i:x12}");

    // ================================================================== EXACT: ownership at the stored creation time

    [Theory]
    [InlineData(0, 1000, false)]   // security-1: the replacement one second later
    [InlineData(900, 1100, false)] // the probed boundary: 0.2 s later, but stored in the next second
    [InlineData(900, 1100, true)]  // ... with both creation times still holding their fraction (before Jellyfin's refresh)
    public async Task AReplacementStoredInAnotherSecondIsNeverStampedBoundOrWritten(int createdAtMs, int replacedAtMs, bool fraction)
    {
        using var w = new ReadyWorld();
        w.Host.KeepFraction = fraction;
        var start = w.Now;
        w.Now = start.AddMilliseconds(createdAtMs);
        var emma = w.User();
        var (_, versions) = w.Movie(Sintel, Arrived);
        w.Interests.Add(emma.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        await w.Service.SetPlaylistAsync(emma.UserId, true);
        // Between Jellyfin's create returning and JE's first read, the person deletes JE's playlist and makes their own, empty
        // and private, under the same folder name: Jellyfin gives it the same id and its own creation time.
        FakeReadyPlaylistHost.Native? own = null;
        w.Host.During = call =>
        {
            if (call != "created" || own != null) return;
            var made = Assert.Single(w.Host.Playlists.Values);
            w.Host.Playlists.Remove(made.Id);
            w.Now = start.AddMilliseconds(replacedAtMs);
            own = w.Host.AddOwn(emma.UserId, made.Name);
            Assert.Equal(made.Id, own.Id);
            Assert.NotEqual(made.Created, own.Created);
        };
        Assert.Equal("lost", await w.Service.ReconcileAsync(emma.UserId));
        w.Host.During = null;
        Assert.Null(own!.Nonce);
        Assert.Null(w.Store.Binding(ReadyWorld.Server, emma.UserId)!.PlaylistId);
        Assert.Equal("nothing", await w.Service.RemoveAsync(emma.UserId));

        // Turned on again: another playlist of JE's; the person's stays as it is.
        w.Now = w.Now.AddMinutes(5);
        await w.Service.SetPlaylistAsync(emma.UserId, true);
        Assert.Equal("updated", await w.Service.ReconcileAsync(emma.UserId));
        var fresh = w.Store.Binding(ReadyWorld.Server, emma.UserId)!.PlaylistId!.Value;
        Assert.NotEqual(own.Id, fresh);
        Assert.Equal(new[] { versions[0] }, w.Host.Playlists[fresh].Entries);
        Assert.Null(own.Nonce);
        Assert.Empty(own.Entries);
        Assert.DoesNotContain(w.Host.Sets, s => s.Playlist == own.Id);
        Assert.Equal("removed", await w.Service.RemoveAsync(emma.UserId));
        Assert.True(w.Host.Playlists.ContainsKey(own.Id));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AReplacementStoredInTheSameSecondIsRefusedToo(bool fraction)
    {
        // Round 5's stated limit (a delete-and-remake inside the same stored second) is closed by provenance at the create
        // (4f round 6): the replacement never carries the nonce JE's create wrote into its own playlist.
        using var w = new ReadyWorld();
        w.Host.KeepFraction = fraction;
        var start = w.Now;
        w.Now = start.AddMilliseconds(100);
        var emma = w.User();
        w.Movie(Sintel, Arrived);
        w.Interests.Add(emma.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        await w.Service.SetPlaylistAsync(emma.UserId, true);
        FakeReadyPlaylistHost.Native? own = null;
        w.Host.During = call =>
        {
            if (call != "created" || own != null) return;
            var made = Assert.Single(w.Host.Playlists.Values);
            w.Host.Playlists.Remove(made.Id);
            w.Now = start.AddMilliseconds(800);
            own = w.Host.AddOwn(emma.UserId, made.Name);
            Assert.Equal(made.Created.ToUnixTimeSeconds(), own.Created.ToUnixTimeSeconds());
        };
        Assert.Equal("lost", await w.Service.ReconcileAsync(emma.UserId));
        Assert.Null(own!.Nonce);
        Assert.Null(w.Store.Binding(ReadyWorld.Server, emma.UserId)!.PlaylistId);
    }

    [Theory]
    [InlineData(0, 0, true)]
    [InlineData(640, 0, true)]     // the same second with its fraction (a save of the instance the create made)
    [InlineData(0, 640, true)]     // a binding an earlier version recorded with the fraction, the time now stored to the second
    [InlineData(999, 0, true)]
    [InlineData(-1, 0, false)]     // the second before
    [InlineData(-999, 0, false)]
    [InlineData(1000, 0, false)]   // the second after
    [InlineData(1000, 640, false)]
    public void APlaylistCarriesTheBindingOnlyInExactlyItsStoredCreationSecond(int storedOffsetMs, int boundOffsetMs, bool carries)
    {
        var second = new DateTimeOffset(2026, 10, 18, 9, 0, 0, TimeSpan.Zero);
        var info = new ReadyPlaylistInfo(Guid.NewGuid(), Guid.NewGuid(), false, 0, "Ready to watch (m)", "Ready to watch", second.AddMilliseconds(storedOffsetMs), "n0nce");
        Assert.Equal(carries, info.Carries("n0nce", second.AddMilliseconds(boundOffsetMs).ToUnixTimeMilliseconds()));
        Assert.False(info.Carries("other", second.ToUnixTimeMilliseconds()));
    }

    [Fact]
    public async Task ABoundPlaylistWhoseStoredCreationTimeIsNotTheBindingsIsNeverWrittenOrDeleted()
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        w.Movie(Sintel, Arrived);
        w.Interests.Add(emma.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        await w.Service.SetPlaylistAsync(emma.UserId, true);
        Assert.Equal("updated", await w.Service.ReconcileAsync(emma.UserId));
        var bound = Assert.Single(w.Host.Playlists.Values);
        // The same id and nonce, but stored in another second (the one before; a nonce can't move to another playlist, so this
        // pins the identity rule itself): not the playlist JE bound.
        var other = new FakeReadyPlaylistHost.Native { Id = bound.Id, Owner = bound.Owner, Folder = bound.Folder, Name = bound.Name, Created = bound.Created.AddMilliseconds(-1), Nonce = bound.Nonce };
        other.Entries.AddRange(bound.Entries);
        w.Host.Playlists[bound.Id] = other;
        var sets = w.Host.Sets.Count;
        // Something new to write: another title the person asked for arrives.
        var bunny = TitleKey.Parse("movie:tmdb:10378")!;
        w.Movie(bunny, Arrived.AddHours(1));
        w.Interests.Add(emma.UserId, "w:2", ReadyInterestKind.Request, bunny);
        w.Now = w.Now.AddMinutes(1);
        Assert.Equal("lost", await w.Service.ReconcileAsync(emma.UserId));
        Assert.Equal(sets, w.Host.Sets.Count);
        await w.Service.RemoveAsync(emma.UserId);
        Assert.True(w.Host.Playlists.ContainsKey(bound.Id));
        Assert.DoesNotContain(w.Host.Gates, g => g.Call == "delete" && g.Refused == null);
    }

    [Theory]
    [InlineData("before-stamp")]
    [InlineData("after-bind")]
    public async Task JesOwnPlaylistStaysJesWhenJellyfinStoresItsCreationTimeAgainToTheSecond(string when)
    {
        // Probed live (12.2 and 10.11.11): a new playlist is first saved with a fraction of a second, then Jellyfin's refresh
        // stores it again from playlist.xml to the whole second, and a save of the instance the create made can bring the
        // fraction back. Both are the same stored second: JE's own playlist stays JE's.
        using var w = new ReadyWorld();
        w.Host.KeepFraction = true;
        w.Now = w.Now.AddMilliseconds(640);
        var emma = w.User();
        var (_, versions) = w.Movie(Sintel, Arrived);
        w.Interests.Add(emma.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        await w.Service.SetPlaylistAsync(emma.UserId, true);
        if (when == "before-stamp")
        {
            var refreshed = false;
            w.Host.During = call =>
            {
                if (call != "stamp" || refreshed) return;
                refreshed = true;
                w.Host.Refresh(Assert.Single(w.Host.Playlists.Values).Id);
            };
        }

        Assert.Equal("updated", await w.Service.ReconcileAsync(emma.UserId));
        w.Host.During = null;
        var mine = Assert.Single(w.Host.Playlists.Values);
        Assert.NotNull(mine.Nonce);
        Assert.Equal(mine.Id, w.Store.Binding(ReadyWorld.Server, emma.UserId)!.PlaylistId);
        Assert.Equal(new[] { versions[0] }, mine.Entries);

        // Later Jellyfin's refresh stores it to the second, then a save of the created instance brings the fraction back:
        // writes and the removal still go ahead.
        w.Host.Refresh(mine.Id);
        var bunny = TitleKey.Parse("movie:tmdb:10378")!;
        var (_, more) = w.Movie(bunny, Arrived.AddHours(1));
        w.Interests.Add(emma.UserId, "w:2", ReadyInterestKind.Request, bunny);
        w.Now = w.Now.AddMinutes(1);
        Assert.Equal("updated", await w.Service.ReconcileAsync(emma.UserId));
        Assert.Contains(more[0], mine.Entries);
        mine.Created = mine.Created.AddMilliseconds(640);
        Assert.Equal("removed", await w.Service.RemoveAsync(emma.UserId));
        Assert.Empty(w.Host.Playlists);
    }

    [Fact]
    public async Task TheHostsSecondReadAcceptsTheSameCreationSecondInEitherForm()
    {
        // Between the gate's read and the healed save Jellyfin's refresh stores the creation time again to the second: the
        // same playlist (the write goes ahead); a time in another second is not.
        var id = Guid.NewGuid();
        var owner = Guid.NewGuid();
        var fraction = new DateTime(2026, 10, 18, 9, 0, 0, 640, DateTimeKind.Utc);
        Playlist Make(DateTime created) => new()
        {
            Id = id, Name = ReadyPlaylistService.PlaylistName, OwnerUserId = owner, Path = "/config/data/playlists/Ready to watch (m)",
            DateCreated = created, ExternalId = JellyfinReadyPlaylistHost.NoncePrefix + "n0nce", Shares = Array.Empty<PlaylistUserPermissions>(),
        };
        ReadyGate gate = stored => stored == null ? "missing" : null;
        foreach (var (after, written) in new[] { (fraction.AddMilliseconds(-640), true), (fraction.AddMilliseconds(360), false) })
        {
            var library = new Mock<ILibraryManager>();
            library.SetupSequence(l => l.RetrieveItem(id)).Returns(Make(fraction)).Returns(Make(after));
            library.Setup(l => l.GetItemById(id)).Returns(Make(fraction));
            var playlists = new Mock<IPlaylistManager>();
            var host = new JellyfinReadyPlaylistHost(library.Object, playlists.Object, Mock.Of<MediaBrowser.Model.IO.IFileSystem>());
            Assert.Equal(written ? null : "identity", await host.SetAsync(id, new[] { Guid.NewGuid() }, owner, gate));
            playlists.Verify(p => p.UpdatePlaylist(It.IsAny<PlaylistUpdateRequest>()), written ? Times.Once() : Times.Never());
        }
    }

    // ================================================================== COMPLETE: every physical copy

    [Fact]
    public void TheCompleteCopyLookupReadsEveryCopyPastTheDisplayCapAndFailsClosed()
    {
        var view = new FakeJellyfinView();
        var key = TitleKey.Parse(Dune)!;
        for (var i = 0; i < 45; i++) view.AddCopy(key, new JfCopy { ItemId = Extra(i), Path = "/m/" + i });
        var failing = false;
        using var production = FakeJellyfinLibrary.Over(view, () => failing);
        // Display uses keep their cap (presentation only: past it the lookup is incomplete); the privacy lookup is complete.
        var shown = production.Copies(key, StatusViewer.Library);
        Assert.Equal(20, shown.Seen.Count);
        Assert.False(shown.IsComplete);
        var all = production.TitleCopyIds(key);
        Assert.NotNull(all);
        Assert.Equal(Enumerable.Range(0, 45).Select(Extra).OrderBy(g => g), all!.OrderBy(g => g));
        // An alias of the same kind under another provider is read too.
        var imdb = TitleKey.Parse("movie:imdb:tt15239678")!;
        view.AddCopy(imdb, new JfCopy { ItemId = Extra(99), Path = "/m/99" });
        Assert.Contains(Extra(99), production.TitleCopyIds(key, new[] { imdb })!);
        // A query that fails: completeness unknown.
        failing = true;
        Assert.Null(production.TitleCopyIds(key));
    }

    private sealed class Alerts : IDisposable
    {
        public IntegrationNotificationsTests.Rig Rig { get; }
        public FakeReadyPrivacy Privacy { get; } = new();
        public FakeReadySessionHost Sessions { get; } = new();
        public NotifyDispatcher Dispatcher { get; }
        public NotificationService Service { get; }

        public Alerts(IntegrationNotificationsTests.Rig rig, RequestLedger? ledger = null, Func<IEnumerable<string>, StatusViewer, CancellationToken, Task<Dictionary<string, HubTitleMeta>>>? meta = null)
        {
            Rig = rig;
            rig.Config.ArrPhase4Enabled = true;
            rig.Config.ArrPhase4ReadyMessagesEnabled = true;
            rig.Phones(rig.Emma, rig.Kid);
            rig.Prefs(rig.Emma, p => p.NativeReadyMessages = true);
            Sessions.Add(rig.Emma.UserId, "tv", rig.Arr.Now.UtcDateTime);
            var channel = new ReadyNativeChannel(new ReadyPlaylistStore(rig.Db), new ReadySessionMessages(Sessions, () => rig.Arr.Now.UtcDateTime), Privacy, rig.View, null, () => rig.Arr.Now);
            Dispatcher = new NotifyDispatcher(rig.NotifyStore, new NtfySender(rig.Ntfy), new EmailSender(rig.Mail), null, () => rig.Config, () => rig.Arr.Now, rig.Users, rig.View, rig.Status.Aliases, ledger, native: channel);
            Service = ledger == null
                ? new NotificationService(rig.NotifyStore, rig.Status, rig.Requests, rig.View, rig.Feed, rig.Store, rig.Users, Dispatcher, null, null, () => rig.Config, () => rig.Arr.Now, rig.Hub, rig.Bridge)
                : new NotificationService(rig.NotifyStore, rig.Status, rig.Requests, rig.View, rig.Feed, rig.Store, rig.Users, Dispatcher, null, null, () => rig.Config, () => rig.Arr.Now, rig.Hub, rig.Bridge, ledger, meta);
        }

        public Guid Emma => Rig.Emma.UserId;

        public async Task Step(bool send, params string[] keys)
        {
            await Rig.Requests.RefreshAsync(default);
            await Service.TickAsync(default);
            if (keys.Length > 0) await Service.EvaluateAsync(keys, null, default);
            Service.FlushBatches(Rig.Arr.Now);
            if (send) await Dispatcher.RunOnceAsync(default);
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

        public (int Unread, JsonElement Items) Bell(Guid user)
        {
            var controller = new NotifyController(Rig.Service, Dispatcher, new NtfySender(Rig.Ntfy), new EmailSender(Rig.Mail), Rig.Users)
            {
                ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
                Config = () => Rig.Config,
                Now = () => Rig.Arr.Now,
            };
            controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", user.ToString())], "test"));
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

    private static void AssertNameless(JsonElement row)
    {
        Assert.Equal(JsonValueKind.Null, row.GetProperty("key").ValueKind);
        Assert.Equal(JsonValueKind.Null, row.GetProperty("itemId").ValueKind);
        Assert.False(row.GetProperty("params").TryGetProperty("title", out _));
    }

    // Twenty more physical copies of Dune (another library each), after the one that arrived: 21 in all.
    private static Guid TwentyMoreCopies(Alerts a)
    {
        for (var i = 0; i < 20; i++)
            a.Rig.View.AddCopy(TitleKey.Parse(Dune)!, new JfCopy { ItemId = Extra(i), Path = "/lib" + i + "/dune", LibraryName = "Library " + i, DateCreated = a.Rig.Arr.Now.UtcDateTime });
        a.Rig.View.Rev++;
        return Extra(19);
    }

    [Theory]
    [InlineData("last")]
    [InlineData("first")]
    [InlineData("none")]
    public async Task ARuleOnTheLastOfTwentyOneCopiesMakesNoReadyAlertOnAnyChannel(string rule)
    {
        using var a = new Alerts(await IntegrationNotificationsTests.Started(r => r.Request(1, 693134, r.Emma)));
        a.Rig.View.Production = FakeJellyfinLibrary.Over(a.Rig.View);
        var item = a.Rig.Arrive(Dune, a.Emma, a.Rig.Sam.UserId);
        var last = TwentyMoreCopies(a);
        a.Privacy.Rules[a.Emma] = rule switch
        {
            "last" => ItemRule(last),
            "first" => ItemRule(item),
            _ => ItemRule(Guid.NewGuid()),
        };
        await a.Step(true, Dune);

        if (rule == "none")
        {
            // Twenty-one copies are past the copy lookup's budget (edition round 21): the lookup is incomplete, so nothing is
            // remembered or told from it (looked at again), whatever the rules say.
            Assert.DoesNotContain(a.Rig.Inbox(a.Rig.Emma), r => r.Kind == NotifyKind.Ready);
            Assert.False(a.Told("Dune"));
            return;
        }

        Assert.DoesNotContain(a.Rig.Inbox(a.Rig.Emma), r => r.Kind == NotifyKind.Ready);
        Assert.Empty(a.Rig.Pushes);
        Assert.Empty(a.Rig.Mail.Sent);
        Assert.Empty(a.Sessions.Sent);
        Assert.Equal(0, a.Bell(a.Emma).Unread);
    }

    [Fact]
    public async Task ARuleOnTheLastOfTwentyOneCopiesMadeAfterTheAlertIsSuppressedAtEverySend()
    {
        using var a = new Alerts(await IntegrationNotificationsTests.Started(r => r.Request(1, 693134, r.Emma)));
        a.Rig.View.Production = FakeJellyfinLibrary.Over(a.Rig.View);
        a.Rig.Arrive(Dune, a.Emma, a.Rig.Sam.UserId);
        await a.Step(false, Dune);
        var row = Assert.Single(a.Rig.Inbox(a.Rig.Emma), r => r.Kind == NotifyKind.Ready);
        Assert.Equal(3, a.Deliveries(row.Id).Count);

        a.Privacy.Rules[a.Emma] = ItemRule(TwentyMoreCopies(a));
        await a.Dispatcher.RunOnceAsync(default);
        Assert.False(a.Told("Dune"));
        Assert.All(a.Deliveries(row.Id), d => Assert.Equal("suppressed", d.Status));
        AssertNameless(Assert.Single(a.Bell(a.Emma).Items.EnumerateArray()));
    }

    [Fact]
    public async Task WhenEveryCopyCantBeEstablishedAReadyAlertWaitsOnEveryChannel()
    {
        using var a = new Alerts(await IntegrationNotificationsTests.Started(r => r.Request(1, 693134, r.Emma)));
        // Some rule exists (on something else), so the title's copies matter; the complete lookup can't be made now.
        a.Privacy.Rules[a.Emma] = ItemRule(Guid.NewGuid());
        a.Rig.Arrive(Dune, a.Emma, a.Rig.Sam.UserId);
        a.Rig.View.CopiesUnknown = true;
        await a.Step(true, Dune);
        Assert.DoesNotContain(a.Rig.Inbox(a.Rig.Emma), r => r.Kind == NotifyKind.Ready);
        Assert.False(a.Told("Dune"));

        // Known again: told once, on every channel.
        a.Rig.View.CopiesUnknown = false;
        await a.Step(true, Dune);
        Assert.Single(a.Rig.Inbox(a.Rig.Emma), r => r.Kind == NotifyKind.Ready);
        Assert.True(a.Told("Dune"));
    }

    [Fact]
    public async Task WhenEveryCopyCantBeEstablishedAQueuedAlertIsHeldAndTheBellNamesNothing()
    {
        using var a = new Alerts(await IntegrationNotificationsTests.Started(r => r.Request(1, 693134, r.Emma)));
        a.Privacy.Rules[a.Emma] = ItemRule(Guid.NewGuid());
        a.Rig.Arrive(Dune, a.Emma, a.Rig.Sam.UserId);
        await a.Step(false, Dune);
        var row = Assert.Single(a.Rig.Inbox(a.Rig.Emma), r => r.Kind == NotifyKind.Ready);
        a.Rig.View.CopiesUnknown = true;
        await a.Dispatcher.RunOnceAsync(default);
        Assert.False(a.Told("Dune"));
        Assert.DoesNotContain(a.Deliveries(row.Id), d => d.Status == "sent");
        AssertNameless(Assert.Single(a.Bell(a.Emma).Items.EnumerateArray()));
    }

    [Theory]
    [InlineData("last")]
    [InlineData("first")]
    [InlineData("none")]
    public async Task ARuleOnTheLastOfTwentyOneCopiesLeavesTheTitleOutOfTheReadyPlaylist(string rule)
    {
        using var w = new ReadyWorld();
        w.View.Production = FakeJellyfinLibrary.Over(w.View);
        var emma = w.User();
        var (item, versions) = w.Movie(Sintel, Arrived);
        for (var i = 0; i < 20; i++) w.View.AddCopy(Sintel, new JfCopy { ItemId = Extra(i), Path = "/lib" + i + "/sintel", DateCreated = Arrived });
        w.Interests.Add(emma.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        w.Privacy.Rules[emma.UserId] = rule switch
        {
            "last" => ItemRule(Extra(19)),
            "first" => ItemRule(item),
            _ => ItemRule(Guid.NewGuid()),
        };
        await w.Service.SetPlaylistAsync(emma.UserId, true);
        await w.Service.ReconcileAsync(emma.UserId);
        var playlist = Assert.Single(w.Host.Playlists.Values);
        // Twenty-one copies are past the copy lookup's budget (edition round 21): an incomplete lookup never makes anything
        // Ready, so the title stays out with or without a rule.
        _ = versions;
        Assert.Empty(playlist.Entries);
    }

    [Fact]
    public async Task WhenEveryCopyCantBeEstablishedTheTitleStaysOutOfTheReadyPlaylist()
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        var (_, versions) = w.Movie(Sintel, Arrived);
        w.Interests.Add(emma.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        w.Privacy.Rules[emma.UserId] = ItemRule(Guid.NewGuid());
        w.View.CopiesUnknown = true;
        await w.Service.SetPlaylistAsync(emma.UserId, true);
        await w.Service.ReconcileAsync(emma.UserId);
        Assert.DoesNotContain(w.Host.Sets, s => s.Items.Contains(versions[0]));

        w.View.CopiesUnknown = false;
        w.Now = w.Now.AddMinutes(1);
        await w.Service.ReconcileAsync(emma.UserId);
        Assert.Equal(new[] { versions[0] }, Assert.Single(w.Host.Playlists.Values).Entries);
    }

    // ================================================================== CURRENT: the last check before the write

    [Fact]
    public async Task ACopyThatAppearsWithAWholeTitleHideBeforeTheWriteIsNeverInserted()
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        var (_, versions) = w.Movie(Sintel, Arrived);
        w.Interests.Add(emma.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        await w.Service.SetPlaylistAsync(emma.UserId, true);
        // After the selection chose copy A, right before the membership write: copy B arrives in another library and the
        // person hides the movie on it (a title-level rule).
        var copyB = Guid.NewGuid();
        var done = false;
        w.Host.During = call =>
        {
            if (call != "set" || done) return;
            done = true;
            w.View.AddCopy(Sintel, new JfCopy { ItemId = copyB, Path = "/kids/sintel", DateCreated = Arrived });
            w.Privacy.Rules[emma.UserId] = ItemRule(copyB);
        };
        await w.Service.ReconcileAsync(emma.UserId);
        Assert.True(done);
        Assert.DoesNotContain(w.Host.Sets, s => s.Items.Contains(versions[0]));
        Assert.Empty(Assert.Single(w.Host.Playlists.Values).Entries);
    }

    [Fact]
    public async Task WithNothingChangedBeforeTheWriteTheChosenCopyIsInserted()
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        var (_, versions) = w.Movie(Sintel, Arrived);
        w.Interests.Add(emma.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        w.Privacy.Rules[emma.UserId] = ItemRule(Guid.NewGuid());
        await w.Service.SetPlaylistAsync(emma.UserId, true);
        Assert.Equal("updated", await w.Service.ReconcileAsync(emma.UserId));
        Assert.Equal(new[] { versions[0] }, Assert.Single(w.Host.Playlists.Values).Entries);
    }

    // ================================================================== Declined and Approved to the requester (Q-4FFIX2B-1)

    private static async Task<(Alerts A, RequestLedger Ledger, RequestService Requests)> JeMode()
    {
        var rig = await IntegrationNotificationsTests.Started();
        rig.Config.ArrPhase3Enabled = true;
        rig.Config.ArrRequestBackend = "je";
        var policy = new IntegrationRequestLedgerTests.Policy();
        foreach (var (viewer, role) in new[] { (rig.Admin, "Admin"), (rig.Kid, "Kid"), (rig.Emma, "Member") })
            policy.People[viewer.UserId] = new(viewer.UserId, role, true, role == "Admin", role == "Admin", true, "p1", "je", "inst", "g1", 7, 7, 0, "{}");
        var ledger = new RequestLedger(rig.Db);
        var requests = new RequestService(ledger, policy, rig.View, rig.Feed, () => rig.Arr.Now);
        var a = new Alerts(rig, ledger, (keys, viewer, ct) => Task.FromResult(keys.ToDictionary(k => k, k => new HubTitleMeta { Title = k == Dune ? "Dune: Part Two" : "Severance", Year = 2024 })));
        return (a, ledger, requests);
    }

    private static async Task Decide(RequestService requests, Guid admin, string id, string outcome)
    {
        var status = outcome == NotifyKind.Approved
            ? (await requests.ApproveAsync(id, admin, null, default)).HttpStatus
            : (await requests.DeclineAsync(id, admin, "Not now", default)).HttpStatus;
        Assert.Equal(200, status);
    }

    private static long Notices(IntegrationNotificationsTests.Rig rig)
        => Convert.ToInt64(rig.Db.Read(c => NotifyStore.Scalar(c, "SELECT COUNT(*) FROM request_notices", Array.Empty<(string, object?)>(), null)));

    [Theory]
    [InlineData(NotifyKind.Approved)]
    [InlineData(NotifyKind.Declined)]
    public async Task ARequestOutcomeForATitleTheRequesterHidIsToldOnNoChannel(string outcome)
    {
        var (a, _, requests) = await JeMode();
        using var _a = a;
        var kid = a.Rig.Kid.UserId;
        a.Privacy.Rules[kid] = TitleRule("movie:tmdb:693134");
        var dune = await requests.CreateAsync(kid, new("kid-dune", new MutationInput { Key = Dune }), default);
        var sev = await requests.CreateAsync(kid, new("kid-sev", new MutationInput { Key = Severance, Scope = "seasons", Seasons = new[] { 1 } }), default);
        await Decide(requests, a.Rig.Admin.UserId, dune.RequestId!, outcome);
        await Decide(requests, a.Rig.Admin.UserId, sev.RequestId!, outcome);
        await a.Step(true);
        await a.Step(true);

        // The hidden title: nowhere (no row, push, e-mail); its notice is handled. The other one: as before.
        Assert.DoesNotContain(a.Rig.Inbox(a.Rig.Kid), n => n.Key == Dune);
        Assert.False(a.Told("Dune"));
        Assert.Single(a.Rig.Inbox(a.Rig.Kid), n => n.Kind == outcome && n.Key == Severance);
        Assert.Single(a.Rig.Pushes);
        Assert.Single(a.Rig.Mail.Sent);
        Assert.True(a.Told("Severance"));
        Assert.Single(a.Bell(kid).Items.EnumerateArray());
        Assert.Equal(0L, Notices(a.Rig));
    }

    [Theory]
    [InlineData(NotifyKind.Approved, true)]
    [InlineData(NotifyKind.Declined, true)]
    [InlineData(NotifyKind.Approved, false)]
    public async Task ARequestOutcomeHiddenAfterItWasMadeIsSuppressedAtEverySendAndNamelessInTheBell(string outcome, bool hide)
    {
        var (a, _, requests) = await JeMode();
        using var _a = a;
        var kid = a.Rig.Kid.UserId;
        a.Rig.Prefs(a.Rig.Kid, p => { p.QuietHours = true; p.QuietFrom = "00:00"; p.QuietTo = "23:59"; p.UtcOffsetMinutes = 0; });
        var dune = await requests.CreateAsync(kid, new("kid-dune", new MutationInput { Key = Dune }), default);
        await Decide(requests, a.Rig.Admin.UserId, dune.RequestId!, outcome);
        await a.Step(true);
        var row = Assert.Single(a.Rig.Inbox(a.Rig.Kid), n => n.Kind == outcome);
        Assert.Empty(a.Rig.Pushes);

        if (hide) a.Privacy.Rules[kid] = TitleRule("movie:tmdb:693134");
        a.Rig.Prefs(a.Rig.Kid, p => p.QuietHours = false);
        a.Rig.Arr.Now = a.Rig.Arr.Now.AddDays(1);
        await a.Dispatcher.RunOnceAsync(default);
        var bell = Assert.Single(a.Bell(kid).Items.EnumerateArray());
        if (!hide)
        {
            Assert.True(a.Told("Dune"));
            Assert.Equal(Dune, bell.GetProperty("key").GetString());
            return;
        }

        Assert.False(a.Told("Dune"));
        Assert.Empty(a.Rig.Pushes);
        Assert.Empty(a.Rig.Mail.Sent);
        Assert.All(a.Deliveries(row.Id), d => Assert.Equal("suppressed", d.Status));
        AssertNameless(bell);
    }

    [Fact]
    public async Task ARequestOutcomeWhoseRulesCantBeReadWaitsUntilTheyCan()
    {
        var (a, _, requests) = await JeMode();
        using var _a = a;
        var kid = a.Rig.Kid.UserId;
        a.Privacy.Rules[kid] = null;
        var dune = await requests.CreateAsync(kid, new("kid-dune", new MutationInput { Key = Dune }), default);
        await Decide(requests, a.Rig.Admin.UserId, dune.RequestId!, NotifyKind.Approved);
        await a.Step(true);
        Assert.DoesNotContain(a.Rig.Inbox(a.Rig.Kid), n => n.Kind == NotifyKind.Approved);
        Assert.False(a.Told("Dune"));
        // Out of the ledger's page and into the wait queue (4f round 6).
        Assert.Equal(0L, Notices(a.Rig));
        Assert.Equal(1L, Convert.ToInt64(a.Rig.Db.Read(c => NotifyStore.Scalar(c, "SELECT COUNT(*) FROM alert_waits", Array.Empty<(string, object?)>(), null))));

        a.Privacy.Rules.Remove(kid);
        a.Rig.Arr.Now = a.Rig.Arr.Now.AddMinutes(6);
        await a.Step(true);
        Assert.Single(a.Rig.Inbox(a.Rig.Kid), n => n.Kind == NotifyKind.Approved);
        Assert.True(a.Told("Dune"));
        Assert.Equal(0L, Notices(a.Rig));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ASeerrDeclineOfATitleTheRequesterHidIsToldOnNoChannel(bool hide)
    {
        using var a = new Alerts(await IntegrationNotificationsTests.Started());
        if (hide) a.Privacy.Rules[a.Emma] = TitleRule("movie:tmdb:693134");
        a.Rig.Arr.Now = a.Rig.Arr.Now.AddMinutes(1);
        a.Rig.Seerr.Requests.Add(FakeSeerr.Request(7, "movie", 693134, 1, a.Emma, a.Rig.Arr.Now.UtcDateTime, userName: "Emma"));
        await a.Step(true);
        a.Rig.Seerr.Requests.RemoveAll(r => (int)r["id"]! == 7);
        a.Rig.Arr.Now = a.Rig.Arr.Now.AddMinutes(1);
        a.Rig.Seerr.Requests.Add(FakeSeerr.Request(7, "movie", 693134, 3, a.Emma, a.Rig.Arr.Now.UtcDateTime.AddMinutes(-1), a.Rig.Arr.Now.UtcDateTime, userName: "Emma"));
        await a.Step(true);
        await a.Step(true);
        if (hide)
        {
            Assert.DoesNotContain(a.Rig.Inbox(a.Rig.Emma), n => n.Kind == NotifyKind.Declined);
            Assert.Empty(a.Rig.Pushes);
            Assert.Empty(a.Rig.Mail.Sent);
            Assert.Equal(0, a.Bell(a.Emma).Unread);
        }
        else
        {
            Assert.Single(a.Rig.Inbox(a.Rig.Emma), n => n.Kind == NotifyKind.Declined);
            Assert.Single(a.Rig.Pushes);
        }
    }
}
