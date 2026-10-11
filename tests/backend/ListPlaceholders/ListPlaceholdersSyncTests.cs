using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Sources;
using static JE.Tests.FakeImportLookup;
using static JE.Tests.ListPlaceholdersHarness;

namespace JE.Tests;

// Linked lists (5c, F1–F3): link/unlink, import provenance, and sync semantics against the in-memory Jellyfin.
[Collection("Plugin singleton")]
public class ListPlaceholdersSyncTests
{
    private static readonly CancellationToken None = CancellationToken.None;
    private const string Url = "https://mdblist.com/lists/me/dc";

    private sealed class World : IDisposable
    {
        public ListPlaceholdersHarness H { get; }
        public User Owner { get; }
        public FakeListHost.FakeList List { get; }
        public Guid InLibrary { get; }

        /// <param name="collection">Link a collection instead of a playlist.</param>
        /// <param name="realLibrary">Library lookups through the production adapter over the fake Jellyfin.</param>
        public World(bool collection = false, bool realLibrary = false)
        {
            H = new ListPlaceholdersHarness(realLibrary: realLibrary);
            H.Plugin.Plugin.Configuration.ListPlaceholdersSyncEnabled = true;
            Owner = H.NewUser("owner");
            List = collection ? H.Host.AddCollection() : H.Host.AddPlaylist(Owner);
            InLibrary = H.Host.AddItem(tmdb: 862);
            H.Library.Matches[("movie", 862)] = new LibraryMatch(InLibrary, "movie", Array.Empty<Guid>(), true);
            foreach (var id in new[] { 1, 2, 3, 4, 5, 862 })
            {
                H.Lookup.Details[("movie", id)] = new TitleDetails(FakeImportLookup.Movie(id, "Movie " + id, "2020-01-01"), null, null, "Released", null, Array.Empty<SeasonFacts>());
            }

            var show = Tv(110492, "Peacemaker", "2022-01-13");
            H.Lookup.AddShow(show, new SeasonFacts(1, 8, "2022-01-13", "Season 1"));
        }

        public ListAccess Access => H.AccessFor(List, Owner);

        public string Id => Access.ListIdN;

        public ListDoc Doc => H.Store.Load(Id)!;

        public void Source(params SourceItem[] items) => H.Fetcher.Items = items.ToList();

        public static SourceItem M(int tmdb) => new("movie", tmdb, null, null, "Movie " + tmdb, 2020, null, null, null);

        public async Task Link(bool removeDropped = false)
        {
            var outcome = await H.Sources.LinkAsync(Access, new LinkSourceRequest { Url = Url, SyncEnabled = true, RemoveDropped = removeDropped }, None);
            Assert.Equal(200, outcome.StatusCode);
        }

        public Task<SourceSyncResultDto> Sync() => H.Sources.SyncAsync(Id, background: true, None);

        public List<string> Titles() => Doc.Order.Select(t => ListPlaceholderOrder.PlaceholderIdOf(t) is { } id ? Doc.Items.First(p => p.Id == id).Title : "REAL").ToList();

        public void Dispose() => H.Dispose();
    }

    [Fact]
    public async Task TheFirstSyncAddsEverythingInSourceOrderWithProvenance()
    {
        using var w = new World();
        w.Source(World.M(1), World.M(862), new SourceItem("tv", 110492, null, 391153, "Peacemaker", 2022, 1, null, "season one"), World.M(2));
        await w.Link();

        var result = await w.Sync();

        Assert.Equal(("ok", 4), (result.State, result.Added));
        Assert.Equal(new[] { "Movie 1", "REAL", "Peacemaker", "Movie 2" }, w.Titles());
        Assert.Equal(new[] { w.InLibrary }, w.H.Host.Resolved(w.List.Info.Id));
        var source = w.Doc.Source!;
        Assert.Equal(4, source.Owned.Count);
        Assert.Equal(new[] { w.InLibrary.ToString("N") }, source.Owned["movie|862||"].ItemIds);
        var season = w.Doc.Items.Single(p => p.Kind == PlaceholderKinds.Season);
        Assert.Equal(("tv|110492|1|", 1, 8, "season one"), (season.SourceKey, season.SeasonNumber!.Value, season.EpisodeTotal!.Value, season.Note));
        Assert.Equal(new[] { "movie|1||", "movie|862||", "tv|110492|1|", "movie|2||" }, source.LastSnapshotKeys);
        Assert.Equal(result.Message, source.LastSyncResult);
        Assert.Equal(("ok", 4, 0, false), (source.LastSync!.State, source.LastSync.Added, source.LastSync.Removed, source.LastSync.Partial));
        Assert.Equal(4, (await w.H.Service.GetViewAsync(w.Access, None)).Source!.LastSync!.Added); // structured, for localised display
        Assert.Contains(w.H.Fetcher.Calls, c => c.Fresh && c.Provider == "mdblist");

        // Nothing changed upstream: nothing happens (and nothing is resolved again).
        var calls = w.H.Lookup.Log.Count;
        var again = await w.Sync();
        Assert.Equal((0, 0), (again.Added, again.Removed));
        Assert.Equal(calls, w.H.Lookup.Log.Count);
    }

    [Fact]
    public async Task NewEntriesAreInsertedInSourceOrderAndDroppedOnesRemovedOnlyIfTheSyncAddedThem()
    {
        using var w = new World();
        w.Source(World.M(1), World.M(2), World.M(862));
        await w.Link(removeDropped: true);
        await w.Sync();
        // An editor adds "Movie 4" by hand; it is also in the source later: present, never owned.
        var mine = Ok<ApplyResultDto>(await w.H.Service.AddPlaceholdersAsync(w.Access, new[] { Movie(4) }, null, null, null, None));
        Assert.Single(mine.Added);

        w.Source(World.M(2), World.M(3), World.M(4));
        var result = await w.Sync();

        Assert.Equal(("ok", 1, 2), (result.State, result.Added, result.Removed));
        // Ordered insertion: Movie 3 goes right after its preceding source entry (Movie 2), not at the end.
        Assert.Equal(new[] { "Movie 2", "Movie 3", "Movie 4" }, w.Titles());
        Assert.Empty(w.H.Host.Resolved(w.List.Info.Id)); // the sync-added real item left the source: removed
        Assert.Equal(new[] { w.InLibrary }, w.H.Remover.Removed);
        Assert.False(w.Doc.Source!.Owned.ContainsKey("movie|4||"));

        // Hand-added entries survive when they leave the source; they are reported as kept.
        w.Source(World.M(2), World.M(3));
        var kept = await w.Sync();
        Assert.Equal((0, 0), (kept.Added, kept.Removed));
        Assert.Contains("Movie 4", w.Titles());

        // An entry the sync removed comes back when the source adds it again (no tombstone).
        w.Source(World.M(2), World.M(3), World.M(1));
        Assert.Equal(1, (await w.Sync()).Added);
        Assert.Equal(new[] { "Movie 2", "Movie 3", "Movie 1", "Movie 4" }, w.Titles());
    }

