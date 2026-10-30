using System.Globalization;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Ready;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Microsoft.Data.Sqlite;
using World = JE.Tests.ReadyProvenanceAndWaitsTests.World;

namespace JE.Tests;

/// <summary>
/// 4f round 9 (4f-r8-1, D53): the await-point model. Every await on every alert path (a single delivery, a summary, the
/// summary's one-by-one fallback, the wait queue's retry, an ask to the administrators in JE and Seerr mode, a Seerr decline,
/// Remind, Ready, new episodes, a request's outcome declined or OK'd, and the bell row each of them writes) is a point at which
/// each mutation is applied: notifications switched off, the kind switched off, the title hidden, access revoked, Hidden
/// Content unreadable, quiet hours starting, the person disabled. The expected result is what the final gate says at the
/// moment of the action: a mutation applied before an action's decision decides it (Off and missing evidence leave it as it
/// is and it goes later; a refusal ends it; quiet hours hold it), one applied after it (during the network send) doesn't
/// un-send it. The cells are generated from the paths' points × the mutations; <see cref="EveryAwaitOnTheAlertPathsIsAPointOfTheModel"/>
/// checks, by Roslyn over the plugin's source, that every await on those paths is one of the model's points (or composite,
/// or excluded with its reason), so an await added later without a point fails.
/// 4f round 10 (4f-r9-1, 4f-r9-2, D53): the native message's claim is a path of its own (its point is the session re-read
/// right before the claim: notifications switched off there leave it pending, and it goes once they are back on), and every
/// path has the mutation <see cref="Mutation.Stale"/>: the clock passes the alert's catch-up limit at the point, so each alert
/// kind is checked to carry its own origin (an alert made after that is refused; a delivery of an alert told when it was made
/// isn't held to it; a native message is stale after its own ten minutes).
/// </summary>
[Collection("Plugin singleton")]
public class ReadyAwaitPointModelTests
{
    public enum Mutation
    {
        Off,
        KindOff,
        Hidden,
        Revoked,
        Unreadable,
        Quiet,
        Disabled,
        Stale,
    }

    private const string Dune = "movie:tmdb:693134";
    private const string Severance = "tv:tvdb:371980";

    private static readonly string[] Keys = Enumerable.Range(0, 5).Select(i => "movie:tmdb:" + (7100 + i)).ToArray();

    // ================================================================== the model

    /// <summary>One await point of a path: the probe label it fires as, and the await sites (method:callee) it stands for.</summary>
    internal sealed record Point(string Label, params string[] Sites);

    /// <summary>One thing a path does, decided after the first <see cref="After"/> points of the path.</summary>
    /// <param name="Name">What it is (shown when a cell fails).</param>
    /// <param name="After">How many of the path's points come before its decision: a mutation at an earlier point decides it.</param>
    /// <param name="Outbound">A delivery (sent / pending / suppressed) rather than the notification itself (told / held / none).</param>
    /// <param name="Admin">An administrators' alert (an ask, a reminder): their alerts to phone and e-mail, no Hidden Content.</param>
    /// <param name="Native">A native Ready message (sent / pending / suppressed; never held).</param>
    internal sealed record Unit(string Name, int After, bool Outbound, bool Admin, Func<World, Ctx, string> Observe, bool Native = false);

    /// <summary>A path: how its world is made, how the round under test and the round after it run, its points and units.</summary>
    internal sealed class AlertPath
    {
        public required string Name { get; init; }
        public required Point[] Points { get; init; }
        public required Func<Task<(World World, Ctx Ctx)>> Setup { get; init; }
        public required Func<World, Ctx, Task> Run { get; init; }
        public required Func<World, Ctx, Task> Next { get; init; }
        public required Func<Ctx, Unit[]> Units { get; init; }

        /// <summary>The person the mutation is applied to, the title it is about and the kind of alert.</summary>
        public required Func<World, StatusViewer> Target { get; init; }
        public required string Title { get; init; }
        public required string Kind { get; init; }

        /// <summary>The title is in the library (access revoked by the copy's visibility, not the request policy).</summary>
        public bool InLibrary { get; init; }
        public Action<World, Ctx, Probe>? Arm { get; init; }
    }

    /// <summary>What a path's setup leaves for its run and observations.</summary>
    internal sealed class Ctx
    {
        public Dictionary<string, long> Rows { get; } = new();
        public List<string> Hidden { get; } = new();
        public List<string> Survivors { get; } = new();
        public Guid SeriesCopy { get; set; }
    }

    /// <summary>Counts every hook by label and applies the armed mutation once, at the armed occurrence.</summary>
    internal sealed class Probe
    {
        private readonly Dictionary<string, int> _seen = new(StringComparer.Ordinal);

        public string? Armed { get; set; }
        public Action? Apply { get; set; }
        public bool Fired { get; private set; }
        public List<string> Trace { get; } = new();
        public List<(string Label, Action Do)> Setup { get; } = new();

        public void Hit(string key)
        {
            int n;
            lock (_seen) _seen[key] = n = _seen.GetValueOrDefault(key) + 1;
            var label = key + "#" + n.ToString(CultureInfo.InvariantCulture);
            lock (Trace) Trace.Add(label);
            foreach (var step in Setup.Where(s => s.Label == label).ToList()) step.Do();
            if (!Fired && Armed == label)
            {
                Fired = true;
                Apply!();
            }
        }
    }

    private static string Who(World w, Guid user)
        => user == w.Rig.Kid.UserId ? "kid" : user == w.Rig.Emma.UserId ? "emma" : user == w.Rig.Admin.UserId ? "jake" : user == w.Rig.Sam.UserId ? "sam" : "other";

