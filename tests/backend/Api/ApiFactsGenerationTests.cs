using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class ApiFactsGenerationTests
{
    [Fact]
    public async Task LegacySelectorSaveRetiresCachesWithoutDrainingItsOwnAdmittedVersionZeroSend()
    {
        using var fixture = new ApiPluginFixture();
        fixture.Plugin.Configuration.ArrRequestBackend = "je";
        fixture.Plugin.Configuration.ArrBackendIsolationVersion = 0;
        _ = EffectiveRequestsBackend.Shared.Current;
        var generation = UserCacheRegistry.FactsGeneration;
        var cache = new RegisteredCache<string, SeerrFacts.Derived<int>>();
        var effect = SeerrFacts.BeginEffect();
        var value = SeerrFacts.ReadSeerrCached(() => 42, 0);
        cache.Set("old", cache.Begin(), SeerrFacts.Remember(value));
        var save = Task.Run(() => fixture.Plugin.PatchConfiguration(new Jellyfin.Plugin.JellyfinEnhanced.Configuration.ConfigurationPatch
        {
            Set = new() { ["ArrRequestBackend"] = System.Text.Json.JsonSerializer.SerializeToElement("seerr") }
        }));
        try
        {
            await save.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.False(effect.Token.IsCancellationRequested);
            Assert.Equal(generation + 1, UserCacheRegistry.FactsGeneration);
            Assert.False(cache.TryGetValue("old", out _));
            Assert.Equal(0, cache.Count);
            Assert.Equal(value, effect.Publish(() => value)); // the retained legacy send, never an old cache hit
        }
        finally
        {
            effect.Dispose();
            await save.WaitAsync(TimeSpan.FromSeconds(10));
        }
    }

    [Theory]
    [InlineData(false)][InlineData(true)]
    public async Task MigrationCommitAndRollbackShareTheBackendWriterDrain(bool rollback)
    {
        using var fixture = new ApiPluginFixture();
        using var rig = new IntegrationRequestLedgerTests.Rig();
        using var fake = new FakeSeerr();
        var config = fixture.Plugin.Configuration;
        config.ArrRequestBackend = "seerr"; config.ArrBackendIsolationVersion = 0;
        config.ArrIntegrationEnabled = config.ArrPhase1Enabled = config.ArrPhase3Enabled = true;
        config.JellyseerrEnabled = true; config.JellyseerrUrls = FakeSeerr.Url; config.JellyseerrApiKey = FakeSeerr.Key;
        fake.MainSettings = new System.Text.Json.Nodes.JsonObject { ["defaultPermissions"] = 0 };
        fake.Requests.Add(FakeSeerr.Request(1, "movie", 603, 1, rig.Member, rig.Now.UtcDateTime));
        using var reader = new SeerrFacts(fake.Transport);
        var migration = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.SeerrMigration(reader,
            rig.Ledger, rig.Policy, rig.View, null, rig.Feed, () => fixture.Plugin.Configuration,
            () => fixture.Plugin.SaveConfiguration(), () => rig.Now);
        var preview = await migration.PreviewAsync(default);
        Assert.True(preview.Complete);
        string? batch = null;
        if (rollback)
        {
            var imported = await migration.CommitAsync(rig.Admin, preview.Digest, false, default);
            Assert.Equal(200, imported.HttpStatus); batch = imported.BatchId;
            Assert.NotNull(batch);
        }
        _ = EffectiveRequestsBackend.Shared.Current;
        var generation = UserCacheRegistry.FactsGeneration;
        var lease = EffectiveRequestsBackend.Shared.AdmitFacts(generation, default);
        try
        {
            var write = Task.Run(async () =>
            {
                var controller = ApiAssetTests.Controller(fixture.Core);
                var method = typeof(Jellyfin.Plugin.JellyfinEnhanced.Controllers.AcquireMigrationController)
                    .GetMethod(rollback ? "Rollback" : "Commit")!;
                var descriptor = new Microsoft.AspNetCore.Mvc.Controllers.ControllerActionDescriptor { MethodInfo = method };
                var context = new Microsoft.AspNetCore.Mvc.Filters.ActionExecutingContext(new(controller.HttpContext,
                    new Microsoft.AspNetCore.Routing.RouteData(), descriptor), [], new Dictionary<string, object?>(), controller);
                Microsoft.AspNetCore.Mvc.Filters.ActionExecutedContext? executed = null;
                await new SeerrIsolationActionFilter(EffectiveRequestsBackend.Shared, fixture.Core.Logger)
                    .OnActionExecutionAsync(context, async () =>
                    {
                        var committed = rollback ? migration.Rollback(batch)
                            : await migration.CommitAsync(rig.Admin, preview.Digest, false, default);
                        return executed = new(context, [], controller)
                        {
                            Result = new Microsoft.AspNetCore.Mvc.ObjectResult(committed) { StatusCode = committed.HttpStatus }
                        };
                    });
                var response = Assert.IsType<Microsoft.AspNetCore.Mvc.ObjectResult>(executed?.Result ?? context.Result);
                Assert.Equal(200, response.StatusCode);
                return Assert.IsType<Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.SeerrMigrationReply>(response.Value);
            });
            var until = DateTime.UtcNow.AddSeconds(10);
            while (!lease.Token.IsCancellationRequested && DateTime.UtcNow < until) await Task.Delay(10);
            Assert.True(lease.Token.IsCancellationRequested);
            Assert.False(write.IsCompleted);
            var unlocked = await Task.Run(() =>
            {
                if (!Monitor.TryEnter(Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced.AnalyticsCredentialLock, TimeSpan.FromSeconds(2))) return false;
                Monitor.Exit(Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced.AnalyticsCredentialLock); return true;
            });
            Assert.True(unlocked);
            lease.Dispose();
            var result = await write.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.Equal(200, result.HttpStatus);
            Assert.Equal(rollback ? "seerr" : "je", fixture.Plugin.Configuration.ArrRequestBackend);
            Assert.Equal(generation + 1, UserCacheRegistry.FactsGeneration);
        }
        finally { lease.Dispose(); }
        Assert.Empty(fake.Writes);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    public void UnrelatedNativeSaveKeepsAnAdmittedEffectAndFactsGeneration(int version)
    {
        using var fixture = new ApiPluginFixture();
        fixture.Plugin.Configuration.ArrRequestBackend = "je";
        fixture.Plugin.Configuration.ArrBackendIsolationVersion = version;
        _ = EffectiveRequestsBackend.Shared.Current;
        var generation = UserCacheRegistry.FactsGeneration;
        using var lease = EffectiveRequestsBackend.Shared.AdmitFacts(generation, default);
        fixture.Plugin.PatchConfiguration(new Jellyfin.Plugin.JellyfinEnhanced.Configuration.ConfigurationPatch
        {
            Set = new() { ["ToastDuration"] = System.Text.Json.JsonSerializer.SerializeToElement(1700) }
        });
        Assert.False(lease.Token.IsCancellationRequested);
        Assert.Equal(generation, UserCacheRegistry.FactsGeneration);
        Assert.Equal(1700, fixture.Plugin.Configuration.ToastDuration);
    }

    [Theory]
    [InlineData("patch")]
    [InlineData("native")]
    [InlineData("restore")]
    public async Task RealConfigurationWritersDrainBeforeTakingTheConfigurationLockAndAdvanceTheGeneration(string writer)
    {
        using var fixture = new ApiPluginFixture();
        var config = fixture.Plugin.Configuration;
        config.ArrRequestBackend = "je"; config.ArrBackendIsolationVersion = 0;
        _ = EffectiveRequestsBackend.Shared.Current;
        var generation = UserCacheRegistry.FactsGeneration;
        var lease = EffectiveRequestsBackend.Shared.AdmitFacts(generation, default);
        try
        {
            var save = Task.Run(() =>
            {
                if (writer == "patch") fixture.Plugin.PatchConfiguration(new Jellyfin.Plugin.JellyfinEnhanced.Configuration.ConfigurationPatch
                {
                    Set = new() { ["ArrBackendIsolationVersion"] = System.Text.Json.JsonSerializer.SerializeToElement(1) }
                });
                else
                {
                    var next = Jellyfin.Plugin.JellyfinEnhanced.Configuration.ConfigurationPatcher.Clone(config);
                    next.ArrBackendIsolationVersion = 1;
                    if (writer == "native") fixture.Plugin.UpdateConfiguration(next);
                    else fixture.Plugin.RestoreConfiguration(next, Array.Empty<string>());
                }
            });
            var until = DateTime.UtcNow.AddSeconds(10);
            while (!lease.Token.IsCancellationRequested && DateTime.UtcNow < until) await Task.Delay(10);
            Assert.True(lease.Token.IsCancellationRequested);
            Assert.False(save.IsCompleted);
            // Old effects may need this lock in order to finish; a writer must not hold it while draining.
            var unlocked = await Task.Run(() =>
            {
                if (!Monitor.TryEnter(Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced.AnalyticsCredentialLock, TimeSpan.FromSeconds(2))) return false;
                Monitor.Exit(Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced.AnalyticsCredentialLock);
                return true;
            });
            Assert.True(unlocked);
            lease.Dispose();
            await save.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.Equal(generation + 1, UserCacheRegistry.FactsGeneration);
            Assert.Equal(1, fixture.Plugin.Configuration.ArrBackendIsolationVersion);
        }
        finally { lease.Dispose(); }
    }

    [Fact]
    public async Task PreparedUnderNIsNotServedUnderNPlusOneAndLateStoreCannotRestampIt()
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab();
        lab.Config.ArrRequestBackend = "je";
        lab.Config.ArrBackendIsolationVersion = 0;
        _ = EffectiveRequestsBackend.Shared.Current;
        var cache = new RegisteredCache<string, int>();
        var ticket = cache.Begin();
        cache.Set("warm", ticket, 42);
        Assert.True(cache.TryGetValue("warm", out _));
        await EffectiveRequestsBackend.Shared.TransitionAsync(() => lab.Config.ArrBackendIsolationVersion = 1, default);
        Assert.Equal(ticket.Generation + 1, UserCacheRegistry.FactsGeneration);
        Assert.False(cache.TryGetValue("warm", out _));
        Assert.Equal(0, cache.Count); // physically evicted, not just hidden by enumeration
        cache.Set("late", ticket, 43);
        Assert.False(cache.TryGetValue("late", out _));
        Assert.Equal(0, cache.Count);
    }

    [Fact]
    public async Task SeerrFreePublicTmdbByIdResponseSurvivesAdoption()
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab();
        lab.Config.ArrRequestBackend = "je"; lab.Config.ArrBackendIsolationVersion = 0;
        var calls = 0;
        using var transport = new IntegrationTransport((_, _) =>
        {
            Interlocked.Increment(ref calls);
            return Task.FromResult(IntegrationTransport.Response("{\"id\":603,\"title\":\"The Matrix\"}"));
        });
        using var cache = new Jellyfin.Plugin.JellyfinEnhanced.Services.TmdbResponseCache(transport, TimeProvider.System);
        var before = await cache.GetAsync("movie/603", "", "test-tmdb", default);
        await EffectiveRequestsBackend.Shared.TransitionAsync(() => lab.Config.ArrBackendIsolationVersion = 1, default);
        var after = await cache.GetAsync("movie/603", "", "test-tmdb", default);
        Assert.True(before.IsSuccess); Assert.Equal(before.Content, after.Content); Assert.Equal(1, calls);
    }

    [Fact]
    public async Task RegistryRefusesWarmFactsWhileTheAtomicWriterHasSwitchedChoiceButNotReturned()
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab();
        lab.Config.ArrRequestBackend = "je"; lab.Config.ArrBackendIsolationVersion = 0;
        var cache = new RegisteredCache<string, int>();
        cache.Set("warm", cache.Begin(), 603);
        using var release = new ManualResetEventSlim();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var transition = Task.Run(() => EffectiveRequestsBackend.Shared.TransitionAsync(() =>
        {
            lab.Config.ArrBackendIsolationVersion = 1;
            entered.TrySetResult();
            if (!release.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException("writer release");
        }, default));
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.False(cache.TryGetValue("warm", out _));
            Assert.Equal(0, cache.Count);
        }
        finally { release.Set(); }
        await transition.WaitAsync(TimeSpan.FromSeconds(5));
    }

    [Fact]
    public async Task WarmPlainCacheLookupEnlistsOriginalGenerationInFinalPublication()
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab();
        lab.Config.ArrRequestBackend = "je"; lab.Config.ArrBackendIsolationVersion = 0;
        var cache = new RegisteredCache<string, int>();
        cache.Set("warm", cache.Begin(), 603);
        using var answer = SeerrFacts.BeginPublication();
        Assert.True(cache.TryGetValue("warm", out var identity));
        await EffectiveRequestsBackend.Shared.TransitionAsync(() => lab.Config.ArrBackendIsolationVersion = 1, default);
        Assert.Throws<BackendDisabledException>(() => answer.Publish(() => identity));
    }

    [Fact]
    public async Task WarmDerivedCacheEffectRetainsTheSameTransitionOwnerWithSubmissionsOff()
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab();
        lab.Config.ArrRequestBackend = "je"; lab.Config.ArrBackendIsolationVersion = 0; lab.Config.ArrPhase3Enabled = false;
        Assert.False(EffectiveRequestsBackend.Shared.Current.RequestsEnabled);
        var cache = new RegisteredCache<string, SeerrFacts.Derived<int>>();
        using (SeerrFacts.BeginPublication())
        {
            var input = SeerrFacts.ReadSeerrCached(() => 42, 0);
            cache.Set("local", cache.Begin(), SeerrFacts.Remember(input));
        }
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var effect = Task.Run(async () =>
        {
            using var answer = SeerrFacts.BeginEffect();
            Assert.True(cache.TryGetValue("local", out _));
            entered.SetResult();
            await release.Task;
            Assert.True(answer.Token.IsCancellationRequested);
        });
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var committed = false;
        var transition = EffectiveRequestsBackend.Shared.TransitionAsync(() => { committed = true; lab.Config.ArrRequestBackend = "seerr"; }, default);
        Assert.False(committed);
        release.SetResult();
        await Task.WhenAll(effect, transition).WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(committed);
    }

    [Fact]
    public async Task FailedOrCancelledTransitionDoesNotAdvanceGeneration()
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab();
        _ = EffectiveRequestsBackend.Shared.Current;
        var before = UserCacheRegistry.FactsGeneration;
        await Assert.ThrowsAsync<InvalidOperationException>(() => EffectiveRequestsBackend.Shared.TransitionAsync(() => throw new InvalidOperationException(), default));
        Assert.Equal(before, UserCacheRegistry.FactsGeneration);
        using var cancel = new CancellationTokenSource(); cancel.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => EffectiveRequestsBackend.Shared.TransitionAsync(() => { }, cancel.Token));
        Assert.Equal(before, UserCacheRegistry.FactsGeneration);
    }

    [Fact]
    public void TaintModeRejectsPlainScalarTransformationButAcceptsItsProvenanceEnvelope()
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab();
        lab.Config.ArrRequestBackend = "je";
        lab.Config.ArrBackendIsolationVersion = 0;
        var prior = UserCacheRegistry.TaintMode;
        UserCacheRegistry.TaintMode = true;
        try
        {
            using var operation = SeerrFacts.BeginPublication();
            var value = SeerrFacts.ReadSeerrCached(() => 603, 0);
            var plain = new RegisteredCache<string, int>();
            var error = Assert.Throws<InvalidOperationException>(() => plain.Set("identity", plain.Begin(), value + 1));
            Assert.Contains("plain cache store", error.Message);
            Assert.Equal(0, plain.Count);
            var derived = new RegisteredCache<string, SeerrFacts.Derived<int>>();
            var handout = SeerrFacts.Remember(value + 1);
            Assert.True(handout.Tainted);
            derived.Set("identity", derived.Begin(), handout);
            Assert.True(derived.TryGetValue("identity", out var held));
            Assert.Equal(604, held.Publish());
        }
        finally { UserCacheRegistry.TaintMode = prior; }
    }
}

