using System.Text;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Stamps;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Moq;

namespace JE.Tests;

/// <summary>
/// Every cache the plugin keeps is listed (tests/fixtures/user-caches/user-caches.tsv) with why it can't serve an answer
/// from before a change to a user's access: declared as the access-stamp helper (Helpers/UserAccessCache.cs), keyed by the
/// viewer's access as the asking request read it, or independent of access for a stated reason. The list is checked
/// against the plugin's own source (<see cref="UserCacheScan"/>), so a new cache can't be missed by a manual sweep.
/// </summary>
public class UserCacheRegistryTests
{
    internal sealed record Row(string Member, string Build, string Class, string Key, string Reason, string Rules = "")
    {
        /// <summary>The value of a rule ("write:…", "snapshot:…"; several snapshot rules may be given).</summary>
        internal IEnumerable<string> Rule(string name)
            => Rules.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Where(r => r.StartsWith(name + ":", StringComparison.Ordinal)).Select(r => r[(name.Length + 1)..]);
    }

    private static string Build => Environment.Version.Major >= 10 ? "jf12" : "jf10";

    internal static List<Row> Registry()
        => File.ReadAllLines(Path.Combine(AppContext.BaseDirectory, "fixtures", "user-caches", "user-caches.tsv"))
            .Where(l => l.Length > 0 && !l.StartsWith('#')).Select(l => l.Split('\t')).Select(c => new Row(c[0], c[1], c[2], c[3], c[4], c.ElementAtOrDefault(5) ?? string.Empty)).ToList();

