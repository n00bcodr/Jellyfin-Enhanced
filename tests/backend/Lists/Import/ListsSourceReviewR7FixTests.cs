using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json.Nodes;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources;
using MediaBrowser.Common.Configuration;
using Moq;
using Xunit.Abstractions;
using static JE.Tests.ListsImportReviewR2FixTests;
using static JE.Tests.ListsSourceReviewR3FixTests;
using World = JE.Tests.ListsSourceReviewR6FixTests.World;

namespace JE.Tests;

// Track 4c2a review round 7 (D53, 7th round: the SHAPE, not the next field).
// 1. One response contract per resource kind: every provider answer is Valid (definitive, kept), Partial (used, never kept,
//    never proof of an absence) or Malformed (transient: the next server is asked). 4c2-R7-1: details without external ids
//    completed an identity as if the ids were proven absent; 4c2-R7-2: TV details without a season list were kept and made
//    a real season "missing"; 4c2-R7-3: a Seerr server's `{}` was placeholder metadata (kept, the next server never asked).
// 2. Owned lifetimes: an MDBList account lives while anything references it (4c2-R7-4: an account waiting for its first
//    balance was evicted, so one key had two accounts); a limiter lease belongs to the upstream request it admitted
//    (4c2-R7-5: a cancelled caller released its lease while TMDB was still answering it).
// 3. No upstream body, URL or credential in any log line (4c2-R7-6: MDBList error bodies echoing the key were logged).
[Collection("Plugin singleton")]
public class ListsSourceReviewR7FixTests(ITestOutputHelper output)
{
    private static readonly CancellationToken None = CancellationToken.None;
    private static readonly DateTime Today = new(2025, 9, 1, 0, 0, 0, DateTimeKind.Utc);

    internal const string Tmdb = "api.themoviedb.org/3/";
    internal const string SeerrA = "seerr-a.test/api/v1/";
    internal const string SeerrB = "seerr-b.test/api/v1/";

    // ── 1. The generated contract model: resource kind × field × {missing, null, wrong type, empty} ──

    // Valid answers in TMDB's names; Seerr's are the same in camelCase (Camel).
    internal const string MovieBody = "{\"id\":49521,\"title\":\"Man of Steel\",\"original_title\":\"Man of Steel\",\"release_date\":\"2013-06-12\",\"poster_path\":\"/p.jpg\",\"overview\":\"Krypton.\",\"popularity\":10.5,\"vote_count\":100,\"adult\":false,\"status\":\"Released\",\"imdb_id\":\"tt0770828\",\"external_ids\":{\"imdb_id\":\"tt0770828\"}}";
    internal const string ShowBody = "{\"id\":1412,\"name\":\"Arrow\",\"original_name\":\"Arrow\",\"first_air_date\":\"2012-10-10\",\"poster_path\":\"/a.jpg\",\"overview\":\"Oliver.\",\"popularity\":20.5,\"vote_count\":5000,\"status\":\"Ended\",\"in_production\":false,\"external_ids\":{\"imdb_id\":\"tt2193021\",\"tvdb_id\":257655},\"seasons\":[{\"season_number\":1,\"episode_count\":23,\"air_date\":\"2012-10-10\",\"name\":\"Season 1\"},{\"season_number\":2,\"episode_count\":23,\"air_date\":\"2013-10-09\",\"name\":\"Season 2\"}]}";
    internal const string SeasonBody = "{\"id\":3,\"season_number\":1,\"air_date\":\"2012-10-10\",\"episodes\":[{\"episode_number\":1,\"season_number\":1,\"show_id\":1412,\"name\":\"Pilot\",\"air_date\":\"2012-10-10\"},{\"episode_number\":2,\"season_number\":1,\"show_id\":1412,\"name\":\"Honor Thy Father\",\"air_date\":\"2012-10-17\"}]}";
    private const string EpisodeFindBody = "{\"movie_results\":[],\"tv_results\":[],\"tv_episode_results\":[{\"show_id\":1412,\"season_number\":1,\"episode_number\":2,\"name\":\"Honor Thy Father\",\"air_date\":\"2012-10-17\"}]}";
    internal const string MultiBody = "{\"page\":1,\"results\":[{\"media_type\":\"movie\",\"id\":49521,\"title\":\"Man of Steel\",\"original_title\":\"Man of Steel\",\"release_date\":\"2013-06-12\",\"poster_path\":\"/p.jpg\",\"overview\":\"Krypton.\",\"popularity\":10.5,\"vote_count\":100,\"adult\":false},{\"media_type\":\"tv\",\"id\":1412,\"name\":\"Arrow\",\"first_air_date\":\"2012-10-10\"}],\"total_results\":2}";
    private const string FindBody = "{\"movie_results\":[{\"id\":49521,\"title\":\"Man of Steel\",\"release_date\":\"2013-06-12\",\"adult\":false}],\"tv_results\":[{\"id\":1412,\"name\":\"Arrow\"}],\"tv_episode_results\":[]}";

    // Placeholder metadata (Seerr's names; JE mode reads TMDB's, Snake).
    internal const string MetaMovieBody = "{\"id\":10,\"title\":\"Inception\",\"releaseDate\":\"2010-07-16\",\"posterPath\":\"/i.jpg\",\"overview\":\"Dreams.\",\"imdbId\":\"tt1375666\",\"externalIds\":{\"imdbId\":\"tt1375666\"}}";
    internal const string MetaShowBody = "{\"id\":1412,\"name\":\"Arrow\",\"firstAirDate\":\"2012-10-10\",\"posterPath\":\"/a.jpg\",\"overview\":\"Oliver.\",\"status\":\"Returning Series\",\"inProduction\":true,\"externalIds\":{\"imdbId\":\"tt2193021\",\"tvdbId\":257655},\"seasons\":[{\"seasonNumber\":1,\"episodeCount\":3,\"airDate\":\"2012-10-10\"}],\"lastEpisodeToAir\":{\"seasonNumber\":1,\"episodeNumber\":3,\"airDate\":\"2012-10-24\"}}";
    internal const string MetaSeasonBody = "{\"id\":3,\"seasonNumber\":1,\"airDate\":\"2012-10-10\",\"posterPath\":\"/s1.jpg\",\"episodes\":[{\"episodeNumber\":1,\"seasonNumber\":1,\"showId\":1412,\"name\":\"Pilot\",\"airDate\":\"2012-10-10\"},{\"episodeNumber\":2,\"seasonNumber\":1,\"showId\":1412,\"name\":\"Honor\",\"airDate\":\"2012-10-17\"},{\"episodeNumber\":3,\"seasonNumber\":1,\"showId\":1412,\"name\":\"Lone Gunmen\",\"airDate\":\"2012-10-24\"}]}";

    // THE ORACLE: each kind's declared contract restated per field as the verdict of (missing, null, wrong type, empty):
    // V valid (definitive: used and kept), P partial (used, never kept, never proof of an absence), M malformed (transient,
    // the next server asked), U valid but never kept by policy (Seerr's empty search, Q-4C2AFIX5-1), '-' not applicable.
    // Roles behind the letters: a required field MMMM; an identity id PVMV (missing = unknown, null or "" = proven absent;
    // a movie's IMDb id has two sources, so one missing is VVMV); a meaningful fact (a season list, a release date) PVMV or
    // PMMV; a display field VVPV; a row JE can't read makes a search Partial (other titles are used) and a season or season
    // list Malformed.
    private static readonly (string Path, string Verdicts)[] MovieFields =
    {
        ("id", "MMMM"), ("title", "MMMM"), ("original_title", "VVPV"), ("release_date", "VVPV"), ("poster_path", "VVPV"),
        ("overview", "VVPV"), ("popularity", "VVPV"), ("vote_count", "VVPV"), ("adult", "VVP-"), ("status", "VVPV"),
        ("imdb_id", "VVMV"), ("external_ids", "VMMV"), ("external_ids.imdb_id", "VVMV"),
    };

