using Jellyfin.Plugin.JellyfinEnhanced.Services;

namespace JE.Tests;

public class IntegrationDiscoverFiltersTests
{
    private static Func<string, string?> Query(params (string Name, string Value)[] pairs)
    {
        var values = pairs.ToDictionary(pair => pair.Name, pair => pair.Value);
        return name => values.TryGetValue(name, out var value) ? value : null;
    }

    [Fact]
    public void SeerrPathTakesEveryFilterSeerrAcceptsAndNothingElse()
    {
        var path = DiscoverFilters.AppendToSeerrPath("/api/v1/discover/movies?page=2&studio=3", Query(
            ("sortBy", "vote_average.desc"), ("primaryReleaseDateGte", "2010-01-01"), ("voteAverageGte", "7.5"),
            ("voteCountGte", "1000"), ("withRuntimeLte", "120"), ("language", "en|fr"), ("genre", "16,35"),
            ("keywords", "818"), ("excludeKeywords", "9715"), ("watchProviders", "8|337"), ("watchRegion", "US"),
            ("certification", "PG|PG-13"), ("certificationCountry", "US"), ("withCompanies", "1"), ("page", "9")));
        Assert.Equal("/api/v1/discover/movies?page=2&studio=3&sortBy=vote_average.desc&primaryReleaseDateGte=2010-01-01"
            + "&voteAverageGte=7.5&voteCountGte=1000&withRuntimeLte=120&certification=PG%7CPG-13&certificationCountry=US"
            + "&watchRegion=US&language=en%7Cfr&genre=16%2C35&keywords=818&excludeKeywords=9715&watchProviders=8%7C337", path);
    }

    [Fact]
    public void AGenreOrKeywordRouteJoinsTheClientsOwnWithItsOwn()
    {
        Assert.Equal("/api/v1/discover/tv?page=1&genre=16%2C35%2C18&voteAverageGte=7",
            DiscoverFilters.AppendToSeerrPath("/api/v1/discover/tv?page=1&genre=16", Query(("genre", "35,18"), ("voteAverageGte", "7"))));
        Assert.Equal("/api/v1/discover/movies?page=1&keywords=818%2C9715&genre=16",
            DiscoverFilters.AppendToSeerrPath("/api/v1/discover/movies?page=1&keywords=818", Query(("keywords", "9715"), ("genre", "16"))));
        // No filter: the path is the route's own.
        Assert.Equal("/api/v1/discover/tv?page=1&genre=16", DiscoverFilters.AppendToSeerrPath("/api/v1/discover/tv?page=1&genre=16", Query()));
    }

    [Fact]
    public void TmdbTvQueryTranslatesNamesAndLeavesOutWhatIsNotOfItsShape()
    {
        var query = DiscoverFilters.ToTmdbTvQuery(Query(
            ("firstAirDateGte", "2000-01-01"), ("firstAirDateLte", "2009-12-31"), ("voteAverageGte", "8"), ("voteCountGte", "100"),
            ("withRuntimeLte", "30"), ("language", "ja|ko"), ("genre", "16,10759"), ("keywords", "818"), ("excludeKeywords", "9715"),
            ("watchProviders", "8|337"), ("watchRegion", "AU"), ("certification", "TV-PG|TV-14"), ("certificationCountry", "US")));
        Assert.Equal("&first_air_date.gte=2000-01-01&first_air_date.lte=2009-12-31&vote_average.gte=8&vote_count.gte=100"
            + "&with_runtime.lte=30&with_original_language=ja%7Cko&with_genres=16%2C10759&with_keywords=818&without_keywords=9715"
            + "&with_watch_providers=8%7C337&watch_region=AU&certification=TV-PG%7CTV-14&certification_country=US", query);
        // Anything that could change the request's meaning is not of the shape and is dropped.
        Assert.Equal(string.Empty, DiscoverFilters.ToTmdbTvQuery(Query(
            ("firstAirDateGte", "2000-01-01&api_key=x"), ("voteAverageGte", "8;drop"), ("language", "english"), ("genre", "16 OR 1=1"),
            ("watchRegion", "usa"), ("certification", "<script>"), ("primaryReleaseDateGte", "2000-01-01"))));
    }
}
