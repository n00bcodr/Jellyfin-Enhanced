using System.Globalization;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using static JE.Tests.ListsHarness;

namespace JE.Tests;

// Review round 2 (4c1, BY DESIGN (e)): the one list access gate, table-driven. Every list path that writes to Jellyfin or
// answers with list contents runs once to find every await it passes (Seerr parental and metadata reads, status reads,
// Jellyfin's own writes, request preparation, the list lock); then once per await with a change injected right there:
// the caller's share revoked (collections: the collection hidden), their limits lowered (a rated title blocked, library
// items hidden) or the playlist's owner changed. After the change:
// - every Jellyfin write must still be allowed by the state at that moment (who it runs as, the principal's right to
//   edit, every item open to both);
// - the answer may hold no list contents the caller can't see now (none at all once the list is lost);
// - the document gains no placeholder the caller can't see now, and nothing at all after the list was lost.
// Review round 3 adds: the caller disabled, the playlist's owner disabled (no write may run as them), and two creators of
// one name racing, the rival starting at every await of the first create.
// Review round 4 adds "create-recover": the retry of a collection create that died after Jellyfin made the list and before
// it was recorded. Its Revoke hides that list from the creator (who still manages collections), and the rename that gives
// the list its name is a write like any other: allowed only while the creator can see and edit the list.
[Collection("Plugin singleton")]
public class ListsGateTableTests
{
    public enum Change
    {
        Revoke,
        Limits,
        Owner,
        Disable,
        OwnerDisabled,
    }

    private static readonly string[] Paths =
    {
        "add", "apply", "apply-jf10", "apply-collection", "patch-link", "delete", "reorder", "swap-switch", "view",
        "preview", "submit", "create-playlist", "create-collection", "create-replay", "op-replay", "swap-pass", "swap-jf10",
        "create-recover",
    };

    public static IEnumerable<object[]> Rows() =>
        from path in Paths
        from change in new[] { Change.Revoke, Change.Limits, Change.Owner, Change.Disable, Change.OwnerDisabled }
        where change is not (Change.Owner or Change.OwnerDisabled) || !(path.Contains("collection", StringComparison.Ordinal) || path.StartsWith("create", StringComparison.Ordinal))
        select new object[] { path, change };

    [Theory]
    [MemberData(nameof(Rows))]
    public async Task AChangeAtAnyAwaitIsSeenBeforeTheNextWriteAndTheAnswer(string path, Change change)
    {
        int points;
        bool locks;
        using (var control = new Rig(path))
        {
            var answer = await control.Run();
            points = control.Probe.Seen.Count;
            locks = control.Locks;
            Assert.True(control.Probe.Violations.Count == 0, "control run: " + string.Join("; ", control.Probe.Violations));
            Assert.True(control.Check(change, answer).Count == 0, "control run answer: " + string.Join("; ", control.Check(change, answer)));
        }

        // A path whose only wait is the list lock (lookups answered from caches complete at once) still gets the lock row.
        Assert.True(points > 0 || locks, "the path passed no await point");
        var failures = new List<string>();
        for (var at = 0; at <= points; at++)
        {
            using var rig = new Rig(path);
            object? answer;
            try
            {
                if (at == 0)
                {
                    // The list lock: the change lands while the path waits for it (paths that don't wait are skipped).
                    if (!rig.Locks)
                    {
                        continue;
                    }

                    Task<object?> running;
                    using (await rig.H.Store.LockAsync(rig.ListIdN))
                    {
                        running = rig.Run();
                        if (running.IsCompleted)
                        {
                            await running;
                            continue;
                        }

                        rig.Probe.ChangeNow(() => rig.Apply(change), "lock");
                    }

                    answer = await running;
                }
                else
                {
                    rig.Probe.Target = at;
                    rig.Probe.Change = () => rig.Apply(change);
                    answer = await rig.Run();
                }
            }
            catch (Exception ex) when (ex is not Xunit.Sdk.XunitException)
            {
                failures.Add($"@{at} {rig.Probe.Point}: threw {ex.GetType().Name}: {ex.Message}");
                continue;
            }

            failures.AddRange(rig.Probe.Violations.Select(v => $"@{at} {rig.Probe.Point}: {v}"));
            failures.AddRange(rig.Check(change, answer).Select(v => $"@{at} {rig.Probe.Point}: {v}"));
        }

        Assert.True(failures.Count == 0, $"{path} × {change} ({points} await points):\n" + string.Join("\n", failures));
    }

