using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Home;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;

namespace JE.Tests;

/// <summary>
/// Phase 4d home rows: Your requests (own, not ready), Coming soon for you (own requests and follows dated in the next
/// 30 days) and Just arrived for you (first arrived in the last 7 days, upgrades left out), from the same facts as the
/// Requests page, per person, each row off by the person's own preference, nothing at all with the switch off.
/// Against the request-arrivals lab (ledger, fake Sonarr/Radarr and Jellyfin).
/// </summary>
[Collection("Plugin singleton")]
public class HomeRowsTests
{
    private const string Matrix = "movie:tmdb:603";
    private const string Firefly = "tv:tvdb:78874";
    private const string Inception = "movie:tmdb:27205";

    internal sealed class Prefs : IHomePreferences
    {
        public Dictionary<Guid, HomePreferences> By { get; } = new();

        public HomePreferences For(Guid user) => By.GetValueOrDefault(user);
    }

    internal sealed class Library : IHomeLibrary
    {
        public Dictionary<Guid, HomeItem> Items { get; } = new();

        public HomeItem? Item(Guid id) => Items.GetValueOrDefault(id);
    }

    /// <summary>A projection over a lab's hub (also used by the route matrix).</summary>
    internal static HomeProjection Projection(RequestsHubService hub, NotifyStore? notify, AcquireDatabase db, Func<PluginConfiguration?> config, Prefs? prefs = null, Library? library = null,
        Dictionary<string, FollowDate>? dates = null, HomeArrivals? arrivals = null)
        => new(hub, notify, arrivals ?? new HomeArrivals(db, null, null, () => true), prefs ?? new Prefs(), library ?? new Library(), config,
            (keys, ct) => Task.FromResult(dates ?? new Dictionary<string, FollowDate>()),
            (keys, viewer, ct) => Task.FromResult(keys.ToDictionary(k => k, k => new HubTitleMeta { Title = k == Inception ? "Inception" : k })),
            (tmdb, kind) => "syn-" + kind + "-" + tmdb);

    private sealed class Home : IDisposable
    {
        public IntegrationRequestArrivalsTests.Lab Lab { get; } = new(fourK: true);
        public Prefs Prefs { get; } = new();
        public Library Library { get; } = new();
        public NotifyStore Notify { get; }
        public HomeArrivals Arrivals { get; }
        public Dictionary<string, FollowDate> Dates { get; } = new();
        public HomeProjection Projection { get; }

        public Home()
        {
            Lab.Policy.Adjust = (_, _, person) => person with { Can4k = true };
            var c = Lab.Config;
            c.ArrPhase4Enabled = true;
            c.ArrPhase4HomeRowsEnabled = true;
            c.ArrPhase2Enabled = true;
            c.ArrNotificationsEnabled = true;
            Notify = new NotifyStore(Lab.Db);
            Arrivals = new HomeArrivals(Lab.Db, null, null, () => true);
            Projection = HomeRowsTests.Projection(Lab.Hub, Notify, Lab.Db, () => Lab.Config, Prefs, Library, Dates, Arrivals);
        }

        public DateTime Now => Lab.Arr.Now.UtcDateTime;

        public async Task<HomeAnswer> Rows(StatusViewer viewer)
        {
            var body = await Projection.ForViewerAsync(viewer, hss: false, default);
            Assert.NotNull(body);
            return HomeProjection.Read(body!)!;
        }

        /// <summary>A movie copy in Jellyfin (and in the library seam, with its content key).</summary>
        public Guid MovieCopy(string key, DateTime created, bool fourK = false)
        {
            var id = Guid.NewGuid();
            Lab.View.AddCopy(TitleKey.Parse(key)!, new JfCopy { ItemId = id, Path = fourK ? "/media/movies4k/The Matrix (1999)/The Matrix.mkv" : "/media/movies/" + id.ToString("N"), LibraryName = fourK ? "Movies 4K" : "Movies", DateCreated = created });
            // A 4K copy is one with a playable 4K source (D44, the edition core), as the Requests page judges it.
            if (fourK) Lab.View.AddSource(id, 3840, 2160, created: created);
            Library.Items[id] = new HomeItem(new[] { HomeArrivals.MovieContent(TitleKey.Parse(key)!, fourK) }, created, fourK, "Movie", null);
            Lab.View.Rev++;
            return id;
        }

        /// <summary>An episode of Firefly in Jellyfin.</summary>
        public Guid FireflyEpisode(int season, int episode, DateTime created, string? name = null)
        {
            var id = Guid.NewGuid();
            Lab.View.AddEpisode(Lab.SeriesItem, new JfEpisode { ItemId = id, Season = season, Episode = episode, DateCreated = created });
            Library.Items[id] = new HomeItem(new[] { HomeArrivals.EpisodeContent(TitleKey.Parse(Firefly)!, season, episode) }, created, false, name, null);
            Lab.View.Rev++;
            return id;
        }

        public void Dispose() => Lab.Dispose();
    }

    private static List<string> Keys(List<HomeCard>? row) => row!.Select(c => c.Key).ToList();

