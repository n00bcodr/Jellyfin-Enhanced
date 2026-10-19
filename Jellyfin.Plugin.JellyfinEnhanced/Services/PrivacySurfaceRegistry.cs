using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using MediaBrowser.Model.Dto;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services;

/// <summary>
/// One native endpoint's privacy classification. <paramref name="Hc"/> is the Hidden Content surface its titles are
/// listed on ("items" and "home-sections" resolve per request), or null when exempt for <paramref name="HcExempt"/>;
/// <paramref name="Sg"/> says whether Spoiler Guard projects its answer, or why not (<paramref name="SgExempt"/>).
/// </summary>
public sealed record PrivacySurface(string Controller, string Action, string? Hc, string? HcExempt, bool Sg, string? SgExempt)
{
    /// <summary>Neither policy changes this endpoint's answer.</summary>
    public bool Exempt => Hc == null && !Sg;
}

/// <summary>
/// The one surface registry: every endpoint of Jellyfin 12.2 and 10.11.11 whose declared answer can carry a title
/// (BaseItemDto, SearchHint, ImageInfo, MediaSourceInfo or RecommendationDto, found by reflecting over the host's
/// Jellyfin.Api) plus Home Screen Sections' row endpoint, each classified for Hidden Content and Spoiler Guard.
/// Both action filters and the final delivery gate read it. A title-carrying answer from an endpoint that is not listed
/// here is withheld while any privacy policy applies to the viewer.
/// An exemption covers the endpoint's own items only, and is justified by what its answer carries on both hosts
/// (captured in tests/fixtures/host-shapes): the title members NESTED in any answer (a channel's CurrentProgram, a
/// session's NowPlayingItem / NowViewingItem / queue items, a timer's programme) are projected for every endpoint,
/// exempt or not, with the requesting viewer's delivery-time policy.
/// </summary>
public static class PrivacySurfaceRegistry
{
    private const string Opened = "the item the viewer opened (its own page, parts, images, playback); nested titles are projected";
    private const string Folders = "libraries and folders, not titles";
    private const string Channels = "Live TV channels, not titles; each channel's CurrentProgram is projected as a nested title";
    private const string Names = "people, genres, studios and years, not titles";
    private const string Sessions = "sessions, not titles: every session and its controls stay; their NowPlayingItem, NowViewingItem and queue items are projected as nested titles";
    private const string SignIn = "the signing-in device's new session: the host ends that device's earlier session first, so it has no now-playing item (captured on both hosts while the device was playing), and the request has no viewer yet";
    private const string Timers = "the recording schedule: a row stays (it can be cancelled); a hidden programme's title and ProgramInfo are removed from it, and programmes are never Spoiler Guard titles (no library series owns them)";
    private const string LiveStream = "the live stream the viewer opened (its own media source)";
    private const string ActivityLog = "the administrator's activity log: each entry names the item it records (ItemId); an entry about a hidden title is left out and a guarded episode's title is replaced in its text, by the viewer's own rules";

