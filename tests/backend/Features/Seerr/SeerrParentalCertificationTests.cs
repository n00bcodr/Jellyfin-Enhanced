using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Seerr;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Parental;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Seerr;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests.Features.Seerr;

/// <summary>
/// The Seerr parental gate reads a title's certification the way Jellyfin 12.4's TMDB
/// providers fill an item's rating: the server's metadata country first, then the US one
/// (TmdbMovieProvider), and for a series the first listed after that (TmdbSeriesProvider).
/// A title with none is unrated, allowed unless the user blocks unrated items of its kind.
/// </summary>
[Collection("Plugin singleton")]
public class SeerrParentalCertificationTests
{
    // Enough of Jellyfin's rating tables for these titles, looked up in Jellyfin's order:
    // a plain number, the given country's table, the US table, then every other table.
    private static readonly Dictionary<string, Dictionary<string, int>> Tables = new(StringComparer.OrdinalIgnoreCase)
    {
        ["US"] = new(StringComparer.OrdinalIgnoreCase) { ["G"] = 0, ["PG"] = 10, ["PG-13"] = 13, ["R"] = 17, ["NC-17"] = 18, ["TV-PG"] = 10, ["TV-14"] = 14, ["TV-MA"] = 17 },
        ["DE"] = new(StringComparer.OrdinalIgnoreCase) { ["FSK-0"] = 0, ["FSK-6"] = 6, ["FSK-12"] = 12, ["FSK-16"] = 16, ["FSK-18"] = 18 },
        ["GB"] = new(StringComparer.OrdinalIgnoreCase) { ["U"] = 0, ["12A"] = 12, ["15"] = 15, ["18"] = 18 },
        ["NZ"] = new(StringComparer.OrdinalIgnoreCase) { ["G"] = 0, ["PG"] = 13, ["M"] = 16, ["R18"] = 18 },
    };

    // Ratings scored with a sub-score, as some of Jellyfin's rating tables give one.
    private static readonly Dictionary<string, ParentalRatingScore> SubScored = new(StringComparer.OrdinalIgnoreCase)
    {
        ["TEST-10-1"] = new ParentalRatingScore(10, 1),
        ["TEST-12-1"] = new ParentalRatingScore(12, 1),
    };

    private static ParentalRatingScore? Score(string rating, string? country)
    {
        if (SubScored.TryGetValue(rating, out var scored)) return scored;
        if (int.TryParse(rating, out var n)) return new ParentalRatingScore(n, null);
        foreach (var table in new[] { country ?? "", "US" }.Select(c => Tables.GetValueOrDefault(c)).Concat(Tables.Values))
        {
            if (table != null && table.TryGetValue(rating, out var s)) return new ParentalRatingScore(s, null);
        }
        return null;
    }

    private sealed class Lab : IDisposable
    {
        public ApiPluginFixture Plugin { get; } = new();
        public User Kid { get; } = new("kid", "default", "default") { Id = Guid.NewGuid(), MaxParentalRatingScore = 12 };
        public Dictionary<string, string> Details { get; } = new(StringComparer.Ordinal);
        public JeSeerrController Controller { get; }

        public Lab(bool blockUnrated, string country = "DE")
        {
            SeerrCaches.ClearAllSeerrCachesOnConfigChange();
            var config = Plugin.Plugin.Configuration;
            config.JellyseerrEnabled = true;
            config.JellyseerrAutoImportUsers = false;
            config.JellyseerrUrls = "http://seerr.invalid";
            config.JellyseerrApiKey = "test-secret";
            config.SpoilerAutoEnableOnSeerrRequest = false;
            if (blockUnrated) Kid.SetPreference(PreferenceKind.BlockUnratedItems, new[] { UnratedItem.Movie, UnratedItem.Series });
            var transport = new IntegrationTransport((request, _) =>
            {
                var path = request.RequestUri!.AbsolutePath;
                if (path == "/api/v1/user") return Task.FromResult(IntegrationTransport.Response(JsonSerializer.Serialize(new { results = new[] {
                    new { id = 27, jellyfinUserId = Kid.Id.ToString("N"), permissions = (int)JellyseerrPermission.REQUEST } } })));
                if (request.Method == HttpMethod.Post) return Task.FromResult(IntegrationTransport.Response("{\"id\":99}", 201));
                return Task.FromResult(Details.TryGetValue(path, out var body) ? IntegrationTransport.Response(body) : IntegrationTransport.Response("{}", 404));
            });
            var users = new Mock<IUserManager>();
            users.Setup(u => u.GetUserById(Kid.Id)).Returns(Kid);
            var localization = new Mock<ILocalizationManager>();
            localization.Setup(l => l.GetRatingScore(It.IsAny<string>(), It.IsAny<string?>())).Returns((string r, string? c) => Score(r, c));
            var server = new Mock<IServerConfigurationManager>();
            server.Setup(s => s.Configuration).Returns(new ServerConfiguration { MetadataCountryCode = country });
            var filter = new SeerrParentalFilter(transport, users.Object, localization.Object, server.Object, Plugin.Core.Logger);
            Controller = (JeSeerrController)ApiAssetTests.Controller(typeof(JeSeerrController), Plugin.Core, transport, users.Object, filter);
            Controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([
                new Claim("Jellyfin-UserId", Kid.Id.ToString()), new Claim(ClaimTypes.Role, "User")], "test"));
        }

