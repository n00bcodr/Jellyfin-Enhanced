using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Home;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Stamps;
using Moq;

namespace JE.Tests;

/// <summary>
/// Integration rebuild, stage 1 fix round 2 (RBS1-BEH-R2-1, D53): a source whose dimensions Jellyfin hasn't read is
/// never the standard edition, for any edition consumer. It stays pending (not seen, no edition recorded) and a later
/// probe classifies it whenever it arrives: the badge feeder's ten-minute wait only stops retrying the read, it never
/// decides the edition. The badge feeder used to judge a source still unprobed after the wait as standard and mark it
/// seen, so a first 4K file probed at 12 minutes never got its New badge, and the standard edition it recorded in the
/// shared arrival history made home rows see a standard copy that never existed.
/// </summary>
public class IntegrationUnknownEditionTests
{
    private static readonly DateTime T0 = StampWorld.T0;

    private static IReadOnlyList<StampFact> News(StampWorld w, Guid item) => w.Store.FactsFor(item).Where(f => f.Kind == AcquisitionStampKinds.New).ToList();

    private static StampItem Arrival(TitleKey key, bool episode, int width = 0, int height = 0) => new()
    {
        Id = Guid.NewGuid(), Kind = episode ? "episode" : "movie", Keys = new[] { key }, Season = episode ? 1 : null, Episode = episode ? 2 : null,
        DateCreated = T0, Sources = new[] { new StampSource("v1", "/media/" + key.Title + (episode ? "/S01E02" : string.Empty) + ".mkv", width, height, T0) },
    };

    private static StampItem Probed(StampItem item, int width, int height)
        => item with { Sources = item.Sources.Select(s => s with { Width = width, Height = height }).ToArray() };

    private static string[] Parts(StampItem item, string edition)
        => item.Keys.Select(k => item.Kind == "movie" ? "m|" + k + "|" + edition : "e|" + k + "|s1e2|" + edition).ToArray();