    /// <summary>What is wrong with the registry for <paramref name="plugin"/> (empty: nothing).</summary>
    internal static List<string> Problems(WriteGateWalk plugin, IReadOnlyList<Row> registry)
    {
        var problems = new List<string>();
        var rows = new Dictionary<string, Row>(StringComparer.Ordinal);
        foreach (var row in registry)
        {
            if (!rows.TryAdd(row.Member, row)) problems.Add(row.Member + ": listed twice");
            if (row.Class is not ("stamped" or "keyed" or "ticketed" or "independent")) problems.Add(row.Member + ": unknown class " + row.Class);
            // Round 4: "invalidated on every write" isn't a reason a cache can't serve what it read before the write.
            if (row.Class == "independent" && System.Text.RegularExpressions.Regex.IsMatch(row.Reason, "invalidated on (every )?write|dropped when the file is saved|invalidated by every"))
                problems.Add(row.Member + ": independent because it is \"invalidated on write\": a read from before the write is stored after it; put it on the ticket protocol (WrittenStateCache)");
            if (row.Build is not ("both" or "jf12")) problems.Add(row.Member + ": unknown build " + row.Build);
            if (string.IsNullOrWhiteSpace(row.Key) || string.IsNullOrWhiteSpace(row.Reason)) problems.Add(row.Member + ": no key or reason");
        }

        var found = UserCacheScan.Caches(plugin);
        foreach (var cache in found)
        {
            if (!rows.TryGetValue(cache.Member, out var row))
            {
                problems.Add(cache.Member + " (" + cache.Where + ", " + cache.Type + "): a cache nobody listed; declare it as UserAccessCache if a user's access decides what it holds, else list why it doesn't");
                continue;
            }

            if (row.Class == "stamped" && !cache.Stamped) problems.Add(cache.Member + " (" + cache.Where + "): listed as stamped but declared as " + cache.Type + ", not UserAccessCache");
            if (row.Class != "stamped" && cache.Stamped) problems.Add(cache.Member + " (" + cache.Where + "): declared as UserAccessCache but listed as " + row.Class);
            var written = cache.Ticketed && !cache.Stamped;
            if (row.Class == "ticketed" && !written) problems.Add(cache.Member + " (" + cache.Where + "): listed as ticketed but declared as " + cache.Type + ", not WrittenStateCache");
            if (row.Class != "ticketed" && written) problems.Add(cache.Member + " (" + cache.Where + "): declared as WrittenStateCache but listed as " + row.Class);
            if (row.Class == "keyed")
            {
                foreach (var via in row.Reason.Split(','))
                {
                    var (method, text) = (via.Split('~')[0], via.Split('~').ElementAtOrDefault(1) ?? string.Empty);
                    var bodies = Methods(plugin, method);
                    if (bodies.Count == 0) problems.Add(cache.Member + ": its key builder " + method + " isn't in the plugin");
                    else if (text.Length == 0 || !bodies.All(b => b.Contains(text, StringComparison.Ordinal))) problems.Add(cache.Member + ": its key builder " + method + " no longer keys by " + text);
                }
            }
        }

        // Round 4: no invalidate-only caches. Dropped outside the code that fills it: the ticket protocol, or a disposition
        // the scan can check (fenced, locked) or a reason why no stale read can be put back.
        foreach (var (member, drops) in UserCacheScan.Invalidations(plugin, found))
        {
            if (!rows.TryGetValue(member, out var row)) continue;
            var write = row.Rule("write").FirstOrDefault();
            if (write == null) problems.Add(member + " is dropped outside the code that fills it (" + drops.Sites + "): an invalidate-only cache, whose reader can put back what it read before the write; declare it as WrittenStateCache or give it a write: disposition");
            else problems.AddRange(UserCacheScan.CheckWrite(plugin, drops, write));
        }

        // Round 5: a fence is sampled before the inputs it covers are read, and a kept answer lives from when its read began.
        foreach (var row in registry.Where(r => rows.ContainsKey(r.Member) && found.Any(c => c.Member == r.Member)))
        {
            foreach (var write in row.Rule("write").Where(w => w.StartsWith("fenced=", StringComparison.Ordinal) && w.Length > "fenced=".Length))
                problems.AddRange(UserCacheScan.LateFences(plugin, row.Member, write["fenced=".Length..]));
        }

        foreach (var late in UserCacheScan.LateStamps(plugin, found))
        {
            if (rows.TryGetValue(late.Cache, out var row) && row.Rule("deadline").Any(d => d.Length > 0)) continue;
            problems.Add(late.ToString());
        }

        // Round 6: an answer that depends on the person's Seerr account keeps the account authority it was read under (or
        // is keyed by it), and an instant a cache keeps for its lifetime is on the monotonic clock, like the cache's own.
        foreach (var cache in found)
        {
            if (!rows.TryGetValue(cache.Member, out var row)) continue;
            var authority = row.Rule("authority").ToList();
            if ((row.Reason + " " + row.Key).Contains("Seerr account", StringComparison.Ordinal) && authority.Count == 0)
                problems.Add(cache.Member + ": depends on the person's Seerr account but names no authority: rule (held, or key=Type.Method~text): a cold or held answer outlives a fresh read that finds the link changed");
            foreach (var rule in authority)
            {
                if (rule == "held")
                {
                    if (!UserCacheScan.HoldsAuthority(cache)) problems.Add(cache.Member + " (" + cache.Where + "): listed as holding the person's Seerr account authority, but what it keeps holds no SeerrAccountAuthority.Ticket");
                }
                else if (rule.StartsWith("key=", StringComparison.Ordinal))
                {
                    var via = rule["key=".Length..];
                    var (method, text) = (via.Split('~')[0], via.Split('~').ElementAtOrDefault(1) ?? string.Empty);
                    var bodies = Methods(plugin, method);
                    if (bodies.Count == 0 || text.Length == 0 || !bodies.All(b => b.Contains(text, StringComparison.Ordinal)))
                        problems.Add(cache.Member + ": its key builder " + method + " no longer keys by the person's Seerr account authority (" + text + ")");
                }
                else
                {
                    problems.Add(cache.Member + ": unknown authority rule " + rule);
                }
            }

            if ((authority.Count > 0 || row.Class == "ticketed") && !row.Rule("wall").Any(w => w.Length > 0))
            {
                foreach (var instant in UserCacheScan.WallInstants(cache))
                    problems.Add(cache.Member + " (" + cache.Where + "): keeps " + instant + " on the wall clock inside a cache counted on the monotonic one: a wall-clock step lengthens or shortens its lifetime; keep MonotonicClock ticks (a calendar date: wall:<reason>)");
            }
        }

        // Round 4: a decision and its key come from one snapshot.
        var keyed = registry.Where(r => r.Class == "keyed" && (r.Build == "both" || r.Build == Build) && rows.ContainsKey(r.Member)).Select(r => new UserCacheScan.Keyed(r.Member,
            new[] { r.Member[..r.Member.LastIndexOf('.')] }.Concat(r.Reason.Split(',').Select(v => v.Split('~')[0]).Where(m => m.Contains('.')).Select(m => m[..m.LastIndexOf('.')])).Distinct(StringComparer.Ordinal).ToList(),
            r.Rule("snapshot").ToHashSet(StringComparer.Ordinal)));
        problems.AddRange(UserCacheScan.ReReads(plugin, keyed));

        var names = found.Select(c => c.Member).ToHashSet(StringComparer.Ordinal);
        foreach (var row in registry.Where(r => (r.Build == "both" || r.Build == Build) && !names.Contains(r.Member)))
            problems.Add(row.Member + ": listed, but the plugin has no such cache (" + Build + ")");
        return problems;
    }