    private static readonly (string Path, string Verdicts)[] ShowFields =
    {
        ("id", "MMMM"), ("name", "MMMM"), ("original_name", "VVPV"), ("first_air_date", "VVPV"), ("poster_path", "VVPV"),
        ("overview", "VVPV"), ("popularity", "VVPV"), ("vote_count", "VVPV"), ("status", "VVPV"), ("in_production", "VVP-"),
        ("external_ids", "PMMP"), ("external_ids.imdb_id", "PVMV"), ("external_ids.tvdb_id", "PVMV"),
        ("seasons", "PMMV"), ("seasons[0].season_number", "MMMV"), ("seasons[0].episode_count", "VVPV"),
        ("seasons[0].air_date", "VVPV"), ("seasons[0].name", "VVPV"),
    };

    private static readonly (string Path, string Verdicts)[] SeasonFields =
    {
        ("episodes", "MMMV"), ("episodes[0].episode_number", "MMMV"), ("episodes[0].season_number", "VVMM"), // r9: season 0 isn't the season asked for; r10: nor is a value that isn't one
        ("episodes[0].name", "VVPV"), ("episodes[0].air_date", "VVPV"),
    };

    private static readonly (string Path, string Verdicts)[] EpisodeFindFields =
    {
        ("tv_episode_results", "MMMV"), ("tv_episode_results[0].show_id", "MMMM"), ("tv_episode_results[0].season_number", "MMMV"),
        ("tv_episode_results[0].episode_number", "MMMV"), ("tv_episode_results[0].name", "VVPV"), ("tv_episode_results[0].air_date", "VVPV"),
    };

    private static readonly (string Path, string Verdicts)[] MultiFields =
    {
        ("results", "MMMM"), ("results[0].media_type", "PPPP"), ("results[0].id", "PPPP"), ("results[0].title", "PPPP"), // r10: an empty page whose total says 2 is no "no titles"
        ("results[0].original_title", "VVPV"), ("results[0].release_date", "VVPV"), ("results[0].poster_path", "VVPV"),
        ("results[0].overview", "VVPV"), ("results[0].popularity", "VVPV"), ("results[0].vote_count", "VVPV"), ("results[0].adult", "VVP-"),
    };

    private static readonly (string Path, string Verdicts)[] FindFields =
    {
        ("movie_results", "MMMV"), ("tv_results", "MMMV"), ("movie_results[0].id", "PPPP"), ("movie_results[0].title", "PPPP"),
        ("movie_results[0].release_date", "VVPV"), ("movie_results[0].adult", "VVP-"),
    };

    private static readonly (string Path, string Verdicts)[] MetaMovieFields =
    {
        ("id", "MMMM"), ("title", "VVPV"), ("releaseDate", "PVMV"), ("posterPath", "PVMV"), ("overview", "VVPV"),
        ("imdbId", "VVMV"), ("externalIds", "VMMV"), ("externalIds.imdbId", "VVMV"),
    };

    private static readonly (string Path, string Verdicts)[] MetaShowFields =
    {
        ("id", "MMMM"), ("name", "VVPV"), ("firstAirDate", "PVMV"), ("posterPath", "PVMV"), ("overview", "VVPV"),
        ("status", "PVMV"), ("inProduction", "VVP-"), ("externalIds", "PMMP"), ("externalIds.imdbId", "PVMV"),
        ("externalIds.tvdbId", "PVMV"), ("seasons", "PMMV"), ("seasons[0].seasonNumber", "MMMV"),
        ("seasons[0].episodeCount", "PMMV"), ("seasons[0].airDate", "PVMV"), ("lastEpisodeToAir", "VVMM"),
        ("lastEpisodeToAir.seasonNumber", "MMMV"), ("lastEpisodeToAir.episodeNumber", "MMMV"), ("lastEpisodeToAir.airDate", "PVMV"),
    };

    // A season answer that isn't Valid is used like a failed season read: it never sets the expected episodes.
    private static readonly (string Path, string Verdicts)[] MetaSeasonFields =
    {
        ("episodes", "MMMI"), ("episodes[0].episodeNumber", "MMMI"), ("episodes[0].seasonNumber", "VVMM"), // r9: season 0 isn't the season asked for; r10: nor is a value that isn't one
        ("episodes[0].name", "VVPV"), ("episodes[0].airDate", "PIMI"), ("airDate", "PVMV"), ("posterPath", "PVMV"),
    };

    private static readonly (string Path, string Verdicts)[] PosterFields = { ("poster_path", "MVMV") };

    internal sealed record Kind(string Name, string Body, (string Path, string Verdicts)[] Fields, Func<World, string, Task<Seen>> Read);

    // What a production entry point made of one answer: whether it used it, whether it kept it (a second read sent
    // nothing), and (metadata) whether applying it cleared a value the entry already had.
    internal sealed record Seen(bool Used, LookupStatus? Status, bool Kept, bool Cleared = false);

    internal static readonly Kind[] Kinds =
    {
        new("tmdb details movie", MovieBody, MovieFields, (w, b) => LookupAsync(w, Tmdb + "movie/49521", b, () => StatusOf(w.TmdbLookup.GetDetailsAsync("movie", 49521, w.Context, None)))),
        new("tmdb details tv", ShowBody, ShowFields, (w, b) => LookupAsync(w, Tmdb + "tv/1412", b, () => StatusOf(w.TmdbLookup.GetDetailsAsync("tv", 1412, w.Context, None)))),
        new("tmdb season", SeasonBody, SeasonFields, (w, b) => LookupAsync(w, Tmdb + "tv/1412/season/1", b, () => StatusOf(w.TmdbLookup.GetSeasonAsync(1412, 1, w.Context, None)))),
        new("tmdb episode find", EpisodeFindBody, EpisodeFindFields, (w, b) => LookupAsync(w, Tmdb + "find/tt2338304", b, () => StatusOf(w.TmdbLookup.FindImdbEpisodeAsync("tt2338304", w.Context, None)))),
        new("tmdb multi search", MultiBody, MultiFields, (w, b) => LookupAsync(w, Tmdb + "search/multi", b, () => StatusOf(w.TmdbLookup.SearchAsync("Man of Steel", w.Context, None)))),
        new("tmdb find", FindBody, FindFields, (w, b) => LookupAsync(w, Tmdb + "find/tt0770828", b, () => StatusOf(w.TmdbLookup.SearchAsync("imdb:tt0770828", w.Context, None)))),
        new("seerr details movie", Camel(MovieBody), Camel(MovieFields), (w, b) => LookupAsync(w, SeerrA + "movie/49521", b, () => StatusOf(w.SeerrLookup.GetDetailsAsync("movie", 49521, w.Context, None)))),
        new("seerr details tv", Camel(ShowBody), Camel(ShowFields), (w, b) => LookupAsync(w, SeerrA + "tv/1412", b, () => StatusOf(w.SeerrLookup.GetDetailsAsync("tv", 1412, w.Context, None)))),
        new("seerr season", Camel(SeasonBody), Camel(SeasonFields), (w, b) => LookupAsync(w, SeerrA + "tv/1412/season/1", b, () => StatusOf(w.SeerrLookup.GetSeasonAsync(1412, 1, w.Context, None)))),
        new("seerr search", Camel(MultiBody), Camel(MultiFields), (w, b) => LookupAsync(w, SeerrA + "search", b, () => StatusOf(w.SeerrLookup.SearchAsync("Man of Steel", w.Context, None)))),
        new("seerr metadata movie", MetaMovieBody, MetaMovieFields, (w, b) => SeerrMetadataAsync(w, "movie/10", b, Prefilled(PlaceholderKinds.Movie))),
        new("seerr metadata series", MetaShowBody, MetaShowFields, (w, b) => SeerrMetadataAsync(w, "tv/1412", b, Prefilled(PlaceholderKinds.Series))),
        new("seerr metadata season", MetaSeasonBody, MetaSeasonFields, (w, b) => SeerrMetadataAsync(w, "tv/1412/season/1", b, Prefilled(PlaceholderKinds.Season))),
        new("tmdb metadata movie", Snake(MetaMovieBody), Snake(MetaMovieFields), (w, b) => TmdbMetadataAsync(w, "movie/10", b, Prefilled(PlaceholderKinds.Movie))),
        new("tmdb metadata series", Snake(MetaShowBody), Snake(MetaShowFields), (w, b) => TmdbMetadataAsync(w, "tv/1412", b, Prefilled(PlaceholderKinds.Series))),
        new("tmdb metadata season", Snake(MetaSeasonBody), Snake(MetaSeasonFields), (w, b) => TmdbMetadataAsync(w, "tv/1412/season/1", b, Prefilled(PlaceholderKinds.Season))),
        new("tmdb poster", "{\"id\":10,\"poster_path\":\"/p.jpg\"}", PosterFields, PosterAsync),
    };