    public static IEnumerable<object[]> RaceRows() =>
        from kind in new[] { ListKinds.Playlist, ListKinds.Collection }
        from rival in new[] { "je", "hand" }
        select new object[] { kind, rival };

    // Two creators of one name: while the first create waits at any of its awaits, another collection manager creates a
    // list of the same name through JE ("je"), or someone makes one in Jellyfin itself, hidden from the first ("hand").
    // Neither list is replaced: every create that answers 200 has its own list with its own entries, and the hand-made one
    // keeps its name and members.
    [Theory]
    [MemberData(nameof(RaceRows))]
    public async Task TwoCreatorsOfOneNameNeverReplaceEachOtherAtAnyAwait(string kind, string rival)
    {
        var path = kind == ListKinds.Playlist ? "create-playlist" : "create-collection";
        int points;
        using (var control = new Rig(path))
        {
            Ok<CreateListResultDto>((ListOutcome)(await control.Run())!);
            points = control.Probe.Seen.Count;
        }

        Assert.True(points > 0, "the create passed no await point");
        var failures = new List<string>();
        for (var at = 1; at <= points; at++)
        {
            using var rig = new Rig(path);
            rig.H.Host.OnWrite = null; // the rival writes as itself
            var name = "Fresh " + kind;
            var rivalUser = rig.H.NewUser("rival", collections: true);
            var member = rig.H.Host.AddItem();
            Task<ListOutcome>? theirs = null;
            Guid? handMade = null;
            rig.Probe.Target = at;
            rig.Probe.Change = () =>
            {
                if (rival == "je")
                {
                    theirs = rig.H.Service.CreateListAsync(rivalUser, kind, name, false, new[] { new ApplyEntry(0, member, null) }, K("rival-1"), CancellationToken.None);
                    return;
                }

                handMade = (kind == ListKinds.Playlist
                    ? rig.H.Host.CreateHandMadePlaylistAsync(name, rivalUser.Id)
                    : rig.H.Host.CreateHandMadeCollectionAsync(name)).GetAwaiter().GetResult();
                rig.H.Host.Lists[handMade.Value].Raw.Add(new RawEntry(member, true));
                rig.H.Host.ListHiddenFrom[rig.Caller.Id] = new HashSet<Guid> { handMade.Value };
            };

            ListOutcome mine;
            ListOutcome? other;
            try
            {
                mine = (ListOutcome)(await rig.Run())!;
                other = theirs == null ? null : await theirs;
            }
            catch (Exception ex) when (ex is not Xunit.Sdk.XunitException)
            {
                failures.Add($"@{at} {rig.Probe.Point}: threw {ex.GetType().Name}: {ex.Message}");
                continue;
            }

            var made = new List<Guid>();
            foreach (var (outcome, item, who) in new[] { (mine, rig.RealB, "the first"), (other, member, "the rival") })
            {
                if (outcome == null)
                {
                    continue;
                }

                if (outcome.StatusCode == 200)
                {
                    var id = Guid.Parse(((CreateListResultDto)outcome.Value!).ListId);
                    if (!rig.H.Host.Lists.ContainsKey(id) || !rig.H.Host.Resolved(id).Contains(item))
                    {
                        failures.Add($"@{at} {rig.Probe.Point}: {who} answered 200 but its list doesn't hold its entry");
                    }

                    made.Add(id);
                }
                else if (!(outcome.StatusCode == 409 && outcome.Value is ListErrorDto { Code: "name_taken" }))
                {
                    failures.Add($"@{at} {rig.Probe.Point}: {who} answered {outcome.StatusCode}");
                }
            }

            if (made.Count != made.Distinct().Count())
            {
                failures.Add($"@{at} {rig.Probe.Point}: two creates answered with the same list");
            }

            if (handMade is { } hand)
            {
                if (!rig.H.Host.Lists.TryGetValue(hand, out var list) || list.Info.Name != name || !rig.H.Host.Resolved(hand).SequenceEqual(new[] { member }))
                {
                    failures.Add($"@{at} {rig.Probe.Point}: the hand-made list was replaced or changed");
                }

                if (made.Contains(hand))
                {
                    failures.Add($"@{at} {rig.Probe.Point}: JE answered with the hand-made list");
                }
            }
        }

        Assert.True(failures.Count == 0, $"{kind} × {rival} ({points} await points):\n" + string.Join("\n", failures));
    }

