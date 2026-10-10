using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;

namespace JE.Tests;

// Placeholder input validation (lengths, ids, kinds, the single-season episodes invariant) and identity.
public class ListPlaceholdersRulesTests
{
    private static readonly DateTime Now = new(2026, 10, 10, 12, 0, 0, DateTimeKind.Utc);

    private static bool Create(NewPlaceholderDto dto, out Placeholder placeholder, out string error) =>
        PlaceholderRules.TryCreate(dto, "user1", Now, out placeholder, out error);

    [Fact]
    public void ValidPlaceholdersOfEveryKindAreNormalised()
    {
        Assert.True(Create(new NewPlaceholderDto { Kind = "Movie", TmdbId = 5, Title = "  Heat ", ReleaseDate = "1995-12-15", PosterPath = "/a_b-1.jpg", ImdbId = "tt0113277" }, out var movie, out _));
        Assert.Equal(("movie", "movie", "Heat", "1995-12-15"), (movie.Kind, movie.MediaType, movie.Title, movie.ReleaseDate));
        Assert.Equal(32, movie.Id.Length);
        Assert.Equal("user1", movie.AddedBy);
        Assert.Equal(Now, DateTime.Parse(movie.AddedAt, null, System.Globalization.DateTimeStyles.AdjustToUniversal));

        Assert.True(Create(new NewPlaceholderDto { Kind = "series", TmdbId = 7, TvdbId = 9, Title = "Show", EpisodeTotal = 20 }, out var series, out _));
        Assert.Equal(("tv", 20), (series.MediaType, series.EpisodeTotal));

        Assert.True(Create(new NewPlaceholderDto { Kind = "season", TmdbId = 7, Title = "Show", SeasonNumber = 0 }, out var season, out _));
        Assert.Equal(0, season.SeasonNumber);

        Assert.True(Create(new NewPlaceholderDto
        {
            Kind = "episodes", TmdbId = 7, Title = "Show", SeasonNumber = 3,
            Episodes = new() { new() { S = 3, E = 8, AirDate = "2014-12-02" }, new() { S = 3, E = 2 }, new() { S = 3, E = 8 } },
        }, out var episodes, out _));
        Assert.Equal(new[] { 2, 8 }, episodes.Episodes.Select(e => e.E));

        Assert.True(Create(new NewPlaceholderDto { Kind = "custom", MediaType = "tv", Title = "Paradise Lost", Note = "In development" }, out var custom, out _));
        Assert.Equal(("tv", null, "In development"), (custom.MediaType, custom.TmdbId, custom.Note));
    }