    private static readonly string[] Mutations = { "missing", "null", "wrong type", "empty" };

    public static IEnumerable<object[]> ContractCells() =>
        from kind in Kinds
        from field in kind.Fields
        from m in Enumerable.Range(0, 4)
        where field.Verdicts[m] != '-'
        select new object[] { kind.Name, field.Path, Mutations[m] };

    public static IEnumerable<object[]> ValidControls() => Kinds.Select(k => new object[] { k.Name });

    [Theory]
    [MemberData(nameof(ValidControls))]
    public async Task EveryKindsValidAnswerIsDefinitive(string kindName)
    {
        var kind = Kinds.Single(k => k.Name == kindName);
        using var w = new World();
        var seen = await kind.Read(w, kind.Body);
        output.WriteLine(kindName + ": " + seen);
        Assert.True(seen.Used && seen.Kept, kindName + ": a valid answer is used and kept (" + seen + ")");
    }

    [Theory]
    [MemberData(nameof(ContractCells))]
    public async Task EveryAnswerIsValidPartialOrMalformedByItsKindsContract(string kindName, string path, string mutation)
    {
        var kind = Kinds.Single(k => k.Name == kindName);
        var expected = kind.Fields.Single(f => f.Path == path).Verdicts[Array.IndexOf(Mutations, mutation)];
        using var w = new World();
        var body = Mutate(kind.Body, path, mutation);
        var seen = await kind.Read(w, body);
        output.WriteLine(kindName + " | " + path + " " + mutation + " → expected " + expected + ", saw " + seen + "\n" + body);

        var season = kindName.EndsWith("metadata season", StringComparison.Ordinal);
        switch (expected)
        {
            case 'V':
                Assert.True(seen.Used && seen.Kept, "valid: used and kept");
                break;
            case 'I': // individually valid resource, but the composed season is incomplete (count/coordinates/dates)
                Assert.False(seen.Used);
                Assert.True(seen.Kept); // raw resources remain reusable; their composition cannot confirm completion
                Assert.False(seen.Cleared);
                break;
            case 'P' when !season:
                Assert.True(seen.Used, "partial: still used");
                Assert.False(seen.Kept, "partial: never kept");
                Assert.False(seen.Cleared, "partial: never clears a value the entry has");
                break;
            case 'U':
                Assert.True(seen.Used && !seen.Kept, "valid but never kept by policy");
                break;
            default: // M (and a season's P: used like a failed season read)
                Assert.False(seen.Used, "malformed: not used");
                Assert.False(seen.Kept, "malformed: never kept");
                Assert.False(seen.Cleared, "malformed: never clears a value the entry has");
                break;
        }
    }

    private static async Task<LookupStatus> StatusOf<T>(Task<LookupResult<T>> read) => (await read).Status;

    // The Seerr lookups ask server A (the answer under test); B fails, so whatever is used is A's.
    private static async Task<Seen> LookupAsync(World w, string at, string body, Func<Task<LookupStatus>> read)
    {
        w.Answer(at, body);
        if (at.StartsWith(SeerrA, StringComparison.Ordinal))
        {
            w.Answer(SeerrB + at[SeerrA.Length..], "{\"message\":\"down\"}", 503);
        }

        var first = await read();
        var calls = w.Total;
        await read();
        return new Seen(first != LookupStatus.Transient, first, w.Total == calls);
    }

    internal static Placeholder Prefilled(string kind)
    {
        var movie = kind == PlaceholderKinds.Movie;
        var placeholder = new Placeholder
        {
            Id = Guid.NewGuid().ToString("N"),
            Kind = kind,
            MediaType = movie ? "movie" : "tv",
            TmdbId = movie ? 10 : 1412,
            Title = movie ? "Inception" : "Arrow",
            SeasonNumber = kind == PlaceholderKinds.Season ? 1 : null,
            ReleaseDate = "2001-01-01",
            PosterPath = "/old.jpg",
        };
        if (!movie)
        {
            placeholder.Expected = Enumerable.Range(1, 3).Select(e => new PlaceholderEpisode { S = 1, E = e, AirDate = "2012-10-1" + e }).ToList();
            placeholder.EpisodeTotal = 3;
            placeholder.InProduction = true;
        }

        return placeholder;
    }

    // Applying the metadata to a copy of the entry cleared a value it had.
    private static bool Clears(Placeholder entry, PlaceholderMetadata metadata)
    {
        var copy = Prefilled(entry.Kind);
        ListMetadataService.Apply(copy, metadata);
        return copy.ReleaseDate == null || copy.PosterPath == null
            || (copy.MediaType == "tv" && (copy.Expected == null || copy.Expected.Count == 0 || copy.InProduction == false || copy.EpisodeTotal == null));
    }

    // Seerr placeholder metadata: the resource under test from server A (B fails); the show's details are valid.
    private static async Task<Seen> SeerrMetadataAsync(World w, string path, string body, Placeholder entry)
    {
        w.Answer(SeerrA + path, body);
        w.Answer(SeerrB + path, "{\"message\":\"down\"}", 503);
        if (path != "tv/1412" && entry.MediaType == "tv")
        {
            w.Answer(SeerrA + "tv/1412", MetaShowBody);
        }

        var metadata = new ListMetadataService(w.Transport, w.Plugin.Core.Logger);
        return await MetadataAsync(w, entry, path.Contains("/season/", StringComparison.Ordinal), () => metadata.FetchAsync(entry, TimeSpan.FromHours(12), Today, None));
    }

    // JE mode: the same resources from TMDB with JE's key (TMDB's names).
    private static async Task<Seen> TmdbMetadataAsync(World w, string path, string body, Placeholder entry)
    {
        ImportTestFlags.AllOn(w.Plugin.Plugin.Configuration);
        w.Plugin.Plugin.Configuration.ArrPhase4ListJeMetadataEnabled = true;
        w.Answer(Tmdb + path, body);
        if (path != "tv/1412" && entry.MediaType == "tv")
        {
            w.Answer(Tmdb + "tv/1412", Snake(MetaShowBody));
        }

        var source = new TmdbListMetadataSource(w.Cache, w.Plugin.Core.Logger);
        return await MetadataAsync(w, entry, path.Contains("/season/", StringComparison.Ordinal), () => source.FetchAsync(entry, TimeSpan.FromHours(12), Today, None));
    }

    private static async Task<Seen> MetadataAsync(World w, Placeholder entry, bool season, Func<Task<PlaceholderMetadata?>> fetch)
    {
        var first = await fetch();
        var calls = w.Total;
        await fetch();
        var used = first != null && (!season || !first.Partial);
        return new Seen(used, null, w.Total == calls, first != null && Clears(entry, first));
    }

    private static async Task<Seen> PosterAsync(World w, string body)
    {
        w.Answer(Tmdb + "movie/10", body);
        var metadata = new ListMetadataService(w.Transport, w.Plugin.Core.Logger);
        var first = await metadata.ReadTmdbPosterAsync(ListsHarness.Movie(10), None);
        var calls = w.Total;
        await metadata.ReadTmdbPosterAsync(ListsHarness.Movie(10), None);
        return new Seen(first.Answered, null, w.Total == calls);
    }

