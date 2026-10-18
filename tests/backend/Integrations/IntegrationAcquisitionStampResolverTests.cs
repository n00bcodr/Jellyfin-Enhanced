using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Stamps;

namespace JE.Tests;

/// <summary>
/// Phase 4e: which one stamp a viewer sees (Upgraded &gt; New for you &gt; 4K), decided at read time from the facts, the
/// viewer's access and watch state, the lifetimes and the library's 4K copies.
/// </summary>
public class IntegrationAcquisitionStampResolverTests
{
    private static readonly DateTime T0 = StampWorld.T0;

    // ── 9. facts ─────────────────────────────────────────────────────────

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void UpgradedBeatsNewWhichBeatsFourKWhateverOrderTheFactsAreIn(bool newFirst)
    {
        using var w = new StampWorld();
        w.Config.ArrAcquisitionUpgradedDays = 1;
        w.Config.ArrAcquisitionNewDays = 3;
        var series = w.AddSeries(StampWorld.Show(81189));
        var e1 = w.AddEpisode(series, null, 1, 1, T0);
        var e2 = w.AddEpisode(series, null, 1, 2, T0);
        w.AddEpisode(w.AddSeries(StampWorld.Show(81189)), null, 1, 3, T0.AddDays(-50), fourK: true);   // a 4K copy in another series copy
        var user = Guid.NewGuid();
        if (newFirst) w.Store.AddNew(user, e2, T0, "follow");
        w.Store.AddUpgraded(e1, T0, "sonarr:1");
        if (!newFirst) w.Store.AddNew(user, e2, T0, "follow");

        Assert.Equal(AcquisitionStamp.Upgraded, w.Resolver.Resolve(series.Id, user, T0.AddHours(1)));
        Assert.Equal(AcquisitionStamp.NewForYou, w.Resolver.Resolve(series.Id, user, T0.AddDays(1)));   // Upgraded expired
        Assert.Equal(AcquisitionStamp.FourK, w.Resolver.Resolve(series.Id, user, T0.AddDays(3)));       // New expired too
    }

