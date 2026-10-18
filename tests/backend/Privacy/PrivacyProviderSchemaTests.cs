using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services;

namespace JE.Tests;

/// <summary>Inventory A–K provider contracts. Every incoming key has a disposition, including nested metadata.</summary>
public class PrivacyProviderSchemaTests
{
    private sealed record Schema(string Allowed, string Projected, string Rejected = "");
    // Normalization admits the documented snake_case/camelCase aliases, never unknown field names.
    private static string Key(string value) => value.Replace("_", "").ToLowerInvariant();
    private static readonly Dictionary<string, Schema> Schemas = new()
    {
        ["title"] = new("creditId episodeCount firstCreditAirDate order softcore video languages onUserWatchlist watchProviders collection parts id mediaType type kind key tmdbId adult name title originalName originalTitle originalLanguage language popularity genreIds genres originCountry productionCountries productionCompanies spokenLanguages networks homepage status runtime episodeRunTime numberOfEpisodes numberOfSeasons inProduction belongsToCollection budget revenue imdbId externalIds contentRatings watch/providers mediaInfo year seasons episodes lastEpisodeToAir nextEpisodeToAir recommendations similar",
            "createdBy character job department overview description summary plot tagline taglines voteAverage voteCount rating ratings communityRating criticRating awards posterPath posterUrl poster backdropPath backdropUrl backdrop logoPath logoUrl logo images posters backdrops logos stills releaseDate releaseDateLocal firstAirDate lastAirDate airDate airDateUtc nextAirDate nextDate nextDay digitalReleaseDate theatricalReleaseDate initialAirDate releaseDates releases keywords tags reviews videos relatedVideos credits aggregateCredits content"),
        ["episode"] = new("id tmdbId seasonNumber episodeNumber productionCode runtime showId episodeType crew guestStars",
            "name title originalName originalTitle overview voteAverage voteCount airDate stillPath still images"),
        ["season"] = new("id seasonNumber episodeCount episodes networks", "name overview airDate posterPath voteAverage"), // S1 exemption asserted separately.
        ["person"] = new("alsoKnownAs homepage biography birthday deathday placeOfBirth imdbId id name originalName gender knownForDepartment popularity profilePath adult castId creditId order totalEpisodeCount roles jobs", "character job department knownFor"),
        ["request"] = new("id status type media is4k seasons requestedBy modifiedBy createdAt updatedAt", ""),
        ["user"] = new("id displayName username email avatar jellyfinUsername jellyfinUserId userType", ""),
        ["role"] = new("creditId episodeCount", "character job"),
        ["named"] = new("id name iso6391 englishName iso31661 originCountry logoPath", ""),
        ["media"] = new("id tmdbId tvdbId mediaType status status4k jellyfinMediaId jellyfinMediaId4k jellyfinMediaUrl jellyfinMediaUrl4k createdAt updatedAt lastSeasonChange seasons requests downloadStatus downloadStatus4k serviceId serviceId4k externalServiceId externalServiceId4k mediaAddedAt", ""),
        ["calendar"] = new("id source type title dateOnly releaseType hasFile monitored imdbId itemId itemEpisodeId tvdbId seasonNumber episodeNumber episodeTvdbId episodeImdbId seriesId tmdbId shokoSeriesId shokoEpisodeId instanceName alsoInInstances year",
            "subtitle episodeTitle episodeName overview posterUrl backdropUrl releaseDate releaseDateLocal airDateUtc airDate digitalRelease physicalRelease inCinemas", "arrPath instanceId"),
        ["page"] = new("id page totalPages totalResults results cast crew parts items events requests mine soon ready groups", ""),
        ["image"] = new("iso31661 aspectRatio height width iso6391 voteAverage voteCount filePath", ""),
        ["images"] = new("id", "posters backdrops stills logos"),
        ["credits"] = new("id", "cast crew guestStars"),
        ["videos"] = new("id", "results"),
        ["keywords"] = new("id", "keywords results"),
        ["reviews"] = new("id page totalPages totalResults", "results"),
        ["release_dates"] = new("id", "results"),
        ["content_ratings"] = new("id results iso31661 rating descriptors", ""),
        ["external_ids"] = new("id imdbId tvdbId tvrageId wikidataId facebookId instagramId twitterId freebaseMid freebaseId", ""),
        ["watch/providers"] = new("name id results link flatrate rent buy ads iso31661 displayPriority logoPath providerId providerName", ""),
        ["video"] = new("url id iso6391 iso31661 name key site size type official publishedAt", ""),
        ["review"] = new("id author authorDetails username name avatarPath rating content createdAt updatedAt url", ""),
        ["release"] = new("results iso31661 releaseDates certification descriptors iso6391 note releaseDate type", "")
    };

