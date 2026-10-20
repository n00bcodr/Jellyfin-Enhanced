using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Jellyfin.Data.Enums;
using User = Jellyfin.Database.Implementations.Entities.User;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Model.Querying;
using MediaBrowser.Model.Search;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.AspNetCore.Routing;
using Moq;

namespace JE.Tests;

/// <summary>
/// The privacy model on the host's REAL answers: every fixture is a response captured from an owned Jellyfin lab (12.2 for
/// the jf12 build, 10.11.11 for jf10; tests/fixtures/host-shapes, made by .notes-side tooling from a lab with no privacy
/// rule), deserialized into the host's own types. Sessions carry another account's NowPlayingItem / NowViewingItem
/// (and 10.11's NowPlayingQueueFullItems), theme songs and videos are Audio/Video extras owned through
/// ThemeMediaResult.OwnerId, local trailers and featurettes are the host's own extras, channels carry CurrentProgram and
/// timers ProgramInfo; a session playing a Live TV channel carries the channel's CurrentProgram inside its NowPlayingItem,
/// over REST and over the dashboard's WebSocket ("Session.WebSocket" shots: the first "Sessions" message, projected by
/// the session listener's projection). Each cell runs Hidden Content's and Spoiler Guard's action filters around the action and then the
/// final gate, with the rule saved before the request or while the action runs. Expectations come from this file's oracle
/// (which names each title's family and which endpoints open an item), never from the production registry. A cell whose
/// subject the captured answer does not contain is not generated.
/// </summary>
[Collection("Plugin singleton")]
public class PrivacyHostShapeModelTests
{
#if NET9_0
    public const string HostName = "10.11.11";
#else
    public const string HostName = "12.2";
#endif

    public sealed record Shot(string File, string Endpoint, string Method, string Path, string Viewer, bool Socket = false);

    internal sealed record Manifest(Dictionary<string, string> Roles, Dictionary<string, string> Owners, List<Shot> Shots);

    private static readonly JsonSerializerOptions Json = Jellyfin.Extensions.Json.JsonDefaults.Options;

    private static readonly Lazy<Manifest> _manifest = new(() =>
    {
        var root = JsonNode.Parse(Resource("manifest.json"))!;
        var roles = root["roles"]!.AsObject().ToDictionary(p => p.Key, p => p.Value!.ToString());
        var owners = root["owners"]!.AsObject().ToDictionary(p => p.Key, p => p.Value!.ToString());
        var shots = root["shots"]!.AsArray().Select(s => s!.AsObject())
            .Where(s => (int)s["status"]! == 200 && Exists(s["file"]!.ToString()))
            .Select(s => new Shot(s["file"]!.ToString(), s["endpoint"]!.ToString(), s["method"]!.ToString(), s["path"]!.ToString(), s["viewer"]!.ToString(),
                s["socket"]?.GetValue<bool>() == true))
            .ToList();
        return new(roles, owners, shots);
    });

    internal static Manifest Data => _manifest.Value;

    private static string Name(string file) => "JE.Tests.HostShapes." + HostName + "." + file;

    private static bool Exists(string file) => typeof(PrivacyHostShapeModelTests).Assembly.GetManifestResourceInfo(Name(file)) != null;