    // The bodies of the methods "Type.Method" names (overloads included).
    private static List<string> Methods(WriteGateWalk plugin, string name)
    {
        var (type, method) = (name[..name.LastIndexOf('.')], name[(name.LastIndexOf('.') + 1)..]);
        return plugin.Sources().SelectMany(s => s.Tree.GetRoot().DescendantNodes().OfType<MethodDeclarationSyntax>()
                .Where(m => m.Identifier.ValueText == method && s.Model.GetDeclaredSymbol(m) is { } symbol && UserCacheScan.Name(symbol.ContainingType) == type))
            .Select(m => m.ToString()).ToList();
    }

    [Fact]
    public void EveryCacheIsStampedKeyedOrIndependentWithAReason()
    {
        var problems = Problems(WriteGateWalk.Plugin, Registry());
        Assert.True(problems.Count == 0, string.Join(Environment.NewLine, problems));
    }

    [Fact]
    public void TheScanFindsTheCachesThatHoldAUsersAccess()
    {
        var found = UserCacheScan.Caches(WriteGateWalk.Plugin).ToDictionary(c => c.Member, StringComparer.Ordinal);
        // Round 2's miss is found, and is the helper.
        Assert.True(found["SpoilerBlurImageFilter._watchedCache"].Stamped);
        foreach (var stamped in Registry().Where(r => r.Class == "stamped" && (r.Build == "both" || r.Build == Build))) Assert.True(found[stamped.Member].Stamped, stamped.Member);
        // A table nothing writes after it is made isn't a cache.
        Assert.DoesNotContain("UserAuthorityFields.Entity", found.Keys);
        Assert.DoesNotContain("SpoilerBlurImageFilter._imageActions", found.Keys);
    }

    private const string Filter = "Services/SpoilerGuard/SpoilerBlurImageFilter.cs";

    [Fact]
    public void APlantedUnregisteredCacheFails()
    {
        // A per-(user, season) answer kept in a plain dictionary, written at run time.
        var planted = WriteGateWalk.Plugin.With(Filter, s => s.Replace(
            "        private static readonly TimeSpan SeasonWatchedCacheTtl",
            "        private static readonly System.Collections.Concurrent.ConcurrentDictionary<(Guid, Guid), bool> _plantedSeasons = new();\n        private static readonly TimeSpan SeasonWatchedCacheTtl", StringComparison.Ordinal));
        Assert.Contains(Problems(planted, Registry()), p => p.StartsWith("SpoilerBlurImageFilter._plantedSeasons (", StringComparison.Ordinal) && p.Contains("a cache nobody listed", StringComparison.Ordinal));

        // A readonly Dictionary with an initializer is a cache once something writes it after it is made.
        var written = WriteGateWalk.Plugin.With(Filter, s => s.Replace(
            "        private static readonly TimeSpan SeasonWatchedCacheTtl",
            "        private static readonly Dictionary<Guid, bool> _plantedTable = new() { [Guid.Empty] = false };\n        internal static void Plant(Guid user) => _plantedTable[user] = true;\n        private static readonly TimeSpan SeasonWatchedCacheTtl", StringComparison.Ordinal));
        Assert.Contains(Problems(written, Registry()), p => p.StartsWith("SpoilerBlurImageFilter._plantedTable (", StringComparison.Ordinal));
        // The same table, never written: not a cache.
        var table = WriteGateWalk.Plugin.With(Filter, s => s.Replace(
            "        private static readonly TimeSpan SeasonWatchedCacheTtl",
            "        private static readonly Dictionary<Guid, bool> _plantedTable = new() { [Guid.Empty] = false };\n        internal static bool Plant(Guid user) => _plantedTable.TryGetValue(user, out var v) && v;\n        private static readonly TimeSpan SeasonWatchedCacheTtl", StringComparison.Ordinal));
        Assert.Empty(Problems(table, Registry()));
        // A mutable field holding one user's answer.
        var field = WriteGateWalk.Plugin.With(Filter, s => s.Replace(
            "        private static readonly TimeSpan SeasonWatchedCacheTtl",
            "        private Guid _lastViewer;\n        internal void Plant(Guid user) => _lastViewer = user;\n        private static readonly TimeSpan SeasonWatchedCacheTtl", StringComparison.Ordinal));
        Assert.Contains(Problems(field, Registry()), p => p.StartsWith("SpoilerBlurImageFilter._lastViewer (", StringComparison.Ordinal));
        // A snapshot swapped whole (round 3): a mutable field of the plugin's own type that holds a dictionary.
        var snapshot = WriteGateWalk.Plugin.With(Filter, s => s.Replace(
            "        private static readonly TimeSpan SeasonWatchedCacheTtl",
            "        private sealed record PlantedSnapshot(Dictionary<Guid, bool> Seen);\n        private PlantedSnapshot? _plantedSnapshot;\n        internal void Plant(Guid season) => _plantedSnapshot = new(new() { [season] = true });\n        private static readonly TimeSpan SeasonWatchedCacheTtl", StringComparison.Ordinal));
        Assert.Contains(Problems(snapshot, Registry()), p => p.StartsWith("SpoilerBlurImageFilter._plantedSnapshot (", StringComparison.Ordinal));
    }