    private static readonly PrivacySurface[] _entries =
    [
        // Lists of titles, by the surface they are shown on.
        new("Items", "GetItems", "items", null, true, null),
        new("Items", "GetItemsByUserIdLegacy", "items", null, true, null),
        new("Items", "GetResumeItems", "continuewatching", null, true, null),
        new("Items", "GetResumeItemsLegacy", "continuewatching", null, true, null),
        new("UserLibrary", "GetLatestMedia", "library", null, true, null),
        new("UserLibrary", "GetLatestMediaLegacy", "library", null, true, null),
        new("TvShows", "GetNextUp", "nextup", null, true, null),
        new("TvShows", "GetUpcomingEpisodes", "upcoming", null, true, null),
        new("TvShows", "GetSeasons", "library", null, true, null),
        new("TvShows", "GetEpisodes", "library", null, true, null),
        new("Suggestions", "GetSuggestions", "recommendations", null, true, null),
        new("Suggestions", "GetSuggestionsLegacy", "recommendations", null, true, null),
        new("Library", "GetSimilarItems", "recommendations", null, true, null),
        new("Movies", "GetMovieRecommendations", "recommendations", null, true, null),
        new("Search", "GetSearchHints", "search", null, true, null),
        new("Trailers", "GetTrailers", "library", null, true, null),
        new("Playlists", "GetPlaylistItems", "library", null, true, null),
        new("Library", "GetItemCollections", "library", null, true, null),
        new("Library", "GetCriticReviews", "library", null, true, null),
        new("Channels", "GetChannelItems", "library", null, true, null),
        new("Channels", "GetLatestChannelItems", "library", null, true, null),
        new("InstantMix", "GetInstantMixFromAlbum", "library", null, true, null),
        new("InstantMix", "GetInstantMixFromArtists", "library", null, true, null),
        new("InstantMix", "GetInstantMixFromArtists2", "library", null, true, null),
        new("InstantMix", "GetInstantMixFromItem", "library", null, true, null),
        new("InstantMix", "GetInstantMixFromMusicGenreById", "library", null, true, null),
        new("InstantMix", "GetInstantMixFromMusicGenreByName", "library", null, true, null),
        new("InstantMix", "GetInstantMixFromPlaylist", "library", null, true, null),
        new("InstantMix", "GetInstantMixFromSong", "library", null, true, null),
        new("LiveTv", "GetLiveTvPrograms", "library", null, true, null),
        new("LiveTv", "GetPrograms", "library", null, true, null),
        new("LiveTv", "GetRecommendedPrograms", "library", null, true, null),
        new("LiveTv", "GetRecordings", "library", null, true, null),
        new("LiveTv", "GetRecordingsSeries", "library", null, true, null),
        new("UserLibrary", "GetIntros", "library", null, true, null),
        new("UserLibrary", "GetIntrosLegacy", "library", null, true, null),
        // Home Screen Sections (third-party plugin): the row's surface comes from its {sectionType}.
        new("HomeScreen", "GetSectionContent", "home-sections", null, true, null),

        // The item the viewer opened: never hidden from its own page, still guarded.
        new("UserLibrary", "GetItem", null, Opened, true, null),
        new("UserLibrary", "GetItemLegacy", null, Opened, true, null),
        new("Library", "GetAncestors", null, Opened, true, null),
        new("Videos", "GetAdditionalPart", null, Opened, true, null),
        new("UserLibrary", "GetLocalTrailers", null, Opened, true, null),
        new("UserLibrary", "GetLocalTrailersLegacy", null, Opened, true, null),
        new("UserLibrary", "GetSpecialFeatures", null, Opened, true, null),
        new("UserLibrary", "GetSpecialFeaturesLegacy", null, Opened, true, null),
        new("Image", "GetItemImageInfos", null, Opened, true, null),
        new("MediaInfo", "GetPlaybackInfo", null, Opened, true, null),
        new("MediaInfo", "GetPostedPlaybackInfo", null, Opened, true, null),
        new("LiveTv", "GetChannel", null, Opened, true, null),
        new("LiveTv", "GetProgram", null, Opened, true, null),
        new("LiveTv", "GetRecording", null, Opened, true, null),
        new("LiveTv", "GetRecordingGroup", null, Opened, true, null),
        new("Library", "GetThemeMedia", null, Opened, true, null),
        new("Library", "GetThemeSongs", null, Opened, true, null),
        new("Library", "GetThemeVideos", null, Opened, true, null),
        new("MediaInfo", "OpenLiveStream", null, LiveStream, false, LiveStream),

        // Structure and names: never hidden; the native strip leaves them as they are.
        new("Library", "GetMediaFolders", null, Folders, true, null),
        new("UserViews", "GetUserViews", null, Folders, true, null),
        new("UserViews", "GetUserViewsLegacy", null, Folders, true, null),
        new("UserLibrary", "GetRootFolder", null, Folders, true, null),
        new("UserLibrary", "GetRootFolderLegacy", null, Folders, true, null),
        new("Channels", "GetChannels", null, Folders, true, null),
        new("LiveTv", "GetLiveTvChannels", null, Channels, true, null),
        new("LiveTv", "GetRecordingFolders", null, Folders, true, null),
        new("LiveTv", "GetRecordingGroups", null, Folders, true, null),
        new("Artists", "GetAlbumArtists", null, Names, true, null),
        new("Artists", "GetArtistByName", null, Names, true, null),
        new("Artists", "GetArtists", null, Names, true, null),
        new("Genres", "GetGenre", null, Names, true, null),
        new("Genres", "GetGenres", null, Names, true, null),
        new("MusicGenres", "GetMusicGenre", null, Names, true, null),
        new("MusicGenres", "GetMusicGenres", null, Names, true, null),
        new("Persons", "GetPerson", null, Names, true, null),
        new("Persons", "GetPersons", null, Names, true, null),
        new("Studios", "GetStudio", null, Names, true, null),
        new("Studios", "GetStudios", null, Names, true, null),
        new("Years", "GetYear", null, Names, true, null),
        new("Years", "GetYears", null, Names, true, null),

        // The administrator's activity log (the dashboard's Activity panel and page).
        new("ActivityLog", "GetLogEntries", null, ActivityLog, false, ActivityLog),
        // Sessions (the administrator's dashboard sees every account's), sign-in and the recording schedule.
        new("Session", "GetSessions", null, Sessions, false, Sessions),
        new("User", "AuthenticateUser", null, SignIn, false, SignIn),
        new("User", "AuthenticateUserByName", null, SignIn, false, SignIn),
        new("User", "AuthenticateWithQuickConnect", null, SignIn, false, SignIn),
        new("LiveTv", "GetTimer", null, Opened, false, Timers),
        new("LiveTv", "GetTimers", null, Timers, false, Timers),
    ];