    public static string Resource(string file)
    {
        using var stream = typeof(PrivacyHostShapeModelTests).Assembly.GetManifestResourceStream(Name(file))
            ?? throw new InvalidOperationException("missing captured shape " + file);
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // The oracle.

    /// <summary>Endpoints that answer about the item their route opens: Hidden Content never hides that item from them.</summary>
    private static readonly HashSet<string> Opens =
    [
        "UserLibrary.GetItem", "UserLibrary.GetItemLegacy", "Library.GetAncestors", "Videos.GetAdditionalPart",
        "UserLibrary.GetLocalTrailers", "UserLibrary.GetLocalTrailersLegacy", "UserLibrary.GetSpecialFeatures", "UserLibrary.GetSpecialFeaturesLegacy",
        "Image.GetItemImageInfos", "MediaInfo.GetPlaybackInfo", "MediaInfo.GetPostedPlaybackInfo", "LiveTv.GetChannel", "LiveTv.GetProgram",
        "LiveTv.GetRecording", "LiveTv.GetTimer", "LiveTv.GetSeriesTimer", "LiveTv.GetDefaultTimer", "Library.GetThemeMedia", "Library.GetThemeSongs", "Library.GetThemeVideos",
    ];

    /// <summary>A rule, the role it names, and the text that identifies its subject (Hidden Content) or family secrets (Spoiler Guard).</summary>
    public sealed record Rule(string Id, string Role, string[] Subject, string[] Control);

    public static readonly Rule[] Rules =
    [
        new("hc-movie", "movie:hidden", ["D46 R17 Hidden"], ["D46 R17 Guarded", "D46 R17 Plain", "Secret ending r17 E1"]),
        new("hc-program-now", "program:now", ["D46 R17 Program Now", "Secret plot r17 program now"], ["D46 R17 Channel", "D46 R17 Program Later"]),
        new("hc-program-later", "program:later", ["D46 R17 Program Later", "Secret plot r17 program later"], ["D46 R17 Channel", "D46 R17 Program Now"]),
        new("sg-movie", "movie:guarded", ["Secret plot r17 movie Guarded", "Secret plot r17 theme guarded"], ["Secret plot r17 movie Plain", "Secret plot r17 theme plainSong", "Secret ending r17"]),
        new("sg-series", "series:show", ["Secret plot r17 series", "Secret plot r17 episode", "Secret ending r17", "Secret plot r17 theme show"],
            ["Secret plot r17 movie Plain", "Secret plot r17 theme plainSong", "Secret plot r17 movie Guarded"]),
        // Round 19's captures: a multi-track movie (titled audio and subtitle tracks, a sidecar subtitle named after it) and a
        // series whose episodes have incomplete numbering (no episode number; no numbers at all).
        new("hc-r19-movie", "movie:r19-hidden", ["D46 R19 Hidden"], ["D46 R19 Plain", "Secret ending r19"]),
        new("sg-r19-series", "series:r19-show", ["Secret ending r19", "Secret original r19", "Secret sort r19", "secret sort r0000000019", "Secret plot r19 episode", "Secret tagline r19 E"],
            ["D46 R19 Show", "D46 R19 Hidden"]),
    ];

    public static readonly string[] Moments = ["before", "in-flight"];

    public static IEnumerable<object[]> Cells()
    {
        foreach (var shot in Data.Shots)
        {
            if (shot.Endpoint.StartsWith("User.Authenticate", StringComparison.Ordinal)) continue;
            var raw = Resource(shot.File);
            foreach (var rule in Rules)
            {
                // A cell exists only where the host's own answer carries the rule's subject.
                if (!rule.Subject.Any(s => raw.Contains(s, StringComparison.Ordinal))) continue;
                foreach (var moment in Moments) yield return new object[] { shot.File, rule.Id, moment };
            }
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // The rig: a library of the captured items (kinds and owners from the host), the real filters and the real gate.

    internal sealed class Rig : IDisposable
    {
        public ApiPluginFixture F { get; } = new();
        public Dictionary<Guid, BaseItem> Items { get; } = new();
        public HashSet<(Guid User, Guid Item)> Played { get; } = new();
        public Mock<ILibraryManager> Library { get; } = new();
        public Mock<IUserManager> Users { get; } = new();
        public SpoilerFieldStripFilter Strip { get; }
        public SpoilerPresentation Spoilers { get; }
        public Guid Admin { get; }
        public Guid Viewer { get; }
        private readonly SpoilerNextUnwatchedService _next;
        private readonly ILibraryManager? _previous = BaseItem.LibraryManager;

        public Rig()
        {
            var config = F.Plugin.Configuration;
            config.HiddenContentEnabled = true; config.SpoilerBlurEnabled = true; config.SpoilerReplaceTitle = true; config.SpoilerStripOverview = true;
            config.SpoilerStripSeriesOverview = true; config.SpoilerStripRatings = true; config.SpoilerStripReviews = true;
            Admin = G(Data.Roles["user:admin"]); Viewer = G(Data.Roles["user:viewer"]);
            BuildLibrary();
            Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>()))
                .Returns((InternalItemsQuery q) => (q.ItemIds ?? []).Select(id => Items.GetValueOrDefault(id)).OfType<BaseItem>().ToList());
            Library.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => Items.GetValueOrDefault(id)!);
            BaseItem.LibraryManager = Library.Object;
            foreach (var (id, name) in new[] { (Admin, "real-admin"), (Viewer, "real-viewer") })
                Users.Setup(u => u.GetUserById(id)).Returns(new User(name, "default", "default") { Id = id });
            var data = new Mock<IUserDataManager>();
            data.Setup(d => d.GetUserData(It.IsAny<User>(), It.IsAny<BaseItem>()))
                .Returns((User user, BaseItem item) => new UserItemData { Key = "k", Played = Played.Contains((user.Id, item.Id)) });
            var identities = new RequestIdentityService(Mock.Of<ISessionManager>(), Users.Object, new SpoilerIdentityService(Users.Object, F.Core.Logger), F.Core.Logger);
            var resolver = new SpoilerUserResolver(F.Core.Manager, Library.Object, F.Core.Logger, identities);
            _next = new SpoilerNextUnwatchedService(Library.Object, Users.Object, data.Object, F.Core.Logger);
            Strip = PrivacyTestHost.Create<SpoilerFieldStripFilter>(resolver, Library.Object, Users.Object, data.Object, _next, Localization);
            Spoilers = new SpoilerPresentation(F.Core.Manager, Library.Object, Users.Object, data.Object);
        }

        /// <summary>The host's localization (its closed language, rating and label lists), as the privacy projection asks it.</summary>
        public MediaBrowser.Model.Globalization.ILocalizationManager Localization { get; } = PrivacyTestHost.Localization();

        /// <summary>Every captured library item as the host's own kind, with the host's own owners.</summary>
        private void BuildLibrary()
        {
            var kinds = new Dictionary<Guid, (string Type, JsonObject Dto)>();
            void Walk(JsonNode? node)
            {
                switch (node)
                {
                    case JsonObject o:
                        if (o["Id"]?.GetValueKind() == JsonValueKind.String && o["Type"]?.GetValueKind() == JsonValueKind.String
                            && Guid.TryParse(o["Id"]!.ToString(), out var id) && !kinds.ContainsKey(id)) kinds[id] = (o["Type"]!.ToString(), o);
                        foreach (var pair in o) Walk(pair.Value);
                        break;
                    case JsonArray a:
                        foreach (var child in a) Walk(child);
                        break;
                }
            }
            foreach (var shot in Data.Shots) Walk(JsonNode.Parse(Resource(shot.File)));
            var owners = new Dictionary<Guid, Guid>();
            foreach (var (key, owner) in Data.Owners)
                foreach (var role in Data.Roles.Where(r => r.Key.StartsWith("extra:" + key + ":", StringComparison.Ordinal)))
                    owners[G(role.Value)] = G(owner);
            // Each episode and season belongs to the series (and season) its own captured DTO names.
            var series = G(Data.Roles["series:show"]);
            var season = G(Data.Roles["season:show-s1"]);
            Guid Own(JsonObject dto, string field, Guid fallback) => Guid.TryParse(dto[field]?.ToString(), out var id) && id != Guid.Empty ? id : fallback;
            foreach (var (id, (type, dto)) in kinds)
            {
                BaseItem? item = type switch
                {
                    "Movie" => new MediaBrowser.Controller.Entities.Movies.Movie(),
                    "Series" => new MediaBrowser.Controller.Entities.TV.Series(),
                    "Season" => new MediaBrowser.Controller.Entities.TV.Season { SeriesId = Own(dto, "SeriesId", series) },
                    "Episode" => new MediaBrowser.Controller.Entities.TV.Episode { SeriesId = Own(dto, "SeriesId", series), SeasonId = Own(dto, "SeasonId", season), SeriesName = dto["SeriesName"]?.ToString() },
                    "Audio" => new MediaBrowser.Controller.Entities.Audio.Audio(),
                    "Video" => new Video(),
                    "Trailer" => new Trailer(),
                    "TvChannel" => new MediaBrowser.Controller.LiveTv.LiveTvChannel(),
                    "Program" => new MediaBrowser.Controller.LiveTv.LiveTvProgram(),
                    _ => null
                };
                if (item == null) continue;
                item.Id = id;
                item.Name = dto["Name"]?.ToString();
                item.IndexNumber = dto["IndexNumber"]?.GetValue<int>();
                item.ParentIndexNumber = dto["ParentIndexNumber"]?.GetValue<int>();
                if (owners.TryGetValue(id, out var owner)) item.OwnerId = owner;
                Items[id] = item;
            }
            // A series (or season) the captures name only through its episodes is still the host's own item.
            foreach (var episode in Items.Values.OfType<MediaBrowser.Controller.Entities.TV.Episode>().ToArray())
            {
                if (!Items.ContainsKey(episode.SeriesId))
                    Items[episode.SeriesId] = new MediaBrowser.Controller.Entities.TV.Series { Id = episode.SeriesId, Name = episode.SeriesName };
                if (episode.SeasonId != Guid.Empty && !Items.ContainsKey(episode.SeasonId))
                    Items[episode.SeasonId] = new MediaBrowser.Controller.Entities.TV.Season { Id = episode.SeasonId, SeriesId = episode.SeriesId, IndexNumber = 1 };
            }
        }

        /// <summary>Saves the cell's rule for the requesting viewer.</summary>
        public void Commit(Rule rule, Guid viewer)
        {
            var id = viewer.ToString("N");
            var subject = G(Data.Roles[rule.Role]);
            if (rule.Id.StartsWith("hc-", StringComparison.Ordinal))
            {
                F.Core.Manager.SaveUserConfiguration(id, "hidden-content.json", new UserHiddenContent
                {
                    Settings = new() { FilterSearch = true, FilterLibrary = true, FilterRecommendations = true, FilterNextUp = true, FilterContinueWatching = true, FilterUpcoming = true },
                    Items = new() { [subject.ToString("N")] = new HiddenContentItem { ItemId = subject.ToString("D"), Type = Items[subject] is MediaBrowser.Controller.Entities.Movies.Movie ? "Movie" : "Program", HideScope = "global" } }
                });
                HiddenContentResponseFilter.InvalidateUser(id);
                return;
            }
            var state = new UserSpoilerBlur();
            if (rule.Role.StartsWith("series:", StringComparison.Ordinal)) state.Series[subject.ToString("N")] = new();
            else state.Movies[subject.ToString("N")] = new();
            F.Core.Manager.SaveUserConfiguration(id, "spoilerblur.json", state);
            SpoilerUserResolver.InvalidateUser(id);
        }

        public TitlePresentationResultFilter Gate()
            => PrivacyTestHost.Create<TitlePresentationResultFilter>(F.Core.Manager, Spoilers, Library.Object, Mock.Of<MediaBrowser.Controller.IServerApplicationHost>(), Strip, Localization);

        public void Dispose()
        {
            _next.Dispose();
            foreach (var user in new[] { Admin, Viewer }) SpoilerUserResolver.InvalidateUser(user.ToString("N"));
            BaseItem.LibraryManager = _previous!;
            F.Dispose();
        }
    }