    // R5-4: a swap-in interrupted after Jellyfin added the item leaves its intent on disk. A sync that runs before the
    // next swap pass settles it first, so the item is owned by the placeholder's source key and leaves with it.
    [Fact]
    public async Task AnInterruptedSwapIsSettledBeforeTheSyncDropsItsPlaceholder()
    {
        using var w = new World();
        w.Source(World.M(5));
        await w.Link(removeDropped: true);
        await w.Sync();
        var placeholder = w.Doc.Items.Single();
        var arrived = w.H.Host.AddItem(tmdb: 5);
        using (await w.H.Store.LockAsync(w.Id))
        {
            var doc = w.H.Store.LoadForUpdate(w.Id, ListKinds.Playlist);
            doc.Intents.Add(new SwapIntent { PhId = placeholder.Id, ItemIds = { arrived.ToString("N") }, OccurrenceCountsBefore = { [arrived.ToString("N")] = 0 }, CreatedAt = "x1" });
            w.H.Store.Save(doc);
        }

        w.List.Raw.Add(new RawEntry(arrived, true)); // Jellyfin inserted it; the pass threw before saving

        w.Source(World.M(1));
        var result = await w.Sync();

        Assert.Equal("ok", result.State);
        Assert.Empty(w.Doc.Intents);
        Assert.DoesNotContain(arrived, w.H.Host.Resolved(w.List.Info.Id));
        Assert.Contains(arrived, w.H.Remover.Removed);
        Assert.False(w.Doc.Source!.Owned.ContainsKey("movie|5||"));
        Assert.Equal(new[] { "Movie 1" }, w.Titles());
    }

    [Fact]
    public async Task WithoutRemoveDroppedNothingIsRemoved()
    {
        using var w = new World();
        w.Source(World.M(1), World.M(862));
        await w.Link(removeDropped: false);
        await w.Sync();
        w.Source(World.M(2));
        var result = await w.Sync();
        Assert.Equal((1, 0, 2), (result.Added, result.Removed, result.Kept));
        Assert.Equal(new[] { "Movie 1", "REAL", "Movie 2" }, w.Titles());
    }

    [Fact]
    public async Task EditorRemovalsAreRespectedForPlaceholdersAndRealItems()
    {
        using var w = new World();
        w.Source(World.M(1), World.M(862), World.M(2));
        await w.Link();
        await w.Sync();
        var placeholder = w.Doc.Items.Single(p => p.TmdbId == 1);
        var deleted = await w.H.Service.DeleteAsync(w.Access, placeholder.Id, w.Doc.Rev, null, None);
        Assert.Equal(200, deleted.StatusCode);
        w.H.Host.Lists[w.List.Info.Id].Raw.Clear(); // an editor removed Toy Story in Jellyfin itself

        // The list now forgets the snapshot (as if the source re-ordered everything): still nothing comes back.
        var doc = w.H.Store.LoadForUpdate(w.Id, ListKinds.Playlist);
        doc.Source!.LastSnapshotKeys.Clear();
        w.H.Store.Save(doc);
        var result = await w.Sync();

        Assert.Equal(0, result.Added);
        Assert.Equal(new[] { "Movie 2" }, w.Titles());
        Assert.True(w.Doc.Source!.UserRemovedKeys.ContainsKey("movie|1||"));
        Assert.True(w.Doc.Source.UserRemovedKeys.ContainsKey("movie|862||"));
    }

    [Fact]
    public async Task ARealItemThatOccursTwiceIsKeptAndReported()
    {
        using var w = new World();
        w.Source(World.M(862));
        await w.Link(removeDropped: true);
        await w.Sync();
        w.H.Host.Lists[w.List.Info.Id].Raw.Add(new RawEntry(w.InLibrary, true)); // a second copy added by hand
        w.Source(World.M(1));

        var result = await w.Sync();

        Assert.Equal((1, 0, 1), (result.Added, result.Removed, result.Kept));
        Assert.Equal(2, w.H.Host.Resolved(w.List.Info.Id).Count(id => id == w.InLibrary));
        Assert.Empty(w.H.Remover.Removed);
    }

    [Fact]
    public async Task DuplicatesPartialAndFailedFetchesNeverRemoveAnything()
    {
        using var w = new World();
        w.Source(World.M(1), World.M(2));
        await w.Link(removeDropped: true);
        await w.Sync();

        w.Source(World.M(3), World.M(3));
        w.H.Fetcher.Truncated = true;
        var partial = await w.Sync();
        Assert.Equal((1, 0), (partial.Added, partial.Removed)); // duplicates added once, nothing removed
        Assert.Contains("1 duplicates ignored", partial.Message, StringComparison.Ordinal);
        Assert.Contains("only the first 1000", partial.Message, StringComparison.Ordinal);
        Assert.Equal(new[] { "Movie 1", "Movie 2", "Movie 3" }, w.Titles());

        w.H.Fetcher.Truncated = false;
        w.H.Fetcher.FailCode = "not_found";
        var rev = w.Doc.Rev;
        var failed = await w.Sync();
        Assert.Equal("failed", failed.State);
        Assert.Equal(new[] { "Movie 1", "Movie 2", "Movie 3" }, w.Titles());
        Assert.StartsWith("Couldn't read the source", w.Doc.Source!.LastSyncResult, StringComparison.Ordinal);
        Assert.Equal(rev + 1, w.Doc.Rev); // only the result was recorded
    }

    [Fact]
    public async Task UnresolvedEntriesAreRetriedOnTheNextSync()
    {
        using var w = new World();
        w.Source(World.M(1), World.M(99));
        await w.Link();
        var first = await w.Sync();
        Assert.Equal((1, 1), (first.Added, first.Unresolved));
        Assert.DoesNotContain("movie|99||", w.Doc.Source!.LastSnapshotKeys);

        w.H.Lookup.Details[("movie", 99)] = new TitleDetails(FakeImportLookup.Movie(99, "Late", "2026-01-01"), null, null, "Released", null, Array.Empty<SeasonFacts>());
        Assert.Equal(1, (await w.Sync()).Added);
        Assert.Contains("Late", w.Titles());
    }

