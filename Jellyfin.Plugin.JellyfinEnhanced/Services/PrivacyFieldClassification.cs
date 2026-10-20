using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services;

/// <summary>What one field of a DTO the privacy walker touches carries.</summary>
public enum PrivacyField
{
    /// <summary>Neither names a title nor drives the host's clients: a protected copy keeps it, a stub drops it.</summary>
    Neutral,

    /// <summary>
    /// Text that names or describes a title (or a member that is one): a protected item never carries it. Where the host's
    /// clients need a value (an item's Name) a neutral form takes its place.
    /// </summary>
    TitleBearing,

    /// <summary>
    /// What the host's own clients index to drive the item (ids, kinds, length, media streams, queue position): a stub
    /// keeps it, with the title-bearing fields of its own values removed.
    /// </summary>
    HostRequired,
}

/// <summary>
/// The one field classification of every DTO type the privacy walker touches (host-verified: tests/fixtures/host-endpoints
/// dto-fields-*.tsv lists every public property of those types on 12.2 and 10.11.11, and every one must be classified
/// here). It says which members a protected item keeps at all: a hidden member a session's controls hang on (a
/// <see cref="PrivacyField.HostRequired"/> BaseItemDto member) becomes a stub of its host-required members, any other
/// hidden member (title-bearing) is removed. What each kept member may carry is decided by its VALUE, never by its name:
/// <see cref="PrivacyValues"/> rebuilds every protected item (stub, guarded item, timer and activity rows, search hints)
/// from values that are constructed or validated.
/// Host-required evidence: jellyfin-web's remote-control page reads NowPlayingItem.MediaStreams[0].Type and its track
/// menus list MediaStreams by DisplayTitle and Index; its now-playing names helper returns nothing for an empty Name
/// (the page then throws); the remote session player matches queue items by PlaylistItemId.
/// </summary>
public static class PrivacyFieldClassification
{
    private const PrivacyField N = PrivacyField.Neutral, T = PrivacyField.TitleBearing, H = PrivacyField.HostRequired;

    /// <summary>The neutral name a hidden item's stub carries (the host's clients need a non-empty name).</summary>
    public const string HiddenName = "Hidden content";

    private static Dictionary<string, PrivacyField> Of(string? title = null, string? required = null, string? neutral = null)
    {
        var map = new Dictionary<string, PrivacyField>(StringComparer.Ordinal);
        foreach (var (names, kind) in new[] { (title, T), (required, H), (neutral, N) })
            foreach (var name in (names ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries)) map.Add(name, kind);
        return map;
    }

