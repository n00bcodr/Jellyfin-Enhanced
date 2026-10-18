using System.Net;
using System.Security.Claims;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using static JE.Tests.ListsHarness;

namespace JE.Tests;

// Phase 4c3a: the Playlists page summaries (POST acquire/lists/summaries). Which of the lists on screen have entries the
// caller can see that aren't in the library, through the list gate: hidden entries are never counted and a list with no
// entry the caller can see is left out (never answered with 0), the D29 switches and preferences turn it off, a slow
// parental check answers "pending" within the budget, and the route refuses API keys / unknown people (D19) and bad input.
[Collection("Plugin singleton")]
public class ListsSummaryTests
{
    private static readonly CancellationToken None = CancellationToken.None;

    private sealed class PagePreferences : IListPagePreferences
    {
        public Dictionary<Guid, (bool? Placeholders, bool? PlaylistUi, bool? CollectionUi)> ByUser { get; } = new();

        public (bool? Placeholders, bool? PlaylistUi, bool? CollectionUi) PagesFor(Guid user) =>
            ByUser.TryGetValue(user, out var preferences) ? preferences : (null, null, null);
    }

    private static ListsHarness Harness(bool seerr = true)
    {
        var h = new ListsHarness(seerr);
        var config = h.Plugin.Plugin.Configuration;
        config.ArrPhase4ListPlaylistUiEnabled = true;
        config.ArrPhase4ListCollectionUiEnabled = true;
        return h;
    }

    private static async Task Add(ListsHarness h, FakeListHost.FakeList list, User editor, params Placeholder[] entries)
    {
        var result = Ok<ApplyResultDto>(await h.Service.AddPlaceholdersAsync(h.AccessFor(list, editor), entries, null, null, null, None));
        Assert.Equal(entries.Length, result.Added.Count);
    }

    private static Dictionary<string, int> Missing(ListSummariesDto summaries) => summaries.Lists.ToDictionary(s => s.ListId, s => s.Missing);

    private static string N(Guid id) => id.ToString("N");

    [Fact]
    public async Task OnlyEntriesTheCallerMaySeeAreCountedAndListsWithNoneAreLeftOut()
    {
        using var h = Harness();
        h.MovieCertifications[1] = "G";
        h.MovieCertifications[2] = "R";
        var owner = h.NewUser("owner");
        var adult = h.NewUser("adult");
        var kid = h.NewUser("kid", maxRating: 10);
        var mixed = h.Host.AddPlaylist(owner, openAccess: true);
        var onlyRated = h.Host.AddPlaylist(owner, openAccess: true);
        var noEntries = h.Host.AddPlaylist(owner, openAccess: true);
        var hidden = h.Host.AddPlaylist(owner); // private: the others can't see it
        await Add(h, mixed, owner, Movie(1), Movie(2), Movie(3)); // G, R, unverifiable
        await Add(h, onlyRated, owner, Movie(2));
        await Add(h, hidden, owner, Movie(1));
        var service = new ListSummaryService(h.Store, h.Access, h.Plugin.Core.Logger, new PagePreferences());
        var ids = new[] { mixed.Info.Id, onlyRated.Info.Id, noEntries.Info.Id, hidden.Info.Id };

        var forAdult = Missing(await service.SummariesAsync(adult, ids, None));
        var forKid = Missing(await service.SummariesAsync(kid, ids, None));
        var forOwner = Missing(await service.SummariesAsync(owner, ids, None));

        Assert.Equal(new Dictionary<string, int> { [N(mixed.Info.Id)] = 3, [N(onlyRated.Info.Id)] = 1 }, forAdult);
        // The kid sees only the G title; a list whose every entry is hidden from them isn't listed at all.
        Assert.Equal(new Dictionary<string, int> { [N(mixed.Info.Id)] = 1 }, forKid);
        Assert.Equal(new Dictionary<string, int> { [N(mixed.Info.Id)] = 3, [N(onlyRated.Info.Id)] = 1, [N(hidden.Info.Id)] = 1 }, forOwner);
        Assert.All((await service.SummariesAsync(kid, ids, None)).Lists, s => Assert.True(s.Missing > 0));
    }

