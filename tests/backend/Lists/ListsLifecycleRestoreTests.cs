using System.Text.Json;
using System.Xml.Serialization;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Backup;
using MediaBrowser.Controller.Library;
using Moq;
using static JE.Tests.ListsHarness;

namespace JE.Tests;

// 4c1 lifecycle: a restore marks every list for reconciliation and reads documents fresh (JeBackupService.DataRestored
// drives it), a swap pass clears the mark, a deleted list loses its database rows, a deleted user loses their links and
// operations; and the verified swap-in events a pass records (arrivals and a TV entry's completion).
[Collection("Plugin singleton")]
public class ListsLifecycleRestoreTests
{
    private static readonly CancellationToken None = CancellationToken.None;
    private const string Past = "2020-01-01";

    private static async Task Seed(ListsHarness h, string listIdN, params Placeholder[] items)
    {
        using (await h.Store.LockAsync(listIdN))
        {
            var doc = h.Store.LoadForUpdate(listIdN, ListKinds.Playlist);
            foreach (var item in items)
            {
                doc.Items.Add(item);
                doc.Order.Add(P(item.Id));
            }

            h.Store.Save(doc);
        }
    }

    private static async Task SetReconcile(ListsHarness h, string listIdN, string? value)
    {
        using (await h.Store.LockAsync(listIdN))
        {
            var doc = h.Store.LoadForUpdate(listIdN, ListKinds.Playlist);
            doc.Reconcile = value;
            h.Store.Save(doc);
        }
    }

    private static async Task Until(Func<bool> condition)
    {
        for (var i = 0; i < 250 && !condition(); i++)
        {
            await Task.Delay(20);
        }

        Assert.True(condition());
    }

    // ── restore reconciliation ────────────────────────────────────────

    [Fact]
    public async Task AfterARestoreEveryListIsReadFreshAndMarkedAndOrphanLinksGoUntilAPassClearsTheMark()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var a = h.Host.AddPlaylist(owner);
        var b = h.Host.AddPlaylist(owner);
        var c = h.Host.AddPlaylist(owner);
        var (ia, ib, ic) = (a.Info.Id.ToString("N"), b.Info.Id.ToString("N"), c.Info.Id.ToString("N"));
        await Seed(h, ia, Movie(1));
        await Seed(h, ib, Movie(2));
        await Seed(h, ic, Movie(3));
        await SetReconcile(h, ic, "import"); // already waiting: left as it is
        var links = new ListLinks(h.Database);
        links.Add(new ListLink(ia, h.Store.Load(ia)!.Items[0].Id, owner.Id, "want-that-is-gone", null, "movie:tmdb:1", "{}", "standard"), DateTimeOffset.UtcNow);

        // The restore wrote a's document behind the store's back (another entry, a higher revision).
        var restored = h.Store.LoadForUpdate(ia, ListKinds.Playlist);
        var extra = Movie(10);
        restored.Items.Add(extra);
        restored.Order.Add(P(extra.Id));
        restored.Rev = 40;
        File.WriteAllText(Path.Combine(h.Store.DirectoryPath, ia + ".json"), JsonSerializer.Serialize(restored));
        Assert.Single(h.Store.Load(ia)!.Items); // cached

        using var lifecycle = new ListLifecycle(new Mock<ILibraryManager>().Object, h.Store, h.Host, h.Plugin.Core.Logger, links, h.Operations, h.Events);
        Assert.Equal(2, await lifecycle.ReconcileAfterRestoreAsync());

        var docA = h.Store.Load(ia)!;
        Assert.Equal(("restore", 41, 2), (docA.Reconcile, docA.Rev, docA.Items.Count));
        Assert.Contains(docA.Items, p => p.Id == extra.Id);
        Assert.Equal("restore", h.Store.Load(ib)!.Reconcile);
        Assert.Equal("import", h.Store.Load(ic)!.Reconcile);
        Assert.Empty(links.ForList(ia));