    public static Guid G(string id) => Guid.Parse(id);

    /// <summary>The host's declared answer type of the endpoint (from the host's own endpoint table).</summary>
    public static Type Declared(string endpoint)
    {
        // The dashboard's live session updates carry the same sessions as the REST answer.
        if (endpoint == "Session.WebSocket") return typeof(List<SessionInfoDto>);
        var declared = PrivacySurfaceModelTests.HostEndpoints.FirstOrDefault(e => e.Host == HostName && e.Controller + "." + e.Action == endpoint)?.Declared
            ?? PrivacySurfaceModelTests.TitleEndpoints[endpoint];
        return declared switch
        {
            "BaseItemDto" => typeof(BaseItemDto),
            "IEnumerable<BaseItemDto>" => typeof(List<BaseItemDto>),
            "IReadOnlyList<SessionInfoDto>" => typeof(List<SessionInfoDto>),
            "SearchHintResult" => typeof(SearchHintResult),
            "ThemeMediaResult" => typeof(ThemeMediaResult),
            "AllThemeMediaResult" => typeof(AllThemeMediaResult),
            "IEnumerable<ImageInfo>" => typeof(List<ImageInfo>),
            "PlaybackInfoResponse" => typeof(PlaybackInfoResponse),
            "IEnumerable<RecommendationDto>" => typeof(List<RecommendationDto>),
            "QueryResult<TimerInfoDto>" => typeof(QueryResult<MediaBrowser.Model.LiveTv.TimerInfoDto>),
            "QueryResult<SeriesTimerInfoDto>" => typeof(QueryResult<MediaBrowser.Model.LiveTv.SeriesTimerInfoDto>),
            "SeriesTimerInfoDto" => typeof(MediaBrowser.Model.LiveTv.SeriesTimerInfoDto),
            "QueryResult<ActivityLogEntry>" => typeof(QueryResult<MediaBrowser.Model.Activity.ActivityLogEntry>),
            "TimerInfoDto" => typeof(MediaBrowser.Model.LiveTv.TimerInfoDto),
            "AuthenticationResult" => typeof(MediaBrowser.Controller.Authentication.AuthenticationResult),
            _ => typeof(QueryResult<BaseItemDto>)
        };
    }

