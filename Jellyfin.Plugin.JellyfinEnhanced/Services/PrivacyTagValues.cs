using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services;

/// <summary>What a guarded tag-cache entry loses (the viewer's effective Spoiler Guard strip for that entry).</summary>
/// <param name="Vocabulary">Genres, languages and stream data leave (the tag strip).</param>
/// <param name="Scores">Community and critic ratings leave (the rating strip).</param>
/// <param name="Titles">Item names, paths and stream titles leave (the title or overview strip).</param>
/// <param name="RatingFrom">The item whose age rating replaces the entry's own (an episode's or season's series), when set.</param>
public readonly record struct PrivacyTagStrip(bool Vocabulary, bool Scores, bool Titles, Guid? RatingFrom = null);

/// <summary>One tag-data request's context: the viewer's strip, the selected version and the library lookups it needs.</summary>
/// <param name="Policy">The viewer's Spoiler Guard tag strip, or null when nothing is stripped.</param>
/// <param name="MediaSourceId">The one version the caller asked for, if any.</param>
/// <param name="Placeholder">The administrator's placeholder (a guarded series' name under the title strip).</param>
/// <param name="FirstEpisode">A series' or season's stream-bearing first episode, with the viewer's access.</param>
/// <param name="FirstProtected">Whether Spoiler Guard protects that episode for the viewer.</param>
public sealed record PrivacyTagDataRequest(SpoilerTagStripPolicy? Policy, string? MediaSourceId, string? Placeholder,
    Func<BaseItem, BaseItem?> FirstEpisode, Func<BaseItem, bool> FirstProtected);

/// <summary>
/// The construction table's tag answers: the tag cache's guarded entries (GET tag-cache, native poster tags) and the card
/// data POST tag-data answers. Every value these answers carry is read here, through the same rules as the item DTOs
/// (host table entries, the title's own vocabulary, constructed names), so no other output path reads an item's text.
/// </summary>
public static partial class PrivacyValues
{
    /// <summary>
    /// A guarded tag-cache entry: a clone (the cache's entries are shared by every user) without what the strip removes,
    /// then only values the host vouches for: provider ids as digits, a rating the host's tables know, languages the host
    /// knows, ffprobe's codec, profile and layout tokens; item names, paths and stream titles only where Spoiler Guard
    /// reveals the title family. An episode's, season's or extra's genres are its title's own (<paramref name="title"/>:
    /// the series, the owner), since a season entry aggregates its episodes' genres and Jellyfin's genre names come from
    /// the protected items themselves.
    /// </summary>
    public static TagCacheEntry TagEntry(TagCacheEntry entry, PrivacyTagStrip strip, Guid? title, PrivacyValueHost host)
    {
        var e = entry.Clone();
        if (strip.Vocabulary)
        {
            e.Genres = Array.Empty<string>();
            e.AudioLanguages = null;
            e.PartialAudioLanguages = null;
            e.StreamData = null;
        }
        if (strip.Scores)
        {
            e.CommunityRating = null;
            e.CriticRating = null;
        }
        // Age rating: an episode's or season's own can differ from its series' and Jellyfin never shows it; the series'
        // is not a spoiler.
        if (strip.RatingFrom is { } source)
        {
            var rating = host.Item(source)?.OfficialRating;
            e.OfficialRating = string.IsNullOrWhiteSpace(rating) ? null : rating;
        }
        if (title is { } owner && e.Genres != null)
        {
            var genres = host.Item(owner)?.Genres;
            e.Genres = e.Genres.Select(g => PrivacyValueHost.EntryIn(genres, g)).OfType<string>().Distinct(StringComparer.Ordinal).ToArray();
        }
        static string? Digits(string? v) => v is { Length: > 0 and <= 20 } && v.All(char.IsAsciiDigit) ? v : null;
        e.TmdbId = Digits(e.TmdbId);
        e.SeriesTmdbId = Digits(e.SeriesTmdbId);
        e.SeriesId = PrivacyTokens.IdOf(e.SeriesId);
        e.OfficialRating = host.Rating(e.OfficialRating);
        e.AudioLanguages = e.AudioLanguages?.Select(host.Language).OfType<string>().Distinct(StringComparer.Ordinal).ToArray();
        e.PartialAudioLanguages = e.PartialAudioLanguages?.Select(host.Language).OfType<string>().Distinct(StringComparer.Ordinal).ToArray();
        if (e.StreamData is { } data)
        {
            var titles = strip.Titles;
            e.StreamData = new TagStreamData
            {
                ItemName = titles ? null : data.ItemName,
                ItemPath = titles ? null : data.ItemPath,
                Streams = data.Streams?.Where(st => st != null).Select(st => TagStream(st, host, titles)).ToList(),
                Sources = data.Sources?.Select(source => new TagMediaSource { Path = titles ? null : source?.Path, Name = titles ? null : source?.Name }).ToList(),
            };
        }
        return e;
    }

