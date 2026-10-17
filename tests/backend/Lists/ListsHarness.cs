using System.Globalization;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using Moq;

namespace JE.Tests;

/// <summary>
/// The list core services wired to an in-memory Jellyfin (<see cref="FakeListHost"/>), a real store on disk under the
/// fixture's temp root, durable operations in a temp acquire.db, the real Seerr parental filter and metadata reader
/// behind a synthetic Seerr, and per-person preferences (<see cref="Preferences"/>). Turns on the list switches it
/// needs (lists, authoring, swap-in); uses the plugin singleton.
/// </summary>
internal sealed class ListsHarness : IDisposable
{
    public ApiPluginFixture Plugin { get; } = new();
    public FakeListHost Host { get; } = new();
    public Mock<IUserManager> Users { get; } = new();
    public Mock<ILocalizationManager> Localization { get; } = new();
    public List<string> SeerrCalls { get; } = new();
    public Func<HttpRequestMessage, HttpResponseMessage> Reply { get; set; }
    /// <summary>When set, answers Seerr calls instead of <see cref="Reply"/> (hanging/slow Seerr).</summary>
    public Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>>? ReplyAsync { get; set; }
    public IntegrationTransport Transport { get; }
    /// <summary>Server configuration (metadata country "US"; the parental filter rates titles with it).</summary>
    public Mock<IServerConfigurationManager> ServerConfig { get; } = new();
    public AcquireDatabase Database { get; }
    public ListOperations Operations { get; }
    public ListEventStore Events { get; }
    public FakeListPreferences Preferences { get; } = new();
    public FakeListStatusSource Status { get; } = new();
    public ListStore Store { get; }
    public ListAccessService Access { get; }
    public ListResolver Resolver { get; }
    public ListMetadataService Metadata { get; }
    public ListSwapService Swap { get; }
    public ListService Service { get; }

    /// <summary>Request capabilities per user for the list views' request actions (null: none).</summary>
    public Dictionary<Guid, RequestCapabilities> Capabilities { get; } = new();

    /// <summary>Synthetic Seerr TV details by TMDB id (JSON), served at /api/v1/tv/{id}.</summary>
    public Dictionary<int, string> TvDetails { get; } = new();

    /// <summary>Synthetic Seerr season details by (TMDB id, season) (JSON), served at /api/v1/tv/{id}/season/{n}.</summary>
    public Dictionary<(int Tmdb, int Season), string> SeasonDetails { get; } = new();

    /// <summary>Synthetic Seerr movie details by TMDB id (JSON), served at /api/v1/movie/{id} (before certifications).</summary>
    public Dictionary<int, string> MovieDetails { get; } = new();

    /// <summary>Synthetic TMDB API answers by path (e.g. <c>/3/movie/10</c>), served for api.themoviedb.org.</summary>
    public Dictionary<string, string> Tmdb { get; } = new(StringComparer.Ordinal);

    /// <summary>TMDB certification per movie id for the synthetic Seerr detail endpoint.</summary>
    public Dictionary<int, string> MovieCertifications { get; } = new();

    /// <param name="seerr">Configure a (synthetic) Seerr.</param>
    /// <param name="status">Wire <see cref="Status"/> as the list status source.</param>
    public ListsHarness(bool seerr = false, bool status = false)
    {
        var config = Plugin.Plugin.Configuration;
        config.ArrIntegrationEnabled = true;
        config.ArrPhase1Enabled = true;
        config.ArrPhase3Enabled = true;
        config.ArrPhase4Enabled = true;
        config.ArrPhase4ListPlaceholdersEnabled = true;
        config.ArrPhase4ListAuthoringEnabled = true;
        config.ArrPhase4ListSwapInEnabled = true;
        if (seerr)
        {
            config.JellyseerrEnabled = true;
            config.JellyseerrUrls = "http://seerr.test";
            config.JellyseerrApiKey = "seerr-key";
        }

        Reply = DefaultReply;
        Transport = new IntegrationTransport((request, ct) =>
        {
            lock (SeerrCalls)
            {
                SeerrCalls.Add(request.RequestUri!.PathAndQuery);
            }

            return ReplyAsync != null ? ReplyAsync(request, ct) : Task.FromResult(Reply(request));
        });
        Localization.Setup(l => l.GetRatingScore(It.IsAny<string>(), It.IsAny<string?>()))
            .Returns((string rating, string? _) => rating switch
            {
                "G" => new ParentalRatingScore(0, null),
                "PG" => new ParentalRatingScore(10, null),
                "R" => new ParentalRatingScore(17, null),
                _ => null,
            });
        ServerConfig.SetupGet(c => c.Configuration).Returns(new ServerConfiguration { MetadataCountryCode = "US" });
        var filter = new SeerrParentalFilter(Transport, Users.Object, Localization.Object, ServerConfig.Object, Plugin.Core.Logger);
        Database = new AcquireDatabase(Path.Combine(Plugin.Core.Root, "acquire.db"), Plugin.Core.Logger);
        Operations = new ListOperations(Database);
        Events = new ListEventStore(Database);
        Store = new ListStore(Path.Combine(Plugin.Core.ConfigRoot, ListStore.DirectoryName), Plugin.Core.Logger);
        Access = new ListAccessService(Host, Users.Object, filter, Plugin.Core.Logger);
        Resolver = new ListResolver(Host, Plugin.Core.Logger);
        Metadata = new ListMetadataService(Transport, Plugin.Core.Logger);
        Swap = new ListSwapService(Store, Host, Users.Object, Resolver, Metadata, Plugin.Core.Logger, Events, Preferences, Access) { SettleDelay = TimeSpan.Zero };
        Service = new ListService(
            Store, Access, Host, Users.Object, Plugin.Core.Logger, Resolver, Metadata, Swap, Operations,
            status ? Status : null, Preferences, user => Capabilities.TryGetValue(user, out var capabilities) ? capabilities : null);
    }

