using System.Globalization;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution;

namespace JE.Tests;

/// <summary>Native score numbers follow the user's locale with the web's Intl decimal separator and digits.</summary>
[Collection("Plugin singleton")]
public class ScoreNumbersTests
{
    [Theory]
    [InlineData("en", "8.1", "8.1")]
    [InlineData("en-GB", "81%", "81%")]
    [InlineData("de", "8.1", "8,1")]
    [InlineData("de-CH", "8.1", "8.1")]
    [InlineData("fr-CA", "4.1", "4,1")]
    [InlineData("pt-BR", "7.5", "7,5")]
    [InlineData("ar", "8.1", "8.1")]
    [InlineData("ar-SA", "8.1", "٨٫١")]
    [InlineData("fa", "81%", "۸۱%")]
    [InlineData("he", "8.1", "8.1")]
    [InlineData("de", "—", "—")]
    public void ScoresUseTheLocalesDecimalSeparatorAndDigits(string locale, string text, string expected)
        => Assert.Equal(expected, ScoreNumbers.Localize(text, CultureInfo.GetCultureInfo(locale)));

    [Fact]
    public void RatingChipsAndDigestsFollowTheSavedLocaleWhileEnglishTokensStayTheSame()
    {
        var entry = new TagCacheEntry { Type = "Movie", CommunityRating = 8.1f, CriticRating = 93 };
        PosterTagSettings Settings(string? locale) => PosterTagSettings.FromUserSettings(new() { RatingTagsEnabled = true, NativePosterDateLocale = locale }, new PluginConfiguration(), null);
        string[] Texts(PosterTagSettings settings) => RatingRules.ResolveScores(entry, settings).OfType<RatingTag>().Select(t => t.Text).ToArray();
        Assert.Equal(new[] { "93%", "8.1" }, Texts(Settings(null)));
        Assert.Equal(new[] { "93%", "8,1" }, Texts(Settings("de-DE")));
        Assert.Equal(Settings(null).Digest, Settings("en-US").Digest);
        Assert.NotEqual(Settings(null).Digest, Settings("de-DE").Digest);
    }
}

/// <summary>Native chip words (Dual/Multi, Mixed, editions) come from the same vocabulary the web translates.</summary>
[Collection("Plugin singleton")]
public class NativeChipVocabularyTests
{
    [Fact]
    public void CountBadgeKeepsItsStyleKeyAndDrawsTheVocabularyText()
    {
        var entry = new TagCacheEntry { Type = "Movie", AudioLanguages = ["eng", "fre", "ger"] };
        foreach (var locale in new[] { "en-US", "de-DE", "ar-SA" })
        {
            var settings = PosterTagSettings.FromUserSettings(new() { LanguageTagsEnabled = true, LanguageTagsCountBadge = "only", NativePosterDateLocale = locale }, new PluginConfiguration(), null);
            var badge = Assert.Single(LanguageFlagRules.ResolveGroup(entry, settings)!.OfType<LanguageTag>(), t => t.CountBadge != null);
            Assert.Equal("Multi", badge.CountBadge);
            Assert.Equal(StatusRules.Text("language_tags_multi", settings.StatusCulture), badge.CountBadgeText);
        }
    }

    [Fact]
    public void VocabularyFallsBackToEnglishThenTheKey()
    {
        Assert.Equal("Dual", StatusRules.Text("language_tags_dual", CultureInfo.GetCultureInfo("en")));
        Assert.Equal(StatusRules.Text("calendar_tomorrow", CultureInfo.GetCultureInfo("de")), StatusRules.Text("calendar_tomorrow", CultureInfo.GetCultureInfo("de-AT")));
        Assert.NotEqual(StatusRules.Text("calendar_tomorrow", CultureInfo.GetCultureInfo("en")), StatusRules.Text("calendar_tomorrow", CultureInfo.GetCultureInfo("de")));
        Assert.Equal("no_such_key", StatusRules.Text("no_such_key", CultureInfo.GetCultureInfo("de")));
    }
}