    // ── JSON helpers of the model ──

    internal static string Mutate(string body, string path, string mutation)
    {
        var root = JsonNode.Parse(body)!;
        var segments = path.Split('.');
        JsonNode node = root;
        foreach (var segment in segments[..^1])
        {
            node = Step(node, segment)!;
        }

        var last = segments[^1]; // paths end in a field name (a row's field: "seasons[0].season_number")
        var parent = (JsonObject)node;
        var value = parent[last];
        switch (mutation)
        {
            case "missing":
                parent.Remove(last);
                break;
            case "null":
                parent[last] = null;
                break;
            case "wrong type":
                parent[last] = value switch
                {
                    JsonArray => new JsonObject(),
                    JsonObject => JsonValue.Create("x"),
                    _ when value!.GetValueKind() == System.Text.Json.JsonValueKind.String => JsonValue.Create(5),
                    _ => JsonValue.Create("x"),
                };
                break;
            default:
                parent[last] = value switch
                {
                    JsonArray => new JsonArray(),
                    JsonObject => new JsonObject(),
                    _ when value!.GetValueKind() == System.Text.Json.JsonValueKind.String => JsonValue.Create(string.Empty),
                    _ => JsonValue.Create(0),
                };
                break;
        }

        return root.ToJsonString();
    }

    internal static JsonNode? Step(JsonNode node, string segment)
    {
        var open = segment.IndexOf('[', StringComparison.Ordinal);
        if (open < 0)
        {
            return node[segment];
        }

        var list = node[segment[..open]]!;
        return list[int.Parse(segment[(open + 1)..^1], CultureInfo.InvariantCulture)];
    }

    private static string CamelName(string name)
    {
        var parts = name.Split('_');
        return parts[0] + string.Concat(parts.Skip(1).Select(p => p.Length == 0 ? p : char.ToUpperInvariant(p[0]) + p[1..]));
    }

    private static string SnakeName(string name) => string.Concat(name.Select(c => char.IsUpper(c) ? "_" + char.ToLowerInvariant(c) : c.ToString()));

    private static string Rename(string body, Func<string, string> rename)
    {
        static JsonNode? Walk(JsonNode? node, Func<string, string> rename) => node switch
        {
            JsonObject o => new JsonObject(o.Select(p => KeyValuePair.Create(rename(p.Key), Walk(p.Value, rename)))),
            JsonArray a => new JsonArray(a.Select(i => Walk(i, rename)).ToArray()),
            null => null,
            _ => node.DeepClone(),
        };

        return Walk(JsonNode.Parse(body), rename)!.ToJsonString();
    }

    private static string RenamePath(string path, Func<string, string> rename) =>
        string.Join('.', path.Split('.').Select(s => s.IndexOf('[', StringComparison.Ordinal) is var i and >= 0 ? rename(s[..i]) + s[i..] : rename(s)));

    internal static string Camel(string body) => Rename(body, CamelName);

    private static (string Path, string Verdicts)[] Camel((string Path, string Verdicts)[] fields) => fields.Select(f => (RenamePath(f.Path, CamelName), f.Verdicts)).ToArray();

    private static string Snake(string body) => Rename(body, SnakeName);

    private static (string Path, string Verdicts)[] Snake((string Path, string Verdicts)[] fields) => fields.Select(f => (RenamePath(f.Path, SnakeName), f.Verdicts)).ToArray();

    // ── 1. List rows per provider: the row contract (identity field required; titles and years display) ──

    // Per provider shape (ListsSourceReviewR3FixTests.Shapes: the production fetcher over each provider's real answer
    // shape), the row field paths and their role: "required" (the row's key; for Chronolists, an exact source whose rows
    // become placeholders without a title lookup, also its title: missing, null, wrong type or empty → the row is malformed
    // and the snapshot isn't complete) or "display" (title, year: unreadable → no value; the snapshot is complete by its
    // keys). The row types are review rounds 4–5's table (ListsSourceReviewR3FixTests.RowCases).
    internal static readonly Dictionary<string, (string Path, string Role)[]> RowFields = new()
    {
        ["tmdb list"] = new[] { ("id", "required"), ("title", "display"), ("release_date", "display") },
        ["tmdb trending"] = new[] { ("id", "required"), ("title", "display"), ("release_date", "display") },
        ["tmdb chart"] = new[] { ("id", "required"), ("title", "display"), ("release_date", "display") },
        ["tmdb collection"] = new[] { ("id", "required"), ("title", "display"), ("release_date", "display") },
        ["seerr trending"] = new[] { ("id", "required"), ("title", "display"), ("releaseDate", "display") },
        ["seerr collection"] = new[] { ("id", "required"), ("title", "display"), ("releaseDate", "display") },
        ["trakt list"] = new[] { ("movie.ids.tmdb", "required"), ("movie.title", "display"), ("movie.year", "display") },
        ["trakt chart"] = new[] { ("movie.ids.tmdb", "required"), ("movie.title", "display"), ("movie.year", "display") },
        ["trakt box office"] = new[] { ("movie.ids.tmdb", "required"), ("movie.title", "display"), ("movie.year", "display") },
        ["imdb list"] = new[] { ("node.item.id", "required"), ("node.item.titleText.text", "display"), ("node.item.releaseYear.year", "display") },
        ["imdb chart"] = new[] { ("node.item.id", "required"), ("node.item.titleText.text", "display"), ("node.item.releaseYear.year", "display") },
        ["mdblist public"] = new[] { ("id", "required"), ("title", "display"), ("release_year", "display") },
        ["mdblist official"] = new[] { ("id", "required"), ("title", "display"), ("release_year", "display") },
        ["mdblist api"] = new[] { ("id", "required"), ("title", "display"), ("release_year", "display") },
        ["chronolists"] = new[] { ("id", "required"), ("n", "required"), ("rd", "display") },
    };

    public static IEnumerable<object[]> RowContractCells() =>
        from provider in RowFields.Keys from field in RowFields[provider] from mutation in Mutations select new object[] { provider, field.Path, mutation };

    [Theory]
    [MemberData(nameof(RowContractCells))]
    public async Task EveryListRowIsReadByItsProvidersRowContract(string provider, string path, string mutation)
    {
        var shape = ListsSourceReviewR3FixTests.Shapes().Single(s => s.Provider == provider);
        var role = RowFields[provider].Single(f => f.Path == path).Role;
        var rows = new[] { Mutate(shape.Valid(1), path, mutation), shape.Valid(2), shape.Valid(3) };
        using var net = new Net();
        var (url, options) = shape.Arrange(net, rows);

        var result = await net.Fetch(url, options);
        output.WriteLine(provider + " | " + path + " " + mutation + ": ok " + result.Ok + ", complete " + IsComplete(result) + ", items " + result.Items?.Count + "\n" + rows[0]);

        Assert.True(result.Ok, result.ErrorCode);
        if (role == "required")
        {
            Assert.False(IsComplete(result), "a row without its required data: never a complete snapshot");
            Assert.DoesNotContain(result.Items, i => i.TmdbId == 1 || i.ImdbId == "tt1000001");
        }
        else
        {
            Assert.True(IsComplete(result), "a row's display field never decides completeness");
        }
    }

    // ── 1. Identity: an explicit null is a proven absence, a missing id is unknown (4c2-R7-1) ──

    /// <summary>The library holds copies no id at hand can find, so every identity is completed through the lookup.</summary>
    private sealed class CopiesBeyond : IImportPhysicalTitles
    {
        public ImportPhysical Read(User viewer, CompletedIdentity identity, int? season) => ImportPhysical.None;

        public bool HoldsCopiesBeyond(ImportIdentity identity) => true;
    }

