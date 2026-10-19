using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using MediaBrowser.Controller.Library;
using Moq;

namespace JE.Tests;

/// <summary>
/// The Seerr scan nudge owner (C60): nudges for one Seerr and job coalesce into one run whose wait is
/// capped at min(4 x debounce, 1 hour) from the first change; a running scan gets one follow-up instead of
/// an aborting /run; a batch goes to the first address that answers; in JE request mode a confirmed add
/// nudges Seerr's Radarr/Sonarr scan.
/// </summary>
public class IntegrationScanNudgeTests
{
    private sealed class Rig : IDisposable
    {
        public FakeSeerr Seerr { get; } = new();
        public DateTimeOffset Now { get; set; } = new(2026, 10, 14, 12, 0, 0, TimeSpan.Zero);
        public PluginConfiguration Config { get; } = new()
        {
            JellyseerrEnabled = true, JellyseerrUrls = FakeSeerr.Url + "\nhttp://seerr-failover.lan:5055", JellyseerrApiKey = FakeSeerr.Key,
            TriggerSeerrScanOnItemAdded = true, SeerrScanDebounceSeconds = 60,
        };
        public RequestOutboxEvents Events { get; } = new();
        public SeerrScanTriggerService Service { get; }
        private readonly IntegrationEnvironment _env = new();
        public Rig()
        {
            Service = new SeerrScanTriggerService(Mock.Of<ILibraryManager>(), Seerr.Transport, _env.Logger, Events, () => Now, () => Config);
            Service.Initialize();
            Seerr.Jobs = Jobs(false);
        }
        public static JsonArray Jobs(bool running, string id = SeerrScanTriggerService.ScanJobId)
            => new(new JsonObject { ["id"] = id, ["name"] = "scan", ["running"] = running }, new JsonObject { ["id"] = "other", ["running"] = !running });
        public List<string> Runs() { lock (Seerr.Writes) return Seerr.Writes.ToList(); }
        public void Dispose() { Service.Dispose(); Seerr.Dispose(); _env.Dispose(); }
    }

    [Fact]
    public async Task NudgesCoalesceIntoOneRunPerSeerrAndJobAndTheWaitIsCappedFromTheFirstChange()
    {
        using var r = new Rig();
        r.Service.Nudge(SeerrScanTriggerService.ScanJobId);
        Assert.Equal(TimeSpan.FromSeconds(240), r.Service.DueIn(SeerrScanTriggerService.ScanJobId));   // 4 x 60 s
        r.Now = r.Now.AddSeconds(200);
        for (var i = 0; i < 50; i++) r.Service.Nudge(SeerrScanTriggerService.ScanJobId);              // a steady trickle can't postpone it
        Assert.Equal(TimeSpan.FromSeconds(40), r.Service.DueIn(SeerrScanTriggerService.ScanJobId));
        await r.Service.FireAsync(SeerrScanTriggerService.ScanJobId);
        Assert.Equal(new[] { "POST /api/v1/settings/jobs/jellyfin-recently-added-scan/run" }, r.Runs());   // one run, first address only
        Assert.Null(r.Service.DueIn(SeerrScanTriggerService.ScanJobId));
        Assert.Equal(2, r.Seerr.CallCount("/api/v1/settings/jobs"));                // the running check, then the run

        // A long debounce is capped at an hour from the first change.
        r.Config.SeerrScanDebounceSeconds = 3600;
        r.Service.Nudge(SeerrScanTriggerService.ScanJobId);
        Assert.Equal(TimeSpan.FromHours(1), r.Service.DueIn(SeerrScanTriggerService.ScanJobId));
    }

    [Fact]
    public async Task ARunningScanGetsOneFollowUpInsteadOfAnAbortingRun()
    {
        using var r = new Rig();
        r.Seerr.Jobs = Rig.Jobs(true);
        r.Service.Nudge(SeerrScanTriggerService.ScanJobId);
        r.Service.Nudge(SeerrScanTriggerService.ScanJobId);
        await r.Service.FireAsync(SeerrScanTriggerService.ScanJobId);
        Assert.Empty(r.Runs());                                                       // never /run over a running scan
        Assert.NotNull(r.Service.DueIn(SeerrScanTriggerService.ScanJobId));           // the batch waits for one follow-up
        r.Seerr.Jobs = Rig.Jobs(false);
        await r.Service.FireAsync(SeerrScanTriggerService.ScanJobId);
        Assert.Single(r.Runs());
    }

    [Fact]
    public async Task AnUnreadableJobListStillRunsTheScanAsBefore()
    {
        using var r = new Rig();
        r.Seerr.Jobs = null;   // an older Seerr without the job list: 404
        r.Service.Nudge(SeerrScanTriggerService.ScanJobId);
        await r.Service.FireAsync(SeerrScanTriggerService.ScanJobId);
        Assert.Single(r.Runs());
    }

    [Theory]
    [InlineData("je", "movie:tmdb:603", "POST /api/v1/settings/jobs/radarr-scan/run")]
    [InlineData("je", "tv:tvdb:78874", "POST /api/v1/settings/jobs/sonarr-scan/run")]
    [InlineData("seerr", "movie:tmdb:603", null)]
    public async Task InJeModeAConfirmedAddNudgesSeerrsArrScan(string backend, string key, string? expected)
    {
        using var r = new Rig();
        r.Config.ArrIntegrationEnabled = true; r.Config.ArrPhase1Enabled = true; r.Config.ArrPhase3Enabled = true; r.Config.ArrRequestBackend = backend;
        var job = new RequestJob("j1", "w1", new MutationInput { Key = key, Scope = key.StartsWith("movie", StringComparison.Ordinal) ? "movie" : "seasons", Seasons = key.StartsWith("tv", StringComparison.Ordinal) ? new[] { 1 } : Array.Empty<int>() },
            new RequestAuthorization(Guid.NewGuid(), null, "request", "movie", "standard", backend, "r1", "g1", "p"), "succeeded", 1, r.Now, "looking", "request:j1", "f");
        r.Events.RaiseConfirmed(job);
        var jobId = key.StartsWith("movie", StringComparison.Ordinal) ? SeerrScanTriggerService.RadarrScanJobId : SeerrScanTriggerService.SonarrScanJobId;
        if (expected == null) { Assert.Null(r.Service.DueIn(jobId)); return; }
        r.Seerr.Jobs = Rig.Jobs(false, jobId);
        await r.Service.FireAsync(jobId);
        Assert.Equal(new[] { expected }, r.Runs());
    }

    [Fact]
    public void ADisabledSwitchOrNoSeerrMeansNoNudge()
    {
        using var r = new Rig();
        r.Config.JellyseerrEnabled = false;
        r.Service.Nudge(SeerrScanTriggerService.ScanJobId);
        Assert.Null(r.Service.DueIn(SeerrScanTriggerService.ScanJobId));
        Assert.Empty(r.Seerr.Calls);
    }
}