    /// <summary>
    /// A tag stream rebuilt from canonical values: the host's table entries (language, codec, profile, layout), enum names
    /// (stream type, range type), numbers; its display title only where titles are revealed.
    /// </summary>
    internal static TagMediaStream TagStream(TagMediaStream stream, PrivacyValueHost host, bool sanitizeTitles) => new()
    {
        Type = EnumName<MediaStreamType>(stream.Type),
        Language = host.Language(stream.Language),
        Codec = PrivacyTokens.Codec(stream.Codec),
        CodecTag = PrivacyTokens.FourCc(stream.CodecTag) ? stream.CodecTag : null,
        Profile = PrivacyTokens.Profile(stream.Profile),
        Height = stream.Height,
        Channels = stream.Channels,
        ChannelLayout = PrivacyTokens.Layout(stream.ChannelLayout),
        VideoRangeType = EnumName<VideoRangeType>(stream.VideoRangeType),
        DisplayTitle = sanitizeTitles ? null : stream.DisplayTitle,
    };

    /// <summary>The enum's own name for a value (ordinal), or null.</summary>
    private static string? EnumName<T>(string? value) where T : struct, Enum
        => value == null ? null : Enum.GetNames<T>().FirstOrDefault(n => string.Equals(n, value, StringComparison.Ordinal));

    /// <summary>
    /// One item's POST tag-data answer. An item Spoiler Guard protects (<paramref name="stub"/>) gets its stub: its name
    /// from <see cref="NameOf"/>, a field kept only when its strip is off, the series' age rating where the item's own is
    /// hidden, streams from validated values only and no file or version names (they commonly carry the title). Any other
    /// item is the library's own projection for the tag renderers.
    /// </summary>
    public static object TagData(BaseItem item, SpoilerTagDataStub stub, PrivacyTagDataRequest request, PrivacyValueHost host)
    {
        var kind = item.GetBaseItemKind();
        var policy = request.Policy;
        var stripGenres = policy?.StripGenres == true;
        var stripRatings = policy?.StripRatings == true;
        var reveal = new PrivacyReveal { Title = policy?.ReplaceTitle != true, TitleFamily = policy?.SanitizeTitleStreams != true };

        // The versions the caller selected: a details page's chosen version goes through the same projection (and the same
        // language resolution) as the whole item.
        List<MediaSourceInfo> Sources(BaseItem of)
            => string.IsNullOrWhiteSpace(request.MediaSourceId)
                ? of.GetMediaSources(false).ToList()
                : of.GetMediaSources(false).Where(source => string.Equals(source.Id, request.MediaSourceId, StringComparison.OrdinalIgnoreCase)).ToList();

        // Age rating for the Age Rating Tags overlay. Seasons/Episodes rarely carry their own, so fall back to the Series
        // (as TagCacheService.BuildEntryForItem does). The series-level age rating is never spoiler-stripped, but an
        // Episode's or Season's OWN rating can differ from the series and Jellyfin never displays it, so the stubs pass
        // seriesOnly when ratings are stripped.
        string? Rating(BaseItem of, bool seriesOnly = false)
        {
            if (!seriesOnly && !string.IsNullOrWhiteSpace(of.OfficialRating)) return of.OfficialRating;
            var series = of switch
            {
                MediaBrowser.Controller.Entities.TV.Episode e => e.SeriesId,
                MediaBrowser.Controller.Entities.TV.Season s => s.SeriesId,
                _ => Guid.Empty,
            };
            if (series == Guid.Empty) return null;
            var parent = host.Item(series)?.OfficialRating;
            return string.IsNullOrWhiteSpace(parent) ? null : parent;
        }

