using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using static JE.Tests.ListsHarness;

namespace JE.Tests;

// Review round 3: server-side fixes (swap recovery, posters, store index, link access).
[Collection("Plugin singleton")]
public class ListsReviewR3Tests
{
    private static readonly CancellationToken None = CancellationToken.None;

    // R3-3: a crash right after JE added an episode to a collection leaves the intent on disk. An episode imported
    // before the next pass is not in that intent; recovery must not count it as present (it never went into the
    // collection), or the placeholder retires with the episode missing.
    [Fact]
    public async Task AnEpisodeThatArrivedAfterACrashedCollectionSwapStillGoesIn()
    {
        using var h = new ListsHarness();
        var admin = h.NewUser("admin", admin: true);
        var collection = h.Host.AddCollection();
        var access = h.AccessFor(collection, admin);
        var placeholder = Ph("{\"kind\":\"episodes\",\"tmdbId\":77,\"seasonNumber\":1,\"title\":\"Show\",\"episodes\":[{\"s\":1,\"e\":1},{\"s\":1,\"e\":2}]}");
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { placeholder }, null, null, null, None));
        await h.Consent(access); // D29: this list's editor turned automatic swap-in on
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
        var writer = new ListStore(fixture.Paths.Object, fixture.Logger);
        foreach (var (list, tmdb) in new[] { (listA, 10), (listB, 20) })
        {
            var doc = writer.LoadForUpdate(list, ListKinds.Playlist);
            doc.Items.Add(new Placeholder { Id = "p" + tmdb, Kind = PlaceholderKinds.Movie, MediaType = "movie", TmdbId = tmdb, Title = "M" + tmdb });
            writer.Save(doc);
        }

        var store = new ListStore(fixture.Paths.Object, fixture.Logger) { IndexRetryDelay = TimeSpan.Zero };
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

    // Not ported here (source/sync track): R3-8 ALinkFetchedAfterTheEditorLostTheirRightsChangesNothing (linking),
    // R3-7 AnEpisodeStillCoveredByAStayingKeyIsNotTrimmed (sync drop planning).

    // R3-1/R3-4/R3-16: with neither Seerr nor a TMDB key nothing can check a TMDB placeholder's poster: the client's is
    // kept but marked unverified, so a viewer with parental controls never gets it, even once a provider is configured
    // and the filter can rate (and so allow) the title. R3-5: with a TMDB key (Seerr still off), the background passes
    // replace it with TMDB's poster.
    [Fact]
    public async Task AnUncheckedClientPosterIsHiddenFromRestrictedViewersAndReplacedOnceTmdbCanBeRead()
    {
        using var h = new ListsHarness();
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
        Assert.True(ListMetadataService.Apply(season, new PlaceholderMetadata { FetchedAtUtc = DateTime.UtcNow, PosterPath = "/show.jpg", Partial = true }));
        Assert.Equal(("/show.jpg", (bool?)null), (season.PosterPath, season.PosterUnverified));
    }

    // R3-5: with Seerr off and a TMDB key, a poster the interactive budget didn't read is filled in by the New pass.
    [Fact]
    public async Task ANewPassReadsTmdbPostersTheInteractiveBudgetMissed()
    {
        using var h = new ListsHarness();
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