    private static readonly Dictionary<string, (bool Movie, string Body, bool Completes, string? Imdb, int? Tvdb)> IdentityAnswers = new()
    {
        ["movie, no ids at all"] = (true, "{\"id\":49521,\"title\":\"Man of Steel\",\"overview\":\"Krypton.\"}", false, null, null),
        ["movie, external ids without imdb"] = (true, "{\"id\":49521,\"title\":\"Man of Steel\",\"external_ids\":{}}", false, null, null),
        ["movie, external imdb null"] = (true, "{\"id\":49521,\"title\":\"Man of Steel\",\"external_ids\":{\"imdb_id\":null}}", true, null, null),
        ["movie, imdb_id null"] = (true, "{\"id\":49521,\"title\":\"Man of Steel\",\"imdb_id\":null}", true, null, null),
        ["movie, imdb id"] = (true, "{\"id\":49521,\"title\":\"Man of Steel\",\"imdb_id\":\"tt0770828\",\"external_ids\":{\"imdb_id\":\"tt0770828\"}}", true, "tt0770828", null),
        ["tv, no external ids"] = (false, "{\"id\":1412,\"name\":\"Arrow\",\"seasons\":[]}", false, null, null),
        ["tv, imdb only (tvdb missing)"] = (false, "{\"id\":1412,\"name\":\"Arrow\",\"seasons\":[],\"external_ids\":{\"imdb_id\":\"tt2193021\"}}", false, null, null),
        ["tv, both null"] = (false, "{\"id\":1412,\"name\":\"Arrow\",\"seasons\":[],\"external_ids\":{\"imdb_id\":null,\"tvdb_id\":null}}", true, null, null),
        ["tv, tvdb with imdb null"] = (false, "{\"id\":1412,\"name\":\"Arrow\",\"seasons\":[],\"external_ids\":{\"imdb_id\":null,\"tvdb_id\":257655}}", true, null, 257655),
    };

    public static IEnumerable<object[]> IdentityCells() =>
        from lookup in new[] { "tmdb", "seerr" } from answer in IdentityAnswers.Keys select new object[] { lookup, answer };

    [Theory]
    [MemberData(nameof(IdentityCells))]
    public async Task AnIdentityIsCompletedOnlyByIdsTheAnswerProves(string lookup, string answer)
    {
        using var w = new World();
        var (movie, body, completes, imdb, tvdb) = IdentityAnswers[answer];
        var path = movie ? "movie/49521" : "tv/1412";
        w.Answer(lookup == "tmdb" ? Tmdb + path : SeerrA + path, lookup == "tmdb" ? body : Camel(body));
        w.Answer(SeerrB + path, "{}", 503);

        var completion = new CompletedIdentity.Completion(new CopiesBeyond(), w.Lookup(lookup), w.Context);
        var completed = await completion.CompleteAsync(new ImportIdentity(movie, movie ? 49521 : 1412, null, null), None);
        output.WriteLine(lookup + " " + answer + ": " + (completed?.Text() ?? "not completed"));

        Assert.Equal(completes, completed != null);
        if (completed != null)
        {
            Assert.Equal((imdb, tvdb), (completed.Imdb, completed.Tvdb));
        }
    }

    // The production resolver over the real TMDB lookup: a movie the library holds only under its IMDb id, where the viewer
    // can't open it. TMDB's details without external ids prove nothing about that IMDb id: the entry is retried, never
    // offered as a title that isn't in the library (and its overview never shown).
    private sealed class ImdbOnlyHeld : IImportPhysicalTitles
    {
        public ImportPhysical Read(User viewer, CompletedIdentity identity, int? season) => identity.Imdb == "tt0770828" ? ImportPhysical.Unreadable : ImportPhysical.None;

        public bool HoldsCopiesBeyond(ImportIdentity identity) => !identity.Providers.Contains("imdb");
    }

    [Theory]
    [InlineData("no ids", "{\"id\":49521,\"title\":\"Man of Steel\",\"release_date\":\"2013-06-12\",\"overview\":\"Krypton.\"}", "transient")]
    [InlineData("imdb id", "{\"id\":49521,\"title\":\"Man of Steel\",\"release_date\":\"2013-06-12\",\"overview\":\"Krypton.\",\"imdb_id\":\"tt0770828\",\"external_ids\":{\"imdb_id\":\"tt0770828\"}}", "held")]
    [InlineData("imdb proven absent", "{\"id\":49521,\"title\":\"Man of Steel\",\"release_date\":\"2013-06-12\",\"overview\":\"Krypton.\",\"imdb_id\":null,\"external_ids\":{\"imdb_id\":null}}", "offered")]
    public async Task AnImdbOnlyHeldTitleIsNeverOfferedOnDetailsWithoutIds(string answer, string details, string expected)
    {
        using var h = new ImportHarness();
        h.Plugin.Plugin.Configuration.TMDB_API_KEY = "tmdb-key";
        h.Tmdb["/3/movie/49521"] = details;
        var lookup = new TmdbImportLookup(new TmdbResponseCache(h.Lists.Transport, TimeProvider.System), h.Limiter, h.Plugin.Core.Logger);
        var resolver = new ListImportResolver(lookup, h.Library, h.Access, h.Limiter, h.Plugin.Core.Logger, h.Viewer, new ImdbOnlyHeld());
        var viewer = h.NewUser("viewer");

        var outcome = await resolver.ResolveAsync(new[] { new ImportEntryDto { Title = "Man of Steel", Year = 2013, TypeHint = "movie", Ids = new ImportIdsDto { Tmdb = 49521, TmdbType = "movie" } } }, new ImportResolveOptions
        {
            Caller = viewer,
            LibraryUsers = new[] { viewer },
            Context = new ImportCallContext("viewer", false),
            EmptyRetryDelay = TimeSpan.FromMilliseconds(1),
        }, None);

        var result = Assert.Single(outcome.Response.Results);
        var offered = result.Candidates.Where(c => c.InLibrary == null).ToList();
        output.WriteLine(answer + ": state " + result.State + ", match " + result.Match?.TmdbId + ", offered " + offered.Count + ", overview " + result.Match?.Overview);
        switch (expected)
        {
            case "transient":
                Assert.Equal("transient", result.State);
                Assert.Null(result.Match);
                break;
            case "held":
                Assert.NotEqual("transient", result.State);
                Assert.DoesNotContain(result.Candidates, c => c.Overview == "Krypton." && c.InLibrary == null);
                break;
            default:
                Assert.Equal(49521, result.Match?.TmdbId);
                break;
        }
    }

    // ── 1. A season is "missing" only on a Valid season list (4c2-R7-2) ──

    [Theory]
    [InlineData("seasons missing", "", "transient")]
    [InlineData("seasons null", ",\"seasons\":null", "transient")]
    [InlineData("seasons an object", ",\"seasons\":{\"season_number\":1}", "transient")]
    [InlineData("valid, without season 3", ",\"seasons\":[{\"season_number\":1,\"episode_count\":23}]", "missing")]
    public async Task ASeasonIsMissingOnlyOnAValidSeasonList(string answer, string seasons, string expected)
    {
        using var h = new ImportHarness();
        h.Plugin.Plugin.Configuration.TMDB_API_KEY = "tmdb-key";
        h.Tmdb["/3/tv/1412"] = "{\"id\":1412,\"name\":\"Arrow\",\"first_air_date\":\"2012-10-10\",\"external_ids\":{\"imdb_id\":\"tt2193021\",\"tvdb_id\":257655}" + seasons + "}";
        h.Tmdb["/3/tv/1412/season/3"] = "{\"episodes\":[{\"episode_number\":1,\"season_number\":3}]}";
        var lookup = new TmdbImportLookup(new TmdbResponseCache(h.Lists.Transport, TimeProvider.System), h.Limiter, h.Plugin.Core.Logger);
        var resolver = new ListImportResolver(lookup, h.Library, h.Access, h.Limiter, h.Plugin.Core.Logger, h.Viewer, h.Physical);
        var viewer = h.NewUser("viewer");

        var outcome = await resolver.ResolveAsync(new[] { new ImportEntryDto { Title = "Arrow", TypeHint = "tv", Season = 3, Ids = new ImportIdsDto { Tmdb = 1412, TmdbType = "tv" } } }, new ImportResolveOptions
        {
            Caller = viewer,
            LibraryUsers = new[] { viewer },
            Context = new ImportCallContext("viewer", false),
            EmptyRetryDelay = TimeSpan.FromMilliseconds(1),
        }, None);

        var result = Assert.Single(outcome.Response.Results);
        output.WriteLine(answer + ": state " + result.State + ", reasons " + string.Join(",", result.Reasons));
        if (expected == "transient")
        {
            Assert.Equal("transient", result.State);
            Assert.DoesNotContain("seasonMissing", result.Reasons);
        }
        else
        {
            Assert.Contains("seasonMissing", result.Reasons); // control: a valid list without the season proves it
        }
    }