    [Theory]
    [InlineData("{\"kind\":\"bogus\",\"tmdbId\":1,\"title\":\"x\"}", "unknown kind")]
    [InlineData("{\"kind\":\"movie\",\"title\":\"x\"}", "tmdbId is required")]
    [InlineData("{\"kind\":\"movie\",\"tmdbId\":0,\"title\":\"x\"}", "tmdbId is required")]
    [InlineData("{\"kind\":\"movie\",\"mediaType\":\"tv\",\"tmdbId\":1,\"title\":\"x\"}", "mediaType movie")]
    [InlineData("{\"kind\":\"series\",\"mediaType\":\"movie\",\"tmdbId\":1,\"title\":\"x\"}", "mediaType tv")]
    [InlineData("{\"kind\":\"custom\",\"tmdbId\":1,\"title\":\"x\"}", "no tmdbId")]
    [InlineData("{\"kind\":\"custom\",\"mediaType\":\"person\",\"title\":\"x\"}", "movie or tv")]
    [InlineData("{\"kind\":\"movie\",\"tmdbId\":1,\"title\":\"   \"}", "title")]
    [InlineData("{\"kind\":\"movie\",\"tmdbId\":1,\"title\":\"x\",\"year\":1500}", "year")]
    [InlineData("{\"kind\":\"movie\",\"tmdbId\":1,\"title\":\"x\",\"releaseDate\":\"10/23/2026\"}", "releaseDate")]
    [InlineData("{\"kind\":\"movie\",\"tmdbId\":1,\"title\":\"x\",\"posterPath\":\"https://evil/x.jpg\"}", "posterPath")]
    [InlineData("{\"kind\":\"movie\",\"tmdbId\":1,\"title\":\"x\",\"posterPath\":\"/../x.jpg\"}", "posterPath")]
    [InlineData("{\"kind\":\"movie\",\"tmdbId\":1,\"title\":\"x\",\"imdbId\":\"nm0000001\"}", "imdbId")]
    [InlineData("{\"kind\":\"movie\",\"tmdbId\":1,\"tvdbId\":3,\"title\":\"x\"}", "tvdbId")]
    [InlineData("{\"kind\":\"movie\",\"tmdbId\":1,\"title\":\"x\",\"seasonNumber\":1}", "seasonNumber only")]
    [InlineData("{\"kind\":\"season\",\"tmdbId\":1,\"title\":\"x\"}", "seasonNumber 0-200")]
    [InlineData("{\"kind\":\"season\",\"tmdbId\":1,\"title\":\"x\",\"seasonNumber\":201}", "seasonNumber 0-200")]
    [InlineData("{\"kind\":\"episodes\",\"tmdbId\":1,\"title\":\"x\",\"seasonNumber\":1}", "episodes are required")]
    [InlineData("{\"kind\":\"episodes\",\"tmdbId\":1,\"title\":\"x\",\"seasonNumber\":1,\"episodes\":[{\"s\":1,\"e\":1},{\"s\":2,\"e\":1}]}", "seasonNumber")]
    [InlineData("{\"kind\":\"episodes\",\"tmdbId\":1,\"title\":\"x\",\"seasonNumber\":1,\"episodes\":[{\"s\":1,\"e\":-1}]}", "episode number")]
    [InlineData("{\"kind\":\"season\",\"tmdbId\":1,\"title\":\"x\",\"seasonNumber\":1,\"episodes\":[{\"s\":1,\"e\":1}]}", "only apply")]
    [InlineData("{\"kind\":\"season\",\"tmdbId\":1,\"title\":\"x\",\"seasonNumber\":1,\"episodeTotal\":-1}", "episodeTotal")]
    public void InvalidInputIsRejectedWithAReason(string json, string reasonPart)
    {
        var dto = System.Text.Json.JsonSerializer.Deserialize<NewPlaceholderDto>(json)!;
        Assert.False(Create(dto, out _, out var error));
        Assert.Contains(reasonPart, error);
    }

    [Fact]
    public void LengthLimitsAreEnforced()
    {
        Assert.False(Create(new NewPlaceholderDto { Kind = "movie", TmdbId = 1, Title = new string('x', 201) }, out _, out _));
        Assert.True(Create(new NewPlaceholderDto { Kind = "movie", TmdbId = 1, Title = new string('x', 200) }, out _, out _));
        Assert.False(Create(new NewPlaceholderDto { Kind = "movie", TmdbId = 1, Title = "x", Note = new string('n', 301) }, out _, out _));
        Assert.True(Create(new NewPlaceholderDto { Kind = "movie", TmdbId = 1, Title = "x", Overview = new string('o', 1500) }, out var cut, out _));
        Assert.Equal(1000, cut.Overview!.Length);
        var many = Enumerable.Range(1, 101).Select(e => new PlaceholderEpisode { S = 1, E = e }).ToList();
        Assert.False(Create(new NewPlaceholderDto { Kind = "episodes", TmdbId = 1, Title = "x", SeasonNumber = 1, Episodes = many }, out _, out var error));
        Assert.Contains("100", error);
        Assert.False(PlaceholderRules.TryCreate(null, "u", Now, out _, out _));
    }