    [Fact]
    public void ACacheListedAsStampedMustBeTheHelperAndAKeyedOneMustKeepItsKey()
    {
        // Round 2's season cache as it was: a plain dictionary keyed by (user, season).
        var plain = WriteGateWalk.Plugin.With(Filter, s => s.Replace(
            "private static readonly UserAccessCache<(Guid User, Guid Season), bool> _watchedCache = new(SeasonWatchedCacheTtl, 512);",
            "private static readonly System.Collections.Concurrent.ConcurrentDictionary<(Guid User, Guid Season), bool> _watchedCache = new();", StringComparison.Ordinal));
        Assert.Contains(Problems(plain, Registry()), p => p.StartsWith("SpoilerBlurImageFilter._watchedCache (", StringComparison.Ordinal) && p.Contains("not UserAccessCache", StringComparison.Ordinal));

        // The feed audience keyed by another read of the user (the round 2 race) instead of the user it decides with.
        var audience = WriteGateWalk.Plugin.With("Services/Arr/Live/ArrFeedAudience.cs", s => s.Replace(
            "Acquire.ArrJellyfinView.PolicyRevisionOf(user)", "(_view.Viewer(userId)?.PolicyRevision ?? string.Empty)", StringComparison.Ordinal));
        Assert.Contains(Problems(audience, Registry()), p => p.StartsWith("ArrFeedAudience._cache: its key builder ArrFeedAudience.Visible no longer keys by PolicyRevisionOf(user)", StringComparison.Ordinal));

        // A row whose cache is gone.
        Assert.Contains(Problems(WriteGateWalk.Plugin, Registry().Append(new Row("SpoilerBlurImageFilter._gone", "both", "independent", "user", "x")).ToList()),
            p => p.StartsWith("SpoilerBlurImageFilter._gone: listed, but", StringComparison.Ordinal));
    }
}

/// <summary>
/// Review round 3: a value carries the stamp of the inputs it was computed from. The plugin's source is checked for any
/// version taken apart from the read the value was computed from (<see cref="UserCacheScan.StampSources"/>).
/// </summary>
public class UserCacheStampSourceTests
{
    private const string Resolver = "Services/Acquire/Stamps/AcquisitionStampResolver.cs";
    private const string Fixed = "? _access.GetHeld((user, item), user, () => access.CanOpenAsRead(user, item))";

    [Fact]
    public void EveryCachedValueIsFiledUnderTheVersionItsUserWasReadUnder()
    {
        var problems = UserCacheScan.StampSources(WriteGateWalk.Plugin);
        Assert.True(problems.Count == 0, string.Join(Environment.NewLine, problems));
    }