    public User NewUser(string name, bool admin = false, bool collections = false, int? maxRating = null)
    {
        var user = FakeListHost.MakeUser(name, admin, collections);
        user.MaxParentalRatingScore = maxRating;
        Users.Setup(u => u.GetUserById(user.Id)).Returns(user);
        return user;
    }

    public ListAccess AccessFor(FakeListHost.FakeList list, User user) => Access.Evaluate(list.Info, user);

    /// <summary>
    /// Turns automatic swap-in on for the list as <paramref name="access"/>'s user (the list's recorded consent, D29),
    /// creating the document when the list has none. The harness's preferences agree by default.
    /// </summary>
    public async Task Consent(ListAccess access)
    {
        using (await Store.LockAsync(access.ListIdN))
        {
            var doc = Store.LoadForUpdate(access.ListIdN, access.List.Kind);
            if (doc.SwapIn != null)
            {
                return;
            }

            doc.SwapIn = new ListConsent { ByUserId = access.UserIdN, At = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) };
            Store.Save(doc);
        }
    }

    /// <summary>A durable request key (same id + same fingerprint = a retry of the same request).</summary>
    public static ListRequestKey K(string requestId, string fingerprint = "fp") => new(requestId, fingerprint);

    public static string E(Guid id, int k = 0) => ListOrder.RealToken(id, k);

    public static string P(string id) => "p:" + id;

    public static Placeholder Ph(string json, string addedBy = "00000000000000000000000000000000")
    {
        var dto = JsonSerializer.Deserialize<NewPlaceholderDto>(json)!;
        Assert.True(ListRules.TryCreate(dto, addedBy, DateTime.UtcNow, out var placeholder, out var error), error);
        return placeholder;
    }

    public static Placeholder Movie(int tmdb, string? releaseDate = null, string? addedBy = null) =>
        Ph($"{{\"kind\":\"movie\",\"tmdbId\":{tmdb.ToString(CultureInfo.InvariantCulture)},\"title\":\"Movie {tmdb.ToString(CultureInfo.InvariantCulture)}\"{(releaseDate == null ? string.Empty : ",\"releaseDate\":\"" + releaseDate + "\"")}}}", addedBy ?? "00000000000000000000000000000000");

    public static T Ok<T>(ListOutcome outcome)
    {
        Assert.True(outcome.StatusCode == 200, $"expected 200, got {outcome.StatusCode}: {JsonSerializer.Serialize(outcome.Value)}");
        return Assert.IsType<T>(outcome.Value);
    }

    public static ListErrorDto Error(ListOutcome outcome, int status, string code)
    {
        Assert.Equal(status, outcome.StatusCode);
        var error = Assert.IsType<ListErrorDto>(outcome.Value);
        Assert.Equal(code, error.Code);
        return error;
    }

    public void Dispose()
    {
        Swap.Dispose();
        Transport.Dispose();
        Database.Dispose();
        Plugin.Dispose();
    }

    private HttpResponseMessage DefaultReply(HttpRequestMessage request)
    {
        var path = request.RequestUri!.AbsolutePath;
        if (request.RequestUri.Host == "api.themoviedb.org")
        {
            return Tmdb.TryGetValue(path, out var body) ? IntegrationTransport.Response(body) : IntegrationTransport.Response("{\"status_code\":34}", 404);
        }

        if (path is "/api/v1/media" or "/api/v1/request")
        {
            return IntegrationTransport.Response("{\"pageInfo\":{\"pages\":1},\"results\":[]}");
        }

        if (path.StartsWith("/api/v1/tv/", StringComparison.Ordinal))
        {
            var parts = path["/api/v1/tv/".Length..].Split('/');
            if (parts.Length == 1 && int.TryParse(parts[0], out var tvId) && TvDetails.TryGetValue(tvId, out var tv))
            {
                return IntegrationTransport.Response(tv);
            }

            if (parts.Length == 3 && parts[1] == "season" && int.TryParse(parts[0], out var showId) && int.TryParse(parts[2], out var number)
                && SeasonDetails.TryGetValue((showId, number), out var season))
            {
                return IntegrationTransport.Response(season);
            }

            return IntegrationTransport.Response("{\"message\":\"Unable to retrieve series.\"}", 500);
        }

        if (path.StartsWith("/api/v1/movie/", StringComparison.Ordinal)
            && int.TryParse(path["/api/v1/movie/".Length..], out var movieId)
            && MovieDetails.TryGetValue(movieId, out var movie))
        {
            return IntegrationTransport.Response(movie);
        }

        if (path.StartsWith("/api/v1/movie/", StringComparison.Ordinal)
            && int.TryParse(path["/api/v1/movie/".Length..], out var id)
            && MovieCertifications.TryGetValue(id, out var cert))
        {
            return IntegrationTransport.Response("{\"id\":" + id + ",\"releases\":{\"results\":[{\"iso_3166_1\":\"US\",\"release_dates\":[{\"certification\":\"" + cert + "\",\"type\":3}]}]}}");
        }

        return IntegrationTransport.Response("{\"message\":\"not found\"}", 404);
    }
}