    private static string Disposition(string schema, string field)
    {
        var spec = Schemas[schema]; var key = Key(field);
        // Country maps have ISO 3166-1 keys; these are data, not extensible response fields.
        if (schema == "watch/providers" && field.Length == 2 && field.All(c => c is >= 'A' and <= 'Z')) return "allowed";
        var matches = new[] { ("allowed", spec.Allowed), ("projected", spec.Projected), ("rejected", spec.Rejected) }
            .Where(group => group.Item2.Split(' ', StringSplitOptions.RemoveEmptyEntries).Select(Key).Contains(key)).Select(group => group.Item1).ToArray();
        Assert.True(matches.Length == 1, $"{schema}.{field}: expected exactly one classification, got {matches.Length}");
        return matches.Single();
    }

    [Fact]
    public void EveryServedCalendarModelKeyIsClassifiedAndSensitiveValuesAreProjected()
    {
        // Reflect the actual served model so an added property fails even before the fixture is updated.
        var model = new ArrItem { Source="Sonarr", Type="Series", TmdbId=42, Title="Entry", EpisodeTitle="secret", Subtitle="S02E03 - secret",
            SeasonNumber=2, EpisodeNumber=3, ReleaseDate="secret", ReleaseDateLocal="secret", DateOnly=true,
            Overview="secret", PosterUrl="/safe-series-poster.jpg", BackdropUrl="secret", ArrPath="server-only", InstanceId="server-only" };
        var raw = JsonSerializer.SerializeToNode(model)!.AsObject();
        var policy = Policy(); var projected = JsonNode.Parse(policy.ProjectResource("["+raw.ToJsonString()+"]", null, "calendar"))![0]!.AsObject();
        foreach (var pair in raw)
        {
            var disposition = Disposition("calendar", pair.Key);
            if (disposition == "projected" && pair.Value != null && pair.Key != "posterUrl") Assert.False(JsonNode.DeepEquals(pair.Value, projected[pair.Key]), pair.Key);
            if (disposition == "allowed" && pair.Key != "subtitle") Assert.True(JsonNode.DeepEquals(pair.Value, projected[pair.Key]), pair.Key);
            Assert.NotEqual("rejected", disposition);
        }
        Assert.Equal("/safe-series-poster.jpg",projected["posterUrl"]?.ToString());
        // Server-only fields are deliberately rejected by serialization.
        Assert.DoesNotContain("server-only", raw.ToJsonString());
        Assert.Equal("rejected", Disposition("calendar", "arrPath")); Assert.Equal("rejected", Disposition("calendar", "instanceId"));
    }

    private static SpoilerPresentationContext Policy() => new(new UserSpoilerBlur { ProviderTitles=new() { ["tv:tmdb:42"]=new(), ["movie:tmdb:42"]=new() } },
        new PluginConfiguration { SpoilerBlurEnabled=true, SpoilerBlurArtwork=true, SpoilerKeepMoviePosters=false, SpoilerReplaceTitle=true,
            SpoilerStripOverview=true, SpoilerStripSeriesOverview=true, SpoilerStripPremiereDate=true, SpoilerStripCast=true,
            SpoilerStripCastMode="All", SpoilerStripRatings=true, SpoilerStripTags=true, SpoilerStripReviews=true, SpoilerStripTaglines=true });

