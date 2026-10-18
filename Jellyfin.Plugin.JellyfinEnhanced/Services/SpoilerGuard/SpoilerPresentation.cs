using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Http;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services;

/// <summary>Builds one provider-aware spoiler context for a viewer, after access filtering and before presentation caches.</summary>
public sealed class SpoilerPresentation(UserConfigurationManager config, ILibraryManager library, IUserManager users, IUserDataManager userData)
{
    /// <summary>Loads strictly once per request. Unknown policy suppresses sensitive presentation.</summary>
    public SpoilerPresentationContext Load(Guid viewer, HttpContext? http = null)
    {
        var key = "__JE_SPOILER_PRESENTATION_" + viewer.ToString("N");
        if (http?.Items.TryGetValue(key, out var hit) == true && hit is SpoilerPresentationContext cached) return cached;
        var plugin = JellyfinEnhanced.Instance?.Configuration ?? new();
        SpoilerPresentationContext context;
        try
        {
            UserSpoilerBlur state;
            lock (config.GetUserFileLock(viewer.ToString("N"), SpoilerBlurImageFilter.SpoilerBlurFileName))
                state = config.GetUserConfigurationStrict<UserSpoilerBlur>(viewer.ToString("N"), SpoilerBlurImageFilter.SpoilerBlurFileName, quarantineCorrupt: false);
            context = new(state, plugin);
            if (plugin.SpoilerBlurEnabled)
            {
                var ids = state.Series.Keys.Concat(state.Movies.Keys).Select(id => Guid.TryParse(id, out var guid) ? guid : Guid.Empty)
                    .Where(id => id != Guid.Empty).Distinct().ToArray();
                var person = users.GetUserById(viewer);
                if (ids.Length > 0 && person != null)
                {
                    foreach (var batch in ids.Chunk(2000))
                    {
                        var items = library.GetItemList(new InternalItemsQuery { ItemIds = batch,
                            DtoOptions = new DtoOptions(false) { Fields = new[] { ItemFields.ProviderIds } } });
                        foreach (var item in items)
                        {
                            if (item is not (Movie or Series)) continue;
                            var title = HiddenContentPolicy.TitleIdentity(item is Movie ? "movie" : "tv", item.GetProviderId(MetadataProvider.Tmdb));
                            if (title == null) continue;
                            var watched = item is Movie && userData.GetUserData(person, item)?.Played == true;
                            context.AddLibraryTitle(title, watched);
                        }
                    }
                }
                // Collection membership is resolved once for the whole context, never once per result card.
                var collections = state.Collections.Keys.Select(id => Guid.TryParse(id, out var guid) ? guid : Guid.Empty).Where(id => id != Guid.Empty).ToArray();
                if (collections.Length > 0 && person != null)
                    foreach (var batch in collections.Distinct().Chunk(2000))
                    foreach (var item in library.GetItemList(new InternalItemsQuery { AncestorIds = batch, Recursive = true,
                        IncludeItemTypes = new[] { BaseItemKind.Movie }, DtoOptions = new DtoOptions(false) { Fields = new[] { ItemFields.ProviderIds } } }))
                    {
                        var title = HiddenContentPolicy.TitleIdentity("movie", item.GetProviderId(MetadataProvider.Tmdb));
                        if (title != null) context.AddLibraryTitle(title, userData.GetUserData(person, item)?.Played == true);
                    }
            }
        }
        catch (Exception) { context = new(new(), plugin, unavailable: true); }
        context.Seal();
        if (http != null) http.Items[key] = context;
        return context;
    }
}

/// <summary>Effective strip decisions shared by JSON feeds, missing rows, native pages, metadata and art.</summary>
public sealed class SpoilerPresentationContext
{
    private readonly HashSet<string> _titles = new(StringComparer.Ordinal);
    private readonly HashSet<string> _watched = new(StringComparer.Ordinal);
    private readonly PluginConfiguration _config;
    private readonly bool _unavailable;
    internal bool Unavailable => _unavailable;

    /// <summary>The viewer's state; callers pass it to the existing native DTO stripper.</summary>
    public UserSpoilerBlur State { get; }

    /// <summary>A fingerprint of the full viewer and admin spoiler policy, stable across restarts.</summary>
    public string Revision { get; private set; }