    /// <summary>The captured answer as the host's own runtime value.</summary>
    public static object Value(Shot shot)
    {
        var raw = Resource(shot.File);
        var type = Declared(shot.Endpoint);
        if (type == typeof(SearchHintResult))
        {
            var node = JsonNode.Parse(raw)!;
            var hints = node["SearchHints"]!.Deserialize<SearchHint[]>(Json)!;
            return new SearchHintResult(hints, node["TotalRecordCount"]!.GetValue<int>());
        }
        return JsonSerializer.Deserialize(raw, type, Json)!;
    }

    private static readonly Dictionary<string, string> RouteKeys = new(StringComparer.Ordinal)
    {
        ["Items"] = "itemId", ["Channels"] = "channelId", ["Programs"] = "programId", ["Timers"] = "timerId",
        ["Shows"] = "seriesId", ["Videos"] = "itemId", ["Playlists"] = "playlistId", ["Users"] = "userId",
    };

    /// <summary>The route values the captured request bound (ids after their collection segment).</summary>
    public static RouteValueDictionary Route(Shot shot)
    {
        var (controller, action) = (shot.Endpoint.Split('.')[0], shot.Endpoint.Split('.')[1]);
        var values = new RouteValueDictionary { ["controller"] = controller, ["action"] = action };
        foreach (System.Text.RegularExpressions.Match m in Regex.Matches(shot.Path.Split('?')[0], "/(Items|Channels|Programs|Timers|Shows|Videos|Playlists|Users)/([0-9a-fA-F]{32})"))
            values[RouteKeys[m.Groups[1].Value]] = m.Groups[2].Value;
        return values;
    }

