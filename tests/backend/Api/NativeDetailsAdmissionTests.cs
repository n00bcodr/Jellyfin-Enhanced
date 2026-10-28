#if JF12
// Partial of ApiNativeDetailsTests, whose rig and the native-details pages it drives are Jellyfin 12 only (the plugin
// compiles them under JF12), like the rest of that class.
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;

namespace JE.Tests;

public partial class ApiNativeDetailsTests
{
    [Fact]
    public async Task TmdbAdmissionRestrictedEightyColdPagesBoundParentalTasksBeforeNativeReads()
    {
        await using var rig = new AdmissionRig();
        var viewer = rig.Rig.Person(linked: false);
        viewer.MaxParentalRatingScore = 16;
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        rig.Rig.RatingGate = gate;
        var reads = Enumerable.Range(1, 80).Select(i => rig.Read(viewer.Id, SyntheticId.Movie(760000 + i))).ToArray();
        try
        {
            // Observe the real evidence task factory, not concurrent HTTP sends (which may have another cap).
            var parental = typeof(Rig).GetField("_parental", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.GetValue(rig.Rig)!;
            var tasks = typeof(SeerrParentalFilter).GetField("_inFlight", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.GetValue(parental)!;
            var total = typeof(TmdbNativeDetailsSource).GetProperty("MetadataTaskCount", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic);
            Assert.Equal(8, total == null ? (int)tasks.GetType().GetProperty("Count")!.GetValue(tasks)! : (int)total.GetValue(rig.Source)!);
            Assert.Equal(72, reads.Count(t => t.IsCompletedSuccessfully && t.Result.Outcome == AbsentLookup.Unavailable));
        }
        finally
        {
            gate.TrySetResult();
            rig.Release();
            await Task.WhenAll(reads).WaitAsync(TimeSpan.FromSeconds(15));
        }
        Assert.Equal(8, reads.Count(t => t.Result.Outcome == AbsentLookup.Found));
        Assert.Equal(AbsentLookup.Found, (await rig.Read(viewer.Id, SyntheticId.Movie(760080))).Outcome);
    }

    /// <summary>Real page/policy/source readers with a held TMDB transport; disposal always drains owned reads.</summary>
    private sealed class AdmissionRig : IAsyncDisposable
    {
        private readonly TaskCompletionSource _release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly IntegrationTransport _net;
        private readonly TmdbResponseCache _cache;
        public TmdbResponseCache Cache => _cache;
        private readonly List<Task> _reads = new();
        public Rig Rig { get; }
        public ViewerMetadataAdmission Admission { get; } = new();
        public TmdbNativeDetailsSource Source { get; }
        public NativeDetailsPages Pages { get; }
        public bool Hold { get; set; } = true;
        public int Sends;

        public AdmissionRig()
        {
            _net = new IntegrationTransport(async (req, ct) =>
            {
                Assert.Equal("api.themoviedb.org", req.RequestUri!.Host);
                Interlocked.Increment(ref Sends);
                if (Hold) await _release.Task.WaitAsync(ct);
                var path = req.RequestUri.AbsolutePath;
                var body = path.EndsWith("/images", StringComparison.Ordinal) ? (path.Contains("/699998/", StringComparison.Ordinal) ? """{"logos":[null]}""" : """{"logos":[{"file_path":"/logo.png","iso_639_1":"en"}]}""")
                    : path.EndsWith("/recommendations", StringComparison.Ordinal) ? TmdbRelated
                    : path.StartsWith("/3/genre/", StringComparison.Ordinal) ? """{"genres":[{"id":18,"name":"Drama"}]}"""
                    : path.EndsWith("/combined_credits", StringComparison.Ordinal) ? TmdbCredits
                    : path.StartsWith("/3/person/", StringComparison.Ordinal) ? TmdbPerson
                    : path.Contains("/season/", StringComparison.Ordinal) ? TmdbSeason
                    : path.Contains("/tv/", StringComparison.Ordinal) ? TmdbSeries : TmdbMovie;
                return IntegrationTransport.Response(body);
            });
            _cache = new TmdbResponseCache(_net, TimeProvider.System, Admission);
            TmdbNativeDetailsSource? source = null;
            Rig = new Rig(source: r =>
            {
                source = new TmdbNativeDetailsSource(_cache, null, r.Plugin.Core.Logger, Admission) { PageReadWait = TimeSpan.Zero };
                return new ModeNativeDetailsSource(r.Source, source, () => true);
            }, admission: Admission);
            Source = source!;
            JeModeWithTmdb(Rig, false);
            Pages = new NativeDetailsPages(Rig.Callers.Users.Object, Host(), Rig.Used, Rig.Policy);
        }

        public Task<AbsentPageResult> Read(Guid viewer, SyntheticId page, CancellationToken ct = default)
        {
            var read = Pages.ResolveAsync(viewer, Id(page), ct);
            _reads.Add(read);
            return read;
        }

        public void Release() => _release.TrySetResult();

        public async ValueTask DisposeAsync()
        {
            Release();
            try { await Task.WhenAll(_reads).WaitAsync(TimeSpan.FromSeconds(15)); }
            catch (OperationCanceledException) { /* Individual waiter cancellation does not own the upstream read. */ }
            finally { Rig.Dispose(); _cache.Dispose(); _net.Dispose(); }
        }
    }

    [Fact]
    public async Task TmdbAdmissionEightyColdAbsentPagesRetainOnlyEightDistinctTasks()
    {
        await using var rig = new AdmissionRig();
        var viewer = rig.Rig.Person(linked: false);
        var reads = Enumerable.Range(1, 80).Select(i => rig.Read(viewer.Id, SyntheticId.Movie(700000 + i))).ToArray();
        Assert.Equal(8, rig.Source.InFlightCount);
        Assert.Equal(72, reads.Count(t => t.IsCompletedSuccessfully && t.Result.Outcome == AbsentLookup.Unavailable));
        rig.Release();
        var answers = await Task.WhenAll(reads).WaitAsync(TimeSpan.FromSeconds(15));
        Assert.Equal(8, answers.Count(a => a.Outcome == AbsentLookup.Found));
        Assert.Equal(8, rig.Sends);
        Assert.Equal(0, rig.Source.InFlightCount);
        // Refusal isn't cached: a real page load can retry once capacity is free.
        Assert.Equal(AbsentLookup.Found, (await rig.Read(viewer.Id, SyntheticId.Movie(700080))).Outcome);
    }

    [Theory]
    [InlineData("movie")]
    [InlineData("series")]
    [InlineData("season")]
    [InlineData("episode")]
    public async Task TmdbAdmissionAbsentResolverAdmitsEighthAndRefusesNinth(string kind)
    {
        await using var rig = new AdmissionRig();
        var viewer = rig.Rig.Person(linked: false);
        if (kind is "season" or "episode")
        {
            // Isolate the season read: the shared parent is already cached.
            rig.Hold = false;
            for (var i = 1; i <= 9; i++) await rig.Source.SeriesAsync(710000 + i, viewer.Id, CancellationToken.None);
            rig.Hold = true;
        }

        SyntheticId Page(int n) => kind switch
        {
            "movie" => SyntheticId.Movie(n),
            "series" => SyntheticId.Series(n),
            "season" => SyntheticId.SeasonOf(n, 1),
            _ => SyntheticId.EpisodeOf(n, 1, 1),
        };
        var reads = Enumerable.Range(1, 8).Select(i => rig.Read(viewer.Id, Page(710000 + i))).ToArray();
        Assert.Equal(8, rig.Source.InFlightCount);
        Assert.False(reads[7].IsCompleted);
        var ninth = rig.Read(viewer.Id, Page(710009));
        Assert.True(ninth.IsCompletedSuccessfully);
        Assert.Equal(AbsentLookup.Unavailable, (await ninth).Outcome);
        rig.Release();
        Assert.All(await Task.WhenAll(reads), a => Assert.Equal(AbsentLookup.Found, a.Outcome));
        Assert.Equal(AbsentLookup.Found, (await rig.Read(viewer.Id, Page(710009))).Outcome);
    }

    [Fact]
    public async Task TmdbAdmissionViewerSwitchSharesReadsButKeepsOriginalOwnersAndServerLimit()
    {
        await using var rig = new AdmissionRig();
        var viewers = Enumerable.Range(0, 7).Select(_ => rig.Rig.Person(linked: false)).ToArray();
        var reads = new List<Task<AbsentPageResult>>();
        for (var v = 0; v < 6; v++)
        {
            for (var i = 0; i < 8; i++) reads.Add(rig.Read(viewers[v].Id, SyntheticId.Movie(720000 + v * 100 + i)));
            Assert.Equal((v + 1) * 8, rig.Source.InFlightCount);
        }

        Assert.Equal(48, rig.Source.InFlightCount);
        var refused = rig.Read(viewers[6].Id, SyntheticId.Movie(729999));
        Assert.True(refused.IsCompletedSuccessfully);
        Assert.Equal(AbsentLookup.Unavailable, (await refused).Outcome);
        // The newly selected viewer joins existing work for free, even with the server full.
        var joined = rig.Read(viewers[6].Id, SyntheticId.Movie(720000));
        using var abort = new CancellationTokenSource();
        var cancelled = rig.Read(viewers[6].Id, SyntheticId.Movie(720000), abort.Token);
        abort.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => cancelled);
        Assert.Equal(48, rig.Source.InFlightCount);
        rig.Release();
        Assert.All(await Task.WhenAll(reads), a => Assert.Equal(AbsentLookup.Found, a.Outcome));
        Assert.Equal(AbsentLookup.Found, (await joined).Outcome);
        Assert.Equal(48, rig.Sends);
        Assert.Equal(0, rig.Source.InFlightCount);
        Assert.Equal(AbsentLookup.Found, (await rig.Read(viewers[6].Id, SyntheticId.Movie(729999))).Outcome);
    }
    [Theory]
    [InlineData("person")]
    [InlineData("genres")]
    [InlineData("recommendations")]
    [InlineData("logo")]
    [InlineData("logo-malformed")]
    [InlineData("find")]
    public async Task TmdbAdmissionAuxiliaryReadsShareTheViewersEighthPlace(string kind)
    {
        await using var rig = new AdmissionRig();
        var viewer = rig.Rig.Person(linked: false);
        var pending = Enumerable.Range(1, 7).Select(i => rig.Read(viewer.Id, SyntheticId.Movie(730000 + i))).ToArray();
        var source = rig.Rig.Used;
        async Task<bool> ReadHelper() => kind switch
        {
            "person" => (await source.PersonAsync(3810, viewer.Id, CancellationToken.None)).Data != null,
            "genres" => (await source.GenresAsync(true, viewer.Id, CancellationToken.None)).Data != null,
            "logo-malformed" => await source.LogoPathAsync(true, 699998, viewer.Id, CancellationToken.None) == null,
            "find" => (await rig.Source.FindAsync(TitleKey.Parse("tv:tvdb:999999")!, viewer.Id, CancellationToken.None)).Data != null,
            "recommendations" => await source.RecommendationsAsync(true, 693134, viewer.Id, CancellationToken.None) != null,
            _ => await source.LogoPathAsync(true, 693134, viewer.Id, CancellationToken.None) == "/logo.png",
        };
        var helper = ReadHelper();
        try
        {
            Assert.Equal(8, rig.Source.InFlightCount);
            Assert.False(helper.IsCompleted);
            var ninth = rig.Read(viewer.Id, SyntheticId.Movie(739999));
            Assert.True(ninth.IsCompletedSuccessfully);
            Assert.Equal(AbsentLookup.Unavailable, (await ninth).Outcome);
        }
        finally
        {
            rig.Release();
            await Task.WhenAll(pending);
            Assert.True(await helper);
        }
        Assert.Equal(8, rig.Sends);
        // A warm helper joins the cache without taking another place or sending another request.
        Assert.True(await ReadHelper());
        Assert.Equal(8, rig.Sends);
    }

    [Fact]
    public async Task TmdbAdmissionAWaitingPageMakesProgressAndCancellingItsOwnerDoesNotFreeItsRead()
    {
        await using var rig = new AdmissionRig();
        var viewer = rig.Rig.Person(linked: false);
        using var abort = new CancellationTokenSource();
        var owner = rig.Read(viewer.Id, SyntheticId.Movie(740000), abort.Token);
        var pending = Enumerable.Range(1, 7).Select(i => rig.Read(viewer.Id, SyntheticId.Movie(740000 + i))).ToArray();
        abort.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => owner);
        Assert.Equal(8, rig.Source.InFlightCount);
        rig.Source.PageReadWait = TimeSpan.FromSeconds(3);
        var waiting = rig.Read(viewer.Id, SyntheticId.Movie(749999));
        Assert.False(waiting.IsCompleted);
        rig.Release();
        await Task.WhenAll(pending);
        Assert.Equal(AbsentLookup.Found, (await waiting).Outcome);
        Assert.Equal(9, rig.Sends);
        Assert.Equal(0, rig.Source.InFlightCount);
    }