    private static void Install(World w, Probe probe)
    {
        w.Policy.Visibility = (who, input) =>
        {
            probe.Hit("prepare:" + Who(w, who));
            return Task.CompletedTask;
        };
        w.OnMeta = viewer =>
        {
            probe.Hit("meta:" + Who(w, viewer.UserId));
            return Task.CompletedTask;
        };
        w.Rig.OnPush = () =>
        {
            probe.Hit("push");
            return Task.CompletedTask;
        };
        w.Rig.Mail.OnSend = () =>
        {
            probe.Hit("mail");
            return Task.CompletedTask;
        };
        w.Rig.Radarr.Before = (path, ct) =>
        {
            probe.Hit("arr:" + path);
            return Task.CompletedTask;
        };
        w.Sessions.OnReread = _ => probe.Hit("reread");
    }

    private static void Uninstall(World w)
    {
        w.Policy.Visibility = null;
        w.OnMeta = null;
        w.Rig.OnPush = null;
        w.Rig.Mail.OnSend = null;
        w.Rig.Radarr.Before = null;
        w.Sessions.OnReread = null;
    }

    // ================================================================== mutations

    private static ReadyHides TitleRules(params string[] keys) => new(Array.Empty<Guid>(), Array.Empty<Guid>(), keys);

    private static void Apply(AlertPath path, World w, Ctx ctx, Mutation m)
    {
        var who = path.Target(w);
        switch (m)
        {
            case Mutation.Off:
                w.Rig.Config.ArrNotificationsEnabled = false;
                break;
            case Mutation.KindOff:
                ChangeObservedPrefs(w, who, p => Kind(p, path.Kind, false));
                break;
            case Mutation.Hidden:
                // A series is hidden by a rule on its copy (Hidden Content's title rules are TMDB keys).
                w.Privacy.Rules[who.UserId] = ctx.SeriesCopy != Guid.Empty
                    ? new ReadyHides(Array.Empty<Guid>(), Array.Empty<Guid>(), Array.Empty<string>(), new[] { ctx.SeriesCopy })
                    : TitleRules(ctx.Rows.Count > 1 ? ctx.Rows.Keys.ToArray() : new[] { path.Title });
                break;
            case Mutation.Revoked:
                if (path.InLibrary) Visible(w, path.Title, false);
                else w.Policy.Adjust = (user, input, facts) => user == who.UserId ? facts with { Visible = false } : facts;
                break;
            case Mutation.Unreadable:
                w.Privacy.Rules[who.UserId] = null;
                break;
            case Mutation.Quiet:
                ChangeObservedPrefs(w, who, p =>
                {
                    p.QuietHours = true;
                    p.QuietFrom = w.Rig.Arr.Now.UtcDateTime.AddHours(-1).ToString("HH:mm", CultureInfo.InvariantCulture);
                    p.QuietTo = w.Rig.Arr.Now.UtcDateTime.AddHours(1).ToString("HH:mm", CultureInfo.InvariantCulture);
                    p.UtcOffsetMinutes = 0;
                });
                break;
            case Mutation.Stale:
                // The clock passes the catch-up limit (and a minute) at this point: what happened before it is too old to tell.
                w.Rig.Arr.Now = w.Rig.Arr.Now + NotificationService.ArrivalFreshFor + TimeSpan.FromMinutes(1);
                break;
            default:
                w.Rig.Users.Disabled.Add(who.UserId);
                break;
        }
    }