    /// <summary>The item the route opens, when the endpoint answers about one.</summary>
    public static Guid? Opened(Shot shot)
    {
        if (!Opens.Contains(shot.Endpoint)) return null;
        // An opened timer (or series timer, or a new timer's defaults) is its programme's own page.
        if (shot.Endpoint is "LiveTv.GetTimer" or "LiveTv.GetSeriesTimer" or "LiveTv.GetDefaultTimer")
            return Value(shot) is MediaBrowser.Model.LiveTv.BaseTimerInfoDto { ProgramId: { } program } && Guid.TryParse(program, out var id) ? id : null;
        var route = Route(shot);
        foreach (var key in new[] { "itemId", "channelId", "programId", "timerId" })
            if (route.TryGetValue(key, out var id) && Guid.TryParse(id?.ToString(), out var guid)) return guid;
        return null;
    }

    public static ActionContext Context(Shot shot, Guid viewer)
    {
        var http = new DefaultHttpContext { User = TestCallers.Principal(viewer, viewer == G(Data.Roles["user:admin"])) };
        http.Request.Method = shot.Method;
        var parts = shot.Path.Split('?', 2);
        http.Request.Path = parts[0];
        if (parts.Length > 1) http.Request.QueryString = new QueryString("?" + parts[1]);
        var values = Route(shot);
        http.Request.RouteValues = values;
        var (controller, action) = (shot.Endpoint.Split('.')[0], shot.Endpoint.Split('.')[1]);
        var descriptor = new ControllerActionDescriptor
        {
            ControllerName = controller, ActionName = action, DisplayName = shot.Endpoint,
            // A host controller (not this plugin's): the gate tells JE endpoints apart by their controller's assembly.
            ControllerTypeInfo = typeof(MediaBrowser.Controller.Library.ILibraryManager).Assembly.GetTypes().First(t => t.IsClass).GetTypeInfo(),
            RouteValues = new Dictionary<string, string?> { ["controller"] = controller, ["action"] = action }
        };
        return new ActionContext(http, new RouteData(values), descriptor, new ModelStateDictionary());
    }