    /// <summary>Counts await points; at the target one it makes the change; records Jellyfin writes and asks.</summary>
    internal sealed class Probe
    {
        private readonly object _gate = new();
        private int _sequence;

        public List<string> Seen { get; } = new();

        public int Target { get; set; } = -1;

        public Action? Change { get; set; }

        public bool Changed { get; private set; }

        public string? Point { get; private set; }

        /// <summary>Snapshot taken when the change was made (see <see cref="Rig.Snapshot"/>).</summary>
        public Func<object>? Snapshotter { get; set; }

        public object? Snapshot { get; private set; }

        public int WritesBeforeChange { get; private set; }

        public List<string> Violations { get; } = new();

        public List<string> Writes { get; } = new();

        public void Hit(string where)
        {
            lock (_gate)
            {
                Seen.Add(where);
                if (!Changed && Seen.Count == Target)
                {
                    ChangeNow(Change!, where);
                }
            }
        }

        public void ChangeNow(Action change, string where)
        {
            lock (_gate)
            {
                Point = where;
                WritesBeforeChange = Writes.Count;
                change();
                Changed = true;
                Snapshot = Snapshotter?.Invoke();
                _sequence++;
            }
        }

        public void Write(string what, string? violation)
        {
            lock (_gate)
            {
                Writes.Add(what);
                if (violation != null)
                {
                    Violations.Add($"{what} after the change: {violation}");
                }
            }
        }
    }

    /// <summary>One path's world: a playlist (or collection) with real rows and placeholders, a restricted editor.</summary>
    internal sealed class Rig : IDisposable
    {
        private static readonly CancellationToken None = CancellationToken.None;
        private readonly string _path;
        private readonly ListAcquisition _acquisition;
        private readonly RequestLedger _ledger;
        private readonly IntegrationRequestLedgerTests.Policy _policy = new();
        private readonly Placeholder _g = Movie(910, "2020-01-01");
        private readonly Placeholder _r = Movie(911, "2020-01-01");
        private readonly Placeholder _custom;
        private readonly Placeholder _season = Ph("{\"kind\":\"season\",\"tmdbId\":1600,\"seasonNumber\":1,\"title\":\"Show S1\",\"releaseDate\":\"2020-01-01\"}");
        private readonly List<Guid> _episodes = new();
        private ListAccess _access;

