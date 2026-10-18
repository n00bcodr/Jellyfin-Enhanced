using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Home;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;

namespace JE.Tests;

/// <summary>
/// Collection gaps, phase 4 (track 4d): titles the collection's list already holds as entries the viewer can see are
/// left out of "Get the N missing" and counted as <c>covered</c> (never anything the viewer may not see), only with the
/// phase 4 switch on; and (not behind a switch) an answer whose storage check couldn't be made in time says so
/// (<c>pausesPending</c>) instead of offering unchecked movies as gettable.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationCollectionGapsPhase4Tests
{
    private const long Gb = 1_000_000_000;

    private static string Body(params int[] ids)
        => JsonSerializer.Serialize(new { id = 10, parts = ids.Select(i => new { id = i, title = "Part " + i, release_date = "200" + (i % 10) + "-01-01" }).ToArray() });

    private static readonly DateTimeOffset Today = new(2026, 10, 17, 0, 0, 0, TimeSpan.Zero);

    /// <summary>A coverage that answers fixed keys and records who asked.</summary>
    private sealed class FixedCoverage : ICollectionCoverage
    {
        public HashSet<string> Keys { get; } = new(StringComparer.Ordinal);
        public List<(Guid Collection, Guid User)> Calls { get; } = new();
        public Exception? Throw { get; set; }

        public async Task<Func<IReadOnlySet<string>>> PrepareAsync(Guid collectionId, StatusViewer viewer, CancellationToken ct)
        {
            await CoveredAsync(collectionId, viewer, ct);
            return () => Keys;
        }

        public Task<IReadOnlySet<string>> CoveredAsync(Guid collectionId, StatusViewer viewer, CancellationToken ct)
        {
            Calls.Add((collectionId, viewer.UserId));
            if (Throw != null) throw Throw;
            return Task.FromResult<IReadOnlySet<string>>(Keys);
        }
    }

    private static CollectionGapsService Gaps(
        IArrJellyfinView view,
        Guid box,
        string body,
        Func<int, Guid, CancellationToken, Task<bool>>? maySee = null,
        ICollectionCoverage? coverage = null,
        bool phase4 = true,
        Func<Guid, IReadOnlyList<string>, CancellationToken, Task<IReadOnlyDictionary<string, RequestBlock>>>? pauses = null,
        Func<IReadOnlyList<string>, bool>? unknown = null,
        Func<Guid, IReadOnlyList<string>, IReadOnlyDictionary<string, RequestBlock?>>? refusals = null)
        => new(
            view,
            (_, id) => id == box ? new BoxSetRef(id, 10) : null,
            null,
            null,
            (_, _, _) => Task.FromResult<string?>(body),
            maySee ?? ((_, _, _) => Task.FromResult(true)),
            () => Today,
            pauses: pauses,
            pausesUnknown: unknown,
            coverage: coverage,
            phase4: () => phase4,
            refusals: refusals);

    [Fact]
    public async Task TheRegisteredApplicationSuppliesVisibleCollectionCoverage()
    {
        using var h = new ListsHarness();
        var viewer = h.NewUser("viewer");
        var collection = h.Host.AddCollection("Saga");
        await SaveEntries(h, collection, ListsHarness.Movie(49026));
        var services = new Microsoft.Extensions.DependencyInjection.ServiceCollection();
        new Jellyfin.Plugin.JellyfinEnhanced.PluginServiceRegistrator().RegisterServices(services, Moq.Mock.Of<MediaBrowser.Controller.IServerApplicationHost>());
        Microsoft.Extensions.DependencyInjection.ServiceCollectionServiceExtensions.AddSingleton(services, h.Store);
        Microsoft.Extensions.DependencyInjection.ServiceCollectionServiceExtensions.AddSingleton(services, h.Access);
        Microsoft.Extensions.DependencyInjection.ServiceCollectionServiceExtensions.AddSingleton(services, h.Users.Object);
        Microsoft.Extensions.DependencyInjection.ServiceCollectionServiceExtensions.AddSingleton<IListPreferences>(services, h.Preferences);
        Microsoft.Extensions.DependencyInjection.ServiceCollectionServiceExtensions.AddSingleton(services, h.Plugin.Core.Logger);
        using var provider = Microsoft.Extensions.DependencyInjection.ServiceCollectionContainerBuilderExtensions.BuildServiceProvider(services);
        var coverage = Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetService<ICollectionCoverage>(provider);
        Assert.NotNull(coverage);
        Assert.Contains("movie:tmdb:49026", await coverage!.CoveredAsync(collection.Info.Id, Viewer(viewer), default));
    }

    [Theory]
    [InlineData("revoke")]
    [InlineData("preference")]
    [InlineData("rating")]
    [InlineData("removed-entry")]
    public async Task CoverageRechecksAccessPreferencesLimitsAndMembershipAfterTheParentalRead(string change)
    {
        using var h = new ListsHarness(seerr: true);
        var user = h.NewUser("kid", maxRating: 17);
        var collection = h.Host.AddCollection("Saga");
        await SaveEntries(h, collection, ListsHarness.Movie(2, addedBy: Guid.NewGuid().ToString("N")));
        h.MovieCertifications[2] = "R";
        var original = h.Reply;
        var changed = false;
        h.ReplyAsync = (request, _) =>
        {
            if (!changed && request.RequestUri!.AbsolutePath.Contains("/movie/2", StringComparison.Ordinal))
            {
                changed = true;
                if (change == "revoke") h.Host.ListHiddenFrom[user.Id] = new HashSet<Guid> { collection.Info.Id };
                if (change == "preference") h.Preferences.ByUser[user.Id] = (false, null, null);
                if (change == "rating") user.MaxParentalRatingScore = 10;
                if (change == "removed-entry")
                {
                    var doc = h.Store.Load(collection.Info.Id.ToString("N"))!;
                    doc.Items.Clear();
                    h.Store.Save(doc);
                }
            }
            return Task.FromResult(original(request));
        };
        var coverage = new ListCollectionCoverage(h.Store, h.Access, h.Users.Object, h.Preferences, () => h.Plugin.Plugin.Configuration, null);
        Assert.Empty(await coverage.CoveredAsync(collection.Info.Id, Viewer(user, parental: true), default));
        Assert.True(changed);
    }

    public static IEnumerable<object[]> GapWaits()
    {
        foreach (var wait in new[] { "collection", "coverage", "parental", "storage" })
            foreach (var change in new[] { "revoke", "preference", "rating", "removed-entry", "flag", "deleted" })
                yield return new object[] { wait, change };
    }

    [Theory]
    [MemberData(nameof(GapWaits))]
    public async Task EveryGapWaitEndsWithCurrentAccessCoverageAndParentalPolicy(string wait, string change)
    {
        using var h = new ListsHarness(seerr: true);
        var user = h.NewUser("viewer", maxRating: 17);
        h.MovieCertifications[2] = "R";
        h.MovieCertifications[3] = "G";
        var collection = h.Host.AddCollection("Saga");
        await SaveEntries(h, collection, ListsHarness.Movie(2, addedBy: Guid.NewGuid().ToString("N")));
        var view = new FakeJellyfinView();
        view.Users[user.Id] = Viewer(user, parental: true);
        var changed = false;
        async Task ChangeAt(string point)
        {
            await Task.Yield();
            if (changed || point != wait) return;
            changed = true;
            if (change == "revoke") h.Host.ListHiddenFrom[user.Id] = new HashSet<Guid> { collection.Info.Id };
            if (change == "preference") h.Preferences.ByUser[user.Id] = (false, null, null);
            if (change == "rating")
            {
                user.MaxParentalRatingScore = 10;
                view.Users[user.Id] = new StatusViewer { UserId = user.Id, Handle = user, HasParentalLimit = true, PolicyRevision = "restricted" };
            }
            if (change == "removed-entry") { var doc = h.Store.Load(collection.Info.Id.ToString("N"))!; doc.Items.Clear(); h.Store.Save(doc); }
            if (change == "flag") h.Plugin.Plugin.Configuration.ArrPhase4ListPlaceholdersEnabled = false;
            if (change == "deleted") view.Users.Remove(user.Id);
        }
        var original = h.Reply;
        h.ReplyAsync = async (request, ct) => { await ChangeAt("coverage"); return original(request); };
        var coverage = new ListCollectionCoverage(h.Store, h.Access, h.Users.Object, h.Preferences, () => h.Plugin.Plugin.Configuration, null);
        var gaps = new CollectionGapsService(view, (_, id) => new BoxSetRef(id, 10), null, null,
            async (_, _, _) => { await ChangeAt("collection"); return Body(2, 3); },
            async (id, _, _) => { await ChangeAt("parental"); return id != 2 || user.MaxParentalRatingScore > 10; }, () => Today,
            pauses: async (_, _, _) => { await ChangeAt("storage"); return new Dictionary<string, RequestBlock>(); },
            coverage: coverage, phase4: () => true);
        var result = await gaps.ForCollectionAsync(view.Users[user.Id], collection.Info.Id, null, default);
        Assert.True(changed, "Dependency was not exercised: " + wait);
        if (change == "deleted") { Assert.Null(result.Gaps); return; }
        Assert.NotNull(result.Gaps);
        Assert.Equal(0, result.Gaps!.Covered);
        Assert.Equal(change == "rating" ? new[] { "movie:tmdb:3" } : new[] { "movie:tmdb:2", "movie:tmdb:3" }, result.Gaps.Missing.Select(p => p.Key));
    }

    [Fact]
    public async Task CoverageUsesAPreferenceEnabledDuringTheStorageWait()
    {
        using var h = new ListsHarness();
        var user = h.NewUser("viewer");
        var collection = h.Host.AddCollection("Saga");
        await SaveEntries(h, collection, ListsHarness.Movie(2));
        h.Preferences.ByUser[user.Id] = (false, null, null);
        var view = new FakeJellyfinView();
        var viewer = Viewer(user);
        view.Users[user.Id] = viewer;
        var coverage = new ListCollectionCoverage(h.Store, h.Access, h.Users.Object, h.Preferences, () => h.Plugin.Plugin.Configuration, null);
        var gaps = Gaps(view, collection.Info.Id, Body(2, 3), coverage: coverage,
            pauses: async (_, _, _) => { await Task.Yield(); h.Preferences.ByUser[user.Id] = (true, null, null); return new Dictionary<string, RequestBlock>(); });
        var answer = (await gaps.ForCollectionAsync(viewer, collection.Info.Id, null, default)).Gaps!;
        Assert.Equal(1, answer.Covered);
        Assert.Equal("movie:tmdb:3", Assert.Single(answer.Missing).Key);
    }

    [Fact]
    public async Task ListEntriesTheViewerSeesAreLeftOutAndCountedCoveredAndHiddenOnesChangeNothing()
    {
        using var h = new ListsHarness(seerr: true);
        // Parts 1–6; the viewer has 1. Ratings: 4 is R (over the kid's limit), the rest G.
        foreach (var id in new[] { 2, 3, 5, 6 }) h.MovieCertifications[id] = "G";
        h.MovieCertifications[4] = "R";
        var kid = h.NewUser("kid", maxRating: 10);
        var adult = h.NewUser("adult");
        var collection = h.Host.AddCollection("Saga");
        var adder = adult.Id.ToString("N");
        // The list holds 2 and 4 as entries (plus someone else's custom entry and a series entry, which cover nothing).
        await SaveEntries(h, collection, ListsHarness.Movie(2, addedBy: adder), ListsHarness.Movie(4, addedBy: adder),
            ListsHarness.Ph("{\"kind\":\"custom\",\"title\":\"Part 5\"}", adder),
            ListsHarness.Ph("{\"kind\":\"series\",\"tmdbId\":6,\"title\":\"Not a movie\"}", adder));
        var coverage = new ListCollectionCoverage(h.Store, h.Access, h.Users.Object, h.Preferences, () => h.Plugin.Plugin.Configuration, null);

        var view = new FakeJellyfinView();
        view.Users[adult.Id] = Viewer(adult);
        view.Users[kid.Id] = Viewer(kid, parental: true);
        view.AddCopy(TitleKey.Parse("movie:tmdb:1")!, new JfCopy { ItemId = Guid.NewGuid(), Path = "/m/1" });
        // The gaps' own parental decision is the same filter the list entries go through.
        Func<int, Guid, CancellationToken, Task<bool>> maySee = async (tmdb, user, ct) => await h.Access.CheckTitleAsync("movie", tmdb, user.ToString("N"), ct) == true;
        var gaps = Gaps(view, collection.Info.Id, Body(1, 2, 3, 4, 5, 6), maySee, coverage);

        var adultGaps = (await gaps.ForCollectionAsync(Viewer(adult), collection.Info.Id, null, default)).Gaps!;
        Assert.Equal(new[] { "movie:tmdb:3", "movie:tmdb:5", "movie:tmdb:6" }, adultGaps.Missing.Select(p => p.Key).OrderBy(k => k));
        Assert.Equal((1, 2, 6), (adultGaps.Have, adultGaps.Covered, adultGaps.Total));

        // The kid never sees 4 (R): not in the missing list, not counted covered, not in the total.
        var kidGaps = (await gaps.ForCollectionAsync(Viewer(kid, parental: true), collection.Info.Id, null, default)).Gaps!;
        Assert.Equal(new[] { "movie:tmdb:3", "movie:tmdb:5", "movie:tmdb:6" }, kidGaps.Missing.Select(p => p.Key).OrderBy(k => k));
        Assert.Equal((1, 1, 5), (kidGaps.Have, kidGaps.Covered, kidGaps.Total));
        var json = JsonSerializer.Serialize(kidGaps);
        Assert.Contains("\"covered\":1", json, StringComparison.Ordinal);
        Assert.DoesNotContain("tmdb:4", json, StringComparison.Ordinal);
    }

    [Fact]
    public async Task WithThePhase4SwitchOffTheListIsNotReadAndTheAnswerIsAsBefore()
    {
        var view = new FakeJellyfinView();
        var viewer = view.AddUser(false);
        var box = Guid.NewGuid();
        var coverage = new FixedCoverage();
        coverage.Keys.Add("movie:tmdb:2");
        var off = (await Gaps(view, box, Body(1, 2, 3), coverage: coverage, phase4: false).ForCollectionAsync(viewer, box, null, default)).Gaps!;
        Assert.Empty(coverage.Calls);
        Assert.Equal(new[] { "movie:tmdb:1", "movie:tmdb:2", "movie:tmdb:3" }, off.Missing.Select(p => p.Key));
        Assert.Equal((0, 3), (off.Have, off.Total));
        var json = JsonSerializer.Serialize(off);
        Assert.DoesNotContain("covered", json, StringComparison.Ordinal);
        Assert.DoesNotContain("pausesPending", json, StringComparison.Ordinal);

        var on = (await Gaps(view, box, Body(1, 2, 3), coverage: coverage, phase4: true).ForCollectionAsync(viewer, box, null, default)).Gaps!;
        Assert.Equal((box, viewer.UserId), Assert.Single(coverage.Calls));
        Assert.Equal(new[] { "movie:tmdb:1", "movie:tmdb:3" }, on.Missing.Select(p => p.Key));
        Assert.Equal((0, 1, 3), (on.Have, on.Covered, on.Total));
    }

    [Fact]
    public async Task ACoverageThatFailsOffersEveryMissingMovieAsBefore()
    {
        var view = new FakeJellyfinView();
        var viewer = view.AddUser(false);
        var box = Guid.NewGuid();
        var coverage = new FixedCoverage { Throw = new InvalidOperationException("boom") };
        var gaps = (await Gaps(view, box, Body(1, 2), coverage: coverage).ForCollectionAsync(viewer, box, null, default)).Gaps!;
        Assert.Equal(2, gaps.Missing.Count);
        Assert.Equal((0, 2), (gaps.Covered, gaps.Total));
    }

    [Fact]
    public async Task CoverageIsEmptyWhenListsAreOffTheListIsHiddenOrTheViewerSwitchedEntriesOffOrItCantBeRead()
    {
        using var h = new ListsHarness();
        var viewer = h.NewUser("viewer");
        var collection = h.Host.AddCollection("Saga");
        var fourK = ListsHarness.Ph("{\"kind\":\"movie\",\"tmdbId\":3,\"title\":\"Three\",\"edition\":\"4k\"}");
        await SaveEntries(h, collection, ListsHarness.Movie(2), fourK);
        var config = h.Plugin.Plugin.Configuration;
        var coverage = new ListCollectionCoverage(h.Store, h.Access, h.Users.Object, h.Preferences, () => config, null);
        var id = collection.Info.Id;

        // Every edition of a title counts: the title is on the page already.
        Assert.Equal(new[] { "movie:tmdb:2", "movie:tmdb:3" }, (await coverage.CoveredAsync(id, Viewer(viewer), default)).OrderBy(k => k));

        h.Preferences.ByUser[viewer.Id] = (false, null, null);
        Assert.Empty(await coverage.CoveredAsync(id, Viewer(viewer), default));
        h.Preferences.ByUser.Remove(viewer.Id);

        h.Host.ListHiddenFrom[viewer.Id] = new HashSet<Guid> { id };
        Assert.Empty(await coverage.CoveredAsync(id, Viewer(viewer), default));
        h.Host.ListHiddenFrom.Clear();

        config.ArrPhase4ListPlaceholdersEnabled = false;
        Assert.Empty(await coverage.CoveredAsync(id, Viewer(viewer), default));
        config.ArrPhase4ListPlaceholdersEnabled = true;

        // A playlist is not a collection; an unknown id is nothing.
        var playlist = h.Host.AddPlaylist(viewer, openAccess: true);
        await SaveEntries(h, playlist, ListsHarness.Movie(2));
        Assert.Empty(await coverage.CoveredAsync(playlist.Info.Id, Viewer(viewer), default));
        Assert.Empty(await coverage.CoveredAsync(Guid.NewGuid(), Viewer(viewer), default));

        // A document that can't be read covers nothing (and doesn't throw).
        h.Store.InvalidateAll();
        await File.WriteAllTextAsync(Path.Combine(h.Store.DirectoryPath, collection.Info.Id.ToString("N") + ".json"), "{ not json");
        h.Store.InvalidateAll();
        Assert.Empty(await coverage.CoveredAsync(id, Viewer(viewer), default));
    }

    [Fact]
    public async Task PausesPendingIsSaidOnlyWhenAMovieNotMarkedPausedCouldntBeChecked()
    {
        var view = new FakeJellyfinView();
        var viewer = view.AddUser(false);
        var box = Guid.NewGuid();
        var asked = new List<IReadOnlyList<string>>();
        var unknown = true;
        Func<Guid, IReadOnlyList<string>, CancellationToken, Task<IReadOnlyDictionary<string, RequestBlock>>> pauses =
            (_, keys, _) => Task.FromResult<IReadOnlyDictionary<string, RequestBlock>>(new Dictionary<string, RequestBlock> { ["movie:tmdb:1"] = new RequestBlock { Reason = "low_disk" } });
        var service = Gaps(view, box, Body(1, 2, 9), pauses: pauses, unknown: keys => { asked.Add(keys); return unknown; }, phase4: false);

        var pending = (await service.ForCollectionAsync(viewer, box, null, default)).Gaps!;
        Assert.True(pending.PausesPending);
        // Only released movies nobody asked for and not already marked paused are in question (9 is out in 2009 too).
        Assert.Equal(new[] { "movie:tmdb:2", "movie:tmdb:9" }, Assert.Single(asked).OrderBy(k => k));
        Assert.Contains("\"pausesPending\":true", JsonSerializer.Serialize(pending), StringComparison.Ordinal);

        unknown = false;
        var known = (await service.ForCollectionAsync(viewer, box, null, default)).Gaps!;
        Assert.Null(known.PausesPending);
        Assert.DoesNotContain("pausesPending", JsonSerializer.Serialize(known), StringComparison.Ordinal);
    }

    [Fact]
    public async Task AFirstReadSlowerThanTheWaitSaysStorageIsUncheckedAndTheNextReadMarksThePauses()
    {
        // The first view after a restart: Radarr's disk facts take longer than the policy's wait. Before the fix the
        // answer offered every movie as gettable with no pause, as if checked ("Get the 7 missing", seen once in 3h).
        using var arr = new FakeArr();
        var radarr = arr.Add("radarr.invalid", "Radarr");
        arr.Configure(("Radarr", ArrKind.Radarr, "http://radarr.invalid", "key-radarr"));
        var config = arr.Plugin.Plugin.Configuration;
        config.ArrIntegrationEnabled = true;
        config.ArrPhase1Enabled = true;
        config.ArrPhase3Enabled = true;
        config.ArrRequestBackend = "je";
        config.ArrRequestDefaultRole = "Member";
        config.ArrLowDiskPercent = 10;
        var rows = JsonNode.Parse(config.RadarrInstances)!.AsArray();
        foreach (var row in rows) row!["Defaults"] = new JsonObject { ["QualityProfileId"] = 1, ["RootFolderPath"] = "/movies", ["Tags"] = new JsonArray() };
        config.RadarrInstances = rows.ToJsonString();
        radarr.DiskSpace.Add(new JsonObject { ["path"] = "/movies", ["freeSpace"] = 1 * Gb, ["totalSpace"] = 1000 * Gb });
        var slow = new TaskCompletionSource();
        radarr.Before = async (path, ct) => { if (path.EndsWith("/diskspace", StringComparison.Ordinal)) await slow.Task.WaitAsync(ct); };

        var store = arr.Store();
        var view = new FakeJellyfinView();
        var policy = new RequestPolicy(view, store, new ArrInstanceLibraries(store, new FakeLibraryAccess()), new TitleAliases(store, null), null!, arr.Factory, new UnavailableRequestBackend())
        {
            DiskWait = TimeSpan.FromMilliseconds(200),
        };
        using var db = new AcquireDatabase(Path.Combine(arr.Plugin.Core.Root, "gaps4-" + Guid.NewGuid().ToString("N") + ".db"));
        var requests = new RequestService(new RequestLedger(db), policy, view, new ArrChangeFeed(), new TitleAliases(store, null));
        var member = view.AddUser(false);
        var box = Guid.NewGuid();
        var gaps = Gaps(view, box, Body(1, 2, 3), pauses: (user, keys, ct) => requests.StoragePausesAsync(user, keys, true, ct),
            unknown: keys => CollectionGapsService.StorageUnknown(policy, keys), phase4: false);

        var first = (await gaps.ForCollectionAsync(member, box, null, default)).Gaps!;
        Assert.All(first.Missing, p => Assert.Null(p.Blocked));
        Assert.True(first.PausesPending, "unchecked movies must not be offered as checked");

        slow.SetResult();
        var system = store.WarmSystem(arr.Instance("Radarr"));
        if (system != null) await system;
        for (var i = 0; i < 300 && (store.PeekSystem(arr.Instance("Radarr").Id) == null || store.PeekLibrary(arr.Instance("Radarr").Id) == null); i++) await Task.Delay(10);

        var next = (await gaps.ForCollectionAsync(member, box, null, default)).Gaps!;
        Assert.All(next.Missing, p => Assert.Equal("low_disk", p.Blocked?.Reason));
        Assert.Null(next.PausesPending);
        // The guard off (or Seerr handling): nothing needs knowing, nothing is pending.
        config.ArrLowDiskPercent = 0;
        Assert.False(CollectionGapsService.StorageUnknown(policy, new[] { "movie:tmdb:1" }));
    }

    [Fact]
    public async Task MoviesThePersonCantAskForAtAllAreNotOfferedAndSaidWhereTheControlsExplainIt()
    {
        // Before: "Get the N missing" counted a movie the title check refuses (it would land in a library the person
        // can't open), so the batch could only end in "couldn't be asked".
        var view = new FakeJellyfinView();
        var viewer = view.AddUser(false);
        var box = Guid.NewGuid();
        var policy = new IntegrationRequestLedgerTests.Policy();
        policy.People[viewer.UserId] = new(viewer.UserId, "Member", true, false, false, true, "p1", "je", "r1", "g1", 7, 7, 0, "{}");
        policy.Adjust = (_, input, facts) => input.Key switch
        {
            "movie:tmdb:2" => facts with { Refusal = "not_visible_to_user" },
            "movie:tmdb:3" => facts with { Refusal = "instance_changed" },
            "movie:tmdb:4" => facts with { Refusal = "authorization_changed" },
            _ => facts,
        };
        var unknownAsked = new List<IReadOnlyList<string>>();
        Func<Guid, IReadOnlyList<string>, CancellationToken, Task<IReadOnlyDictionary<string, RequestBlock>>> none =
            (_, _, _) => Task.FromResult<IReadOnlyDictionary<string, RequestBlock>>(new Dictionary<string, RequestBlock>());
        var gaps = (await Gaps(view, box, Body(1, 2, 3, 4), pauses: none, unknown: keys => { unknownAsked.Add(keys); return false; },
            refusals: (user, keys) => CollectionGapsService.Refusals(policy, user, keys), phase4: false).ForCollectionAsync(viewer, box, null, default)).Gaps!;
        var byKey = gaps.Missing.ToDictionary(p => p.Key);
        Assert.Equal((null, (bool?)null), (byKey["movie:tmdb:1"].Blocked, byKey["movie:tmdb:1"].Askable));
        Assert.Equal((null, (bool?)false), (byKey["movie:tmdb:2"].Blocked, byKey["movie:tmdb:2"].Askable));
        Assert.Equal(("instance_changed", (bool?)null), (byKey["movie:tmdb:3"].Blocked?.Reason, byKey["movie:tmdb:3"].Askable));
        // A change under way decides nothing (the next read answers).
        Assert.Equal((null, (bool?)null), (byKey["movie:tmdb:4"].Blocked, byKey["movie:tmdb:4"].Askable));
        Assert.Equal(new[] { "movie:tmdb:1", "movie:tmdb:4" }, Assert.Single(unknownAsked).OrderBy(k => k));
        var json = JsonSerializer.Serialize(gaps);
        Assert.Contains("\"askable\":false", json, StringComparison.Ordinal);
        Assert.Equal(1, json.Split("askable").Length - 1);
    }

    private static StatusViewer Viewer(User user, bool parental = false)
        => new() { UserId = user.Id, IsAdmin = ListAccessService.IsAdmin(user), HasParentalLimit = parental, PolicyRevision = "p", Handle = user };

    private static async Task SaveEntries(ListsHarness h, FakeListHost.FakeList list, params Placeholder[] entries)
    {
        var listId = list.Info.Id.ToString("N");
        using (await h.Store.LockAsync(listId))
        {
            var doc = h.Store.LoadForUpdate(listId, list.Info.Kind);
            foreach (var entry in entries)
            {
                doc.Items.Add(entry);
                doc.Order.Add(ListsHarness.P(entry.Id));
            }

            h.Store.Save(doc);
        }
    }
}