    [Fact]
    public void NewIsOnlyForItsOwnPersonAndUpgradedForAnyoneWhoCanOpenTheItem()
    {
        using var w = new StampWorld();
        var asked = w.AddMovie(StampWorld.Movie(1), T0);
        var upgraded = w.AddMovie(StampWorld.Movie(2), T0);
        var (owner, other, locked) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        w.Store.AddNew(owner, asked, T0, "request");
        w.Store.AddUpgraded(upgraded, T0, "radarr:1");
        w.Library.Deny(locked, upgraded.Id);

        Assert.Equal(AcquisitionStamp.NewForYou, w.Resolver.Resolve(asked.Id, owner, T0.AddHours(1)));
        Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(asked.Id, other, T0.AddHours(1)));
        Assert.Equal(AcquisitionStamp.Upgraded, w.Resolver.Resolve(upgraded.Id, owner, T0.AddHours(1)));
        Assert.Equal(AcquisitionStamp.Upgraded, w.Resolver.Resolve(upgraded.Id, other, T0.AddHours(1)));
        Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(upgraded.Id, locked, T0.AddHours(1)));
        Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(asked.Id, Guid.Empty, T0.AddHours(1)));
        Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(Guid.Empty, owner, T0.AddHours(1)));
    }

    [Fact]
    public void NobodyGetsAStampForAnItemTheyCanNoLongerOpen()
    {
        using var w = new StampWorld();
        var series = w.AddSeries(StampWorld.Show(5));
        var episode = w.AddEpisode(series, null, 1, 1, T0);
        var user = Guid.NewGuid();
        w.Store.AddNew(user, episode, T0, "follow");
        w.Store.AddUpgraded(w.AddEpisode(series, null, 1, 2, T0), T0, "sonarr:1");
        // Access revoked after the facts were written (e.g. a parental limit or library access change).
        w.Library.Deny(user, episode.Id);
        foreach (var item in w.Library.Items.Values.Where(i => i.Kind == "episode")) w.Library.Deny(user, item.Id);

        Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(episode.Id, user, T0.AddHours(1)));
        Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(series.Id, user, T0.AddHours(1)));
    }

    [Fact]
    public void NewEndsWithAPlayedMarkOrAPlaybackSinceItArrived()
    {
        using var w = new StampWorld();
        var movie = w.AddMovie(StampWorld.Movie(1), T0);
        var user = Guid.NewGuid();
        w.Store.AddNew(user, movie, T0, "request");
        var at = T0.AddHours(1);

        w.Library.Played(user, movie.Id, false, T0.AddDays(-30));      // watched an older copy before it arrived
        Assert.Equal(AcquisitionStamp.NewForYou, w.Resolver.Resolve(movie.Id, user, at));
        w.Library.Played(user, movie.Id, false, T0);                    // playback at the arrival counts
        Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(movie.Id, user, at));
        w.Library.Played(user, movie.Id, true, null);                   // a played mark alone ends New
        Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(movie.Id, user, at));
    }

    [Fact]
    public void UpgradedSurvivesACarriedOverPlayedMarkButEndsWithPlaybackAfterTheUpgrade()
    {
        using var w = new StampWorld();
        var movie = w.AddMovie(StampWorld.Movie(1), T0.AddDays(-60));
        var user = Guid.NewGuid();
        w.Store.AddUpgraded(movie, T0, "radarr:1");
        var at = T0.AddHours(1);

        w.Library.Played(user, movie.Id, true, null);
        Assert.Equal(AcquisitionStamp.Upgraded, w.Resolver.Resolve(movie.Id, user, at));
        w.Library.Played(user, movie.Id, true, T0.AddMilliseconds(-1));
        Assert.Equal(AcquisitionStamp.Upgraded, w.Resolver.Resolve(movie.Id, user, at));
        w.Library.Played(user, movie.Id, false, T0);
        Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(movie.Id, user, at));
    }

    [Theory]
    [InlineData(7)]
    [InlineData(1)]
    [InlineData(30)]
    public void AStampLastsExactlyItsLifetimeByTheClock(int days)
    {
        using var w = new StampWorld();
        w.Config.ArrAcquisitionNewDays = days;
        w.Config.ArrAcquisitionUpgradedDays = days;
        var asked = w.AddMovie(StampWorld.Movie(1), T0);
        var upgraded = w.AddMovie(StampWorld.Movie(2), T0);
        var user = Guid.NewGuid();
        w.Store.AddNew(user, asked, T0, "request");
        w.Store.AddUpgraded(upgraded, T0, "radarr:1");

        w.Now = T0.AddDays(days).AddMilliseconds(-1);
        Assert.Equal(AcquisitionStamp.NewForYou, w.Resolver.Resolve(asked.Id, user));
        Assert.Equal(AcquisitionStamp.Upgraded, w.Resolver.Resolve(upgraded.Id, user));
        w.Now = T0.AddDays(days);
        Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(asked.Id, user));
        Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(upgraded.Id, user));
    }

    [Fact]
    public void ALifetimeChangeAppliesAtOnceAndLifetimesAreClamped()
    {
        using var w = new StampWorld();
        var movie = w.AddMovie(StampWorld.Movie(1), T0);
        var user = Guid.NewGuid();
        w.Store.AddNew(user, movie, T0, "request");
        w.Now = T0.AddDays(3);
        Assert.Equal(AcquisitionStamp.NewForYou, w.Resolver.Resolve(movie.Id, user));
        w.Config.ArrAcquisitionNewDays = 2;
        Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(movie.Id, user));
        w.Config.ArrAcquisitionNewDays = 0;                // clamped to 1 day
        w.Now = T0.AddHours(23);
        Assert.Equal(AcquisitionStamp.NewForYou, w.Resolver.Resolve(movie.Id, user));
        w.Now = T0.AddHours(24);
        Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(movie.Id, user));
    }

    [Fact]
    public void WithTheBadgeSwitchOffNobodySeesAnything()
    {
        using var w = new StampWorld();
        var asked = w.AddMovie(StampWorld.Movie(1), T0);
        var upgraded = w.AddMovie(StampWorld.Movie(2), T0);
        w.AddMovie(StampWorld.Movie(3), T0.AddDays(-9), fourK: true);
        var fourK = w.AddMovie(StampWorld.Movie(3), T0);
        var user = Guid.NewGuid();
        w.Store.AddNew(user, asked, T0, "request");
        w.Store.AddUpgraded(upgraded, T0, "radarr:1");
        var on = new[] { asked, upgraded, fourK }.Select(i => w.Resolver.Resolve(i.Id, user, T0.AddHours(1))).ToArray();
        Assert.Equal(new[] { AcquisitionStamp.NewForYou, AcquisitionStamp.Upgraded, AcquisitionStamp.FourK }, on);

        foreach (var off in new Action<Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration>[]
        {
            c => c.ArrPhase4AcquisitionBadgesEnabled = false, c => c.ArrPhase4Enabled = false, c => c.ArrPhase1Enabled = false, c => c.ArrIntegrationEnabled = false,
        })
        {
            w.Config = StampWorld.On();
            off(w.Config);
            Assert.All(new[] { asked, upgraded, fourK }, i => Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(i.Id, user, T0.AddHours(1))));
        }

        w.Config = null!;
        Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(asked.Id, user, T0.AddHours(1)));
    }

    [Fact]
    public void AFailingLibraryGivesNoStampAndNeverThrows()
    {
        using var w = new StampWorld();
        var movie = w.AddMovie(StampWorld.Movie(1), T0);
        var user = Guid.NewGuid();
        w.Store.AddNew(user, movie, T0, "request");
        w.Library.Fail = new InvalidOperationException("library unavailable");

        Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(movie.Id, user, T0.AddHours(1)));
        Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(Guid.NewGuid(), user, T0.AddHours(1)));
        w.Library.Fail = null;
        Assert.Equal(AcquisitionStamp.NewForYou, w.Resolver.Resolve(movie.Id, user, T0.AddHours(1)));
    }

    // ── 10. 4K ───────────────────────────────────────────────────────────

    [Fact]
    public void AMovieCardShowsFourKOnlyForAFourKCopyTheViewerCanOpen()
    {
        using var w = new StampWorld();
        var standard = w.AddMovie(StampWorld.Movie(603), T0.AddDays(-20));
        var uhd = w.AddMovie(StampWorld.Movie(603), T0.AddDays(-10), fourK: true);
        var unrelated = w.AddMovie(StampWorld.Movie(604), T0.AddDays(-20));
        var (viewer, kid) = (Guid.NewGuid(), Guid.NewGuid());
        w.Library.Deny(kid, uhd.Id);

        Assert.Equal(AcquisitionStamp.FourK, w.Resolver.Resolve(standard.Id, viewer, T0));
        Assert.Equal(AcquisitionStamp.FourK, w.Resolver.Resolve(uhd.Id, viewer, T0));
        Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(standard.Id, kid, T0));
        Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(unrelated.Id, viewer, T0));
    }

    [Fact]
    public void FourKOnASeriesSeasonAndEpisodeCardFollowsTheSeasonAndEpisodeNumbers()
    {
        using var w = new StampWorld();
        var series = w.AddSeries(StampWorld.Show(81189));
        var s1 = w.AddSeason(series, 1);
        var s2 = w.AddSeason(series, 2);
        var e11 = w.AddEpisode(series, s1, 1, 1, T0.AddDays(-30));
        var e12 = w.AddEpisode(series, s1, 1, 2, T0.AddDays(-30));
        var e14 = w.AddEpisode(series, s1, 1, 4, T0.AddDays(-30));
        var e15to16 = w.AddEpisode(series, s1, 1, 5, T0.AddDays(-30), end: 6);
        w.AddEpisode(series, s2, 2, 1, T0.AddDays(-30));
        // The 4K copies live in another series item for the same show: S1E1, and a two-episode file S1E3-E4, and S1E6.
        var uhd = w.AddSeries(StampWorld.Show(81189));
        w.AddEpisode(uhd, null, 1, 1, T0.AddDays(-5), fourK: true);
        w.AddEpisode(uhd, null, 1, 3, T0.AddDays(-5), fourK: true, end: 4);
        w.AddEpisode(uhd, null, 1, 6, T0.AddDays(-5), fourK: true);
        var other = w.AddSeries(StampWorld.Show(1));
        var user = Guid.NewGuid();

        Assert.Equal(AcquisitionStamp.FourK, w.Resolver.Resolve(series.Id, user, T0));
        Assert.Equal(AcquisitionStamp.FourK, w.Resolver.Resolve(s1.Id, user, T0));
        Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(s2.Id, user, T0));
        Assert.Equal(AcquisitionStamp.FourK, w.Resolver.Resolve(e11.Id, user, T0));
        Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(e12.Id, user, T0));
        Assert.Equal(AcquisitionStamp.FourK, w.Resolver.Resolve(e14.Id, user, T0));      // inside the 4K multi-episode file
        Assert.Equal(AcquisitionStamp.FourK, w.Resolver.Resolve(e15to16.Id, user, T0));  // its own range reaches E6
        Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(other.Id, user, T0));
        Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(Guid.NewGuid(), user, T0));
    }

    [Fact]
    public void AFourKArrivalJudgedAfterItsProbeReachesTheIndexWithoutALibraryEvent()
    {
        using var w = new StampWorld();
        var standard = w.AddMovie(StampWorld.Movie(603), T0.AddDays(-20));
        // Jellyfin raised "added" before it read the video size: the copy isn't 4K yet when the index is built.
        var uhd = w.Library.Put(new StampItem { Id = Guid.NewGuid(), Kind = "movie", Keys = standard.Keys, DateCreated = T0.AddMinutes(-2) });
        var user = Guid.NewGuid();
        Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(standard.Id, user, T0));
        Assert.Equal(1, w.Library.FourKCalls);

        // The probe lands; Jellyfin raises no further event the stamp code sees.
        w.Library.Put(uhd with { Width = 3840, Height = 2160 });
        w.Resolver.RefreshFourK();
        Assert.Equal(1, w.Library.FourKCalls);                                         // nothing told the index
        Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(standard.Id, user, T0));

        Assert.Equal(AcquisitionStampFeeder.Outcome.Done, w.Feeder.Judge(uhd.Id, T0));   // judging it sees a 4K copy
        w.Resolver.RefreshFourK();
        Assert.Equal(2, w.Library.FourKCalls);
        Assert.Equal(AcquisitionStamp.FourK, w.Resolver.Resolve(standard.Id, user, T0));

        // A standard arrival doesn't dirty the index.
        w.Feeder.Judge(w.AddMovie(StampWorld.Movie(604), T0.AddMinutes(-2)).Id, T0);
        w.Resolver.RefreshFourK();
        Assert.Equal(2, w.Library.FourKCalls);
    }

    [Fact]
    public async Task AFourKUpgradeImportReachesTheIndexWithoutALibraryEvent()
    {
        using var w = new StampWorld();
        var standard = w.AddMovie(StampWorld.Movie(603), T0.AddDays(-20));
        var user = Guid.NewGuid();
        await w.Feeder.TickAsync(CancellationToken.None);                            // builds the index (no 4K copy yet)
        var built = w.Library.FourKCalls;
        Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(standard.Id, user, T0));

        // The arr upgraded another copy to 4K in place: same item, no event the stamp code sees.
        w.AddMovie(StampWorld.Movie(603), T0.AddDays(-90), fourK: true, path: "/movies/m-2160p.mkv");
        w.Upgrades.Imports.Add(new StampUpgradeImport("radarr:9", "/movies/m-2160p.mkv", T0.AddMinutes(-5)));
        w.Now = T0.AddSeconds(15);
        await w.Feeder.TickAsync(CancellationToken.None);                            // records the upgrade, notes the 4K copy
        Assert.Equal(built + 1, w.Library.FourKCalls);                         // index is current before publishing
        Assert.Equal(AcquisitionStamp.FourK, w.Resolver.Resolve(standard.Id, user, T0));
        w.Now = T0.AddSeconds(30);
        await w.Feeder.TickAsync(CancellationToken.None);                            // unchanged next round does not rebuild
        Assert.Equal(built + 1, w.Library.FourKCalls);
        Assert.Equal(AcquisitionStamp.FourK, w.Resolver.Resolve(standard.Id, user, T0));
    }

    [Fact]
    public void TheFourKIndexIsRebuiltInTheBackgroundAfterALibraryEventNeverOnTheReadPath()
    {
        using var w = new StampWorld();
        var standard = w.AddMovie(StampWorld.Movie(603), T0.AddDays(-20));
        var user = Guid.NewGuid();
        Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(standard.Id, user, T0));
        Assert.Equal(1, w.Library.FourKCalls);                     // built once, on first use

        var uhd = new StampItem { Id = Guid.NewGuid(), Kind = "movie", Keys = standard.Keys, Width = 3840, Height = 2160, DateCreated = T0 };
        w.Library.RaiseAdded(uhd);
        Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(standard.Id, user, T0));   // still the old index
        Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(standard.Id, user, T0));
        Assert.Equal(1, w.Library.FourKCalls);                     // a read never rebuilds it

        w.Resolver.RefreshFourK();                                 // the feeder's loop: dirty, so rebuilt
        Assert.Equal(2, w.Library.FourKCalls);
        Assert.Equal(AcquisitionStamp.FourK, w.Resolver.Resolve(standard.Id, user, T0));
        w.Resolver.RefreshFourK();                                 // clean and fresh: no rebuild
        Assert.Equal(2, w.Library.FourKCalls);

        // An update that makes a copy 4K (media info read late) marks it dirty too, and so does a removal.
        var late = w.AddMovie(StampWorld.Movie(700), T0);
        var other = w.AddMovie(StampWorld.Movie(700), T0.AddDays(-3));
        w.Library.RaiseUpdated(late with { Width = 3840, Height = 2160 });
        Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(other.Id, user, T0));
        w.Resolver.RefreshFourK();
        Assert.Equal(AcquisitionStamp.FourK, w.Resolver.Resolve(other.Id, user, T0));
        w.Library.RaiseRemoved(w.Library.Items[late.Id]);
        w.Resolver.RefreshFourK();
        Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(other.Id, user, T0));
        Assert.Equal(4, w.Library.FourKCalls);
    }
}