        public Rig(string path)
        {
            _path = path;
            H.Plugin.Plugin.Configuration.ArrPhase4ListStatusEnabled = true;
            H.Plugin.Plugin.Configuration.ArrPhase4ListRequestsEnabled = true;
            H.Plugin.Plugin.Configuration.ArrPhase4ListRequestAllEnabled = true;
            foreach (var (tmdb, cert) in new[] { (901, "G"), (902, "G"), (910, "G"), (911, "R"), (912, "R"), (913, "G") })
            {
                H.MovieCertifications[tmdb] = cert;
            }

            Owner = H.NewUser("owner");
            Caller = H.NewUser("editor", collections: true, maxRating: 17);
            NewOwner = H.NewUser("heir");
            _custom = Ph("{\"kind\":\"custom\",\"title\":\"Mine\"}", Caller.Id.ToString("N"));
            RealX = H.Host.AddItem();
            RealY = H.Host.AddItem();
            RealA = H.Host.AddItem(tmdb: 901);
            RealB = H.Host.AddItem();
            _ledger = new RequestLedger(H.Database);
            var requests = new RequestService(_ledger, _policy, new FakeJellyfinView(), new ArrChangeFeed(), () => DateTimeOffset.UtcNow);
            _acquisition = new ListAcquisition(H.Store, H.Access, requests, new RequestOperations(H.Database), new ListLinks(H.Database), H.Plugin.Core.Logger);
            _policy.People[Caller.Id] = new RequestPolicyFacts(Caller.Id, "Member", true, false, false, true, "p1", "je", "r1", "g1", 7, 7, 0, "{\"score\":5}");
            H.Status.ByKey["movie:tmdb:910"] = "{\"stage\":\"asked\"}";
            H.Status.ByKey["movie:tmdb:911"] = "{\"stage\":\"asked\"}";
            H.Host.SupportsPositionalInsert = !path.EndsWith("jf10", StringComparison.Ordinal);

            if (Collection)
            {
                List = H.Host.AddCollection("Heist films");
                List.Raw.Add(new RawEntry(RealX, true));
            }
            else
            {
                List = H.Host.AddPlaylist(Owner, false, new ListShare(Caller.Id, true));
                List.Raw.AddRange(new[] { new RawEntry(RealX, true), new RawEntry(RealY, true) });
            }

            _access = H.AccessFor(List, Caller);
            Seed().GetAwaiter().GetResult();
            Prepare().GetAwaiter().GetResult();
            Wire();
        }

        public ListsHarness H { get; } = new(seerr: true, status: true);

        public Probe Probe { get; } = new();

        public User Owner { get; }

        public User Caller { get; }

        public User NewOwner { get; }

        public FakeListHost.FakeList List { get; }

        public Guid RealX { get; }

        public Guid RealY { get; }

        public Guid RealA { get; }

        public Guid RealB { get; }

        public string ListIdN => List.Info.Id.ToString("N");

        public bool Collection => _path.Contains("collection", StringComparison.Ordinal) && _path != "create-playlist";

        public bool Swap => _path.StartsWith("swap-", StringComparison.Ordinal) && _path != "swap-switch";

        /// <summary>Paths that take the list lock (the lock row injects while they wait for it).</summary>
        public bool Locks => _path is not ("view" or "preview" or "submit" or "create-playlist" or "create-collection" or "create-replay" or "create-recover");

        private string? CreatedId { get; set; }

        // The lists the path may have created (create paths) or the rig's list.
        private IEnumerable<Guid> Watched => _path.StartsWith("create", StringComparison.Ordinal)
            ? H.Host.Lists.Keys.Where(id => id != List.Info.Id).ToList()
            : new[] { List.Info.Id };

        public void Apply(Change change)
        {
            switch (change)
            {
                case Change.Revoke:
                    if (_path is "create-playlist")
                    {
                        H.Users.Setup(u => u.GetUserById(Caller.Id)).Returns((User?)null);
                    }
                    else if (_path is "create-recover")
                    {
                        // The recovered collection is hidden from its creator, who still manages collections.
                        foreach (var id in H.Host.Lists.Keys.Where(id => id != List.Info.Id))
                        {
                            Hidden(id);
                        }
                    }
                    else if (_path is "create-collection" or "create-replay")
                    {
                        Caller.SetPermission(PermissionKind.EnableCollectionManagement, false);
                        foreach (var id in H.Host.Lists.Keys.Where(id => id != List.Info.Id))
                        {
                            Hidden(id);
                        }
                    }
                    else if (Collection)
                    {
                        Hidden(List.Info.Id);
                    }
                    else
                    {
                        List.Info = List.Info with { Shares = Array.Empty<ListShare>() };
                    }

                    break;
                case Change.Limits:
                    Caller.MaxParentalRatingScore = 10;
                    foreach (var item in new[] { RealA, RealB, RealY })
                    {
                        H.Host.Hide(item, Caller);
                    }

                    // Swap-in runs as the owner: the arriving episodes are hidden from the owner instead.
                    if (Swap || _path == "patch-link")
                    {
                        foreach (var item in _episodes.Append(RealA))
                        {
                            H.Host.Hide(item, Owner);
                        }
                    }

                    break;
                case Change.Owner:
                    foreach (var item in _episodes.Concat(new[] { RealA, RealB, RealX, RealY }))
                    {
                        H.Host.Hide(item, NewOwner);
                    }

                    List.Info = List.Info with { OwnerId = NewOwner.Id };
                    break;
                case Change.Disable:
                    Caller.SetPermission(PermissionKind.IsDisabled, true);
                    break;
                case Change.OwnerDisabled:
                    Owner.SetPermission(PermissionKind.IsDisabled, true);
                    break;
            }
        }