    /// <summary>Endpoints that list the opened item's own extras: the route's item owns every item they answer.</summary>
    private static readonly HashSet<(string, string)> _routeOwned =
    [
        ("userlibrary", "getlocaltrailers"), ("userlibrary", "getlocaltrailerslegacy"),
        ("userlibrary", "getspecialfeatures"), ("userlibrary", "getspecialfeatureslegacy"),
    ];

    private static readonly Dictionary<(string, string), PrivacySurface> _byAction = _entries.ToDictionary(
        e => (e.Controller.ToLowerInvariant(), e.Action.ToLowerInvariant()));

    /// <summary>The opened item whose extras the matched endpoint lists (its route's itemId), or null.</summary>
    public static Guid? RouteOwnsAnswer(ActionContext context)
        => Find(context) is { } entry && _routeOwned.Contains((entry.Controller.ToLowerInvariant(), entry.Action.ToLowerInvariant())) ? RouteId(context, "itemId") : null;

    /// <summary>
    /// The item an "opened item" endpoint answers about (its route's item, channel or programme; for a timer, the
    /// programme it records): Hidden Content never hides that item from its own answer. Null for any other endpoint.
    /// </summary>
    public static Guid? OpenedItem(ActionContext context, object? value)
    {
        if (Find(context) is not { HcExempt: Opened }) return null;
        if (value is MediaBrowser.Model.LiveTv.TimerInfoDto timer) return NativePrivacyProjection.ProgramOf(timer);
        return RouteId(context, "itemId") ?? RouteId(context, "channelId") ?? RouteId(context, "programId") ?? RouteId(context, "recordingId");
    }

    private static Guid? RouteId(ActionContext context, string key)
        => (context.RouteData?.Values.TryGetValue(key, out var raw) == true ? raw : context.HttpContext?.Request?.RouteValues?.TryGetValue(key, out var value) == true ? value : null)
            is { } id && Guid.TryParse(id.ToString(), out var guid) && guid != Guid.Empty ? guid : null;

    /// <summary>Home Screen Sections section ids that mirror a scoped surface; others are library rows.</summary>
    private static readonly Dictionary<string, string[]> _homeSections = new(StringComparer.OrdinalIgnoreCase)
    {
        { "ContinueWatching", ["continuewatching"] },
        { "NextUp", ["nextup"] },
        { "MyRequests", ["requests"] },
        { "Discover", ["discovery"] },
        { "Upcoming", ["upcoming"] },
        // One row of resume and next-up items: each item is judged as what it appears as.
        { "ContinueWatchingNextUp", ["continuewatching", "nextup"] },
    };

    /// <summary>Every classified endpoint.</summary>
    public static IReadOnlyList<PrivacySurface> Entries => _entries;

    /// <summary>The matched endpoint's classification (controller/action from the descriptor, any casing), or null.</summary>
    public static PrivacySurface? Find(ActionContext context)
    {
        var values = context.ActionDescriptor?.RouteValues;
        if (values == null || !values.TryGetValue("controller", out var controller) || !values.TryGetValue("action", out var action)
            || controller == null || action == null)
        {
            var route = context.RouteData?.Values;
            if (route == null || route["controller"] is not string c || route["action"] is not string a) return null;
            controller = c; action = a;
        }
        return _byAction.GetValueOrDefault((controller.ToLowerInvariant(), action.ToLowerInvariant()));
    }