    // Independent provider samples: a field added here MUST get an explicit disposition above.
    public static TheoryData<string, string, string, string> Shapes => new()
    {
        { "tmdb movie", "title", "movie:tmdb:42", """{"id":42,"adult":false,"title":"Entry","original_title":"Entry","original_language":"en","popularity":1,"genre_ids":[1],"overview":"secret","tagline":"secret","vote_average":9,"vote_count":2,"poster_path":"secret","backdrop_path":"secret","release_date":"secret","budget":1,"revenue":1,"runtime":120,"imdb_id":"tt123","status":"Released","homepage":"https://example.com","production_countries":[{"iso_3166_1":"US","name":"US"}],"spoken_languages":[{"iso_639_1":"en","name":"English","english_name":"English"}],"production_companies":[{"id":1,"name":"Studio","logo_path":null,"origin_country":"US"}],"genres":[{"id":1,"name":"Genre"}],"belongs_to_collection":null}""" },
        { "tmdb tv", "title", "tv:tmdb:42", """{"id":42,"name":"Entry","original_name":"Entry","origin_country":["US"],"number_of_episodes":1,"number_of_seasons":1,"episode_run_time":[60],"in_production":true,"first_air_date":"secret","last_air_date":"secret","overview":"secret","networks":[{"id":1,"name":"Network","logo_path":null,"origin_country":"US"}],"seasons":[{"id":1,"season_number":1,"episode_count":1,"name":"Season 1","overview":"First","air_date":"2020-01-01","poster_path":"/first.jpg"}],"last_episode_to_air":{"id":999,"season_number":2,"episode_number":1,"name":"secret","overview":"secret","air_date":"secret","still_path":"secret","vote_average":9,"vote_count":1,"runtime":60,"show_id":42,"production_code":"X","episode_type":"standard"}}""" },
        { "seerr movie/tv details", "title", "tv:tmdb:42", """{"id":42,"mediaType":"tv","name":"Entry","originalName":"Entry","originalLanguage":"en","overview":"secret","posterPath":"/entry.jpg","backdropPath":"secret","logoPath":"secret","firstAirDate":"secret","lastAirDate":"secret","voteAverage":9,"voteCount":1,"tagline":"secret","mediaInfo":{"id":1,"tmdbId":42,"tvdbId":123,"mediaType":"tv","status":1,"status4k":1,"jellyfinMediaId":null,"jellyfinMediaId4k":null,"createdAt":"2020-01-01","updatedAt":"2020-01-01","seasons":[],"requests":[]},"credits":{"cast":[{"id":1,"name":"Person","character":"secret","profilePath":"/person.jpg"}],"crew":[]},"keywords":[{"id":1,"name":"secret"}],"relatedVideos":[{"id":"v","name":"secret","key":"secret","site":"YouTube","type":"Trailer"}]}""" },
        { "native title cards", "title", "movie:tmdb:42", """{"id":42,"mediaType":"movie","title":"Entry","overview":"secret","posterPath":"secret","backdropPath":"secret","voteAverage":9,"voteCount":1,"releaseDate":"secret","genreIds":[1],"character":"secret","job":"secret","department":"secret"}""" },
        { "sonarr calendar", "calendar", "tv:tmdb:42", """{"id":"sonarr|x|999","source":"Sonarr","type":"Series","tmdbId":42,"title":"Entry","subtitle":"S02E03 - secret","seasonNumber":2,"episodeNumber":3,"episode_title":"secret","overview":"secret","releaseDate":"secret","releaseDateLocal":"secret","airDateUtc":"secret","posterUrl":"/safe-series-poster.jpg","backdropUrl":"secret","dateOnly":true,"releaseType":"Episode","hasFile":false,"monitored":true}""" },
        { "radarr calendar", "calendar", "movie:tmdb:42", """{"id":"radarr|x|999-digital","source":"Radarr","type":"Movie","tmdbId":42,"title":"Entry","subtitle":"2020","releaseDate":"secret","releaseDateLocal":"secret","physicalRelease":"secret","digitalRelease":"secret","inCinemas":"secret","overview":"secret","posterUrl":"secret","backdropUrl":"secret","dateOnly":true,"releaseType":"Digital","hasFile":false,"monitored":true}""" }
    };

