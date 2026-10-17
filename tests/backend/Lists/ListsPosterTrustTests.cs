using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using static JE.Tests.ListsHarness;

namespace JE.Tests;

// Review round 1 (track f, list-core part): a TMDB placeholder's poster is the one Seerr has for that title, never one a
// client sent. (The collage tests of the same review file belong to the collage track.)
[Collection("Plugin singleton")]
public class ListsPosterTrustTests
{
    private static readonly CancellationToken None = CancellationToken.None;

    [Fact]
    public async Task AddedAndLinkedTitlesGetTheServersPosterNotTheClients()
    {
        using var h = new ListsHarness(seerr: true);
        h.MovieDetails[10] = "{\"id\":10,\"posterPath\":\"/real10.jpg\"}"; // nothing else, so the background pass saves nothing
        h.MovieDetails[12] = "{\"id\":12,\"releaseDate\":\"2012-07-16\",\"posterPath\":\"/real12.jpg\"}";
        var editor = h.NewUser("editor");
        var playlist = h.Host.AddPlaylist(editor);
        var access = h.AccessFor(playlist, editor);
        Assert.False(access.IsAdmin);

        var known = Ph("{\"kind\":\"movie\",\"tmdbId\":10,\"title\":\"Movie 10\",\"posterPath\":\"/blocked.jpg\"}", access.UserIdN);
        var unknown = Ph("{\"kind\":\"movie\",\"tmdbId\":11,\"title\":\"Movie 11\",\"posterPath\":\"/blocked.jpg\"}", access.UserIdN);
        var custom = Ph("{\"kind\":\"custom\",\"title\":\"Fan edit\",\"posterPath\":\"/mine.jpg\"}", access.UserIdN);
        var added = Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { known, unknown, custom }, null, null, null, None));
        var rows = added.View!.Placeholders.ToDictionary(p => p.Id);
        Assert.Equal("/real10.jpg", rows[known.Id].PosterPath);
        Assert.Null(rows[unknown.Id].PosterPath); // nothing to check it against: no poster (fail closed)
        Assert.Equal("/mine.jpg", rows[custom.Id].PosterPath); // a custom entry is the adder's own (never shown to restricted viewers)

        var link = Ph("{\"kind\":\"movie\",\"tmdbId\":12,\"title\":\"Movie 12\",\"posterPath\":\"/blocked.jpg\"}");
        var linked = Ok<ListViewDto>(await h.Service.PatchAsync(access, custom.Id, added.View.Rev, null, link, null, None));
        Assert.Equal("/real12.jpg", linked.Placeholders.Single(p => p.Id == custom.Id).PosterPath);
        var stored = h.Store.Load(access.ListIdN)!.Items.ToDictionary(p => p.Id);
        Assert.Equal("/real12.jpg", stored[custom.Id].PosterPath);
        Assert.NotEqual("/blocked.jpg", stored[known.Id].PosterPath);
        Assert.NotEqual("/blocked.jpg", stored[unknown.Id].PosterPath);
    }

    [Fact]
    public async Task WithoutSeerrTheClientsPosterIsKept()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        var movie = Ph("{\"kind\":\"movie\",\"tmdbId\":10,\"title\":\"Movie 10\",\"posterPath\":\"/mine.jpg\"}", access.UserIdN);
        var added = Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { movie }, null, null, null, None));
        Assert.Equal("/mine.jpg", Assert.Single(added.View!.Placeholders).PosterPath);
    }

    [Fact]
    public void SeerrsPosterReplacesAStoredOneAndAFullReadWithoutAPosterClearsIt()
    {
        var movie = Ph("{\"kind\":\"movie\",\"tmdbId\":10,\"title\":\"Movie 10\",\"posterPath\":\"/blocked.jpg\"}");
        var today = new DateTime(2026, 10, 11, 0, 0, 0, DateTimeKind.Utc);
        Assert.True(ListMetadataService.Apply(movie, new PlaceholderMetadata { FetchedAtUtc = today, PosterPath = "/real.jpg" }));
        Assert.Equal("/real.jpg", movie.PosterPath);
        Assert.True(ListMetadataService.Apply(movie, new PlaceholderMetadata { FetchedAtUtc = today }));
        Assert.Null(movie.PosterPath);

        // A partial read (the season's details failed) only fills a missing poster.
        var season = Ph("{\"kind\":\"season\",\"tmdbId\":20,\"seasonNumber\":1,\"title\":\"Show\",\"posterPath\":\"/s1.jpg\"}");
        ListMetadataService.Apply(season, new PlaceholderMetadata { FetchedAtUtc = today, PosterPath = "/show.jpg", Partial = true });
        Assert.Equal("/s1.jpg", season.PosterPath);
    }
}
