using System.Net;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;

namespace JE.Tests;

/// <summary>
/// 4a review round 7 (4a-security-r7-1): the transport check gathers every fact it reads from storage first (the budget
/// reservations, the breaker, the eligibility grant and role, the person's consent, disk facts), then makes one decision on
/// the live settings with nothing that waits before the request is handed on. Each storage read is held at a barrier as
/// it returns, a control is flipped meanwhile, and the read is released: the write must be held, the attempt's budget
/// reservation released, and nothing counted twice. Before round 7, a flip made while a later read waited (the breaker
/// read waits for a restore) was missed and the write was sent.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationAutomationFactsFirstTests
{
    /// <summary>
    /// The storage reads the transport check makes for a Direct add, each held in turn. Since round 8 both disk verdicts are
    /// read in the decision from memory: the low_disk and disk_unknown cells hold the disk facts' only step left in the
    /// gather (starting the reads of any not in memory yet). "approval" holds the Jellyfin administrator read, "grant" the
    /// eligibility grant's. Round 10: "authority" holds the read of the people's policy facts (the requester's here).
    /// </summary>
    public static readonly string[] Reads = { "budget", "breaker", "approval", "consent", "low_disk", "disk_unknown", "grant", "authority" };

    /// <summary>The controls flipped while a read is held, and the hold each one gives.</summary>
    public static readonly Dictionary<string, string?> Flips = new(StringComparer.Ordinal)
    {
        ["none"] = null,
        ["kill_all"] = AutomationHolds.Killed,
        ["kill_recipe"] = AutomationHolds.Killed,
        ["kill_target"] = AutomationHolds.Killed,
        ["shadow_override_on"] = AutomationHolds.ShadowOverride,
        ["mode_off"] = AutomationHolds.RecipePaused,
        ["mode_shadow"] = AutomationHolds.RecipePaused,
        ["opt_out"] = AutomationHolds.UserOptedOut,
        ["budget_zero"] = AutomationHolds.BudgetExhausted,
        ["breaker_open"] = AutomationHolds.BreakerOpen,
        ["restore"] = AutomationHolds.EngineChanged,
    };

    public static IEnumerable<object[]> Cells() => from read in Reads from flip in Flips.Keys select new object[] { read, flip };

    // Holds the first read of the kind named, on the thread making it, until released; a flip is made meanwhile.
    private sealed class Barrier : IDisposable
    {
        private int _once;
        public ManualResetEventSlim Reached { get; } = new();
        public ManualResetEventSlim Release { get; } = new();

        public void Hold()
        {
            if (Interlocked.Exchange(ref _once, 1) != 0) return;
            Reached.Set();
            Release.Wait(TimeSpan.FromSeconds(20));
        }

        public void Dispose()
        {
            Release.Set();
            Reached.Dispose();
            Release.Dispose();
        }
    }

    private static void Arm(IntegrationAutomationTests.Engine e, string read, Barrier barrier)
    {
        switch (read)
        {
            case "budget": e.Budgets.RowsRead = category => { if (category == BudgetCategories.HouseholdAdd) barrier.Hold(); }; break;
            case "breaker": e.Store.BreakerRead = _ => barrier.Hold(); break;
            case "approval": e.R.Policy.Reading = what => { if (what == "is_admin") barrier.Hold(); }; break;
            case "consent": e.Consent.Reading = barrier.Hold; break;
            case "low_disk" or "disk_unknown": e.R.Policy.Reading = what => { if (what == "warm_disk") barrier.Hold(); }; break;
            case "grant": e.Store.GrantRead = _ => barrier.Hold(); break;
            case "authority": e.R.Policy.Reading = what => { if (what == "evaluate") barrier.Hold(); }; break;
            default: throw new ArgumentOutOfRangeException(nameof(read), read, null);
        }
    }

    private static void Apply(IntegrationAutomationTests.Engine e, string flip, string target, byte[]? snapshot)
    {
        var c = e.C;
        switch (flip)
        {
            case "none": break;
            case "kill_all": c.ArrAutomationKillAll = true; break;
            case "kill_recipe": e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto, killed: true); break;
            case "kill_target": c.ArrAutomationKilledInstances = "other," + target; break;
            case "shadow_override_on": c.ArrAutomationShadowOverride = true; break;
            case "mode_off": e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Off); break;
            case "mode_shadow": e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Shadow); break;
            case "opt_out": e.Consent.Map[(e.R.Admin, AutomationRecipes.AutoMovie)] = false; break;
            case "budget_zero": c.ArrAutomationHouseholdAddsPerDay = 0; break;
            case "breaker_open":
                for (var i = 0; i < AutomationStore.BreakerThreshold; i++) e.Store.Failure(target, "backend_unavailable", e.R.Now);
                break;
            case "restore": e.R.Db.ReplaceWith(snapshot!); break;
            default: throw new ArgumentOutOfRangeException(nameof(flip), flip, null);
        }
    }

    [Theory]
    [MemberData(nameof(Cells))]
    public async Task AControlFlippedWhileTheTransportCheckWaitsOnAStorageReadStopsTheWrite(string read, string flip)
    {
        using var e = new IntegrationAutomationTests.Engine();
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto);
        // The disk guard on, so its read is made (the destination's facts are known and the drive has room).
        e.C.ArrLowDiskPercent = 5;
        var asked = await e.Auto(e.R.Admin, IntegrationRequestLedgerTests.Movie(961));
        var want = e.R.Ledger.Find(asked.WantId!)!;
        var job = e.R.Ledger.ForWant(want.Id).Single();
        var admission = e.Guard.Admission(job, want)!;
        Assert.Null(admission.Admit(SendWriteKind.Add, "add"));
        var snapshot = flip == "restore" ? e.R.Db.Snapshot() : null;
        var target = AutomationSendGuard.Target(job);
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response()));
        using var client = transport.CreateClient(ArrHttp.ClientName);
        using var barrier = new Barrier();
        Arm(e, read, barrier);
        var write = AutomationWrite.ForJob(job, want, true);
        var post = Task.Run(async () =>
        {
            using (AutomationTransportContext.Enter(e.Guard.Gate, write, admission))
            {
                using var response = await client.PostAsync("http://radarr.test/api/v3/movie", new StringContent("{}"));
                return response.StatusCode;
            }
        });
        Assert.True(barrier.Reached.Wait(TimeSpan.FromSeconds(10)), "the transport check made its " + read + " read");
        Apply(e, flip, target, snapshot);
        barrier.Release.Set();

        if (Flips[flip] is not { } reason)
        {
            // Nothing flipped: the write goes, its reservation counted once.
            Assert.Equal(HttpStatusCode.OK, await post);
            Assert.Equal(1, transport.Calls);
            admission.Settled(SendWriteKind.Add, "add", SendWriteResult.Sent);
            Assert.Equal(1, e.Count("SELECT count(*) FROM automation_budget WHERE state='consumed'"));
            return;
        }

        var refused = await Assert.ThrowsAsync<AutomationTransportRefusedException>(() => post);
        Assert.Equal(reason, refused.Hold.Reason);
        Assert.Equal(0, transport.Calls);
        // The attempt's reservation is released, and nothing else was counted.
        Assert.Equal(1, e.Count("SELECT count(*) FROM automation_budget"));
        Assert.Equal(0, e.Count("SELECT count(*) FROM automation_budget WHERE state<>'released'"));
    }

    // The write sites' own gate calls (defence in depth) go through the same facts-first check: a control flipped while
    // one of their reads waits holds the write too (the outbox's check before any transport, with its budget read).
    [Theory]
    [InlineData("budget", "kill_all")]
    [InlineData("breaker", "kill_all")]
    [InlineData("approval", "mode_shadow")]
    [InlineData("consent", "shadow_override_on")]
    [InlineData("low_disk", "opt_out")]
    [InlineData("disk_unknown", "breaker_open")]
    [InlineData("breaker", "restore")]
    [InlineData("budget", "none")]
    public async Task AWriteSitesGateCallIsFactsFirstToo(string read, string flip)
    {
        using var e = new IntegrationAutomationTests.Engine();
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto);
        e.C.ArrLowDiskPercent = 5;
        var asked = await e.Auto(e.R.Admin, IntegrationRequestLedgerTests.Movie(961));
        var want = e.R.Ledger.Find(asked.WantId!)!;
        var job = e.R.Ledger.ForWant(want.Id).Single();
        var snapshot = flip == "restore" ? e.R.Db.Snapshot() : null;
        using var barrier = new Barrier();
        if (read == "budget") e.Budgets.RowsRead = category => { if (category == BudgetCategories.Search) barrier.Hold(); };
        else Arm(e, read, barrier);
        var hold = Task.Run(() => e.Guard.Hold(job, want));
        Assert.True(barrier.Reached.Wait(TimeSpan.FromSeconds(10)), "the gate made its " + read + " read");
        Apply(e, flip, AutomationSendGuard.Target(job), snapshot);
        barrier.Release.Set();
        Assert.Equal(Flips[flip], (await hold)?.Reason);
    }

    // A setting changed in place (a household or role save edits the live configuration, then saves it) while a fact that
    // depends on it is read: the configuration's content stamp moved, so the fact is read again. Here the disk guard is
    // switched on while the "is the destination's free space known" read (made with the guard off) returns.
    [Fact]
    public async Task ASettingChangedInPlaceWhileAFactThatDependsOnItIsReadIsReadAgain()
    {
        using var e = new IntegrationAutomationTests.Engine();
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto);
        e.R.Policy.DiskFacts = false;
        e.C.ArrLowDiskPercent = 0;
        var asked = await e.Auto(e.R.Admin, IntegrationRequestLedgerTests.Movie(961));
        var want = e.R.Ledger.Find(asked.WantId!)!;
        var job = e.R.Ledger.ForWant(want.Id).Single();
        var admission = e.Guard.Admission(job, want)!;
        Assert.Null(admission.Admit(SendWriteKind.Add, "add"));
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response()));
        using var client = transport.CreateClient(ArrHttp.ClientName);
        using var barrier = new Barrier();
        Arm(e, "disk_unknown", barrier);
        var write = AutomationWrite.ForJob(job, want, true);
        var post = Task.Run(async () =>
        {
            using (AutomationTransportContext.Enter(e.Guard.Gate, write, admission))
                using (await client.PostAsync("http://radarr.test/api/v3/movie", new StringContent("{}"))) { }
        });
        Assert.True(barrier.Reached.Wait(TimeSpan.FromSeconds(10)));
        e.C.ArrLowDiskPercent = 10;
        barrier.Release.Set();
        var refused = await Assert.ThrowsAsync<AutomationTransportRefusedException>(() => post);
        Assert.Equal(AutomationHolds.DiskUnknown, refused.Hold.Reason);
        Assert.Equal(0, transport.Calls);
    }

    // What the facts depend on keeps moving (a breaker failure lands during every read): the facts are gathered a few
    // times at most, then the write waits briefly, and nothing is sent.
    [Fact]
    public async Task FactsThatKeepChangingWhileTheyAreGatheredHoldTheWrite()
    {
        using var e = new IntegrationAutomationTests.Engine();
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto);
        var asked = await e.Auto(e.R.Admin, IntegrationRequestLedgerTests.Movie(961));
        var want = e.R.Ledger.Find(asked.WantId!)!;
        var job = e.R.Ledger.ForWant(want.Id).Single();
        var admission = e.Guard.Admission(job, want)!;
        Assert.Null(admission.Admit(SendWriteKind.Add, "add"));
        var reads = 0;
        e.Store.BreakerRead = target => { if (Interlocked.Increment(ref reads) <= 10) e.Store.Failure("elsewhere", "backend_unavailable", e.R.Now); };
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response()));
        using var client = transport.CreateClient(ArrHttp.ClientName);
        using (AutomationTransportContext.Enter(e.Guard.Gate, AutomationWrite.ForJob(job, want, true), admission))
        {
            var refused = await Assert.ThrowsAsync<AutomationTransportRefusedException>(() => client.PostAsync("http://radarr.test/api/v3/movie", new StringContent("{}")));
            Assert.Equal(AutomationHolds.EngineChanged, refused.Hold.Reason);
            Assert.Equal(TimeSpan.FromSeconds(30), refused.Hold.Wait);
        }
        Assert.Equal(AutomationWriteGate.GatherRounds, reads);
        Assert.Equal(0, transport.Calls);
        Assert.Equal(0, e.Count("SELECT count(*) FROM automation_budget WHERE state<>'released'"));
    }

    // A person's settings saved while their consent is read: the version read before the file tells the gate it is stale.
    [Fact]
    public void APersonsSettingsVersionMovesWithEverySaveOfTheirSettings()
    {
        using var core = new CoreFixture();
        var users = core.Manager;
        var consents = new UserSettingsConsents(users);
        var person = Guid.NewGuid();
        var other = Guid.NewGuid();
        var id = person.ToString("N");
        var start = consents.Version(person);
        users.SaveUserSettings(id, new UserSettings { AutoMovieRequests = false }, byThePerson: true);
        var saved = consents.Version(person);
        Assert.True(saved > start);
        Assert.False(consents.Preference(person, AutomationRecipes.AutoMovie));
        // Another file of theirs, or someone else's settings, doesn't move it.
        users.SaveUserConfiguration(id, "bookmarks.json", new { });
        users.SaveUserSettings(other.ToString("N"), new UserSettings(), byThePerson: true);
        Assert.Equal(saved, consents.Version(person));
        // The reset (an administrator) and the removal of a deleted person's folder do.
        users.ResetUserSettings(id, new UserSettings());
        var reset = consents.Version(person);
        Assert.True(reset > saved);
        Assert.True(users.DeleteUserData(person));
        Assert.True(consents.Version(person) > reset);
    }
}