    [Fact]
    public async Task TheAnswerIsTheCallersAccessWhenItIsMadeNotWhenItWasAsked()
    {
        using var h = Harness();
        h.MovieCertifications[1] = "G";
        h.MovieCertifications[4] = "G";
        var owner = h.NewUser("owner");
        var kid = h.NewUser("kid", maxRating: 10);
        var kept = h.Host.AddPlaylist(owner, false, new ListShare(kid.Id, false));
        var revoked = h.Host.AddPlaylist(owner, false, new ListShare(kid.Id, false));
        await Add(h, kept, owner, Movie(1));
        await Add(h, revoked, owner, Movie(4));
        // The share of one list is removed while the kid's parental lookup of its entry is out (after the first access
        // read, before the answer): the gate reads access again right before the answer, and that list is left out.
        h.ReplyAsync = (request, _) =>
        {
            if (request.RequestUri!.AbsolutePath.Contains("/4", StringComparison.Ordinal))
            {
                revoked.Info = revoked.Info with { Shares = Array.Empty<ListShare>() };
            }

            return Task.FromResult(h.Reply(request));
        };
        var service = new ListSummaryService(h.Store, h.Access, h.Plugin.Core.Logger, new PagePreferences());

        var summaries = await service.SummariesAsync(kid, new[] { kept.Info.Id, revoked.Info.Id }, None);

        Assert.Equal(new[] { N(kept.Info.Id) }, summaries.Lists.Select(s => s.ListId));
        Assert.Empty(revoked.Info.Shares);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CompletedSummariesAreRevalidatedAfterTheOtherListsFinish(bool parental)
    {
        using var h = Harness();
        h.MovieCertifications[1] = "PG";
        h.MovieCertifications[4] = "G";
        var owner = h.NewUser("owner");
        var kid = h.NewUser("kid", maxRating: 10);
        var first = h.Host.AddPlaylist(owner, false, new ListShare(kid.Id, false));
        var second = h.Host.AddPlaylist(owner, false, new ListShare(kid.Id, false));
        await Add(h, first, owner, Movie(1));
        await Add(h, second, owner, Movie(4));
        // First projects synchronously after warming its ratings cache. Second changes access before the batch ends.
        var service = new ListSummaryService(h.Store, h.Access, h.Plugin.Core.Logger, new PagePreferences());
        Assert.Single((await service.SummariesAsync(kid, new[] { first.Info.Id }, None)).Lists);
        h.ReplyAsync = (request, _) =>
        {
            if (request.RequestUri!.AbsolutePath.Contains("/4", StringComparison.Ordinal))
            {
                if (parental) kid.MaxParentalRatingScore = 0;
                else first.Info = first.Info with { Shares = Array.Empty<ListShare>() };
            }
            return Task.FromResult(h.Reply(request));
        };
        var answer = await service.SummariesAsync(kid, new[] { first.Info.Id, second.Info.Id }, None);
        Assert.DoesNotContain(answer.Lists, s => s.ListId == N(first.Info.Id));
        Assert.Contains(answer.Lists, s => s.ListId == N(second.Info.Id));
    }

    [Fact]
    public async Task TheSwitchesAndEachPersonsPreferencesTurnItOff()
    {
        using var h = Harness();
        var owner = h.NewUser("owner", admin: true);
        var viewer = h.NewUser("viewer");
        var playlist = h.Host.AddPlaylist(owner, openAccess: true);
        var collection = h.Host.AddCollection();
        await Add(h, playlist, owner, Movie(1));
        await Add(h, collection, owner, Movie(2));
        var preferences = new PagePreferences();
        var service = new ListSummaryService(h.Store, h.Access, h.Plugin.Core.Logger, preferences);
        var ids = new[] { playlist.Info.Id, collection.Info.Id };
        var config = h.Plugin.Plugin.Configuration;

        Assert.Equal(2, (await service.SummariesAsync(viewer, ids, None)).Lists.Count);

        config.ArrPhase4ListCollectionUiEnabled = false;
        Assert.Equal(new[] { N(playlist.Info.Id) }, (await service.SummariesAsync(viewer, ids, None)).Lists.Select(s => s.ListId));
        config.ArrPhase4ListCollectionUiEnabled = true;

        config.ArrPhase4ListPlaylistUiEnabled = false;
        Assert.Equal(new[] { N(collection.Info.Id) }, (await service.SummariesAsync(viewer, ids, None)).Lists.Select(s => s.ListId));
        config.ArrPhase4ListPlaylistUiEnabled = true;

        // Hidden for one person (null follows the administrator; false hides), the other still gets it.
        preferences.ByUser[viewer.Id] = (null, false, null);
        Assert.Equal(new[] { N(collection.Info.Id) }, (await service.SummariesAsync(viewer, ids, None)).Lists.Select(s => s.ListId));
        Assert.Equal(2, (await service.SummariesAsync(owner, ids, None)).Lists.Count);
        preferences.ByUser[viewer.Id] = (false, null, null); // "titles not in the library" hidden altogether
        Assert.Empty((await service.SummariesAsync(viewer, ids, None)).Lists);
        preferences.ByUser[viewer.Id] = (null, null, false);
        Assert.Equal(new[] { N(playlist.Info.Id) }, (await service.SummariesAsync(viewer, ids, None)).Lists.Select(s => s.ListId));

        config.ArrPhase4ListPlaceholdersEnabled = false;
        Assert.Empty((await service.SummariesAsync(owner, ids, None)).Lists);
    }

    [Fact]
    public async Task ASlowParentalCheckAnswersPendingWithinTheBudgetAndFailsClosed()
    {
        using var h = Harness();
        h.MovieCertifications[1] = "G";
        var owner = h.NewUser("owner");
        var kid = h.NewUser("kid", maxRating: 10);
        var list = h.Host.AddPlaylist(owner, openAccess: true);
        await Add(h, list, owner, Movie(1));
        var slow = new TaskCompletionSource();
        h.ReplyAsync = async (request, ct) =>
        {
            await slow.Task.WaitAsync(ct);
            return h.Reply(request);
        };
        var service = new ListSummaryService(h.Store, h.Access, h.Plugin.Core.Logger, new PagePreferences()) { Budget = TimeSpan.FromMilliseconds(300) };

        var started = DateTime.UtcNow;
        var summaries = await service.SummariesAsync(kid, new[] { list.Info.Id }, None);

        Assert.True(DateTime.UtcNow - started < TimeSpan.FromSeconds(5));
        Assert.Empty(summaries.Lists);
        Assert.Equal(new[] { N(list.Info.Id) }, summaries.Pending);
        slow.SetResult();
        h.ReplyAsync = null;
        Assert.Equal(1, (await service.SummariesAsync(kid, new[] { list.Info.Id }, None)).Lists.Single().Missing);
    }

    [Fact]
    public async Task OneCallAnswers170ListsAndNoMoreThanTheCap()
    {
        using var h = Harness(seerr: false);
        var owner = h.NewUser("owner");
        var viewer = h.NewUser("viewer");
        var ids = new List<Guid>();
        for (var i = 0; i < 210; i++)
        {
            var list = h.Host.AddPlaylist(owner, openAccess: true);
            ids.Add(list.Info.Id);
            if (i < 170 ? i % 2 == 0 : true)
            {
                await Add(h, list, owner, Movie(1000 + i));
            }
        }

        var service = new ListSummaryService(h.Store, h.Access, h.Plugin.Core.Logger, new PagePreferences());
        var first = ids.Take(170).ToList();
        var summaries = await service.SummariesAsync(viewer, first, None);

        Assert.Equal(85, summaries.Lists.Count);
        Assert.Empty(summaries.Pending);
        Assert.Equal(first.Where((_, i) => i % 2 == 0).Select(N), summaries.Lists.Select(s => s.ListId));
        // More than the cap: only the first MaxIds are looked at (the client batches; the route refuses more).
        var all = await service.SummariesAsync(viewer, ids, None);
        Assert.Equal(85 + (ListSummaryService.MaxIds - 170), all.Lists.Count);
        Assert.DoesNotContain(N(ids[^1]), all.Lists.Select(s => s.ListId));
    }

    // ── The route ───────────────────────────────────────────────────────────

    private sealed class HeaderAuthentication(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder)
        : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
    {
        protected override Task<AuthenticateResult> HandleAuthenticateAsync()
        {
            var user = Request.Headers["X-Test-User"].ToString();
            if (user.Length == 0)
            {
                return Task.FromResult(AuthenticateResult.NoResult());
            }

            var identity = new ClaimsIdentity(new[] { new Claim("Jellyfin-UserId", user), new Claim(ClaimTypes.Role, "User") }, Scheme.Name);
            return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(identity), Scheme.Name)));
        }
    }

    private sealed class Activator(Func<ControllerBase> create) : IControllerActivator
    {
        public object Create(ControllerContext context)
        {
            var controller = create();
            controller.ControllerContext = context;
            return controller;
        }

        public void Release(ControllerContext context, object controller) { }
    }

    private static IHost Server(ListsHarness h, ListSummaryService? summaries) =>
        new HostBuilder().ConfigureWebHost(web => web.UseTestServer().ConfigureServices(services =>
        {
            services.AddLogging();
            services.AddRouting();
            services.AddAuthentication("test").AddScheme<AuthenticationSchemeOptions, HeaderAuthentication>("test", _ => { });
            services.AddAuthorization();
            services.AddControllers().AddApplicationPart(typeof(AcquireListsController).Assembly);
            services.AddSingleton<IControllerActivator>(new Activator(() => new AcquireListsController(h.Users.Object, h.Access, h.Service, h.Plugin.Core.Logger, summaries: summaries)));
        }).Configure(app =>
        {
            app.UseRouting();
            app.UseAuthentication();
            app.UseAuthorization();
            app.UseEndpoints(e => e.MapControllers());
        })).Start();

    private static async Task<(HttpStatusCode Status, JsonElement Body, string? CacheControl)> Post(IHost server, Guid? user, string body)
    {
        var client = server.GetTestServer().CreateClient();
        if (user != null)
        {
            client.DefaultRequestHeaders.Add("X-Test-User", user.Value.ToString());
        }

        var response = await client.PostAsync("/JellyfinEnhanced/acquire/lists/summaries", new StringContent(body, Encoding.UTF8, "application/json"));
        var text = await response.Content.ReadAsStringAsync();
        return (response.StatusCode, text.Length == 0 ? default : JsonDocument.Parse(text).RootElement, response.Headers.CacheControl?.ToString());
    }

    [Fact]
    public async Task TheRouteRefusesStrangersAndBadInputAndAnswersPrivately()
    {
        using var h = Harness();
        var owner = h.NewUser("owner");
        var viewer = h.NewUser("viewer");
        var list = h.Host.AddPlaylist(owner, openAccess: true);
        await Add(h, list, owner, Movie(1));
        var service = new ListSummaryService(h.Store, h.Access, h.Plugin.Core.Logger, new PagePreferences());
        using var server = Server(h, service);
        var ids = $"{{\"listIds\":[\"{N(list.Info.Id)}\"]}}";

        Assert.Equal(HttpStatusCode.Unauthorized, (await Post(server, null, ids)).Status);
        var ghost = await Post(server, Guid.NewGuid(), ids); // an API key / unknown person (D19)
        Assert.Equal(HttpStatusCode.Forbidden, ghost.Status);
        Assert.Equal("user_required", ghost.Body.GetProperty("code").GetString());
        Assert.Equal(HttpStatusCode.BadRequest, (await Post(server, viewer.Id, "{\"listIds\":[]}")).Status);
        Assert.Equal(HttpStatusCode.BadRequest, (await Post(server, viewer.Id, "{\"listIds\":[\"nope\"]}")).Status);
        Assert.Equal(HttpStatusCode.BadRequest, (await Post(server, viewer.Id, "{\"listIds\":[" + string.Join(',', Enumerable.Range(0, 201).Select(_ => $"\"{N(Guid.NewGuid())}\"")) + "]}")).Status);

        var ok = await Post(server, viewer.Id, ids);
        Assert.Equal(HttpStatusCode.OK, ok.Status);
        Assert.Contains("no-store", ok.CacheControl);
        var entry = ok.Body.GetProperty("lists").EnumerateArray().Single();
        Assert.Equal(N(list.Info.Id), entry.GetProperty("listId").GetString());
        Assert.Equal("playlist", entry.GetProperty("listKind").GetString());
        Assert.Equal(1, entry.GetProperty("missing").GetInt32());
        Assert.Equal(0, ok.Body.GetProperty("pending").GetArrayLength());

        h.Plugin.Plugin.Configuration.ArrPhase4ListPlaceholdersEnabled = false;
        var off = await Post(server, viewer.Id, ids);
        Assert.Equal(HttpStatusCode.NotFound, off.Status);
        Assert.Equal("disabled", off.Body.GetProperty("code").GetString());
    }

    [Fact]
    public void ThePublicConfigAndPreferencesFollowTheSwitches()
    {
        using var h = Harness();
        var config = h.Plugin.Plugin.Configuration;
        Assert.True(ListFlags.PlaylistUi(config));
        Assert.True(ListFlags.CollectionUi(config));
        config.ArrPhase4ListPlaceholdersEnabled = false;
        Assert.False(ListFlags.PlaylistUi(config));
        Assert.False(ListFlags.CollectionUi(config));
        // Off by default.
        var fresh = new Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration();
        Assert.False(fresh.ArrPhase4ListPlaylistUiEnabled);
        Assert.False(fresh.ArrPhase4ListCollectionUiEnabled);
        var settings = new Jellyfin.Plugin.JellyfinEnhanced.Configuration.UserSettings();
        Assert.Null(settings.ListPlaylistUi);
        Assert.Null(settings.ListCollectionUi);
    }
}