    [Fact]
    public async Task WithoutSeerrNothingIsSynced()
    {
        using var w = new World();
        w.Source(World.M(1));
        await w.Link();
        w.H.Lookup.IsConfigured = false;
        var result = await w.Sync();
        Assert.Equal("failed", result.State);
        Assert.Empty(w.Doc.Items);
        Assert.Empty(w.Doc.Source!.LastSnapshotKeys);
        Assert.Contains("Seerr", w.Doc.Source.LastSyncResult, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ALinkThatLostItsEditorPausesAndAChangedLinkAbortsTheApply()
    {
        using var w = new World();
        w.Source(World.M(1));
        var stranger = w.H.NewUser("stranger");
        await w.Link();
        var doc = w.H.Store.LoadForUpdate(w.Id, ListKinds.Playlist);
        doc.Source!.LinkedByUserId = stranger.Id.ToString("N");
        w.H.Store.Save(doc);

        var paused = await w.Sync();
        Assert.Equal(("paused", ListSourceService.LinkerCannotEdit), (paused.State, paused.Code));
        Assert.Equal(ListSourceService.LinkerCannotEdit, w.Doc.Source!.PausedCode);
        Assert.Equal(("paused", ListSourceService.LinkerCannotEdit), (w.Doc.Source.LastSync!.State, w.Doc.Source.LastSync.Code));
        Assert.Contains("can no longer edit", w.Doc.Source.PausedReason, StringComparison.Ordinal);
        Assert.DoesNotContain("stranger", w.Doc.Source.PausedReason, StringComparison.Ordinal); // every viewer sees it: no user names
        Assert.Empty(w.Doc.Items);
        Assert.Equal("paused", (await w.Sync()).State);

        // Re-linking clears the pause; a link change while syncing aborts the apply.
        await w.Link();
        Assert.Null(w.Doc.Source!.PausedCode);
        w.H.Lookup.Delay = TimeSpan.FromMilliseconds(200);
        var running = w.Sync();
        await Task.Delay(50);
        await w.Link(); // generation bump while the sync is resolving
        var result = await running;
        Assert.Equal("failed", result.State);
        Assert.Empty(w.Doc.Items);
    }

    [Fact]
    public async Task ScheduledSyncRunsOnlyActiveLinksAndTheTaskRespectsTheSetting()
    {
        using var w = new World();
        w.Source(World.M(1));
        await w.Link();
        var other = w.H.Host.AddPlaylist(w.Owner);
        var otherAccess = w.H.AccessFor(other, w.Owner);
        await w.H.Sources.LinkAsync(otherAccess, new LinkSourceRequest { Url = Url, SyncEnabled = false }, None);

        var task = new Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks.ListPlaceholdersSyncTask(w.H.Sources, w.H.Plugin.Core.Logger);
        w.H.Plugin.Plugin.Configuration.ListPlaceholdersSyncEnabled = false;
        await task.ExecuteAsync(new Progress<double>(), None);
        Assert.Empty(w.Doc.Items);

        w.H.Plugin.Plugin.Configuration.ListPlaceholdersSyncEnabled = true;
        await task.ExecuteAsync(new Progress<double>(), None);
        Assert.Single(w.Doc.Items);
        Assert.Null(w.H.Store.Load(otherAccess.ListIdN)!.Source!.LastSyncAt); // sync off for that link
        Assert.Equal("JellyfinEnhancedListPlaceholdersSync", task.Key);
        Assert.Equal(TimeSpan.FromHours(12).Ticks, Assert.Single(task.GetDefaultTriggers()).IntervalTicks);
    }

    [Fact]
    public async Task LinkingValidatesUrlsReplaysAndUnlinkKeepsEntries()
    {
        using var w = new World();
        var letterboxd = await w.H.Sources.LinkAsync(w.Access, new LinkSourceRequest { Url = "https://letterboxd.com/a/list/b/" }, None);
        Error(letterboxd, 400, "letterboxd_unsupported");
        w.H.Fetcher.FailCode = "not_found";
        Error(await w.H.Sources.LinkAsync(w.Access, new LinkSourceRequest { Url = Url }, None), 404, "not_found");
        w.H.Fetcher.FailCode = null;

        var first = Ok<ListViewDto>(await w.H.Sources.LinkAsync(w.Access, new LinkSourceRequest { RequestId = "link-1", Url = Url + "/json", RemoveDropped = true }, None));
        Assert.Equal((Url, true, true), (first.Source!.Url, first.Source.SyncEnabled, first.Source.RemoveDropped));
        var replay = await w.H.Sources.LinkAsync(w.Access, new LinkSourceRequest { RequestId = "link-1", Url = "https://mdblist.com/lists/other/x" }, None);
        Assert.NotNull(replay.RawJson);
        Assert.Equal(Url, w.Doc.Source!.Url);
        Assert.Equal(w.Owner.Id.ToString("N"), w.Doc.Source.LinkedByUserId);

        w.Source(World.M(1));
        await w.Sync();
        var unlinked = Ok<ListViewDto>(await w.H.Sources.UnlinkAsync(w.Access, null, None));
        Assert.Null(unlinked.Source);
        Assert.Single(unlinked.Placeholders);
        Error(await w.H.Sources.SyncNowAsync(w.Access, null, None), 404, "no_source");
    }

    [Fact]
    public async Task SyncNowReturnsTheResultWithTheViewAndReplays()
    {
        using var w = new World();
        w.Source(World.M(1));
        await w.Link();
        var outcome = await w.H.Sources.SyncNowAsync(w.Access, "sync-1", None);
        var result = Ok<SourceSyncResultDto>(outcome);
        Assert.Equal((1, 1), (result.Added, result.View!.Placeholders.Count));
        w.Source(World.M(1), World.M(2));
        var replay = await w.H.Sources.SyncNowAsync(w.Access, "sync-1", None);
        Assert.NotNull(replay.RawJson);
        Assert.Single(w.Doc.Items);
    }

    [Fact]
    public async Task AnImportFromAUrlLinksTheListAndRecordsWhatItAddedInTheSameWrite()
    {
        using var w = new World();
        var p1 = Movie(1);
        p1.SourceKey = "movie|1||";
        var entries = new List<ApplyEntry> { new(0, null, p1), new(1, w.InLibrary, null) };
        var keys = new Dictionary<int, IReadOnlyList<string>> { [0] = new[] { "movie|1||" }, [1] = new[] { "movie|862||" } };
        var spec = new SourceLinkSpec("mdblist", Url, "mdblist", "DC", SyncEnabled: true, RemoveDropped: true);
        // The fetched list had a third entry that the editor skipped in review.
        var hooks = ListSourceService.ImportHooks(spec, w.Owner.Id.ToString("N"), keys, new[] { "movie|1||", "movie|862||", "movie|2||", "bogus" });

        var applied = Ok<ApplyResultDto>(await w.H.Service.ApplyAsync(w.Access, entries, null, null, "import-1", None, hooks));

        Assert.Equal(1, applied.View!.Rev); // one write
        var source = w.Doc.Source!;
        Assert.Equal((Url, "mdblist", "DC", true), (source.Url, source.Provider, source.Title, source.RemoveDropped));
        Assert.Equal(p1.Id, source.Owned["movie|1||"].PhId);
        Assert.Equal(new[] { w.InLibrary.ToString("N") }, source.Owned["movie|862||"].ItemIds);
        Assert.True(source.UserRemovedKeys.ContainsKey("movie|2||"));
        Assert.Equal(new[] { "movie|1||", "movie|862||", "movie|2||" }, source.LastSnapshotKeys);

        // The skipped entry stays skipped on the next sync.
        w.Source(World.M(1), World.M(862), World.M(2));
        Assert.Equal(0, (await w.Sync()).Added);
    }

    [Fact]
    public async Task AFullListStopsAddingAndSaysSo()
    {
        using var w = new World();
        await w.Link();
        var doc = w.H.Store.LoadForUpdate(w.Id, ListKinds.Playlist);
        for (var i = 0; i < ListPlaceholderStore.MaxPlaceholders - 1; i++)
        {
            var filler = Movie(100_000 + i);
            doc.Items.Add(filler);
            doc.Order.Add(P(filler.Id));
        }

        w.H.Store.Save(doc);
        w.Source(World.M(1), World.M(2));

        var result = await w.Sync();

        Assert.Equal((1, true), (result.Added, result.ListFull));
        Assert.Contains("list full", result.Message, StringComparison.Ordinal);
        Assert.Equal(ListPlaceholderStore.MaxPlaceholders, w.Doc.Items.Count);
        Assert.DoesNotContain("movie|2||", w.Doc.Source!.LastSnapshotKeys); // retried once there is room
    }

    [Fact]
    public async Task ARetriedImportWithTheSameRequestIdIsReplayedNotAppliedTwice()
    {
        using var w = new World();
        var spec = new SourceLinkSpec("mdblist", Url, "mdblist", null, SyncEnabled: true, RemoveDropped: false);
        ApplyHooks Hooks() => ListSourceService.ImportHooks(spec, w.Owner.Id.ToString("N"), new Dictionary<int, IReadOnlyList<string>> { [0] = new[] { "movie|1||" } }, new[] { "movie|1||" });
        var first = Movie(1);
        Ok<ApplyResultDto>(await w.H.Service.ApplyAsync(w.Access, new[] { new ApplyEntry(0, null, first) }, null, null, "import-x", None, Hooks()));
        var generation = w.Doc.Source!.Generation;

        var retry = Movie(1);
        var replay = await w.H.Service.ApplyAsync(w.Access, new[] { new ApplyEntry(0, null, retry) }, null, null, "import-x", None, Hooks());

        Assert.NotNull(replay.RawJson);
        Assert.Single(w.Doc.Items);
        Assert.Equal(generation, w.Doc.Source!.Generation);
        Assert.Equal(first.Id, w.Doc.Source.Owned["movie|1||"].PhId);
    }

    [Fact]
    public async Task CollectionsGetRealItemsForLibraryTitles()
    {
        using var w = new World(collection: true);
        var admin = w.H.NewUser("admin", admin: true);
        w.Source(World.M(862), World.M(1));
        var access = w.H.AccessFor(w.List, admin);
        await w.H.Sources.LinkAsync(access, new LinkSourceRequest { Url = Url }, None);
        Assert.Equal(2, (await w.Sync()).Added);
        Assert.Equal(new[] { w.InLibrary }, w.H.Host.Resolved(w.List.Info.Id));
        Assert.Single(w.H.Store.Load(access.ListIdN)!.Items);
    }

    [Fact]
    public async Task AUrlImportThatFailsPartWayOwnsWhatLandedSoTheRetryAndLaterSyncsTreatItAsImported()
    {
        using var w = new World();
        var spec = new SourceLinkSpec("mdblist", Url, "mdblist", null, SyncEnabled: true, RemoveDropped: true);
        // "movie|3||" was skipped in review.
        var snapshot = new[] { "movie|1||", "movie|862||", "movie|2||", "movie|3||" };
        (List<ApplyEntry> Entries, ApplyHooks Hooks) Attempt()
        {
            var p1 = Movie(1);
            p1.SourceKey = "movie|1||";
            var p2 = Movie(2);
            p2.SourceKey = "movie|2||";
            var entries = new List<ApplyEntry> { new(0, null, p1), new(1, w.InLibrary, null), new(2, null, p2) };
            var keys = new Dictionary<int, IReadOnlyList<string>> { [0] = new[] { "movie|1||" }, [1] = new[] { "movie|862||" }, [2] = new[] { "movie|2||" } };
            return (entries, ListSourceService.ImportHooks(spec, w.Owner.Id.ToString("N"), keys, snapshot));
        }

        w.H.Host.BeforeAdd = (_, _, _) => throw new InvalidOperationException("boom");
        var first = Attempt();
        Error(await w.H.Service.ApplyAsync(w.Access, first.Entries, null, null, "import-f", None, first.Hooks), 500, "list_update_failed");

        // The saved placeholders are owned by the (now linked) source; the real item never landed and stays new.
        var source = w.Doc.Source!;
        Assert.Equal(2, w.Doc.Items.Count);
        Assert.Equal(new[] { "movie|1||", "movie|2||" }, source.Owned.Keys.Order(StringComparer.Ordinal));
        Assert.DoesNotContain("movie|862||", source.LastSnapshotKeys);
        Assert.False(source.UserRemovedKeys.ContainsKey("movie|862||"));
        Assert.True(source.UserRemovedKeys.ContainsKey("movie|3||"));
        Assert.Equal(("failed", "apply_failed", 2), (source.LastSync!.State, source.LastSync.Code, source.LastSync.Added));

        // The same-requestId retry re-applies: the placeholders are duplicates now but stay owned.
        w.H.Host.BeforeAdd = null;
        var retry = Attempt();
        var applied = Ok<ApplyResultDto>(await w.H.Service.ApplyAsync(w.Access, retry.Entries, null, null, "import-f", None, retry.Hooks));
        Assert.Equal(new[] { "duplicate", "duplicate" }, applied.Skipped.Select(s => s.Reason));
        source = w.Doc.Source!;
        Assert.Equal(new[] { "movie|1||", "movie|2||", "movie|862||" }, source.Owned.Keys.Order(StringComparer.Ordinal));
        Assert.Equal("imported", source.LastSync!.State);

        // "Movie 1" leaves the source: removeDropped removes it (imported, not hand-added); nothing is re-added.
        w.Source(World.M(862), World.M(2), World.M(3));
        var result = await w.Sync();
        Assert.Equal((0, 1), (result.Added, result.Removed));
        Assert.Equal(new[] { "Movie 2", "REAL" }, w.Titles());
    }

    [Fact]
    public async Task ASyncThatFailsPartWayOwnsThePlaceholdersItSaved()
    {
        using var w = new World();
        w.Source(World.M(1), World.M(862));
        await w.Link(removeDropped: true);
        w.H.Host.BeforeAdd = (_, _, _) => throw new InvalidOperationException("boom");

        var failed = await w.Sync();

        Assert.Equal(("failed", "apply_failed"), (failed.State, failed.Code));
        Assert.Equal(new[] { "movie|1||" }, w.Doc.Source!.Owned.Keys);
        // The next sync adds only what is missing, and a later drop removes the placeholder the failed sync saved.
        w.H.Host.BeforeAdd = null;
        Assert.Equal(1, (await w.Sync()).Added);
        w.Source(World.M(862));
        Assert.Equal(1, (await w.Sync()).Removed);
        Assert.Equal(new[] { "REAL" }, w.Titles());
    }

    // ── Review round ────────────────────────────────────────────────────

    [Fact]
    public async Task JoinedSyncNowCallersEachGetTheirOwnView()
    {
        using var w = new World();
        var editor = w.H.NewUser("editor");
        w.List.Info = w.List.Info with { Shares = new[] { new ListShare(editor.Id, true) } };
        w.Source(World.M(1), World.M(862));
        await w.Link();
        await w.Sync();
        w.H.Host.Hide(w.InLibrary, editor); // the editor's parental controls hide the real item

        w.Source(World.M(1), World.M(862), World.M(2));
        w.H.Lookup.Delay = TimeSpan.FromMilliseconds(200);
        var ownerCall = w.H.Sources.SyncNowAsync(w.Access, "owner-sync", None);
        var editorAccess = w.H.AccessFor(w.List, editor);
        var editorCall = w.H.Sources.SyncNowAsync(editorAccess, "editor-sync", None);
        var ownerResult = Ok<SourceSyncResultDto>(await ownerCall);
        var editorResult = Ok<SourceSyncResultDto>(await editorCall);

        Assert.NotSame(ownerResult, editorResult);
        // One sync, shared by both; the editor doesn't see every entry, so gets no counts (A2).
        Assert.Equal((1, 0, true), (ownerResult.Added, editorResult.Added, editorResult.CountsHidden));
        var hidden = E(w.InLibrary);
        Assert.Contains(hidden, ownerResult.View!.Order!);
        Assert.DoesNotContain(hidden, editorResult.View!.Order!);
        var replay = await w.H.Sources.SyncNowAsync(editorAccess, "editor-sync", None);
        Assert.DoesNotContain(w.InLibrary.ToString("N"), replay.RawJson!, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ALinkerWhoLosesEditRightsWhileTheSyncResolvesPausesItInsteadOfApplying()
    {
        using var w = new World();
        var editor = w.H.NewUser("editor");
        w.List.Info = w.List.Info with { Shares = new[] { new ListShare(editor.Id, true) } };
        var editorAccess = w.H.AccessFor(w.List, editor);
        w.Source(World.M(1), World.M(2));
        Ok<ListViewDto>(await w.H.Sources.LinkAsync(editorAccess, new LinkSourceRequest { Url = Url, SyncEnabled = true }, None));

        // Revoked while resolving: caught by the check after the resolve.
        w.H.Lookup.Delay = TimeSpan.FromMilliseconds(200);
        var running = w.Sync();
        await Task.Delay(50);
        w.List.Info = w.List.Info with { Shares = Array.Empty<ListShare>() };
        var paused = await running;
        Assert.Equal(("paused", ListSourceService.LinkerCannotEdit), (paused.State, paused.Code));
        Assert.Empty(w.Doc.Items);

        // Revoked while the apply waits for the list lock: caught by the precondition under the lock.
        w.List.Info = w.List.Info with { Shares = new[] { new ListShare(editor.Id, true) } };
        Ok<ListViewDto>(await w.H.Sources.LinkAsync(editorAccess, new LinkSourceRequest { Url = Url, SyncEnabled = true }, None));
        w.H.Lookup.Delay = TimeSpan.Zero;
        var held = await w.H.Store.LockAsync(w.Id, None);
        var blocked = w.Sync();
        var waited = 0;
        while (!w.H.Lookup.Log.Contains("details:movie/2") && waited++ < 100)
        {
            await Task.Delay(20);
        }

        await Task.Delay(200);
        Assert.False(blocked.IsCompleted);
        w.List.Info = w.List.Info with { Shares = Array.Empty<ListShare>() };
        held.Dispose();
        var underLock = await blocked;
        Assert.Equal(("paused", ListSourceService.LinkerCannotEdit), (underLock.State, underLock.Code));
        Assert.Empty(w.Doc.Items);
        Assert.Empty(w.H.Host.Resolved(w.List.Info.Id));
        Assert.Equal(ListSourceService.LinkerCannotEdit, w.Doc.Source!.PausedCode);
    }

    [Fact]
    public async Task AnUnlinkAndRelinkWithinOneSecondStillAbortsTheOldSync()
    {
        var now = DateTime.UtcNow;
        var first = ListSourceService.NextGeneration(0, now);
        Assert.True(ListSourceService.NextGeneration(0, now) > first); // same second, no previous link: still new

        using var w = new World();
        w.Source(World.M(1));
        await w.Link();
        w.H.Lookup.Delay = TimeSpan.FromMilliseconds(200);
        var running = w.Sync();
        await Task.Delay(50);
        Ok<ListViewDto>(await w.H.Sources.UnlinkAsync(w.Access, null, None));
        await w.Link(removeDropped: true);
        var result = await running;
        Assert.Equal(("failed", "source_changed"), (result.State, result.Code));
        Assert.Empty(w.Doc.Items);
    }

    [Fact]
    public async Task SyncNowThatJoinedACancelledScheduledSyncAnswersInsteadOfFailing()
    {
        using var w = new World();
        w.Source(World.M(1));
        await w.Link();
        w.H.Lookup.Delay = TimeSpan.FromSeconds(5);
        using var stop = new CancellationTokenSource();
        var scheduled = w.H.Sources.SyncAsync(w.Id, background: true, stop.Token);
        var now = w.H.Sources.SyncNowAsync(w.Access, null, None);
        await Task.Delay(50);
        stop.Cancel();

        var outcome = await now;

        Assert.Equal(202, outcome.StatusCode);
        Assert.Equal("cancelled", Assert.IsType<SourceSyncResultDto>(outcome.Value).Code);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => scheduled);
    }

    [Fact]
    public async Task APartialFetchAddsButNeverRemovesOrReplacesTheSnapshot()
    {
        using var w = new World();
        w.Source(World.M(1), World.M(2));
        await w.Link(removeDropped: true);
        await w.Sync();

        w.Source(World.M(2), World.M(3)); // Movie 1 is missing only because the upstream answered partly
        w.H.Fetcher.Partial = true;
        var partial = await w.Sync();
        Assert.Equal((1, 0), (partial.Added, partial.Removed));
        Assert.Contains("partly", partial.Message, StringComparison.Ordinal);
        Assert.Equal(new[] { "Movie 1", "Movie 2", "Movie 3" }, w.Titles());
        Assert.Contains("movie|1||", w.Doc.Source!.LastSnapshotKeys);
        Assert.True(w.Doc.Source.LastSync!.Partial);

        w.H.Fetcher.Partial = false;
        Assert.Equal(1, (await w.Sync()).Removed); // a complete answer may remove it
        Assert.Equal(new[] { "Movie 2", "Movie 3" }, w.Titles());
    }

    // Phase 3 + 5: TV that is already in the library goes in as REAL episodes (C1) with the placeholder keeping the
    // rest; the sync owns both under the entry's key, swap-in keeps that ownership, and removeDropped removes all of it.
    [Fact]
    public async Task ASyncAddsLibraryTvAsRealEpisodesOwnsThemAndRemovesThemAllWhenTheEntryLeaves()
    {
        using var w = new World(realLibrary: true);
        var series = w.H.Host.AddSeries(tmdb: 110492, tvdb: 391153);
        var e2 = w.H.Host.AddEpisode(series, 1, 2);
        var e1 = w.H.Host.AddEpisode(series, 1, 1);
        var hand = w.H.Host.AddEpisode(series, 2, 1);
        Ok<ApplyResultDto>(await w.H.Service.ApplyAsync(w.Access, new[] { new ApplyEntry(0, hand, null) }, null, null, null, None));
        w.Source(World.M(1), new SourceItem("tv", 110492, null, 391153, "Peacemaker", 2022, 1, null, null), World.M(862));
        await w.Link(removeDropped: true);

        var result = await w.Sync();

        Assert.Equal(("ok", 5), (result.State, result.Added)); // Movie 1, E1, E2, the season placeholder, the movie
        Assert.Equal(new[] { "REAL", "Movie 1", "REAL", "REAL", "Peacemaker", "REAL" }, w.Titles());
        Assert.Equal(new[] { hand, e1, e2, w.InLibrary }, w.H.Host.Resolved(w.List.Info.Id));
        var season = w.Doc.Items.Single(p => p.Kind == PlaceholderKinds.Season);
        Assert.Equal(new[] { e1.ToString("N"), e2.ToString("N") }, season.Filled.Select(f => f.ItemId));
        var owned = w.Doc.Source!.Owned["tv|110492|1|"];
        Assert.Equal(season.Id, owned.PhId);
        Assert.Equal(new[] { e1.ToString("N"), e2.ToString("N") }, owned.ItemIds);
        Assert.Equal(new[] { w.InLibrary.ToString("N") }, w.Doc.Source.Owned["movie|862||"].ItemIds);
        Assert.Contains("tv|110492|1|", w.Doc.Source.LastSnapshotKeys);

        // E3 arrives: swap-in fills the placeholder, and the key owns the new episode too (same locked write).
        var e3 = w.H.Host.AddEpisode(series, 1, 3);
        await w.H.Swap.RunListPassAsync(w.Id, null, MetadataMode.None, None);
        Assert.Equal(new[] { hand, e1, e2, e3, w.InLibrary }, w.H.Host.Resolved(w.List.Info.Id));
        Assert.Equal(new[] { e1.ToString("N"), e2.ToString("N"), e3.ToString("N") }, w.Doc.Source!.Owned["tv|110492|1|"].ItemIds);

        // A sync with nothing new keeps all of it (no editor removal is detected).
        Assert.Equal((0, 0), ((await w.Sync()).Added, w.Doc.Source!.UserRemovedKeys.Count));

        // The season leaves the source: its placeholder and the three episodes the sync and swap-in added go; the
        // episode the editor added by hand stays.
        w.Source(World.M(1), World.M(862));
        var dropped = await w.Sync();
        Assert.Equal(4, dropped.Removed);
        Assert.Equal(new[] { hand, w.InLibrary }, w.H.Host.Resolved(w.List.Info.Id));
        Assert.DoesNotContain(w.Doc.Items, p => p.Kind == PlaceholderKinds.Season);
        Assert.False(w.Doc.Source!.Owned.ContainsKey("tv|110492|1|"));
        Assert.Empty(w.Doc.Source.UserRemovedKeys);
    }

    [Fact]
    public async Task AUrlImportOwnsWhatTheLibraryExpansionInsertedEvenWhenThePlaceholderIsNotKept()
    {
        using var w = new World(realLibrary: true);
        var series = w.H.Host.AddSeries(tmdb: 110492);
        var e1 = w.H.Host.AddEpisode(series, 1, 1);
        var e2 = w.H.Host.AddEpisode(series, 1, 2);
        var present = w.H.Host.AddEpisode(series, 1, 5);
        Ok<ApplyResultDto>(await w.H.Service.ApplyAsync(w.Access, new[] { new ApplyEntry(0, present, null) }, null, null, null, None));
        // The review sent placeholders; the apply's C1 expansion turns the in-library ones into real items.
        var movie = Movie(862);
        var both = Ph("{\"kind\":\"episodes\",\"mediaType\":\"tv\",\"tmdbId\":110492,\"title\":\"Peacemaker\",\"seasonNumber\":1,\"episodes\":[{\"s\":1,\"e\":1},{\"s\":1,\"e\":2}]}");
        var partly = Ph("{\"kind\":\"episodes\",\"mediaType\":\"tv\",\"tmdbId\":110492,\"title\":\"Peacemaker\",\"seasonNumber\":1,\"episodes\":[{\"s\":1,\"e\":5},{\"s\":1,\"e\":6}]}");
        var entries = new List<ApplyEntry> { new(0, null, movie), new(1, null, both), new(2, null, partly) };
        var keys = new Dictionary<int, IReadOnlyList<string>> { [0] = new[] { "movie|862||" }, [1] = new[] { "tv|110492|1|1" }, [2] = new[] { "tv|110492|1|5" } };
        var spec = new SourceLinkSpec("mdblist", Url, "mdblist", null, SyncEnabled: true, RemoveDropped: true);
        var hooks = ListSourceService.ImportHooks(spec, w.Owner.Id.ToString("N"), keys, keys.Values.SelectMany(k => k).ToList());

        var applied = Ok<ApplyResultDto>(await w.H.Service.ApplyAsync(w.Access, entries, null, null, "import-tv", None, hooks));

        Assert.Equal(new[] { present, w.InLibrary, e1, e2 }, w.H.Host.Resolved(w.List.Info.Id));
        Assert.Equal(new[] { partly.Id }, applied.Added); // the complete E1–E2 scope needs no placeholder
        var source = w.Doc.Source!;
        Assert.Null(source.Owned["movie|862||"].PhId);
        Assert.Equal(new[] { w.InLibrary.ToString("N") }, source.Owned["movie|862||"].ItemIds);
        Assert.Null(source.Owned["tv|110492|1|1"].PhId);
        Assert.Equal(new[] { e1.ToString("N"), e2.ToString("N") }, source.Owned["tv|110492|1|1"].ItemIds);
        // E5 was already in the list: the placeholder is owned, the episode only "present".
        Assert.Equal((partly.Id, 0), (source.Owned["tv|110492|1|5"].PhId, source.Owned["tv|110492|1|5"].ItemIds.Count));
        Assert.Equal(keys.Values.SelectMany(k => k).ToList(), source.LastSnapshotKeys);
        Assert.Empty(source.UserRemovedKeys);
        Assert.Equal(4, source.LastSync!.Added);
    }

    // Review round (F1): overlapping keys ("Show S1" + "Show S1E1", a series + its season) both own what they added; an
    // entry is removed only once every key that wants it has left the source — in either order.
    [Theory]
    [InlineData(false, true)]
    [InlineData(false, false)]
    [InlineData(true, true)]
    [InlineData(true, false)]
    public async Task OverlappingSourceKeysShareTheirEntriesSoOneLeavingKeepsWhatTheOtherStillLists(bool series, bool outerLeavesFirst)
    {
        using var w = new World(realLibrary: true);
        var show = w.H.Host.AddSeries(tmdb: 110492, tvdb: 391153);
        var e1 = w.H.Host.AddEpisode(show, 1, 1);
        var e2 = w.H.Host.AddEpisode(show, 1, 2);
        w.H.Lookup.Seasons[(110492, 1)] = Enumerable.Range(1, 8).Select(e => new EpisodeFacts(1, e, "Episode " + e, "2022-01-13")).ToList();
        var outer = series
            ? new SourceItem("tv", 110492, null, 391153, "Peacemaker", 2022, null, null, null)
            : new SourceItem("tv", 110492, null, 391153, "Peacemaker", 2022, 1, null, null);
        var inner = series
            ? new SourceItem("tv", 110492, null, 391153, "Peacemaker", 2022, 1, null, null)
            : new SourceItem("tv", 110492, null, 391153, "Peacemaker", 2022, 1, 1, null);
        var (outerKey, innerKey) = (outer.Key!, inner.Key!);
        w.Source(outer, inner);
        await w.Link(removeDropped: true);

        Assert.Equal(("ok", 0), ((await w.Sync()).State, w.Doc.Source!.LastSync!.Unresolved));
        Assert.Equal(new[] { e1, e2 }, w.H.Host.Resolved(w.List.Info.Id)); // inserted once
        Assert.Contains(e1.ToString("N"), w.Doc.Source!.Owned[outerKey].ItemIds);
        Assert.Contains(e1.ToString("N"), w.Doc.Source.Owned[innerKey].ItemIds);

        var (leaving, staying) = outerLeavesFirst ? (outerKey, inner) : (innerKey, outer);
        w.Source(staying);
        var first = await w.Sync();
        Assert.Equal("ok", first.State);
        Assert.Contains(e1, w.H.Host.Resolved(w.List.Info.Id)); // the other key still lists it
        Assert.False(w.Doc.Source!.Owned.ContainsKey(leaving));
        Assert.Contains(e1.ToString("N"), w.Doc.Source.Owned[staying.Key!].ItemIds);
        Assert.Empty(w.Doc.Source.UserRemovedKeys);
        Assert.Equal(outerLeavesFirst && !series ? new[] { e1 } : new[] { e1, e2 }, w.H.Host.Resolved(w.List.Info.Id));

        // The remaining key leaves too: now everything the sync added goes.
        w.Source(World.M(1));
        await w.Sync();
        Assert.Empty(w.H.Host.Resolved(w.List.Info.Id));
        Assert.Equal(new[] { "Movie 1" }, w.Titles());
    }

    [Fact]
    public async Task AKeyThatLaterListsAnEntryAnotherKeyAddedSharesItInsteadOfLosingIt()
    {
        using var w = new World(realLibrary: true);
        var show = w.H.Host.AddSeries(tmdb: 110492, tvdb: 391153);
        var e1 = w.H.Host.AddEpisode(show, 1, 1);
        w.H.Lookup.Seasons[(110492, 1)] = Enumerable.Range(1, 8).Select(e => new EpisodeFacts(1, e, "Episode " + e, "2022-01-13")).ToList();
        var season = new SourceItem("tv", 110492, null, 391153, "Peacemaker", 2022, 1, null, null);
        var episode = new SourceItem("tv", 110492, null, 391153, "Peacemaker", 2022, 1, 1, null);
        w.Source(season);
        await w.Link(removeDropped: true);
        await w.Sync();

        // The source adds S1E1 later: E1 is already there (added by the season key), so the new key shares it.
        w.Source(season, episode);
        await w.Sync();
        Assert.Contains(e1.ToString("N"), w.Doc.Source!.Owned[episode.Key!].ItemIds);
        Assert.Contains(episode.Key!, w.Doc.Source.LastSnapshotKeys);

        w.Source(episode);
        await w.Sync();
        Assert.Equal(new[] { e1 }, w.H.Host.Resolved(w.List.Info.Id));
    }

    // Review round (F3): the sync acts as the linker, who must still see what removeDropped would remove.
    [Fact]
    public async Task ALinkerWhoCanNoLongerSeeADroppedEntryPausesTheLinkAndNothingIsRemoved()
    {
        using var w = new World();
        w.Source(World.M(862), World.M(1));
        await w.Link(removeDropped: true);
        await w.Sync();
        w.H.Host.Hide(w.InLibrary, w.Owner); // still the owner (can edit), but no longer sees the movie

        w.Source(World.M(1), World.M(2));
        var result = await w.Sync();

        Assert.Equal(("paused", ListSourceService.LinkerCannotSee), (result.State, result.Code));
        Assert.Empty(w.H.Remover.Removed);
        Assert.Equal(new[] { w.InLibrary }, w.H.Host.Resolved(w.List.Info.Id));
        Assert.Contains("Movie 2", w.Titles()); // what was added passed the linker's own checks
        var source = w.Doc.Source!;
        Assert.Equal(ListSourceService.LinkerCannotSee, source.PausedCode);
        Assert.Equal(("paused", ListSourceService.LinkerCannotSee), (source.LastSync!.State, source.LastSync.Code));
        Assert.True(source.Owned.ContainsKey("movie|862||")); // still owned: removed once a linker who sees it syncs
        Assert.Equal("paused", (await w.Sync()).State);

        // A placeholder the linker's parental filter now hides pauses the link the same way.
        using var k = new World();
        k.Source(World.M(1), World.M(2));
        await k.Link(removeDropped: true);
        await k.Sync();
        k.Owner.MaxParentalRatingScore = 10; // without Seerr nothing can be verified: hidden (fails closed)
        k.Source(World.M(2));
        Assert.Equal(("paused", ListSourceService.LinkerCannotSee), ((await k.Sync()).State, k.Doc.Source!.PausedCode));
        Assert.Equal(2, k.Doc.Items.Count);
    }

    // Review round (A2): sync counts describe the whole list, so only callers who see every entry get them.
    [Fact]
    public async Task SyncCountsAreShownOnlyToCallersWhoSeeTheWholeList()
    {
        using var w = new World();
        var editor = w.H.NewUser("editor");
        w.List.Info = w.List.Info with { Shares = new[] { new ListShare(editor.Id, true) } };
        w.Source(World.M(862), World.M(1));
        await w.Link();
        await w.Sync();
        w.H.Host.Hide(w.InLibrary, editor);
        var editorAccess = w.H.AccessFor(w.List, editor);

        var full = (await w.H.Service.GetViewAsync(w.Access, None)).Source!;
        Assert.Null(full.CountsHidden);
        Assert.Equal(2, full.LastSync!.Added);
        Assert.NotNull(full.LastSyncResult);

        var partial = (await w.H.Service.GetViewAsync(editorAccess, None)).Source!;
        Assert.True(partial.CountsHidden);
        Assert.Equal(("ok", 0), (partial.LastSync!.State, partial.LastSync.Added));
        Assert.Null(partial.LastSyncResult);
        Assert.Equal(full.LastSyncAt, partial.LastSyncAt);

        w.Source(World.M(862), World.M(1), World.M(2));
        var now = Ok<SourceSyncResultDto>(await w.H.Sources.SyncNowAsync(editorAccess, "editor-sync", None));
        Assert.Equal(("ok", true, 0, "Synced."), (now.State, now.CountsHidden, now.Added, now.Message));
        var replay = await w.H.Sources.SyncNowAsync(editorAccess, "editor-sync", None);
        Assert.DoesNotContain("\"added\":1", replay.RawJson!, StringComparison.Ordinal);

        w.Source(World.M(862), World.M(1), World.M(2), World.M(3));
        var owner = Ok<SourceSyncResultDto>(await w.H.Sources.SyncNowAsync(w.Access, "owner-sync", None));
        Assert.Equal((1, (bool?)null), (owner.Added, owner.CountsHidden));

        // A failure's reason has no counts: everyone sees it.
        w.H.Fetcher.FailCode = "not_found";
        await w.Sync();
        var failed = (await w.H.Service.GetViewAsync(editorAccess, None)).Source!;
        Assert.Equal(("failed", "not_found"), (failed.LastSync!.State, failed.LastSync.Code));
        Assert.NotNull(failed.LastSyncResult);

        // Collections: an item the caller can't access hides the counts too.
        using var c = new World(collection: true);
        var admin = c.H.NewUser("admin", admin: true);
        var viewer = c.H.NewUser("viewer");
        c.Source(World.M(862));
        await c.H.Sources.LinkAsync(c.H.AccessFor(c.List, admin), new LinkSourceRequest { Url = Url }, None);
        Assert.Equal(("ok", 1), ((await c.Sync()).State, c.Doc.Source!.LastSync!.Added));
        Assert.Equal(new[] { c.InLibrary }, c.H.Host.Resolved(c.List.Info.Id));
        Assert.Null((await c.H.Service.GetViewAsync(c.H.AccessFor(c.List, viewer), None)).Source!.CountsHidden);
        c.H.Host.Hide(c.InLibrary, viewer);
        Assert.True((await c.H.Service.GetViewAsync(c.H.AccessFor(c.List, viewer), None)).Source!.CountsHidden);
    }
}
