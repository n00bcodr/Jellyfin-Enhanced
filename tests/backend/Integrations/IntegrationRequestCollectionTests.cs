using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests;

/// <summary>
/// Collection gaps ("You have 4 of 6. Get the 2 missing"): the collection must be visible to the
/// caller, owned movies are counted, movies Jellyfin hides from the caller are left out, missing
/// movies are filtered through the parental decision (unknown ratings refused), unreleased ones are
/// listed but marked, and the body names no instance, path or other person.
/// </summary>
public class IntegrationRequestCollectionTests
{
    private const int CollectionId = 10;

    /// <summary>A TMDB collection body: parts (id, title, release date, poster).</summary>
    private static string Tmdb(params (int Id, string Title, string? Date)[] parts)
        => JsonSerializer.Serialize(new
        {
            id = CollectionId,
            name = "The Collection",
            parts = parts.Select(p => new { id = p.Id, title = p.Title, release_date = p.Date ?? string.Empty, poster_path = "/p" + p.Id + ".jpg", adult = false }).ToArray(),
        });

    private static readonly string Six = Tmdb((1, "One", "1999-03-31"), (2, "Two", "2003-05-15"), (3, "Three", "2003-11-05"), (4, "Four", "2021-12-22"), (5, "Five", "2030-01-01"), (6, "Six", "2008-01-01"));

    private sealed class Setup : IDisposable
    {
        public IntegrationRequestLedgerTests.Rig Rig { get; } = new();
        public Guid BoxSet { get; } = Guid.NewGuid();
        public HashSet<Guid> SeesBoxSet { get; } = new();
        public int? TmdbCollection { get; set; } = CollectionId;
        public string? Body { get; set; } = Six;
        public Func<int, Guid, bool> MaySee { get; set; } = (_, _) => true;
        public List<int> ParentalAsked { get; } = new();
        public List<string?> Languages { get; } = new();

        public CollectionGapsService Service() => new(
            Rig.View,
            (viewer, id) => id == BoxSet && SeesBoxSet.Contains(viewer.UserId) ? new BoxSetRef(id, TmdbCollection) : null,
            Rig.Ledger,
            null,
            (id, language, _) => { Languages.Add(language); return Task.FromResult(id == CollectionId ? Body : null); },
            (tmdbId, user, _) => { lock (ParentalAsked) ParentalAsked.Add(tmdbId); return Task.FromResult(MaySee(tmdbId, user)); },
            () => Rig.Now);

        public AcquireCollectionsController Controller(ClaimsPrincipal principal, CollectionGapsService? service = null)
        {
            var controller = new AcquireCollectionsController(Rig.Service, service ?? Service()) { ControllerContext = new() { HttpContext = new DefaultHttpContext() } };
            controller.HttpContext.User = principal;
            return controller;
        }

        /// <summary>A Jellyfin copy of the movie, visible to everyone or (not visible) only to an unrelated user.</summary>
        public void Own(int tmdbId, bool visible = true)
            => Rig.View.AddCopy(TitleKey.Parse("movie:tmdb:" + tmdbId)!, new JfCopy { ItemId = Guid.NewGuid(), Path = "/movies/secret-" + tmdbId }, visible ? Array.Empty<Guid>() : new[] { Guid.NewGuid() });

        public void Dispose() => Rig.Dispose();
    }

    private static async Task<CollectionGaps> Gaps(Setup s, Guid user)
    {
        var viewer = s.Rig.View.Viewer(user)!;
        var (gaps, refusal) = await s.Service().ForCollectionAsync(viewer, s.BoxSet, "en", default);
        Assert.Null(refusal);
        return gaps!;
    }

    [Fact]
    public async Task OwnedMoviesAreCountedAndMissingOnesListedInReleaseOrderWithUnreleasedLast()
    {
        using var s = new Setup();
        s.SeesBoxSet.Add(s.Rig.Member);
        s.Own(1); s.Own(2); s.Own(3);
        var gaps = await Gaps(s, s.Rig.Member);
        Assert.Equal(3, gaps.Have);
        Assert.Equal(6, gaps.Total);
        Assert.Equal(new[] { "movie:tmdb:6", "movie:tmdb:4", "movie:tmdb:5" }, gaps.Missing.Select(m => m.Key));
        Assert.Equal(new[] { true, true, false }, gaps.Missing.Select(m => m.Released));
        var six = gaps.Missing[0];
        Assert.Equal(("Six", 2008, "/p6.jpg"), (six.Title, six.Year, six.Poster));
        Assert.All(gaps.Missing, m => Assert.Null(m.Request));
        Assert.Equal("en", Assert.Single(s.Languages));
    }