        public void Dispose() { SeerrCaches.ClearAllSeerrCachesOnConfigChange(); Plugin.Dispose(); }
    }

    private static string Movie(int id, params (string Iso, string Cert)[] releases) => JsonSerializer.Serialize(new
    {
        id,
        title = "Film " + id,
        releases = new { results = releases.Select(r => new { iso_3166_1 = r.Iso, release_dates = new[] { new { certification = r.Cert, type = 3 } } }) },
    });

    private static string Series(int id, params (string Iso, string Rating)[] ratings) => JsonSerializer.Serialize(new
    {
        id,
        name = "Show " + id,
        contentRatings = new { results = ratings.Select(r => new { iso_3166_1 = r.Iso, rating = r.Rating }) },
    });

    private static bool Refused(IActionResult result) => result is ObjectResult { StatusCode: 403 } or StatusCodeResult { StatusCode: 403 };

    [Fact]
    public async Task ATitleRatedOnlyInTheUsIsScoredByItsUsRatingLikeJellyfin()
    {
        using var lab = new Lab(blockUnrated: false);
        lab.Details["/api/v1/movie/501"] = Movie(501, ("US", "R"), ("FR", ""));
        lab.Details["/api/v1/movie/502"] = Movie(502, ("US", "PG"));
        lab.Details["/api/v1/movie/503"] = Movie(503, ("DE", "12"), ("US", "R"));
        lab.Details["/api/v1/tv/601"] = Series(601, ("US", "TV-MA"));

        // R (US 17) is above the child's FSK 12 limit: Jellyfin stores "R" for this film and hides it.
        Assert.True(Refused(await lab.Controller.GetMovie(501)));
        Assert.True(Refused(await lab.Controller.GetTvShow(601)));
        // ... and refuses the request whichever surface it came from.
        Assert.True(Refused(await lab.Controller.JellyseerrRequest(JsonSerializer.Deserialize<JsonElement>("{\"mediaType\":\"movie\",\"mediaId\":501}"))));
        // Within the limit through the US rating, and the local rating still wins over the US one.
        Assert.False(Refused(await lab.Controller.GetMovie(502)));
        Assert.False(Refused(await lab.Controller.GetMovie(503)));
    }

    [Fact]
    public async Task AUsFallbackRatingIsScoredInTheServersCountryLikeJellyfin()
    {
        // Jellyfin stores the US "PG" unprefixed and scores it in the New Zealand table first (13).
        using var lab = new Lab(blockUnrated: false, country: "NZ");
        lab.Details["/api/v1/movie/506"] = Movie(506, ("US", "PG"));

        Assert.True(Refused(await lab.Controller.GetMovie(506)));
    }

    [Fact]
    public async Task ASeriesWithNeitherTheLocalNorTheUsRatingTakesTheFirstListedLikeJellyfin()
    {
        using var lab = new Lab(blockUnrated: false);
        lab.Details["/api/v1/tv/602"] = Series(602, ("GB", "18"), ("FR", "10"));
        lab.Details["/api/v1/tv/603"] = Series(603, ("GB", "U"), ("FR", "18"));

        Assert.True(Refused(await lab.Controller.GetTvShow(602)));
        Assert.False(Refused(await lab.Controller.GetTvShow(603)));
    }

    [Fact]
    public async Task ASubScoreLimitAppliesOnlyAtItsOwnScoreLikeJellyfin()
    {
        // Jellyfin compares (score, sub-score) in order: under a (12, 0) limit the library shows a title scored
        // (10, 1) and hides one scored (12, 1).
        using var lab = new Lab(blockUnrated: false);
        lab.Kid.MaxParentalRatingSubScore = 0;
        lab.Details["/api/v1/movie/507"] = Movie(507, ("DE", "TEST-10-1"));
        lab.Details["/api/v1/movie/508"] = Movie(508, ("DE", "TEST-12-1"));

        Assert.False(Refused(await lab.Controller.GetMovie(507)));
        Assert.True(Refused(await lab.Controller.GetMovie(508)));
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, true)]
    public async Task ATitleWithNoUsableRatingFollowsTheUsersBlockUnratedSetting(bool blockUnrated, bool refused)
    {
        using var lab = new Lab(blockUnrated);
        lab.Details["/api/v1/movie/504"] = Movie(504, ("FR", "12"), ("US", ""));
        lab.Details["/api/v1/movie/505"] = Movie(505);
        lab.Details["/api/v1/tv/604"] = Series(604);

        Assert.Equal(refused, Refused(await lab.Controller.GetMovie(504)));
        Assert.Equal(refused, Refused(await lab.Controller.GetMovie(505)));
        Assert.Equal(refused, Refused(await lab.Controller.GetTvShow(604)));
    }
}