    [Fact]
    public void AVersionTakenApartFromTheReadFails()
    {
        // Round 3's 4K memo as it was: a fresh version, then the library's (possibly earlier) read of the user.
        var fresh = WriteGateWalk.Plugin.With(Resolver, s => s.Replace(Fixed,
            "? _access.GetHeld((user, item), user, () => { var stamp = Helpers.UserAuthority.Take(user); return (_library.CanOpen(user, item), stamp); })", StringComparison.Ordinal));
        var problems = UserCacheScan.StampSources(fresh);
        Assert.Contains(problems, p => p.Contains("AcquisitionStampResolver.CanOpen samples the person's version itself", StringComparison.Ordinal));
        Assert.Contains(problems, p => p.Contains("AcquisitionStampResolver.CanOpen GetHeld's read must return the value and its version from one call", StringComparison.Ordinal));

        // A read's version put together with an answer from another read.
        var paired = WriteGateWalk.Plugin.With(Resolver, s => s.Replace(Fixed,
            "? _access.GetHeld((user, item), user, () => (_library.CanOpen(user, item), Helpers.UserAuthority.ReadOncePerRequest(user, _ => null).Stamp))", StringComparison.Ordinal));
        Assert.Contains(UserCacheScan.StampSources(paired), p => p.Contains("GetHeld's read must return the value and its version from one call", StringComparison.Ordinal));

        // A made-up version for a held ticket.
        var made = WriteGateWalk.Plugin.With("Services/SpoilerGuard/SpoilerNextUnwatchedService.cs", s => s.Replace(
            "_cache.BeginHeld(userId, read.Stamp, seriesId)", "_cache.BeginHeld(userId, default, seriesId)", StringComparison.Ordinal));
        problems = UserCacheScan.StampSources(made);
        Assert.Contains(problems, p => p.Contains("SpoilerNextUnwatchedService.GetBoundary BeginHeld's version must be the .Stamp of the read", StringComparison.Ordinal));
        Assert.Contains(problems, p => p.Contains("SpoilerNextUnwatchedService.GetBoundary makes a version (default / with)", StringComparison.Ordinal));

        // The user cache stamping its own read afresh.
        var users = WriteGateWalk.Plugin.With("Services/PosterTags/PosterTagUserCache.cs", s => s.Replace(
            "() => UserAuthority.ReadOncePerRequest(userId, _userManager.GetUserById)",
            "() => (_userManager.GetUserById(userId), new UserAuthority.Stamp(0, 0, 0, 0, long.MaxValue))", StringComparison.Ordinal));
        problems = UserCacheScan.StampSources(users);
        Assert.Contains(problems, p => p.Contains("PosterTagUserCache.GetStamped makes a version (new Stamp)", StringComparison.Ordinal));
        Assert.Contains(problems, p => p.Contains("PosterTagUserCache.GetStamped GetHeldStamped's read must return", StringComparison.Ordinal));
    }
}

/// <summary>
/// The helper itself (Helpers/UserAccessCache.cs): what keeps an entry, what ends it, and that a computation running across
/// an invalidation never leaves an entry that is served.
/// </summary>
[Collection("Jellyfin user versions")]
public class UserAccessCacheTests
{
    private static User Read(Guid id, Action<User>? policy = null) => UserChange.Read(id, policy: policy);

    [Fact]
    public async Task AnEntryFollowsTheUserAsReadAndTheirOwnVersion()
    {
        var cache = new UserAccessCache<Guid, int>(TimeSpan.FromMinutes(1), 16);
        var id = Guid.NewGuid();
        var ticket = cache.Begin(Read(id));
        cache.Set(id, ticket, 1);
        Assert.True(cache.TryGet(id, cache.Begin(Read(id)).Authority, out var hit));
        Assert.Equal(1, hit);
        // A silent change (no event, no bracket): the user as read differs.
        Assert.False(cache.TryGet(id, cache.Begin(Read(id, UserChange.Changes["blockedTag"])).Authority, out _));
        // A bracketed change that leaves the access as it was still moves the version.
        await UserChange.PolicyPost(id, () => { });
        Assert.False(cache.TryGet(id, cache.Begin(Read(id)).Authority, out _));
        // Someone else's change doesn't.
        cache.Set(id, cache.Begin(Read(id)), 2);
        await UserChange.PolicyPost(Guid.NewGuid(), () => { });
        Assert.True(cache.TryGet(id, cache.Begin(Read(id)).Authority, out hit));
        Assert.Equal(2, hit);
    }

