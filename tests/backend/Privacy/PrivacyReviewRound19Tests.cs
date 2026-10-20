using System.Collections;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Data.Enums;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Providers;
using MediaBrowser.Model.Search;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

/// <summary>A media stream type the host's own code does not know (another plugin's, a future host's).</summary>
public class DerivedMediaStream : MediaStream
{
    public string? ExtraLabel { get; set; }
}

/// <summary>An item DTO with a property the host's classification does not name.</summary>
public class DerivedItemDto : BaseItemDto
{
    public string? NewEpisodeTitle { get; set; }
}

/// <summary>
/// Review round 19 (values, not fields): a protected item's projection keeps no free-text value that something other than
/// a validator or JE's own construction let through. D46-R19-1: a media stream's language tag is free text (ffmpeg
/// accepts any tag; the host shows the raw tag when it cannot localise it) and was copied into hidden stubs and guarded
/// items. D46-R19-2: dictionaries were copied whole (ProviderIds["EpisodeSlug"], MediaSources' RequiredHttpHeaders
/// ["Referer"]). D46-R19-3: runtime types outside the declared names (a derived MediaStream[], a BaseItemDto subclass with
/// an extra property) bypassed the classification. D46-R19-4: search hints asked their own two-kind list, so a guarded
/// unwatched season kept its name and matched term. Then the sentinel sweep: every string member the hosts' DTO lists
/// name, plus runtime extensions, planted in a protected item and run through every projection site for a hiding viewer
/// and a guarding viewer: no sentinel survives in the bytes; a viewer without rules gets every one. Uses only the
/// filters' and gate's existing surface (constructed reflectively), so the same file runs against the pre-fix build.
/// </summary>
[Collection("Plugin singleton")]
public class PrivacyReviewRound19Tests
{
    private static PrivacyHostShapeModelTests.Shot Shot(string file) => PrivacyHostShapeModelTests.Data.Shots.Single(s => s.File == file);

    private static Guid Role(string role) => PrivacyHostShapeModelTests.G(PrivacyHostShapeModelTests.Data.Roles[role]);

    private static PrivacyHostShapeModelTests.Rule Rule(string id) => PrivacyHostShapeModelTests.Rules.Single(r => r.Id == id);