/// <summary>Premiere dates are calendar days in the viewer's time zone, not UTC instants.</summary>
[Collection("Plugin singleton")]
public class StatusPremiereDayTests
{
    [Theory]
    [InlineData("Australia/Sydney", "2026-11-04T21:00:00Z", "new_movie")]    // 08:00 on release day in Sydney
    [InlineData("Australia/Sydney", "2026-11-05T09:00:00Z", "new_movie")]    // 20:00 on release day
    [InlineData("Australia/Sydney", "2026-11-04T12:59:00Z", "coming_soon")]  // 23:59 the day before
    [InlineData("UTC", "2026-11-04T21:00:00Z", "coming_soon")]
    [InlineData("UTC", "2026-11-05T00:00:00Z", "new_movie")]
    [InlineData("America/Los_Angeles", "2026-11-05T15:00:00Z", "new_movie")]   // 07:00 on release day
    [InlineData("America/Los_Angeles", "2026-11-05T07:00:00Z", "coming_soon")] // 23:00 the day before
    public void ReleaseDayStartsAtLocalMidnight(string zone, string now, string expected)
    {
        var config = new PluginConfiguration { StatusTagsEnabled = true };
        var settings = PosterTagSettings.FromUserSettings(new() { StatusTagsEnabled = true, NativePosterTimeZone = zone }, config, null);
        var entry = new TagCacheEntry { Type = "Movie", PremiereDate = DateTimeOffset.Parse("2026-11-05T00:00:00Z").ToUnixTimeMilliseconds() };
        Assert.Equal(expected, StatusRules.Resolve(entry, settings, new(DateTimeOffset.Parse(now)))?.Key);
    }

    /// <summary>
    /// A new season dated 5 November: at 16:30 UTC on 4 November it is already 00:30 on the 5th in Perth,
    /// so the series facts carry the premiere and Perth shows New Season while Los Angeles (still the 4th) does not.
    /// </summary>
    [Theory]
    [InlineData("Australia/Perth", "2026-11-04T16:30:00Z", "new_season")]
    [InlineData("Pacific/Kiritimati", "2026-11-04T10:30:00Z", "new_season")] // UTC+14: 00:30 on the 5th
    [InlineData("America/Los_Angeles", "2026-11-04T16:30:00Z", null)]
    [InlineData("UTC", "2026-11-04T16:30:00Z", null)]
    [InlineData("America/Los_Angeles", "2026-11-05T08:30:00Z", "new_season")]
    public void ASeasonPremiereCountsFromTheViewersOwnMidnight(string zone, string now, string? expected)
    {
        var at = DateTimeOffset.Parse(now);
        var facts = new StatusTagsEpisodeFacts(false, null, at.UtcDateTime);
        facts.Note(Guid.NewGuid(), at.UtcDateTime.AddDays(-400), DateTime.Parse("2025-09-01T00:00:00Z").ToUniversalTime(), 1, 1);
        facts.Note(Guid.NewGuid(), at.UtcDateTime.AddDays(-1), DateTime.Parse("2026-11-05T00:00:00Z").ToUniversalTime(), 2, 1);
        var entry = new TagCacheEntry { Type = "Series" };
        facts.ApplyTo(entry);
        Assert.Equal(2, entry.SeasonPremiere?.Season);
        var config = new PluginConfiguration { StatusTagsEnabled = true };
        var settings = PosterTagSettings.FromUserSettings(new() { StatusTagsEnabled = true, NativePosterTimeZone = zone }, config, null);
        Assert.Equal(expected, StatusRules.Resolve(entry, settings, new(at))?.Key);
    }

    [Fact]
    public void AFuturePremiereRefreshesWhenItsDayFirstBeginsThenAtItsInstant()
    {
        var premiere = DateTime.Parse("2026-11-05T00:00:00Z").ToUniversalTime();
        var early = new StatusTagsEpisodeFacts(false, null, DateTime.Parse("2026-11-03T12:00:00Z").ToUniversalTime());
        early.Note(Guid.NewGuid(), DateTime.UtcNow, premiere, 2, 1);
        Assert.Equal(new DateTimeOffset(premiere.AddHours(-14)).ToUnixTimeMilliseconds(), early.NextPremiere);
        Assert.Null(early.SeasonPremiere);
        var late = new StatusTagsEpisodeFacts(false, null, DateTime.Parse("2026-11-04T16:30:00Z").ToUniversalTime());
        late.Note(Guid.NewGuid(), DateTime.UtcNow, premiere, 2, 1);
        Assert.Equal(new DateTimeOffset(premiere).ToUnixTimeMilliseconds(), late.NextPremiere);
        Assert.Equal(2, late.SeasonPremiere?.Season);
    }
}