    [Fact]
    public void AComputationRunningAcrossAnInvalidationIsNeverServed()
    {
        var cache = new UserAccessCache<(Guid, Guid), bool>(TimeSpan.FromMinutes(1), 16);
        var (user, season, series, other) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        var key = (user, season);

        // Begun, then the user's season is invalidated (a watched-state save), then stored: never served.
        var ticket = cache.Begin(Read(user), season, series);
        cache.Invalidate(user, season);
        cache.Set(key, ticket, true);
        Assert.False(cache.TryGet(key, cache.Begin(Read(user)).Authority, out _));

        // The series, for this user.
        ticket = cache.Begin(Read(user), season, series);
        cache.Set(key, ticket, true);
        Assert.True(cache.TryGet(key, ticket.Authority, out _));
        cache.Invalidate(user, series);
        Assert.False(cache.TryGet(key, ticket.Authority, out _));

        // The series, for everyone (a library change).
        ticket = cache.Begin(Read(user), season, series);
        cache.Set(key, ticket, true);
        cache.Invalidate(Guid.Empty, series);
        Assert.False(cache.TryGet(key, ticket.Authority, out _));

        // Another user's or another scope's invalidation leaves it.
        ticket = cache.Begin(Read(user), season, series);
        cache.Set(key, ticket, true);
        cache.Invalidate(other, season);
        cache.Invalidate(user, Guid.NewGuid());
        Assert.True(cache.TryGet(key, ticket.Authority, out _));
        // All of the user's.
        cache.Invalidate(user);
        Assert.False(cache.TryGet(key, ticket.Authority, out _));

        // Everything, begun before it: never served, even stored after.
        ticket = cache.Begin(Read(user), season, series);
        cache.InvalidateAll();
        cache.Set(key, ticket, true);
        Assert.False(cache.TryGet(key, ticket.Authority, out _));
        Assert.Equal(0, cache.Count);
    }

    [Fact]
    public void TooManyInvalidationRecordsEndEveryEntryRatherThanForgetOne()
    {
        var cache = new UserAccessCache<Guid, bool>(TimeSpan.FromMinutes(1), 16);
        var user = Guid.NewGuid();
        var ticket = cache.Begin(Read(user), Guid.NewGuid());
        cache.Set(user, ticket, true);
        for (var i = 0; i < 9000; i++) cache.Invalidate(Guid.NewGuid(), Guid.NewGuid());
        Assert.False(cache.TryGet(user, ticket.Authority, out _));
        // And it keeps working.
        ticket = cache.Begin(Read(user));
        cache.Set(user, ticket, true);
        Assert.True(cache.TryGet(user, ticket.Authority, out _));
    }

    [Fact]
    public async Task AnEntryThatStandsForTheUserFollowsTheirVersionAndNoSuchUserStays()
    {
        var cache = new UserAccessCache<Guid, User?>(TimeSpan.FromMinutes(1), 16, final: u => u == null);
        var (id, gone) = (Guid.NewGuid(), Guid.NewGuid());
        var reads = 0;
        User? Get(Guid user) => cache.GetHeld(user, user, () => { reads++; var stamp = UserAuthority.Take(user); return (user == gone ? null : Read(user), stamp); });
        Get(id);
        Get(id);
        Assert.Equal(1, reads);
        await UserChange.PolicyPost(id, () => { });
        Get(id);
        Assert.Equal(2, reads);
        Get(gone);
        await UserChange.PolicyPost(gone, () => { });
        Get(gone);
        Assert.Equal(3, reads);
        // A held entry is never served for a request that compares a fingerprint, nor the other way round.
        Assert.False(cache.TryGet(id, cache.Begin(Read(id)).Authority, out _));
    }

    [Fact]
    public void AnEntryEndsWithItsLifetimeAndTheCacheStaysBounded()
    {
        var now = 0L;
        using var clock = MonotonicClock.Use(() => now);
        var cache = new UserAccessCache<int, int>(TimeSpan.FromSeconds(30), 4);
        var user = Read(Guid.NewGuid());
        var ticket = cache.Begin(user);
        for (var i = 0; i < 10; i++) cache.Set(i, ticket, i);
        Assert.True(cache.Count <= 4);
        cache.Set(42, ticket, 42);
        Assert.True(cache.TryGet(42, ticket.Authority, out _));
        now += TimeSpan.FromSeconds(30).Ticks;
        Assert.False(cache.TryGet(42, ticket.Authority, out _));
    }
}

