using System.Text.Json;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Globalization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

/// <summary>Requests → Audit names titles only as the calling administrator's own request cards may show them.</summary>
[Collection("Plugin singleton")]
public class IntegrationAuditTitleVisibilityTests
{
    // UX6R-1 (review of 65da24e93): the Audit tab's names map named a title through TMDB for an administrator whose parental
    // limit hides it from their own request cards. Ported from the review probe; "prepared": whether the rating evidence was
    // read before the Audit tab was opened (unread evidence is read for it, never guessed).
    [Theory]
    [InlineData("G", true, true)]
    [InlineData("R", false, true)]
    [InlineData("G", true, false)]
    [InlineData("R", false, false)]
    public async Task AuditNamesOnlyTitlesTheCallingAdministratorsRequestCardsMayShow(string rating, bool visible, bool prepared)
    {
        using var arr = new FakeArr();
        arr.Add("movies.invalid", "Radarr");
        arr.Configure(("Movies", ArrKind.Radarr, "http://movies.invalid", "test-key"));
        var config = arr.Plugin.Plugin.Configuration;
        config.ArrIntegrationEnabled = true;
        config.ArrPhase1Enabled = true;
        config.ArrPhase3Enabled = true;
        config.ArrRequestBackend = "seerr";
        config.JellyseerrEnabled = true;
        config.JellyseerrUrls = "http://seerr.invalid";
        config.JellyseerrApiKey = "test-seerr";
        var view = new FakeJellyfinView();
        var viewer = view.AddUser(true, parental: true);
        var user = (User)viewer.Handle!;
        user.SetPermission(PermissionKind.IsAdministrator, true);
        user.MaxParentalRatingScore = 10;
        var access = new FakeLibraryAccess();
        var unrelated = access.AddLibrary("Unrelated", "movies", "/other");
        user.SetPreference(PreferenceKind.BlockedMediaFolders, new[] { unrelated.Id });
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(viewer.UserId)).Returns(user);
        var localization = new Mock<ILocalizationManager>();
        localization.Setup(l => l.GetRatingScore("G", "US")).Returns(new MediaBrowser.Model.Entities.ParentalRatingScore(1, null));
        localization.Setup(l => l.GetRatingScore("R", "US")).Returns(new MediaBrowser.Model.Entities.ParentalRatingScore(18, null));
        var server = new Mock<IServerConfigurationManager>();
        server.SetupGet(s => s.Configuration).Returns(new ServerConfiguration { MetadataCountryCode = "US" });
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response(JsonSerializer.Serialize(new
        {
            releases = new { results = new[] { new { iso_3166_1 = "US", release_dates = new[] { new { type = 3, certification = rating } } } } },
            keywords = new { keywords = Array.Empty<object>() }, genres = Array.Empty<object>()
        }))));
        var parental = new SeerrParentalFilter(transport, users.Object, localization.Object, server.Object, arr.Plugin.Core.Logger);
        using var store = arr.Store();
        var aliases = new TitleAliases(store, null);
        var policy = new RequestPolicy(view, store, new ArrInstanceLibraries(store, access), aliases, parental, arr.Factory, new UnavailableRequestBackend());
        var input = new MutationInput { Key = "movie:tmdb:603", SeerrServerId = 1, SeerrRootFolder = "/kids", SeerrProfileId = 6, SeerrOptions = "unknown" };
        if (prepared)
        {
            await policy.PrepareVisibilityAsync(viewer.UserId, input, default);
            Assert.Equal(visible, policy.Evaluate(viewer.UserId, input).Visible);
        }
        using var database = new AcquireDatabase(Path.Combine(arr.Plugin.Core.Root, "ux6r.db"));
        var ledger = new RequestLedger(database);
        var service = new RequestService(ledger, policy, view, new ArrChangeFeed(), () => arr.Now);
        var projection = new RequestHubProjection(service, new IntegrationRequestHouseholdTests.FakeDirectory(), aliases,
            (_, _, _) => Task.FromResult<HubTitleMeta?>(new HubTitleMeta { Title = "Restricted title", Year = 1999 }), () => arr.Now);
        var audit = new ArrAuditLog(Path.Combine(arr.Plugin.Core.Root, "ux6r-audit.jsonl"), 100000, 1);
        audit.Append(new ArrAuditEntry { Target = input.Key, Action = "request.dispatch", UserId = viewer.UserId.ToString("N"), Outcome = "succeeded", Time = arr.Now });
        var controller = new ArrAdminController(arr.Factory, audit, users.Object, arr.Plugin.Core.Logger, ledger, projection)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() }
        };
        controller.HttpContext.User = TestCallers.Principal(viewer.UserId, true);
        var result = Assert.IsAssignableFrom<OkObjectResult>(await controller.GetAudit());
        using var answer = JsonDocument.Parse(JsonSerializer.Serialize(result.Value));
        var titles = answer.RootElement.GetProperty("names").GetProperty("titles");
        Assert.Equal(visible, titles.TryGetProperty(input.Key, out _));
        // The row itself keeps its stored key either way.
        Assert.Equal(input.Key, answer.RootElement.GetProperty("entries")[0].GetProperty("target").GetString());
        if (!prepared) Assert.Equal(visible, policy.Evaluate(viewer.UserId, input).Visible);
    }
}
