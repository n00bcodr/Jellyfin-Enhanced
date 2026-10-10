using System.Globalization;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using Moq;

namespace JE.Tests;

/// <summary>
/// The list placeholder services wired to an in-memory Jellyfin (<see cref="FakeListHost"/>), a real store on disk,
/// the real Seerr parental filter and status index behind a synthetic Seerr. Uses the plugin singleton.
/// </summary>
internal sealed class ListPlaceholdersHarness : IDisposable
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
    public ListPlaceholderStore Store { get; }
    public ListAccessService Access { get; }
    public SeerrMediaIndex Index { get; }
    public ListPlaceholderResolver Resolver { get; }
    public ListPlaceholderMetadataService Metadata { get; }
    public ListPlaceholderSwapService Swap { get; }
    public ListPlaceholderService Service { get; }

    /// <summary>Synthetic Seerr TV details by TMDB id (JSON), served at /api/v1/tv/{id}.</summary>
    public Dictionary<int, string> TvDetails { get; } = new();

    /// <summary>Synthetic Seerr season details by (TMDB id, season) (JSON), served at /api/v1/tv/{id}/season/{n}.</summary>
    public Dictionary<(int Tmdb, int Season), string> SeasonDetails { get; } = new();

    /// <summary>Synthetic Seerr movie details by TMDB id (JSON), served at /api/v1/movie/{id} (before certifications).</summary>
    public Dictionary<int, string> MovieDetails { get; } = new();

    /// <summary>TMDB certification per movie id for the synthetic Seerr detail endpoint.</summary>
    public Dictionary<int, string> MovieCertifications { get; } = new();

    public ListPlaceholdersHarness(bool seerr = false)
    {
        Plugin.Plugin.Configuration.ListPlaceholdersEnabled = true;
        if (seerr)
        {
            Plugin.Plugin.Configuration.JellyseerrEnabled = true;
            Plugin.Plugin.Configuration.JellyseerrUrls = "http://seerr.test";
            Plugin.Plugin.Configuration.JellyseerrApiKey = "seerr-key";
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
        var serverConfig = new Mock<IServerConfigurationManager>();
        serverConfig.SetupGet(c => c.Configuration).Returns(new ServerConfiguration { MetadataCountryCode = "US" });
        var filter = new SeerrParentalFilter(Transport, Users.Object, Localization.Object, serverConfig.Object, Plugin.Core.Logger);
        Store = new ListPlaceholderStore(Plugin.Core.Paths.Object, Plugin.Core.Logger);
        Access = new ListAccessService(Host, Users.Object, filter, Plugin.Core.Logger);
        Index = new SeerrMediaIndex(Transport, Plugin.Core.Logger);
        Resolver = new ListPlaceholderResolver(Host, Plugin.Core.Logger);
        Metadata = new ListPlaceholderMetadataService(Transport, Plugin.Core.Logger);
        Swap = new ListPlaceholderSwapService(Store, Host, Users.Object, Resolver, Metadata, Plugin.Core.Logger) { SettleDelay = TimeSpan.Zero };
        Service = new ListPlaceholderService(Store, Access, Host, Index, Users.Object, Plugin.Core.Logger, Resolver, Metadata, Swap);
    }

    public User NewUser(string name, bool admin = false, bool collections = false, int? maxRating = null)
    {
        var user = FakeListHost.MakeUser(name, admin, collections);
        user.MaxParentalRatingScore = maxRating;
        Users.Setup(u => u.GetUserById(user.Id)).Returns(user);
        return user;
    }

    public ListAccess AccessFor(FakeListHost.FakeList list, User user) => Access.Evaluate(list.Info, user);

    public static string E(Guid id, int k = 0) => ListPlaceholderOrder.RealToken(id, k);

    public static string P(string id) => "p:" + id;

    public static Placeholder Ph(string json, string addedBy = "00000000000000000000000000000000")
    {
        var dto = System.Text.Json.JsonSerializer.Deserialize<NewPlaceholderDto>(json)!;
        Assert.True(PlaceholderRules.TryCreate(dto, addedBy, DateTime.UtcNow, out var placeholder, out var error), error);
        return placeholder;
    }

    public static Placeholder Movie(int tmdb, string? releaseDate = null, string? addedBy = null) =>
        Ph($"{{\"kind\":\"movie\",\"tmdbId\":{tmdb.ToString(CultureInfo.InvariantCulture)},\"title\":\"Movie {tmdb.ToString(CultureInfo.InvariantCulture)}\"{(releaseDate == null ? string.Empty : ",\"releaseDate\":\"" + releaseDate + "\"")}}}", addedBy ?? "00000000000000000000000000000000");

    public static T Ok<T>(ListOutcome outcome)
    {
        Assert.True(outcome.StatusCode == 200, $"expected 200, got {outcome.StatusCode}: {System.Text.Json.JsonSerializer.Serialize(outcome.Value)}");
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
        Plugin.Dispose();
    }

    private HttpResponseMessage DefaultReply(HttpRequestMessage request)
    {
        var path = request.RequestUri!.AbsolutePath;
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