/// <summary>Per-person list preferences for tests: swap-in agreed by default, display preferences unset.</summary>
internal sealed class FakeListPreferences : IListPreferences
{
    public Dictionary<Guid, (bool? Placeholders, bool? Status, bool? SwapIn)> ByUser { get; } = new();

    public (bool? Placeholders, bool? Status, bool? SwapIn) Default { get; set; } = (null, null, true);

    public (bool? Placeholders, bool? Status, bool? SwapIn) For(Guid user) => ByUser.TryGetValue(user, out var preferences) ? preferences : Default;
}

/// <summary>A request status source that answers fixed JSON per title key (or throws), and records what it was asked.</summary>
internal sealed class FakeListStatusSource : IListStatusSource
{
    public Dictionary<string, string> ByKey { get; } = new(StringComparer.Ordinal);

    public List<(Guid User, IReadOnlyList<string> Keys)> Calls { get; } = new();

    /// <summary>Season-scoped reads: the viewer and the season ids (<see cref="ListStatusKeys.SeasonId"/>) asked for.</summary>
    public List<(Guid User, IReadOnlyList<string> Seasons)> SeasonCalls { get; } = new();

    public Exception? Fail { get; set; }

    /// <summary>Runs during each title status read (e.g. a share removed while the statuses load).</summary>
    public Action? During { get; set; }

    public Task<IReadOnlyDictionary<string, JsonElement>> StatusesAsync(Guid user, IReadOnlyList<TitleKey> keys, CancellationToken cancellationToken)
    {
        Calls.Add((user, keys.Select(k => k.ToString()).ToList()));
        During?.Invoke();
        if (Fail != null)
        {
            throw Fail;
        }

        IReadOnlyDictionary<string, JsonElement> result = keys
            .Select(k => k.ToString())
            .Where(ByKey.ContainsKey)
            .Distinct()
            .ToDictionary(k => k, k => JsonDocument.Parse(ByKey[k]).RootElement.Clone(), StringComparer.Ordinal);
        return Task.FromResult(result);
    }

    /// <summary>Season reads with what the list knows of each season (episodes and whether it premiered).</summary>
    public List<ListStatusSeason> SeasonDetails { get; } = new();

    // Recorded, then answered like the plain season reads.
    public Task<IReadOnlyDictionary<string, JsonElement>> SeasonStatusesAsync(Guid user, IReadOnlyList<ListStatusSeason> seasons, CancellationToken cancellationToken)
    {
        SeasonDetails.AddRange(seasons);
        return SeasonStatusesAsync(user, seasons.Select(s => (s.Key, s.TmdbId, s.Season)).ToList(), cancellationToken);
    }

    /// <summary>Part reads (4K entries): the viewer and the part ids asked for.</summary>
    public List<(Guid User, IReadOnlyList<string> Parts)> PartCalls { get; } = new();

    // Part ids answered from ByKey too.
    public Task<IReadOnlyDictionary<string, JsonElement>> PartStatusesAsync(Guid user, IReadOnlyList<ListStatusPart> parts, CancellationToken cancellationToken)
    {
        var ids = parts.Select(p => p.Id).ToList();
        PartCalls.Add((user, ids));
        if (Fail != null)
        {
            throw Fail;
        }

        IReadOnlyDictionary<string, JsonElement> result = ids
            .Where(ByKey.ContainsKey)
            .Distinct()
            .ToDictionary(k => k, k => JsonDocument.Parse(ByKey[k]).RootElement.Clone(), StringComparer.Ordinal);
        return Task.FromResult(result);
    }

    // Season ids answered from ByKey too (an empty dictionary unless a test put a season id there).
    public Task<IReadOnlyDictionary<string, JsonElement>> SeasonStatusesAsync(Guid user, IReadOnlyList<(TitleKey Key, int TmdbId, int Season)> seasons, CancellationToken cancellationToken)
    {
        var ids = seasons.Select(s => ListStatusKeys.SeasonId(s.Key, s.Season)).ToList();
        SeasonCalls.Add((user, ids));
        if (Fail != null)
        {
            throw Fail;
        }

        IReadOnlyDictionary<string, JsonElement> result = ids
            .Where(ByKey.ContainsKey)
            .Distinct()
            .ToDictionary(k => k, k => JsonDocument.Parse(ByKey[k]).RootElement.Clone(), StringComparer.Ordinal);
        return Task.FromResult(result);
    }
}