    /// <summary>Creates a context; no shared upstream objects are modified.</summary>
    public SpoilerPresentationContext(UserSpoilerBlur state, PluginConfiguration config, bool unavailable = false)
    {
        State = Newtonsoft.Json.JsonConvert.DeserializeObject<UserSpoilerBlur>(Newtonsoft.Json.JsonConvert.SerializeObject(state))!;
        _config = new PluginConfiguration { SpoilerBlurEnabled = config.SpoilerBlurEnabled, SpoilerBlurArtwork = config.SpoilerBlurArtwork,
            SpoilerKeepMoviePosters = config.SpoilerKeepMoviePosters, SpoilerBlurIntensity = config.SpoilerBlurIntensity, SpoilerBlurMode = config.SpoilerBlurMode,
            SpoilerStripOverview = config.SpoilerStripOverview, SpoilerStripSeriesOverview = config.SpoilerStripSeriesOverview,
            SpoilerStripRatings = config.SpoilerStripRatings, SpoilerStripCast = config.SpoilerStripCast, SpoilerStripTags = config.SpoilerStripTags,
            SpoilerStripCastMode = config.SpoilerStripCastMode,
            SpoilerStripPremiereDate = config.SpoilerStripPremiereDate, SpoilerStripTaglines = config.SpoilerStripTaglines,
            SpoilerStripReviews = config.SpoilerStripReviews, SpoilerReplaceTitle = config.SpoilerReplaceTitle };
        state = State; config = _config; _unavailable = unavailable;
        foreach (var key in state.PendingTmdb.Keys)
        {
            var parts = key.Split(':');
            if (parts.Length == 2 && HiddenContentPolicy.TitleIdentity(parts[0], parts[1]) is { } title) _titles.Add(title);
        }
        foreach (var key in state.ProviderTitles.Keys) if (HiddenContentPolicy.CanonicalTitle(key) is { } title) _titles.Add(title);
        // No lists or names go into the public revision, only a one-way policy fingerprint.
        Revision = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Newtonsoft.Json.JsonConvert.SerializeObject(new {
            state, config.SpoilerBlurEnabled, config.SpoilerBlurArtwork, config.SpoilerKeepMoviePosters, config.SpoilerBlurIntensity,
            config.SpoilerBlurMode, config.SpoilerStripOverview, config.SpoilerStripSeriesOverview, config.SpoilerStripRatings,
            config.SpoilerStripCast, config.SpoilerStripCastMode, config.SpoilerStripTags, config.SpoilerStripPremiereDate, config.SpoilerStripTaglines,
            config.SpoilerStripReviews, config.SpoilerReplaceTitle, unavailable
        }))));
    }

    internal void Seal() => Revision = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Revision + "|" + string.Join(',', _titles.OrderBy(k => k, StringComparer.Ordinal)) + "|" + string.Join(',', _watched.OrderBy(k => k, StringComparer.Ordinal)))));

    internal void AddLibraryTitle(string key, bool watched) { if (watched) _watched.Add(key); else _titles.Add(key); }

    internal bool KnowsTitle(string? title) => title != null && (_titles.Contains(title) || _watched.Contains(title));

    /// <summary>Each result is judged by its own typed identity, never by the seed's guard.</summary>
    public bool Guarded(string? title) => _config.SpoilerBlurEnabled && (_unavailable || title != null && _titles.Contains(title) && !_watched.Contains(title));

    /// <summary>Existing admin caps and per-user opt-outs, including the separate series-description policy.</summary>
    public (bool Title, bool Overview, bool AirDate) MissingRow(string? title)
        => Guarded(title) ? SpoilerFieldStripFilter.AbsentRowStrip(State, _config) : (false, false, false);

    /// <summary>Ratings/reviews/date decorators use the same effective cap and preference decisions.</summary>
    public bool HidesRatings(string? title) => Guarded(title) && Strip(_config.SpoilerStripRatings, State.Prefs?.HideRatings);
    public bool HidesReviews(string? title) => Guarded(title) && Strip(_config.SpoilerStripReviews, State.Prefs?.HideReviews);
    public bool HidesDates(string? title) => Guarded(title) && Strip(_config.SpoilerStripPremiereDate, State.Prefs?.HideAirDate);

    /// <summary>Flags for clients and record-based feeds; contains no private rule lists.</summary>
    public JsonObject Flags(string title)
    {
        var row = new JsonObject();
        ProjectTitle(row, title, title.StartsWith("movie:", StringComparison.Ordinal) ? "movie" : "tv");
        return (JsonObject)row["jeSpoiler"]!.DeepClone();
    }

    /// <summary>Known provider subresources have distinct schemas and must not bypass the title strip.</summary>
    public string ProjectResource(string json, string? title, string resource, string? fallbackKind = null, string? scopeKind = null, int season = 0, int episode = 0)
    {
        if (resource is "content_ratings" or "watch/providers" or "external_ids") return json;
        if (resource is "credits" or "aggregate_credits")
        {
            var credits = JsonNode.Parse(json) as JsonObject ?? new();
            // These IDs identify people, not titles. Only the owning title selects their cast policy.
            if (Guarded(title) && Strip(_config.SpoilerStripCast, State.Prefs?.HideCast))
            {
                Remove(credits, "guestStars");
                if (string.Equals(_config.SpoilerStripCastMode, "All", StringComparison.OrdinalIgnoreCase))
                    Remove(credits, "cast", "crew");
            }
            return credits.ToJsonString();
        }
        if (title != null && ((resource is "release_dates" or "releases" && HidesDates(title)) || (resource == "reviews" && HidesReviews(title)))) return "{\"results\":[]}";
        if (title != null && Guarded(title))
        {
            if (resource == "videos" && Strip(_config.SpoilerStripOverview, State.Prefs?.HideEpisodeDescriptions)) return "{\"results\":[]}";
            if (resource == "keywords" && Strip(_config.SpoilerStripTags, State.Prefs?.HideTags)) return "{\"results\":[],\"keywords\":[]}";
        }
        if (resource is "ratings" or "awards" && HidesRatings(title)) return "null";
        if (resource == "images" && title != null)
        {
            var images = JsonNode.Parse(json) as JsonObject ?? new();
            ProjectImages(images, title, scopeKind ?? TitleKind(title), season);
            return images.ToJsonString();
        }
        return Project(json, title, resource == "ratings", fallbackKind, scopeKind, season, episode);
    }

    /// <summary>Whether original artwork is protected. Movie posters follow the existing keep-posters option.</summary>
    public bool ProtectArtwork(string? title, string kind, string imageType, int season = 0)
    {
        if (!Guarded(title)) return false;
        return kind == "episode" && imageType is "Primary" or "Thumb" or "Screenshot"
            || kind == "season" && season > 1 && imageType == "Primary"
            || kind == "movie" && !_config.SpoilerKeepMoviePosters && imageType is "Primary" or "Thumb"
            || _config.SpoilerBlurArtwork && imageType is "Backdrop" or "Art" or "Logo";
    }

    /// <summary>Projects known title/list schemas from a private fresh tree; raw shared source/cache bytes stay intact.</summary>
    public string Project(string json, string? title = null, bool ratingsOnly = false, string? fallbackKind = null, string? scopeKind = null, int season = 0, int episode = 0)
    {
        if (!_config.SpoilerBlurEnabled) return json;
        var node = JsonNode.Parse(json);
        if (ratingsOnly && Guarded(title) && Strip(_config.SpoilerStripRatings, State.Prefs?.HideRatings)) return "null";
        if (node is JsonObject obj)
        {
            if (title != null) ProjectTitle(obj, title, scopeKind ?? (title.StartsWith("movie:", StringComparison.Ordinal) ? "movie" : "tv"), season, episode);
            ProjectAppended(obj, title, fallbackKind, scopeKind, season, episode);
            foreach (var field in new[] { "results", "cast", "crew", "parts", "items", "requests", "events", "mine", "soon", "ready" })
                if (obj[field] is JsonArray rows) ProjectRows(rows, field == "parts" ? "movie" : fallbackKind);
            if (obj["groups"] is JsonArray groups)
                foreach (var group in groups.OfType<JsonObject>()) if (group["results"] is JsonArray rows) ProjectRows(rows, null);
        }
        else if (node is JsonArray rows) ProjectRows(rows, null);
        return node?.ToJsonString() ?? json;
    }

    private void ProjectRows(JsonArray rows, string? fallback)
    {
        foreach (var row in rows.OfType<JsonObject>())
        {
            var title = TitleFeedProjection.Identity(row, fallback);
            if (title != null)
            {
                var kind = title.StartsWith("movie:", StringComparison.Ordinal) ? "movie" : "tv";
                if (CalendarEpisode(row)) ProjectCalendarEpisode(row, title);
                else ProjectTitle(row, title, kind);
                if (row["media"] is JsonObject media) ProjectTitle(media, title, kind);
            }
        }
    }

    /// <summary>Projects one title/card, its nested season/episode fields and safe effective flags.</summary>
    public void ProjectTitle(JsonObject row, string title, string kind, int season = 0, int episode = 0)
    {
        // The year is navigation metadata; precise release/air dates still follow the strip policy.
        if (kind is "movie" or "tv" && row["year"] == null)
        {
            var date = (row["releaseDate"] ?? row["release_date"] ?? row["firstAirDate"] ?? row["first_air_date"])?.ToString();
            if (date?.Length >= 4 && int.TryParse(date.AsSpan(0, 4), out var year) && year is >= 1800 and <= 9999) row["year"] = year;
        }
        // Age certification is safe, independently of the precise dates in the release resource.
        if (kind == "movie" && row["contentRatings"] == null && row["releases"]?["results"] is JsonArray releases)
        {
            var certifications = new JsonArray();
            foreach (var release in releases.OfType<JsonObject>())
                if (release["release_dates"] is JsonArray releaseDates)
                {
                    var certification = releaseDates.OfType<JsonObject>().FirstOrDefault(d => !string.IsNullOrWhiteSpace(d["certification"]?.ToString()))?["certification"]?.ToString();
                    if (certification != null) certifications.Add(new JsonObject { ["iso_3166_1"] = release["iso_3166_1"]?.DeepClone(), ["rating"] = certification });
                }
            row["contentRatings"] = new JsonObject { ["results"] = certifications };
        }
        var guarded = Guarded(title);
        var exempt = kind == "season" && season <= 1;
        var prefs = State.Prefs;
        var overview = guarded && !exempt && Strip(kind == "tv" ? (_config.SpoilerStripSeriesOverview ?? _config.SpoilerStripOverview) : _config.SpoilerStripOverview,
            kind == "tv" ? prefs?.HideSeriesDescriptions : prefs?.HideEpisodeDescriptions);
        var ratings = guarded && !exempt && Strip(_config.SpoilerStripRatings, prefs?.HideRatings);
        var dates = guarded && !exempt && Strip(_config.SpoilerStripPremiereDate, prefs?.HideAirDate);
        var cast = guarded && !exempt && Strip(_config.SpoilerStripCast, prefs?.HideCast);
        var tags = guarded && !exempt && Strip(_config.SpoilerStripTags, prefs?.HideTags);
        var reviews = guarded && !exempt && Strip(_config.SpoilerStripReviews, prefs?.HideReviews);
        if (overview) Remove(row, "overview", "description", "summary", "plot", "relatedVideos", "videos");
        if (ratings) Remove(row, "voteAverage", "voteCount", "vote_average", "vote_count", "ratings", "rating", "communityRating", "criticRating", "awards");
        if (dates) Remove(row, "releaseDate", "releaseDateLocal", "airDateUtc", "date", "digitalRelease", "physicalRelease", "inCinemas", "physicalReleaseNote", "release_date", "firstAirDate", "first_air_date", "lastAirDate", "last_air_date", "airDate", "air_date", "nextAirDate", "nextDate", "nextDay", "digitalReleaseDate", "theatricalReleaseDate", "initialAirDate", "releaseDates", "release_dates", "releases");
        if (guarded && Strip(_config.SpoilerStripTaglines, prefs?.HideTaglines)) Remove(row, "tagline", "taglines");
        if (tags) Remove(row, "keywords", "tags");
        if (reviews) Remove(row, "reviews", "review", "content");
        var allCast = cast && string.Equals(_config.SpoilerStripCastMode, "All", StringComparison.OrdinalIgnoreCase);
        if (cast)
        {
            Remove(row, "character", "job", "department", "guestStars", "guest_stars");
            if (row["credits"] is JsonObject credits) Remove(credits, "guestStars", "guest_stars");
            if (allCast) Remove(row, "credits", "cast", "crew", "createdBy", "created_by");
        }
        if (guarded && kind == "episode" && Strip(_config.SpoilerReplaceTitle, prefs?.ReplaceEpisodeTitles))
        {
            Remove(row, "title", "originalTitle", "originalName", "original_name", "original_title");
            row["name"] = "";
        }
        if (ProtectArtwork(title, kind, "Primary", season)) Remove(row, "posterPath", "poster_path", "poster", "posterUrl", "stillPath", "still_path", "still");
        if (ProtectArtwork(title, kind, "Backdrop", season)) Remove(row, "backdropPath", "backdrop_path", "backdrop", "backdropUrl");
        if (ProtectArtwork(title, kind, "Logo", season)) Remove(row, "logoPath", "logoUrl", "logo");
        ProjectImages(row, title, kind, season);
        if (row["images"] is JsonObject images) ProjectImages(images, title, kind, season);
        foreach (var field in new[] { "last_episode_to_air", "next_episode_to_air", "lastEpisodeToAir", "nextEpisodeToAir" })
            if (row[field] is JsonObject child) ProjectTitle(child, title, "episode", Number(child, "seasonNumber", "season_number", season), Number(child, "episodeNumber", "episode_number"));
        if (row["seasons"] is JsonArray seasons)
            foreach (var child in seasons.OfType<JsonObject>()) ProjectTitle(child, title, "season", Number(child, "seasonNumber", "season_number"));
        if (row["episodes"] is JsonArray episodes)
            foreach (var child in episodes.OfType<JsonObject>()) ProjectTitle(child, title, "episode", Number(child, "seasonNumber", "season_number", season), Number(child, "episodeNumber", "episode_number"));
        row["jeSpoiler"] = new JsonObject { ["guarded"] = guarded, ["overview"] = overview, ["ratings"] = ratings,
            ["dates"] = dates, ["cast"] = allCast, ["tags"] = tags, ["reviews"] = reviews, ["revision"] = Revision };
    }

    // Calendar IDs are arr episode IDs. Only the owning series' provider identity selects policy.
    private static bool CalendarEpisode(JsonObject row)
        => (row["episodeNumber"] ?? row["episode_number"]) != null
            && ((row["source"]?.ToString() is "Sonarr" or "Shoko") || row["episodeTitle"] != null || row["episode_title"] != null || row["releaseType"]?.ToString() == "Episode");

    private void ProjectCalendarEpisode(JsonObject row, string title)
    {
        var entryTitle = row["title"]?.DeepClone();
        ProjectTitle(row, title, "episode", Number(row, "seasonNumber", "season_number"), Number(row, "episodeNumber", "episode_number"));
        // Calendar title is the series entry point; subtitle and aliases contain episode text.
        if (entryTitle != null) row["title"] = entryTitle;
        if (MissingRow(title).Title)
        {
            Remove(row, "episodeTitle", "episodeName");
            row["subtitle"] = string.Create(CultureInfo.InvariantCulture, $"S{Number(row, "seasonNumber", "season_number"):00}E{Number(row, "episodeNumber", "episode_number"):00}");
        }
    }

    private void ProjectAppended(JsonObject row, string? title, string? fallback, string? scope, int season, int episode)
    {
        foreach (var envelope in TmdbAppendProjection.Envelopes)
        {
            if (row[envelope] is not JsonObject child) continue;
            if (envelope is "recommendations" or "similar")
            {
                if (child["results"] is JsonArray results) ProjectRows(results, title == null ? fallback : TitleKind(title));
            }
            else if (title != null)
            {
                row[envelope] = JsonNode.Parse(ProjectResource(child.ToJsonString(), title, envelope, fallback, scope, season, episode));
            }
        }
    }

    private static string TitleKind(string title) => title.StartsWith("movie:", StringComparison.Ordinal) ? "movie" : "tv";

    private void ProjectImages(JsonObject images, string title, string kind, int season)
    {
        foreach (var (field, type) in new[] { ("posters", "Primary"), ("backdrops", "Backdrop"), ("stills", "Screenshot"), ("logos", "Logo") })
            if (ProtectArtwork(title, kind, type, season) && images[field] != null) images[field] = new JsonArray();
    }

    private static int Number(JsonObject row, string name, string alternate, int fallback = 0)
        => int.TryParse((row[name] ?? row[alternate])?.ToString(), out var n) ? n : fallback;
    private static bool Strip(bool admin, bool? preference) => admin && preference != false;
    private static void Remove(JsonObject row, params string[] names) { foreach (var name in names) { row.Remove(name); row.Remove(JsonNamingPolicy.SnakeCaseLower.ConvertName(name)); } }
}