    /// <summary>Type name (generic types by their definition's name) → property → class.</summary>
    private static readonly Dictionary<string, Dictionary<string, PrivacyField>> _table = new(StringComparer.Ordinal)
    {
        ["BaseItemDto"] = Of(
            title: "Name OriginalTitle SortName ForcedSortName EpisodeTitle Overview Taglines Tags Path CustomRating SeriesName SeasonName Album AlbumArtist AlbumArtists "
                + "Artists ArtistItems SeriesStudio ExternalUrls RemoteTrailers People Chapters MediaSources CurrentProgram",
            required: "Id ServerId Type MediaType IsFolder RunTimeTicks LocationType MediaStreams PlaylistItemId",
            neutral: "AirDays AirsAfterSeasonNumber AirsBeforeEpisodeNumber AirsBeforeSeasonNumber AirTime AlbumCount AlbumId AlbumNormalizationGain AlbumPrimaryImageTag "
                + "Altitude Aperture ArtistCount AspectRatio Audio BackdropImageTags CameraMake CameraModel CanDelete CanDownload ChannelId ChannelName ChannelNumber "
                + "ChannelPrimaryImageTag ChannelType ChildCount CollectionType CommunityRating CompletionPercentage Container CriticRating CumulativeRunTimeTicks "
                + "DateCreated DateLastMediaAdded DisplayOrder DisplayPreferencesId EnableMediaSourceDisplay EndDate EpisodeCount Etag ExposureTime ExtraType FocalLength "
                + "GenreItems Genres HasLyrics HasSubtitles Height ImageBlurHashes ImageOrientation ImageTags IndexNumber IndexNumberEnd IsHD IsKids IsLive IsMovie IsNews "
                + "IsoSpeedRating IsoType IsPlaceHolder IsPremiere IsRepeat IsSeries IsSports Latitude LocalTrailerCount LockData LockedFields Longitude MediaSourceCount "
                + "MovieCount MusicVideoCount NormalizationGain Number OfficialRating OriginalLanguage ParentArtImageTag ParentArtItemId ParentBackdropImageTags "
                + "ParentBackdropItemId ParentId ParentIndexNumber ParentLogoImageTag ParentLogoItemId ParentPrimaryImageItemId ParentPrimaryImageTag ParentThumbImageTag "
                + "ParentThumbItemId PartCount PlayAccess PreferredMetadataCountryCode PreferredMetadataLanguage PremiereDate PrimaryImageAspectRatio ProductionLocations "
                + "ProductionYear ProgramCount ProgramId ProviderIds RecursiveItemCount ScreenshotImageTags SeasonId SeriesCount SeriesId SeriesPrimaryImageTag "
                + "SeriesThumbImageTag SeriesTimerId ShutterSpeed Software SongCount SourceType SpecialFeatureCount StartDate Status Studios TimerId TrailerCount Trickplay "
                + "UserData Video3DFormat VideoType Width"),
        ["MediaStream"] = Of(
            title: "Title Comment Path",
            required: "Type Index Codec Language IsDefault IsForced IsExternal IsExternalUrl DeliveryMethod DeliveryUrl DisplayTitle Channels ChannelLayout IsTextSubtitleStream "
                + "SupportsExternalStream IsHearingImpaired",
            neutral: "AspectRatio AudioSpatialFormat AverageFrameRate BitDepth BitRate BlPresentFlag CodecTag CodecTimeBase ColorPrimaries ColorRange ColorSpace ColorTransfer "
                + "DvBlSignalCompatibilityId DvLevel DvProfile DvVersionMajor DvVersionMinor ElPresentFlag Hdr10PlusPresentFlag Height IsAnamorphic IsAVC "
                + "IsExtractableSubtitleStream IsInterlaced IsOriginal IsPgsSubtitleStream IsVobSubSubtitleStream Level LocalizedDefault LocalizedExternal LocalizedForced "
                + "LocalizedHearingImpaired LocalizedLanguage LocalizedOriginal LocalizedUndefined NalLengthSize PacketLength PixelFormat Profile RealFrameRate "
                + "ReferenceFrameRate RefFrames Rotation RpuPresentFlag SampleRate Score TimeBase VideoDoViTitle VideoRange VideoRangeType Width"),
        ["MediaSourceInfo"] = Of(
            title: "Name Path",
            required: "Id Protocol Container RunTimeTicks MediaStreams DefaultAudioStreamIndex DefaultSubtitleStreamIndex SupportsDirectPlay SupportsDirectStream "
                + "SupportsTranscoding TranscodingUrl TranscodingSubProtocol TranscodingContainer Type",
            neutral: "AnalyzeDurationMs Bitrate BufferMs DefaultAudioIndexSource EncoderPath EncoderProtocol ETag FallbackMaxStreamingBitrate Formats GenPtsInput HasSegments "
                + "IgnoreDts IgnoreIndex IsInfiniteStream IsoType IsRemote LiveStreamId MediaAttachments OpenToken ReadAtNativeFramerate RequiredHttpHeaders RequiresClosing "
                + "RequiresLooping RequiresOpening Size SupportsProbing Timestamp TranscodeReasons UseMostCompatibleTranscodingProfile Video3DFormat VideoStream VideoType"),
        ["MediaAttachment"] = Of(title: "Comment FileName", required: "Index DeliveryUrl", neutral: "Codec CodecTag MimeType"),
        ["ChapterInfo"] = Of(title: "Name ImagePath", required: "StartPositionTicks", neutral: "ImageDateModified ImageTag"),
        ["BaseItemPerson"] = Of(title: "Role", required: "Id", neutral: "HasPrimaryImage ImageBlurHashes Name PrimaryImageTag Type"),
        ["ExternalUrl"] = Of(title: "Name Url"),
        ["MediaUrl"] = Of(title: "Name Url"),
        ["NameGuidPair"] = Of(title: "Name", required: "Id"),
        ["UserItemDataDto"] = Of(required: "ItemId Key", neutral: "IsFavorite LastPlayedDate Likes PlaybackPositionTicks PlayCount Played PlayedPercentage Rating UnplayedItemCount"),
        ["TrickplayInfoDto"] = Of(neutral: "Bandwidth Height Interval ThumbnailCount TileHeight TileWidth Width"),
        ["SessionInfoDto"] = Of(
            title: "NowViewingItem",
            required: "Id UserId ServerId DeviceId PlayState Capabilities SupportedCommands SupportsMediaControl SupportsRemoteControl PlayableMediaTypes NowPlayingItem "
                + "NowPlayingQueue NowPlayingQueueFullItems PlaylistItemId IsActive",
            neutral: "AdditionalUsers ApplicationVersion Client DeviceName DeviceType HasCustomDeviceName LastActivityDate LastPausedDate LastPlaybackCheckIn RemoteEndPoint "
                + "TranscodingInfo UserName UserPrimaryImageTag"),
        ["AuthenticationResult"] = Of(required: "AccessToken ServerId SessionInfo User"),
        ["QueryResult"] = Of(required: "StartIndex TotalRecordCount", neutral: "Items"),
        ["ThemeMediaResult"] = Of(required: "OwnerId StartIndex TotalRecordCount", neutral: "Items"),
        ["AllThemeMediaResult"] = Of(neutral: "SoundtrackSongsResult ThemeSongsResult ThemeVideosResult"),
        ["RecommendationDto"] = Of(title: "BaselineItemName", required: "CategoryId RecommendationType", neutral: "Items"),
        ["SearchHintResult"] = Of(required: "TotalRecordCount", neutral: "SearchHints"),
        ["SearchHint"] = Of(
            title: "Name MatchedTerm Series Album AlbumArtist Artists",
            required: "Id ItemId Type MediaType IsFolder",
            neutral: "AlbumId BackdropImageItemId BackdropImageTag ChannelId ChannelName EndDate EpisodeCount IndexNumber ParentIndexNumber PrimaryImageAspectRatio "
                + "PrimaryImageTag ProductionYear RunTimeTicks SongCount StartDate Status ThumbImageItemId ThumbImageTag"),
        ["BaseTimerInfoDto"] = Timer(""),
        ["TimerInfoDto"] = Timer("ProgramInfo", "ExternalSeriesTimerId RunTimeTicks SeriesTimerId Status"),
        ["SeriesTimerInfoDto"] = Timer("", "DayPattern Days ImageTags KeepUpTo ParentPrimaryImageItemId ParentPrimaryImageTag ParentThumbImageTag ParentThumbItemId "
            + "RecordAnyChannel RecordAnyTime RecordNewOnly SkipEpisodesInLibrary"),
        ["ActivityLogEntry"] = Of(title: "Name ShortOverview Overview", required: "Id Date Type ItemId UserId Severity", neutral: "UserPrimaryImageTag"),
    };

