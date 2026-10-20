using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;

namespace JE.Tests;

/// <summary>
/// Runs a few operations on their own threads, one step at a time, in every order a bounded search generates: each
/// operation stops at its own points and at every interleaving point the access-stamp helper names, and the search
/// tries every schedule with at most <see cref="Run"/>'s preemption bound (a switch away from an operation that could
/// have gone on). Stateless: each schedule runs from scratch.
/// </summary>
internal sealed class Interleavings
{
    [ThreadStatic]
    private static Worker? _current;

    private readonly List<Worker> _workers = new();
    private readonly SemaphoreSlim _back = new(0);

    private sealed class Worker
    {
        public required string Name { get; init; }

        public SemaphoreSlim Go { get; } = new(0);

        public bool Done { get; set; }

        public Exception? Failed { get; set; }
    }

    /// <summary>Called by an operation (or the helper's step hook) at a point another operation may run.</summary>
    public void Yield()
    {
        var me = _current;
        if (me == null) return;
        _back.Release();
        if (!me.Go.Wait(TimeSpan.FromSeconds(30))) throw new TimeoutException("not scheduled");
    }

    /// <summary>
    /// Every schedule of <paramref name="operations"/> with at most <paramref name="preemptions"/> preemptions: for each,
    /// <paramref name="make"/> builds a fresh world, the operations run in that order and <paramref name="check"/> judges
    /// the world once they have all finished. Returns how many schedules ran.
    /// </summary>
    public static int Run<TWorld>(Func<Interleavings, TWorld> make, IReadOnlyList<(string Name, Action<TWorld> Body)> operations, Action<TWorld, string> check, int preemptions = 2, int cap = 50000)
    {
        var pending = new Stack<List<int>>();
        pending.Push(new List<int>());
        var runs = 0;
        while (pending.Count > 0)
        {
            if (++runs > cap) throw new InvalidOperationException("more than " + cap + " schedules: lower the bound");
            var prefix = pending.Pop();
            var scheduler = new Interleavings();
            var world = make(scheduler);
            var trace = scheduler.Once(world, operations, prefix);
            var description = string.Join(" ", trace.Select(t => operations[t.Chosen].Name));
            check(world, description);
            for (var i = prefix.Count; i < trace.Count; i++)
            {
                foreach (var other in trace[i].Enabled)
                {
                    if (other == trace[i].Chosen) continue;
                    var previous = i > 0 ? trace[i - 1].Chosen : -1;
                    var cost = previous >= 0 && other != previous && trace[i].Enabled.Contains(previous) ? 1 : 0;
                    if (trace[i].Preempted + cost > preemptions) continue;
                    pending.Push(trace.Take(i).Select(t => t.Chosen).Append(other).ToList());
                }
            }
        }

        return runs;
    }

    private sealed record Decision(int Chosen, int[] Enabled, int Preempted);

    private List<Decision> Once<TWorld>(TWorld world, IReadOnlyList<(string Name, Action<TWorld> Body)> operations, List<int> prefix)
    {
        var threads = new List<Thread>();
        foreach (var (name, body) in operations)
        {
            var worker = new Worker { Name = name };
            _workers.Add(worker);
            var thread = new Thread(() =>
            {
                _current = worker;
                try
                {
                    if (!worker.Go.Wait(TimeSpan.FromSeconds(30))) throw new TimeoutException("never scheduled");
                    body(world);
                }
                catch (Exception ex)
                {
                    worker.Failed = ex;
                }
                finally
                {
                    worker.Done = true;
                    _current = null;
                    _back.Release();
                }
            }) { IsBackground = true, Name = "interleaving " + name };
            threads.Add(thread);
            thread.Start();
        }

        var trace = new List<Decision>();
        var preempted = 0;
        var last = -1;
        while (true)
        {
            var enabled = Enumerable.Range(0, _workers.Count).Where(i => !_workers[i].Done).ToArray();
            if (enabled.Length == 0) break;
            var chosen = trace.Count < prefix.Count ? prefix[trace.Count] : (last >= 0 && enabled.Contains(last) ? last : enabled[0]);
            if (!enabled.Contains(chosen)) throw new InvalidOperationException("schedule replay diverged");
            trace.Add(new Decision(chosen, enabled, preempted));
            if (last >= 0 && chosen != last && enabled.Contains(last)) preempted++;
            last = chosen;
            _workers[chosen].Go.Release();
            if (!_back.Wait(TimeSpan.FromSeconds(30))) throw new TimeoutException("an operation never reached its next point");
        }

        foreach (var thread in threads) thread.Join();
        var failed = _workers.FirstOrDefault(w => w.Failed != null);
        if (failed != null) throw new InvalidOperationException(failed.Name + " failed", failed.Failed);
        return trace;
    }
}

