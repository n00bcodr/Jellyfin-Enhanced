#if JF12
// Partial of ApiNativeDetailsTests, whose rig and the native-details pages it drives are Jellyfin 12 only (the plugin
// compiles them under JF12), like the rest of that class.
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;

namespace JE.Tests;

public partial class ApiNativeDetailsTests
{
    public static IEnumerable<object[]> ExpiredEvidencePaths()
    {
        foreach (var path in new[] { "movie", "series", "season", "person", "filmography", "collection", "related",
                     "native-discover", "raw-search", "raw-collection", "list-metadata", "people-batch", "absent", "list-access" })
        foreach (var held in new[] { 0, 8 }) yield return new object[] { path, held };
    }

    [Theory]
    [MemberData(nameof(ExpiredEvidencePaths))]
    public async Task ExpiredEvidenceCannotCreateColdOwnersOrReportCapacityPressure(string path, int held)
    {
        await using var rig = new AdmissionRig();
        var viewer = rig.Rig.Person(linked: false);
        viewer.MaxParentalRatingScore = 16;
        var config = rig.Rig.Plugin.Plugin.Configuration;
        config.ArrPhase4Enabled = config.ArrPhase4ListPlaceholdersEnabled = true;
        var release = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        var ratingRelease = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        rig.Rig.RatingGate = ratingRelease;
        var creations = 0;
        using var observation = MetadataTaskProbe.Observe(e => { if (e.Kind == "created") Interlocked.Increment(ref creations); });
        using var scope = ViewerMetadataAdmission.ForViewer(viewer.Id);
        var owners = Enumerable.Range(0, held).Select(i => rig.Admission.Read("joinfix-held:" + i, viewer.Id,
            () => (false, 0), () => release.Task, -1, default)).ToArray();
        using var expired = new CancellationTokenSource();
        expired.Cancel();
        var ct = expired.Token;
        try
        {
            // These are the actual four shared-admission callers, including list continuations,
            // native public-details/feed readers, optional person batches and nullable evidence.
            // A completed cache hit is intentionally outside this cold-read contract.
            var error = await Record.ExceptionAsync(async () =>
            {
                switch (path)
                {
                    case "movie": await rig.Source.MovieAsync(991001, viewer.Id, ct); break;
                    case "series": await rig.Source.SeriesAsync(991001, viewer.Id, ct); break;
                    case "season": await rig.Source.SeasonAsync(991001, 1, viewer.Id, ct); break;
                    case "person": await rig.Source.PersonAsync(991001, viewer.Id, ct); break;
                    case "filmography": await rig.Source.PersonCreditsAsync(991001, viewer.Id, ct); break;
                    case "collection": await rig.Source.CollectionAsync(991001, viewer.Id, ct); break;
                    case "related": await rig.Source.RelatedAsync(true, 991001, "recommendations", 1, viewer.Id, ct); break;
                    case "native-discover": await rig.Source.DiscoverAsync(true, "genre", 18, 1, null, viewer.Id, ct); break;
                    case "raw-search": await rig.Cache.GetAsync("search/multi", "?query=joinfix", "test-tmdb", ct); break;
                    case "raw-collection": await rig.Cache.GetAsync("collection/991001", "", "test-tmdb", ct); break;
                    case "people-batch": await rig.Cache.GetPeopleAsync(new[] { 991001 }, "test-tmdb", viewer.Id, ct); break;
                    case "list-metadata":
                        Assert.True(TmdbListMetadataSource.IsAvailable);
                        await new TmdbListMetadataSource(rig.Cache, rig.Rig.Plugin.Core.Logger).FetchAsync(
                            new Placeholder { Kind = PlaceholderKinds.Movie, TmdbId = 991001 }, TimeSpan.Zero, DateTime.UtcNow.Date, ct);
                        break;
                    case "absent": await rig.Rig.Parental.CheckAbsentAsync("movie", 991001, viewer.Id.ToString("N"), ct); break;
                    case "list-access":
                        await new ListAccessService(new FakeListHost(), rig.Rig.Callers.Users.Object, rig.Rig.Parental, rig.Rig.Plugin.Core.Logger)
                            .CheckTitleAsync("movie", 991001, viewer.Id.ToString("N"), ct);
                        break;
                }
            });
            Assert.False(scope.Refused);
            Assert.Equal(held, creations);
            Assert.Equal(held, rig.Admission.Count());
            Assert.IsAssignableFrom<OperationCanceledException>(error);
            Assert.Null(rig.Rig.Parental.AbsentVerdict("movie", 991001, viewer.Id.ToString("N")));
            Assert.All(owners, owner => Assert.False(owner.IsCompleted));
        }
        finally
        {
            release.TrySetResult(1);
            ratingRelease.TrySetResult();
            rig.Release();
            await Task.WhenAll(owners).WaitAsync(TimeSpan.FromSeconds(15));
        }
    }

    [Theory]
    [InlineData(0)]
    [InlineData(8)]
    public async Task EvidenceCancellationDuringCacheCheckPrecedesColdAdmission(int held)
    {
        var admission = new ViewerMetadataAdmission();
        var viewer = Guid.NewGuid();
        using var scope = ViewerMetadataAdmission.ForViewer(viewer);
        var release = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        var owners = Enumerable.Range(0, held).Select(i => admission.Read("held:" + i, viewer,
            () => (false, 0), () => release.Task, -1, default)).ToArray();
        using var expired = new CancellationTokenSource();
        var starts = 0;
        try
        {
            // Deterministically expires between the cache probe and the cold-admission decision.
            var error = await Record.ExceptionAsync(async () => await admission.Read("cold", viewer,
                () => { expired.Cancel(); return (false, 0); },
                () => { Interlocked.Increment(ref starts); return release.Task; }, -1, expired.Token));
            Assert.False(scope.Refused);
            Assert.Equal(0, starts);
            Assert.Equal(held, admission.Count());
            Assert.IsAssignableFrom<OperationCanceledException>(error);

            // Real live pressure is still typed busy and cannot free another owner's place.
            if (held == 8)
            {
                Assert.Equal(-1, await admission.Read("live", viewer, () => (false, 0), () => release.Task, -1, default));
                Assert.True(scope.Refused);
            }
        }
        finally
        {
            release.TrySetResult(1);
            await Task.WhenAll(owners).WaitAsync(TimeSpan.FromSeconds(15));
        }
    }
}
#endif