        public async Task<object?> Run()
        {
            switch (_path)
            {
                case "add":
                    return await H.Service.AddPlaceholdersAsync(_access, new[] { Movie(901, "2020-01-01"), Movie(912, "2020-01-01"), Movie(913, "2020-01-01") }, null, null, K("add-1"), None, recheckAccess: true);
                case "apply":
                case "apply-jf10":
                    return await H.Service.ApplyAsync(_access, new[] { new ApplyEntry(0, RealB, null), new ApplyEntry(1, null, Movie(913, "2020-01-01")), new ApplyEntry(2, null, Movie(912, "2020-01-01")) }, new PositionDto { AtStart = true }, null, K("apply-1"), None, recheckAccess: true);
                case "apply-collection":
                    return await H.Service.ApplyAsync(_access, new[] { new ApplyEntry(0, RealB, null), new ApplyEntry(1, null, Movie(913, "2020-01-01")), new ApplyEntry(2, null, Movie(912, "2020-01-01")) }, null, null, K("apply-1"), None, recheckAccess: true);
                case "patch-link":
                    return await H.Service.PatchAsync(_access, _custom.Id, Rev, null, Movie(901, "2020-01-01"), K("patch-1"), None);
                case "delete":
                    return await H.Service.DeleteAsync(_access, _g.Id, Rev, K("delete-1"), None);
                case "reorder":
                    return await H.Service.ReorderAsync(_access, Rev, new[] { E(RealY), E(RealX), P(_g.Id), P(_r.Id), P(_custom.Id) }, E(RealY), K("order-1"), None);
                case "swap-switch":
                    return await H.Service.SetSwapInAsync(_access, Rev, false, K("swap-1"), None);
                case "view":
                    return await H.Service.ViewAsync(_access, None);
                case "preview":
                    return await _acquisition.PreviewAsync(_access, null, true, None);
                case "submit":
                    var submitted = await _acquisition.SubmitAsync(_access, "confirm-1", new[] { _g.Id, _r.Id }, None);
                    // As the route does: the answer's view is read after the asks.
                    var view = await H.Service.ViewAsync(_access, None);
                    return (submitted, view);
                case "create-playlist":
                case "create-collection":
                    var kind = _path == "create-playlist" ? ListKinds.Playlist : ListKinds.Collection;
                    var created = await H.Service.CreateListAsync(Caller, kind, "Fresh " + kind, false, new[] { new ApplyEntry(0, RealB, null), new ApplyEntry(1, null, Movie(913, "2020-01-01")), new ApplyEntry(2, null, Movie(912, "2020-01-01")) }, K("create-1"), None);
                    return created;
                case "create-replay":
                    return await H.Service.CreateListAsync(Caller, ListKinds.Collection, "Replayed", false, new[] { new ApplyEntry(0, null, Movie(911, "2020-01-01")) }, K("create-r"), None);
                case "create-recover":
                    return await H.Service.CreateListAsync(Caller, ListKinds.Collection, "Recovered", false, new[] { new ApplyEntry(0, RealB, null), new ApplyEntry(1, null, Movie(913, "2020-01-01")) }, K("create-c"), None);
                case "op-replay":
                    return await H.Service.AddPlaceholdersAsync(_access, new[] { Movie(913, "2020-01-01") }, null, null, K("replayed"), None, recheckAccess: true);
                case "swap-pass":
                case "swap-jf10":
                    return await H.Swap.RunListPassAsync(ListIdN, null, MetadataMode.None, None);
                default:
                    throw new InvalidOperationException(_path);
            }
        }