    [Theory]
    [MemberData(nameof(Shapes))]
    public void EveryKeyOfEveryProviderShapeHasAnEnforcedDisposition(string name, string schema, string title, string json)
    {
        var raw = JsonNode.Parse(json)!.AsObject(); Classify(raw, schema, name);
        var projected = schema == "calendar" ? JsonNode.Parse(Policy().ProjectResource("["+json+"]", null, "calendar"))![0] : JsonNode.Parse(Policy().ProjectResource(json,title,"title"));
        Assert.DoesNotContain("secret", projected!.ToJsonString());
        foreach (var pair in raw)
            if (Disposition(schema,pair.Key) == "allowed" && pair.Value is JsonValue && pair.Key != "subtitle")
                Assert.True(JsonNode.DeepEquals(pair.Value,projected[pair.Key]), $"{name}.{pair.Key} allowed value changed");
    }

    internal static void Classify(JsonObject obj, string schema, string path)
    {
        foreach (var pair in obj)
        {
            Disposition(schema, pair.Key);
            var childSchema = Key(pair.Key) switch
            {
                "lastepisodetoair" or "nextepisodetoair" or "episodes" => "episode", "seasons" => schema == "media" ? "media" : "season",
                "mediainfo" or "media" => "media", "requests" => "request", "requestedby" or "modifiedby" => "user",
                "results" => schema switch { "page" => "title", "release_dates" => "release", "videos" => "video", "keywords" => "named", "reviews" => "review", _ => schema },
                "releasedates" or "releases" => "release", "externalids" => "external_ids", "contentratings" => "content_ratings",
                "parts" or "knownfor" => "title", "createdby" => "person", "credits" or "aggregatecredits" => "credits", "cast" or "crew" => schema == "page" ? "title" : "person",
                "gueststars" => "person", "watchproviders" => "watch/providers", "collection" => "title",
                "roles" or "jobs" => "role", "images" => "images", "posters" or "backdrops" or "stills" or "logos" => "image",
                "relatedvideos" => "video", "keywords" => "named", "productioncountries" or "productioncompanies" or "spokenlanguages" or "networks" or "genres" => "named",
                _ => schema
            };
            if (pair.Value is JsonObject child) Classify(child,childSchema,path+"."+pair.Key);
            else if (pair.Value is JsonArray rows) foreach (var row in rows.OfType<JsonObject>()) Classify(row,childSchema,path+"."+pair.Key+"[]");
        }
    }

    [Fact]
    public void CapturedPublicTmdbAndSeerrContractsClassifyEveryNestedKey()
    {
        var samples = JsonNode.Parse(Resource("Public"))!.AsArray();
        Assert.True(samples.Count >= 21);
        foreach (var sample in samples)
            Classify(sample!["body"]!.AsObject(),sample["schema"]!.ToString(),sample["route"]!.ToString());
    }

    [Fact]
    public void ExistingNativeSourceFixturesAlsoRequireClassificationForEveryKey()
    {
        var source = Resource("Native");
        var fixtures = System.Text.RegularExpressions.Regex.Matches(source, "private const string (\\w+Json) = \"\"\"(.*?)\"\"\";", System.Text.RegularExpressions.RegexOptions.Singleline);
        Assert.True(fixtures.Count >= 6);
        foreach (System.Text.RegularExpressions.Match fixture in fixtures)
        {
            var name = fixture.Groups[1].Value;
            var schema = name == "PersonJson" ? "person" : name == "SeasonJson" ? "season" : name == "RecsJson" ? "page" : "title";
            Classify(JsonNode.Parse(fixture.Groups[2].Value)!.AsObject(),schema,name);
        }
    }

    private static string Resource(string name)
    {
        using var stream = typeof(PrivacyProviderSchemaTests).Assembly.GetManifestResourceStream("JE.Tests.ProviderContracts."+name);
        Assert.NotNull(stream);
        using var reader = new StreamReader(stream!);
        return reader.ReadToEnd();
    }

    [Fact]
    public void AnUnclassifiedNewProviderKeyFailsTheContract()
    {
        Assert.ThrowsAny<Xunit.Sdk.XunitException>(() => Classify(JsonNode.Parse("""{"id":42,"new_spoiler_field":"secret"}""")!.AsObject(),"title","tmdb"));
    }
}