    private static Dictionary<string, PrivacyField> Timer(string title, string neutral = "")
        => Of(title: "Name Overview " + title, required: "Id ServerId Type ChannelId ProgramId StartDate EndDate",
            neutral: "ChannelName ChannelPrimaryImageTag ExternalChannelId ExternalId ExternalProgramId IsPostPaddingRequired IsPrePaddingRequired KeepUntil "
                + "ParentBackdropImageTags ParentBackdropItemId PostPaddingSeconds PrePaddingSeconds Priority ServiceName " + neutral);

    /// <summary>The classified type names.</summary>
    public static IEnumerable<string> Types => _table.Keys;

    /// <summary>The classification of a type's properties by name (null when the type is not one the walker touches).</summary>
    public static IReadOnlyDictionary<string, PrivacyField>? Fields(string type)
        => _table.TryGetValue(type, out var map) ? map : null;

    private static string Key(Type type) => type.IsGenericType ? type.Name.Split('`')[0] : type.Name;

    /// <summary>
    /// A property's class. Declared on a classified type (or one of its base types); a property the table does not name
    /// on a classified type is title-bearing (deny by default: a future host field is assumed to carry the title).
    /// </summary>
    public static PrivacyField Of(Type type, string property)
    {
        for (var t = type; t != null && t != typeof(object); t = t.BaseType)
            if (_table.TryGetValue(Key(t), out var map) && map.TryGetValue(property, out var kind)) return kind;
        return PrivacyField.TitleBearing;
    }

    /// <summary>Whether a BaseItemDto member of this type is one the host's controls hang on (a hidden one leaves a stub).</summary>
    public static bool KeepsControls(PropertyInfo property) => Of(property.DeclaringType ?? typeof(object), property.Name) == PrivacyField.HostRequired;
}

/// <summary>
/// The neutral names Spoiler Guard gives a protected episode or season, from whatever numbering the library has: never
/// conditional on it (an episode without numbers is still protected).
/// </summary>
public static class NeutralNames
{
    /// <summary>"Season 2, Episode 6", "Season 2, Episode", "Episode 6" or "Episode".</summary>
    public static string Episode(int? season, int? episode) => (season, episode) switch
    {
        ({ } s, { } e) => string.Create(CultureInfo.InvariantCulture, $"Season {s}, Episode {e}"),
        ({ } s, null) => string.Create(CultureInfo.InvariantCulture, $"Season {s}, Episode"),
        (null, { } e) => string.Create(CultureInfo.InvariantCulture, $"Episode {e}"),
        _ => "Episode",
    };

    /// <summary>"Season 2" or "Season".</summary>
    public static string Season(int? index) => index is { } n ? string.Create(CultureInfo.InvariantCulture, $"Season {n}") : "Season";
}