    /// <summary>Hidden Content's and Spoiler Guard's action filters around the action, then the final gate; the delivered JSON.</summary>
    internal static async Task<(IActionResult Result, string Body)> Deliver(Rig rig, Shot shot, Action? inFlight = null, object? answer = null)
    {
        var viewer = shot.Viewer == "viewer" ? rig.Viewer : rig.Admin;
        if (shot.Socket)
        {
            // The session listener builds the update, then projects it for the connection's viewer (a rule saved in between applies).
            var update = (List<SessionInfoDto>)(answer ?? Value(shot));
            inFlight?.Invoke();
            var sent = rig.Gate().ProjectSessions(update, viewer);
            await Task.CompletedTask;
            return (new ObjectResult(sent), JsonSerializer.Serialize(sent, typeof(IReadOnlyList<SessionInfoDto>), Json));
        }
        var context = Context(shot, viewer);
        var result = new ObjectResult(answer ?? Value(shot));
        var filters = new List<IFilterMetadata>();
        Task<ActionExecutedContext> Action()
        {
            inFlight?.Invoke();
            return Task.FromResult(new ActionExecutedContext(context, filters, new object()) { Result = result });
        }
        var strip = new ActionExecutingContext(context, filters, new Dictionary<string, object?>(), new object());
        ActionExecutionDelegate inner = async () => { ActionExecutedContext? done = null; await rig.Strip.OnActionExecutionAsync(strip, async () => done = await Action()); return done!; };
        await new HiddenContentResponseFilter(rig.F.Core.Manager, rig.F.Core.Logger, rig.Library.Object)
            .OnActionExecutionAsync(new ActionExecutingContext(context, filters, new Dictionary<string, object?>(), new object()), inner);
        var delivery = new ResultExecutingContext(context, filters, result, new object());
        rig.Gate().OnResultExecuting(delivery);
        var value = (delivery.Result as ObjectResult)?.Value;
        return (delivery.Result, value == null ? "" : JsonSerializer.Serialize(value, value.GetType(), Json));
    }

    [Theory]
    [MemberData(nameof(Cells))]
    public async Task EveryCapturedAnswerAppliesTheRequestingViewersRules(string file, string ruleId, string moment)
    {
        using var rig = new Rig();
        var shot = Data.Shots.Single(s => s.File == file);
        var rule = Rules.Single(r => r.Id == ruleId);
        var viewer = shot.Viewer == "viewer" ? rig.Viewer : rig.Admin;
        var original = JsonSerializer.Serialize(Value(shot), Declared(shot.Endpoint), Json);
        if (moment == "before") rig.Commit(rule, viewer);
        var (result, delivered) = await Deliver(rig, shot, moment == "in-flight" ? () => rig.Commit(rule, viewer) : null);
        Assert.IsAssignableFrom<ObjectResult>(result);
        var subject = G(Data.Roles[rule.Role]);
        if (rule.Id.StartsWith("hc-", StringComparison.Ordinal) && Opened(shot) == subject)
        {
            // Hidden Content never hides an item from its own page.
            foreach (var text in rule.Subject.Where(s => original.Contains(s, StringComparison.Ordinal))) Assert.Contains(text, delivered);
        }
        else
        {
            foreach (var text in rule.Subject) Assert.DoesNotContain(text, delivered);
        }
        // Everything else the host answered stays.
        foreach (var text in rule.Control.Where(s => original.Contains(s, StringComparison.Ordinal))) Assert.Contains(text, delivered);
        if (Declared(shot.Endpoint) == typeof(List<SessionInfoDto>))
        {
            // Sessions are never removed, and their controls stay: the projection only touches the title members.
            var before = JsonNode.Parse(original)!.AsArray();
            var after = JsonNode.Parse(delivered)!.AsArray();
            Assert.Equal(before.Select(s => s!["Id"]!.ToString()), after.Select(s => s!["Id"]!.ToString()));
            for (var i = 0; i < before.Count; i++)
            {
                foreach (var control in new[] { "PlayState", "SupportsRemoteControl", "SupportsMediaControl", "Capabilities", "UserId", "DeviceId" })
                    Assert.Equal(before[i]![control]?.ToJsonString(), after[i]![control]?.ToJsonString());
                // A session that is playing keeps a now-playing item (the dashboard's controls hang on it).
                Assert.Equal(before[i]!["NowPlayingItem"]?["Id"]?.ToString(), after[i]!["NowPlayingItem"]?["Id"]?.ToString());
            }
        }
    }

