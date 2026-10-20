using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Ready;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.Sqlite;

namespace JE.Tests;

/// <summary>
/// 4f review round 5 (D53, seventh round on the two invariants), through the real modules:
/// <list type="bullet">
/// <item><description>Provenance at the create: a Ready playlist is JE's only when the create itself showed it (the object
/// Jellyfin's create allocated carries JE's nonce from then on); whatever is put in its place under the same folder, in any
/// second, is never stamped, bound, written or deleted, and nothing is made over and over.</description></item>
/// <item><description>Deferred work has its own queue: an outcome alert waiting for evidence never holds another person's
/// notice back, is tried again on its own schedule (no new Seerr revision, no new ledger notice), fairly between people, and
/// expires from the outcome's own time.</description></item>
/// <item><description>One outcome-alert policy: Declined/Approved follow the title's current visibility (library access and
/// parental limits for a library title, the request policy for an absent one, Hidden Content for both), at production, at
/// every send and in the bell; a withheld row is an allowlisted generic shape (no free text such as a decline reason).</description></item>
/// </list>
/// </summary>
[Collection("Plugin singleton")]
public class ReadyProvenanceAndWaitsTests
{
    private const string Dune = "movie:tmdb:693134";
    private const string Severance = "tv:tvdb:371980";
    private static readonly TitleKey Sintel = TitleKey.Parse("movie:tmdb:45745")!;
    private static readonly DateTime Arrived = ReadyWorld.Since.AddDays(2);

    private static ReadyHides TitleRule(string key) => new(Array.Empty<Guid>(), Array.Empty<Guid>(), new[] { key });

    // ================================================================== provenance at the create