        // The stream fields the tag renderers read, from validated values only (a stub's streams). DisplayTitle's GETTER
        // prepends the raw Title field, which on user-muxed files commonly carries the title; qualitytags.js recomputes
        // overlay text from Codec / Height / VideoRangeType / Profile.
        List<object> StubStreams(BaseItem of) => Sources(of)
            .SelectMany(source => MediaStreamLanguageResolver.Resolve(source, of.Path))
            .Where(resolved => resolved.Stream.Type == MediaStreamType.Video || resolved.Stream.Type == MediaStreamType.Audio)
            .Select(resolved =>
            {
                var s = resolved.Stream;
                return (object)new
                {
                    Type = s.Type.ToString(),
                    Language = host.Language(resolved.Language),
                    Codec = PrivacyTokens.Codec(s.Codec),
                    CodecTag = PrivacyTokens.FourCc(s.CodecTag) ? s.CodecTag : null,
                    Profile = PrivacyTokens.Profile(s.Profile),
                    Height = s.Height,
                    Channels = s.Channels,
                    ChannelLayout = PrivacyTokens.Layout(s.ChannelLayout),
                    VideoRangeType = s.VideoRangeType,
                    DisplayTitle = default(string?),
                };
            })
            .ToList();

        // Episode stub: an unwatched episode of a guarded series. Streams only when the tag strip is off (quality and
        // language overlays still render under a rating-only strip); MediaSources stays null: file and version names
        // commonly carry the episode title. SeriesId is nulled only when ratings are stripped (it controls the rating
        // fallback to the parent series).
        if (stub == SpoilerTagDataStub.Episode && item is MediaBrowser.Controller.Entities.TV.Episode episode)
        {
            return new
            {
                Id = item.Id,
                Type = kind.ToString(),
                Genres = stripGenres ? Array.Empty<string>() : (episode.Genres ?? Array.Empty<string>()),
                CommunityRating = stripRatings ? (float?)null : episode.CommunityRating,
                CriticRating = stripRatings ? (float?)null : episode.CriticRating,
                OfficialRating = host.Rating(Rating(episode, seriesOnly: stripRatings)),
                SeriesId = stripRatings ? (Guid?)null : episode.SeriesId,
                ProviderIds = (IDictionary<string, string>?)null,
                Name = NameOf(kind, item.Id, episode.ParentIndexNumber, episode.IndexNumber, item.Name, reveal, host, known: item),
                Path = (string?)null,
                MediaStreams = stripGenres ? null : StubStreams(episode),
                MediaSources = (List<object>?)null,
                FirstEpisode = (object?)null,
                // Aligned with the field-strip filter (which empties Tags).
                Tags = stripGenres ? Array.Empty<string>() : (episode.Tags ?? Array.Empty<string>()),
            };
        }

        // Series stub: a series the viewer guards (home-rail cards bound to a series id: Next Up and Continue Watching
        // with "Use episode images" off show the series poster). Series titles are rarely spoilery; they are replaced only
        // under the explicit title strip, matching the field-strip filter.
        if (stub == SpoilerTagDataStub.Series && item is MediaBrowser.Controller.Entities.TV.Series series)
        {
            return new
            {
                Id = item.Id,
                Type = kind.ToString(),
                Genres = stripGenres ? Array.Empty<string>() : (series.Genres ?? Array.Empty<string>()),
                CommunityRating = stripRatings ? (float?)null : series.CommunityRating,
                CriticRating = stripRatings ? (float?)null : series.CriticRating,
                OfficialRating = host.Rating(Rating(series)),
                SeriesId = (Guid?)null,
                ProviderIds = (IDictionary<string, string>?)null,
                Name = policy?.ReplaceTitle == true
                    ? (string.IsNullOrWhiteSpace(request.Placeholder) ? "Spoiler Guard activated" : request.Placeholder)
                    : NameOf(kind, item.Id, null, null, null, reveal, host, known: item),
                Path = (string?)null,
                MediaStreams = (List<object>?)null,
                MediaSources = (List<object>?)null,
                FirstEpisode = (object?)null,
                Tags = stripGenres ? Array.Empty<string>() : (series.Tags ?? Array.Empty<string>()),
            };
        }

        // Movie stub: an unwatched movie in the viewer's spoiler scope, and an extra of a guarded title by its owner's
        // rules. The name is NameOf's: a movie's own title (Spoiler Guard does not hide it), an extra's kind.
        if (stub is SpoilerTagDataStub.Movie or SpoilerTagDataStub.Extra)
        {
            return new
            {
                Id = item.Id,
                Type = kind.ToString(),
                Genres = stripGenres ? Array.Empty<string>() : (item.Genres ?? Array.Empty<string>()),
                CommunityRating = stripRatings ? (float?)null : item.CommunityRating,
                CriticRating = stripRatings ? (float?)null : item.CriticRating,
                OfficialRating = host.Rating(Rating(item)),
                SeriesId = (Guid?)null,
                ProviderIds = (IDictionary<string, string>?)null,
                Name = NameOf(kind, item.Id, null, null, null, reveal, host, known: item),
                Path = (string?)null,
                MediaStreams = stripGenres ? null : StubStreams(item),
                MediaSources = (List<object>?)null,
                FirstEpisode = (object?)null,
                Tags = stripGenres ? Array.Empty<string>() : (item.Tags ?? Array.Empty<string>()),
            };
        }

