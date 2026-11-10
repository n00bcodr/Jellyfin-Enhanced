using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags;

namespace Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags.Resolution;

/// <summary>Live, caller-filtered inputs for the pure status decision. No remote data is persisted in the tag cache.</summary>
/// <param name="WeeklyRank">The rank came from Seerr's weekly list ("#N This Week"), not TMDB's daily one.</param>
public sealed record PosterStatusContext(DateTimeOffset Now, SeriesSchedule? Schedule = null, int? Rank = null, TagCacheEntry? Series = null, bool WeeklyRank = false);

/// <summary>
/// The statustags.js first-match decision, with the same embedded vocabulary, thresholds and translated labels.
/// Dates use the user's last saved web context; callers without one use the server timezone.
/// </summary>
public static class StatusRules
{
    private sealed record ShortMonth(string Template, string Month);
    private sealed record ShortDate(string Calendar, int DayDigits, string Digits, ShortMonth[] Months);
    private sealed record ShortDateTable(Dictionary<string, ShortDate> Formats, Dictionary<string, string> Locales);
    private sealed record Vocabulary(StatusThresholds Thresholds, Dictionary<string, BadgeDefinition> Badges);
    private sealed record BadgeDefinition(string Kind, string Style, string Label, string? Compact);
    public sealed record StatusThresholds(long DayMs, int AirsWithinDays, int WeekdayWithinDays, int ReturnGapDays,
        int ReturnsWithinDays, int JustAddedDays, int NewReleaseDays, int MinWindowDays, int MaxWindowDays);
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };
    private static readonly ShortDateTable ShortDates = Read<ShortDateTable>("tags.status-short-dates")!;
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
        try { return CultureInfo.GetCultureInfo(NativePosterDateContext.FormattingLocale(name) ?? "en"); }
        catch (CultureNotFoundException) { return CultureInfo.GetCultureInfo("en"); }
    }

    /// <summary>Accept IANA/Windows timezone ids; the server's timezone is the documented fallback.</summary>
    public static TimeZoneInfo TimeZone(string? name)
    {
        name = NativePosterDateContext.TimeZone(name);
        if (name == null) return TimeZoneInfo.Local;
        try { return TimeZoneInfo.FindSystemTimeZoneById(name); }
        catch (Exception ex) when (ex is TimeZoneNotFoundException or InvalidTimeZoneException) { return TimeZoneInfo.Local; }
    }

    /// <summary>One winning status badge, or null. The input entry and parent are already access/spoiler filtered.</summary>
    public static StatusTag? Resolve(TagCacheEntry data, PosterTagSettings settings, PosterStatusContext context)
    {
        if (!settings.Shows(PosterTagGroup.Status)) return null;
        if (data.Type == "BoxSet" && !settings.StatusOnCollections) return null;
        var now = context.Now.ToUnixTimeMilliseconds();
        var today = LocalDate(context.Now, settings.StatusTimeZone);
        var justAddedMs = settings.StatusJustAddedDays * Thresholds.DayMs;
        var newReleaseMs = settings.StatusNewReleaseDays * Thresholds.DayMs;
        var facts = settings.StatusRemoteEnabled ? context.Schedule : null;
        var showNew = settings.StatusNewRelease;
        var showAdded = settings.StatusJustAdded;
        var showSchedule = settings.StatusSchedule;
        var showMilestones = settings.StatusMilestones;
        // A premiere date is a calendar day (Jellyfin stores it at midnight UTC): it is compared with
        // the viewer's own today, so release day starts at local midnight in every time zone.
        bool AiredWithin(long? ms, long windowMs) => PremiereDay(ms) is { } day && day <= today && (long)(today.DayNumber - day.DayNumber) * Thresholds.DayMs <= windowMs;
        var newRelease = AiredWithin(data.PremiereDate, newReleaseMs);
        var comingSoon = PremiereDay(data.PremiereDate) > today;
        // A collection is recreated by library scans (a fresh DateCreated every time), so its newest member's date stands in.
        var addedRecently = Within(data.Type == "BoxSet" ? data.LatestEpisodeAdded : data.DateCreated, now, justAddedMs);
        var newEpisode = Within(data.LatestEpisodeAdded, now, justAddedMs) && data.DateCreated is { } created && now - created > justAddedMs;
        var nextDay = AirDate(facts?.NextAired?.Date);
        var lastDay = AirDate(facts?.LastAired?.Date);
        var daysToNext = nextDay?.DayNumber - today.DayNumber;
        var lastRecently = RecentDay(lastDay, today, newReleaseMs);
        var final = FinalRegularEpisode(data, context.Series, facts);
        var finalRecently = RecentDay(AirDate(final?.Date), today, newReleaseMs);
        StatusTag Badge(string key, string? date = null) => Make(key, settings, date);

        // Leaving soon outranks everything: the item is about to go.
        if (settings.StatusLeaving && data.Leaving is { } leaving && data.Type is "Movie" or "Series" or "Season" or "Episode")
            return LeavingBadge(leaving, settings, context.Now);
        if (data.Type is "Movie" or "Series" && settings.StatusTrending && context.Rank is > 0)
            return Make(context.WeeklyRank ? "trending_week" : "trending_today", settings, rank: context.Rank);
        switch (data.Type)
        {
            case "Movie":
                if (showSchedule && comingSoon) return Badge("coming_soon");
                if (showNew && newRelease) return Badge("new_movie");
                break;
            case "Series":
                if (showSchedule && daysToNext == 0) return Badge("airing_today");
                if (showMilestones && final != null && Ended(facts!.Status) && finalRecently
                    && data.LatestEpisodeIndex is { } index && index.Season == final.Season && index.Episode == final.Episode)
                    return Badge("series_finale");
                if (showMilestones && data.SeasonPremiere is { Season: > 1 } sp && AiredWithin(sp.Aired, newReleaseMs)) return Badge("new_season");
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
                    && Within(span.First, now, justAddedMs) && Within(span.Last, now, justAddedMs) && SeasonComplete(data, facts)) return Badge("complete_season");
                if (showMilestones && data.SeasonPremiere is { } seasonPremiere && AiredWithin(seasonPremiere.Aired, newReleaseMs)) return Badge("season_premiere");
                var season = data.SeasonNumber ?? data.SeasonPremiere?.Season ?? data.LatestEpisodeIndex?.Season;
                if (showMilestones && facts?.LastAired is { } last && lastRecently && season != null && last.Season == season
                    && data.LatestEpisodeIndex is { } latest && latest.Season == season && latest.Episode == last.Episode
                    && LastEndsSeason(facts, latest.IsLast == true)) return Badge("season_finale");
                if (showNew && newEpisode) return Badge("new_episode");
                break;
            case "Episode":
                var aired = PremiereDay(data.PremiereDate) <= today;
                var episodeSeason = data.EpisodeIndex?.Season ?? data.SeasonNumber;
                var episode = data.EpisodeIndex?.Episode ?? data.EpisodeNumber;
                if (showMilestones && aired && episode == 1 && episodeSeason is > 0 && AiredWithin(data.PremiereDate, justAddedMs)) return Badge("season_premiere");
                // A combined file (S01E09-E10) is the finale when it holds the final episode.
                bool Holds(int? number) => episode != null && number >= episode && number <= (data.EpisodeIndex?.EpisodeEnd ?? episode);
                if (showMilestones && aired && final != null && finalRecently && episodeSeason == final.Season
                    && Holds(final.Episode) && Ended(facts!.Status)) return Badge("series_finale");
                if (showMilestones && aired && facts?.LastAired is { } lastEpisode && lastRecently
                    && episodeSeason == lastEpisode.Season && Holds(lastEpisode.Episode) && LastEndsSeason(facts, data.EpisodeIndex?.IsLast == true)) return Badge("season_finale");
                if (showNew && AiredWithin(data.PremiereDate, justAddedMs)) return Badge("new_episode");
                break;
            case "BoxSet":
            case "Video":
                break;
            default:
                return null;
        }
        if (showAdded && addedRecently) return Badge("just_added");
        if (data.Type == "Movie" && settings.StatusScenes)
        {
            if (data.Scenes?.PostCredits == true) return Badge("post_credits");
            if (data.Scenes?.MidCredits == true) return Badge("mid_credits");
        }
        if (data.Type != "Series" || !settings.StatusSeriesStatus) return null;
        if (data.Status == "Continuing") return Badge("returning");
        if (data.Status == "Ended") return Badge(facts?.Status == "Canceled" ? "cancelled" : "ended");
        return facts?.Status switch { "Returning Series" => Badge("returning"), "Ended" => Badge("ended"), "Canceled" => Badge("cancelled"), _ => null };
    }

    /// <summary>
    /// "Leaving in {days}d" by local calendar days (DST-safe), "Leaving tomorrow", "Leaving today",
    /// and "Leaving soon" without a date or once the date has passed (Maintainerr removes it on its next run).
    /// </summary>
    private static readonly long MinLeavingMs = DateTimeOffset.MinValue.AddDays(2).ToUnixTimeMilliseconds();
    private static readonly long MaxLeavingMs = DateTimeOffset.MaxValue.AddDays(-2).ToUnixTimeMilliseconds();

    internal static StatusTag LeavingBadge(TagLeaving leaving, PosterTagSettings settings, DateTimeOffset now)
    {
        // A time no zone conversion can hold (never stored by the refresh, which bounds it) reads as undated.
        if (leaving.DeleteAt is not { } at || at < MinLeavingMs || at > MaxLeavingMs) return Make("leaving_soon", settings);
        var days = LocalDate(DateTimeOffset.FromUnixTimeMilliseconds(at), settings.StatusTimeZone).DayNumber - LocalDate(now, settings.StatusTimeZone).DayNumber;
        return days switch
        {
            < 0 => Make("leaving_soon", settings),
            0 => Make("leaving_today", settings),
            1 => Make("leaving_tomorrow", settings),
            _ => Make("leaving_days", settings, days: days),
        };
    }

    private static bool Ended(string? status) => status is "Ended" or "Canceled";
    private static bool Within(long? value, long now, long window) => value is { } ms && ms <= now + Thresholds.DayMs && now - ms <= window;
    private static bool RecentDay(DateOnly? value, DateOnly today, long window) => value is { } day && day <= today && (today.DayNumber - day.DayNumber) * Thresholds.DayMs <= window;
    private static DateOnly LocalDate(DateTimeOffset instant, TimeZoneInfo zone) => DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(instant, zone).DateTime);

    /// <summary>The calendar day of a premiere date (stored at midnight UTC), or null (premiereDay in statustags.js).</summary>
    private static DateOnly? PremiereDay(long? ms) => ms is { } value ? DateOnly.FromDateTime(DateTimeOffset.FromUnixTimeMilliseconds(value).UtcDateTime) : null;
    private static DateOnly? AirDate(string? value) => DateOnly.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day) ? day : null;
    /// <summary>
    /// Complete Season needs proof (seasonComplete in statustags.js): TMDB's episode count for the season, every one
    /// of them aired (no next episode in it), and the library covering every episode number 1..N (TagAddedSpan.CoveredThrough).
    /// Without TMDB facts, or with a gap anywhere in 1..N, the season is not called complete.
    /// </summary>
    private static bool SeasonComplete(TagCacheEntry data, SeriesSchedule? facts)
    {
        var season = data.SeasonNumber ?? data.LatestEpisodeIndex?.Season;
        if (facts?.SeasonEpisodes is not { } counts || season is not { } number || !counts.TryGetValue(number, out var expected)) return false;
        if (facts.NextAired is { Season: { } nextSeason } && nextSeason <= number) return false;
        if (facts.LastAired is not { Season: { } lastSeason } last || lastSeason < number || (lastSeason == number && last.Episode < expected)) return false;
        // Every episode 1..N present (duplicates and extra numbers cannot fill a gap; a multi-episode file covers its range).
        return data.SeasonAddedSpan?.CoveredThrough >= expected;
    }

    private static bool LastEndsSeason(SeriesSchedule facts, bool isLast) => facts.LastAired is { } last && (last.Type != null
        ? last.Type == "finale" : isLast && (facts.NextAired == null || facts.NextAired.Season > last.Season));

    /// <summary>
    /// TMDB's final regular episode first, so a library holding only S1E3 of an ended ten-episode season never calls
    /// E3 the finale. The caller's regular aggregate only stands in when TMDB names none and its per-season counts
    /// show that episode is the last of the last season. Never an episode's season-local IsLast.
    /// </summary>
    private static SeriesEpisodeRef? FinalRegularEpisode(TagCacheEntry data, TagCacheEntry? parent, SeriesSchedule? facts)
    {
        if (facts == null) return null;
        bool LastOfShow(TagEpisodeIndex index) => facts.SeasonEpisodes is { Count: > 0 } counts && counts.Keys.Max() == index.Season
            && counts[index.Season] == index.Episode;
        // The air date is a calendar date (stored at midnight UTC): keep its day, as TMDB's own dates are kept.
        SeriesEpisodeRef? Regular(TagCacheEntry? entry) => entry?.LatestEpisodeIndex is { Season: > 0 } index && entry.LatestEpisodeAired is { } aired && LastOfShow(index)
            ? new(PremiereDay(aired)!.Value.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), index.Season, index.Episode, null) : null;
        return (facts.LastAired?.Season > 0 ? facts.LastAired : null)
            ?? (facts.LastRegularAired?.Season > 0 ? facts.LastRegularAired : null)
            ?? Regular(parent ?? (data.Type == "Series" ? data : null))
            ?? Regular(data);
    }

    private static string FormatAirDay(DateOnly day, int ahead, PosterTagSettings settings)
    {
        if (ahead == 1) return Translate("calendar_tomorrow", settings.StatusCulture);
        var culture = settings.StatusCulture;
        if (ahead <= Thresholds.WeekdayWithinDays) return culture.DateTimeFormat.GetDayName(day.DayOfWeek);
        return FormatShortDate(day, culture);
    }

    /// <summary>Browser-generated month/day order, literals, calendar and digits for shipped locales.</summary>
    internal static string FormatShortDate(DateOnly day, CultureInfo culture)
    {
        // Walk CultureInfo parents: a variant retains its regional ancestor,
        // and a scripted culture retains that script before language fallback.
        string? key = null;
        for (var ancestor = culture; !string.IsNullOrEmpty(ancestor.Name); ancestor = ancestor.Parent)
        {
            if (ShortDates.Locales.TryGetValue(ancestor.Name, out key)) break;
        }
        var format = ShortDates.Formats[key ?? ShortDates.Locales["en"]];
        System.Globalization.Calendar calendar = format.Calendar switch
        {
            "persian" => new PersianCalendar(),
            "islamic-umalqura" => new UmAlQuraCalendar(),
            "buddhist" => new ThaiBuddhistCalendar(),
            _ => new GregorianCalendar(),
        };
        var date = day.ToDateTime(TimeOnly.MinValue);
        var month = format.Months[calendar.GetMonth(date) - 1];
        var number = calendar.GetDayOfMonth(date).ToString("D" + format.DayDigits, CultureInfo.InvariantCulture);
        var digits = new string(number.Select(d => format.Digits[d - '0']).ToArray());
        return month.Template.Replace("{month}", month.Month, StringComparison.Ordinal).Replace("{day}", digits, StringComparison.Ordinal);
    }

    private static StatusTag Make(string key, PosterTagSettings settings, string? date = null, int? rank = null, int? days = null)
    {
        var definition = Table.Badges[key];
        var label = settings.CompactLabels && definition.Compact != null ? definition.Compact : definition.Label;
        var text = (days.HasValue ? Text(label, settings.StatusCulture, days.Value) : Translate(label, settings.StatusCulture)).Replace("{date}", date ?? string.Empty, StringComparison.Ordinal)
            .Replace("{rank}", rank?.ToString(settings.StatusCulture) ?? string.Empty, StringComparison.Ordinal)
            .Replace("{days}", days?.ToString(settings.StatusCulture) ?? string.Empty, StringComparison.Ordinal);
        return new(key, text, definition.Style);
    }

    /// <summary>Use the same embedded locale resources and English missing-key fallback as JE.t().</summary>
    /// <summary>A web string (js/locales) in the culture, falling back to English, then the key: the vocabulary posters share with the web.</summary>
    internal static string Text(string key, CultureInfo culture) => Translate(key, culture);

    /// <summary>
    /// <see cref="Text(string, CultureInfo)"/> for a count: the `key_one`, `key_few` … form of the count's CLDR
    /// category (<see cref="Shared.Text.PluralRules"/>) in the language the string is written in, else `key_other`,
    /// else the key's own string, by JE.t's rule (js/plugin.js): a form comes from the same locale as the key's
    /// string (English forms for an English fallback, or for any kind of English).
    /// </summary>
    internal static string Text(string key, CultureInfo culture, long count)
    {
        var name = string.IsNullOrEmpty(culture.Name) ? "en" : culture.Name;
        var own = LocaleStrings(name);
        var english = LocaleStrings("en");
        var keyIsOwn = own.TryGetValue(key, out var ownValue) && !string.IsNullOrEmpty(ownValue);
        var source = keyIsOwn ? own : english;
        var language = keyIsOwn ? name : "en";
        var category = Shared.Text.PluralRules.Category(language, count);
        foreach (var variant in new[] { key + "_" + category, key + "_other" })
        {
            if (source.TryGetValue(variant, out var form) && !string.IsNullOrEmpty(form)) return form;
            if (keyIsOwn && name.Split('-')[0].Equals("en", StringComparison.OrdinalIgnoreCase)
                && english.TryGetValue(variant, out var englishForm) && !string.IsNullOrEmpty(englishForm)) return englishForm;
        }

        return Translate(key, culture);
    }

    private static IReadOnlyDictionary<string, string> LocaleStrings(string name)
        => Locales.GetOrAdd(name, static locale => Read<Dictionary<string, string>>("locales." + locale)
            ?? Read<Dictionary<string, string>>("locales." + locale.Split('-')[0]) ?? new Dictionary<string, string>());

    private static string Translate(string key, CultureInfo culture)
    {
        var name = string.IsNullOrEmpty(culture.Name) ? "en" : culture.Name;
        var translations = LocaleStrings(name);
        if (translations.TryGetValue(key, out var value) && !string.IsNullOrEmpty(value)) return value;
        if (name != "en") return Translate(key, CultureInfo.GetCultureInfo("en"));
        return key;
    }

    private static T? Read<T>(string resource)
    {
        using var stream = Infrastructure.Assets.PackedResources.Open(typeof(StatusRules).Assembly, "Jellyfin.Plugin.JellyfinEnhanced.js." + resource + ".json");
        return stream == null ? default : JsonSerializer.Deserialize<T>(stream, JsonOptions);
    }
}
