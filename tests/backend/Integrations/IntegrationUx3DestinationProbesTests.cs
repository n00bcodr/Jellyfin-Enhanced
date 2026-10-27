using Jellyfin.Data;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;

namespace JE.Tests;

/// <summary>
/// UX-3 round 3 (review UX2R2-1, -4, -5 probes): the season rows read the request target's own Sonarr through the real
/// snapshot store and request policy. Only a list read now counts, a target the viewer may not use is never read or named,
/// and a 4K ask is described by the 4K target's own list.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationUx3DestinationProbesTests
{
    private static Task<DestinationSeason> Read(ArrStateStore store, string instance, int season = 1)
        => SeasonRowsService.DestinationSeasonAsync(store, instance, new[] { TitleKey.Parse("tv:tvdb:100")! }, season, CancellationToken.None);

    [Theory]
    [InlineData(403)]
    [InlineData(503)]
    [InlineData(-1)]
    public async Task UX2R2_5_AFailedRefreshOfAWarmEpisodeListIsUnreadNotTheListItKept(int status)
    {
        using var arr = new FakeArr();
        var host = arr.Add("sonarr.lan", "Sonarr");
        arr.Configure(("TV", ArrKind.Sonarr, "http://sonarr.lan:8989", "PROBE-FAKE-CREDENTIAL"));
        host.Series.Add(FakeArr.SeriesRow(1, 100, "Show"));
        var episode = FakeArr.Episode(1, "2020-01-01T00:00:00Z"); episode["title"] = "One"; host.Episodes.Add(episode);
        var store = arr.Store(); var tv = arr.Instance("TV");
        Assert.True((await Read(store, tv.Id)).Read);
        if (status == -1) host.Before = (path, _) => path == "/api/v3/episode" ? Task.FromException(new TaskCanceledException("synthetic timeout")) : Task.CompletedTask;
        else host.EpisodesFailWith = status;
        await store.ReadEpisodesNowAsync(tv, 1, default);
        Assert.NotNull(store.PeekEpisodes(tv, 1)!.Error);
        Assert.False((await Read(store, tv.Id)).Read);
    }

    [Fact]
    public async Task UX2R2_5_AColdRefusalIsUnreadAndSpecialsAreNotTheSeason()
    {
        using var arr = new FakeArr(); var host = arr.Add("sonarr.lan", "Sonarr");
        arr.Configure(("TV", ArrKind.Sonarr, "http://sonarr.lan:8989", "PROBE-FAKE-CREDENTIAL"));
        host.FailWith = 403;
        var store = arr.Store(); var tv = arr.Instance("TV");
        Assert.False((await Read(store, tv.Id)).Read);

        // Specials are season 0: never part of season 1's list.
        using var fresh = new FakeArr();
        var other = fresh.Add("sonarr.lan", "Sonarr");
        fresh.Configure(("TV", ArrKind.Sonarr, "http://sonarr.lan:8989", "PROBE-FAKE-CREDENTIAL"));
        other.Series.Add(FakeArr.SeriesRow(1, 100, "Show"));
        var special = FakeArr.Episode(1, "2020-01-01T00:00:00Z", season: 0, episode: 1); special["title"] = "Special One"; other.Episodes.Add(special);
        var regular = FakeArr.Episode(2, "2020-01-02T00:00:00Z", season: 1, episode: 1); regular["title"] = "One"; other.Episodes.Add(regular);
        var read = await Read(fresh.Store(), fresh.Instance("TV").Id);
        Assert.True(read.Read && read.Holds);
        Assert.Equal(new[] { ("One", 1) }, read.Episodes.Select(e => (e.Title!, e.Episode)));
    }

    [Fact]
    public async Task UX2R2_1_AVisibleSeasonSaysNothingAboutAnInaccessibleTargetsSonarr()
    {
        using var arr = new FakeArr(); var host = arr.Add("sonarr.lan", "Sonarr");
        arr.Configure(("TV", ArrKind.Sonarr, "http://sonarr.lan:8989", "PROBE-FAKE-CREDENTIAL"));
        var config = arr.Plugin.Plugin.Configuration;
        config.ArrIntegrationEnabled = config.ArrPhase1Enabled = config.ArrPhase3Enabled = true;
        config.ArrRequestBackend = "je"; config.ArrRequestDefaultRole = "Member";
        host.Series.Add(FakeArr.SeriesRow(1, 100, "Show", tmdb: 101));
        var ep = FakeArr.Episode(1, "2020-01-01T00:00:00Z"); ep["title"] = "One"; host.Episodes.Add(ep);
        var extra = FakeArr.Episode(2, "2020-01-02T00:00:00Z", episode: 2); extra["title"] = "Private Extra"; host.Episodes.Add(extra);
        var store = arr.Store(); var tv = arr.Instance("TV"); await Read(store, tv.Id);
        using var r = new IntegrationRequestLedgerTests.Rig();
        var viewer = r.View.Users[r.Member];
        var library = new FakeLibraryAccess(); var open = library.AddLibrary("Open", "tvshows", "/public"); library.AddLibrary("Private", "tvshows", "/data/tv");
        var user = (Jellyfin.Database.Implementations.Entities.User)viewer.Handle!;
        user.SetPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.EnableAllFolders, false);
        user.SetPreference(Jellyfin.Database.Implementations.Enums.PreferenceKind.EnabledFolders, new[] { open.Id });
        var seriesId = Guid.NewGuid(); var seasonId = Guid.NewGuid(); var key = TitleKey.Parse("tv:tvdb:100")!;
        r.View.AddItem(new JfItemRef { ItemId = seriesId, Kind = "series", Key = key, Path = "/public/Show" });
        r.View.AddCopy(key, new JfCopy { ItemId = seriesId, Path = "/public/Show" }, viewer.UserId);
        r.View.AddItem(new JfItemRef { ItemId = seasonId, Kind = "season", Key = key.WithSeason(1), SeriesId = seriesId, Season = 1, TmdbId = 101 });
        var libs = new ArrInstanceLibraries(store, library, () => arr.Now);
        var aliases = new TitleAliases(store, null);
        var policy = new RequestPolicy(r.View, store, libs, aliases, null!, arr.Factory, new UnavailableRequestBackend());
        var input = new MutationInput { Key = key.ToString(), Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } };
        Assert.False(policy.Evaluate(viewer.UserId, input).Visible, "request destination is in inaccessible Private library");
        var reads = new List<string>();
        var rows = new SeasonRowsService(r.View, r.Ledger, policy, aliases,
            (_, _, _, _) => Task.FromResult<string?>("""{"episodes":[{"episode_number":1,"name":"One"}]}"""),
            destination: (instance, _, _, _) => { reads.Add(instance); return Read(store, instance); });
        var answer = await rows.ForSeasonAsync(viewer, seasonId, "en", default);
        Assert.NotNull(answer); Assert.False(answer.CanRequest);
        Assert.Empty(reads);                                            // the target was never read
        Assert.Equal("unchecked", answer.Source);                       // the same whether or not it holds the series
        Assert.DoesNotContain(answer.Episodes, e => e.Episode == 2 || e.Title == "Private Extra");
    }

    [Fact]
    public async Task UX2R2_EpisodeTitlesStayScopedToTheirInstanceAndFollowRefreshAndConnection()
    {
        using var arr = new FakeArr();
        var a = arr.Add("sonarr.lan", "Sonarr"); var b = arr.Add("other.lan", "Sonarr"); var c = arr.Add("new.lan", "Sonarr");
        arr.Configure(("TV", ArrKind.Sonarr, "http://sonarr.lan:8989", "PROBE-FAKE-A"), ("Other", ArrKind.Sonarr, "http://other.lan:8989", "PROBE-FAKE-B"));
        foreach (var (host, title) in new[] { (a, "Original"), (b, "OtherInstance"), (c, "NewConnection") })
        {
            var ep = FakeArr.Episode(1, "2020-01-01T00:00:00Z"); ep["title"] = title; host.Episodes.Add(ep);
        }
        var store = arr.Store(); var tv = arr.Instance("TV");
        Assert.Equal("Original", (await store.GetEpisodesAsync(tv, 1, default)).Value!.Episodes.Single().Title);
        Assert.Equal("OtherInstance", (await store.GetEpisodesAsync(arr.Instance("Other"), 1, default)).Value!.Episodes.Single().Title);
        a.Episodes[0]["title"] = "Refreshed";
        Assert.Equal("Refreshed", (await store.ReadEpisodesNowAsync(tv, 1, default)).Value!.Episodes.Single().Title);
        arr.Plugin.Plugin.Configuration.SonarrInstances = arr.Plugin.Plugin.Configuration.SonarrInstances.Replace("sonarr.lan", "new.lan");
        Assert.Equal("NewConnection", (await store.GetEpisodesAsync(arr.Instance("TV"), 1, default)).Value!.Episodes.Single().Title);
    }

    [Fact]
    public async Task UX2R2_4_AFourKAskIsDescribedByTheFourKTargetsOwnList()
    {
        using var arr = new FakeArr(); var hd = arr.Add("sonarr.lan", "Sonarr"); var uhd = arr.Add("fourk.lan", "Sonarr");
        arr.Configure(("TV", ArrKind.Sonarr, "http://sonarr.lan:8989", "PROBE-FAKE-A"), ("UHD", ArrKind.Sonarr, "http://fourk.lan:8989", "PROBE-FAKE-B"));
        var config = arr.Plugin.Plugin.Configuration;
        var configured = System.Text.Json.Nodes.JsonNode.Parse(config.SonarrInstances)!.AsArray();
        configured.Single(x => (string?)x!["Name"] == "UHD")!["Role"] = "4k";
        config.SonarrInstances = configured.ToJsonString();
        config.ArrIntegrationEnabled = config.ArrPhase1Enabled = config.ArrPhase3Enabled = true; config.ArrRequestBackend = "je";
        foreach (var (host, title) in new[] { (hd, "One"), (uhd, "A Different Episode") })
        {
            host.Series.Add(FakeArr.SeriesRow(1, 100, "Show"));
            var ep = FakeArr.Episode(1, "2020-01-01T00:00:00Z"); ep["title"] = title; host.Episodes.Add(ep);
        }
        var store = arr.Store(); var tv = arr.Instance("TV"); var fourk = arr.Instance("UHD");
        using var r = new IntegrationRequestLedgerTests.Rig(); var viewer = r.View.Users[r.Admin];
        var aliases = new TitleAliases(store, null);
        var policy = new RequestPolicy(r.View, store, new ArrInstanceLibraries(store, new FakeLibraryAccess()), aliases, null!, arr.Factory, new UnavailableRequestBackend());
        var input = new MutationInput { Key = "tv:tvdb:100", Variant = "4k", Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1) } };
        Assert.Equal(fourk.Id, policy.JeTarget(viewer.UserId, input).InstanceId);
        var seasonId = Guid.NewGuid(); var seriesId = Guid.NewGuid();
        r.View.AddItem(new JfItemRef { ItemId = seasonId, Kind = "season", Key = TitleKey.Parse(input.Key)!.WithSeason(1), SeriesId = seriesId, Season = 1, TmdbId = 101 });
        var called = new List<string>();
        var service = new SeasonRowsService(r.View, r.Ledger, policy, aliases, (_, _, _, _) => Task.FromResult<string?>("""{"episodes":[{"episode_number":1,"name":"One"}]}"""),
            destination: (instance, _, _, _) => { called.Add(instance); return Read(store, instance); });
        var standard = await service.ForSeasonAsync(viewer, seasonId, "en", default);
        Assert.Equal("destination", standard!.Source);
        Assert.Equal("One", standard.Episodes.Single().Title);
        var fourK = await service.ForSeasonAsync(viewer, seasonId, "en", default, "4k");
        Assert.Equal("destination", fourK!.Source);
        Assert.Equal("A Different Episode", fourK.Episodes.Single().Title);
        Assert.Equal(new[] { tv.Id, fourk.Id }, called);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task UX2R3_3_ADateOnlyEpisodeAiringTodayIsNotAnAiredPickerNumber(bool provider)
    {
        using var arr = new FakeArr(); var host = arr.Add("sonarr.lan", "Sonarr");
        arr.Configure(("TV", ArrKind.Sonarr, "http://sonarr.lan:8989", "PROBE-FAKE"));
        host.Series.Add(FakeArr.SeriesRow(1, 100, "Show"));
        var ep = FakeArr.Episode(1, "2026-10-12T00:00:00Z"); ep.Remove("airDateUtc"); ep["airDate"] = "2026-10-12"; host.Episodes.Add(ep);
        var store = arr.Store(); var tv = arr.Instance("TV");
        var library = (await store.GetLibraryAsync(tv, default)).Value!;
        var snapshot = (await store.GetEpisodesAsync(tv, 1, default)).Value!;
        Assert.True(snapshot.Episodes.Single().AirDateIsDay);
        using var r = new IntegrationRequestLedgerTests.Rig(); var viewer = r.View.Users[r.Member];
        var copy = new ArrCopyFacts(tv) { Series = library.SeriesByTvdb(100), Episodes = snapshot };
        var state = StatusComposer.EpisodeFromArr(copy.Through(HiddenParts.None), 1, 1, snapshot.Episodes.Single(), new ComposeContext(viewer, arr.Now.UtcDateTime, 24));
        Assert.Equal(StatusStage.NotOut, state.Stage);                  // the season page's own airing rule
        var key = TitleKey.Parse("tv:tvdb:100")!; var seasonId = Guid.NewGuid();
        r.View.AddItem(new JfItemRef { ItemId = seasonId, Kind = "season", Key = key.WithSeason(1), SeriesId = Guid.NewGuid(), Season = 1, TmdbId = 101 });
        var rows = new SeasonRowsService(r.View, r.Ledger, r.Policy, null, (_, _, _, _) => Task.FromResult<string?>("""{"episodes":[{"episode_number":1,"name":"Today","air_date":"2026-10-12"}]}"""), () => arr.Now,
            destination: (_, titles, season, ct) => provider ? Task.FromResult(DestinationSeason.NotHeld) : SeasonRowsService.DestinationSeasonAsync(store, tv.Id, titles, season, ct));
        var answer = await rows.ForSeasonAsync(viewer, seasonId, "en", default);
        Assert.NotNull(answer); Assert.Equal(provider ? "provider" : "destination", answer.Source);
        Assert.False(answer.Episodes.Single().Aired, "the page says NotOut; the picker must not offer it as aired");
        // The same rule a day and a half on: aired for both.
        var later = new SeasonRowsService(r.View, r.Ledger, r.Policy, null, (_, _, _, _) => Task.FromResult<string?>("""{"episodes":[{"episode_number":1,"name":"Today","air_date":"2026-10-12"}]}"""), () => arr.Now.AddHours(37),
            destination: (_, titles, season, ct) => provider ? Task.FromResult(DestinationSeason.NotHeld) : SeasonRowsService.DestinationSeasonAsync(store, tv.Id, titles, season, ct));
        Assert.True((await later.ForSeasonAsync(viewer, seasonId, "en", default))!.Episodes.Single().Aired);
    }
}