    // ── 1. Seerr: a server's malformed or partial answer falls through to the next (4c2-R7-3) ──

    public static IEnumerable<object[]> FallthroughCells() =>
        from kind in new[] { "lookup details", "lookup season", "lookup search", "metadata movie", "metadata series" }
        from a in new[] { "{}", "partial" }
        select new object[] { kind, a };

    [Theory]
    [MemberData(nameof(FallthroughCells))]
    public async Task ASeerrServersMalformedOrPartialAnswerFallsThroughToTheNextServer(string kind, string a)
    {
        using var w = new World();
        var (path, valid, partial) = kind switch
        {
            "lookup details" => ("tv/1412", Camel(ShowBody), Mutate(Camel(ShowBody), "externalIds", "missing")),
            "lookup season" => ("tv/1412/season/1", Camel(SeasonBody), Mutate(Camel(SeasonBody), "episodes[0].name", "wrong type")),
            "lookup search" => ("search", Camel(MultiBody), Mutate(Camel(MultiBody), "results[0].id", "missing")),
            "metadata movie" => ("movie/10", MetaMovieBody, Mutate(MetaMovieBody, "releaseDate", "missing")),
            _ => ("tv/1412", MetaShowBody, Mutate(MetaShowBody, "seasons", "missing")),
        };
        w.Answer(SeerrA + path, a == "{}" ? "{}" : partial);
        w.Answer(SeerrB + path, valid);

        object? read;
        if (kind.StartsWith("lookup", StringComparison.Ordinal))
        {
            read = kind switch
            {
                "lookup details" => (await w.SeerrLookup.GetDetailsAsync("tv", 1412, w.Context, None)).Value?.Seasons.Count,
                "lookup season" => (await w.SeerrLookup.GetSeasonAsync(1412, 1, w.Context, None)).Value?[0].Title,
                _ => (await w.SeerrLookup.SearchAsync("Man of Steel", w.Context, None)).Value?.Count,
            };
        }
        else
        {
            var entry = Prefilled(kind == "metadata movie" ? PlaceholderKinds.Movie : PlaceholderKinds.Series);
            var metadata = await new ListMetadataService(w.Transport, w.Plugin.Core.Logger).FetchAsync(entry, TimeSpan.FromHours(12), Today, None);
            read = kind == "metadata movie" ? metadata?.ReleaseDate : metadata?.Expected?.Count;
        }

        var calls = w.Total;
        output.WriteLine(kind + " A " + a + ": read " + read + ", calls " + calls);
        Assert.Equal(2, calls); // B was asked
        Assert.Equal(kind switch
        {
            "lookup details" => (object)2,
            "lookup season" => "Pilot",
            "lookup search" => 2,
            "metadata movie" => "2010-07-16",
            _ => 3,
        }, read); // B's valid answer
    }

    // ── 2. Owned lifetimes: an MDBList account lives while it is referenced (4c2-R7-4) ──

    private static MdblistAccountStatus Balance(int remaining) => new()
    {
        Plan = "free",
        RateLimit = 1000,
        RateLimitRemaining = remaining,
        FetchedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
    };

    // Eight other keys meet the quota while `key` waits for its first balance (9 accounts: the cap is 8).
    private static async Task CrowdAsync(MdblistService quota)
    {
        for (var i = 0; i < 8; i++)
        {
            (await quota.TryReserveListRequestAsync("other-key-" + i.ToString(CultureInfo.InvariantCulture), _ => Task.FromResult<MdblistAccountStatus?>(Balance(500)), None))?.Dispose();
        }
    }

    [Fact]
    public async Task AnAccountWaitingForItsFirstBalanceIsNeverEvicted()
    {
        using var net = new Net();
        const string key = "mdb-waiting-key";
        var reads = 0;
        var arrived = false;
        using var release = new ManualResetEventSlim();
        async Task<MdblistAccountStatus?> ReadBalance(CancellationToken ct)
        {
            if (Interlocked.Increment(ref reads) == 1)
            {
                Volatile.Write(ref arrived, true);
                await Task.Run(() => release.Wait(TimeSpan.FromSeconds(10)), ct); // the first balance read is slow
            }

            return Balance(MdblistService.SafetyMargin + 1); // one request left to spend
        }

        var first = Task.Run(() => net.Quota.TryReserveListRequestAsync(key, ReadBalance, None));
        await WaitUntil(() => Volatile.Read(ref arrived));
        await CrowdAsync(net.Quota);
        var second = Task.Run(() => net.Quota.TryReserveListRequestAsync(key, ReadBalance, None));
        await Task.Delay(150);
        release.Set();
        var granted = new[] { await first, await second }.Count(r => r != null);

        output.WriteLine("granted " + granted + ", balance reads " + reads);
        Assert.Equal(1, granted); // one request was left: never two leases against one balance
        Assert.Equal(1, reads); // one account: the second waited for the first's balance read
    }

    [Fact]
    public async Task AnAccountWhoseStatusIsBeingReadIsNeverEvicted()
    {
        using var net = MdblistApiNet(() => MdblistService.SafetyMargin + 1);
        var status = net.Routes["https://api.mdblist.com/user"];
        var arrived = false;
        using var release = new ManualResetEventSlim();
        net.Routes["https://api.mdblist.com/user"] = r =>
        {
            Volatile.Write(ref arrived, true);
            release.Wait(TimeSpan.FromSeconds(10)); // the admin's status check is slow
            return status(r);
        };

        var check = Task.Run(() => net.Quota.GetAccountStatusAsync(None, forceRefresh: true));
        await WaitUntil(() => Volatile.Read(ref arrived));
        await CrowdAsync(net.Quota);
        var reads = 0;
        var reserve = Task.Run(() => net.Quota.TryReserveListRequestAsync("mdb-key", _ =>
        {
            Interlocked.Increment(ref reads);
            return Task.FromResult<MdblistAccountStatus?>(Balance(MdblistService.SafetyMargin + 1));
        }, None));
        await Task.Delay(150);
        release.Set();
        await check;
        var lease = await reserve;

        output.WriteLine("reservation " + (lease != null) + ", its own balance reads " + reads + ", remaining " + net.Quota.RemainingQuota());
        Assert.NotNull(lease);
        Assert.Equal(0, reads); // the same account: it took the status the check read
        Assert.Equal(MdblistService.SafetyMargin, net.Quota.RemainingQuota()); // and the configured key's account counts the lease
        lease!.Dispose();
    }

    // ── 2. Owned lifetimes: a limiter lease belongs to the upstream request (4c2-R7-5) ──

    /// <summary>The TMDB and Seerr lookups over a transport that holds every request until the test lets it go.</summary>
    private sealed class HeldNet : IDisposable
    {
        private readonly ConcurrentQueue<TaskCompletionSource<bool>> _held = new();
        private int _inFlight;
        private int _peak;
        private int _sent;