    /// <summary>
    /// The Hidden Content surfaces a request lists titles on: "none" when exempt (or a metadata-resolver id lookup), the
    /// requested Home Screen Sections row, and search for an /Items search.
    /// </summary>
    public static string[] Surfaces(ActionContext context)
    {
        var entry = Find(context);
        switch (entry?.Hc)
        {
            case null: return ["none"];
            case "home-sections":
                var section = context.RouteData?.Values.TryGetValue("sectionType", out var raw) == true ? raw as string : null;
                return !string.IsNullOrEmpty(section) && _homeSections.TryGetValue(section, out var surfaces) ? surfaces : ["library"];
            case "items":
                if (HasNonEmpty(context, "searchTerm")) return ["search"];
                return IsMetadataResolverIdsCall(context) ? ["none"] : ["library"];
            default: return [entry.Hc];
        }
    }

    /// <summary>The surface one item is listed on (a mixed resume/next-up row judges each item by what it shows as).</summary>
    public static string Surface(ActionContext context, BaseItemDto? item)
    {
        var surfaces = Surfaces(context);
        return surfaces.Length > 1 ? (item?.UserData?.PlaybackPositionTicks ?? 0) > 0 ? "continuewatching" : "nextup" : surfaces[0];
    }

    /// <summary>JE's parent-series cascade looks items up by id; those lookups are never filtered (a missing id reads as deleted).</summary>
    public static bool IsMetadataResolverIdsCall(ActionContext context)
        => HasNonEmpty(context, "ids") && !IsTrue(context, "recursive") && !HasNonEmpty(context, "parentId");

    private static bool HasNonEmpty(ActionContext context, string key)
        => context.HttpContext?.Request?.Query is { } q && q.Any(p => p.Key.Equals(key, StringComparison.OrdinalIgnoreCase) && !string.IsNullOrWhiteSpace(p.Value.ToString()));

    private static bool IsTrue(ActionContext context, string key)
        => context.HttpContext?.Request?.Query is { } q && q.Any(p => p.Key.Equals(key, StringComparison.OrdinalIgnoreCase)
            && string.Equals(p.Value.ToString().Trim(), "true", StringComparison.OrdinalIgnoreCase));

    private static readonly string[] _atoms = ["BaseItemDto", "SearchHint", "ImageInfo", "MediaSourceInfo", "RecommendationDto", "ActivityLogEntry"];
    private static readonly ConcurrentDictionary<Type, bool> _carries = new();

    /// <summary>Whether a value of this runtime type can carry a title (the same walk the host registry was extracted with; an activity entry's text names its item).</summary>
    public static bool CarriesTitles(Type type) => _carries.GetOrAdd(type, t => Walk(t, 0, new HashSet<Type>()));

    private static bool Walk(Type type, int depth, HashSet<Type> seen)
    {
        if (_atoms.Contains(type.Name) && type.Namespace?.StartsWith("MediaBrowser", StringComparison.Ordinal) == true) return true;
        if (depth > 6 || type.IsPrimitive || type.IsEnum || type == typeof(string) || !seen.Add(type)) return false;
        if (type.IsArray) return Walk(type.GetElementType()!, depth + 1, seen);
        if (type.IsGenericType && type.GetGenericArguments().Any(a => Walk(a, depth + 1, seen))) return true;
        if (type.Namespace?.StartsWith("System", StringComparison.Ordinal) == true)
            return type.GetInterfaces().Where(i => i.IsGenericType).Any(i => i.GetGenericArguments().Any(a => Walk(a, depth + 1, seen)));
        return type.GetProperties(BindingFlags.Public | BindingFlags.Instance).Any(p => p.GetIndexParameters().Length == 0 && Walk(p.PropertyType, depth + 1, seen));
    }

    /// <summary>Whether the request reads (GET or HEAD).</summary>
    public static bool IsRead(HttpContext http) => HttpMethods.IsGet(http.Request.Method) || HttpMethods.IsHead(http.Request.Method);
}