        /// <summary>What the answer and the documents may hold after the change.</summary>
        public List<string> Check(Change change, object? answer)
        {
            var problems = new List<string>();
            if (!Probe.Changed)
            {
                return problems;
            }

            var views = Views(answer).ToList();
            switch (change)
            {
                case Change.Revoke:
                case Change.Disable:
                    if (views.Count > 0)
                    {
                        problems.Add($"answered with {views.Count} view(s) of a list the caller lost");
                    }

                    if (answer is ListOutcome { Value: ListRequestPreviewDto })
                    {
                        problems.Add("answered a preview of a list the caller lost");
                    }

                    if (!Swap && Probe.Snapshot is Dictionary<Guid, string> before)
                    {
                        foreach (var (id, state) in Snapshot())
                        {
                            var was = before.TryGetValue(id, out var old) ? old : string.Empty;
                            // Once a Jellyfin write had started, recording what it did is the write's own result (an entry
                            // retired by its swap-in); nothing new may be added. With nothing written, nothing may change.
                            var added = Placeholders(state).Split(',').Except(Placeholders(was).Split(',')).Where(x => x.Length > 0).ToList();
                            if (Probe.WritesBeforeChange == 0 ? Placeholders(state) != Placeholders(was) : added.Count > 0)
                            {
                                problems.Add($"list {Short(id)}'s entries changed after the caller lost it: [{Placeholders(was)}] -> [{Placeholders(state)}]");
                            }

                            if (Probe.WritesBeforeChange == 0 && state != was && _path != "view")
                            {
                                problems.Add($"list {Short(id)} changed after the caller lost it with nothing written to Jellyfin before");
                            }
                        }
                    }

                    break;
                case Change.Limits:
                    foreach (var view in views)
                    {
                        foreach (var placeholder in view.Placeholders.Where(p => p.TmdbId is 911 or 912))
                        {
                            problems.Add($"answered the blocked title {placeholder.TmdbId}");
                        }

                        foreach (var token in (view.Order ?? new List<string>()).Where(t => t == E(RealA) || t == E(RealB) || t == E(RealY)))
                        {
                            problems.Add($"answered the hidden row {token[..8]}");
                        }
                    }

                    if (answer is ListOutcome { Value: ListRequestPreviewDto preview } && preview.Items.Any(i => i.PlaceholderId == _r.Id))
                    {
                        problems.Add("previewed the blocked title 911");
                    }

                    if (!Swap && Probe.Snapshot is Dictionary<Guid, string> limited)
                    {
                        foreach (var (id, state) in Snapshot())
                        {
                            var was = limited.TryGetValue(id, out var old) ? old : string.Empty;
                            if (Placeholders(state).Contains("912", StringComparison.Ordinal) && !Placeholders(was).Contains("912", StringComparison.Ordinal))
                            {
                                problems.Add($"list {Short(id)} got the blocked title 912 after the limit");
                            }
                        }
                    }

                    break;
            }

            return problems;
        }

        public void Dispose() => H.Dispose();

        // Each watched list: "placeholders | order" (placeholders as kind:tmdb:note).
        internal Dictionary<Guid, string> Snapshot() => Watched.ToDictionary(
            id => id,
            id => H.Store.Load(id.ToString("N")) is { } doc
                ? string.Join(",", doc.Items.Select(p => p.Kind + ":" + p.TmdbId + ":" + p.Note).OrderBy(x => x, StringComparer.Ordinal)) + " | " + string.Join(",", doc.Order)
                : string.Empty);

        private static string Placeholders(string state) => state.Split(" | ")[0];

        private static string Short(Guid id) => id.ToString("N")[..6];

        private int Rev => H.Store.Load(ListIdN)!.Rev;

