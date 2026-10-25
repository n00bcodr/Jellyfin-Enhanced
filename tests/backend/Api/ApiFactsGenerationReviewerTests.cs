using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using MediaBrowser.Model.Globalization;
using Moq;
namespace JE.Tests;

[Collection("Plugin singleton")]
public class ApiFactsGenerationReviewerTests
{
    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task HouseholdFactsMustNotKeepASeerrOnlyIdentityAfterAdoption(bool delayed, bool adopt)
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab();
        var config = lab.Config;
        config.ArrRequestBackend = "je"; config.ArrBackendIsolationVersion = 0;
        config.JellyseerrEnabled = true; config.JellyseerrUrls = FakeSeerr.Url; config.JellyseerrApiKey = FakeSeerr.Key;
        config.TMDB_API_KEY = "review-fake-tmdb";
        lab.Radarr.Movies.Clear(); lab.Radarr.Queue.Clear();
        var request = FakeSeerr.Request(1, "movie", 603, 2, lab.Emma.UserId, lab.Arr.Now.UtcDateTime);
        request["media"]!["imdbId"] = "tt0133093"; lab.Seerr.Requests.Add(request);
        using var facts = new SeerrFacts(lab.Seerr.Transport, lab.Feed, lab.Arr.Plugin.Core.Logger, new RequestOutboxEvents());
        Assert.True(await facts.RefreshAsync(default));
        var aliases = new TitleAliases(lab.Store, facts);
        var title = TitleKey.Parse("movie:imdb:tt0133093")!;
        Assert.Contains(aliases.Of(title), k => k.ToString() == "movie:tmdb:603");
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var transport = new IntegrationTransport(async (request, ct) =>
        {
            // A fake-only terminal. No find response supplies the identity mapping.
            Assert.Contains("/movie/603", request.RequestUri!.AbsolutePath);
            entered.TrySetResult();
            if (delayed) await release.Task.WaitAsync(ct);
            return IntegrationTransport.Response("{\"id\":603,\"original_language\":\"en\",\"genres\":[{\"id\":28}],\"release_dates\":{\"results\":[]},\"watch/providers\":{\"results\":{}}}");
        });
        using var tmdb = new TmdbResponseCache(transport, TimeProvider.System);
        var rules = new HouseholdRuleFacts(tmdb, aliases, Mock.Of<ILocalizationManager>());
        Task prepare;
        // Same ordinary composed-read owner used by read-only callers; no synthetic retaining effect.
        using (var publication = SeerrFacts.BeginPublication())
        {
            prepare = rules.PrepareAsync(title, default);
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            if (!delayed) await prepare;
            if (adopt) await EffectiveRequestsBackend.Shared.TransitionAsync(() => config.ArrBackendIsolationVersion = 1, default).WaitAsync(TimeSpan.FromSeconds(5));
            release.TrySetResult();
            await prepare.WaitAsync(TimeSpan.FromSeconds(5));
        }
        if (adopt)
        {
            Assert.Empty(facts.All);
            Assert.DoesNotContain(aliases.Of(title), k => k.ToString() == "movie:tmdb:603");
            using var fresh = SeerrFacts.BeginPublication();
            var answer = fresh.Publish(() => rules.Peek(title));
            Assert.Null(answer);
        }
        else Assert.Equal(603, rules.Peek(title)?.TmdbId);
    }
    [Theory]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task HouseholdPolicyMustNotUseASeerrOnlyIdentityAfterAdoption(bool delayed, bool adopt)
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab();
        var config = lab.Config;
        config.ArrRequestBackend = "je"; config.ArrBackendIsolationVersion = 0;
        config.JellyseerrEnabled = true; config.JellyseerrUrls = FakeSeerr.Url; config.JellyseerrApiKey = FakeSeerr.Key;
        config.TMDB_API_KEY = "review-fake-tmdb";
        lab.Radarr.Movies.Clear(); lab.Radarr.Queue.Clear();
        var request = FakeSeerr.Request(1, "movie", 603, 2, lab.Emma.UserId, lab.Arr.Now.UtcDateTime);
        request["media"]!["imdbId"] = "tt0133093"; lab.Seerr.Requests.Add(request);
        using var facts = new SeerrFacts(lab.Seerr.Transport, lab.Feed, lab.Arr.Plugin.Core.Logger, new RequestOutboxEvents());
        Assert.True(await facts.RefreshAsync(default));
        var aliases = new TitleAliases(lab.Store, facts);
        var title = TitleKey.Parse("movie:imdb:tt0133093")!;
        Assert.Contains(aliases.Of(title), k => k.ToString() == "movie:tmdb:603");
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var transport = new IntegrationTransport(async (request, ct) =>
        {
            // A fake-only terminal. No find response supplies the identity mapping.
            Assert.Contains("/movie/603", request.RequestUri!.AbsolutePath);
            entered.TrySetResult();
            if (delayed) await release.Task.WaitAsync(ct);
            return IntegrationTransport.Response("{\"id\":603,\"original_language\":\"en\",\"genres\":[{\"id\":28}],\"release_dates\":{\"results\":[]},\"watch/providers\":{\"results\":{}}}");
        });
        using var tmdb = new TmdbResponseCache(transport, TimeProvider.System);
        var rules = new HouseholdRuleFacts(tmdb, aliases, Mock.Of<ILocalizationManager>());
        Task prepare;
        // Same ordinary composed-read owner used by read-only callers; no synthetic retaining effect.
        using (var publication = SeerrFacts.BeginPublication())
        {
            prepare = rules.PrepareAsync(title, default);
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            if (!delayed) await prepare;
            if (adopt) await EffectiveRequestsBackend.Shared.TransitionAsync(() => config.ArrBackendIsolationVersion = 1, default).WaitAsync(TimeSpan.FromSeconds(5));
            release.TrySetResult();
            await prepare.WaitAsync(TimeSpan.FromSeconds(5));
        }
        if (adopt)
        {
            Assert.Empty(facts.All);
            Assert.DoesNotContain(aliases.Of(title), k => k.ToString() == "movie:tmdb:603");
            using var fresh = SeerrFacts.BeginPublication();
            var answer = fresh.Publish(() => rules.Peek(title));
            config.ArrPhase4Enabled = config.ArrPhase4HouseholdRulesEnabled = true;
            config.ArrRequestDefaultRole = "Member";
            config.ArrHouseholdRules = "{\"roles\":{\"member\":{\"genre\":{\"ids\":[28],\"match\":\"deny\",\"otherwise\":\"approve\"}}}}";
            var policy = new RequestPolicy(lab.View, lab.Store, new ArrInstanceLibraries(lab.Store, new FakeLibraryAccess()),
                aliases, null!, lab.Arr.Factory, new UnavailableRequestBackend(), rules);
            var decision = fresh.Publish(() => policy.Evaluate(lab.Emma.UserId, new MutationInput { Key = title.ToString(), Scope = "movie" }));
            Assert.Equal("review", decision.Rules?.Verdict);
            Assert.Null(answer);
        }
        else Assert.Equal(603, rules.Peek(title)?.TmdbId);
    }
}
