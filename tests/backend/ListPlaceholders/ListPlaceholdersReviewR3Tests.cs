using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Sources;
using static JE.Tests.ListPlaceholdersHarness;

namespace JE.Tests;

// Review round 3: server-side fixes (swap recovery, posters, store index, link access).
[Collection("Plugin singleton")]
public class ListPlaceholdersReviewR3Tests
{
    private static readonly CancellationToken None = CancellationToken.None;

    // R3-3: a crash right after JE added an episode to a collection leaves the intent on disk. An episode imported
    // before the next pass is not in that intent; recovery must not count it as present (it never went into the
    // collection), or the placeholder retires with the episode missing.
    [Fact]
    public async Task AnEpisodeThatArrivedAfterACrashedCollectionSwapStillGoesIn()
    {
        using var h = new ListPlaceholdersHarness();
        var admin = h.NewUser("admin", admin: true);
        var collection = h.Host.AddCollection();
        var access = h.AccessFor(collection, admin);
        var placeholder = Ph("{\"kind\":\"episodes\",\"tmdbId\":77,\"seasonNumber\":1,\"title\":\"Show\",\"episodes\":[{\"s\":1,\"e\":1},{\"s\":1,\"e\":2}]}");
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { placeholder }, null, null, null, None));
        var series = h.Host.AddSeries(tmdb: 77);
        var e1 = h.Host.AddEpisode(series, 1, 1);

        ListDoc? crashDoc = null;
        List<RawEntry>? crashRaw = null;
        h.Host.AfterCollectionAdd = _ =>
        {
            // What a crash right after Jellyfin took the add leaves: the saved intent and the new member.
            crashDoc ??= h.Store.LoadForUpdate(access.ListIdN, ListKinds.Collection);
            crashRaw ??= collection.Raw.ToList();
        };
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
        h.Host.AfterCollectionAdd = null;
        Assert.Single(crashDoc!.Intents);

        // Restart from the crash point; E02 is imported before the next pass.
        collection.Raw.Clear();
        collection.Raw.AddRange(crashRaw!);
        using (await h.Store.LockAsync(access.ListIdN))
        {
            h.Store.Save(crashDoc);
        }

        var e2 = h.Host.AddEpisode(series, 1, 2);
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);

        Assert.Contains(collection.Raw, r => r.ItemId == e1);
        Assert.Contains(collection.Raw, r => r.ItemId == e2);
        var after = h.Store.Load(access.ListIdN)!;
        Assert.Empty(after.Intents);
        Assert.DoesNotContain(after.Items, p => p.Id == placeholder.Id && PlaceholderProgress.FilledCoords(p).Count < 2);
    }

    // R3-6: a document that can't be read while the placeholder index is built (a file held by a backup tool) must not
    // leave the index half-built: the other lists are indexed, and the unreadable one is read again later.
    [Fact]
    public void AnUnreadableDocumentDoesNotStopTheIndexBuild()
    {
        using var fixture = new CoreFixture();
        const string listA = "0123456789abcdef0123456789abcdef";
        const string listB = "fedcba9876543210fedcba9876543210";
        var writer = new ListPlaceholderStore(fixture.Paths.Object, fixture.Logger);
        foreach (var (list, tmdb) in new[] { (listA, 10), (listB, 20) })
        {
            var doc = writer.LoadForUpdate(list, ListKinds.Playlist);
            doc.Items.Add(new Placeholder { Id = "p" + tmdb, Kind = PlaceholderKinds.Movie, MediaType = "movie", TmdbId = tmdb, Title = "M" + tmdb });
            writer.Save(doc);
        }

        var store = new ListPlaceholderStore(fixture.Paths.Object, fixture.Logger) { IndexRetryDelay = TimeSpan.Zero };
        var locked = true;
        store.AfterColdReadForTest = id =>
        {
            if (locked && id == listA)
            {
                throw new IOException("The process cannot access the file because it is being used by another process.");
            }
        };

        Assert.True(store.HasAnyPlaceholders());
        Assert.Equal(listB, Assert.Single(store.FindByTmdb("movie", 20)).ListId);
        Assert.Empty(store.FindByTmdb("movie", 10)); // not readable yet

        locked = false;
        Assert.Equal(listA, Assert.Single(store.FindByTmdb("movie", 10)).ListId);
        Assert.Equal(listB, Assert.Single(store.FindByTmdb("movie", 20)).ListId);
    }

    // R3-8: an editor's link that was still fetching when the owner removed their share (or made it read-only) must not
    // replace the existing link: rights are checked again under the list lock.
    [Theory]
    [InlineData(false, 404, "not_found")]
    [InlineData(true, 403, "forbidden")]
    public async Task ALinkFetchedAfterTheEditorLostTheirRightsChangesNothing(bool keepViewShare, int status, string code)
    {
        using var h = new ListPlaceholdersHarness();
        h.Plugin.Plugin.Configuration.ListPlaceholdersSyncEnabled = true;
        var owner = h.NewUser("owner");
        var editor = h.NewUser("editor");
        var playlist = h.Host.AddPlaylist(owner, false, new ListShare(editor.Id, true));
        h.Fetcher.Items = new List<SourceItem> { new("movie", 1, null, null, "Movie 1", 2020, null, null, null) };
        var ownerAccess = h.AccessFor(playlist, owner);
        Assert.Equal(200, (await h.Sources.LinkAsync(ownerAccess, new LinkSourceRequest { Url = "https://mdblist.com/lists/me/x", SyncEnabled = true }, None)).StatusCode);

        var editorAccess = h.AccessFor(playlist, editor);
        Assert.True(editorAccess.Permissions.CanEdit);
        h.Fetcher.OnFetch = () =>
        {
            playlist.Info = playlist.Info with { Shares = keepViewShare ? new[] { new ListShare(editor.Id, false) } : Array.Empty<ListShare>() };
            return Task.CompletedTask;
        };
        var outcome = await h.Sources.LinkAsync(editorAccess, new LinkSourceRequest { Url = "https://mdblist.com/lists/me/y", SyncEnabled = true }, None);
        Error(outcome, status, code);
        var source = h.Store.Load(ownerAccess.ListIdN)!.Source!;
        Assert.Equal("https://mdblist.com/lists/me/x", source.Url);
        Assert.Equal(ownerAccess.UserIdN, source.LinkedByUserId);
    }

    // R3-7: an episode key that leaves the source while a staying key still covers that episode (the show, its season,
    // or the same episode under another id) only releases the key: the episode stays in the run placeholder.
    [Theory]
    [InlineData("tv|123||")]
    [InlineData("tv|123|1|")]
    [InlineData("tvdb|456|1|1")]
    public void AnEpisodeStillCoveredByAStayingKeyIsNotTrimmed(string stayingKey)
    {
        var run = Ph("{\"kind\":\"episodes\",\"tmdbId\":123,\"title\":\"Show\",\"seasonNumber\":1,\"episodes\":[{\"s\":1,\"e\":1},{\"s\":1,\"e\":2}]}");
        var doc = new ListDoc { Items = new List<Placeholder> { run }, Source = new ListSource { RemoveDropped = true } };
        ListSourceProvenance.RecordAdded(doc.Source, stayingKey, run.Id, null);
        ListSourceProvenance.RecordAdded(doc.Source, "tv|123|1|1", run.Id, null);
        doc.Source.LastSnapshotKeys = doc.Source.Owned.Keys.ToList();

        var plan = ListSourceProvenance.PlanDrops(doc, new[] { stayingKey }, new Dictionary<string, int>());
        Assert.Empty(plan.Trims);
        Assert.Empty(plan.PlaceholderIds);
        Assert.Equal(new[] { "tv|123|1|1" }, plan.Released);
        ListSourceProvenance.ApplyDrops(doc, plan, Array.Empty<string>());
        Assert.Equal(new[] { 1, 2 }, run.Episodes.Select(e => e.E));

        // Control: a staying key of another episode does not cover E1, so E1 still leaves the run.
        var other = Ph("{\"kind\":\"episodes\",\"tmdbId\":123,\"title\":\"Show\",\"seasonNumber\":1,\"episodes\":[{\"s\":1,\"e\":1},{\"s\":1,\"e\":2}]}");
        var control = new ListDoc { Items = new List<Placeholder> { other }, Source = new ListSource { RemoveDropped = true } };
        ListSourceProvenance.RecordAdded(control.Source, "tv|123|1|2", other.Id, null);
        ListSourceProvenance.RecordAdded(control.Source, "tv|123|1|1", other.Id, null);
        Assert.Equal(new[] { (other.Id, 1, 1) }, ListSourceProvenance.PlanDrops(control, new[] { "tv|123|1|2" }, new Dictionary<string, int>()).Trims);
    }

    // R3-1/R3-4/R3-16: with neither Seerr nor a TMDB key nothing can check a TMDB placeholder's poster: the client's is
    // kept but marked unverified, so a viewer with parental controls never gets it, even once a provider is configured
    // and the filter can rate (and so allow) the title. R3-5: with a TMDB key (Seerr still off), the background passes
    // replace it with TMDB's poster.
    [Fact]
    public async Task AnUncheckedClientPosterIsHiddenFromRestrictedViewersAndReplacedOnceTmdbCanBeRead()
    {
        using var h = new ListPlaceholdersHarness();
        var editor = h.NewUser("editor");
        var kid = h.NewUser("kid", maxRating: 10);
        var playlist = h.Host.AddPlaylist(editor, openAccess: true);
        var access = h.AccessFor(playlist, editor);
        var movie = Ph("{\"kind\":\"movie\",\"tmdbId\":10,\"title\":\"Movie 10\",\"releaseDate\":\"2001-01-01\",\"posterPath\":\"/blocked.jpg\"}", access.UserIdN);
        var season = Ph("{\"kind\":\"season\",\"tmdbId\":20,\"seasonNumber\":2,\"title\":\"Show\",\"posterPath\":\"/blocked.jpg\"}", access.UserIdN);
        var custom = Ph("{\"kind\":\"custom\",\"title\":\"Fan edit\",\"posterPath\":\"/mine.jpg\"}", access.UserIdN);
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { movie, season, custom }, null, null, null, None));

        var stored = h.Store.Load(access.ListIdN)!.Items.ToDictionary(p => p.Id);
        Assert.Equal(("/blocked.jpg", (bool?)true), (stored[movie.Id].PosterPath, stored[movie.Id].PosterUnverified));
        Assert.Equal(("/blocked.jpg", (bool?)true), (stored[season.Id].PosterPath, stored[season.Id].PosterUnverified));
        Assert.Equal(("/mine.jpg", (bool?)null), (stored[custom.Id].PosterPath, stored[custom.Id].PosterUnverified));

        // The admin sets a TMDB key: the filter now rates (and allows) the movie for the kid, who still gets no poster
        // that nothing checked; the unrestricted editor keeps seeing it until it is replaced.
        h.Plugin.Plugin.Configuration.TMDB_API_KEY = "tmdb-key";
        h.Tmdb["/3/movie/10/release_dates"] = "{\"id\":10,\"results\":[{\"iso_3166_1\":\"US\",\"release_dates\":[{\"certification\":\"PG\",\"type\":3}]}]}";
        var kidView = await h.Service.GetViewAsync(h.AccessFor(playlist, kid), None);
        var kidMovie = Assert.Single(kidView.Placeholders, p => p.Id == movie.Id);
        Assert.Null(kidMovie.PosterPath);
        var editorView = await h.Service.GetViewAsync(access, None);
        Assert.Equal("/blocked.jpg", editorView.Placeholders.Single(p => p.Id == movie.Id).PosterPath);

        // The daily maintenance pass reads the posters from TMDB.
        h.Tmdb["/3/movie/10"] = "{\"id\":10,\"poster_path\":\"/real10.jpg\"}";
        h.Tmdb["/3/tv/20/season/2"] = "{\"id\":200,\"poster_path\":\"/s2.jpg\"}";
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.Maintenance, None);
        stored = h.Store.Load(access.ListIdN)!.Items.ToDictionary(p => p.Id);
        Assert.Equal(("/real10.jpg", (bool?)null), (stored[movie.Id].PosterPath, stored[movie.Id].PosterUnverified));
        Assert.Equal(("/s2.jpg", (bool?)null), (stored[season.Id].PosterPath, stored[season.Id].PosterUnverified));
        Assert.Equal("2001-01-01", stored[movie.Id].ReleaseDate); // poster-only: nothing else changes
        Assert.Equal("/mine.jpg", stored[custom.Id].PosterPath);
        Assert.DoesNotContain(h.SeerrCalls, c => c.Contains("/api/v1/", StringComparison.Ordinal));
        kidView = await h.Service.GetViewAsync(h.AccessFor(playlist, kid), None);
        Assert.Equal("/real10.jpg", kidView.Placeholders.Single(p => p.Id == movie.Id).PosterPath);
    }

    // R3-1: Seerr's poster also replaces an unverified one, even from partial metadata.
    [Fact]
    public void ServerMetadataAlwaysReplacesAnUnverifiedPoster()
    {
        var season = Ph("{\"kind\":\"season\",\"tmdbId\":20,\"seasonNumber\":1,\"title\":\"Show\",\"posterPath\":\"/forged.jpg\"}");
        season.PosterUnverified = true;
        Assert.True(ListPlaceholderMetadataService.Apply(season, new PlaceholderMetadata { FetchedAtUtc = DateTime.UtcNow, PosterPath = "/show.jpg", Partial = true }));
        Assert.Equal(("/show.jpg", (bool?)null), (season.PosterPath, season.PosterUnverified));
    }

    // R3-5: with Seerr off and a TMDB key, a poster the interactive budget didn't read is filled in by the New pass.
    [Fact]
    public async Task ANewPassReadsTmdbPostersTheInteractiveBudgetMissed()
    {
        using var h = new ListPlaceholdersHarness();
        h.Plugin.Plugin.Configuration.TMDB_API_KEY = "tmdb-key";
        var editor = h.NewUser("editor");
        var playlist = h.Host.AddPlaylist(editor);
        var access = h.AccessFor(playlist, editor);
        var movie = Ph("{\"kind\":\"movie\",\"tmdbId\":10,\"title\":\"Movie 10\"}", access.UserIdN);
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { movie }, null, null, null, None));
        Assert.Null(h.Store.Load(access.ListIdN)!.Items.Single().PosterPath); // TMDB did not answer then (404, not cached)

        h.Tmdb["/3/movie/10"] = "{\"id\":10,\"poster_path\":\"/real10.jpg\"}";
        await h.Swap.RunListPassAsync(access.ListIdN, new[] { movie.Id }, MetadataMode.New, None);
        Assert.Equal("/real10.jpg", h.Store.Load(access.ListIdN)!.Items.Single().PosterPath);
    }
}
