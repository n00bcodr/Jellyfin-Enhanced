using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Dlna;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Model.Session;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

/// <summary>
/// Review round 20 (emit canonical constructions only; shapes are host-required; one verdict reaches the tag cache;
/// sentinels inside valid shapes). A rule that VALIDATES a value and then KEEPS THE ORIGINAL STRING is still a
/// pass-through: the hosts' rating parser accepts "text:PG" and "text/PG" (D46-R20-1); Jellyfin creates its genre, studio
/// and person entities FROM an item's own metadata, so an entity's existence vouches for nothing (D46-R20-2); a URL
/// pattern admits free segments and parameters (D46-R20-3). Cache entries of extras did not get their owner's verdict
/// (D46-R20-4), and dropping a collection the host's clients index (RequiredHttpHeaders.length) broke playback (D46-R20-5).
/// Uses only the filters' and endpoints' existing surface, so the same file runs against the pre-fix build.
/// </summary>
[Collection("Plugin singleton")]
public class PrivacyReviewRound20Tests
{
    private static PrivacyHostShapeModelTests.Shot Shot(string file) => PrivacyHostShapeModelTests.Data.Shots.Single(s => s.File == file);

    private static Guid Role(string role) => PrivacyHostShapeModelTests.G(PrivacyHostShapeModelTests.Data.Roles[role]);

    private static PrivacyHostShapeModelTests.Rule Rule(string id) => PrivacyHostShapeModelTests.Rules.Single(r => r.Id == id);

    private static void AssertAbsent(string body, string text, string where)
    {
        var at = body.IndexOf(text, StringComparison.OrdinalIgnoreCase);
        Assert.True(at < 0, where + ": \"" + text + "\" delivered near: " + (at < 0 ? "" : body.Substring(Math.Max(0, at - 160), Math.Min(320, body.Length - Math.Max(0, at - 160)))));
    }

    /// <summary>Every JSON object in the delivered bytes for this item id (listed, nested, queued).</summary>
    private static List<JsonObject> Delivered(string body, Guid id)
    {
        var found = new List<JsonObject>();
        void Walk(JsonNode? node)
        {
            if (node is JsonArray a) { foreach (var c in a) Walk(c); return; }
            if (node is not JsonObject o) return;
            if (IsItem(o, id)) found.Add(o);
            foreach (var (_, c) in o) Walk(c);
        }
        Walk(JsonNode.Parse(body));
        return found;
    }

    /// <summary>An item DTO with this id (not a media source, which shares the item's id).</summary>
    private static bool IsItem(JsonObject o, Guid id)
        => o["Id"]?.ToString().Replace("-", "", StringComparison.Ordinal) == id.ToString("N") && Enum.TryParse<BaseItemKind>(o["Type"]?.ToString(), out _);

    private static readonly (string Rule, string File, string Role)[] GuardedSites =
    [
        ("sg-r19-series", "UserLibrary.GetItem.r19-e3.json", "episode:r19-e3"),
        ("sg-r19-series", "TvShows.GetEpisodes.r19.json", "episode:r19-e3"),
        ("sg-r19-series", "Session.GetSessions.admin-r19.json", "episode:r19-e3"),
        ("sg-r19-series", "Session.WebSocket.admin-r19.json", "episode:r19-e3"),
    ];

    // ---------------------------------------------------------------------------------------------------------------
    // D46-R20-1: a parental rating is the rating table's own entry, never the original string the host's parser accepted.

    public static IEnumerable<object[]> RatingCases()
        => GuardedSites.SelectMany(s => new[] { "Secret rating r21:PG", "Secret rating r21/PG", "Secret rating r21-PG", "PG/Secret rating r21" }.Select(r => new object[] { s.File, r }));