        // A pass reconciles and clears the mark (no consent: nothing is inserted).
        await h.Swap.RunListPassAsync(ia, null, MetadataMode.None, None);
        Assert.Null(h.Store.Load(ia)!.Reconcile);
        Assert.Equal("restore", h.Store.Load(ib)!.Reconcile);
        Assert.Empty(h.Host.Resolved(a.Info.Id));
    }

    // ── JeBackupService.DataRestored ──────────────────────────────────

    private static JeBackupService Backup(ListsHarness h, string dataFolder)
    {
        var configPath = Path.Combine(h.Plugin.Core.Root, "configurations", "Jellyfin.Plugin.JellyfinEnhanced.xml");
        Directory.CreateDirectory(Path.GetDirectoryName(configPath)!);
        using (var stream = File.Create(configPath))
        {
            new XmlSerializer(typeof(PluginConfiguration)).Serialize(stream, new PluginConfiguration());
        }

        return new JeBackupService(dataFolder, configPath, () => h.Plugin.Plugin.Secrets, h.Plugin.Core.Logger) { ApplyConfiguration = (_, _) => null };
    }

    private static byte[] Export(JeBackupService service)
    {
        using var ms = new MemoryStream();
        service.Export(ms, JeBackupSecrets.Exclude, null);
        return ms.ToArray();
    }

    [Fact]
    public async Task ARestoreThatWroteListDocumentsRaisesDataRestoredAndTheLifecycleReconcilesThem()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var list = h.Host.AddPlaylist(owner);
        var id = list.Info.Id.ToString("N");
        var kept = Movie(1);
        await Seed(h, id, kept);
        var service = Backup(h, h.Plugin.Core.ConfigRoot);
        var zip = Export(service);
        var backedUpRev = h.Store.Load(id)!.Rev;
        await Seed(h, id, Movie(2)); // changed after the backup

        var raised = 0;
        void Count() => Interlocked.Increment(ref raised);
        JeBackupService.DataRestored += Count;
        using var lifecycle = new ListLifecycle(new Mock<ILibraryManager>().Object, h.Store, h.Host, h.Plugin.Core.Logger, new ListLinks(h.Database), h.Operations, h.Events);
        await lifecycle.StartAsync(None);
        try
        {
            var result = service.Restore(new MemoryStream(zip), null);
            Assert.True(result.FilesRestored > 0);
            Assert.Equal(1, raised);

            // The lifecycle heard it: the restored document is read from disk and waits for reconciliation.
            await Until(() => h.Store.Load(id)?.Reconcile == "restore");
            var doc = h.Store.Load(id)!;
            Assert.Equal(new[] { kept.Id }, doc.Items.Select(p => p.Id));
            Assert.Equal(backedUpRev + 1, doc.Rev);
        }
        finally
        {
            JeBackupService.DataRestored -= Count;
            await lifecycle.StopAsync(None);
        }

        // Stopped: a later restore no longer reaches it.
        await SetReconcile(h, id, null);
        service.Restore(new MemoryStream(zip), null);
        await Task.Delay(200);
        Assert.Null(h.Store.Load(id)!.Reconcile);
    }

    [Fact]
    public void ARestoreThatWroteNoDataFileDoesNotRaiseDataRestored()
    {
        using var h = new ListsHarness();
        var empty = Path.Combine(h.Plugin.Core.Root, "empty-data");
        Directory.CreateDirectory(empty);
        var service = Backup(h, empty);
        var zip = Export(service);

        var raised = 0;
        void Count() => Interlocked.Increment(ref raised);
        JeBackupService.DataRestored += Count;
        try
        {
            var result = service.Restore(new MemoryStream(zip), null);
            Assert.Equal(0, result.FilesRestored);
            Assert.Equal(0, raised);
        }
        finally
        {
            JeBackupService.DataRestored -= Count;
        }
    }

    // ── deleted lists and users ───────────────────────────────────────

    [Fact]
    public async Task ADeletedListLosesItsLinksOperationsAndEventsButNotOtherListsRows()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var gone = Guid.NewGuid();
        var other = h.Host.AddPlaylist(owner);
        var (g, o) = (gone.ToString("N"), other.Info.Id.ToString("N"));
        await Seed(h, g, Movie(1));
        var links = new ListLinks(h.Database);
        var now = DateTimeOffset.UtcNow;
        foreach (var list in new[] { g, o })
        {
            links.Add(new ListLink(list, "p", owner.Id, "w-" + list, "op", "movie:tmdb:1", "{}", "standard"), now);
            Assert.NotNull(h.Operations.Begin(owner.Id, list, "c", "add", "f", now).Operation);
            Assert.True(h.Events.Record(list, "p", "movie", "movie:tmdb:1", "standard", new[] { "i" }, true, now));
        }

        var created = h.Operations.Begin(owner.Id, "create-playlist", "create-1", "create", "f", now).Operation!;
        h.Operations.SetList(created.Id, g, now);

        using var lifecycle = new ListLifecycle(new Mock<ILibraryManager>().Object, h.Store, h.Host, h.Plugin.Core.Logger, links, h.Operations, h.Events);
        Assert.True(await lifecycle.DeleteForRemovedListAsync(gone));

        Assert.Null(h.Store.Load(g));
        Assert.Empty(links.ForList(g));
        Assert.Single(links.ForList(o));
        Assert.False(h.Operations.Begin(owner.Id, g, "c", "add", "f", now).Replayed);
        Assert.False(h.Operations.Begin(owner.Id, "create-playlist", "create-1", "create", "f", now).Replayed);
        Assert.True(h.Operations.Begin(owner.Id, o, "c", "add", "f", now).Replayed);
        Assert.Equal(new[] { o }, h.Events.Pending().Select(e => e.ListId));

        // A list without a document still loses its rows (the sweep and the event path share it).
        links.Add(new ListLink(o, "p2", owner.Id, "w2", null, "movie:tmdb:2", "{}", "standard"), now);
        Assert.False(await lifecycle.DeleteForRemovedListAsync(other.Info.Id));
        Assert.Empty(links.ForList(o));
        Assert.Empty(h.Events.Pending());
    }

    [Fact]
    public async Task ADeletedUsersLinksAndOperationsAreRemovedAndOtherPeoplesStay()
    {
        using var h = new ListsHarness();
        var gone = h.NewUser("gone");
        var stays = h.NewUser("stays");
        const string list = "0123456789abcdef0123456789abcdef";
        var links = new ListLinks(h.Database);
        var now = DateTimeOffset.UtcNow;
        foreach (var user in new[] { gone, stays })
        {
            links.Add(new ListLink(list, "p", user.Id, "w-" + user.Id.ToString("N"), null, "movie:tmdb:1", "{}", "standard"), now);
            h.Operations.Begin(user.Id, list, "c", "add", "f", now);
        }

        var purge = new ListUserPurge(links, h.Operations, h.Plugin.Core.Logger);
        await purge.OnEvent(new Jellyfin.Data.Events.Users.UserDeletedEventArgs(gone));

        Assert.Equal(new[] { stays.Id }, links.ForList(list).Select(l => l.UserId));
        Assert.False(h.Operations.Begin(gone.Id, list, "c", "add", "f", now).Replayed);
        Assert.True(h.Operations.Begin(stays.Id, list, "c", "add", "f", now).Replayed);
    }

    // ── swap-in events ────────────────────────────────────────────────

    [Fact]
    public async Task ASwapThatInsertsAMovieRecordsOneVerifiedEvent()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        var movie = Movie(49521);
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { movie }, null, null, null, None));
        await h.Consent(access);
        Assert.Empty(h.Events.Pending());

        var arrived = h.Host.AddItem(tmdb: 49521);
        var raised = new List<ListSwapEvent>();
        h.Events.Recorded += raised.Add;
        h.Swap.NotifyItemChanged(arrived);
        await h.Swap.DrainAsync(None);

        Assert.Equal(new[] { arrived }, h.Host.Resolved(playlist.Info.Id));
        var e = Assert.Single(h.Events.Pending());
        Assert.Equal((access.ListIdN, movie.Id, "movie", "movie:tmdb:49521", "standard", true), (e.ListId, e.PlaceholderId, e.Kind, e.TitleKey, e.Edition, e.Complete));
        Assert.Equal(new[] { arrived.ToString("N") }, e.ItemIds);
        Assert.Single(raised);

        // Another pass changes nothing and records nothing.
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
        Assert.Single(h.Events.Pending());
    }

    private static string TvJson(int tmdb) =>
        $"{{\"id\":{tmdb},\"name\":\"Show\",\"firstAirDate\":\"{Past}\",\"status\":\"Ended\",\"inProduction\":false," +
        $"\"externalIds\":{{\"imdbId\":\"tt1234567\",\"tvdbId\":{tmdb + 1000}}},\"posterPath\":\"/show.jpg\"," +
        $"\"lastEpisodeToAir\":{{\"seasonNumber\":1,\"episodeNumber\":2,\"airDate\":\"{Past}\"}},\"nextEpisodeToAir\":null," +
        $"\"seasons\":[{{\"seasonNumber\":1,\"episodeCount\":2,\"airDate\":\"{Past}\"}}]}}";

    private static string SeasonJson(int season) =>
        $"{{\"seasonNumber\":{season},\"airDate\":\"{Past}\",\"posterPath\":\"/s{season}.jpg\",\"episodes\":[" +
        $"{{\"episodeNumber\":1,\"seasonNumber\":{season},\"name\":\"Episode 1\",\"airDate\":\"{Past}\"}}," +
        $"{{\"episodeNumber\":2,\"seasonNumber\":{season},\"name\":\"Episode 2\",\"airDate\":\"{Past}\"}}]}}";

    [Fact]
    public async Task ATvEntryRecordsAnEventPerArrivalAndOneCompletionEventListingEveryFilledEpisode()
    {
        using var h = new ListsHarness(seerr: true);
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        h.TvDetails[2001] = TvJson(2001);
        h.SeasonDetails[(2001, 1)] = SeasonJson(1);
        var season = Ph("{\"kind\":\"season\",\"tmdbId\":2001,\"seasonNumber\":1,\"title\":\"Show S1\"}");
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { season }, null, null, null, None));
        await h.Consent(access);
        await h.Swap.DrainAsync(None); // metadata for the new entry
        Assert.Equal(2, h.Store.Load(access.ListIdN)!.Items.Single().Expected.Count);

        var series = h.Host.AddSeries(tmdb: 2001);
        var e1 = h.Host.AddEpisode(series, 1, 1);
        h.Swap.NotifyItemChanged(e1);
        await h.Swap.DrainAsync(None);
        var first = Assert.Single(h.Events.Pending());
        Assert.Equal((season.Id, "season", false), (first.PlaceholderId, first.Kind, first.Complete));
        Assert.Equal(new[] { e1.ToString("N") }, first.ItemIds);
        Assert.Equal("tv:tvdb:3001", first.TitleKey); // the TVDB id learned from the metadata

        var e2 = h.Host.AddEpisode(series, 1, 2);
        h.Swap.NotifyItemChanged(e2);
        await h.Swap.DrainAsync(None);
        await h.Swap.DrainAsync(None); // a completion check on fresh metadata, if the arrival queued one
        Assert.Equal(new[] { e1, e2 }, h.Host.Resolved(playlist.Info.Id));
        Assert.Empty(h.Store.Load(access.ListIdN)!.Items);

        var events = h.Events.Pending();
        Assert.Equal(3, events.Count);
        Assert.Equal((false, new[] { e2.ToString("N") }.Single()), (events[1].Complete, events[1].ItemIds.Single()));
        var completion = events[2];
        Assert.True(completion.Complete);
        Assert.Equal(season.Id, completion.PlaceholderId);
        Assert.Equal(new[] { e1.ToString("N"), e2.ToString("N") }.OrderBy(x => x, StringComparer.Ordinal), completion.ItemIds);
    }
}