public class SeerrFreeProducerProofTests
{
    private static class Source { internal static int Read() => 603; }
    private static IEnumerable<int> IteratorEscape() { yield return Source.Read(); }
    private static async Task<int> AsyncEscape() { await Task.Yield(); return Source.Read(); }
    private static async IAsyncEnumerable<int> AsyncIteratorEscape() { await Task.Yield(); yield return Source.Read(); }
    private static IEnumerable<int> SafeEnumerable() { yield return 603; }
    [Fact]
    public void ProducerProofFollowsActualIteratorAndAsyncBodiesAndAllowsIndependentEnumerable()
    {
        var type = typeof(SeerrFreeProducerProofTests);
        var iterator = type.GetMethod(nameof(IteratorEscape), SeerrFreeProducerProof.Declared)!;
        var async = type.GetMethod(nameof(AsyncEscape), SeerrFreeProducerProof.Declared)!;
        var asyncIterator = type.GetMethod(nameof(AsyncIteratorEscape), SeerrFreeProducerProof.Declared)!;
        var safe = type.GetMethod(nameof(SafeEnumerable), SeerrFreeProducerProof.Declared)!;
        // This fixture's Forbidden method is the stand-in fact source, not a production type rename.
        Assert.NotEmpty(SeerrFreeProducerProof.Violations([iterator], t => t == typeof(Source)));
        Assert.NotEmpty(SeerrFreeProducerProof.Violations([async], t => t == typeof(Source)));
        Assert.NotEmpty(SeerrFreeProducerProof.Violations([asyncIterator], t => t == typeof(Source)));
        Assert.Empty(SeerrFreeProducerProof.Violations([safe], t => t == typeof(Source)));
    }
}