    [Theory]
    [MemberData(nameof(RatingCases))]
    public async Task ARatingTheHostsParserAcceptsKeepsNoTextOfItsOwn(string file, string rating)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        Assert.NotNull(rig.Localization.GetRatingScore(rating));
        rig.Commit(Rule("sg-r19-series"), rig.Admin);
        var shot = Shot(file);
        var answer = PrivacyHostShapeModelTests.Value(shot);
        var targets = PrivacyReviewRound19Tests.Dtos(answer, Role("episode:r19-e3"));
        Assert.NotEmpty(targets);
        foreach (var dto in targets) dto.OfficialRating = rating;
        var (result, body) = await PrivacyHostShapeModelTests.Deliver(rig, shot, answer: answer);
        Assert.IsAssignableFrom<ObjectResult>(result);
        AssertAbsent(body, "Secret rating", file);
    }

    [Theory]
    [InlineData("pg", "PG")]
    [InlineData("TV-MA", "TV-MA")]
    [InlineData("12", "12")]
    public async Task AValidRatingIsDeliveredAsTheTablesOwnEntry(string rating, string entry)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        rig.Commit(Rule("sg-r19-series"), rig.Admin);
        var shot = Shot("UserLibrary.GetItem.r19-e3.json");
        var answer = PrivacyHostShapeModelTests.Value(shot);
        foreach (var dto in PrivacyReviewRound19Tests.Dtos(answer, Role("episode:r19-e3"))) dto.OfficialRating = rating;
        var (_, body) = await PrivacyHostShapeModelTests.Deliver(rig, shot, answer: answer);
        Assert.All(Delivered(body, Role("episode:r19-e3")), o => Assert.Equal(entry, o["OfficialRating"]?.ToString()));
    }

    [Theory]
    [InlineData("ENG", "eng")]
    [InlineData("eng", "eng")]
    [InlineData("En", "en")]
    [InlineData("en-us", "en-US")]
    [InlineData("Secret language r21-US", null)]
    public async Task AStreamLanguageIsDeliveredAsTheLanguageListsOwnEntry(string language, string? entry)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        rig.Commit(Rule("sg-r19-series"), rig.Admin);
        var shot = Shot("UserLibrary.GetItem.r19-e3.json");
        var answer = PrivacyHostShapeModelTests.Value(shot);
        foreach (var dto in PrivacyReviewRound19Tests.Dtos(answer, Role("episode:r19-e3")))
            foreach (var stream in (dto.MediaStreams ?? []).Concat((dto.MediaSources ?? []).SelectMany(m => m.MediaStreams ?? [])).Where(s => s.Type == MediaStreamType.Audio)) stream.Language = language;
        var (_, body) = await PrivacyHostShapeModelTests.Deliver(rig, shot, answer: answer);
        AssertAbsent(body, "Secret language", "item page");
        var streams = Delivered(body, Role("episode:r19-e3")).SelectMany(o => ((JsonArray)o["MediaStreams"]!).OfType<JsonObject>()).Where(s => s["Type"]?.ToString() == "Audio").ToArray();
        Assert.NotEmpty(streams);
        Assert.All(streams, s => Assert.Equal(entry, s["Language"]?.ToString()));
    }

    // ---------------------------------------------------------------------------------------------------------------
    // D46-R20-2: genres, studios and people of a guarded episode are copied from its series, never the episode's own names
    // (Jellyfin creates those entities from the episode's metadata, so a matching entity proves nothing).

    /// <summary>A library entity of the kind with this name, and the library's id lookup for it (as the host creates them).</summary>
    private static Guid Entity<T>(PrivacyHostShapeModelTests.Rig rig, string name) where T : BaseItem, new()
    {
        var id = Guid.NewGuid();
        rig.Items[id] = new T { Id = id, Name = name };
        if (typeof(T) == typeof(Genre)) rig.Library.Setup(l => l.GetGenreId(name)).Returns(id);
        if (typeof(T) == typeof(Studio)) rig.Library.Setup(l => l.GetStudioId(name)).Returns(id);
        return id;
    }

    /// <summary>The guarded series' own vocabulary, and an episode carrying it plus episode-level names that are title text.</summary>
    internal static void EpisodeVocabulary(PrivacyHostShapeModelTests.Rig rig, IEnumerable<BaseItemDto> episodes, string secret)
    {
        var series = (MediaBrowser.Controller.Entities.TV.Series)rig.Items[Role("series:r19-show")];
        series.Genres = ["Drama"];
        series.Studios = ["Series Studio"];
        rig.Library.Setup(l => l.GetPeople(It.Is<BaseItem>(b => b.Id == series.Id))).Returns([new PersonInfo { Name = "Series Actor", Type = PersonKind.Actor }]);
        var drama = Entity<Genre>(rig, "Drama");
        var genre = Entity<Genre>(rig, secret + " genre");
        var studio = Entity<Studio>(rig, "Series Studio");
        var secretStudio = Entity<Studio>(rig, secret + " studio");
        var actor = Entity<Person>(rig, "Series Actor");
        var guest = Entity<Person>(rig, secret + " guest");
        foreach (var dto in episodes)
        {
            dto.Genres = ["Drama", secret + " genre"];
            dto.GenreItems = [new NameGuidPair { Name = "Drama", Id = drama }, new NameGuidPair { Name = secret + " genre", Id = genre }];
            dto.Studios = [new NameGuidPair { Name = "Series Studio", Id = studio }, new NameGuidPair { Name = secret + " studio", Id = secretStudio }];
            dto.People = [new BaseItemPerson { Name = "Series Actor", Id = actor, Type = PersonKind.Actor }, new BaseItemPerson { Name = secret + " guest", Id = guest, Type = PersonKind.Actor }];
        }
    }

    public static IEnumerable<object[]> GuardedSiteFiles() => GuardedSites.Select(s => new object[] { s.File });

    [Theory]
    [MemberData(nameof(GuardedSiteFiles))]
    public async Task AGuardedEpisodesGenresStudiosAndPeopleAreItsSeriesOwn(string file)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        rig.Commit(Rule("sg-r19-series"), rig.Admin);
        var shot = Shot(file);
        var answer = PrivacyHostShapeModelTests.Value(shot);
        var targets = PrivacyReviewRound19Tests.Dtos(answer, Role("episode:r19-e3"));
        Assert.NotEmpty(targets);
        EpisodeVocabulary(rig, targets, "Secret r21");
        var (result, body) = await PrivacyHostShapeModelTests.Deliver(rig, shot, answer: answer);
        Assert.IsAssignableFrom<ObjectResult>(result);
        AssertAbsent(body, "Secret r21", file);
        // The series' own vocabulary is still there.
        foreach (var item in Delivered(body, Role("episode:r19-e3")))
        {
            Assert.Contains("Drama", item["Genres"]!.AsArray().Select(g => g!.ToString()));
            Assert.Contains("Series Studio", item["Studios"]!.AsArray().Select(g => g!["Name"]!.ToString()));
            Assert.Contains("Series Actor", item["People"]!.AsArray().Select(g => g!["Name"]!.ToString()));
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // D46-R20-3: delivery and transcoding URLs are rebuilt from the host's route templates (named parameters, the host's
    // fixed file name), never kept whole.

    /// <summary>The transcoding URL the host builds (its own StreamInfo.ToUrl, with MediaInfoHelper's additions) for the model's caller.</summary>
    internal static string HostTranscodingUrl(Guid itemId, MediaSourceInfo source)
    {
        var info = new StreamInfo
        {
            ItemId = itemId, MediaType = DlnaProfileType.Video, Container = "ts", DeviceId = PrivacyTestHost.CallerDeviceId, MediaSource = source,
            PlaySessionId = "bea7025a61ca464884ea2a18f785d2a4", VideoCodecs = ["h264"], AudioCodecs = ["aac"], AudioStreamIndex = 1, PlayMethod = PlayMethod.Transcode,
            DeviceProfile = new DeviceProfile(), TranscodeReasons = TranscodeReason.ContainerNotSupported | TranscodeReason.AudioCodecNotSupported, VideoBitrate = 808000, MaxFramerate = 24,
        };
        var protocol = typeof(StreamInfo).GetProperty("SubProtocol")!;
        protocol.SetValue(info, Enum.ToObject(protocol.PropertyType, 1)); // hls
        info.SetOption("h264", "profile", "high,main,baseline,constrainedbaseline");
        info.SetOption("h264", "level", "51");
        info.SetOption("h264", "rangetype", "SDR");
        info.SetOption("aac", "audiochannels", "2");
        return info.ToUrl(null, PrivacyTestHost.CallerToken, "&allowVideoStreamCopy=false&allowAudioStreamCopy=false");
    }

    /// <summary>The host's subtitle delivery URL (StreamInfo's template, "Stream.{format}", the caller's token).</summary>
    internal static string HostSubtitleUrl(Guid itemId, string sourceId, int index) => "/Videos/" + itemId.ToString("D") + "/" + sourceId + "/Subtitles/" + index + "/0/Stream.srt?ApiKey=" + PrivacyTestHost.CallerToken;

    /// <summary>A playback answer for the guarded episode: a file source with transcoding and an external subtitle, and an HTTP source.</summary>
    internal static PlaybackInfoResponse Playback(PlaybackInfoResponse captured, Guid itemId, string secret)
    {
        var file = captured.MediaSources[0];
        file.SupportsDirectPlay = false; file.SupportsDirectStream = false;
        file.MediaStreams = file.MediaStreams.Concat([
            new MediaStream { Type = MediaStreamType.Audio, Index = 1, Codec = "aac", Language = "eng", Channels = 2, ChannelLayout = "stereo", IsDefault = true },
            new MediaStream { Type = MediaStreamType.Subtitle, Index = 2, Codec = "subrip", Language = "eng", IsExternal = true, SupportsExternalStream = true,
                Path = "/media/" + secret + ".en.srt", DeliveryMethod = SubtitleDeliveryMethod.External, DeliveryUrl = HostSubtitleUrl(itemId, file.Id, 2) },
        ]).ToArray();
        file.TranscodingUrl = HostTranscodingUrl(itemId, file);
        file.TranscodingSubProtocol = (Jellyfin.Data.Enums.MediaStreamProtocol)1;
        file.TranscodingContainer = "ts";
        var http = new MediaSourceInfo
        {
            Id = "5a5e1f0e2d3c4b5a69788796a5b4c3d2", Protocol = MediaProtocol.Http, Path = "http://media.invalid/" + secret + ".mkv", Container = "mkv", Name = secret, IsRemote = true,
            SupportsDirectPlay = true, SupportsDirectStream = true, SupportsTranscoding = false, RequiredHttpHeaders = new Dictionary<string, string> { ["User-Agent"] = "JE " + secret },
            MediaStreams = [new MediaStream { Type = MediaStreamType.Video, Index = 0, Codec = "h264", Width = 320, Height = 180 }, new MediaStream { Type = MediaStreamType.Audio, Index = 1, Codec = "aac", Language = "eng", Channels = 2 }],
            MediaAttachments = [], Formats = [], Type = MediaSourceType.Default,
        };
        return new PlaybackInfoResponse { MediaSources = [file, http], PlaySessionId = captured.PlaySessionId };
    }

    [Theory]
    [InlineData("query parameter", "&Title=Secret.Ending.r21.mkv")]
    [InlineData("known parameter's value", "&PlaySessionId=SecretEndingr21")]
    [InlineData("codec list", "&SubtitleCodec=srt,SecretEndingr21")]
    [InlineData("codec option", "&h264-profile=high,SecretEndingr21")]
    [InlineData("percent-encoded value", "&Title=Secret%2EEnding%2Er21")]
    [InlineData("dotted unknown parameter", "&Secret.Ending.r21=1")]
    public async Task ATranscodingUrlIsRebuiltFromTheHostsTemplate(string what, string planted)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        rig.Commit(Rule("sg-series"), rig.Admin);
        var shot = Shot("MediaInfo.GetPlaybackInfo.json");
        var id = Role("episode:show-e1");
        var answer = Playback((PlaybackInfoResponse)PrivacyHostShapeModelTests.Value(shot), id, "Secret ending r21");
        var host = answer.MediaSources[0].TranscodingUrl!;
        answer.MediaSources[0].TranscodingUrl = host + planted;
        var (result, body) = await PrivacyHostShapeModelTests.Deliver(rig, shot, answer: answer);
        Assert.IsAssignableFrom<ObjectResult>(result);
        AssertAbsent(body, "SecretEnding", what);
        AssertAbsent(body, "Secret.Ending", what);
        AssertAbsent(body, "Secret%2EEnding", what);
        // The host's own URL is delivered exactly as the host built it (the parameter the original carried, nothing else).
        Assert.Equal(host, JsonNode.Parse(body)!["MediaSources"]![0]!["TranscodingUrl"]!.ToString());
    }

    [Theory]
    [InlineData("file name", "/Videos/{id}/{source}/Subtitles/2/0/SecretEnding.srt?ApiKey={token}")]
    [InlineData("dotted file name", "/Videos/{id}/{source}/Subtitles/2/0/Secret.Ending.r21.srt?ApiKey={token}")]
    [InlineData("query parameter", "/Videos/{id}/{source}/Subtitles/2/0/Stream.srt?ApiKey={token}&Title=SecretEnding")]
    [InlineData("format segment", "/Videos/{id}/{source}/Subtitles/2/0/Stream.SecretEnding")]
    public async Task ADeliveryUrlIsRebuiltWithTheHostsFileName(string what, string planted)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        rig.Commit(Rule("sg-series"), rig.Admin);
        var shot = Shot("MediaInfo.GetPlaybackInfo.json");
        var id = Role("episode:show-e1");
        var answer = Playback((PlaybackInfoResponse)PrivacyHostShapeModelTests.Value(shot), id, "Secret ending r21");
        var subtitle = answer.MediaSources[0].MediaStreams.Single(s => s.Type == MediaStreamType.Subtitle);
        var host = subtitle.DeliveryUrl;
        subtitle.DeliveryUrl = planted.Replace("{id}", id.ToString("D"), StringComparison.Ordinal).Replace("{source}", answer.MediaSources[0].Id, StringComparison.Ordinal)
            .Replace("{token}", PrivacyTestHost.CallerToken, StringComparison.Ordinal);
        var (result, body) = await PrivacyHostShapeModelTests.Deliver(rig, shot, answer: answer);
        Assert.IsAssignableFrom<ObjectResult>(result);
        AssertAbsent(body, "SecretEnding", what);
        AssertAbsent(body, "Secret.Ending", what);
        var delivered = JsonNode.Parse(body)!["MediaSources"]![0]!["MediaStreams"]!.AsArray().Single(s => s!["Type"]!.ToString() == "Subtitle")!["DeliveryUrl"]?.ToString();
        // A host-shaped URL is the host's own; one whose format is not a subtitle format is left out.
        if (what == "format segment") Assert.Null(delivered);
        else Assert.Equal(host, delivered);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // D46-R20-4: extras (theme videos, trailers, featurettes) in the tag cache, and in native poster tags, follow their owner.

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task AGuardedOrHiddenTitlesExtrasLeaveNoTextInTheTagCache(bool stripTags)
    {
        using var tags = new PrivacyReviewRound19Tests.TagSite(rules: true, stripTags, extras: true);
        var body = await tags.TagCache();
        // With the tag strip off, the viewer's switch reveals a guarded entry's genres (as for every guarded entry).
        var leaked = tags.Sentinels.In(body).Where(p => p.Contains("Extra", StringComparison.Ordinal) && (stripTags || !p.EndsWith(".Genres[]", StringComparison.Ordinal))).ToList();
        Assert.True(leaked.Count == 0, "tag cache: " + leaked.Count + " extra members delivered, e.g. " + string.Join(", ", leaked.Take(20)));
        // The hidden movie's extra is not answered at all; the guarded series' extra is answered, stripped.
        Assert.DoesNotContain(tags.MovieExtra.ToString("N"), body, StringComparison.Ordinal);
        Assert.Contains(tags.SeriesExtra.ToString("N"), body, StringComparison.Ordinal);
    }

    [Fact]
    public void TagDataGivesTheSameVerdictForExtras()
    {
        using var tags = new PrivacyReviewRound19Tests.TagSite(rules: true, stripTags: true, extras: true);
        var body = tags.TagData(tags.SeriesExtra, tags.MovieExtra);
        var leaked = tags.Sentinels.In(body).Where(p => p.Contains("Extra", StringComparison.Ordinal)).ToList();
        Assert.True(leaked.Count == 0, "tag data: " + string.Join(", ", leaked.Take(20)));
    }

    [Fact]
    public async Task ExtrasKeepEveryValueForAViewerWithoutRules()
    {
        using var tags = new PrivacyReviewRound19Tests.TagSite(rules: false, stripTags: true, extras: true);
        var body = await tags.TagCache();
        var missing = tags.Sentinels.Planted.Where(p => p.Value.Contains("ExtraEntry", StringComparison.Ordinal) && !body.Contains(p.Key, StringComparison.Ordinal)).Select(p => p.Value).ToList();
        Assert.True(missing.Count == 0, "missing: " + string.Join(", ", missing.Take(20)));
    }

    [Fact]
    public void NativePosterTagsGiveAGuardedSeriesExtraItsOwnersVerdict()
    {
        using var tags = new PrivacyReviewRound19Tests.TagSite(rules: true, stripTags: true, extras: true);
        Assert.True(tags.Stripper.IsGuarded(tags.State, tags.SeriesExtra, "Video", null), "the stamper's spoiler scope for a guarded series' theme video");
        var config = tags.Fixture.Plugin.Configuration;
        var policy = Jellyfin.Plugin.JellyfinEnhanced.Services.SpoilerTagDataStripper.CreatePolicy(config, tags.State)!;
        Assert.NotNull(policy);
        var entry = new Jellyfin.Plugin.JellyfinEnhanced.Model.TagCacheEntry { Type = "Video", LastUpdated = 1 };
        tags.Sentinels.Plant(entry, "posterExtraEntry", new HashSet<string> { "Type", "SeriesId" });
        var stripped = tags.Stripper.StripEntry(policy, tags.Alice, tags.Items[tags.SeriesExtra], entry, out var changed);
        Assert.True(changed);
        var leaked = tags.Sentinels.In(JsonSerializer.Serialize(stripped)).Where(p => p.StartsWith("posterExtra", StringComparison.Ordinal)).ToList();
        Assert.True(leaked.Count == 0, "poster entry: " + string.Join(", ", leaked.Take(20)));
    }

    // ---------------------------------------------------------------------------------------------------------------
    // D46-R20-5: shapes are host-required: a collection the host sent stays a collection, empty when withheld.

    [Fact]
    public async Task AGuardedHttpSourceKeepsItsHeaderCollectionEmptyNotNull()
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        rig.Commit(Rule("sg-series"), rig.Admin);
        var shot = Shot("MediaInfo.GetPlaybackInfo.json");
        var answer = Playback((PlaybackInfoResponse)PrivacyHostShapeModelTests.Value(shot), Role("episode:show-e1"), "Secret ending r21");
        var (_, body) = await PrivacyHostShapeModelTests.Deliver(rig, shot, answer: answer);
        AssertAbsent(body, "Secret ending r21", "playback info");
        foreach (var source in JsonNode.Parse(body)!["MediaSources"]!.AsArray())
        {
            // The remote URL is withheld, so the client is offered the host's stream route instead of direct play.
            if (source!["Protocol"]!.ToString() == "Http") { Assert.Null(source["Path"]); Assert.False(source["SupportsDirectPlay"]!.GetValue<bool>()); Assert.True(source["SupportsDirectStream"]?.GetValue<bool>() ?? true); }
            Assert.Equal("{}", source!["RequiredHttpHeaders"]?.ToJsonString());
            Assert.IsType<JsonArray>(source["MediaStreams"]);
            Assert.IsType<JsonArray>(source["MediaAttachments"]);
        }
    }

    public static IEnumerable<object[]> ShapeCases() => new[]
    {
        new object[] { "hc-r19-movie", "Session.GetSessions.admin-r19.json", "movie:r19-hidden" },
        ["hc-r19-movie", "Session.WebSocket.admin-r19.json", "movie:r19-hidden"],
        ["sg-r19-series", "Session.GetSessions.admin-r19.json", "episode:r19-e3"],
        ["sg-r19-series", "UserLibrary.GetItem.r19-e3.json", "episode:r19-e3"],
    };

    [Theory]
    [MemberData(nameof(ShapeCases))]
    public async Task EveryCollectionTheHostSentStaysACollection(string ruleId, string file, string role)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        rig.Commit(Rule(ruleId), rig.Admin);
        var shot = Shot(file);
        var answer = PrivacyHostShapeModelTests.Value(shot);
        foreach (var dto in PrivacyReviewRound19Tests.Dtos(answer, Role(role)))
        {
            // The host's own collections, some of whose values are withheld on a protected item.
            dto.MediaSources ??= [new MediaSourceInfo { Id = dto.Id.ToString("N"), Protocol = MediaProtocol.Http, MediaStreams = [], MediaAttachments = [], Formats = [] }];
            foreach (var source in dto.MediaSources) source.RequiredHttpHeaders = new Dictionary<string, string> { ["Referer"] = "https://example.invalid/r21" };
            dto.Chapters ??= [new ChapterInfo { Name = "Secret chapter r21", StartPositionTicks = 0 }];
            dto.Taglines ??= ["Secret tagline r21"];
            dto.Tags ??= ["Secret tag r21"];
            dto.ProductionLocations ??= ["Secret place r21"];
        }
        var before = JsonNode.Parse(JsonSerializer.Serialize(answer, answer.GetType(), PrivacyHostShapeModelTests.Json))!;
        var (_, body) = await PrivacyHostShapeModelTests.Deliver(rig, shot, answer: answer);
        var originals = new List<JsonObject>();
        void Walk(JsonNode? node)
        {
            if (node is JsonArray a) { foreach (var c in a) Walk(c); return; }
            if (node is not JsonObject o) return;
            if (IsItem(o, Role(role))) originals.Add(o);
            foreach (var (_, c) in o) Walk(c);
        }
        Walk(before);
        var after = Delivered(body, Role(role));
        Assert.NotEmpty(after);
        // Each delivered copy against its own original (the answer keeps its order: listed, nested, queued).
        Assert.Equal(originals.Count, after.Count);
        foreach (var (original, item) in originals.Zip(after))
            foreach (var (member, value) in original.Where(m => m.Value is JsonArray or JsonObject))
                Assert.True(item[member]?.GetValueKind() == value!.GetValueKind(), file + ": " + member + " was " + value.GetValueKind() + ", delivered " + (item[member]?.GetValueKind().ToString() ?? "missing"));
        // Nested: every delivered media source keeps its header collection.
        foreach (var item in after)
            foreach (var source in item["MediaSources"]?.AsArray() ?? [])
                Assert.Equal(JsonValueKind.Object, source!["RequiredHttpHeaders"]?.GetValueKind());
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Sentinels INSIDE valid shapes: a composite rating, URL query parameters and file-name segments, library entities that
    // exist with the sentinel's name, dotted and percent-encoded forms. Absent for a hiding and a guarding viewer; a viewer
    // without rules gets every one.

    public sealed record ShapeSite(string Name, string File, string Rule, string Role, bool Playback);

    public static readonly ShapeSite[] ShapeSites =
    [
        new("sessions REST: hidden now-playing", "Session.GetSessions.admin-r19.json", "hc-r19-movie", "movie:r19-hidden", false),
        new("sessions WebSocket: hidden now-playing", "Session.WebSocket.admin-r19.json", "hc-r19-movie", "movie:r19-hidden", false),
        new("item page: guarded episode", "UserLibrary.GetItem.r19-e3.json", "sg-r19-series", "episode:r19-e3", false),
        new("episode list: guarded episode", "TvShows.GetEpisodes.r19.json", "sg-r19-series", "episode:r19-e3", false),
        new("sessions REST: guarded now-playing", "Session.GetSessions.admin-r19.json", "sg-r19-series", "episode:r19-e3", false),
        new("sessions WebSocket: guarded now-playing", "Session.WebSocket.admin-r19.json", "sg-r19-series", "episode:r19-e3", false),
        new("playback info: guarded episode", "MediaInfo.GetPlaybackInfo.json", "sg-series", "episode:show-e1", true),
    ];

    public static IEnumerable<object[]> ShapeSweepCells() => ShapeSites.SelectMany(s => new[] { new object[] { s.Name, "rule" }, [s.Name, "none"] });

    /// <summary>The planted values: each sentinel sits inside a value its member's format otherwise accepts.</summary>
    private static Dictionary<string, string> PlantInShapes(PrivacyHostShapeModelTests.Rig rig, ShapeSite site, object answer, PrivacyReviewRound19Tests.Sentinels sentinels)
    {
        var forms = new Dictionary<string, string>(StringComparer.Ordinal);
        string S(string where) { var t = sentinels.Token(where); forms[t] = where; return t; }
        var id = Role(site.Role);
        var sources = new List<MediaSourceInfo>();
        if (site.Playback)
        {
            sources.AddRange(((PlaybackInfoResponse)answer).MediaSources);
        }
        else
        {
            var dtos = PrivacyReviewRound19Tests.Dtos(answer, id);
            Assert.NotEmpty(dtos);
            var genre = S("library genre entity");
            var studio = S("library studio entity");
            var person = S("library person entity");
            var genreId = Entity<Genre>(rig, genre);
            var studioId = Entity<Studio>(rig, studio);
            var personId = Entity<Person>(rig, person);
            var rating = S("composite rating text:PG") + ":PG";
            foreach (var dto in dtos)
            {
                dto.OfficialRating = rating;
                dto.Genres = [genre];
                dto.GenreItems = [new NameGuidPair { Name = genre, Id = genreId }];
                dto.Studios = [new NameGuidPair { Name = studio, Id = studioId }];
                dto.People = [new BaseItemPerson { Name = person, Id = personId, Type = PersonKind.Actor }];
                dto.ProviderIds = new Dictionary<string, string>(dto.ProviderIds ?? new()) { ["Imdb"] = "tt" + S("provider id") };
                dto.MediaSources ??= [new MediaSourceInfo { Id = dto.Id.ToString("N"), Protocol = MediaProtocol.File, MediaStreams = [], MediaAttachments = [], Formats = [] }];
                sources.AddRange(dto.MediaSources);
                foreach (var stream in dto.MediaStreams ?? []) if (stream.Type == MediaStreamType.Audio) stream.Language = "en-" + S("language region");
            }
        }
        foreach (var source in sources)
        {
            source.TranscodingUrl = "/videos/" + id.ToString("D") + "/master.m3u8?DeviceId=" + PrivacyTestHost.CallerDeviceId + "&MediaSourceId=" + source.Id + "&VideoCodec=h264&" + S("query parameter name")
                + "=1&Title=The.Death.of." + S("dotted query value") + ".mkv&Comment=" + Uri.EscapeDataString(S("percent-encoded query value") + " ending") + "&ApiKey=" + PrivacyTestHost.CallerToken;
            source.RequiredHttpHeaders = new Dictionary<string, string> { ["User-Agent"] = S("header value") };
            foreach (var attachment in source.MediaAttachments ?? []) attachment.DeliveryUrl = "/Videos/" + id.ToString("D") + "/" + source.Id + "/Attachments/0?Name=" + S("attachment query");
            source.MediaStreams = (source.MediaStreams ?? []).Append(new MediaStream
            {
                Type = MediaStreamType.Subtitle, Index = 40, Codec = "subrip", IsExternal = true, Language = "eng", DeliveryMethod = SubtitleDeliveryMethod.External,
                DeliveryUrl = "/Videos/" + id.ToString("D") + "/" + source.Id + "/Subtitles/40/0/The.Death.of." + S("dotted subtitle file name") + ".srt?ApiKey=" + PrivacyTestHost.CallerToken,
            }).ToArray();
        }
        return forms;
    }

    [Theory]
    [MemberData(nameof(ShapeSweepCells))]
    public async Task NoSentinelInsideAValidShapeSurvivesAProjectionSite(string siteName, string mode)
    {
        var site = ShapeSites.Single(s => s.Name == siteName);
        using var rig = new PrivacyHostShapeModelTests.Rig();
        if (mode == "rule") rig.Commit(Rule(site.Rule), rig.Admin);
        var shot = Shot(site.File);
        var answer = site.Playback ? Playback((PlaybackInfoResponse)PrivacyHostShapeModelTests.Value(shot), Role(site.Role), "Secret ending r21") : PrivacyHostShapeModelTests.Value(shot);
        var sentinels = new PrivacyReviewRound19Tests.Sentinels();
        var forms = PlantInShapes(rig, site, answer, sentinels);
        var (result, body) = await PrivacyHostShapeModelTests.Deliver(rig, shot, answer: answer);
        Assert.IsAssignableFrom<ObjectResult>(result);
        // Look for each sentinel in the bytes and in their decoded form (a percent-encoded value).
        var decoded = Uri.UnescapeDataString(body);
        if (mode == "rule")
        {
            var leaked = forms.Where(f => body.Contains(f.Key, StringComparison.Ordinal) || decoded.Contains(f.Key, StringComparison.Ordinal)).Select(f => f.Value).ToList();
            Assert.True(leaked.Count == 0, site.Name + ": " + leaked.Count + " of " + forms.Count + " planted values delivered: " + string.Join(", ", leaked));
        }
        else
        {
            var missing = forms.Where(f => !decoded.Contains(f.Key, StringComparison.Ordinal)).Select(f => f.Value).ToList();
            Assert.True(missing.Count == 0, site.Name + " (no rule): missing " + string.Join(", ", missing));
        }
    }

    [Theory]
    [InlineData("rule")]
    [InlineData("none")]
    public async Task NoSentinelInsideAValidShapeSurvivesTheTagCache(string mode)
    {
        // Composite ratings and region-tagged languages in every entry the viewer's rules touch: the guarded episode, the
        // exempt first season (its entry carries values of its episodes), the hidden movie and both extras.
        var planted = new List<string>();
        using var site = new PrivacyReviewRound19Tests.TagSite(rules: mode == "rule", stripTags: false, extras: true, edit: entries =>
        {
            foreach (var (key, entry) in entries)
            {
                var token = "ZR" + key[..6] + "RZ";
                planted.Add(token);
                entry.OfficialRating = token + ":PG";
                entry.AudioLanguages = ["eng", "en-" + token[..2]];
                // A genre the library has because the item named it (a season entry aggregates its episodes' genres).
                entry.Genres = [.. entry.Genres ?? [], token + " genre"];
            }
        });
        var body = await site.TagCache();
        Assert.NotEmpty(planted);
        if (mode == "rule")
        {
            var leaked = planted.Where(t => body.Contains(t, StringComparison.Ordinal)).ToList();
            Assert.True(leaked.Count == 0, "tag cache: " + string.Join(", ", leaked));
        }
        else
        {
            Assert.All(planted, t => Assert.Contains(t, body, StringComparison.Ordinal));
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // The playback answers jellyfin-web's real playback functions run on (tests/fixtures/host-web/playback/<host>.json).

    internal static async Task<string> PlaybackPayloads()
    {
        var cases = new JsonArray();
        var id = Role("episode:show-e1");
        foreach (var ruleId in new[] { "none", "sg-series" })
        {
            using var rig = new PrivacyHostShapeModelTests.Rig();
            if (ruleId != "none") rig.Commit(Rule(ruleId), rig.Admin);
            var shot = Shot("MediaInfo.GetPlaybackInfo.json");
            var (_, playback) = await PrivacyHostShapeModelTests.Deliver(rig, shot, answer: Playback((PlaybackInfoResponse)PrivacyHostShapeModelTests.Value(shot), id, "Secret ending r21"));
            var (_, page) = await PrivacyHostShapeModelTests.Deliver(rig, Shot("UserLibrary.GetItem.episode.json"));
            var item = JsonNode.Parse(page)!.AsObject();
            cases.Add(new JsonObject
            {
                ["id"] = ruleId,
                ["rule"] = ruleId,
                ["protected"] = new JsonArray((ruleId == "none" ? [] : Rule(ruleId).Subject.Append("Secret ending r21")).Select(t => (JsonNode?)t).ToArray()),
                ["item"] = new JsonObject { ["Id"] = item["Id"]!.DeepClone(), ["Type"] = item["Type"]!.DeepClone(), ["MediaType"] = item["MediaType"]?.DeepClone(), ["Name"] = item["Name"]!.DeepClone(), ["ServerId"] = item["ServerId"]?.DeepClone() },
                ["playback"] = JsonNode.Parse(playback),
            });
        }
        return new JsonObject
        {
            ["host"] = PrivacyHostShapeModelTests.HostName,
            ["caller"] = new JsonObject { ["deviceId"] = PrivacyTestHost.CallerDeviceId, ["token"] = PrivacyTestHost.CallerToken },
            ["cases"] = cases,
        }.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n";
    }

    /// <summary>
    /// The checked-in playback payloads are exactly what this build delivers (set JE_HOST_WEB_PLAYBACK to a directory to
    /// rewrite them), so the frontend test runs jellyfin-web's playback functions on this build's projection.
    /// </summary>
    [Fact]
    public async Task TheWebClientsPlaybackPayloadsAreWhatThisBuildDelivers()
    {
        var current = await PlaybackPayloads();
        if (Environment.GetEnvironmentVariable("JE_HOST_WEB_PLAYBACK") is { Length: > 0 } dir)
            await File.WriteAllTextAsync(Path.Combine(dir, PrivacyHostShapeModelTests.HostName + ".json"), current);
        using var stream = typeof(PrivacyReviewRound20Tests).Assembly.GetManifestResourceStream("JE.Tests.HostWebPlayback." + PrivacyHostShapeModelTests.HostName);
        Assert.NotNull(stream);
        var committed = await new StreamReader(stream!).ReadToEndAsync();
        Assert.Equal(committed.ReplaceLineEndings("\n"), current.ReplaceLineEndings("\n"));
    }
}