    [Fact]
    public void TheModelCoversEveryCapturedFamily()
    {
        var cells = Cells().Select(c => ((string)c[0], (string)c[1], (string)c[2])).ToArray();
        Assert.Equal(cells.Length, cells.Distinct().Count());
        // The families whose real shape decided the round-16 findings, plus Live TV's nested members.
        foreach (var file in new[] { "Session.GetSessions.admin.json", "Session.WebSocket.admin.json", "Session.WebSocket.viewer.json", "Library.GetThemeSongs.movie.json", "Library.GetThemeSongs.series.json",
            "Library.GetThemeVideos.movie.json", "Library.GetThemeMedia.movie.json", "Library.GetThemeMedia.series.json", "Library.GetThemeSongs.episode-inherited.json",
            "UserLibrary.GetSpecialFeatures.series.json", "UserLibrary.GetSpecialFeatures.movie.json", "UserLibrary.GetLocalTrailers.movie.json",
            "LiveTv.GetLiveTvChannels.json", "LiveTv.GetChannel.json", "UserLibrary.GetItem.channel.json", "LiveTv.GetTimers.json", "LiveTv.GetSeriesTimers.json", "ActivityLog.GetLogEntries.json",
            "Items.GetItems.json", "TvShows.GetEpisodes.json", "Search.GetSearchHints.json" })
            Assert.Contains(cells, c => c.Item1 == file);
        foreach (var rule in Rules) foreach (var moment in Moments) Assert.Contains(cells, c => c.Item2 == rule.Id && c.Item3 == moment);
        // Real shapes, not invented ones: theme extras are Audio/Video owned by the envelope, sessions carry another account's item.
        var theme = Assert.IsType<ThemeMediaResult>(Value(Data.Shots.Single(s => s.File == "Library.GetThemeSongs.movie.json")));
        Assert.Equal(G(Data.Roles["movie:guarded"]), theme.OwnerId);
        Assert.All(theme.Items, i => { Assert.Equal(BaseItemKind.Audio, i.Type); Assert.Null(i.SeriesId); });
        var sessions = Assert.IsType<List<SessionInfoDto>>(Value(Data.Shots.Single(s => s.File == "Session.GetSessions.admin.json")));
        Assert.Contains(sessions, s => s.UserId == G(Data.Roles["user:viewer"]) && s.NowPlayingItem?.Id == G(Data.Roles["movie:hidden"]));
        Assert.Contains(sessions, s => s.NowPlayingItem?.Id == G(Data.Roles["episode:show-e1"]));
        // A session playing a Live TV channel: the programme airing now is nested in the now-playing channel (REST and WebSocket).
        foreach (var file in new[] { "Session.GetSessions.admin.json", "Session.WebSocket.admin.json", "Session.WebSocket.viewer.json" })
        {
            var live = Assert.IsType<List<SessionInfoDto>>(Value(Data.Shots.Single(s => s.File == file)));
            Assert.Contains(live, s => s.NowPlayingItem?.Id == G(Data.Roles["channel:r17"]) && s.NowPlayingItem.CurrentProgram?.Id == G(Data.Roles["program:now"]));
        }
    }
}