/// <summary>
/// Review round 3 (COREUC-R3-1): the helper's invalidation bookkeeping under every bounded interleaving of rollovers
/// (the record bound reached), full invalidations, a computation and a watched-state save. Whatever the order, once all
/// have finished an entry served is the state as it now is, and a computation begun afterwards is served.
/// </summary>
[Collection("Jellyfin user versions")]
public class UserAccessCacheInterleavingTests(Xunit.Abstractions.ITestOutputHelper output)
{
    private sealed class World
    {
        public World(Interleavings scheduler, int records)
        {
            Scheduler = scheduler;
            Cache = new UserAccessCache<Guid, bool>(TimeSpan.FromMinutes(5), 16, null, null, records, _ => scheduler.Yield());
            // The record bound reached: the next invalidation rolls over.
            for (var i = 0; i < records; i++) Cache.Invalidate(Guid.NewGuid(), Guid.NewGuid());
        }

        public Interleavings Scheduler { get; }

        public UserAccessCache<Guid, bool> Cache { get; }

        public Guid Season { get; } = Guid.NewGuid();

        public User Viewer { get; } = UserChange.Read(Guid.NewGuid());

        // Whether the viewer has watched an episode of the season (what the cached answer says).
        public volatile bool Watched = true;
    }

    private static readonly (string Name, Action<World> Body) Rollover = ("rollover", w => w.Cache.Invalidate(Guid.NewGuid(), Guid.NewGuid()));

    private static readonly (string Name, Action<World> Body) Everything = ("all", w => w.Cache.InvalidateAll());

    // A request: the ticket, then the query reads the watched state, then the answer is stored.
    private static readonly (string Name, Action<World> Body) Compute = ("compute", w =>
    {
        var ticket = w.Cache.Begin(w.Viewer, w.Season);
        w.Scheduler.Yield();
        var answer = w.Watched;
        w.Scheduler.Yield();
        w.Cache.Set(w.Viewer.Id, ticket, answer);
    });

    // A watched-state save: Jellyfin writes it, then JE invalidates the viewer's season inline.
    private static readonly (string Name, Action<World> Body) Save = ("save", w =>
    {
        w.Watched = false;
        w.Scheduler.Yield();
        w.Cache.Invalidate(w.Viewer.Id, w.Season);
    });

    public static TheoryData<string> Scenarios => new()
    {
        "rollover rollover compute save",
        "rollover compute save",
        "all compute save",
        "rollover all compute save",
        "all all compute save",
        "rollover compute save compute",
    };

    [Theory]
    [MemberData(nameof(Scenarios))]
    public void NoInterleavingOfRolloversAndASaveLeavesAnAnswerFromBeforeTheSave(string scenario)
    {
        var operations = scenario.Split(' ').Select(name => name switch
        {
            "rollover" => Rollover,
            "all" => Everything,
            "compute" => Compute,
            "save" => Save,
            _ => throw new ArgumentOutOfRangeException(nameof(scenario)),
        }).ToList();
        var runs = Interleavings.Run(scheduler => new World(scheduler, records: 2), operations, (world, schedule) =>
        {
            var authority = world.Cache.Begin(world.Viewer).Authority;
            if (world.Cache.TryGet(world.Viewer.Id, authority, out var served))
                Assert.True(served == world.Watched, "served " + served + " after the save, schedule: " + schedule);
            // And the cache still works: a computation begun now is served.
            var ticket = world.Cache.Begin(world.Viewer, world.Season);
            world.Cache.Set(world.Viewer.Id, ticket, world.Watched);
            Assert.True(world.Cache.TryGet(world.Viewer.Id, authority, out served) && served == world.Watched, "a fresh answer isn't served, schedule: " + schedule);
        });
        output.WriteLine(scenario + ": " + runs + " schedules");
        Assert.True(runs > 1);
    }
}