    [Fact]
    public async Task ACollectionTheCallerCantOpenIsNotFoundAndAnswersNothingAboutIt()
    {
        using var s = new Setup();
        s.SeesBoxSet.Add(s.Rig.Manager);
        var (gaps, refusal) = await s.Service().ForCollectionAsync(s.Rig.View.Viewer(s.Rig.Member)!, s.BoxSet, null, default);
        Assert.Null(gaps);
        Assert.Equal("not_found", refusal);
        Assert.Empty(s.Languages);      // no TMDB read for a collection the caller can't see

        var reply = await s.Controller(TestCallers.Principal(s.Rig.Member, false)).Collection(s.BoxSet.ToString("N"));
        var outcome = Assert.IsType<RequestOutcome>(Assert.IsType<ObjectResult>(reply).Value);
        Assert.Equal((404, "not_found"), (outcome.HttpStatus, outcome.Reason));
    }

    [Fact]
    public async Task MoviesJellyfinHidesFromTheCallerAreLeftOutNotOfferedAsMissing()
    {
        using var s = new Setup();
        s.SeesBoxSet.Add(s.Rig.Member);
        s.SeesBoxSet.Add(s.Rig.Admin);
        s.Own(1);
        s.Own(4, visible: false);                       // in a library the member can't open
        var gaps = await Gaps(s, s.Rig.Member);
        Assert.Equal(1, gaps.Have);
        Assert.DoesNotContain(gaps.Missing, m => m.Key == "movie:tmdb:4");
        Assert.Equal(5, gaps.Total);
    }

    [Fact]
    public async Task ParentalLimitsRefuseMissingMoviesWithUnknownOrTooHighRatings()
    {
        using var s = new Setup();
        s.SeesBoxSet.Add(s.Rig.Kid);
        s.Own(1);
        // 4 is rated within the limit; the others are unrated, too high or failed to look up.
        s.MaySee = (id, _) => id == 4 ? true : id == 6 ? throw new HttpRequestException("lookup failed") : false;
        var gaps = await Gaps(s, s.Rig.Kid);
        Assert.Equal(new[] { "movie:tmdb:4" }, gaps.Missing.Select(m => m.Key));
        Assert.Equal((1, 2), (gaps.Have, gaps.Total));
        // Only absent movies are checked (an owned copy is Jellyfin's own decision).
        Assert.DoesNotContain(1, s.ParentalAsked);
        Assert.Contains(5, s.ParentalAsked);
    }

    [Fact]
    public async Task NoTmdbKeyOrNoCollectionIdOrABrokenBodyIsCollectionUnknown()
    {
        using var s = new Setup();
        s.SeesBoxSet.Add(s.Rig.Member);
        var viewer = s.Rig.View.Viewer(s.Rig.Member)!;
        s.Body = null;                                   // no server TMDB key / TMDB failed
        Assert.Equal("collection_unknown", (await s.Service().ForCollectionAsync(viewer, s.BoxSet, null, default)).Refusal);
        s.Body = "{\"status_code\":34}";
        Assert.Equal("collection_unknown", (await s.Service().ForCollectionAsync(viewer, s.BoxSet, null, default)).Refusal);
        s.Body = "not json";
        Assert.Equal("collection_unknown", (await s.Service().ForCollectionAsync(viewer, s.BoxSet, null, default)).Refusal);
        s.Body = Six; s.TmdbCollection = null;
        Assert.Equal("collection_unknown", (await s.Service().ForCollectionAsync(viewer, s.BoxSet, null, default)).Refusal);

        var reply = await s.Controller(TestCallers.Principal(s.Rig.Member, false)).Collection(s.BoxSet.ToString("N"));
        var outcome = Assert.IsType<RequestOutcome>(Assert.IsType<ObjectResult>(reply).Value);
        Assert.Equal((404, "collection_unknown"), (outcome.HttpStatus, outcome.Reason));
    }