    // Arrivals the feeder still retries every round (its private queue: the test must also build without the fix).
    private static int Pending(StampWorld w) => ((System.Collections.ICollection)typeof(AcquisitionStampFeeder)
        .GetField("_pending", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.GetValue(w.Feeder)!).Count;

    private static string Content(StampItem item) => item.Kind == "movie" ? item.Keys[0].ToString() : item.Keys[0] + ":s1:e2";

    // Ticks the feeder's background round every minute from (excluded) to (included).
    private static async Task Run(StampWorld w, int fromMinute, int toMinute)
    {
        for (var minute = fromMinute + 1; minute <= toMinute; minute++)
        {
            w.Now = T0.AddMinutes(minute);
            await w.Feeder.TickAsync(CancellationToken.None);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AFirstFourKSourceProbedAfterTheTenMinuteWaitIsNewForTheFourKAskAndNeverStandard(bool episode)
    {
        using var w = new StampWorld();
        using var home = new HomeArrivals(w.Db, null, null, () => true, w.Library, w.Store);
        await w.Feeder.TickAsync(CancellationToken.None);                       // the start's catch-up (empty library)
        var key = episode ? StampWorld.Show(78874) : StampWorld.Movie(603);
        var (fourK, standard) = (Guid.NewGuid(), Guid.NewGuid());
        w.Interests.Add(key, StampWorld.Interest(fourK, T0.AddDays(-1), fourKOnly: true, allSeasons: true));
        w.Interests.Add(key, StampWorld.Interest(standard, T0.AddDays(-1), allSeasons: true));
        var item = Arrival(key, episode);
        w.Library.RaiseAdded(item);                                              // Jellyfin announces it before the probe

        await Run(w, 0, 11);                                                     // past the ten-minute wait
        Assert.False(w.Store.Seen(item.Id, item.Sources[0].Identity));          // still pending
        Assert.Empty(w.Store.FactsFor(item.Id));
        Assert.Null(w.Store.EditionArrival(Parts(item, "std")));                // never the standard edition
        Assert.Null(home.EditionAt(Content(item), false));                      // nor for home rows, which share the history
        Assert.Equal(0, Pending(w));                                      // the wait stopped retrying the read

        // Jellyfin probes the file at 12 minutes: 2160p.
        w.Now = T0.AddMinutes(12);
        w.Library.RaiseUpdated(Probed(item, 3840, 2160));
        await Run(w, 12, 14);
        // The 4K ask's New, dated at the first sighting; the standard ask too (D44: any first copy, 4K included, is new
        // content for it).
        Assert.Equal(new[] { (fourK, T0), (standard, T0) }.OrderBy(x => x.Item1), News(w, item.Id).Select(f => (f.UserId, f.At)).OrderBy(x => x.Item1));
        Assert.Equal(AcquisitionStamp.NewForYou, w.Resolver.Resolve(item.Id, fourK, w.Now));
        Assert.DoesNotContain(w.Store.FactsFor(item.Id), f => f.Kind == AcquisitionStampKinds.Upgraded);
        Assert.Equal(T0, w.Store.EditionArrival(Parts(item, "4k")));
        Assert.Null(w.Store.EditionArrival(Parts(item, "std")));
        Assert.Equal(T0, home.EditionAt(Content(item), true));
        Assert.Null(home.EditionAt(Content(item), false));
    }

    // Control: a probed standard source is judged once settled, as before.
    [Fact]
    public async Task AProbedStandardSourceIsTheStandardEditionAtOnce()
    {
        using var w = new StampWorld();
        await w.Feeder.TickAsync(CancellationToken.None);
        var key = StampWorld.Movie(604);
        var (fourK, standard) = (Guid.NewGuid(), Guid.NewGuid());
        w.Interests.Add(key, StampWorld.Interest(fourK, T0.AddDays(-1), fourKOnly: true));
        w.Interests.Add(key, StampWorld.Interest(standard, T0.AddDays(-1)));
        var item = Arrival(key, false, 1920, 1080);
        w.Library.RaiseAdded(item);
        await Run(w, 0, 2);
        Assert.Equal(standard, Assert.Single(News(w, item.Id)).UserId);
        Assert.Equal(T0, w.Store.EditionArrival(Parts(item, "std")));
        Assert.Null(w.Store.EditionArrival(Parts(item, "4k")));
        Assert.True(w.Store.Seen(item.Id, item.Sources[0].Identity));
    }

    // Control: a source Jellyfin never probes is never classified, however long it waits; the catch-up looks again
    // (every ten minutes, not every round), so a probe that arrives without a library event is still classified.
    [Fact]
    public async Task ASourceNeverProbedStaysPendingAndTheCatchUpClassifiesALateProbe()
    {
        using var w = new StampWorld();
        await w.Feeder.TickAsync(CancellationToken.None);
        var key = StampWorld.Movie(605);
        var standard = Guid.NewGuid();
        w.Interests.Add(key, StampWorld.Interest(standard, T0.AddDays(-1)));
        var item = Arrival(key, false);
        w.Library.RaiseAdded(item);
        await Run(w, 0, 45);
        Assert.False(w.Store.Seen(item.Id, item.Sources[0].Identity));
        Assert.Empty(w.Store.FactsFor(item.Id));
        Assert.Null(w.Store.EditionArrival(Parts(item, "std")));
        Assert.Null(w.Store.EditionArrival(Parts(item, "4k")));
        Assert.Equal(0, Pending(w));

        w.Library.Put(Probed(item, 1920, 1080));                               // no ItemUpdated this time
        await Run(w, 45, 52);
        Assert.Equal(standard, Assert.Single(News(w, item.Id)).UserId);
        Assert.Equal(T0, w.Store.EditionArrival(Parts(item, "std")));
    }

    // A file removed before Jellyfin read it: its content arrived (a renamed replacement is no first arrival), but no
    // edition is recorded for it.
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AnUnprobedSourceRemovedKeepsItsContentArrivalButRecordsNoEdition(bool episode)
    {
        using var w = new StampWorld();
        await w.Feeder.TickAsync(CancellationToken.None);
        var key = episode ? StampWorld.Show(78875) : StampWorld.Movie(606);
        var item = Arrival(key, episode);
        w.Library.RaiseAdded(item);
        w.Now = T0.AddMinutes(1);
        w.Library.RaiseRemoved(item);
        await w.Feeder.TickAsync(CancellationToken.None);
        Assert.Null(w.Store.EditionArrival(Parts(item, "std")));
        Assert.Null(w.Store.EditionArrival(Parts(item, "4k")));
        Assert.Equal(T0, w.Store.FirstContentArrival(Parts(item, "std")));

        var known = Arrival(key, episode, 1920, 1080) with { Id = Guid.NewGuid() };
        w.Library.RaiseAdded(known);
        w.Now = T0.AddMinutes(2);
        w.Library.RaiseRemoved(known);
        Assert.NotNull(w.Store.EditionArrival(Parts(known, "std")));            // control: a probed removal keeps its edition
    }

    // The standard edition prefers a source KNOWN not to be 4K: a source with unknown dimensions (null or 0) is never
    // taken for one.
    [Theory]
    [InlineData(null, null)]
    [InlineData(0, 0)]
    public void AStandardEditionPrefersASourceKnownNotToBeFourKOverAnUnreadOne(int? width, int? height)
    {
        var item = Guid.NewGuid();
        var unread = new JfSource { SourceId = Guid.NewGuid(), ItemId = item, Width = width, Height = height, Path = "/m/unread.mkv" };
        var hd = new JfSource { SourceId = Guid.NewGuid(), ItemId = item, Width = 1920, Height = 1080, Path = "/m/hd.mkv" };
        var view = new Mock<IArrJellyfinView>();
        view.Setup(v => v.Sources(item, It.IsAny<StatusViewer>(), It.IsAny<bool>())).Returns(new[] { unread, hd });
        foreach (var needsNonFourK in new[] { false, true })
        {
            var config = new Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration { ArrStandardNeedsNonFourK = needsNonFourK };
            var editions = new EditionAvailability(view.Object, () => config, (_, _) => Array.Empty<JfCopy>());
            var hits = editions.Movie(new StatusViewer { UserId = Guid.NewGuid() }, new[] { new JfCopy { ItemId = item, Visible = true } }, Edition.Standard);
            Assert.Equal(hd.SourceId, hits[0].Source.SourceId);
            Assert.Equal(needsNonFourK ? 1 : 2, hits.Count);                    // with the switch, the unread one never qualifies
            Assert.DoesNotContain(editions.Movie(new StatusViewer { UserId = Guid.NewGuid() }, new[] { new JfCopy { ItemId = item, Visible = true } }, Edition.FourK),
                h => h.Source.SourceId == unread.SourceId);
        }
    }
}