        public HeldNet()
        {
            var config = Plugin.Plugin.Configuration;
            config.TMDB_API_KEY = "tmdb-key";
            config.JellyseerrEnabled = true;
            config.JellyseerrUrls = "http://seerr-a.test";
            config.JellyseerrApiKey = "seerr-key";
            Transport = new IntegrationTransport(async (request, _) =>
            {
                var now = Interlocked.Increment(ref _inFlight);
                Interlocked.Increment(ref _sent);
                lock (_held)
                {
                    _peak = Math.Max(_peak, now);
                }

                var gate = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
                _held.Enqueue(gate);
                try
                {
                    await gate.Task.WaitAsync(TimeSpan.FromSeconds(20)); // TMDB is still answering (no caller can stop it)
                }
                finally
                {
                    Interlocked.Decrement(ref _inFlight);
                }

                var id = request.RequestUri!.Segments[^1];
                return request.RequestUri.Host == "seerr-a.test"
                    ? Json("{\"id\":" + id + ",\"title\":\"T" + id + "\",\"imdbId\":null,\"externalIds\":{\"imdbId\":null}}")
                    : Json("{\"id\":" + id + ",\"title\":\"T" + id + "\",\"imdb_id\":null,\"external_ids\":{\"imdb_id\":null}}");
            });
            Limiter = new MetadataCallLimiter(4, TimeSpan.Zero, TimeProvider.System);
            Cache = new TmdbResponseCache(Transport, TimeProvider.System);
            Tmdb = new TmdbImportLookup(Cache, Limiter, Plugin.Core.Logger);
            Seerr = new SeerrImportLookup(Transport, Limiter, Cache, Plugin.Core.Logger);
        }

        public ApiPluginFixture Plugin { get; } = new();

        public IntegrationTransport Transport { get; }

        public MetadataCallLimiter Limiter { get; }

        public TmdbResponseCache Cache { get; }

        public TmdbImportLookup Tmdb { get; }

        public SeerrImportLookup Seerr { get; }

        public int Sent => Volatile.Read(ref _sent);

        public int Peak
        {
            get
            {
                lock (_held)
                {
                    return _peak;
                }
            }
        }

        public IImportLookup Lookup(string name) => name == "tmdb" ? Tmdb : Seerr;

        public void ReleaseOne()
        {
            if (_held.TryDequeue(out var gate))
            {
                gate.TrySetResult(true);
            }
        }

        public void ReleaseAll()
        {
            while (_held.TryDequeue(out var gate))
            {
                gate.TrySetResult(true);
            }
        }

        public void Dispose()
        {
            ReleaseAll();
            Cache.Dispose();
            Transport.Dispose();
            Plugin.Dispose();
        }
    }

    [Theory]
    [InlineData("tmdb")]
    [InlineData("seerr")] // control: the Seerr lookup's shared fetch already held its lease
    public async Task CancelledLookupsLeaveTheirLeasesWithTheRequestsStillRunning(string lookup)
    {
        using var net = new HeldNet();
        var context = new ImportCallContext("r7", false);
        var callers = Enumerable.Range(1, 4).Select(_ => new CancellationTokenSource()).ToArray();
        var admitted = Enumerable.Range(1, 4).Select(i => Task.Run(() => net.Lookup(lookup).GetDetailsAsync("movie", 100 + i, context, callers[i - 1].Token))).ToArray();
        await WaitUntil(() => net.Sent == 4);
        foreach (var caller in callers)
        {
            caller.Cancel(); // every caller gives up; TMDB is still answering all four
        }

        foreach (var task in admitted)
        {
            try
            {
                await task;
            }
            catch (OperationCanceledException)
            {
            }
        }

        var fifth = Task.Run(() => net.Lookup(lookup).GetDetailsAsync("movie", 105, context, None));
        await Task.Delay(300);
        var sentWhileFull = net.Sent;
        net.ReleaseOne(); // one real request ends
        await WaitUntil(() => net.Sent == 5);
        net.ReleaseAll();
        var answer = await fifth;

        output.WriteLine(lookup + ": sent while four were running " + sentWhileFull + ", peak " + net.Peak + ", fifth " + answer.Status);
        Assert.Equal(4, sentWhileFull); // the fifth waited for a real request to end
        Assert.Equal(4, net.Peak);
        Assert.Equal(LookupStatus.Ok, answer.Status);
        foreach (var caller in callers)
        {
            caller.Dispose();
        }
    }

    [Theory]
    [InlineData("tmdb")]
    [InlineData("seerr")] // control: the Seerr lookup already shared one call
    public async Task ASharedWaiterTakesNoAdmission(string lookup)
    {
        using var net = new HeldNet();
        var context = new ImportCallContext("r7", false);
        var a = Task.Run(() => net.Lookup(lookup).GetDetailsAsync("movie", 7, context, None));
        await WaitUntil(() => net.Sent == 1);
        var b = Task.Run(() => net.Lookup(lookup).GetDetailsAsync("movie", 7, context, None));
        await Task.Delay(150);
        var admissions = net.Limiter.Stats().Total;
        net.ReleaseAll();
        var results = await Task.WhenAll(a, b);

        output.WriteLine(lookup + ": sent " + net.Sent + ", admissions " + admissions);
        Assert.All(results, r => Assert.Equal(LookupStatus.Ok, r.Status));
        Assert.Equal(1, net.Sent);
        Assert.Equal(1, admissions); // the second caller joined the request in flight without a turn of its own
    }

    // ── 3. No upstream body, URL or credential in any log line (4c2-R7-6) ──

    private static readonly string[] EchoModes = { "error body", "unreadable body", "unexpected shape", "transport error", "unexpected error" };

    public static IEnumerable<object[]> EchoCells() => EchoModes.Select(m => new object[] { m });

