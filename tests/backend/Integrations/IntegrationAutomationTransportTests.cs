using Jellyfin.Plugin.JellyfinEnhanced;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using MediaBrowser.Controller;
using Microsoft.Extensions.DependencyInjection;
using Moq;

namespace JE.Tests;

/// <summary>
/// 4a review round 6 (D41): the guarantee for automatic writes is the transport check (AutomationTransportHandler). These
/// tests cover it directly: which clients carry it, that a person's own requests are never touched by it, the budget
/// recheck there (its own reservation counted once, released when refused) and the automation context's scope. The
/// per-site tables in IntegrationAutomationWriteGateTests flip every gate at the transport for every write site.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationAutomationTransportTests
{
    // The clients a Sonarr/Radarr or Seerr request leaves through. Every HttpClient the plugin gets is one of these, or is
    // named in NotChecked with the reason it can't carry an automatic request.
    private static readonly string[] Checked = { ArrHttp.ClientName, SeerrHttpHelper.NamedClient, string.Empty };

    private static readonly Dictionary<string, string> NotChecked = new(StringComparer.Ordinal)
    {
        [NotifyEndpoints.ClientName] = "notifications to people (ntfy, webhooks): never a request to Sonarr, Radarr or Seerr",
    };

    public static IEnumerable<object[]> Clients() => Checked.Select(c => new object[] { c });

    [Theory]
    [MemberData(nameof(Clients))]
    public void EveryArrSeerrAndFallbackClientCarriesTheTransportCheckOnce(string name)
    {
        var services = new ServiceCollection();
        services.AddLogging();
        new PluginServiceRegistrator().RegisterServices(services, Mock.Of<IServerApplicationHost>());
        using var provider = services.BuildServiceProvider();
        var handler = provider.GetRequiredService<IHttpMessageHandlerFactory>().CreateHandler(name);
        var checks = 0;
        while (handler is DelegatingHandler next)
        {
            if (handler is AutomationTransportHandler) checks++;
            handler = next.InnerHandler!;
        }
        Assert.Equal(1, checks);
    }

    // Every HttpClient in the plugin's source (by symbols) is a checked client, or listed as not carrying requests. A new
    // client, or one built by hand, fails here until it is registered with the check.
    [Fact]
    public void EveryHttpClientThePluginUsesIsACheckedClient()
    {
        var clients = WriteGateWalk.Plugin.HttpClients();
        Assert.Contains(clients, c => c.Name == ArrHttp.ClientName);
        Assert.Contains(clients, c => c.Name == SeerrHttpHelper.NamedClient);
        Assert.Contains(clients, c => c.Name == string.Empty);
        var unknown = clients.Where(c => c.Name == null || !(Checked.Contains(c.Name) || NotChecked.ContainsKey(c.Name))).Select(c => c.Where + " " + (c.Name ?? "(name not a constant)")).ToList();
        Assert.True(unknown.Count == 0, "HttpClients without the transport check: " + string.Join(", ", unknown));
    }

    // A person's own request is never an automatic write: every automation stop on (kill switches, the Shadow override,
    // budgets at 0, the old recipes off) and it still goes, unchecked. Also when the flow it runs in carried an
    // automatic scope (a person's job entering clears it).
    [Theory]
    [InlineData("direct", false)]
    [InlineData("seerr", false)]
    [InlineData("direct", true)]
    [InlineData("seerr", true)]
    public async Task APersonsOwnRequestStillSendsWithEveryAutomationStopOn(string backend, bool insideAutomation)
    {
        using var lab = backend == "direct" ? new IntegrationRequestBackendsTests.Lab() : null;
        using var seerr = backend == "seerr" ? new IntegrationRequestBackendsTests.SeerrLab() : null;
        using var e = new IntegrationAutomationTests.Engine();
        var arr = lab ?? seerr!.Arr;
        var instance = arr.Instance("Radarr").Id;
        e.C.ArrRequestBackend = backend == "direct" ? "je" : "seerr";
        e.C.JellyseerrEnabled = true;
        e.C.ArrAutomationKillAll = true;
        e.C.ArrAutomationShadowOverride = true;
        e.C.ArrAutomationHouseholdAddsPerDay = 0;
        e.C.ArrAutomationSearchesPerHour = 0;
        e.C.ArrAutomationSeerrPostsPerDay = 0;
        e.C.AutoMovieRequestEnabled = false;
        if (seerr != null)
        {
            seerr.Seerr.Users.Add(new System.Text.Json.Nodes.JsonObject { ["id"] = 9, ["jellyfinUserId"] = e.R.Admin.ToString("N"), ["permissions"] = 2 });
            e.R.Policy.Adjust = (_, _, facts) => facts with { SeerrSource = seerr.Source, SeerrUser = 9, BackendQuota = new QuotaProjection(0, null, null, null, 0) };
        }
        else
        {
            lab!.Radarr.Lookup.Add(IntegrationRequestBackendsTests.Lab.MovieLookup(961));
            e.R.Policy.Adjust = (_, _, facts) => facts with { InstanceId = instance, ConnectionGeneration = arr.Arr.Factory.ConnectionGeneration(instance)! };
        }
        var transport = seerr?.Seerr.Transport ?? arr.Arr.Transport;
        var asked = await e.R.Service.CreateAsync(e.R.Admin, new CreateRequest(Guid.NewGuid().ToString("N"), IntegrationRequestLedgerTests.Movie(seerr == null ? 961 : 22596)), default);
        Assert.NotNull(asked.RequestId);
        using (insideAutomation ? AutomationTransportContext.Enter(e.Guard.Gate, AutomationWrite.LegacySeerr(AutomationRecipes.AutoMovie, true)) : null)
            await e.Outbox(seerr?.Backend ?? (IRequestBackend)lab!.Direct).TickAsync(default);
        Assert.Equal("succeeded", e.R.Ledger.ForWant(asked.RequestId!).Single().State);
        Assert.NotEmpty(transport.Writes);
        Assert.All(transport.AutomationChecks, Assert.False);
        Assert.Equal(0, e.Count("SELECT count(*) FROM automation_budget"));
    }

    // 4a-security-r6-1: the limit as it is at the transport. Lowered to 0 there, the write doesn't go and its reservation
    // is released; left as it is, the write's own reservation counts once (a limit of 1 lets it go).
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task TheTransportCountsTheWritesOwnReservationOnceAndReleasesItWhenTheLiveLimitRefuses(bool lowered)
    {
        using var e = new IntegrationAutomationTests.Engine();
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto);
        e.C.ArrAutomationHouseholdAddsPerDay = 1;
        var asked = await e.Auto(e.R.Admin, IntegrationRequestLedgerTests.Movie(961));
        var want = e.R.Ledger.Find(asked.WantId!)!;
        var job = e.R.Ledger.ForWant(want.Id).Single();
        var admission = e.Guard.Admission(job, want)!;
        Assert.Null(admission.Admit(SendWriteKind.Add, "add"));
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response()));
        transport.BeforeGate = _ => { if (lowered) e.C.ArrAutomationHouseholdAddsPerDay = 0; };
        using var client = transport.CreateClient(ArrHttp.ClientName);
        using (AutomationTransportContext.Enter(e.Guard.Gate, AutomationWrite.ForJob(job, want, true), admission))
        {
            if (lowered)
            {
                var refused = await Assert.ThrowsAsync<AutomationTransportRefusedException>(() => client.PostAsync("http://radarr.test/api/v3/movie", new StringContent("{}")));
                Assert.Equal(AutomationHolds.BudgetExhausted, refused.Hold.Reason);
                Assert.Equal(0, transport.Calls);
                Assert.Equal(0, e.Budgets.Usage(BudgetCategories.HouseholdAdd, BudgetCategories.Household).Single().Used);
                Assert.Equal(1, e.Count("SELECT count(*) FROM automation_budget WHERE state='released'"));
            }
            else
            {
                using var response = await client.PostAsync("http://radarr.test/api/v3/movie", new StringContent("{}"));
                Assert.True(response.IsSuccessStatusCode);
                Assert.Equal(1, transport.Calls);
                admission.Settled(SendWriteKind.Add, "add", SendWriteResult.Sent);
                Assert.Equal(1, e.Budgets.Usage(BudgetCategories.HouseholdAdd, BudgetCategories.Household).Single().Used);
            }
        }
        Assert.Null(AutomationTransportContext.Current);
    }

    // 4a-security-r6-1, at the admission: it reads the limits once it has the database writer. Another writer holds it
    // (a save, a restore) while the limit is lowered to 0: the admission that waited for it refuses, and reserves nothing.
    [Fact]
    public async Task AnAdmissionWaitingForTheDatabaseWriterUsesTheLimitSavedMeanwhile()
    {
        using var e = new IntegrationAutomationTests.Engine();
        e.C.ArrAutomationHouseholdAddsPerDay = 5;
        using var holding = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        using var started = new ManualResetEventSlim();
        var writer = Task.Run(() => e.R.Db.Write((_, _) => { holding.Set(); release.Wait(TimeSpan.FromSeconds(10)); return 0; }));
        Assert.True(holding.Wait(TimeSpan.FromSeconds(5)));
        e.Budgets.BeforeAdmission = started.Set;
        var admission = Task.Run(() => e.Budgets.Admit(BudgetCategories.HouseholdAdd, BudgetCategories.Household, "job:waiting"));
        Assert.True(started.Wait(TimeSpan.FromSeconds(5)));
        await Task.Delay(200);
        Assert.False(admission.IsCompleted, "the admission waits for the writer");
        e.C.ArrAutomationHouseholdAddsPerDay = 0;
        release.Set();
        await writer;
        var admitted = await admission;
        Assert.Equal((false, "budget_exhausted"), (admitted.Admitted, admitted.Reason));
        Assert.Equal(0, e.Count("SELECT count(*) FROM automation_budget"));
    }

    // A later write of the same job replays its add (counted once per job). Refused at the transport, the row counted
    // when the add was sent stays counted: only what this attempt reserved is released.
    [Fact]
    public async Task RefusingAReplayedAddNeverReleasesTheEarlierSentAdmission()
    {
        using var e = new IntegrationAutomationTests.Engine();
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto);
        var asked = await e.Auto(e.R.Admin, IntegrationRequestLedgerTests.Movie(961));
        var want = e.R.Ledger.Find(asked.WantId!)!;
        var job = e.R.Ledger.ForWant(want.Id).Single();
        var admission = e.Guard.Admission(job, want)!;
        Assert.Null(admission.Admit(SendWriteKind.Add, "add"));
        admission.Settled(SendWriteKind.Add, "add", SendWriteResult.Sent);
        Assert.Null(admission.Admit(SendWriteKind.Add, "monitor"));
        e.C.ArrAutomationHouseholdAddsPerDay = 0;
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response()));
        using var client = transport.CreateClient(ArrHttp.ClientName);
        using (AutomationTransportContext.Enter(e.Guard.Gate, AutomationWrite.ForJob(job, want, true), admission))
            await Assert.ThrowsAsync<AutomationTransportRefusedException>(() => client.PutAsync("http://radarr.test/api/v3/movie/editor", new StringContent("{}")));
        Assert.Equal(0, transport.Calls);
        Assert.Equal(1, e.Count("SELECT count(*) FROM automation_budget WHERE state='consumed'"));
        Assert.Equal(0, e.Count("SELECT count(*) FROM automation_budget WHERE state='released'"));
    }

    // The context flows across awaits and threads, a nested scope restores its parent (refused, cancelled or not), reads
    // pass while a write is held, the synchronous Send is checked too, and outside any scope a write goes.
    [Fact]
    public async Task TheAutomationContextFlowsAcrossAwaitsAndRestoresWhatWasThere()
    {
        using var e = new IntegrationAutomationTests.Engine();
        e.C.ArrAutomationKillAll = true;
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto);
        var write = AutomationWrite.LegacySeerr(AutomationRecipes.AutoMovie, true);
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response()));
        using var client = transport.CreateClient(SeerrHttpHelper.NamedClient);
        Assert.Null(AutomationTransportContext.Current);
        using (var parent = AutomationTransportContext.Enter(e.Guard.Gate, write))
        {
            await Task.Yield();
            Assert.Same(parent, AutomationTransportContext.Current);
            await Task.Run(async () =>
            {
                Assert.Same(parent, AutomationTransportContext.Current);
                using (AutomationTransportContext.Enter(e.Guard.Gate, write))
                {
                    using var read = await client.GetAsync("http://seerr.test/api/v1/request");
                    Assert.True(read.IsSuccessStatusCode);
                    await Assert.ThrowsAsync<AutomationTransportRefusedException>(() => client.PostAsync("http://seerr.test/api/v1/request", null));
                    Assert.Throws<AutomationTransportRefusedException>(() => client.Send(new HttpRequestMessage(HttpMethod.Post, "http://seerr.test/api/v1/request")));
                }
                Assert.Same(parent, AutomationTransportContext.Current);
                try
                {
                    using var nested = AutomationTransportContext.Enter(e.Guard.Gate, write);
                    throw new OperationCanceledException();
                }
                catch (OperationCanceledException) { }
                Assert.Same(parent, AutomationTransportContext.Current);
                // A person's own work inside an automatic flow: no automation until it ends.
                using (AutomationTransportContext.Enter(e.Guard.Gate, null))
                {
                    Assert.Null(AutomationTransportContext.Current);
                    using var own = await client.PostAsync("http://seerr.test/api/v1/request", null);
                    Assert.True(own.IsSuccessStatusCode);
                }
                Assert.Same(parent, AutomationTransportContext.Current);
            });
            Assert.Same(parent, AutomationTransportContext.Current);
        }
        Assert.Null(AutomationTransportContext.Current);
        using var manual = await client.PostAsync("http://seerr.test/api/v1/request", null);
        Assert.True(manual.IsSuccessStatusCode);
        Assert.Equal(new[] { true, true, false, false }, transport.AutomationChecks);
    }
}