/// <summary>Complete Season and Series Finale need proof: every episode 1..N present, and a finale identity TMDB confirms.</summary>
[Collection("Plugin singleton")]
public class StatusCompletionProofTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-11-05T12:00:00Z");

    private static TagCacheEntry Season(params (int Start, int? End)[] episodes)
    {
        var facts = new StatusTagsEpisodeFacts(true, 1, Now.UtcDateTime);
        foreach (var (start, end) in episodes)
            facts.Note(Guid.NewGuid(), Now.UtcDateTime.AddDays(-1), Now.UtcDateTime.AddDays(-30 + start), 1, start, end);
        var entry = new TagCacheEntry { Type = "Season", SeasonNumber = 1, DateCreated = Now.AddYears(-1).ToUnixTimeMilliseconds() };
        facts.ApplyTo(entry);
        return entry;
    }

    private static string? Badge(TagCacheEntry entry, SeriesSchedule schedule)
    {
        var settings = PosterTagSettings.FromUserSettings(new() { StatusTagsEnabled = true, NativePosterTimeZone = "UTC" }, new PluginConfiguration { StatusTagsEnabled = true, TMDB_API_KEY = "key" }, null);
        return StatusRules.Resolve(entry, settings, new(Now, schedule))?.Key;
    }

    private static readonly SeriesSchedule TenEpisodes = new("Ended", new("2026-10-15", 1, 10, null), null, SeasonEpisodes: new Dictionary<int, int> { [1] = 10 });

    [Fact]
    public void EveryEpisodeOneToTenMakesACompleteSeason()
        => Assert.Equal("complete_season", Badge(Season(Enumerable.Range(1, 10).Select(n => (n, (int?)null)).ToArray()), TenEpisodes));

    [Theory]
    [InlineData(new[] { 1, 1, 3, 4, 5, 6, 7, 8, 9, 10 })]   // a duplicate stands where episode 2 should be
    [InlineData(new[] { 1, 3, 4, 5, 6, 7, 8, 9, 10, 11 })]  // an extra number past the end
    [InlineData(new[] { 1, 2, 3, 4, 6, 7, 8, 9, 10 })]      // episode 5 missing
    public void ExtraOrDuplicateRowsNeverFillAGap(int[] numbers)
    {
        var entry = Season(numbers.Select(n => (n, (int?)null)).ToArray());
        Assert.True(entry.SeasonAddedSpan!.CoveredThrough < 10);
        Assert.NotEqual("complete_season", Badge(entry, TenEpisodes));
    }

    [Fact]
    public void MultiEpisodeFilesCoverTheirRange()
    {
        var entry = Season((1, 2), (3, 4), (5, 6), (7, 8), (9, 10));
        Assert.Equal(10, entry.SeasonAddedSpan!.CoveredThrough);
        Assert.Equal("complete_season", Badge(entry, TenEpisodes));
    }

    [Theory]
    [InlineData(3, false)]
    [InlineData(10, true)]
    public void WithoutTmdbsFinaleTheLibraryEpisodeMustBeTheLastOfTheLastSeason(int latest, bool finale)
    {
        var series = new TagCacheEntry { Type = "Series", DateCreated = Now.AddYears(-1).ToUnixTimeMilliseconds(),
            LatestEpisodeIndex = new() { Season = 1, Episode = latest }, LatestEpisodeAired = Now.AddDays(-2).ToUnixTimeMilliseconds() };
        var ended = new SeriesSchedule("Ended", null, null, SeasonEpisodes: new Dictionary<int, int> { [1] = 10 });
        Assert.Equal(finale, Badge(series, ended) == "series_finale");
        Assert.NotEqual("series_finale", Badge(series, new SeriesSchedule("Ended", null, null)));
    }
}