    // These hooks deliberately change persisted evidence during an evaluator
    // await. Public preference writers now serialize behind that entire owner;
    // synchronously calling one from this hook would deadlock the test itself.
    // Inject the stronger out-of-band database mutation through the fixture DB.
    // IntegrationEvidenceOrderingTests separately verifies real API writers wait.
    internal static void ChangeObservedPrefs(World w, StatusViewer who, Action<NotifyPrefs> change)
    {
        var prefs = w.Rig.NotifyStore.Prefs(who.UserId);
        change(prefs);
        w.Rig.Db.Write((connection, transaction) =>
        {
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = "INSERT INTO notify_prefs(user_id,json,updated_at) VALUES($u,$j,$n) ON CONFLICT(user_id) DO UPDATE SET json=excluded.json,updated_at=excluded.updated_at";
            command.Parameters.AddWithValue("$u", who.UserId.ToString("N"));
            command.Parameters.AddWithValue("$j", JsonSerializer.Serialize(prefs, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase }));
            command.Parameters.AddWithValue("$n", w.Rig.Arr.Now.ToUnixTimeMilliseconds());
            return command.ExecuteNonQuery();
        });
    }

    private static void Undo(AlertPath path, World w, Ctx ctx, Mutation m)
    {
        var who = path.Target(w);
        switch (m)
        {
            case Mutation.Off:
                w.Rig.Config.ArrNotificationsEnabled = true;
                break;
            case Mutation.KindOff:
                w.Rig.Prefs(who, p => Kind(p, path.Kind, true));
                break;
            case Mutation.Hidden:
            case Mutation.Unreadable:
                // Back to the path's own rules (the fallback's two hidden titles stay hidden).
                if (ctx.Hidden.Count > 0) w.Privacy.Rules[who.UserId] = TitleRules(ctx.Hidden.ToArray());
                else w.Privacy.Rules.Remove(who.UserId);
                break;
            case Mutation.Revoked:
                if (path.InLibrary) Visible(w, path.Title, true);
                else w.Policy.Adjust = null;
                break;
            case Mutation.Quiet:
                w.Rig.Prefs(who, p => p.QuietHours = false);
                break;
            case Mutation.Stale:
                // Time doesn't go back.
                break;
            default:
                w.Rig.Users.Disabled.Remove(who.UserId);
                break;
        }
    }

    private static void Kind(NotifyPrefs p, string kind, bool on)
    {
        switch (kind)
        {
            case NotifyKind.Declined: p.Declined = on; break;
            case NotifyKind.Approved: p.Approved = on; break;
            case NotifyKind.Ready: p.Ready = on; break;
            case NotifyKind.Episodes: p.Episodes = on; break;
            default: p.AdminAlerts = on; break;
        }
    }

    // A library title's copies made visible to the administrator only (revoked), or to everyone again.
    private static void Visible(World w, string key, bool everyone)
    {
        var list = w.Rig.View.CopiesByKey[TitleKey.Parse(key)!.ToString()];
        for (var i = 0; i < list.Count; i++) list[i] = (list[i].Copy, everyone ? null : new HashSet<Guid> { w.Rig.Admin.UserId });
        w.Rig.View.Rev++;
    }

    // ================================================================== expectations

    /// <summary>The final gate's verdict on an alert after the mutation: what the action does then.</summary>
    internal static (string First, string Then) Expected(Unit unit, Mutation m, int index)
    {
        var affected = index < unit.After;
        if (unit.Native)
        {
            // Never held: switched off, it stays pending (nothing done) and goes once they are back on; anything else ends it.
            if (!affected) return ("sent", "sent");
            return m == Mutation.Off ? ("pending", "sent") : ("suppressed", "suppressed");
        }

        if (m == Mutation.Stale)
        {
            // A delivery of an alert told when it was made isn't held to the catch-up limit.
            if (unit.Outbound) return ("sent", "sent");
            if (!affected) return ("told", "told");
            // Too old by the time it is decided: refused for good. A reminder pressed again (the next round) is a new press, told
            // unless the refused one was spent at the same (later) time: the clock passed the limit before the press was recorded.
            return unit.Name == "remind" && index > 0 ? ("none", "told") : ("none", "none");
        }

        if (unit.Outbound)
        {
            if (!affected) return ("sent", "sent");
            return m is Mutation.Off or Mutation.Unreadable or Mutation.Quiet ? ("pending", "sent") : ("suppressed", "suppressed");
        }

        if (!affected) return ("told", "told");
        // A library title the person can't open any more isn't ready for them (the look finds no copy of theirs); once they can
        // open it again, its arrival is theirs to be told.
        if (unit.Name == "ready" && m == Mutation.Revoked) return ("none", "told");
        if (unit.Admin)
        {
            return m switch
            {
                Mutation.Off => ("none", "told"),
                Mutation.KindOff => ("bell-only", "bell-only"),
                Mutation.Hidden or Mutation.Unreadable => ("told", "told"),
                Mutation.Quiet => ("held", "held"),
                _ => ("none", "none"),
            };
        }

        return m switch
        {
            Mutation.Off or Mutation.Unreadable => ("none", "told"),
            Mutation.Quiet => ("held", "held"),
            _ => ("none", "none"),
        };
    }

    // ================================================================== observations

    private static string DeliveryOf(World w, long notification, string channel)
    {
        using var c = new SqliteConnection("Data Source=" + w.Rig.Db.FilePath + ";Pooling=False");
        c.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT status FROM deliveries WHERE notification_id=$n AND channel=$c";
        cmd.Parameters.AddWithValue("$n", notification);
        cmd.Parameters.AddWithValue("$c", channel);
        return cmd.ExecuteScalar() as string ?? "missing";
    }

    // The notification of that kind the person got: none, told (phone and e-mail due now), held (due later), bell-only.
    private static string Told(World w, StatusViewer who, string kind)
    {
        var rows = w.Rig.NotifyStore.Inbox(who.UserId, null, 500).Where(r => r.Kind == kind).ToList();
        if (rows.Count == 0) return "none";
        if (rows.Count > 1) return "twice";
        using var c = new SqliteConnection("Data Source=" + w.Rig.Db.FilePath + ";Pooling=False");
        c.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT next_at FROM deliveries WHERE notification_id=$n AND channel IN ('ntfy','email')";
        cmd.Parameters.AddWithValue("$n", rows[0].Id);
        var at = new List<long>();
        using (var r = cmd.ExecuteReader())
        {
            while (r.Read()) at.Add(r.GetInt64(0));
        }

        if (at.Count == 0) return "bell-only";
        if (at.Count != 2) return "deliveries:" + at.Count.ToString(CultureInfo.InvariantCulture);
        var now = w.Rig.Arr.Now.ToUnixTimeMilliseconds();
        return at.All(a => a <= now + 60_000) ? "told" : at.All(a => a > now + 60_000) ? "held" : "mixed";
    }

    // ================================================================== paths

    private static void Quiet(World w, StatusViewer who)
        => w.Rig.Prefs(who, p =>
        {
            p.QuietHours = true;
            p.QuietFrom = w.Rig.Arr.Now.UtcDateTime.AddHours(-1).ToString("HH:mm", CultureInfo.InvariantCulture);
            p.QuietTo = w.Rig.Arr.Now.UtcDateTime.AddHours(1).ToString("HH:mm", CultureInfo.InvariantCulture);
            p.UtcOffsetMinutes = 0;
        });

    // The kid's requests for the first `count` titles answered during their quiet hours (phone and e-mail held two hours).
    private static async Task<(World, Ctx)> Held(string outcome, int count)
    {
        var w = await ReadyProvenanceAndWaitsTests.JeWorld();
        var ctx = new Ctx();
        var kid = w.Rig.Kid;
        var ids = new List<string>();
        for (var i = 0; i < count; i++) ids.Add(await w.Ask(kid, Keys[i], "kid-" + i));
        Quiet(w, kid);
        foreach (var id in ids) await w.Decide(id, outcome);
        await w.Step(true);
        foreach (var r in w.Rig.Inbox(kid).Where(r => r.Kind == outcome)) ctx.Rows[r.Key!] = r.Id;
        Assert.Equal(count, ctx.Rows.Count);
        Assert.Equal(0, w.Rig.Pushes.Count + w.Rig.Mail.Sent.Count);
        w.Rig.Arr.Now = w.Rig.Arr.Now.AddHours(2);
        return (w, ctx);
    }

    private static Task RunDispatcher(World w, Ctx ctx) => w.Dispatcher.RunOnceAsync(default);

    private static async Task NextDispatcher(World w, Ctx ctx)
    {
        w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(61);
        await w.Dispatcher.RunOnceAsync(default);
    }

    private static readonly string[] Prepare = { "DeliverAsync:PrepareOutcomeAsync", "PrepareOutcomeAsync:PrepareVisibilityAsync" };
    private static readonly string[] SummaryPrepare = { "DeliverSummaryAsync:PrepareOutcomeAsync", "PrepareOutcomeAsync:PrepareVisibilityAsync" };
    private static readonly string[] Push = { "DeliverAsync:SendAsync", "SendAsync:NtfySender.SendAsync" };
    private static readonly string[] Mail = { "DeliverAsync:SendAsync", "SendAsync:EmailSender.SendAsync" };

    private static AlertPath Single(string outcome) => new()
    {
        Name = "single-" + outcome,
        Kind = outcome,
        Title = Keys[0],
        Target = w => w.Rig.Kid,
        Points = new[] { new Point("prepare:kid#1", Prepare), new Point("push#1", Push), new Point("prepare:kid#2", Prepare), new Point("mail#1", Mail) },
        Setup = () => Held(outcome, 1),
        Run = RunDispatcher,
        Next = NextDispatcher,
        Units = ctx => new[]
        {
            new Unit("phone", 1, true, false, (w, c) => DeliveryOf(w, c.Rows[Keys[0]], NotifyChannel.Ntfy)),
            new Unit("e-mail", 3, true, false, (w, c) => DeliveryOf(w, c.Rows[Keys[0]], NotifyChannel.Email)),
        },
    };

    private static AlertPath Summary() => new()
    {
        Name = "summary",
        Kind = NotifyKind.Declined,
        Title = Keys[0],
        Target = w => w.Rig.Kid,
        Points = new[]
        {
            new Point("prepare:kid#1", SummaryPrepare), new Point("prepare:kid#5", SummaryPrepare),
            new Point("push#1", "DeliverSummaryAsync:SendAsync", "SendAsync:NtfySender.SendAsync"),
            new Point("prepare:kid#6", SummaryPrepare), new Point("prepare:kid#10", SummaryPrepare),
            new Point("mail#1", "DeliverSummaryAsync:SendAsync", "SendAsync:EmailSender.SendAsync"),
        },
        Setup = () => Held(NotifyKind.Declined, 5),
        Run = RunDispatcher,
        Next = NextDispatcher,
        Units = ctx => Keys.SelectMany(k => new[]
        {
            new Unit("phone " + k, 2, true, false, (w, c) => DeliveryOf(w, c.Rows[k], NotifyChannel.Ntfy)),
            new Unit("e-mail " + k, 5, true, false, (w, c) => DeliveryOf(w, c.Rows[k], NotifyChannel.Email)),
        }).ToArray(),
    };

    private static AlertPath Fallback() => new()
    {
        Name = "fallback",
        Kind = NotifyKind.Declined,
        Title = Keys[2],
        Target = w => w.Rig.Kid,
        Points = new[]
        {
            new Point("prepare:kid#6", "DeliverSummaryAsync:DeliverAsync", "DeliverAsync:PrepareOutcomeAsync", "PrepareOutcomeAsync:PrepareVisibilityAsync"),
            new Point("push#1", Push), new Point("prepare:kid#8", Prepare), new Point("push#3", Push),
        },
        Setup = async () =>
        {
            var (w, ctx) = await Held(NotifyKind.Declined, 5);
            // The first two titles prepared are hidden during the last member's preparation: three survive, under the summary
            // threshold, and go one by one.
            ctx.Hidden.AddRange(Keys.Take(2));
            ctx.Survivors.AddRange(Keys.Skip(2));
            return (w, ctx);
        },
        Arm = (w, ctx, probe) => probe.Setup.Add(("prepare:kid#5", () => w.Privacy.Rules[w.Rig.Kid.UserId] = TitleRules(ctx.Hidden.ToArray()))),
        Run = RunDispatcher,
        Next = NextDispatcher,
        Units = ctx => ctx.Survivors.Select((k, i) => new Unit("phone " + k, i + 1, true, false, (w, c) => DeliveryOf(w, c.Rows[k], NotifyChannel.Ntfy)))
            .Concat(ctx.Survivors.Select(k => new Unit("e-mail " + k, 4, true, false, (w, c) => DeliveryOf(w, c.Rows[k], NotifyChannel.Email)))).ToArray(),
    };

    private static AlertPath WaitRetry() => new()
    {
        Name = "wait-retry",
        Kind = NotifyKind.Declined,
        Title = Keys[0],
        Target = w => w.Rig.Kid,
        Points = new[] { new Point("prepare:kid#1", "RetryAlertWaitsCoreAsync:PrepareVisibilityAsync") },
        Setup = async () =>
        {
            var w = await ReadyProvenanceAndWaitsTests.JeWorld();
            var kid = w.Rig.Kid;
            w.Privacy.Rules[kid.UserId] = null;
            await w.Decide(await w.Ask(kid, Keys[0], "kid-0"), NotifyKind.Declined);
            await w.Step(false);
            Assert.Equal(1L, w.Count("SELECT COUNT(*) FROM alert_waits"));
            w.Privacy.Rules.Remove(kid.UserId);
            w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(6);
            return (w, new Ctx());
        },
        Run = (w, ctx) => w.Service.RetryAlertWaitsAsync(w.Rig.Arr.Now, default),
        Next = async (w, ctx) =>
        {
            w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(6);
            await w.Service.RetryAlertWaitsAsync(w.Rig.Arr.Now, default);
        },
        Units = ctx => new[] { new Unit("declined", 1, false, false, (w, c) => Told(w, w.Rig.Kid, NotifyKind.Declined)) },
    };

    private static AlertPath Notice(string outcome) => new()
    {
        Name = "notice-" + outcome,
        Kind = outcome,
        Title = Keys[0],
        Target = w => w.Rig.Kid,
        Points = new[] { new Point("meta:kid#1", "DeliverRequestNoticesCoreAsync:_titleMeta#3"), new Point("prepare:kid#1", "DeliverRequestNoticesCoreAsync:PrepareVisibilityAsync#3") },
        Setup = async () =>
        {
            var w = await ReadyProvenanceAndWaitsTests.JeWorld();
            var id = await w.Ask(w.Rig.Kid, Keys[0], "kid-0");
            await w.Service.DeliverRequestNoticesAsync(w.Rig.Arr.Now, default);
            await w.Decide(id, outcome);
            return (w, new Ctx());
        },
        Run = (w, ctx) => w.Service.DeliverRequestNoticesAsync(w.Rig.Arr.Now, default),
        Next = async (w, ctx) =>
        {
            w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(6);
            await w.Step(false);
        },
        Units = ctx => new[] { new Unit(outcome, 2, false, false, (w, c) => Told(w, w.Rig.Kid, outcome)) },
    };

    // A second administrator, Sam (asked after Jake: the administrators' order); Jake has a phone and e-mail.
    private static void Admins(World w)
    {
        var sam = w.Rig.Sam;
        w.Rig.Users.AdminIds.Add(sam.UserId);
        w.Rig.Users.Names[sam.UserId] = "Sam";
        w.Policy.People[sam.UserId] = new(sam.UserId, "Admin", true, true, true, true, "p1", "je", "inst", "g1", 1000, 7, 0, "{}");
        w.Rig.Phones(w.Rig.Admin);
    }

    private static AlertPath AskJe() => new()
    {
        Name = "ask-je",
        Kind = NotifyKind.Approval,
        Title = Keys[0],
        Target = w => w.Rig.Admin,
        Points = new[]
        {
            new Point("prepare:jake#1", "DeliverRequestNoticesCoreAsync:PrepareVisibilityAsync#1"), new Point("meta:jake#1", "DeliverRequestNoticesCoreAsync:_titleMeta#1"),
            new Point("prepare:sam#1", "DeliverRequestNoticesCoreAsync:PrepareVisibilityAsync#1"), new Point("meta:sam#1", "DeliverRequestNoticesCoreAsync:_titleMeta#1"),
        },
        Setup = async () =>
        {
            var w = await ReadyProvenanceAndWaitsTests.JeWorld();
            Admins(w);
            await w.Ask(w.Rig.Kid, Keys[0], "kid-0");
            return (w, new Ctx());
        },
        Run = (w, ctx) => w.Service.DeliverRequestNoticesAsync(w.Rig.Arr.Now, default),
        Next = (w, ctx) => w.Service.DeliverRequestNoticesAsync(w.Rig.Arr.Now, default),
        Units = ctx => new[] { new Unit("ask", 4, false, true, (w, c) => Told(w, w.Rig.Admin, NotifyKind.Approval)) },
    };

    // F83: a request held because its episode can't be matched to Sonarr's by id tells the administrators (an attention alert):
    // their view of the title prepared and its name read for each of them, then the final gate after the last await.
    private static AlertPath HeldJe() => new()
    {
        Name = "held-je",
        Kind = NotifyKind.Attention,
        Title = Keys[0],
        Target = w => w.Rig.Admin,
        Points = new[]
        {
            new Point("prepare:jake#1", "DeliverRequestNoticesCoreAsync:PrepareVisibilityAsync#2"), new Point("meta:jake#1", "DeliverRequestNoticesCoreAsync:_titleMeta#2"),
            new Point("prepare:sam#1", "DeliverRequestNoticesCoreAsync:PrepareVisibilityAsync#2"), new Point("meta:sam#1", "DeliverRequestNoticesCoreAsync:_titleMeta#2"),
        },
        Setup = async () =>
        {
            var w = await ReadyProvenanceAndWaitsTests.JeWorld();
            Admins(w);
            var id = await w.Ask(w.Rig.Kid, Keys[0], "kid-0");
            await w.Decide(id, NotifyKind.Approved);
            await w.Service.DeliverRequestNoticesAsync(w.Rig.Arr.Now, default);
            // Its send is held: the episode couldn't be matched by id (nothing went out).
            var job = w.Ledger!.ForWant(id).Single(j => j.State == "queued");
            Assert.True(w.Ledger.Claim(job, w.Rig.Db.Generation, w.Rig.Arr.Now));
            Assert.True(w.Ledger.Complete(job, w.Rig.Db.Generation, BackendResults.Hold(EpisodeIdentity.Unresolved, "Held"), w.Rig.Arr.Now));
            return (w, new Ctx());
        },
        Run = (w, ctx) => w.Service.DeliverRequestNoticesAsync(w.Rig.Arr.Now, default),
        Next = (w, ctx) => w.Service.DeliverRequestNoticesAsync(w.Rig.Arr.Now, default),
        Units = ctx => new[] { new Unit("held", 4, false, true, (w, c) => Told(w, w.Rig.Admin, NotifyKind.Attention)) },
    };

    private static AlertPath AskSeerr() => new()
    {
        Name = "ask-seerr",
        Kind = NotifyKind.Approval,
        Title = Keys[0],
        Target = w => w.Rig.Admin,
        Points = new[] { new Point("prepare:jake#1", "PrepareAskVisibilityAsync:PrepareVisibilityAsync#2") },
        Setup = async () =>
        {
            var w = new World(await IntegrationNotificationsTests.Started(), jeMode: false);
            w.Rig.Phones(w.Rig.Admin);
            w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(1);
            return (w, new Ctx());
        },
        Run = async (w, ctx) =>
        {
            w.Rig.Seerr.Requests.Add(FakeSeerr.Request(7, "movie", 7100, 1, w.Rig.Kid.UserId, w.Rig.Arr.Now.UtcDateTime, userName: "Kid"));
            await w.Step(false);
        },
        Next = async (w, ctx) =>
        {
            await w.Step(false);
            await w.Step(false);
        },
        Units = ctx => new[] { new Unit("ask", 1, false, true, (w, c) => Told(w, w.Rig.Admin, NotifyKind.Approval)) },
    };

    private static AlertPath DeclineSeerr() => new()
    {
        Name = "decline-seerr",
        Kind = NotifyKind.Declined,
        Title = Keys[0],
        Target = w => w.Rig.Kid,
        Points = new[] { new Point("prepare:kid#1", "PrepareAskVisibilityAsync:PrepareVisibilityAsync#1") },
        Setup = async () =>
        {
            var w = new World(await IntegrationNotificationsTests.Started(), jeMode: false);
            var kid = w.Rig.Kid.UserId;
            w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(1);
            w.Rig.Seerr.Requests.Add(FakeSeerr.Request(7, "movie", 7100, 1, kid, w.Rig.Arr.Now.UtcDateTime, userName: "Kid"));
            await w.Step(false);
            w.Rig.Seerr.Requests.Clear();
            w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(1);
            w.Rig.Seerr.Requests.Add(FakeSeerr.Request(7, "movie", 7100, 3, kid, w.Rig.Arr.Now.UtcDateTime.AddMinutes(-1), w.Rig.Arr.Now.UtcDateTime, userName: "Kid"));
            return (w, new Ctx());
        },
        Run = async (w, ctx) =>
        {
            await w.Step(false);
            await w.Step(false);
        },
        Next = async (w, ctx) =>
        {
            w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(6);
            await w.Step(false);
            await w.Step(false);
        },
        Units = ctx => new[] { new Unit("declined", 1, false, false, (w, c) => Told(w, w.Rig.Kid, NotifyKind.Declined)) },
    };

    private const string Queue = "arr:/api/v3/queue#1";

    private static AlertPath Remind() => new()
    {
        Name = "remind",
        Kind = NotifyKind.Remind,
        Title = Dune,
        Target = w => w.Rig.Admin,
        Points = new[] { new Point(Queue, "RemindCoreAsync:CurrentAsync"), new Point("prepare:jake#1", "RemindCoreAsync:PrepareVisibilityAsync"), new Point("prepare:sam#1", "RemindCoreAsync:PrepareVisibilityAsync") },
        Setup = async () =>
        {
            var w = new World(await IntegrationNotificationsTests.Started(r => r.Request(1, 693134, r.Emma)), jeMode: false);
            w.Rig.Radarr.Queue.Add(FakeArr.RadarrQueueRow(2, 693134, "Dune Part Two", state: "importBlocked", status: "warning"));
            await w.Rig.Store.RefreshForEventAsync(w.Rig.Arr.Instance("RadarrZ").Id, ArrSnapshotKind.Queue, force: true);
            Admins(w);
            // The queue goes cold (past its longest serve time): the reminder's status read waits for Radarr.
            w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(11);
            return (w, new Ctx());
        },
        Run = async (w, ctx) => Assert.Contains((await w.Service.RemindAsync(w.Rig.Emma, TitleKey.Parse(Dune)!, null, default)).Code, new[] { "ok", "disabled" }),
        Next = (w, ctx) => w.Service.RemindAsync(w.Rig.Emma, TitleKey.Parse(Dune)!, null, default),
        Units = ctx => new[] { new Unit("remind", 3, false, true, (w, c) => Told(w, w.Rig.Admin, NotifyKind.Remind)) },
    };

    private static AlertPath Ready() => new()
    {
        Name = "ready",
        Kind = NotifyKind.Ready,
        Title = Dune,
        InLibrary = true,
        Target = w => w.Rig.Emma,
        Points = new[] { new Point(Queue, "EvaluateMovieAsync:ComposeForAsync") },
        Setup = async () =>
        {
            var w = new World(await IntegrationNotificationsTests.Started(r => r.Request(1, 693134, r.Emma)), jeMode: false);
            await w.Service.EvaluateAsync(new[] { Dune }, null, default);
            w.Rig.Arrive(Dune);
            // The queue goes cold (past its longest serve time): the look waits for Radarr.
            w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(11);
            return (w, new Ctx());
        },
        Run = (w, ctx) => w.Service.EvaluateAsync(new[] { Dune }, null, default),
        Next = (w, ctx) => w.Service.EvaluateAsync(new[] { Dune }, null, default),
        Units = ctx => new[] { new Unit("ready", 1, false, false, (w, c) => Told(w, w.Rig.Emma, NotifyKind.Ready)) },
    };

    private static AlertPath Episodes() => new()
    {
        Name = "episodes",
        Kind = NotifyKind.Episodes,
        Title = Severance,
        InLibrary = true,
        Target = w => w.Rig.Emma,
        // No await of its own: the batch waits its window, then the flush decides (synchronously, in a later round).
        Points = new[] { new Point("window") },
        Setup = async () =>
        {
            var w = new World(await IntegrationNotificationsTests.Started(), jeMode: false);
            var series = Guid.NewGuid();
            w.Rig.View.AddCopy(TitleKey.Parse(Severance)!, new JfCopy { ItemId = series, Path = "/tv/Severance", DateCreated = w.Rig.Arr.Now.UtcDateTime.AddDays(-30) });
            w.Rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = w.Rig.Arr.Now.UtcDateTime.AddDays(-30) });
            Assert.Equal("ok", await w.Service.SetFollowAsync(w.Rig.Emma, TitleKey.Parse(Severance)!, true, default));
            w.Rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 2, DateCreated = w.Rig.Arr.Now.UtcDateTime });
            await w.Service.EvaluateAsync(new[] { Severance }, null, default);
            Assert.Equal(0, w.Rows(w.Rig.Emma, NotifyKind.Episodes));
            w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(11);
            return (w, new Ctx { SeriesCopy = series });
        },
        Run = (w, ctx) =>
        {
            w.Service.FlushBatches(w.Rig.Arr.Now);
            return Task.CompletedTask;
        },
        Next = (w, ctx) =>
        {
            w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(6);
            w.Service.FlushBatches(w.Rig.Arr.Now);
            return Task.CompletedTask;
        },
        Units = ctx => new[] { new Unit("episodes", 1, false, false, (w, c) => Told(w, w.Rig.Emma, NotifyKind.Episodes)) },
    };

    // A native Ready message (4f-r9-1): Emma's Ready alert with a native message for her idle session; the point is the session
    // re-read right before the claim (inside the send: the claim decides with no await before the host call).
    private static AlertPath Native() => new()
    {
        Name = "native",
        Kind = NotifyKind.Ready,
        Title = Dune,
        InLibrary = true,
        Target = w => w.Rig.Emma,
        Points = new[] { new Point("reread#1", "DeliverDisplayAsync:SendAsync") },
        Setup = async () =>
        {
            var w = new World(await IntegrationNotificationsTests.Started(r => r.Request(1, 693134, r.Emma)), jeMode: false);
            w.Rig.Config.ArrPhase4ReadyMessagesEnabled = true;
            w.Rig.Prefs(w.Rig.Emma, p => p.NativeReadyMessages = true);
            await w.Service.EvaluateAsync(new[] { Dune }, null, default);
            w.Rig.Arrive(Dune);
            await w.Service.EvaluateAsync(new[] { Dune }, null, default);
            var row = Assert.Single(w.Rig.NotifyStore.Inbox(w.Rig.Emma.UserId, null, 500), r => r.Kind == NotifyKind.Ready);
            var ctx = new Ctx();
            ctx.Rows[Dune] = row.Id;
            Assert.Equal("pending", DeliveryOf(w, row.Id, NotifyChannel.DisplayMessage));
            w.Sessions.Add(w.Rig.Emma.UserId, "tv", w.Rig.Arr.Now.UtcDateTime);
            return (w, ctx);
        },
        Run = RunDispatcher,
        Next = async (w, ctx) =>
        {
            w.Rig.Arr.Now = w.Rig.Arr.Now.AddMinutes(1);
            w.Sessions.Add(w.Rig.Emma.UserId, "tv", w.Rig.Arr.Now.UtcDateTime);
            await w.Dispatcher.RunOnceAsync(default);
            // Delivered once: a further round sends nothing more.
            await w.Dispatcher.RunOnceAsync(default);
            Assert.True(w.Sessions.Sent.Count <= 1, "native messages sent: " + w.Sessions.Sent.Count.ToString(CultureInfo.InvariantCulture));
        },
        Units = ctx => new[] { new Unit("native", 1, false, false, (w, c) => DeliveryOf(w, c.Rows[Dune], NotifyChannel.DisplayMessage), Native: true) },
    };

    internal static readonly AlertPath[] Paths =
    {
        Single(NotifyKind.Declined), Single(NotifyKind.Approved), Summary(), Fallback(), WaitRetry(), Notice(NotifyKind.Declined), Notice(NotifyKind.Approved),
        AskJe(), HeldJe(), AskSeerr(), DeclineSeerr(), Remind(), Ready(), Episodes(), Native(),
    };

    public static IEnumerable<object[]> Cells()
        => from path in Paths
           from point in path.Points
           from mutation in Enum.GetValues<Mutation>()
           select new object[] { path.Name, point.Label, mutation.ToString() };

    [Theory]
    [MemberData(nameof(Cells))]
    public async Task EachMutationAtEachAwaitIsDecidedAtTheAction(string pathName, string pointLabel, string mutationName)
    {
        var path = Paths.Single(p => p.Name == pathName);
        var index = Array.FindIndex(path.Points, p => p.Label == pointLabel);
        var mutation = Enum.Parse<Mutation>(mutationName);
        var (w, ctx) = await path.Setup();
        using (w)
        {
            var probe = new Probe();
            path.Arm?.Invoke(w, ctx, probe);
            probe.Armed = pointLabel == "window" ? null : pointLabel;
            probe.Apply = () => Apply(path, w, ctx, mutation);
            Install(w, probe);
            if (pointLabel == "window") Apply(path, w, ctx, mutation);
            await path.Run(w, ctx);
            Uninstall(w);
            Assert.True(pointLabel == "window" || probe.Fired, $"{pathName}: the point {pointLabel} was never reached (reached: {string.Join(", ", probe.Trace)})");

            var units = path.Units(ctx);
            var first = units.Select(u => (u, Expected(u, mutation, index), Got: u.Observe(w, ctx))).ToList();
            Undo(path, w, ctx, mutation);
            await path.Next(w, ctx);
            var problems = new List<string>();
            foreach (var (unit, expected, got) in first)
            {
                var then = unit.Observe(w, ctx);
                if (got != expected.First || then != expected.Then)
                    problems.Add($"{unit.Name}: expected {expected.First} then {expected.Then}, got {got} then {then}");
            }

            foreach (var hidden in ctx.Hidden)
            {
                foreach (var channel in new[] { NotifyChannel.Ntfy, NotifyChannel.Email })
                {
                    if (DeliveryOf(w, ctx.Rows[hidden], channel) != "suppressed") problems.Add($"hidden {hidden} {channel}: not suppressed");
                }
            }

            Assert.True(problems.Count == 0, $"{pathName} @ {pointLabel} × {mutationName}: " + string.Join("; ", problems));
        }
    }

    // ================================================================== every await is a point

    /// <summary>
    /// The alert paths' await sites (method:callee, numbered where a method awaits the same callee twice), each either a point
    /// of the model (the probe labels that stand for it), composite (an await of another listed method: its own awaits are the
    /// points) or excluded with its reason.
    /// </summary>
    internal static readonly Dictionary<string, string> Sites = new(StringComparer.Ordinal)
    {
        // NotifyDispatcher: single, summary, fallback, native messages.
        ["RunOnceAsync:WaitAsync"] = "excluded: the round's lock, taken before the round reads anything",
        ["RunOnceAsync:DeliverDisplayAsync"] = "composite",
        ["RunOnceAsync:DeliverSummaryAsync"] = "composite",
        ["RunOnceAsync:DeliverAsync"] = "composite",
        ["DeliverAsync:PrepareOutcomeAsync"] = "point",
        ["DeliverAsync:SendAsync"] = "point",
        ["DeliverSummaryAsync:PrepareOutcomeAsync"] = "point",
        ["DeliverSummaryAsync:DeliverAsync"] = "point",
        ["DeliverSummaryAsync:SendAsync"] = "point",
        ["PrepareOutcomeAsync:PrepareVisibilityAsync"] = "point",
        ["SendAsync:NtfySender.SendAsync"] = "point",
        ["SendAsync:EmailSender.SendAsync"] = "point",
        ["DeliverDisplayAsync:SendAsync"] = "point",
        // NotificationService: asks, outcomes, the wait queue, Remind, Ready, new episodes, administrators' checks.
        ["TickCoreAsync:WaitAsync"] = "excluded: the round's lock, taken before the round reads anything",
        ["TickCoreAsync:PrepareAskVisibilityAsync"] = "composite",
        ["TickCoreAsync:DeliverRequestNoticesCoreAsync"] = "composite",
        ["TickCoreAsync:RetryAlertWaitsCoreAsync"] = "composite",
        ["TickCoreAsync:PrepareLaterAsync"] = "composite",
        ["TickCoreAsync:EvaluateCoreAsync"] = "composite",
        ["TickCoreAsync:AdminChecksCoreAsync"] = "composite",
        ["PrepareAskVisibilityAsync:PrepareVisibilityAsync#1"] = "point",
        ["PrepareAskVisibilityAsync:PrepareVisibilityAsync#2"] = "point",
        ["DeliverRequestNoticesCoreAsync:PrepareVisibilityAsync#1"] = "point",
        ["DeliverRequestNoticesCoreAsync:_titleMeta#1"] = "point",
        ["DeliverRequestNoticesCoreAsync:PrepareVisibilityAsync#2"] = "point",
        ["DeliverRequestNoticesCoreAsync:_titleMeta#2"] = "point",
        ["DeliverRequestNoticesCoreAsync:_titleMeta#3"] = "point",
        ["DeliverRequestNoticesCoreAsync:PrepareVisibilityAsync#3"] = "point",
        ["RetryAlertWaitsCoreAsync:PrepareVisibilityAsync"] = "point",
        ["PrepareLaterAsync:PrepareVisibilityAsync"] = "excluded: a preparation for the bell's next read; nothing is decided or written after it in that function",
        ["EvaluateCoreAsync:EvaluateMovieAsync"] = "composite",
        ["EvaluateMovieAsync:ComposeForAsync"] = "point",
        ["RemindCoreAsync:CurrentAsync"] = "point",
        ["RemindCoreAsync:PrepareVisibilityAsync"] = "point",
        ["SetFollowCoreAsync:EvaluateCoreAsync"] = "composite",
        ["AdminChecksCoreAsync:NeedsAttentionAsync"] = "excluded: administrators' outage, disk and attention alerts (no title visibility, Hidden Content or request); decided by the final gate after the read (walk) and r8's TheAdministratorsOutageAlertIsDecidedOnTheSettingsAfterTheAttentionRead",
    };

    [Fact]
    public void EveryAwaitInventoryRejectsAnAwaitAddedToTheForwardedCore()
    {
        const string signature = "private async Task TickCoreAsync(CancellationToken cancellationToken, bool force)\n        {";
        var planted = NotifyGateWalk.Plugin.With("NotificationService.cs", source =>
            source.Replace(signature, signature + "\n            await Task.Delay(1).ConfigureAwait(false);", StringComparison.Ordinal));
        Assert.Empty(planted.Errors());
        var unknown = planted.AwaitSites().Except(Sites.Keys).ToList();
        Assert.Contains("TickCoreAsync:Delay", unknown);
    }

    [Fact]
    public void EveryAwaitOnTheAlertPathsIsAPointOfTheModel()
    {
        var found = NotifyGateWalk.Plugin.AwaitSites();
        var unknown = found.Where(s => !Sites.ContainsKey(s)).ToList();
        var gone = Sites.Keys.Where(s => !found.Contains(s)).ToList();
        Assert.True(unknown.Count == 0 && gone.Count == 0, "awaits not in the model: " + string.Join(", ", unknown) + "; listed but not found: " + string.Join(", ", gone));
        var pointed = Paths.SelectMany(p => p.Points).SelectMany(p => p.Sites).ToHashSet(StringComparer.Ordinal);
        var unpointed = Sites.Where(s => s.Value == "point" && !pointed.Contains(s.Key)).Select(s => s.Key).ToList();
        Assert.True(unpointed.Count == 0, "awaits with no point in any path: " + string.Join(", ", unpointed));
        Assert.True(Cells().Count() >= 280, "cells: " + Cells().Count().ToString(CultureInfo.InvariantCulture));
    }
}
