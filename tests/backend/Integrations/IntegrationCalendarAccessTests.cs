using System.Security.Claims;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

/// <summary>
/// Who sees which Calendar rows: an upcoming title Jellyfin doesn't have yet is shown to a user who
/// isn't an administrator only when they may open the library its instance lands it in (linked
/// libraries first, else the folder through the path mappings; a folder no library holds, or a root
/// two instances share unmapped, is hidden); one Jellyfin has is Jellyfin's own check. Row ids are
/// unique per instance and source. The favourites/watched route reads data only for items the
/// caller can open.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationCalendarAccessTests
{
    // ------------------------------------------------------------------ the resolver

    private sealed class ResolverRig : IDisposable
    {
        public FakeArr Arr { get; } = new();
        public FakeLibraryAccess Library { get; } = new();
        public ArrStateStore Store { get; private set; } = null!;
        public ArrInstanceLibraries Resolver { get; private set; } = null!;
        public JfLibraryRoot Tv { get; }
        public JfLibraryRoot Kids { get; }
        public JfLibraryRoot Movies { get; }

        public ResolverRig()
        {
            Tv = Library.AddLibrary("TV", "tvshows", "/media/tv");
            Kids = Library.AddLibrary("Kids TV", "tvshows", "/media/tv/kids");
            Movies = Library.AddLibrary("Movies", "movies", "/media/movies");
        }

        public FakeArr.Host Add(string host, string app, params string[] roots)
        {
            var h = Arr.Add(host, app);
            foreach (var r in roots) h.RootFolders.Add(new JsonObject { ["path"] = r, ["freeSpace"] = 1L, ["accessible"] = true });
            return h;
        }

        public void Configure(Func<string, (string Arr, string Jf)[]> mappings, Func<string, string[]>? linked = null, params (string Name, ArrKind Kind, string Url)[] rows)
        {
            Arr.Configure(rows.Select(r => (r.Name, r.Kind, r.Url, "KEY-" + r.Name.Replace(' ', '-') + "-0123456789")).ToArray());
            var c = Arr.Plugin.Plugin.Configuration;
            c.SonarrInstances = Rewrite(c.SonarrInstances, mappings, linked);
            c.RadarrInstances = Rewrite(c.RadarrInstances, mappings, linked);
            Store = Arr.Store();
            Resolver = new ArrInstanceLibraries(Store, Library, () => Arr.Now);
        }

        private static string Rewrite(string json, Func<string, (string Arr, string Jf)[]> mappings, Func<string, string[]>? linked)
        {
            var rows = JsonNode.Parse(json)!.AsArray();
            foreach (var row in rows)
            {
                var name = (string)row!["Name"]!;
                row["PathMappings"] = new JsonArray(mappings(name).Select(m => (JsonNode)new JsonObject { ["ArrPath"] = m.Arr, ["JellyfinPath"] = m.Jf }).ToArray());
                row["LinkedLibraryIds"] = new JsonArray((linked?.Invoke(name) ?? Array.Empty<string>()).Select(l => (JsonNode)l).ToArray());
            }
            return rows.ToJsonString();
        }

        public async Task Roots()
        {
            foreach (var i in Arr.Registry.All()) await Store.GetSystemAsync(i, default);
        }

        public ArrLibraryTarget Resolve(string instance, string path) => Resolver.Resolve(Arr.Instance(instance), path);

        // The system reads a member's calendar started in the background (none when none is needed).
        public Task Warmed() => Task.WhenAll(Arr.Registry.All().Select(i => Store.WarmSystem(i) ?? Task.CompletedTask));

        public void Dispose() => Arr.Dispose();
    }

    private static Guid Id(JfLibraryRoot library) => Guid.Parse(library.Id);

    [Fact]
    public async Task LinkedLibrariesWinThenTheLongestMappingAndTheDeepestLibrary()
    {
        using var rig = new ResolverRig();
        rig.Add("sonarr.lan", "Sonarr", "/data/tv");
        rig.Add("sonarr2.lan", "Sonarr", "/data/tv");
        rig.Add("radarr.lan", "Radarr", "/data/movies");
        rig.Configure(name => name switch
            {
                "TV" => new[] { ("/data", "/elsewhere"), ("/data/tv", "/media/tv") },     // the longest mapping wins
                "TV 2" => new[] { ("/data/tv", "/media/tv/kids") },                       // the same arr path, another disk
                _ => new[] { ("/data/movies", "/media/movies") },
            },
            name => name == "Movies" ? new[] { rig.Kids.Id } : Array.Empty<string>(),
            ("TV", ArrKind.Sonarr, "http://sonarr.lan:8989"), ("TV 2", ArrKind.Sonarr, "http://sonarr2.lan:8989"), ("Movies", ArrKind.Radarr, "http://radarr.lan:7878"));
        await rig.Roots();

        var tv = rig.Resolve("TV", "/data/tv/Show A");
        Assert.Equal(new[] { Id(rig.Tv) }, tv.Libraries);
        Assert.Equal("mapped", tv.Via);
        // Two instances with the same root but their own mappings land in their own libraries (the deepest folder wins).
        Assert.Equal(new[] { Id(rig.Kids) }, rig.Resolve("TV 2", "/data/tv/Show B").Libraries);
        // Linked libraries beat the folder (which would say Movies).
        var movie = rig.Resolve("Movies", "/data/movies/Dune (2021)");
        Assert.Equal(new[] { Id(rig.Kids) }, movie.Libraries);
        Assert.Equal("linked", movie.Via);
        Assert.Equal(ArrLibraryProblem.NoPath, rig.Resolve("TV", " ").Problem);
        Assert.Equal(ArrLibraryProblem.NotInLibrary, rig.Resolve("TV", "/data/other/Show").Problem);
    }

    [Fact]
    public async Task IdenticalUnmappedRootsOnTwoInstancesResolveToNothingAndWindowsPathsIgnoreCase()
    {
        using var rig = new ResolverRig();
        rig.Library.AddLibrary("Shared", "tvshows", "/tv");
        var windows = rig.Library.AddLibrary("Windows TV", "tvshows", "D:/Media/TV");
        rig.Add("sonarr.lan", "Sonarr", "/tv");
        rig.Add("sonarr2.lan", "Sonarr", "/tv", "d:/media/tv");
        rig.Configure(_ => Array.Empty<(string, string)>(), null,
            ("TV", ArrKind.Sonarr, "http://sonarr.lan:8989"), ("TV 2", ArrKind.Sonarr, "http://sonarr2.lan:8989"));
        await rig.Roots();

        // Both say "/tv" with no mapping: two Docker containers, two disks; which one Jellyfin sees can't be told.
        Assert.Equal(ArrLibraryProblem.SharedRoot, rig.Resolve("TV", "/tv/Show").Problem);
        Assert.Equal(ArrLibraryProblem.SharedRoot, rig.Resolve("TV 2", "/tv/Show").Problem);
        Assert.False(rig.Resolve("TV", "/tv/Show").Resolved);
        // A Windows path matches its library whatever the case.
        Assert.Equal(new[] { Guid.Parse(windows.Id) }, rig.Resolve("TV 2", "d:/media/tv/Show").Libraries);

        // Mapping one of them tells them apart again (the answers follow the configuration at once).
        var c = rig.Arr.Plugin.Plugin.Configuration;
        var rows = JsonNode.Parse(c.SonarrInstances)!.AsArray();
        rows.First(r => (string)r!["Name"]! == "TV")!["PathMappings"] = new JsonArray(new JsonObject { ["ArrPath"] = "/tv", ["JellyfinPath"] = "/media/tv" });
        c.SonarrInstances = rows.ToJsonString();
        Assert.Equal(new[] { Id(rig.Tv) }, rig.Resolve("TV", "/tv/Show").Libraries);
        Assert.True(rig.Resolve("TV 2", "/tv/Show").Resolved);
    }

    [Fact]
    public async Task AMappingBelowASharedRootPlacesTheTitlesItCovers()
    {
        using var rig = new ResolverRig();
        rig.Library.AddLibrary("Shared", "tvshows", "/tv");
        rig.Add("sonarr.lan", "Sonarr", "/tv");
        rig.Add("sonarr2.lan", "Sonarr", "/tv");
        // Both say "/tv" unmapped, but TV maps its kids' folder below it to Jellyfin's Kids TV.
        rig.Configure(name => name == "TV" ? new[] { ("/tv/kids", "/media/tv/kids") } : Array.Empty<(string, string)>(), null,
            ("TV", ArrKind.Sonarr, "http://sonarr.lan:8989"), ("TV 2", ArrKind.Sonarr, "http://sonarr2.lan:8989"));
        await rig.Roots();

        var kids = rig.Resolve("TV", "/tv/kids/Show");
        Assert.Equal(new[] { Id(rig.Kids) }, kids.Libraries);
        Assert.Equal("mapped", kids.Via);
        // The rest of the shared root is still anybody's disk.
        Assert.Equal(ArrLibraryProblem.SharedRoot, rig.Resolve("TV", "/tv/Other show").Problem);
        Assert.Equal(ArrLibraryProblem.SharedRoot, rig.Resolve("TV 2", "/tv/kids/Show").Problem);
    }

    [Fact]
    public async Task WithoutEveryInstancesRootFoldersTheArrsOwnPathPlacesNothing()
    {
        using var rig = new ResolverRig();
        rig.Library.AddLibrary("Shared", "tvshows", "/tv");
        rig.Add("sonarr.lan", "Sonarr", "/tv");
        rig.Add("sonarr2.lan", "Sonarr", "/tv");
        rig.Add("radarr.lan", "Radarr", "/movies");
        rig.Configure(name => name == "Movies" ? new[] { ("/movies", "/media/movies") } : Array.Empty<(string, string)>(), null,
            ("TV", ArrKind.Sonarr, "http://sonarr.lan:8989"), ("TV 2", ArrKind.Sonarr, "http://sonarr2.lan:8989"), ("Movies", ArrKind.Radarr, "http://radarr.lan:7878"));

        // No system snapshot read yet (a restart): nothing is placed by the arr's own path ...
        Assert.Equal(ArrLibraryProblem.RootsUnknown, rig.Resolve("TV", "/tv/Show").Problem);
        // ... while a path mapping still tells where a title lands.
        Assert.Equal(new[] { Id(rig.Movies) }, rig.Resolve("Movies", "/movies/Dune (2021)").Libraries);
        // Every other instance's folders known but not TV's own: which of its roots holds the title can't be told.
        await rig.Store.GetSystemAsync(rig.Arr.Instance("TV 2"), default);
        await rig.Store.GetSystemAsync(rig.Arr.Instance("Movies"), default);
        Assert.Equal(ArrLibraryProblem.RootsUnknown, rig.Resolve("TV", "/tv/Show").Problem);
        // Only TV's own folders known (TV 2's unknown): TV 2's may be the same, so still nothing.
        Assert.Equal(ArrLibraryProblem.RootsUnknown, rig.Resolve("TV 2", "/tv/Show").Problem);
        // Once both are known they are the same unmapped root: shared.
        await rig.Store.GetSystemAsync(rig.Arr.Instance("TV"), default);
        Assert.Equal(ArrLibraryProblem.SharedRoot, rig.Resolve("TV", "/tv/Show").Problem);
    }

    [Fact]
    public async Task AnswersFollowTheCurrentRegistryNotTheCallersOlderCopy()
    {
        using var rig = new ResolverRig();
        rig.Add("sonarr.lan", "Sonarr", "/data/tv");
        rig.Configure(_ => new[] { ("/data/tv", "/media/tv/kids") }, null, ("TV", ArrKind.Sonarr, "http://sonarr.lan:8989"));
        await rig.Roots();
        var stale = rig.Arr.Instance("TV");
        Assert.Equal(new[] { Id(rig.Kids) }, rig.Resolver.Resolve(stale, "/data/tv/Show A").Libraries);

        // An administrator moves the mapping to the grown-ups' TV library while a request still holds the old instance.
        var c = rig.Arr.Plugin.Plugin.Configuration;
        var rows = JsonNode.Parse(c.SonarrInstances)!.AsArray();
        rows[0]!["PathMappings"] = new JsonArray(new JsonObject { ["ArrPath"] = "/data/tv", ["JellyfinPath"] = "/media/tv" });
        c.SonarrInstances = rows.ToJsonString();
        Assert.Equal(new[] { Id(rig.Tv) }, rig.Resolver.Resolve(stale, "/data/tv/Show B").Libraries);
        // Nothing decided from the old copy was kept for later callers.
        Assert.Equal(new[] { Id(rig.Tv) }, rig.Resolve("TV", "/data/tv/Show B").Libraries);
        Assert.Equal(new[] { Id(rig.Tv) }, rig.Resolver.Resolve(stale, "/data/tv/Show A").Libraries);
        // Linked libraries set later win for the old copy too.
        rows = JsonNode.Parse(c.SonarrInstances)!.AsArray();
        rows[0]!["LinkedLibraryIds"] = new JsonArray(JsonValue.Create(rig.Movies.Id));
        c.SonarrInstances = rows.ToJsonString();
        var linked = rig.Resolver.Resolve(stale, "/data/tv/Show A");
        Assert.Equal(new[] { Id(rig.Movies) }, linked.Libraries);
        Assert.Equal("linked", linked.Via);
    }

    [Fact]
    public async Task ThePathDoctorFlagsRootsWhoseUpcomingTitlesMembersDontSee()
    {
        using var rig = new ResolverRig();
        rig.Arr.Plugin.Plugin.Configuration.CalendarPageEnabled = true;
        rig.Arr.Plugin.Plugin.Configuration.CalendarFilterByLibraryAccess = true;
        rig.Add("sonarr.lan", "Sonarr", "/data/tv");
        rig.Add("sonarr2.lan", "Sonarr", "/shared");
        rig.Add("sonarr3.lan", "Sonarr", "/shared");
        rig.Add("radarr.lan", "Radarr", "/data/movies");
        rig.Library.AddLibrary("Shared", "tvshows", "/shared");
        rig.Configure(name => name == "TV" ? new[] { ("/data/tv", "/media/tv") } : Array.Empty<(string, string)>(),
            name => name == "Linked" ? new[] { rig.Movies.Id } : Array.Empty<string>(),
            ("TV", ArrKind.Sonarr, "http://sonarr.lan:8989"), ("A", ArrKind.Sonarr, "http://sonarr2.lan:8989"), ("B", ArrKind.Sonarr, "http://sonarr3.lan:8989"), ("Movies", ArrKind.Radarr, "http://radarr.lan:7878"));
        await rig.Roots();
        rig.Library.Folders.UnionWith(new[] { "/media/tv", "/shared", "/data/movies" });
        using var bridge = new JellyfinBridge(rig.Store, rig.Library, null, () => rig.Arr.Plugin.Plugin.Configuration, () => rig.Arr.Now, null);

        var doctor = bridge.PathDoctor().ToDictionary(d => d.Instance);
        var tv = Assert.Single(doctor["TV"].Roots);
        Assert.Equal(((string?)null, false), (tv.Problem, tv.HiddenFromMembers));
        var shared = Assert.Single(doctor["A"].Roots);
        Assert.Equal(("shared_root", true, "problem"), (shared.Problem, shared.HiddenFromMembers, doctor["A"].Verdict));
        var movies = Assert.Single(doctor["Movies"].Roots);
        Assert.Equal(("not_in_library", true), (movies.Problem, movies.HiddenFromMembers));
    }

    [Theory]
    [InlineData(false, true, true)]
    [InlineData(true, false, true)]
    [InlineData(false, true, false)]
    [InlineData(true, false, false)]
    public async Task ThePathDoctorOnlyFlagsCalendarAccessProblemsWhenThePageAndFilterAreOn(bool page, bool filter, bool rootsKnown)
    {
        using var rig = new ResolverRig();
        rig.Library.AddLibrary("Shared", "tvshows", "/shared");
        rig.Library.Folders.Add("/shared");
        rig.Add("sonarr.lan", "Sonarr", "/shared");
        rig.Add("sonarr2.lan", "Sonarr", "/shared");
        rig.Configure(_ => Array.Empty<(string, string)>(), null,
            ("A", ArrKind.Sonarr, "http://sonarr.lan:8989"), ("B", ArrKind.Sonarr, "http://sonarr2.lan:8989"));
        if (rootsKnown) await rig.Roots();
        else await rig.Store.GetSystemAsync(rig.Arr.Instance("A"), default);
        var config = rig.Arr.Plugin.Plugin.Configuration;
        config.CalendarPageEnabled = page;
        config.CalendarFilterByLibraryAccess = filter;
        using var bridge = new JellyfinBridge(rig.Store, rig.Library, null, () => config, () => rig.Arr.Now, null);

        var doctor = bridge.PathDoctor();
        Assert.All(doctor.SelectMany(d => d.Roots), r =>
        {
            Assert.False(r.HiddenFromMembers);
            Assert.Null(r.Problem);
        });
        Assert.Equal("ok", doctor.Single(d => d.Instance == "A").Verdict);
        if (rootsKnown) Assert.Equal("ok", doctor.Single(d => d.Instance == "B").Verdict);
    }

    [Fact]
    public void TheFolderRuleIsBlockedThenAllThenEnabled()
    {
        var tv = Guid.NewGuid();
        var kids = Guid.NewGuid();
        var all = new User("all", "default", "default") { Id = Guid.NewGuid() };
        all.SetPermission(PermissionKind.EnableAllFolders, true);
        Assert.True(ArrInstanceLibraries.CanOpen(all, new[] { tv }));
        all.SetPreference(PreferenceKind.BlockedMediaFolders, [tv.ToString("N")]);
        Assert.False(ArrInstanceLibraries.CanOpen(all, new[] { tv }));             // blocked beats "all libraries"
        Assert.True(ArrInstanceLibraries.CanOpen(all, new[] { tv, kids }));        // another of the instance's libraries is open
        var some = new User("some", "default", "default") { Id = Guid.NewGuid() };
        some.SetPermission(PermissionKind.EnableAllFolders, false);
        some.SetPreference(PreferenceKind.EnabledFolders, [kids.ToString("N")]);
        Assert.False(ArrInstanceLibraries.CanOpen(some, new[] { tv }));
        Assert.True(ArrInstanceLibraries.CanOpen(some, new[] { kids }));
    }

    // ------------------------------------------------------------------ the Calendar route

    private sealed class CalendarRig : IDisposable
    {
        public ResolverRig R { get; } = new();
        public FakeArr.Host Tv { get; }
        public FakeArr.Host Tv2 { get; }
        public FakeArr.Host Radarr { get; }
        public TestCallers Callers { get; } = new();
        public Mock<ILibraryManager> Library { get; } = new();
        public Mock<IUserDataManager> UserData { get; } = new();
        public IntegrationCalendarTests.CalendarDatabase Database { get; } = new();
        public User Member { get; }
        public User Kid { get; }
        public TitleAliases? Aliases { get; set; }

        public CalendarRig()
        {
            Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(new List<BaseItem>());
            Tv = R.Add("sonarr.lan", "Sonarr", "/data/tv");
            Tv2 = R.Add("sonarr2.lan", "Sonarr", "/data/tv");
            Radarr = R.Add("radarr.lan", "Radarr", "/data/movies");
            // TV maps into the TV library, TV 2 into Kids TV; Radarr has no mapping and Jellyfin's
            // movie library is elsewhere (/media/movies), so its folder resolves to no library.
            R.Configure(name => name switch
                {
                    "TV" => new[] { ("/data/tv", "/media/tv") },
                    "TV 2" => new[] { ("/data/tv", "/media/tv/kids") },
                    _ => Array.Empty<(string, string)>(),
                }, null,
                ("TV", ArrKind.Sonarr, "http://sonarr.lan:8989"), ("TV 2", ArrKind.Sonarr, "http://sonarr2.lan:8989"), ("Movies", ArrKind.Radarr, "http://radarr.lan:7878"));
            var c = R.Arr.Plugin.Plugin.Configuration;
            c.CalendarPageEnabled = true;
            c.CalendarFilterByLibraryAccess = true;
            // Both Sonarrs number an episode 42 (different series); the movie has a digital release.
            Tv.Calendar.Add(FakeArr.Episode(42, "2026-10-20T20:00:00Z", "Show A", tvdb: 501));
            Tv2.Calendar.Add(FakeArr.Episode(42, "2026-10-20T20:00:00Z", "Show B", tvdb: 502));
            Radarr.Calendar.Add(FakeArr.Movie(7, 438631, "Dune", hasFile: false, digital: "2026-10-21"));
            Member = Callers.Register(Guid.NewGuid(), admin: false, "member");
            Member.SetPermission(PermissionKind.EnableAllFolders, false);
            Member.SetPreference(PreferenceKind.EnabledFolders, [R.Tv.Id]);
            Kid = Callers.Register(Guid.NewGuid(), admin: false, "kid");
            Kid.SetPermission(PermissionKind.EnableAllFolders, true);
            Kid.MaxParentalRatingScore = 10;
        }

        public JellyfinEnhancedController Controller(ClaimsPrincipal caller)
        {
            var controller = ApiAssetTests.Controller(R.Arr.Plugin.Core, R.Arr.Transport, R.Store, R.Arr.Factory, Database, Callers.Users.Object, Library.Object, UserData.Object, R.Resolver, Aliases!);
            controller.HttpContext.User = caller;
            controller.Request.QueryString = new QueryString("?start=2026-10-12&end=2026-10-31");
            return controller;
        }

        public async Task<List<ArrItem>> Events(ClaimsPrincipal caller)
        {
            var root = JsonSerializer.SerializeToElement(Assert.IsType<OkObjectResult>(await Controller(caller).GetCalendarEvents()).Value);
            return JsonSerializer.Deserialize<List<ArrItem>>(root.GetProperty("events"))!;
        }

        public void Dispose() => R.Dispose();
    }

    private static string[] Titles(IEnumerable<ArrItem> events) => events.Select(e => e.Title).OrderBy(t => t, StringComparer.Ordinal).ToArray();

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CalendarAndAudienceUseSeerrAliasesBeforeFallingBackToAnUpcomingTitlesLibrary(bool visible)
    {
        using var rig = new CalendarRig();
        using var seerr = new FakeSeerr();
        var config = rig.R.Arr.Plugin.Plugin.Configuration;
        config.ArrIntegrationEnabled = config.ArrPhase1Enabled = config.JellyseerrEnabled = true;
        config.JellyseerrUrls = FakeSeerr.Url;
        config.JellyseerrApiKey = FakeSeerr.Key;
        var request = FakeSeerr.Request(1, "tv", 9501, 2, rig.Member.Id, rig.R.Arr.Now.UtcDateTime, tvdb: 501);
        request["media"]!["imdbId"] = "tt501";
        seerr.Requests.Add(request);
        using var requests = new SeerrRequestReadModel(seerr.Transport, null, null, () => config, () => rig.R.Arr.Now);
        Assert.True(await requests.RefreshAsync(default));
        rig.Aliases = new TitleAliases(rig.R.Store, requests);
        var series = new MediaBrowser.Controller.Entities.TV.Series { Id = Guid.NewGuid() };
        using (var db = rig.Database.CreateDbContext())
        {
            db.BaseItemProviders.Add(new BaseItemProvider { Item = null!, ItemId = series.Id, ProviderId = "Imdb", ProviderValue = "tt501" });
            db.SaveChanges();
        }
        rig.Library.Setup(l => l.GetItemById<BaseItem>(series.Id, It.IsAny<User>())).Returns(visible ? series : null);
        rig.Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
            q.HasAnyProviderId?.Values.Contains("tt501") == true && (q.User == null || visible)
                ? new List<BaseItem> { series } : new List<BaseItem>());
        var rows = await rig.Events(TestCallers.Principal(rig.Member.Id, admin: false));
        if (visible) Assert.Equal(series.Id, Assert.Single(rows).ItemId);
        else Assert.Empty(rows); // The instance lands in her TV library, but Jellyfin hides this title.
        var audience = new ArrFeedAudience(rig.Library.Object, rig.Callers.Users.Object,
            rig.R.Store, () => rig.R.Arr.Now, null, requests);
        var change = new ArrFeedChange("tv:tvdb:501", 1, rig.R.Arr.Instance("TV").Id);
        var shown = audience.Visible(rig.Member.Id, false, new[] { change });
        Assert.Equal(visible ? new[] { change.Key } : Array.Empty<string>(), shown);
    }

    [Fact]
    public async Task UpcomingTitlesFollowTheLibraryTheirInstanceLandsThemIn()
    {
        using var rig = new CalendarRig();
        var admin = await rig.Events(TestCallers.Principal(rig.Callers.Register(Guid.NewGuid(), admin: true).Id, admin: true));
        Assert.Equal(new[] { "Dune", "Show A", "Show B" }, Titles(admin));   // administrators: everything

        // The member may open TV only: Show B lands in Kids TV, Dune's folder in no library (unresolved).
        Assert.Equal(new[] { "Show A" }, Titles(await rig.Events(TestCallers.Principal(rig.Member.Id, admin: false))));
        await rig.R.Warmed();                                               // Dune's unmapped folder started the root-folder reads
        var calls = rig.R.Arr.CallCount();
        // All libraries (and a rating limit, which can't judge titles Jellyfin doesn't have yet): the
        // resolved ones; never the unresolved one.
        Assert.Equal(new[] { "Show A", "Show B" }, Titles(await rig.Events(TestCallers.Principal(rig.Kid.Id, admin: false))));
        // A folder blocked for them hides it whatever else they may open.
        rig.Kid.SetPreference(PreferenceKind.BlockedMediaFolders, [rig.R.Kids.Id]);
        Assert.Equal(new[] { "Show A" }, Titles(await rig.Events(TestCallers.Principal(rig.Kid.Id, admin: false))));
        Assert.Equal(calls, rig.R.Arr.CallCount());                         // warm: decided from memory, no arr call

        // No user (an unknown one, or none at all): no rows.
        Assert.Empty(await rig.Events(TestCallers.Principal(Guid.NewGuid(), admin: false)));
        Assert.Empty(await rig.Events(new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.Role, "User")], "test"))));

        // The filter off: everyone sees everything, as before.
        rig.R.Arr.Plugin.Plugin.Configuration.CalendarFilterByLibraryAccess = false;
        Assert.Equal(new[] { "Dune", "Show A", "Show B" }, Titles(await rig.Events(TestCallers.Principal(rig.Member.Id, admin: false))));
    }

    [Fact]
    public async Task ATitleJellyfinHasIsJellyfinsOwnCheckAndDuplicatesKeepTheVisibleCopy()
    {
        using var rig = new CalendarRig();
        // Show A is in Jellyfin as a series the member can't open (its rating), even though TV is theirs.
        var seriesId = Guid.NewGuid();
        using (var db = rig.Database.CreateDbContext())
        {
            db.BaseItemProviders.Add(new BaseItemProvider { Item = null!, ItemId = seriesId, ProviderId = "Tvdb", ProviderValue = "501" });
            db.SaveChanges();
        }
        rig.Library.Setup(l => l.GetItemById<BaseItem>(seriesId, It.IsAny<User>())).Returns((Guid _, User u) => u.Id == rig.Kid.Id ? new MediaBrowser.Controller.Entities.TV.Series { Id = seriesId } : null);
        Assert.Empty(await rig.Events(TestCallers.Principal(rig.Member.Id, admin: false)));
        Assert.Contains("Show A", Titles(await rig.Events(TestCallers.Principal(rig.Kid.Id, admin: false))));

    }

    [Fact]
    public async Task AnEpisodeJellyfinHidesFromTheCallerIsHiddenEvenWhenTheirSeriesIsNot()
    {
        using var rig = new CalendarRig();
        rig.Tv.Calendar.Clear();
        rig.Tv2.Calendar.Clear();
        // Show A is in Jellyfin and the kid may open it; of its two upcoming episodes (Sonarr episode
        // tvdb ids 9043 / 9044, both in Jellyfin), S01E03 carries a rating that hides it from them.
        rig.Tv.Calendar.Add(FakeArr.Episode(43, "2026-10-20T20:00:00Z", "Show A", tvdb: 501, episode: 3));
        rig.Tv.Calendar.Add(FakeArr.Episode(44, "2026-10-21T20:00:00Z", "Show A", tvdb: 501, episode: 4));
        var seriesId = Guid.NewGuid();
        var hidden = Guid.NewGuid();
        var open = Guid.NewGuid();
        using (var db = rig.Database.CreateDbContext())
        {
            db.BaseItemProviders.Add(new BaseItemProvider { Item = null!, ItemId = seriesId, ProviderId = "Tvdb", ProviderValue = "501" });
            db.BaseItemProviders.Add(new BaseItemProvider { Item = null!, ItemId = hidden, ProviderId = "Tvdb", ProviderValue = "9043" });
            db.BaseItemProviders.Add(new BaseItemProvider { Item = null!, ItemId = open, ProviderId = "Tvdb", ProviderValue = "9044" });
            db.SaveChanges();
        }
        rig.Library.Setup(l => l.GetItemById<BaseItem>(seriesId, It.IsAny<User>())).Returns(new MediaBrowser.Controller.Entities.TV.Series { Id = seriesId });
        rig.Library.Setup(l => l.GetItemById<BaseItem>(open, It.IsAny<User>())).Returns(new MediaBrowser.Controller.Entities.TV.Episode { Id = open });
        rig.Library.Setup(l => l.GetItemById<BaseItem>(hidden, It.IsAny<User>())).Returns((Guid _, User u) => u.Id == rig.Kid.Id ? null : new MediaBrowser.Controller.Entities.TV.Episode { Id = hidden });

        var kid = await rig.Events(TestCallers.Principal(rig.Kid.Id, admin: false));
        Assert.Equal(new int?[] { 4 }, kid.Where(e => e.Title == "Show A").Select(e => e.EpisodeNumber).ToArray());
        Assert.DoesNotContain(kid, e => e.ItemEpisodeId == hidden);
        // Someone the episode isn't hidden from sees both.
        Assert.Equal(2, (await rig.Events(TestCallers.Principal(rig.Member.Id, admin: false))).Count(e => e.Title == "Show A"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CalendarEpisodesWithoutMatchingProviderIdsStillNeedTheCallersEpisodeAccess(bool episodeVisible)
    {
        using var rig = new CalendarRig();
        rig.Tv.Calendar.Clear();
        rig.Tv2.Calendar.Clear();
        foreach (var number in new[] { 3, 4, 6 })
            rig.Tv.Calendar.Add(FakeArr.Episode(40 + number, "2026-10-20T20:00:00Z", "Show A", tvdb: 501, episode: number));
        var series = new MediaBrowser.Controller.Entities.TV.Series { Id = Guid.NewGuid() };
        var episode = new MediaBrowser.Controller.Entities.TV.Episode { Id = Guid.NewGuid(), SeriesId = series.Id, ParentIndexNumber = 1, IndexNumber = 3 };
        var combined = new MediaBrowser.Controller.Entities.TV.Episode { Id = Guid.NewGuid(), SeriesId = series.Id, ParentIndexNumber = 1, IndexNumber = 5, IndexNumberEnd = 6 };
        using (var db = rig.Database.CreateDbContext())
        {
            db.BaseItemProviders.Add(new BaseItemProvider { Item = null!, ItemId = series.Id, ProviderId = "Tvdb", ProviderValue = "501" });
            db.SaveChanges();
        }
        // The episodes have no provider ids; only their numbers identify them in this series copy.
        rig.Library.Setup(l => l.GetItemById<BaseItem>(series.Id, It.IsAny<User>())).Returns(series);
        rig.Library.Setup(l => l.GetItemById<BaseItem>(episode.Id, It.IsAny<User>())).Returns(episodeVisible ? episode : null);
        rig.Library.Setup(l => l.GetItemById<BaseItem>(combined.Id, It.IsAny<User>())).Returns((BaseItem?)null);
        rig.Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(new List<BaseItem> { episode, combined });

        var member = (await rig.Events(TestCallers.Principal(rig.Member.Id, admin: false))).Where(e => e.Title == "Show A").OrderBy(e => e.EpisodeNumber).ToList();
        Assert.Equal(episodeVisible ? new int?[] { 3, 4 } : new int?[] { 4 }, member.Select(e => e.EpisodeNumber));
        Assert.Null(Assert.Single(member, e => e.EpisodeNumber == 4).ItemEpisodeId); // absent: the series decides
        if (episodeVisible) Assert.Equal(episode.Id, Assert.Single(member, e => e.EpisodeNumber == 3).ItemEpisodeId);
        rig.Library.Verify(l => l.GetItemList(It.Is<InternalItemsQuery>(q => q.User == null && q.Recursive
            && q.AncestorIds.SequenceEqual(new[] { series.Id }) && q.ParentIndexNumber == 1
            && q.IncludeItemTypes.SequenceEqual(new[] { Jellyfin.Data.Enums.BaseItemKind.Episode }))), Times.Once); // one read per copy and season
        Assert.Equal(3, (await rig.Events(TestCallers.Principal(Guid.NewGuid(), admin: true))).Count(e => e.Title == "Show A"));
    }

    /// <summary>A hidden long combined file hides calendar episodes even without episode provider ids.</summary>
    [Fact]
    public async Task CalendarEpisodesInAHiddenLongCombinedFileNeedTheCallersEpisodeAccess()
    {
        using var rig = new CalendarRig();
        rig.Tv.Calendar.Clear();
        rig.Tv2.Calendar.Clear();
        rig.Tv.Calendar.Add(FakeArr.Episode(95, "2026-10-20T20:00:00Z", "Show A", tvdb: 501, episode: 55));
        var series = new MediaBrowser.Controller.Entities.TV.Series { Id = Guid.NewGuid() };
        var combined = new MediaBrowser.Controller.Entities.TV.Episode { Id = Guid.NewGuid(), SeriesId = series.Id, ParentIndexNumber = 1, IndexNumber = 5, IndexNumberEnd = 70 };
        using (var db = rig.Database.CreateDbContext())
        {
            db.BaseItemProviders.Add(new BaseItemProvider { Item = null!, ItemId = series.Id, ProviderId = "Tvdb", ProviderValue = "501" });
            db.SaveChanges();
        }
        // Only the series has a provider id; E55 is covered by the hidden E05-E70 file.
        rig.Library.Setup(l => l.GetItemById<BaseItem>(series.Id, It.IsAny<User>())).Returns(series);
        rig.Library.Setup(l => l.GetItemById<BaseItem>(combined.Id, It.IsAny<User>())).Returns((BaseItem?)null);
        rig.Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(new List<BaseItem> { combined });

        Assert.DoesNotContain(await rig.Events(TestCallers.Principal(rig.Member.Id, admin: false)), e => e.Title == "Show A");
        var admin = Assert.Single(await rig.Events(TestCallers.Principal(Guid.NewGuid(), admin: true)), e => e.Title == "Show A");
        Assert.Equal(55, admin.EpisodeNumber);
    }

    [Fact]
    public async Task AnUnreadableEpisodeLookupHidesTheCalendarEventWithoutLookingUpAnEmptyId()
    {
        using var rig = new CalendarRig();
        rig.Tv2.Calendar.Clear();
        var series = new MediaBrowser.Controller.Entities.TV.Series { Id = Guid.NewGuid() };
        using (var db = rig.Database.CreateDbContext())
        {
            db.BaseItemProviders.Add(new BaseItemProvider { Item = null!, ItemId = series.Id, ProviderId = "Tvdb", ProviderValue = "501" });
            db.SaveChanges();
        }
        rig.Library.Setup(l => l.GetItemById<BaseItem>(series.Id, It.IsAny<User>())).Returns(series);
        rig.Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Throws(new InvalidOperationException("library unavailable"));

        Assert.Empty(await rig.Events(TestCallers.Principal(rig.Member.Id, admin: false)));
        rig.Library.Verify(l => l.GetItemById<BaseItem>(Guid.Empty, It.IsAny<User>()), Times.Never);
        rig.Library.Verify(l => l.GetItemById<BaseItem>(Guid.Empty), Times.Never);
        Assert.Contains("Show A", Titles(await rig.Events(TestCallers.Principal(Guid.NewGuid(), admin: true))));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ATitleInTwoLibrariesIsShownWhenTheCallerMayOpenOneCopyWhicheverCopyJellyfinListsFirst(bool blockedFirst)
    {
        using var rig = new CalendarRig();
        rig.Tv.Calendar.Clear();
        rig.Tv2.Calendar.Clear();
        // Show A is in Jellyfin twice: in TV (the member's) and in a library the member can't open.
        // Both copies have S01E05 (Sonarr episode tvdb id 9045); only the other copy has S01E06 (9046).
        // Dune is in two movie libraries the same way.
        rig.Tv.Calendar.Add(FakeArr.Episode(45, "2026-10-20T20:00:00Z", "Show A", tvdb: 501, episode: 5));
        rig.Tv.Calendar.Add(FakeArr.Episode(46, "2026-10-21T20:00:00Z", "Show A", tvdb: 501, episode: 6));
        static Guid G(int n) => new(n, 0, 0, new byte[8]);
        // Which copy Jellyfin lists first (by key and by insertion): the blocked one, or the open one.
        var (open, blocked) = blockedFirst ? (G(2), G(1)) : (G(1), G(2));
        var (openEpisode, blockedEpisode) = blockedFirst ? (G(4), G(3)) : (G(3), G(4));
        var (openMovie, blockedMovie) = blockedFirst ? (G(6), G(5)) : (G(5), G(6));
        var onlyBlocked = G(7);
        using (var db = rig.Database.CreateDbContext())
        {
            foreach (var (id, provider, value) in new[]
                {
                    (blocked, "Tvdb", "501"), (open, "Tvdb", "501"),
                    (blockedEpisode, "Tvdb", "9045"), (openEpisode, "Tvdb", "9045"),
                    (blockedMovie, "Tmdb", "438631"), (openMovie, "Tmdb", "438631"),
                    (onlyBlocked, "Tvdb", "9046"),
                }.OrderBy(r => r.Item1))                          // the lower id is also added first
                db.BaseItemProviders.Add(new BaseItemProvider { Item = null!, ItemId = id, ProviderId = provider, ProviderValue = value });
            db.SaveChanges();
        }
        BaseItem Series(Guid id) => new MediaBrowser.Controller.Entities.TV.Series { Id = id };
        BaseItem Episode(Guid id, Guid series) => new MediaBrowser.Controller.Entities.TV.Episode { Id = id, SeriesId = series };
        BaseItem Movie(Guid id) => new MediaBrowser.Controller.Entities.Movies.Movie { Id = id };
        var everyone = new Dictionary<Guid, BaseItem>
        {
            [open] = Series(open), [blocked] = Series(blocked), [openMovie] = Movie(openMovie), [blockedMovie] = Movie(blockedMovie),
            [openEpisode] = Episode(openEpisode, open), [blockedEpisode] = Episode(blockedEpisode, blocked), [onlyBlocked] = Episode(onlyBlocked, blocked),
        };
        foreach (var (id, item) in everyone)
        {
            rig.Library.Setup(l => l.GetItemById<BaseItem>(id)).Returns(item);
            // The member can't open the other library; S01E05 carries a rating that hides it from the kid in both copies.
            var inOther = id == blocked || id == blockedEpisode || id == blockedMovie || id == onlyBlocked;
            var rated = id == openEpisode || id == blockedEpisode;
            rig.Library.Setup(l => l.GetItemById<BaseItem>(id, It.IsAny<User>())).Returns((Guid _, User u) =>
                (u.Id == rig.Member.Id && inOther) || (u.Id == rig.Kid.Id && rated) ? null : item);
        }

        // Administrators see the copy picked for everyone: this order really puts the blocked copy first (or not).
        var admin = await rig.Events(TestCallers.Principal(rig.Callers.Register(Guid.NewGuid(), admin: true).Id, admin: true));
        Assert.Equal(blockedFirst ? blockedEpisode : openEpisode, admin.Single(e => e.EpisodeNumber == 5).ItemEpisodeId);

        // The member sees both episodes and the movie, each pointing at their own copy; S01E06 isn't in
        // their copy yet, so the series decides and no episode of the other library is linked.
        var member = await rig.Events(TestCallers.Principal(rig.Member.Id, admin: false));
        Assert.Equal(new[] { "Dune", "Show A", "Show A" }, Titles(member));
        var fifth = member.Single(e => e.EpisodeNumber == 5);
        Assert.Equal((open, openEpisode), (fifth.ItemId, fifth.ItemEpisodeId));
        var sixth = member.Single(e => e.EpisodeNumber == 6);
        Assert.Equal((open, (Guid?)null), (sixth.ItemId, sixth.ItemEpisodeId));
        Assert.Equal(openMovie, member.Single(e => e.Title == "Dune").ItemId);

        // The kid may open every library, but S01E05 is hidden from them in both copies: hidden. S01E06
        // is open in the other copy, which the event then points at.
        var kid = await rig.Events(TestCallers.Principal(rig.Kid.Id, admin: false));
        Assert.Equal(new int?[] { 6 }, kid.Where(e => e.Title == "Show A").Select(e => e.EpisodeNumber).ToArray());
        var kidSixth = kid.Single(e => e.Title == "Show A");
        Assert.Equal((blocked, onlyBlocked), (kidSixth.ItemId, kidSixth.ItemEpisodeId));
    }

    [Fact]
    public async Task AnUpcomingTitleIsHiddenWhileAnotherInstancesRootFoldersCantBeRead()
    {
        // Two unmapped, unlinked Sonarrs; Jellyfin's library is at /data/tv (TV's root). TV 2's
        // root folders can't be read (its disk space call fails), so whether "/data/tv" is TV 2's
        // disk too can't be told: TV's upcoming episode, whose calendar read works, stays hidden.
        using var rig = new ResolverRig();
        rig.Library.AddLibrary("Same path", "tvshows", "/data/tv");
        var tv = rig.Add("sonarr.lan", "Sonarr", "/data/tv");
        var tv2 = rig.Add("sonarr2.lan", "Sonarr", "/data/other");
        rig.Configure(_ => Array.Empty<(string, string)>(), null, ("TV", ArrKind.Sonarr, "http://sonarr.lan:8989"), ("TV 2", ArrKind.Sonarr, "http://sonarr2.lan:8989"));
        var config = rig.Arr.Plugin.Plugin.Configuration;
        config.CalendarPageEnabled = true;
        config.CalendarFilterByLibraryAccess = true;
        tv.Calendar.Add(FakeArr.Episode(42, "2026-10-20T20:00:00Z", "Show A", tvdb: 501));
        var broken = true;
        tv2.Before = (path, _) => broken && path.EndsWith("/diskspace", StringComparison.Ordinal) ? Task.FromException(new HttpRequestException("down")) : Task.CompletedTask;
        var callers = new TestCallers();
        var member = callers.Register(Guid.NewGuid(), admin: false, "member");
        member.SetPermission(PermissionKind.EnableAllFolders, true);
        var database = new IntegrationCalendarTests.CalendarDatabase();
        async Task<List<ArrItem>> Events()
        {
            var controller = ApiAssetTests.Controller(rig.Arr.Plugin.Core, rig.Arr.Transport, rig.Store, rig.Arr.Factory, database, callers.Users.Object, new Mock<ILibraryManager>().Object, new Mock<IUserDataManager>().Object, rig.Resolver);
            controller.HttpContext.User = TestCallers.Principal(member.Id, admin: false);
            controller.Request.QueryString = new QueryString("?start=2026-10-12&end=2026-10-31");
            var root = JsonSerializer.SerializeToElement(Assert.IsType<OkObjectResult>(await controller.GetCalendarEvents()).Value);
            return JsonSerializer.Deserialize<List<ArrItem>>(root.GetProperty("events"))!;
        }

        Assert.Empty(await Events());
        await rig.Warmed();
        Assert.Null(rig.Store.PeekSystem(rig.Arr.Instance("TV 2").Id));
        using (var bridge = new JellyfinBridge(rig.Store, rig.Library, null, () => config, () => rig.Arr.Now, null))
        {
            rig.Library.Folders.Add("/data/tv");
            var root = Assert.Single(bridge.PathDoctor().Single(d => d.Instance == "TV").Roots);
            Assert.Equal(("roots_unknown", true), (root.Problem, root.HiddenFromMembers));
        }

        // TV 2 answers again: its folders are elsewhere, so TV's path is TV's disk.
        broken = false;
        rig.Arr.Now = rig.Arr.Now.AddMinutes(30);
        Assert.NotNull((await rig.Store.GetSystemAsync(rig.Arr.Instance("TV 2"), default)).Value);
        Assert.Equal(new[] { "Show A" }, Titles(await Events()));
    }

    [Fact]
    public async Task AMembersCalendarNeverWaitsForRootFoldersAndReadsThemOnlyWhenATitleNeedsThem()
    {
        // TV is mapped into the TV library; Movies has no mapping and Jellyfin's "Same path" library
        // is its own root (/data/movies), so its titles need every instance's root folders.
        using var rig = new ResolverRig();
        rig.Library.AddLibrary("Same path", "movies", "/data/movies");
        var tv = rig.Add("sonarr.lan", "Sonarr", "/data/tv");
        rig.Add("radarr.lan", "Radarr", "/data/movies");
        rig.Configure(name => name == "TV" ? new[] { ("/data/tv", "/media/tv") } : Array.Empty<(string, string)>(), null,
            ("TV", ArrKind.Sonarr, "http://sonarr.lan:8989"), ("Movies", ArrKind.Radarr, "http://radarr.lan:7878"));
        var config = rig.Arr.Plugin.Plugin.Configuration;
        config.CalendarPageEnabled = true;
        config.CalendarFilterByLibraryAccess = true;
        tv.Calendar.Add(FakeArr.Episode(42, "2026-10-20T20:00:00Z", "Show A", tvdb: 501));
        var callers = new TestCallers();
        var member = callers.Register(Guid.NewGuid(), admin: false, "member");
        member.SetPermission(PermissionKind.EnableAllFolders, true);
        var admin = callers.Register(Guid.NewGuid(), admin: true, "admin");
        var database = new IntegrationCalendarTests.CalendarDatabase();
        async Task<List<ArrItem>> Events(User caller)
        {
            var controller = ApiAssetTests.Controller(rig.Arr.Plugin.Core, rig.Arr.Transport, rig.Store, rig.Arr.Factory, database, callers.Users.Object, new Mock<ILibraryManager>().Object, new Mock<IUserDataManager>().Object, rig.Resolver);
            controller.HttpContext.User = TestCallers.Principal(caller.Id, admin: caller.Id == admin.Id);
            controller.Request.QueryString = new QueryString("?start=2026-10-12&end=2026-10-31");
            var root = JsonSerializer.SerializeToElement(Assert.IsType<OkObjectResult>(await controller.GetCalendarEvents().WaitAsync(TimeSpan.FromSeconds(5))).Value);
            return JsonSerializer.Deserialize<List<ArrItem>>(root.GetProperty("events"))!;
        }
        long? SystemLastRead(string instance) => rig.Store.Describe().Instances.Single(i => i.Name == instance).Snapshots.FirstOrDefault(x => x.Kind == ArrSnapshotKind.System)?.LastReadSecondsAgo;

        // Only mapped titles in range: no root folder is needed, so a member's calendar starts no
        // system read, cold or stale (10 minutes old), and marks no interest in them.
        await Events(admin);
        var coldCalls = rig.Arr.CallCount();
        Assert.Equal(new[] { "Show A" }, Titles(await Events(member)));
        Assert.Equal(coldCalls, rig.Arr.CallCount());
        Assert.All(rig.Store.Describe().Instances, i => Assert.Equal((false, false), i.Snapshots.Where(x => x.Kind == ArrSnapshotKind.System).Select(x => (x.Loaded, x.Refreshing)).DefaultIfEmpty((false, false)).Single()));
        await rig.Roots();
        rig.Arr.Now = rig.Arr.Now.AddMinutes(10);
        var calls = rig.Arr.CallCount();
        Assert.Equal(new[] { "Show A" }, Titles(await Events(member)));
        Assert.Equal(calls, rig.Arr.CallCount());
        Assert.Equal(600, SystemLastRead("TV"));

        // An unmapped movie of a cold instance (no system snapshot yet; its reads hang): the
        // calendar answers at once without it and starts one background read ...
        using var fresh = new ResolverRig();
        fresh.Library.AddLibrary("Same path", "movies", "/data/movies");
        var tv2 = fresh.Add("sonarr.lan", "Sonarr", "/data/tv");
        var movies2 = fresh.Add("radarr.lan", "Radarr", "/data/movies");
        fresh.Configure(name => name == "TV" ? new[] { ("/data/tv", "/media/tv") } : Array.Empty<(string, string)>(), null,
            ("TV", ArrKind.Sonarr, "http://sonarr.lan:8989"), ("Movies", ArrKind.Radarr, "http://radarr.lan:7878"));
        fresh.Arr.Plugin.Plugin.Configuration.CalendarPageEnabled = true;
        fresh.Arr.Plugin.Plugin.Configuration.CalendarFilterByLibraryAccess = true;
        movies2.Calendar.Add(FakeArr.Movie(7, 438631, "Dune", hasFile: false, digital: "2026-10-21"));
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Task Hold(string path, CancellationToken token) => path.EndsWith("/rootfolder", StringComparison.Ordinal) ? gate.Task.WaitAsync(token) : Task.CompletedTask;
        tv2.Before = Hold;
        movies2.Before = Hold;
        async Task<List<ArrItem>> FreshEvents(User caller)
        {
            var controller = ApiAssetTests.Controller(fresh.Arr.Plugin.Core, fresh.Arr.Transport, fresh.Store, fresh.Arr.Factory, database, callers.Users.Object, new Mock<ILibraryManager>().Object, new Mock<IUserDataManager>().Object, fresh.Resolver);
            controller.HttpContext.User = TestCallers.Principal(caller.Id, admin: caller.Id == admin.Id);
            controller.Request.QueryString = new QueryString("?start=2026-10-12&end=2026-10-31");
            var root = JsonSerializer.SerializeToElement(Assert.IsType<OkObjectResult>(await controller.GetCalendarEvents().WaitAsync(TimeSpan.FromSeconds(5))).Value);
            return JsonSerializer.Deserialize<List<ArrItem>>(root.GetProperty("events"))!;
        }
        Assert.Equal(new[] { "Dune" }, Titles(await FreshEvents(admin)));
        Assert.Empty(await FreshEvents(member));
        Assert.All(fresh.Store.Describe().Instances, i => Assert.Null(i.Snapshots.Single(x => x.Kind == ArrSnapshotKind.System).LastReadSecondsAgo));
        Assert.Empty(await FreshEvents(member));                            // still running: not started twice
        ArrSlotReport[] Systems() => fresh.Store.Describe().Instances.Select(i => i.Snapshots.Single(x => x.Kind == ArrSnapshotKind.System)).ToArray();
        Assert.All(Systems(), x => Assert.True(x.Refreshing));               // started by the calendar itself
        gate.SetResult();
        for (var i = 0; i < 200 && !Systems().All(x => x.Loaded); i++) await Task.Delay(25);
        Assert.All(Systems(), x => Assert.True(x.Loaded));
        var started = fresh.Arr.Calls.Count(c => c.Contains("/rootfolder", StringComparison.Ordinal));
        Assert.Equal(2, started);                                           // one root-folder read per instance
        // ... and the next request places it by the arr's own path.
        Assert.Equal(new[] { "Dune" }, Titles(await FreshEvents(member)));
        Assert.Equal(started, fresh.Arr.Calls.Count(c => c.Contains("/rootfolder", StringComparison.Ordinal)));
    }

    [Theory]
    [InlineData(true)][InlineData(false)]
    public async Task OfTheSameEpisodeFromTwoInstancesTheCopyTheCallerMaySeeIsTheOneShown(bool firstIsVisible)
    {
        using var rig = new CalendarRig();
        rig.Tv.Calendar.Clear();
        rig.Tv2.Calendar.Clear();
        // One episode of Show C from both Sonarrs (one row after merging); only TV's copy lands in a library the member may open.
        (firstIsVisible ? rig.Tv : rig.Tv2).Calendar.Add(FakeArr.Episode(77, "2026-10-20T20:00:00Z", "Show C", tvdb: 503));
        (firstIsVisible ? rig.Tv2 : rig.Tv).Calendar.Add(FakeArr.Episode(42, "2026-10-20T20:00:00Z", "Show C", tvdb: 503));
        var events = await rig.Events(TestCallers.Principal(rig.Member.Id, admin: false));
        var only = Assert.Single(events, e => e.Title == "Show C");
        Assert.Equal("sonarr|" + rig.R.Arr.Instance("TV").Id + "|" + (firstIsVisible ? 77 : 42), only.Id);
        var admin = await rig.Events(TestCallers.Principal(rig.Callers.Register(Guid.NewGuid(), admin: true).Id, admin: true));
        Assert.Single(admin, e => e.Title == "Show C");
    }

    [Fact]
    public async Task RowIdsAreUniquePerInstanceAndSource()
    {
        using var rig = new CalendarRig();
        var events = await rig.Events(TestCallers.Principal(rig.Callers.Register(Guid.NewGuid(), admin: true).Id, admin: true));
        var tv = rig.R.Arr.Instance("TV").Id;
        var tv2 = rig.R.Arr.Instance("TV 2").Id;
        var movies = rig.R.Arr.Instance("Movies").Id;
        Assert.Equal(new[] { "radarr|" + movies + "|7-DigitalRelease", "sonarr|" + tv + "|42", "sonarr|" + tv2 + "|42" }.OrderBy(x => x, StringComparer.Ordinal), events.Select(e => e.Id).OrderBy(x => x, StringComparer.Ordinal));
        Assert.Equal("shoko|42", ArrLegacyViews.RowId(ArrType.Shoko, null, "42"));
        // Server paths and instance ids used for access never leave the server.
        var json = JsonSerializer.Serialize(events);
        Assert.DoesNotContain("/data/", json);
        Assert.DoesNotContain("arrPath", json, StringComparison.OrdinalIgnoreCase);
    }

    // ------------------------------------------------------------------ favourites and watched (C102)

    [Fact]
    public async Task UserDataIsReadOnlyForItemsTheCallerCanOpen()
    {
        using var rig = new CalendarRig();
        var visible = Guid.NewGuid();
        var hidden = Guid.NewGuid();
        var episode = Guid.NewGuid();
        var unknown = Guid.NewGuid();
        // Jellyfin has the first three (whoever asks); the fourth id is unknown to it.
        rig.Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>()))
            .Returns((InternalItemsQuery q) => q.ItemIds.Where(id => id == visible || id == hidden || id == episode).Select(id => (BaseItem)new MediaBrowser.Controller.Entities.Movies.Movie { Id = id }).ToList());
        var visibleItem = new MediaBrowser.Controller.Entities.Movies.Movie { Id = visible };
        var episodeItem = new MediaBrowser.Controller.Entities.TV.Episode { Id = episode };
        rig.Library.Setup(l => l.GetItemById<BaseItem>(visible, It.Is<User>(u => u.Id == rig.Member.Id))).Returns(visibleItem);
        rig.Library.Setup(l => l.GetItemById<BaseItem>(episode, It.Is<User>(u => u.Id == rig.Member.Id))).Returns(episodeItem);
        rig.UserData.Setup(d => d.GetUserData(It.IsAny<User>(), It.IsAny<BaseItem>())).Returns(new UserItemData { Key = "k", Likes = true, Played = true });
        var request = new JellyfinEnhancedController.CalendarUserDataRequest
        {
            Events =
            [
                new() { Id = "radarr|x|1-DigitalRelease", Type = "Movie", ItemId = visible },
                new() { Id = "radarr|x|2-DigitalRelease", Type = "Movie", ItemId = hidden },           // a blocked library or parental limit
                new() { Id = "sonarr|x|3", Type = "Series", ItemId = hidden, ItemEpisodeId = episode },
                new() { Id = "sonarr|x|4", Type = "Series", ItemId = unknown },                        // unknown to Jellyfin
            ],
        };

        var body = JsonSerializer.SerializeToElement(Assert.IsType<OkObjectResult>(rig.Controller(TestCallers.Principal(rig.Member.Id, admin: false)).GetCalendarUserDataForEvents(request)).Value);
        var flags = body.GetProperty("results").EnumerateArray().ToDictionary(r => r.GetProperty("id").GetString()!, r => (r.GetProperty("isFavorite").GetBoolean(), r.GetProperty("isWatched").GetBoolean()));
        Assert.Equal((true, true), flags["radarr|x|1-DigitalRelease"]);
        Assert.Equal((false, false), flags["radarr|x|2-DigitalRelease"]);
        Assert.Equal((false, true), flags["sonarr|x|3"]);       // the episode is theirs, the series isn't
        Assert.Equal((false, false), flags["sonarr|x|4"]);
        rig.UserData.Verify(d => d.GetUserData(It.IsAny<User>(), It.Is<BaseItem>(i => i.Id == hidden)), Times.Never);
        // Existence is one query with no user (it decides nothing); access is Jellyfin's per-user
        // check, asked only for ids Jellyfin has (an unknown one would be a database read each).
        rig.Library.Verify(l => l.GetItemList(It.Is<InternalItemsQuery>(q => q.User == null && q.ItemIds.Length == 4)), Times.Once);
        rig.Library.Verify(l => l.GetItemList(It.Is<InternalItemsQuery>(q => q.User != null)), Times.Never);
        rig.Library.Verify(l => l.GetItemById<BaseItem>(unknown, It.IsAny<User>()), Times.Never);
        rig.Library.Verify(l => l.GetItemById<BaseItem>(hidden, It.IsAny<User>()), Times.Once);

        // More distinct ids than one request may name: refused whole, before any lookup.
        rig.Library.Invocations.Clear();
        var flood = new JellyfinEnhancedController.CalendarUserDataRequest
        {
            Events = Enumerable.Range(0, JellyfinEnhancedController.MaxCalendarUserDataIds / 2 + 1)
                .Select(i => new JellyfinEnhancedController.CalendarEventInfo { Id = "e" + i, Type = "Series", ItemId = Guid.NewGuid(), ItemEpisodeId = Guid.NewGuid() })
                .ToList(),
        };
        var tooMany = Assert.IsType<BadRequestObjectResult>(rig.Controller(TestCallers.Principal(rig.Member.Id, admin: false)).GetCalendarUserDataForEvents(flood));
        Assert.Contains("too_many_ids", JsonSerializer.Serialize(tooMany.Value));
        Assert.Empty(rig.Library.Invocations);
        // At the limit it is answered.
        flood.Events.RemoveAt(flood.Events.Count - 1);
        Assert.IsType<OkObjectResult>(rig.Controller(TestCallers.Principal(rig.Member.Id, admin: false)).GetCalendarUserDataForEvents(flood));

        // An API key has no favourites: refused, nothing read.
        var refused = Assert.IsType<ObjectResult>(rig.Controller(TestCallers.ApiKey()).GetCalendarUserDataForEvents(request));
        Assert.Equal(403, refused.StatusCode);
        Assert.Contains("user_required", JsonSerializer.Serialize(refused.Value));
    }
}
