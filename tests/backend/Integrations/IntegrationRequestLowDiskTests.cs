using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests;

/// <summary>
/// Phase 3g: the low-disk guard of the production request policy measures, in JE mode, the drive the download would
/// land on (the title's own folder when the arr holds it, else the folder named or the default root folder for a new
/// add), for every role; Seerr mode keeps measuring only the folder named or the default root, as before. The season
/// rows, the title check and the caller's capabilities say why ("Paused: storage full", where and how much is free for
/// administrators only) instead of leaving nothing to do.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationRequestLowDiskTests
{
    private const long Gb = 1_000_000_000;
    private const string Firefly = "tv:tvdb:78874";      // held, its folder on the full drive
    private const string OldShow = "tv:tvdb:70000";      // held, its folder on a roomy drive
    private const string NewShow = "tv:tvdb:99999";      // not held: a new add (default root)

    private sealed class Lab : IDisposable
    {
        public FakeArr Arr { get; } = new();
        public FakeArr.Host Sonarr { get; }
        public FakeArr.Host Radarr { get; }
        public FakeJellyfinView View { get; } = new();
        public ArrStateStore Store { get; }
        public RequestPolicy Policy { get; }
        public StatusViewer Admin { get; }
        public StatusViewer Member { get; }
        public PluginConfiguration Config => Arr.Plugin.Plugin.Configuration;

        public Lab(string backend = "je", bool defaults = true, string? disks = null)
        {
            Sonarr = Arr.Add("sonarr.invalid", "Sonarr");
            Radarr = Arr.Add("radarr.invalid", "Radarr");
            Arr.Configure(("Sonarr", ArrKind.Sonarr, "http://sonarr.invalid", "key-sonarr"), ("Radarr", ArrKind.Radarr, "http://radarr.invalid", "key-radarr"));
            Config.ArrIntegrationEnabled = true;
            Config.ArrPhase1Enabled = true;
            Config.ArrPhase3Enabled = true;
            Config.ArrRequestBackend = backend;
            Config.ArrRequestDefaultRole = "Member";
            Config.ArrLowDiskPercent = 10;
            if (defaults) SetDefaults("/tv", "/movies");
            // The default roots sit on nearly full drives; an older series lives on a roomy one.
            if (disks != null) Sonarr.DiskSpace.AddRange(Disks(disks));
            else
            {
                Sonarr.DiskSpace.Add(new JsonObject { ["path"] = "/", ["freeSpace"] = 900 * Gb, ["totalSpace"] = 1000 * Gb });
                Sonarr.DiskSpace.Add(new JsonObject { ["path"] = "/tv", ["freeSpace"] = 2 * Gb, ["totalSpace"] = 4000 * Gb });
                Sonarr.DiskSpace.Add(new JsonObject { ["path"] = "/tv2", ["freeSpace"] = 1500 * Gb, ["totalSpace"] = 4000 * Gb });
            }
            Sonarr.RootFolders.Add(new JsonObject { ["path"] = "/tv", ["freeSpace"] = 2 * Gb, ["accessible"] = true });
            Sonarr.RootFolders.Add(new JsonObject { ["path"] = "/tv2", ["freeSpace"] = 1500 * Gb, ["accessible"] = true });
            Radarr.DiskSpace.Add(new JsonObject { ["path"] = "/movies", ["freeSpace"] = 1 * Gb, ["totalSpace"] = 1000 * Gb });
            var firefly = FakeArr.SeriesRow(1, 78874, "Firefly");
            firefly["path"] = "/tv/Firefly (2002)";
            var old = FakeArr.SeriesRow(2, 70000, "Old Show");
            old["path"] = "/tv2/Old Show";
            Sonarr.Series.Add(firefly);
            Sonarr.Series.Add(old);
            Store = Arr.Store();
            Policy = new RequestPolicy(View, Store, new ArrInstanceLibraries(Store, new FakeLibraryAccess()), new TitleAliases(Store, null), null!, Arr.Factory, new UnavailableRequestBackend());
            Admin = View.AddUser(true);
            Member = View.AddUser(false);
        }

        /// <summary>Sets (or with nulls clears) the instances' add defaults, like a config-page save.</summary>
        public void SetDefaults(string? tv, string? movies)
        {
            Config.SonarrInstances = WithDefaults(Config.SonarrInstances, tv);
            Config.RadarrInstances = WithDefaults(Config.RadarrInstances, movies);
        }

        private static string WithDefaults(string json, string? root)
        {
            var rows = JsonNode.Parse(json)!.AsArray();
            foreach (var row in rows)
            {
                if (root == null) row!.AsObject().Remove("Defaults");
                else row!["Defaults"] = new JsonObject { ["QualityProfileId"] = 1, ["RootFolderPath"] = root, ["Tags"] = new JsonArray() };
            }
            return rows.ToJsonString();
        }

        /// <summary>
        /// <c>/diskspace</c> rows from "path=free/total;..." in bytes ("-" for a value the arr leaves out).
        /// </summary>
        private static IEnumerable<JsonObject> Disks(string spec)
            => spec.Split(';').Select(entry =>
            {
                var (path, sizes) = (entry.Split('=')[0], entry.Split('=')[1].Split('/'));
                return new JsonObject { ["path"] = path, ["freeSpace"] = sizes[0] == "-" ? null : long.Parse(sizes[0]), ["totalSpace"] = sizes[1] == "-" ? null : long.Parse(sizes[1]) };
            });

        /// <summary>Reads both instances' library index and system facts into memory.</summary>
        public async Task LoadAsync()
        {
            foreach (var name in new[] { "Sonarr", "Radarr" })
            {
                Assert.True((await Store.GetLibraryAsync(Arr.Instance(name), default)).Value != null);
                Assert.True((await Store.GetSystemAsync(Arr.Instance(name), default)).Value != null);
            }
        }

        /// <summary>Reads both instances' system facts only (the library index stays cold, as after a restart).</summary>
        public async Task LoadSystemAsync()
        {
            foreach (var name in new[] { "Sonarr", "Radarr" }) Assert.True((await Store.GetSystemAsync(Arr.Instance(name), default)).Value != null);
            Assert.Null(Store.PeekLibrary(Arr.Instance("Sonarr").Id));
        }

        public RequestPolicyFacts Facts(StatusViewer viewer, string key)
            => Policy.Evaluate(viewer.UserId, key.StartsWith("movie:", StringComparison.Ordinal)
                ? new MutationInput { Key = key }
                : new MutationInput { Key = key, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 3) } });

        public void Dispose() => Arr.Dispose();
    }

    [Fact]
    public async Task TheGuardMeasuresTheTitlesOwnFolderWhenTheArrHoldsItElseTheDefaultRootForEveryRole()
    {
        using var lab = new Lab();
        await lab.LoadAsync();
        foreach (var viewer in new[] { lab.Admin, lab.Member })
        {
            // Held, its own folder on the full drive: refused, the series' folder measured (where the download imports to).
            var firefly = lab.Facts(viewer, Firefly);
            Assert.Equal("low_disk", firefly.Refusal);
            Assert.Equal(("Sonarr", "/tv/Firefly (2002)", 2 * Gb, 0, 10), (firefly.Disk!.Instance, firefly.Disk.Folder, firefly.Disk.Free, firefly.Disk.FreePercent, firefly.Disk.LimitPercent));
            // Held on a roomy drive: asked for (and searched) as usual, although the default root is full.
            Assert.Null(lab.Facts(viewer, OldShow).Refusal);
            Assert.Null(lab.Facts(viewer, OldShow).Disk);
            // A new add lands in the default root.
            Assert.Equal(("low_disk", "/tv"), (lab.Facts(viewer, NewShow).Refusal, lab.Facts(viewer, NewShow).Disk!.Folder));
            Assert.Equal(("low_disk", "/movies"), (lab.Facts(viewer, "movie:tmdb:603").Refusal, lab.Facts(viewer, "movie:tmdb:603").Disk!.Folder));
        }
        // Threshold 0: the guard is off.
        lab.Config.ArrLowDiskPercent = 0;
        Assert.Null(lab.Facts(lab.Member, Firefly).Refusal);
        Assert.Null(lab.Facts(lab.Member, NewShow).Refusal);
    }

    [Fact]
    public async Task AHeldTitlesOwnFolderBeatsAFolderTheAdministratorNamesWhichOnlyCountsForANewAdd()
    {
        using var lab = new Lab();
        await lab.LoadAsync();
        // The arr merges an ask for a title it holds into that title: it stays in its folder whatever root is named,
        // so the roomy /tv2 named here doesn't let an ask for Firefly (on the full /tv) through.
        RequestPolicyFacts Named(string key, string root) => lab.Policy.Evaluate(lab.Admin.UserId,
            new MutationInput { Key = key, Scope = "seasons", Seasons = new[] { 1 }, RootFolder = root });
        var firefly = Named(Firefly, "/tv2");
        Assert.Equal(("low_disk", "/tv/Firefly (2002)"), (firefly.Refusal, firefly.Disk?.Folder));
        // Old Show (held on the roomy /tv2) named into the full /tv: still its own roomy folder.
        Assert.Null(Named(OldShow, "/tv").Refusal);
        // A new add goes where it is told: the roomy /tv2 named beats the full default root, the full /tv named is refused.
        Assert.Null(Named(NewShow, "/tv2").Refusal);
        Assert.Equal(("low_disk", "/tv"), (Named(NewShow, "/tv").Refusal, Named(NewShow, "/tv").Disk?.Folder));
    }

    [Theory]
    [InlineData("Admin")]
    [InlineData("Member")]
    public async Task SeerrModeMeasuresOnlyTheFolderNamedOrTheDefaultRootAsBefore(string who)
    {
        using var lab = new Lab("seerr");
        await lab.LoadAsync();
        var viewer = who == "Admin" ? lab.Admin : lab.Member;
        // Seerr picks its own server and folder: the title's own folder isn't looked at, the default root counts for every
        // title (Old Show, held on the roomy /tv2, is paused like a new add because the default root /tv is full).
        foreach (var key in new[] { Firefly, OldShow, NewShow })
        {
            var facts = lab.Facts(viewer, key);
            Assert.Equal(("low_disk", "/tv"), (facts.Refusal, facts.Disk?.Folder));
        }
        // Without JE add defaults the guard has no folder in Seerr mode, held or not (the usual Seerr setup).
        lab.SetDefaults(null, null);
        Assert.Null(lab.Facts(viewer, Firefly).Refusal);
        Assert.Null(lab.Facts(viewer, NewShow).Refusal);
        Assert.Null(lab.Facts(viewer, "movie:tmdb:603").Refusal);
    }

    [Fact]
    public async Task SeerrModeStartsNoArrReadsForTheGuard()
    {
        using var lab = new Lab("seerr");
        var input = new MutationInput { Key = Firefly, Scope = "seasons", Seasons = new[] { 1 } };
        // Nothing in memory (a restart): Seerr mode doesn't wait for or start a read of the arr for the guard.
        await lab.Policy.PrepareDiskAsync(input, default);
        await lab.Policy.PrepareAddPauseAsync(false, default);
        Assert.Null(lab.Policy.Evaluate(lab.Member.UserId, input).Refusal);
        Assert.Null(lab.Policy.AddPause(false));
        await Task.Delay(200);
        Assert.Null(lab.Store.PeekSystem(lab.Arr.Instance("Sonarr").Id));
        Assert.Null(lab.Store.PeekLibrary(lab.Arr.Instance("Sonarr").Id));
        Assert.DoesNotContain(lab.Arr.Calls, c => c.Contains("/diskspace", StringComparison.Ordinal) || c.Contains("/series", StringComparison.Ordinal));
    }

    [Theory]
    // The most specific /diskspace entry under the folder decides; free exactly at the threshold is not "below" it.
    [InlineData("/=900/1000;/tv=400/4000", false)]
    [InlineData("/=900/1000;/tv=399/4000", true)]
    [InlineData("/=400000000000/4000000000000;/tv=399999999999/4000000000000", true)]
    // Nested mounts: a full / with a roomy /tv is fine; a roomy / with a full /tv is not.
    [InlineData("/=1/1000;/tv=2000/4000", false)]
    [InlineData("/=900/1000;/tv=1/4000", true)]
    [InlineData("/tv=1/4000;/=900/1000", true)]
    // Nothing usable is known about the drive: never paused (an unmapped or proxied arr says nothing useful).
    [InlineData("/tv=-/4000", false)]
    [InlineData("/tv=1/-", false)]
    [InlineData("/tv=0/0", false)]
    [InlineData("/data=1/4000", false)]
    [InlineData("/tvshows=1/4000", false)]
    public async Task TheGuardUsesTheMostSpecificUsableDiskEntryAndFailsOpenWhenNothingIsKnown(string disks, bool paused)
    {
        using var lab = new Lab(disks: disks);
        await lab.LoadAsync();
        var facts = lab.Facts(lab.Member, NewShow);
        Assert.Equal(paused ? "low_disk" : null, facts.Refusal);
        Assert.Equal(paused, facts.Disk != null);
    }

    [Fact]
    public async Task WithTheLibraryIndexNotReadYetTheGuardReadsItFirstAndNeverGuessesTheDefaultRoot()
    {
        // The default root is roomy, Firefly's own folder is on the full drive; only the system facts are in memory.
        using (var lab = new Lab())
        {
            lab.SetDefaults("/tv2", "/movies");
            await lab.LoadSystemAsync();
            var input = new MutationInput { Key = Firefly, Scope = "seasons", Seasons = new[] { 1 } };
            // Not known whether Sonarr holds it: no verdict from the default root (which would let it through).
            Assert.Null(lab.Policy.Evaluate(lab.Member.UserId, input).Disk);
            // The season rows, the title check and an ask read the library first: Firefly's own folder counts.
            await lab.Policy.PrepareDiskAsync(input, default);
            Assert.NotNull(lab.Store.PeekLibrary(lab.Arr.Instance("Sonarr").Id));
            Assert.Equal(("low_disk", "/tv/Firefly (2002)"), (lab.Policy.Evaluate(lab.Member.UserId, input).Refusal, lab.Policy.Evaluate(lab.Member.UserId, input).Disk?.Folder));
        }
        // Reversed: the default root is full, Old Show's own folder is roomy. Not read yet: not paused for the default root.
        using var other = new Lab();
        await other.LoadSystemAsync();
        var old = new MutationInput { Key = OldShow, Scope = "seasons", Seasons = new[] { 1 } };
        Assert.Null(other.Policy.Evaluate(other.Member.UserId, old).Refusal);
        await other.Policy.PrepareAsync(other.Member.UserId, old, default);
        Assert.NotNull(other.Store.PeekLibrary(other.Arr.Instance("Sonarr").Id));
        Assert.Null(other.Policy.Evaluate(other.Member.UserId, old).Refusal);
        // A new add needs no library index: the household pause answers from the system facts alone.
        Assert.Equal("/tv", other.Policy.AddPause(false)?.Folder);
    }

    [Fact]
    public async Task WithoutAddDefaultsANewAddIsNotMeasuredButAHeldTitleStillIs()
    {
        using var lab = new Lab(defaults: false);
        await lab.LoadAsync();
        // No default root: no folder a new add lands in is known (the add itself waits for defaults).
        Assert.Null(lab.Facts(lab.Member, NewShow).Refusal);
        Assert.Null(lab.Facts(lab.Admin, "movie:tmdb:603").Refusal);
        // A title the arr holds is measured by its own folder whatever the defaults say.
        Assert.Equal("low_disk", lab.Facts(lab.Member, Firefly).Refusal);
        Assert.Null(lab.Policy.AddPause(true));
        Assert.Null(lab.Policy.AddPause(false));
    }

    [Fact]
    public async Task OnlyAdministratorsAreToldWhereAndHowMuchIsFreeAndWatchersAreToldNothing()
    {
        using var lab = new Lab();
        await lab.LoadAsync();
        var admin = RequestBlock.Of(lab.Facts(lab.Admin, Firefly))!;
        Assert.Equal(("low_disk", "Sonarr", "/tv/Firefly (2002)", 2 * Gb, 0, 10), (admin.Reason, admin.Instance, admin.Folder, admin.Free, admin.FreePercent, admin.LimitPercent));
        var member = RequestBlock.Of(lab.Facts(lab.Member, Firefly))!;
        var json = JsonSerializer.Serialize(member);
        Assert.Equal("{\"reason\":\"low_disk\"}", json);
        Assert.DoesNotContain("tv", json, StringComparison.OrdinalIgnoreCase);
        // Nothing to explain: a role that can't ask, no refusal, or a refusal the controls don't explain.
        Assert.Null(RequestBlock.Of(lab.Facts(lab.Member, Firefly) with { CanCreate = false }));
        Assert.Null(RequestBlock.Of(lab.Facts(lab.Member, OldShow)));
        Assert.Null(RequestBlock.Of(lab.Facts(lab.Member, Firefly) with { Refusal = "not_visible_to_user" }));
        Assert.Equal("instance_changed", RequestBlock.Of(lab.Facts(lab.Member, Firefly) with { Refusal = "instance_changed", Disk = null })!.Reason);
        Assert.Null(RequestBlock.Storage(null, true));
    }

    [Fact]
    public async Task DiskFactsNotReadSinceARestartAreReadBeforeTheGuardAnswers()
    {
        using (var lab = new Lab())
        {
            var input = new MutationInput { Key = NewShow, Scope = "seasons", Seasons = new[] { 1 } };
            // Nothing in memory (a restart): the season rows, the title check and the capabilities read it first.
            Assert.Null(lab.Store.PeekSystem(lab.Arr.Instance("Sonarr").Id));
            await lab.Policy.PrepareDiskAsync(input, default);
            Assert.NotNull(lab.Store.PeekSystem(lab.Arr.Instance("Sonarr").Id));
            Assert.Equal("low_disk", lab.Policy.Evaluate(lab.Member.UserId, input).Refusal);
        }
        // An ask prepares them too.
        using var other = new Lab();
        var movie = new MutationInput { Key = "movie:tmdb:603" };
        Assert.Null(other.Store.PeekSystem(other.Arr.Instance("Radarr").Id));
        await other.Policy.PrepareAsync(other.Member.UserId, movie, default);
        Assert.Equal("low_disk", other.Policy.Evaluate(other.Member.UserId, movie).Refusal);
    }

    [Fact]
    public async Task SeasonRowsWithTheRealPolicySayWhyAndTheCapabilitiesAndTitleCheckDoToo()
    {
        using var lab = new Lab();
        await lab.LoadAsync();
        var seriesId = Guid.NewGuid();
        var seasonId = Guid.NewGuid();
        lab.View.AddItem(new JfItemRef { ItemId = seasonId, Kind = "season", Key = TitleKey.Parse(Firefly)!.WithSeason(1), SeriesId = seriesId, Season = 1 });
        lab.View.AddEpisode(seriesId, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1 });
        using var db = new AcquireDatabase(Path.Combine(lab.Arr.Plugin.Core.Root, "lowdisk-" + Guid.NewGuid().ToString("N") + ".db"));
        var ledger = new RequestLedger(db);
        var rows = new SeasonRowsService(lab.View, ledger, lab.Policy, null, (_, _, _, _) => Task.FromResult<string?>(null));

        // Full drive: nothing can be asked for, and the rows say why (where and how much only for the administrator).
        var member = (await rows.ForSeasonAsync(lab.View.Users[lab.Member.UserId], seasonId, null, default))!;
        Assert.False(member.CanRequest);
        Assert.Equal("{\"reason\":\"low_disk\"}", JsonSerializer.Serialize(member.Blocked));
        var admin = (await rows.ForSeasonAsync(lab.View.Users[lab.Admin.UserId], seasonId, null, default))!;
        Assert.False(admin.CanRequest);
        Assert.Equal(("low_disk", "/tv/Firefly (2002)"), (admin.Blocked!.Reason, admin.Blocked.Folder));

        var service = new RequestService(ledger, lab.Policy, lab.View, new ArrChangeFeed(), new TitleAliases(lab.Store, null));
        // The caller's capabilities: may ask, but new movies and series are paused (default roots full).
        var me = service.Me(lab.Member.UserId);
        Assert.True(me.CanRequest);
        Assert.Equal(("low_disk", null), (me.PausedMovies!.Reason, me.PausedMovies.Folder));
        Assert.Equal(("low_disk", "/tv"), (service.Me(lab.Admin.UserId).PausedSeries!.Reason, service.Me(lab.Admin.UserId).PausedSeries!.Folder));
        // The title check: Firefly paused; the older series (roomy drive) can be asked for.
        var check = (await service.CheckAsync(lab.Member.UserId, Firefly + ":s1", null, default))!;
        Assert.Equal((Firefly, "standard", false, "low_disk"), (check.Key, check.Variant, check.CanRequest, check.Blocked!.Reason));
        var roomy = (await service.CheckAsync(lab.Member.UserId, OldShow, "standard", default))!;
        Assert.Equal((true, null), (roomy.CanRequest, roomy.Blocked));
        Assert.Null(await service.CheckAsync(lab.Member.UserId, "not a key", null, default));
        // The route: a person only, a key and an edition it knows.
        var controller = new AcquireRequestsController(service) { ControllerContext = new() { HttpContext = new DefaultHttpContext() } };
        controller.HttpContext.User = TestCallers.Principal(lab.Member.UserId, false);
        var ok = Assert.IsType<OkObjectResult>(await controller.Check(Firefly, "standard", default));
        Assert.Contains("\"reason\":\"low_disk\"", JsonSerializer.Serialize(ok.Value), StringComparison.Ordinal);
        Assert.DoesNotContain("/tv", JsonSerializer.Serialize(ok.Value), StringComparison.Ordinal);
        Assert.Equal(400, Assert.IsType<ObjectResult>(await controller.Check(Firefly, "8k", default)).StatusCode);
        Assert.Equal(400, Assert.IsType<ObjectResult>(await controller.Check(null, null, default)).StatusCode);
        controller.HttpContext.User = TestCallers.Unknown();
        Assert.Equal(403, Assert.IsType<ObjectResult>(await controller.Check(Firefly, null, default)).StatusCode);

        // A roomy drive again: Get it is offered, nothing is blocked, nothing paused.
        lab.Config.ArrLowDiskPercent = 0;
        var healthy = (await rows.ForSeasonAsync(lab.View.Users[lab.Member.UserId], seasonId, null, default))!;
        Assert.True(healthy.CanRequest);
        Assert.Null(healthy.Blocked);
        Assert.Null(service.Me(lab.Member.UserId).PausedSeries);

        // An ask while the drive is full is refused with the storage reason, as blocked (not denied).
        lab.Config.ArrLowDiskPercent = 10;
        var refused = await service.CreateAsync(lab.Member.UserId, new CreateRequest("full-1", new MutationInput { Key = NewShow, Scope = "seasons", Seasons = new[] { 1 } }), default);
        Assert.Equal((403, "blocked", "low_disk"), (refused.HttpStatus, refused.Outcome, refused.Reason));
    }

    // ------------------------------------------------------------------ review round 2: lists answer title by title

    /// <summary>
    /// Radarr for the list tests: <c>/movies</c> (the default root) and <c>/movies2</c> with the given free GB (of
    /// 1000); held movies 603 on <c>/movies2</c> and 605 on <c>/movies</c>; 604 is a new add.
    /// </summary>
    private static void Movies(Lab lab, long defaultFreeGb, long otherFreeGb)
    {
        lab.Radarr.DiskSpace.Clear();
        lab.Radarr.DiskSpace.Add(new JsonObject { ["path"] = "/movies", ["freeSpace"] = defaultFreeGb * Gb, ["totalSpace"] = 1000 * Gb });
        lab.Radarr.DiskSpace.Add(new JsonObject { ["path"] = "/movies2", ["freeSpace"] = otherFreeGb * Gb, ["totalSpace"] = 1000 * Gb });
        lab.Radarr.Movies.Add(FakeArr.Movie(1, 603, "Held Roomy", hasFile: false, path: "/movies2/Held Roomy"));
        lab.Radarr.Movies.Add(FakeArr.Movie(2, 605, "Held Full", hasFile: false, path: "/movies/Held Full"));
    }

    private static RequestService Requests(Lab lab, out AcquireDatabase db)
    {
        db = new AcquireDatabase(Path.Combine(lab.Arr.Plugin.Core.Root, "lowdisk-" + Guid.NewGuid().ToString("N") + ".db"));
        return new RequestService(new RequestLedger(db), lab.Policy, lab.View, new ArrChangeFeed(), new TitleAliases(lab.Store, null));
    }

    [Fact]
    public async Task StoragePausesAreTheTitleChecksAnswerTitleByTitleInBothDirections()
    {
        // The default roots are full; a held title on a roomy drive isn't paused, a new add and a held title on the
        // full drive are; the same answer as the title check for each.
        using (var lab = new Lab())
        {
            Movies(lab, 1, 600);
            await lab.LoadAsync();
            var service = Requests(lab, out var db);
            using var _ = db;
            var keys = new[] { Firefly, OldShow, NewShow, "movie:tmdb:603", "movie:tmdb:604", "movie:tmdb:605", "not a key" };
            var member = await service.StoragePausesAsync(lab.Member.UserId, keys, true, default);
            Assert.Equal(new[] { Firefly, NewShow, "movie:tmdb:604", "movie:tmdb:605" }, member.Keys.OrderBy(k => Array.IndexOf(keys, k)));
            Assert.All(member.Values, b => Assert.Equal("{\"reason\":\"low_disk\"}", JsonSerializer.Serialize(b)));
            foreach (var key in keys.Take(6))
            {
                var check = (await service.CheckAsync(lab.Member.UserId, key, "standard", default))!;
                Assert.Equal(check.Blocked?.Reason, member.TryGetValue(key, out var b) ? b.Reason : null);
            }
            var admin = await service.StoragePausesAsync(lab.Admin.UserId, keys, true, default);
            Assert.Equal(("/tv/Firefly (2002)", "/tv", "/movies", "/movies/Held Full"), (admin[Firefly].Folder, admin[NewShow].Folder, admin["movie:tmdb:604"].Folder, admin["movie:tmdb:605"].Folder));
            // Nothing for a role that can't ask, nothing with the guard off.
            lab.Config.ArrRequestDefaultRole = "Watcher";
            Assert.Empty(await service.StoragePausesAsync(lab.Member.UserId, keys, true, default));
            lab.Config.ArrRequestDefaultRole = "Member";
            lab.Config.ArrLowDiskPercent = 0;
            Assert.Empty(await service.StoragePausesAsync(lab.Admin.UserId, keys, true, default));
        }
        // The reverse: roomy default roots, the drive a held title sits on full: only that title.
        using (var lab = new Lab(disks: "/tv=1500000000000/4000000000000;/tv2=2000000000/4000000000000"))
        {
            Movies(lab, 600, 1);
            await lab.LoadAsync();
            var service = Requests(lab, out var db);
            using var _ = db;
            var paused = await service.StoragePausesAsync(lab.Member.UserId, new[] { Firefly, OldShow, NewShow, "movie:tmdb:603", "movie:tmdb:604", "movie:tmdb:605" }, true, default);
            Assert.Equal(new[] { "movie:tmdb:603", OldShow }, paused.Keys.OrderBy(k => k, StringComparer.Ordinal));
        }
    }

    [Fact]
    public async Task StoragePausesReadTheListOfHeldTitlesFirstWhenAskedToWaitAndOnlyStartTheReadsOtherwise()
    {
        using var lab = new Lab();
        Movies(lab, 1, 600);
        var service = Requests(lab, out var db);
        using var _ = db;
        var radarr = lab.Arr.Instance("Radarr").Id;
        // Nothing in memory (a restart). Not waiting: nothing is marked yet (no guess on the default root), the reads start.
        Assert.Empty(await service.StoragePausesAsync(lab.Member.UserId, new[] { "movie:tmdb:603", "movie:tmdb:604" }, false, default));
        for (var i = 0; i < 500 && (lab.Store.PeekLibrary(radarr) == null || lab.Store.PeekSystem(radarr) == null); i++) await Task.Delay(10);
        Assert.NotNull(lab.Store.PeekLibrary(radarr));
        Assert.Equal(new[] { "movie:tmdb:604" }, (await service.StoragePausesAsync(lab.Member.UserId, new[] { "movie:tmdb:603", "movie:tmdb:604" }, false, default)).Keys);
        // Waiting: read first, then answered.
        using var cold = new Lab();
        Movies(cold, 1, 600);
        var other = Requests(cold, out var db2);
        using var __ = db2;
        Assert.Equal(new[] { "movie:tmdb:604" }, (await other.StoragePausesAsync(cold.Member.UserId, new[] { "movie:tmdb:603", "movie:tmdb:604" }, true, default)).Keys);
    }

    private static string CollectionBody(params (int Id, string Title, string Date)[] parts)
        => JsonSerializer.Serialize(new { id = 10, parts = parts.Select(p => new { id = p.Id, title = p.Title, release_date = p.Date }).ToArray() });

    [Fact]
    public async Task CollectionGapsMarkEachMissingMovieByItsOwnDriveNotTheHouseholdsNewAddPause()
    {
        foreach (var (defaultFree, otherFree, expected) in new[] { (1L, 600L, new[] { "movie:tmdb:604", "movie:tmdb:605" }), (600L, 1L, new[] { "movie:tmdb:603" }) })
        {
            using var lab = new Lab();
            Movies(lab, defaultFree, otherFree);
            var service = Requests(lab, out var db);
            using var _ = db;
            var box = Guid.NewGuid();
            var body = CollectionBody((603, "Held Roomy", "1999-03-31"), (604, "New", "2003-05-15"), (605, "Held Full", "2003-11-05"), (606, "Not out", "2031-01-01"));
            var gaps = new CollectionGapsService(lab.View, (_, id) => id == box ? new BoxSetRef(id, 10) : null, null, null,
                (_, _, _) => Task.FromResult<string?>(body), (_, _, _) => Task.FromResult(true), () => new DateTimeOffset(2026, 10, 15, 0, 0, 0, TimeSpan.Zero),
                pauses: (user, keys, ct) => service.StoragePausesAsync(user, keys, true, ct));
            // Cold after a restart: the collection waits for the disks and Radarr's list before answering.
            var member = (await gaps.ForCollectionAsync(lab.Member, box, null, default)).Gaps!;
            Assert.Equal(expected, member.Missing.Where(p => p.Blocked != null).Select(p => p.Key));
            Assert.Null(member.Missing.Single(p => p.Key == "movie:tmdb:606").Blocked);
            var json = JsonSerializer.Serialize(member);
            Assert.DoesNotContain("/movies", json, StringComparison.Ordinal);
            if (defaultFree == 1)
            {
                // The household's new-add pause is on all the same: it decides nothing here.
                Assert.NotNull(service.Me(lab.Member.UserId).PausedMovies);
                var admin = (await gaps.ForCollectionAsync(lab.Admin, box, null, default)).Gaps!;
                Assert.Equal(("/movies", "/movies/Held Full"), (admin.Missing.Single(p => p.Key == "movie:tmdb:604").Blocked!.Folder, admin.Missing.Single(p => p.Key == "movie:tmdb:605").Blocked!.Folder));
            }
            else
            {
                Assert.Null(service.Me(lab.Member.UserId).PausedMovies);
            }
        }
    }

    [Fact]
    public async Task DiscoverAndSearchCardsAreMarkedTitleByTitleOnEveryAnswerCachedOnesToo()
    {
        using var lab = new Lab();
        Movies(lab, 1, 600);
        var held = FakeArr.SeriesRow(3, 80000, "Tmdb Show", tmdb: 5000);
        held["path"] = "/tv2/Tmdb Show";
        lab.Sonarr.Series.Add(held);
        var service = Requests(lab, out var db);
        using var _ = db;
        var page = JsonSerializer.Serialize(new { page = 1, total_pages = 1, results = new object[]
        {
            new { id = 603, title = "Held Roomy", media_type = "movie" }, new { id = 604, title = "New", media_type = "movie" },
            new { id = 605, title = "Held Full", media_type = "movie" }, new { id = 5000, name = "Tmdb Show", media_type = "tv" }, new { id = 5001, name = "New Show", media_type = "tv" },
        } });
        var discover = new DiscoverService(service, new TitleAliases(lab.Store, null), (_, _, _, _) => Task.FromResult(true),
            (_, _, _) => Task.FromResult<string?>(page),
            (_, _) => new[] { new RecentTitle(true, 1, "Seed") }, _ => HiddenTitles.None, () => DateTimeOffset.UtcNow);

        // Pages read (and cached) while the guard is off: unmarked.
        lab.Config.ArrLowDiskPercent = 0;
        Assert.All((await discover.SearchAsync(lab.Member, "show", 1, null, default))!.Results, c => Assert.Null(c.Blocked));
        Assert.All((await discover.DiscoverAsync(lab.Member, "trending", "movie", 1, null, default))!.Results, c => Assert.Null(c.Blocked));
        Assert.Null(lab.Store.PeekSystem(lab.Arr.Instance("Radarr").Id));
        // Guard on, nothing read yet (a restart): nothing marked rather than a guess, and Discover doesn't wait for the reads.
        lab.Config.ArrLowDiskPercent = 10;
        Assert.All((await discover.SearchAsync(lab.Member, "show", 1, null, default))!.Results, c => Assert.Null(c.Blocked));
        await lab.LoadAsync();
        // The same (cached) page now says which titles are paused, each by its own drive.
        var member = (await discover.SearchAsync(lab.Member, "show", 1, null, default))!;
        Assert.Equal(new[] { "movie:tmdb:604", "movie:tmdb:605", "tv:tmdb:5001" }, member.Results.Where(c => c.Blocked != null).Select(c => c.Key));
        Assert.DoesNotContain("/tv", JsonSerializer.Serialize(member), StringComparison.Ordinal);
        var admin = (await discover.SearchAsync(lab.Admin, "show", 1, null, default))!;
        Assert.Equal("/movies/Held Full", admin.Results.Single(c => c.Key == "movie:tmdb:605").Blocked!.Folder);
        // Discover rows (this page was cached unmarked above) and "Because you watched" groups the same way.
        var row = (await discover.DiscoverAsync(lab.Member, "trending", "movie", 1, null, default))!;
        Assert.Equal(new[] { "movie:tmdb:604", "movie:tmdb:605" }, row.Results.Where(c => c.Blocked != null).Select(c => c.Key));
        var because = (await discover.DiscoverAsync(lab.Member, "because", "all", 1, null, default))!;
        Assert.Equal(new[] { "movie:tmdb:604", "movie:tmdb:605" }, because.Groups!.Single().Results.Where(c => c.Blocked != null).Select(c => c.Key));
        // Room again: the cached page is answered without marks.
        lab.Config.ArrLowDiskPercent = 0;
        Assert.All((await discover.SearchAsync(lab.Member, "show", 1, null, default))!.Results, c => Assert.Null(c.Blocked));
        Assert.All((await discover.DiscoverAsync(lab.Member, "because", "all", 1, null, default))!.Groups!.Single().Results, c => Assert.Null(c.Blocked));
    }
}