        private static IEnumerable<ListViewDto> Views(object? answer)
        {
            switch (answer)
            {
                case ListViewDto view:
                    yield return view;
                    break;
                case ListOutcome outcome:
                    foreach (var view in Views(outcome.Value))
                    {
                        yield return view;
                    }

                    break;
                case ApplyResultDto { View: { } applied }:
                    yield return applied;
                    break;
                case CreateListResultDto { Result.View: { } created }:
                    yield return created;
                    break;
                case ListErrorDto { View: { } error }:
                    yield return error;
                    break;
                case ListRequestSubmitDto { View: { } submitted }:
                    yield return submitted;
                    break;
                case ValueTuple<ListOutcome, ListViewDto?> pair:
                    foreach (var view in Views(pair.Item1).Concat(Views(pair.Item2)))
                    {
                        yield return view;
                    }

                    break;
            }
        }

        private void Hidden(Guid listId)
        {
            if (!H.Host.ListHiddenFrom.TryGetValue(Caller.Id, out var set))
            {
                H.Host.ListHiddenFrom[Caller.Id] = set = new HashSet<Guid>();
            }

            set.Add(listId);
        }

        private async Task Seed()
        {
            using (await H.Store.LockAsync(ListIdN))
            {
                var doc = H.Store.LoadForUpdate(ListIdN, List.Info.Kind);
                foreach (var item in new[] { _g, _r, _custom })
                {
                    doc.Items.Add(item);
                    if (!Collection)
                    {
                        doc.Order.Add(P(item.Id));
                    }
                }

                if (!Collection)
                {
                    doc.Order.InsertRange(0, new[] { E(RealX), E(RealY) });
                }

                if (Swap)
                {
                    // Show S1: E2 is in the list already; E1 and E3 arrive (two insertion runs around E2).
                    var series = H.Host.AddSeries(tmdb: 1600);
                    var e1 = H.Host.AddEpisode(series, 1, 1);
                    var e2 = H.Host.AddEpisode(series, 1, 2);
                    var e3 = H.Host.AddEpisode(series, 1, 3);
                    _episodes.AddRange(new[] { e1, e3 });
                    _season.Expected = Enumerable.Range(1, 3).Select(e => new PlaceholderEpisode { S = 1, E = e, AirDate = "2020-01-01" }).ToList();
                    _season.InProduction = false;
                    _season.Filled.Add(new FilledEpisode { ItemId = e2.ToString("N"), S = 1, E = 2 });
                    List.Raw.Add(new RawEntry(e2, true));
                    doc.Items.Add(_season);
                    doc.Order.Add(E(e2));
                    doc.Order.Add(P(_season.Id));
                }

                if (_path is "swap-pass" or "swap-jf10" or "patch-link")
                {
                    doc.SwapIn = new ListConsent { ByUserId = Caller.Id.ToString("N"), At = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) };
                }

                if (_path == "swap-switch")
                {
                    doc.SwapIn = new ListConsent { ByUserId = Caller.Id.ToString("N"), At = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) };
                }