    [Fact]
    public async Task RequestStatesAreTheCallersOwnAndOnlyHouseholdForOtherPeople()
    {
        using var s = new Setup();
        s.SeesBoxSet.UnionWith(new[] { s.Rig.Member, s.Rig.Kid });
        Assert.Equal(201, (await s.Rig.Create(s.Rig.Kid, IntegrationRequestLedgerTests.Movie(4))).HttpStatus);      // waits for an OK
        Assert.Equal(201, (await s.Rig.Create(s.Rig.Member, IntegrationRequestLedgerTests.Movie(6))).HttpStatus);   // on its way
        Assert.Equal(201, (await s.Rig.Create(s.Rig.Admin, IntegrationRequestLedgerTests.Movie(2, "4k"))).HttpStatus);    // another edition

        var kid = await Gaps(s, s.Rig.Kid);
        Assert.Equal("waiting", kid.Missing.Single(m => m.Key == "movie:tmdb:4").Request);
        Assert.Equal("household", kid.Missing.Single(m => m.Key == "movie:tmdb:6").Request);
        var member = await Gaps(s, s.Rig.Member);
        Assert.Equal("asked", member.Missing.Single(m => m.Key == "movie:tmdb:6").Request);
        Assert.Equal("household", member.Missing.Single(m => m.Key == "movie:tmdb:4").Request);
        Assert.Null(member.Missing.Single(m => m.Key == "movie:tmdb:2").Request);
    }

    [Fact]
    public async Task AnOwnDeclinedMovieCanBeAskedForAgainOnceTheCooldownIsOver()
    {
        using var s = new Setup();
        s.SeesBoxSet.Add(s.Rig.Kid);
        var declined = await s.Rig.Create(s.Rig.Kid, IntegrationRequestLedgerTests.Movie(4));
        Assert.Equal(200, s.Rig.Service.Close(declined.RequestId!, s.Rig.Admin, "Not this time").HttpStatus);
        Assert.Equal("declined", (await Gaps(s, s.Rig.Kid)).Missing.Single(m => m.Key == "movie:tmdb:4").Request);

        s.Rig.Now = s.Rig.Now.AddDays(7);
        Assert.Null((await Gaps(s, s.Rig.Kid)).Missing.Single(m => m.Key == "movie:tmdb:4").Request);
        Assert.Equal(201, (await s.Rig.Create(s.Rig.Kid, IntegrationRequestLedgerTests.Movie(4))).HttpStatus);
    }

    [Fact]
    public async Task ApiKeysAndUnknownCallersAreRefusedBeforeAnythingIsRead()
    {
        using var s = new Setup();
        s.SeesBoxSet.Add(s.Rig.Member);
        foreach (var principal in new[] { TestCallers.ApiKey(), TestCallers.Unknown() })
        {
            var reply = await s.Controller(principal).Collection(s.BoxSet.ToString("N"));
            var outcome = Assert.IsType<RequestOutcome>(Assert.IsType<ObjectResult>(reply).Value);
            Assert.Equal((403, "user_required"), (outcome.HttpStatus, outcome.Reason));
        }
        Assert.Empty(s.Languages);
        var invalid = await s.Controller(TestCallers.Principal(s.Rig.Member, false)).Collection("not-a-guid");
        Assert.Equal(400, Assert.IsType<RequestOutcome>(Assert.IsType<ObjectResult>(invalid).Value).HttpStatus);
        var empty = await s.Controller(TestCallers.Principal(s.Rig.Member, false)).Collection(Guid.Empty.ToString("N"));
        Assert.Equal(400, Assert.IsType<RequestOutcome>(Assert.IsType<ObjectResult>(empty).Value).HttpStatus);
    }

    [Fact]
    public async Task TheFeatureOffRefusesAndWatchersMayStillSeeTheGaps()
    {
        using var s = new Setup();
        var watcher = s.Rig.Add("Watcher");
        s.SeesBoxSet.Add(watcher);
        var ok = await s.Controller(TestCallers.Principal(watcher, false)).Collection(s.BoxSet.ToString("N"));
        Assert.IsType<FileContentResult>(ok);
        s.Rig.Policy.Configuration.ArrPhase3Enabled = false;
        var off = await s.Controller(TestCallers.Principal(watcher, false)).Collection(s.BoxSet.ToString("N"));
        Assert.Equal((403, "feature_disabled"), Reason(off));
    }

