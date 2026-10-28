using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;

namespace JE.Tests;

public partial class ApiNativeDetailsTests
{
    private static async Task Until(Func<bool> condition)
    {
        for (var i = 0; i < 1500 && !condition(); i++) await Task.Delay(10);
        Assert.True(condition());
    }

    [Fact]
    public async Task StageTimingsChargeTheSendToItsOwnerAndOnlyTheWaitToAJoiner()
    {
        await using var rig = new AdmissionRig();
        var viewer = rig.Rig.Person(linked: false);
        // An async method's recorder stays in its own flow; everything up to the shared read's join runs synchronously.
        async Task<(StageTimings Recorder, SourceAnswer Answer)> Timed()
        {
            var recorder = StageTimings.Begin();
            return (recorder, await rig.Source.MovieAsync(720001, viewer.Id, CancellationToken.None));
        }

        var owner = Timed();
        await Until(() => rig.Sends == 1);
        var joiner = Timed();
        Assert.Null(StageTimings.Current);
        Assert.False(joiner.IsCompleted);
        Assert.Equal(1, rig.Admission.Count("native:"));
        rig.Release();
        var (first, firstAnswer) = await owner.WaitAsync(TimeSpan.FromSeconds(15));
        var (second, secondAnswer) = await joiner.WaitAsync(TimeSpan.FromSeconds(15));
        var (third, thirdAnswer) = await Timed().WaitAsync(TimeSpan.FromSeconds(15));

        // One upstream send for all three, charged to the request that started it.
        Assert.Equal(1, rig.Sends);
        Assert.Equal(1, first.Of(Stage.MetaAdmit).Count);
        Assert.Equal(1, first.Of(Stage.TmdbSend).Count);
        Assert.Equal(1, first.Of(Stage.TmdbSlot).Count);
        Assert.True(first.Of(Stage.SourceMap).Count >= 1);
        Assert.Equal(1, second.Of(Stage.MetaJoin).Count);
        Assert.Equal(0, second.Of(Stage.TmdbSend).Count);
        Assert.Equal(0, second.Of(Stage.MetaAdmit).Count);
        Assert.Equal(1, third.Of(Stage.SourceHit).Count);
        Assert.Equal(0, third.Of(Stage.TmdbSend).Count + third.Of(Stage.MetaAdmit).Count + third.Of(Stage.MetaJoin).Count);
        Assert.Equal(firstAnswer.Data!.Value.GetRawText(), secondAnswer.Data!.Value.GetRawText());
        Assert.Equal(firstAnswer.Data!.Value.GetRawText(), thirdAnswer.Data!.Value.GetRawText());
    }

    [Fact]
    public async Task StageTimingsKeepEightPerViewerAndCountTheRefusal()
    {
        var admission = new ViewerMetadataAdmission();
        var viewer = Guid.NewGuid();
        var release = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        var (recorder, owners, ninth) = await Task.Run(async () =>
        {
            var r = StageTimings.Begin();
            using var scope = ViewerMetadataAdmission.ForViewer(viewer);
            var held = Enumerable.Range(0, 8).Select(i => admission.Read("held:" + i, viewer, () => (false, 0), () => release.Task, -1, default)).ToArray();
            var refused = await admission.Read("ninth", viewer, () => (false, 0), () => release.Task, -1, default);
            return (r, held, refused);
        });
        try
        {
            Assert.Equal(-1, ninth);
            Assert.Equal(8, admission.Count());
            Assert.Equal(1, recorder.Of(Stage.MetaBusy).Count);
        }
        finally
        {
            release.TrySetResult(1);
            await Task.WhenAll(owners).WaitAsync(TimeSpan.FromSeconds(15));
        }
        Assert.Equal(8, recorder.Of(Stage.MetaFetch).Count);
        Assert.Equal(8, recorder.Of(Stage.MetaAdmit).Count);
    }

    [Fact]
    public void StageTimingsStayBoundedAndStopOnceClosed()
    {
        var recorder = new Func<StageTimings>(() => Task.Run(StageTimings.Begin).Result)();
        for (var i = 0; i < 10_000; i++) recorder.Add(Stage.TmdbHit, 0);
        recorder.Close();
        recorder.Add(Stage.TmdbHit, 0);
        recorder.Add(Stage.Publish, 1000);
        Assert.Equal(10_000, recorder.Of(Stage.TmdbHit).Count);
        Assert.Equal(0, recorder.Of(Stage.Publish).Count);
        Assert.Equal(StageTimings.StageCount, Enum.GetValues<Stage>().Length);
        var names = recorder.Header().Split(", ").Select(p => p.Split(';')[0]).ToArray();
        Assert.Equal(new[] { "total", "tmdb-hit" }, names);
        Assert.True(StageTimings.Flag("1") && StageTimings.Flag(" TRUE ") && !StageTimings.Flag("0") && !StageTimings.Flag(null) && !StageTimings.Flag("yes"));
    }
}