/// <summary>
/// Review round 2 (COREUC-R2-2): the fingerprint's encoding. Each value says where it ends, so no tag or other value can
/// pass for the structure and make two different users' fingerprints equal.
/// </summary>
[Collection("Jellyfin user versions")]
public class UserFingerprintEncodingTests
{
    // The finding's pair: delimiter-bearing tags that made two different policies hash identically.
    internal static readonly (string[] Allowed, string[] Blocked)[] Pair =
    [
        (["foo;\u001fKind:BlockedTags;Value:bar"], ["baz"]),
        (["foo"], ["bar;\u001fKind:BlockedTags;Value:baz"]),
    ];

    private static User With(Guid id, string[] allowed, string[] blocked) => UserChange.Read(id, policy: u =>
    {
        u.SetPreference(PreferenceKind.AllowedTags, allowed);
        u.SetPreference(PreferenceKind.BlockedTags, blocked);
    });

    [Fact]
    public void TagsHoldingTheEncodingsCharactersNeverShareAFingerprint()
    {
        var id = Guid.NewGuid();
        Assert.NotEqual(UserAuthority.Fingerprint(With(id, Pair[0].Allowed, Pair[0].Blocked)), UserAuthority.Fingerprint(With(id, Pair[1].Allowed, Pair[1].Blocked)));
        // Other ways one value could pass for another's structure: a separator, a length prefix, a row boundary, a
        // member that looks like a collection.
        var pairs = new (string[] A, string[] B, string[] C, string[] D)[]
        {
            (["a\u001eb"], [], ["a"], ["b"]),
            (["s1:a"], [], ["a"], []),
            (["a}{"], ["b"], ["a"], ["}{b"]),
            (["c1[s1:a]"], [], ["a"], []),
            (["x;"], ["y"], ["x"], [";y"]),
        };
        foreach (var (a, b, c, d) in pairs) Assert.NotEqual(UserAuthority.Fingerprint(With(id, a, b)), UserAuthority.Fingerprint(With(id, c, d)));
        // The same policy is still the same fingerprint (sets compared without their order).
        Assert.Equal(UserAuthority.Fingerprint(With(id, ["b", "a"], ["c"])), UserAuthority.Fingerprint(With(id, ["a", "b"], ["c"])));
    }

    [Fact]
    public void SpoilerGuardsBoundaryMovesWhenOnlyDelimiterBearingTagsChange()
    {
        using var core = new CoreFixture();
        var viewer = Guid.NewGuid();
        var series = Guid.NewGuid();
        var current = With(viewer, Pair[0].Allowed, Pair[0].Blocked);
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(viewer)).Returns(() => current);
        using var next = new SpoilerNextUnwatchedService(Mock.Of<ILibraryManager>(), users.Object, Mock.Of<IUserDataManager>(), core.Logger);
        var computed = 0;
        next.BoundaryComputerForTest = (_, _) => { computed++; return null; };
        next.GetBoundary(viewer, series);
        next.GetBoundary(viewer, series);
        Assert.Equal(1, computed);
        // A silent save (no event, no bracket) to the other policy of the pair: a different boundary input.
        current = With(viewer, Pair[1].Allowed, Pair[1].Blocked);
        next.GetBoundary(viewer, series);
        Assert.Equal(2, computed);
    }

    [Fact]
    public void ThePolicyRevisionEscapesItsSeparatorsAndKeepsEveryOtherRevision()
    {
        var id = Guid.NewGuid();
        string Revision(string[] allowed, string[] blocked)
        {
            var text = new StringBuilder();
            UserAuthority.AppendPolicy(text, With(id, allowed, blocked));
            return text.ToString();
        }

        // Before: blocked "a", "|b" + allowed "c" read the same as blocked "a" + allowed "b", "|c" (Jellyfin keeps
        // a preference as one ','-joined value, so a tag can't hold ',' but can hold '|').
        Assert.NotEqual(Revision(["c"], ["a", "|b"]), Revision(["b", "|c"], ["a"]));
        Assert.NotEqual(Revision(["c"], ["a|"]), Revision(["|c"], ["a"]));
        // A tag without them is written as before, so the revisions stored with existing requests stay what they were.
        var user = With(id, ["kids", "family"], ["horror"]);
        var text = new StringBuilder();
        UserAuthority.AppendPolicy(text, user);
        Assert.Equal(Legacy(user), text.ToString());
    }

    // The arr status viewer's policy text as 14c488fa wrote it.
    private static string Legacy(User user)
    {
        var text = new StringBuilder();
        var allFolders = user.HasPermission(PermissionKind.EnableAllFolders);
        var folders = allFolders ? Array.Empty<Guid>() : user.GetPreferenceValues<Guid>(PreferenceKind.EnabledFolders);
        text.Append(user.HasPermission(PermissionKind.IsAdministrator) ? 'A' : 'U').Append('|').Append(allFolders ? '*' : '-').Append('|');
        foreach (var f in folders.OrderBy(f => f)) text.Append(f.ToString("N")).Append(',');
        text.Append('|').Append(user.MaxParentalRatingScore?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "-")
            .Append('.').Append(user.MaxParentalRatingSubScore?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "-").Append('|');
        foreach (var t in (user.GetPreference(PreferenceKind.BlockedTags) ?? []).OrderBy(t => t, StringComparer.Ordinal)) text.Append(t).Append(',');
        text.Append('|');
        foreach (var t in (user.GetPreference(PreferenceKind.AllowedTags) ?? []).OrderBy(t => t, StringComparer.Ordinal)) text.Append(t).Append(',');
        text.Append('|');
        foreach (var u in user.GetPreferenceValues<UnratedItem>(PreferenceKind.BlockUnratedItems).OrderBy(u => u)) text.Append((int)u).Append(',');
        text.Append('|');
        foreach (var f in user.GetPreferenceValues<Guid>(PreferenceKind.BlockedMediaFolders).OrderBy(f => f)) text.Append(f.ToString("N")).Append(',');
        text.Append('|').Append(user.DisplayMissingEpisodes ? 'M' : '-');
        return text.ToString();
    }
}