    [Fact]
    public async Task TheBodyIsTheOutcomeShapeAndNamesNoInstancePathOrPerson()
    {
        using var s = new Setup();
        s.SeesBoxSet.Add(s.Rig.Member);
        s.Own(1); s.Own(2, visible: false);
        Assert.Equal(201, (await s.Rig.Create(s.Rig.Kid, IntegrationRequestLedgerTests.Movie(4))).HttpStatus);
        var controller = s.Controller(TestCallers.Principal(s.Rig.Member, false));
        var file = Assert.IsType<FileContentResult>(await controller.Collection(s.BoxSet.ToString("N"), "en"));
        Assert.Equal("private, no-cache", controller.Response.Headers["Cache-Control"].ToString());
        var text = Encoding.UTF8.GetString(file.FileContents);
        using var doc = JsonDocument.Parse(text);
        var root = doc.RootElement;
        Assert.Equal(("accepted", "collection", "Succeeded"), (root.GetProperty("outcome").GetString(), root.GetProperty("reason").GetString(), root.GetProperty("certainty").GetString()));
        Assert.True(root.TryGetProperty("message", out _));
        var collection = root.GetProperty("collection");
        Assert.Equal(1, collection.GetProperty("have").GetInt32());
        Assert.Equal(new[] { "key", "title", "year", "poster", "released", "request" }, collection.GetProperty("missing")[0].EnumerateObject().Select(p => p.Name));
        foreach (var word in new[] { "secret", "/movies", "instance", "Instance", "profile", "rootFolder", "path", "Path", s.Rig.Kid.ToString("N"), s.Rig.Kid.ToString() })
            Assert.DoesNotContain(word, text, StringComparison.Ordinal);

        // A repeat with the ETag is a 304; another caller's ETag is not theirs.
        var etag = controller.Response.Headers["ETag"].ToString();
        var again = s.Controller(TestCallers.Principal(s.Rig.Member, false));
        again.Request.Headers["If-None-Match"] = etag;
        Assert.Equal(304, Assert.IsType<StatusCodeResult>(await again.Collection(s.BoxSet.ToString("N"), "en")).StatusCode);
    }

    [Fact]
    public void TheTmdbParserDropsAdultDuplicateAndInvalidPartsAndCleansPosters()
    {
        var json = JsonSerializer.Serialize(new
        {
            parts = new object[]
            {
                new { id = 7, title = "Kept", release_date = "2001-01-01", poster_path = "/ok.jpg" },
                new { id = 7, title = "Duplicate", release_date = "2001-01-01", poster_path = "/ok.jpg" },
                new { id = 8, title = "Adult", release_date = "2001-01-01", poster_path = "/a.jpg", adult = true },
                new { id = -1, title = "Bad id", release_date = "2001-01-01", poster_path = "/b.jpg" },
                new { id = 9, title = "Evil poster", release_date = "bad", poster_path = "javascript:alert(1)" },
                new { id = 10, title = "", release_date = "2001-01-01", poster_path = "/c.jpg" },
            },
        });
        var parts = CollectionGapsService.ParseCollection(json, new DateOnly(2026, 10, 14))!;
        Assert.Equal(new[] { "movie:tmdb:7", "movie:tmdb:9" }, parts.Select(p => p.Key));
        Assert.Null(parts[1].Poster);
        Assert.False(parts[1].Released);
        Assert.Null(parts[1].Year);
        var many = JsonSerializer.Serialize(new { parts = Enumerable.Range(1, 100).Select(i => new { id = i, title = "T" + i, release_date = "2001-01-01" }) });
        Assert.Equal(CollectionGapsService.MaxParts, CollectionGapsService.ParseCollection(many, new DateOnly(2026, 10, 14))!.Count);
        Assert.Null(CollectionGapsService.ParseCollection("[]", new DateOnly(2026, 10, 14)));
    }

    private static (int, string) Reason(IActionResult result)
    {
        var outcome = Assert.IsType<RequestOutcome>(Assert.IsType<ObjectResult>(result).Value);
        return (outcome.HttpStatus, outcome.Reason);
    }
}
