using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Model;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution;

/// <summary>Live, caller-filtered inputs for the pure status decision. No remote data is persisted in the tag cache.</summary>
public sealed record PosterStatusContext(DateTimeOffset Now, SeriesSchedule? Schedule = null, int? Rank = null, TagCacheEntry? Series = null);

/// <summary>
/// The statustags.js first-match decision, with the same embedded vocabulary, thresholds and translated labels.
/// Dates use the user's last saved web context; callers without one use the server timezone.
/// </summary>
public static class StatusRules
{
    private sealed record Vocabulary(StatusThresholds Thresholds, Dictionary<string, BadgeDefinition> Badges);
    private sealed record BadgeDefinition(string Kind, string Style, string Label, string? Compact);
    public sealed record StatusThresholds(long DayMs, int AirsWithinDays, int WeekdayWithinDays, int ReturnGapDays,
        int ReturnsWithinDays, int JustAddedDays, int NewReleaseDays, int MinWindowDays, int MaxWindowDays);
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };
    private static readonly Vocabulary Table = Read<Vocabulary>("tags.status-vocabulary")!;
    private static readonly ConcurrentDictionary<string, IReadOnlyDictionary<string, string>> Locales = new(StringComparer.OrdinalIgnoreCase);
    public static StatusThresholds Thresholds => Table.Thresholds;

    /// <summary>Known web style ids and their English names, also used by the Tag Styles catalog.</summary>
    public static IReadOnlyList<(string Key, string Name)> StyleLabels { get; } = Table.Badges.Values
        .GroupBy(b => b.Style, StringComparer.Ordinal).Select(g => (g.Key, Translate(g.First().Label, CultureInfo.GetCultureInfo("en"))))
        .Select(p => (p.Key, p.Item2.Replace("#{rank} Today", "Trending", StringComparison.Ordinal))).ToArray();

    /// <summary>A valid culture for relative date formatting; invalid, auto and absent values use English.</summary>
    public static CultureInfo Culture(string? name)
    {
        try { return string.IsNullOrWhiteSpace(name) ? CultureInfo.GetCultureInfo("en") : CultureInfo.GetCultureInfo(name); }
        catch (CultureNotFoundException) { return CultureInfo.GetCultureInfo("en"); }
    }

    /// <summary>Accept IANA/Windows timezone ids; the server's timezone is the documented fallback.</summary>
    public static TimeZoneInfo TimeZone(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return TimeZoneInfo.Local;
        try { return TimeZoneInfo.FindSystemTimeZoneById(name); }
        catch (Exception ex) when (ex is TimeZoneNotFoundException or InvalidTimeZoneException) { return TimeZoneInfo.Local; }
    }

    /// <summary>One winning status badge, or null. The input entry and parent are already access/spoiler filtered.</summary>
    public static StatusTag? Resolve(TagCacheEntry data, PosterTagSettings settings, PosterStatusContext context)
    {
        if (!settings.Shows(PosterTagGroup.Status)) return null;
        var now = context.Now.ToUnixTimeMilliseconds();
        var today = LocalDate(context.Now, settings.StatusTimeZone);
        var justAddedMs = settings.StatusJustAddedDays * Thresholds.DayMs;
        var newReleaseMs = settings.StatusNewReleaseDays * Thresholds.DayMs;
        var facts = settings.StatusRemoteEnabled ? context.Schedule : null;
        var showNew = settings.StatusNewRelease;
        var showAdded = settings.StatusJustAdded;
        var showSchedule = settings.StatusSchedule;
        var showMilestones = settings.StatusMilestones;
        var newRelease = data.PremiereDate is { } premiere && premiere <= now && now - premiere <= newReleaseMs;
        var comingSoon = data.PremiereDate > now;
        var addedRecently = Within(data.DateCreated, now, justAddedMs);
        var newEpisode = Within(data.LatestEpisodeAdded, now, justAddedMs) && data.DateCreated is { } created && now - created > justAddedMs;
        var nextDay = AirDate(facts?.NextAired?.Date);
        var lastDay = AirDate(facts?.LastAired?.Date);
        var daysToNext = nextDay?.DayNumber - today.DayNumber;
        var lastRecently = RecentDay(lastDay, today, newReleaseMs);
        var final = FinalRegularEpisode(data, context.Series, facts, settings.StatusTimeZone);
        var finalRecently = RecentDay(AirDate(final?.Date), today, newReleaseMs);
        StatusTag Badge(string key, string? date = null) => Make(key, settings, date);

        if (data.Type is "Movie" or "Series" && settings.StatusTrending && context.Rank is > 0)
            return Make("trending_today", settings, rank: context.Rank);
        switch (data.Type)
        {
            case "Movie":
                if (showSchedule && comingSoon) return Badge("coming_soon");
                if (showNew && newRelease) return Badge("new_movie");
                break;
            case "Series":
                if (showSchedule && daysToNext == 0) return Badge("airing_today");
                if (showMilestones && final != null && Ended(facts?.Status) && finalRecently
                    && data.LatestEpisodeIndex is { } index && index.Season == final.Season && index.Episode == final.Episode)
                    return Badge("series_finale");
                if (showMilestones && data.SeasonPremiere is { Season: > 1 } sp && sp.Aired <= now && Within(sp.Aired, now, newReleaseMs)) return Badge("new_season");
                if (showSchedule && daysToNext is >= 1 && daysToNext <= Thresholds.AirsWithinDays)
                    return Badge("airs_date", FormatAirDay(nextDay!.Value, daysToNext.Value, settings));
                if (showSchedule && daysToNext is >= 1 && daysToNext <= Thresholds.ReturnsWithinDays
                    && lastDay != null && nextDay!.Value.DayNumber - lastDay.Value.DayNumber > Thresholds.ReturnGapDays)
                    return Badge("returns_date", FormatAirDay(nextDay.Value, daysToNext.Value, settings));
                if (showNew && newEpisode) return Badge("new_episode");
                if (showSchedule && comingSoon) return Badge("coming_soon");
                if (showNew && newRelease) return Badge("new_series");
                break;
            case "Season":
                if (showMilestones && data.SeasonAddedSpan is { Count: > 0 } span && span.First <= span.Last
                    && Within(span.First, now, justAddedMs) && Within(span.Last, now, justAddedMs)) return Badge("complete_season");
                if (showMilestones && data.SeasonPremiere is { } seasonPremiere && seasonPremiere.Aired <= now
                    && Within(seasonPremiere.Aired, now, newReleaseMs)) return Badge("season_premiere");
                var season = data.SeasonNumber ?? data.SeasonPremiere?.Season ?? data.LatestEpisodeIndex?.Season;
                if (showMilestones && facts?.LastAired is { } last && lastRecently && season != null && last.Season == season
                    && data.LatestEpisodeIndex is { } latest && latest.Season == season && latest.Episode == last.Episode
                    && LastEndsSeason(facts, latest.IsLast == true)) return Badge("season_finale");
                if (showNew && newEpisode) return Badge("new_episode");
                break;
            case "Episode":
                var aired = data.PremiereDate != null && data.PremiereDate <= now;
                var episodeSeason = data.EpisodeIndex?.Season ?? data.SeasonNumber;
                var episode = data.EpisodeIndex?.Episode ?? data.EpisodeNumber;
                if (showMilestones && aired && episode == 1 && episodeSeason is > 0 && Within(data.PremiereDate, now, justAddedMs)) return Badge("season_premiere");
                if (showMilestones && aired && final != null && finalRecently && episodeSeason == final.Season
                    && episode == final.Episode && Ended(facts?.Status)) return Badge("series_finale");
                if (showMilestones && aired && facts?.LastAired is { } lastEpisode && lastRecently
                    && episodeSeason == lastEpisode.Season && episode == lastEpisode.Episode && LastEndsSeason(facts, data.EpisodeIndex?.IsLast == true)) return Badge("season_finale");
                if (showNew && ((aired && Within(data.PremiereDate, now, justAddedMs)) || addedRecently)) return Badge("new_episode");
                break;
            case "BoxSet":
            case "Video":
                break;
            default:
                return null;
        }
        if (showAdded && addedRecently) return Badge("just_added");
        if (data.Type != "Series" || !settings.StatusSeriesStatus) return null;
        if (data.Status == "Continuing") return Badge("returning");
        if (data.Status == "Ended") return Badge(facts?.Status == "Canceled" ? "cancelled" : "ended");
        return facts?.Status switch { "Returning Series" => Badge("returning"), "Ended" => Badge("ended"), "Canceled" => Badge("cancelled"), _ => null };
    }

    private static bool Ended(string? status) => status is "Ended" or "Canceled";
    private static bool Within(long? value, long now, long window) => value is { } ms && ms <= now + Thresholds.DayMs && now - ms <= window;
    private static bool RecentDay(DateOnly? value, DateOnly today, long window) => value is { } day && day <= today && (today.DayNumber - day.DayNumber) * Thresholds.DayMs <= window;
    private static DateOnly LocalDate(DateTimeOffset instant, TimeZoneInfo zone) => DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(instant, zone).DateTime);
    private static DateOnly? AirDate(string? value) => DateOnly.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day) ? day : null;
    private static bool LastEndsSeason(SeriesSchedule facts, bool isLast) => facts.LastAired is { } last && (last.Type != null
        ? last.Type == "finale" : isLast && (facts.NextAired == null || facts.NextAired.Season > last.Season));

    /// <summary>Use the caller's regular series aggregate before TMDB, never an episode's season-local IsLast.</summary>
    private static SeriesEpisodeRef? FinalRegularEpisode(TagCacheEntry data, TagCacheEntry? parent, SeriesSchedule? facts, TimeZoneInfo zone)
    {
        if (facts == null) return null;
        SeriesEpisodeRef? Regular(TagCacheEntry? entry) => entry?.LatestEpisodeIndex is { Season: > 0 } index && entry.LatestEpisodeAired is { } aired
            ? new(LocalDate(DateTimeOffset.FromUnixTimeMilliseconds(aired), zone).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), index.Season, index.Episode, null) : null;
        return Regular(parent ?? (data.Type == "Series" ? data : null))
            ?? (facts.LastAired?.Season > 0 ? facts.LastAired : null)
            ?? (facts.LastRegularAired?.Season > 0 ? facts.LastRegularAired : null)
            ?? Regular(data);
    }

    private static string FormatAirDay(DateOnly day, int ahead, PosterTagSettings settings)
    {
        if (ahead == 1) return Translate("status_tag_tomorrow", settings.StatusCulture);
        var culture = settings.StatusCulture;
        if (ahead <= Thresholds.WeekdayWithinDays) return culture.DateTimeFormat.GetDayName(day.DayOfWeek);
        // MonthDayPattern preserves the locale's date ordering without its year.
        var pattern = culture.DateTimeFormat.MonthDayPattern.Replace("MMMM", "MMM", StringComparison.Ordinal).Replace("dd", "d", StringComparison.Ordinal);
        return day.ToString(pattern, culture);
    }

    private static StatusTag Make(string key, PosterTagSettings settings, string? date = null, int? rank = null)
    {
        var definition = Table.Badges[key];
        var label = settings.CompactBands && definition.Compact != null ? definition.Compact : definition.Label;
        var text = Translate(label, settings.StatusCulture).Replace("{date}", date ?? string.Empty, StringComparison.Ordinal)
            .Replace("{rank}", rank?.ToString(settings.StatusCulture) ?? string.Empty, StringComparison.Ordinal);
        return new(key, text, definition.Style);
    }

    /// <summary>Use the same embedded locale resources and English missing-key fallback as JE.t().</summary>
    private static string Translate(string key, CultureInfo culture)
    {
        var name = string.IsNullOrEmpty(culture.Name) ? "en" : culture.Name;
        var translations = Locales.GetOrAdd(name, static locale => Read<Dictionary<string, string>>("locales." + locale)
            ?? Read<Dictionary<string, string>>("locales." + locale.Split('-')[0]) ?? new Dictionary<string, string>());
        if (translations.TryGetValue(key, out var value) && !string.IsNullOrEmpty(value)) return value;
        if (name != "en") return Translate(key, CultureInfo.GetCultureInfo("en"));
        return key;
    }

    private static T? Read<T>(string resource)
    {
        using var stream = typeof(StatusRules).Assembly.GetManifestResourceStream("Jellyfin.Plugin.JellyfinEnhanced.js." + resource + ".json");
        return stream == null ? default : JsonSerializer.Deserialize<T>(stream, JsonOptions);
    }
}
