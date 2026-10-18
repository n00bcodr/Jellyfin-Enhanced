using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using static JE.Tests.ListsHarness;

namespace JE.Tests;

// Editions (new in the list core): an entry stands for the standard edition (default, stored as no value; also every
// imported #936 entry) or 4K. It is part of the entry's identity; a 4K entry only ever resolves 4K copies, a standard
// entry takes any copy but prefers the non-4K ones.
[Collection("Plugin singleton")]
public class ListsEditionTests
{
    private static readonly CancellationToken None = CancellationToken.None;
    private static readonly User[] Nobody = Array.Empty<User>();

    private static Placeholder Movie4k(int tmdb) => Ph($"{{\"kind\":\"movie\",\"tmdbId\":{tmdb},\"title\":\"Movie {tmdb}\",\"edition\":\"4k\"}}");

    private static Placeholder Season(int tmdb, int season, bool fourK = false) =>
        Ph($"{{\"kind\":\"season\",\"tmdbId\":{tmdb},\"seasonNumber\":{season},\"title\":\"Show\"{(fourK ? ",\"edition\":\"4k\"" : string.Empty)}}}");

    [Fact]
    public async Task AFourKEntrysStatusIsItsOwnEditionsNeverTheStandardCopys()
    {
        using var h = new ListsHarness(status: true);
        h.Plugin.Plugin.Configuration.ArrPhase4ListStatusEnabled = true;
        var show = TitleKey.ForSeries(null, "7", null)!;
        // The standard copies are here; nothing of the 4K ones is.
        h.Status.ByKey["movie:tmdb:5"] = "{\"stage\":\"ready\"}";
        h.Status.ByKey[ListStatusKeys.SeasonId(show, 2)] = "{\"stage\":\"ready\"}";
        h.Status.ByKey["movie:tmdb:5@4k"] = "{\"stage\":\"notHere\"}";
        h.Status.ByKey[ListStatusKeys.SeasonId(show, 2) + "@4k"] = "{\"stage\":\"downloading\"}";
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(
            access,
            new[] { Movie(5, "2020-01-01"), Movie4k(5), Season(7, 2), Season(7, 2, fourK: true) },
            null,
            null,
            null,
            None));

        var view = await h.Service.GetViewAsync(access, None);

        Assert.Equal(new[] { "standard", "4k", "standard", "4k" }, view.Placeholders.Select(p => p.Edition));
        Assert.Equal(
            new[] { "ready", "notHere", "ready", "downloading" },
            view.Placeholders.Select(p => p.Status is { } status ? status.GetProperty("stage").GetString() : null));
    }

    [Theory]
    [InlineData(null, null)]
    [InlineData("standard", null)]
    [InlineData(" Standard ", null)]
    [InlineData("4k", "4k")]
    [InlineData("4K", "4k")]
    public void TheEditionIsNormalisedAndStandardIsStoredAsNoValue(string? sent, string? stored)
    {
        Assert.True(ListRules.TryCreate(new NewPlaceholderDto { Kind = "movie", TmdbId = 1, Title = "x", Edition = sent }, "u", DateTime.UtcNow, out var placeholder, out var error), error);
        Assert.Equal(stored, placeholder.Edition);
        Assert.Equal(stored ?? ListRules.Standard, ListRules.EditionOf(placeholder));
    }

    [Theory]
    [InlineData("{\"kind\":\"movie\",\"tmdbId\":1,\"title\":\"x\",\"edition\":\"8k\"}")]
    [InlineData("{\"kind\":\"movie\",\"tmdbId\":1,\"title\":\"x\",\"edition\":\"hdr\"}")]
    [InlineData("{\"kind\":\"custom\",\"title\":\"x\",\"edition\":\"4k\"}")]
    public void UnknownEditionsAnd4kCustomEntriesAreRejected(string json)
    {
        var dto = System.Text.Json.JsonSerializer.Deserialize<NewPlaceholderDto>(json)!;
        Assert.False(ListRules.TryCreate(dto, "u", DateTime.UtcNow, out _, out var error));
        Assert.Contains("edition", error);
    }

    [Fact]
    public void FourKIsPartOfTheIdentityAndStandardKeepsTheSchemaOneKey()
    {
        Assert.Equal("movie|movie|5||", ListRules.IdentityKey(Movie(5)));
        Assert.Equal("movie|movie|5|||4k", ListRules.IdentityKey(Movie4k(5)));
        Assert.Equal("season|tv|7|2||4k", ListRules.IdentityKey(Season(7, 2, fourK: true)));
        Assert.NotEqual(ListRules.IdentityKey(Season(7, 2)), ListRules.IdentityKey(Season(7, 2, fourK: true)));
        // An unknown stored value counts as standard.
        var odd = Movie(5);
        odd.Edition = "hdr";
        Assert.Equal(ListRules.Standard, ListRules.EditionOf(odd));
        Assert.Equal("movie|movie|5||", ListRules.IdentityKey(odd));
    }

    [Fact]
    public void AFourKMovieEntryOnlyResolvesAFourKCopy()
    {
        using var h = new ListsHarness();
        var standard = h.Host.AddMovieCopy(600);
        Assert.False(h.Resolver.Resolve(Movie4k(600), ListKinds.Playlist, Nobody).Found);

        var uhd = h.Host.AddMovieCopy(600, fourK: true);
        Assert.Equal(uhd, Assert.Single(h.Resolver.Resolve(Movie4k(600), ListKinds.Playlist, Nobody).Items).ItemId);
        Assert.Equal(standard, Assert.Single(h.Resolver.Resolve(Movie(600), ListKinds.Playlist, Nobody).Items).ItemId);
    }

    [Fact]
    public void AStandardMovieEntryPrefersANonFourKCopyAndTakesAFourKOneOnlyWhenThereIsNoOther()
    {
        using var h = new ListsHarness();
        var uhd = h.Host.AddMovieCopy(610, fourK: true); // the library lists the 4K copy first
        Assert.Equal(uhd, Assert.Single(h.Resolver.Resolve(Movie(610), ListKinds.Playlist, Nobody).Items).ItemId);

        var standard = h.Host.AddMovieCopy(610);
        Assert.Equal(standard, Assert.Single(h.Resolver.Resolve(Movie(610), ListKinds.Playlist, Nobody).Items).ItemId);

        // A standard copy the users can't access doesn't block the 4K one.
        var viewer = h.NewUser("viewer");
        h.Host.Hide(standard, viewer);
        Assert.Equal(uhd, Assert.Single(h.Resolver.Resolve(Movie(610), ListKinds.Playlist, new[] { viewer }).Items).ItemId);
    }

    [Fact]
    public void EpisodeEntriesFollowTheEditionRulePerCopyOfTheShow()
    {
        using var h = new ListsHarness();
        // A 4K library holds E01–E03 (added first, so it is the first copy found); the HD library E01–E02.
        var uhd = h.Host.AddSeries(tmdb: 620);
        var uhdEpisodes = new[] { 1, 2, 3 }.Select(e => h.Host.AddEpisode(uhd, 1, e)).ToList();
        uhdEpisodes.ForEach(id => h.Host.FourK.Add(id));
        var hd = h.Host.AddSeries(tmdb: 620);
        var hdEpisodes = new[] { 1, 2 }.Select(e => h.Host.AddEpisode(hd, 1, e)).ToList();

        // 4K: only the 4K copy's episodes.
        Assert.Equal(uhdEpisodes, h.Resolver.Resolve(Season(620, 1, fourK: true), ListKinds.Playlist, Nobody).Items.Select(i => i.ItemId));

        // Standard: the HD copy's episodes first, the 4K copy only for the episode the HD copy lacks.
        Assert.Equal(hdEpisodes.Append(uhdEpisodes[2]), h.Resolver.Resolve(Season(620, 1), ListKinds.Playlist, Nobody).Items.Select(i => i.ItemId));

        // A 4K episodes entry for an episode only the HD copy has: nothing.
        var listed = Ph("{\"kind\":\"episodes\",\"tmdbId\":620,\"seasonNumber\":1,\"title\":\"Show\",\"edition\":\"4k\",\"episodes\":[{\"s\":1,\"e\":4}]}");
        h.Host.AddEpisode(hd, 1, 4);
        Assert.False(h.Resolver.Resolve(listed, ListKinds.Playlist, Nobody).Found);
        Assert.Equal(BaseItemKind.Episode, Assert.Single(h.Resolver.Resolve(Ph("{\"kind\":\"episodes\",\"tmdbId\":620,\"seasonNumber\":1,\"title\":\"Show\",\"episodes\":[{\"s\":1,\"e\":4}]}"), ListKinds.Playlist, Nobody).Items).Kind);
    }

    [Fact]
    public async Task BothEditionsOfATitleCanBeListedAndOnlyTheMatchingCopyGoesIn()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        var standardCopy = h.Host.AddMovieCopy(630);

        // The standard entry goes in as the library's standard copy; the 4K entry of the same title isn't a duplicate
        // and stays an entry (the library has no 4K copy).
        var added = Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { Movie(630), Movie4k(630), Movie4k(630) }, null, null, null, None));
        Assert.Equal(new[] { standardCopy.ToString("N") }, added.AddedAsItems);
        Assert.Equal((2, "duplicate", (int?)1), (added.Skipped.Single().Index, added.Skipped.Single().Reason, added.Skipped.Single().SameAs));
        var entry = Assert.Single(added.View!.Placeholders);
        Assert.Equal(("4k", "movie:tmdb:630"), (entry.Edition, entry.TitleKey));
        Assert.Equal("4k", h.Store.Load(access.ListIdN)!.Items.Single().Edition);
        await h.Consent(access);

        // A second standard copy arriving is no arrival for the 4K entry.
        var other = h.Host.AddMovieCopy(630);
        h.Swap.NotifyItemChanged(other);
        await h.Swap.DrainAsync(None);
        Assert.Equal(new[] { standardCopy }, h.Host.Resolved(playlist.Info.Id));
        Assert.Single(h.Store.Load(access.ListIdN)!.Items);

        // The 4K copy is.
        var uhd = h.Host.AddMovieCopy(630, fourK: true);
        h.Swap.NotifyItemChanged(uhd);
        await h.Swap.DrainAsync(None);
        Assert.Equal(new[] { standardCopy, uhd }, h.Host.Resolved(playlist.Info.Id));
        Assert.Empty(h.Store.Load(access.ListIdN)!.Items);
    }

    [Fact]
    public async Task AStandardEntryAddedWhenOnlyAFourKCopyExistsTakesIt()
    {
        using var h = new ListsHarness();
        var owner = h.NewUser("owner");
        var playlist = h.Host.AddPlaylist(owner);
        var access = h.AccessFor(playlist, owner);
        var uhd = h.Host.AddMovieCopy(640, fourK: true);
        var added = Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(access, new[] { Movie(640) }, null, null, null, None));
        Assert.Equal(new[] { uhd.ToString("N") }, added.AddedAsItems);
        Assert.Empty(added.Added);
    }
}