    /// <summary>Every BaseItemDto in an answer's graph with this id (listed, nested, queued).</summary>
    internal static List<BaseItemDto> Dtos(object? node, Guid id)
    {
        var found = new List<BaseItemDto>();
        var seen = new HashSet<object>(ReferenceEqualityComparer.Instance);
        void Walk(object? value, int depth)
        {
            if (value == null || depth > 8 || value is string || value.GetType().IsValueType || !seen.Add(value)) return;
            if (value is BaseItemDto dto && dto.Id == id) found.Add(dto);
            if (value is IEnumerable sequence) { foreach (var element in sequence) Walk(element, depth + 1); return; }
            foreach (var p in value.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance).Where(p => p.GetIndexParameters().Length == 0 && !p.PropertyType.IsValueType && p.PropertyType != typeof(string)))
                Walk(p.GetValue(value), depth + 1);
        }
        Walk(node, 0);
        return found;
    }

    private static void AssertAbsent(string body, string text, string where)
    {
        var at = body.IndexOf(text, StringComparison.Ordinal);
        Assert.True(at < 0, where + ": \"" + text + "\" delivered near: " + (at < 0 ? "" : body.Substring(Math.Max(0, at - 120), Math.Min(240, body.Length - Math.Max(0, at - 120)))));
    }

    // ---------------------------------------------------------------------------------------------------------------
    // D46-R19-1: a language tag that is title text, in a hidden stub and in a guarded episode.

    private const string LanguageTitle = "Secret language r20 title";

    private static void TitleLanguage(BaseItemDto dto)
    {
        var streams = dto.MediaStreams ?? [];
        var audio = streams.Where(s => s.Type == MediaStreamType.Audio).ToArray();
        var subtitle = streams.FirstOrDefault(s => s.Type == MediaStreamType.Subtitle);
        Assert.NotEmpty(audio);
        audio[^1].Language = LanguageTitle;
        // 12.x also carries the host's localized name of the language (10.11 has no such member).
        typeof(MediaStream).GetProperty("LocalizedLanguage")?.SetValue(audio[^1], LanguageTitle);
        if (subtitle != null) subtitle.Language = LanguageTitle + " subtitles";
        foreach (var source in dto.MediaSources ?? [])
            foreach (var stream in source.MediaStreams ?? []) if (stream.Type is MediaStreamType.Audio or MediaStreamType.Subtitle && stream.Index == audio[^1].Index) stream.Language = LanguageTitle;
    }

    public static IEnumerable<object[]> LanguageCases() => new[]
    {
        new object[] { "hc-r19-movie", "Session.GetSessions.admin-r19.json", "movie:r19-hidden" },
        ["hc-r19-movie", "Session.WebSocket.admin-r19.json", "movie:r19-hidden"],
        ["sg-r19-series", "Session.GetSessions.admin-r19.json", "episode:r19-e3"],
        ["sg-r19-series", "Session.WebSocket.admin-r19.json", "episode:r19-e3"],
        ["sg-r19-series", "UserLibrary.GetItem.r19-e3.json", "episode:r19-e3"],
        ["sg-r19-series", "TvShows.GetEpisodes.r19.json", "episode:r19-e3"],
    };

    [Theory]
    [MemberData(nameof(LanguageCases))]
    public async Task ALanguageTagThatIsTitleTextNeverLeavesAProtectedItem(string ruleId, string file, string role)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        rig.Commit(Rule(ruleId), rig.Admin);
        var shot = Shot(file);
        var answer = PrivacyHostShapeModelTests.Value(shot);
        var targets = Dtos(answer, Role(role));
        Assert.NotEmpty(targets);
        foreach (var dto in targets) TitleLanguage(dto);
        var (result, body) = await PrivacyHostShapeModelTests.Deliver(rig, shot, answer: answer);
        Assert.IsAssignableFrom<ObjectResult>(result);
        AssertAbsent(body, "Secret language r20", file);
        // The tracks the host's menus list are still there, labelled from validated values.
        var delivered = JsonNode.Parse(body)!;
        var items = new List<JsonObject>();
        void Find(JsonNode? node)
        {
            if (node is JsonArray a) { foreach (var c in a) Find(c); return; }
            if (node is not JsonObject o) return;
            if (o["Id"]?.ToString().Replace("-", "", StringComparison.Ordinal) == Role(role).ToString("N") && o["MediaStreams"] is JsonArray) items.Add(o);
            foreach (var (_, c) in o) Find(c);
        }
        Find(delivered);
        Assert.NotEmpty(items);
        foreach (var item in items)
        {
            var audio = ((JsonArray)item["MediaStreams"]!).Where(s => s!["Type"]?.ToString() == "Audio").ToArray();
            Assert.Equal(targets[0].MediaStreams!.Count(s => s.Type == MediaStreamType.Audio), audio.Length);
            Assert.All(audio, s => Assert.False(string.IsNullOrWhiteSpace(s!["DisplayTitle"]?.ToString())));
            // A valid language keeps the host's localized name.
            Assert.Contains(audio, s => s!["DisplayTitle"]!.ToString().StartsWith("English", StringComparison.Ordinal));
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // D46-R19-2: dictionaries carry values per key, not as a whole.

    public static IEnumerable<object[]> DictionaryCases() => new[]
    {
        new object[] { "UserLibrary.GetItem.r19-e3.json" }, ["TvShows.GetEpisodes.r19.json"], ["Session.GetSessions.admin-r19.json"], ["Session.WebSocket.admin-r19.json"],
    };

    [Theory]
    [MemberData(nameof(DictionaryCases))]
    public async Task AProtectedItemsDictionariesKeepNoTitleValueAndNoTransportMember(string file)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        rig.Commit(Rule("sg-r19-series"), rig.Admin);
        var shot = Shot(file);
        var answer = PrivacyHostShapeModelTests.Value(shot);
        var targets = Dtos(answer, Role("episode:r19-e3"));
        Assert.NotEmpty(targets);
        foreach (var dto in targets)
        {
            dto.ProviderIds = new Dictionary<string, string>(dto.ProviderIds ?? new()) { ["EpisodeSlug"] = "secret-ending-r20-slug", ["Tvdb"] = "12345" };
            dto.MediaSources ??= [new MediaSourceInfo { Id = dto.Id.ToString("N"), Protocol = MediaBrowser.Model.MediaInfo.MediaProtocol.Http }];
            foreach (var source in dto.MediaSources)
                source.RequiredHttpHeaders = new Dictionary<string, string> { ["Referer"] = "https://example.invalid/secret-ending-r20-referer", ["User-Agent"] = "je" };
        }
        var (result, body) = await PrivacyHostShapeModelTests.Deliver(rig, shot, answer: answer);
        Assert.IsAssignableFrom<ObjectResult>(result);
        AssertAbsent(body, "secret-ending-r20-slug", file);
        AssertAbsent(body, "secret-ending-r20-referer", file);
        // The protected item's sources carry no transport headers at all (an unprotected item keeps the host's own).
        var id = Role("episode:r19-e3").ToString("N");
        var sources = new List<JsonNode>();
        void Walk(JsonNode? node)
        {
            if (node is JsonArray a) { foreach (var c in a) Walk(c); return; }
            if (node is not JsonObject o) return;
            if (o["Id"]?.ToString().Replace("-", "", StringComparison.Ordinal) == id && o["MediaSources"] is JsonArray list) sources.AddRange(list.OfType<JsonNode>());
            foreach (var (_, c) in o) Walk(c);
        }
        Walk(JsonNode.Parse(body));
        Assert.NotEmpty(sources);
        // Shapes are host-required too (D46-R20-5): the clients index it (RequiredHttpHeaders.length), so it stays an empty collection.
        Assert.All(sources, s => Assert.Equal("{}", s["RequiredHttpHeaders"]?.ToJsonString()));
    }

    // ---------------------------------------------------------------------------------------------------------------
    // D46-R19-3: runtime types outside the declared names are judged by what they are, on both paths.

    public static IEnumerable<object[]> RuntimeCases() => new[]
    {
        new object[] { "hc-r19-movie", "Session.GetSessions.admin-r19.json", "movie:r19-hidden", "streams" },
        ["hc-r19-movie", "Session.WebSocket.admin-r19.json", "movie:r19-hidden", "streams"],
        ["sg-r19-series", "UserLibrary.GetItem.r19-e3.json", "episode:r19-e3", "streams"],
        ["sg-r19-series", "Session.GetSessions.admin-r19.json", "episode:r19-e3", "streams"],
        ["sg-r19-series", "UserLibrary.GetItem.r19-e3.json", "episode:r19-e3", "subclass"],
        ["sg-r19-series", "TvShows.GetEpisodes.r19.json", "episode:r19-e3", "subclass"],
        ["hc-r19-movie", "Session.GetSessions.admin-r19.json", "movie:r19-hidden", "subclass"],
        ["sg-r19-series", "Session.GetSessions.admin-r19.json", "episode:r19-e3", "subclass"],
    };

    /// <summary>A copy of the DTO as the subclass, with the extra property carrying the title.</summary>
    private static DerivedItemDto Subclass(BaseItemDto dto)
    {
        var copy = new DerivedItemDto { NewEpisodeTitle = "Secret new episode title r20" };
        foreach (var p in typeof(BaseItemDto).GetProperties().Where(p => p.SetMethod is { IsPublic: true } && p.GetIndexParameters().Length == 0)) p.SetValue(copy, p.GetValue(dto));
        return copy;
    }

    /// <summary>Replaces every reference to <paramref name="from"/> in the graph (properties, arrays, lists) with <paramref name="to"/>.</summary>
    private static object Replace(object answer, object from, object to)
    {
        if (ReferenceEquals(answer, from)) return to;
        var seen = new HashSet<object>(ReferenceEqualityComparer.Instance);
        void Walk(object? node, int depth)
        {
            if (node == null || depth > 8 || node is string || node.GetType().IsValueType || !seen.Add(node)) return;
            if (node is IList list)
            {
                for (var i = 0; i < list.Count; i++) if (ReferenceEquals(list[i], from)) list[i] = to; else Walk(list[i], depth + 1);
                return;
            }
            foreach (var p in node.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance).Where(p => p.GetIndexParameters().Length == 0 && !p.PropertyType.IsValueType && p.PropertyType != typeof(string)))
            {
                var value = p.GetValue(node);
                if (ReferenceEquals(value, from) && p.SetMethod is { IsPublic: true }) p.SetValue(node, to);
                else if (value is IEnumerable and not IList && value is IReadOnlyList<BaseItemDto> items && items.Contains(from) && p.SetMethod is { IsPublic: true })
                    p.SetValue(node, items.Select(i => ReferenceEquals(i, from) ? (BaseItemDto)to : i).ToArray());
                else Walk(value, depth + 1);
            }
        }
        Walk(answer, 0);
        return answer;
    }

    [Theory]
    [MemberData(nameof(RuntimeCases))]
    public async Task RuntimeTypesTheClassificationDoesNotNameAreWithheldOnBothPaths(string ruleId, string file, string role, string shape)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        rig.Commit(Rule(ruleId), rig.Admin);
        var shot = Shot(file);
        var answer = PrivacyHostShapeModelTests.Value(shot);
        var targets = Dtos(answer, Role(role));
        Assert.NotEmpty(targets);
        foreach (var dto in targets)
        {
            if (shape == "streams")
            {
                // A derived element type, assigned through array covariance: the declared type is still MediaStream[].
                dto.MediaStreams = dto.MediaStreams!.Select(s =>
                {
                    var derived = new DerivedMediaStream { ExtraLabel = "Secret derived label r20" };
                    foreach (var p in typeof(MediaStream).GetProperties().Where(p => p.SetMethod is { IsPublic: true })) p.SetValue(derived, p.GetValue(s));
                    derived.Title = "Secret derived track r20";
                    return derived;
                }).ToArray();
            }
            else
            {
                answer = Replace(answer, dto, Subclass(dto));
            }
        }
        var (result, body) = await PrivacyHostShapeModelTests.Deliver(rig, shot, answer: answer);
        Assert.IsAssignableFrom<ObjectResult>(result);
        AssertAbsent(body, "Secret derived", file);
        AssertAbsent(body, "Secret new episode title r20", file);
        AssertAbsent(body, "NewEpisodeTitle", file);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // D46-R19-4: search hints ask the same verdict for every kind: a guarded unwatched season.

    [Theory]
    [InlineData(2, true)]
    [InlineData(1, false)]
    public async Task AGuardedUnwatchedSeasonInSearchHintsGetsItsNeutralNameLikeItsDto(int season, bool protectedSeason)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var series = Role("series:r19-show");
        var id = Guid.NewGuid();
        rig.Items[id] = new MediaBrowser.Controller.Entities.TV.Season { Id = id, SeriesId = series, IndexNumber = season, Name = "Secret season r20" };
        rig.Commit(Rule("sg-r19-series"), rig.Admin);
        var shot = Shot("Search.GetSearchHints.r19.json");
        var captured = (SearchHintResult)PrivacyHostShapeModelTests.Value(shot);
        var hint = new SearchHint
        {
            Id = id, ItemId = id, Type = BaseItemKind.Season, Name = "Secret season r20", MatchedTerm = "Secret season", Series = "D46 R19 Show", IndexNumber = season,
            MediaType = Jellyfin.Data.Enums.MediaType.Unknown, IsFolder = true,
        };
        var answer = new SearchHintResult(captured.SearchHints.Append(hint).ToArray(), captured.TotalRecordCount + 1);
        var (result, body) = await PrivacyHostShapeModelTests.Deliver(rig, shot, answer: answer);
        Assert.IsAssignableFrom<ObjectResult>(result);
        var delivered = JsonNode.Parse(body)!["SearchHints"]!.AsArray().Single(h => h!["Id"]!.ToString().Replace("-", "", StringComparison.Ordinal) == id.ToString("N"))!;
        if (protectedSeason)
        {
            AssertAbsent(body, "Secret season", "season " + season);
            Assert.Equal("Season " + season, delivered["Name"]!.ToString());
            Assert.Null(delivered["MatchedTerm"]);
        }
        else
        {
            // Seasons 0 and 1 are never guarded (the viewer's entry point), as on their own DTO.
            Assert.Equal("Secret season r20", delivered["Name"]!.ToString());
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // The sentinel sweep.

    /// <summary>Unique sentinels planted in every string member of a value (and runtime extensions), by member path.</summary>
    internal sealed class Sentinels
    {
        private int _next;
        public Dictionary<string, string> Planted { get; } = new(StringComparer.Ordinal);

        public string Token(string path)
        {
            var token = "ZQ" + (++_next).ToString("D4", System.Globalization.CultureInfo.InvariantCulture) + "QZ";
            Planted[token] = path;
            return token;
        }

        /// <summary>The planted members whose sentinel is in the bytes (bounded).</summary>
        public List<string> In(string bytes) => Planted.Where(p => bytes.Contains(p.Key, StringComparison.Ordinal)).Select(p => p.Value).ToList();

        /// <summary>The planted members whose sentinel is not in the bytes (bounded).</summary>
        public List<string> NotIn(string bytes) => Planted.Where(p => !bytes.Contains(p.Key, StringComparison.Ordinal)).Select(p => p.Value).ToList();

        private static readonly HashSet<Type> Nested =
        [
            typeof(MediaStream), typeof(MediaSourceInfo), typeof(MediaAttachment), typeof(ChapterInfo), typeof(BaseItemPerson), typeof(ExternalUrl),
            typeof(MediaUrl), typeof(NameGuidPair), typeof(UserItemDataDto), typeof(BaseItemDto),
            typeof(Jellyfin.Plugin.JellyfinEnhanced.Model.TagStreamData), typeof(Jellyfin.Plugin.JellyfinEnhanced.Model.TagMediaStream), typeof(Jellyfin.Plugin.JellyfinEnhanced.Model.TagMediaSource),
        ];

        /// <summary>Plants a sentinel in every writable string-typed member (strings, string lists, dictionary keys and values) at any depth.</summary>
        public void Plant(object target, string path, ISet<string> skip, int depth = 0)
        {
            foreach (var p in target.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance)
                         .Where(p => p.GetIndexParameters().Length == 0 && p.GetMethod is { IsPublic: true } && p.SetMethod is { IsPublic: true }))
            {
                var at = path + "." + p.Name;
                if (skip.Contains(p.Name) || skip.Contains(at)) continue;
                var type = p.PropertyType;
                var element = type.IsArray ? type.GetElementType() : type.IsGenericType && type.GetGenericArguments().Length == 1 ? type.GetGenericArguments()[0] : null;
                if (type == typeof(string)) p.SetValue(target, Token(at));
                else if (element == typeof(string) && type.IsAssignableFrom(typeof(string[]))) p.SetValue(target, new[] { Token(at + "[]") });
                else if (element == typeof(string) && type.IsAssignableFrom(typeof(List<string>))) p.SetValue(target, new List<string> { Token(at + "[]") });
                else if (type == typeof(Dictionary<string, string>))
                {
                    var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                    foreach (var key in ((Dictionary<string, string>?)p.GetValue(target))?.Keys ?? Enumerable.Empty<string>()) map[key] = Token(at + "{" + key + "}");
                    // Known provider keys with title text, and an unknown key whose name is the title.
                    if (p.Name == "ProviderIds") { map["Tmdb"] = Token(at + "{Tmdb}"); map["Imdb"] = Token(at + "{Imdb}"); }
                    map[Token(at + "{unknown key}")] = Token(at + "{unknown}");
                    p.SetValue(target, map);
                }
                else if (type == typeof(Dictionary<ImageType, string>)) p.SetValue(target, new Dictionary<ImageType, string> { [ImageType.Primary] = Token(at + "{Primary}") });
                else if (type == typeof(Dictionary<ImageType, Dictionary<string, string>>))
                    p.SetValue(target, new Dictionary<ImageType, Dictionary<string, string>> { [ImageType.Primary] = new() { [Token(at + "{Primary}{tag}")] = Token(at + "{Primary}{hash}") } });
                else if (type == typeof(Dictionary<string, Dictionary<int, TrickplayInfoDto>>))
                    p.SetValue(target, new Dictionary<string, Dictionary<int, TrickplayInfoDto>> { [Token(at + "{source}")] = new() { [320] = (TrickplayInfoDto)System.Runtime.CompilerServices.RuntimeHelpers.GetUninitializedObject(typeof(TrickplayInfoDto)) } });
                else if (depth < 3 && element != null && Nested.Contains(element))
                {
                    var current = ((IEnumerable?)p.GetValue(target))?.Cast<object?>().Where(e => e != null).ToList() ?? [];
                    if (current.Count == 0) current.Add(New(element, depth));
                    var i = 0;
                    foreach (var e in current) Plant(e!, at + "[" + i++ + "]", skip, depth + 1);
                    var array = Array.CreateInstance(element, current.Count);
                    for (var j = 0; j < current.Count; j++) array.SetValue(current[j], j);
                    p.SetValue(target, type.IsAssignableFrom(array.GetType()) ? array : Activator.CreateInstance(typeof(List<>).MakeGenericType(element), array));
                }
                else if (depth < 3 && Nested.Contains(type))
                {
                    var value = p.GetValue(target) ?? New(type, depth);
                    Plant(value, at, skip, depth + 1);
                    p.SetValue(target, value);
                }
            }
        }

        private static object New(Type type, int depth) => type == typeof(BaseItemDto)
            ? new BaseItemDto { Id = Guid.NewGuid(), Type = BaseItemKind.Program }
            : type == typeof(MediaStream) ? new MediaStream { Type = MediaStreamType.Audio, Index = 90 + depth }
            : Activator.CreateInstance(type)!;
    }

    /// <summary>Identity members (the decision is taken from them) and the item's own kind: not planted.</summary>
    private static readonly HashSet<string> Identity = ["Id", "ItemId", "SeriesId", "SeasonId", "ParentId", "ProgramId", "Type", "MediaType", "UserId", "ChannelId"];

    /// <summary>Where the protected item sits in a captured answer, and how its rule protects it.</summary>
    public sealed record Site(string Name, string File, string Rule, string Role, string Kind);

    public static readonly Site[] Sites =
    [
        // Hidden Content (a hiding viewer).
        new("sessions REST: hidden now-playing", "Session.GetSessions.admin-r19.json", "hc-r19-movie", "movie:r19-hidden", "dto"),
        new("sessions WebSocket: hidden now-playing (and 10.11 queue items)", "Session.WebSocket.admin-r19.json", "hc-r19-movie", "movie:r19-hidden", "dto"),
        new("item list: hidden movie", "Items.GetItems.r19.json", "hc-r19-movie", "movie:r19-hidden", "dto"),
        new("search hints: hidden movie", "Search.GetSearchHints.titles.json", "hc-movie", "movie:hidden", "hint"),
        new("activity: hidden movie", "ActivityLog.GetLogEntries.json", "hc-movie", "movie:hidden", "activity"),
        new("timers: hidden programme", "LiveTv.GetTimers.json", "hc-program-later", "program:later", "timer"),
        new("series timers: hidden programme", "LiveTv.GetSeriesTimers.json", "hc-program-later", "program:later", "timer"),
        // Spoiler Guard (a guarding viewer).
        new("item page: guarded episode", "UserLibrary.GetItem.r19-e3.json", "sg-r19-series", "episode:r19-e3", "dto"),
        new("episode list: guarded episode", "TvShows.GetEpisodes.r19.json", "sg-r19-series", "episode:r19-e3", "dto"),
        new("sessions REST: guarded now-playing", "Session.GetSessions.admin-r19.json", "sg-r19-series", "episode:r19-e3", "dto"),
        new("sessions WebSocket: guarded now-playing", "Session.WebSocket.admin-r19.json", "sg-r19-series", "episode:r19-e3", "dto"),
        new("search hints: guarded episode", "Search.GetSearchHints.r19.json", "sg-r19-series", "episode:r19-e3", "hint"),
        new("activity: guarded episode", "ActivityLog.GetLogEntries.json", "sg-series", "episode:show-e1", "activity"),
        new("playback info: guarded episode", "MediaInfo.GetPlaybackInfo.json", "sg-series", "episode:show-e1", "playback"),
        new("image infos: guarded episode", "Image.GetItemImageInfos.json", "sg-series", "episode:show-e1", "images"),
    ];

    public static IEnumerable<object[]> SweepCells() => Sites.SelectMany(s => new[] { new object[] { s.Name, "rule" }, [s.Name, "none"] });

    /// <summary>Plants sentinels in the site's protected item(s); returns how many places were planted.</summary>
    private static int PlantSite(Site site, object answer, Sentinels sentinels)
    {
        var id = Role(site.Role);
        var planted = 0;
        switch (site.Kind)
        {
            case "dto":
                foreach (var dto in Dtos(answer, id)) { sentinels.Plant(dto, "item" + planted++, Identity); }
                break;
            case "hint":
                foreach (var hint in ((SearchHintResult)answer).SearchHints.Where(h => h.Id == id)) { sentinels.Plant(hint, "hint" + planted++, Identity); }
                break;
            case "activity":
                foreach (var entry in ((MediaBrowser.Model.Querying.QueryResult<MediaBrowser.Model.Activity.ActivityLogEntry>)answer).Items.Where(e => Guid.TryParse(e.ItemId, out var g) && g == id))
                    sentinels.Plant(entry, "entry" + planted++, Identity);
                break;
            case "playback":
                foreach (var source in ((MediaBrowser.Model.MediaInfo.PlaybackInfoResponse)answer).MediaSources) sentinels.Plant(source, "source" + planted++, Identity);
                break;
            case "images":
                foreach (var image in (IEnumerable<ImageInfo>)answer) sentinels.Plant(image, "image" + planted++, Identity);
                break;
            case "timer":
                foreach (var timer in ((IEnumerable)answer.GetType().GetProperty("Items")!.GetValue(answer)!).Cast<MediaBrowser.Model.LiveTv.BaseTimerInfoDto>()
                             .Where(t => Guid.TryParse(t.ProgramId, out var g) && g == id))
                    sentinels.Plant(timer, "timer" + planted++, Identity);
                break;
        }
        return planted;
    }

    [Theory]
    [MemberData(nameof(SweepCells))]
    public async Task NoSentinelPlantedInAProtectedItemSurvivesAnyProjectionSite(string siteName, string mode)
    {
        var site = Sites.Single(s => s.Name == siteName);
        using var rig = new PrivacyHostShapeModelTests.Rig();
        if (mode == "rule")
        {
            var config = rig.F.Plugin.Configuration;
            // Every Spoiler Guard strip on: nothing is revealed by configuration.
            config.SpoilerStripTags = true; config.SpoilerStripChapters = true; config.SpoilerStripTaglines = true; config.SpoilerStripCast = true;
            config.SpoilerStripPremiereDate = true; config.SpoilerStripCastMode = "All";
            rig.Commit(Rule(site.Rule), rig.Admin);
        }
        var shot = Shot(site.File);
        var answer = PrivacyHostShapeModelTests.Value(shot);
        var sentinels = new Sentinels();
        Assert.True(PlantSite(site, answer, sentinels) > 0, "the captured answer holds the protected item");
        var (result, body) = await PrivacyHostShapeModelTests.Deliver(rig, shot, answer: answer);
        Assert.IsAssignableFrom<ObjectResult>(result);
        if (mode == "rule")
        {
            var leaked = sentinels.In(body);
            Assert.True(leaked.Count == 0, site.Name + ": " + leaked.Count + " of " + sentinels.Planted.Count + " planted members delivered, e.g. " + string.Join(", ", leaked.Take(20)));
        }
        else
        {
            // Positive control: the same planted values reach a viewer without rules.
            var missing = sentinels.NotIn(body);
            Assert.True(missing.Count == 0, site.Name + " (no rule): " + missing.Count + " of " + sentinels.Planted.Count + " planted members missing, e.g. " + string.Join(", ", missing.Take(20)));
        }
    }

    [Fact]
    public void TheSweepCoversEveryStringMemberTheHostsList()
    {
        // Every string-typed member of every type the walker touches (host lists) that can sit in a protected item.
        var host = PrivacyHostShapeModelTests.HostName;
        using var stream = typeof(PrivacyReviewRound19Tests).Assembly.GetManifestResourceStream("JE.Tests.HostDtoFields." + host)!;
        var rows = new StreamReader(stream).ReadToEnd().Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(l => l.Split('\t'))
            .Where(c => c[3].Trim() == "rw" && (c[2] == "String" || c[2].Contains("String", StringComparison.Ordinal)))
            .Select(c => (Type: c[0].Split('<')[0], Property: c[1])).ToHashSet();
        var item = new BaseItemDto();
        var sentinels = new Sentinels();
        sentinels.Plant(item, "item", Identity);
        var hint = new SearchHint();
        sentinels.Plant(hint, "hint", Identity);
        var entry = new MediaBrowser.Model.Activity.ActivityLogEntry("n", "t", Guid.Empty);
        sentinels.Plant(entry, "entry", Identity);
        var timer = new MediaBrowser.Model.LiveTv.TimerInfoDto();
        sentinels.Plant(timer, "timer", Identity);
        var seriesTimer = new MediaBrowser.Model.LiveTv.SeriesTimerInfoDto();
        sentinels.Plant(seriesTimer, "timer", Identity);
        var planted = sentinels.Planted.Values.ToHashSet();
        var types = new Dictionary<string, string>
        {
            ["BaseItemDto"] = "item", ["MediaStream"] = "item.MediaStreams[0]", ["MediaSourceInfo"] = "item.MediaSources[0]", ["MediaAttachment"] = "item.MediaSources[0].MediaAttachments[0]",
            ["ChapterInfo"] = "item.Chapters[0]", ["BaseItemPerson"] = "item.People[0]", ["ExternalUrl"] = "item.ExternalUrls[0]", ["MediaUrl"] = "item.RemoteTrailers[0]",
            ["NameGuidPair"] = "item.Studios[0]", ["UserItemDataDto"] = "item.UserData", ["SearchHint"] = "hint", ["ActivityLogEntry"] = "entry",
            ["TimerInfoDto"] = "timer", ["SeriesTimerInfoDto"] = "timer", ["BaseTimerInfoDto"] = "timer",
        };
        var missing = rows.Where(r => types.ContainsKey(r.Type) && !Identity.Contains(r.Property)
            && !planted.Any(p => p.StartsWith(types[r.Type] + "." + r.Property, StringComparison.Ordinal))).Select(r => r.Type + "." + r.Property).ToArray();
        Assert.True(missing.Length == 0, "string members the sweep does not plant: " + string.Join(", ", missing.Take(30)));
    }

    // ---------------------------------------------------------------------------------------------------------------
    // JE's own per-card answers (tag cache and tag data): the same verdicts and the same value rules.

    /// <summary>
    /// GET /tag-cache and POST /tag-data over a real TagCacheService: a movie Alice hides and an episode of a series she
    /// guards, every string member of their cache entries and of the library items tag data reads planted with sentinels.
    /// </summary>
    internal sealed class TagSite : IDisposable
    {
        public readonly ApiPluginFixture Fixture = new();
        public readonly Jellyfin.Database.Implementations.Entities.User Alice = new("alice", "default", "default") { Id = Guid.NewGuid() };
        public readonly Guid Movie = Guid.NewGuid(), Episode = Guid.NewGuid(), Series = Guid.NewGuid(), Season = Guid.NewGuid();
        public readonly Mock<MediaBrowser.Controller.Library.ILibraryManager> Library = new();
        public readonly Mock<MediaBrowser.Controller.Library.IMediaSourceManager> Media = new();
        public readonly Jellyfin.Plugin.JellyfinEnhanced.Services.TagCacheService Cache;
        public readonly Jellyfin.Plugin.JellyfinEnhanced.Controllers.JellyfinEnhancedController Controller;
        public readonly Sentinels Sentinels = new();
        /// <summary>Theme videos (extras) of the guarded series and of the hidden movie (with <c>extras</c>).</summary>
        public readonly Guid SeriesExtra = Guid.NewGuid(), MovieExtra = Guid.NewGuid();
        public Jellyfin.Plugin.JellyfinEnhanced.Services.SpoilerTagDataStripper Stripper { get; private set; } = null!;
        public Jellyfin.Plugin.JellyfinEnhanced.Configuration.UserSpoilerBlur State { get; } = new();
        public readonly Dictionary<Guid, MediaBrowser.Controller.Entities.BaseItem> Items = new();
        private readonly Microsoft.Extensions.DependencyInjection.ServiceProvider _provider;
        private readonly MediaBrowser.Controller.Library.ILibraryManager? _previousLibrary = MediaBrowser.Controller.Entities.BaseItem.LibraryManager;
        private readonly MediaBrowser.Controller.Library.IMediaSourceManager? _previousMedia = MediaBrowser.Controller.Entities.BaseItem.MediaSourceManager;
        private readonly MediaBrowser.Controller.LiveTv.IRecordingsManager? _previousRecordings = MediaBrowser.Controller.Entities.Video.RecordingsManager;
        private static readonly PropertyInfo? _segments = typeof(MediaBrowser.Controller.Entities.BaseItem).GetProperty("MediaSegmentManager", BindingFlags.Public | BindingFlags.Static);
        private readonly object? _previousSegments = _segments?.GetValue(null);

        public TagSite(bool rules, bool stripTags, bool extras = false, Action<Dictionary<string, Jellyfin.Plugin.JellyfinEnhanced.Model.TagCacheEntry>>? edit = null)
        {
            var config = Fixture.Plugin.Configuration;
            config.TagCacheServerMode = true;
            config.HiddenContentEnabled = true;
            config.SpoilerBlurEnabled = true; config.SpoilerReplaceTitle = true; config.SpoilerStripOverview = true; config.SpoilerStripRatings = true;
            config.SpoilerStripTags = stripTags;
            var users = new Mock<MediaBrowser.Controller.Library.IUserManager>();
            users.Setup(x => x.GetUserById(Alice.Id)).Returns(Alice);
            Library.Setup(x => x.GetItemIds(It.IsAny<MediaBrowser.Controller.Entities.InternalItemsQuery>()))
                .Returns((MediaBrowser.Controller.Entities.InternalItemsQuery q) => q.IsPlayed == true ? [] : extras ? [Movie, Episode, Season, SeriesExtra, MovieExtra] : [Movie, Episode, Season]);
            // Season 1 of the guarded series: exempt itself (the viewer's entry point), but its entry aggregates its episodes'
            // audio languages and carries its first episode's stream data and name.
            var season = new MediaBrowser.Controller.Entities.TV.Season { Id = Season, SeriesId = Series, IndexNumber = 1, Name = "Season 1" };
            Library.Setup(x => x.GetItemById<MediaBrowser.Controller.Entities.BaseItem>(Season, It.IsAny<Jellyfin.Database.Implementations.Entities.User>())).Returns(season);
            Library.Setup(x => x.GetItemById<MediaBrowser.Controller.Entities.BaseItem>(Season)).Returns(season);
            Library.Setup(x => x.GetItemById(Season)).Returns(season);
            // The library items tag data reads, with sentinels in what it emits.
            var movie = new MediaBrowser.Controller.Entities.Movies.Movie { Id = Movie, Path = "/media/" + Sentinels.Token("movie.Path") + ".mkv" };
            var episode = new MediaBrowser.Controller.Entities.TV.Episode { Id = Episode, SeriesId = Series, ParentIndexNumber = 1, IndexNumber = 3, Path = "/media/" + Sentinels.Token("episode.Path") + ".mkv" };
            foreach (var (item, name) in new (MediaBrowser.Controller.Entities.BaseItem, string)[] { (movie, "movie"), (episode, "episode") })
            {
                item.Name = Sentinels.Token(name + ".Name");
                item.Genres = [Sentinels.Token(name + ".Genres[]")];
                item.Tags = [Sentinels.Token(name + ".Tags[]")];
                item.OfficialRating = Sentinels.Token(name + ".OfficialRating");
                Library.Setup(x => x.GetItemById<MediaBrowser.Controller.Entities.BaseItem>(item.Id, It.IsAny<Jellyfin.Database.Implementations.Entities.User>())).Returns(item);
                Library.Setup(x => x.GetItemById(item.Id)).Returns(item);
                var streams = new List<MediaStream>
                {
                    new() { Type = MediaStreamType.Video, Index = 0, Codec = Sentinels.Token(name + ".stream.Codec"), CodecTag = Sentinels.Token(name + ".stream.CodecTag"), Profile = Sentinels.Token(name + ".stream.Profile"), Height = 1080, Title = Sentinels.Token(name + ".stream.Title") },
                    new() { Type = MediaStreamType.Audio, Index = 1, Codec = "aac", Language = Sentinels.Token(name + ".stream.Language"), ChannelLayout = Sentinels.Token(name + ".stream.ChannelLayout"), Channels = 2, Title = Sentinels.Token(name + ".audio.Title") },
                    new() { Type = MediaStreamType.Audio, Index = 2, Codec = "aac", Language = "eng", Channels = 2 },
                };
                Media.Setup(x => x.GetMediaStreams(item.Id)).Returns(streams);
                Items[item.Id] = item;
            }
            Items[Season] = season;
            // The series' own genre: the exempt season's (and every guarded entry's) genres come from it.
            Items[Series] = new MediaBrowser.Controller.Entities.TV.Series { Id = Series, Name = "Guarded show", Genres = ["Season genre"] };
            if (extras)
            {
                // Theme videos: owned by the guarded series and by the hidden movie; their own names, paths and streams carry text.
                foreach (var (extraId, owner, name) in new[] { (SeriesExtra, Series, "seriesExtra"), (MovieExtra, Movie, "movieExtra") })
                {
                    var video = new MediaBrowser.Controller.Entities.Video
                    {
                        Id = extraId, OwnerId = owner, ExtraType = ExtraType.ThemeVideo, Name = Sentinels.Token(name + ".Name"), Path = "/media/" + Sentinels.Token(name + ".Path") + ".mkv",
                        Genres = [Sentinels.Token(name + ".Genres[]")], OfficialRating = Sentinels.Token(name + ".OfficialRating") + ":PG",
                    };
                    Library.Setup(x => x.GetItemById<MediaBrowser.Controller.Entities.BaseItem>(extraId, It.IsAny<Jellyfin.Database.Implementations.Entities.User>())).Returns(video);
                    Library.Setup(x => x.GetItemById<MediaBrowser.Controller.Entities.BaseItem>(extraId)).Returns(video);
                    Library.Setup(x => x.GetItemById(extraId)).Returns(video);
                    Media.Setup(x => x.GetMediaStreams(extraId)).Returns(new List<MediaStream>
                    {
                        new() { Type = MediaStreamType.Video, Index = 0, Codec = "h264", Height = 720, Title = Sentinels.Token(name + ".stream.Title") },
                        new() { Type = MediaStreamType.Audio, Index = 1, Codec = "aac", Language = Sentinels.Token(name + ".stream.Language"), Channels = 2 },
                    });
                    Items[extraId] = video;
                }
            }
            Library.Setup(x => x.GetItemById(It.IsAny<Guid>())).Returns((Guid i) => Items.GetValueOrDefault(i)!);
            Library.Setup(x => x.GetItemList(It.IsAny<MediaBrowser.Controller.Entities.InternalItemsQuery>()))
                .Returns((MediaBrowser.Controller.Entities.InternalItemsQuery q) => (q.ItemIds ?? []).Select(i => Items.GetValueOrDefault(i)).OfType<MediaBrowser.Controller.Entities.BaseItem>().ToList());
            Media.Setup(x => x.GetMediaAttachments(It.IsAny<Guid>())).Returns([]);
            Media.Setup(x => x.GetPathProtocol(It.IsAny<string>())).Returns(MediaBrowser.Model.MediaInfo.MediaProtocol.File);
            MediaBrowser.Controller.Entities.BaseItem.LibraryManager = Library.Object;
            MediaBrowser.Controller.Entities.BaseItem.MediaSourceManager = Media.Object;
            MediaBrowser.Controller.Entities.Video.RecordingsManager = Mock.Of<MediaBrowser.Controller.LiveTv.IRecordingsManager>();
            // The media-segment store an item's sources consult (a host static on both lines).
            if (_segments != null) _segments.SetValue(null, ((Mock)Activator.CreateInstance(typeof(Mock<>).MakeGenericType(_segments.PropertyType))!).Object);
            // The cache entries, every string member planted.
            Directory.CreateDirectory(Fixture.Core.ConfigRoot);
            var entries = new Dictionary<string, Jellyfin.Plugin.JellyfinEnhanced.Model.TagCacheEntry>
            {
                [Movie.ToString("N")] = new() { Type = "Movie", LastUpdated = 100 },
                [Episode.ToString("N")] = new() { Type = "Episode", SeriesId = Series.ToString("N"), SeasonNumber = 1, EpisodeNumber = 3, LastUpdated = 100 },
            };
            foreach (var (key, entry) in entries) Sentinels.Plant(entry, (key == Movie.ToString("N") ? "movie" : "episode") + "Entry", new HashSet<string> { "Type", "SeriesId" });
            if (extras)
                foreach (var (extraId, name) in new[] { (SeriesExtra, "seriesExtra"), (MovieExtra, "movieExtra") })
                {
                    var entry = new Jellyfin.Plugin.JellyfinEnhanced.Model.TagCacheEntry { Type = "Video", LastUpdated = 100 };
                    Sentinels.Plant(entry, name + "Entry", new HashSet<string> { "Type", "SeriesId" });
                    entries[extraId.ToString("N")] = entry;
                }
            entries[Season.ToString("N")] = new()
            {
                Type = "Season", SeriesId = Series.ToString("N"), SeasonNumber = 1, LastUpdated = 100, Genres = ["Season genre"],
                AudioLanguages = ["eng", Sentinels.Token("seasonEntry.AudioLanguages[] (an episode's)")], PartialAudioLanguages = [Sentinels.Token("seasonEntry.PartialAudioLanguages[] (an episode's)")],
                StreamData = new() { ItemName = Sentinels.Token("seasonEntry.StreamData.ItemName (the first episode's)"), ItemPath = Sentinels.Token("seasonEntry.StreamData.ItemPath"),
                    Streams = [new() { Type = "Audio", Language = Sentinels.Token("seasonEntry.StreamData.Streams[0].Language"), Codec = "aac", DisplayTitle = Sentinels.Token("seasonEntry.StreamData.Streams[0].DisplayTitle") }] },
            };
            edit?.Invoke(entries);
            File.WriteAllText(Path.Combine(Fixture.Core.ConfigRoot, "tag-cache.json"), JsonSerializer.Serialize(new { SchemaVersion = 7, Version = 9, LastModified = 200, Items = entries }));
            var localization = PrivacyTestHost.Localization();
            Cache = new Jellyfin.Plugin.JellyfinEnhanced.Services.TagCacheService(Library.Object, Fixture.Core.Paths.Object, localization, Fixture.Core.Logger);
            Cache.LoadFromDisk();
            var services = new Microsoft.Extensions.DependencyInjection.ServiceCollection();
            Microsoft.Extensions.DependencyInjection.LoggingServiceCollectionExtensions.AddLogging(services);
            Microsoft.Extensions.DependencyInjection.MvcCoreMvcBuilderExtensions.AddJsonOptions(Microsoft.Extensions.DependencyInjection.MvcServiceCollectionExtensions.AddControllers(services), options =>
            {
                options.JsonSerializerOptions.PropertyNamingPolicy = null;
                options.JsonSerializerOptions.DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull;
            });
            _provider = Microsoft.Extensions.DependencyInjection.ServiceCollectionContainerBuilderExtensions.BuildServiceProvider(services);
            var resolver = new Jellyfin.Plugin.JellyfinEnhanced.Services.SpoilerUserResolver(Fixture.Core.Manager, Library.Object, Fixture.Core.Logger, null!);
            var userData = Mock.Of<MediaBrowser.Controller.Library.IUserDataManager>();
            Stripper = PrivacyTestHost.Create<Jellyfin.Plugin.JellyfinEnhanced.Services.SpoilerTagDataStripper>(Library.Object, userData, resolver, localization);
            Controller = ApiAssetTests.Controller(Fixture.Core, users.Object, Cache, Library.Object, userData, Fixture.Core.Manager, resolver, Stripper, localization);
            if (!rules) return;
            var id = Alice.Id.ToString("N");
            Fixture.Core.Manager.SaveUserConfiguration(id, "hidden-content.json", new Jellyfin.Plugin.JellyfinEnhanced.Configuration.UserHiddenContent
            {
                Settings = new() { FilterLibrary = true, FilterSearch = true },
                Items = new() { [Movie.ToString("N")] = new Jellyfin.Plugin.JellyfinEnhanced.Configuration.HiddenContentItem { ItemId = Movie.ToString("D"), Type = "Movie", HideScope = "global" } },
            });
            Jellyfin.Plugin.JellyfinEnhanced.Services.HiddenContentResponseFilter.InvalidateUser(id);
            State.Series[Series.ToString("N")] = new();
            Fixture.Core.Manager.SaveUserConfiguration(id, Jellyfin.Plugin.JellyfinEnhanced.Services.SpoilerBlurImageFilter.SpoilerBlurFileName, State);
            Jellyfin.Plugin.JellyfinEnhanced.Services.SpoilerUserResolver.InvalidateUser(id);
        }

        private void SignIn() => Controller.ControllerContext = new ControllerContext
        {
            HttpContext = new Microsoft.AspNetCore.Http.DefaultHttpContext { RequestServices = _provider, User = TestCallers.Principal(Alice.Id, false) }
        };

        public async Task<string> TagCache()
        {
            SignIn();
            var http = Controller.HttpContext;
            http.Request.Method = "GET";
            using var stream = new MemoryStream();
            http.Response.Body = stream;
            var result = Controller.GetTagCache(Alice.Id);
            await result.ExecuteResultAsync(new ActionContext(http, new Microsoft.AspNetCore.Routing.RouteData(), new Microsoft.AspNetCore.Mvc.Abstractions.ActionDescriptor()));
            return System.Text.Encoding.UTF8.GetString(stream.ToArray());
        }

        public string TagData(params Guid[] ids)
        {
            SignIn();
            var result = Assert.IsType<OkObjectResult>(Controller.GetTagData(Alice.Id, (ids.Length > 0 ? ids : [Movie, Episode]).Select(i => i.ToString()).ToArray()));
            return JsonSerializer.Serialize(result.Value);
        }

        public void Dispose()
        {
            foreach (var id in new[] { Alice.Id.ToString("N") }) { Jellyfin.Plugin.JellyfinEnhanced.Services.SpoilerUserResolver.InvalidateUser(id); Jellyfin.Plugin.JellyfinEnhanced.Services.HiddenContentResponseFilter.InvalidateUser(id); }
            MediaBrowser.Controller.Entities.BaseItem.LibraryManager = _previousLibrary!;
            MediaBrowser.Controller.Entities.BaseItem.MediaSourceManager = _previousMedia!;
            MediaBrowser.Controller.Entities.Video.RecordingsManager = _previousRecordings!;
            _segments?.SetValue(null, _previousSegments);
            Cache.Dispose();
            _provider.Dispose();
            Fixture.Dispose();
        }
    }

    /// <summary>Members Spoiler Guard reveals by configuration when its tag strip is off (genres and tags).</summary>
    private static bool RevealedWithTags(string path) => path.EndsWith(".Genres[]", StringComparison.Ordinal) || path.EndsWith(".Tags[]", StringComparison.Ordinal);

    [Theory]
    [InlineData("tag-cache", true)]
    [InlineData("tag-data", true)]
    [InlineData("tag-cache", false)]
    [InlineData("tag-data", false)]
    public async Task NoSentinelPlantedInAProtectedItemSurvivesJellyfinEnhancedsOwnCardAnswers(string site, bool stripTags)
    {
        using var tags = new TagSite(rules: true, stripTags);
        var body = site == "tag-cache" ? await tags.TagCache() : tags.TagData();
        // The movie is hidden (gone with every value); the episode is guarded (no free-text value but those its switches reveal).
        var leaked = tags.Sentinels.In(body).Where(p => stripTags || !(p.StartsWith("episode", StringComparison.Ordinal) && RevealedWithTags(p))).ToList();
        Assert.True(leaked.Count == 0, site + ": " + leaked.Count + " of " + tags.Sentinels.Planted.Count + " planted members delivered, e.g. " + string.Join(", ", leaked.Take(20)));
        Assert.Contains(tags.Episode.ToString("N"), body.Replace("-", "", StringComparison.Ordinal));
        // The exempt season keeps its series' genre.
        if (site == "tag-cache") Assert.Contains("Season genre", body);
    }

    [Theory]
    [InlineData("tag-cache")]
    [InlineData("tag-data")]
    public async Task JellyfinEnhancedsOwnCardAnswersCarryEveryPlantedValueForAViewerWithoutRules(string site)
    {
        using var tags = new TagSite(rules: false, stripTags: true);
        var body = site == "tag-cache" ? await tags.TagCache() : tags.TagData();
        // Tag data answers what its renderers read (no entry paths, no stream titles); the cache answers its entries.
        var expected = tags.Sentinels.Planted.Where(p => site == "tag-cache" ? p.Value.Contains("Entry", StringComparison.Ordinal) && !p.Value.StartsWith("season", StringComparison.Ordinal)
            : !p.Value.Contains("Entry", StringComparison.Ordinal) && !p.Value.EndsWith(".Title", StringComparison.Ordinal) && !p.Value.EndsWith(".Tags[]", StringComparison.Ordinal)).ToList();
        var missing = expected.Where(p => !body.Contains(p.Key, StringComparison.Ordinal)).Select(p => p.Value).ToList();
        Assert.True(missing.Count == 0, site + " (no rule): missing " + string.Join(", ", missing.Take(20)));
    }
}