                H.Store.Save(doc);
            }
        }

        // What happened before the path runs (outside the probe): the completed operations replays answer from.
        private async Task Prepare()
        {
            if (_path == "create-replay")
            {
                var created = Ok<CreateListResultDto>(await H.Service.CreateListAsync(Caller, ListKinds.Collection, "Replayed", false, new[] { new ApplyEntry(0, null, Movie(911, "2020-01-01")) }, K("create-r"), None));
                CreatedId = created.ListId;
            }

            if (_path == "create-recover")
            {
                // The first attempt died right after Jellyfin made the collection, before it was recorded.
                H.Host.AfterCreate = _ => throw new IOException("the server stopped");
                try
                {
                    await H.Service.CreateListAsync(Caller, ListKinds.Collection, "Recovered", false, new[] { new ApplyEntry(0, RealB, null), new ApplyEntry(1, null, Movie(913, "2020-01-01")) }, K("create-c"), None);
                    throw new InvalidOperationException("the first attempt didn't die");
                }
                catch (IOException)
                {
                }
                finally
                {
                    H.Host.AfterCreate = null;
                }
            }

            if (_path == "op-replay")
            {
                Ok<ApplyResultDto>(await H.Service.AddPlaceholdersAsync(_access, new[] { Movie(913, "2020-01-01") }, null, null, K("replayed"), None, recheckAccess: true));
            }
        }

        private void Wire()
        {
            Probe.Snapshotter = Snapshot;
            var reply = H.Reply;
            H.ReplyAsync = (request, _) =>
            {
                Probe.Hit("seerr " + request.RequestUri!.AbsolutePath);
                return Task.FromResult(reply(request));
            };
            H.Status.During = () => Probe.Hit("status");
            H.Host.OnAwait = where => Probe.Hit("jellyfin " + where);
            H.Host.OnWrite = (op, list, actAs, items) => Probe.Write($"{op} {string.Join(",", items.Select(Short))}", Probe.Changed ? Invalid(op, list, actAs, items) : null);
            _policy.Before = (user, input) =>
            {
                if (_path == "submit")
                {
                    Probe.Write("ask " + input.Key, Probe.Changed ? InvalidAsk(input) : null);
                }

                Probe.Hit("prepare");
                return Task.CompletedTask;
            };
            _policy.Visibility = (_, _) =>
            {
                Probe.Hit("visibility");
                return Task.CompletedTask;
            };
        }

        // Whether a Jellyfin write is allowed by the state right now (null: allowed).
        private string? Invalid(string op, Guid listId, Guid actAs, IReadOnlyList<Guid> items)
        {
            var principal = H.Users.Object.GetUserById(Caller.Id);
            if (principal != null && principal.HasPermission(PermissionKind.IsDisabled))
            {
                return Swap ? "the consenting editor is disabled" : "the caller is disabled";
            }

            if (op == "finish")
            {
                var made = H.Host.GetList(listId);
                return principal == null ? "the caller is gone"
                    : made == null ? "the list is gone"
                    : !H.Access.Evaluate(made, principal).Permissions.CanEdit ? "renames a list the caller can't see or edit"
                    : made.Kind == ListKinds.Collection ? (ListAccessService.CanManageCollections(principal) ? null : "the caller can't manage collections")
                    : made.OwnerId == principal.Id && actAs == principal.Id ? null : "renames a playlist that isn't the caller's";
            }

            if (op.StartsWith("create", StringComparison.Ordinal))
            {
                return principal == null ? "the caller is gone"
                    : op == "create-collection" && !ListAccessService.CanManageCollections(principal) ? "the caller can't manage collections"
                    : null;
            }

            var list = H.Host.GetList(listId);
            if (list == null)
            {
                return "the list is gone";
            }

            if (principal == null || !H.Access.Evaluate(list, principal).Permissions.CanEdit)
            {
                return Swap ? "the consenting editor can't edit the list" : "the caller can't edit the list";
            }

            if (op == "collection")
            {
                return Swap || items.All(i => H.Host.CanAccessItem(i, principal)) ? null : "an item the caller can't open";
            }

            var owner = H.Users.Object.GetUserById(list.OwnerId);
            var native = H.Access.Evaluate(list, principal).Permissions.NativeCanEdit;
            if (op == "move" && actAs == principal.Id && native && !Swap)
            {
                return items.All(i => H.Host.IsEntryVisible(i, principal)) ? null : "moves a row the caller can't see";
            }

            if (owner == null || actAs != owner.Id)
            {
                return $"runs as {Short(actAs)}, not the current owner";
            }

            if (owner.HasPermission(PermissionKind.IsDisabled))
            {
                return "runs as a disabled owner";
            }

            if (!items.All(i => H.Host.CanAccessItem(i, owner)))
            {
                return "an item the owner can't open";
            }

            return Swap || op == "move" || _path == "patch-link" || items.All(i => H.Host.CanAccessItem(i, principal)) ? null : "an item the caller can't open";
        }

        // Whether an ask is allowed now: the caller still sees the list and the entry's title.
        private string? InvalidAsk(MutationInput input)
        {
            var principal = H.Users.Object.GetUserById(Caller.Id);
            var list = H.Host.GetList(List.Info.Id);
            if (principal == null || list == null || principal.HasPermission(PermissionKind.IsDisabled) || !H.Access.Evaluate(list, principal).Permissions.CanView)
            {
                return "the caller lost the list";
            }

            return input.Key == "movie:tmdb:911" && principal.MaxParentalRatingScore is < 17 ? "a title the caller's limits block" : null;
        }
    }
}