/// <summary>Caches the round 2 enumeration found deciding by a user's access without following it.</summary>
[Collection("Jellyfin user versions")]
public class UserCacheSweepTests
{
    [Fact]
    public async Task ThePostersFourKBadgeFollowsTheViewersAccessOnTheNextRequest()
    {
        using var world = new StampWorld();
        var viewer = Guid.NewGuid();
        var key = StampWorld.Movie(77);
        var hd = world.AddMovie(key, StampWorld.T0.AddDays(-30));
        var uhd = world.AddMovie(key, StampWorld.T0.AddDays(-30), fourK: true);
        Assert.Equal(AcquisitionStamp.FourK, world.Resolver.Resolve(hd.Id, viewer));
        var asked = world.Library.CanOpenCalls;
        Assert.Equal(AcquisitionStamp.FourK, world.Resolver.Resolve(hd.Id, viewer));
        Assert.Equal(asked, world.Library.CanOpenCalls);
        // Someone else's change: still answered from the cache.
        await UserChange.PolicyPost(Guid.NewGuid(), () => { });
        Assert.Equal(AcquisitionStamp.FourK, world.Resolver.Resolve(hd.Id, viewer));
        Assert.Equal(asked, world.Library.CanOpenCalls);
        // The Dashboard takes the 4K library away (10.11: no event): the badge goes on the next poster, not 30 s later.
        await UserChange.PolicyPost(viewer, () => world.Library.Deny(viewer, uhd.Id));
        Assert.Equal(AcquisitionStamp.None, world.Resolver.Resolve(hd.Id, viewer));
    }

    [Fact]
    public void TheFeedAudienceNeverKeepsAnAnswerUnderARevisionItWasntDecidedWith()
    {
        using var arr = new FakeArr();
        var viewer = Guid.NewGuid();
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Tagged" };
        movie.SetProviderId(MetadataProvider.Tmdb, "4242");
        movie.Tags = ["late-night"];
        // The viewer is read twice per announcement on 14c488fa: the save lands between the two reads.
        var reads = 0;
        var before = UserChange.Read(viewer);
        var after = UserChange.Read(viewer, policy: u => u.SetPreference(PreferenceKind.BlockedTags, ["late-night"]));
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(viewer)).Returns(() => ++reads == 1 ? before : after);
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
            q.User != null && (q.ExcludeInheritedTags ?? []).Contains("late-night") ? new List<BaseItem>() : new List<BaseItem> { movie });
        var audience = new ArrFeedAudience(library.Object, users.Object, arr.Store());
        var change = new List<ArrFeedChange> { new("movie:tmdb:4242", 1, null) };
        // Decided with the user from before the save.
        Assert.Single(audience.Visible(viewer, false, change));
        // Every read is the saved user now: the title is hidden from them.
        Assert.Empty(audience.Visible(viewer, false, change));
    }
}
