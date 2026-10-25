using System.Reflection;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Ready;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Stamps;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Routing;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class ApiSeerrFactConsumersTests
{
    public static IEnumerable<object[]> Consumers => new[] { "aliases", "ledger", "shared-title", "shared-user", "ready-own", "ready-audience", "stamps", "notify-follows", "dispatcher", "hub", "manage", "admin", "status", "snapshot", "state", "parts" }
        .SelectMany(name => new[] { new object[] { name, 0 }, new object[] { name, 1 } });

    [Theory]
    [MemberData(nameof(Consumers))]
    public async Task ActualConsumerFactsCannotEscapeInAnAnswerAfterAdoption(string consumer, int version)
    {
        using var r = new IntegrationNotificationsTests.Rig();
        var c = r.Config;
        c.ArrRequestBackend = "seerr"; c.ArrBackendIsolationVersion = version;
        c.ArrPhase3Enabled = c.ArrRequestsHubEnabled = true;
        r.Request(1, 693134, r.Emma, status: SeerrRequestStatus.Pending);
        r.Seerr.Requests[0]["media"]!["imdbId"] = "tt15239678";
        Assert.True(await r.Requests.RefreshAsync(default));
        var title = TitleKey.Parse("movie:tmdb:693134")!;
        var aliases = new TitleAliases(r.Store, r.Requests);
        var ledger = new RequestLedger(r.Db);
        var shared = new SharedRequestFacts(ledger, r.Requests, aliases);
        var ready = new ReadyInterestSource(ledger, r.Requests, r.NotifyStore, aliases, () => c);
        var stamps = new StampInterests(ledger, r.Requests, r.NotifyStore, aliases);
        var facts = new LedgerRequestFacts(ledger, r.Requests, aliases);
        var hub = new RequestsHubService(r.Status, r.Requests, () => c);
        var audit = new ArrAuditLog(r.Arr.Plugin.Core.Paths.Object, r.Arr.Plugin.Core.Logger);
        var manage = new ArrManageService(r.Status, r.Arr.Factory, new ArrActionRunner(audit, new ArrConfirmationTokens()), audit, r.Requests, null, r.Feed, () => c, null);
        r.Prefs(r.Emma, p => p.AutoFollowRequests = true);
        var source = r.Requests.Source!;
        var context = new ActionExecutingContext(new(new DefaultHttpContext(), new RouteData(), new ControllerActionDescriptor
        { ControllerTypeInfo = typeof(JellyfinEnhancedController).GetTypeInfo(), MethodInfo = typeof(JellyfinEnhancedController).GetMethod("GetDownloadQueue")! }), [], new Dictionary<string, object?>(), new object());
        var filter = new SeerrIsolationActionFilter(EffectiveRequestsBackend.Shared, r.Arr.Plugin.Core.Logger);
        ActionExecutedContext? executed = null;
        await filter.OnActionExecutionAsync(context, async () =>
        {
            // Run the real consumer, then retain its derived answer across a later await. The same
            // global publication owner used by MVC must protect every consumer, not a route allowlist.
            object? value = consumer switch
            {
                "aliases" => aliases.Of(title),
                "ledger" => facts.For(title, r.Emma),
                "shared-title" => shared.For(c, title),
                "shared-user" => shared.ForUser(c, r.Emma.UserId),
                "ready-own" => ready.For(r.Emma.UserId),
                "ready-audience" => ready.Interested([title]),
                "stamps" => stamps.For([title]),
                "notify-follows" => r.Service.FollowsOf(r.Emma.UserId).Requested,
                "dispatcher" => typeof(NotifyDispatcher).GetMethod("Request", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(r.Dispatcher,
                    [new NotifyAlert(r.Admin.UserId, NotifyKind.Approval, title.ToString(), null, "approval|" + source[..8] + "|1", new Dictionary<string, string>())]),
                "hub" => await hub.ForViewerAsync(r.Emma, default),
                "manage" => await manage.OverviewAsync(r.Admin, title, null, default),
                "admin" => await r.Hub.SystemAsync(default),
                "status" => await r.Status.ForBatchAsync(r.Emma, [], [title], default),
                "snapshot" => r.Requests.Current,
                "state" => r.Requests.State,
                "parts" => r.Requests.ForPart(title, false, [], [], r.Emma),
                _ => throw new ArgumentOutOfRangeException(nameof(consumer)),
            };
            Assert.NotNull(value);
            // A barrier after consumption matters: checking only inner reads cannot own this result.
            await EffectiveRequestsBackend.Shared.TransitionAsync(() => { c.ArrBackendIsolationVersion = 1; c.ArrRequestBackend = "je"; JellyfinEnhancedController.ClearAllSeerrCachesOnConfigChange(); }, default);
            return executed = new(context, [], context.Controller) { Result = new OkObjectResult(new { consumer, value }) };
        });
        Assert.Equal(409, Assert.IsType<ObjectResult>(executed!.Result).StatusCode);
        Assert.DoesNotContain("tt15239678", JsonSerializer.Serialize(((ObjectResult)executed.Result).Value));
    }
}
