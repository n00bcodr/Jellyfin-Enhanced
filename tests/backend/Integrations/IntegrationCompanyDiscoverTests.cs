using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services;

namespace JE.Tests;

public class IntegrationCompanyDiscoverTests
{
    [Fact]
    public void PaginationAndTvFieldsAreTranslatedWhileOnlyVisibleLibraryRowsReceiveMediaInfo()
    {
        const string input = "{\"page\":3,\"total_pages\":9,\"total_results\":173,\"results\":[{\"id\":1,\"name\":\"日本語\",\"original_name\":\"Original\",\"poster_path\":\"/p.jpg\",\"vote_average\":7.5,\"genre_ids\":[18]},{\"id\":2,\"name\":\"Other\"},{\"id\":0},{\"id\":\"3\"},null]}";
        Assert.Equal(new[] { 1, 2 }, TmdbCompanyTvDiscover.ReadRowIds(input));
        const string partial = "{\"status\":4,\"seasons\":[{\"seasonNumber\":1,\"status\":5}]}";
        using var doc = JsonDocument.Parse(TmdbCompanyTvDiscover.ToSeerrShape(input, new Dictionary<int, string> { [1] = partial }));
        var root = doc.RootElement;
        Assert.Equal(3, root.GetProperty("page").GetInt32());
        Assert.Equal(9, root.GetProperty("totalPages").GetInt32());
        Assert.Equal(173, root.GetProperty("totalResults").GetInt32());
        var rows = root.GetProperty("results"); Assert.Equal(2, rows.GetArrayLength());
        Assert.Equal("tv", rows[0].GetProperty("mediaType").GetString());
        Assert.Equal("Original", rows[0].GetProperty("originalName").GetString());
        Assert.Equal(7.5, rows[0].GetProperty("voteAverage").GetDouble());
        Assert.Equal(4, rows[0].GetProperty("mediaInfo").GetProperty("status").GetInt32());
        Assert.False(rows[1].TryGetProperty("mediaInfo", out _));
        Assert.False(rows[0].TryGetProperty("original_name", out _));
    }

    [Fact]
    public void EmptyPageUsesDocumentedDefaultsAndLibraryFallbackLinksCorrectItem()
    {
        using var result = JsonDocument.Parse(TmdbCompanyTvDiscover.ToSeerrShape("{}", new Dictionary<int, string>()));
        Assert.Equal(1, result.RootElement.GetProperty("page").GetInt32());
        Assert.Equal(1, result.RootElement.GetProperty("totalPages").GetInt32());
        Assert.Equal(0, result.RootElement.GetProperty("totalResults").GetInt32());
        Assert.Equal(0, result.RootElement.GetProperty("results").GetArrayLength());
        var id = Guid.NewGuid();
        using var info = JsonDocument.Parse(TmdbCompanyTvDiscover.LibraryMediaInfo(id));
        Assert.Equal(5, info.RootElement.GetProperty("status").GetInt32());
        Assert.Equal(id.ToString("N"), info.RootElement.GetProperty("jellyfinMediaId").GetString());
    }

    [Theory]
    [InlineData("{")][InlineData("null")][InlineData("[]")][InlineData("{}")] [InlineData("{\"mediaInfo\":null}")]
    public void InvalidOrAbsentSeerrDetailDoesNotInventAvailability(string json) => Assert.Null(TmdbCompanyTvDiscover.ExtractMediaInfo(json));

    [Fact]
    public void MalformedTmdbJsonIsSurfacedToCallerInsteadOfInventingEmptySuccess()
    {
        Assert.ThrowsAny<JsonException>(() => TmdbCompanyTvDiscover.ReadRowIds("{"));
        Assert.ThrowsAny<JsonException>(() => TmdbCompanyTvDiscover.ToSeerrShape("{", new Dictionary<int, string>()));
    }

    [Theory]
    [InlineData("popularity.desc", true)][InlineData("first_air_date.asc", true)][InlineData("vote_count.desc", true)]
    [InlineData("name.asc", true)][InlineData("original_name.desc", true)][InlineData("popularity.desc&include_adult=true", false)]
    [InlineData("popularity.desc\n", false)][InlineData(null, false)]
    public void SortAllowlistRejectsInjectedQueryOrUnknownSort(string? value, bool allowed) => Assert.Equal(allowed, TmdbCompanyTvDiscover.IsValidSort(value));
}