    [Theory]
    [InlineData("list")]
    [InlineData("import")]
    [InlineData("sync")]
    [InlineData("automation")]
    public async Task ExplicitWantsOfEveryOriginArePersonalHomeInterests(string origin)
    {
        using var home = new Home();
        await home.Lab.Warm();
        // List membership alone has created no want or follow.
        Assert.Empty((await home.Rows(home.Lab.Emma)).Requests!);
        var p = new RequestProvenance(ListId: "owned-list", EntryId: "entry", ListRevision: 1, OperationId: "op");
        var source = origin switch
        {
            "list" => RequestOrigin.List("owned-list", p),
            "import" => RequestOrigin.Import("owned-list", p),
            "sync" => RequestOrigin.Sync("owned-list", p),
            _ => RequestOrigin.Automation("list_acquire_ahead"),
        };
        var result = home.Lab.Ledger.Create(home.Lab.Emma.UserId, new CreateRequest(Guid.NewGuid().ToString("N"), new MutationInput { Key = Matrix }), home.Lab.Policy, home.Lab.Arr.Now, source);
        Assert.True(result.HttpStatus < 300, result.Reason);
        Assert.Equal(new[] { Matrix }, Keys((await home.Rows(home.Lab.Emma)).Requests));
        Assert.Empty((await home.Rows(home.Lab.Kid)).Requests!);
    }

    [Theory]
    [InlineData(-1, true)]
    [InlineData(0, true)]
    [InlineData(1, false)]
    public async Task JustArrivedHasAnExactSevenDayBoundary(int milliseconds, bool included)
    {
        using var home = new Home();
        await home.Lab.Warm();
        await home.Lab.Ask(home.Lab.Emma, new MutationInput { Key = Matrix });
        await home.Lab.Outbox.TickAsync(default);
        home.Lab.Radarr.Queue.Clear();
        home.MovieCopy(Matrix, home.Now.AddDays(-7).AddMilliseconds(-milliseconds));
        await home.Lab.Warm();
        Assert.Equal(included ? 1 : 0, (await home.Rows(home.Lab.Emma)).Arrived!.Count);
    }

