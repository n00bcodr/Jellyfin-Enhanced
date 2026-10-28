using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using static JE.Tests.ListsHarness;

namespace JE.Tests;

// Review round 2: server-side fixes in the core list service (the list-core assertions; sync ones belong to the
// source track).
[Collection("Plugin singleton")]
public class ListsReviewR2Tests
{
    private static readonly CancellationToken None = CancellationToken.None;

    // R2-1: without Seerr but with a TMDB key the parental filter rates titles from TMDB, so a client's poster must not
    // be kept: the poster comes from TMDB (the season's for a season placeholder), or none.
    [Fact]
    public async Task WithoutSeerrButWithATmdbKeyThePosterComesFromTmdbNotTheClient()
    {
        using var h = new ListsHarness();
        h.Plugin.Plugin.Configuration.TMDB_API_KEY = "tmdb-key";
        h.Tmdb["/3/movie/10"] = "{\"id\":10,\"poster_path\":\"/real10.jpg\"}";
        h.Tmdb["/3/tv/20/season/2"] = "{\"id\":200,\"poster_path\":\"/s2.jpg\"}";
        h.Tmdb["/3/tv/30"] = "{\"id\":30,\"poster_path\":\"/show30.jpg\"}";
        var editor = h.NewUser("editor");
        var playlist = h.Host.AddPlaylist(editor);
        var access = h.AccessFor(playlist, editor);
        var movie = Ph("{\"kind\":\"movie\",\"tmdbId\":10,\"title\":\"Movie 10\",\"posterPath\":\"/blocked.jpg\"}", access.UserIdN);
        var unknown = Ph("{\"kind\":\"movie\",\"tmdbId\":11,\"title\":\"Movie 11\",\"posterPath\":\"/blocked.jpg\"}", access.UserIdN);
        var season = Ph("{\"kind\":\"season\",\"tmdbId\":20,\"seasonNumber\":2,\"title\":\"Show\",\"posterPath\":\"/blocked.jpg\"}", access.UserIdN);
        var noSeasonPoster = Ph("{\"kind\":\"season\",\"tmdbId\":30,\"seasonNumber\":1,\"title\":\"Show 30\",\"posterPath\":\"/blocked.jpg\"}", access.UserIdN);
        var custom = Ph("{\"kind\":\"custom\",\"title\":\"Fan edit\",\"posterPath\":\"/mine.jpg\"}", access.UserIdN);
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { movie, unknown, season, noSeasonPoster, custom }, null, null, null, None));

        var stored = h.Store.Load(access.ListIdN)!.Items.ToDictionary(p => p.Id);
        Assert.Equal("/real10.jpg", stored[movie.Id].PosterPath);
        Assert.Null(stored[unknown.Id].PosterPath);
        Assert.Equal("/s2.jpg", stored[season.Id].PosterPath);
        Assert.Equal("/show30.jpg", stored[noSeasonPoster.Id].PosterPath);
        Assert.Equal("/mine.jpg", stored[custom.Id].PosterPath);
        Assert.DoesNotContain(h.SeerrCalls, c => c.Contains("/api/v1/", StringComparison.Ordinal));
    }

    // R2-3: someone adds the arrived movie by hand between JE's first membership read and the intent save. The saved
    // intent must lose it before Jellyfin is called, or a crash would let recovery make the user's member sync-owned.
    [Fact]
    public async Task AMemberAddedByHandAfterTheIntentWasSavedLeavesTheSavedIntent()
    {
        using var h = new ListsHarness();
        var admin = h.NewUser("admin", admin: true);
        var collection = h.Host.AddCollection();
        var access = h.AccessFor(collection, admin);
        var movie = Movie(821);
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { movie }, null, null, null, None));
        await h.Consent(access); // D29: this list's editor turned automatic swap-in on
        using (await h.Store.LockAsync(access.ListIdN))
        {
            var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Collection);
            doc.Items.Single(p => p.Id == movie.Id).SourceKey = "movie|821||";
            doc.Source = new ListSource { Kind = "tmdb", Url = "https://www.themoviedb.org/list/1" };
            doc.Source.Owned["movie|821||"] = new SourceOwnership { PhId = movie.Id };
            h.Store.Save(doc);
        }

        var arrived = h.Host.AddItem(tmdb: 821);
        var phase = 0;
        ListDoc? crashDoc = null;
        List<RawEntry>? crashRaw = null;
        h.Host.OnRawRead = _ =>
        {
            if (phase == 0 && h.Store.Load(access.ListIdN)!.Intents.Count > 0)
            {
                collection.Raw.Add(new RawEntry(arrived, true)); // the user's own add, right after JE saved its intent
                phase = 1;
            }
            else if (phase == 1)
            {
                // The next read: what a crash here leaves on disk.
                crashDoc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Collection);
                crashRaw = collection.Raw.ToList();
                phase = 2;
            }
        };
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
        h.Host.OnRawRead = null;
        Assert.Equal(2, phase);
        Assert.DoesNotContain(h.Host.Calls, c => c.StartsWith("collection:", StringComparison.Ordinal));
        Assert.Empty(crashDoc!.Intents);

        // Restart from that crash point: recovery must not make the user's member sync-owned.
        collection.Raw.Clear();
        collection.Raw.AddRange(crashRaw!);
        using (await h.Store.LockAsync(access.ListIdN))
        {
            h.Store.Save(crashDoc);
        }

        await h.Swap.RunListPassAsync(access.ListIdN, Array.Empty<string>(), MetadataMode.None, None);
        await h.Swap.RunListPassAsync(access.ListIdN, null, MetadataMode.None, None);
        var after = h.Store.Load(access.ListIdN)!;
        Assert.Empty(after.Intents);
        Assert.DoesNotContain(arrived.ToString("N"), after.Source!.Owned.TryGetValue("movie|821||", out var owned) ? owned.ItemIds : new List<string>());
    }

    // R2-4: an ended show's season whose TMDB data has an undated episode between aired ones isn't complete until that
    // episode is in too; stale display-only trailing rows do not extend freshly reconciled authority.
    [Fact]
    public void AnEndedShowsUndatedEpisodeBetweenAiredOnesIsStillRequired()
    {
        var today = new DateTime(2026, 10, 11, 0, 0, 0, DateTimeKind.Utc);
        var season = Ph("{\"kind\":\"season\",\"tmdbId\":40,\"seasonNumber\":1,\"title\":\"Old show\"}");
        season.InProduction = false;
        season.Expected = Enumerable.Range(1, 10)
            .Select(e => new PlaceholderEpisode { S = 1, E = e, AirDate = e == 5 ? null : "2001-01-" + e.ToString("00", System.Globalization.CultureInfo.InvariantCulture) })
            .Append(new PlaceholderEpisode { S = 1, E = 11 })
            .ToList();
        season.Filled = Enumerable.Range(1, 10).Where(e => e != 5).Select(e => new FilledEpisode { ItemId = Guid.NewGuid().ToString("N"), S = 1, E = e }).ToList();
        Assert.False(PlaceholderProgress.IsComplete(season, today)); // E5 is a gap in the data, not unaired

        // Cold/legacy display rows cannot grant authority. Refresh with ten explicit detailed coordinates;
        // the undated interior E5 is independently required by the named last-aired E10.
        var show = System.Text.Json.JsonSerializer.Serialize(new
        {
            id = 40, name = "Old show", firstAirDate = "2001-01-01", posterPath = (string?)null,
            status = "Ended", inProduction = false, externalIds = new { imdbId = (string?)null, tvdbId = (int?)null },
            seasons = new[] { new { seasonNumber = 1, episodeCount = 10, airDate = "2001-01-01" } },
            lastEpisodeToAir = new { seasonNumber = 1, episodeNumber = 10, airDate = "2001-01-10" }, nextEpisodeToAir = (object?)null,
        });
        var details = System.Text.Json.JsonSerializer.Serialize(new
        {
            seasonNumber = 1, airDate = "2001-01-01", posterPath = (string?)null,
            episodes = season.Expected.Take(10).Select(e => new { showId = 40, seasonNumber = e.S, episodeNumber = e.E, airDate = e.AirDate }),
        });
        ListMetadataService.Apply(season, ReconciledTv(season, show, today, details));
        season.Expected.Add(new PlaceholderEpisode { S = 1, E = 11 }); // stale display row, absent from refreshed authority
        Assert.DoesNotContain(season.CompletionAuthority!.Episodes, e => e.E == 11);
        Assert.Contains(new EpisodeCoord(1, 5), CompletionEvaluator.Read(season, today).Missing);
        Assert.False(PlaceholderProgress.IsComplete(season, today));

        season.Filled.Add(new FilledEpisode { ItemId = Guid.NewGuid().ToString("N"), S = 1, E = 5 });
        Assert.True(PlaceholderProgress.IsComplete(season, today)); // E11 (undated, after the last aired) isn't required
    }

    // Not ported here (source/sync track): R2-8 LinkingAListDeletedDuringTheFetchRecreatesNoDocument, R2-9
    // AJoinerStopsWaitingWhenItsOwnTokenIsCancelled, R2-10 AnUnreadableDocumentDoesNotStopTheScheduledRun.
}