    [Theory]
    [MemberData(nameof(EchoCells))]
    public async Task NoProviderPathEverLogsAnUpstreamBodyUrlOrKey(string mode)
    {
        var key = "SYNTHKEY" + Guid.NewGuid().ToString("N");
        using var h = new ImportHarness();
        var plugin = h.Plugin;
        var config = plugin.Plugin.Configuration;
        ImportTestFlags.AllOn(config);
        config.ArrPhase4ListJeMetadataEnabled = true;
        config.ArrPhase4ListMdblistApiEnabled = true;
        config.TMDB_API_KEY = key;
        config.MdblistApiKey = key;
        config.ArrListTraktApiKey = key;
        config.JellyseerrEnabled = true;
        config.JellyseerrUrls = "http://seerr-a.test\nhttp://seerr-b.test";
        config.JellyseerrApiKey = key;

        // Every upstream echoes what it was sent (the URL with its query, every header) in the way `mode` names.
        using var transport = new IntegrationTransport((request, _) =>
        {
            var echo = request.RequestUri + " " + string.Join(";", request.Headers.Select(h => h.Key + "=" + string.Join(",", h.Value))) + " " + key;
            if (mode == "unexpected shape" && request.RequestUri!.AbsolutePath == "/user")
            {
                return Task.FromResult(Json(Status(500))); // a real balance, so the MDBList requests are sent and answered oddly
            }

            HttpResponseMessage response = mode switch
            {
                "error body" => Json("{\"status_message\":" + System.Text.Json.JsonSerializer.Serialize(echo) + ",\"error\":" + System.Text.Json.JsonSerializer.Serialize(echo) + "}", 500),
                "unreadable body" => IntegrationTransport.Response("<html>" + echo + "</html>"),
                "unexpected shape" => Json("{\"echo\":" + System.Text.Json.JsonSerializer.Serialize(echo) + "}"),
                "transport error" => throw new HttpRequestException("sending " + echo + " failed"),
                _ => throw new InvalidOperationException("broken handler for " + echo),
            };
            response.Headers.TryAddWithoutValidation("X-Echo", key);
            return Task.FromResult(response);
        });
        var logger = plugin.Core.Logger;
        var limiter = new MetadataCallLimiter(4, TimeSpan.Zero, TimeProvider.System);
        using var cache = new TmdbResponseCache(transport, TimeProvider.System);
        var context = new ImportCallContext("r7", false);
        var tmdb = new TmdbImportLookup(cache, limiter, logger);
        var seerr = new SeerrImportLookup(transport, limiter, cache, logger);
        var metadata = new ListMetadataService(transport, logger);
        var jeMetadata = new TmdbListMetadataSource(cache, logger);
        var cacheDir = Path.Combine(plugin.Core.Root, "mdb");
        using var mdblist = new MdblistService(transport, Mock.Of<IApplicationPaths>(p => p.PluginsPath == cacheDir), logger);
        var fetcher = new ListSourceFetcher(transport, cache, mdblist, limiter, logger, null, new CountingAdmission());
        var resolver = new ListImportResolver(new MetadataImportLookup(tmdb, seerr), h.Library, h.Access, limiter, logger);
        var caller = h.NewUser("member");

        var paths = new List<(string Name, Func<Task> Run)>
        {
            ("tmdb details", () => tmdb.GetDetailsAsync("tv", 1412, context, None)),
            ("tmdb search", () => tmdb.SearchAsync("Man of Steel", context, None)),
            ("tmdb season", () => tmdb.GetSeasonAsync(1412, 1, context, None)),
            ("tmdb episode find", () => tmdb.FindImdbEpisodeAsync("tt2338304", context, None)),
            ("seerr details", () => seerr.GetDetailsAsync("movie", 49521, context, None)),
            ("seerr search", () => seerr.SearchAsync("Arrow", context, None)),
            ("seerr season", () => seerr.GetSeasonAsync(1412, 1, context, None)),
            ("seerr episode find", () => seerr.FindImdbEpisodeAsync("tt2338305", context, None)),
            ("seerr metadata", () => metadata.FetchAsync(Prefilled(PlaceholderKinds.Season), TimeSpan.FromHours(12), Today, None)),
            ("tmdb poster", () => metadata.ReadTmdbPosterAsync(Prefilled(PlaceholderKinds.Season), None)),
            ("tmdb metadata", () => jeMetadata.FetchAsync(Prefilled(PlaceholderKinds.Season), TimeSpan.FromHours(12), Today, None)),
            ("mdblist ratings", () => mdblist.GetRatingsAsync("movie", "49521", None)),
            ("mdblist batch", () => mdblist.GetMediaBatchAsync("movie", new[] { "49521", "1412" }, None)),
            ("mdblist status", () => mdblist.GetAccountStatusAsync(None, forceRefresh: true)),
            ("mdblist list", () => Fetch(fetcher, "https://mdblist.com/lists/me/mine", ApiRead)),
            ("tmdb list", () => Fetch(fetcher, "https://www.themoviedb.org/list/634", new SourceFetchOptions { Fresh = true })),
            ("trakt list", () => Fetch(fetcher, "https://trakt.tv/users/someone/lists/mine", new SourceFetchOptions { Fresh = true })),
            ("resolver", () => resolver.ResolveAsync(new[] { new ImportEntryDto { Title = "Man of Steel", Year = 2013, TypeHint = "movie" } }, new ImportResolveOptions
            {
                Caller = caller,
                LibraryUsers = new[] { caller },
                Context = context,
                EmptyRetryDelay = TimeSpan.FromMilliseconds(1),
            }, None)),
        };

        var escaped = new List<string>();
        foreach (var (name, run) in paths)
        {
            try
            {
                await run();
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                escaped.Add(name + ": " + ex.GetType().Name + (ex.Message.Contains(key, StringComparison.Ordinal) ? " (carrying the key)" : string.Empty));
            }
        }

        var log = File.Exists(logger.CurrentLogFilePath) ? File.ReadAllText(logger.CurrentLogFilePath) : string.Empty;
        var leaks = log.Split('\n').Where(l => l.Contains(key, StringComparison.Ordinal) || l.Contains("SYNTHKEY", StringComparison.Ordinal)).ToList();
        output.WriteLine(mode + ": " + log.Split('\n').Length + " log lines, " + leaks.Count + " with the key; escaped: " + string.Join("; ", escaped));
        foreach (var leak in leaks.Take(20))
        {
            output.WriteLine("  LEAK " + leak.Replace(key, "<key>", StringComparison.Ordinal));
        }

        Assert.Contains("[", log); // the failures were logged (not vacuous)
        Assert.Empty(leaks);
        Assert.DoesNotContain(escaped, e => e.Contains("carrying the key", StringComparison.Ordinal));
    }

    // ── Found along the way (live): a wrong-shaped MDBList batch answer recorded every title as "no MDBList data" ──

    [Theory]
    [InlineData("{}", false)]
    [InlineData("{\"error\":\"x\"}", false)]
    [InlineData("[{\"ids\":{\"tmdb\":42},\"ratings\":[]},{\"ratings\":[]}]", false)]
    [InlineData("[{\"ids\":{\"tmdb\":42},\"ratings\":[]},\"x\"]", false)]
    [InlineData("[]", true)]
    [InlineData("[{\"type\":\"movie\",\"ids\":{\"tmdb\":42},\"ratings\":[]}]", true)]
    public async Task AWrongShapedMdblistBatchIsAFailureNeverAConfirmedNoMatch(string answer, bool read)
    {
        using var net = MdblistApiNet(() => 900);
        net.Routes["https://api.mdblist.com/tmdb/movie/"] = _ => Json(answer);

        var batch = await net.Quota.GetMediaBatchAsync("movie", new[] { "42", "43" }, None);
        output.WriteLine(answer + ": " + (batch == null ? "failed" : batch.Count + " matched"));

        Assert.Equal(read, batch != null); // null: the fetch skips the chunk and asks again next run
        if (batch != null)
        {
            net.Quota.MergeMediaBatchIntoCache("movie", new[] { "42", "43" }, batch);
            Assert.True(net.Quota.GetCachedEntry("movie", "43")!.Confirmed); // a valid answer without 43 does say "no data"
        }
        else
        {
            Assert.Null(net.Quota.GetCachedEntry("movie", "43"));
        }
    }

    // ── Found along the way (live): a list create refused for a bad request id said the NAME was missing ──

    [Theory]
    [InlineData("a name", "good-id", null)]
    [InlineData("", "good-id", "name")]
    [InlineData("a name", "has spaces", "request id")]
    public async Task AListCreateRefusalSaysWhatIsWrong(string name, string requestId, string? wrong)
    {
        using var h = new ListsHarness();
        var user = h.NewUser("owner");
        var controller = new Jellyfin.Plugin.JellyfinEnhanced.Controllers.AcquireListsController(h.Users.Object, h.Access, h.Service, h.Plugin.Core.Logger)
        {
            ControllerContext = new Microsoft.AspNetCore.Mvc.ControllerContext { HttpContext = new Microsoft.AspNetCore.Http.DefaultHttpContext() },
        };
        controller.HttpContext.User = TestCallers.Principal(user.Id, false);

        var result = Assert.IsAssignableFrom<Microsoft.AspNetCore.Mvc.ObjectResult>(await controller.CreatePlaylist(new CreateListRequest { Name = name, RequestId = requestId, Entries = new() }, None));
        var message = (result.Value as ListErrorDto)?.Message;
        output.WriteLine(name + " / " + requestId + ": " + result.StatusCode + " " + message);
        if (wrong == null)
        {
            Assert.True(result.StatusCode is null or 200, "status " + result.StatusCode);
        }
        else
        {
            Assert.Equal(400, result.StatusCode);
            Assert.Contains(wrong, message!, StringComparison.OrdinalIgnoreCase);
        }
    }

    private static async Task Fetch(ListSourceFetcher fetcher, string url, SourceFetchOptions options)
    {
        Assert.True(ListSourceUrl.TryParse(url, out var source, out var error), error);
        await fetcher.FetchAsync(source!, options, None);
    }
}