    [Theory]
    [InlineData(100, 1100)]  // 4f-r5-security-1: the replacement stored one second later (S+1)
    [InlineData(100, 2100)]  // S+2
    [InlineData(100, 700)]   // the same stored second (round 5's stated host limit)
    [InlineData(900, 1050)]  // 0.15 s later, stored in the next second
    public async Task APlaylistPutInPlaceOfJesBeforeJeReadsItIsNeverJesInAnySecond(int createdAtMs, int replacedAtMs)
    {
        using var w = new ReadyWorld();
        var start = w.Now;
        w.Now = start.AddMilliseconds(createdAtMs);
        var emma = w.User();
        w.Movie(Sintel, Arrived);
        w.Interests.Add(emma.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        await w.Service.SetPlaylistAsync(emma.UserId, true);
        // Jellyfin's create has returned; before JE reads anything, the person deletes JE's playlist and makes their own,
        // empty and private, under the same folder name: Jellyfin gives it the same id and its own creation time.
        FakeReadyPlaylistHost.Native? own = null;
        w.Host.During = call =>
        {
            if (call != "created" || own != null) return;
            var made = Assert.Single(w.Host.Playlists.Values);
            w.Host.Playlists.Remove(made.Id);
            w.Now = start.AddMilliseconds(replacedAtMs);
            own = w.Host.AddOwn(emma.UserId, made.Name);
            Assert.Equal(made.Id, own.Id);
        };
        await w.Service.ReconcileAsync(emma.UserId);
        w.Host.During = null;
        Assert.NotNull(own);

        // Never stamped, bound, renamed, written or deleted; the binding is lost (nothing is made over and over).
        Assert.Null(own!.Nonce);
        var b = w.Store.Binding(ReadyWorld.Server, emma.UserId)!;
        Assert.Null(b.PlaylistId);
        Assert.Equal(ReadyState.Lost, b.State);
        Assert.Equal("provenance", b.Reason);
        Assert.DoesNotContain(w.Host.Gates, g => g.Call is "stamp" or "rename" or "set" or "delete" && g.Refused == null);
        Assert.Equal("nothing", await w.Service.RemoveAsync(emma.UserId));
        w.Now = w.Now.AddMinutes(5);
        Assert.Equal("not_active", await w.Service.ReconcileAsync(emma.UserId));
        Assert.Equal(1, w.Host.Creates);
        Assert.True(w.Host.Playlists.ContainsKey(own.Id));
        Assert.Empty(own.Entries);
        Assert.Null(own.Nonce);
        Assert.Equal(ReadyPlaylistService.CreateName(b.Marker!), own.Name);
    }

    [Fact]
    public async Task AfterARefusedCreateTurningItOnAgainMakesJesOwnAndLeavesThePersonsAlone()
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        var (_, versions) = w.Movie(Sintel, Arrived);
        w.Interests.Add(emma.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        await w.Service.SetPlaylistAsync(emma.UserId, true);
        FakeReadyPlaylistHost.Native? own = null;
        w.Host.During = call =>
        {
            if (call != "created" || own != null) return;
            var made = Assert.Single(w.Host.Playlists.Values);
            w.Host.Playlists.Remove(made.Id);
            own = w.Host.AddOwn(emma.UserId, made.Name);
        };
        await w.Service.ReconcileAsync(emma.UserId);
        w.Host.During = null;

        await w.Service.SetPlaylistAsync(emma.UserId, true);
        w.Now = w.Now.AddMinutes(1);
        Assert.Equal("updated", await w.Service.ReconcileAsync(emma.UserId));
        var bound = w.Store.Binding(ReadyWorld.Server, emma.UserId)!;
        Assert.NotEqual(own!.Id, bound.PlaylistId);
        var mine = w.Host.Playlists[bound.PlaylistId!.Value];
        Assert.Equal(bound.Nonce, mine.Nonce);
        Assert.Equal(new[] { versions[0] }, mine.Entries);
        Assert.Equal("removed", await w.Service.RemoveAsync(emma.UserId));
        Assert.True(w.Host.Playlists.ContainsKey(own.Id));
        Assert.Null(own.Nonce);
    }

    [Fact]
    public async Task AReplacementInsideJellyfinsOwnCreateSaveIsTheStatedHostLimit()
    {
        // Jellyfin's create saves the object it allocated again in its refresh, by id, with no conditional save: a
        // delete-and-remake completed inside the create call itself (before Jellyfin returns to JE) is overwritten by that
        // save, so what is stored there is JE's own playlist row (its nonce, its second). Pinned so a change is seen.
        using var w = new ReadyWorld();
        var emma = w.User();
        w.Movie(Sintel, Arrived);
        w.Interests.Add(emma.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        await w.Service.SetPlaylistAsync(emma.UserId, true);
        var replaced = false;
        w.Host.During = call =>
        {
            if (call != "in-create" || replaced) return;
            replaced = true;
            var made = Assert.Single(w.Host.Playlists.Values);
            w.Host.Playlists.Remove(made.Id);
            w.Host.AddOwn(emma.UserId, made.Name);
        };
        Assert.Equal("updated", await w.Service.ReconcileAsync(emma.UserId));
        Assert.True(replaced);
        var b = w.Store.Binding(ReadyWorld.Server, emma.UserId)!;
        Assert.Equal(b.Nonce, w.Host.Playlists[b.PlaylistId!.Value].Nonce);
    }

    [Fact]
    public async Task AnInterruptedCreateIsRecoveredOnlyWithTheNonceAndTheSecondItsCreateShowed()
    {
        using var w = new ReadyWorld();
        var emma = w.User();
        var (_, versions) = w.Movie(Sintel, Arrived);
        w.Interests.Add(emma.UserId, "w:1", ReadyInterestKind.Request, Sintel);
        await w.Service.SetPlaylistAsync(emma.UserId, true);
        // JE stops right after the create's second was recorded, before its first read and the bind.
        w.Host.FailGet = true;
        Assert.Equal("native_error", await w.Service.ReconcileAsync(emma.UserId));
        var made = Assert.Single(w.Host.Playlists.Values);
        var b = w.Store.Binding(ReadyWorld.Server, emma.UserId)!;
        Assert.Equal(b.Nonce, made.Nonce);
        Assert.Equal(made.Created.ToUnixTimeSeconds() * 1000, b.PlaylistCreated);
        Assert.Null(b.PlaylistId);

        w.Now = w.Now.AddMinutes(1);
        w.Reopen();
        Assert.Equal("updated", await w.Service.ReconcileAsync(emma.UserId));
        Assert.Equal(1, w.Host.Creates);
        Assert.Equal(made.Id, w.Store.Binding(ReadyWorld.Server, emma.UserId)!.PlaylistId);
        Assert.Equal(new[] { versions[0] }, made.Entries);
    }

    // ================================================================== the outcome alerts' world

    internal sealed class World : IDisposable
    {
        public IntegrationNotificationsTests.Rig Rig { get; }
        public FakeReadyPrivacy Privacy { get; } = new();

        /// <summary>Jellyfin's sessions (native Ready messages).</summary>
        public FakeReadySessionHost Sessions { get; } = new();

        public NotifyDispatcher Dispatcher { get; }
        public NotificationService Service { get; }
        public IntegrationRequestLedgerTests.Policy Policy { get; } = new();
        public RequestLedger? Ledger { get; }
        public RequestService? Requests { get; }

        /// <summary>Runs inside every title-metadata lookup (an await of the notices' production), before it answers.</summary>
        public Func<StatusViewer, Task>? OnMeta { get; set; }

        public World(IntegrationNotificationsTests.Rig rig, bool jeMode)
        {
            Rig = rig;
            rig.Config.ArrPhase4Enabled = true;
            rig.Phones(rig.Emma, rig.Kid);
            var channel = new ReadyNativeChannel(new ReadyPlaylistStore(rig.Db), new ReadySessionMessages(Sessions, () => rig.Arr.Now.UtcDateTime), Privacy, rig.View, null, () => rig.Arr.Now);
            foreach (var (viewer, role) in new[] { (rig.Admin, "Admin"), (rig.Kid, "Kid"), (rig.Emma, "Kid") })
                Policy.People[viewer.UserId] = new(viewer.UserId, role, true, role == "Admin", role == "Admin", true, "p1", "je", "inst", "g1", 1000, 7, 0, "{}");
            if (jeMode)
            {
                rig.Config.ArrPhase3Enabled = true;
                rig.Config.ArrRequestBackend = "je";
                Ledger = new RequestLedger(rig.Db);
                Requests = new RequestService(Ledger, Policy, rig.View, rig.Feed, () => rig.Arr.Now);
            }

            Dispatcher = new NotifyDispatcher(rig.NotifyStore, new NtfySender(rig.Ntfy), new EmailSender(rig.Mail), null, () => rig.Config, () => rig.Arr.Now, rig.Users, rig.View, rig.Status.Aliases, Ledger, Policy, channel, rig.Requests);
            Func<IEnumerable<string>, StatusViewer, CancellationToken, Task<Dictionary<string, HubTitleMeta>>> meta = (keys, viewer, ct)
                => (OnMeta?.Invoke(viewer) ?? Task.CompletedTask).ContinueWith(_ => keys.ToDictionary(k => k, k => new HubTitleMeta { Title = k == Dune ? "Dune: Part Two" : k == Severance ? "Severance" : "Film " + k.Split(':')[^1], Year = 2024 }), TaskScheduler.Default);
            Service = new NotificationService(rig.NotifyStore, rig.Status, rig.Requests, rig.View, rig.Feed, rig.Store, rig.Users, Dispatcher, null, null, () => rig.Config, () => rig.Arr.Now, rig.Hub, rig.Bridge, Ledger, meta, Policy);
        }

        public async Task Step(bool send)
        {
            await Rig.Requests.RefreshAsync(default);
            await Service.TickAsync(default);
            Service.FlushBatches(Rig.Arr.Now);
            if (send) await Dispatcher.RunOnceAsync(default);
        }

        public async Task<string> Ask(StatusViewer who, string key, string label)
        {
            var input = TitleKey.Parse(key)!.IsMovie ? new MutationInput { Key = key } : new MutationInput { Key = key, Scope = "seasons", Seasons = new[] { 1 } };
            var made = await Requests!.CreateAsync(who.UserId, new(label, input), default);
            Assert.NotNull(made.RequestId);
            return made.RequestId!;
        }

        public async Task Decide(string id, string outcome, string reason = "Not now")
        {
            var status = outcome == NotifyKind.Approved
                ? (await Requests!.ApproveAsync(id, Rig.Admin.UserId, null, default)).HttpStatus
                : (await Requests!.DeclineAsync(id, Rig.Admin.UserId, reason, default)).HttpStatus;
            Assert.Equal(200, status);
        }

        public int Rows(StatusViewer who, string kind) => Rig.NotifyStore.Inbox(who.UserId, null, 500).Count(r => r.Kind == kind);

        public bool Told(string text)
            => Rig.Pushes.Any(p => p.Body.ToJsonString().Contains(text, StringComparison.Ordinal))
               || Rig.Mail.Sent.Any(m => m.Subject.Contains(text, StringComparison.Ordinal) || m.Text.Contains(text, StringComparison.Ordinal));

        public JsonElement Bell(Guid user)
        {
            var controller = new NotifyController(Service, Dispatcher, new NtfySender(Rig.Ntfy), new EmailSender(Rig.Mail), Rig.Users)
            {
                ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
                Config = () => Rig.Config,
                Now = () => Rig.Arr.Now,
            };
            controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", user.ToString())], "test"));
            var result = (ObjectResult)controller.GetInbox(null, 100);
            return JsonDocument.Parse(JsonSerializer.Serialize(result.Value)).RootElement.GetProperty("items");
        }

        public long Count(string sql)
            => Convert.ToInt64(Rig.Db.Read(c => NotifyStore.Scalar(c, sql, Array.Empty<(string, object?)>(), null)));

        public IReadOnlyList<(string Status, string? Error)> Deliveries(long notification)
        {
            using var c = new SqliteConnection("Data Source=" + Rig.Db.FilePath + ";Pooling=False");
            c.Open();
            using var cmd = c.CreateCommand();
            cmd.CommandText = "SELECT status, last_error FROM deliveries WHERE notification_id=$n ORDER BY id";
            cmd.Parameters.AddWithValue("$n", notification);
            using var r = cmd.ExecuteReader();
            var list = new List<(string, string?)>();
            while (r.Read()) list.Add((r.GetString(0), r.IsDBNull(1) ? null : r.GetString(1)));
            return list;
        }

        public void Dispose()
        {
            Dispatcher.Dispose();
            Service.Dispose();
            Rig.Dispose();
        }
    }

    internal static async Task<World> JeWorld() => new(await IntegrationNotificationsTests.Started(), jeMode: true);

    // ================================================================== deferred work: its own fair queue

    [Fact]
    public async Task TwoHundredWaitingOutcomesOfOnePersonNeverHoldBackAnotherPersonsNotice()
    {
        using var w = await JeWorld();
        var kid = w.Rig.Kid;
        w.Privacy.Rules[kid.UserId] = null;
        for (var i = 0; i < 210; i++) await w.Decide(await w.Ask(kid, "movie:tmdb:" + (5000 + i), "kid-" + i), NotifyKind.Declined);
        w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(1);
        await w.Decide(await w.Ask(w.Rig.Emma, Severance, "emma-sev"), NotifyKind.Declined);

        // Each request left two notices (its ask and its decline): the ledger's pages of 200 are drained round by round.
        for (var i = 0; i < 3; i++) await w.Step(true);
        // Emma's decline is told; the kid's wait (their rules can't be read) without holding hers back.
        Assert.Equal(1, w.Rows(w.Rig.Emma, NotifyKind.Declined));
        Assert.True(w.Told("Severance"));
        Assert.Equal(0, w.Rows(kid, NotifyKind.Declined));
    }

    [Fact]
    public async Task WaitingOutcomesAreTriedAgainFairlyBetweenPeopleOnTheirOwnSchedule()
    {
        using var w = await JeWorld();
        var kid = w.Rig.Kid;
        var emma = w.Rig.Emma;
        w.Privacy.Rules[kid.UserId] = null;
        w.Privacy.Rules[emma.UserId] = null;
        for (var i = 0; i < 210; i++) await w.Decide(await w.Ask(kid, "movie:tmdb:" + (5000 + i), "kid-" + i), NotifyKind.Declined);
        w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(1);
        await w.Decide(await w.Ask(emma, Severance, "emma-sev"), NotifyKind.Declined);
        for (var i = 0; i < 3; i++) await w.Step(false);
        Assert.Equal(0, w.Rows(kid, NotifyKind.Declined) + w.Rows(emma, NotifyKind.Declined));

        // Both readable again; nothing else changes (no notice, no request). The next round's tries are shared fairly: Emma's
        // one is among the first, whatever the kid has waiting.
        w.Privacy.Rules.Clear();
        w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(6);
        await w.Step(false);
        Assert.Equal(1, w.Rows(emma, NotifyKind.Declined));
        Assert.InRange(w.Rows(kid, NotifyKind.Declined), 1, 200);

        // The rest follow on their own schedule.
        for (var i = 0; i < 4; i++)
        {
            w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(6);
            await w.Step(false);
        }

        Assert.Equal(210, w.Rows(kid, NotifyKind.Declined));
    }

    [Fact]
    public async Task AWaitingJeOutcomeIsToldWhenTheRulesReturnWithNoNewNotice()
    {
        using var w = await JeWorld();
        var kid = w.Rig.Kid;
        w.Privacy.Rules[kid.UserId] = null;
        await w.Decide(await w.Ask(kid, Dune, "kid-dune"), NotifyKind.Approved);
        await w.Step(true);
        Assert.Equal(0, w.Rows(kid, NotifyKind.Approved));

        w.Privacy.Rules.Remove(kid.UserId);
        w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(6);
        await w.Step(true);
        Assert.Equal(1, w.Rows(kid, NotifyKind.Approved));
        Assert.True(w.Told("Dune"));
    }

    [Fact]
    public async Task AWaitingSeerrDeclineIsToldWhenTheRulesReturnWithNoNewRevision()
    {
        using var w = new World(await IntegrationNotificationsTests.Started(), jeMode: false);
        var emma = w.Rig.Emma.UserId;
        w.Privacy.Rules[emma] = null;
        w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(1);
        w.Rig.Seerr.Requests.Add(FakeSeerr.Request(7, "movie", 693134, 1, emma, w.Rig.Arr.Now.UtcDateTime, userName: "Emma"));
        await w.Step(true);
        w.Rig.Seerr.Requests.RemoveAll(r => (int)r["id"]! == 7);
        w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(1);
        w.Rig.Seerr.Requests.Add(FakeSeerr.Request(7, "movie", 693134, 3, emma, w.Rig.Arr.Now.UtcDateTime.AddMinutes(-1), w.Rig.Arr.Now.UtcDateTime, userName: "Emma"));
        await w.Step(true);
        await w.Step(true);
        Assert.Equal(0, w.Rows(w.Rig.Emma, NotifyKind.Declined));
        var revision = w.Rig.Requests.Revision;

        // Readable again; Seerr's list doesn't change at all.
        w.Privacy.Rules.Remove(emma);
        w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(6);
        await w.Step(true);
        await w.Step(true);
        Assert.Equal(revision, w.Rig.Requests.Revision);
        Assert.Equal(1, w.Rows(w.Rig.Emma, NotifyKind.Declined));
        Assert.Single(w.Rig.Pushes);
    }

    [Fact]
    public async Task AWaitingOutcomeExpiresFromTheOutcomesOwnTime()
    {
        using var w = await JeWorld();
        var kid = w.Rig.Kid;
        w.Privacy.Rules[kid.UserId] = null;
        await w.Decide(await w.Ask(kid, Dune, "kid-dune"), NotifyKind.Declined);
        await w.Step(false);
        // Tried every few minutes for days; readable only after the outcome itself is too old: never told.
        for (var i = 0; i < 4; i++)
        {
            w.Rig.Arr.Now = w.Rig.Arr.Now.AddHours(20);
            await w.Step(false);
        }

        w.Privacy.Rules.Remove(kid.UserId);
        w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(6);
        await w.Step(true);
        Assert.Equal(0, w.Rows(kid, NotifyKind.Declined));
        Assert.False(w.Told("Dune"));
    }

    // ================================================================== one outcome policy

    // The title's copies stop being visible to the kid (library access removed, or a parental limit now blocks it).
    private static void OnlyAdminCanOpen(World w, string key)
    {
        var list = w.Rig.View.CopiesByKey[TitleKey.Parse(key)!.ToString()];
        for (var i = 0; i < list.Count; i++) list[i] = (list[i].Copy, new HashSet<Guid> { w.Rig.Admin.UserId });
        w.Rig.View.Rev++;
    }

    [Theory]
    [InlineData(NotifyKind.Declined, "production")]
    [InlineData(NotifyKind.Approved, "production")]
    [InlineData(NotifyKind.Declined, "send")]
    [InlineData(NotifyKind.Approved, "send")]
    public async Task AnOutcomeOfALibraryTitleTheRequesterCanNoLongerOpenIsToldOnNoChannel(string outcome, string when)
    {
        using var w = await JeWorld();
        var kid = w.Rig.Kid;
        var id = await w.Ask(kid, Dune, "kid-dune");
        w.Rig.Arrive(Dune);
        if (when == "send") w.Rig.Prefs(kid, p => { p.QuietHours = true; p.QuietFrom = "00:00"; p.QuietTo = "23:59"; p.UtcOffsetMinutes = 0; });
        else OnlyAdminCanOpen(w, Dune);
        await w.Decide(id, outcome);
        await w.Step(true);
        if (when == "send")
        {
            // Made while they could open it; their access goes during quiet hours; the held sends find it gone.
            var row = Assert.Single(w.Rig.Inbox(kid), n => n.Kind == outcome);
            OnlyAdminCanOpen(w, Dune);
            w.Rig.Prefs(kid, p => p.QuietHours = false);
            w.Rig.Arr.Now = w.Rig.Arr.Now.AddDays(1);
            await w.Dispatcher.RunOnceAsync(default);
            Assert.All(w.Deliveries(row.Id), d => Assert.Equal("suppressed", d.Status));
            var bell = Assert.Single(w.Bell(kid.UserId).EnumerateArray(), r => r.GetProperty("kind").GetString() == outcome);
            Assert.Equal(JsonValueKind.Null, bell.GetProperty("key").ValueKind);
            Assert.False(bell.GetProperty("params").TryGetProperty("title", out _));
        }
        else
        {
            Assert.Equal(0, w.Rows(kid, outcome));
        }

        Assert.False(w.Told("Dune"));
        Assert.False(w.Told(outcome == NotifyKind.Declined ? "said no" : "OK'd"));
    }

    [Theory]
    [InlineData(NotifyKind.Declined)]
    [InlineData(NotifyKind.Approved)]
    public async Task AnOutcomeOfAnAbsentTitleTheRequestPolicyHidesIsToldOnNoChannel(string outcome)
    {
        using var w = await JeWorld();
        var kid = w.Rig.Kid;
        var id = await w.Ask(kid, Dune, "kid-dune");
        await w.Decide(id, outcome);
        // A parental limit now blocks the absent title's rating for them (the rule the Requests page's cards follow).
        w.Policy.Adjust = (user, input, facts) => user == kid.UserId && input.Key == Dune ? facts with { Visible = false } : facts;
        await w.Step(true);
        await w.Step(true);
        Assert.Equal(0, w.Rows(kid, outcome));
        Assert.False(w.Told("Dune"));
        Assert.Equal(0L, w.Count("SELECT COUNT(*) FROM request_notices"));
    }

    [Theory]
    [InlineData(NotifyKind.Declined, true)]
    [InlineData(NotifyKind.Approved, true)]
    [InlineData(NotifyKind.Declined, false)]
    [InlineData(NotifyKind.Approved, false)]
    public async Task AnOutcomeTheRequesterMaySeeIsToldEverywhere(string outcome, bool inLibrary)
    {
        using var w = await JeWorld();
        var kid = w.Rig.Kid;
        var id = await w.Ask(kid, Dune, "kid-dune");
        if (inLibrary) w.Rig.Arrive(Dune);
        await w.Decide(id, outcome);
        await w.Step(true);
        Assert.Equal(1, w.Rows(kid, outcome));
        Assert.True(w.Told(outcome == NotifyKind.Declined ? "said no to Dune" : "OK'd Dune"));
        Assert.Equal(Dune, Assert.Single(w.Bell(kid.UserId).EnumerateArray(), r => r.GetProperty("kind").GetString() == outcome).GetProperty("key").GetString());
    }

    [Fact]
    public async Task WithHideTitlesADeclinePushCarriesNoReason()
    {
        using var w = await JeWorld();
        var kid = w.Rig.Kid;
        w.Rig.Prefs(kid, p => p.HideTitles = true);
        await w.Decide(await w.Ask(kid, Dune, "kid-dune"), NotifyKind.Declined, "Dune is too violent");
        await w.Step(true);
        Assert.Equal(1, w.Rows(kid, NotifyKind.Declined));
        Assert.True(w.Told("said no to a request"));
        Assert.False(w.Told("violent"));
        Assert.False(w.Told("Dune"));
    }

    // ================================================================== the withheld row's payload

    [Fact]
    public async Task AWithheldDeclineRowCarriesNoReasonOrAnythingElseOfTheTitle()
    {
        using var w = await JeWorld();
        var kid = w.Rig.Kid;
        await w.Decide(await w.Ask(kid, Dune, "kid-dune"), NotifyKind.Declined, "Dune is too violent");
        await w.Step(false);
        var shown = Assert.Single(w.Bell(kid.UserId).EnumerateArray());
        Assert.Equal("Dune is too violent", shown.GetProperty("params").GetProperty("reason").GetString());

        // Hidden afterwards: the row stays, as a generic shape only.
        w.Privacy.Rules[kid.UserId] = TitleRule(Dune);
        var row = Assert.Single(w.Bell(kid.UserId).EnumerateArray());
        Assert.Equal(JsonValueKind.Null, row.GetProperty("key").ValueKind);
        Assert.Equal(JsonValueKind.Null, row.GetProperty("itemId").ValueKind);
        var names = row.GetProperty("params").EnumerateObject().Select(p => p.Name).ToList();
        Assert.All(names, n => Assert.Contains(n, new[] { "variant", "shared", "count" }));
        Assert.DoesNotContain("Dune", row.GetRawText(), StringComparison.Ordinal);
        Assert.DoesNotContain("violent", row.GetRawText(), StringComparison.Ordinal);
    }

    // ================================================================== Q-4FFIX5-4: an OK that fell back to waiting

    [Fact]
    public async Task AnOkdRequestThatWentBackToWaitingIsSuppressedWithAnAccurateReason()
    {
        using var w = await JeWorld();
        var kid = w.Rig.Kid;
        w.Rig.Prefs(kid, p => { p.QuietHours = true; p.QuietFrom = "00:00"; p.QuietTo = "23:59"; p.UtcOffsetMinutes = 0; });
        var id = await w.Ask(kid, Dune, "kid-dune");
        await w.Decide(id, NotifyKind.Approved);
        await w.Step(true);
        var row = Assert.Single(w.Rig.Inbox(kid), n => n.Kind == NotifyKind.Approved);
        // The send to Sonarr/Radarr couldn't happen (no instance): the request is back to waiting, as the sender leaves it.
        w.Rig.Db.Write((c, t) =>
        {
            using var cmd = c.CreateCommand();
            cmd.Transaction = t;
            cmd.CommandText = "UPDATE wants SET status='pending', reason='no_instance' WHERE id=$id";
            cmd.Parameters.AddWithValue("$id", id);
            return cmd.ExecuteNonQuery();
        });
        w.Rig.Prefs(kid, p => p.QuietHours = false);
        w.Rig.Arr.Now = w.Rig.Arr.Now.AddDays(1);
        await w.Dispatcher.RunOnceAsync(default);
        var deliveries = w.Deliveries(row.Id);
        Assert.NotEmpty(deliveries);
        Assert.All(deliveries, d =>
        {
            Assert.Equal("suppressed", d.Status);
            Assert.Contains("waiting again", d.Error, StringComparison.Ordinal);
            Assert.DoesNotContain("cancelled, declined or removed", d.Error, StringComparison.Ordinal);
        });
    }
}