    [Theory]
    [InlineData("filmography")]
    [InlineData("genres-feed")]
    [InlineData("genres-page")]
    [InlineData("seasons-logo")]
    [InlineData("person-page")]
    [InlineData("recommendations")]
    [InlineData("logo")]
    public async Task TmdbAdmissionHttpReadersKeepTheEffectiveViewerWhenTheirShareIsFull(string route)
    {
        await using var rig = new AdmissionRig();
        var viewer = rig.Rig.Person(linked: false);
        rig.Rig.Plugin.Plugin.Configuration.JellyseerrShowGenreDiscovery = true;
        // Warm only the prerequisite; the child read under test remains cold.
        rig.Hold = false;
        if (route == "filmography") await rig.Rig.Used.PersonCreditsAsync(3810, viewer.Id, CancellationToken.None);
        if (route == "seasons-logo") await rig.Rig.Used.SeriesAsync(83867, viewer.Id, CancellationToken.None);
        if (route == "logo") await rig.Rig.Used.MovieAsync(693134, viewer.Id, CancellationToken.None);
        rig.Hold = true;
        var held = Enumerable.Range(1, 8).Select(i => rig.Read(viewer.Id, SyntheticId.Movie(750000 + i))).ToArray();
        async Task ReadRoute()
        {
            if (route == "filmography")
                Assert.Equal(FeedOutcome.Busy, (await rig.Rig.Feeds.FilmographyAsync(viewer, 3810, CancellationToken.None)).Outcome);
            else if (route == "genres-feed")
                Assert.Equal(FeedOutcome.Busy, (await rig.Rig.Feeds.GenresAsync(viewer, true, CancellationToken.None)).Outcome);
            else if (route == "seasons-logo")
            {
                var result = (await Call(rig.Rig, "TvShows", "GetSeasons", Me(viewer), new() { ["seriesId"] = Id(SyntheticId.Series(83867)) })).Result;
                Assert.All(Value<MediaBrowser.Model.Querying.QueryResult<MediaBrowser.Model.Dto.BaseItemDto>>(result).Items,
                    item => Assert.False(item.ImageTags.ContainsKey(MediaBrowser.Model.Entities.ImageType.Logo)));
            }
            else
            {
                var page = route == "genres-page" ? SyntheticId.Genre(18) : route == "person-page" ? SyntheticId.Person(3810) : SyntheticId.Movie(693134);
                var result = (await Call(rig.Rig, route == "recommendations" ? "Library" : "UserLibrary", route == "recommendations" ? "GetSimilarItems" : "GetItem", Me(viewer), new() { ["itemId"] = Id(page) })).Result;
                if (route == "genres-page") Assert.Equal(503, Status(result));
                else if (route == "person-page") Assert.Equal(429, Status(result));
                else if (route == "recommendations") Assert.Empty(Value<MediaBrowser.Model.Querying.QueryResult<MediaBrowser.Model.Dto.BaseItemDto>>(result).Items);
                else Assert.False(Value<MediaBrowser.Model.Dto.BaseItemDto>(result).ImageTags.ContainsKey(MediaBrowser.Model.Entities.ImageType.Logo));
            }
        }
        var read = ReadRoute();
        try
        {
            Assert.True(read.IsCompleted);
            Assert.Equal(8, rig.Source.InFlightCount);
            await read;
        }
        finally
        {
            rig.Release();
            await Task.WhenAll(held);
            await read;
        }
    }

}
#endif