    [Theory]
    [InlineData(-1, true)]
    [InlineData(0, true)]
    [InlineData(1, false)]
    public async Task ComingSoonHasAnExactThirtyDayBoundary(int milliseconds, bool included)
    {
        using var home = new Home();
        await home.Lab.Warm();
        var e = home.Lab.Sonarr.Episodes.Single(e => (int)e["seasonNumber"]! == 1 && (int)e["episodeNumber"]! == 4);
        e["airDateUtc"] = home.Now.AddDays(30).AddMilliseconds(milliseconds).ToString("O");
        await home.Lab.Store.RefreshLibraryNowAsync(home.Lab.Arr.Instance("SonarrZ"), default);
        await home.Lab.Ask(home.Lab.Emma, new MutationInput { Key = Firefly, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 4) } });
        await home.Lab.Outbox.TickAsync(default);
        Assert.Equal(included ? 1 : 0, (await home.Rows(home.Lab.Emma)).Soon!.Count);
    }

    [Fact]
    public async Task AFourKSeriesRequestNeverAdvertisesAnHdEpisodeAsJustArrived()
    {
        using var home = new Home();
        await home.Lab.Warm();
        await home.Lab.Ask(home.Lab.Emma, new MutationInput { Key = Firefly, Variant = "4k", Scope = "seasons", Seasons = new[] { 1 } });
        await home.Lab.Outbox.TickAsync(default);
        home.FireflyEpisode(1, 2, home.Now.AddHours(-1));
        await home.Lab.Warm();
        Assert.Empty((await home.Rows(home.Lab.Emma)).Arrived!);
    }

    [Fact]
    public async Task ATitleAskedForInBothEditionsKeepsBothRequestCardsBesideAFollow()
    {
        // Integration (4b per-edition composition with 4d home rows): the Requests page composes a title asked for in both
        // editions once per edition; home rows used to map composed titles by title and threw on the second one.
        using var home = new Home();
        await home.Lab.Warm();
        await home.Lab.Ask(home.Lab.Emma, new MutationInput { Key = Matrix });
        await home.Lab.Ask(home.Lab.Emma, new MutationInput { Key = Matrix, Variant = "4k" });
        await home.Lab.Outbox.TickAsync(default);
        Assert.True(home.Notify.SetFollow(home.Lab.Emma.UserId, Inception, "title", false, false, home.Lab.Arr.Now));
        home.Dates[Inception] = new FollowDate(home.Now.Date.AddDays(10), null, null);
        await home.Lab.Warm();
        var rows = await home.Rows(home.Lab.Emma);
        Assert.Equal(2, rows.Requests!.Count(c => c.Key == Matrix));
        // The followed title, composed beside the requested editions without a request of its own, still gets its card.
        Assert.Contains(rows.Soon!, c => c.Key == Inception && c.Follow);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AFourKOnlyFirstArrivalOfATitleAskedForInBothEditionsIsJustArrivedForTheFourKAsk(bool standardNeedsNonFourK)
    {
        // Integration review RBS1-BEH-R1-1: "Just arrived" looked the requested arrival up by title only, so with both
        // editions asked for it judged the 4K ask by the standard edition's result (no non-4K source: no copy to open).
        using var home = new Home();
        home.Lab.Config.ArrStandardNeedsNonFourK = standardNeedsNonFourK;
        await home.Lab.Warm();
        await home.Lab.Ask(home.Lab.Emma, new MutationInput { Key = Matrix });
        await home.Lab.Ask(home.Lab.Emma, new MutationInput { Key = Matrix, Variant = "4k" });
        await home.Lab.Outbox.TickAsync(default);
        home.Lab.Radarr.Queue.Clear();
        home.Lab.Arr.Now = home.Lab.Arr.Now.AddHours(1);
        // The first copy of the title is a new 4K one.
        home.MovieCopy(Matrix, home.Now.AddMinutes(-30), fourK: true);
        await home.Lab.Warm();
        var arrived = (await home.Rows(home.Lab.Emma)).Arrived!;
        Assert.Contains(arrived, c => c.Key == Matrix && c.Is4k);
        // The standard ask: any copy unless the administrator wants a non-4K one (content arrival is edition-independent,
        // fulfilment follows the switch; Q-REBUILD1-2).
        Assert.Equal(!standardNeedsNonFourK, arrived.Any(c => c.Key == Matrix && !c.Is4k));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AFourKMovieUpgradeFulfilsTheRequestButIsNeverNewContent(bool grouped)
    {
        using var home = new Home();
        await home.Lab.Warm();
        var want = await home.Lab.Ask(home.Lab.Emma, new MutationInput { Key = Matrix, Variant = "4k" });
        await home.Lab.Outbox.TickAsync(default);
        home.Lab.Radarr.Queue.Clear();
        home.Arrivals.Record(new[] { (HomeArrivals.MovieContent(TitleKey.Parse(Matrix)!, false), home.Now.AddDays(-2)) });
        // A grouped primary may keep its original HD creation date when a 4K source is added.
        home.MovieCopy(Matrix, grouped ? home.Now.AddDays(-2) : home.Now.AddHours(-1), fourK: true);
        Assert.True(home.Lab.Ledger.Fulfil(want, home.Lab.Arr.Now));
        await home.Lab.Warm();
        Assert.Equal("ready", (await home.Lab.Page(home.Lab.Emma))[Matrix].GetProperty("group").GetString());
        Assert.Empty((await home.Rows(home.Lab.Emma)).Arrived!);
    }

    public static IEnumerable<object[]> ResponseWaits()
    {
        foreach (var wait in new[] { "follow-meta", "follow-dates", "request-meta", "library", "queue", "history", "episodes", "cache" })
            foreach (var change in new[] { "parental", "opt-out", "unfollow", "disabled", "deleted" })
                yield return new object[] { wait, change };
    }

    [Theory]
    [MemberData(nameof(ResponseWaits))]
    public async Task EveryHomeWaitEndsWithCurrentPolicyPreferencesAndFollows(string wait, string change)
    {
        using var home = new Home();
        var lab = home.Lab;
        home.Notify.SetFollow(lab.Emma.UserId, Inception, "title", false, false, lab.Arr.Now);
        await lab.Ask(lab.Emma, new MutationInput { Key = Firefly, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 4) } });
        var changed = false;
        async Task ChangeAt(string point)
        {
            await Task.Yield(); // An actual suspension at each dependency, including a warm-cache answer.
            if (changed || point != wait) return;
            changed = true;
            if (change == "parental") lab.View.Users[lab.Emma.UserId] = new StatusViewer { UserId = lab.Emma.UserId, HasParentalLimit = true, PolicyRevision = "restricted" };
            if (change == "opt-out") home.Prefs.By[lab.Emma.UserId] = new HomePreferences(false, false, false, false);
            if (change == "unfollow") home.Notify.SetFollow(lab.Emma.UserId, Inception, "title", true, false, lab.Arr.Now);
            if (change == "disabled") lab.Config.ArrPhase4HomeRowsEnabled = false;
            if (change == "deleted") lab.View.Users.Remove(lab.Emma.UserId);
        }
        var hub = new RequestsHubService(lab.Status, lab.Model, () => lab.Config, lab.Ledger, async (keys, viewer, ct) =>
        {
            await ChangeAt("request-meta");
            return keys.ToDictionary(k => k, k => new HubTitleMeta { Title = k });
        });
        var projection = new HomeProjection(hub, home.Notify, home.Arrivals, home.Prefs, home.Library, () => lab.Config,
            async (keys, ct) => { await ChangeAt("follow-dates"); await ChangeAt("cache"); return new() { [Inception] = new FollowDate(home.Now.AddDays(1), null, null) }; },
            async (keys, viewer, ct) => { await ChangeAt("follow-meta"); return keys.ToDictionary(k => k, k => new HubTitleMeta { Title = "Inception" }); },
            (id, kind) => "syn-" + id);
        if (wait == "cache")
        {
            // Prime the exact body, then change policy in the date read preceding its cache lookup.
            changed = true;
            Assert.NotNull(await projection.ForViewerAsync(lab.Emma, false, default));
            changed = false;
        }
        foreach (var host in lab.Arr.Hosts.Values) host.Before = async (path, ct) =>
        {
            if (path.EndsWith("/movie", StringComparison.Ordinal) || path.EndsWith("/series", StringComparison.Ordinal)) await ChangeAt("library");
            if (path.EndsWith("/queue", StringComparison.Ordinal)) await ChangeAt("queue");
            if (path.EndsWith("/history", StringComparison.Ordinal)) await ChangeAt("history");
            if (path.EndsWith("/episode", StringComparison.Ordinal)) await ChangeAt("episodes");
        };
        var body = await projection.ForViewerAsync(lab.Emma, false, default);
        Assert.True(changed, "Dependency was not exercised: " + wait);
        if (change is "disabled" or "deleted") { Assert.Null(body); return; }
        Assert.NotNull(body);
        var rows = HomeProjection.Read(body!)!;
        if (change == "opt-out") Assert.Null(rows.Soon);
        else Assert.DoesNotContain(rows.Soon ?? new(), c => c.Key == Inception);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task HomeProjectionKeepsTheAuthoritativeFirstSourceArrival(bool episode, bool fourK)
    {
        using var home = new Home();
        await home.Lab.Warm();
        var key = episode ? Firefly : Matrix;
        if (episode && fourK)
        {
            var instances = JsonNode.Parse(home.Lab.Config.SonarrInstances)!.AsArray();
            foreach (var instance in instances) instance!["Role"] = "4k";
            home.Lab.Config.SonarrInstances = instances.ToJsonString();
        }
        var want = await home.Lab.Ask(home.Lab.Emma, new MutationInput { Key = key, Variant = fourK ? "4k" : "standard",
            Scope = episode ? "episodes" : "movie", Episodes = episode ? new[] { new RequestEpisode(1, 2) } : Array.Empty<RequestEpisode>() });
        await home.Lab.Outbox.TickAsync(default);
        home.Lab.Arr.Now = home.Lab.Arr.Now.AddHours(1);
        var observed = home.Now.AddMinutes(-1);
        var created = observed.AddSeconds(-2);
        var id = episode ? home.FireflyEpisode(1, 2, created) : home.MovieCopy(Matrix, created, fourK);
        var source = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Stamps.StampSource("first", "/first.mkv", fourK ? 3840 : 1920, fourK ? 2160 : 1080, created);
        home.Library.Items[id] = home.Library.Items[id] with { FourK = fourK, Sources = new[] { source } };
        // The edition core judges a 4K episode by its playable 4K source too (D44).
        if (episode && fourK) home.Lab.View.AddSource(id, source.Width, source.Height, created: created);
        if (episode) home.Library.Items[home.Lab.SeriesItem] = new HomeItem(Array.Empty<string>(), created, false, "Firefly", TitleKey.Parse(Firefly));
        var store = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Stamps.AcquisitionStampStore(home.Lab.Db, () => DateTimeOffset.UtcNow);
        var item = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Stamps.StampItem { Id = id, Kind = episode ? "episode" : "movie",
            Keys = new[] { TitleKey.Parse(key)! }, Season = episode ? 1 : null, Episode = episode ? 2 : null,
            Width = source.Width, Height = source.Height, DateCreated = created, Sources = new[] { source } };
        store.ObserveSources(new[] { item }, observed, home.Lab.Db.Generation);
        // The feeder may already have published the first-content fact, or home may be first to consume the observation.
        if (fourK) store.NoteArrival(Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Stamps.AcquisitionStampStore.PartKeys(item), observed, id);
        Assert.True(home.Lab.Ledger.Fulfil(want, home.Lab.Arr.Now));
        await home.Lab.Warm();
        var arrived = (await home.Rows(home.Lab.Emma)).Arrived!;
        Assert.Contains(arrived, c => c.Key == key);
        Assert.Equal(observed, home.Arrivals.FirstAt(episode ? Firefly + ":s1:e2" : Matrix));
        Assert.Equal(observed, store.FirstContentArrival(Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Stamps.AcquisitionStampStore.PartKeys(item)));
    }

    [Fact]
    public async Task AGroupedFourKSourceIsAnUpgradeEvenWhenItsRequestPredatesTheHdArrival()
    {
        using var home = new Home();
        await home.Lab.Warm();
        var want = await home.Lab.Ask(home.Lab.Emma, new MutationInput { Key = Matrix, Variant = "4k" });
        await home.Lab.Outbox.TickAsync(default);
        home.Lab.Arr.Now = home.Lab.Arr.Now.AddDays(2);
        var hdAt = home.Now.AddDays(-1);
        home.Arrivals.Record(new[] { (HomeArrivals.MovieContent(TitleKey.Parse(Matrix)!, false), hdAt) });
        var id = home.MovieCopy(Matrix, hdAt, fourK: true);
        // The source fact was recorded by 4e after Updated; the primary inherited the old title date.
        var store = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Stamps.AcquisitionStampStore(home.Lab.Db, () => DateTimeOffset.UtcNow);
        store.NoteArrival(new[] { "m|" + Matrix + "|4k" }, home.Now.AddHours(-1), id);
        Assert.True(home.Lab.Ledger.Fulfil(want, home.Lab.Arr.Now));
        await home.Lab.Warm();
        Assert.Empty((await home.Rows(home.Lab.Emma)).Arrived!);
        Assert.Equal(hdAt, store.FirstArrival(new[] { "m|" + Matrix + "|4k" }));
    }

    [Fact]
    public async Task NothingAtAllWithTheSwitchOrAParentOff()
    {
        using var home = new Home();
        await home.Lab.Warm();
        Assert.NotNull(await home.Projection.ForViewerAsync(home.Lab.Emma, false, default));
        foreach (var off in new Action<PluginConfiguration>[] { c => c.ArrPhase4HomeRowsEnabled = false, c => c.ArrPhase4Enabled = false, c => c.ArrPhase3Enabled = false, c => c.ArrPhase1Enabled = false, c => c.ArrIntegrationEnabled = false })
        {
            using var lab = new Home();
            off(lab.Lab.Config);
            Assert.Null(await lab.Projection.ForViewerAsync(lab.Lab.Emma, false, default));
        }
    }

    [Fact]
    public void TheEffectiveSwitchesNeedEveryParent()
    {
        var c = new PluginConfiguration { ArrIntegrationEnabled = true, ArrPhase1Enabled = true, ArrPhase3Enabled = true, ArrPhase4Enabled = true, ArrPhase4HomeRowsEnabled = true };
        Assert.True(HomeFlags.Rows(c));
        Assert.False(HomeFlags.OpsStrip(c));                 // its own switch
        c.ArrPhase4HomeOpsStripEnabled = true;
        Assert.False(HomeFlags.OpsStrip(c));                 // and phase 2
        c.ArrPhase2Enabled = true;
        Assert.True(HomeFlags.OpsStrip(c));
        c.ArrPhase4HssSectionsEnabled = true;
        Assert.False(HomeFlags.HssSections(c));              // titles not in the library need the native pages
        c.NativeAbsentDetailsEnabled = true;
        Assert.False(HomeFlags.HssSections(c)); // native pages also need their configured metadata source
        c.JellyseerrEnabled = true;
        c.JellyseerrUrls = "http://seerr.test";
        c.JellyseerrApiKey = "lab-key";
#if NET9_0
        Assert.False(HomeFlags.HssSections(c));              // Jellyfin 10.11 has no native pages for them
#else
        Assert.True(HomeFlags.HssSections(c));
#endif
        Assert.False(HomeFlags.CollectionGaps(c));
        c.ArrPhase4CollectionGapsEnabled = true;
        Assert.True(HomeFlags.CollectionGaps(c));
        c.ArrPhase4HomeRowsEnabled = false;
        Assert.False(HomeFlags.Rows(c) || HomeFlags.HssSections(c) || HomeFlags.OpsStrip(c));
        Assert.True(HomeFlags.CollectionGaps(c));           // not a child of the rows
        c.ArrPhase3Enabled = false;
        Assert.False(HomeFlags.CollectionGaps(c));
        var fresh = new PluginConfiguration();
        Assert.False(fresh.ArrPhase4HomeRowsEnabled || fresh.ArrPhase4HssSectionsEnabled || fresh.ArrPhase4HomeOpsStripEnabled || fresh.ArrPhase4CollectionGapsEnabled);
    }

    [Fact]
    public async Task YourRequestsHoldsOnlyThePersonsOwnOpenAsksAndAManagerSeesNobodyElses()
    {
        using var home = new Home();
        await home.Lab.Warm();
        await home.Lab.Ask(home.Lab.Emma, new MutationInput { Key = Matrix });
        await home.Lab.Outbox.TickAsync(default);
        await home.Lab.Ask(home.Lab.Kid, new MutationInput { Key = Firefly, Scope = "seasons", Seasons = new[] { 2 } });

        var emma = await home.Rows(home.Lab.Emma);
        Assert.Equal(new[] { Matrix }, Keys(emma.Requests));
        Assert.Equal(StatusStage.Downloading, emma.Requests![0].Status!.Stage);
        Assert.Equal("syn-Movie-603", emma.Requests[0].HssId);          // not in the library: the title's native page id
        var kid = await home.Rows(home.Lab.Kid);
        Assert.Equal(new[] { Firefly }, Keys(kid.Requests));
        Assert.Equal(StatusStage.Asked, kid.Requests![0].Status!.Stage);
        // The administrator (who approves both) has asked for nothing: their own row is empty.
        Assert.Empty((await home.Rows(home.Lab.Admin)).Requests!);
        Assert.False((await home.Rows(home.Lab.Admin)).Ops);              // strip switch off
    }

    [Fact]
    public async Task JustArrivedHoldsWhatFirstArrivedInTheLastSevenDaysThenLetsItGo()
    {
        using var home = new Home();
        await home.Lab.Warm();
        await home.Lab.Ask(home.Lab.Emma, new MutationInput { Key = Matrix });
        await home.Lab.Outbox.TickAsync(default);
        home.Lab.Radarr.Queue.Clear();
        var item = home.MovieCopy(Matrix, home.Now.AddDays(-2));
        await home.Lab.Warm();

        var rows = await home.Rows(home.Lab.Emma);
        Assert.Empty(rows.Requests!);                                         // ready: no longer "on its way"
        var card = Assert.Single(rows.Arrived!);
        Assert.Equal((Matrix, item.ToString("N"), item.ToString("N")), (card.Key, card.ItemId, card.HssId));
        Assert.Equal(home.Now.AddDays(-2), card.Date);
        Assert.Empty((await home.Rows(home.Lab.Kid)).Arrived!);               // someone else's arrival

        home.Lab.Arr.Now += TimeSpan.FromDays(4);                            // 6 days after it arrived
        await home.Lab.Warm();
        Assert.Single((await home.Rows(home.Lab.Emma)).Arrived!);
        home.Lab.Arr.Now += TimeSpan.FromDays(1.5);                          // 7.5 days
        await home.Lab.Warm();
        Assert.Empty((await home.Rows(home.Lab.Emma)).Arrived!);
    }

    [Fact]
    public async Task AnUpgradeIsNotAnArrivalTheFirstDateStaysWhileTheRequestsPageShowsTheNewCopy()
    {
        using var home = new Home();
        await home.Lab.Warm();
        await home.Lab.Ask(home.Lab.Emma, new MutationInput { Key = Matrix });
        await home.Lab.Outbox.TickAsync(default);
        home.Lab.Radarr.Queue.Clear();
        home.MovieCopy(Matrix, home.Now.AddDays(-10));
        await home.Lab.Warm();
        Assert.Empty((await home.Rows(home.Lab.Emma)).Arrived!);             // ten days ago: recorded, not new

        // Replaced by a better file: Jellyfin makes a new item with a new date (the old one goes).
        home.Lab.View.CopiesByKey.Remove(Matrix);
        var upgraded = home.MovieCopy(Matrix, home.Now.AddHours(-1));
        await home.Lab.Warm();
        Assert.Empty((await home.Rows(home.Lab.Emma)).Arrived!);
        Assert.Equal(home.Now.AddDays(-10), home.Arrivals.FirstAt(HomeArrivals.MovieContent(TitleKey.Parse(Matrix)!, false)));
        // The Requests page (14 days, by the copy) still shows it as Ready with the new copy: a different question.
        var page = await home.Lab.Page(home.Lab.Emma);
        Assert.Equal((HubGroup.Ready, upgraded.ToString("N")), (page[Matrix].GetProperty("group").GetString(), page[Matrix].GetProperty("itemId").GetString()));

        // A later 4K copy fulfils that edition but is not another content arrival.
        home.MovieCopy(Matrix, home.Now.AddHours(-1), fourK: true);
        await home.Lab.Warm();
        Assert.Empty((await home.Rows(home.Lab.Emma)).Arrived!);
    }

    [Fact]
    public async Task AnUpgradeTo4kInTheSameRadarrIsNotAnArrivalForAFollow()
    {
        using var home = new Home();
        await home.Lab.Warm();
        // Emma follows The Matrix (no request: no ledger evidence); its 1080p file came 10 days ago.
        Assert.True(home.Notify.SetFollow(home.Lab.Emma.UserId, Matrix, "title", false, false, home.Lab.Arr.Now));
        home.Lab.Radarr.Queue.Clear();
        home.MovieCopy(Matrix, home.Now.AddDays(-10));
        await home.Lab.Warm();
        Assert.Empty((await home.Rows(home.Lab.Emma)).Arrived!);
        // Radarr upgrades it to a 2160p file: the standard copy goes, a 4K copy comes.
        home.Lab.View.CopiesByKey.Remove(Matrix);
        home.MovieCopy(Matrix, home.Now.AddHours(-1), fourK: true);
        await home.Lab.Warm();
        Assert.Empty((await home.Rows(home.Lab.Emma)).Arrived!);
        Assert.Equal(HomeArrivals.MovieContent(TitleKey.Parse(Matrix)!, true), HomeArrivals.OtherEdition(HomeArrivals.MovieContent(TitleKey.Parse(Matrix)!, false)));
        Assert.Null(HomeArrivals.OtherEdition(HomeArrivals.EpisodeContent(TitleKey.Parse(Firefly)!, 1, 1)));
    }

    [Fact]
    public async Task TheLedgersFulfilmentKeepsAnOldArrivalOldEvenWithoutARecordedDate()
    {
        using var home = new Home();
        await home.Lab.Warm();
        var movie = await home.Lab.Ask(home.Lab.Emma, new MutationInput { Key = Matrix });
        await home.Lab.Outbox.TickAsync(default);
        Assert.True(home.Lab.Ledger.Fulfil(movie, home.Lab.Arr.Now.AddDays(-9)));
        home.Lab.Radarr.Queue.Clear();
        // A copy Jellyfin knows only by its (new) creation date; the library seam can't name it.
        home.Lab.View.AddCopy(TitleKey.Parse(Matrix)!, new JfCopy { ItemId = Guid.NewGuid(), Path = "/media/movies/m", LibraryName = "Movies", DateCreated = home.Now.AddHours(-2) });
        home.Lab.View.Rev++;
        await home.Lab.Warm();
        Assert.Empty((await home.Rows(home.Lab.Emma)).Arrived!);
    }

    [Fact]
    public async Task ASeriesShowsItsNewestNewEpisodeOfThePartAskedForAndAnEpisodeUpgradeDoesntCount()
    {
        using var home = new Home();
        home.Library.Items[home.Lab.SeriesItem] = new HomeItem(Array.Empty<string>(), home.Now.AddDays(-300), false, "Firefly", TitleKey.Parse(Firefly));
        await home.Lab.Warm();
        await home.Lab.Ask(home.Lab.Emma, new MutationInput { Key = Firefly, Scope = "seasons", Seasons = new[] { 1 } });
        await home.Lab.Outbox.TickAsync(default);
        var e2 = home.FireflyEpisode(1, 2, home.Now.AddDays(-1), "The Train Job");
        await home.Lab.Warm();
        var card = Assert.Single((await home.Rows(home.Lab.Emma)).Arrived!);
        Assert.Equal((Firefly, 1, 2, "The Train Job", e2.ToString("N")), (card.Key, card.Season, card.Episode, card.EpisodeTitle, card.ItemId));
        Assert.Equal(home.Lab.SeriesItem.ToString("N"), card.PosterItemId);     // the series' poster, never the episode's still

        var e3 = home.FireflyEpisode(1, 3, home.Now.AddHours(-3), "Bushwhacked");
        await home.Lab.Warm();
        card = Assert.Single((await home.Rows(home.Lab.Emma)).Arrived!);
        Assert.Equal((3, e3.ToString("N")), (card.Episode, card.ItemId));

        // E1 (here 300 days) replaced by a new file now: not the newest new episode.
        home.FireflyEpisode(1, 1, home.Now.AddDays(-300));
        await home.Lab.Warm();
        await home.Rows(home.Lab.Emma);                                      // recorded at its first date
        home.Lab.View.EpisodesBySeries[home.Lab.SeriesItem].RemoveAll(e => e.Episode.Season == 1 && e.Episode.Episode == 1);
        home.FireflyEpisode(1, 1, home.Now.AddMinutes(-5));
        await home.Lab.Warm();
        Assert.Equal(3, Assert.Single((await home.Rows(home.Lab.Emma)).Arrived!).Episode);
        // Outside the part asked for (season 2) never counts for a season ask.
        home.FireflyEpisode(2, 1, home.Now.AddMinutes(-1));
        await home.Lab.Warm();
        Assert.Equal(3, Assert.Single((await home.Rows(home.Lab.Emma)).Arrived!).Episode);
    }

    [Fact]
    public async Task ComingSoonHoldsOwnAsksAndFollowsDatedInTheNextThirtyDays()
    {
        using var home = new Home();
        await home.Lab.Warm();
        // Firefly S1E3 airs in 5 days (not here, monitored).
        var e3 = home.Lab.Sonarr.Episodes.Single(e => (int)e["seasonNumber"]! == 1 && (int)e["episodeNumber"]! == 3);
        e3["airDateUtc"] = home.Lab.Arr.Now.AddDays(5).UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ssZ");
        foreach (var e in home.Lab.Sonarr.Episodes.Where(e => (int)e["seasonNumber"]! == 1 && (int)e["episodeNumber"]! == 4)) e["airDateUtc"] = home.Lab.Arr.Now.AddDays(12).UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ssZ");
        await home.Lab.Store.RefreshLibraryNowAsync(home.Lab.Arr.Instance("SonarrZ"), default);
        await home.Lab.Ask(home.Lab.Emma, new MutationInput { Key = Firefly, Scope = "seasons", Seasons = new[] { 1 } });
        await home.Lab.Outbox.TickAsync(default);
        // Emma follows Inception (no arr has it; TMDB: on digital in 10 days) and a title dated too far away.
        Assert.True(home.Notify.SetFollow(home.Lab.Emma.UserId, Inception, "title", false, false, home.Lab.Arr.Now));
        Assert.True(home.Notify.SetFollow(home.Lab.Emma.UserId, "movie:tmdb:11", "title", false, false, home.Lab.Arr.Now));
        home.Dates[Inception] = new FollowDate(home.Now.Date.AddDays(10), null, null);
        home.Dates["movie:tmdb:11"] = new FollowDate(home.Now.Date.AddDays(31), null, null);
        await home.Lab.Warm();

        var soon = (await home.Rows(home.Lab.Emma)).Soon!;
        Assert.Equal(new[] { Firefly, Inception }, Keys(soon));
        Assert.Equal((1, 3, false), (soon[0].Season, soon[0].Episode, soon[0].Follow));
        Assert.Equal((home.Now.Date.AddDays(10), "Inception", true), (soon[1].Date!.Value, soon[1].Title, soon[1].Follow));
        Assert.Empty((await home.Rows(home.Lab.Kid)).Soon!);                   // nobody else's follows

        // Muted (not interested) and notifications off: no follow cards.
        Assert.True(home.Notify.SetFollow(home.Lab.Emma.UserId, Inception, "title", true, false, home.Lab.Arr.Now));
        Assert.Equal(new[] { Firefly }, Keys((await home.Rows(home.Lab.Emma)).Soon));
        Assert.True(home.Notify.SetFollow(home.Lab.Emma.UserId, Inception, "title", false, false, home.Lab.Arr.Now));
        home.Lab.Config.ArrNotificationsEnabled = false;
        Assert.Equal(new[] { Firefly }, Keys((await home.Rows(home.Lab.Emma)).Soon));
    }

    [Fact]
    public async Task EachRowIsOffByThePersonsOwnPreferenceAndNullFollowsTheAdministrator()
    {
        using var home = new Home();
        await home.Lab.Warm();
        var rows = await home.Rows(home.Lab.Emma);
        Assert.NotNull(rows.Requests);
        Assert.NotNull(rows.Soon);
        Assert.NotNull(rows.Arrived);
        home.Prefs.By[home.Lab.Emma.UserId] = new HomePreferences(null, false, null, null);
        rows = await home.Rows(home.Lab.Emma);
        Assert.NotNull(rows.Requests);
        Assert.Null(rows.Soon);
        Assert.NotNull(rows.Arrived);
        home.Prefs.By[home.Lab.Emma.UserId] = new HomePreferences(false, false, false, false);
        rows = await home.Rows(home.Lab.Emma);
        Assert.True(rows.Requests == null && rows.Soon == null && rows.Arrived == null);
        var offBody = await home.Projection.ForViewerAsync(home.Lab.Emma, false, default);
        using var offJson = JsonDocument.Parse(offBody!.Json);
        Assert.Equal(JsonValueKind.Null, offJson.RootElement.GetProperty("requests").ValueKind);
        Assert.Equal(JsonValueKind.Null, offJson.RootElement.GetProperty("soon").ValueKind);
        Assert.Equal(JsonValueKind.Null, offJson.RootElement.GetProperty("arrived").ValueKind);
        Assert.NotNull((await home.Rows(home.Lab.Kid)).Soon);                 // another person's choice is theirs
        // The strip: administrators only, the switch on and phase 2, unless the person hid it.
        home.Lab.Config.ArrPhase4HomeOpsStripEnabled = true;
        Assert.True((await home.Rows(home.Lab.Admin)).Ops);
        Assert.False((await home.Rows(home.Lab.Kid)).Ops);
        home.Prefs.By[home.Lab.Admin.UserId] = new HomePreferences(null, null, null, false);
        Assert.False((await home.Rows(home.Lab.Admin)).Ops);
    }

    [Fact]
    public async Task TheRowsBodyIsCachedPerPersonAndChangesWithTheirFacts()
    {
        using var home = new Home();
        await home.Lab.Warm();
        var a = await home.Projection.ForViewerAsync(home.Lab.Emma, false, default);
        var b = await home.Projection.ForViewerAsync(home.Lab.Emma, false, default);
        Assert.Equal(a!.ETag, b!.ETag);
        var kid = await home.Projection.ForViewerAsync(home.Lab.Kid, false, default);
        Assert.NotEqual(a.ETag, kid!.ETag);                                    // same access, different person
        await home.Lab.Ask(home.Lab.Emma, new MutationInput { Key = Matrix });
        var c = await home.Projection.ForViewerAsync(home.Lab.Emma, false, default);
        Assert.NotEqual(a.ETag, c!.ETag);
        home.Prefs.By[home.Lab.Emma.UserId] = new HomePreferences(null, false, null, null);
        Assert.NotEqual(c.ETag, (await home.Projection.ForViewerAsync(home.Lab.Emma, false, default))!.ETag);
        Assert.NotEqual(c.ETag, (await home.Projection.ForViewerAsync(home.Lab.Emma, true, default))!.ETag);
    }

    [Fact]
    public void TheRequestsPageNeverSendsTheFirstArrivalEvidence()
    {
        var json = JsonSerializer.Serialize(new HubEntry { Key = Matrix, FirstArrivedAt = DateTime.UtcNow }, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
        Assert.DoesNotContain("firstArrived", json, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void FirstArrivalDatesOnlyEverMoveEarlierAndSurviveARestart()
    {
        var path = Path.Combine(Path.GetTempPath(), "je-tests-home-" + Guid.NewGuid().ToString("N") + ".db");
        try
        {
            var first = new DateTime(2026, 10, 1, 8, 0, 0, DateTimeKind.Utc);
            using (var db = new AcquireDatabase(path))
            {
                Assert.Equal(7, db.Version);
                var arrivals = new HomeArrivals(db, null, null, () => true);
                arrivals.Record(new[] { ("movie:tmdb:603|std", first) });
                arrivals.Record(new[] { ("movie:tmdb:603|std", first.AddDays(5)) });      // a replacement copy
                Assert.Equal(first, arrivals.FirstAt("movie:tmdb:603|std"));
                Assert.Equal(first, arrivals.FirstAtOrRecord("movie:tmdb:603|std", first.AddDays(9)));
                Assert.Equal(first.AddDays(-1), arrivals.FirstAtOrRecord("tv:tvdb:1:s1:e1", first.AddDays(-1)));
                arrivals.Record(new[] { ("movie:tmdb:603|std", first.AddDays(-2)) });     // an older copy found later
                Assert.Equal(first.AddDays(-2), arrivals.FirstAt("movie:tmdb:603|std"));
            }
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
            using (var db = new AcquireDatabase(path))
            {
                var arrivals = new HomeArrivals(db, null, null, () => true);
                Assert.Equal(first.AddDays(-2), arrivals.FirstAt("movie:tmdb:603|std"));
                Assert.Equal(first.AddDays(-1), arrivals.FirstAt("tv:tvdb:1:s1:e1"));
                Assert.Null(arrivals.FirstAt("movie:tmdb:1|std"));
            }
        }
        finally
        {
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
            foreach (var f in Directory.GetFiles(Path.GetDirectoryName(path)!, Path.GetFileName(path) + "*")) File.Delete(f);
        }
    }

    [Fact]
    public void ContentKeysNameTheEditionOrTheEpisode()
    {
        Assert.Equal("movie:tmdb:603|std", HomeArrivals.MovieContent(TitleKey.Parse(Matrix)!, false));
        Assert.Equal("movie:tmdb:603|4k", HomeArrivals.MovieContent(TitleKey.Parse(Matrix)!, true));
        Assert.Equal("tv:tvdb:78874:s1:e5", HomeArrivals.EpisodeContent(TitleKey.Parse(Firefly + ":s3")!, 1, 5));
    }

    [Fact]
    public void FollowedTitlesGetAHomeReleaseOrTheNextEpisodeFromTmdbNeverATheatricalDate()
    {
        var now = new DateTime(2026, 10, 17, 12, 0, 0, DateTimeKind.Utc);
        var releases = """
        {"results":[
          {"iso_3166_1":"US","release_dates":[{"type":3,"release_date":"2026-10-20T00:00:00.000Z"},{"type":5,"release_date":"2026-12-01T00:00:00.000Z"},{"type":4,"release_date":"2026-11-14T00:00:00.000Z"},{"type":4,"release_date":"2026-01-01T00:00:00.000Z"}]},
          {"iso_3166_1":"AU","release_dates":[{"type":3,"release_date":"2026-10-21T00:00:00.000Z"}]}]}
        """;
        Assert.Equal(new DateTime(2026, 11, 14, 0, 0, 0, DateTimeKind.Utc), FollowDates.HomeRelease(releases, "US", now)!.Date);
        Assert.Equal(new DateTime(2026, 11, 14, 0, 0, 0, DateTimeKind.Utc), FollowDates.HomeRelease(releases, "AU", now)!.Date);   // AU has only cinema: US
        Assert.Null(FollowDates.HomeRelease("""{"results":[{"iso_3166_1":"US","release_dates":[{"type":3,"release_date":"2026-10-20"}]}]}""", "US", now));
        Assert.Equal(new DateTime(2026, 12, 1, 0, 0, 0, DateTimeKind.Utc), FollowDates.HomeRelease("""{"results":[{"iso_3166_1":"US","release_dates":[{"type":5,"release_date":"2026-12-01"}]}]}""", "US", now)!.Date);
        var next = FollowDates.NextEpisode("""{"name":"Severance","next_episode_to_air":{"air_date":"2026-10-18","season_number":3,"episode_number":6}}""")!;
        Assert.Equal((new DateTime(2026, 10, 18, 0, 0, 0, DateTimeKind.Utc), 3, 6), (next.Date, next.Season!.Value, next.Episode!.Value));
        Assert.Null(FollowDates.NextEpisode("""{"name":"Ended","next_episode_to_air":null}"""));
        Assert.Null(FollowDates.NextEpisode("not json"));
    }
}