    [Fact]
    public void OversizedEpisodeInputIsRejectedBeforeAnyPerEpisodeWork()
    {
        // 10,000 distinct numbers followed by ~1M repeats: quadratic de-duplication would take minutes. The input
        // size itself is capped, so this returns at once.
        var hostile = Enumerable.Range(0, 10_000).Concat(Enumerable.Repeat(9_999, 1_000_000))
            .Select(e => new PlaceholderEpisode { S = 1, E = e }).ToList();
        var watch = System.Diagnostics.Stopwatch.StartNew();
        Assert.False(Create(new NewPlaceholderDto { Kind = "episodes", TmdbId = 1, Title = "x", SeasonNumber = 1, Episodes = hostile }, out _, out var error));
        Assert.True(watch.ElapsedMilliseconds < 500, $"took {watch.ElapsedMilliseconds} ms");
        Assert.Contains("100", error);

        // Duplicates within the cap are still tolerated (first copy wins).
        var duplicated = Enumerable.Repeat(3, 60).Concat(Enumerable.Repeat(1, 40))
            .Select(e => new PlaceholderEpisode { S = 1, E = e, Title = "E" + e }).ToList();
        Assert.True(Create(new NewPlaceholderDto { Kind = "episodes", TmdbId = 1, Title = "x", SeasonNumber = 1, Episodes = duplicated }, out var placeholder, out _));
        Assert.Equal(new[] { 1, 3 }, placeholder.Episodes.Select(e => e.E));
    }

    [Fact]
    public void ControlCharactersAreStripped()
    {
        Assert.True(Create(new NewPlaceholderDto { Kind = "movie", TmdbId = 1, Title = "A\u0000B​c\nd" }, out var placeholder, out _));
        Assert.Equal("ABc d", placeholder.Title);
    }

    [Fact]
    public void LinkingRefusesCustomKind()
    {
        Assert.False(PlaceholderRules.TryNormalize(new NewPlaceholderDto { Kind = "custom", Title = "x" }, allowCustom: false, out _, out _));
        Assert.True(PlaceholderRules.TryNormalize(new NewPlaceholderDto { Kind = "movie", TmdbId = 1, Title = "x" }, allowCustom: false, out _, out _));
    }

    [Fact]
    public void IdentityKeysSeparateGranularitiesAndNormaliseCustomTitles()
    {
        Placeholder Make(string json)
        {
            Assert.True(Create(System.Text.Json.JsonSerializer.Deserialize<NewPlaceholderDto>(json)!, out var p, out var error), error);
            return p;
        }

        Assert.Equal("movie|movie|5||", PlaceholderRules.IdentityKey(Make("{\"kind\":\"movie\",\"tmdbId\":5,\"title\":\"x\"}")));
        Assert.Equal("season|tv|7|2|", PlaceholderRules.IdentityKey(Make("{\"kind\":\"season\",\"tmdbId\":7,\"title\":\"x\",\"seasonNumber\":2}")));
        Assert.Equal("episodes|tv|7|2|1,8", PlaceholderRules.IdentityKey(Make("{\"kind\":\"episodes\",\"tmdbId\":7,\"title\":\"x\",\"seasonNumber\":2,\"episodes\":[{\"s\":2,\"e\":8},{\"s\":2,\"e\":1}]}")));
        Assert.Equal(
            PlaceholderRules.IdentityKey(Make("{\"kind\":\"custom\",\"title\":\"The  Batman: Part II!\",\"year\":2027}")),
            PlaceholderRules.IdentityKey(Make("{\"kind\":\"custom\",\"title\":\"the batman part ii\",\"year\":2027}")));
        Assert.Equal("custom|movie|the batman part ii|2027", PlaceholderRules.IdentityKey(Make("{\"kind\":\"custom\",\"title\":\"The Batman - Part II\",\"year\":2027}")));
    }

    [Theory]
    [InlineData("2026-10-10", true)]
    [InlineData("2026-10-09", true)]
    [InlineData("2026-10-11", false)]
    [InlineData(null, false)]
    public void ReleasedMeansTodayOrEarlierAndTbaIsUnreleased(string? date, bool released)
    {
        Assert.Equal(released, PlaceholderRules.IsReleased(new Placeholder { ReleaseDate = date }, Now));
    }
}