        // Season stub: a season of a guarded series with no watched episode, not S0/S1.
        if (stub == SpoilerTagDataStub.Season && item is MediaBrowser.Controller.Entities.TV.Season season)
        {
            return new
            {
                Id = item.Id,
                Type = kind.ToString(),
                Genres = stripGenres ? Array.Empty<string>() : (season.Genres ?? Array.Empty<string>()),
                CommunityRating = stripRatings ? (float?)null : season.CommunityRating,
                CriticRating = stripRatings ? (float?)null : season.CriticRating,
                OfficialRating = host.Rating(Rating(season, seriesOnly: stripRatings)),
                SeriesId = stripRatings ? (Guid?)null : season.SeriesId,
                ProviderIds = (IDictionary<string, string>?)null,
                Name = NameOf(kind, item.Id, null, season.IndexNumber, item.Name, reveal, host, known: item),
                Path = (string?)null,
                MediaStreams = (List<object>?)null,
                MediaSources = (List<object>?)null,
                FirstEpisode = (object?)null,
                Tags = stripGenres ? Array.Empty<string>() : (season.Tags ?? Array.Empty<string>()),
            };
        }

        // An item Spoiler Guard does not protect: the library's own values. Only playable items (movies, episodes) have
        // media sources; series and seasons are containers (skip the expensive call). Only the fields the tag renderers
        // need; file names only (not full paths) for IMAX/3D/media-stub detection.
        var isContainer = kind is BaseItemKind.Series or BaseItemKind.Season;
        List<object>? streams = null;
        List<object>? sources = null;
        if (!isContainer)
        {
            var mediaSources = Sources(item);
            streams = mediaSources
                .SelectMany(source => MediaStreamLanguageResolver.Resolve(source, item.Path))
                .Where(resolved => resolved.Stream.Type == MediaStreamType.Video || resolved.Stream.Type == MediaStreamType.Audio)
                .Select(resolved =>
                {
                    var s = resolved.Stream;
                    return (object)new
                    {
                        Type = s.Type.ToString(),
                        Language = resolved.Language,
                        Codec = s.Codec,
                        CodecTag = s.CodecTag,
                        Profile = s.Profile,
                        Height = s.Height,
                        Channels = s.Channels,
                        ChannelLayout = s.ChannelLayout,
                        VideoRangeType = s.VideoRangeType,
                        DisplayTitle = s.DisplayTitle,
                    };
                })
                .ToList();
            sources = mediaSources
                .Select(s => (object)new
                {
                    Path = string.IsNullOrEmpty(s.Path) ? null : System.IO.Path.GetFileName(s.Path),
                    Name = s.Name,
                })
                .ToList();
        }

        // A series' or season's first episode (the same stream-bearing episode as the server cache, with the viewer's
        // access): the client fetches its region-aware stream projection from tag data. The episode is judged on its
        // own: a protected one's genres follow the tag strip, as on its stub.
        object? first = null;
        if (isContainer && request.FirstEpisode(item) is { } firstEpisode)
        {
            var firstProtected = policy != null && request.FirstProtected(firstEpisode);
            first = new
            {
                Id = firstEpisode.Id,
                Type = firstEpisode.GetBaseItemKind().ToString(),
                Genres = firstProtected && stripGenres ? Array.Empty<string>() : firstEpisode.Genres,
                NeedsStreamFetch = true,
            };
        }

        return new
        {
            Id = item.Id,
            Type = kind.ToString(),
            Genres = item.Genres,
            CommunityRating = item.CommunityRating,
            CriticRating = item.CriticRating,
            OfficialRating = Rating(item),
            SeriesId = item is MediaBrowser.Controller.Entities.TV.Episode ep ? ep.SeriesId : item is MediaBrowser.Controller.Entities.TV.Season sn ? sn.SeriesId : (Guid?)null,
            ProviderIds = item.ProviderIds,
            Name = item.Name,
            Path = string.IsNullOrEmpty(item.Path) ? null : System.IO.Path.GetFileName(item.Path),
            MediaStreams = streams,
            MediaSources = sources,
            FirstEpisode = first,
        };
    }
}