/// <summary>Combined episode files and library finale dates keep their real episode range and calendar day.</summary>
[Collection("Plugin singleton")]
public class StatusEpisodeRangeTests
{
    [Fact]
    public void ACombinedFileEndsOnItsLastEpisode()
    {
        var now = DateTime.Parse("2026-11-05T12:00:00Z").ToUniversalTime();
        var facts = new StatusTagsEpisodeFacts(true, 1, now);
        for (var start = 1; start <= 9; start += 2) facts.Note(Guid.NewGuid(), now.AddDays(-1), now.AddDays(-20 + start), 1, start, start + 1);
        var entry = new TagCacheEntry { Type = "Season", SeasonNumber = 1 };
        facts.ApplyTo(entry);
        Assert.Equal(10, entry.SeasonAddedSpan!.CoveredThrough);
        Assert.Equal(new TagEpisodeIndex { Season = 1, Episode = 10, IsLast = true }, entry.LatestEpisodeIndex);
        Assert.Equal(1, entry.SeasonPremiere?.Season); // the E1–E2 file still opens the season
    }

    /// <summary>S1E10 dated 29 October is the finale everywhere on 5 November inside a seven-day window, and nowhere after it.</summary>
    [Theory]
    [InlineData("UTC", "2026-11-05T17:00:00Z", true)]
    [InlineData("America/Los_Angeles", "2026-11-05T17:00:00Z", true)]
    [InlineData("Australia/Perth", "2026-11-05T12:00:00Z", true)]   // 20:00 on 5 November in Perth
    [InlineData("America/Los_Angeles", "2026-11-06T09:00:00Z", false)] // 6 November local: past the window
    public void TheLibraryFinaleKeepsItsCalendarDay(string zone, string now, bool finale)
    {
        var series = new TagCacheEntry { Type = "Series", DateCreated = DateTimeOffset.Parse("2025-01-01T00:00:00Z").ToUnixTimeMilliseconds(),
            LatestEpisodeIndex = new() { Season = 1, Episode = 10 }, LatestEpisodeAired = DateTimeOffset.Parse("2026-10-29T00:00:00Z").ToUnixTimeMilliseconds() };
        var schedule = new SeriesSchedule("Ended", new("2026-10-30", 0, 1, null), null, SeasonEpisodes: new Dictionary<int, int> { [1] = 10 });
        var settings = PosterTagSettings.FromUserSettings(new() { StatusTagsEnabled = true, NativePosterTimeZone = zone }, new PluginConfiguration { StatusTagsEnabled = true, StatusTagsNewReleaseDays = 7, TMDB_API_KEY = "key" }, null);
        Assert.Equal(finale, StatusRules.Resolve(series, settings, new(DateTimeOffset.Parse(now), schedule))?.Key == "series_finale");
    }
}

public class UserReviewKeyTests
{
    [Theory]
    [InlineData("Movie", "603", null, null, null, "movie:603")]
    [InlineData("Series", "1399", null, null, null, "tv:1399")]
    [InlineData("Season", null, "1399", 1, null, "tv:1399:s1")]
    [InlineData("Episode", null, "1399", 1, 2, "tv:1399:s1:e2")]
    [InlineData("Season", null, null, 1, null, null)]
    [InlineData("Episode", null, "1399", 1, null, null)]
    [InlineData("BoxSet", "10", null, null, null, null)]
    public void SeasonsAndEpisodesTakeTheirSeriesTmdbIdAndNumbers(string type, string? tmdb, string? series, int? season, int? episode, string? expected)
    {
        var entry = new TagCacheEntry { Type = type, TmdbId = tmdb, SeriesTmdbId = series, SeasonNumber = season, EpisodeNumber = episode };
        Assert.Equal(expected, PosterTagReviewRatings.ReviewKey(entry));
        var settings = PosterTagSettings.FromSettingsJson("{\"RatingTagsEnabled\":true}", new PluginConfiguration { ShowUserReviews = true, ShowUserRatingOnPosters = true });
        Assert.True(settings.UserReviewChipEnabled);
        Assert.Equal(expected != null, RatingRules.ResolveUserReview(entry, settings, 4) != null);
    }
}
